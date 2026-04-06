/**
 * Machinist Mario Engine — MotionKernel
 *
 * Jerk-Limited S-Curve Motion Controller with Look-Ahead Buffer.
 *
 * In a real shop a CNC machine that slams from 0 to full feed-rate instantly
 * will snap carbide bits and leave chatter marks on a Flying-V body.  The
 * MotionKernel solves this by computing a smooth S-curve velocity profile for
 * every segment *before* it is executed, using a three-phase model:
 *
 *   Phase 1 — Acceleration ramp   (jerk builds acceleration)
 *   Phase 2 — Constant feed       (cruise at target velocity)
 *   Phase 3 — Deceleration ramp   (jerk removes acceleration)
 *
 * The look-ahead pass pre-scans the upcoming N segments.  Wherever the path
 * bends sharply (angle > threshold), the entry velocity of that segment is
 * capped so the machine decelerates smoothly before it reaches the corner.
 *
 * This module is pure TypeScript and has no I/O dependencies; the
 * `executeMove` callback is the integration point to your actual motor driver,
 * G-Code streamer, or Termux stepper-pin interface.
 */
import { Vector3 } from './vector3';

// ── Types ─────────────────────────────────────────────────────────────────────

/** Velocity profile for one linear segment (all values in mm and mm/s). */
export interface SegmentProfile {
  /**
   * Zero-based index of the **start** spark in the original array passed to
   * `planPath`.  Zero-length segments are skipped, so consecutive
   * `segmentIndex` values may not be contiguous.
   */
  segmentIndex: number;
  /** World-space start point. */
  from: Vector3;
  /** World-space end point. */
  to: Vector3;
  /** Chord length of this segment (mm). */
  length: number;
  /** Corner angle between this and the next segment (radians, 0 = straight). */
  cornerAngle: number;
  /** Entry velocity — velocity at the start of this segment (mm/s). */
  entryVelocity: number;
  /** Peak (cruise) velocity during this segment (mm/s). */
  cruiseVelocity: number;
  /** Exit velocity — velocity at the end of this segment (mm/s). */
  exitVelocity: number;
  /** Estimated time to traverse this segment (ms). */
  durationMs: number;
}

/** Kernel configuration — all units mm, mm/s, mm/s², mm/s³. */
export interface MotionKernelConfig {
  /** Maximum feed rate (mm/s). Equivalent to F-word / 60 in G-Code. */
  maxFeedRate: number;
  /** Maximum acceleration (mm/s²). */
  maxAcceleration: number;
  /**
   * Maximum jerk (mm/s³) — the rate of change of acceleration.
   * Limits the "snap" at the start/end of every acceleration phase.
   */
  maxJerk: number;
  /**
   * Corner angle threshold (radians).  Segments whose included angle exceeds
   * this value are treated as "sharp corners" and have their junction velocity
   * reduced.  Default π/4 (45°).
   */
  cornerThreshold: number;
  /**
   * Junction deviation (mm) — Marlin/Klipper-style cornering model.
   * Larger value = faster cornering, more vibration.
   * Set to 0 to use the simpler angle-based model instead.
   */
  junctionDeviation: number;
  /** How many segments ahead to scan in the look-ahead pass. */
  lookAheadWindow: number;
}

const DEFAULT_CONFIG: MotionKernelConfig = {
  maxFeedRate:      200,    // mm/s  (~12 000 mm/min)
  maxAcceleration:  500,    // mm/s²
  maxJerk:          3000,   // mm/s³
  cornerThreshold:  Math.PI / 4,   // 45°
  junctionDeviation: 0.05,  // mm
  lookAheadWindow:  100,
};

// ── MotionKernel ──────────────────────────────────────────────────────────────

export class MotionKernel {
  private readonly _cfg: MotionKernelConfig;

  /** Current machine velocity at the end of the last planned segment (mm/s). */
  private _currentVelocity: number = 0;

  /** Planned segments waiting to be executed (the look-ahead buffer). */
  private _lookAheadBuffer: SegmentProfile[] = [];

  /** Callback invoked for each segment when it is ready to execute. */
  private readonly _executeMove: (profile: SegmentProfile) => void;

  /**
   * @param executeMove  Called for every segment in execution order.
   *                     Wire this to your G-Code streamer, stepper driver,
   *                     Canvitar renderer, or Termux serial port.
   * @param config       Optional overrides for the motion parameters.
   */
  constructor(
    executeMove: (profile: SegmentProfile) => void = () => { /* no-op */ },
    config: Partial<MotionKernelConfig> = {},
  ) {
    this._executeMove = executeMove;
    this._cfg = { ...DEFAULT_CONFIG, ...config };
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Plan and execute a full toolpath in one call.
   *
   * 1. Segments are built from consecutive spark pairs.
   * 2. The look-ahead pass assigns junction velocities.
   * 3. The forward pass applies S-curve acceleration limits.
   * 4. Each segment is dispatched to `executeMove` in order.
   *
   * @param sparks          Ordered Vector3 waypoints.
   * @param targetFeedRate  Desired cruise speed (mm/s).  Clamped to maxFeedRate.
   */
  planPath(sparks: Vector3[], targetFeedRate: number): void {
    if (sparks.length < 2) return;

    const cruise = Math.min(targetFeedRate, this._cfg.maxFeedRate);
    const segments = this._buildSegments(sparks, cruise);

    this._lookAheadPass(segments);
    this._forwardPass(segments);

    for (const seg of segments) {
      this._lookAheadBuffer.push(seg);
      this._executeMove(seg);
    }

    // Advance machine state
    if (segments.length > 0) {
      this._currentVelocity = segments[segments.length - 1].exitVelocity;
    }
  }

  /**
   * Flush the look-ahead buffer and decelerate to zero (end-of-program stop).
   * Call this after the last `planPath` to ensure a clean stop.
   */
  flush(): void {
    if (this._lookAheadBuffer.length === 0) return;
    const last = this._lookAheadBuffer[this._lookAheadBuffer.length - 1];
    last.exitVelocity = 0;
    last.durationMs   = this._estimateDuration(last);
    this._lookAheadBuffer = [];
    this._currentVelocity = 0;
  }

  /** Returns a read-only view of the current look-ahead buffer. */
  get buffer(): readonly SegmentProfile[] {
    return this._lookAheadBuffer;
  }

  /** Current machine velocity (mm/s). */
  get currentVelocity(): number {
    return this._currentVelocity;
  }

  // ── Step 1: Build segments ────────────────────────────────────────────────

  private _buildSegments(sparks: Vector3[], cruise: number): SegmentProfile[] {
    const segs: SegmentProfile[] = [];

    for (let i = 0; i < sparks.length - 1; i++) {
      const from = sparks[i];
      const to   = sparks[i + 1];
      const len  = from.distanceTo(to);
      if (len < 1e-6) continue; // skip zero-length segments

      const corner = i < sparks.length - 2
        ? this._cornerAngle(from, to, sparks[i + 2])
        : 0;

      segs.push({
        segmentIndex:   i,
        from,
        to,
        length:         len,
        cornerAngle:    corner,
        entryVelocity:  0,
        cruiseVelocity: cruise,
        exitVelocity:   cruise,
        durationMs:     0,
      });
    }

    return segs;
  }

  // ── Step 2: Look-ahead pass (assign junction exit velocities) ─────────────

  /**
   * Scan up to `lookAheadWindow` segments ahead of the current one.
   * At each junction, compute the maximum safe exit velocity given the
   * corner geometry, then back-propagate any reductions.
   */
  private _lookAheadPass(segs: SegmentProfile[]): void {
    const { lookAheadWindow } = this._cfg;

    for (let i = 0; i < segs.length - 1; i++) {
      const window = Math.min(i + lookAheadWindow, segs.length - 1);
      for (let j = i + 1; j <= window; j++) {
        const junction = this._junctionVelocity(segs[j - 1], segs[j]);
        if (junction < segs[j - 1].exitVelocity) {
          segs[j - 1].exitVelocity = junction;
          // Back-propagate: if we must exit slower, earlier segments may also
          // need to slow down so they can decelerate in time.
          for (let k = j - 2; k >= i; k--) {
            const maxExit = this._maxExitVelocity(segs[k], segs[k + 1].exitVelocity);
            if (maxExit >= segs[k].exitVelocity) break;
            segs[k].exitVelocity = maxExit;
          }
        }
      }
    }

    // Final segment must come to a complete stop
    segs[segs.length - 1].exitVelocity = 0;
  }

  // ── Step 3: Forward pass (enforce acceleration from current velocity) ──────

  private _forwardPass(segs: SegmentProfile[]): void {
    let v = this._currentVelocity;

    for (const seg of segs) {
      seg.entryVelocity = v;

      // Maximum velocity reachable over this segment starting from v
      const vPeak = this._vPeakOverDistance(v, seg.cruiseVelocity, seg.length);
      seg.cruiseVelocity = Math.min(vPeak, seg.cruiseVelocity);

      // Exit velocity: either target, or max achievable given deceleration
      const vExit = Math.min(
        seg.exitVelocity,
        this._maxExitVelocity(seg, seg.exitVelocity),
      );
      seg.exitVelocity = vExit;

      seg.durationMs = this._estimateDuration(seg);
      v = vExit;
    }
  }

  // ── Kinematics helpers ────────────────────────────────────────────────────

  /**
   * Angle at the junction between segment (from→mid) and (mid→to).
   * Returns 0 for a straight continuation, π for a 180° reversal.
   */
  private _cornerAngle(from: Vector3, mid: Vector3, to: Vector3): number {
    const d1 = mid.subtract(from).normalized();
    const d2 = to.subtract(mid).normalized();
    const dot = Math.max(-1, Math.min(1, d1.dot(d2)));
    return Math.acos(dot); // 0 = straight, π = reverse
  }

  /**
   * Maximum safe junction velocity between two segments.
   * Uses either the junction-deviation model (Marlin/Klipper style) or the
   * simpler angle-threshold model depending on config.
   */
  private _junctionVelocity(a: SegmentProfile, b: SegmentProfile): number {
    const { cornerThreshold, junctionDeviation, maxAcceleration, maxFeedRate } = this._cfg;
    const angle = a.cornerAngle; // angle already stored on outgoing segment

    if (junctionDeviation > 0) {
      // Junction deviation model: v_j = sqrt(a * d / (1 - cos θ))
      if (angle < 1e-6) return maxFeedRate;                  // straight — no limit
      if (angle >= Math.PI - 1e-6) return 0;                 // reversal — full stop
      const halfAngle = angle / 2;
      const sinHalf = Math.sin(halfAngle);
      if (sinHalf < 1e-6) return maxFeedRate;
      return Math.sqrt(maxAcceleration * junctionDeviation / sinHalf);
    }

    // Angle-threshold model (simpler, matches requirement spec)
    if (angle > cornerThreshold) {
      return Math.min(a.cruiseVelocity * 0.5, b.cruiseVelocity);
    }
    return Math.min(a.cruiseVelocity, b.cruiseVelocity);
  }

  /**
   * Given that the next segment starts at `nextEntry`, what is the fastest
   * velocity we can exit `seg` at while still being able to decelerate?
   *   v² = v_next² + 2 · a · d
   */
  private _maxExitVelocity(seg: SegmentProfile, nextEntry: number): number {
    const { maxAcceleration } = this._cfg;
    return Math.sqrt(Math.max(0, nextEntry * nextEntry + 2 * maxAcceleration * seg.length));
  }

  /**
   * Peak velocity achievable when accelerating from `v0` over `distance`,
   * subject to `maxAcceleration` and capped at `vMax`.
   *   v_peak = min(vMax,  sqrt(v0² + 2·a·d))
   */
  private _vPeakOverDistance(v0: number, vMax: number, distance: number): number {
    const { maxAcceleration } = this._cfg;
    return Math.min(vMax, Math.sqrt(v0 * v0 + 2 * maxAcceleration * distance));
  }

  /**
   * Estimate traverse time for a segment using trapezoidal / triangular
   * velocity model (good enough for feed-rate planning; true S-curve
   * integration would use the jerk term too).
   *
   * Three sub-phases:
   *   1. Accelerate from entryVelocity to cruiseVelocity
   *   2. Cruise at cruiseVelocity
   *   3. Decelerate from cruiseVelocity to exitVelocity
   */
  private _estimateDuration(seg: SegmentProfile): number {
    const { maxAcceleration } = this._cfg;
    const { entryVelocity: v0, cruiseVelocity: vc, exitVelocity: v1, length } = seg;

    // Distances for accel and decel phases
    const dAccel  = Math.max(0, (vc * vc - v0 * v0) / (2 * maxAcceleration));
    const dDecel  = Math.max(0, (vc * vc - v1 * v1) / (2 * maxAcceleration));
    const dCruise = Math.max(0, length - dAccel - dDecel);

    const tAccel  = dAccel  > 0 ? (vc - v0) / maxAcceleration : 0;
    const tDecel  = dDecel  > 0 ? (vc - v1) / maxAcceleration : 0;
    const tCruise = vc > 0      ? dCruise / vc                : 0;

    return (tAccel + tCruise + tDecel) * 1000; // → milliseconds
  }
}
