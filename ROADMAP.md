# Roadmap

## Completed Milestones

- **Tauri Desktop Migration**: Package the app as a self-contained desktop app with native atomic JSON file storage (`ledger.json`) and SQLite database persistence (`LedgerWell.db`) for price history.
- **Incremental & Bulk Price Fetching**: Incremental per-security price updates from Stooq with a native Rust-based EOD bulk ZIP archive downloader/extractor to bypass API quotas.
- **Stock Split Detection & Booking**: Scans price history for overnight gaps, suggests stock splits, and books split transactions that adjust share counts and lots historically.
- **Interactive Portfolio Reports**: Custom SVG line/area charts tracking Portfolio Value, security holdings, and Realized/Unrealized Gains over time with interactive tooltip crosshairs.
- **CSV Import Engine**: Import transactions into accounts with custom column mappings, live preview, per-row category/transfer assignments, payee-based auto-matching, and duplicate checks.

## Next Up — Statement Reconciliation & Register Polish

1. **Statement Reconciliation**: Implement a dedicated reconciliation workflow where users input a statement ending date and ending balance, then tick off cleared transactions in the register until the difference resolves to zero. Cleared transactions are marked as reconciled and locked.
2. **Register Search, Filtering & Multi-select**: Add a quick filter/search input to the register view to search by payee, category, amount, or cleared status. Enable multi-select to delete or mass-categorize transactions.

## Planned Roadmap Items

- **Rule-Based & Learned Auto-Categorization**: Add custom text-matching and regex rules for incoming transactions, combined with a lightweight Bayesian classifier that learns category assignments from past user data.
- **Interactive Dashboard Widgets**: Enhance the main dashboard with spending category breakdown pie charts, monthly budget progress rings, and historical net-worth trend lines.
- **Advanced Portfolio Metrics (XIRR)**: Track compound performance (IRR / XIRR) of investments, display security asset allocation charts (e.g. by sector or asset class), and calculate dividend yields.
- **Scheduled & Recurring Transactions**: Support template transactions (bills, salary) that trigger automatically or prompt for approval on due dates, with future cash flow forecasting.
- **Specific Lot Selection & Tax Harvesting**: Support custom tax lot selection methods on sells (LIFO, HIFO, specific ID) and flag potential tax-loss harvesting opportunities.
- **Budgets and Budget-vs-Actual Reporting**: Set monthly spending limits per category/group and view comparative charts showing actual spend against limits.
- **Multi-currency & Crypto Support**: Allow holding cash or assets in non-primary currencies with automated exchange rate fetching.

