// Listening backend: a speech-recognition model that runs in the learner's browser (transformers.js).
// The server never hears the audio: it tells the client which model to use (see public/listen-worker.js).
// Default: Moonshine base, made for on-device English speech recognition (~63 MB with q8).

export const type = 'browser-transcribe';

const MODELS = {
  'onnx-community/moonshine-base-ONNX': 'Moonshine base (English, ~63 MB)',
  'onnx-community/moonshine-tiny-ONNX': 'Moonshine tiny (English, ~28 MB, fastest)',
  'onnx-community/whisper-base.en': 'Whisper base (English, ~75 MB)',
  'onnx-community/whisper-tiny.en': 'Whisper tiny (English, ~40 MB)',
  'onnx-community/whisper-base': 'Whisper base (many languages, ~75 MB)',
};

export const meta = {
  label: 'In-browser speech recognition (free)', kind: 'listening',
  help: 'Runs on the learner’s device; audio never leaves it. First use downloads the model.',
  fields: [
    { key: 'model', label: 'Model', kind: 'select', options: Object.keys(MODELS), default: 'onnx-community/moonshine-base-ONNX', hint: 'Moonshine is made for on-device use; Whisper base also does other languages' },
    { key: 'dtype', label: 'Precision', kind: 'select', options: ['q8', 'fp32'], default: 'q8', hint: 'q8 downloads about a quarter of the size' },
    { key: 'device', label: 'Runs on', kind: 'select', options: ['wasm', 'webgpu', 'auto'], default: 'wasm', hint: 'auto uses the GPU when the browser offers it' },
  ],
};

export function create({ model = 'onnx-community/moonshine-base-ONNX', dtype = 'q8', device = 'wasm' }) {
  return {
    type,
    capabilities: { runsIn: 'browser' },
    describe: () => `${(MODELS[model] || model).split(' (')[0]} in the browser (free)`,
    clientSpec: () => ({ model, dtype, device }),
  };
}
