/** Native CSS-pixel overview, editor and settings, against the real DOM bundle. */
export async function checkOverviewUI({
  evaluate,
  until,
  check,
  shot,
  send,
  sleep,
  evidence,
}) {
  const click = (selector) =>
    evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const field = (name, value) =>
    evaluate(
      `(() => {const field=document.querySelector(${JSON.stringify(name)});field.value=${JSON.stringify(value)};field.dispatchEvent(new Event('input',{bubbles:true}));field.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
  const hit = async (selector) => {
    const point = await evaluate(
      `(() => {const node=document.querySelector(${JSON.stringify(selector)});node.scrollIntoView({block:'nearest'});const r=node.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,hit:node.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))};})()`,
    );
    if (!point.hit) throw new Error("Covered mouse target: " + selector);
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x,
      y: point.y,
    });
    for (const type of ["mousePressed", "mouseReleased"])
      await send("Input.dispatchMouseEvent", {
        type,
        x: point.x,
        y: point.y,
        button: "left",
        clickCount: 1,
      });
  };
  await until(
    "overview entered",
    `document.querySelector('.ssh-overview')?.dataset.transition==='open'`,
  );
  const geometries = [];
  for (const theme of ["light", "dark"]) {
    await hit('[data-overview-action="settings"]');
    await until(
      "native settings",
      `document.querySelector('.modal-backdrop')?.dataset.transition==='open'`,
    );
    await check(
      "overview settings isolate background input",
      `document.querySelector('#modal-root').closest('#stage')===null && document.querySelector('.ssh-overview').inert`,
    );
    await hit(`[data-color-theme="${theme}"]`);
    await hit('[data-action="close-modal"]');
    await until(
      "settings returned to overview",
      `!document.querySelector('.ssh-overview').inert && !document.querySelector('.modal-backdrop')`,
    );
    await sleep(1200);
    for (const [width, height, dpr] of [
      [1920, 1080, 1],
      [2560, 1440, 1.5],
      [1280, 800, 1.25],
    ]) {
      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: dpr,
        mobile: false,
      });
      await sleep(550);
      const geometry = await evaluate(
        `(() => {const sheet=document.querySelector('.ssh-overview-glass'),r=sheet.getBoundingClientRect(),brand=document.querySelector('.brand').getBoundingClientRect();return {theme:${JSON.stringify(theme)},width:innerWidth,height:innerHeight,dpr:devicePixelRatio,sheet:{x:r.x,y:r.y,width:r.width,height:r.height},overflow:sheet.scrollWidth>sheet.clientWidth,brandOverlap:brand.right>r.left&&brand.bottom>r.top,native:!sheet.closest('#stage')&&getComputedStyle(sheet).transform==='none'};})()`,
      );
      geometries.push(geometry);
      await check(
        `${theme} overview fits ${width}x${height} DPR${dpr}`,
        `${!geometry.overflow && !geometry.brandOverlap && geometry.native && geometry.sheet.x >= 0 && geometry.sheet.y >= 0 && geometry.sheet.x + geometry.sheet.width <= width + 1 && geometry.sheet.y + geometry.sheet.height <= height + 1}`,
      );
      await shot(`overview-${theme}-${width}`);
    }
  }
  evidence.overviewGeometry = geometries;
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1920,
    height: 1080,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(350);
  await hit('[data-overview-action="settings"]');
  await until(
    "settings for light theme",
    `document.querySelector('.modal-backdrop')?.dataset.transition==='open'`,
  );
  await hit('[data-color-theme="light"]');
  await hit('[data-action="close-modal"]');
  await until(
    "overview editable",
    `!document.querySelector('.ssh-overview').inert`,
  );

  await click('[data-overview-action="add"]');
  await field('.ssh-host-editor [name="name"]', "凭据 UI 验证");
  await field('.ssh-host-editor [name="hostname"]', "192.0.2.20");
  await field('.ssh-host-editor [name="user"]', "tester");
  await click('[name="rememberCredential"]');
  await field('[name="credential"]', "isolated-ui-password");
  await evaluate(
    `__multiFixture.failCredentialSave=true; document.querySelector('.ssh-host-editor').requestSubmit()`,
  );
  await until(
    "partial save reported",
    `document.querySelector('.ssh-host-editor-message').textContent.includes('凭据未保存')`,
  );
  await check(
    "credential failure preserves the saved host identity and input",
    `__multiFixture.profiles.size===1 && document.querySelector('[name="credential"]').value==='isolated-ui-password' && !document.querySelector('.ssh-host-editor').hidden`,
  );
  await evaluate(
    `__multiFixture.failCredentialSave=false; document.querySelector('.ssh-host-editor').requestSubmit()`,
  );
  await until(
    "saved host appears",
    `document.querySelectorAll('.ssh-overview-host').length===9 && !document.querySelector('.ssh-overview-hosts').hidden`,
  );
  await evaluate(
    `window.__overviewTestAlias='rhine-profile:'+Array.from(__multiFixture.profiles.keys())[0]`,
  );
  await check(
    "retry updates the same host and keeps secrets out of profile and workspace JSON",
    `__multiFixture.profiles.size===1 && __multiFixture.secrets.get(__overviewTestAlias+':password')==='isolated-ui-password' && !JSON.stringify(Array.from(__multiFixture.profiles.values())).includes('isolated-ui-password') && !JSON.stringify(localStorage).includes('isolated-ui-password')`,
  );
  await evaluate(
    `document.querySelector('[data-host-alias="'+__overviewTestAlias+'"] [data-overview-action="edit"]').click()`,
  );
  await until(
    "saved state in editor",
    `document.querySelector('.ssh-credential-state').textContent.includes('凭据已加密保存')`,
  );
  await check(
    "saved passwords are indicated without being returned to the input",
    `document.querySelector('[name="credential"]').value==='' && !document.querySelector('[name="rememberCredential"]').checked`,
  );
  await until(
    "credential editor visually settled",
    `document.documentElement.dataset.darkSurface==='false' && document.querySelector('.ssh-hosts').dataset.motion==='settled' && document.querySelector('.ssh-overview-content').getAnimations().every(animation=>animation.playState==='finished')`,
  );
  await shot("overview-saved-credential");

  await click('[data-overview-page="keys"]');
  await click(".ssh-key-import summary");
  await field('.ssh-key-import [name="name"]', "UI 导入身份");
  await field(
    '.ssh-key-import [name="content"]',
    "-----BEGIN OPENSSH PRIVATE KEY-----\nISOLATED-UI-ONLY\n-----END OPENSSH PRIVATE KEY-----",
  );
  await evaluate(
    `document.querySelector('.ssh-key-import form').requestSubmit()`,
  );
  await until(
    "key metadata row",
    `document.querySelectorAll('.ssh-key-row').length===1`,
  );
  await check(
    "key import clears the private field after success",
    `document.querySelector('.ssh-key-import textarea').value==='' && !document.querySelector('.ssh-key-import').open`,
  );
  await until(
    "key library visually settled",
    `document.querySelector('.ssh-key-library').dataset.motion==='settled' && document.querySelector('.ssh-overview-content').getAnimations().every(animation=>animation.playState==='finished')`,
  );
  await shot("overview-key-library");
  await click('[data-overview-page="hosts"]');
  await evaluate(
    `document.querySelector('[data-host-alias="'+__overviewTestAlias+'"] [data-overview-action="edit"]').click()`,
  );
  await field('[name="authMode"]', "key");
  await until(
    "key selector loaded",
    `document.querySelector('[name="keyId"]').options.length===2`,
  );
  await evaluate(
    `document.querySelector('[name="keyId"]').value=Array.from(__multiFixture.keys.keys())[0];document.querySelector('.ssh-host-editor').requestSubmit()`,
  );
  await until(
    "key host saved",
    `!document.querySelector('.ssh-overview-hosts').hidden`,
  );
  await click('[data-overview-page="keys"]');
  await until(
    "key reference listed",
    `document.querySelector('.ssh-key-list').textContent.includes('用于：')`,
  );
  await click('[data-key-action="remove"]');
  await click('[data-key-action="remove"]');
  await until(
    "referenced key removal rejected",
    `document.querySelector('.ssh-key-feedback').textContent.includes('解除')`,
  );
  await click('[data-overview-page="hosts"]');
  await evaluate(
    `document.querySelector('[data-host-alias="'+__overviewTestAlias+'"] [data-overview-action="edit"]').click()`,
  );
  await click(".ssh-host-remove");
  await click(".ssh-host-remove");
  await until(
    "test host removed",
    `document.querySelectorAll('.ssh-overview-host').length===8`,
  );
  await click('[data-overview-page="keys"]');
  await until(
    "unused key row",
    `document.querySelectorAll('.ssh-key-row').length===1`,
  );
  await click('[data-key-action="remove"]');
  await click('[data-key-action="remove"]');
  await until(
    "test key removed",
    `document.querySelectorAll('.ssh-key-row').length===0`,
  );
  await click('[data-overview-page="hosts"]');
}

export async function checkOperatingSettings({
  evaluate,
  until,
  check,
  shot,
  send,
  sleep,
}) {
  const button = await evaluate(
    `(() => {const b=document.querySelector('.ssh-terminal-settings'),r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,hit:b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))};})()`,
  );
  await check(
    "operating settings button is a real mouse target",
    String(button.hit),
  );
  for (const type of ["mousePressed", "mouseReleased"])
    await send("Input.dispatchMouseEvent", {
      type,
      x: button.x,
      y: button.y,
      button: "left",
      clickCount: 1,
    });
  await until(
    "settings above operating terminal",
    `document.querySelector('.modal-backdrop')?.dataset.transition==='open'`,
  );
  await check(
    "native settings preserve the visible terminal and isolate its input",
    `document.querySelector('.ssh-terminal').inert && document.querySelector('.ssh-terminal').dataset.surfaceCovered==='false' && document.querySelector('#modal-root').closest('#stage')===null`,
  );
  await shot("operating-settings");
  await evaluate(
    `document.querySelector('[data-action="close-modal"]').click()`,
  );
  await until(
    "operating focus restored",
    `!document.querySelector('.modal-backdrop') && !document.querySelector('.ssh-terminal').inert`,
  );
  await evaluate(
    `document.querySelector('.ssh-terminal .xterm-helper-textarea').focus()`,
  );
  await sleep(200);
}

export async function checkTabLifecycle({
  evaluate,
  until,
  check,
  shot,
  send,
  sleep,
  evidence,
}) {
  const click = (selector) =>
    evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const switchTo = async (variable) => {
    await evaluate(
      `Array.from(document.querySelectorAll('.ssh-terminal .ssh-session-tab')).find(node=>node.dataset.sessionKey===${variable}.key).querySelector('[role="tab"]').click()`,
    );
    await until(
      "tab selected",
      `rhineSshUi.activeSessionKey===${variable}.key && rhineSshUi.hasFocus`,
    );
  };
  const closeTab = async (variable, surface = ".ssh-terminal") => {
    const point = await evaluate(
      `(() => {const button=Array.from(document.querySelectorAll('${surface} .ssh-session-tab')).find(node=>node.dataset.sessionKey===${variable}.key).querySelector('.ssh-tab-close');button.scrollIntoView({block:'nearest',inline:'nearest'});const r=button.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`,
    );
    for (const type of ["mousePressed", "mouseReleased"])
      await send("Input.dispatchMouseEvent", {
        type,
        ...point,
        button: "left",
        clickCount: 1,
      });
  };
  await click('[data-overview-page="hosts"]');
  await click('[data-overview-action="settings"]');
  await until(
    "motion setting available",
    `document.querySelector('[data-pref="reduced"]')`,
  );
  await click('[data-pref="reduced"]');
  await click('[data-action="close-modal"]');
  await until(
    "full motion restored",
    `!rhine.stats().motion.reduced && !document.querySelector('.modal-backdrop')`,
  );
  await evaluate(
    `(async()=>{__multiFixture.auto=true; await rhineSshUi.startSession({target:'review-host'});window.__tabsA=rhineSshUi.sessions.at(-1)})()`,
  );
  await until(
    "first lifecycle terminal",
    `rhineSshUi.hasFocus && rhine.stats().sessionDeck.ready`,
  );
  await evaluate(
    `(async()=>{await rhineSshUi.startSession({target:'review-host'});window.__tabsB=rhineSshUi.sessions.at(-1)})()`,
  );
  await until(
    "second lifecycle terminal",
    `rhineSshUi.hasFocus && rhine.stats().sessionDeck.ready`,
  );
  await evaluate(
    `(async()=>{await rhineSshUi.startSession({target:'second-host'});window.__tabsC=rhineSshUi.sessions.at(-1)})()`,
  );
  await until(
    "third lifecycle terminal",
    `rhineSshUi.hasFocus && rhine.stats().sessionDeck.ready`,
  );
  await evaluate(
    `document.querySelector('.ssh-terminal .ssh-session-tabs [role="tab"][aria-selected="true"]').focus()`,
  );
  for (const [name, code, variable] of [
    ["ArrowLeft", 37, "__tabsB"],
    ["ArrowLeft", 37, "__tabsA"],
    ["End", 35, "__tabsC"],
    ["Home", 36, "__tabsA"],
  ]) {
    for (const type of ["keyDown", "keyUp"])
      await send("Input.dispatchKeyEvent", {
        type,
        key: name,
        code: name,
        windowsVirtualKeyCode: code,
      });
    await until(
      "keyboard tab focus retained",
      `rhineSshUi.activeSessionKey===${variable}.key && document.activeElement?.getAttribute('role')==='tab' && document.activeElement?.closest('[data-session-key]').dataset.sessionKey===${variable}.key`,
    );
  }
  await check(
    "consecutive arrow, Home and End keys remain in the session tab bar",
    `document.activeElement?.getAttribute('role')==='tab' && rhineSshUi.activeSessionKey===__tabsA.key`,
  );
  await switchTo("__tabsA");
  await switchTo("__tabsC");
  await click(".ssh-terminal-close");
  await until(
    "current host after collapse",
    `rhine.stats().mode==='detail' && rhine.stats().sessionDeck.progress===0 && !document.querySelector('#detail-ui').inert && !rhineSshUi.isOpen`,
  );
  await click(".back-button");
  await until(
    "overview after collapse",
    `!rhineSshUi.isOpen && !document.querySelector('.ssh-overview').inert`,
  );
  await click('[data-host-alias="review-host"] .ssh-overview-connect');
  await until(
    "recent session resumed",
    `rhineSshUi.activeSessionKey===__tabsA.key && rhineSshUi.hasFocus`,
  );
  await check(
    "host click resumes its last used session instead of the newest creation",
    `rhineSshUi.sessions.length===3 && rhineSshUi.activeSessionKey===__tabsA.key`,
  );
  await closeTab("__tabsB");
  await until(
    "background tab closed",
    `!rhineSshUi.sessions.some(session=>session.key===__tabsB.key)`,
  );
  await check(
    "background close preserves the foreground buffer and input",
    `rhineSshUi.hasFocus && rhineSshUi.activeSessionKey===__tabsA.key && __multiFixture.entries.get(__tabsA.id).active && !__multiFixture.entries.get(__tabsB.id).active`,
  );
  await evaluate(`__multiFixture.job(__tabsC.id,'transferring')`);
  await closeTab("__tabsC");
  await until(
    "tab transfer confirmation",
    `rhineSshUi.activeSessionKey===__tabsC.key && document.querySelector('.ssh-session-pending')?.textContent.includes('确认结束')`,
  );
  await click(".ssh-session-pending button:last-child");
  await check(
    "canceling tab close keeps the transfer and session alive",
    `__multiFixture.entries.get(__tabsC.id).active && rhineSshUi.sessions.some(session=>session.key===__tabsC.key)`,
  );
  await closeTab("__tabsC");
  await click(".ssh-session-pending button");
  await until(
    "confirmed tab close",
    `rhineSshUi.sessions.length===1 && rhineSshUi.activeSessionKey===__tabsA.key && rhineSshUi.hasFocus`,
  );
  await check(
    "confirmed active tab close returns to the remaining terminal",
    `!__multiFixture.entries.get(__tabsC.id).active && __multiFixture.entries.get(__tabsA.id).active && document.querySelectorAll('.ssh-terminal .xterm').length===1`,
  );
  await evaluate(
    `window.__lastTabContent=rhine.stats().sessionDeck.contentKey`,
  );
  await closeTab("__tabsA");
  await sleep(360);
  await check(
    "closing the last tab keeps its terminal picture during reassembly",
    `rhineSshUi.sessions.length===0 && rhine.stats().sessionDeck.progress>0 && rhine.stats().sessionDeck.progress<1 && rhine.stats().sessionDeck.contentKey===__lastTabContent`,
  );
  await shot("12-final-tab-reassembly");
  await until(
    "last close completes",
    `rhine.stats().sessionDeck.progress===0 && !rhineSshUi.isOpen && !document.querySelector('.ssh-overview').inert`,
  );
  await check(
    "last tab close returns to an empty interactive overview and retains history",
    `document.querySelector('.ssh-overview .ssh-session-tabs').hidden && !rhineSsh.active && __multiFixture.records.size===3`,
  );

  await evaluate(
    `(async()=>{await rhineSshUi.startSession({target:'review-host'});window.__tabsD=rhineSshUi.sessions.at(-1)})()`,
  );
  await until(
    "new terminal after final close",
    `rhineSshUi.hasFocus && rhine.stats().sessionDeck.ready`,
  );
  await evaluate(
    `(async()=>{await rhineSshUi.startSession({target:'second-host'});window.__tabsE=rhineSshUi.sessions.at(-1)})()`,
  );
  await until(
    "second new terminal",
    `rhineSshUi.hasFocus && rhine.stats().sessionDeck.ready`,
  );
  await click(".ssh-terminal-close");
  await until(
    "host details before returning to overview",
    `rhine.stats().mode==='detail' && rhine.stats().sessionDeck.progress===0 && !document.querySelector('#detail-ui').inert && !rhineSshUi.isOpen`,
  );
  await click(".back-button");
  await until(
    "overview before tab removal",
    `!document.querySelector('.ssh-overview').inert && !rhineSshUi.isOpen`,
  );
  await closeTab("__tabsE", ".ssh-overview");
  await until("overview tab closed", `rhineSshUi.sessions.length===1`);
  await check(
    "closing the current overview tab does not reopen a terminal",
    `!rhineSshUi.isOpen && rhine.stats().mode==='archive' && !document.querySelector('.ssh-overview').inert`,
  );
  await closeTab("__tabsD", ".ssh-overview");
  await until(
    "overview tabs empty",
    `rhineSshUi.sessions.length===0 && rhine.stats().sessionDeck.progress===0`,
  );
  await check(
    "overview can close its final tab without leaving an active connection",
    `!rhineSshUi.isOpen && Array.from(__multiFixture.entries.values()).every(entry=>!entry.active)`,
  );
  evidence.tabLifecycle = {
    ended: await evaluate("__multiFixture.records.size"),
    finalSessions: await evaluate("rhineSshUi.sessions.length"),
  };
}
