/* Simulated workspace data for layout/input checks only. Never bundled. */
(() => {
  const listeners = new Set(),
    desktop = window.rhineDesktop,
    deck = window.__deckFixture;
  let state = null,
    sequence = 0,
    timer,
    jobId = 0,
    challengeId = 0;
  const clone = (value) => structuredClone(value);
  const emit = (event, data, sessionId = state?.sessionId) => {
    for (const listener of listeners)
      listener(clone({ event, data, sessionId }));
  };
  const entry = (
    name,
    kind = "file",
    size = 4096,
    directory = "/home/operator",
  ) => ({
    name,
    path: directory + "/" + name,
    kind,
    size,
    modified: Date.now() - 3600000,
    permissions:
      kind === "directory"
        ? "drwxr-xr-x"
        : kind === "link"
          ? "Lrwxrwxrwx"
          : "-rw-r--r--",
  });
  const directories = new Map([
    [
      "/",
      [entry("home", "directory", 0, ""), entry("data", "directory", 0, "")],
    ],
    ["/home", [entry("operator", "directory", 0, "/home")]],
    [
      "/home/operator",
      [
        entry("checkpoints", "directory"),
        entry("datasets", "directory"),
        entry("experiments", "directory"),
        entry("models", "directory"),
        entry("outputs", "directory"),
        entry(".ssh", "directory"),
        entry("train.py"),
        entry("config.yaml", "file", 864),
        entry("preview.png", "file", 430899),
        entry("results.tar.gz", "file", 92444521),
        entry("模型说明.md", "file", 1802),
        entry("current", "link"),
        ...Array.from({ length: 700 }, (_, n) =>
          entry(`sample-${String(n).padStart(4, "0")}.bin`, "file", n * 4096),
        ),
      ],
    ],
    [
      "/home/operator/models",
      [
        entry(
          "weights.safetensors",
          "file",
          8432000000,
          "/home/operator/models",
        ),
      ],
    ],
  ]);
  // Text documents the editor can read and write back. `revision` only has to
  // be stable per content: the editor compares it to decide whether the server
  // moved under the draft, and never asks what it is made of.
  const documents = new Map([
    ["/home/operator/train.py", "import torch\n\nprint('training')\n"],
  ]);
  const revisionOf = (text) => {
    let value = 7;
    for (const char of text) value = (value * 31 + char.codePointAt(0)) >>> 0;
    return value.toString(16).padStart(8, "0").repeat(8);
  };
  const textDocument = (path) => {
    const item = [...directories.values()]
      .flat()
      .find((row) => row.path === path);
    const text = documents.get(path) ?? "";
    return {
      path,
      text,
      revision: revisionOf(text),
      modified: item?.modified ?? Date.now(),
      permissions: item?.permissions ?? "-rw-r--r--",
    };
  };
  const sample = () => {
    const timestamp = Date.now();
    sequence++;
    const gpu = (index, name, utilization, used, total, temperature) => ({
      uuid: "GPU-UI-FIXTURE-" + index,
      index,
      name,
      utilization,
      memoryUsed: used * 2 ** 30,
      memoryTotal: total * 2 ** 30,
      temperature,
      power: 240 - index * 66,
      powerLimit: 350,
      fan: 42,
      processes: [
        {
          pid: 18572 + index,
          name: "/opt/venv/bin/python train.py",
          type: "C",
          memory: used * 2 ** 30,
          gpu: "GPU-UI-FIXTURE-" + index,
        },
      ],
    });
    return {
      sequence,
      timestamp,
      hostname: "GPU LAB · 界面测试数据",
      uptime: 1840312,
      cpu: { usage: 24 + (sequence % 6), cores: 32, load: [8.2, 7.41, 6.8] },
      memory: {
        total: 128 * 2 ** 30,
        used: 72 * 2 ** 30,
        available: 56 * 2 ** 30,
        swapTotal: 8 * 2 ** 30,
        swapUsed: 0,
      },
      disks: [
        {
          mount: "/",
          device: "/dev/nvme0n1p2",
          used: 390 * 2 ** 30,
          total: 1000 * 2 ** 30,
          available: 610 * 2 ** 30,
        },
        {
          mount: "/data",
          device: "/dev/sda1",
          used: 3690 * 2 ** 30,
          total: 4000 * 2 ** 30,
          available: 310 * 2 ** 30,
        },
      ],
      diskIO: { read: 12 * 2 ** 20, write: 3 * 2 ** 20 },
      networks: [{ name: "eth0", receive: 2340103, send: 65433 }],
      gpus: [
        gpu(0, "NVIDIA RTX 4090", 86 + (sequence % 4), 19.4, 24, 72),
        gpu(1, "NVIDIA RTX A6000", 28, 8.2, 48, 49),
      ],
      gpuAt: timestamp,
      gpuState: "live",
      errors: [],
    };
  };
  const tick = () => {
    if (!state?.active) return;
    state.sample = sample();
    state.receivedAt = Date.now();
    emit("sample", { sample: state.sample, receivedAt: state.receivedAt });
  };
  const capability = (service, status) => {
    state[service] = { ...state[service], ...status };
    emit("capability", { service, ...state[service] });
  };
  const setJob = (job) => {
    const index = state.jobs.findIndex((item) => item.id === job.id);
    if (index < 0) state.jobs.push(job);
    else state.jobs[index] = job;
    emit("transfer", job);
  };
  const addJob = (overrides = {}) => {
    const job = {
      id: "job-" + ++jobId,
      direction: "upload",
      name: "模型资料",
      source: "fixture-local/模型资料",
      destination: "/home/operator",
      state: "transferring",
      bytesDone: 18 * 2 ** 20,
      bytesTotal: 64 * 2 ** 20,
      filesDone: 1,
      filesTotal: 3,
      skipped: 0,
      rate: 7.3 * 2 ** 20,
      ...overrides,
    };
    setJob(job);
    return job;
  };
  const fixture = (window.__workspaceFixture = {
    calls: [],
    answers: [],
    get state() {
      return clone(state);
    },
    directories,
    tick,
    addJob,
    setJob,
    pause() {
      clearInterval(timer);
    },
    resume() {
      clearInterval(timer);
      timer = setInterval(tick, 1000);
    },
    status: capability,
    stale() {
      this.pause();
      state.receivedAt = Date.now() - 8000;
      emit("snapshot", state);
    },
    prompt(source = "sftp", kind = "password") {
      const prompt = {
        id: "challenge-" + ++challengeId,
        connection: "fixture-channel",
        source,
        kind,
        prompt: "Fixture authentication request",
        fingerprint: "SHA256:UIFIXTURE",
        diagnostics: "Simulated request for UI testing",
      };
      state.prompt = prompt;
      emit("auth", prompt);
      return prompt.id;
    },
    oldEvent() {
      emit(
        "capability",
        {
          service: "sftp",
          state: "error",
          message: "STALE_SESSION_SHOULD_BE_IGNORED",
        },
        "old-session",
      );
    },
  });
  desktop.services = {
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: async () => ({ ok: true, result: clone(state) }),
    async answer(request) {
      if (
        request.sessionId !== state.sessionId ||
        request.id !== state.prompt?.id
      )
        return { ok: false, error: "stale prompt" };
      fixture.answers.push({ id: request.id, canceled: request.canceled });
      state.prompt = null;
      emit("auth", null);
      return { ok: true };
    },
  };
  const valid = (request) =>
    request.sessionId === state?.sessionId && state.active;
  desktop.sftp = {
    async readText(request) {
      fixture.calls.push({ method: "readText", ...request });
      if (!valid(request)) return { ok: false, error: "session changed" };
      if (!documents.has(request.path))
        return { ok: false, error: "无法读取文本文件" };
      await new Promise((resolve) => setTimeout(resolve, 65));
      return { ok: true, result: clone(textDocument(request.path)) };
    },
    async writeText(request) {
      fixture.calls.push({ method: "writeText", ...request });
      if (!valid(request)) return { ok: false, error: "session changed" };
      const current = textDocument(request.path);
      await new Promise((resolve) => setTimeout(resolve, 65));
      if (current.revision !== request.revision)
        return {
          ok: true,
          result: { saved: false, conflict: true, document: current },
        };
      documents.set(request.path, request.text);
      return {
        ok: true,
        result: { saved: true, document: clone(textDocument(request.path)) },
      };
    },
    async list(request) {
      fixture.calls.push({ method: "list", ...request });
      await new Promise((resolve) => setTimeout(resolve, 65));
      if (!valid(request)) return { ok: false, error: "session changed" };
      if (!directories.has(request.path))
        return { ok: false, error: "目录不存在" };
      const all = directories.get(request.path),
        start = Number(request.cursor || 0),
        next = start + 500;
      return {
        ok: true,
        result: {
          path: request.path,
          entries: clone(all.slice(start, next)),
          total: all.length,
          cursor: next < all.length ? String(next) : "",
        },
      };
    },
    async stat(request) {
      const item = [...directories.values()]
        .flat()
        .find((entry) => entry.path === request.path);
      return item
        ? {
            ok: true,
            result: {
              entry: clone(item),
              linkTarget: "models",
              targetKind: "directory",
            },
          }
        : { ok: false, error: "不存在" };
    },
    async mkdir(request) {
      const split = request.path.lastIndexOf("/"),
        parent = request.path.slice(0, split),
        name = request.path.slice(split + 1);
      directories.get(parent).push(entry(name, "directory", 0, parent));
      directories.set(request.path, []);
      fixture.calls.push({ method: "mkdir", ...request });
      return { ok: true };
    },
    async rename(request) {
      const item = [...directories.values()]
        .flat()
        .find((entry) => entry.path === request.path);
      if (item) {
        item.path = request.destination;
        item.name = request.destination.split("/").at(-1);
      }
      fixture.calls.push({ method: "rename", ...request });
      return { ok: true };
    },
    async remove(request) {
      for (const [path, entries] of directories)
        directories.set(
          path,
          entries.filter((entry) => !request.paths.includes(entry.path)),
        );
      fixture.calls.push({ method: "remove", ...request });
      return { ok: true, result: { removed: request.paths, errors: [] } };
    },
    async upload(request) {
      fixture.calls.push({ method: "upload", ...request });
      return {
        ok: true,
        result: [addJob({ destination: request.destination })],
      };
    },
    async uploadDropped(sessionId, files, destination) {
      fixture.calls.push({
        method: "drop",
        sessionId,
        names: files.map((file) => file.name),
        destination,
      });
      return {
        ok: true,
        result: [addJob({ name: files[0].name, destination })],
      };
    },
    async download(request) {
      fixture.calls.push({ method: "download", ...request });
      return {
        ok: true,
        result: [
          addJob({
            direction: "download",
            source: request.paths[0],
            name: request.paths[0].split("/").at(-1),
            destination: "fixture-local/downloads",
          }),
        ],
      };
    },
    async cancel(request) {
      const job = state.jobs.find((job) => job.id === request.id);
      setJob({ ...job, state: "canceled", rate: 0 });
      return { ok: true };
    },
    async retry(request) {
      return {
        ok: true,
        result: [
          addJob({
            ...state.jobs.find((job) => job.id === request.id),
            id: "job-" + ++jobId,
            state: "queued",
          }),
        ],
      };
    },
    async conflict(request) {
      const job = state.jobs.find((job) => job.id === request.id);
      if (request.conflictId !== job.conflict?.id)
        return { ok: false, error: "该冲突已结束" };
      fixture.calls.push({ method: "conflict", ...request });
      setJob({
        ...job,
        state: "completed",
        conflict: null,
        bytesDone: job.bytesTotal,
        filesDone: job.filesTotal,
        rate: 0,
      });
      return { ok: true };
    },
    async reconnect() {
      capability("sftp", {
        state: "ready",
        message: "模拟文件通道",
        home: "/home/operator",
      });
      return { ok: true };
    },
  };
  desktop.monitor = {
    async retry() {
      capability("monitor", { state: "ready", message: "模拟监控已恢复" });
      tick();
      fixture.resume();
      return { ok: true };
    },
  };
  const start = desktop.session.start;
  desktop.session.start = async (...args) => {
    clearInterval(timer);
    sequence = 0;
    const result = await start(...args);
    state = {
      sessionId: result.id,
      active: true,
      sftp: { state: "waiting", message: "等待鉴权" },
      monitor: { state: "waiting", message: "等待鉴权" },
      jobs: [],
      sample: null,
      receivedAt: 0,
      history: [],
      prompt: null,
    };
    emit("snapshot", state);
    return result;
  };
  const interactive = deck.interactive;
  deck.interactive = () => {
    interactive();
    capability("sftp", {
      state: "ready",
      message: "模拟文件通道",
      home: "/home/operator",
    });
    capability("monitor", { state: "ready", message: "模拟采样", pid: 12345 });
    state.history = Array.from({ length: 299 }, (_, n) => ({
      timestamp: Date.now() - (299 - n) * 1000,
      receivedAt: Date.now() - (299 - n) * 1000,
      cpu: 24 + 12 * Math.sin(n / 20),
      memory: 56,
      gpus: [
        {
          uuid: "GPU-UI-FIXTURE-0",
          utilization: 79 + 12 * Math.sin(n / 9),
          memoryUsed: 19 * 2 ** 30,
        },
        {
          uuid: "GPU-UI-FIXTURE-1",
          utilization: 28 + 12 * Math.sin(n / 18),
          memoryUsed: 8 * 2 ** 30,
        },
      ],
    }));
    emit("snapshot", state);
    tick();
    fixture.resume();
  };
  desktop.session.onExit(() => {
    if (!state) return;
    state.active = false;
    state.prompt = null;
    clearInterval(timer);
    state.sftp = state.monitor = { state: "stopped", message: "会话已结束" };
    emit("stopped", state);
  });
})();
