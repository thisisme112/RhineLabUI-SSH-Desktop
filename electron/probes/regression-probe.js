(async () => {
  const checks = {},
    evidence = {};
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const client = window.rhineSsh,
    ui = window.rhineSshUi;
  const until = async (predicate, label) => {
    for (let i = 0; i < 120; i++) {
      if (predicate()) return;
      await sleep(60);
    }
    throw new Error("Timed out: " + label);
  };
  const closeAll = async () => {
    ui.closeTerminal();
    ui.closeAudit();
    ui.closeHosts();
    ui.dismissPrompt();
    await sleep(350);
  };
  const rows = () =>
    document.querySelector(".ssh-terminal .xterm-rows")?.textContent || "";
  try {
    if (client.active) {
      client.stop();
      await until(() => !client.active, "previous typing session stopped");
    }
    await closeAll();
    const started = await ui.startSession("regression-host");
    if (!started.ok) throw new Error(started.error);
    await until(
      () => client.status().phase === "interactive" && ui.isOpen,
      "terminal open",
    );
    await sleep(250);
    client.write("first-marker\r");
    await until(() => rows().includes("first-marker"), "first output");
    const generation = client.generation;
    checks["parallel start preserves the current terminal"] =
      !(await client.start({ target: "different-host" })).ok &&
      client.generation === generation &&
      client.target === "regression-host";
    ui.closeTerminal();
    const before = window.rhine.stats().selected;
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
        cancelable: true,
      }),
    );
    checks["closing terminal still isolates background input"] =
      window.rhine.stats().selected === before && ui.isOpen;
    await sleep(300);
    client.write("hidden-marker\r");
    await until(
      () => client.output.includes("hidden-marker"),
      "background output",
    );
    ui.openTerminal();
    await sleep(250);
    checks["hidden terminal output is retained"] =
      rows().includes("hidden-marker");
    for (let n = 0; n < 3; n++) {
      ui.closeTerminal();
      await sleep(40);
      ui.openTerminal();
      await sleep(40);
    }
    client.write("repeat-marker\r");
    await sleep(300);
    const occurrences = (value) => (value.match(/repeat-marker/g) || []).length;
    evidence.outputCounts = {
      received: occurrences(client.output),
      displayed: occurrences(rows()),
    };
    checks["rapid reopen does not duplicate terminal output"] =
      evidence.outputCounts.received > 0 &&
      evidence.outputCounts.received === evidence.outputCounts.displayed;
    client.write("__notice__\r");
    await until(
      () => client.output.includes("forged@remote"),
      "untrusted shell text",
    );
    await sleep(150);
    checks["shell text cannot fail a connection or request a password"] =
      client.status().phase === "interactive" &&
      !client.pendingPrompt &&
      !ui.promptOpen;
    client.write("exit\r");
    await until(() => Boolean(client.exit), "first exit");
    const ended = JSON.stringify(client.buildRecord());
    await sleep(200);
    checks["finished record and phase durations stop advancing"] =
      ended === JSON.stringify(client.buildRecord());
    await closeAll();

    await ui.startSession("retry-passhost");
    await until(() => ui.promptKind === "password", "password prompt");
    const field = () => document.querySelector(".ssh-prompt input");
    const submit = () =>
      document
        .querySelector('.ssh-prompt [data-action="submit-secret"]')
        .click();
    const firstId = client.pendingPrompt.id;
    submit();
    await sleep(120);
    checks["empty password keeps its prompt and input"] =
      ui.promptKind === "password" &&
      client.pendingPrompt?.id === firstId &&
      field() !== null;
    field().value = "incorrect";
    submit();
    await until(
      () => client.pendingPrompt?.id > firstId && ui.promptKind === "password",
      "repeated password",
    );
    checks["identical retry prompt has a new request identity"] =
      client.pendingPrompt.id > firstId && field().value === "";
    field().value = "correct";
    submit();
    await until(
      () => client.status().phase === "interactive" && ui.isOpen,
      "retry accepted",
    );
    await sleep(250);
    checks["new session clears old terminal content"] =
      !rows().includes("first-marker") && !rows().includes("hidden-marker");
    const staleReply = await window.rhineDesktop.session.answer(
      firstId,
      "must-not-reach-shell",
    );
    checks["stale password reply is rejected by the main process"] =
      !staleReply.ok && !client.output.includes("must-not-reach-shell");
    checks["passwords do not enter the terminal transcript"] =
      !client.output.includes("incorrect") &&
      !client.output.includes("correct");
    client.write("exit\r");
    await until(() => Boolean(client.exit), "retry exit");
    await closeAll();

    const old = {
      ...client.buildRecord(),
      id: "historical-regression",
      target: "labnode",
    };
    const saved = await window.rhineDesktop.session.record(old);
    if (!saved.ok) throw new Error("could not store historical fixture");
    window.rhine.select(ui.cardOf("labnode"));
    window.rhine.detail();
    await sleep(900);
    document.querySelector('[data-tab="notes"]').click();
    await until(
      () =>
        [...document.querySelectorAll("[data-record-file]")].some(
          (button) => button.dataset.recordFile === saved.file,
        ),
      "stored record row",
    );
    [...document.querySelectorAll("[data-record-file]")]
      .find((button) => button.dataset.recordFile === saved.file)
      .click();
    await until(() => ui.auditOpen, "historical audit");
    await sleep(350);
    const auditPanel = document.querySelector(".ssh-record .ssh-audit-panel");
    const auditBody = document.querySelector(".ssh-record .ssh-audit-body");
    const auditRect = auditPanel.getBoundingClientRect();
    evidence.auditLayout = {
      bottom: auditRect.bottom,
      viewportHeight: innerHeight,
      bodyHeight: auditBody.clientHeight,
      contentHeight: auditBody.scrollHeight,
    };
    checks["long record stays inside the viewport"] =
      auditRect.top >= 0 && auditRect.bottom <= innerHeight + 1;
    auditBody.scrollTop = auditBody.scrollHeight;
    checks["long record content scrolls to its final section"] =
      auditBody.scrollTop > 0 &&
      auditBody.scrollTop + auditBody.clientHeight >=
        auditBody.scrollHeight - 1;
    const exported = await ui.exportRecord(
      window.__auditExportPath.replace(/\.txt$/, "-historical.txt"),
    );
    evidence.exportedTarget = exported.record?.target;
    checks["historical export uses the record being displayed"] =
      exported.ok &&
      exported.record?.target === "labnode" &&
      client.target === "retry-passhost";
    ui.closeAudit();
    await sleep(300);
    const focus = document.activeElement;
    checks["audit exit restores a visible focus target"] =
      Boolean(focus?.getClientRects().length) &&
      !focus?.closest("[inert],[hidden]");
    const pruned = await window.rhineDesktop.records.prune();
    checks["log maintenance preserves recent session records"] =
      pruned.ok && (await window.rhineDesktop.records.read(saved.file)).ok;
    await closeAll();
    return { checks, evidence };
  } catch (error) {
    client.stop();
    return { checks, evidence, error: String(error.stack || error) };
  }
})();
