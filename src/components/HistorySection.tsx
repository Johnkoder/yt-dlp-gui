import { useState } from "react";
import { CheckCircle2, FolderOpen, RotateCcw, Trash2, XCircle } from "lucide-react";
import { openOutputFolder } from "../features/downloads/downloadService";
import type { HistoryEntry, HistoryStatus } from "../features/history/types";
import "./HistorySection.css";

export interface HistorySectionProps {
  entries: HistoryEntry[];
  isClearing?: boolean;
  clearError?: string | null;
  onClearHistory: () => Promise<boolean>;
}

function historySummary(entry: HistoryEntry): string {
  if (entry.mediaType === "audio") {
    const format = entry.audioFormat ?? "original";
    const label = format === "original" ? "Original" : format.toUpperCase();
    return `Audio • ${label}`;
  }
  const quality =
    !entry.quality || entry.quality === "best"
      ? "Best"
      : `${entry.quality}p`;
  return `Video • ${quality}`;
}

function historyLabel(entry: HistoryEntry): string {
  if (entry.filename) {
    return entry.filename;
  }
  const url = entry.url;
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.replace(/^www\./, "");
    const path = parsed.pathname;
    const short = path.length > 28 ? `${path.slice(0, 28)}…` : path;
    return `${hostname}${short}`;
  } catch {
    return url.length > 48 ? `${url.slice(0, 48)}…` : url;
  }
}

function statusTitle(status: HistoryStatus): string {
  switch (status) {
    case "success":
      return "Completed";
    case "error":
      return "Failed";
    case "cancelled":
      return "Cancelled";
  }
}

function formatTimestamp(timestampMs: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "short",
      timeStyle: "short",
    }).format(new Date(timestampMs));
  } catch {
    return new Date(timestampMs).toLocaleString();
  }
}

function HistoryRow({ entry }: { entry: HistoryEntry }) {
  const [openError, setOpenError] = useState<string | null>(null);

  const handleOpen = async () => {
    setOpenError(null);
    if (!entry.outputDirectory) {
      setOpenError("The output folder is no longer known.");
      return;
    }
    try {
      await openOutputFolder(entry.outputDirectory);
    } catch {
      setOpenError("Could not open the output folder.");
    }
  };

  const isSuccess = entry.status === "success";
  const isError = entry.status === "error";

  return (
    <li
      className={isError ? "hrow hrow--error" : "hrow"}
      aria-label={`History item ${entry.id}: ${statusTitle(entry.status)}`}
    >
      <div className="hrow__header">
        {isSuccess ? (
          <CheckCircle2 size={15} className="hrow__icon hrow__icon--ok" aria-hidden="true" />
        ) : isError ? (
          <XCircle size={15} className="hrow__icon hrow__icon--error" aria-hidden="true" />
        ) : (
          <RotateCcw size={15} className="hrow__icon hrow__icon--muted" aria-hidden="true" />
        )}
        <span className="hrow__status">{statusTitle(entry.status)}</span>
        <span className="hrow__summary">{historySummary(entry)}</span>
        <span className="hrow__time">{formatTimestamp(entry.timestampMs)}</span>
      </div>

      <div className="hrow__label" title={entry.filename ?? entry.url}>
        {historyLabel(entry)}
      </div>

      {entry.message && (
        <div className="hrow__message">{entry.message}</div>
      )}

      {isSuccess && entry.outputDirectory && (
        <div className="hrow__message hrow__location" title={entry.outputDirectory}>
          Saved to {entry.outputDirectory}
        </div>
      )}

      {isSuccess && (
        <button
          type="button"
          className="btn btn--secondary"
          onClick={handleOpen}
          aria-label={`Open folder for ${entry.filename ?? "download"}`}
        >
          <FolderOpen size={15} />
          Open Folder
        </button>
      )}

      {openError && (
        <p className="hrow__note hrow__note--error" role="alert">
          {openError}
        </p>
      )}
    </li>
  );
}

export function HistorySection({
  entries,
  isClearing = false,
  clearError = null,
  onClearHistory,
}: HistorySectionProps) {
  const [isConfirming, setIsConfirming] = useState(false);

  const handleConfirmClear = async () => {
    const success = await onClearHistory();
    if (success) {
      setIsConfirming(false);
    }
  };

  const handleCancelClear = () => {
    setIsConfirming(false);
  };

  return (
    <section className="history" aria-label="Download history">
      <div className="history__header">
        <div className="history__title-wrap">
          <h2 className="history__title">History</h2>
          {entries.length > 0 && (
            <span className="history__badge" aria-label={`${entries.length} items`}>
              {entries.length}
            </span>
          )}
        </div>

        {entries.length > 0 && (
          <div className="history__actions">
            {isConfirming ? (
              <div className="history__confirm" role="group" aria-label="Confirm clear history">
                <span>Clear all history?</span>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={handleConfirmClear}
                  disabled={isClearing}
                >
                  {isClearing ? "Clearing…" : "Confirm"}
                </button>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={handleCancelClear}
                  disabled={isClearing}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => setIsConfirming(true)}
                disabled={isClearing}
                aria-label="Clear History"
              >
                <Trash2 size={14} />
                Clear History
              </button>
            )}
          </div>
        )}
      </div>

      {clearError && (
        <p className="hrow__note hrow__note--error" role="alert">
          {clearError}
        </p>
      )}

      {entries.length === 0 ? (
        <p className="history__empty">No download history yet.</p>
      ) : (
        <ol className="history__list">
          {entries.map((entry) => (
            <HistoryRow key={entry.id} entry={entry} />
          ))}
        </ol>
      )}
    </section>
  );
}
