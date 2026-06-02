import {
  videoEl,
  meta,
  inPoint,
  setInPoint,
  outPoint,
  setOutPoint,
  setCurrentTime,
  boomerang,
  speed,
  playing,
  setPlaying,
} from "./state";
import { MIN_SELECTION } from "./constants";

// The boomerang reverse pass is simulated, since HTML <video> can't play in
// reverse. We seek backwards one step at a time, gated on the "seeked" event so
// each frame actually renders before we issue the next seek (setting currentTime
// faster than seeks complete just coalesces them and the picture freezes). The
// target is wall-clock based so it stays ~1x, dropping frames if decode is slow.
let reversing = false;
let reverseStartWall = 0;
let reverseStartTime = 0;

function cancelReverse() {
  reversing = false;
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

function startReverse() {
  const v = videoEl();
  if (!v) return;
  reversing = true;
  v.pause(); // we control currentTime manually now
  reverseStartWall = performance.now();
  reverseStartTime = v.currentTime;
  reverseSeek();
}

function reverseSeek() {
  const v = videoEl();
  if (!v || !reversing) return;
  const elapsed = (performance.now() - reverseStartWall) / 1000;
  const target = reverseStartTime - elapsed * speed(); // match the chosen speed
  if (target <= inPoint()) {
    reversing = false;
    v.currentTime = inPoint();
    setCurrentTime(inPoint());
    void v.play(); // loop back into forward playback
    return;
  }
  const onSeeked = () => {
    v.removeEventListener("seeked", onSeeked);
    if (!reversing) return;
    setCurrentTime(v.currentTime);
    reverseSeek();
  };
  v.addEventListener("seeked", onSeeked);
  v.currentTime = target;
}

/** Called from the <video> timeupdate. Loops or boomerangs at the OUT point. */
export function onPlaybackTime(t: number) {
  if (reversing) return; // the reverse pass owns currentTime
  setCurrentTime(t);
  const v = videoEl();
  if (!v || !playing()) return;
  if (t >= outPoint()) {
    if (boomerang()) {
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
  if (boomerang()) {
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
