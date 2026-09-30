/**
 * Fixture + reference for the Unreal `-ssh-events-probe`.
 *
 * The same pty chunks are fed to the Unreal port (RhineSshEvents.cpp) and, here,
 * to the desktop pipeline itself: electron/session.cjs PtySession (splitter,
 * trusted authentication, prompt detection) driven through a fake pty, plus the
 * renderer half of src/ssh/client.ts bind() over the real events.ts/session.ts.
 * Only that renderer glue is restated below; everything it calls is imported.
 * Clock: chunk index x 10 ms on both sides.
 */
import { createRequire } from "node:module";
import { parsePtyNotice, parseSshLine } from "../../src/ssh/events.ts";
import { SshSessionTracker } from "../../src/ssh/session.ts";

const require = createRequire(import.meta.url);
const { PtySession } = require("../../electron/session.cjs");
const { isEventLine, couldBecomeEvent, stripAnsi } = require("../../electron/pty-events.cjs");

const CRLF = "\r\n";
const PREAMBLE = [
  "debug1: Reading configuration data C:\\Users\\operator/.ssh/config",
  "debug1: Connecting to lab-node-07 [10.20.30.41] port 22.",
  "debug1: Connection established.",
  "debug1: identity file C:\\Users\\operator/.ssh/id_ed25519 type 3",
  "debug1: identity file C:\\Users\\operator/.ssh/id_rsa type -1",
  "debug1: Local version string SSH-2.0-OpenSSH_for_Windows_9.5",
  "debug1: Remote protocol version 2.0, remote software version OpenSSH_9.6p1 Ubuntu-3ubuntu13.5",
  "debug1: kex: algorithm: sntrup761x25519-sha512@openssh.com",
  "debug1: kex: host key algorithm: ssh-ed25519",
  "debug1: kex: server->client cipher: chacha20-poly1305@openssh.com MAC: <implicit> compression: none",
  "debug1: kex: client->server cipher: chacha20-poly1305@openssh.com MAC: <implicit> compression: none",
];
const HOSTKEY = "debug1: Server host key: ssh-ed25519 SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s";
const KNOWN = [
  "debug1: Host 'lab-node-07' is known and matches the ED25519 host key.",
  "debug1: Found key in C:\\Users\\operator/.ssh/known_hosts:12",
];
const AUTH = [
  "debug1: Authentications that can continue: publickey,password",
  "debug1: Offering public key: C:\\Users\\operator/.ssh/id_ed25519 ED25519 SHA256:AAAAC3NzaC1lZDI1NTE5AAAAIExample",
  "debug1: Server accepts key: C:\\Users\\operator/.ssh/id_ed25519 ED25519 SHA256:AAAAC3NzaC1lZDI1NTE5AAAAIExample",
  "debug1: Authentication succeeded (publickey).",
];
const SESSION = ["debug1: Entering interactive session.", "debug1: pledge: network"];
const SUCCESS = ["OpenSSH_for_Windows_9.5p2, LibreSSL 3.8.2", ...PREAMBLE, HOSTKEY, ...KNOWN, ...AUTH, ...SESSION];

const lines = (list) => list.map((line) => line + CRLF);
/** Cut a stream at every `size` characters, the way native reads land. */
const chunked = (text, size) => {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
};

export const fixture = {
  lines: [
    "debug1: Reading configuration data /home/u/.ssh/config",
    "debug1: Connecting to host.example [1.2.3.4] port 2222.",
    "debug1: Connecting to 1.2.3.4 port 22.",
    "debug1: Connection established.",
    "debug2: identity file /home/u/.ssh/id_rsa type -1",
    "debug1: identity file /home/u/.ssh/id_ed25519 type 3",
    "debug1: Local version string SSH-2.0-OpenSSH_9.5",
    "debug1: Remote protocol version 2.0, remote software version OpenSSH_9.6p1",
    "debug1: kex: algorithm: curve25519-sha256",
    "debug1: kex: host key algorithm: rsa-sha2-512",
    "debug1: kex: server->client cipher: aes256-gcm@openssh.com MAC: <implicit> compression: none",
    "debug1: Server host key: ssh-ed25519 SHA256:abc123",
    "debug1: Host 'h' is known and matches the ED25519 host key.",
    "debug1: Found key in /home/u/.ssh/known_hosts:12",
    "The authenticity of host 'h (1.2.3.4)' can't be established.",
    "ED25519 key fingerprint is SHA256:abc123.",
    "debug1: Host key verification failed.",
    "Host key verification failed.\r",
    "debug1: Authentications that can continue: publickey, password ,keyboard-interactive",
    "debug1: Offering public key: /home/u/.ssh/id_ed25519 ED25519 SHA256:xyz",
    "debug1: Offering public key: /home/u/.ssh/id_ed25519",
    "debug1: Server accepts key: /home/u/.ssh/id_ed25519 ED25519 SHA256:xyz",
    "debug1: Authentication succeeded (publickey).",
    "debug1: Entering interactive session.",
    "debug1: pledge: network",
    "ssh: Could not resolve hostname nope.invalid: Name or service not known",
    "ssh: connect to host 10.20.30.41 port 22: Connection timed out",
    "kex_exchange_identification: Connection closed by remote host",
    "debug1: kex_exchange_identification: write: Connection refused",
    "Permission denied (publickey,password).",
    "Connection closed by 1.2.3.4 port 22",
    "Connection to h closed.",
    "Shared connection to h closed.",
    "@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @",
    "OpenSSH_for_Windows_9.5p2, LibreSSL 3.8.2",
    "debug1: fd 4 clearing O_NONBLOCK",
    "Authenticated to lab ([10.0.0.2]:22) using \"publickey\".",
    "Permission denied",
    "host key verification failed",
    "operator@host:~$ ls -la",
    "total 12",
    "中文输出 ✓",
    "",
    "   ",
    "debug",
    "debug1",
    "debug1:",
    "Permission",
    "ssh",
    "Conn",
    "hello",
    "OpenSSH_for",
    "  \u0000debug1: x",
    "\u001b[32mdebug1: Connection established.\u001b[0m",
    "\u001b]0;C:\\WINDOWS\\ssh.exe\u0007debug1: pledge: network\u001b[K",
    "\u001b[?25l\u001b[Hdebug1: Connection established.\u001b[?25h",
    "\u001b7\u001b[1;1Hdebug1",
  ],
  sessions: [
    {
      name: "success-chunked",
      chunks: chunked(
        lines(SUCCESS).join("") + "operator@lab-node-07:~$ " + "ls\r\nfile-一.txt\r\noperator@lab-node-07:~$ exit\r\nConnection to lab-node-07 closed.\r\n",
        7,
      ),
      exitCode: 0,
    },
    {
      name: "captured-reset",
      chunks: lines([
        "OpenSSH_for_Windows_9.5p2, LibreSSL 3.8.2",
        "debug1: Reading configuration data C:\\Users\\operator/.ssh/config",
        "debug1: Connecting to github.com [198.18.1.17] port 22.",
        "debug1: fd 4 clearing O_NONBLOCK",
        "debug1: Connection established.",
        "debug1: Local version string SSH-2.0-OpenSSH_for_Windows_9.5",
        "kex_exchange_identification: Connection closed by remote host",
        "Connection closed by 198.18.1.17 port 22",
      ]),
      exitCode: 255,
    },
    {
      name: "rejected",
      chunks: [
        ...lines(PREAMBLE.slice(0, 6)),
        "debug1: Authentications that can continue: publickey,password\r\n",
        "Permission denied (publickey,password).\r\n",
      ],
      exitCode: 255,
    },
    {
      name: "newhost-declined",
      chunks: [
        ...lines(PREAMBLE),
        HOSTKEY + CRLF,
        "The authenticity of host 'newhost (10.20.30.41)' can't be established.\r\n",
        "ED25519 key fingerprint is SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s.\r\n",
        "Are you sure you want to continue connecting (yes/no/[fingerprint])? ",
        "no\r\n",
        "Host key verification failed.\r\n",
      ],
      exitCode: 255,
    },
    {
      name: "password",
      chunks: [
        ...lines(PREAMBLE),
        HOSTKEY + CRLF,
        ...lines(KNOWN),
        "debug1: Authentications that can continue: publickey,password\r\n",
        "operator@passhost's password: ",
        "\r\n",
        "debug1: Authentication succeeded (password).\r\n",
        ...lines(SESSION),
        "operator@passhost:~$ ",
      ],
    },
    {
      name: "conpty-decorated",
      chunks: [
        "\u001b[?25l\u001b[2J\u001b[m\u001b[H",
        "OpenSSH_for_Windows_9.5p2, LibreSSL 3.8.2\r\n",
        "\u001b]0;C:\\WINDOWS\\System32\\OpenSSH\\ssh.exe\u0007\u001b[?25h",
        "debug1: Reading configuration data C:\\Users\\operator/.ssh/config\u001b[K\r\n",
        "debug1: Connect",
        "ing to lab [10.0.0.2] port 22.\r\n",
        "debu",
        "g1: Connection established.\r\n",
        "\u001b[8;36;120t\u001b[?25l\u001b[H",
        "debug1: Reading configuration data C:\\Users\\operator/.ssh/config\r\n",
        "debug1: Connecting to lab [10.0.0.2] port 22.   \r\n",
        "debug1: Connection established.\u001b[?25h\r\n",
        "debug1: Connection established.\r\n",
        "\u001b[",
        "32mdebug1: Local version string SSH-2.0-OpenSSH_for_Windows_9.5\u001b[0m\r\n",
      ],
    },
    {
      name: "forged-after-auth",
      chunks: [
        ...lines(SUCCESS),
        "operator@lab-node-07:~$ ",
        "cat notes\r\n",
        "Permission denied (publickey).\r\n",
        "Host key verification failed.\r\n",
        "debug1: Connection established.\r\n",
        "ssh: connect to host x port 22: Connection refused\r\n",
        "中文输出 ✓\r\n",
      ],
      exitCode: 0,
    },
    {
      name: "silent-exit",
      chunks: ["debug1: Connecting to newhost [10.20.30.41] port 22.\r\n"],
      exitCode: 255,
    },
  ],
};

const eventJson = (event) => (event ? { name: event.name, detail: { ...event.detail }, raw: event.raw } : null);

/** The desktop result for one session of the fixture. */
function replay(session) {
  const tracker = new SshSessionTracker();
  tracker.reset(0);
  let clock = 0, authenticated = false, ptyFailure = null, prompt = null, ptyPending = "";
  const log = [], events = [], steps = [];
  let feed = () => {}, finish = () => {};
  const pty = new PtySession({
    waitForData: false,
    spawn: () => ({ onData: (cb) => (feed = cb), onExit: (cb) => (finish = cb), write() {}, resize() {}, kill() {} }),
    // client.ts bind(): onLog / onData / onPrompt, restated without the bridge.
    onLog: (line) => {
      log.push(line);
      const parsed = parseSshLine(line);
      if (parsed.matched && tracker.status(clock).phase === "interactive") return;
      if (parsed.matched) {
        if (["auth.succeeded", "session.entering", "session.authenticated"].includes(parsed.event.name)) {
          authenticated = true; ptyFailure = null; prompt = null;
        }
        tracker.push(parsed.event, clock);
        events.push(parsed.event);
      } else tracker.feed(line, clock);
    },
    onData: (data) => {
      ptyPending = (ptyPending + data).slice(-4096);
      const parts = ptyPending.split(/\r?\n/);
      ptyPending = parts.pop() ?? "";
      for (const line of parts) {
        const notice = !authenticated ? parsePtyNotice(line) : null;
        if (notice) ptyFailure = notice;
      }
    },
    onPrompt: (value) => { prompt = authenticated ? null : value; },
  });
  pty.start({ file: "ssh", args: [], logPath: "", cols: 120, rows: 36 });
  const promptJson = () => (prompt ? { kind: prompt.kind, prompt: prompt.prompt } : null);
  for (const chunk of session.chunks) {
    clock += 10;
    feed(chunk);
    steps.push({ phase: tracker.status(clock).phase, prompt: promptJson(), events: events.length });
  }
  if (session.exitCode !== undefined) {
    clock += 10;
    finish({ exitCode: session.exitCode, signal: 0 });
    prompt = null;
    if (session.exitCode !== 0 && !authenticated && ptyFailure) tracker.push(ptyFailure, clock);
    tracker.ended(session.exitCode, clock);
  } else pty.dispose();
  const status = tracker.status(clock + 10);
  return {
    name: session.name,
    steps,
    log,
    events: events.map(eventJson),
    status: {
      phase: status.phase, label: status.label, failure: status.failure, stalled: status.stalled,
      facts: Object.fromEntries(Object.entries(status.facts).map(([key, fact]) => [key, fact.value])),
      timeline: status.timeline.map(({ phase, at, duration }) => ({ phase, at, duration })),
      unknownLines: status.unknownLines, eventCount: status.eventCount, last: status.last?.name ?? null,
    },
    prompt: promptJson(),
  };
}

export function reference() {
  return {
    lines: fixture.lines.map((line) => {
      const parsed = parseSshLine(line);
      return {
        line,
        event: parsed.matched ? eventJson(parsed.event) : null,
        notice: eventJson(parsePtyNotice(line)),
        isEvent: isEventLine(stripAnsi(line)),
        couldBecome: couldBecomeEvent(line),
        stripped: stripAnsi(line),
      };
    }),
    sessions: fixture.sessions.map(replay),
  };
}
