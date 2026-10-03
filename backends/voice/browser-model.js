// Voice backend: a TTS model that runs in the learner's browser (transformers.js). The server never
// makes audio for it: it tells the client which engine and voice to use (see public/voice-worker.js).
// First engine: Kokoro (kokoro-js), 82M parameters, ~90 MB download (q8), cached by the browser.

export const type = 'browser-model';

// Kokoro's English voices (id, name, accent, quality grade from the model card).
const KOKORO_VOICES = [
  ['af_heart', 'Heart', 'American', 'female', 'A'], ['af_bella', 'Bella', 'American', 'female', 'A-'],
  ['af_nicole', 'Nicole', 'American', 'female', 'B-'], ['af_aoede', 'Aoede', 'American', 'female', 'C+'],
  ['af_kore', 'Kore', 'American', 'female', 'C+'], ['af_sarah', 'Sarah', 'American', 'female', 'C+'],
  ['af_alloy', 'Alloy', 'American', 'female', 'C'], ['af_nova', 'Nova', 'American', 'female', 'C'],
  ['af_sky', 'Sky', 'American', 'female', 'C-'], ['af_jessica', 'Jessica', 'American', 'female', 'D'],
  ['af_river', 'River', 'American', 'female', 'D'], ['am_fenrir', 'Fenrir', 'American', 'male', 'C+'],
  ['am_michael', 'Michael', 'American', 'male', 'C+'], ['am_puck', 'Puck', 'American', 'male', 'C+'],
  ['am_echo', 'Echo', 'American', 'male', 'D'], ['am_eric', 'Eric', 'American', 'male', 'D'],
  ['am_liam', 'Liam', 'American', 'male', 'D'], ['am_onyx', 'Onyx', 'American', 'male', 'D'],
  ['am_santa', 'Santa', 'American', 'male', 'D-'], ['am_adam', 'Adam', 'American', 'male', 'F+'],
  ['bf_emma', 'Emma', 'British', 'female', 'B-'], ['bf_isabella', 'Isabella', 'British', 'female', 'C'],
  ['bf_alice', 'Alice', 'British', 'female', 'D'], ['bf_lily', 'Lily', 'British', 'female', 'D'],
  ['bm_george', 'George', 'British', 'male', 'C'], ['bm_fable', 'Fable', 'British', 'male', 'C'],
  ['bm_lewis', 'Lewis', 'British', 'male', 'D+'], ['bm_daniel', 'Daniel', 'British', 'male', 'D'],
].map(([id, name, accent, gender, grade]) => ({ id, name, description: `${accent}, ${gender}, quality ${grade}` }));

// Offered by default: the best-rated voices, with British ones marked.
const KOKORO_DEFAULTS = ['af_heart', 'af_bella', 'af_nicole', 'bf_emma', 'am_michael', 'am_fenrir', 'bm_george']
  .map(id => KOKORO_VOICES.find(v => v.id === id))
  .map(v => ({ id: v.id, name: v.description.startsWith('British') ? `${v.name} (British)` : v.name }));

const ENGINES = {
  kokoro: { voices: KOKORO_VOICES, defaults: KOKORO_DEFAULTS, model: 'onnx-community/Kokoro-82M-v1.0-ONNX' },
};

// settings: { engine: 'kokoro', model, dtype ('q8', 'fp32', ...), device ('wasm', 'webgpu', 'auto') }
export function create({ engine = 'kokoro', model, dtype = 'q8', device = 'wasm' }) {
  const e = ENGINES[engine];
  if (!e) throw new Error(`Unknown browser voice engine: ${engine}`);
  return {
    type,
    capabilities: { timings: false, audioTags: false, runsIn: 'browser' },
    model: model || e.model,
    describe: () => `${engine[0].toUpperCase() + engine.slice(1)} in the browser (free)`,
    voices: () => e.defaults,
    available: async () => e.voices,
    defaultVoice: e.defaults[0].id,
    // What the client needs to generate speech itself.
    clientSpec: voice => ({ engine, model: model || e.model, dtype, device, voice }),
  };
}
