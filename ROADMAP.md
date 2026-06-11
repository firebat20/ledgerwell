# Roadmap

## Next up — CSV import (in progress)

Import a bank/credit/investment export into a chosen account. Requirements:

1. **Choose the destination account** for the import.
2. **Column mapping & verification** — map the file's columns to Date, Description,
   and Amount (support either one signed Amount column or separate Debit/Credit
   columns), with a live preview so the user can verify the parse before committing.
3. **Per-row double-entry assignment** — every imported row must have its other side
   chosen (a category or a transfer account) so the resulting transaction balances.
   Rows without a valid assignment are blocked from import.
4. **Recurring auto-match** — for each row, look up prior transactions with a matching
   payee/description and pre-fill the category that was used most recently/most often,
   so repeated items categorize themselves.
5. Duplicate detection (date + amount + description already present) with a skip option.

## Later

- Subcategories and tags.
- Statement reconciliation (mark cleared up to a statement balance).
- Scheduled / recurring transactions with forecasting.
- Specific-lot selection on sells (currently FIFO only); average-cost option.
- Capital-gains report split into short vs. long term.
- Budgets and budget-vs-actual reporting.
- Multi-currency.
