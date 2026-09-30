/**
 * Android's back gesture arrives as a history event, and this app has never had
 * one: on a phone, pressing back from the middle of a document, from the 360°
 * viewer or from an open dialog left the page outright, from wherever you were.
 * This maps the app's own screens onto history entries so back means "one level
 * up", the way it does in every other Android app.
 *
 * It deliberately stops intervening at the archive. There is nothing of ours
 * left to undo there, so the press is passed through and Android leaves the
 * app — which is the correct behaviour, and the reason this is a stack of
 * *screens above the archive* rather than of every mode.
 *
 * The desktop and wallpaper builds opt out (`enabled: false`). They load from
 * `file://`, where `pushState` is not permitted, and neither answers to a
 * system back button.
 */

export type AppScreen = "detail" | "viewer" | "modal";

export class HistoryNav {
  /** Screens above the archive, innermost last. */
  private stack: AppScreen[] = [];
  /** Programmatic `history.back()` calls we made, whose popstate is ours. */
  private own = 0;

  constructor(
    /** Undo one level in the app itself; the same path Escape takes. */
    private readonly restore: (screen: AppScreen) => void,
    private readonly enabled = true,
  ) {
    if (!this.enabled) return;
    // A reload can restore the previous entry's state, but the app restarts at
    // the boot screen, so whatever it described is no longer on screen.
    try {
      history.replaceState(null, "");
    } catch {
      /* file:// and sandboxed documents */
    }
    window.addEventListener("popstate", this.onPopState);
  }

  get depth() {
    return this.stack.length;
  }

  /** The app moved one level deeper. */
  enter(screen: AppScreen) {
    if (!this.enabled || this.stack.at(-1) === screen) return;
    this.stack.push(screen);
    try {
      history.pushState({ rhine: this.stack.length }, "");
    } catch {
      /* Not permitted here; in-app state still tracks the screen. */
    }
  }

  /**
   * The app left `screen` by its own means — Escape, a close button, or a
   * navigation that moved on. Its entry is consumed so a later back press does
   * not fire an action for a screen that is already gone.
   *
   * A screen that is not on top (the archive closing underneath an open
   * dialog, say) is dropped from the stack without touching history: its entry
   * is still ahead of us, and a later back press will consume it harmlessly.
   */
  leave(screen: AppScreen) {
    if (!this.enabled) return;
    const at = this.stack.lastIndexOf(screen);
    if (at < 0) return;
    if (at !== this.stack.length - 1) {
      this.stack.splice(at, 1);
      return;
    }
    this.stack.pop();
    this.own++;
    try {
      history.back();
    } catch {
      this.own = Math.max(0, this.own - 1);
    }
  }

  /**
   * Back to the boot screen. The entries already in history are left where they
   * are rather than unwound with `history.go`: that fires one popstate per
   * entry, and a browser that clamps the distance would leave this class
   * swallowing presses that were never ours. The cost is that a replay can
   * leave one stale entry behind, which reads as a single dead back press.
   */
  reset() {
    this.stack.length = 0;
  }

  dispose() {
    if (!this.enabled) return;
    window.removeEventListener("popstate", this.onPopState);
  }

  private onPopState = () => {
    if (this.own > 0) {
      this.own--;
      return;
    }
    const screen = this.stack.pop();
    if (screen) this.restore(screen);
  };
}
