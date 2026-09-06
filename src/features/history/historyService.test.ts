import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearHistory,
  getHistory,
  HISTORY_ENTRY_ADDED_EVENT,
  subscribeToHistoryEvents,
} from "./historyService";
import { invoke } from "@tauri-apps/api/core";
import type { HistoryEntry } from "./types";

const { mockListen } = vi.hoisted(() => ({
  mockListen: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({ listen: mockListen }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const mockInvoke = vi.mocked(invoke);

beforeEach(() => {
  mockListen.mockReset();
  mockInvoke.mockReset();
});

describe("historyService", () => {
  it("getHistory invokes get_history command", async () => {
    const mockEntries: HistoryEntry[] = [
      {
        id: 1,
        timestampMs: 123456789,
        url: "https://example.com/watch?v=1",
        mediaType: "video",
        quality: "1080",
        audioFormat: null,
        outputDirectory: "C:\\Downloads",
        status: "success",
        filename: "test.mp4",
        filepath: "C:\\Downloads\\test.mp4",
        message: null,
      },
    ];
    mockInvoke.mockResolvedValueOnce(mockEntries);

    const result = await getHistory();
    expect(mockInvoke).toHaveBeenCalledWith("get_history");
    expect(result).toEqual(mockEntries);
  });

  it("clearHistory invokes clear_history command", async () => {
    mockInvoke.mockResolvedValueOnce(undefined);

    await clearHistory();
    expect(mockInvoke).toHaveBeenCalledWith("clear_history");
  });

  it("subscribeToHistoryEvents listens for history-entry-added event", async () => {
    const unlistenFn = vi.fn();
    mockListen.mockResolvedValueOnce(unlistenFn);

    const onEntryAdded = vi.fn();
    const result = await subscribeToHistoryEvents(onEntryAdded);

    expect(mockListen).toHaveBeenCalledWith(
      HISTORY_ENTRY_ADDED_EVENT,
      expect.any(Function),
    );
    expect(result).toBe(unlistenFn);

    // Trigger handler
    const handler = mockListen.mock.calls[0][1];
    const newEntry: HistoryEntry = {
      id: 2,
      timestampMs: 123456790,
      url: "https://example.com/watch?v=2",
      mediaType: "audio",
      quality: null,
      audioFormat: "mp3",
      outputDirectory: "C:\\Music",
      status: "error",
      filename: null,
      filepath: null,
      message: "Network error",
    };
    handler({ payload: newEntry });
    expect(onEntryAdded).toHaveBeenCalledWith(newEntry);
  });
});
