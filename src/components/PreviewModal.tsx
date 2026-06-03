import { createSignal, Show } from "solid-js";
import { convertFileSrc } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { savePreview, discardPreview } from "../ipc";
import {
  previewPath,
  setPreviewPath,
  previewVersion,
  previewBytes,
} from "../state";

function formatSize(bytes: number): string {
  const mb = bytes / 1024 ** 2;
  return mb >= 100 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}

/**
 * Shows the just-encoded GIF (from the OS temp dir) and lets the user commit
 * it (Save), go back to tweak settings (Re-export), or throw it away (Discard).
 */
export default function PreviewModal() {
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);

  // Cache-busting query so re-exporting to the same temp path reloads the img.
  const src = () => {
    const p = previewPath();
    return p ? `${convertFileSrc(p)}?v=${previewVersion()}` : "";
  };

  async function onSave() {
    const p = previewPath();
    if (!p) return;
    setError(null);

    let dest: string | null;
    try {
      dest = await save({
        filters: [{ name: "GIF", extensions: ["gif"] }],
        defaultPath: "export.gif",
      });
    } catch (e) {
      setError(String(e));
      return;
    }
    if (!dest) return; // user cancelled the save dialog, keep the modal open

    setBusy(true);
    try {
      await savePreview(p, dest);
      setPreviewPath(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  // Back to the editor; the temp file is reused/overwritten on the next export.
  function onReexport() {
    setPreviewPath(null);
  }

  async function onDiscard() {
    const p = previewPath();
    setPreviewPath(null);
    if (p) await discardPreview(p).catch(() => undefined);
  }

  return (
    <Show when={previewPath()}>
      <div class="modal-overlay">
        <div class="modal">
          <img class="preview-img" src={src()} alt="GIF preview" />
          <p class="preview-size">{formatSize(previewBytes())}</p>
          <Show when={error()}>
            <p class="error">{error()}</p>
          </Show>
          <div class="modal-actions">
            <button
              type="button"
              class="primary"
              onClick={onSave}
              disabled={busy()}
            >
              Save
            </button>
            <button type="button" onClick={onReexport} disabled={busy()}>
              Re-export
            </button>
            <button type="button" onClick={onDiscard} disabled={busy()}>
              Discard
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}
