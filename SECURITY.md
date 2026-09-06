# Security policy

## Supported status

yt-dlp GUI is a small personal open-source utility. There are no paid
support tiers and no guaranteed response times, but genuine security
reports are taken seriously.

## Reporting a vulnerability

**Please do not open a public GitHub issue for a suspected security
vulnerability** before it has been addressed.

- If GitHub private vulnerability reporting is enabled for this
  repository, use it — that is the preferred channel.
- Otherwise, open a regular issue describing only that you believe you
  found a security-sensitive problem and ask for a private contact,
  without including exploit details.

## Scope notes

The most security-relevant parts of this codebase are:

- Rust process execution (`src-tauri/src/services/ytdlp.rs` — direct argv,
  no shell concatenation),
- Tauri command permissions (`src-tauri/capabilities/default.json`),
- Content Security Policy (`src-tauri/tauri.conf.json`).

However, note that downloaded media files and the third-party binaries
this app drives (yt-dlp, FFmpeg, Deno) carry their own risks; keep those
tools updated and only download content you have the right to access.
