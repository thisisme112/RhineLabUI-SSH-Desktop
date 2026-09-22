import { enterInspection } from './enter-inspection.mjs';
/** Real desktop UI/xterm in the isolated browser fixture, no OS clipboard use. */
export async function checkTerminalTools({
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
  const query = ".ssh-terminal-query";
  const count = ".ssh-terminal-search-count";
  const panel = ".ssh-terminal-tools";
  const textarea = ".ssh-terminal .xterm-helper-textarea";
  const click = (action) =>
    evaluate(
      `(() => { const b = document.querySelector('[data-terminal-tool="${action}"]'); b.focus(); b.click(); })()`,
    );
  const focusTerminal = () =>
    evaluate(`document.querySelector('${textarea}').focus()`);
  const search = async (text) => {
    await evaluate(`document.querySelector('${query}').focus()`);
    await key("a", "KeyA", 65, 2);
    await send("Input.insertText", { text });
  };
  const matches = (n) =>
    `document.querySelector('${count}').textContent.endsWith(' / ${n}')`;
  const output = (text) =>
    evaluate(`__deckFixture.output(${JSON.stringify(text)})`);

  await check(
    "tools start folded and never read the clipboard automatically",
    `document.querySelector('${panel}').hidden && document.querySelector('${panel}').inert && __deckFixture.clipboard.reads === 0`,
  );
  await evaluate(
    `window.__toolsSizes = __deckFixture.sizes.length; window.__toolsWrites = __deckFixture.writes.length`,
  );
  await key("F", "KeyF", 70, 10);
  await check(
    "search shortcut unfolds the existing footer and focuses its input",
    `document.activeElement === document.querySelector('${query}') && !document.querySelector('${panel}').hidden && document.querySelector('.ssh-terminal-foot').contains(document.querySelector('${panel}'))`,
  );
  await check(
    "footer opening uses the shared page animation",
    `Number(document.querySelector('${panel}').dataset.motionCount) > 0 && document.querySelector('${panel}').getAnimations({subtree:true}).length > 0`,
  );
  await until(
    "footer settled",
    `document.querySelector('${panel}').dataset.motion === 'settled'`,
  );
  await check(
    "footer layout resizes the PTY once instead of on every frame",
    `__deckFixture.sizes.length > __toolsSizes && __deckFixture.sizes.length - __toolsSizes <= 2`,
  );
  const cols = await evaluate(`__deckFixture.sizes.at(-1)[0]`);
  await output(
    "\x1b[2J\x1b[3J\x1b[HSEARCH_FIXTURE\r\nAlpha alpha ALPHA\r\n中文匹配 · 中文匹配\r\n" +
      ".".repeat(cols - 4) +
      "跨行needle\r\n" +
      Array.from({ length: 60 }, (_, i) => `output line ${i}`).join("\r\n") +
      "\r\noperator@review-host:~$ ",
  );
  await search("alpha");
  await until("case-insensitive matches", matches(3));
  await until(
    "search result rendered",
    `document.querySelector('.xterm-rows').textContent.includes('Alpha alpha ALPHA')`,
  );
  await check(
    "search reads real scrollback and scrolls back to the result",
    `document.querySelector('.xterm-rows').textContent.includes('Alpha alpha ALPHA')`,
  );
  await evaluate(
    `window.__firstMatch = document.querySelector('${count}').textContent`,
  );
  await key("Enter", "Enter", 13);
  await check(
    "Enter advances to the next match",
    `document.querySelector('${count}').textContent !== __firstMatch`,
  );
  await key("Enter", "Enter", 13, 8);
  await check(
    "Shift+Enter returns to the previous match",
    `document.querySelector('${count}').textContent === __firstMatch`,
  );
  await click("case");
  await until("case-sensitive match", matches(1));
  await check(
    "case option filters matches",
    `document.querySelector('[data-terminal-tool="case"]').getAttribute('aria-pressed') === 'true'`,
  );
  await search("中文匹配");
  await until("wide character matches", matches(2));
  await check(
    "search selection does not automatically overwrite the clipboard",
    `__deckFixture.clipboard.writes.length === 0`,
  );
  await focusTerminal();
  await key("c", "KeyC", 67, 2);
  await until("Ctrl+C copied selection", `__deckFixture.clipboard.text === '中文匹配'`);
  await check(
    "Ctrl+C with a selection copies through the desktop bridge without interrupting SSH",
    `__deckFixture.writes.length === __toolsWrites`,
  );
  await click("copy");
  await until(
    "copied selection",
    `__deckFixture.clipboard.text === '中文匹配'`,
  );
  await check(
    "copy transfers the actual xterm selection without reading the clipboard",
    `__deckFixture.clipboard.writes.at(-1) === '中文匹配' && __deckFixture.clipboard.reads === 0`,
  );
  await shot("tools-light-search");
  await output("\r\n中文匹配\r\n");
  await until("new output updates search", matches(3));
  await check(
    "live output updates the result count without replacing search input",
    `document.querySelector('${query}').value === '中文匹配' && document.querySelector('${count}').textContent.endsWith(' / 3')`,
  );
  await search("跨行needle");
  await until("wrapped wide text", matches(1));
  await click("copy");
  await until(
    "wrapped selection copied",
    `__deckFixture.clipboard.text === '跨行needle'`,
  );
  await check(
    "search and copy preserve a word across a wrapped terminal line",
    `__deckFixture.clipboard.writes.at(-1) === '跨行needle'`,
  );
  await search("missing-pattern");
  await until(
    "no match",
    `document.querySelector('${count}').textContent === '没有匹配结果'`,
  );
  await check(
    "no results disables navigation",
    `document.querySelector('[data-terminal-tool="next"]').disabled && document.querySelector('[data-terminal-tool="previous"]').disabled`,
  );

  await output("\x1b[?1049h\x1b[2J\x1b[HALT_SEARCH_ONLY");
  await search("ALT_SEARCH_ONLY");
  await until("alternate buffer search", matches(1));
  await search("SEARCH_FIXTURE");
  await until(
    "normal buffer excluded in full screen",
    `document.querySelector('${count}').textContent === '没有匹配结果'`,
  );
  await output("\x1b[?1049l");
  await until("normal buffer restored in search", matches(1));
  await check("search follows the active full-screen buffer", matches(1));

  await evaluate(`document.querySelector('${query}').focus()`);
  await key("Escape", "Escape", 27);
  await check(
    "Escape from search folds only tools and immediately restores terminal input",
    `rhineSshUi.isOpen && document.querySelector('${panel}').inert && document.activeElement === document.querySelector('${textarea}')`,
  );
  await sleep(40);
  await key("F", "KeyF", 70, 10);
  await until(
    "interrupted tools reopened",
    `document.querySelector('${panel}').dataset.transition === 'open'`,
  );
  await check(
    "reopening during exit keeps one terminal and the current query",
    `document.querySelectorAll('.ssh-terminal .xterm').length === 1 && document.querySelector('${query}').value === 'SEARCH_FIXTURE' && !document.querySelector('${panel}').inert`,
  );
  await key("P", "KeyP", 80, 10);
  await until("tools folded", `document.querySelector('${panel}').hidden`);
  await check(
    "tool shortcuts and search navigation never send input to the remote",
    `__deckFixture.writes.length === __toolsWrites`,
  );
  await key("Escape", "Escape", 27);
  await key("Tab", "Tab", 9);
  await key("ArrowUp", "ArrowUp", 38);
  await key("c", "KeyC", 67, 2);
  await key("f", "KeyF", 70, 2);
  await check(
    "ordinary Escape Tab arrows Ctrl+C and Ctrl+F still reach the remote",
    `['\x1b','\t','\x1b[A','\x03','\x06'].every(value => __deckFixture.writes.includes(value)) && rhineSshUi.isOpen`,
  );

  await output("\x1b[?1049h\x1b[2J\x1b[HAUTO_COPY_MOUSE");
  await until("mouse selection output", `document.querySelector('.xterm-rows').textContent.includes('AUTO_COPY_MOUSE')`);
  const cell = await evaluate(`(() => {
    const row = document.querySelector('.xterm-rows > div').getBoundingClientRect();
    return { x: row.left, y: row.top + row.height / 2, width: row.width / __deckFixture.sizes.at(-1)[0] };
  })()`);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: cell.x + cell.width * .2, y: cell.y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: cell.x + cell.width * 15, y: cell.y, button: "left", buttons: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: cell.x + cell.width * 15, y: cell.y, button: "left", clickCount: 1 });
  await until("mouse selection copied automatically", `__deckFixture.clipboard.text === 'AUTO_COPY_MOUSE'`);
  await check("mouse selection writes the desktop clipboard", `__deckFixture.clipboard.writes.at(-1) === 'AUTO_COPY_MOUSE'`);
  await output("\x1b[?1049l");

  await output("\x1b[?2004h\r\nBRACKETED_PASTE_READY\r\n");
  await until(
    "paste mode parsed",
    `document.querySelector('.xterm-rows').textContent.includes('BRACKETED_PASTE_READY')`,
  );
  const pasted = "echo one\nprintf 二";
  await evaluate(`__deckFixture.clipboard.text = ${JSON.stringify(pasted)}`);
  await key("V", "KeyV", 86, 10);
  await until(
    "bracketed paste",
    `__deckFixture.writes.includes(${JSON.stringify("\x1b[200~echo one\rprintf 二\x1b[201~")})`,
  );
  await check(
    "paste uses bracketed mode and adds no execution newline",
    `__deckFixture.writes.at(-1) === ${JSON.stringify("\x1b[200~echo one\rprintf 二\x1b[201~")} && document.activeElement === document.querySelector('${textarea}')`,
  );
  for (const [label, value, code, keyCode, modifiers] of [
    ["Ctrl+V", "v", "KeyV", 86, 2],
    ["Shift+Insert", "Insert", "Insert", 45, 8],
    ["Meta+V", "v", "KeyV", 86, 4],
  ]) {
    await evaluate(`window.__shortcutWrites = __deckFixture.writes.length; window.__shortcutReads = __deckFixture.clipboard.reads; __deckFixture.clipboard.text = ${JSON.stringify(label)}`);
    await key(value, code, keyCode, modifiers);
    await until(label + " paste", `__deckFixture.writes.length > __shortcutWrites`);
    await check(label + " pastes exactly once through the clipboard bridge",
      `__deckFixture.writes.length === __shortcutWrites + 1 && __deckFixture.clipboard.reads === __shortcutReads + 1 && __deckFixture.writes.at(-1) === ${JSON.stringify("\x1b[200~" + label + "\x1b[201~")}`);
  }
  await evaluate(
    `window.__pasteWrites = __deckFixture.writes.length; __deckFixture.clipboard.text = ''`,
  );
  await key("V", "KeyV", 86, 10);
  await until(
    "empty clipboard feedback",
    `document.querySelector('.ssh-terminal-tool-feedback').textContent.includes('没有文本')`,
  );
  await check(
    "empty clipboard sends nothing",
    `__deckFixture.writes.length === __pasteWrites`,
  );
  await evaluate(`__deckFixture.clipboard.error = '测试剪贴板不可用'`);
  await key("V", "KeyV", 86, 10);
  await until(
    "clipboard error",
    `document.querySelector('.ssh-terminal-tool-feedback').textContent === '测试剪贴板不可用'`,
  );
  await check(
    "clipboard failures stay in the footer and send nothing",
    `__deckFixture.writes.length === __pasteWrites`,
  );
  await evaluate(
    `__deckFixture.clipboard.error = ''; __deckFixture.clipboard.text = 'button_paste'`,
  );
  await key("P", "KeyP", 80, 10);
  await click("paste");
  await until(
    "paste button",
    `__deckFixture.writes.at(-1) === '\x1b[200~button_paste\x1b[201~'`,
  );
  await check(
    "paste button works and returns keyboard focus to the terminal",
    `document.activeElement === document.querySelector('${textarea}')`,
  );
  await search("中文匹配");
  await until("copy shortcut selection", matches(3));
  await focusTerminal();
  await key("C", "KeyC", 67, 10);
  evidence.copyShortcut = await evaluate(
    `({clipboard:__deckFixture.clipboard.text,feedback:document.querySelector('.ssh-terminal-tool-feedback').textContent,count:document.querySelector('.ssh-terminal-search-count').textContent,sizes:__deckFixture.sizes.slice(-5)})`,
  );
  await until("copy shortcut", `__deckFixture.clipboard.text === '中文匹配'`);

  await evaluate(
    `window.__focusPasteWrites = __deckFixture.writes.length; __deckFixture.clipboard.text = 'STALE_FOCUS'; __deckFixture.clipboard.delay = 350`,
  );
  await key("V", "KeyV", 86, 10);
  await evaluate(`document.querySelector('${query}').focus()`);
  await until("focus read finished", `__deckFixture.clipboard.pending === 0`);
  await check(
    "moving focus while clipboard reads cancels that paste",
    `__deckFixture.writes.length === __focusPasteWrites`,
  );
  await focusTerminal();
  await key("V", "KeyV", 86, 10);
  await evaluate(`rhineSshUi.closeTerminal()`);
  await until(
    "collapse read finished",
    `__deckFixture.clipboard.pending === 0 && !rhineSshUi.isOpen`,
  );
  await check(
    "collapsing while clipboard reads cancels that paste",
    `__deckFixture.writes.length === __focusPasteWrites`,
  );
  await evaluate(`rhineSshUi.openTerminal()`);
  await until(
    "terminal reopened",
    `rhineSshUi.hasFocus && rhine.stats().sessionDeck.ready`,
  );
  await check(
    "collapse leaves tools folded and clears search decorations",
    `document.querySelector('${panel}').hidden && document.querySelectorAll('.xterm-decoration').length === 0`,
  );

  await key("F", "KeyF", 70, 10);
  await until(
    "resized before font",
    `document.querySelector('${panel}').dataset.transition === 'open'`,
  );
  await evaluate(`window.__fontCols = __deckFixture.sizes.at(-1)[0]`);
  await click("larger");
  await click("larger");
  await until(
    "font changes resize terminal",
    `__deckFixture.sizes.at(-1)[0] < __fontCols`,
  );
  await check(
    "font controls affect terminal text and its PTY dimensions",
    `getComputedStyle(document.querySelector('.xterm-rows')).fontSize === '15px' && localStorage.getItem('rhine.ssh.terminal-appearance') !== null && JSON.parse(localStorage.getItem('rhine.ssh.terminal-appearance')).size === 15`,
  );
  await evaluate(
    `for (let i = 0; i < 20; i++) document.querySelector('[data-terminal-tool="larger"]').click()`,
  );
  await check(
    "font upper bound is 32",
    `document.querySelector('[data-terminal-tool="font"]').textContent === '32' && document.querySelector('[data-terminal-tool="larger"]').disabled`,
  );
  await evaluate(
    `for (let i = 0; i < 40; i++) document.querySelector('[data-terminal-tool="smaller"]').click()`,
  );
  await check(
    "font lower bound is 8",
    `document.querySelector('[data-terminal-tool="font"]').textContent === '8' && document.querySelector('[data-terminal-tool="smaller"]').disabled`,
  );
  await click("font");
  await check(
    "current size restores the default when clicked",
    `document.querySelector('[data-terminal-tool="font"]').textContent === '13'`,
  );
  await click("larger");
  await click("larger");

  await focusTerminal();
  await evaluate(
    `window.__generationPasteWrites = __deckFixture.writes.length; __deckFixture.clipboard.text = 'STALE_GENERATION'; __deckFixture.clipboard.delay = 6500`,
  );
  await key("V", "KeyV", 86, 10);
  await evaluate(`__deckFixture.end(0)`);
  await check(
    "disconnected output can be searched and copied but cannot accept paste",
    `!document.querySelector('.ssh-terminal-shortcut').hidden && document.querySelector('[data-terminal-tool="paste"]').disabled`,
  );
  await search("中文匹配");
  await until("search disconnected buffer", matches(3));
  await evaluate(`rhineSshUi.closeTerminal()`);
  await until("before reconnect", `!rhineSshUi.isOpen && rhine.stats().sessionDeck.progress === 0`);
  await evaluate(`rhineSshUi.connectHost('review-host')`);
  await enterInspection({ evaluate, until });
  await until("new authentication", `rhineSshUi.promptKind === 'password'`);
  await until(
    "terminal remounts only after the new session is ready",
    `rhineSshUi.promptKind === 'password' && document.querySelectorAll('.ssh-terminal .xterm').length === 0`,
  );
  await evaluate(
    `rhineSshUi.answerSecret('new-session'); __deckFixture.interactive()`,
  );
  await until(
    "new session ready",
    `rhineSshUi.hasFocus && rhine.stats().sessionDeck.ready`,
  );
  await check(
    "reconnection clears the previous search query",
    `document.querySelectorAll('.ssh-terminal .xterm').length === 1 && document.querySelector('${query}').value === ''`,
  );
  await until(
    "old clipboard read finished",
    `__deckFixture.clipboard.pending === 0`,
  );
  await check(
    "an old clipboard read cannot send text to a reconnected session",
    `__deckFixture.writes.length === __generationPasteWrites && !rhineSsh.output.includes('STALE_GENERATION')`,
  );
  await check(
    "reconnection preserves font preference and a single fresh terminal",
    `document.querySelectorAll('.ssh-terminal .xterm').length === 1 && getComputedStyle(document.querySelector('.xterm-rows')).fontSize === '15px'`,
  );
  await evaluate(
    `__deckFixture.end(0); localStorage.setItem('rhine-settings', JSON.stringify({...JSON.parse(localStorage.getItem('rhine-settings')),colorTheme:'dark',reduced:true}))`,
  );
  await send("Page.reload");
  await until(
    "reduced dark scene",
    `window.rhine?.stats().ready && !!window.rhineSshUi`,
  );
  await evaluate(`rhineSshUi.connectHost('review-host')`);
  await enterInspection({ evaluate, until });
  await until(
    "reduced auth",
    `rhineSshUi.promptKind === 'password' && rhine.stats().sessionDeck.available`,
  );
  await evaluate(
    `rhineSshUi.answerSecret('dark-tools'); __deckFixture.interactive()`,
  );
  await until(
    "reduced operation",
    `rhineSshUi.hasFocus && rhine.stats().sessionDeck.ready`,
  );
  await check(
    "font preference survives an application reload",
    `getComputedStyle(document.querySelector('.xterm-rows')).fontSize === '15px'`,
  );
  await key("F", "KeyF", 70, 10);
  await search("中文");
  await until("dark matches", matches(1));
  await check(
    "reduced motion shows footer controls immediately without animations",
    `document.querySelector('${panel}').dataset.transition === 'open' && document.querySelector('${panel}').getAnimations({subtree:true}).length === 0`,
  );
  evidence.darkTools = await evaluate(
    `({dark:document.querySelector('.ssh-terminal').dataset.dark, color:getComputedStyle(document.querySelector('${query}')).color, terminalFg:getComputedStyle(document.querySelector('.ssh-terminal')).getPropertyValue('--terminal-fg').trim(), colorTheme:JSON.parse(localStorage.getItem('rhine-settings')||'{}').colorTheme})`,
  );
  await check(
    "terminal surface follows the dark color theme",
    `document.querySelector('.ssh-terminal').dataset.dark === 'true'`,
  );
  await check(
    "tools inherit the terminal dark theme",
    `getComputedStyle(document.querySelector('${query}')).color === 'rgb(226, 233, 231)'`,
  );
  await check(
    "dark terminal error text retains readable contrast",
    `(() => {
      const root = document.querySelector('.ssh-terminal');
      const rgb = value => value.match(/[\\d.]+/g).slice(0,3).map(Number).map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; });
      const luma = value => rgb(value).reduce((sum,v,i) => sum + v * [.2126,.7152,.0722][i], 0);
      const fg = luma(getComputedStyle(root.querySelector('.ssh-terminal-exit')).color);
      const bg = luma(getComputedStyle(root).backgroundColor);
      return (Math.max(fg,bg)+.05)/(Math.min(fg,bg)+.05) >= 4.5;
    })()`,
  );
  await shot("tools-dark-search");
  for (const [width, height] of [
    [1024, 640],
    [800, 600],
  ]) {
    await send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(600);
    await check(
      `footer controls fit ${width}x${height}`,
      `(() => {
      const root = document.querySelector('.ssh-terminal').getBoundingClientRect();
      const controls = document.querySelector('${panel}');
      return controls.scrollWidth <= controls.clientWidth + 1 && [...controls.querySelectorAll('button,input')].every(node => {
        const r = node.getBoundingClientRect(); return r.width > 0 && r.left >= root.left - 1 && r.right <= root.right + 1 && r.bottom <= root.bottom + 1;
      }) && __deckFixture.sizes.at(-1)[1] >= 6;
    })()`,
    );
    await shot(`tools-dark-${width}x${height}`);
  }
  evidence.tools = await evaluate(
    `({fontSize:localStorage.getItem('rhine-ssh-terminal-font-size'), count:document.querySelector('${count}').textContent, sizes:__deckFixture.sizes, terminal:document.querySelector('.ssh-terminal').getBoundingClientRect().toJSON()})`,
  );
  await key("Escape", "Escape", 27);
  await check(
    "reduced motion folds tools immediately and restores remote input",
    `document.querySelector('${panel}').hidden && document.activeElement === document.querySelector('${textarea}')`,
  );
  await evaluate(`__deckFixture.end(0)`);
  await check(
    "volume input updates audio live but persists only on commit without unmuting",
    `(() => {
      const before = localStorage.getItem('rhine-settings');
      const sound = rhine.stats().audio.preferences.sound;
      const slider = document.createElement('input');
      slider.type = 'range'; slider.dataset.volume = 'soundVolume';
      document.body.append(slider);
      try {
        slider.value = '37'; slider.dispatchEvent(new Event('input', {bubbles:true}));
        const live = rhine.stats().audio.preferences.soundVolume === .37 && localStorage.getItem('rhine-settings') === before;
        slider.dispatchEvent(new Event('change', {bubbles:true}));
        return live && JSON.parse(localStorage.getItem('rhine-settings')).soundVolume === .37 && rhine.stats().audio.preferences.sound === sound;
      } finally { slider.remove(); }
    })()`,
  );
  await check(
    "performance preference preserves the unblurred overview material",
    `(() => {
      const toggle = document.createElement('input');
      toggle.type = 'checkbox'; toggle.dataset.pref = 'superPerformance'; document.body.append(toggle);
      const glass = document.querySelector('.ssh-overview-glass');
      try {
        toggle.checked = true; toggle.dispatchEvent(new Event('change', {bubbles:true}));
        const reduced = getComputedStyle(glass).backdropFilter === 'none';
        toggle.checked = false; toggle.dispatchEvent(new Event('change', {bubbles:true}));
        return reduced && getComputedStyle(glass).backdropFilter === 'none' && !JSON.parse(localStorage.getItem('rhine-settings')).superPerformance;
      } finally { toggle.remove(); }
    })()`,
  );
  // --- palettes ---
  // The terminal panel is a full-window surface, so it must take its colours
  // from the same palette as the rest of the application rather than a set of
  // its own — otherwise the window caption and the bar under it disagree.
  const themeColours = `({paper:getComputedStyle(document.documentElement).getPropertyValue('--theme-paper').trim(), terminal:getComputedStyle(document.querySelector('.ssh-terminal')).backgroundColor})`;
  const beforePalette = await evaluate(themeColours);
  await check(
    "the terminal panel takes its background from the active palette",
    `${beforePalette.terminal === beforePalette.paper}`,
  );
  // The probe has to live inside the SSH surface: its scope installs a
  // capture-phase guard that swallows any event whose target is outside the
  // open surface, so a button on `document.body` never reaches the application.
  const pickPalette = (name) =>
    evaluate(`(() => {
      const button = document.createElement('button');
      button.dataset.colorPalette = ${JSON.stringify(name)};
      const host = document.querySelector('.ssh-terminal');
      host.append(button);
      try { button.click(); } finally { button.remove(); }
    })()`);
  await pickPalette("cool");
  // The preference is written synchronously but `paintTheme` runs on the next
  // animation frame, so a single read can land before the repaint.
  await until(
    "the new palette repaints",
    `getComputedStyle(document.documentElement).getPropertyValue('--theme-paper').trim() !== ${JSON.stringify(beforePalette.paper)}`,
  );
  const cooled = await evaluate(themeColours);
  evidence.palette = { before: beforePalette, after: cooled };
  await check(
    "choosing a palette recolours the application and its terminal together",
    `${cooled.paper !== beforePalette.paper && cooled.terminal === cooled.paper}`,
  );
  await check(
    "a palette choice is remembered",
    `JSON.parse(localStorage.getItem('rhine-settings')||'{}').palette === 'cool'`,
  );
  // Put it back so the run leaves the fixture profile as it found it.
  await pickPalette("warm");
  await evaluate(`rhine.settings()`);
  await until("settings panel opens", `!!document.querySelector('[data-color-palette]')`);
  await check(
    "the settings panel offers ten preview palettes with the current one marked",
    `(() => {
      const buttons = [...document.querySelectorAll('button[data-color-palette]')];
      const pressed = buttons.filter(button => button.getAttribute('aria-pressed') === 'true');
      return buttons.length === 10 && buttons.every(button => button.querySelector('.theme-sample')) && pressed.length === 1 && pressed[0].dataset.colorPalette === 'warm';
    })()`,
  );
  await shot("settings-palettes");
  await send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  for (const mode of ["dark", "light"]) {
    await evaluate(`document.querySelector('button[data-color-theme="${mode}"]').click()`);
    await sleep(300);
  for (const name of ["warm", "cool", "sand", "phosphor", "hologram", "amber", "nova", "cryo", "hazard", "voidwave"]) {
    await evaluate(`document.querySelector('button[data-color-palette="${name}"]').click()`);
    await sleep(450);
    await check(`${name}: ${mode} settings controls retain readable contrast`, `(() => {
      const luma = value => value.match(/[\\d.]+/g).slice(0, 3).map(Number).map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
      return [...document.querySelectorAll('.quality-settings select, .theme-choices button')].every(node => {
        const style = getComputedStyle(node), fg = luma(style.color), bg = luma(style.backgroundColor);
        return (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05) >= 4.5;
      });
    })()`);
    await check(`${name}: ${mode} secondary text and control boundaries meet contrast targets`, `(() => {
      const style=getComputedStyle(document.documentElement);
      const rgb=name=>style.getPropertyValue(name).match(/[\\d.]+/g).slice(0,3).map(Number);
      const luma=rgb=>rgb.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
      const ratio=(a,b)=>(Math.max(luma(a),luma(b))+.05)/(Math.min(luma(a),luma(b))+.05);
      return ['paper','panel','field','glass'].every(surface=>ratio(rgb('--theme-muted'),rgb('--theme-'+surface))>=4.5 && ratio(rgb('--ui-control-line'),rgb('--theme-'+surface))>=3 && ratio(rgb('--ui-focus'),rgb('--theme-'+surface))>=3);
    })()`);
    if (["hologram", "hazard", "voidwave"].includes(name)) await shot(`settings-${name}-${mode}`);
  }
  }
  await evaluate(`document.querySelector('[data-settings-section="terminal"]').click()`);
  await until('shared terminal settings', `!!document.querySelector('.ssh-workspace-settings:not([hidden])')`);
  for(const section of ['terminal','connection','security','data']) {
    await evaluate(`document.querySelector('.ssh-workspace-settings [data-settings-section="${section}"]').click()`);
    await check(`settings route ${section} shows only its own controls`, `[...document.querySelectorAll('.ssh-workspace-settings fieldset')].every(field=>field.hidden === (field.dataset.section !== '${section}'))`);
  }
  await shot('settings-data');
  await evaluate(`document.querySelector('.ssh-workspace-settings [data-settings-section="appearance"]').click()`);
  await until('appearance settings return', `!!document.querySelector('.settings-modal')`);
  await evaluate(`document.querySelector('[data-color-theme="dark"]').click()`); await sleep(300);
  await evaluate(`document.querySelector('[data-action="close-modal"]').click()`);
  await until("settings close button still works after choosing a theme", `!document.querySelector('.settings-modal')`);
  await check("theme selection does not swallow ordinary menu actions", `!document.querySelector('.settings-modal')`);
  await shot("terminal-voidwave");
}
