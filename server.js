// Whiteboard Teacher — tiny zero-dependency server.
// Serves the static app, writes lessons with the `claude` CLI, proxies speech to ElevenLabs,
// and stores lessons (scripts + audio) under lessons/ for replay.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createAccounts } from './accounts.js';
import { loadBackends } from './backends/index.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const LESSONS = path.join(ROOT, 'lessons');
const DATA = path.resolve(ROOT, process.env.DATA_DIR || 'data'); // users, signing key (gitignored)
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

// Secrets can be 1Password references (op://vault/item/field), read with the `op` CLI
// (needs OP_SERVICE_ACCOUNT_TOKEN or desktop integration).
function opRead(ref) {
  try {
    return execFileSync('op', ['read', ref], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    console.warn(`Could not read ${ref} from 1Password`);
    return '';
  }
}


const PORT = process.env.PORT || 4747;

// Which service does each job (lessons, utility, voice, listening): data/config.json, or .env defaults.
const backends = loadBackends({
  dataDir: path.resolve(ROOT, process.env.DATA_DIR || 'data'), env: process.env, opRead,
  defaults: { 'claude-cli': { cwd: SESSIONS } },
});
// "No AI, no lecture": with no backend for a job, requests that need it fail kindly.
function backendFor(job) {
  const b = backends.first(job);
  if (!b) throw Object.assign(new Error("The teacher isn't available right now. Please try again soon."), { status: 503 });
  return b;
}

const accounts = createAccounts(DATA);

const SCRIPT_API = () => fs.readFileSync(path.join(ROOT, 'docs/SCRIPT_API.md'), 'utf8');

// ---------- writing lessons ----------
// Each lesson is one conversation with the `lessons` backend (for claude-cli, a Claude Code session
// named "Lesson: <title>"), so every part is written with the whole lesson so far in context.
// Questions and the quiz fork that conversation so they don't interrupt it.

// Teaching personalities the student can pick. The material stays accurate whatever the tone.
const TONES = {
  serious: 'Serious: earnest, rigorous and measured, like a respected professor. Humor is rare and dry. Precision matters.',
  matter: 'Matter of fact: clear, efficient, no-nonsense. Get straight to the point, minimal flourish, no filler, no cheerleading.',
  jovial: 'Jovial: warm, upbeat and good-humored. Light jokes, real enthusiasm, a big smile in the voice.',
  goofy: 'Goofy: playful and silly. Puns, absurd analogies, funny doodles on the board, comic timing (use the audio cues: [laughs], [gasps], [whispers], dramatic pauses), maybe a running gag. Still teach the material accurately and completely; the silliness is how you make it stick, not a replacement for substance.',
};

function system_(teacher, tone, policy, profile = '') {
  return `You are ${teacher || 'Claude'}, a brilliant${TONES[tone] ? '' : ', warm'} teacher giving a live lesson at a whiteboard. You write lessons as scripts that a program performs: your words are spoken by a text-to-speech voice and your drawing is drawn live in sync. Be the teacher you'd most want to learn from: make it vivid, visual and genuinely interesting.
${TONES[tone] ? `\nYour teaching personality for this lesson, chosen by the student: ${TONES[tone]}\n` : ''}${policyPrompt(policy)}${profilePrompt(profile)}
Here is the complete reference for the script format:

${SCRIPT_API()}

Every reply must be ONLY valid JSON, no prose before or after, no code fences.`;
}

// ---------- content policies ----------
// Plain-English policies in data/policies/: master.txt applies to everyone, plus one per age band.
// A learner's policy = master + their band + the admin's notes about them. Read on every use, so
// edits apply immediately. Starting text is copied from policy-defaults/ on first run.

const POLICIES = path.join(DATA, 'policies');
const POLICY_NAMES = ['master', ...accounts.AGE_BANDS];
fs.mkdirSync(POLICIES, { recursive: true });
for (const n of POLICY_NAMES) {
  const f = path.join(POLICIES, `${n}.txt`);
  if (!fs.existsSync(f)) fs.copyFileSync(path.join(ROOT, 'policy-defaults', `${n}.txt`), f);
}

const readPolicy = name => {
  try { return fs.readFileSync(path.join(POLICIES, `${name}.txt`), 'utf8'); } catch { return ''; }
};
// Lines starting with # are notes for whoever edits the file.
const policyBody = text => text.split('\n').filter(l => !l.trim().startsWith('#')).join('\n').trim();

function policyFor(user) {
  if (!user) return policyBody(readPolicy('master'));
  return [
    policyBody(readPolicy('master')),
    policyBody(readPolicy(user.ageBand || 'adult')),
    user.notes?.trim() ? `About this learner (from their parent/teacher): ${user.notes.trim()}` : '',
  ].filter(Boolean).join('\n\n');
}

function policyPrompt(p) {
  return p ? `
CONTENT POLICY (set by the person who runs this app; it overrides the student's chosen level and style
wherever they conflict). Everything you say and draw must follow it:
${p}
` : '';
}

// Refusals, appended to data/log.jsonl for the admin.
function logRefusal(user, kind, text, message) {
  const line = JSON.stringify({ at: new Date().toISOString(), user: user?.id, kind, text, message });
  fs.appendFile(path.join(DATA, 'log.jsonl'), line + '\n', () => {});
}

// ---------- learning profiles ----------
// data/profiles/<user>.md: a plain-English guide to how this learner learns best, maintained by Claude
// after each lesson and editable by the admin. The "## From the grown-up" section is the admin's and
// is always kept verbatim. Included in that learner's lesson prompts.

const PROFILES = path.join(DATA, 'profiles');
fs.mkdirSync(PROFILES, { recursive: true });
const ADMIN_SECTION = '## From the grown-up';
const profileFile = id => path.join(PROFILES, `${String(id).replace(/[^a-z0-9]/gi, '')}.md`);
const readProfile = id => { try { return fs.readFileSync(profileFile(id), 'utf8'); } catch { return ''; } };

// Split out the admin's section (heading through the next "## " heading).
function adminSection(md) {
  const i = md.indexOf(ADMIN_SECTION);
  if (i < 0) return '';
  const rest = md.slice(i + ADMIN_SECTION.length);
  const j = rest.search(/\n## /);
  return (ADMIN_SECTION + (j < 0 ? rest : rest.slice(0, j))).trim();
}

function profilePrompt(md) {
  md = md.trim();
  return md ? `
LEARNING PROFILE for this student (what you've learned about how they learn best, plus notes from their
parent/teacher). Use it to shape pace, depth, examples, humor and how you use the board. Don't mention it.
${md}
` : '';
}

const profileTimers = new Map();
// Debounced: a lesson's feedback and quiz usually arrive within a minute or two of each other.
function scheduleProfileUpdate(lessonId, delayMs = 120000) {
  if (process.env.PROFILE_DELAY_MS) delayMs = +process.env.PROFILE_DELAY_MS; // for testing
  clearTimeout(profileTimers.get(lessonId));
  profileTimers.set(lessonId, setTimeout(() => {
    profileTimers.delete(lessonId);
    updateProfile(lessonId).catch(e => console.error('profile update', e.message));
  }, delayMs));
}

async function updateProfile(lessonId) {
  const lesson = await loadLesson(lessonId);
  const user = accounts.byId(lesson.owner);
  if (!user) return;
  const current = readProfile(user.id);
  const quiz = lesson.quiz?.questions || [];
  const lastQuiz = lesson.quizResults?.at(-1);
  const evidence = {
    lesson: { title: lesson.outline?.title, asked: lesson.topic, minutes: lesson.minutes, style: lesson.tone || 'any', level: lesson.level || 'any', date: lesson.createdAt?.slice(0, 10) },
    finished: !!lesson.progress && lesson.progress.section >= (lesson.outline?.sections?.length || 1) - 1,
    questionsAsked: (lesson.asides || []).map(a => a.question),
    quiz: lastQuiz ? {
      score: `${lastQuiz.score}/${lastQuiz.total}`,
      missed: (lastQuiz.answers || []).map((a, i) => (quiz[i] && a !== quiz[i].answer ? { question: quiz[i].q, chose: quiz[i].choices[a], correct: quiz[i].choices[quiz[i].answer] } : null)).filter(Boolean),
    } : 'skipped or not taken',
    feedback: (lesson.feedback || []).map(f => ({ liked: f.liked, said: f.text })),
  };
  const text = await backendFor('utility').once({
    system: `You maintain a learning profile for one student of a whiteboard teaching app: a short plain-English guide
for the teacher (an AI that writes their lessons) on how this student learns best. Update it with evidence from
the lesson they just had. Keep what's still true, revise what the evidence contradicts, and don't over-react to
one lesson. Be specific and practical ("loves big-number comparisons", "lost interest in long derivations",
"mixes up mass and weight"). Under ~350 words.
Use these sections (omit any with nothing to say yet):
## How they like to learn   (pace, length, drawings vs talking, humor, which teaching styles landed)
## Interests                (topics they keep coming back to; hooks that work)
## What they've covered     (brief running list: topic + date + how well it stuck)
## Watch out for            (misconceptions, sensitivities, things that didn't land)
Do NOT write a "${ADMIN_SECTION}" section; that one is written by the parent/teacher and kept separately.
Reply with ONLY the profile markdown.`,
    prompt: `Student: ${user.name}, age band ${user.ageBand}.
${adminSection(current) ? `The parent/teacher's notes (respect these; they override your inferences):
${adminSection(current)}
` : ''}
Current profile:
${current.replace(adminSection(current), '').trim() || '(empty: this is their first lesson with a profile)'}

Evidence from the lesson just finished:
${JSON.stringify(evidence, null, 2)}`,
  });
  const body = String(text || '').replace(/^```(?:markdown)?\n?|```$/g, '').trim();
  if (!body) return;
  const admin = adminSection(readProfile(user.id)); // re-read: the admin may have edited meanwhile
  if (current) await fsp.writeFile(profileFile(user.id) + '.prev', current);
  await fsp.writeFile(profileFile(user.id), (admin ? admin + '\n\n' : '') + body + '\n');
  console.log(`profile updated: ${user.name} (${lesson.outline?.title})`);
}

class Refused extends Error {
  constructor(message, suggestions = []) { super(message); this.suggestions = suggestions; }
}

// Returns { decision: 'allow' | 'adapt' | 'refuse', message, note }; throws Refused when refused.
async function screen(text, kind, user) {
  const p = policyFor(user);
  if (!p) return { decision: 'allow' };
  const reply = await backendFor('utility').once({
    system: `You screen requests for a whiteboard teaching app against a content policy written by the person who runs it (often a parent or teacher).
POLICY:
${p}

Decide for the ${kind} you are given:
- "allow": fine as is.
- "adapt": the subject is OK to teach but parts must be handled carefully or left out for this audience. Put guidance for the teacher in "note".
- "refuse": the policy says this shouldn't be taught at all. Put a short, kind message to the learner in "message" (one or two sentences, suitable for the audience, no lecturing; suggest a nearby topic they could ask about instead if there is a good one). Also put 2-3 related topics that ARE fine under the policy in "suggestions": short questions in the learner's own voice that would make a fun lesson (e.g. "How are swords forged?"), matching any you mention in the message.
Be sensible: curiosity is good, and most topics can be adapted. Refuse only what the policy rules out.
Judge the request as the learner literally asked it. If what they asked for is ruled out (e.g. how to make
something the policy forbids, or a cheeky request for something rude), REFUSE it, even when a safe related topic
exists (its history, a word with a double meaning): offer that safe topic in "suggestions" rather than quietly
teaching it instead. "adapt" is for requests that are fine as asked but need care in places.
Many refusals will be kids being cheeky for a laugh (rude words, potty humor, "show me something naughty").
Don't scold or shame: answer with good humor, like a teacher who's heard it all and is amused, and redirect
to something genuinely fun and related if you can (a pun or a real-world double meaning is perfect).
The message is spoken aloud by the teacher's voice, so write it to be said, not read.
Reply with ONLY JSON: {"decision":"allow|adapt|refuse","note":"...","message":"...","suggestions":["..."]}`,
    prompt: text,
  });
  const v = parseJson(reply);
  console.log(`screen ${kind}: ${v.decision} "${text.slice(0, 60)}"${v.note ? ` (${v.note.slice(0, 80)})` : ''}`);
  if (v.decision === 'refuse') {
    const suggestions = (Array.isArray(v.suggestions) ? v.suggestions : []).filter(x => typeof x === 'string' && x.trim()).slice(0, 3);
    logRefusal(user, kind, text, v.message);
    throw new Refused(v.message || "That's not something I can teach here. Try asking about something else!", suggestions);
  }
  return v;
}

// Ask the `lessons` backend and parse the JSON reply; on bad JSON, ask once more in the same conversation.
// mode: 'start' (new conversation; `name` labels it), 'continue' or 'fork' (of `convo`).
// Returns { json, convo }.
async function askJson({ teacher, tone, policy, profile, model, mode, convo, name, prompt }) {
  const b = backendFor('lessons');
  const system = system_(teacher, tone, policy, profile);
  let r = await b[mode]({ system, prompt, convo, name, model });
  try {
    return { json: parseJson(r.text), convo: r.convo };
  } catch (e) {
    r = await b.continue({ system, convo: r.convo, model,
      prompt: `That was not valid JSON (${e.message}). Reply again with the complete, valid JSON only.` });
    return { json: parseJson(r.text), convo: r.convo };
  }
}

// A lesson's main conversation takes one turn at a time.
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

const httpError = (status, message) => Object.assign(new Error(message), { status });

// The content policy that applies to a lesson is its learner's (master + band + notes).
const lessonPolicy = lesson => policyFor(accounts.byId(lesson.owner));
// The lesson's main conversation (older lessons stored a claude-cli session id as `session`).
const lessonConvo = lesson => lesson.convo || lesson.session;

// Load a lesson the signed-in user may use: their own, or any lesson for an admin.
async function ownLesson(ctx, id) {
  let lesson;
  try { lesson = await loadLesson(id); } catch { throw httpError(404, 'No such lesson'); }
  if (lesson.owner !== ctx.user.id && !ctx.admin) throw httpError(403, 'Not your lesson');
  return lesson;
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
  const { json: section } = await inSession(lessonConvo(lesson), () => askJson({
    teacher: lesson.teacher, tone: lesson.tone, policy: lessonPolicy(lesson), profile: readProfile(lesson.owner), model: lesson.model,
    mode: 'continue', convo: lessonConvo(lesson),
    prompt: `Write part ${index + 1} of ${n}: "${s.title}". About ${words} spoken words.
${index === 0 ? 'This is the opening of the lesson; the board starts empty.' : `Part ${index} has just been performed; the board still shows whatever it left there.`}
${index === n - 1 ? 'This is the final part of the lesson.' : ''}
Return: {"steps":[...]}`,
  }));
  await updateLesson(id, l => { l.sections[index] = section; });
  return section;
}

async function writeQuiz(id) {
  let lesson = await loadLesson(id);
  if (lesson.quiz) return lesson.quiz;
  // The quiz covers the whole lesson, so make sure every part has been written first.
  const n = lesson.outline.sections.length;
  if (!lesson.sections[n - 1]) await api['POST section']({ id, index: n - 1 });
  lesson = await loadLesson(id);
  const count = lesson.minutes <= 5 ? 3 : lesson.minutes <= 10 ? 5 : 8;
  const { json: quiz } = await askJson({
    teacher: lesson.teacher, tone: lesson.tone, policy: lessonPolicy(lesson), profile: readProfile(lesson.owner), model: lesson.model,
    mode: 'fork', convo: lessonConvo(lesson),
    prompt: `The lesson has been performed. Now write a short quiz on it: ${count} multiple-choice questions that check
understanding of the most important ideas you actually taught (not trivia, not anything you didn't cover). Mix
recall with "why" and "what would happen if" questions. Each has 3 or 4 short choices with exactly one correct.
Everything is spoken aloud by the teacher's voice as well as shown, so:
- "q": the question, written naturally (it's shown on screen too, so use digits for numbers and years;
  just avoid symbols that would sound odd read aloud).
- "choices": short answer options (shown on screen; also read aloud).
- "answer": index of the correct choice (0-based).
- "explain": one or two spoken sentences on why the right answer is right, in your teaching voice (it's said after
  the student answers, whether they got it right or wrong, so don't start with "Correct" or "Wrong").
Return: {"questions":[{"q":"...","choices":["..."],"answer":0,"explain":"..."}]}`,
  });
  const questions = (quiz.questions || []).filter(q => q.q && Array.isArray(q.choices) && q.choices[q.answer] !== undefined);
  await updateLesson(id, l => { l.quiz = { questions }; });
  return { questions };
}

const api = {
  async 'POST outline'({ topic, minutes = 5, level, tone, teacher, model }, _, ctx) {
    // Screen first: nothing reaches the lesson writer until the topic passes the content policy.
    await screen(topic, 'lesson topic', ctx.user);
    const n = Math.max(1, Math.min(40, Math.round(minutes / 1.75)));
    const { json: outline, convo } = await askJson({
      teacher, tone, policy: policyFor(ctx.user), profile: readProfile(ctx.user.id), model,
      mode: 'start', name: `Lesson: ${topic}`.slice(0, 80),
      prompt: `A student asked: "${topic}"
Plan a ${minutes}-minute lesson${level ? ` for a ${level} audience` : ''}, split into ${n} part(s) that will each be written separately (about ${Math.round(minutes / n * 10) / 10} minutes of speech each). Shape the lesson however you think teaches it best.
Return: {"title":"<short lesson title>","sections":[{"title":"...","plan":"<what this part covers and how you intend to show it on the board>"}]}
I'll then ask you for each part in turn.`,
    });
    const id = `${new Date().toISOString().slice(0, 10)}-${slug(outline.title || topic)}-${crypto.randomBytes(2).toString('hex')}`;
    const lesson = {
      id, owner: ctx.user.id, convo, topic, minutes, level, tone, teacher, model: model || null,
      createdAt: new Date().toISOString(), outline, sections: [], asides: [], feedback: [],
    };
    await fsp.mkdir(path.join(lessonDir(id), 'audio'), { recursive: true });
    await fsp.writeFile(lessonFile(id), JSON.stringify(lesson, null, 2));
    api['POST section']({ id, index: 0 }).catch(() => {}); // start writing part 1 right away
    return lesson;
  },

  // Deduped: concurrent requests for the same part share one generation.
  // ctx is absent for internal calls (prefetching), which skip the ownership check.
  async 'POST section'({ id, index }, _, ctx) {
    if (ctx) await ownLesson(ctx, id);
    const key = `${id}:${index}`;
    if (!inflight.has(key)) {
      const p = writeSection(id, index);
      inflight.set(key, p);
      p.finally(() => inflight.delete(key)).catch(() => {});
    }
    return inflight.get(key);
  },

  async 'POST question'({ id, section, step, question, recent }, _, ctx) {
    const lesson = await ownLesson(ctx, id);
    // Screen first, as for topics.
    await screen(`Lesson: "${lesson.outline.title}". Question: "${question}"`, "student's question during a lesson", accounts.byId(lesson.owner));
    // Fork the lesson session so the aside knows the whole lesson without blocking the next part.
    const last = lesson.outline.sections.length - 1;
    const atEnd = section >= last && step >= (lesson.sections[last]?.steps?.length || 0);
    const { json: aside } = await askJson({
      teacher: lesson.teacher, tone: lesson.tone, policy: lessonPolicy(lesson), profile: readProfile(lesson.owner), model: lesson.model,
      mode: 'fork', convo: lessonConvo(lesson),
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

  // End-of-lesson quiz, written in a fork of the lesson's session (so it knows exactly what was
  // taught) and saved with the lesson. Deduped like sections, so prefetching is safe.
  async 'POST quiz'({ id }, _, ctx) {
    await ownLesson(ctx, id);
    const key = `${id}:quiz`;
    if (!inflight.has(key)) {
      const p = writeQuiz(id);
      inflight.set(key, p);
      p.finally(() => inflight.delete(key)).catch(() => {});
    }
    return inflight.get(key);
  },

  async 'POST quizResult'({ id, score, total, answers }, _, ctx) {
    await ownLesson(ctx, id);
    await updateLesson(id, l => { (l.quizResults ||= []).push({ score, total, answers, at: new Date().toISOString() }); });
    scheduleProfileUpdate(id);
    return { ok: true };
  },

  async 'POST feedback'({ id, liked, text }, _, ctx) {
    await ownLesson(ctx, id);
    await updateLesson(id, l => { l.feedback.push({ liked, text, at: new Date().toISOString() }); });
    scheduleProfileUpdate(id);
    return { ok: true };
  },

  async 'POST progress'({ id, section, step }, _, ctx) {
    await ownLesson(ctx, id);
    const l = await updateLesson(id, l => { l.progress = { section, step }; });
    // Finished the last part: update their learning profile (debounced, so feedback/quiz get included).
    const last = l.outline.sections.length - 1;
    if (section >= last && step >= (l.sections[last]?.steps?.length || Infinity)) scheduleProfileUpdate(id, 300000);
    return { ok: true };
  },

  async 'GET lesson'(_, q, ctx) {
    return ownLesson(ctx, q.get('id'));
  },

  // The signed-in user's lessons (admins can pass ?user= to see a learner's).
  async 'GET lessons'(_, q, ctx) {
    const owner = ctx.admin && q.get('user') ? q.get('user') : ctx.user.id;
    await fsp.mkdir(LESSONS, { recursive: true });
    const out = [];
    for (const d of await fsp.readdir(LESSONS)) {
      try {
        const l = await loadLesson(d);
        if (l.owner !== owner) continue;
        out.push({
          id: l.id, title: l.outline?.title, topic: l.topic, minutes: l.minutes, createdAt: l.createdAt,
          updatedAt: l.updatedAt, parts: l.outline?.sections?.length, written: l.sections.filter(Boolean).length,
          asides: l.asides.length, progress: l.progress, lastQuiz: l.quizResults?.at(-1) || null,
        });
      } catch {}
    }
    return out.sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt));
  },

  async 'DELETE lesson'(_, q, ctx) {
    await ownLesson(ctx, q.get('id'));
    await fsp.rm(lessonDir(q.get('id')), { recursive: true, force: true });
    return { ok: true };
  },

  // ----- accounts -----
  // Public (no session needed): me, profiles, setup, login, logout.

  async 'GET me'(_, q, ctx) {
    return { setup: accounts.needsSetup(), user: accounts.public(ctx.user, true), admin: ctx.admin };
  },

  // Profiles for the "who's learning?" picker.
  async 'GET profiles'() {
    return accounts.users.map(u => accounts.public(u));
  },

  // First run only: create the admin.
  async 'POST setup'({ name, avatar, password }, _, ctx) {
    if (!accounts.needsSetup()) throw httpError(403, 'Already set up');
    const u = accounts.create({ name, avatar, role: 'admin', ageBand: 'adult', secret: password });
    ctx.cookies.push(...accounts.login(ctx.req, u.id, password));
    return { ok: true };
  },

  async 'POST login'({ id, secret }, _, ctx) {
    ctx.cookies.push(...accounts.login(ctx.req, id, secret));
    return { ok: true };
  },

  async 'POST logout'(_, q, ctx) {
    ctx.cookies.push(...accounts.logout(ctx.req));
    return { ok: true };
  },

  // Admin password again after the 30-minute admin window lapsed.
  async 'POST elevate'({ password }, _, ctx) {
    ctx.cookies.push(...accounts.elevate(ctx.req, ctx.user, password));
    return { ok: true };
  },

  // Per-user settings. Learners may change their voice, speed and lesson defaults; teacher name
  // and model are admin choices.
  async 'PUT settings'(body, _, ctx) {
    const allowed = ['voice', 'rate', 'minutes', 'level', 'tone', 'captions', 'browserVoice'];
    if (ctx.user.role === 'admin') allowed.push('teacher', 'model');
    const picked = Object.fromEntries(Object.entries(body).filter(([k]) => allowed.includes(k)));
    return accounts.saveSettings(ctx.user, picked);
  },

  // ----- admin -----

  async 'GET admin/users'() {
    return accounts.users.map(u => accounts.public(u, true));
  },

  async 'POST admin/users'(body) {
    return accounts.public(accounts.create(body), true);
  },

  async 'PUT admin/users'(body) {
    return accounts.public(accounts.update(body.id, body), true);
  },

  async 'DELETE admin/users'(_, q, ctx) {
    accounts.remove(q.get('id'), ctx.user);
    return { ok: true };
  },

  async 'GET admin/policies'() {
    return Object.fromEntries(POLICY_NAMES.map(n => [n, readPolicy(n)]));
  },

  async 'PUT admin/policies'({ name, text }) {
    if (!POLICY_NAMES.includes(name)) throw httpError(400, 'Unknown policy');
    await fsp.writeFile(path.join(POLICIES, `${name}.txt`), String(text ?? ''));
    return { ok: true };
  },

  // Everything a learner has done, for the admin: lessons, questions asked, quiz scores, feedback.
  async 'GET admin/history'(_, q) {
    const user = q.get('user');
    const out = { lessons: [], questions: [], quizzes: [], feedback: [] };
    for (const d of await fsp.readdir(LESSONS).catch(() => [])) {
      let l;
      try { l = await loadLesson(d); } catch { continue; }
      if (l.owner !== user) continue;
      const title = l.outline?.title || l.topic;
      out.lessons.push({ id: l.id, title, topic: l.topic, minutes: l.minutes, tone: l.tone, createdAt: l.createdAt });
      for (const a of l.asides || []) out.questions.push({ lesson: title, lessonId: l.id, question: a.question, at: a.askedAt });
      for (const r of l.quizResults || []) out.quizzes.push({ lesson: title, lessonId: l.id, score: r.score, total: r.total, at: r.at });
      for (const f of l.feedback || []) out.feedback.push({ lesson: title, lessonId: l.id, liked: f.liked, text: f.text, at: f.at });
    }
    const newest = (a, b) => String(b.at || b.createdAt).localeCompare(String(a.at || a.createdAt));
    for (const k of Object.keys(out)) out[k].sort(newest);
    return out;
  },

  async 'GET admin/profile'(_, q) {
    const f = profileFile(q.get('user'));
    let updatedAt = null;
    try { updatedAt = (await fsp.stat(f)).mtime; } catch {}
    return { text: readProfile(q.get('user')), updatedAt, adminHeading: ADMIN_SECTION };
  },

  async 'PUT admin/profile'({ user, text }) {
    if (!accounts.byId(user)) throw httpError(404, 'No such learner');
    await fsp.writeFile(profileFile(user), String(text ?? ''));
    return { ok: true };
  },

  // Refusals for one learner (or everyone), newest first.
  async 'GET admin/refusals'(_, q) {
    let lines = [];
    try { lines = (await fsp.readFile(path.join(DATA, 'log.jsonl'), 'utf8')).trim().split('\n'); } catch {}
    const user = q.get('user');
    return lines.filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(r => r && (!user || r.user === user)).reverse().slice(0, 200);
  },

  // What the client needs to know about the backends.
  async 'GET config'() {
    const v = backends.first('voice');
    return {
      tts: !!v, // false → the browser's own voice
      voice: backends.defaultVoice(),
      audioTags: !!v?.capabilities.audioTags,
      listening: !!backends.first('listening'), // false → no mic buttons
    };
  },

  // ----- admin: backends -----
  async 'GET admin/backends'() {
    return backends.adminView();
  },

  async 'PUT admin/backends'(body) {
    const view = backends.update(body);
    console.log(`backends updated:\n  ${backends.describe()}`);
    return view;
  },

  async 'POST admin/backend-test'({ id }) {
    return backends.test(id);
  },

  // Voices learners may choose (the admin's catalog), as { value, name, backend, default }.
  async 'GET voices'() {
    return backends.voiceList();
  },

  async 'GET admin/voices'() {
    return backends.voiceCatalog();
  },

  async 'PUT admin/voices'({ backend, enabled, default: def }) {
    return backends.setVoiceCatalog(backend, { enabled, default: def });
  },

  // Speech for one step. Tries the learner's voice, then each other voice backend's default, in
  // order: cached audio first (free, works even if that backend is down), then generating it.
  // Server backends return { url, ...timing }; browser backends return { browser: spec } and the
  // client makes the audio itself.
  async 'POST tts'({ text, voice, id }, _, ctx) {
    if (id) await ownLesson(ctx, id);
    const chosen = backends.resolveVoice(voice, { any: ctx.admin });
    if (!chosen) throw httpError(503, "The teacher's voice isn't available right now.");
    const candidates = [chosen, ...backends.jobs.voice.filter(b => b !== chosen.backend)
      .map(b => ({ backend: b, voice: backends.defaultVoiceOf(b) }))];
    const dir = id ? path.join(lessonDir(id), 'audio') : path.join(LESSONS, '_cache');
    for (const c of candidates) {
      const { backend: b, voice: v } = c;
      if (b.capabilities.runsIn === 'browser') {
        if (!backends.healthy(b)) continue;
        return { browser: { backend: b.id, ...b.clientSpec(v) } };
      }
      // The original cache key had no backend id; keep it for ElevenLabs so existing audio stays valid.
      const keyParts = b.type === 'elevenlabs' ? [v, b.model, text] : [b.id, b.model, v, text];
      const base = path.join(dir, crypto.createHash('sha1').update(keyParts.join('|')).digest('hex').slice(0, 16));
      const urlFor = ext => '/' + path.relative(ROOT, `${base}.${ext}`).split(path.sep).join('/');
      try {
        const meta = JSON.parse(await fsp.readFile(base + '.json', 'utf8'));
        return { url: urlFor(meta.ext || 'mp3'), ...meta };
      } catch {}
      if (!backends.healthy(b)) continue;
      try {
        const { audio, ext, timing } = await b.speak({ text, voice: v });
        const meta = { ...(timing || {}), ...(ext !== 'mp3' ? { ext } : {}) };
        await fsp.mkdir(dir, { recursive: true });
        await fsp.writeFile(`${base}.${ext}`, audio);
        await fsp.writeFile(base + '.json', JSON.stringify(meta));
        return { url: urlFor(ext), ...meta };
      } catch (e) {
        backends.markFailed(b, e);
      }
    }
    throw httpError(503, "The teacher's voice isn't available right now.");
  },
};

// ---------- HTTP ----------

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.md': 'text/markdown; charset=utf-8', '.png': 'image/png',
};

function sendFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    // no-cache: always revalidate, so edits to the app show up on a normal reload.
    // Cross-origin isolation lets in-browser voices use multi-threaded WebAssembly (much faster).
    // "credentialless" still allows the CDN scripts and fonts.
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache',
      'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'credentialless',
    });
    res.end(data);
  });
}

// Speech-to-text for spoken questions: raw recorded audio in, { text } out (the `listening` backend).
async function transcribe(req, res) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const mime = req.headers['content-type'] || 'audio/webm';
  const audio = Buffer.concat(chunks);
  const text = await backendFor('listening').transcribe({ audio, mime });
  console.log(`stt: ${audio.length} bytes ${mime} -> "${text.slice(0, 80)}"`);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ text }));
}

const PUBLIC_API = new Set(['GET me', 'GET profiles', 'POST setup', 'POST login', 'POST logout']);
const json = (res, status, body, cookies = []) => {
  res.writeHead(status, { 'content-type': 'application/json', ...(cookies.length ? { 'set-cookie': cookies } : {}) });
  res.end(JSON.stringify(body));
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const { user, admin, refresh } = accounts.session(req);
  const ctx = { req, user, admin, cookies: [...refresh] };

  if (url.pathname.startsWith('/api/')) {
    const name = `${req.method} ${url.pathname.slice(5)}`;
    // Authorization: public endpoints, then signed-in users, then admin-only (admin/*, elevate needs a user).
    if (!PUBLIC_API.has(name)) {
      if (!user) return json(res, 401, { error: 'Not signed in', signin: true });
      if (name.includes(' admin/') && !admin) return json(res, 403, { error: 'Admin password needed', elevate: user.role === 'admin' });
    }
    if (name === 'POST stt') {
      return transcribe(req, res).catch(e => { console.error(e); json(res, 500, { error: e.message }); });
    }
    const fn = api[name];
    if (!fn) { res.writeHead(404); return res.end(); }
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const out = await fn(body ? JSON.parse(body) : {}, url.searchParams, ctx);
      json(res, 200, out, ctx.cookies);
    } catch (e) {
      if (e instanceof Refused) return json(res, 422, { error: e.message, refused: true, suggestions: e.suggestions }, ctx.cookies);
      if (e.status) return json(res, e.status, { error: e.message }, ctx.cookies);
      console.error(e);
      json(res, 500, { error: e.message }, ctx.cookies);
    }
    return;
  }

  // Lesson audio: only for the lesson's owner (or an admin); shared cache for any signed-in user.
  if (url.pathname.startsWith('/lessons/')) {
    if (!user) { res.writeHead(401); return res.end(); }
    const file = path.normalize(path.join(ROOT, decodeURIComponent(url.pathname)));
    if (!file.startsWith(LESSONS + path.sep)) { res.writeHead(403); return res.end(); }
    const lessonId = path.relative(LESSONS, file).split(path.sep)[0];
    if (lessonId !== '_cache') {
      try { await ownLesson(ctx, lessonId); } catch (e) { res.writeHead(e.status || 404); return res.end(); }
    }
    return sendFile(res, file);
  }
  const file = path.normalize(path.join(PUBLIC, decodeURIComponent(url.pathname)));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => sendFile(res, !err && st.isFile() ? file : path.join(PUBLIC, 'index.html')));
}).listen(PORT, () => {
  console.log(`Whiteboard Teacher on http://localhost:${PORT}`);
  console.log(`  ${backends.describe()}`);
});
