/** Listing only. Effective config resolution remains the system ssh's job. */
function parseHostConfig(text) {
  const hosts = new Map();
  let current = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(\S+?)(?:\s*=\s*|\s+)(.*)$/);
    if (!match) continue;
    const [, keyword, value] = match;
    if (/^host$/i.test(keyword)) {
      current = value
        .split(/\s+/)
        .filter((alias) => alias && !/[*?!]/.test(alias))
        .map((alias) => {
          if (!hosts.has(alias))
            hosts.set(alias, {
              alias,
              hostname: "",
              user: "",
              port: "",
              raw: "",
            });
          const entry = hosts.get(alias);
          entry.raw += (entry.raw ? "\n" : "") + raw;
          return entry;
        });
      continue;
    }
    if (/^match$/i.test(keyword)) {
      current = [];
      continue;
    }
    const field = {
      hostname: "hostname",
      user: "user",
      port: "port",
      identityfile: "identityFile",
    }[keyword.toLowerCase()];
    for (const entry of current) {
      entry.raw += "\n" + raw;
      if (field && !entry[field])
        entry[field] = value.replace(/^"(.*)"$/, "$1");
    }
  }
  return [...hosts.values()];
}
module.exports = { parseHostConfig };
