#!/usr/bin/env bash
#
# build-ffmpeg-macos.sh — compile a minimal LGPL ffmpeg + ffprobe from source
# for the host macOS architecture, and place them in src-tauri/binaries with
# the Rust host target-triple suffix Tauri's externalBin bundler expects.
#
# Why compile instead of download: no LGPL static macOS build is published, and
# evermeet.cx (and most prebuilts) are GPL, which conflicts with GifSmith's MIT
# license. Building with --disable-gpl / --disable-nonfree keeps it LGPL. Only
# built-in decoders/demuxers/filters are used (h264/hevc/vp9/av1 decode, fps,
# scale, crop, rawvideo out), so the binary links only macOS system libraries
# and stays portable. See CLAUDE.md "Gotchas" and the release workflow.
#
# Run on a macOS runner whose native arch matches the target you want.

set -euo pipefail

FFMPEG_VERSION="${FFMPEG_VERSION:-7.1}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BIN_DIR="$REPO_ROOT/src-tauri/binaries"
TRIPLE="$(rustc -vV | sed -n 's/host: //p')"

mkdir -p "$BIN_DIR"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"

echo "Downloading ffmpeg ${FFMPEG_VERSION} source..."
curl -fL --retry 3 -o ffmpeg.tar.xz \
  "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz"
tar xf ffmpeg.tar.xz
cd "ffmpeg-${FFMPEG_VERSION}"

echo "Configuring (LGPL, no external GPL libs)..."
# --enable-videotoolbox makes the macOS system H.264 encoder (h264_videotoolbox)
# an explicit, required part of the build. The playback-proxy command uses it on
# macOS (the from-source ffmpeg has no libopenh264). It's a system framework, so
# this stays LGPL-clean. Configure fails loudly if it can't be enabled.
./configure \
  --prefix="$WORK/out" \
  --disable-gpl \
  --disable-nonfree \
  --disable-doc \
  --disable-ffplay \
  --disable-debug \
  --enable-pic \
  --enable-videotoolbox

make -j"$(sysctl -n hw.ncpu)"
make install

cp "$WORK/out/bin/ffmpeg" "$BIN_DIR/ffmpeg-${TRIPLE}"
cp "$WORK/out/bin/ffprobe" "$BIN_DIR/ffprobe-${TRIPLE}"
chmod +x "$BIN_DIR/ffmpeg-${TRIPLE}" "$BIN_DIR/ffprobe-${TRIPLE}"

echo "Built LGPL ffmpeg + ffprobe for ${TRIPLE}:"
"$BIN_DIR/ffmpeg-${TRIPLE}" -hide_banner -version | head -1
