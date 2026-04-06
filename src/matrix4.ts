/**
 * Machinist Mario Engine — Matrix4
 *
 * A column-major 4×4 homogeneous transform matrix.  Provides the "Dimension-
 * Jumping" math that rotates, translates, and scales the 144,000 Sparks before
 * the Canvitar* projects them onto the 2D Web-Fabric.
 *
 * Storage convention (matches WebGL / OpenGL):
 *   m[ 0] m[ 4] m[ 8] m[12]    col 0  col 1  col 2  col 3
 *   m[ 1] m[ 5] m[ 9] m[13]
 *   m[ 2] m[ 6] m[10] m[14]
 *   m[ 3] m[ 7] m[11] m[15]
 */
import { Vector3 } from './vector3';

export class Matrix4 {
  /** Flat array of 16 values in column-major order. */
  readonly m: Float64Array;

  constructor(values?: ArrayLike<number>) {
    this.m = new Float64Array(16);
    if (values) {
      for (let i = 0; i < 16; i++) this.m[i] = values[i] ?? 0;
    } else {
      this._identity();
    }
  }

  // ── Factory constructors ──────────────────────────────────────────────────

  /** Identity matrix. */
  static identity(): Matrix4 {
    return new Matrix4();
  }

  /**
   * Rotation around the X-axis by `radians`.
   *   [ 1    0       0    0 ]
   *   [ 0  cos θ  -sin θ  0 ]
   *   [ 0  sin θ   cos θ  0 ]
   *   [ 0    0       0    1 ]
   */
  static rotateX(radians: number): Matrix4 {
    const c = Math.cos(radians);
    const s = Math.sin(radians);
    // prettier-ignore
    return new Matrix4([
      1,  0,  0, 0,
      0,  c,  s, 0,
      0, -s,  c, 0,
      0,  0,  0, 1,
    ]);
  }

  /**
   * Rotation around the Y-axis by `radians`.
   *   [  cos θ  0  sin θ  0 ]
   *   [    0    1    0    0 ]
   *   [ -sin θ  0  cos θ  0 ]
   *   [    0    0    0    1 ]
   */
  static rotateY(radians: number): Matrix4 {
    const c = Math.cos(radians);
    const s = Math.sin(radians);
    // prettier-ignore
    return new Matrix4([
       c, 0, -s, 0,
       0, 1,  0, 0,
       s, 0,  c, 0,
       0, 0,  0, 1,
    ]);
  }

  /**
   * Rotation around the Z-axis by `radians`.
   *   [ cos θ  -sin θ  0  0 ]
   *   [ sin θ   cos θ  0  0 ]
   *   [   0       0    1  0 ]
   *   [   0       0    0  1 ]
   */
  static rotateZ(radians: number): Matrix4 {
    const c = Math.cos(radians);
    const s = Math.sin(radians);
    // prettier-ignore
    return new Matrix4([
       c, s, 0, 0,
      -s, c, 0, 0,
       0, 0, 1, 0,
       0, 0, 0, 1,
    ]);
  }

  /** Uniform or non-uniform scale. */
  static scale(sx: number, sy: number = sx, sz: number = sx): Matrix4 {
    // prettier-ignore
    return new Matrix4([
      sx,  0,  0, 0,
       0, sy,  0, 0,
       0,  0, sz, 0,
       0,  0,  0, 1,
    ]);
  }

  /** Translation matrix. */
  static translate(tx: number, ty: number, tz: number): Matrix4 {
    // prettier-ignore
    return new Matrix4([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      tx, ty, tz, 1,
    ]);
  }

  /**
   * Perspective projection matrix (right-handed, clip space [-1,1]).
   * @param fovY   Vertical field of view in radians.
   * @param aspect Width / height ratio.
   * @param near   Near clip distance (> 0).
   * @param far    Far clip distance (> near).
   */
  static perspective(fovY: number, aspect: number, near: number, far: number): Matrix4 {
    const f = 1 / Math.tan(fovY / 2);
    const nf = 1 / (near - far);
    // prettier-ignore
    return new Matrix4([
      f / aspect, 0,                      0,  0,
      0,          f,                      0,  0,
      0,          0, (far + near) * nf,      -1, // -1 in w-column drives the perspective divide (w = -z after transform)
      0,          0, 2 * far * near * nf,     0,
    ]);
  }

  // ── Operations ────────────────────────────────────────────────────────────

  /** Matrix multiplication: returns `this × other`. */
  multiply(other: Matrix4): Matrix4 {
    const a = this.m;
    const b = other.m;
    const out = new Float64Array(16);

    for (let col = 0; col < 4; col++) {
      for (let row = 0; row < 4; row++) {
        let sum = 0;
        for (let k = 0; k < 4; k++) {
          sum += a[k * 4 + row] * b[col * 4 + k];
        }
        out[col * 4 + row] = sum;
      }
    }
    return new Matrix4(out);
  }

  /**
   * Apply this transform to a Vector3.
   * The vector is promoted to homogeneous coords (w=1), multiplied,
   * then divided by the resulting w for perspective-correct output.
   */
  applyToVector(v: Vector3): Vector3 {
    const { m } = this;
    const x = v.x, y = v.y, z = v.z;

    const rx = m[0] * x + m[4] * y + m[8]  * z + m[12];
    const ry = m[1] * x + m[5] * y + m[9]  * z + m[13];
    const rz = m[2] * x + m[6] * y + m[10] * z + m[14];
    const rw = m[3] * x + m[7] * y + m[11] * z + m[15];

    if (rw === 0 || rw === 1) return new Vector3(rx, ry, rz);
    return new Vector3(rx / rw, ry / rw, rz / rw);
  }

  /**
   * Transpose of this matrix (swap rows and columns).
   * Useful for converting between row-major and column-major conventions.
   */
  transpose(): Matrix4 {
    const { m } = this;
    // prettier-ignore
    return new Matrix4([
      m[0], m[4], m[8],  m[12],
      m[1], m[5], m[9],  m[13],
      m[2], m[6], m[10], m[14],
      m[3], m[7], m[11], m[15],
    ]);
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private _identity(): void {
    this.m.fill(0);
    this.m[0] = this.m[5] = this.m[10] = this.m[15] = 1;
  }

  toString(): string {
    const { m } = this;
    const fmt = (n: number) => n.toFixed(4).padStart(9);
    return [
      `[ ${fmt(m[0])} ${fmt(m[4])} ${fmt(m[8])}  ${fmt(m[12])} ]`,
      `[ ${fmt(m[1])} ${fmt(m[5])} ${fmt(m[9])}  ${fmt(m[13])} ]`,
      `[ ${fmt(m[2])} ${fmt(m[6])} ${fmt(m[10])} ${fmt(m[14])} ]`,
      `[ ${fmt(m[3])} ${fmt(m[7])} ${fmt(m[11])} ${fmt(m[15])} ]`,
    ].join('\n');
  }
}
