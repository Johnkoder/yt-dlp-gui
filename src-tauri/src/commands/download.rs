//! Tauri commands: the only bridge between the React UI and yt-dlp.
//!
//! The frontend invokes these commands and listens for progress events.
//! Argument construction and process management live in
//! `crate::services::ytdlp`; this module only validates input, guards
//! concurrent downloads, and spawns the background task.

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::{AppHandle, State};

use crate::services::ytdlp::{self, StartDownloadRequest};

/// Single-download guard. Structured as managed state so it can later
/// become a queue / multi-download tracker without changing the command
/// signatures' shape.
pub struct DownloadState {
    pub active: Arc<AtomicBool>,
}

impl Default for DownloadState {
    fn default() -> Self {
        Self {
            active: Arc::new(AtomicBool::new(false)),
        }
    }
}

fn is_valid_http_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    (lower.starts_with("http://") || lower.starts_with("https://")) && url.len() <= 2048
}

/// Start a download in the background. Takes a structured request (never a
/// bag of flags); values are re-validated in Rust and never trusted blindly.
/// Returns immediately; progress, completion, and failure are delivered via
/// Tauri events so the UI never blocks.
#[tauri::command]
pub async fn start_download(
    app: AppHandle,
    state: State<'_, DownloadState>,
    request: StartDownloadRequest,
) -> Result<(), String> {
    if !is_valid_http_url(request.url.trim()) {
        return Err("That does not look like a valid http(s) URL.".to_string());
    }
    // Fail fast if the binary is missing so the user gets an immediate,
    // understandable error instead of a silent background failure.
    ytdlp::resolve_ytdlp_path(&app)?;

    // The output directory comes from the validated request — Downloads is
    // only the default/fallback, never the forced destination.
    let options = ytdlp::validate_request(&request)?;

    let active = state.active.clone();
    if active
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("A download is already running.".to_string());
    }

    tokio::spawn(async move {
        ytdlp::run_download(app.clone(), options).await;
        active.store(false, Ordering::SeqCst);
    });

    Ok(())
}

/// Absolute path of the user's Downloads folder (default output folder).
#[tauri::command]
pub fn get_downloads_dir() -> Result<String, String> {
    Ok(ytdlp::resolve_downloads_dir()?
        .to_string_lossy()
        .to_string())
}

/// Validate a candidate output directory. Used at startup to check a
/// persisted folder and shared with the download path validation.
#[tauri::command]
pub fn validate_output_directory(path: String) -> Result<String, String> {
    Ok(ytdlp::validate_output_directory(&path)?
        .to_string_lossy()
        .to_string())
}

/// Open an output folder with the OS file manager. The path is validated
/// and passed as a single argument — never through a shell. This command
/// cannot execute anything: it only opens folders in Explorer.
#[tauri::command]
pub fn open_output_folder(path: String) -> Result<(), String> {
    let dir = ytdlp::validate_output_directory(&path)
        .map_err(|_| "The folder to open is no longer available.".to_string())?;

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("Could not open folder: {}", e))?;
        Ok(())
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("Could not open folder: {}", e))?;
        return Ok(());
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("Could not open folder: {}", e))?;
        return Ok(());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_http_urls() {
        assert!(is_valid_http_url(
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        ));
        assert!(is_valid_http_url("http://example.com/video.mp4"));
        assert!(is_valid_http_url("HTTPS://EXAMPLE.COM/UPPER"));
    }

    #[test]
    fn rejects_non_urls() {
        assert!(!is_valid_http_url(""));
        assert!(!is_valid_http_url("   "));
        assert!(!is_valid_http_url("not a url"));
        assert!(!is_valid_http_url("ftp://example.com/file.mp4"));
        assert!(!is_valid_http_url("javascript:alert(1)"));
        assert!(!is_valid_http_url("yt-dlp https://example.com"));
    }

    #[test]
    fn rejects_absurd_lengths() {
        let long = format!("https://example.com/{}", "a".repeat(3000));
        assert!(!is_valid_http_url(&long));
    }
}
