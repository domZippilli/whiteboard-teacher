// Sounds: marker scratches and little UI sounds made with Web Audio (free, instant), the lesson's
// sound effects and music accents (files made by the server's `sounds` backend), and background
// music for the gaps (waiting, quiz): the admin's music library, or a gentle tune made up here.
//
// Everything goes through one volume (the learner's setting). Music gets quieter while the teacher
// speaks (`duck`). Nothing here is required: any failure is just silence.

const PENTATONIC = [0, 2, 4, 7, 9]; // major pentatonic, semitones
const hz = semis => 261.63 * 2 ** (semis / 12); // from middle C
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = list => list[Math.floor(Math.random() * list.length)];

export function createSound(getCtx) {
  let ctx = null, master, synthBus, sfxBus, musicBus, noise;
  let volume = 0.8, allowed = true, ducked = false;
  const live = new Set(); // synth sources, cut on pause/stop
  const playing = new Set(); // <audio> elements for effects and accents
  const buffers = new Map(); // url → Promise<AudioBuffer>
  let bg = null; // background music: { stop() }

  const on = () => allowed && volume > 0;
  function setup() {
    if (ctx) return ctx.state === 'closed' ? null : ctx;
    try { ctx = getCtx(); } catch { return null; }
    master = new GainNode(ctx, { gain: volume });
    master.connect(ctx.destination);
    synthBus = new GainNode(ctx, { gain: 4 }); // synth amps below are relative; measured against speech
    sfxBus = new GainNode(ctx, { gain: 0.7 });
    musicBus = new GainNode(ctx, { gain: 0.45 });
    for (const b of [synthBus, sfxBus, musicBus]) b.connect(master);
    const n = ctx.sampleRate * 2;
    noise = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return ctx;
  }
  // A ready context, or null (sounds off, or the browser hasn't allowed audio yet).
  const ready = () => (on() && setup() && ctx.state === 'running' ? ctx : null);

  function track(src) {
    live.add(src);
    src.onended = () => live.delete(src);
    return src;
  }
  // Filtered noise through an envelope: the basis of every marker sound.
  function noiseBurst({ t, dur, freq, q = 1, amp, attack = 0.02, release = 0.05, sweepTo, bus = synthBus }) {
    const src = track(new AudioBufferSourceNode(ctx, { buffer: noise, loop: true }));
    const bp = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: freq, Q: q });
    if (sweepTo) bp.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
    const g = new GainNode(ctx, { gain: 0 });
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(amp, t + attack);
    g.gain.setValueAtTime(amp, Math.max(t + attack, t + dur - release));
    g.gain.linearRampToValueAtTime(0, t + dur);
    src.connect(bp).connect(g).connect(bus);
    src.start(t, rnd(0, 1.5));
    src.stop(t + dur + 0.05);
    return g;
  }
  // A soft mallet note (marimba-ish): a sine plus a quiet overtone, quick attack, natural decay.
  function note(freq, t, { dur = 0.6, amp = 0.12, bus = synthBus, type = 'sine' } = {}) {
    for (const [mult, a] of [[1, 1], [4, 0.12], [2, 0.25]]) {
      const o = track(new OscillatorNode(ctx, { type: mult === 1 ? type : 'sine', frequency: freq * mult }));
      const g = new GainNode(ctx, { gain: 0 });
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(amp * a, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur * (mult === 1 ? 1 : 0.4));
      o.connect(g).connect(bus);
      o.start(t);
      o.stop(t + dur + 0.05);
    }
  }

  // ----- the board: marker on whiteboard -----
  const marker = {
    // A stroke: a soft scratch for as long as the line is being drawn, with a little wobble in
    // pressure, and a tiny tap as the marker touches down.
    stroke({ dur, len }) {
      const t = ctx.currentTime + 0.01;
      dur = Math.min(dur, 4);
      noiseBurst({ t, dur: 0.025, freq: 2400, q: 0.7, amp: 0.05, attack: 0.002, release: 0.02 });
      const g = noiseBurst({ t, dur, freq: rnd(2600, 4200), q: rnd(0.8, 1.4), amp: 0.045, attack: 0.03, release: 0.06, sweepTo: rnd(2200, 4600) });
      // Pressure wobble: a few random dips across the stroke (longer strokes wobble more).
      const wobbles = Math.min(8, Math.max(1, Math.round((len || 300) / 250)));
      for (let i = 1; i <= wobbles; i++) {
        const at = t + 0.03 + (dur - 0.09) * (i / (wobbles + 1));
        if (at > t + dur - 0.06) break;
        g.gain.linearRampToValueAtTime(0.045 * rnd(0.45, 1), at);
      }
    },
    // Handwriting: short scratchy bursts, about one per letter stroke.
    write({ dur, chars }) {
      const t0 = ctx.currentTime + 0.01;
      const n = Math.min(40, Math.max(2, Math.round(chars / 1.6)));
      for (let i = 0; i < n; i++) {
        const t = t0 + (dur * i) / n + rnd(0, dur / n / 3);
        noiseBurst({ t, dur: rnd(0.04, 0.1), freq: rnd(3000, 5200), q: 1.2, amp: rnd(0.025, 0.045), attack: 0.008, release: 0.03 });
      }
    },
    // Eraser: a soft low swish.
    erase({ dur }) {
      const t = ctx.currentTime + 0.01;
      noiseBurst({ t, dur: Math.max(0.25, dur), freq: 700, q: 0.8, amp: 0.06, attack: 0.06, release: 0.12, sweepTo: 1500 });
    },
    // A highlight pulse: a soft glassy ding.
    highlight() { const t = ctx.currentTime + 0.01; note(1568, t, { dur: 0.7, amp: 0.04 }); note(2349, t + 0.05, { dur: 0.6, amp: 0.025 }); },
  };

  // ----- UI sounds -----
  const UI = {
    right() { const t = ctx.currentTime; note(hz(19), t, { amp: 0.09, dur: 0.4 }); note(hz(24), t + 0.11, { amp: 0.09, dur: 0.7 }); },
    wrong() {
      const t = ctx.currentTime;
      for (const [f, at] of [[hz(-5), 0], [hz(-10), 0.16]]) {
        const o = track(new OscillatorNode(ctx, { type: 'triangle', frequency: f }));
        o.frequency.exponentialRampToValueAtTime(f * 0.85, t + at + 0.25);
        const g = new GainNode(ctx, { gain: 0 });
        g.gain.setValueAtTime(0, t + at);
        g.gain.linearRampToValueAtTime(0.075, t + at + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.3);
        o.connect(g).connect(synthBus);
        o.start(t + at); o.stop(t + at + 0.35);
      }
    },
    tick() { noiseBurst({ t: ctx.currentTime, dur: 0.035, freq: 1900, q: 9, amp: 0.2, attack: 0.002, release: 0.03 }); },
    hand() {
      const t = ctx.currentTime;
      const o = track(new OscillatorNode(ctx, { type: 'sine', frequency: 520 }));
      o.frequency.exponentialRampToValueAtTime(980, t + 0.09);
      const g = new GainNode(ctx, { gain: 0 });
      g.gain.linearRampToValueAtTime(0.06, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      o.connect(g).connect(synthBus);
      o.start(t); o.stop(t + 0.2);
    },
  };

  // ----- made-up music (when the library has no track) -----
  const STINGS = {
    intro: [[0, 0], [7, 0.14], [12, 0.28], [16, 0.42]],
    celebrate: [[7, 0], [12, 0.12], [16, 0.24], [19, 0.36], [24, 0.5]],
    perfect: [[0, 0], [4, 0.1], [7, 0.2], [12, 0.3], [16, 0.42], [19, 0.54], [24, 0.66], [12, 0.9], [16, 0.9], [19, 0.9], [24, 0.9]],
  };
  function synthSting(slot) {
    const t = ctx.currentTime + 0.02;
    for (const [s, at] of STINGS[slot] || STINGS.celebrate) note(hz(s + 12), t + at, { amp: 0.35, dur: at >= 0.9 ? 1.6 : 0.6, bus: musicBus });
  }
  // A gentle wandering pentatonic tune with a soft echo, until stopped. quiz: a bit perkier.
  function synthLoop(slot) {
    const out = new GainNode(ctx, { gain: 0 });
    out.gain.linearRampToValueAtTime(1, ctx.currentTime + 1.5);
    const delay = new DelayNode(ctx, { delayTime: 0.36 });
    const fb = new GainNode(ctx, { gain: 0.32 });
    const lp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 2500 });
    out.connect(musicBus);
    out.connect(delay).connect(lp).connect(fb).connect(delay);
    lp.connect(musicBus);
    const quiz = slot === 'quiz';
    const beat = quiz ? 0.3 : 0.42;
    const root = pick(quiz ? [2, 5, 7] : [0, 5, -3]);
    let next = ctx.currentTime + 0.2, step = 0, last = 2, stopped = false;
    const timer = setInterval(() => {
      if (stopped || ctx.state !== 'running') return;
      while (next < ctx.currentTime + 0.6) {
        // Melody: small steps around the scale, with rests.
        if (Math.random() < (quiz ? 0.7 : 0.55)) {
          last = Math.max(0, Math.min(9, last + pick([-2, -1, -1, 1, 1, 2, 0])));
          const s = root + 12 + PENTATONIC[last % 5] + 12 * Math.floor(last / 5);
          note(hz(s), next, { amp: quiz ? 0.28 : 0.32, dur: quiz ? 0.35 : 0.9, bus: out });
        }
        // A soft bass note every bar.
        if (step % 8 === 0) note(hz(root - 12 + pick([0, 0, 7, 5])), next, { amp: 0.34, dur: 1.8, bus: out });
        step++;
        next += beat * pick([1, 1, 1, 2]) * (quiz ? 1 : rnd(0.9, 1.15));
      }
    }, 120);
    return {
      stop() {
        stopped = true;
        clearInterval(timer);
        const t = ctx.currentTime;
        out.gain.cancelScheduledValues(t);
        out.gain.setValueAtTime(out.gain.value, t);
        out.gain.linearRampToValueAtTime(0, t + 0.8);
        setTimeout(() => { out.disconnect(); lp.disconnect(); }, 2500);
      },
    };
  }

  // ----- music files -----
  function buffer(url) {
    if (!buffers.has(url)) {
      buffers.set(url, fetch(url).then(r => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); })
        .then(a => ctx.decodeAudioData(a)).catch(e => { buffers.delete(url); throw e; }));
    }
    return buffers.get(url);
  }
  // Loop a track forever, crossfading its end into its start so the seam doesn't show.
  function fileLoop(url, slot) {
    const out = new GainNode(ctx, { gain: 1 });
    out.connect(musicBus);
    let stopped = false, timer = null, fallback = null;
    const srcs = new Set();
    buffer(url).then(buf => {
      if (stopped) return;
      const xf = Math.min(3, buf.duration / 4);
      let next = ctx.currentTime + 0.05, first = true;
      const schedule = () => {
        while (!stopped && next < ctx.currentTime + 2) {
          const src = new AudioBufferSourceNode(ctx, { buffer: buf });
          const g = new GainNode(ctx, { gain: 0 });
          const fadeIn = first ? 1 : xf;
          g.gain.setValueAtTime(0, next);
          g.gain.linearRampToValueAtTime(1, next + fadeIn);
          g.gain.setValueAtTime(1, next + buf.duration - xf);
          g.gain.linearRampToValueAtTime(0, next + buf.duration);
          src.connect(g).connect(out);
          src.start(next);
          srcs.add(src);
          src.onended = () => srcs.delete(src);
          next += buf.duration - xf;
          first = false;
        }
      };
      schedule();
      timer = setInterval(schedule, 500);
    }).catch(() => { if (!stopped) fallback = synthLoop(slot); });
    return {
      stop() {
        stopped = true;
        clearInterval(timer);
        fallback?.stop();
        const t = ctx.currentTime;
        out.gain.setValueAtTime(out.gain.value, t);
        out.gain.linearRampToValueAtTime(0, t + 0.8);
        setTimeout(() => { for (const s of srcs) try { s.stop(); } catch {} out.disconnect(); }, 1000);
      },
    };
  }

  // An effect or accent from a URL, through an <audio> element so it can pause with the lesson.
  function playFile(url, bus) {
    const a = new Audio(url);
    try { ctx.createMediaElementSource(a).connect(bus); } catch { return; }
    playing.add(a);
    const done = () => playing.delete(a);
    a.onended = done;
    a.onerror = done;
    a.play().catch(done);
  }

  function applyDuck() {
    if (!ctx) return;
    const t = ctx.currentTime;
    musicBus.gain.cancelScheduledValues(t);
    musicBus.gain.setValueAtTime(musicBus.gain.value, t);
    musicBus.gain.linearRampToValueAtTime(ducked ? 0.12 : 0.45, t + (ducked ? 0.15 : 0.8));
  }

  return {
    // The learner's volume (0–1) and the admin's switch for them.
    configure({ volume: v, allowed: a }) {
      if (v !== undefined) volume = Math.max(0, Math.min(1, +v));
      if (a !== undefined) allowed = !!a;
      if (ctx) master.gain.setTargetAtTime(on() ? volume : 0, ctx.currentTime, 0.05);
      if (!on()) this.stopMusic();
    },
    get on() { return on(); },
    // From the board: 'stroke' | 'write' | 'erase' | 'highlight'.
    board(kind, info) { if (ready() && marker[kind]) marker[kind](info || {}); },
    ui(name) { if (ready()) UI[name]?.(); },
    // A lesson's sound effect (music: a music accent, which ducks under speech).
    effect(url, { music = false } = {}) { if (url && ready()) playFile(url, music ? musicBus : sfxBus); },
    // Background music for a gap: slot 'waiting' or 'quiz'; url from the library, or made up here.
    startMusic(slot, url) {
      if (!ready()) return;
      if (bg?.slot === slot) return;
      bg?.stop();
      bg = url ? fileLoop(url, slot) : synthLoop(slot);
      bg.slot = slot;
    },
    stopMusic() { bg?.stop(); bg = null; },
    // A short musical moment: 'intro' | 'celebrate' | 'perfect'.
    sting(slot, url) {
      if (!ready()) return;
      if (url) buffer(url).then(buf => { const s = new AudioBufferSourceNode(ctx, { buffer: buf }); s.connect(musicBus); s.start(); }).catch(() => synthSting(slot));
      else synthSting(slot);
    },
    // Music is quieter while the teacher talks.
    duck(on) { if (on !== ducked) { ducked = on; applyDuck(); } },
    // Lesson paused: cut marker sounds, pause effects. stop(): the lesson moved on.
    pause() { for (const s of live) try { s.stop(); } catch {} live.clear(); for (const a of playing) a.pause(); },
    resume() { for (const a of playing) a.play().catch(() => {}); },
    stop() { this.pause(); playing.clear(); },
    // Load a music track ahead of time so it starts without a gap.
    preload(url) { if (url && on() && setup()) buffer(url).catch(() => {}); },
  };
}
