import { useCallback, useRef } from "react";
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
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (disabled) {
        return;
      }
      const index = MEDIA_TYPES.indexOf(value);
      let next: number | null = null;
      if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        next = (index + 1) % MEDIA_TYPES.length;
      } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        next = (index - 1 + MEDIA_TYPES.length) % MEDIA_TYPES.length;
      }
      if (next !== null) {
        event.preventDefault();
        onChange(MEDIA_TYPES[next]);
        // Radiogroup pattern: arrows move selection AND focus together.
        buttonRefs.current[next]?.focus();
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
        {MEDIA_TYPES.map((option, index) => (
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
            {MEDIA_TYPE_LABELS[option]}
          </button>
        ))}
      </div>
    </div>
  );
}
