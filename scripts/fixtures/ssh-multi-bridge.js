/* Deterministic browser fixture; no network, credentials or user filesystem. */
(() => {
  const listeners = new Map(), entries = new Map(), records = new Map();
  const on = name => fn => { const set = listeners.get(name) || new Set(); set.add(fn); listeners.set(name, set); return () => set.delete(fn); };
  const emit = (name, sessionId, data) => { for (const fn of listeners.get(name) || []) fn({ sessionId, data }); };
  const service = (id, event, data) => { for (const fn of listeners.get("services") || []) fn({ sessionId: id, event, data: structuredClone(data) }); };
  const output = (id, data) => { const entry = entries.get(id); entry.bytesIn += new TextEncoder().encode(data).length; emit("data", id, data); };
  const snapshot = id => structuredClone(entries.get(id)?.state || null);
  let auto = false;
  function sample(id) {
    const entry = entries.get(id);
    if (!entry?.shell || !entry.active) return;
    const sequence = (entry.state.sample?.sequence || 0) + 1, now = Date.now();
    const frame = { sequence, timestamp: now, hostname: entry.target + " / local fixture", uptime: 3000,
      cpu: { usage: 20 + sequence % 25, cores: 8, load: [1, 2, 3] },
      memory: { total: 64 * 2 ** 30, used: 25 * 2 ** 30, available: 39 * 2 ** 30, swapTotal: 0, swapUsed: 0 },
      networks: [{ name: "eth0", receive: 1000, send: 2000 }], diskIO: { read: 3000, write: 1000 },
      disks: [{ mount: "/", device: "/dev/fixture", total: 100 * 2 ** 30, used: 30 * 2 ** 30, available: 70 * 2 ** 30 }],
      gpus: [{ uuid: id + "-gpu", index: 0, name: "NVIDIA · UI fixture", utilization: 94, memoryUsed: 8 * 2 ** 30, memoryTotal: 16 * 2 ** 30, temperature: 65, power: 190, powerLimit: 250, fan: 50,
        processes: [{ pid: 4321, name: entry.target + "-process", type: "C", memory: 8 * 2 ** 30, gpu: id + "-gpu" }] }],
      gpuAt: now, gpuState: "live", errors: [] };
    entry.state.sample = frame; entry.state.receivedAt = now;
    entry.state.history.push({ timestamp: now, receivedAt: now, cpu: frame.cpu.usage, memory: 39, gpus: frame.gpus.map(gpu => ({ uuid: gpu.uuid, utilization: gpu.utilization, memoryUsed: gpu.memoryUsed })) });
    if (entry.state.history.length > 300) entry.state.history.shift();
    service(id, "sample", { sample: frame, receivedAt: now });
  }
  function ready(id) {
    const entry = entries.get(id); if (!entry?.active) return;
    entry.pending = null; emit("prompt", id, null);
    emit("log", id, `Authenticated to ${entry.target} ([127.0.0.1]:2222) using "password".`);
    emit("log", id, "debug1: Entering interactive session.");
    entry.shell = true;
    entry.state.sftp = { state: "ready", message: "文件通道已建立", home: "/home/" + entry.target };
    entry.state.monitor = { state: "ready", message: "测试采样中" };
    service(id, "capability", { service: "sftp", ...entry.state.sftp });
    service(id, "capability", { service: "monitor", ...entry.state.monitor });
    output(id, `\x1b[?2004hSESSION ${entry.target} / ${id}\r\nfixture@${entry.target}$ `);
    sample(id);
    entry.timer ||= setInterval(() => sample(id), 1000);
  }
  function end(id, code = 0) {
    const entry = entries.get(id); if (!entry?.active) return;
    entry.active = false; entry.pending = null; clearInterval(entry.timer);
    entry.state.active = false; entry.state.prompt = null;
    service(id, "stopped", entry.state); emit("prompt", id, null);
    emit("exit", id, { exitCode: code, bytesIn: entry.bytesIn, bytesOut: 0, logLines: 12, elapsedMs: 10000, logPath: id + ".log" });
  }
  const hosts = ["review-host", "second-host", ...Array.from({ length: 6 }, (_, index) => "host-" + (index + 3))].map(alias => ({ alias, displayName: alias,
    hostname: "127.0.0.1", user: "fixture", port: "2222", source: "config", raw: "Host " + alias + "\n HostName 127.0.0.1" }));
  const profiles = new Map(), keys = new Map(), secrets = new Map();
  let revision = 1;
  const savedHosts = () => [...profiles.values()].map(profile => ({alias:'rhine-profile:'+profile.id,displayName:profile.name,
    hostname:profile.hostname,user:profile.user||'',port:String(profile.port||22),source:'saved',profile,raw:'Isolated profile fixture'}));
  const credentialState = target => ({password:secrets.has(target+':password')?'saved':'none',passphrase:secrets.has(target+':passphrase')?'saved':'none',available:true});
  const entryFor = request => { const entry = entries.get(request.sessionId); if (!entry?.active) throw new Error("stale session"); return entry; };
  const fixture = window.__multiFixture = {
    entries, output, ready, end, sample,
    get auto() { return auto; }, set auto(value) { auto = value; },
    prompt(id) { const entry = entries.get(id); entry.pending = { id: 1, kind: "password", host: entry.target, prompt: entry.target + " password:" }; emit("prompt", id, entry.pending); },
    job(id, state) { const entry = entries.get(id); const job = { id: "job-" + id, name: "fixture-file", source: "/local/file", destination: "/remote/file", direction: "upload", state, bytesDone: state === "completed" ? 200 : 0, bytesTotal: 200, filesDone: 0, filesTotal: 1, skipped: 0, rate: 0 };
      entry.state.jobs = [job]; service(id, "transfer", job); },
    auxiliary(id) { const entry = entries.get(id); entry.state.prompt = { id: "aux-1", connection: id, source: "sftp", kind: "verification-code", prompt: "One time code / " + entry.target, fingerprint: "", diagnostics: "" }; service(id, "auth", entry.state.prompt); },
    records, profiles, keys, secrets, failCredentialSave: false,
  };
  window.rhineDesktop = {
    isDesktop: true, platform: "win32", versions: { electron: "fixture", chrome: "fixture", node: "fixture" },
    hosts: async () => ({ ok: true, hosts:[...hosts,...savedHosts()], configPath: "fixture/config", profilesPath: "fixture/hosts.json", revision: String(revision) }),
    hostProfiles: {
      save: async (input, expected) => {
        if (expected!==String(revision)) return {ok:false,error:'主机列表已更新'};
        const profile={...input,id:input.id||crypto.randomUUID()}; profiles.set(profile.id,profile); revision++;
        return {ok:true,profile,revision:String(revision)};
      },
      remove: async (id, expected) => {
        if(expected!==String(revision)) return {ok:false,error:'主机列表已更新'};
        profiles.delete(id); secrets.delete('rhine-profile:'+id+':password'); secrets.delete('rhine-profile:'+id+':passphrase'); revision++;
        return {ok:true};
      },
      pickIdentity: async () => ({ok:true,file:'C:/isolated-fixture/key'}),
    },
    credentials: {
      status: async target => ({ok:true,state:credentialState(target)}),
      save: async request => { if(fixture.failCredentialSave) return {ok:false,error:'隔离测试：加密保存失败'}; secrets.set(request.target+':'+request.kind,request.value); return {ok:true,state:credentialState(request.target)}; },
      remove: async request => {secrets.delete(request.target+':'+request.kind); return {ok:true,state:credentialState(request.target)};},
    },
    keys: {
      list: async () => ({ok:true,keys:[...keys.values()].map(key=>({...key,hosts:[...profiles.values()].filter(profile=>profile.keyId===key.id).map(profile=>profile.name)}))}),
      add: async input => { const key={id:crypto.randomUUID(),name:input.name||'本机测试私钥',source:input.source,type:'ssh-ed25519',fingerprint:'SHA256:ISOLATEDKEY',protected:true,...(input.file?{file:input.file}:{})}; keys.set(key.id,key); return {ok:true,key}; },
      remove: async id => { if([...profiles.values()].some(profile=>profile.keyId===id))return {ok:false,error:'请先解除主机的密钥关联'}; keys.delete(id); return {ok:true}; },
    },
    clipboard: { readText: async () => ({ ok: true, text: "fixture-paste" }), writeText: async () => ({ ok: true }) },
    records: {
      list: async () => ({ ok: true, records: [...records.values()].map(record => ({ ...record, file: record.id + ".json", outcome: record.outcome, bytesIn: record.traffic.bytesIn, bytesOut: record.traffic.bytesOut })) }),
      read: async file => ({ ok: true, record: records.get(file.replace(/\.json$/, "")) }),
      log: async () => ({ ok: true, lines: ["Local fixture log"] }),
      prune: async () => ({ ok: true, removed: 0, bytesFreed: 0 }),
    },
    session: {
      reserve: async () => ({ ok: true, id: crypto.randomUUID() }),
      async start(descriptor, id) {
        const entry = { target: descriptor.target, active: true, shell: false, bytesIn: 0, writes: [], sizes: [], line: "", pending: null, timer: 0,
          state: { sessionId: id, active: true, sftp: { state: "waiting", message: "等待连接" }, monitor: { state: "waiting", message: "等待连接" }, jobs: [], sample: null, receivedAt: 0, history: [], prompt: null } };
        entries.set(id, entry);
        service(id, "snapshot", entry.state);
        for (const line of [`debug1: Connecting to ${entry.target} [127.0.0.1] port 2222.`, "debug1: Connection established.", "debug1: Remote protocol version 2.0, remote software version OpenSSH_9.6", "debug1: kex: algorithm: curve25519-sha256", "debug1: kex: host key algorithm: ssh-ed25519", "debug1: Server host key: ssh-ed25519 SHA256:FIXTURE", `debug1: Host '${entry.target}' is known and matches the ssh-ed25519 host key.`, "debug1: Authentications that can continue: password"]) emit("log", id, line);
        if (auto) ready(id); else fixture.prompt(id);
        return { ok: true, id, argv: ["ssh", descriptor.target], file: "ssh", logPath: id + ".log", startedAt: Date.now() };
      },
      async answer(requestId, value, id) {
        const entry = entries.get(id); if (!entry?.active || entry.pending?.id !== requestId) return { ok: false, error: "stale prompt" };
        entry.answer = value; ready(id); return { ok: true };
      },
      write(data, id) {
        const entry = entries.get(id); if (!entry?.active) return;
        entry.writes.push(data);
        if (/^\x1b\[\d+;\d+R$/.test(data)) return;
        if (data.startsWith("\x1b[200~")) { entry.line += data.replace(/^\x1b\[200~/, "").replace(/\x1b\[201~$/, ""); return; }
        if (data === "\r") { output(id, `\r\n${entry.target}: ${entry.line}\r\nfixture$ `); entry.line = ""; }
        else { entry.line += data; output(id, data); }
      },
      resize(cols, rows, id) { entries.get(id)?.sizes.push([cols, rows]); },
      stop: end,
      record: async record => { records.set(record.id, record); return { ok: true, file: record.id + ".json" }; },
      export: async () => ({ ok: true, file: "fixture-export.txt" }),
      onData: on("data"), onLog: on("log"), onPrompt: on("prompt"), onTraffic: on("traffic"), onExit: on("exit"),
    },
    services: {
      snapshot: async id => ({ ok: true, result: snapshot(id) }), onEvent: on("services"),
      answer: async request => { const entry = entryFor(request); if (entry.state.prompt?.id !== request.id) return { ok: false, error: "stale auxiliary" };
        entry.auxAnswer = request.value; entry.state.prompt = null; service(request.sessionId, "auth", null); return { ok: true }; },
    },
    sftp: {
      list: async request => { const entry = entryFor(request); entry.lastDirectory = request.path;
        return { ok: true, result: { path: request.path === "." ? "/home/" + entry.target : request.path, total: 2, cursor: "", entries: [
          { name: entry.target + ".txt", path: request.path + "/" + entry.target + ".txt", kind: "file", size: 45, modified: Date.now(), permissions: "-rw-r--r--" },
          { name: "project", path: request.path + "/project", kind: "directory", size: 0, modified: Date.now(), permissions: "drwxr-xr-x" },
        ] } }; },
      reconnect: async () => ({ ok: true }), cancel: async request => { fixture.job(request.sessionId, "canceled"); return { ok: true }; },
    },
    monitor: { retry: async () => ({ ok: true }) },
  };
})();
