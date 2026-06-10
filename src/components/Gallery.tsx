import {
  createSignal,
  createMemo,
  createEffect,
  onMount,
  onCleanup,
  Show,
  For,
} from "solid-js";
import { createStore } from "solid-js/store";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  listExports,
  getExportsDir,
  galleryThumbnail,
  type ExportEntry,
} from "../ipc";
import { loadSource } from "../source";
import { setGalleryOpen } from "../state";
import { storedExportsDir, setStoredExportsDir } from "../settings";

// How many thumbnails to show on each side of the centered one in the scroller.
const WINDOW = 3;

/**
 * Full-screen gallery over the editor: reads the Exports folder, plays the
 * selected GIF in the center, and shows a scroller of first-frame thumbnails
 * (current one centered, a few before and after). Clicking the viewer or the
 * Edit button on the centered thumbnail loads that GIF back into the editor.
 */
export default function Gallery() {
  const [entries, setEntries] = createSignal<ExportEntry[]>([]);
  const [selected, setSelected] = createSignal(0);
  const [loading, setLoading] = createSignal(true);
  const [editing, setEditing] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  // The folder the gallery reads from. Resolved on mount from the saved setting,
  // falling back to the backend default.
  const [dir, setDir] = createSignal<string>(storedExportsDir() ?? "");

  // Lazy thumbnail cache: source path -> PNG data URI. Fetched per visible item.
  const [thumbs, setThumbs] = createStore<Record<string, string>>({});
  const pending = new Set<string>();

  function ensureThumb(path: string) {
    if (thumbs[path] || pending.has(path)) return;
    pending.add(path);
    galleryThumbnail(path)
      .then((uri) => setThumbs(path, uri))
      .catch(() => undefined)
      .finally(() => pending.delete(path));
  }

  const current = () => entries()[selected()];

  // Compact display for the folder path: the last two segments, keeping the
  // platform separator, e.g. "/Users/me/dev/GifSmith/Exports" -> ".../GifSmith/
  // Exports" and "C:\Users\me\GifSmith\Exports" -> "...\GifSmith\Exports". Full
  // path lives in the button's tooltip.
  const shortDir = () => {
    const d = dir();
    const sep = d.includes("\\") && !d.includes("/") ? "\\" : "/";
    const parts = d.split(/[\\/]/).filter(Boolean);
    return parts.length <= 2 ? d : `…${sep}${parts.slice(-2).join(sep)}`;
  };

  // The clamped slice of entries shown in the scroller, each with its real index.
  const windowItems = createMemo(() => {
    const list = entries();
    if (!list.length) return [];
    const start = Math.max(0, selected() - WINDOW);
    const end = Math.min(list.length - 1, selected() + WINDOW);
    const items: { entry: ExportEntry; index: number }[] = [];
    for (let i = start; i <= end; i += 1) items.push({ entry: list[i], index: i });
    return items;
  });

  // Fetch thumbnails for whatever is currently visible as the selection moves.
  createEffect(() => {
    for (const item of windowItems()) ensureThumb(item.entry.path);
  });

  function step(delta: number) {
    const list = entries();
    if (!list.length) return;
    setSelected((s) => Math.min(list.length - 1, Math.max(0, s + delta)));
  }

  function close() {
    setGalleryOpen(false);
  }

  // Load the selected GIF back into the editor as a new source. Stay open (the
  // gallery covers the editor) until the probe resolves, so a failure surfaces
  // here instead of dumping the user into an empty editor.
  async function editCurrent() {
    const entry = current();
    if (!entry || editing()) return;
    setEditing(true);
    setError(null);
    try {
      await loadSource(entry.path);
      setGalleryOpen(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setEditing(false);
    }
  }

  // (Re)list the GIFs in `d`, resetting the selection to the newest.
  function loadEntries(d: string) {
    setLoading(true);
    setError(null);
    listExports(d)
      .then((list) => {
        setEntries(list);
        setSelected(0);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }

  // Pick a new exports folder from Finder; persist it and reload the gallery.
  async function chooseFolder() {
    let picked: string | string[] | null;
    try {
      picked = await open({ directory: true, defaultPath: dir() || undefined });
    } catch (e) {
      setError(String(e));
      return;
    }
    if (typeof picked !== "string" || picked === dir()) return;
    setStoredExportsDir(picked);
    setDir(picked);
    loadEntries(picked);
  }

  onMount(() => {
    // Resolve the effective folder: the saved setting, else the backend default.
    const stored = storedExportsDir();
    if (stored) {
      setDir(stored);
      loadEntries(stored);
    } else {
      getExportsDir()
        .then((def) => {
          setDir(def);
          loadEntries(def);
        })
        .catch((e) => {
          setError(String(e));
          setLoading(false);
        });
    }

    const onKey = (e: KeyboardEvent) => {
      switch (e.key) {
        case "Escape":
          e.preventDefault();
          close();
          break;
        case "ArrowLeft":
          e.preventDefault();
          step(-1);
          break;
        case "ArrowRight":
          e.preventDefault();
          step(1);
          break;
        case "Enter":
          e.preventDefault();
          void editCurrent();
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  return (
    <div class="gallery">
      <header class="gallery-bar">
        <button
          type="button"
          class="gallery-folder"
          title={`Reading from ${dir()}\nClick to choose a different folder`}
          onClick={() => void chooseFolder()}
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          </svg>
          <span class="gallery-folder-path">{shortDir()}</span>
        </button>
        <span class="gallery-title">{current()?.name ?? ""}</span>
        <div class="gallery-bar-end">
          <button
            type="button"
            class="gallery-close"
            title="Close gallery"
            aria-label="Close gallery"
            onClick={close}
          >
            &times;
          </button>
        </div>
      </header>

      <Show
        when={!loading()}
        fallback={<div class="gallery-empty">Loading exports...</div>}
      >
        <Show
          when={entries().length > 0}
          fallback={
            <div class="gallery-empty">
              No exports yet. Export a GIF and it shows up here.
            </div>
          }
        >
          <div class="gallery-viewer">
            <button
              type="button"
              class="gallery-nav gallery-nav-prev"
              aria-label="Previous"
              onClick={() => step(-1)}
              disabled={selected() === 0}
            >
              &lsaquo;
            </button>
            <Show when={current()}>
              {(entry) => (
                <img
                  class="gallery-viewer-img"
                  src={convertFileSrc(entry().path)}
                  alt={entry().name}
                  title="Click to edit this GIF"
                  onClick={() => void editCurrent()}
                />
              )}
            </Show>
            <button
              type="button"
              class="gallery-nav gallery-nav-next"
              aria-label="Next"
              onClick={() => step(1)}
              disabled={selected() === entries().length - 1}
            >
              &rsaquo;
            </button>
          </div>

          <Show when={error()}>
            <p class="error gallery-error">{error()}</p>
          </Show>

          <div class="gallery-scroller">
            <For each={windowItems()}>
              {(item) => (
                <div
                  class="gallery-thumb"
                  classList={{ active: item.index === selected() }}
                  onClick={() => setSelected(item.index)}
                >
                  <Show
                    when={thumbs[item.entry.path]}
                    fallback={<div class="gallery-thumb-ph" />}
                  >
                    <img src={thumbs[item.entry.path]} alt={item.entry.name} />
                  </Show>
                  <Show when={item.index === selected()}>
                    <button
                      type="button"
                      class="gallery-edit"
                      disabled={editing()}
                      onClick={(e) => {
                        e.stopPropagation();
                        void editCurrent();
                      }}
                    >
                      {editing() ? "Opening..." : "Edit"}
                    </button>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </Show>
      </Show>
    </div>
  );
}
