import { FolderOpen } from "lucide-react";
import "./OutputFolderSelector.css";

interface OutputFolderSelectorProps {
  /** Resolved folder, or null while startup initialization is pending. */
  value: string | null;
  onBrowse: () => void;
  disabled: boolean;
}

export function OutputFolderSelector({
  value,
  onBrowse,
  disabled,
}: OutputFolderSelectorProps) {
  return (
    <div className="field">
      <label className="field__label" htmlFor="output-folder">
        Save to
      </label>
      <div className="folder-row">
        <input
          id="output-folder"
          className="folder-input"
          type="text"
          readOnly
          tabIndex={0}
          value={value ?? "Loading…"}
          title={value ?? "Resolving output folder…"}
          aria-label="Output folder"
          disabled={disabled || value === null}
          onFocus={(e) => e.target.select()}
        />
        <button
          type="button"
          className="browse-button"
          disabled={disabled}
          onClick={onBrowse}
        >
          <FolderOpen size={15} strokeWidth={2} />
          Browse
        </button>
      </div>
    </div>
  );
}
