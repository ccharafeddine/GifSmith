import { createSignal, Show } from "solid-js";
import { open } from "@tauri-apps/plugin-dialog";
import { probeVideo } from "../ipc";
import { setFilePath, setMeta } from "../state";

// Extensions GifSmith accepts. Mirrors the drag-and-drop allowlist (Step 14).
const VIDEO_EXTENSIONS = ["mp4", "mov", "mkv", "webm", "avi", "m4v"];

/**
 * Picker for the source video. Opens the native file dialog, then probes the
 * selection and stores path + metadata in shared state. Handles cancel,
 * loading, and error states.
 */
export default function DropZone() {
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

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

    setLoading(true);
    setFilePath(selected);
    setMeta(null);
    try {
      setMeta(await probeVideo(selected));
    } catch (e) {
      setError(String(e));
      setFilePath(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <section class="dropzone">
      <button type="button" onClick={pick} disabled={loading()}>
        {loading() ? "Reading video..." : "Open video"}
      </button>
      <Show when={error()}>
        <p class="error">{error()}</p>
      </Show>
    </section>
  );
}
