import { createSignal, Show } from "solid-js";
import { save } from "@tauri-apps/plugin-dialog";
import { exportGif } from "../ipc";
import { filePath, meta, inPoint, outPoint } from "../state";

// Fixed MVP settings (Step 7). FPS / width / quality become sliders in Step 8.
const MVP_FPS = 15;
const MVP_WIDTH = 480;

export default function ExportPanel() {
  const [exporting, setExporting] = createSignal(false);
  const [status, setStatus] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  async function doExport() {
    const input = filePath();
    const m = meta();
    if (!input || !m) return;

    setStatus(null);
    setError(null);

    let dest: string | null;
    try {
      dest = await save({
        filters: [{ name: "GIF", extensions: ["gif"] }],
        defaultPath: "export.gif",
      });
    } catch (e) {
      setError(String(e));
      return;
    }
    if (!dest) return; // user cancelled

    setExporting(true);
    try {
      await exportGif({
        inputPath: input,
        outputPath: dest,
        startSecs: inPoint(),
        endSecs: outPoint(),
        fps: MVP_FPS,
        width: MVP_WIDTH,
        srcWidth: m.width,
        srcHeight: m.height,
      });
      setStatus(`Saved to ${dest}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setExporting(false);
    }
  }

  return (
    <section class="export-panel">
      <button type="button" onClick={doExport} disabled={exporting()}>
        {exporting() ? "Exporting..." : "Export GIF"}
      </button>
      <Show when={status()}>
        <p class="status">{status()}</p>
      </Show>
      <Show when={error()}>
        <p class="error">{error()}</p>
      </Show>
    </section>
  );
}
