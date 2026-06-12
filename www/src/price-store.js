/* ============================================================
   price-store.js — Phase 2 of docs/MIGRATION.md
   A self-contained, plain-globals module (load AFTER price-provider.js).

   Responsibilities:
     1. PriceStore selection: SqlitePriceStore in the Tauri build (via the
        sql plugin's global, window.__TAURI__.sql.Database), else the
        MemoryPriceStore from price-provider.js (browser/dev), else none.
     2. Latest-price CACHE: on load, hydrate each security's in-memory
        `sec.price` from the newest stored row, so the synchronous engine
        (accountMarketValue, holdings views, dashboard) is unchanged. The
        ledger JSON keeps `sec.price` as the durable "last known" value, so
        the app still runs in a plain browser and backups stay complete.
     3. HISTORY: a manual price edit writes a dated row to the store (today),
        in addition to updating the cache + ledger. Same-day re-edits REPLACE
        on the (ticker,date) primary key.
     4. A first read-path proof: inline-SVG sparklines in the Investments view.

   Reuses globals:
     engine.js     — state, getSecurity, cents, todayISO
     price-provider.js — MemoryPriceStore, stooqSymbol  (both optional)
     ui.js         — render() calls drawInvestmentSparklines() for the
                     investments view (one guarded line; see the diff)

   The store contract (docs/MIGRATION.md), all async:
     lastDate(ticker)              -> "YYYY-MM-DD" | null
     upsert(ticker, rows)          -> void   (rows: [{date,close,open,high,low,volume}])
     range(ticker, fromISO, toISO) -> rows ascending by date
   ============================================================ */

const PRICE_DB_FILENAME = "LedgerWell.db";
let _resolvedDbUrl = null;

/// Resolve the absolute sqlite: URL for the price database.
/// The Rust backend stores the DB next to the executable; we query for
/// that directory once and cache the result.
async function _resolvePriceDbUrl() {
  if (_resolvedDbUrl) return _resolvedDbUrl;
  try {
    const dir = await window.__TAURI__.core.invoke("get_data_dir");
    // Use forward slashes for the sqlite URI even on Windows
    const sep = dir.includes("\\") ? "\\" : "/";
    const normalized = dir.endsWith(sep) ? dir : dir + sep;
    _resolvedDbUrl = "sqlite:" + normalized + PRICE_DB_FILENAME;
  } catch (_e) {
    // Fallback: let the plugin resolve relative to its default location
    _resolvedDbUrl = "sqlite:" + PRICE_DB_FILENAME;
  }
  return _resolvedDbUrl;
}

const _spark_isoDaysAgo = (n) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

/* Key a security to a store "ticker". We key by the SAME value Phase 3 will
   fetch into (Stooq ticker, e.g. "aapl.us") when price-provider.js is loaded,
   so manually-entered prices and later-fetched history share one series and
   no re-key migration is needed. Falls back to the lowercased symbol. */
function priceKeyForSecurity(sec) {
  if (!sec) return "";
  // Phase 3: an explicit Stooq-ticker override wins over the default mapping.
  const ov = sec.stooqTicker && String(sec.stooqTicker).trim();
  if (ov) return ov.toLowerCase();
  if (typeof stooqSymbol === "function") {
    const k = stooqSymbol(sec.symbol);
    if (k) return k;
  }
  return String(sec.symbol || "").trim().toLowerCase();
}

/* ---------- SQLite store (Tauri build, no bundler needed) ----------
   With `withGlobalTauri: true` the sql plugin's guest bindings are exposed at
   window.__TAURI__.sql, so we never import @tauri-apps/plugin-sql. */
function SqlitePriceStore() {
  let _db = null;
  async function db() {
    if (_db) return _db;
    const sql = window.__TAURI__ && window.__TAURI__.sql;
    const Database = sql && (sql.Database || sql.default || sql);
    if (!Database || typeof Database.load !== "function") {
      throw new Error("Tauri sql plugin not available on window.__TAURI__.sql");
    }
    const dbUrl = await _resolvePriceDbUrl();
    _db = await Database.load(dbUrl); // migrations (Rust side) apply here / at preload
    return _db;
  }
  return {
    async lastDate(ticker) {
      const d = await db();
      const rows = await d.select(
        "SELECT last_date FROM price_meta WHERE ticker = $1",
        [ticker]
      );
      return rows && rows[0] && rows[0].last_date ? rows[0].last_date : null;
    },
    async lastFetched(ticker) {
      const d = await db();
      const rows = await d.select(
        "SELECT last_fetched FROM price_meta WHERE ticker = $1",
        [ticker]
      );
      return rows && rows[0] && rows[0].last_fetched ? rows[0].last_fetched : null;
    },
    async upsert(ticker, rows) {
      if (!rows || !rows.length) return;
      const d = await db();
      for (const r of rows) {
        await d.execute(
          "INSERT OR REPLACE INTO prices (ticker,date,close,open,high,low,volume) VALUES ($1,$2,$3,$4,$5,$6,$7)",
          [ticker, r.date, Number(r.close),
            r.open == null ? null : Number(r.open),
            r.high == null ? null : Number(r.high),
            r.low == null ? null : Number(r.low),
            r.volume == null ? null : Number(r.volume)]
        );
      }
      const last = rows.reduce((m, r) => (r.date > m ? r.date : m), rows[0].date);
      // keep last_date monotonic; refresh last_fetched every time
      await d.execute(
        "INSERT INTO price_meta (ticker,last_date,last_fetched) VALUES ($1,$2,$3) " +
        "ON CONFLICT(ticker) DO UPDATE SET " +
        "last_date = CASE WHEN excluded.last_date > price_meta.last_date THEN excluded.last_date ELSE price_meta.last_date END, " +
        "last_fetched = excluded.last_fetched",
        [ticker, last, new Date().toISOString()]
      );
    },
    async range(ticker, fromISO, toISO) {
      const d = await db();
      let q = "SELECT date,close,open,high,low,volume FROM prices WHERE ticker = $1";
      const args = [ticker];
      if (fromISO) { args.push(fromISO); q += " AND date >= $" + args.length; }
      if (toISO) { args.push(toISO); q += " AND date <= $" + args.length; }
      q += " ORDER BY date ASC";
      return await d.select(q, args);
    },
  };
}

/* ---------- store selection (singleton) ---------- */
let _priceStore = null;
let _priceStoreResolved = false;
function getPriceStore() {
  if (_priceStoreResolved) return _priceStore;
  _priceStoreResolved = true;
  try {
    if (typeof window !== "undefined" && window.__TAURI__ && window.__TAURI__.sql) {
      _priceStore = SqlitePriceStore();
    } else if (typeof MemoryPriceStore === "function") {
      _priceStore = MemoryPriceStore(); // session-only fallback for the browser
    } else {
      _priceStore = null;
    }
  } catch (e) {
    console.error("price store unavailable", e);
    _priceStore = null;
  }
  return _priceStore;
}

/* ---------- latest-price cache hydration (called once after load()) ----------
   - If the store has history for a security, copy its newest close into the
     in-memory `sec.price` cache (the engine reads this synchronously).
   - If the store has NO history yet, seed a single baseline point from the
     ledger's current price so the read path / sparkline have something to show
     and so the first manual edit appends to a real series.
   Never calls save(): the ledger already holds these prices. */
async function hydratePricesFromStore() {
  const store = getPriceStore();
  if (!store || !state || !Array.isArray(state.securities)) return;
  for (const sec of state.securities) {
    const key = priceKeyForSecurity(sec);
    if (!key) continue;
    let last = null;
    try { last = await store.lastDate(key); } catch (e) { continue; }
    if (last) {
      try {
        const rows = await store.range(key, last, last);
        const close = rows && rows[0] ? Number(rows[0].close) : NaN;
        if (!isNaN(close)) sec.price = cents(close);
      } catch (e) { /* leave ledger price as-is */ }
    } else if (sec.price != null && !isNaN(Number(sec.price))) {
      try {
        await store.upsert(key, [{ date: sec.priceDate || todayISO(), close: cents(sec.price) }]);
      } catch (e) { /* non-fatal */ }
    }
  }
}

/* ---------- write a history point on a manual edit (fire-and-forget) ---------- */
function persistPriceHistory(secId) {
  const store = getPriceStore();
  if (!store) return;
  const sec = getSecurity(secId);
  if (!sec || sec.price == null || isNaN(Number(sec.price))) return;
  const key = priceKeyForSecurity(sec);
  if (!key) return;
  const row = { date: sec.priceDate || todayISO(), close: cents(sec.price) };
  Promise.resolve(store.upsert(key, [row]))
    .catch((e) => console.error("price history upsert failed", e));
}

/* ---------- sparklines (inline SVG, no dependencies) ----------
   Investments view renders <svg data-spark-sec="<id>"> placeholders; after the
   DOM is in place ui.js render() calls this to fill them from store.range(). */
function _drawSparkInto(el, rows) {
  const W = 96, H = 24, pad = 2;
  const vals = (rows || []).map((r) => Number(r.close)).filter((v) => !isNaN(v));
  if (!vals.length) {
    el.innerHTML = `<line x1="0" y1="${H / 2}" x2="${W}" y2="${H / 2}" stroke="var(--line-strong)" stroke-width="1"/>`;
    el.setAttribute("title", "No price history yet");
    return;
  }
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = (max - min) || 1;
  const n = vals.length;
  const x = (i) => (n === 1 ? W / 2 : pad + (i / (n - 1)) * (W - 2 * pad));
  const y = (v) => H - pad - ((v - min) / span) * (H - 2 * pad);
  if (n === 1) {
    el.innerHTML = `<circle cx="${x(0).toFixed(1)}" cy="${y(vals[0]).toFixed(1)}" r="2" fill="var(--primary)"/>`;
    el.setAttribute("title", `1 point · ${fmtMoney(vals[0])}`);
    return;
  }
  const d = vals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const stroke = vals[n - 1] >= vals[0] ? "var(--pos)" : "var(--neg)";
  el.innerHTML = `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="1.5" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/>`;
  el.setAttribute("title", `${n} points · ${fmtMoney(vals[0])} → ${fmtMoney(vals[n - 1])}`);
}

async function drawInvestmentSparklines() {
  const store = getPriceStore();
  if (!store || typeof document === "undefined") return;
  const els = document.querySelectorAll("[data-spark-sec]");
  const from = _spark_isoDaysAgo(120), to = todayISO();
  for (const el of els) {
    const sec = getSecurity(el.getAttribute("data-spark-sec"));
    if (!sec) { _drawSparkInto(el, []); continue; }
    let rows = [];
    try { rows = await store.range(priceKeyForSecurity(sec), from, to); }
    catch (e) { rows = []; }
    _drawSparkInto(el, rows);
  }
}

/* expose for node tests if ever loaded there (browser uses globals) */
if (typeof module !== "undefined") {
  module.exports = { priceKeyForSecurity, SqlitePriceStore, getPriceStore, hydratePricesFromStore, persistPriceHistory, drawInvestmentSparklines };
}
