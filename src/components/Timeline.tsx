import { createMemo, Show } from "solid-js";
import {
  meta,
  currentTime,
  setCurrentTime,
  inPoint,
  setInPoint,
  outPoint,
  setOutPoint,
  videoEl,
  viewStart,
  setViewStart,
  viewEnd,
  setViewEnd,
} from "../state";
import { formatTimecode } from "../format";

// Absolute smallest selectable clip, in seconds (a safety floor).
const MIN_SELECTION = 0.1;
// Handle width in px (matches .tl-handle in App.css).
const HANDLE_PX = 14;
// Keep IN and OUT at least two handle widths apart on screen so they never
// overlap and both stay grabbable. Converted to seconds per the current zoom.
const MIN_GAP_PX = 2 * HANDLE_PX;
// Most-zoomed-in state: the whole strip shows this many seconds.
const MIN_VIEW_SPAN = 60;
// Wheel zoom step.
const ZOOM_FACTOR = 1.2;

type DragKind = "in" | "out" | "playhead";

const clamp = (x: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, x));

/**
 * iOS-style trim strip with a zoomable view window. Drag the IN/OUT handles to
 * frame a selection; drag elsewhere to scrub. Scroll to zoom the visible window
 * (cursor-anchored, down to MIN_VIEW_SPAN); zooming in pulls a too-wide trim
 * inward, zooming out leaves the trim alone. Geometry is fed in via CSS custom
 * properties so styling stays in the stylesheet.
 */
export default function Timeline() {
  let track: HTMLDivElement | undefined;

  const duration = createMemo(() => meta()?.duration_secs ?? 0);
  const viewSpan = () => viewEnd() - viewStart();

  // Position of a time within the visible window, as a clamped 0-100 percentage.
  const pct = (t: number) => {
    const span = viewSpan();
    return span > 0 ? clamp(((t - viewStart()) / span) * 100, 0, 100) : 0;
  };

  function timeFromClientX(clientX: number): number {
    if (!track) return 0;
    const rect = track.getBoundingClientRect();
    const frac = clamp((clientX - rect.left) / rect.width, 0, 1);
    return viewStart() + frac * viewSpan();
  }

  // Minimum IN/OUT gap in seconds that keeps the handles from overlapping at
  // the current zoom (MIN_GAP_PX on screen).
  function minGapTime(): number {
    const span = viewSpan();
    if (!track || span <= 0) return MIN_SELECTION;
    const w = track.getBoundingClientRect().width;
    if (w <= 0) return MIN_SELECTION;
    return Math.max(MIN_SELECTION, (MIN_GAP_PX / w) * span);
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
      // Block shrinking past the on-screen gap, but if the selection is already
      // smaller (e.g. set at a deeper zoom, then zoomed out) don't force it
      // open: only stop it from shrinking further. Expanding is always allowed.
      const gap = Math.min(minGapTime(), outPoint() - inPoint());
      if (kind === "in") {
        setInPoint(clamp(t, viewStart(), outPoint() - gap));
        if (currentTime() < inPoint()) seekTo(inPoint());
      } else if (kind === "out") {
        setOutPoint(clamp(t, inPoint() + gap, viewEnd()));
        if (currentTime() > outPoint()) seekTo(outPoint());
      } else {
        seekTo(clamp(t, inPoint(), outPoint()));
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

  function onWheel(e: WheelEvent) {
    const d = duration();
    if (d <= 0) return;
    e.preventDefault();

    const minSpan = Math.min(MIN_VIEW_SPAN, d);
    const span = viewSpan();
    const cursorT = timeFromClientX(e.clientX);
    const factor = e.deltaY < 0 ? 1 / ZOOM_FACTOR : ZOOM_FACTOR; // up = zoom in
    const newSpan = clamp(span * factor, minSpan, d);
    if (newSpan === span) return;

    // Keep the time under the cursor pinned to the same pixel.
    const frac = span > 0 ? (cursorT - viewStart()) / span : 0;
    const newStart = clamp(cursorT - frac * newSpan, 0, d - newSpan);
    const newEnd = newStart + newSpan;
    setViewStart(newStart);
    setViewEnd(newEnd);

    // Couple the trim to the view: clamp handles into the window. Zoom-in pulls
    // a too-wide selection inward; zoom-out is a no-op (handles already inside).
    const ni = clamp(inPoint(), newStart, newEnd);
    const no = clamp(outPoint(), newStart, newEnd);
    if (no - ni < MIN_SELECTION) {
      setInPoint(newStart);
      setOutPoint(newEnd);
    } else {
      setInPoint(ni);
      setOutPoint(no);
    }
  }

  const playheadVisible = () =>
    currentTime() >= viewStart() && currentTime() <= viewEnd();
  const zoomed = () => viewSpan() < duration() - 1e-6;

  return (
    <div class="timeline-wrap">
      <div
        class="timeline"
        ref={track}
        onPointerDown={(e) => startDrag("playhead", e)}
        onWheel={onWheel}
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
        <Show when={playheadVisible()}>
          <div class="tl-playhead" />
        </Show>
      </div>
      <p class="tl-info">
        <Show when={zoomed()} fallback="Scroll over the timeline to zoom in">
          Showing {formatTimecode(viewSpan())} of {formatTimecode(duration())}
        </Show>
      </p>
    </div>
  );
}
