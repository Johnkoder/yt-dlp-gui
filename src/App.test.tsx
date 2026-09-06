/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import type { DependencyReport } from "./features/dependencies/types";
import type { HistoryEntry } from "./features/history/types";

const { mockInvoke, mockListen, mockDialogOpen } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockListen: vi.fn(),
  mockDialogOpen: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mockListen }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mockDialogOpen }));

const DEFAULT_DIR = "C:\\Users\\Test\\Downloads";
const CUSTOM_DIR = "D:\\Videos";

function availableReport(): DependencyReport {
  return {
    ytDlp: {
      name: "yt-dlp",
      state: "available",
      version: "2026.08.19",
      path: "C:\\app\\yt-dlp.exe",
      message: null,
    },
    deno: {
      name: "Deno",
      state: "available",
      version: "2.9.6",
      path: "C:\\Users\\Test\\.deno\\bin\\deno.exe",
      message: null,
    },
    ffmpeg: {
      name: "FFmpeg",
      state: "available",
      version: "8.0",
      path: "C:\\tools\\ffmpeg.exe",
      message: "ffprobe available",
    },
  };
}

type Handler = (payload: never) => void;

/** Controllable backend double. Tests mutate `backend` per scenario. */
const backend = {
  report: availableReport(),
  enqueueIds: [1, 2, 3, 4, 5, 6, 7, 8, 9],
  cancelOutcome: "cancelling" as "cancelling" | "removed" | "notFound",
  failEnqueueWith: null as string | null,
  history: [] as HistoryEntry[],
};

function activeListen(handlers?: Map<string, Handler>) {
  const unlistens = [vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn()];
  const fns = [...unlistens];
  mockListen.mockImplementation((event: string, handler: Handler) => {
    handlers?.set(event, handler);
    const unlisten = fns.shift() ?? vi.fn();
    return Promise.resolve(unlisten);
  });
  return unlistens;
}

/** Default answers for non-dependency backend commands. */
function defaultAnswer(command: string, args?: unknown) {
  if (command === "get_downloads_dir") {
    return Promise.resolve(DEFAULT_DIR);
  }
  if (command === "validate_output_directory") {
    return Promise.resolve((args as { path: string }).path);
  }
  if (command === "check_dependencies") {
    return Promise.resolve(backend.report);
  }
  if (command === "enqueue_download") {
    if (backend.failEnqueueWith) {
      return Promise.reject(new Error(backend.failEnqueueWith));
    }
    const jobId = backend.enqueueIds.shift() ?? 99;
    return Promise.resolve({ jobId });
  }
  if (command === "enqueue_playlist") {
    if (backend.failEnqueueWith) {
      return Promise.reject(new Error(backend.failEnqueueWith));
    }
    const id1 = backend.enqueueIds.shift() ?? 91;
    const id2 = backend.enqueueIds.shift() ?? 92;
    return Promise.resolve({
      items: [
        { jobId: id1, url: "https://example.com/item1", title: "Item 1" },
        { jobId: id2, url: "https://example.com/item2", title: "Item 2" },
      ],
      skippedCount: 1,
    });
  }
  if (command === "cancel_job") {
    return Promise.resolve(backend.cancelOutcome);
  }
  if (command === "get_history") {
    return Promise.resolve(backend.history);
  }
  if (command === "clear_history") {
    backend.history = [];
    return Promise.resolve();
  }
  return Promise.resolve(undefined);
}

function fire<T>(handlers: Map<string, Handler>, event: string, payload: T) {
  return act(async () => {
    handlers.get(event)?.({ payload } as never);
  });
}

async function renderReadyApp(handlers?: Map<string, Handler>) {
  activeListen(handlers);
  render(<App />);
  await act(async () => {});
}

function enterUrl(url: string) {
  fireEvent.change(screen.getByPlaceholderText(/youtube\.com/), {
    target: { value: url },
  });
}

beforeEach(() => {
  mockInvoke.mockReset();
  mockListen.mockReset();
  mockDialogOpen.mockReset().mockResolvedValue(null);
  window.localStorage.clear();
  backend.report = availableReport();
  backend.enqueueIds = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  backend.cancelOutcome = "cancelling";
  backend.failEnqueueWith = null;
  backend.history = [];
  mockInvoke.mockImplementation(defaultAnswer);
});

// RTL auto-cleanup relies on globals mode; wire it explicitly instead.
afterEach(() => {
  cleanup();
});

describe("App download options", () => {
  it("defaults to Video + Best with a Download Video button", async () => {
    await renderReadyApp();

    expect(screen.getByRole("radio", { name: "Video" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("radio", { name: "Audio" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(screen.getByLabelText("Quality")).toHaveValue("best");
    // Empty URL: no enqueue allowed yet.
    expect(
      screen.getByRole("button", { name: /download video/i }),
    ).toBeDisabled();

    enterUrl("https://example.com/v");
    expect(
      screen.getByRole("button", { name: /download video/i }),
    ).toBeEnabled();
  });

  it("hides quality and renames the button in Audio mode", async () => {
    await renderReadyApp();

    enterUrl("https://example.com/v");
    fireEvent.click(screen.getByRole("radio", { name: "Audio" }));
    expect(screen.getByRole("radio", { name: "Audio" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.queryByLabelText("Quality")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /download audio/i }),
    ).toBeEnabled();

    fireEvent.click(screen.getByRole("radio", { name: "Video" }));
    expect(screen.getByLabelText("Quality")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /download video/i }),
    ).toBeEnabled();
  });

  it("moves selection and focus together with arrow keys", async () => {
    await renderReadyApp();

    const video = screen.getByRole("radio", { name: "Video" });
    const audio = screen.getByRole("radio", { name: "Audio" });

    video.focus();
    fireEvent.keyDown(video, { key: "ArrowRight" });
    expect(audio).toHaveAttribute("aria-checked", "true");
    expect(document.activeElement).toBe(audio);

    fireEvent.keyDown(audio, { key: "ArrowLeft" });
    expect(video).toHaveAttribute("aria-checked", "true");
    expect(document.activeElement).toBe(video);
  });

  it("shows the default output folder on startup", async () => {
    await renderReadyApp();

    const folder = screen.getByLabelText("Output folder") as HTMLInputElement;
    expect(folder.value).toBe(DEFAULT_DIR);
    expect(folder.title).toBe(DEFAULT_DIR);
  });

  it("browse updates the folder and persists it", async () => {
    mockDialogOpen.mockResolvedValue("D:\\Videos");
    await renderReadyApp();

    fireEvent.click(screen.getByRole("button", { name: /browse/i }));
    await act(async () => {});

    expect(mockDialogOpen).toHaveBeenCalled();
    const folder = screen.getByLabelText("Output folder") as HTMLInputElement;
    expect(folder.value).toBe("D:\\Videos");
    expect(window.localStorage.getItem("yt-dlp-gui.outputDirectory")).toBe(
      "D:\\Videos",
    );
  });

  it("cancelled picker preserves the current folder", async () => {
    mockDialogOpen.mockResolvedValue(null);
    await renderReadyApp();

    fireEvent.click(screen.getByRole("button", { name: /browse/i }));
    await act(async () => {});

    const folder = screen.getByLabelText("Output folder") as HTMLInputElement;
    expect(folder.value).toBe(DEFAULT_DIR);
    expect(
      window.localStorage.getItem("yt-dlp-gui.outputDirectory"),
    ).toBeNull();
  });

  it("falls back to Downloads for a stale saved folder", async () => {
    window.localStorage.setItem(
      "yt-dlp-gui.outputDirectory",
      "C:\\stale\\gone",
    );
    // Stale paths fail validation in the mock backend.
    mockInvoke.mockImplementation((command: string, args?: unknown) => {
      if (command === "validate_output_directory") {
        const path = (args as { path: string }).path;
        return path === "C:\\stale\\gone"
          ? Promise.reject(new Error("gone"))
          : Promise.resolve(path);
      }
      return defaultAnswer(command, args);
    });
    await renderReadyApp();

    const folder = screen.getByLabelText("Output folder") as HTMLInputElement;
    expect(folder.value).toBe(DEFAULT_DIR);
    expect(
      window.localStorage.getItem("yt-dlp-gui.outputDirectory"),
    ).toBeNull();
  });
});

describe("App queue", () => {
  it("first enqueue creates a waiting job and clears only the URL", async () => {
    await renderReadyApp();

    enterUrl("https://example.com/a");
    fireEvent.change(screen.getByLabelText("Quality"), {
      target: { value: "1080" },
    });
    fireEvent.click(screen.getByRole("button", { name: /download video/i }));
    await act(async () => {});

    expect(mockInvoke).toHaveBeenCalledWith("enqueue_download", {
      request: {
        url: "https://example.com/a",
        mediaType: "video",
        quality: "1080",
        audioFormat: null,
        outputDirectory: DEFAULT_DIR,
      },
    });
    expect(screen.getByLabelText("Job 1: Waiting")).toBeInTheDocument();
    expect(screen.getByText("Video • 1080p")).toBeInTheDocument();
    // URL cleared; selections preserved.
    expect(
      (screen.getByPlaceholderText(/youtube\.com/) as HTMLInputElement).value,
    ).toBe("");
    expect(screen.getByLabelText("Quality")).toHaveValue("1080");
  });

  it("second job enqueues while the first downloads", async () => {
    const handlers = new Map<string, Handler>();
    await renderReadyApp(handlers);

    enterUrl("https://example.com/a");
    fireEvent.click(screen.getByRole("button", { name: /download video/i }));
    await act(async () => {});
    await fire(handlers, "download-started", { jobId: 1 });

    // Form stays usable; button becomes Add to Queue.
    expect(screen.getByPlaceholderText(/youtube\.com/)).toBeEnabled();
    expect(screen.getByRole("radio", { name: "Audio" })).toBeEnabled();
    expect(screen.getByLabelText("Quality")).toBeEnabled();
    expect(screen.getByLabelText("Output folder")).toBeEnabled();
    expect(screen.getByRole("button", { name: /browse/i })).toBeEnabled();

    enterUrl("https://example.com/b");
    expect(
      screen.getByRole("button", { name: /add to queue/i }),
    ).toBeEnabled();
    fireEvent.click(screen.getByRole("radio", { name: "Audio" }));
    fireEvent.change(screen.getByLabelText("Audio format"), {
      target: { value: "mp3" },
    });
    fireEvent.click(screen.getByRole("button", { name: /add to queue/i }));
    await act(async () => {});

    const rows = screen.getAllByLabelText(/Job \d: (Waiting|Downloading)/);
    expect(rows).toHaveLength(2);
    expect(screen.getByText("Audio • MP3")).toBeInTheDocument();
    const enqueues = mockInvoke.mock.calls.filter(
      ([command]) => command === "enqueue_download",
    );
    expect(enqueues).toHaveLength(2);
  });

  it("snapshots stay distinct across jobs", async () => {
    const handlers = new Map<string, Handler>();
    await renderReadyApp(handlers);

    fireEvent.change(screen.getByLabelText("Quality"), {
      target: { value: "720" },
    });
    enterUrl("https://example.com/a");
    fireEvent.click(screen.getByRole("button", { name: /download video/i }));
    await act(async () => {});
    await fire(handlers, "download-started", { jobId: 1 });

    fireEvent.click(screen.getByRole("radio", { name: "Audio" }));
    enterUrl("https://example.com/b");
    fireEvent.click(screen.getByRole("button", { name: /add to queue/i }));
    await act(async () => {});
    await fire(handlers, "download-started", { jobId: 2 });
    await fire(handlers, "download-complete", {
      jobId: 1,
      filename: "a [1].mp4",
      filepath: `${DEFAULT_DIR}\\a [1].mp4`,
      outputDir: DEFAULT_DIR,
    });
    await fire(handlers, "download-complete", {
      jobId: 2,
      filename: "b [2].m4a",
      filepath: `${CUSTOM_DIR}\\b [2].m4a`,
      outputDir: CUSTOM_DIR,
    });

    // Job 1 kept its video snapshot; rows show in FIFO order.
    const completed = screen.getAllByText("Completed");
    expect(completed).toHaveLength(2);
    expect(screen.getByText("a [1].mp4")).toBeInTheDocument();
    expect(screen.getByText("b [2].m4a")).toBeInTheDocument();
  });

  it("started event marks the correct job downloading", async () => {
    const handlers = new Map<string, Handler>();
    await renderReadyApp(handlers);

    enterUrl("https://example.com/a");
    fireEvent.click(screen.getByRole("button", { name: /download video/i }));
    await act(async () => {});
    enterUrl("https://example.com/b");
    fireEvent.click(screen.getByRole("button", { name: /add to queue/i }));
    await act(async () => {});

    await fire(handlers, "download-started", { jobId: 2 });
    expect(
      screen.getByLabelText("Job 2: Downloading"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Job 1: Waiting")).toBeInTheDocument();
  });

  it("progress updates only the matching job", async () => {
    const handlers = new Map<string, Handler>();
    await renderReadyApp(handlers);

    enterUrl("https://example.com/a");
    fireEvent.click(screen.getByRole("button", { name: /download video/i }));
    await act(async () => {});
    await fire(handlers, "download-started", { jobId: 1 });
    await fire(handlers, "download-progress", {
      jobId: 1,
      status: "Downloading",
      percentage: 64,
      speed: "7.2 MiB/s",
      eta: "00:18",
    });

    expect(screen.getByText("64.0%")).toBeInTheDocument();
    expect(screen.getByText(/7\.2 MiB\/s/)).toBeInTheDocument();
  });

  it("error on one job does not stop the next from starting", async () => {
    const handlers = new Map<string, Handler>();
    await renderReadyApp(handlers);

    enterUrl("https://example.com/a");
    fireEvent.click(screen.getByRole("button", { name: /download video/i }));
    await act(async () => {});
    enterUrl("https://example.com/b");
    fireEvent.click(screen.getByRole("button", { name: /add to queue/i }));
    await act(async () => {});

    await fire(handlers, "download-started", { jobId: 1 });
    await fire(handlers, "download-error", {
      jobId: 1,
      message: "boom",
      details: "boom details",
    });
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("boom")).toBeInTheDocument();

    await fire(handlers, "download-started", { jobId: 2 });
    expect(screen.getByLabelText("Job 2: Downloading")).toBeInTheDocument();
    expect(screen.getByLabelText("Job 1: Failed")).toBeInTheDocument();
  });

  it("cancel active then next job starts automatically", async () => {
    const handlers = new Map<string, Handler>();
    await renderReadyApp(handlers);

    enterUrl("https://example.com/a");
    fireEvent.click(screen.getByRole("button", { name: /download video/i }));
    await act(async () => {});
    enterUrl("https://example.com/b");
    fireEvent.click(screen.getByRole("button", { name: /add to queue/i }));
    await act(async () => {});

    await fire(handlers, "download-started", { jobId: 1 });
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    await act(async () => {});
    expect(mockInvoke).toHaveBeenCalledWith("cancel_job", { jobId: 1 });
    expect(
      screen.getByRole("button", { name: /cancelling/i }),
    ).toBeDisabled();

    await fire(handlers, "download-cancelled", {
      jobId: 1,
      message: "Download cancelled.",
    });
    expect(screen.getByLabelText("Job 1: Cancelled")).toBeInTheDocument();
    expect(screen.queryByText("Download failed")).not.toBeInTheDocument();

    await fire(handlers, "download-started", { jobId: 2 });
    expect(screen.getByLabelText("Job 2: Downloading")).toBeInTheDocument();
  });

  it("remove waiting job by id; removed job never starts", async () => {
    const handlers = new Map<string, Handler>();
    await renderReadyApp(handlers);
    backend.cancelOutcome = "removed";

    enterUrl("https://example.com/a");
    fireEvent.click(screen.getByRole("button", { name: /download video/i }));
    await act(async () => {});
    enterUrl("https://example.com/b");
    fireEvent.click(screen.getByRole("button", { name: /add to queue/i }));
    await act(async () => {});
    await fire(handlers, "download-started", { jobId: 1 });

    const removeButtons = screen.getAllByRole("button", { name: /remove/i });
    expect(removeButtons).toHaveLength(1);
    fireEvent.click(removeButtons[0]);
    await act(async () => {});
    expect(mockInvoke).toHaveBeenCalledWith("cancel_job", { jobId: 2 });
    expect(screen.getByLabelText("Job 2: Cancelled")).toBeInTheDocument();

    // Even if a stale started event arrived, a terminal row never regresses.
    await fire(handlers, "download-started", { jobId: 2 });
    expect(screen.getByLabelText("Job 2: Cancelled")).toBeInTheDocument();
  });

  it("waiting-to-active remove race showing cancelling is handled", async () => {
    const handlers = new Map<string, Handler>();
    await renderReadyApp(handlers);
    backend.cancelOutcome = "cancelling";

    enterUrl("https://example.com/a");
    fireEvent.click(screen.getByRole("button", { name: /download video/i }));
    await act(async () => {});

    const removeButtons = screen.getAllByRole("button", { name: /remove/i });
    fireEvent.click(removeButtons[0]);
    await act(async () => {});
    // Backend promoted it first: row shows Cancelling, not removed.
    expect(
      screen.getByRole("button", { name: /cancelling/i }),
    ).toBeDisabled();

    await fire(handlers, "download-cancelled", {
      jobId: 1,
      message: "Download cancelled.",
    });
    expect(screen.getByLabelText("Job 1: Cancelled")).toBeInTheDocument();
  });

  it("late job 1 progress cannot modify job 2", async () => {
    const handlers = new Map<string, Handler>();
    await renderReadyApp(handlers);

    enterUrl("https://example.com/a");
    fireEvent.click(screen.getByRole("button", { name: /download video/i }));
    await act(async () => {});
    enterUrl("https://example.com/b");
    fireEvent.click(screen.getByRole("button", { name: /add to queue/i }));
    await act(async () => {});

    await fire(handlers, "download-started", { jobId: 1 });
    await fire(handlers, "download-started", { jobId: 2 });
    await fire(handlers, "download-progress", {
      jobId: 1,
      status: "Downloading",
      percentage: 99,
    });

    expect(screen.getByLabelText("Job 1: Downloading")).toBeInTheDocument();
    // Job 2 shows no percentage of its own.
    const job2 = screen.getByLabelText("Job 2: Downloading");
    expect(job2.textContent).not.toContain("99%");
  });

  it("started-before-response merges without regressing", async () => {
    let resolveEnqueue!: (value: unknown) => void;
    const handlers = new Map<string, Handler>();
    activeListen(handlers);
    mockInvoke.mockImplementation((command: string, args?: unknown) => {
      if (command === "enqueue_download") {
        return new Promise((resolve) => {
          resolveEnqueue = resolve;
        });
      }
      return defaultAnswer(command, args);
    });
    render(<App />);
    await act(async () => {});

    enterUrl("https://example.com/a");
    fireEvent.click(screen.getByRole("button", { name: /download video/i }));
    // Started lands before the enqueue response resolves.
    await fire(handlers, "download-started", { jobId: 42 });
    expect(screen.getByLabelText("Job 42: Downloading")).toBeInTheDocument();

    await act(async () => {
      resolveEnqueue({ jobId: 42 });
    });
    await act(async () => {});
    // Still exactly one row, still downloading, snapshot merged in.
    expect(screen.getByLabelText("Job 42: Downloading")).toBeInTheDocument();
    expect(screen.getByText("Video • Best")).toBeInTheDocument();
    expect(
      screen.queryByLabelText("Job 42: Waiting"),
    ).not.toBeInTheDocument();
  });

  it("double-click while submitting enqueues only once", async () => {
    let resolveEnqueue!: (value: unknown) => void;
    const handlers = new Map<string, Handler>();
    activeListen(handlers);
    mockInvoke.mockImplementation((command: string, args?: unknown) => {
      if (command === "enqueue_download") {
        return new Promise((resolve) => {
          resolveEnqueue = resolve;
        });
      }
      return defaultAnswer(command, args);
    });
    render(<App />);
    await act(async () => {});

    enterUrl("https://example.com/a");
    const button = screen.getByRole("button", { name: /download video/i });
    fireEvent.click(button);
    fireEvent.click(button);
    await act(async () => {
      resolveEnqueue({ jobId: 1 });
    });
    await act(async () => {});

    const enqueues = mockInvoke.mock.calls.filter(
      ([command]) => command === "enqueue_download",
    );
    expect(enqueues).toHaveLength(1);
    expect(screen.getByLabelText("Job 1: Waiting")).toBeInTheDocument();
    void handlers;
  });

  it("success rows open their own output folder", async () => {
    const handlers = new Map<string, Handler>();
    await renderReadyApp(handlers);

    enterUrl("https://example.com/a");
    fireEvent.click(screen.getByRole("button", { name: /download video/i }));
    await act(async () => {});
    await fire(handlers, "download-started", { jobId: 1 });
    await fire(handlers, "download-complete", {
      jobId: 1,
      filename: "a [1].mp4",
      filepath: `${DEFAULT_DIR}\\a [1].mp4`,
      outputDir: DEFAULT_DIR,
    });

    expect(screen.getByText("Completed")).toBeInTheDocument();
    expect(screen.getByText("a [1].mp4")).toBeInTheDocument();
    expect(screen.getByText(`Saved to ${DEFAULT_DIR}`)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /open folder/i }));
    await act(async () => {});
    expect(mockInvoke).toHaveBeenCalledWith("open_output_folder", {
      path: DEFAULT_DIR,
    });
  });
});

describe("App dependencies", () => {
  it("checks on startup and shows versions", async () => {
    await renderReadyApp();

    expect(mockInvoke).toHaveBeenCalledWith("check_dependencies");
    expect(screen.getByText("2026.08.19")).toBeInTheDocument();
    expect(screen.getByText(/2\.9\.6/)).toBeInTheDocument();
    // Long paths stay in tooltips, not in the row text.
    const row = screen.getByLabelText(/yt-dlp: 2026\.08\.19/);
    expect(row.textContent).not.toContain("C:\\app");
    expect(row.getAttribute("title")).toContain("C:\\app\\yt-dlp.exe");
  });

  it("shows loading state while checking", async () => {
    mockInvoke.mockImplementation((command: string, args?: unknown) => {
      if (command === "check_dependencies") {
        return new Promise(() => {});
      }
      return defaultAnswer(command, args);
    });
    activeListen();
    render(<App />);

    expect(screen.getByText("Checking dependencies…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /refresh/i })).toBeDisabled();
    await act(async () => {});
  });

  it("warns on missing Deno and FFmpeg without blocking downloads", async () => {
    const report = availableReport();
    report.deno = {
      name: "Deno",
      state: "missing",
      version: null,
      path: null,
      message:
        "Deno was not found. Some sites, including YouTube, may not work fully without a JavaScript runtime.",
    };
    report.ffmpeg = {
      name: "FFmpeg",
      state: "missing",
      version: null,
      path: null,
      message:
        "FFmpeg was not found. High-quality video streams may not be mergeable, and audio conversion will be unavailable.",
    };
    backend.report = report;
    await renderReadyApp();

    expect(screen.getByLabelText(/deno: /i)).toHaveTextContent(
      /not found|may not work fully/i,
    );
    expect(screen.getByLabelText(/ffmpeg: /i)).toHaveTextContent(
      /not found|not be mergeable/i,
    );
    // Downloads still allowed: enter URL and the button enables.
    enterUrl("https://example.com/v");
    expect(
      screen.getByRole("button", { name: /download video/i }),
    ).toBeEnabled();
    // Contextual FFmpeg note appears for video mode.
    expect(
      screen.getByText(/FFmpeg is not installed\. Some video qualities/i),
    ).toBeInTheDocument();
  });

  it("missing yt-dlp disables downloading and explains why", async () => {
    const report = availableReport();
    report.ytDlp = {
      name: "yt-dlp",
      state: "missing",
      version: null,
      path: null,
      message: "yt-dlp is required to download media.",
    };
    backend.report = report;
    await renderReadyApp();

    enterUrl("https://example.com/v");
    expect(
      screen.getByRole("button", { name: /download video/i }),
    ).toBeDisabled();
    expect(
      screen.getByText(/downloads unavailable: yt-dlp is missing/i),
    ).toBeInTheDocument();

    // Even Enter cannot start the download.
    fireEvent.keyDown(screen.getByPlaceholderText(/youtube\.com/), {
      key: "Enter",
    });
    await act(async () => {});
    const started = mockInvoke.mock.calls.filter(
      ([command]) => command === "enqueue_download",
    );
    expect(started).toHaveLength(0);
  });

  it("refresh re-checks and ignores clicks while checking", async () => {
    let resolveCheck!: (value: unknown) => void;
    mockInvoke.mockImplementation((command: string, args?: unknown) => {
      if (command === "check_dependencies") {
        return new Promise((resolve) => {
          resolveCheck = resolve;
        });
      }
      return defaultAnswer(command, args);
    });
    activeListen();
    render(<App />);
    const checks = () =>
      mockInvoke.mock.calls.filter(([c]) => c === "check_dependencies").length;

    expect(checks()).toBe(1);
    await act(async () => {
      resolveCheck(availableReport());
    });
    await act(async () => {});
    expect(screen.getByRole("button", { name: /refresh/i })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    expect(checks()).toBe(2);
    await act(async () => {
      resolveCheck(availableReport());
    });
    await act(async () => {});
    expect(checks()).toBe(2);
    expect(screen.getByText("2026.08.19")).toBeInTheDocument();
  });

  it("download UI still works when all dependencies are available", async () => {
    await renderReadyApp();

    enterUrl("https://example.com/v");
    fireEvent.click(screen.getByRole("button", { name: /download video/i }));
    await act(async () => {});
    expect(mockInvoke).toHaveBeenCalledWith("enqueue_download", {
      request: {
        url: "https://example.com/v",
        mediaType: "video",
        quality: "best",
        audioFormat: null,
        outputDirectory: DEFAULT_DIR,
      },
    });
  });

  it("updates button text and calls enqueue_playlist in Playlist mode", async () => {
    await renderReadyApp();

    expect(screen.getByRole("radio", { name: "Single item" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("radio", { name: "Playlist" })).toHaveAttribute(
      "aria-checked",
      "false",
    );

    fireEvent.click(screen.getByRole("radio", { name: "Playlist" }));
    expect(screen.getByRole("radio", { name: "Playlist" })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    enterUrl("https://example.com/playlist?list=PL123");
    const button = screen.getByRole("button", {
      name: /add playlist to queue/i,
    });
    expect(button).toBeEnabled();

    fireEvent.click(button);
    await act(async () => {});

    expect(mockInvoke).toHaveBeenCalledWith("enqueue_playlist", {
      request: {
        url: "https://example.com/playlist?list=PL123",
        mediaType: "video",
        quality: "best",
        audioFormat: null,
        outputDirectory: DEFAULT_DIR,
      },
    });

    // Should display notice with enqueued and skipped count
    expect(
      screen.getByText(/Added 2 items\. 1 unavailable entry was skipped\./i),
    ).toBeInTheDocument();
  });

  describe("History section integration", () => {
    it("renders empty history state when no items exist", async () => {
      await renderReadyApp();
      expect(screen.getByRole("region", { name: /download history/i })).toBeInTheDocument();
      expect(screen.getByText("No download history yet.")).toBeInTheDocument();
    });

    it("displays loaded history items", async () => {
      backend.history = [
        {
          id: 1,
          timestampMs: 1672531199000,
          url: "https://example.com/item",
          mediaType: "video",
          quality: "1080",
          audioFormat: null,
          outputDirectory: DEFAULT_DIR,
          status: "success",
          filename: "saved_video.mp4",
          filepath: `${DEFAULT_DIR}\\saved_video.mp4`,
          message: null,
        },
      ];

      await renderReadyApp();

      expect(screen.getByText("saved_video.mp4")).toBeInTheDocument();
      expect(screen.getByText("Video • 1080p")).toBeInTheDocument();
      expect(screen.getByText("Completed")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /open folder/i })).toBeInTheDocument();
    });

    it("updates dynamically when history-entry-added event arrives", async () => {
      const handlers = new Map<string, Handler>();
      await renderReadyApp(handlers);

      expect(screen.getByText("No download history yet.")).toBeInTheDocument();

      const newEntry: HistoryEntry = {
        id: 99,
        timestampMs: 1672531200000,
        url: "https://example.com/live",
        mediaType: "audio",
        quality: null,
        audioFormat: "mp3",
        outputDirectory: DEFAULT_DIR,
        status: "error",
        filename: null,
        filepath: null,
        message: "Network failure",
      };

      await fire(handlers, "history-entry-added", newEntry);

      expect(screen.queryByText("No download history yet.")).not.toBeInTheDocument();
      expect(screen.getByText("Audio • MP3")).toBeInTheDocument();
      expect(screen.getByText("Failed")).toBeInTheDocument();
      expect(screen.getByText("Network failure")).toBeInTheDocument();
    });

    it("clears history when confirmed", async () => {
      backend.history = [
        {
          id: 1,
          timestampMs: 1672531199000,
          url: "https://example.com/item",
          mediaType: "video",
          quality: "best",
          audioFormat: null,
          outputDirectory: DEFAULT_DIR,
          status: "success",
          filename: "video_to_clear.mp4",
          filepath: null,
          message: null,
        },
      ];

      await renderReadyApp();
      expect(screen.getByText("video_to_clear.mp4")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: /clear history/i }));
      expect(screen.getByText("Clear all history?")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
      await act(async () => {});

      expect(mockInvoke).toHaveBeenCalledWith("clear_history");
      expect(screen.getByText("No download history yet.")).toBeInTheDocument();
    });
  });
});
