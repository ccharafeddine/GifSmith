# GifSmith

A small, fast desktop app for turning a slice of a video into a high-quality
animated GIF. Open a local video, scrub to pick start and end points, optionally
crop, tweak the output, and export a `.gif`. No accounts, no library, no
telemetry, no ads. Your source video is read in place and never imported.

Built with [Tauri](https://v2.tauri.app), [SolidJS](https://www.solidjs.com),
and the [gifski](https://github.com/ImageOptim/gifski) encoder, with a bundled
LGPL build of [FFmpeg](https://ffmpeg.org) for decoding.

<!-- Screenshots (light + dark) go here. -->

## Features

- Open `mp4`, `mov`, `mkv`, `webm`, `avi`, `m4v` via file picker or drag-and-drop
- iOS-style trim handles over a **zoomable** timeline (zoom down to a 30-second
  window for precise short clips)
- **Crop** with a draggable, resizable rectangle (tracked in source pixels)
- **Boomerang** (play forward then reversed), with live preview
- FPS, width, and quality controls
- Preview the result before committing: **Save**, **Re-export**, or **Discard**
- High-quality `gifski` encoding, streamed frame-by-frame with no intermediate
  files written
- Light/dark theme that follows your OS
- Native binaries for macOS and Windows

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Space` | Play / pause |
| `←` / `→` | Step one source frame |
| `I` / `O` | Set the IN / OUT point at the playhead |
| `Esc` | Close the preview |
| Scroll over the timeline | Zoom in / out (cursor-anchored) |

## Install

Download the latest installer from the
[Releases](https://github.com/ccharafeddine/GifSmith/releases) page:

- **Windows**: the `.msi` (or setup `.exe`). Windows SmartScreen may warn on an
  unsigned app; choose **More info → Run anyway**.
- **macOS**: the `.dmg` for your chip (Apple Silicon or Intel). The app is
  unsigned, so the first launch needs the Gatekeeper workaround:

  > **Right-click** (or Control-click) the app in Applications → **Open** →
  > **Open** again in the dialog. You only need to do this once.

## Build from source

Prerequisites: [Node.js](https://nodejs.org) 20+ and the
[Rust toolchain](https://rustup.rs).

```bash
npm install

# Fetch the FFmpeg + ffprobe sidecars.
# Windows: downloads the BtbN LGPL static build.
bash scripts/fetch-ffmpeg.sh
# macOS: compile an LGPL build from source instead (no LGPL prebuilt exists):
bash scripts/build-ffmpeg-macos.sh

# Run in development
npm run tauri dev

# Produce a production build for the current platform
npm run tauri build
```

## FFmpeg licensing

GifSmith is MIT licensed and bundles an **LGPL** build of FFmpeg, invoked as a
separate sidecar process (never linked into the app).

- **Windows**: the LGPL static build from
  [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds), fetched
  unmodified by `scripts/fetch-ffmpeg.sh`.
- **macOS**: compiled from the official [FFmpeg](https://ffmpeg.org/download.html)
  source with `--disable-gpl --disable-nonfree` by `scripts/build-ffmpeg-macos.sh`,
  because no LGPL static macOS build is published.

The bundled FFmpeg is licensed under the LGPL; its source is available at
<https://ffmpeg.org/download.html>.

## License

[MIT](LICENSE) © Chafic Charafeddine. The bundled FFmpeg binaries are LGPL, as
noted above.
