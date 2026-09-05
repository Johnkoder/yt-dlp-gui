//! Tauri commands: the only bridge between the React UI and yt-dlp.
//!
//! The frontend invokes these commands and listens for progress events.
//! Argument construction and process management live in
//! `crate::services::ytdlp`; this module only validates input, guards
//! the single active download, and spawns the background task.

use std::sync::Arc;
use tauri::{AppHandle, State};
use tokio::sync::{watch, Mutex};

use crate::services::ytdlp::{self, StartDownloadRequest};

/// The one active download, if any. The ID generation makes cleanup stale-
/// safe: a finished old task can never clear a newer download's record.
struct ActiveDownload {
    id: u64,
    cancel_tx: watch::Sender<bool>,
}

#[derive(Default)]
struct DownloadControl {
    next_id: u64,
    active: Option<ActiveDownload>,
}

impl DownloadControl {
    /// Register a new download. Returns its ID and the cancellation
    /// receiver, or `None` when a download is already active. Registration
    /// (check + install) happens atomically under one lock hold, so a
    /// cancel arriving in any gap is never lost.
    fn try_begin(&mut self) -> Option<(u64, watch::Receiver<bool>)> {
        if self.active.is_some() {
            return None;
        }
        let id = self.next_id;
        self.next_id += 1;
        let (cancel_tx, cancel_rx) = watch::channel(false);
        self.active = Some(ActiveDownload { id, cancel_tx });
        Some((id, cancel_rx))
    }

    /// Request cancellation of the active download, if any. Idempotent:
    /// repeated calls just re-send an already-true flag. Returns whether a
    /// download record existed.
    fn cancel_active(&self) -> bool {
        match &self.active {
            Some(active) => {
                let _ = active.cancel_tx.send(true);
                true
            }
            None => false,
        }
    }

    /// Clear the active record, but only if it still belongs to `id`.
    /// A stale (already replaced) record is left untouched.
    fn finish(&mut self, id: u64) {
        if self.active.as_ref().is_some_and(|active| active.id == id) {
            self.active = None;
        }
    }

    /// Test-only visibility into the guard state.
    #[cfg(test)]
    fn is_active(&self) -> bool {
        self.active.is_some()
    }
}

/// Single-download guard with cancellation support. Structured as managed
/// state so a future queue can grow here without changing the command
/// signatures' shape. No globals, no unsafe.
pub struct DownloadState {
    inner: Arc<Mutex<DownloadControl>>,
}

impl Default for DownloadState {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(DownloadControl::default())),
        }
    }
}

fn is_valid_http_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    (lower.starts_with("http://") || lower.starts_with("https://")) && url.len() <= 2048
}

/// Start a download in the background. Takes a structured request (never a
/// bag of flags); values are re-validated in Rust and never trusted blindly.
/// Returns immediately; progress, completion, failure, and cancellation are
/// delivered via Tauri events so the UI never blocks.
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

    // Register atomically: check + install under one lock so an immediate
    // cancel can neither slip through nor hit a half-registered download.
    let (id, cancel_rx) = {
        let mut control = state.inner.lock().await;
        match control.try_begin() {
            Some(registered) => registered,
            None => return Err("A download is already running.".to_string()),
        }
    };

    let inner = state.inner.clone();
    tokio::spawn(async move {
        ytdlp::run_download(app.clone(), options, cancel_rx).await;
        inner.lock().await.finish(id);
    });

    Ok(())
}

/// Request cancellation of the active download, if any.
///
/// Returns `true` when a cancellation request was sent to an active
/// download, `false` when nothing was running. Idempotent and race-safe:
/// repeated calls never panic, and calling with no active download is a
/// harmless `false` — never a catastrophic error.
///
/// The frontend only says "cancel the active download": no PIDs, paths, or
/// process details ever cross IPC.
#[tauri::command]
pub async fn cancel_download(state: State<'_, DownloadState>) -> Result<bool, String> {
    Ok(state.inner.lock().await.cancel_active())
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

    #[test]
    fn control_registers_single_download() {
        // A: no active download → registration succeeds.
        let mut control = DownloadControl::default();
        let first = control.try_begin();
        assert!(first.is_some());
        assert!(control.is_active());
        // B: second registration is rejected while active.
        assert!(control.try_begin().is_none());
    }

    #[test]
    fn control_cancel_signals_active_download() {
        // C: cancel marks the receiver without needing async polling.
        let mut control = DownloadControl::default();
        let (_id, rx) = control.try_begin().expect("registered");
        assert!(!*rx.borrow());
        assert!(control.cancel_active());
        assert!(*rx.borrow());
        // D: repeat cancels are harmless and stay true.
        assert!(control.cancel_active());
        assert!(*rx.borrow());
    }

    #[test]
    fn control_cancel_without_download_is_harmless() {
        // E: nothing active → false, never a panic or error.
        let control = DownloadControl::default();
        assert!(!control.is_active());
        assert!(!control.cancel_active());
    }

    #[test]
    fn control_finish_honors_generation_id() {
        // F: a stale task must never clear a newer download's record.
        let mut control = DownloadControl::default();
        let (first_id, _rx) = control.try_begin().expect("first");
        control.finish(first_id + 999);
        assert!(control.is_active(), "wrong id must not clear");
        control.finish(first_id);
        assert!(!control.is_active(), "matching id clears");

        // A newer download after cleanup gets a fresh record the old
        // task cannot disturb.
        let (second_id, _) = control.try_begin().expect("second");
        assert_ne!(first_id, second_id);
        control.finish(first_id);
        assert!(control.is_active(), "stale finish must not clear");
    }

    #[tokio::test]
    async fn control_flow_across_tasks() {
        // Registration, async cancellation, and guarded finish cooperate.
        let state = DownloadState::default();
        let (id, mut rx) = {
            let mut control = state.inner.lock().await;
            control.try_begin().expect("registered")
        };
        assert!(state.inner.lock().await.cancel_active());
        assert!(*rx.borrow());
        // Receiver observes the signal without polling.
        rx.wait_for(|cancelled| *cancelled)
            .await
            .expect("signal arrives");
        {
            let mut control = state.inner.lock().await;
            control.finish(id + 1);
            assert!(control.is_active());
            control.finish(id);
            assert!(!control.is_active());
        }
        assert!(!state.inner.lock().await.cancel_active());
    }
}
