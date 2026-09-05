/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import type { DependencyReport } from "./features/dependencies/types";

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

/** Default answers for non-dependency backend commands. */
function defaultAnswer(command: string, args?: unknown) {
  if (command === "get_downloads_dir") {
    return Promise.resolve(DEFAULT_DIR);
  }
  if (command === "validate_output_directory") {
    const path = (args as { path: string }).path;
    return path === "C:\\stale\\gone"
      ? Promise.reject(new Error("gone"))
      : Promise.resolve(path);
  }
  return Promise.resolve(undefined);
}

/** Route mocked backend commands; stale paths fail validation. */
function mockBackend(report = availableReport()) {
  mockInvoke.mockImplementation((command: string, args?: unknown) => {
    if (command === "check_dependencies") {
      return Promise.resolve(report);
    }
    return defaultAnswer(command, args);
  });
}

async function renderReadyApp() {
  activeListen();
  render(<App />);
  // Flush subscription + output-folder init: initializing -> ready.
  await act(async () => {});
}

function activeListen() {
  mockListen
    .mockResolvedValueOnce(vi.fn())
    .mockResolvedValueOnce(vi.fn())
    .mockResolvedValueOnce(vi.fn());
}

beforeEach(() => {
  mockInvoke.mockReset();
  mockListen.mockReset();
  mockDialogOpen.mockReset().mockResolvedValue(null);
  window.localStorage.clear();
  mockBackend();
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
    // Empty URL: no download allowed yet.
    expect(
      screen.getByRole("button", { name: /download video/i }),
    ).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText(/youtube\.com/), {
      target: { value: "https://example.com/v" },
    });
    expect(
      screen.getByRole("button", { name: /download video/i }),
    ).toBeEnabled();
  });

  it("hides quality and renames the button in Audio mode", async () => {
    await renderReadyApp();

    fireEvent.change(screen.getByPlaceholderText(/youtube\.com/), {
      target: { value: "https://example.com/v" },
    });
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

  it("sends the selected video quality to the backend", async () => {
    await renderReadyApp();

    fireEvent.change(screen.getByPlaceholderText(/youtube\.com/), {
      target: { value: "https://example.com/v" },
    });
    fireEvent.change(screen.getByLabelText("Quality"), {
      target: { value: "1080" },
    });
    fireEvent.click(screen.getByRole("button", { name: /download video/i }));

    await act(async () => {});
    expect(mockInvoke).toHaveBeenCalledWith("start_download", {
      request: {
        url: "https://example.com/v",
        mediaType: "video",
        quality: "1080",
        outputDirectory: DEFAULT_DIR,
      },
    });
  });

  it("sends audio with a null quality", async () => {
    await renderReadyApp();

    fireEvent.click(screen.getByRole("radio", { name: "Audio" }));
    fireEvent.change(screen.getByPlaceholderText(/youtube\.com/), {
      target: { value: "https://example.com/v" },
    });
    fireEvent.click(screen.getByRole("button", { name: /download audio/i }));

    await act(async () => {});
    expect(mockInvoke).toHaveBeenCalledWith("start_download", {
      request: {
        url: "https://example.com/v",
        mediaType: "audio",
        quality: null,
        outputDirectory: DEFAULT_DIR,
      },
    });
  });

  it("disables all controls while downloading", async () => {
    mockInvoke.mockImplementation((command: string) => {
      if (command === "get_downloads_dir") {
        return Promise.resolve(DEFAULT_DIR);
      }
      return new Promise(() => {});
    });
    await renderReadyApp();

    fireEvent.change(screen.getByPlaceholderText(/youtube\.com/), {
      target: { value: "https://example.com/v" },
    });
    fireEvent.click(screen.getByRole("button", { name: /download video/i }));
    await act(async () => {});

    expect(screen.getByPlaceholderText(/youtube\.com/)).toBeDisabled();
    expect(screen.getByRole("radio", { name: "Video" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "Audio" })).toBeDisabled();
    expect(screen.getByLabelText("Quality")).toBeDisabled();
    expect(screen.getByLabelText("Output folder")).toBeDisabled();
    expect(screen.getByRole("button", { name: /browse/i })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /downloading/i }),
    ).toBeDisabled();
  });

  it("shows the default output folder on startup", async () => {
    await renderReadyApp();

    const folder = screen.getByLabelText("Output folder") as HTMLInputElement;
    expect(folder.value).toBe(DEFAULT_DIR);
    expect(folder.title).toBe(DEFAULT_DIR);
  });

  it("browse updates the folder, persists it, and sends it", async () => {
    mockDialogOpen.mockResolvedValue(CUSTOM_DIR);
    await renderReadyApp();

    fireEvent.click(screen.getByRole("button", { name: /browse/i }));
    await act(async () => {});

    expect(mockDialogOpen).toHaveBeenCalled();
    const folder = screen.getByLabelText("Output folder") as HTMLInputElement;
    expect(folder.value).toBe(CUSTOM_DIR);
    expect(window.localStorage.getItem("yt-dlp-gui.outputDirectory")).toBe(
      CUSTOM_DIR,
    );

    fireEvent.change(screen.getByPlaceholderText(/youtube\.com/), {
      target: { value: "https://example.com/v" },
    });
    fireEvent.click(screen.getByRole("button", { name: /download video/i }));
    await act(async () => {});
    expect(mockInvoke).toHaveBeenCalledWith("start_download", {
      request: {
        url: "https://example.com/v",
        mediaType: "video",
        quality: "best",
        outputDirectory: CUSTOM_DIR,
      },
    });
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
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("falls back to Downloads for a stale saved folder", async () => {
    window.localStorage.setItem(
      "yt-dlp-gui.outputDirectory",
      "C:\\stale\\gone",
    );
    await renderReadyApp();

    const folder = screen.getByLabelText("Output folder") as HTMLInputElement;
    expect(folder.value).toBe(DEFAULT_DIR);
    expect(
      window.localStorage.getItem("yt-dlp-gui.outputDirectory"),
    ).toBeNull();
  });

  it("success shows the real folder and Open Folder uses it", async () => {
    const handlers = new Map<string, (payload: never) => void>();
    mockListen.mockImplementation((event: string, handler: (p: never) => void) => {
      handlers.set(event, handler);
      return Promise.resolve(vi.fn());
    });
    render(<App />);
    await act(async () => {});

    await act(async () => {
      handlers.get("download-complete")?.({
        payload: {
          filename: "video [abc].mp4",
          filepath: `${CUSTOM_DIR}\\video [abc].mp4`,
          outputDir: CUSTOM_DIR,
        },
      } as never);
    });

    expect(screen.getByText(`Saved to ${CUSTOM_DIR}`)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /open folder/i }));
    await act(async () => {});
    expect(mockInvoke).toHaveBeenCalledWith("open_output_folder", {
      path: CUSTOM_DIR,
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
    mockBackend(report);
    await renderReadyApp();

    expect(screen.getByLabelText(/deno: /i)).toHaveTextContent(/not found|may not work fully/i);
    expect(screen.getByLabelText(/ffmpeg: /i)).toHaveTextContent(/not found|not be mergeable/i);
    // Downloads still allowed: enter URL and the button enables.
    fireEvent.change(screen.getByPlaceholderText(/youtube\.com/), {
      target: { value: "https://example.com/v" },
    });
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
    mockBackend(report);
    await renderReadyApp();

    fireEvent.change(screen.getByPlaceholderText(/youtube\.com/), {
      target: { value: "https://example.com/v" },
    });
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
      ([command]) => command === "start_download",
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
      mockInvoke.mock.calls.filter(([c]) => c === "check_dependencies")
        .length;

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

    fireEvent.change(screen.getByPlaceholderText(/youtube\.com/), {
      target: { value: "https://example.com/v" },
    });
    fireEvent.click(screen.getByRole("button", { name: /download video/i }));
    await act(async () => {});
    expect(mockInvoke).toHaveBeenCalledWith("start_download", {
      request: {
        url: "https://example.com/v",
        mediaType: "video",
        quality: "best",
        outputDirectory: DEFAULT_DIR,
      },
    });
  });
});
