# CLAUDE.md — GifSmith

## Project

GifSmith is a standalone desktop app for Mac and Windows that converts a slice of a video file into a high-quality animated GIF. The user opens a local video, scrubs a timeline to pick start and end points (with optional crop), tweaks output settings, and exports a `.gif` to disk.

### Hard constraints

- No media library, no cache, no telemetry, no ads, no accounts.
- Source video is read in place from disk, never copied or imported into the app.
- Encoding pipeline writes zero intermediate files. The only file written is the final `.gif` at the user's chosen path (plus an optional preview GIF in OS temp, deleted on app close).
- Single codebase, cross-platform via Tauri.
- MIT licensed.

## Stack (locked)

| Layer | Choice | Why |
|---|---|---|
| Shell | Tauri 2.x | Native binary, ~10MB, system webview |
| Frontend | SolidJS + TypeScript + Vite | Fine-grained reactivity, ideal for 60fps timeline scrubbing |
| Styling | Plain CSS with custom properties | Light/dark via `prefers-color-scheme`, no framework overhead |
| Video decode | Bundled FFmpeg (LGPL) as Tauri sidecar | Universal format support |
| GIF encode | `gifski` Rust crate, in-process | Best-quality GIF encoder available, no subprocess overhead |
| Build/release | GitHub Actions + `tauri-action` | Auto-builds `.dmg` and `.msi` on tag push |

## Pipeline

Export does NOT write intermediate frame files. FFmpeg streams raw RGBA frames to stdout, Rust reads them into `ImgVec` buffers, `gifski`'s `Collector` consumes them on one thread while its `Writer` encodes on another.

```
ffmpeg -ss {in} -to {out} -i {path} \
  -vf "fps={fps},scale={w}:-1:flags=lanczos[,crop=...]" \
  -f rawvideo -pix_fmt rgba pipe:1
   │
   ▼  (raw RGBA8 bytes, w*h*4 per frame)
Rust reader loop
   │
   ▼
gifski::Collector::add_frame_rgba(idx, ImgVec, pts_secs)
   │
   ▼
gifski::Writer::write(File::create(output_path), &Settings)
```

## Project structure

```
gifsmith/
├── CLAUDE.md
├── README.md
├── LICENSE                       # MIT
├── package.json
├── vite.config.ts
├── tsconfig.json
├── index.html
├── src/                          # SolidJS frontend
│   ├── index.tsx
│   ├── App.tsx
│   ├── state.ts                  # Solid signals: filePath, meta, in, out, fps, width, quality, crop, bounce
│   ├── ipc.ts                    # Tauri invoke wrappers, typed
│   ├── styles.css                # CSS variables, theme tokens
│   └── components/
│       ├── DropZone.tsx
│       ├── VideoPlayer.tsx
│       ├── Timeline.tsx
│       ├── CropOverlay.tsx
│       ├── ExportPanel.tsx
│       └── PreviewModal.tsx
├── src-tauri/
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── binaries/                 # FFmpeg sidecars, populated by scripts/fetch-ffmpeg
│   │   ├── ffmpeg-x86_64-pc-windows-msvc.exe
│   │   ├── ffmpeg-aarch64-apple-darwin
│   │   ├── ffmpeg-x86_64-apple-darwin
│   │   └── ffprobe-...           # same target triples
│   └── src/
│       ├── main.rs
│       ├── commands.rs           # probe_video, export_gif, save_preview
│       ├── probe.rs              # ffprobe JSON parse → VideoMeta
│       └── encoder.rs            # ffmpeg-stdout → gifski pipeline
├── scripts/
│   └── fetch-ffmpeg.sh           # downloads LGPL FFmpeg + ffprobe for all target triples
└── .github/workflows/
    └── release.yml               # tauri-action, builds on tag
```

## Commands

```bash
# First-time setup
npm install
bash scripts/fetch-ffmpeg.sh

# Dev (hot reload frontend, recompile Rust on change)
npm run tauri dev

# Production build for current platform
npm run tauri build

# Frontend-only dev (no Tauri, useful for component work)
npm run dev

# Rust tests
cd src-tauri && cargo test

# Rust lint
cd src-tauri && cargo clippy --all-targets -- -D warnings
```

## Conventions

### TypeScript / Solid

- Use `createSignal` and `createMemo` for state. Avoid stores unless state grows past ~10 signals.
- Components are functions. Use `<Show>`, `<For>`, `<Switch>` from `solid-js` instead of ternaries and `.map()` in JSX.
- File names: `PascalCase.tsx` for components, `camelCase.ts` for everything else.
- Strict TypeScript. No `any`. Use `unknown` and narrow.
- Side effects in `createEffect`. Cleanup via `onCleanup` or the returned function.
- Never destructure props at the top of a component, it kills reactivity. Use `props.foo` inside JSX.

### Rust

- Edition 2021. `rustfmt` defaults. `clippy::pedantic` warnings on, treated as errors in CI.
- Errors with `thiserror` (library code) and `anyhow` (command handlers).
- Tauri commands return `Result<T, String>` where the string is a user-facing error message.
- No `.unwrap()` in command paths. `.expect()` only with a message explaining the invariant.
- Long-running commands accept a `tauri::AppHandle` and emit progress events (`window.emit("export-progress", ...)`) that the frontend listens for.

### CSS

- One stylesheet at `src/styles.css`. CSS custom properties for colors, spacing, radii.
- Light/dark via `@media (prefers-color-scheme: dark)` overriding the same custom properties.
- No CSS-in-JS, no Tailwind, no PostCSS plugins beyond Vite defaults.

### Aesthetic

Minimal and native. Clean lines, generous spacing, system font stack (`-apple-system, "Segoe UI", system-ui, sans-serif`). Reference [sindresorhus/Gifski](https://github.com/sindresorhus/Gifski) for visual restraint. Avoid gradients, glassmorphism, and drop shadows beyond a 1-2px ambient layer.

Token starting point (light, dark inverts the same tokens):

```css
:root {
  --bg: #ffffff;
  --bg-elev: #f5f5f7;
  --fg: #1d1d1f;
  --fg-muted: #6e6e73;
  --accent: #007aff;
  --border: #d2d2d7;
  --radius: 8px;
  --space: 8px;
}
```

## Build plan

Each step ends with something runnable. Commit at the end of each step.

1. **Scaffold.** `npm create tauri-app@latest gifsmith`, choose Solid + TypeScript. Verify `npm run tauri dev` opens a blank window. Commit.
2. **FFmpeg sidecars.** Write `scripts/fetch-ffmpeg.sh` that downloads LGPL builds of `ffmpeg` and `ffprobe` for `x86_64-pc-windows-msvc`, `x86_64-apple-darwin`, and `aarch64-apple-darwin`, placing them in `src-tauri/binaries/` with Tauri's required `{name}-{target-triple}` suffix. For Mac use evermeet.cx, for Windows use BtbN's lgpl-shared release. Configure `tauri.conf.json` `bundle.externalBin`. Verify dev build runs without sidecar errors.
3. **probe_video command.** Rust command that spawns `ffprobe -v quiet -print_format json -show_streams -show_format`, parses the JSON, returns `VideoMeta { duration_secs, width, height, fps_num, fps_den, codec, container }`. Add a temporary button in the UI that calls it on a hardcoded path and logs the result.
4. **DropZone + file picker.** Replace the temp button with a real file open dialog via `@tauri-apps/plugin-dialog`. On select, store path in a signal, call `probe_video`, store meta. Show file name and duration.
5. **VideoPlayer.** When a path is loaded, render `<video src={convertFileSrc(path)}>` with custom play/pause controls and a seekbar bound to `currentTime`. No trim handles yet.
6. **Timeline trim handles.** Build `<Timeline>` with two draggable handles (IN, OUT) layered over the seekbar. Constrain `in < out`. Update signals on drag. Loop playback between IN and OUT.
7. **Export pipeline, minimum viable.** Rust `export_gif` command: trim only, fixed 15 fps, fixed 480px width, default gifski quality. Add Export button that opens a save dialog and runs the command. Verify the GIF plays correctly in a browser.
8. **ExportPanel.** Side panel with FPS slider (5-30), width slider (240-1080), quality slider (1-100). Wire to signals, pass into the command.
9. **Progress events.** Encoder emits `export-progress` events with a 0.0-1.0 float (`frames_done / total_frames`). Frontend shows a progress bar in the panel during export.
10. **PreviewModal.** Export writes to OS temp first, modal shows the result in an `<img>`, user clicks Save (moves file to chosen path), Re-export (back to editor with current settings), or Discard (deletes temp).
11. **Frame stepping.** Keyboard: `←`/`→` step by `1 / source_fps` seconds when video is focused. `Space` toggles play. `I` sets IN at playhead, `O` sets OUT at playhead. `Esc` closes any modal.
12. **Crop overlay.** Toggleable `<CropOverlay>` component, draggable + resizable rectangle over the video, tracked internally in source pixel coordinates. Feed into ffmpeg's `crop=W:H:X:Y` filter (applied before `scale`).
13. **Bounce loop.** Checkbox in panel. When enabled, encoder buffers all frames in memory, then feeds them forward followed by reversed (skipping the first and last reversed frames to avoid duplicate seam frames). Warn user if estimated peak RAM exceeds 2 GB.
14. **Drag-and-drop.** Listen for Tauri's file drop event on the window. Accept the first dropped file if its extension is in the allowlist (mp4, mov, mkv, webm, avi, m4v).
15. **Theming.** Add CSS custom properties for light and dark, override via `@media (prefers-color-scheme: dark)`. Test on both Mac and Windows.
16. **Release workflow.** `.github/workflows/release.yml` using `tauri-apps/tauri-action`. Builds on git tag push (`v*`), creates a draft GitHub Release with `.dmg` and `.msi` attached.
17. **README + screenshots.** Install instructions, the Mac Gatekeeper right-click-Open workaround, FFmpeg LGPL note, screenshots in light and dark mode.

## Gotchas

- **FFmpeg licensing.** Bundle the LGPL build only. A GPL FFmpeg would force the whole app to GPL, conflicting with MIT. Document the bundled FFmpeg's license in README.
- **Mac code signing.** Without a $99/yr Apple Developer ID, the `.dmg` triggers Gatekeeper. README must include the right-click-Open workaround. Windows is unsigned-friendly enough for a personal project, SmartScreen warning is the worst case.
- **Webview codec support.** `<video>` plays what the OS supports. H.264 MP4 works everywhere. HEVC, VP9, AV1 are spotty on the player side even though FFmpeg can decode them for export. If a video loads metadata but won't play, defer "proxy mode" (transcode a low-bitrate preview for playback only) to v2.
- **gifski API shape.** `Collector::add_frame_rgba(frame_index, ImgVec<RGBA8>, presentation_timestamp_seconds)` on the reader thread. `Writer::write(writer, &settings)` blocks on a worker thread. Spawn writer first, then drop the Collector when done feeding, which signals end-of-stream.
- **Bounce memory.** 10s of 720p at 30fps in bounce ≈ 600 frames × 720 × 1280 × 4 bytes ≈ 2.6 GB peak RAM. Pre-flight estimate; warn if > 2 GB.
- **Sidecar path naming.** Tauri requires sidecar binaries named `{base}-{target-triple}` exactly. Easy to typo. Trust the script.
- **convertFileSrc on Windows.** Backslashes must round-trip cleanly. Always pass the path the file dialog returned, never one you constructed from parts.
- **Solid reactivity gotcha.** Destructuring props loses reactivity. Use `props.foo` directly inside JSX or wrap in `createMemo`.
- **FFmpeg `-ss` placement.** Put `-ss` BEFORE `-i` for fast seek (keyframe-accurate but quick). Put it AFTER `-i` for frame-accurate slow seek. Use both: `-ss {in_minus_2s} -i {path} -ss 2 -to {duration}` for fast + accurate.

## Coding standards

These apply to all generated code, commit messages, and explanations.

- Think in first principles. Be direct. Skip affirmations and filler.
- No em dashes anywhere. Use commas, periods, colons, parens.
- No watery language. No "it's not about X it's about Y" constructions. No "here's the kicker".
- Useful over polite. When wrong, say so and show the correction.
- Self-critique every response, fix weaknesses, show only the final version.
- Reason at full depth, step by step.
- Cite every external claim or source.
- Humanize all output. Prefer plain words over jargon when both work.

### Commit style

`type: short imperative summary` on one line, ≤72 chars. Types: `feat`, `fix`, `refactor`, `chore`, `docs`, `build`, `test`. For larger commits, blank line then prose explaining the why.

```
feat: add timeline trim handles
fix: prevent IN handle from passing OUT
refactor: move encoder pipeline into its own module
chore: bump tauri to 2.1.1
```

### When stuck

Stop and ask. Don't paper over with `.unwrap()`, `any`, or `// TODO: figure out why this works` comments. If a step's assumption breaks (FFmpeg outputs unexpected bytes, gifski API changed, Solid signal isn't updating), surface it instead of patching around it.

## References

- Tauri 2 docs: https://v2.tauri.app
- Tauri sidecar guide: https://v2.tauri.app/develop/sidecar/
- Tauri file dialog plugin: https://v2.tauri.app/plugin/dialog/
- SolidJS docs: https://www.solidjs.com/docs/latest
- gifski crate: https://crates.io/crates/gifski
- gifski source / examples: https://github.com/ImageOptim/gifski
- FFmpeg LGPL builds (Windows): https://github.com/BtbN/FFmpeg-Builds/releases
- FFmpeg builds (Mac, signed for arm64 + x86_64): https://evermeet.cx/ffmpeg/
- FFmpeg filters reference: https://ffmpeg.org/ffmpeg-filters.html
- tauri-action release workflow: https://github.com/tauri-apps/tauri-action
