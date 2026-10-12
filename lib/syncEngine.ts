import path from "path";
import pLimit from "p-limit";
import { FieldValue } from "@google-cloud/firestore";
import { filesCollection } from "@/lib/firestore";
import { getMapping, getPoolDir, listPoolFiles } from "@/lib/pool";
import { summariseFile, tokenise } from "@/lib/gemini";
import { fileTypeForSchema, pathTokens } from "@/lib/fileMeta";
import {
  startSync,
  incrementSyncProgress,
  finishSync,
  claimSyncRun,
  isStopRequested,
  requestStop,
  addRecentSyncItem,
} from "@/lib/syncState";
import { refreshNameIndex } from "@/lib/nameIndex";
import { importRecords, deleteRecord } from "@/lib/vertexSearch";

// Tested live against the real Gemini key: 0 failures at up to 100 concurrent
// requests (connection/RPM level). That test used short text-only prompts
// though — real files (especially inline PDFs/images) use far more tokens
// per call, and token-per-minute quotas are a separate ceiling this doesn't
// prove is clear. 16 is a large, evidence-backed jump from the original 4
// without betting the whole run on an untested-at-scale number.
//
// Not every deployment's internet connection can sustain this, though — a
// weaker/shared office link can start timing out every outbound call once
// ~16 run at once, even though a single request succeeds instantly (seen
// live on Mantri's site: ConnectTimeoutError on every Gemini/Vertex call
// under real concurrent load, zero failures on an isolated one-off fetch to
// the same host). SYNC_CONCURRENCY lets a site override this down without a
// code change when that happens.
const CONCURRENCY = Number(process.env.SYNC_CONCURRENCY) || 16;
// Safety ceiling per Sync Now press — protects against accidentally kicking off
// an enormous run in one go. The route is fire-and-forget (POST /api/sync does
// not await this), so a single press safely runs this many files to
// completion entirely server-side, regardless of whether a browser stays
// connected. Raised from 2000 to 20000 — still well short of the ~450k
// target total, so a full run needs roughly 23 presses (or auto-retriggers)
// rather than one, unlike the crawl side which covers everything in one go.
const BATCH_CAP = 20_000;

async function getExistingDocIds(): Promise<Set<string>> {
  const refs = await filesCollection.listDocuments();
  return new Set(refs.map((r) => r.id));
}

async function getFailedDocIds(): Promise<Set<string>> {
  const snap = await filesCollection.where("status", "==", "failed").get();
  return new Set(snap.docs.map((d) => d.id));
}

// Returns true if the file was actually attempted, false if skipped because
// a stop was requested before it got its turn — the caller uses this to
// count how many queued-but-unstarted files need to go back into "remaining"
// rather than being counted as done.
async function processFile(poolName: string): Promise<boolean> {
  if (isStopRequested()) return false;

  const mapping = getMapping();
  const record = mapping[poolName];
  const filePath = path.join(getPoolDir(), poolName);

  if (!record) {
    // A pool file with no mapping entry means a prior crawl run copied the
    // file but crashed before its mapping entry was saved — re-running
    // "Sync New Files" re-copies it (deterministic pool naming) and fills
    // in the missing entry. Surface this loudly instead of silently
    // counting it as an unexplained failure.
    console.error(`[sync] no mapping entry for pool file "${poolName}" — re-run Sync New Files to repair it`);
    addRecentSyncItem({
      name: poolName,
      status: "failed",
      sizeBytes: 0,
      at: new Date().toISOString(),
    });
    incrementSyncProgress(false, 0);
    return true;
  }

  try {
    const { summary, keywords: geminiKeywords } = await summariseFile(
      filePath,
      record.original_name,
      record.original_path
    );

    // Gemini often returns multi-word phrases ("gosavi om prakash", "real
    // estate") rather than single tokens. Firestore's array-contains-any
    // only matches whole array elements, so a search for just "gosavi"
    // would never match the phrase. Keep the phrases (useful to read) but
    // also expand each into its individual words so single-word queries
    // still hit.
    const geminiKeywordTokens = geminiKeywords.flatMap((k) => tokenise(k));

    const keywords = [
      ...new Set([
        ...geminiKeywords,
        ...geminiKeywordTokens,
        ...tokenise(record.original_name),
        ...pathTokens(record.original_path),
      ]),
    ];

    // Written as "done" as soon as the summary exists, before the Vertex
    // import below is even attempted — vertex_indexed starts false and only
    // flips to true once that import actually succeeds. This means a Vertex
    // failure below can never destroy this summary: the worst case is a doc
    // that's searchable by name/keyword but not yet by content, not a doc
    // that has to be re-summarized (see the catch block's comment).
    await filesCollection.doc(poolName).set({
      pool_name: poolName,
      original_name: record.original_name,
      name_lower: record.original_name.toLowerCase(),
      original_path: record.original_path,
      path_tokens: pathTokens(record.original_path),
      file_type: fileTypeForSchema(record.original_name),
      size_bytes: record.size_bytes,
      summary,
      keywords,
      status: "done",
      vertex_indexed: false,
      processed_at: FieldValue.serverTimestamp(),
    });

    // Content/semantic search runs on Vertex AI Search, not Firestore — feed
    // the same summary there too, keeping both stores in sync on every file.
    // Caught separately from summarization errors (see the outer catch
    // below): a Vertex-side rate limit is common under sustained concurrent
    // load and must not discard the summary just written above.
    // reindexPendingVertexDocs() retries exactly this case cheaply, without
    // re-summarizing, at the start of every future sync run.
    try {
      await importRecords([
        {
          pool_name: poolName,
          original_name: record.original_name,
          original_path: record.original_path,
          file_type: fileTypeForSchema(record.original_name),
          size_bytes: record.size_bytes,
          summary,
          keywords,
        },
      ]);
      await filesCollection.doc(poolName).update({ vertex_indexed: true });
    } catch (vertexErr) {
      console.error(
        `[sync] summarized "${poolName}" but Vertex AI Search import failed — will retry the import only (no re-summarizing) on the next sync run:`,
        vertexErr
      );
    }

    addRecentSyncItem({
      name: poolName,
      status: "done",
      sizeBytes: record.size_bytes,
      at: new Date().toISOString(),
    });
    incrementSyncProgress(true, record.size_bytes);
    return true;
  } catch (err) {
    const status = (err as { status?: number })?.status;
    if (status === 402) {
      // OpenRouter's spending-limit-reached error. Not a problem with this
      // particular file — every other in-flight/queued file in this batch
      // will fail the exact same way, so continuing would just mark a
      // potentially large batch of perfectly fine files "failed" for no
      // real reason. Stop the whole run instead (same mechanism as the
      // Stop button) and leave this file, and everything still queued,
      // unprocessed — a plain Sync Now naturally retries all of them once
      // the limit is raised or credit is added, no separate "retry failed"
      // step needed. Deliberately no Firestore write here for that reason.
      console.error(
        `[sync] OpenRouter spending limit reached while processing "${poolName}" — stopping the sync run. ` +
          `Raise the key's limit or add credit, then press Sync Now again to pick up where this left off.`
      );
      requestStop();
      addRecentSyncItem({
        name: poolName,
        status: "failed",
        sizeBytes: record.size_bytes,
        at: new Date().toISOString(),
      });
      incrementSyncProgress(false, 0);
      return false;
    }

    console.error(`[sync] failed to process "${poolName}":`, err);
    await filesCollection.doc(poolName).set({
      pool_name: poolName,
      original_name: record.original_name,
      name_lower: record.original_name.toLowerCase(),
      original_path: record.original_path,
      path_tokens: pathTokens(record.original_path),
      file_type: fileTypeForSchema(record.original_name),
      size_bytes: record.size_bytes,
      status: "failed",
      error: String((err as Error)?.message ?? err),
      processed_at: FieldValue.serverTimestamp(),
    });
    // Remove any stale Vertex AI Search entry from a previous successful run
    // (e.g. a retryFailed re-attempt that failed this time) so content
    // search never points at a file marked failed.
    await deleteRecord(poolName).catch(() => {});
    addRecentSyncItem({
      name: poolName,
      status: "failed",
      sizeBytes: record.size_bytes,
      at: new Date().toISOString(),
    });
    incrementSyncProgress(false, 0);
    return true;
  }
}

interface PendingVertexDoc {
  id: string;
  original_name: string;
  original_path: string;
  file_type: string;
  size_bytes: number;
  summary: string;
  keywords: string[];
}

async function getPendingVertexIndexDocs(): Promise<PendingVertexDoc[]> {
  const snap = await filesCollection.where("vertex_indexed", "==", false).get();
  return snap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      original_name: data.original_name,
      original_path: data.original_path,
      file_type: data.file_type,
      size_bytes: data.size_bytes,
      summary: data.summary,
      keywords: (data.keywords as string[]) || [],
    };
  });
}

// Vertex AI Search's inlineSource import caps out at 100 documents per
// request (confirmed against the real API — a prior attempt at 500 was
// rejected outright with "At most 100 values are allowed"). Sending a bigger
// backlog in one call would fail every single sync run, and the backlog
// would never shrink. Chunking keeps this working no matter how large the
// backlog gets.
const REINDEX_CHUNK_SIZE = 100;

// Catches up every file whose summary was saved successfully but whose
// Vertex AI Search import failed (almost always the 100-requests/minute
// rate limit under sustained concurrent sync load). Cheap and fast — it
// only re-sends already-generated text to Vertex, no rendering or
// Gemini/OpenRouter calls — so it's safe to run before every sync batch
// without meaningfully slowing it down.
async function reindexPendingVertexDocs(): Promise<void> {
  const pending = await getPendingVertexIndexDocs();
  if (pending.length === 0) return;

  console.log(`[sync] retrying Vertex AI Search import for ${pending.length} already-summarized file(s)`);
  for (let i = 0; i < pending.length; i += REINDEX_CHUNK_SIZE) {
    const chunk = pending.slice(i, i + REINDEX_CHUNK_SIZE);
    try {
      await importRecords(
        chunk.map((doc) => ({
          pool_name: doc.id,
          original_name: doc.original_name,
          original_path: doc.original_path,
          file_type: doc.file_type,
          size_bytes: doc.size_bytes,
          summary: doc.summary,
          keywords: doc.keywords,
        }))
      );
      await Promise.all(chunk.map((doc) => filesCollection.doc(doc.id).update({ vertex_indexed: true })));
    } catch (err) {
      console.error(`[sync] retry of a ${chunk.length}-file Vertex AI Search import batch still failing — will retry again next sync run:`, err);
    }
  }
}

export interface SyncPlan {
  toProcess: string[];
  remainingAfterThisRun: number;
}

export async function planSync(retryFailed: boolean): Promise<SyncPlan> {
  const poolFiles = listPoolFiles();
  const existingIds = await getExistingDocIds();
  const failedIds = retryFailed ? await getFailedDocIds() : new Set<string>();

  const unprocessed = poolFiles.filter((name) => !existingIds.has(name) || failedIds.has(name));
  const toProcess = unprocessed.slice(0, BATCH_CAP);

  return { toProcess, remainingAfterThisRun: unprocessed.length - toProcess.length };
}

// Runs in the background — the caller does not await this. Progress is
// tracked in lib/syncState.ts and read via /api/sync/status polling, so a
// large sync never has to hold an HTTP request open (which risks hitting
// Node's default request timeout on big batches).
//
// Stop mid-run: a stop request makes every not-yet-started file bail out
// immediately (near-instant), while files already mid-Gemini-call finish
// naturally rather than being cut off. Nothing skipped this way is written
// to Firestore, so it's picked back up automatically as "unprocessed" the
// next time Sync Now runs — no separate resume bookkeeping needed.
export async function runSyncInBackground(retryFailed: boolean): Promise<void> {
  // Claiming the run must happen synchronously, before any await — see
  // claimSyncRun()'s comment in lib/syncState.ts for why a separate
  // isSyncRunning() check here was a real, confirmed race.
  if (!claimSyncRun()) return;

  await reindexPendingVertexDocs();

  const { toProcess, remainingAfterThisRun } = await planSync(retryFailed);
  startSync(toProcess.length);

  const limit = pLimit(CONCURRENCY);
  const results = await Promise.all(toProcess.map((name) => limit(() => processFile(name))));
  const skippedByStop = results.filter((attempted) => !attempted).length;

  finishSync(remainingAfterThisRun + skippedByStop);
  await refreshNameIndex();
}
