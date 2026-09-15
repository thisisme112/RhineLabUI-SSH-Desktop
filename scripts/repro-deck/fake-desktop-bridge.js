/**
 * Fake desktop bridge for browser review of the session deck.
 *
 * Mimics the Electron `window.rhineDesktop` surface with a scripted password
 * session: real-shaped `ssh -v` lines drive the handshake, a password prompt
 * arrives, answering it enters the interactive session and the pty starts
 * echoing. Only the network is faked — everything the UI does with the events
 * is the real code path.
 */
(() => {
  const listeners = {
    data: new Set(),
    log: new Set(),
    prompt: new Set(),
    traffic: new Set(),
    exit: new Set(),
  };
  const on = (key) => (fn) => {
    listeners[key].add(fn);
    return () => listeners[key].delete(fn);
  };
  const emit = (key, value) => {
    for (const fn of [...listeners[key]]) fn(value);
  };
  const logLines = (lines, gap = 90) =>
    lines.forEach((line, i) => setTimeout(() => emit("log", line), i * gap));

  window.rhineDesktop = {
    isDesktop: true,
    platform: "win32",
    versions: { electron: "review", chrome: "review", node: "review" },
    hosts: async () => ({
      ok: true,
      configPath: "C:\\review\\config",
      hosts: [
        {
          alias: "demo-box",
          hostname: "192.168.1.10",
          user: "kaze",
          port: "22",
          raw: "Host demo-box\n  HostName 192.168.1.10\n  User kaze",
        },
      ],
    }),
    records: {
      list: async () => ({ ok: true, records: [] }),
      read: async () => ({ ok: false, error: "review bridge has no records" }),
      log: async () => ({ ok: false, error: "review bridge has no logs" }),
      prune: async () => ({ ok: true, removed: 0, bytesFreed: 0 }),
    },
    session: {
      start: async () => {
        queueMicrotask(() => {
          logLines([
            "debug1: Reading configuration data C:\\review\\config",
            "debug1: Connecting to demo-box [192.168.1.10] port 22.",
            "debug1: Connection established.",
            "debug1: identity file C:\\review\\id_ed25519 type 3",
            "debug1: Local version string SSH-2.0-OpenSSH_for_Windows_9.5",
            "debug1: Remote protocol version 2.0, remote software version OpenSSH_8.9p1",
            "debug1: kex: algorithm: curve25519-sha256",
            "debug1: kex: host key algorithm: ssh-ed25519",
            "debug1: kex: server->client cipher: chacha20-poly1305@openssh.com MAC: <implicit> compression: none",
            "debug1: Server host key: ssh-ed25519 SHA256:ReviewReviewReviewReviewReviewReviewRev",
            "debug1: Host 'demo-box' is known and matches the ssh-ed25519 host key.",
            "debug1: Found key in C:\\review\\known_hosts:3",
            "debug1: Authentications that can continue: publickey,password",
            "debug1: Offering public key: C:\\review\\id_ed25519 ED25519 SHA256:Review",
            "debug1: Authentications that can continue: publickey,password",
          ]);
          setTimeout(
            () =>
              emit("prompt", {
                id: 1,
                kind: "password",
                host: "demo-box",
                prompt: "kaze@demo-box's password:",
              }),
            1600,
          );
        });
        return { ok: true };
      },
      write: (data) => emit("data", data),
      resize: () => {},
      stop: () => {},
      answer: async () => {
        emit("prompt", null);
        logLines(
          [
            "debug1: Authentication succeeded (password).",
            "debug1: Entering interactive session.",
            "debug1: pledge: exec",
          ],
          140,
        );
        setTimeout(
          () =>
            emit(
              "data",
              "Welcome to Ubuntu 22.04.3 LTS (GNU/Linux 5.15.0-91-generic x86_64)\r\n\r\n Last login: Sat Sep 12 13:00:00 2026 from 192.168.1.2\r\nkaze@demo-box:~$ ",
            ),
          700,
        );
        return { ok: true };
      },
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
