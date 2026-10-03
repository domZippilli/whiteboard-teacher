// Backends: which service does each job. See PLAN-CONFIGURABLE-BACKENDS.md.
//
// Jobs: lessons (scripts, answers, quizzes), utility (screening, profile updates), voice, listening.
// Each job has an ordered list of backends: the first healthy one is used, the rest are fallbacks.
// Config comes from data/config.json (edited in Admin › Backends); without it, from .env, which
// reproduces the original setup (claude CLI + ElevenLabs, Kokoro as the free fallback).
//
// config.json shape:
//   { "backends": { "<id>": { "type": "<type>", ...settings } },
//     "jobs": { "lessons": ["<id>", ...], "utility": [...], "voice": [...], "listening": [...] } }
// Secret settings are a string, or { "env": "VAR" }, or { "op": "op://vault/item/field" }.
import fs from 'node:fs';
import path from 'node:path';
import * as claudeCli from './text/claude-cli.js';
import * as openaiChat from './text/openai-chat.js';
import * as elevenlabs from './voice/elevenlabs.js';
import * as elevenlabsStt from './listening/elevenlabs-stt.js';
import * as browserModel from './voice/browser-model.js';
import * as browserTranscribe from './listening/browser-transcribe.js';

const TYPES = Object.fromEntries([claudeCli, openaiChat, elevenlabs, elevenlabsStt, browserModel, browserTranscribe].map(m => [m.type, m]));
export const JOBS = ['lessons', 'utility', 'voice', 'listening'];
// Which kind of backend each job takes.
const JOB_KIND = { lessons: 'text', utility: 'text', voice: 'voice', listening: 'listening' };

// ElevenLabs voices offered by default, by first name (shared-library voices).
const ELEVENLABS_VOICES = [
  { id: 'uFIXVu9mmnDZ7dTKCBTX', name: 'Justin' }, // "Justin Time - Elearning Narration"
  { id: 'hIru3zkEJ3dBYHTbMy2V', name: 'Alexander' }, // "Alexander - Clear, Steady and Refined"
];

// The original setup, from environment variables. Secrets stay as references, never copied.
function envConfig(env) {
  const keyRef = env.ELEVENLABS_API_KEY ? { env: 'ELEVENLABS_API_KEY' }
    : env.ELEVENLABS_API_KEY_OP_REF ? { op: env.ELEVENLABS_API_KEY_OP_REF } : null;
  return {
    backends: {
      claude: { type: 'claude-cli', model: env.MODEL || 'opus' },
      'claude-utility': { type: 'claude-cli', model: env.SCREEN_MODEL || env.PROFILE_MODEL || 'sonnet' },
      ...(keyRef ? {
        elevenlabs: {
          type: 'elevenlabs', apiKey: keyRef, model: env.ELEVENLABS_MODEL || 'eleven_v3',
          voices: ELEVENLABS_VOICES, defaultVoice: env.ELEVENLABS_VOICE || ELEVENLABS_VOICES[0].id,
          concurrency: +env.ELEVENLABS_CONCURRENCY || 2,
        },
        'elevenlabs-stt': { type: 'elevenlabs-stt', apiKey: keyRef, model: env.ELEVENLABS_STT_MODEL || 'scribe_v2' },
      } : {}),
      // Free voice that runs in the learner's browser: the fallback when ElevenLabs can't speak.
      kokoro: { type: 'browser-model', engine: 'kokoro' },
    },
    jobs: {
      lessons: ['claude'],
      utility: ['claude-utility'],
      voice: keyRef ? ['elevenlabs', 'kokoro'] : ['kokoro'],
      listening: keyRef ? ['elevenlabs-stt'] : [],
    },
  };
}

const httpError = (status, message) => Object.assign(new Error(message), { status });
const secretFields = type => (TYPES[type]?.meta.fields || []).filter(f => f.kind === 'secret').map(f => f.key);

// Returns the live set of backends. `opRead(ref)` reads a 1Password reference.
export function loadBackends({ dataDir, env, opRead, defaults }) {
  const file = path.join(dataDir, 'config.json');
  let config;
  try { config = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { config = envConfig(env); }

  const opCache = new Map(); // op reads are slow (a CLI call): once per reference
  const resolveSecret = v => {
    if (!v || typeof v !== 'object') return v || '';
    if (v.env) return env[v.env] || '';
    if (v.op) { if (!opCache.has(v.op)) opCache.set(v.op, opRead(v.op)); return opCache.get(v.op); }
    return '';
  };

  let built = {};
  let jobs = {};
  function build() {
    built = {};
    for (const [id, settings] of Object.entries(config.backends || {})) {
      const mod = TYPES[settings.type];
      if (!mod) { console.warn(`backend ${id}: unknown type ${settings.type}`); continue; }
      const s = { ...(defaults[settings.type] || {}), ...settings };
      for (const k of secretFields(settings.type)) s[k] = resolveSecret(s[k]);
      try { built[id] = Object.assign(mod.create(s), { id }); }
      catch (e) { console.warn(`backend ${id}: ${e.message}`); }
    }
    jobs = Object.fromEntries(JOBS.map(j => [j, (config.jobs?.[j] || []).map(id => built[id]).filter(Boolean)]));
  }
  build();

  // ----- voice catalog -----
  // data/voices.json: per voice backend, the voices learners may pick ({ id, name }) and the default.
  // Without an entry, a backend offers its configured voices. A learner's choice is "backendId:voiceId".
  const catalogFile = path.join(dataDir, 'voices.json');
  let catalog = {};
  try { catalog = JSON.parse(fs.readFileSync(catalogFile, 'utf8')); } catch {}
  const catalogFor = b => catalog[b.id] || { enabled: b.voices().map(v => ({ id: v.id, name: v.name })), default: b.defaultVoice };

  // ----- health -----
  // A backend that fails is skipped for a while: an hour for quota/auth problems (e.g. out of
  // credits), 10 minutes for anything else (unreachable, timeouts, server errors).
  const health = new Map(); // id → { until, error, at }
  const healthy = b => (health.get(b.id)?.until || 0) < Date.now();
  function markFailed(b, err) {
    const quota = [401, 402, 403].includes(err.status) || /quota|credit|limit|payment|unauthori[sz]ed|api key/i.test(err.message);
    health.set(b.id, { until: Date.now() + (quota ? 3600e3 : 600e3), error: err.message, at: new Date().toISOString() });
    console.warn(`backend ${b.id} unavailable for ${quota ? '1 h' : '10 min'}: ${err.message}`);
  }

  // ----- admin view of the config -----
  // Secrets are never sent to the browser: { secret: true, set, source: 'typed'|'env'|'op', hint }.
  function maskSecret(v) {
    if (!v) return { secret: true, set: false };
    if (typeof v === 'object') {
      const value = resolveSecret(v);
      return { secret: true, set: !!value, source: v.env ? 'env' : 'op', ref: v.env ? `$${v.env}` : v.op, hint: value ? `••••${value.slice(-4)}` : 'not found' };
    }
    return { secret: true, set: true, source: 'typed', hint: `••••${String(v).slice(-4)}` };
  }
  // A secret from the admin form: { keep: true } keeps the stored one; "$NAME" → env var;
  // "op://…" → 1Password; "" clears; anything else is the key itself.
  function parseSecret(input, previous) {
    if (input && typeof input === 'object' && input.keep) return previous;
    const s = String(input ?? '').trim();
    if (!s) return '';
    if (/^\$[A-Z_][A-Z0-9_]*$/.test(s)) return { env: s.slice(1) };
    if (s.startsWith('op://')) return { op: s };
    return s;
  }

  return {
    get jobs() { return jobs; },
    first: job => jobs[job].find(healthy) || null,
    healthy,
    markFailed,
    describe: () => JOBS.map(j => `${j}: ${jobs[j].map(b => b.describe()).join(' → ') || '(none)'}`).join('\n  '),

    adminView() {
      const backends = Object.fromEntries(Object.entries(config.backends || {}).map(([id, s]) => {
        const out = { ...s };
        for (const k of secretFields(s.type)) out[k] = maskSecret(s[k]);
        const h = health.get(id);
        out.status = !built[id] ? { ok: false, error: 'Could not start (check its settings)' }
          : h && h.until > Date.now() ? { ok: false, error: h.error, until: new Date(h.until).toISOString() } : { ok: true };
        out.describe = built[id]?.describe() || id;
        return [id, out];
      }));
      const types = Object.fromEntries(Object.values(TYPES).map(m => [m.type, m.meta]));
      return { types, jobKinds: JOB_KIND, backends, jobs: config.jobs, fromEnv: !fs.existsSync(file) };
    },

    // Replace the config from the admin form, write data/config.json, rebuild. Health resets for
    // backends whose settings changed.
    update({ backends: inBackends, jobs: inJobs }) {
      const next = { backends: {}, jobs: {} };
      for (const [id, s] of Object.entries(inBackends || {})) {
        if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(id)) throw httpError(400, `Bad backend name "${id}": use lowercase letters, digits and dashes`);
        const mod = TYPES[s.type];
        if (!mod) throw httpError(400, `Unknown backend type ${s.type}`);
        const prev = config.backends?.[id] || {};
        // Keep settings the form doesn't show (e.g. ElevenLabs' seed voice list), then apply the form.
        const clean = { ...(prev.type === s.type ? prev : {}), type: s.type };
        for (const f of mod.meta.fields) {
          if (f.kind === 'secret') clean[f.key] = parseSecret(s[f.key], prev[f.key]);
          else if (s[f.key] !== undefined && s[f.key] !== '') clean[f.key] = f.kind === 'number' ? +s[f.key] : String(s[f.key]);
          else delete clean[f.key];
        }
        next.backends[id] = clean;
        if (JSON.stringify(clean) !== JSON.stringify(prev)) health.delete(id);
      }
      for (const j of JOBS) {
        const ids = (inJobs?.[j] || []).filter(id => next.backends[id]);
        for (const id of ids) {
          if (TYPES[next.backends[id].type].meta.kind !== JOB_KIND[j]) throw httpError(400, `${id} can't do ${j}`);
        }
        next.jobs[j] = [...new Set(ids)];
      }
      if (!next.jobs.lessons.length) throw httpError(400, 'Lessons need at least one backend');
      config = next;
      fs.writeFileSync(file + '.tmp', JSON.stringify(config, null, 2), { mode: 0o600 });
      fs.renameSync(file + '.tmp', file);
      opCache.clear();
      build();
      return this.adminView();
    },

    // A small real request, to check a backend works. Voice returns audio for the admin to hear.
    async test(id) {
      const b = built[id];
      if (!b) throw httpError(400, 'This backend could not start; check its settings');
      const kind = TYPES[b.type].meta.kind;
      const t0 = Date.now();
      try {
        let result;
        if (kind === 'text') {
          result = await b.once({ system: 'You are a test. Reply with exactly: OK', prompt: 'Reply with OK.' });
          result = `Replied “${String(result).trim().slice(0, 60)}”`;
        } else if (kind === 'voice') {
          if (b.capabilities.runsIn === 'browser') return { ok: true, browser: b.clientSpec(b.defaultVoice), ms: 0 };
          const r = await b.speak({ text: 'Testing, one, two, three.', voice: catalogFor(b).default || b.defaultVoice });
          result = { audio: `data:${r.mime};base64,${r.audio.toString('base64')}` };
        } else if (b.capabilities?.runsIn === 'browser') {
          return { ok: true, browserListening: b.clientSpec(), ms: 0, message: 'Runs in the browser: try the mic to test it' };
        } else {
          // Half a second of silence: checks the key and the service, expects no words back.
          const wav = silentWav(0.5);
          await b.transcribe({ audio: wav, mime: 'audio/wav' });
          result = 'Transcribed a short test clip';
        }
        health.delete(id);
        return { ok: true, ms: Date.now() - t0, ...(typeof result === 'string' ? { message: result } : result) };
      } catch (e) {
        return { ok: false, ms: Date.now() - t0, error: e.message };
      }
    },

    // ----- voices -----
    // Voices learners can choose, across all voice backends in order.
    voiceList: () => jobs.voice.flatMap(b => {
      const c = catalogFor(b);
      return c.enabled.map(v => ({ value: `${b.id}:${v.id}`, backend: b.id, id: v.id, name: v.name, default: v.id === c.default }));
    }),
    // The default voice: the first working backend's default.
    defaultVoice() {
      const b = jobs.voice.find(healthy) || jobs.voice[0];
      return b ? `${b.id}:${catalogFor(b).default || catalogFor(b).enabled[0]?.id}` : null;
    },
    // Turn a learner's choice into { backend, voice }. Older settings hold a bare voice id. Falls back
    // to the first backend's default when the choice isn't enabled (any more).
    // `any` (admin previews) allows voices that aren't enabled yet.
    resolveVoice(choice, { any = false } = {}) {
      let [bid, vid] = String(choice || '').includes(':') ? String(choice).split(':') : [null, choice];
      for (const b of jobs.voice) {
        if (bid && b.id !== bid) continue;
        if ((any && bid && vid) || catalogFor(b).enabled.some(v => v.id === vid)) return { backend: b, voice: vid };
      }
      const b = jobs.voice[0];
      return b ? { backend: b, voice: catalogFor(b).default || catalogFor(b).enabled[0]?.id } : null;
    },
    // A backend's own default voice (from the catalog).
    defaultVoiceOf: b => catalogFor(b).default || catalogFor(b).enabled[0]?.id,
    // Admin: everything each voice backend offers, with what's enabled.
    async voiceCatalog() {
      return Promise.all(jobs.voice.map(async b => {
        let available = b.voices();
        try { if (b.available) available = await b.available(); } catch (e) { console.warn(`voices for ${b.id}: ${e.message}`); }
        return { backend: b.id, type: b.type, describe: b.describe(), available, ...catalogFor(b) };
      }));
    },
    setVoiceCatalog(backendId, { enabled, default: def }) {
      if (!jobs.voice.some(b => b.id === backendId)) throw httpError(404, 'No such voice backend');
      enabled = (enabled || []).filter(v => v && v.id).map(v => ({ id: String(v.id), name: String(v.name || v.id).slice(0, 40) }));
      if (!enabled.length) throw httpError(400, 'Enable at least one voice');
      catalog[backendId] = { enabled, default: enabled.some(v => v.id === def) ? def : enabled[0].id };
      fs.writeFileSync(catalogFile, JSON.stringify(catalog, null, 2));
      return catalog[backendId];
    },
  };
}

// A WAV file of silence (16 kHz mono 16-bit), for testing listening backends.
function silentWav(seconds) {
  const rate = 16000, n = Math.round(rate * seconds), buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  return buf;
}
