/* ============================================================
   import.js — CSV import wizard
   A self-contained, plain-globals module (loaded after ui.js).
   Implements the ROADMAP "CSV import" spec:
     1. choose destination account
     2. column mapping + live preview (signed Amount OR Debit/Credit)
     3. per-row double-entry assignment (category / transfer)
     4. recurring auto-match (pre-fill from prior matching payees)
     5. duplicate detection (date + amount + description) with skip
   Depends on globals from engine.js (state, cents, keyForAccount,
   addBankTxn, rebuild, save, getAccount, ACCT_TYPES, esc, fmtMoney)
   and ui.js (openModal, closeModal, render).
   ============================================================ */

let importState = null;

/* ---------- pure parsing helpers ---------- */
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\r") { /* ignore */ }
    else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ""));
}

function normDate(s) {
  s = String(s || "").trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})[\/.](\d{1,2})[\/.](\d{2})$/);
  if (m) return `20${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  const d = new Date(s);
  return isNaN(d) ? s : d.toISOString().slice(0, 10);
}

function parseAmt(s) {
  if (s == null) return NaN;
  s = String(s).trim();
  if (s === "") return NaN;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/[$,\s]/g, "");
  if (s.startsWith("-")) { neg = true; s = s.slice(1); }
  const v = parseFloat(s);
  if (isNaN(v)) return NaN;
  return neg ? -v : v;
}

/* signed amount, positive = money INTO the account (engine convention) */
function importRowAmount(cells, m) {
  if (m.mode === "single") {
    let v = parseAmt(cells[m.amt]);
    if (isNaN(v)) return NaN;
    return m.flip ? -v : v;
  }
  const d = parseAmt(cells[m.debit]);
  const c = parseAmt(cells[m.credit]);
  if (isNaN(d) && isNaN(c)) return NaN;
  return cents((isNaN(c) ? 0 : c) - (isNaN(d) ? 0 : d));
}

/* merchant signature: first up-to-3 alphabetic tokens, lowercased */
function descTokens(s) {
  return String(s || "").toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 2).slice(0, 3);
}
function tokenPrefixMatch(a, b) {
  const n = Math.min(a.length, b.length);
  if (n === 0) return false;
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;
  return true;
}

/* ---------- auto-match + duplicate detection (need state) ---------- */
function guessTarget(desc, destId) {
  const want = descTokens(desc);
  if (!want.length) return "";
  const destKey = keyForAccount(destId);
  const score = {};
  for (const t of state.transactions) {
    if (!t.payee) continue;
    if (!tokenPrefixMatch(want, descTokens(t.payee))) continue;
    for (const p of (t.postings || [])) {
      let key = null;
      if (p.key === destKey) continue;
      if (p.key.startsWith("cat:")) key = p.key;
      else if (p.key.startsWith("acc:")) {
        const id = p.key.slice(4).replace(/:cash$|:sec$/, "");
        if (id === destId) continue;
        key = "acc:" + id;
      }
      if (key) score[key] = (score[key] || 0) + 1 + (t.seq || 0) / 1e9; // freq, recency tiebreak
    }
  }
  let best = "", top = 0;
  for (const k in score) if (score[k] > top) { top = score[k]; best = k; }
  return best;
}

function isDuplicate(date, amount, desc, destId) {
  const key = keyForAccount(destId);
  const sig = descTokens(desc).join(" ");
  return state.transactions.some((t) => {
    if (t.date !== date) return false;
    const p = (t.postings || []).find((x) => x.key === key);
    if (!p || cents(p.amount) !== cents(amount)) return false;
    return descTokens(t.payee).join(" ") === sig;
  });
}

function guessMapping(headers) {
  const find = (re) => headers.findIndex((x) => re.test(x));
  const date = Math.max(0, find(/date/i));
  const desc = Math.max(0, find(/desc|payee|merchant|memo|narration|name|detail/i));
  const amt = find(/^amount$|amount|amt|signed/i);
  const debit = find(/debit|withdraw|payment|charge|outflow/i);
  const credit = find(/credit|deposit|inflow/i);
  const mode = amt >= 0 ? "single" : ((debit >= 0 || credit >= 0) ? "separate" : "single");
  return {
    header: true, date, desc, mode, flip: false,
    amt: amt >= 0 ? amt : Math.min(2, headers.length - 1),
    debit: debit >= 0 ? debit : 0,
    credit: credit >= 0 ? credit : Math.min(1, headers.length - 1),
  };
}

/* ---------- styling (injected once) ---------- */
function ensureImportStyles() {
  if (document.getElementById("imp-style")) return;
  const s = document.createElement("style");
  s.id = "imp-style";
  s.textContent = `
  .imp-wrap .imp-step{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:-4px 0 12px}
  .imp-map{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:11px 14px;margin-bottom:14px}
  .imp-map .fld{margin:0}
  .imp-map .fld select,.imp-map .fld input{width:100%;padding:8px 10px;border:1px solid var(--line-strong);border-radius:7px;background:#fff}
  .imp-radio{display:flex;gap:16px;align-items:center;font-size:13px;margin:2px 0 10px}
  .imp-radio label{display:flex;gap:6px;align-items:center;text-transform:none;letter-spacing:0;font-weight:500;color:var(--ink)}
  .imp-scroll{max-height:48vh;overflow:auto;border:1px solid var(--line);border-radius:8px}
  .imp-scroll table{margin:0}
  .imp-scroll thead th{position:sticky;top:0;z-index:1}
  .imp-sel{width:100%;padding:5px 7px;border:1px solid var(--line-strong);border-radius:6px;background:#fff;font-size:12.5px}
  .imp-sel.bad{border-color:var(--neg);box-shadow:0 0 0 2px var(--neg-tint)}
  td.bad{color:var(--neg);font-weight:600}
  .badge-dup{font-size:10px;font-weight:600;color:var(--warn);background:#FBF3DE;border:1px solid #EFE0B6;padding:1px 7px;border-radius:999px}
  .imp-note{flex:1;font-size:12px;color:var(--muted);text-align:left;align-self:center}`;
  document.head.appendChild(s);
}

function impModal(html) {
  ensureImportStyles();
  openModal(`<div class="imp-wrap">${html}</div>`);
  const m = document.querySelector("#modal-root .modal");
  if (m) m.style.width = "min(920px,96vw)";
}

/* ---------- target <select> options (categories + transfers) ---------- */
function importTargetOptions(sel, destId) {
  const opt = (v, label) => `<option value="${v}" ${v === sel ? "selected" : ""}>${esc(label)}</option>`;
  const inc = state.categories.filter((c) => c.type === "income").map((c) => opt("cat:" + c.id, c.name)).join("");
  const exp = state.categories.filter((c) => c.type === "expense").map((c) => opt("cat:" + c.id, c.name)).join("");
  const xfer = state.accounts.filter((a) => a.id !== destId).map((a) => opt("acc:" + a.id, "→ " + a.name)).join("");
  return `<option value="" ${sel ? "" : "selected"}>— choose —</option>
    <optgroup label="Income">${inc}</optgroup>
    <optgroup label="Expense">${exp}</optgroup>
    <optgroup label="Transfer to / from">${xfer}</optgroup>`;
}

/* ---------- step 1: source ---------- */
function openImport() {
  if (!state.accounts.length) {
    alert("Add an account first, then import into it.");
    openAddAccount();
    return;
  }
  importState = { accountId: state.accounts[0].id, raw: null, map: null, rows: null };
  const acctOpts = state.accounts
    .map((a) => `<option value="${a.id}">${esc(a.name)} · ${ACCT_TYPES[a.type].label}</option>`).join("");
  impModal(`
    <div class="modal-h"><h3>Import transactions</h3><p>Bring a bank, credit, or investment-cash CSV export into one account.</p></div>
    <div class="modal-b">
      <div class="imp-step">Step 1 of 3 · Source</div>
      <div class="fld"><label>Destination account</label>
        <select id="imp-acct" class="full">${acctOpts}</select></div>
      <div class="fld" style="margin-top:13px"><label>CSV file</label>
        <input id="imp-file" type="file" accept=".csv,text/csv" class="full"></div>
      <div class="fld" style="margin-top:13px"><label>…or paste CSV text</label>
        <textarea id="imp-text" class="full" rows="6" placeholder="Date,Description,Amount&#10;2025-06-01,ACME PAYROLL,3200.00" style="padding:9px 11px;border:1px solid var(--line-strong);border-radius:7px;font-family:'IBM Plex Mono',monospace;font-size:12.5px"></textarea></div>
    </div>
    <div class="modal-f"><button class="btn ghost" onclick="closeModal()">Cancel</button>
      <button class="btn" onclick="importParse()">Next: map columns</button></div>`);
}

async function importParse() {
  importState.accountId = $("imp-acct").value;
  const f = $("imp-file").files[0];
  let text = "";
  try { text = f ? await f.text() : $("imp-text").value; }
  catch (e) { alert("Could not read that file."); return; }
  const raw = parseCSV(text || "");
  if (raw.length < 1) { alert("No rows found. Paste CSV text or choose a file."); return; }
  importState.raw = raw;
  importState.map = guessMapping(raw[0]);
  importRenderMapping();
}

/* ---------- step 2: column mapping + preview ---------- */
function importReadMap() {
  const m = importState.map;
  m.header = $("imp-header").checked;
  m.date = +$("imp-date").value;
  m.desc = +$("imp-desc").value;
  m.mode = $("imp-mode").value;
  if (m.mode === "single") { m.amt = +$("imp-amt").value; m.flip = $("imp-flip").checked; }
  else { m.debit = +$("imp-debit").value; m.credit = +$("imp-credit").value; }
}

function importRenderMapping() {
  const { raw, map: m } = importState;
  const headers = raw[0];
  const colOpt = (sel) => headers
    .map((h, i) => `<option value="${i}" ${i === sel ? "selected" : ""}>${m.header ? esc(h) : "Column " + (i + 1)}</option>`).join("");
  const data = m.header ? raw.slice(1) : raw;
  const preview = data.slice(0, 6).map((cells) => {
    const date = normDate(cells[m.date]);
    const amt = importRowAmount(cells, m);
    const dOk = /^\d{4}-\d{2}-\d{2}$/.test(date);
    return `<tr>
      <td class="num ${dOk ? "muted" : "bad"}">${esc(date) || "—"}</td>
      <td>${esc((cells[m.desc] || "").trim()) || "<span class='muted'>—</span>"}</td>
      <td class="r num ${isNaN(amt) ? "bad" : (amt < 0 ? "neg" : "pos")}">${isNaN(amt) ? "invalid" : fmtMoney(amt)}</td></tr>`;
  }).join("");

  const single = m.mode === "single";
  impModal(`
    <div class="modal-h"><h3>Map columns</h3><p>Match your file's columns, then check the preview. Positive = money in.</p></div>
    <div class="modal-b">
      <div class="imp-step">Step 2 of 3 · Columns</div>
      <label class="imp-radio"><input type="checkbox" id="imp-header" ${m.header ? "checked" : ""} onchange="importReadMap();importRenderMapping()"> First row is a header</label>
      <div class="imp-map">
        <div class="fld"><label>Date column</label><select id="imp-date" onchange="importReadMap();importRenderMapping()">${colOpt(m.date)}</select></div>
        <div class="fld"><label>Description column</label><select id="imp-desc" onchange="importReadMap();importRenderMapping()">${colOpt(m.desc)}</select></div>
      </div>
      <div class="fld" style="margin-bottom:8px"><label>Amount format</label>
        <select id="imp-mode" onchange="importReadMap();importRenderMapping()">
          <option value="single" ${single ? "selected" : ""}>One signed Amount column</option>
          <option value="separate" ${single ? "" : "selected"}>Separate Debit &amp; Credit columns</option>
        </select></div>
      <div class="imp-map">
        ${single ? `
          <div class="fld"><label>Amount column</label><select id="imp-amt" onchange="importReadMap();importRenderMapping()">${colOpt(m.amt)}</select></div>
          <div class="fld" style="justify-content:flex-end"><label class="imp-radio"><input type="checkbox" id="imp-flip" ${m.flip ? "checked" : ""} onchange="importReadMap();importRenderMapping()"> Outflows are positive (flip signs)</label></div>`
        : `
          <div class="fld"><label>Debit / money-out column</label><select id="imp-debit" onchange="importReadMap();importRenderMapping()">${colOpt(m.debit)}</select></div>
          <div class="fld"><label>Credit / money-in column</label><select id="imp-credit" onchange="importReadMap();importRenderMapping()">${colOpt(m.credit)}</select></div>`}
      </div>
      <div class="imp-step" style="margin:14px 0 6px">Preview · first ${Math.min(6, data.length)} of ${data.length} rows</div>
      <div class="imp-scroll"><table>
        <thead><tr><th style="width:120px">Date</th><th>Description</th><th class="r">Amount</th></tr></thead>
        <tbody>${preview || `<tr><td colspan="3" class="empty">No data rows.</td></tr>`}</tbody></table></div>
    </div>
    <div class="modal-f"><button class="btn ghost" onclick="openImport()">Back</button>
      <button class="btn" onclick="importBuildRows()">Next: assign categories</button></div>`);
}

/* ---------- step 3: per-row assignment ---------- */
function importBuildRows() {
  importReadMap();
  const { raw, map: m, accountId } = importState;
  const data = m.header ? raw.slice(1) : raw;
  importState.rows = data.map((cells) => {
    const date = normDate(cells[m.date]);
    const desc = (cells[m.desc] || "").trim();
    const amount = cents(importRowAmount(cells, m));
    const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(date);
    const amtOk = !isNaN(amount) && amount !== 0;
    const target = guessTarget(desc, accountId);
    const dup = dateOk && amtOk && isDuplicate(date, amount, desc, accountId);
    return { date, desc, amount, dateOk, amtOk, target, dup, include: dateOk && amtOk && !dup };
  });
  importRenderRows();
}

function importRowReady(r) { return r.include && r.target && r.dateOk && r.amtOk; }

function importRenderRows() {
  const rows = importState.rows;
  const acc = getAccount(importState.accountId);
  const body = rows.map((r, i) => {
    const need = r.include && !r.target;
    return `<tr>
      <td class="r"><input type="checkbox" id="imp-inc-${i}" ${r.include ? "checked" : ""} onchange="importToggle(${i})"></td>
      <td class="num ${r.dateOk ? "muted" : "bad"}">${esc(r.date) || "—"}</td>
      <td>${esc(r.desc) || "<span class='muted'>—</span>"}${r.dup ? ` <span class="badge-dup">duplicate</span>` : ""}</td>
      <td class="r num ${r.amtOk ? (r.amount < 0 ? "neg" : "pos") : "bad"}">${r.amtOk ? fmtMoney(r.amount) : "invalid"}</td>
      <td style="min-width:200px"><select id="imp-sel-${i}" class="imp-sel ${need ? "bad" : ""}" onchange="importSetTarget(${i},this.value)">${importTargetOptions(r.target, importState.accountId)}</select></td>
    </tr>`;
  }).join("");

  impModal(`
    <div class="modal-h"><h3>Assign &amp; review</h3><p>Each row needs a category or transfer so its entry balances. Duplicates are unchecked by default.</p></div>
    <div class="modal-b">
      <div class="imp-step">Step 3 of 3 · Into ${esc(acc.name)}</div>
      <div class="imp-scroll"><table>
        <thead><tr><th class="r" style="width:34px"></th><th style="width:104px">Date</th><th>Description</th><th class="r" style="width:120px">Amount</th><th style="width:210px">Category / Transfer</th></tr></thead>
        <tbody>${body || `<tr><td colspan="5" class="empty">Nothing to import.</td></tr>`}</tbody></table></div>
    </div>
    <div class="modal-f">
      <button class="btn ghost" onclick="importRenderMapping()">Back</button>
      <span class="imp-note" id="imp-note"></span>
      <button class="btn" id="imp-go" onclick="commitImport()">Import</button>
    </div>`);
  importUpdateFooter();
}

function importToggle(i) {
  importState.rows[i].include = $("imp-inc-" + i).checked;
  const sel = $("imp-sel-" + i);
  if (sel) sel.classList.toggle("bad", importState.rows[i].include && !importState.rows[i].target);
  importUpdateFooter();
}
function importSetTarget(i, val) {
  importState.rows[i].target = val;
  const sel = $("imp-sel-" + i);
  if (sel) sel.classList.toggle("bad", importState.rows[i].include && !val);
  importUpdateFooter();
}
function importUpdateFooter() {
  const rows = importState.rows;
  const ready = rows.filter(importRowReady).length;
  const blocked = rows.filter((r) => r.include && !importRowReady(r)).length;
  const go = $("imp-go"); const note = $("imp-note");
  if (go) { go.textContent = `Import ${ready} transaction${ready === 1 ? "" : "s"}`; go.disabled = ready === 0; }
  if (note) note.textContent = blocked
    ? `${blocked} checked row${blocked === 1 ? "" : "s"} still need a category/date/amount and will be skipped.`
    : (ready ? "" : "Check at least one row to import.");
}

function commitImport() {
  const rows = importState.rows.filter(importRowReady);
  if (!rows.length) return;
  for (const r of rows) {
    addBankTxn({ date: r.date, accountId: importState.accountId, payee: r.desc, target: r.target, amount: r.amount, memo: "", cleared: false });
  }
  const destId = importState.accountId;
  rebuild(); save(); closeModal();
  importState = null;
  view = { type: "account", id: destId };
  render();
}
