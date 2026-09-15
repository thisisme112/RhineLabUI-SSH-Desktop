import * as THREE from "three";
import { disposeThreeTree } from "../three-resources";
import { damp } from "../motion";
import type { SshClient } from "./client";
import type { SshTerminalPanel } from "./terminal";
import { paintTerminalBuffer, TERMINAL_FONT } from "./terminal-screen";
import { buildDeckInsert, DECK_PARTS, SCREEN, type DeckInsert } from "./terminal-deck-parts";
import "./deck-tools.css";

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
 * stack can be separated in place — the terminal's version of the archive's
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
  /** Normalized 0..1 separation of the insert's plates, on a spring. */
  private separation = { value: 0, velocity: 0 };
  private targetSpread = 0;
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

  /** Separated for inspection; the same spring `model-viewer.ts` uses. */
  setExploded(value: boolean, immediate = false) {
    this.targetSpread = value ? 1 : 0;
    if (immediate) this.separation = { value: this.targetSpread, velocity: 0 };
  }
  get exploded() {
    return this.targetSpread === 1;
  }
  get spread() {
    return this.separation.value;
  }

  private pose(
    parts: Map<string, THREE.Group>,
    opening: number,
    spread = 0,
  ) {
    const lid = opening, screws = 1 - (1 - opening) ** 2, rear = opening * (0.85 + 0.15 * opening);
    for (const name of ["cover", "fasteners"]) {
      const part = parts.get(name);
      if (!part) continue;
      part.position.set(-3.1 * lid, 1.85 + 2.5 * lid, 0.8 * lid + (name === "fasteners" ? .22 * screws : 0));
      part.rotation.set(-.16 * lid, -.45 * lid, .1 * lid);
    }
    const carrier = parts.get("carrier"), substrate = parts.get("substrate");
    if (carrier) { carrier.position.set(.45 * rear, 1.85 - .32 * rear, -.75 * rear); carrier.rotation.y = .12 * rear; }
    if (substrate) { substrate.position.set(-.22 * rear, 1.85 - .45 * rear, -.38 * rear); substrate.rotation.y = -.06 * rear; }
    // The insert's own plates. Names never overlap the package's, so opening
    // the box and separating the stack are two independent movements. They fan
    // on a diagonal as well as along z, because the only camera this is ever
    // seen from is nearly front-on (see DECK_PARTS).
    for (const spec of DECK_PARTS) {
      const part = parts.get(spec.id);
      if (!part) continue;
      part.position.set(
        spec.slide[0] * spread,
        SCREEN.y + spec.slide[1] * spread,
        spec.z + spec.depth * spread,
      );
    }
  }

  update(dt: number, time: number, reduced: boolean, opening: number, theme: number) {
    if (this.disposed) return;
    // The screen is readable through the original lightly frosted cover during
    // authentication. Opening the physical package still requires a real session.
    this.shell.setClarity?.(0.96 + 0.04 * opening);
    this.finishes.setTheme(theme);
    // The separation runs on its own clock rather than the paint gate below:
    // the stack has to keep moving even while the screen content is unchanged.
    damp(this.separation, this.targetSpread, reduced ? 45 : 5.5, dt);
    if (
      Math.abs(this.separation.value - this.targetSpread) < 0.0001 &&
      Math.abs(this.separation.velocity) < 0.001
    )
      this.separation = { value: this.targetSpread, velocity: 0 };
    // The insert stays at its real coordinates; all enlargement is the camera.
    // The scene already eased this progress: the lid moves with the camera
    // from the first frame. Fasteners lead slightly and the rear follows,
    // without another delay or easing that would split the movement in two.
    this.pose(this.parts, opening, this.separation.value);
    const own = this.client.target === this.host;
    const phase = own ? this.client.status().phase : "idle";
    // Backlight level comes from the phase ssh actually reported, never from a
    // loop of its own (rule R1). The breathing is a modulation of a real state,
    // exactly like the cursor blink the screen already does.
    const failed = own && phase === "failed";
    const settling =
      own &&
      ["resolving", "connecting", "handshake", "hostkey", "authenticating", "opening"].includes(
        phase,
      );
    this.finishes.setBacklight(
      failed
        ? 0.5
        : settling
          ? reduced
            ? 0.4
            : 0.28 + 0.08 * (1 + Math.sin(time * 3.4))
          : phase === "interactive"
            ? 0.4
            : 0.22,
      failed,
    );
    const key = `${this.host}:${this.preview?.key}:${this.client.generation}:${phase}:${own ? this.client.rawLog.length : 0}:${own ? (this.client.pendingPrompt?.id ?? "") : ""}:${own ? this.terminal.screenRevision : 0}:${this.terminal.dark}:${own && phase === "interactive" && !reduced ? Math.floor(time * 1.6) : 0}`;
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
      const lines = this.preview ? this.preview.lines : own ? [...client.rawLog] : [];
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
