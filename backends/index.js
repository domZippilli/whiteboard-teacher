// Backends: which service does each job. See PLAN-CONFIGURABLE-BACKENDS.md.
//
// Jobs: lessons (scripts, answers, quizzes), utility (screening, profile updates), voice, listening.
// Each job has an ordered list of backends. Config comes from data/config.json when it exists;
// otherwise from .env, which reproduces the original setup (claude CLI + ElevenLabs).
//
// config.json shape:
//   { "backends": { "<id>": { "type": "<type>", ...settings } },
//     "jobs": { "lessons": ["<id>", ...], "utility": [...], "voice": [...], "listening": [...] } }
// Secret settings (apiKey) may be given as { "env": "VAR" } or { "op": "op://vault/item/field" }.
import fs from 'node:fs';
import path from 'node:path';
import * as claudeCli from './text/claude-cli.js';
import * as elevenlabs from './voice/elevenlabs.js';
import * as elevenlabsStt from './listening/elevenlabs-stt.js';

const TYPES = Object.fromEntries([claudeCli, elevenlabs, elevenlabsStt].map(m => [m.type, m]));
export const JOBS = ['lessons', 'utility', 'voice', 'listening'];

// ElevenLabs voices offered by default, by first name (shared-library voices).
const ELEVENLABS_VOICES = [
  { id: 'uFIXVu9mmnDZ7dTKCBTX', name: 'Justin' }, // "Justin Time - Elearning Narration"
  { id: 'hIru3zkEJ3dBYHTbMy2V', name: 'Alexander' }, // "Alexander - Clear, Steady and Refined"
];

// The original setup, from environment variables.
function envConfig(env, secret) {
  const key = secret('ELEVENLABS_API_KEY');
  return {
    backends: {
      claude: { type: 'claude-cli', model: env.MODEL || 'opus' },
      'claude-utility': { type: 'claude-cli', model: env.SCREEN_MODEL || env.PROFILE_MODEL || 'sonnet' },
      ...(key ? {
        elevenlabs: {
          type: 'elevenlabs', apiKey: key, model: env.ELEVENLABS_MODEL || 'eleven_v3',
          voices: ELEVENLABS_VOICES, defaultVoice: env.ELEVENLABS_VOICE || ELEVENLABS_VOICES[0].id,
          concurrency: +env.ELEVENLABS_CONCURRENCY || 2,
        },
        'elevenlabs-stt': { type: 'elevenlabs-stt', apiKey: key, model: env.ELEVENLABS_STT_MODEL || 'scribe_v2' },
      } : {}),
    },
    jobs: {
      lessons: ['claude'],
      utility: ['claude-utility'],
      voice: key ? ['elevenlabs'] : [],
      listening: key ? ['elevenlabs-stt'] : [],
    },
  };
}

// Returns { jobs: { lessons: [backend...], ... }, first(job), describe() }.
// `secret(name)` reads a secret from the environment or 1Password; `opRead(ref)` reads a 1Password ref.
export function loadBackends({ dataDir, env, secret, opRead, defaults }) {
  let config;
  const file = path.join(dataDir, 'config.json');
  try { config = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { config = envConfig(env, secret); }

  const resolveSecret = v => (v && typeof v === 'object' ? (v.env ? env[v.env] || '' : v.op ? opRead(v.op) : '') : v);
  const built = {};
  for (const [id, settings] of Object.entries(config.backends || {})) {
    const mod = TYPES[settings.type];
    if (!mod) { console.warn(`backend ${id}: unknown type ${settings.type}`); continue; }
    const s = { ...(defaults[settings.type] || {}), ...settings };
    if ('apiKey' in s) s.apiKey = resolveSecret(s.apiKey);
    built[id] = Object.assign(mod.create(s), { id });
  }
  const jobs = Object.fromEntries(JOBS.map(j => [j, (config.jobs?.[j] || []).map(id => built[id]).filter(Boolean)]));

  // ----- voice catalog -----
  // data/voices.json: per voice backend, the voices learners may pick ({ id, name }) and the default.
  // Without an entry, a backend offers its configured voices. A learner's choice is "backendId:voiceId".
  const catalogFile = path.join(dataDir, 'voices.json');
  let catalog = {};
  try { catalog = JSON.parse(fs.readFileSync(catalogFile, 'utf8')); } catch {}
  const catalogFor = b => catalog[b.id] || { enabled: b.voices().map(v => ({ id: v.id, name: v.name })), default: b.defaultVoice };

  return {
    jobs,
    first: job => jobs[job][0] || null,

    // Voices learners can choose, across all voice backends in order.
    voiceList: () => jobs.voice.flatMap(b => {
      const c = catalogFor(b);
      return c.enabled.map(v => ({ value: `${b.id}:${v.id}`, backend: b.id, id: v.id, name: v.name, default: v.id === c.default }));
    }),
    // The default voice: the first backend's default.
    defaultVoice() {
      const b = jobs.voice[0];
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
    // Admin: everything each voice backend offers, with what's enabled.
    async voiceCatalog() {
      return Promise.all(jobs.voice.map(async b => {
        let available = b.voices();
        try { if (b.available) available = await b.available(); } catch (e) { console.warn(`voices for ${b.id}: ${e.message}`); }
        return { backend: b.id, type: b.type, describe: b.describe(), available, ...catalogFor(b) };
      }));
    },
    setVoiceCatalog(backendId, { enabled, default: def }) {
      if (!jobs.voice.some(b => b.id === backendId)) throw Object.assign(new Error('No such voice backend'), { status: 404 });
      enabled = (enabled || []).filter(v => v && v.id).map(v => ({ id: String(v.id), name: String(v.name || v.id).slice(0, 40) }));
      if (!enabled.length) throw Object.assign(new Error('Enable at least one voice'), { status: 400 });
      catalog[backendId] = { enabled, default: enabled.some(v => v.id === def) ? def : enabled[0].id };
      fs.writeFileSync(catalogFile, JSON.stringify(catalog, null, 2));
      return catalog[backendId];
    },

    describe: () => JOBS.map(j => `${j}: ${jobs[j].map(b => b.describe()).join(' → ') || '(none)'}`).join('\n  '),
  };
}
