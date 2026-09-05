import { useState } from "react";
import { CheckCircle2, FolderOpen, RotateCcw, XCircle } from "lucide-react";
import { openOutputFolder } from "../features/downloads/downloadService";
import type { DownloadResult } from "../features/downloads/types";
import "./StatusMessage.css";

interface StatusMessageProps {
  kind: "success" | "error";
  title: string;
  message?: string | null;
  details?: string | null;
  result?: DownloadResult | null;
  /** Null hides the reset action (e.g. unrecoverable init failure). */
  onReset?: (() => void) | null;
}

export function StatusMessage({
  kind,
  title,
  message,
  details,
  result,
  onReset,
}: StatusMessageProps) {
  const [openError, setOpenError] = useState<string | null>(null);

  const handleOpen = async () => {
    setOpenError(null);
    if (!result?.outputDir) {
      setOpenError("The output folder is no longer known.");
      return;
    }
    try {
      await openOutputFolder(result.outputDir);
    } catch {
      setOpenError("Could not open the output folder.");
    }
  };

  return (
    <div
      className={
        kind === "success"
          ? "status status--success"
          : "status status--error"
      }
      role={kind === "error" ? "alert" : "status"}
    >
      <div className="status__row">
        {kind === "success" ? (
          <CheckCircle2 size={18} className="status__icon status__icon--success" />
        ) : (
          <XCircle size={18} className="status__icon status__icon--error" />
        )}
        <div className="status__text">
          <div className="status__title">{title}</div>
          {result?.filename && (
            <div className="status__filename" title={result.filename}>
              {result.filename}
            </div>
          )}
          {message && <div className="status__message">{message}</div>}
          {kind === "success" && result?.outputDir && (
            <div className="status__message status__location" title={result.outputDir}>
              Saved to {result.outputDir}
            </div>
          )}
        </div>
      </div>

      {details && kind === "error" && (
        <pre className="status__details">{details}</pre>
      )}

      <div className="status__actions">
        {kind === "success" && (
          <button type="button" className="btn btn--secondary" onClick={handleOpen}>
            <FolderOpen size={15} />
            Open Folder
          </button>
        )}
        {onReset && (
          <button
            type="button"
            className={
              kind === "success" ? "btn btn--ghost" : "btn btn--secondary"
            }
            onClick={onReset}
          >
            <RotateCcw size={15} />
            {kind === "success" ? "Download another" : "Try again"}
          </button>
        )}
      </div>

      {openError && (
        <div className="status__message status__message--error" role="alert">
          {openError}
        </div>
      )}
    </div>
  );
}
