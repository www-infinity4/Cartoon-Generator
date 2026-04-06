/**
 * Machinist Mario Engine — Canvitar* Renderer
 *
 * Manifesting 3D Sparks onto 2D Web-Fabric via Perspective Divide.
 *
 * The Canvitar* is dependency-free beyond the engine's own Vector3/Matrix4
 * types, making it runnable inside any WebView — including the Termux
 * Android overlay — with no build step beyond TypeScript compilation.
 *
 * Key concepts:
 *   • Perspective project  — "zoom = focalLength / (focalLength + z)"
 *   • Low focalLength      — retro 8-bit Nintendo perspective (~100)
 *   • High focalLength     — realistic cinematic depth (~500–800)
 *   • HUD overlay          — fixed-screen-space text / data readouts
 *   • Aero feedback        — live colour coding driven by drag coefficient
 */
import { Vector3 } from './vector3';
import { Matrix4 } from './matrix4';

// ── Types ──────────────────────────────────────────────────────────────────────

/** A projected 2-D pixel coordinate. */
export interface ScreenPoint {
  u: number;
  v: number;
  /** Depth after projection (smaller = closer). Used for Z-sort. */
  depth: number;
  /** Whether the original point was behind the camera. */
  clipped: boolean;
}

/** Options accepted by `Canvitar.renderPath`. */
export interface RenderPathOptions {
  color?: string;
  lineWidth?: number;
  /** If true the path is closed (last point connected back to first). */
  closed?: boolean;
  /** Fill colour; if provided the closed path is also filled. */
  fillColor?: string;
  /** Global alpha for this draw call (0–1). */
  alpha?: number;
}

/** Options for the heads-up display. */
export interface HUDEntry {
  label: string;
  value: string | number;
  /** Optional colour; defaults to white. */
  color?: string;
}

// ── Canvitar class ────────────────────────────────────────────────────────────

/**
 * High-performance, dependency-free Canvas 2D renderer for the
 * Machinist Mario 3D asset engine.
 */
export class Canvitar {
  private readonly ctx: CanvasRenderingContext2D;

  /** Canvas pixel width. */
  readonly width: number;

  /** Canvas pixel height. */
  readonly height: number;

  /**
   * The "Lens" of the Infinity AI.
   * • ~100  → retro 8-bit / Nintendo perspective
   * • ~500  → realistic depth (default)
   * • ~800+ → near-orthographic / aero-engineering view
   */
  focalLength: number;

  /**
   * Background clear colour.  Set to 'transparent' to overlay on a
   * Termux / WebView terminal background.
   */
  clearColor: string;

  constructor(canvas: HTMLCanvasElement, focalLength: number = 500) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvitar: could not obtain 2D rendering context.');
    this.ctx         = ctx;
    this.width       = canvas.width;
    this.height      = canvas.height;
    this.focalLength = focalLength;
    this.clearColor  = '#000000';
  }

  // ── Core projection ───────────────────────────────────────────────────────

  /**
   * Project a single 3-D Spark into 2-D pixel space using the Perspective
   * Divide: zoom = focalLength / (focalLength + z).
   *
   * Points with z ≤ −focalLength are behind the camera and are flagged as
   * clipped so callers can skip them.
   */
  project(v: Vector3): ScreenPoint {
    const denom = this.focalLength + v.z;

    if (denom <= 0) {
      return { u: 0, v: 0, depth: Infinity, clipped: true };
    }

    const zoom = this.focalLength / denom;

    return {
      u:       v.x * zoom + this.width  / 2,
      v:       v.y * zoom + this.height / 2,
      depth:   denom,
      clipped: false,
    };
  }

  /**
   * Project all points in an array, optionally applying a world-transform
   * matrix first.  Returns `ScreenPoint[]` in the same order.
   */
  projectPath(path: Vector3[], transform?: Matrix4): ScreenPoint[] {
    if (transform) {
      return path.map(p => this.project(transform.applyToVector(p)));
    }
    return path.map(p => this.project(p));
  }

  // ── Drawing ───────────────────────────────────────────────────────────────

  /**
   * Render an ordered series of 3D points as a Canvas 2D polyline / polygon.
   *
   * @param path      World-space Vector3 waypoints.
   * @param options   Stroke/fill style overrides.
   * @param transform Optional Matrix4 applied before projection (e.g. rotation).
   */
  renderPath(
    path: Vector3[],
    options: RenderPathOptions = {},
    transform?: Matrix4,
  ): void {
    if (path.length < 2) return;

    const {
      color     = '#00FF00',
      lineWidth = 2,
      closed    = false,
      fillColor,
      alpha     = 1,
    } = options;

    const pts = this.projectPath(path, transform);

    const saved = this.ctx.globalAlpha;
    this.ctx.globalAlpha = alpha;
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth   = lineWidth;
    this.ctx.beginPath();

    let started = false;
    for (const pt of pts) {
      if (pt.clipped) continue;
      if (!started) { this.ctx.moveTo(pt.u, pt.v); started = true; }
      else            this.ctx.lineTo(pt.u, pt.v);
    }

    if (closed && started) this.ctx.closePath();

    if (fillColor && started) {
      this.ctx.fillStyle = fillColor;
      this.ctx.fill();
    }
    this.ctx.stroke();
    this.ctx.globalAlpha = saved;
  }

  /**
   * Render a wireframe made of independent line segments (edge list).
   * `edges` is an array of index pairs `[i, j]` into `vertices`.
   */
  renderWireframe(
    vertices: Vector3[],
    edges: [number, number][],
    options: RenderPathOptions = {},
    transform?: Matrix4,
  ): void {
    const pts = this.projectPath(vertices, transform);
    const { color = '#00FF00', lineWidth = 1, alpha = 1 } = options;

    const saved = this.ctx.globalAlpha;
    this.ctx.globalAlpha = alpha;
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth   = lineWidth;

    for (const [i, j] of edges) {
      const a = pts[i], b = pts[j];
      if (!a || !b || a.clipped || b.clipped) continue;
      this.ctx.beginPath();
      this.ctx.moveTo(a.u, a.v);
      this.ctx.lineTo(b.u, b.v);
      this.ctx.stroke();
    }

    this.ctx.globalAlpha = saved;
  }

  /**
   * Render projected points as individual dots (useful for sparse Spark clouds).
   */
  renderPoints(
    points: Vector3[],
    radius: number = 3,
    color: string  = '#FFD700',
    transform?: Matrix4,
  ): void {
    const pts = this.projectPath(points, transform);
    this.ctx.fillStyle = color;

    for (const pt of pts) {
      if (pt.clipped) continue;
      this.ctx.beginPath();
      this.ctx.arc(pt.u, pt.v, radius, 0, Math.PI * 2);
      this.ctx.fill();
    }
  }

  // ── Aero feedback coloring ────────────────────────────────────────────────

  /**
   * Colour-code a toolpath based on a scalar field value (e.g. drag coefficient).
   * Green → acceptable; amber → caution; red → exceeds limit.
   *
   * @param path       World-space toolpath.
   * @param values     Scalar value per point (same length as `path`).
   * @param limit      Maximum acceptable value; segments above this are red.
   * @param transform  Optional world transform.
   */
  renderAeroFeedback(
    path: Vector3[],
    values: number[],
    limit: number,
    transform?: Matrix4,
  ): void {
    if (path.length < 2) return;
    const pts = this.projectPath(path, transform);

    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      if (a.clipped || b.clipped) continue;

      const v = values[i] ?? 0;
      const ratio = Math.min(1, v / limit);

      // Green (0,255,0) → Amber (255,165,0) → Red (255,0,0)
      let r: number, g: number;
      if (ratio < 0.5) {
        r = Math.round(ratio * 2 * 255);
        g = 255;
      } else {
        r = 255;
        g = Math.round((1 - (ratio - 0.5) * 2) * 165);
      }

      this.ctx.strokeStyle = `rgb(${r},${g},0)`;
      this.ctx.lineWidth   = 2;
      this.ctx.beginPath();
      this.ctx.moveTo(a.u, a.v);
      this.ctx.lineTo(b.u, b.v);
      this.ctx.stroke();
    }
  }

  // ── HUD overlay ───────────────────────────────────────────────────────────

  /**
   * Render a data heads-up display in the top-left corner.
   * Entries are rendered in screen space (no projection).
   *
   * @param entries  Label/value pairs to display.
   * @param x        Left edge (px), default 12.
   * @param y        Top edge (px), default 20.
   */
  renderHUD(entries: HUDEntry[], x: number = 12, y: number = 20): void {
    const lineH = 18;
    this.ctx.font         = '13px "Courier New", monospace';
    this.ctx.textBaseline = 'top';

    entries.forEach((entry, i) => {
      const text = `${entry.label}: ${entry.value}`;
      const ty   = y + i * lineH;

      // Shadow for legibility on any background
      this.ctx.fillStyle = 'rgba(0,0,0,0.6)';
      this.ctx.fillText(text, x + 1, ty + 1);

      this.ctx.fillStyle = entry.color ?? '#FFFFFF';
      this.ctx.fillText(text, x, ty);
    });
  }

  /**
   * Render a pulsing "LIVE" indicator — useful for syncing with Termux log
   * output (e.g. llama-cli "STAY_ALIVE" heartbeat).
   *
   * @param pulse  Value in [0,1] driving the pulse brightness (e.g. `Math.sin(t)`).
   */
  renderLiveIndicator(pulse: number): void {
    const alpha = 0.4 + 0.6 * Math.max(0, Math.min(1, pulse));
    const x = this.width  - 70;
    const y = this.height - 22;

    this.ctx.globalAlpha = alpha;
    this.ctx.fillStyle   = '#FF4444';
    this.ctx.beginPath();
    this.ctx.arc(x, y + 6, 5, 0, Math.PI * 2);
    this.ctx.fill();

    this.ctx.globalAlpha  = alpha;
    this.ctx.fillStyle    = '#FFFFFF';
    this.ctx.font         = 'bold 13px "Courier New", monospace';
    this.ctx.textBaseline = 'top';
    this.ctx.fillText('● LIVE', x - 4, y);

    this.ctx.globalAlpha = 1;
  }

  // ── Frame utilities ───────────────────────────────────────────────────────

  /** Clear the canvas to `this.clearColor`. */
  clear(): void {
    this.ctx.fillStyle = this.clearColor;
    this.ctx.fillRect(0, 0, this.width, this.height);
  }

  /**
   * Convenience method: rotate all points around Y by `angle` radians and
   * render the path.  Mirrors the "Cart 08 Swirl" pattern from the spec.
   *
   * @param path     Original world-space toolpath (not mutated).
   * @param angle    Y-rotation in radians (e.g. `time * 0.01`).
   * @param options  Stroke style overrides.
   */
  renderRotatingY(
    path: Vector3[],
    angle: number,
    options: RenderPathOptions = {},
  ): void {
    this.renderPath(path, options, Matrix4.rotateY(angle));
  }
}
