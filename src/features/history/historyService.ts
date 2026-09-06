import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { HistoryEntry } from "./types";

export const HISTORY_ENTRY_ADDED_EVENT = "history-entry-added";

/**
 * Fetch all persistent history entries from the backend, ordered newest first.
 */
export async function getHistory(): Promise<HistoryEntry[]> {
  return invoke<HistoryEntry[]>("get_history");
}

/**
 * Clear all history entries from disk.
 */
export async function clearHistory(): Promise<void> {
  await invoke<void>("clear_history");
}

/**
 * Listen for live history entries added by the queue worker.
 * Returns an unlisten function for cleanup.
 */
export async function subscribeToHistoryEvents(
  onEntryAdded: (entry: HistoryEntry) => void,
): Promise<UnlistenFn> {
  return listen<HistoryEntry>(HISTORY_ENTRY_ADDED_EVENT, (event) => {
    onEntryAdded(event.payload);
  });
}
