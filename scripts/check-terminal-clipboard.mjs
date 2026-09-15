import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createTextClipboard,
  MAX_CLIPBOARD_BYTES,
} from "../electron/terminal-clipboard.cjs";

test("only an explicit read/write touches the clipboard and preserves Unicode/newlines", () => {
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
  assert.deepEqual(clipboard.readText(), { ok: true, text });
  assert.equal(reads, 1);
  const input = "printf '搜索🔎'\n";
  assert.deepEqual(clipboard.writeText(input), { ok: true });
  assert.equal(text, input);
  assert.equal(writes, 1);
});

test("limit is UTF-8 bytes; oversized input never alters clipboard or returns a prefix", () => {
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
  assert.equal(clipboard.writeText(exact).ok, true);
  assert.equal(clipboard.readText().text, exact);
  const oversized = "中".repeat(Math.ceil(MAX_CLIPBOARD_BYTES / 3));
  assert.equal(clipboard.writeText(oversized).ok, false);
  assert.equal(text, exact);
  assert.equal(writes, 1);
  text = oversized;
  const result = clipboard.readText();
  assert.equal(result.ok, false);
  assert.equal("text" in result, false);
});

test("invalid IPC payloads are rejected before write; empty text remains valid", () => {
  const writes = [];
  const clipboard = createTextClipboard({
    readText: () => "",
    writeText: (value) => writes.push(value),
  });
  for (const value of [null, undefined, 1, {}, [], Buffer.from("text")])
    assert.equal(clipboard.writeText(value).ok, false);
  assert.equal(writes.length, 0);
  assert.deepEqual(clipboard.readText(), { ok: true, text: "" });
  assert.deepEqual(clipboard.writeText(""), { ok: true });
  assert.deepEqual(writes, [""]);
});

test("OS clipboard errors are contained without leaking clipboard data", () => {
  const clipboard = createTextClipboard({
    readText() {
      throw new Error("private-read-content");
    },
    writeText() {
      throw new Error("private-write-content");
    },
  });
  for (const result of [clipboard.readText(), clipboard.writeText("hello")]) {
    assert.equal(result.ok, false);
    assert.ok(!JSON.stringify(result).includes("private"));
  }
});
