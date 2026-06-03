import { invoke } from "@tauri-apps/api/core";

/** Mirrors `VideoMeta` in src-tauri/src/probe.rs. */
export interface VideoMeta {
  duration_secs: number;
  width: number;
  height: number;
  fps_num: number;
  fps_den: number;
  codec: string;
  container: string;
}

/** A crop region in source pixels. Mirrors `Crop` in encoder.rs. */
export interface Crop {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Mirrors `ExportParams` in src-tauri/src/encoder.rs (camelCase over IPC). */
export interface ExportParams {
  inputPath: string;
  startSecs: number;
  endSecs: number;
  fps: number;
  width: number;
  quality: number;
  srcWidth: number;
  srcHeight: number;
  crop: Crop | null;
  speed: number;
  boomerang: boolean;
}

/** Probe a local video file via the bundled ffprobe sidecar. */
export function probeVideo(path: string): Promise<VideoMeta> {
  return invoke<VideoMeta>("probe_video", { path });
}

/** Download a video from a URL via yt-dlp; resolves to the temp file path. */
export function downloadVideo(url: string): Promise<string> {
  return invoke<string>("download_video", { url });
}

/** Build a timeline thumbnail strip; resolves to a PNG data URI. */
export function generateFilmstrip(
  path: string,
  durationSecs: number,
): Promise<string> {
  return invoke<string>("generate_filmstrip", { path, durationSecs });
}

/** Result of an export: temp path and output size in bytes. */
export interface PreviewResult {
  path: string;
  bytes: number;
}

/** Encode the selected slice to a temp GIF; resolves to its path + size. */
export function exportPreview(params: ExportParams): Promise<PreviewResult> {
  return invoke<PreviewResult>("export_preview", { params });
}

/** Move a previewed temp GIF to the user's chosen destination. */
export function savePreview(tempPath: string, destPath: string): Promise<void> {
  return invoke<void>("save_preview", { tempPath, destPath });
}

/** Delete a discarded preview temp GIF. */
export function discardPreview(tempPath: string): Promise<void> {
  return invoke<void>("discard_preview", { tempPath });
}
