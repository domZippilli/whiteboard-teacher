// Whiteboard Teacher — app shell and lesson player.
import { Board } from './board.js';

const $ = s => document.querySelector(s);
const api = async (path, body, method) => {
  const res = await fetch('/api/' + path, {
    method: method || (body ? 'POST' : 'GET'),
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
};

// ---------- settings ----------

const DEFAULTS = { teacher: 'Claude', voice: '', rate: 1, model: 'opus', minutes: 5, level: '', captions: false };
const settings = { ...DEFAULTS, ...safeJson(localStorage.getItem('wt-settings')) };
function safeJson(s) { try { return JSON.parse(s) || {}; } catch { return {}; } }
function saveSettings() { try { localStorage.setItem('wt-settings', JSON.stringify(settings)); } catch {} }
let config = { tts: false };

function applyName() {
  $('#teacherName').textContent = settings.teacher;
  document.title = `Ask ${settings.teacher}`;
  $('#q').placeholder = `What would you like ${settings.teacher} to teach you?`;
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

const ttsCache = new Map();
function speech(text, lessonId) {
  if (!text?.trim()) return Promise.resolve(null);
  const key = `${settings.voice}|${text}`;
  if (!ttsCache.has(key)) {
    const p = config.tts
      ? api('tts', { text, voice: settings.voice || undefined, id: lessonId }).catch(e => { console.warn(e); return null; })
      : Promise.resolve(null);
    ttsCache.set(key, p);
  }
  return ttsCache.get(key);
}

// [audio tags] are delivery cues for the voice model, never shown or spoken by the browser voice.
const stripCues = text => text.replace(/\[[^\]]*\]\s*/g, '').trim();

// Estimated seconds for text when we have no timings (browser voice).
const estimate = text => (text.split(/\s+/).filter(Boolean).length / 2.6 + (text.match(/[.,;:!?]/g) || []).length * 0.15);

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
        hidePrep();
      }
      // Prefetch the next part while this one plays.
      if (section + 1 < l.outline.sections.length) this.section(section + 1).catch(() => {});
      const steps = sec.steps || [];
      while (alive() && this.pos.step < steps.length) {
        // Prefetch speech for the next few steps.
        for (let k = 1; k <= 3; k++) speech(steps[this.pos.step + k]?.say, l.id);
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
    showFeedback();
  }

  // Play one step (or aside step): speech plus its ops on the step's timeline.
  async playStep(step, alive) {
    if (!step) return;
    const say = (step.say || '').trim();
    const ops = (step.draw || []).filter(o => o && typeof o === 'object');
    caption(stripCues(say));
    const tts = await speech(say, this.lesson.id);
    if (!alive()) return;
    const duration = say ? (tts?.duration || estimate(say) / settings.rate) : 0;
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
    showPrep('Thinking about your question…');
    let aside;
    try {
      aside = await api('question', { id: this.lesson.id, section, step, question, recent });
    } catch (e) { showPrep(`Couldn't answer: ${e.message}`, true); return; }
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
    for (const s of aside.steps || []) {
      await this.playStep(s, alive);
      if (!alive()) return;
    }
    this.seek(this.pos.section, this.pos.step);
  }
}

const player = new Player();

// ---------- UI ----------

function caption(text) {
  const c = $('#caption');
  c.textContent = text;
  c.classList.toggle('hidden', !settings.captions || !text);
}
function showPrep(text, error) {
  $('#prep').classList.remove('hidden');
  $('#prepText').textContent = text;
  $('#prep .spinner').classList.toggle('hidden', !!error);
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
function hideStart() { $('#start').classList.add('hidden'); }
function hidePrep() { $('#prep').classList.add('hidden'); }
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
function saveProgress() {
  clearTimeout(progressTimer);
  progressTimer = setTimeout(() => api('progress', { id: player.lesson.id, ...player.pos }).catch(() => {}), 1000);
}

function showFeedback() {
  caption('');
  const fb = $('#feedback');
  fb.classList.remove('hidden');
  fb.dataset.liked = '';
  fb.querySelectorAll('.thumbs button').forEach(b => b.classList.remove('on'));
  $('#fbText').value = '';
  $('#fbSend').textContent = 'Send';
}

function show(screen) {
  $('#home').classList.toggle('hidden', screen !== 'home');
  $('#lesson').classList.toggle('hidden', screen !== 'lesson');
  $('#feedback').classList.add('hidden');
  $('#handBox').classList.add('hidden');
  hideStart();
  hidePrep();
}

async function goHome() {
  player.stop();
  history.pushState({}, '', '/');
  show('home');
  $('#q').focus();
  renderLibrary();
}

async function renderLibrary() {
  const lib = $('#library');
  let lessons = [];
  try { lessons = await api('lessons'); } catch {}
  lib.replaceChildren();
  if (!lessons.length) return;
  lib.innerHTML = '<h3>Your lessons</h3>';
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
      renderLibrary();
    };
    row.append(t, meta, del);
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
    lesson = await api('outline', { topic, minutes: +minutes, level: settings.level, teacher: settings.teacher, model: settings.model });
  } catch (e) { return showPrep(`Something went wrong: ${e.message}`, true); }
  history.replaceState({}, '', `/?lesson=${lesson.id}`);
  for (const s of lesson.outline.sections) {
    const li = document.createElement('li');
    li.textContent = s.title;
    $('#prepOutline').appendChild(li);
  }
  showPrep(`Writing part 1…`);
  player.load(lesson);
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

  const openHand = () => {
    if (!player.lesson) return;
    if (player.playing && !player.paused) player.togglePause();
    $('#handBox').classList.remove('hidden');
    $('#handQ').value = '';
    $('#handQ').focus();
  };
  const closeHand = () => $('#handBox').classList.add('hidden');
  $('#handBtn').onclick = openHand;
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
    await api('feedback', { id: player.lesson.id, liked: fb.dataset.liked === '' ? null : fb.dataset.liked === 'true', text: $('#fbText').value });
    $('#fbSend').textContent = 'Thanks!';
  };
  $('#fbReplay').onclick = () => { fb.classList.add('hidden'); player.seek(0, 0); };
  $('#fbHome').onclick = goHome;

  document.addEventListener('keydown', e => {
    if ($('#lesson').classList.contains('hidden') || e.target.matches('input, textarea, select')) return;
    if (e.key === ' ') { e.preventDefault(); player.togglePause(); }
    else if (e.key === 'ArrowRight') player.next();
    else if (e.key === 'ArrowLeft') player.prev();
    else if (e.key === '?' || e.key === 'h') { e.preventDefault(); openHand(); }
    else if (e.key === 'c') $('#ccBtn').click();
    else if (e.key === 'Escape') closeHand();
  });

  // Settings
  const dlg = $('#settings');
  $('#openSettings').onclick = async () => {
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
    const name = sel.selectedOptions[0]?.textContent.split(' (')[0];
    const text = `Hi, I'm ${name}. Let's learn something.`;
    if (config.tts) {
      const r = await api('tts', { text, voice: sel.value }).catch(() => null);
      if (r) { const a = new Audio(r.url); a.playbackRate = +$('#sRate').value; a.play(); }
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
    try { voices = (await api('voices')).map(v => ({ id: v.id, name: v.name })); } catch {}
  } else {
    voices = speechSynthesis.getVoices().filter(v => v.lang.startsWith('en')).map(v => ({ id: v.name, name: `${v.name} (${v.lang})` }));
  }
  for (const v of voices) {
    const o = document.createElement('option');
    o.value = v.id; o.textContent = v.name;
    sel.appendChild(o);
  }
  sel.value = (config.tts ? settings.voice || config.voice : settings.browserVoice) || '';
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
  renderLibrary();
}

(async function init() {
  try { config = await api('config'); } catch {}
  applyName();
  wire();
  route();
})();
