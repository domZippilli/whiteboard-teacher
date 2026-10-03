// Listening backend: any server with the OpenAI Transcriptions API (/v1/audio/transcriptions):
// faster-whisper (Speaches), whisper.cpp server, LocalAI, OpenAI, Groq, ...

export const type = 'openai-transcribe';

export const meta = {
  label: 'OpenAI-compatible transcription API', kind: 'listening',
  help: 'Any /v1/audio/transcriptions server: Speaches (faster-whisper), whisper.cpp, LocalAI, OpenAI…',
  fields: [
    { key: 'baseUrl', label: 'Base URL', kind: 'text', default: 'http://localhost:8000/v1', hint: 'Up to and including /v1' },
    { key: 'model', label: 'Model', kind: 'text', default: 'whisper-1', hint: 'As the server names it, e.g. Systran/faster-whisper-small, whisper-1' },
    { key: 'apiKey', label: 'API key', kind: 'secret', hint: 'Leave empty for servers without one' },
    { key: 'language', label: 'Language', kind: 'text', default: 'en', hint: 'ISO code; empty lets the model guess' },
    { key: 'timeout', label: 'Timeout (seconds)', kind: 'number', default: 30 },
  ],
};

// settings: as in meta.
export function create({ baseUrl = 'http://localhost:8000/v1', model = 'whisper-1', apiKey, language = 'en', timeout = 30 }) {
  const url = baseUrl.replace(/\/+$/, '') + '/audio/transcriptions';
  const host = new URL(url).host;
  return {
    type,
    describe: () => `${model} @ ${host}`,
    async transcribe({ audio, mime = 'audio/webm' }) {
      const ext = mime.includes('wav') ? 'wav' : mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : 'webm';
      const form = new FormData();
      form.append('model', model);
      form.append('response_format', 'json');
      if (language) form.append('language', language);
      form.append('file', new Blob([audio], { type: mime.split(';')[0] }), `question.${ext}`);
      let res;
      try {
        res = await fetch(url, { method: 'POST', headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {}, body: form, signal: AbortSignal.timeout(timeout * 1000) });
      } catch (e) {
        throw Object.assign(new Error(`Can't reach ${host}: ${e.cause?.code || e.message}`), { status: 0 });
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error(data?.error?.message || data?.message || `${res.status} from ${host}`), { status: res.status });
      return String(data.text || '').trim();
    },
  };
}
