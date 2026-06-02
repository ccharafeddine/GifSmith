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

/** Mirrors `ExportParams` in src-tauri/src/encoder.rs (camelCase over IPC). */
export interface ExportParams {
  inputPath: string;
  outputPath: string;
  startSecs: number;
  endSecs: number;
  fps: number;
  width: number;
  quality: number;
  srcWidth: number;
  srcHeight: number;
}

/** Probe a local video file via the bundled ffprobe sidecar. */
export function probeVideo(path: string): Promise<VideoMeta> {
  return invoke<VideoMeta>("probe_video", { path });
}

/** Encode the selected slice to a GIF at params.outputPath. */
export function exportGif(params: ExportParams): Promise<void> {
  return invoke<void>("export_gif", { params });
}
