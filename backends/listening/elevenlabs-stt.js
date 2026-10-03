// Listening backend: ElevenLabs Scribe speech-to-text.

export const type = 'elevenlabs-stt';

export const meta = {
  label: 'ElevenLabs Scribe', kind: 'listening',
  help: 'Speech to text for spoken questions.',
  fields: [
    { key: 'apiKey', label: 'API key', kind: 'secret' },
    { key: 'model', label: 'Model', kind: 'select', options: ['scribe_v2', 'scribe_v1'], default: 'scribe_v2' },
  ],
};

// settings: { apiKey, model }
export function create({ apiKey, model = 'scribe_v2' }) {
  return {
    type,
    describe: () => `ElevenLabs ${model}`,
    async transcribe({ audio, mime = 'audio/webm' }) {
      const form = new FormData();
      form.append('model_id', model);
      form.append('tag_audio_events', 'false');
      form.append('file', new Blob([audio], { type: mime }), 'question.' + (mime.includes('mp4') ? 'm4a' : 'webm'));
      const r = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
        method: 'POST', headers: { 'xi-api-key': apiKey }, body: form,
      });
      const data = await r.json();
      if (!r.ok) throw Object.assign(new Error(data?.detail?.message || `ElevenLabs STT error ${r.status}`), { status: r.status });
      return (data.text || '').trim();
    },
  };
}
