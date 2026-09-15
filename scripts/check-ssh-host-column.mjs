import assert from "node:assert/strict";
import { SshHostCards } from "../src/ssh/host-cards.ts";
import { archiveColumns, records, columnFiles, fileLocation, archiveFiles, isActiveArchive } from "../src/data.ts";
import { fileAtCell, selectionCell } from "../src/archive-loop.ts";

const storage = new Map();
globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
const original = JSON.stringify(records);
const cards = new SshHostCards();
const host = index => ({ alias: `host-${index}`, hostname: `node-${index}.example`, user: "operator", port: "22" });
assert.equal(cards.lane, 5);
assert.equal(archiveColumns.length, 6);
assert.equal(cards.directoryCard, 40);
for (const count of [0, 1, 8, 33, 256]) {
  await cards.refresh(async () => ({ ok: true, hosts: Array.from({ length: count }, (_, index) => host(index)) }));
  const files = columnFiles(cards.lane);
  assert.equal(files.length, count + 1);
  assert.equal(new Set(files).size, files.length);
  assert.equal(archiveFiles().length, 41 + count);
  for (let index = 0; index < files.length; index++) {
    const cell = fileLocation(files[index]);
    assert.equal(fileAtCell(cell), files[index]);
    for (const direction of [-1, 1]) {
      const next = files[(index + direction + files.length) % files.length];
      const nextCell = selectionCell(next, cell, { axis: "row", direction });
      assert.equal(fileAtCell(nextCell), next);
      assert.equal(nextCell.row - cell.row, direction);
    }
    assert.equal(fileAtCell({ lane: cell.lane + archiveColumns.length * 400, row: cell.row + files.length * 400 }), files[index]);
  }
  for (let lane = 0; lane < 5; lane++) {
    assert.equal(columnFiles(lane).length, 8);
    for (const index of columnFiles(lane)) assert.equal(fileAtCell(fileLocation(index)), index);
  }
  assert.equal(JSON.stringify(records.slice(0, 40)), original);
}
const removed = cards.cardOf("host-1");
const retained = cards.cardOf("host-2");
const id = records[retained].id;
await cards.refresh(async () => ({ ok: true, hosts: [{ ...host(2), displayName: "新名称" }, host(300)] }));
assert.equal(cards.cardOf("host-2"), retained);
assert.equal(records[retained].id, id);
assert.equal(records[retained].title, "新名称");
assert.equal(cards.cardOf("host-1"), undefined);
assert.equal(isActiveArchive(removed), false);
assert.equal(archiveFiles().includes(removed), false);
assert.notEqual(cards.cardOf("host-300"), removed);
assert.equal(fileAtCell(fileLocation(retained)), retained);
const countBeforeFailure = archiveFiles().length;
await cards.refresh(async () => ({ ok: false, hosts: [], error: "read failed" }));
assert.equal(archiveFiles().length, countBeforeFailure);
assert.equal(cards.cardOf("host-2"), retained);
for (const invalid of [-1, NaN, 0.5, records.length]) assert.equal(isActiveArchive(invalid), false);
console.log("Host column: 0 / 1 / 8 / 33 / 256 hosts, adjacent cyclic navigation, long-coordinate periods, rename, removal, reserved identity and authored-content isolation passed.");
