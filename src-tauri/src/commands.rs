//! Tauri command handlers. Each returns `Result<T, String>` where the string
//! is a user-facing error message.

use std::io;
use std::path::{Path, PathBuf};

use crate::encoder::{export_gif as run_export, ExportParams};
use crate::probe::{parse_ffprobe_json, VideoMeta};
use crate::scrape::{self, MediaKind};
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

/// Temp dir holding cached gallery thumbnails (first-frame PNGs).
fn thumbs_dir() -> PathBuf {
    std::env::temp_dir().join("gifsmith-thumbs")
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
    let _ = std::fs::remove_dir_all(thumbs_dir());
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

/// Resolve the export folder path. Does not create it: callers that need it on
/// disk (e.g. `default_save_path`) create it themselves; readers (e.g.
/// `list_exports`) treat a missing folder as empty.
///
/// In dev builds this is the project's own `Exports/` folder (so the gallery and
/// the save default point at your working set). Release builds use
/// `<Documents>/GifSmith/Exports`. Both save and gallery share this, so they
/// always agree.
fn exports_dir(app: &AppHandle) -> Result<PathBuf, String> {
    // CARGO_MANIFEST_DIR is baked in at compile time as `<project>/src-tauri`;
    // its parent is the project root. Gated on debug_assertions so shipped
    // builds never reference a path that won't exist on the user's machine.
    if cfg!(debug_assertions) {
        if let Some(root) = Path::new(env!("CARGO_MANIFEST_DIR")).parent() {
            return Ok(root.join("Exports"));
        }
    }
    let docs = app
        .path()
        .document_dir()
        .map_err(|e| format!("could not find your Documents folder: {e}"))?;
    Ok(docs.join("GifSmith").join("Exports"))
}

/// Return the effective default exports folder (dev: the project `Exports/`,
/// release: `<Documents>/GifSmith/Exports`) so the gallery can show it on first
/// run before the user has chosen one.
///
/// # Errors
/// Returns a user-facing message if the default folder can't be resolved.
#[tauri::command]
pub fn get_exports_dir(app: AppHandle) -> Result<String, String> {
    Ok(exports_dir(&app)?.to_string_lossy().into_owned())
}

/// Resolve the default save path `<dir>/<filename>`, where `dir` is the user's
/// configured exports folder (passed from the frontend) or the default when
/// unset. The folder is created on demand here, never at startup. The frontend
/// falls back to a bare filename on error.
///
/// # Errors
/// Returns a user-facing message if the folder can't be resolved or created.
#[tauri::command]
pub fn default_save_path(
    app: AppHandle,
    filename: String,
    dir: Option<String>,
) -> Result<String, String> {
    let dir = match dir {
        Some(d) => PathBuf::from(d),
        None => exports_dir(&app)?,
    };
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("could not create the export folder: {e}"))?;
    Ok(dir.join(filename).to_string_lossy().into_owned())
}

/// One GIF in the gallery: file name, absolute path, byte size, and mtime
/// (unix seconds, used to sort newest-first).
#[derive(serde::Serialize)]
pub struct ExportEntry {
    pub name: String,
    pub path: String,
    pub bytes: u64,
    pub modified: u64,
}

/// List the `.gif` files in the export folder, newest first, for the gallery.
/// `dir` is the user's configured exports folder (passed from the frontend) or
/// the default when unset. A missing folder is not an error: it yields an empty
/// list.
///
/// # Errors
/// Returns a user-facing message if the default folder can't be resolved or the
/// directory exists but can't be read.
#[tauri::command]
pub fn list_exports(app: AppHandle, dir: Option<String>) -> Result<Vec<ExportEntry>, String> {
    let dir = match dir {
        Some(d) => PathBuf::from(d),
        None => exports_dir(&app)?,
    };
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let entries =
        std::fs::read_dir(&dir).map_err(|e| format!("could not read the export folder: {e}"))?;
    let mut gifs: Vec<ExportEntry> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let is_gif = path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("gif"));
        if !is_gif {
            continue;
        }
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_secs());
        gifs.push(ExportEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: path.to_string_lossy().into_owned(),
            bytes: meta.len(),
            modified,
        });
    }
    gifs.sort_by_key(|g| std::cmp::Reverse(g.modified));
    Ok(gifs)
}

/// First-frame thumbnail for a gallery GIF, returned as a PNG data URI. Cached
/// on disk (keyed by source path + mtime) so repeat opens skip ffmpeg. The
/// scroller uses these light stills instead of the full ~15 MB animated GIFs.
///
/// # Errors
/// Returns a user-facing message if ffmpeg can't be located or run, or the
/// thumbnail can't be read.
#[tauri::command]
pub async fn gallery_thumbnail(app: AppHandle, path: String) -> Result<String, String> {
    use std::hash::{Hash, Hasher};

    let mtime = std::fs::metadata(&path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_secs());
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut hasher);
    mtime.hash(&mut hasher);
    let cache = thumbs_dir().join(format!("{:x}.png", hasher.finish()));

    if !cache.exists() {
        std::fs::create_dir_all(thumbs_dir())
            .map_err(|e| format!("could not prepare the thumbnail folder: {e}"))?;
        let cache_str = cache.to_string_lossy().into_owned();
        // First frame only, scaled to 160px tall (even width via -2).
        let output = app
            .shell()
            .sidecar("ffmpeg")
            .map_err(|e| format!("could not locate ffmpeg: {e}"))?
            .args([
                "-y",
                "-v",
                "error",
                "-i",
                &path,
                "-frames:v",
                "1",
                "-vf",
                "scale=-2:160",
                &cache_str,
            ])
            .output()
            .await
            .map_err(|e| format!("ffmpeg failed to start: {e}"))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("could not build thumbnail: {}", stderr.trim()));
        }
    }

    let bytes = std::fs::read(&cache).map_err(|e| format!("could not read thumbnail: {e}"))?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:image/png;base64,{b64}"))
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
    let dur = if duration_secs > 0.05 {
        duration_secs
    } else {
        1.0
    };
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

/// True if `url` parses as an http or https URL. Any other scheme (`file`,
/// `ftp`, `javascript`, ...) is rejected before it can reach reqwest or yt-dlp,
/// so a paste can only ever trigger a network fetch of a web resource.
fn is_http_url(url: &str) -> bool {
    reqwest::Url::parse(url).is_ok_and(|u| matches!(u.scheme(), "http" | "https"))
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

/// Hard cap on any single URL download (runaway disk guard), in bytes and in
/// yt-dlp's `--max-filesize` syntax.
const MAX_DOWNLOAD_BYTES: u64 = 16 * 1024 * 1024 * 1024;
const MAX_DOWNLOAD_YTDLP: &str = "16G";

/// Parse the seconds value out of an ffmpeg progress line's `time=HH:MM:SS.xx`
/// field. Returns `None` for lines without a parseable timestamp (e.g. `N/A`).
fn parse_progress_time(s: &str) -> Option<f64> {
    let idx = s.rfind("time=")?;
    let token: String = s[idx + 5..]
        .chars()
        .take_while(|c| !c.is_whitespace())
        .collect();
    let mut parts = token.split(':');
    let h: f64 = parts.next()?.parse().ok()?;
    let m: f64 = parts.next()?.parse().ok()?;
    let sec: f64 = parts.next()?.parse().ok()?;
    Some((h * 3600.0 + m * 60.0 + sec).max(0.0))
}

/// User-facing message for a page neither yt-dlp nor the fallback scraper could
/// find a video on.
const UNSUPPORTED_SITE: &str = "This site isn't supported. Try downloading the video yourself and opening the file, or paste a direct link to a video file.";

/// True when yt-dlp failed because it has no extractor for the page (or its
/// generic extractor found nothing): the cue to try the HTML scraper fallback.
/// Network/HTTP failures are deliberately excluded - scraping won't fix those.
fn ytdlp_unsupported(stderr: &str) -> bool {
    let lower = stderr.to_lowercase();
    lower.contains("unsupported url") || lower.contains("no video formats found")
}

/// Browser-like UA for the scrape fallback: many sites serve a stripped page
/// (or a 403) to non-browser clients.
const SCRAPE_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/// Cap on how much page HTML the scrape fallback reads.
const MAX_SCRAPE_HTML_BYTES: usize = 5 * 1024 * 1024;

/// Cap on an HLS master playlist read (they're a few KB in practice).
const MAX_PLAYLIST_BYTES: usize = 2 * 1024 * 1024;

/// Most media candidates the scrape fallback will try per page.
const MAX_SCRAPE_ATTEMPTS: usize = 3;

/// Most embedded players (iframes / embed URLs) the fallback will follow. Each
/// gets one yt-dlp attempt and one scrape of the embed page (depth 2 max; the
/// embed page's own iframes are not followed), which bounds total time.
const MAX_EMBEDS: usize = 3;

/// Protocols ffmpeg may open for a scraped stream: network only, so a crafted
/// playlist can't make it read local files (`file:`) or spawn anything.
const STREAM_PROTOCOLS: &str = "http,https,tcp,tls,crypto";

/// yt-dlp format selection, source quality with no resolution cap or codec
/// preference: the best video-only stream + best audio (merged), else the best
/// single file that already has audio, else any video + audio. Video-only first
/// avoids merging a muxed file with a second copy of its own audio (`bv*+ba`
/// produced two audio tracks on single-file sites).
const YTDLP_FORMAT: &str = "bv*[acodec=none]+ba/b/bv*+ba";

/// yt-dlp format sort: highest resolution, then frame rate, then bitrate.
const YTDLP_SORT: &str = "res,fps,br";

/// Merge container: mp4 when the codecs fit (H.264/AAC, and modern VP9/AV1/Opus
/// too), mkv otherwise - so no format is ever downgraded to fit a container.
const YTDLP_MERGE: &str = "mp4/mkv";

/// Build the yt-dlp argument list. `referer` is sent for embed URLs (many
/// players are domain-locked to the page that embeds them).
fn ytdlp_args(
    template: &str,
    ffmpeg_location: Option<&str>,
    referer: Option<&str>,
    url: &str,
) -> Vec<String> {
    let mut args: Vec<String> = vec![
        // Ignore any user/global yt-dlp config so a planted config file can't
        // inject options (e.g. --exec); cap the size as a runaway disk guard.
        "--ignore-config".into(),
        "--max-filesize".into(),
        MAX_DOWNLOAD_YTDLP.into(),
        "--no-playlist".into(),
        "--no-part".into(),
        "--newline".into(),
        "--socket-timeout".into(),
        "20".into(),
        "-f".into(),
        YTDLP_FORMAT.into(),
        "-S".into(),
        YTDLP_SORT.into(),
        "--merge-output-format".into(),
        YTDLP_MERGE.into(),
        "-o".into(),
        template.into(),
    ];
    if let Some(loc) = ffmpeg_location {
        // Let yt-dlp use our ffmpeg for any remux/merge it needs.
        args.push("--ffmpeg-location".into());
        args.push(loc.into());
    }
    if let Some(r) = referer.filter(|r| is_http_url(r)) {
        args.push("--referer".into());
        args.push(r.into());
    }
    // End-of-options: everything after `--` is a positional URL, never a flag.
    args.push("--".into());
    args.push(url.into());
    args
}

/// `scheme://host[:port]` of a URL, for an `Origin` header.
fn origin_of(url: &str) -> Option<String> {
    let u = reqwest::Url::parse(url).ok()?;
    let origin = u.origin().ascii_serialization();
    (origin != "null").then_some(origin)
}

/// HTTP client for scraped fetches: browser UA, plus Referer/Origin of the page
/// the media was found on (hosts commonly reject hotlinks without them).
fn scrape_client(referer: Option<&str>, timeout: Option<u64>) -> Result<reqwest::Client, String> {
    let mut headers = reqwest::header::HeaderMap::new();
    if let Some(r) = referer {
        if let Ok(v) = reqwest::header::HeaderValue::from_str(r) {
            headers.insert(reqwest::header::REFERER, v);
        }
        if let Some(o) = origin_of(r).and_then(|o| reqwest::header::HeaderValue::from_str(&o).ok())
        {
            headers.insert(reqwest::header::ORIGIN, o);
        }
    }
    let mut b = reqwest::Client::builder()
        .user_agent(SCRAPE_USER_AGENT)
        .default_headers(headers)
        .connect_timeout(std::time::Duration::from_secs(20));
    if let Some(t) = timeout {
        b = b.timeout(std::time::Duration::from_secs(t));
    }
    b.build()
        .map_err(|e| format!("could not start the page fetch: {e}"))
}

/// Parse ffmpeg's input `Duration: HH:MM:SS.xx,` header into seconds. Live
/// streams report `N/A`, which yields `None` (no progress is emitted then).
fn parse_ffmpeg_duration(s: &str) -> Option<f64> {
    let idx = s.find("Duration:")?;
    let rest = s[idx + "Duration:".len()..].trim_start();
    let field = rest.split([',', ' ', '\n', '\r']).next()?;
    let mut parts = field.split(':');
    let h: f64 = parts.next()?.parse().ok()?;
    let m: f64 = parts.next()?.parse().ok()?;
    let sec: f64 = parts.next()?.parse().ok()?;
    let total = h * 3600.0 + m * 60.0 + sec;
    (total > 0.0).then_some(total)
}

/// Fetch a page/playlist as text: browser UA (+ Referer/Origin), 20s timeout,
/// and a size cap (excess is truncated, not an error - a partial page still
/// parses). Races the read against the cancel flag.
async fn fetch_text(
    url: &str,
    referer: Option<&str>,
    cap: usize,
    cancel: &AtomicBool,
) -> Result<String, String> {
    let client = scrape_client(referer, Some(20))?;
    let mut resp = tokio::select! {
        biased;
        () = cancelled(cancel) => return Err(DOWNLOAD_CANCELLED.to_string()),
        r = client.get(url).header("Accept", "text/html,application/xhtml+xml,*/*;q=0.8").send() => r
            .map_err(|_| "Couldn't reach that link. Check the URL and your connection.".to_string())?,
    };
    if !resp.status().is_success() {
        return Err(UNSUPPORTED_SITE.to_string());
    }
    let mut body: Vec<u8> = Vec::new();
    loop {
        let chunk = tokio::select! {
            biased;
            () = cancelled(cancel) => return Err(DOWNLOAD_CANCELLED.to_string()),
            c = resp.chunk() => c.map_err(|_| UNSUPPORTED_SITE.to_string())?,
        };
        let Some(chunk) = chunk else { break };
        body.extend_from_slice(&chunk);
        if body.len() >= cap {
            body.truncate(cap);
            break;
        }
    }
    Ok(String::from_utf8_lossy(&body).into_owned())
}

/// What ffmpeg should read for a stream candidate.
#[derive(Debug, PartialEq)]
struct StreamInputs {
    /// One input (a manifest or a chosen variant) or two (variant + audio).
    inputs: Vec<String>,
    /// True when `inputs[0]` is an already-chosen single variant.
    pinned: bool,
}

/// For an HLS master playlist, pick the best variant (highest resolution, then
/// bandwidth) and its matching audio rendition. DASH / unknown streams are
/// passed through whole: with no `-map`, ffmpeg's default stream selection
/// already takes the highest-resolution video and the best audio. Any playlist
/// fetch/parse failure falls back to handing ffmpeg the URL as-is.
async fn resolve_stream_inputs(
    url: &str,
    kind: &MediaKind,
    referer: Option<&str>,
    cancel: &AtomicBool,
) -> Result<StreamInputs, String> {
    if *kind == MediaKind::Hls {
        match fetch_text(url, referer, MAX_PLAYLIST_BYTES, cancel).await {
            Ok(text) => {
                if let Some(c) = scrape::best_hls_variant(&text, url) {
                    let mut inputs = vec![c.video];
                    inputs.extend(c.audio);
                    return Ok(StreamInputs {
                        inputs,
                        pinned: true,
                    });
                }
            }
            Err(e) if e == DOWNLOAD_CANCELLED => return Err(e),
            Err(_) => {}
        }
    }
    Ok(StreamInputs {
        inputs: vec![url.to_string()],
        pinned: false,
    })
}

/// Build the ffmpeg remux command for a stream: per-input network-only protocol
/// whitelist + browser UA + Referer/Origin, stream copy (no re-encode, so the
/// source quality is untouched), size cap, and `+faststart`. `max_secs` limits
/// the output duration (used only by the live test harness).
fn stream_args(
    s: &StreamInputs,
    referer: Option<&str>,
    out: &str,
    max_secs: Option<f64>,
) -> Vec<String> {
    let mut args: Vec<String> = vec!["-hide_banner".into(), "-nostdin".into(), "-y".into()];
    for input in &s.inputs {
        args.extend([
            "-protocol_whitelist".to_string(),
            STREAM_PROTOCOLS.to_string(),
            "-user_agent".to_string(),
            SCRAPE_USER_AGENT.to_string(),
        ]);
        if let Some(r) = referer.filter(|r| is_http_url(r)) {
            args.extend(["-referer".to_string(), r.to_string()]);
            if let Some(o) = origin_of(r) {
                args.extend(["-headers".to_string(), format!("Origin: {o}\r\n")]);
            }
        }
        args.extend(["-i".to_string(), input.clone()]);
    }
    if s.inputs.len() > 1 {
        args.extend(["-map", "0:v:0", "-map", "1:a:0"].map(String::from));
    } else if s.pinned {
        args.extend(["-map", "0:v:0", "-map", "0:a:0?"].map(String::from));
    }
    args.extend(["-c".to_string(), "copy".to_string()]);
    if let Some(t) = max_secs {
        args.extend(["-t".to_string(), format!("{t}")]);
    }
    args.extend([
        "-fs".to_string(),
        MAX_DOWNLOAD_BYTES.to_string(),
        "-movflags".to_string(),
        "+faststart".to_string(),
        out.to_string(),
    ]);
    args
}

/// Wipe and recreate the download folder.
fn fresh_download_dir() -> Result<PathBuf, String> {
    let dir = download_dir();
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not prepare download folder: {e}"))?;
    Ok(dir)
}

/// Remux a stream candidate to `download_dir()/source.mp4` with the bundled
/// ffmpeg (see `resolve_stream_inputs` / `stream_args`). Honours the cancel
/// flag, emits "download-progress" when the input reports a finite duration,
/// and removes the partial file on any failure.
async fn download_stream(
    app: &AppHandle,
    stream_url: &str,
    kind: &MediaKind,
    referer: Option<&str>,
    cancel: &AtomicBool,
) -> Result<String, String> {
    // Defence in depth: the scraper already keeps http/https only, and an
    // http(s) URL can never start with `-`, so it can't be read as an option.
    if !is_http_url(stream_url) {
        return Err(UNSUPPORTED_SITE.to_string());
    }
    let inputs = resolve_stream_inputs(stream_url, kind, referer, cancel).await?;
    if inputs.inputs.iter().any(|i| !is_http_url(i)) {
        return Err(UNSUPPORTED_SITE.to_string());
    }
    let out = fresh_download_dir()?.join("source.mp4");
    let out_s = out.to_string_lossy().into_owned();
    let args = stream_args(&inputs, referer, &out_s, None);

    let (mut rx, child) = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| format!("could not locate ffmpeg: {e}"))?
        .args(args)
        .spawn()
        .map_err(|e| format!("ffmpeg failed to start: {e}"))?;

    let mut duration: Option<f64> = None;
    let mut tail = String::new();
    let fail = |msg: String| {
        let _ = std::fs::remove_dir_all(download_dir());
        Err(msg)
    };
    loop {
        let event = tokio::select! {
            biased;
            () = cancelled(cancel) => {
                let _ = child.kill();
                return fail(DOWNLOAD_CANCELLED.to_string());
            }
            event = rx.recv() => match event {
                Some(event) => event,
                None => break,
            },
        };
        match event {
            CommandEvent::Stderr(bytes) => {
                let text = String::from_utf8_lossy(&bytes);
                if duration.is_none() {
                    duration = parse_ffmpeg_duration(&text);
                }
                if let (Some(total), Some(t)) = (duration, parse_progress_time(&text)) {
                    let _ = app.emit("download-progress", (t / total).clamp(0.0, 1.0));
                }
                tail.push_str(&text);
                if tail.len() > 4096 {
                    let cut = tail.len() - 4096;
                    let cut = (cut..tail.len())
                        .find(|i| tail.is_char_boundary(*i))
                        .unwrap_or(0);
                    tail.drain(..cut);
                }
            }
            CommandEvent::Error(e) => tail.push_str(&e),
            CommandEvent::Terminated(payload) if payload.code != Some(0) => {
                let summary = tail
                    .lines()
                    .map(str::trim)
                    .rfind(|l| !l.is_empty())
                    .unwrap_or("");
                return fail(if summary.is_empty() {
                    "Download failed.".to_string()
                } else {
                    format!("Download failed: {summary}")
                });
            }
            _ => {}
        }
    }

    match std::fs::metadata(&out) {
        Ok(m) if m.len() > 0 => Ok(out_s),
        _ => fail("the download produced no file".to_string()),
    }
}

/// Why a yt-dlp run didn't produce a file.
enum YtdlpError {
    Cancelled,
    /// yt-dlp failed; carries its stderr.
    Failed(String),
}

/// Run the bundled yt-dlp with `args` (which write into `dir`), forwarding
/// progress, racing the cancel flag, and returning the downloaded file path.
async fn run_ytdlp(
    app: &AppHandle,
    args: Vec<String>,
    dir: &Path,
    cancel: &AtomicBool,
) -> Result<String, YtdlpError> {
    // MAINTAINER NOTE: the bundled yt-dlp goes stale as sites change their
    // players; refresh it (scripts/fetch-ytdlp.sh) on every release build or URL
    // extraction will start failing in the wild.
    let (mut rx, child) = app
        .shell()
        .sidecar("yt-dlp")
        .map_err(|e| YtdlpError::Failed(format!("could not locate yt-dlp: {e}")))?
        .args(args)
        .spawn()
        .map_err(|e| YtdlpError::Failed(format!("yt-dlp failed to start: {e}")))?;

    let mut errors = String::new();
    loop {
        // Race the next yt-dlp event against the cancel flag. recv() blocks while
        // yt-dlp is stalled, so polling the flag inside the loop alone wouldn't
        // cancel a hang; select! lets the cancel branch fire regardless.
        let event = tokio::select! {
            biased;
            () = cancelled(cancel) => {
                let _ = child.kill();
                let _ = std::fs::remove_dir_all(dir);
                return Err(YtdlpError::Cancelled);
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
                return Err(YtdlpError::Failed(errors));
            }
            _ => {}
        }
    }

    std::fs::read_dir(dir)
        .map_err(|e| YtdlpError::Failed(format!("could not read download folder: {e}")))?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .find(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
        .ok_or_else(|| YtdlpError::Failed("the download produced no file".to_string()))
}

/// The `--ffmpeg-location` to hand yt-dlp (the folder holding our sidecar).
fn ytdlp_ffmpeg_location() -> Option<String> {
    ffmpeg_path()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_string_lossy().into_owned()))
}

/// Try a page's media candidates (best first, up to `MAX_SCRAPE_ATTEMPTS`):
/// direct files over HTTP, streams through ffmpeg, all with `referer` as the
/// Referer/Origin. `Ok(None)` = nothing worked (reason left in `last_err`);
/// `Err` only for a cancel.
async fn try_media(
    app: &AppHandle,
    candidates: &[scrape::Candidate],
    referer: &str,
    cancel: &AtomicBool,
    last_err: &mut String,
) -> Result<Option<String>, String> {
    let media = candidates.iter().filter(|c| c.kind != MediaKind::Embed);
    for c in media.take(MAX_SCRAPE_ATTEMPTS) {
        let result = match &c.kind {
            MediaKind::File(ext) => download_direct(app, &c.url, ext, Some(referer), cancel).await,
            kind => download_stream(app, &c.url, kind, Some(referer), cancel).await,
        };
        match result {
            Ok(path) => return Ok(Some(path)),
            Err(e) if e == DOWNLOAD_CANCELLED => return Err(e),
            Err(e) => *last_err = e,
        }
    }
    Ok(None)
}

/// Fallback for pages yt-dlp has no extractor for. Order (each step bounded):
/// 1. fetch the page HTML and try its embedded media (video tags, data-attrs,
///    JSON-LD, script/packed-JS URLs), best quality first;
/// 2. for each embedded player (iframe / embed URL, up to `MAX_EMBEDS`): run
///    yt-dlp on the embed URL with the page as Referer (Vimeo, YouTube,
///    Dailymotion, JW Player, Brightcove, Wistia, Streamable, ... embeds), and
///    if that fails, scrape the embed page's own media once.
///
/// With nothing found it returns the original "site isn't supported" message.
async fn scrape_fallback(
    app: &AppHandle,
    page_url: &str,
    cancel: &AtomicBool,
) -> Result<String, String> {
    let html = fetch_text(page_url, None, MAX_SCRAPE_HTML_BYTES, cancel).await?;
    let candidates = scrape::extract_candidates(&html, page_url);
    let mut last_err = UNSUPPORTED_SITE.to_string();
    if let Some(p) = try_media(app, &candidates, page_url, cancel, &mut last_err).await? {
        return Ok(p);
    }
    let embeds = candidates.iter().filter(|c| c.kind == MediaKind::Embed);
    for embed in embeds.take(MAX_EMBEDS) {
        let dir = fresh_download_dir()?;
        let template = dir.join("source.%(ext)s").to_string_lossy().into_owned();
        let args = ytdlp_args(
            &template,
            ytdlp_ffmpeg_location().as_deref(),
            Some(page_url),
            &embed.url,
        );
        match run_ytdlp(app, args, &dir, cancel).await {
            Ok(p) => return Ok(p),
            Err(YtdlpError::Cancelled) => return Err(DOWNLOAD_CANCELLED.to_string()),
            Err(YtdlpError::Failed(_)) => {}
        }
        match fetch_text(&embed.url, Some(page_url), MAX_SCRAPE_HTML_BYTES, cancel).await {
            Ok(h) => {
                let inner = scrape::extract_candidates(&h, &embed.url);
                if let Some(p) = try_media(app, &inner, &embed.url, cancel, &mut last_err).await? {
                    return Ok(p);
                }
            }
            Err(e) if e == DOWNLOAD_CANCELLED => return Err(e),
            Err(_) => {}
        }
    }
    Err(last_err)
}

/// Stream `url` into `out` over HTTP (browser UA + Referer/Origin when given),
/// capped at `MAX_DOWNLOAD_BYTES`, racing every chunk against the cancel flag.
/// Calls `on_progress` (0.0-1.0) when Content-Length is known; with no
/// Content-Length it stays silent rather than reporting a fake value.
async fn fetch_to_file(
    url: &str,
    referer: Option<&str>,
    out: &Path,
    cancel: &AtomicBool,
    on_progress: impl Fn(f64),
) -> Result<(), String> {
    use std::io::Write;

    let client = scrape_client(referer, None)?;
    let mut resp = tokio::select! {
        biased;
        () = cancelled(cancel) => return Err(DOWNLOAD_CANCELLED.to_string()),
        r = client.get(url).send() => r
            .map_err(|_| "Couldn't reach that link. Check the URL and your connection.".to_string())?,
    };
    if !resp.status().is_success() {
        return Err(format!(
            "the server returned {} for that link",
            resp.status()
        ));
    }

    let total = resp.content_length();
    let mut downloaded: u64 = 0;
    let mut file =
        std::fs::File::create(out).map_err(|e| format!("could not save the download: {e}"))?;
    loop {
        let chunk = tokio::select! {
            biased;
            () = cancelled(cancel) => return Err(DOWNLOAD_CANCELLED.to_string()),
            chunk = resp.chunk() => chunk
                .map_err(|_| "the download was interrupted before it finished".to_string())?,
        };
        let Some(chunk) = chunk else { break };
        file.write_all(&chunk)
            .map_err(|e| format!("could not write the download: {e}"))?;
        downloaded += chunk.len() as u64;
        if downloaded > MAX_DOWNLOAD_BYTES {
            return Err("that download is too large".to_string());
        }
        if let Some(total) = total.filter(|t| *t > 0) {
            #[allow(clippy::cast_precision_loss)]
            let p = (downloaded as f64 / total as f64).clamp(0.0, 1.0);
            on_progress(p);
        }
    }
    Ok(())
}

/// Download a direct media link to `download_dir()/source.<ext>`. Reuses the
/// download dir so app-close cleanup already covers it; emits
/// "download-progress"; removes the partial file on failure or cancel.
async fn download_direct(
    app: &AppHandle,
    url: &str,
    ext: &str,
    referer: Option<&str>,
    cancel: &AtomicBool,
) -> Result<String, String> {
    let dir = fresh_download_dir()?;
    let out = dir.join(format!("source.{ext}"));
    match fetch_to_file(url, referer, &out, cancel, |p| {
        let _ = app.emit("download-progress", p);
    })
    .await
    {
        Ok(()) => Ok(out.to_string_lossy().into_owned()),
        Err(e) => {
            let _ = std::fs::remove_dir_all(&dir);
            Err(e)
        }
    }
}

/// Download a video from a URL and return its local path, at source quality.
/// Direct links to a video file are fetched over plain HTTP; everything else
/// goes through the bundled `yt-dlp` sidecar (best video + best audio); if
/// yt-dlp has no extractor for the page, a fallback scrapes the page and its
/// embedded players (see `scrape_fallback`). Emits "download-progress" events
/// (0.0-1.0). The resulting file is treated as an ordinary local source and
/// deleted on exit.
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

    // Only http/https. Blocks file:// and, crucially, `--flag`-shaped strings
    // that yt-dlp would otherwise parse as options rather than a URL.
    if !is_http_url(&url) {
        return Err("Only http and https links are supported.".to_string());
    }

    // Direct file links skip yt-dlp entirely: a plain streaming GET is faster and
    // works even for hosts yt-dlp has no extractor for.
    if let Some(ext) = direct_media_extension(&url) {
        return download_direct(&app, &url, &ext, None, &flag).await;
    }

    let dir = fresh_download_dir()?;
    let template = dir.join("source.%(ext)s").to_string_lossy().into_owned();
    let args = ytdlp_args(&template, ytdlp_ffmpeg_location().as_deref(), None, &url);
    match run_ytdlp(&app, args, &dir, &flag).await {
        Ok(path) => Ok(path),
        Err(YtdlpError::Cancelled) => Err(DOWNLOAD_CANCELLED.to_string()),
        // No extractor for this page: fall back to scraping the HTML (and its
        // embedded players) before giving up.
        Err(YtdlpError::Failed(e)) if ytdlp_unsupported(&e) => {
            scrape_fallback(&app, &url, &flag).await
        }
        Err(YtdlpError::Failed(e)) => Err(friendly_ytdlp_error(&e)),
    }
}

/// GitHub Releases API endpoint for this repo's latest published release. The
/// slug is the real `ccharafeddine/GifSmith` remote (see release.yml / git
/// origin), not a guess.
const RELEASES_API: &str = "https://api.github.com/repos/ccharafeddine/GifSmith/releases/latest";

/// Human-facing releases page, used as a fallback download URL if the API
/// response omits `html_url`.
const RELEASES_PAGE: &str = "https://github.com/ccharafeddine/GifSmith/releases/latest";

/// Result of an update check. `current` is this build's version, `latest` is the
/// newest published tag (leading `v` stripped), `is_newer` is the numeric-tuple
/// comparison, `notes` is the release body, and `url` opens the release page.
#[derive(serde::Serialize)]
pub struct UpdateInfo {
    pub current: String,
    pub latest: String,
    pub is_newer: bool,
    pub notes: String,
    pub url: String,
}

/// Split a version like `v1.10.2` or `1.2.0-beta` into numeric components,
/// ignoring a leading `v` and stopping each component at its first non-digit
/// (so `2-beta` reads as `2`). Missing components are treated as 0 by the caller.
fn parse_version(v: &str) -> Vec<u64> {
    v.trim()
        .trim_start_matches(['v', 'V'])
        .split('.')
        .map(|part| {
            let digits: String = part.chars().take_while(char::is_ascii_digit).collect();
            digits.parse().unwrap_or(0)
        })
        .collect()
}

/// True when `latest` is a strictly higher version than `current`, compared
/// component-by-component as integers so `1.10.0` correctly beats `1.9.0` (a
/// plain string compare would not). Mirrors Portfolio Analyzer's `is_newer`.
fn is_newer(current: &str, latest: &str) -> bool {
    let a = parse_version(current);
    let b = parse_version(latest);
    for i in 0..a.len().max(b.len()) {
        let x = a.get(i).copied().unwrap_or(0);
        let y = b.get(i).copied().unwrap_or(0);
        if y != x {
            return y > x;
        }
    }
    false
}

/// Check GitHub for a newer release. Does the network in Rust (not the webview)
/// so no CSP work is needed. Prompt-only: this never downloads or installs
/// anything, it just reports what the latest published release is.
///
/// # Errors
/// Returns a user-facing message if GitHub can't be reached, returns a non-2xx
/// status, or the response can't be parsed.
#[tauri::command]
pub async fn check_for_update() -> Result<UpdateInfo, String> {
    // Only the fields we use. Serde ignores the rest of GitHub's large payload.
    #[derive(serde::Deserialize)]
    struct GithubRelease {
        tag_name: Option<String>,
        name: Option<String>,
        body: Option<String>,
        html_url: Option<String>,
    }

    // GitHub rejects requests without a User-Agent. Accept pins the v3 media type.
    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| format!("could not start the update check: {e}"))?;
    let resp = client
        .get(RELEASES_API)
        .header("User-Agent", "GifSmith")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|_| {
            "Couldn't reach GitHub to check for updates. Check your connection.".to_string()
        })?;
    if !resp.status().is_success() {
        return Err(format!(
            "GitHub returned {} for the update check",
            resp.status()
        ));
    }
    // No `json` feature on reqwest (default-features off): read text, parse with
    // serde_json, which is already a dependency.
    let body = resp
        .text()
        .await
        .map_err(|_| "the update response was interrupted".to_string())?;
    let release: GithubRelease =
        serde_json::from_str(&body).map_err(|e| format!("could not read the update info: {e}"))?;

    let current = env!("CARGO_PKG_VERSION").to_string();
    let tag = release.tag_name.unwrap_or_default();
    let is_newer = is_newer(&current, &tag);
    // Show the tag without a leading `v` so it reads consistently with `current`.
    let latest = tag.trim().trim_start_matches(['v', 'V']).to_string();
    // Prefer the release body; fall back to the release name; else empty.
    let notes = release
        .body
        .filter(|b| !b.trim().is_empty())
        .or(release.name)
        .unwrap_or_default();
    let url = release
        .html_url
        .filter(|u| !u.trim().is_empty())
        .unwrap_or_else(|| RELEASES_PAGE.to_string());

    Ok(UpdateInfo {
        current,
        latest,
        is_newer,
        notes,
        url,
    })
}

/// Resolve the bundled `ffmpeg` sidecar. Tauri places it next to the app binary
/// when bundled, and next to the dev binary in `target/` during development.
fn ffmpeg_path() -> io::Result<PathBuf> {
    let exe = std::env::current_exe()?;
    let dir = exe
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "current exe has no parent dir"))?;
    let name = if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    };
    Ok(dir.join(name))
}

#[cfg(test)]
mod tests {
    use super::{
        direct_media_extension, friendly_ytdlp_error, is_http_url, is_newer, origin_of,
        parse_ffmpeg_duration, parse_progress_time, parse_version, stream_args, ytdlp_args,
        ytdlp_unsupported, StreamInputs,
    };

    #[test]
    fn parses_versions_ignoring_v_and_suffixes() {
        assert_eq!(parse_version("v1.2.3"), vec![1, 2, 3]);
        assert_eq!(parse_version("1.0.0"), vec![1, 0, 0]);
        // Leading V and a pre-release suffix on the last component.
        assert_eq!(parse_version("V2.4.0-beta"), vec![2, 4, 0]);
    }

    #[test]
    fn detects_a_strictly_newer_version() {
        assert!(is_newer("1.0.0", "1.0.1"));
        assert!(is_newer("1.0.0", "v1.1.0"));
        // Numeric compare, not lexical: 1.10 must beat 1.9.
        assert!(is_newer("1.9.0", "1.10.0"));
        // Differing component counts compare as if zero-padded.
        assert!(is_newer("1.0", "1.0.1"));
    }

    #[test]
    fn same_or_older_version_is_not_newer() {
        assert!(!is_newer("1.0.0", "1.0.0"));
        assert!(!is_newer("1.2.0", "1.1.9"));
        assert!(!is_newer("2.0.0", "v1.9.9"));
        // Trailing zeros don't make it newer.
        assert!(!is_newer("1.0", "1.0.0"));
    }

    #[test]
    fn accepts_http_and_https_urls() {
        assert!(is_http_url("https://example.com/v.mp4"));
        assert!(is_http_url("http://example.com/watch?v=abc"));
    }

    #[test]
    fn rejects_non_http_urls() {
        // file:// would otherwise let a paste read a local path over the URL box.
        assert!(!is_http_url("file:///etc/passwd"));
        assert!(!is_http_url("ftp://example.com/v.mp4"));
        assert!(!is_http_url("javascript:alert(1)"));
        assert!(!is_http_url("not a url"));
    }

    #[test]
    fn ytdlp_url_is_last_and_after_end_of_options() {
        // A URL that looks like a dangerous flag must survive as a plain operand.
        let evil = "--exec=calc.exe";
        let args = ytdlp_args("out.%(ext)s", None, None, evil);
        assert_eq!(args.last().expect("args are never empty"), evil);
        let sep = args.len() - 2;
        assert_eq!(args[sep], "--", "URL must be preceded by an -- separator");
        // The evil string must never appear as its own argument before the guard.
        assert!(!args[..sep].iter().any(|a| a == evil));
    }

    #[test]
    fn ytdlp_ffmpeg_location_included_when_present() {
        let args = ytdlp_args("out.%(ext)s", Some("/bin"), None, "https://x/y");
        assert!(args.iter().any(|a| a == "--ffmpeg-location"));
        // Even with the extra flags, the URL stays last behind the separator.
        assert_eq!(args.last().expect("args are never empty"), "https://x/y");
        assert_eq!(args[args.len() - 2], "--");
    }

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
        assert_eq!(
            direct_media_extension("https://youtube.com/watch?v=abc"),
            None
        );
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
        assert_eq!(
            msg,
            "Couldn't reach that link. Check the URL and your connection."
        );
    }

    #[test]
    fn falls_back_to_last_stderr_line() {
        let msg = friendly_ytdlp_error("some noise\n\nERROR: the thing exploded\n");
        assert_eq!(msg, "Download failed: ERROR: the thing exploded");
    }

    #[test]
    fn ytdlp_unsupported_detects_fallback_cases() {
        assert!(ytdlp_unsupported(
            "ERROR: Unsupported URL: https://x.example/p"
        ));
        assert!(ytdlp_unsupported(
            "ERROR: [generic] p: No video formats found!; please report this issue"
        ));
        assert!(!ytdlp_unsupported(
            "ERROR: Unable to download webpage: HTTP Error 404"
        ));
        assert!(!ytdlp_unsupported(""));
    }

    #[test]
    fn parses_ffmpeg_duration_header() {
        let s = "Input #0, hls, from 'https://x/i.m3u8':\n  Duration: 00:01:30.50, start: 0.000, bitrate: 0 kb/s";
        assert_eq!(parse_ffmpeg_duration(s), Some(90.5));
        assert_eq!(parse_ffmpeg_duration("  Duration: N/A, start: 0.0"), None);
        assert_eq!(parse_ffmpeg_duration("frame=1 time=00:00:01.00"), None);
    }
    #[test]
    fn ytdlp_args_request_source_quality_safely() {
        let a = ytdlp_args(
            "/tmp/source.%(ext)s",
            Some("/bin"),
            Some("https://page.example/a"),
            "https://v.example/e/1",
        );
        let s = a.join(" ");
        assert!(s.contains("-f bv*[acodec=none]+ba/b/bv*+ba"));
        assert!(s.contains("-S res,fps,br"));
        assert!(s.contains("--merge-output-format mp4/mkv"));
        assert!(!s.contains("height<="));
        assert!(s.contains("--ignore-config"));
        assert!(s.contains("--referer https://page.example/a"));
        // The URL is always last, after the end-of-options separator.
        assert_eq!(&a[a.len() - 2..], ["--", "https://v.example/e/1"]);
        // A non-http referer is never passed through.
        let b = ytdlp_args("t", None, Some("--exec=x"), "https://v.example/");
        assert!(!b.iter().any(|x| x.contains("exec")));
    }

    #[test]
    fn stream_args_map_variant_audio_and_headers() {
        let split = StreamInputs {
            inputs: vec![
                "https://c.example/v1080.m3u8".into(),
                "https://c.example/a.m3u8".into(),
            ],
            pinned: true,
        };
        let a = stream_args(&split, Some("https://page.example/w/1"), "out.mp4", None);
        let s = a.join(" ");
        assert_eq!(a.iter().filter(|x| *x == "-i").count(), 2);
        assert_eq!(a.iter().filter(|x| *x == "-protocol_whitelist").count(), 2);
        assert!(s.contains("http,https,tcp,tls,crypto"));
        assert!(s.contains("-referer https://page.example/w/1"));
        assert!(s.contains("Origin: https://page.example\r\n"));
        assert!(s.contains("-map 0:v:0 -map 1:a:0 -c copy"));
        assert!(!s.contains("-t "));
        assert_eq!(a.last().map(String::as_str), Some("out.mp4"));

        let whole = StreamInputs {
            inputs: vec!["https://c.example/m.mpd".into()],
            pinned: false,
        };
        let b = stream_args(&whole, None, "o.mp4", Some(10.0)).join(" ");
        // No -map: ffmpeg's default picks the highest-resolution video + best audio.
        assert!(!b.contains("-map"));
        assert!(!b.contains("-referer"));
        assert!(b.contains("-c copy -t 10"));

        let pinned = StreamInputs {
            inputs: vec!["https://c.example/v.m3u8".into()],
            pinned: true,
        };
        assert!(stream_args(&pinned, None, "o.mp4", None)
            .join(" ")
            .contains("-map 0:v:0 -map 0:a:0?"));
    }

    #[test]
    fn origin_of_strips_path() {
        assert_eq!(
            origin_of("https://a.example:8443/x/y?z").as_deref(),
            Some("https://a.example:8443")
        );
        assert_eq!(origin_of("not a url"), None);
    }

    #[test]
    fn parses_ffmpeg_progress_time() {
        let line = "frame=  120 fps= 30 size=  256kB time=00:01:04.50 bitrate=...";
        assert_eq!(parse_progress_time(line), Some(64.5));
        assert_eq!(parse_progress_time("time=N/A"), None);
        assert_eq!(parse_progress_time("no timestamp"), None);
    }
}
