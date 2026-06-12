/* ============================================================
   price-fetch.js — Phase 3 of docs/MIGRATION.md
   A self-contained, plain-globals module. Load AFTER price-provider.js
   and price-store.js (see index.html). Adds the network path on top of the
   existing provider/store contracts; touches no engine internals.

   Responsibilities:
     1. HTTP adapter for the Tauri build: tauriHttpGet(url) over
        window.__TAURI__.http.fetch (native request, bypasses CORS). The
        browser path stays on price-provider.js's browserHttpGet.
     2. Provider wiring: getPriceProvider() builds a StooqProvider injected
        with the right httpGet and the per-security symbolOverrides collected
        from state.securities (sec.stooqTicker). Rebuilt per call so override
        edits take effect without a reload.
     3. UI orchestration for the Investments view:
          - runPriceUpdate()        — loop all securities (the "Update prices" button)
          - updateOneSymbol(secId)  — single security (the per-row "↻" test path)
          - editSecTicker(secId,val)— persist the inline Stooq-ticker override
          - priceStatusHtml()/setPriceStatus() — a status line that survives render()
          - priceFetchAvailable()   — true only in a Tauri build with the http plugin

   Reuses globals:
     engine.js         — state, getSecurity, save, todayISO
     ui.js             — esc, render
     price-provider.js — StooqProvider, browserHttpGet, updatePrices
     price-store.js    — getPriceStore, priceKeyForSecurity, hydratePricesFromStore
   ============================================================ */

/* ---------- environment check ---------- */
/* The network path is only meaningful in the Tauri build: Stooq blocks
   cross-origin fetches from a plain webview, so we gate the network UI on the
   http plugin being present. The inline override field is shown regardless
   (it's harmless and persists in the ledger either way). */
function priceFetchAvailable() {
  return typeof window !== "undefined"
    && !!(window.__TAURI__ && window.__TAURI__.http && window.__TAURI__.http.fetch);
}

/* ---------- HTTP adapter (Tauri) ----------
   Logically a sibling of browserHttpGet in price-provider.js; lives here to
   keep the Phase 3 diff to existing files minimal. With withGlobalTauri the
   plugin-http bindings are exposed at window.__TAURI__.http. */
async function tauriHttpGet(url) {
  const http = (typeof window !== "undefined") && window.__TAURI__ && window.__TAURI__.http;
  const f = http && http.fetch;
  if (typeof f !== "function") {
    throw new Error("Tauri http plugin not available on window.__TAURI__.http");
  }
  const r = await f(url, { method: "GET" });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return await r.text();
}

/* ---------- symbol overrides + provider singleton ----------
   Overrides live ON the security as sec.stooqTicker (the exact Stooq ticker,
   e.g. "spy.us" or "^spx"). We hand them to StooqProvider keyed by uppercased
   plain symbol so provider.mapSymbol(sec.symbol) returns the override, and
   priceKeyForSecurity() (price-store.js) reads the same field so manually
   entered prices and fetched history share one series key. */
function collectSymbolOverrides() {
  const out = {};
  if (typeof state === "object" && state && Array.isArray(state.securities)) {
    for (const sec of state.securities) {
      const ov = sec && sec.stooqTicker && String(sec.stooqTicker).trim();
      if (ov) out[String(sec.symbol || "").trim().toUpperCase()] = ov.toLowerCase();
    }
  }
  return out;
}

function getPriceProvider() {
  if (typeof StooqProvider !== "function") return null;
  const httpGet = priceFetchAvailable() ? tauriHttpGet : browserHttpGet;
  return StooqProvider(httpGet, { symbolOverrides: collectSymbolOverrides() });
}

/* ---------- inline Stooq-ticker override (securities table) ----------
   Empty input clears the override and falls back to the default mapping
   (stooqSymbol: ".us" suffix / "^" indices). NOTE: changing the override
   re-keys the series — prices stored under the old key are not migrated, so
   the next fetch backfills history under the new key. Set the override before
   entering manual prices to avoid a split series. */
function editSecTicker(secId, val) {
  const s = (typeof getSecurity === "function") ? getSecurity(secId) : null;
  if (!s) return;
  const v = String(val || "").trim().toLowerCase();
  if (v) s.stooqTicker = v; else delete s.stooqTicker;
  if (typeof save === "function") save();
}

/* ---------- status line (persists across a full render()) ---------- */
let _priceStatusMsg = "";
let _priceStatusErr = false;

function priceStatusHtml() {
  if (!_priceStatusMsg) return "";
  const safe = (typeof esc === "function") ? esc(_priceStatusMsg) : _priceStatusMsg;
  const color = _priceStatusErr ? "var(--neg)" : "var(--muted)";
  return `<div id="price-status" class="muted" style="margin:6px 0 0;font-size:12px;color:${color}">${safe}</div>`;
}

function setPriceStatus(msg, isErr) {
  _priceStatusMsg = msg || "";
  _priceStatusErr = !!isErr;
  // Live-update the element if it already exists (progress without re-render).
  if (typeof document !== "undefined") {
    const el = document.getElementById("price-status");
    if (el) {
      el.textContent = _priceStatusMsg;
      el.style.color = _priceStatusErr ? "var(--neg)" : "var(--muted)";
    }
  }
}

/* ---------- shared post-update step ---------- */
async function _afterPriceUpdate(summary, oneLabel) {
  // Re-hydrate the in-memory sec.price cache from the newest stored rows so
  // market values / holdings reflect the fetch, then repaint.
  try {
    if (typeof hydratePricesFromStore === "function") await hydratePricesFromStore();
  } catch (e) { /* non-fatal: leave ledger prices as-is */ }
  if (typeof render === "function") render();

  const parts = [
    `${summary.updated} updated`,
    `${summary.rowsAdded} rows added`,
    `${summary.skipped} skipped`,
  ];
  if (summary.errors && summary.errors.length) parts.push(`${summary.errors.length} error(s)`);
  let msg = (oneLabel ? oneLabel + " — " : "") + parts.join(" · ");
  if (summary.quota) {
    msg += " — Stooq daily limit hit; use the bulk archive (Phase 4) for a full refresh.";
  }
  const hadFailure = !!(summary.errors && summary.errors.length) && !summary.updated;
  setPriceStatus(msg, hadFailure || summary.quota);
}

/* ---------- "Update prices" — loop all securities ---------- */
async function runPriceUpdate() {
  const store = (typeof getPriceStore === "function") ? getPriceStore() : null;
  if (!store) { setPriceStatus("No price store available in this build.", true); return; }
  const provider = getPriceProvider();
  if (!provider) { setPriceStatus("Price provider unavailable.", true); return; }

  const securities = (state.securities || []).filter((s) => s.symbol);
  if (!securities.length) { setPriceStatus("No securities to update.", false); return; }

  setPriceStatus("Updating prices…", false);
  let summary;
  try {
    summary = await updatePrices({
      provider, store, securities, throttleMs: 500,
      onProgress: (p) => setPriceStatus(
        `${p.symbol}: ${p.status}${p.rows ? " (" + p.rows + " rows)" : ""}…`, false),
    });
  } catch (e) {
    setPriceStatus("Update failed: " + (e && e.message ? e.message : e), true);
    return;
  }
  await _afterPriceUpdate(summary);
}

/* ---------- single security (per-row "↻" — the end-to-end test path) ---------- */
async function updateOneSymbol(secId) {
  const store = (typeof getPriceStore === "function") ? getPriceStore() : null;
  if (!store) { setPriceStatus("No price store available in this build.", true); return; }
  const sec = (typeof getSecurity === "function") ? getSecurity(secId) : null;
  if (!sec || !sec.symbol) return;
  const provider = getPriceProvider();
  if (!provider) { setPriceStatus("Price provider unavailable.", true); return; }

  setPriceStatus(`Updating ${sec.symbol}…`, false);
  let summary;
  try {
    summary = await updatePrices({ provider, store, securities: [sec], throttleMs: 0 });
  } catch (e) {
    setPriceStatus(`${sec.symbol} — update failed: ` + (e && e.message ? e.message : e), true);
    return;
  }
  await _afterPriceUpdate(summary, sec.symbol);
}

/* expose for node tests if ever loaded there (browser uses globals) */
if (typeof module !== "undefined") {
  module.exports = {
    priceFetchAvailable, tauriHttpGet, collectSymbolOverrides, getPriceProvider,
    editSecTicker, priceStatusHtml, setPriceStatus, runPriceUpdate, updateOneSymbol,
  };
}
