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
  [k: string]: unknown;
}
export interface BrowserChoice { id: string; unreliable: boolean }
export interface FetchSettings {
  browserCookies: string | null;
  clipboardWatch: boolean;
  autoUpdate: boolean;
  browsers: BrowserChoice[];
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
export const fetchSettingsSet = (patch: { browserCookies?: string; clipboardWatch?: boolean; autoUpdate?: boolean }) =>
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

/** Short label for a sniffed request. */
export function hitLabel(h: Hit): string {
  const kind = h.kind === "hls" ? "HLS stream" : h.kind === "dash" ? "DASH stream" : "Video file";
  const bits = [kind];
  if (h.height) bits.push(`${h.height}p`);
  if (h.live) bits.push("live");
  const sz = fmtSize(h.size);
  if (sz) bits.push(sz);
  let name = h.url;
  try { const u = new URL(h.url); name = u.host + u.pathname.slice(-40); } catch { /* keep raw */ }
  return `${bits.join(" · ")}: ${name}`;
}

export const LEGAL_NOTE =
  "Only download videos you have the right to save: your own, openly licensed, or with the owner's permission. " +
  "Respect each site's terms of service. DRM-protected video is never saved.";
