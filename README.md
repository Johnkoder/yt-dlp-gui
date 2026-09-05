# yt-dlp GUI

A Windows desktop app that downloads videos and audio without the
command line.
Paste a URL, press **Download**, watch real progress, and find the
file in your Downloads folder. Multiple downloads queue up and run one
at a time.

**yt-dlp** does the actual downloading — this app is a native GUI around
the `yt-dlp.exe` binary, which is bundled as an application resource.

Roles: **yt-dlp** is required and bundled; **Deno** is an external JS
runtime yt-dlp uses for modern site extraction; **FFmpeg** is an external
tool yt-dlp uses for merging separate streams and future conversion.

## Current features

- Paste a video URL and download it with one click (Enter works too)
- Download type: **Video** or **Audio**. Audio offers **Original**
  (best native audio-only stream, no conversion) plus **MP3 / M4A /
  WAV / FLAC** conversion via FFmpeg. Conversion needs an `ffmpeg` on
  `PATH`; without it, conversion choices are locked and Original still
  works. FFmpeg is never installed automatically
- Video quality presets: **Best / 2160p / 1440p / 1080p / 720p / 480p /
  360p** (best stream at or below the chosen height, plus best audio,
  with a fallback when separate streams are unavailable)
- Real, live progress parsed from yt-dlp output: percentage, speed, ETA,
  filename — never faked
- Videos saved to your chosen output folder (default: the system
  Downloads folder; the last selected folder is remembered between
  launches, and a missing folder falls back safely to Downloads)
  (`%(title)s [%(id)s].%(ext)s` naming)
- High-quality video may need FFmpeg to merge separate streams; a missing
  FFmpeg produces an understandable error, never a fake file
- Clear per-job states with an **Open Folder** button that opens the
  actual folder each download went to
- FIFO download queue: enqueue while one runs (the form stays usable),
  one active yt-dlp job at a time, waiting jobs removable, automatic
  continuation after success/error/cancellation. Session-only, not
  persisted
- Active downloads can be cancelled: the yt-dlp job (including any
  FFmpeg child on Windows) is terminated and cancellation is reported
  as its own neutral state, not an error. Cancelling may leave a
  resumable partial (`.part`) file behind
- Dependency detection with Refresh: bundled yt-dlp version, system
  Deno status, system FFmpeg status (with ffprobe note)
- Understandable errors (bad URL, unavailable/private video, unavailable
  quality, missing FFmpeg, HTTP and network failures, missing yt-dlp
  binary, missing Deno) with stderr details in the UI
- FIFO queue owns ordering with exactly one active yt-dlp job, so
  concurrent downloads can't collide

## Tech stack

- **Tauri 2** — native window, commands, and events
- **React + TypeScript + Vite** — frontend
- **Rust (Tokio)** — backend: process spawning, output parsing, events
- **CSS variables / modular CSS** — dark desktop-utility styling
- **Lucide React** — icons

No Electron. No Python. No browser-only mode. The React layer never
builds shell strings — it only invokes Tauri commands. All yt-dlp
execution happens in Rust.

## Architecture overview

```text
React UI (draft form + queue rows)
  │  invoke("enqueue_download" / "cancel_job") / listen("download-*")
  ▼
Tauri commands  (src-tauri/src/commands/download.rs)
  │  validate, FIFO queue, single worker, cancel/remove by job ID
  ▼
yt-dlp service  (src-tauri/src/services/ytdlp.rs)
  │  resolve binary, build argv, spawn process,
  │  parse stdout, emit job-tagged events
  ▼
yt-dlp.exe  (direct execution, one argv element per argument)
```

- The binary is executed **directly** with individual arguments
  (`Command::new(binary).args([...])`). There is no `cmd.exe /c`
  wrapping and no string concatenation, so URLs can't break quoting or
  inject commands.
- The process runs **asynchronously** (Tokio) with piped stdout/stderr;
  the UI never blocks.
- Progress flows backend → frontend as Tauri events:
  `download-progress`, `download-complete`, `download-error`.
- The UI stays in `initializing` until all event listeners are
  registered — a download can never start with nowhere to report to.
- A restrictive Content Security Policy is configured (no remote
  scripts; Tauri appends its compile-time hashes/nonces automatically).
- Argument construction lives in `build_download_args()` (with the
  `format_selector()` media/quality mapping) and binary discovery in
  `resolve_ytdlp_path()` — one place each, ready to grow
  (`DownloadOptions` carries `media_type` / `quality` plus future
  `subtitles` / `playlist` fields).

## Folder structure

```text
yt-dlp-gui/
├── src/
│   ├── components/            # UrlInput, DownloadButton,
│   │                          # DownloadProgress, CancelButton,
│   │                          # MediaTypeSelector, QualitySelector,
│   │                          # AudioFormatSelector, QueueSection,
│   │                          # OutputFolderSelector, DependencySection
│   ├── features/downloads/
│   │   ├── hooks/useDownloadQueue.ts  # FIFO jobs + init + draft form
│   │   ├── downloadService.ts     # Tauri invoke/listen/dialog wrapper + errors
│   │   ├── options.ts             # MediaType, VideoQuality, DownloadRequest
│   │   ├── outputDirectory.ts     # output-folder preference persistence
│   │   └── types.ts               # JobStatus, DownloadJob, job events
│   ├── features/dependencies/
│   │   ├── hooks/useDependencies.ts  # idle|loading|ready|error checks
│   │   ├── dependencyService.ts      # check_dependencies wrapper
│   │   └── types.ts
│   ├── styles/                # variables.css, globals.css
│   ├── App.tsx                # composes components (no business logic)
│   └── main.tsx
├── src-tauri/
│   ├── src/
│   │   ├── commands/
│   │   │   ├── download.rs        # enqueue/cancel_job, FIFO worker, dirs,
│   │   │   │                      # open_output_folder
│   │   │   └── dependencies.rs    # check_dependencies
│   │   ├── services/
│   │   │   ├── ytdlp.rs           # binary resolver, argv builder,
│   │   │   │                      # progress parser, process runner
│   │   │   └── dependencies.rs    # yt-dlp/Deno/FFmpeg detection
│   │   ├── lib.rs                 # composition root
│   │   └── main.rs
│   ├── resources/bin/yt-dlp.exe   # bundled downloader binary
│   ├── capabilities/default.json
│   ├── icons/
│   ├── Cargo.toml
│   └── tauri.conf.json
├── scripts/verify-ytdlp.ps1   # checks the bundled binary runs
├── package.json
├── vite.config.ts
└── tsconfig.json
```

## Development prerequisites

- **Node.js 22.22.2+** and npm (required by the jsdom/vitest test tree)
- **Rust 1.88+** via [rustup](https://rustup.rs/) (stable; this is the
  verified minimum: the dependency tree requires it, and the code uses
  lint syntax that needs 1.81+)
- **Visual Studio 2022 Build Tools** with the C++ workload
  (provides MSVC `link.exe` — required to link the Tauri binary and to
  run `cargo test` on Windows)
- **WebView2 Runtime** (preinstalled on Windows 10/11)
- **FFmpeg** (optional, not bundled): yt-dlp's default format selection
  may download separate video and audio streams and merge them. Merging
  needs an `ffmpeg` reachable via `PATH` (any standard install works,
  e.g. `C:\ytdlp`). Without it, such downloads fail with an
  understandable error instead of silently producing a wrong file.
- **Deno** (optional, not bundled): yt-dlp discovers a system Deno
  install via `PATH` and uses it as its JavaScript runtime for sites
  that need one. Without it yt-dlp prints a warning and some formats
  may be missing. The app never bundles or manages Deno itself. The app
  detects Deno from `PATH` and from the standard `~/.deno/bin`
  location; if Deno is found there but is not on `PATH`, the app makes
  it available to the yt-dlp child process without modifying the user's
  system `PATH`.

The app detects all three at startup (Dependencies section + Refresh)
but does NOT automatically install Deno or FFmpeg yet.

## Installation steps

```powershell
git clone <repo-url>
cd yt-dlp-gui
npm install
```

The `yt-dlp.exe` binary ships in `src-tauri/resources/bin/`. Verify it:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\verify-ytdlp.ps1
```

## How to start development

```powershell
npm run tauri dev
```

This starts Vite (http://localhost:1420) and opens the native window
with live reload.

## How to build

```powershell
npm run tauri build
```

Produces a Windows installer/bundle. The `yt-dlp.exe` resource is
included via the `bundle.resources` entry in `tauri.conf.json`.

## Checks

```powershell
npm run build          # tsc --noEmit + vite production build
npm test               # vitest: event-readiness state machine tests
cd src-tauri
cargo fmt --check
cargo clippy -- -D warnings
cargo check
cargo test             # needs MSVC link.exe on Windows
```

## Current limitations

- One download at a time (MVP guard; the state type is shaped to become
  a queue later).
- Always downloads to the Windows Downloads folder, always a single
  video (`--no-playlist`), yt-dlp's default format selection (separate
  streams are merged when FFmpeg is available; the reported filename is
  always the real post-merge file).
- No quality picker, audio-only/MP3 mode, subtitle, playlist, history,
  cancellation, settings, or updater UI yet.
- Full linking and `cargo test` of the Tauri crate require MSVC; with
  only a GNU toolchain, `cargo check`/`clippy` still validate the code.
- The placeholder `icon.icns` is bundle filler for non-Windows targets;
  run `npm run tauri icon` with final artwork before a macOS release.

## Future roadmap

Completed:
- quality selector (Best / 2160p–360p presets)
- video / native-audio download mode
- output folder selection (native picker, remembered, safe fallback)
- dependency detection (bundled yt-dlp, system Deno, system FFmpeg)
- audio format conversion (Original/MP3/M4A/WAV/FLAC via FFmpeg)
- cancellation (terminates the yt-dlp job tree, neutral Cancelled state)
- sequential download queue (FIFO, one active job, remove/cancel,
  auto-continue, session-only)

Possible next:
- playlist support
- history
- dependency setup assistance
etc.

## License

MIT. yt-dlp itself is public-domain software by its authors; see
https://github.com/yt-dlp/yt-dlp.
