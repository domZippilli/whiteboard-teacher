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
  return {
    jobs,
    first: job => jobs[job][0] || null,
    describe: () => JOBS.map(j => `${j}: ${jobs[j].map(b => b.describe()).join(' → ') || '(none)'}`).join('\n  '),
  };
}
