import { DownloadButton } from "./components/DownloadButton";
import { DownloadProgress } from "./components/DownloadProgress";
import { StatusMessage } from "./components/StatusMessage";
import { UrlInput } from "./components/UrlInput";
import { useDownload } from "./features/downloads/hooks/useDownload";
import "./App.css";

export default function App() {
  const {
    status,
    url,
    setUrl,
    progress,
    result,
    errorMessage,
    errorDetails,
    canDownload,
    handleDownload,
    handleReset,
  } = useDownload();

  const isDownloading = status === "downloading";

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
          onSubmit={handleDownload}
          disabled={isDownloading}
        />

        <DownloadButton
          disabled={!canDownload}
          loading={isDownloading}
          onClick={handleDownload}
        />

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
            title="Download failed"
            message={errorMessage}
            details={errorDetails}
            onReset={handleReset}
          />
        )}
      </main>

      <footer className="app-footer">
        <span>Videos are saved to your Downloads folder.</span>
      </footer>
    </div>
  );
}
