# Whiteboard Teacher — Plan

## Goal
Ask a question, pick a length (3 / 5 / 10 / 30 / 60 min), and get a chalk-and-talk lesson:
narrated by TTS, with diagrams drawn live in color and simple animations, interruptible with
questions. Teacher name is customizable. Works as a home page.

## Architecture
```
Browser (public/)                         server.js                 claude -p (one session per lesson)
 ├ Home: big question box + length  ──►  POST /api/outline   ──►   outline JSON
 ├ Player: SVG board + TTS          ──►  POST /api/section   ──►   steps JSON (per section)
 └ "Raise hand" question            ──►  POST /api/question  ──►   aside steps JSON
```
- **Outline first** (fast, small): title + N sections, N ≈ minutes / 1.75.
- **Sections on demand**: generate section 1, start playing; prefetch section i+1 while i plays.
  A 60-min lesson is ~34 sections, never generated all at once.
- **Word budget**: ~150 spoken words/min, divided across sections, drives lesson length.

## Lesson format (model output)
`{"steps":[{"say":"spoken sentence(s)","draw":[ops]}]}`
Ops: `clear`, `text`, `line` (+arrow/dash), `rect`, `circle`, `path` (SVG d), `dot` (particle
moving along a path, repeatable — electrons, photons, flow), `move`, `highlight`, `erase`, `stop`.
Named palette: black, blue, red, green, orange, purple, brown, gray.

## Rendering
- SVG 1600x900 viewBox scaled to the window.
- Strokes "draw on" via stroke-dashoffset animation; text appears letter-by-letter in a
  handwriting font; fills fade in semi-transparent like marker.
- Per step: speak `say` and schedule its ops across the estimated speech duration; step ends
  when both speech and drawing finish.
- `dot` uses SVG `animateMotion`; pause freezes all animations.

## Controls / interruption
- Play / pause, previous / next step, speed (TTS rate), progress by section.
- **Raise hand**: pauses, you type (later: speak) a question, a short aside is generated on a
  fresh board, then the original board is restored and the lesson resumes.
- Keyboard: space = pause, ? = raise hand, arrows = step.

## Settings (localStorage)
Teacher name, voice, speech rate, default length, audience level (kid / general / expert),
model (default `claude-opus-5-5`; `claude-sonnet-5-5` optional), TTS provider + voice.

## Home page use
- Landing page is just the question box with "Ask <Teacher>".
- `/?q=...&min=5` starts directly, so it can be registered as a custom browser search engine.

## Milestones
1. **MVP** (built 2026-10-03, in testing): server + outline/section/question endpoints with schema validation and
   the documented script API, SVG renderer, ElevenLabs TTS with timestamp sync (Web Speech fallback),
   play/pause/raise-hand, settings, end-of-lesson feedback prompt (stored, used in V2).

2. **Polish**: better layout reliability (renderer-side overlap/bounds clamping), smoother
   sync, saved lesson history + replay without regenerating, export/share.
3. **Saved lessons**: lesson + audio storage, library page, question branches on the timeline.
4. **Smarter generation**: streaming steps so playback starts within seconds; voice questions
   via speech recognition; quizzes / "check your understanding" pauses.

## Decisions (2026-10-03)
1. **Model: Opus default** via `claude -p` (one Claude Code session per lesson; no API key), Sonnet selectable. Opus is trusted to be
   creative with the board and the lesson's structure.
2. **TTS: ElevenLabs**, using its with-timestamps endpoint to line drawing up with speech.
   Behind a small provider interface; browser Web Speech is the no-key fallback.
3. **Local only.** Lessons via the local `claude` CLI; ElevenLabs key from 1Password; no auth/hosting.
4. **Save lessons for replay.** Questions asked become part of the saved lesson.

## Script API, not restrictions
- The model gets clear **documentation of the script format** (every op, its fields,
  coordinates, timing behaviour, what renders how), written like an API reference, in
  `docs/SCRIPT_API.md` and loaded into the prompt from there.
- **No imposed structure**: no layout grid, no section template, no step-size caps. How the
  board is used and how the lecture flows is up to the model.
- Robustness only where it costs no creativity: output is parsed/validated against the format,
  with one retry on malformed JSON; the renderer tolerates unknown fields and odd values.
- Style guidance comes from the learner (see V2 "Learning style"), not hard-coded rules.

## Saved lessons & replay
- Each lesson saved to `lessons/<slug>-<date>/`: `lesson.json` (outline + all steps) and the
  generated audio per step (`audio/<section>-<step>.mp3` + timing), so replay costs nothing.
- Asides from "raise hand" are saved as **branches** attached to the step where they were
  asked; on replay they show as markers on the timeline you can open or skip. New questions
  on replay add new branches.
- Library page: list of past lessons, search, delete, resume where you left off.

## V2 (after V1)
- **Learning style profile.** After each lesson, ask "Did you like it? What worked, what
  didn't?" (V1 already collects this). V2 turns that feedback into a per-user style guide
  (`profile/style.md`) that Claude maintains and includes when writing lessons: pace,
  amount of drawing vs talking, analogies, maths depth, humour, and so on. Viewable and editable.
  Possibly several modes per user (e.g. "quick overview" vs "deep dive").
- **Post-lecture quizzes.** Optional quiz at the end, generated from the lesson; answers and
  weak spots feed back into the learning-style profile and suggest follow-up lessons.
