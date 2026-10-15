// Vite plugin: turn a build into a standalone site for its own (sub)domain root.
// - injects description, Open Graph and Twitter card meta (absolute og:image)
// - promotes `page` (e.g. "clip.html") to index.html
// - writes `_headers` (cross-origin isolation for ffmpeg.wasm), read by Workers static assets,
//   plus 404.html for hosts like GitHub Pages. The SPA fallback comes from wrangler.jsonc
//   (`not_found_handling: single-page-application`), so no `_redirects` is written.
// - the absolute URLs (canonical, og:url, og:image, twitter:image) use `o.url`, the
//   chafic.me subdomain from sites.mjs, unless SMITH_SITE_URL overrides it
//   (for example SMITH_SITE_URL=https://clips.example.com/). Nothing else in a build
//   names a domain.
// Used by `SMITH_SITE=<app> vite build` (see web/README.md).
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const HEADERS = `# Cross-origin isolation for ffmpeg.wasm, and long caching for hashed assets.
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  Cross-Origin-Resource-Policy: same-origin
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
/assets/*
  Cache-Control: public, max-age=31536000, immutable
/ffmpeg/*
  Cache-Control: public, max-age=604800
`;

const esc = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** Site origin for the absolute meta URLs: SMITH_SITE_URL if set, else `fallback`. */
export function siteUrl(fallback, env = process.env.SMITH_SITE_URL) {
  const v = (env ?? "").trim();
  if (!v) return fallback;
  let u;
  try { u = new URL(v); } catch { throw new Error(`SMITH_SITE_URL must be an absolute http(s) URL, got "${v}"`); }
  if (!/^https?:$/.test(u.protocol) || u.search || u.hash) throw new Error(`SMITH_SITE_URL must be a plain http(s) URL, got "${v}"`);
  return u.href.endsWith("/") ? u.href : `${u.href}/`;
}

/** @param {{ page?: string, url: string, title: string, description: string, og: string }} o */
export default function smithSite(o) {
  let outDir = "dist";
  const url = esc(siteUrl(o.url));
  return {
    name: "smith-site",
    configResolved(c) { outDir = resolve(c.root, c.build.outDir); },
    transformIndexHtml(html) {
      const meta = [
        `<meta name="description" content="${esc(o.description)}" />`,
        `<link rel="canonical" href="${url}" />`,
        `<meta name="theme-color" content="#0b0b0f" />`,
        `<meta property="og:type" content="website" />`,
        `<meta property="og:url" content="${url}" />`,
        `<meta property="og:title" content="${esc(o.title)}" />`,
        `<meta property="og:description" content="${esc(o.description)}" />`,
        `<meta property="og:image" content="${url}og.png" />`,
        `<meta property="og:image:width" content="1200" />`,
        `<meta property="og:image:height" content="630" />`,
        `<meta name="twitter:card" content="summary_large_image" />`,
        `<meta name="twitter:image" content="${url}og.png" />`,
      ].join("\n    ");
      return html
        .replace(/<title>[^<]*<\/title>/, `<title>${esc(o.title)}</title>`)
        .replace(/(href|src)="\.\//g, '$1="/')
        .replace(/\s*<meta name="description"[^>]*>/, "").replace("</head>", `    ${meta}\n  </head>`);
    },
    writeBundle() {
      if (o.page && o.page !== "index.html") {
        const from = join(outDir, o.page);
        if (existsSync(from)) renameSync(from, join(outDir, "index.html"));
      }
      writeFileSync(join(outDir, "_headers"), HEADERS);
      copyFileSync(join(outDir, "index.html"), join(outDir, "404.html"));
      copyFileSync(o.og, join(outDir, "og.png"));
      const html = readFileSync(join(outDir, "index.html"), "utf8");
      if (/https?:\/\/(cdn|unpkg|fonts\.g)/.test(html)) throw new Error("CDN reference in index.html");
    },
  };
}
