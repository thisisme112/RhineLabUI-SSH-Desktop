/** Same machine / full-quality measurements. No synthetic lowering of quality. */
export async function checkOverviewPerformance({
  evaluate,
  until,
  check,
  shot,
  send,
  sleep,
  evidence,
}) {
  const phases = [];
  try {
    evidence.gpu = await send("SystemInfo.getInfo");
  } catch {
    /* Page-scoped CDP may not provide system info. */
  }
  for (const count of [32, 256]) {
    await evaluate(`(async () => {
      const hosts = Array.from({ length: ${count} }, (_, index) => ({ alias: 'perf-' + index,
        displayName: '计算节点 ' + String(index + 1).padStart(3, '0'), hostname: '192.0.2.' + (index % 254 + 1),
        user: 'operator', port: '22', source: 'config', raw: 'Isolated performance fixture' }));
      rhineDesktop.hosts = async () => ({ ok:true, hosts, configPath:'fixture', revision:'performance' });
      await rhineSshUi.reloadHosts(); rhine.archive();
      window.__perfCards = hosts.map(host => rhineSshUi.cardOf(host.alias));
    })()`);
    await until(
      "performance catalog",
      `rhineSshUi.boundHosts.length === ${count} && document.querySelectorAll('.ssh-overview-host').length === ${count}`,
    );
    await sleep(5500);
    for (const kind of ["idle", "wheel", "jump", "preview"]) {
      const phase = await evaluate(`new Promise(resolve => {
        const kind = ${JSON.stringify(kind)}, intervals = [], counts = [], tasks = [];
        const observer = new PerformanceObserver(list => tasks.push(...list.getEntries().map(entry => ({ start:entry.startTime, duration:entry.duration }))));
        observer.observe({type:'longtask'});
        let last = performance.now(), started = last, previousCount = last, actionAt = last, actions = 0;
        function frame(now) {
          intervals.push(now-last); last=now;
          if (kind !== 'idle' && now-actionAt >= (kind === 'wheel' ? 80 : 250)) {
            actionAt=now; actions++;
            if (kind === 'wheel') document.querySelector('#three-scene canvas').dispatchEvent(new WheelEvent('wheel',{deltaY:300,bubbles:true,cancelable:true}));
            else if (kind === 'jump') rhine.select(__perfCards[actions % 2 ? __perfCards.length-1 : 0]);
            else {
              const row = document.querySelector('.ssh-overview-host[data-host-alias="perf-' + (actions % 2 ? __perfCards.length-1 : 0) + '"]');
              row.dispatchEvent(new PointerEvent('pointerover',{bubbles:true}));
            }
          }
          if (now-previousCount > 250) {
            previousCount=now; const stats=rhine.stats();
            counts.push({at:now-started, returning:stats.returningFiles, candidates:stats.archiveCandidates, drawn:stats.archiveCount, calls:stats.drawCalls});
          }
          if (now-started < 4000) { requestAnimationFrame(frame); return; }
          observer.disconnect(); intervals.sort((a,b)=>a-b);
          const q=value=>intervals[Math.floor((intervals.length-1)*value)];
          resolve({hosts:${count}, kind, ms:now-started, frames:intervals.length, p50:q(.5),p95:q(.95),p99:q(.99),max:intervals.at(-1),framesOver50:intervals.filter(value=>value>50).length,longTasks:tasks, actions,counts,heap:performance.memory?.usedJSHeapSize});
        }
        requestAnimationFrame(frame);
      })`);
      phases.push(phase);
      console.log(
        `PERF ${count} ${kind} p95=${phase.p95.toFixed(1)}ms calls=${Math.max(...phase.counts.map((item) => item.calls))} returns=${Math.max(...phase.counts.map((item) => item.returning))}`,
      );
      await sleep(3200);
    }
  }
  await shot("performance-256-hosts");
  evidence.overviewPerformance = {
    viewport: "1920x1080 DPR1",
    quality: "original default, no effects disabled",
    phases,
  };
  await check(
    "settled motion releases outgoing models",
    `rhine.stats().returningFiles === 0`,
  );
  await check(
    "performance fixture never starts SSH",
    `rhineSshUi.sessions.length === 0`,
  );
  await evaluate(
    `rhine.select(__perfCards[0]); document.querySelector('.ssh-overview-host-list').dispatchEvent(new PointerEvent('pointerleave'))`,
  );
  await sleep(1600);
  await evaluate(`window.__previewSelections=[];window.__previewCheck=setInterval(()=>__previewSelections.push(rhine.stats().selectedIndex),16);
    document.querySelector('.ssh-overview-host[data-host-alias="perf-255"]').dispatchEvent(new PointerEvent('pointerover',{bubbles:true}))`);
  await sleep(260);
  await evaluate(
    `document.querySelector('.ssh-overview-host[data-host-alias="perf-0"]').dispatchEvent(new PointerEvent('pointerover',{bubbles:true}))`,
  );
  await sleep(1300);
  await evaluate(`clearInterval(__previewCheck)`);
  await check(
    "returning hover to the starting host interrupts the old preview without intermediate selections",
    `__previewSelections.length>10 && __previewSelections.every(index=>index===__perfCards[0]) && rhine.stats().selectedIndex===__perfCards[0] && rhineSshUi.sessions.length===0`,
  );
}
