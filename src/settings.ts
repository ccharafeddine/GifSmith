// User-chosen exports folder, persisted in the webview's localStorage. When
// unset, the backend falls back to its default (dev: the project Exports folder,
// release: <Documents>/GifSmith/Exports). Both the gallery (read) and the save
// dialog default share this, so they always point at the same folder.

const KEY = "exportsDir";

/** The configured exports folder, or null if the user hasn't chosen one. */
export function storedExportsDir(): string | null {
  return localStorage.getItem(KEY);
}

/** Persist the user's chosen exports folder. */
export function setStoredExportsDir(dir: string): void {
  localStorage.setItem(KEY, dir);
}
