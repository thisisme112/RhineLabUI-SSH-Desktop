"use strict";

/** Small, bounded console observer used only before authentication. ConPTY can
 * repaint the wrap column, so stripping CSI would duplicate a path character.
 * This never changes the raw stream sent to xterm or any interactive output. */
function consolePromptText(text, columns = 32767, rows = 32767) {
  const lines = new Map();
  let row = 0,
    col = 0;
  const line = () => {
    if (!lines.has(row)) lines.set(row, []);
    return lines.get(row);
  };
  const down = () => {
    if (++row < rows) return;
    // Cursor addressing is relative to the visible console, including after
    // a diagnostic scrolls off its bottom edge.
    row = rows - 1;
    const previous = [...lines.entries()];
    lines.clear();
    for (const [at, cells] of previous) if (at > 0) lines.set(at - 1, cells);
  };
  const tokens =
    text.match(
      /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]|[^]/gu,
    ) || [];
  for (const token of tokens) {
    if (token.startsWith("\x1b[")) {
      const match = token.match(/^\x1b\[([0-9;]*)([A-Za-z`])$/);
      if (!match) continue;
      const args = match[1].split(";").map(Number),
        n = args[0] || 1;
      switch (match[2]) {
        case "D":
          col = Math.max(0, col - n);
          break;
        case "C":
          col = Math.min(columns - 1, col + n);
          break;
        case "G":
        case "`":
          col = Math.min(columns - 1, n - 1);
          break;
        case "A":
          row = Math.max(0, row - n);
          break;
        case "B":
          row = Math.min(rows - 1, row + n);
          break;
        case "H":
        case "f":
          row = Math.min(rows - 1, n - 1);
          col = Math.min(columns - 1, (args[1] || 1) - 1);
          break;
        case "J":
          if (args[0] === 2 || args[0] === 3) lines.clear();
          break;
        case "K":
          if (args[0] === 2) lines.set(row, []);
          else if (!args[0]) line().length = col;
          break;
      }
      continue;
    }
    if (token.startsWith("\x1b")) continue;
    if (token === "\r") {
      col = 0;
      continue;
    }
    if (token === "\n") {
      down();
      continue;
    }
    if (token === "\b") {
      col = Math.max(0, col - 1);
      continue;
    }
    if (token.charCodeAt(0) < 32) continue;
    const code = token.codePointAt(0);
    const width = /[\p{Mark}\p{Format}]/u.test(token)
      ? 0
      : code >= 0x1100 &&
          (code <= 0x115f ||
            code === 0x2329 ||
            code === 0x232a ||
            (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
            (code >= 0xac00 && code <= 0xd7a3) ||
            (code >= 0xf900 && code <= 0xfaff) ||
            (code >= 0xfe10 && code <= 0xfe19) ||
            (code >= 0xfe30 && code <= 0xfe6f) ||
            (code >= 0xff01 && code <= 0xff60) ||
            (code >= 0xffe0 && code <= 0xffe6) ||
            (code >= 0x1f300 && code <= 0x1faff) ||
            (code >= 0x20000 && code <= 0x3fffd))
        ? 2
        : 1;
    if (!width) {
      const cells = line();
      let previous = col - 1;
      while (previous > 0 && cells[previous] === "") previous--;
      if (cells[previous]) cells[previous] += token;
      continue;
    }
    if (col + width > columns) {
      // A wide character cannot occupy the final single cell. ConPTY may
      // repaint that position with padding before wrapping the character.
      if (width === 2 && col === columns - 1) line()[col] = "";
      down();
      col = 0;
    }
    // Sparse absolute cursor rows must stay bounded even for malformed input.
    if (row > 32767 || col > 32767) continue;
    line()[col++] = token;
    if (width === 2) line()[col++] = "";
  }
  return [...lines.entries()]
    .filter(([at]) => at <= row)
    .sort((a, b) => a[0] - b[0])
    .map(([, cells]) => Array.from(cells, (value) => value ?? " ").join(""))
    .join("\n");
}
module.exports = { consolePromptText };
