// Runs a text-to-speech model in the browser, off the main thread, so the board stays smooth.
// Messages in:  { type: 'speak', id, spec: { engine, model, dtype, device, voice }, text }
// Messages out: { type: 'progress', loaded, total } while the model downloads (first use only;
//               the browser caches it), { type: 'audio', id, wav: ArrayBuffer, duration } or
//               { type: 'error', id, message }.
// Requests are handled one at a time, in order.

const KOKORO_JS = 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js';

let tts = null;
let loadedKey = '';
let queue = Promise.resolve();

async function load(spec) {
  const key = `${spec.engine}|${spec.model}|${spec.dtype}|${spec.device}`;
  if (tts && key === loadedKey) return tts;
  if (spec.engine !== 'kokoro') throw new Error(`Unknown engine ${spec.engine}`);
  const { KokoroTTS } = await import(KOKORO_JS);
  // 'auto': WebGPU (fast, needs fp32) where the browser has it, otherwise WASM.
  let { device, dtype } = spec;
  if (device === 'auto') device = self.navigator?.gpu ? 'webgpu' : 'wasm';
  if (device === 'webgpu') dtype = 'fp32';
  const files = new Map(); // file → { loaded, total }, for one overall progress figure
  tts = await KokoroTTS.from_pretrained(spec.model, {
    dtype, device,
    progress_callback: p => {
      if (p.status !== 'progress' || !p.total) return;
      files.set(p.file, { loaded: p.loaded, total: p.total });
      let loaded = 0, total = 0;
      for (const f of files.values()) { loaded += f.loaded; total += f.total; }
      self.postMessage({ type: 'progress', loaded, total });
    },
  });
  loadedKey = key;
  self.postMessage({ type: 'ready' });
  return tts;
}

self.onmessage = ({ data }) => {
  if (data.type !== 'speak') return;
  queue = queue.then(async () => {
    try {
      const model = await load(data.spec);
      const audio = await model.generate(data.text, { voice: data.spec.voice });
      const wav = await audio.toBlob().arrayBuffer();
      self.postMessage({ type: 'audio', id: data.id, wav, duration: audio.audio.length / audio.sampling_rate }, [wav]);
    } catch (e) {
      self.postMessage({ type: 'error', id: data.id, message: String(e?.message || e) });
    }
  });
};
