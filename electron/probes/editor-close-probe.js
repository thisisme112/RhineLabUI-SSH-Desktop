/**
 * Renderer-side probe for the SFTP text editor's close path, run inside the
 * real desktop window (frameless, caption overlay, scaled stage).
 *
 * Defines `window.__editorProbe`; main.cjs drives the steps and interleaves
 * REAL `sendInputEvent` mouse clicks between them, so the probe can record
 * exactly what each click hit and whether the editor left the screen.
 */
window.__editorProbe = (() => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const editor = () => document.querySelector(".ssh-text-editor");
  const closeButton = () =>
    document.querySelector('.ssh-text-editor [data-editor="close"]');

  // Record every pointer/click event at capture time, before any app listener
  // can cancel it: the answer to "did the click even reach the page".
  const events = [];
  for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "click"])
    window.addEventListener(
      type,
      (event) =>
        events.push({
          type,
          x: event.clientX,
          y: event.clientY,
          target:
            event.target instanceof Element
              ? event.target.closest("[data-editor]")?.dataset.editor ??
                event.target.className?.toString?.().slice(0, 60) ??
                event.target.tagName
              : String(event.target),
          defaultPrevented: event.defaultPrevented,
        }),
      { capture: true },
    );

  const state = () => {
    const surface = editor();
    const button = closeButton();
    if (!surface || !button) return { missing: true };
    const rect = button.getBoundingClientRect();
    const hit = document.elementFromPoint(
      rect.x + rect.width / 2,
      rect.y + rect.height / 2,
    );
    const strip = document.querySelector(".titlebar-drag");
    return {
      hidden: surface.hidden,
      inert: surface.inert,
      transition: surface.dataset.transition ?? null,
      zIndex: surface.style.zIndex,
      status:
        document.querySelector(".ssh-editor-status")?.textContent ?? null,
      closeDisabled: button.disabled,
      buttonRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      buttonRegion: getComputedStyle(button).webkitAppRegion,
      hit: hit
        ? hit.closest("[data-editor]")?.dataset.editor ??
          hit.className?.toString?.().slice(0, 60) ??
          hit.tagName
        : null,
      strip: strip
        ? {
            inert: strip.inert,
            rect: strip.getBoundingClientRect().toJSON(),
            region: getComputedStyle(strip).webkitAppRegion,
          }
        : null,
      window: {
        width: innerWidth,
        height: innerHeight,
        dpr: devicePixelRatio,
        stageScale:
          document.querySelector("#stage")?.style.getPropertyValue("--stage-scale") ??
          null,
      },
      events: events.splice(0),
    };
  };

  const until = async (test, timeout = 20000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (test()) return true;
      await sleep(150);
    }
    return false;
  };

  const openEditor = async () => {
    const ui = window.rhineSshUi;
    const client = window.rhineSsh;
    if (!ui || !client) return { error: "session layer missing" };
    // Enter the running scene first; the smoke window starts at the entry gate.
    document.querySelector("#loading .entry-start")?.click();
    await until(() => window.rhine?.stats()?.ready, 30000);
    window.rhine.archive();
    await sleep(800);
    // The fixture's success scenario authenticates by key: no prompt.
    ui.connectHost("labnode");
    if (!(await until(() => ui.isOpen, 20000)))
      return { error: "terminal did not open", phase: String(client.status?.() ?? null) };
    if (
      !(await until(
        () =>
          Number(document.querySelector(".ssh-files-count")?.textContent) > 0,
        20000,
      ))
    )
      return { error: "file listing never became ready" };
    const field = document.querySelector(".ssh-files-filter input");
    field.value = "config.yaml";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    if (
      !(await until(
        () =>
          document.querySelector(".ssh-file-name")?.textContent ===
          "config.yaml",
      ))
    )
      return { error: "config.yaml row missing" };
    document
      .querySelector(".ssh-file-row")
      .dispatchEvent(
        new MouseEvent("dblclick", { bubbles: true, cancelable: true }),
      );
    if (
      !(await until(
        () =>
          editor() &&
          !editor().hidden &&
          editor()
            .querySelector(".cm-content")
            ?.textContent.includes("key: value"),
      ))
    )
      return { error: "editor did not open", state: state() };
    await until(() => editor().dataset.transition === "open", 5000);
    return state();
  };

  const edit = async () => {
    // Real input path: focus is on the CodeMirror content after open().
    document.querySelector(".ssh-text-editor .cm-content")?.focus();
    document.execCommand("insertText", false, "edited: true\n");
    await until(() =>
      document
        .querySelector(".ssh-editor-status")
        ?.textContent.includes("未保存"),
    );
    return state();
  };

  return { openEditor, edit, state, sleep };
})();
true;
