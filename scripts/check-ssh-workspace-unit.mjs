import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { SshClient } from "../src/ssh/client.ts";
import { WorkspaceStore } from "../src/ssh/workspace-store.ts";
import { SshEventAudio } from "../src/ssh/event-audio.ts";
import { SshHostCards } from "../src/ssh/host-cards.ts";
import { UNGROUPED } from "../src/ssh/host-groups.ts";
import { archiveColumns, records, columnFiles, fileLocation, rebaseArchiveRows, resetArchiveRows } from "../src/data.ts";
import { fileAtCell, selectionCell } from "../src/archive-loop.ts";
const require = createRequire(import.meta.url);
const { SessionRegistry } = require("../electron/session-registry.cjs");
const { lifecycleRecord } = require("../electron/session-checkpoint.cjs");

function registryHarness(overrides = {}) {
  const messages = [], ptys = [], services = [];
  const registry = new SessionRegistry({
    resolveLaunch: descriptor => ({ ok: true, launch: descriptor, displayTarget: descriptor.target }),
    resolveEndpoint: async () => ({ host: "127.0.0.1", port: 22 }),
    logPathFor: (_target, id) => `/logs/${id}.log`,
    command: launch => ({ file: "ssh", args: [launch.target] }),
    send: (sender, channel, data) => messages.push({ owner: sender.id, channel, data }),
    createServices: options => {
      const service = { ...options, closed: false, primaryPrompt: null, snapshot: () => ({ sessionId: options.id, jobs: [] }),
        close() { this.closed = true; }, observeLog() {}, setPrimaryPrompt(prompt) { this.primaryPrompt = prompt; },
        activate() { this.active = true; }, rememberPrimaryAnswer(prompt, value) { this.answer = [prompt, value]; } };
      services.push(service); return service;
    },
    createPty: callbacks => {
      const pty = { callbacks, running: false, startedAt: 0, bytesIn: 0, bytesOut: 0, logLines: 0,
        writes: [], sizes: [], disposed: false,
        start() { this.running = true; this.startedAt = Date.now(); },
        write(data) { this.writes.push(data); }, resize(cols, rows) { this.sizes.push([cols, rows]); },
        answer(id, value) { this.reply = [id, value]; return { ok: true }; },
        stop() { this.running = false; }, dispose() { this.disposed = true; } };
      ptys.push(pty); return pty;
    }, ...overrides,
  });
  return { registry, messages, ptys, services };
}
const sender = id => ({ id, isDestroyed: () => false });

test("native shutdown checkpoints retain measured data without inventing protocol facts", () => {
  const entry = { id: "native-a", target: "a", logPath: "/logs/native-a.log", argv: ["ssh", "a"],
    pty: { startedAt: 1000, bytesIn: 400, bytesOut: 30, logLines: 12 }, canceled: false };
  const record = lifecycleRecord(entry, { exitCode: 255 }, null, 5000);
  assert.equal(record.outcome, "failed");
  assert.equal(record.durationMs, 4000);
  assert.equal(record.traffic.bytesIn, 400);
  assert.deepEqual(record.facts, []);
  entry.canceled = true;
  const checkpoint = lifecycleRecord(entry, {}, { ...record, facts: [{ key: "host", value: "a", source: "measured" }] }, 5500);
  assert.equal(checkpoint.outcome, "closed");
  assert.equal(checkpoint.exitCode, null);
  assert.equal(checkpoint.facts[0].source, "measured");
  assert.equal(lifecycleRecord({ ...entry, pty: null }), null);
});

test("independent owners, inputs, prompts and exits never affect another session", async () => {
  const h = registryHarness(), a = sender(11), foreign = sender(22);
  try {
    const one = h.registry.reserve(a).id, two = h.registry.reserve(a).id;
    const results = await Promise.all([h.registry.start(a, one, { target: "same-host" }), h.registry.start(a, two, { target: "same-host" })]);
    assert.ok(results.every(result => result.ok));
    assert.notEqual(one, two);
    h.ptys[0].callbacks.onData("ONLY_ONE"); h.ptys[1].callbacks.onData("ONLY_TWO");
    assert.deepEqual(h.messages.filter(event => event.channel === "session:data").map(event => event.data), [{ sessionId: one, data: "ONLY_ONE" }, { sessionId: two, data: "ONLY_TWO" }]);
    h.registry.write(a, { sessionId: two, data: "two-input" });
    h.registry.write(foreign, { sessionId: two, data: "foreign" });
    h.registry.resize(a, { sessionId: one, cols: 90, rows: 28 });
    h.registry.resize(foreign, { sessionId: one, cols: 1, rows: 1 });
    h.ptys[0].callbacks.onPrompt({ id: 1, kind: "password" });
    h.ptys[1].callbacks.onPrompt({ id: 1, kind: "password" });
    assert.equal(h.registry.answer(a, { sessionId: two, id: 1, value: "two-secret" }).ok, true);
    assert.equal(h.registry.answer(foreign, { sessionId: one, id: 1, value: "bad" }).ok, false);
    assert.deepEqual(h.ptys[0].writes, []);
    assert.deepEqual(h.ptys[1].writes, ["two-input"]);
    assert.deepEqual(h.ptys[0].sizes, [[90, 28]]);
    assert.equal(h.services[0].answer, undefined);
    assert.equal(h.services[1].answer[1], "two-secret");
    h.registry.stop(a, one);
    assert.equal(h.registry.get(a, one), null);
    assert.equal(h.services[1].closed, false);
    assert.ok(h.registry.logPaths.some(file => file.includes(one)), "a stopped PTY log remains protected until native exit");
    h.ptys[0].callbacks.onExit({ exitCode: 0 });
    assert.equal(h.registry.entries.has(one), false);
    assert.equal(h.registry.active().length, 1);
    assert.equal(h.ptys[1].disposed, false);
    h.ptys[1].callbacks.onData("STILL_TWO");
    assert.equal(h.messages.at(-1).data.sessionId, two);
  } finally { for (const entry of [...h.registry.entries.values()]) h.registry.release(entry); }
});

test("cancel during resolution and a synchronous native exit leave no ghost timers or sessions", async () => {
  let resolve;
  const h = registryHarness({ resolveEndpoint: () => new Promise(done => { resolve = done; }) }), owner = sender(1);
  const id = h.registry.reserve(owner).id;
  const start = h.registry.start(owner, id, { target: "delayed" });
  h.registry.stop(owner, id); resolve({});
  assert.equal((await start).ok, false);
  assert.equal(h.ptys.length, 0);
  assert.equal(h.registry.entries.size, 0);
  const early = registryHarness({ createPty: callbacks => ({ startedAt: Date.now(),
    start: () => callbacks.onExit({ exitCode: 0 }), dispose() {},
  }) });
  const earlyId = early.registry.reserve(owner).id;
  assert.equal((await early.registry.start(owner, earlyId, { target: "early" })).ok, true);
  assert.equal(early.registry.entries.size, 0);
  assert.equal(early.messages.filter(event => event.channel === "session:exit").length, 1);
});

test("eight reserved sessions keep independent lifecycle and stopOwner preserves other windows", async () => {
  const h = registryHarness(), one = sender(1), two = sender(2);
  const ids = Array.from({ length: 8 }, (_, index) => h.registry.reserve(index < 4 ? one : two).id);
  try {
    await Promise.all(ids.map((id, index) => h.registry.start(index < 4 ? one : two, id, { target: `host-${index}` })));
    assert.equal(h.registry.active().length, 8);
    h.registry.stopOwner(one.id);
    assert.equal(h.registry.active().length, 4);
    assert.ok(h.ptys.slice(4).every(pty => pty.running));
    assert.ok(h.services.slice(4).every(service => !service.closed));
  } finally { for (const entry of [...h.registry.entries.values()]) h.registry.release(entry); }
});

test("renderer transport binds listeners before early events and scopes them through reconnect", async () => {
  const listeners = new Map(), writes = [], answers = [];
  let sequence = 0;
  const emit = (name, sessionId, data) => { for (const fn of listeners.get(name) || []) fn({ sessionId, data }); };
  const subscribe = name => fn => { const set = listeners.get(name) || new Set(); set.add(fn); listeners.set(name, set); return () => set.delete(fn); };
  const transport = {
    reserve: async () => ({ ok: true, id: "session-" + ++sequence }),
    start: async (descriptor, id) => {
      emit("data", id, `early:${descriptor.target}\r\n`);
      return { ok: true, id, file: "ssh", argv: ["ssh", descriptor.target], logPath: id + ".log" };
    },
    write: (data, id) => writes.push([id, data]), resize() {}, stop: id => emit("exit", id, { exitCode: 0, bytesIn: 0, bytesOut: 0, logLines: 0, logPath: id + ".log" }),
    answer: async (id, value, sessionId) => { answers.push([sessionId, id, value]); return { ok: true }; },
    record: async () => ({ ok: true }), export: async () => ({ ok: true }),
    onData: subscribe("data"), onLog: subscribe("log"), onPrompt: subscribe("prompt"), onTraffic: subscribe("traffic"), onExit: subscribe("exit"),
  };
  globalThis.window = { rhineDesktop: { session: transport } };
  const a = new SshClient(), b = new SshClient();
  try {
    await Promise.all([a.start({ target: "A" }), b.start({ target: "B" })]);
    assert.equal(a.output, "early:A\r\n"); assert.equal(b.output, "early:B\r\n");
    emit("prompt", a.id, { id: 1, kind: "password", prompt: "Password A", host: "A" });
    emit("prompt", b.id, { id: 1, kind: "password", prompt: "Password B", host: "B" });
    await b.answerPrompt("only-b");
    assert.deepEqual(answers, [[b.id, 1, "only-b"]]);
    assert.ok(a.pendingPrompt);
    const previous = a.id;
    a.stop(); assert.equal(b.active, true);
    await a.start({ target: "A2" });
    emit("data", previous, "STALE"); emit("data", b.id, "B-OUTPUT");
    assert.equal(a.output, "early:A2\r\n"); assert.equal(b.output, "early:B\r\nB-OUTPUT");
    assert.notEqual(previous, a.id);
  } finally { a.dispose(); b.dispose(); delete globalThis.window; }
});

test("versioned workspace keeps identities and drafts safe without restoring connections", () => {
  const map = new Map([["rhine-host-column", '{"old-host":7}']]);
  const storage = { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value) };
  const store = new WorkspaceStore(storage);
  assert.equal(store.commands.length, 0);
  assert.ok(store.saveCommand({ name: "Check", command: "echo check\n", note: "Inspect only" }));
  assert.equal(store.commands[0].command, "echo check");
  assert.equal(store.saveCommand({ name: "Control", command: "echo a\x1b[1D", note: "" }), false);
  assert.ok(store.saveBookmark({ alias: "old-host", name: "Project", path: "/home/user/project" }));
  assert.ok(store.saveBookmark({ alias: "old-host", name: "Updated", path: "/home/user/project" }));
  assert.equal(store.bookmarks.length, 1);
  const number = store.number("command", store.commands[0].id);
  store.saveLayout("old-host", { width: 360, page: "monitor" });
  const reloaded = new WorkspaceStore(storage);
  assert.equal(reloaded.number("command", store.commands[0].id), number);
  assert.deepEqual(reloaded.layout("old-host"), { width: 360, page: "monitor" });
  assert.equal(map.get("rhine-host-column"), '{"old-host":7}');
  map.set("rhine.ssh.workspace", '{"version":99,"future":"keep"}');
  const incompatible = new WorkspaceStore(storage);
  assert.equal(incompatible.saveCommand({ name: "A", command: "echo b", note: "" }), false);
  assert.equal(map.get("rhine.ssh.workspace"), '{"version":99,"future":"keep"}');
});

test("file favorites stay live, host scoped and release subscriptions", async () => {
  const output = ts.transpileModule(readFileSync(new URL("../src/ssh/files-panel.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  // The bookmarks are menu rows now, built with `document.createElement`, so the
  // panel needs the smallest DOM that can answer for one.
  const element = tag => ({
    tagName: tag, children: [], dataset: {}, attributes: {}, textContent: "",
    className: "", title: "", type: "", hidden: false, disabled: false,
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return this.attributes[name] ?? null; },
    append(...kids) { this.children.push(...kids); },
    replaceChildren(...kids) { this.children = kids; },
    querySelector: () => null,
    focus() { this.focused = true; },
  });
  const exports = {};
  runInNewContext(output, {
    exports, require: () => ({}), clearTimeout,
    document: { createElement: element },
  });
  const store = new WorkspaceStore({ getItem: () => null, setItem() {} });
  const panels = [];
  const makePanel = alias => {
    const panel = Object.create(exports.SftpPanel.prototype);
    const list = element("div");
    list.hidden = true;
    const menu = element("button");
    const row = element("button");
    row.dataset.fileAction = "open-bookmark";
    const root = element("div");
    root.querySelectorAll = () => [row];
    root.querySelector = selector => (selector.includes("bookmarks") ? menu : null);
    Object.assign(panel, { bookmarkList: list, ready: true, loading: false, entries: [], selection: new Set(),
      services: { files: {} }, root, pathField: {},
      abort: { abort() {} }, resize: { disconnect() {} }, motion: { cancel() {} }, loadRevision: 0,
    });
    panel.setBookmarkStore(store, alias);
    panels.push(panel);
    return { panel, list, menu, row };
  };
  const rows = list => list.children.filter(node => node.dataset.bookmarkId);
  const rowText = row => `${row.children[0].textContent} · ${row.children[1].textContent}`;
  const a = makePanel("a"), peer = makePanel("a"), b = makePanel("b");
  try {
    assert.equal(rows(a.list).length, 0);
    assert.match(a.list.children[0].textContent, /暂无收藏/);
    assert.equal(a.menu.disabled, true);
    assert.ok(store.saveBookmark({ id: "a1", alias: "a", name: "<Project>", path: "/project" }));
    assert.ok(store.saveBookmark({ id: "b1", alias: "b", name: "Other", path: "/other" }));
    assert.deepEqual(rows(a.list).map(row => row.dataset.bookmarkId), ["a1"]);
    assert.deepEqual(rows(peer.list).map(row => row.dataset.bookmarkId), ["a1"]);
    assert.deepEqual(rows(b.list).map(row => row.dataset.bookmarkId), ["b1"]);
    assert.equal(rowText(rows(a.list)[0]), "<Project> · /project");
    assert.equal(rows(a.list)[0].title, "/project");
    a.panel.syncActions();
    assert.equal(a.row.disabled, false);
    assert.equal(a.menu.disabled, false);
    const rendered = a.list.children;
    store.saveCommand({ name: "Unrelated", command: "pwd", note: "" });
    assert.equal(a.list.children, rendered);
    store.saveBookmark({ id: "a1", alias: "a", name: "Edited", path: "/new path" });
    assert.equal(rowText(rows(a.list)[0]), "Edited · /new path");
    assert.equal(rowText(rows(peer.list)[0]), "Edited · /new path");
    const opened = [];
    a.panel.openDirectory = async path => opened.push(path);
    await a.panel.action("open-bookmark", rows(a.list)[0]);
    assert.deepEqual(opened, ["/new path"]);
    // Another host's row must not resolve against this panel's bookmarks.
    await a.panel.action("open-bookmark", rows(b.list)[0]);
    assert.deepEqual(opened, ["/new path"]);
    a.panel.loading = true;
    a.panel.syncActions();
    assert.equal(a.row.disabled, true);
    await a.panel.action("open-bookmark", rows(a.list)[0]);
    assert.deepEqual(opened, ["/new path"]);
    a.panel.loading = false;
    a.panel.ready = false;
    a.panel.syncActions();
    assert.equal(a.menu.disabled, true);
    await a.panel.action("open-bookmark", rows(a.list)[0]);
    assert.deepEqual(opened, ["/new path"]);
    a.panel.ready = true;
    store.remove("bookmark", "a1");
    assert.equal(rows(a.list).length, 0);
    assert.equal(a.menu.disabled, true);
    a.panel.setBookmarkStore(store, "b");
    assert.equal(store.listeners.size, 3);
    assert.deepEqual(rows(a.list).map(row => row.dataset.bookmarkId), ["b1"]);
    const replacement = new WorkspaceStore({ getItem: () => null, setItem() {} });
    a.panel.setBookmarkStore(replacement, "b");
    assert.equal(store.listeners.size, 2);
    assert.equal(replacement.listeners.size, 1);
    a.panel.dispose();
    assert.equal(replacement.listeners.size, 0);
    const disposed = a.list.children;
    replacement.saveBookmark({ alias: "b", name: "After disposal", path: "/after" });
    assert.equal(a.list.children, disposed);
    a.panel.setBookmarkStore(store, "a");
    assert.equal(store.listeners.size, 2);
  } finally {
    for (const panel of panels) panel.dispose();
  }
  assert.equal(store.listeners.size, 0);
});

test("host groups become lanes while resources remain logical records", async () => {
  const storage = new Map(), previous = globalThis.localStorage;
  globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  try {
    const cards = new SshHostCards(true);
    await cards.refresh(async () => ({ ok:true, hosts:Array.from({length:8}, (_, i) => ({alias:'host-' + i, hostname:'localhost', user:'fixture', port:'22'})) }));
    for (const [kind, count] of [['session',2],['files',4],['monitor',6],['command',10],['history',12]])
      cards.publishResources(kind, Array.from({length:count}, (_, i) => ({kind,key:kind+i,title:kind+i,subtitle:'fixture'})));
    // Nothing is grouped yet, so every host sits in the one ungrouped lane.
    assert.deepEqual(archiveColumns, [UNGROUPED]);
    assert.ok(records.every(record => !record.id.startsWith('X-')));
    assert.ok(archiveColumns.flatMap((_, lane) => columnFiles(lane)).every(index => records[index].id.startsWith('H-')));
    // A group with hosts in it becomes a column of its own. The directory card
    // stays in the first lane, so that lane is the directory plus its members.
    assert.ok(cards.groups.create("训练集群"));
    const group = cards.groups.groups[0].id;
    cards.groups.setMembership("host-1", group, true);
    cards.groups.setMembership("host-3", group, true);
    assert.deepEqual(archiveColumns, ["训练集群", UNGROUPED]);
    assert.deepEqual(columnFiles(0).map(index => records[index].id), ["H-000", "H-002", "H-004"]);
    assert.deepEqual(columnFiles(1).map(index => records[index].id), ["H-001", "H-003", "H-005", "H-006", "H-007", "H-008"]);
    // One host in two groups is two records sharing one card number.
    assert.ok(cards.groups.create("预发环境"));
    cards.groups.setMembership("host-1", cards.groups.groups[1].id, true);
    assert.deepEqual(archiveColumns, ["训练集群", "预发环境", UNGROUPED]);
    const shared = columnFiles(1)[0], first = columnFiles(0)[1];
    assert.equal(records[shared].label, "H-002");
    assert.equal(records[first].label, "H-002");
    assert.notEqual(shared, first);
    assert.match(records[shared].id, /^H-002@/);
    // Emptying a group takes its column away rather than leaving a blank one.
    cards.groups.setMembership("host-3", group, false);
    cards.groups.setMembership("host-1", group, false);
    assert.deepEqual(archiveColumns, ["预发环境", UNGROUPED]);
    // Removing a host drops it from its groups, so no lane outlives its hosts.
    await cards.refresh(async () => ({ ok:true, hosts:[{alias:'host-5', hostname:'localhost', user:'fixture', port:'22'}] }));
    assert.deepEqual(archiveColumns, [UNGROUPED]);
    assert.equal(cards.groups.groups[1].aliases.length, 0);
    for (const kind of ['session','files','monitor','command','history']) {
      const resource = cards.resourceCard(kind, kind + '0');
      assert.notEqual(resource, undefined);
      assert.equal(cards.resourceAt(resource).kind, kind);
    }
    for (const shift of [3072, -5120, 7168]) {
      const samples = archiveColumns.flatMap((_, lane) => Array.from({length:60}, (_, i) => ({lane,row: i * 157 - 4600})));
      const before = samples.map(cell => fileAtCell(cell));
      rebaseArchiveRows(shift);
      samples.forEach((cell, i) => assert.equal(fileAtCell({...cell,row:cell.row-shift}), before[i]));
      archiveColumns.forEach((_, lane) => {
        const files = columnFiles(lane);
        files.forEach((index, i) => {
          const current = fileLocation(index), next = files[(i+1)%files.length];
          assert.equal(fileAtCell(current), index);
          assert.equal(fileAtCell(selectionCell(next, current, {axis:'row',direction:1})), next);
        });
      });
    }
    resetArchiveRows();
    archiveColumns.forEach((_, lane) => columnFiles(lane).forEach((index, row) => assert.equal(fileLocation(index).row, 12 + row)));
  } finally { globalThis.localStorage = previous; }
});

test("event audio deduplicates snapshots, batches transfers and marks intentional stops once", async () => {
  const sounds = [], audio = new SshEventAudio(sound => sounds.push(sound));
  let phase = "connecting";
  const context = { key: "one", manualStop: false, client: { generation: 1, pendingPrompt: { id: 1 }, exit: null, status: () => ({ phase }) }, services: { state: { jobs: [] } } };
  try {
    for (let i = 0; i < 10; i++) audio.update(context);
    assert.deepEqual(sounds, ["ssh-auth"]);
    context.client.pendingPrompt = null; phase = "interactive";
    for (let i = 0; i < 10; i++) audio.update(context);
    const jobs = context.services.state.jobs = [{ id: "a", state: "queued" }, { id: "b", state: "queued" }];
    audio.update(context); jobs[0].state = "completed"; audio.update(context);
    jobs[1].state = "completed"; audio.update(context);
    await new Promise(resolve => setTimeout(resolve, 400));
    for (let i = 0; i < 10; i++) audio.update(context);
    context.manualStop = true; context.client.exit = { exitCode: 1 }; audio.update(context);
    for (let i = 0; i < 10; i++) audio.update(context);
    assert.deepEqual(sounds, ["ssh-auth", "ssh-connected", "ssh-transfer-complete", "ssh-ended"]);
  } finally { audio.dispose(); }
});
