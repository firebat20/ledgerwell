// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use tauri::{AppHandle, Manager};

#[tauri::command]
async fn get_ledger(app: AppHandle) -> Result<Option<String>, String> {
    let mut path = app.path().app_data_dir().map_err(|e| e.to_string())?;
    path.push("ledger.json");
    if !path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    Ok(Some(content))
}

#[tauri::command]
async fn set_ledger(app: AppHandle, content: String) -> Result<(), String> {
    let mut dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    }

    let mut path = dir.clone();
    path.push("ledger.json");

    // Atomic write: write to a sibling temp file, then rename over the target.
    // A rename within the same directory is atomic on Windows, macOS, and Linux,
    // so a concurrent/next reader never observes a truncated or partial file.
    // (Plain fs::write truncates-then-writes, leaving a corrupt file if the
    // process dies mid-write — which then trips the reseed/clobber path on load.)
    let mut tmp = dir;
    tmp.push("ledger.json.tmp");

    fs::write(&tmp, content.as_bytes()).map_err(|e| e.to_string())?;
    match fs::rename(&tmp, &path) {
        Ok(()) => Ok(()),
        Err(e) => {
            // Best-effort cleanup so a failed rename doesn't leave a stray temp file.
            let _ = fs::remove_file(&tmp);
            Err(e.to_string())
        }
    }
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![get_ledger, set_ledger])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
