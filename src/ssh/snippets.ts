export const shellQuote = (value: string) =>
  "'" + value.replaceAll("'", "'\\''") + "'";
const pattern = () =>
  /\{\{([a-zA-Z_][a-zA-Z0-9_]{0,31})(?:=([^{}\r\n]{0,256}))?\}\}/g;
export function snippetParameters(command: string) {
  return [
    ...new Map(
      [...command.matchAll(pattern())].map((match) => [
        match[1],
        { name: match[1], value: match[2] || "" },
      ]),
    ).values(),
  ];
}
export function expandSnippet(command: string, values: Record<string, string>) {
  const params = snippetParameters(command);
  for (const p of params)
    if (
      !values[p.name] ||
      /[\x00-\x1f\x7f]/.test(values[p.name]) ||
      values[p.name].length > 4096
    )
      throw new Error(`请填写参数 ${p.name}（不能包含控制字符）`);
  // Parameters already become single-quoted shell words. Adding another pair
  // of quotes around the placeholder could undo that protection.
  const offsets = new Map(
    [...command.matchAll(pattern())].map((match) => [
      match.index,
      match[0].length,
    ]),
  );
  let quote = "",
    escaped = false;
  for (let index = 0; index < command.length; index++) {
    if (offsets.has(index) && (quote || escaped))
      throw new Error("参数占位符不要放在引号或反引号中，应用会自动转义参数值");
    if (offsets.has(index)) {
      index += offsets.get(index)! - 1;
      continue;
    }
    const ch = command[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = "";
    } else if (["'", '"', "`"].includes(ch)) quote = ch;
  }
  return command.replace(pattern(), (_match, name: string) =>
    shellQuote(values[name]),
  );
}
