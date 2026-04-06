/**
 * Machinist Mario Engine — Medical Stent Mesh Asset
 *
 * Generates the diamond-cell lattice geometry and G-Code for a balloon-
 * expandable vascular stent, suitable for FDM printing in flexible TPU
 * or for export to a metal-SLS slicer.
 *
 * Stent geometry:
 *   • Cylindrical scaffold of diameter `diameter` and length `length`
 *   • Diamond (rhombus) cells arranged in `ringCount` rings around the
 *     circumference, each ring offset by half a cell to interlock
 *   • Each cell is 4 struts connecting 4 nodes; toolpath traces each strut
 *
 * Usage:
 *   const asset = new MedicalStentMeshAsset();
 *   asset.params.diameter    = 3.5;  // mm (nominal expanded diameter)
 *   asset.params.length      = 18;   // mm
 *   asset.params.cellsPerRing = 8;
 *   asset.params.ringCount   = 6;
 *   const gcode = asset.toGCode();
 */
import { Vector3 } from './vector3';
import { AABB } from './aabb';
import {
  BaseMachinistAsset,
  AssetFactory,
  gcodePreamble,
  gcodeEpilogue,
  toolpathToGCode,
} from './asset-factory';

export interface StentMeshParams {
  /** Nominal expanded outer diameter (mm). */
  diameter: number;
  /** Total stent length along the cylinder axis (mm). */
  length: number;
  /** Number of diamond cells around each ring. */
  cellsPerRing: number;
  /** Number of axial rings of cells. */
  ringCount: number;
  /** Strut width — used only for documentation (actual width is set by nozzle). */
  strutWidth: number;
  /** Print feed rate (mm/min). */
  feedRate: number;
}

export class MedicalStentMeshAsset implements BaseMachinistAsset<StentMeshParams> {
  readonly name     = 'Medical Stent Mesh — Diamond-Cell Scaffold';
  readonly category = 'medical';

  params: StentMeshParams = {
    diameter:    3.5,
    length:      18,
    cellsPerRing: 8,
    ringCount:   6,
    strutWidth:  0.2,
    feedRate:    600,
  };

  private _toolpath: Vector3[] = [];

  // ── Node geometry ─────────────────────────────────────────────────────────

  /**
   * Returns the 3D position of a lattice node.
   * Nodes sit on the cylinder surface at the midpoints of diamond cells.
   * Odd rings are offset by half a cell (π/cellsPerRing) to interlock.
   */
  private _node(ring: number, cell: number): Vector3 {
    const { diameter, length, cellsPerRing, ringCount } = this.params;
    const r     = diameter / 2;
    const dZ    = length / (ringCount + 1);
    const dTheta = (2 * Math.PI) / cellsPerRing;
    const offset = (ring % 2 === 0) ? 0 : dTheta / 2;

    const theta = cell * dTheta + offset;
    const z     = (ring + 1) * dZ;

    return new Vector3(r * Math.cos(theta), r * Math.sin(theta), z);
  }

  // ── BaseMachinistAsset ────────────────────────────────────────────────────

  buildToolpath(): Vector3[] {
    const { cellsPerRing, ringCount } = this.params;
    this._toolpath = [];

    // Trace each diamond cell: 4 struts connecting a top node, left, bottom, right
    for (let ring = 0; ring < ringCount - 1; ring++) {
      for (let cell = 0; cell < cellsPerRing; cell++) {
        const top    = this._node(ring,     cell);
        const bottom = this._node(ring + 1, cell);
        const right  = this._node(ring + 1, (cell + 1) % cellsPerRing);
        // Diamond cell: top → bottom → right → top (half-cell stitch)
        const lift   = new Vector3(top.x, top.y, top.z + 2); // safe lift

        this._toolpath.push(lift, top, bottom, right, top, lift);
      }
    }

    // Add two end-ring circles for proximal and distal stent shoulders
    for (const ring of [0, ringCount - 1]) {
      for (let cell = 0; cell <= cellsPerRing; cell++) {
        this._toolpath.push(this._node(ring, cell % cellsPerRing));
      }
    }

    return this._toolpath;
  }

  computeAABB(): AABB {
    const pts = this._toolpath.length > 0 ? this._toolpath : this.buildToolpath();
    const xs = pts.map(p => p.x);
    const ys = pts.map(p => p.y);
    const zs = pts.map(p => p.z);
    return new AABB(
      new Vector3(Math.min(...xs), Math.min(...ys), Math.min(...zs)),
      new Vector3(Math.max(...xs), Math.max(...ys), Math.max(...zs)),
    );
  }

  toGCode(): string {
    const pts  = this.buildToolpath();
    const aabb = this.computeAABB();
    const r = (this.params.diameter / 2).toFixed(3);
    return [
      gcodePreamble(this.name),
      `; Diameter: ${this.params.diameter} mm  Length: ${this.params.length} mm`,
      `; Cells/ring: ${this.params.cellsPerRing}  Rings: ${this.params.ringCount}`,
      `; Strut width: ${this.params.strutWidth} mm`,
      `; AABB: X[${aabb.min.x.toFixed(3)},${aabb.max.x.toFixed(3)}]`,
      `;       Y[${aabb.min.y.toFixed(3)},${aabb.max.y.toFixed(3)}]`,
      `;       Z[${aabb.min.z.toFixed(3)},${aabb.max.z.toFixed(3)}]`,
      `; Total waypoints: ${pts.length}`,
      ``,
      `; ── Stent mesh toolpath ──`,
      `; Note: print on a cylindrical mandrel (r=${r} mm), then remove after annealing`,
      toolpathToGCode(pts, this.params.feedRate, 0.015),
      gcodeEpilogue(),
    ].join('\n');
  }
}

// ── Self-register with the AssetFactory ──────────────────────────────────────
AssetFactory.register('medical-stent-mesh', MedicalStentMeshAsset);
