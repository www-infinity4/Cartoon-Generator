/**
 * Vector3 — 3D vector math for the Machinist Mario Engine.
 * Provides the spatial coordinate system used by kinematics,
 * toolpath generation, AABB safety bounds, and G-Code output.
 */
export class Vector3 {
  constructor(
    public x: number = 0,
    public y: number = 0,
    public z: number = 0,
  ) {}

  /** Euclidean length of the vector. */
  magnitude(): number {
    return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z);
  }

  /** Returns a unit-length copy of this vector. */
  normalized(): Vector3 {
    const m = this.magnitude();
    if (m === 0) return new Vector3();
    return new Vector3(this.x / m, this.y / m, this.z / m);
  }

  /** Returns a new vector scaled uniformly by `factor`. */
  scale(factor: number): Vector3 {
    return new Vector3(this.x * factor, this.y * factor, this.z * factor);
  }

  /** Component-wise addition. */
  add(other: Vector3): Vector3 {
    return new Vector3(this.x + other.x, this.y + other.y, this.z + other.z);
  }

  /** Component-wise subtraction. */
  subtract(other: Vector3): Vector3 {
    return new Vector3(this.x - other.x, this.y - other.y, this.z - other.z);
  }

  /** Dot product. */
  dot(other: Vector3): number {
    return this.x * other.x + this.y * other.y + this.z * other.z;
  }

  /** Cross product. */
  cross(other: Vector3): Vector3 {
    return new Vector3(
      this.y * other.z - this.z * other.y,
      this.z * other.x - this.x * other.z,
      this.x * other.y - this.y * other.x,
    );
  }

  /** Linear interpolation toward `other` by `t ∈ [0,1]`. */
  lerp(other: Vector3, t: number): Vector3 {
    return new Vector3(
      this.x + (other.x - this.x) * t,
      this.y + (other.y - this.y) * t,
      this.z + (other.z - this.z) * t,
    );
  }

  /** Euclidean distance to another point. */
  distanceTo(other: Vector3): number {
    return this.subtract(other).magnitude();
  }

  /** Returns a formatted string for G-Code coordinate output. */
  toGCode(decimals: number = 4): string {
    return `X${this.x.toFixed(decimals)} Y${this.y.toFixed(decimals)} Z${this.z.toFixed(decimals)}`;
  }

  toString(): string {
    return `Vector3(${this.x}, ${this.y}, ${this.z})`;
  }

  /** Creates a copy of this vector. */
  clone(): Vector3 {
    return new Vector3(this.x, this.y, this.z);
  }

  // ── Static helpers ──────────────────────────────────────────────────────────

  static zero(): Vector3 { return new Vector3(0, 0, 0); }
  static one(): Vector3  { return new Vector3(1, 1, 1); }
  static up(): Vector3   { return new Vector3(0, 1, 0); }
  static right(): Vector3 { return new Vector3(1, 0, 0); }
  static forward(): Vector3 { return new Vector3(0, 0, 1); }
}
