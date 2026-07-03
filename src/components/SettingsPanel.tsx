import { Show, createSignal, onMount, onCleanup } from "solid-js";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { setSettingsOpen } from "../state";
import {
  updateStatus,
  updateInfo,
  updateError,
  runUpdateCheck,
  checkOnStartupEnabled,
  setCheckOnStartup,
} from "../update";

/**
 * Settings popover anchored under the header gearwheel. Shows the app version, a
 * "Check for updates" button that surfaces checking / up-to-date / update-available
 * states, and an opt-in "check on startup" toggle. Prompt-only: an available
 * update shows the release notes and a Download button that opens the release
 * page in the browser. Nothing is ever downloaded or installed in-app.
 */
export default function SettingsPanel() {
  const [version, setVersion] = createSignal("");
  const [startup, setStartup] = createSignal(checkOnStartupEnabled());
  let root: HTMLDivElement | undefined;

  onMount(() => {
    // App version for the header line (independent of any update check).
    void getVersion()
      .then(setVersion)
      .catch(() => setVersion(""));

    // Close on a click anywhere outside the popover.
    const onPointerDown = (e: PointerEvent) => {
      if (root && !root.contains(e.target as Node)) setSettingsOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    onCleanup(() => document.removeEventListener("pointerdown", onPointerDown));
  });

  const onToggleStartup = (e: Event) => {
    const on = (e.currentTarget as HTMLInputElement).checked;
    setStartup(on);
    setCheckOnStartup(on);
  };

  const openRelease = () => {
    const info = updateInfo();
    if (info) void openUrl(info.url).catch(() => undefined);
  };

  return (
    <div class="settings-panel" ref={root} role="dialog" aria-label="Settings">
      <p class="settings-version">
        GifSmith <span class="settings-version-num">v{version() || "…"}</span>
      </p>

      <div class="settings-update">
        <button
          type="button"
          class="settings-check"
          disabled={updateStatus() === "checking"}
          onClick={() => void runUpdateCheck()}
        >
          {updateStatus() === "checking" ? "Checking…" : "Check for updates"}
        </button>

        <Show when={updateStatus() === "current"}>
          <p class="settings-status">You're up to date.</p>
        </Show>
        <Show when={updateStatus() === "error"}>
          <p class="settings-status error">{updateError()}</p>
        </Show>
        <Show when={updateStatus() === "available" && updateInfo()}>
          {(info) => (
            <div class="settings-available">
              <p class="settings-status">
                Version <strong>{info().latest}</strong> is available.
              </p>
              <Show when={info().notes.trim()}>
                <pre class="settings-notes">{info().notes}</pre>
              </Show>
              <button type="button" class="primary" onClick={openRelease}>
                Download
              </button>
            </div>
          )}
        </Show>
      </div>

      <label class="settings-startup">
        <input
          type="checkbox"
          checked={startup()}
          onChange={onToggleStartup}
        />
        Check for updates on startup
      </label>
    </div>
  );
}
