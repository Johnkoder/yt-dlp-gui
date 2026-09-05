/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDownloadQueue } from "./useDownloadQueue";
import type { DownloadRequest } from "../options";

const { mockInvoke, mockListen } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockListen: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mockListen }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

type Handler = (payload: never) => void;

const TEST_DIR = "C:\\Users\\Test\\Downloads";

/** Listeners that resolve and stay invokable, with routing invokes. */
function setupActive(nextJobId: { value: number }) {
  const handlers = new Map<string, Handler>();
  mockListen.mockImplementation((event: string, handler: Handler) => {
    handlers.set(event, handler);
    return Promise.resolve(vi.fn());
  });
  mockInvoke.mockImplementation((command: string, args?: unknown) => {
    if (command === "get_downloads_dir") {
      return Promise.resolve(TEST_DIR);
    }
    if (command === "validate_output_directory") {
      return Promise.resolve((args as { path: string }).path);
    }
    if (command === "enqueue_download") {
      const jobId = nextJobId.value;
      nextJobId.value += 1;
      return Promise.resolve({ jobId });
    }
    if (command === "cancel_job") {
      return Promise.resolve("cancelling");
    }
    return Promise.resolve(undefined);
  });
  return handlers;
}

function fire<T>(handlers: Map<string, Handler>, event: string, payload: T) {
  return act(async () => {
    handlers.get(event)?.({ payload } as never);
  });
}

beforeEach(() => {
  mockInvoke.mockReset();
  mockListen.mockReset();
  window.localStorage.clear();
});

describe("useDownloadQueue", () => {
  it("initializes to ready with no jobs", async () => {
    setupActive({ value: 1 });
    const { result } = renderHook(() => useDownloadQueue());

    expect(result.current.initStatus).toBe("initializing");
    expect(result.current.jobs).toHaveLength(0);
    await act(async () => {});
    expect(result.current.initStatus).toBe("ready");
    expect(result.current.outputDirectory).toBe(TEST_DIR);
    expect(result.current.canEnqueue).toBe(false);
  });

  it("enqueue snapshots the draft and clears only the URL", async () => {
    setupActive({ value: 1 });
    const { result } = renderHook(() => useDownloadQueue());
    await act(async () => {});

    act(() => {
      result.current.setUrl("https://example.com/a");
      result.current.setMediaType("audio");
      result.current.setQuality("720");
      result.current.setAudioFormat("mp3");
    });
    await act(async () => {
      await result.current.enqueueCurrentDraft();
    });

    expect(result.current.jobs).toHaveLength(1);
    const job = result.current.jobs[0];
    expect(job.id).toBe(1);
    expect(job.status).toBe("queued");
    const request = job.request as DownloadRequest;
    expect(request.url).toBe("https://example.com/a");
    expect(request.mediaType).toBe("audio");
    expect(request.quality).toBeNull();
    expect(request.audioFormat).toBe("mp3");
    expect(request.outputDirectory).toBe(TEST_DIR);
    // URL cleared for next entry; selections preserved.
    expect(result.current.url).toBe("");
    expect(result.current.mediaType).toBe("audio");
    expect(result.current.audioFormat).toBe("mp3");
  });

  it("draft edits after enqueue never mutate the queued snapshot", async () => {
    setupActive({ value: 1 });
    const { result } = renderHook(() => useDownloadQueue());
    await act(async () => {});

    act(() => {
      result.current.setUrl("https://example.com/a");
      result.current.setOutputDirectory("D:\\Videos");
    });
    expect(result.current.outputDirectory).toBe("D:\\Videos");
    await act(async () => {
      await result.current.enqueueCurrentDraft();
    });
    act(() => {
      result.current.setUrl("https://example.com/b");
      result.current.setMediaType("audio");
      result.current.setOutputDirectory("E:\\Music");
    });

    const job = result.current.jobs[0];
    const request = job.request as DownloadRequest;
    expect(request.url).toBe("https://example.com/a");
    expect(request.mediaType).toBe("video");
    expect(request.outputDirectory).toBe("D:\\Videos");
  });

  it("started event marks the job downloading", async () => {
    const handlers = setupActive({ value: 1 });
    const { result } = renderHook(() => useDownloadQueue());
    await act(async () => {});

    act(() => {
      result.current.setUrl("https://example.com/a");
    });
    await act(async () => {
      await result.current.enqueueCurrentDraft();
    });
    await fire(handlers, "download-started", { jobId: 1 });
    expect(result.current.jobs[0].status).toBe("downloading");
  });

  it("started-before-response upserts without regressing", async () => {
    // The worker emits download-started before enqueue_download resolves.
    let resolveEnqueue!: (value: unknown) => void;
    const handlers = new Map<string, Handler>();
    mockListen.mockImplementation((event: string, handler: Handler) => {
      handlers.set(event, handler);
      return Promise.resolve(vi.fn());
    });
    mockInvoke.mockImplementation((command: string) => {
      if (command === "get_downloads_dir") {
        return Promise.resolve(TEST_DIR);
      }
      if (command === "enqueue_download") {
        return new Promise((resolve) => {
          resolveEnqueue = resolve;
        });
      }
      return Promise.resolve(undefined);
    });
    const { result } = renderHook(() => useDownloadQueue());
    await act(async () => {});

    act(() => {
      result.current.setUrl("https://example.com/a");
    });
    let enqueuePromise!: Promise<void>;
    act(() => {
      enqueuePromise = result.current.enqueueCurrentDraft();
    });
    // Started lands first: placeholder row becomes downloading.
    await fire(handlers, "download-started", { jobId: 42 });
    expect(result.current.jobs).toHaveLength(1);
    expect(result.current.jobs[0].id).toBe(42);
    expect(result.current.jobs[0].status).toBe("downloading");
    expect(result.current.jobs[0].request?.url).toBe(
      "https://example.com/a",
    );

    // Response arrives later: snapshot merges, status stays downloading.
    await act(async () => {
      resolveEnqueue({ jobId: 42 });
      await enqueuePromise;
    });
    expect(result.current.jobs).toHaveLength(1);
    const job = result.current.jobs[0];
    expect(job.id).toBe(42);
    expect(job.status).toBe("downloading");
    expect((job.request as DownloadRequest).url).toBe(
      "https://example.com/a",
    );
  });

  it("progress routes to the matching job only", async () => {
    const handlers = setupActive({ value: 1 });
    const { result } = renderHook(() => useDownloadQueue());
    await act(async () => {});

    for (const url of ["https://example.com/a", "https://example.com/b"]) {
      act(() => {
        result.current.setUrl(url);
      });
      await act(async () => {
        await result.current.enqueueCurrentDraft();
      });
    }
    await fire(handlers, "download-started", { jobId: 1 });
    await fire(handlers, "download-started", { jobId: 2 });
    await fire(handlers, "download-progress", {
      jobId: 1,
      status: "Downloading",
      percentage: 64,
    });

    const [first, second] = result.current.jobs;
    expect(first.progress?.percentage).toBe(64);
    expect(second.progress).toBeNull();
    expect(second.status).toBe("downloading");
  });

  it("late progress after terminal states is ignored", async () => {
    const handlers = setupActive({ value: 1 });
    const { result } = renderHook(() => useDownloadQueue());
    await act(async () => {});

    act(() => {
      result.current.setUrl("https://example.com/a");
    });
    await act(async () => {
      await result.current.enqueueCurrentDraft();
    });
    await fire(handlers, "download-started", { jobId: 1 });
    await fire(handlers, "download-complete", {
      jobId: 1,
      filename: "a.mp4",
      filepath: "C:\\dl\\a.mp4",
      outputDir: TEST_DIR,
    });
    await fire(handlers, "download-progress", {
      jobId: 1,
      status: "Downloading",
      percentage: 10,
    });

    const job = result.current.jobs[0];
    expect(job.status).toBe("success");
    expect(job.progress).toBeNull();
  });

  it("completion and error update only their own job", async () => {
    const handlers = setupActive({ value: 1 });
    const { result } = renderHook(() => useDownloadQueue());
    await act(async () => {});

    for (const url of ["https://example.com/a", "https://example.com/b"]) {
      act(() => {
        result.current.setUrl(url);
      });
      await act(async () => {
        await result.current.enqueueCurrentDraft();
      });
    }
    await fire(handlers, "download-started", { jobId: 1 });
    await fire(handlers, "download-complete", {
      jobId: 1,
      filename: "a.mp4",
      filepath: "C:\\dl\\a.mp4",
      outputDir: TEST_DIR,
    });
    await fire(handlers, "download-error", {
      jobId: 2,
      message: "boom",
      details: "boom details",
    });

    const [first, second] = result.current.jobs;
    expect(first.status).toBe("success");
    expect(first.result?.filename).toBe("a.mp4");
    expect(second.status).toBe("error");
    expect(second.errorMessage).toBe("boom");
    expect(second.result).toBeNull();
  });

  it("cancel waiting removes the row on the removed outcome", async () => {
    mockInvoke.mockImplementation((command: string, args?: unknown) => {
      if (command === "get_downloads_dir") {
        return Promise.resolve(TEST_DIR);
      }
      if (command === "validate_output_directory") {
        return Promise.resolve((args as { path: string }).path);
      }
      if (command === "enqueue_download") {
        return Promise.resolve({ jobId: 1 });
      }
      if (command === "cancel_job") {
        return Promise.resolve("removed");
      }
      return Promise.resolve(undefined);
    });
    const handlers = new Map<string, Handler>();
    mockListen.mockImplementation((event: string, handler: Handler) => {
      handlers.set(event, handler);
      return Promise.resolve(vi.fn());
    });
    const { result } = renderHook(() => useDownloadQueue());
    await act(async () => {});

    act(() => {
      result.current.setUrl("https://example.com/a");
    });
    await act(async () => {
      await result.current.enqueueCurrentDraft();
    });
    expect(result.current.jobs[0].status).toBe("queued");

    await act(async () => {
      await result.current.handleJobCancel(1);
    });
    // Response marked it; the event is a harmless no-op afterwards.
    expect(result.current.jobs[0].status).toBe("cancelled");
    await fire(handlers, "download-cancelled", {
      jobId: 1,
      message: "Removed from queue.",
    });
    expect(result.current.jobs[0].status).toBe("cancelled");
    expect(mockInvoke).toHaveBeenCalledWith("cancel_job", { jobId: 1 });
  });

  it("cancel active flows cancelling then cancelled", async () => {
    const handlers = setupActive({ value: 1 });
    const { result } = renderHook(() => useDownloadQueue());
    await act(async () => {});

    act(() => {
      result.current.setUrl("https://example.com/a");
    });
    await act(async () => {
      await result.current.enqueueCurrentDraft();
    });
    await fire(handlers, "download-started", { jobId: 1 });
    await act(async () => {
      await result.current.handleJobCancel(1);
    });
    expect(result.current.jobs[0].status).toBe("cancelling");
    expect(mockInvoke).toHaveBeenCalledWith("cancel_job", { jobId: 1 });

    await fire(handlers, "download-cancelled", {
      jobId: 1,
      message: "Download cancelled.",
    });
    expect(result.current.jobs[0].status).toBe("cancelled");
  });

  it("double submit while IPC pending enqueues only once", async () => {
    let resolveEnqueue!: (value: unknown) => void;
    mockListen.mockImplementation(() => Promise.resolve(vi.fn()));
    mockInvoke.mockImplementation((command: string) => {
      if (command === "get_downloads_dir") {
        return Promise.resolve(TEST_DIR);
      }
      if (command === "enqueue_download") {
        return new Promise((resolve) => {
          resolveEnqueue = resolve;
        });
      }
      return Promise.resolve(undefined);
    });
    const { result } = renderHook(() => useDownloadQueue());
    await act(async () => {});

    act(() => {
      result.current.setUrl("https://example.com/a");
    });
    act(() => {
      void result.current.enqueueCurrentDraft();
      void result.current.enqueueCurrentDraft();
    });
    await act(async () => {
      resolveEnqueue({ jobId: 1 });
    });
    await act(async () => {});

    expect(result.current.jobs).toHaveLength(1);
  });

  it("same URL can be queued again after resolve", async () => {
    setupActive({ value: 1 });
    const { result } = renderHook(() => useDownloadQueue());
    await act(async () => {});

    for (let round = 0; round < 2; round += 1) {
      act(() => {
        result.current.setUrl("https://example.com/a");
      });
      await act(async () => {
        await result.current.enqueueCurrentDraft();
      });
    }
    expect(result.current.jobs).toHaveLength(2);
    expect(result.current.jobs[0].id).not.toBe(result.current.jobs[1].id);
  });

  it("enqueue failure surfaces without creating a job", async () => {
    mockListen.mockImplementation(() => Promise.resolve(vi.fn()));
    mockInvoke.mockImplementation((command: string) => {
      if (command === "get_downloads_dir") {
        return Promise.resolve(TEST_DIR);
      }
      if (command === "enqueue_download") {
        return Promise.reject(new Error("yt-dlp is required"));
      }
      return Promise.resolve(undefined);
    });
    const { result } = renderHook(() => useDownloadQueue());
    await act(async () => {});

    act(() => {
      result.current.setUrl("https://example.com/a");
    });
    await act(async () => {
      await result.current.enqueueCurrentDraft();
    });
    expect(result.current.jobs).toHaveLength(0);
    expect(result.current.enqueueError).toMatch(/yt-dlp is required/);
    // URL preserved for correction and retry.
    expect(result.current.url).toBe("https://example.com/a");
  });
});
