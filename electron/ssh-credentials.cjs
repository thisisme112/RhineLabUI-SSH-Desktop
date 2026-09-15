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

/** A connection-local broker. Prompt wording is never the credential identity. */
class SshCredentials {
  constructor({ vault, target, endpoint, launch }) {
    this.vault = vault;
    this.target = target;
    this.endpoint = endpoint;
    this.launch = launch;
    this.memory = new Map();
    this.attempts = new Map();
    this.pending = new Map();
  }
  identity(prompt, method, peer) {
    // A password prompt omits the port. Only a preceding OpenSSH handshake can
    // establish which target (or jump host) is actually asking for the secret.
    if (!prompt || !sameEndpoint(peer, this.endpoint)) return null;
    if (prompt.kind === "password") {
      if (method !== "password") return null;
      const match = String(prompt.prompt)
        .trim()
        .match(/^(.+?)@(.+?)'s\s+password:\s*$/i);
      if (
        !match ||
        match[1] !== this.endpoint.user ||
        hostName(match[2]) !== hostName(this.endpoint.host)
      )
        return null;
      return "";
    }
    if (prompt.kind !== "passphrase" || method !== "publickey") return null;
    const file =
      prompt.key ||
      String(prompt.prompt).match(/passphrase for key ['"](.+?)['"]/i)?.[1];
    if (!file) return null;
    if (!matchesSelectedKey(file, this.launch, this.endpoint, prompt.keyHints))
      return null;
    return this.launch.keyId || keyPath(file);
  }
  automatic(prompt, fingerprint, method, connection = "primary", peer) {
    const identity = this.identity(prompt, method, peer);
    if (identity === null || !fingerprint) return null;
    const key = prompt.kind + ":" + identity,
      attempt = connection + ":" + key;
    if (this.attempts.has(attempt)) {
      const previous = this.attempts.get(attempt);
      if (this.memory.get(key)?.value === previous) this.memory.delete(key);
      this.pending.delete(connection + ":" + key);
      try {
        this.vault?.invalidate(
          this.target,
          prompt.kind,
          this.endpoint,
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
        this.target,
        prompt.kind,
        this.endpoint,
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
    const identity = this.identity(prompt, method, peer);
    if (identity === null || !fingerprint) return false;
    const key = prompt.kind + ":" + identity;
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
    });
    return true;
  }
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
              this.target,
              item.kind,
              item.value,
              this.endpoint,
              item.identity,
              item.fingerprint,
            );
          else if (item.bind)
            this.vault?.confirm(
              this.target,
              item.kind,
              this.endpoint,
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
