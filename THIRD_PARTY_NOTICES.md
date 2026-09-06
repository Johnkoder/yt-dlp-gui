# Third-party notices

This project (yt-dlp GUI) is original source code licensed under MIT
(see `LICENSE`). The following third-party components retain their own
licenses. This file names each component, its license, and where the full
license text can be found. It is not legal advice.

## Bundled at build/runtime

### yt-dlp
- What: the underlying media downloader; `yt-dlp.exe` is fetched from the
  official upstream release (see `scripts/ytdlp-version.json`) and bundled
  into packaged builds as an application resource.
- Upstream: https://github.com/yt-dlp/yt-dlp
- License: **The Unlicense** (public-domain dedication).
  Full text: https://github.com/yt-dlp/yt-dlp/blob/master/LICENSE

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
