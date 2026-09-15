"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { execFileSync, spawn } = require("node:child_process");

const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const endpointKey = (endpoint) =>
  JSON.stringify([
    String(endpoint?.host || "").toLowerCase(),
    Number(endpoint?.port) || 22,
    endpoint?.user || "",
  ]);
const validSecret = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 16384 &&
  !/[\0\r\n]/.test(value);
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const fingerprintValue = (value) =>
  typeof value === "string" &&
  (value === "" || /^SHA256:[A-Za-z0-9+/=]{1,128}$/.test(value));
const encryptedValue = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 256 * 1024 &&
  /^[A-Za-z0-9+/]+={0,2}$/.test(value);
const validText = (value, max) =>
  typeof value === "string" && value.length <= max && !/[\0\r\n]/.test(value);

/** Persistent secrets are encrypted; imported keys have short-lived private
 * runtime files for OpenSSH. Never expose a read-secret IPC. */
class CredentialVault {
  constructor(file, encryption, inspectKey) {
    this.file = file;
    this.encryption = encryption;
    this.inspectKey = inspectKey;
    this.runtime = path.join(path.dirname(file), "ssh-key-runtime");
    this.leases = new Map();
    this.runtimeReady = false;
  }
  read() {
    if (!fs.existsSync(this.file))
      return { version: 1, credentials: {}, keys: [] };
    const stat = fs.lstatSync(this.file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024)
      throw new Error("凭据库文件无效，原文件已保留");
    let data;
    try {
      data = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      throw new Error("凭据库无法读取，原文件已保留");
    }
    if (
      data?.version !== 1 ||
      !data.credentials ||
      typeof data.credentials !== "object" ||
      Array.isArray(data.credentials) ||
      !Array.isArray(data.keys)
    )
      throw new Error("凭据库版本不受支持，原文件已保留");
    const credentials = Object.entries(data.credentials);
    if (
      credentials.length > 4096 ||
      data.keys.length > 256 ||
      credentials.some(
        ([id, item]) =>
          !/^[a-f0-9]{64}$/.test(id) ||
          !item ||
          !validText(item.target, 1024) ||
          !item.target ||
          !["password", "passphrase"].includes(item.kind) ||
          !validText(item.binding, 8192) ||
          !validText(item.identity, 4096) ||
          !fingerprintValue(item.fingerprint) ||
          !encryptedValue(item.encrypted) ||
          typeof item.invalid !== "boolean",
      ) ||
      data.keys.some(
        (key) =>
          !key ||
          !uuid.test(key.id) ||
          !validText(key.name, 80) ||
          !key.name ||
          !validText(key.type, 128) ||
          !fingerprintValue(key.fingerprint) ||
          typeof key.protected !== "boolean" ||
          typeof key.contentHash !== "string" ||
          !/^[a-f0-9]{64}$/.test(key.contentHash) ||
          (key.source === "file"
            ? !validText(key.file, 4096) || !path.isAbsolute(key.file)
            : key.source !== "import" || !encryptedValue(key.encrypted)),
      ) ||
      new Set(data.keys.map((key) => key.id)).size !== data.keys.length
    )
      throw new Error("凭据库条目无效，原文件已保留");
    return data;
  }
  write(data) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = this.file + "." + randomUUID() + ".tmp";
    const contents = JSON.stringify(data);
    if (Buffer.byteLength(contents) > 8 * 1024 * 1024)
      throw new Error("凭据库超过 8 MiB，原文件已保留");
    try {
      fs.writeFileSync(temporary, contents, { flag: "wx", mode: 0o600 });
      fs.renameSync(temporary, this.file);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
  encrypt(value) {
    if (!this.encryption.isEncryptionAvailable())
      throw new Error("当前系统账户的加密存储不可用，凭据未保存");
    return this.encryption.encryptString(value).toString("base64");
  }
  decrypt(value) {
    try {
      return this.encryption.decryptString(Buffer.from(value, "base64"));
    } catch {
      throw new Error("当前系统账户无法解密此凭据，请重新保存");
    }
  }
  status(target, endpoint, identity) {
    const values = Object.values(this.read().credentials).filter(
      (item) => item.target === target,
    );
    const state = (kind) =>
      values.some(
        (item) =>
          item.kind === kind &&
          !item.invalid &&
          (!endpoint || item.binding === endpointKey(endpoint)) &&
          (kind !== "passphrase" ||
            identity === undefined ||
            item.identity === identity),
      )
        ? "saved"
        : values.some((item) => item.kind === kind)
          ? "needs-update"
          : "none";
    return {
      password: state("password"),
      passphrase: state("passphrase"),
      available: this.encryption.isEncryptionAvailable(),
    };
  }
  put(target, kind, value, endpoint, identity = "", fingerprint = "") {
    if (
      !["password", "passphrase"].includes(kind) ||
      !validSecret(value) ||
      !validText(target, 1024) ||
      !target ||
      !validText(endpoint?.host, 1024) ||
      !endpoint.host ||
      !validText(endpoint.user, 128) ||
      !Number.isInteger(endpoint.port) ||
      endpoint.port < 1 ||
      endpoint.port > 65535 ||
      !validText(identity, 4096) ||
      !fingerprintValue(fingerprint)
    )
      throw new Error("凭据内容无效");
    const binding = endpointKey(endpoint),
      id = digest([target, kind, binding, identity]);
    const encrypted = this.encrypt(value),
      data = this.read();
    data.credentials[id] = {
      target,
      kind,
      binding,
      identity,
      fingerprint: fingerprint || data.credentials[id]?.fingerprint || "",
      encrypted,
      invalid: false,
    };
    this.write(data);
  }
  get(target, kind, endpoint, identity, fingerprint) {
    const data = this.read(),
      item =
        data.credentials[
          digest([target, kind, endpointKey(endpoint), identity || ""])
        ];
    if (!item || item.invalid || !fingerprint) return null;
    if (item.fingerprint && item.fingerprint !== fingerprint) {
      this.invalidate(target, kind, endpoint, identity);
      return null;
    }
    try {
      return this.decrypt(item.encrypted);
    } catch (error) {
      this.invalidate(target, kind, endpoint, identity);
      throw error;
    }
  }
  confirm(target, kind, endpoint, identity, fingerprint, expectedValue) {
    const data = this.read(),
      item =
        data.credentials[
          digest([target, kind, endpointKey(endpoint), identity || ""])
        ];
    if (
      !item ||
      item.invalid ||
      item.fingerprint ||
      !fingerprintValue(fingerprint) ||
      !fingerprint
    )
      return;
    if (
      expectedValue !== undefined &&
      this.decrypt(item.encrypted) !== expectedValue
    )
      return;
    item.fingerprint = fingerprint;
    this.write(data);
  }
  invalidate(target, kind, endpoint, identity = "", expectedValue) {
    const data = this.read(),
      item =
        data.credentials[
          digest([target, kind, endpointKey(endpoint), identity])
        ];
    // Another session or the editor may have replaced this value while the
    // previous authentication attempt was in flight.
    if (
      item &&
      expectedValue !== undefined &&
      this.decrypt(item.encrypted) !== expectedValue
    )
      return;
    if (item && !item.invalid) {
      item.invalid = true;
      this.write(data);
    }
  }
  remove(target, kind) {
    const data = this.read();
    for (const [id, item] of Object.entries(data.credentials))
      if (item.target === target && (!kind || item.kind === kind))
        delete data.credentials[id];
    this.write(data);
  }
  listKeys() {
    return this.read().keys.map((key) => ({
      id: key.id,
      name: key.name,
      source: key.source,
      type: key.type,
      fingerprint: key.fingerprint,
      protected: key.protected,
      ...(key.source === "file"
        ? { file: key.file, missing: !fs.existsSync(key.file) }
        : {}),
    }));
  }
  async addKey(input) {
    if (
      !input ||
      !["file", "import"].includes(input.source) ||
      (input.name !== undefined && !validText(input.name, 80)) ||
      (input.passphrase !== undefined &&
        input.passphrase !== "" &&
        !validSecret(input.passphrase))
    )
      throw new Error("密钥来源或名称无效");
    let content;
    if (input.source === "file") {
      if (!validText(input.file, 4096) || !path.isAbsolute(input.file))
        throw new Error("请选择私钥文件");
      const stat = fs.statSync(input.file);
      if (!stat.isFile() || stat.size > 128 * 1024)
        throw new Error("私钥文件类型或大小无效");
      content = fs.readFileSync(input.file, "utf8");
    } else content = input.content;
    if (typeof content !== "string" || Buffer.byteLength(content) > 128 * 1024)
      throw new Error("私钥内容无效或超过 128 KiB");
    if (content.startsWith("PuTTY-User-Key-File"))
      throw new Error("请先将 PuTTY PPK 转换为 OpenSSH 私钥再导入");
    const info = await this.inspectKey(content, input.passphrase || "");
    if (
      !validText(info?.type, 128) ||
      !fingerprintValue(info.fingerprint) ||
      typeof info.protected !== "boolean"
    )
      throw new Error("密钥检查未返回有效元信息");
    const contentHash = createHash("sha256").update(content).digest("hex");
    const data = this.read();
    const existing =
      input.source === "file" &&
      data.keys.find(
        (key) =>
          key.source === "file" &&
          path.resolve(key.file) === path.resolve(input.file),
      );
    if (existing) {
      if (existing.contentHash !== contentHash) {
        if (this.leases.has(existing.id))
          throw new Error("该私钥仍被连接使用，请结束会话后更新文件引用");
        Object.assign(existing, {
          type: info.type,
          fingerprint: info.fingerprint,
          protected: info.protected,
          contentHash,
        });
        for (const item of Object.values(data.credentials))
          if (item.kind === "passphrase" && item.identity === existing.id)
            item.invalid = true;
        this.write(data);
      }
      return this.listKeys().find((key) => key.id === existing.id);
    }
    if (data.keys.length >= 256) throw new Error("最多保存 256 份密钥");
    const key = {
      id: randomUUID(),
      name:
        String(
          input.name || (input.file ? path.basename(input.file) : "导入密钥"),
        )
          .trim()
          .slice(0, 80) || "导入密钥",
      source: input.source,
      type: info.type,
      fingerprint: info.fingerprint,
      protected: info.protected,
      contentHash,
      ...(input.source === "file"
        ? { file: path.resolve(input.file) }
        : { encrypted: this.encrypt(content) }),
    };
    data.keys.push(key);
    this.write(data);
    return this.listKeys().find((item) => item.id === key.id);
  }
  removeKey(id) {
    if (typeof id !== "string" || !uuid.test(id))
      throw new Error("密钥编号无效");
    if (this.leases.has(id)) throw new Error("此密钥仍被运行中的连接使用");
    const data = this.read();
    data.keys = data.keys.filter((key) => key.id !== id);
    for (const [entry, item] of Object.entries(data.credentials))
      if (item.kind === "passphrase" && item.identity === id)
        delete data.credentials[entry];
    this.write(data);
  }
  prepareRuntime() {
    if (this.runtimeReady) return;
    fs.mkdirSync(this.runtime, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(this.runtime);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("密钥临时目录无效");
    if (process.platform === "win32") {
      // Replace the DACL atomically; disabling inheritance alone could leave
      // explicit grants on a pre-existing directory. The path is data, never
      // interpolated into PowerShell code.
      try {
        execFileSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `
        $ErrorActionPreference = 'Stop'
        $keyRuntimeSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
        $keyRuntimeAcl = New-Object System.Security.AccessControl.DirectorySecurity
        $keyRuntimeAcl.SetSecurityDescriptorSddlForm('D:P(A;OICI;FA;;;' + $keyRuntimeSid.Value + ')', [System.Security.AccessControl.AccessControlSections]::Access)
        [System.IO.Directory]::SetAccessControl($env:RHINE_SSH_KEY_RUNTIME, $keyRuntimeAcl)
      `,
          ],
          {
            windowsHide: true,
            stdio: "pipe",
            timeout: 10000,
            env: { ...process.env, RHINE_SSH_KEY_RUNTIME: this.runtime },
          },
        );
      } catch {
        throw new Error(
          "无法设置私钥临时目录权限，请检查当前账户对应用数据目录的访问权限",
        );
      }
    } else fs.chmodSync(this.runtime, 0o700);
    this.runtimeReady = true;
  }
  cleanupStale() {
    if (!fs.existsSync(this.runtime)) return;
    this.prepareRuntime();
    // Individual, app-created files only; never recursively remove a computed path.
    for (const name of fs.readdirSync(this.runtime))
      if (/^key-[a-f0-9-]{36}$/.test(name)) {
        const file = path.join(this.runtime, name);
        if (fs.lstatSync(file).isFile()) fs.unlinkSync(file);
      }
  }
  acquire(id) {
    const key = this.read().keys.find((item) => item.id === id);
    if (!key) throw new Error("所选密钥不存在，请重新选择");
    let lease = this.leases.get(id);
    if (!lease) {
      let file = key.file;
      if (key.source === "import") {
        this.prepareRuntime();
        file = path.join(this.runtime, "key-" + randomUUID());
        fs.writeFileSync(file, this.decrypt(key.encrypted), {
          flag: "wx",
          mode: 0o600,
        });
      } else {
        if (!fs.existsSync(file))
          throw new Error("私钥文件已移动或删除，请重新选择");
        const stat = fs.statSync(file);
        if (
          !stat.isFile() ||
          stat.size > 128 * 1024 ||
          (key.contentHash &&
            createHash("sha256").update(fs.readFileSync(file)).digest("hex") !==
              key.contentHash)
        )
          throw new Error("私钥文件已变化，请在密钥库中重新选择此文件");
      }
      lease = { file, count: 0, temporary: key.source === "import" };
      this.leases.set(id, lease);
    }
    lease.count++;
    let released = false;
    return {
      file: lease.file,
      identity: key.id,
      release: () => {
        if (released) return;
        released = true;
        if (--lease.count) return;
        this.leases.delete(id);
        if (lease.temporary && fs.existsSync(lease.file))
          fs.unlinkSync(lease.file);
      },
    };
  }
}

function inspectPrivateKey(executable, content, passphrase = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["--inspect-key"], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    let output = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("密钥检查超时"));
    }, 10000);
    child.on("error", () => {
      clearTimeout(timer);
      reject(new Error("密钥检查服务无法启动"));
    });
    child.stdout.on("data", (data) => {
      output += data;
      if (output.length > 65536) child.kill();
    });
    child.stdin.on("error", () => {});
    child.on("close", () => {
      clearTimeout(timer);
      try {
        const result = JSON.parse(output);
        if (!result.ok) throw new Error(result.error || "私钥无法读取");
        resolve(result);
      } catch (error) {
        reject(
          new Error(
            error.message.includes("JSON")
              ? "密钥检查失败，请重新构建桌面版"
              : error.message,
          ),
        );
      }
    });
    child.stdin.end(JSON.stringify({ content, passphrase }));
  });
}
module.exports = { CredentialVault, endpointKey, inspectPrivateKey };
