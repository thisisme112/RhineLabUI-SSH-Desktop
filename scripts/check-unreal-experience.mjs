/** Native arrival, bounded inspection, decryption and spatial page capture. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stage=path.join(root,'release/RhineLab-Unreal-DLSS5/Windows/RhineLabViewer');
const exe=path.join(stage,'Binaries/Win64/RhineLabViewer.exe');
const compact=process.argv.includes('--compact');
const width=compact ? 1280 : 1707, height=compact ? 800 : 1067;
const out=path.join(root,'verification/unreal-experience',`${width}x${height}`);
mkdirSync(out,{recursive:true});
copyFileSync(path.join(root,'prototypes/unreal/Binaries/Win64/RhineLabViewer.exe'),exe);
const started=Date.now();
const run=spawnSync(exe,['-experience-probe','-windowed',`-ResX=${width}`,`-ResY=${height}`,'-dpr=1','-nosound','-NoSplash'],{cwd:path.dirname(exe),windowsHide:true,encoding:'utf8',timeout:90000});
assert.equal(run.status,0,run.stderr || String(run.error));
const file=path.join(stage,'Saved/experience-probe.json');
assert.ok(existsSync(file) && statSync(file).mtimeMs>=started,'fresh report');
const report=JSON.parse(readFileSync(file,'utf8'));
const shots=path.join(stage,'Saved/Screenshots/Windows');
for(const name of readdirSync(shots).filter(n=>n.startsWith('experience-') && n.endsWith('.png'))) {
  assert.ok(statSync(path.join(shots,name)).mtimeMs>=started,`fresh ${name}`);
  copyFileSync(path.join(shots,name),path.join(out,name));
}
writeFileSync(path.join(out,'report.json'),JSON.stringify({...report,generated:new Date().toISOString(),width,height},null,2)+'\n');
assert.equal(report.passed,true,(report.failures || []).join('\n'));
console.log(`PASS experience ${width}x${height}: arrival, three pages, yaw ±28°, pitch locked, speed ≤24°/s. ${out}`);
