//! Persistent download history service.
//!
//! Owns history data models, atomic JSON file persistence in `app_data_dir/history.json`,
//! corrupt/unsupported file recovery, and terminal outcome recording.
//!
//! The download queue remains strictly session-only; this module persists only
//! terminal outcomes (`success`, `error`, `cancelled`).

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;

use super::ytdlp::{
    AudioFormat, DownloadTerminalOutcome, MediaType, StartDownloadRequest, VideoQuality,
};

/// Name of the Tauri event emitted when a new history entry is persisted.
pub const HISTORY_ENTRY_ADDED_EVENT: &str = "history-entry-added";

/// Schema version for `history.json`.
pub const CURRENT_HISTORY_VERSION: u32 = 1;

/// Strongly-typed terminal outcome status for history records.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HistoryStatus {
    Success,
    Error,
    Cancelled,
}

/// Persistent record of a single attempted download that reached a terminal outcome.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: u64,
    pub timestamp_ms: u64,
    pub url: String,
    pub media_type: MediaType,
    pub quality: Option<VideoQuality>,
    #[serde(default)]
    pub audio_format: Option<AudioFormat>,
    pub output_directory: String,
    pub status: HistoryStatus,
    pub filename: Option<String>,
    pub filepath: Option<String>,
    pub message: Option<String>,
}

/// Versioned root container for `history.json`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryStore {
    pub version: u32,
    pub next_id: u64,
    pub entries: Vec<HistoryEntry>,
}

impl Default for HistoryStore {
    fn default() -> Self {
        Self {
            version: CURRENT_HISTORY_VERSION,
            next_id: 1,
            entries: Vec::new(),
        }
    }
}

/// Current system time in Unix epoch milliseconds.
pub fn current_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Resolve the `history.json` path in the Tauri app-data directory.
pub fn resolve_history_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not resolve app data directory: {e}"))?;
    Ok(dir.join("history.json"))
}

/// Load the history store from disk defensively.
///
/// - Absent file returns a fresh empty store (normal startup).
/// - Corrupt JSON backs up the file to `history.corrupt-<timestamp>.json` and initializes empty.
/// - Unsupported version backs up the file to `history.unsupported-v<ver>-<timestamp>.json` and initializes empty.
pub fn load_history(path: &Path) -> HistoryStore {
    if !path.exists() {
        return HistoryStore::default();
    }
    let data = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(err) => {
            eprintln!("Failed to read history file {}: {}", path.display(), err);
            return HistoryStore::default();
        }
    };
    if data.trim_ascii().is_empty() {
        return HistoryStore::default();
    }

    let parsed: serde_json::Value = match serde_json::from_slice(&data) {
        Ok(val) => val,
        Err(err) => {
            eprintln!("Corrupt history file detected: {err}");
            backup_corrupt_file(path, "corrupt");
            return HistoryStore::default();
        }
    };

    let version = parsed
        .get("version")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0) as u32;

    if version != CURRENT_HISTORY_VERSION {
        eprintln!(
            "Unsupported history schema version ({version}); expected {CURRENT_HISTORY_VERSION}"
        );
        backup_corrupt_file(path, &format!("unsupported-v{version}"));
        return HistoryStore::default();
    }

    match serde_json::from_value::<HistoryStore>(parsed) {
        Ok(store) => store,
        Err(err) => {
            eprintln!("Invalid history store schema: {err}");
            backup_corrupt_file(path, "corrupt");
            HistoryStore::default()
        }
    }
}

/// Safely backup a problematic history file without silently destroying its contents.
fn backup_corrupt_file(path: &Path, tag: &str) {
    let timestamp = current_timestamp_ms();
    let backup_name = format!("history.{tag}-{timestamp}.json");
    let backup_path = path.with_file_name(backup_name);
    let _ = std::fs::rename(path, &backup_path);
}

#[cfg(windows)]
extern "system" {
    fn ReplaceFileW(
        lpReplacedFileName: *const u16,
        lpReplacementFileName: *const u16,
        lpBackupFileName: *const u16,
        dwReplaceFlags: u32,
        lpExclude: *mut std::ffi::c_void,
        lpReserved: *mut std::ffi::c_void,
    ) -> i32;

    fn MoveFileExW(lpExistingFileName: *const u16, lpNewFileName: *const u16, dwFlags: u32) -> i32;

    fn GetLastError() -> u32;
}

/// Safely replace `target_path` with `temp_path` on Windows without deleting `target_path` first.
///
/// If `target_path` exists, `ReplaceFileW` atomically replaces it while leaving it intact if
/// replacement fails. If `target_path` does not yet exist, `MoveFileExW` commits the new file.
#[cfg(windows)]
pub fn replace_file_atomic(temp_path: &Path, target_path: &Path) -> Result<(), std::io::Error> {
    use std::os::windows::ffi::OsStrExt;

    const MOVEFILE_REPLACE_EXISTING: u32 = 0x00000001;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x00000008;
    const ERROR_FILE_NOT_FOUND: u32 = 2;

    let to_wide = |p: &Path| -> Vec<u16> {
        p.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    };

    let temp_wide = to_wide(temp_path);
    let target_wide = to_wide(target_path);

    if target_path.exists() {
        let res = unsafe {
            ReplaceFileW(
                target_wide.as_ptr(),
                temp_wide.as_ptr(),
                std::ptr::null(),
                0,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        if res != 0 {
            return Ok(());
        }
        let err = unsafe { GetLastError() };
        if err != ERROR_FILE_NOT_FOUND {
            return Err(std::io::Error::from_raw_os_error(err as i32));
        }
    }

    let res = unsafe {
        MoveFileExW(
            temp_wide.as_ptr(),
            target_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if res != 0 {
        Ok(())
    } else {
        let err = unsafe { GetLastError() };
        Err(std::io::Error::from_raw_os_error(err as i32))
    }
}

/// Cross-platform atomic replacement on non-Windows platforms.
#[cfg(not(windows))]
pub fn replace_file_atomic(temp_path: &Path, target_path: &Path) -> Result<(), std::io::Error> {
    std::fs::rename(temp_path, target_path)
}

pub type CommitterFn = fn(&Path, &Path) -> Result<(), std::io::Error>;

/// Atomically serialize and write `store` to `path` using the supplied committer.
pub fn save_history_impl(
    path: &Path,
    store: &HistoryStore,
    committer: CommitterFn,
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create history directory: {e}"))?;
        }
    }

    let json_bytes = serde_json::to_vec_pretty(store)
        .map_err(|e| format!("Failed to serialize history: {e}"))?;

    let timestamp = current_timestamp_ms();
    let pid = std::process::id();
    let temp_name = format!("history.json.tmp.{pid}.{timestamp}");
    let temp_path = path.with_file_name(temp_name);

    {
        use std::io::Write;
        let mut file = std::fs::File::create(&temp_path)
            .map_err(|e| format!("Failed to create temporary history file: {e}"))?;
        file.write_all(&json_bytes).map_err(|e| {
            let _ = std::fs::remove_file(&temp_path);
            format!("Failed to write temporary history file: {e}")
        })?;
        file.sync_all().map_err(|e| {
            let _ = std::fs::remove_file(&temp_path);
            format!("Failed to flush temporary history file: {e}")
        })?;
    }

    if let Err(e) = committer(&temp_path, path) {
        let _ = std::fs::remove_file(&temp_path);
        return Err(format!("Failed to commit history file: {e}"));
    }

    Ok(())
}

/// Atomically serialize and write `store` to `path` via a temporary file and safe replacement.
pub fn save_history(path: &Path, store: &HistoryStore) -> Result<(), String> {
    save_history_impl(path, store, replace_file_atomic)
}

/// Result of clearing history, returning the ID barrier.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClearHistoryResult {
    pub next_id: u64,
}

/// Append an entry with a monotonic persistent ID.
#[allow(clippy::too_many_arguments)]
pub fn append_entry(
    store: &mut HistoryStore,
    url: String,
    media_type: MediaType,
    quality: Option<VideoQuality>,
    audio_format: Option<AudioFormat>,
    output_directory: String,
    status: HistoryStatus,
    filename: Option<String>,
    filepath: Option<String>,
    message: Option<String>,
) -> HistoryEntry {
    let id = store.next_id;
    store.next_id += 1;
    let entry = HistoryEntry {
        id,
        timestamp_ms: current_timestamp_ms(),
        url,
        media_type,
        quality,
        audio_format,
        output_directory,
        status,
        filename,
        filepath,
        message,
    };
    store.entries.push(entry.clone());
    entry
}

/// Empty all history entries while preserving `version` and the `next_id` counter.
pub fn clear_entries(store: &mut HistoryStore) {
    store.entries.clear();
}

/// Map an immutable request snapshot and terminal outcome into a new history entry.
pub fn entry_from_outcome(
    store: &mut HistoryStore,
    request: &StartDownloadRequest,
    outcome: &DownloadTerminalOutcome,
) -> HistoryEntry {
    match outcome {
        DownloadTerminalOutcome::Complete(result) => append_entry(
            store,
            request.url.clone(),
            request.media_type,
            request.quality,
            request.audio_format,
            result.output_dir.clone(),
            HistoryStatus::Success,
            result.filename.clone(),
            result.filepath.clone(),
            None,
        ),
        DownloadTerminalOutcome::Error(err) => {
            let output_dir = request.output_directory.clone().unwrap_or_default();
            append_entry(
                store,
                request.url.clone(),
                request.media_type,
                request.quality,
                request.audio_format,
                output_dir,
                HistoryStatus::Error,
                None,
                None,
                Some(err.message.clone()),
            )
        }
        DownloadTerminalOutcome::Cancelled(cancelled) => {
            let output_dir = request.output_directory.clone().unwrap_or_default();
            append_entry(
                store,
                request.url.clone(),
                request.media_type,
                request.quality,
                request.audio_format,
                output_dir,
                HistoryStatus::Cancelled,
                None,
                None,
                Some(cancelled.message.clone()),
            )
        }
    }
}

pub type SaveHistoryFn = fn(&Path, &HistoryStore) -> Result<(), String>;

/// Manages thread-safe in-memory history operations and transactional disk persistence.
pub struct HistoryManager {
    path: PathBuf,
    store: HistoryStore,
    save_fn: SaveHistoryFn,
}

impl HistoryManager {
    pub fn new(path: PathBuf) -> Self {
        let store = load_history(&path);
        Self {
            path,
            store,
            save_fn: save_history,
        }
    }

    #[cfg(test)]
    pub fn with_save_fn(path: PathBuf, save_fn: SaveHistoryFn) -> Self {
        let store = load_history(&path);
        Self {
            path,
            store,
            save_fn,
        }
    }

    /// Retrieve all history entries, ordered newest first.
    pub fn get_entries_newest_first(&self) -> Vec<HistoryEntry> {
        self.store.entries.iter().rev().cloned().collect()
    }

    /// Current in-memory store reference.
    #[cfg(test)]
    pub fn store(&self) -> &HistoryStore {
        &self.store
    }

    /// Record a terminal outcome and commit transactionally to disk with copy-on-write.
    ///
    /// If persistence fails, the in-memory store and `next_id` remain unmodified.
    pub fn record(
        &mut self,
        request: &StartDownloadRequest,
        outcome: &DownloadTerminalOutcome,
    ) -> Result<HistoryEntry, String> {
        let mut candidate = self.store.clone();
        let entry = entry_from_outcome(&mut candidate, request, outcome);
        (self.save_fn)(&self.path, &candidate)?;
        self.store = candidate;
        Ok(entry)
    }

    /// Clear all entries and commit transactionally to disk with copy-on-write.
    ///
    /// Returns a `ClearHistoryResult` containing the barrier `next_id`.
    /// Any entry created after this clear has an `id >= barrier.next_id`.
    /// If persistence fails, existing in-memory entries remain unmodified.
    pub fn clear(&mut self) -> Result<ClearHistoryResult, String> {
        let mut candidate = self.store.clone();
        clear_entries(&mut candidate);
        (self.save_fn)(&self.path, &candidate)?;
        self.store = candidate;
        Ok(ClearHistoryResult {
            next_id: self.store.next_id,
        })
    }
}

/// Managed backend state for download history.
pub struct HistoryState {
    pub inner: Arc<Mutex<Option<HistoryManager>>>,
}

impl Default for HistoryState {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(None)),
        }
    }
}

impl HistoryState {
    /// Acquire the history manager, initializing lazily from `app.path().app_data_dir()` on first access.
    pub async fn get_manager(
        &self,
        app: &AppHandle,
    ) -> Result<tokio::sync::MutexGuard<'_, Option<HistoryManager>>, String> {
        let mut guard = self.inner.lock().await;
        if guard.is_none() {
            let path = resolve_history_path(app)?;
            *guard = Some(HistoryManager::new(path));
        }
        Ok(guard)
    }

    /// Explicitly initialize with a custom path (useful in tests).
    #[cfg(test)]
    #[allow(dead_code)]
    pub async fn init_with_path(&self, path: PathBuf) {
        let mut guard = self.inner.lock().await;
        *guard = Some(HistoryManager::new(path));
    }
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::ytdlp::{DownloadCancelled, DownloadError, DownloadResult};

    fn test_request() -> StartDownloadRequest {
        StartDownloadRequest {
            url: "https://example.com/watch?v=abc".to_string(),
            media_type: MediaType::Video,
            quality: Some(VideoQuality::P1080),
            audio_format: None,
            output_directory: Some("C:\\Videos".to_string()),
        }
    }

    #[test]
    fn test_missing_file_returns_empty_store() {
        let temp_dir =
            std::env::temp_dir().join(format!("yt_dlp_history_test_{}", current_timestamp_ms()));
        let history_file = temp_dir.join("non_existent_history.json");

        let store = load_history(&history_file);
        assert_eq!(store.version, CURRENT_HISTORY_VERSION);
        assert_eq!(store.next_id, 1);
        assert!(store.entries.is_empty());
    }

    #[test]
    fn test_history_roundtrip_preserves_fields_unicode_and_paths() {
        let temp_dir =
            std::env::temp_dir().join(format!("yt_dlp_roundtrip_{}", current_timestamp_ms()));
        let history_file = temp_dir.join("history.json");

        let mut store = HistoryStore::default();
        let unicode_name = "日本語タイトル 🚀 [%id%].mp4".to_string();
        let win_path = "D:\\Downloads\\Special 📁\\video.mp4".to_string();

        let e1 = append_entry(
            &mut store,
            "https://example.com/video1".to_string(),
            MediaType::Video,
            Some(VideoQuality::Best),
            None,
            "D:\\Downloads\\Special 📁".to_string(),
            HistoryStatus::Success,
            Some(unicode_name.clone()),
            Some(win_path.clone()),
            None,
        );

        let e2 = append_entry(
            &mut store,
            "https://example.com/audio1".to_string(),
            MediaType::Audio,
            None,
            Some(AudioFormat::Mp3),
            "D:\\Music".to_string(),
            HistoryStatus::Error,
            None,
            None,
            Some("Extraction failed: 404".to_string()),
        );

        let e3 = append_entry(
            &mut store,
            "https://example.com/cancel1".to_string(),
            MediaType::Video,
            Some(VideoQuality::P720),
            None,
            "C:\\Downloads".to_string(),
            HistoryStatus::Cancelled,
            None,
            None,
            Some("Download cancelled.".to_string()),
        );

        save_history(&history_file, &store).expect("save must succeed");

        let loaded = load_history(&history_file);
        assert_eq!(loaded.version, CURRENT_HISTORY_VERSION);
        assert_eq!(loaded.next_id, 4);
        assert_eq!(loaded.entries.len(), 3);

        assert_eq!(loaded.entries[0], e1);
        assert_eq!(loaded.entries[0].filename, Some(unicode_name));
        assert_eq!(loaded.entries[0].filepath, Some(win_path));

        assert_eq!(loaded.entries[1], e2);
        assert_eq!(loaded.entries[1].status, HistoryStatus::Error);
        assert_eq!(
            loaded.entries[1].message,
            Some("Extraction failed: 404".to_string())
        );

        assert_eq!(loaded.entries[2], e3);
        assert_eq!(loaded.entries[2].status, HistoryStatus::Cancelled);

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_history_ids_are_unique_and_monotonic() {
        let mut store = HistoryStore::default();
        let e1 = append_entry(
            &mut store,
            "https://example.com/1".to_string(),
            MediaType::Video,
            None,
            None,
            "C:\\".to_string(),
            HistoryStatus::Success,
            None,
            None,
            None,
        );
        let e2 = append_entry(
            &mut store,
            "https://example.com/2".to_string(),
            MediaType::Video,
            None,
            None,
            "C:\\".to_string(),
            HistoryStatus::Success,
            None,
            None,
            None,
        );
        let e3 = append_entry(
            &mut store,
            "https://example.com/3".to_string(),
            MediaType::Video,
            None,
            None,
            "C:\\".to_string(),
            HistoryStatus::Success,
            None,
            None,
            None,
        );

        assert_eq!(e1.id, 1);
        assert_eq!(e2.id, 2);
        assert_eq!(e3.id, 3);
        assert_eq!(store.next_id, 4);

        clear_entries(&mut store);
        assert!(store.entries.is_empty());

        let e4 = append_entry(
            &mut store,
            "https://example.com/4".to_string(),
            MediaType::Video,
            None,
            None,
            "C:\\".to_string(),
            HistoryStatus::Success,
            None,
            None,
            None,
        );
        assert_eq!(e4.id, 4, "next_id must continue incrementing after clear");
        assert_eq!(store.next_id, 5);
    }

    #[test]
    fn test_corrupt_file_is_backed_up_and_new_store_initialized() {
        let temp_dir =
            std::env::temp_dir().join(format!("yt_dlp_corrupt_{}", current_timestamp_ms()));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let history_file = temp_dir.join("history.json");

        std::fs::write(&history_file, "{ malformed json ]").unwrap();

        let store = load_history(&history_file);
        assert_eq!(store.version, CURRENT_HISTORY_VERSION);
        assert!(store.entries.is_empty());

        // Verify corrupt file was renamed
        let remaining_files: Vec<_> = std::fs::read_dir(&temp_dir)
            .unwrap()
            .map(|r| r.unwrap().file_name().to_string_lossy().to_string())
            .collect();

        assert!(
            remaining_files
                .iter()
                .any(|name| name.starts_with("history.corrupt-")),
            "A backup file with history.corrupt- prefix must be created"
        );

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_unsupported_version_is_safely_backed_up() {
        let temp_dir =
            std::env::temp_dir().join(format!("yt_dlp_unsupported_{}", current_timestamp_ms()));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let history_file = temp_dir.join("history.json");

        std::fs::write(
            &history_file,
            r#"{"version": 999, "nextId": 10, "entries": []}"#,
        )
        .unwrap();

        let store = load_history(&history_file);
        assert_eq!(store.version, CURRENT_HISTORY_VERSION);
        assert!(store.entries.is_empty());

        let remaining_files: Vec<_> = std::fs::read_dir(&temp_dir)
            .unwrap()
            .map(|r| r.unwrap().file_name().to_string_lossy().to_string())
            .collect();

        assert!(
            remaining_files
                .iter()
                .any(|name| name.starts_with("history.unsupported-v999-")),
            "A backup file with history.unsupported-v999- prefix must be created"
        );

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_outcome_mapping_success() {
        let mut store = HistoryStore::default();
        let req = test_request();
        let outcome = DownloadTerminalOutcome::Complete(DownloadResult {
            job_id: 42,
            filename: Some("video.mp4".to_string()),
            filepath: Some("C:\\Videos\\video.mp4".to_string()),
            output_dir: "C:\\Videos".to_string(),
        });

        let entry = entry_from_outcome(&mut store, &req, &outcome);
        assert_eq!(entry.id, 1);
        assert_eq!(entry.status, HistoryStatus::Success);
        assert_eq!(entry.url, req.url);
        assert_eq!(entry.media_type, MediaType::Video);
        assert_eq!(entry.quality, Some(VideoQuality::P1080));
        assert_eq!(entry.filename, Some("video.mp4".to_string()));
        assert_eq!(entry.filepath, Some("C:\\Videos\\video.mp4".to_string()));
        assert_eq!(entry.output_directory, "C:\\Videos");
        assert!(entry.message.is_none());
    }

    #[test]
    fn test_outcome_mapping_error() {
        let mut store = HistoryStore::default();
        let req = test_request();
        let outcome = DownloadTerminalOutcome::Error(DownloadError {
            job_id: 42,
            message: "Format unavailable".to_string(),
            details: Some("Format unavailable details".to_string()),
        });

        let entry = entry_from_outcome(&mut store, &req, &outcome);
        assert_eq!(entry.id, 1);
        assert_eq!(entry.status, HistoryStatus::Error);
        assert_eq!(entry.message, Some("Format unavailable".to_string()));
        assert!(entry.filename.is_none());
        assert!(entry.filepath.is_none());
    }

    #[test]
    fn test_outcome_mapping_cancelled() {
        let mut store = HistoryStore::default();
        let req = test_request();
        let outcome = DownloadTerminalOutcome::Cancelled(DownloadCancelled {
            job_id: 42,
            message: "Download cancelled.".to_string(),
        });

        let entry = entry_from_outcome(&mut store, &req, &outcome);
        assert_eq!(entry.id, 1);
        assert_eq!(entry.status, HistoryStatus::Cancelled);
        assert_eq!(entry.message, Some("Download cancelled.".to_string()));
        assert!(entry.filename.is_none());
        assert!(entry.filepath.is_none());
    }

    fn failing_save_fn(_path: &Path, _store: &HistoryStore) -> Result<(), String> {
        Err("Simulated save failure".to_string())
    }

    fn successful_save_fn(_path: &Path, _store: &HistoryStore) -> Result<(), String> {
        Ok(())
    }

    fn failing_committer(_temp: &Path, _target: &Path) -> Result<(), std::io::Error> {
        Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "Simulated commit failure",
        ))
    }

    #[test]
    fn test_failed_record_save_leaves_in_memory_store_unchanged() {
        let dummy_path = PathBuf::from("dummy_history.json");
        let mut manager = HistoryManager::with_save_fn(dummy_path, failing_save_fn);
        assert_eq!(manager.store().entries.len(), 0);
        assert_eq!(manager.store().next_id, 1);

        let req = test_request();
        let outcome = DownloadTerminalOutcome::Cancelled(DownloadCancelled {
            job_id: 1,
            message: "Cancelled".to_string(),
        });

        let res = manager.record(&req, &outcome);
        assert!(res.is_err());
        assert_eq!(manager.store().entries.len(), 0);
        assert_eq!(manager.store().next_id, 1);
    }

    #[test]
    fn test_failed_clear_save_leaves_in_memory_store_unchanged() {
        let dummy_path = PathBuf::from("dummy_history.json");
        let mut manager = HistoryManager::with_save_fn(dummy_path, successful_save_fn);
        let req = test_request();
        let outcome = DownloadTerminalOutcome::Cancelled(DownloadCancelled {
            job_id: 1,
            message: "Cancelled".to_string(),
        });
        let _ = manager.record(&req, &outcome).unwrap();
        assert_eq!(manager.store().entries.len(), 1);
        assert_eq!(manager.store().next_id, 2);

        manager.save_fn = failing_save_fn;
        let res = manager.clear();
        assert!(res.is_err());
        assert_eq!(manager.store().entries.len(), 1);
        assert_eq!(manager.store().next_id, 2);
    }

    #[test]
    fn test_failed_record_does_not_advance_next_id() {
        let dummy_path = PathBuf::from("dummy_history.json");
        let mut manager = HistoryManager::with_save_fn(dummy_path, failing_save_fn);
        manager.store = HistoryStore {
            version: 1,
            next_id: 20,
            entries: Vec::new(),
        };

        let req = test_request();
        let outcome = DownloadTerminalOutcome::Cancelled(DownloadCancelled {
            job_id: 1,
            message: "Cancelled".to_string(),
        });

        let res = manager.record(&req, &outcome);
        assert!(res.is_err());
        assert_eq!(manager.store().next_id, 20);

        manager.save_fn = successful_save_fn;
        let res2 = manager.record(&req, &outcome);
        assert!(res2.is_ok());
        let entry = res2.unwrap();
        assert_eq!(entry.id, 20);
        assert_eq!(manager.store().next_id, 21);
    }

    #[test]
    fn test_successful_record_advances_next_id_exactly_once() {
        let dummy_path = PathBuf::from("dummy_history.json");
        let mut manager = HistoryManager::with_save_fn(dummy_path, successful_save_fn);
        manager.store = HistoryStore {
            version: 1,
            next_id: 5,
            entries: Vec::new(),
        };

        let req = test_request();
        let outcome = DownloadTerminalOutcome::Cancelled(DownloadCancelled {
            job_id: 1,
            message: "Cancelled".to_string(),
        });

        let entry = manager.record(&req, &outcome).unwrap();
        assert_eq!(entry.id, 5);
        assert_eq!(manager.store().next_id, 6);
        assert_eq!(manager.store().entries.len(), 1);
    }

    #[test]
    fn test_successful_clear_preserves_next_id() {
        let dummy_path = PathBuf::from("dummy_history.json");
        let mut manager = HistoryManager::with_save_fn(dummy_path, successful_save_fn);
        manager.store = HistoryStore {
            version: 1,
            next_id: 15,
            entries: vec![HistoryEntry {
                id: 14,
                timestamp_ms: 1000,
                url: "https://example.com".to_string(),
                media_type: MediaType::Video,
                quality: None,
                audio_format: None,
                output_directory: "C:\\".to_string(),
                status: HistoryStatus::Success,
                filename: None,
                filepath: None,
                message: None,
            }],
        };

        let res = manager.clear().unwrap();
        assert_eq!(res.next_id, 15);
        assert_eq!(manager.store().next_id, 15);
        assert!(manager.store().entries.is_empty());
    }

    #[test]
    fn test_successful_clear_returns_correct_barrier() {
        let dummy_path = PathBuf::from("dummy_history.json");
        let mut manager = HistoryManager::with_save_fn(dummy_path, successful_save_fn);
        manager.store = HistoryStore {
            version: 1,
            next_id: 50,
            entries: Vec::new(),
        };

        let res = manager.clear().unwrap();
        assert_eq!(res.next_id, 50);
    }

    #[test]
    fn test_old_history_file_remains_intact_when_replacement_fails() {
        let temp_dir =
            std::env::temp_dir().join(format!("yt_dlp_replace_fail_{}", current_timestamp_ms()));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let history_file = temp_dir.join("history.json");

        let original_content = r#"{"version":1,"nextId":10,"entries":[]}"#;
        std::fs::write(&history_file, original_content).unwrap();

        let new_store = HistoryStore {
            version: 1,
            next_id: 11,
            entries: vec![],
        };

        let res = save_history_impl(&history_file, &new_store, failing_committer);
        assert!(res.is_err());

        let content_after = std::fs::read_to_string(&history_file).unwrap();
        assert_eq!(content_after, original_content);

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_temp_file_cleanup_after_replacement_failure() {
        let temp_dir =
            std::env::temp_dir().join(format!("yt_dlp_cleanup_fail_{}", current_timestamp_ms()));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let history_file = temp_dir.join("history.json");

        let store = HistoryStore::default();
        let res = save_history_impl(&history_file, &store, failing_committer);
        assert!(res.is_err());

        let entries: Vec<_> = std::fs::read_dir(&temp_dir)
            .unwrap()
            .map(|r| r.unwrap().file_name().to_string_lossy().to_string())
            .collect();

        assert!(
            !entries
                .iter()
                .any(|name| name.starts_with("history.json.tmp.")),
            "Temporary file must be cleaned up on replacement failure"
        );

        let _ = std::fs::remove_dir_all(&temp_dir);
    }
}
