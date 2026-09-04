import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DOWNLOAD_COMPLETE_EVENT,
  DOWNLOAD_ERROR_EVENT,
  DOWNLOAD_PROGRESS_EVENT,
  subscribeToDownloadEvents,
} from "./downloadService";

const { mockListen } = vi.hoisted(() => ({
  mockListen: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({ listen: mockListen }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const handlers = {
  onProgress: vi.fn(),
  onComplete: vi.fn(),
  onError: vi.fn(),
};

beforeEach(() => {
  mockListen.mockReset();
  handlers.onProgress.mockClear();
  handlers.onComplete.mockClear();
  handlers.onError.mockClear();
});

describe("subscribeToDownloadEvents", () => {
  it("rolls back the first listener when the second registration fails", async () => {
    const unlistenProgress = vi.fn();
    mockListen
      .mockResolvedValueOnce(unlistenProgress)
      .mockRejectedValueOnce(new Error("complete listen failed"));

    await expect(subscribeToDownloadEvents(handlers)).rejects.toThrow(
      "complete listen failed",
    );
    expect(unlistenProgress).toHaveBeenCalledTimes(1);
    expect(mockListen).toHaveBeenCalledTimes(2);
    expect(mockListen).toHaveBeenNthCalledWith(
      1,
      DOWNLOAD_PROGRESS_EVENT,
      expect.any(Function),
    );
    expect(mockListen).toHaveBeenNthCalledWith(
      2,
      DOWNLOAD_COMPLETE_EVENT,
      expect.any(Function),
    );
  });

  it("rolls back the first two listeners when the third registration fails", async () => {
    const unlistenProgress = vi.fn();
    const unlistenComplete = vi.fn();
    mockListen
      .mockResolvedValueOnce(unlistenProgress)
      .mockResolvedValueOnce(unlistenComplete)
      .mockRejectedValueOnce(new Error("error listen failed"));

    await expect(subscribeToDownloadEvents(handlers)).rejects.toThrow(
      "error listen failed",
    );
    expect(unlistenProgress).toHaveBeenCalledTimes(1);
    expect(unlistenComplete).toHaveBeenCalledTimes(1);
    expect(mockListen).toHaveBeenNthCalledWith(
      3,
      DOWNLOAD_ERROR_EVENT,
      expect.any(Function),
    );
  });

  it("unregisters all three listeners on cleanup", async () => {
    const unlistens = [vi.fn(), vi.fn(), vi.fn()];
    mockListen
      .mockResolvedValueOnce(unlistens[0])
      .mockResolvedValueOnce(unlistens[1])
      .mockResolvedValueOnce(unlistens[2]);

    const cleanup = await subscribeToDownloadEvents(handlers);
    for (const unlisten of unlistens) {
      expect(unlisten).not.toHaveBeenCalled();
    }

    cleanup();
    for (const unlisten of unlistens) {
      expect(unlisten).toHaveBeenCalledTimes(1);
    }
  });

  it("cleanup is idempotent", async () => {
    const unlistens = [vi.fn(), vi.fn(), vi.fn()];
    mockListen
      .mockResolvedValueOnce(unlistens[0])
      .mockResolvedValueOnce(unlistens[1])
      .mockResolvedValueOnce(unlistens[2]);

    const cleanup = await subscribeToDownloadEvents(handlers);
    cleanup();
    cleanup();
    for (const unlisten of unlistens) {
      expect(unlisten).toHaveBeenCalledTimes(1);
    }
  });
});
