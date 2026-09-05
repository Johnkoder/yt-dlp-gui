//! Narrowly scoped dependency-status command. Detection itself lives in
//! `crate::services::dependencies`; this only exposes the single report.

use tauri::AppHandle;

use crate::services::dependencies::{self, DependencyReport};

/// Detect yt-dlp, Deno, and FFmpeg and return one whole report. Never fails
/// overall: individual probes degrade to Missing/Error inside the report.
#[tauri::command]
pub async fn check_dependencies(app: AppHandle) -> DependencyReport {
    dependencies::check_all(&app).await
}
