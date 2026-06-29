#!/usr/bin/env bash
#
# build-ffmpeg-macos.sh — compile a minimal LGPL ffmpeg + ffprobe from source
# for BOTH macOS architectures (arm64 native + x86_64 cross), and place them in
# src-tauri/binaries with the Rust target-triple suffix Tauri's externalBin
# bundler expects. A Tauri `universal-apple-darwin` build needs a sidecar for
# each arch (aarch64-apple-darwin and x86_64-apple-darwin) and lipo-merges them.
#
# Why compile instead of download: no LGPL static macOS build is published, and
# evermeet.cx (and most prebuilts) are GPL, which conflicts with GifSmith's MIT
# license. Building with --disable-gpl / --disable-nonfree keeps it LGPL. Only
# built-in decoders/demuxers/filters are used (h264/hevc/vp9/av1 decode, fps,
# scale, crop, rawvideo out), so the binary links only macOS system libraries
# and stays portable. See CLAUDE.md "Gotchas" and the release workflow.
#
# Run on an Apple Silicon macOS runner: the arm64 build is native, the x86_64
# build cross-compiles via `clang -arch x86_64` against the universal macOS SDK.

set -euo pipefail

FFMPEG_VERSION="${FFMPEG_VERSION:-7.1}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BIN_DIR="$REPO_ROOT/src-tauri/binaries"

mkdir -p "$BIN_DIR"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"

echo "Downloading ffmpeg ${FFMPEG_VERSION} source..."
curl -fL --retry 3 -o ffmpeg.tar.xz \
  "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz"
tar xf ffmpeg.tar.xz
SRC="$WORK/ffmpeg-${FFMPEG_VERSION}"

# Build one arch into its own out-of-tree dir, then copy the binaries out under
# the matching Rust target triple. $2.. are extra configure args (cross flags).
#
# --enable-videotoolbox makes the macOS system H.264 encoder (h264_videotoolbox)
# an explicit, required part of the build. The playback-proxy command uses it on
# macOS (the from-source ffmpeg has no libopenh264). It's a system framework, so
# this stays LGPL-clean and is available for both arches. Configure fails loudly
# if it can't be enabled.
build_arch() {
  local triple="$1"; shift
  local builddir="$WORK/build-${triple}"
  echo "=== Configuring ffmpeg for ${triple} ==="
  mkdir -p "$builddir"
  cd "$builddir"
  "$SRC/configure" \
    --prefix="$builddir/out" \
    --disable-gpl \
    --disable-nonfree \
    --disable-doc \
    --disable-ffplay \
    --disable-debug \
    --enable-pic \
    --enable-videotoolbox \
    "$@"
  make -j"$(sysctl -n hw.ncpu)"
  make install
  cp "$builddir/out/bin/ffmpeg" "$BIN_DIR/ffmpeg-${triple}"
  cp "$builddir/out/bin/ffprobe" "$BIN_DIR/ffprobe-${triple}"
  chmod +x "$BIN_DIR/ffmpeg-${triple}" "$BIN_DIR/ffprobe-${triple}"
  echo "Built LGPL ffmpeg + ffprobe for ${triple}."
  cd "$WORK"
}

# Native arm64.
build_arch "aarch64-apple-darwin"

# Cross x86_64. --enable-cross-compile skips run-time configure checks (the
# x86_64 test binaries can't execute on the arm64 host); clang targets x86_64
# against the same universal SDK.
build_arch "x86_64-apple-darwin" \
  --enable-cross-compile \
  --arch=x86_64 \
  --target-os=darwin \
  --cc="clang -arch x86_64" \
  --extra-ldflags="-arch x86_64"

echo "All macOS ffmpeg sidecars:"
ls -la "$BIN_DIR"/ffmpeg-*-apple-darwin "$BIN_DIR"/ffprobe-*-apple-darwin
file "$BIN_DIR/ffmpeg-aarch64-apple-darwin" "$BIN_DIR/ffmpeg-x86_64-apple-darwin"
