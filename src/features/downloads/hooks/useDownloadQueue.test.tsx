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
    if (command === "enqueue_playlist") {
      const id1 = nextJobId.value++;
      const id2 = nextJobId.value++;
      const id3 = nextJobId.value++;
      return Promise.resolve({
        items: [
          { jobId: id1, url: "https://example.com/watch?v=A", title: "A" },
          { jobId: id2, url: "https://example.com/watch?v=B", title: "B" },
          { jobId: id3, url: "https://example.com/watch?v=C", title: "C" },
        ],
        skippedCount: 0,
      });
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

  it("unrelated start keeps the pending snapshot for its own job", async () => {
    // Race B: Job 1 downloading, Job 2 queued, Job 3 enqueue in flight.
    // Job 1 finishes and Job 2 starts BEFORE Job 3's response resolves.
    // Job 2's started event must not consume Job 3's pending snapshot.
    let resolveEnqueue!: (value: unknown) => void;
    const handlers = new Map<string, Handler>();
    mockListen.mockImplementation((event: string, handler: Handler) => {
      handlers.set(event, handler);
      return Promise.resolve(vi.fn());
    });
    let nextJobId = 1;
    mockInvoke.mockImplementation((command: string) => {
      if (command === "get_downloads_dir") {
        return Promise.resolve(TEST_DIR);
      }
      if (command === "enqueue_download") {
        // First two enqueues resolve immediately; the third stays pending.
        if (nextJobId < 3) {
          const jobId = nextJobId;
          nextJobId += 1;
          return Promise.resolve({ jobId });
        }
        return new Promise((resolve) => {
          resolveEnqueue = resolve;
        });
      }
      return Promise.resolve(undefined);
    });
    const { result } = renderHook(() => useDownloadQueue());
    await act(async () => {});

    // Enqueue Job 1 and Job 2 (resolve at once).
    act(() => {
      result.current.setUrl("https://example.com/job-1");
    });
    await act(async () => {
      await result.current.enqueueCurrentDraft();
    });
    act(() => {
      result.current.setUrl("https://example.com/job-2");
    });
    await act(async () => {
      await result.current.enqueueCurrentDraft();
    });
    await fire(handlers, "download-started", { jobId: 1 });
    expect(result.current.jobs[0].status).toBe("downloading");
    expect(result.current.jobs[1].status).toBe("queued");

    // Start enqueueing Job 3 with unique values; keep it unresolved.
    act(() => {
      result.current.setUrl("https://example.com/job-3");
      result.current.setMediaType("audio");
      result.current.setAudioFormat("mp3");
      result.current.setOutputDirectory("D:\\Job 3 Music");
    });
    let enqueuePromise!: Promise<void>;
    act(() => {
      enqueuePromise = result.current.enqueueCurrentDraft();
    });

    // Job 1 finishes and Job 2 starts before Job 3's response.
    await fire(handlers, "download-started", { jobId: 2 });
    expect(result.current.jobs[1].status).toBe("downloading");

    // Now resolve Job 3's enqueue response.
    await act(async () => {
      resolveEnqueue({ jobId: 3 });
      await enqueuePromise;
    });

    // No duplicate rows; IDs stay in order.
    const jobs = result.current.jobs;
    expect(jobs.map((job) => job.id)).toEqual([1, 2, 3]);
    // Job 2 did NOT receive Job 3's snapshot (it keeps its own).
    expect(jobs[1].request?.url).toBe("https://example.com/job-2");
    // Job 3 exists exactly once with its full snapshot intact.
    const job3 = jobs[2];
    expect(job3.status).toBe("queued");
    expect(job3.request).not.toBeNull();
    expect(job3.request?.url).toBe("https://example.com/job-3");
    expect(job3.request?.mediaType).toBe("audio");
    expect(job3.request?.audioFormat).toBe("mp3");
    expect(job3.request?.quality).toBeNull();
    expect(job3.request?.outputDirectory).toBe("D:\\Job 3 Music");
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

  it("defaults scope to single", async () => {
    setupActive({ value: 1 });
    const { result } = renderHook(() => useDownloadQueue());
    await act(async () => {});

    expect(result.current.scope).toBe("single");
  });

  it("playlist request invokes enqueue_playlist and NOT enqueue_download", async () => {
    setupActive({ value: 1 });
    const { result } = renderHook(() => useDownloadQueue());
    await act(async () => {});

    act(() => {
      result.current.setScope("playlist");
      result.current.setUrl("https://example.com/playlist?list=XYZ");
      result.current.setMediaType("video");
      result.current.setQuality("1080");
    });
    await act(async () => {
      await result.current.enqueueCurrentDraft();
    });

    expect(mockInvoke).toHaveBeenCalledWith("enqueue_playlist", expect.anything());
    expect(mockInvoke).not.toHaveBeenCalledWith("enqueue_download", expect.anything());
  });

  it("single request invokes enqueue_download and NOT enqueue_playlist", async () => {
    setupActive({ value: 1 });
    const { result } = renderHook(() => useDownloadQueue());
    await act(async () => {});

    act(() => {
      result.current.setScope("single");
      result.current.setUrl("https://example.com/watch?v=ABC&list=XYZ");
    });
    await act(async () => {
      await result.current.enqueueCurrentDraft();
    });

    expect(mockInvoke).toHaveBeenCalledWith("enqueue_download", expect.anything());
    expect(mockInvoke).not.toHaveBeenCalledWith("enqueue_playlist", expect.anything());
  });

  it("playlist response creates jobs in order inheriting common options with individual URLs", async () => {
    setupActive({ value: 10 });
    const { result } = renderHook(() => useDownloadQueue());
    await act(async () => {});

    act(() => {
      result.current.setScope("playlist");
      result.current.setUrl("https://example.com/playlist?list=XYZ");
      result.current.setMediaType("video");
      result.current.setQuality("720");
    });
    await act(async () => {
      await result.current.enqueueCurrentDraft();
    });

    expect(result.current.jobs).toHaveLength(3);
    const [j1, j2, j3] = result.current.jobs;
    expect(j1.id).toBe(10);
    expect(j1.request?.url).toBe("https://example.com/watch?v=A");
    expect(j1.request?.quality).toBe("720");
    expect(j1.status).toBe("queued");

    expect(j2.id).toBe(11);
    expect(j2.request?.url).toBe("https://example.com/watch?v=B");
    expect(j2.request?.quality).toBe("720");

    expect(j3.id).toBe(12);
    expect(j3.request?.url).toBe("https://example.com/watch?v=C");
    expect(j3.request?.quality).toBe("720");

    expect(result.current.enqueueNotice).toMatch(/Added 3 playlist items to the queue/);
    expect(result.current.url).toBe("");
  });

  it("playlist event before response race merges in place without status regression", async () => {
    let resolvePlaylist!: (val: unknown) => void;
    const playlistPromise = new Promise((resolve) => {
      resolvePlaylist = resolve;
    });
    const handlers = setupActive({ value: 10 });
    mockInvoke.mockImplementation((command: string) => {
      if (command === "get_downloads_dir") return Promise.resolve(TEST_DIR);
      if (command === "enqueue_playlist") return playlistPromise;
      return Promise.resolve(undefined);
    });

    const { result } = renderHook(() => useDownloadQueue());
    await act(async () => {});

    act(() => {
      result.current.setScope("playlist");
      result.current.setUrl("https://example.com/playlist?list=XYZ");
      result.current.setMediaType("video");
      result.current.setQuality("1080");
    });

    let submitPromise!: Promise<void>;
    act(() => {
      submitPromise = result.current.enqueueCurrentDraft();
    });

    // Event for job 10 arrives BEFORE playlist response
    await fire(handlers, "download-started", { jobId: 10 });
    expect(result.current.jobs).toHaveLength(1);
    expect(result.current.jobs[0].id).toBe(10);
    expect(result.current.jobs[0].status).toBe("downloading");
    expect(result.current.jobs[0].request).toBeNull();

    // Now resolve playlist response
    await act(async () => {
      resolvePlaylist({
        items: [
          { jobId: 10, url: "https://example.com/watch?v=A" },
          { jobId: 11, url: "https://example.com/watch?v=B" },
          { jobId: 12, url: "https://example.com/watch?v=C" },
        ],
        skippedCount: 0,
      });
      await submitPromise;
    });

    expect(result.current.jobs).toHaveLength(3);
    // Job 10 remains downloading and received its request snapshot!
    expect(result.current.jobs[0].id).toBe(10);
    expect(result.current.jobs[0].status).toBe("downloading");
    expect(result.current.jobs[0].request?.url).toBe("https://example.com/watch?v=A");
    expect(result.current.jobs[0].request?.quality).toBe("1080");

    // Jobs 11 and 12 are queued
    expect(result.current.jobs[1].id).toBe(11);
    expect(result.current.jobs[1].status).toBe("queued");
    expect(result.current.jobs[1].request?.url).toBe("https://example.com/watch?v=B");

    expect(result.current.jobs[2].id).toBe(12);
    expect(result.current.jobs[2].status).toBe("queued");
    expect(result.current.jobs[2].request?.url).toBe("https://example.com/watch?v=C");
  });

  it("mixed queue race: active single job does not steal or corrupt playlist state", async () => {
    let resolvePlaylist!: (val: unknown) => void;
    const playlistPromise = new Promise((resolve) => {
      resolvePlaylist = resolve;
    });
    const handlers = setupActive({ value: 1 });
    mockInvoke.mockImplementation((command: string) => {
      if (command === "get_downloads_dir") return Promise.resolve(TEST_DIR);
      if (command === "enqueue_download") return Promise.resolve({ jobId: 1 });
      if (command === "enqueue_playlist") return playlistPromise;
      return Promise.resolve(undefined);
    });

    const { result } = renderHook(() => useDownloadQueue());
    await act(async () => {});

    // Enqueue single job 1
    act(() => {
      result.current.setUrl("https://example.com/single");
    });
    await act(async () => {
      await result.current.enqueueCurrentDraft();
    });
    expect(result.current.jobs).toHaveLength(1);
    expect(result.current.jobs[0].id).toBe(1);

    // Job 1 starts downloading
    await fire(handlers, "download-started", { jobId: 1 });
    expect(result.current.jobs[0].status).toBe("downloading");

    // Now submit playlist
    act(() => {
      result.current.setScope("playlist");
      result.current.setUrl("https://example.com/playlist?list=123");
    });
    let playlistSubmit!: Promise<void>;
    act(() => {
      playlistSubmit = result.current.enqueueCurrentDraft();
    });

    // While playlist is resolving, Job 1 finishes
    await fire(handlers, "download-complete", {
      jobId: 1,
      filename: "single.mp4",
      outputDir: TEST_DIR,
    });
    expect(result.current.jobs[0].status).toBe("success");

    // Now playlist response resolves
    await act(async () => {
      resolvePlaylist({
        items: [
          { jobId: 2, url: "https://example.com/p1" },
          { jobId: 3, url: "https://example.com/p2" },
        ],
        skippedCount: 0,
      });
      await playlistSubmit;
    });

    expect(result.current.jobs).toHaveLength(3);
    expect(result.current.jobs[0].id).toBe(1);
    expect(result.current.jobs[0].status).toBe("success");
    expect(result.current.jobs[0].request?.url).toBe("https://example.com/single");

    expect(result.current.jobs[1].id).toBe(2);
    expect(result.current.jobs[1].status).toBe("queued");
    expect(result.current.jobs[1].request?.url).toBe("https://example.com/p1");

    expect(result.current.jobs[2].id).toBe(3);
    expect(result.current.jobs[2].status).toBe("queued");
    expect(result.current.jobs[2].request?.url).toBe("https://example.com/p2");
  });

  it("draft edits during playlist submission do not mutate submitted immutable snapshot", async () => {
    let resolvePlaylist!: (val: unknown) => void;
    const playlistPromise = new Promise((resolve) => {
      resolvePlaylist = resolve;
    });
    setupActive({ value: 1 });
    mockInvoke.mockImplementation((command: string) => {
      if (command === "get_downloads_dir") return Promise.resolve(TEST_DIR);
      if (command === "enqueue_playlist") return playlistPromise;
      return Promise.resolve(undefined);
    });

    const { result } = renderHook(() => useDownloadQueue());
    await act(async () => {});

    act(() => {
      result.current.setScope("playlist");
      result.current.setUrl("https://example.com/playlist");
      result.current.setMediaType("video");
      result.current.setQuality("1080");
    });

    let submitPromise!: Promise<void>;
    act(() => {
      submitPromise = result.current.enqueueCurrentDraft();
    });

    // User changes draft while submission is in-flight
    act(() => {
      result.current.setMediaType("audio");
      result.current.setAudioFormat("mp3");
    });

    await act(async () => {
      resolvePlaylist({
        items: [{ jobId: 1, url: "https://example.com/item1" }],
        skippedCount: 0,
      });
      await submitPromise;
    });

    expect(result.current.jobs).toHaveLength(1);
    const req = result.current.jobs[0].request!;
    expect(req.mediaType).toBe("video");
    expect(req.quality).toBe("1080");
    expect(req.audioFormat).toBeNull();
  });

  it("skipped unavailable entries show notice and queue only accepted jobs", async () => {
    setupActive({ value: 1 });
    mockInvoke.mockImplementation((command: string) => {
      if (command === "get_downloads_dir") return Promise.resolve(TEST_DIR);
      if (command === "enqueue_playlist") {
        return Promise.resolve({
          items: [
            { jobId: 1, url: "https://example.com/item1" },
            { jobId: 2, url: "https://example.com/item2" },
          ],
          skippedCount: 3,
        });
      }
      return Promise.resolve(undefined);
    });

    const { result } = renderHook(() => useDownloadQueue());
    await act(async () => {});

    act(() => {
      result.current.setScope("playlist");
      result.current.setUrl("https://example.com/playlist");
    });

    await act(async () => {
      await result.current.enqueueCurrentDraft();
    });

    expect(result.current.jobs).toHaveLength(2);
    expect(result.current.enqueueNotice).toBe(
      "Added 2 items. 3 unavailable entries were skipped.",
    );
  });

  it("playlist failure surfaces friendly error without adding jobs or disturbing queue", async () => {
    setupActive({ value: 1 });
    mockInvoke.mockImplementation((command: string) => {
      if (command === "get_downloads_dir") return Promise.resolve(TEST_DIR);
      if (command === "enqueue_playlist") {
        return Promise.reject(new Error("This playlist is private."));
      }
      return Promise.resolve(undefined);
    });

    const { result } = renderHook(() => useDownloadQueue());
    await act(async () => {});

    act(() => {
      result.current.setScope("playlist");
      result.current.setUrl("https://example.com/playlist");
    });

    await act(async () => {
      await result.current.enqueueCurrentDraft();
    });

    expect(result.current.jobs).toHaveLength(0);
    expect(result.current.enqueueError).toBe("This playlist is private.");
    // URL preserved so user can edit it
    expect(result.current.url).toBe("https://example.com/playlist");
  });

  it("playlist double submit guard: only one IPC request in flight", async () => {
    let resolvePlaylist!: (val: unknown) => void;
    const playlistPromise = new Promise((resolve) => {
      resolvePlaylist = resolve;
    });
    setupActive({ value: 1 });
    mockInvoke.mockImplementation((command: string) => {
      if (command === "get_downloads_dir") return Promise.resolve(TEST_DIR);
      if (command === "enqueue_playlist") return playlistPromise;
      return Promise.resolve(undefined);
    });

    const { result } = renderHook(() => useDownloadQueue());
    await act(async () => {});

    act(() => {
      result.current.setScope("playlist");
      result.current.setUrl("https://example.com/playlist");
    });

    act(() => {
      void result.current.enqueueCurrentDraft();
      void result.current.enqueueCurrentDraft();
    });

    expect(
      mockInvoke.mock.calls.filter((call) => call[0] === "enqueue_playlist"),
    ).toHaveLength(1);

    await act(async () => {
      resolvePlaylist({ items: [{ jobId: 1, url: "https://example.com/1" }], skippedCount: 0 });
    });

    expect(result.current.jobs).toHaveLength(1);
  });
});
