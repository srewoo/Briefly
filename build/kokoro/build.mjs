// Bundles kokoro-js + transformers.js into a browser ESM file vendored by the
// extension, and copies the ONNX runtime WASM. Run: `npm run build:kokoro`.
import { build } from "esbuild";
import { cp, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const vendor = path.resolve(here, "../../Briefly/lib/vendor");

await build({
  entryPoints: [path.join(here, "src/entry.js")],
  outfile: path.join(vendor, "kokoro.bundle.mjs"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  legalComments: "none",
  alias: {
    "fs/promises": path.join(here, "src/stub-empty.js"),
    "fs": path.join(here, "src/stub-empty.js"),
    "path": path.join(here, "src/stub-empty.js")
  }
});

const ortWasm = path.join(here,
  "node_modules/@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.wasm");
await stat(ortWasm);
await cp(ortWasm, path.join(vendor, "ort-wasm-simd-threaded.jsep.wasm"));

console.log("✓ kokoro.bundle.mjs + ort wasm written to Briefly/lib/vendor/");
