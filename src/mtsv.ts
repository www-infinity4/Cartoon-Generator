/**
 * Machinist Mario Engine — MTSV (Multi-Threaded Spark Validator)
 *
 * Parallelises AABB safety checks across a pool of Web Workers — one per CPU
 * core — so that validating 500,000+ Vector3 sparks never stalls the UI thread.
 *
 * Architecture
 * ────────────
 *                     ┌──── Worker 0 ──── chunk 0 ────┐
 *   Main Thread       │                               │  violations[]
 *   planPath()  ──▶  MTSV  ──── Worker 1 ──── chunk 1 ┤  ──▶  merged
 *                     │                               │
 *                     └──── Worker N ──── chunk N ────┘
 *
 * Each worker receives a plain-object serialised batch of sparks (no SharedArrayBuffer
 * needed) and returns the absolute indices of any out-of-bounds sparks.
 * The manager re-offsets chunk-local indices back to the full-path positions.
 *
 * Usage
 * ─────
 *   const mtsv = new MTSV();
 *
 *   // Simple boolean check
 *   const safe = await mtsv.validateLargePath(sparks, printerBed);
 *
 *   // Detailed report
 *   const report = await mtsv.validateWithDetail(sparks, printerBed);
 *   console.log(report.violations);   // absolute indices of bad sparks
 *   console.log(report.durationMs);   // wall-clock time across all workers
 *
 *   mtsv.terminate();  // release workers when done
 */
import { Vector3 } from './vector3';
import { AABB } from './aabb';

// ── Shared protocol types (must match mtsv.worker.ts) ────────────────────────

interface Vec3Plain { x: number; y: number; z: number; }

interface MTSVWorkerRequest {
  batchId:    number;
  sparks:     Vec3Plain[];
  cageMin:    Vec3Plain;
  cageMax:    Vec3Plain;
  startIndex: number;
}

interface MTSVWorkerResponse {
  batchId:    number;
  violations: number[];
  processed:  number;
  durationMs: number;
}

// ── Validation result ─────────────────────────────────────────────────────────

/** Full diagnostic returned by `validateWithDetail`. */
export interface ValidationReport {
  /** Whether every spark passed the safety check. */
  valid: boolean;
  /**
   * Absolute indices (within the original `sparks` array) of every spark
   * that fell outside the AABB cage.
   */
  violations: number[];
  /** Total sparks examined. */
  processed: number;
  /** Wall-clock time from first dispatch to last worker reply (ms). */
  durationMs: number;
  /** Per-worker timing breakdown for profiling. */
  workerTimes: number[];
}

// ── MTSV manager ──────────────────────────────────────────────────────────────

export class MTSV {
  /** Number of worker threads in the pool. */
  readonly numWorkers: number;

  private readonly _workers: Worker[];
  private _nextBatchId = 0;

  /**
   * @param workerCount  Number of workers to spawn.  Defaults to
   *                     `navigator.hardwareConcurrency` (falls back to 4).
   */
  constructor(workerCount?: number) {
    this.numWorkers = workerCount
      ?? (typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency || 4) : 4);

    this._workers = Array.from({ length: this.numWorkers }, () =>
      new Worker(new URL('./mtsv.worker.ts', import.meta.url), { type: 'module' }),
    );
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Validate a large toolpath against an AABB safety cage.
   *
   * Splits `sparks` into equal chunks and dispatches one chunk per worker.
   * Resolves `true` only when every spark is inside `cage`.
   *
   * @param sparks  Full Vector3 toolpath (may be hundreds of thousands of points).
   * @param cage    Work-envelope AABB; sparks outside this box are violations.
   */
  async validateLargePath(sparks: Vector3[], cage: AABB): Promise<boolean> {
    const report = await this.validateWithDetail(sparks, cage);
    return report.valid;
  }

  /**
   * Like `validateLargePath` but returns a full `ValidationReport` including
   * violation indices, timing, and per-worker profiling data.
   */
  async validateWithDetail(sparks: Vector3[], cage: AABB): Promise<ValidationReport> {
    if (sparks.length === 0) {
      return { valid: true, violations: [], processed: 0, durationMs: 0, workerTimes: [] };
    }

    const t0 = performance.now();

    const chunkSize = Math.ceil(sparks.length / this.numWorkers);
    const cageMin: Vec3Plain = { x: cage.min.x, y: cage.min.y, z: cage.min.z };
    const cageMax: Vec3Plain = { x: cage.max.x, y: cage.max.y, z: cage.max.z };

    const promises = this._workers.map((worker, workerIdx) => {
      const start = workerIdx * chunkSize;
      const slice = sparks.slice(start, start + chunkSize);
      if (slice.length === 0) {
        return Promise.resolve<MTSVWorkerResponse>({
          batchId: -1, violations: [], processed: 0, durationMs: 0,
        });
      }

      const batchId = this._nextBatchId++;

      // Serialise to plain objects (structured clone — no SharedArrayBuffer needed)
      const plainSparks: Vec3Plain[] = slice.map(v => ({ x: v.x, y: v.y, z: v.z }));

      const request: MTSVWorkerRequest = {
        batchId,
        sparks:     plainSparks,
        cageMin,
        cageMax,
        startIndex: start,
      };

      return new Promise<MTSVWorkerResponse>((resolve, reject) => {
        // Assign a one-shot handler so concurrent batches don't cross-wire
        const onMsg = (e: MessageEvent<MTSVWorkerResponse>) => {
          if (e.data.batchId !== batchId) return; // not our reply
          worker.removeEventListener('message', onMsg);
          worker.removeEventListener('error', onErr);
          resolve(e.data);
        };
        const onErr = (e: ErrorEvent) => {
          worker.removeEventListener('message', onMsg);
          worker.removeEventListener('error', onErr);
          reject(new Error(`MTSV worker ${workerIdx} error: ${e.message}`));
        };
        worker.addEventListener('message', onMsg);
        worker.addEventListener('error', onErr);
        worker.postMessage(request);
      });
    });

    const results = await Promise.all(promises);

    const violations = results.flatMap(r => r.violations).sort((a, b) => a - b);
    const processed  = results.reduce((sum, r) => sum + r.processed, 0);
    const workerTimes = results.map(r => r.durationMs);

    return {
      valid:       violations.length === 0,
      violations,
      processed,
      durationMs:  performance.now() - t0,
      workerTimes,
    };
  }

  /**
   * Terminate all workers and release their threads.
   * The MTSV instance cannot be used after calling this.
   */
  terminate(): void {
    for (const w of this._workers) w.terminate();
  }
}
