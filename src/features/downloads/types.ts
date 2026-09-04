/** Shared download-domain types for the MVP. */

export type DownloadStatus =
  | "idle"
  | "downloading"
  | "success"
  | "error";

/**
 * Structured progress payload emitted by the Rust backend over Tauri events.
 * Mirrors the `DownloadProgress` struct in `src-tauri/src/services/ytdlp.rs`.
 * All fields except `status` are optional: when yt-dlp output cannot be
 * parsed into a percentage, the UI falls back to the raw `status` text.
 */
export interface DownloadProgressEvent {
  /** Human-readable status line, e.g. "Downloading" or raw yt-dlp output. */
  status: string;
  /** 0-100 when parseable, otherwise undefined. */
  percentage?: number | null;
  /** Raw speed string from yt-dlp, e.g. "8.40MiB/s". */
  speed?: string | null;
  /** Raw ETA string from yt-dlp, e.g. "00:08". */
  eta?: string | null;
  /** Destination filename when known. */
  filename?: string | null;
}

export interface DownloadResult {
  filename?: string | null;
  downloadsDir: string;
}

export interface DownloadError {
  message: string;
  /** Truncated stderr tail for display. */
  details?: string | null;
}
