//! Centralized yt-dlp process logic.
//!
//! All knowledge about where the yt-dlp binary lives, which arguments to
//! pass, and how to interpret its stdout lives here. Tauri commands and the
//! frontend must not duplicate any of this.

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    OnceLock,
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};

pub const PROGRESS_EVENT: &str = "download-progress";
pub const COMPLETE_EVENT: &str = "download-complete";
pub const ERROR_EVENT: &str = "download-error";

const BINARY_FILE_NAME: &str = "yt-dlp.exe";

/// Uniqueness for per-download sidecar files.
static FINAL_PATH_COUNTER: AtomicU64 = AtomicU64::new(0);

/// What to download: full video or native audio stream. Strongly typed so
/// no raw string ever travels deep into the backend.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaType {
    Video,
    Audio,
}

/// Video resolution presets. The frontend deals in these semantic values —
/// never in yt-dlp format IDs or raw `-f` fragments. Unknown strings fail
/// deserialization, so a malicious value can never become an argument.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub enum VideoQuality {
    #[serde(rename = "best")]
    Best,
    #[serde(rename = "2160")]
    P2160,
    #[serde(rename = "1440")]
    P1440,
    #[serde(rename = "1080")]
    P1080,
    #[serde(rename = "720")]
    P720,
    #[serde(rename = "480")]
    P480,
    #[serde(rename = "360")]
    P360,
}

impl VideoQuality {
    /// Maximum stream height in pixels, or `None` for unconstrained best.
    fn max_height(self) -> Option<u32> {
        match self {
            VideoQuality::Best => None,
            VideoQuality::P2160 => Some(2160),
            VideoQuality::P1440 => Some(1440),
            VideoQuality::P1080 => Some(1080),
            VideoQuality::P720 => Some(720),
            VideoQuality::P480 => Some(480),
            VideoQuality::P360 => Some(360),
        }
    }
}

/// Structured download request from the frontend (camelCase over IPC).
/// `quality` is meaningful for video only; audio requests must send `None`.
/// `output_directory` is the user-selected folder; `None` means the normal
/// Downloads folder. The frontend never builds yt-dlp arguments.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartDownloadRequest {
    pub url: String,
    pub media_type: MediaType,
    pub quality: Option<VideoQuality>,
    /// Omitted (or null) means the normal Downloads folder.
    #[serde(default)]
    pub output_directory: Option<String>,
}

/// Validated, backend-owned options. Later features (output directory
/// picker, subtitles, playlists, …) extend this struct instead of changing
/// call sites.
#[derive(Debug, Clone)]
#[allow(
    dead_code,
    reason = "audio_only/subtitles/playlist are roadmap fields, phases 1 fills url + output_directory + media"
)]
pub struct DownloadOptions {
    pub url: String,
    pub output_directory: PathBuf,
    pub media_type: MediaType,
    /// Resolved quality for video; always `None` for audio.
    pub quality: Option<VideoQuality>,
    pub subtitles: bool,
    pub playlist: bool,
}

impl DownloadOptions {
    pub fn new(
        url: String,
        output_directory: PathBuf,
        media_type: MediaType,
        quality: Option<VideoQuality>,
    ) -> Self {
        Self {
            url,
            output_directory,
            media_type,
            quality,
            subtitles: false,
            playlist: false,
        }
    }
}

/// Validate a user-selected output directory. The frontend path is
/// untrusted input: it must be non-empty, absolute, and an existing
/// directory. No home-folder restriction — external drives, secondary
/// volumes, and UNC paths are all legitimate. Spaces, parentheses, and
/// Unicode need no special handling: the path travels as one argv element.
pub fn validate_output_directory(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Please choose an output folder first.".to_string());
    }
    let dir = PathBuf::from(trimmed);
    if !dir.is_absolute() {
        return Err("The output folder must be an absolute path.".to_string());
    }
    if !dir.exists() {
        return Err(
            "The selected output folder no longer exists. Choose another folder.".to_string(),
        );
    }
    if !dir.is_dir() {
        return Err("The selected output path is not a folder.".to_string());
    }
    Ok(dir)
}

/// Validate a frontend request into backend-owned options. Rejects invalid
/// combinations with understandable errors instead of panicking. A missing
/// output directory falls back to the normal Downloads folder.
pub fn validate_request(request: &StartDownloadRequest) -> Result<DownloadOptions, String> {
    let url = request.url.trim().to_string();
    if url.is_empty() {
        return Err("Please paste a video URL first.".to_string());
    }
    let output_directory = match &request.output_directory {
        Some(dir) => validate_output_directory(dir)?,
        None => resolve_downloads_dir()?,
    };
    match request.media_type {
        MediaType::Audio => {
            if request.quality.is_some() {
                return Err("Audio downloads do not take a video quality.".to_string());
            }
            Ok(DownloadOptions::new(
                url,
                output_directory,
                MediaType::Audio,
                None,
            ))
        }
        MediaType::Video => Ok(DownloadOptions::new(
            url,
            output_directory,
            MediaType::Video,
            // Default to Best when the frontend omits it.
            Some(request.quality.unwrap_or(VideoQuality::Best)),
        )),
    }
}

/// Structured progress payload sent to the frontend over Tauri events.
/// Percentage/speed/eta/filename are optional: when yt-dlp output cannot
/// be parsed, the UI falls back to the raw `status` text instead of
/// inventing progress.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub status: String,
    pub percentage: Option<f32>,
    pub speed: Option<String>,
    pub eta: Option<String>,
    pub filename: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadResult {
    /// Display name of the real final file (after merge/post-processing).
    pub filename: Option<String>,
    /// Full final path, kept for future features (reveal in folder, …).
    pub filepath: Option<String>,
    /// The folder this download actually went to (custom or Downloads).
    pub output_dir: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadError {
    pub message: String,
    pub details: Option<String>,
}

/// Locate the yt-dlp executable.
///
/// Search order is centralized here so dev and packaged builds share one
/// code path:
/// 1. Tauri resource directory (`resource_dir/bin/yt-dlp.exe` and
///    `resource_dir/resources/bin/yt-dlp.exe`) — packaged builds.
/// 2. `CARGO_MANIFEST_DIR/resources/bin/yt-dlp.exe` — `cargo` / `tauri dev`.
/// 3. Directory containing the current executable (plus `resources/bin`
///    beneath it) — dev and some bundle layouts.
/// 4. Current working directory fallbacks, including the legacy
///    repository-root `./yt-dlp.exe` before it was moved.
pub fn resolve_ytdlp_path(app: &AppHandle) -> Result<PathBuf, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("bin").join(BINARY_FILE_NAME));
        candidates.push(
            resource_dir
                .join("resources")
                .join("bin")
                .join(BINARY_FILE_NAME),
        );
    }

    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("bin")
            .join(BINARY_FILE_NAME),
    );

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join(BINARY_FILE_NAME));
            candidates.push(dir.join("resources").join("bin").join(BINARY_FILE_NAME));
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join(BINARY_FILE_NAME));
        candidates.push(
            cwd.join("src-tauri")
                .join("resources")
                .join("bin")
                .join(BINARY_FILE_NAME),
        );
    }

    for candidate in &candidates {
        if candidate.is_file() {
            return Ok(candidate.clone());
        }
    }

    Err(format!(
        "yt-dlp binary not found (looked for {} in {} locations). \
         Expected at src-tauri/resources/bin/yt-dlp.exe during development.",
        BINARY_FILE_NAME,
        candidates.len()
    ))
}

/// User's normal Windows Downloads folder.
pub fn resolve_downloads_dir() -> Result<PathBuf, String> {
    if let Some(dir) = dirs::download_dir() {
        return Ok(dir);
    }
    // Fallback: $HOME/Downloads.
    if let Some(home) = dirs::home_dir() {
        let fallback = home.join("Downloads");
        if fallback.is_dir() {
            return Ok(fallback);
        }
    }
    Err("Could not locate your Downloads folder.".to_string())
}

/// Convert media type + quality into a yt-dlp `-f` expression.
///
/// The ONLY place format strings are created. Selection is an exhaustive
/// match over the enums — user input only picks a variant, and heights are
/// compile-time constants, so a hostile frontend value can never become a
/// raw format expression. No exact format IDs, no site-specific IDs.
pub fn format_selector(media_type: MediaType, quality: Option<VideoQuality>) -> String {
    match media_type {
        // Best audio-ONLY stream in its source container/codec. Deliberately
        // no `/b` fallback: falling back to a combined video+audio format
        // would silently break the "Download Audio" promise. No `-x`, no mp3
        // conversion: conversion needs FFmpeg and is a later phase.
        MediaType::Audio => "ba".to_string(),
        MediaType::Video => match quality.unwrap_or(VideoQuality::Best) {
            VideoQuality::Best => "bv*+ba/b".to_string(),
            preset => {
                let height = preset
                    .max_height()
                    .expect("non-Best preset always has a height");
                format!("bv*[height<={height}]+ba/b[height<={height}]")
            }
        },
    }
}

/// Build the yt-dlp argument list in one place.
///
/// The binary is executed directly with individual arguments (never via
/// `cmd.exe /c` with a concatenated string), so the URL and the output
/// template each travel as a single argv element — no quoting or injection
/// concerns, whatever characters the folder contains.
pub fn build_download_args(options: &DownloadOptions, final_path_file: &Path) -> Vec<String> {
    let template = options
        .output_directory
        .join("%(title)s [%(id)s].%(ext)s")
        .to_string_lossy()
        .to_string();

    let mut args = vec![
        "--newline".to_string(),
        "--no-playlist".to_string(),
        // Explicit: print options can suppress progress output; this keeps
        // live progress and the final-path report coexisting.
        "--progress".to_string(),
        // Report the real final filepath after all merging/move steps, so the
        // UI never mistakes a temporary video/audio stream file for the result.
        // A sidecar FILE (not stdout text) carries the path: yt-dlp's piped
        // stdout mangles non-ANSI characters, while file I/O is exact.
        "--print-to-file".to_string(),
        "after_move:%(filepath)s".to_string(),
        final_path_file.to_string_lossy().to_string(),
        "-f".to_string(),
        format_selector(options.media_type, options.quality),
        "-o".to_string(),
        template,
    ];

    if options.subtitles {
        args.push("--write-subs".to_string());
    }

    args.push(options.url.clone());
    args
}

/// Per-download sidecar file that receives the real final path. Lives in the
/// OS temp dir — never in the user's output folder, so no litter survives a
/// successful run (it is always deleted after being read).
fn final_path_sidecar() -> PathBuf {
    let n = FINAL_PATH_COUNTER.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("ytdlp-gui-final-{}-{}.txt", std::process::id(), n))
}

/// Read the final path back: last non-empty line, CRLF tolerant. The file is
/// deleted either way; a missing or unreadable file yields `None`.
fn read_final_path_file(path: &Path) -> Option<PathBuf> {
    let text = std::fs::read_to_string(path).ok()?;
    let _ = std::fs::remove_file(path);
    text.lines()
        .map(str::trim)
        .rfind(|line| !line.is_empty())
        .map(PathBuf::from)
}

// --- Progress parsing -----------------------------------------------------

fn progress_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"^\[download\]\s+(?P<pct>[0-9]+(?:\.[0-9]+)?)%\s+of\s+(?P<size>\S+)(?:\s+at\s+(?P<speed>\S+))?(?:\s+ETA\s+(?P<eta>\S+))?",
        )
        .expect("progress regex must compile")
    })
}

fn destination_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"^\[download\]\s+Destination:\s*(?P<path>.+?)\s*$")
            .expect("destination regex must compile")
    })
}

fn already_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"^\[download\]\s+(?P<path>.+?)\s+has already been downloaded")
            .expect("already-downloaded regex must compile")
    })
}

fn merger_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"^\[(?:Merger|ExtractAudio)\]\s*(?P<rest>.*)\s*$")
            .expect("merger regex must compile")
    })
}

fn file_name_from_path(path: &str) -> String {
    path.replace(['/', '\\'], "\n")
        .lines()
        .last()
        .unwrap_or(path)
        .trim()
        .to_string()
}

/// Interpret one stdout line from yt-dlp. Updates `current_filename` when a
/// destination becomes known. Returns a progress payload when the line
/// carries user-visible status, or `None` for noise.
pub fn parse_progress_line(
    line: &str,
    current_filename: &mut Option<String>,
) -> Option<DownloadProgress> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }

    if let Some(caps) = destination_regex().captures(trimmed) {
        let name = file_name_from_path(&caps["path"]);
        *current_filename = Some(name.clone());
        return Some(DownloadProgress {
            status: "Downloading".to_string(),
            percentage: None,
            speed: None,
            eta: None,
            filename: Some(name),
        });
    }

    if let Some(caps) = already_regex().captures(trimmed) {
        let name = file_name_from_path(&caps["path"]);
        *current_filename = Some(name.clone());
        return Some(DownloadProgress {
            status: "Already downloaded".to_string(),
            percentage: Some(100.0),
            speed: None,
            eta: None,
            filename: Some(name),
        });
    }

    if let Some(caps) = progress_regex().captures(trimmed) {
        let percentage: Option<f32> = caps["pct"].parse().ok();
        let speed = caps.name("speed").map(|m| m.as_str().to_string());
        let eta = caps.name("eta").map(|m| m.as_str().to_string());
        return Some(DownloadProgress {
            status: "Downloading".to_string(),
            percentage,
            speed,
            eta,
            filename: current_filename.clone(),
        });
    }

    if let Some(caps) = merger_regex().captures(trimmed) {
        let rest = caps["rest"].trim();
        let status = if rest.is_empty() {
            "Processing".to_string()
        } else {
            format!("Processing: {}", rest)
        };
        return Some(DownloadProgress {
            status,
            percentage: None,
            speed: None,
            eta: None,
            filename: current_filename.clone(),
        });
    }

    // Surface other [info]-level lines that look meaningful, ignore noise.
    if trimmed.starts_with("[download]")
        || trimmed.starts_with("[info]")
        || trimmed.starts_with("[youtube]")
    {
        return Some(DownloadProgress {
            status: trimmed.to_string(),
            percentage: None,
            speed: None,
            eta: None,
            filename: current_filename.clone(),
        });
    }

    None
}

fn file_name_of(path: &std::path::Path) -> Option<String> {
    path.file_name()
        .map(|name| name.to_string_lossy().to_string())
}

/// Decide what the success UI reports: the real post-merge file when yt-dlp
/// printed it, otherwise the last `[download] Destination:` filename, if any.
/// The extension is never guessed or derived from stream filenames.
///
/// Crucially, the reported file must actually exist: yt-dlp can exit 0 while
/// leaving streams unmerged (no FFmpeg), in which case claiming success
/// would fake a file. A missing file becomes an honest, actionable error.
fn resolve_verified_result(
    final_path: Option<PathBuf>,
    destination_filename: Option<String>,
    output_dir: &std::path::Path,
) -> Result<(Option<String>, Option<String>), String> {
    if let Some(path) = final_path {
        if path.is_file() {
            let name = file_name_of(&path);
            let full = path.to_string_lossy().to_string();
            return Ok((name, Some(full)));
        }
        return Err(missing_file_message());
    }
    match destination_filename {
        Some(name) => {
            let path = output_dir.join(&name);
            if path.is_file() {
                let full = path.to_string_lossy().to_string();
                Ok((Some(name), Some(full)))
            } else {
                Err(missing_file_message())
            }
        }
        None => Ok((None, None)),
    }
}

fn missing_file_message() -> String {
    "Download finished but the merged file is missing. FFmpeg is required \
     to merge the separate streams — install FFmpeg or choose a format \
     that does not require merging."
        .to_string()
}

fn emit_progress(app: &AppHandle, progress: &DownloadProgress) {
    let _ = app.emit(PROGRESS_EVENT, progress);
}

fn emit_complete(app: &AppHandle, result: &DownloadResult) {
    let _ = app.emit(COMPLETE_EVENT, result);
}

fn emit_error(app: &AppHandle, error: &DownloadError) {
    let _ = app.emit(ERROR_EVENT, error);
}

/// Run one download to completion, streaming progress events.
/// Intended to be spawned as a background task by the command layer.
pub async fn run_download(app: AppHandle, options: DownloadOptions) {
    let binary = match resolve_ytdlp_path(&app) {
        Ok(path) => path,
        Err(message) => {
            emit_error(
                &app,
                &DownloadError {
                    message: message.clone(),
                    details: Some(message),
                },
            );
            return;
        }
    };

    let output_dir = options.output_directory.clone();
    let final_path_file = final_path_sidecar();
    let args = build_download_args(&options, &final_path_file);

    let mut child = match tokio::process::Command::new(&binary)
        .args(&args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
    {
        Ok(child) => child,
        Err(err) => {
            let _ = std::fs::remove_file(&final_path_file);
            let message = format!("Could not launch yt-dlp: {}", err);
            emit_error(
                &app,
                &DownloadError {
                    message: message.clone(),
                    details: Some(message),
                },
            );
            return;
        }
    };

    // The pipes were requested above; a missing handle means the spawn is
    // unusable, so fail loudly instead of panicking.
    let (stdout, stderr) = match (child.stdout.take(), child.stderr.take()) {
        (Some(stdout), Some(stderr)) => (stdout, stderr),
        _ => {
            let _ = child.kill().await;
            let _ = std::fs::remove_file(&final_path_file);
            let message = "Could not capture the yt-dlp process output.".to_string();
            emit_error(
                &app,
                &DownloadError {
                    message: message.clone(),
                    details: Some(message),
                },
            );
            return;
        }
    };

    // Honest initial status: extraction produces no parseable lines yet, so
    // say so instead of leaving the UI empty until progress arrives.
    emit_progress(
        &app,
        &DownloadProgress {
            status: "Starting download…".to_string(),
            percentage: None,
            speed: None,
            eta: None,
            filename: None,
        },
    );

    // Read stdout line-by-line for live progress.
    let app_for_stdout = app.clone();
    let stdout_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        let mut current_filename: Option<String> = None;
        let mut destination_filename: Option<String> = None;
        while let Ok(Some(line)) = reader.next_line().await {
            if let Some(progress) = parse_progress_line(&line, &mut current_filename) {
                if progress.filename.is_some() {
                    destination_filename = progress.filename.clone();
                }
                emit_progress(&app_for_stdout, &progress);
            }
        }
        destination_filename
    });

    // Collect stderr in the background (bounded tail for error display).
    let stderr_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        let mut tail: Vec<String> = Vec::new();
        while let Ok(Some(line)) = reader.next_line().await {
            tail.push(line);
            if tail.len() > 40 {
                tail.remove(0);
            }
        }
        tail.join("\n")
    });

    let status = child.wait().await;
    // A panicked reader task must not crash the download flow: fall back to
    // whatever was captured (or nothing) and report the exit status honestly.
    let destination_filename = stdout_task.await.unwrap_or_default();
    let stderr_text = stderr_task.await.unwrap_or_default();
    // The sidecar carries the real final path (exact bytes, unlike stdout
    // text); it is consumed and deleted here on every outcome.
    let final_path = read_final_path_file(&final_path_file);

    match status {
        Ok(exit) if exit.success() => {
            match resolve_verified_result(final_path, destination_filename, &output_dir) {
                Ok((filename, filepath)) => emit_complete(
                    &app,
                    &DownloadResult {
                        filename,
                        filepath,
                        output_dir: output_dir.to_string_lossy().to_string(),
                    },
                ),
                Err(message) => {
                    let details = if stderr_text.trim().is_empty() {
                        message.clone()
                    } else {
                        tail_text(&stderr_text, 2000)
                    };
                    emit_error(
                        &app,
                        &DownloadError {
                            message,
                            details: Some(details),
                        },
                    );
                }
            }
        }
        Ok(exit) => {
            let details = if stderr_text.trim().is_empty() {
                format!("yt-dlp exited with status {}", exit)
            } else {
                tail_text(&stderr_text, 2000)
            };
            emit_error(
                &app,
                &DownloadError {
                    message: first_meaningful_line(&stderr_text)
                        .unwrap_or_else(|| format!("yt-dlp exited with status {}", exit)),
                    details: Some(details),
                },
            );
        }
        Err(err) => {
            let message = format!("Download process failed: {}", err);
            emit_error(
                &app,
                &DownloadError {
                    message: message.clone(),
                    details: Some(if stderr_text.trim().is_empty() {
                        message
                    } else {
                        tail_text(&stderr_text, 2000)
                    }),
                },
            );
        }
    }
}

/// Return approximately the last `max_chars` characters of `text`.
///
/// Operates on Unicode scalar values, never on byte offsets, so titles or
/// errors containing emoji/CJK/accents can never cause a panic at a
/// non-character boundary.
fn tail_text(text: &str, max_chars: usize) -> String {
    let trimmed = text.trim();
    let len = trimmed.chars().count();
    if len <= max_chars {
        trimmed.to_string()
    } else {
        trimmed.chars().skip(len - max_chars).collect()
    }
}

/// Pick the user-facing message from yt-dlp stderr: the last `ERROR:` line
/// wins (earlier warnings must not hide a later real error); otherwise the
/// first other meaningful line; `None` when there is nothing to show.
fn first_meaningful_line(text: &str) -> Option<String> {
    let mut fallback: Option<String> = None;
    let mut last_error: Option<String> = None;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with("WARNING:") {
            continue;
        }
        // Strip the common "ERROR: " prefix for cleaner display.
        if let Some(rest) = trimmed.strip_prefix("ERROR:") {
            last_error = Some(rest.trim().to_string());
        } else if fallback.is_none() {
            fallback = Some(trimmed.to_string());
        }
    }
    last_error.or(fallback)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_percentage_line() {
        let mut filename = Some("video.mp4".to_string());
        let parsed = parse_progress_line(
            "[download]  37.4% of 105.20MiB at 8.40MiB/s ETA 00:08",
            &mut filename,
        )
        .expect("should parse");
        assert!((parsed.percentage.unwrap() - 37.4).abs() < 0.01);
        assert_eq!(parsed.speed.as_deref(), Some("8.40MiB/s"));
        assert_eq!(parsed.eta.as_deref(), Some("00:08"));
        assert_eq!(parsed.status, "Downloading");
    }

    #[test]
    fn parses_fragmented_stream_line() {
        // Fragmented (HLS/DASH) downloads report approximate `~` sizes and
        // often lack speed/ETA: percentage must still parse, the rest stays
        // empty rather than failing.
        let mut filename = None;
        let parsed = parse_progress_line(
            "[download]   1.3% of ~  52.84KiB at      0.00B/s ETA Unknown (frag 1/38)",
            &mut filename,
        )
        .expect("should parse");
        assert!((parsed.percentage.unwrap() - 1.3).abs() < 0.01);
        assert_eq!(parsed.speed, None);
        assert_eq!(parsed.eta, None);
        assert_eq!(parsed.status, "Downloading");
    }

    #[test]
    fn parses_destination_line() {
        let mut filename = None;
        let parsed = parse_progress_line(
            r"[download] Destination: C:\Users\Alex\Downloads\My Video [abc123].mp4",
            &mut filename,
        )
        .expect("should parse");
        assert_eq!(parsed.filename.as_deref(), Some("My Video [abc123].mp4"));
        assert_eq!(filename.as_deref(), Some("My Video [abc123].mp4"));
    }

    #[test]
    fn builds_video_best_args() {
        let options = DownloadOptions::new(
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ".to_string(),
            PathBuf::from("C:\\Users\\Alex\\Downloads"),
            MediaType::Video,
            Some(VideoQuality::Best),
        );
        let sidecar = PathBuf::from("C:\\Temp\\ytdlp-gui-final-1.txt");
        let args = build_download_args(&options, &sidecar);
        assert!(args.contains(&"--newline".to_string()));
        assert!(args.contains(&"--no-playlist".to_string()));
        assert!(args.contains(&"--progress".to_string()));
        // The final path travels via a sidecar FILE (stdout text mangles
        // non-ANSI characters): template and file are separate argv elements.
        assert!(args.contains(&"--print-to-file".to_string()));
        let print_index = args
            .iter()
            .position(|a| a == "--print-to-file")
            .expect("print-to-file present");
        assert_eq!(args[print_index + 1], "after_move:%(filepath)s");
        assert_eq!(args[print_index + 2], sidecar.to_string_lossy());
        // Best video: highest-quality video+audio result.
        let format = format_value(&args);
        assert_eq!(format, "bv*+ba/b");
        // URL remains exactly one trailing argument (no shell join).
        let url_args = args
            .iter()
            .filter(|a| a.as_str() == "https://www.youtube.com/watch?v=dQw4w9WgXcQ")
            .count();
        assert_eq!(url_args, 1, "URL must appear exactly once");
        assert_eq!(
            args.last().unwrap(),
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        );
        // Output template keeps the human-friendly title-based naming.
        let template = args
            .iter()
            .skip_while(|a| a.as_str() != "-o")
            .nth(1)
            .expect("-o must carry a template");
        assert!(template.contains("%(title)s"));
        assert!(template.contains("%(id)s"));
        assert!(template.contains("%(ext)s"));
    }

    /// Fetch the `-f` value from a built argument list.
    fn format_value(args: &[String]) -> &str {
        args.iter()
            .skip_while(|a| a.as_str() != "-f")
            .nth(1)
            .expect("-f must carry a format expression")
    }

    #[test]
    fn builds_video_quality_args() {
        for (quality, height) in [
            (VideoQuality::P2160, 2160),
            (VideoQuality::P1440, 1440),
            (VideoQuality::P1080, 1080),
            (VideoQuality::P720, 720),
            (VideoQuality::P480, 480),
            (VideoQuality::P360, 360),
        ] {
            let options = DownloadOptions::new(
                "https://example.com/v".to_string(),
                PathBuf::from("C:\\dl"),
                MediaType::Video,
                Some(quality),
            );
            let args = build_download_args(&options, Path::new("sidecar.txt"));
            let format = format_value(&args);
            // Constrained best video + best audio, with a progressive
            // fallback when separate streams are unavailable.
            assert!(
                format.contains(&format!("height<={height}")),
                "quality {:?} must constrain height, got: {}",
                quality,
                format
            );
            assert!(
                format.contains("+ba"),
                "quality {:?} must include best audio, got: {}",
                quality,
                format
            );
            assert!(
                format.contains('/'),
                "quality {:?} must keep a fallback, got: {}",
                quality,
                format
            );
        }
    }

    #[test]
    fn builds_audio_args_without_conversion() {
        let options = DownloadOptions::new(
            "https://example.com/v".to_string(),
            PathBuf::from("C:\\dl"),
            MediaType::Audio,
            None,
        );
        let args = build_download_args(&options, Path::new("sidecar.txt"));
        let format = format_value(&args);
        // Best audio-ONLY stream: exactly `ba`, never a `/b` fallback to a
        // combined video+audio format, and never a conversion flag.
        assert_eq!(format, "ba");
        assert!(
            !format.contains('/'),
            "audio selector must not fall back to video, got: {}",
            format
        );
        assert!(
            !args.iter().any(|a| a == "-x"
                || a == "--extract-audio"
                || a == "--audio-format"
                || a == "mp3"),
            "audio mode must not convert, got: {:?}",
            args
        );
        assert!(
            !args.iter().any(|a| a.contains("height")),
            "audio mode takes no quality constraint, got: {:?}",
            args
        );
    }

    #[test]
    fn format_selector_covers_all_modes() {
        assert_eq!(
            format_selector(MediaType::Video, Some(VideoQuality::Best)),
            "bv*+ba/b"
        );
        assert_eq!(
            format_selector(MediaType::Video, None),
            "bv*+ba/b",
            "missing quality defaults to best"
        );
        assert_eq!(
            format_selector(MediaType::Video, Some(VideoQuality::P1080)),
            "bv*[height<=1080]+ba/b[height<=1080]"
        );
        assert_eq!(
            format_selector(MediaType::Video, Some(VideoQuality::P720)),
            "bv*[height<=720]+ba/b[height<=720]"
        );
        assert_eq!(format_selector(MediaType::Audio, None), "ba");
        // Even a stray quality with audio resolves to plain best audio.
        assert_eq!(
            format_selector(MediaType::Audio, Some(VideoQuality::P1080)),
            "ba"
        );
    }

    #[test]
    fn hostile_strings_cannot_become_format_args() {
        // Unknown media types and qualities fail deserialization outright.
        assert!(serde_json::from_str::<MediaType>("\"video \"").is_err());
        assert!(serde_json::from_str::<MediaType>("\"hacker\"").is_err());
        assert!(serde_json::from_str::<VideoQuality>("\"137\"").is_err());
        assert!(serde_json::from_str::<VideoQuality>("\"1080;evil\"").is_err());
        assert!(serde_json::from_str::<VideoQuality>("\"bestvideo+bestaudio\"").is_err());
        // A full hostile request is rejected before any argument is built.
        let hostile =
            r#"{"url":"https://example.com/v","mediaType":"video","quality":"bv*+ba; rm -rf ~"}"#;
        assert!(serde_json::from_str::<StartDownloadRequest>(hostile).is_err());
        // Valid spellings still parse.
        let ok: StartDownloadRequest = serde_json::from_str(
            r#"{"url":"https://example.com/v","mediaType":"audio","quality":null}"#,
        )
        .expect("valid request must parse");
        assert_eq!(ok.media_type, MediaType::Audio);
        assert_eq!(ok.quality, None);
    }

    #[test]
    fn validate_request_rejects_audio_with_quality() {
        let request = StartDownloadRequest {
            url: "https://example.com/v".to_string(),
            media_type: MediaType::Audio,
            quality: Some(VideoQuality::P1080),
            output_directory: Some(std::env::temp_dir().to_string_lossy().to_string()),
        };
        let err = validate_request(&request).expect_err("audio + quality must be rejected");
        assert!(err.contains("quality"), "unexpected message: {}", err);
    }

    #[test]
    fn validate_request_accepts_valid_combinations() {
        let tmp = std::env::temp_dir().to_string_lossy().to_string();
        let video = StartDownloadRequest {
            url: "  https://example.com/v  ".to_string(),
            media_type: MediaType::Video,
            quality: Some(VideoQuality::P720),
            output_directory: Some(tmp.clone()),
        };
        let options = validate_request(&video).expect("video + quality must validate");
        assert_eq!(options.url, "https://example.com/v");
        assert_eq!(options.media_type, MediaType::Video);
        assert_eq!(options.quality, Some(VideoQuality::P720));
        assert_eq!(options.output_directory, std::env::temp_dir());

        // Omitted video quality defaults to Best.
        let defaulted = StartDownloadRequest {
            url: "https://example.com/v".to_string(),
            media_type: MediaType::Video,
            quality: None,
            output_directory: Some(tmp.clone()),
        };
        let options = validate_request(&defaulted).expect("video without quality must default");
        assert_eq!(options.quality, Some(VideoQuality::Best));

        let audio = StartDownloadRequest {
            url: "https://example.com/v".to_string(),
            media_type: MediaType::Audio,
            quality: None,
            output_directory: Some(tmp),
        };
        let options = validate_request(&audio).expect("audio must validate");
        assert_eq!(options.media_type, MediaType::Audio);
        assert_eq!(options.quality, None);
    }

    #[test]
    fn validate_output_directory_rules() {
        // Empty and relative paths are rejected.
        assert!(validate_output_directory("").is_err());
        assert!(validate_output_directory("   ").is_err());
        assert!(validate_output_directory("relative/folder").is_err());
        // Missing folders are rejected with a folder-specific message.
        let missing = std::env::temp_dir().join("ytdlp_gui_no_such_dir_xyz");
        assert!(!missing.exists());
        let err = validate_output_directory(&missing.to_string_lossy())
            .expect_err("missing dir must be rejected");
        assert!(
            err.contains("no longer exists"),
            "unexpected message: {}",
            err
        );
        // A file is not a directory.
        let file = std::env::temp_dir().join("ytdlp_gui_not_a_dir.txt");
        std::fs::write(&file, b"x").expect("test file");
        let err =
            validate_output_directory(&file.to_string_lossy()).expect_err("file must be rejected");
        assert!(err.contains("not a folder"), "unexpected message: {}", err);
        std::fs::remove_file(&file).ok();
        // Existing directories pass through unchanged.
        let dir = std::env::temp_dir();
        assert_eq!(
            validate_output_directory(&dir.to_string_lossy()).expect("temp dir valid"),
            dir
        );
    }

    #[test]
    fn output_template_uses_custom_directory() {
        // Spaces, parentheses, and Unicode stay intact inside the single
        // template argument.
        let base = std::env::temp_dir().join("My Videos (2026) 日本語 🎬");
        std::fs::create_dir_all(&base).expect("test dir");
        let options = DownloadOptions::new(
            "https://example.com/v".to_string(),
            base.clone(),
            MediaType::Video,
            Some(VideoQuality::P1080),
        );
        let args = build_download_args(&options, Path::new("sidecar.txt"));
        let template = args
            .iter()
            .skip_while(|a| a.as_str() != "-o")
            .nth(1)
            .expect("-o must carry a template");
        let expected_prefix = base.to_string_lossy().to_string();
        assert!(
            template.starts_with(&expected_prefix),
            "template must live under the custom dir, got: {}",
            template
        );
        assert!(template.ends_with("%(title)s [%(id)s].%(ext)s"));
        // Template and URL each remain exactly one argv element.
        assert_eq!(args.iter().filter(|a| a.as_str() == "-o").count(), 1);
        assert_eq!(args.last().unwrap(), "https://example.com/v");
        std::fs::remove_dir(&base).ok();
    }

    #[test]
    fn reads_final_path_sidecar_file() {
        // The sidecar carries the exact path (CRLF tolerant); last
        // non-empty line wins, and the file is consumed.
        let sidecar = std::env::temp_dir().join("ytdlp_gui_test_sidecar.txt");
        std::fs::write(
            &sidecar,
            "C:\\Vids\\first.mp4\r\nC:\\Vids\\My Video [abc123].mp4\r\n\r\n",
        )
        .expect("test file");
        let path = read_final_path_file(&sidecar).expect("sidecar must parse");
        assert_eq!(path.to_string_lossy(), "C:\\Vids\\My Video [abc123].mp4");
        assert!(!sidecar.exists(), "sidecar must be consumed");
        // Missing or empty files yield None instead of panicking.
        assert_eq!(
            read_final_path_file(&std::env::temp_dir().join("ytdlp_gui_no_sidecar_xyz.txt")),
            None
        );
        let empty = std::env::temp_dir().join("ytdlp_gui_test_sidecar_empty.txt");
        std::fs::write(&empty, "  \r\n").expect("test file");
        assert_eq!(read_final_path_file(&empty), None);
    }

    #[test]
    fn merged_download_reports_final_file_not_streams() {
        // Simulate: separate streams download, then the merge prints the
        // real final path. The UI must show actual-final-video.mp4.
        let mut current: Option<String> = None;
        for line in [
            "[download] Destination: video [abc123].f313.webm",
            "[download] 100% of 10.00MiB at 5.00MiB/s ETA 00:00",
            "[download] Destination: video [abc123].f140.m4a",
            "[Merger] Merging formats into \"video [abc123].mp4\"",
        ] {
            let _ = parse_progress_line(line, &mut current);
        }
        assert_eq!(current.as_deref(), Some("video [abc123].f140.m4a"));

        let dir = std::env::temp_dir();
        let final_path = dir.join("ytdlp_gui_test_final.mp4");
        std::fs::write(&final_path, b"fake video").expect("test file");
        let (filename, filepath) = resolve_verified_result(Some(final_path.clone()), current, &dir)
            .expect("existing final file must verify");
        assert_eq!(filename.as_deref(), Some("ytdlp_gui_test_final.mp4"));
        assert_eq!(
            filepath.as_deref(),
            Some(final_path.to_string_lossy().as_ref())
        );
        std::fs::remove_file(&final_path).ok();
    }

    #[test]
    fn phantom_merged_file_becomes_ffmpeg_error() {
        // yt-dlp exits 0 but the reported final file was never created
        // (streams left unmerged without FFmpeg): success must NOT be faked.
        let dir = std::env::temp_dir();
        let phantom = dir.join("ytdlp_gui_test_phantom_xyz.mp4");
        assert!(!phantom.exists());
        let err = resolve_verified_result(Some(phantom), None, &dir)
            .expect_err("missing final file must error");
        assert!(
            err.contains("FFmpeg"),
            "error must guide toward FFmpeg, got: {}",
            err
        );
        // The message already reads user-friendly and maps to the frontend
        // FFmpeg guidance (contains "FFmpeg" + "required").
        assert!(err.contains("required"));
    }

    #[test]
    fn missing_final_path_falls_back_to_destination() {
        let dir = std::env::temp_dir();
        let dest = dir.join("ytdlp_gui_test_dest.mp4");
        std::fs::write(&dest, b"fake video").expect("test file");
        let (filename, filepath) =
            resolve_verified_result(None, Some("ytdlp_gui_test_dest.mp4".to_string()), &dir)
                .expect("existing destination must verify");
        assert_eq!(filename.as_deref(), Some("ytdlp_gui_test_dest.mp4"));
        assert_eq!(filepath.as_deref(), Some(dest.to_string_lossy().as_ref()));
        std::fs::remove_file(&dest).ok();

        let (filename, filepath) =
            resolve_verified_result(None, None, &dir).expect("no info must stay empty success");
        assert_eq!(filename, None);
        assert_eq!(filepath, None);
    }

    #[test]
    fn truncation_is_unicode_safe() {
        // Emoji, CJK, and accents: slicing must never panic and must keep
        // whole characters.
        let text = "ERROR: 下载失败 😭 日本語テスト café";
        let tail = tail_text(text, 10);
        assert_eq!(tail.chars().count(), 10);
        assert!(text.ends_with(&tail));

        // Multi-byte boundary stress: truncating a pure-emoji string lands
        // inside what would be byte offsets, not char boundaries.
        let emojis = "😀😃😄😁😆😅🤣😂🙂🙃";
        let tail = tail_text(emojis, 4);
        assert_eq!(tail, "🤣😂🙂🙃");

        // Short text is returned whole (trimmed).
        assert_eq!(tail_text("  café ☕  ", 100), "café ☕");
        assert_eq!(tail_text("", 10), "");
    }

    #[test]
    fn prefers_last_error_over_warnings() {
        let stderr = "WARNING: [youtube] No supported JavaScript runtime could be found.\n\
             [youtube] abc123: Downloading webpage\n\
             ERROR: [youtube] abc123: Private video. Sign in.\n";
        assert_eq!(
            first_meaningful_line(stderr).as_deref(),
            Some("[youtube] abc123: Private video. Sign in.")
        );

        // A later real error beats an earlier one.
        let stderr = "ERROR: [generic] first problem\nERROR: [generic] final problem\n";
        assert_eq!(
            first_meaningful_line(stderr).as_deref(),
            Some("[generic] final problem")
        );

        // No ERROR line: first meaningful line, warnings skipped.
        let stderr = "WARNING: something\n[youtube] Extracting URL: https://example.com\n";
        assert_eq!(
            first_meaningful_line(stderr).as_deref(),
            Some("[youtube] Extracting URL: https://example.com")
        );

        assert_eq!(first_meaningful_line("  \nWARNING: x\n  "), None);
    }
}
