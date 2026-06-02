import { createMemo } from "solid-js";
import {
  meta,
  currentTime,
  setCurrentTime,
  inPoint,
  setInPoint,
  outPoint,
  setOutPoint,
  videoEl,
} from "../state";

// Smallest selectable clip, in seconds, so IN and OUT can't collapse together.
const MIN_SELECTION = 0.1;

type DragKind = "in" | "out" | "playhead";

/**
 * iOS-style trim strip layered over the playback range. Drag the IN/OUT
 * handles to frame a selection (highlighted, dimmed outside); drag elsewhere
 * to scrub the playhead. Geometry is fed in via CSS custom properties so all
 * styling stays in the stylesheet.
 */
export default function Timeline() {
  let track: HTMLDivElement | undefined;

  const duration = createMemo(() => meta()?.duration_secs ?? 0);
  const pct = (t: number) => {
    const d = duration();
    return d > 0 ? (t / d) * 100 : 0;
  };

  function timeFromClientX(clientX: number): number {
    if (!track) return 0;
    const rect = track.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return frac * duration();
  }

  function seekTo(t: number) {
    const v = videoEl();
    if (v) v.currentTime = t;
    setCurrentTime(t);
  }

  function startDrag(kind: DragKind, e: PointerEvent) {
    e.preventDefault();

    const apply = (clientX: number) => {
      const t = timeFromClientX(clientX);
      if (kind === "in") {
        const next = Math.min(t, outPoint() - MIN_SELECTION);
        setInPoint(Math.max(0, next));
        if (currentTime() < inPoint()) seekTo(inPoint());
      } else if (kind === "out") {
        const next = Math.max(t, inPoint() + MIN_SELECTION);
        setOutPoint(Math.min(duration(), next));
        if (currentTime() > outPoint()) seekTo(outPoint());
      } else {
        seekTo(Math.min(outPoint(), Math.max(inPoint(), t)));
      }
    };

    const onMove = (ev: PointerEvent) => apply(ev.clientX);
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    apply(e.clientX);
  }

  return (
    <div
      class="timeline"
      ref={track}
      onPointerDown={(e) => startDrag("playhead", e)}
      style={{
        "--in": `${pct(inPoint())}%`,
        "--out": `${pct(outPoint())}%`,
        "--ph": `${pct(currentTime())}%`,
      }}
    >
      <div class="tl-dim tl-dim-left" />
      <div class="tl-dim tl-dim-right" />
      <div class="tl-selection" />
      <div
        class="tl-handle tl-handle-in"
        onPointerDown={(e) => {
          e.stopPropagation();
          startDrag("in", e);
        }}
      />
      <div
        class="tl-handle tl-handle-out"
        onPointerDown={(e) => {
          e.stopPropagation();
          startDrag("out", e);
        }}
      />
      <div class="tl-playhead" />
    </div>
  );
}
