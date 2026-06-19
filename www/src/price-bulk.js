/* ============================================================
   price-bulk.js — Phase 4 of docs/MIGRATION.md
   A self-contained, plain-globals module. Load AFTER price-fetch.js
   (see index.html). Adds two things on top of the Phase 3 contracts,
   touching no engine internals:

     1. runBulkUpdate() — the "Full refresh" path. Asks the Tauri backend
        (bulk_fetch_us command in main.rs) to download Stooq's US end-of-day
        archive in ONE request, unzip it, and return only the rows for the
        tickers we hold. We then upsert those through the existing PriceStore
        contract — so the per-symbol quota is sidestepped entirely. Coarse
        progress arrives via the "bulk-progress" Tauri event.

     2. maybeAutoRefreshPrices() — launch automation. If we haven't fetched
        yet today, run the normal Phase 3 incremental update once (deltas only,
        throttled, quota-aware). This uses the per-symbol path, NOT the bulk
        download — we never auto-pull 333 MB on launch.

   Reuses globals:
     engine.js         — state, render (via ui.js)
     price-provider.js — (none directly)
     price-store.js    — getPriceStore, priceKeyForSecurity, hydratePricesFromStore
     price-fetch.js    — priceFetchAvailable, runPriceUpdate, setPriceStatus
   ============================================================ */

/* ---------- environment check ----------
   Bulk refresh needs the Tauri command bridge (core.invoke) and a real store.
   It does NOT depend on the webview http plugin: the download is native (Rust),
   so this is available in any Tauri build, even where browser fetch would be
   CORS-blocked. */
function bulkUpdateAvailable() {
  if (typeof window === "undefined") return false;
  const core = window.__TAURI__ && window.__TAURI__.core;
  if (!core || typeof core.invoke !== "function") return false;
  if (typeof getPriceStore !== "function" || !getPriceStore()) return false;
  return true;
}

/* days-ago ISO, used to bound a first backfill to ~5 years (matches the
   per-symbol default window in price-provider.js so the two paths agree). */
function _bulk_isoDaysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/* ---------- "Full refresh" — one archive request for every held symbol ---------- */
async function runBulkUpdate() {
  if (!bulkUpdateAvailable()) {
    if (typeof setPriceStatus === "function") setPriceStatus("Full refresh needs the desktop app.", true);
    return;
  }
  const store = getPriceStore();
  const securities = (state.securities || []).filter((s) => s.symbol);
  if (!securities.length) {
    setPriceStatus("No securities to update.", false);
       return;
  }

  // Build per-ticker requests: deltas after each ticker's last stored date, or
  // a bounded ~5y backfill when there's nothing yet. We key by the SAME value
  // the store uses (priceKeyForSecurity), which is also the archive file stem.
  const fiveYrAgo = _bulk_isoDaysAgo(5 * 366);
  const requests = [];
  const seen = new Set();
  for (const s of securities) {
    const ticker = (typeof priceKeyForSecurity === "function")
      ? priceKeyForSecurity(s) : String(s.symbol || "").trim().toLowerCase();
    if (!ticker || seen.has(ticker)) continue;
    seen.add(ticker);
    let since = fiveYrAgo;
    try { const last = await store.lastDate(ticker); if (last) since = last; } catch (e) { /* backfill */ }
    requests.push({ ticker, since });
  }
  if (!requests.length) {
    setPriceStatus("No securities to refresh.", false);
    return;
  }

  setPriceStatus("Starting full price refresh…", false);

  // Live progress for the long download (optional — guarded).
  let unlisten = null;
  try {
    const ev = window.__TAURI__ && window.__TAURI__.event;
    if (ev && typeof ev.listen === "function") {
      unlisten = await ev.listen("bulk-progress", (e) => {
        const p = (e && e.payload) || {};
        if (p.phase === "downloading") {
          const mb = (Number(p.downloaded) / 1048576).toFixed(0);
          const tot = p.total ? ` / ${(Number(p.total) / 1048576).toFixed(0)} MB` : " MB";
          setPriceStatus(`Downloading archive… ${mb}${tot}`, false);
        } else if (p.phase === "extracting") {
          setPriceStatus(`Extracting your symbols… (${p.downloaded}/${p.total})`, false);
        } else if (p.phase === "done") {
          setPriceStatus("Saving prices…", false);
        }
      });
    }
  } catch (e) { /* progress is non-essential */ }

  let result;
  try {
    result = await window.__TAURI__.core.invoke("bulk_fetch_us", { requests });
  } catch (e) {
    if (unlisten) { try { unlisten(); } catch (_e) {} }
    setPriceStatus("Full refresh failed: " + (e && e.message ? e.message : e), true);
    return;
  }
  if (unlisten) { try { unlisten(); } catch (_e) {} }

  // Upsert returned rows via the existing store contract (bumps last_date /
  // last_fetched the same way the per-symbol path does).
  let updated = 0, rowsAdded = 0;
  const returned = result || {};
  for (const ticker of Object.keys(returned)) {
    const rows = returned[ticker] || [];
    if (!rows.length) continue;
    try { await store.upsert(ticker, rows); updated++; rowsAdded += rows.length; }
    catch (e) { console.error("bulk upsert failed for " + ticker, e); }
  }
  const noData = requests.length - updated;

  try { if (typeof hydratePricesFromStore === "function") await hydratePricesFromStore(); }
  catch (e) { /* leave ledger prices as-is */ }
  if (typeof render === "function") render();

  let msg = `Full refresh — ${updated} updated · ${rowsAdded} rows added`;
  if (noData > 0) msg += ` · ${noData} with no new data (non-US/index tickers aren't in the US archive)`;
  setPriceStatus(msg, false);
  if (typeof refreshSplitDetection === "function") refreshSplitDetection();
}

/* ---------- launch auto-refresh (per-symbol incremental, once per day) ----------
   Runs the Phase 3 path, not the bulk download. Skipped entirely outside a
   Tauri build with the http plugin, and skipped if we already fetched today. */
async function maybeAutoRefreshPrices() {
  if (typeof priceFetchAvailable !== "function" || !priceFetchAvailable()) return;
  if (typeof runPriceUpdate !== "function") return;

  const store = (typeof getPriceStore === "function") ? getPriceStore() : null;
  if (!store || typeof store.lastFetched !== "function") return;

  const securities = (state && Array.isArray(state.securities))
    ? state.securities.filter((s) => s.symbol)
    : [];

  if (!securities.length) return;

  // Newest successful fetch across all held tickers.
  let newest = null;
  const seen = new Set();
  for (const s of securities) {
    const key = (typeof priceKeyForSecurity === "function")
      ? priceKeyForSecurity(s) : String(s.symbol || "").trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    try { const lf = await store.lastFetched(key); if (lf && (!newest || lf > newest)) newest = lf; }
    catch (e) { /* treat as never-fetched */ }
  }

  const today = new Date().toISOString().slice(0, 10);
  if (newest && String(newest).slice(0, 10) >= today) return; // already refreshed today

  try { await runPriceUpdate(); } catch (e) { console.error("auto price refresh failed", e); }
}

/* expose for node tests if ever loaded there (browser uses globals) */
if (typeof module !== "undefined") {
  module.exports = { bulkUpdateAvailable, runBulkUpdate, maybeAutoRefreshPrices };
}
