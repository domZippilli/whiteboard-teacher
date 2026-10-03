# Whiteboard Teacher

A web app where you ask a question ("how do solar panels work?") and an AI teacher gives a
narrated, live-drawn whiteboard lesson of a chosen length. Intended to be usable as a browser
home page / address-bar search engine.

## Stack
- `server.js` — zero-dependency Node (v20+) server. Serves `public/`, writes lessons by running
  the `claude` CLI (`claude -p`, no API key needed), and proxies speech to ElevenLabs.
  Optional `.env`: `PORT` (default 4747), `MODEL` (default `opus`), `ELEVENLABS_*`.
- Each lesson is one Claude Code session (`--session-id`, then `--resume`), named "Lesson: …",
  run with cwd `~/.whiteboard-teacher/sessions` so it doesn't load this repo's CLAUDE.md. Parts are
  written in order in that session; raise-hand questions `--fork-session` from it.
- Secrets: `ELEVENLABS_API_KEY`, or a 1Password reference read with `op read` at startup
  (set `ELEVENLABS_API_KEY_OP_REF`; needs `OP_SERVICE_ACCOUNT_TOKEN`).
- `public/` — vanilla HTML/CSS/JS, no build step. SVG whiteboard.
- TTS: ElevenLabs `eleven_v3` with-timestamps (per-character timings drive `at` sync; `[audio tags]` in
  `say` cue delivery and are stripped from captions). Client levels loudness with a Web Audio compressor.
  Browser Web Speech fallback.
  Voices offered are the `VOICES` list in `server.js` (first names: Justin, Alexander).
  Plan allows 3 concurrent requests; the server queues (ELEVENLABS_CONCURRENCY, default 2).
- Local-only app. Saved lessons + audio live in `lessons/` (gitignored).
- Spoken questions: browser MediaRecorder → `POST /api/stt` (raw audio) → ElevenLabs Scribe (`scribe_v2`).
- Teaching style (Serious / Matter of fact / Jovial / Goofy) is `TONES` in `server.js`, stored per lesson and
  added to the system prompt for every call in that lesson.
- Content policy: optional `content-policy.txt` (gitignored; see `content-policy.example.txt`). When present,
  topics/questions are screened by `claude -p --model sonnet` (Haiku was inconsistent) before anything is sent to the lesson writer (refusal → 422
  `{refused:true, suggestions}`: a spoken kind message plus suggested safe topics as buttons), and the policy is added to every lesson system prompt.
- Run: `npm start` → http://localhost:4747 (`/?q=topic&min=5` starts a lesson directly).

## Core concept: the lesson script
Claude returns JSON; the client renders it. A lesson = outline → sections → steps.
Each step is `{ "say": "...", "draw": [ops] }`. Ops (in a 1600x900 board space):
`clear, text, line, rect, circle, ellipse, path, polyline, brace, label, icon, dot (particle along a path),
move, scale, rotate, highlight, color, fade, erase, stop, group, pause` (full reference in docs/SCRIPT_API.md).
Draw ops in a step are spread across the time it takes to speak `say`.
The script format is documented in `docs/SCRIPT_API.md`, which is also the system prompt the model sees. If you add an op, update both
that doc and the renderer in `public/`. Do not add layout or structure rules; style comes from user feedback.

## Conventions
- Keep it dependency-free unless there's a strong reason; no bundler.
- Never expose keys to the browser; all model/TTS calls go through `server.js`.
- Long lessons are generated section-by-section, prefetching the next section while the
  current one plays — keep first-section latency low.
- See `PLAN.md` for roadmap and open decisions.

## Testing
- `public/dev/board.html?lesson=<id>&section=0&upto=6&instant=1` renders a saved lesson's
  drawings with no audio. Headless Chrome screenshots work well with `instant=1`; animated
  rendering under `--virtual-time-budget` stalls (rAF), so test animation in real time over CDP.
