/**
 * Persistence for the single output-folder preference.
 *
 * Uses localStorage under a namespaced key. All access is centralized here
 * so components never scatter storage calls — and every access is guarded,
 * because storage can throw (privacy modes, disabled cookies, …).
 */

const STORAGE_KEY = "yt-dlp-gui.outputDirectory";

export function getSavedOutputDirectory(): string | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value && value.trim().length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function saveOutputDirectory(path: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, path);
  } catch {
    // Preference stays session-only; the download itself is unaffected.
  }
}

export function clearSavedOutputDirectory(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do: the key is already unreadable.
  }
}
