/**
 * Preload for the desktop shell.
 *
 * Every capability is enumerated here by hand. `ipcRenderer` itself is never
 * exposed, and the renderer cannot name an executable: `start()` takes a launch
 * descriptor, and the main process builds and validates the argv.
 */
const { contextBridge, ipcRenderer, webUtils } = require("electron");

/** Wrap a listener so callers get an unsubscribe function and no event object. */
const subscribe = (channel) => (listener) => {
  const wrapped = (_event, payload) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
};

contextBridge.exposeInMainWorld("rhineDesktop", {
  isDesktop: true,
  platform: process.platform,
  /** Report which of the two captions to use; the OS draws it, not us. */
  theme: (value) => ipcRenderer.send("shell:theme", value),
  services: {
    snapshot: (sessionId) => ipcRenderer.invoke("services:snapshot", { sessionId }),
    answer: (request) => ipcRenderer.invoke("services:answer", request),
    onEvent: subscribe("services:event"),
  },
  sftp: {
    readText: request => ipcRenderer.invoke("sftp:readText", request),
    writeText: request => ipcRenderer.invoke("sftp:writeText", request),
    list: (request) => ipcRenderer.invoke("sftp:list", request),
    stat: (request) => ipcRenderer.invoke("sftp:stat", request),
    mkdir: (request) => ipcRenderer.invoke("sftp:mkdir", request),
    rename: (request) => ipcRenderer.invoke("sftp:rename", request),
    remove: (request) => ipcRenderer.invoke("sftp:remove", request),
    upload: (request) => ipcRenderer.invoke("sftp:upload", request),
    uploadDropped: async (sessionId, files, destination) => {
      try {
        if (!Array.isArray(files) || files.length === 0 || files.length > 256)
          throw new Error("请选择 1–256 个文件或目录");
        const paths = files.map((file) => webUtils.getPathForFile(file));
        if (paths.some((file) => !file))
          throw new Error("无法读取拖入文件的本地路径，请使用上传入口");
        return await ipcRenderer.invoke("sftp:drop", {
          sessionId,
          destination,
          paths,
        });
      } catch (error) {
        return { ok: false, error: String(error?.message || error) };
      }
    },
    download: (request) => ipcRenderer.invoke("sftp:download", request),
    cancel: (request) => ipcRenderer.invoke("sftp:cancel", request),
    retry: (request) => ipcRenderer.invoke("sftp:retry", request),
    conflict: (request) => ipcRenderer.invoke("sftp:conflict", request),
    reconnect: (request) => ipcRenderer.invoke("sftp:reconnect", request),
  },
  monitor: { retry: (request) => ipcRenderer.invoke("monitor:retry", request) },
  tunnels: {
    list: request => ipcRenderer.invoke("tunnels:list", request),
    start: request => ipcRenderer.invoke("tunnels:start", request),
    stop: request => ipcRenderer.invoke("tunnels:stop", request),
  },
  migration: {
    describeHosts: targets => ipcRenderer.invoke("migration:describeHosts", targets),
    exportCredentials: request => ipcRenderer.invoke("migration:exportCredentials", request),
    prepareCredentials: request => ipcRenderer.invoke("migration:prepareCredentials", request),
    importKeys: ticket => ipcRenderer.invoke("migration:importKeys", ticket),
    importCredentials: request => ipcRenderer.invoke("migration:importCredentials", request),
    cancel: ticket => ipcRenderer.invoke("migration:cancel", ticket),
  },
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  /** App-saved profiles alongside the user's system SSH config hosts. */
  hosts: () => ipcRenderer.invoke("hosts:list"),
  credentials: {
    status: target => ipcRenderer.invoke("credentials:status", target),
    save: request => ipcRenderer.invoke("credentials:save", request),
    remove: request => ipcRenderer.invoke("credentials:remove", request),
  },
  keys: {
    list: () => ipcRenderer.invoke("keys:list"),
    add: request => ipcRenderer.invoke("keys:add", request),
    remove: id => ipcRenderer.invoke("keys:remove", id),
  },
  clipboard: {
    readText: () => ipcRenderer.invoke("terminal:clipboard-read"),
    writeText: (text) => ipcRenderer.invoke("terminal:clipboard-write", text),
  },
  /** Renderer-side crash/error reporting; metadata only, sanitized in main. */
  captureError: (entry) => ipcRenderer.invoke("diagnostic:event", entry),
  hostProfiles: {
    save: (profile, revision) =>
      ipcRenderer.invoke("hosts:save", { profile, revision }),
    remove: (id, revision) =>
      ipcRenderer.invoke("hosts:remove", { id, revision }),
    pickIdentity: () => ipcRenderer.invoke("hosts:identity"),
  },
  /** Past session records, read back for the archive's host cards. */
  records: {
    list: () => ipcRenderer.invoke("records:list"),
    read: (file) => ipcRenderer.invoke("records:read", file),
    log: (file) => ipcRenderer.invoke("records:log", file),
    prune: () => ipcRenderer.invoke("records:prune"),
  },
  session: {
    reserve: () => ipcRenderer.invoke("session:reserve"),
    start: (descriptor, sessionId) => ipcRenderer.invoke("session:start", { descriptor, sessionId }),
    write: (data, sessionId) => ipcRenderer.send("session:input", { data, sessionId }),
    resize: (cols, rows, sessionId) => ipcRenderer.send("session:resize", { cols, rows, sessionId }),
    stop: (sessionId) => ipcRenderer.send("session:stop", { sessionId }),
    answer: (id, value, sessionId, remember = false) => ipcRenderer.invoke("session:answer", { id, value, sessionId, remember }),
    /** Persist the record of a finished session; returns where it landed. */
    record: (payload) => ipcRenderer.invoke("session:record", payload),
    /** Write the readable export, either to `target` or wherever the user picks. */
    export: (payload) => ipcRenderer.invoke("session:export", payload),
    onData: subscribe("session:data"),
    onLog: subscribe("session:log"),
    onPrompt: subscribe("session:prompt"),
    onTraffic: subscribe("session:traffic"),
    onExit: subscribe("session:exit"),
  },
});
