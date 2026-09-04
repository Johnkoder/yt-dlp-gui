import { ClipboardPaste } from "lucide-react";
import "./UrlInput.css";

interface UrlInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  disabled: boolean;
}

export function UrlInput({ value, onChange, onSubmit, disabled }: UrlInputProps) {
  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        onChange(text.trim());
      }
    } catch {
      // Clipboard access may be denied; user can paste manually with Ctrl+V.
    }
  };

  return (
    <div className="field">
      <label className="field__label" htmlFor="video-url">
        Video URL
      </label>
      <div className="url-row">
        <input
          id="video-url"
          className="url-input"
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="https://www.youtube.com/watch?v=..."
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && value.trim().length > 0 && !disabled) {
              onSubmit();
            }
          }}
        />
        <button
          type="button"
          className="paste-button"
          title="Paste from clipboard"
          aria-label="Paste from clipboard"
          disabled={disabled}
          onClick={handlePaste}
        >
          <ClipboardPaste size={16} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}
