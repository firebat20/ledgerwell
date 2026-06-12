# Migration: static web app → Tauri desktop app with price history

This plan moves LedgerWell from a static, open-`index.html` web app to a Tauri
desktop application that fetches and stores daily price history. It is written to
be executed in **phases that each ship on their own**, so the app is never broken
for long and every step is reversible.

## Why Tauri, why now

The triggering requirement is **daily price history** (≈100 symbols × 5 years ≈
126k rows) to drive performance charts. That data is too large for `localStorage`
(~5 MB cap), is append-heavy, and is queried by date range — i.e. it wants a real
database. A desktop wrapper also gives us network access without browser CORS
restrictions and a place to schedule updates.

We use **Stooq** as the price source. Stooq is a plain CSV-over-HTTP download with
no API key, no auth handshake, and no client library — so, unlike yfinance, it
pulls **no Python/pandas** into the stack. That keeps the app single-language
(JavaScript) and lets Tauri stay lean (a few-MB webview shell + SQLite), which is
why Tauri wins over Electron here: there is no heavy dependency to offset its size
advantage, and no second language in our own code.

## Guiding principles

1. **The engine stays authoritative.** `engine.js` (in-memory state, `rebuild()`,
   FIFO lots, balances) remains the source of truth for the ledger. We do **not**
   move the ledger into SQL — it is small even when "grown," and rewriting the
   derivation as queries is high-risk for no payoff at personal-finance scale.
2. **Split the two datasets.** Ledger → JSON snapshot (small, written to an app
   file). Prices → SQLite (large, range-queried). This also removes the
   write-amplification problem: the ledger blob stays tiny and prices never touch
   it.
3. **Degrade gracefully.** Keep the app runnable in a plain browser (manual
   prices, no auto-fetch) by feature-detecting Tauri, preserving the existing
   "runs anywhere" property of `storage.js`.
4. **Sources behind an interface.** All fetching goes through the `PriceProvider`
   contract so Stooq can be swapped for Yahoo/Alpha Vantage/etc. without touching
   callers.

## Target architecture

```
index.html                 app shell (unchanged structure)
src/
  storage.js               + "tauri" mode for the ledger JSON (file on disk)
  engine.js                unchanged (authoritative ledger)
  ui.js                    + "Update prices" action, price-history charts
  import.js                unchanged (its parseCSV is reused by the provider)
  price-provider.js        PriceProvider interface + Stooq impl + updatePrices()
  price-store.js           PriceStore: SQLite (Tauri) / memory (browser)
src-tauri/                 Tauri project (Rust shell + config)
  Cargo.toml               tauri-plugin-sql (sqlite), tauri-plugin-http
  tauri.conf.json          window, bundle, sql preload
  capabilities/default.json  grant sql + http permissions
  src/main.rs              register plugins, define DB migrations
docs/
  MIGRATION.md             this file
```

No Python sidecar, no `externalBin`, no PyInstaller — the Stooq choice removes all
of that. The only Rust you touch is registering two plugins and declaring the
SQLite migration.

## Data model (SQLite)

```sql
-- one row per security per trading day (Stooq is UNADJUSTED: close is raw)
CREATE TABLE IF NOT EXISTS prices (
  ticker TEXT NOT NULL,        -- Stooq ticker, e.g. "aapl.us"
  date   TEXT NOT NULL,        -- "YYYY-MM-DD"
  close  REAL NOT NULL,
  open   REAL, high REAL, low REAL, volume INTEGER,
  PRIMARY KEY (ticker, date)
);
CREATE INDEX IF NOT EXISTS idx_prices_ticker_date ON prices(ticker, date);

-- drives incremental fetches
CREATE TABLE IF NOT EXISTS price_meta (
  ticker       TEXT PRIMARY KEY,
  last_date    TEXT,           -- newest date stored
  last_fetched TEXT            -- ISO timestamp of last successful update
);
```

`PriceStore` contract (consumed by `updatePrices` in `price-provider.js`):

```
lastDate(ticker)               -> "YYYY-MM-DD" | null
upsert(ticker, rows)           -> void   (INSERT OR REPLACE; bump price_meta)
range(ticker, fromISO, toISO)  -> rows ascending by date   (for charts)
```

`MemoryPriceStore` (already in `price-provider.js`) implements this for the
browser/dev path; the SQLite implementation backs the same three methods using
`@tauri-apps/plugin-sql`.

## Phases

### Phase 0 — Export / Import JSON (do this in the current web app)
Low-risk, reversible, and the **migration bridge**: Tauri's webview is a fresh
origin, so existing `localStorage` data will not carry over. Export-from-browser →
import-into-desktop is how a user moves their data. Also doubles as backup.
- Add "Export data" (download the serialized state as `.json`) and "Import data"
  (read a file, validate, replace state, `rebuild()` + `save()`).
- **Ship it.**

### Phase 1 — Tauri shell with persistence parity (no new features)
Goal: the desktop app behaves *identically* to the browser version.
- `npm create tauri-app` (or add a `src-tauri/` to the repo); point the Tauri
  window at the existing static files.
- Add a `"tauri"` branch to `storage.js` `STORAGE_MODE` detection and to
  `storeGet`/`storeSet` that writes the ledger JSON to an app-data file (via the
  Store plugin or `fs`). The `storeGet/storeSet(KEY, jsonString)` contract is
  unchanged — only the backend differs.
- Verify the demo seed, edits, CSV import, and reload-persistence all work.
- **Ship it** (an installable app that does what today's app does).

### Phase 2 — SQLite price store
- `cargo add tauri-plugin-sql --features sqlite`; register it in `main.rs`; add the
  migration above (`MigrationKind::Up`, version 1). Grant `sql:default` (plus
  `sql:allow-execute`/`allow-select` as needed) in `capabilities/default.json`.
- Add `src/price-store.js` with a `SqlitePriceStore` implementing the contract via
  `Database.load("sqlite:LedgerWell.db")`.
- Move manual price entry (the existing price inputs in the Investments view) to
  read/write SQLite via the store. No network yet.
- Wire `store.range()` into a first price-history chart to prove the read path.

### Phase 3 — Stooq fetch, manual button first
- Add `cargo add tauri-plugin-http`; grant `http:default` with Stooq in the
  allowlist (`https://stooq.com/*`). Inject `@tauri-apps/plugin-http`'s `fetch`
  as the `httpGet` for `StooqProvider` (native request, bypasses CORS).
- Build a symbol-mapping step: each security's `symbol` → Stooq ticker via
  `provider.mapSymbol` (`.us` suffix, `^` indices, `symbolOverrides` for the rest).
  Persist overrides next to the security.
- Add an **"Update prices"** button that calls `updatePrices({provider, store,
  securities, throttleMs})`. It fetches **deltas only** (after each ticker's
  `last_date`), throttles between requests, and **stops on the quota error**,
  surfacing the summary (updated / rows added / skipped / quota).
- Get one symbol working end-to-end before looping all of them.

### Phase 4 — bulk archive + automation
- **Bulk path (quota workaround):** when the daily per-symbol limit is hit (or for
  a first big backfill), download Stooq's US end-of-day archive in **one** request,
  unzip it, and extract only the held symbols. Download + unzip happen in the Tauri
  layer (HTTP plugin to fetch the archive; unzip in Rust or a JS unzip lib).
  Confirm the exact archive URL from <https://stooq.com/db/>.
- **Automation:** on launch, check `price_meta.last_fetched` and refresh anything
  stale; optionally a daily schedule. Keep the manual button.

### Phase 5 — reporting & charting on top
With ledger (in memory) + prices (SQLite range queries) both available: portfolio
value over time, per-holding performance, realized/unrealized trends. If you ever
want unified cross-year queries you may write a denormalized read-model of the
ledger into the same SQLite file, but the engine stays the source of truth.

## Stooq specifics that shape the data layer

- **Daily hit quota.** Stooq returns "Exceeded the daily hits limit" instead of
  data when you make too many per-symbol requests. The provider raises a `QUOTA`
  error and `updatePrices` stops; the answer is the **bulk archive** (Phase 4),
  which is one request for the whole market. Throttle per-symbol fetches
  (`throttleMs`) and prefer bulk for large refreshes.
- **No split/dividend adjustment.** Stooq closes are **raw/unadjusted**. That is
  exactly right for market value (`shares × close` matches your actual share
  count), but it means there is no `adjclose` for clean long-run performance
  charts, and **a stock split will desync stored prices from your FIFO lot share
  counts** unless you handle it. Decide the split policy explicitly: detect splits
  and adjust lots, or reload affected history. (This connects to the
  "specific-lot / average-cost" item already on the ROADMAP.)
- **Symbology.** US tickers need `.us`; indices use a `^` prefix; broad global
  coverage otherwise. Use `symbolOverrides` for anything that doesn't follow the
  default rule.

## Decisions to lock before Phase 1

- **Rust toolchain** must be installed to build Tauri; accept a tiny amount of
  Rust (plugin registration + migration) and stay in JS for everything else.
- **Adjusted vs raw price policy** (above) — determines whether you store/handle
  any adjustment and every downstream chart.
- **Distribution & signing.** For personal/internal use, skip it. To share builds,
  budget for macOS notarization and a Windows code-signing certificate.
- **Webview variance.** Tauri uses each OS's webview (WebView2 / WKWebView /
  WebKitGTK); smoke-test rendering on the platforms you target, especially Linux.

## Load order (scripts)

```
storage.js → engine.js → ui.js → import.js → price-provider.js → price-store.js
```
`price-provider.js` reuses `import.js`'s global `parseCSV` when present and falls
back to a simple splitter otherwise, so this order is preferred but not fragile.
