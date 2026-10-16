import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { isTauri } from "@tauri-apps/api/core";
import LinkImport from "./LinkImport";
import "../fetch.css";
import { loadSource } from "../source";

// Extensions GifSmith accepts (file dialog filter + drag-and-drop allowlist).
const VIDEO_EXTENSIONS = ["mp4", "mov", "mkv", "webm", "avi", "m4v"];

function hasAllowedExtension(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return VIDEO_EXTENSIONS.includes(ext);
}

/**
 * Source loader: open via the native dialog, a window file drop, or a URL
 * (downloaded with yt-dlp). Probes the result and stores path + metadata.
 */
export default function DropZone(props: { compact?: boolean } = {}) {
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [dragOver, setDragOver] = createSignal(false);

  // Probe a path and store it. Shared by every load path.
  async function load(path: string) {
    setLoading(true);
    setError(null);
    try {
      await loadSource(path);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function pick() {
    setError(null);
    let selected: string | string[] | null;
    try {
      selected = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "Video", extensions: VIDEO_EXTENSIONS }],
      });
    } catch (e) {
      setError(String(e));
      return;
    }
    if (typeof selected !== "string") return; // cancelled
    await load(selected);
  }

  onMount(() => {
    const unlistenPromise = getCurrentWebview().onDragDropEvent((event) => {
      const p = event.payload;
      if (p.type === "enter" || p.type === "over") {
        setDragOver(true);
      } else if (p.type === "leave") {
        setDragOver(false);
      } else if (p.type === "drop") {
        setDragOver(false);
        const path = p.paths[0];
        if (!path) return;
        if (!hasAllowedExtension(path)) {
          setError("Unsupported file type. Use mp4, mov, mkv, webm, avi, or m4v.");
          return;
        }
        void load(path);
      }
    });
    onCleanup(() => {
      void unlistenPromise.then((unlisten) => unlisten());
    });
  });

  const busy = () => loading();

  if (props.compact) {
    return (
      <button type="button" class="sm-btn sm-btn--sm" onClick={pick} disabled={busy()}>
        {loading() ? "Reading…" : "Open video…"}
      </button>
    );
  }
  return (
    <div class="loader sm-panel smith-drop" classList={{ "drag-over": dragOver() }}>
      <div class="sm-empty__art" aria-hidden="true">GIF</div>
      <h3 class="smith-drop-title">Turn a video into a GIF</h3>
      <p class="smith-drop-sub">Pick a moment, crop it and export a looping or boomerang GIF. Local files never leave this computer.</p>
      <button type="button" class="sm-btn sm-btn--primary sm-btn--lg" onClick={pick} disabled={busy()}>
        {loading() ? "Reading…" : "Open video…"}
      </button>
      <p class="smith-drop-formats">{VIDEO_EXTENSIONS.map((e) => e.toUpperCase()).join(" · ")} · or drop a file anywhere</p>

      {/* Link downloads are desktop-only; the web demo only opens local files. */}
      <Show when={isTauri()}>
        <div class="smith-or"><span>or paste a link · optional, needs internet</span></div>
        <LinkImport disabled={loading()} onFile={(path) => load(path)} />
      </Show>
      <Show when={error()}>
        <p class="error">{error()}</p>
      </Show>
    </div>
  );
}
