/**
 * Build, stage, self-test and capture the Unreal SSH workbench.
 *
 *   npm run check:unreal-workbench
 *   npm run check:unreal-workbench -- --skip-build
 *
 * The workbench ships as a packaged Windows app whose executable is replaced by
 * the freshly built development binary, so every run has to prove four things:
 * the target compiles, the staged binary really is the one under test, the
 * native ConPTY round-trip still echoes a command back, and both capture modes
 * still render the deck. Any of those silently regressing is expensive to
 * notice by hand, so they are asserted here.
 *
 * Reports land in verification/unreal-prototype/.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const engine = process.env.RHINE_UNREAL_ENGINE ?? "E:\\UE_5.8";
const project = path.join(root, "prototypes", "unreal");
const uproject = path.join(project, "RhineLabViewer.uproject");
const builtExe = path.join(project, "Binaries", "Win64", "RhineLabViewer.exe");
const staged = path.resolve(root, process.env.RHINE_UNREAL_STAGE ?? "release/RhineLab-Unreal/Windows/RhineLabViewer");
const stagedExe = path.join(staged, "Binaries", "Win64", "RhineLabViewer.exe");
const saved = path.join(staged, "Saved");
const shots = path.join(saved, "Screenshots", "Windows");
const outDir = path.join(root, "verification", "unreal-prototype");
const skipBuild = process.argv.includes("--skip-build");

const homeOnly = process.argv.includes("--home-flow");
const checks = [];
const validationPath = path.join(outDir, homeOnly ? "home-flow-report.json" : "report.json");
const validationStarted = new Date().toISOString();
let validationStatus = "running";
function checkpoint(extra = {}) {
  mkdirSync(outDir, { recursive: true });
  const data = { started: validationStarted, generated: new Date().toISOString(), status: validationStatus,
    engine, binary: existsSync(stagedExe) ? { path: stagedExe, bytes: statSync(stagedExe).size, built: statSync(stagedExe).mtime.toISOString() } : null,
    checks, ...extra };
  writeFileSync(validationPath + ".tmp", JSON.stringify(data, null, 2) + "\n");
  renameSync(validationPath + ".tmp", validationPath);
}
checkpoint();
process.on("exit", code => {
  if (validationStatus === "running") {
    validationStatus = "failed";
    checkpoint({ exitCode: code, note: "验证未完成；已通过的条目不代表整体验收。" });
  }
});
function check(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  checkpoint();
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) throw new Error(`${name}${detail ? `: ${detail}` : ""}`);
}

function run(file, args, options = {}) {
  return spawnSync(file, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
}

/**
 * Launch the app detached from any console, the way a double click does.
 *
 * A ConPTY child started from a console-attached parent exits immediately, so a
 * plain spawn() makes the self-test fail for reasons that have nothing to do
 * with the workbench. `cmd /c start /wait` reproduces the shipped launch path.
 */
function play(args, timeout = 120000) {
  const started = Date.now();
  // Scripted runs never need frame generation, and Streamline's interposer makes
  // them flaky (a stall after LogExit, or a silent exit early on): leave it out.
  const result = run("cmd.exe", ["/c", "start", "/wait", "", stagedExe, ...args, "-slno"],
    { cwd: path.dirname(stagedExe), timeout });
  const logPath = path.join(saved, "Logs", "RhineLabViewer.log");
  const log = existsSync(logPath) && statSync(logPath).mtimeMs >= started ? readFileSync(logPath, "utf8") : "";
  check(`进程正常退出：${args.find(arg => /probe|capture|selftest/.test(arg)) ?? "viewer"}`,
    result.status === 0 && log.includes("LogExit: Exiting.") && !/Fatal error|Assertion failed|missing usage flag|Default Material will be used/.test(log),
    `exit=${result.status}; fresh shutdown=${log.includes("LogExit: Exiting.")}`);
  return { result, started };
}

function freshShot(name, started) {
  const file = path.join(shots, name);
  if (!existsSync(file)) return null;
  const stat = statSync(file);
  return stat.mtimeMs >= started ? stat : null;
}

mkdirSync(outDir, { recursive: true });

// The Unreal opening reads tables generated from the web sources, so they are
// regenerated here: a web-side tweak can never leave Unreal with stale values.
const exportRun = run(process.execPath, [path.join("scripts", "export-boot-tracks.mjs")], { cwd: root });
check("the Unreal boot tables regenerate from src/boot-*.ts", exportRun.status === 0,
  (exportRun.stdout ?? "").trim() || (exportRun.stderr ?? "").trim());

if (!skipBuild) {
  const build = run("cmd.exe", ["/c", path.join(engine, "Engine", "Build", "BatchFiles", "Build.bat"),
    "RhineLabViewer", "Win64", "Development", `-Project=${uproject}`, "-WaitMutex", "-NoHotReloadFromIDE"],
    { cwd: project, timeout: 1800000 });
  const output = `${build.stdout ?? ""}\n${build.stderr ?? ""}`;
  check("the UE 5.8 target compiles", build.status === 0 && output.includes("Result: Succeeded"),
    output.trim().split(/\r?\n/).filter(line => line.includes("Result:") || line.includes("error")).slice(-3).join(" / "));
  check("the build produced an executable", existsSync(builtExe));
} else {
  check("the development executable already exists", existsSync(builtExe), builtExe);
}

// The opening frames are build output, not source: stage them only when the
// bake changed so a routine check does not copy ~180 MB every run.
const frameSource = path.join(project, "Build", "BootFrames");
const frameTarget = path.join(staged, "Binaries", "Win64", "BootFrames");
const manifest = path.join(frameSource, "boot-frames.json");
if (existsSync(manifest)) {
  mkdirSync(frameTarget, { recursive: true });
  const wanted = readFileSync(manifest, "utf8");
  const stagedManifest = path.join(frameTarget, "boot-frames.json");
  const current = existsSync(stagedManifest) ? readFileSync(stagedManifest, "utf8") : "";
  if (current !== wanted) {
    for (const entry of readdirSync(frameSource).filter(name => name.endsWith(".jpg") || name.endsWith(".json"))) {
      copyFileSync(path.join(frameSource, entry), path.join(frameTarget, entry));
    }
    console.log(`      staged ${JSON.parse(wanted).count} baked opening frames`);
  }
  check("the baked opening frames match their manifest",
    readdirSync(frameTarget).filter(name => name.endsWith(".jpg")).length === JSON.parse(wanted).count);
} else {
  check("the baked opening frames exist", false, `${frameSource} has no boot-frames.json`);
}

// The 4K120 opening is a hardware-decoded HEVC stream: it is small enough to
// stage unconditionally, and its presence is what makes the video path (rather
// than the 1440p JPEG fallback) the one the app under test actually exercises.
for (const name of ["boot-1440p120-h264.mp4","boot-1440p120-hevc.mp4","boot-4k60-hevc.mp4","boot-4k120-hevc.mp4"]) {
  const source=path.join(project,"Build","BootVideo",name);
  const target=path.join(staged,"Binaries","Win64","BootVideo",name);
  check(name+" exists",existsSync(source),source);
  mkdirSync(path.dirname(target),{recursive:true}); copyFileSync(source,target);
}
// A just-finished run (or a virus scan of the fresh binary) can hold the file
// for a moment; retry instead of failing the whole check.
for (let attempt = 0; ; ++attempt) {
  try { copyFileSync(builtExe, stagedExe); break; }
  catch (error) {
    if (error.code !== "EBUSY" || attempt >= 20) throw error;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
}
mkdirSync(path.join(staged,"Content","Data"),{recursive:true});
copyFileSync(path.join(project,"Content","Data","archive-brand.png"),path.join(staged,"Content","Data","archive-brand.png"));
// MiSans exactly as src/fonts.css ships it; regenerated when missing (generated, gitignored).
const fontSource = path.join(project, "Content", "Fonts", "MiSans");
if (!existsSync(path.join(fontSource, "manifest.json")) || !existsSync(path.join(project, "Content", "Fonts", "JetBrainsMono"))) run(process.execPath, [path.join("scripts", "export-unreal-fonts.mjs")], { cwd: root });
check("MiSans font subsets exported", existsSync(path.join(fontSource, "manifest.json")));
cpSync(fontSource, path.join(staged, "Content", "Fonts", "MiSans"), { recursive: true });
cpSync(path.join(project, "Content", "Fonts", "JetBrainsMono"), path.join(staged, "Content", "Fonts", "JetBrainsMono"), { recursive: true });
const digest = file => createHash("sha256").update(readFileSync(file)).digest("hex");
check("the staged app carries the freshly built binary", digest(stagedExe) === digest(builtExe));

/**
 * 3.3 / 3.4: the SSH event parser, phase tracker and pty splitter are diffed
 * against the desktop pipeline on one fixture, then three live ConPTY sessions
 * against scripts/fixtures/fake-ssh.mjs exercise the session bank.
 */
async function sshSessionChecks() {
  const { fixture, reference } = await import(pathToFileURL(path.join(root, "scripts", "fixtures", "unreal-ssh-events.mjs")).href);
  const fixturePath = path.join(saved, "ssh-events-fixture.json");
  mkdirSync(saved, { recursive: true });
  writeFileSync(fixturePath, JSON.stringify(fixture));
  const eventsRun = play(["-ssh-events-probe", `-ssh-events-fixture=${fixturePath}`, "-windowed", "-ResX=1280", "-ResY=720", "-nosound"]);
  const eventsPath = path.join(saved, "ssh-events-probe.json");
  check("SSH 事件探针生成新报告", eventsRun.result.status === 0 && existsSync(eventsPath) && statSync(eventsPath).mtimeMs >= eventsRun.started);
  const unreal = JSON.parse(readFileSync(eventsPath, "utf8"));
  const expected = reference();
  const differences = [];
  const compare = (where, a, b) => {
    try { assert.deepStrictEqual(a, b); } catch { differences.push(`${where}: unreal=${JSON.stringify(a)} web=${JSON.stringify(b)}`); }
  };
  check("SSH 事件探针覆盖全部夹具", unreal.lines?.length === expected.lines.length && unreal.sessions?.length === expected.sessions.length, unreal.error ?? "");
  expected.lines.forEach((row, index) => compare(`line ${JSON.stringify(row.line)}`, unreal.lines[index], row));
  check(`逐行解析与 src/ssh/events.ts、electron/pty-events.cjs 一致（${expected.lines.length} 行）`, differences.length === 0, differences.slice(0, 3).join(" | "));
  for (const [index, session] of expected.sessions.entries()) {
    differences.length = 0;
    for (const key of Object.keys(session)) compare(key, unreal.sessions[index][key], session[key]);
    check(`会话状态机与桌面版一致：${session.name}（${session.status.phase}）`, differences.length === 0, differences.slice(0, 2).join(" | "));
  }
  copyFileSync(eventsPath, path.join(outDir, "ssh-events-probe.json"));

  const fake = { RHINE_SSH_PATH: process.execPath, RHINE_SSH_PREFIX: path.join(root, "scripts", "fixtures", "fake-ssh.mjs"),
    FAKE_SSH_HOLD_MS: "60000", FAKE_SSH_GAP_MS: "15" };
  Object.assign(process.env, fake);
  const sessionRun = play(["-ssh-session-probe", "-windowed", "-ResX=1600", "-ResY=900", "-nosound"], 120000);
  for (const key of Object.keys(fake)) delete process.env[key];
  const sessionPath = path.join(saved, "ssh-session-probe.json");
  check("多会话探针生成新报告", sessionRun.result.status === 0 && existsSync(sessionPath) && statSync(sessionPath).mtimeMs >= sessionRun.started);
  const sessions = JSON.parse(readFileSync(sessionPath, "utf8"));
  check("三个 ConPTY 会话：成功、拒绝、密码认证各自独立，后台保持连接，关闭与本地断开保留输出",
    sessions.passed === true, (sessions.failures ?? []).join(" / "));
  for (const name of ["session-tabs.png", "session-stopped.png"]) {
    check("会话截图：" + name, Boolean(freshShot(name, sessionRun.started)));
    copyFileSync(path.join(shots, name), path.join(outDir, name));
  }
  copyFileSync(sessionPath, path.join(outDir, "ssh-session-probe.json"));
  return sessions;
}

if (process.argv.includes("--ssh-session")) {
  const sessions = await sshSessionChecks();
  validationStatus = "passed";
  checkpoint({ sessions, note: "fake-ssh 驱动的真实 ConPTY 会话；未连接真实远程主机。" });
  console.log(`\n${checks.length} checks passed. Report: ${path.relative(root, outDir)}`);
  process.exit(0);
}

// The selected host card as a live terminal package: connect, authenticate in
// the document column, open the deck, close on its screen, hand over and back.
if (process.argv.includes("--deck-flow")) {
  const fake = { RHINE_SSH_PATH: process.execPath, RHINE_SSH_PREFIX: path.join(root, "scripts", "fixtures", "fake-ssh.mjs"),
    FAKE_SSH_HOLD_MS: "60000", FAKE_SSH_GAP_MS: "15" };
  Object.assign(process.env, fake);
  const flow = play(["-deck-flow-probe", "-windowed", "-ResX=1600", "-ResY=900", "-nosound"], 120000);
  for (const key of Object.keys(fake)) delete process.env[key];
  const probeFile = path.join(saved, "deck-flow-probe.json");
  check("主机卡终端盒流程生成新报告", existsSync(probeFile) && statSync(probeFile).mtimeMs >= flow.started);
  const report = JSON.parse(readFileSync(probeFile, "utf8"));
  for (const name of ["deck-01-packed.png", "deck-02-prompt.png", "deck-03-opening.png", "deck-04-screen.png", "deck-05-terminal.png", "deck-06-closing.png", "deck-07-closed.png", "deck-08-retained.png", "deck-09-window.png"]) {
    const shot = freshShot(name, flow.started);
    if (shot) copyFileSync(path.join(shots, name), path.join(outDir, name));
  }
  copyFileSync(probeFile, path.join(outDir, "deck-flow-probe.json"));
  check("读取 → 认证 → 开盒推近 → 终端接管 → 收起", report.passed === true, (report.failures ?? []).join(" / "));
  // Closing the window with a live shell on the open package: the process must
  // be gone within the timeout (it once lingered for hours after LogExit).
  Object.assign(process.env, fake);
  const exit = play(["-exit-probe", "-windowed", "-ResX=1280", "-ResY=800", "-nosound"], 60000);
  for (const key of Object.keys(fake)) delete process.env[key];
  const exitFile = path.join(saved, "exit-probe.json");
  const exitReport = existsSync(exitFile) && statSync(exitFile).mtimeMs >= exit.started ? JSON.parse(readFileSync(exitFile, "utf8")) : {};
  check("带着运行中的终端关窗后进程及时退出", exit.result.status === 0 && exitReport.running === true && exitReport.terminal === true,
    `exit=${exit.result.status} running=${exitReport.running} terminal=${exitReport.terminal} ${((Date.now() - exit.started) / 1000).toFixed(1)}s`);
  validationStatus = "passed";
  checkpoint({ deck: { passed: report.passed }, note: "fake-ssh 驱动；动画观感需人工验收。" });
  process.exit(0);
}

if (homeOnly) {
  const flow = play(["-home-flow-probe", "-windowed", "-ResX=1600", "-ResY=900", "-nosound"], 120000);
  const probeFile = path.join(saved, "home-flow-probe.json");
  check("开屏后的完整主页流程生成新报告", flow.result.status === 0 && existsSync(probeFile) && statSync(probeFile).mtimeMs >= flow.started);
  const flowReport = JSON.parse(readFileSync(probeFile, "utf8"));
  check("旋转档案先保持高度对齐、再下降，镜头对齐期间保持构图", flowReport.returnAlignmentPassed === true);
  check("开屏播放、选择、详情、总览和工作台返回", flowReport.passed === true && flowReport.openingPlayed === true && flowReport.noImplicitConnection === true && flowReport.decryptionComplete === true, JSON.stringify(flowReport));
  const log = readFileSync(path.join(saved, "Logs", "RhineLabViewer.log"), "utf8");
  check("完整场景正常退出且未回退默认材质", log.includes("LogExit: Exiting.") && !/Fatal error|Assertion failed|missing usage flag|Default Material will be used/.test(log));
  for (const name of ["flow-01-home.png", "flow-02-selected.png", "flow-03-detail.png", "flow-03-scanning.png", "flow-03-configuration.png", "flow-08-dark.png", "flow-04-return.png", "flow-05-overview.png", "flow-06-workbench.png", "flow-07-restored.png", "flow-09-rotated.png", "flow-10-aligning.png", "flow-11-descending.png"]) {
    check("流程截图：" + name, Boolean(freshShot(name, flow.started)));
    copyFileSync(path.join(shots, name), path.join(outDir, name));
  }
  copyFileSync(probeFile, path.join(outDir, "home-flow-probe.json"));
  copyFileSync(path.join(saved, "Logs", "RhineLabViewer.log"), path.join(outDir, "home-flow.log"));
  validationStatus = "passed";
  checkpoint({ flow: flowReport, visualAcceptance: "pending", note: "功能探针不替代画面和真实鼠标交互验收。" });
  process.exit(0);
}

const selftest = play(["-ssh-selftest", "-windowed", "-nosound"]);
const reportPath = path.join(saved, "ssh-selftest.json");
check("the self-test wrote a report", existsSync(reportPath), reportPath);
const report = JSON.parse(readFileSync(reportPath, "utf8"));
check("the native ConPTY round-trip echoes the probe command",
  report.passed === true && report.conpty === true && report.received_bytes > 0
    && String(report.output_tail).includes("RHINE_CONPTY_OK"),
  `passed=${report.passed} rx=${report.received_bytes} tx=${report.sent_bytes}`);
check("the self-test process exits cleanly", selftest.result.status === 0, `exit=${selftest.result.status}`);

for (const [flag, name] of [["-capture-ssh", "ssh-workbench.png"], ["-capture-ssh-open", "ssh-workbench-open.png"]]) {
  const { result, started } = play(["-game", "-windowed", "-ResX=1600", "-ResY=900", flag, "-NoSplash", "-NoSound"]);
  check(`the ${flag} run exits cleanly`, result.status === 0, `exit=${result.status}`);
  const shot = freshShot(name, started);
  check(`the ${flag} run writes ${name}`, Boolean(shot), shot ? `${shot.size} bytes` : "stale or missing");
}
check("展开与合拢实际呈现不同画面", digest(path.join(shots, "ssh-workbench.png")) !== digest(path.join(shots, "ssh-workbench-open.png")));

// Playback of the baked opening: four moments that were also checked against the
// web implementation, so a render regression shows up as a stale or missing shot.
{
  const started = Date.now();
  const run = play(["-capture-boot", "-windowed", "-ResX=1600", "-ResY=900", "-nosound"], 180000);
  check("the baked opening plays through", run.result.status === 0, `exit=${run.result.status}`);
  const expected = [480, 1720, 2030, 2180];
  const shotDir = path.join(saved, "Screenshots", "Windows");
  const missing = expected.filter(time => {
    const file = path.join(shotDir, `boot-${String(time).padStart(5, "0")}.png`);
    return !existsSync(file) || statSync(file).mtimeMs < started;
  });
  check("the baked opening writes all four verification frames", missing.length === 0,
    missing.length ? `stale or missing: ${missing.join(", ")}` : "4 frames");
}
// The opening is a frame-exact choreography, so "it looks right" is not a test.
// src/boot-motion.ts stays the source of truth and the Unreal port is diffed
// against it value by value on a fixed grid.
const { bootMotion } = await import(pathToFileURL(path.join(root, "src", "boot-motion.ts")).href);
const probeRun = play(["-boot-motion-probe", "-nosound"]);
check("the boot timeline probe exits cleanly", probeRun.result.status === 0, `exit=${probeRun.result.status}`);
const probePath = path.join(saved, "boot-motion-probe.json");
check("the boot timeline probe wrote its samples", existsSync(probePath), probePath);
const probe = JSON.parse(readFileSync(probePath, "utf8"));

function bootReference(appTime) {
  const s = bootMotion(appTime);
  return {
    t: appTime, frame: s.f, step: s.step, access: s.access, auth: s.auth, logoLetters: s.logoLetters,
    accessOpacity: s.accessOpacity, logoOpacity: s.logoOpacity,
    logoOffsetX: s.logo.offsetX, logoStart: s.logo.start, logoLength: s.logo.length,
    logoStrokeWidth: s.logo.strokeWidth, logoSymbolScale: s.logo.symbolScale, logoPlusX: s.logo.plusX,
    logoMinusX: s.logo.minusX, logoMinusWidth: s.logo.minusWidth, logoPlusAngle: s.logo.plusAngle,
    authOpacity: s.authOpacity,
    brand0x: s.brand[0].x, brand0o: s.brand[0].opacity,
    brand1x: s.brand[1].x, brand1o: s.brand[1].opacity,
    brand2x: s.brand[2].x, brand2o: s.brand[2].opacity,
    poweredLetters: s.poweredLetters,
    scanRadius: s.scan.radius, scanWhiteRadius: s.scan.whiteRadius,
    scanOuterStart: s.scan.outerStart, scanOuterSweep: s.scan.outerSweep,
    scanWhiteStart: s.scan.whiteStart, scanWhiteSweep: s.scan.whiteSweep,
    scanInnerRadius: s.scan.innerRadius, scanInnerStart: s.scan.innerStart, scanInnerSweep: s.scan.innerSweep,
    scanOrbit: s.scan.orbit, scanOrbitRadius: s.scan.orbitRadius, scanDotRadius: s.scan.dotRadius,
    scanBlackCap: s.scan.blackCap, scanWhiteCap: s.scan.whiteCap,
    ringScale: s.ringScale, ringOpacity: s.ringOpacity, ringBlur: s.ringBlur,
    scanTracking: s.scanTracking, permissionOpacity: s.permissionOpacity,
    orbitLeftX: s.scanOrbit.sides[0].x, orbitLeftY: s.scanOrbit.sides[0].y,
    orbitRightX: s.scanOrbit.sides[1].x, orbitRightY: s.scanOrbit.sides[1].y,
    orbitSideRadius: s.scanOrbit.sides[0].radius,
    orbitLeftStart: s.scanOrbit.sides[0].start, orbitRightStart: s.scanOrbit.sides[1].start,
    orbitLeftSweep: s.scanOrbit.sides[0].sweep, orbitRightSweep: s.scanOrbit.sides[1].sweep,
    orbitCoreRadius: s.scanOrbit.coreRadius,
    satellite0x: s.scanOrbit.satellites[0].x, satellite0y: s.scanOrbit.satellites[0].y, satellite0r: s.scanOrbit.satellites[0].radius,
    satellite3x: s.scanOrbit.satellites[3].x, satellite3y: s.scanOrbit.satellites[3].y, satellite3r: s.scanOrbit.satellites[3].radius,
    satellite5r: s.scanOrbit.satellites[5].radius,
    highlight: s.highlight, welcomePanel: s.welcomePanel, welcomeInk: s.welcomeInk,
    welcomeScale: s.welcomeScale, welcomeOpacity: s.welcomeOpacity, exitBlur: s.exitBlur,
    white: s.white, backgroundOpacity: s.backgroundOpacity,
  };
}

let worst = { key: "", delta: 0, at: 0 };
const drifted = new Map();
for (const sample of probe.samples) {
  const want = bootReference(sample.t);
  for (const [key, value] of Object.entries(want)) {
    const got = sample[key];
    if (typeof value === "number") {
      const delta = Math.abs(got - value);
      if (delta > worst.delta) worst = { key, delta, at: sample.t };
      if (delta > 1e-8 + 1e-11 * Math.abs(value)) drifted.set(key, (drifted.get(key) ?? 0) + 1);
    } else if (String(got) !== String(value)) {
      drifted.set(key, (drifted.get(key) ?? 0) + 1);
    }
  }
}
check(`the opening timeline matches src/boot-motion.ts (${probe.samples.length} samples, ${Object.keys(bootReference(0)).length} values each)`,
  drifted.size === 0, drifted.size === 0 ? `worst ${worst.key} ${worst.delta.toExponential(2)} @${worst.at}s`
    : [...drifted].slice(0, 6).map(([key, count]) => `${key} x${count}`).join(", "));
// Validate the same web pose function used by terminal-deck.ts, including rotations.
const deckRun = play(["-deck-motion-probe", "-windowed", "-ResX=1600", "-ResY=900", "-nosound"]);
const deckPath = path.join(saved, "deck-motion-probe.json");
check("deck probe exits and produces fresh samples", deckRun.result.status === 0 && existsSync(deckPath) && statSync(deckPath).mtimeMs >= deckRun.started);
const deck = JSON.parse(readFileSync(deckPath, "utf8"));
const { deckPose, deckBacklight } = await import(pathToFileURL(path.join(root,"src/ssh/deck-motion.ts")).href);
const { Quaternion, Euler } = await import("three");
let deckError = 0;
for (const sample of deck.samples) {
  const reference = deckPose(sample.opening ** 2);
  deckError = Math.max(deckError, Math.abs(sample.backlight - deckBacklight(sample.phase,sample.reduced,1.37)));
  for (const [i,id] of ["cover","fasteners","carrier","substrate"].entries()) {
    const {position:p,rotation:r} = reference.parts[id];
    const q = new Quaternion().setFromEuler(new Euler(r.x,r.y,r.z,"XYZ"));
    const expected = [p.x*100,p.z*100,p.y*100,-q.x,-q.z,-q.y,q.w];
    const actual = [...sample.parts[i].position,...sample.parts[i].quaternion];
    for(let j=0;j<expected.length;j++) {
      if(!Number.isFinite(actual[j])) throw new Error("non-finite deck sample");
      deckError = Math.max(deckError,Math.abs(actual[j]-expected[j]));
    }
  }
}
check("deck pose and phase backlight match the web",deck.samples.length===198 && deckError<1e-8, String(deckError));
const cover=deck.meshes.find(m=>m.name==="Shell_cover__Frosted_Polymer_012");
check("shell import uses centimetres without double scaling",cover && Math.abs(cover.max[0]-250)<1 && Math.abs(cover.max[2]-370)<1);
check("all deck groups and emissive parameters are present",deck.meshes.length===61 && deck.glowCount>0 && deck.glowParameterValid);
const opened=deck.runtime[0],closed=deck.runtime[1];
check("runtime opens, closes and keeps the screen fixed",opened.opening===1 && closed.opening===0 && Math.abs(opened.cover[0]+310)<1e-6 && closed.cover[0]===0 && [...opened.insert,...closed.insert].every(n=>n===0));
const span=Math.max(242/(.84*.975),436/((1600/900)*.76*.985));
check("operating camera aims at the screen", Math.abs(opened.aim[1]-13.9)<.1 && Math.abs(opened.aim[2]-(156.5+span*.06))<.1);
copyFileSync(deckPath,path.join(outDir,"deck-motion-probe.json"));
const terminalRun = play(["-terminal-ui-probe", "-windowed", "-ResX=1600", "-ResY=900", "-nosound"]);
const terminalPath=path.join(saved,"terminal-ui-probe.json");
check("终端界面探针生成新报告", terminalRun.result.status===0 && existsSync(terminalPath) && statSync(terminalPath).mtimeMs>=terminalRun.started);
const terminalReport=JSON.parse(readFileSync(terminalPath,"utf8"));
for(const key of ["search","fontLimits","input","projection","retained","inputMethod","selectionSurvivesCtrl"]) check("终端验证："+key,terminalReport[key]===true);
const screenCapture=play(["-capture-terminal-screen","-windowed","-ResX=1600","-ResY=900","-nosound"]);
check("屏面投影截图生成",screenCapture.result.status===0 && Boolean(freshShot("terminal-screen.png",screenCapture.started)));
copyFileSync(terminalPath,path.join(outDir,"terminal-ui-probe.json"));
await sshSessionChecks();
copyFileSync(path.join(shots,"terminal-screen.png"),path.join(outDir,"terminal-screen.png"));
// Host groups (overview chips, filter, archive columns) and the host editor in
// 02 连接配置; both restore the files they touch. Desktop layout, CSS 1707x1067.
for (const [probe, label, captures] of [
  ["group-probe", "主机分组：新建、重命名、筛选、分列与持久化", ["group-01-sections.png", "group-02-filter.png", "group-03-ungrouped.png", "group-04-column.png"]],
  ["config-probe", "连接配置编辑器：校验、连接选项、持久化、跟随选中、移除主机", ["config-01-editor.png"]],
  // RhineTheme.h: every theme's change-over, turn-over and settled state.
  ["theme-probe", "六套主题：场景内过渡、逐卡翻面、界面与场景落定", ["paper", "night", "hazard", "clinic", "orbit", "print"]
    .flatMap((id, i) => ["a-start", "b-blend", "c-wave", "d-settled"].map(step => `theme-${i}-${id}-${step}.png`))],
]) {
  const run = play([`-${probe}`, "-windowed", "-ResX=1707", "-ResY=1067", "-dpr=1", "-nosound"]);
  const reportFile = path.join(saved, `${probe}.json`);
  check(`${probe} 生成新报告`, existsSync(reportFile) && statSync(reportFile).mtimeMs >= run.started);
  const result = JSON.parse(readFileSync(reportFile, "utf8"));
  check(label, result.passed === true, (result.failures ?? []).join(" / "));
  for (const name of captures) if (freshShot(name, run.started)) copyFileSync(path.join(shots, name), path.join(outDir, name));
}
// A resting home must not run at the interactive cap (RhineFrameBudget.cpp):
// 30 fps in front, 15 behind another window; the footer clock's 0.46 s roll
// each second runs at 60 so it stays smooth, averaging about 44.
{
  const run = play(["-perf-probe", "-frame-budget", "-windowed", "-ResX=1707", "-ResY=1067", "-dpr=1", "-nosound"]);
  const reportFile = path.join(saved, "perf-probe.json");
  const perf = existsSync(reportFile) && statSync(reportFile).mtimeMs >= run.started ? JSON.parse(readFileSync(reportFile, "utf8")) : {};
  check("静止的主页降帧（不再固定 120 fps；读秒滚动时 60）", perf.fps > 0 && perf.fps <= 48,
    `fps=${perf.fps?.toFixed(1)} game=${perf.gameMs?.toFixed(2)}ms render=${perf.renderMs?.toFixed(2)}ms gpu=${perf.gpuMs?.toFixed(2)}ms`);
}
for (const [flag,name] of [["-capture-home","home-archive.png"],["-capture-overview","home-overview.png"]]) {
  const capture=play([flag,"-windowed","-ResX=1920","-ResY=1080","-nosound"]);
  check("主界面截图："+name,capture.result.status===0 && Boolean(freshShot(name,capture.started)));
  copyFileSync(path.join(shots,name),path.join(outDir,name));
}
// --no-perf skips the 2560x1440 playback probes (they take over the screen).
if (!process.argv.includes("--no-perf")) {
const performanceRun=play(["-boot-performance-probe","-windowed","-ResX=2560","-ResY=1440","-nosound"],60000);
const performancePath=path.join(saved,"boot-performance.json");
check("启动视频性能探针生成新报告",performanceRun.result.status===0 && existsSync(performancePath) && statSync(performancePath).mtimeMs>=performanceRun.started);
const performance=JSON.parse(readFileSync(performancePath,"utf8"));
const expectedSamples=Math.max(1,(performance.videoPosition-1)*performance.sourceFps);
check("4K60 启动视频的不同采样覆盖率至少 98%",performance.sourceFps===60 && performance.distinctVideoSamples/expectedSamples>=.98,JSON.stringify(performance));
copyFileSync(performancePath,path.join(outDir,"boot-performance-4k60.json"));
const smoothRun=play(["-boot-quality=smooth","-boot-performance-probe","-windowed","-ResX=2560","-ResY=1440","-nosound"],60000);
check("1440p120 流畅模式性能探针生成报告",smoothRun.result.status===0 && existsSync(performancePath) && statSync(performancePath).mtimeMs>=smoothRun.started);
const smooth=JSON.parse(readFileSync(performancePath,"utf8"));
const smoothExpected=Math.max(1,(smooth.videoPosition-1)*smooth.sourceFps);
check("1440p120 流畅模式实际采样覆盖率至少 98%",smooth.sourceFps>=119 && smooth.distinctVideoSamples/smoothExpected>=.98,JSON.stringify(smooth));
copyFileSync(performancePath,path.join(outDir,"boot-performance-1440p120.json"));
}
const artifacts = [
  ["Screenshots/Windows/ssh-workbench.png", "workbench-closed.png"],
  ["Screenshots/Windows/ssh-workbench-open.png", "workbench-open.png"],
  ["ssh-selftest.json", "selftest.json"],
  ["Logs/RhineLabViewer.log", "workbench-run.log"],
  ["boot-motion-probe.json", "boot-motion-probe.json"],
  ["Screenshots/Windows/boot-00280.png", "boot-0280.png"],
];
for (const [from, to] of artifacts) {
  const source = path.join(saved, from);
  if (existsSync(source)) copyFileSync(source, path.join(outDir, to));
}

validationStatus = "passed";
checkpoint({ selftest: report });

console.log(`\n${checks.length} checks passed. Report: ${path.relative(root, outDir)}`);
