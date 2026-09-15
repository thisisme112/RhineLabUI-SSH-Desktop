import fs from "node:fs";
import path from "node:path";

const roots = [
  "@fontsource/jetbrains-mono",
  "@fontsource/ibm-plex-mono",
  "codemirror",
  "@codemirror/lang-javascript",
  "@codemirror/lang-json",
  "@codemirror/lang-python",
  "@codemirror/legacy-modes",
  "@codemirror/merge",
  "@xterm/xterm",
  "@xterm/addon-fit",
  "@xterm/addon-search",
];
const seen = new Set(),
  sections = [];
function visit(name) {
  if (seen.has(name)) return;
  seen.add(name);
  const directory = path.resolve("node_modules", name);
  const pkg = JSON.parse(
    fs.readFileSync(path.join(directory, "package.json"), "utf8"),
  );
  const file = fs
    .readdirSync(directory)
    .find((file) => /^(license|ofl|copying)(\.(txt|md))?$/i.test(file));
  if (!file) throw new Error(`Missing license text: ${name}`);
  sections.push(
    `${name}@${pkg.version}\n${"=".repeat(name.length + pkg.version.length + 1)}\n${fs.readFileSync(path.join(directory, file), "utf8").trim()}\n`,
  );
  for (const dependency of Object.keys(pkg.dependencies || {}).sort())
    visit(dependency);
}
for (const name of roots.sort()) visit(name);
fs.mkdirSync("licenses", { recursive: true });
fs.writeFileSync(
  "licenses/SSH-UI-NOTICES.txt",
  "Rhine Lab SSH UI — third-party licenses\n\nBundled terminal fonts retain their upstream names and SIL Open Font License.\nOnly Latin regular and bold webfont subsets are shipped. CodeMirror and xterm dependencies are bundled into the SSH renderer.\n\n" +
    sections.join("\n"),
);
console.log(`SSH UI notices: ${sections.length} packages`);
