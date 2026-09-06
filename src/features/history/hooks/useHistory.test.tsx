/**
 * @vitest-environment jsdom
 */
import { renderHook, act, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  afterEach(() => {
    cleanup();
  });

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

  it("A. normal clear: history [1, 2], clear returns nextId 3 -> result []", async () => {
    const e1: HistoryEntry = {
      id: 1,
      timestampMs: 1000,
      url: "https://example.com/1",
      mediaType: "video",
      quality: "best",
      outputDirectory: "C:\\Downloads",
      status: "success",
    };
    const e2: HistoryEntry = {
      id: 2,
      timestampMs: 2000,
      url: "https://example.com/2",
      mediaType: "video",
      quality: "best",
      outputDirectory: "C:\\Downloads",
      status: "success",
    };
    vi.mocked(historyService.getHistory).mockResolvedValueOnce([e2, e1]);
    vi.mocked(historyService.clearHistory).mockResolvedValueOnce({ nextId: 3 });

    const { result } = renderHook(() => useHistory());

    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });
    expect(result.current.entries.length).toBe(2);

    let success: boolean | undefined;
    await act(async () => {
      success = await result.current.clearAllHistory();
    });

    expect(success).toBe(true);
    expect(historyService.clearHistory).toHaveBeenCalled();
    expect(result.current.entries).toEqual([]);
    expect(result.current.clearError).toBeNull();
  });

  it("B & Req 2C. race test: new event after backend clear boundary (event 12 arrives while clear pending, clear returns nextId 12 -> 12 remains)", async () => {
    const e10: HistoryEntry = {
      id: 10,
      timestampMs: 1000,
      url: "https://example.com/10",
      mediaType: "video",
      quality: "best",
      outputDirectory: "C:\\Downloads",
      status: "success",
    };
    const e11: HistoryEntry = {
      id: 11,
      timestampMs: 1100,
      url: "https://example.com/11",
      mediaType: "video",
      quality: "best",
      outputDirectory: "C:\\Downloads",
      status: "success",
    };
    vi.mocked(historyService.getHistory).mockResolvedValueOnce([e11, e10]);

    let resolveClear!: (val: { nextId: number }) => void;
    const clearPromise = new Promise<{ nextId: number }>((resolve) => {
      resolveClear = resolve;
    });
    vi.mocked(historyService.clearHistory).mockReturnValueOnce(clearPromise);

    const { result } = renderHook(() => useHistory());

    // 1. Render history with IDs 10 and 11
    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });
    expect(result.current.entries.map((e) => e.id)).toEqual([11, 10]);

    // 2. Call clearAllHistory()
    let clearSuccess: boolean | undefined;
    const clearPromiseResult = result.current.clearAllHistory().then((res) => {
      clearSuccess = res;
    });

    // 3. Keep clear_history Promise unresolved & verify isClearing
    await waitFor(() => {
      expect(result.current.isClearing).toBe(true);
    });

    // 4. Emit history-entry-added ID 12 while clear is in-flight
    const e12: HistoryEntry = {
      id: 12,
      timestampMs: 1200,
      url: "https://example.com/12",
      mediaType: "video",
      quality: "best",
      outputDirectory: "C:\\Downloads",
      status: "success",
      filename: "video12.mp4",
    };
    act(() => {
      eventCallback?.(e12);
    });

    // 5. Assert ID 12 is visible alongside in-flight entries
    expect(result.current.entries.map((e) => e.id)).toEqual([12, 11, 10]);

    // 6. Resolve clear_history with barrier nextId = 12
    await act(async () => {
      resolveClear({ nextId: 12 });
      await clearPromiseResult;
    });

    expect(clearSuccess).toBe(true);
    expect(result.current.isClearing).toBe(false);

    // 7. Final entries must be: ID 12 only (10 and 11 filtered out)
    expect(result.current.entries.map((e) => e.id)).toEqual([12]);
  });

  it("C. race test: event belongs to old generation (event 12 arrived before backend clear committed, clear returns nextId 13 -> 12 removed)", async () => {
    const e10: HistoryEntry = {
      id: 10,
      timestampMs: 1000,
      url: "https://example.com/10",
      mediaType: "video",
      quality: "best",
      outputDirectory: "C:\\Downloads",
      status: "success",
    };
    const e11: HistoryEntry = {
      id: 11,
      timestampMs: 1100,
      url: "https://example.com/11",
      mediaType: "video",
      quality: "best",
      outputDirectory: "C:\\Downloads",
      status: "success",
    };
    vi.mocked(historyService.getHistory).mockResolvedValueOnce([e11, e10]);

    let resolveClear!: (val: { nextId: number }) => void;
    const clearPromise = new Promise<{ nextId: number }>((resolve) => {
      resolveClear = resolve;
    });
    vi.mocked(historyService.clearHistory).mockReturnValueOnce(clearPromise);

    const { result } = renderHook(() => useHistory());

    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    const clearPromiseResult = result.current.clearAllHistory();

    await waitFor(() => {
      expect(result.current.isClearing).toBe(true);
    });

    // Event 12 arrives before backend clear completes
    const e12: HistoryEntry = {
      id: 12,
      timestampMs: 1200,
      url: "https://example.com/12",
      mediaType: "video",
      quality: "best",
      outputDirectory: "C:\\Downloads",
      status: "success",
    };
    act(() => {
      eventCallback?.(e12);
    });
    expect(result.current.entries.map((e) => e.id)).toEqual([12, 11, 10]);

    // Backend clear committed after 12 was written on backend, so barrier is 13
    await act(async () => {
      resolveClear({ nextId: 13 });
      await clearPromiseResult;
    });

    // Both old entries and 12 (< 13) are cleared
    expect(result.current.entries).toEqual([]);
  });

  it("D. clear failure leaves history unchanged", async () => {
    const e1: HistoryEntry = {
      id: 1,
      timestampMs: 1000,
      url: "https://example.com/1",
      mediaType: "video",
      quality: "best",
      outputDirectory: "C:\\Downloads",
      status: "success",
    };
    vi.mocked(historyService.getHistory).mockResolvedValueOnce([e1]);
    vi.mocked(historyService.clearHistory).mockRejectedValueOnce(
      new Error("Permission denied"),
    );

    const { result } = renderHook(() => useHistory());

    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });
    expect(result.current.entries.length).toBe(1);

    let success: boolean | undefined;
    await act(async () => {
      success = await result.current.clearAllHistory();
    });

    expect(success).toBe(false);
    expect(result.current.clearError).toBe("Permission denied");
    // Entries are untouched!
    expect(result.current.entries).toEqual([e1]);
  });

  it("E. subsequent live event after successful clear (clear nextId 20, event 20 arrives afterward -> 20 appears)", async () => {
    const e1: HistoryEntry = {
      id: 1,
      timestampMs: 1000,
      url: "https://example.com/1",
      mediaType: "video",
      quality: "best",
      outputDirectory: "C:\\Downloads",
      status: "success",
    };
    vi.mocked(historyService.getHistory).mockResolvedValueOnce([e1]);
    vi.mocked(historyService.clearHistory).mockResolvedValueOnce({ nextId: 20 });

    const { result } = renderHook(() => useHistory());

    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    await act(async () => {
      await result.current.clearAllHistory();
    });
    expect(result.current.entries).toEqual([]);

    // Event 20 arrives afterward
    const e20: HistoryEntry = {
      id: 20,
      timestampMs: 2000,
      url: "https://example.com/20",
      mediaType: "video",
      quality: "best",
      outputDirectory: "C:\\Downloads",
      status: "success",
      filename: "video20.mp4",
    };
    act(() => {
      eventCallback?.(e20);
    });

    expect(result.current.entries).toEqual([e20]);
  });

  it("10. late stale event after clear: delayed event 12 arriving after clear nextId 13 must NOT reappear", async () => {
    const e10: HistoryEntry = {
      id: 10,
      timestampMs: 1000,
      url: "https://example.com/10",
      mediaType: "video",
      quality: "best",
      outputDirectory: "C:\\Downloads",
      status: "success",
    };
    const e11: HistoryEntry = {
      id: 11,
      timestampMs: 1100,
      url: "https://example.com/11",
      mediaType: "video",
      quality: "best",
      outputDirectory: "C:\\Downloads",
      status: "success",
    };
    const e12: HistoryEntry = {
      id: 12,
      timestampMs: 1200,
      url: "https://example.com/12",
      mediaType: "video",
      quality: "best",
      outputDirectory: "C:\\Downloads",
      status: "success",
    };
    vi.mocked(historyService.getHistory).mockResolvedValueOnce([e12, e11, e10]);
    vi.mocked(historyService.clearHistory).mockResolvedValueOnce({ nextId: 13 });

    const { result } = renderHook(() => useHistory());

    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });
    expect(result.current.entries.length).toBe(3);

    // 1-3. User clears history, backend commits clear and returns nextId = 13
    await act(async () => {
      await result.current.clearAllHistory();
    });

    // 4. Frontend removes IDs < 13
    expect(result.current.entries).toEqual([]);

    // 5. Delayed history-entry-added ID 12 arrives
    act(() => {
      eventCallback?.(e12);
    });

    // 6. Must remain [] because 12 < 13 barrier
    expect(result.current.entries).toEqual([]);
  });

  it("11. new event after clear: event 13 arriving after clear nextId 13 is accepted (>= not >)", async () => {
    const e10: HistoryEntry = {
      id: 10,
      timestampMs: 1000,
      url: "https://example.com/10",
      mediaType: "video",
      quality: "best",
      outputDirectory: "C:\\Downloads",
      status: "success",
    };
    vi.mocked(historyService.getHistory).mockResolvedValueOnce([e10]);
    vi.mocked(historyService.clearHistory).mockResolvedValueOnce({ nextId: 13 });

    const { result } = renderHook(() => useHistory());

    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    await act(async () => {
      await result.current.clearAllHistory();
    });
    expect(result.current.entries).toEqual([]);

    // Fire event 13
    const e13: HistoryEntry = {
      id: 13,
      timestampMs: 1300,
      url: "https://example.com/13",
      mediaType: "video",
      quality: "best",
      outputDirectory: "C:\\Downloads",
      status: "success",
      filename: "video13.mp4",
    };
    act(() => {
      eventCallback?.(e13);
    });

    // ID 13 is >= 13 barrier, so accepted!
    expect(result.current.entries).toEqual([e13]);
  });

  it("12. stale getHistory load after clear: delayed getHistory response with old IDs is rejected by barrier", async () => {
    let resolveGetHistory!: (val: HistoryEntry[]) => void;
    const getHistoryPromise = new Promise<HistoryEntry[]>((resolve) => {
      resolveGetHistory = resolve;
    });
    vi.mocked(historyService.getHistory).mockReturnValueOnce(getHistoryPromise);
    vi.mocked(historyService.clearHistory).mockResolvedValueOnce({ nextId: 13 });

    const { result } = renderHook(() => useHistory());

    // 1. getHistory is in flight (status: loading)
    expect(result.current.status).toBe("loading");

    // 2-3. User clears history, clearHistory resolves with nextId = 13
    await act(async () => {
      await result.current.clearAllHistory();
    });

    // 4. Frontend barrier is now 13
    // 5. Delayed original getHistory finally resolves with old entries 10, 11, 12
    const oldEntries: HistoryEntry[] = [
      {
        id: 12,
        timestampMs: 1200,
        url: "https://example.com/12",
        mediaType: "video",
        outputDirectory: "C:\\",
        status: "success",
      },
      {
        id: 11,
        timestampMs: 1100,
        url: "https://example.com/11",
        mediaType: "video",
        outputDirectory: "C:\\",
        status: "success",
      },
      {
        id: 10,
        timestampMs: 1000,
        url: "https://example.com/10",
        mediaType: "video",
        outputDirectory: "C:\\",
        status: "success",
      },
    ];

    await act(async () => {
      resolveGetHistory(oldEntries);
    });

    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    // Entries stay [] - none of 10, 11, 12 may reappear!
    expect(result.current.entries).toEqual([]);
  });

  it("13. mixed stale/fresh load: getHistory returning [10, 11, 12, 13, 14] with barrier 13 keeps only [14, 13]", async () => {
    vi.mocked(historyService.getHistory).mockResolvedValueOnce([]);
    vi.mocked(historyService.clearHistory).mockResolvedValueOnce({ nextId: 13 });

    const { result } = renderHook(() => useHistory());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    // Set barrier to 13
    await act(async () => {
      await result.current.clearAllHistory();
    });
    expect(result.current.entries).toEqual([]);

    // Now reloadHistory returns mixed entries: 10, 11, 12, 13, 14
    const mixedEntries: HistoryEntry[] = [
      { id: 14, timestampMs: 1400, url: "https://14", mediaType: "video", outputDirectory: "C:\\", status: "success" },
      { id: 13, timestampMs: 1300, url: "https://13", mediaType: "video", outputDirectory: "C:\\", status: "success" },
      { id: 12, timestampMs: 1200, url: "https://12", mediaType: "video", outputDirectory: "C:\\", status: "success" },
      { id: 11, timestampMs: 1100, url: "https://11", mediaType: "video", outputDirectory: "C:\\", status: "success" },
      { id: 10, timestampMs: 1000, url: "https://10", mediaType: "video", outputDirectory: "C:\\", status: "success" },
    ];
    vi.mocked(historyService.getHistory).mockResolvedValueOnce(mixedEntries);

    await act(async () => {
      await result.current.reloadHistory();
    });

    // Only 14 and 13 remain, newest first
    expect(result.current.entries.map((e) => e.id)).toEqual([14, 13]);
  });

  it("14. multiple clears: barrier advances monotonically across multiple clears", async () => {
    const e10: HistoryEntry = { id: 10, timestampMs: 1000, url: "https://10", mediaType: "video", outputDirectory: "C:\\", status: "success" };
    const e11: HistoryEntry = { id: 11, timestampMs: 1100, url: "https://11", mediaType: "video", outputDirectory: "C:\\", status: "success" };
    vi.mocked(historyService.getHistory).mockResolvedValueOnce([e11, e10]);
    vi.mocked(historyService.clearHistory).mockResolvedValueOnce({ nextId: 12 });

    const { result } = renderHook(() => useHistory());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    // First clear: nextId 12
    await act(async () => {
      await result.current.clearAllHistory();
    });
    expect(result.current.entries).toEqual([]);

    // Events 12 and 13 arrive
    const e12: HistoryEntry = { id: 12, timestampMs: 1200, url: "https://12", mediaType: "video", outputDirectory: "C:\\", status: "success" };
    const e13: HistoryEntry = { id: 13, timestampMs: 1300, url: "https://13", mediaType: "video", outputDirectory: "C:\\", status: "success" };
    act(() => {
      eventCallback?.(e12);
      eventCallback?.(e13);
    });
    expect(result.current.entries.map((e) => e.id)).toEqual([13, 12]);

    // Second clear: nextId 14
    vi.mocked(historyService.clearHistory).mockResolvedValueOnce({ nextId: 14 });
    await act(async () => {
      await result.current.clearAllHistory();
    });
    expect(result.current.entries).toEqual([]);

    // Stale event 13 arrives -> ignored (< 14)
    act(() => {
      eventCallback?.(e13);
    });
    expect(result.current.entries).toEqual([]);

    // New event 14 arrives -> accepted (>= 14)
    const e14: HistoryEntry = { id: 14, timestampMs: 1400, url: "https://14", mediaType: "video", outputDirectory: "C:\\", status: "success" };
    act(() => {
      eventCallback?.(e14);
    });
    expect(result.current.entries.map((e) => e.id)).toEqual([14]);
  });

  it("15. clear failure does not advance barrier or block subsequent valid events", async () => {
    const e5: HistoryEntry = { id: 5, timestampMs: 500, url: "https://5", mediaType: "video", outputDirectory: "C:\\", status: "success" };
    vi.mocked(historyService.getHistory).mockResolvedValueOnce([e5]);
    vi.mocked(historyService.clearHistory).mockRejectedValueOnce(new Error("Disk locked"));

    const { result } = renderHook(() => useHistory());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      const ok = await result.current.clearAllHistory();
      expect(ok).toBe(false);
    });

    // Entries unchanged
    expect(result.current.entries).toEqual([e5]);
    expect(result.current.clearError).toBe("Disk locked");

    // Live event 6 arrives; since barrier did NOT advance to some hypothetical value, event 6 is accepted
    const e6: HistoryEntry = { id: 6, timestampMs: 600, url: "https://6", mediaType: "video", outputDirectory: "C:\\", status: "success" };
    act(() => {
      eventCallback?.(e6);
    });
    expect(result.current.entries.map((e) => e.id)).toEqual([6, 5]);
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
