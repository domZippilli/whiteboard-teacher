# Whiteboard Teacher — Plan

## Goal
Ask a question, pick a length (3 / 5 / 10 / 30 / 60 min), and get a chalk-and-talk lesson:
narrated by a natural voice, with diagrams drawn live in color and simple animations,
interruptible with questions, ending with a quiz. Teacher name is customizable. Works as a home page.

## Status
**V1 is built** (2026-10-03) and in daily use, locally. Remaining work is under "Next" and "V2" below.

## Architecture
```
Browser (public/)                          server.js                      external
 ├ Home: question box, length,      ──►  POST /api/outline   ──►  screen (if policy) → claude -p: outline
 │  level, style, 🎤 / hold A
 ├ Player: SVG board + narration    ──►  POST /api/section   ──►  claude -p --resume: part N
 │                                  ──►  POST /api/tts       ──►  ElevenLabs v3 with-timestamps (cached)
 ├ Raise hand / end questions       ──►  POST /api/question  ──►  screen → claude -p --fork-session
 ├ Spoken questions                 ──►  POST /api/stt       ──►  ElevenLabs Scribe
 ├ End-of-lesson quiz               ──►  POST /api/quiz      ──►  claude -p --fork-session
 └ Library, feedback, progress      ──►  lessons/<id>/lesson.json + audio/
```
- **One Claude Code session per lesson** (`claude -p`, Opus by default, no API key). The outline
  creates it; each part is written in order with `--resume`, so later parts know what was said and
  drawn. Questions and the quiz `--fork-session` from it.
- **Outline first**, then parts on demand: part 1 starts writing as soon as the outline exists;
  part i+1 is prefetched while part i plays. Parts ≈ minutes / 1.75; ~150 spoken words/min.
- **Speech is prefetched** a few steps ahead (ElevenLabs takes ~4s per paragraph), including
  across part boundaries and in answers to questions.

## Script API, not restrictions
- The model gets clear **documentation of the script format** (every op, its fields,
  coordinates, timing, delivery cues), written like an API reference, in `docs/SCRIPT_API.md`,
  which is also the system prompt.
- **No imposed structure**: no layout grid, no section template, no step-size caps. How the
  board is used and how the lecture flows is up to the model.
- Robustness only where it costs no creativity: JSON is parsed with one retry in the same session;
  the renderer ignores unknown ops/fields and odd values.
- Style guidance comes from the learner (style picker now, learning-style profile in V2), not
  hard-coded rules.

## What V1 does
**Lessons**
- Script: `{"steps":[{"say":"...","draw":[ops]}]}`; ops are drawn in sync with speech, optionally
  pinned to words with `"at"`. 20+ ops (shapes, paths, braces, labels, icons, moving particles,
  move/scale/rotate, highlight, erase...). See `docs/SCRIPT_API.md`.
- Narration: ElevenLabs `eleven_v3` with per-character timestamps; `[audio tags]` in `say` cue
  delivery (`[excited]`, `[whispers]`, `[pause]`...). Loudness leveled in the browser. Voices:
  Justin (default), Alexander. Browser Web Speech fallback without a key.
- Teaching style picker: Serious / Matter of fact / Jovial / Goofy. Audience level picker.
- Waiting: pencil-doodle animation with quips; handwritten title card on the board while part 1 is written.

**Interaction**
- Raise hand any time (type, 🎤, or hold A): "Hmm..." in the teacher's voice, an answer on a fresh
  board, then the board is restored and the lesson resumes.
- End of lesson: "Any questions?" (spoken), with a 30s countdown to a multiple-choice quiz
  (spoken questions and explanations, skippable), then a feedback card.
- Keys: space play/pause, ←/→ steps, hold A talk / tap A ask, m ask by voice, c captions, 1-4 quiz.

**Saved lessons**
- `lessons/<date>-<slug>-<id>/lesson.json` (outline, parts, asides, quiz, quiz results, feedback,
  progress) + `audio/<hash>.mp3` with timings, so replay costs nothing.
- Library on the home screen: resume where you left off, last quiz score badge, delete.
- Questions asked are saved as markers on the timeline; click to replay them.

**Content policy** (optional `content-policy.txt`, plain English, e.g. "the learner is 10")
- Topics and questions are screened by Sonnet *before* anything is sent to the lesson writer.
- Refusals are spoken kindly (playful for cheeky requests) with 2-3 suggested safe topics as buttons.
- The policy is added to every lesson prompt, overriding level/style.

**Home page use**
- `/?q=...&min=5` starts a lesson directly, so it can be a custom browser search engine.

## Decisions (2026-10-03)
1. **Model: Opus default** via `claude -p` (no API key), Sonnet selectable. Opus is trusted to be
   creative with the board and the lesson's structure.
2. **TTS: ElevenLabs** (v3 for expressiveness; timestamps for sync). Web Speech as fallback.
3. **Local only.** ElevenLabs key from 1Password (`op read`); no auth/hosting.
4. **Save lessons for replay.** Questions and quizzes become part of the saved lesson.
5. **Content screening is serial** (screen, then generate), so refused requests never reach Opus.
   Sonnet screens (Haiku was inconsistent).

## Next (polish)
- **Faster start**: stream part 1 so playback begins within seconds instead of 30-60s.
- **Layout safety net**: renderer-side bounds clamping / overlap nudging, without constraining the model.
- **Library**: search, export/share a lesson.

## V2
- **Learning style profile.** Turn post-lesson feedback (already collected) into a per-learner
  style guide (`profile/style.md`) that Claude maintains and includes when writing lessons: pace,
  amount of drawing vs talking, analogies, maths depth, humour, and so on. Viewable and editable.
  Possibly several modes per learner (e.g. "quick overview" vs "deep dive").
- **Quiz follow-ups.** Feed quiz results and weak spots into the profile and suggest follow-up lessons.
