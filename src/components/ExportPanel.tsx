import { createSignal, Show } from "solid-js";
import { save } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { exportGif } from "../ipc";
import {
  filePath,
  meta,
  inPoint,
  outPoint,
  fps,
  setFps,
  width,
  setWidth,
  quality,
  setQuality,
} from "../state";

export default function ExportPanel() {
  const [exporting, setExporting] = createSignal(false);
  const [progress, setProgress] = createSignal(0);
  const [status, setStatus] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  // Output height, derived from source aspect at the chosen width (preview).
  const outHeight = () => {
    const m = meta();
    if (!m || m.width === 0) return 0;
    const h = Math.round((m.height * width()) / m.width);
    return h - (h % 2);
  };

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

    setProgress(0);
    setExporting(true);
    const unlisten = await listen<number>("export-progress", (e) =>
      setProgress(e.payload),
    );
    try {
      await exportGif({
        inputPath: input,
        outputPath: dest,
        startSecs: inPoint(),
        endSecs: outPoint(),
        fps: fps(),
        width: width(),
        quality: quality(),
        srcWidth: m.width,
        srcHeight: m.height,
      });
      setStatus(`Saved to ${dest}`);
    } catch (e) {
      setError(String(e));
    } finally {
      unlisten();
      setExporting(false);
    }
  }

  return (
    <section class="export-panel">
      <div class="setting">
        <label for="fps">FPS</label>
        <input
          id="fps"
          type="range"
          min={5}
          max={30}
          step={1}
          value={fps()}
          onInput={(e) => setFps(e.currentTarget.valueAsNumber)}
        />
        <span class="setting-value">{fps()}</span>
      </div>

      <div class="setting">
        <label for="width">Width</label>
        <input
          id="width"
          type="range"
          min={240}
          max={1080}
          step={10}
          value={width()}
          onInput={(e) => setWidth(e.currentTarget.valueAsNumber)}
        />
        <span class="setting-value">
          {width()}&times;{outHeight()}
        </span>
      </div>

      <div class="setting">
        <label for="quality">Quality</label>
        <input
          id="quality"
          type="range"
          min={1}
          max={100}
          step={1}
          value={quality()}
          onInput={(e) => setQuality(e.currentTarget.valueAsNumber)}
        />
        <span class="setting-value">{quality()}</span>
      </div>

      <button type="button" onClick={doExport} disabled={exporting()}>
        {exporting() ? "Exporting..." : "Export GIF"}
      </button>
      <Show when={exporting()}>
        <div class="progress-row">
          <div
            class="progress"
            style={{ "--p": `${Math.round(progress() * 100)}%` }}
          >
            <div class="progress-fill" />
          </div>
          <span class="progress-pct">{Math.round(progress() * 100)}%</span>
        </div>
      </Show>
      <Show when={status()}>
        <p class="status">{status()}</p>
      </Show>
      <Show when={error()}>
        <p class="error">{error()}</p>
      </Show>
    </section>
  );
}
