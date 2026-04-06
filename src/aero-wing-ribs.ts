/**
 * Machinist Mario Engine — Aero Wing Ribs Asset
 *
 * Generates the internal "V-skeleton" bracing geometry and G-Code for a
 * Flying-V style guitar body or an aero-wing rib section. The rib profile
 * follows a NACA 4-digit symmetric airfoil approximation, parameterised by
 * chord length, thickness ratio, and span count.
 *
 * Each rib is a closed polygon of Vector3 waypoints lying in a Z-plane;
 * the full toolpath sweeps from Z=0 to Z=span × ribSpacing.
 *
 * Usage:
 *   const asset = new AeroWingRibsAsset();
 *   asset.params.chord         = 200;   // mm
 *   asset.params.thicknessRatio = 0.12; // 12% NACA profile
 *   asset.params.ribCount      = 8;
 *   asset.params.ribSpacing    = 50;    // mm between ribs
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

export interface AeroWingRibParams {
  /** Chord length — nose to trailing edge (mm). */
  chord: number;
  /** NACA thickness ratio (e.g. 0.12 = 12%). */
  thicknessRatio: number;
  /** Number of ribs to generate along the span. */
  ribCount: number;
  /** Distance between successive ribs along Z (mm). */
  ribSpacing: number;
  /** Number of profile sample points per rib half. */
  profilePoints: number;
  /** Feed rate (mm/min). */
  feedRate: number;
}

/** Compute the NACA 4-digit symmetric half-thickness at x/c in [0,1]. */
function nacaHalfThickness(xc: number, t: number): number {
  // NACA formula: y_t = 5t ( 0.2969√(x/c) − 0.1260(x/c) − 0.3516(x/c)² + 0.2843(x/c)³ − 0.1015(x/c)⁴ )
  return (
    5 * t * (
      0.2969 * Math.sqrt(xc) -
      0.1260 * xc -
      0.3516 * xc ** 2 +
      0.2843 * xc ** 3 -
      0.1015 * xc ** 4
    )
  );
}

export class AeroWingRibsAsset implements BaseMachinistAsset<AeroWingRibParams> {
  readonly name     = 'Aero Wing Ribs — V-Skeleton Internal Bracing';
  readonly category = 'aerospace';

  params: AeroWingRibParams = {
    chord:          200,
    thicknessRatio: 0.12,
    ribCount:       8,
    ribSpacing:     50,
    profilePoints:  24,
    feedRate:       1200,
  };

  private _toolpath: Vector3[] = [];

  // ── Profile helper ────────────────────────────────────────────────────────

  /**
   * Returns an ordered closed-loop polygon (upper surface + lower surface)
   * for a single rib at the given Z height.
   */
  private _ribProfile(z: number): Vector3[] {
    const { chord, thicknessRatio: t, profilePoints: n } = this.params;
    const upper: Vector3[] = [];
    const lower: Vector3[] = [];

    for (let i = 0; i <= n; i++) {
      const xc = i / n;                          // normalised chord position
      const yt = nacaHalfThickness(xc, t);       // normalised half-thickness
      const x  = xc * chord;
      const y  = yt * chord;

      upper.push(new Vector3(x,  y, z));
      lower.push(new Vector3(x, -y, z));
    }

    // Close the loop: upper (LE→TE), then lower (TE→LE)
    return [...upper, ...[...lower].reverse()];
  }

  // ── BaseMachinistAsset ────────────────────────────────────────────────────

  buildToolpath(): Vector3[] {
    this._toolpath = [];

    for (let r = 0; r < this.params.ribCount; r++) {
      const z = r * this.params.ribSpacing;
      const ribPts = this._ribProfile(z);

      // Lift to safe height, then plunge to rib Z
      this._toolpath.push(new Vector3(ribPts[0].x, ribPts[0].y, z + 5));
      this._toolpath.push(...ribPts);
      // Return to safe height after closing rib
      this._toolpath.push(new Vector3(ribPts[0].x, ribPts[0].y, z + 5));
    }

    return this._toolpath;
  }

  computeAABB(): AABB {
    const pts = this._toolpath.length > 0 ? this._toolpath : this.buildToolpath();
    const xs = pts.map(p => p.x);
    const ys = pts.map(p => p.y);
    const zs = pts.map(p => p.z);
    return {
      min: new Vector3(Math.min(...xs), Math.min(...ys), Math.min(...zs)),
      max: new Vector3(Math.max(...xs), Math.max(...ys), Math.max(...zs)),
    };
  }

  toGCode(): string {
    const pts = this.buildToolpath();
    const aabb = this.computeAABB();
    return [
      gcodePreamble(this.name),
      `; Chord: ${this.params.chord} mm  Thickness: ${(this.params.thicknessRatio * 100).toFixed(1)}%`,
      `; Ribs: ${this.params.ribCount}  Rib spacing: ${this.params.ribSpacing} mm`,
      `; AABB: X[${aabb.min.x.toFixed(1)},${aabb.max.x.toFixed(1)}]`,
      `;       Y[${aabb.min.y.toFixed(1)},${aabb.max.y.toFixed(1)}]`,
      `;       Z[${aabb.min.z.toFixed(1)},${aabb.max.z.toFixed(1)}]`,
      `; Total waypoints: ${pts.length}`,
      ``,
      `; ── Wing rib toolpath ──`,
      toolpathToGCode(pts, this.params.feedRate),
      gcodeEpilogue(),
    ].join('\n');
  }
}

// ── Self-register with the AssetFactory ──────────────────────────────────────
AssetFactory.register('aero-wing-ribs', AeroWingRibsAsset);
