import { probeVideo, generateFilmstrip } from "./ipc";
import { filePath, setFilePath, setMeta, setFilmstripSrc, videoEl } from "./state";

/**
 * Load a path as the editor's source: release the previously-open file (so it's
 * no longer locked on disk), store the path, probe its metadata, and kick off
 * the timeline filmstrip in the background. Shared by the DropZone (open / drop /
 * URL) and the Gallery (edit an existing GIF).
 *
 * Rejects if probing fails, clearing the half-loaded path. Callers own their own
 * loading/error UI.
 */
export async function loadSource(path: string): Promise<void> {
  // Release the previously-open source so it's no longer locked on disk.
  const v = videoEl();
  if (v) {
    v.pause();
    v.removeAttribute("src");
    v.load();
  }
  setFilePath(path);
  setMeta(null);
  setFilmstripSrc(null);
  try {
    const m = await probeVideo(path);
    setMeta(m);
    // Build the timeline thumbnail strip in the background (non-blocking).
    // Resolves to a data URI so the <img> loads directly. Guard against a slow
    // strip from a previous load resolving after the source was switched: only
    // apply it if this path is still the active one.
    generateFilmstrip(path, m.duration_secs)
      .then((dataUri) => {
        if (filePath() === path) setFilmstripSrc(dataUri);
      })
      .catch(() => {
        if (filePath() === path) setFilmstripSrc(null);
      });
  } catch (e) {
    setFilePath(null);
    throw e;
  }
}
