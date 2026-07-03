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

/** Ask the running URL download to abort. The download rejects with a cancelled error. */
export function cancelDownload(): Promise<void> {
  return invoke<void>("cancel_download");
}

/** Transcode an H.264 playback proxy for an unsupported codec; resolves to its path. */
export function generateProxy(path: string): Promise<string> {
  return invoke<string>("generate_proxy", { path });
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

/** Ask the running export to abort. The export rejects with a cancelled error. */
export function cancelExport(): Promise<void> {
  return invoke<void>("cancel_export");
}

/**
 * Resolve the default save path (<Documents>/GifSmith/<filename>), creating the
 * folder on demand. Rejects if the Documents dir can't be resolved or created.
 */
export function defaultSavePath(
  filename: string,
  dir?: string | null,
): Promise<string> {
  return invoke<string>("default_save_path", { filename, dir: dir ?? null });
}

/** Move a previewed temp GIF to the user's chosen destination. */
export function savePreview(tempPath: string, destPath: string): Promise<void> {
  return invoke<void>("save_preview", { tempPath, destPath });
}

/** Delete a discarded preview temp GIF. */
export function discardPreview(tempPath: string): Promise<void> {
  return invoke<void>("discard_preview", { tempPath });
}

/** One GIF in the gallery. Mirrors `ExportEntry` in src-tauri/src/commands.rs. */
export interface ExportEntry {
  name: string;
  path: string;
  bytes: number;
  modified: number;
}

/** The effective default exports folder, for first-run display. */
export function getExportsDir(): Promise<string> {
  return invoke<string>("get_exports_dir");
}

/** List the GIFs in `dir` (or the default folder when omitted), newest first. */
export function listExports(dir?: string | null): Promise<ExportEntry[]> {
  return invoke<ExportEntry[]>("list_exports", { dir: dir ?? null });
}

/** First-frame thumbnail for a gallery GIF; resolves to a PNG data URI. */
export function galleryThumbnail(path: string): Promise<string> {
  return invoke<string>("gallery_thumbnail", { path });
}

/** Result of an update check. Mirrors `UpdateInfo` in src-tauri/src/commands.rs. */
export interface UpdateInfo {
  /** This build's version (from CARGO_PKG_VERSION). */
  current: string;
  /** Latest published release version, leading `v` stripped. */
  latest: string;
  /** True when `latest` is a strictly higher version than `current`. */
  is_newer: boolean;
  /** Release notes (the GitHub release body), may be empty. */
  notes: string;
  /** Release page URL to open for the download. */
  url: string;
}

/** Ask GitHub for the latest release (network runs in Rust). Prompt-only: never
 * downloads or installs, just reports what's available. */
export function checkForUpdate(): Promise<UpdateInfo> {
  return invoke<UpdateInfo>("check_for_update");
}
