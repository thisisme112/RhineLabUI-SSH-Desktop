/* Browser-only fixture. Never imported or shipped by the application. */
(() => {
  const listeners = Object.fromEntries(
    ["data", "log", "prompt", "traffic", "exit"].map((key) => [key, new Set()]),
  );
  const on = (key) => (fn) => {
    listeners[key].add(fn);
    return () => listeners[key].delete(fn);
  };
  const emit = (key, value) => {
    for (const fn of [...listeners[key]]) fn(value);
  };
  let generation = 0,
    active = false,
    pending = null,
    line = "",
    bytesIn = 0,
    bytesOut = 0;
  const later = (fn, delay) => {
    const n = generation;
    setTimeout(() => {
      if (n === generation && active) fn();
    }, delay);
  };
  const data = (text) => {
    bytesIn += new TextEncoder().encode(text).length;
    emit("data", text);
  };
  const log = (text) => emit("log", text);
  const end = (code) => {
    active = false;
    pending = null;
    emit("prompt", null);
    emit("exit", {
      exitCode: code,
      logPath: "review.log",
      bytesIn,
      bytesOut,
      logLines: 12,
      elapsedMs: 5000,
    });
  };
  const fixture = (window.__deckFixture = {
    writes: [],
    sizes: [],
    clipboard: { text: "", writes: [], reads: 0, pending: 0, delay: 0, error: "" },
    output: data,
    interactive() {
      log("debug1: Entering interactive session.");
      data(
        "Rhine Lab local UI fixture\r\n\x1b[32mANSI green\x1b[0m · 中文输入\r\noperator@review-host:~$ ",
      );
    },
    end,
  });
  const hosts = ["review-host", "second-host"].map((alias) => ({
    alias,
    hostname: "127.0.0.1",
    user: "operator",
    port: "2222",
    raw: `Host ${alias}\n HostName 127.0.0.1\n User operator\n Port 2222`,
  }));
  window.rhineDesktop = {
    isDesktop: true,
    platform: "win32",
    versions: { electron: "fixture", chrome: "fixture", node: "fixture" },
    hosts: async () => ({ ok: true, configPath: "review/config", hosts }),
    clipboard: {
      async readText() {
        const { text, delay, error } = fixture.clipboard;
        fixture.clipboard.reads++;
        fixture.clipboard.pending++;
        if (delay) await new Promise(resolve => setTimeout(resolve, delay));
        fixture.clipboard.pending--;
        return error ? { ok: false, error } : { ok: true, text };
      },
      async writeText(text) {
        if (fixture.clipboard.error) return { ok: false, error: fixture.clipboard.error };
        fixture.clipboard.text = text;
        fixture.clipboard.writes.push(text);
        return { ok: true };
      },
    },
    records: {
      list: async () => ({ ok: true, records: [] }),
      read: async () => ({ ok: false }),
      log: async () => ({ ok: true, lines: [] }),
      prune: async () => ({ ok: true, removed: 0, bytesFreed: 0 }),
    },
    session: {
      async start({ target }) {
        generation++;
        active = true;
        bytesIn = 0;
        bytesOut = 0;
        line = "";
        [
          "debug1: Reading configuration data review/config",
          `debug1: Connecting to ${target} [127.0.0.1] port 2222.`,
          "debug1: Connection established.",
          "debug1: Local version string SSH-2.0-OpenSSH_for_Windows_9.5",
          "debug1: Remote protocol version 2.0, remote software version OpenSSH_9.6",
          "debug1: kex: algorithm: curve25519-sha256",
          "debug1: kex: host key algorithm: ssh-ed25519",
          "debug1: kex: server->client cipher: chacha20-poly1305@openssh.com MAC: <implicit> compression: none",
          "debug1: Server host key: ssh-ed25519 SHA256:REVIEWONLYNOTAREALHOSTKEY",
          `debug1: Host '${target}' is known and matches the ssh-ed25519 host key.`,
          "debug1: Authentications that can continue: publickey,password",
        ].forEach((text, i) => later(() => log(text), 80 * i));
        later(() => {
          pending = {
            id: generation,
            kind: "password",
            host: target,
            prompt: `operator@${target}'s password:`,
          };
          emit("prompt", pending);
        }, 1100);
        return {
          ok: true,
          argv: ["ssh", "-v", target],
          file: "ssh",
          logPath: "review.log",
          id: `review-${generation}`,
        };
      },
      async answer(id, value) {
        if (pending?.id !== id) return { ok: false, error: "stale prompt" };
        pending = null;
        emit("prompt", null);
        if (value === "fail") {
          log("Permission denied (publickey,password).");
          end(255);
        } else
          log(
            `Authenticated to review-host ([127.0.0.1]:2222) using "password".`,
          );
        return { ok: true };
      },
      write(text) {
        if (!active) return;
        fixture.writes.push(text);
        bytesOut += new TextEncoder().encode(text).length;
        for (const ch of text) {
          if (ch === "\r") {
            data(`\r\nresult: ${line}\r\noperator@review-host:~$ `);
            line = "";
          } else if (ch >= " ") {
            line += ch;
            data(ch);
          }
        }
      },
      resize: (cols, rows) => fixture.sizes.push([cols, rows]),
      stop: () => end(0),
      record: async () => ({ ok: true }),
      export: async () => ({ ok: true, canceled: true }),
      onData: on("data"),
      onLog: on("log"),
      onPrompt: on("prompt"),
      onTraffic: on("traffic"),
      onExit: on("exit"),
    },
  };
})();
