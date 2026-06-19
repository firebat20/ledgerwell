# Architecture

## Double-entry model

A transaction is a list of **postings**, each `{ key, amount }`, where `amount` is
signed and the postings **sum to zero**. An account's balance is the sum of the
postings that reference its key.

Posting keys:

- `acc:<id>` — a banking/credit account.
- `acc:<id>:cash` and `acc:<id>:sec` — the cash and securities-at-cost buckets of an
  investment account.
- `cat:<id>` — a category (income or expense account).
- `sys:opening` — Opening Balance Equity.
- `sys:realized` — Realized Capital Gains.

Examples:

- **Spend $50 on groceries from checking:** `acc:chk −50`, `cat:groceries +50`.
- **Receive $2,000 salary:** `acc:chk +2000`, `cat:salary −2000`.
- **Transfer $500 checking → savings:** `acc:chk −500`, `acc:sav +500`.

Income accounts therefore accumulate negative balances and expenses positive; the
report layer flips signs as needed. Net worth = Σ value of asset/liability accounts
(investments use cash + market value); income/expense accounts are nominal and excluded.

## Investment model

Holdings, lots, and quantities are **derived** from the investment transactions on
every change (`rebuild()`), so editing or deleting a trade safely recomputes basis
and gains rather than mutating stored numbers.

- **Buy** — adds a lot; fee is folded into cost basis. Posts `cash −total`, `sec +total`.
- **Sell** — relieves shares **FIFO** (oldest lots first), books realized gain/loss to
  `sys:realized`. Posts `cash +proceeds`, `sec −costRelieved`, `realized −gain`.
- **Dividend** — `cash +amount`, `cat:dividend −amount`.
- **Split** — a transaction that scales share counts and lot sizes historically, leaving cost basis unchanged.

Market value is never a transaction; it's `shares × current price`. Unrealized gain is
`market value − cost basis`, so price edits revalue everything without touching the ledger.

## Data Persistence & SQLite Database

LedgerWell implements a dual-persistence system to balance performance and simple backups:

1. **The Ledger State (`ledger.json`)**
   Contains the transactional ledger data (accounts, categories, securities, transactions).
   - In Tauri, this is stored next to the executable using `get_ledger` / `set_ledger` commands. Writes are atomic (write to a temporary file then rename) to prevent corruption.
   - Falls back to `window.storage`, `localStorage`, or in-memory.
2. **Historical Price Database (`LedgerWell.db`)**
   Historical pricing datasets are too large for plain JSON. In Tauri, prices are stored in a local SQLite database (`LedgerWell.db`) next to the executable.
   - Schema defines `prices` (ticker, date, close, open, high, low, volume) and `price_meta` (last_date, last_fetched).
   - Interaction is async, orchestrated via `price-store.js` using Tauri's SQL plugin.

## Price Orchestration & Provider Contracts

Pricing data flows through decoupled components:
- **PriceStore**: Provides `lastDate(ticker)`, `upsert(ticker, rows)`, and `range(ticker, from, to)`. Resolves to `SqlitePriceStore` (Tauri) or `MemoryPriceStore` (browser).
- **PriceProvider**: Provides `mapSymbol(sym)` and `fetchDaily(sym, from, to)`. Resolves to `StooqProvider` using either native Tauri HTTP client (to bypass CORS) or browser fetches.
- **Bulk Fetcher**: To bypass Stooq's low daily per-symbol query limits, a native Rust subcommand (`bulk_fetch_us`) downloads the entire US EOD market ZIP archive (~333MB), unzips and parses the EOD text streams directly in Rust memory-efficiently, filters for active tickers, and streams the updates back to JavaScript to be upserted.

## Stock Split Mechanics

Stooq stock prices are unadjusted. When a stock split occurs, a large gap appears in price history.
- `price-splits.js` scans the local price database for overnight gaps that match common split ratios (e.g., 2:1, 7:1, 1:10).
- If detected, it displays a banner to the user.
- On confirmation, it books a `Split` transaction in the ledger. During `rebuild()`, the double-entry engine scales the share counts and lot sizes of the security for all preceding purchases, adjusting balances correctly while preserving historical cost basis.

## Reporting & Portfolio History Replay

To render portfolio and gains charts over time:
- `charts.js` exposes `computePortfolioHistory(from, to)`.
- It first extracts all historical quotes for held securities from the `PriceStore`.
- It then walks the transaction ledger chronologically. For every calendar date, it aggregates running cash balances across investment accounts, calculates share counts for held securities, applies FIFO cost relief on sells, and computes market value (`shares × close`).
- This produces a sequential dataset mapping dates to total portfolio value, cash, market value, cost basis, unrealized gain, realized gain, and individual security holdings.

## Files

`storage.js` (persistence) → `engine.js` (state, mutations, derived balances) →
`ui.js` (rendering and handlers). Scripts are loaded as globals in `index.html` to run seamlessly in local `file://` webviews, Tauri, or served environments. Add-on modules (`backup.js`, `import.js`, `price-*.js`, `charts.js`) tap into these core globals.

