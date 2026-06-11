/* Engine tests — run with: npm test   (or: node test/engine.test.js)
   Loads storage.js + engine.js in a node context (no DOM needed) and
   asserts the core double-entry and FIFO invariants. */
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function ok(name, cond) { cond ? (pass++, console.log("  ok  - " + name))
                               : (fail++, console.log("  FAIL- " + name)); }

const src = fs.readFileSync(path.join(__dirname, "../src/storage.js"), "utf8")
          + "\n" + fs.readFileSync(path.join(__dirname, "../src/engine.js"), "utf8");

const ctx = {};
src && (function () {
  // run in a function scope and capture the symbols we need via a trailing export
  const exposed = eval(src + `\n;({ seedDemo, state: () => state, cents, fmtMoney, netWorth,
      accountCash, accountMarketValue, getSecurity, balanceOfKey, rebuild });`);
  Object.assign(ctx, exposed);
})();

const { seedDemo, cents, netWorth, accountMarketValue, getSecurity, balanceOfKey, rebuild } = ctx;
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

// 4. deleting a transaction keeps the ledger balanced after rebuild
const firstBuy = state.transactions.find(t => t.inv && t.inv.action === "Buy");
state.transactions = state.transactions.filter(t => t.id !== firstBuy.id);
rebuild();
let g2 = 0; state.transactions.forEach(t => (t.postings || []).forEach(p => g2 += p.amount));
ok("ledger still balanced after deleting a buy", Math.abs(cents(g2)) < 0.005);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
