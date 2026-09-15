const fs = require("node:fs");
const path = require("node:path");

const RETENTION = { days: 30, sessions: 200, bytes: 64 * 1024 * 1024 };

function recordPath(directory, file) {
  const dir = path.resolve(directory),
    target = path.resolve(String(file ?? ""));
  if (path.dirname(target) !== dir || !/\.(json|log)$/.test(target))
    throw new Error("路径不在会话记录目录内");
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("会话记录必须是普通文件");
  return target;
}

/** Only direct, regular .json/.log files in this app's log directory qualify. */
function pruneRecords(
  directory,
  { now = Date.now(), exclude = [], ...overrides } = {},
) {
  const limits = { ...RETENTION, ...overrides },
    dir = path.resolve(directory);
  if (!fs.existsSync(dir))
    return { ok: true, removed: 0, bytesFreed: 0, errors: [] };
  const protectedFiles = new Set(exclude.map((file) => path.resolve(file)));
  const files = new Map();
  for (const name of fs.readdirSync(dir)) {
    if (!/\.(json|log)$/.test(name)) continue;
    const file = path.join(dir, name),
      stat = fs.lstatSync(file);
    if (stat.isFile() && !stat.isSymbolicLink())
      files.set(file, { file, size: stat.size, at: stat.mtimeMs });
  }
  const groups = new Map();
  const add = (key, entry) => {
    if (!groups.has(key)) groups.set(key, new Map());
    groups.get(key).set(entry.file, entry);
  };
  const paired = new Set();
  for (const entry of files.values()) {
    if (!entry.file.endsWith(".json")) continue;
    let log = entry.file.replace(/\.json$/, ".log");
    try {
      if (entry.size < 4 * 1024 * 1024) {
        const record = JSON.parse(fs.readFileSync(entry.file, "utf8"));
        const candidate = path.resolve(String(record.logPath || log));
        if (path.dirname(candidate) === dir && candidate.endsWith(".log"))
          log = candidate;
      }
    } catch {
      /* Unreadable records still age out by their own file timestamp. */
    }
    add(log, entry);
    if (files.has(log)) {
      add(log, files.get(log));
      paired.add(log);
    }
  }
  for (const entry of files.values())
    if (entry.file.endsWith(".log") && !paired.has(entry.file))
      add(entry.file, entry);
  const sessions = [...groups.values()]
    .map((group) => [...group.values()])
    .sort(
      (a, b) =>
        Math.max(...b.map((entry) => entry.at)) -
        Math.max(...a.map((entry) => entry.at)),
    );
  let kept = 0,
    bytes = 0,
    removed = 0,
    bytesFreed = 0;
  const errors = [];
  for (const group of sessions) {
    const size = group.reduce((sum, entry) => sum + entry.size, 0);
    const protectedGroup = group.some((entry) =>
      protectedFiles.has(entry.file),
    );
    const expired =
      Math.max(...group.map((entry) => entry.at)) <
      now - limits.days * 86400000;
    if (
      protectedGroup ||
      (!expired && kept < limits.sessions && bytes + size <= limits.bytes)
    ) {
      kept++;
      bytes += size;
      continue;
    }
    let complete = true;
    for (const entry of group) {
      try {
        // Revalidate immediately before removal. Never recurse or follow links.
        fs.unlinkSync(recordPath(dir, entry.file));
        bytesFreed += entry.size;
      } catch (error) {
        complete = false;
        errors.push(String(error.message || error));
      }
    }
    if (complete) removed++;
  }
  return { ok: errors.length === 0, removed, bytesFreed, errors };
}
module.exports = { RETENTION, recordPath, pruneRecords };
