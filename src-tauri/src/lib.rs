//! yt-dlp GUI backend entry point.
//!
//! Thin composition root: manage shared state, register Tauri commands,
//! and run the application. Download logic lives in `commands` and
//! `services` — never here.

mod commands;
mod services;

use commands::{DownloadState, HistoryState};

/// Build the Tauri application. Split from `main` so integration tests
/// and tooling can construct the app without launching it.
pub fn build_app() -> tauri::Builder<tauri::Wry> {
    tauri::Builder::default()
        .manage(DownloadState::default())
        .manage(HistoryState::default())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::download::enqueue_download,
            commands::download::enqueue_playlist,
            commands::download::cancel_job,
            commands::download::get_downloads_dir,
            commands::download::validate_output_directory,
            commands::download::open_output_folder,
            commands::dependencies::check_dependencies,
            commands::history::get_history,
            commands::history::clear_history,
        ])
}

pub fn run() {
    build_app()
        .run(tauri::generate_context!())
        .expect("failed to run yt-dlp GUI");
}
