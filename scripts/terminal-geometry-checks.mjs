/** Exercise real pointer input on the built xterm, not synthetic DOM clicks.
 * SSH and clipboard data are the isolated fixture's, never the user's. */
export async function checkTerminalGeometry({
  evaluate,
  until,
  check,
  shot,
  key,
  send,
  sleep,
  evidence,
}) {
  const mouse = (type, point, extra = {}) =>
    send("Input.dispatchMouseEvent", {
      type,
      ...point,
      button: "left",
      clickCount: 1,
      ...extra,
    });
  const click = async (selector) => {
    const point = await evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      const r = node.getBoundingClientRect();
      if (!r.width || !r.height) throw new Error('Control is hidden: ' + ${JSON.stringify(selector)});
      const x = r.x + r.width / 2, y = r.y + r.height / 2;
      if (!node.contains(document.elementFromPoint(x, y))) throw new Error('Control hit target is offset: ' + ${JSON.stringify(selector)});
      return {x, y};
    })()`);
    await mouse("mousePressed", point);
    await mouse("mouseReleased", point);
  };
  const output = (text) =>
    evaluate(`__deckFixture.output(${JSON.stringify(text)})`);
  const tab = async (page) => {
    await click(`[data-workspace-page="${page}"]`);
    await until(
      "native page hit target",
      `document.querySelector('.ssh-terminal').dataset.workspacePage === '${page}'`,
    );
    await sleep(350);
    if (page === "terminal")
      await until(
        "terminal page motion is settled",
        `getComputedStyle(document.querySelector('.ssh-terminal-screen')).transform === 'none'`,
      );
  };
  const grid = () =>
    evaluate(`(() => {
    const r = document.querySelector('.xterm-screen').getBoundingClientRect();
    const [cols, rows] = __deckFixture.sizes.at(-1);
    return {left:r.left,top:r.top,cw:r.width/cols,ch:r.height/rows,cols,rows};
  })()`);
  evidence.geometry = [];
  await evaluate(`window.__geometryXterm = document.querySelector('.xterm')`);
  for (const [width, height, dpr] of [
    [1366, 768, 1],
    [1920, 1080, 1],
    [2560, 1440, 1],
    [1920, 1080, 1.25],
    [1600, 900, 1.5],
    [2560, 1440, 2],
    [3440, 1440, 1],
  ]) {
    const label = `${width}x${height} DPR ${dpr}`;
    await send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: dpr,
      mobile: false,
    });
    await sleep(850);
    await tab("terminal");
    const geometry = await evaluate(`(() => {
      const root = document.querySelector('.ssh-terminal'), r = root.getBoundingClientRect();
      const chain = [];
      for (let node = document.querySelector('.xterm-screen'); node; node = node.parentElement) {
        const s = getComputedStyle(node);
        chain.push({node:node.id || node.className || node.tagName,transform:s.transform,perspective:s.perspective,zoom:s.zoom,filter:s.filter});
      }
      return {width:innerWidth,height:innerHeight,dpr:devicePixelRatio,rect:[r.x,r.y,r.width,r.height],client:[root.clientWidth,root.clientHeight],font:getComputedStyle(document.querySelector('.xterm-rows')).fontSize,chain,cols:__deckFixture.sizes.at(-1)[0],rows:__deckFixture.sizes.at(-1)[1]};
    })()`);
    evidence.geometry.push(geometry);
    await check(
      `${label}: text and pointer geometry use unscaled viewport pixels`,
      String(
        geometry.chain.every(
          (s) =>
            s.transform === "none" &&
            s.perspective === "none" &&
            Number(s.zoom) === 1 &&
            s.filter === "none",
        ) &&
          geometry.rect[2] === geometry.client[0] &&
          geometry.rect[3] === geometry.client[1] &&
          geometry.font === "16px",
      ),
    );
    await check(
      `${label}: larger screen remains inside the window`,
      String(
        geometry.rect[0] >= 0 &&
          geometry.rect[1] >= 0 &&
          geometry.rect[0] + geometry.rect[2] <= width &&
          geometry.rect[1] + geometry.rect[3] <= height &&
          (geometry.rect[2] * geometry.rect[3]) / (width * height) >=
            (width / height > 2 ? 0.54 : 0.71),
      ),
    );
    await output(
      "\x1b[?1049h\x1b[2J\x1b[H" +
        Array.from(
          { length: 12 },
          (_, i) =>
            `POINTER ROW ${String(i + 1).padStart(2, "0")} | ` +
            "0123456789".repeat(7),
        ).join("\r\n") +
        "\x1b[?1000h\x1b[?1006h",
    );
    await until(
      "terminal enables native mouse reporting",
      `document.querySelector('.xterm').classList.contains('enable-mouse-events')`,
    );
    let cells = await grid();
    await evaluate(`window.__mouseStart = __deckFixture.writes.length`);
    for (const [column, row] of [
      [5, 2],
      [40, 6],
      [80, 10],
    ]) {
      const point = {
        x: cells.left + (column - 0.5) * cells.cw,
        y: cells.top + (row - 0.5) * cells.ch,
      };
      await mouse("mousePressed", point);
      await mouse("mouseReleased", point);
      await check(
        `${label}: mouse reports the visible cell ${column},${row}`,
        `__deckFixture.writes.slice(__mouseStart).includes(${JSON.stringify(`\x1b[<0;${column};${row}M`)}) && __deckFixture.writes.slice(__mouseStart).includes(${JSON.stringify(`\x1b[<0;${column};${row}m`)})`,
      );
    }
    await output(
      "\x1b[?1000l\x1b[?1006l\x1b[2J\x1b[HPOINTER SELECTION CHECK\r\n012345 PIXEL_MATCH abcdefghijklmnop\r\n012345 中文选中 abcdefghijklmnop",
    );
    await until(
      "terminal disables mouse reporting",
      `!document.querySelector('.xterm').classList.contains('enable-mouse-events') && document.querySelector('.xterm-rows').textContent.includes('PIXEL_MATCH')`,
    );
    cells = await grid();
    for (const [row, end, text] of [
      [2, 18, "PIXEL_MATCH"],
      [3, 15, "中文选中"],
    ]) {
      const start = {
        x: cells.left + 7.1 * cells.cw,
        y: cells.top + (row - 0.5) * cells.ch,
      };
      const finish = { x: cells.left + (end + 0.1) * cells.cw, y: start.y };
      await mouse("mousePressed", start);
      await mouse("mouseMoved", finish, { buttons: 1 });
      await mouse("mouseReleased", finish);
      await key("C", "KeyC", 67, 10);
      await until(
        "native selection copied",
        `__deckFixture.clipboard.text === ${JSON.stringify(text)}`,
        5000,
      );
      await check(
        `${label}: dragging selects exactly ${text}`,
        `__deckFixture.clipboard.text === ${JSON.stringify(text)}`,
      );
    }
    await output("\x1b[?1049l");
    await tab("monitor");
    await check(
      `${label}: native tab clicks retain one terminal and its buffer`,
      `__geometryXterm === document.querySelector('.xterm') && document.querySelectorAll('.xterm').length === 1 && rhineSsh.output.includes('POINTER SELECTION CHECK')`,
    );
    if (dpr === 1 && [1920, 2560].includes(width))
      await shot(`geometry-monitor-${width}`);
  }
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1920,
    height: 1080,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(850);
  await tab("files");
  const divider = await evaluate(
    `(() => {const r=document.querySelector('.ssh-side-divider').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,width:document.querySelector('.ssh-workspace-side').clientWidth};})()`,
  );
  await mouse("mousePressed", { x: divider.x, y: divider.y });
  await mouse(
    "mouseMoved",
    { x: divider.x - 55, y: divider.y },
    { buttons: 1 },
  );
  await mouse("mouseReleased", { x: divider.x - 55, y: divider.y });
  await check(
    "sidebar drag follows the pointer by exactly 55 CSS pixels",
    `Math.abs(document.querySelector('.ssh-workspace-side').clientWidth - ${divider.width + 55}) <= 1`,
  );
  await evaluate(`__workspaceFixture.prompt('sftp','password')`);
  await until(
    "auxiliary decision surface owns focus",
    `rhineSshUi.promptKind === 'password'`,
  );
  await check(
    "viewport terminal yields visual and input priority to authentication",
    `document.querySelector('.ssh-terminal').inert && getComputedStyle(document.querySelector('.ssh-terminal')).visibility === 'hidden'`,
  );
  await click('.ssh-prompt [data-action="cancel"]');
  await until(
    "terminal is restored after native prompt click",
    `!rhineSshUi.promptOpen && getComputedStyle(document.querySelector('.ssh-terminal')).visibility === 'visible'`,
  );
  await tab("terminal");
  await click(".ssh-terminal-shortcut");
  await until(
    "native footer button works",
    `!document.querySelector('.ssh-terminal-tools').hidden`,
  );
  await click('[data-terminal-tool="larger"]');
  await until(
    "native font button works",
    `getComputedStyle(document.querySelector('.xterm-rows')).fontSize === '17px'`,
  );
  await click('[data-terminal-tool="font"]');
  await click('[data-terminal-tool="return"]');
  await click(".ssh-terminal-close");
  await until(
    "native close reassembles the original package",
    `!rhineSshUi.isOpen && rhine.stats().sessionDeck.progress === 0`,
  );
  await evaluate(`rhineSshUi.openTerminal()`);
  await until(
    "reopening retains the same native-resolution xterm",
    `rhineSshUi.hasFocus && __geometryXterm === document.querySelector('.xterm')`,
  );
  await check(
    "pointer validation preserves the SSH connection",
    `rhineSsh.active`,
  );
}
