import { createEffect, createSignal } from "solid-js";
import { convertFileSrc } from "@tauri-apps/api/core";
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
} from "../state";
import { formatTimecode } from "../format";
import Timeline from "./Timeline";

/**
 * Plays the loaded source video via the asset protocol. Play/pause toggle plus
 * an iOS-style trim Timeline; playback loops between the IN and OUT points.
 */
export default function VideoPlayer() {
  let videoEl: HTMLVideoElement | undefined;
  const [playing, setPlaying] = createSignal(false);

  const src = () => {
    const p = filePath();
    return p ? convertFileSrc(p) : "";
  };

  // New source: reset transport and reset the trim to the whole clip.
  createEffect(() => {
    const m = meta();
    setPlaying(false);
    setCurrentTime(0);
    setInPoint(0);
    setOutPoint(m ? m.duration_secs : 0);
  });

  function togglePlay() {
    if (!videoEl) return;
    if (videoEl.paused) {
      // Always start inside the selection.
      if (videoEl.currentTime < inPoint() || videoEl.currentTime >= outPoint()) {
        videoEl.currentTime = inPoint();
      }
      void videoEl.play();
    } else {
      videoEl.pause();
    }
  }

  function onTimeUpdate(t: number) {
    setCurrentTime(t);
    // Loop within the selection while playing.
    if (videoEl && !videoEl.paused && t >= outPoint()) {
      videoEl.currentTime = inPoint();
    }
  }

  function onEnded() {
    // Reached the real end (OUT == duration): restart the loop.
    if (!videoEl) return;
    videoEl.currentTime = inPoint();
    void videoEl.play();
  }

  const selectionLength = () => Math.max(0, outPoint() - inPoint());

  return (
    <section class="player">
      <video
        ref={(el) => {
          videoEl = el;
          setVideoEl(el);
        }}
        src={src()}
        onTimeUpdate={(e) => onTimeUpdate(e.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={onEnded}
      />
      <Timeline />
      <div class="controls">
        <button type="button" onClick={togglePlay}>
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
