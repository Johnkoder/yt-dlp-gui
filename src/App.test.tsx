/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

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

function activeListen() {
  mockListen
    .mockResolvedValueOnce(vi.fn())
    .mockResolvedValueOnce(vi.fn())
    .mockResolvedValueOnce(vi.fn());
}

/** Route mocked backend commands; stale paths fail validation. */
function mockBackend() {
  mockInvoke.mockImplementation((command: string, args?: unknown) => {
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
  });
}

async function renderReadyApp() {
  activeListen();
  render(<App />);
  // Flush subscription + output-folder init: initializing -> ready.
  await act(async () => {});
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
