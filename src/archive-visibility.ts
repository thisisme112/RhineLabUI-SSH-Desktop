import * as THREE from 'three';
import { COLUMN_SPACING, ROW_SPACING, type ArchiveCell } from './archive-loop.ts';

const edges = [[0,1],[0,2],[0,4],[1,3],[1,5],[2,3],[2,6],[3,7],[4,5],[4,6],[5,7],[6,7]];
/** A view-aligned pool, clipped to the height slab the array can occupy. */
export class ArchiveVisibility {
  private camera = new THREE.PerspectiveCamera();
  private frustum = new THREE.Frustum();
  private matrix = new THREE.Matrix4();
  private box = new THREE.Box3();
  private inverse = new THREE.Matrix4();
  private vertices = Array.from({length:8}, () => new THREE.Vector3());
  private slab = new THREE.Box3();
  private point = new THREE.Vector3();
  private cells: ArchiveCell[] = [];
  private pool: ArchiveCell[] = [];
  candidates = 0;
  update(source: THREE.PerspectiveCamera, far: number, trackX: number, trackZ: number, extra: boolean): ArchiveCell[] {
    this.camera.copy(source, false);
    this.camera.far = Math.min(source.far, Math.max(source.near + 1, far + 8));
    this.camera.updateProjectionMatrix();
    // Screen-space overscan plus the complete card bounds keep silhouettes and
    // off-screen shadow casters alive before they reach an edge.
    const margin = extra ? 1.5 : 1.18;
    this.camera.projectionMatrix.elements[0] /= margin;
    this.camera.projectionMatrix.elements[5] /= margin;
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
    this.matrix.multiplyMatrices(this.camera.projectionMatrix, source.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.matrix);
    const inverse = this.inverse.copy(this.matrix).invert();
    const vertices = this.vertices;
    vertices.forEach((point,i) => point.set(i&1?1:-1,i&2?1:-1,i&4?1:-1).applyMatrix4(inverse));
    const slab = this.slab.makeEmpty();
    const bottom = -6.5, top = 6.5;
    for (const point of vertices) if(point.y >= bottom && point.y <= top) slab.expandByPoint(point);
    for (const [a,b] of edges) for (const y of [bottom,top]) {
      const start=vertices[a],end=vertices[b],dy=end.y-start.y;
      if(Math.abs(dy)<1e-9)continue;
      const t=(y-start.y)/dy;
      if(t>=0&&t<=1)slab.expandByPoint(this.point.copy(start).lerp(end,t));
    }
    if(slab.isEmpty()) { this.candidates=0; return []; }
    const minLane=Math.floor((slab.min.x-2.8+trackX)/COLUMN_SPACING+2)-1;
    const maxLane=Math.ceil((slab.max.x+2.8+trackX)/COLUMN_SPACING+2)+1;
    const minRow=Math.floor((slab.min.z-.6-trackZ)/ROW_SPACING+15.5)-2;
    const maxRow=Math.ceil((slab.max.z+.6-trackZ)/ROW_SPACING+15.5)+2;
    const cells = this.cells;
    cells.length = 0;
    for(let lane=minLane;lane<=maxLane;lane++)for(let row=minRow;row<=maxRow;row++) {
      const x=(lane-2)*COLUMN_SPACING-trackX, z=(row-15.5)*ROW_SPACING+trackZ;
      this.box.min.set(x-2.8,bottom,z-1.2);
      this.box.max.set(x+2.8,top,z+1.2);
      if(this.frustum.intersectsBox(this.box)) {
        const cell = this.pool[cells.length] ?? (this.pool[cells.length] = {lane, row});
        cell.lane = lane; cell.row = row;
        cells.push(cell);
      }
    }
    this.candidates=cells.length;
    return cells;
  }
  intersects(x: number, y: number, z: number) {
    // Conservative over the subtle x-axis lean and normal wave amplitude.
    // Additional depth keeps adjacent offscreen shadow casters in the set.
    this.box.min.set(x-2.8,y-.3,z-1.2);
    this.box.max.set(x+2.8,y+4.1,z+1.2);
    return this.frustum.intersectsBox(this.box);
  }
}
