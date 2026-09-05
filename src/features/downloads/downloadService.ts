import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { DownloadRequest, MediaType } from "./options";
import type {
  CancelJobOutcome,
  DownloadCancelled,
  DownloadError,
  DownloadProgressEvent,
  DownloadResult,
  DownloadStartedEvent,
  EnqueueResult,
} from "./types";

export const DOWNLOAD_STARTED_EVENT = "download-started";
export const DOWNLOAD_PROGRESS_EVENT = "download-progress";
export const DOWNLOAD_COMPLETE_EVENT = "download-complete";
export const DOWNLOAD_ERROR_EVENT = "download-error";
export const DOWNLOAD_CANCELLED_EVENT = "download-cancelled";

export interface DownloadEventHandlers {
  onStarted: (event: DownloadStartedEvent) => void;
  onProgress: (progress: DownloadProgressEvent) => void;
  onComplete: (result: DownloadResult) => void;
  onError: (error: DownloadError) => void;
  onCancelled: (event: DownloadCancelled) => void;
}

/**
 * Thin wrapper over Tauri commands/events for downloads.
 *
 * The React layer sends semantic option snapshots (media type, quality
 * preset, folder) and never builds shell strings or yt-dlp arguments. All
 * argument construction and process execution lives in the Rust backend
 * (`src-tauri/src/services/ytdlp.rs`), which also owns queue order and the
 * single active job.
 */

export async function openOutputFolder(path: string): Promise<void> {
  await invoke("open_output_folder", { path });
}

export async function getDownloadsDir(): Promise<string> {
  return invoke<string>("get_downloads_dir");
}

/** Backend validation shared by startup checks and new selections. */
export async function validateOutputDirectory(path: string): Promise<string> {
  return invoke<string>("validate_output_directory", { path });
}

/**
 * Native folder picker (directory only, single selection).
 * Returns the chosen folder, or `null` when the user cancels — cancellation
 * is not an error and must leave the current selection untouched.
 */
export async function chooseOutputDirectory(): Promise<string | null> {
  const selected = await openDialog({
    directory: true,
    multiple: false,
    title: "Choose output folder",
  });
  if (selected === null) {
    return null;
  }
  const path = Array.isArray(selected) ? selected[0] : selected;
  return path ?? null;
}

export function friendlyErrorMessage(
  raw: string,
  mediaType?: MediaType,
): string {
  const lower = raw.toLowerCase();
  if (lower.includes("ffmpeg")) {
    // The backend's conversion rejection names the format precisely;
    // surface it verbatim instead of the generic merge guidance.
    if (lower.includes("convert audio to")) {
      const firstLine = raw
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0);
      return firstLine ?? raw;
    }
    if (mediaType === "audio") {
      return "FFmpeg is required for audio conversion. Install FFmpeg or choose the Original format.";
    }
    if (
      lower.includes("not installed") ||
      lower.includes("not found") ||
      lower.includes("required")
    ) {
      return "FFmpeg is required to merge this video quality. Install FFmpeg or choose a format that does not require merging.";
    }
  }
  if (mediaType === "audio" && lower.includes("postprocessing")) {
    return "Audio conversion failed. See details below.";
  }
  if (
    lower.includes("requested format is not available") ||
    lower.includes("no video formats found") ||
    lower.includes("no audio formats found")
  ) {
    return mediaType === "audio"
      ? "No audio-only format is available for this URL."
      : "The requested quality is not available for this video. Try Best quality.";
  }
  if (
    lower.includes("unsupported url") ||
    lower.includes("not a valid url") ||
    lower.includes("invalid url")
  ) {
    return "That URL is not supported. Check the link and try again.";
  }
  if (lower.includes("yt-dlp binary") || lower.includes("yt-dlp.exe")) {
    return "yt-dlp executable was not found. Reinstall the application.";
  }
  if (
    lower.includes("deno") ||
    lower.includes("js runtime") ||
    lower.includes("javascript runtime")
  ) {
    return "A JavaScript runtime (Deno) is required by yt-dlp for this site and was not found.";
  }
  if (
    lower.includes("http error 403") ||
    lower.includes("http error 404") ||
    lower.includes("http error")
  ) {
    return "The site refused the request. The video may be private, removed, or region-locked.";
  }
  if (
    lower.includes("network") ||
    lower.includes("failed to resolve") ||
    lower.includes("connection") ||
    lower.includes("timed out") ||
    lower.includes("urlopen error")
  ) {
    return "Network error. Check your connection and try again.";
  }
  if (lower.includes("private video")) {
    return "This video is private and cannot be downloaded.";
  }
  if (
    lower.includes("video is unavailable") ||
    lower.includes("video unavailable")
  ) {
    return "This video is unavailable. It may be removed, private, or region-locked.";
  }
  if (lower.includes("sign in") || lower.includes("log in")) {
    return "This video requires login and cannot be downloaded anonymously.";
  }
  // Fall back to a trimmed single-line summary.
  const firstLine = raw.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  if (firstLine && firstLine.length <= 220) {
    return firstLine;
  }
  return "Download failed. See details below.";
}

/**
 * Request cancellation or removal of one queued job by backend ID.
 * Returns what the backend did: signalled an active job ("cancelling"),
 * removed a waiting job ("removed"), or found nothing ("notFound").
 * No PIDs or process details cross IPC — the backend owns them.
 */
export async function cancelJob(jobId: number): Promise<CancelJobOutcome> {
  return invoke<CancelJobOutcome>("cancel_job", { jobId });
}

/**
 * Enqueue a download request snapshot. Returns the backend-owned job ID.
 * The worker starts the job immediately when idle, otherwise it waits its
 * FIFO turn; progress arrives via events either way.
 */
export async function enqueueDownload(
  request: DownloadRequest,
): Promise<EnqueueResult> {
  const url = request.url.trim();
  if (url.length === 0) {
    throw new Error("Please paste a video URL first.");
  }
  return invoke<EnqueueResult>("enqueue_download", {
    request: { ...request, url },
  });
}

/**
 * Subscribe to backend download events. Returns an unlisten function.
 *
 * Registration is transactional: if any listener fails to register, the
 * ones already acquired are released before the original error is
 * rethrown, so a partial subscription can never leak. The returned
 * cleanup is idempotent.
 */
export async function subscribeToDownloadEvents(
  handlers: DownloadEventHandlers,
): Promise<UnlistenFn> {
  const unlisteners: UnlistenFn[] = [];
  try {
    unlisteners.push(
      await listen<DownloadStartedEvent>(
        DOWNLOAD_STARTED_EVENT,
        (event) => handlers.onStarted(event.payload),
      ),
    );
    unlisteners.push(
      await listen<DownloadProgressEvent>(
        DOWNLOAD_PROGRESS_EVENT,
        (event) => handlers.onProgress(event.payload),
      ),
    );
    unlisteners.push(
      await listen<DownloadResult>(
        DOWNLOAD_COMPLETE_EVENT,
        (event) => handlers.onComplete(event.payload),
      ),
    );
    unlisteners.push(
      await listen<DownloadError>(
        DOWNLOAD_ERROR_EVENT,
        (event) => handlers.onError(event.payload),
      ),
    );
    unlisteners.push(
      await listen<DownloadCancelled>(
        DOWNLOAD_CANCELLED_EVENT,
        (event) => handlers.onCancelled(event.payload),
      ),
    );
  } catch (error) {
    for (const unlisten of unlisteners) {
      unlisten();
    }
    throw error;
  }

  let cleanedUp = false;
  return () => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    for (const unlisten of unlisteners) {
      unlisten();
    }
  };
}
