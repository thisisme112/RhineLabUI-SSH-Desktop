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
    `getComputedStyle(document.querySelector('.xterm-rows')).fontSize === '18px' && localStorage.getItem('rhine-ssh-terminal-font-size') === '18'`,
  );
  await evaluate(
    `for (let i = 0; i < 12; i++) document.querySelector('[data-terminal-tool="larger"]').click()`,
  );
  await check(
    "font upper bound is 24",
    `document.querySelector('[data-terminal-tool="font"]').textContent === '24' && document.querySelector('[data-terminal-tool="larger"]').disabled`,
  );
  await evaluate(
    `for (let i = 0; i < 20; i++) document.querySelector('[data-terminal-tool="smaller"]').click()`,
  );
  await check(
    "font lower bound is 12",
    `document.querySelector('[data-terminal-tool="font"]').textContent === '12' && document.querySelector('[data-terminal-tool="smaller"]').disabled`,
  );
  await click("font");
  await check(
    "current size restores the default when clicked",
    `document.querySelector('[data-terminal-tool="font"]').textContent === '16'`,
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
  await until("before reconnect", `rhine.stats().sessionDeck.progress === 0`);
  await evaluate(`rhineSshUi.connectHost('review-host')`);
  await until("new authentication", `rhineSshUi.promptKind === 'password'`);
  await check(
    "reconnection clears the previous search query",
    `document.querySelector('${query}').value === ''`,
  );
  await evaluate(
    `rhineSshUi.answerSecret('new-session'); __deckFixture.interactive()`,
  );
  await until(
    "new session ready",
    `rhineSshUi.hasFocus && rhine.stats().sessionDeck.ready`,
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
    `document.querySelectorAll('.ssh-terminal .xterm').length === 1 && getComputedStyle(document.querySelector('.xterm-rows')).fontSize === '18px'`,
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
    `getComputedStyle(document.querySelector('.xterm-rows')).fontSize === '18px'`,
  );
  await key("F", "KeyF", 70, 10);
  await search("中文");
  await until("dark matches", matches(1));
  await check(
    "reduced motion shows footer controls immediately without animations",
    `document.querySelector('${panel}').dataset.transition === 'open' && document.querySelector('${panel}').getAnimations({subtree:true}).length === 0`,
  );
  await check(
    "tools inherit the terminal dark theme",
    `document.querySelector('.ssh-terminal').dataset.dark === 'true' && getComputedStyle(document.querySelector('${query}')).color === 'rgb(236, 231, 221)'`,
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
}
