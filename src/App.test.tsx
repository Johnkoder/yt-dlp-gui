/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

const { mockInvoke, mockListen } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockListen: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mockListen }));

function activeListen() {
  mockListen
    .mockResolvedValueOnce(vi.fn())
    .mockResolvedValueOnce(vi.fn())
    .mockResolvedValueOnce(vi.fn());
}

async function renderReadyApp() {
  activeListen();
  render(<App />);
  // Flush the subscription promises: initializing -> ready.
  await act(async () => {});
}

beforeEach(() => {
  mockInvoke.mockReset().mockResolvedValue(undefined);
  mockListen.mockReset();
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
      },
    });
  });

  it("disables all controls while downloading", async () => {
    mockInvoke.mockImplementation(() => new Promise(() => {}));
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
    expect(
      screen.getByRole("button", { name: /downloading/i }),
    ).toBeDisabled();
  });
});
