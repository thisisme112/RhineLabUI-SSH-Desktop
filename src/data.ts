import content from "../content/archives.json" with { type: "json" };

export interface ArchiveRecord {
  id: string;
  title: string;
  en: string;
  department: string;
  category: string;
  date: string;
  lead: string;
  clearance: string;
  abstract: string;
  findings: string[];
  source: string;
}

export const records: ArchiveRecord[] = [...content.records];
export const categories = ["全部档案", ...content.categories];
export const archiveColumns = [...content.columns];
let originalCount = records.length;
const columnIndexes = archiveColumns.map(category => records.flatMap((record, index) => record.category === category ? [index] : []));
const extensionIndexes = new Map<string, number>();
const rowOffsets: number[] = archiveColumns.map(() => 0);
let repeatEmptyColumns = false;

/** Called before scene/navigation creation, only by the desktop catalog. */
export function configureArchiveColumns(columns: readonly string[], repeatEmpty = false) {
  repeatEmptyColumns = repeatEmpty;
  records.length = 0;
  originalCount = 0;
  extensionIndexes.clear();
  archiveColumns.splice(0, archiveColumns.length, ...columns);
  categories.splice(0, categories.length, "全部档案", ...columns);
  columnIndexes.splice(0, columnIndexes.length, ...columns.map(() => []));
  rowOffsets.splice(0, rowOffsets.length, ...columns.map(() => 0));
}

export function columnRowOffset(lane: number) { return rowOffsets[lane] || 0; }
export function resetArchiveRows() { rowOffsets.fill(0); }
export function rebaseArchiveRows(shift: number) {
  columnIndexes.forEach((files, lane) => {
    const period = files.length || 1;
    rowOffsets[lane] = ((columnRowOffset(lane) + shift) % period + period) % period;
  });
}

/** Runtime host archives are separate from the authored five-column content. */
export function setArchiveExtension(category: string, entries: readonly ArchiveRecord[]) {
  let lane = archiveColumns.indexOf(category);
  if (lane < 0) {
    lane = archiveColumns.push(category) - 1;
    categories.push(category);
  }
  columnIndexes[lane] = registerArchiveRecords(entries);
  return columnIndexes[lane];
}

/** Secondary SSH catalogs have stable record IDs without becoming 3D columns. */
export function registerArchiveRecords(entries: readonly ArchiveRecord[]) {
  return entries.map(record => {
    let index = extensionIndexes.get(record.id);
    if (index === undefined) {
      index = records.length;
      extensionIndexes.set(record.id, index);
      records.push(record);
    } else records[index] = record;
    return index;
  });
}

export function archiveFiles() { return columnIndexes.flat(); }
export function isActiveArchive(index: number) {
  return Number.isInteger(index) && index >= 0 && (index < originalCount || columnIndexes.some(files => files.includes(index)));
}

export function columnFiles(lane: number) {
  if (repeatEmptyColumns && !columnIndexes[lane]?.length) return columnIndexes.find(files => files.length) ?? [];
  return columnIndexes[lane] ?? [];
}
export function fileLocation(index: number) {
  const lane = archiveColumns.indexOf(records[index].category);
  const count = columnFiles(lane).length || 1;
  const row = 12 + ((columnFiles(lane).indexOf(index) - columnRowOffset(lane)) % count + count) % count;
  return { lane, row, slot: lane * 32 + row };
}
export function fileAtSlot(slot: number) {
  const files = columnFiles(Math.floor(slot / 32));
  return files[Math.max(0, Math.min(files.length - 1, (slot % 32) - 12))];
}
