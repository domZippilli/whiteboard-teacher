# Whiteboard Teacher — Plan

## Goal
Ask a question, pick a length (1 / 3 / 5 / 10 min), and get a chalk-and-talk lesson:
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

**Content policy** (V1 had one optional `content-policy.txt`; V1.5 replaces it with master + age-band policies)
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

## V1.5: profiles, sign-in and per-learner policies (planned 2026-10-03)
Needed before learning profiles: the app will move to the homelab and be used from several devices
(including an Android tablet) over Tailscale, by several learners of different ages.

**Decisions (from interview)**
- Runs on the homelab, reached over Tailscale from devices at home. Served over HTTPS with
  `tailscale serve` (browsers only allow the microphone on secure pages). Installable as a PWA so
  the tablet gets an app icon and full-screen view.
- Sign-in with **PINs, no Google**: a "who's learning?" profile picker. Admin has an alphanumeric
  password; learner PINs are optional and set by the admin per learner.
- Sessions: learners stay signed in on a device until they switch profile; admin mode expires
  after ~30 min idle and re-asks for the password.
- Age bands: **Under 8 / 8–12 / 13–17 / Adult**.
- Existing lessons are discarded when profiles ship.

**Roles (authz)**
- **Admin**: everything below, plus their own lessons as a learner.
- **Learner**: their own lessons, questions and quizzes; voice/speed settings only.
- Enforced server-side on every request (API, lesson files and audio), not just hidden in the UI.

**Accounts & sessions**
- `data/` (gitignored): `users.json` (id, name, avatar emoji, role, age band, notes, PIN/password
  hash, per-user settings), `secret` (cookie signing key), `policies/`, `profiles/`, `log.jsonl`.
- PINs/passwords hashed with Node's built-in `scrypt` (per-user salt). Lockout after repeated wrong
  attempts (e.g. 5 tries → 5 min, doubling).
- Signed, httpOnly, secure cookie for the learner session; a separate short-lived admin cookie
  (sliding 30 min).
- First run: no users → "create the admin" screen.
- Lessons gain an `owner`; the library, lesson files, audio, questions and quizzes are scoped to it.

**Content policies**
- `data/policies/master.txt`: applies to everyone (weapons, drugs, explicit content...).
- `data/policies/<band>.txt`: one per age band (Adult may be empty).
- Optional per-learner **notes** ("loves dinosaurs, scared of spiders"), set by the admin.
- Screening and every lesson prompt use master + the learner's band + notes. Replaces today's
  single `content-policy.txt` (migrated into master + bands).
- Refusals are logged per learner for the admin to see.

**Learning profiles**
- `data/profiles/<user>.md`: a plain-English style guide per learner (pace, drawing vs talking,
  analogies, depth, humor, interests, what's been learned).
- After each lesson, a background `claude -p` call (Sonnet) updates it from that lesson's feedback,
  quiz result and questions asked. A section the admin writes is kept verbatim.
- Included in the learner's lesson prompts. Admin can view and edit it.

**Admin pages**
- Users: add/edit learners (name, avatar, age band, PIN, notes), reset PINs.
- Policies: edit master and band policies.
- History per learner: lessons, questions asked, refusals, quiz scores, feedback.
- Profile: view/edit each learner's learning profile.

**Build order**
1. ✅ Accounts & sessions: users store, setup screen, profile picker, PINs, cookies, authz on every
   endpoint, lesson ownership; discard old lessons.
2. ✅ Policies: master + age bands + notes; migration from `content-policy.txt`; refusal log.
3. ✅ Admin pages: users, policies, history.
4. ✅ Learning profiles: auto-update after lessons, used in prompts, admin view/edit.
5. Homelab: `tailscale serve` HTTPS, run as a service, PWA manifest + icon, setup notes.

## Next (polish)
- **Faster start**: stream part 1 so playback begins within seconds instead of 30-60s.
- **Layout safety net**: renderer-side bounds clamping / overlap nudging, without constraining the model.
- **Library**: search, export/share a lesson.
- **Configurable backends** (lessons, voice, listening; admin-level, server-wide): see
  `PLAN-CONFIGURABLE-BACKENDS.md`. Covers the Kokoro idea below.
- **Kokoro TTS fallback** (ElevenLabs is expensive). Use Kokoro (82M-parameter open TTS) when
  ElevenLabs is unreachable or errors (e.g. out of credits), or when chosen in settings.
  - In-browser option: `kokoro-js` (transformers.js) loaded as an ES module from a CDN; WebGPU where
    available, WASM otherwise. Model download (~80–300 MB depending on quantization) cached by the
    browser. Worth checking speed on the Android tablet.
  - Homelab option: run Kokoro server-side (e.g. Kokoro-FastAPI), which can return word timestamps;
    likely faster and steadier than in-browser on a tablet.
  - Kokoro has no `[audio tags]`: strip cues before speaking. Without timestamps, `at` sync falls
    back to the estimate already used for browser voices.
  - Server should report ElevenLabs failures (402/401/quota) so the client switches for the rest of
    the session and says so quietly in settings.

## V2
- ~~Learning style profile~~ (done in V1.5). Maybe: several modes per learner ("quick overview" vs "deep dive").
- **Quiz follow-ups.** Quiz results and misses already feed the profile; next: suggest follow-up
  lessons on the home screen ("You mixed up birds and crocodiles. Want a 3-minute lesson on it?").
