/** Shared download-domain types for the queue model. */

import type { DownloadRequest } from "./options";

/**
 * Per-job lifecycle. Terminal states (success/error/cancelled) are sticky:
 * late events for a terminal job are ignored.
 */
export type JobStatus =
  | "queued"
  | "downloading"
  | "cancelling"
  | "success"
  | "error"
  | "cancelled";

/** Global app initialization (subscriptions + output folder). */
export type InitStatus = "initializing" | "ready" | "error";

export type EventSubscription = "pending" | "active" | "failed";

export interface DownloadJob {
  id: number;
  /** Request snapshot; null only for a placeholder created by an early event. */
  request: DownloadRequest | null;
  status: JobStatus;
  progress: DownloadProgressEvent | null;
  result: DownloadResult | null;
  errorMessage: string | null;
  errorDetails: string | null;
  cancelError: string | null;
}

/**
 * Structured progress payload emitted by the Rust backend over Tauri events.
 * Mirrors the `DownloadProgress` struct in `src-tauri/src/services/ytdlp.rs`.
 * `jobId` is authoritative — events are never attributed by "active" guess.
 */
export interface DownloadProgressEvent {
  jobId: number;
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

export interface DownloadStartedEvent {
  jobId: number;
}

export interface DownloadResult {
  jobId: number;
  /** Real final filename (after merge/post-processing). */
  filename?: string | null;
  /** Full final path, kept for future features (reveal in folder, …). */
  filepath?: string | null;
  /** The folder this download actually went to. */
  outputDir: string;
}

export interface DownloadError {
  jobId: number;
  message: string;
  /** Truncated stderr tail for display. */
  details?: string | null;
}

export interface DownloadCancelled {
  jobId: number;
  message: string;
}

export type CancelJobOutcome = "cancelling" | "removed" | "notFound";

export interface EnqueueResult {
  jobId: number;
}

export type DownloadScope = "single" | "playlist";

export interface PlaylistEnqueueItem {
  jobId: number;
  url: string;
  title?: string | null;
}

export interface PlaylistEnqueueResult {
  items: PlaylistEnqueueItem[];
  skippedCount: number;
}
