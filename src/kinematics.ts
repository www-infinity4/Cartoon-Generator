/**
 * Machinist Mario Engine — Inverse Kinematics (IK)
 * "The Reach": Moving 144,000 Sparks via Bone Constraints.
 *
 * Implements a 2-joint IK solver (shoulder → elbow → wrist) using the
 * Law of Cosines so that a character or robotic arm can physically reach
 * a target position in 3D space without tearing joint constraints.
 */
import { Vector3 } from './vector3';

/** A single rigid bone segment with a length, local rotation angle, and world position. */
export class Bone {
  constructor(
    /** Length of this bone segment in world units. */
    public length: number,
    /** Current rotation angle in radians (local to parent). */
    public angle: number = 0,
    /** World-space origin of this bone. */
    public position: Vector3 = new Vector3(),
  ) {}

  /**
   * Returns the world-space tip (end point) of this bone,
   * projected into the XY plane from its origin.
   */
  tip(): Vector3 {
    return new Vector3(
      this.position.x + this.length * Math.cos(this.angle),
      this.position.y + this.length * Math.sin(this.angle),
      this.position.z,
    );
  }
}

/** Axis-aligned bounding box used for joint reach safety checks. */
export interface AABB {
  min: Vector3;
  max: Vector3;
}

/** Result of a solve operation, including whether the target was reachable. */
export interface IKResult {
  reachable: boolean;
  upperAngle: number;
  lowerAngle: number;
  elbowPosition: Vector3;
  wristPosition: Vector3;
}

/**
 * 2-Joint Inverse Kinematics Solver.
 *
 * Solves the classic "shoulder → elbow → wrist" chain so that the tip of
 * the lower bone reaches the given target. Uses the Law of Cosines:
 *   a² = b² + c² − 2bc·cos(A)
 */
export class IKSolver {
  /**
   * Solve a 2-joint (planar, XY) IK chain so that the wrist reaches `target`.
   *
   * The solver modifies `upper.angle` and `lower.angle` in place and returns
   * a detailed result object.
   *
   * @param target  - Desired wrist position in world space.
   * @param upper   - Upper arm bone (shoulder → elbow). Its `position` is the shoulder origin.
   * @param lower   - Lower arm bone (elbow → wrist).
   * @param bounds  - Optional AABB safety check; if the target falls outside, solve is skipped.
   */
  solve2D(
    target: Vector3,
    upper: Bone,
    lower: Bone,
    bounds?: AABB,
  ): IKResult {
    // Translate target into the shoulder's local space
    const localTarget = target.subtract(upper.position);
    const dist = localTarget.magnitude();

    const maxReach = upper.length + lower.length;
    const minReach = Math.abs(upper.length - lower.length);

    // Safety: don't "tear the body" if target is out of reach
    if (dist > maxReach || dist < minReach) {
      return this._unreachableResult(upper, lower);
    }

    // Optional AABB safety bounds
    if (bounds) {
      if (
        target.x < bounds.min.x || target.x > bounds.max.x ||
        target.y < bounds.min.y || target.y > bounds.max.y ||
        target.z < bounds.min.z || target.z > bounds.max.z
      ) {
        return this._unreachableResult(upper, lower);
      }
    }

    const a = lower.length;   // opposite to upper angle
    const b = upper.length;   // opposite to lower angle
    const c = dist;           // distance from shoulder to target

    // Law of Cosines — clamp to [-1,1] to guard against floating-point drift
    const cosUpper = Math.max(-1, Math.min(1, (b * b + c * c - a * a) / (2 * b * c)));
    const cosLower = Math.max(-1, Math.min(1, (a * a + b * b - c * c) / (2 * a * b)));

    upper.angle = Math.atan2(localTarget.y, localTarget.x) - Math.acos(cosUpper);
    lower.angle = Math.PI - Math.acos(cosLower);

    // Forward-kinematics to derive elbow and wrist world positions
    const elbowPos = upper.tip();
    lower.position = elbowPos;
    const wristPos = lower.tip();

    return {
      reachable:    true,
      upperAngle:   upper.angle,
      lowerAngle:   lower.angle,
      elbowPosition: elbowPos,
      wristPosition: wristPos,
    };
  }

  /**
   * Solve a full 3-joint chain by decomposing into two sequential 2D solves:
   *   root → mid → sub → tip.
   * The first solve positions `sub` so the remaining two bones can reach `target`.
   */
  solve3Joint(
    target: Vector3,
    root: Bone,
    mid: Bone,
    sub: Bone,
  ): { reachable: boolean } {
    // Create a virtual bone from root spanning (mid + sub) length
    const virtual = new Bone(mid.length + sub.length, 0, root.position.clone());
    const r1 = this.solve2D(target, root, virtual);
    if (!r1.reachable) return { reachable: false };

    // Now solve from the elbow onward
    mid.position = r1.elbowPosition;
    const r2 = this.solve2D(target, mid, sub);
    return { reachable: r2.reachable };
  }

  private _unreachableResult(upper: Bone, lower: Bone): IKResult {
    return {
      reachable:    false,
      upperAngle:   upper.angle,
      lowerAngle:   lower.angle,
      elbowPosition: upper.tip(),
      wristPosition: lower.tip(),
    };
  }
}
