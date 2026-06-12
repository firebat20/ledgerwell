# Phase 3 — apply guide

Phase 3 wires Stooq fetching onto the existing `StooqProvider` / `SqlitePriceStore`
contracts. Most of this ships as **drop-in files**; two existing files
(`price-store.js`, `investments.js`) need small **anchored edits** below.

## 1. Drop-in files (overwrite)

- `www/index.html` — adds the `price-fetch.js` script tag.
- `www/src/price-fetch.js` — **new file** (http adapter, provider wiring, Update-prices UI).
- `src-tauri/Cargo.toml` — adds `tauri-plugin-http = "2"`.
- `src-tauri/src/main.rs` — registers `tauri_plugin_http::init()`.
- `src-tauri/capabilities/default.json` — grants `http:default` scoped to `https://stooq.com/*`.

## 2. Edit `www/src/price-store.js`

Make the store key honor a per-security override so manual + fetched history
share one series. Replace the whole `priceKeyForSecurity` function:

**FIND**
```js
function priceKeyForSecurity(sec) {
  if (!sec) return "";
  if (typeof stooqSymbol === "function") {
    const k = stooqSymbol(sec.symbol);
    if (k) return k;
  }
  return String(sec.symbol || "").trim().toLowerCase();
}
```

**REPLACE WITH**
```js
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
```

## 3. Edit `www/src/investments.js`

### 3a. Securities table rows — add the inline override + per-row "↻"

**FIND**
```js
  // ---- securities & prices (editable, like Categories' manager) ----
  const secRows = state.securities.map((s) => {
    const held = invAccts.some((a) => (((state._holdings[a.id] || {})[s.id] || {}).shares || 0) > 1e-9);
    return `<tr>
      <td><strong>${esc(s.symbol)}</strong></td>
      <td>${esc(s.name)}</td>
      <td class="r num"><input class="num" style="width:90px;text-align:right" type="number" step="0.01" value="${s.price}" onchange="editSec('${s.id}','price',this.value);render()"></td>
      <td class="muted" style="font-size:12px">${held ? "held" : "—"}</td></tr>`;
  }).join("");
```

**REPLACE WITH**
```js
  // ---- securities & prices (editable, like Categories' manager) ----
  const _canFetch = (typeof priceFetchAvailable === "function") && priceFetchAvailable();
  const secRows = state.securities.map((s) => {
    const held = invAccts.some((a) => (((state._holdings[a.id] || {})[s.id] || {}).shares || 0) > 1e-9);
    const tkr = (typeof priceKeyForSecurity === "function") ? priceKeyForSecurity(s) : "";
    const ov = s.stooqTicker ? esc(s.stooqTicker) : "";
    const fetchCell = _canFetch
      ? `<td class="r"><button class="btn ghost sm" title="Fetch ${esc(s.symbol)} from Stooq" onclick="updateOneSymbol('${s.id}')">↻</button></td>`
      : `<td></td>`;
    return `<tr>
      <td><strong>${esc(s.symbol)}</strong></td>
      <td>${esc(s.name)}</td>
      <td class="r num"><input class="num" style="width:90px;text-align:right" type="number" step="0.01" value="${s.price}" onchange="editSec('${s.id}','price',this.value);render()"></td>
      <td><input type="text" style="width:110px" value="${ov}" placeholder="${esc(tkr)}" title="Stooq ticker override (default shown as placeholder)" onchange="editSecTicker('${s.id}', this.value)"></td>
      <td class="muted" style="font-size:12px">${held ? "held" : "—"}</td>
      ${fetchCell}</tr>`;
  }).join("");
```

### 3b. Securities panel — add the "Update prices" button, status line, and two columns

**FIND**
```js
  <div class="panel">
    <div class="panel-h"><h3>Securities &amp; prices</h3><button class="btn ghost sm" onclick="openAddSecurity()">+ Add security</button></div>
    <div class="panel-b"><table>
      <thead><tr><th>Symbol</th><th>Name</th><th class="r">Price</th><th></th></tr></thead>
      <tbody>${secRows || `<tr><td colspan="4" class="empty">No securities yet.</td></tr>`}</tbody></table></div>
  </div>`;
```

**REPLACE WITH**
```js
  <div class="panel">
    <div class="panel-h"><h3>Securities &amp; prices</h3>
      <div>
        ${_canFetch ? `<button class="btn sm" onclick="runPriceUpdate()">Update prices</button>` : ""}
        <button class="btn ghost sm" onclick="openAddSecurity()">+ Add security</button>
      </div>
    </div>
    ${(typeof priceStatusHtml === "function") ? `<div style="padding:0 16px">${priceStatusHtml()}</div>` : ""}
    <div class="panel-b"><table>
      <thead><tr><th>Symbol</th><th>Name</th><th class="r">Price</th><th>Stooq ticker</th><th></th><th class="r"></th></tr></thead>
      <tbody>${secRows || `<tr><td colspan="6" class="empty">No securities yet.</td></tr>`}</tbody></table></div>
  </div>`;
```

## 4. Build & run

```sh
# from src-tauri/ (Rust toolchain required)
cargo add tauri-plugin-http   # or rely on the Cargo.toml edit above
cargo tauri dev               # or: cargo tauri build
```

The first `cargo build` will pull `tauri-plugin-http` and update `Cargo.lock`.

## 5. Test plan

1. **One symbol end-to-end first.** Open Investments → Securities & prices.
   Click **↻** on a single US equity (e.g. AAPL). Expect the status line to read
   something like `AAPL — 1 updated · N rows added · 0 skipped`, the sparkline to
   fill in, and Last price / Market value to refresh.
2. **Delta-only.** Click **↻** again immediately. Expect `0 updated · 0 skipped`
   for "current", or only the newest missing day(s) — no full re-pull.
3. **Override.** Set a Stooq ticker in the inline field (e.g. `^spx` for an index,
   or `spy.us`). Re-fetch and confirm it pulls under that key.
4. **Update all.** Click **Update prices**. Watch per-symbol progress; confirm the
   final summary totals.
5. **Quota.** If Stooq returns the daily-limit response mid-loop, the run stops and
   the status line points you at the Phase 4 bulk archive.
6. **Browser fallback.** Open `www/index.html` in a plain browser: the Update
   buttons are hidden (no http plugin), manual price entry still works.

## Caveats / notes

- **Override re-keys the series.** Changing `stooqTicker` after manual prices were
  stored under the auto key won't migrate old rows; the next fetch backfills under
  the new key. Set overrides before entering manual prices to avoid a split series.
- **Unadjusted closes.** Stooq closes are raw. A stock split will desync stored
  prices from FIFO lot share counts until handled — see the split-policy note in
  `docs/MIGRATION.md` and the specific-lot item on the ROADMAP.
- **Backfill window.** A security with no stored `last_date` backfills ~5 years in
  one CSV request (`updatePrices` default). After Phase 2 hydration most securities
  already have a baseline row, so updates are deltas.
- `tauriHttpGet` logically belongs beside `browserHttpGet` in `price-provider.js`;
  it lives in `price-fetch.js` only to keep the Phase 3 diff to existing files small.
