// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;
use tauri::Emitter;
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

/* ============================================================
   Phase 4 — bulk price archive (docs/MIGRATION.md)

   Stooq's per-symbol CSV endpoint enforces a low daily hit limit, so a full
   refresh of many names is done with ONE request for the whole US end-of-day
   market: a ~333 MB zip of per-symbol `.txt` files (full daily history).

   We do the whole job natively here — stream the download to a temp file (so
   the 333 MB never sits in the webview's memory), unzip, and keep only the
   tickers the ledger actually holds — then hand the small filtered result back
   to JS, which upserts it through the existing PriceStore contract. This also
   means the download bypasses the webview's tauri-plugin-http allowlist; only
   the Phase 3 per-symbol path (on stooq.com) needs that capability entry.

   The archive lives on a different host than the per-symbol endpoint:
       https://static.stooq.com/db/h/d_us_txt.zip
   Each `.txt` is CSV with a header like:
       <TICKER>,<PER>,<DT>,<TIME>,<OPEN>,<HIGH>,<LOW>,<CLOSE>,<VOL>,<OPENINT>
   where <DT> is an integer date "YYYYMMDD" (note: NOT the ISO format the
   Phase 3 per-symbol parser handles), so this has its own small parser.
   ============================================================ */

const STOOQ_BULK_US_URL: &str = "https://static.stooq.com/db/h/d_us_txt.zip";

/// One requested security: its Stooq ticker (lowercased stem, e.g. "aapl.us")
/// and the newest date already stored. `since` keeps the returned payload
/// incremental — only rows strictly after it are returned (null = backfill).
#[derive(serde::Deserialize)]
struct TickerRequest {
    ticker: String,
    since: Option<String>,
}

#[derive(serde::Serialize, Clone)]
struct PriceRow {
    date: String,
    close: f64,
    open: Option<f64>,
    high: Option<f64>,
    low: Option<f64>,
    volume: Option<i64>,
}

/// "20240115" -> "2024-01-15"; None if it isn't 8 digits.
fn dt_to_iso(dt: &str) -> Option<String> {
    let dt = dt.trim();
    if dt.len() != 8 || !dt.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some(format!("{}-{}-{}", &dt[0..4], &dt[4..6], &dt[6..8]))
}

/// Parse one Stooq bulk `.txt` body. Resolves columns from the header when
/// present (falling back to Stooq's standard daily layout) and keeps only rows
/// strictly after `since`.
fn parse_bulk_txt(body: &str, since: Option<&str>) -> Vec<PriceRow> {
    // Defaults follow the standard daily layout:
    // <TICKER>(0) <PER>(1) <DT>(2) <TIME>(3) <OPEN>(4) <HIGH>(5) <LOW>(6) <CLOSE>(7) <VOL>(8) <OPENINT>(9)
    let mut i_date = 2usize;
    let mut i_open = Some(4usize);
    let mut i_high = Some(5usize);
    let mut i_low = Some(6usize);
    let mut i_close = 7usize;
    let mut i_vol = Some(8usize);

    let mut rows = Vec::new();
    for (n, line) in body.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        // Header row: resolve indices by name, then skip it. A header always
        // contains '<'; a data row never does, so a missing header is handled.
        if n == 0 && line.contains('<') {
            let cols: Vec<String> = line
                .split(',')
                .map(|c| {
                    c.trim()
                        .trim_start_matches('<')
                        .trim_end_matches('>')
                        .to_ascii_lowercase()
                })
                .collect();
            let find = |names: &[&str]| cols.iter().position(|c| names.iter().any(|nm| c == nm));
            if let Some(x) = find(&["dt", "date"]) {
                i_date = x;
            }
            if let Some(x) = find(&["close"]) {
                i_close = x;
            }
            i_open = find(&["open"]).or(i_open);
            i_high = find(&["high"]).or(i_high);
            i_low = find(&["low"]).or(i_low);
            i_vol = find(&["vol", "volume"]).or(i_vol);
            continue;
        }

        let f: Vec<&str> = line.split(',').collect();
        let date = match f.get(i_date).and_then(|d| dt_to_iso(d)) {
            Some(d) => d,
            None => continue,
        };
        if let Some(s) = since {
            if date.as_str() <= s {
                continue;
            }
        }
        let close = match f.get(i_close).and_then(|v| v.trim().parse::<f64>().ok()) {
            Some(c) => c,
            None => continue,
        };
        let getf = |i: Option<usize>| -> Option<f64> {
            i.and_then(|idx| f.get(idx))
                .and_then(|v| v.trim().parse::<f64>().ok())
        };
        rows.push(PriceRow {
            date,
            close,
            open: getf(i_open),
            high: getf(i_high),
            low: getf(i_low),
            volume: getf(i_vol).map(|x| x as i64),
        });
    }
    rows
}

/// Blocking worker: download -> temp file -> unzip -> filter to held tickers.
/// Emits coarse "bulk-progress" events ({phase, downloaded, total}) so the UI
/// can show the long (~333 MB) download moving.
fn bulk_fetch_us_blocking(
    requests: Vec<TickerRequest>,
    window: Option<tauri::WebviewWindow>,
) -> Result<HashMap<String, Vec<PriceRow>>, String> {
    // ticker (lowercased stem) -> since
    let mut since_by: HashMap<String, Option<String>> = HashMap::new();
    for r in &requests {
        since_by.insert(r.ticker.trim().to_ascii_lowercase(), r.since.clone());
    }
    let wanted: HashSet<String> = since_by.keys().cloned().collect();
    if wanted.is_empty() {
        return Ok(HashMap::new());
    }

    let emit = |phase: &str, downloaded: u64, total: u64| {
        if let Some(w) = &window {
            let _ = w.emit(
                "bulk-progress",
                serde_json::json!({ "phase": phase, "downloaded": downloaded, "total": total }),
            );
        }
    };

    // ---- download (streamed straight to disk) ----
    emit("downloading", 0, 0);
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_secs(30))
        .timeout_read(std::time::Duration::from_secs(120))
        .build();
    let resp = agent
        .get(STOOQ_BULK_US_URL)
        .set("User-Agent", "Mozilla/5.0 (LedgerWell)")
        .call()
        .map_err(|e| format!("download failed: {}", e))?;
    let total: u64 = resp
        .header("Content-Length")
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);

    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut tmp_path = std::env::temp_dir();
    tmp_path.push(format!("LedgerWell-d_us_txt-{}-{}.zip", std::process::id(), unique));

    let mut file = fs::File::create(&tmp_path).map_err(|e| e.to_string())?;
    let mut reader = resp.into_reader();
    let mut buf = [0u8; 1 << 16]; // 64 KiB
    let mut downloaded: u64 = 0;
    let mut last_emit: u64 = 0;
    loop {
        let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        downloaded += n as u64;
        if downloaded - last_emit >= 4 * 1024 * 1024 {
            last_emit = downloaded;
            emit("downloading", downloaded, total);
        }
    }
    file.flush().map_err(|e| e.to_string())?;
    drop(file);
    emit("downloading", downloaded, total);

    // ---- unzip + filter ----
    emit("extracting", 0, wanted.len() as u64);
    let zipfile = fs::File::open(&tmp_path).map_err(|e| e.to_string())?;
    let mut archive = match zip::ZipArchive::new(zipfile) {
        Ok(a) => a,
        Err(e) => {
            let _ = fs::remove_file(&tmp_path);
            // A non-zip body here usually means Stooq served an error/limit page.
            return Err(format!(
                "couldn't open the archive (Stooq may have rate-limited the download): {}",
                e
            ));
        }
    };

    let mut out: HashMap<String, Vec<PriceRow>> = HashMap::new();
    let mut matched: u64 = 0;
    for i in 0..archive.len() {
        let mut entry = match archive.by_index(i) {
            Ok(e) => e,
            Err(_) => continue,
        };
        if entry.is_dir() {
            continue;
        }
        let name = entry.name().to_string();
        let lname = name.to_ascii_lowercase();
        if !lname.ends_with(".txt") {
            continue;
        }
        // stem = final path component without ".txt", lowercased -> "aapl.us"
        let base = lname.rsplit(|c| c == '/' || c == '\\').next().unwrap_or(&lname);
        let stem = &base[..base.len().saturating_sub(4)];
        if !wanted.contains(stem) {
            continue;
        }

        let mut content = String::new();
        if entry.read_to_string(&mut content).is_err() {
            continue;
        }
        let since = since_by.get(stem).and_then(|s| s.as_deref());
        let rows = parse_bulk_txt(&content, since);
        if !rows.is_empty() {
            out.insert(stem.to_string(), rows);
        }
        matched += 1;
        if matched % 10 == 0 {
            emit("extracting", matched, wanted.len() as u64);
        }
    }

    let _ = fs::remove_file(&tmp_path);
    emit("done", matched, wanted.len() as u64);
    Ok(out)
}

#[tauri::command]
async fn bulk_fetch_us(
    window: tauri::WebviewWindow,
    requests: Vec<TickerRequest>,
) -> Result<HashMap<String, Vec<PriceRow>>, String> {
    // Heavy, blocking IO — run it off the async runtime so the UI stays live.
    tauri::async_runtime::spawn_blocking(move || bulk_fetch_us_blocking(requests, Some(window)))
        .await
        .map_err(|e| e.to_string())?
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
        // Phase 3: native HTTP client for Stooq fetches (no CORS). The allowed
        // URL scope is granted in capabilities/default.json.
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![
            get_ledger,
            set_ledger,
            get_data_dir,
            bulk_fetch_us
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
