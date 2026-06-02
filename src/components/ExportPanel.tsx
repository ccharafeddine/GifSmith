import { createSignal, Show } from "solid-js";
import { listen } from "@tauri-apps/api/event";
import { exportPreview } from "../ipc";
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
  setPreviewPath,
  setPreviewVersion,
  cropEnabled,
  setCropEnabled,
  crop,
  setCrop,
  bounce,
  setBounce,
} from "../state";

const RAM_WARN_BYTES = 2 * 1024 ** 3; // 2 GB

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

export default function ExportPanel() {
  const [exporting, setExporting] = createSignal(false);
  const [progress, setProgress] = createSignal(0);
  const [error, setError] = createSignal<string | null>(null);

  // Effective input dimensions: the crop region when cropping, else the source.
  const inputDims = () => {
    const m = meta();
    const c = crop();
    if (cropEnabled() && c && c.w > 0 && c.h > 0) return { w: c.w, h: c.h };
    return m ? { w: m.width, h: m.height } : { w: 0, h: 0 };
  };

  // Output height, derived from the input aspect at the chosen width (preview).
  const outHeight = () => {
    const d = inputDims();
    if (d.w === 0) return 0;
    const h = Math.round((d.h * width()) / d.w);
    return h - (h % 2);
  };

  // Estimated peak RAM for a bounce: all output frames buffered at once.
  const bounceRamBytes = () => {
    const ow = Math.floor(width() / 2) * 2;
    const oh = outHeight();
    const frames = Math.max(
      1,
      Math.round((outPoint() - inPoint()) * fps()),
    );
    return frames * ow * oh * 4;
  };

  function toggleCrop(on: boolean) {
    setCropEnabled(on);
    const m = meta();
    if (on && !crop() && m) {
      setCrop({ x: 0, y: 0, w: m.width, h: m.height });
    }
  }

  // Crop payload for export: rounded ints, or null when off / full-frame.
  function cropPayload() {
    const m = meta();
    const c = crop();
    if (!cropEnabled() || !c || !m) return null;
    const x = Math.round(c.x);
    const y = Math.round(c.y);
    const w = Math.round(c.w);
    const h = Math.round(c.h);
    if (x <= 0 && y <= 0 && w >= m.width && h >= m.height) return null;
    return { x, y, w, h };
  }

  async function doExport() {
    const input = filePath();
    const m = meta();
    if (!input || !m) return;

    setError(null);
    setProgress(0);
    setExporting(true);
    const unlisten = await listen<number>("export-progress", (e) =>
      setProgress(e.payload),
    );
    try {
      const tempPath = await exportPreview({
        inputPath: input,
        startSecs: inPoint(),
        endSecs: outPoint(),
        fps: fps(),
        width: width(),
        quality: quality(),
        srcWidth: m.width,
        srcHeight: m.height,
        crop: cropPayload(),
        bounce: bounce(),
      });
      setPreviewVersion((v) => v + 1);
      setPreviewPath(tempPath);
    } catch (e) {
      setError(String(e));
    } finally {
      unlisten();
      setExporting(false);
    }
  }

  return (
    <section class="export-panel">
      <label class="crop-toggle">
        <input
          type="checkbox"
          checked={cropEnabled()}
          onChange={(e) => toggleCrop(e.currentTarget.checked)}
        />
        Crop
      </label>

      <label class="crop-toggle">
        <input
          type="checkbox"
          checked={bounce()}
          onChange={(e) => setBounce(e.currentTarget.checked)}
        />
        Bounce
      </label>
      <Show when={bounce()}>
        <p
          class="bounce-note"
          classList={{ warn: bounceRamBytes() > RAM_WARN_BYTES }}
        >
          Buffers ~{formatBytes(bounceRamBytes())} in RAM
          {bounceRamBytes() > RAM_WARN_BYTES ? " (over 2 GB)" : ""}
        </p>
      </Show>

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
      <Show when={error()}>
        <p class="error">{error()}</p>
      </Show>
    </section>
  );
}
