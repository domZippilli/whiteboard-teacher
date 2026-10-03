// Whiteboard Teacher — app shell and lesson player.
import { Board } from './board.js';
import { createAccountUI } from './account.js';

const $ = s => document.querySelector(s);
// Signed out → back to the profile picker. Admin mode lapsed → ask for the password and retry once.
const api = async (path, body, method, retried) => {
  const res = await fetch('/api/' + path, {
    method: method || (body ? 'POST' : 'GET'),
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (res.status === 401 && data.signin) { player?.stop(); account.showPicker(); }
  if (res.status === 403 && data.elevate && !retried && await account.askAdminPassword()) return api(path, body, method, true);
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { refused: !!data.refused, suggestions: data.suggestions || [] });
  return data;
};

// ---------- settings ----------

// Settings belong to the signed-in user and live on the server (so a shared tablet follows the profile).
const DEFAULTS = { teacher: 'Claude', voice: '', rate: 1, model: 'opus', minutes: 5, level: '', tone: '', captions: false };
const settings = { ...DEFAULTS };
let me = null; // { user, admin }
let settingsTimer;
function saveSettings() {
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => api('settings', settings, 'PUT').catch(() => {}), 300);
}
let config = { tts: false };

function applyName() {
  $('#teacherName').textContent = settings.teacher;
  document.title = `Ask ${settings.teacher}`;
  $('#q').placeholder = `What would you like ${settings.teacher} to teach you? (hold A to talk)`;
}

// ---------- speech ----------
// ElevenLabs via the server (with per-character timings), falling back to the browser voice.

// Each step is generated separately, so loudness varies between them. Run playback through a
// compressor + makeup gain to even it out. Created on first use (needs a user gesture).
let audioCtx;
function levelAudio(audio) {
  if (audio._leveled) return;
  try {
    audioCtx ||= new AudioContext();
    const src = audioCtx.createMediaElementSource(audio);
    const comp = new DynamicsCompressorNode(audioCtx, { threshold: -24, knee: 12, ratio: 4, attack: 0.01, release: 0.3 });
    const gain = new GainNode(audioCtx, { gain: 1.6 });
    src.connect(comp).connect(gain).connect(audioCtx.destination);
    audio._leveled = true;
  } catch (e) { console.warn('audio leveling unavailable', e); }
}

// Speech for some text: { url, duration, starts? } from the server, or made in this browser when the
// server says the voice runs here ({ browser: spec }). null → the device's own voice (Web Speech).
const ttsCache = new Map();
function speech(text, lessonId, voice = settings.voice) {
  if (!text?.trim()) return Promise.resolve(null);
  const key = `${voice}|${text}`;
  if (!ttsCache.has(key)) {
    const p = !config.tts ? Promise.resolve(null)
      : api('tts', { text, voice: voice || undefined, id: lessonId })
        .then(r => (r.browser ? browserSpeech(stripCues(text), r.browser) : r))
        .catch(e => { console.warn(e); return null; });
    ttsCache.set(key, p);
  }
  return ttsCache.get(key);
}

// ---------- in-browser voices (voice-worker.js) ----------
// The first use downloads the model (~90 MB, then cached by the browser): show progress meanwhile.
let voiceWorker = null;
let voiceBroken = false;
const voiceJobs = new Map();
function browserSpeech(text, spec) {
  if (voiceBroken) return Promise.resolve(null);
  if (!voiceWorker) {
    voiceWorker = new Worker('/voice-worker.js', { type: 'module' });
    voiceWorker.onmessage = ({ data }) => {
      if (data.type === 'progress') return voiceProgress(data.loaded / data.total);
      if (data.type === 'ready') return voiceProgress(null);
      const job = voiceJobs.get(data.id);
      if (!job) return;
      voiceJobs.delete(data.id);
      if (data.type === 'audio') {
        job.resolve({ url: URL.createObjectURL(new Blob([data.wav], { type: 'audio/wav' })), duration: data.duration, local: true });
      } else {
        console.warn('in-browser voice failed:', data.message);
        voiceProgress(null);
        // If the model can't run on this device, stop trying and use the device's voice instead.
        if (/load|fetch|backend|webgpu|wasm|import/i.test(data.message)) voiceBroken = true;
        job.resolve(null);
      }
    };
    voiceWorker.onerror = e => { console.warn('voice worker', e.message); voiceBroken = true; voiceProgress(null); };
  }
  const id = crypto.randomUUID();
  return new Promise(resolve => {
    voiceJobs.set(id, { resolve });
    voiceWorker.postMessage({ type: 'speak', id, spec, text });
  });
}
function voiceProgress(frac) {
  const el = $('#voiceLoading');
  el.classList.toggle('hidden', frac === null);
  if (frac !== null) el.textContent = `Getting the voice ready… ${Math.round(frac * 100)}%`;
}

// [audio tags] are delivery cues for the voice model, never shown or spoken by the browser voice.
const stripCues = text => text.replace(/\[[^\]]*\]\s*/g, '').trim();

// Estimated seconds for text when we have no timings (browser voice).
const estimate = text => (text.split(/\s+/).filter(Boolean).length / 2.6 + (text.match(/[.,;:!?]/g) || []).length * 0.15);

// ---------- little spoken lines ----------
// Short lines in the teacher's voice outside the script: "Hmm..." while a question is being
// answered, "Any questions?" at the end. Cached on disk per voice.

const LINES = {
  hmm: [
    '[thoughtful] Hmm...',
    '[thoughtful] Hmm, good question...',
    '[curious] Ooh. Let me think...',
    '[thoughtful] Hmm... okay...',
  ],
  anyQuestions: [
    '[warmly] And that\'s the lesson. [pause] So... any questions?',
    '[warmly] That\'s it for today. [pause] Any questions? Anything you\'d like me to go over again?',
  ],
  anyMore: [
    '[warmly] Any other questions?',
    '[curious] Anything else you\'re wondering about?',
  ],
};
const lineAudio = new Audio();
// Pre-make the teacher's little lines. For an in-browser voice, just the first (which also loads the
// model in the background); the rest are made when needed.
async function warmLines() {
  if (!config.tts) return;
  const first = await speech(LINES.hmm[0]);
  if (first && !first.local) Object.values(LINES).flat().forEach(t => speech(t));
}
async function sayLine(kind) {
  const list = LINES[kind];
  const text = list[Math.floor(Math.random() * list.length)];
  if (!config.tts) {
    const u = new SpeechSynthesisUtterance(stripCues(text));
    u.rate = settings.rate;
    return speechSynthesis.speak(u);
  }
  const r = await speech(text);
  if (!r?.url) return;
  levelAudio(lineAudio);
  lineAudio.src = r.url;
  lineAudio.playbackRate = settings.rate;
  lineAudio.play().catch(() => {});
}
const hmm = () => sayLine('hmm');

// Say an arbitrary short message in the teacher's voice (e.g. a content-policy refusal).
async function sayText(text) {
  if (!config.tts) {
    const u = new SpeechSynthesisUtterance(stripCues(text));
    u.rate = settings.rate;
    return speechSynthesis.speak(u);
  }
  const r = await speech(text);
  if (!r?.url) return;
  levelAudio(lineAudio);
  lineAudio.src = r.url;
  lineAudio.playbackRate = settings.rate;
  lineAudio.play().catch(() => {});
}

// ---------- speaking questions ----------
// Click the mic to record, click again (or pause speaking) to stop; the transcript is then asked.

const mic = { rec: null, stream: null, stopTimer: null };
// btn: the mic button (shows recording state); input: where status shows as placeholder.
// autoStop: stop after a pause in speech (off for push-to-talk, where releasing the key stops it).
async function startRecording({ btn, input, autoStop = true }, onText) {
  mic.wantStop = false;
  try {
    mic.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch (e) { input.placeholder = 'Microphone blocked; type your question'; return; }
  const type = ['audio/webm;codecs=opus', 'audio/mp4'].find(t => MediaRecorder.isTypeSupported(t)) || '';
  const rec = (mic.rec = new MediaRecorder(mic.stream, type ? { mimeType: type } : {}));
  const chunks = [];
  rec.ondataavailable = e => e.data.size && chunks.push(e.data);
  btn.classList.add('rec');
  input.placeholder = autoStop ? 'Listening… (click 🎤 to finish)' : 'Listening… (let go of A to ask)';

  // Level meter + auto-stop after ~1.8s of silence once you've started talking.
  audioCtx ||= new AudioContext();
  audioCtx.resume();
  const an = new AnalyserNode(audioCtx, { fftSize: 1024 });
  // Route through a muted gain to the output so every browser keeps the analyser running.
  audioCtx.createMediaStreamSource(mic.stream).connect(an).connect(new GainNode(audioCtx, { gain: 0 })).connect(audioCtx.destination);
  const startedAt = performance.now();
  const buf = new Float32Array(an.fftSize);
  let spoke = false, quietSince = performance.now();
  const meter = () => {
    if (mic.rec !== rec || rec.state !== 'recording') return;
    an.getFloatTimeDomainData(buf);
    const rms = Math.sqrt(buf.reduce((a, v) => a + v * v, 0) / buf.length);
    btn.style.setProperty('--level', Math.min(1, rms * 8).toFixed(2));
    if (rms > 0.015) { spoke = true; quietSince = performance.now(); }
    else if (autoStop && spoke && performance.now() - quietSince > 1800) return stopRecording();
    requestAnimationFrame(meter);
  };
  meter();

  rec.onstop = async () => {
    mic.stream.getTracks().forEach(t => t.stop());
    btn.classList.remove('rec');
    btn.style.setProperty('--level', 0);
    if (mic.rec !== rec) return; // cancelled
    // The level meter only drives auto-stop; let the transcriber decide whether anything was said.
    if (!chunks.length || performance.now() - startedAt < 400) { input.placeholder = "Recording was too short; try again or type"; return; }
    btn.classList.add('busy');
    input.placeholder = 'Transcribing…';
    try {
      const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
      const res = await fetch('/api/stt', { method: 'POST', headers: { 'content-type': blob.type }, body: blob });
      const { text, error } = await res.json();
      if (error) throw new Error(error);
      if (text) onText(text);
      else input.placeholder = "Heard no words; try again or type";
    } catch (e) {
      input.placeholder = `Couldn't transcribe (${e.message}); type instead`;
    } finally { btn.classList.remove('busy'); }
  };
  rec.start();
  if (mic.wantStop) rec.stop(); // push-to-talk key already released
}
function stopRecording() {
  if (mic.rec?.state === 'recording') mic.rec.stop();
  else mic.wantStop = true; // released before the mic was ready
}
const recording = () => mic.rec?.state === 'recording';

// ---------- loading quips ----------

const QUIPS = {
  lesson: [
    'Doing a little research…', 'Getting some library books…', 'Writing a lesson plan…',
    'Drinking some warm tea…', 'Sharpening my pencils…', 'Uncapping the markers…',
    'Dusting off the whiteboard…', 'Hunting for the perfect analogy…', 'Asking the librarian…',
    'Sketching a few diagrams…', 'Stretching before class…', 'Checking my notes twice…',
    'Finding my good chalk… er, marker…', 'Straightening my bow tie…',
  ],
  question: [
    'Ooh, good one…', 'Flipping through my notes…', 'Thinking how to draw this…',
    'Scratching my chin…', 'Finding a clean spot on the board…', 'Consulting the big book…',
  ],
};
let quipTimer;
function startQuips(kind) {
  clearInterval(quipTimer);
  const list = [...QUIPS[kind]].sort(() => Math.random() - 0.5);
  let i = 0;
  const el = $('#quip');
  const next = () => {
    el.classList.remove('in');
    setTimeout(() => { el.textContent = list[i++ % list.length]; el.classList.add('in'); }, 250);
  };
  next();
  quipTimer = setInterval(next, 2800);
}
function stopQuips() { clearInterval(quipTimer); }

// ---------- player clock ----------
// A pausable clock; all waits in the player go through it.

class Clock {
  constructor() { this.paused = false; this.offset = 0; this.pausedAt = 0; }
  now() { return ((this.paused ? this.pausedAt : performance.now()) - this.offset) / 1000; }
  pause() { if (!this.paused) { this.paused = true; this.pausedAt = performance.now(); } }
  resume() { if (this.paused) { this.offset += performance.now() - this.pausedAt; this.paused = false; } }
  // Resolves after `sec` of unpaused time, or early (false) if `alive()` turns false.
  wait(sec, alive) {
    const until = this.now() + sec;
    return new Promise(res => {
      const tick = () => {
        if (!alive()) return res(false);
        if (this.now() >= until) return res(true);
        requestAnimationFrame(tick);
      };
      tick();
    });
  }
}

// ---------- player ----------

class Player {
  constructor() {
    this.board = new Board($('#board'));
    this.clock = new Clock();
    this.audio = new Audio();
    this.gen = 0; // bumps on every seek/stop; stale loops exit
    this.lesson = null;
    this.pos = { section: 0, step: 0 };
    this.playing = false;
  }

  get paused() { return this.clock.paused; }

  load(lesson) {
    this.stop();
    this.lesson = lesson;
    this.pos = { section: 0, step: 0 };
    this.endRound = 0;
    this.titleShown = false;
    this.board.reset();
    $('#lessonTitle').textContent = lesson.outline?.title || lesson.topic;
    renderTimeline();
  }

  stop() {
    this.gen++;
    this.audio.pause();
    speechSynthesis.cancel();
    this.clock.resume();
    this.board.resume();
    this.playing = false;
  }

  async section(i) {
    const l = this.lesson;
    if (l.sections[i]) return l.sections[i];
    l.pending ||= {};
    l.pending[i] ||= api('section', { id: l.id, index: i }).then(s => {
      l.sections[i] = s;
      (s.steps || []).slice(0, 2).forEach(st => speech(st.say, l.id));
      renderTimeline();
      return s;
    }).finally(() => delete l.pending[i]);
    return l.pending[i];
  }

  // Rebuild the board instantly as it would look just before (section, step), then play from there.
  async seek(section, step = 0, autoplay = true) {
    this.stop();
    const gen = this.gen;
    this.pos = { section, step };
    this.board.reset();
    // Replay from the last `clear` before the target.
    const flat = [];
    for (let s = 0; s <= section; s++) {
      const steps = this.lesson.sections[s]?.steps || [];
      const end = s === section ? step : steps.length;
      for (let k = 0; k < end; k++) flat.push(steps[k]);
    }
    let from = 0;
    flat.forEach((st, i) => { if ((st.draw || []).some(o => o?.op === 'clear')) from = i; });
    for (const st of flat.slice(from)) for (const op of st.draw || []) await this.board.run(op, true);
    if (gen !== this.gen) return;
    renderProgress();
    if (autoplay) this.play(); else updatePlayButton();
  }

  async play() {
    const gen = ++this.gen;
    this.playing = true;
    updatePlayButton();
    const alive = () => gen === this.gen;
    const l = this.lesson;
    while (alive() && this.pos.section < l.outline.sections.length) {
      const { section } = this.pos;
      let sec = l.sections[section];
      if (!sec) {
        showPrep(`Writing part ${section + 1}: ${l.outline.sections[section].title}…`);
        try { sec = await this.section(section); } catch (e) { showPrep(`Something went wrong: ${e.message}`, true); return; }
        if (!alive()) return;
        // Don't drop the waiting screen until the first line can actually be spoken.
        $('#prepText').textContent = 'Clearing my throat…';
        await speech(sec.steps?.[this.pos.step]?.say, l.id);
        if (!alive()) return;
        hidePrep();
      }
      if (this.titleShown) {
        this.titleShown = false;
        await this.board.run({ op: 'erase', target: ['_title', '_titleBy'] });
        if (!alive()) return;
      }
      // Prefetch the next part while this one plays.
      if (section + 1 < l.outline.sections.length) this.section(section + 1).catch(() => {});
      const steps = sec.steps || [];
      // Get the quiz ready while the final part plays.
      if (section === l.outline.sections.length - 1) loadQuiz(l);
      while (alive() && this.pos.step < steps.length) {
        // Prefetch speech for the next few steps (into the next part, if it's written).
        // ElevenLabs takes ~4s per paragraph, so anything not prefetched is an audible gap.
        const ahead = [...steps.slice(this.pos.step + 1), ...(l.sections[section + 1]?.steps || [])].slice(0, 3);
        ahead.forEach(st => speech(st.say, l.id));
        renderProgress();
        await this.playStep(steps[this.pos.step], alive);
        if (!alive()) return;
        this.pos.step++;
        saveProgress();
      }
      if (!alive()) return;
      this.pos = { section: section + 1, step: 0 };
    }
    if (!alive()) return;
    this.playing = false;
    updatePlayButton();
    renderProgress();
    this.endQuestions();
  }

  // End of lesson: invite questions (not everyone likes to interrupt). Answers play as asides,
  // after which the final board is restored and we come back here with "any other questions?".
  endQuestions() {
    caption('');
    const again = this.endRound++ > 0;
    sayLine(again ? 'anyMore' : 'anyQuestions');
    showEndQuestions(again);
  }

  askAtEnd(question) {
    const last = this.lesson.outline.sections.length - 1;
    this.pos = { section: last, step: this.lesson.sections[last]?.steps.length || 0 };
    this.ask(question);
  }

  // Play one step (or aside step): speech plus its ops on the step's timeline.
  async playStep(step, alive) {
    if (!step) return;
    const say = (step.say || '').trim();
    const ops = (step.draw || []).filter(o => o && typeof o === 'object');
    caption(stripCues(say));
    const tts = await speech(say, this.lesson.id);
    if (!alive()) return;
    // Audio plays at settings.rate, so its real length is duration / rate.
    const duration = say ? (tts?.duration || estimate(say)) / settings.rate : 0;
    const timeAt = phrase => {
      const i = say.toLowerCase().indexOf(String(phrase).toLowerCase());
      if (i < 0) return null;
      if (tts?.starts?.length) return (tts.starts[Math.min(i, tts.starts.length - 1)] || 0) / settings.rate;
      return (i / say.length) * duration;
    };
    // Schedule: `at` pins to a phrase; the rest are spread evenly between anchors.
    const times = ops.map(o => (o.at !== undefined ? timeAt(o.at) : null));
    const anchors = [[-1, 0], ...times.map((t, i) => [i, t]).filter(([, t]) => t !== null), [ops.length, duration]];
    for (let a = 0; a < anchors.length - 1; a++) {
      const [i0, t0] = anchors[a], [i1, t1] = anchors[a + 1];
      // Before the first anchor ops start at t0 itself; after an anchor op they follow it.
      const off = i0 < 0 ? 1 : 0;
      for (let i = i0 + 1; i < i1; i++) times[i] = t0 + ((t1 - t0) * (i - i0 - off)) / Math.max(1, i1 - i0 - off);
    }

    const start = this.clock.now();
    const speechDone = this.speak(say, tts, alive);
    const drawDone = (async () => {
      for (let i = 0; i < ops.length && alive(); i++) {
        const op = ops[i];
        if (op.wait !== undefined) await this.clock.wait(+op.wait || 0, alive);
        else if (say) {
          const dt = times[i] - (this.clock.now() - start);
          if (dt > 0) await this.clock.wait(dt, alive);
        }
        if (!alive()) return;
        if (op.op === 'pause') { await this.clock.wait(+op.dur || 1, alive); continue; }
        await this.board.run(op);
      }
    })();
    await Promise.all([speechDone, drawDone]);
    // A beat between steps.
    if (alive()) await this.clock.wait(0.25, alive);
  }

  speak(text, tts, alive) {
    if (!text) return Promise.resolve();
    return new Promise(resolve => {
      const done = () => { clearInterval(watch); this.speaking = false; resolve(); };
      const watch = setInterval(() => { if (!alive()) done(); }, 100);
      this.speaking = true;
      if (tts?.url) {
        levelAudio(this.audio);
        audioCtx?.resume();
        this.audio.src = tts.url;
        this.audio.playbackRate = settings.rate;
        this.audio.onended = done;
        this.audio.onerror = done;
        if (!this.paused) this.audio.play().catch(e => {
          // The browser wants a click before playing sound: pause and ask for one.
          if (e.name === 'NotAllowedError') this.needGesture();
          else done();
        });
      } else {
        const u = new SpeechSynthesisUtterance(stripCues(text));
        u.rate = settings.rate;
        const v = speechSynthesis.getVoices().find(v => v.name === settings.browserVoice);
        if (v) u.voice = v;
        u.onend = done;
        u.onerror = done;
        speechSynthesis.speak(u);
      }
    });
  }

  // Handwritten title card shown while the first part is being written; erased when it starts.
  titleCard() {
    const l = this.lesson;
    this.titleShown = true;
    const title = l.outline?.title || l.topic;
    const size = Math.min(84, Math.floor(1400 / (0.48 * Math.max(10, title.length))));
    this.board.run({ op: 'text', id: '_title', x: 800, y: 330, text: title, size, color: 'blue', align: 'middle', underline: true })
      .then(() => this.board.run({ op: 'text', id: '_titleBy', x: 800, y: 330 + size * 0.9 + 40, text: `with ${settings.teacher}  ·  ${l.minutes} min`, size: 40, color: 'gray', align: 'middle' }));
  }

  needGesture() {
    this.clock.pause(); this.board.pause();
    updatePlayButton();
    showStart({ resume: true });
  }

  togglePause() {
    if (!this.lesson) return;
    hideStart();
    if (!this.playing) return this.seek(this.pos.section, this.pos.step);
    if (this.paused) {
      this.clock.resume(); this.board.resume();
      audioCtx?.resume();
      if (this.speaking && this.audio.src && !this.audio.ended) this.audio.play().catch(() => {});
      speechSynthesis.resume();
    } else {
      this.clock.pause(); this.board.pause(); this.audio.pause(); speechSynthesis.pause();
    }
    updatePlayButton();
  }

  next() { this.jump(+1); }
  prev() { this.jump(-1); }
  jump(d) {
    const l = this.lesson;
    let { section, step } = this.pos;
    step += d;
    if (step < 0) {
      if (section === 0) step = 0;
      else { section--; step = Math.max(0, (l.sections[section]?.steps.length || 1) - 1); }
    } else if (step >= (l.sections[section]?.steps.length || 0)) {
      if (!l.sections[section + 1] && section + 1 >= l.outline.sections.length) return;
      section++; step = 0;
    }
    this.seek(section, step);
  }

  // Raise hand: stop where we are, answer on a fresh board, then rebuild and resume this step.
  async ask(question) {
    const { section, step } = this.pos;
    this.stop();
    updatePlayButton();
    const steps = this.lesson.sections[section]?.steps || [];
    const recent = steps.slice(Math.max(0, step - 4), step + 1).map(s => stripCues(s.say || '')).join(' ');
    showPrep('Thinking about your question…', false, 'question');
    hmm();
    let aside;
    try {
      aside = await api('question', { id: this.lesson.id, section, step, question, recent });
    } catch (e) {
      lineAudio.pause();
      if (!e.refused) { showPrep(`Couldn't answer: ${e.message}`, true); return; }
      // Declined by the content policy: the teacher says why and offers other questions.
      hidePrep();
      sayText(e.message);
      const atEnd = this.endRound > 0;
      showRefusal(e.message, e.suggestions, {
        pick: q => { lineAudio.pause(); this.pos = { section, step }; this.ask(q); },
        back: () => { lineAudio.pause(); this.seek(section, step); },
        backLabel: atEnd ? 'Back to the board' : 'Back to the lesson',
      });
      return;
    }
    // Keep the thinking screen up until the first line of the answer can be spoken.
    (aside.steps || []).slice(1, 3).forEach(st => speech(st.say, this.lesson.id));
    await speech(aside.steps?.[0]?.say, this.lesson.id);
    hidePrep();
    this.lesson.asides.push(aside);
    renderTimeline();
    await this.playAside(aside);
  }

  async playAside(aside) {
    this.stop();
    const gen = ++this.gen;
    const alive = () => gen === this.gen;
    this.playing = true;
    updatePlayButton();
    this.board.reset();
    const steps = aside.steps || [];
    for (let k = 0; k < steps.length; k++) {
      steps.slice(k + 1, k + 4).forEach(st => speech(st.say, this.lesson.id));
      await this.playStep(steps[k], alive);
      if (!alive()) return;
    }
    this.seek(this.pos.section, this.pos.step);
  }
}

const player = new Player();
window.wt = { player, speech }; // for debugging from the console

// ---------- UI ----------

function caption(text) {
  const c = $('#caption');
  c.textContent = text;
  c.classList.toggle('hidden', !settings.captions || !text);
}
// kind: 'lesson' or 'question' picks the quips; errors hide the animation.
function showPrep(text, error, kind = 'lesson') {
  const wasHidden = $('#prep').classList.contains('hidden');
  $('#prep').classList.remove('hidden');
  $('#prepText').textContent = text;
  $('#prep .doodle').classList.toggle('hidden', !!error);
  $('#quip').classList.toggle('hidden', !!error);
  if (error) stopQuips();
  else if (wasHidden || kind !== showPrep.kind) startQuips(kind);
  showPrep.kind = kind;
}
// Start card: shown when opening a saved lesson (a click also unlocks audio) or when the
// browser blocked autoplay mid-lesson.
function showStart({ resume, fresh } = {}) {
  const box = $('#start');
  box.classList.remove('hidden');
  $('#startTitle').textContent = player.lesson?.outline?.title || '';
  $('#startGo').textContent = resume ? '▶ Continue' : fresh ? '▶ Start' : '▶ Resume';
  $('#startOver').classList.toggle('hidden', !!(resume || fresh));
}
// A declined topic or question: the teacher's message, suggested alternatives as buttons, and
// a way out. pick(question) runs a suggestion; back() is offered when there's somewhere to return to.
function showRefusal(message, suggestions = [], { pick, back, backLabel } = {}) {
  const box = $('#refusal');
  box.classList.remove('hidden');
  $('#refusalMsg').textContent = message;
  const list = $('#refusalPicks');
  list.replaceChildren();
  for (const q of suggestions) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = q;
    b.onclick = () => { hideRefusal(); pick(q); };
    list.appendChild(b);
  }
  const backBtn = $('#refusalBack');
  backBtn.classList.toggle('hidden', !back);
  backBtn.textContent = backLabel || 'Back';
  backBtn.onclick = () => { hideRefusal(); back(); };
  $('#refusalNew').onclick = () => { hideRefusal(); lineAudio.pause(); goHome(); };
}
function hideRefusal() { $('#refusal').classList.add('hidden'); }

function hideStart() { $('#start').classList.add('hidden'); }
function hidePrep() { $('#prep').classList.add('hidden'); $('#prep').classList.remove('low'); stopQuips(); showPrep.kind = null; }
function updatePlayButton() { $('#playBtn').textContent = player.playing && !player.paused ? '⏸' : '▶'; }

function renderTimeline() {
  const l = player.lesson;
  const tl = $('#timeline');
  tl.replaceChildren();
  l.outline.sections.forEach((s, i) => {
    const seg = document.createElement('div');
    seg.className = 'seg' + (l.sections[i] ? '' : ' pending');
    seg.dataset.title = `${i + 1}. ${s.title}`;
    seg.innerHTML = '<div class="fill"></div>';
    seg.onclick = () => l.sections[i] || i === 0 || l.sections[i - 1] ? player.seek(i, 0) : null;
    const n = l.sections[i]?.steps.length || 1;
    for (const a of l.asides.filter(a => a.section === i)) {
      const dot = document.createElement('div');
      dot.className = 'aside';
      dot.style.left = `${(a.step / n) * 100}%`;
      dot.title = `Q: ${a.question}`;
      dot.onclick = e => { e.stopPropagation(); player.pos = { section: a.section, step: a.step }; player.playAside(a); };
      seg.appendChild(dot);
    }
    tl.appendChild(seg);
  });
  renderProgress();
}

function renderProgress() {
  const l = player.lesson;
  if (!l) return;
  [...$('#timeline').children].forEach((seg, i) => {
    const n = l.sections[i]?.steps.length || 1;
    const f = i < player.pos.section ? 1 : i > player.pos.section ? 0 : player.pos.step / n;
    seg.querySelector('.fill').style.width = `${f * 100}%`;
  });
  $('#status').textContent = `Part ${Math.min(player.pos.section + 1, l.outline.sections.length)} of ${l.outline.sections.length}`;
}

let progressTimer;
// An admin watching a learner's lesson shouldn't move their resume point, quiz scores or feedback.
const viewingOthers = () => !!(player.lesson && me?.user && player.lesson.owner && player.lesson.owner !== me.user.id);

function saveProgress() {
  if (viewingOthers()) return;
  clearTimeout(progressTimer);
  progressTimer = setTimeout(() => api('progress', { id: player.lesson.id, ...player.pos }).catch(() => {}), 1000);
}

function showEndQuestions(again) {
  const box = $('#endQ');
  box.classList.remove('hidden');
  $('#endTitle').textContent = again ? 'Any other questions?' : 'Any questions?';
  $('#endInput').value = '';
  $('#endInput').placeholder = 'Type, or hold A to talk';
  // Not focused on purpose: focusing would count as "interacting" and stop the countdown.
  $('#endInput').blur();
  startCountdown();
}
function hideEndQuestions() { stopRecording(); mic.rec = null; stopCountdown(); $('#endQ').classList.add('hidden'); }

// ---------- quiz countdown ----------
// After "any questions?", the quiz starts by itself in 30s unless the student starts asking something.

const COUNTDOWN = 30;
let countdown = null;
function startCountdown() {
  stopCountdown();
  const quizOk = !!player.lesson && player.lesson.quiz !== false;
  $('#endQuiz').classList.toggle('hidden', !quizOk);
  $('#endSkip').textContent = quizOk ? 'Skip quiz' : "No, I'm all good";
  const bar = $('#endCountdown');
  bar.classList.toggle('hidden', !quizOk);
  if (!quizOk) return;
  let left = COUNTDOWN;
  const tick = () => {
    bar.querySelector('span').textContent = `Quiz in ${left}…`;
    bar.querySelector('.fill').style.width = `${(left / COUNTDOWN) * 100}%`;
    if (left-- <= 0) { hideEndQuestions(); startQuiz(); }
  };
  tick();
  countdown = setInterval(tick, 1000);
}
function stopCountdown() {
  clearInterval(countdown);
  countdown = null;
  $('#endCountdown').classList.add('hidden');
}

// ---------- quiz ----------

function loadQuiz(lesson) {
  if (lesson.quiz || lesson.quizPending) return lesson.quizPending;
  lesson.quizPending = api('quiz', { id: lesson.id }).then(q => {
    lesson.quiz = q?.questions?.length ? q : false;
    if (lesson.quiz) quizSpeech(lesson.quiz.questions[0], lesson.id);
    return lesson.quiz;
  }).catch(e => { console.warn('quiz', e); lesson.quiz = false; return false; })
    .finally(() => { lesson.quizPending = null; });
  return lesson.quizPending;
}

// Spoken text for a question: the question then its options; and what's said after each answer.
const quizLines = q => ({
  ask: `${q.q} ${q.choices.map((c, i) => `${i + 1}: ${c}.`).join(' ')}`,
  right: `[excited] That's right! ${q.explain || ''}`,
  wrong: `[warmly] Not quite. It's ${q.choices[q.answer]}. ${q.explain || ''}`,
});
function quizSpeech(q, id) {
  if (!q) return;
  const l = quizLines(q);
  speech(l.ask, id); speech(l.right, id); speech(l.wrong, id);
}

const quiz = { i: 0, score: 0, answers: [], answered: false, active: false };

async function startQuiz() {
  const l = player.lesson;
  const box = $('#quiz');
  box.classList.remove('hidden');
  Object.assign(quiz, { i: 0, score: 0, answers: [], answered: false, active: true });
  if (!l.quiz) {
    $('#quizQ').textContent = 'Writing your quiz…';
    $('#quizChoices').replaceChildren();
    $('#quizExplain').textContent = '';
    $('#quizNext').classList.add('hidden');
    $('#quizCount').textContent = '';
    await loadQuiz(l);
    if (!quiz.active) return;
    if (!l.quiz) return endQuiz(true);
  }
  showQuestion();
}

function showQuestion() {
  const l = player.lesson;
  const qs = l.quiz.questions;
  const q = qs[quiz.i];
  quiz.answered = false;
  $('#quizCount').textContent = `Question ${quiz.i + 1} of ${qs.length}`;
  $('#quizQ').textContent = q.q;
  $('#quizExplain').textContent = '';
  $('#quizNext').classList.add('hidden');
  const list = $('#quizChoices');
  list.replaceChildren();
  q.choices.forEach((c, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = `<b>${i + 1}</b>`;
    b.append(' ' + c);
    b.onclick = () => answer(i);
    list.appendChild(b);
  });
  sayText(quizLines(q).ask);
  quizSpeech(qs[quiz.i + 1], l.id);
}

function answer(i) {
  const q0 = player.lesson?.quiz?.questions?.[quiz.i];
  if (!quiz.active || quiz.answered || !q0 || i >= q0.choices.length) return;
  quiz.answered = true;
  const q = player.lesson.quiz.questions[quiz.i];
  const right = i === q.answer;
  if (right) quiz.score++;
  quiz.answers.push(i);
  [...$('#quizChoices').children].forEach((b, k) => {
    b.disabled = true;
    b.classList.toggle('right', k === q.answer);
    b.classList.toggle('wrong', k === i && !right);
  });
  $('#quizExplain').textContent = `${right ? '✓ ' : '✗ '}${stripCues(q.explain || '')}`;
  const last = quiz.i === player.lesson.quiz.questions.length - 1;
  $('#quizNext').textContent = last ? 'See my score' : 'Next question';
  $('#quizNext').classList.remove('hidden');
  $('#quizNext').focus();
  sayText(quizLines(q)[right ? 'right' : 'wrong']);
}

function nextQuestion() {
  if (!quiz.answered) return;
  lineAudio.pause();
  if (quiz.i < player.lesson.quiz.questions.length - 1) { quiz.i++; showQuestion(); }
  else endQuiz();
}

function endQuiz(skipped) {
  const l = player.lesson;
  quiz.active = false;
  lineAudio.pause();
  if (skipped || !l.quiz) { $('#quiz').classList.add('hidden'); return showFeedback(); }
  const total = l.quiz.questions.length;
  if (!viewingOthers()) api('quizResult', { id: l.id, score: quiz.score, total, answers: quiz.answers }).catch(() => {});
  $('#quizCount').textContent = 'Quiz complete';
  $('#quizQ').textContent = `You got ${quiz.score} out of ${total}!`;
  $('#quizChoices').replaceChildren();
  const pct = quiz.score / total;
  const line = pct === 1 ? `[excited] You got all ${total}! Perfect score!`
    : pct >= 0.6 ? `[warmly] You got ${quiz.score} out of ${total}. Nicely done!`
    : `[warmly] You got ${quiz.score} out of ${total}. That's okay, it's a lot to take in. Want to replay the lesson sometime?`;
  $('#quizExplain').textContent = stripCues(line);
  sayText(line);
  $('#quizNext').textContent = 'Done';
  $('#quizNext').classList.remove('hidden');
  $('#quizNext').focus();
  quiz.answered = false;
  $('#quizNext').onclick = () => {
    $('#quizNext').onclick = nextQuestion;
    lineAudio.pause();
    $('#quiz').classList.add('hidden');
    showFeedback();
  };
}

function showFeedback() {
  caption('');
  const fb = $('#feedback');
  fb.classList.remove('hidden');
  fb.dataset.liked = '';
  fb.querySelectorAll('.thumbs button').forEach(b => b.classList.remove('on'));
  $('#fbText').value = '';
  $('#fbSend').classList.remove('hidden');
  $('#fbHome').classList.add('ghost');
}

function show(screen) {
  for (const s of ['home', 'lesson', 'picker', 'setup', 'admin']) $('#' + s).classList.toggle('hidden', screen !== s);
  $('#meMenu').classList.add('hidden');
  $('#feedback').classList.add('hidden');
  $('#handBox').classList.add('hidden');
  $('#endQ').classList.add('hidden');
  $('#quiz').classList.add('hidden');
  quiz.active = false;
  stopCountdown();
  hideRefusal();
  hideStart();
  hidePrep();
}

async function goHome() {
  player.stop();
  history.pushState({}, '', '/');
  show('home');
  clearAsk();
  $('#q').focus();
  renderLibrary();
}

// The lesson list: your own on the home screen, or (admin) a learner's on the admin page.
async function renderLibrary({ el = $('#library'), user, heading = 'Your lessons' } = {}) {
  const lib = el;
  let lessons = [];
  try { lessons = await api('lessons' + (user ? '?user=' + encodeURIComponent(user.id) : '')); } catch {}
  lib.replaceChildren();
  if (!lessons.length) { if (user) lib.innerHTML = `<h3>${heading}</h3><p class="hint">No lessons yet.</p>`; return; }
  lib.innerHTML = '<h3></h3>';
  lib.querySelector('h3').textContent = heading;
  for (const l of lessons.slice(0, 30)) {
    const row = document.createElement('div');
    row.className = 'lesson-row';
    const t = document.createElement('div');
    t.className = 't';
    t.textContent = l.title || l.topic;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${l.minutes} min${l.asides ? ` · ${l.asides} question${l.asides > 1 ? 's' : ''}` : ''} · ${new Date(l.createdAt).toLocaleDateString()}`;
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '✕';
    del.title = 'Delete';
    del.onclick = async e => {
      e.stopPropagation();
      if (!confirm(`Delete "${t.textContent}"?`)) return;
      await api('lesson?id=' + encodeURIComponent(l.id), null, 'DELETE');
      renderLibrary({ el, user, heading });
    };
    // Most recent quiz score, if the quiz was taken (skipped quizzes aren't recorded).
    const grade = document.createElement('div');
    if (l.lastQuiz?.total) {
      const { score, total } = l.lastQuiz;
      grade.className = 'grade ' + (score === total ? 'perfect' : score / total >= 0.6 ? 'good' : 'low');
      grade.textContent = `${score}/${total}`;
      grade.title = `Last quiz: ${score} out of ${total}`;
    }
    row.append(t, grade, meta, del);
    row.onclick = () => openLesson(l.id);
    lib.appendChild(row);
  }
}

async function startLesson(topic, minutes = settings.minutes) {
  if (!topic.trim()) return;
  show('lesson');
  player.stop();
  player.board.reset();
  $('#lessonTitle').textContent = topic;
  $('#timeline').replaceChildren();
  $('#prepOutline').replaceChildren();
  showPrep(`${settings.teacher} is planning the lesson…`);
  let lesson;
  try {
    lesson = await api('outline', { topic, minutes: +minutes, level: settings.level, tone: settings.tone, teacher: settings.teacher, model: settings.model });
  } catch (e) {
    if (!e.refused) return showPrep(`Something went wrong: ${e.message}`, true);
    hidePrep();
    sayText(e.message);
    return showRefusal(e.message, e.suggestions, {
      pick: q => { lineAudio.pause(); history.replaceState({}, '', `/?q=${encodeURIComponent(q)}&min=${minutes}`); startLesson(q, minutes); },
    });
  }
  history.replaceState({}, '', `/?lesson=${lesson.id}`);
  for (const s of lesson.outline.sections) {
    const li = document.createElement('li');
    li.textContent = s.title;
    $('#prepOutline').appendChild(li);
  }
  player.load(lesson);
  // While part 1 is written, put the lesson's title on the board, with the waiting card below it.
  showPrep(`Writing part 1…`);
  $('#prep').classList.add('low');
  player.titleCard();
  player.play();
}

async function openLesson(id) {
  show('lesson');
  history.pushState({}, '', `/?lesson=${id}`);
  showPrep('Opening lesson…');
  const lesson = await api('lesson?id=' + encodeURIComponent(id));
  hidePrep();
  player.load(lesson);
  // Don't autoplay: show the board where they left off and wait for a click.
  const p = lesson.progress;
  const finished = p && p.section >= lesson.outline.sections.length - 1 && p.step >= (lesson.sections.at(-1)?.steps.length || 0);
  const resume = p && !finished && (p.section || p.step);
  await player.seek(resume ? p.section : 0, resume ? p.step : 0, false);
  showStart({ fresh: !resume });
}

// ---------- wiring ----------

function wire() {
  $('#askForm').onsubmit = e => {
    e.preventDefault();
    const q = $('#q').value;
    history.pushState({}, '', `/?q=${encodeURIComponent(q)}&min=${settings.minutes}`);
    startLesson(q);
  };
  const markLength = () => $('#lengths').querySelectorAll('button').forEach(b => b.classList.toggle('on', +b.dataset.min === +settings.minutes));
  $('#lengths').onclick = e => {
    if (!e.target.dataset.min) return;
    settings.minutes = +e.target.dataset.min; saveSettings(); markLength();
  };
  markLength();
  $('#level').value = settings.level;
  $('#level').onchange = () => { settings.level = $('#level').value; saveSettings(); };
  $('#tone').value = settings.tone;
  $('#tone').onchange = () => { settings.tone = $('#tone').value; saveSettings(); };

  // Mic on the home screen: speak a topic, and the lesson starts once it's transcribed.
  $('#homeMic').onclick = () => {
    if (recording()) return stopRecording();
    startRecording({ btn: $('#homeMic'), input: $('#q') }, text => {
      $('#q').value = text;
      $('#askForm').requestSubmit();
    });
  };

  $('#homeBtn').onclick = goHome;
  $('#startGo').onclick = () => {
    hideStart();
    audioCtx?.resume();
    if (player.playing) player.togglePause(); else player.play();
  };
  $('#startOver').onclick = () => { hideStart(); player.seek(0, 0); };
  $('#playBtn').onclick = () => player.togglePause();
  $('#nextBtn').onclick = () => player.next();
  $('#prevBtn').onclick = () => player.prev();
  $('#ccBtn').classList.toggle('on', settings.captions);
  $('#ccBtn').onclick = () => {
    settings.captions = !settings.captions; saveSettings();
    $('#ccBtn').classList.toggle('on', settings.captions);
    $('#caption').classList.toggle('hidden', !settings.captions || !$('#caption').textContent);
  };

  const openHand = (listen = false) => {
    if (!player.lesson) return;
    if (player.playing && !player.paused) player.togglePause();
    $('#handBox').classList.remove('hidden');
    $('#handQ').value = '';
    $('#handQ').placeholder = 'Type, or hold A to talk';
    $('#handQ').focus();
    if (listen) toggleMic();
  };
  const closeHand = () => { stopRecording(); mic.rec = null; $('#handBox').classList.add('hidden'); };
  // Spoken questions are asked as soon as they're transcribed.
  const toggleMic = () => {
    if (recording()) return stopRecording();
    startRecording({ btn: $('#micBtn'), input: $('#handQ') }, text => {
      $('#handQ').value = text;
      $('#handForm').requestSubmit();
    });
  };
  $('#micBtn').onclick = toggleMic;
  $('#handQ').addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeHand(); if (player.paused) player.togglePause(); }
  });
  $('#handBtn').onclick = () => openHand();
  $('#handCancel').onclick = () => { closeHand(); if (player.paused) player.togglePause(); };
  $('#handForm').onsubmit = e => {
    e.preventDefault();
    const q = $('#handQ').value.trim();
    closeHand();
    if (q) player.ask(q);
  };

  const fb = $('#feedback');
  fb.querySelectorAll('.thumbs button').forEach(b => (b.onclick = () => {
    fb.querySelectorAll('.thumbs button').forEach(x => x.classList.toggle('on', x === b));
    fb.dataset.liked = b.dataset.liked;
  }));
  $('#fbSend').onclick = async () => {
    if (!viewingOthers()) await api('feedback', { id: player.lesson.id, liked: fb.dataset.liked === '' ? null : fb.dataset.liked === 'true', text: $('#fbText').value });
    // Sent: drop the Send button and make "New question" the obvious next step.
    $('#fbSend').classList.add('hidden');
    $('#fbHome').classList.remove('ghost');
    $('#fbHome').focus();
  };
  $('#fbReplay').onclick = () => { fb.classList.add('hidden'); player.endRound = 0; player.seek(0, 0); };

  // End-of-lesson questions
  $('#endForm').onsubmit = e => {
    e.preventDefault();
    const q = $('#endInput').value.trim();
    if (!q) return;
    hideEndQuestions();
    player.askAtEnd(q);
  };
  $('#endMic').onclick = () => {
    if (recording()) return stopRecording();
    startRecording({ btn: $('#endMic'), input: $('#endInput') }, text => {
      $('#endInput').value = text;
      $('#endForm').requestSubmit();
    });
  };
  $('#endSkip').onclick = () => { hideEndQuestions(); lineAudio.pause(); showFeedback(); };
  $('#endQuiz').onclick = () => { hideEndQuestions(); lineAudio.pause(); startQuiz(); };
  // Any sign the student wants to ask something stops the quiz countdown.
  for (const ev of ['focus', 'input', 'pointerdown']) $('#endInput').addEventListener(ev, stopCountdown);
  $('#endMic').addEventListener('pointerdown', stopCountdown);
  $('#quizNext').onclick = nextQuestion;
  $('#quizSkip').onclick = () => endQuiz(true);
  document.addEventListener('keydown', e => {
    if ($('#quiz').classList.contains('hidden') || e.target.matches('input, textarea')) return;
    const n = +e.key;
    if (n >= 1 && n <= 4) { e.preventDefault(); answer(n - 1); }
    else if (e.key === 'Escape') endQuiz(true);
  });
  $('#fbHome').onclick = goHome;

  document.addEventListener('keydown', e => {
    if ($('#lesson').classList.contains('hidden') || e.target.matches('input, textarea, select')) return;
    if (e.key === ' ') { e.preventDefault(); player.togglePause(); }
    else if (e.key === 'ArrowRight') player.next();
    else if (e.key === 'ArrowLeft') player.prev();
    else if (e.key === '?' || e.key === 'h') { e.preventDefault(); openHand(); }
    else if (e.key === 'm') { e.preventDefault(); openHand(true); }
    else if (e.key === 'c') $('#ccBtn').click();
    else if (e.key === 'Escape') closeHand();
  });

  // Push-to-talk on "A" (for Ask): hold to speak a question, let go to ask; a quick tap opens the
  // question box for typing. Works on the home screen, during a lesson and on the end-of-lesson card,
  // but not while typing in a text box.
  const HOLD_MS = 250;
  let ptt = null;
  const visible = id => !$(id).classList.contains('hidden');
  const pttContext = () => {
    if (visible('#quiz')) return null;
    if (visible('#lesson') && visible('#endQ')) return 'end';
    if (visible('#lesson')) return 'lesson';
    if (visible('#home')) return 'home';
    return null;
  };
  const beginPTT = ctx => {
    const ask = (btn, input, form) => startRecording({ btn: $(btn), input: $(input), autoStop: false }, text => {
      $(input).value = text;
      $(form).requestSubmit();
    });
    if (ctx === 'home') ask('#homeMic', '#q', '#askForm');
    else if (ctx === 'end') { stopCountdown(); ask('#endMic', '#endInput', '#endForm'); }
    else if (ctx === 'lesson') {
      if (!visible('#handBox')) openHand();
      ask('#micBtn', '#handQ', '#handForm');
    }
  };
  const isA = e => e.key === 'a' || e.key === 'A';
  // In the home screen's empty question box, A is held for push-to-talk but a tap (or typing on)
  // still types the letter.
  const typeLetter = () => {
    const { field, char } = ptt;
    field.setRangeText(char, field.selectionStart, field.selectionEnd, 'end');
    field.dispatchEvent(new Event('input', { bubbles: true }));
  };
  document.addEventListener('keydown', e => {
    if (ptt && !ptt.active && ptt.field && !isA(e)) {
      // Typing continued while A was down: it was just a letter.
      clearTimeout(ptt.timer);
      typeLetter();
      ptt = null;
      return;
    }
    if (!isA(e) || e.metaKey || e.ctrlKey || e.altKey || $('#settings').open) return;
    if (ptt) { e.preventDefault(); return; } // key repeat while held
    const inField = e.target.matches?.('input, textarea, select');
    const homeBox = e.target.id === 'q' && !e.target.value;
    if (inField && !homeBox) return;
    const ctx = pttContext();
    if (!ctx || recording()) return;
    e.preventDefault();
    ptt = { ctx, active: false, field: homeBox ? e.target : null, char: e.key };
    ptt.timer = setTimeout(() => { ptt.active = true; beginPTT(ctx); }, HOLD_MS);
  }, true);
  document.addEventListener('keyup', e => {
    if (!isA(e) || !ptt) return;
    e.preventDefault();
    clearTimeout(ptt.timer);
    if (ptt.active) stopRecording();
    else if (ptt.field) typeLetter();
    else if (ptt.ctx === 'lesson') openHand();
    else if (ptt.ctx === 'home') $('#q').focus();
    else if (ptt.ctx === 'end') $('#endInput').focus();
    ptt = null;
  }, true);

  // Settings
  const dlg = $('#settings');
  $('#openSettings').onclick = async () => {
    // Teacher name and model are the admin's choice; learners just pick voice and speed.
    const isAdmin = me?.user?.role === 'admin';
    $('#sName').closest('label').classList.toggle('hidden', !isAdmin);
    $('#sModel').closest('label').classList.toggle('hidden', !isAdmin);
    $('#sName').value = settings.teacher;
    $('#sRate').value = settings.rate;
    $('#sRateVal').textContent = `${settings.rate}×`;
    $('#sModel').value = settings.model;
    $('#searchUrl').textContent = `${location.origin}/?q=%s`;
    await fillVoices();
    dlg.showModal();
  };
  // Preview a voice when it's picked.
  $('#sVoice').onchange = async () => {
    const sel = $('#sVoice');
    // Introduce with the teacher's name as typed in the form, not the voice's name.
    const name = $('#sName').value.trim() || 'Claude';
    const text = `Hi, I'm ${name}. Let's learn something.`;
    if (config.tts) {
      const r = await speech(text, null, sel.value);
      if (r?.url) { const a = new Audio(r.url); a.playbackRate = +$('#sRate').value; a.play(); }
    } else {
      const u = new SpeechSynthesisUtterance(text);
      u.voice = speechSynthesis.getVoices().find(v => v.name === sel.value) || null;
      speechSynthesis.speak(u);
    }
  };
  $('#sRate').oninput = () => ($('#sRateVal').textContent = `${$('#sRate').value}×`);
  dlg.onclose = () => {
    settings.teacher = $('#sName').value.trim() || 'Claude';
    settings.rate = +$('#sRate').value;
    settings.model = $('#sModel').value;
    const v = $('#sVoice').value;
    if (config.tts) settings.voice = v; else settings.browserVoice = v;
    saveSettings();
    applyName();
  };

  // Browsers only let audio start after a user gesture; wake the audio graph on any interaction.
  document.addEventListener('pointerdown', () => {
    try { audioCtx ||= new AudioContext(); audioCtx.resume(); } catch {}
  }, { capture: true });
  document.addEventListener('keydown', () => { audioCtx?.resume(); }, { capture: true });

  window.onpopstate = route;
}

async function fillVoices() {
  const sel = $('#sVoice');
  sel.replaceChildren();
  let voices = [];
  if (config.tts) {
    // The admin's catalog, across voice services: value is "backend:voice".
    try { voices = (await api('voices')).map(v => ({ id: v.value, name: v.name })); } catch {}
  } else {
    voices = speechSynthesis.getVoices().filter(v => v.lang.startsWith('en')).map(v => ({ id: v.name, name: `${v.name} (${v.lang})` }));
  }
  for (const v of voices) {
    const o = document.createElement('option');
    o.value = v.id; o.textContent = v.name;
    sel.appendChild(o);
  }
  // Older settings hold a bare ElevenLabs voice id; match it to its "backend:voice" entry.
  const want = config.tts ? settings.voice || config.voice : settings.browserVoice;
  const match = voices.find(v => v.id === want) || voices.find(v => want && v.id.endsWith(':' + want));
  sel.value = match?.id || (config.tts ? config.voice : '') || '';
}

function route() {
  const p = new URLSearchParams(location.search);
  if (p.get('lesson')) return openLesson(p.get('lesson'));
  if (p.get('q')) {
    if (p.get('min')) settings.minutes = +p.get('min');
    return startLesson(p.get('q'), settings.minutes);
  }
  player.stop();
  show('home');
  clearAsk();
  renderLibrary();
}

// Fresh question box on returning home (also resets any mic status left in the placeholder).
function clearAsk() {
  $('#q').value = '';
  $('#q').placeholder = `What would you like ${settings.teacher} to teach you? (hold A to talk)`;
}

// ---------- accounts ----------

const account = createAccountUI({
  api, show, onSignedIn: signedIn,
  // Admin voice catalog: play a sample of any voice, named as it would introduce itself.
  onPreviewVoice: async (voice, name) => {
    const r = await speech(`Hi, I'm ${name}. Let's learn something.`, null, voice);
    if (r?.url) { const a = new Audio(r.url); a.play(); }
  },
  onShowLessons: u => account.renderHistory(u, {
    renderLessons: el => renderLibrary({ el, user: u, heading: 'Lessons' }),
  }),
});

// After sign-in (or on load with a session): load the user's settings and carry on to the app.
async function signedIn() {
  me = await api('me');
  if (!me.user) return account.showPicker();
  Object.assign(settings, DEFAULTS, me.user.settings || {});
  applyName();
  const chip = $('#meChip');
  chip.innerHTML = '<span class="avatar"></span><span class="nm"></span>';
  chip.querySelector('.avatar').textContent = me.user.avatar;
  chip.querySelector('.nm').textContent = me.user.name;
  $('#meAdmin').classList.toggle('hidden', me.user.role !== 'admin');
  $('#level').value = settings.level;
  $('#tone').value = settings.tone;
  $('#lengths').querySelectorAll('button').forEach(b => b.classList.toggle('on', +b.dataset.min === +settings.minutes));
  $('#ccBtn').classList.toggle('on', !!settings.captions);
  try { config = await api('config'); } catch {}
  warmLines();
  route();
}

function wireAccount() {
  $('#meChip').onclick = e => { e.stopPropagation(); $('#meMenu').classList.toggle('hidden'); };
  document.addEventListener('click', () => $('#meMenu').classList.add('hidden'));
  $('#meSwitch').onclick = async () => {
    player.stop();
    await api('logout', {});
    history.pushState({}, '', '/');
    account.showPicker();
  };
  $('#meAdmin').onclick = async () => {
    show('admin');
    $('#adminHistory').replaceChildren();
    try { await account.renderUsers(); await account.renderVoices(); await account.renderPolicies(); } catch { goHome(); }
  };
  $('#adminBack').onclick = goHome;
}

(async function init() {
  wire();
  wireAccount();
  let state;
  try { state = await api('me'); } catch { state = {}; }
  if (state.setup) return account.showSetup();
  if (!state.user) return account.showPicker();
  signedIn();
})();
