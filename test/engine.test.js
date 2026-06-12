/* Engine tests — run with: npm test   (or: node test/engine.test.js)
   Loads storage.js + engine.js + backup.js in a node context (no DOM
   needed) and asserts the core double-entry / FIFO invariants plus the
   Phase 0 export/import round-trip. The backup module's DOM-facing
   functions (exportData, openImportData, doImportData) are never called
   here, so the absence of window/document is fine. */
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function ok(name, cond) {
  cond ? (pass++, console.log("  ok  - " + name))
    : (fail++, console.log("  FAIL- " + name));
}

const src = fs.readFileSync(path.join(__dirname, "../www/src/storage.js"), "utf8")
  + "\n" + fs.readFileSync(path.join(__dirname, "../www/src/engine.js"), "utf8")
  + "\n" + fs.readFileSync(path.join(__dirname, "../www/src/backup.js"), "utf8");

const ctx = {};
src && (function () {
  // run in a function scope and capture the symbols we need via a trailing export
  const exposed = eval(src + `\n;({ seedDemo, state: () => state, cents, fmtMoney, netWorth,
      accountCash, accountMarketValue, getSecurity, balanceOfKey, rebuild,
      serializeState, exportEnvelope, readBackup, applyBackup });`);
  Object.assign(ctx, exposed);
})();

const { seedDemo, cents, netWorth, accountMarketValue, getSecurity, balanceOfKey, rebuild,
  serializeState, exportEnvelope, readBackup, applyBackup } = ctx;
seedDemo();
const state = ctx.state();

// 1. every transaction balances
let unbalanced = 0;
for (const t of state.transactions) {
  let s = 0; for (const p of (t.postings || [])) s += p.amount;
  if (Math.abs(cents(s)) > 0.005) unbalanced++;
}
ok("every transaction's postings sum to zero", unbalanced === 0);

// 2. global ledger balances
let g = 0; state.transactions.forEach(t => (t.postings || []).forEach(p => g += p.amount));
ok("global ledger sums to zero", Math.abs(cents(g)) < 0.005);

// 3. FIFO cost basis + realized gain on the seeded AAPL trades
const brk = state.accounts.find(a => a.type === "investment");
const aapl = state.securities.find(s => s.symbol === "AAPL");
const pos = state._holdings[brk.id][aapl.id];
ok("AAPL remaining shares = 9", Math.abs(pos.shares - 9) < 1e-9);
ok("AAPL FIFO cost basis = 1701.93", cents(pos.costBasis) === 1701.93);
ok("AAPL realized gain = 172.08", cents(pos.realized) === 172.08);

// ---- Phase 0: export / import round-trip --------------------------------
// Re-seed to a known-good state and grab a FRESH reference (seedDemo()
// reassigns the global `state`, so the earlier local would go stale).
seedDemo();
const st = ctx.state();
const nwBefore = netWorth();
const txnBefore = st.transactions.length;
const acctBefore = st.accounts.length;
const secBefore = st.securities.length;

// 4. envelope has app + schema + state and a serialized (derived-stripped) ledger
const env = exportEnvelope();
ok("export envelope is tagged app=LedgerWell, schema=1", env.app === "LedgerWell" && env.schema === 1);
ok("export envelope carries a state object", env.state && Array.isArray(env.state.transactions));
ok("export strips derived investment postings",
  env.state.transactions.filter(t => t.inv && t.inv.action !== "Div").every(t => t.postings === undefined));

// 5. a full export -> readBackup -> applyBackup restores everything
const res = readBackup(JSON.stringify(env));
ok("readBackup accepts a valid envelope", res.ok === true);
ok("readBackup summary counts match source",
  res.ok && res.summary.transactions === txnBefore
  && res.summary.accounts === acctBefore
  && res.summary.securities === secBefore);
ok("readBackup does not mutate live state before commit", ctx.state() === st);

if (res.ok) applyBackup(res.state);
const restored = ctx.state();
let gr = 0; restored.transactions.forEach(t => (t.postings || []).forEach(p => gr += p.amount));
ok("restored ledger still sums to zero", Math.abs(cents(gr)) < 0.005);
ok("restored net worth matches the original", Math.abs(netWorth() - nwBefore) < 0.005);
// FIFO basis survives the round-trip (postings were re-derived from raw inv inputs)
const brk2 = restored.accounts.find(a => a.type === "investment");
const aapl2 = restored.securities.find(s => s.symbol === "AAPL");
const pos2 = restored._holdings[brk2.id][aapl2.id];
ok("restored AAPL cost basis = 1701.93", cents(pos2.costBasis) === 1701.93);
ok("restored AAPL realized gain = 172.08", cents(pos2.realized) === 172.08);

// 6. a bare state object (no envelope) is also accepted
const bare = readBackup(JSON.stringify(serializeState()));
ok("readBackup accepts a bare state object (no envelope)", bare.ok === true);

// 7. malformed input is rejected, and rejection leaves live state untouched
const liveRef = ctx.state();
ok("readBackup rejects non-JSON", readBackup("definitely not json").ok === false);
ok("readBackup rejects a non-object", readBackup("42").ok === false);
ok("readBackup rejects wrong-typed fields", readBackup('{"accounts":"nope"}').ok === false);
ok("rejected reads do not swap out live state", ctx.state() === liveRef);

// 8. an unbalanced ledger is caught and refused
const broken = exportEnvelope();
broken.state.transactions.push({
  id: "txn_bad", date: "2025-06-02", payee: "Corrupt", seq: 999999,
  postings: [{ key: "acc:" + brk2.id, amount: 100 }, { key: "sys:opening", amount: -90 }],
});
const badRes = readBackup(JSON.stringify(broken));
ok("readBackup refuses an unbalanced ledger", badRes.ok === false);

// 9. deleting a transaction keeps the ledger balanced after rebuild
seedDemo();
const st3 = ctx.state();
const firstBuy = st3.transactions.find(t => t.inv && t.inv.action === "Buy");
st3.transactions = st3.transactions.filter(t => t.id !== firstBuy.id);
rebuild();
let g2 = 0; st3.transactions.forEach(t => (t.postings || []).forEach(p => g2 += p.amount));
ok("ledger still balanced after deleting a buy", Math.abs(cents(g2)) < 0.005);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
