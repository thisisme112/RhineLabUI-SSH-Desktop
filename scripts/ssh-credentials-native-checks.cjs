/** Real Electron safeStorage, sandboxed preload, IPC, ConPTY and system OpenSSH.
 * Used only with the loopback fixture and an explicitly isolated userData path. */
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { safeStorage } = require("electron");
const { CredentialVault } = require("../electron/credential-vault.cjs");

exports.run = async ({ win, sessions, app, report, problems }) => {
  const fixture = JSON.parse(
    fs.readFileSync(process.env.RHINE_CREDENTIAL_FIXTURE, "utf8"),
  );
  const phase = Number(process.env.RHINE_CREDENTIAL_PHASE || 1);
  const proofFile = path.join(
    path.dirname(process.env.RHINE_CREDENTIAL_FIXTURE),
    "credential-proof.json",
  );
  const checks = {},
    observations = {};
  const pass = (name) => {
    checks[name] = true;
    console.log("PASS " + name);
  };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const evaluate = (expression) =>
    win.webContents.executeJavaScript(expression);
  const wait = async (name, condition, timeout = 30000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await condition()) return;
      await sleep(60);
    }
    const diagnosis = await evaluate(
      `({prompts:window.__credentialsProbe?.prompts,auxiliary:window.__credentialsProbe?.auxiliary,errors:window.__credentialsProbe?.errors,outputs:Object.fromEntries(Object.entries(window.__credentialsProbe?.outputs||{}).map(([id,text])=>[id,text.slice(-5000)]))})`,
    );
    fs.writeFileSync(
      path.join(path.dirname(proofFile), "credential-timeout.json"),
      JSON.stringify(
        {
          name,
          diagnosis,
          services: [...sessions.entries.values()].map((entry) => ({
            id: entry.id,
            state: entry.services?.snapshot(),
          })),
        },
        null,
        2,
      ),
    );
    throw new Error("Timed out: " + name);
  };
  await wait("preload ready", () =>
    evaluate(
      "Boolean(window.rhineDesktop?.session && window.rhineDesktop?.keys)",
    ),
  );
  await evaluate(`(() => {
    window.__credentialsProbe = { prompts:[], errors:[], outputs:{}, lastStatus:[], auxiliary:[], remember:true };
    const state=__credentialsProbe, bridge=rhineDesktop;
    bridge.session.onData(({sessionId,data}) => state.outputs[sessionId]=(state.outputs[sessionId]||'')+data);
    bridge.session.onPrompt(async ({sessionId,data}) => {
      if (!data) return;
      state.prompts.push({sessionId,kind:data.kind,canRemember:data.canRemember,key:data.key});
      const entry=state.targets?.[sessionId];
      if (entry && data.kind==='password') state.lastStatus.push((await bridge.credentials.status(entry)).state?.password);
      const value=data.kind==='hostkey'?'yes':data.kind==='passphrase'?'fixture-passphrase':data.kind==='verification-code'?'314159':'fixture-password';
      const reply=await bridge.session.answer(data.id,value,sessionId,state.remember);
      if (!reply.ok) state.errors.push(reply.error);
    });
    bridge.services.onEvent(async event => {
      if(event.event==='credential-error') state.errors.push(event.data.message);
      if(event.event!=='auth'||!event.data) return;
      const prompt=event.data; state.auxiliary.push({sessionId:event.sessionId,kind:prompt.kind,canRemember:prompt.canRemember,peer:prompt.peer,method:prompt.method,prompt:prompt.prompt});
      const reply=await bridge.services.answer({sessionId:event.sessionId,id:prompt.id,
        value:prompt.kind==='hostkey'?'yes':prompt.kind==='passphrase'?'fixture-passphrase':'fixture-password',remember:true});
      if(!reply.ok) state.errors.push(reply.error);
    });
    state.start=async target => {
      const reserved=await bridge.session.reserve(); if(!reserved.ok) return reserved;
      (state.targets ||= {})[reserved.id]=target;
      const result=await bridge.session.start({target,cols:100,rows:32},reserved.id);
      return {...result,id:reserved.id};
    };
    return true;
  })()`);
  const vaultFile = path.join(app.getPath("userData"), "ssh-credentials.json");
  const vault = new CredentialVault(vaultFile, safeStorage);
  const ready = async (id) => {
    await wait("shell and SFTP/monitor", async () => {
      const services = sessions.services(id),
        snapshot = services?.snapshot();
      if (!sessions.entries.has(id))
        throw new Error("Fixture session exited before ready");
      if ([snapshot?.sftp.state, snapshot?.monitor.state].includes("error"))
        throw new Error(
          JSON.stringify({ sftp: snapshot.sftp, monitor: snapshot.monitor }),
        );
      return (
        snapshot?.sftp.state === "ready" &&
        snapshot.monitor.state === "ready" &&
        snapshot.sample &&
        (await evaluate(
          `Boolean(__credentialsProbe.outputs[${JSON.stringify(id)}]?.includes('Isolated SSH fixture'))`,
        ))
      );
    });
    fs.writeFileSync(
      path.join(path.dirname(proofFile), "credential-progress.json"),
      JSON.stringify(
        {
          checks,
          observations: await evaluate(
            "({primary:__credentialsProbe.prompts,auxiliary:__credentialsProbe.auxiliary,errors:__credentialsProbe.errors})",
          ),
          promptTrace: await evaluate(
            `(() => {const text=__credentialsProbe.outputs[${JSON.stringify(id)}]||'';const at=text.lastIndexOf('Enter passphrase');return at<0?'':text.slice(at,at+350);})()`,
          ),
          broker: {
            peer: sessions.services(id)?.primaryPeer,
            method: sessions.services(id)?.primaryMethod,
            launch: sessions.services(id)?.launch,
            memory: [
              ...(sessions.services(id)?.credentialBroker.memory.keys() || []),
            ],
          },
        },
        null,
        2,
      ),
    );
  };
  const start = async (target) => {
    const result = await evaluate(
      `__credentialsProbe.start(${JSON.stringify(target)})`,
    );
    assert(result?.ok, result?.error);
    await ready(result.id);
    return result.id;
  };
  const stop = async (id) => {
    const services = sessions.services(id);
    await evaluate(`rhineDesktop.session.stop(${JSON.stringify(id)})`);
    await wait("native session closes", () => !sessions.entries.has(id));
    await services?.close();
    await sleep(30);
  };
  const profile = async (data) => {
    const result = await evaluate(
      `(async()=>{ const hosts=await rhineDesktop.hosts(); return rhineDesktop.hostProfiles.save(${JSON.stringify(data)},hosts.revision); })()`,
    );
    assert(result?.ok, result?.error);
    return "rhine-profile:" + result.profile.id;
  };
  const promptCount = async (id, key = "prompts") =>
    evaluate(
      `__credentialsProbe.${key}.filter(item=>item.sessionId===${JSON.stringify(id)}&&item.kind!=='hostkey').length`,
    );
  let proof;
  if (phase === 1) {
    assert.equal(safeStorage.isEncryptionAvailable(), true);
    const password = await profile({
      name: "保存密码验证",
      hostname: "127.0.0.1",
      port: fixture.port,
      user: "password",
      authMode: "password",
    });
    const saved = await evaluate(
      `rhineDesktop.credentials.save({target:${JSON.stringify(password)},kind:'password',value:'fixture-password'})`,
    );
    assert(saved?.ok, saved?.error);
    assert.equal(saved.state.password, "saved");
    assert(!fs.readFileSync(vaultFile, "utf8").includes("fixture-password"));
    const id = await start(password);
    assert.equal(await promptCount(id), 0);
    assert.equal(await promptCount(id, "auxiliary"), 0);
    assert.equal(
      Object.values(vault.read().credentials)[0].fingerprint,
      fixture.fingerprint,
    );
    await stop(id);
    pass(
      "password saved through real IPC automatically authenticates primary, SFTP, probe and collector and then binds its fingerprint",
    );

    const privateKey = fs.readFileSync(fixture.encryptedIdentity, "utf8");
    const imported = await evaluate(
      `rhineDesktop.keys.add(${JSON.stringify({ source: "import", name: "加密导入验证", content: privateKey, passphrase: "fixture-passphrase" })})`,
    );
    assert(imported?.ok, imported?.error);
    assert.equal(imported.key.protected, true);
    assert.match(imported.key.fingerprint, /^SHA256:/);
    assert(!JSON.stringify(imported).includes("PRIVATE KEY"));
    const reference = await evaluate(
      `rhineDesktop.keys.add(${JSON.stringify({ source: "file", name: "文件引用验证", file: fixture.identity })})`,
    );
    assert(reference?.ok, reference?.error);
    assert.equal(reference.key.protected, false);
    const malformed = await evaluate(
      `rhineDesktop.keys.add({source:'import',content:'PuTTY-User-Key-File-3: ssh-ed25519'})`,
    );
    assert.equal(malformed.ok, false);
    const encrypted = await profile({
      name: "导入私钥验证",
      hostname: "127.0.0.1",
      port: fixture.port,
      user: "key",
      authMode: "key",
      keyId: imported.key.id,
    });
    const keySession = await start(encrypted);
    assert.equal(await promptCount(keySession), 1);
    assert.equal(await promptCount(keySession, "auxiliary"), 0);
    assert.equal(vault.status(encrypted).passphrase, "saved");
    const metadata = await evaluate("rhineDesktop.keys.list()");
    assert(!JSON.stringify(metadata).includes("PRIVATE KEY"));
    assert(!JSON.stringify(metadata).includes("fixture-passphrase"));
    const remove = await evaluate(
      `rhineDesktop.keys.remove(${JSON.stringify(imported.key.id)})`,
    );
    assert.equal(remove.ok, false);
    await stop(keySession);
    const keyFiles = () =>
      fs.existsSync(vault.runtime)
        ? fs.readdirSync(vault.runtime).filter((name) => /^key-/.test(name))
        : [];
    await wait("imported private file cleanup", () => keyFiles().length === 0);
    pass(
      "imported OpenSSH key prompts once, remembers its passphrase only after success, reuses it for services and cleans private runtime files",
    );

    const unencrypted = await profile({
      name: "引用私钥验证",
      hostname: "127.0.0.1",
      port: fixture.port,
      user: "key",
      authMode: "key",
      keyId: reference.key.id,
    });
    const refSession = await start(unencrypted);
    assert.equal(await promptCount(refSession), 0);
    assert.equal(await promptCount(refSession, "auxiliary"), 0);
    await stop(refSession);
    assert(fs.existsSync(fixture.identity));
    pass(
      "referenced private key authenticates through real system OpenSSH and leaves the original file intact",
    );

    const unicodeFile = path.join(
      path.dirname(fixture.encryptedIdentity),
      "用户 密钥",
      "测试密钥".repeat(8) + " encrypted",
    );
    fs.mkdirSync(path.dirname(unicodeFile), { recursive: true });
    fs.copyFileSync(fixture.encryptedIdentity, unicodeFile);
    const unicodeKey = await evaluate(
      `rhineDesktop.keys.add(${JSON.stringify({ source: "file", name: "中文长路径验证", file: unicodeFile })})`,
    );
    assert(unicodeKey.ok, unicodeKey.error);
    const unicode = await profile({
      name: "中文路径密钥",
      hostname: "127.0.0.1",
      port: fixture.port,
      user: "key",
      authMode: "key",
      keyId: unicodeKey.key.id,
    });
    const unicodeSecret = await evaluate(
      `rhineDesktop.credentials.save({target:${JSON.stringify(unicode)},kind:'passphrase',value:'fixture-passphrase'})`,
    );
    assert(unicodeSecret.ok, unicodeSecret.error);
    const unicodeSession = await start(unicode);
    assert.equal(await promptCount(unicodeSession), 0);
    assert.equal(await promptCount(unicodeSession, "auxiliary"), 0);
    await stop(unicodeSession);
    pass(
      "saved key passphrase also handles a long Unicode file path with spaces through native ConPTY and ASKPASS",
    );

    for (const padding of ["a", "ab"]) {
      const variantFile = path.join(
        path.dirname(unicodeFile),
        padding + path.basename(unicodeFile),
      );
      fs.copyFileSync(fixture.encryptedIdentity, variantFile);
      const variantKey = await evaluate(
        `rhineDesktop.keys.add(${JSON.stringify({ source: "file", name: "UTF-8 边界验证", file: variantFile })})`,
      );
      assert(variantKey.ok, variantKey.error);
      const variant = await profile({
        name: "UTF-8 边界",
        hostname: "127.0.0.1",
        port: fixture.port,
        user: "key",
        authMode: "key",
        keyId: variantKey.key.id,
      });
      const saved = await evaluate(
        `rhineDesktop.credentials.save({target:${JSON.stringify(variant)},kind:'passphrase',value:'fixture-passphrase'})`,
      );
      assert(saved.ok, saved.error);
      const id = await start(variant);
      assert.equal(await promptCount(id), 0);
      assert.equal(await promptCount(id, "auxiliary"), 0);
      await stop(id);
    }
    pass(
      "both partial UTF-8 boundaries in OpenSSH's 100-byte key prompt preserve automatic credential binding",
    );

    const wrong = await evaluate(
      `rhineDesktop.credentials.save({target:${JSON.stringify(password)},kind:'password',value:'wrong-fixture-secret'})`,
    );
    assert(wrong.ok);
    const corrected = await start(password);
    assert.equal(await promptCount(corrected), 1);
    assert.equal(await promptCount(corrected, "auxiliary"), 0);
    assert(
      (await evaluate("__credentialsProbe.lastStatus")).includes(
        "needs-update",
      ),
    );
    await stop(corrected);
    assert.equal(
      vault.get(
        password,
        "password",
        { host: "127.0.0.1", port: fixture.port, user: "password" },
        "",
        fixture.fingerprint,
      ),
      "fixture-password",
    );
    pass(
      "wrong saved password falls back once to manual input and the corrected password replaces it after successful authentication",
    );
    proof = { password, encrypted, unencrypted, unicode, key: imported.key.id };
    fs.writeFileSync(proofFile, JSON.stringify(proof));
  } else {
    proof = JSON.parse(fs.readFileSync(proofFile, "utf8"));
    const before = await evaluate("rhineDesktop.keys.list()");
    assert(before.ok);
    const a = await start(proof.password),
      b = await start(proof.encrypted);
    assert.equal(await promptCount(a), 0);
    assert.equal(await promptCount(a, "auxiliary"), 0);
    assert.equal(await promptCount(b), 0);
    assert.equal(await promptCount(b, "auxiliary"), 0);
    const c = await start(proof.encrypted);
    assert.equal(await promptCount(c), 0);
    assert.equal(await promptCount(c, "auxiliary"), 0);
    await stop(b);
    assert(sessions.services(c).snapshot().active);
    assert.equal(
      fs.readdirSync(vault.runtime).filter((name) => /^key-/.test(name)).length,
      1,
    );
    const listed = await evaluate(
      `rhineDesktop.sftp.list({sessionId:${JSON.stringify(c)},path:'/data'})`,
    );
    assert(listed.ok, listed.error);
    await stop(a);
    await stop(c);
    assert.equal(
      fs.readdirSync(vault.runtime).filter((name) => /^key-/.test(name)).length,
      0,
    );
    pass(
      "after a full Electron process restart, password and key passphrase reconnect without prompts across concurrent primary/SFTP/monitor channels",
    );
    pass(
      "two sessions share an imported key lease safely and the final close removes its plaintext runtime file",
    );
    const unicodeSession = await start(proof.unicode);
    assert.equal(await promptCount(unicodeSession), 0);
    assert.equal(await promptCount(unicodeSession, "auxiliary"), 0);
    await stop(unicodeSession);
    pass(
      "the encrypted Unicode-path key reconnects without another passphrase after restart",
    );
    const removed = await evaluate(
      `rhineDesktop.credentials.remove({target:${JSON.stringify(proof.password)},kind:'password'})`,
    );
    assert(removed.ok);
    assert.equal(removed.state.password, "none");
    const manual = await start(proof.password);
    assert.equal(await promptCount(manual), 1);
    await stop(manual);
    pass(
      "deleting a saved password returns the next connection to manual authentication",
    );
  }
  assert.equal(await evaluate("__credentialsProbe.errors.length"), 0);
  for (const name of fs.readdirSync(app.getPath("userData")))
    if (name.startsWith("ssh-") && name.endsWith(".json")) {
      const data = fs.readFileSync(
        path.join(app.getPath("userData"), name),
        "utf8",
      );
      assert(
        !data.includes("fixture-password") &&
          !data.includes("fixture-passphrase") &&
          !data.includes("BEGIN OPENSSH PRIVATE KEY"),
      );
    }
  pass(
    "renderer metadata and app JSON contain no plaintext password, private key or passphrase",
  );
  observations.primaryPrompts = await evaluate("__credentialsProbe.prompts");
  observations.auxiliaryPrompts = await evaluate(
    "__credentialsProbe.auxiliary",
  );
  report({
    phase,
    checks,
    failed: [],
    observations,
    problems,
    scope:
      "Real Electron / safeStorage / sandboxed IPC / ConPTY / OpenSSH / SFTP; monitor frames are simulated by the isolated peer.",
  });
  return true;
};
