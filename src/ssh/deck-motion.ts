/**
 * The terminal deck's拆解 choreography, as plain numbers.
 *
 * These formulas used to live inside `TerminalDeck.pose()`. They are lifted out
 * — not changed — so scripts/check-unreal-workbench.mjs can import this file
 * directly and diff the Unreal port against it value by value, exactly the way
 * the opening timeline is diffed against `boot-motion.ts`. Nothing here imports
 * three.js or the GLB, so Node can load it as-is; moving a number is a port
 * change, so the Unreal side is regenerated rather than edited.
 *
 * Axes are the web ones: X = screen width, Y = screen height, Z = layer order.
 * art/build_terminal.py builds the insert layers from Blender (X, -Z, Y), so
 * glTF ends up with Blender Z as its Y and the layer depths as its Z — which is
 * why `SCREEN.y = 1.565` is the screen's real height above the package face and
 * `DECK_PARTS[].z` are layer depths.
 */

/** Projection and camera anchors match art/build_terminal.py. */
export const SCREEN = { width: 4.36, height: 2.42, y: 1.565, z: 0.139 } as const;
export const DECK_PARTS = [
  { id: "bezel", label: "光导与定位角", en: "LIGHT GUIDES", z: 0.096 },
  { id: "screen", label: "无边框显示层", en: "EDGE DISPLAY", z: SCREEN.z },
  { id: "vents", label: "散热层", en: "THERMAL LAYER", z: -0.001 },
  { id: "board", label: "主板与接口", en: "BOARD & PORTS", z: -0.045 },
  { id: "backplate", label: "背板", en: "BACKPLATE", z: -0.108 },
] as const;
export type DeckPartId = (typeof DECK_PARTS)[number]["id"];

/**
 * The four movable package layers, in the order the Unreal port's `EDeckPart`
 * enum uses. They are the groups art/build_assembly.py tags with
 * `assemblyPart`; `optical-core` and `optical-lenses` are tagged too but never
 * rendered, so they are not listed.
 */
export const SHELL_PARTS = ["cover", "fasteners", "carrier", "substrate"] as const;
export type ShellPartId = (typeof SHELL_PARTS)[number];

/** Rest height of the package: art/build_archive.py puts every shell at z=1.85. */
export const DECK_REST_Y = 1.85;
/** Seconds the deck takes to separate; the close is deliberately quicker. */
export const DECK_OPEN_SECONDS = 2.1;
export const DECK_CLOSE_SECONDS = 1.2;

export type DeckPoseVector = { x: number; y: number; z: number };
export type DeckPosePart = { position: DeckPoseVector; rotation: DeckPoseVector };
export type DeckPose = {
  lid: number;
  screws: number;
  rear: number;
  /** Keyed by every `ShellPartId` followed by every `DeckPartId`. */
  parts: Record<string, DeckPosePart>;
  /** Opacity of the frosted cover: the screen reads through it while settling. */
  clarity: number;
};

const NONE: DeckPoseVector = { x: 0, y: 0, z: 0 };
const part = (position: DeckPoseVector, rotation: DeckPoseVector = NONE): DeckPosePart =>
  ({ position, rotation });

/**
 * `pose()` from terminal-deck.ts, unchanged.
 *
 * The insert layers are not moved: they sit at their real coordinates
 * (`DECK_PARTS[].z`) for all time, and every enlargement is the camera. The
 * cover/fasteners rotations are about the model's world origin, because
 * art/build_assembly.py re-origins every shell mesh to (0,0,0).
 */
export function deckPose(opening: number): DeckPose {
  const lid = opening;
  const screws = 1 - (1 - opening) ** 2;
  const rear = opening * (0.85 + 0.15 * opening);
  return {
    lid, screws, rear,
    parts: {
      cover: part(
        { x: -3.1 * lid, y: DECK_REST_Y + 2.5 * lid, z: 0.8 * lid },
        { x: -0.16 * lid, y: -0.45 * lid, z: 0.1 * lid },
      ),
      fasteners: part(
        { x: -3.1 * lid, y: DECK_REST_Y + 2.5 * lid, z: 0.8 * lid + 0.22 * screws },
        { x: -0.16 * lid, y: -0.45 * lid, z: 0.1 * lid },
      ),
      carrier: part(
        { x: 0.45 * rear, y: DECK_REST_Y - 0.32 * rear, z: -0.75 * rear },
        { x: 0, y: 0.12 * rear, z: 0 },
      ),
      substrate: part(
        { x: -0.22 * rear, y: DECK_REST_Y - 0.45 * rear, z: -0.38 * rear },
        { x: 0, y: -0.06 * rear, z: 0 },
      ),
      ...Object.fromEntries(
        DECK_PARTS.map(spec => [spec.id, part({ x: 0, y: SCREEN.y, z: spec.z })]),
      ),
    },
    clarity: 0.96 + 0.04 * opening,
  };
}

/**
 * Backlight level for a phase ssh actually reported.
 *
 * Rule R1 from DESKTOP-SSH.md: no event, no movement. The breathing is a
 * modulation of a real state, never a loop of its own, so `idle` and `closed`
 * hold a steady level and only the settling phases pulse.
 */
export function deckBacklight(phase: string, reduced: boolean, time: number): number {
  if (phase === "failed") return 0.5;
  if (["resolving", "connecting", "handshake", "hostkey", "authenticating", "opening"].includes(phase))
    return reduced ? 0.4 : 0.28 + 0.08 * (1 + Math.sin(time * 3.4));
  if (phase === "interactive") return 0.4;
  return 0.22;
}

/** How far `openBlend` walks this frame, in blend units. */
export function deckOpenStep(opening: boolean, seconds: number, dt: number): number {
  return dt / (opening ? Math.max(0.3, Math.min(DECK_OPEN_SECONDS, seconds)) : DECK_CLOSE_SECONDS);
}
