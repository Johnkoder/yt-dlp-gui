import { useCallback, useEffect, useRef, useState } from "react";
import {
  friendlyErrorMessage,
  startDownload,
  subscribeToDownloadEvents,
} from "../downloadService";
import {
  DEFAULT_MEDIA_TYPE,
  DEFAULT_VIDEO_QUALITY,
  buildDownloadRequest,
  type MediaType,
  type VideoQuality,
} from "../options";
import type {
  DownloadError,
  DownloadProgressEvent,
  DownloadResult,
  DownloadStatus,
  EventSubscription,
} from "../types";

export interface UseDownloadState {
  status: DownloadStatus;
  subscription: EventSubscription;
  url: string;
  setUrl: (url: string) => void;
  mediaType: MediaType;
  setMediaType: (mediaType: MediaType) => void;
  quality: VideoQuality;
  setQuality: (quality: VideoQuality) => void;
  progress: DownloadProgressEvent | null;
  result: DownloadResult | null;
  errorMessage: string | null;
  errorDetails: string | null;
  canDownload: boolean;
  handleDownload: () => Promise<void>;
  handleReset: () => void;
}

/**
 * Owns the MVP download state machine:
 * initializing -> ready -> downloading -> success | error.
 *
 * Downloads are gated on `subscription === "active"`, so the button can
 * never fire before every backend event listener is registered. A failed
 * subscription lands in a terminal error state that `handleReset` does not
 * clear — the app must be restarted.
 */
export function useDownload(): UseDownloadState {
  const [status, setStatus] = useState<DownloadStatus>("initializing");
  const [subscription, setSubscription] =
    useState<EventSubscription>("pending");
  const [url, setUrlState] = useState("");
  // Selection state is separate from the lifecycle state machine.
  const [mediaType, setMediaTypeState] =
    useState<MediaType>(DEFAULT_MEDIA_TYPE);
  const [quality, setQualityState] = useState<VideoQuality>(
    DEFAULT_VIDEO_QUALITY,
  );
  const [progress, setProgress] = useState<DownloadProgressEvent | null>(null);
  const [result, setResult] = useState<DownloadResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorDetails, setErrorDetails] = useState<string | null>(null);
  const statusRef = useRef<DownloadStatus>("initializing");
  statusRef.current = status;
  const subscriptionRef = useRef<EventSubscription>("pending");
  subscriptionRef.current = subscription;

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
        if (cancelled) {
          // StrictMode remount or unmount beat the subscription: release it
          // immediately so listeners are never duplicated.
          fn();
          return;
        }
        unlisten = fn;
        setSubscription("active");
        setStatus((current) =>
          current === "initializing" ? "ready" : current,
        );
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const raw = err instanceof Error ? err.message : String(err);
        // Terminal: the error is surfaced, never stored-then-cleared, and
        // handleReset intentionally does not leave this state.
        setSubscription("failed");
        setErrorMessage(
          "Could not connect to the application backend. Event listeners failed to start — please restart the application.",
        );
        setErrorDetails(raw);
        setStatus("error");
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const setUrl = useCallback((value: string) => {
    setUrlState(value);
  }, []);

  const setMediaType = useCallback((value: MediaType) => {
    setMediaTypeState(value);
  }, []);

  const setQuality = useCallback((value: VideoQuality) => {
    setQualityState(value);
  }, []);

  const trimmedUrl = url.trim();
  const canDownload =
    subscription === "active" &&
    status !== "downloading" &&
    status !== "initializing" &&
    trimmedUrl.length > 0;

  const handleDownload = useCallback(async () => {
    // Defense in depth: the UI disables the button, but never invoke the
    // backend without listeners — progress/completion would be lost.
    if (subscriptionRef.current !== "active") {
      return;
    }
    if (statusRef.current === "downloading") {
      return;
    }
    const target = url.trim();
    if (target.length === 0) {
      return;
    }
    setProgress(null);
    setResult(null);
    setErrorMessage(null);
    setErrorDetails(null);
    setStatus("downloading");
    try {
      await startDownload(buildDownloadRequest(target, mediaType, quality));
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : String(err);
      setErrorMessage(friendlyErrorMessage(raw));
      setErrorDetails(raw);
      setStatus("error");
    }
  }, [url, mediaType, quality]);

  const handleReset = useCallback(() => {
    if (
      statusRef.current === "downloading" ||
      subscriptionRef.current !== "active"
    ) {
      return;
    }
    setProgress(null);
    setResult(null);
    setErrorMessage(null);
    setErrorDetails(null);
    setStatus("ready");
  }, []);

  return {
    status,
    subscription,
    url,
    setUrl,
    mediaType,
    setMediaType,
    quality,
    setQuality,
    progress,
    result,
    errorMessage,
    errorDetails,
    canDownload,
    handleDownload,
    handleReset,
  };
}
