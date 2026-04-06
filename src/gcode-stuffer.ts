/**
 * Machinist Mario Engine — GCodeStuffer
 *
 * The "Infinity Pipe" — a backpressure-aware async-generator streaming buffer
 * for processing arbitrarily large G-Code files without RAM spikes.
 *
 * Instead of loading 500,000+ lines into memory at once, the Stuffer reads
 * the source in configurable chunks, validates each chunk through the MTSV
 * worker pool, and yields the safe sparks to the consumer one batch at a time.
 * The `yield` keyword acts as a natural backpressure valve: if the CNC motor
 * (or Canvitar renderer) is busy, the generator simply pauses here until the
 * consumer calls `.next()` again.
 *
 * Memory model
 * ────────────
 *   Input text   →  GCodeInterpreter (line by line)  →  Vector3 batch
 *   Vector3 batch  →  MTSV (parallel AABB check)  →  yield safe sparks
 *   flush remaining lines → yield final batch
 *   RAM usage ≈ O(bufferSize) regardless of total file size.
 *
 * Self-heal mode
 * ──────────────
 *   Use `streamGCode(lines, cage, { onViolation: 'clamp' })` to have the
 *   Stuffer automatically clamp out-of-bounds sparks to the cage surface
 *   instead of throwing.  The clamped sparks are still yielded but are
 *   flagged in the accompanying `StreamChunk` metadata.
 */
import { Vector3 } from './vector3';
import { AABB } from './aabb';
import { MTSV, ValidationReport } from './mtsv';
import { GCodeInterpreter } from './gcode-interpreter';

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * What the Stuffer does when MTSV finds violations in a chunk.
 *   'throw'  — throw an Error and stop the stream (default, safest)
 *   'clamp'  — clamp violating sparks to the cage surface and continue
 *   'skip'   — drop violating sparks and continue with remaining safe ones
 *   'warn'   — log a warning and yield the chunk as-is (no modification)
 */
export type ViolationPolicy = 'throw' | 'clamp' | 'skip' | 'warn';

/** Options accepted by `streamGCode` and `streamWithStats`. */
export interface StufferOptions {
  /**
   * Number of parsed Vector3 sparks to accumulate before dispatching a
   * validation+yield cycle.  Larger values = fewer round-trips to workers
   * but higher peak memory.  Default: 5 000.
   */
  bufferSize?: number;
  /**
   * Action taken when MTSV finds out-of-bounds sparks in a chunk.
   * Default: 'throw'.
   */
  onViolation?: ViolationPolicy;
  /**
   * If true, only G0/G1/G2/G3 lines that change the XYZ position are
   * included.  Non-motion lines (M-codes, comments, etc.) are silently
   * skipped.  Default: true.
   */
  motionOnly?: boolean;
}

/** A single validated batch handed to the consumer. */
export interface StreamChunk {
  /** Safe (possibly clamped) sparks in this batch. */
  sparks: Vector3[];
  /** 1-based number of this chunk within the stream. */
  chunkIndex: number;
  /** Absolute line numbers (0-based) of sparks that were modified. */
  clampedIndices: number[];
  /** Absolute line numbers (0-based) of sparks that were dropped. */
  skippedIndices: number[];
  /** Full MTSV report for this chunk. */
  validation: ValidationReport;
}

/** Cumulative statistics emitted by `streamWithStats`. */
export interface StreamStats {
  totalLines:      number;
  totalSparks:     number;
  totalChunks:     number;
  totalViolations: number;
  totalClamped:    number;
  totalSkipped:    number;
  elapsedMs:       number;
}

// ── GCodeStuffer ──────────────────────────────────────────────────────────────

export class GCodeStuffer {
  private readonly _mtsv: MTSV;

  /**
   * @param mtsv  Optional pre-constructed MTSV instance.  If omitted, a new
   *              pool is created using `hardwareConcurrency` workers.
   */
  constructor(mtsv?: MTSV) {
    this._mtsv = mtsv ?? new MTSV();
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Core streaming interface.
   *
   * Reads `lines` lazily, parses each G-Code line into a Vector3 spark using
   * `GCodeInterpreter`, accumulates up to `bufferSize` sparks, dispatches them
   * to MTSV for parallel AABB validation, then yields a `StreamChunk`.
   *
   * The generator automatically handles the final partial buffer after the
   * last line so no sparks are ever silently discarded.
   *
   * @param lines  G-Code source lines (array, generator, or any iterable).
   * @param cage   Work-envelope AABB.  Every spark is checked against this.
   * @param opts   Streaming options (buffer size, violation policy, …).
   */
  async *streamGCode(
    lines: Iterable<string>,
    cage: AABB,
    opts: StufferOptions = {},
  ): AsyncGenerator<StreamChunk> {
    const {
      bufferSize   = 5_000,
      onViolation  = 'throw',
      motionOnly   = true,
    } = opts;

    const interpreter = new GCodeInterpreter(cage, 'warn', 16);
    let batch: Vector3[]   = [];
    let absoluteOffset = 0;   // running count of sparks emitted so far
    let chunkIndex     = 0;
    let lineNumber     = 0;

    for (const line of lines) {
      lineNumber++;
      const before = interpreter.getMoves().length;
      interpreter.parseLine(line);
      const after = interpreter.getMoves().length;

      // Extract any new spark(s) produced by this line
      const newMoves = interpreter.getMoves().slice(before, after);
      for (const move of newMoves) {
        if (motionOnly && move.arcPoints.length === 0) {
          batch.push(move.position);
        } else if (move.arcPoints.length > 0) {
          batch.push(...move.arcPoints);
        } else if (!motionOnly) {
          batch.push(move.position);
        }
      }

      if (batch.length >= bufferSize) {
        const chunk = await this._validateAndBuild(
          batch, cage, onViolation, chunkIndex++, absoluteOffset,
        );
        absoluteOffset += chunk.sparks.length;
        batch = [];
        yield chunk;
      }
    }

    // Flush the final partial buffer
    if (batch.length > 0) {
      yield await this._validateAndBuild(
        batch, cage, onViolation, chunkIndex, absoluteOffset,
      );
    }
  }

  /**
   * Like `streamGCode` but also tracks cumulative statistics.
   * Yields `{ chunk, stats }` pairs so the consumer can display a live
   * progress dashboard (Canvitar HUD, terminal progress bar, etc.).
   */
  async *streamWithStats(
    lines: Iterable<string>,
    cage: AABB,
    opts: StufferOptions = {},
  ): AsyncGenerator<{ chunk: StreamChunk; stats: StreamStats }> {
    const t0 = performance.now();
    const stats: StreamStats = {
      totalLines: 0, totalSparks: 0, totalChunks: 0,
      totalViolations: 0, totalClamped: 0, totalSkipped: 0, elapsedMs: 0,
    };

    for (const line of lines) stats.totalLines++;

    // Re-iterate (requires array input for two-pass; accept that trade-off
    // for the stats variant, or users can pass a pre-collected array).
    const linesArr = Array.isArray(lines) ? lines : [...lines];
    stats.totalLines = linesArr.length;

    for await (const chunk of this.streamGCode(linesArr, cage, opts)) {
      stats.totalSparks     += chunk.sparks.length;
      stats.totalChunks     += 1;
      stats.totalViolations += chunk.validation.violations.length;
      stats.totalClamped    += chunk.clampedIndices.length;
      stats.totalSkipped    += chunk.skippedIndices.length;
      stats.elapsedMs        = performance.now() - t0;
      yield { chunk, stats: { ...stats } };
    }
  }

  /**
   * Terminate the MTSV worker pool.  Call when streaming is complete and
   * the GCodeStuffer will no longer be used.
   */
  terminate(): void {
    this._mtsv.terminate();
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Run MTSV validation on `batch`, apply the violation policy, and assemble
   * a `StreamChunk`.
   */
  private async _validateAndBuild(
    batch: Vector3[],
    cage: AABB,
    policy: ViolationPolicy,
    chunkIndex: number,
    absoluteOffset: number,
  ): Promise<StreamChunk> {
    const validation = await this._mtsv.validateWithDetail(batch, cage);
    const violationSet = new Set(validation.violations);

    const clampedIndices: number[] = [];
    const skippedIndices: number[] = [];
    let safeSparks: Vector3[];

    if (validation.valid || policy === 'warn') {
      safeSparks = batch;
      if (!validation.valid) {
        console.warn(
          `[GCodeStuffer] chunk ${chunkIndex}: ` +
          `${validation.violations.length} violation(s) passed through (policy=warn).`,
        );
      }
    } else if (policy === 'throw') {
      const sample = validation.violations.slice(0, 3).join(', ');
      throw new Error(
        `[GCodeStuffer] Safety breach in chunk ${chunkIndex}: ` +
        `${validation.violations.length} out-of-bounds spark(s). ` +
        `First indices: ${sample}. Emergency stop.`,
      );
    } else if (policy === 'clamp') {
      safeSparks = batch.map((spark, localIdx) => {
        const absIdx = absoluteOffset + localIdx;
        if (violationSet.has(absIdx)) {
          clampedIndices.push(absIdx);
          return cage.clampPoint(spark);
        }
        return spark;
      });
    } else {
      // 'skip' — drop violating sparks entirely
      safeSparks = batch.filter((_, localIdx) => {
        const absIdx = absoluteOffset + localIdx;
        if (violationSet.has(absIdx)) {
          skippedIndices.push(absIdx);
          return false;
        }
        return true;
      });
    }

    return {
      sparks:         safeSparks,
      chunkIndex,
      clampedIndices,
      skippedIndices,
      validation,
    };
  }
}
