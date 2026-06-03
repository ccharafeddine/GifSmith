//! Parse `ffprobe -print_format json` output into a typed [`VideoMeta`].
//!
//! Kept free of Tauri/IO so it can be unit tested against captured JSON.

use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ProbeError {
    #[error("ffprobe output was not valid JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("ffprobe found no video stream")]
    NoVideoStream,
    #[error("ffprobe reported no usable duration")]
    NoDuration,
    #[error("could not parse frame rate {0:?}")]
    FrameRate(String),
}

/// Normalized video metadata the frontend consumes.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct VideoMeta {
    pub duration_secs: f64,
    pub width: u32,
    pub height: u32,
    pub fps_num: u32,
    pub fps_den: u32,
    pub codec: String,
    pub container: String,
}

// --- raw ffprobe JSON shape (only the fields we use) ---

#[derive(Deserialize)]
struct FfprobeOutput {
    streams: Vec<FfprobeStream>,
    format: FfprobeFormat,
}

#[derive(Deserialize)]
struct FfprobeStream {
    codec_type: Option<String>,
    codec_name: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    r_frame_rate: Option<String>,
    avg_frame_rate: Option<String>,
    duration: Option<String>,
    tags: Option<StreamTags>,
    side_data_list: Option<Vec<SideData>>,
}

#[derive(Deserialize)]
struct StreamTags {
    rotate: Option<String>,
}

#[derive(Deserialize)]
struct SideData {
    rotation: Option<f64>,
}

#[derive(Deserialize)]
struct FfprobeFormat {
    duration: Option<String>,
    format_name: Option<String>,
}

/// Effective display rotation in degrees from `tags.rotate` or a Display Matrix
/// side-data entry. Returns true if it's an odd quarter-turn (90/270), meaning
/// the display dimensions are the coded ones swapped.
fn is_quarter_turned(stream: &FfprobeStream) -> bool {
    let rot = stream
        .tags
        .as_ref()
        .and_then(|t| t.rotate.as_deref())
        .and_then(|r| r.trim().parse::<f64>().ok())
        .or_else(|| {
            stream
                .side_data_list
                .as_ref()
                .and_then(|list| list.iter().find_map(|s| s.rotation))
        })
        .unwrap_or(0.0);
    (rot.round().rem_euclid(180.0) - 90.0).abs() < 1.0
}

/// Parse a full ffprobe JSON document into [`VideoMeta`].
///
/// # Errors
/// Returns [`ProbeError`] if the JSON is malformed, has no video stream, or is
/// missing a parseable duration / frame rate.
pub fn parse_ffprobe_json(json: &str) -> Result<VideoMeta, ProbeError> {
    let out: FfprobeOutput = serde_json::from_str(json)?;

    let video = out
        .streams
        .iter()
        .find(|s| s.codec_type.as_deref() == Some("video"))
        .ok_or(ProbeError::NoVideoStream)?;

    // r_frame_rate is the base/exact rate; avg_frame_rate is the fallback.
    let (fps_num, fps_den) = parse_frame_rate(
        video
            .r_frame_rate
            .as_deref()
            .or(video.avg_frame_rate.as_deref()),
    )?;

    // Container duration is most reliable; fall back to the stream's own.
    let duration_secs = out
        .format
        .duration
        .as_deref()
        .or(video.duration.as_deref())
        .and_then(|d| d.parse::<f64>().ok())
        .filter(|d| d.is_finite() && *d > 0.0)
        .ok_or(ProbeError::NoDuration)?;

    let codec = video
        .codec_name
        .clone()
        .unwrap_or_else(|| "unknown".to_string());

    // format_name is often a comma list ("mov,mp4,m4a,..."); take the first.
    let container = out
        .format
        .format_name
        .as_deref()
        .map(|f| f.split(',').next().unwrap_or(f).to_string())
        .unwrap_or_else(|| "unknown".to_string());

    // Report DISPLAY dimensions: ffmpeg auto-rotates on decode, so a 90/270
    // rotated clip is shown (and cropped/exported) with width/height swapped.
    // The crop overlay must use the same coordinate system.
    let coded_w = video.width.unwrap_or(0);
    let coded_h = video.height.unwrap_or(0);
    let (width, height) = if is_quarter_turned(video) {
        (coded_h, coded_w)
    } else {
        (coded_w, coded_h)
    };

    Ok(VideoMeta {
        duration_secs,
        width,
        height,
        fps_num,
        fps_den,
        codec,
        container,
    })
}

/// Parse ffprobe's `"num/den"` rational frame rate. Rejects a zero denominator.
fn parse_frame_rate(raw: Option<&str>) -> Result<(u32, u32), ProbeError> {
    let raw = raw.ok_or_else(|| ProbeError::FrameRate("<missing>".to_string()))?;
    let (num, den) = raw
        .split_once('/')
        .ok_or_else(|| ProbeError::FrameRate(raw.to_string()))?;
    let num: u32 = num
        .parse()
        .map_err(|_| ProbeError::FrameRate(raw.to_string()))?;
    let den: u32 = den
        .parse()
        .map_err(|_| ProbeError::FrameRate(raw.to_string()))?;
    if den == 0 {
        return Err(ProbeError::FrameRate(raw.to_string()));
    }
    Ok((num, den))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{
        "streams": [
            { "codec_type": "audio", "codec_name": "aac" },
            { "codec_type": "video", "codec_name": "h264", "width": 1920,
              "height": 1080, "r_frame_rate": "30000/1001",
              "avg_frame_rate": "30000/1001", "duration": "12.345000" }
        ],
        "format": { "duration": "12.345000", "format_name": "mov,mp4,m4a,3gp,3g2,mj2" }
    }"#;

    #[test]
    fn parses_typical_mp4() {
        let m = parse_ffprobe_json(SAMPLE).expect("should parse");
        assert_eq!(m.width, 1920);
        assert_eq!(m.height, 1080);
        assert_eq!((m.fps_num, m.fps_den), (30000, 1001));
        assert_eq!(m.codec, "h264");
        assert_eq!(m.container, "mov");
        assert!((m.duration_secs - 12.345).abs() < 1e-6);
    }

    #[test]
    fn errors_when_no_video_stream() {
        let json = r#"{ "streams": [ { "codec_type": "audio" } ],
                        "format": { "duration": "1.0" } }"#;
        assert!(matches!(
            parse_ffprobe_json(json),
            Err(ProbeError::NoVideoStream)
        ));
    }

    #[test]
    fn rejects_zero_denominator_frame_rate() {
        assert!(matches!(
            parse_frame_rate(Some("30/0")),
            Err(ProbeError::FrameRate(_))
        ));
    }

    #[test]
    fn swaps_dimensions_when_rotated_90() {
        // Coded 1920x1080 with a 90deg display rotation -> display is portrait.
        let json = r#"{
            "streams": [
                { "codec_type": "video", "codec_name": "hevc", "width": 1920,
                  "height": 1080, "r_frame_rate": "30/1", "duration": "5.0",
                  "side_data_list": [ { "rotation": -90 } ] }
            ],
            "format": { "duration": "5.0", "format_name": "mov" }
        }"#;
        let m = parse_ffprobe_json(json).expect("should parse");
        assert_eq!(m.width, 1080);
        assert_eq!(m.height, 1920);
    }

    #[test]
    fn keeps_dimensions_when_rotated_180() {
        let json = r#"{
            "streams": [
                { "codec_type": "video", "codec_name": "h264", "width": 1920,
                  "height": 1080, "r_frame_rate": "30/1", "duration": "5.0",
                  "tags": { "rotate": "180" } }
            ],
            "format": { "duration": "5.0", "format_name": "mp4" }
        }"#;
        let m = parse_ffprobe_json(json).expect("should parse");
        assert_eq!(m.width, 1920);
        assert_eq!(m.height, 1080);
    }

    #[test]
    fn falls_back_to_stream_duration() {
        let json = r#"{
            "streams": [ { "codec_type": "video", "codec_name": "vp9",
                           "width": 640, "height": 480, "r_frame_rate": "24/1",
                           "duration": "5.0" } ],
            "format": { "format_name": "webm" }
        }"#;
        let m = parse_ffprobe_json(json).expect("should parse");
        assert!((m.duration_secs - 5.0).abs() < 1e-6);
        assert_eq!(m.container, "webm");
    }
}
