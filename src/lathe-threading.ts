/**
 * Machinist Mario Engine — Lathe Threading Asset
 *
 * Generates helical toolpaths and G-Code for machining threaded shafts,
 * principally used for guitar tuning-peg worm-gear stems.
 *
 * Thread geometry follows the Unified Thread Standard (UTS) profile:
 *   • 60° included angle
 *   • Flat crests and roots (for clarity in CNC output)
 *
 * Usage:
 *   const asset = new LatheThreadingAsset();
 *   asset.params.pitch    = 0.8;   // mm per revolution
 *   asset.params.diameter = 6;     // nominal shaft diameter (mm)
 *   asset.params.length   = 25;    // threaded length (mm)
 *   const gcode = asset.toGCode();
 */
import { Vector3 } from './vector3';
import { AABB } from './kinematics';
import {
  BaseMachinistAsset,
  AssetFactory,
  gcodePreamble,
  gcodeEpilogue,
  toolpathToGCode,
} from './asset-factory';

export interface LatheThreadParams {
  /** Nominal outer diameter of the threaded shaft (mm). */
  diameter: number;
  /** Thread pitch — axial distance between crests (mm/rev). */
  pitch: number;
  /** Total threaded length along the Z-axis (mm). */
  length: number;
  /** Number of angular steps per revolution (resolution). */
  stepsPerRev: number;
  /** Tool feed rate (mm/min). */
  feedRate: number;
}

export class LatheThreadingAsset implements BaseMachinistAsset<LatheThreadParams> {
  readonly name     = 'Lathe Threading — Guitar Tuning Peg';
  readonly category = 'musical';

  params: LatheThreadParams = {
    diameter:    6,
    pitch:       0.8,
    length:      25,
    stepsPerRev: 36,
    feedRate:    800,
  };

  private _toolpath: Vector3[] = [];

  // ── BaseMachinistAsset ────────────────────────────────────────────────────

  buildToolpath(): Vector3[] {
    const { diameter, pitch, length, stepsPerRev } = this.params;
    const radius   = diameter / 2;
    const totalRevs = length / pitch;
    const totalSteps = Math.ceil(totalRevs * stepsPerRev);
    const dZ = pitch / stepsPerRev;       // Z advance per step
    const dTheta = (2 * Math.PI) / stepsPerRev;

    this._toolpath = [];

    for (let i = 0; i <= totalSteps; i++) {
      const theta = i * dTheta;
      const z     = i * dZ;
      // Thread profile: crest at `radius`, root at `radius - depth`
      const depth  = 0.6495 * pitch;        // UTS theoretical depth
      const phase  = (i % stepsPerRev) / stepsPerRev; // 0→1 per revolution
      const rLocal = radius - depth * Math.abs(Math.sin(phase * Math.PI));

      this._toolpath.push(new Vector3(
        rLocal * Math.cos(theta),
        rLocal * Math.sin(theta),
        z,
      ));
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
    return [
      gcodePreamble(this.name),
      `; Pitch: ${this.params.pitch} mm  Diameter: ${this.params.diameter} mm  Length: ${this.params.length} mm`,
      `; Total waypoints: ${pts.length}`,
      ``,
      `; ── Approach ──`,
      `G1 Z5 F3000`,
      `G1 X${(this.params.diameter / 2).toFixed(3)} Y0 F${this.params.feedRate}`,
      ``,
      `; ── Helical thread toolpath ──`,
      toolpathToGCode(pts, this.params.feedRate),
      gcodeEpilogue(),
    ].join('\n');
  }
}

// ── Self-register with the AssetFactory ──────────────────────────────────────
AssetFactory.register('lathe-threading', LatheThreadingAsset);
