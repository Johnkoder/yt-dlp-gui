import { useCallback, useEffect, useRef, useState } from "react";
import {
  friendlyErrorMessage,
  startDownload,
  subscribeToDownloadEvents,
} from "../downloadService";
import type {
  DownloadError,
  DownloadProgressEvent,
  DownloadResult,
  DownloadStatus,
} from "../types";

export interface UseDownloadState {
  status: DownloadStatus;
  url: string;
  setUrl: (url: string) => void;
  progress: DownloadProgressEvent | null;
  result: DownloadResult | null;
  errorMessage: string | null;
  errorDetails: string | null;
  canDownload: boolean;
  handleDownload: () => Promise<void>;
  handleReset: () => void;
}

/**
 * Owns the MVP download state machine: idle -> downloading -> success | error.
 * Subscribes once to backend Tauri events and updates state in real time.
 */
export function useDownload(): UseDownloadState {
  const [status, setStatus] = useState<DownloadStatus>("idle");
  const [url, setUrlState] = useState("");
  const [progress, setProgress] = useState<DownloadProgressEvent | null>(null);
  const [result, setResult] = useState<DownloadResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorDetails, setErrorDetails] = useState<string | null>(null);
  const [invokeError, setInvokeError] = useState<string | null>(null);
  const statusRef = useRef<DownloadStatus>("idle");
  statusRef.current = status;

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    subscribeToDownloadEvents({
      onProgress: (payload) => {
        if (cancelled) return;
        setProgress(payload);
        if (statusRef.current !== "downloading") {
          setStatus("downloading");
        }
      },
      onComplete: (payload: DownloadResult) => {
        if (cancelled) return;
        setResult(payload);
        setErrorMessage(null);
        setErrorDetails(null);
        setStatus("success");
      },
      onError: (payload: DownloadError) => {
        if (cancelled) return;
        setErrorMessage(friendlyErrorMessage(payload.message));
        setErrorDetails(payload.details ?? payload.message);
        setStatus("error");
      },
    })
      .then((fn) => {
        if (!cancelled) {
          unlisten = fn;
        } else {
          fn();
        }
      })
      .catch((err: unknown) => {
        // Event subscription itself failed; surface as an error state only
        // if the user attempts a download.
        setInvokeError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const setUrl = useCallback((value: string) => {
    setUrlState(value);
  }, []);

  const trimmedUrl = url.trim();
  const canDownload =
    status !== "downloading" && trimmedUrl.length > 0;

  const handleDownload = useCallback(async () => {
    const target = url.trim();
    if (target.length === 0 || statusRef.current === "downloading") {
      return;
    }
    setProgress(null);
    setResult(null);
    setErrorMessage(null);
    setErrorDetails(null);
    setInvokeError(null);
    setStatus("downloading");
    try {
      await startDownload(target);
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : String(err);
      setErrorMessage(friendlyErrorMessage(raw));
      setErrorDetails(raw);
      setStatus("error");
    }
  }, [url]);

  const handleReset = useCallback(() => {
    if (statusRef.current === "downloading") {
      return;
    }
    setProgress(null);
    setResult(null);
    setErrorMessage(null);
    setErrorDetails(null);
    setStatus("idle");
  }, []);

  return {
    status,
    url,
    setUrl,
    progress,
    result,
    errorMessage: invokeError && status === "error" && !errorMessage ? invokeError : errorMessage,
    errorDetails,
    canDownload,
    handleDownload,
    handleReset,
  };
}
