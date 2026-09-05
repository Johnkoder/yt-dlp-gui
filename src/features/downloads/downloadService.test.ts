import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DOWNLOAD_CANCELLED_EVENT,
  DOWNLOAD_COMPLETE_EVENT,
  DOWNLOAD_ERROR_EVENT,
  DOWNLOAD_PROGRESS_EVENT,
  DOWNLOAD_STARTED_EVENT,
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
  onStarted: vi.fn(),
  onProgress: vi.fn(),
  onComplete: vi.fn(),
  onError: vi.fn(),
  onCancelled: vi.fn(),
};

beforeEach(() => {
  mockListen.mockReset();
  handlers.onStarted.mockClear();
  handlers.onProgress.mockClear();
  handlers.onComplete.mockClear();
  handlers.onError.mockClear();
  handlers.onCancelled.mockClear();
});

describe("subscribeToDownloadEvents", () => {
  it("registers listeners in order, started first", async () => {
    const unlistens = [vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn()];
    mockListen
      .mockResolvedValueOnce(unlistens[0])
      .mockResolvedValueOnce(unlistens[1])
      .mockResolvedValueOnce(unlistens[2])
      .mockResolvedValueOnce(unlistens[3])
      .mockResolvedValueOnce(unlistens[4]);

    await subscribeToDownloadEvents(handlers);
    expect(mockListen).toHaveBeenNthCalledWith(
      1,
      DOWNLOAD_STARTED_EVENT,
      expect.any(Function),
    );
    expect(mockListen).toHaveBeenNthCalledWith(
      2,
      DOWNLOAD_PROGRESS_EVENT,
      expect.any(Function),
    );
    expect(mockListen).toHaveBeenNthCalledWith(
      3,
      DOWNLOAD_COMPLETE_EVENT,
      expect.any(Function),
    );
    expect(mockListen).toHaveBeenNthCalledWith(
      4,
      DOWNLOAD_ERROR_EVENT,
      expect.any(Function),
    );
    expect(mockListen).toHaveBeenNthCalledWith(
      5,
      DOWNLOAD_CANCELLED_EVENT,
      expect.any(Function),
    );
  });

  it("rolls back the first listener when the second registration fails", async () => {
    const unlistenStarted = vi.fn();
    mockListen
      .mockResolvedValueOnce(unlistenStarted)
      .mockRejectedValueOnce(new Error("progress listen failed"));

    await expect(subscribeToDownloadEvents(handlers)).rejects.toThrow(
      "progress listen failed",
    );
    expect(unlistenStarted).toHaveBeenCalledTimes(1);
    expect(mockListen).toHaveBeenCalledTimes(2);
  });

  it("rolls back listeners when a middle registration fails", async () => {
    const unlistens = [vi.fn(), vi.fn()];
    mockListen
      .mockResolvedValueOnce(unlistens[0])
      .mockResolvedValueOnce(unlistens[1])
      .mockRejectedValueOnce(new Error("error listen failed"));

    await expect(subscribeToDownloadEvents(handlers)).rejects.toThrow(
      "error listen failed",
    );
    for (const unlisten of unlistens) {
      expect(unlisten).toHaveBeenCalledTimes(1);
    }
  });

  it("rolls back all four listeners when the fifth fails", async () => {
    const unlistens = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
    mockListen
      .mockResolvedValueOnce(unlistens[0])
      .mockResolvedValueOnce(unlistens[1])
      .mockResolvedValueOnce(unlistens[2])
      .mockResolvedValueOnce(unlistens[3])
      .mockRejectedValueOnce(new Error("cancelled listen failed"));

    await expect(subscribeToDownloadEvents(handlers)).rejects.toThrow(
      "cancelled listen failed",
    );
    for (const unlisten of unlistens) {
      expect(unlisten).toHaveBeenCalledTimes(1);
    }
    expect(mockListen).toHaveBeenNthCalledWith(
      5,
      DOWNLOAD_CANCELLED_EVENT,
      expect.any(Function),
    );
  });

  it("unregisters all five listeners on cleanup", async () => {
    const unlistens = [vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn()];
    mockListen
      .mockResolvedValueOnce(unlistens[0])
      .mockResolvedValueOnce(unlistens[1])
      .mockResolvedValueOnce(unlistens[2])
      .mockResolvedValueOnce(unlistens[3])
      .mockResolvedValueOnce(unlistens[4]);

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
    const unlistens = [vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn()];
    mockListen
      .mockResolvedValueOnce(unlistens[0])
      .mockResolvedValueOnce(unlistens[1])
      .mockResolvedValueOnce(unlistens[2])
      .mockResolvedValueOnce(unlistens[3])
      .mockResolvedValueOnce(unlistens[4]);

    const cleanup = await subscribeToDownloadEvents(handlers);
    cleanup();
    cleanup();
    for (const unlisten of unlistens) {
      expect(unlisten).toHaveBeenCalledTimes(1);
    }
  });
});
