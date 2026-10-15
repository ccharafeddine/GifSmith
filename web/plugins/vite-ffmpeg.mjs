// Vite plugin (vendored from MediaSmith packages/platform): ship @ffmpeg/core with the app as same-origin static files,
// splitting the ~31 MiB wasm into parts under the 25 MiB static-asset
// per-file cap. Dev serves the same layout from memory. Output:
//   <outDir>/ffmpeg/ffmpeg-core.js, ffmpeg-core.wasm.part0..N, manifest.json
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PART_BYTES = 20 * 1024 * 1024; // 20 MiB, comfortably below 25 MiB

function coreDir(root) {
  // The ESM build (the "import" condition). Resolved from this package, which
  // depends on @ffmpeg/core; fall back to the app root.
  try { return dirname(fileURLToPath(import.meta.resolve("@ffmpeg/core"))); } catch { /* older Node */ }
  const req = createRequire(join(root, "package.json"));
  return join(dirname(req.resolve("@ffmpeg/core")), "..", "esm");
}

function load(root, withFonts) {
  const dir = coreDir(root);
  const core = readFileSync(join(dir, "ffmpeg-core.js"));
  const wasm = readFileSync(join(dir, "ffmpeg-core.wasm"));
  const parts = [];
  for (let i = 0; i * PART_BYTES < wasm.length; i++) parts.push(wasm.subarray(i * PART_BYTES, (i + 1) * PART_BYTES));
  const fontDir = join(dirname(fileURLToPath(import.meta.url)), "fonts");
  const fonts = !withFonts ? [] : ["Inter.ttf", "Syne-Regular.ttf", "Syne-Bold.ttf"].map((f) => [f, readFileSync(join(fontDir, f))]);
  const manifest = { core: "ffmpeg-core.js", parts: parts.map((_, i) => `ffmpeg-core.wasm.part${i}`), bytes: wasm.length, fonts: fonts.map((f) => f[0]) };
  return { core, parts, manifest, fonts };
}

/** @param {{ fonts?: boolean }} [opts] Ship Inter/Syne for libass (captions/text burn-in). */
export default function ffmpegCore(opts = {}) {
  let root = process.cwd();
  let outDir = "dist";
  return {
    name: "smith-ffmpeg-core",
    configResolved(c) { root = c.root; outDir = resolve(c.root, c.build.outDir); },
    configureServer(server) {
      const files = load(root, opts.fonts);
      server.middlewares.use((req, res, next) => {
        const m = /\/ffmpeg\/([^?]+)/.exec(req.url ?? "");
        if (!m) return next();
        const name = m[1];
        let body = null, type = "application/octet-stream";
        if (name === "manifest.json") { body = JSON.stringify(files.manifest); type = "application/json"; }
        else if (name === files.manifest.core) { body = files.core; type = "text/javascript"; }
        else if (name.startsWith("fonts/")) { const f = files.fonts.find((x) => "fonts/" + x[0] === name); if (f) { body = f[1]; type = "font/ttf"; } }
        else { const i = files.manifest.parts.indexOf(name); if (i >= 0) body = files.parts[i]; }
        if (body === null) return next();
        res.setHeader("Content-Type", type);
        res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
        res.end(body);
      });
    },
    writeBundle() {
      const files = load(root, opts.fonts);
      const dir = join(outDir, "ffmpeg");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "ffmpeg-core.js"), files.core);
      files.parts.forEach((p, i) => writeFileSync(join(dir, files.manifest.parts[i]), p));
      if (files.fonts.length) mkdirSync(join(dir, "fonts"), { recursive: true });
      for (const [n, b] of files.fonts) writeFileSync(join(dir, "fonts", n), b);
      writeFileSync(join(dir, "manifest.json"), JSON.stringify(files.manifest));
    },
  };
}
