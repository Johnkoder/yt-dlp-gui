/**
 * @vitest-environment jsdom
 */
import { renderHook, act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHistory } from "./useHistory";
import * as historyService from "../historyService";
import type { HistoryEntry } from "../types";

vi.mock("../historyService", () => ({
  getHistory: vi.fn(),
  clearHistory: vi.fn(),
  subscribeToHistoryEvents: vi.fn(),
  HISTORY_ENTRY_ADDED_EVENT: "history-entry-added",
}));

describe("useHistory hook", () => {
  let eventCallback: ((entry: HistoryEntry) => void) | null = null;
  const mockUnlisten = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    eventCallback = null;
    vi.mocked(historyService.subscribeToHistoryEvents).mockImplementation(
      async (callback) => {
        eventCallback = callback;
        return mockUnlisten;
      },
    );
  });

  it("loads history on mount and transitions to ready", async () => {
    const mockEntries: HistoryEntry[] = [
      {
        id: 2,
        timestampMs: 2000,
        url: "https://example.com/2",
        mediaType: "video",
        quality: "1080",
        audioFormat: null,
        outputDirectory: "C:\\Videos",
        status: "success",
        filename: "video2.mp4",
        filepath: "C:\\Videos\\video2.mp4",
        message: null,
      },
      {
        id: 1,
        timestampMs: 1000,
        url: "https://example.com/1",
        mediaType: "audio",
        quality: null,
        audioFormat: "mp3",
        outputDirectory: "C:\\Music",
        status: "error",
        filename: null,
        filepath: null,
        message: "Failed to download",
      },
    ];

    vi.mocked(historyService.getHistory).mockResolvedValueOnce(mockEntries);

    const { result } = renderHook(() => useHistory());

    expect(result.current.status).toBe("loading");

    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    expect(result.current.entries).toEqual(mockEntries);
    expect(result.current.errorMessage).toBeNull();
  });

  it("handles getHistory failure with error status", async () => {
    vi.mocked(historyService.getHistory).mockRejectedValueOnce(
      new Error("Disk read failure"),
    );

    const { result } = renderHook(() => useHistory());

    await waitFor(() => {
      expect(result.current.status).toBe("error");
    });

    expect(result.current.errorMessage).toBe("Disk read failure");
    expect(result.current.entries).toEqual([]);
  });

  it("prepends new entries when live event arrives after initial load", async () => {
    vi.mocked(historyService.getHistory).mockResolvedValueOnce([]);

    const { result } = renderHook(() => useHistory());

    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    const newEntry: HistoryEntry = {
      id: 1,
      timestampMs: 3000,
      url: "https://example.com/new",
      mediaType: "video",
      quality: "720",
      audioFormat: null,
      outputDirectory: "C:\\Downloads",
      status: "success",
      filename: "new.mp4",
      filepath: "C:\\Downloads\\new.mp4",
      message: null,
    };

    act(() => {
      eventCallback?.(newEntry);
    });

    expect(result.current.entries).toEqual([newEntry]);
  });

  it("deduplicates entry if event arrives while getHistory is in flight", async () => {
    let resolveGetHistory: (entries: HistoryEntry[]) => void;
    const getHistoryPromise = new Promise<HistoryEntry[]>((resolve) => {
      resolveGetHistory = resolve;
    });
    vi.mocked(historyService.getHistory).mockReturnValueOnce(getHistoryPromise);

    const { result } = renderHook(() => useHistory());

    const entry1: HistoryEntry = {
      id: 1,
      timestampMs: 1000,
      url: "https://example.com/race",
      mediaType: "video",
      quality: "best",
      audioFormat: null,
      outputDirectory: "C:\\Downloads",
      status: "success",
      filename: "race.mp4",
      filepath: "C:\\Downloads\\race.mp4",
      message: null,
    };

    // Live event arrives before getHistory resolves
    act(() => {
      eventCallback?.(entry1);
    });

    expect(result.current.entries).toEqual([entry1]);

    // getHistory resolves containing the same entry
    await act(async () => {
      resolveGetHistory([entry1]);
    });

    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    // Should only have 1 entry, not duplicated
    expect(result.current.entries.length).toBe(1);
    expect(result.current.entries[0].id).toBe(1);
  });

  it("clears history successfully and updates state", async () => {
    const entry: HistoryEntry = {
      id: 1,
      timestampMs: 1000,
      url: "https://example.com/1",
      mediaType: "video",
      quality: "best",
      audioFormat: null,
      outputDirectory: "C:\\Downloads",
      status: "success",
      filename: "vid.mp4",
      filepath: null,
      message: null,
    };
    vi.mocked(historyService.getHistory).mockResolvedValueOnce([entry]);
    vi.mocked(historyService.clearHistory).mockResolvedValueOnce();

    const { result } = renderHook(() => useHistory());

    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });
    expect(result.current.entries.length).toBe(1);

    let success: boolean | undefined;
    await act(async () => {
      success = await result.current.clearAllHistory();
    });

    expect(success).toBe(true);
    expect(historyService.clearHistory).toHaveBeenCalled();
    expect(result.current.entries).toEqual([]);
    expect(result.current.clearError).toBeNull();
  });

  it("sets clearError when clearHistory fails", async () => {
    vi.mocked(historyService.getHistory).mockResolvedValueOnce([]);
    vi.mocked(historyService.clearHistory).mockRejectedValueOnce(
      new Error("Permission denied"),
    );

    const { result } = renderHook(() => useHistory());

    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    let success: boolean | undefined;
    await act(async () => {
      success = await result.current.clearAllHistory();
    });

    expect(success).toBe(false);
    expect(result.current.clearError).toBe("Permission denied");
  });

  it("cleans up event listener on unmount", async () => {
    vi.mocked(historyService.getHistory).mockResolvedValueOnce([]);

    const { unmount } = renderHook(() => useHistory());

    await waitFor(() => {
      expect(historyService.subscribeToHistoryEvents).toHaveBeenCalled();
    });

    unmount();
    expect(mockUnlisten).toHaveBeenCalled();
  });
});
