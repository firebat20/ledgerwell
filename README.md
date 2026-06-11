# Ledgerwell

A light, Quicken-style personal finance app built on a real **double-entry ledger**.
Every transaction posts balanced entries (debits = credits), which keeps the books
internally consistent and makes reporting straightforward to build on.

> Status: early/working. Banking + investment accounts, categories, registers,
> portfolio, and a journal view all function. CSV import is next (see ROADMAP).

## Features

- **Multiple accounts** grouped into Banking, Credit, and Investments, with per-group
  subtotals and a running net-worth figure.
- **Double-entry engine** — each transaction is a set of postings that sum to zero.
  Categories are income/expense accounts; transfers are account-to-account postings;
  opening balances post against Opening Balance Equity.
- **Account registers** with running balances and a cleared flag; click any row to
  see its underlying journal entry.
- **Investment accounts** that hold multiple securities separately, each with lots,
  **FIFO cost basis**, realized/unrealized gain, and live market value (shares × price).
  Buy / Sell / Dividend actions; editing a price revalues holdings instantly.
- **Categories manager** and a **Journal** view that proves total debits = total credits.
- **Dashboard** with month income / spending / net cash-flow and a portfolio snapshot.

## Running it

It's a static app — no build step.

- **Quickest:** open `index.html` in a browser.
- **Recommended (avoids any file:// quirks):** serve the folder, e.g.
  `python3 -m http.server` then visit `http://localhost:8000`.
- **GitHub Pages:** enable Pages on the repo; it runs as-is.

### Data persistence

`src/storage.js` auto-selects a backend so the same code runs anywhere:

| Environment            | Backend used        |
|------------------------|---------------------|
| Claude artifact runtime| `window.storage`    |
| Normal browser         | `localStorage`      |
| No storage available   | in-memory (session) |

Use **Reset to demo data** (bottom of the sidebar) to reload the sample dataset.

## Project layout

```
index.html          app shell; loads the scripts and boots
src/
  storage.js        persistence adapter (artifact / localStorage / memory)
  engine.js         double-entry engine: accounts, postings, lots, balances
  ui.js             rendering + event handlers + modals
  styles.css        design tokens and component styles
docs/
  ARCHITECTURE.md   how the ledger and investment model work
sample-data/        example CSVs for developing import
test/               node test harness for the engine
ROADMAP.md          planned work, including CSV import spec
```

## License

MIT — see [LICENSE](LICENSE).
