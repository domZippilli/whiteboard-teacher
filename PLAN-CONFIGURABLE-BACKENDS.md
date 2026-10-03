# Plan: configurable backends

Status: in progress (2026-10-03). Steps 1–4 done.

## Goal
Let the admin choose, for the whole server, which service does each job: writing lessons, screening
and profiles, voice, and listening. Learners then choose among the voices the admin has enabled.

The backends are **categories of standard APIs**, not products. A product like Kokoro, Ollama or
Whisper is used through whichever standard API it speaks, so supporting one API supports many
products.

## Concepts
- **Backend type**: a protocol the server knows how to speak (e.g. "OpenAI-compatible speech").
- **Backend**: a configured instance of a type: name, base URL, model, credentials, limits.
  The admin can have several of the same type (e.g. a lab server and OpenRouter).
- **Job**: what the app needs done. Each job has an ordered list of backends: the first healthy
  one is used, the rest are fallbacks.

| Job | Used for | Today |
|---|---|---|
| `lessons` | outlines, parts, answers, quizzes | `claude -p`, Opus |
| `utility` | content screening, learning-profile updates | `claude -p`, Sonnet |
| `voice` | speech for lessons and the teacher's lines | ElevenLabs v3 |
| `listening` | spoken questions | ElevenLabs Scribe |

## Backend types

### Text (jobs: `lessons`, `utility`)
| Type | Speaks | Covers |
|---|---|---|
| `claude-cli` | the `claude` CLI (`-p`, sessions) | Claude via the signed-in account; no key (today's backend) |
| `anthropic-messages` | Anthropic Messages API | Anthropic, and servers that offer an Anthropic-compatible endpoint |
| `openai-chat` | OpenAI Chat Completions (`/v1/chat/completions`) | Ollama, LM Studio, vLLM, llama.cpp server, LocalAI, OpenRouter, LiteLLM, OpenAI |

Settings: base URL, model, key (optional), max tokens, JSON mode on/off, timeout.

### Voice (job: `voice`)
| Type | Speaks | Covers |
|---|---|---|
| `elevenlabs` | ElevenLabs TTS API | ElevenLabs (audio tags, per-character timings) |
| `openai-speech` | OpenAI Speech (`/v1/audio/speech`) | Kokoro via Kokoro-FastAPI, Speaches, LocalAI, OpenAI TTS, others |
| `browser-model` | runs a TTS model in the learner's browser (transformers.js) | Kokoro (`kokoro-js`) first; others later |
| `browser-speech` | Web Speech API | the device's own voices (zero setup; today's fallback) |

Settings: base URL / model / key (server types), concurrency, and the **voice catalog** (below).
Capabilities differ, so each type declares them: `timings` (word/char timings for drawing sync),
`audioTags` (understands `[excited]` etc.), `runsIn` (`server` or `browser`).

### Listening (job: `listening`)
| Type | Speaks | Covers |
|---|---|---|
| `elevenlabs-stt` | ElevenLabs Scribe | today's backend |
| `openai-transcribe` | OpenAI Transcriptions (`/v1/audio/transcriptions`) | faster-whisper (Speaches), whisper.cpp server, LocalAI, OpenAI |
| `browser-transcribe` ✅ | runs a speech-recognition model in the learner's browser (transformers.js) | Moonshine (default; ~63 MB q8; a question transcribes in ~0.1–0.2 s on a Mac), Whisper tiny/base |
| `browser-recognition` | Web Speech recognition | Chrome/Android (sends audio to Google; no Safari/Firefox) |

## Voice catalog (admin) and voice choice (learners)
- For each voice backend the admin sees the voices it offers (from the backend, e.g. Kokoro's ~50;
  or typed in for APIs that can't list them), **enables** the ones learners may use, and gives each
  a friendly name ("Justin", "Bella", "Emma (British)"). One enabled voice is the backend's default.
- Learners pick from all enabled voices of all backends in the voice job, with a preview. Their
  choice is stored as `{ backend, voice }`.
- If their backend becomes unavailable, they hear the next backend's default voice for that
  paragraph; their choice is kept.
- The teacher's own lines ("Hmm…", "Any questions?") use the learner's voice too.

## Fallbacks and health
- Each job uses the first healthy backend in its list.
- Errors that mean "this backend can't serve now" (auth or quota errors such as 401/402/429 with a
  quota message, connection refused, timeouts) mark it unhealthy for a cooling-off period (10 min;
  1 h for quota). Other errors are retried once.
- Voice can switch per paragraph. Lessons switch only between requests; a lesson that moves to a
  different text backend mid-way continues with the script so far as context.
- Admin › Backends shows each backend's health, last error and a **Test** button.

## Design

### Provider interfaces (server, `backends/`)
```js
// Text
{ capabilities: { conversations, json },
  start({ system, prompt })            → { convo, text }   // convo: opaque, stored in lesson.json
  continue({ convo, system, prompt })  → { convo, text }
  fork({ convo, system, prompt })      → { convo, text }   // asides, quizzes
  once({ system, prompt })             → text }            // screening, profile updates

// Voice (server-side types)
{ capabilities: { timings, audioTags, runsIn: 'server' },
  voices()                             → [{ id, name, lang }]
  speak({ text, voice })               → { audio, mime, timing? } }

// Listening
{ transcribe({ audio, mime })          → text }
```
- `claude-cli` keeps a session id as `convo`. The HTTP types keep the message list in `lesson.json`
  (`lesson.convo`); `fork` copies it.
- Browser types (`browser-model`, `browser-speech`, `browser-recognition`) have small client modules
  with the same shape; the server tells the client which backend and voice to use.
- `[audio tags]` are stripped when the voice has no `audioTags`. `SCRIPT_API.md` mentions cues only
  when the default voice backend supports them.
- When a voice gives no timings, drawing sync falls back to the estimate already used today.

### In-browser models (`browser-model`, first: Kokoro)
- `kokoro-js` loaded as an ES module from a CDN (no bundler). WebGPU where available, WASM
  otherwise; quantization chosen by the admin (q8 default; fp32 for quality on strong devices).
- The model (~80–300 MB) downloads once and is cached by the browser. First use shows a progress bar.
- Generation runs in a Web Worker so the board stays smooth. Paragraphs are generated ahead, as
  with server voices today.
- No server cost and no server cache (audio is made on each device each time). Kokoro has no
  timings, so drawings use the estimate.
- Measured on a Mac (headless Chrome, WASM q8): 7.2 s of speech in 5.0 s with threads (cross-origin
  isolation), 9.8 s without. Unknown: speed on the Android tablet. If too slow there, the admin can put an `openai-speech`
  Kokoro server (Kokoro-FastAPI) ahead of it in the list.

### Configuration
- `data/config.json` (gitignored, 0600), edited in **Admin › Backends**: backends (type + settings),
  the ordered list per job, voice catalogs.
- Secrets: typed in (stored server-side, shown as `••••1234`, never sent to browsers), or an env var
  name, or a 1Password reference (`op://…`).
- No config file = today's behaviour from `.env` (claude-cli, ElevenLabs, browser fallback).
- Speech cache key = backend + model + voice + text.

### Lesson quality on other models
The script format is demanding (long JSON, coordinates, timing). Smaller models may draw poorly or
break JSON. Mitigations: JSON mode where the API has it, the existing retry, and separate `lessons`
and `utility` jobs so a strong model can write lessons while a small one screens. One prompt for all
backends unless testing shows a need for more.

## Steps
1. ✅ **Refactor** today's code behind the interfaces (`claude-cli`, `elevenlabs`, `elevenlabs-stt`,
   `browser-speech`), config loader with `.env` defaults. No behaviour change.
2. ✅ **Voice catalog and learner choice**: admin enables/names voices per backend; learners pick.
3. ✅ **`browser-model` voice with Kokoro**: worker, model download, settings, fallback rules.
4. ✅ **Admin › Backends**: add/edit backends, order per job, secrets, Test, health.
5. **`openai-chat` and `anthropic-messages`** text backends (for the lab model), conversation storage.
6. **`openai-speech`** voice (Kokoro-FastAPI etc.) and **`openai-transcribe`** listening.
7. **`browser-recognition`** listening (optional).

## Decisions
- **Lab model**: Qwen on vLLM, which serves the OpenAI-compatible API, so `openai-chat` is enough
  to start. vLLM also supports structured output (`response_format` with a JSON schema / guided
  decoding), which `openai-chat` should use when available to keep lesson JSON valid.
- **No AI, no lecture**: if every `utility` backend is down, screening refuses kindly ("the teacher
  isn't available right now, try again soon") instead of letting requests through. If every
  `lessons` backend is down, lessons and answers fail the same way. Replays of saved lessons still work.
