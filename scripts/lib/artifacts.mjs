import path from "node:path";
import { execFileSync } from "node:child_process";
let commit = "local";
try { commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch {}
export const artifactRunId = process.env.RHINE_CHECK_RUN_ID ||= new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z") + "-" + commit;
export function artifactPath(relative) {
  const [suite, ...parts] = relative.replaceAll("\\", "/").split("/");
  if (!suite || relative.includes("..")) throw new Error("Invalid artifact suite");
  return path.join(".artifacts/checks", suite, artifactRunId, ...parts);
}
