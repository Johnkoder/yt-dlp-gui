import { Download, Loader2 } from "lucide-react";
import "./DownloadButton.css";

interface DownloadButtonProps {
  disabled: boolean;
  loading: boolean;
  onClick: () => void;
}

export function DownloadButton({ disabled, loading, onClick }: DownloadButtonProps) {
  return (
    <button
      type="button"
      className="download-button"
      disabled={disabled || loading}
      onClick={onClick}
    >
      {loading ? (
        <Loader2 size={16} strokeWidth={2.25} className="spin" />
      ) : (
        <Download size={16} strokeWidth={2.25} />
      )}
      {loading ? "Downloading…" : "Download Video"}
    </button>
  );
}
