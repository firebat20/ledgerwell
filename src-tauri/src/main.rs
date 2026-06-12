// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use tauri::{AppHandle, Manager};
use tauri_plugin_sql::{Migration, MigrationKind};

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
    let mut tmp = dir;
    tmp.push("ledger.json.tmp");

    fs::write(&tmp, content.as_bytes()).map_err(|e| e.to_string())?;
    match fs::rename(&tmp, &path) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            Err(e.to_string())
        }
    }
}

fn main() {
    // One row per security per trading day; price_meta drives incremental fetches.
    let migrations = vec![Migration {
        version: 1,
        description: "create_price_tables",
        sql: "CREATE TABLE IF NOT EXISTS prices (\
                ticker TEXT NOT NULL, \
                date   TEXT NOT NULL, \
                close  REAL NOT NULL, \
                open REAL, high REAL, low REAL, volume INTEGER, \
                PRIMARY KEY (ticker, date)\
              );\
              CREATE INDEX IF NOT EXISTS idx_prices_ticker_date ON prices(ticker, date);\
              CREATE TABLE IF NOT EXISTS price_meta (\
                ticker       TEXT PRIMARY KEY, \
                last_date    TEXT, \
                last_fetched TEXT\
              );",
        kind: MigrationKind::Up,
    }];

    tauri::Builder::default()
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:LedgerWell.db", migrations)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![get_ledger, set_ledger])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
