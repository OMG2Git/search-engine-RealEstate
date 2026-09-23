import os from "os";
import path from "path";
import crypto from "crypto";
import { Worker } from "worker_threads";

// Persistent pool of PDF-rendering worker threads. Replaces the old
// in-process rendering (which ran on Node's single main thread and became
// the real bottleneck under concurrency — confirmed by testing: 16
// concurrent files took 60.8s with in-process rendering vs 9.9s once
// rendering was removed from the timed path). This pool gives each
// concurrent file's rendering its own OS thread instead.
//
// Only used by the OpenRouter path (lib/summaryProvider.ts). The
// direct-Gemini path is untouched — it sends whole PDFs/images to Gemini
// directly and never rasterizes anything itself, so there's nothing there
// this bottleneck could have affected.
//
// Hardened against messy real-world files (a 15+ year archive will contain
// corrupted PDFs, pathological page structures, and other edge cases no
// small test sample can fully anticipate):
//  - Every render job has a hard timeout. A hung job (e.g. a malformed PDF
//    that sends pdfjs-dist into an infinite loop) is killed rather than
//    left to block a worker forever.
//  - A worker that errors, exits unexpectedly, or times out is terminated
//    and replaced with a fresh one — the pool self-heals instead of slowly
//    losing capacity over a multi-day, 450,000-file run.
//  - A poisoned job never blocks the queue — its promise always settles
//    (resolve or reject), so callers (syncEngine's per-file try/catch)
//    always get a clean answer instead of hanging indefinitely.

const SYNC_CONCURRENCY = 16;
const DEFAULT_POOL_SIZE = Math.max(2, Math.min(SYNC_CONCURRENCY, os.cpus().length - 1));
const POOL_SIZE = Number(process.env.RENDER_POOL_SIZE) || DEFAULT_POOL_SIZE;
const WORKER_PATH = path.join(process.cwd(), "workers", "pdfRenderWorker.mjs");

// Was 90s on the assumption a 40-page render "should finish in seconds" —
// real overnight data disproved that: 33 real failures tonight were
// "Rendering timed out", and 28 of those were completely normal-sized
// files (3-11MB, not the huge/corrupted ones the timeout was meant to
// catch). Under real load — 16 files summarizing concurrently, each
// competing for the render pool's limited worker threads/CPU cores — wall
// clock time for a real multi-page scanned chunk is genuinely often over
// 90s without anything being wrong with the file. Raised to give real
// files enough room; a truly pathological file still gets cut loose
// eventually rather than hanging forever.
const RENDER_TIMEOUT_MS = 180_000;

interface RenderResult {
  totalPages: number;
  pagesSent: number;
  pages: Buffer[];
}

interface PendingJob {
  resolve: (result: RenderResult) => void;
  reject: (err: Error) => void;
  timeoutHandle: NodeJS.Timeout;
}

interface QueuedJob {
  id: string;
  filePath: string;
  startPage: number;
  endPage: number;
  maxImageBytes: number;
}

interface PoolWorker {
  worker: Worker;
  busy: boolean;
  currentJobId: string | null;
}

let pool: PoolWorker[] | null = null;
const pending = new Map<string, PendingJob>();
const queue: QueuedJob[] = [];

function settleJob(id: string, err: Error | null, result?: RenderResult): void {
  const job = pending.get(id);
  if (!job) return; // already settled (e.g. timeout fired, then a late message arrived) — ignore
  pending.delete(id);
  clearTimeout(job.timeoutHandle);
  if (err) job.reject(err);
  else job.resolve(result!);
}

function spawnWorker(): PoolWorker {
  const worker = new Worker(WORKER_PATH);
  const entry: PoolWorker = { worker, busy: false, currentJobId: null };

  worker.on(
    "message",
    (msg: { id: string; ok: boolean; filePath?: string; totalPages?: number; pagesSent?: number; buffers?: ArrayBuffer[]; warnings?: string[]; error?: string }) => {
      if (msg.ok) {
        // pdfjs warnings (missing cMap/wasm/font data for a specific
        // embedded font, etc.) don't fail the render — the page "succeeds"
        // with that content silently missing. Logging them here, tagged
        // with the actual file, is what makes an affected file findable
        // later: `grep "rendering warnings for" logs/<date>.log`.
        if (msg.warnings && msg.warnings.length > 0) {
          console.error(`[renderPool] rendering warnings for "${msg.filePath}": ${msg.warnings.join(" | ")}`);
        }
        settleJob(msg.id, null, {
          totalPages: msg.totalPages!,
          pagesSent: msg.pagesSent!,
          pages: (msg.buffers ?? []).map((b) => Buffer.from(b)),
        });
      } else {
        settleJob(msg.id, new Error(msg.error));
      }
      entry.busy = false;
      entry.currentJobId = null;
      dispatchNext();
    }
  );

  worker.on("error", (err) => {
    console.error("[renderPool] worker error, replacing it:", err);
    replaceWorker(entry, new Error(`Render worker crashed: ${err.message}`));
  });

  worker.on("exit", (code) => {
    if (code !== 0) {
      console.error(`[renderPool] worker exited unexpectedly (code ${code}), replacing it`);
      replaceWorker(entry, new Error(`Render worker exited unexpectedly (code ${code})`));
    }
  });

  return entry;
}

// A worker that crashed, exited, or hung is presumed dead — it's swapped
// out for a fresh one in place, and whichever job it was holding (if any)
// is failed cleanly rather than left to hang forever.
function replaceWorker(entry: PoolWorker, jobError: Error): void {
  if (!pool) return;
  const idx = pool.indexOf(entry);
  if (idx === -1) return; // already replaced (e.g. both 'error' and 'exit' fired)

  if (entry.currentJobId) {
    settleJob(entry.currentJobId, jobError);
  }
  try {
    entry.worker.terminate();
  } catch {
    // already dead — nothing to do
  }

  pool[idx] = spawnWorker();
  dispatchNext();
}

function getPool(): PoolWorker[] {
  if (pool) return pool;
  pool = Array.from({ length: POOL_SIZE }, () => spawnWorker());
  return pool;
}

function dispatchNext(): void {
  if (queue.length === 0) return;
  const idle = getPool().find((w) => !w.busy);
  if (!idle) return;
  const job = queue.shift()!;
  idle.busy = true;
  idle.currentJobId = job.id;
  idle.worker.postMessage(job);

  // If this specific job doesn't settle in time, treat its worker as hung
  // and replace it — this is what actually prevents one bad file from
  // slowly eating the pool's capacity over a long run.
  const pendingJob = pending.get(job.id);
  if (pendingJob) {
    pendingJob.timeoutHandle = setTimeout(() => {
      if (pending.has(job.id)) {
        console.error(`[renderPool] job timed out after ${RENDER_TIMEOUT_MS}ms (${job.filePath}), replacing its worker`);
        replaceWorker(idle, new Error(`Rendering timed out after ${RENDER_TIMEOUT_MS}ms`));
      }
    }, RENDER_TIMEOUT_MS);
  }
}

// Renders pages [startPage, endPage] (1-indexed, inclusive) of filePath.
// Large documents are chunked into multiple calls like this (see
// summariseViaOpenRouterInner in lib/summaryProvider.ts) so every page
// actually gets seen instead of silently truncating to the opening pages.
export function renderPdfPagesInWorker(
  filePath: string,
  startPage: number,
  endPage: number,
  maxImageBytes: number
): Promise<RenderResult> {
  getPool(); // ensure workers exist before queuing
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    // Placeholder timeout handle — dispatchNext() sets the real one once
    // this job is actually assigned to a worker (queueing time shouldn't
    // count against the render timeout).
    pending.set(id, { resolve, reject, timeoutHandle: setTimeout(() => {}, 0) });
    queue.push({ id, filePath, startPage, endPage, maxImageBytes });
    dispatchNext();
  });
}
