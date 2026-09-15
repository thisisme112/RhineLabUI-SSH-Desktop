/**
 * Parser for the OpenSSH client diagnostics observed from `ssh -v`.
 *
 * This module is the single source of truth for every connection animation: the
 * UI never advances a phase on a timer, only on one of the events below. A line
 * the table does not recognise is reported as `matched: false` and kept
 * verbatim, so an unfamiliar OpenSSH version degrades to "phase unknown"
 * instead of silently faking progress (see DESKTOP-SSH.md, rule R4).
 *
 * Measured against OpenSSH_for_Windows_9.5p2; the `debug1:` shapes quoted in
 * the table were captured from a real handshake, the rest follow the formats
 * OpenSSH has emitted unchanged for many releases.
 */

export type SshEventName =
  // success path
  | "config.loaded"
  | "tcp.connecting"
  | "tcp.established"
  | "identity.scanned"
  | "banner.local"
  | "banner.remote"
  | "kex.algorithms"
  | "kex.ciphers"
  | "hostkey.received"
  | "hostkey.verified"
  | "hostkey.unknown"
  | "auth.methods"
  | "auth.offering"
  | "auth.accepted"
  | "auth.succeeded"
  | "session.entering"
  | "session.authenticated"
  // failure paths — real states, not exceptions
  | "dns.failed"
  | "tcp.failed"
  | "kex.reset"
  | "hostkey.mismatch"
  | "auth.denied"
  | "session.closed";

export type SshEvent = {
  name: SshEventName;
  /** Fields lifted from the line. Every value is shown to the user verbatim. */
  detail: Record<string, string>;
  /** The line that produced this event, unmodified. */
  raw: string;
};

export type ParsedLine =
  { matched: true; event: SshEvent } | { matched: false; raw: string };

type Matcher = {
  name: SshEventName;
  re: RegExp;
  detail?: (match: RegExpMatchArray) => Record<string, string>;
};

/** Debug lines carry a level prefix that varies with `-v` / `-vv`. */
const D = String.raw`debug\d+:\s`;

const MATCHERS: Matcher[] = [
  // ── configuration ────────────────────────────────────────────────────────
  {
    name: "config.loaded",
    re: new RegExp(String.raw`^${D}Reading configuration data (.+)$`),
    detail: (m) => ({ path: m[1] }),
  },

  // ── TCP ──────────────────────────────────────────────────────────────────
  {
    // "Connecting to host [1.2.3.4] port 22." when a name is given, and
    // "Connecting to 1.2.3.4 port 22." when an address is given directly.
    name: "tcp.connecting",
    re: new RegExp(
      String.raw`^${D}Connecting to (.+?)(?: \[(.+?)\])? port (\d+)\.$`,
    ),
    detail: (m) => ({
      host: m[1],
      ...(m[2] ? { address: m[2] } : {}),
      port: m[3],
    }),
  },
  {
    name: "tcp.established",
    re: new RegExp(String.raw`^${D}Connection established\.$`),
  },

  // ── local identity ───────────────────────────────────────────────────────
  {
    // `type -1` means the key file does not exist; that is information, not an
    // error, and the UI shows it as such.
    name: "identity.scanned",
    re: new RegExp(String.raw`^${D}identity file (.+) type (-?\d+)$`),
    detail: (m) => ({
      path: m[1],
      type: m[2],
      present: String(Number(m[2]) !== -1),
    }),
  },

  // ── version exchange ─────────────────────────────────────────────────────
  {
    name: "banner.local",
    re: new RegExp(String.raw`^${D}Local version string (.+)$`),
    detail: (m) => ({ banner: m[1] }),
  },
  {
    name: "banner.remote",
    re: new RegExp(
      String.raw`^${D}Remote protocol version (\S+), remote software version (.+)$`,
    ),
    detail: (m) => ({ protocol: m[1], software: m[2] }),
  },

  // ── key exchange ─────────────────────────────────────────────────────────
  {
    name: "kex.algorithms",
    re: new RegExp(String.raw`^${D}kex: algorithm: (\S+)$`),
    detail: (m) => ({ kex: m[1] }),
  },
  {
    name: "kex.algorithms",
    re: new RegExp(String.raw`^${D}kex: host key algorithm: (\S+)$`),
    detail: (m) => ({ hostKeyAlgorithm: m[1] }),
  },
  {
    name: "kex.ciphers",
    re: new RegExp(
      String.raw`^${D}kex: (server->client|client->server) cipher: (\S+) MAC: (\S+) compression: (\S+)$`,
    ),
    detail: (m) => ({
      direction: m[1],
      cipher: m[2],
      mac: m[3],
      compression: m[4],
    }),
  },

  // ── host key ─────────────────────────────────────────────────────────────
  {
    name: "hostkey.received",
    re: new RegExp(String.raw`^${D}Server host key: (\S+) (SHA256:\S+)`),
    detail: (m) => ({ type: m[1], fingerprint: m[2] }),
  },
  {
    name: "hostkey.verified",
    re: new RegExp(
      String.raw`^${D}Host '(.+)' is known and matches the (\S+) host key\.`,
    ),
    detail: (m) => ({ host: m[1], type: m[2] }),
  },
  {
    name: "hostkey.verified",
    re: new RegExp(String.raw`^${D}Found key in (.+):(\d+)$`),
    detail: (m) => ({ knownHosts: m[1], line: m[2] }),
  },
  {
    name: "hostkey.unknown",
    re: /^The authenticity of host '(.+)' can't be established\.$/,
    detail: (m) => ({ host: m[1] }),
  },
  {
    name: "hostkey.unknown",
    re: /^(\S+) key fingerprint is (SHA256:\S+)\.$/,
    detail: (m) => ({ type: m[1], fingerprint: m[2] }),
  },
  {
    name: "hostkey.mismatch",
    re: /WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!/,
  },
  {
    name: "hostkey.mismatch",
    re: new RegExp(String.raw`^(?:${D})?Host key verification failed\.$`),
  },

  // ── authentication ───────────────────────────────────────────────────────
  {
    name: "auth.methods",
    re: new RegExp(String.raw`^${D}Authentications that can continue: (.+)$`),
    detail: (m) => ({
      methods: m[1],
      list: m[1]
        .split(",")
        .map((entry) => entry.trim())
        .join(" "),
    }),
  },
  {
    name: "auth.offering",
    re: new RegExp(String.raw`^${D}Offering public key: (.+)$`),
    detail: (m) => fingerprintTail(m[1]),
  },
  {
    name: "auth.accepted",
    re: new RegExp(String.raw`^${D}Server accepts key: (.+)$`),
    detail: (m) => fingerprintTail(m[1]),
  },
  {
    name: "auth.succeeded",
    re: new RegExp(String.raw`^${D}Authentication succeeded \((\S+)\)\.$`),
    detail: (m) => ({ method: m[1] }),
  },

  // ── session ──────────────────────────────────────────────────────────────
  {
    name: "session.entering",
    re: new RegExp(String.raw`^${D}Entering interactive session\.$`),
  },
  {
    name: "session.authenticated",
    re: new RegExp(String.raw`^${D}pledge: (.+)$`),
    detail: (m) => ({ pledge: m[1] }),
  },

  // ── failure paths ────────────────────────────────────────────────────────
  {
    name: "dns.failed",
    re: /^ssh: Could not resolve hostname (\S+): (.+)$/,
    detail: (m) => ({ host: m[1], reason: m[2] }),
  },
  {
    name: "tcp.failed",
    re: /^ssh: connect to host (.+?) port (\d+): (.+)$/,
    detail: (m) => ({ host: m[1], port: m[2], reason: m[3] }),
  },
  {
    // A real client prefixes this with its debug level — measured as
    // `debug1: kex_exchange_identification: write: Connection refused` — so the
    // prefix is optional rather than the line going unrecognised.
    name: "kex.reset",
    re: new RegExp(String.raw`^(?:${D})?kex_exchange_identification: (.+)$`),
    detail: (m) => ({ reason: m[1] }),
  },
  {
    name: "auth.denied",
    re: /^Permission denied \((.+)\)\.$/,
    detail: (m) => ({ methods: m[1] }),
  },
  {
    name: "session.closed",
    re: /^Connection closed by (.+?) port (\d+)$/,
    detail: (m) => ({ host: m[1], port: m[2] }),
  },
  {
    name: "session.closed",
    re: /^Connection to (.+) closed\.$/,
    detail: (m) => ({ host: m[1] }),
  },
  {
    name: "session.closed",
    re: /^Shared connection to (.+) closed\.$/,
    detail: (m) => ({ host: m[1] }),
  },
];

/** `path TYPE SHA256:…` → keep the fingerprint when present. */
function fingerprintTail(rest: string): Record<string, string> {
  const match = rest.match(/^(.*?)\s+(SHA256:\S+)\s*$/);
  if (!match) return { target: rest.trim() };
  return { target: match[1].trim(), fingerprint: match[2] };
}

/**
 * Parse one log line. Never throws: an unparsable line is a legitimate result
 * that the caller must keep in the raw stream.
 */
export function parseSshLine(line: string): ParsedLine {
  const trimmed = line.replace(/\r$/, "");
  if (!trimmed.trim()) return { matched: false, raw: trimmed };
  for (const matcher of MATCHERS) {
    const match = trimmed.match(matcher.re);
    if (!match) continue;
    return {
      matched: true,
      event: {
        name: matcher.name,
        detail: matcher.detail ? matcher.detail(match) : {},
        raw: trimmed,
      },
    };
  }
  return { matched: false, raw: trimmed };
}

/** The subset of events that can only mean "this connection is over". */
export const TERMINAL_EVENTS: ReadonlySet<SshEventName> = new Set<SshEventName>(
  [
    "dns.failed",
    "tcp.failed",
    "kex.reset",
    "hostkey.mismatch",
    "auth.denied",
    "session.closed",
  ],
);

/**
 * Notices OpenSSH prints on the pty rather than in the debug log. They are the
 * only evidence for some endings — answering "no" to an unknown host key prints
 * `Host key verification failed.` on stderr and exits, leaving the log silent.
 *
 * Deliberately narrow. The pty also carries everything the shell prints, so a
 * user catting a file must not be able to end the session state: only
 * unambiguous *failure* notices qualify. A normal ending needs no help — the
 * process exit status covers it (`SshSessionTracker.ended`).
 */
const PTY_NOTICE_NAMES: ReadonlySet<SshEventName> = new Set<SshEventName>([
  "hostkey.mismatch",
  "auth.denied",
  "tcp.failed",
  "dns.failed",
  "kex.reset",
]);

const PTY_NOTICES: { re: RegExp; name: SshEventName }[] = [
  { re: /^Host key verification failed\.$/, name: "hostkey.mismatch" },
  { re: /^Permission denied \(.+\)\.$/, name: "auth.denied" },
  { re: /^ssh: connect to host (.+?) port (\d+): (.+)$/, name: "tcp.failed" },
  { re: /^ssh: Could not resolve hostname (\S+): (.+)$/, name: "dns.failed" },
  {
    re: /^(?:debug\d+: )?kex_exchange_identification: (.+)$/,
    name: "kex.reset",
  },
];

/** Parse one line of terminal output. Returns null for ordinary session text. */
export function parsePtyNotice(line: string): SshEvent | null {
  const trimmed = line.replace(/\r$/, "").trim();
  if (!trimmed) return null;
  const parsed = parseSshLine(trimmed);
  if (parsed.matched && PTY_NOTICE_NAMES.has(parsed.event.name))
    return parsed.event;
  for (const notice of PTY_NOTICES) {
    const match = trimmed.match(notice.re);
    if (match) {
      const detail: Record<string, string> = {};
      if (match[1]) detail.host = match[1];
      if (match[2]) detail.reason = match[2];
      if (match[3]) detail.reason = match[3];
      return { name: notice.name, detail, raw: trimmed };
    }
  }
  return null;
}
