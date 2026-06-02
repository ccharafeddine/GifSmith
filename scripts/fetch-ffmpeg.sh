#!/usr/bin/env bash
#
# fetch-ffmpeg.sh — download LGPL FFmpeg + ffprobe sidecars for every target
# triple GifSmith ships on, and place them in src-tauri/binaries/ with the
# {name}-{target-triple} suffix Tauri's externalBin bundler requires.
#
# LGPL ONLY. Do not switch to a GPL build: GifSmith is MIT, and bundling a
# GPL FFmpeg would relicense the distribution. See CLAUDE.md "Gotchas".
#
# Sources:
#   Windows (x86_64-pc-windows-msvc): BtbN static LGPL build.
#     https://github.com/BtbN/FFmpeg-Builds  (ffmpeg-master-latest-win64-lgpl.zip)
#   macOS  (x86_64 + aarch64): TODO — pending licensing decision, see README.
#
# Idempotent: skips a target if its binaries already exist. Pass --force to
# re-download. Run from anywhere; paths resolve relative to the repo root.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BIN_DIR="$REPO_ROOT/src-tauri/binaries"
FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

mkdir -p "$BIN_DIR"

# Place a downloaded executable as binaries/{name}-{triple}{ext}.
# args: <name> <triple> <ext> <src-path>
place() {
  local name="$1" triple="$2" ext="$3" src="$4"
  local dest="$BIN_DIR/${name}-${triple}${ext}"
  cp "$src" "$dest"
  chmod +x "$dest"
  echo "  placed ${name}-${triple}${ext} ($(du -h "$dest" | cut -f1))"
}

have() {
  local name="$1" triple="$2" ext="$3"
  [ -f "$BIN_DIR/${name}-${triple}${ext}" ]
}

# ---------------------------------------------------------------------------
# Windows: x86_64-pc-windows-msvc — BtbN static LGPL (single .exe, no DLLs)
# ---------------------------------------------------------------------------
fetch_windows() {
  local triple="x86_64-pc-windows-msvc" ext=".exe"
  if [ "$FORCE" -eq 0 ] && have ffmpeg "$triple" "$ext" && have ffprobe "$triple" "$ext"; then
    echo "win64-lgpl: already present, skipping (use --force to refresh)"
    return
  fi
  echo "win64-lgpl: downloading BtbN static LGPL build..."
  local url="https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-lgpl.zip"
  local tmp; tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  curl -fL --retry 3 -o "$tmp/win.zip" "$url"
  unzip -q "$tmp/win.zip" -d "$tmp"
  local inner; inner="$(find "$tmp" -name ffmpeg.exe -path '*/bin/*' | head -1)"
  [ -n "$inner" ] || { echo "ERROR: ffmpeg.exe not found in archive" >&2; exit 1; }
  local bindir; bindir="$(dirname "$inner")"
  place ffmpeg  "$triple" "$ext" "$bindir/ffmpeg.exe"
  place ffprobe "$triple" "$ext" "$bindir/ffprobe.exe"
}

# ---------------------------------------------------------------------------
# macOS: x86_64-apple-darwin + aarch64-apple-darwin
# TODO(licensing): no turnkey LGPL static macOS build exists publicly.
# evermeet.cx is GPL (--enable-gpl --enable-libx264). Resolve before the
# macOS release (build plan Step 16). See README "FFmpeg licensing".
# ---------------------------------------------------------------------------
fetch_macos() {
  echo "macOS: SKIPPED — LGPL source not yet decided (see README, build plan Step 16)."
}

fetch_windows
fetch_macos

echo "done. binaries in src-tauri/binaries/"
ls -1 "$BIN_DIR"
