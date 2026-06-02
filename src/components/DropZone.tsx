import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { listen } from "@tauri-apps/api/event";
import { probeVideo, downloadVideo } from "../ipc";
import { setFilePath, setMeta } from "../state";

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
export default function DropZone() {
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [dragOver, setDragOver] = createSignal(false);
  const [url, setUrl] = createSignal("");
  const [downloading, setDownloading] = createSignal(false);
  const [dlProgress, setDlProgress] = createSignal(0);

  // Probe a path and store it. Shared by every load path.
  async function load(path: string) {
    setLoading(true);
    setError(null);
    setFilePath(path);
    setMeta(null);
    try {
      setMeta(await probeVideo(path));
    } catch (e) {
      setError(String(e));
      setFilePath(null);
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

  async function loadFromUrl(e: Event) {
    e.preventDefault();
    const link = url().trim();
    if (!link || downloading()) return;

    setError(null);
    setDlProgress(0);
    setDownloading(true);
    const unlisten = await listen<number>("download-progress", (ev) =>
      setDlProgress(ev.payload),
    );
    try {
      const path = await downloadVideo(link);
      await load(path);
      setUrl("");
    } catch (err) {
      setError(String(err));
    } finally {
      unlisten();
      setDownloading(false);
    }
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

  const busy = () => loading() || downloading();

  return (
    <section class="dropzone-wrap">
      <div class="dropzone" classList={{ "drag-over": dragOver() }}>
        <button type="button" onClick={pick} disabled={busy()}>
          {loading() ? "Reading video..." : "Open video"}
        </button>
        <span class="dropzone-hint">or drop a video here</span>
      </div>

      <form class="url-row" onSubmit={loadFromUrl}>
        <input
          type="text"
          class="url-input"
          placeholder="or paste a video URL (YouTube, etc.)"
          value={url()}
          onInput={(e) => setUrl(e.currentTarget.value)}
          disabled={busy()}
        />
        <button type="submit" disabled={busy() || !url().trim()}>
          {downloading() ? "Downloading..." : "Load"}
        </button>
      </form>

      <Show when={downloading()}>
        <div class="progress-row">
          <div
            class="progress"
            style={{ "--p": `${Math.round(dlProgress() * 100)}%` }}
          >
            <div class="progress-fill" />
          </div>
          <span class="progress-pct">{Math.round(dlProgress() * 100)}%</span>
        </div>
      </Show>
      <Show when={error()}>
        <p class="error">{error()}</p>
      </Show>
    </section>
  );
}
