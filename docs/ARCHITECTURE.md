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

Market value is never a transaction; it's `shares × current price`. Unrealized gain is
`market value − cost basis`, so price edits revalue everything without touching the ledger.

## Files

`storage.js` (persistence) → `engine.js` (state, mutations, derived balances) →
`ui.js` (rendering and handlers). Scripts are plain globals (not ES modules) so the app
also runs from a `file://` open.
