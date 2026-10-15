// A small, honest note that this is the browser demo, with a link to the app.
declare const __APP_NAME__: string;
declare const __APP_REPO__: string;

export function mountBadge(): void {
  const css = document.createElement("style");
  css.textContent = `
.smith-web-badge{position:fixed;left:12px;bottom:12px;z-index:2147483000;display:flex;gap:8px;align-items:center;font:500 12px/1 Inter,system-ui,sans-serif;color:#cfcfe0;background:rgba(18,18,26,.88);border:1px solid rgba(255,255,255,.1);border-radius:999px;padding:7px 12px;backdrop-filter:blur(8px);box-shadow:0 4px 18px rgba(0,0,0,.35)}
.smith-web-badge a{color:#c4b5fd;text-decoration:none;font-weight:600}.smith-web-badge a:hover{text-decoration:underline}
.smith-web-badge button{all:unset;cursor:pointer;opacity:.6;padding:0 2px}.smith-web-badge button:hover{opacity:1}
.smith-web-engine{position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:2147483001;display:flex;gap:10px;align-items:center;font:500 13px/1 Inter,system-ui,sans-serif;color:#eee;background:rgba(18,18,26,.94);border:1px solid rgba(167,139,250,.4);border-radius:10px;padding:10px 14px;box-shadow:0 8px 28px rgba(0,0,0,.45)}
.smith-web-engine b{color:#c4b5fd;font-variant-numeric:tabular-nums}`;
  document.head.appendChild(css);
  const el = document.createElement("div");
  el.className = "smith-web-badge";
  el.innerHTML = `<span>Browser demo: files stay on this device.</span><a href="${__APP_REPO__}/releases/latest" target="_blank" rel="noopener">Get the desktop app</a><button aria-label="Hide">✕</button>`;
  el.querySelector("button")!.addEventListener("click", () => el.remove());
  document.body.appendChild(el);
}
