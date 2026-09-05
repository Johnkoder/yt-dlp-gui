import { useCallback } from "react";
import {
  MEDIA_TYPES,
  MEDIA_TYPE_LABELS,
  type MediaType,
} from "../features/downloads/options";
import "./MediaTypeSelector.css";

interface MediaTypeSelectorProps {
  value: MediaType;
  onChange: (value: MediaType) => void;
  disabled: boolean;
}

/**
 * Compact segmented control for the download type. Uses the radiogroup
 * pattern: Tab moves into the group, arrows move between options.
 */
export function MediaTypeSelector({
  value,
  onChange,
  disabled,
}: MediaTypeSelectorProps) {
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (disabled) {
        return;
      }
      const index = MEDIA_TYPES.indexOf(value);
      if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        event.preventDefault();
        onChange(MEDIA_TYPES[(index + 1) % MEDIA_TYPES.length]);
      } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        event.preventDefault();
        onChange(
          MEDIA_TYPES[(index - 1 + MEDIA_TYPES.length) % MEDIA_TYPES.length],
        );
      }
    },
    [value, onChange, disabled],
  );

  return (
    <div className="field">
      <span className="field__label" id="download-type-label">
        Download type
      </span>
      <div
        className="segmented"
        role="radiogroup"
        aria-labelledby="download-type-label"
        onKeyDown={handleKeyDown}
      >
        {MEDIA_TYPES.map((option) => (
          <button
            key={option}
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
            {MEDIA_TYPE_LABELS[option]}
          </button>
        ))}
      </div>
    </div>
  );
}
