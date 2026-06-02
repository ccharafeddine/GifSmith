import { Show } from "solid-js";
import DropZone from "./components/DropZone";
import { filePath, meta } from "./state";
import "./App.css";

function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

function formatDuration(secs: number): string {
  const total = Math.round(secs);
  const mins = Math.floor(total / 60);
  const rem = total % 60;
  return `${mins}:${rem.toString().padStart(2, "0")}`;
}

function App() {
  return (
    <main class="container">
      <h1>GifSmith</h1>
      <DropZone />

      <Show when={meta()}>
        {(m) => (
          <section class="file-info">
            <p class="filename">{basename(filePath() ?? "")}</p>
            <p class="meta-line">
              {formatDuration(m().duration_secs)} &middot; {m().width}&times;
              {m().height} &middot; {(m().fps_num / m().fps_den).toFixed(2)} fps
              &middot; {m().codec} &middot; {m().container}
            </p>
          </section>
        )}
      </Show>
    </main>
  );
}

export default App;
