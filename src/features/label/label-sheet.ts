import "./label.css";
import { setAttr, setData, setStyle } from "../../shared/dom-write";
import {
  BAND, DECODE, FIELD, FOOT, SPINE, TOP,
  chevrons, outline, outlinePath, picto, resolve, settle, sigilCells, sigilStep, slashes, zone,
} from "./label-kit";

/**
 * The archive home as a label (the Unreal build's RhineLabelHome.cpp): a field
 * of the signal colour carrying the selected file's number, a spine, the archive
 * array in a window ruled like a drawing sheet, and a foot that counts the files.
 * The top strip stays over the overview and the detail page too.
 *
 * The model is measured, not decorated: the leader's node sits on its printed
 * label, the note names the zone it stands in, and the top strip and the
 * window's frame give way where the selected archive stands in front of them.
 */
export type LabelPage = "archive" | "overview" | "detail";

export type LabelFile = {
  /** "H—" and "001": the file number, split where the figure begins. */
  prefix: string;
  code: string;
  name: string;
  /** `user@host:port` for a host; a line about the file otherwise. */
  address: string;
  /** The state chip (solid) and the second chip (outlined). */
  state: string;
  detail: string;
  /** Which of terminal, files, monitor, tunnel the file offers now. */
  services: readonly [boolean, boolean, boolean, boolean];
  /** What its 5 × 5 mark is made from. */
  mark: string;
};

export type LabelFrame = {
  page: LabelPage;
  time: number;
  reduced: boolean;
  /** The stage's width in stage units (it is 1080 tall). */
  width: number;
  /** How much of the stage's top the window's caption buttons keep (frameless Windows), in stage units. */
  inset: number;
  file: LabelFile;
  /** The column the file is in, and where in it. */
  lane: { index: number; count: number; name: string; position: number; files: readonly number[] };
  /** The selected archive on the stage: its printed label, and the corners of its parts. */
  probe: { pin: [number, number]; corners: [number, number][] } | null;
  /** A key the selection is known by: a new one decodes the figures again. */
  selection: string;
};

export type LabelActions = {
  /** 01: the overview from the home, the home from the overview, back out of a file. */
  primary(): void;
  search(): void;
  settings(): void;
  portals(): void;
  read(): void;
  select(index: number): void;
  step(direction: number): void;
  column(direction: number): void;
};

const SLOTS = 7;
const ARRIVAL = 3.2;

export class LabelSheet {
  readonly root = document.createElement("div");
  private els: Record<string, HTMLElement | SVGElement> = {};
  private changedAt = -10;
  private selection = "";
  private markFrom: string | undefined;
  private mark = "";
  private width = 0;
  private inset = -1;
  private hull = "";
  private pin = "";
  private arrivedAt = -10;
  private page: LabelPage | "" = "";
  private second = -1;
  private ruler: HTMLButtonElement[] = [];
  private rulerFiles: number[] = [];

  constructor(private stage: HTMLElement, private actions: LabelActions, demo = false) {
    this.root.className = "label-sheet";
    this.root.setAttribute("aria-hidden", "false");
    const arrive = (delay: number) => `data-arrive style="--d:${delay}"`;
    this.root.innerHTML = `
      <div class="label-home">
        <div class="label-field-reveal"><section class="label-field label-cut-tr" aria-label="已选档案">
          <span class="label-field-kicker label-note" ${arrive(1.3)}>FILE NO. / 档案编号</span>
          <span class="label-field-prefix label-figure" ${arrive(1.35)}></span>
          <span class="label-field-figure label-figure" data-slit data-figure="field"></span>
          <div class="label-field-name" ${arrive(1.75)}><span></span></div>
          <span class="label-field-address" ${arrive(1.85)}></span>
          <div class="label-field-chips" ${arrive(1.95)}><span class="label-chip label-cut-br" data-solid></span><span class="label-chip"></span></div>
          <div class="label-field-services">${[0, 1, 2, 3].map(kind => `<span ${arrive(2.05 + kind * .07)} data-picto="${kind}">${picto(kind)}</span>`).join("")}<span class="label-services-note" ${arrive(2.35)}><span class="label-note">SERVICES</span><span>可用服务</span></span></div>
          <svg class="label-field-sigil label-sigil" viewBox="0 0 5 5" ${arrive(1.8)} aria-hidden="true"></svg>
          <div class="label-field-slashes" ${arrive(2.4)}></div>
        </section></div>
        <div class="label-spine" aria-hidden="true"><span ${arrive(1.7)}>${chevrons()}</span><span class="label-spine-text label-note" ${arrive(1.8)}></span></div>
        <div class="label-window">
          <svg class="label-zone" aria-hidden="true"><defs><clipPath id="label-zone-hole"><path clip-rule="evenodd"/></clipPath></defs><g clip-path="url(#label-zone-hole)"><path class="label-ground" data-zone="ground-top"/><path class="label-rule" data-zone="rule-top"/></g><path class="label-ground" data-zone="ground-side"/><path class="label-rule" data-zone="rule-side"/><path class="label-tick" data-zone="ticks"/><g data-zone="marks"></g></svg>
          <span class="label-fig label-note" ${arrive(1.7)}>FIG. 01 — 档案阵列</span>
          <div class="label-selected label-cut-br" ${arrive(2.15)} aria-hidden="true"><span class="label-note">SELECTED / 已选中</span><span class="label-selected-zone label-figure" data-slit></span><p>点击读取 · 按住向上抽出</p></div>
          <button type="button" class="label-read" data-label-action="read" aria-label="读取档案"><span class="label-read-text label-cut-tl"><b>读取档案</b><span class="label-note">ACCESS FILE · ENTER</span></span><span class="label-read-go" aria-hidden="true">→</span></button>
        </div>
        <footer class="label-foot">
          <div class="label-foot-count" aria-hidden="true"><span class="label-figure" data-figure="count"></span><span class="label-foot-total"></span></div>
          <div class="label-ruler" role="group" aria-label="本列档案">${Array.from({ length: SLOTS }, (_, i) => `<button type="button" class="label-cut-tr" data-slot="${i}" ${arrive(1.5 + i * .06)}></button>`).join("")}</div>
          <div class="label-keys" ${arrive(1.9)}><button type="button" class="label-key" data-label-action="prev" aria-label="上一个档案">←</button><button type="button" class="label-key" data-label-action="next" aria-label="下一个档案">→</button><span>前后档案</span><button type="button" class="label-key" data-label-action="column-prev" aria-label="上一列">↑</button><button type="button" class="label-key" data-label-action="column-next" aria-label="下一列">↓</button><span>切换列</span></div>
          <div class="label-powered" ${arrive(2.0)}>POWERED BY <b>RHINE LAB</b><i></i></div>
        </footer>
      </div>
      <header class="label-top">
        <svg class="label-top-ground" aria-hidden="true"><defs><clipPath id="label-top-hole"><path clip-rule="evenodd"/></clipPath></defs><g clip-path="url(#label-top-hole)"><path class="label-ground"/><path class="label-rule"/></g></svg>
        <div class="label-top-row">
          <span class="label-brand">RHINE LAB<span>ANALYSIS OS</span></span>
          <span class="label-system label-note">ARCHIVE SYSTEM — SSH WORKSPACE${demo ? " · 演示模式" : ""}</span>
          <nav class="label-nav" aria-label="系统导航">
            <button type="button" data-label-action="primary"><b></b><span></span></button>
            <button type="button" data-label-action="search"><b>02</b><span>检索</span></button>
            <button type="button" data-label-action="settings"><b>03</b><span>设置</span></button>
            <button type="button" data-label-action="portals"><b>04</b><span>空间入口</span></button>
          </nav>
          <span class="label-clock" aria-hidden="true">00:00:00</span>
        </div>
      </header>
      <svg class="label-leader" aria-hidden="true"><polyline/><rect class="label-node-ink" width="18" height="18"/><rect class="label-node" width="12" height="12"/></svg>`;
    const q = <T extends Element>(selector: string) => this.root.querySelector(selector) as unknown as T;
    this.els = {
      prefix: q(".label-field-prefix"), figure: q(".label-field-figure"), name: q(".label-field-name span"), address: q(".label-field-address"),
      state: q(".label-chip[data-solid]"), detail: q(".label-chip:not([data-solid])"), sigil: q(".label-field-sigil"), slashes: q(".label-field-slashes"),
      spine: q(".label-spine-text"), zoneFigure: q(".label-selected-zone"), count: q('[data-figure="count"]'), total: q(".label-foot-total"),
      primary: q('[data-label-action="primary"]'), clock: q(".label-clock"), topGround: q(".label-top-ground"), zone: q(".label-zone"),
      topHole: q("#label-top-hole path"), zoneHole: q("#label-zone-hole path"), leader: q(".label-leader"),
      leaderLine: q(".label-leader polyline"), nodeInk: q(".label-node-ink"), node: q(".label-node"),
    };
    this.ruler = [...this.root.querySelectorAll<HTMLButtonElement>(".label-ruler button")];
    this.els.prefix.textContent = "H—";
    this.root.addEventListener("click", event => {
      const button = (event.target as Element).closest<HTMLElement>("button");
      if (!button || !this.root.contains(button)) return;
      if (button.dataset.slot !== undefined) {
        const index = this.rulerFiles[Number(button.dataset.slot)];
        if (index !== undefined) this.actions.select(index);
        return;
      }
      switch (button.dataset.labelAction) {
        case "primary": this.actions.primary(); break;
        case "search": this.actions.search(); break;
        case "settings": this.actions.settings(); break;
        case "portals": this.actions.portals(); break;
        case "read": this.actions.read(); break;
        case "prev": this.actions.step(-1); break;
        case "next": this.actions.step(1); break;
        case "column-prev": this.actions.column(-1); break;
        case "column-next": this.actions.column(1); break;
      }
    });
    stage.append(this.root);
    // The giant figure is sized by the condensed face's own widths, once it has loaded.
    document.fonts.addEventListener("loadingdone", () => this.fitFigures());
    void document.fonts.load(`700 100px "Barlow Condensed"`, "0123456789—").then(() => this.fitFigures(), () => {});
  }

  /** The home arrives piece by piece (Unreal LabelIn): once after the opening, and after every replay. */
  arrive(time: number) {
    this.arrivedAt = time;
    this.root.dataset.arriving = "";
  }

  update(frame: LabelFrame) {
    const { time, file } = frame;
    if (frame.page !== this.page) {
      this.page = frame.page;
      setData(this.root, "page", frame.page);
    }
    if (this.root.dataset.arriving !== undefined && (frame.reduced || time - this.arrivedAt > ARRIVAL)) delete this.root.dataset.arriving;
    if (frame.width !== this.width || frame.inset !== this.inset) this.layout(frame.width, frame.inset);
    if (frame.selection !== this.selection) {
      if (this.selection) { this.markFrom = this.mark; this.changedAt = time; }
      this.selection = frame.selection;
      this.mark = file.mark;
    }
    const changed = frame.reduced ? 1 : Math.min(1, (time - this.changedAt) / DECODE);
    // The top strip: 01 changes with the page, the clock with the second.
    const primary = this.els.primary as HTMLElement;
    const [number, label] = frame.page === "detail" ? ["ESC", "返回"] : frame.page === "overview" ? ["01", "档案阵列"] : ["01", "主机总览"];
    if (primary.firstElementChild!.textContent !== number) primary.firstElementChild!.textContent = number;
    if (primary.lastElementChild!.textContent !== label) primary.lastElementChild!.textContent = label;
    const second = Math.floor(Date.now() / 1000);
    if (second !== this.second) {
      this.second = second;
      this.els.clock.textContent = new Date().toLocaleTimeString("en-GB", { hour12: false });
    }
    this.probe(frame);
    if (frame.page !== "archive") return;

    // The field: the selected file's label.
    const arrived = frame.reduced ? 1 : Math.min(1, (time - this.arrivedAt - .9) / (DECODE + .2));
    this.text("prefix", file.prefix);
    this.text("figure", resolve(file.code, Math.min(arrived, changed), time));
    this.text("name", file.name);
    this.text("address", file.address);
    this.text("state", file.state);
    this.text("detail", file.detail);
    this.root.querySelectorAll<HTMLElement>("[data-picto]").forEach((tile, kind) => {
      const svg = tile.firstElementChild!;
      if (file.services[kind]) svg.setAttribute("data-on", ""); else svg.removeAttribute("data-on");
    });
    const sigil = this.els.sigil as SVGElement;
    const step = `${file.mark}|${this.markFrom ?? ""}|${sigilStep(changed)}`;
    if (sigil.dataset.step !== step) {
      sigil.dataset.step = step;
      sigil.innerHTML = sigilCells(file.mark, this.markFrom, changed);
    }
    this.text("spine", `INTERNAL DATABASE — COLUMN ${pad(frame.lane.index + 1)} / ${pad(frame.lane.count)} — ${frame.lane.name}`);

    // The foot: which file of how many, and up to seven of the column with the selected one in view.
    const { files, position } = frame.lane;
    this.text("count", resolve(pad(position + 1), changed * 1.6, time));
    this.text("total", `/ ${pad(files.length)}`);
    const first = Math.min(Math.max(0, position - 3), Math.max(0, files.length - SLOTS));
    this.rulerFiles = files.slice(first, first + SLOTS) as number[];
    this.ruler.forEach((button, slot) => {
      const index = first + slot;
      button.hidden = index >= files.length;
      const text = pad(index + 1);
      if (button.textContent !== text) button.textContent = text;
      setAttr(button, "aria-pressed", String(index === position));
      setAttr(button, "aria-label", `第 ${index + 1} 个档案`);
    });

    // The note names the zone the archive's label stands in.
    const window = this.windowSize(frame.width);
    const pin = frame.probe?.pin;
    this.text("zoneFigure", pin ? resolve(zone(pin[0] - FIELD - SPINE, pin[1] - this.head(), window.width, window.height), changed, time) : "A—01");
  }

  /** The archive's outline cuts the top strip and the window's frame; the leader follows its label. */
  private probe(frame: LabelFrame) {
    const head = this.head();
    const hull = frame.probe && frame.page !== "detail" ? outline(frame.probe.corners, 2.5) : [];
    const hole = outlinePath(hull);
    if (hole !== this.hull) {
      this.hull = hole;
      const everything = "M-99999,-99999H99999V99999H-99999Z";
      this.els.topHole.setAttribute("d", everything + hole);
      this.els.zoneHole.setAttribute("d", everything + outlinePath(hull, FIELD + SPINE, head));
    }
    const pin = frame.page === "archive" ? frame.probe?.pin : undefined;
    // The leader draws itself in after arriving, and again after every change of file.
    const draw = frame.reduced ? 1 : settle((frame.time - this.arrivedAt - 1.95) / .45) * settle((frame.time - this.changedAt - .12) / .45);
    const key = pin ? `${pin[0].toFixed(1)},${pin[1].toFixed(1)},${draw.toFixed(3)},${head}` : "";
    if (key === this.pin) return;
    this.pin = key;
    const leader = this.els.leader as SVGElement;
    setStyle(leader as unknown as HTMLElement, "display", pin && draw > 0 ? "" : "none");
    if (!pin || draw <= 0) return;
    const a: [number, number] = [FIELD + SPINE + 200, head + 470], b = pin;
    const corner = Math.min(30, Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
    const sx = b[0] >= a[0] ? 1 : -1, sy = b[1] >= a[1] ? 1 : -1;
    const path: [number, number][] = [a, [a[0], b[1] - sy * corner], [a[0] + sx * corner, b[1]], b];
    const lengths = path.slice(1).map((p, i) => Math.hypot(p[0] - path[i][0], p[1] - path[i][1]));
    let left = lengths.reduce((s, l) => s + l, 0) * draw;
    const points = [path[0]];
    for (let i = 0; i < 3 && left > 0; i++) {
      const t = Math.min(1, left / Math.max(lengths[i], .001));
      points.push([path[i][0] + (path[i + 1][0] - path[i][0]) * t, path[i][1] + (path[i + 1][1] - path[i][1]) * t]);
      left -= lengths[i];
    }
    this.els.leaderLine.setAttribute("points", points.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" "));
    const landed = draw >= 1;
    for (const [node, size] of [[this.els.nodeInk, 18], [this.els.node, 12]] as const) {
      node.setAttribute("x", String(b[0] - size / 2));
      node.setAttribute("y", String(b[1] - size / 2));
      node.setAttribute("visibility", landed ? "visible" : "hidden");
    }
  }

  /** Lays out what depends on the stage's width and the caption inset: the frame's zones, the strip's ground, the slashes. */
  private layout(width: number, inset: number) {
    this.width = width;
    this.inset = inset;
    // On the stage, so every length derived from it there (the strip, the portals under it) agrees.
    setStyle(this.stage, "--label-inset", `${inset}px`);
    this.fitFigures();
    const head = this.head(), { width: w, height: h } = this.windowSize(width);
    const top = this.els.topGround as SVGElement;
    top.setAttribute("viewBox", `0 0 ${width} ${head}`);
    top.querySelector(".label-ground")!.setAttribute("d", `M0,0H${width}V${head - 3}H0Z`);
    top.querySelector(".label-rule")!.setAttribute("d", `M0,${head - 3}H${width}V${head}H0Z`);
    const zoneSvg = this.els.zone as SVGElement;
    zoneSvg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    zoneSvg.setAttribute("width", String(w));
    zoneSvg.setAttribute("height", String(h));
    const set = (key: string, d: string) => zoneSvg.querySelector(`[data-zone="${key}"]`)!.setAttribute("d", d);
    set("ground-top", `M0,0H${w}V${BAND - 2}H0Z`);
    set("rule-top", `M${BAND - 2},${BAND - 2}H${w}V${BAND}H${BAND - 2}Z`);
    set("ground-side", `M0,${BAND - 2}H${BAND}V${h}H0Z`);
    set("rule-side", `M${BAND - 2},${BAND - 2}H${BAND}V${h}H${BAND - 2}Z`);
    const wide = (w - BAND) / 8, high = (h - BAND) / 6;
    let ticks = "", marks = "";
    for (let i = 0; i < 8; i++) {
      if (i) ticks += `M${BAND + i * wide - 1},0h2v${BAND}h-2Z`;
      marks += `<text x="${BAND + (i + .5) * wide}" y="${BAND / 2 - 1}">${i + 1}</text>`;
    }
    for (let i = 0; i < 6; i++) {
      if (i) ticks += `M0,${BAND + i * high - 1}h${BAND}v2h-${BAND}Z`;
      marks += `<text x="${BAND / 2 - 1}" y="${BAND + (i + .5) * high}">${String.fromCharCode(65 + i)}</text>`;
    }
    set("ticks", ticks);
    zoneSvg.querySelector('[data-zone="marks"]')!.innerHTML = marks;
    this.els.slashes.innerHTML = slashes(FIELD - 56 - 150);
    this.hull = "\u0000";
    this.pin = "";
  }

  /**
   * The field's figure is the sheet's one giant number, shrunk to fit "000" in the field's width
   * (SRhineFigure Pixels 430, MaxWidth, Sample). Slate measures Barlow's figures with their side
   * bearings and lands on 386 px; the browser's narrower measure would keep 430, so 386 is the limit.
   */
  private fitFigures() {
    const field = this.els.figure as HTMLElement;
    const measure = document.createElement("canvas").getContext("2d");
    if (!measure) return;
    measure.font = `700 100px "Barlow Condensed"`;
    const wide = measure.measureText("000").width * 4.3;
    const px = wide > 0 && document.fonts.check(`700 100px "Barlow Condensed"`) ? Math.min(386, Math.floor(430 * (FIELD - 112) / wide)) : 386;
    setStyle(field, "--px", `${px}px`);
  }

  /** The sheet's top: the strip, and the Windows caption over it. */
  private head() {
    return Math.max(0, this.inset) + TOP;
  }
  private windowSize(width: number) {
    return { width: width - FIELD - SPINE, height: 1080 - this.head() - FOOT };
  }
  private text(key: string, value: string) {
    const node = this.els[key];
    if (node.textContent !== value) node.textContent = value;
  }
}

const pad = (value: number) => String(value).padStart(2, "0");
