import { useCallback, useRef } from "react";
import type { DownloadScope } from "../features/downloads/types";
import "./ScopeSelector.css";

const SCOPES: DownloadScope[] = ["single", "playlist"];

const SCOPE_LABELS: Record<DownloadScope, string> = {
  single: "Single item",
  playlist: "Playlist",
};

interface ScopeSelectorProps {
  value: DownloadScope;
  onChange: (value: DownloadScope) => void;
  disabled: boolean;
}

/**
 * Compact segmented control for the download scope (Single item vs Playlist).
 * Uses the radiogroup pattern: Tab moves into the group, arrows move between options.
 */
export function ScopeSelector({
  value,
  onChange,
  disabled,
}: ScopeSelectorProps) {
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (disabled) {
        return;
      }
      const index = SCOPES.indexOf(value);
      let next: number | null = null;
      if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        next = (index + 1) % SCOPES.length;
      } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        next = (index - 1 + SCOPES.length) % SCOPES.length;
      }
      if (next !== null) {
        event.preventDefault();
        onChange(SCOPES[next]);
        buttonRefs.current[next]?.focus();
      }
    },
    [value, onChange, disabled],
  );

  return (
    <div className="field">
      <span className="field__label" id="download-scope-label">
        Download scope
      </span>
      <div
        className="segmented"
        role="radiogroup"
        aria-labelledby="download-scope-label"
        onKeyDown={handleKeyDown}
      >
        {SCOPES.map((option, index) => (
          <button
            key={option}
            ref={(element) => {
              buttonRefs.current[index] = element;
            }}
            type="button"
            role="radio"
            aria-checked={value === option}
            tabIndex={value === option ? 0 : -1}
            disabled={disabled}
            className={
              value === option
                ? "segmented__option segmented__option--active"
                : "segmented__option"
            }
            onClick={() => onChange(option)}
          >
            {SCOPE_LABELS[option]}
          </button>
        ))}
      </div>
    </div>
  );
}
