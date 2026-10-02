import "./label.css";
import "./label-overview.css";
import "./label-detail.css";
import { setAttr, setData, setStyle } from "../../shared/dom-write";
import {
  BAND, DECODE, FIELD, FOOT, SPINE, TOP,
  chevrons, outline, outlinePath, picto, resolve, settle, sigilCells, sigilStep, slashes, zone,
} from "./label-kit";

/**
 * The label design's sheet over the stage (the Unreal build's RhineLabelHome.cpp,
 * RhineLabelOverview.cpp and RhineLabelDetail.cpp):
 *
 *   home      a field of the signal colour carrying the selected file's number, a
 *             spine, the archive in a window ruled like a drawing sheet, a foot
 *             that counts the files
 *   overview  the ground round the shelf's window (the timetable itself is the
 *             overview sheet, label-overview.css)
 *   detail    the inspection sheet: the frame ruled into zones, two notes pinned to
 *             the model that follow it as it turns, the turn read out in degrees
 *
 * and the top strip over all three. The model is measured, not decorated: the
 * leaders' nodes sit on its printed label and its screen, the note names the zone
 * it stands in, and the strip and the frames give way where it stands in front.
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
  /** A host (its model opens into parts), or an authored file. */
  host: boolean;
};

/** The selected archive on the stage (stage units), from the scene. */
export type LabelProbe = {
  /** Its printed label, and a point low on its face where the session screen is. */
  pin: [number, number];
  screen: [number, number];
  /** The corners of every visible part: the frames give way to their outline. */
  corners: [number, number][];
  /** How far it has been turned, in degrees, and how far the camera has gone into the file (0..1). */
  yaw: number;
  detail: number;
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
  probe: LabelProbe | null;
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
/** Where the document column starts on the detail page (SshWorkbenchDetail.cpp ColL); the inspection sheet ends a gutter before it. */
export const DOCUMENT_LEFT = .60104167;
const sheetRight = (width: number) => DOCUMENT_LEFT * width - 40;

type Leader = { line: SVGPolylineElement; ink: SVGRectElement; node: SVGRectElement; key: string };

export class LabelSheet {
  readonly root = document.createElement("div");
  private els: Record<string, HTMLElement | SVGElement> = {};
  private leaders: Leader[] = [];
  private changedAt = -10;
  private selection = "";
  private markFrom: string | undefined;
  private mark = "";
  private width = 0;
  private inset = -1;
  private hull = "";
  private arrivedAt = -10;
  private page: LabelPage | "" = "";
  private openedAt = -10;
  private second = -1;
  private ruler: HTMLButtonElement[] = [];
  private pictos: SVGElement[] = [];
  private rulerFiles: number[] = [];
  private documentFigure: HTMLElement | null = null;

  constructor(private stage: HTMLElement, private actions: LabelActions, demo = false) {
    this.root.className = "label-sheet";
    const arrive = (delay: number) => `data-arrive style="--d:${delay}"`;
    const zoneFrame = (id: string) => `<svg class="label-zone" aria-hidden="true"><defs><clipPath id="${id}"><path clip-rule="evenodd"/></clipPath></defs><g clip-path="url(#${id})"><path class="label-ground" data-zone="ground-top"/><path class="label-rule" data-zone="rule-top"/></g><path class="label-ground" data-zone="ground-side"/><path class="label-rule" data-zone="rule-side"/><path class="label-tick" data-zone="ticks"/><g data-zone="marks"></g></svg>`;
    const leader = '<g class="label-leader"><polyline/><rect class="label-node-ink" width="18" height="18"/><rect class="label-node" width="12" height="12"/></g>';
    this.root.innerHTML = `
      <div class="label-home">
        <div class="label-field-reveal"><section class="label-field label-cut-tr" aria-label="已选档案">
          <span class="label-field-kicker label-note" ${arrive(1.3)}>FILE NO. / 档案编号</span>
          <span class="label-field-prefix label-figure" ${arrive(1.35)}></span>
          <span class="label-field-figure label-figure" data-slit></span>
          <div class="label-field-name" ${arrive(1.75)}><span></span></div>
          <span class="label-field-address" ${arrive(1.85)}></span>
          <div class="label-field-chips" ${arrive(1.95)}><span class="label-chip label-cut-br" data-solid></span><span class="label-chip"></span></div>
          <div class="label-field-services">${[0, 1, 2, 3].map(kind => `<span ${arrive(2.05 + kind * .07)}>${picto(kind)}</span>`).join("")}<span class="label-services-note" ${arrive(2.35)}><span class="label-note">SERVICES</span><span>可用服务</span></span></div>
          <svg class="label-field-sigil label-sigil" viewBox="0 0 5 5" ${arrive(1.8)} aria-hidden="true"></svg>
          <div class="label-field-slashes" ${arrive(2.4)}></div>
        </section></div>
        <div class="label-spine" aria-hidden="true"><span ${arrive(1.7)}>${chevrons()}</span><span class="label-spine-text label-note" ${arrive(1.8)}></span></div>
        <div class="label-window" data-frame="home">
          ${zoneFrame("label-home-hole")}
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
      <div class="label-overview" aria-hidden="true">
        <svg class="label-overview-ground"><defs><clipPath id="label-overview-hole"><path clip-rule="evenodd"/></clipPath></defs><g clip-path="url(#label-overview-hole)"><path class="label-ground" data-overview="around"/><path class="label-rule" data-overview="rule"/></g><path class="label-ground" data-overview="table"/></svg>
        <span class="label-fig label-note label-overview-fig">FIG. 02 — 货架 · 悬停一行，它的档案升起</span>
      </div>
      <div class="label-detail" data-frame="detail">
        ${zoneFrame("label-detail-hole")}
        <span class="label-fig label-note label-detail-fig" aria-hidden="true"></span>
        <span class="label-tag label-cut-br" data-tag="1" aria-hidden="true"><b>01</b>标签 · 与右侧编号同源</span>
        <span class="label-tag label-cut-br" data-tag="2" aria-hidden="true"><b>02</b>屏幕 · 会话实时预览</span>
        <div class="label-yaw" aria-hidden="true"><span class="label-note"></span><span class="label-figure"></span></div>
        <button type="button" class="label-viewer" data-action="model-viewer"></button>
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
      <svg class="label-leaders" aria-hidden="true">${leader.repeat(3)}</svg>`;
    const q = <T extends Element>(selector: string) => this.root.querySelector(selector) as unknown as T;
    this.els = {
      prefix: q(".label-field-prefix"), figure: q(".label-field-figure"), name: q(".label-field-name span"), address: q(".label-field-address"),
      state: q(".label-chip[data-solid]"), detail: q(".label-chip:not([data-solid])"), sigil: q(".label-field-sigil"), slashes: q(".label-field-slashes"),
      spine: q(".label-spine-text"), zoneFigure: q(".label-selected-zone"), count: q('[data-figure="count"]'), total: q(".label-foot-total"),
      primary: q('[data-label-action="primary"]'), clock: q(".label-clock"), topGround: q(".label-top-ground"),
      homeZone: q('[data-frame="home"] .label-zone'), detailZone: q('[data-frame="detail"] .label-zone'),
      topHole: q("#label-top-hole path"), homeHole: q("#label-home-hole path"), detailHole: q("#label-detail-hole path"), overviewHole: q("#label-overview-hole path"),
      overviewGround: q(".label-overview-ground"), detailFig: q(".label-detail-fig"), tag1: q('[data-tag="1"]'), tag2: q('[data-tag="2"]'),
      yawNote: q(".label-yaw .label-note"), yaw: q(".label-yaw .label-figure"), viewer: q(".label-viewer"),
    };
    this.leaders = [...this.root.querySelectorAll<SVGGElement>(".label-leaders .label-leader")].map(group => ({
      line: group.querySelector("polyline")!, ink: group.querySelector(".label-node-ink")!, node: group.querySelector(".label-node")!, key: "",
    }));
    this.ruler = [...this.root.querySelectorAll<HTMLButtonElement>(".label-ruler button")];
    this.pictos = [...this.root.querySelectorAll<SVGElement>(".label-field-services .label-picto")];
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
      if (frame.page === "detail") { this.openedAt = time; this.documentFigure = null; }
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
    this.cut(frame);
    if (frame.page === "archive") this.home(frame, changed);
    else this.leader(0, null, 0);
    if (frame.page === "detail") this.inspect(frame);
    else { this.leader(1, null, 0); this.leader(2, null, 0); }
  }

  /** The selected archive's outline on the stage, as last cut: the page turn leaves it open too. */
  hullPoints: [number, number][] = [];

  /** The archive's outline cuts the top strip and the frames. */
  private cut(frame: LabelFrame) {
    const hull = frame.probe ? outline(frame.probe.corners, 2.5) : [];
    this.hullPoints = hull;
    const hole = outlinePath(hull);
    if (hole === this.hull) return;
    this.hull = hole;
    const everything = "M-99999,-99999H99999V99999H-99999Z", head = this.head();
    this.els.topHole.setAttribute("d", everything + hole);
    this.els.overviewHole.setAttribute("d", everything + hole);
    this.els.homeHole.setAttribute("d", everything + outlinePath(hull, FIELD + SPINE, head));
    this.els.detailHole.setAttribute("d", everything + outlinePath(hull, 0, head));
  }

  private home(frame: LabelFrame, changed: number) {
    const { time, file } = frame;
    // The field: the selected file's label.
    const arrived = frame.reduced ? 1 : Math.min(1, (time - this.arrivedAt - .9) / (DECODE + .2));
    this.text("prefix", file.prefix);
    this.text("figure", resolve(file.code, Math.min(arrived, changed), time));
    this.text("name", file.name);
    this.text("address", file.address);
    this.text("state", file.state);
    this.text("detail", file.detail);
    this.pictos.forEach((svg, kind) => {
      if (file.services[kind] !== svg.hasAttribute("data-on")) svg.toggleAttribute("data-on", file.services[kind]);
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

    // The note names the zone the archive's label stands in; its leader runs to that label. It draws
    // itself in after arriving, and again after every change of file.
    const head = this.head(), pin = frame.probe?.pin;
    this.text("zoneFigure", pin ? resolve(zone(pin[0] - FIELD - SPINE, pin[1] - head, frame.width - FIELD - SPINE, 1080 - head - FOOT), changed, time) : "A—01");
    const draw = frame.reduced ? 1 : settle((time - this.arrivedAt - 1.95) / .45) * settle((time - this.changedAt - .12) / .45);
    this.leader(0, pin ? [[FIELD + SPINE + 200, head + 470], pin] : null, draw);
  }

  /** The inspection sheet: its two notes follow the model, the turn is read out, the document's number resolves. */
  private inspect(frame: LabelFrame) {
    const { file, probe } = frame, head = this.head(), right = sheetRight(frame.width);
    this.text("detailFig", `FIG. 03 — ${file.host ? "主机档案" : "档案"} ${file.prefix.replace("—", "-")}${file.code}`);
    this.text("yawNote", file.services[1] ? "YAW / 点击模型打开终端 · 拖动检查" : "YAW / 拖动检查模型");
    const degrees = Math.round(probe?.yaw ?? 0);
    this.text("yaw", `${degrees < 0 ? "−" : "+"}${String(Math.abs(degrees)).padStart(3, "0")}°`);
    this.text("viewer", file.host ? "拆解模型 ↗" : "360° 查看文档模型 ↗");
    const first: [number, number] = [BAND + 38, head + BAND + 86], second: [number, number] = [right - 392, 1080 - 170];
    setStyle(this.els.tag1 as HTMLElement, "translate", `${first[0]}px ${first[1]}px`);
    setStyle(this.els.tag2 as HTMLElement, "translate", `${second[0]}px ${second[1]}px`);
    const detail = probe?.detail ?? 0;
    this.leader(1, probe ? [[first[0] + 30, first[1] + 46], probe.pin] : null, frame.reduced ? 1 : settle((detail - .75) / .25));
    this.leader(2, probe ? [[second[0] + 30, second[1]], probe.screen] : null, frame.reduced ? 1 : settle((detail - .8) / .2));
    // The number at the head of the document resolves as the document comes up.
    this.documentFigure ??= this.stage.querySelector<HTMLElement>("#detail-content .detail-label-figure");
    const figure = this.documentFigure;
    if (figure?.isConnected) {
      const value = resolve(figure.dataset.final ?? "", frame.reduced ? 1 : Math.min(1, (frame.time - this.openedAt - .3) / (DECODE * 1.5)), frame.time);
      if (figure.textContent !== value) figure.textContent = value;
    } else this.documentFigure = null;
  }

  /**
   * A leader from a note to a point on the model (SRhineLeader): up, one 45-degree corner, across, and a
   * node on the point. `draw` grows it from the note; the node lands when it is whole.
   */
  private leader(index: number, ends: [[number, number], [number, number]] | null, draw: number) {
    const leader = this.leaders[index];
    const key = ends && draw > 0 ? `${ends[0][0].toFixed(1)},${ends[0][1].toFixed(1)},${ends[1][0].toFixed(1)},${ends[1][1].toFixed(1)},${draw.toFixed(3)}` : "";
    if (key === leader.key) return;
    leader.key = key;
    const group = leader.line.parentElement as unknown as SVGGElement;
    group.style.display = key ? "" : "none";
    if (!ends || !key) return;
    const [a, b] = ends;
    const corner = Math.min(30, Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
    const sx = b[0] >= a[0] ? 1 : -1, sy = b[1] >= a[1] ? 1 : -1;
    const path: [number, number][] = [a, [a[0], b[1] - sy * corner], [a[0] + sx * corner, b[1]], b];
    const lengths = path.slice(1).map((p, i) => Math.hypot(p[0] - path[i][0], p[1] - path[i][1]));
    let left = lengths.reduce((s, l) => s + l, 0) * Math.min(1, draw);
    const points = [path[0]];
    for (let i = 0; i < 3 && left > 0; i++) {
      const t = Math.min(1, left / Math.max(lengths[i], .001));
      points.push([path[i][0] + (path[i + 1][0] - path[i][0]) * t, path[i][1] + (path[i + 1][1] - path[i][1]) * t]);
      left -= lengths[i];
    }
    leader.line.setAttribute("points", points.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" "));
    for (const [node, size] of [[leader.ink, 18], [leader.node, 12]] as const) {
      node.setAttribute("x", String(b[0] - size / 2));
      node.setAttribute("y", String(b[1] - size / 2));
      node.setAttribute("visibility", draw >= .995 ? "visible" : "hidden");
    }
  }

  /** Lays out what depends on the stage's width and the caption inset: the frames, the strip's ground, the slashes. */
  private layout(width: number, inset: number) {
    this.width = width;
    this.inset = inset;
    // On the viewport, so every length derived from it agrees: the strip, the portals, the overview sheet.
    setStyle(this.stage.parentElement ?? this.stage, "--label-inset", `${inset}px`);
    this.fitFigures();
    const head = this.head();
    const top = this.els.topGround as SVGElement;
    top.setAttribute("viewBox", `0 0 ${width} ${head}`);
    top.querySelector(".label-ground")!.setAttribute("d", `M0,0H${width}V${head - 3}H0Z`);
    top.querySelector(".label-rule")!.setAttribute("d", `M0,${head - 3}H${width}V${head}H0Z`);
    this.zoneFrame(this.els.homeZone as SVGElement, width - FIELD - SPINE, 1080 - head - FOOT);
    this.zoneFrame(this.els.detailZone as SVGElement, sheetRight(width), 1080 - head);
    // The overview's ground (RhineLabelOverview.cpp): the side column, the band above the shelf's window
    // with the window's top rule, and the right margin give way to the raised archive; the table does not.
    const overview = this.els.overviewGround as SVGElement, side = 512, margin = 64, shelf = head + 232;
    overview.setAttribute("viewBox", `0 0 ${width} 1080`);
    const draw = (key: string, d: string) => overview.querySelector(`[data-overview="${key}"]`)!.setAttribute("d", d);
    draw("around", `M0,${head}H${side}V1080H0Z M${side},${head}H${width - margin}V${head + 29}H${side}Z M${width - margin},${head}H${width}V${shelf}H${width - margin}Z`);
    draw("rule", `M${side},${head + 29}H${width - margin}V${head + 32}H${side}Z`);
    draw("table", `M${side},${shelf}H${width}V1080H${side}Z`);
    this.els.slashes.innerHTML = slashes(FIELD - 56 - 150);
    this.hull = "\u0000";
    for (const leader of this.leaders) leader.key = "\u0000";
  }

  /** A window ruled like a drawing sheet (SRhineZoneFrame): zones 1..8 along the top, A..F down the side. */
  private zoneFrame(svg: SVGElement, w: number, h: number) {
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    svg.setAttribute("width", String(w));
    svg.setAttribute("height", String(h));
    const set = (key: string, d: string) => svg.querySelector(`[data-zone="${key}"]`)!.setAttribute("d", d);
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
    svg.querySelector('[data-zone="marks"]')!.innerHTML = marks;
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
  private text(key: string, value: string) {
    const node = this.els[key];
    if (node.textContent !== value) node.textContent = value;
  }
}

/**
 * The head of the document on the detail page (MakeLabelDetailHeader): the same label the home shows, so
 * the number on the model and the number beside it are one thing. Its figure is resolved by the sheet.
 */
export function labelDocumentHeader(file: LabelFile, escape: (value: string) => string) {
  const final = `${file.prefix}${file.code}`;
  return `<header class="detail-label label-cut-br" aria-hidden="true"><span class="label-note">FILE NO. / 档案编号</span><span class="label-figure detail-label-figure" data-slit data-final="${escape(final)}">${escape(final)}</span><strong>${escape(file.name)}</strong><span class="detail-label-address">${escape(file.address)}</span><svg class="label-sigil" viewBox="0 0 5 5">${sigilCells(file.mark, undefined, 1)}</svg><span class="label-chip label-cut-br" data-solid id="host-state-label">${escape(file.state)}</span></header>`;
}

const pad = (value: number) => String(value).padStart(2, "0");
