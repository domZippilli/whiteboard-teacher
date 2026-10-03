// Voice backend: ElevenLabs text-to-speech with per-character timings ("with-timestamps").
// v3 and v4 models understand [audio tags] like [excited] or [whispers].

export const type = 'elevenlabs';

export const meta = {
  label: 'ElevenLabs', kind: 'voice',
  help: 'Best voice quality, with delivery cues and word timings. Paid per character.',
  fields: [
    { key: 'apiKey', label: 'API key', kind: 'secret' },
    { key: 'model', label: 'Model', kind: 'select', options: ['eleven_v3', 'eleven_v4', 'eleven_v4_turbo', 'eleven_multilingual_v2', 'eleven_flash_v2_5', 'eleven_turbo_v2_5'], default: 'eleven_v3', hint: 'v3 and v4 understand [audio tags]; v4 Turbo costs half' },
    { key: 'concurrency', label: 'Requests at once', kind: 'number', default: 2, hint: 'Your plan’s limit, minus one' },
  ],
};

// settings: { apiKey, model, voices: [{ id, name }], defaultVoice, concurrency }
export function create({ apiKey, model = 'eleven_v3', voices = [], defaultVoice, concurrency = 2 }) {
  // ElevenLabs plans cap concurrent requests (3 on the current plan): queue beyond `concurrency`.
  let active = 0;
  const waiting = [];
  const slot = async fn => {
    if (active >= concurrency) await new Promise(r => waiting.push(r));
    active++;
    try { return await fn(); } finally { active--; waiting.shift()?.(); }
  };

  return {
    type,
    capabilities: { timings: true, audioTags: /^eleven_v[34]/.test(model), runsIn: 'server' },
    model,
    describe: () => `ElevenLabs ${model}`,
    voices: () => voices,
    defaultVoice: defaultVoice || voices[0]?.id,

    // Every voice the account can use, for the admin's voice catalog. Shared-library voices (like the
    // defaults) aren't listed by the API, so the configured ones are always included.
    async available() {
      const res = await fetch('https://api.elevenlabs.io/v2/voices?page_size=100', { headers: { 'xi-api-key': apiKey } });
      const data = await res.json().catch(() => ({}));
      const listed = (data.voices || []).map(v => ({
        id: v.voice_id, name: v.name,
        description: [v.labels?.accent, v.labels?.gender, v.labels?.age, v.labels?.description || v.labels?.descriptive].filter(Boolean).join(', '),
      }));
      return [...voices.filter(v => !listed.some(l => l.id === v.id)), ...listed];
    },

    async speak({ text, voice }) {
      const data = await slot(async () => {
        for (let attempt = 0; ; attempt++) {
          const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}/with-timestamps?output_format=mp3_44100_128`, {
            method: 'POST',
            headers: { 'xi-api-key': apiKey, 'content-type': 'application/json' },
            body: JSON.stringify({ text, model_id: model }),
          });
          const data = await res.json();
          if (res.ok) return data;
          if (res.status === 429 && attempt < 4) { await new Promise(r => setTimeout(r, 1000 * (attempt + 1))); continue; }
          throw Object.assign(new Error(data?.detail?.message || `ElevenLabs error ${res.status}`), { status: res.status });
        }
      });
      const a = data.alignment || {};
      return {
        audio: Buffer.from(data.audio_base64, 'base64'),
        mime: 'audio/mpeg',
        ext: 'mp3',
        timing: {
          chars: a.characters || [],
          starts: a.character_start_times_seconds || [],
          duration: (a.character_end_times_seconds || []).at(-1) || 0,
        },
      };
    },
  };
}
