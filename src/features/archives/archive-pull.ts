type Point = { x: number; y: number };

/** A pull starts on the selected file; all other drags keep browsing the plane. */
export class ArchivePull {
  active = false;
  private pending = false;
  private origin: Point = { x: 0, y: 0 };
  private projection: Point = { x: 0, y: -1 };
  private startHeight = 0;
  private endHeight = 0;
  private restHeight = .4;
  height = 0;

  start(x: number, y: number, projection: Point, height: number, endHeight: number, restHeight = .4) {
    this.reset();
    if (!Number.isFinite(projection.x + projection.y) || Math.hypot(projection.x, projection.y) < 1) return;
    this.pending = true;
    this.origin = { x, y };
    this.projection = projection;
    this.height = this.startHeight = height;
    this.endHeight = endHeight;
    this.restHeight = restHeight;
  }

  /** The first deliberate movement chooses extraction or ordinary free dragging. */
  move(x: number, y: number) {
    if (!this.pending && !this.active) return false;
    const dx = x - this.origin.x, dy = y - this.origin.y;
    const span = Math.hypot(this.projection.x, this.projection.y);
    const along = (dx * this.projection.x + dy * this.projection.y) / span;
    const across = (dx * this.projection.y - dy * this.projection.x) / span;
    if (this.pending) {
      if (Math.hypot(dx, dy) < 10) return true;
      this.pending = false;
      this.active = along >= 10 && along > Math.abs(across) * 1.5;
      if (!this.active) return false;
    }
    this.height = Math.max(this.restHeight, Math.min(this.endHeight, this.startHeight + along / span));
    return true;
  }

  get progress() {
    return this.endHeight > this.restHeight
      ? Math.max(0, (this.height - this.restHeight) / (this.endHeight - this.restHeight))
      : 0;
  }

  get ready() { return this.active && this.progress >= 0.4; }

  reset() {
    this.active = this.pending = false;
    this.height = this.startHeight = this.endHeight = 0;
  }
}
