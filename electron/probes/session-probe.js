/**
 * Renderer-side smoke probe for the desktop session layer.
 *
 * Loaded as a real file (see `readProbe` in main.cjs) rather than kept inline
 * as a template literal: 130 lines of code inside a string loses syntax
 * highlighting, lint coverage and escaping sanity — `'ping\r'` inside a
 * template literal has to be written `'ping\\r'`, which is exactly the kind of
 * thing that silently breaks.
 *
 * Runs in the renderer through `webContents.executeJavaScript`, so it may use
 * DOM APIs, `window.rhine` and `window.rhineSsh`.
 *
 * Defines `window.__sessionProbe` rather than calling itself: the harness wraps
 * the invocation in its own try/catch so an async throw is reported instead of
 * silently resolving to undefined.
 */
window.__sessionProbe = async () => {
  const client = window.rhineSsh;
  if (!client)
    return {
      error: "window.rhineSsh missing — the desktop client did not initialise",
    };

  // Bring the app up so the 3D scene is updating; the reveal is driven through
  // scene.update(), so nothing can be observed until it runs.
  const entry = document.querySelector("#loading .entry-start");
  if (entry) entry.click();
  await new Promise((r) => setTimeout(r, 2500));
  window.rhine.archive();
  await new Promise((r) => setTimeout(r, 1000));

  // Sampled before any session exists: this is the "no data, no animation"
  // baseline. By the time a session is interactive the handshake itself has
  // already produced traffic, so it has to be measured here.
  const bandsBeforeSession = (() => {
    const b = window.rhineSsh.meter.value;
    return { low: +b.low.toFixed(4), activity: +b.activity.toFixed(4) };
  })();

  const sceneDecryption = () => {
    const d = window.rhine.stats()?.decryption;
    return d
      ? { phase: d.phase, clarity: Number(Number(d.clarity).toFixed(3)) }
      : null;
  };

  /**
   * Exercises the terminal surface while the session is genuinely live: the
   * panel must have opened on its own, real keystrokes must reach the program
   * and come back, and the array bands must be moved by measured bytes.
   */
  const terminalCheck = async () => {
    const ui = window.rhineSshUi;
    const result = {
      autoOpened: false,
      mounted: false,
      focused: false,
      guardHeld: false,
      roundTrip: false,
      painted: "",
      bandsBefore: null,
      bandsAfter: null,
    };
    result.autoOpened = ui.isOpen;
    if (!result.autoOpened) return result;
    await new Promise((r) => setTimeout(r, 500));

    const screen = document.querySelector(".ssh-terminal-screen");
    const rows = () =>
      document.querySelector(".ssh-terminal-screen .xterm-rows")?.textContent ||
      "";
    result.mounted = Boolean(screen && screen.querySelector(".xterm"));
    result.paintedBefore = rows().slice(0, 120);
    result.focused = ui.hasFocus;
    result.bandsBefore = (() => {
      const b = window.rhineSsh.meter.value;
      return { low: +b.low.toFixed(4), activity: +b.activity.toFixed(4) };
    })();

    // Global shortcuts must yield while the terminal owns the keyboard: `/`
    // opens the archive search everywhere else in this app.
    const textarea = screen && screen.querySelector("textarea");
    (textarea || screen || document).dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "/",
        bubbles: true,
        cancelable: true,
      }),
    );
    await new Promise((r) => setTimeout(r, 250));
    const modalRoot = document.querySelector("#modal-root");
    result.guardHeld = !(modalRoot && modalRoot.children.length);

    // A command must reach the program and be answered. The pty echoes what is
    // typed, so the marker is what proves a round trip rather than a redraw.
    window.rhineSsh.write("ping\r");
    for (let i = 0; i < 30 && !result.roundTrip; i++) {
      await new Promise((r) => setTimeout(r, 100));
      result.painted = rows();
      result.roundTrip = result.painted.includes("[fake-ssh] ping");
    }
    result.bandsAfter = (() => {
      const b = window.rhineSsh.meter.value;
      return { low: +b.low.toFixed(4), activity: +b.activity.toFixed(4) };
    })();

    window.rhineSsh.write("exit\r");
    await new Promise((r) => setTimeout(r, 600));
    result.stillOpenAfterExit = window.rhineSshUi.isOpen;
    return result;
  };

  const runOne = async (target, interactiveCheck) => {
    const samples = [];
    const started = await client.start({ target, cols: 100, rows: 30 });
    if (!started.ok) return { target, error: started.error };

    const sampler = setInterval(() => {
      const d = sceneDecryption();
      if (!d) return;
      // [phase, lowest clarity seen, highest clarity seen] per phase, so the
      // log shows the reveal actually travelling rather than one resting value.
      const last = samples[samples.length - 1];
      if (!last || last[0] !== d.phase)
        samples.push([d.phase, d.clarity, d.clarity]);
      else {
        last[1] = Math.min(last[1], d.clarity);
        last[2] = Math.max(last[2], d.clarity);
      }
    }, 40);

    let interactive = null;
    let interactivePhase = null;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const phase = client.status().phase;
      if (phase === "interactive" && !interactivePhase)
        interactivePhase = phase;
      if (phase === "interactive" && interactiveCheck && !interactive)
        interactive = await interactiveCheck();
      if (client.exit) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    // Let the spring finish travelling before reading the resting state.
    await new Promise((r) => setTimeout(r, 4500));
    clearInterval(sampler);
    const status = client.status();
    const band = () => {
      const b = client.meter.value;
      return {
        low: +b.low.toFixed(4),
        mid: +b.mid.toFixed(4),
        high: +b.high.toFixed(4),
        activity: +b.activity.toFixed(4),
      };
    };
    const hand = client.handshake;
    return {
      target,
      argv: started.argv,
      logPath: started.logPath,
      phase: status.phase,
      interactivePhase,
      finalPhase: status.phase,
      failure: status.failure,
      timeline: status.timeline.map((entry) => entry.phase),
      facts: Object.fromEntries(
        Object.entries(status.facts).map(([key, fact]) => [key, fact.value]),
      ),
      unknownLines: status.unknownLines,
      rawLogLines: client.rawLog.length,
      terminalHasPrompt: /:~\$/.test(client.output),
      terminalHasDebug: /debug1:/.test(client.output),
      traffic: client.traffic,
      exit: client.exit,
      decryption: sceneDecryption(),
      decryptionSamples: samples,
      interactive,
      bands: band(),
      rates: client.meter.measurements,
      handshake: {
        reference: hand.reference,
        target: hand.target,
        frozen: hand.frozen,
        milestone: hand.milestone,
        clarity: hand.clarity,
        settled: hand.settled,
      },
    };
  };

  /**
   * Drives a scenario that blocks on a question and reports what the blocking
   * surface showed, what the answer did, and where the connection ended up.
   */
  const promptScenario = async (target, answer, afterInteractive) => {
    const ui = window.rhineSshUi;
    const out = {
      target,
      opened: false,
      kind: null,
      text: "",
      reachedInteractive: false,
      phase: null,
      failure: null,
      exitCode: null,
      panelAfter: null,
      panelTextAfter: "",
    };
    // A failure surface left over from the previous scenario would otherwise be
    // mistaken for this scenario's question.
    if (ui.promptOpen) ui.dismissPrompt();
    await new Promise((r) => setTimeout(r, 400));

    const started = await ui.startSession(target);
    if (!started.ok) {
      out.error = started.error;
      return out;
    }
    // Wait for a *question*: a failure surface means ssh never asked.
    const seen = [];
    for (let i = 0; i < 250; i++) {
      const open = ui.promptOpen;
      const kind = ui.promptKind;
      const last = seen[seen.length - 1];
      if (!last || last[0] !== open || last[1] !== kind)
        seen.push([open, kind]);
      if (open && kind && kind !== "failure") break;
      if (open && kind === "failure") break;
      await new Promise((r) => setTimeout(r, 80));
    }
    out.seen = seen;
    out.opened = ui.promptOpen;
    out.kind = ui.promptKind;
    out.text = ui.promptText.slice(0, 600);

    if (ui.promptOpen && ui.promptKind && ui.promptKind !== "failure" && answer)
      await answer(ui);

    // The answer either gets the session up or ends it; record which, before
    // it is torn down, rather than reading the resting phase afterwards.
    for (let i = 0; i < 250; i++) {
      if (client.status().phase === "interactive") {
        out.reachedInteractive = true;
        break;
      }
      if (client.exit) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (out.reachedInteractive && afterInteractive) await afterInteractive();

    for (let i = 0; i < 300; i++) {
      if (client.exit) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await new Promise((r) => setTimeout(r, 900));
    const status = client.status();
    out.phase = status.phase;
    out.failure = status.failure;
    out.exitCode = client.exit ? client.exit.exitCode : null;
    out.panelAfter = ui.promptKind;
    out.panelTextAfter = ui.promptText.slice(0, 300);
    return out;
  };

  /** Let a session that reached a shell end cleanly. */
  const endSession = () => client.write("exit\r");

  /** Read the finished session's own record back through its surface. */
  const auditCheck = async () => {
    const ui = window.rhineSshUi;
    const out = {
      open: false,
      closed: false,
      text: "",
      summary: "",
      exportOk: false,
      exportPath: null,
    };
    ui.openAudit();
    await new Promise((r) => setTimeout(r, 500));
    out.open = ui.auditOpen;
    // `ssh-record` scopes this to the record surface: the host picker shares
    // the same layout classes on purpose.
    out.text = (
      document.querySelector(".ssh-record .ssh-audit-body")?.textContent || ""
    ).slice(0, 4000);
    out.summary =
      document.querySelector(".ssh-record .ssh-audit-summary")?.textContent ||
      "";
    const result = await ui.exportRecord(window.__auditExportPath || undefined);
    out.exportOk = result.ok === true;
    out.exportPath = result.file || null;
    out.exportError = result.error || null;
    ui.closeAudit();
    await new Promise((r) => setTimeout(r, 350));
    out.closed = !ui.auditOpen;
    return out;
  };

  /** The entry point of the workflow: pick a host, connect, end the session. */
  const hostPickerCheck = async () => {
    const ui = window.rhineSshUi;
    const out = {
      open: false,
      closed: false,
      count: 0,
      list: [],
      text: "",
      clicked: null,
      reachedInteractive: false,
    };
    ui.openHosts();
    await new Promise((r) => setTimeout(r, 900));
    out.open = ui.hostsOpen;
    out.list = ui.hostList.map((entry) => ({ ...entry }));
    out.count = out.list.length;
    out.text = (
      document.querySelector(".ssh-hosts-list")?.textContent || ""
    ).slice(0, 300);
    out.note = (
      document.querySelector(".ssh-hosts-note")?.textContent || ""
    ).slice(0, 200);
    // The header now shows a host count; compare the displayed entries with
    // the actual config loader instead of depending on the old path caption.
    const loadedHosts = await window.rhineDesktop.hosts();
    out.source = loadedHosts.configPath || "";
    out.configMatches = loadedHosts.ok && out.list.every((entry) =>
      loadedHosts.hosts.some((loaded) => loaded.alias === entry.alias && loaded.raw === entry.raw),
    );

    // Click a host whose scenario reaches a shell: `passhost` would block on a
    // password question, which is what the typing check exercises separately.
    const row = [...document.querySelectorAll(".ssh-hosts-row")].find(
      (entry) => entry.dataset.alias === "labnode",
    );
    if (!row) {
      ui.closeHosts();
      await new Promise((r) => setTimeout(r, 400));
      out.closed = !ui.hostsOpen;
      return out;
    }
    // Read the host archive, then use its existing connection action.
    const previousExit = client.exit;
    out.clicked = row.dataset.alias || "";
    row.click();
    for (let i = 0; i < 100; i++) {
      if (document.querySelector('#host-connect') && !document.querySelector('#detail-content').inert) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    document.querySelector('#host-connect')?.click();
    for (let i = 0; i < 250; i++) {
      if (client.status().phase === "interactive") {
        out.reachedInteractive = true;
        break;
      }
      if (client.exit && client.exit !== previousExit) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (out.reachedInteractive) client.write("exit\r");
    for (let i = 0; i < 200; i++) {
      if (client.exit && client.exit !== previousExit) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await new Promise((r) => setTimeout(r, 400));
    out.closed = !ui.hostsOpen;
    return out;
  };

  /**
   * The freeze the user hit: closing one surface and opening another before the
   * 200ms fade finishes. The old implementation tied sibling restoration to the
   * transition's completion callback, which an interruption cancels — leaving
   * everything under `#stage` permanently inert.
   */
  const interruptCheck = async () => {
    const ui = window.rhineSshUi;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // Start from a clean screen: an earlier scenario leaves the terminal open on
    // purpose (the session output stays readable until the user closes it), and
    // its modality would be mistaken for a freeze.
    if (ui.isOpen) ui.closeTerminal();
    if (ui.promptOpen) ui.dismissPrompt();
    if (ui.auditOpen) ui.closeAudit();
    if (ui.hostsOpen) ui.closeHosts();
    await sleep(700);
    const baseline = (() => {
      const stage = document.querySelector("#stage");
      return [...stage.children].filter((node) => node.inert).length;
    })();
    const baselineNames = [...document.querySelector("#stage").children]
      .filter((node) => node.inert)
      .map((node) => node.className || node.id || node.tagName);

    ui.openAudit();
    await sleep(250);
    ui.closeAudit();
    await sleep(60); // mid-fade
    ui.openHosts();
    await sleep(250);
    ui.closeHosts();
    await sleep(60); // mid-fade again
    ui.openAudit();
    await sleep(200);
    ui.closeAudit();
    await sleep(700);

    const inspect = () => {
      const stage = document.querySelector("#stage");
      const panels = [
        ".ssh-prompt",
        ".ssh-terminal",
        ".ssh-audit",
        ".ssh-hosts",
      ];
      return {
        inertChildren: [...stage.children]
          .filter((node) => node.inert)
          .map((node) => node.className),
        visiblePanels: panels.filter((selector) => {
          const el = stage.querySelector(`:scope > ${selector}`);
          return el && !el.hidden;
        }),
        navInert: document.querySelector(".system-nav")?.inert ?? null,
        archiveInert: document.querySelector("#archive-ui")?.inert ?? null,
        bodyFocusable: document.activeElement !== null,
      };
    };
    const after_ = inspect();

    // And the archive must still respond. Compare the authoritative selection,
    // not the rolling-number markup: that animates for 460ms and would still be
    // mid-roll when this reads it.
    const before = window.rhine.stats()?.selected ?? null;
    const state = window.rhine.stats() ?? {};
    // Dispatch on an element, not on `document`: the app's handler reads
    // `target.dataset`, which only exists on elements. Real keystrokes always
    // target an element.
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
        cancelable: true,
      }),
    );
    await sleep(600);
    const after = window.rhine.stats()?.selected ?? null;
    const moved = before !== null && after !== null && before !== after;
    return {
      baseline,
      baselineNames,
      after: after_,
      moved,
      selection: { before, after },
      mode: state.mode,
      ready: state.ready,
      startup: state.startup,
      panelStates: {
        audit: ui.auditOpen,
        hosts: ui.hostsOpen,
        prompt: ui.promptOpen,
        terminal: ui.isOpen,
      },
    };
  };

  const payload = {
    bandsBeforeSession,
    hostPicker: await hostPickerCheck(),
    success: await runOne("operator@lab-node-07", terminalCheck),
    rejected: await runOne("operator@reject-host"),
    // The security decision, both branches, plus the secret path.
    hostkeyAccepted: await promptScenario(
      "operator@newhost",
      (ui) => ui.answerHostKey(true),
      endSession,
    ),
    hostkeyRejected: await promptScenario("operator@newhost", (ui) =>
      ui.answerHostKey(false),
    ),
    passwordGiven: await promptScenario(
      "operator@passhost",
      (ui) => ui.answerSecret("hunter2"),
      endSession,
    ),
    audit: await auditCheck(),
    interrupt: await interruptCheck(),
  };
  // Also stash it: a large result object can fail structured-clone on the way
  // out of the renderer and resolve to undefined, which would look like every
  // check failing for no stated reason.
  window.__sessionSmokeResult = payload;
  return payload;
};
