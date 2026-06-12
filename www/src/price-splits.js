/* ============================================================
   price-splits.js — stock-split detection + suggest/book (docs/MIGRATION.md)
   A self-contained, plain-globals module. Load AFTER price-bulk.js.

   Stooq closes are UNADJUSTED, so a split shows up in stored history as a
   large overnight price gap that lands on a clean ratio (price ÷10 for a 10:1
   split). We scan for those, SUGGEST them (never auto-book — a big drop can be
   a crash, not a split), and on confirmation record a security-level Split
   transaction via engine.splitSecurity(). rebuild() then scales the share
   counts/lots across every account; cost basis is unchanged.

   Reuses globals:
     engine.js     — state, getSecurity, splitSecurity, rebuild, save, cents,
                     fmtShares, fmtMoney, esc, todayISO
     ui.js         — render
     price-store.js— getPriceStore, priceKeyForSecurity
   ============================================================ */

/* ---------- tunables ---------- */
const _SPLIT_RATIOS = [
  2, 3, 4, 5, 6, 7, 8, 10, 12, 15, 20, 1.5, 2.5,        // forward (price drops)
  1 / 2, 1 / 3, 1 / 4, 1 / 5, 1 / 6, 1 / 8, 1 / 10, 1 / 15, 1 / 20, 2 / 3, 3 / 4, // reverse (price jumps)
];
const _SPLIT_SNAP_TOL = 0.05;   // accept a ratio within 5% of a clean value
const _SPLIT_MIN_MOVE = 0.30;   // require ≥30% overnight move to consider it
const _SPLIT_SCAN_YEARS = 6;    // history window to scan

function splitDetectAvailable() {
  return (typeof getPriceStore === "function") && !!getPriceStore()
    && (typeof priceKeyForSecurity === "function");
}

/* snap a raw prevClose/close ratio to the nearest clean split multiplier */
function _snapSplitRatio(raw) {
  let best = null, bestErr = Infinity;
  for (const m of _SPLIT_RATIOS) {
    const err = Math.abs(raw / m - 1);
    if (err < bestErr) { bestErr = err; best = m; }
  }
  return bestErr <= _SPLIT_SNAP_TOL ? best : null;
}

function _splitFromISO(years) {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString().slice(0, 10);
}

async function detectSplitsForSecurity(sec) {
  const store = getPriceStore();
  const key = (typeof priceKeyForSecurity === "function") ? priceKeyForSecurity(sec) : "";
  if (!store || !key) return [];
  let rows = [];
  try { rows = await store.range(key, _splitFromISO(_SPLIT_SCAN_YEARS), todayISO()); }
  catch (e) { return []; }
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const prev = Number(rows[i - 1].close), cur = Number(rows[i].close);
    if (!(prev > 0) || !(cur > 0)) continue;
    const raw = prev / cur;                 // >1 forward, <1 reverse
    if (Math.abs(raw - 1) < _SPLIT_MIN_MOVE) continue;
    const ratio = _snapSplitRatio(raw);
    if (!ratio) continue;
    out.push({
      secId: sec.id, symbol: sec.symbol, date: rows[i].date,
      ratio, prevClose: cents(prev), close: cents(cur),
    });
  }
  return out;
}

/* a candidate is "handled" if already booked (±4 days), dismissed, or the user
   never held the security before that date */
function _splitHandled(sec, cand) {
  const near = (d1, d2) => Math.abs((new Date(d1) - new Date(d2)) / 86400000) <= 4;
  const booked = state.transactions.some((t) => t.inv && t.inv.action === "Split"
    && t.inv.securityId === sec.id && near(t.date, cand.date));
  if (booked) return true;
  if (Array.isArray(sec.splitDismissed) && sec.splitDismissed.includes(cand.date)) return true;
  const ownedBefore = state.transactions.some((t) => t.inv && t.inv.action === "Buy"
    && t.inv.securityId === sec.id && t.date < cand.date);
  return !ownedBefore;
}

/* ---------- scan state (cache read by the synchronous view) ---------- */
let _splitCandidates = [];
let _splitScanToken = 0;

async function refreshSplitDetection() {
  if (!splitDetectAvailable() || !state || !Array.isArray(state.securities)) { _splitCandidates = []; return; }
  const token = ++_splitScanToken;
  const found = [];
  for (const sec of state.securities) {
    if (!sec.symbol) continue;
    let cands = [];
    try { cands = await detectSplitsForSecurity(sec); } catch (e) { continue; }
    for (const c of cands) if (!_splitHandled(sec, c)) found.push(c);
  }
  if (token !== _splitScanToken) return;   // superseded by a newer scan
  _splitCandidates = found.sort((a, b) => (a.date < b.date ? 1 : -1));
  if (typeof render === "function") render();
}

/* ---------- banner (read synchronously by viewInvestments) ---------- */
function renderSplitSuggestions() {
  if (!_splitCandidates || !_splitCandidates.length) return "";
  const items = _splitCandidates.slice(0, 8).map((c) => {
    const label = c.ratio >= 1 ? `${fmtShares(c.ratio)}:1` : `1:${fmtShares(1 / c.ratio)} reverse`;
    return `<div style="display:flex;gap:10px;align-items:center;justify-content:space-between;padding:6px 0;border-top:1px solid #EFE0B6">
      <div><strong>${esc(c.symbol)}</strong> — possible <strong>${label}</strong> split on ${c.date}
        <span class="muted">(${fmtMoney(c.prevClose)} → ${fmtMoney(c.close)})</span></div>
      <div style="display:flex;gap:6px;white-space:nowrap">
        <button class="btn sm" onclick="bookDetectedSplit('${c.secId}','${c.date}',${c.ratio})">Record split</button>
        <button class="btn ghost sm" onclick="dismissDetectedSplit('${c.secId}','${c.date}')">Dismiss</button>
      </div></div>`;
  }).join("");
  return `<div class="banner"><strong>Possible stock splits detected</strong> from price history — review before recording. A large overnight drop can also be a crash, not a split.${items}</div>`;
}

/* ---------- actions ---------- */
function bookDetectedSplit(secId, date, ratio) {
  if (typeof splitSecurity !== "function") return;
  splitSecurity(secId, date, Number(ratio));
  if (typeof rebuild === "function") rebuild();
  if (typeof save === "function") save();
  _splitCandidates = _splitCandidates.filter((c) => !(c.secId === secId && c.date === date));
  if (typeof render === "function") render();
}

function dismissDetectedSplit(secId, date) {
  const sec = (typeof getSecurity === "function") ? getSecurity(secId) : null;
  if (sec) {
    sec.splitDismissed = sec.splitDismissed || [];
    if (!sec.splitDismissed.includes(date)) sec.splitDismissed.push(date);
    if (typeof save === "function") save();
  }
  _splitCandidates = _splitCandidates.filter((c) => !(c.secId === secId && c.date === date));
  if (typeof render === "function") render();
}

/* expose for node tests if ever loaded there (browser uses globals) */
if (typeof module !== "undefined") {
  module.exports = {
    splitDetectAvailable, detectSplitsForSecurity, refreshSplitDetection,
    renderSplitSuggestions, bookDetectedSplit, dismissDetectedSplit,
  };
}
