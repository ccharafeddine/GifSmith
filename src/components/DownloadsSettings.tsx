import { createResource, createSignal, For, Show } from "solid-js";
import { open } from "@tauri-apps/plugin-dialog";
import {
  cookiesForget, cookiesImport, cookiesList, fetchSettingsGet, fetchSettingsSet,
  minSizeLabel, toolsStatus, toolsUpdateNow, LEGAL_NOTE,
} from "../fetch";

// Settings → Downloads (desktop only; the parent gates it with isTauri()).
export default function DownloadsSettings() {
  const [settings, { mutate }] = createResource(fetchSettingsGet);
  const [sites, { refetch: refetchSites }] = createResource(cookiesList);
  const [tools, { refetch: refetchTools }] = createResource(toolsStatus);
  const [updating, setUpdating] = createSignal(false);
  const [msg, setMsg] = createSignal("");

  const set = async (patch: Parameters<typeof fetchSettingsSet>[0]) => {
    try { mutate(await fetchSettingsSet(patch)); } catch (e) { setMsg(String(e)); }
  };

  async function importCookies() {
    const file = await open({ multiple: false, directory: false, filters: [{ name: "cookies.txt", extensions: ["txt"] }] });
    if (typeof file !== "string") return;
    try {
      const s = await cookiesImport(file);
      setMsg(s.length ? `Imported cookies for ${s.join(", ")}.` : "No cookies found in that file.");
      void refetchSites();
    } catch (e) { setMsg(String(e)); }
  }

  async function updateNow() {
    setUpdating(true);
    setMsg("");
    try {
      const r = await toolsUpdateNow();
      setMsg(r.updated ? `Updated the downloader to ${r.version}.` : `The downloader is up to date (${r.version ?? "unknown"}).`);
      void refetchTools();
    } catch (e) { setMsg(String(e)); } finally { setUpdating(false); }
  }

  const unreliable = () => settings()?.browsers.find((b) => b.id === settings()?.browserCookies)?.unreliable;

  return (
    <div class="field smith-dl-settings">
      <span class="field-label">Downloads</span>

      <label class="smith-fetch-field">
        <span>Use cookies from browser</span>
        <select value={settings()?.browserCookies ?? ""} onChange={(e) => void set({ browserCookies: e.currentTarget.value })}>
          <option value="">Off</option>
          <For each={settings()?.browsers ?? []}>
            {(b) => <option value={b.id}>{b.id}{b.unreliable ? " (may not work on Windows)" : ""}</option>}
          </For>
        </select>
      </label>
      <Show when={unreliable()}>
        <p class="settings-update-status is-error">
          This browser encrypts its cookies on Windows, so reading them usually fails. Use Firefox, a cookies.txt file, or "Sign in to this site…" instead.
        </p>
      </Show>

      <label class="smith-fetch-field" title="Browse page: hide detected videos smaller than this, shorter than 30 s, or from ad servers. Hidden ones stay one click away.">
        <span>Hide videos under</span>
        <select value={String(settings()?.sniffMinMb ?? 5)} onChange={(e) => void set({ sniffMinMb: Number(e.currentTarget.value) })}>
          <For each={settings()?.sniffMinMbPresets ?? [0, 5, 10, 25, 50, 100]}>
            {(mb) => <option value={String(mb)}>{minSizeLabel(mb)}</option>}
          </For>
        </select>
      </label>

      <div class="smith-fetch-field">
        <span>Saved sign-ins</span>
        <button type="button" class="chip" onClick={() => void importCookies()}>Import cookies.txt…</button>
      </div>
      <Show when={(sites() ?? []).length} fallback={<p class="smith-fetch-hint">None saved.</p>}>
        <ul class="smith-sites">
          <For each={sites()}>
            {(s) => (
              <li>
                <span>{s.site} ({s.cookies} cookies)</span>
                <button type="button" class="chip" onClick={async () => { await cookiesForget(s.site); void refetchSites(); }}>Forget</button>
              </li>
            )}
          </For>
        </ul>
      </Show>

      <label class="settings-toggle">
        <input type="checkbox" checked={settings()?.autoUpdate ?? true}
          onChange={(e) => void set({ autoUpdate: e.currentTarget.checked })} />
        <span>Keep the downloader (yt-dlp) up to date automatically</span>
      </label>
      <div class="settings-update-row">
        <span class="smith-fetch-hint">
          yt-dlp {tools()?.ytdlpVersion ?? "…"} ({tools()?.ytdlpSource ?? ""})
          <Show when={tools()?.denoVersion}> · Deno {tools()?.denoVersion}</Show>
        </span>
        <button type="button" class="chip" disabled={updating()} onClick={() => void updateNow()}>
          {updating() ? "Updating…" : "Update now"}
        </button>
      </div>

      <label class="settings-toggle">
        <input type="checkbox" checked={settings()?.clipboardWatch ?? false}
          onChange={(e) => void set({ clipboardWatch: e.currentTarget.checked })} />
        <span>Offer to download video links I copy</span>
      </label>

      <Show when={msg()}><p class="smith-fetch-status">{msg()}</p></Show>
      <p class="smith-fetch-legal">{LEGAL_NOTE}</p>
    </div>
  );
}
