/** Actual desktop bundle + preload + ConPTY; only the SSH peer is a fixture. */
(async () => {
  const waitFor = async (predicate, name, timeout = 20000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Native terminal: ${name} timed out`);
  };
  const client = window.rhineSsh,
    ui = window.rhineSshUi;
  const text = () =>
    document.querySelector(".ssh-terminal .xterm-rows")?.textContent ?? "";
  document.querySelector("#loading .entry-start")?.click();
  await waitFor(() => window.rhine.stats().ready, "scene");
  await waitFor(() => window.rhine.stats().startup === "started", "startup");
  window.rhine.archive();
  ui.connectHost("labnode");
  await waitFor(
    () => ui.hasFocus && window.rhine.stats().sessionDeck?.ready,
    "projected terminal",
  );
  await waitFor(
    () =>
      document.querySelector(".ssh-terminal")?.dataset.transition === "open",
    "surface transition",
  );
  await new Promise((resolve) => setTimeout(resolve, 450));
  const checks = {
    "native desktop loads the terminal insert and original package":
      window.rhine.stats().sessionDeck.available,
    "native desktop operates on the projected model screen":
      document.querySelector(".ssh-terminal")?.dataset.presentation === "deck",
    "native terminal includes actual authentication output":
      text().includes("debug1:") && text().includes("operator@labnode"),
  };
  window.__nativeDeckProbe = {
    async input() {
      await waitFor(
        () => text().includes("[fake-ssh] native_key_check"),
        "keyboard round trip",
      );
      checks["native keyboard reaches ConPTY and returns to the model screen"] =
        true;
      ui.closeTerminal();
      await waitFor(
        () => !ui.isOpen && window.rhine.stats().sessionDeck.progress === 0,
        "reassembly",
      );
      client.write("collapsed_native_check\r");
      await waitFor(
        () => client.output.includes("[fake-ssh] collapsed_native_check"),
        "hidden output",
      );
      ui.openTerminal();
      await waitFor(() => ui.hasFocus, "reopen");
      await waitFor(
        () =>
          document.querySelector(".ssh-terminal")?.dataset.transition ===
          "open",
        "reopen transition",
      );
      await new Promise((resolve) => setTimeout(resolve, 450));
      checks["native hidden output survives reassembly and reopening"] =
        text().includes("[fake-ssh] collapsed_native_check");
      return checks;
    },
    async tools() {
      window.__nativeDeckProbe.evidence = { beforeTools: [...client.rawLog] };
      const button = (action) =>
        document.querySelector(`[data-terminal-tool="${action}"]`);
      const click = (action) => {
        const node = button(action);
        node.focus();
        node.click();
      };
      const clipboard = window.rhineDesktop.clipboard;
      document.querySelector(".ssh-terminal-shortcut").click();
      const query = document.querySelector(".ssh-terminal-query");
      query.value = "[fake-ssh] native_key_check";
      query.dispatchEvent(new Event("input", { bubbles: true }));
      await waitFor(
        () =>
          document
            .querySelector(".ssh-terminal-search-count")
            .textContent.endsWith(" / 1"),
        "native output search",
      );
      checks["native search finds the actual ConPTY output"] = true;
      click("copy");
      await waitFor(
        () =>
          document.querySelector(".ssh-terminal-tool-feedback").textContent ===
          "已复制选中输出",
        "native copy",
      );
      checks["native copy uses the preload and text clipboard IPC"] =
        (await clipboard.readText()).text === "[fake-ssh] native_key_check";
      const rejected = await clipboard.writeText({ text: "invalid payload" });
      checks[
        "native clipboard IPC rejects a non-text payload without changing content"
      ] =
        !rejected.ok &&
        (await clipboard.readText()).text === "[fake-ssh] native_key_check";
      await clipboard.writeText("native_paste_check");
      click("paste");
      await waitFor(
        () =>
          document.querySelector(".ssh-terminal-tool-feedback").textContent ===
          "已粘贴",
        "native paste",
      );
      checks["native paste does not append Enter"] = !client.output.includes(
        "[fake-ssh] native_paste_check",
      );
      client.write("\r");
      await waitFor(
        () => client.output.includes("[fake-ssh] native_paste_check"),
        "native pasted command",
      );
      checks["native pasted text reaches ConPTY and returns"] = true;
      click("larger");
      await waitFor(
        () =>
          getComputedStyle(document.querySelector(".xterm-rows")).fontSize ===
          "17px",
        "native font size",
      );
      checks["native font controls update terminal text"] = true;
      click("font");
      window.__nativeDeckProbe.evidence.afterTools = [...client.rawLog];
      return checks;
    },
    async end() {
      document.querySelector('[data-terminal-tool="return"]')?.click();
      await waitFor(
        () => document.querySelector(".ssh-terminal-tools").hidden,
        "tools folded",
      );
      if (!client.active)
        throw new Error("Native fixture ended before explicit exit");
      client.write("exit\r");
      await waitFor(() => client.exit !== null, "exit");
      checks["native exit keeps its final output readable"] =
        client.exit.exitCode === 0 &&
        ui.isOpen &&
        text().includes("[fake-ssh] collapsed_native_check");
      checks["native resize does not duplicate authentication records"] =
        client.rawLog.length === 19;
      window.__nativeDeckProbe.evidence.finalLog = [...client.rawLog];
      if (client.rawLog.length !== 19)
        window.__nativeDeckProbe.evidence.terminalOutput = client.output;
      return checks;
    },
  };
  return { checks, screen: window.rhine.stats().sessionDeck.screen };
})();
