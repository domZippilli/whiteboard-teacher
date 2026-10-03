# Whiteboard Teacher

A web app where you ask a question ("how do solar panels work?") and an AI teacher gives a
narrated, live-drawn whiteboard lesson of a chosen length, takes questions, and ends with a quiz.
Intended to be usable as a browser home page / address-bar search engine. Local-only.

Run: `npm start` → http://localhost:4747 (`/?q=topic&min=5` starts a lesson directly).
See `PLAN.md` for status, decisions and roadmap.

## Files
- `server.js` — zero-dependency Node (v20+) server: static files (sent `no-cache`), the `/api/*`
  endpoints, lesson storage, Claude and ElevenLabs calls.
- `docs/SCRIPT_API.md` — the lesson script format. It is also the system prompt the model sees.
- `public/board.js` — SVG whiteboard renderer: implements every op in SCRIPT_API.md.
- `public/app.js` — app shell and player: home, library, playback clock, speech, questions,
  push-to-talk, end-of-lesson questions, quiz, feedback, settings.
- `public/index.html`, `public/style.css` — vanilla, no build step.
- `public/dev/board.html` — dev page that renders a saved lesson's drawings without audio.
- `content-policy.example.txt` — template for the optional content policy.
- `lessons/` (gitignored) — saved lessons: `<id>/lesson.json` + `audio/<hash>.mp3|.json`;
  `lessons/_cache/` for audio outside a lesson (voice previews, "Hmm...").

## How lessons are written
- Via the `claude` CLI (`claude -p`, no API key). Default model `opus` (`MODEL` in `.env`).
- Each lesson is one Claude Code session (`--session-id`, then `--resume`), named "Lesson: …",
  run with cwd `~/.whiteboard-teacher/sessions` so it doesn't load this repo's CLAUDE.md or crowd
  its /resume list. Outline first, then parts written in order in that session. Raise-hand
  questions, end-of-lesson questions and the quiz use `--fork-session`.
- System prompt = teacher persona + optional teaching style (`TONES` in `server.js`) + optional
  content policy + SCRIPT_API.md. Replies are JSON only, with one retry in the same session.
- A lesson = outline → sections (parts) → steps. Each step is `{ "say": "...", "draw": [ops] }`.
  Ops (1600x900 board): `clear, text, line, rect, circle, ellipse, path, polyline, brace, label, icon,
  dot, move, scale, rotate, highlight, color, fade, erase, stop, group, pause`. Ops in a step are
  spread across the speech, or pinned to words with `"at"`.
- If you add an op, update both SCRIPT_API.md and `board.js`. Do not add layout or structure rules;
  style comes from the learner (style picker now, learning-style profile in V2).

## Speech
- TTS: ElevenLabs `eleven_v3` with-timestamps; per-character timings drive `at` sync. `[audio tags]`
  in `say` cue delivery and are stripped from captions. Cached on disk by (voice, model, text).
  ~4s per paragraph, so the player prefetches a few steps ahead (also across parts and in asides).
- The plan allows 3 concurrent requests; the server queues (`ELEVENLABS_CONCURRENCY`, default 2).
- Voices offered are the `VOICES` list in `server.js` (first names: Justin, Alexander).
- Client levels loudness with a Web Audio compressor. Browser Web Speech is the fallback.
- Spoken questions: browser MediaRecorder → `POST /api/stt` (raw audio) → ElevenLabs Scribe (`scribe_v2`).
  🎤 buttons auto-stop after silence; hold A is push-to-talk (also in the empty home question box).
- Secrets: `ELEVENLABS_API_KEY`, or a 1Password reference read with `op read` at startup
  (set `ELEVENLABS_API_KEY_OP_REF`; needs `OP_SERVICE_ACCOUNT_TOKEN`).

## Content policy
- Optional `content-policy.txt` (gitignored; `#` lines are comments; re-read on every use).
- When present, topics and questions are screened by `claude -p --model sonnet` (Haiku was
  inconsistent) *before* anything is sent to the lesson writer. Refusal → 422
  `{refused, error, suggestions}`: the message is spoken, suggestions become buttons.
- The policy is also added to every lesson system prompt, overriding level and style.

## End of lesson
- "Any questions?" (spoken) with a 30s countdown to the quiz; the countdown stops if the student
  starts asking. Questions asked here play as asides, then it asks "any other questions?".
- Quiz: `POST /api/quiz` (forked session, prefetched while the last part plays) → `lesson.quiz`;
  results → `lesson.quizResults` (last score shown in the library). Skippable.
- Then the feedback card (stored in `lesson.feedback`, to be used by the V2 style profile).

## Conventions
- Keep it dependency-free unless there's a strong reason; no bundler.
- Never expose keys to the browser; all model/TTS/STT calls go through `server.js`.
- Keep first-part latency low: parts are generated on demand and prefetched one ahead.
- Keys: space play/pause, ←/→ steps, hold A talk / tap A ask, m ask by voice, c captions, 1-4 quiz.
- Commits are currently unsigned (`git -c commit.gpgsign=false`) until the Secretive signing key is fixed.

## Testing
- `public/dev/board.html?lesson=<id>&section=0&upto=6&instant=1` renders a saved lesson's
  drawings with no audio. Headless Chrome screenshots work well with `instant=1`; animated
  rendering under `--virtual-time-budget` stalls (rAF), so test animation in real time over CDP.
- The player is exposed as `window.wt.player` for driving it from the console or CDP
  (e.g. `wt.player.seek(section, step)`).
- Headless Chrome flags that help: `--autoplay-policy=no-user-gesture-required` (audio without a
  click), `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream` (mic). Synthetic
  `KeyboardEvent`s aren't cancelable; use CDP `Input.dispatchKeyEvent` for key tests.
- Avoid testing the content filter with genuinely harmful phrases; use mild ones.
- Lessons in `lessons/` belong to the user (a young learner uses the app). Don't delete ones you
  didn't create; tests that save quizzes/asides into their lessons should be mentioned.
