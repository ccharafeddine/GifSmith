//! FFmpeg -> gifski streaming pipeline. FFmpeg decodes and scales the selected
//! slice, emitting raw RGBA frames on stdout; we read them frame by frame and
//! feed gifski's collector while its writer encodes on another thread. No
//! intermediate files are written, only the final .gif.

use std::fs::File;
use std::io::{self, Read};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;

use gifski::progress::NoProgress;
use gifski::{Repeat, Settings};
use imgref::ImgVec;
use rgb::RGBA8;
use serde::Deserialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum EncodeError {
    #[error("failed to start ffmpeg: {0}")]
    Spawn(#[source] io::Error),
    #[error("i/o error during export: {0}")]
    Io(#[from] io::Error),
    #[error("gif encoding failed: {0}")]
    Gifski(#[from] gifski::Error),
    #[error("ffmpeg exited with an error: {0}")]
    Ffmpeg(String),
    #[error("no frames were produced for this selection")]
    NoFrames,
    #[error("export was cancelled")]
    Cancelled,
}

/// A crop region in source pixels (FFmpeg `crop=w:h:x:y`).
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Crop {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

/// Parameters for a single export. Field names are camelCase over IPC.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportParams {
    pub input_path: String,
    pub start_secs: f64,
    pub end_secs: f64,
    pub fps: u32,
    pub width: u32,
    pub quality: u8,
    pub src_width: u32,
    pub src_height: u32,
    /// Optional crop, applied before scaling.
    pub crop: Option<Crop>,
    /// Playback speed multiplier (e.g. 0.5 = half, 2.0 = double).
    pub speed: f64,
    /// Play the clip forward then reversed (buffers all frames in memory).
    pub boomerang: bool,
}

/// Round down to the nearest even number, clamped to a minimum of 2. FFmpeg's
/// scaler and most codecs want even dimensions.
fn even(v: u32) -> u32 {
    let v = v & !1;
    if v < 2 {
        2
    } else {
        v
    }
}

/// Run the full export. Blocking: call from a blocking thread. `on_progress` is
/// called with a 0.0-1.0 fraction of frames read (throttled to ~1% steps).
///
/// # Errors
/// Fails if ffmpeg can't start or exits non-zero, on any i/o error, if gifski
/// rejects a frame, or if the selection yields no frames.
pub fn export_gif(
    ffmpeg: &Path,
    params: &ExportParams,
    output_path: &Path,
    on_progress: &dyn Fn(f64),
    cancel: &AtomicBool,
) -> Result<(), EncodeError> {
    let (out_w, out_h) = output_dims(params);
    let frame_bytes = out_w as usize * out_h as usize * 4;
    let (_, duration) = clip_window(params);
    let speed = effective_speed(params.speed);
    let args = ffmpeg_args(params, out_w, out_h);

    let mut child = Command::new(ffmpeg)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(EncodeError::Spawn)?;

    let (Some(mut stdout), Some(mut stderr)) = (child.stdout.take(), child.stderr.take()) else {
        let _ = child.kill();
        return Err(EncodeError::Ffmpeg(
            "ffmpeg output pipes were not available".to_string(),
        ));
    };

    // Drain stderr on its own thread so a full pipe can't deadlock the reader.
    let stderr_thread = thread::spawn(move || {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s);
        s
    });

    let settings = Settings {
        quality: params.quality.clamp(1, 100),
        repeat: Repeat::Infinite,
        ..Settings::default()
    };
    let (collector, writer) = gifski::new(settings)?;

    let output_path = output_path.to_path_buf();
    let writer_thread = thread::spawn(move || -> Result<(), EncodeError> {
        let file = File::create(&output_path)?;
        let mut progress = NoProgress {};
        writer.write(file, &mut progress)?;
        Ok(())
    });

    // Estimated frame count for progress reporting (output runs at duration/speed).
    let total_frames = ((duration / speed) * f64::from(params.fps))
        .round()
        .max(1.0) as usize;
    let mut last_pct: i32 = -1;
    on_progress(0.0);

    let mut idx = 0usize;
    if params.boomerang {
        // Buffer every frame, then feed forward + reversed, dropping the two
        // seam frames that would otherwise duplicate at the turn-arounds.
        let mut frames: Vec<ImgVec<RGBA8>> = Vec::new();
        let mut buf = vec![0u8; frame_bytes];
        loop {
            if cancel.load(Ordering::Relaxed) {
                let _ = child.kill();
                return Err(EncodeError::Cancelled);
            }
            let n = read_full(&mut stdout, &mut buf)?;
            if n != frame_bytes {
                break;
            }
            let pixels: Vec<RGBA8> = buf
                .chunks_exact(4)
                .map(|c| RGBA8::new(c[0], c[1], c[2], c[3]))
                .collect();
            frames.push(ImgVec::new(pixels, out_w as usize, out_h as usize));

            // Buffering is the first half of the progress bar.
            let frac = (frames.len() as f64 / total_frames as f64).min(1.0) * 0.5;
            let pct = (frac * 100.0) as i32;
            if pct != last_pct {
                last_pct = pct;
                on_progress(frac);
            }
        }

        let order = boomerang_order(frames.len());
        let total_out = order.len().max(1);
        for &i in &order {
            if cancel.load(Ordering::Relaxed) {
                return Err(EncodeError::Cancelled);
            }
            let pts = idx as f64 / f64::from(params.fps);
            collector.add_frame_rgba(idx, frames[i].clone(), pts)?;
            idx += 1;

            // Feeding/encoding is the second half of the progress bar.
            let frac = 0.5 + (idx as f64 / total_out as f64).min(1.0) * 0.5;
            let pct = (frac * 100.0) as i32;
            if pct != last_pct {
                last_pct = pct;
                on_progress(frac);
            }
        }
    } else {
        let mut buf = vec![0u8; frame_bytes];
        loop {
            if cancel.load(Ordering::Relaxed) {
                let _ = child.kill();
                return Err(EncodeError::Cancelled);
            }
            let n = read_full(&mut stdout, &mut buf)?;
            if n != frame_bytes {
                break; // clean EOF (0) or a partial trailing frame
            }
            let pixels: Vec<RGBA8> = buf
                .chunks_exact(4)
                .map(|c| RGBA8::new(c[0], c[1], c[2], c[3]))
                .collect();
            let img = ImgVec::new(pixels, out_w as usize, out_h as usize);
            let pts = idx as f64 / f64::from(params.fps);
            collector.add_frame_rgba(idx, img, pts)?;
            idx += 1;

            // Throttle progress emissions to whole-percent changes.
            let frac = (idx as f64 / total_frames as f64).min(1.0);
            let pct = (frac * 100.0) as i32;
            if pct != last_pct {
                last_pct = pct;
                on_progress(frac);
            }
        }
    }
    drop(collector); // signal end of stream so the writer can finish

    writer_thread
        .join()
        .map_err(|_| EncodeError::Ffmpeg("gif writer thread panicked".to_string()))??;

    let status = child.wait()?;
    let stderr_text = stderr_thread.join().unwrap_or_default();
    if !status.success() {
        return Err(EncodeError::Ffmpeg(stderr_text.trim().to_string()));
    }
    if idx == 0 {
        return Err(EncodeError::NoFrames);
    }
    on_progress(1.0);
    Ok(())
}

/// Output frame size: `params.width` rounded to even, height derived from the
/// crop (or source) aspect so the raw frame byte size is known exactly (avoids
/// ffmpeg's `scale=-1` rounding, which we couldn't predict).
pub(crate) fn output_dims(params: &ExportParams) -> (u32, u32) {
    let out_w = even(params.width);
    let (in_w, in_h) = match params.crop {
        Some(c) if c.w > 0 && c.h > 0 => (c.w, c.h),
        _ => (params.src_width, params.src_height),
    };
    let out_h = if in_w == 0 {
        out_w
    } else {
        let h = (f64::from(in_h) * f64::from(out_w) / f64::from(in_w)).round() as u32;
        even(h)
    };
    (out_w, out_h)
}

/// Seek start and source duration. The start is clamped to >= 0 (a trim handle
/// dragged past zero would pass ffmpeg a nonsensical `-ss`) and the duration to
/// >= 0 (an inverted selection yields no frames instead of an ffmpeg error).
pub(crate) fn clip_window(params: &ExportParams) -> (f64, f64) {
    let start = params.start_secs.max(0.0);
    let duration = (params.end_secs - start).max(0.0);
    (start, duration)
}

/// Speed multiplier, falling back to 1x for zero, negative, or NaN input.
pub(crate) fn effective_speed(speed: f64) -> f64 {
    if speed > 0.0 && speed.is_finite() {
        speed
    } else {
        1.0
    }
}

/// The `-vf` chain. Order: retime (setpts) -> resample (fps) -> crop -> scale.
/// crop must precede scale; setpts must precede fps.
pub(crate) fn video_filter(params: &ExportParams, out_w: u32, out_h: u32) -> String {
    let pts_factor = 1.0 / effective_speed(params.speed);
    let crop_part = match params.crop {
        Some(c) if c.w > 0 && c.h > 0 => format!(",crop={}:{}:{}:{}", c.w, c.h, c.x, c.y),
        _ => String::new(),
    };
    format!(
        "setpts={pts_factor:.6}*PTS,fps={}{crop_part},scale={out_w}:{out_h}:flags=lanczos",
        params.fps
    )
}

/// Full ffmpeg argument list. -ss and -t are both INPUT options (before -i):
/// -ss is a fast keyframe seek, -t bounds the SOURCE read to the selection
/// length. Bounding the source (not the output) is essential with speed != 1,
/// where setpts retimes the frames: an output-side -t would truncate a slowed
/// clip to a fraction of the selection.
pub(crate) fn ffmpeg_args(params: &ExportParams, out_w: u32, out_h: u32) -> Vec<String> {
    let (start_secs, duration) = clip_window(params);
    [
        "-v",
        "error",
        "-nostdin",
        "-ss",
        &format!("{start_secs:.6}"),
        "-t",
        &format!("{duration:.6}"),
        "-i",
        &params.input_path,
        "-vf",
        &video_filter(params, out_w, out_h),
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgba",
        "pipe:1",
    ]
    .iter()
    .map(|s| (*s).to_string())
    .collect()
}

/// Boomerang frame order: 0,1,..,n-1, then n-2,..,1. The two seam frames are
/// dropped so the turn-arounds don't show a duplicated frame.
pub(crate) fn boomerang_order(n: usize) -> Vec<usize> {
    let mut order: Vec<usize> = (0..n).collect();
    if n >= 3 {
        order.extend((1..=n - 2).rev());
    }
    order
}

/// Read until `buf` is full or EOF. Returns the number of bytes read (== buf.len
/// on a full read, less at EOF).
fn read_full(r: &mut impl Read, buf: &mut [u8]) -> io::Result<usize> {
    let mut filled = 0;
    while filled < buf.len() {
        match r.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(ref e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(filled)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params() -> ExportParams {
        ExportParams {
            input_path: "C:\\clips\\in put.mp4".to_string(),
            start_secs: 1.5,
            end_secs: 4.0,
            fps: 15,
            width: 480,
            quality: 90,
            src_width: 1920,
            src_height: 1080,
            crop: None,
            speed: 1.0,
            boomerang: false,
        }
    }

    #[test]
    fn even_rounds_down_and_floors_at_two() {
        assert_eq!(even(480), 480);
        assert_eq!(even(481), 480);
        assert_eq!(even(1), 2);
        assert_eq!(even(0), 2);
        assert_eq!(even(2), 2);
    }

    #[test]
    fn dims_follow_source_aspect() {
        assert_eq!(output_dims(&params()), (480, 270));
    }

    #[test]
    fn dims_follow_crop_aspect_and_round_even() {
        let mut p = params();
        p.width = 481;
        p.crop = Some(Crop {
            x: 10,
            y: 20,
            w: 300,
            h: 301,
        });
        // 301 * 480 / 300 = 481.6 -> 482 (even)
        assert_eq!(output_dims(&p), (480, 482));
    }

    #[test]
    fn dims_ignore_degenerate_crop_and_zero_source() {
        let mut p = params();
        p.crop = Some(Crop {
            x: 0,
            y: 0,
            w: 0,
            h: 100,
        });
        assert_eq!(output_dims(&p), (480, 270));
        p.crop = None;
        p.src_width = 0;
        assert_eq!(output_dims(&p), (480, 480));
    }

    #[test]
    fn window_clamps_negative_start_and_inverted_range() {
        let mut p = params();
        p.start_secs = -0.4;
        assert_eq!(clip_window(&p), (0.0, 4.0));
        p.start_secs = 5.0;
        assert_eq!(clip_window(&p), (5.0, 0.0));
    }

    #[test]
    fn speed_falls_back_to_one() {
        assert!((effective_speed(2.0) - 2.0).abs() < f64::EPSILON);
        for bad in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert!((effective_speed(bad) - 1.0).abs() < f64::EPSILON);
        }
    }

    #[test]
    fn filter_orders_setpts_fps_crop_scale() {
        let mut p = params();
        p.speed = 2.0;
        p.crop = Some(Crop {
            x: 1,
            y: 2,
            w: 640,
            h: 360,
        });
        assert_eq!(
            video_filter(&p, 480, 270),
            "setpts=0.500000*PTS,fps=15,crop=640:360:1:2,scale=480:270:flags=lanczos"
        );
    }

    #[test]
    fn args_put_seek_and_duration_before_input() {
        let p = params();
        let args = ffmpeg_args(&p, 480, 270);
        let pos = |a: &str| args.iter().position(|x| x == a).unwrap();
        assert!(pos("-ss") < pos("-i"));
        assert!(pos("-t") < pos("-i"));
        assert_eq!(args[pos("-ss") + 1], "1.500000");
        assert_eq!(args[pos("-t") + 1], "2.500000");
        // The path is passed as one argument, spaces and all.
        assert_eq!(args[pos("-i") + 1], p.input_path);
        assert_eq!(args.last().map(String::as_str), Some("pipe:1"));
        assert!(args
            .windows(2)
            .any(|w| w[0] == "-pix_fmt" && w[1] == "rgba"));
    }

    #[test]
    fn boomerang_order_drops_seam_frames() {
        assert_eq!(boomerang_order(0), Vec::<usize>::new());
        assert_eq!(boomerang_order(1), vec![0]);
        assert_eq!(boomerang_order(2), vec![0, 1]);
        assert_eq!(boomerang_order(4), vec![0, 1, 2, 3, 2, 1]);
    }
}
