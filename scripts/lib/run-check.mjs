import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { artifactPath } from "./artifacts.mjs";
const commands = JSON.parse(fs.readFileSync(new URL("../check/commands.json", import.meta.url)));
const command = commands[process.argv[2]];
if (!command) throw new Error("Unknown check: " + process.argv[2]);
const steps = command.split(/\s+&&\s+/);
for (const [index, step] of steps.entries()) {
  const tokens = step.match(/"[^"]*"|'[^']*'|[^\s]+/g).map(token => token.replace(/^(["'])(.*)\1$/, "$2"));
  if (index === steps.length - 1) tokens.push(...process.argv.slice(3));
  for (let i = 0; i < tokens.length; i++) if (tokens[i] === "--out" && tokens[i + 1]?.startsWith(".artifacts/checks/")) tokens[i + 1] = artifactPath(tokens[i + 1].slice(".artifacts/checks/".length));
  const [executable, ...args] = tokens;
  const result = spawnSync(executable === "node" ? process.execPath : executable, args, { stdio: "inherit", env: process.env, windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) { process.exitCode = result.status ?? 1; break; }
}
