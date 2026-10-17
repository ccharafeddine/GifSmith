// Desktop-only link downloads (shared smith-fetch engine). The web demo has no
// backend for any of this; callers gate the UI with isTauri().
import { invoke } from "@tauri-apps/api/core";

export interface DownloadOptions {
  format?: string | null;
  playlist?: boolean;
  live?: boolean;
  liveFromStart?: boolean;
  referer?: string | null;
  headers?: [string, string][];
}
export interface FetchResult { path: string; files: string[]; folder: string | null }
export interface FormatChoice { spec: string; label: string; height: number; filesize: number | null }
export interface MediaInfo {
  title: string;
  extractor: string;
  isLive: boolean;
  duration: number | null;
  playlistCount: number | null;
  formats: FormatChoice[];
}
export interface Hit {
  url: string;
  kind: "hls" | "dash" | "file" | "segment";
  pageUrl: string;
  headers: [string, string][];
  size: number | null;
  height: number;
  live?: boolean;
  drm?: boolean;
  /** Seconds, when the manifest says. */
  duration?: number | null;
  /** `size` is duration × bitrate, not a byte count. */
  estimated?: boolean;
  likelyAd?: boolean;
  /** Caught by the minimum-size / duration filter or an ad host. */
  hidden?: boolean;
  hiddenReason?: "ad" | "small" | "short" | null;
  [k: string]: unknown;
}
export interface BrowserChoice { id: string; unreliable: boolean }
export interface FetchSettings {
  browserCookies: string | null;
  clipboardWatch: boolean;
  autoUpdate: boolean;
  browsers: BrowserChoice[];
  /** Browse list: hide media under this many MB (0 = off). */
  sniffMinMb: number;
  sniffMinMbPresets: number[];
}
export interface FetchSettingsPatch {
  browserCookies?: string;
  clipboardWatch?: boolean;
  autoUpdate?: boolean;
  sniffMinMb?: number;
}
export interface SavedSite { site: string; cookies: number }
export interface ToolsStatus {
  ytdlpVersion: string | null;
  ytdlpSource: string;
  ytdlpChecked: number;
  denoVersion: string | null;
  autoUpdate: boolean;
}

/** Errors that need the user to sign in to the site start with this. */
export const SIGNIN_PREFIX = "[signin] ";

export const fetchDownload = (url: string, options?: DownloadOptions) =>
  invoke<FetchResult>("fetch_download", { url, options: options ?? null });
export const fetchProbe = (url: string, options?: DownloadOptions) =>
  invoke<MediaInfo>("fetch_probe", { url, options: options ?? null });
export const fetchDownloadHit = (hit: Hit, options?: DownloadOptions) =>
  invoke<FetchResult>("fetch_download_hit", { hit, options: options ?? null });
export const cancelFetch = () => invoke<void>("cancel_download");
export const stopRecording = () => invoke<void>("stop_recording");
export const browseOpen = (url: string) => invoke<void>("browse_open", { url });
export const browseClose = () => invoke<void>("browse_close");
export const browseSaveSignin = () => invoke<string[]>("browse_save_signin");
export const cookiesList = () => invoke<SavedSite[]>("cookies_list");
export const cookiesForget = (site?: string) => invoke<void>("cookies_forget", { site: site ?? null });
export const cookiesImport = (path: string) => invoke<string[]>("cookies_import", { path });
export const fetchSettingsGet = () => invoke<FetchSettings>("fetch_settings_get");
export const fetchSettingsSet = (patch: FetchSettingsPatch) =>
  invoke<FetchSettings>("fetch_settings_set", { patch });
export const toolsStatus = () => invoke<ToolsStatus>("tools_status");
export const toolsUpdateNow = () => invoke<{ updated: boolean; version: string | null }>("tools_update_now");

/** Human size, e.g. "12.3 MB". */
export function fmtSize(n: number | null | undefined): string {
  if (!n) return "";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
}

/** Duration as m:ss or h:mm:ss. */
export function fmtDuration(s: number | null | undefined): string {
  if (s == null || !Number.isFinite(s) || s <= 0) return "";
  const t = Math.round(s);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/** "~1.2 GB" for an estimate, "1.2 GB" for a real size, "size unknown". */
export function hitSize(h: Hit): string {
  const sz = fmtSize(h.size);
  if (!sz) return h.live ? "" : "size unknown";
  return h.estimated ? `~${sz}` : sz;
}

/** Kind, resolution, live, size and duration of a sniffed request. */
export function hitFacts(h: Hit): string {
  const kind = h.kind === "hls" ? "HLS stream" : h.kind === "dash" ? "DASH stream" : "Video file";
  const bits = [kind];
  if (h.height) bits.push(`${h.height}p`);
  if (h.live) bits.push("live");
  const sz = hitSize(h);
  if (sz) bits.push(sz);
  const d = fmtDuration(h.duration);
  if (d) bits.push(d);
  if (h.likelyAd) bits.push("ad server");
  return bits.join(" · ");
}

/** Host and the tail of the path. */
export function hitName(h: Hit): string {
  try { const u = new URL(h.url); return u.host + u.pathname.slice(-40); } catch { return h.url; }
}

/** Short label for a sniffed request. */
export function hitLabel(h: Hit): string {
  return `${hitFacts(h)}: ${hitName(h)}`;
}

/** Label for a minimum-size preset. */
export const minSizeLabel = (mb: number) => (mb ? `${mb} MB` : "Off");

export const LEGAL_NOTE =
  "Only download videos you have the right to save: your own, openly licensed, or with the owner's permission. " +
  "Respect each site's terms of service. DRM-protected video is never saved.";
