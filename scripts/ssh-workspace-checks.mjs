/** Real DOM/xterm with labelled fixture samples; never used for transport QA. */
export async function checkSshWorkspace({
  evaluate,
  until: waitFor,
  check,
  shot,
  key,
  send,
  sleep,
  evidence,
}) {
  const until = (name, expression) => waitFor(name, expression, 15000);
  const click = (selector) =>
    evaluate(
      `(() => { const element = document.querySelector(${JSON.stringify(selector)}); element.focus({preventScroll:true}); element.click(); })()`,
    );
  const tab = (page) => click(`[data-workspace-page="${page}"]`);
  const field = (selector, text) =>
    evaluate(
      `(() => { const element = document.querySelector(${JSON.stringify(selector)}); element.focus(); element.value = ${JSON.stringify(text)}; element.dispatchEvent(new Event('input',{bubbles:true})); })()`,
    );
  await until(
    "paged file listing",
    `Number(document.querySelector('.ssh-files-count').textContent) > 700`,
  );
  await check(
    "1920 workspace preserves a terminal of at least 80 columns beside a 320 px sidebar",
    `document.querySelector('.ssh-terminal').dataset.workspace === 'split' && Math.abs(document.querySelector('.ssh-workspace-side').clientWidth - 320) <= 1 && __deckFixture.sizes.at(-1)[0] >= 80`,
  );
  await check(
    "large directory is paged and virtualized",
    `__workspaceFixture.calls.some(call => call.cursor) && document.querySelectorAll('.ssh-file-row').length < 50`,
  );
  await check(
    "one xterm is shared by every workspace page",
    `document.querySelectorAll('.xterm').length === 1`,
  );
  await shot("workspace-files-1920");
  await field(".ssh-files-filter input", "models");
  await until(
    "folder filter",
    `document.querySelector('.ssh-file-name')?.textContent === 'models'`,
  );
  await evaluate(
    `window.__fileNode = document.querySelector('.ssh-file-row'); __fileNode.click()`,
  );
  await check(
    "selecting a file retains its DOM node for native double click",
    `__fileNode === document.querySelector('.ssh-file-row') && document.querySelector('.ssh-file-row').getAttribute('aria-selected') === 'true'`,
  );
  const row = await evaluate(
    `(() => {const r=document.querySelector('.ssh-file-row').getBoundingClientRect();return {x:r.x+60,y:r.y+20};})()`,
  );
  for (const type of ["mousePressed", "mouseReleased"])
    await send("Input.dispatchMouseEvent", {
      type,
      ...row,
      button: "left",
      clickCount: 2,
    });
  await until(
    "double click enters directory",
    `document.querySelector('.ssh-files-path').value === '/home/operator/models'`,
  );
  await field(".ssh-files-filter input", "");
  await check(
    "directory navigation displays actual returned entries",
    `document.querySelector('.ssh-file-name').textContent === 'weights.safetensors'`,
  );
  await evaluate(`document.querySelector('.ssh-files-list').focus()`);
  await key("Backspace", "Backspace", 8);
  await until(
    "parent directory",
    `document.querySelector('.ssh-files-path').value === '/home/operator' && Number(document.querySelector('.ssh-files-count').textContent) > 700`,
  );
  await field(".ssh-files-path", "/not-found");
  await evaluate(
    `document.querySelector('.ssh-files-path-form').requestSubmit()`,
  );
  await until(
    "failed navigation",
    `document.querySelector('.ssh-files-feedback').textContent.includes('目录不存在')`,
  );
  await check(
    "failed navigation retains the original directory and its entries",
    `document.querySelector('.ssh-files-path').value === '/home/operator' && Number(document.querySelector('.ssh-files-count').textContent) > 700`,
  );
  await field(".ssh-files-filter input", "sample-00");
  await evaluate(`document.querySelector('.ssh-file-row').click()`);
  await key("ArrowDown", "ArrowDown", 40, 8);
  await key("ArrowDown", "ArrowDown", 40, 8);
  await check(
    "Shift navigation extends selection across successive rows",
    `document.querySelectorAll('.ssh-file-row[aria-selected="true"]').length === 3`,
  );
  await click('[data-file-action="download"]');
  await until(
    "transfer drawer opens",
    `document.querySelector('.ssh-transfer-drawer').dataset.transition === 'open'`,
  );
  await check(
    "selected files are sent as one explicit download request",
    `__workspaceFixture.calls.filter(call => call.method === 'download').at(-1).paths.length === 3`,
  );
  await click('[data-transfer-action="close"]');
  await field(".ssh-files-filter input", "");
  await click('[data-file-action="mkdir"]');
  await field(".ssh-file-editor-name", "UI-test-directory");
  await evaluate(`document.querySelector('.ssh-file-editor').requestSubmit()`);
  await until(
    "mkdir returns to listing",
    `__workspaceFixture.calls.some(call => call.method === 'mkdir') && document.querySelector('.ssh-file-editor').hidden`,
  );
  await field(".ssh-files-filter input", "UI-test-directory");
  await until(
    "created directory visible",
    `document.querySelector('.ssh-file-name')?.textContent === 'UI-test-directory'`,
  );
  await evaluate(`document.querySelector('.ssh-file-row').click()`);
  await key("F2", "F2", 113);
  await field(".ssh-file-editor-name", "renamed-directory");
  await evaluate(`document.querySelector('.ssh-file-editor').requestSubmit()`);
  await until(
    "rename submitted",
    `__workspaceFixture.calls.some(call => call.method === 'rename') && document.querySelector('.ssh-file-editor').hidden`,
  );
  await field(".ssh-files-filter input", "renamed-directory");
  await until(
    "renamed entry visible",
    `document.querySelector('.ssh-file-name')?.textContent === 'renamed-directory'`,
  );
  await evaluate(`document.querySelector('.ssh-file-row').click()`);
  await key("Delete", "Delete", 46);
  await check(
    "delete waits for an inline explicit confirmation",
    `!document.querySelector('.ssh-file-editor').hidden && !__workspaceFixture.calls.some(call => call.method === 'remove')`,
  );
  await evaluate(`document.querySelector('.ssh-file-editor').requestSubmit()`);
  await until(
    "delete applied",
    `__workspaceFixture.calls.some(call => call.method === 'remove')`,
  );
  await field(".ssh-files-filter input", "");
  await until(
    "delete listing refreshed",
    `document.querySelector('.ssh-files-state').textContent.includes('项') && document.querySelector('.ssh-file-editor').hidden`,
  );
  await evaluate(
    `document.querySelector('.ssh-files').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:(()=>{const d=new DataTransfer();d.items.add(new File(['fixture'],'drop-file.txt'));return d;})()}))`,
  );
  await until(
    "drag upload",
    `__workspaceFixture.calls.some(call => call.method === 'drop')`,
  );
  await check(
    "drop upload uses the current directory and actual File objects",
    `__workspaceFixture.calls.filter(call => call.method === 'drop').at(-1).destination === '/home/operator'`,
  );
  await evaluate(
    `window.__conflictJob = __workspaceFixture.addJob({state:'conflict',name:'checkpoints.tar.gz',conflict:{id:'conflict-1',path:'/home/operator/checkpoints.tar.gz',directory:false,sourceSize:67108864,existingSize:441024}})`,
  );
  await until(
    "conflict row visible",
    `!document.querySelector('[data-job="'+__conflictJob.id+'"] .ssh-transfer-conflict').hidden`,
  );
  await evaluate(
    `document.querySelector('[data-job="'+__conflictJob.id+'"] .ssh-transfer-conflict input').checked=true`,
  );
  await shot("workspace-transfer-conflict");
  await evaluate(
    `document.querySelector('[data-job="'+__conflictJob.id+'"] [data-transfer-action="keep-both"]').click()`,
  );
  await check(
    "conflict response carries the displayed token and apply-to-all choice",
    `__workspaceFixture.calls.filter(call => call.method === 'conflict').at(-1).conflictId === 'conflict-1' && __workspaceFixture.calls.filter(call => call.method === 'conflict').at(-1).all`,
  );
  await click('[data-transfer-action="close"]');
  await tab("monitor");
  await until(
    "monitor renders two GPUs",
    `document.querySelectorAll('.ssh-gpu').length === 2`,
  );
  await evaluate(
    `window.__gpuNode=document.querySelector('.ssh-gpu'); document.querySelector('.ssh-gpu details').open=true; window.__oldReading=document.querySelector('[data-metric="cpu"] .ssh-metric-value').textContent`,
  );
  await sleep(1300);
  await check(
    "1 Hz updates preserve GPU nodes, process disclosure and live rolling values",
    `__gpuNode === document.querySelector('.ssh-gpu') && document.querySelector('.ssh-gpu details').open && document.querySelector('[data-metric="cpu"] .ssh-metric-value').textContent !== __oldReading`,
  );
  await check(
    "monitor uses per-device histories and resource colors",
    `document.querySelectorAll('.ssh-gpu .ssh-trend-line[d]').length === 2 && document.querySelectorAll('.ssh-disk[data-tone="high"]').length === 1 && document.querySelector('.ssh-trend-line').getAttribute('d').length > 100`,
  );
  await shot("workspace-monitor-1920");
  await evaluate(`__workspaceFixture.stale()`);
  await sleep(1100);
  await check(
    "missing samples are visibly stale",
    `document.querySelector('.ssh-monitor').dataset.stale === 'true' && document.querySelector('.ssh-monitor-status').textContent.includes('采样已暂停')`,
  );
  await evaluate(
    `__workspaceFixture.status('monitor',{state:'error',message:'Fixture monitor offline'})`,
  );
  await click(".ssh-monitor-retry");
  await until(
    "monitor retry recovers",
    `document.querySelector('.ssh-monitor').dataset.stale === 'false'`,
  );
  await evaluate(`__workspaceFixture.oldEvent()`);
  await tab("files");
  await check(
    "old-session capability events are ignored",
    `!document.querySelector('.ssh-files-state').textContent.includes('STALE_SESSION')`,
  );
  await evaluate(`__workspaceFixture.prompt('sftp','password')`);
  await until(
    "auxiliary password prompt",
    `rhineSshUi.promptKind === 'password' && document.querySelector('.ssh-prompt .detail-kicker').textContent.includes('SFTP')`,
  );
  await check(
    "auxiliary authentication uses the existing animated prompt and isolates terminal input",
    `document.querySelector('.ssh-terminal').inert && Number(document.querySelector('.ssh-prompt').dataset.motionCount) > 0`,
  );
  await shot("workspace-auxiliary-auth");
  await click('.ssh-prompt [data-action="cancel"]');
  await until("auxiliary prompt closes", `!rhineSshUi.promptOpen`);
  await check(
    "auxiliary cancel preserves the active terminal session",
    `rhineSsh.active && __workspaceFixture.answers.at(-1).canceled`,
  );
  await field(".ssh-files-filter input", "train");
  await evaluate(
    `window.__writesBeforeFiles = __deckFixture.writes.length; __deckFixture.clipboard.text='SHOULD_NOT_PASTE'`,
  );
  await evaluate(
    `document.querySelector('.ssh-files-filter input').dispatchEvent(new KeyboardEvent('keydown',{key:'V',ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true}))`,
  );
  await key("F", "KeyF", 70, 10);
  await check(
    "terminal paste and search shortcuts do not hijack file inputs",
    `__deckFixture.writes.length === __writesBeforeFiles && document.querySelector('.ssh-terminal-tools').hidden`,
  );
  await field(".ssh-files-filter input", "");

  evidence.workspaceLayouts = [];
  for (const [width, height] of [
    [1024, 640],
    [1366, 768],
    [1600, 900],
    [1920, 1080],
    [2560, 1440],
  ]) {
    await send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(700);
    for (const page of ["terminal", "files", "monitor"]) {
      await tab(page);
      await sleep(350);
      const layout = await evaluate(
        `(() => {const t=document.querySelector('.ssh-terminal'), r=t.getBoundingClientRect(), body=document.querySelector('.ssh-workspace-body'); return {mode:t.dataset.workspace,page:t.dataset.workspacePage,width:innerWidth,height:innerHeight,cols:__deckFixture.sizes.at(-1)[0],sidebar:document.querySelector('.ssh-workspace-side').clientWidth,overflow:body.scrollWidth>body.clientWidth+1,inside:r.x>=0&&r.y>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1,xterms:document.querySelectorAll('.xterm').length};})()`,
      );
      evidence.workspaceLayouts.push(layout);
      await check(
        `${width}x${height} ${page} stays inside the screen without horizontal overflow`,
        `${layout.inside && !layout.overflow && layout.xterms === 1}`,
      );
      if (page === "monitor")
        await shot(`workspace-monitor-${width}x${height}`);
    }
  }
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1920,
    height: 1080,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(700);
  await tab("files");
  const divider = await evaluate(
    `(() => {const r=document.querySelector('.ssh-side-divider').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`,
  );
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    ...divider,
    button: "left",
    clickCount: 1,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: divider.x - 250,
    y: divider.y,
    button: "left",
    buttons: 1,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: divider.x - 250,
    y: divider.y,
    button: "left",
    clickCount: 1,
  });
  await sleep(350);
  await check(
    "sidebar drag respects 260–480 bounds and preserves 80 terminal columns",
    `document.querySelector('.ssh-workspace-side').clientWidth <= 480 && document.querySelector('.ssh-workspace-side').clientWidth >= 260 && __deckFixture.sizes.at(-1)[0] >= 80`,
  );
  await tab("terminal");
  await key("P", "KeyP", 80, 10);
  for (const target of [12, 24, 16]) {
    await evaluate(
      `(() => {const current=Number(document.querySelector('[data-terminal-tool="font"]').textContent); for(let n=current;n!==${target};n+=n<${target}?1:-1) document.querySelector('[data-terminal-tool="'+(n<${target}?'larger':'smaller')+'"]').click();})()`,
    );
    await tab("monitor");
    await sleep(350);
    await check(
      `font ${target} uses a valid workspace layout`,
      `document.querySelector('.ssh-terminal').dataset.workspace === 'compact' || __deckFixture.sizes.at(-1)[0] >= 80`,
    );
    await tab("terminal");
    await key("P", "KeyP", 80, 10);
    await sleep(200);
  }
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1024,
    height: 640,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(700);
  await tab("monitor");
  await evaluate(
    `window.__compactXterm=document.querySelector('.xterm'); window.__protocolStart=__deckFixture.writes.length; __deckFixture.output(${JSON.stringify("\x1b[6n\r\nHIDDEN_SIDE_OUTPUT\r\n")})`,
  );
  await until(
    "hidden terminal answers protocol",
    String.raw`__deckFixture.writes.slice(__protocolStart).some(value => /^\u001b\[\d+;\d+R$/.test(value))`,
  );
  await check(
    "compact monitoring keeps terminal protocol replies alive without zero-size resize",
    `__deckFixture.sizes.every(([cols,rows]) => cols>0 && rows>0)`,
  );
  await tab("terminal");
  await check(
    "returning from compact page preserves the same xterm and output",
    `__compactXterm === document.querySelector('.xterm') && rhineSsh.output.includes('HIDDEN_SIDE_OUTPUT')`,
  );
  await evaluate(`__deckFixture.end(0)`);
  await tab("monitor");
  await check(
    "disconnect retains the last samples and visibly marks them stopped",
    `document.querySelectorAll('.ssh-gpu').length === 2 && document.querySelector('.ssh-monitor').dataset.stale === 'true'`,
  );
  await evaluate(
    `localStorage.setItem('rhine-settings',JSON.stringify({...JSON.parse(localStorage.getItem('rhine-settings')),colorTheme:'dark',reduced:true}))`,
  );
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1920,
    height: 1080,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Page.reload");
  await until(
    "dark reduced workspace",
    `window.rhine?.stats().ready && !!window.rhineSshUi`,
  );
  await evaluate(`rhineSshUi.connectHost('review-host')`);
  await until("dark auth", `rhineSshUi.promptKind==='password'`);
  await evaluate(
    `rhineSshUi.answerSecret('fixture-only');__deckFixture.interactive()`,
  );
  await until("dark terminal", `rhineSshUi.isOpen && rhineSshUi.hasFocus`);
  await tab("monitor");
  await sleep(500);
  await check(
    "dark reduced mode keeps all instrumentation and disables decorative motion",
    `document.querySelector('.ssh-terminal').dataset.dark==='true' && document.querySelector('.ssh-monitor').getAnimations({subtree:true}).length===0 && document.querySelectorAll('.ssh-gpu').length===2`,
  );
  await shot("workspace-monitor-dark-reduced");
  await tab("files");
  await until(
    "dark files",
    `document.querySelectorAll('.ssh-file-row').length>0`,
  );
  await shot("workspace-files-dark-reduced");
}
