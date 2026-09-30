// Labelled in-memory SFTP peer for the native editor input/close smoke only.
// The production preload and IPC remain in use; contextBridge APIs are frozen.
module.exports = class EditorFixtureServices {
  constructor({ id, send }) {
    this.id = id; this.send = send; this.closed = false;
    this.text = '# fixture\nkey: value\n'; this.revision = '1'.repeat(64);
    this.state = { sessionId: id, active: false, sftp: { state: 'waiting', message: 'Editor fixture' },
      monitor: { state: 'unsupported', message: 'Editor fixture' }, jobs: [], tunnels: [], sample: null, receivedAt: 0, history: [], prompt: null };
  }
  snapshot() { return structuredClone(this.state); }
  observeLog() {}
  setPrimaryPrompt() {}
  rememberPrimaryAnswer() {}
  activate() {
    this.state.active = true;
    this.state.sftp = { state: 'ready', message: 'Editor fixture', home: '/home/operator' };
    this.send({ sessionId: this.id, event: 'snapshot', data: this.snapshot() });
  }
  close() { this.closed = true; this.state.active = false; }
  list({ path = '/home/operator' }) {
    return Promise.resolve({ ok: true, result: { path, total: 1, cursor: '', entries: [{ name: 'config.yaml', path: path + '/config.yaml', kind: 'file', size: this.text.length, modified: 1, permissions: '-rw-r--r--' }] } });
  }
  document(path) { return { path, text: this.text, revision: this.revision, modified: 1, permissions: '-rw-r--r--' }; }
  call(sessionId, method, request) { if (sessionId !== this.id || this.closed) return Promise.resolve({ ok: false }); return this[method](request); }
  readText({ path }) { return Promise.resolve({ ok: true, result: this.document(path) }); }
  writeText({ path, text }) { this.text = text; this.revision = '2'.repeat(64); return Promise.resolve({ ok: true, result: { saved: true, document: this.document(path) } }); }
};
