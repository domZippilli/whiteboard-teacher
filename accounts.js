// Accounts: users, PIN/password hashing, signed session cookies, lockouts. Zero dependencies.
//
// Two cookies:
//   wt_user  — who is using this device (long-lived; learners stay signed in until they switch).
//   wt_admin — admin powers, sliding 30-minute expiry; re-asks for the admin password after that.
// Both are HMAC-signed with a random key in data/secret.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const AGE_BANDS = ['under8', '8-12', '13-17', 'adult'];
// Daily lesson-time limit in minutes (set by the admin); empty/0 means no limit.
const dailyMinutes = v => (+v > 0 ? Math.min(24 * 60, Math.round(+v)) : null);
const ADMIN_IDLE_MS = 30 * 60 * 1000;
const USER_COOKIE_DAYS = 400;

export function createAccounts(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const usersFile = path.join(dataDir, 'users.json');
  const secretFile = path.join(dataDir, 'secret');
  if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  const key = fs.readFileSync(secretFile, 'utf8').trim();

  let users = [];
  try { users = JSON.parse(fs.readFileSync(usersFile, 'utf8')); } catch {}
  const save = () => {
    fs.writeFileSync(usersFile + '.tmp', JSON.stringify(users, null, 2), { mode: 0o600 });
    fs.renameSync(usersFile + '.tmp', usersFile);
  };

  // ----- secrets -----
  const hash = secret => {
    const salt = crypto.randomBytes(16).toString('hex');
    const h = crypto.scryptSync(String(secret), salt, 32, { N: 16384 }).toString('hex');
    return `scrypt:${salt}:${h}`;
  };
  const verify = (secret, stored) => {
    const [kind, salt, h] = String(stored || '').split(':');
    if (kind !== 'scrypt' || !salt || !h) return false;
    const got = crypto.scryptSync(String(secret ?? ''), salt, 32, { N: 16384 });
    return crypto.timingSafeEqual(got, Buffer.from(h, 'hex'));
  };

  // ----- lockouts (in memory): 5 wrong tries → 5 min, doubling each time after -----
  const fails = new Map();
  const lockedFor = id => Math.max(0, (fails.get(id)?.until || 0) - Date.now());
  const noteFail = id => {
    const f = fails.get(id) || { n: 0, locks: 0, until: 0 };
    f.n++;
    if (f.n >= 5) { f.until = Date.now() + 5 * 60 * 1000 * 2 ** f.locks; f.locks++; f.n = 0; }
    fails.set(id, f);
  };

  // ----- cookies -----
  const sign = obj => {
    const body = Buffer.from(JSON.stringify(obj)).toString('base64url');
    return `${body}.${crypto.createHmac('sha256', key).update(body).digest('base64url')}`;
  };
  const unsign = token => {
    const [body, mac] = String(token || '').split('.');
    if (!body || !mac) return null;
    const want = crypto.createHmac('sha256', key).update(body).digest('base64url');
    if (mac.length !== want.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return null;
    try { return JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { return null; }
  };
  const parseCookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(c => {
    const i = c.indexOf('=');
    return i < 0 ? [c.trim(), ''] : [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1).trim())];
  }));
  const secure = req => req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted;
  const cookie = (req, name, value, maxAgeSec) =>
    `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure(req) ? '; Secure' : ''}`;

  const byId = id => users.find(u => u.id === id);
  const isAdmin = u => u?.role === 'admin';

  return {
    AGE_BANDS,
    get users() { return users; },
    byId,
    needsSetup: () => !users.some(isAdmin),

    // What the browser may see about a user (never the hash).
    public(u, full = false) {
      if (!u) return null;
      const out = { id: u.id, name: u.name, avatar: u.avatar, role: u.role, locked: !!u.secret };
      if (full) Object.assign(out, { ageBand: u.ageBand, notes: u.notes || '', settings: u.settings || {}, dailyMinutes: u.dailyMinutes || null, createdAt: u.createdAt });
      return out;
    },

    // Read the session from cookies. Returns { user, admin, refresh: [Set-Cookie...] }.
    session(req) {
      const c = parseCookies(req);
      const s = unsign(c.wt_user);
      const user = s && byId(s.u);
      const a = unsign(c.wt_admin);
      const admin = !!(user && isAdmin(user) && a && a.u === user.id && a.exp > Date.now());
      // Slide the admin window forward on activity.
      const refresh = admin ? [cookie(req, 'wt_admin', sign({ u: user.id, exp: Date.now() + ADMIN_IDLE_MS }), ADMIN_IDLE_MS / 1000)] : [];
      return { user: user || null, admin, refresh };
    },

    // Sign in as a profile. Admins always need their password (and get admin powers);
    // learners need a PIN only if one is set. Returns Set-Cookie headers or throws.
    login(req, id, secret) {
      const u = byId(id);
      if (!u) throw Object.assign(new Error('No such profile'), { status: 404 });
      const wait = lockedFor(id);
      if (wait) throw Object.assign(new Error(`Too many tries. Try again in ${Math.ceil(wait / 60000)} min.`), { status: 429 });
      if (u.secret && !verify(secret, u.secret)) {
        noteFail(id);
        throw Object.assign(new Error(isAdmin(u) ? 'Wrong password' : 'Wrong PIN'), { status: 401 });
      }
      fails.delete(id);
      const out = [cookie(req, 'wt_user', sign({ u: u.id, iat: Date.now() }), USER_COOKIE_DAYS * 86400)];
      if (isAdmin(u)) out.push(cookie(req, 'wt_admin', sign({ u: u.id, exp: Date.now() + ADMIN_IDLE_MS }), ADMIN_IDLE_MS / 1000));
      return out;
    },

    // Re-enter admin mode after it timed out, without switching profile.
    elevate(req, user, password) {
      if (!isAdmin(user)) throw Object.assign(new Error('Not an admin'), { status: 403 });
      return this.login(req, user.id, password).slice(1);
    },

    logout(req) {
      return [cookie(req, 'wt_user', '', 0), cookie(req, 'wt_admin', '', 0)];
    },

    // ----- user management (admin) -----
    create(fields) {
      const { name, avatar, role = 'learner', ageBand, notes, secret } = fields;
      if (!String(name || '').trim()) throw Object.assign(new Error('Name is required'), { status: 400 });
      const u = {
        id: crypto.randomBytes(6).toString('hex'),
        name: String(name).trim().slice(0, 40),
        avatar: avatar || '🙂',
        role: role === 'admin' ? 'admin' : 'learner',
        ageBand: AGE_BANDS.includes(ageBand) ? ageBand : (role === 'admin' ? 'adult' : '8-12'),
        notes: String(notes || '').slice(0, 2000),
        dailyMinutes: dailyMinutes(fields.dailyMinutes),
        settings: {},
        createdAt: new Date().toISOString(),
      };
      this.setSecret(u, secret, true);
      users.push(u);
      save();
      return u;
    },

    update(id, fields) {
      const u = byId(id);
      if (!u) throw Object.assign(new Error('No such profile'), { status: 404 });
      if (fields.name !== undefined) u.name = String(fields.name).trim().slice(0, 40) || u.name;
      if (fields.avatar !== undefined) u.avatar = fields.avatar || u.avatar;
      if (fields.ageBand !== undefined && AGE_BANDS.includes(fields.ageBand)) u.ageBand = fields.ageBand;
      if (fields.notes !== undefined) u.notes = String(fields.notes || '').slice(0, 2000);
      if (fields.dailyMinutes !== undefined) u.dailyMinutes = dailyMinutes(fields.dailyMinutes);
      if (fields.settings && typeof fields.settings === 'object') u.settings = { ...(u.settings || {}), ...fields.settings };
      if (fields.role !== undefined && fields.role !== u.role) {
        if (u.role === 'admin' && users.filter(isAdmin).length === 1) throw Object.assign(new Error("Can't remove the last admin"), { status: 400 });
        if (fields.role === 'admin' && !u.secret && !fields.secret) throw Object.assign(new Error('An admin needs a password'), { status: 400 });
        u.role = fields.role === 'admin' ? 'admin' : 'learner';
      }
      // secret: string to set, null/'' to clear (learners only), undefined to leave as is.
      if (fields.secret !== undefined) this.setSecret(u, fields.secret, false);
      save();
      return u;
    },

    setSecret(u, secret, creating) {
      if (secret === undefined && !creating) return;
      if (!secret) {
        if (isAdmin(u)) throw Object.assign(new Error('An admin needs a password'), { status: 400 });
        delete u.secret;
        return;
      }
      secret = String(secret);
      if (isAdmin(u) && secret.length < 6) throw Object.assign(new Error('Admin password must be at least 6 characters'), { status: 400 });
      if (!isAdmin(u) && !/^\d{4,8}$/.test(secret)) throw Object.assign(new Error('PIN must be 4–8 digits'), { status: 400 });
      u.secret = hash(secret);
    },

    remove(id, by) {
      const u = byId(id);
      if (!u) return;
      if (u.id === by?.id) throw Object.assign(new Error("You can't delete yourself"), { status: 400 });
      if (isAdmin(u) && users.filter(isAdmin).length === 1) throw Object.assign(new Error("Can't delete the last admin"), { status: 400 });
      users = users.filter(x => x.id !== id);
      save();
    },

    saveSettings(u, settings) {
      u.settings = { ...(u.settings || {}), ...settings };
      save();
      return u.settings;
    },
  };
}
