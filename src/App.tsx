import { useEffect } from "react";
import { AudioFormatSelector } from "./components/AudioFormatSelector";
import { DependencySection } from "./components/DependencySection";
import { DownloadButton } from "./components/DownloadButton";
import { MediaTypeSelector } from "./components/MediaTypeSelector";
import { OutputFolderSelector } from "./components/OutputFolderSelector";
import { QualitySelector } from "./components/QualitySelector";
import { QueueSection } from "./components/QueueSection";
import { ScopeSelector } from "./components/ScopeSelector";
import { UrlInput } from "./components/UrlInput";
import { AUDIO_FORMAT_LABELS } from "./features/downloads/options";
import { useDependencies } from "./features/dependencies/hooks/useDependencies";
import { useDownloadQueue } from "./features/downloads/hooks/useDownloadQueue";
import "./App.css";

export default function App() {
  const {
    initStatus,
    url,
    setUrl,
    scope,
    setScope,
    mediaType,
    setMediaType,
    quality,
    setQuality,
    audioFormat,
    setAudioFormat,
    outputDirectory,
    chooseOutputDirectory,
    jobs,
    isSubmitting,
    enqueueError,
    enqueueNotice,
    initErrorMessage,
    initErrorDetails,
    canEnqueue,
    enqueueCurrentDraft,
    handleJobCancel,
  } = useDownloadQueue();

  const dependencies = useDependencies();

  const isInitializing = initStatus === "initializing";
  const initFailed = initStatus === "error";
  const isAudio = mediaType === "audio";
  // Only yt-dlp gates new jobs; Deno/FFmpeg degrade gracefully — except an
  // audio conversion, which needs FFmpeg confirmed available.
  const ytdlpState = dependencies.report?.ytDlp.state;
  const ytdlpMissing = ytdlpState === "missing" || ytdlpState === "error";
  const ffmpegAvailable = dependencies.report?.ffmpeg.state === "available";
  const needsConversion = isAudio && audioFormat !== "original";
  const conversionBlocked = needsConversion && !ffmpegAvailable;
  const enqueueAllowed =
    canEnqueue && !ytdlpMissing && !conversionBlocked && !isSubmitting;
  const showFfmpegNote =
    !isAudio && dependencies.report?.ffmpeg.state === "missing";

  // If Refresh revokes FFmpeg while a conversion is selected, fall back to
  // Original rather than leaving the draft in an un-enqueueable state.
  // Queued jobs keep their own snapshots and are never mutated here.
  useEffect(() => {
    if (
      dependencies.report &&
      dependencies.report.ffmpeg.state !== "available" &&
      audioFormat !== "original"
    ) {
      setAudioFormat("original");
    }
  }, [dependencies.report, audioFormat, setAudioFormat]);

  const hasPendingJobs = jobs.some(
    (job) =>
      job.status === "queued" ||
      job.status === "downloading" ||
      job.status === "cancelling",
  );
  // While downloading the button falls back to its internal "Downloading…".
  const actionLabel = isInitializing
    ? "Loading…"
    : isSubmitting
      ? scope === "playlist"
        ? "Adding Playlist…"
        : "Downloading…"
      : scope === "playlist"
        ? "Add Playlist to Queue"
        : hasPendingJobs
          ? "Add to Queue"
          : isAudio
            ? "Download Audio"
            : "Download Video";

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header__icon" aria-hidden="true">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
            <rect x="2" y="5" width="20" height="14" rx="4" fill="#4f8cff" />
            <path d="M10 9.5v5l4.5-2.5L10 9.5Z" fill="#fff" />
          </svg>
        </div>
        <div className="app-header__text">
          <h1 className="app-header__title">yt-dlp GUI</h1>
          <p className="app-header__subtitle">
            Download videos without the command line.
          </p>
        </div>
      </header>

      <main className="app-main">
        <UrlInput
          value={url}
          onChange={setUrl}
          onSubmit={() => {
            if (enqueueAllowed) {
              void enqueueCurrentDraft();
            }
          }}
          disabled={isInitializing || initFailed}
        />

        <ScopeSelector
          value={scope}
          onChange={setScope}
          disabled={isInitializing || initFailed || isSubmitting}
        />

        <MediaTypeSelector
          value={mediaType}
          onChange={setMediaType}
          disabled={isInitializing || initFailed}
        />

        {!isAudio && (
          <>
            <QualitySelector
              value={quality}
              onChange={setQuality}
              disabled={isInitializing || initFailed}
            />
            {showFfmpegNote && (
              <p className="hint">
                FFmpeg is not installed. Some video qualities may require it
                to merge video and audio.
              </p>
            )}
          </>
        )}

        {isAudio && (
          <AudioFormatSelector
            value={audioFormat}
            onChange={setAudioFormat}
            disabled={isInitializing || initFailed}
            conversionsEnabled={ffmpegAvailable}
          />
        )}

        <OutputFolderSelector
          value={outputDirectory}
          onBrowse={chooseOutputDirectory}
          disabled={isInitializing || initFailed}
        />

        <DownloadButton
          disabled={!enqueueAllowed}
          loading={isInitializing || isSubmitting}
          label={actionLabel}
          onClick={() => {
            if (enqueueAllowed) {
              void enqueueCurrentDraft();
            }
          }}
        />

        {ytdlpMissing && (
          <p className="hint hint--error" role="note">
            Downloads unavailable: yt-dlp is{" "}
            {ytdlpState === "error" ? "reporting an error" : "missing"}.
          </p>
        )}

        {conversionBlocked && (
          <p className="hint hint--error" role="note">
            FFmpeg is required to convert audio to{" "}
            {AUDIO_FORMAT_LABELS[audioFormat]}.
          </p>
        )}

        {enqueueError && (
          <p className="hint hint--error" role="alert">
            {enqueueError}
          </p>
        )}

        {enqueueNotice && (
          <p className="hint hint--info" role="status">
            {enqueueNotice}
          </p>
        )}

        {initFailed && (
          <p className="hint hint--error" role="alert">
            {initErrorMessage}
            {initErrorDetails ? ` Details: ${initErrorDetails}` : ""}
          </p>
        )}

        <QueueSection
          jobs={jobs}
          onCancel={(jobId) => {
            void handleJobCancel(jobId);
          }}
          onRemove={(jobId) => {
            void handleJobCancel(jobId);
          }}
        />

        <DependencySection
          status={dependencies.status}
          report={dependencies.report}
          errorMessage={dependencies.errorMessage}
          onRefresh={() => {
            void dependencies.refresh();
          }}
        />
      </main>

      <footer className="app-footer">
        <span>Files are saved to your chosen output folder.</span>
      </footer>
    </div>
  );
}
