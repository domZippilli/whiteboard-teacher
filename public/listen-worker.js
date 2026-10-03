// Runs a speech-recognition model in the browser, off the main thread (transformers.js).
// Messages in:  { type: 'load', spec } to download/prepare the model ahead of time,
//               { type: 'transcribe', id, spec: { model, dtype, device }, audio: Float32Array (16 kHz mono) }
// Messages out: { type: 'progress', loaded, total } during the first download, { type: 'ready' },
//               { type: 'text', id, text } or { type: 'error', id, message }.

const TRANSFORMERS = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js';

let asr = null;
let loadedKey = '';
let loading = null;

async function load(spec) {
  const key = `${spec.model}|${spec.dtype}|${spec.device}`;
  if (asr && key === loadedKey) return asr;
  if (loading && key === loadedKey) return loading;
  loadedKey = key;
  loading = (async () => {
    const { pipeline } = await import(TRANSFORMERS);
    let { device, dtype } = spec;
    if (device === 'auto') device = self.navigator?.gpu ? 'webgpu' : 'wasm';
    const files = new Map();
    asr = await pipeline('automatic-speech-recognition', spec.model, {
      dtype, device,
      progress_callback: p => {
        if (p.status !== 'progress' || !p.total) return;
        files.set(p.file, { loaded: p.loaded, total: p.total });
        let loaded = 0, total = 0;
        for (const f of files.values()) { loaded += f.loaded; total += f.total; }
        self.postMessage({ type: 'progress', loaded, total });
      },
    });
    self.postMessage({ type: 'ready' });
    return asr;
  })();
  try { return await loading; } finally { loading = null; }
}

let queue = Promise.resolve();
self.onmessage = ({ data }) => {
  queue = queue.then(async () => {
    try {
      const model = await load(data.spec);
      if (data.type !== 'transcribe') return;
      const out = await model(data.audio);
      self.postMessage({ type: 'text', id: data.id, text: String(out?.text || '').trim() });
    } catch (e) {
      self.postMessage({ type: 'error', id: data.id, message: String(e?.message || e) });
    }
  });
};
