// Sounds backend: ElevenLabs sound effects (text to sound, up to 30 s) and music (Eleven Music,
// paid plans). Effects cost ~20 credits a second; music ~900 credits a minute.

export const type = 'elevenlabs-sounds';

export const meta = {
  label: 'ElevenLabs sounds', kind: 'sounds',
  help: 'Sound effects the teacher asks for, and the music library. Paid per second of sound.',
  fields: [
    { key: 'apiKey', label: 'API key', kind: 'secret' },
    { key: 'musicModel', label: 'Music model', kind: 'select', options: ['music_v1', 'music_v2', 'music_v2_5'], default: 'music_v1' },
    { key: 'timeout', label: 'Timeout (s)', kind: 'number', default: 120 },
  ],
};

export function create({ apiKey, musicModel = 'music_v1', timeout = 120 }) {
  if (!apiKey) throw new Error('needs an API key');
  async function post(path, body) {
    const res = await fetch(`https://api.elevenlabs.io${path}`, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout * 1000),
    }).catch(e => { throw Object.assign(new Error(`Can't reach ElevenLabs: ${e.message}`), { status: 0 }); });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      const msg = data?.detail?.message || (typeof data?.detail === 'string' ? data.detail : '') || `ElevenLabs error ${res.status}`;
      throw Object.assign(new Error(msg), { status: res.status });
    }
    return Buffer.from(await res.arrayBuffer());
  }

  return {
    type,
    capabilities: { effects: true, music: true },
    describe: () => `ElevenLabs sounds (${musicModel})`,
    // A sound effect from a description. loop: made to repeat seamlessly.
    async effect({ text, seconds, loop = false }) {
      const audio = await post('/v1/sound-generation?output_format=mp3_44100_128', {
        text, model_id: 'eleven_text_to_sound_v2', duration_seconds: seconds, prompt_influence: 0.4, loop,
      });
      return { audio, mime: 'audio/mpeg', ext: 'mp3' };
    },
    // Instrumental music from a description, at least 3 s.
    async music({ text, seconds }) {
      const audio = await post('/v1/music?output_format=mp3_44100_128', {
        prompt: text, music_length_ms: Math.round(Math.max(3, seconds) * 1000), model_id: musicModel, force_instrumental: true,
      });
      return { audio, mime: 'audio/mpeg', ext: 'mp3' };
    },
  };
}
