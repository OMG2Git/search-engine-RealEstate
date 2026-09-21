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
  isSyncRunning,
  isStopRequested,
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
const CONCURRENCY = 16;
// Safety ceiling per Sync Now press — protects against accidentally kicking off
// an enormous run in one go. Non-blocking now, so this can be generous; press
// Sync Now again for the rest if a backlog is bigger than this.
const BATCH_CAP = 2000;

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
      processed_at: FieldValue.serverTimestamp(),
    });

    // Content/semantic search runs on Vertex AI Search, not Firestore — feed
    // the same summary there too, keeping both stores in sync on every file.
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

    addRecentSyncItem({
      name: poolName,
      status: "done",
      sizeBytes: record.size_bytes,
      at: new Date().toISOString(),
    });
    incrementSyncProgress(true, record.size_bytes);
    return true;
  } catch (err) {
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
  if (isSyncRunning()) return;

  const { toProcess, remainingAfterThisRun } = await planSync(retryFailed);
  startSync(toProcess.length);

  const limit = pLimit(CONCURRENCY);
  const results = await Promise.all(toProcess.map((name) => limit(() => processFile(name))));
  const skippedByStop = results.filter((attempted) => !attempted).length;

  finishSync(remainingAfterThisRun + skippedByStop);
  await refreshNameIndex();
}
