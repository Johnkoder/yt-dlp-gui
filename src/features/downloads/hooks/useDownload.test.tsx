/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDownload } from "./useDownload";

const { mockInvoke, mockListen } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockListen: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mockListen }));

type Handler = (payload: never) => void;

function pendingListen() {
  const handlers = new Map<string, Handler>();
  mockListen.mockImplementation((event: string, handler: Handler) => {
    handlers.set(event, handler);
    return new Promise(() => {});
  });
  return handlers;
}

function activeListen() {
  const unlistens = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
  mockListen
    .mockResolvedValueOnce(unlistens[0])
    .mockResolvedValueOnce(unlistens[1])
    .mockResolvedValueOnce(unlistens[2])
    .mockResolvedValueOnce(unlistens[3]);
  return unlistens;
}

/** Listeners that both resolve (active subscription) and stay invokable. */
function capturedActiveListen() {
  const handlers = new Map<string, Handler>();
  const unlistens = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
  let next = 0;
  mockListen.mockImplementation((event: string, handler: Handler) => {
    handlers.set(event, handler);
    const unlisten = unlistens[next] ?? vi.fn();
    next += 1;
    return Promise.resolve(unlisten);
  });
  return { handlers, unlistens };
}

export const TEST_DOWNLOADS_DIR = "C:\\Users\\Test\\Downloads";

/** Route mocked invokes like the backend would answer. */
export function mockInvokeRouting() {
  mockInvoke.mockImplementation((command: string, args?: unknown) => {
    if (command === "get_downloads_dir") {
      return Promise.resolve(TEST_DOWNLOADS_DIR);
    }
    if (command === "validate_output_directory") {
      const path = (args as { path: string }).path;
      return path === "C:\\stale\\gone"
        ? Promise.reject(new Error("gone"))
        : Promise.resolve(path);
    }
    return Promise.resolve(undefined);
  });
}

beforeEach(() => {
  mockInvoke.mockReset();
  mockListen.mockReset();
  window.localStorage.clear();
  mockInvokeRouting();
});

/** Every start_download invocation (startup init also invokes). */
function startedDownloads() {
  return mockInvoke.mock.calls.filter(([command]) => command === "start_download");
}

describe("useDownload event readiness", () => {
  it("blocks downloads until listeners are registered", async () => {
    pendingListen();
    const { result } = renderHook(() => useDownload());

    expect(result.current.status).toBe("initializing");
    expect(result.current.canDownload).toBe(false);

    act(() => {
      result.current.setUrl("https://example.com/video");
    });
    // URL present, but subscription still pending: still blocked.
    expect(result.current.canDownload).toBe(false);

    await act(async () => {
      await result.current.handleDownload();
    });
    expect(startedDownloads()).toHaveLength(0);
    expect(result.current.status).toBe("initializing");
  });

  it("allows downloads once listeners are active", async () => {
    activeListen();
    const { result } = renderHook(() => useDownload());

    await act(async () => {});
    expect(result.current.status).toBe("ready");
    expect(result.current.canDownload).toBe(false);

    act(() => {
      result.current.setUrl("  https://example.com/video  ");
    });
    expect(result.current.canDownload).toBe(true);

    await act(async () => {
      await result.current.handleDownload();
    });
    expect(startedDownloads()).toHaveLength(1);
    expect(mockInvoke).toHaveBeenCalledWith("start_download", {
      request: {
        url: "https://example.com/video",
        mediaType: "video",
        quality: "best",
        audioFormat: null,
        outputDirectory: TEST_DOWNLOADS_DIR,
      },
    });
    expect(result.current.status).toBe("downloading");
  });

  it("surfaces subscription failure and never allows downloads", async () => {
    mockListen.mockRejectedValue(new Error("event backend unavailable"));
    const { result } = renderHook(() => useDownload());

    await act(async () => {});
    expect(result.current.subscription).toBe("failed");
    expect(result.current.status).toBe("error");
    expect(result.current.errorMessage).toMatch(/backend/i);
    expect(result.current.errorDetails).toBe("event backend unavailable");
    expect(result.current.canDownload).toBe(false);

    // The terminal state is sticky: reset and download stay no-ops.
    act(() => {
      result.current.setUrl("https://example.com/video");
      result.current.handleReset();
    });
    expect(result.current.status).toBe("error");
    expect(result.current.canDownload).toBe(false);

    await act(async () => {
      await result.current.handleDownload();
    });
    expect(startedDownloads()).toHaveLength(0);
  });

  it("unsubscribes listeners on unmount", async () => {
    const unlistens = activeListen();
    const { unmount } = renderHook(() => useDownload());

    await act(async () => {});
    unmount();
    for (const unlisten of unlistens) {
      expect(unlisten).toHaveBeenCalledTimes(1);
    }
  });

  it("cancel requests confirmation through the backend event", async () => {
    const { handlers } = capturedActiveListen();
    const { result } = renderHook(() => useDownload());

    await act(async () => {});
    act(() => {
      result.current.setUrl("https://example.com/video");
    });
    await act(async () => {
      await result.current.handleDownload();
    });
    expect(result.current.status).toBe("downloading");

    await act(async () => {
      await result.current.handleCancel();
    });
    // Cancelling, not yet cancelled: the event decides.
    expect(result.current.status).toBe("cancelling");
    expect(mockInvoke).toHaveBeenCalledWith("cancel_download");

    await act(async () => {
      handlers.get("download-cancelled")?.({ payload: { message: "x" } } as never);
    });
    expect(result.current.status).toBe("cancelled");
    expect(result.current.result).toBeNull();
    expect(result.current.errorMessage).toBeNull();
  });

  it("late progress does not regress cancelling to downloading", async () => {
    const { handlers } = capturedActiveListen();
    const { result } = renderHook(() => useDownload());

    await act(async () => {});
    act(() => {
      result.current.setUrl("https://example.com/video");
    });
    await act(async () => {
      await result.current.handleDownload();
    });
    await act(async () => {
      await result.current.handleCancel();
    });
    expect(result.current.status).toBe("cancelling");

    await act(async () => {
      handlers.get("download-progress")?.({
        payload: { status: "Downloading", percentage: 68 },
      } as never);
    });
    expect(result.current.status).toBe("cancelling");
    expect(result.current.progress?.percentage).toBe(68);
  });

  it("second cancel click issues no further request", async () => {
    capturedActiveListen();
    const { result } = renderHook(() => useDownload());

    await act(async () => {});
    act(() => {
      result.current.setUrl("https://example.com/video");
    });
    await act(async () => {
      await result.current.handleDownload();
    });
    await act(async () => {
      await result.current.handleCancel();
    });
    await act(async () => {
      await result.current.handleCancel();
    });
    const cancels = mockInvoke.mock.calls.filter(
      ([command]) => command === "cancel_download",
    );
    expect(cancels).toHaveLength(1);
    expect(result.current.status).toBe("cancelling");
  });

  it("cancel IPC failure keeps the running download visible", async () => {
    capturedActiveListen();
    const { result } = renderHook(() => useDownload());

    await act(async () => {});
    act(() => {
      result.current.setUrl("https://example.com/video");
    });
    await act(async () => {
      await result.current.handleDownload();
    });
    mockInvoke.mockImplementation((command: string) => {
      if (command === "cancel_download") {
        return Promise.reject(new Error("ipc down"));
      }
      if (command === "get_downloads_dir") {
        return Promise.resolve(TEST_DOWNLOADS_DIR);
      }
      return Promise.resolve(undefined);
    });

    await act(async () => {
      await result.current.handleCancel();
    });
    // Back to downloading with a targeted message — not a fake terminal.
    expect(result.current.status).toBe("downloading");
    expect(result.current.cancelError).toMatch(/could not cancel/i);
    expect(result.current.errorMessage).toBeNull();
  });

  it("reset after cancellation returns to ready with selections kept", async () => {
    const { handlers } = capturedActiveListen();
    const { result } = renderHook(() => useDownload());

    await act(async () => {});
    act(() => {
      result.current.setUrl("https://example.com/video");
      result.current.setMediaType("audio");
    });
    await act(async () => {
      await result.current.handleDownload();
    });
    await act(async () => {
      await result.current.handleCancel();
    });
    await act(async () => {
      handlers.get("download-cancelled")?.({ payload: { message: "x" } } as never);
    });
    expect(result.current.status).toBe("cancelled");

    act(() => {
      result.current.handleReset();
    });
    expect(result.current.status).toBe("ready");
    expect(result.current.url).toBe("https://example.com/video");
    expect(result.current.mediaType).toBe("audio");
  });
});
