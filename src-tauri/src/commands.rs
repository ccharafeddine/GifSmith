//! Tauri command handlers. Each returns `Result<T, String>` where the string
//! is a user-facing error message.

use std::io;
use std::path::{Path, PathBuf};

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

/// Encode the selected slice to a GIF in the OS temp dir and return its path,
/// for preview before the user commits to a final location.
///
/// # Errors
/// Returns a user-facing message if ffmpeg can't be located or run, or if
/// encoding fails.
#[tauri::command]
pub async fn export_preview(app: AppHandle, params: ExportParams) -> Result<String, String> {
    let ffmpeg = ffmpeg_path().map_err(|e| format!("could not locate ffmpeg: {e}"))?;
    let temp = std::env::temp_dir().join("gifsmith-preview.gif");
    let out = temp.clone();
    // Encoding is blocking and CPU-bound; keep it off the async runtime. Frame
    // progress is emitted to the frontend as "export-progress" (0.0-1.0).
    tauri::async_runtime::spawn_blocking(move || {
        run_export(&ffmpeg, &params, &out, &|p| {
            let _ = app.emit("export-progress", p);
        })
    })
    .await
    .map_err(|e| format!("export task failed to run: {e}"))?
    .map_err(|e| e.to_string())?;
    Ok(temp.to_string_lossy().into_owned())
}

/// Move a preview GIF from the temp dir to the user's chosen path.
///
/// # Errors
/// Returns a user-facing message if the file can't be moved or copied.
#[tauri::command]
pub fn save_preview(temp_path: String, dest_path: String) -> Result<(), String> {
    let temp = Path::new(&temp_path);
    let dest = Path::new(&dest_path);
    if std::fs::rename(temp, dest).is_ok() {
        return Ok(());
    }
    // rename fails across drives/devices; fall back to copy + delete.
    std::fs::copy(temp, dest).map_err(|e| format!("could not save the GIF: {e}"))?;
    let _ = std::fs::remove_file(temp);
    Ok(())
}

/// Delete a preview GIF the user discarded. Missing file is not an error.
///
/// # Errors
/// Returns a user-facing message if the file exists but can't be deleted.
#[tauri::command]
pub fn discard_preview(temp_path: String) -> Result<(), String> {
    match std::fs::remove_file(&temp_path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("could not delete the preview: {e}")),
    }
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
