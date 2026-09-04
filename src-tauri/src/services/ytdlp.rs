//! Centralized yt-dlp process logic.
//!
//! All knowledge about where the yt-dlp binary lives, which arguments to
//! pass, and how to interpret its stdout lives here. Tauri commands and the
//! frontend must not duplicate any of this.

use regex::Regex;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};

pub const PROGRESS_EVENT: &str = "download-progress";
pub const COMPLETE_EVENT: &str = "download-complete";
pub const ERROR_EVENT: &str = "download-error";

const BINARY_FILE_NAME: &str = "yt-dlp.exe";

/// Future-proof download options. The MVP only fills in `url` and
/// `output_directory`; later features (quality, format, audio-only,
/// subtitles, playlists, …) extend this struct instead of changing
/// call sites.
#[derive(Debug, Clone)]
#[allow(
    dead_code,
    reason = "quality/format/subtitles/playlist are roadmap fields, MVP fills url + output_directory"
)]
pub struct DownloadOptions {
    pub url: String,
    pub output_directory: PathBuf,
    pub quality: Option<String>,
    pub format: Option<String>,
    pub audio_only: bool,
    pub subtitles: bool,
    pub playlist: bool,
}

impl DownloadOptions {
    pub fn mvp(url: String, output_directory: PathBuf) -> Self {
        Self {
            url,
            output_directory,
            quality: None,
            format: None,
            audio_only: false,
            subtitles: false,
            playlist: false,
        }
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
    pub filename: Option<String>,
    pub downloads_dir: String,
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

/// Build the yt-dlp argument list in one place.
///
/// The binary is executed directly with individual arguments (never via
/// `cmd.exe /c` with a concatenated string), so the URL is passed as a
/// single argv element — no quoting or injection concerns.
pub fn build_download_args(options: &DownloadOptions) -> Vec<String> {
    let template = options
        .output_directory
        .join("%(title)s [%(id)s].%(ext)s")
        .to_string_lossy()
        .to_string();

    let mut args = vec![
        "--newline".to_string(),
        "--no-playlist".to_string(),
        "-o".to_string(),
        template,
    ];

    if options.audio_only {
        args.push("-x".to_string());
    }
    if let Some(format) = &options.format {
        args.push("-f".to_string());
        args.push(format.clone());
    }
    if options.subtitles {
        args.push("--write-subs".to_string());
    }

    args.push(options.url.clone());
    args
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
pub async fn run_download(app: AppHandle, url: String) {
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

    let downloads_dir = match resolve_downloads_dir() {
        Ok(dir) => dir,
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

    let options = DownloadOptions::mvp(url, downloads_dir.clone());
    let args = build_download_args(&options);

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

    let stdout = child.stdout.take().expect("stdout was piped");
    let stderr = child.stderr.take().expect("stderr was piped");

    // Read stdout line-by-line for live progress.
    let app_for_stdout = app.clone();
    let stdout_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        let mut current_filename: Option<String> = None;
        let mut last_filename: Option<String> = None;
        while let Ok(Some(line)) = reader.next_line().await {
            if let Some(progress) = parse_progress_line(&line, &mut current_filename) {
                if progress.filename.is_some() {
                    last_filename = progress.filename.clone();
                }
                emit_progress(&app_for_stdout, &progress);
            }
        }
        last_filename
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
    let stdout_filename = stdout_task.await.unwrap_or_default();
    let stderr_text = stderr_task.await.unwrap_or_default();

    match status {
        Ok(exit) if exit.success() => {
            emit_complete(
                &app,
                &DownloadResult {
                    filename: stdout_filename,
                    downloads_dir: downloads_dir.to_string_lossy().to_string(),
                },
            );
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

fn tail_text(text: &str, max_chars: usize) -> String {
    let trimmed = text.trim();
    if trimmed.len() <= max_chars {
        return trimmed.to_string();
    }
    trimmed[trimmed.len() - max_chars..].to_string()
}

fn first_meaningful_line(text: &str) -> Option<String> {
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        // Skip generic warning prefixes when a better line exists.
        if trimmed.starts_with("WARNING:") {
            continue;
        }
        // Strip the common "ERROR: " prefix for cleaner display.
        if let Some(rest) = trimmed.strip_prefix("ERROR: ") {
            return Some(rest.trim().to_string());
        }
        return Some(trimmed.to_string());
    }
    None
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
    fn builds_mvp_args_without_shell_string() {
        let options = DownloadOptions::mvp(
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ".to_string(),
            PathBuf::from("C:\\Users\\Alex\\Downloads"),
        );
        let args = build_download_args(&options);
        assert!(args.contains(&"--newline".to_string()));
        assert!(args.contains(&"--no-playlist".to_string()));
        assert_eq!(
            args.last().unwrap(),
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        );
    }
}
