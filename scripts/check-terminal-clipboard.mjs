import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createTextClipboard,
  MAX_CLIPBOARD_BYTES,
} from "../electron/terminal-clipboard.cjs";

test("only an explicit read/write touches the clipboard and preserves Unicode/newlines", async () => {
  let text = "中文\r\nnext line\n",
    reads = 0,
    writes = 0;
  const clipboard = createTextClipboard({
    readText: () => {
      reads++;
      return text;
    },
    writeText: (value) => {
      writes++;
      text = value;
    },
  });
  assert.equal(reads + writes, 0);
  assert.deepEqual(await clipboard.readText(), { ok: true, text });
  assert.equal(reads, 1);
  const input = "printf '搜索🔎'\n";
  assert.deepEqual(await clipboard.writeText(input), { ok: true });
  assert.equal(text, input);
  assert.equal(writes, 1);
});

test("limit is UTF-8 bytes; oversized input never alters clipboard or returns a prefix", async () => {
  let text = "original",
    writes = 0;
  const clipboard = createTextClipboard({
    readText: () => text,
    writeText: (value) => {
      text = value;
      writes++;
    },
  });
  const exact = "a".repeat(MAX_CLIPBOARD_BYTES);
  assert.equal((await clipboard.writeText(exact)).ok, true);
  assert.equal((await clipboard.readText()).text, exact);
  const oversized = "中".repeat(Math.ceil(MAX_CLIPBOARD_BYTES / 3));
  assert.equal((await clipboard.writeText(oversized)).ok, false);
  assert.equal(text, exact);
  assert.equal(writes, 1);
  text = oversized;
  const result = await clipboard.readText();
  assert.equal(result.ok, false);
  assert.equal("text" in result, false);
});

test("invalid IPC payloads are rejected before write; empty text remains valid", async () => {
  const writes = [];
  const clipboard = createTextClipboard({
    readText: () => "",
    writeText: (value) => writes.push(value),
  });
  for (const value of [null, undefined, 1, {}, [], Buffer.from("text")])
    assert.equal((await clipboard.writeText(value)).ok, false);
  assert.equal(writes.length, 0);
  assert.deepEqual(await clipboard.readText(), { ok: true, text: "" });
  assert.deepEqual(await clipboard.writeText(""), { ok: true });
  assert.deepEqual(writes, [""]);
});

test("OS clipboard errors are contained without leaking clipboard data", async () => {
  const clipboard = createTextClipboard({
    readText() {
      throw new Error("private-read-content");
    },
    writeText() {
      throw new Error("private-write-content");
    },
  });
  for (const result of [await clipboard.readText(), await clipboard.writeText("hello")]) {
    assert.equal(result.ok, false);
    assert.ok(!JSON.stringify(result).includes("private"));
  }
});

// Electron 44's native clipboard resolves promises; the adapter must await
// them instead of rejecting the Promise object as "not text".
test("native promise-based clipboard reads and writes resolve as text", async () => {
  let text = "异步剪贴板\n",
    reads = 0,
    writes = 0;
  const clipboard = createTextClipboard({
    async readText() {
      reads++;
      return text;
    },
    async writeText(value) {
      writes++;
      text = value;
    },
  });
  const read = await clipboard.readText();
  assert.deepEqual(read, { ok: true, text: "异步剪贴板\n" });
  assert.equal(reads, 1);
  const input = "printf '异步粘贴🔎'\n";
  assert.deepEqual(await clipboard.writeText(input), { ok: true });
  assert.equal(text, input);
  assert.equal(writes, 1);
  assert.deepEqual(await clipboard.readText(), { ok: true, text: input });
  assert.equal(reads, 2);
});

test("promise-based clipboard still rejects non-strings, oversize and OS failures", async () => {
  let writes = 0;
  const clipboard = createTextClipboard({
    readText: async () => Promise.resolve("ok"),
    writeText: async () => {
      writes++;
      throw new Error("native-write-failure");
    },
  });
  for (const value of [null, undefined, 1, {}, [], Buffer.from("text"), Promise.resolve(7)])
    assert.equal((await clipboard.writeText(value)).ok, false);
  assert.equal(writes, 0);
  const oversized = "中".repeat(Math.ceil(MAX_CLIPBOARD_BYTES / 3));
  assert.equal((await clipboard.writeText(oversized)).ok, false);
  assert.equal(writes, 0);
  const bad = createTextClipboard({
    readText: async () => {
      throw new Error("private-read-content");
    },
    writeText: async () => {},
  });
  const failed = await bad.readText();
  assert.equal(failed.ok, false);
  assert.ok(!JSON.stringify(failed).includes("private"));
  assert.ok("error" in failed);
});
