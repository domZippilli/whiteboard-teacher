// The sound library: sound effects the teacher has asked for (shared by every lesson, so a sound is
// made once and reused) and the music for the gaps (waiting, quiz, intro, celebrations).
//
// Files live in lessons/_sounds/ with an index, library.json:
//   { effects: { <key>: { text, seconds, file, uses, createdAt } },
//     music:   { <slot> | <style>:<slot>: { prompt, seconds, file, createdAt } } }
// Effects are keyed by their normalized description and length, so the same words give the same file.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

// Music for the gaps. Loops are crossfaded by the player; stings play once.
export const MUSIC_SLOTS = {
  waiting: { label: 'Waiting', hint: 'While a lesson or an answer is being written (loops)', seconds: 45,
    prompt: 'Gentle, curious instrumental background music for thinking: soft marimba, light piano and plucked strings, slow and calm, warm and friendly, steady with no big build-ups, no vocals' },
  quiz: { label: 'Quiz', hint: 'Quietly under the quiz (loops)', seconds: 40,
    prompt: 'Light playful quiz-time background music: pizzicato strings, soft woodblock and xylophone, gently bouncy and not distracting, steady, no vocals' },
  intro: { label: 'Lesson start', hint: 'A short jingle as a lesson begins', seconds: 4,
    prompt: 'A short bright friendly opening jingle for a kids science lesson: xylophone and light brass, cheerful, ends cleanly, no vocals' },
  celebrate: { label: 'Quiz done', hint: 'After the quiz', seconds: 4,
    prompt: 'A short cheerful well-done jingle: bright xylophone and soft brass, happy, ends cleanly, no vocals' },
  perfect: { label: 'Perfect score', hint: 'All quiz answers right', seconds: 6,
    prompt: 'A short triumphant fanfare for a perfect score: joyful brass, timpani roll and a cymbal, ends with a big happy chord, no vocals' },
};

// A set of music per teaching style (the learner's pick, whatever the subject), each falling back to
// the default set above, slot by slot. Prompts are the starting descriptions in Admin › Sounds; a style
// has only the slots it lists (serious and matter-of-fact lessons have no jingles or quiz music).
export const MUSIC_STYLES = {
  '': { label: 'Default', hint: 'Lessons with no style, and any slot a style has no track for' },
  serious: { label: 'Serious', prompts: {
    waiting: 'Calm, thoughtful instrumental background music: solo piano and soft cello, slow and reflective, understated, steady with no big build-ups, no vocals',
  } },
  matter: { label: 'Matter of fact', prompts: {
    waiting: 'Minimal, clean instrumental background music: soft electric piano and a light pulsing synth, neutral and focused, steady with no build-ups, no vocals',
  } },
  jovial: { label: 'Jovial', prompts: {
    waiting: 'Warm, cheerful instrumental background music: acoustic guitar, ukulele, light piano and soft hand percussion, sunny and friendly, steady with no big build-ups, no vocals',
    quiz: 'Upbeat friendly quiz background music: acoustic guitar strums, light handclaps and glockenspiel, bouncy but not distracting, steady, no vocals',
    intro: 'A short warm, cheerful opening jingle: acoustic guitar, glockenspiel and handclaps, ends cleanly, no vocals',
    celebrate: 'A short happy well-done jingle: acoustic guitar, glockenspiel and a bright flute, ends cleanly, no vocals',
    perfect: 'A short joyful celebration: bright brass, handclaps and a big happy final chord, ends cleanly, no vocals',
  } },
  goofy: { label: 'Goofy', prompts: {
    waiting: 'Silly, bouncy instrumental background music: tuba, bassoon, slide whistle and pizzicato strings, cartoonish and playful, steady with no big build-ups, no vocals',
    quiz: 'Goofy cartoon quiz background music: bassoon, pizzicato strings, woodblock and springy boings, sneaky and comic, steady and not distracting, no vocals',
    intro: 'A short goofy cartoon opening jingle: tuba, slide whistle and xylophone, comic, ends with a silly honk, no vocals',
    celebrate: 'A short silly well-done jingle: comic brass, a xylophone run and a slide whistle, ends cleanly, no vocals',
    perfect: 'A short over-the-top comic fanfare: brass, timpani, a cymbal crash and a slide-whistle flourish, ends with a big silly chord, no vocals',
  } },
};
const musicKey = (style, slot) => (style ? `${style}:${slot}` : slot);

// How much sound a lesson may ask for (extra ops are dropped when a part is saved).
export const LIMITS = { effectsPerPart: 3, effectsPerAside: 2, musicPerLesson: 1, effectSeconds: [0.5, 10, 2], musicSeconds: [3, 10, 5] };

const norm = t => String(t || '').trim().replace(/\s+/g, ' ').slice(0, 300);
const clampSecs = (v, [lo, hi, def]) => Math.round(Math.min(hi, Math.max(lo, +v || def)) * 10) / 10;
const keyOf = (kind, text, seconds) => crypto.createHash('sha1').update(`${kind}|${norm(text).toLowerCase()}|${seconds}`).digest('hex').slice(0, 16);

// Sound ops in a list of steps (sound effects and music accents).
const soundOps = steps => (steps || []).flatMap(s => (s?.draw || []).filter(o => o && (o.op === 'sound' || o.op === 'music')));
export const opText = op => norm(op.op === 'music' ? op.music ?? op.sound : op.sound ?? op.music);

// Keep a part's (or aside's) sounds within the limits, in place: drop extras, fix up lengths.
// musicLeft: how many music accents the lesson may still use.
export function limitSounds(steps, { effects, musicLeft }) {
  let e = 0, m = 0;
  for (const s of steps || []) {
    if (!Array.isArray(s?.draw)) continue;
    s.draw = s.draw.filter(o => {
      if (!o || (o.op !== 'sound' && o.op !== 'music')) return true;
      if (!opText(o)) return false;
      if (o.op === 'music') { if (m >= musicLeft) return false; m++; o.seconds = clampSecs(o.seconds, LIMITS.musicSeconds); return true; }
      if (e >= effects) return false;
      e++;
      o.seconds = clampSecs(o.seconds, LIMITS.effectSeconds);
      return true;
    });
  }
  return { effects: e, music: m };
}
// Music accents already used in a lesson.
export const musicUsed = lesson => soundOps([...(lesson.sections || []).flatMap(s => s?.steps || [])]).filter(o => o.op === 'music').length;
// Remove every sound op (for a learner with sounds off, or when there's no sounds backend).
export function stripSounds(steps) {
  for (const s of steps || []) if (Array.isArray(s?.draw)) s.draw = s.draw.filter(o => !o || (o.op !== 'sound' && o.op !== 'music'));
}
// Is this sound one of the lesson's own? (Learners can only have sounds made that their lessons use.)
export function lessonHasSound(lesson, kind, text) {
  const steps = [...(lesson.sections || []).flatMap(s => s?.steps || []), ...(lesson.asides || []).flatMap(a => a.steps || [])];
  return soundOps(steps).some(o => (o.op === 'music' ? 'music' : 'effect') === kind && opText(o).toLowerCase() === norm(text).toLowerCase());
}

export function createSoundLibrary({ dir, backends, urlFor }) {
  const indexFile = path.join(dir, 'library.json');
  let lib = { effects: {}, music: {} };
  try { lib = { effects: {}, music: {}, ...JSON.parse(fs.readFileSync(indexFile, 'utf8')) }; } catch {}
  let saving = Promise.resolve();
  const save = () => (saving = saving.then(async () => {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(indexFile + '.tmp', JSON.stringify(lib, null, 2));
    await fsp.rename(indexFile + '.tmp', indexFile);
  }).catch(e => console.warn('sound library', e.message)));
  const inflight = new Map();

  // Make (or fetch from the cache) a sound. kind: 'effect' | 'music'. Returns { url } or null.
  async function make(kind, text, seconds) {
    text = norm(text);
    if (!text) return null;
    seconds = clampSecs(seconds, kind === 'music' ? LIMITS.musicSeconds : LIMITS.effectSeconds);
    const key = keyOf(kind, text, seconds);
    const have = lib.effects[key];
    if (have && fs.existsSync(path.join(dir, have.file))) {
      have.uses = (have.uses || 0) + 1;
      have.lastUsed = new Date().toISOString();
      save();
      return { url: urlFor(have.file) };
    }
    if (!inflight.has(key)) {
      const p = (async () => {
        for (const b of backends.jobs.sounds) {
          if (!backends.healthy(b)) continue;
          try {
            const { audio, ext } = await (kind === 'music' ? b.music({ text, seconds }) : b.effect({ text, seconds }));
            const file = `${kind === 'music' ? 'accent' : 'fx'}-${key}.${ext}`;
            await fsp.mkdir(dir, { recursive: true });
            await fsp.writeFile(path.join(dir, file), audio);
            lib.effects[key] = { kind, text, seconds, file, uses: 1, createdAt: new Date().toISOString(), lastUsed: new Date().toISOString() };
            save();
            console.log(`sound made (${b.id}): ${kind} ${seconds}s "${text.slice(0, 60)}"`);
            return { url: urlFor(file) };
          } catch (e) {
            // A bad description (422) isn't the backend's fault; nor is ElevenLabs being busy.
            if (e.status === 422 || e.status === 400) { console.warn(`sound refused: "${text.slice(0, 60)}": ${e.message}`); return null; }
            if (e.busy) { console.warn(`sound not made (busy): "${text.slice(0, 60)}"`); return null; }
            backends.markFailed(b, e);
          }
        }
        return null;
      })();
      inflight.set(key, p);
      p.finally(() => inflight.delete(key));
    }
    return inflight.get(key);
  }

  return {
    make,
    // Make a part's sounds in the background as soon as it's written, so they're ready to play.
    warm(steps) {
      if (!backends.jobs.sounds.length) return;
      for (const o of soundOps(steps)) make(o.op === 'music' ? 'music' : 'effect', opText(o), o.seconds).catch(() => {});
    },
    // Descriptions of the effects already made, most used first: offered to the lesson writer to reuse.
    known(limit = 40) {
      return Object.values(lib.effects).filter(e => e.kind !== 'music')
        .sort((a, b) => (b.uses || 0) - (a.uses || 0)).slice(0, limit).map(e => `"${e.text}" (${e.seconds}s)`);
    },

    // ----- music for the gaps -----
    // { <style>: { <slot>: url } } with only the tracks that exist; '' is the default set.
    musicUrls() {
      return Object.fromEntries(Object.keys(MUSIC_STYLES).map(style => [style, Object.fromEntries(Object.keys(MUSIC_SLOTS).flatMap(slot => {
        const m = lib.music[musicKey(style, slot)];
        return m && fs.existsSync(path.join(dir, m.file)) ? [[slot, urlFor(m.file)]] : [];
      }))]));
    },
    async makeMusic(slot, prompt, seconds, style = '') {
      const def = MUSIC_SLOTS[slot];
      if (!def) throw Object.assign(new Error('Unknown music slot'), { status: 400 });
      if (!MUSIC_STYLES[style] || (style && !MUSIC_STYLES[style].prompts[slot])) throw Object.assign(new Error('Unknown style'), { status: 400 });
      prompt = norm(prompt) || MUSIC_STYLES[style].prompts?.[slot] || def.prompt;
      seconds = Math.round(Math.min(120, Math.max(3, +seconds || def.seconds)));
      // The admin asked for this directly: try even a backend that failed a moment ago, and don't take it
      // out of rotation if it fails now (the message says why).
      const b = backends.jobs.sounds.find(x => backends.healthy(x) && x.capabilities.music) || backends.jobs.sounds.find(x => x.capabilities.music);
      if (!b) throw Object.assign(new Error('No sounds backend that can make music (Admin › Backends)'), { status: 503 });
      let audio, ext;
      try { ({ audio, ext } = await b.music({ text: prompt, seconds })); }
      catch (e) {
        const msg = e.busy ? `ElevenLabs is busy right now (${e.message}). Try again in a minute.` : e.message;
        throw Object.assign(new Error(msg), { status: e.status >= 400 && e.status < 500 ? e.status : 502 });
      }
      backends.healthy(b) || backends.clearFailed?.(b);
      const key = musicKey(style, slot);
      const file = `music-${style ? style + '-' : ''}${slot}-${Date.now().toString(36)}.${ext}`;
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, file), audio);
      const old = lib.music[key];
      lib.music[key] = { prompt, seconds, file, createdAt: new Date().toISOString() };
      await save();
      if (old?.file) fsp.unlink(path.join(dir, old.file)).catch(() => {});
      console.log(`music made (${b.id}): ${key} ${seconds}s`);
      return lib.music[key];
    },
    async removeMusic(slot, style = '') {
      const key = musicKey(style, slot);
      const old = lib.music[key];
      delete lib.music[key];
      await save();
      if (old?.file) fsp.unlink(path.join(dir, old.file)).catch(() => {});
    },
    async removeEffect(key) {
      const e = lib.effects[key];
      if (!e) return;
      delete lib.effects[key];
      await save();
      fsp.unlink(path.join(dir, e.file)).catch(() => {});
    },
    // For Admin › Sounds.
    adminView() {
      return {
        styles: Object.entries(MUSIC_STYLES).map(([style, st]) => ({ style, label: st.label, hint: st.hint || null,
          music: Object.entries(MUSIC_SLOTS).filter(([slot]) => !st.prompts || st.prompts[slot]).map(([slot, d]) => {
            const m = lib.music[musicKey(style, slot)];
            return { slot, label: d.label, hint: d.hint, defaultPrompt: st.prompts?.[slot] || d.prompt, defaultSeconds: d.seconds,
              prompt: m?.prompt || null, seconds: m?.seconds || null, url: m ? urlFor(m.file) : null, createdAt: m?.createdAt || null,
              fallback: style && !m && lib.music[slot] ? urlFor(lib.music[slot].file) : null };
          }),
        })),
        effects: Object.entries(lib.effects).map(([key, e]) => ({ key, ...e, url: urlFor(e.file) }))
          .sort((a, b) => String(b.lastUsed || b.createdAt).localeCompare(String(a.lastUsed || a.createdAt))),
        backend: backends.jobs.sounds.map(b => b.describe()).join(' → ') || null,
      };
    },
  };
}
