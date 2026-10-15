"use strict";
const fs = require("node:fs");
const path = require("node:path");

/**
 * The maids' half in the main process (the Unreal build's RhineClaude.cpp Seal/Unseal and its HTTP): each maid's API
 * key, sealed with the system's encryption for this account (safeStorage) and never handed to the page; the requests
 * to her API, made here with her key added (the page names the URL and the body, never the key); and her sealed
 * records on disk, the conversations and the command history.
 *
 * ANTHROPIC_API_KEY and DEEPSEEK_API_KEY in the environment are used when nothing is saved.
 */
const WHO = ["claude", "deepseek"];
const ENV = { claude: "ANTHROPIC_API_KEY", deepseek: "DEEPSEEK_API_KEY" };
const RECORDS = { history: "maid-history.bin", commands: "maid-commands.bin" };
const MAX_RECORD = 32 * 1024 * 1024;
const MAX_BODY = 8 * 1024 * 1024;

/** An https URL, or plain http to this machine (a local stand-in or a self-hosted model). */
function allowedUrl(value) {
  let url;
  try { url = new URL(String(value)); } catch { return false; }
  if (url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
}

class MaidAssistant {
  constructor(dir, safeStorage) {
    this.dir = dir;
    this.safeStorage = safeStorage;
    this.keysFile = path.join(dir, "maid-keys.json");
    this.requests = new Map();
  }

  readKeys() {
    try {
      const data = JSON.parse(fs.readFileSync(this.keysFile, "utf8"));
      return data && typeof data === "object" ? data : {};
    } catch { return {}; }
  }

  writeKeys(keys) {
    fs.mkdirSync(this.dir, { recursive: true });
    const temporary = this.keysFile + ".tmp";
    fs.writeFileSync(temporary, JSON.stringify(keys), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, this.keysFile);
  }

  keyOf(who) {
    const sealed = this.readKeys()[who];
    if (typeof sealed === "string" && sealed && this.safeStorage.isEncryptionAvailable()) {
      try { return this.safeStorage.decryptString(Buffer.from(sealed, "base64")); } catch { /* sealed for another account: as if none */ }
    }
    return String(process.env[ENV[who]] || "").trim();
  }

  /** Where each maid's key comes from: "saved", "env" or "". */
  status() {
    const keys = this.readKeys(), out = {};
    for (const who of WHO) {
      let saved = false;
      if (typeof keys[who] === "string" && keys[who] && this.safeStorage.isEncryptionAvailable())
        try { saved = Boolean(this.safeStorage.decryptString(Buffer.from(keys[who], "base64"))); } catch { saved = false; }
      out[who] = saved ? "saved" : String(process.env[ENV[who]] || "").trim() ? "env" : "";
    }
    return { ok: true, keys: out, available: this.safeStorage.isEncryptionAvailable() };
  }

  save(who, key) {
    if (!WHO.includes(who)) return { ok: false, error: "不认识这位看板娘" };
    const value = String(key ?? "").trim();
    if (value.length < 20 || value.length > 512 || /\s/.test(value)) return { ok: false, error: "这不像一个 API key" };
    if (!this.safeStorage.isEncryptionAvailable()) return { ok: false, error: "当前系统账户的加密存储不可用，密钥未保存" };
    const keys = this.readKeys();
    keys[who] = this.safeStorage.encryptString(value).toString("base64");
    this.writeKeys(keys);
    return this.status();
  }

  forget(who) {
    if (!WHO.includes(who)) return { ok: false, error: "不认识这位看板娘" };
    const keys = this.readKeys();
    delete keys[who];
    this.writeKeys(keys);
    return this.status();
  }

  /**
   * POSTs `body` (JSON) to `url` with the maid's key: `x-api-key` and the Anthropic version for "anthropic", a bearer
   * token for "bearer". Resolves with the status and the response's text; status 0 when it never connected.
   */
  async request(input) {
    const who = input?.who, id = String(input?.id ?? "");
    if (!WHO.includes(who)) return { ok: false, status: 0, text: "", error: "不认识这位看板娘" };
    if (!allowedUrl(input.url)) return { ok: false, status: 0, text: "", error: "接入点必须是 https 地址（或本机的 http）" };
    const body = typeof input.body === "string" ? input.body : JSON.stringify(input.body ?? {});
    if (body.length > MAX_BODY) return { ok: false, status: 0, text: "", error: "请求太大" };
    const key = this.keyOf(who);
    if (!key) return { ok: false, status: 0, text: "", error: "no key" };
    const headers = { "content-type": "application/json" };
    if (input.auth === "anthropic") {
      headers["x-api-key"] = key;
      headers["anthropic-version"] = "2023-06-01";
      if (typeof input.beta === "string" && /^[\w.,-]{1,300}$/.test(input.beta)) headers["anthropic-beta"] = input.beta;
      if (typeof input.workspace === "string" && /^[\w-]{1,128}$/.test(input.workspace)) headers["anthropic-workspace-id"] = input.workspace;
    } else headers.authorization = `Bearer ${key}`;
    const controller = new AbortController();
    const timeout = Math.min(600, Math.max(5, Number(input.timeout) || 60)) * 1000;
    const timer = setTimeout(() => controller.abort(), timeout);
    if (id) this.requests.get(id)?.abort();
    if (id) this.requests.set(id, controller);
    try {
      const response = await fetch(input.url, { method: "POST", headers, body, signal: controller.signal });
      const text = await response.text();
      return { ok: true, status: response.status, text: text.slice(0, MAX_BODY) };
    } catch (error) {
      return { ok: false, status: 0, text: "", error: controller.signal.aborted ? "aborted" : String(error?.message || error) };
    } finally {
      clearTimeout(timer);
      if (id && this.requests.get(id) === controller) this.requests.delete(id);
    }
  }

  cancel(id) {
    this.requests.get(String(id))?.abort();
    this.requests.delete(String(id));
    return { ok: true };
  }

  /** A sealed record ("history" or "commands"): its text, or "" when there is none or it cannot be opened. */
  read(name) {
    const file = RECORDS[name];
    if (!file) return { ok: false, error: "记录名无效" };
    try {
      const full = path.join(this.dir, file);
      if (!fs.existsSync(full)) return { ok: true, text: "" };
      if (fs.statSync(full).size > MAX_RECORD) return { ok: false, error: "记录文件太大" };
      if (!this.safeStorage.isEncryptionAvailable()) return { ok: false, error: "加密存储不可用" };
      return { ok: true, text: this.safeStorage.decryptString(fs.readFileSync(full)) };
    } catch (error) { return { ok: false, error: String(error?.message || error) }; }
  }

  write(name, text) {
    const file = RECORDS[name];
    if (!file) return { ok: false, error: "记录名无效" };
    if (typeof text !== "string" || text.length > MAX_RECORD) return { ok: false, error: "记录太大" };
    if (!this.safeStorage.isEncryptionAvailable()) return { ok: false, error: "加密存储不可用" };
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const full = path.join(this.dir, file), temporary = full + ".tmp";
      fs.writeFileSync(temporary, this.safeStorage.encryptString(text), { mode: 0o600 });
      fs.renameSync(temporary, full);
      return { ok: true };
    } catch (error) { return { ok: false, error: String(error?.message || error) }; }
  }

  remove(name) {
    const file = RECORDS[name];
    if (!file) return { ok: false, error: "记录名无效" };
    try { fs.rmSync(path.join(this.dir, file), { force: true }); return { ok: true }; }
    catch (error) { return { ok: false, error: String(error?.message || error) }; }
  }
}

module.exports = { MaidAssistant, allowedUrl };
