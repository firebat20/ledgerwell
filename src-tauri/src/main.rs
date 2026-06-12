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
    let mut path = app.path().app_data_dir().map_err(|e| e.to_string())?;
    if !path.exists() {
        fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    }
    path.push("ledger.json");
    fs::write(path, content).map_err(|e| e.to_string())?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![get_ledger, set_ledger])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
