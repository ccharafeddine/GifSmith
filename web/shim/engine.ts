// ffmpeg.wasm for the browser build. Loaded from this site on first use (never
// a CDN). The ~31 MiB core wasm is served in parts below the 25 MiB per-file
// static-asset limit and joined in memory (see plugins/vite-ffmpeg.mjs).
import type { FFmpeg } from "@ffmpeg/ffmpeg";
import { getFile } from "./vfs";

interface Manifest { core: string; parts: string[]; bytes: number; fonts?: string[] }

let engine: Promise<FFmpeg> | null = null;
let wasmUrl: string | null = null;
let coreUrl = "";
let fonts: string[] = [];
let busy = false;
const root = () => new URL(import.meta.env.BASE_URL, location.href).href;

function overlay(): { set(r: number): void; done(): void } {
  const el = document.createElement("div");
  el.className = "smith-web-engine";
  el.setAttribute("role", "status");
  el.innerHTML = `<span>Loading the video engine (one-time, about 31 MB)</span><b>0%</b>`;
  document.body.appendChild(el);
  const b = el.querySelector("b")!;
  return { set: (r) => { b.textContent = `${Math.round(r * 100)}%`; }, done: () => el.remove() };
}

async function fetchWasm(m: Manifest, onRatio: (r: number) => void): Promise<string> {
  const blobs: Blob[] = [];
  let got = 0;
  for (const p of m.parts) {
    const r = await fetch(root() + "ffmpeg/" + p);
    if (!r.ok) throw new Error(`Couldn't load the video engine (HTTP ${r.status}).`);
    const b = await r.blob();
    got += b.size;
    onRatio(Math.min(1, got / m.bytes));
    blobs.push(b);
  }
  return URL.createObjectURL(new Blob(blobs, { type: "application/wasm" }));
}

/** The shared ffmpeg instance, loading it on first call. */
export function ffmpeg(): Promise<FFmpeg> {
  engine ??= (async () => {
    let ui: ReturnType<typeof overlay> | null = null;
    try {
      if (!wasmUrl) {
        const res = await fetch(root() + "ffmpeg/manifest.json");
        if (!res.ok) throw new Error("The video engine isn't part of this build.");
        const m = (await res.json()) as Manifest;
        coreUrl = root() + "ffmpeg/" + m.core;
        fonts = m.fonts ?? [];
        ui = overlay();
        wasmUrl = await fetchWasm(m, (r) => ui!.set(r));
      }
      const { FFmpeg } = await import("@ffmpeg/ffmpeg");
      const f = new FFmpeg();
      await f.load({ coreURL: coreUrl, wasmURL: wasmUrl });
      if (fonts.length) {
        await f.createDir("/fonts").catch(() => undefined);
        for (const name of fonts) {
          const r = await fetch(root() + "ffmpeg/fonts/" + name);
          if (r.ok) await f.writeFile("/fonts/" + name, new Uint8Array(await r.arrayBuffer()));
        }
      }
      return f;
    } finally {
      ui?.done();
    }
  })();
  engine.catch(() => (engine = null));
  return engine;
}

let mounts = 0;
/** Make a stored file readable by ffmpeg without copying it (WORKERFS). */
export async function mountInput(f: FFmpeg, path: string): Promise<{ file: string; unmount(): Promise<void> }> {
  const e = getFile(path);
  const dir = `/in${++mounts}`;
  await f.createDir(dir);
  const name = e.name.replace(/[^\w.\-]+/g, "_") || "input";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await f.mount("WORKERFS" as any, { blobs: [{ name, data: e.blob }] }, dir);
  return { file: `${dir}/${name}`, unmount: async () => { await f.unmount(dir).catch(() => undefined); await f.deleteDir(dir).catch(() => undefined); } };
}

const TIME = /time=\s*(-?\d+):(\d+):(\d+(?:\.\d+)?)/;
let cancelled = false;

/** Run ffmpeg. `onProgress` gets 0..1 from the encoder's time= against `outSecs`. */
export async function run(args: string[], o: { outSecs?: number; onProgress?: (r: number) => void } = {}): Promise<string[]> {
  if (busy) throw "Another export is still running in this tab.";
  busy = true;
  cancelled = false;
  const f = await ffmpeg();
  const logs: string[] = [];
  const onLog = ({ message }: { message: string }) => {
    logs.push(message);
    if (logs.length > 200) logs.shift();
    const m = TIME.exec(message);
    if (m && o.outSecs && o.onProgress) {
      const t = +m[1] * 3600 + +m[2] * 60 + +m[3];
      o.onProgress(Math.max(0, Math.min(0.99, t / o.outSecs)));
    }
  };
  f.on("log", onLog);
  try {
    const code = await f.exec(args);
    if (cancelled) throw "Export cancelled";
    if (code !== 0) {
      const err = logs.filter((l) => /error|invalid|unable|no such|failed|not /i.test(l)).slice(-3).join(" ").trim();
      throw err || `ffmpeg exited with code ${code}`;
    }
    o.onProgress?.(1);
    return logs;
  } catch (e) {
    if (cancelled) throw "Export cancelled";
    throw e;
  } finally {
    f.off("log", onLog);
    busy = false;
  }
}

/** Abort the running ffmpeg job. The engine restarts on next use (wasm stays cached). */
export function cancel(): void {
  if (!busy || !engine) return;
  cancelled = true;
  const e = engine;
  engine = null;
  void e.then((f) => f.terminate()).catch(() => undefined);
}

export interface Probe {
  format?: { duration?: string; format_name?: string };
  streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number; r_frame_rate?: string; avg_frame_rate?: string; duration?: string; side_data_list?: { rotation?: number }[]; tags?: { rotate?: string } }[];
}

/** ffprobe a stored file (JSON). */
export async function probe(path: string): Promise<Probe> {
  const f = await ffmpeg();
  const m = await mountInput(f, path);
  try {
    await f.ffprobe(["-v", "error", "-print_format", "json", "-show_format", "-show_streams", m.file, "-o", "/probe.json"]);
    const out = await f.readFile("/probe.json", "utf8");
    await f.deleteFile("/probe.json").catch(() => undefined);
    return JSON.parse(String(out)) as Probe;
  } finally {
    await m.unmount();
  }
}

/** Read an output file out of the wasm FS into a Blob and delete it there. */
export async function take(name: string, type: string): Promise<Blob> {
  const f = await ffmpeg();
  const data = await f.readFile(name);
  await f.deleteFile(name).catch(() => undefined);
  return new Blob([data as unknown as BlobPart], { type });
}

/** Browser-only metadata probe (no engine download): duration and size. */
export function probeElement(url: string): Promise<{ duration: number; width: number; height: number; audio: boolean }> {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    v.onloadedmetadata = () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const a = v as any;
      const audio = a.mozHasAudio ?? (a.webkitAudioDecodedByteCount !== undefined ? true : a.audioTracks ? a.audioTracks.length > 0 : true);
      resolve({ duration: v.duration, width: v.videoWidth, height: v.videoHeight, audio: !!audio });
    };
    v.onerror = () => reject(new Error("unreadable"));
    v.src = url;
  });
}

/** Grab evenly spaced frames from a playable video with <video> + canvas. */
export async function grabFrames(url: string, times: number[], draw: (ctx: CanvasRenderingContext2D, v: HTMLVideoElement, i: number) => void, canvas: HTMLCanvasElement): Promise<void> {
  const v = document.createElement("video");
  v.muted = true;
  v.preload = "auto";
  v.src = url;
  await new Promise<void>((res, rej) => { v.onloadeddata = () => res(); v.onerror = () => rej(new Error("unreadable")); });
  const ctx = canvas.getContext("2d")!;
  for (let i = 0; i < times.length; i++) {
    await new Promise<void>((res) => { v.onseeked = () => res(); v.currentTime = Math.min(Math.max(0, times[i]), Math.max(0, v.duration - 0.05)); });
    draw(ctx, v, i);
  }
  v.removeAttribute("src");
  v.load();
}

/** Codec name from the container header (MP4/MOV sample entry or Matroska
 *  codec id), without loading the engine. Empty when unknown. */
export async function sniffCodec(blob: Blob): Promise<string> {
  const MB = 4 * 1024 * 1024;
  const parts = [blob.slice(0, MB)];
  if (blob.size > MB) parts.push(blob.slice(Math.max(MB, blob.size - MB)));
  const text = (await Promise.all(parts.map((p) => p.arrayBuffer())))
    .map((b) => new TextDecoder("latin1").decode(b))
    .join("");
  const table: [RegExp, string][] = [
    [/avc1|avc3/, "h264"], [/hvc1|hev1/, "hevc"], [/av01|V_AV1/, "av1"], [/vp09|V_VP9/, "vp9"], [/vp08|V_VP8/, "vp8"],
    [/V_MPEG4\/ISO\/AVC/, "h264"], [/V_MPEGH\/ISO\/HEVC/, "hevc"], [/apc[hnsoh]|ap4[hx]/, "prores"], [/mp4v/, "mpeg4"], [/GIF8[79]a/, "gif"],
  ];
  for (const [re, name] of table) if (re.test(text)) return name;
  return "";
}

/** Frame rate of a playable video, measured from decoded frames
 *  (requestVideoFrameCallback), snapped to the usual rates. */
export function measureFps(url: string, timeoutMs = 2500): Promise<{ num: number; den: number } | null> {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rvfc = (v as any).requestVideoFrameCallback?.bind(v);
    if (!rvfc) return resolve(null);
    v.muted = true;
    v.playsInline = true;
    v.src = url;
    const times: number[] = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      v.pause();
      v.removeAttribute("src");
      v.load();
      const d = times.slice(1).map((t, i) => t - times[i]).filter((x) => x > 0.001).sort((a, b) => a - b);
      if (d.length < 3) return resolve(null);
      const fps = 1 / d[Math.floor(d.length / 2)];
      const known: [number, number, number][] = [[24000, 1001, 23.976], [24, 1, 24], [25, 1, 25], [30000, 1001, 29.97], [30, 1, 30], [48, 1, 48], [50, 1, 50], [60000, 1001, 59.94], [60, 1, 60], [120, 1, 120]];
      const best = known.reduce((a, k) => (Math.abs(k[2] - fps) < Math.abs(a[2] - fps) ? k : a));
      resolve(Math.abs(best[2] - fps) / fps < 0.03 ? { num: best[0], den: best[1] } : { num: Math.round(fps * 1000), den: 1000 });
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onFrame = (_: number, m: any) => { times.push(m.mediaTime); if (times.length >= 16) finish(); else rvfc(onFrame); };
    rvfc(onFrame);
    v.play().catch(() => finish());
    setTimeout(finish, timeoutMs);
  });
}
