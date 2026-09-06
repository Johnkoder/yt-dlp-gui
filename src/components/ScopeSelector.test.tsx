/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScopeSelector } from "./ScopeSelector";

afterEach(() => {
  cleanup();
});

describe("ScopeSelector", () => {
  it("renders both Single item and Playlist options", () => {
    render(
      <ScopeSelector value="single" onChange={vi.fn()} disabled={false} />,
    );

    const singleButton = screen.getByRole("radio", { name: "Single item" });
    const playlistButton = screen.getByRole("radio", { name: "Playlist" });

    expect(singleButton).toBeInTheDocument();
    expect(playlistButton).toBeInTheDocument();
    expect(singleButton).toHaveAttribute("aria-checked", "true");
    expect(playlistButton).toHaveAttribute("aria-checked", "false");
  });

  it("calls onChange when an unselected option is clicked", () => {
    const onChange = vi.fn();
    render(
      <ScopeSelector value="single" onChange={onChange} disabled={false} />,
    );

    fireEvent.click(screen.getByRole("radio", { name: "Playlist" }));
    expect(onChange).toHaveBeenCalledWith("playlist");
  });

  it("navigates via arrow keys and calls onChange", () => {
    const onChange = vi.fn();
    render(
      <ScopeSelector value="single" onChange={onChange} disabled={false} />,
    );

    const radiogroup = screen.getByRole("radiogroup");
    fireEvent.keyDown(radiogroup, { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith("playlist");

    onChange.mockClear();
    fireEvent.keyDown(radiogroup, { key: "ArrowLeft" });
    expect(onChange).toHaveBeenCalledWith("playlist");
  });

  it("disables all radio buttons when disabled is true", () => {
    render(
      <ScopeSelector value="single" onChange={vi.fn()} disabled={true} />,
    );

    expect(screen.getByRole("radio", { name: "Single item" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "Playlist" })).toBeDisabled();
  });
});
