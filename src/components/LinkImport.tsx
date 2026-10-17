import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  browseClose, browseOpen, browseSaveSignin, cancelFetch, fetchDownload, fetchDownloadHit,
  fetchProbe, fetchSettingsGet, fetchSettingsSet, hitFacts, hitName, LEGAL_NOTE, minSizeLabel,
  SIGNIN_PREFIX, stopRecording, fmtSize,
  type DownloadOptions, type FetchResult, type Hit, type MediaInfo,
} from "../fetch";

// Link import for the desktop app: paste a link and Fetch (best quality), or
// choose quality / playlist / live recording after a probe, or Browse the page
// in a built-in window and pick a video it plays. Errors that need a login
// offer an in-app sign-in. Desktop-only (the parent gates it with isTauri()).
export default function LinkImport(props: {
  disabled?: boolean;
  onFile: (path: string, result: FetchResult) => Promise<void>;
}) {
  const [url, setUrl] = createSignal("");
  const [working, setWorking] = createSignal(false);
  const [recording, setRecording] = createSignal(false);
  const [progress, setProgress] = createSignal(0);
  const [status, setStatus] = createSignal("");
  const [error, setError] = createSignal("");
  const [needsSignin, setNeedsSignin] = createSignal(false);
  const [signinOpen, setSigninOpen] = createSignal(false);
  const [info, setInfo] = createSignal<MediaInfo | null>(null);
  const [probing, setProbing] = createSignal(false);
  const [format, setFormat] = createSignal("");
  const [playlist, setPlaylist] = createSignal(false);
  const [browsing, setBrowsing] = createSignal(false);
  const [hits, setHits] = createSignal<Hit[]>([]);
  const [drm, setDrm] = createSignal(false);
  const [clip, setClip] = createSignal("");
  // Browse list: the backend sends it sorted largest first (estimated size
  // for streams, then duration) and re-sends on every new hit or size update.
  // `picked` is the user's own choice, kept by URL so re-sorting never moves
  // the selection; until they pick, the top item is selected.
  const [picked, setPicked] = createSignal<string | null>(null);
  const [showHidden, setShowHidden] = createSignal(false);
  const [minMb, setMinMb] = createSignal(10);
  const [presets, setPresets] = createSignal([0, 5, 10, 25, 50, 100]);
  let userCancelled = false;
  const unlisten: UnlistenFn[] = [];

  onMount(async () => {
    unlisten.push(
      await listen<number>("download-progress", (e) => setProgress(e.payload)),
      await listen<string>("download-status", (e) => setStatus(e.payload)),
      await listen<Hit[]>("sniff-hits", (e) => setHits(e.payload)),
      await listen<boolean>("sniff-drm", (e) => setDrm(e.payload)),
      await listen("browse-closed", () => { setBrowsing(false); setSigninOpen(false); }),
      await listen<string>("clipboard-link", (e) => setClip(e.payload)),
    );
    try {
      const s = await fetchSettingsGet();
      setMinMb(s.sniffMinMb);
      if (s.sniffMinMbPresets?.length) setPresets(s.sniffMinMbPresets);
    } catch { /* defaults */ }
  });
  onCleanup(() => unlisten.forEach((u) => u()));

  const busy = () => Boolean(props.disabled) || working();

  function resetForLink() {
    setInfo(null);
    setFormat("");
    setPlaylist(false);
    setError("");
    setNeedsSignin(false);
  }

  async function run(task: () => Promise<FetchResult>, live = false) {
    setError("");
    setNeedsSignin(false);
    setStatus("");
    setProgress(0);
    setWorking(true);
    setRecording(live);
    userCancelled = false;
    try {
      const r = await task();
      await props.onFile(r.path, r);
      setUrl("");
      resetForLink();
      if (browsing()) void browseClose();
    } catch (err) {
      if (userCancelled) return;
      const msg = String(err);
      if (msg.startsWith(SIGNIN_PREFIX)) {
        setNeedsSignin(true);
        setError(msg.slice(SIGNIN_PREFIX.length));
      } else setError(msg);
    } finally {
      setWorking(false);
      setRecording(false);
      setStatus("");
      userCancelled = false;
    }
  }

  const opts = (): DownloadOptions => ({
    format: format() || null,
    playlist: playlist(),
  });

  function submit(e: Event) {
    e.preventDefault();
    const link = url().trim();
    if (!link || busy()) return;
    void run(() => fetchDownload(link, opts()));
  }

  async function probe() {
    const link = url().trim();
    if (!link || busy()) return;
    setError("");
    setProbing(true);
    try {
      setInfo(await fetchProbe(link));
    } catch (err) {
      setError(String(err).replace(SIGNIN_PREFIX, ""));
    } finally {
      setProbing(false);
    }
  }

  function record() {
    const link = url().trim();
    if (!link) return;
    void run(() => fetchDownload(link, { ...opts(), live: true }), true);
  }

  async function cancel() {
    userCancelled = true;
    try { await cancelFetch(); } catch { /* finally in run() resets */ }
  }

  async function browse() {
    const link = url().trim();
    if (!link) return;
    setError("");
    setHits([]);
    setDrm(false);
    setPicked(null);
    setShowHidden(false);
    try {
      await browseOpen(link);
      setBrowsing(true);
    } catch (err) {
      setError(String(err));
    }
  }

  async function signIn() {
    const link = url().trim();
    if (!link) return;
    try {
      await browseOpen(link);
      setBrowsing(true);
      setSigninOpen(true);
    } catch (err) {
      setError(String(err));
    }
  }

  async function saveSignin() {
    try {
      const sites = await browseSaveSignin();
      setSigninOpen(false);
      setNeedsSignin(false);
      void browseClose();
      setStatus(sites.length ? `Saved sign-in for ${sites.join(", ")}. Fetching…` : "");
      const link = url().trim();
      if (link) void run(() => fetchDownload(link, opts()));
    } catch (err) {
      setError(String(err));
    }
  }

  const downloadable = () => hits().filter((h) => h.kind !== "segment");
  const visible = createMemo(() => downloadable().filter((h) => !h.hidden));
  const hidden = createMemo(() => downloadable().filter((h) => h.hidden));
  const selected = createMemo(() => {
    const all = downloadable();
    const p = picked();
    return (p && all.find((h) => h.url === p)) || visible().find((h) => !h.drm) || null;
  });

  async function changeMinMb(mb: number) {
    setMinMb(mb);
    try { await fetchSettingsSet({ sniffMinMb: mb }); } catch (err) { setError(String(err)); }
  }

  const reasonText = (h: Hit) =>
    h.hiddenReason === "ad" ? "ad server" : h.hiddenReason === "short" ? "under 30 s" : `under ${minMb()} MB`;

  const hitRow = (h: Hit) => (
    <label class="smith-fetch-hit" classList={{ "is-selected": selected()?.url === h.url, "is-drm": Boolean(h.drm) }} title={h.url}>
      <input type="radio" name="smith-hit" checked={selected()?.url === h.url} disabled={Boolean(h.drm)}
        onChange={() => setPicked(h.url)} />
      <span class="smith-fetch-hit-text">
        <span class="smith-fetch-hit-facts">{hitFacts(h)}{h.drm ? " · DRM" : ""}</span>
        <span class="smith-fetch-hit-name">{hitName(h)}</span>
      </span>
      <Show when={h.hidden}><span class="smith-fetch-hit-tag">{reasonText(h)}</span></Show>
    </label>
  );

  function downloadSelected() {
    const h = selected();
    if (!h || h.drm) return;
    void run(() => fetchDownloadHit(h, h.live ? { live: true } : undefined), Boolean(h.live));
  }

  return (
    <div class="smith-fetch">
      <Show when={clip()}>
        <div class="smith-toast" role="status">
          <span>Copied link: {clip().length > 60 ? clip().slice(0, 60) + "…" : clip()}</span>
          <button type="button" class="chip" disabled={busy()} onClick={() => {
            const c = clip(); setClip(""); setUrl(c); resetForLink();
            void run(() => fetchDownload(c));
          }}>Fetch</button>
          <button type="button" class="chip" onClick={() => setClip("")}>Dismiss</button>
        </div>
      </Show>

      <form class="url-row" onSubmit={submit}>
        <input
          type="text"
          class="url-input"
          placeholder="https://…"
          aria-label="Video link"
          value={url()}
          onInput={(e) => { setUrl(e.currentTarget.value); resetForLink(); }}
          disabled={busy()}
        />
        <button class="sm-btn" type="submit" disabled={busy() || !url().trim()}>
          {working() && !recording() ? "Downloading…" : "Fetch"}
        </button>
      </form>
      <div class="smith-fetch-actions">
        <button type="button" class="chip" disabled={busy() || probing() || !url().trim()} onClick={() => void probe()}>
          {probing() ? "Checking…" : "Quality & options…"}
        </button>
        <button type="button" class="chip" disabled={busy() || !url().trim()} onClick={() => void browse()}
          title="Open the page in a built-in browser, play the video, then pick it here">
          Browse page…
        </button>
      </div>

      <Show when={info()}>
        {(i) => (
          <div class="smith-fetch-info">
            <Show when={i().title}><div class="smith-fetch-title">{i().title}</div></Show>
            <Show when={i().formats.length > 1}>
              <label class="smith-fetch-field">
                <span>Quality</span>
                <select value={format()} onChange={(e) => setFormat(e.currentTarget.value)} disabled={busy()}>
                  <For each={i().formats}>
                    {(f, idx) => (
                      <option value={idx() === 0 ? "" : f.spec}>
                        {f.label}{f.filesize ? ` (~${fmtSize(f.filesize)})` : ""}
                      </option>
                    )}
                  </For>
                </select>
              </label>
            </Show>
            <Show when={(i().playlistCount ?? 0) > 1}>
              <label class="settings-toggle">
                <input type="checkbox" checked={playlist()} disabled={busy()}
                  onChange={(e) => setPlaylist(e.currentTarget.checked)} />
                <span>Download the whole playlist ({Math.min(i().playlistCount ?? 0, 50)} videos, max 50)</span>
              </label>
            </Show>
            <Show when={i().isLive}>
              <div class="smith-fetch-live">
                <span>This is a live stream.</span>
                <button type="button" class="sm-btn" disabled={busy()} onClick={record}>● Record</button>
              </div>
            </Show>
          </div>
        )}
      </Show>

      <Show when={browsing() && !signinOpen()}>
        <div class="smith-fetch-hits">
          <div class="smith-fetch-hint">
            Play the video in the browser window. Videos it loads appear here.
            <button type="button" class="chip" onClick={() => void browseClose()}>Close browser</button>
          </div>
          <Show when={drm()}>
            <p class="error">This page uses DRM-protected video, which can't be saved.</p>
          </Show>
          <div class="smith-fetch-field smith-fetch-minsize">
            <span>Hide videos under</span>
            <select value={String(minMb())} onChange={(e) => void changeMinMb(Number(e.currentTarget.value))}
              title="Hides detected videos smaller than this, shorter than 30 s, or from ad servers. Nothing is thrown away.">
              <For each={presets()}>{(mb) => <option value={String(mb)}>{minSizeLabel(mb)}</option>}</For>
            </select>
          </div>
          <Show when={downloadable().length} fallback={<p class="smith-fetch-hint">Nothing detected yet.</p>}>
            <div class="smith-fetch-hit-list" role="radiogroup" aria-label="Detected videos, largest first">
              <For each={visible()}>{(h) => hitRow(h)}</For>
              <Show when={!visible().length}>
                <p class="smith-fetch-hint">Everything detected so far looks like an ad or a short clip.</p>
              </Show>
            </div>
            <Show when={hidden().length}>
              <button type="button" class="smith-fetch-hidden-toggle" aria-expanded={showHidden()}
                onClick={() => setShowHidden(!showHidden())}>
                {showHidden() ? "▾" : "▸"} Hidden ({hidden().length}): small or likely ads · {showHidden() ? "hide" : "show all"}
              </button>
              <Show when={showHidden()}>
                <div class="smith-fetch-hit-list is-hidden" role="radiogroup" aria-label="Hidden videos">
                  <For each={hidden()}>{(h) => hitRow(h)}</For>
                </div>
              </Show>
            </Show>
            <div class="smith-fetch-hit-actions">
              <button type="button" class="sm-btn" disabled={busy() || !selected() || Boolean(selected()?.drm)} onClick={downloadSelected}>
                {selected()?.live ? "Record selected" : "Download selected"}
              </button>
              <Show when={selected()}>
                {(h) => <span class="smith-fetch-hint">{fmtSize(h().size) ? `${h().estimated ? "~" : ""}${fmtSize(h().size)}` : ""}</span>}
              </Show>
            </div>
          </Show>
        </div>
      </Show>

      <Show when={signinOpen()}>
        <div class="smith-fetch-hint">
          Sign in on the site in the browser window, then
          <button type="button" class="sm-btn" onClick={() => void saveSignin()}>I'm signed in, save</button>
        </div>
      </Show>

      <Show when={working()}>
        <div class="dl-progress-row">
          <Show when={!recording()} fallback={<span class="dl-progress-pct">● Recording…</span>}>
            <div class="dl-progress">
              <div class="dl-progress-fill" style={{ width: `${Math.round(progress() * 100)}%` }} />
            </div>
            <span class="dl-progress-pct">{Math.round(progress() * 100)}%</span>
          </Show>
          <Show when={recording()}>
            <button type="button" class="dl-cancel" onClick={() => void stopRecording()}>Stop</button>
          </Show>
          <button type="button" class="dl-cancel" onClick={() => void cancel()}>Cancel</button>
        </div>
      </Show>
      <Show when={status()}><p class="smith-fetch-status">{status()}</p></Show>
      <Show when={error()}>
        <p class="error">{error()}</p>
        <Show when={needsSignin()}>
          <button type="button" class="chip" onClick={() => void signIn()}>Sign in to this site…</button>
        </Show>
      </Show>
      <p class="smith-fetch-legal">{LEGAL_NOTE}</p>
    </div>
  );
}
