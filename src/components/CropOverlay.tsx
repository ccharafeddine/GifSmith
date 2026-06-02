import { Show } from "solid-js";
import {
  meta,
  cropEnabled,
  crop,
  setCrop,
  cropAspect,
  ASPECT_RATIO,
  type CropRect,
} from "../state";

// Smallest crop in source pixels.
const MIN_CROP = 16;
type Corner = "nw" | "ne" | "sw" | "se";

const clamp = (x: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, x));

/**
 * Draggable / resizable crop rectangle over the video. The rect is stored in
 * source pixels (state.crop); rendered as percentages since the stage is sized
 * to the exact source aspect ratio (no letterboxing).
 */
export default function CropOverlay() {
  let root: HTMLDivElement | undefined;

  const srcW = () => meta()?.width ?? 0;
  const srcH = () => meta()?.height ?? 0;
  const rect = (): CropRect =>
    crop() ?? { x: 0, y: 0, w: srcW(), h: srcH() };

  const pctL = () => (srcW() > 0 ? (rect().x / srcW()) * 100 : 0);
  const pctT = () => (srcH() > 0 ? (rect().y / srcH()) * 100 : 0);
  const pctW = () => (srcW() > 0 ? (rect().w / srcW()) * 100 : 100);
  const pctH = () => (srcH() > 0 ? (rect().h / srcH()) * 100 : 100);

  // Map a pointer drag (display px) to source px using the live element size.
  function scale(): { sx: number; sy: number } {
    if (!root) return { sx: 1, sy: 1 };
    const r = root.getBoundingClientRect();
    return {
      sx: r.width > 0 ? srcW() / r.width : 1,
      sy: r.height > 0 ? srcH() / r.height : 1,
    };
  }

  function startMove(e: PointerEvent) {
    e.preventDefault();
    const start = rect();
    const px = e.clientX;
    const py = e.clientY;
    const { sx, sy } = scale();

    const onMove = (ev: PointerEvent) => {
      const dx = (ev.clientX - px) * sx;
      const dy = (ev.clientY - py) * sy;
      setCrop({
        x: clamp(start.x + dx, 0, srcW() - start.w),
        y: clamp(start.y + dy, 0, srcH() - start.h),
        w: start.w,
        h: start.h,
      });
    };
    listenDrag(onMove);
  }

  function startResize(corner: Corner, e: PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    const start = rect();
    const px = e.clientX;
    const py = e.clientY;
    const { sx, sy } = scale();

    // Locked aspect (landscape/portrait) resizes around the opposite corner,
    // keeping w/h = ratio. Free mode resizes each edge independently.
    const mode = cropAspect();
    const ratio = mode === "free" ? null : ASPECT_RATIO[mode];

    const onMove = (ev: PointerEvent) => {
      const dx = (ev.clientX - px) * sx;
      const dy = (ev.clientY - py) * sy;

      if (ratio !== null) {
        // Anchor = corner opposite the one being dragged.
        const ax = corner === "nw" || corner === "sw" ? start.x + start.w : start.x;
        const ay = corner === "nw" || corner === "ne" ? start.y + start.h : start.y;
        const pointerX =
          corner === "nw" || corner === "sw" ? start.x + dx : start.x + start.w + dx;
        const roomX = corner === "nw" || corner === "sw" ? ax : srcW() - ax;
        const roomY = corner === "nw" || corner === "ne" ? ay : srcH() - ay;
        const maxW = Math.min(roomX, roomY * ratio);
        const w = clamp(Math.abs(pointerX - ax), MIN_CROP, Math.max(MIN_CROP, maxW));
        const h = w / ratio;
        setCrop({
          x: corner === "nw" || corner === "sw" ? ax - w : ax,
          y: corner === "nw" || corner === "ne" ? ay - h : ay,
          w,
          h,
        });
        return;
      }

      const next = { ...start };
      if (corner === "nw" || corner === "sw") {
        const nx = clamp(start.x + dx, 0, start.x + start.w - MIN_CROP);
        next.x = nx;
        next.w = start.x + start.w - nx;
      } else {
        next.w = clamp(start.w + dx, MIN_CROP, srcW() - start.x);
      }
      if (corner === "nw" || corner === "ne") {
        const ny = clamp(start.y + dy, 0, start.y + start.h - MIN_CROP);
        next.y = ny;
        next.h = start.y + start.h - ny;
      } else {
        next.h = clamp(start.h + dy, MIN_CROP, srcH() - start.y);
      }
      setCrop(next);
    };
    listenDrag(onMove);
  }

  function listenDrag(onMove: (ev: PointerEvent) => void) {
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  return (
    <Show when={cropEnabled()}>
      <div class="crop-overlay" ref={root}>
        <div
          class="crop-rect"
          onPointerDown={startMove}
          style={{
            "--cl": `${pctL()}%`,
            "--ct": `${pctT()}%`,
            "--cw": `${pctW()}%`,
            "--ch": `${pctH()}%`,
          }}
        >
          <div
            class="crop-handle nw"
            onPointerDown={(e) => startResize("nw", e)}
          />
          <div
            class="crop-handle ne"
            onPointerDown={(e) => startResize("ne", e)}
          />
          <div
            class="crop-handle sw"
            onPointerDown={(e) => startResize("sw", e)}
          />
          <div
            class="crop-handle se"
            onPointerDown={(e) => startResize("se", e)}
          />
        </div>
      </div>
    </Show>
  );
}
