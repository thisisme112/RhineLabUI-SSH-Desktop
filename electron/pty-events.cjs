/**
 * Observes ssh diagnostics and authentication prompts in the raw PTY stream.
 * The terminal receives that entire stream separately, preserving VT state.
 *
 * Why this exists instead of `ssh -E <file>`:
 *
 * Measured with OpenSSH_for_Windows_9.5p2 — ssh opens the `-E` file with a
 * share mode that denies every other opener. `fs.openSync(logPath, "r")` fails
 * with EBUSY for the entire session and only succeeds once ssh closes stderr on
 * its way out, so the tail delivers the whole handshake at the end. Holding the
 * handle open before ssh starts does not help either: ssh then fails outright
 * with "Couldn't open logfile". A named pipe accepts the open but buffers, so
 * nothing arrives until the peer closes.
 *
 * Without `-E` the same lines come down the pty as they happen: complete
 * `\r\n`-terminated lines, no console reflow at 100 columns, first line within
 * ~400ms of spawn. Splitting them here restores the separation in the only
 * place that can actually see the bytes, and the main process writes the log
 * file itself — so the audit trail is a file we own and can always read.
 *
 * Unprefixed notices are only recognised before authentication. Debug-shaped
 * lines remain observable afterwards, but SshClient no longer lets them change
 * verified state once a shell is live. Raw terminal output is never filtered.
 */
"use strict";

const LINE_END = /\r?\n/;
/** Beyond this, a held fragment is not worth waiting for. */
const MAX_HELD = 8192;

/** Anything OpenSSH prints at debug level 1, 2 or 3. */
const DEBUG_LINE = /^debug\d+:\s/;
/** The client's own version banner, printed once before any debug line. */
const VERSION_BANNER = /^OpenSSH_[\w.]+,\s(?:LibreSSL|OpenSSL)\s/;

/**
 * Notices ssh prints without a `debug1:` prefix. Unlike the debug lines these
 * could in principle be forged by remote text, so they are only honoured before
 * authentication.
 */
const NOTICES = [
  /^Permission denied \(.*\)\.$/,
  /^Host key verification failed\.$/,
  /^kex_exchange_identification: /,
  /^banner exchange: /,
  /^ssh: /,
  /^Authenticated to /,
  /^Connection to .+ closed\.$/,
  /^Connection closed by /,
  /^Shared connection to .+ closed\.$/,
  /^WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED/,
];

/** Starts of the patterns above, so a partially received line can be held. */
const PREFIXES = [
  "debug",
  "OpenSSH_",
  "ssh:",
  "Permission denied (",
  "Host key verification failed.",
  "kex_exchange_identification:",
  "banner exchange:",
  "Authenticated to ",
  "Connection to ",
  "Connection closed by ",
  "Shared connection to ",
  "WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED",
];

/**
 * Strip terminal control sequences before matching.
 *
 * Measured: a pty-hosted prompt arrives as
 *   `operator@host's password:\u001b[1C\u001b]0;…\u0007`
 * — the trailing space is replaced by a cursor-forward escape and the window
 * title follows. ConPTY adds its own sequences at the start of the stream too.
 */
function stripAnsi(text) {
  return text
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "") // OSC … BEL/ST
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "") // CSI
    .replace(/\u001b[@-Z\\-_]/g, ""); // two-character escapes
}

/**
 * Is this a line ssh printed about itself, rather than something the session
 * said? `notices` is switched off once a person is at a shell, because from
 * then on the bytes belong to the remote.
 */
function isEventLine(line, notices = true) {
  if (DEBUG_LINE.test(line) || VERSION_BANNER.test(line)) return true;
  if (!notices) return false;
  return NOTICES.some((re) => re.test(line));
}

/**
 * Could this fragment still grow into an event line? Used to decide whether an
 * unterminated tail may be held back — a password prompt has no newline, so
 * holding everything would delay every shell echo by the hold time.
 */
function couldBecomeEvent(text) {
  const probe = stripAnsi(text).replace(/^[\s\u0000]+/, "");
  if (!probe) return false;
  // A native read can end between the debug level, colon and following space.
  if (/^debug\d+:?$/.test(probe)) return true;
  for (const prefix of PREFIXES) if (prefix.startsWith(probe)) return true;
  return isEventLine(stripAnsi(probe));
}

/**
 * Routes one pty stream into `onEvent` (diagnostics, newline-free) and
 * `onText` (everything a terminal should render, terminators intact).
 */
class PtyEventSplitter {
  #buffer = "";
  #history = [];
  #redraw = null;
  #cursorHidden = false;

  /**
   * @param {object} handlers
   * @param {(line: string) => void} handlers.onEvent
   * @param {(text: string) => void} handlers.onText
   * @param {() => boolean} [handlers.hold] whether authentication is still
   *   pending and unprefixed SSH notices may be recognised
   */
  constructor({ onEvent, onText, hold = () => true } = {}) {
    this.onEvent = onEvent ?? (() => {});
    this.onText = onText ?? (() => {});
    this.hold = hold;
  }

  /** Bytes arriving from the pty, however they happen to be chunked. */
  push(chunk) {
    this.#buffer += chunk;
    let match;
    while ((match = LINE_END.exec(this.#buffer)) !== null) {
      const line = this.#buffer.slice(0, match.index);
      this.#buffer = this.#buffer.slice(match.index + match[0].length);
      this.#route(line, match[0]);
    }
    if (this.#buffer.length > MAX_HELD) {
      this.drain();
      return;
    }
    // An escape may span native chunks. Keep its prefix with the following
    // text so a split resize marker or a coloured diagnostic is still parsed.
    const partialEscape = /\u001b(?:\[[0-?]*[ -/]*|\][^\u0007\u001b]*|)$/.test(
      this.#buffer,
    );
    if (this.#buffer && !partialEscape && !couldBecomeEvent(this.#buffer))
      this.drain();
  }

  /** Emit whatever is still buffered as terminal text. */
  drain() {
    const rest = this.#buffer;
    this.#buffer = "";
    if (rest) {
      this.#beginRedraw(rest);
      this.onText(rest);
      this.#endRedraw(rest);
    }
  }

  get pending() {
    return this.#buffer;
  }

  #route(line, terminator) {
    this.#beginRedraw(line);
    const clean = stripAnsi(line);
    if (isEventLine(clean, this.hold())) {
      // ConPTY sometimes clears a resized row with spaces rather than CSI K.
      // Padding is not a new diagnostic; retain the original emitted text and
      // use only the unpadded text as this repaint's comparison key.
      const key = clean.trimEnd();
      const remaining = this.#redraw?.get(key) ?? 0;
      if (remaining) this.#redraw.set(key, remaining - 1);
      else {
        this.#history.push(key);
        if (this.#history.length > 4096) this.#history.shift();
        this.onEvent(clean);
      }
    } else this.onText(line + terminator);
    this.#endRedraw(line);
  }

  #beginRedraw(text) {
    // A height-only ConPTY resize can omit CSI 8. It still hides the cursor,
    // moves home, repaints rows and restores the cursor. Track hide across
    // chunks so the two complete control sequences may arrive separately.
    // Only already observed lines within that repaint are deduplicated;
    // a later identical diagnostic (e.g. an auth retry) remains a new event.
    const prefix = text.match(
      /^(?:\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b[@-Z\\-_])*/,
    )[0];
    // A cursor restore before the diagnostic ends the repaint before that
    // line; a restore after its text is handled by #endRedraw instead.
    if (prefix.includes("\u001b[?25h")) {
      this.#redraw = null;
      this.#cursorHidden = false;
    }
    if (/\u001b\[\?25l/.test(text)) this.#cursorHidden = true;
    const resize = /\u001b\[8;\d+;\d+t/.test(text);
    const repaint = this.#cursorHidden && /\u001b\[(?:1;1)?H/.test(text);
    if (!resize && !repaint) return;
    this.#redraw = new Map();
    for (const line of this.#history)
      this.#redraw.set(line, (this.#redraw.get(line) ?? 0) + 1);
  }

  #endRedraw(text) {
    if (/\u001b\[\?25h/.test(text)) {
      this.#redraw = null;
      this.#cursorHidden = false;
    }
  }
}

module.exports = {
  PtyEventSplitter,
  isEventLine,
  couldBecomeEvent,
  stripAnsi,
  NOTICES,
};
