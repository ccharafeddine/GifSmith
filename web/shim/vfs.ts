// In-memory file store for the browser build. Desktop code passes file paths
// around; here a "path" names a Blob that lives only for this tab.
export interface Entry { name: string; blob: Blob; modified: number; url?: string }

const files = new Map<string, Entry>();
let n = 0;

/** Where "saved" files go: the browser's downloads (also listed in galleries). */
export const DOWNLOADS = "/Downloads";

export const basename = (p: string) => p.split(/[\\/]/).pop() ?? p;
export const dirname = (p: string) => p.replace(/[\\/][^\\/]*$/, "") || "/";

/** Store a blob under a fresh path that keeps its file name. */
export function addFile(blob: Blob, name: string, dir = "/browser"): string {
  const path = `${dir}/${++n}/${name}`;
  files.set(path, { name, blob, modified: Date.now() });
  return path;
}

/** Store (or replace) a blob at an exact path. */
export function putFile(path: string, blob: Blob): string {
  const old = files.get(path);
  if (old?.url) URL.revokeObjectURL(old.url);
  files.set(path, { name: basename(path), blob, modified: Date.now() });
  return path;
}

export function hasFile(path: string): boolean { return files.has(path); }

export function getFile(path: string): Entry {
  const e = files.get(path);
  if (!e) throw `File not found: ${basename(path)}. Open it again in this tab.`;
  return e;
}

export function urlFor(path: string): string {
  const e = files.get(path);
  if (!e) return path;
  e.url ??= URL.createObjectURL(e.blob);
  return e.url;
}

export function removeFile(path: string): void {
  const e = files.get(path);
  if (e?.url) URL.revokeObjectURL(e.url);
  files.delete(path);
}

/** Entries directly or indirectly under `dir`, newest first. */
export function listDir(dir: string): [string, Entry][] {
  const pre = dir.endsWith("/") ? dir : dir + "/";
  return [...files].filter(([p]) => p.startsWith(pre)).sort((a, b) => b[1].modified - a[1].modified);
}

/** Hand a blob to the browser as a download. */
export function download(blob: Blob, name: string): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
}
