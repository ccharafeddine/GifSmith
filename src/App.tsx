import { Show, onMount, onCleanup } from "solid-js";
import DropZone from "./components/DropZone";
import VideoPlayer from "./components/VideoPlayer";
import ExportPanel from "./components/ExportPanel";
import PreviewModal from "./components/PreviewModal";
import Logo from "./components/Logo";
import { filePath, meta, previewPath, setPreviewPath } from "./state";
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
        <Logo />
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
              <span class="filename">{basename(filePath() ?? "")}</span>
              {"  "}
              {formatTimecode(m().duration_secs)} &middot; {m().width}&times;
              {m().height} &middot; {(m().fps_num / m().fps_den).toFixed(2)} fps
              &middot; {m().codec}
            </p>
            <VideoPlayer />
            <ExportPanel />
          </div>
        )}
      </Show>
      <PreviewModal />
    </main>
  );
}

export default App;
