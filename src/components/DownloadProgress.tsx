import type { DownloadProgressEvent } from "../features/downloads/types";
import "./DownloadProgress.css";

interface DownloadProgressProps {
  progress: DownloadProgressEvent | null;
}

function formatMeta(progress: DownloadProgressEvent): string | null {
  const parts: string[] = [];
  if (progress.speed) parts.push(progress.speed);
  if (progress.eta) parts.push(`${progress.eta} remaining`);
  if (parts.length === 0) return null;
  return parts.join(" • ");
}

export function DownloadProgress({ progress }: DownloadProgressProps) {
  const pct =
    progress?.percentage !== null && progress?.percentage !== undefined
      ? Math.max(0, Math.min(100, progress.percentage))
      : null;
  const meta = progress ? formatMeta(progress) : null;

  return (
    <div className="progress-card" aria-live="polite">
      <div className="progress-card__header">
        <span className="progress-card__status">
          {progress?.status ?? "Downloading"}
        </span>
        {pct !== null && (
          <span className="progress-card__pct">{pct.toFixed(1)}%</span>
        )}
      </div>
      {progress?.filename && (
        <div className="progress-card__filename" title={progress.filename}>
          {progress.filename}
        </div>
      )}
      <div
        className="progress-bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct ?? undefined}
      >
        <div
          className={
            pct !== null ? "progress-bar__fill" : "progress-bar__fill--indeterminate"
          }
          style={pct !== null ? { width: `${pct}%` } : undefined}
        />
      </div>
      {meta && <div className="progress-card__meta">{meta}</div>}
      {pct === null && !meta && progress?.status && (
        <div className="progress-card__meta progress-card__meta--raw">
          Reading download status…
        </div>
      )}
    </div>
  );
}
