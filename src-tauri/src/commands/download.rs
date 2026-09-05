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
    let downloads_dir = ytdlp::resolve_downloads_dir()?;

    let options = ytdlp::validate_request(&request, downloads_dir)?;

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

/// Absolute path of the user's Downloads folder (for display/testing).
#[tauri::command]
pub fn get_downloads_dir() -> Result<String, String> {
    Ok(ytdlp::resolve_downloads_dir()?
        .to_string_lossy()
        .to_string())
}

/// Open the Downloads folder with the OS file manager.
#[tauri::command]
pub fn open_downloads_folder() -> Result<(), String> {
    let dir = ytdlp::resolve_downloads_dir()?;

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("Could not open Downloads folder: {}", e))?;
        Ok(())
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("Could not open Downloads folder: {}", e))?;
        return Ok(());
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("Could not open Downloads folder: {}", e))?;
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
