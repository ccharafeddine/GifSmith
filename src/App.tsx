import { createSignal, Show } from "solid-js";
import { probeVideo, type VideoMeta } from "./ipc";
import "./App.css";

// TEMP (build plan Step 3): hardcoded path to exercise probe_video.
// Replaced by a real file picker in Step 4. Point this at a video on your
// machine before clicking Probe.
const TEMP_VIDEO_PATH = "C:\\Users\\mnc-9\\Videos\\sample.mp4";

function App() {
  const [meta, setMeta] = createSignal<VideoMeta | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  async function probe() {
    setError(null);
    setMeta(null);
    try {
      const result = await probeVideo(TEMP_VIDEO_PATH);
      console.log("probe_video result:", result);
      setMeta(result);
    } catch (e) {
      console.error("probe_video error:", e);
      setError(String(e));
    }
  }

  return (
    <main class="container">
      <h1>GifSmith</h1>
      <p>Step 3 harness: probe a hardcoded video path.</p>
      <p>
        <code>{TEMP_VIDEO_PATH}</code>
      </p>
      <button type="button" onClick={probe}>
        Probe video
      </button>

      <Show when={meta()}>
        {(m) => <pre>{JSON.stringify(m(), null, 2)}</pre>}
      </Show>
      <Show when={error()}>
        <p class="error">{error()}</p>
      </Show>
    </main>
  );
}

export default App;
