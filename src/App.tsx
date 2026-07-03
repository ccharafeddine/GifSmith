import { Show, onMount, onCleanup } from "solid-js";
import DropZone from "./components/DropZone";
import VideoPlayer from "./components/VideoPlayer";
import ExportPanel from "./components/ExportPanel";
import PreviewModal from "./components/PreviewModal";
import Gallery from "./components/Gallery";
import SettingsPanel from "./components/SettingsPanel";
import Logo from "./components/Logo";
import {
  filePath,
  meta,
  previewPath,
  setPreviewPath,
  closeVideo,
  galleryOpen,
  setGalleryOpen,
  settingsOpen,
  setSettingsOpen,
} from "./state";
import { checkOnStartupEnabled, runUpdateCheck } from "./update";
import {
  togglePlayback,
  stepFrame,
  setInAtPlayhead,
  setOutAtPlayhead,
} from "./playback";
import { discardPreview } from "./ipc";
import { formatTimecode } from "./format";
import "./App.css";

function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

// True when the key event targets a typing/slider control we shouldn't hijack.
function isFormControl(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return (
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT" ||
    el.isContentEditable
  );
}

function App() {
  onMount(() => {
    // Opt-in silent update check: run on mount, only surface UI if a newer
    // release exists (open the settings popover so the user sees it).
    if (checkOnStartupEnabled()) {
      void runUpdateCheck().then((status) => {
        if (status === "available") setSettingsOpen(true);
      });
    }

    const onKey = (e: KeyboardEvent) => {
      // Modal open: only Esc, which discards the preview and closes it.
      if (previewPath()) {
        if (e.key === "Escape") {
          e.preventDefault();
          const p = previewPath();
          setPreviewPath(null);
          if (p) void discardPreview(p).catch(() => undefined);
        }
        return;
      }
      // Settings popover open: Esc closes it, otherwise let its controls be.
      if (settingsOpen()) {
        if (e.key === "Escape") {
          e.preventDefault();
          setSettingsOpen(false);
        }
        return;
      }
      // Gallery owns the keyboard while it's open (it has its own listener).
      if (galleryOpen()) return;
      if (isFormControl(e.target) || !meta()) return;

      switch (e.key) {
        case " ":
          e.preventDefault();
          togglePlayback();
          break;
        case "ArrowLeft":
          e.preventDefault();
          stepFrame(-1);
          break;
        case "ArrowRight":
          e.preventDefault();
          stepFrame(1);
          break;
        case "i":
        case "I":
          setInAtPlayhead();
          break;
        case "o":
        case "O":
          setOutAtPlayhead();
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  return (
    <main class="container">
      <header class="app-header">
        <div class="header-spacer" />
        <Logo />
        <div class="header-actions">
          <button
            type="button"
            class="icon-btn"
            title="Gallery"
            aria-label="Gallery"
            onClick={() => setGalleryOpen(true)}
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <path d="M21 15l-5-5L5 21" />
            </svg>
          </button>
          <div class="settings-anchor">
            <button
              type="button"
              class="icon-btn settings-btn"
              classList={{ active: settingsOpen() }}
              title="Settings"
              aria-label="Settings"
              aria-haspopup="dialog"
              aria-expanded={settingsOpen()}
              onClick={() => setSettingsOpen(!settingsOpen())}
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.6"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
            <Show when={settingsOpen()}>
              <SettingsPanel />
            </Show>
          </div>
        </div>
      </header>
      <DropZone />

      <Show
        when={meta()}
        fallback={
          <div class="empty-state">
            Open a video, drop one in, or paste a link to start.
          </div>
        }
      >
        {(m) => (
          <div
            class="editor-single"
            style={{ "--aspect": `${m().width}/${m().height}` }}
          >
            <p class="meta-line">
              <span class="meta-text">
                <span class="filename">{basename(filePath() ?? "")}</span>
                {"  "}
                {formatTimecode(m().duration_secs)} &middot; {m().width}&times;
                {m().height} &middot; {(m().fps_num / m().fps_den).toFixed(2)} fps
                &middot; {m().codec}
              </span>
              <button
                type="button"
                class="close-video"
                title="Close video"
                aria-label="Close video"
                onClick={closeVideo}
              >
                &times;
              </button>
            </p>
            <VideoPlayer />
            <ExportPanel />
          </div>
        )}
      </Show>
      <PreviewModal />
      <Show when={galleryOpen()}>
        <Gallery />
      </Show>
    </main>
  );
}

export default App;
