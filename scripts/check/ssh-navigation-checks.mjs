/** Actual pointer / keyboard navigation over Three.js and xterm; SSH is a local fixture. */
export async function checkSshNavigation({ evaluate, until, check, shot, key, send, sleep, evidence }) {
  const visible = selector => `(() => { const n=document.querySelector(${JSON.stringify(selector)}); if (!n || n.closest('[hidden],[inert]')) return false; const s=getComputedStyle(n),r=n.getBoundingClientRect(); return s.visibility==='visible' && Number(s.opacity)>.95 && r.width>0 && r.height>0; })()`;
  const hit = async selector => {
    let previous, point;
    for (let attempt=0; attempt<25; attempt++) {
      point = await evaluate(`(() => {const n=document.querySelector(${JSON.stringify(selector)}); if(!n) return null; const r=n.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2,hit:!n.closest('[hidden],[inert]')&&n.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))};})()`);
      if (point?.hit && previous?.hit && Math.hypot(point.x-previous.x,point.y-previous.y)<.5) { await clickPoint(point); return; }
      previous = point;
      await sleep(60);
    }
    throw new Error(`Covered or missing control: ${selector} ${JSON.stringify(point)}`);
  };
  const mouse = (type, point, buttons = 0) => send("Input.dispatchMouseEvent", {
    type, x: point.x, y: point.y, button: type === "mouseMoved" && !buttons ? "none" : "left", buttons,
    ...(type !== "mouseMoved" ? { clickCount: 1 } : {}),
  });
  const clickPoint = async point => {
    await mouse("mouseMoved", point);
    await mouse("mousePressed", point, 1);
    await mouse("mouseReleased", point);
  };
  const modelPoint = async () => {
    const points = await evaluate(`(() => {
      const s=rhine.stats(), c=document.querySelector('#three-scene canvas'),r=c.getBoundingClientRect(),sx=r.width/c.clientWidth,sy=r.height/c.clientHeight;
      if(s.mode==='detail') { const p=s.sessionDeck.screen.corners; return [{x:r.left+p.reduce((n,v)=>n+v[0],0)/4*sx,y:r.top+p.reduce((n,v)=>n+v[1],0)/4*sy}]; }
      return [.2,.35,.5,.65,.8].flatMap(t=>[34,24,14].map(d=>({x:r.left+(s.topLeft[0]+(s.topRight[0]-s.topLeft[0])*t)*sx,y:r.top+(s.topLeft[1]+(s.topRight[1]-s.topLeft[1])*t+d)*sy})));
    })()`);
    if (await evaluate(`rhine.stats().mode==='detail'`)) return points[0];
    for (const point of points) {
      if (point.x < 4 || point.y < 4) continue;
      await mouse("mouseMoved", point);
      if (await evaluate(`(() => {const s=rhine.stats();return s.hoverCell?.lane===s.selectedCell.lane && s.hoverCell?.row===s.selectedCell.row;})()`)) return point;
    }
    await shot("model-hit-failure");
    throw new Error("Selected model has no reachable face at its projected coordinates");
  };
  const settledArchive = () => until("archive usable", `rhine.stats().mode==='archive' && rhine.stats().cameraDetail<.005 && rhine.stats().sessionDeck.progress===0 && !rhine.stats().holdingArchive && !rhine.stats().archiveMomentum && !document.querySelector('#archive-ui').inert && Math.abs(rhine.stats().extraction-.4)<.015`);
  const settledDetail = () => until("host details usable", `rhine.stats().mode==='detail' && !rhineSshUi.isOpen && rhine.stats().sessionDeck.progress===0 && rhine.stats().cameraDetail>.98 && ${visible('#detail-content')}`);
  const terminalReady = () => until("terminal usable", `rhineSshUi.isOpen && rhineSshUi.hasFocus && rhine.stats().sessionDeck.ready && document.querySelector('.ssh-terminal:not([hidden])').dataset.transition==='open'`);
  const returnToArray = async () => { await hit('.back-button'); await settledArchive(); };

  await until("overview ready", `document.querySelectorAll('.ssh-overview-host').length===8 && document.querySelector('.ssh-overview').dataset.transition==='open'`);
  await check("expanded overview keeps background controls out of keyboard focus", `document.querySelector('#archive-ui').inert && document.querySelector('.ssh-overview-restore').inert`);
  await hit('[data-host-alias="review-host"] [data-overview-action="inspect"]');
  await settledDetail();
  await check("overview has a direct host-detail route without connecting", `rhineSshUi.sessions.length===0 && document.querySelector('#detail-content').textContent.includes('review-host') && document.querySelector('#host-connect').dataset.action==='ssh-connect'`);
  await shot("01-host-details");
  await hit('.back-button');
  await until("overview returns", `document.querySelector('.ssh-overview').dataset.transition==='open' && !document.querySelector('.ssh-overview').inert`);
  await hit('.ssh-overview-heading-actions [data-overview-action="collapse"]');
  await settledArchive();
  await until("archive labels appear", visible('.file-summary'));
  await check("collapsing restores description, read button and both navigation axes", `${visible('.read-file')} && ${visible('.file-title')} && ${visible('.archive-navigation')} && ${visible('.column-navigation')} && ${visible('.system-nav')} && document.querySelector('#selected-title').textContent.includes('review-host')`);
  await check("collapsed sheet cannot trap Tab in invisible fields", `document.querySelector('.ssh-overview-glass').inert && !document.querySelector('.ssh-overview-restore').inert && document.activeElement===document.querySelector('.ssh-overview-restore')`);
  await shot("02-collapsed-archive");

  const beforeWheel = await evaluate(`rhine.stats().selectedIndex`);
  const pointBeforeWheel = await modelPoint();
  await send("Input.dispatchMouseEvent", { type: "mouseWheel", ...pointBeforeWheel, deltaX: 0, deltaY: 120 });
  await until("wheel selects another host", `rhine.stats().selectedIndex!==${beforeWheel}`);
  await sleep(1000);
  const selectedByWheel = await evaluate(`rhine.stats().selectedIndex`);
  await clickPoint(await modelPoint());
  await settledDetail();
  await check("a real click opens the model selected by the wheel", `rhine.stats().selectedIndex===${selectedByWheel} && rhineSshUi.sessions.length===0`);
  await returnToArray();

  const beginPull = async () => {
    const point = await modelPoint();
    const baseline = await evaluate(`(() => {const s=rhine.stats(), c=document.querySelector('#three-scene canvas'),r=c.getBoundingClientRect(); return {position:s.modelPosition,cell:s.selectedCell,up:{x:(s.labelTopLeft[0]-s.labelBottomLeft[0])/.46*r.width/c.clientWidth,y:(s.labelTopLeft[1]-s.labelBottomLeft[1])/.46*r.height/c.clientHeight}};})()`);
    const readPull = () => evaluate(`(() => {const s=rhine.stats();return {pull:s.archivePull,holding:s.holdingArchive,drag:s.dragTrack,detail:s.cameraDetail,extraction:s.extraction,position:s.modelPosition,hover:s.hoverCell,cell:s.selectedCell,inert:document.querySelector('#three-scene').inert};})()`);
    await mouse("mousePressed", point, 1);
    (evidence.pullStarts ??= []).push({point,baseline,state:await readPull()});
    const move = async lift => {
      const destination = { x: point.x + baseline.up.x * lift, y: point.y + baseline.up.y * lift };
      (evidence.pullMoves ??= []).push({point, lift, destination});
      await mouse("mouseMoved", destination, 1);
      await sleep(80);
      evidence.pullMoves.at(-1).state = await readPull();
      return destination;
    };
    return { point, baseline, move };
  };
  let pull = await beginPull();
  let release = await pull.move(.55);
  await check("holding a selected model raises only that file", `rhine.stats().archivePull.active && rhine.stats().mode==='archive' && rhine.stats().extraction>.7 && rhine.stats().cameraDetail<.01 && Math.abs(rhine.stats().modelPosition[0]-(${pull.baseline.position[0]}))<.02 && Math.abs(rhine.stats().modelPosition[2]-(${pull.baseline.position[2]}))<.02`);
  await mouse("mouseReleased", release);
  await settledArchive();
  await check("a short pull returns to the array without opening", `rhine.stats().mode==='archive' && !rhine.stats().archivePull.active && rhineSshUi.sessions.length===0`);
  pull = await beginPull();
  release = await pull.move(1.6);
  await until("pull reaches opening threshold", `rhine.stats().archivePull.ready`, 5000);
  await shot("03-manual-extraction");
  release = await pull.move(.2);
  await mouse("mouseReleased", release);
  await settledArchive();
  await check("pulling back before release cancels a previously crossed threshold", `rhine.stats().mode==='archive' && rhineSshUi.sessions.length===0`);
  pull = await beginPull();
  release = await pull.move(1.6);
  await mouse("mouseReleased", release);
  await settledDetail();
  await check("a committed manual extraction opens host details", `rhine.stats().selectedIndex===${selectedByWheel} && rhineSshUi.sessions.length===0 && Math.abs(rhine.stats().extraction-4.05)<.05`);
  await returnToArray();

  // Dragging elsewhere still follows both camera tracks and can turn mid-gesture.
  await mouse("mousePressed", {x:1450,y:300}, 1);
  await mouse("mouseMoved", {x:1350,y:320}, 1);
  await sleep(40);
  await mouse("mouseMoved", {x:1360,y:240}, 1);
  await check("free plane drags can turn without extracting a model", `rhine.stats().dragMapping==='free' && !!rhine.stats().dragTrack && !rhine.stats().archivePull.active && rhine.stats().mode==='archive'`);
  await mouse("mouseReleased", {x:1360,y:240});
  await settledArchive();

  // Native touch cancellation must never be interpreted as releasing to open.
  await evaluate(`rhine.select(rhineSshUi.cardOf('review-host'));`);
  await settledArchive();
  await send("Emulation.setTouchEmulationEnabled", {enabled:true,maxTouchPoints:2});
  await sleep(150);
  await settledArchive();
  const touchPoint = await modelPoint();
  const touch = (type, point) => send("Input.dispatchTouchEvent", {type,touchPoints:point?[{...point,id:1,radiusX:1,radiusY:1}]:[]});
  await touch("touchStart", touchPoint);
  await touch("touchMove", {x:touchPoint.x,y:touchPoint.y-210});
  await until("touch pulls selected model", `rhine.stats().archivePull.active`, 5000);
  await touch("touchCancel");
  await settledArchive();
  await check("touch cancellation returns the model without opening or changing selection", `rhine.stats().selectedIndex===rhineSshUi.cardOf('review-host') && rhine.stats().mode==='archive' && !rhine.stats().archivePull.active`);
  const touchOpen = await modelPoint();
  await touch("touchStart", touchOpen);
  await touch("touchMove", {x:touchOpen.x,y:touchOpen.y-210});
  await until("touch pull reaches threshold", `rhine.stats().archivePull.ready`, 5000);
  await touch("touchEnd");
  await settledDetail();
  await check("touch extraction uses the same host-detail route", `rhine.stats().selectedIndex===rhineSshUi.cardOf('review-host') && rhineSshUi.sessions.length===0`);
  await send("Emulation.setTouchEmulationEnabled", {enabled:false});
  await returnToArray();

  await hit('[data-action="ssh-hosts"]');
  await until("expanded hosts", `document.querySelector('.ssh-overview').dataset.transition==='open' && document.querySelector('.ssh-overview').dataset.collapsed==='false'`);
  await hit('[data-host-alias="review-host"] [data-overview-action="inspect"]');
  await settledDetail();
  await hit('#host-connect');
  await until("password prompt", `rhineSshUi.promptKind==='password'`);
  await hit('.ssh-prompt-back');
  await until("authentication back returns", `!rhineSshUi.promptOpen && rhine.stats().mode==='archive' && !document.querySelector('.ssh-overview').inert`);
  await check("authentication back still cancels the attempt", `!rhineSsh.active && !rhineSshUi.isOpen`);
  await hit('[data-host-alias="review-host"] [data-overview-action="inspect"]');
  await settledDetail();
  await hit('#host-connect');
  await until("second password prompt", `rhineSshUi.promptKind==='password'`);
  await evaluate(`rhineSshUi.answerSecret('navigation-fixture-only')`);
  await terminalReady();
  await evaluate(String.raw`window.__navigationSession={key:rhineSshUi.activeSessionKey,id:rhineSsh.id,count:__multiFixture.entries.size}; __multiFixture.output(rhineSsh.id,'\r\nNAVIGATION_BUFFER_MARKER\r\n');`);
  await hit('.ssh-terminal:not([hidden]) .ssh-terminal-close');
  await settledDetail();
  await check("terminal collapse returns to this host instead of the global overview", `rhine.stats().selectedIndex===rhineSshUi.cardOf('review-host') && document.querySelector('.ssh-overview').hidden && document.querySelector('#host-connect').dataset.action==='ssh-terminal' && rhineSsh.active && rhineSshUi.activeSessionKey===__navigationSession.key`);
  await until("focus returns to host terminal entry", `document.activeElement===document.querySelector('#host-connect')`);
  await evaluate(String.raw`__multiFixture.output(__navigationSession.id,'\r\nOUTPUT_WHILE_COLLAPSED\r\n')`);
  await shot("04-returned-to-host");
  await clickPoint(await modelPoint());
  await terminalReady();
  await check("clicking the detail model reopens the same terminal buffer", `rhineSsh.id===__navigationSession.id && __multiFixture.entries.size===__navigationSession.count && rhineSsh.output.includes('NAVIGATION_BUFFER_MARKER') && rhineSsh.output.includes('OUTPUT_WHILE_COLLAPSED')`);
  await key("Escape", "Escape", 27);
  await check("Escape remains terminal input", `rhineSshUi.isOpen && __multiFixture.entries.get(__navigationSession.id).writes.some(text=>text.includes(String.fromCharCode(27)))`);
  await key("E", "KeyE", 69, 2 | 8);
  await settledDetail();
  await hit('.back-button');
  await until("global overview can be collapsed again", `document.querySelector('.ssh-overview').dataset.transition==='open' && !document.querySelector('.ssh-overview').inert`);
  await hit('.ssh-overview-heading-actions [data-overview-action="collapse"]');
  await settledArchive();
  await check("the array exposes the retained terminal outside the model", visible('.archive-session'));
  await hit('.archive-session');
  await terminalReady();
  await check("the outer terminal button resumes without reconnecting", `__multiFixture.entries.size===__navigationSession.count && rhineSsh.id===__navigationSession.id`);
  await hit('.ssh-terminal:not([hidden]) .ssh-terminal-close');
  await until("DOM terminal exits before camera finishes", `!rhineSshUi.isOpen && !document.querySelector('#detail-ui').inert && document.querySelector('.ssh-terminal').hidden`);
  evidence.interruptedClose = await evaluate(`rhine.stats().sessionDeck.progress`);
  await key("T", "KeyT", 84, 2 | 8);
  await terminalReady();
  await check("reopening during reassembly preserves session and final focus", `rhineSsh.id===__navigationSession.id && rhineSshUi.hasFocus && __multiFixture.entries.size===__navigationSession.count`);
  await evaluate(`rhineSshUi.closeTerminal(); rhine.archive()`);
  await settledArchive();
  await check("later archive navigation survives the terminal exit callback", `rhine.stats().mode==='archive' && !rhineSshUi.isOpen && rhineSsh.id===__navigationSession.id && ${visible('.archive-session')}`);

  evidence.layouts = [];
  for (const [width, height, dpr, dark] of [[1920,1080,1,false],[1366,768,1.25,false],[2560,1440,1.5,true]]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: dpr, mobile: false });
    await sleep(400);
    if (dark) {
      await hit('[data-action="settings"]');
      await until("settings visible", visible('[data-color-theme="dark"]'));
      await hit('[data-color-theme="dark"]');
      await hit('[data-action="close-modal"]');
      await settledArchive();
      await sleep(1200);
    }
    const layout = await evaluate(`(() => { const selectors=['.read-file','.archive-session','.ssh-overview-restore','[data-action="prev"]','[data-action="next"]','[data-action="column-prev"]','[data-action="column-next"]']; return {width:innerWidth,height:innerHeight,dpr:devicePixelRatio,controls:selectors.map(selector=>{const n=document.querySelector(selector),r=n.getBoundingClientRect();return {selector,rect:r.toJSON(),hit:n.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)),visible:getComputedStyle(n).visibility==='visible'&&!n.closest('[inert],[hidden]')};})};})()`);
    evidence.layouts.push(layout);
    await check(`archive controls remain reachable at ${width}x${height} DPR ${dpr}`, `${layout.controls.every(item=>item.hit && item.visible && item.rect.left >= 0 && item.rect.right <= width && item.rect.top >= 0 && item.rect.bottom <= height)}`);
    await shot(`05-archive-${width}-${dark ? 'dark' : 'light'}`);
    await hit('.read-file');
    await settledDetail();
    await hit('#host-connect');
    await terminalReady();
    await shot(`06-terminal-${width}-${dark ? 'dark' : 'light'}`);
    await hit('.ssh-terminal:not([hidden]) .ssh-terminal-close');
    await settledDetail();
    await returnToArray();
  }
  await evaluate(`localStorage.setItem('rhine-settings', JSON.stringify({...JSON.parse(localStorage.getItem('rhine-settings')),reduced:true}));`);
  await send("Page.reload");
  await until("collapsed preference survives reload", `window.rhine?.stats().ready && window.rhineSshUi?.boundHosts.length===8 && document.querySelector('.ssh-overview').dataset.collapsed==='true'`);
  await settledArchive();
  await check("reload restores original controls without auto-connecting", `rhineSshUi.sessions.length===0 && ${visible('.read-file')}`);
  await evaluate(`rhine.select(rhineSshUi.cardOf('review-host')); __multiFixture.auto=true;`);
  await settledArchive();
  await clickPoint(await modelPoint());
  await settledDetail();
  await hit('#host-connect');
  await terminalReady();
  await hit('.ssh-terminal:not([hidden]) .ssh-terminal-close');
  await settledDetail();
  await check("reduced motion keeps the same return hierarchy and connection", `rhine.stats().motion.reduced && rhineSsh.active && !document.querySelector('#detail-content').inert && rhine.stats().sessionDeck.progress===0`);
  await shot("07-reduced-return");
}
