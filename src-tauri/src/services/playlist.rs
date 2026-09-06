//! Playlist discovery: expand a playlist URL into normal queue jobs.
//!
//! Uses the bundled yt-dlp with flat JSON extraction — no media is ever
//! downloaded here. Shares the binary resolver and the child-PATH
//! environment (Deno fallback) with normal downloads, and never touches a
//! shell: the URL travels as one argv element.

use std::time::Duration;
use tauri::AppHandle;

use super::ytdlp::{first_meaningful_line, is_valid_http_url, resolve_ytdlp_path, yt_dlp_command};

/// Bound so a wedged extraction cannot hang the command forever. Flat
/// extraction is metadata-only and streams nothing, so even large
/// playlists finish well inside this; genuine hangs fail loudly instead.
const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(120);

/// One usable playlist item. Only the URL is required downstream; the title
/// rides along for diagnostics and future display.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlaylistEntry {
    pub url: String,
    pub title: Option<String>,
}

/// Discovery outcome: usable entries in playlist order plus how many raw
/// entries had to be skipped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlaylistDiscovery {
    pub entries: Vec<PlaylistEntry>,
    pub skipped: usize,
}

/// Pure argv for enumeration. Structured JSON, flat (metadata only),
/// playlist behavior explicit. Deliberately NO `-f`, NO `-o`, NO `-x`,
/// NO `--audio-format`: discovery must never download or convert media.
pub fn build_discovery_args(url: &str) -> Vec<String> {
    vec![
        "--flat-playlist".to_string(),
        "--dump-single-json".to_string(),
        "--yes-playlist".to_string(),
        "--no-warnings".to_string(),
        url.to_string(),
    ]
}

/// Prefer yt-dlp's own resolved item URL; fall back through related fields.
/// Anything that is not a usable http(s) URL is rejected (never shelled
// out, never executed — just skipped by the caller).
fn entry_url(entry: &serde_json::Value) -> Option<String> {
    let object = entry.as_object()?;
    for key in ["url", "webpage_url", "original_url"] {
        if let Some(url) = object.get(key).and_then(|value| value.as_str()) {
            let trimmed = url.trim();
            if is_valid_http_url(trimmed) {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

fn entry_title(entry: &serde_json::Value) -> Option<String> {
    entry
        .get("title")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .map(str::to_string)
}

/// Parse `--dump-single-json` output. Rules, in order:
/// 1. a non-empty `entries` array wins → playlist path (unusable raw
///    entries are skipped, never fatal);
/// 2. otherwise a single video item (`_type == "video"` with a usable
///    `webpage_url`) becomes exactly one job — playlist mode on a plain
///    video URL is friendly, not an error;
/// 3. anything else (empty playlist, failure `null`, garbage) is an error.
pub fn parse_playlist_json(text: &str) -> Result<PlaylistDiscovery, String> {
    let value: serde_json::Value = serde_json::from_str(text)
        .map_err(|_| "Could not understand the playlist response.".to_string())?;
    let root = value
        .as_object()
        .ok_or_else(|| "Could not understand the playlist response.".to_string())?;

    if let Some(entries) = root.get("entries").and_then(|value| value.as_array()) {
        if !entries.is_empty() {
            let mut items = Vec::with_capacity(entries.len());
            let mut skipped = 0usize;
            for entry in entries {
                match entry_url(entry) {
                    Some(url) => items.push(PlaylistEntry {
                        url,
                        title: entry_title(entry),
                    }),
                    None => skipped += 1,
                }
            }
            return Ok(PlaylistDiscovery {
                entries: items,
                skipped,
            });
        }
        return Err("This playlist has no downloadable items.".to_string());
    }

    let is_single_video = root
        .get("_type")
        .and_then(|value| value.as_str())
        .is_some_and(|kind| kind == "video");
    if is_single_video {
        if let Some(url) = root
            .get("webpage_url")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|url| is_valid_http_url(url))
        {
            return Ok(PlaylistDiscovery {
                entries: vec![PlaylistEntry {
                    url: url.to_string(),
                    title: entry_title(&value),
                }],
                skipped: 0,
            });
        }
    }

    Err("This URL did not resolve to a playlist or a downloadable item.".to_string())
}

/// Run discovery against the live binary and parse the result. No media is
/// downloaded; failures surface yt-dlp's own error line for diagnostics.
pub async fn discover_entries(app: &AppHandle, url: &str) -> Result<PlaylistDiscovery, String> {
    let binary = resolve_ytdlp_path(app)?;
    let args = build_discovery_args(url);
    let child = yt_dlp_command(&binary)
        .args(&args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|err| format!("Could not launch yt-dlp: {}", err))?;

    let output = tokio::time::timeout(DISCOVERY_TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| {
            "Playlist extraction timed out. The playlist may be too large or the network too slow."
                .to_string()
        })
        .and_then(|result| result.map_err(|err| format!("Playlist extraction failed: {}", err)))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let trimmed = stderr.trim();
        return Err(first_meaningful_line(trimmed)
            .unwrap_or_else(|| "Playlist extraction failed.".to_string()));
    }
    parse_playlist_json(&String::from_utf8_lossy(&output.stdout))
}

/// Build one child download request from the common playlist settings and
/// the resolved per-entry URL. The rest of the pipeline (validation,
/// argv, sidecar, worker) treats it exactly like a manual single request.
pub fn child_request(
    common: &super::ytdlp::StartDownloadRequest,
    entry_url: String,
) -> super::ytdlp::StartDownloadRequest {
    super::ytdlp::StartDownloadRequest {
        url: entry_url,
        media_type: common.media_type,
        quality: common.quality,
        audio_format: common.audio_format,
        output_directory: common.output_directory.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::ytdlp::{AudioFormat, MediaType};

    /// Minimal flat-playlist JSON in yt-dlp's shape. Extra unknown fields
    /// ride along to prove they are ignored (F).
    fn playlist_fixture() -> serde_json::Value {
        serde_json::json!({
            "_type": "playlist",
            "id": "RDdQw4w9WgXcQ",
            "title": "Mix",
            "playlist_count": 3,
            "extractor": "youtube:tab",
            "entries": [
                {
                    "_type": "url",
                    "ie_key": "Youtube",
                    "id": "dQw4w9WgXcQ",
                    "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
                    "title": "Never Gonna Give You Up",
                    "duration": 213,
                    "channel": "Rick Astley",
                    "thumbnails": [{"url": "https://i.ytimg.com/vi/x/hqdefault.jpg"}],
                    "extra_unknown_future_field": {"nested": [1, 2, 3]}
                },
                {
                    "_type": "url",
                    "ie_key": "Youtube",
                    "id": "yPYZpwSpKmA",
                    "url": "https://www.youtube.com/watch?v=yPYZpwSpKmA",
                    "title": "Together Forever",
                    "duration": 201
                },
                {
                    "_type": "url",
                    "ie_key": "Youtube",
                    "id": "djV11Xbc914",
                    "url": "https://www.youtube.com/watch?v=djV11Xbc914",
                    "title": "Take On Me",
                    "duration": 225
                }
            ],
            "webpage_url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ"
        })
    }

    #[test]
    fn parses_playlist_in_order() {
        // A: three valid entries come out in playlist order with URLs+titles.
        let discovery =
            parse_playlist_json(&serde_json::to_string(&playlist_fixture()).expect("json"))
                .expect("must parse");
        assert_eq!(discovery.skipped, 0);
        let urls: Vec<&str> = discovery
            .entries
            .iter()
            .map(|entry| entry.url.as_str())
            .collect();
        assert_eq!(
            urls,
            [
                "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
                "https://www.youtube.com/watch?v=yPYZpwSpKmA",
                "https://www.youtube.com/watch?v=djV11Xbc914",
            ]
        );
        assert_eq!(
            discovery.entries[0].title.as_deref(),
            Some("Never Gonna Give You Up")
        );
    }

    #[test]
    fn skips_unusable_entries() {
        // B/C: deleted (null URL), missing URL, malformed URL, and non-object
        // entries are skipped without failing the batch.
        let mut fixture = playlist_fixture();
        let entries = fixture
            .get_mut("entries")
            .expect("entries")
            .as_array_mut()
            .expect("array");
        entries.push(serde_json::json!({
            "_type": "url", "ie_key": "Youtube", "id": "deadbeef",
            "url": serde_json::Value::Null, "title": "Deleted video"
        }));
        entries.push(serde_json::json!({
            "_type": "url", "ie_key": "Youtube", "id": "private1",
            "title": "Private video"
        }));
        entries.push(serde_json::json!({
            "_type": "url", "id": "weird",
            "url": "not a url", "title": "Malformed"
        }));
        entries.push(serde_json::json!({
            "_type": "url", "id": "ftp",
            "url": "ftp://example.com/file.mp4", "title": "Wrong scheme"
        }));
        entries.push(serde_json::Value::Null);
        entries.push(serde_json::json!("just a string"));

        let discovery = parse_playlist_json(&serde_json::to_string(&fixture).expect("json"))
            .expect("must parse");
        assert_eq!(discovery.entries.len(), 3, "only valid entries survive");
        assert_eq!(discovery.skipped, 6, "six bad entries skipped");
        // Order of survivors is preserved.
        assert_eq!(
            discovery.entries[2].url,
            "https://www.youtube.com/watch?v=djV11Xbc914"
        );
    }

    #[test]
    fn empty_or_useless_playlists_error() {
        // D: empty entry lists are friendly errors, never jobs. An entries
        // array whose items are all unusable parses to an empty list (the
        // enqueue command rejects that); only truly unparseable input
        // errors here.
        let mut fixture = playlist_fixture();
        fixture["entries"] = serde_json::json!([]);
        assert!(parse_playlist_json(&serde_json::to_string(&fixture).expect("json")).is_err());

        let bad = serde_json::json!({
            "_type": "playlist",
            "entries": [{"_type": "url", "url": None::<String>}]
        });
        // All-skipped parses to an empty list (skips are never fatal here);
        // the enqueue command turns that into the friendly "no downloadable
        // items" error instead of queueing anything.
        let discovery =
            parse_playlist_json(&serde_json::to_string(&bad).expect("json")).expect("parses");
        assert!(discovery.entries.is_empty());
        assert_eq!(discovery.skipped, 1);

        // Failure stdout ("null") and garbage are errors, not jobs.
        assert!(parse_playlist_json("null").is_err());
        assert!(parse_playlist_json("").is_err());
        assert!(parse_playlist_json("[1, 2, 3]").is_err());
    }

    #[test]
    fn unicode_titles_survive_parsing() {
        // E: non-ASCII metadata never breaks the parser.
        let mut fixture = playlist_fixture();
        fixture["entries"][0]["title"] =
            serde_json::json!("MONSTA X 무대 위에서 'MAGIC' MV 日本語テスト 🎬");
        let discovery = parse_playlist_json(&serde_json::to_string(&fixture).expect("json"))
            .expect("must parse");
        assert_eq!(
            discovery.entries[0].title.as_deref(),
            Some("MONSTA X 무대 위에서 'MAGIC' MV 日本語テスト 🎬")
        );
    }

    #[test]
    fn single_video_becomes_one_job() {
        // Single-item URL in playlist mode: friendly single job from the
        // extractor's own resolved page URL.
        let single = serde_json::json!({
            "_type": "video",
            "id": "sample-5s",
            "webpage_url": "https://samplelib.com/mp4/sample-5s.mp4",
            "title": "sample-5s"
        });
        let discovery = parse_playlist_json(&serde_json::to_string(&single).expect("json"))
            .expect("must parse");
        assert_eq!(discovery.skipped, 0);
        assert_eq!(discovery.entries.len(), 1);
        assert_eq!(
            discovery.entries[0].url,
            "https://samplelib.com/mp4/sample-5s.mp4"
        );
    }

    #[test]
    fn discovery_args_download_nothing() {
        // Structured JSON + flat + forced playlist; no format/output/
        // conversion flags; URL stays one trailing argument.
        let args = build_discovery_args("https://example.com/list?list=XYZ");
        assert!(args.contains(&"--flat-playlist".to_string()));
        assert!(args.contains(&"--dump-single-json".to_string()));
        assert!(args.contains(&"--yes-playlist".to_string()));
        assert!(args.contains(&"--no-warnings".to_string()));
        for forbidden in ["-f", "-o", "-x", "--extract-audio", "--audio-format"] {
            assert!(
                !args.contains(&forbidden.to_string()),
                "discovery must not carry {}, got: {:?}",
                forbidden,
                args
            );
        }
        assert_eq!(args.last().unwrap(), "https://example.com/list?list=XYZ");
        let urls = args
            .iter()
            .filter(|arg| *arg == "https://example.com/list?list=XYZ")
            .count();
        assert_eq!(urls, 1);
    }

    #[test]
    fn child_request_inherits_common_settings() {
        use crate::services::ytdlp::StartDownloadRequest;
        let common = StartDownloadRequest {
            url: "https://example.com/playlist?list=X".to_string(),
            media_type: MediaType::Audio,
            quality: None,
            audio_format: Some(AudioFormat::Mp3),
            output_directory: Some("D:\\Music".to_string()),
        };
        let child = child_request(&common, "https://example.com/watch?v=A".to_string());
        assert_eq!(child.url, "https://example.com/watch?v=A");
        assert_eq!(child.media_type, MediaType::Audio);
        assert_eq!(child.quality, None);
        assert_eq!(child.audio_format, Some(AudioFormat::Mp3));
        assert_eq!(child.output_directory, Some("D:\\Music".to_string()));
    }
}
