/** The host archive workflow through the real DOM, preload, storage and PTY. */
window.__hostManagementProbe = (() => {
  const ui = window.rhineSshUi, client = window.rhineSsh, bridge = window.rhineDesktop;
  const checks = {};
  const q = selector => document.querySelector(selector);
  const form = () => q(".ssh-host-editor");
  const field = name => form().elements.namedItem(name);
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const waitFor = async (predicate, name, timeout = 20000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (await predicate()) return; await pause(50); }
    throw new Error(`Host archive timed out: ${name}`);
  };
  const click = selector => {
    const node = q(selector);
    if (!node || node.disabled || node.closest("[hidden],[inert]")) throw new Error(`Control not available: ${selector}; blocked by ${node?.closest("[hidden],[inert]")?.outerHTML.slice(0, 180) ?? "missing"}`);
    node.click();
  };
  const change = (node, value) => { node.value = String(value); node.dispatchEvent(new Event("input", { bubbles: true })); };
  const fill = values => { for (const [name, value] of Object.entries(values)) change(field(name), value); };
  const rows = () => [...document.querySelectorAll(".ssh-hosts-row")];
  const text = () => q(".ssh-terminal .xterm-rows")?.textContent || "";
  const detailReady = async () => {
    await pause(60); // Let a newly selected model update the old detail opacity.
    await waitFor(() => q("#stage").dataset.mode === "detail" && !q("#detail-content").inert && Number(q("#detail-content").style.opacity) > .9, "archive detail ready");
    await pause(300);
    await waitFor(() => !q("#detail-content").closest("[hidden],[inert]"), "detail input ready");
  };
  const openHosts = async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, shiftKey: true, bubbles: true }));
    await detailReady();
    await waitFor(() => ui.hostsOpen && q(".ssh-hosts-browser") && !q(".ssh-hosts-browser").hidden, "directory page");
  };
  const openHost = async alias => {
    const row = rows().find(row => row.dataset.alias === alias);
    if (!row) throw new Error(`No archive row for ${alias}`);
    row.click(); await detailReady();
  };
  const edit = async alias => {
    await openHosts();
    change(q('.ssh-hosts input[type="search"]'), "");
    click('.ssh-hosts [data-source="all"]');
    await openHost(alias);
    click("#tab-config");
    await waitFor(() => form() && !form().hidden, "configuration tab");
  };
  const terminalOpen = async () => {
    await waitFor(() => client.status().phase === "interactive" && ui.hasFocus, "interactive terminal");
    await waitFor(() => q(".ssh-terminal")?.dataset.transition === "open", "terminal transition");
    await pause(400);
  };
  const closeTerminal = async () => { ui.closeTerminal(); await waitFor(() => !ui.isOpen, "terminal close"); await pause(350); };
  const endSession = async () => {
    if (!client.active) throw new Error("Fixture exited before the explicit exit command");
    const id = client.buildRecord().id;
    client.write("exit\r");
    await waitFor(() => client.exit !== null, "native exit");
    await waitFor(async () => (await bridge.records.list()).records.some(record => record.id === id), "persisted session");
  };
  const savedName = "开发服务器", firstRename = "实验节点 · 已更名", finalRename = "长期维护节点";
  let saved, alias, card, argv, quickArgv, configAliases, oldRecordFile;
  const api = {
    checks, complete: false,
    async prepare() {
      q("#loading .entry-start")?.click();
      await waitFor(() => window.rhine.stats().ready && window.rhine.stats().startup === "started", "startup");
      window.rhine.archive(); await pause(450);
      checks["no separate SSH navigation button"] = !q('.system-nav [data-action="ssh-hosts"]');
      for (let i = 0; i < 6 && window.rhine.stats().selectedIndex !== ui.hostDirectoryCard; i++) click('[data-action="column-next"]');
      checks["existing column navigation reaches the sixth host column"] = window.rhine.stats().selectedIndex === ui.hostDirectoryCard && q("#column-number").textContent.includes("06");
      click('.read-file[data-action="open"]');
      await detailReady();
      await waitFor(() => rows().length === 2, "config host list");
      configAliases = (await bridge.hosts()).hosts.map(host => host.alias);
      checks["host directory is embedded in the archive detail"] = q("#tab-panel .ssh-hosts") && !q('.ssh-hosts[role="dialog"]') && q("#detail-content h2").textContent === "HOST ARCHIVES";
      checks["directory title and lines have a page entrance"] = Number(q("#detail-content").dataset.motionCount) > 0;
      change(q('.ssh-hosts input[type="search"]'), "labnode");
      checks["search filters existing SSH config hosts"] = rows().length === 1 && rows()[0].dataset.alias === "labnode";
      change(q('.ssh-hosts input[type="search"]'), "no-such-host");
      checks["search has an empty result state"] = rows().length === 0 && q(".ssh-hosts").textContent.includes("没有匹配");
      change(q('.ssh-hosts input[type="search"]'), "");
      click("#tab-config");
      fill({ hostname: "labnode", user: "operator", port: 2222, identityFile: "C:/keys with spaces/开发.pem", jumpHost: "jump@bastion:2200", connectTimeout: 12, keepAliveInterval: 0, keepAliveCountMax: 5 });
      form().querySelector("details").open = true;
      const input = field("hostname");
      await ui.reloadHosts();
      checks["host refresh preserves the exact editor nodes and draft"] = field("hostname") === input && input.value === "labnode";
      field("name").focus();
    },
    async saved() {
      await waitFor(() => form()?.hidden !== false && ui.hostList.some(host => host.displayName === savedName), "Enter saves host");
      const result = await bridge.hosts();
      const entry = result.hosts.find(host => host.displayName === savedName);
      saved = entry.profile; alias = entry.alias; card = ui.cardOf(alias);
      checks["native Enter saves a profile and opens its archive"] = !client.active && saved.name === savedName && window.rhine.stats().selectedIndex === card;
      checks["host card uses its dedicated stable H identifier"] = card >= 40 && ui.hostAt(card) === alias && q("#object-id").textContent.startsWith("H.");
      checks["key path and disabled keepalive survive persistence"] = saved.identityFile === "C:/keys with spaces/开发.pem" && saved.keepAliveInterval === 0;
      await openHosts();
      click('.ssh-hosts [data-source="saved"]');
      checks["source filters use friendly labels"] = rows().length === 1 && rows()[0].textContent.includes(savedName) && !rows()[0].textContent.includes("rhine-profile:");
      change(q('.ssh-hosts input[type="search"]'), "operator");
      checks["search matches the saved username"] = rows().length === 1;
      change(q('.ssh-hosts input[type="search"]'), "");
    },
    async staleEditor() {
      await edit(alias);
      const input = field("name");
      fill({ name: "尚未保存的本地修改" });
      const revision = (await bridge.hosts()).revision;
      const external = await bridge.hostProfiles.save({ ...saved, name: "来自另一个窗口" }, revision);
      if (!external.ok) throw new Error(external.error);
      click('.ssh-hosts [data-intent="save"]');
      await waitFor(() => q(".ssh-host-editor-message").textContent.includes("已更新"), "stale edit rejected");
      checks["stale edits retain their input until explicitly reloaded"] = field("name") === input && input.value === "尚未保存的本地修改";
      click('.ssh-hosts [data-action="reload-editor"]');
      await waitFor(() => field("name").value === "来自另一个窗口" && !form().querySelector("fieldset").disabled, "reload current configuration");
      checks["explicit reload recovers from a stale editor revision"] = q(".ssh-host-editor-message").textContent.includes("已载入最新配置") && ui.cardOf(alias) === card;
    },
    async connectSaved() {
      await edit(alias); fill({ name: firstRename });
      click('.ssh-hosts [data-intent="save-connect"]');
      await terminalOpen();
      saved = (await bridge.hosts()).hosts.find(host => host.alias === alias).profile;
      argv = client.buildRecord().argv;
      checks["save and connect preserves the card through rename"] = saved.name === firstRename && ui.cardOf(alias) === card && client.target === alias;
      checks["saved profile launches all selected options"] = argv[1].endsWith("fake-ssh.mjs") && JSON.stringify(argv.slice(2)) === JSON.stringify(["-v", "-l", "operator", "-p", "2222", "-i", "C:/keys with spaces/开发.pem", "-J", "jump@bastion:2200", "-o", "ConnectTimeout=12", "-o", "ServerAliveInterval=0", "-o", "ServerAliveCountMax=5", "labnode"]);
      checks["saved profile opens the packaged 3D terminal"] = q(".ssh-terminal").dataset.presentation === "deck" && window.rhine.stats().sessionDeck?.ready;
      checks["terminal uses the friendly host name"] = q(".ssh-terminal-target").textContent === firstRename && client.displayTarget === firstRename;
      checks["terminal paints actual authentication and PTY output"] = text().includes("debug1:") && text().includes("operator@labnode");
    },
    async guardAndReconnect() {
      await waitFor(() => text().includes("[fake-ssh] profile_round_trip"), "native saved-host input");
      checks["native keyboard reaches the saved host PTY"] = true;
      const list = await bridge.hosts();
      const rejectedSave = await bridge.hostProfiles.save({ ...saved, name: "blocked" }, list.revision);
      const rejectedRemove = await bridge.hostProfiles.remove(saved.id, list.revision);
      checks["main rejects editing or deleting the active profile"] = !rejectedSave.ok && !rejectedRemove.ok && (await bridge.hosts()).revision === list.revision;
      await closeTerminal(); await edit(alias);
      const input = field("name"); fill({ name: "应保留的编辑内容" });
      click('.ssh-hosts [data-intent="save"]');
      await waitFor(() => q(".ssh-host-editor-message").textContent.includes("请先断开"), "save failure feedback");
      checks["failed save retains the same field and entered value"] = field("name") === input && input.value === "应保留的编辑内容";
      click("#tab-notes"); await pause(150); click("#tab-config");
      checks["switching tabs retains an unfinished configuration draft"] = field("name").value === "应保留的编辑内容";
      click("#tab-overview"); await endSession();
      ui.openTerminal();
      await waitFor(() => ui.isOpen && !q(".ssh-terminal-reconnect").hidden, "reconnect action");
      const generation = client.generation;
      click(".ssh-terminal-reconnect");
      await waitFor(() => client.generation > generation, "saved reconnect start"); await terminalOpen();
      checks["saved reconnect uses the same full configuration"] = client.target === alias && JSON.stringify(client.buildRecord().argv) === JSON.stringify(argv);
      await endSession(); await closeTerminal();
    },
    async historyAndRemove() {
      await edit(alias); fill({ name: finalRename }); click('.ssh-hosts [data-intent="save"]');
      await waitFor(() => form()?.hidden !== false && ui.hostList.some(host => host.displayName === finalRename), "post-session rename");
      await detailReady();
      checks["post-session rename retains the same archive"] = ui.cardOf(alias) === card;
      const records = (await bridge.records.list()).records.filter(record => record.target === alias);
      oldRecordFile = records[0]?.file;
      checks["both past sessions retain their stable host association"] = records.length === 2;
      click("#tab-notes");
      await waitFor(() => document.querySelectorAll(".host-session-row").length === 2, "renamed host history");
      checks["session list tab has a content entrance"] = Number(q("#tab-panel").dataset.motionCount) > 0;
      click(".host-session-row"); await waitFor(() => ui.auditOpen, "stored audit"); await pause(400);
      checks["history uses the original display name and archive modal"] = q(".ssh-record .ssh-audit-summary").textContent.includes(firstRename) && Boolean(q(".ssh-record .terminal-modal .modal-top"));
      checks["full session record has staggered page motion"] = Number(q(".ssh-record").dataset.motionCount) > 0;
      ui.closeAudit(); await waitFor(() => !ui.auditOpen, "audit close");
      await edit(alias); click('.ssh-hosts [data-action="remove"]');
      checks["first remove click leaves the host intact"] = (await bridge.hosts()).hosts.some(host => host.alias === alias);
      click('.ssh-hosts [data-action="remove"]');
      await waitFor(() => ui.cardOf(alias) === null && ui.hostsOpen, "confirmed removal and directory fallback"); await detailReady();
      checks["removing the selected host selects the directory"] = window.rhine.stats().selectedIndex === ui.hostDirectoryCard && ui.cardOf(alias) === null;
      checks["removal retains stored history and system config hosts"] = (await bridge.records.read(oldRecordFile)).ok && JSON.stringify((await bridge.hosts()).hosts.map(host => host.alias)) === JSON.stringify(configAliases);
      click("#tab-notes");
      await waitFor(() => document.querySelectorAll(".host-directory-session").length >= 2, "global history after deletion");
      checks["deleted host sessions remain accessible from the directory"] = [...document.querySelectorAll(".host-directory-session")].some(node => node.textContent.includes(firstRename));
      click(".host-directory-session"); await waitFor(() => ui.auditOpen, "deleted host audit");
      ui.closeAudit(); await waitFor(() => !ui.auditOpen, "deleted host audit close");
      click("#tab-overview"); click('.ssh-hosts [data-source="config"]');
      change(q('.ssh-hosts input[type="search"]'), "labnode"); await openHost("labnode"); click("#tab-config");
      checks["config source copies inherit the alias and unspecified options"] = field("hostname").value === "labnode" && field("port").value === "" && field("connectTimeout").value === "";
      field("hostname").focus();
    },
    async auditSnapshot() {
      ui.openAudit(); await waitFor(() => ui.auditOpen, "audit screenshot"); await pause(500);
    },
    async closeAuditSnapshot() {
      ui.closeAudit(); await waitFor(() => !ui.auditOpen, "audit screenshot close");
    },
    async prepareQuick() {
      await waitFor(() => q("#tab-overview").getAttribute("aria-selected") === "true", "Escape returns from config");
      checks["native Escape returns to the archive overview tab"] = document.activeElement === q("#tab-overview") && form()?.hidden !== false;
      await openHosts(); click("#tab-config"); click('.ssh-hosts [data-mode="quick"]');
      fill({ name: "临时维护", hostname: "quicknode", user: "admin", port: 2244, identityFile: "C:/keys with spaces/临时.pem", jumpHost: "relay:2201", connectTimeout: 15, keepAliveInterval: 20, keepAliveCountMax: 4 });
      field("hostname").focus();
    },
    async quickConnected() {
      await terminalOpen(); quickArgv = client.buildRecord().argv;
      checks["native Enter starts an unsaved temporary connection"] = client.target === "quicknode" && !(await bridge.hosts()).hosts.some(host => host.source === "saved");
      checks["temporary connection uses its display name"] = client.displayTarget === "临时维护" && q(".ssh-terminal-target").textContent === "临时维护";
      checks["temporary connection applies all supplied parameters"] = quickArgv[1].endsWith("fake-ssh.mjs") && JSON.stringify(quickArgv.slice(2)) === JSON.stringify(["-v", "-l", "admin", "-p", "2244", "-i", "C:/keys with spaces/临时.pem", "-J", "relay:2201", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=20", "-o", "ServerAliveCountMax=4", "quicknode"]);
      checks["temporary connection has an operable terminal"] = ui.hasFocus;
    },
    async quickReconnect() {
      await waitFor(() => text().includes("[fake-ssh] quick_round_trip"), "native temporary-host input");
      checks["native keyboard reaches temporary host PTY"] = true;
      await endSession(); const generation = client.generation; click(".ssh-terminal-reconnect");
      await waitFor(() => client.generation > generation, "temporary reconnect start"); await terminalOpen();
      checks["temporary reconnect preserves parameters and display name"] = JSON.stringify(client.buildRecord().argv) === JSON.stringify(quickArgv) && client.displayTarget === "临时维护";
      await endSession(); await closeTerminal();
    },
    async darkEditor() {
      window.rhine.archive(); click('.system-nav [data-action="settings"]');
      await waitFor(() => q('[data-color-theme="dark"]'), "theme settings");
      click('[data-color-theme="dark"]'); click('[data-action="close-modal"]');
      await waitFor(() => !q(".modal-backdrop"), "settings close"); await pause(1000);
      await openHosts(); click("#tab-config"); click('.ssh-hosts [data-mode="saved"]');
      fill({ name: "维护服务器", hostname: "192.0.2.42", user: "operator", identityFile: "C:/Users/operator/.ssh/id_ed25519", jumpHost: "relay:2222" });
      form().querySelector("details").open = true;
      checks["host editor follows the application dark theme"] = getComputedStyle(q(".ssh-hosts")).color !== "rgb(8, 10, 8)" && getComputedStyle(field("hostname")).backgroundColor === "rgba(0, 0, 0, 0)";
    },
    async compactLayout() {
      const body = q("#detail-content"), bounds = body.getBoundingClientRect();
      checks["small desktop has no horizontal editor overflow"] = body.scrollWidth <= body.clientWidth + 1 && bounds.left >= -1 && bounds.top >= -1 && bounds.right <= innerWidth + 1 && bounds.bottom <= innerHeight + 1;
      const submit = form().querySelector('[data-intent="save-connect"]'); submit.focus(); await pause(150);
      const button = submit.getBoundingClientRect();
      checks["small-window actions are reachable through archive scrolling"] = button.top >= bounds.top && button.bottom <= bounds.bottom && !submit.disabled;
    },
    focusWrapped() {
      checks["embedded editor allows Tab into the existing page controls"] = !q(".ssh-hosts").contains(document.activeElement) && !q(".system-footer").inert;
      field("hostname").focus();
    },
    editorEscaped() {
      checks["Escape returns from editor before leaving the directory"] = ui.hostsOpen && form()?.hidden !== false && document.activeElement === q("#tab-overview");
    },
    async finished() {
      await waitFor(() => !ui.hostsOpen, "Escape returns to archive array");
      checks["closing the directory restores archive input and focus"] = document.activeElement === q(".read-file") && !q("#archive-ui").inert;
      checks["unfinished drafts are not persisted"] = !(await bridge.hosts()).hosts.some(host => host.source === "saved");
      // Exercise an actual column longer than the reference's 32 physical rows.
      const added = [];
      let revision = (await bridge.hosts()).revision;
      for (let i = 0; i < 36; i++) {
        const result = await bridge.hostProfiles.save({ name: `节点 ${String(i).padStart(2, "0")}`, hostname: `node-${i}.example` }, revision);
        if (!result.ok) throw new Error(result.error);
        added.push(result.profile); revision = result.revision;
      }
      await ui.reloadHosts();
      const last = added.at(-1), lastCard = ui.cardOf(`rhine-profile:${last.id}`);
      window.rhine.select(lastCard); await pause(50);
      const ticks = [...document.querySelectorAll("#file-ticks button:not([hidden])")];
      checks["more than 32 hosts remain individually selectable"] = lastCard !== null && window.rhine.stats().selectedIndex === lastCard && q(".count-total").textContent === "39";
      checks["long columns retain eight valid ticks around the selection"] = ticks.length === 8 && ticks.some(tick => Number(tick.dataset.select) === lastCard && tick.classList.contains("selected")) && ticks.every(tick => tick.title.includes("H-"));
      click('[data-action="next"]');
      checks["long host column wraps from last host to its directory"] = window.rhine.stats().selectedIndex === ui.hostDirectoryCard;
      click('[data-action="prev"]');
      checks["long host column wraps backwards to the same last host"] = window.rhine.stats().selectedIndex === lastCard;
      click('[data-action="column-next"]'); click('[data-action="column-prev"]');
      checks["column switching restores the selected host memory"] = window.rhine.stats().selectedIndex === lastCard;
      for (const profile of added) {
        const result = await bridge.hostProfiles.remove(profile.id, revision);
        if (!result.ok) throw new Error(result.error);
        revision = (await bridge.hosts()).revision;
      }
      await ui.reloadHosts();
      checks["refresh after bulk removal repairs selection and column memory"] = window.rhine.stats().selectedIndex === ui.hostDirectoryCard;
      checks["original forty archives remain ordinary content"] = Array.from({ length: 40 }, (_, index) => ui.hostAt(index)).every(host => host === null);
    },
    async reducedMotion() {
      click('.system-nav [data-action="settings"]');
      await waitFor(() => q('[data-pref="reduced"]'), "reduced motion settings");
      if (!q('[data-pref="reduced"]').checked) click('[data-pref="reduced"]');
      click('[data-action="close-modal"]');
      await openHosts(); click("#tab-config");
      checks["reduced motion reveals the configuration immediately"] = q(".ssh-hosts").dataset.motion === "settled" && q(".ssh-hosts").getAnimations({ subtree: true }).filter(animation => animation.playState === "running").length === 0;
      ui.connectHost("passhost");
      await waitFor(() => ui.promptOpen && ui.promptKind === "password", "reduced authentication");
      const prompt = q(".ssh-prompt");
      checks["reduced authentication has no page or waiting animation"] = prompt.dataset.transition === "open" && prompt.dataset.motion === "settled" && getComputedStyle(q(".ssh-prompt .status-light")).animationName === "none";
      checks["dark authentication uses the same palette and detail position"] = getComputedStyle(prompt).color !== "rgb(8, 10, 8)" && Math.abs(q(".ssh-prompt-panel").getBoundingClientRect().left - q("#detail-content").getBoundingClientRect().left) < 2;
    },
    async endReduced() {
      ui.answerSecret("correct"); await terminalOpen(); await endSession(); await closeTerminal();
      checks["reduced motion still connects and operates the real PTY"] = client.exit?.exitCode === 0;
      api.complete = true;
    },
  };
  return api;
})();
