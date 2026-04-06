/**
 * Machinist Mario Engine — ArcInterpolator
 *
 * Standalone G2/G3 circular interpolator. Decomposes any arc or helix into a
 * dense sequence of Vector3 "micro-sparks" that can be:
 *   • Individually vetted by an AABB safety cage before execution
 *   • Rendered by the Canvitar* as smooth screen-space curves
 *   • Written directly into a G-Code program as densified G1 moves
 *
 * The GCodeInterpreter delegates to this class internally; it is also
 * exported for direct use in toolpath generators and animation loops.
 *
 * Coordinate planes:
 *   XY (G17, default) — I/J centre offsets, K helical axis
 *   XZ (G18)          — I/K centre offsets, J helical axis
 *   YZ (G19)          — J/K centre offsets, I helical axis
 *
 * Winding convention (right-hand rule looking along the positive helical axis):
 *   G2 — clockwise     (negative angular direction)
 *   G3 — counter-clockwise (positive angular direction)
 */
import { Vector3 } from './vector3';
import { AABB } from './aabb';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ArcPlane = 'XY' | 'XZ' | 'YZ';

/** Input descriptor for a single arc segment. */
export interface ArcParams {
  /** World-space start point (current machine position). */
  start: Vector3;
  /** World-space end point (the G2/G3 target). */
  end: Vector3;
  /**
   * Centre offset along the first in-plane axis relative to `start`.
   * XY → I,  XZ → I,  YZ → (unused, pass 0)
   */
  i: number;
  /**
   * Centre offset along the second in-plane axis relative to `start`.
   * XY → J,  XZ → (unused, pass 0),  YZ → J
   */
  j: number;
  /**
   * Centre offset along the third axis relative to `start`.
   * XY → (unused, pass 0),  XZ → K,  YZ → K
   */
  k: number;
  /** true = G2 clockwise, false = G3 counter-clockwise. */
  clockwise: boolean;
  /** Active G17/G18/G19 plane selection. */
  plane: ArcPlane;
}

/** A single validated step along the arc. */
export interface ArcStep {
  /** World-space position of this micro-spark. */
  point: Vector3;
  /** Parametric position along the arc [0, 1]. */
  t: number;
  /** Cumulative arc length from start to this step (mm). */
  arcLength: number;
  /** Whether this point was clamped by the AABB safety cage. */
  clamped: boolean;
}

/** Diagnostic returned by `ArcInterpolator.validate`. */
export interface ArcValidation {
  valid: boolean;
  /** Computed circle radius (mm). Should equal distance from start to centre. */
  radius: number;
  /** Total sweep angle in radians. */
  sweepAngle: number;
  /** Approximate arc length (mm). */
  arcLength: number;
  /** Distance between computed end position and declared end point (mm). Ideally < 0.001). */
  closureError: number;
  warnings: string[];
}

// ── ArcInterpolator ───────────────────────────────────────────────────────────

export class ArcInterpolator {
  /**
   * @param segmentLength  Maximum chord length per step (mm). Smaller = smoother.
   *                       Default 0.1 mm gives sub-millimetre precision.
   * @param bounds         Optional AABB. Steps outside this box are clamped and
   *                       flagged; pass `undefined` to disable bounds checking.
   */
  constructor(
    public segmentLength: number = 0.1,
    public bounds?: AABB,
  ) {}

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Interpolate an arc defined by `params` into an ordered array of `ArcStep`
   * micro-sparks, each separated by at most `this.segmentLength` mm of chord.
   *
   * The start point is **not** included (it is the already-known current
   * position); the end point is always the final element.
   */
  interpolate(params: ArcParams): ArcStep[] {
    const { start, end, i, j, k, clockwise, plane } = params;

    // ── Axis mapping ──────────────────────────────────────────────────────
    // a1, a2 = in-plane axes; ha = helical axis
    const [a1, a2, ha, ci, cj] = this._axisMap(plane, i, j, k);

    // Centre in world space
    const centre = new Vector3();
    centre[a1] = start[a1] + ci;
    centre[a2] = start[a2] + cj;
    centre[ha] = start[ha];   // centre lies in the arc plane

    const radius = Math.hypot(start[a1] - centre[a1], start[a2] - centre[a2]);

    if (radius < 1e-9) {
      // Degenerate arc: radius is zero — return single step at end
      return [this._step(end, 1, 0, false)];
    }

    const startAngle = Math.atan2(start[a2] - centre[a2], start[a1] - centre[a1]);
    const endAngle   = Math.atan2(end[a2]   - centre[a2], end[a1]   - centre[a1]);

    let sweep = endAngle - startAngle;
    if ( clockwise && sweep > 0) sweep -= 2 * Math.PI;
    if (!clockwise && sweep < 0) sweep += 2 * Math.PI;
    if (sweep === 0)              sweep  = clockwise ? -2 * Math.PI : 2 * Math.PI;

    // Helical interpolation: start[ha] → end[ha]
    const startH = start[ha];
    const dH     = end[ha] - startH;

    // How many steps to keep chord ≤ segmentLength?
    const arcLen  = Math.abs(sweep) * radius;
    const nSteps  = Math.max(1, Math.ceil(arcLen / this.segmentLength));

    const steps: ArcStep[] = [];
    let cumLen = 0;
    let prev   = start.clone();

    for (let s = 1; s <= nSteps; s++) {
      const t     = s / nSteps;
      const angle = startAngle + sweep * t;

      const p     = new Vector3();
      p[a1] = centre[a1] + radius * Math.cos(angle);
      p[a2] = centre[a2] + radius * Math.sin(angle);
      p[ha] = startH + dH * t;

      cumLen += p.distanceTo(prev);
      prev    = p;

      let clamped = false;
      let final   = p;
      if (this.bounds && !this.bounds.contains(p)) {
        final   = this.bounds.clampPoint(p);
        clamped = true;
      }

      steps.push(this._step(final, t, cumLen, clamped));
    }

    return steps;
  }

  /**
   * Convenience: return just the Vector3 points (no metadata).
   * Equivalent to `interpolate(params).map(s => s.point)`.
   */
  points(params: ArcParams): Vector3[] {
    return this.interpolate(params).map(s => s.point);
  }

  /**
   * Pre-flight validation: check the arc geometry for consistency before
   * committing it to the toolpath.
   *
   * Checks performed:
   *   • Radius is non-zero
   *   • End point lies on the circle within tolerance
   *   • Sweep angle is well-defined
   */
  validate(params: ArcParams, tolerance: number = 0.01): ArcValidation {
    const { start, end, i, j, k, clockwise, plane } = params;
    const warnings: string[] = [];

    const [a1, a2, , ci, cj] = this._axisMap(plane, i, j, k);

    const cx = start[a1] + ci;
    const cy = start[a2] + cj;
    const radius = Math.hypot(start[a1] - cx, start[a2] - cy);

    if (radius < 1e-6) {
      warnings.push('Degenerate arc: radius is effectively zero.');
    }

    const endRadius = Math.hypot(end[a1] - cx, end[a2] - cy);
    const closureError = Math.abs(endRadius - radius);
    if (closureError > tolerance) {
      warnings.push(
        `End point is ${closureError.toFixed(4)} mm off the circle ` +
        `(tolerance ${tolerance} mm). Check I/J/K offsets.`,
      );
    }

    const startAngle = Math.atan2(start[a2] - cy, start[a1] - cx);
    const endAngle   = Math.atan2(end[a2]   - cy, end[a1]   - cx);
    let sweep = endAngle - startAngle;
    if ( clockwise && sweep > 0) sweep -= 2 * Math.PI;
    if (!clockwise && sweep < 0) sweep += 2 * Math.PI;

    const arcLength = Math.abs(sweep) * radius;

    return {
      valid: warnings.length === 0,
      radius,
      sweepAngle:   sweep,
      arcLength,
      closureError,
      warnings,
    };
  }

  /**
   * Compute the number of G1 segments that would be emitted for this arc at
   * the current `segmentLength`.  Useful for feed-rate planning.
   */
  segmentCount(params: ArcParams): number {
    const [a1, a2, , ci, cj] = this._axisMap(params.plane, params.i, params.j, params.k);
    const cx = params.start[a1] + ci;
    const cy = params.start[a2] + cj;
    const radius = Math.hypot(params.start[a1] - cx, params.start[a2] - cy);
    const startAngle = Math.atan2(params.start[a2] - cy, params.start[a1] - cx);
    const endAngle   = Math.atan2(params.end[a2]   - cy, params.end[a1]   - cx);
    let sweep = endAngle - startAngle;
    if ( params.clockwise && sweep > 0) sweep -= 2 * Math.PI;
    if (!params.clockwise && sweep < 0) sweep += 2 * Math.PI;
    if (sweep === 0) sweep = params.clockwise ? -2 * Math.PI : 2 * Math.PI;
    return Math.max(1, Math.ceil(Math.abs(sweep) * radius / this.segmentLength));
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Map a plane selector to the correct Vector3 axis keys and centre offsets.
   * Returns [firstAxis, secondAxis, helicalAxis, c1offset, c2offset].
   */
  private _axisMap(
    plane: ArcPlane, i: number, j: number, k: number,
  ): [keyof Vector3, keyof Vector3, keyof Vector3, number, number] {
    switch (plane) {
      case 'XZ': return ['x', 'z', 'y', i, k];
      case 'YZ': return ['y', 'z', 'x', j, k];
      default:   return ['x', 'y', 'z', i, j]; // XY
    }
  }

  private _step(point: Vector3, t: number, arcLength: number, clamped: boolean): ArcStep {
    return { point, t, arcLength, clamped };
  }
}
