/**
 * Machinist Mario Engine — MTSV Worker
 *
 * Runs in a background Web Worker thread.  Receives a batch of plain-object
 * spark coordinates and an AABB cage, reconstructs typed instances, and posts
 * back the indices of any out-of-bounds sparks.
 *
 * Communication protocol
 * ──────────────────────
 * Incoming MessageEvent.data — MTSVWorkerRequest:
 *   {
 *     batchId:  number          — monotonic ID so the manager can match replies
 *     sparks:   {x,y,z}[]      — serialised Vector3 coordinates
 *     cageMin:  {x,y,z}        — AABB minimum corner
 *     cageMax:  {x,y,z}        — AABB maximum corner
 *     startIndex: number       — offset of this batch within the full path
 *   }
 *
 * Outgoing postMessage — MTSVWorkerResponse:
 *   {
 *     batchId:    number       — echoed from the request
 *     violations: number[]     — absolute spark indices (startIndex + local i)
 *     processed:  number       — total sparks examined in this batch
 *     durationMs: number       — wall-clock time for this batch (ms)
 *   }
 *
 * This file is compiled as a separate entry point from the main bundle so
 * that `new Worker(new URL('./mtsv.worker.ts', import.meta.url))` resolves
 * correctly with bundlers that support module workers (Vite, Webpack 5, esbuild).
 */

// ── Type declarations for the worker global scope ─────────────────────────────
// (TypeScript's lib.webworker.d.ts is enabled via tsconfig `lib` when targeting
//  a worker, but we write the minimal shapes here to stay compatible with the
//  current project tsconfig that targets a mixed browser/worker environment.)

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

// ── Inline AABB contains — avoids importing a module file from a worker ───────
// Workers compiled as classic scripts cannot use ES-module imports in all
// environments.  We reproduce the scalar check directly so the worker has
// zero external dependencies and can be used as a classic or module worker.
function contains(
  cageMin: Vec3Plain,
  cageMax: Vec3Plain,
  x: number, y: number, z: number,
): boolean {
  return (
    x >= cageMin.x && x <= cageMax.x &&
    y >= cageMin.y && y <= cageMax.y &&
    z >= cageMin.z && z <= cageMax.z
  );
}

// ── Message handler ───────────────────────────────────────────────────────────

self.onmessage = (e: MessageEvent<MTSVWorkerRequest>): void => {
  const { batchId, sparks, cageMin, cageMax, startIndex } = e.data;
  const t0 = performance.now();

  const violations: number[] = [];

  for (let i = 0; i < sparks.length; i++) {
    const { x, y, z } = sparks[i];
    if (!contains(cageMin, cageMax, x, y, z)) {
      violations.push(startIndex + i);   // absolute index in the full path
    }
  }

  const response: MTSVWorkerResponse = {
    batchId,
    violations,
    processed:  sparks.length,
    durationMs: performance.now() - t0,
  };

  // postMessage is always available in worker scope as a global
  postMessage(response);
};
