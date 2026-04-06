/**
 * Machinist Mario Engine — G-Code Interpreter
 *
 * The "Sensor" layer of the No-Inertia OS (Cart 06 — Self-Healing Repo).
 * Reads raw G-Code text, converts every move command into a Vector3 spark,
 * and validates it against an AABB work envelope before accepting it.
 *
 * Supported commands:
 *   G0  — Rapid positioning (no extrusion)
 *   G1  — Linear feed move
 *   G2  — Clockwise arc (XY plane, I/J centre offsets)
 *   G3  — Counter-clockwise arc (XY plane, I/J centre offsets)
 *   G17 — Select XY plane (default)
 *   G18 — Select XZ plane
 *   G19 — Select YZ plane
 *   G20 — Switch to inch units
 *   G21 — Switch to millimetre units (default)
 *   G28 — Home all axes (or named axes)
 *   G90 — Absolute positioning mode (default)
 *   G91 — Incremental positioning mode
 *   G92 — Set position / reset extruder
 *   M-codes are parsed and stored but do not affect motion.
 *
 * Self-heal policy (configurable):
 *   'warn'  — log a warning, skip the offending move
 *   'clamp' — clamp the target to the AABB surface and continue
 *   'throw' — throw an error immediately
 */
import { Vector3 } from './vector3';
import { AABB } from './aabb';

// ── Types ─────────────────────────────────────────────────────────────────────

export type OutOfBoundsPolicy = 'warn' | 'clamp' | 'throw';
export type ArcPlane = 'XY' | 'XZ' | 'YZ';
export type Units = 'mm' | 'inch';
export type PositioningMode = 'absolute' | 'incremental';

/** A parsed, validated move record stored in the interpreter's history. */
export interface MoveRecord {
  /** Sequential line number within the program. */
  lineNumber: number;
  /** Original G-Code source text (stripped of comments). */
  source: string;
  /** G-command that produced this move (e.g. 'G1', 'G2'). */
  command: string;
  /** World-space destination after validation. */
  position: Vector3;
  /** Feed rate (mm/min) at the time of this move. */
  feedRate: number;
  /** Whether the target was modified by the self-heal clamp. */
  clamped: boolean;
  /** Points along a G2/G3 arc (empty for linear moves). */
  arcPoints: Vector3[];
}

/** Diagnostic emitted for every out-of-bounds event. */
export interface SafetyEvent {
  lineNumber: number;
  source: string;
  requested: Vector3;
  clamped: Vector3 | null;
  policy: OutOfBoundsPolicy;
}

// ── Interpreter ───────────────────────────────────────────────────────────────

export class GCodeInterpreter {
  // ── Machine state ──────────────────────────────────────────────────────────
  private _pos: Vector3 = new Vector3(0, 0, 0);
  private _feedRate: number = 1000;
  private _units: Units = 'mm';
  private _mode: PositioningMode = 'absolute';
  private _plane: ArcPlane = 'XY';

  // ── Output ─────────────────────────────────────────────────────────────────
  private _moves: MoveRecord[] = [];
  private _safetyLog: SafetyEvent[] = [];
  private _lineNumber: number = 0;

  /**
   * @param bounds  Work envelope. Every move target is tested against this box.
   * @param policy  What to do when a target is outside `bounds`.
   * @param arcSegments  Number of line segments used to approximate each arc.
   */
  constructor(
    public readonly bounds: AABB,
    public readonly policy: OutOfBoundsPolicy = 'warn',
    public readonly arcSegments: number = 32,
  ) {}

  // ── Public API ────────────────────────────────────────────────────────────

  /** Parse and execute a single line of G-Code. */
  parseLine(line: string): void {
    this._lineNumber++;
    const clean = line.split(';')[0].trim(); // strip comments
    if (!clean) return;

    const upper = clean.toUpperCase();
    const tokens = upper.split(/\s+/);
    const cmd = tokens[0];

    switch (cmd) {
      // ── Modal: units ─────────────────────────────────────────────────────
      case 'G20': this._units = 'inch'; break;
      case 'G21': this._units = 'mm';   break;

      // ── Modal: positioning mode ──────────────────────────────────────────
      case 'G90': this._mode = 'absolute';    break;
      case 'G91': this._mode = 'incremental'; break;

      // ── Modal: arc plane ─────────────────────────────────────────────────
      case 'G17': this._plane = 'XY'; break;
      case 'G18': this._plane = 'XZ'; break;
      case 'G19': this._plane = 'YZ'; break;

      // ── Home ─────────────────────────────────────────────────────────────
      case 'G28':
        this._pos = this.bounds.min.clone();
        break;

      // ── Set position (G92) ───────────────────────────────────────────────
      case 'G92': {
        const nx = this._getVal(tokens, 'X', this._pos.x);
        const ny = this._getVal(tokens, 'Y', this._pos.y);
        const nz = this._getVal(tokens, 'Z', this._pos.z);
        this._pos = new Vector3(nx, ny, nz);
        break;
      }

      // ── Linear moves (G0 / G1) ───────────────────────────────────────────
      case 'G0':
      case 'G1': {
        const f = this._getVal(tokens, 'F', this._feedRate);
        if (f !== this._feedRate) this._feedRate = f;

        const target = this._resolveTarget(tokens);
        const toMm   = this._units === 'inch' ? 25.4 : 1;
        const world  = new Vector3(target.x * toMm, target.y * toMm, target.z * toMm);

        this._acceptMove(cmd, clean, world, [], false);
        break;
      }

      // ── Arc moves (G2 = CW, G3 = CCW) ───────────────────────────────────
      case 'G2':
      case 'G3': {
        const f = this._getVal(tokens, 'F', this._feedRate);
        if (f !== this._feedRate) this._feedRate = f;

        const target  = this._resolveTarget(tokens);
        const toMm    = this._units === 'inch' ? 25.4 : 1;
        const worldT  = new Vector3(target.x * toMm, target.y * toMm, target.z * toMm);

        // Centre offsets (I, J, K) are always relative to current position
        const iOff = (this._getVal(tokens, 'I', 0)) * toMm;
        const jOff = (this._getVal(tokens, 'J', 0)) * toMm;
        const kOff = (this._getVal(tokens, 'K', 0)) * toMm;

        const arcPts = this._interpolateArc(worldT, iOff, jOff, kOff, cmd === 'G2');
        this._acceptMove(cmd, clean, worldT, arcPts, false);
        break;
      }

      // ── M-codes — parse but don't move ──────────────────────────────────
      default:
        if (cmd.startsWith('M')) break; // silently accept
        // Ignore unrecognised commands
        break;
    }
  }

  /**
   * Parse an entire G-Code program (newline-separated or array of lines).
   */
  parseProgram(program: string | string[]): void {
    const lines = Array.isArray(program) ? program : program.split('\n');
    for (const line of lines) this.parseLine(line);
  }

  /** All validated move records, in execution order. */
  getMoves(): MoveRecord[] {
    return [...this._moves];
  }

  /**
   * Flat toolpath: the validated world-space position after each move.
   * Arc moves contribute their interpolated intermediate points too.
   */
  getToolpath(): Vector3[] {
    const pts: Vector3[] = [];
    for (const m of this._moves) {
      if (m.arcPoints.length > 0) pts.push(...m.arcPoints);
      else pts.push(m.position);
    }
    return pts;
  }

  /** All safety events (out-of-bounds detections). */
  getSafetyLog(): SafetyEvent[] {
    return [...this._safetyLog];
  }

  /** Current machine position (after all parsed lines). */
  get currentPosition(): Vector3 {
    return this._pos.clone();
  }

  /** Number of out-of-bounds events detected. */
  get violationCount(): number {
    return this._safetyLog.length;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Resolve the X/Y/Z values in a token list to a world-space Vector3,
   * handling absolute vs. incremental mode.
   */
  private _resolveTarget(tokens: string[]): Vector3 {
    if (this._mode === 'absolute') {
      return new Vector3(
        this._getVal(tokens, 'X', this._pos.x),
        this._getVal(tokens, 'Y', this._pos.y),
        this._getVal(tokens, 'Z', this._pos.z),
      );
    }
    // Incremental: offsets added to current position
    return new Vector3(
      this._pos.x + this._getVal(tokens, 'X', 0),
      this._pos.y + this._getVal(tokens, 'Y', 0),
      this._pos.z + this._getVal(tokens, 'Z', 0),
    );
  }

  /**
   * Extract the numeric value for a given axis/parameter letter from the token
   * list (e.g. 'X', 'Y', 'I', 'F').  Returns `fallback` if not present.
   */
  private _getVal(tokens: string[], key: string, fallback: number): number {
    const tok = tokens.find(t => t.startsWith(key) && t.length > key.length);
    if (!tok) return fallback;
    const n = parseFloat(tok.substring(key.length));
    return isNaN(n) ? fallback : n;
  }

  /**
   * Validate `target` against the work envelope, apply the self-heal policy
   * if needed, advance the machine position, and store the move record.
   */
  private _acceptMove(
    cmd: string,
    source: string,
    target: Vector3,
    arcPoints: Vector3[],
    _rapid: boolean,
  ): void {
    let final = target;
    let wasClamped = false;

    if (!this.bounds.contains(target)) {
      const clamped = this.bounds.clampPoint(target);

      const event: SafetyEvent = {
        lineNumber: this._lineNumber,
        source,
        requested: target,
        clamped: this.policy === 'clamp' ? clamped : null,
        policy: this.policy,
      };
      this._safetyLog.push(event);

      if (this.policy === 'throw') {
        throw new RangeError(
          `[SAFETY] Line ${this._lineNumber}: target ${target} is outside work envelope ${this.bounds}`,
        );
      } else if (this.policy === 'clamp') {
        final = clamped;
        wasClamped = true;
        console.warn(
          `[SAFETY] Line ${this._lineNumber}: clamped ${target} → ${clamped} | ${source}`,
        );
      } else {
        // 'warn': skip the move entirely
        console.warn(
          `[SAFETY] Line ${this._lineNumber}: out-of-bounds move skipped | ${source}`,
        );
        return;
      }
    }

    this._pos = final;
    this._moves.push({
      lineNumber: this._lineNumber,
      source,
      command:   cmd,
      position:  final,
      feedRate:  this._feedRate,
      clamped:   wasClamped,
      arcPoints: arcPoints.map(p => this.bounds.contains(p) ? p : this.bounds.clampPoint(p)),
    });
  }

  /**
   * Generate arc interpolation points for G2/G3.
   *
   * The arc is computed in the currently selected plane (XY, XZ, or YZ).
   * I/J/K are centre offsets relative to the current position.
   *
   * @param target   End point of the arc.
   * @param iOff     Centre offset along the first plane axis.
   * @param jOff     Centre offset along the second plane axis.
   * @param kOff     Centre offset along the third axis (XZ/YZ planes).
   * @param clockwise  true = G2 (CW), false = G3 (CCW).
   */
  private _interpolateArc(
    target: Vector3,
    iOff: number,
    jOff: number,
    kOff: number,
    clockwise: boolean,
  ): Vector3[] {
    // Determine which axes are in-plane vs. the helical axis
    let [a1, a2, helical]: Array<keyof Vector3> = ['x', 'y', 'z'];
    let [c1, c2]: [number, number] = [iOff, jOff];

    if (this._plane === 'XZ') {
      [a1, a2, helical] = ['x', 'z', 'y'];
      [c1, c2] = [iOff, kOff];
    } else if (this._plane === 'YZ') {
      [a1, a2, helical] = ['y', 'z', 'x'];
      [c1, c2] = [jOff, kOff];
    }

    // Centre of the arc circle in world space
    const cx = (this._pos[a1] as number) + c1;
    const cy = (this._pos[a2] as number) + c2;

    // Start and end angles
    const startAngle = Math.atan2((this._pos[a2] as number) - cy, (this._pos[a1] as number) - cx);
    const endAngle   = Math.atan2((target[a2]    as number) - cy, (target[a1]    as number) - cx);
    const radius     = Math.hypot((this._pos[a1] as number) - cx, (this._pos[a2] as number) - cy);

    // Sweep angle with correct winding
    let sweep = endAngle - startAngle;
    if (clockwise  && sweep > 0) sweep -= 2 * Math.PI;
    if (!clockwise && sweep < 0) sweep += 2 * Math.PI;

    // Helical interpolation (Z changes linearly over the arc)
    const startHelical = this._pos[helical] as number;
    const endHelical   = target[helical]    as number;
    const dHelical     = endHelical - startHelical;

    const n = this.arcSegments;
    const pts: Vector3[] = [];

    for (let i = 1; i <= n; i++) {
      const t     = i / n;
      const angle = startAngle + sweep * t;
      const p     = new Vector3();

      (p as Record<string, number>)[a1 as string]      = cx + radius * Math.cos(angle);
      (p as Record<string, number>)[a2 as string]      = cy + radius * Math.sin(angle);
      (p as Record<string, number>)[helical as string] = startHelical + dHelical * t;

      pts.push(p);
    }

    return pts;
  }
}
