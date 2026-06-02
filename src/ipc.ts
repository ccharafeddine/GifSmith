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

/** Probe a local video file via the bundled ffprobe sidecar. */
export function probeVideo(path: string): Promise<VideoMeta> {
  return invoke<VideoMeta>("probe_video", { path });
}
