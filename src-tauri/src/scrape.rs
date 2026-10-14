//! Fallback page scraper for URL import.
//!
//! When yt-dlp has no extractor for a page, GifSmith fetches the page HTML and
//! looks for a video it can download itself. Everything here is pure (no I/O)
//! so it can be unit-tested; the fetch + download lives in `commands.rs`.
//!
//! Sources, all site-agnostic:
//! - `<video src>` / `<source src type=...>` (HLS/DASH MIME types honoured),
//!   lazy-load `data-src` / `data-video-src` / `data-hls` / `data-mp4` / ...
//!   attributes, and `<link rel=preload as=video>`.
//! - `og:video*` / `twitter:player:stream*` meta, plus `twitter:player`.
//! - JSON-LD `VideoObject` (`contentUrl`, `embedUrl`), incl. `@graph`/arrays.
//! - Any absolute `.mp4/.webm/.mov/.m4v/.m3u8/.mpd` URL in inline scripts/JSON
//!   (`\/` and `\u002F` escapes undone), including inside Dean Edwards
//!   `eval(function(p,a,c,k,e,d)...)` packed scripts, which are unpacked first.
//! - `<iframe src>` embeds (and non-media `og:video` / `embedUrl`), returned as
//!   [`MediaKind::Embed`] so the caller can hand them to yt-dlp.
//!
//! Candidates are ranked best-quality first using resolution hints (`1080p`,
//! `label`/`res`/`height` attributes or JSON keys, `1920x1080`).

use std::collections::HashMap;
use std::sync::OnceLock;

use regex::Regex;
use reqwest::Url;

/// Extensions treated as a direct video file (mirrors `commands::VIDEO_EXTENSIONS`).
const FILE_EXTENSIONS: [&str; 6] = ["mp4", "mov", "mkv", "webm", "avi", "m4v"];

/// Lazy-load / player attributes that often carry the real media URL.
const DATA_ATTRS: [&str; 10] = [
    "data-src",
    "data-video-src",
    "data-video-url",
    "data-url",
    "data-hls",
    "data-hls-url",
    "data-mp4",
    "data-video",
    "data-stream",
    "data-file",
];

/// Tag attributes that may carry a resolution hint for the tag's media URL.
const QUALITY_ATTRS: [&str; 7] = [
    "res",
    "label",
    "size",
    "height",
    "data-res",
    "data-quality",
    "title",
];

/// Substrings marking ads, trackers, and thumbnail/preview clips.
const JUNK_MEDIA: [&str; 10] = [
    "doubleclick",
    "googlesyndication",
    "googleads",
    "/ads/",
    "adserver",
    "preroll",
    "advert",
    "thumbnail",
    "/thumbs/",
    "sprite",
];

/// Iframe hosts that are never video players.
const JUNK_EMBEDS: [&str; 12] = [
    "googletagmanager",
    "doubleclick",
    "googlesyndication",
    "facebook.com/plugins",
    "disqus",
    "recaptcha",
    "google.com/maps",
    "platform.twitter.com/widgets",
    "/ads/",
    "adserver",
    "chat",
    "consent",
];

/// What kind of media a candidate URL points at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MediaKind {
    /// A direct video file; carries the lowercased extension.
    File(String),
    /// An HLS playlist (`.m3u8`), remuxed by ffmpeg.
    Hls,
    /// A DASH manifest (`.mpd`), remuxed by ffmpeg.
    Dash,
    /// Found in a video tag/meta/JSON-LD but with no recognisable extension;
    /// handed to ffmpeg, which probes the content itself.
    Unknown,
    /// An HTML player page (iframe / embed URL): try yt-dlp, then scrape it.
    Embed,
}

impl MediaKind {
    /// Tie-break order at equal resolution. Adaptive manifests come first: an
    /// unlabelled master playlist usually carries the top rendition, while an
    /// unlabelled file is often a preview.
    fn rank(&self) -> u8 {
        match self {
            MediaKind::Hls => 0,
            MediaKind::Dash => 1,
            MediaKind::File(_) => 2,
            MediaKind::Unknown => 3,
            MediaKind::Embed => 4,
        }
    }
}

/// A downloadable video (or embed page) URL found on a page.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub url: String,
    pub kind: MediaKind,
    /// Best resolution hint (frame height in px), 0 if unknown.
    pub height: u32,
}

/// How a raw URL should be classified when it has no media extension.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Fallback {
    /// Drop it (a `data-*` attribute pointing at a non-media URL).
    Drop,
    /// Keep it as [`MediaKind::Unknown`] (came from a video-specific source).
    Unknown,
    /// Keep it as [`MediaKind::Embed`] (iframe / embed URL).
    Embed,
    /// Force HLS (e.g. `type="application/x-mpegURL"`).
    Hls,
    /// Force DASH (`type="application/dash+xml"`).
    Dash,
}

struct Raw {
    url: String,
    fallback: Fallback,
    height: u32,
}

fn re(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("scrape regex is a valid literal"))
}

fn tag_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"(?is)<([a-z][a-z0-9-]*)\b([^>]*)>")
}

fn attr_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(
        &R,
        r#"(?is)([a-z_:][-a-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')"#,
    )
}

fn ld_json_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(
        &R,
        r#"(?is)<script[^>]*type\s*=\s*["']application/ld\+json["'][^>]*>(.*?)</script>"#,
    )
}

fn absolute_media_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(
        &R,
        r#"(?i)https?://[^\s"'<>\\]+?\.(?:mp4|webm|mov|m4v|m3u8|mpd)(?:\?[^\s"'<>\\]*)?(?:[^a-z0-9]|$)"#,
    )
}

fn quoted_stream_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(
        &R,
        r#"(?i)["']([^"'\s<>\\]+?\.(?:m3u8|mpd)(?:\?[^"'\s<>\\]*)?)["']"#,
    )
}

fn json_object_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"(?s)\{[^{}]{0,800}\}")
}

fn json_quality_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(
        &R,
        r#"(?i)["']?(?:label|res|height|quality|resolution|size)["']?\s*:\s*["']?(\d{3,4})"#,
    )
}

fn packed_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(
        &R,
        r"(?s)\}\s*\(\s*'((?:[^'\\]|\\.)*)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'((?:[^'\\]|\\.)*)'\s*\.split\(\s*'\|'\s*\)",
    )
}

fn word_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"\b\w+\b")
}

fn height_p_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"(?i)(?:^|[^0-9])(\d{3,4})p(?:[^a-z0-9]|$)")
}

fn height_x_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"(?:^|[^0-9])\d{3,4}x(\d{3,4})(?:[^0-9]|$)")
}

/// Undo the common JSON escapes for `/` so URLs in inline-script JSON become
/// plain URLs.
fn unescape_json_slashes(s: &str) -> String {
    s.replace("\\/", "/")
        .replace("\\u002F", "/")
        .replace("\\u002f", "/")
}

/// Decode the handful of HTML entities that show up inside attribute URLs.
fn html_unescape(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&#38;", "&")
        .replace("&#x26;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x2F;", "/")
        .replace("&#47;", "/")
}

/// Plausible video frame height from a number, else 0.
fn plausible_height(n: u32) -> u32 {
    if (144..=4320).contains(&n) {
        n
    } else {
        0
    }
}

/// Resolution hint from free text: `1080p`, `1920x1080`, or a bare number.
fn height_hint(s: &str) -> u32 {
    if let Some(c) = height_x_re().captures(s) {
        return plausible_height(c[1].parse().unwrap_or(0));
    }
    if let Some(c) = height_p_re().captures(s) {
        return plausible_height(c[1].parse().unwrap_or(0));
    }
    let digits: String = s.chars().filter(char::is_ascii_digit).collect();
    if digits.len() == s.trim().len() && !digits.is_empty() {
        return plausible_height(digits.parse().unwrap_or(0));
    }
    0
}

/// Resolution hint from a URL (`.../video_1080p.mp4`, `.../1920x1080/...`).
fn url_height_hint(url: &str) -> u32 {
    let path = url.split('?').next().unwrap_or(url);
    if let Some(c) = height_x_re().captures(path) {
        return plausible_height(c[1].parse().unwrap_or(0));
    }
    height_p_re()
        .captures(path)
        .map_or(0, |c| plausible_height(c[1].parse().unwrap_or(0)))
}

fn resolve(base: &Url, raw: &str) -> Option<Url> {
    let raw = html_unescape(raw.trim());
    if raw.is_empty() {
        return None;
    }
    let url = base.join(&raw).ok()?;
    matches!(url.scheme(), "http" | "https").then_some(url)
}

fn ext_kind(url: &Url) -> Option<MediaKind> {
    let path = url.path().to_ascii_lowercase();
    let ext = path.rsplit_once('.').map_or("", |(_, e)| e);
    if FILE_EXTENSIONS.contains(&ext) {
        Some(MediaKind::File(ext.to_string()))
    } else if ext == "m3u8" {
        Some(MediaKind::Hls)
    } else if ext == "mpd" {
        Some(MediaKind::Dash)
    } else {
        None
    }
}

fn parse_attrs(attrs: &str) -> HashMap<String, String> {
    attr_re()
        .captures_iter(attrs)
        .map(|c| {
            let v = c.get(2).or_else(|| c.get(3)).map_or("", |m| m.as_str());
            (c[1].to_ascii_lowercase(), v.to_string())
        })
        .collect()
}

fn tag_height(attrs: &HashMap<String, String>) -> u32 {
    QUALITY_ATTRS
        .iter()
        .filter_map(|k| attrs.get(*k))
        .map(|v| height_hint(v))
        .max()
        .unwrap_or(0)
}

fn collect_tags(html: &str, raw: &mut Vec<Raw>) {
    for cap in tag_re().captures_iter(html) {
        let name = cap[1].to_ascii_lowercase();
        let attrs = parse_attrs(&cap[2]);
        let height = tag_height(&attrs);
        let mut push = |url: &str, fallback: Fallback| {
            raw.push(Raw {
                url: url.to_string(),
                fallback,
                height,
            });
        };
        match name.as_str() {
            "video" | "source" => {
                if let Some(src) = attrs.get("src") {
                    let ty = attrs
                        .get("type")
                        .map(|t| t.to_ascii_lowercase())
                        .unwrap_or_default();
                    let fb = if ty.contains("mpegurl") {
                        Fallback::Hls
                    } else if ty.contains("dash") {
                        Fallback::Dash
                    } else {
                        Fallback::Unknown
                    };
                    push(src, fb);
                }
            }
            "iframe" | "embed" => {
                for k in ["src", "data-src", "data-lazy-src"] {
                    if let Some(src) = attrs.get(k) {
                        push(src, Fallback::Embed);
                    }
                }
            }
            "link" => {
                let rel = attrs.get("rel").map(|s| s.to_ascii_lowercase());
                let as_ = attrs.get("as").map(|s| s.to_ascii_lowercase());
                if rel.as_deref().is_some_and(|r| r.contains("preload"))
                    && as_.as_deref() == Some("video")
                {
                    if let Some(href) = attrs.get("href") {
                        push(href, Fallback::Unknown);
                    }
                }
            }
            "meta" => {
                let key = attrs
                    .get("property")
                    .or_else(|| attrs.get("name"))
                    .map(|k| k.to_ascii_lowercase())
                    .unwrap_or_default();
                if let Some(content) = attrs.get("content") {
                    if matches!(
                        key.as_str(),
                        "og:video" | "og:video:url" | "og:video:secure_url"
                    ) {
                        push(content, Fallback::Embed);
                    } else if key.starts_with("twitter:player:stream") && !key.ends_with("type") {
                        push(content, Fallback::Unknown);
                    } else if key == "twitter:player" {
                        push(content, Fallback::Embed);
                    }
                }
            }
            _ => {}
        }
        if name != "iframe" && name != "embed" {
            for k in DATA_ATTRS {
                if let Some(v) = attrs.get(k) {
                    let fb = if k.contains("hls") {
                        Fallback::Hls
                    } else {
                        Fallback::Drop
                    };
                    push(v, fb);
                }
            }
        }
    }
}

fn json_height(v: &serde_json::Value) -> u32 {
    match v {
        serde_json::Value::Number(n) => {
            plausible_height(u32::try_from(n.as_u64().unwrap_or(0)).unwrap_or(0))
        }
        serde_json::Value::String(s) => height_hint(s),
        serde_json::Value::Object(o) => o.get("value").map_or(0, json_height),
        _ => 0,
    }
}

fn is_video_object(o: &serde_json::Map<String, serde_json::Value>) -> bool {
    match o.get("@type") {
        Some(serde_json::Value::String(s)) => s.eq_ignore_ascii_case("VideoObject"),
        Some(serde_json::Value::Array(a)) => a.iter().any(|t| {
            t.as_str()
                .is_some_and(|s| s.eq_ignore_ascii_case("VideoObject"))
        }),
        _ => false,
    }
}

fn walk_ld(v: &serde_json::Value, raw: &mut Vec<Raw>, depth: u8) {
    if depth > 16 {
        return;
    }
    match v {
        serde_json::Value::Array(a) => a.iter().for_each(|x| walk_ld(x, raw, depth + 1)),
        serde_json::Value::Object(o) => {
            if is_video_object(o) {
                let height = o.get("height").map_or(0, json_height);
                if let Some(u) = o.get("contentUrl").and_then(|u| u.as_str()) {
                    raw.push(Raw {
                        url: u.to_string(),
                        fallback: Fallback::Unknown,
                        height,
                    });
                }
                if let Some(u) = o.get("embedUrl").and_then(|u| u.as_str()) {
                    raw.push(Raw {
                        url: u.to_string(),
                        fallback: Fallback::Embed,
                        height,
                    });
                }
            }
            o.values().for_each(|x| walk_ld(x, raw, depth + 1));
        }
        _ => {}
    }
}

fn collect_ld_json(html: &str, raw: &mut Vec<Raw>) {
    for cap in ld_json_re().captures_iter(html) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(cap[1].trim()) {
            walk_ld(&v, raw, 0);
        }
    }
}

fn collect_script_urls(text: &str, raw: &mut Vec<Raw>) {
    let text = unescape_json_slashes(text);
    // Resolution hints from small JSON-ish objects: {"file":"..","label":"1080p"}.
    let mut hints: HashMap<String, u32> = HashMap::new();
    for obj in json_object_re().find_iter(&text) {
        let o = obj.as_str();
        let h = json_quality_re()
            .captures_iter(o)
            .map(|c| plausible_height(c[1].parse().unwrap_or(0)))
            .max()
            .unwrap_or(0);
        if h == 0 {
            continue;
        }
        for m in absolute_media_re().find_iter(o) {
            let e = hints
                .entry(trim_media_match(m.as_str()).to_string())
                .or_insert(0);
            *e = (*e).max(h);
        }
    }
    for m in absolute_media_re().find_iter(&text) {
        let url = trim_media_match(m.as_str());
        raw.push(Raw {
            url: url.to_string(),
            fallback: Fallback::Drop,
            height: hints.get(url).copied().unwrap_or(0),
        });
    }
    for cap in quoted_stream_re().captures_iter(&text) {
        raw.push(Raw {
            url: cap[1].to_string(),
            fallback: Fallback::Drop,
            height: 0,
        });
    }
}

/// The absolute-URL regex consumes one trailing delimiter char; strip it.
fn trim_media_match(m: &str) -> &str {
    let last = m.chars().last().unwrap_or('a');
    if last.is_ascii_alphanumeric() {
        m
    } else {
        &m[..m.len() - last.len_utf8()]
    }
}

/// Decode a Dean Edwards packer token in base `radix` (alphabet `0-9a-zA-Z`).
fn decode_base(token: &str, radix: u32) -> Option<usize> {
    let mut n: usize = 0;
    for ch in token.chars() {
        let d = match ch {
            '0'..='9' => ch as u32 - '0' as u32,
            'a'..='z' => ch as u32 - 'a' as u32 + 10,
            'A'..='Z' => ch as u32 - 'A' as u32 + 36,
            _ => return None,
        };
        if d >= radix {
            return None;
        }
        n = n.checked_mul(radix as usize)?.checked_add(d as usize)?;
    }
    Some(n)
}

/// Unpack every Dean Edwards `eval(function(p,a,c,k,e,d){...}('payload',a,c,
/// 'k|e|y|s'.split('|')...))` script in `html`. Many file hosts hide their
/// player config (and HLS URL) this way. Returns the unpacked sources.
#[must_use]
pub fn unpack_packed(html: &str) -> Vec<String> {
    let mut out = Vec::new();
    for cap in packed_re().captures_iter(html) {
        let payload = cap[1].replace("\\'", "'").replace("\\\\", "\\");
        let Ok(radix) = cap[2].parse::<u32>() else {
            continue;
        };
        if !(2..=62).contains(&radix) {
            continue;
        }
        let words: Vec<&str> = cap[4].split('|').collect();
        let unpacked = word_re().replace_all(&payload, |w: &regex::Captures| {
            let tok = &w[0];
            match decode_base(tok, radix).and_then(|i| words.get(i)) {
                Some(word) if !word.is_empty() => (*word).to_string(),
                _ => tok.to_string(),
            }
        });
        out.push(unpacked.into_owned());
    }
    out
}

fn is_junk_media(url: &str) -> bool {
    let l = url.to_ascii_lowercase();
    JUNK_MEDIA.iter().any(|j| l.contains(j))
}

fn is_junk_embed(url: &str) -> bool {
    let l = url.to_ascii_lowercase();
    JUNK_EMBEDS.iter().any(|j| l.contains(j))
}

/// Extract downloadable video candidates from `html`, resolved against
/// `page_url`, deduplicated, http/https only. Media candidates come first,
/// highest resolution hint first (ties: HLS > DASH > file > unknown); embed
/// pages come last in document order. Empty if `page_url` isn't a valid URL.
#[must_use]
pub fn extract_candidates(html: &str, page_url: &str) -> Vec<Candidate> {
    let Ok(base) = Url::parse(page_url) else {
        return Vec::new();
    };
    let mut raw: Vec<Raw> = Vec::new();
    collect_tags(html, &mut raw);
    collect_ld_json(html, &mut raw);
    collect_script_urls(html, &mut raw);
    for unpacked in unpack_packed(html) {
        collect_tags(&unpacked, &mut raw);
        collect_script_urls(&unpacked, &mut raw);
    }

    let mut out: Vec<Candidate> = Vec::new();
    for r in raw {
        let Some(url) = resolve(&base, &r.url) else {
            continue;
        };
        let kind = match (ext_kind(&url), r.fallback) {
            (Some(k), _) => k,
            (None, Fallback::Hls) => MediaKind::Hls,
            (None, Fallback::Dash) => MediaKind::Dash,
            (None, Fallback::Unknown) => MediaKind::Unknown,
            (None, Fallback::Embed) => MediaKind::Embed,
            (None, Fallback::Drop) => continue,
        };
        let url_s = url.to_string();
        let junk = if kind == MediaKind::Embed {
            is_junk_embed(&url_s) || url_s == base.as_str()
        } else {
            is_junk_media(&url_s)
        };
        if junk {
            continue;
        }
        let height = r.height.max(url_height_hint(&url_s));
        if let Some(existing) = out.iter_mut().find(|c| c.url == url_s) {
            existing.height = existing.height.max(height);
            if existing.kind == MediaKind::Unknown && kind != MediaKind::Embed {
                existing.kind = kind;
            }
            continue;
        }
        out.push(Candidate {
            url: url_s,
            kind,
            height,
        });
    }
    out.sort_by_key(|c| {
        let embed = c.kind == MediaKind::Embed;
        (
            embed,
            std::cmp::Reverse(if embed { 0 } else { c.height }),
            c.kind.rank(),
        )
    });
    out
}

/// The variant chosen from an HLS master playlist.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HlsChoice {
    /// Absolute URL of the chosen variant (media) playlist.
    pub video: String,
    /// Absolute URL of the matching separate audio rendition, if any.
    pub audio: Option<String>,
    pub height: u32,
    pub bandwidth: u64,
}

fn hls_attrs(line: &str) -> HashMap<String, String> {
    static R: OnceLock<Regex> = OnceLock::new();
    let r = re(&R, r#"([A-Z0-9-]+)=("[^"]*"|[^,]*)"#);
    r.captures_iter(line)
        .map(|c| (c[1].to_string(), c[2].trim_matches('"').to_string()))
        .collect()
}

/// Pick the best variant of an HLS master playlist: highest resolution, then
/// highest bandwidth. Returns its absolute URL plus the matching audio group's
/// rendition (DEFAULT=YES preferred) when audio is carried separately. Returns
/// `None` for a media (non-master) playlist or an unparseable base URL.
#[must_use]
pub fn best_hls_variant(master: &str, base_url: &str) -> Option<HlsChoice> {
    let base = Url::parse(base_url).ok()?;
    let abs = |u: &str| {
        base.join(u.trim())
            .ok()
            .filter(|u| matches!(u.scheme(), "http" | "https"))
            .map(|u| u.to_string())
    };
    // (group, uri, default)
    let mut audio: Vec<(String, String, bool)> = Vec::new();
    // (height, bandwidth, uri, audio group)
    let mut variants: Vec<(u32, u64, String, Option<String>)> = Vec::new();
    let mut lines = master.lines().map(str::trim).peekable();
    while let Some(line) = lines.next() {
        if let Some(rest) = line.strip_prefix("#EXT-X-MEDIA:") {
            let a = hls_attrs(rest);
            if a.get("TYPE").map(String::as_str) == Some("AUDIO") {
                if let (Some(g), Some(u)) = (a.get("GROUP-ID"), a.get("URI")) {
                    let default = a.get("DEFAULT").map(String::as_str) == Some("YES");
                    audio.push((g.clone(), u.clone(), default));
                }
            }
        } else if let Some(rest) = line.strip_prefix("#EXT-X-STREAM-INF:") {
            let a = hls_attrs(rest);
            let height = a
                .get("RESOLUTION")
                .and_then(|r| r.split_once('x'))
                .and_then(|(_, h)| h.parse().ok())
                .unwrap_or(0);
            let bandwidth = a.get("BANDWIDTH").and_then(|b| b.parse().ok()).unwrap_or(0);
            let uri = loop {
                match lines.next() {
                    Some(l) if l.is_empty() || l.starts_with('#') => {}
                    Some(l) => break Some(l.to_string()),
                    None => break None,
                }
            };
            if let Some(uri) = uri {
                variants.push((height, bandwidth, uri, a.get("AUDIO").cloned()));
            }
        }
    }
    let (height, bandwidth, uri, group) =
        variants.into_iter().max_by_key(|(h, b, _, _)| (*h, *b))?;
    let audio_uri = group.and_then(|g| {
        let mut in_group = audio.iter().filter(|(ag, _, _)| *ag == g);
        let first = in_group.clone().next();
        in_group
            .find(|(_, _, d)| *d)
            .or(first)
            .and_then(|(_, u, _)| abs(u))
    });
    Some(HlsChoice {
        video: abs(&uri)?,
        audio: audio_uri,
        height,
        bandwidth,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAGE: &str = "https://example.com/watch/123";

    fn urls(c: &[Candidate]) -> Vec<&str> {
        c.iter().map(|c| c.url.as_str()).collect()
    }

    #[test]
    fn finds_video_and_source_tags() {
        let html = r#"<video controls src="https://cdn.example.com/a.mp4" poster="p.jpg"></video>
            <video><source type="video/webm" src='https://cdn.example.com/b.webm'></video>"#;
        let c = extract_candidates(html, PAGE);
        assert_eq!(
            urls(&c),
            [
                "https://cdn.example.com/a.mp4",
                "https://cdn.example.com/b.webm"
            ]
        );
        assert_eq!(c[0].kind, MediaKind::File("mp4".into()));
    }

    #[test]
    fn source_type_marks_extensionless_hls_and_dash() {
        let html = r#"<source src="/play?id=1" type="application/x-mpegURL">
            <source src="/manifest?id=1" type="application/dash+xml">"#;
        let c = extract_candidates(html, PAGE);
        assert_eq!(c[0].kind, MediaKind::Hls);
        assert_eq!(c[0].url, "https://example.com/play?id=1");
        assert_eq!(c[1].kind, MediaKind::Dash);
    }

    #[test]
    fn finds_data_attributes_and_preload_links() {
        let html = r#"<div class="player" data-video-src="https://v.example.com/main.mp4" data-src="/img/cover.jpg"></div>
            <div data-hls="https://v.example.com/live?k=1"></div>
            <link rel="preload" as="video" href="/media/intro.webm">"#;
        let c = extract_candidates(html, PAGE);
        assert_eq!(
            urls(&c),
            [
                "https://v.example.com/live?k=1",
                "https://v.example.com/main.mp4",
                "https://example.com/media/intro.webm",
            ]
        );
    }

    #[test]
    fn finds_og_and_twitter_meta_and_embeds() {
        let html = r#"<meta property="og:video:secure_url" content="https://v.example.com/x.mp4">
            <meta content="https://v.example.com/y.m3u8" name="twitter:player:stream" />
            <meta name="twitter:player" content="https://player.example.com/embed/9">
            <meta property="og:video" content="https://player.example.com/embed/9">
            <meta property="og:image" content="https://v.example.com/thumb.jpg">"#;
        let c = extract_candidates(html, PAGE);
        assert_eq!(
            urls(&c),
            [
                "https://v.example.com/y.m3u8",
                "https://v.example.com/x.mp4",
                "https://player.example.com/embed/9",
            ]
        );
        assert_eq!(c[2].kind, MediaKind::Embed);
    }

    #[test]
    fn finds_iframes_and_skips_junk_frames() {
        let html = r#"<iframe src="https://player.vimeo.com/video/76979871?h=x"></iframe>
            <iframe data-src="//www.youtube.com/embed/abc"></iframe>
            <iframe src="https://www.googletagmanager.com/ns.html?id=GTM"></iframe>
            <iframe src="about:blank"></iframe>"#;
        let c = extract_candidates(html, PAGE);
        assert_eq!(
            urls(&c),
            [
                "https://player.vimeo.com/video/76979871?h=x",
                "https://www.youtube.com/embed/abc",
            ]
        );
        assert!(c.iter().all(|c| c.kind == MediaKind::Embed));
    }

    #[test]
    fn finds_json_ld_video_objects_in_graph_and_arrays() {
        let html = r#"<script type="application/ld+json">{"@context":"https://schema.org","@graph":[
            {"@type":"WebPage"},
            {"@type":["VideoObject"],"contentUrl":"https://cdn.example.com/v/full.mp4","embedUrl":"https://player.example.com/e/1","height":"1080"}]}</script>
            <script type="application/ld+json">[{"@type":"VideoObject","contentUrl":"https://cdn.example.com/stream/abc"}]</script>"#;
        let c = extract_candidates(html, PAGE);
        assert_eq!(
            urls(&c),
            [
                "https://cdn.example.com/v/full.mp4",
                "https://cdn.example.com/stream/abc",
                "https://player.example.com/e/1",
            ]
        );
        assert_eq!(c[0].height, 1080);
        assert_eq!(c[1].kind, MediaKind::Unknown);
    }

    #[test]
    fn resolves_relative_urls_and_unescapes_entities() {
        let html = r#"<video src="/media/clip.mp4?a=1&amp;b=2"></video>
            <source src="../hls/master.m3u8"><video src="//other.example.net/v.mov">"#;
        let c = extract_candidates(html, PAGE);
        assert_eq!(
            urls(&c),
            [
                "https://example.com/hls/master.m3u8",
                "https://example.com/media/clip.mp4?a=1&b=2",
                "https://other.example.net/v.mov",
            ]
        );
    }

    #[test]
    fn finds_escaped_script_urls_and_filters_junk() {
        let html = r#"<script>var cfg = {"hls":"https:\/\/s.example.com\/live\/index.m3u8?token=abc","dash":"https:\u002F\u002Fs.example.com\u002Fd\u002Fmanifest.mpd",
            "ad":"https://pubads.doubleclick.net/x/ad.mp4","thumb":"https://s.example.com/thumbnail/t.mp4"};</script>"#;
        let c = extract_candidates(html, PAGE);
        assert_eq!(
            urls(&c),
            [
                "https://s.example.com/live/index.m3u8?token=abc",
                "https://s.example.com/d/manifest.mpd",
            ]
        );
        assert_eq!(c[1].kind, MediaKind::Dash);
    }

    #[test]
    fn ranks_renditions_highest_resolution_first() {
        let html = r#"<script>player.setup({sources:[
            {"file":"https://cdn.example.com/v/a.mp4","label":"360p"},
            {"file":"https://cdn.example.com/v/b.mp4","label":"1080p"},
            {"file":"https://cdn.example.com/v/c.mp4","label":"720p"}]});</script>
            <video><source src="https://cdn.example.com/v/clip_480p.mp4"><source src="https://cdn.example.com/v/hd.mp4" res="1440"></video>"#;
        let c = extract_candidates(html, PAGE);
        assert_eq!(
            urls(&c),
            [
                "https://cdn.example.com/v/hd.mp4",
                "https://cdn.example.com/v/b.mp4",
                "https://cdn.example.com/v/c.mp4",
                "https://cdn.example.com/v/clip_480p.mp4",
                "https://cdn.example.com/v/a.mp4",
            ]
        );
        assert_eq!(c[0].height, 1440);
    }

    #[test]
    fn dedupes_and_ties_prefer_hls_then_dash_then_file() {
        let html = r#"<script>x="https://s.example.com/m.mpd"; y="https://s.example.com/p.m3u8";</script>
            <video src="https://s.example.com/p.m3u8"></video>
            <meta property="og:video" content="https://s.example.com/f.mp4">
            <meta property="og:video:url" content="https://s.example.com/f.mp4">
            <video src="https://s.example.com/stream?id=9"></video>"#;
        let c = extract_candidates(html, PAGE);
        assert_eq!(
            urls(&c),
            [
                "https://s.example.com/p.m3u8",
                "https://s.example.com/m.mpd",
                "https://s.example.com/f.mp4",
                "https://s.example.com/stream?id=9",
            ]
        );
    }

    #[test]
    fn unpacks_dean_edwards_packed_scripts() {
        // eval(function(p,a,c,k,e,d){...}('0 1="2://3.4/5.6"',7,7,'var|src|https|cdn|example|master|m3u8'.split('|'),0,{}))
        let html = r#"<script>eval(function(p,a,c,k,e,d){e=function(c){return c};if(!''.replace(/^/,String)){while(c--){d[c]=k[c]||c}k=[function(e){return d[e]}];e=function(){return'\\w+'};c=1};while(c--){if(k[c]){p=p.replace(new RegExp('\\b'+e(c)+'\\b','g'),k[c])}}return p}('0 1="2://3.4.com/5.6"',7,7,'var|src|https|cdn|example|master|m3u8'.split('|'),0,{}))</script>"#;
        let unpacked = unpack_packed(html);
        assert_eq!(
            unpacked,
            [r#"var src="https://cdn.example.com/master.m3u8""#]
        );
        let c = extract_candidates(html, PAGE);
        assert_eq!(urls(&c), ["https://cdn.example.com/master.m3u8"]);
    }

    #[test]
    fn unpacker_handles_base62_tokens() {
        // radix 62: token "A" = 36, "10" = 62.
        let mut words = vec![""; 63];
        words[36] = "hello";
        words[62] = "world";
        let html = format!(
            "}}('A 10 zz',62,63,'{}'.split('|'),0,{{}}))",
            words.join("|")
        );
        assert_eq!(unpack_packed(&html), ["hello world zz"]);
        assert_eq!(decode_base("10", 62), Some(62));
        assert_eq!(decode_base("Z", 36), None);
    }

    #[test]
    fn drops_non_http_schemes() {
        let html = r#"<video src="blob:https://example.com/uuid"></video>
            <video src="data:video/mp4;base64,AAAA"></video>
            <source src="file:///etc/passwd.mp4"><video src="javascript:alert(1)">
            <iframe src="javascript:void(0)"></iframe>"#;
        assert!(extract_candidates(html, PAGE).is_empty());
    }

    #[test]
    fn no_candidates_on_plain_page_or_bad_base() {
        let html = "<html><body><img src='a.png' data-src='/b.png'><a href='/about'>About</a></body></html>";
        assert!(extract_candidates(html, PAGE).is_empty());
        assert!(extract_candidates(r#"<video src="a.mp4">"#, "not a url").is_empty());
    }

    #[test]
    fn height_hints() {
        assert_eq!(height_hint("1080p"), 1080);
        assert_eq!(height_hint("1920x1080"), 1080);
        assert_eq!(height_hint("720"), 720);
        assert_eq!(height_hint("HD"), 0);
        assert_eq!(url_height_hint("https://x/v_720p.mp4?id=1080p"), 720);
        assert_eq!(url_height_hint("https://x/1280x720/v.mp4"), 720);
        assert_eq!(url_height_hint("https://x/v/12345.mp4"), 0);
    }

    const MASTER: &str = "#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"aac\",NAME=\"English\",DEFAULT=NO,URI=\"audio/en_lo.m3u8\"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"aac\",NAME=\"English HQ\",DEFAULT=YES,URI=\"audio/en.m3u8\"
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS=\"avc1.4d401e,mp4a.40.2\",AUDIO=\"aac\"
v360/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,AUDIO=\"aac\"
v1080/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,AUDIO=\"aac\"
v1080lo/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,AUDIO=\"aac\"
https://other.example.com/v720.m3u8
";

    #[test]
    fn picks_highest_hls_variant_with_matching_audio() {
        let c = best_hls_variant(MASTER, "https://cdn.example.com/show/master.m3u8")
            .expect("master playlist");
        assert_eq!(c.video, "https://cdn.example.com/show/v1080/index.m3u8");
        assert_eq!(
            c.audio.as_deref(),
            Some("https://cdn.example.com/show/audio/en.m3u8")
        );
        assert_eq!((c.height, c.bandwidth), (1080, 6_000_000));
    }

    #[test]
    fn hls_variant_without_resolution_uses_bandwidth_and_muxed_audio() {
        let m = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=300000\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=900000\nhigh.m3u8\n";
        let c = best_hls_variant(m, "https://h.example.com/a/m.m3u8").expect("master");
        assert_eq!(c.video, "https://h.example.com/a/high.m3u8");
        assert_eq!(c.audio, None);
        // A media playlist (segments, no variants) isn't a master.
        let media = "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg0.ts\n";
        assert_eq!(
            best_hls_variant(media, "https://h.example.com/a/m.m3u8"),
            None
        );
    }
}
