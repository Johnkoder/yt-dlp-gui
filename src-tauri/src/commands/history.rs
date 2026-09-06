//! Tauri commands for persistent download history.

use tauri::{AppHandle, State};

use crate::services::history::{ClearHistoryResult, HistoryEntry, HistoryState};

/// Retrieve all persisted history entries, ordered newest first.
#[tauri::command]
pub async fn get_history(
    app: AppHandle,
    state: State<'_, HistoryState>,
) -> Result<Vec<HistoryEntry>, String> {
    let mut guard = state.get_manager(&app).await?;
    let manager = guard
        .as_mut()
        .ok_or_else(|| "History manager uninitialized".to_string())?;
    Ok(manager.get_entries_newest_first())
}

/// Clear all persisted history entries. Returns the ID barrier for newly created entries.
#[tauri::command]
pub async fn clear_history(
    app: AppHandle,
    state: State<'_, HistoryState>,
) -> Result<ClearHistoryResult, String> {
    let mut guard = state.get_manager(&app).await?;
    let manager = guard
        .as_mut()
        .ok_or_else(|| "History manager uninitialized".to_string())?;
    manager.clear()
}
