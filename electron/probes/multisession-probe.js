/** Sandboxed renderer + real preload/IPC/ConPTY; the SSH peer is a fixture. */
(async () => {
  const waitFor = async (predicate, name, timeout = 20000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Concurrent desktop: ${name} timed out`);
  };
  const ui = window.rhineSshUi;
  document.querySelector('#loading .entry-start')?.click();
  await waitFor(() => window.rhine.stats().ready && window.rhine.stats().startup === 'started', 'startup');
  window.rhine.archive();
  await ui.startSession({target:'passhost-one'});
  const a = window.rhineSsh, one = ui.sessions.find(session => session.id === a.id);
  await waitFor(() => a.pendingPrompt?.kind === 'password', 'first password');
  await ui.startSession({target:'passhost-two'});
  const b = window.rhineSsh, two = ui.sessions.find(session => session.id === b.id);
  await waitFor(() => b.pendingPrompt?.kind === 'password', 'second password');
  const promptIds = [a.pendingPrompt.id, b.pendingPrompt.id];
  ui.answerSecret('fixture-two');
  await waitFor(() => b.status().phase === 'interactive', 'second authentication');
  const checks = {
    'preload assigns distinct native IDs and log files': a.id !== b.id && a.buildRecord().logPath !== b.buildRecord().logPath,
    'a second password reply leaves the first connection awaiting its own answer': !!a.pendingPrompt && !b.pendingPrompt && a.status().phase !== 'interactive',
  };
  ui.activateSession(one.key);
  await waitFor(() => ui.promptKind === 'password' && ui.promptText.includes('passhost-one'), 'switch to first password');
  ui.answerSecret('fixture-one');
  await waitFor(() => a.status().phase === 'interactive' && ui.hasFocus, 'first authentication');
  a.write('native_multi_one\r');
  b.write('native_multi_two\r');
  await waitFor(() => a.output.includes('[fake-ssh] native_multi_one') && b.output.includes('[fake-ssh] native_multi_two'), 'independent echoes');
  checks['native IPC input and output remain isolated between two ConPTY processes'] = !a.output.includes('native_multi_two') && !b.output.includes('native_multi_one');
  ui.activateSession(two.key);
  await waitFor(() => ui.activeSessionKey === two.key && ui.hasFocus, 'operating switch');
  checks['native session switching mounts one terminal and retains the other buffer'] = document.querySelectorAll('.ssh-terminal .xterm').length === 1 && a.output.includes('native_multi_one');
  window.rhineDesktop.session.resize(110, 32, a.id);
  window.rhineDesktop.session.resize(130, 38, b.id);
  b.stop();
  await waitFor(() => !!b.exit, 'second exit');
  window.rhineDesktop.session.resize(132, 40, b.id);
  const late = await window.rhineDesktop.session.answer(1, 'stale-fixture', b.id);
  checks['late resize and authentication after native exit are rejected without affecting A'] = !late.ok && a.active;
  await b.persistRecord();
  const records = await window.rhineDesktop.records.list();
  checks['the ended native session is readable from history'] = records.ok && records.records.some(record => record.id === b.id && record.exitCode !== null);
  await ui.startSession({target:'reload-live-peer'});
  const c = window.rhineSsh;
  await waitFor(() => c.status().phase === 'interactive', 'reload companion');
  return {checks, promptIds, liveIds:[a.id,c.id], endedId:b.id, sessions:ui.sessions};
})().catch(error => ({error:String(error?.stack || error)}));
