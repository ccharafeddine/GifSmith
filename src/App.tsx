import { Show } from "solid-js";
import DropZone from "./components/DropZone";
import VideoPlayer from "./components/VideoPlayer";
import ExportPanel from "./components/ExportPanel";
import { filePath, meta } from "./state";
import { formatTimecode } from "./format";
import "./App.css";

function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

function App() {
  return (
    <main class="container">
      <h1>GifSmith</h1>
      <DropZone />

      <Show when={meta()}>
        {(m) => (
          <>
            <section class="file-info">
              <p class="filename">{basename(filePath() ?? "")}</p>
              <p class="meta-line">
                {formatTimecode(m().duration_secs)} &middot; {m().width}&times;
                {m().height} &middot; {(m().fps_num / m().fps_den).toFixed(2)} fps
                &middot; {m().codec} &middot; {m().container}
              </p>
            </section>
            <VideoPlayer />
            <ExportPanel />
          </>
        )}
      </Show>
    </main>
  );
}

export default App;
