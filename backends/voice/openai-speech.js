// Voice backend: any server with the OpenAI Speech API (/v1/audio/speech): Kokoro via Kokoro-FastAPI,
// Speaches, LocalAI, OpenAI TTS, ... No word timings, so drawings follow an even spread over the
// audio's length (taken from the WAV header). [audio tags] are removed before speaking.

export const type = 'openai-speech';

export const meta = {
  label: 'OpenAI-compatible speech API', kind: 'voice',
  help: 'Any /v1/audio/speech server: Kokoro-FastAPI, Speaches, LocalAI, OpenAI…',
  fields: [
    { key: 'baseUrl', label: 'Base URL', kind: 'text', default: 'http://localhost:8880/v1', hint: 'Up to and including /v1' },
    { key: 'model', label: 'Model', kind: 'text', default: 'kokoro', hint: 'kokoro (Kokoro-FastAPI), tts-1 / gpt-4o-mini-tts (OpenAI), …' },
    { key: 'apiKey', label: 'API key', kind: 'secret', hint: 'Leave empty for servers without one' },
    { key: 'voices', label: 'Voices', kind: 'text', default: 'af_heart', hint: 'Voice ids, comma-separated, if the server can’t list them (enable them in Admin › Voices)' },
    { key: 'concurrency', label: 'Requests at once', kind: 'number', default: 2 },
    { key: 'timeout', label: 'Timeout (seconds)', kind: 'number', default: 60 },
  ],
};

// OpenAI's own voices, offered when a server can't list its voices.
const OPENAI_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'];
const nameOf = id => id.replace(/^[a-z]{2}_/, '').replace(/^./, c => c.toUpperCase());

// settings: as in meta.
export function create({ baseUrl = 'http://localhost:8880/v1', model = 'kokoro', apiKey, voices = 'af_heart', concurrency = 2, timeout = 60 }) {
  const base = baseUrl.replace(/\/+$/, '');
  const host = new URL(base).host;
  const auth = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  const configured = String(voices).split(',').map(s => s.trim()).filter(Boolean).map(id => ({ id, name: nameOf(id) }));

  let active = 0;
  const waiting = [];
  const slot = async fn => {
    if (active >= concurrency) await new Promise(r => waiting.push(r));
    active++;
    try { return await fn(); } finally { active--; waiting.shift()?.(); }
  };

  return {
    type,
    capabilities: { timings: false, audioTags: false, runsIn: 'server' },
    model,
    describe: () => `${model} @ ${host}`,
    voices: () => configured,
    defaultVoice: configured[0]?.id,

    // Kokoro-FastAPI lists its voices at /audio/voices; otherwise offer the configured ones and OpenAI's.
    async available() {
      try {
        const res = await fetch(`${base}/audio/voices`, { headers: auth, signal: AbortSignal.timeout(10e3) });
        const data = await res.json();
        const list = (Array.isArray(data) ? data : data.voices || data.data || [])
          .map(v => (typeof v === 'string' ? v : v.id || v.voice_id || v.name)).filter(Boolean);
        if (res.ok && list.length) return list.map(id => ({ id, name: nameOf(id) }));
      } catch {}
      return [...configured, ...OPENAI_VOICES.filter(id => !configured.some(v => v.id === id)).map(id => ({ id, name: nameOf(id) }))];
    },

    async speak({ text, voice }) {
      const input = text.replace(/\[[^\]]*\]\s*/g, '').trim();
      const audio = await slot(async () => {
        let res;
        try {
          res = await fetch(`${base}/audio/speech`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...auth },
            body: JSON.stringify({ model, voice: voice || configured[0]?.id, input, response_format: 'wav' }),
            signal: AbortSignal.timeout(timeout * 1000),
          });
        } catch (e) {
          throw Object.assign(new Error(`Can't reach ${host}: ${e.cause?.code || e.message}`), { status: 0 });
        }
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          const msg = data?.error?.message || data?.detail?.message || (typeof data?.detail === 'string' ? data.detail : '') || data?.message;
          throw Object.assign(new Error(msg || `${res.status} from ${host}`), { status: res.status });
        }
        return Buffer.from(await res.arrayBuffer());
      });
      return { audio, mime: 'audio/wav', ext: 'wav', timing: { duration: wavDuration(audio) } };
    },
  };
}

// Length of a WAV file in seconds, from its fmt and data chunks. Streamed WAVs may give a bogus data
// size, so it is capped by the bytes actually there.
function wavDuration(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return 0;
  let byteRate = 0;
  for (let i = 12; i + 8 <= buf.length;) {
    const id = buf.toString('ascii', i, i + 4);
    const size = buf.readUInt32LE(i + 4);
    if (id === 'fmt ') byteRate = buf.readUInt32LE(i + 16);
    if (id === 'data') return byteRate ? Math.min(size, buf.length - i - 8) / byteRate : 0;
    i += 8 + size + (size % 2);
  }
  return 0;
}
