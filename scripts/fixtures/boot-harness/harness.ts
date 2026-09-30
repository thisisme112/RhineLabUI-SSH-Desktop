/**
 * Renders the web opening sequence for offline baking.
 *
 * The Unreal build plays the opening as a baked frame sequence, so this harness
 * exists to reproduce the real one exactly: it reuses src/features/boot/boot.ts, the real
 * stylesheet and the real markup instead of re-drawing anything by hand. Frames
 * are stepped externally through `window.__boot.render(t)`.
 */
import "../../../src/app/style.css";
import { BootSequence } from "../../../src/features/boot/boot.ts";
import { brandHeading, logo } from "../../../src/shared/brand.ts";

const stage = document.querySelector<HTMLElement>("#stage")!;
stage.innerHTML = `
  <div id="boot-background" class="boot-background"><svg viewBox="0 0 1920 1080" preserveAspectRatio="none"><g fill="none" stroke="#fff" stroke-width="3"><path d="M-210 705C-45 705 182 704 247 567C337 377 99 306 4 435S27 680 169 631C309 584 227 314 279 111S568-113 568-113"/><path d="M1560-80C1374 114 1671 168 1601 323S1371 367 1431 480S1692 666 1559 787S1329 886 1498 1130"/><circle cx="1450" cy="648" r="346"/><circle cx="1450" cy="648" r="348"/></g></svg></div>
  <header class="brand">${brandHeading}</header>
  <section id="boot" class="boot">
    <div class="access-text">ACCESS</div>
    <div class="boot-logo">${logo}</div>
    <div class="auth-status"><span>▪</span> <span id="auth-message"></span><i></i></div>
    <div class="scan"><svg viewBox="0 0 1920 1080" aria-hidden="true"><g fill="none" stroke="#080a08" stroke-width="2" stroke-linecap="round"><path/><path stroke="#fff"/><path/><path/><path/><path/><circle class="orbit-dot" r="8" fill="#ed821b" stroke="none"/><circle class="orbit-dot" r="8" fill="#ed821b" stroke="none"/><circle class="scan-core" cx="960" cy="540" r="5" fill="#080a08" stroke="none"/></g></svg><span>PERMISSION AUTHORIZED</span></div>
    <div class="welcome"><div class="welcome-panel"></div><div class="welcome-heading">WELCOME TO</div><div class="welcome-company"><strong>RHINE LAB.LLC.</strong><strong class="welcome-highlight" aria-hidden="true">RHINE LAB.LLC.</strong></div><div class="welcome-database">INTERNAL DATABASE</div><div class="welcome-logo">${logo}</div></div>
  </section>
  <div class="powered">POWERED BY <b>RHINE LAB</b><i></i></div>`;
document.querySelector("#boot-background")!.insertAdjacentHTML("beforeend", '<div class="boot-white"></div>');

// The app scales #stage from a layout pass; the bake renders the 1920x1080
// reference surface straight into the capture size, so the stage is pinned to
// the top-left corner and scaled by the requested resolution.
const requested = new URLSearchParams(location.search);
const captureWidth = Number(requested.get("w") ?? 1920);
const captureHeight = Number(requested.get("h") ?? 1080);
const stageScale = captureWidth / 1920;
document.head.insertAdjacentHTML("beforeend",
  `<style>html,body,#viewport{width:${captureWidth}px;height:${captureHeight}px;margin:0;overflow:hidden}` +
  `#stage{left:0;top:0;transform:scale(${stageScale});transform-origin:top left}</style>`);

stage.dataset.mode = "boot";
const bootSequence = new BootSequence(stage);

/** App time at which each editorial step takes over (from boot-motion.ts). */
const STEP_START: Record<string, number> = { access: 0, logo: 4.12, auth: 6.12, scan: 14.48, welcome: 17.76 };

declare global {
  interface Window {
    __boot: {
      duration: number;
      render: (appTime: number) => { step: string; frame: number };
      ready: boolean;
    };
  }
}

window.__boot = {
  duration: 21.92,
  ready: true,
  render(appTime: number) {
    const motion = bootSequence.update(appTime);
    stage.dataset.boot = motion.step;
    // CSS-side entrance animations (fadeIn, step transforms) are real-time by
    // nature; pin them to the frame's own time so stepping stays deterministic
    // instead of depending on how long a screenshot took.
    const elapsed = Math.max(0, (appTime - (STEP_START[motion.step] ?? 0)) * 1000);
    for (const animation of document.getAnimations()) {
      try {
        animation.currentTime = elapsed;
      } catch {
        /* animations without a timeline cannot be pinned */
      }
    }
    return { step: motion.step, frame: motion.f };
  },
};