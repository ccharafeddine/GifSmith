# Web build for gif.chafic.me

`web/dist/` is the GifSmith web demo, built from this repo's own SolidJS frontend (`src/`), so it has the same interface as the desktop app.

## How it works

`web/vite.config.ts` builds `src/` for the browser. It aliases the `@tauri-apps/*` imports to `web/shim/`. There, `invoke` calls `web/commands.ts`, which implements the app's Rust commands with the same arguments, results and events, using ffmpeg.wasm and browser APIs. Files stay in memory in the tab, and saved files download.

## Build

```
npm ci
npm run build:web      # -> web/dist
npm run preview:web    # serve it with COOP/COEP
```

- Base path `/`, no CDN, every file 25 MiB or smaller. The ffmpeg.wasm core and any larger model ship in parts that are joined at runtime.
- `_headers` sets COOP/COEP (`same-origin` / `require-corp`), needed for SharedArrayBuffer. Workers static assets applies it to every response, including the SPA fallback.
- The root `wrangler.jsonc` (no routes) serves `web/dist` with Workers static assets. Its `not_found_handling: single-page-application` is the SPA fallback, so there is no `_redirects`. `404.html` is a copy of the app for other hosts.
- Favicon, Open Graph and Twitter meta and `og.png` are included. The demo badge links to this repo's latest release.

## Desktop-only

- Link import and real folders (the gallery lists GIFs saved in this tab) need the desktop app.
- gifski has no wasm build, so GIFs use ffmpeg's two-pass palette encoder, with the quality slider mapped to colours and dithering.

## Building for another domain

The only domain in the build is in the canonical, `og:url`, `og:image` and `twitter:image` tags of `index.html` and `404.html`. They default to https://gif.chafic.me/. To build for another domain, set `SMITH_SITE_URL` to its public URL (absolute `http(s)`; it must be the root of the domain):

```
SMITH_SITE_URL=https://gifs.example.com npm run build:web
```

On Windows PowerShell: `$env:SMITH_SITE_URL="https://gifs.example.com"; npm run build:web`.
