import { Download, Loader2 } from "lucide-react";
import "./DownloadButton.css";

interface DownloadButtonProps {
  disabled: boolean;
  loading: boolean;
  label?: string;
  onClick: () => void;
}

export function DownloadButton({
  disabled,
  loading,
  label,
  onClick,
}: DownloadButtonProps) {
  const text = label ?? (loading ? "Downloading…" : "Download Video");
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
      {text}
    </button>
  );
}
