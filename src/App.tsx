import { DependencySection } from "./components/DependencySection";
import { DownloadButton } from "./components/DownloadButton";
import { DownloadProgress } from "./components/DownloadProgress";
import { MediaTypeSelector } from "./components/MediaTypeSelector";
import { OutputFolderSelector } from "./components/OutputFolderSelector";
import { QualitySelector } from "./components/QualitySelector";
import { StatusMessage } from "./components/StatusMessage";
import { UrlInput } from "./components/UrlInput";
import { useDependencies } from "./features/dependencies/hooks/useDependencies";
import { useDownload } from "./features/downloads/hooks/useDownload";
import "./App.css";

export default function App() {
  const {
    status,
    subscription,
    url,
    setUrl,
    mediaType,
    setMediaType,
    quality,
    setQuality,
    outputDirectory,
    chooseOutputDirectory,
    progress,
    result,
    errorMessage,
    errorDetails,
    canDownload,
    handleDownload,
    handleReset,
  } = useDownload();

  const dependencies = useDependencies();

  const isInitializing = status === "initializing";
  const isDownloading = status === "downloading";
  const backendUnreachable = subscription === "failed";
  const optionsLocked = isDownloading || isInitializing;
  const isAudio = mediaType === "audio";
  // Only yt-dlp gates downloads; Deno/FFmpeg degrade gracefully.
  const ytdlpState = dependencies.report?.ytDlp.state;
  const ytdlpMissing = ytdlpState === "missing" || ytdlpState === "error";
  const downloadAllowed = canDownload && !ytdlpMissing;
  const showFfmpegNote =
    !isAudio && dependencies.report?.ffmpeg.state === "missing";
  // While downloading the button falls back to its internal "Downloading…".
  const actionLabel = isInitializing
    ? "Loading…"
    : isDownloading
      ? undefined
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
            if (downloadAllowed) {
              void handleDownload();
            }
          }}
          disabled={optionsLocked}
        />

        <MediaTypeSelector
          value={mediaType}
          onChange={setMediaType}
          disabled={optionsLocked}
        />

        {!isAudio && (
          <>
            <QualitySelector
              value={quality}
              onChange={setQuality}
              disabled={optionsLocked}
            />
            {showFfmpegNote && (
              <p className="hint">
                FFmpeg is not installed. Some video qualities may require it
                to merge video and audio.
              </p>
            )}
          </>
        )}

        <OutputFolderSelector
          value={outputDirectory}
          onBrowse={chooseOutputDirectory}
          disabled={optionsLocked}
        />

        <DownloadButton
          disabled={!downloadAllowed}
          loading={isDownloading || isInitializing}
          label={actionLabel}
          onClick={() => {
            if (downloadAllowed) {
              void handleDownload();
            }
          }}
        />

        {ytdlpMissing && !isDownloading && (
          <p className="hint hint--error" role="note">
            Downloads unavailable: yt-dlp is{" "}
            {ytdlpState === "error" ? "reporting an error" : "missing"}.
          </p>
        )}

        {isDownloading && <DownloadProgress progress={progress} />}

        {status === "success" && result && (
          <StatusMessage
            kind="success"
            title="Download complete"
            result={result}
            onReset={handleReset}
          />
        )}

        {status === "error" && (
          <StatusMessage
            kind="error"
            title={backendUnreachable ? "Application error" : "Download failed"}
            message={errorMessage}
            details={errorDetails}
            onReset={backendUnreachable ? null : handleReset}
          />
        )}

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
