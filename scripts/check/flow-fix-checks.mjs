export async function checkFlowFix({ evaluate, until, check, shot, key }) {
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  await click('.ssh-overview-host[data-host-alias="review-host"] .ssh-overview-connect');
  await until('host archive opens', `rhine.stats().cameraDetail > .98`);
  await check('host row opens archive without inspection or SSH', `!rhineSsh.active && !rhineSshUi.isOpen && (!document.querySelector('.model-viewer') || document.querySelector('.model-viewer').hidden)`);
  await click('.viewer-open');
  await until('explicit inspection automatically explodes', `JSON.parse(document.querySelector('.model-viewer').dataset.stats || '{}').spread === 1`);
  await shot('explicit-explosion');
  await key('Escape','Escape',27);
  await until('inspection returns to archive', `document.querySelector('.model-viewer').hidden`);
  await click('[data-action="ssh-connect"]');
  await until('direct connection prompts', `rhineSshUi.promptKind === 'password'`);
  await check('connecting does not reopen the inspector', `document.querySelector('.model-viewer').hidden`);
  await evaluate(`rhineSshUi.answerSecret('flow-fix'); __deckFixture.interactive()`);
  await until('terminal opens directly', 'rhineSshUi.hasFocus');
  await check('settings is visible outside more', `(() => {const b=document.querySelector('.ssh-terminal-settings');const r=b.getBoundingClientRect();return !b.closest('details') && r.width>0 && r.height>0 && b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})()`);
  await click('.ssh-terminal-settings');
  for (const section of ['connection','security','data','terminal']) {
    await until('workspace settings visible', `document.querySelector('.ssh-settings-scroll')?.closest('section')?.hidden === false`);
    await click('.ssh-utility-surface [data-settings-section="appearance"]');
    await until('appearance visible', `document.querySelector('.modal-backdrop')?.dataset.transition === 'open'`);
    await click(`.settings-modal [data-settings-section="${section}"]`);
    await until('category returns from appearance', `!document.querySelector('.modal-backdrop') && document.querySelector('.ssh-utility-surface [data-settings-section="${section}"]')?.getAttribute('aria-current') === 'page'`);
    await check(`appearance can return to ${section}`, `!document.querySelector('.ssh-settings-scroll').closest('section').inert`);
  }
  await click('.ssh-utility-surface [data-close]');
  await until('settings closed', 'rhineSshUi.hasFocus');
  await evaluate('rhineSshUi.closeTerminal()');
  await until('terminal closed', '!rhineSshUi.isOpen');
  await check('closing terminal returns to archive without forced inspection', `document.querySelector('.model-viewer').hidden && rhineSsh.active`);
  await shot('archive-return');
}
