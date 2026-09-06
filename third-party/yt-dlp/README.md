# Third-party material: yt-dlp

This folder vendors licensing material for the **prebuilt official
yt-dlp executable** that this project fetches at build setup time and
bundles into packaged releases. It is not application source code.

- Upstream project: https://github.com/yt-dlp/yt-dlp
- yt-dlp version used: **2026.08.19**
  (pinned in `scripts/ytdlp-version.json`)
- Upstream source commit for this material:
  `3a08beaf031ab68f966401ead017ac81fe8486cf`
  (the commit tagged `2026.08.19`)

## Files

- `THIRD_PARTY_LICENSES.txt` — copied **verbatim, byte-for-byte** from
  the official upstream source at:

  https://raw.githubusercontent.com/yt-dlp/yt-dlp/3a08beaf031ab68f966401ead017ac81fe8486cf/THIRD_PARTY_LICENSES.txt

  Per the [official 2026.08.19 release notes](https://github.com/yt-dlp/yt-dlp/releases/tag/2026.08.19):
  the zipimport executable and release tarball contain ISC/MIT code,
  while the PyInstaller-bundled executables (including `yt-dlp.exe`)
  are subject to those and other licenses, all compiled in this file.

## Why this file ships with releases

The prebuilt `yt-dlp.exe` redistributed inside this project's packaged
builds includes third-party components under licenses including
permissive licenses as well as GPL/LGPL-family licenses (see the file
itself for the authoritative list). This file is therefore bundled
alongside the application (see `bundle.resources` in
`src-tauri/tauri.conf.json`) so redistributions carry the applicable
upstream notices.

This GUI project itself remains MIT-licensed original source code (see
`LICENSE`). It launches the official prebuilt executable as a separate
child process and does not incorporate yt-dlp source code. This note is
not legal advice.
