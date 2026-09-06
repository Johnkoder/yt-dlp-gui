# Third-party notices

This project (yt-dlp GUI) is original source code licensed under MIT
(see `LICENSE`). The following third-party components retain their own
licenses. This file names each component, its license, and where the full
license text can be found. It is not legal advice.

## Bundled at build/runtime

### yt-dlp (source project)
- What: the underlying media downloader. This GUI fetches the official
  prebuilt `yt-dlp.exe` at build setup time (see
  `scripts/ytdlp-version.json`) and bundles it into packaged builds as an
  application resource. The GUI launches it as a separate child process
  and incorporates no yt-dlp source code.
- Upstream: https://github.com/yt-dlp/yt-dlp
- Source license: **The Unlicense** (public-domain dedication).
  Full text: https://github.com/yt-dlp/yt-dlp/blob/master/LICENSE

### yt-dlp official prebuilt executable (what is actually redistributed)
- The official PyInstaller-bundled executables are **not** covered by the
  Unlicense alone. Per the [official 2026.08.19 release notes](https://github.com/yt-dlp/yt-dlp/releases/tag/2026.08.19):
  the release tarball/zipimport binary contain ISC/MIT code, while the
  PyInstaller-bundled executables "are subject to these and other
  licenses, all of which are compiled in THIRD_PARTY_LICENSES.txt".
  That upstream file lists components under permissive licenses as well
  as GPL/LGPL-family licenses (including GPL-3.0-or-later and
  GPL-2.0-or-later entries) — consult it as the authoritative list.
- The exact upstream file for the pinned release is vendored verbatim at
  `third-party/yt-dlp/THIRD_PARTY_LICENSES.txt` (see
  `third-party/yt-dlp/README.md` for version, source commit, and URL) and
  is included in packaged builds alongside the application so
  redistributions carry the applicable upstream notices.
- This GUI project itself stays MIT-licensed: it is a separate program
  that invokes the official executable as a child process. This note is
  not legal advice.

## Application framework and UI libraries

### Tauri (Rust core + JS API + CLI + plugins)
- Upstream: https://github.com/tauri-apps/tauri
- License: **MIT OR Apache-2.0** (dual license, your choice).
  Full texts: https://github.com/tauri-apps/tauri/blob/dev/LICENSE_MIT
  and `LICENSE_APACHE-2.0` in the same repository. Per-crate license
  metadata is pinned in `src-tauri/Cargo.lock`.

### React + ReactDOM
- Upstream: https://github.com/facebook/react
- License: **MIT**.
  Full text ships in the installed package (`node_modules/react/LICENSE`
  after `npm install`).

### Vite
- Upstream: https://github.com/vitejs/vite
- License: **MIT**.
  Full text ships in the installed package (`node_modules/vite/LICENSE*`
  after `npm install`).

### Lucide icons (lucide-react)
- Upstream: https://github.com/lucide-icons/lucide
- License: **ISC**.
  Full text ships in the installed package (`node_modules/lucide-react/LICENSE`
  after `npm install`).

## Other dependencies

The complete, pinned dependency trees — including transitive crates and
packages with their own licenses — are recorded in `package-lock.json`
(npm) and `src-tauri/Cargo.lock` (Cargo). Consult those files and the
upstream repositories for authoritative licensing of any component not
listed above.
