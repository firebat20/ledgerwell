/* ============================================================
   price-provider.js — daily price fetching, provider-agnostic
   Loaded after import.js (reuses its global parseCSV when present).

   Design goals:
   - One PriceProvider interface so the source can be swapped (Stooq now,
     Yahoo/yfinance/Alpha Vantage later) without touching callers.
   - Environment-agnostic: the provider takes an injected httpGet(url)->text.
       * Tauri: import { fetch } from "@tauri-apps/plugin-http" (native, no CORS)
       * dev/browser: window.fetch (NOTE: Stooq is CORS-blocked in a plain
         webview, so the browser path is only for local testing with a proxy)
   - Incremental: only fetch dates after what the store already has.
   - Quota-aware: Stooq enforces a low daily hit limit; on hitting it we stop
     and signal the caller to fall back to the bulk end-of-day archive.

   ----------------------------------------------------------------
   PriceStore contract (you supply this; SQLite impl lives in the
   Tauri build — see docs/MIGRATION.md). All methods are async:
     lastDate(ticker)            -> "YYYY-MM-DD" | null
     upsert(ticker, rows)        -> void   (rows: [{date,close,open,high,low,volume}])
     range(ticker, fromISO, toISO) -> rows ascending by date
   A MemoryPriceStore is included below for development/tests.
   ============================================================ */

/* reuse the importer's CSV parser if it's loaded; else a simple line splitter
   (Stooq CSV has no quoted fields, so the fallback is sufficient) */
const _parseCSV = (typeof parseCSV === "function")
  ? parseCSV
  : (text) => String(text || "").split(/\r?\n/).filter((l) => l.trim() !== "").map((l) => l.split(","));

/* ---------- symbol mapping (plain symbol -> Stooq ticker) ---------- */
/* US equities take a ".us" suffix; indices are "^"-prefixed; anything that
   already carries an exchange suffix (a ".") is passed through. Supply
   `symbolOverrides` for anything that doesn't follow the rule (most indices). */
function stooqSymbol(sym, overrides = {}) {
  const s = String(sym || "").trim();
  if (!s) return "";
  const key = s.toUpperCase();
  if (overrides[key]) return String(overrides[key]).toLowerCase();
  if (s.startsWith("^")) return s.toLowerCase();   // index, e.g. ^spx
  if (s.includes(".")) return s.toLowerCase();     // already exchange-qualified
  return s.toLowerCase() + ".us";                  // default: US listing
}

const _ymd = (iso) => String(iso || "").replace(/-/g, "");
function stooqDailyUrl(ticker, fromISO, toISO) {
  let q = "s=" + encodeURIComponent(ticker) + "&i=d";
  if (fromISO) q += "&d1=" + _ymd(fromISO);
  if (toISO) q += "&d2=" + _ymd(toISO);
  return "https://stooq.com/q/d/l/?" + q;
}

/* ---------- parse a Stooq daily CSV body ----------
   Expected: "Date,Open,High,Low,Close,Volume" with ISO dates.
   Returns { rows, error } where error is null | "quota" | "nodata" | "unexpected". */
function parseStooqCsv(text) {
  const t = String(text || "").trim();
  if (!t) return { rows: [], error: "nodata" };
  if (!/^date,/i.test(t)) {
    const low = t.toLowerCase();
    if (low.includes("exceeded") || low.includes("limit")) return { rows: [], error: "quota" };
    if (low.startsWith("no data") || low === "n/d") return { rows: [], error: "nodata" };
    return { rows: [], error: "unexpected", sample: t.slice(0, 120) };
  }
  const csv = _parseCSV(t);
  const head = csv[0].map((h) => String(h).trim().toLowerCase());
  const at = (n) => head.indexOf(n);
  const di = at("date"), ci = at("close"), oi = at("open"), hi = at("high"), li = at("low"), vi = at("volume");
  const rows = [];
  for (let r = 1; r < csv.length; r++) {
    const c = csv[r];
    const date = String(c[di] || "").trim();
    const close = parseFloat(c[ci]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(close)) continue;
    rows.push({
      date, close,
      open: oi >= 0 ? parseFloat(c[oi]) : null,
      high: hi >= 0 ? parseFloat(c[hi]) : null,
      low: li >= 0 ? parseFloat(c[li]) : null,
      volume: vi >= 0 ? parseInt(c[vi], 10) : null,
      // Stooq is unadjusted: no adjclose. Use `close` for market value;
      // handle splits in the lot model yourself (see MIGRATION.md).
      adjclose: null,
    });
  }
  return { rows, error: null };
}

/* ---------- the provider ---------- */
function StooqProvider(httpGet, opts = {}) {
  const overrides = opts.symbolOverrides || {};
  return {
    name: "stooq",
    mapSymbol: (sym) => stooqSymbol(sym, overrides),

    /* fetch daily bars for one security in [fromISO, toISO]. Throws an Error
       with .code "QUOTA" on the daily-limit response so the caller can stop. */
    async fetchDaily(sym, fromISO, toISO) {
      const ticker = stooqSymbol(sym, overrides);
      const text = await httpGet(stooqDailyUrl(ticker, fromISO, toISO));
      const { rows, error, sample } = parseStooqCsv(text);
      if (error === "quota") { const e = new Error("Stooq daily hit limit exceeded"); e.code = "QUOTA"; throw e; }
      if (error === "unexpected") { const e = new Error("Unexpected Stooq response: " + sample); e.code = "PARSE"; throw e; }
      return rows; // [] when there is simply no data for the symbol/range
    },

    /* One request for the whole US end-of-day market (a zip of per-symbol txt
       files) — the way around the per-symbol quota when refreshing many names.
       NOTE: confirm the exact archive URL from https://stooq.com/db/ ; download
       + unzip + extract is wired in the Tauri build (Phase 4). */
    bulkDailyUsUrl() { return "https://static.stooq.com/db/h/d_us_txt.zip"; },
  };
}

/* ---------- update orchestration (provider + store) ---------- */
const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function _nextDayISO(iso) { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); }
function _isoDaysAgo(n) { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); }

/* Refresh prices for a list of securities ({symbol}). Only fetches dates after
   each ticker's last stored date. Throttles between requests; stops on quota.
   Returns a summary the UI can show. */
async function updatePrices({ provider, store, securities, defaultFrom, throttleMs = 500, onProgress } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const summary = { updated: 0, rowsAdded: 0, skipped: 0, errors: [], quota: false };
  const report = (p) => { if (typeof onProgress === "function") onProgress(p); };

  for (const sec of securities) {
    const ticker = provider.mapSymbol(sec.symbol);
    let from;
    try { const last = await store.lastDate(ticker); from = last ? _nextDayISO(last) : (defaultFrom || _isoDaysAgo(5 * 366)); }
    catch (e) { from = defaultFrom || _isoDaysAgo(5 * 366); }

    if (from > today) { summary.skipped++; report({ symbol: sec.symbol, status: "current" }); continue; }

    try {
      // don't trust the source to honor the date window — keep only new dates
      const rows = (await provider.fetchDaily(sec.symbol, from, today)).filter((r) => r.date >= from);
      if (rows.length) {
        await store.upsert(ticker, rows);
        summary.updated++;
        summary.rowsAdded += rows.length;
        report({ symbol: sec.symbol, status: "updated", rows: rows.length });
      } else {
        if (typeof store.markFetched === "function") {
          await store.markFetched(ticker);
        }
        summary.skipped++;
        report({ symbol: sec.symbol, status: "none" });
      }
    } catch (e) {
      if (e.code === "QUOTA") {
        summary.quota = true;
        summary.errors.push({ symbol: sec.symbol, error: "quota" });
        report({ symbol: sec.symbol, status: "quota" });
        break; // stop and let the caller suggest the bulk archive
      }
      summary.errors.push({ symbol: sec.symbol, error: e.message });
      report({ symbol: sec.symbol, status: "error", error: e.message });
    }
    await _sleep(throttleMs);
  }
  return summary;
}

/* ---------- HTTP adapters ---------- */
/* dev/browser only — Stooq blocks cross-origin webview fetches, so this is for
   local testing behind a proxy. The Tauri build injects plugin-http's fetch. */
async function browserHttpGet(url) { const r = await fetch(url); if (!r.ok) throw new Error("HTTP " + r.status); return await r.text(); }

/* ---------- in-memory store for development / tests ---------- */
function MemoryPriceStore() {
  const db = {}; // ticker -> Map(date -> row)
  const fetched = {}; // ticker -> ISO timestamp of last upsert
  return {
    async lastDate(t) { const m = db[t]; if (!m || !m.size) return null; return [...m.keys()].sort().pop(); },
    async lastFetched(t) { return fetched[t] || null; },
    async upsert(t, rows) { db[t] = db[t] || new Map(); for (const r of rows) db[t].set(r.date, r); fetched[t] = new Date().toISOString(); },
    async range(t, from, to) { const m = db[t]; if (!m) return []; return [...m.values()].filter((r) => (!from || r.date >= from) && (!to || r.date <= to)).sort((a, b) => (a.date < b.date ? -1 : 1)); },
    _db: db,
  };
}

/* expose for non-module (browser global) and module (node test) contexts */
if (typeof module !== "undefined") module.exports = { stooqSymbol, stooqDailyUrl, parseStooqCsv, StooqProvider, updatePrices, MemoryPriceStore, browserHttpGet };
