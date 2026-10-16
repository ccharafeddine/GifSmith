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
use tauri_plugin_shell::ShellExt;

/// Temp path of the preview GIF.
fn preview_path() -> PathBuf {
    std::env::temp_dir().join("gifsmith-preview.gif")
}

/// Temp dir for URL downloads.
pub fn download_dir() -> PathBuf {
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
    use super::{is_newer, parse_version};

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

}
