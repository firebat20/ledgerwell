/* ============================================================
   storage.js — persistence adapter
   Prefers Tauri desktop app file storage, falls back to the
   Claude artifact storage API, then to browser's localStorage,
   then to an in-memory store. This lets the same code run
   inside Tauri, Claude, on GitHub Pages, or from a file:// open.

   IMPORTANT (read-path contract): storeGet resolves to a string
   when data exists, to null ONLY when there is genuinely no data
   (first run / no file), and THROWS on a backend error. Callers
   (engine.js load()) rely on this distinction so that a transient
   read failure is never mistaken for "empty", which would cause a
   reseed that overwrites the user's real data.
   ============================================================ */
const KEY = "LedgerWell:v1";
const _mem = {};

const STORAGE_MODE = (function () {
  if (typeof window !== "undefined" && window.__TAURI__) return "tauri";
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
  if (STORAGE_MODE === "tauri") {
    // Do NOT catch here: a backend error must propagate so the caller can
    // tell "no file yet" (Ok(None) -> null) apart from "read failed" (throw).
    // Masking the error as null was a data-loss bug: load() would treat it as
    // empty, reseed demo data, and save() would clobber the real ledger file.
    if (k === KEY) {
      return await window.__TAURI__.core.invoke("get_ledger");
    }
    return null;
  }
  if (STORAGE_MODE === "artifact") {
    try { const r = await window.storage.get(k); return r ? r.value : null; } catch (e) { return null; }
  }
  if (STORAGE_MODE === "local") {
    try { return localStorage.getItem(k); } catch (e) { return null; }
  }
  return _mem[k] ?? null;
}

async function storeSet(k, v) {
  if (STORAGE_MODE === "tauri") {
    // Let write errors propagate too, so save() can surface a failure rather
    // than silently dropping the user's most recent changes.
    if (k === KEY) {
      await window.__TAURI__.core.invoke("set_ledger", { content: v });
    }
    return;
  }
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
