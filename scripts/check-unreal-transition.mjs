import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, mkdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

// Build first with UE Build.bat; run the freshly built executable against the
// packaged content. Fixed timestep verifies timing, not achievable frame rate.
const root = resolve(import.meta.dirname, '..');
const staged = resolve(root, process.env.RHINE_UNREAL_STAGE ?? 'release/RhineLab-Unreal/Windows/RhineLabViewer');
const exe = resolve(staged, 'Binaries/Win64/RhineLabViewer.exe');
copyFileSync(resolve(root, 'prototypes/unreal/Binaries/Win64/RhineLabViewer.exe'), exe);
const reports=[];
for (const fps of [60,120]) {
  const started=Date.now();
  const result=spawnSync('powershell.exe', ['-NoProfile','-Command',
    ` $p=Start-Process -FilePath '${exe.replaceAll("'","''")}' -ArgumentList '-transition-probe','-windowed','-ResX=1600','-ResY=900','-nosound','-benchmark','-fps=${fps}' -WindowStyle Hidden -PassThru; $p.WaitForExit(); exit $p.ExitCode`],
    {encoding:'utf8',timeout:180000});
  assert.equal(result.status,0,result.stderr);
  const file=resolve(staged,'Saved/transition-probe.json');
  assert.ok(statSync(file).mtimeMs>=started,'fresh probe report');
  const report=JSON.parse(readFileSync(file,'utf8'));
  const out=resolve(root,`verification/unreal-transition/${fps}`);
  mkdirSync(out,{recursive:true});
  copyFileSync(file,resolve(out,'report.json'));
  assert.equal(report.passed,true,`reversal / interruption / skip / reduced-motion at ${fps} Hz`);
  assert.equal(report.noImplicitConnection,true);
  const log=readFileSync(resolve(staged,'Saved/Logs/RhineLabViewer.log'),'utf8');
  assert.ok(log.includes('LogExit: Exiting.') && !/Fatal error|Assertion failed|Ensure condition failed/.test(log),'clean shutdown');
  for (const name of ['enter','reverse','workbench','restored']) {
    const shot=resolve(staged,`Saved/Screenshots/Windows/transition-${name}.png`);
    assert.ok(statSync(shot).mtimeMs>=started);
    copyFileSync(shot,resolve(out,`${name}.png`));
  }
  reports.push(report);
  console.log(`PASS ${fps} Hz: ${report.samples.length} timeline samples; reverse, repeated toggle, skip, reduced motion; no SSH connection`);
}
// Before the first interruption, both runs must reach the same curve values
// within one 60 Hz evaluation step (the UMG evaluation precedes the next pawn tick).
for (const elapsed of [.10,.15,.20]) {
  const values=reports.map(r=>{
    const start=r.samples.find(x=>x.target).time;
    return r.samples.reduce((a,b)=>Math.abs(b.time-start-elapsed)<Math.abs(a.time-start-elapsed)?b:a).blend;
  });
  assert.ok(Math.abs(values[0]-values[1])<.07,`time consistency at ${elapsed}: ${values}`);
}
console.log('PASS 60/120 Hz time consistency (fixed timestep; not a performance benchmark)');
