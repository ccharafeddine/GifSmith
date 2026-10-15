// "Shrink to fit": when an export lands over the chosen size limit (Discord
// 10 MB, X 15 MB, ...), pick smaller settings for another pass. GIF size
// scales roughly with frames x pixels, and quality trims ~20-35% at the top
// end, so each step cuts the cheapest-to-lose dimension first.

export interface FitParams {
  width: number;
  fps: number;
  quality: number;
}

export const MIN_WIDTH = 160;
export const MIN_FPS = 8;
export const MIN_QUALITY = 55;
/** Aim a little under the limit: sizes vary between passes. */
const HEADROOM = 0.9;

/** Next settings to try, or null if already at the floor / already fits. */
export function fitStep(p: FitParams, bytes: number, limitBytes: number): FitParams | null {
  if (bytes <= limitBytes || bytes <= 0) return null;
  let need = (limitBytes / bytes) * HEADROOM; // fraction of current size to hit
  let { width, fps, quality } = p;
  // Small overshoot: quality alone usually covers it.
  if (need >= 0.75 && quality > MIN_QUALITY + 10) {
    return { width, fps, quality: Math.max(MIN_QUALITY, quality - 15) };
  }
  // Frame rate next, down to ~12 fps (still smooth for most GIFs).
  const fpsFloor = Math.max(MIN_FPS, 12);
  if (fps > fpsFloor) {
    const nf = Math.max(fpsFloor, Math.floor(fps * Math.max(need, 0.6)));
    need *= fps / nf;
    fps = nf;
  }
  // Then width: area ~ width², so scale by the square root.
  if (need < 1) {
    const nw = Math.max(MIN_WIDTH, Math.floor((width * Math.sqrt(need)) / 2) * 2);
    width = nw;
  }
  if (quality > MIN_QUALITY && need < 0.5) quality = Math.max(MIN_QUALITY, quality - 10);
  if (width === p.width && fps === p.fps && quality === p.quality) return null;
  return { width, fps, quality };
}

/** At most this many extra passes, so a stubborn clip can't loop forever. */
export const MAX_FIT_PASSES = 3;
