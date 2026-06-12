// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::path::PathBuf;
use tauri_plugin_sql::{Migration, MigrationKind};

/// Resolve the portable data directory: the folder that contains the running
/// executable.  All user data (ledger.json, LedgerWell.db) lives here so the
/// app is fully self-contained.
fn data_dir() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    exe.parent()
        .map(|p| p.to_path_buf())
        .ok_or_else(|| "cannot resolve exe directory".into())
}

#[tauri::command]
async fn get_ledger() -> Result<Option<String>, String> {
    let mut path = data_dir()?;
    path.push("ledger.json");
    if !path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    Ok(Some(content))
}

#[tauri::command]
async fn set_ledger(content: String) -> Result<(), String> {
    let dir = data_dir()?;
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

/// Expose the portable data directory to the frontend so the JS-side SQL
/// plugin can build the correct absolute `sqlite:` connection string.
#[tauri::command]
async fn get_data_dir() -> Result<String, String> {
    let dir = data_dir()?;
    dir.to_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "data dir path contains non-UTF-8 characters".into())
}

fn main() {
    // Resolve the absolute path for the SQLite database so the sql plugin
    // stores it next to the executable instead of in app_config_dir.
    let db_path = data_dir()
        .expect("cannot resolve exe directory for database")
        .join("LedgerWell.db");
    let db_url = format!("sqlite:{}", db_path.display());

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
                .add_migrations(&db_url, migrations)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![get_ledger, set_ledger, get_data_dir])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
