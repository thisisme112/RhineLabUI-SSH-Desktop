/** Verify the packaged, local-only DLSS 5 experiment on this Windows machine. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = path.resolve(root, process.env.RHINE_UNREAL_DLSS5_STAGE ?? "release/RhineLab-Unreal-DLSS5/Windows/RhineLabViewer");
const bin = path.join(stage, "Binaries", "Win64");
const normal = path.join(bin, "RhineLabViewer.exe");
const experiment = path.join(bin, "RhineLabViewer_nvngx.dll.exe");
const runtime = path.join(stage, "Plugins", "DLSS5ForUE5", "Binaries", "ThirdParty", "Win64", "nvngx_dlssnr.dll");
const out = path.join(root, "verification", "unreal-dlss5");
const logPath = path.join(stage, "Saved", "Logs", "RhineLabViewer.log");
const perfPath = path.join(stage, "Saved", "perf-probe.json");

mkdirSync(out, { recursive: true });
assert.ok(existsSync(normal), `Package the current Unreal project first: ${normal}`);
assert.ok(existsSync(runtime), `Neural runtime was not staged: ${runtime}`);
// UE's packaged game is monolithic; the third-party snippet checks the caller
// module path for "nvngx.dll". This alias is a local experiment, not an SDK fix.
copyFileSync(normal, experiment);

function run(name, args, width = 1280, height = 720) {
  const started = Date.now();
  const child = spawnSync(experiment, [
    "-perf-probe", "-dlss=1", "-windowed", `-ResX=${width}`, `-ResY=${height}`,
    "-nosound", "-NoSplash", "-log", ...args],
    { cwd: bin, encoding: "utf8", windowsHide: true, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(child.status, 0, `${name} exited ${child.status}: ${child.stderr ?? child.error ?? ""}`);
  assert.ok(existsSync(logPath) && statSync(logPath).mtimeMs >= started, `${name}: no fresh log`);
  assert.ok(existsSync(perfPath) && statSync(perfPath).mtimeMs >= started, `${name}: no fresh performance report`);
  const log = readFileSync(logPath, "utf8");
  assert.match(log, /LogExit: Exiting\./, `${name}: Unreal did not shut down cleanly`);
  assert.doesNotMatch(log, /Fatal error|Assertion failed|DLSS-NR EvaluateFeature failed/, `${name}: render failure`);
  copyFileSync(logPath, path.join(out, `${name}.log`));
  const perf = JSON.parse(readFileSync(perfPath, "utf8"));
  writeFileSync(path.join(out, `${name}.json`), JSON.stringify(perf, null, 2) + "\n");
  return { log, perf };
}

const baseline = run("dlaa", []);
const neural = run("neural", ["-neural"]);
const guided = run("guided-1080", ["-neural", "-dlss5-guides"], 1920, 1080);
assert.match(neural.log, /DLSS-NR snippet initialized through existing NGX core/);
assert.match(neural.log, /Created NGX feature 18/);
const counts = neural.log.match(/Attempts \/ successful \/ failed \/ resets: (\d+) \/ (\d+) \/ (\d+) \/ (\d+)/);
assert.ok(counts, "The neural probe did not print real evaluation counters");
const [, attempts, successful, failed, resets] = counts.map(Number);
assert.ok(successful > 0 && failed === 0 && attempts === successful,
  `Neural evaluations: attempts=${attempts}, successful=${successful}, failed=${failed}`);
const guidedCounts = guided.log.match(/Attempts \/ successful \/ failed \/ resets: (\d+) \/ (\d+) \/ (\d+) \/ (\d+)/);
assert.ok(guidedCounts, "The guided probe did not print evaluation counters");
const [, guidedAttempts, guidedSuccessful, guidedFailed, guidedResets] = guidedCounts.map(Number);
assert.ok(guidedSuccessful > 0 && guidedFailed === 0 && guidedAttempts === guidedSuccessful,
  `Guided evaluations: attempts=${guidedAttempts}, successful=${guidedSuccessful}, failed=${guidedFailed}`);
assert.ok(/Depth \(UE scene depth \/ DLSS host input\) requested\/available\/used: YES \/ YES \/ YES/.test(guided.log),
  "1080p guide probe did not feed scene depth");
assert.ok(/Motion requested\/available\/used: YES \/ YES \/ YES/.test(guided.log),
  "1080p guide probe did not feed motion vectors");

const report = {
  generated: new Date().toISOString(), status: "passed", stage,
  runtime: { bytes: statSync(runtime).size, sha256: createHash("sha256").update(readFileSync(runtime)).digest("hex") },
  mode: "unofficial NGX feature 18; default launch is color-only, guided mode is probe-only",
  evaluations: { attempts, successful, failed, resets },
  baseline: { fps: baseline.perf.fps, gpuMs: baseline.perf.gpuMs },
  neural: { fps: neural.perf.fps, gpuMs: neural.perf.gpuMs },
  guided1080: { evaluations: { attempts: guidedAttempts, successful: guidedSuccessful, failed: guidedFailed, resets: guidedResets },
    fps: guided.perf.fps, gpuMs: guided.perf.gpuMs, depthUsed: true, motionUsed: true },
};
writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(`DLSS5 passed: color ${successful}/${attempts}, guided 1080p ${guidedSuccessful}/${guidedAttempts}; GPU ${baseline.perf.gpuMs.toFixed(2)} -> ${neural.perf.gpuMs.toFixed(2)} ms at 720p.`);
console.log(path.join(out, "report.json"));
