import { createSignal, For, Show } from "solid-js";
import { listen } from "@tauri-apps/api/event";
import { exportPreview, cancelExport } from "../ipc";
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
  speed,
  setSpeed,
  setPreviewPath,
  setPreviewVersion,
  setPreviewBytes,
  cropEnabled,
  setCropEnabled,
  crop,
  setCrop,
  cropAspect,
  setCropAspect,
  ASPECT_RATIO,
  type CropAspect,
  boomerang,
  setBoomerang,
} from "../state";

const MB = 1024 ** 2;
const RAM_WARN_BYTES = 2 * 1024 ** 3; // 2 GB
const FRAME_WARN = 200; // GIPHY recommends fewer than 200 frames

// Per-platform recommended settings + a size target for the readout.
interface Preset {
  name: string;
  width: number;
  fps: number;
  quality: number;
  limitMb: number;
}
const PRESETS: Preset[] = [
  { name: "Web", width: 480, fps: 12, quality: 80, limitMb: 8 },
  { name: "GIPHY", width: 480, fps: 15, quality: 88, limitMb: 8 },
  { name: "X", width: 640, fps: 24, quality: 90, limitMb: 15 },
  { name: "Discord", width: 540, fps: 20, quality: 88, limitMb: 10 },
];

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

function formatSize(bytes: number): string {
  const mb = bytes / MB;
  return mb >= 100 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}

export default function ExportPanel() {
  const [exporting, setExporting] = createSignal(false);
  const [progress, setProgress] = createSignal(0);
  const [error, setError] = createSignal<string | null>(null);
  const [activePreset, setActivePreset] = createSignal<string | null>(null);
  const [limitMb, setLimitMb] = createSignal<number | null>(null);
  // Set just before requesting cancellation so the resulting error is swallowed.
  let userCancelled = false;

  function applyPreset(p: Preset) {
    setWidth(p.width);
    setFps(p.fps);
    setQuality(p.quality);
    setLimitMb(p.limitMb);
    setActivePreset(p.name);
  }

  // Frames in one forward pass, matching the encoder's (duration / speed) * fps:
  // slowing the clip (speed < 1) stretches it into more frames, speeding it up
  // into fewer. Every frame-count metric below derives from this.
  const baseFrameCount = () => {
    const dur = Math.max(0, outPoint() - inPoint());
    const s = speed() > 0 ? speed() : 1;
    return Math.max(1, Math.round((dur / s) * fps()));
  };

  // Output frame count (boomerang adds the reversed pass, minus the two seams).
  const frameCount = () => {
    const base = baseFrameCount();
    return boomerang() ? Math.max(1, 2 * base - 2) : base;
  };

  // Rough size estimate (GIF size is very content-dependent). The real size is
  // shown after export. ~bytes per output pixel-frame, scaled by quality.
  const estBytes = () => {
    const ow = Math.floor(width() / 2) * 2;
    const factor = 0.12 + (quality() / 100) * 0.3;
    return frameCount() * ow * outHeight() * factor;
  };

  const overTarget = () => {
    const l = limitMb();
    return frameCount() > FRAME_WARN || (l != null && estBytes() > l * MB);
  };

  // Effective input dimensions: the crop region when cropping, else the source.
  const inputDims = () => {
    const m = meta();
    const c = crop();
    if (cropEnabled() && c && c.w > 0 && c.h > 0) return { w: c.w, h: c.h };
    return m ? { w: m.width, h: m.height } : { w: 0, h: 0 };
  };

  // Output height, derived from the input aspect at the chosen width (preview).
  // Filled-track percent for a slider value (drives the --val CSS var).
  const pctOf = (v: number, min: number, max: number) =>
    `${((v - min) / (max - min)) * 100}%`;

  const outHeight = () => {
    const d = inputDims();
    if (d.w === 0) return 0;
    const h = Math.round((d.h * width()) / d.w);
    return h - (h % 2);
  };

  // Estimated peak RAM for a boomerang: the encoder buffers one full forward
  // pass (speed-adjusted) in memory before feeding it forward then reversed.
  const boomerangRamBytes = () => {
    const ow = Math.floor(width() / 2) * 2;
    const oh = outHeight();
    return baseFrameCount() * ow * oh * 4;
  };

  function toggleCrop(on: boolean) {
    setCropEnabled(on);
    setCropAspect("free");
    const m = meta();
    if (on && !crop() && m) {
      setCrop({ x: 0, y: 0, w: m.width, h: m.height });
    }
  }

  // Largest centered rectangle of the given aspect ratio (w/h) within the source.
  function fitAspect(ratio: number) {
    const m = meta();
    if (!m) return null;
    let w = Math.min(m.width, m.height * ratio);
    let h = w / ratio;
    if (h > m.height) {
      h = m.height;
      w = h * ratio;
    }
    return {
      x: Math.round((m.width - w) / 2),
      y: Math.round((m.height - h) / 2),
      w: Math.round(w),
      h: Math.round(h),
    };
  }

  // Toggle a locked aspect: re-clicking the active one returns to free-form.
  function chooseAspect(mode: Exclude<CropAspect, "free">) {
    if (cropAspect() === mode) {
      setCropAspect("free");
      return;
    }
    setCropAspect(mode);
    const fitted = fitAspect(ASPECT_RATIO[mode]);
    if (fitted) setCrop(fitted);
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
    userCancelled = false;
    const unlisten = await listen<number>("export-progress", (e) =>
      setProgress(e.payload),
    );
    try {
      const res = await exportPreview({
        inputPath: input,
        startSecs: inPoint(),
        endSecs: outPoint(),
        fps: fps(),
        width: width(),
        quality: quality(),
        srcWidth: m.width,
        srcHeight: m.height,
        crop: cropPayload(),
        speed: speed(),
        boomerang: boomerang(),
      });
      setPreviewVersion((v) => v + 1);
      setPreviewBytes(res.bytes);
      setPreviewPath(res.path);
    } catch (e) {
      // A user-requested cancel surfaces as the "cancelled" error; ignore it.
      if (!userCancelled) setError(String(e));
    } finally {
      unlisten();
      setExporting(false);
      userCancelled = false;
    }
  }

  async function abortExport() {
    userCancelled = true;
    try {
      await cancelExport();
    } catch {
      // The export task itself reports completion via doExport's finally block.
    }
  }

  return (
    <section class="export-panel">
      <div class="presets">
        <span class="presets-label">Optimize for</span>
        <For each={PRESETS}>
          {(p) => (
            <button
              type="button"
              class="preset"
              classList={{ active: activePreset() === p.name }}
              onClick={() => applyPreset(p)}
            >
              {p.name}
            </button>
          )}
        </For>
      </div>

      <label class="crop-toggle">
        <input
          type="checkbox"
          checked={cropEnabled()}
          onChange={(e) => toggleCrop(e.currentTarget.checked)}
        />
        Crop
      </label>
      <Show when={cropEnabled()}>
        <div class="aspect-row">
          <label class="crop-toggle">
            <input
              type="checkbox"
              checked={cropAspect() === "landscape"}
              onChange={() => chooseAspect("landscape")}
            />
            Landscape
          </label>
          <label class="crop-toggle">
            <input
              type="checkbox"
              checked={cropAspect() === "portrait"}
              onChange={() => chooseAspect("portrait")}
            />
            Portrait
          </label>
          <label class="crop-toggle">
            <input
              type="checkbox"
              checked={cropAspect() === "square"}
              onChange={() => chooseAspect("square")}
            />
            Square
          </label>
        </div>
      </Show>

      <label class="crop-toggle">
        <input
          type="checkbox"
          checked={boomerang()}
          onChange={(e) => setBoomerang(e.currentTarget.checked)}
        />
        Boomerang
      </label>
      <Show when={boomerang()}>
        <p
          class="bounce-note"
          classList={{ warn: boomerangRamBytes() > RAM_WARN_BYTES }}
        >
          Buffers ~{formatBytes(boomerangRamBytes())} in RAM
          {boomerangRamBytes() > RAM_WARN_BYTES ? " (over 2 GB)" : ""}
        </p>
      </Show>

      <div class="settings-grid">
        <div class="setting">
          <label for="fps">FPS</label>
        <input
          id="fps"
          type="range"
          min={5}
          max={30}
          step={1}
          value={fps()}
          style={{ "--val": pctOf(fps(), 5, 30) }}
          onInput={(e) => {
            setActivePreset(null);
            setFps(e.currentTarget.valueAsNumber);
          }}
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
          style={{ "--val": pctOf(width(), 240, 1080) }}
          onInput={(e) => {
            setActivePreset(null);
            setWidth(e.currentTarget.valueAsNumber);
          }}
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
          style={{ "--val": pctOf(quality(), 1, 100) }}
          onInput={(e) => {
            setActivePreset(null);
            setQuality(e.currentTarget.valueAsNumber);
          }}
        />
        <span class="setting-value">{quality()}</span>
      </div>

      <div class="setting">
        <label for="speed">Speed</label>
        <input
          id="speed"
          type="range"
          min={0.5}
          max={2}
          step={0.25}
          value={speed()}
          style={{ "--val": pctOf(speed(), 0.5, 2) }}
          onInput={(e) => setSpeed(e.currentTarget.valueAsNumber)}
        />
        <span class="setting-value">{speed().toFixed(2)}x</span>
        </div>
      </div>

      <p class="export-metrics" classList={{ caution: overTarget() }}>
        <Show when={meta()} fallback="">
          {frameCount()} frames &middot; ~{formatSize(estBytes())} est.
          <Show when={limitMb()}>
            {(l) => <span> &middot; limit {l()} MB</span>}
          </Show>
        </Show>
      </p>

      <button
        type="button"
        class="primary export"
        onClick={doExport}
        disabled={exporting()}
      >
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
          <button type="button" class="cancel" onClick={abortExport}>
            Cancel
          </button>
        </div>
      </Show>
      <Show when={error()}>
        <p class="error">{error()}</p>
      </Show>
    </section>
  );
}
