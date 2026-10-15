// Browser build of this app's own SolidJS frontend. The @tauri-apps/* imports
// are aliased to ./shim, which runs the app's commands (./commands.ts) with
// ffmpeg.wasm and browser APIs instead of Rust. Output: web/dist, a static
// site for the root of its own (sub)domain. Build: `npm run build:web`.
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ffmpegCore from "./plugins/vite-ffmpeg.mjs";
import smithSite from "./plugins/vite-site.mjs";
import copyAssets from "./plugins/vite-copy.mjs";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const pkg = JSON.parse(readFileSync(here("../package.json"), "utf8"));
const site = JSON.parse(readFileSync(here("./site.json"), "utf8"));
const shim = (m: string) => here(`./shim/${m}.ts`);

export default defineConfig({
  root: here(".."),
  base: "/",
  publicDir: here("../public"),
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_NAME__: JSON.stringify(site.name),
    __APP_REPO__: JSON.stringify(site.repo),
    __SMITH_WEB__: "true",
  },
  resolve: {
    alias: [
      { find: /^@tauri-apps\/api\/core$/, replacement: shim("core") },
      { find: /^@tauri-apps\/api\/event$/, replacement: shim("event") },
      { find: /^@tauri-apps\/api\/webview$/, replacement: shim("webview") },
      { find: /^@tauri-apps\/api\/app$/, replacement: shim("app") },
      { find: /^@tauri-apps\/plugin-dialog$/, replacement: shim("dialog") },
      { find: /^@tauri-apps\/plugin-opener$/, replacement: shim("opener") },
    ],
  },
  plugins: [
    solid(),
    {
      name: "smith-web-entry",
      // Boot the shim (badge, styles) before the app's own entry runs.
      transformIndexHtml: { order: "pre", handler: (html: string) => html.replace(/<script\b/, `<script type="module" src="/web/boot.ts"></script>\n    <script`) },
    },
    ffmpegCore({ fonts: !!site.fonts }),
    copyAssets(site.assets ?? []),
    {
      // Truthful labels for what the browser engine produces (see commands.ts).
      name: "smith-web-labels",
      transform(code: string, id: string) {
        for (const [file, from, to] of (site.relabel ?? []) as [string, string, string][]) {
          if (id.replace(/\\/g, "/").endsWith(file) && code.includes(from)) code = code.split(from).join(to);
        }
        return code;
      },
    },
    smithSite({ page: "index.html", url: site.url, title: site.title, description: site.description, og: here("./og.png") }),
  ],
  optimizeDeps: { exclude: ["@ffmpeg/ffmpeg", "@ffmpeg/util"] },
  worker: { format: "es" },
  build: { outDir: here("./dist"), emptyOutDir: true, target: "es2022", chunkSizeWarningLimit: 2000 },
  server: { headers: { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" } },
  preview: { headers: { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" } },
});
