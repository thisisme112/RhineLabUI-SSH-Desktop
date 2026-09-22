import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const out = path.resolve('verification/redesign'); await mkdir(out,{recursive:true});
const profile = await mkdtemp(path.join(os.tmpdir(),'rhine-inspection-perf-'));
const vite = spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','5197','--strictPort','--mode','desktop'],{stdio:'ignore',windowsHide:true});
let browser, ws;
try {
  for(let i=0;i<50;i++){try{if((await fetch('http://127.0.0.1:5197/scripts/fixtures/inspection-benchmark.html')).ok)break;}catch{} await sleep(200);}
  browser = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',['--headless=new','--disable-extensions','--no-first-run','--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding','--remote-debugging-port=9597',`--user-data-dir=${profile}`,'--window-size=1920,1080','about:blank'],{stdio:'ignore',windowsHide:true});
  let target;
  for(let i=0;i<50&&!target;i++){try{target=(await(await fetch('http://127.0.0.1:9597/json/list')).json()).find(t=>t.type==='page');}catch{} await sleep(200);}
  if(!target)throw Error('Browser unavailable');
  ws=new WebSocket(target.webSocketDebuggerUrl); await new Promise(resolve=>ws.onopen=resolve);
  let id=0;const pending=new Map();
  ws.onmessage=event=>{const message=JSON.parse(event.data);if(message.id){pending.get(message.id)?.(message);pending.delete(message.id);}};
  const send=(method,params={})=>new Promise((resolve,reject)=>{const next=++id;const timer=setTimeout(()=>reject(Error(method+' timeout')),60000);pending.set(next,msg=>{clearTimeout(timer);msg.error?reject(Error(msg.error.message)):resolve(msg.result);});ws.send(JSON.stringify({id:next,method,params}));});
  const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description);return r.result.value;};
  await send('Page.navigate',{url:'http://127.0.0.1:5197/scripts/fixtures/inspection-benchmark.html'});
  let ready=false;for(let i=0;i<120;i++){if(await evaluate('!!window.benchmark')){ready=true;break;}await sleep(250);}if(!ready)throw Error('Benchmark did not initialize');
  const results=[];
  for(const kind of ['archive','terminal','archive','terminal']) { console.log('Measuring '+kind); results.push(await evaluate(`benchmark.run('${kind}')`)); }
  const average=kind=>results.filter(r=>r.kind===kind).reduce((sum,r)=>sum+r.p95,0)/2;
  const ratio=average('terminal')/average('archive');
  const report={viewport:'1920x1080',quality:'same default viewer quality',results,ratio,passed:ratio<=1.2};
  await writeFile(path.join(out,'performance.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
  await evaluate('benchmark.dispose()');if(!report.passed)process.exitCode=1;
} finally {ws?.close();browser?.kill();vite.kill();}
