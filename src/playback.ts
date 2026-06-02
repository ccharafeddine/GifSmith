import {
  videoEl,
  meta,
  inPoint,
  setInPoint,
  outPoint,
  setOutPoint,
  setCurrentTime,
  bounce,
  playing,
  setPlaying,
} from "./state";
import { MIN_SELECTION } from "./constants";

// Boomerang reverse pass is simulated by stepping currentTime backwards, since
// HTML <video> can't play in reverse. Module-level so the controller is a
// singleton across the button, keyboard, and timeupdate callbacks.
let rafId: number | undefined;
let reversing = false;
let reverseLast: number | undefined;

function cancelReverse() {
  if (rafId !== undefined) {
    cancelAnimationFrame(rafId);
    rafId = undefined;
  }
  reversing = false;
  reverseLast = undefined;
}

/** Stop playback entirely (forward or reverse). */
export function pausePlayback() {
  cancelReverse();
  const v = videoEl();
  if (v) v.pause();
  setPlaying(false);
}

/** Start forward playback from inside the selection. */
export function playPlayback() {
  const v = videoEl();
  if (!v) return;
  cancelReverse();
  if (v.currentTime < inPoint() || v.currentTime >= outPoint()) {
    v.currentTime = inPoint();
  }
  void v.play();
  setPlaying(true);
}

export function togglePlayback() {
  if (playing()) pausePlayback();
  else playPlayback();
}

/** Drive the reverse half of a boomerang by seeking backwards in real time. */
function startReverse() {
  const v = videoEl();
  if (!v) return;
  reversing = true;
  reverseLast = undefined;
  v.pause(); // we control currentTime manually now
  rafId = requestAnimationFrame(reverseTick);
}

function reverseTick(now: number) {
  if (!reversing) return;
  const v = videoEl();
  if (!v) {
    cancelReverse();
    return;
  }
  if (reverseLast === undefined) reverseLast = now;
  const dt = (now - reverseLast) / 1000;
  reverseLast = now;
  const t = v.currentTime - dt; // 1x reverse
  if (t <= inPoint()) {
    cancelReverse();
    v.currentTime = inPoint();
    setCurrentTime(inPoint());
    void v.play(); // loop back into forward playback
    return;
  }
  v.currentTime = t;
  setCurrentTime(t);
  rafId = requestAnimationFrame(reverseTick);
}

/** Called from the <video> timeupdate. Loops or boomerangs at the OUT point. */
export function onPlaybackTime(t: number) {
  if (reversing) return; // rAF owns currentTime during the reverse pass
  setCurrentTime(t);
  const v = videoEl();
  if (!v || !playing()) return;
  if (t >= outPoint()) {
    if (bounce()) {
      startReverse();
    } else {
      v.currentTime = inPoint();
    }
  }
}

/** Called from the <video> ended event (OUT == duration edge). */
export function onPlaybackEnded() {
  const v = videoEl();
  if (!v || !playing() || reversing) return;
  if (bounce()) {
    startReverse();
  } else {
    v.currentTime = inPoint();
    void v.play();
  }
}

/** Stop and clear transport state (e.g. when a new source loads). */
export function resetPlayback() {
  cancelReverse();
  const v = videoEl();
  if (v) v.pause();
  setPlaying(false);
}

/** Pause and seek by one source frame (1 / source fps) in the given direction. */
export function stepFrame(direction: 1 | -1) {
  const v = videoEl();
  const m = meta();
  if (!v || !m) return;
  pausePlayback();
  const fps = m.fps_den > 0 ? m.fps_num / m.fps_den : 30;
  const frameDur = fps > 0 ? 1 / fps : 1 / 30;
  const t = Math.min(
    m.duration_secs,
    Math.max(0, v.currentTime + direction * frameDur),
  );
  v.currentTime = t;
  setCurrentTime(t);
}

/** Set the IN point at the playhead, keeping at least MIN_SELECTION before OUT. */
export function setInAtPlayhead() {
  const v = videoEl();
  if (!v) return;
  setInPoint(Math.max(0, Math.min(v.currentTime, outPoint() - MIN_SELECTION)));
}

/** Set the OUT point at the playhead, keeping at least MIN_SELECTION after IN. */
export function setOutAtPlayhead() {
  const v = videoEl();
  const m = meta();
  if (!v || !m) return;
  setOutPoint(
    Math.min(m.duration_secs, Math.max(v.currentTime, inPoint() + MIN_SELECTION)),
  );
}
