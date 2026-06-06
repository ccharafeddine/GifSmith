//! Tauri command handlers. Each returns `Result<T, String>` where the string
//! is a user-facing error message.

use std::io;
use std::path::{Path, PathBuf};

use crate::encoder::{export_gif as run_export, ExportParams};
use crate::probe::{parse_ffprobe_json, VideoMeta};
use base64::Engine;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
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

/// Shared flag the running export polls so the frontend can cancel it.
#[derive(Default)]
pub struct ExportCancel(pub Arc<AtomicBool>);

/// Request the in-progress export to abort.
#[tauri::command]
pub fn cancel_export(cancel: State<'_, ExportCancel>) {
    cancel.0.store(true, Ordering::SeqCst);
}

/// User-facing message returned when a download is cancelled. The frontend
/// matches on this to swallow the error instead of showing it.
const DOWNLOAD_CANCELLED: &str = "Download cancelled.";

/// Shared flag the running URL download polls so the frontend can cancel it.
#[derive(Default)]
pub struct DownloadCancel(pub Arc<AtomicBool>);

/// Request the in-progress URL download to abort.
#[tauri::command]
pub fn cancel_download(cancel: State<'_, DownloadCancel>) {
    cancel.0.store(true, Ordering::SeqCst);
}

/// Resolve once `flag` is set. Used to race a download await against a cancel
/// request so a stalled fetch (no bytes, no events) can still be aborted.
async fn cancelled(flag: &AtomicBool) {
    while !flag.load(Ordering::SeqCst) {
        tokio::time::sleep(std::time::Duration::from_millis(120)).await;
    }
}

#[tauri::command]
pub async fn export_preview(
    app: AppHandle,
    cancel: State<'_, ExportCancel>,
    params: ExportParams,
) -> Result<PreviewResult, String> {
    let ffmpeg = ffmpeg_path().map_err(|e| format!("could not locate ffmpeg: {e}"))?;
    let temp = preview_path();
    let out = temp.clone();
    let flag = cancel.0.clone();
    flag.store(false, Ordering::SeqCst);
    // Encoding is blocking and CPU-bound; keep it off the async runtime. Frame
    // progress is emitted to the frontend as "export-progress" (0.0-1.0).
    tauri::async_runtime::spawn_blocking(move || {
        run_export(
            &ffmpeg,
            &params,
            &out,
            &|p| {
                let _ = app.emit("export-progress", p);
            },
            &flag,
        )
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

/// Resolve the default export location: `<Documents>/GifSmith/Exports/<filename>`.
/// The folder is created on demand here (only when the user is about to save),
/// never at startup. The frontend falls back to a bare filename on error.
///
/// # Errors
/// Returns a user-facing message if the Documents directory can't be resolved or
/// the export folder can't be created.
#[tauri::command]
pub fn default_save_path(app: AppHandle, filename: String) -> Result<String, String> {
    let docs = app
        .path()
        .document_dir()
        .map_err(|e| format!("could not find your Documents folder: {e}"))?;
    // create_dir_all builds both levels (GifSmith and Exports) if missing.
    let dir = docs.join("GifSmith").join("Exports");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("could not create the GifSmith export folder: {e}"))?;
    Ok(dir.join(filename).to_string_lossy().into_owned())
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

    // H.264 encoder choice is platform-specific, both LGPL-clean (no libx264):
    // - macOS: our from-source ffmpeg has no libopenh264, so use the always-present,
    //   hardware-accelerated h264_videotoolbox.
    // - Windows: the BtbN LGPL build ships libopenh264.
    #[cfg(target_os = "macos")]
    let vcodec = "h264_videotoolbox";
    #[cfg(not(target_os = "macos"))]
    let vcodec = "libopenh264";

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
            vcodec,
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

/// Extensions GifSmith treats as a direct video-file link (mirrors the frontend
/// allowlist in DropZone.tsx).
const VIDEO_EXTENSIONS: [&str; 6] = ["mp4", "mov", "mkv", "webm", "avi", "m4v"];

/// Classify a URL as a direct media link: if its path component ends in a known
/// video extension (query string ignored), return that lowercased extension.
/// Such links are fetched over plain HTTP rather than routed through yt-dlp.
fn direct_media_extension(url: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(url).ok()?;
    let ext = Path::new(parsed.path())
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_lowercase)?;
    VIDEO_EXTENSIONS.contains(&ext.as_str()).then_some(ext)
}

/// Stream a direct media link to `download_dir()/source.<ext>` over plain HTTP.
/// Reuses the download dir so app-close cleanup already covers it. Emits
/// "download-progress" from Content-Length when present; with no Content-Length
/// it stays silent rather than emitting a fake value.
async fn download_direct(
    app: &AppHandle,
    url: &str,
    ext: &str,
    cancel: &AtomicBool,
) -> Result<String, String> {
    use std::io::Write;

    let dir = download_dir();
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not prepare download folder: {e}"))?;
    let out = dir.join(format!("source.{ext}"));

    let mut resp = reqwest::get(url)
        .await
        .map_err(|_| "Couldn't reach that link. Check the URL and your connection.".to_string())?;
    if !resp.status().is_success() {
        return Err(format!("the server returned {} for that link", resp.status()));
    }

    let total = resp.content_length();
    let mut downloaded: u64 = 0;
    let mut file =
        std::fs::File::create(&out).map_err(|e| format!("could not save the download: {e}"))?;
    // Race each chunk read against the cancel flag so even a stalled connection
    // (bytes never arrive) aborts promptly instead of hanging.
    loop {
        let chunk = tokio::select! {
            biased;
            () = cancelled(cancel) => {
                drop(file);
                let _ = std::fs::remove_dir_all(&dir);
                return Err(DOWNLOAD_CANCELLED.to_string());
            }
            chunk = resp.chunk() => chunk
                .map_err(|_| "the download was interrupted before it finished".to_string())?,
        };
        let Some(chunk) = chunk else { break };
        file.write_all(&chunk)
            .map_err(|e| format!("could not write the download: {e}"))?;
        downloaded += chunk.len() as u64;
        if let Some(total) = total.filter(|t| *t > 0) {
            let p = (downloaded as f64 / total as f64).clamp(0.0, 1.0);
            let _ = app.emit("download-progress", p);
        }
    }

    Ok(out.to_string_lossy().into_owned())
}

/// Map a yt-dlp stderr dump to a clear, user-facing message. Raw stderr is kept
/// only as a one-line fallback for failures we don't specifically recognize.
fn friendly_ytdlp_error(stderr: &str) -> String {
    let lower = stderr.to_lowercase();
    if lower.contains("unsupported url") {
        "This site isn't supported. Try downloading the video yourself and opening the file, or paste a direct link to a video file.".to_string()
    } else if lower.contains("unable to download webpage")
        || lower.contains("failed to resolve")
        || lower.contains("getaddrinfo")
        || lower.contains("connection")
        || lower.contains("timed out")
        || lower.contains("network is unreachable")
        || lower.contains("http error")
    {
        "Couldn't reach that link. Check the URL and your connection.".to_string()
    } else {
        let summary = stderr
            .lines()
            .map(str::trim)
            .rfind(|l| !l.is_empty())
            .unwrap_or("");
        if summary.is_empty() {
            "Download failed.".to_string()
        } else {
            format!("Download failed: {summary}")
        }
    }
}

/// Download a video from a URL and return its local path. Direct links to a
/// video file are fetched over plain HTTP; everything else goes through the
/// bundled `yt-dlp` sidecar. Emits "download-progress" events (0.0-1.0).
///
/// # Errors
/// Returns a user-facing message if the download can't start, fails, or
/// produces no file.
#[tauri::command]
pub async fn download_video(
    app: AppHandle,
    cancel: State<'_, DownloadCancel>,
    url: String,
) -> Result<String, String> {
    let flag = cancel.0.clone();
    flag.store(false, Ordering::SeqCst);

    // Direct file links skip yt-dlp entirely: a plain streaming GET is faster and
    // works even for hosts yt-dlp has no extractor for.
    if let Some(ext) = direct_media_extension(&url) {
        return download_direct(&app, &url, &ext, &flag).await;
    }

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

    // MAINTAINER NOTE: the bundled yt-dlp goes stale as sites change their
    // players; refresh it (scripts/fetch-ytdlp.sh) on every release build or URL
    // extraction will start failing in the wild. Also tracked in progress.txt.
    let (mut rx, child) = app
        .shell()
        .sidecar("yt-dlp")
        .map_err(|e| format!("could not locate yt-dlp: {e}"))?
        .args(args)
        .spawn()
        .map_err(|e| format!("yt-dlp failed to start: {e}"))?;

    let mut errors = String::new();
    loop {
        // Race the next yt-dlp event against the cancel flag. recv() blocks while
        // yt-dlp is stalled, so polling the flag inside the loop alone wouldn't
        // cancel a hang; select! lets the cancel branch fire regardless.
        let event = tokio::select! {
            biased;
            () = cancelled(&flag) => {
                let _ = child.kill();
                let _ = std::fs::remove_dir_all(&dir);
                return Err(DOWNLOAD_CANCELLED.to_string());
            }
            event = rx.recv() => match event {
                Some(event) => event,
                None => break,
            },
        };
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
                return Err(friendly_ytdlp_error(&errors));
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

#[cfg(test)]
mod tests {
    use super::{direct_media_extension, friendly_ytdlp_error};

    #[test]
    fn detects_direct_media_links() {
        assert_eq!(
            direct_media_extension("https://x.com/clip.mp4").as_deref(),
            Some("mp4")
        );
        // Query string is ignored, extension is lowercased.
        assert_eq!(
            direct_media_extension("https://x.com/path/Clip.MOV?token=abc&t=1").as_deref(),
            Some("mov")
        );
    }

    #[test]
    fn rejects_non_media_links() {
        // A watch page, not a file: must fall through to yt-dlp.
        assert_eq!(direct_media_extension("https://youtube.com/watch?v=abc"), None);
        // Unsupported extension.
        assert_eq!(direct_media_extension("https://x.com/clip.gif"), None);
        // No extension at all.
        assert_eq!(direct_media_extension("https://x.com/video"), None);
        // Not a parseable URL.
        assert_eq!(direct_media_extension("not a url"), None);
    }

    #[test]
    fn maps_unsupported_url_error() {
        let msg = friendly_ytdlp_error("ERROR: Unsupported URL: https://example.com/x");
        assert!(msg.starts_with("This site isn't supported"));
    }

    #[test]
    fn maps_network_error() {
        let msg = friendly_ytdlp_error("ERROR: Unable to download webpage: timed out");
        assert_eq!(msg, "Couldn't reach that link. Check the URL and your connection.");
    }

    #[test]
    fn falls_back_to_last_stderr_line() {
        let msg = friendly_ytdlp_error("some noise\n\nERROR: the thing exploded\n");
        assert_eq!(msg, "Download failed: ERROR: the thing exploded");
    }
}
