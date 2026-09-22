/** Bounded metadata-only desktop diagnostics. Never persist arbitrary messages. */
const fs = require("node:fs");
const path = require("node:path");

const MAX_BYTES = 5 * 1024 * 1024;
const KEEP = 7;
const CATEGORIES = new Set([
  "app", "console-error", "console-warning", "console-info", "did-fail-load",
  "renderer-crash", "preload-error", "gpu", "child-process", "renderer-hang",
  "renderer-error", "session-lifecycle",
]);
const REASONS = new Set([
  "clean-exit", "abnormal-exit", "killed", "crashed", "oom", "launch-failed",
  "integrity-failure", "memory-eviction", "error", "rejection", "started",
  "stopped", "exited", "ready", "quitting", "load-finished", "responsive",
  "reload-budget-exhausted", "auto-reload-after-crash", "reload-failed",
]);

function sanitize(entry = {}) {
  const clean = {};
  if (["debug", "info", "warning", "error"].includes(entry.level)) clean.level = entry.level;
  if (REASONS.has(entry.reason)) clean.reason = entry.reason;
  if (typeof entry.sessionId === "string" && /^[a-f0-9-]{36}$/i.test(entry.sessionId))
    clean.sessionId = entry.sessionId;
  for (const key of ["code", "line"]) {
    if (Number.isSafeInteger(entry[key])) clean[key] = entry[key];
  }
  // Fixed classifications, not raw paths/URLs (which may contain credentials).
  if (["app", "external", "unknown"].includes(entry.source)) clean.source = entry.source;
  return clean;
}

function createDiagnosticLog({ dir, maxBytes = MAX_BYTES, keep = KEEP } = {}) {
  let disabled = !dir;
  let sequence = 0;
  return {
    enabled: () => !disabled,
    write(category, entry = {}) {
      if (disabled) return;
      try {
        fs.mkdirSync(dir, { recursive: true });
        const stamp = new Date().toISOString();
        const file = path.join(dir, `diagnostic-${stamp.slice(0, 10)}.log`);
        const line = JSON.stringify({ time: stamp,
          category: CATEGORIES.has(category) ? category : "app", ...sanitize(entry) }) + "\n";
        if (Buffer.byteLength(line) > maxBytes) return;
        let size = 0;
        try { size = fs.statSync(file).size; }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        if (size + Buffer.byteLength(line) > maxBytes)
          fs.renameSync(file, file.replace(/\.log$/, `-${Date.now()}-${sequence++}.log`));
        fs.appendFileSync(file, line, "utf8");
        const files = fs.readdirSync(dir)
          .filter(name => /^diagnostic-\d{4}-\d{2}-\d{2}(?:-\d+-\d+)?\.log$/.test(name))
          .map(name => ({ name, time: fs.statSync(path.join(dir, name)).mtimeMs }))
          .sort((a, b) => (a.name === path.basename(file) ? 1 : b.name === path.basename(file) ? -1 : a.time - b.time || a.name.localeCompare(b.name)));
        for (const old of files.slice(0, Math.max(0, files.length - keep)))
          fs.unlinkSync(path.join(dir, old.name));
      } catch {
        disabled = true;
      }
    },
  };
}

function createReloadBudget({ windowMs = 5 * 60 * 1000, limit = 3, now = () => Date.now() } = {}) {
  const stamps = [];
  return {
    allowed() {
      const t = now();
      while (stamps.length && t - stamps[0] >= windowMs) stamps.shift();
      if (stamps.length >= limit) return false;
      stamps.push(t);
      return true;
    },
  };
}

/** Always stop owned sessions first; recovery rebuilds UI only. */
function bindCrashRecovery({ contents, stopOwner, log, enabled = true, budget = createReloadBudget() }) {
  const listener = (_event, details) => {
    stopOwner(contents.id);
    if (!enabled || details.reason === "clean-exit" || contents.isDestroyed()) return;
    if (!budget.allowed()) {
      log("app", { level: "error", reason: "reload-budget-exhausted" });
      return;
    }
    log("app", { level: "warning", reason: "auto-reload-after-crash" });
    try { contents.reload(); }
    catch { log("app", { level: "error", reason: "reload-failed" }); }
  };
  contents.on("render-process-gone", listener);
  return () => contents.removeListener("render-process-gone", listener);
}

module.exports = { createDiagnosticLog, createReloadBudget, bindCrashRecovery, sanitize };
