import { useState } from "react";
import { CheckCircle2, FolderOpen, RotateCcw, XCircle } from "lucide-react";
import { DownloadProgress } from "./DownloadProgress";
import { CancelButton } from "./CancelButton";
import { openOutputFolder } from "../features/downloads/downloadService";
import type { DownloadJob, JobStatus } from "../features/downloads/types";
import "./QueueSection.css";

interface QueueSectionProps {
  jobs: DownloadJob[];
  onCancel: (jobId: number) => void;
  onRemove: (jobId: number) => void;
}

function jobSummary(job: DownloadJob): string {
  const request = job.request;
  if (!request) {
    return "Queued download";
  }
  if (request.mediaType === "audio") {
    const format = request.audioFormat ?? "original";
    const label =
      format === "original" ? "Original" : format.toUpperCase();
    return `Audio • ${label}`;
  }
  const quality =
    !request.quality || request.quality === "best"
      ? "Best"
      : `${request.quality}p`;
  return `Video • ${quality}`;
}

function jobLabel(job: DownloadJob): string {
  if (job.result?.filename) {
    return job.result.filename;
  }
  const url = job.request?.url ?? "";
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "");
    const path = new URL(url).pathname;
    const short = path.length > 28 ? `${path.slice(0, 28)}…` : path;
    return `${hostname}${short}`;
  } catch {
    return url.length > 48 ? `${url.slice(0, 48)}…` : url;
  }
}

function statusTitle(status: JobStatus): string {
  switch (status) {
    case "queued":
      return "Waiting";
    case "downloading":
      return "Downloading";
    case "cancelling":
      return "Cancelling";
    case "success":
      return "Completed";
    case "error":
      return "Failed";
    case "cancelled":
      return "Cancelled";
  }
}

function ActiveRow({
  job,
  onCancel,
}: {
  job: DownloadJob;
  onCancel: (jobId: number) => void;
}) {
  return (
    <li className="qrow" aria-label={`Job ${job.id}: ${statusTitle(job.status)}`}>
      <div className="qrow__header">
        <span className="qrow__status">{statusTitle(job.status)}</span>
        <span className="qrow__summary">{jobSummary(job)}</span>
      </div>
      <div className="qrow__label" title={job.request?.url ?? jobLabel(job)}>
        {jobLabel(job)}
      </div>
      <DownloadProgress progress={job.progress} />
      <CancelButton
        cancelling={job.status === "cancelling"}
        onClick={() => onCancel(job.id)}
      />
      {job.cancelError && (
        <p className="qrow__note qrow__note--error" role="alert">
          {job.cancelError}
        </p>
      )}
    </li>
  );
}

function WaitingRow({
  job,
  onRemove,
}: {
  job: DownloadJob;
  onRemove: (jobId: number) => void;
}) {
  return (
    <li className="qrow" aria-label={`Job ${job.id}: Waiting`}>
      <div className="qrow__header">
        <span className="qrow__status">Waiting</span>
        <span className="qrow__summary">{jobSummary(job)}</span>
      </div>
      <div className="qrow__label" title={job.request?.url ?? jobLabel(job)}>
        {jobLabel(job)}
      </div>
      <button
        type="button"
        className="btn btn--ghost"
        onClick={() => onRemove(job.id)}
      >
        Remove
      </button>
      {job.cancelError && (
        <p className="qrow__note qrow__note--error" role="alert">
          {job.cancelError}
        </p>
      )}
    </li>
  );
}

function TerminalRow({ job }: { job: DownloadJob }) {
  const [openError, setOpenError] = useState<string | null>(null);

  const handleOpen = async () => {
    setOpenError(null);
    if (!job.result?.outputDir) {
      setOpenError("The output folder is no longer known.");
      return;
    }
    try {
      await openOutputFolder(job.result.outputDir);
    } catch {
      setOpenError("Could not open the output folder.");
    }
  };

  return (
    <li
      className={
        job.status === "error"
          ? "qrow qrow--error"
          : "qrow qrow--terminal"
      }
      aria-label={`Job ${job.id}: ${statusTitle(job.status)}`}
    >
      <div className="qrow__header">
        {job.status === "success" ? (
          <CheckCircle2 size={15} className="qrow__icon qrow__icon--ok" aria-hidden="true" />
        ) : job.status === "error" ? (
          <XCircle size={15} className="qrow__icon qrow__icon--error" aria-hidden="true" />
        ) : (
          <RotateCcw size={15} className="qrow__icon qrow__icon--muted" aria-hidden="true" />
        )}
        <span className="qrow__status">{statusTitle(job.status)}</span>
        <span className="qrow__summary">{jobSummary(job)}</span>
      </div>
      {job.result?.filename && (
        <div className="qrow__label" title={job.result.filename}>
          {job.result.filename}
        </div>
      )}
      {job.errorMessage && (
        <div className="qrow__message">{job.errorMessage}</div>
      )}
      {job.errorDetails && job.status === "error" && (
        <pre className="qrow__details">{job.errorDetails}</pre>
      )}
      {job.result?.outputDir && job.status === "success" && (
        <div className="qrow__message qrow__location" title={job.result.outputDir}>
          Saved to {job.result.outputDir}
        </div>
      )}
      {job.status === "success" && (
        <button type="button" className="btn btn--secondary" onClick={handleOpen}>
          <FolderOpen size={15} />
          Open Folder
        </button>
      )}
      {openError && (
        <p className="qrow__note qrow__note--error" role="alert">
          {openError}
        </p>
      )}
    </li>
  );
}

export function QueueSection({ jobs, onCancel, onRemove }: QueueSectionProps) {
  if (jobs.length === 0) {
    return null;
  }
  return (
    <section className="queue" aria-label="Download queue">
      <h2 className="queue__title">Queue</h2>
      <ol className="queue__list">
        {jobs.map((job) =>
          job.status === "downloading" || job.status === "cancelling" ? (
            <ActiveRow key={job.id} job={job} onCancel={onCancel} />
          ) : job.status === "queued" ? (
            <WaitingRow key={job.id} job={job} onRemove={onRemove} />
          ) : (
            <TerminalRow key={job.id} job={job} />
          ),
        )}
      </ol>
    </section>
  );
}
