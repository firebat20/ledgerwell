/* ============================================================
   charts.js — Phase 5 of docs/MIGRATION.md
   A self-contained, plain-globals module (load AFTER price-store.js).

   Responsibilities:
     1. computePortfolioHistory()  — replay transactions against stored
        daily prices to produce [{date, totalValue, cash, marketValue,
        costBasis, unrealized, realized, holdings:{secId:{shares,value}}}]
     2. Inline SVG chart renderer  — full-width area/line charts with
        axes, gridlines, hover tooltip. Zero external dependencies.
     3. viewReports()              — the Reports view HTML + wiring.

   Reuses globals:
     engine.js      — state, getSecurity, cents, round6, fmtMoney,
                       fmtShares, fmtPct, esc, todayISO, balanceOfKey,
                       accountCash, ACCT_TYPES
     price-store.js — getPriceStore, priceKeyForSecurity
     ui.js          — nav, render, sgn
   ============================================================ */

/* ---- date helpers ---- */
const _ch_isoDaysAgo = (n) => {
  const d = new Date(); d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};
const _ch_addDay = (iso) => {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};
const _ch_ytdStart = () => {
  const d = new Date();
  return d.getFullYear() + "-01-01";
};

/* ---- range presets ---- */
const RANGE_PRESETS = [
  { label: "1M",  days: 30 },
  { label: "3M",  days: 91 },
  { label: "6M",  days: 183 },
  { label: "YTD", fn: () => _ch_ytdStart() },
  { label: "1Y",  days: 365 },
  { label: "All", days: 5 * 366 },
];

let _chartRange = "1Y";
let _chartTab   = "portfolio"; // portfolio | holdings | gains

/* ================================================================
   computePortfolioHistory(fromISO, toISO)
   Produces daily snapshots of portfolio state by:
     1. Fetching stored price rows for every security.
     2. Building a date→{close} lookup per security.
     3. Replaying transactions in date order, accumulating:
          - cash balance per investment account
          - share counts per (account, security)
     4. At each calendar date in the range where at least one price
        exists, computing market value = Σ(shares × close) + cash.
   Returns: [{date, totalValue, cash, marketValue, costBasis,
              unrealized, realized, holdings:{secId:{shares,value,cost}}}]
   ================================================================ */
async function computePortfolioHistory(fromISO, toISO) {
  const store = (typeof getPriceStore === "function") ? getPriceStore() : null;
  if (!store || !state || !Array.isArray(state.securities)) return [];

  // 1. Gather all price rows in range keyed by security id
  const priceMap = {}; // secId -> Map(date -> close)
  const allDatesSet = new Set();
  for (const sec of state.securities) {
    const key = (typeof priceKeyForSecurity === "function") ? priceKeyForSecurity(sec) : "";
    if (!key) continue;
    let rows = [];
    try { rows = await store.range(key, fromISO, toISO); } catch (e) { continue; }
    const m = new Map();
    for (const r of rows) { m.set(r.date, Number(r.close)); allDatesSet.add(r.date); }
    priceMap[sec.id] = m;
  }

  const allDates = [...allDatesSet].sort();
  if (!allDates.length) return [];

  // 2. Replay transactions sorted by date to track cumulative state
  const byDateSeq = (a, b) =>
    (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.seq || 0) - (b.seq || 0));
  const allTxns = [...state.transactions].sort(byDateSeq);

  // State accumulators
  const cashByAcct = {};  // accId -> running cash
  const sharesByAcctSec = {}; // "accId|secId" -> {shares, costBasis}
  let cumulativeRealized = 0;
  const invAcctIds = new Set(
    state.accounts.filter((a) => a.type === "investment").map((a) => a.id)
  );

  // Track which transactions have been applied
  let txnIdx = 0;

  const applyTxnsUpTo = (date) => {
    while (txnIdx < allTxns.length && allTxns[txnIdx].date <= date) {
      const t = allTxns[txnIdx];
      txnIdx++;

      if (t.inv) {
        const inv = t.inv;
        if (!invAcctIds.has(inv.accountId) && inv.action !== "Split") continue;

        const lk = inv.accountId + "|" + inv.securityId;
        if (!sharesByAcctSec[lk]) sharesByAcctSec[lk] = { shares: 0, costBasis: 0 };
        if (!cashByAcct[inv.accountId]) cashByAcct[inv.accountId] = 0;

        if (inv.action === "Buy") {
          const cost = cents(inv.shares * inv.price + (inv.fee || 0));
          sharesByAcctSec[lk].shares = round6(sharesByAcctSec[lk].shares + inv.shares);
          sharesByAcctSec[lk].costBasis = cents(sharesByAcctSec[lk].costBasis + cost);
          cashByAcct[inv.accountId] = cents(cashByAcct[inv.accountId] - cost);
        } else if (inv.action === "Sell") {
          const cb = sharesByAcctSec[lk].costBasis;
          const prevShares = sharesByAcctSec[lk].shares;
          const fraction = prevShares > 1e-9 ? inv.shares / prevShares : 1;
          const costRelieved = cents(cb * Math.min(fraction, 1));
          const proceeds = cents(inv.shares * inv.price - (inv.fee || 0));
          sharesByAcctSec[lk].shares = round6(prevShares - inv.shares);
          sharesByAcctSec[lk].costBasis = cents(cb - costRelieved);
          cashByAcct[inv.accountId] = cents(cashByAcct[inv.accountId] + proceeds);
          cumulativeRealized = cents(cumulativeRealized + (proceeds - costRelieved));
        } else if (inv.action === "Div") {
          const amt = cents(inv.amount);
          cashByAcct[inv.accountId] = cents(cashByAcct[inv.accountId] + amt);
        } else if (inv.action === "Split") {
          const r = Number(inv.ratio) || 1;
          if (r > 0 && r !== 1) {
            for (const key of Object.keys(sharesByAcctSec)) {
              if (key.endsWith("|" + inv.securityId)) {
                sharesByAcctSec[key].shares = round6(sharesByAcctSec[key].shares * r);
              }
            }
          }
        }
      } else if (t.postings) {
        // Non-investment postings that affect investment cash
        for (const p of t.postings) {
          const m = p.key.match(/^acc:(.+?):cash$/);
          if (m && invAcctIds.has(m[1])) {
            if (!cashByAcct[m[1]]) cashByAcct[m[1]] = 0;
            cashByAcct[m[1]] = cents(cashByAcct[m[1]] + p.amount);
          }
        }
      }
    }
  };

  // 3. Walk dates and produce snapshots
  const snapshots = [];
  for (const date of allDates) {
    if (date < fromISO) continue;
    applyTxnsUpTo(date);

    let totalCash = 0, totalMv = 0, totalCb = 0;
    const holdings = {};

    for (const accId of invAcctIds) {
      totalCash += cashByAcct[accId] || 0;
    }

    for (const key of Object.keys(sharesByAcctSec)) {
      const pos = sharesByAcctSec[key];
      if (pos.shares < 1e-9) continue;
      const secId = key.split("|")[1];
      const pm = priceMap[secId];
      if (!pm) continue;
      // Use the closest available price on or before this date
      let close = pm.get(date);
      if (close == null) {
        // Find latest price ≤ date
        for (const d of [...pm.keys()].sort().reverse()) {
          if (d <= date) { close = pm.get(d); break; }
        }
      }
      if (close == null) continue;

      const mv = cents(pos.shares * close);
      totalMv += mv;
      totalCb += pos.costBasis;

      if (!holdings[secId]) holdings[secId] = { shares: 0, value: 0, cost: 0 };
      holdings[secId].shares = round6(holdings[secId].shares + pos.shares);
      holdings[secId].value = cents(holdings[secId].value + mv);
      holdings[secId].cost = cents(holdings[secId].cost + pos.costBasis);
    }

    totalCash = cents(totalCash);
    totalMv = cents(totalMv);
    totalCb = cents(totalCb);

    snapshots.push({
      date,
      totalValue: cents(totalCash + totalMv),
      cash: totalCash,
      marketValue: totalMv,
      costBasis: totalCb,
      unrealized: cents(totalMv - totalCb),
      realized: cents(cumulativeRealized),
      holdings,
    });
  }

  return snapshots;
}

/* ================================================================
   SVG Chart Renderer — inline, no dependencies
   ================================================================ */
const CHART_COLORS = [
  "#0E6B61", "#1FB39F", "#3B82F6", "#8B5CF6",
  "#EC4899", "#F59E0B", "#10B981", "#6366F1",
  "#EF4444", "#14B8A6", "#F97316", "#06B6D4",
];

function _ch_fmtAxisMoney(n) {
  const abs = Math.abs(n);
  if (abs >= 1e6) return (n < 0 ? "-" : "") + "$" + (abs / 1e6).toFixed(1) + "M";
  if (abs >= 1e3) return (n < 0 ? "-" : "") + "$" + (abs / 1e3).toFixed(0) + "k";
  return (n < 0 ? "-$" : "$") + abs.toFixed(0);
}

function _ch_fmtDate(iso) {
  const [y, m, d] = iso.split("-");
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return months[parseInt(m, 10) - 1] + " " + parseInt(d, 10);
}

function _ch_fmtDateFull(iso) {
  const [y, m, d] = iso.split("-");
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return months[parseInt(m, 10) - 1] + " " + parseInt(d, 10) + ", " + y;
}

/**
 * renderLineChart(containerId, { series, dates, options })
 *  series: [{ label, values:[], color, fill? }]  — values aligned to dates[]
 *  options: { height, yLabel, formatY, showArea, showTooltip }
 */
function renderLineChart(containerId, config) {
  const el = document.getElementById(containerId);
  if (!el) return;

  const { series, dates, options = {} } = config;
  if (!dates || !dates.length || !series || !series.length) {
    el.innerHTML = `<div class="chart-empty">No data for the selected range.</div>`;
    return;
  }

  const W = el.clientWidth || 720;
  const H = options.height || 280;
  const PAD = { top: 20, right: 24, bottom: 40, left: 70 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  // Compute Y bounds across all series
  let yMin = Infinity, yMax = -Infinity;
  for (const s of series) {
    for (const v of s.values) {
      if (v != null && isFinite(v)) {
        if (v < yMin) yMin = v;
        if (v > yMax) yMax = v;
      }
    }
  }
  if (!isFinite(yMin)) { yMin = 0; yMax = 100; }
  if (yMin === yMax) { yMin -= 1; yMax += 1; }
  // Add 5% padding
  const yRange = yMax - yMin;
  yMin = yMin - yRange * 0.05;
  yMax = yMax + yRange * 0.05;

  const n = dates.length;
  const xOf = (i) => PAD.left + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const yOf = (v) => PAD.top + plotH - ((v - yMin) / (yMax - yMin)) * plotH;
  const formatY = options.formatY || _ch_fmtAxisMoney;

  // Y axis gridlines + labels
  const yTicks = 5;
  let gridSvg = "";
  for (let i = 0; i <= yTicks; i++) {
    const v = yMin + (i / yTicks) * (yMax - yMin);
    const y = yOf(v);
    gridSvg += `<line x1="${PAD.left}" y1="${y.toFixed(1)}" x2="${W - PAD.right}" y2="${y.toFixed(1)}" stroke="var(--line)" stroke-width="0.5"/>`;
    gridSvg += `<text x="${PAD.left - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" fill="var(--muted)" font-size="10" font-family="IBM Plex Mono, monospace">${formatY(v)}</text>`;
  }

  // X axis labels — pick ~6 evenly spaced dates
  const xLabelCount = Math.min(n, 6);
  let xLabelsSvg = "";
  for (let i = 0; i < xLabelCount; i++) {
    const idx = xLabelCount === 1 ? 0 : Math.round(i * (n - 1) / (xLabelCount - 1));
    const x = xOf(idx);
    xLabelsSvg += `<text x="${x.toFixed(1)}" y="${H - 6}" text-anchor="middle" fill="var(--muted)" font-size="10" font-family="IBM Plex Mono, monospace">${_ch_fmtDate(dates[idx])}</text>`;
  }

  // Draw series
  let seriesSvg = "";
  for (const s of series) {
    const points = [];
    for (let i = 0; i < n; i++) {
      if (s.values[i] != null && isFinite(s.values[i])) {
        points.push({ i, x: xOf(i), y: yOf(s.values[i]) });
      }
    }
    if (!points.length) continue;

    const pathD = points.map((p, idx) => `${idx ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");

    if (s.fill) {
      const first = points[0], last = points[points.length - 1];
      const fillD = pathD +
        ` L${last.x.toFixed(1)} ${yOf(yMin).toFixed(1)}` +
        ` L${first.x.toFixed(1)} ${yOf(yMin).toFixed(1)} Z`;
      seriesSvg += `<path d="${fillD}" fill="${s.color}" opacity="0.08"/>`;
    }

    seriesSvg += `<path d="${pathD}" fill="none" stroke="${s.color}" stroke-width="${s.strokeWidth || 2}" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`;
  }

  // Tooltip overlay (invisible rect that captures mouse events)
  const tooltipId = containerId + "-tip";
  const lineId = containerId + "-line";
  const dotGroupId = containerId + "-dots";

  const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="display:block" xmlns="http://www.w3.org/2000/svg">
    ${gridSvg}
    ${xLabelsSvg}
    <!-- plot border -->
    <line x1="${PAD.left}" y1="${PAD.top}" x2="${PAD.left}" y2="${PAD.top + plotH}" stroke="var(--line-strong)" stroke-width="1"/>
    <line x1="${PAD.left}" y1="${PAD.top + plotH}" x2="${W - PAD.right}" y2="${PAD.top + plotH}" stroke="var(--line-strong)" stroke-width="1"/>
    ${seriesSvg}
    <!-- tooltip crosshair -->
    <line id="${lineId}" x1="0" y1="${PAD.top}" x2="0" y2="${PAD.top + plotH}" stroke="var(--muted)" stroke-width="0.5" stroke-dasharray="3,3" visibility="hidden"/>
    <g id="${dotGroupId}"></g>
    <!-- invisible overlay for mouse tracking -->
    <rect x="${PAD.left}" y="${PAD.top}" width="${plotW}" height="${plotH}" fill="transparent" style="cursor:crosshair"
      onmousemove="chartTooltip(event,'${containerId}',${n},${PAD.left},${plotW})"
      onmouseleave="chartTooltipHide('${containerId}')"/>
  </svg>
  <div id="${tooltipId}" class="chart-tooltip" style="display:none"></div>`;

  el.innerHTML = svg;

  // Stash chart data on the element for tooltip lookup
  el._chartData = { series, dates, n, padLeft: PAD.left, plotW, plotH, padTop: PAD.top, yMin, yMax, formatY, xOf, yOf };
}

/* Tooltip handlers (called from inline event attributes on the SVG overlay) */
function chartTooltip(event, containerId, n, padLeft, plotW) {
  const el = document.getElementById(containerId);
  if (!el || !el._chartData) return;
  const cd = el._chartData;
  const rect = el.querySelector("svg").getBoundingClientRect();
  const mouseX = event.clientX - rect.left;

  // Find nearest data index
  let idx = Math.round(((mouseX - padLeft) / plotW) * (n - 1));
  idx = Math.max(0, Math.min(n - 1, idx));

  const snapX = cd.xOf(idx);

  // Update crosshair line
  const line = document.getElementById(containerId + "-line");
  if (line) { line.setAttribute("x1", snapX.toFixed(1)); line.setAttribute("x2", snapX.toFixed(1)); line.setAttribute("visibility", "visible"); }

  // Update dots
  const dotGroup = document.getElementById(containerId + "-dots");
  if (dotGroup) {
    let dotsHtml = "";
    for (const s of cd.series) {
      const v = s.values[idx];
      if (v != null && isFinite(v)) {
        const y = cd.yOf(v);
        dotsHtml += `<circle cx="${snapX.toFixed(1)}" cy="${y.toFixed(1)}" r="4" fill="${s.color}" stroke="var(--surface)" stroke-width="2"/>`;
      }
    }
    dotGroup.innerHTML = dotsHtml;
  }

  // Update tooltip box
  const tip = document.getElementById(containerId + "-tip");
  if (tip) {
    const date = cd.dates[idx];
    let html = `<div class="chart-tip-date">${_ch_fmtDateFull(date)}</div>`;
    for (const s of cd.series) {
      const v = s.values[idx];
      if (v != null && isFinite(v)) {
        html += `<div class="chart-tip-row"><span class="chart-tip-dot" style="background:${s.color}"></span>${esc(s.label)}: <strong class="num">${cd.formatY(v)}</strong></div>`;
      }
    }
    tip.innerHTML = html;
    tip.style.display = "block";

    // Position tooltip
    const tipW = tip.offsetWidth || 180;
    let left = snapX + 12;
    if (left + tipW > el.clientWidth - 10) left = snapX - tipW - 12;
    tip.style.left = Math.max(0, left) + "px";
    tip.style.top = (cd.padTop + 8) + "px";
  }
}

function chartTooltipHide(containerId) {
  const line = document.getElementById(containerId + "-line");
  if (line) line.setAttribute("visibility", "hidden");
  const dots = document.getElementById(containerId + "-dots");
  if (dots) dots.innerHTML = "";
  const tip = document.getElementById(containerId + "-tip");
  if (tip) tip.style.display = "none";
}

/* ================================================================
   Reports View
   ================================================================ */
let _reportData = null;  // cached computation result
let _reportLoading = false;

function _rangeFrom() {
  const p = RANGE_PRESETS.find((r) => r.label === _chartRange) || RANGE_PRESETS[4]; // default 1Y
  if (p.fn) return p.fn();
  return _ch_isoDaysAgo(p.days);
}

function setChartRange(label) {
  _chartRange = label;
  _reportData = null; // force recompute
  render();
  _loadAndRenderCharts();
}

function setChartTab(tab) {
  _chartTab = tab;
  render();
  if (_reportData) _renderChartsFromData(_reportData);
  else _loadAndRenderCharts();
}

function viewReports() {
  const invAccts = state.accounts.filter((a) => a.type === "investment");
  if (!invAccts.length) {
    return `
    <div class="ph"><div><h2>Reports</h2><div class="sub">Portfolio analytics and performance charts</div></div></div>
    <div class="panel"><div class="panel-b"><div class="empty">
      No investment accounts yet. Add one to see reports.<br><br>
      <button class="btn" onclick="openAddAccount()">+ Add investment account</button>
    </div></div></div>`;
  }

  // Summary cards from current engine state
  const h = {};
  for (const a of invAccts) {
    const ah = state._holdings[a.id] || {};
    for (const secId in ah) {
      if (!h[secId]) h[secId] = { shares: 0, costBasis: 0, realized: 0 };
      h[secId].shares += ah[secId].shares;
      h[secId].costBasis += ah[secId].costBasis;
      h[secId].realized += ah[secId].realized;
    }
  }

  let totMv = 0, totCb = 0, totRealized = 0;
  let bestSec = null, bestPct = -Infinity;
  let worstSec = null, worstPct = Infinity;

  for (const secId in h) {
    const pos = h[secId];
    const sec = getSecurity(secId);
    if (!sec || pos.shares < 1e-9) continue;
    const mv = cents(pos.shares * sec.price);
    totMv += mv;
    totCb += pos.costBasis;
    totRealized += pos.realized;
    const pct = pos.costBasis > 0 ? ((mv - pos.costBasis) / pos.costBasis) * 100 : 0;
    if (pct > bestPct) { bestPct = pct; bestSec = sec; }
    if (pct < worstPct) { worstPct = pct; worstSec = sec; }
  }
  totMv = cents(totMv); totCb = cents(totCb); totRealized = cents(totRealized);
  const totUnrl = cents(totMv - totCb);
  const totalReturn = cents(totRealized + totUnrl);
  const totalReturnPct = totCb > 0 ? (totalReturn / totCb) * 100 : 0;

  // Range buttons
  const rangeHtml = RANGE_PRESETS.map((p) =>
    `<button class="range-btn ${_chartRange === p.label ? "active" : ""}" onclick="setChartRange('${p.label}')">${p.label}</button>`
  ).join("");

  // Chart tab buttons
  const tabs = [
    { key: "portfolio", label: "Portfolio Value" },
    { key: "holdings", label: "Holdings" },
    { key: "gains", label: "Gains" },
  ];
  const tabsHtml = tabs.map((t) =>
    `<div class="tab ${_chartTab === t.key ? "active" : ""}" onclick="setChartTab('${t.key}')">${t.label}</div>`
  ).join("");

  return `
  <div class="ph">
    <div><h2>Reports</h2><div class="sub">Portfolio analytics and performance over time</div></div>
    <div class="range-group">${rangeHtml}</div>
  </div>

  <div class="cards">
    <div class="card"><div class="lbl">Total return</div><div class="big num ${sgn(totalReturn)}">${fmtMoney(totalReturn)}</div><div class="meta">${fmtPct(totalReturnPct)} of invested capital</div></div>
    <div class="card"><div class="lbl">Unrealized</div><div class="big num ${sgn(totUnrl)}">${fmtMoney(totUnrl)}</div><div class="meta">current holdings vs cost</div></div>
    <div class="card"><div class="lbl">Realized</div><div class="big num ${sgn(totRealized)}">${fmtMoney(totRealized)}</div><div class="meta">booked gains / losses</div></div>
    <div class="card"><div class="lbl">${bestSec ? "Best performer" : "—"}</div>
      <div class="big num pos">${bestSec ? esc(bestSec.symbol) : "—"}</div>
      <div class="meta">${bestSec ? fmtPct(bestPct) + " unrealized" : "no holdings"}</div></div>
  </div>

  <div class="panel">
    <div class="tabs">${tabsHtml}</div>
    <div class="panel-b" style="padding:16px;position:relative;min-height:320px">
      <div id="report-chart" style="width:100%"></div>
    </div>
  </div>

  ${worstSec && worstSec !== bestSec ? `<div class="panel" style="padding:14px 16px">
    <span class="muted" style="font-size:12px">Worst performer: <strong>${esc(worstSec.symbol)}</strong> ${fmtPct(worstPct)}</span>
  </div>` : ""}`;
}

/* Trigger async chart data load after render() has placed the DOM */
async function _loadAndRenderCharts() {
  if (_reportLoading) return;
  _reportLoading = true;

  const el = document.getElementById("report-chart");
  if (el && !_reportData) {
    el.innerHTML = `<div class="chart-loading">Loading chart data…</div>`;
  }

  try {
    const from = _rangeFrom();
    const to = todayISO();
    _reportData = await computePortfolioHistory(from, to);
  } catch (e) {
    console.error("Chart data computation failed", e);
    _reportData = [];
  }
  _reportLoading = false;
  _renderChartsFromData(_reportData);
}

function _renderChartsFromData(data) {
  const el = document.getElementById("report-chart");
  if (!el) return;

  if (!data || !data.length) {
    el.innerHTML = `<div class="chart-empty">No price history available for the selected range.<br><span class="muted" style="font-size:12px">Fetch prices first using the Investments view.</span></div>`;
    return;
  }

  const dates = data.map((d) => d.date);

  if (_chartTab === "portfolio") {
    renderLineChart("report-chart", {
      dates,
      series: [
        { label: "Total Value", values: data.map((d) => d.totalValue), color: "#0E6B61", fill: true, strokeWidth: 2.5 },
        { label: "Market Value", values: data.map((d) => d.marketValue), color: "#1FB39F", strokeWidth: 1.5 },
        { label: "Cost Basis", values: data.map((d) => d.costBasis), color: "#9AA4B2", strokeWidth: 1 },
        { label: "Cash", values: data.map((d) => d.cash), color: "#3B82F6", strokeWidth: 1 },
      ],
    });
  } else if (_chartTab === "holdings") {
    // Gather all security IDs that appear in any snapshot
    const secIds = new Set();
    for (const snap of data) {
      for (const id in snap.holdings) secIds.add(id);
    }
    const ids = [...secIds];
    const series = ids.map((id, i) => {
      const sec = getSecurity(id);
      return {
        label: sec ? sec.symbol : id,
        values: data.map((d) => (d.holdings[id] ? d.holdings[id].value : 0)),
        color: CHART_COLORS[i % CHART_COLORS.length],
        fill: false,
        strokeWidth: 2,
      };
    });
    if (!series.length) {
      el.innerHTML = `<div class="chart-empty">No holding data in this range.</div>`;
      return;
    }
    renderLineChart("report-chart", { dates, series });
  } else if (_chartTab === "gains") {
    renderLineChart("report-chart", {
      dates,
      series: [
        { label: "Unrealized", values: data.map((d) => d.unrealized), color: "#1FB39F", fill: true, strokeWidth: 2 },
        { label: "Realized", values: data.map((d) => d.realized), color: "#8B5CF6", fill: false, strokeWidth: 2 },
        { label: "Total Return", values: data.map((d) => cents(d.unrealized + d.realized)), color: "#0E6B61", fill: false, strokeWidth: 2.5 },
      ],
    });
  }
}

/* Called by ui.js render() when view.type === "reports" */
function afterReportsRender() {
  if (_reportData) {
    _renderChartsFromData(_reportData);
  } else {
    _loadAndRenderCharts();
  }
}

/* expose for node tests if ever loaded there (browser uses globals) */
if (typeof module !== "undefined") {
  module.exports = {
    computePortfolioHistory, renderLineChart, viewReports, afterReportsRender,
    setChartRange, setChartTab, RANGE_PRESETS, CHART_COLORS,
  };
}
