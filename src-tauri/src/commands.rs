//! Tauri command handlers. Each returns `Result<T, String>` where the string
//! is a user-facing error message.

use std::io;
use std::path::{Path, PathBuf};

use crate::encoder::{export_gif as run_export, ExportParams};
use crate::probe::{parse_ffprobe_json, VideoMeta};
use base64::Engine;
use tauri::{AppHandle, Emitter};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

/// Temp path of the preview GIF.
fn preview_path() -> PathBuf {
    std::env::temp_dir().join("gifsmith-preview.gif")
}

/// Temp dir for URL downloads.
fn download_dir() -> PathBuf {
    std::env::temp_dir().join("gifsmith-dl")
}

/// Temp path of the timeline filmstrip image.
fn filmstrip_path() -> PathBuf {
    std::env::temp_dir().join("gifsmith-filmstrip.png")
}

/// Remove any leftover playback-proxy files (uniquely named, so glob by prefix).
fn remove_proxy_files() {
    if let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with("gifsmith-proxy") && name.ends_with(".mp4") {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}

/// Best-effort removal of all temp files GifSmith may have written. Call on exit.
pub fn cleanup_temp() {
    let _ = std::fs::remove_file(preview_path());
    let _ = std::fs::remove_file(filmstrip_path());
    let _ = std::fs::remove_dir_all(download_dir());
    remove_proxy_files();
}

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
#[derive(serde::Serialize)]
pub struct PreviewResult {
    pub path: String,
    pub bytes: u64,
}

#[tauri::command]
pub async fn export_preview(
    app: AppHandle,
    params: ExportParams,
) -> Result<PreviewResult, String> {
    let ffmpeg = ffmpeg_path().map_err(|e| format!("could not locate ffmpeg: {e}"))?;
    let temp = preview_path();
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
    let bytes = std::fs::metadata(&temp).map(|m| m.len()).unwrap_or(0);
    Ok(PreviewResult {
        path: temp.to_string_lossy().into_owned(),
        bytes,
    })
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

/// Parse a yt-dlp progress line like "[download]  12.3% of ..." into 0.0-1.0.
fn parse_download_percent(line: &str) -> Option<f64> {
    let idx = line.find('%')?;
    let prefix = &line[..idx];
    let start = prefix.rfind(char::is_whitespace).map_or(0, |i| i + 1);
    prefix[start..]
        .trim()
        .parse::<f64>()
        .ok()
        .map(|p| (p / 100.0).clamp(0.0, 1.0))
}

/// Build a horizontal thumbnail strip for the timeline and return its temp path.
/// Samples `COUNT` frames evenly across the clip and tiles them into one PNG.
///
/// # Errors
/// Returns a user-facing message if ffmpeg can't be located or run.
#[tauri::command]
pub async fn generate_filmstrip(
    app: AppHandle,
    path: String,
    duration_secs: f64,
) -> Result<String, String> {
    const COUNT: u32 = 24;
    const HEIGHT: u32 = 144;
    let dur = if duration_secs > 0.05 { duration_secs } else { 1.0 };
    let temp = filmstrip_path();
    let temp_str = temp.to_string_lossy().into_owned();

    // Fast keyframe seeks: open the file once per thumbnail at evenly spaced
    // timestamps (-ss before -i = keyframe seek, no full decode), center-crop
    // each, then hstack into one strip. Stays fast on hour-long videos.
    let mut args: Vec<String> = vec!["-y".into(), "-v".into(), "error".into()];
    for i in 0..COUNT {
        let t = (f64::from(i) + 0.5) * dur / f64::from(COUNT);
        args.push("-ss".into());
        args.push(format!("{t:.3}"));
        args.push("-an".into());
        args.push("-i".into());
        args.push(path.clone());
    }
    let mut fc = String::new();
    for i in 0..COUNT {
        fc.push_str(&format!(
            "[{i}:v]crop=min(iw\\,ih*0.7):ih,scale=-2:{HEIGHT},setsar=1[v{i}];"
        ));
    }
    for i in 0..COUNT {
        fc.push_str(&format!("[v{i}]"));
    }
    fc.push_str(&format!("hstack=inputs={COUNT}[out]"));
    args.extend([
        "-filter_complex".into(),
        fc,
        "-map".into(),
        "[out]".into(),
        "-frames:v".into(),
        "1".into(),
        temp_str.clone(),
    ]);

    let output = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| format!("could not locate ffmpeg: {e}"))?
        .args(args)
        .output()
        .await
        .map_err(|e| format!("ffmpeg failed to start: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("could not build filmstrip: {}", stderr.trim()));
    }

    // Return a data URI so the <img> loads without touching the asset protocol.
    let bytes = std::fs::read(&temp).map_err(|e| format!("could not read filmstrip: {e}"))?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:image/png;base64,{b64}"))
}

/// Transcode a lightweight H.264 proxy (libopenh264, ~640px) for codecs the
/// webview can't decode (HEVC, ProRes, ...). Playback uses this proxy; export
/// still uses the original. Returns the proxy file path. Full decode, so it's
/// slow on long videos.
///
/// # Errors
/// Returns a user-facing message if ffmpeg can't be located or transcoding fails.
#[tauri::command]
pub async fn generate_proxy(app: AppHandle, path: String) -> Result<String, String> {
    remove_proxy_files();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let out = std::env::temp_dir().join(format!("gifsmith-proxy-{nanos}.mp4"));
    let out_str = out.to_string_lossy().into_owned();

    let output = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| format!("could not locate ffmpeg: {e}"))?
        .args([
            "-y",
            "-v",
            "error",
            "-an",
            "-i",
            &path,
            "-vf",
            "scale=640:-2",
            "-c:v",
            "libopenh264",
            "-b:v",
            "2500k",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            &out_str,
        ])
        .output()
        .await
        .map_err(|e| format!("ffmpeg failed to start: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("could not build preview: {}", stderr.trim()));
    }
    Ok(out_str)
}

/// Download a video from a URL with the bundled `yt-dlp` sidecar into the OS
/// temp dir and return its path. Emits "download-progress" events (0.0-1.0).
///
/// # Errors
/// Returns a user-facing message if yt-dlp can't be located or run, the
/// download fails, or no file is produced.
#[tauri::command]
pub async fn download_video(app: AppHandle, url: String) -> Result<String, String> {
    let dir = download_dir();
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not prepare download folder: {e}"))?;
    let template = dir.join("source.%(ext)s");

    let mut args: Vec<String> = vec![
        "--no-playlist".into(),
        "--no-part".into(),
        "--newline".into(),
        "-f".into(),
        // Prefer an H.264 mp4 the webview can play; fall back to anything.
        "bestvideo[height<=1080][ext=mp4][vcodec^=avc1]/bestvideo[height<=1080][ext=mp4]/best[ext=mp4]/best".into(),
        "-o".into(),
        template.to_string_lossy().into_owned(),
    ];
    // Let yt-dlp use our ffmpeg for any remux/merge it needs.
    if let Some(dir) = ffmpeg_path().ok().and_then(|p| p.parent().map(PathBuf::from)) {
        args.push("--ffmpeg-location".into());
        args.push(dir.to_string_lossy().into_owned());
    }
    args.push(url);

    let (mut rx, _child) = app
        .shell()
        .sidecar("yt-dlp")
        .map_err(|e| format!("could not locate yt-dlp: {e}"))?
        .args(args)
        .spawn()
        .map_err(|e| format!("yt-dlp failed to start: {e}"))?;

    let mut errors = String::new();
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                if let Some(p) = parse_download_percent(&String::from_utf8_lossy(&bytes)) {
                    let _ = app.emit("download-progress", p);
                }
            }
            CommandEvent::Stderr(bytes) => {
                let line = String::from_utf8_lossy(&bytes);
                if let Some(p) = parse_download_percent(&line) {
                    let _ = app.emit("download-progress", p);
                } else {
                    errors.push_str(&line);
                }
            }
            CommandEvent::Error(e) => errors.push_str(&e),
            CommandEvent::Terminated(payload) if payload.code != Some(0) => {
                return Err(format!("download failed: {}", errors.trim()));
            }
            _ => {}
        }
    }

    let file = std::fs::read_dir(&dir)
        .map_err(|e| format!("could not read download folder: {e}"))?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .find(|p| p.is_file());
    match file {
        Some(p) => Ok(p.to_string_lossy().into_owned()),
        None => Err("the download produced no file".to_string()),
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
