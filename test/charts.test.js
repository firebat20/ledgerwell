/* Charts & portfolio history tests — run with: node test/charts.test.js
   Loads storage, engine, price-provider, price-store, and charts in a node context
   and asserts portfolio history and gains computation correctness. */
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function ok(name, cond) {
  cond ? (pass++, console.log("  ok  - " + name))
    : (fail++, console.log("  FAIL- " + name));
}

const src = fs.readFileSync(path.join(__dirname, "../www/src/storage.js"), "utf8")
  + "\n" + fs.readFileSync(path.join(__dirname, "../www/src/engine.js"), "utf8")
  + "\n" + fs.readFileSync(path.join(__dirname, "../www/src/price-provider.js"), "utf8")
  + "\n" + fs.readFileSync(path.join(__dirname, "../www/src/price-store.js"), "utf8")
  + "\n" + fs.readFileSync(path.join(__dirname, "../www/src/charts.js"), "utf8");

const ctx = {};
src && (function () {
  const exposed = eval(src + `\n;({
    seedDemo,
    state: () => state,
    cents,
    rebuild,
    MemoryPriceStore,
    getPriceStore,
    computePortfolioHistory,
    priceKeyForSecurity
  });`);
  Object.assign(ctx, exposed);
})();

const { seedDemo, cents, rebuild, MemoryPriceStore, getPriceStore, computePortfolioHistory, priceKeyForSecurity } = ctx;

async function runTests() {
  // Re-seed demo data which sets up an investment account, AAPL security, and transactions.
  seedDemo();
  const state = ctx.state();

  const store = getPriceStore();
  ok("price store is a MemoryPriceStore in testing", store && typeof store.upsert === "function");

  // Add sample historical prices for AAPL and MSFT
  const aaplSec = state.securities.find(s => s.symbol === "AAPL");
  const msftSec = state.securities.find(s => s.symbol === "MSFT");
  const aaplKey = priceKeyForSecurity(aaplSec);
  const msftKey = priceKeyForSecurity(msftSec);

  // Insert daily closes for range: 2025-06-01 to 2025-06-05
  await store.upsert(aaplKey, [
    { date: "2025-06-01", close: 170 },
    { date: "2025-06-02", close: 172 },
    { date: "2025-06-03", close: 175 },
    { date: "2025-06-04", close: 174 },
    { date: "2025-06-05", close: 180 }
  ]);

  if (msftSec) {
    await store.upsert(msftKey, [
      { date: "2025-06-01", close: 320 },
      { date: "2025-06-02", close: 322 },
      { date: "2025-06-03", close: 325 },
      { date: "2025-06-04", close: 324 },
      { date: "2025-06-05", close: 330 }
    ]);
  }

  // Run portfolio history computation
  const history = await computePortfolioHistory("2025-06-01", "2025-06-05");

  ok("history output is an array", Array.isArray(history));
  ok("history has correct number of days", history.length === 5);

  // Check structure and values of a single day
  const day3 = history.find(h => h.date === "2025-06-03");
  ok("snapshot date 2025-06-03 exists", !!day3);
  if (day3) {
    ok("snapshot has cash", typeof day3.cash === "number");
    ok("snapshot has marketValue", typeof day3.marketValue === "number");
    ok("snapshot has costBasis", typeof day3.costBasis === "number");
    ok("snapshot has totalValue", day3.totalValue === cents(day3.cash + day3.marketValue));
    ok("snapshot has unrealized gain/loss", day3.unrealized === cents(day3.marketValue - day3.costBasis));
    ok("snapshot has realized gain/loss", typeof day3.realized === "number");
    ok("snapshot has holdings map", day3.holdings && typeof day3.holdings === "object");
  }

  console.log(`\nCharts tests: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

runTests().catch(e => {
  console.error("Test execution failed", e);
  process.exit(1);
});
