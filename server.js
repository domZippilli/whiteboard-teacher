// Whiteboard Teacher — tiny zero-dependency server.
// Serves the static app, writes lessons with the `claude` CLI, proxies speech to ElevenLabs,
// and stores lessons (scripts + audio) under lessons/ for replay.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const LESSONS = path.join(ROOT, 'lessons');
// cwd for `claude -p`: outside the project so lesson sessions don't pick up this repo's CLAUDE.md
// or crowd its /resume list.
const SESSIONS = path.join(os.homedir(), '.whiteboard-teacher', 'sessions');

// ---------- config & secrets ----------

try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && m[2] && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}

// A secret can be given directly (FOO) or as a 1Password reference (FOO_OP_REF = op://vault/item/field),
// resolved once at startup with the `op` CLI (needs OP_SERVICE_ACCOUNT_TOKEN or desktop integration).
function secret(name, defaultRef) {
  if (process.env[name]) return process.env[name];
  const ref = process.env[`${name}_OP_REF`] || defaultRef;
  if (!ref) return '';
  try {
    return execFileSync('op', ['read', ref], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    console.warn(`Could not read ${name} from 1Password (${ref})`);
    return '';
  }
}

const PORT = process.env.PORT || 4747;
const DEFAULT_MODEL = process.env.MODEL || 'opus';
const ELEVENLABS_API_KEY = secret('ELEVENLABS_API_KEY');
// Voices offered in Settings, by first name. Shared-library voices work without adding them to the account.
const VOICES = [
  { name: 'Justin', id: 'uFIXVu9mmnDZ7dTKCBTX' }, // "Justin Time - Elearning Narration"
  { name: 'Alexander', id: 'hIru3zkEJ3dBYHTbMy2V' }, // "Alexander - Clear, Steady and Refined"
];
const DEFAULT_VOICE = process.env.ELEVENLABS_VOICE || VOICES[0].id;
const TTS_MODEL = process.env.ELEVENLABS_MODEL || 'eleven_v3'; // v3 understands [audio tags] for expressive delivery

const SCRIPT_API = () => fs.readFileSync(path.join(ROOT, 'docs/SCRIPT_API.md'), 'utf8');

// ---------- Claude (via the `claude` CLI) ----------
// Each lesson is one Claude Code session (named "Lesson: <title>"), so every part is written with
// the whole lesson so far in context. Questions fork that session so asides don't interrupt it.

// Teaching personalities the student can pick. The material stays accurate whatever the tone.
const TONES = {
  serious: 'Serious: earnest, rigorous and measured, like a respected professor. Humor is rare and dry. Precision matters.',
  matter: 'Matter of fact: clear, efficient, no-nonsense. Get straight to the point, minimal flourish, no filler, no cheerleading.',
  jovial: 'Jovial: warm, upbeat and good-humored. Light jokes, real enthusiasm, a big smile in the voice.',
  goofy: 'Goofy: playful and silly. Puns, absurd analogies, funny doodles on the board, comic timing (use the audio cues: [laughs], [gasps], [whispers], dramatic pauses), maybe a running gag. Still teach the material accurately and completely; the silliness is how you make it stick, not a replacement for substance.',
};

function system(teacher, tone) {
  return `You are ${teacher || 'Claude'}, a brilliant${TONES[tone] ? '' : ', warm'} teacher giving a live lesson at a whiteboard. You write lessons as scripts that a program performs: your words are spoken by a text-to-speech voice and your drawing is drawn live in sync. Be the teacher you'd most want to learn from: make it vivid, visual and genuinely interesting.
${TONES[tone] ? `\nYour teaching personality for this lesson, chosen by the student: ${TONES[tone]}\n` : ''}
Here is the complete reference for the script format:

${SCRIPT_API()}

Every reply must be ONLY valid JSON, no prose before or after, no code fences.`;
}

function claudeRun(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('claude', ['-p', '--output-format', 'json', '--tools', '', ...args], {
      cwd: SESSIONS, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    p.stdout.on('data', d => (out += d));
    p.stderr.on('data', d => (err += d));
    p.on('error', reject);
    p.on('close', code => {
      try {
        const r = JSON.parse(out);
        if (r.is_error) return reject(new Error(r.result || 'claude error'));
        resolve(r);
      } catch {
        reject(new Error(`claude exited ${code}: ${(err || out).slice(0, 500)}`));
      }
    });
  });
}

// Ask within a session and parse the JSON reply; on bad JSON, ask once more in the same session.
// `session`: { id, create?, fork?, name? }. Returns { json, sessionId }.
async function claudeJson({ teacher, tone, model, session, prompt }) {
  const base = ['--model', model || DEFAULT_MODEL, '--system-prompt', system(teacher, tone)];
  const first = session.create
    ? ['--session-id', session.id, ...(session.name ? ['-n', session.name] : [])]
    : ['--resume', session.id, ...(session.fork ? ['--fork-session'] : [])];
  let r = await claudeRun([...base, ...first, prompt]);
  try {
    return { json: parseJson(r.result), sessionId: r.session_id };
  } catch (e) {
    r = await claudeRun([...base, '--resume', r.session_id,
      `That was not valid JSON (${e.message}). Reply again with the complete, valid JSON only.`]);
    return { json: parseJson(r.result), sessionId: r.session_id };
  }
}

// Main lesson sessions take one turn at a time.
const sessionQueues = new Map();
function inSession(id, fn) {
  const run = (sessionQueues.get(id) || Promise.resolve()).then(fn);
  sessionQueues.set(id, run.catch(() => {}));
  return run;
}

function parseJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < 0) throw new Error('no JSON object found');
  return JSON.parse(text.slice(start, end + 1));
}

// ---------- lesson storage ----------

const lessonDir = id => path.join(LESSONS, id.replace(/[^a-z0-9-]/gi, ''));
const lessonFile = id => path.join(lessonDir(id), 'lesson.json');

async function loadLesson(id) {
  return JSON.parse(await fsp.readFile(lessonFile(id), 'utf8'));
}
// Serialize writes per lesson so concurrent section/aside saves don't clobber each other.
const locks = new Map();
function updateLesson(id, fn) {
  const run = (locks.get(id) || Promise.resolve()).then(async () => {
    const lesson = await loadLesson(id);
    fn(lesson);
    lesson.updatedAt = new Date().toISOString();
    await fsp.writeFile(lessonFile(id), JSON.stringify(lesson, null, 2));
    return lesson;
  });
  locks.set(id, run.catch(() => {}));
  return run;
}

const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'lesson';
const WPM = 150;

// ---------- API ----------

const inflight = new Map();

async function writeSection(id, index) {
  let lesson = await loadLesson(id);
  if (lesson.sections[index]) return lesson.sections[index];
  // Parts are written in order within the lesson's session.
  if (index > 0 && !lesson.sections[index - 1]) await api['POST section']({ id, index: index - 1 });
  lesson = await loadLesson(id);
  const { outline, minutes } = lesson;
  const n = outline.sections.length;
  const s = outline.sections[index];
  const words = Math.round((minutes * WPM) / n);
  const { json: section } = await inSession(lesson.session, () => claudeJson({
    teacher: lesson.teacher, tone: lesson.tone, model: lesson.model, session: { id: lesson.session },
    prompt: `Write part ${index + 1} of ${n}: "${s.title}". About ${words} spoken words.
${index === 0 ? 'This is the opening of the lesson; the board starts empty.' : `Part ${index} has just been performed; the board still shows whatever it left there.`}
${index === n - 1 ? 'This is the final part of the lesson.' : ''}
Return: {"steps":[...]}`,
  }));
  await updateLesson(id, l => { l.sections[index] = section; });
  return section;
}

// ElevenLabs plans cap concurrent requests (3 on the current plan).
const TTS_CONCURRENCY = +process.env.ELEVENLABS_CONCURRENCY || 2;
let ttsActive = 0;
const ttsWaiting = [];
async function ttsSlot(fn) {
  if (ttsActive >= TTS_CONCURRENCY) await new Promise(r => ttsWaiting.push(r));
  ttsActive++;
  try { return await fn(); } finally { ttsActive--; ttsWaiting.shift()?.(); }
}

const api = {
  async 'POST outline'({ topic, minutes = 5, level, tone, teacher, model }) {
    const n = Math.max(1, Math.min(40, Math.round(minutes / 1.75)));
    const session = crypto.randomUUID();
    await fsp.mkdir(SESSIONS, { recursive: true });
    const { json: outline } = await inSession(session, () => claudeJson({
      teacher, tone, model, session: { id: session, create: true, name: `Lesson: ${topic}`.slice(0, 80) },
      prompt: `A student asked: "${topic}"
Plan a ${minutes}-minute lesson${level ? ` for a ${level} audience` : ''}, split into ${n} part(s) that will each be written separately (about ${Math.round(minutes / n * 10) / 10} minutes of speech each). Shape the lesson however you think teaches it best.
Return: {"title":"<short lesson title>","sections":[{"title":"...","plan":"<what this part covers and how you intend to show it on the board>"}]}
I'll then ask you for each part in turn.`,
    }));
    const id = `${new Date().toISOString().slice(0, 10)}-${slug(outline.title || topic)}-${crypto.randomBytes(2).toString('hex')}`;
    const lesson = {
      id, session, topic, minutes, level, tone, teacher, model: model || DEFAULT_MODEL,
      createdAt: new Date().toISOString(), outline, sections: [], asides: [], feedback: [],
    };
    await fsp.mkdir(path.join(lessonDir(id), 'audio'), { recursive: true });
    await fsp.writeFile(lessonFile(id), JSON.stringify(lesson, null, 2));
    api['POST section']({ id, index: 0 }).catch(() => {}); // start writing part 1 right away
    return lesson;
  },

  // Deduped: concurrent requests for the same part share one generation.
  'POST section'({ id, index }) {
    const key = `${id}:${index}`;
    if (!inflight.has(key)) {
      const p = writeSection(id, index);
      inflight.set(key, p);
      p.finally(() => inflight.delete(key)).catch(() => {});
    }
    return inflight.get(key);
  },

  async 'POST question'({ id, section, step, question, recent }) {
    const lesson = await loadLesson(id);
    // Fork the lesson session so the aside knows the whole lesson without blocking the next part.
    const last = lesson.outline.sections.length - 1;
    const atEnd = section >= last && step >= (lesson.sections[last]?.steps?.length || 0);
    const { json: aside } = await claudeJson({
      teacher: lesson.teacher, tone: lesson.tone, model: lesson.model, session: { id: lesson.session, fork: true },
      prompt: atEnd
        ? `The lesson has been performed to the end, and you asked the student if they had any questions.
They asked: "${question}"
Answer it. The answer starts on a fresh, empty board (the final board is restored afterwards), so draw whatever helps. Take as long as the question deserves. Don't wrap up the whole lesson again or say goodbye; you'll ask if there are more questions afterwards.
Return: {"steps":[...]}`
        : `The lesson is being performed; you are in part ${section + 1} ("${lesson.outline.sections[section]?.title}"), step ${step + 1}.
What you said just before: "${(recent || '').slice(-1500)}"
A student raised their hand and asked: "${question}"
Answer it as an aside. The aside starts on a fresh, empty board (the current board is saved and restored after you finish), so draw whatever helps. Take as long as the question deserves, then hand back to the lesson.
Return: {"steps":[...]}`,
    });
    const entry = { section, step, question, steps: aside.steps, askedAt: new Date().toISOString() };
    await updateLesson(id, l => { l.asides.push(entry); });
    return entry;
  },

  async 'POST feedback'({ id, liked, text }) {
    await updateLesson(id, l => { l.feedback.push({ liked, text, at: new Date().toISOString() }); });
    return { ok: true };
  },

  async 'POST progress'({ id, section, step }) {
    await updateLesson(id, l => { l.progress = { section, step }; });
    return { ok: true };
  },

  async 'GET lesson'(_, q) {
    return loadLesson(q.get('id'));
  },

  async 'GET lessons'() {
    await fsp.mkdir(LESSONS, { recursive: true });
    const out = [];
    for (const d of await fsp.readdir(LESSONS)) {
      try {
        const l = await loadLesson(d);
        out.push({
          id: l.id, title: l.outline?.title, topic: l.topic, minutes: l.minutes, createdAt: l.createdAt,
          updatedAt: l.updatedAt, parts: l.outline?.sections?.length, written: l.sections.filter(Boolean).length,
          asides: l.asides.length, progress: l.progress,
        });
      } catch {}
    }
    return out.sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt));
  },

  async 'DELETE lesson'(_, q) {
    await fsp.rm(lessonDir(q.get('id')), { recursive: true, force: true });
    return { ok: true };
  },

  async 'GET config'() {
    return { model: DEFAULT_MODEL, tts: !!ELEVENLABS_API_KEY, voice: DEFAULT_VOICE };
  },

  async 'GET voices'() {
    return ELEVENLABS_API_KEY ? VOICES : [];
  },

  // Speech for one step, with per-character timings. Cached on disk by (voice, model, text),
  // inside the lesson folder when there is one, so replays are free.
  async 'POST tts'({ text, voice, id }) {
    if (!ELEVENLABS_API_KEY) throw new Error('ElevenLabs key not configured');
    voice ||= DEFAULT_VOICE;
    const hash = crypto.createHash('sha1').update(`${voice}|${TTS_MODEL}|${text}`).digest('hex').slice(0, 16);
    const dir = id ? path.join(lessonDir(id), 'audio') : path.join(LESSONS, '_cache');
    const base = path.join(dir, hash);
    const url = '/' + path.relative(ROOT, base + '.mp3').split(path.sep).join('/');
    try {
      const timing = JSON.parse(await fsp.readFile(base + '.json', 'utf8'));
      return { url, ...timing };
    } catch {}
    const data = await ttsSlot(async () => {
      for (let attempt = 0; ; attempt++) {
        const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}/with-timestamps?output_format=mp3_44100_128`, {
          method: 'POST',
          headers: { 'xi-api-key': ELEVENLABS_API_KEY, 'content-type': 'application/json' },
          body: JSON.stringify({ text, model_id: TTS_MODEL }),
        });
        const data = await res.json();
        if (res.ok) return data;
        if (res.status === 429 && attempt < 4) { await new Promise(r => setTimeout(r, 1000 * (attempt + 1))); continue; }
        throw new Error(data?.detail?.message || `ElevenLabs error ${res.status}`);
      }
    });
    const a = data.alignment || {};
    const timing = {
      chars: a.characters || [],
      starts: a.character_start_times_seconds || [],
      duration: (a.character_end_times_seconds || []).at(-1) || 0,
    };
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(base + '.mp3', Buffer.from(data.audio_base64, 'base64'));
    await fsp.writeFile(base + '.json', JSON.stringify(timing));
    return { url, ...timing };
  },
};

// ---------- HTTP ----------

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.mp3': 'audio/mpeg', '.md': 'text/markdown; charset=utf-8', '.png': 'image/png',
};

function sendFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

// Speech-to-text for spoken questions: raw recorded audio in, { text } out (ElevenLabs Scribe).
async function transcribe(req, res) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const type = req.headers['content-type'] || 'audio/webm';
  const form = new FormData();
  form.append('model_id', process.env.ELEVENLABS_STT_MODEL || 'scribe_v2');
  form.append('tag_audio_events', 'false');
  form.append('file', new Blob([Buffer.concat(chunks)], { type }), 'question.' + (type.includes('mp4') ? 'm4a' : 'webm'));
  const r = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST', headers: { 'xi-api-key': ELEVENLABS_API_KEY }, body: form,
  });
  const data = await r.json();
  console.log(`stt: ${Buffer.concat(chunks).length} bytes ${type} -> ${r.status} "${(data.text || '').slice(0, 80)}"`);
  if (!r.ok) throw new Error(data?.detail?.message || `ElevenLabs STT error ${r.status}`);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ text: (data.text || '').trim() }));
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'POST' && url.pathname === '/api/stt') {
    return transcribe(req, res).catch(e => {
      console.error(e);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    });
  }
  if (url.pathname.startsWith('/api/')) {
    const fn = api[`${req.method} ${url.pathname.slice(5)}`];
    if (!fn) { res.writeHead(404); return res.end(); }
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const out = await fn(body ? JSON.parse(body) : {}, url.searchParams);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    } catch (e) {
      console.error(e);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (url.pathname.startsWith('/lessons/')) {
    const file = path.normalize(path.join(ROOT, decodeURIComponent(url.pathname)));
    if (!file.startsWith(LESSONS + path.sep)) { res.writeHead(403); return res.end(); }
    return sendFile(res, file);
  }
  const file = path.normalize(path.join(PUBLIC, decodeURIComponent(url.pathname)));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => sendFile(res, !err && st.isFile() ? file : path.join(PUBLIC, 'index.html')));
}).listen(PORT, () => {
  console.log(`Whiteboard Teacher on http://localhost:${PORT}`);
  console.log(`  Claude: claude -p --model ${DEFAULT_MODEL}   ElevenLabs: ${ELEVENLABS_API_KEY ? 'ok' : 'off (browser voice)'}`);
});
