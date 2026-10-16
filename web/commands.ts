// GifSmith's Tauri commands, implemented for the browser build. Each mirrors
// its Rust counterpart in src-tauri/src (same arguments and results), using
// ffmpeg.wasm and browser APIs. Link import, the update check and real folders
// are desktop-only.
import type { ExportParams, VideoMeta, PreviewResult, ExportEntry, UpdateInfo } from "../src/ipc";
import { emitLocal } from "./shim/event";
import { addFile, basename, download, DOWNLOADS, getFile, hasFile, listDir, putFile, removeFile, urlFor } from "./shim/vfs";
import { cancel, ffmpeg, grabFrames, measureFps, mountInput, probe, probeElement, run, sniffCodec, take } from "./shim/engine";

const MAX_INPUT = 2 * 1024 * 1024 * 1024; // ffmpeg.wasm reads via WORKERFS, but stay sane
let preview: string | null = null;

function even(v: number): number { const e = Math.floor(v) & ~1; return e < 2 ? 2 : e; }

/** Mirrors encoder::output_dims. */
function outputDims(p: ExportParams): [number, number] {
  const w = even(p.width);
  const [iw, ih] = p.crop && p.crop.w > 0 && p.crop.h > 0 ? [p.crop.w, p.crop.h] : [p.srcWidth, p.srcHeight];
  return [w, iw === 0 ? w : even(Math.round((ih * w) / iw))];
}

const speedOf = (s: number) => (s > 0 && Number.isFinite(s) ? s : 1);

/** Mirrors encoder::video_filter (setpts -> fps -> crop -> scale). */
function videoFilter(p: ExportParams, w: number, h: number): string {
  const crop = p.crop && p.crop.w > 0 && p.crop.h > 0 ? `,crop=${p.crop.w}:${p.crop.h}:${p.crop.x}:${p.crop.y}` : "";
  return `setpts=${(1 / speedOf(p.speed)).toFixed(6)}*PTS,fps=${p.fps}${crop},scale=${w}:${h}:flags=lanczos`;
}

/** gifski's quality (1-100) has no wasm build; map it onto ffmpeg's palette encoder. */
function palette(quality: number): { colors: number; dither: string } {
  const q = Math.max(1, Math.min(100, quality || 90));
  const colors = Math.max(32, Math.min(256, Math.round(32 + (q / 100) * 224)));
  const dither = q >= 85 ? "sierra2_4a" : q >= 60 ? "bayer:bayer_scale=3" : "bayer:bayer_scale=5";
  return { colors, dither };
}

async function probeVideo({ path }: { path: string }): Promise<VideoMeta> {
  const e = getFile(path);
  if (e.blob.size > MAX_INPUT) throw "That file is over 2 GB, too big for the browser demo.";
  try {
    const m = await probeElement(urlFor(path));
    if (m.width > 0 && m.duration > 0 && Number.isFinite(m.duration)) {
      // Playable here: read the codec from the header and measure the frame
      // rate, so the 31 MB engine only loads when exporting.
      const [codec, fps] = await Promise.all([sniffCodec(e.blob), measureFps(urlFor(path))]);
      return { duration_secs: m.duration, width: m.width, height: m.height, fps_num: fps?.num ?? 30, fps_den: fps?.den ?? 1, codec: codec || "video", container: e.name.split(".").pop()?.toLowerCase() ?? "" };
    }
  } catch { /* fall through to ffprobe (e.g. a GIF, HEVC or ProRes) */ }
  const p = await probe(path);
  const v = p.streams?.find((s) => s.codec_type === "video");
  if (!v) throw "No video stream found in that file.";
  const dur = Number(p.format?.duration ?? v.duration ?? 0);
  if (!(dur > 0)) throw "Couldn't read the video's duration.";
  const [num, den] = (v.avg_frame_rate && v.avg_frame_rate !== "0/0" ? v.avg_frame_rate : v.r_frame_rate ?? "30/1").split("/").map(Number);
  const rot = Math.abs(Number(v.side_data_list?.find((s) => s.rotation !== undefined)?.rotation ?? v.tags?.rotate ?? 0)) % 180 === 90;
  return { duration_secs: dur, width: (rot ? v.height : v.width) ?? 0, height: (rot ? v.width : v.height) ?? 0, fps_num: num || 30, fps_den: den || 1, codec: v.codec_name ?? "", container: p.format?.format_name ?? "" };
}

/** Mirrors generate_filmstrip: 24 evenly spaced frames, centre-cropped to 0.7 aspect, 144 px high, side by side. */
async function generateFilmstrip({ path, durationSecs }: { path: string; durationSecs: number }): Promise<string> {
  const COUNT = 24, H = 144;
  const dur = durationSecs > 0.05 ? durationSecs : 1;
  const times = Array.from({ length: COUNT }, (_, i) => ((i + 0.5) * dur) / COUNT);
  const canvas = document.createElement("canvas");
  let cellW = 0;
  const draw = (ctx: CanvasRenderingContext2D, v: HTMLVideoElement, i: number) => {
    const cw = Math.min(v.videoWidth, v.videoHeight * 0.7);
    if (!cellW) {
      cellW = even(Math.round((cw / v.videoHeight) * H));
      canvas.width = cellW * COUNT;
      canvas.height = H;
    }
    ctx.drawImage(v, (v.videoWidth - cw) / 2, 0, cw, v.videoHeight, i * cellW, 0, cellW, H);
  };
  try {
    await grabFrames(proxies.get(path) ?? urlFor(path), times, draw, canvas);
  } catch {
    // The browser can't decode this codec: build the playback proxy and use it.
    if (!proxies.has(path)) await generateProxy({ path });
    await grabFrames(proxies.get(path)!, times, draw, canvas);
  }
  return canvas.toDataURL("image/png");
}

const proxies = new Map<string, string>();

/** Mirrors generate_proxy: a ~640 px H.264 copy for codecs the browser can't play. */
const proxyJobs = new Map<string, Promise<string>>();
function generateProxy({ path }: { path: string }): Promise<string> {
  // The player and the filmstrip can both ask for it: build it once.
  let job = proxyJobs.get(path);
  if (!job) {
    job = buildProxy(path);
    proxyJobs.set(path, job);
    job.catch(() => proxyJobs.delete(path));
  }
  return job;
}

async function buildProxy(path: string): Promise<string> {
  const f = await ffmpeg();
  const m = await mountInput(f, path);
  try {
    await run(["-v", "info", "-i", m.file, "-an", "-vf", "scale=640:-2", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "/proxy.mp4"]);
  } finally { await m.unmount(); }
  const out = addFile(await take("/proxy.mp4", "video/mp4"), "proxy.mp4", "/proxy");
  proxies.set(path, urlFor(out));
  return out;
}

/** Mirrors export_preview: encode the selection to a temp GIF, emitting "export-progress" (0..1). */
async function exportPreview({ params: p }: { params: ExportParams }): Promise<PreviewResult> {
  const [w, h] = outputDims(p);
  const start = Math.max(0, p.startSecs);
  const len = Math.max(0, p.endSecs - start);
  if (len <= 0) throw "no frames were produced for this selection";
  const { colors, dither } = palette(p.quality);
  const vf = videoFilter(p, w, h);
  // Boomerang: forward without its first frame, then reversed without its first
  // frame, so neither turn-around repeats a frame (same as encoder::boomerang_order, rotated).
  const graph = p.boomerang
    ? `[0:v]${vf},split[f][r];[f]trim=start_frame=1,setpts=PTS-STARTPTS[fw];[r]reverse,trim=start_frame=1,setpts=PTS-STARTPTS[rv];[fw][rv]concat=n=2:v=1,split[a][b];[a]palettegen=max_colors=${colors}:stats_mode=diff[pal];[b][pal]paletteuse=dither=${dither}:diff_mode=rectangle[out]`
    : `[0:v]${vf},split[a][b];[a]palettegen=max_colors=${colors}:stats_mode=diff[pal];[b][pal]paletteuse=dither=${dither}:diff_mode=rectangle[out]`;
  const outSecs = (len / speedOf(p.speed)) * (p.boomerang ? 2 : 1);
  const f = await ffmpeg();
  const m = await mountInput(f, p.inputPath);
  emitLocal("export-progress", 0);
  try {
    await run(["-v", "info", "-nostdin", "-ss", start.toFixed(6), "-t", len.toFixed(6), "-i", m.file, "-filter_complex", graph, "-map", "[out]", "-loop", "0", "-f", "gif", "/preview.gif"], {
      outSecs: outSecs * 2, // palettegen reads everything first, then paletteuse writes: two passes over the timeline
      onProgress: (r) => emitLocal("export-progress", r),
    });
  } finally { await m.unmount(); }
  const blob = await take("/preview.gif", "image/gif");
  if (!blob.size) throw "no frames were produced for this selection";
  if (preview) removeFile(preview);
  preview = addFile(blob, "preview.gif", "/tmp");
  emitLocal("export-progress", 1);
  return { path: preview, bytes: blob.size };
}

async function cancelExport(): Promise<void> { cancel(); }

async function defaultSavePath({ filename }: { filename: string; dir: string | null }): Promise<string> {
  return `${DOWNLOADS}/${filename}`;
}

/** Mirrors save_preview: "move" the temp GIF to its destination = a browser download, kept in the gallery. */
async function savePreview({ tempPath, destPath }: { tempPath: string; destPath: string }): Promise<void> {
  const e = getFile(tempPath);
  let name = basename(destPath) || "export.gif";
  if (!/\.gif$/i.test(name)) name += ".gif";
  // Keep a unique name in this tab's "Downloads" (the gallery), like a real folder.
  let dest = `${DOWNLOADS}/${name}`;
  for (let i = 2; hasFile(dest); i++) dest = `${DOWNLOADS}/${name.replace(/(\.gif)$/i, ` (${i})$1`)}`;
  putFile(dest, e.blob);
  removeFile(tempPath);
  if (preview === tempPath) preview = null;
  download(e.blob, basename(dest));
}

async function discardPreview({ tempPath }: { tempPath: string }): Promise<void> {
  removeFile(tempPath);
  if (preview === tempPath) preview = null;
}

async function getExportsDir(): Promise<string> { return DOWNLOADS; }

async function listExports(): Promise<ExportEntry[]> {
  return listDir(DOWNLOADS).filter(([p]) => /\.gif$/i.test(p)).map(([path, e]) => ({ name: e.name, path, bytes: e.blob.size, modified: Math.floor(e.modified / 1000) }));
}

/** Mirrors gallery_thumbnail: first frame, 160 px high, PNG data URI. */
async function galleryThumbnail({ path }: { path: string }): Promise<string> {
  const img = new Image();
  img.src = urlFor(path);
  await img.decode();
  const c = document.createElement("canvas");
  c.height = 160;
  c.width = even(Math.round((img.naturalWidth / img.naturalHeight) * 160));
  c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL("image/png");
}

const DESKTOP_LINKS = "Importing from a link runs in the desktop app. In the browser, open or drop a video file.";
async function downloadVideo(): Promise<string> { throw DESKTOP_LINKS; }
async function cancelDownload(): Promise<void> {}

async function checkForUpdate(): Promise<UpdateInfo> {
  return { current: __APP_VERSION__, latest: __APP_VERSION__, is_newer: false, notes: "", url: `${__APP_REPO__}/releases/latest` };
}

export const commands = {
  probe_video: probeVideo,
  generate_filmstrip: generateFilmstrip,
  generate_proxy: generateProxy,
  export_preview: exportPreview,
  cancel_export: cancelExport,
  default_save_path: defaultSavePath,
  save_preview: savePreview,
  discard_preview: discardPreview,
  get_exports_dir: getExportsDir,
  list_exports: listExports,
  gallery_thumbnail: galleryThumbnail,
  download_video: downloadVideo,
  cancel_download: cancelDownload,
  // Desktop-only link downloads (the UI is hidden on the web via isTauri()).
  fetch_download: downloadVideo,
  fetch_probe: downloadVideo,
  fetch_download_hit: downloadVideo,
  browse_open: downloadVideo,
  browse_save_signin: downloadVideo,
  cookies_import: downloadVideo,
  tools_update_now: downloadVideo,
  stop_recording: cancelDownload,
  browse_close: cancelDownload,
  cookies_forget: cancelDownload,
  browse_hits: async (): Promise<never[]> => [],
  cookies_list: async (): Promise<never[]> => [],
  check_for_update: checkForUpdate,
};
