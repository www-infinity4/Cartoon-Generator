/**
 * Machinist Mario Engine — AABB (Axis-Aligned Bounding Box)
 *
 * The "Safety Cage" / Work Envelope for CNC, 3-D printing, and aero-physics.
 * Every asset, toolpath, and IK joint operates inside an AABB so that the
 * AI can detect collisions and self-heal paths before a single motor turns.
 *
 * Design notes:
 *   • Immutable by default — every mutating operation returns a new AABB.
 *   • An AABB constructed with no arguments starts in the "empty" state
 *     (min = +Infinity, max = -Infinity) and expands via `expandByPoint`.
 *   • All axes are world-space millimetres, matching Vector3 and G-Code units.
 */
import { Vector3 } from './vector3';

export class AABB {
  constructor(
    public readonly min: Vector3 = new Vector3( Infinity,  Infinity,  Infinity),
    public readonly max: Vector3 = new Vector3(-Infinity, -Infinity, -Infinity),
  ) {}

  // ── State helpers ─────────────────────────────────────────────────────────

  /**
   * Returns `true` when the box has never been expanded (min > max on any axis).
   * An empty AABB contains no points and intersects nothing.
   */
  isEmpty(): boolean {
    return (
      this.min.x > this.max.x ||
      this.min.y > this.max.y ||
      this.min.z > this.max.z
    );
  }

  // ── Expansion ─────────────────────────────────────────────────────────────

  /**
   * Hand-over-hand expansion: grow the box to include a new Spark (Vector3).
   * Returns a new AABB — the original is not mutated.
   */
  expandByPoint(p: Vector3): AABB {
    return new AABB(
      new Vector3(
        Math.min(this.min.x, p.x),
        Math.min(this.min.y, p.y),
        Math.min(this.min.z, p.z),
      ),
      new Vector3(
        Math.max(this.max.x, p.x),
        Math.max(this.max.y, p.y),
        Math.max(this.max.z, p.z),
      ),
    );
  }

  /**
   * Grow the box by a scalar margin on all six faces.
   * Useful for adding clearance ("keeper distance") around a tool or clamp.
   */
  expandByScalar(margin: number): AABB {
    return new AABB(
      new Vector3(this.min.x - margin, this.min.y - margin, this.min.z - margin),
      new Vector3(this.max.x + margin, this.max.y + margin, this.max.z + margin),
    );
  }

  /**
   * Merge two AABBs into the smallest box that contains both.
   */
  merge(other: AABB): AABB {
    if (this.isEmpty()) return other;
    if (other.isEmpty()) return this;
    return new AABB(
      new Vector3(
        Math.min(this.min.x, other.min.x),
        Math.min(this.min.y, other.min.y),
        Math.min(this.min.z, other.min.z),
      ),
      new Vector3(
        Math.max(this.max.x, other.max.x),
        Math.max(this.max.y, other.max.y),
        Math.max(this.max.z, other.max.z),
      ),
    );
  }

  // ── Queries ───────────────────────────────────────────────────────────────

  /**
   * Crash detection: returns `true` when this box and `other` overlap on all
   * three axes (touching faces count as intersecting).
   */
  intersects(other: AABB): boolean {
    if (this.isEmpty() || other.isEmpty()) return false;
    return (
      this.min.x <= other.max.x && this.max.x >= other.min.x &&
      this.min.y <= other.max.y && this.max.y >= other.min.y &&
      this.min.z <= other.max.z && this.max.z >= other.min.z
    );
  }

  /**
   * Dimension-jump safety: returns `true` when point `p` lies inside (or on
   * the surface of) this box.  Used by the G-Code interpreter to verify every
   * move before it is executed.
   */
  contains(p: Vector3): boolean {
    return (
      p.x >= this.min.x && p.x <= this.max.x &&
      p.y >= this.min.y && p.y <= this.max.y &&
      p.z >= this.min.z && p.z <= this.max.z
    );
  }

  /**
   * Returns `true` when this box completely encloses `other`
   * (i.e. `other` is a subset of `this`).
   */
  containsAABB(other: AABB): boolean {
    if (this.isEmpty() || other.isEmpty()) return false;
    return (
      this.min.x <= other.min.x && this.max.x >= other.max.x &&
      this.min.y <= other.min.y && this.max.y >= other.max.y &&
      this.min.z <= other.min.z && this.max.z >= other.max.z
    );
  }

  // ── Derived geometry ──────────────────────────────────────────────────────

  /** Centre point of the box. */
  center(): Vector3 {
    return new Vector3(
      (this.min.x + this.max.x) / 2,
      (this.min.y + this.max.y) / 2,
      (this.min.z + this.max.z) / 2,
    );
  }

  /** Per-axis extents (width, height, depth). */
  size(): Vector3 {
    return new Vector3(
      this.max.x - this.min.x,
      this.max.y - this.min.y,
      this.max.z - this.min.z,
    );
  }

  /** Half-extents (radius on each axis). */
  halfSize(): Vector3 {
    const s = this.size();
    return new Vector3(s.x / 2, s.y / 2, s.z / 2);
  }

  /** Volume of the box in cubic units. */
  volume(): number {
    if (this.isEmpty()) return 0;
    const s = this.size();
    return s.x * s.y * s.z;
  }

  /**
   * Clamp a point to the nearest location inside (or on the surface of) this
   * box.  Used by the G-Code interpreter's self-heal path to pull an
   * out-of-bounds coordinate back inside the work envelope.
   */
  clampPoint(p: Vector3): Vector3 {
    return new Vector3(
      Math.max(this.min.x, Math.min(this.max.x, p.x)),
      Math.max(this.min.y, Math.min(this.max.y, p.y)),
      Math.max(this.min.z, Math.min(this.max.z, p.z)),
    );
  }

  /**
   * Returns the 8 corner vertices of the box, ordered:
   *   0: min, 1–6: mixed, 7: max.
   * Useful for rendering a wireframe cage in Canvitar.
   */
  corners(): Vector3[] {
    const { min: n, max: x } = this;
    return [
      new Vector3(n.x, n.y, n.z),
      new Vector3(x.x, n.y, n.z),
      new Vector3(n.x, x.y, n.z),
      new Vector3(x.x, x.y, n.z),
      new Vector3(n.x, n.y, x.z),
      new Vector3(x.x, n.y, x.z),
      new Vector3(n.x, x.y, x.z),
      new Vector3(x.x, x.y, x.z),
    ];
  }

  /**
   * The 12 edges of the box as pairs of corner indices (for wireframe
   * rendering via `Canvitar.renderWireframe`).
   */
  static readonly EDGES: ReadonlyArray<[number, number]> = [
    // Bottom face
    [0, 1], [1, 3], [3, 2], [2, 0],
    // Top face
    [4, 5], [5, 7], [7, 6], [6, 4],
    // Vertical pillars
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];

  // ── Octree spatial partitioning ───────────────────────────────────────────

  /**
   * Split this box into 8 equal child octants.
   * The key to handling 144,000 Sparks without inertia: only check
   * collisions within the same octant.
   */
  octants(): AABB[] {
    const c = this.center();
    const { min: n, max: x } = this;
    return [
      new AABB(new Vector3(n.x, n.y, n.z), new Vector3(c.x, c.y, c.z)),
      new AABB(new Vector3(c.x, n.y, n.z), new Vector3(x.x, c.y, c.z)),
      new AABB(new Vector3(n.x, c.y, n.z), new Vector3(c.x, x.y, c.z)),
      new AABB(new Vector3(c.x, c.y, n.z), new Vector3(x.x, x.y, c.z)),
      new AABB(new Vector3(n.x, n.y, c.z), new Vector3(c.x, c.y, x.z)),
      new AABB(new Vector3(c.x, n.y, c.z), new Vector3(x.x, c.y, x.z)),
      new AABB(new Vector3(n.x, c.y, c.z), new Vector3(c.x, x.y, x.z)),
      new AABB(new Vector3(c.x, c.y, c.z), new Vector3(x.x, x.y, x.z)),
    ];
  }

  // ── Static constructors ───────────────────────────────────────────────────

  /** Build the tightest AABB that wraps all points in the array. */
  static fromPoints(points: Vector3[]): AABB {
    return points.reduce((box, p) => box.expandByPoint(p), new AABB());
  }

  /**
   * Construct directly from min/max component values without creating
   * intermediate Vector3 objects.
   */
  static fromMinMax(
    minX: number, minY: number, minZ: number,
    maxX: number, maxY: number, maxZ: number,
  ): AABB {
    return new AABB(
      new Vector3(minX, minY, minZ),
      new Vector3(maxX, maxY, maxZ),
    );
  }

  // ── Formatting ────────────────────────────────────────────────────────────

  toString(): string {
    if (this.isEmpty()) return 'AABB(empty)';
    const f = (v: Vector3) =>
      `(${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)})`;
    return `AABB(min=${f(this.min)}, max=${f(this.max)})`;
  }
}
