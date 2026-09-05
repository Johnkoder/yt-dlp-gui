import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelJob,
  chooseOutputDirectory,
  enqueueDownload,
  friendlyErrorMessage,
  getDownloadsDir,
  subscribeToDownloadEvents,
  validateOutputDirectory,
} from "../downloadService";
import {
  DEFAULT_AUDIO_FORMAT,
  DEFAULT_MEDIA_TYPE,
  DEFAULT_VIDEO_QUALITY,
  buildDownloadRequest,
  type AudioFormat,
  type DownloadRequest,
  type MediaType,
  type VideoQuality,
} from "../options";
import {
  clearSavedOutputDirectory,
  getSavedOutputDirectory,
  saveOutputDirectory,
} from "../outputDirectory";
import type {
  DownloadCancelled,
  DownloadError,
  DownloadResult,
  DownloadStartedEvent,
  DownloadJob,
  EventSubscription,
  InitStatus,
  JobStatus,
} from "../types";

export interface UseQueueState {
  initStatus: InitStatus;
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
  /** FIFO jobs, session-memory only. */
  jobs: DownloadJob[];
  isSubmitting: boolean;
  enqueueError: string | null;
  initErrorMessage: string | null;
  initErrorDetails: string | null;
  canEnqueue: boolean;
  enqueueCurrentDraft: () => Promise<void>;
  handleJobCancel: (jobId: number) => Promise<void>;
}

function isTerminalStatus(status: JobStatus): boolean {
  return status === "success" || status === "error" || status === "cancelled";
}

function emptyJob(
  id: number,
  request: DownloadRequest | null,
  status: JobStatus,
): DownloadJob {
  return {
    id,
    request,
    status,
    progress: null,
    result: null,
    errorMessage: null,
    errorDetails: null,
    cancelError: null,
  };
}

/**
 * Owns the FIFO download queue plus global app initialization.
 *
 * Initialization (event subscriptions, output folder) stays global and
 * separate from per-job state. The draft form configures only the NEXT job:
 * every enqueue snapshots plain values, so later edits can never mutate a
 * queued or running job. The backend owns order, identity, and execution;
 * this hook mirrors it by job ID and never guesses ownership.
 */
export function useDownloadQueue(): UseQueueState {
  const [initStatus, setInitStatus] = useState<InitStatus>("initializing");
  const [subscription, setSubscription] =
    useState<EventSubscription>("pending");
  const [url, setUrlState] = useState("");
  const [mediaType, setMediaTypeState] =
    useState<MediaType>(DEFAULT_MEDIA_TYPE);
  const [quality, setQualityState] = useState<VideoQuality>(
    DEFAULT_VIDEO_QUALITY,
  );
  const [audioFormat, setAudioFormatState] = useState<AudioFormat>(
    DEFAULT_AUDIO_FORMAT,
  );
  const [outputDirectory, setOutputDirectoryState] = useState<string | null>(
    null,
  );
  const [jobs, setJobs] = useState<DownloadJob[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [enqueueError, setEnqueueError] = useState<string | null>(null);
  const [initErrorMessage, setInitErrorMessage] = useState<string | null>(null);
  const [initErrorDetails, setInitErrorDetails] = useState<string | null>(null);

  const initStatusRef = useRef<InitStatus>("initializing");
  initStatusRef.current = initStatus;
  const subscriptionRef = useRef<EventSubscription>("pending");
  subscriptionRef.current = subscription;
  const jobsRef = useRef<DownloadJob[]>([]);
  jobsRef.current = jobs;
  const submittingRef = useRef(false);
  // Snapshot of the in-flight enqueue, consumed exactly once by whichever
  // arrives first: the download-started event (placeholder row) or the
  // enqueue response (merge). At most one enqueue is ever in flight.
  const pendingRef = useRef<DownloadRequest | null>(null);
  // The mode at event-registration time is irrelevant per-job (snapshots
  // carry their own media type), but invoke-failure mapping still needs the
  // draft mode for enqueue errors.
  const mediaTypeRef = useRef<MediaType>(DEFAULT_MEDIA_TYPE);
  mediaTypeRef.current = mediaType;
  const outputDirectoryRef = useRef<string | null>(null);
  outputDirectoryRef.current = outputDirectory;

  // Shared gate: `initializing` ends only after event listeners AND the
  // output folder are both resolved — in either completion order.
  const markReadyWhenInitialized = useCallback(() => {
    if (
      initStatusRef.current === "initializing" &&
      subscriptionRef.current === "active" &&
      outputDirectoryRef.current !== null
    ) {
      setInitStatus("ready");
    }
  }, []);

  const failInit = useCallback((message: string, details: string) => {
    setInitErrorMessage(message);
    setInitErrorDetails(details);
    setInitStatus("error");
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    subscribeToDownloadEvents({
      onStarted: (event: DownloadStartedEvent) => {
        if (cancelled) return;
        const { jobId } = event;
        // Consume the in-flight snapshot if this started event won the race
        // against the enqueue response.
        const snapshot = pendingRef.current;
        pendingRef.current = null;
        setJobs((prev) => {
          const index = prev.findIndex((job) => job.id === jobId);
          if (index === -1) {
            return [...prev, emptyJob(jobId, snapshot, "downloading")];
          }
          const job = prev[index];
          if (job.status !== "queued") {
            return prev;
          }
          const next = [...prev];
          next[index] = {
            ...job,
            request: job.request ?? snapshot,
            status: "downloading",
          };
          return next;
        });
      },
      onProgress: (payload) => {
        if (cancelled) return;
        const { jobId } = payload;
        const snapshot = pendingRef.current;
        setJobs((prev) => {
          const index = prev.findIndex((job) => job.id === jobId);
          if (index === -1) {
            // Pathological order (progress before started/response): keep
            // the data on a placeholder rather than dropping or
            // misattributing it. Only consume the snapshot when actually
            // creating the row.
            pendingRef.current = null;
            return [
              ...prev,
              { ...emptyJob(jobId, snapshot, "downloading"), progress: payload },
            ];
          }
          const job = prev[index];
          if (isTerminalStatus(job.status)) {
            return prev;
          }
          const next = [...prev];
          next[index] = {
            ...job,
            progress: payload,
            status: job.status === "cancelling" ? "cancelling" : "downloading",
          };
          return next;
        });
      },
      onComplete: (payload: DownloadResult) => {
        if (cancelled) return;
        const { jobId } = payload;
        setJobs((prev) => {
          const index = prev.findIndex((job) => job.id === jobId);
          if (index === -1) {
            return prev;
          }
          const job = prev[index];
          // Completion wins even mid-cancellation (the process really
          // finished); terminal rows are never overwritten.
          if (
            job.status !== "downloading" &&
            job.status !== "cancelling"
          ) {
            return prev;
          }
          const next = [...prev];
          next[index] = {
            ...job,
            result: payload,
            errorMessage: null,
            errorDetails: null,
            cancelError: null,
            status: "success",
          };
          return next;
        });
      },
      onError: (payload: DownloadError) => {
        if (cancelled) return;
        const { jobId } = payload;
        setJobs((prev) => {
          const index = prev.findIndex((job) => job.id === jobId);
          if (index === -1) {
            return prev;
          }
          const job = prev[index];
          if (
            job.status !== "downloading" &&
            job.status !== "cancelling" &&
            job.status !== "queued"
          ) {
            return prev;
          }
          const next = [...prev];
          next[index] = {
            ...job,
            errorMessage: friendlyErrorMessage(
              payload.message,
              job.request?.mediaType ?? mediaTypeRef.current,
            ),
            errorDetails: payload.details ?? payload.message,
            status: "error",
          };
          return next;
        });
      },
      onCancelled: (payload: DownloadCancelled) => {
        if (cancelled) return;
        const { jobId } = payload;
        setJobs((prev) => {
          const index = prev.findIndex((job) => job.id === jobId);
          if (index === -1) {
            return prev;
          }
          const job = prev[index];
          if (isTerminalStatus(job.status)) {
            return prev;
          }
          const next = [...prev];
          next[index] = {
            ...job,
            errorMessage: null,
            errorDetails: null,
            cancelError: null,
            status: "cancelled",
          };
          return next;
        });
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
        // Terminal: the error is surfaced, never stored-then-cleared.
        setSubscription("failed");
        failInit(
          "Could not connect to the application backend. Event listeners failed to start — please restart the application.",
          raw,
        );
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [failInit, markReadyWhenInitialized]);

  // Output-folder initialization: default Downloads, persisted override
  // when it still validates, fatal error when no default can be found.
  useEffect(() => {
    let cancelled = false;

    async function initialize() {
      let fallback: string;
      try {
        fallback = await getDownloadsDir();
      } catch (err: unknown) {
        if (cancelled) return;
        const raw = err instanceof Error ? err.message : String(err);
        failInit(
          "Could not determine your Downloads folder. Please restart the application.",
          raw,
        );
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
  }, [failInit, markReadyWhenInitialized]);

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
      initStatusRef.current !== "ready"
    ) {
      return;
    }
    let selected: string | null;
    try {
      selected = await chooseOutputDirectory();
    } catch {
      // The picker itself failed; keep the current folder and say so.
      setEnqueueError("Could not open the folder picker.");
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
      setEnqueueError(friendlyErrorMessage(raw));
    }
  }, []);

  const trimmedUrl = url.trim();
  const canEnqueue =
    initStatus === "ready" &&
    subscription === "active" &&
    outputDirectory !== null &&
    trimmedUrl.length > 0 &&
    !isSubmitting;

  const enqueueCurrentDraft = useCallback(async () => {
    // Double-click guard: one in-flight enqueue at a time. Identical jobs
    // remain enqueueable one after another — no global URL dedup.
    if (submittingRef.current) {
      return;
    }
    if (subscriptionRef.current !== "active") {
      return;
    }
    if (initStatusRef.current !== "ready") {
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
    // Plain-object snapshot: later draft edits cannot mutate this job.
    const snapshot = buildDownloadRequest(
      target,
      mediaType,
      quality,
      audioFormat,
      destination,
    );
    pendingRef.current = snapshot;
    submittingRef.current = true;
    setIsSubmitting(true);
    setEnqueueError(null);
    try {
      const { jobId } = await enqueueDownload(snapshot);
      const taken = pendingRef.current;
      pendingRef.current = null;
      setJobs((prev) => {
        const index = prev.findIndex((job) => job.id === jobId);
        if (index !== -1) {
          // Started event won the race: fold the snapshot in, keep the
          // downloading status — never regress it to queued.
          const job = prev[index];
          if (job.request) {
            return prev;
          }
          const next = [...prev];
          next[index] = { ...job, request: taken };
          return next;
        }
        return [...prev, emptyJob(jobId, taken, "queued")];
      });
      // Clear the URL for convenient next entry; selections persist.
      setUrlState("");
    } catch (err: unknown) {
      pendingRef.current = null;
      const raw = err instanceof Error ? err.message : String(err);
      setEnqueueError(friendlyErrorMessage(raw, mediaType));
    } finally {
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  }, [url, mediaType, quality, audioFormat]);

  const handleJobCancel = useCallback(async (jobId: number) => {
    const job = jobsRef.current.find((candidate) => candidate.id === jobId);
    if (!job || isTerminalStatus(job.status) || job.status === "cancelling") {
      return;
    }
    if (job.status === "queued") {
      try {
        const outcome = await cancelJob(jobId);
        if (outcome === "removed" || outcome === "cancelling") {
          // The terminal download-cancelled event marks the row; if it
          // already landed, these guards make this a harmless no-op.
          setJobs((prev) => {
            const index = prev.findIndex((candidate) => candidate.id === jobId);
            if (index === -1) {
              return prev;
            }
            const current = prev[index];
            if (isTerminalStatus(current.status)) {
              return prev;
            }
            const next = [...prev];
            next[index] = {
              ...current,
              cancelError: null,
              status: outcome === "removed" ? "cancelled" : "cancelling",
            };
            return next;
          });
        }
        // notFound: leave the row; an event may still land, or nothing
        // was there to begin with.
      } catch (err: unknown) {
        const raw = err instanceof Error ? err.message : String(err);
        setJobs((prev) => {
          const index = prev.findIndex((candidate) => candidate.id === jobId);
          if (index === -1) {
            return prev;
          }
          const next = [...prev];
          next[index] = { ...next[index], cancelError: `Could not remove the job. ${raw}` };
          return next;
        });
      }
      return;
    }
    // Downloading: move to cancelling optimistically (guarded so a
    // just-landed terminal event is never clobbered), then request.
    setJobs((prev) => {
      const index = prev.findIndex((candidate) => candidate.id === jobId);
      if (index === -1 || prev[index].status !== "downloading") {
        return prev;
      }
      const next = [...prev];
      next[index] = { ...next[index], status: "cancelling", cancelError: null };
      return next;
    });
    try {
      await cancelJob(jobId);
      // Terminal download-cancelled event confirms; nothing else to do.
      // (notFound simply means the task finished first — its terminal
      // event is authoritative and already applied or imminent.)
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : String(err);
      setJobs((prev) => {
        const index = prev.findIndex((candidate) => candidate.id === jobId);
        if (index === -1 || prev[index].status !== "cancelling") {
          return prev;
        }
        const next = [...prev];
        next[index] = {
          ...next[index],
          status: "downloading",
          cancelError: `Could not cancel the download. ${raw}`,
        };
        return next;
      });
    }
  }, []);

  return {
    initStatus,
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
    jobs,
    isSubmitting,
    enqueueError,
    initErrorMessage,
    initErrorDetails,
    canEnqueue,
    enqueueCurrentDraft,
    handleJobCancel,
  };
}
