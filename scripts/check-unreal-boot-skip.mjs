import { spawnSync } from 'node:child_process';
import { readFileSync, copyFileSync, statSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const root=resolve(import.meta.dirname,'..');
const staged=resolve(root,process.env.RHINE_UNREAL_STAGE ?? 'release/RhineLab-Unreal/Windows/RhineLabViewer');
const exe=resolve(staged,'Binaries/Win64/RhineLabViewer.exe');
for(const mode of ['video','frames']) {
  const started=Date.now();
  const extra=mode==='frames' ? ",'-boot-frames-only'" : '';
  const command=`$p=Start-Process -FilePath '${exe.replaceAll("'","''")}' -ArgumentList '-boot-skip-probe','-windowed','-ResX=1600','-ResY=900','-nosound'${extra} -WindowStyle Hidden -PassThru; $p.WaitForExit(); exit $p.ExitCode`;
  const result=spawnSync('powershell.exe',['-NoProfile','-Command',command],{encoding:'utf8',timeout:90000});
  assert.equal(result.status,0,result.stderr);
  const source=resolve(staged,'Saved/boot-skip-probe.json');
  assert.ok(statSync(source).mtimeMs>=started,'fresh probe');
  const report=JSON.parse(readFileSync(source,'utf8'));
  assert.equal(report.passed,true,JSON.stringify(report));
  assert.equal(report[mode],true,`exercise ${mode} playback`);
  const out=resolve(root,'verification/unreal-boot-button',mode);
  mkdirSync(out,{recursive:true});
  copyFileSync(source,resolve(out,'report.json'));
  for(const name of ['boot-enter-button','boot-enter-result']) {
    const image=resolve(staged,`Saved/Screenshots/Windows/${name}.png`);
    assert.ok(statSync(image).mtimeMs>=started);
    copyFileSync(image,resolve(out,`${name}.png`));
  }
  console.log(`PASS ${mode}: Slate button activation skips opening, stops playback, restores world, hides button; no SSH connection`);
}
