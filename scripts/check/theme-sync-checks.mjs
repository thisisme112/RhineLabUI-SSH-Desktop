// Themes ported from the Unreal build, in the real desktop bundle (run through check-terminal-deck.mjs --theme-sync):
// the corner card a change leaves behind, the far-layer poster, per-theme room lighting and the frame gate.
export async function checkThemeSync({ evaluate, until, check, shot, send, sleep }) {
  const choose = async (name) => {
    await evaluate(`rhine.settings()`);
    await until("settings panel opens", `!!document.querySelector('button[data-color-palette="${name}"]')`);
    await evaluate(`document.querySelector('button[data-color-palette="${name}"]').click()`);
  };
  const closeSettings = async () => {
    await evaluate(`document.querySelector('[data-action="close-modal"]')?.click()`);
    await until("settings close", `!document.querySelector('.settings-modal')`);
  };
  const state = () => evaluate(`(() => {
    const mark = document.querySelector('.theme-mark');
    const poster = document.querySelector('#theme-poster');
    let drawn = 0;
    if (poster && poster.width > 0) {
      const data = poster.getContext('2d').getImageData(0, 0, poster.width, poster.height).data;
      for (let i = 3; i < data.length; i += 16) if (data[i] > 8) drawn++;
    }
    const stats = window.rhine.stats();
    return {
      palette: document.documentElement.dataset.colorPalette,
      mark: mark ? { opacity: +getComputedStyle(mark).opacity, rect: (r => [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)])(mark.getBoundingClientRect()), z: getComputedStyle(mark).zIndex, text: mark.querySelector('small')?.textContent, name: [...mark.querySelectorAll('.theme-mark-letter b:last-child')].map(b => b.textContent).join(''), glyph: !!mark.querySelector('svg') } : null,
      posterOn: poster?.dataset.on ?? null,
      posterDrawn: drawn,
      exposure: stats.exposure ?? null,
      budget: stats.budget,
      mode: stats.mode,
    };
  })()`);

  await closeSettings().catch(() => {});
  await sleep(1500);
  const before = await state();
  await check("the far-layer poster is on over the archive", `${before.posterOn === "true"}`);
  await check("the poster has been drawn (not an empty canvas)", `${before.posterDrawn > 50}`);

  await choose("clinic");
  await sleep(120);
  await check("the corner card is not there before the change-over has cleared", `${(await state()).mark === null}`);
  await until("the rows begin to turn over card by card", `window.rhine.stats().flipping === true`);
  await check("the flip wave runs after a theme change", `${(await evaluate(`window.rhine.stats().flipping`)) === true}`);
  await sleep(900);
  // The settings sheet that offered the choice is in the top layer and would hide the card: it waits.
  await check("the corner card waits while the settings sheet is open", `${(await state()).mark === null}`);
  await closeSettings();
  await sleep(500);
  // The picture first: reading the poster back is slow and the card only lives 1.7 s.
  await shot("theme-sync-clinic-mark");
  const during = await state();
  await check("a theme change leaves its corner card", `${during.mark !== null}`);
  await check("the card carries the theme number and Latin name", `${/THEME 12 \/ 14 · CLINICAL \/ STERILE/.test(during.mark?.text ?? "")}`);
  await check("the card carries the motif glyph", `${during.mark?.glyph === true}`);
  await check("the card's name turns over to the new theme", `${during.mark?.name === "医疗"}`);
  await check("the palette itself changed", `${during.palette === "clinic"}`);
  await sleep(2400);
  const after = await state();
  await check("the corner card fades away after 1.7 s", `${after.mark === null}`);
  await check("the flip wave has ended and the rows are at rest", `${(await evaluate(`window.rhine.stats().flipping`)) === false}`);

  const clinic = await state();
  await check("the poster follows the theme (redrawn after the change)", `${clinic.posterDrawn > 50}`);
  await shot("theme-sync-clinic-home");

  // Mid-wave picture: the rows leaning and flashing the new theme's accent.
  await choose("hazard");
  await closeSettings();
  await sleep(350);
  await shot("theme-sync-flip");
  await sleep(2500);

  // The poster steps aside for a surface that covers the page.
  await evaluate(`rhine.detail()`);
  await until("detail opens", `window.rhine.stats().mode === 'detail'`);
  await sleep(1200);
  await check("the poster stays behind the detail page", `${(await state()).posterOn === "true"}`);
  await evaluate(`rhine.archive()`);
  await until("archive returns", `window.rhine.stats().mode === 'archive'`);

  // Reduced motion: a theme is simply applied, with no card.
  await evaluate(`(() => { const p = JSON.parse(localStorage.getItem('rhine-settings')||'{}'); p.reduced = true; localStorage.setItem('rhine-settings', JSON.stringify(p)); })()`);
  await send("Page.reload");
  await until("scene and hosts after reload", `window.rhine?.stats().ready`);
  await sleep(800);
  await choose("orbit");
  await sleep(1400);
  await check("reduced motion shows no corner card", `${(await state()).mark === null}`);
  await evaluate(`(() => { const p = JSON.parse(localStorage.getItem('rhine-settings')||'{}'); p.reduced = false; localStorage.setItem('rhine-settings', JSON.stringify(p)); })()`);
  await closeSettings().catch(() => {});

  // The scene stops rendering under an opened portal page and wakes when it closes.
  await send("Page.reload");
  await until("scene after reload", `window.rhine?.stats().ready`);
  await sleep(1500);
  const frames = () => evaluate(`window.rhineSshUi.rendering.frames`);
  await evaluate(`document.querySelector('.portal-launcher')?.click()`);
  await sleep(300);
  await evaluate(`document.querySelector('.portal-card')?.click()`);
  await sleep(2500);
  const asleep = await frames();
  await sleep(1500);
  const stillAsleep = await frames();
  await check("an opened portal page stands over a sleeping scene (no frames rendered)", `${asleep === stillAsleep}`);
  await evaluate(`document.querySelector('.portal-back')?.click()`);
  await sleep(1200);
  await check("the scene wakes when the page closes", `${(await frames()) > stillAsleep}`);
}
