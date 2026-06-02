import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { probeVideo } from "../ipc";
import { setFilePath, setMeta } from "../state";

// Extensions GifSmith accepts (file dialog filter + drag-and-drop allowlist).
const VIDEO_EXTENSIONS = ["mp4", "mov", "mkv", "webm", "avi", "m4v"];

function hasAllowedExtension(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return VIDEO_EXTENSIONS.includes(ext);
}

/**
 * Picker for the source video. Opens via the native dialog or a window file
 * drop, then probes the selection and stores path + metadata in shared state.
 * Handles cancel, loading, and error states.
 */
export default function DropZone() {
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [dragOver, setDragOver] = createSignal(false);

  // Probe a path and store it. Shared by the dialog and drag-and-drop.
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

    // Null = user cancelled. Array is impossible with multiple:false, but the
    // union type allows it, so narrow defensively.
    if (typeof selected !== "string") return;
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

  return (
    <section class="dropzone" classList={{ "drag-over": dragOver() }}>
      <button type="button" onClick={pick} disabled={loading()}>
        {loading() ? "Reading video..." : "Open video"}
      </button>
      <span class="dropzone-hint">or drop a video here</span>
      <Show when={error()}>
        <p class="error">{error()}</p>
      </Show>
    </section>
  );
}
