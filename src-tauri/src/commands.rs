//! Tauri command handlers. Each returns `Result<T, String>` where the string
//! is a user-facing error message.

use std::io;
use std::path::PathBuf;

use crate::encoder::{export_gif as run_export, ExportParams};
use crate::probe::{parse_ffprobe_json, VideoMeta};
use tauri::{AppHandle, Emitter};
use tauri_plugin_shell::ShellExt;

/// Probe a local video file with the bundled `ffprobe` sidecar and return its
/// normalized metadata.
///
/// # Errors
/// Returns a user-facing message if the sidecar can't be located, ffprobe
/// fails to run or exits non-zero, or its output can't be parsed.
#[tauri::command]
pub async fn probe_video(app: AppHandle, path: String) -> Result<VideoMeta, String> {
    let output = app
        .shell()
        .sidecar("ffprobe")
        .map_err(|e| format!("could not locate the ffprobe sidecar: {e}"))?
        // -v error keeps stdout pure JSON while surfacing real errors on stderr.
        .args([
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_streams",
            "-show_format",
            &path,
        ])
        .output()
        .await
        .map_err(|e| format!("ffprobe failed to start: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "ffprobe could not read this file: {}",
            stderr.trim()
        ));
    }

    let json = String::from_utf8_lossy(&output.stdout);
    parse_ffprobe_json(&json).map_err(|e| format!("could not read video metadata: {e}"))
}

/// Encode the selected slice of the source video to a GIF at `output_path`.
///
/// # Errors
/// Returns a user-facing message if ffmpeg can't be located or run, or if
/// encoding fails.
#[tauri::command]
pub async fn export_gif(app: AppHandle, params: ExportParams) -> Result<(), String> {
    let ffmpeg = ffmpeg_path().map_err(|e| format!("could not locate ffmpeg: {e}"))?;
    // Encoding is blocking and CPU-bound; keep it off the async runtime. Frame
    // progress is emitted to the frontend as "export-progress" (0.0-1.0).
    tauri::async_runtime::spawn_blocking(move || {
        run_export(&ffmpeg, &params, &|p| {
            let _ = app.emit("export-progress", p);
        })
    })
    .await
    .map_err(|e| format!("export task failed to run: {e}"))?
    .map_err(|e| e.to_string())
}

/// Resolve the bundled `ffmpeg` sidecar. Tauri places it next to the app binary
/// when bundled, and next to the dev binary in `target/` during development.
fn ffmpeg_path() -> io::Result<PathBuf> {
    let exe = std::env::current_exe()?;
    let dir = exe
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "current exe has no parent dir"))?;
    let name = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
    Ok(dir.join(name))
}
