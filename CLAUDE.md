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
- `public/board.js` — SVG whiteboard renderer: implements every op in SCRIPT_API.md (and SCRIPT_SOUNDS.md).
- `public/sound.js` — Web Audio: synthesized marker/UI sounds, lesson effects and music, gap music.
- `soundlib.js` — server-side sound library (`lessons/_sounds/`): effects cache, music slots, limits.
- `public/app.js` — app shell and player: home, library, playback clock, speech, questions,
  push-to-talk, end-of-lesson questions, quiz, feedback, settings.
- `public/index.html`, `public/style.css` — vanilla, no build step.
- `public/dev/board.html` — dev page that renders a saved lesson's drawings without audio.
- `policy-defaults/` — starting text for the content policies (copied to `data/policies/`).
- `lessons/` (gitignored) — saved lessons: `<id>/lesson.json` + `audio/<hash>.mp3|.json`;
  `lessons/_cache/` for audio outside a lesson (voice previews, "Hmm...").

## Deploy (homelab)
- Runs as a systemd **user** service (linger on) with `HOST=127.0.0.1`, behind its own tailnet device: a
  `tailscale/tailscale` container (host network, `TS_USERSPACE=true`, own `--port`, `TS_SERVE_CONFIG` proxying
  HTTPS 443 → 127.0.0.1:4747), so it gets `https://<name>.<tailnet>.ts.net` with no port. HTTPS is needed
  for the mic and threaded WASM.
- LAN devices off the tailnet: local DNS points the same name at the host's LAN address, where a Caddy
  container (bound to the LAN address) serves it with the Tailscale-issued cert, re-exported weekly by a
  user timer (`tailscale cert` in the Tailscale container, then restart Caddy). `PATH` in the
  unit must include `claude` (claude-cli backend) and node.
- Update: `git pull` there, then `systemctl --user restart whiteboard-teacher`. Data (`data/`, `lessons/`,
  `.env`) lives only on that host; claude-cli sessions are in `~/.claude/projects/<encoded sessions dir>/`.
- `public/manifest.webmanifest` + `icon*.png` make it installable ("Add to Home screen").
- Host names, ports and model names stay out of the repo.

## Accounts (V1.5, in progress; see PLAN.md)
- `accounts.js`: users in `data/users.json` (gitignored; `DATA_DIR` overrides), scrypt-hashed
  PINs/passwords, HMAC-signed cookies (`wt_user` long-lived, `wt_admin` sliding 30 min), lockouts.
- Roles: `admin` (password) and `learner` (optional 4–8 digit PIN). First run shows admin setup.
- `server.js` authorizes every request: public (`me`, `profiles`, `setup`, `login`, `logout`),
  signed-in, and admin-only (`admin/*`). Lessons have an `owner`; `ownLesson()` guards lesson
  endpoints and `/lessons/<id>/` files. Settings are per user (`PUT settings`).
- `public/account.js`: setup, profile picker, PIN entry, admin password prompt, admin Users page.
- Test against a throwaway server: `DATA_DIR=<tmp> PORT=4799 node server.js`.

## Backends
- `backends/`: which service does each job (`lessons`, `utility`, `voice`, `listening`, `sounds`). See
  `PLAN-CONFIGURABLE-BACKENDS.md`. `backends/index.js` builds them from `data/config.json`, or from
  `.env` when there is none (claude-cli + ElevenLabs, the original setup).
- Interfaces: text `start/continue/fork/once` (returns `{ convo, text }`), voice `voices()/speak()`
  (returns `{ audio, mime, ext, timing? }`), listening `transcribe()`. Types: text `claude-cli`,
  `anthropic-messages`, `openai-chat`; voice `elevenlabs`, `openai-speech`, `browser-model`; listening
  `elevenlabs-stt`, `openai-transcribe`, `browser-transcribe`; sounds `elevenlabs-sounds` (see Sound).
  No backend for a job → 503 "the teacher isn't available".
- `openai-chat` (llama.cpp, vLLM, Ollama, …): JSON mode via `response_format`, Qwen-style thinking toggle
  (`chat_template_kwargs.enable_thinking`), `<think>` stripped. No server-side conversations, so
  messages are stored in `data/convos/<id>.json` (`convo` = `oc:<id>`; `backends/text/convos.js`).
- `anthropic-messages`: Anthropic API key (or a compatible server); same stored conversations
  (`am:<id>`); the system prompt is marked for prompt caching; 429/529 retried twice.
- `openai-speech` (Kokoro-FastAPI, Speaches, OpenAI…): WAV out, duration read from the header (no
  timings, cues stripped); voices listed from `/audio/voices` when the server has it.
  `openai-transcribe` (Speaches, whisper.cpp, OpenAI…): multipart upload, `language` default `en`.
- `askJson()` tries `lessons` backends in order; a lesson's conversation belongs to `lesson.convoBackend`;
  another backend taking over starts afresh seeded with the outline + parts so far (`lessonSoFar`).
  `utilityOnce()` does the same fallback for screening/profiles. Never commit lab hostnames/model
  names: they belong in `data/config.json`.
- Admin › Backends edits `data/config.json` (0600) live: services (each type's `meta.fields` drive
  the form), and the ordered list per job. Secrets: typed, `$ENV_VAR` or `op://…`; stored as given
  (references, not values) and never sent to the browser (masked). `backends.update()` rebuilds
  without a restart; `backends.test(id)` makes a tiny real request. No `listening` backend → no mic.
- `browser-transcribe` (listening): Moonshine/Whisper via transformers.js in `public/listen-worker.js`.
  `GET config` gives `listenInBrowser` (model spec) when it's the first working listening backend; the
  client converts the recording to 16 kHz and transcribes locally; the model preloads after sign-in.
  Server-side listening backends are tried in order with health marking (`transcribe()` in server.js).
- Voice catalog: `data/voices.json` (per voice backend: enabled `{ id, name }` + default), edited in
  Admin › Voices; without an entry a backend offers its configured voices. Learners pick from
  `GET voices`; a choice is `"backendId:voiceId"` (older settings: bare id). `resolveVoice()` falls
  back to the first backend's default; admins may preview voices that aren't enabled.
- Voice fallback: `POST tts` tries the learner's voice, then each other voice backend's default; cached
  audio first. Failures mark a backend unhealthy (1 h quota/auth, 10 min otherwise; `markFailed`).
- `browser-model` (Kokoro via kokoro-js) runs in the learner's browser: the server answers
  `{ browser: spec }` and `public/voice-worker.js` makes WAV audio (no timings; cues stripped). Static
  responses carry COOP/COEP (credentialless) so WASM can use threads (~2× faster). In the default
  `.env` setup Kokoro follows ElevenLabs in the voice job.
- Lessons store their conversation handle as `convo` (older lessons: `session`, a claude-cli id).

## How lessons are written
- Via the `lessons` backend; by default the `claude` CLI (`claude -p`, no API key), model `opus`.
- With claude-cli, each lesson is one Claude Code session (`--session-id`, then `--resume`), named "Lesson: …",
  run with cwd `~/.whiteboard-teacher/sessions` so it doesn't load this repo's CLAUDE.md or crowd
  its /resume list. Outline first, then parts written in order in that session. Raise-hand
  questions, end-of-lesson questions and the quiz use `--fork-session`.
- System prompt = teacher persona + optional teaching style (`TONES` in `server.js`) + the
  learner's content policy + SCRIPT_API.md. Replies are JSON only, with one retry in the same session.
- A lesson = outline → sections (parts) → steps. Each step is `{ "say": "...", "draw": [ops] }`.
  Ops (1600x900 board): `clear, text, line, rect, circle, ellipse, path, polyline, brace, label, icon,
  dot, move, scale, rotate, highlight, color, fade, erase, stop, group, pause`. Ops in a step are
  spread across the speech, or pinned to words with `"at"`.
- If you add an op, update both SCRIPT_API.md (or SCRIPT_SOUNDS.md) and `board.js`. Do not add layout or structure rules;
  style comes from the learner (style picker now, learning-style profile in V2).

## Speech
- TTS: ElevenLabs `eleven_v3` with-timestamps; per-character timings drive `at` sync. `[audio tags]`
  in `say` cue delivery and are stripped from captions. Cached on disk by (voice, model, text).
  ~4s per paragraph, so the player prefetches a few steps ahead (also across parts and in asides).
- The plan allows 3 concurrent requests; the server queues (`ELEVENLABS_CONCURRENCY`, default 2).
- Voices offered are the `VOICES` list in `server.js` (first names: Justin, Alexander).
- Client levels loudness with a Web Audio compressor. Browser Web Speech is the fallback.
- Spoken questions: browser MediaRecorder → `POST /api/stt` (raw audio) → ElevenLabs Scribe (`scribe_v2`).
  🎤 buttons (`micButton`): hold to talk, let go to ask; a tap listens until a pause (or another tap). ✋ Ask
  works like A: tap opens the box, hold talks. Hold A is push-to-talk (also in an empty question box: home,
  raise-hand, end of lesson). Touch screens (`pointer: coarse`): bigger controls, the raise-hand box
  isn't focused (no on-screen keyboard over the board), hints say "hold 🎤" instead of A.
- Secrets: `ELEVENLABS_API_KEY`, or `ELEVENLABS_API_KEY_OP_REF` (a 1Password reference read with
  `op read` at startup; needs `OP_SERVICE_ACCOUNT_TOKEN`). Both go in `.env` (gitignored).

## Sound
- Synth (`public/sound.js`, free): the board calls `board.onSound(kind, info)` for strokes, handwriting,
  erasing and highlights (not when rebuilding instantly); the player turns them into soft marker sounds.
  Quiz right/wrong, countdown ticks (last 5 s) and the raised hand are synth too.
- `sound` / `music` ops: documented in `docs/SCRIPT_SOUNDS.md`, appended to the system prompt only when
  `lesson.sounds` (set at creation: a `sounds` backend exists and the learner's `user.sounds !== false`).
  Each part/aside prompt lists the library's known effects to reuse. Limits (`LIMITS` in soundlib.js) are
  enforced on save; sounds are made in the background as soon as a part is written (`sounds.warm`).
- `POST sound` { id, kind, text, seconds } → `{ url }` (or null): only sounds the lesson itself contains,
  made once and cached by (kind, description, seconds). The board's `op_sound`/`op_music` emit to the
  player, which plays them through `<audio>` (pausable); late ones (>2.5 s) are skipped.
- Music for the gaps (`MUSIC_SLOTS`: waiting, quiz, intro, celebrate, perfect): Admin › Sounds makes them
  (`POST admin/music`); `GET config` gives `music: { slot: url|null }`; null → generative synth tune.
  Loops are crossfaded. Music ducks while the teacher speaks (`sound.duck`).
- `sounds` job: type `elevenlabs-sounds` (effects: `/v1/sound-generation`; music: `/v1/music`,
  instrumental). Older configs get it automatically when there's an ElevenLabs voice key (`addSoundsJob`).
- Per learner: admin switch `user.sounds` (People › Edit, also stops sounds in existing lessons), volume
  `settings.volume` (Settings; 0 = off).

## Daily lesson time
- Optional per-learner limit `user.dailyMinutes` (Admin › People › Edit). A new lesson's length counts when
  its outline is made (`recordUsage` → `data/usage.jsonl`, by server-local day); replays and questions
  are free; deleting a lesson doesn't refund. Over the limit → 429 `{ limited, usage }` before screening.
- `GET me` and `GET admin/users` include `usage: { limit, used, left }`; the home screen shows the minutes
  left and greys out lengths that don't fit (`markLengths`); the out-of-time card is spoken.

## Content policies
- `data/policies/master.txt` (everyone) + one per age band (`under8`, `8-12`, `13-17`, `adult`), seeded
  from `policy-defaults/` on first run, edited in Admin › Content rules. `#` lines are comments.
- A learner's policy = master + their band + the admin's notes on their profile (`policyFor(user)`);
  a lesson uses its owner's (`lessonPolicy`). Re-read on every use.
- Topics and questions are screened by `claude -p --model sonnet` (Haiku was inconsistent) *before*
  anything is sent to the lesson writer. Refusal → 422 `{refused, error, suggestions}`: the message is
  spoken, suggestions become buttons. Refusals are logged to `data/log.jsonl` (Admin › Lessons per learner).
- The policy is also added to every lesson system prompt, overriding level and style.

## Learning profiles
- `data/profiles/<user>.md`: plain-English guide to how that learner learns best. Updated by a
  background `claude -p --model sonnet` call (`updateProfile`) from a lesson's feedback, quiz answers
  and questions, debounced: 2 min after feedback/quiz, 5 min after finishing (`PROFILE_DELAY_MS`
  overrides for tests). Previous version kept as `.md.prev`.
- The `## From the grown-up` section is the admin's: re-inserted verbatim after every update.
- Added to every lesson/answer/quiz system prompt for that learner. Admin › People › History ›
  Learning profile to view/edit. Admin › History also shows lessons, questions, quizzes, feedback,
  refusals (`GET admin/history`, `GET admin/refusals`).

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
