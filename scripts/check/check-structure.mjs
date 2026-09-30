import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import ts from "typescript";

const root = process.cwd(),
  failures = [];
let modules = 0;
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!["resources", "assets", "boot-frames"].includes(entry.name))
        walk(file);
    } else if (/\.(?:ts|mjs|cjs|js)$/.test(file)) {
      modules++;
      const source = ts.createSourceFile(
        file,
        fs.readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      const check = (literal) => {
        if (
          !literal ||
          !ts.isStringLiteral(literal) ||
          !literal.text.startsWith(".")
        )
          return;
        const target = path.resolve(
          path.dirname(file),
          literal.text.split("?")[0],
        );
        if (
          ![
            target,
            ...[".ts", ".js", ".mjs", ".cjs", "/index.ts"].map(
              (suffix) => target + suffix,
            ),
          ].some((candidate) => fs.existsSync(candidate))
        )
          failures.push(`${path.relative(root, file)} -> ${literal.text}`);
      };
      function visit(node) {
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
          check(node.moduleSpecifier);
        if (
          ts.isCallExpression(node) &&
          (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            node.expression.getText(source) === "require")
        )
          check(node.arguments[0]);
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
  }
}
for (const directory of ["src", "scripts", "electron"])
  walk(path.join(root, directory));
for (const [name, command] of Object.entries({
  ...JSON.parse(fs.readFileSync("package.json")).scripts,
  ...JSON.parse(fs.readFileSync("scripts/check/commands.json")),
})) {
  for (const match of command.matchAll(
    /(?:node\s+(?:--[\w-]+\s+)*)?(scripts\/[^\s]+|electron\/[^\s]+\.cjs)/g,
  ))
    if (!fs.existsSync(match[1])) failures.push(`${name} -> ${match[1]}`);
}
assert.deepEqual(
  failures,
  [],
  "Moved module imports and command paths must resolve",
);
console.log(`Structure check passed: ${modules} modules and npm entry points`);
