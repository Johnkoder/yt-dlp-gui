import { AlertTriangle, CheckCircle2, RefreshCw, XCircle } from "lucide-react";
import type {
  DependencyInfo,
  DependencyReport,
} from "../features/dependencies/types";
import type { DependencyCheckStatus } from "../features/dependencies/hooks/useDependencies";
import "./DependencySection.css";

interface DependencySectionProps {
  status: DependencyCheckStatus;
  report: DependencyReport | null;
  errorMessage: string | null;
  onRefresh: () => void;
}

function StatusIcon({ state }: { state: DependencyInfo["state"] }) {
  if (state === "available") {
    return (
      <CheckCircle2
        size={15}
        className="dep__icon dep__icon--ok"
        aria-hidden="true"
      />
    );
  }
  if (state === "missing") {
    return (
      <XCircle size={15} className="dep__icon dep__icon--missing" aria-hidden="true" />
    );
  }
  return (
    <AlertTriangle
      size={15}
      className="dep__icon dep__icon--error"
      aria-hidden="true"
    />
  );
}

function rowText(info: DependencyInfo): string {
  if (info.state === "available") {
    const extra = info.message ? ` • ${info.message}` : "";
    return info.version ? `${info.version}${extra}` : `Available${extra}`;
  }
  return info.message ?? (info.state === "missing" ? "Not found" : "Error");
}

function DependencyRow({ info }: { info: DependencyInfo }) {
  const detail = [info.path, info.message].filter(Boolean).join("\n");
  return (
    <li
      className="dep"
      title={detail || undefined}
      aria-label={`${info.name}: ${rowText(info)}`}
    >
      <StatusIcon state={info.state} />
      <span className="dep__name">{info.name}</span>
      <span className="dep__value">{rowText(info)}</span>
    </li>
  );
}

export function DependencySection({
  status,
  report,
  errorMessage,
  onRefresh,
}: DependencySectionProps) {
  const checking = status === "loading" || status === "idle";
  return (
    <section className="deps" aria-label="Dependencies">
      <div className="deps__header">
        <h2 className="deps__title">Dependencies</h2>
        <button
          type="button"
          className="deps__refresh"
          onClick={onRefresh}
          disabled={checking}
          title="Re-check dependencies"
        >
          <RefreshCw
            size={13}
            className={checking ? "spin" : undefined}
            aria-hidden="true"
          />
          Refresh
        </button>
      </div>
      {checking && !report && (
        <p className="deps__note">Checking dependencies…</p>
      )}
      {status === "error" && errorMessage && (
        <p className="deps__note deps__note--error" role="alert">
          {errorMessage}
        </p>
      )}
      {report && (
        <ul className="deps__list">
          <DependencyRow info={report.ytDlp} />
          <DependencyRow info={report.deno} />
          <DependencyRow info={report.ffmpeg} />
        </ul>
      )}
    </section>
  );
}
