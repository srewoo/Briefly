// Browser entry bundled by esbuild → Briefly/lib/vendor/kokoro.bundle.mjs
// Re-exports KokoroTTS and a configure() that points ONNX at the vendored
// WASM and keeps it single-threaded (no SharedArrayBuffer in an extension).
import { KokoroTTS } from "kokoro-js";
import { env } from "@huggingface/transformers";

export function configure(wasmBaseUrl) {
  env.allowRemoteModels = true;          // model WEIGHTS (data) fetched from HF
  env.allowLocalModels = false;
  env.backends.onnx.wasm.wasmPaths = wasmBaseUrl;
  env.backends.onnx.wasm.numThreads = 1; // single-thread: no COOP/COEP isolation
  env.backends.onnx.wasm.proxy = false;
  return env;
}

export { KokoroTTS, env };
