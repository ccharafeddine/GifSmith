import { createEffect, createSignal, Show } from "solid-js";
import { convertFileSrc } from "@tauri-apps/api/core";
import { generateProxy } from "../ipc";
import {
  filePath,
  meta,
  currentTime,
  setCurrentTime,
  inPoint,
  setInPoint,
  outPoint,
  setOutPoint,
  setVideoEl,
  setViewStart,
  setViewEnd,
  setCropEnabled,
  setCrop,
  setCropAspect,
  setBoomerang,
  playing,
  videoEl,
  speed,
} from "../state";
import { formatTimecode } from "../format";
import {
  togglePlayback,
  onPlaybackTime,
  onPlaybackEnded,
  resetPlayback,
} from "../playback";
import Timeline from "./Timeline";
import CropOverlay from "./CropOverlay";

/**
 * Plays the loaded source video via the asset protocol. Play/pause toggle plus
 * an iOS-style trim Timeline. Loop/boomerang logic lives in ../playback.
 */
export default function VideoPlayer() {
  // When the webview can't decode the file's codec (e.g. HEVC/ProRes), ffmpeg
  // transcodes a lightweight H.264 proxy that playback uses instead. Export
  // always uses the original.
  const [proxySrc, setProxySrc] = createSignal<string | null>(null);
  const [proxyBuilding, setProxyBuilding] = createSignal(false);
  const [proxyFailed, setProxyFailed] = createSignal(false);

  const src = () => {
    const proxy = proxySrc();
    if (proxy) return proxy;
    const p = filePath();
    return p ? convertFileSrc(p) : "";
  };

  function onVideoError() {
    // Already showing a proxy and it still errors: give up.
    if (proxySrc()) {
      setProxyFailed(true);
      return;
    }
    if (proxyBuilding()) return;
    const p = filePath();
    if (!p) return;
    setProxyBuilding(true);
    setProxyFailed(false);
    generateProxy(p)
      .then((proxyPath) => setProxySrc(convertFileSrc(proxyPath)))
      .catch(() => setProxyFailed(true))
      .finally(() => setProxyBuilding(false));
  }

  // New source: reset transport, trim, zoom, crop, and bounce to defaults.
  createEffect(() => {
    const m = meta();
    const dur = m ? m.duration_secs : 0;
    setProxySrc(null);
    setProxyBuilding(false);
    setProxyFailed(false);
    resetPlayback();
    setCurrentTime(0);
    setInPoint(0);
    setOutPoint(dur);
    setViewStart(0);
    setViewEnd(dur);
    setCropEnabled(false);
    setCrop(null);
    setCropAspect("free");
    setBoomerang(false);
  });

  // Keep the preview's forward playback rate in sync with the export speed.
  createEffect(() => {
    const v = videoEl();
    const s = speed();
    if (v) v.playbackRate = s;
  });

  const selectionLength = () => Math.max(0, outPoint() - inPoint());

  const aspect = () => {
    const m = meta();
    return m && m.height > 0 ? `${m.width}/${m.height}` : "16/9";
  };

  return (
    <section class="player" style={{ "--aspect": aspect() }}>
      <div class="stage">
        <video
          ref={(el) => setVideoEl(el)}
          src={src()}
          onTimeUpdate={(e) => onPlaybackTime(e.currentTarget.currentTime)}
          onEnded={onPlaybackEnded}
          onError={onVideoError}
        />
        <Show when={proxyBuilding()}>
          <div class="stage-msg">
            <p>Preparing preview...</p>
            <p class="stage-msg-sub">
              Transcoding a lightweight copy so this codec plays here. Export
              uses the original.
            </p>
          </div>
        </Show>
        <Show when={proxyFailed()}>
          <div class="stage-msg">
            <p>Can't preview this codec in the window (e.g. HEVC / ProRes).</p>
            <p class="stage-msg-sub">
              Trimming and export still work, the timeline thumbnails and the
              GIF are built with FFmpeg.
            </p>
          </div>
        </Show>
        <CropOverlay />
      </div>
      <Timeline />
      <div class="controls">
        <button type="button" onClick={togglePlayback}>
          {playing() ? "Pause" : "Play"}
        </button>
        <span class="time">
          {formatTimecode(currentTime())} /{" "}
          {formatTimecode(meta()?.duration_secs ?? 0)}
        </span>
        <span class="selection-len">
          Selection {selectionLength().toFixed(1)}s
        </span>
      </div>
    </section>
  );
}
