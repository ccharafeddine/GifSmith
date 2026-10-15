# Web build for gif.chafic.me

`web/dist/` is a standalone static build of the GifSmith web demo, built for the root of https://gif.chafic.me/.

- Base path `/`, no CDN, every file 25 MiB or smaller (the ffmpeg.wasm core is split into parts).
- `_headers` sets COOP/COEP (`same-origin` / `require-corp`), needed for SharedArrayBuffer. Workers static assets reads it (it is not served) and applies it to every response, including the SPA fallback.
- The root `wrangler.jsonc` (no routes) serves `web/dist` with Workers static assets; `not_found_handling: single-page-application` is the SPA fallback, so there is no `_redirects`. `404.html` is a copy of the app for other hosts.
- Favicon, Open Graph and Twitter meta and `og.png` are included.

The source lives in the MediaSmith monorepo (`apps/smiths-web`). Rebuild with:

```
SMITH_SITE=gif npm run build -w @mediasmith/smiths-web
```

then copy `apps/smiths-web/dist-site/gif/` here. See `docs/hosting.md` in MediaSmith for details.