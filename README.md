# yt-dlp GUI

A Windows desktop app that downloads videos without the command line.
Paste a URL, press **Download Video**, watch real progress, and find the
file in your Downloads folder.

**yt-dlp** does the actual downloading — this app is a native GUI around
the `yt-dlp.exe` binary, which is bundled as an application resource.

## Current MVP features

- Paste a video URL and download it with one click (Enter works too)
- Real, live progress parsed from yt-dlp output: percentage, speed, ETA,
  filename — never faked
- Videos saved to the user's Windows Downloads folder
  (`%(title)s [%(id)s].%(ext)s` naming)
- Clear success state with an **Open Downloads** button
- Understandable errors (bad URL, unavailable/private video, HTTP and
  network failures, missing yt-dlp binary, missing Deno) with stderr
  details in the UI
- Single-download guard so concurrent MVP downloads can't collide

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
React UI
  │  invoke("start_download") / listen("download-*")
  ▼
Tauri commands  (src-tauri/src/commands/download.rs)
  │  validate, guard, spawn background task
  ▼
yt-dlp service  (src-tauri/src/services/ytdlp.rs)
  │  resolve binary, build argv, spawn process,
  │  parse stdout, emit structured events
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
- Argument construction lives in `build_download_args()` and binary
  discovery in `resolve_ytdlp_path()` — one place each, ready to grow
  (`DownloadOptions` already carries future `quality` / `format` /
  `audio_only` / `subtitles` / `playlist` fields).

## Folder structure

```text
yt-dlp-gui/
├── src/
│   ├── components/            # UrlInput, DownloadButton,
│   │                          # DownloadProgress, StatusMessage
│   ├── features/downloads/
│   │   ├── hooks/useDownload.ts   # idle|downloading|success|error machine
│   │   ├── downloadService.ts     # Tauri invoke/listen wrapper + error map
│   │   └── types.ts
│   ├── styles/                # variables.css, globals.css
│   ├── App.tsx                # composes components (no business logic)
│   └── main.tsx
├── src-tauri/
│   ├── src/
│   │   ├── commands/download.rs   # start_download, get_downloads_dir,
│   │   │                          # open_downloads_folder
│   │   ├── services/ytdlp.rs      # binary resolver, argv builder,
│   │   │                          # progress parser, process runner
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
  understandable error instead of silently producing a wrong file. A
  proper dependency screen is on the roadmap.
- **Deno** (optional, not bundled): yt-dlp discovers a system Deno
  install via `PATH` and uses it as its JavaScript runtime for sites
  that need one. Without it yt-dlp prints a warning and some formats
  may be missing. The app never bundles or manages Deno itself.

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

Download queue · multiple simultaneous downloads · quality selection ·
audio-only/MP3 · output folder selection · subtitles · thumbnails ·
metadata · playlists · history · cancellation · settings · yt-dlp
self-updates · FFmpeg management · dependency checks.

## License

MIT. yt-dlp itself is public-domain software by its authors; see
https://github.com/yt-dlp/yt-dlp.
