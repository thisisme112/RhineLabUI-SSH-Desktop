/**
 * Owns one ssh session: the pty that carries the conversation, and the event
 * log that carries ssh's own diagnostics.
 *
 * Deliberately free of Electron imports so it can be exercised under plain
 * Node — the pty, argument handling and stream splitting are the parts most
 * likely to break and the least convenient to debug inside a window.
 *
 * Channel split (see DESKTOP-SSH.md §1.1):
 *   pty      → complete terminal bytes, including real authentication output
 *   log file → observed diagnostics, excluding ConPTY resize redraws
 *
 * The split is performed on the pty stream (electron/pty-events.cjs) rather
 * than with `ssh -E`: on Windows ssh holds that file exclusively, so nothing
 * could read it until the session was over.
 */
const fs = require("node:fs");
const pty = require("node-pty");
const { PtyEventSplitter, stripAnsi } = require("./pty-events.cjs");
const { consolePromptText } = require("./pty-prompt.cjs");

/** Only the tail matters: a prompt never survives a full screen redraw. */
const PROMPT_TAIL = 8192;
/**
 * How long an unfinished fragment may be held back in case it is still growing
 * into a diagnostic line. Prompts and shell echoes are never held, so this is
 * only a safety net for a line that arrived split in two.
 */
const FRAGMENT_IDLE_MS = 150;
let nextPromptId = 0;

/** Last non-empty line of the tail, with control sequences removed. */
function promptLine(tail) {
  const lines = stripAnsi(tail).split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line) return line;
  }
  return "";
}

/**
 * Prompts OpenSSH prints on the pty. Detected here, in the main process, so the
 * renderer receives a structured event and there is exactly one implementation
 * of this matching.
 *
 * Patterns are anchored to the whole cleaned line (no `m` flag): only the last
 * thing printed can be a pending question.
 */
const PROMPT_RULES = [
  [
    /^(.+?)@(.+?)'s password:\s*$/,
    (m) => ({ kind: "password", prompt: m[0].trim(), host: `${m[1]}@${m[2]}` }),
  ],
  [
    /^Enter passphrase for key '(.+?)':\s*$/,
    (m) => ({ kind: "passphrase", prompt: m[0].trim(), key: m[1] }),
  ],
  [
    /^Are you sure you want to continue connecting \(yes\/no\/\[fingerprint\]\)\?\s*$/,
    (m) => ({ kind: "hostkey", prompt: m[0].trim(), host: "" }),
  ],
  [
    /^(Verification code:)\s*$/,
    (m) => ({ kind: "verification-code", prompt: m[0].trim() }),
  ],
];

function detectPrompt(tail, columns, rows) {
  const clean = consolePromptText(tail, columns, rows);
  const line = promptLine(clean);
  if (!line) return null;
  const candidates = [line];
  // ConPTY wraps long identity paths onto physical console rows. Keep the
  // anchored OpenSSH prefix and final colon, but restore those soft line ends
  // before comparing the selected key path or displaying the challenge.
  const wrappedKey = clean.match(/(?:^|[\r\n])(Enter passphrase for key '[^']+':\s*)$/);
  if (wrappedKey) candidates.push(wrappedKey[1].replace(/[\r\n]/g, ""));
  for (const candidate of candidates) for (const [re, build] of PROMPT_RULES) {
    const match = candidate.match(re);
    if (match) {
      const result = build(match);
      if (result.kind === "passphrase" && wrappedKey) {
        // At a wide-character wrap ConPTY emits a padding space in the last
        // column. It is indistinguishable from a real path space on screen.
        // Preserve the displayed path and give the broker both bounded hints;
        // only an unambiguous effective IdentityFile may resolve them.
        let hints = [wrappedKey[1]];
        const boundary = / (?=\r?\n[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}])/gu;
        const positions = [...wrappedKey[1].matchAll(boundary)].map(item => item.index).reverse();
        for (const at of positions.slice(0, 4)) hints = hints.flatMap(value => [value, value.slice(0, at) + value.slice(at + 1)]);
        const keys = [...new Set(hints.map(value => value.replace(/[\r\n]/g, "").match(PROMPT_RULES[1][0])?.[1]).filter(Boolean))];
        if (keys.length > 1) result.keyHints = keys;
      }
      return result;
    }
  }
  return null;
}

/** Log lines that mean ssh has finished authenticating. */
const AUTHENTICATED =
  /^(?:(?:debug1: )?Authenticated to |debug1: Authentication succeeded|debug1: Entering interactive session\.)/;

function authenticationMatches(line, target, peer) {
  if (!target) return true;
  const matched = line.match(
    /^(?:debug1: )?Authenticated to (.+?) \((?:\[.*\]:(\d+)|(via proxy))\)/,
  );
  if (!matched || matched[1].toLowerCase() !== target.host.toLowerCase())
    return false;
  // ProxyJump's child writes to the same console. Even when the jump and
  // destination share a host/port, its direct authentication isn't the target.
  if (Boolean(matched[3]) !== Boolean(target.viaProxy)) return false;
  if (matched[2] && Number(matched[2]) !== target.port) return false;
  // Proxy authentication omits the port. Bind it to the preceding handshake,
  // including the username, instead of accepting a hop's generic success line.
  if (
    matched[3] &&
    (!peer ||
      peer.host.toLowerCase() !== target.host.toLowerCase() ||
      peer.port !== target.port ||
      (target.user && peer.user !== target.user))
  )
    return false;
  return true;
}

class PtySession {
  #pty = null;
  #spawn;
  #waitForData;
  #ready = false;
  #readyImmediate = null;
  #pendingResize = null;
  #stopping = false;
  #logFd = null;
  #killTimer = null;
  #idleTimer = null;
  #splitter = null;
  #tail = "";
  #prompt = null;
  #authenticated = false;
  #authenticationTarget = null;
  #authenticationPeer = null;
  #columns = 80;
  #rows = 24;

  constructor({
    onData,
    onLog,
    onPrompt,
    onExit,
    onAuthenticated,
    spawn = pty.spawn,
    waitForData = process.platform === "win32",
  } = {}) {
    this.#spawn = spawn;
    this.#waitForData = waitForData;
    this.onData = onData ?? (() => {});
    this.onLog = onLog ?? (() => {});
    this.onPrompt = onPrompt ?? (() => {});
    this.onExit = onExit ?? (() => {});
    this.onAuthenticated = onAuthenticated ?? (() => {});
    this.logPath = "";
    this.startedAt = 0;
    /** Byte counters feed the traffic-driven array wave and the audit log. */
    this.bytesIn = 0;
    this.bytesOut = 0;
    this.logLines = 0;
  }

  get running() {
    return this.#pty !== null && !this.#stopping;
  }

  /**
   * @param {object} options
   * @param {string} options.file     executable (system ssh by default)
   * @param {string[]} options.args   its argv, already built
   * @param {string} options.logPath  where this process writes the diagnostics
   */
  start(options) {
    if (this.#pty) throw new Error("session already started");
    const { file, args, logPath, cols = 80, rows = 24, cwd, env } = options;
    this.#columns = cols;
    this.#rows = rows;
    this.logPath = logPath;
    this.startedAt = Date.now();
    this.#tail = "";
    this.#prompt = null;
    this.#authenticated = false;
    this.#authenticationTarget = options.authenticationTarget ?? null;
    this.#authenticationPeer = null;
    this.#ready = !this.#waitForData;
    this.#pendingResize = null;
    this.#stopping = false;
    this.bytesIn = this.bytesOut = this.logLines = 0;
    this.#openLog();

    this.#splitter = new PtyEventSplitter({
      onEvent: (line) => this.#onEvent(line),
      onText: () => {},
      // After authentication, ordinary remote text cannot become a notice.
      hold: () => !this.#authenticated,
    });

    try {
      this.#pty = this.#spawn(file, args, {
        name: "xterm-256color",
        cols,
        rows,
        cwd: cwd || process.cwd(),
        env: env || process.env,
      });
    } catch (error) {
      this.dispose();
      throw error;
    }
    const target = this.#pty;

    target.onData((data) => {
      if (this.#pty !== target) return;
      // node-pty 1.1 marks WindowsTerminal ready AFTER forwarding the first
      // data event. Calling resize/kill here would put an uncaught callback in
      // its private deferred queue. Wait for the entire event to finish and
      // own pending operations here, where exit can still cancel them.
      if (!this.#ready && this.#readyImmediate === null) {
        this.#readyImmediate = setImmediate(() => {
          this.#readyImmediate = null;
          if (this.#pty !== target) return;
          this.#ready = true;
          if (this.#stopping) {
            this.#kill(target);
          } else if (this.#pendingResize) {
            const size = this.#pendingResize;
            this.#pendingResize = null;
            this.resize(size.cols, size.rows);
          }
        });
      }
      this.bytesIn += Buffer.byteLength(data, "utf8");
      this.#splitter.push(data);
      // Prompt cursor positions refer to the full console. Inspect the raw
      // stream only after its trusted diagnostics have established the peer.
      if (!this.#authenticated) this.#onText(data);
      // Read trusted authentication events before interpreting any tty prompt.
      if (this.#splitter.pending) this.#armFlush();
      // Removing diagnostic rows corrupts ConPTY's absolute cursor positions
      // on resize and in full-screen programs. xterm receives the exact stream;
      // the splitter is only an observer for authentication and event records.
      this.onData(data);
    });

    target.onExit(({ exitCode, signal }) => {
      if (this.#pty !== target) return;
      this.#pty = null;
      this.#stopping = true;
      this.#ready = false;
      this.#clearTimers();
      // Whatever ssh last printed without a newline still belongs to the user.
      this.#splitter.drain();
      this.#clearPrompt();
      this.dispose();
      this.onExit({
        exitCode,
        signal,
        logPath: this.logPath,
        bytesIn: this.bytesIn,
        bytesOut: this.bytesOut,
        logLines: this.logLines,
        elapsedMs: Math.max(0, Date.now() - this.startedAt),
      });
    });

    return this;
  }

  write(data) {
    if (!this.running || !this.#ready || typeof data !== "string" || !data)
      return false;
    try {
      this.#pty.write(data);
      this.bytesOut += Buffer.byteLength(data, "utf8");
      return true;
    } catch {
      // Native exit precedes onExit while ConPTY drains its final output.
      return false;
    }
  }

  answer(id, value) {
    const prompt = this.#prompt;
    if (!this.running || !prompt || prompt.id !== id || this.#authenticated)
      return { ok: false, error: "认证请求已经结束" };
    if (typeof value !== "string" || !value || /[\r\n\0]/.test(value))
      return { ok: false, error: "请输入一行非空内容" };
    if (prompt.kind === "hostkey" && value !== "yes" && value !== "no")
      return { ok: false, error: "主机密钥只能确认或拒绝" };
    if (!this.write(value + "\r"))
      return { ok: false, error: "终端当前无法接收认证回复" };
    this.#clearPrompt();
    return { ok: true };
  }

  #clearPrompt() {
    const hadPrompt = this.#prompt !== null;
    this.#prompt = null;
    this.#tail = "";
    if (hadPrompt) this.onPrompt(null);
  }

  resize(cols, rows) {
    if (!this.running) return false;
    if (
      !Number.isFinite(cols) ||
      !Number.isFinite(rows) ||
      cols < 1 ||
      rows < 1 ||
      cols > 32767 ||
      rows > 32767
    )
      return false;
    cols = Math.floor(cols);
    rows = Math.floor(rows);
    this.#columns = cols;
    this.#rows = rows;
    if (!this.#ready) {
      this.#pendingResize = { cols, rows };
      return true;
    }
    try {
      this.#pty.resize(cols, rows);
      return true;
    } catch {
      // A live JS wrapper does not imply that its native pty still exists.
      // Only onExit may finish the session and publish its real exit code.
      return false;
    }
  }

  /** Ask ssh to end. `onExit` still reports the real exit; this only nudges. */
  stop() {
    if (!this.running) return false;
    this.#stopping = true;
    this.#pendingResize = null;
    this.#clearPrompt();
    if (this.#ready) this.#kill(this.#pty);
    return true;
  }

  #kill(target) {
    try {
      target.kill();
    } catch {
      /* native exit may already be waiting for its final output to drain */
    }
    if (this.#pty !== target) return;
    // If the far end holds the channel open, make sure the pty dies anyway.
    this.#killTimer = setTimeout(() => {
      this.#killTimer = null;
      if (this.#pty !== target) return;
      try {
        target.kill();
      } catch {
        /* already gone */
      }
    }, 1500);
    if (this.#killTimer.unref) this.#killTimer.unref();
  }

  dispose() {
    this.#stopping = true;
    this.#clearTimers();
    if (this.#logFd !== null) {
      try {
        fs.closeSync(this.#logFd);
      } catch {
        /* ignore */
      }
      this.#logFd = null;
    }
  }

  #clearTimers() {
    this.#pendingResize = null;
    if (this.#readyImmediate !== null) {
      clearImmediate(this.#readyImmediate);
      this.#readyImmediate = null;
    }
    if (this.#killTimer) {
      clearTimeout(this.#killTimer);
      this.#killTimer = null;
    }
    if (this.#idleTimer) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = null;
    }
  }

  /** Release a held fragment once the stream has been quiet for a moment. */
  #armFlush() {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = null;
      if (this.#splitter?.pending) this.#splitter.drain();
      if (!this.#authenticated) this.#onText("");
    }, FRAGMENT_IDLE_MS);
    if (this.#idleTimer.unref) this.#idleTimer.unref();
  }

  #openLog() {
    if (!this.logPath) return;
    try {
      fs.mkdirSync(require("node:path").dirname(this.logPath), {
        recursive: true,
      });
      // Ours alone: ssh no longer touches this file, so nothing can lock it.
      this.#logFd = fs.openSync(this.logPath, "w");
    } catch {
      this.#logFd = null;
    }
  }

  /**
   * One diagnostic line. Delivered the moment it is complete, which is what
   * makes every connection animation a report rather than a replay.
   */
  #onEvent(line) {
    this.logLines++;
    if (this.#logFd !== null) {
      try {
        fs.writeSync(this.#logFd, line + "\n");
      } catch {
        /* a log we cannot write is not a reason to lose the event */
      }
    }
    const peer = line.match(
      /^debug1: Authenticating to (.+?):(\d+) as '(.+?)'/,
    );
    if (peer && !this.#authenticated)
      this.#authenticationPeer = {
        host: peer[1].replace(/^\[|\]$/g, ""),
        port: Number(peer[2]),
        user: peer[3],
      };
    const authenticationLine = AUTHENTICATED.test(line);
    const trustedAuthentication =
      !authenticationLine ||
      this.#authenticated ||
      authenticationMatches(
        line,
        this.#authenticationTarget,
        this.#authenticationPeer,
      );
    const firstAuthentication =
      authenticationLine && trustedAuthentication && !this.#authenticated;
    if (authenticationLine && trustedAuthentication) {
      this.#authenticated = true;
      this.#clearPrompt();
    }
    this.onLog(line, { trustedAuthentication });
    if (firstAuthentication) this.onAuthenticated();
  }

  /** Observe the complete console before authentication; never change xterm's bytes. */
  #onText(text) {
    this.#tail = (this.#tail + text).slice(-PROMPT_TAIL);
    const prompt = this.#authenticated ? null : detectPrompt(this.#tail, this.#columns, this.#rows);
    if (prompt && prompt.prompt !== this.#prompt?.prompt) {
      this.#prompt = { ...prompt, id: ++nextPromptId };
      this.onPrompt(this.#prompt);
    }
  }
}

module.exports = {
  PtySession,
  detectPrompt,
  stripAnsi,
  FRAGMENT_IDLE_MS,
  authenticationMatches,
};
