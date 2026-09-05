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
  const unlistens = [vi.fn(), vi.fn(), vi.fn()];
  mockListen
    .mockResolvedValueOnce(unlistens[0])
    .mockResolvedValueOnce(unlistens[1])
    .mockResolvedValueOnce(unlistens[2]);
  return unlistens;
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
});
