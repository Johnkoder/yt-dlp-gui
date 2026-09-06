/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HistorySection } from "./HistorySection";
import * as downloadService from "../features/downloads/downloadService";
import type { HistoryEntry } from "../features/history/types";

vi.mock("../features/downloads/downloadService", () => ({
  openOutputFolder: vi.fn(),
}));

describe("HistorySection component", () => {
  const mockOnClearHistory = vi.fn();

  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders empty state when there are no entries", () => {
    render(
      <HistorySection
        entries={[]}
        onClearHistory={mockOnClearHistory}
      />,
    );

    expect(screen.getByText("History")).toBeInTheDocument();
    expect(screen.getByText("No download history yet.")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /clear history/i }),
    ).not.toBeInTheDocument();
  });

  it("renders history entries with appropriate badges and summaries", () => {
    const entries: HistoryEntry[] = [
      {
        id: 1,
        timestampMs: 1672531199000,
        url: "https://example.com/watch?v=1",
        mediaType: "video",
        quality: "1080",
        audioFormat: null,
        outputDirectory: "C:\\Downloads",
        status: "success",
        filename: "video1.mp4",
        filepath: "C:\\Downloads\\video1.mp4",
        message: null,
      },
      {
        id: 2,
        timestampMs: 1672531200000,
        url: "https://example.com/watch?v=2",
        mediaType: "audio",
        quality: null,
        audioFormat: "mp3",
        outputDirectory: "C:\\Music",
        status: "error",
        filename: null,
        filepath: null,
        message: "Format unavailable",
      },
      {
        id: 3,
        timestampMs: 1672531201000,
        url: "https://example.com/watch?v=3",
        mediaType: "video",
        quality: "best",
        audioFormat: null,
        outputDirectory: "C:\\Downloads",
        status: "cancelled",
        filename: null,
        filepath: null,
        message: "Download cancelled by user",
      },
    ];

    render(
      <HistorySection
        entries={entries}
        onClearHistory={mockOnClearHistory}
      />,
    );

    expect(screen.getByText("History")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();

    expect(screen.getByText("video1.mp4")).toBeInTheDocument();
    expect(screen.getByText("Video • 1080p")).toBeInTheDocument();
    expect(screen.getByText("Completed")).toBeInTheDocument();
    expect(screen.getByText("Saved to C:\\Downloads")).toBeInTheDocument();

    expect(screen.getByText("Audio • MP3")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("Format unavailable")).toBeInTheDocument();

    expect(screen.getByText("Video • Best")).toBeInTheDocument();
    expect(screen.getByText("Cancelled")).toBeInTheDocument();
    expect(screen.getByText("Download cancelled by user")).toBeInTheDocument();
  });

  it("handles Open Folder button clicks", async () => {
    const entries: HistoryEntry[] = [
      {
        id: 1,
        timestampMs: 1672531199000,
        url: "https://example.com/watch?v=1",
        mediaType: "video",
        quality: "1080",
        audioFormat: null,
        outputDirectory: "C:\\Downloads",
        status: "success",
        filename: "video1.mp4",
        filepath: "C:\\Downloads\\video1.mp4",
        message: null,
      },
    ];

    vi.mocked(downloadService.openOutputFolder).mockResolvedValueOnce();

    render(
      <HistorySection
        entries={entries}
        onClearHistory={mockOnClearHistory}
      />,
    );

    const openBtn = screen.getByRole("button", { name: /open folder/i });
    fireEvent.click(openBtn);

    expect(downloadService.openOutputFolder).toHaveBeenCalledWith(
      "C:\\Downloads",
    );
  });

  it("displays error message if openOutputFolder fails", async () => {
    const entries: HistoryEntry[] = [
      {
        id: 1,
        timestampMs: 1672531199000,
        url: "https://example.com/watch?v=1",
        mediaType: "video",
        quality: "1080",
        audioFormat: null,
        outputDirectory: "C:\\Downloads",
        status: "success",
        filename: "video1.mp4",
        filepath: "C:\\Downloads\\video1.mp4",
        message: null,
      },
    ];

    vi.mocked(downloadService.openOutputFolder).mockRejectedValueOnce(
      new Error("Folder not found"),
    );

    render(
      <HistorySection
        entries={entries}
        onClearHistory={mockOnClearHistory}
      />,
    );

    const openBtn = screen.getByRole("button", { name: /open folder/i });
    fireEvent.click(openBtn);

    await waitFor(() => {
      expect(
        screen.getByText("Could not open the output folder."),
      ).toBeInTheDocument();
    });
  });

  it("requires confirmation before calling onClearHistory", async () => {
    const entries: HistoryEntry[] = [
      {
        id: 1,
        timestampMs: 1672531199000,
        url: "https://example.com/watch?v=1",
        mediaType: "video",
        quality: "1080",
        audioFormat: null,
        outputDirectory: "C:\\Downloads",
        status: "success",
        filename: "video1.mp4",
        filepath: "C:\\Downloads\\video1.mp4",
        message: null,
      },
    ];

    mockOnClearHistory.mockResolvedValueOnce(true);

    render(
      <HistorySection
        entries={entries}
        onClearHistory={mockOnClearHistory}
      />,
    );

    const clearBtn = screen.getByRole("button", { name: /clear history/i });
    fireEvent.click(clearBtn);

    expect(screen.getByText("Clear all history?")).toBeInTheDocument();
    expect(mockOnClearHistory).not.toHaveBeenCalled();

    const cancelBtn = screen.getByRole("button", { name: /cancel/i });
    fireEvent.click(cancelBtn);

    // Cancelled: reverts back
    expect(
      screen.getByRole("button", { name: /clear history/i }),
    ).toBeInTheDocument();
    expect(mockOnClearHistory).not.toHaveBeenCalled();

    // Now click Clear History and Confirm
    fireEvent.click(screen.getByRole("button", { name: /clear history/i }));
    const confirmBtn = screen.getByRole("button", { name: /confirm/i });
    fireEvent.click(confirmBtn);

    expect(mockOnClearHistory).toHaveBeenCalledTimes(1);
  });

  it("renders clearError if provided", () => {
    render(
      <HistorySection
        entries={[]}
        clearError="Failed to clear history"
        onClearHistory={mockOnClearHistory}
      />,
    );

    expect(screen.getByText("Failed to clear history")).toBeInTheDocument();
  });
});
