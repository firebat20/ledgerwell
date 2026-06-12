/* ============================================================
   backup.js — Export / Import the whole ledger as JSON
   Phase 0 of docs/MIGRATION.md: the migration bridge that moves
   data into the future Tauri build (a fresh webview origin), and
   doubles as a manual backup / restore.

   Self-contained plain-globals module (load after ui.js), mirroring
   import.js / investments.js.

   Reuses engine.js globals: state, view, blankState, rebuild, save,
     serializeState, cents, DIV_CAT_ID, INT_CAT_ID, todayISO
   and ui.js globals: $, openModal, closeModal, render
   ============================================================ */

const BACKUP_SCHEMA = 1;

/* ---------- export ---------- */
function exportEnvelope() {
  return {
    app: "LedgerWell",
    schema: BACKUP_SCHEMA,
    exportedAt: new Date().toISOString(),
    state: serializeState(),          // same shape storage.js persists
  };
}

function exportData() {
  const json = JSON.stringify(exportEnvelope(), null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `LedgerWell-backup-${todayISO()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------- import: parse + validate (does NOT mutate live state) ---------- */
/* Accept either an export envelope {app,schema,state} or a bare state object
   (e.g. a raw localStorage value), so restores are forgiving. */
function unwrapBackup(parsed) {
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)
    && parsed.state && typeof parsed.state === "object" && parsed.accounts === undefined) {
    return parsed.state;
  }
  return parsed;
}

/* Returns {ok:true, state, summary} or {ok:false, error}.
   Builds a candidate, rebuilds it on a temporary swap, and checks the
   double-entry invariant BEFORE the caller is allowed to commit. */
function readBackup(text) {
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (e) { return { ok: false, error: "That isn't valid JSON." }; }

  const raw = unwrapBackup(parsed);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "This file isn't a LedgerWell backup." };
  }
  for (const k of ["accounts", "categories", "securities", "transactions"]) {
    if (raw[k] !== undefined && !Array.isArray(raw[k])) {
      return { ok: false, error: `Backup field "${k}" should be a list.` };
    }
  }

  const candidate = Object.assign(blankState(), raw);
  candidate.accounts = candidate.accounts || [];
  candidate.categories = candidate.categories || [];
  candidate.securities = candidate.securities || [];
  candidate.transactions = candidate.transactions || [];
  candidate.seq = Number(candidate.seq) || 1;

  // built-in categories the engine relies on (mirror load())
  for (const bc of [
    { id: DIV_CAT_ID, name: "Dividend Income", type: "income" },
    { id: INT_CAT_ID, name: "Interest Income", type: "income" },
  ]) {
    if (!candidate.categories.find((c) => c.id === bc.id)) candidate.categories.push(bc);
  }

  for (const t of candidate.transactions) {
    if (!t || typeof t !== "object") return { ok: false, error: "A transaction record is malformed." };
    if (!t.inv && !Array.isArray(t.postings)) return { ok: false, error: "A transaction is missing its postings." };
  }

  // verify invariants on the rebuilt candidate without disturbing live state
  const prev = state;
  try {
    state = candidate;
    rebuild();                         // re-derives investment postings, lots, holdings
    let unbalanced = 0, ledger = 0;
    for (const t of state.transactions) {
      let s = 0;
      for (const p of (t.postings || [])) { const amt = Number(p.amount); s += amt; ledger += amt; }
      if (!(Math.abs(cents(s)) <= 0.005)) unbalanced++;        // NaN-safe
    }
    if (unbalanced > 0) return { ok: false, error: `${unbalanced} transaction(s) don't balance — the file looks corrupt.` };
    if (!(Math.abs(cents(ledger)) <= 0.005)) return { ok: false, error: "The ledger doesn't balance — the file looks corrupt." };
    return {
      ok: true,
      state: candidate,
      summary: {
        accounts: candidate.accounts.length,
        transactions: candidate.transactions.length,
        securities: candidate.securities.length,
        categories: candidate.categories.length,
      },
    };
  } catch (e) {
    return { ok: false, error: "Couldn't read this backup: " + (e && e.message ? e.message : String(e)) };
  } finally {
    state = prev;                      // caller commits explicitly via applyBackup()
  }
}

function applyBackup(candidate) {
  loadError = null;
  state = candidate;
  rebuild();
  save();
}

/* ---------- import: UI ---------- */
function openImportData() {
  openModal(`
    <div class="modal-h"><h3>Import data</h3><p>Restore a LedgerWell backup (.json). This replaces everything currently in the app.</p></div>
    <div class="modal-b">
      <div class="banner">Importing <strong>replaces all current data</strong>. Use “Export data” first if you want to keep a copy.</div>
      <div class="fld"><label>Backup file</label>
        <input id="bk-file" type="file" accept=".json,application/json" class="full"></div>
      <div class="fld" style="margin-top:13px"><label>…or paste backup JSON</label>
        <textarea id="bk-text" class="full" rows="7" placeholder='{ "app": "LedgerWell", "schema": 1, "state": { … } }' style="padding:9px 11px;border:1px solid var(--line-strong);border-radius:7px;font-family:'IBM Plex Mono',monospace;font-size:12.5px"></textarea></div>
      <div id="bk-msg" style="font-size:12.5px;margin-top:8px;min-height:1em" class="muted"></div>
    </div>
    <div class="modal-f">
      <button class="btn ghost" onclick="closeModal()">Cancel</button>
      <button class="btn" onclick="doImportData()">Replace data…</button>
    </div>`);
}

function setBackupMsg(msg, bad) {
  const el = $("bk-msg"); if (!el) return;
  el.textContent = msg || "";
  el.style.color = bad ? "var(--neg)" : "var(--muted)";
}

async function doImportData() {
  const fileInput = $("bk-file");
  const f = fileInput ? fileInput.files[0] : null;
  let text = "";
  try { text = f ? await f.text() : ($("bk-text") ? $("bk-text").value : ""); }
  catch (e) { setBackupMsg("Couldn't read that file.", true); return; }
  if (!text || !text.trim()) { setBackupMsg("Choose a file or paste backup JSON first.", true); return; }

  const res = readBackup(text);
  if (!res.ok) { setBackupMsg(res.error, true); return; }

  const s = res.summary;
  const ok = confirm(
    "Replace ALL current data with this backup?\n\n" +
    `${s.accounts} account(s) · ${s.transactions} transaction(s) · ` +
    `${s.securities} securit${s.securities === 1 ? "y" : "ies"} · ` +
    `${s.categories} categor${s.categories === 1 ? "y" : "ies"}\n\nThis can't be undone.`
  );
  if (!ok) return;

  applyBackup(res.state);
  closeModal();
  view = { type: "dashboard" };
  render();
}