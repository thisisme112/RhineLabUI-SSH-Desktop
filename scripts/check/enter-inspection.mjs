/** User-level handoff for checks that exercise the terminal after inspection. */
export async function enterInspection({ evaluate, until }) {
  // Direct CONNECT now enters authentication without opening the optional viewer.
  await until('authentication or model ready', `(() => { if (window.rhineSshUi?.promptKind || window.rhineSshUi?.isOpen) return true; const v = document.querySelector('.model-viewer'); return v && !v.hidden && (JSON.parse(v.dataset.stats || '{}').ready || !v.querySelector('[data-viewer="retry"]').hidden); })()`);
  if (await evaluate(`!!window.rhineSshUi?.promptKind || !!window.rhineSshUi?.isOpen`)) return;
  await evaluate(`document.querySelector('[data-viewer="primary"]').click()`);
  await until('inspection hands off', `document.querySelector('.model-viewer').hidden`);
}
