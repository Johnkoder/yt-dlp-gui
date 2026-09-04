import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  DownloadError,
  DownloadProgressEvent,
  DownloadResult,
} from "./types";

export const DOWNLOAD_PROGRESS_EVENT = "download-progress";
export const DOWNLOAD_COMPLETE_EVENT = "download-complete";
export const DOWNLOAD_ERROR_EVENT = "download-error";

export interface DownloadEventHandlers {
  onProgress: (progress: DownloadProgressEvent) => void;
  onComplete: (result: DownloadResult) => void;
  onError: (error: DownloadError) => void;
}

/**
 * Thin wrapper over Tauri commands/events for downloads.
 *
 * The React layer never builds shell strings or spawns processes itself.
 * All yt-dlp argument construction and process execution lives in the
 * Rust backend (`src-tauri/src/services/ytdlp.rs`).
 */
export async function startDownload(url: string): Promise<void> {
  const trimmed = url.trim();
  if (trimmed.length === 0) {
    throw new Error("Please paste a video URL first.");
  }
  await invoke("start_download", { url: trimmed });
}

export async function openDownloadsFolder(): Promise<void> {
  await invoke("open_downloads_folder");
}

export async function getDownloadsDir(): Promise<string> {
  return invoke<string>("get_downloads_dir");
}

export function friendlyErrorMessage(raw: string): string {
  const lower = raw.toLowerCase();
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
