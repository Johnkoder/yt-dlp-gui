import { ChevronDown } from "lucide-react";
import {
  VIDEO_QUALITIES,
  VIDEO_QUALITY_LABELS,
  type VideoQuality,
} from "../features/downloads/options";
import "./QualitySelector.css";

interface QualitySelectorProps {
  value: VideoQuality;
  onChange: (value: VideoQuality) => void;
  disabled: boolean;
}

export function QualitySelector({
  value,
  onChange,
  disabled,
}: QualitySelectorProps) {
  return (
    <div className="field">
      <label className="field__label" htmlFor="video-quality">
        Quality
      </label>
      <div className="select-wrap">
        <select
          id="video-quality"
          className="select"
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value as VideoQuality)}
        >
          {VIDEO_QUALITIES.map((option) => (
            <option key={option} value={option}>
              {VIDEO_QUALITY_LABELS[option]}
            </option>
          ))}
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
