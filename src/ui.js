
/* =================================================================
   UI LAYER
   ================================================================= */
const $ = (id) => document.getElementById(id);
const cls = (n, c) => `class="${[n, c].filter(Boolean).join(" ")}"`;
const sgn = (v) => (v < 0 ? "neg" : v > 0 ? "pos" : "");

function nav(v) { view = v; openTxn = null; render(); }

/* ---------- render dispatch ---------- */
function render() {
  renderSidebar();
  const m = $("main");
  if (view.type === "dashboard") m.innerHTML = viewDashboard();
  else if (view.type === "account") m.innerHTML = viewAccount(getAccount(view.id));
  else if (view.type === "categories") m.innerHTML = viewCategories();
  else if (view.type === "investments") m.innerHTML = viewInvestments();
  else if (view.type === "journal") m.innerHTML = viewJournal();
  else m.innerHTML = viewDashboard();
  // restore entry-form action visibility if present
  const sel = $("inv-action"); if (sel) onInvAction();
}

/* ---------- sidebar ---------- */
function renderSidebar() {
  const groups = {};
  for (const g of GROUP_ORDER) groups[g] = [];
  for (const a of state.accounts) groups[ACCT_TYPES[a.type].group].push(a);

  let acctHtml = "";
  for (const g of GROUP_ORDER) {
    const list = groups[g];
    if (!list.length) continue;
    const tot = cents(list.reduce((s, a) => s + accountValue(a), 0));
    acctHtml += `<div class="grp">${g}<span class="gtot num">${fmtMoney(tot)}</span></div>`;
    for (const a of list) {
      const active = view.type === "account" && view.id === a.id ? "active" : "";
      acctHtml += `<div class="acctrow ${active}" onclick="nav({type:'account',id:'${a.id}'})">
        <span class="an">${esc(a.name)}</span>
        <span class="ab num ${accountValue(a) < 0 ? "neg" : ""}">${fmtMoney(accountValue(a))}</span></div>`;
    }
  }

  const ni = (t, ic, label) => `<div class="navitem ${view.type === t ? "active" : ""}" onclick="nav({type:'${t}'})"><span class="ic">${ic}</span>${label}</div>`;

  $("side").innerHTML = `
    <div class="brand"><span class="mark"></span><div><h1>Ledgerwell</h1><small>Double-entry ledger</small></div></div>
    <div class="nw"><div class="lbl">Net worth</div><div class="val num">${fmtMoney(netWorth())}</div></div>
    <div class="navsec">
      ${ni("dashboard", "▦", "Dashboard")}
      ${ni("categories", "☰", "Categories")}
      ${ni("investments", "↗", "Investments")}
      ${ni("journal", "⇄", "Journal")}
    </div>
    ${acctHtml}
    <button class="addbtn" onclick="openAddAccount()">+ Add account</button>
    <button class="addbtn" onclick="openImport()">⇩ Import CSV</button>
    <div class="sidefoot">
      ${STORAGE_MODE === "memory" ? "In-memory session only — changes will not persist." : (STORAGE_MODE === "artifact" ? "Saved automatically to this device." : "Saved automatically in this browser.")}
      <br><button onclick="resetDemo()">Reset to demo data</button>
    </div>`;
}

/* ---------- dashboard ---------- */
function viewDashboard() {
  const from = todayISO().slice(0, 8) + "01";
  const to = todayISO();
  let inc = 0, exp = 0;
  for (const c of state.categories) {
    const b = balanceOfKey("cat:" + c.id, from, to);
    if (c.type === "income") inc += -b; else exp += b;
  }
  const realized = -balanceOfKey("sys:realized", from, to);
  inc = cents(inc + realized);
  exp = cents(exp);
  const net = cents(inc - exp);
  const monthName = new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" });

  // spending by category this month
  const spend = state.categories.filter((c) => c.type === "expense")
    .map((c) => ({ name: c.name, amt: balanceOfKey("cat:" + c.id, from, to) }))
    .filter((x) => x.amt > 0).sort((a, b) => b.amt - a.amt).slice(0, 6);
  const maxSpend = Math.max(1, ...spend.map((s) => s.amt));

  let acctRows = "";
  for (const g of GROUP_ORDER) {
    const list = state.accounts.filter((a) => ACCT_TYPES[a.type].group === g);
    for (const a of list) {
      acctRows += `<tr class="clk" onclick="nav({type:'account',id:'${a.id}'})">
        <td>${esc(a.name)}</td><td class="muted">${ACCT_TYPES[a.type].label}</td>
        <td class="r num ${accountValue(a) < 0 ? "neg" : ""}">${fmtMoney(accountValue(a))}</td></tr>`;
    }
  }

  // portfolio snapshot
  const invAccts = state.accounts.filter((a) => a.type === "investment");
  let portRows = "", totMv = 0, totCb = 0;
  for (const a of invAccts) {
    const h = state._holdings[a.id] || {};
    for (const secId in h) {
      const pos = h[secId]; if (pos.shares <= 1e-9) continue;
      const sec = getSecurity(secId); const mv = cents(pos.shares * sec.price);
      const unrl = cents(mv - pos.costBasis); totMv += mv; totCb += pos.costBasis;
      const pct = pos.costBasis ? (unrl / pos.costBasis) * 100 : 0;
      portRows += `<tr><td>${esc(sec.symbol)} <span class="muted">${esc(a.name)}</span></td>
        <td class="r num">${fmtShares(pos.shares)}</td>
        <td class="r num">${fmtMoney(mv)}</td>
        <td class="r num ${sgn(unrl)}">${fmtMoney(unrl)} <span class="muted">${fmtPct(pct)}</span></td></tr>`;
    }
  }

  return `
  <div class="ph"><div><h2>Dashboard</h2><div class="sub">${monthName} overview · double-entry ledger</div></div></div>
  <div class="cards">
    <div class="card"><div class="lbl">Net worth</div><div class="big num">${fmtMoney(netWorth())}</div><div class="meta">${state.accounts.length} accounts</div></div>
    <div class="card"><div class="lbl">Income · ${monthName.split(" ")[0]}</div><div class="big num pos">${fmtMoney(inc)}</div><div class="meta">incl. ${fmtMoney(realized)} realized gains</div></div>
    <div class="card"><div class="lbl">Spending · ${monthName.split(" ")[0]}</div><div class="big num neg">${fmtMoney(exp)}</div><div class="meta">across categories</div></div>
    <div class="card"><div class="lbl">Net cash flow</div><div class="big num ${sgn(net)}">${fmtMoney(net)}</div><div class="meta">income − spending</div></div>
  </div>

  <div style="display:grid;grid-template-columns:1.3fr 1fr;gap:20px" class="dgrid">
    <div class="panel">
      <div class="panel-h"><h3>Accounts</h3><button class="btn ghost sm" onclick="openAddAccount()">+ Add account</button></div>
      <div class="panel-b"><table><thead><tr><th>Account</th><th>Type</th><th class="r">Value</th></tr></thead>
        <tbody>${acctRows || `<tr><td colspan="3" class="empty">No accounts yet.</td></tr>`}</tbody></table></div>
    </div>
    <div class="panel">
      <div class="panel-h"><h3>Spending this month</h3></div>
      <div class="panel-b" style="padding:10px 0">
        ${spend.length ? spend.map((s) => `<div class="bar"><span class="nm">${esc(s.name)}</span>
          <span class="track"><span class="fill" style="width:${Math.max(4, (s.amt / maxSpend) * 100)}%"></span></span>
          <span class="r num">${fmtMoney(s.amt)}</span></div>`).join("") : `<div class="empty">No spending recorded this month.</div>`}
      </div>
    </div>
  </div>

  ${invAccts.length ? `<div class="panel">
    <div class="panel-h"><h3>Portfolio</h3><span class="muted num">Market ${fmtMoney(totMv)} · Cost ${fmtMoney(totCb)} · Unrealized <span class="${sgn(cents(totMv - totCb))}">${fmtMoney(cents(totMv - totCb))}</span></span></div>
    <div class="panel-b"><table><thead><tr><th>Holding</th><th class="r">Shares</th><th class="r">Market value</th><th class="r">Unrealized</th></tr></thead>
      <tbody>${portRows || `<tr><td colspan="4" class="empty">No holdings yet.</td></tr>`}</tbody></table></div>
  </div>` : ""}
  <style>@media(max-width:820px){.dgrid{grid-template-columns:1fr!important}}</style>`;
}

/* ---------- account view ---------- */
let invTab = "holdings";
function viewAccount(acc) {
  if (!acc) return viewDashboard();
  if (acc.type === "investment") return viewInvestmentAccount(acc);
  return viewBankAccount(acc);
}

function viewBankAccount(acc) {
  const meta = ACCT_TYPES[acc.type];
  const rows = registerRows(acc).reverse(); // newest first
  const cleared = cents(state.transactions.reduce((s, t) => {
    if (!t.cleared) return s;
    const p = (t.postings || []).find((x) => x.key === "acc:" + acc.id);
    return s + (p ? p.amount : 0);
  }, 0));

  let body = "";
  for (const r of rows) {
    const t = r.t;
    const isOpen = openTxn === t.id;
    const into = r.amount >= 0;
    body += `<tr class="clk" onclick="toggleDetail('${t.id}')">
      <td class="num muted">${t.date}</td>
      <td>${esc(t.payee) || "<span class='muted'>—</span>"}</td>
      <td>${esc(targetLabel(t, "acc:" + acc.id))}</td>
      <td class="muted">${esc(t.memo)}</td>
      <td class="r" style="width:34px">${t.payee === "Opening Balance" ? "" : `<span onclick="event.stopPropagation();toggleCleared('${t.id}')" class="dot ${t.cleared ? "on" : ""}" title="Cleared"></span>`}</td>
      <td class="r num neg">${into ? "" : fmtMoney(-r.amount)}</td>
      <td class="r num pos">${into ? fmtMoney(r.amount) : ""}</td>
      <td class="r num ${r.balance < 0 ? "neg" : ""}">${fmtMoney(r.balance)}</td></tr>`;
    if (isOpen) body += `<tr class="detail"><td colspan="8">${txnDetail(t)}</td></tr>`;
  }

  const catOpts = categoryOptionsHtml();
  const xferOpts = state.accounts.filter((a) => a.id !== acc.id)
    .map((a) => `<option value="acc:${a.id}">→ ${esc(a.name)}</option>`).join("");

  return `
  <div class="ph">
    <div><h2>${esc(acc.name)}</h2><div class="sub">${meta.label} · ${meta.group}</div></div>
    <div style="text-align:right">
      <div class="num" style="font-size:24px;font-weight:600;${accountValue(acc) < 0 ? "color:var(--neg)" : ""}">${fmtMoney(accountValue(acc))}</div>
      <div class="muted" style="font-size:12px">Cleared ${fmtMoney(cleared)}</div>
    </div>
  </div>

  <div class="panel">
    <div class="entry">
      <div class="row">
        <div class="fld"><label>Date</label><input id="b-date" type="date" value="${todayISO()}"></div>
        <div class="fld" style="flex:1;min-width:140px"><label>Payee</label><input id="b-payee" placeholder="e.g. Whole Foods"></div>
        <div class="fld" style="min-width:180px"><label>Category / Transfer</label>
          <select id="b-target"><optgroup label="Categories">${catOpts}</optgroup><optgroup label="Transfer to / from">${xferOpts}</optgroup></select></div>
        <div class="fld"><label>Type</label><select id="b-dir"><option value="-1">Payment</option><option value="1">Deposit</option></select></div>
        <div class="fld amt"><label>Amount</label><input id="b-amt" type="number" step="0.01" placeholder="0.00" style="width:110px"></div>
        <div class="fld" style="flex:1;min-width:120px"><label>Memo</label><input id="b-memo" placeholder="optional"></div>
        <button class="btn" onclick="submitBank('${acc.id}')">Add</button>
      </div>
    </div>
    <table>
      <thead><tr><th style="width:96px">Date</th><th>Payee</th><th>Category</th><th>Memo</th><th class="r">C</th><th class="r">Payment</th><th class="r">Deposit</th><th class="r">Balance</th></tr></thead>
      <tbody>${body || `<tr><td colspan="8" class="empty">No transactions yet. Add one above.</td></tr>`}</tbody>
    </table>
  </div>`;
}

function viewInvestmentAccount(acc) {
  const cash = accountCash(acc), mv = accountMarketValue(acc), val = accountValue(acc);
  const h = state._holdings[acc.id] || {};
  let cb = 0; for (const s in h) cb += h[s].costBasis; cb = cents(cb);
  const unrl = cents(mv - cb);

  const tabsHtml = `<div class="tabs">
    <div class="tab ${invTab === "holdings" ? "active" : ""}" onclick="setInvTab('holdings')">Holdings</div>
    <div class="tab ${invTab === "txns" ? "active" : ""}" onclick="setInvTab('txns')">Transactions</div></div>`;

  return `
  <div class="ph">
    <div><h2>${esc(acc.name)}</h2><div class="sub">Investment · multiple securities tracked separately, FIFO cost basis</div></div>
    <div style="text-align:right">
      <div class="num" style="font-size:24px;font-weight:600">${fmtMoney(val)}</div>
      <div class="muted" style="font-size:12px">Cash ${fmtMoney(cash)} · Market ${fmtMoney(mv)} · Unrealized <span class="${sgn(unrl)}">${fmtMoney(unrl)}</span></div>
    </div>
  </div>
  <div class="panel">
    ${tabsHtml}
    ${invTab === "holdings" ? holdingsTab(acc) : invTxnsTab(acc)}
  </div>`;
}

function holdingsTab(acc) {
  const h = state._holdings[acc.id] || {};
  const secIds = Object.keys(h).filter((id) => h[id].shares > 1e-9 || h[id].realized !== 0);
  let rows = "";
  for (const id of secIds) {
    const pos = h[id], sec = getSecurity(id);
    const mv = cents(pos.shares * sec.price);
    const unrl = cents(mv - pos.costBasis);
    const pct = pos.costBasis ? (unrl / pos.costBasis) * 100 : 0;
    const avg = pos.shares > 1e-9 ? pos.costBasis / pos.shares : 0;
    rows += `<tr>
      <td><strong>${esc(sec.symbol)}</strong> <span class="muted">${esc(sec.name)}</span></td>
      <td class="r num">${pos.shares > 1e-9 ? fmtShares(pos.shares) : "—"}</td>
      <td class="r num">${pos.shares > 1e-9 ? fmtMoney(avg) : "—"}</td>
      <td class="r num">${fmtMoney(pos.costBasis)}</td>
      <td class="r num"><input class="num" style="width:84px;text-align:right" type="number" step="0.01" value="${sec.price}" onchange="updatePrice('${sec.id}', this.value)"></td>
      <td class="r num">${fmtMoney(mv)}</td>
      <td class="r num ${sgn(unrl)}">${pos.shares > 1e-9 ? fmtMoney(unrl) + ` <span class="muted">${fmtPct(pct)}</span>` : "—"}</td>
      <td class="r num ${sgn(pos.realized)}">${pos.realized ? fmtMoney(pos.realized) : "—"}</td></tr>`;
  }
  return `<div class="panel-b">
    <table>
      <thead><tr><th>Security</th><th class="r">Shares</th><th class="r">Avg cost</th><th class="r">Cost basis</th><th class="r">Last price</th><th class="r">Market value</th><th class="r">Unrealized</th><th class="r">Realized</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="8" class="empty">No holdings yet. Record a Buy in the Transactions tab.</td></tr>`}</tbody>
    </table>
    <div style="padding:12px 16px;border-top:1px solid var(--line)"><button class="btn ghost sm" onclick="openManageSecurities()">Manage securities &amp; prices</button>
    <span class="muted" style="margin-left:10px;font-size:12px">Edit a price above to revalue holdings instantly.</span></div>
  </div>`;
}

function invTxnsTab(acc) {
  const rows = registerRows(acc).reverse();
  let body = "";
  for (const r of rows) {
    const t = r.t; const isOpen = openTxn === t.id;
    let desc = "", pillC = "", action = "—";
    if (t.inv) {
      const sec = getSecurity(t.inv.securityId);
      action = t.inv.action; pillC = action === "Buy" ? "buy" : action === "Sell" ? "sell" : "div";
      if (action === "Div") desc = `${esc(sec.symbol)} dividend`;
      else desc = `${esc(sec.symbol)} · ${fmtShares(t.inv.shares)} @ ${fmtMoney(t.inv.price)}${t.inv.fee ? " · fee " + fmtMoney(t.inv.fee) : ""}`;
    } else { action = targetLabel(t, "acc:" + acc.id + ":cash"); desc = esc(t.payee); }
    const into = r.amount >= 0;
    body += `<tr class="clk" onclick="toggleDetail('${t.id}')">
      <td class="num muted">${t.date}</td>
      <td>${t.inv ? `<span class="pill ${pillC}">${action}</span>` : esc(action)}</td>
      <td>${desc}</td>
      <td class="r num neg">${into ? "" : fmtMoney(-r.amount)}</td>
      <td class="r num pos">${into ? fmtMoney(r.amount) : ""}</td>
      <td class="r num">${fmtMoney(r.balance)}</td></tr>`;
    if (isOpen) body += `<tr class="detail"><td colspan="6">${txnDetail(t)}</td></tr>`;
  }
  const secOpts = state.securities.map((s) => `<option value="${s.id}">${esc(s.symbol)} — ${esc(s.name)}</option>`).join("");
  return `
  <div class="entry">
    <div class="row">
      <div class="fld"><label>Action</label><select id="inv-action" onchange="onInvAction()"><option>Buy</option><option>Sell</option><option value="Div">Dividend</option></select></div>
      <div class="fld"><label>Date</label><input id="inv-date" type="date" value="${todayISO()}"></div>
      <div class="fld" style="min-width:190px"><label>Security</label>
        <select id="inv-sec">${secOpts || ""}<option value="__new">+ Add new security…</option></select></div>
      <div class="fld amt" id="fld-shares"><label>Shares</label><input id="inv-shares" type="number" step="0.000001" placeholder="0" style="width:90px"></div>
      <div class="fld amt" id="fld-price"><label>Price</label><input id="inv-price" type="number" step="0.01" placeholder="0.00" style="width:90px"></div>
      <div class="fld amt" id="fld-fee"><label>Fee</label><input id="inv-fee" type="number" step="0.01" placeholder="0.00" style="width:80px"></div>
      <div class="fld amt" id="fld-amount" style="display:none"><label>Amount</label><input id="inv-amount" type="number" step="0.01" placeholder="0.00" style="width:100px"></div>
      <button class="btn" onclick="submitInv('${acc.id}')">Add</button>
    </div>
    <div class="muted" style="font-size:12px;margin-top:7px" id="inv-hint"></div>
  </div>
  <table>
    <thead><tr><th style="width:96px">Date</th><th>Action</th><th>Detail</th><th class="r">Cash out</th><th class="r">Cash in</th><th class="r">Cash bal.</th></tr></thead>
    <tbody>${body || `<tr><td colspan="6" class="empty">No investment transactions yet.</td></tr>`}</tbody>
  </table>`;
}

/* double-entry detail for any transaction */
function txnDetail(t) {
  const keyName = (k) => {
    if (k === "sys:opening") return "Opening Balance Equity";
    if (k === "sys:realized") return "Realized Capital Gains";
    if (k.startsWith("cat:")) { const c = getCategory(k.slice(4)); return (c ? c.name : "Category") + (c ? ` · ${c.type}` : ""); }
    if (k.startsWith("acc:")) {
      const isCash = k.endsWith(":cash"), isSec = k.endsWith(":sec");
      const id = k.slice(4).replace(/:cash$|:sec$/, "");
      const a = getAccount(id);
      return (a ? a.name : "Account") + (isCash ? " · cash" : isSec ? " · securities (cost)" : "");
    }
    return k;
  };
  const rows = (t.postings || []).map((p) => `<tr>
    <td>${esc(keyName(p.key))}</td>
    <td class="r num deb">${p.amount > 0 ? fmtMoney(p.amount) : ""}</td>
    <td class="r num cre">${p.amount < 0 ? fmtMoney(-p.amount) : ""}</td></tr>`).join("");
  const sum = cents((t.postings || []).reduce((s, p) => s + p.amount, 0));
  return `<div class="detail-in">
    <div class="ttl">Journal entry · postings must net to zero (${fmtMoney(sum)})</div>
    <table class="je"><thead><tr><th>Account</th><th class="r">Debit (+)</th><th class="r">Credit (−)</th></tr></thead><tbody>${rows}</tbody></table>
    <div style="margin-top:10px"><button class="btn danger sm" onclick="if(confirm('Delete this transaction?'))deleteTxn('${t.id}')">Delete transaction</button></div>
  </div>`;
}

/* ---------- categories ---------- */
function viewCategories() {
  const from = todayISO().slice(0, 8) + "01", to = todayISO();
  const renderGroup = (type) => {
    const list = state.categories.filter((c) => c.type === type);
    return list.map((c) => {
      const all = balanceOfKey("cat:" + c.id);
      const month = balanceOfKey("cat:" + c.id, from, to);
      const disp = type === "income" ? -all : all;
      const dispM = type === "income" ? -month : month;
      const used = state.transactions.some((t) => (t.postings || []).some((p) => p.key === "cat:" + c.id));
      const builtin = c.id === DIV_CAT_ID || c.id === INT_CAT_ID;
      return `<tr><td>${esc(c.name)}${builtin ? ' <span class="pill">built-in</span>' : ""}</td>
        <td class="r num ${sgn(dispM)}">${fmtMoney(dispM)}</td>
        <td class="r num ${sgn(disp)}">${fmtMoney(disp)}</td>
        <td class="r">${builtin || used ? `<span class="muted" style="font-size:12px">${used ? "in use" : "reserved"}</span>` : `<button class="btn danger sm" onclick="delCategory('${c.id}')">Delete</button>`}</td></tr>`;
    }).join("") || `<tr><td colspan="4" class="empty">No ${type} categories.</td></tr>`;
  };
  return `
  <div class="ph"><div><h2>Categories</h2><div class="sub">Each category is an income or expense account in the ledger</div></div></div>
  <div class="panel">
    <div class="panel-h"><h3>Income</h3><button class="btn ghost sm" onclick="addCategoryPrompt('income')">+ Add income category</button></div>
    <div class="panel-b"><table><thead><tr><th>Category</th><th class="r">This month</th><th class="r">All time</th><th class="r"></th></tr></thead><tbody>${renderGroup("income")}</tbody></table></div>
  </div>
  <div class="panel">
    <div class="panel-h"><h3>Expenses</h3><button class="btn ghost sm" onclick="addCategoryPrompt('expense')">+ Add expense category</button></div>
    <div class="panel-b"><table><thead><tr><th>Category</th><th class="r">This month</th><th class="r">All time</th><th class="r"></th></tr></thead><tbody>${renderGroup("expense")}</tbody></table></div>
  </div>`;
}

/* ---------- journal (raw double-entry proof) ---------- */
function viewJournal() {
  const keyName = (k) => {
    if (k === "sys:opening") return "Opening Balance Equity";
    if (k === "sys:realized") return "Realized Capital Gains";
    if (k.startsWith("cat:")) { const c = getCategory(k.slice(4)); return c ? c.name : "Category"; }
    if (k.startsWith("acc:")) { const id = k.slice(4).replace(/:cash$|:sec$/, ""); const a = getAccount(id); const suf = k.endsWith(":cash") ? " (cash)" : k.endsWith(":sec") ? " (securities)" : ""; return (a ? a.name : "Account") + suf; }
    return k;
  };
  const txns = [...state.transactions].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.seq || 0) - (a.seq || 0)));
  let totalDeb = 0, totalCre = 0, body = "";
  for (const t of txns) {
    const label = t.inv ? (t.inv.action === "Div" ? "Dividend" : t.inv.action + " " + (getSecurity(t.inv.securityId) || {}).symbol) : (t.payee || "—");
    (t.postings || []).forEach((p, i) => {
      if (p.amount > 0) totalDeb += p.amount; else totalCre += -p.amount;
      body += `<tr>
        <td class="num muted">${i === 0 ? t.date : ""}</td>
        <td>${i === 0 ? esc(label) : ""}</td>
        <td>${esc(keyName(p.key))}</td>
        <td class="r num">${p.amount > 0 ? fmtMoney(p.amount) : ""}</td>
        <td class="r num">${p.amount < 0 ? fmtMoney(-p.amount) : ""}</td></tr>`;
    });
  }
  return `
  <div class="ph"><div><h2>Journal</h2><div class="sub">Every posting in the ledger. Total debits must equal total credits.</div></div>
    <div class="tag">Debits ${fmtMoney(cents(totalDeb))} = Credits ${fmtMoney(cents(totalCre))}</div></div>
  <div class="panel"><div class="panel-b"><table>
    <thead><tr><th style="width:96px">Date</th><th>Transaction</th><th>Account</th><th class="r">Debit (+)</th><th class="r">Credit (−)</th></tr></thead>
    <tbody>${body || `<tr><td colspan="5" class="empty">No entries.</td></tr>`}</tbody></table></div></div>`;
}

/* ---------- shared bits ---------- */
function categoryOptionsHtml() {
  const inc = state.categories.filter((c) => c.type === "income").map((c) => `<option value="cat:${c.id}">${esc(c.name)}</option>`).join("");
  const exp = state.categories.filter((c) => c.type === "expense").map((c) => `<option value="cat:${c.id}">${esc(c.name)}</option>`).join("");
  return `<optgroup label="Income">${inc}</optgroup><optgroup label="Expense">${exp}</optgroup>`;
}

/* ---------- handlers ---------- */
function toggleDetail(id) { openTxn = openTxn === id ? null : id; render(); }
function toggleCleared(id) { const t = state.transactions.find((x) => x.id === id); if (t) { t.cleared = !t.cleared; save(); render(); } }
function setInvTab(t) { invTab = t; render(); }

function submitBank(accId) {
  const date = $("b-date").value || todayISO();
  const payee = $("b-payee").value;
  const target = $("b-target").value;
  const dir = Number($("b-dir").value);
  const raw = parseFloat($("b-amt").value);
  if (!raw || raw <= 0) { alert("Enter an amount greater than zero."); return; }
  addBankTxn({ date, accountId: accId, payee, target, amount: dir * Math.abs(raw), memo: $("b-memo").value, cleared: false });
  rebuild(); save(); render();
}

function onInvAction() {
  const a = $("inv-action").value;
  const isDiv = a === "Div";
  $("fld-shares").style.display = isDiv ? "none" : "";
  $("fld-price").style.display = isDiv ? "none" : "";
  $("fld-fee").style.display = isDiv ? "none" : "";
  $("fld-amount").style.display = isDiv ? "" : "none";
  const hint = $("inv-hint");
  if (hint) hint.textContent = a === "Buy" ? "Buy adds a lot; fee is added to cost basis."
    : a === "Sell" ? "Sell relieves shares FIFO (oldest lots first) and books realized gain/loss."
    : "Dividend records cash income against the security.";
}

function submitInv(accId) {
  const action = $("inv-action").value;
  const date = $("inv-date").value || todayISO();
  const secVal = $("inv-sec").value;
  if (secVal === "__new" || !secVal) { openAddSecurity(); return; }
  if (action === "Div") {
    const amt = parseFloat($("inv-amount").value);
    if (!amt || amt <= 0) { alert("Enter a dividend amount."); return; }
    dividend(accId, secVal, date, amt);
  } else {
    const shares = parseFloat($("inv-shares").value);
    const price = parseFloat($("inv-price").value);
    const fee = parseFloat($("inv-fee").value) || 0;
    if (!shares || shares <= 0) { alert("Enter a share quantity."); return; }
    if (price == null || isNaN(price) || price < 0) { alert("Enter a price."); return; }
    if (action === "Sell") {
      const held = ((state._holdings[accId] || {})[secVal] || {}).shares || 0;
      if (shares > held + 1e-9) { alert(`You only hold ${fmtShares(held)} shares of this security in this account.`); return; }
      sell(accId, secVal, date, shares, price, fee);
    } else {
      buy(accId, secVal, date, shares, price, fee);
    }
  }
  rebuild(); save(); render();
}

function updatePrice(secId, val) {
  const s = getSecurity(secId); const p = parseFloat(val);
  if (s && !isNaN(p) && p >= 0) { s.price = cents(p); s.priceDate = todayISO(); save(); render(); }
}

function addCategoryPrompt(type) {
  const name = prompt(`New ${type} category name:`);
  if (name && name.trim()) { addCategory(name, type); render(); }
}
function delCategory(id) {
  const used = state.transactions.some((t) => (t.postings || []).some((p) => p.key === "cat:" + id));
  if (used) { alert("This category is in use and can't be deleted."); return; }
  if (!confirm("Delete this category?")) return;
  state.categories = state.categories.filter((c) => c.id !== id); save(); render();
}

function resetDemo() {
  if (!confirm("Replace all data with the demo dataset?")) return;
  seedDemo(); save(); view = { type: "dashboard" }; render();
}

/* ---------- modals ---------- */
function openModal(html) { $("modal-root").innerHTML = `<div class="scrim" onclick="if(event.target===this)closeModal()"><div class="modal">${html}</div></div>`; }
function closeModal() { $("modal-root").innerHTML = ""; }

function openAddAccount() {
  const typeOpts = Object.entries(ACCT_TYPES).map(([k, v]) => `<option value="${k}">${v.label} · ${v.group}</option>`).join("");
  openModal(`
    <div class="modal-h"><h3>Add account</h3><p>Banking and investment accounts both post to the double-entry ledger.</p></div>
    <div class="modal-b">
      <div class="fld"><label>Name</label><input id="m-name" class="full" placeholder="e.g. Everyday Checking"></div>
      <div class="fld"><label>Type</label><select id="m-type" class="full">${typeOpts}</select></div>
      <div class="fld"><label>Opening balance (cash)</label><input id="m-open" class="full num" type="number" step="0.01" placeholder="0.00"></div>
      <div class="fld"><label>Opening date</label><input id="m-date" class="full" type="date" value="${todayISO()}"></div>
    </div>
    <div class="modal-f"><button class="btn ghost" onclick="closeModal()">Cancel</button><button class="btn" onclick="doAddAccount()">Create account</button></div>`);
  setTimeout(() => $("m-name").focus(), 30);
}
function doAddAccount() {
  const name = $("m-name").value.trim();
  if (!name) { alert("Give the account a name."); return; }
  const a = addAccount(name, $("m-type").value, parseFloat($("m-open").value) || 0, $("m-date").value, true);
  rebuild(); save(); closeModal(); nav({ type: "account", id: a.id });
}

function openAddSecurity() {
  openModal(`
    <div class="modal-h"><h3>Add security</h3><p>A stock or fund you can hold in any investment account.</p></div>
    <div class="modal-b">
      <div class="fld"><label>Symbol</label><input id="s-sym" class="full" placeholder="e.g. AAPL"></div>
      <div class="fld"><label>Name</label><input id="s-name" class="full" placeholder="e.g. Apple Inc."></div>
      <div class="fld"><label>Current price</label><input id="s-price" class="full num" type="number" step="0.01" placeholder="0.00"></div>
    </div>
    <div class="modal-f"><button class="btn ghost" onclick="closeModal()">Cancel</button><button class="btn" onclick="doAddSecurity()">Add security</button></div>`);
  setTimeout(() => $("s-sym").focus(), 30);
}
function doAddSecurity() {
  const sym = $("s-sym").value.trim(); if (!sym) { alert("Enter a symbol."); return; }
  const s = addSecurity(sym, $("s-name").value || sym, parseFloat($("s-price").value) || 0);
  save(); closeModal(); render();
  // preselect in the entry form if present
  const sel = $("inv-sec"); if (sel) sel.value = s.id;
}

function openManageSecurities() {
  const rows = state.securities.map((s) => `<tr>
    <td><input value="${esc(s.symbol)}" onchange="editSec('${s.id}','symbol',this.value)"></td>
    <td><input value="${esc(s.name)}" onchange="editSec('${s.id}','name',this.value)"></td>
    <td><input class="num" type="number" step="0.01" value="${s.price}" onchange="editSec('${s.id}','price',this.value)"></td>
  </tr>`).join("");
  openModal(`
    <div class="modal-h"><h3>Securities &amp; prices</h3><p>Update a price to revalue every account holding that security.</p></div>
    <div class="modal-b">
      <table class="seclist"><thead><tr><th>Symbol</th><th>Name</th><th class="r">Price</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="3" class="empty">No securities yet.</td></tr>`}</tbody></table>
    </div>
    <div class="modal-f"><button class="btn ghost" onclick="openAddSecurity()">+ New security</button><button class="btn" onclick="closeModal();render()">Done</button></div>`);
}
function editSec(id, field, val) {
  const s = getSecurity(id); if (!s) return;
  if (field === "price") { const p = parseFloat(val); if (!isNaN(p) && p >= 0) s.price = cents(p); }
  else if (field === "symbol") s.symbol = val.trim().toUpperCase();
  else s.name = val.trim();
  s.priceDate = todayISO(); save();
}
