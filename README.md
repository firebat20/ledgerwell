# LedgerWell

A light, Quicken-style personal finance app built on a real **double-entry ledger**.
Every transaction posts balanced entries (debits = credits), which keeps the books
internally consistent and makes reporting straightforward to build on.

> Status: Working desktop/web application with portfolio/gains reporting, CSV importing, price fetching/bulk refresh, and stock split detection.

## Features

- **Multiple accounts** grouped into Banking, Credit, and Investments, with per-group subtotals and a running net-worth figure.
- **Double-entry engine** — each transaction is a set of postings that sum to zero. Categories are income/expense accounts; transfers are account-to-account postings; opening balances post against Opening Balance Equity.
- **Account registers** with running balances and a cleared flag; click any row to see its underlying journal entry.
- **Investment portfolio** that holds multiple securities separately, each with lots, **FIFO cost basis**, realized/unrealized gain, and live market value (shares × price). Buy / Sell / Dividend / Split actions.
- **CSV importing** with custom column mapping, live preview, per-row double-entry category/transfer assignment, payer auto-matching, and duplicate detection.
- **Interactive Reports** with zero-dependency inline SVG charts mapping Portfolio Value, Security Holdings, and Realized/Unrealized/Total Gains over time, including interactive crosshairs and hover tooltips.
- **Automatic Stock Split detection** scanning unadjusted historical prices for overnight gaps, suggesting splits via UI banner, and recording split transactions that scale shares and lots.
- **Historical Price database** — a SQLite backend storing daily quotes. Sparklines in the Investments view display recent price trends.
- **Incremental & Bulk Price Fetching** — retrieves quotes from Stooq. For many securities, a native Rust-based bulk archive fetcher downloads/unzips/filters the entire US end-of-day market (~333MB) to bypass daily quotas.
- **Backup & Restore** — exports and imports the entire ledger state as JSON, validating double-entry invariants and structural integrity.

## Running it

LedgerWell runs as either a Tauri desktop application (which enables SQLite history, local file storage, and network price fetching) or as a static web application in the browser.

### Tauri Desktop App (Recommended)
You need Node.js and Rust installed to run the Tauri build:
- **Run in development:**
  ```bash
  npm run tauri dev
  ```
- **Build release bundle:**
  ```bash
  npm run tauri build
  ```

### Static Web Application
Runs directly in the browser (uses memory/localStorage and mock price services):
- **Serve locally (quickest):**
  ```bash
  npm start
  ```
  Then visit `http://localhost:8000`.
- **GitHub Pages:** Deploy the `www` folder; it runs completely client-side.

### Data persistence

`www/src/storage.js` auto-selects a backend so the same code runs anywhere:

| Environment            | Backend used        | Path / Target |
|------------------------|---------------------|---------------|
| Tauri Desktop App      | Local File Storage  | `ledger.json` next to executable |
| Claude artifact runtime| `window.storage`    | Claude storage API |
| Normal browser         | `localStorage`      | Browser cache |
| No storage available   | In-memory (session) | RAM |

Historical prices (SQLite database `LedgerWell.db`) are also stored next to the executable in Tauri.

Use **Reset to demo data** (bottom of the sidebar) to reload the sample dataset.

## Project layout

```
package.json        npm scripts (start, tauri, test)
www/                frontend web app root
  index.html        app shell; loads scripts and boots UI
  src/
    storage.js      persistence adapter (Tauri / Claude / localStorage / memory)
    engine.js       double-entry engine: accounts, postings, lots, balances
    ui.js           rendering + event handlers + modal overlays
    styles.css      design tokens, layout, and component styles
    backup.js       ledger JSON export / import validator
    import.js       CSV column mapper and transactional importer
    investments.js  investment action model & register view
    price-store.js  SQLite & Memory price history and sparklines
    price-provider.js daily price fetching (Stooq provider contracts)
    price-fetch.js  Tauri HTTP price fetch wrapper & sym overrides
    price-bulk.js   bulk US market ZIP downloader and auto-refresh orchestration
    price-splits.js gap split detection and split booking trigger
    charts.js       portfolio history computer and SVG chart renderer
docs/
  ARCHITECTURE.md   how the ledger, investment model, and Tauri backend work
src-tauri/          Tauri v2 project folder (Rust backend)
  src/main.rs       Rust entry, file storage commands, and bulk ZIP parser
  tauri.conf.json   Tauri application configuration
sample-data/        example CSV files for testing imports
test/               Node-based unit test suite for the double-entry engine
```

## License

MIT — see [LICENSE](LICENSE).

