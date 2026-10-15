// Copy extra same-origin static files into the build (and serve them in dev),
// e.g. onnxruntime-web's wasm and the detector models. Paths are relative to
// the repo root; each entry is [from, to-in-dist].
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** @param {[string, string][]} entries */
export default function copyAssets(entries) {
  let root = process.cwd();
  let outDir = "dist";
  return {
    name: "smith-copy-assets",
    configResolved(c) { root = c.root; outDir = resolve(c.root, c.build.outDir); },
    buildStart() {
      for (const [from] of entries) if (!existsSync(join(root, from))) this.error(`missing ${from} (see web/README.md)`);
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? "").split("?")[0];
        const hit = entries.find(([, to]) => url === "/" + to);
        if (!hit) return next();
        res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
        res.setHeader("Content-Type", hit[1].endsWith(".wasm") ? "application/wasm" : hit[1].endsWith(".mjs") ? "text/javascript" : "application/octet-stream");
        res.end(readFileSync(join(root, hit[0])));
      });
    },
    writeBundle() {
      for (const [from, to] of entries) {
        const dest = join(outDir, to);
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(join(root, from), dest);
      }
    },
  };
}
