import { enterInspection } from './enter-inspection.mjs';
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
  // The toolbar is drawings now, so the whole row has to fit the 320 px column:
  // one line, nothing spilling past the panel's own edges.
  await check(
    "file toolbar holds one row of icon buttons inside the sidebar",
    `(() => {
      const side = document.querySelector('.ssh-workspace-side');
      const row = document.querySelector('.ssh-file-toolbar');
      const icons = [...row.querySelectorAll('button')];
      const top = icons[0].getBoundingClientRect().top;
      const bounds = side.getBoundingClientRect();
      // 260 px is the narrowest the sidebar drag allows. The refresh button is
      // pushed right by an auto margin, so measure the buttons and the gaps
      // between them — the row's own scroll extent just tracks its container.
      const intrinsic = icons.reduce((sum, icon) => sum + icon.getBoundingClientRect().width, 0) + 2 * (icons.length - 1);
      return icons.length === 7
        && icons.every(icon => Math.abs(icon.getBoundingClientRect().top - top) <= 1)
        && icons.every(icon => { const r = icon.getBoundingClientRect(); return r.left >= bounds.left - 1 && r.right <= bounds.right + 1; })
        && row.getBoundingClientRect().height <= 30
        && intrinsic <= 260;
    })()`,
  );
  // `/home/operator` holds a real dot-directory (`.ssh`), so the toggle has
  // something honest to hide and reveal.
  const fileNames = `[...document.querySelectorAll('.ssh-file-name')].map(node => node.textContent)`;
  const fileCount = `document.querySelector('.ssh-files-count').textContent`;
  await check(
    "dot entries stay out of the listing until asked for",
    `!${fileNames}.includes('.ssh')`,
  );
  const visibleCount = await evaluate(fileCount);
  await click('[data-file-action="hidden"]');
  await until(
    "the hidden-files toggle reveals dot files and folders",
    `${fileNames}.includes('.ssh')`,
  );
  await check(
    "the hidden-files choice is reported and remembered",
    `document.querySelector('[data-file-action="hidden"]').getAttribute('aria-pressed') === 'true' && localStorage.getItem('rhine-ssh-files-hidden') === '1'`,
  );
  await shot("workspace-files-hidden");
  await click('[data-file-action="hidden"]');
  await until(
    "turning the toggle back off hides them again",
    `!${fileNames}.includes('.ssh') && ${fileCount} === ${JSON.stringify(visibleCount)} && localStorage.getItem('rhine-ssh-files-hidden') === '0'`,
  );
  // The window has no native caption, so the OS paints its buttons into the
  // top-right of the page. The terminal fills the window, so its bar has to keep
  // that corner clear and hand the empty strip back as a drag region.
  await check(
    "terminal bar reserves the window's control corner and stays draggable",
    `(() => {
      const bar = document.querySelector('.ssh-terminal-bar');
      const style = getComputedStyle(bar);
      const region = style.webkitAppRegion ?? style.getPropertyValue('-webkit-app-region');
      const last = bar.lastElementChild.getBoundingClientRect();
      const reserved = parseFloat(style.paddingRight);
      // 138 is the width of the three Windows caption buttons; the bar adds its
      // own 20 px gutter on top (src/desktop.ts, electron/main.cjs).
      return region === 'drag'
        && reserved >= 20 + 138
        && last.right <= bar.getBoundingClientRect().right - reserved + 1;
    })()`,
  );
  await key("Tab", "Tab", 9);
  await evaluate(
    `document.querySelector('.ssh-workspace-tabs [data-workspace-page="files"]').focus()`,
  );
  evidence.workspaceFocus = await evaluate(
    `(() => { const nav = document.querySelector('.ssh-workspace-tabs'); const button = nav?.querySelector('[data-workspace-page="files"]'); if (!button) return { missing: true }; const style = getComputedStyle(button); return { navHidden: nav.hidden, navDisplay: getComputedStyle(nav).display, tabIndex: button.tabIndex, pointerEvents: style.pointerEvents, active: document.activeElement === button, visible: button.matches(':focus-visible'), outline: style.outline }; })()`,
  );
  await check(
    "keyboard focus remains distinct from the active workspace tab",
    `(() => { const button = document.querySelector('.ssh-workspace-tabs [data-workspace-page="files"]'); const style = getComputedStyle(button); return button.matches(':focus-visible') && style.outlineStyle === 'solid' && style.outlineWidth === '2px'; })()`,
  );
  await click('[data-file-action="bookmark"]');
  await click('[data-file-action="bookmarks"]');
  await until(
    "bookmarked directory immediately appears in the files sidebar",
    `!document.querySelector('.ssh-files-bookmarks').hidden && Array.from(document.querySelectorAll('.ssh-files-bookmarks button')).some(button => button.textContent.includes('/home/operator'))`,
  );
  await shot("workspace-files-bookmarks");
  await click('[data-file-action="bookmarks"]');
  await until(
    "the bookmark menu closes from its own toggle",
    `document.querySelector('.ssh-files-bookmarks').hidden`,
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
  await click('[data-file-action="bookmarks"]');
  await until(
    "bookmark menu opens from the toolbar",
    `!document.querySelector('.ssh-files-bookmarks').hidden`,
  );
  await evaluate(
    `Array.from(document.querySelectorAll('.ssh-files-bookmarks button')).find(button => button.textContent.includes('/home/operator')).click()`,
  );
  await until(
    "favorite opens its stored directory",
    `document.querySelector('.ssh-files-path').value === '/home/operator'`,
  );
  await check(
    "choosing a bookmark closes the menu",
    `document.querySelector('.ssh-files-bookmarks').hidden`,
  );
  await check(
    "files sidebar bookmark opens the saved directory",
    `document.querySelector('.ssh-files-path').value === '/home/operator'`,
  );
  // --- right-click menu ---
  const rightClick = (selector) =>
    evaluate(`(() => {
      const row = document.querySelector(${JSON.stringify(selector)});
      const rect = row.getBoundingClientRect();
      // dispatchEvent returns false when a listener called preventDefault, which
      // is exactly the "browser menu was suppressed" signal.
      return row.dispatchEvent(new MouseEvent('contextmenu', {bubbles:true, cancelable:true, button:2, clientX: rect.left + 30, clientY: rect.top + 12}));
    })()`);
  const menuLabels = `[...document.querySelectorAll('.ssh-files-menu button')].map(button => button.textContent)`;
  const menuItem = (label) =>
    evaluate(
      `[...document.querySelectorAll('.ssh-files-menu button')].find(button => button.textContent === ${JSON.stringify(label)}).click()`,
    );
  // Every directory load fades the rows in (files-panel `load` -> motion.reveal),
  // so the reveal has to settle first or the opacity below measures that
  // animation instead of the menu.
  await until(
    "the directory reveal settles",
    `Number(getComputedStyle(document.querySelector('.ssh-file-row')).opacity) === 1`,
  );
  await check(
    "right-clicking a row opens the file menu instead of the browser's",
    `!${await rightClick('.ssh-file-row[data-kind="directory"]')} && !document.querySelector('.ssh-files-menu').hidden`,
  );
  await check(
    "the row menu offers the entries a desktop file manager would",
    `['打开目录','在终端中进入','下载','重命名','详情','删除','复制路径','复制文件名','刷新'].every(label => ${menuLabels}.includes(label))`,
  );
  // Rows carry `data-ssh-reveal`, so opening a menu must not start a reveal of
  // its own and leave the list fading behind it.
  evidence.fileMenuPaint = await evaluate(
    `(() => {
      const row = document.querySelector('.ssh-file-row');
      const name = getComputedStyle(row.querySelector('.ssh-file-name')).color;
      return { rowOpacity: getComputedStyle(row).opacity, nameColor: name, surfaceColor: getComputedStyle(document.querySelector('.ssh-terminal')).color, rowRunning: row.getAnimations().filter(animation => animation.playState === 'running').length };
    })()`,
  );
  const paint = evidence.fileMenuPaint;
  await check(
    "opening the menu neither dims nor re-animates the list behind it",
    `${Number(paint.rowOpacity) === 1 && paint.rowRunning === 0 && paint.nameColor === paint.surfaceColor}`,
  );
  await shot("workspace-files-menu");
  const clipboardWrites = await evaluate(
    `__deckFixture.clipboard.writes.length`,
  );
  await menuItem("复制路径");
  await until(
    "copying a path writes the remote path to the clipboard bridge",
    `__deckFixture.clipboard.writes.length === ${clipboardWrites + 1} && __deckFixture.clipboard.text === document.querySelector('.ssh-files-path').value + '/' + document.querySelector('.ssh-file-row[data-kind="directory"] .ssh-file-name').textContent`,
  );
  await check(
    "acting on a menu entry closes it",
    `document.querySelector('.ssh-files-menu').hidden`,
  );
  // A file has no directory to enter, so that entry must not be offered.
  await rightClick('.ssh-file-row:not([data-kind="directory"])');
  await check(
    "a file row is not offered the terminal entry",
    `!${menuLabels}.includes('在终端中进入') && ${menuLabels}.includes('打开')`,
  );
  await key("Escape", "Escape", 27);
  await check(
    "Escape closes the file menu and returns focus to the list",
    `document.querySelector('.ssh-files-menu').hidden && document.activeElement === document.querySelector('.ssh-files-list')`,
  );
  await evaluate(`(() => {
    const list = document.querySelector('.ssh-files-list');
    const rect = list.getBoundingClientRect();
    list.dispatchEvent(new MouseEvent('contextmenu', {bubbles:true, cancelable:true, button:2, clientX: rect.left + 40, clientY: rect.bottom - 24}));
  })()`);
  await check(
    "right-clicking empty space offers the directory-level actions",
    `${menuLabels}.includes('新建目录') && ${menuLabels}.includes('上传文件') && ${menuLabels}.includes('刷新') && !${menuLabels}.includes('打开')`,
  );
  await evaluate(
    `document.querySelector('.ssh-files-list').dispatchEvent(new MouseEvent('click', {bubbles:true}))`,
  );
  await rightClick('.ssh-file-row[data-kind="directory"]');
  const terminalWrites = await evaluate(`__deckFixture.writes.length`);
  await menuItem("在终端中进入");
  await until(
    "entering a directory from the menu types cd into the live session",
    `__deckFixture.writes.length === ${terminalWrites + 1} && __deckFixture.writes.at(-1) === "cd '" + document.querySelector('.ssh-files-path').value + '/' + document.querySelector('.ssh-file-row[data-kind="directory"] .ssh-file-name').textContent + "'" + String.fromCharCode(13)`,
  );
  await until(
    "the terminal is brought forward with the command",
    `document.querySelector('.ssh-terminal').dataset.workspacePage === 'terminal'`,
  );
  await tab("files");
  await until(
    "the files page is showing again",
    `document.querySelector('.ssh-terminal').dataset.workspacePage === 'files'`,
  );
  // --- host grouping, driven through the real controls ---
  // The store is covered by unit tests; what those cannot see is the wiring
  // between a checkbox and the store, which is where a `name`/data mismatch hid.
  await evaluate(`rhineSshUi.closeTerminal()`);
  await until("terminal folded for the overview", `!rhineSshUi.isOpen && !document.querySelector('.model-viewer').hidden`);
  await evaluate(`rhineSshUi.openHosts()`);
  await until(
    "host overview opens",
    `document.querySelector('.ssh-overview')?.dataset.transition === 'open'`,
  );
  await evaluate(
    `document.querySelector('[data-overview-page="hosts"]').click()`,
  );
  await until(
    "host page and its group chips",
    `!!document.querySelector('.ssh-overview-groups button')`,
  );
  await check(
    "the host page offers a way to create a group",
    `[...document.querySelectorAll('.ssh-overview-groups button')].some(button => button.dataset.overviewAction === 'group-create')`,
  );
  await evaluate(
    `document.querySelector('[data-overview-action="group-create"]').click()`,
  );
  await until(
    "creating a group opens its name for editing",
    `!!document.querySelector('.ssh-overview-group-edit input')`,
  );
  await evaluate(`(() => {
    const input = document.querySelector('.ssh-overview-group-edit input');
    input.value = '训练集群';
    input.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true, cancelable:true}));
  })()`);
  await until(
    "the new group is named",
    `[...document.querySelectorAll('.ssh-overview-groups button[data-group-name]')].some(button => button.textContent === '训练集群')`,
  );
  // Group a real host through its editor, the way a user does.
  await evaluate(
    `document.querySelector('.ssh-overview-host [data-overview-action="edit"]').click()`,
  );
  await until(
    "host editor offers its groups",
    `!!document.querySelector('.ssh-host-group-choices input[data-group-member]')`,
  );
  await check(
    "an existing host is offered the groups it can join",
    `document.querySelectorAll('.ssh-host-group-choices input[data-group-member]').length === 1`,
  );
  await evaluate(`(() => {
    const box = document.querySelector('.ssh-host-group-choices input[data-group-member]');
    box.checked = true;
    box.dispatchEvent(new Event('change', {bubbles:true}));
  })()`);
  await check(
    "ticking a group stores the membership",
    `JSON.parse(localStorage.getItem('rhine.ssh.host-groups')).groups[0].aliases.length === 1`,
  );
  // A group created after this editor was last open still has to be offered:
  // editing the same host again repeats the route, so the list cannot be drawn
  // only when the route changes.
  await click('.ssh-host-editor [data-action="back"]');
  await until(
    "editor closed back to the host page",
    `!document.querySelector('.ssh-host-editor')?.isConnected`,
  );
  await evaluate(
    `document.querySelector('[data-overview-action="group-create"]').click()`,
  );
  await until(
    "a second group opens for naming",
    `!!document.querySelector('.ssh-overview-group-edit input')`,
  );
  await evaluate(`(() => {
    const input = document.querySelector('.ssh-overview-group-edit input');
    input.value = '归档机群';
    input.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true, cancelable:true}));
  })()`);
  await until(
    "the second group is named",
    `[...document.querySelectorAll('.ssh-overview-groups button[data-group-name]')].some(button => button.textContent === '归档机群')`,
  );
  await evaluate(`(() => {
    const alias = JSON.parse(localStorage.getItem('rhine.ssh.host-groups')).groups[0].aliases[0];
    document.querySelector('.ssh-overview-host[data-host-alias="' + alias + '"] [data-overview-action="edit"]').click();
  })()`);
  await until(
    "reopening the same host offers the group created since",
    `document.querySelectorAll('.ssh-host-group-choices input[data-group-member]').length === 2`,
  );
  await check(
    "the stored membership is still ticked after the redraw",
    `document.querySelector('.ssh-host-group-choices input[data-group-member]').checked`,
  );
  await shot("workspace-host-groups");
  await evaluate(`rhineSshUi.closeHosts()`);
  // Back to the session this suite has been driving all along.
  await evaluate(`rhineSshUi.connectHost('review-host')`);
  await enterInspection({ evaluate, until });
  await until(
    "session reopened after grouping",
    `rhineSshUi.isOpen && rhineSshUi.hasFocus`,
  );
  await tab("files");
  await until(
    "files page after grouping",
    `document.querySelector('.ssh-terminal').dataset.workspacePage === 'files'`,
  );
  await field(".ssh-files-path", "/home/operator/models");
  await evaluate(
    `document.querySelector('.ssh-files-path-form').requestSubmit()`,
  );
  await until(
    "return to child for keyboard navigation",
    `document.querySelector('.ssh-files-path').value === '/home/operator/models' && document.querySelector('.ssh-file-name').textContent === 'weights.safetensors'`,
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
  // A surface that owns the screen makes everything below it inert. If it is
  // then dismissed by an exit whose animation never finishes, the stack keeps it
  // on top forever and the deck below looks alive but answers nothing — so the
  // hand back has to happen even when the animation is cancelled.
  await click(".ssh-terminal-search-all");
  await until(
    "quick search takes the screen",
    `!!document.querySelector('.ssh-quick-search:not([hidden])') && document.querySelector('.ssh-terminal').inert`,
  );
  await key("Escape", "Escape", 27);
  await evaluate(
    `document.querySelector('.ssh-quick-search')?.getAnimations().forEach(animation => animation.cancel())`,
  );
  await until(
    "a cancelled exit still hands the screen back",
    `document.querySelector('.ssh-quick-search')?.hidden === true && !document.querySelector('.ssh-terminal').inert`,
  );
  await field(".ssh-files-filter input", "train.py");
  await until(
    "text file row visible",
    `document.querySelector('.ssh-file-name')?.textContent === 'train.py'`,
  );
  await evaluate(
    `document.querySelector('.ssh-file-row').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`,
  );
  await until(
    "text editor reads the file",
    `document.querySelector('.ssh-editor-path')?.textContent === '/home/operator/train.py' && document.querySelector('.ssh-editor-status')?.textContent === '文件已读取'`,
  );
  const reachable = (selector) =>
    `(() => { const button = document.querySelector(${JSON.stringify(selector)});
      if (!button) return false;
      const box = button.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return !button.disabled && !button.closest('.ssh-text-editor').inert &&
        Boolean(hit) && (hit === button || button.contains(hit)); })()`;
  await check(
    "the editor's close button is clickable",
    reachable('.ssh-text-editor [data-editor="close"]'),
  );
  await check(
    "the editor's save button is clickable",
    reachable('.ssh-text-editor [data-editor="save"]'),
  );
  await check(
    "the editor takes the whole working area",
    `(() => { const surface = document.querySelector('.ssh-text-editor');
      const box = surface.getBoundingClientRect();
      return box.width > innerWidth * 0.9 && box.height > innerHeight * 0.9; })()`,
  );
  await shot("workspace-text-editor");
  await click('.ssh-text-editor [data-editor="save"]');
  await until(
    "saving answers at once",
    `document.querySelector('.ssh-editor-status')?.textContent === '正在写入远端…' || document.querySelector('.ssh-editor-status')?.dataset.state === 'saved'`,
  );
  await until(
    "the write reports back",
    `document.querySelector('.ssh-editor-status')?.dataset.state === 'saved'`,
  );
  await check(
    "saving sends the file it opened",
    `__workspaceFixture.calls.filter(call => call.method === 'writeText').length === 1 &&
      __workspaceFixture.calls.filter(call => call.method === 'writeText').at(-1).path === '/home/operator/train.py'`,
  );
  await click('.ssh-text-editor [data-editor="close"]');
  await until(
    "the editor hands the deck back",
    `document.querySelector('.ssh-text-editor')?.hidden === true && !document.querySelector('.ssh-terminal')?.inert`,
  );
  await field(".ssh-files-filter input", "");
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
  await enterInspection({ evaluate, until });
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
  // A driver reset must not flood the console or leave a dead scene behind:
  // the renderer holds frames while the context is gone and repaints after.
  // The extension handle is captured before losing: on a lost context a fresh
  // getExtension may return null, which would silently skip restoreContext.
  await evaluate(
    `(() => { const canvas = document.querySelector('#three-scene canvas'); window.__loseContext = canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context'); window.__loseContext?.loseContext(); })()`,
  );
  await sleep(400);
  await check(
    "losing the WebGL context suspends rendering and reports the state",
    `rhine.stats().contextLost === true`,
  );
  await evaluate(`window.__loseContext?.restoreContext()`);
  await until("context restored", `rhine.stats().contextLost === false`);
  // Return to a visible archive before checking GPU work: the SSH surface
  // can cover/park the scene. Poll the 1 Hz stats after leaving that surface.
  await evaluate(`rhineSshUi.closeTerminal(); rhine.archive()`);
  await until(
    "archive visible after context restoration",
    `!rhineSshUi.isOpen && rhine.stats().mode === 'archive'`,
  );
  await until(
    "restored context repaints the archive",
    `rhine.stats().contextLost === false && rhine.stats().drawCalls > 0`,
  );
  await check(
    "restored context renders the visible archive",
    `rhine.stats().contextLost === false && rhine.stats().drawCalls > 0`,
  );
  await shot("workspace-context-restored");
}
