/**
 * Download options domain: semantic values the UI deals in.
 * The backend maps these to yt-dlp arguments; the frontend never builds
 * `-f` expressions or format IDs.
 */

export type MediaType = "video" | "audio";

export type VideoQuality =
  | "best"
  | "2160"
  | "1440"
  | "1080"
  | "720"
  | "480"
  | "360";

export const MEDIA_TYPES: readonly MediaType[] = ["video", "audio"];

export const VIDEO_QUALITIES: readonly VideoQuality[] = [
  "best",
  "2160",
  "1440",
  "1080",
  "720",
  "480",
  "360",
];

export const MEDIA_TYPE_LABELS: Record<MediaType, string> = {
  video: "Video",
  audio: "Audio",
};

export const VIDEO_QUALITY_LABELS: Record<VideoQuality, string> = {
  best: "Best",
  "2160": "2160p",
  "1440": "1440p",
  "1080": "1080p",
  "720": "720p",
  "480": "480p",
  "360": "360p",
};

export const DEFAULT_MEDIA_TYPE: MediaType = "video";
export const DEFAULT_VIDEO_QUALITY: VideoQuality = "best";

/**
 * Structured download request sent to the `start_download` Tauri command.
 * `quality` is the selected video preset, or `null` for audio (which takes
 * no video quality). `outputDirectory` is the validated folder the user
 * picked; the backend still builds the yt-dlp `-o` template itself.
 * Serialized camelCase to match the Rust `StartDownloadRequest`.
 */
export interface DownloadRequest {
  url: string;
  mediaType: MediaType;
  quality: VideoQuality | null;
  outputDirectory: string;
}

export function buildDownloadRequest(
  url: string,
  mediaType: MediaType,
  quality: VideoQuality,
  outputDirectory: string,
): DownloadRequest {
  return {
    url: url.trim(),
    mediaType,
    quality: mediaType === "video" ? quality : null,
    outputDirectory,
  };
}
