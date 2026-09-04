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

beforeEach(() => {
  mockInvoke.mockReset().mockResolvedValue(undefined);
  mockListen.mockReset();
});

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
    expect(mockInvoke).not.toHaveBeenCalled();
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
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith("start_download", {
      url: "https://example.com/video",
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
    expect(mockInvoke).not.toHaveBeenCalled();
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
