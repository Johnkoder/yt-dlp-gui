import type {
  AudioFormat,
  MediaType,
  VideoQuality,
} from "../downloads/options";

export type HistoryStatus = "success" | "error" | "cancelled";

export interface HistoryEntry {
  id: number;
  timestampMs: number;
  url: string;
  mediaType: MediaType;
  quality?: VideoQuality | null;
  audioFormat?: AudioFormat | null;
  outputDirectory: string;
  status: HistoryStatus;
  filename?: string | null;
  filepath?: string | null;
  message?: string | null;
}

export interface ClearHistoryResult {
  nextId: number;
}

