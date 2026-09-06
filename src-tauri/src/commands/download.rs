//! Tauri commands: the only bridge between the React UI and yt-dlp.
//!
//! The frontend invokes these commands and listens for progress events.
//! Argument construction and process management live in
//! `crate::services::ytdlp`; this module owns the FIFO queue, the single
//! active download, and the background worker.

use std::collections::VecDeque;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{watch, Mutex};

use crate::services::ytdlp::{self, is_valid_http_url, StartDownloadRequest};

/// One waiting job: an ID plus the immutable request snapshot taken at
/// enqueue time. Later form edits can never mutate it.
struct QueuedDownload {
    id: u64,
    request: StartDownloadRequest,
}

/// The one active download, if any. The ID makes cleanup stale-safe: a
/// finished old task can never clear a newer download's record.
struct ActiveDownload {
    id: u64,
    cancel_tx: watch::Sender<bool>,
}

#[derive(Default)]
struct DownloadControl {
    next_id: u64,
    worker_running: bool,
    active: Option<ActiveDownload>,
    queued: VecDeque<QueuedDownload>,
}

/// Outcome of asking to cancel/remove a job by ID.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CancelOutcome {
    /// The job was active: cancellation was signalled; the terminal
    /// `download-cancelled` event follows once the tree is reaped.
    Cancelling,
    /// The job was waiting: it was removed and its terminal
    /// `download-cancelled` event was already emitted.
    Removed,
    /// No active or waiting job carries this ID.
    NotFound,
}

/// Accepted-enqueue answer. The frontend sends semantic options only —
/// never shell or process information.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnqueueResult {
    pub job_id: u64,
}

impl DownloadControl {
    /// Accept a validated request at the back of the FIFO queue. Returns the
    /// fresh job ID and whether the caller must spawn the single queue
    /// worker. Both decisions happen atomically under one lock hold, so
    /// rapid enqueues still yield exactly one worker.
    fn enqueue(&mut self, request: StartDownloadRequest) -> (u64, bool) {
        let id = self.next_id;
        self.next_id += 1;
        self.queued.push_back(QueuedDownload { id, request });
        let spawn_worker = !self.worker_running;
        if spawn_worker {
            self.worker_running = true;
        }
        (id, spawn_worker)
    }

    /// Accept a validated batch in playlist order. IDs stay monotonic, every
    /// job lands in order, and the worker-spawn decision is made exactly
    /// once — never one worker per item.
    fn enqueue_batch(&mut self, requests: Vec<StartDownloadRequest>) -> (Vec<u64>, bool) {
        let mut ids = Vec::with_capacity(requests.len());
        for request in requests {
            let id = self.next_id;
            self.next_id += 1;
            ids.push(id);
            self.queued.push_back(QueuedDownload { id, request });
        }
        let spawn_worker = !self.worker_running;
        if spawn_worker {
            self.worker_running = true;
        }
        (ids, spawn_worker)
    }

    /// Promote the front job to active, installing its cancellation channel.
    /// When the queue is empty the worker parks itself (`worker_running` is
    /// cleared) under the same lock, so an enqueue racing this transition
    /// either hands its job to the live worker or starts a new one — a job
    /// can never sit queued with no worker while the flag claims otherwise.
    fn take_next(&mut self) -> Option<(u64, StartDownloadRequest, watch::Receiver<bool>)> {
        match self.queued.pop_front() {
            Some(job) => {
                let (cancel_tx, cancel_rx) = watch::channel(false);
                self.active = Some(ActiveDownload {
                    id: job.id,
                    cancel_tx,
                });
                Some((job.id, job.request, cancel_rx))
            }
            None => {
                self.worker_running = false;
                None
            }
        }
    }

    /// Cancel or remove a job by ID, decided atomically: an active job gets
    /// its cancellation signal; a waiting job is removed outright. The
    /// waiting→active promotion race resolves here — whichever state the
    /// lock observes is authoritative.
    fn cancel_job(&mut self, id: u64) -> CancelOutcome {
        if self.active.as_ref().is_some_and(|active| active.id == id) {
            let _ = self
                .active
                .as_ref()
                .expect("checked above")
                .cancel_tx
                .send(true);
            return CancelOutcome::Cancelling;
        }
        if let Some(position) = self.queued.iter().position(|job| job.id == id) {
            self.queued.remove(position);
            return CancelOutcome::Removed;
        }
        CancelOutcome::NotFound
    }

    /// Clear the active record, but only if it still belongs to `id`.
    /// A stale (already replaced) record is left untouched.
    fn finish(&mut self, id: u64) {
        if self.active.as_ref().is_some_and(|active| active.id == id) {
            self.active = None;
        }
    }

    #[cfg(test)]
    fn is_active(&self) -> bool {
        self.active.is_some()
    }

    #[cfg(test)]
    fn queued_ids(&self) -> Vec<u64> {
        self.queued.iter().map(|job| job.id).collect()
    }
}

/// FIFO queue with exactly one active download. Structured as managed state
/// so the worker, commands, and (later) a queue UI share one authority.
/// No globals, no unsafe.
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

/// Accept a download request into the FIFO queue. The request is fully
/// validated up front (URL, media/quality/format combinations, output
/// folder, yt-dlp resource, FFmpeg requirement) so obviously invalid jobs
/// never enter the queue. Returns the backend-owned job ID.
///
/// At most one yt-dlp job runs at a time: the single queue worker picks the
/// job up, or it is already running and will get to it in FIFO order.
#[tauri::command]
pub async fn enqueue_download(
    app: AppHandle,
    state: State<'_, DownloadState>,
    request: StartDownloadRequest,
) -> Result<EnqueueResult, String> {
    if !is_valid_http_url(request.url.trim()) {
        return Err("That does not look like a valid http(s) URL.".to_string());
    }
    // Fail fast if the binary is missing so the user gets an immediate,
    // understandable error instead of a silent background failure.
    ytdlp::resolve_ytdlp_path(&app)?;

    // Full validation now (bad jobs never queue); the worker revalidates at
    // execution time because folders and tools may change while waiting.
    ytdlp::validate_request(&request)?;

    let (job_id, spawn_worker) = {
        let mut control = state.inner.lock().await;
        control.enqueue(request)
    };

    if spawn_worker {
        let inner = state.inner.clone();
        tokio::spawn(queue_worker(app, inner));
    }

    Ok(EnqueueResult { job_id })
}

/// One expanded playlist child: its backend job ID plus the resolved item
/// URL, so the frontend can rebuild each child's full request snapshot.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistEnqueueItem {
    pub job_id: u64,
    pub url: String,
    pub title: Option<String>,
}

/// Batch answer: every accepted child in playlist order, plus how many raw
/// entries had to be skipped.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistEnqueueResult {
    pub items: Vec<PlaylistEnqueueItem>,
    pub skipped_count: usize,
}

/// Expand a playlist URL into normal FIFO queue jobs sharing one common
/// request snapshot (media type, quality, audio format, output folder).
///
/// Flow is all-discovery-first, then one atomic batch enqueue: an
/// extraction failure can never leave a half-added playlist behind.
/// Afterwards the existing worker treats every child like any manual job —
/// same validation, same argv builder, same single active download.
#[tauri::command]
pub async fn enqueue_playlist(
    app: AppHandle,
    state: State<'_, DownloadState>,
    request: StartDownloadRequest,
) -> Result<PlaylistEnqueueResult, String> {
    if !is_valid_http_url(request.url.trim()) {
        return Err("That does not look like a valid http(s) URL.".to_string());
    }
    ytdlp::resolve_ytdlp_path(&app)?;

    // Upfront validation of the COMMON settings (bad combos, missing
    // folder, missing FFmpeg for conversions): reject before spending
    // time on extraction or queueing unusable jobs.
    ytdlp::validate_request(&request)?;

    let discovery = crate::services::playlist::discover_entries(&app, request.url.trim()).await?;
    if discovery.entries.is_empty() {
        return Err(
            "This playlist has no downloadable items. Unavailable or private entries were skipped."
                .to_string(),
        );
    }

    let (spawn_worker, items) = {
        let mut control = state.inner.lock().await;
        let child_requests: Vec<StartDownloadRequest> = discovery
            .entries
            .iter()
            .map(|entry| crate::services::playlist::child_request(&request, entry.url.clone()))
            .collect();
        let (ids, spawn_worker) = control.enqueue_batch(child_requests);
        let items: Vec<PlaylistEnqueueItem> = ids
            .into_iter()
            .zip(discovery.entries.iter())
            .map(|(job_id, entry)| PlaylistEnqueueItem {
                job_id,
                url: entry.url.clone(),
                title: entry.title.clone(),
            })
            .collect();
        (spawn_worker, items)
    };

    if spawn_worker {
        let inner = state.inner.clone();
        tokio::spawn(queue_worker(app, inner));
    }

    Ok(PlaylistEnqueueResult {
        items,
        skipped_count: discovery.skipped,
    })
}

/// Cancel or remove a queued job by its backend ID.
///
/// - active job → cancellation is signalled; the terminal
///   `download-cancelled` event follows once the process tree is reaped.
/// - waiting job → removed immediately and its terminal `download-cancelled`
///   event (`"Removed from queue."`) is emitted right here.
/// - unknown ID → `NotFound`, harmless.
///
/// The frontend supplies ONLY the job ID: no PIDs, paths, or process
/// details ever cross IPC.
#[tauri::command]
pub async fn cancel_job(
    app: AppHandle,
    state: State<'_, DownloadState>,
    job_id: u64,
) -> Result<CancelOutcome, String> {
    let outcome = { state.inner.lock().await.cancel_job(job_id) };
    if outcome == CancelOutcome::Removed {
        let _ = app.emit(
            ytdlp::CANCELLED_EVENT,
            ytdlp::DownloadCancelled {
                job_id,
                message: "Removed from queue.".to_string(),
            },
        );
    }
    Ok(outcome)
}

/// The single queue worker. Sequential by construction: one task drains the
/// FIFO, running each job to exactly one terminal outcome before taking the
/// next. Errors, cancellations, and revalidation failures all continue the
/// loop — one bad job never stalls the queue.
async fn queue_worker(app: AppHandle, inner: Arc<Mutex<DownloadControl>>) {
    loop {
        let taken = { inner.lock().await.take_next() };
        let Some((id, request, cancel_rx)) = taken else {
            break;
        };

        let _ = app.emit(ytdlp::STARTED_EVENT, ytdlp::DownloadStarted { job_id: id });

        // Revalidate at execution time: folders may vanish and tools may
        // disappear while the job waits. A stale job errors WITHOUT
        // launching yt-dlp, then the queue continues.
        match ytdlp::validate_request(&request) {
            Err(message) => {
                let _ = app.emit(
                    ytdlp::ERROR_EVENT,
                    ytdlp::DownloadError {
                        job_id: id,
                        message: message.clone(),
                        details: Some(message),
                    },
                );
            }
            Ok(options) => {
                ytdlp::run_download(app.clone(), id, options, cancel_rx).await;
            }
        }

        inner.lock().await.finish(id);
    }
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
    use crate::services::ytdlp::{MediaType, VideoQuality};

    fn video_request(url: &str) -> StartDownloadRequest {
        StartDownloadRequest {
            url: url.to_string(),
            media_type: MediaType::Video,
            quality: Some(VideoQuality::Best),
            audio_format: None,
            output_directory: None,
        }
    }

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
    fn enqueue_into_empty_queue_is_accepted() {
        // A: first job gets ID 0 and requests the single worker.
        let mut control = DownloadControl::default();
        let (id, spawn) = control.enqueue(video_request("https://a.example/"));
        assert_eq!(id, 0);
        assert!(spawn);
        assert_eq!(control.queued_ids(), vec![0]);
    }

    #[test]
    fn enqueue_keeps_fifo_order() {
        // B: three jobs keep arrival order with unique increasing IDs.
        let mut control = DownloadControl::default();
        let (a, _) = control.enqueue(video_request("https://a.example/"));
        let (b, _) = control.enqueue(video_request("https://b.example/"));
        let (c, _) = control.enqueue(video_request("https://c.example/"));
        assert!(a < b && b < c);
        assert_eq!(control.queued_ids(), vec![a, b, c]);
    }

    #[test]
    fn worker_take_and_finish_sequence() {
        // D/E: the worker promotes the front job, finish clears it, and the
        // next job follows — modelling success/error/cancel continuation.
        let mut control = DownloadControl::default();
        control.enqueue(video_request("https://a.example/"));
        control.enqueue(video_request("https://b.example/"));

        let (id_a, _, _) = control.take_next().expect("first job");
        assert!(control.is_active());
        // A second take while active still pops the queue (single-worker
        // discipline belongs to the loop, which never overlaps takes).
        control.finish(id_a);
        assert!(!control.is_active());
        let (id_b, _, _) = control.take_next().expect("second job");
        assert_ne!(id_a, id_b);
        control.finish(id_b);
        assert!(control.take_next().is_none());
    }

    #[test]
    fn empty_queue_parks_worker() {
        // F: draining the queue clears the running flag under the same lock.
        let mut control = DownloadControl {
            worker_running: true,
            ..Default::default()
        };
        assert!(control.take_next().is_none());
        assert!(!control.worker_running);
    }

    #[test]
    fn remove_waiting_job_keeps_others() {
        // G: only the requested waiting ID leaves.
        let mut control = DownloadControl::default();
        let (a, _) = control.enqueue(video_request("https://a.example/"));
        let (b, _) = control.enqueue(video_request("https://b.example/"));
        let (c, _) = control.enqueue(video_request("https://c.example/"));
        assert_eq!(control.cancel_job(999), CancelOutcome::NotFound);
        assert_eq!(control.cancel_job(b), CancelOutcome::Removed);
        assert_eq!(control.queued_ids(), vec![a, c]);
    }

    #[test]
    fn cancel_active_signals_receiver() {
        // H: active job resolves to Cancelling and flips the channel.
        let mut control = DownloadControl::default();
        control.enqueue(video_request("https://a.example/"));
        let (id, _, rx) = control.take_next().expect("active");
        assert!(!*rx.borrow());
        assert_eq!(control.cancel_job(id), CancelOutcome::Cancelling);
        assert!(*rx.borrow());
        // Idempotent: asking again still reports Cancelling, never panics.
        assert_eq!(control.cancel_job(id), CancelOutcome::Cancelling);
    }

    #[test]
    fn waiting_to_active_race_resolves_authoritatively() {
        // I: removal attempted as the job promotes resolves to whichever
        // state the single lock observes — never a lost removal of a
        // running job.
        let mut control = DownloadControl::default();
        let (id, _) = control.enqueue(video_request("https://a.example/"));
        // Case 1: cancel lands first → Removed, worker later finds nothing.
        assert_eq!(control.cancel_job(id), CancelOutcome::Removed);
        assert!(control.take_next().is_none());
        // Case 2: promotion lands first → Cancelling, never Removed.
        let (id2, _) = control.enqueue(video_request("https://b.example/"));
        let (active_id, _, _) = control.take_next().expect("promoted");
        assert_eq!(id2, active_id);
        assert_eq!(control.cancel_job(id2), CancelOutcome::Cancelling);
    }

    #[test]
    fn stale_finish_cannot_clear_newer_download() {
        // J: generation IDs protect the active record.
        let mut control = DownloadControl::default();
        let (first, _) = control.enqueue(video_request("https://a.example/"));
        let (first_id, _, _) = control.take_next().expect("active");
        assert_eq!(first, first_id);
        control.finish(first_id + 999);
        assert!(control.is_active(), "wrong id must not clear");
        control.finish(first_id);
        assert!(!control.is_active());
        let (second, _) = control.enqueue(video_request("https://b.example/"));
        let _ = control.take_next().expect("second active");
        assert_ne!(first, second);
        control.finish(first);
        assert!(control.is_active(), "stale finish must not clear");
    }

    #[test]
    fn cancel_outcome_serializes_camel_case() {
        assert_eq!(
            serde_json::to_value(CancelOutcome::Cancelling).expect("serializes"),
            serde_json::json!("cancelling")
        );
        assert_eq!(
            serde_json::to_value(CancelOutcome::Removed).expect("serializes"),
            serde_json::json!("removed")
        );
        assert_eq!(
            serde_json::to_value(CancelOutcome::NotFound).expect("serializes"),
            serde_json::json!("notFound")
        );
        assert_eq!(
            serde_json::to_value(EnqueueResult { job_id: 17 }).expect("serializes"),
            serde_json::json!({ "jobId": 17 })
        );
    }

    #[test]
    fn batch_enqueue_appends_in_order_with_one_spawn() {
        // Existing X, Y plus batch A, B, C → X, Y, A, B, C with IDs
        // mapping exactly onto the batch order.
        let mut control = DownloadControl::default();
        let (x, _) = control.enqueue(video_request("https://x.example/"));
        let (y, _) = control.enqueue(video_request("https://y.example/"));
        let batch: Vec<StartDownloadRequest> = ["a", "b", "c"]
            .iter()
            .map(|name| video_request(&format!("https://{}.example/", name)))
            .collect();
        let (ids, spawn) = control.enqueue_batch(batch);
        assert_eq!(ids.len(), 3);
        assert!(spawn, "idle worker must be requested once");
        assert_eq!(
            control.queued_ids(),
            vec![x, y, ids[0], ids[1], ids[2]],
            "batch appends after existing jobs in order"
        );
        // A second batch while "running" requests no new worker.
        let (ids2, spawn2) = control.enqueue_batch(vec![video_request("https://d.example/")]);
        assert!(!spawn2, "no second worker while running");
        assert_eq!(ids2.len(), 1);
        assert!(ids2[0] > ids[2], "IDs keep increasing");
    }

    #[test]
    fn batch_of_twenty_requests_single_worker() {
        // A 20-item playlist batch on an empty queue: one spawn flag.
        let mut control = DownloadControl::default();
        let batch: Vec<StartDownloadRequest> = (0..20)
            .map(|i| video_request(&format!("https://{}.example/", i)))
            .collect();
        let (ids, spawn) = control.enqueue_batch(batch);
        assert_eq!(ids.len(), 20);
        assert!(spawn);
        let mut sorted = ids.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), 20, "batch IDs unique");
    }

    #[test]
    fn mixed_single_and_batch_ids_stay_unique_monotonic() {
        // single A, batch B/C/D, single E: unique, ever-increasing IDs.
        let mut control = DownloadControl::default();
        let (a, _) = control.enqueue(video_request("https://a.example/"));
        let (batch_ids, _) = control.enqueue_batch(
            ["b", "c", "d"]
                .iter()
                .map(|name| video_request(&format!("https://{}.example/", name)))
                .collect(),
        );
        let (e, _) = control.enqueue(video_request("https://e.example/"));
        let all = std::iter::once(a)
            .chain(batch_ids.clone())
            .chain(std::iter::once(e))
            .collect::<Vec<_>>();
        assert_eq!(all, vec![a, batch_ids[0], batch_ids[1], batch_ids[2], e]);
        let mut sorted = all.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), 5, "no ID reuse across single/batch");
        assert!(all.windows(2).all(|pair| pair[0] < pair[1]), "monotonic");
        assert_eq!(
            control.queued_ids(),
            all,
            "queue order matches acceptance order"
        );
    }

    #[test]
    fn playlist_result_serializes_for_typescript() {
        let result = PlaylistEnqueueResult {
            items: vec![
                PlaylistEnqueueItem {
                    job_id: 10,
                    url: "https://example.com/watch?v=A".to_string(),
                    title: Some("A".to_string()),
                },
                PlaylistEnqueueItem {
                    job_id: 11,
                    url: "https://example.com/watch?v=B".to_string(),
                    title: None,
                },
            ],
            skipped_count: 2,
        };
        assert_eq!(
            serde_json::to_value(&result).expect("serializes"),
            serde_json::json!({
                "items": [
                    {"jobId": 10, "url": "https://example.com/watch?v=A", "title": "A"},
                    {"jobId": 11, "url": "https://example.com/watch?v=B", "title": null},
                ],
                "skippedCount": 2,
            })
        );
    }

    #[tokio::test]
    async fn concurrent_enqueues_keep_fifo_and_single_worker() {
        // Many simultaneous enqueues: unique IDs, no lost jobs, exactly one
        // worker-spawn request, dequeue order matching ID order.
        let state = DownloadState::default();
        let mut handles = Vec::new();
        for i in 0..16u64 {
            let inner = state.inner.clone();
            handles.push(tokio::spawn(async move {
                let mut control = inner.lock().await;
                control.enqueue(video_request(&format!("https://{}.example/", i)))
            }));
        }
        let mut outcomes = Vec::new();
        for handle in handles {
            outcomes.push(handle.await.expect("enqueue task"));
        }
        let mut ids: Vec<u64> = outcomes.iter().map(|(id, _)| *id).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), 16, "IDs must be unique, none lost");
        let spawns = outcomes.iter().filter(|(_, spawn)| *spawn).count();
        assert_eq!(spawns, 1, "exactly one worker-spawn request");
        // FIFO: locked-order pushes dequeue in ID order.
        let mut control = state.inner.lock().await;
        let mut dequeued = Vec::new();
        while let Some((id, _, _)) = control.take_next() {
            dequeued.push(id);
            control.finish(id);
        }
        let mut sorted = dequeued.clone();
        sorted.sort_unstable();
        assert_eq!(dequeued, sorted, "dequeue follows ID order");
        assert!(!control.worker_running);
    }
}
