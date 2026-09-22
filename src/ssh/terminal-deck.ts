import * as THREE from "three";
import { disposeThreeTree } from "../three-resources";
import type { SshClient } from "./client";
import type { SshTerminalPanel } from "./terminal";
import { paintTerminalBuffer, TERMINAL_FONT } from "./terminal-screen";
import { buildDeckInsert, DECK_PARTS, SCREEN, deckBacklight, deckPose, type DeckInsert } from "./terminal-deck-parts";
import type { ModelSource, InspectionPart } from "../model-viewer";

export const TERMINAL_INSPECTION_PARTS: readonly InspectionPart[] = [
  { id: "fasteners", label: "紧固件", en: "FASTENERS" },
  { id: "cover", label: "透明盖板", en: "COVER" },
  ...DECK_PARTS.map(({ id, label, en }) => ({ id, label, en })),
  { id: "substrate", label: "承载基板", en: "SUBSTRATE" },
  { id: "carrier", label: "外壳框架", en: "CARRIER" },
];

type Shell = {
  model: THREE.Group;
  dispose(): void;
  syncLabel?(): void;
  setClarity?(value: number): void;
};
/** The insert sits inside the unchanged Blender package. The screen reads the
 * same xterm that takes over when the camera reaches operating size.
 *
 * The insert is five named plates (see `terminal-deck-parts.ts`), so the whole
 * stack can be inspected through an independently owned ModelViewer — the terminal's version of the archive's
 * "拆解档案", driven by the same damped spring `model-viewer.ts` uses.
 */
export class TerminalDeck {
  readonly group = new THREE.Group();
  /** Read by `scene.ts` for the operating camera and by `terminal-screen.ts`
   *  for the DOM overlay. Both are why `SCREEN` is imported rather than
   *  restated: one source, three consumers. */
  readonly screenSize = {
    width: SCREEN.width,
    height: SCREEN.height,
    center: [0, SCREEN.y, SCREEN.z] as const,
  };
  private canvas = document.createElement("canvas");
  private ctx: CanvasRenderingContext2D;
  private texture: THREE.CanvasTexture;
  private parts = new Map<string, THREE.Group>();
  private insert: THREE.Group;
  private finishes: DeckInsert;
  private host = "";
  private hostLabel = "";
  private cardId = "";
  private painted = "";
  private disposed = false;
  private preview: { key: string; title: string; lines: string[] } | null = null;
  private lastPaint = -Infinity;

  static async load(
    client: SshClient,
    terminal: SshTerminalPanel,
    makeShell: () => Promise<Shell>,
  ) {
    const shell = await makeShell();
    try {
      return new TerminalDeck(client, terminal, shell, await buildDeckInsert());
    } catch (error) {
      shell.dispose();
      throw error;
    }
  }

  static async inspection(client: SshClient, terminal: SshTerminalPanel, makeShell: () => Promise<Shell>): Promise<ModelSource> {
    const deck = await TerminalDeck.load(client, terminal, makeShell);
    deck.pose(deck.parts, 0);
    deck.group.visible = true;
    // The inspection owns a separate shell, insert and canvas texture.
    // No live scene objects or renderer-owned textures cross WebGL contexts.
    deck.ctx.fillStyle = terminal.screenTheme.background!;
    deck.ctx.fillRect(0, 0, deck.canvas.width, deck.canvas.height);
    deck.texture.needsUpdate = true;
    return { model: deck.group, parts: deck.parts, dispose: () => deck.dispose(),
      setClarity: value => deck.shell.setClarity?.(value),
      setTheme: value => {
        deck.finishes.setTheme(value);
        const background = terminal.screenTheme.background!;
        if (deck.painted !== background) {
          deck.painted = background; deck.ctx.fillStyle = background;
          deck.ctx.fillRect(0, 0, deck.canvas.width, deck.canvas.height); deck.texture.needsUpdate = true;
        }
      } };
  }

  private constructor(
    private client: SshClient,
    private terminal: SshTerminalPanel,
    private shell: Shell,
    insert: DeckInsert,
  ) {
    this.canvas.width = 1536;
    this.canvas.height = Math.round(
      (this.canvas.width * this.screenSize.height) / this.screenSize.width,
    );
    this.ctx = this.canvas.getContext("2d")!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    // Match the Blender-exported glTF UV orientation for the live canvas.
    this.texture.flipY = false;
    this.texture.anisotropy = 4;
    this.finishes = insert;
    this.insert = this.finishes.group;
    // The panel's material belongs to the insert; the deck only hands it the
    // canvas to read. Replacing it here would leave the builder's material
    // undisposed for the whole life of the deck.
    const screenMaterial = this.finishes.screen.material as THREE.MeshBasicMaterial;
    screenMaterial.map = this.texture;
    screenMaterial.needsUpdate = true;
    for (const spec of DECK_PARTS)
      this.parts.set(spec.id, this.finishes.parts.get(spec.id)!);
    for (const child of [...shell.model.children]) {
      const part = child.userData.assemblyPart as string;
      if (part === "optical-core" || part === "optical-lenses") {
        child.visible = false;
        continue;
      }
      let group = this.parts.get(part);
      if (!group) {
        group = new THREE.Group();
        group.userData.deckPart = part;
        group.position.y = 1.85;
        this.parts.set(part, group);
        shell.model.add(group);
      }
      child.position.y -= 1.85;
      group.add(child);
    }
    this.group.add(shell.model, this.insert);
    this.group.visible = false;
  }

  setHost(alias: string, label = alias) {
    if (!this.preview && this.host === alias && this.hostLabel === label) return;
    this.preview = null;
    this.host = alias;
    this.hostLabel = label;
    this.group.userData.contentKey = "host:" + alias;
    this.painted = "";
    this.shell.syncLabel?.();
  }
  setCard(id: string) {
    if (this.cardId === id) return;
    this.cardId = id;
    this.painted = "";
    this.group.userData.cardId = id;
    this.shell.syncLabel?.();
  }

  bind(client: SshClient, terminal: SshTerminalPanel) {
    if (client === this.client && terminal === this.terminal) return;
    this.client = client; this.terminal = terminal;
    this.painted = ""; this.lastPaint = -Infinity;
  }

  setPreview(key: string, title: string, lines: string[]) {
    const changed = this.preview?.key !== key;
    const shape = JSON.stringify(lines);
    if (!changed && this.preview?.title === title && JSON.stringify(this.preview.lines) === shape) return;
    this.preview = { key, title, lines };
    this.group.userData.contentKey = key;
    this.host = ""; this.hostLabel = title; this.painted = "";
    if (changed) this.shell.syncLabel?.();
  }

  /** An immutable screen and label belong to the returning physical card. */
  snapshot() {
    // Covered operation suspends texture uploads, but the outgoing card still
    // captures the latest parser contents rather than its last visible frame.
    this.paint(Number.isFinite(this.lastPaint) ? this.lastPaint : 0, true, this.client.target === this.host);
    this.texture.needsUpdate = true;
    const group = this.group.clone(true);
    const materials: THREE.Material[] = [];
    const textures: THREE.Texture[] = [];
    const parts = new Map<string, THREE.Group>();
    group.traverse(object => {
      if (object.userData.deckPart) parts.set(object.userData.deckPart, object as THREE.Group);
      if (!(object instanceof THREE.Mesh)) return;
      const source = object.material as THREE.MeshBasicMaterial;
      const material = source.clone();
      material.onBeforeCompile = source.onBeforeCompile;
      material.customProgramCacheKey = source.customProgramCacheKey.bind(source);
      if (source.map?.image instanceof HTMLCanvasElement) {
        const canvas = document.createElement("canvas");
        canvas.width = source.map.image.width; canvas.height = source.map.image.height;
        canvas.getContext("2d")!.drawImage(source.map.image, 0, 0);
        // Texture.clone() shares its Source; replacing image there would freeze
        // the live deck as well. Every returning canvas needs its own Source.
        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = source.map.colorSpace;
        texture.flipY = source.map.flipY;
        texture.anisotropy = source.map.anisotropy;
        texture.needsUpdate = true;
        material.map = texture; textures.push(texture);
      }
      object.material = material; materials.push(material);
    });
    group.visible = true;
    return { group, update: (opening: number) => this.pose(parts, opening), dispose: () => {
      group.removeFromParent();
      for (const texture of textures) texture.dispose();
      for (const material of materials) material.dispose();
      group.clear();
    } };
  }

  private pose(
    parts: Map<string, THREE.Group>,
    opening: number,
  ) {
    // The choreography lives in terminal-deck-parts.ts so the Unreal port can be
    // diffed against it value by value; this only places the groups it returns.
    const pose = deckPose(opening);
    for (const [id, spec] of Object.entries(pose.parts)) {
      const group = parts.get(id);
      if (!group) continue;
      group.position.set(spec.position.x, spec.position.y, spec.position.z);
      group.rotation.set(spec.rotation.x, spec.rotation.y, spec.rotation.z);
    }
  }

  update(dt: number, time: number, reduced: boolean, opening: number, theme: number) {
    if (this.disposed) return;
    // The screen is readable through the original lightly frosted cover during
    // authentication. Opening the physical package still requires a real session.
    this.shell.setClarity?.(0.96 + 0.04 * opening);
    this.finishes.setTheme(theme);
    // The insert stays at its real coordinates; all enlargement is the camera.
    // The scene already eased this progress: the lid moves with the camera
    // from the first frame. Fasteners lead slightly and the rear follows,
    // without another delay or easing that would split the movement in two.
    this.pose(this.parts, opening);
    const own = this.client.target === this.host;
    const status = own ? this.client.status() : null;
    const phase = status?.phase ?? "idle";
    // Backlight level comes from the phase ssh actually reported, never from a
    // loop of its own (rule R1). The breathing is a modulation of a real state,
    // exactly like the cursor blink the screen already does. The formula lives
    // in terminal-deck-parts.ts so the Unreal port is diffed against it.
    const failed = own && phase === "failed";
    this.finishes.setBacklight(deckBacklight(own ? phase : "idle", reduced, time), failed);
    // What the card shows before the shell arrives is the list of milestones it
    // has reached, so a new milestone — not a new log line — is what repaints.
    const key = `${this.host}:${this.preview?.key}:${this.client.generation}:${phase}:${status?.timeline.length ?? 0}:${own ? (this.client.pendingPrompt?.id ?? "") : ""}:${own ? this.terminal.screenRevision : 0}:${this.terminal.screenTheme.background}:${Math.round(opening * 100)}:${own && phase === "interactive" && !reduced ? Math.floor(time * 1.6) : 0}`;
    if (key === this.painted || time - this.lastPaint < 1 / 15) return;
    this.lastPaint = time;
    this.painted = key;
    this.paint(time, reduced, own);
    this.texture.needsUpdate = true;
    this.group.userData.screenCurrent = this.texture.image === this.canvas;
  }

  private paint(time: number, reduced: boolean, own: boolean) {
    const { ctx, canvas, client } = this;
    const theme = this.terminal.screenTheme;
    const status = own ? client.status() : null;
    const interactive =
      own &&
      (status?.phase === "interactive" ||
        Boolean(client.exit && status?.facts.authMethod && client.output));
    const width = canvas.width,
      height = canvas.height,
      pad = 26,
      header = 44,
      footer = 28;
    ctx.fillStyle = theme.background!;
    ctx.fillRect(0, 0, width, height);
    // The physical screen keeps showing the live parser while the DOM terminal
    // is hidden during camera travel, in both directions.
    ctx.fillStyle = theme.foreground!;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.font = `600 22px ${TERMINAL_FONT}`;
    ctx.fillText(this.hostLabel || "SSH", pad, header / 2);
    ctx.font = "500 20px MiSans, sans-serif";
    ctx.textAlign = "right";
    ctx.fillStyle = theme.cursor!;
    ctx.fillText(this.preview ? "WORKSPACE" : status?.label ?? "未连接", width - pad, header / 2);
    ctx.strokeStyle = this.terminal.dark ? "#4a4d44" : "#c7c0b4";
    ctx.beginPath();
    ctx.moveTo(pad, header);
    ctx.lineTo(width - pad, header);
    ctx.moveTo(pad, height - footer);
    ctx.lineTo(width - pad, height - footer);
    ctx.stroke();
    const rect = {
      x: pad,
      y: header + 8,
      width: width - 2 * pad,
      height: height - header - footer - 16,
    };
    if (interactive) {
      paintTerminalBuffer(
        ctx,
        this.terminal.screenTerminal,
        theme,
        rect,
        status?.phase === "interactive" &&
          (reduced || Math.floor(time * 1.6) % 2 === 0),
      );
    } else {
      // The list of milestones this session has reached, not the `debug1:` lines
      // behind them: the raw stream is OpenSSH's own diagnostics, and it belongs
      // in 会话记录 where it can be read on purpose. The prompt is the session
      // actually asking something, so it stays.
      const lines = this.preview
        ? [...this.preview.lines]
        : own
          ? (status?.timeline ?? []).map((entry) => entry.label)
          : [];
      if (own && client.pendingPrompt) lines.push(client.pendingPrompt.prompt);
      const text = lines.length
        ? lines.join("\n")
        : own
          ? "等待 SSH 客户端输出…"
          : "选择 CONNECT 建立会话";
      const wrapped = text
        .split(/\r?\n/)
        .flatMap((line) => line.match(/.{1,100}/gu) ?? [""]);
      const rows = Math.floor(rect.height / 30),
        tail = wrapped.slice(-rows);
      ctx.save();
      ctx.beginPath();
      ctx.rect(rect.x, rect.y, rect.width, rect.height);
      ctx.clip();
      ctx.font = `22px ${TERMINAL_FONT}`;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillStyle = theme.foreground!;
      tail.forEach((line, i) => ctx.fillText(line, rect.x, rect.y + i * 30));
      ctx.restore();
    }
    ctx.font = `20px ${TERMINAL_FONT}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillStyle = theme.cursor!;
    ctx.fillText(
      this.preview ? "RHINE LAB / " + this.preview.key.split(":")[0].toUpperCase() : interactive ? "SSH / SESSION" : "SSH / AUTHENTICATION",
      pad,
      height - footer / 2,
    );
    ctx.textAlign = "right";
    ctx.fillText(
      own && client.pendingPrompt ? "等待认证" : "RHINE LAB",
      width - pad,
      height - footer / 2,
    );
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.group.removeFromParent();
    this.texture.dispose();
    disposeThreeTree(this.insert);
    this.shell.dispose();
    this.group.clear();
  }
}
