# Contributing

Small, focused contributions are welcome.

## Workflow

1. Fork the repository and create a branch.
2. Install prerequisites (see README).
3. Run setup:
   - `npm install`
   - `npm run setup:ytdlp`
4. Make your change (keep it small and in the existing architecture).
5. Verify:
   - `npm run build`
   - `npm run lint`
   - `npm test`
   - `cd src-tauri` then `cargo fmt --check`, `cargo check`,
     `cargo clippy --all-targets -- -D warnings`, `cargo test`
6. Open a pull request describing what changed and how it was verified.

## Guidelines

- Match the existing code style and module separation
  (`src/components`, `src/features/*`, `src-tauri/src/{commands,services}`).
- The React frontend must never build shell commands; all process
  execution stays in the Rust backend with separate argv elements.
- Do not bundle large binaries or media files in pull requests.
- Update `README.md` when behavior or setup steps change.
