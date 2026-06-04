// In-browser Kokoro TTS, loaded lazily inside the offscreen document.
// Model weights (~80MB q8) download once from HuggingFace, then cache in the
// browser's Cache Storage — fully free, private, and offline thereafter.
let ttsPromise = null;
let loadedDtype = null;

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';

async function getTTS(dtype) {
  if (ttsPromise && loadedDtype === dtype) return ttsPromise;
  loadedDtype = dtype;
  ttsPromise = (async () => {
    const base = chrome.runtime.getURL('lib/vendor/');
    const { KokoroTTS, configure } = await import(base + 'kokoro.bundle.mjs');
    configure(base); // point ONNX at the vendored .wasm
    // WebGPU when available (fast); fall back to WASM.
    const device = ('gpu' in navigator) ? 'webgpu' : 'wasm';
    try {
      return await KokoroTTS.from_pretrained(MODEL_ID, { dtype, device });
    } catch (e) {
      if (device === 'webgpu') {
        return await KokoroTTS.from_pretrained(MODEL_ID, { dtype, device: 'wasm' });
      }
      throw e;
    }
  })();
  return ttsPromise;
}

// Returns a WAV Blob for the given text.
export async function kokoroSynthesize({ text, voice, dtype }) {
  const tts = await getTTS(dtype || 'q8');
  const audio = await tts.generate(text, { voice: voice || 'af_heart' });
  // RawAudio → WAV Blob
  return audio.toBlob();
}

export const KOKORO_VOICES = [
  'af_heart', 'af_bella', 'af_nicole', 'af_sky', 'af_sarah',
  'am_adam', 'am_michael', 'am_onyx', 'am_echo',
  'bf_emma', 'bf_isabella', 'bm_george', 'bm_lewis'
];
