import {
  videoEl,
  meta,
  inPoint,
  setInPoint,
  outPoint,
  setOutPoint,
  setCurrentTime,
} from "./state";
import { MIN_SELECTION } from "./constants";

/** Toggle play/pause, starting inside the selection if currently outside it. */
export function togglePlayback() {
  const v = videoEl();
  if (!v) return;
  if (v.paused) {
    if (v.currentTime < inPoint() || v.currentTime >= outPoint()) {
      v.currentTime = inPoint();
    }
    void v.play();
  } else {
    v.pause();
  }
}

/** Pause and seek by one source frame (1 / source fps) in the given direction. */
export function stepFrame(direction: 1 | -1) {
  const v = videoEl();
  const m = meta();
  if (!v || !m) return;
  const fps = m.fps_den > 0 ? m.fps_num / m.fps_den : 30;
  const frameDur = fps > 0 ? 1 / fps : 1 / 30;
  v.pause();
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
