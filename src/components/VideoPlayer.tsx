import { createEffect, createSignal } from "solid-js";
import { convertFileSrc } from "@tauri-apps/api/core";
import { filePath } from "../state";
import { formatTimecode } from "../format";

/**
 * Plays the loaded source video via the asset protocol, with a custom
 * play/pause toggle and a seekbar bound to currentTime. No trim handles yet
 * (Step 6). The native <video> controls are intentionally hidden.
 */
export default function VideoPlayer() {
  let videoEl: HTMLVideoElement | undefined;
  const [playing, setPlaying] = createSignal(false);
  const [currentTime, setCurrentTime] = createSignal(0);
  const [duration, setDuration] = createSignal(0);

  const src = () => {
    const p = filePath();
    return p ? convertFileSrc(p) : "";
  };

  // Reset transport state whenever the source changes.
  createEffect(() => {
    filePath();
    setCurrentTime(0);
    setDuration(0);
    setPlaying(false);
  });

  function togglePlay() {
    if (!videoEl) return;
    if (videoEl.paused) {
      void videoEl.play();
    } else {
      videoEl.pause();
    }
  }

  return (
    <section class="player">
      <video
        ref={videoEl}
        src={src()}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
      />
      <div class="controls">
        <button type="button" onClick={togglePlay}>
          {playing() ? "Pause" : "Play"}
        </button>
        <input
          type="range"
          min={0}
          max={duration() || 0}
          step="any"
          value={currentTime()}
          onInput={(e) => {
            if (!videoEl) return;
            const t = Number(e.currentTarget.value);
            videoEl.currentTime = t;
            setCurrentTime(t);
          }}
        />
        <span class="time">
          {formatTimecode(currentTime())} / {formatTimecode(duration())}
        </span>
      </div>
    </section>
  );
}
