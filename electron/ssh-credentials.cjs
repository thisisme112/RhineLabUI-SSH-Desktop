"use strict";
const path = require("node:path");

const hostName = (value) =>
  String(value || "")
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
const keyPath = (value) => {
  const file = path.resolve(String(value || "")).replaceAll("\\", "/");
  return process.platform === "win32" ? file.toLowerCase() : file;
};
const sameEndpoint = (left, right) =>
  Boolean(
    left &&
    right &&
    hostName(left.host) === hostName(right.host) &&
    Number(left.port) === Number(right.port) &&
    left.user === right.user,
  );
function matchesSelectedKey(file, launch, endpoint, keyHints) {
  const hints = keyHints?.length ? keyHints : [file];
  if (!launch.identityFile)
    return hints.length === 1 && Buffer.byteLength(file, "utf8") !== 100;
  if (hints.length === 1 && keyPath(file) === keyPath(launch.identityFile))
    return true;
  // OpenSSH prints %.100s in the passphrase prompt. A truncated path is only
  // usable when ssh -G proves exactly one effective identity has that prefix.
  if (!endpoint.identityFiles) return false;
  const files = endpoint.identityFiles.filter((value) => value !== "none");
  if (files.some((value) => value.startsWith("~") || value.includes("%")))
    return false;
  const identities = new Map(files.map((value) => [keyPath(value), value]));
  const matches = [...identities]
    .filter(([value, original]) =>
      hints.some((hint) => {
        if (value === keyPath(hint)) return true;
        // A byte-limited prompt may end inside a UTF-8 code point. Compare the
        // actual 100-byte representation, including its replacement character.
        return (
          Buffer.byteLength(original, "utf8") > 100 &&
          keyPath(
            Buffer.from(original, "utf8").subarray(0, 100).toString("utf8"),
          ) === keyPath(hint)
        );
      }),
    )
    .map(([value]) => value);
  return matches.length === 1 && matches[0] === keyPath(launch.identityFile);
}

const account = (endpoint) =>
  `${endpoint.user ? endpoint.user + "@" : ""}${endpoint.host}:${endpoint.port}`;

/** A connection-local broker. Prompt wording is never the credential identity. */
class SshCredentials {
  /**
   * `hops` are the saved jump hosts on the way, each `{ target, label,
   * endpoint, launch }`: a prompt from a jump host is answered with that
   * host's own secret, and never with the destination's (RhineCredentials.h).
   */
  constructor({ vault, target, endpoint, launch, hops = [], label = "" }) {
    this.vault = vault;
    this.target = target;
    this.endpoint = endpoint;
    this.launch = launch;
    this.label = label || target;
    this.destination = { target, endpoint, launch, label: this.label };
    this.hops = hops.filter((hop) => hop?.endpoint);
    this.memory = new Map();
    this.attempts = new Map();
    this.pending = new Map();
  }
  /** Whose secret a handshake with `peer` asks for: the destination's or one hop's. */
  scope(peer) {
    if (sameEndpoint(peer, this.endpoint)) return this.destination;
    return this.hops.find((hop) => sameEndpoint(peer, hop.endpoint)) ?? null;
  }
  identity(prompt, method, peer) {
    return this.claim(prompt, method, peer)?.identity ?? null;
  }
  /** The scope and identity a prompt's secret belongs to, or null when it is nobody's here. */
  claim(prompt, method, peer) {
    // A password prompt omits the port. Only a preceding OpenSSH handshake can
    // establish which target (or jump host) is actually asking for the secret.
    const scope = prompt ? this.scope(peer) : null;
    if (!scope) return null;
    if (prompt.kind === "password") {
      if (method !== "password") return null;
      const match = String(prompt.prompt)
        .trim()
        .match(/^(.+?)@(.+?)'s\s+password:\s*$/i);
      if (
        !match ||
        match[1] !== scope.endpoint.user ||
        hostName(match[2]) !== hostName(scope.endpoint.host)
      )
        return null;
      return { scope, identity: "" };
    }
    if (prompt.kind !== "passphrase" || method !== "publickey") return null;
    const file =
      prompt.key ||
      String(prompt.prompt).match(/passphrase for key ['"](.+?)['"]/i)?.[1];
    if (!file) return null;
    if (!matchesSelectedKey(file, scope.launch, scope.endpoint, prompt.keyHints))
      return null;
    return { scope, identity: scope.launch.keyId || keyPath(file) };
  }
  /**
   * Who asks, for the prompt surface only (answering goes through `claim`):
   * a saved jump host by name, a free-form one by address, else the destination.
   */
  asking(prompt, peer) {
    let scope = this.scope(peer);
    // A narrow or redrawn console may not have shown the handshake yet; the
    // password prompt still names its account.
    const named = !scope && prompt?.kind === "password" &&
      String(prompt.prompt).trim().match(/^(.+?)@(.+?)'s\s+password:\s*$/i);
    if (named)
      scope = [this.destination, ...this.hops].find((item) => item.endpoint &&
        item.endpoint.user === named[1] && hostName(item.endpoint.host) === hostName(named[2])) ?? null;
    if (scope && scope !== this.destination)
      return { asking: `跳板机 ${scope.label} · ${account(scope.endpoint)}`, jump: true };
    if (scope) return { asking: `${this.label} · ${account(scope.endpoint)}`, jump: false };
    if (peer?.host && this.endpoint && (this.launch?.jumpHost || this.endpoint.viaProxy))
      return { asking: `跳板机 ${account(peer)}`, jump: true };
    return null;
  }
  automatic(prompt, fingerprint, method, connection = "primary", peer) {
    const claim = this.claim(prompt, method, peer);
    if (!claim || !fingerprint) return null;
    const { scope, identity } = claim;
    const key = scope.target + ":" + prompt.kind + ":" + identity,
      attempt = connection + ":" + key;
    if (this.attempts.has(attempt)) {
      const previous = this.attempts.get(attempt);
      if (this.memory.get(key)?.value === previous) this.memory.delete(key);
      this.pending.delete(connection + ":" + key);
      try {
        this.vault?.invalidate(
          scope.target,
          prompt.kind,
          scope.endpoint,
          identity,
          previous,
        );
      } catch {
        /* Manual authentication remains available. */
      }
      return null;
    }
    let value =
      this.memory.get(key)?.fingerprint === fingerprint
        ? this.memory.get(key).value
        : null;
    try {
      value ??= this.vault?.get(
        scope.target,
        prompt.kind,
        scope.endpoint,
        identity,
        fingerprint,
      );
    } catch {
      return null;
    }
    if (value === null || value === undefined) return null;
    this.remember(
      prompt,
      value,
      fingerprint,
      method,
      false,
      connection,
      prompt.source || "primary",
      peer,
      true,
    );
    return value;
  }
  remember(
    prompt,
    value,
    fingerprint,
    method,
    persist,
    connection = "primary",
    source = "primary",
    peer,
    bind = false,
  ) {
    const claim = this.claim(prompt, method, peer);
    if (!claim || !fingerprint) return false;
    const { scope, identity } = claim;
    const key = scope.target + ":" + prompt.kind + ":" + identity;
    // Rejecting a manual answer must also prevent its reuse by a new prompt.
    this.attempts.set(connection + ":" + key, value);
    this.pending.set(connection + ":" + key, {
      kind: prompt.kind,
      value,
      fingerprint,
      identity,
      source,
      persist,
      bind,
      key,
      scope,
    });
    return true;
  }
  /**
   * The connection reached its destination, so every hop on the way accepted
   * its answer too: only now are typed secrets saved and saved ones bound.
   */
  authenticated(source = "primary") {
    let failure;
    for (const [id, item] of this.pending)
      if (item.source === source) {
        // Do not share a just-typed, unverified answer with other connections.
        this.memory.set(item.key, {
          value: item.value,
          fingerprint: item.fingerprint,
        });
        this.pending.delete(id);
        try {
          if (item.persist)
            this.vault?.put(
              item.scope.target,
              item.kind,
              item.value,
              item.scope.endpoint,
              item.identity,
              item.fingerprint,
            );
          else if (item.bind)
            this.vault?.confirm(
              item.scope.target,
              item.kind,
              item.scope.endpoint,
              item.identity,
              item.fingerprint,
              item.value,
            );
        } catch (error) {
          failure = error;
        }
      }
    if (failure) throw failure;
  }
  clear() {
    this.memory.clear();
    this.attempts.clear();
    this.pending.clear();
  }
}
module.exports = { SshCredentials, sameEndpoint, keyPath };
