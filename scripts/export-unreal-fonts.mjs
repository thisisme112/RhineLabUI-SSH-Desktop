/**
 * Ships the web's MiSans to Unreal exactly as the web loads it.
 *
 * src/fonts.css splits MiSans 4.3.1 into ~188 unicode-range subsets per weight.
 * Slate cannot read WOFF2, so each subset is unpacked to plain OpenType with
 * Node's brotli, and the unicode ranges are written to a manifest the Unreal
 * side turns into one FCompositeFont per weight (a sub-typeface per subset).
 * Nothing is re-drawn or merged, so outlines and each subset's own layout
 * tables are the web's bytes.
 *
 * CFF-flavoured WOFF2 carries no transformed tables (WOFF2 only transforms
 * glyf/loca/hmtx of TrueType fonts); a transformed table is rejected rather
 * than guessed at.
 *
 *   node scripts/export-unreal-fonts.mjs
 *   -> prototypes/unreal/Content/Fonts/MiSans/{light,regular,demibold,bold}/*.otf + manifest.json
 */
import { brotliDecompressSync, inflateSync } from "node:zlib";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "prototypes", "unreal", "Content", "Fonts", "MiSans");

const KNOWN = ["cmap", "head", "hhea", "hmtx", "maxp", "name", "OS/2", "post", "cvt ", "fpgm", "glyf", "loca", "prep", "CFF ", "VORG", "EBDT",
  "EBLC", "gasp", "hdmx", "kern", "LTSH", "PCLT", "VDMX", "vhea", "vmtx", "BASE", "GDEF", "GPOS", "GSUB", "EBSC", "JSTF", "MATH", "CBDT",
  "CBLC", "COLR", "CPAL", "SVG ", "sbix", "acnt", "avar", "bdat", "bloc", "bsln", "cvar", "fdsc", "feat", "fmtx", "fvar", "gvar", "hsty",
  "just", "lcar", "mort", "morx", "opbd", "prop", "trak", "Zapf", "Silf", "Glat", "Gloc", "Feat", "Sill"];

export function woff2ToOpenType(buffer) {
  if (buffer.toString("latin1", 0, 4) !== "wOF2") throw new Error("not WOFF2");
  const flavor = buffer.readUInt32BE(4), count = buffer.readUInt16BE(12), compressed = buffer.readUInt32BE(20);
  let at = 48;
  const base128 = () => {
    let value = 0;
    for (let i = 0; i < 5; i++) {
      const byte = buffer[at++];
      value = value * 128 + (byte & 0x7f);
      if (!(byte & 0x80)) return value;
    }
    throw new Error("bad UIntBase128");
  };
  const tables = [];
  for (let i = 0; i < count; i++) {
    const flags = buffer[at++];
    const tag = (flags & 0x3f) === 63 ? buffer.toString("latin1", at, (at += 4)) : KNOWN[flags & 0x3f];
    const version = flags >> 6;
    const length = base128();
    const transformed = tag === "glyf" || tag === "loca" ? version !== 3 : version !== 0;
    if (transformed) throw new Error(`transformed ${tag} is not supported`);
    tables.push({ tag, length });
  }
  const data = brotliDecompressSync(buffer.subarray(at, at + compressed));
  let offset = 0;
  for (const table of tables) { table.data = data.subarray(offset, offset + table.length); offset += table.length; }
  tables.sort((a, b) => (a.tag < b.tag ? -1 : 1));
  const header = Buffer.alloc(12 + 16 * tables.length);
  const power = 2 ** Math.floor(Math.log2(tables.length));
  header.writeUInt32BE(flavor, 0);
  header.writeUInt16BE(tables.length, 4);
  header.writeUInt16BE(power * 16, 6);
  header.writeUInt16BE(Math.log2(power), 8);
  header.writeUInt16BE(tables.length * 16 - power * 16, 10);
  const chunks = [header];
  let position = header.length;
  tables.forEach((table, index) => {
    const padded = Buffer.alloc((table.length + 3) & ~3);
    table.data.copy(padded);
    let sum = 0;
    for (let i = 0; i < padded.length; i += 4) sum = (sum + padded.readUInt32BE(i)) >>> 0;
    const record = 12 + 16 * index;
    header.write(table.tag, record, "latin1");
    header.writeUInt32BE(sum, record + 4);
    header.writeUInt32BE(position, record + 8);
    header.writeUInt32BE(table.length, record + 12);
    chunks.push(padded);
    position += padded.length;
  });
  return Buffer.concat(chunks);
}

/**
 * WOFF 1.0 to plain sfnt: each table is zlib-deflated on its own (or stored
 * when that would not be smaller), so unpacking is lossless and needs no
 * transform. Used for the terminal face, which fontsource ships as WOFF too.
 */
export function woffToOpenType(buffer) {
  if (buffer.toString("latin1", 0, 4) !== "wOFF") throw new Error("not WOFF");
  const flavor = buffer.readUInt32BE(4), count = buffer.readUInt16BE(12);
  const tables = [];
  for (let i = 0; i < count; i++) {
    const at = 44 + 20 * i;
    const tag = buffer.toString("latin1", at, at + 4);
    const offset = buffer.readUInt32BE(at + 4), compressed = buffer.readUInt32BE(at + 8), length = buffer.readUInt32BE(at + 12);
    const checksum = buffer.readUInt32BE(at + 16);
    const raw = buffer.subarray(offset, offset + compressed);
    tables.push({ tag, checksum, data: compressed < length ? inflateSync(raw) : raw });
  }
  tables.sort((a, b) => (a.tag < b.tag ? -1 : 1));
  const header = Buffer.alloc(12 + 16 * tables.length);
  const power = 2 ** Math.floor(Math.log2(tables.length));
  header.writeUInt32BE(flavor, 0);
  header.writeUInt16BE(tables.length, 4);
  header.writeUInt16BE(power * 16, 6);
  header.writeUInt16BE(Math.log2(power), 8);
  header.writeUInt16BE(tables.length * 16 - power * 16, 10);
  const chunks = [header];
  let position = header.length;
  tables.forEach((table, index) => {
    const padded = Buffer.alloc((table.data.length + 3) & ~3);
    table.data.copy(padded);
    const record = 12 + 16 * index;
    header.write(table.tag, record, "latin1");
    header.writeUInt32BE(table.checksum, record + 4);
    header.writeUInt32BE(position, record + 8);
    header.writeUInt32BE(table.data.length, record + 12);
    chunks.push(padded);
    position += padded.length;
  });
  return Buffer.concat(chunks);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const css = readFileSync(path.join(root, "src", "fonts.css"), "utf8");
  const faces = [...css.matchAll(/@font-face\{([^}]*)\}/g)].map((match) => {
    const body = match[1];
    const family = body.match(/font-family:"([^"]+)"/)?.[1];
    const weight = Number(body.match(/font-weight:(\d+)/)?.[1]);
    const url = body.match(/url\("([^"]+\.woff2)"\)/)?.[1];
    const ranges = (body.match(/unicode-range:([^;]+)/)?.[1] ?? "").split(",").map((part) => {
      const [from, to] = part.trim().replace(/^U\+/i, "").split("-");
      return [parseInt(from, 16), parseInt(to ?? from, 16)];
    });
    return { family, weight, url, ranges };
  }).filter((face) => face.family === "MiSans" && face.url);
  rmSync(target, { recursive: true, force: true });
  const manifest = { family: "MiSans", source: "src/fonts.css", weights: {} };
  for (const face of faces) {
    const source = path.join(root, "public", face.url);
    if (!existsSync(source)) throw new Error(`missing ${source}`);
    const relative = path.relative("/fonts/misans-webfont-4.3.1", face.url).replace(/\\/g, "/").replace(/\.woff2$/, ".otf");
    const file = path.join(target, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, woff2ToOpenType(readFileSync(source)));
    (manifest.weights[face.weight] ??= []).push({ file: relative, ranges: face.ranges });
  }
  writeFileSync(path.join(target, "manifest.json"), JSON.stringify(manifest));
  const counts = Object.entries(manifest.weights).map(([weight, list]) => `${weight}:${list.length}`).join(" ");
  console.log(`MiSans ${faces.length} subsets (${counts}) -> ${path.relative(root, target)}`);
  // The terminal face (src/ssh/terminal-appearance.ts): JetBrains Mono, the
  // Latin 400/700 cuts the web imports; CJK falls back to MiSans in Unreal.
  const mono = path.join(root, "prototypes", "unreal", "Content", "Fonts", "JetBrainsMono");
  rmSync(mono, { recursive: true, force: true });
  mkdirSync(mono, { recursive: true });
  for (const weight of [400, 700]) {
    const source = path.join(root, "node_modules", "@fontsource", "jetbrains-mono", "files", `jetbrains-mono-latin-${weight}-normal.woff`);
    writeFileSync(path.join(mono, `jetbrains-mono-latin-${weight}.ttf`), woffToOpenType(readFileSync(source)));
  }
  console.log(`JetBrains Mono 400/700 -> ${path.relative(root, mono)}`);
}
