import { useCallback, useEffect, useRef, useState } from "react";
import { checkDependencies } from "../dependencyService";
import type { DependencyReport } from "../types";

export type DependencyCheckStatus =
  | "idle"
  | "loading"
  | "ready"
  | "error";

export interface UseDependenciesState {
  status: DependencyCheckStatus;
  report: DependencyReport | null;
  errorMessage: string | null;
  errorDetails: string | null;
  refresh: () => Promise<void>;
}

/**
 * Owns dependency checking, independent from the download lifecycle:
 * refreshing here never touches event subscriptions or download state.
 * Checks once on mount; afterwards only on explicit Refresh. No polling.
 */
export function useDependencies(): UseDependenciesState {
  const [status, setStatus] =
    useState<DependencyCheckStatus>("idle");
  const [report, setReport] = useState<DependencyReport | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorDetails, setErrorDetails] = useState<string | null>(null);
  const statusRef = useRef<DependencyCheckStatus>("idle");
  statusRef.current = status;

  const refresh = useCallback(async () => {
    if (statusRef.current === "loading") {
      return;
    }
    setStatus("loading");
    setErrorMessage(null);
    try {
      const next = await checkDependencies();
      setReport(next);
      setStatus("ready");
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : String(err);
      setErrorMessage(
        "Could not check dependencies. The application backend may be unreachable.",
      );
      // Keep the previous report (if any) visible alongside the error.
      setErrorDetails(raw);
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { status, report, errorMessage, errorDetails, refresh };
}
