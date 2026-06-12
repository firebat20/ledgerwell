/* ============================================================
   investments.js — top-level Investments management view
   A plain-globals module (loaded after ui.js), mirroring how
   viewCategories / viewJournal work. Wired into ui.js render()
   via:  else if (view.type === "investments") m.innerHTML = viewInvestments();
   and a sidebar nav item:  ${ni("investments", "↗", "Investments")}

   Reuses engine.js + ui.js globals: state, getSecurity, accountCash,
   accountMarketValue, accountValue, balanceOfKey, cents, sgn, esc,
   fmtMoney, fmtShares, fmtPct, nav, updatePrice, editSec, render,
   openAddAccount, openAddSecurity.
   ============================================================ */

function viewInvestments() {
  const invAccts = state.accounts.filter((a) => a.type === "investment");

  if (!invAccts.length) {
    return `
    <div class="ph"><div><h2>Investments</h2><div class="sub">Holdings, FIFO cost basis, and gains across every investment account</div></div></div>
    ${(typeof renderSplitSuggestions === "function") ? renderSplitSuggestions() : ""}
    <div class="panel"><div class="panel-b"><div class="empty">
      No investment accounts yet.<br><br>
      <button class="btn" onclick="openAddAccount()">+ Add investment account</button>
    </div></div></div>`;
  }

  // ---- totals + per-account rows ----
  let totCash = 0, totMv = 0, totCb = 0;
  const acctRows = invAccts.map((a) => {
    const cash = accountCash(a), mv = accountMarketValue(a);
    const h = state._holdings[a.id] || {};
    let cb = 0; for (const s in h) cb += h[s].costBasis; cb = cents(cb);
    totCash += cash; totMv += mv; totCb += cb;
    const unrl = cents(mv - cb);
    return `<tr class="clk" onclick="nav({type:'account',id:'${a.id}'})">
      <td>${esc(a.name)}</td>
      <td class="r num">${fmtMoney(cash)}</td>
      <td class="r num">${fmtMoney(mv)}</td>
      <td class="r num ${sgn(unrl)}">${fmtMoney(unrl)}</td>
      <td class="r num">${fmtMoney(accountValue(a))}</td></tr>`;
  }).join("");
  totCash = cents(totCash); totMv = cents(totMv); totCb = cents(totCb);
  const totUnrl = cents(totMv - totCb);
  const totRealized = -balanceOfKey("sys:realized"); // realized posts as −gain

  // ---- consolidated holdings across all accounts ----
  let holdRows = "";
  for (const a of invAccts) {
    const h = state._holdings[a.id] || {};
    const ids = Object.keys(h).filter((id) => h[id].shares > 1e-9 || h[id].realized !== 0);
    for (const id of ids) {
      const pos = h[id], sec = getSecurity(id);
      const mv = cents(pos.shares * sec.price);
      const unrl = cents(mv - pos.costBasis);
      const pct = pos.costBasis ? (unrl / pos.costBasis) * 100 : 0;
      const avg = pos.shares > 1e-9 ? pos.costBasis / pos.shares : 0;
      holdRows += `<tr>
        <td><strong>${esc(sec.symbol)}</strong> <span class="muted">${esc(a.name)}</span></td>
        <td class="r num">${pos.shares > 1e-9 ? fmtShares(pos.shares) : "—"}</td>
        <td class="r num">${pos.shares > 1e-9 ? fmtMoney(avg) : "—"}</td>
        <td class="r num">${fmtMoney(pos.costBasis)}</td>
        <td class="r num"><input class="num" style="width:84px;text-align:right" type="number" step="0.01" value="${sec.price}" onchange="updatePrice('${sec.id}', this.value)"></td>
        <td class="r num">${fmtMoney(mv)}</td>
        <td class="r num ${sgn(unrl)}">${pos.shares > 1e-9 ? fmtMoney(unrl) + ` <span class="muted">${fmtPct(pct)}</span>` : "—"}</td>
        <td class="r num ${sgn(pos.realized)}">${pos.realized ? fmtMoney(pos.realized) : "—"}</td></tr>`;
    }
  }

  // ---- securities & prices (editable, like Categories' manager) ----
  const _canFetch = (typeof priceFetchAvailable === "function") && priceFetchAvailable();
  const _canBulk = (typeof bulkUpdateAvailable === "function") && bulkUpdateAvailable();
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

  return `
  <div class="ph">
    <div><h2>Investments</h2><div class="sub">Holdings, FIFO cost basis, and gains across every investment account</div></div>
    <button class="btn ghost sm" onclick="openAddAccount()">+ Add investment account</button>
  </div>

  <div class="cards">
    <div class="card"><div class="lbl">Market value</div><div class="big num">${fmtMoney(totMv)}</div><div class="meta">+ ${fmtMoney(totCash)} cash</div></div>
    <div class="card"><div class="lbl">Cost basis</div><div class="big num">${fmtMoney(totCb)}</div><div class="meta">of current holdings</div></div>
    <div class="card"><div class="lbl">Unrealized</div><div class="big num ${sgn(totUnrl)}">${fmtMoney(totUnrl)}</div><div class="meta">${fmtPct(totCb ? (totUnrl / totCb) * 100 : 0)} vs cost</div></div>
    <div class="card"><div class="lbl">Realized · all time</div><div class="big num ${sgn(totRealized)}">${fmtMoney(totRealized)}</div><div class="meta">booked gains / losses</div></div>
  </div>

  <div class="panel">
    <div class="panel-h"><h3>Accounts</h3></div>
    <div class="panel-b"><table>
      <thead><tr><th>Account</th><th class="r">Cash</th><th class="r">Market value</th><th class="r">Unrealized</th><th class="r">Total value</th></tr></thead>
      <tbody>${acctRows}</tbody></table></div>
  </div>

  <div class="panel">
    <div class="panel-h"><h3>Securities &amp; prices</h3>
      <div>
        ${_canFetch ? `<button class="btn sm" onclick="runPriceUpdate()">Update prices</button>` : ""}
        ${_canBulk ? `<button class="btn ghost sm" title="Download Stooq's US end-of-day archive in one request — sidesteps the per-symbol daily limit" onclick="runBulkUpdate()">Full refresh</button>` : ""}
        ${(typeof splitDetectAvailable === "function" && splitDetectAvailable()) ? `<button class="btn ghost sm" onclick="refreshSplitDetection()">Check for splits</button>` : ""}
        <button class="btn ghost sm" onclick="openAddSecurity()">+ Add security</button>
      </div>
    </div>
    ${(typeof priceStatusHtml === "function") ? `<div style="padding:0 16px">${priceStatusHtml()}</div>` : ""}
    <div class="panel-b"><table>
      <thead><tr><th>Symbol</th><th>Name</th><th class="r">Price</th><th>Stooq ticker</th><th></th><th class="r"></th></tr></thead>
      <tbody>${secRows || `<tr><td colspan="6" class="empty">No securities yet.</td></tr>`}</tbody></table></div>
  </div>`;
}
