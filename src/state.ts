import { createSignal } from "solid-js";
import type { VideoMeta } from "./ipc";

// Shared app state. Per CLAUDE.md, plain signals until this grows past ~10.

/** Absolute path of the loaded source video, or null when none is open. */
export const [filePath, setFilePath] = createSignal<string | null>(null);

/** Probed metadata for the loaded video, or null until probing succeeds. */
export const [meta, setMeta] = createSignal<VideoMeta | null>(null);

/** Live playback position in seconds (driven by the <video> timeupdate). */
export const [currentTime, setCurrentTime] = createSignal(0);

/** Trim IN point in seconds. */
export const [inPoint, setInPoint] = createSignal(0);

/** Trim OUT point in seconds. */
export const [outPoint, setOutPoint] = createSignal(0);

/** The live <video> element, shared so the timeline can seek it. */
export const [videoEl, setVideoEl] = createSignal<HTMLVideoElement>();

/** Timeline thumbnail strip (asset URL), or null until generated. */
export const [filmstripSrc, setFilmstripSrc] = createSignal<string | null>(null);

/** Whether the transport is active (forward playback or boomerang reverse). */
export const [playing, setPlaying] = createSignal(false);

/** Start of the visible timeline window in seconds (timeline zoom). */
export const [viewStart, setViewStart] = createSignal(0);

/** End of the visible timeline window in seconds (timeline zoom). */
export const [viewEnd, setViewEnd] = createSignal(0);

// --- Export settings ---

/** Output frame rate (frames per second). */
export const [fps, setFps] = createSignal(15);

/** Output width in pixels (height follows source aspect). */
export const [width, setWidth] = createSignal(480);

/** gifski quality, 1-100. */
export const [quality, setQuality] = createSignal(90);

/** Output playback speed multiplier (0.5x - 2x). */
export const [speed, setSpeed] = createSignal(1);

// --- Preview ---

/** Temp path of the GIF awaiting preview, or null when no modal is open. */
export const [previewPath, setPreviewPath] = createSignal<string | null>(null);

/** Bumped on each export so the preview <img> reloads past the cache. */
export const [previewVersion, setPreviewVersion] = createSignal(0);

/** Byte size of the most recent export (shown in the preview). */
export const [previewBytes, setPreviewBytes] = createSignal(0);

// --- Gallery ---

/** Whether the full-screen Exports gallery is open over the editor. */
export const [galleryOpen, setGalleryOpen] = createSignal(false);

// --- Crop (source pixel coordinates) ---

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Whether the crop overlay is active. */
export const [cropEnabled, setCropEnabled] = createSignal(false);

/** Crop region in source pixels, or null for the full frame. */
export const [crop, setCrop] = createSignal<CropRect | null>(null);

/** Locked crop aspect: free-form, 16:9 landscape, 9:16 portrait, or 1:1 square. */
export type CropAspect = "free" | "landscape" | "portrait" | "square";
export const [cropAspect, setCropAspect] = createSignal<CropAspect>("free");

/** Aspect ratio (w/h) for a locked crop mode. */
export const ASPECT_RATIO: Record<Exclude<CropAspect, "free">, number> = {
  landscape: 16 / 9,
  portrait: 9 / 16,
  square: 1,
};

/** Play the clip forward then reversed. */
export const [boomerang, setBoomerang] = createSignal(false);

/**
 * Clear the loaded video without opening another: release the <video> handle
 * (so the source file is no longer locked on disk) and reset source-derived
 * state back to the empty loader. Export settings are intentionally kept.
 */
export function closeVideo(): void {
  const v = videoEl();
  if (v) {
    v.pause();
    v.removeAttribute("src");
    v.load();
  }
  setPlaying(false);
  setFilePath(null);
  setMeta(null);
  setFilmstripSrc(null);
  setCurrentTime(0);
  setInPoint(0);
  setOutPoint(0);
  setViewStart(0);
  setViewEnd(0);
  setCropEnabled(false);
  setCrop(null);
  setCropAspect("free");
}
