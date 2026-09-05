import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelDownload,
  chooseOutputDirectory,
  friendlyErrorMessage,
  getDownloadsDir,
  startDownload,
  subscribeToDownloadEvents,
  validateOutputDirectory,
} from "../downloadService";
import {
  DEFAULT_AUDIO_FORMAT,
  DEFAULT_MEDIA_TYPE,
  DEFAULT_VIDEO_QUALITY,
  buildDownloadRequest,
  type AudioFormat,
  type MediaType,
  type VideoQuality,
} from "../options";
import {
  clearSavedOutputDirectory,
  getSavedOutputDirectory,
  saveOutputDirectory,
} from "../outputDirectory";
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
  audioFormat: AudioFormat;
  setAudioFormat: (format: AudioFormat) => void;
  /** Resolved output folder; null until startup initialization finishes. */
  outputDirectory: string | null;
  setOutputDirectory: (path: string) => void;
  chooseOutputDirectory: () => Promise<void>;
  progress: DownloadProgressEvent | null;
  result: DownloadResult | null;
  errorMessage: string | null;
  errorDetails: string | null;
  /** Cancellation-specific failure; the download itself keeps running. */
  cancelError: string | null;
  canDownload: boolean;
  handleDownload: () => Promise<void>;
  handleCancel: () => Promise<void>;
  handleReset: () => void;
}

/**
 * Owns the download state machine:
 * initializing -> ready -> downloading -> success | error, plus the neutral
 * downloading -> cancelling -> cancelled branch.
 *
 * Downloads are gated on `subscription === "active"` AND a resolved output
 * directory, so the button can never fire before listeners are registered
 * or before the save location is known. A failed subscription or an
 * undeterminable default folder lands in a terminal error state that
 * `handleReset` does not clear — the app must be restarted.
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
  // Independent selection state: switching modes preserves both choices.
  const [audioFormat, setAudioFormatState] = useState<AudioFormat>(
    DEFAULT_AUDIO_FORMAT,
  );
  const [outputDirectory, setOutputDirectoryState] = useState<string | null>(
    null,
  );
  const [progress, setProgress] = useState<DownloadProgressEvent | null>(null);
  const [result, setResult] = useState<DownloadResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorDetails, setErrorDetails] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const statusRef = useRef<DownloadStatus>("initializing");
  statusRef.current = status;
  const subscriptionRef = useRef<EventSubscription>("pending");
  subscriptionRef.current = subscription;
  // The event handlers are registered once; read the mode through a ref so
  // error mapping never sees a stale closure value.
  const mediaTypeRef = useRef<MediaType>(DEFAULT_MEDIA_TYPE);
  mediaTypeRef.current = mediaType;
  const outputDirectoryRef = useRef<string | null>(null);
  outputDirectoryRef.current = outputDirectory;

  // Shared gate: `initializing` ends only after event listeners AND the
  // output folder are both resolved — in either completion order.
  const markReadyWhenInitialized = useCallback(() => {
    if (
      statusRef.current === "initializing" &&
      subscriptionRef.current === "active" &&
      outputDirectoryRef.current !== null
    ) {
      setStatus("ready");
    }
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    subscribeToDownloadEvents({
      onProgress: (payload) => {
        if (cancelled) return;
        const current = statusRef.current;
        if (
          current === "success" ||
          current === "error" ||
          current === "cancelled"
        ) {
          return;
        }
        // While cancelling the numbers may still update, but the lifecycle
        // status must never regress back to downloading.
        setProgress(payload);
        if (current !== "downloading" && current !== "cancelling") {
          setStatus("downloading");
        }
      },
      onComplete: (payload: DownloadResult) => {
        if (cancelled) return;
        setResult(payload);
        setErrorMessage(null);
        setErrorDetails(null);
        setCancelError(null);
        setStatus("success");
      },
      onError: (payload: DownloadError) => {
        if (cancelled) return;
        setErrorMessage(
          friendlyErrorMessage(payload.message, mediaTypeRef.current),
        );
        setErrorDetails(payload.details ?? payload.message);
        setStatus("error");
      },
      onCancelled: () => {
        if (cancelled) return;
        setErrorMessage(null);
        setErrorDetails(null);
        setCancelError(null);
        setStatus("cancelled");
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
        subscriptionRef.current = "active";
        markReadyWhenInitialized();
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
  }, [markReadyWhenInitialized]);

  // Output-folder initialization: default Downloads, persisted override
  // when it still validates, fatal error when no default can be found.
  // The guarded ready-transition keeps startup flicker-free: the UI leaves
  // `initializing` only after listeners AND the folder are both resolved.
  useEffect(() => {
    let cancelled = false;

    async function initialize() {
      let fallback: string;
      try {
        fallback = await getDownloadsDir();
      } catch (err: unknown) {
        if (cancelled) return;
        const raw = err instanceof Error ? err.message : String(err);
        setErrorMessage(
          "Could not determine your Downloads folder. Please restart the application.",
        );
        setErrorDetails(raw);
        setStatus("error");
        return;
      }
      const saved = getSavedOutputDirectory();
      if (saved !== null) {
        try {
          const valid = await validateOutputDirectory(saved);
          if (!cancelled) {
            outputDirectoryRef.current = valid;
            setOutputDirectoryState(valid);
            markReadyWhenInitialized();
          }
          return;
        } catch {
          // Stale preference: drop it and fall back to Downloads.
          clearSavedOutputDirectory();
        }
      }
      if (!cancelled) {
        outputDirectoryRef.current = fallback;
        setOutputDirectoryState(fallback);
        markReadyWhenInitialized();
      }
    }

    initialize();
    return () => {
      cancelled = true;
    };
  }, [markReadyWhenInitialized]);

  const setUrl = useCallback((value: string) => {
    setUrlState(value);
  }, []);

  const setMediaType = useCallback((value: MediaType) => {
    setMediaTypeState(value);
  }, []);

  const setQuality = useCallback((value: VideoQuality) => {
    setQualityState(value);
  }, []);

  const setAudioFormat = useCallback((value: AudioFormat) => {
    setAudioFormatState(value);
  }, []);

  const setOutputDirectory = useCallback((value: string) => {
    setOutputDirectoryState(value);
    saveOutputDirectory(value);
  }, []);

  const handleChooseOutputDirectory = useCallback(async () => {
    if (
      subscriptionRef.current !== "active" ||
      statusRef.current === "downloading"
    ) {
      return;
    }
    let selected: string | null;
    try {
      selected = await chooseOutputDirectory();
    } catch (err: unknown) {
      // The picker itself failed; keep the current folder.
      const raw = err instanceof Error ? err.message : String(err);
      setErrorMessage("Could not open the folder picker.");
      setErrorDetails(raw);
      setStatus("error");
      return;
    }
    if (selected === null) {
      // Cancelled: leave everything unchanged, silently.
      return;
    }
    try {
      const valid = await validateOutputDirectory(selected);
      setOutputDirectoryState(valid);
      saveOutputDirectory(valid);
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : String(err);
      setErrorMessage(friendlyErrorMessage(raw));
      setErrorDetails(raw);
      setStatus("error");
    }
  }, []);

  const trimmedUrl = url.trim();
  const canDownload =
    subscription === "active" &&
    status !== "downloading" &&
    status !== "cancelling" &&
    status !== "initializing" &&
    outputDirectory !== null &&
    trimmedUrl.length > 0;

  const handleDownload = useCallback(async () => {
    // Defense in depth: the UI disables the button, but never invoke the
    // backend without listeners and a resolved folder.
    if (subscriptionRef.current !== "active") {
      return;
    }
    if (
      statusRef.current === "downloading" ||
      statusRef.current === "cancelling"
    ) {
      return;
    }
    const target = url.trim();
    if (target.length === 0) {
      return;
    }
    const destination = outputDirectoryRef.current;
    if (destination === null) {
      return;
    }
    setProgress(null);
    setResult(null);
    setErrorMessage(null);
    setErrorDetails(null);
    setCancelError(null);
    setStatus("downloading");
    try {
      await startDownload(
        buildDownloadRequest(
          target,
          mediaType,
          quality,
          audioFormat,
          destination,
        ),
      );
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : String(err);
      setErrorMessage(friendlyErrorMessage(raw, mediaType));
      setErrorDetails(raw);
      setStatus("error");
    }
  }, [url, mediaType, quality, audioFormat]);

  const handleCancel = useCallback(async () => {
    // Only a running download can be cancelled; anything else is a no-op
    // (this also makes double-clicks harmless).
    if (
      subscriptionRef.current !== "active" ||
      statusRef.current !== "downloading"
    ) {
      return;
    }
    setCancelError(null);
    setStatus("cancelling");
    try {
      await cancelDownload();
      // The backend confirms via the download-cancelled event; `cancelled`
      // is set there, never here, so a lost signal can't fake the outcome.
    } catch (err: unknown) {
      // The IPC call itself failed — the download may still be running, so
      // return to `downloading` and keep it visible instead of erroring out.
      const raw = err instanceof Error ? err.message : String(err);
      setCancelError(`Could not cancel the download. ${raw}`);
      // Re-read the live ref (a terminal backend event may have moved the
      // lifecycle meanwhile); the cast defeats stale narrowing on purpose.
      // "downloading" covers a transition render that hasn't flushed yet.
      const current = statusRef.current as DownloadStatus;
      if (current === "cancelling" || current === "downloading") {
        setStatus("downloading");
      }
    }
  }, []);

  const handleReset = useCallback(() => {
    if (
      statusRef.current === "downloading" ||
      statusRef.current === "cancelling" ||
      subscriptionRef.current !== "active"
    ) {
      return;
    }
    setProgress(null);
    setResult(null);
    setErrorMessage(null);
    setErrorDetails(null);
    setCancelError(null);
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
    audioFormat,
    setAudioFormat,
    outputDirectory,
    setOutputDirectory,
    chooseOutputDirectory: handleChooseOutputDirectory,
    progress,
    result,
    errorMessage,
    errorDetails,
    cancelError,
    canDownload,
    handleDownload,
    handleCancel,
    handleReset,
  };
}
