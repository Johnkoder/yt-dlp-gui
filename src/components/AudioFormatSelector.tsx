import { ChevronDown } from "lucide-react";
import {
  AUDIO_FORMATS,
  AUDIO_FORMAT_LABELS,
  type AudioFormat,
} from "../features/downloads/options";
import "./QualitySelector.css";

interface AudioFormatSelectorProps {
  value: AudioFormat;
  onChange: (value: AudioFormat) => void;
  disabled: boolean;
  /** False while FFmpeg status is unknown/missing/error: conversions lock. */
  conversionsEnabled: boolean;
}

export function AudioFormatSelector({
  value,
  onChange,
  disabled,
  conversionsEnabled,
}: AudioFormatSelectorProps) {
  return (
    <div className="field">
      <label className="field__label" htmlFor="audio-format">
        Audio format
      </label>
      <div className="select-wrap">
        <select
          id="audio-format"
          className="select"
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value as AudioFormat)}
        >
          {AUDIO_FORMATS.map((option) => {
            const needsFfmpeg = option !== "original";
            const locked = needsFfmpeg && !conversionsEnabled;
            return (
              <option key={option} value={option} disabled={locked}>
                {AUDIO_FORMAT_LABELS[option]}
                {locked ? " — FFmpeg required" : ""}
              </option>
            );
          })}
        </select>
        <ChevronDown
          size={15}
          className="select-wrap__chevron"
          aria-hidden="true"
        />
      </div>
    </div>
  );
}
