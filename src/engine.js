/* ============================================================
   engine.js — double-entry ledger engine
   Invariant: every transaction's postings sum to zero.
   Depends on storage.js (KEY, storeGet, storeSet) loaded first.
   ============================================================ */

/* ---------- helpers ---------- */
const cents = (x) => Math.round((Number(x) + Number.EPSILON) * 100) / 100;
const round6 = (x) => Math.round((Number(x) + Number.EPSILON) * 1e6) / 1e6;
let _seq = 1;
const uid = (p) => p + "_" + Date.now().toString(36) + "_" + (_seq++).toString(36) + Math.random().toString(36).slice(2, 6);
const todayISO = () => new Date().toISOString().slice(0, 10);
const fmtMoney = (n) => {
  const v = cents(n || 0);
  const s = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (v < 0 ? "-$" : "$") + s;
};
const fmtShares = (n) => Number(round6(n || 0)).toLocaleString("en-US", { maximumFractionDigits: 6 });
const fmtPct = (n) => (n >= 0 ? "+" : "") + (n).toFixed(2) + "%";
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ---------- account type metadata ---------- */
const ACCT_TYPES = {
  checking:   { label: "Checking",   group: "Banking",     kind: "asset" },
  savings:    { label: "Savings",    group: "Banking",     kind: "asset" },
  cash:       { label: "Cash",       group: "Banking",     kind: "asset" },
  credit:     { label: "Credit Card",group: "Credit",      kind: "liability" },
  investment: { label: "Investment", group: "Investments", kind: "asset" },
};
const GROUP_ORDER = ["Banking", "Credit", "Investments"];

/* built-in categories that the engine relies on */
const DIV_CAT_ID = "cat_dividend";
const INT_CAT_ID = "cat_interest";

/* ---------- state ---------- */
let state = null;
let view = { type: "dashboard" };
let openTxn = null; // txn id whose detail is expanded

function blankState() {
  return {
    accounts: [],
    categories: [
      { id: "cat_salary",   name: "Salary",        type: "income" },
      { id: DIV_CAT_ID,     name: "Dividend Income",type: "income" },
      { id: INT_CAT_ID,     name: "Interest Income",type: "income" },
      { id: "cat_groceries",name: "Groceries",     type: "expense" },
      { id: "cat_dining",   name: "Dining Out",    type: "expense" },
      { id: "cat_rent",     name: "Rent",          type: "expense" },
      { id: "cat_utilities",name: "Utilities",     type: "expense" },
      { id: "cat_transport",name: "Transportation",type: "expense" },
    ],
    securities: [],
    transactions: [],
    seq: 1,
  };
}

/* ---------- seed demo data ---------- */
function seedDemo() {
  state = blankState();
  const chk = addAccount("Everyday Checking", "checking", 0, null, true);
  const sav = addAccount("Emergency Savings", "savings", 0, null, true);
  const cc  = addAccount("Rewards Card", "credit", 0, null, true);
  const brk = addAccount("Brokerage", "investment", 0, null, true);

  // securities
  const aapl = addSecurity("AAPL", "Apple Inc.", 212.5);
  const vt   = addSecurity("VTSAX", "Vanguard Total Stock Mkt", 128.4);

  // opening balances
  openingBalance(chk.id, 4200, "2025-01-01");
  openingBalance(sav.id, 12000, "2025-01-01");

  // some banking activity
  addBankTxn({ date: "2025-05-01", accountId: chk.id, payee: "Acme Payroll",   target: "cat:cat_salary",    amount: 3200, memo: "May salary" });
  addBankTxn({ date: "2025-05-02", accountId: chk.id, payee: "Whole Foods",     target: "cat:cat_groceries", amount: -142.18, memo: "" });
  addBankTxn({ date: "2025-05-03", accountId: chk.id, payee: "Landlord",        target: "cat:cat_rent",      amount: -1850, memo: "" });
  addBankTxn({ date: "2025-05-05", accountId: chk.id, payee: "Transfer to Savings", target: "acc:" + sav.id, amount: -500, memo: "auto-save" });
  addBankTxn({ date: "2025-05-08", accountId: cc.id,  payee: "Shell",           target: "cat:cat_transport", amount: -54.30, memo: "" });
  addBankTxn({ date: "2025-05-09", accountId: cc.id,  payee: "Trattoria",       target: "cat:cat_dining",    amount: -88.75, memo: "" });
  addBankTxn({ date: "2025-05-15", accountId: chk.id, payee: "Pay Rewards Card",target: "acc:" + cc.id,      amount: -143.05, memo: "" });

  // investing
  openingBalance(brk.id, 5000, "2025-01-01"); // opening cash
  buy(brk.id, aapl.id, "2025-02-10", 10, 180, 4.95);
  buy(brk.id, vt.id,   "2025-03-01", 30, 110, 0);
  buy(brk.id, aapl.id, "2025-04-15", 5, 195, 4.95);
  dividend(brk.id, aapl.id, "2025-05-20", 7.50);
  sell(brk.id, aapl.id, "2025-06-01", 6, 210, 4.95);
  rebuild();
}

/* ---------- mutations ---------- */
function nextSeq() { state.seq = (state.seq || 1) + 1; return state.seq; }

function addAccount(name, type, opening, openedDate, silent) {
  const a = { id: uid("acc"), name: name.trim(), type, opened: openedDate || todayISO() };
  state.accounts.push(a);
  if (opening && opening !== 0) openingBalance(a.id, Number(opening), a.opened);
  if (!silent) { rebuild(); save(); }
  return a;
}

function openingBalance(accId, amount, date) {
  const acc = getAccount(accId);
  const key = acc.type === "investment" ? "acc:" + accId + ":cash" : "acc:" + accId;
  state.transactions.push({
    id: uid("txn"), date: date || todayISO(), payee: "Opening Balance", memo: "", cleared: true,
    seq: nextSeq(),
    postings: [
      { key, amount: cents(amount) },
      { key: "sys:opening", amount: cents(-amount) },
    ],
  });
}

function addSecurity(symbol, name, price) {
  const s = { id: uid("sec"), symbol: symbol.trim().toUpperCase(), name: name.trim(), price: cents(price), priceDate: todayISO() };
  state.securities.push(s);
  return s;
}

function addCategory(name, type) {
  const c = { id: uid("cat"), name: name.trim(), type };
  state.categories.push(c);
  save(); return c;
}

/* Banking transaction. target is "cat:<id>" (category) or "acc:<id>" (transfer).
   amount > 0 = money IN to accountId; amount < 0 = money OUT. */
function addBankTxn({ date, accountId, payee, target, amount, memo, cleared }) {
  amount = cents(amount);
  const meKey = keyForAccount(accountId);
  let other;
  if (target.startsWith("acc:")) {
    const otherId = target.slice(4);
    other = { key: keyForAccount(otherId), amount: cents(-amount) };
  } else { // category
    other = { key: target, amount: cents(-amount) };
  }
  state.transactions.push({
    id: uid("txn"), date, payee: (payee || "").trim(), memo: (memo || "").trim(),
    cleared: !!cleared, seq: nextSeq(),
    postings: [{ key: meKey, amount }, other],
  });
}

function keyForAccount(accId) {
  const a = getAccount(accId);
  return a.type === "investment" ? "acc:" + accId + ":cash" : "acc:" + accId;
}

/* investment transactions store raw inputs; postings are materialized in rebuild() */
function buy(accId, secId, date, shares, price, fee) {
  state.transactions.push({
    id: uid("txn"), date, payee: "", memo: "", cleared: true, seq: nextSeq(),
    inv: { action: "Buy", accountId: accId, securityId: secId, shares: round6(shares), price: cents(price), fee: cents(fee || 0) },
  });
}
function sell(accId, secId, date, shares, price, fee) {
  state.transactions.push({
    id: uid("txn"), date, payee: "", memo: "", cleared: true, seq: nextSeq(),
    inv: { action: "Sell", accountId: accId, securityId: secId, shares: round6(shares), price: cents(price), fee: cents(fee || 0) },
  });
}
function dividend(accId, secId, date, amount) {
  state.transactions.push({
    id: uid("txn"), date, payee: "", memo: "", cleared: true, seq: nextSeq(),
    inv: { action: "Div", accountId: accId, securityId: secId, amount: cents(amount) },
  });
}

function deleteTxn(id) {
  const t = state.transactions.find((x) => x.id === id);
  if (t && t.payee === "Opening Balance") { /* allow */ }
  state.transactions = state.transactions.filter((x) => x.id !== id);
  rebuild(); save(); render();
}

/* ---------- derived rebuild (lots, holdings, investment postings) ---------- */
function rebuild() {
  state._lots = {};      // "accId|secId" -> [{remaining, costRemaining}]
  state._holdings = {};  // accId -> { secId: {shares, costBasis, realized} }

  const byDateSeq = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.seq || 0) - (b.seq || 0));
  const invTxns = state.transactions.filter((t) => t.inv).sort(byDateSeq);

  const ensureH = (acc, sec) => {
    if (!state._holdings[acc]) state._holdings[acc] = {};
    if (!state._holdings[acc][sec]) state._holdings[acc][sec] = { shares: 0, costBasis: 0, realized: 0 };
    return state._holdings[acc][sec];
  };

  for (const t of invTxns) {
    const inv = t.inv;
    const cashKey = "acc:" + inv.accountId + ":cash";
    const secKey = "acc:" + inv.accountId + ":sec";
    const lk = inv.accountId + "|" + inv.securityId;
    if (!state._lots[lk]) state._lots[lk] = [];
    const h = ensureH(inv.accountId, inv.securityId);

    if (inv.action === "Buy") {
      const cost = cents(inv.shares * inv.price + inv.fee);
      state._lots[lk].push({ remaining: inv.shares, costRemaining: cost });
      h.shares = round6(h.shares + inv.shares);
      h.costBasis = cents(h.costBasis + cost);
      t.postings = [{ key: cashKey, amount: cents(-cost) }, { key: secKey, amount: cost }];
      inv._cost = cost;
    } else if (inv.action === "Sell") {
      let toSell = inv.shares, costRelieved = 0;
      for (const lot of state._lots[lk]) {
        if (toSell <= 1e-9) break;
        if (lot.remaining <= 1e-9) continue;
        const take = Math.min(lot.remaining, toSell);
        const full = take >= lot.remaining - 1e-9;
        const removedCost = full ? lot.costRemaining : cents(lot.costRemaining * (take / lot.remaining));
        lot.costRemaining = cents(lot.costRemaining - removedCost);
        lot.remaining = round6(lot.remaining - take);
        costRelieved = cents(costRelieved + removedCost);
        toSell = round6(toSell - take);
      }
      const proceeds = cents(inv.shares * inv.price - inv.fee);
      const gain = cents(proceeds - costRelieved);
      h.shares = round6(h.shares - inv.shares);
      h.costBasis = cents(h.costBasis - costRelieved);
      h.realized = cents(h.realized + gain);
      t.postings = [
        { key: cashKey, amount: proceeds },
        { key: secKey, amount: cents(-costRelieved) },
        { key: "sys:realized", amount: cents(-gain) },
      ];
      inv._proceeds = proceeds; inv._costRelieved = costRelieved; inv._gain = gain;
    } else if (inv.action === "Div") {
      const amt = cents(inv.amount);
      t.postings = [{ key: cashKey, amount: amt }, { key: "cat:" + DIV_CAT_ID, amount: cents(-amt) }];
    }
  }
}

/* ---------- lookups ---------- */
const getAccount = (id) => state.accounts.find((a) => a.id === id);
const getCategory = (id) => state.categories.find((c) => c.id === id);
const getSecurity = (id) => state.securities.find((s) => s.id === id);

function balanceOfKey(key, from, to) {
  let sum = 0;
  for (const t of state.transactions) {
    if (from && t.date < from) continue;
    if (to && t.date > to) continue;
    for (const p of (t.postings || [])) if (p.key === key) sum += p.amount;
  }
  return cents(sum);
}

function accountCash(acc) {
  return acc.type === "investment" ? balanceOfKey("acc:" + acc.id + ":cash") : balanceOfKey("acc:" + acc.id);
}
function accountMarketValue(acc) {
  if (acc.type !== "investment") return 0;
  const h = state._holdings[acc.id] || {};
  let mv = 0;
  for (const secId in h) { const s = getSecurity(secId); if (s) mv += h[secId].shares * s.price; }
  return cents(mv);
}
function accountValue(acc) {
  return acc.type === "investment" ? cents(accountCash(acc) + accountMarketValue(acc)) : accountCash(acc);
}
function netWorth() {
  return cents(state.accounts.reduce((s, a) => s + accountValue(a), 0));
}

/* transactions affecting an account, ordered, with running balance */
function registerRows(acc) {
  const key = acc.type === "investment" ? "acc:" + acc.id + ":cash" : "acc:" + acc.id;
  const rows = state.transactions
    .filter((t) => (t.postings || []).some((p) => p.key === key))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.seq || 0) - (b.seq || 0)));
  let run = 0;
  return rows.map((t) => {
    const amt = (t.postings.find((p) => p.key === key) || {}).amount || 0;
    run = cents(run + amt);
    return { t, amount: amt, balance: run };
  });
}

/* describe the "other side" of a 2-posting banking txn, for the Category column */
function targetLabel(t, selfKey) {
  if (t.inv) return t.inv.action === "Div" ? "Dividend" : t.inv.action;
  const other = (t.postings || []).find((p) => p.key !== selfKey);
  if (!other) return "";
  if (other.key.startsWith("cat:")) { const c = getCategory(other.key.slice(4)); return c ? c.name : "(category)"; }
  if (other.key.startsWith("acc:")) {
    const id = other.key.slice(4).replace(/:cash$/, "");
    const a = getAccount(id); return a ? "→ " + a.name : "(transfer)";
  }
  if (other.key === "sys:opening") return "Opening Balance";
  return other.key;
}

/* ---------- save / load ---------- */
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const clean = { accounts: state.accounts, categories: state.categories, securities: state.securities, transactions: state.transactions.map(stripDerived), seq: state.seq };
    storeSet(KEY, JSON.stringify(clean));
  }, 200);
}
function stripDerived(t) {
  const c = { ...t };
  if (c.inv) { c.inv = { ...c.inv }; delete c.inv._cost; delete c.inv._proceeds; delete c.inv._costRelieved; delete c.inv._gain;
    if (c.inv.action !== "Div") delete c.postings; } // investment postings are re-derived
  return c;
}

async function load() {
  const raw = await storeGet(KEY);
  if (!raw) { seedDemo(); save(); return; }
  try {
    const parsed = JSON.parse(raw);
    state = Object.assign(blankState(), parsed);
    // ensure built-in categories exist
    for (const bc of [{ id: DIV_CAT_ID, name: "Dividend Income", type: "income" }, { id: INT_CAT_ID, name: "Interest Income", type: "income" }]) {
      if (!state.categories.find((c) => c.id === bc.id)) state.categories.push(bc);
    }
    rebuild();
  } catch (e) { console.error("load failed, seeding", e); seedDemo(); save(); }
}

