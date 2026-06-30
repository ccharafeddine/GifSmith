#!/usr/bin/env bash
#
# fetch-ytdlp.sh — download the yt-dlp binary for the host platform into
# src-tauri/binaries with the Rust host target-triple suffix Tauri expects.
# yt-dlp is public domain (Unlicense), so it's MIT-compatible to bundle.
#
# Used to import a video from a URL (the only feature that touches the network).
# The macOS binary is a universal build; we just name it per host triple.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BIN_DIR="$REPO_ROOT/src-tauri/binaries"
TRIPLE="$(rustc -vV | sed -n 's/host: //p')"
BASE="https://github.com/yt-dlp/yt-dlp/releases/latest/download"

mkdir -p "$BIN_DIR"

case "$TRIPLE" in
  *windows*)
    url="$BASE/yt-dlp.exe"
    dest="$BIN_DIR/yt-dlp-${TRIPLE}.exe"
    ;;
  *apple-darwin)
    # yt-dlp_macos is already a fat universal binary. A Tauri universal build
    # wants all three names: the two per-arch sidecars (checked by each per-arch
    # build script) and the universal one (copied at bundle time). The fat
    # binary satisfies every slot, so download once and copy to all three.
    url="$BASE/yt-dlp_macos"
    dest="$BIN_DIR/yt-dlp-universal-apple-darwin"
    darwin_copies="aarch64-apple-darwin x86_64-apple-darwin"
    ;;
  *)
    echo "unsupported host triple: $TRIPLE" >&2
    exit 1
    ;;
esac

echo "Downloading yt-dlp for ${TRIPLE}..."
curl -fL --retry 3 -o "$dest" "$url"
chmod +x "$dest"
echo "placed $(basename "$dest") ($(du -h "$dest" | cut -f1))"

for triple in ${darwin_copies:-}; do
  cp "$dest" "$BIN_DIR/yt-dlp-${triple}"
  chmod +x "$BIN_DIR/yt-dlp-${triple}"
  echo "placed yt-dlp-${triple} (universal copy)"
done
