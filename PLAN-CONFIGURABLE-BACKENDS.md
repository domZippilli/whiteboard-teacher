# Plan: configurable backends

Status: proposal (2026-10-03). Not started.

## Goal
Let the admin choose, for the whole server, which service does each job:

| Job | Today | Why change |
|---|---|---|
| **Lessons** (writing scripts, answers, quizzes) | `claude -p`, Opus | Use the API directly, a cheaper model, or a local model on the homelab |
| **Screening & profiles** (content checks, learning-profile updates) | `claude -p`, Sonnet | Same, independently: a small fast model is enough |
| **Voice** (text to speech) | ElevenLabs v3 | ElevenLabs is expensive; Kokoro is free and local |
| **Listening** (speech to text) | ElevenLabs Scribe | A local Whisper server, or the browser |

Server-wide and admin-only for now. Per-learner choices can come later.

## Backends

**Lessons / screening / profiles (LLM)**
- `claude-cli` (current): `claude -p` with one Claude Code session per lesson. No API key; uses the
  signed-in Claude account.
- `anthropic`: Messages API with an API key. Conversation kept in `lesson.json` instead of a CLI
  session. Prompt caching for the big system prompt.
- `openai-compatible`: any `/v1/chat/completions` server: Ollama, LM Studio, vLLM, llama.cpp,
  OpenRouter. Base URL + model + optional key. JSON mode where supported.

**Voice (TTS)**
- `elevenlabs` (current): best quality, `[audio tags]`, per-character timings.
- `kokoro-server`: Kokoro-FastAPI on the homelab (OpenAI-style `/v1/audio/speech`; its captioned
  endpoint returns word timings). Free, fast on a GPU or a decent CPU.
- `kokoro-browser`: `kokoro-js` (transformers.js) running in the learner's browser. No server cost;
  first use downloads the model (~80–300 MB). Speed on the tablet unknown.
- `openai-compatible`: any `/v1/audio/speech` server (OpenAI, others).
- `browser`: Web Speech, the zero-setup fallback that exists today.

**Listening (STT)**
- `elevenlabs` (current), `openai-compatible` (`/v1/audio/transcriptions`: OpenAI, faster-whisper,
  whisper.cpp server), `browser` (Web Speech recognition: Chrome/Android only, sends audio to Google).

## Fallbacks
Each job has an ordered list, e.g. voice: `elevenlabs → kokoro-server → browser`.
- On quota/auth errors (401/402/429 with "quota"), connection failures and timeouts, the server marks
  that backend unhealthy for a while (e.g. 10 min, longer for quota) and moves to the next one.
- Mid-lesson switches are fine for voice (each paragraph is separate) but the client must handle a
  paragraph without timings (estimate, as for the browser voice today).
- For lessons, a switch mid-lesson starts a fresh conversation seeded with the script so far.
- The admin page shows each backend's health and the last error.

## Design

### Provider interfaces (server)
`backends/llm/*.js`, `backends/tts/*.js`, `backends/stt/*.js`, each exporting the same shape:

```js
// LLM
{ capabilities: { sessions, json },
  start({ system, prompt })              → { convo, text }   // convo: opaque handle stored in lesson.json
  continue({ convo, system, prompt })    → { convo, text }
  fork({ convo, system, prompt })        → { convo, text }   // asides and quizzes
  once({ system, prompt, model })        → text }            // screening, profile updates

// TTS
{ capabilities: { timings, audioTags, maxConcurrency },
  voices()                               → [{ id, name }]
  speak({ text, voice })                 → { audio: Buffer, mime, timing?: { chars, starts, duration } } }

// STT
{ transcribe({ audio: Buffer, mime })    → text }
```

- `claude-cli` maps `convo` to a session id (`--resume`, `--fork-session`). API backends keep the
  message list in `lesson.json` (`lesson.convo`), and `fork` copies it.
- `[audio tags]` are stripped before `speak()` when `audioTags` is false; `SCRIPT_API.md` mentions
  cues only when the active voice supports them.
- `kokoro-browser` is special: the server returns "speak this in the browser" and the client runs
  the model, like the Web Speech path today.

### Configuration
- `data/config.json` (gitignored, 0600), edited in **Admin › Backends**. For each job: the backend
  order and per-backend settings (base URL, model, voice list, concurrency).
- Secrets: an API key can be typed in (stored in `config.json`, never sent back to the browser:
  shown as `••••1234`), or given as an env var name or a 1Password reference (`op://…`).
- Env vars and `.env` stay as the defaults, so today's setup keeps working with no config file.
- A **Test** button per backend: a tiny request (one sentence of speech, a short completion) with
  the result or error shown.

### Voices
- The voice list in Settings comes from the active voice backend; each voice has a friendly first
  name (e.g. Justin, Alexander for ElevenLabs; picks from Kokoro's voices).
- A learner's saved voice is `{ backend, id }`. If the backend changes, they get that backend's
  default voice until they pick another.
- TTS cache key includes the backend and model, so switching never plays the wrong cached audio.

### Lesson quality on other models
- The script format is demanding (long JSON, coordinates, timing). Smaller local models may draw
  poorly or break JSON. Mitigations: JSON mode / response_format where available, the existing
  retry, and a per-job model choice so the admin can keep a strong model for lessons and use a
  small one for screening.
- Keep one prompt for all backends; no per-model forks of SCRIPT_API.md unless testing shows a need.

## Steps
1. Refactor: move today's code behind the interfaces (`claude-cli`, `elevenlabs`, `browser`) with
   no behaviour change. Config loader with env defaults.
2. Voice: `kokoro-server`, then `openai-compatible`, fallback chain + health, client handling of
   missing timings and cues.
3. Admin › Backends page: choose order, settings, secrets, Test buttons, health.
4. LLM: `anthropic`, then `openai-compatible`, conversation storage in `lesson.json`.
5. Listening: `openai-compatible` (Whisper), `browser`.
6. `kokoro-browser` (optional; only if the tablet runs it well).

## Open questions
- Which backends first? Proposed: Kokoro (server) for voice, since cost is the main driver.
- Run Kokoro on the homelab (needs a container) or in the browser?
- Any local LLM in mind (Ollama + which model), or is `anthropic` API the main alternative to the CLI?
- Should learners ever pick the voice backend (e.g. "fancy voice" vs "free voice"), or admin only?
