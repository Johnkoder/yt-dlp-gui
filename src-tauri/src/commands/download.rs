//! Tauri commands: the only bridge between the React UI and yt-dlp.
//!
//! The frontend invokes these commands and listens for progress events.
//! Argument construction and process management live in
//! `crate::services::ytdlp`; this module only validates input, guards
//! concurrent MVP downloads, and spawns the background task.

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::{AppHandle, State};

use crate::services::ytdlp;

/// MVP guard: one active download at a time. Structured as managed state
/// so it can later become a queue / multi-download tracker without
/// changing the command signatures' shape.
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

/// Start a download in the background. Returns immediately; progress,
/// completion, and failure are delivered via Tauri events so the UI
/// never blocks.
#[tauri::command]
pub async fn start_download(
    app: AppHandle,
    state: State<'_, DownloadState>,
    url: String,
) -> Result<(), String> {
    let trimmed = url.trim().to_string();
    if trimmed.is_empty() {
        return Err("Please paste a video URL first.".to_string());
    }
    if !is_valid_http_url(&trimmed) {
        return Err("That does not look like a valid http(s) URL.".to_string());
    }
    // Fail fast if the binary is missing so the user gets an immediate,
    // understandable error instead of a silent background failure.
    ytdlp::resolve_ytdlp_path(&app)?;
    ytdlp::resolve_downloads_dir()?;

    let active = state.active.clone();
    if active
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("A download is already running.".to_string());
    }

    tokio::spawn(async move {
        ytdlp::run_download(app.clone(), trimmed).await;
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
