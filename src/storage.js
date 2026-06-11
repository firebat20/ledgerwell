/* ============================================================
   storage.js — persistence adapter
   Prefers the Claude artifact storage API, falls back to the
   browser's localStorage, then to an in-memory store. This lets
   the same code run inside Claude, on GitHub Pages, or from a
   file:// open without changes.
   ============================================================ */
const KEY = "ledgerwell:v1";
const _mem = {};

const STORAGE_MODE = (function () {
  if (typeof window !== "undefined" && window.storage && typeof window.storage.get === "function") return "artifact";
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem("__lw_probe", "1");
      localStorage.removeItem("__lw_probe");
      return "local";
    }
  } catch (e) { /* private mode etc. */ }
  return "memory";
})();

async function storeGet(k) {
  if (STORAGE_MODE === "artifact") {
    try { const r = await window.storage.get(k); return r ? r.value : null; } catch (e) { return null; }
  }
  if (STORAGE_MODE === "local") {
    try { return localStorage.getItem(k); } catch (e) { return null; }
  }
  return _mem[k] ?? null;
}

async function storeSet(k, v) {
  if (STORAGE_MODE === "artifact") {
    try { await window.storage.set(k, v); } catch (e) { console.error("save failed", e); }
    return;
  }
  if (STORAGE_MODE === "local") {
    try { localStorage.setItem(k, v); } catch (e) { console.error("save failed", e); }
    return;
  }
  _mem[k] = v;
}

if (typeof module !== "undefined") module.exports = { KEY, STORAGE_MODE, storeGet, storeSet };
