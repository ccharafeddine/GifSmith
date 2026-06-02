//! FFmpeg -> gifski streaming pipeline. FFmpeg decodes and scales the selected
//! slice, emitting raw RGBA frames on stdout; we read them frame by frame and
//! feed gifski's collector while its writer encodes on another thread. No
//! intermediate files are written, only the final .gif.

use std::fs::File;
use std::io::{self, Read};
use std::path::Path;
use std::process::{Command, Stdio};
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
) -> Result<(), EncodeError> {
    let out_w = even(params.width);
    // Aspect comes from the crop region when cropping, else the full source.
    let (in_w, in_h) = match params.crop {
        Some(c) if c.w > 0 && c.h > 0 => (c.w, c.h),
        _ => (params.src_width, params.src_height),
    };
    // Derive height from input aspect so the frame byte size is known exactly
    // (avoids ffmpeg's scale=-1 rounding, which we couldn't predict).
    let out_h = if in_w == 0 {
        out_w
    } else {
        let h = (f64::from(in_h) * f64::from(out_w) / f64::from(in_w)).round() as u32;
        even(h)
    };
    let frame_bytes = out_w as usize * out_h as usize * 4;
    let duration = (params.end_secs - params.start_secs).max(0.0);
    // crop (if any) must come before scale.
    let vf = match params.crop {
        Some(c) if c.w > 0 && c.h > 0 => format!(
            "fps={},crop={}:{}:{}:{},scale={out_w}:{out_h}:flags=lanczos",
            params.fps, c.w, c.h, c.x, c.y
        ),
        _ => format!("fps={},scale={out_w}:{out_h}:flags=lanczos", params.fps),
    };

    // -ss before -i = fast (keyframe) seek; good enough for the MVP. -t bounds
    // the output to the selection length.
    let mut child = Command::new(ffmpeg)
        .args([
            "-v",
            "error",
            "-nostdin",
            "-ss",
            &format!("{:.6}", params.start_secs),
            "-i",
            &params.input_path,
            "-t",
            &format!("{duration:.6}"),
            "-vf",
            &vf,
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgba",
            "pipe:1",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(EncodeError::Spawn)?;

    let mut stdout = child.stdout.take().expect("stdout was piped");
    let mut stderr = child.stderr.take().expect("stderr was piped");

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

    // Estimated frame count for progress reporting.
    let total_frames = (duration * f64::from(params.fps)).round().max(1.0) as usize;
    let mut last_pct: i32 = -1;
    on_progress(0.0);

    let mut idx = 0usize;
    if params.boomerang {
        // Buffer every frame, then feed forward + reversed, dropping the two
        // seam frames that would otherwise duplicate at the turn-arounds.
        let mut frames: Vec<ImgVec<RGBA8>> = Vec::new();
        let mut buf = vec![0u8; frame_bytes];
        loop {
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

        let n = frames.len();
        // Output order: 0,1,..,n-1, then n-2,n-3,..,1.
        let mut order: Vec<usize> = (0..n).collect();
        if n >= 2 {
            order.extend((1..=n - 2).rev());
        }
        let total_out = order.len().max(1);
        for &i in &order {
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
    use super::even;

    #[test]
    fn even_rounds_down_and_floors_at_two() {
        assert_eq!(even(480), 480);
        assert_eq!(even(481), 480);
        assert_eq!(even(1), 2);
        assert_eq!(even(0), 2);
        assert_eq!(even(2), 2);
    }
}
