import crypto from "crypto";
import { GoogleAuth } from "google-auth-library";

// Vertex AI Search caps a single datastore at 200,000 documents (a hard,
// per-project quota — confirmed live when Nyati's original datastore hit it
// exactly). At Nyati's volume that ceiling gets hit well before the real
// document count does, so a second datastore in a second GCP project
// ("shard 2") takes new documents once the first is full. Firestore stays a
// single shared collection throughout — sharding only applies to Vertex.
//
// A deployment that only ever needs one shard (e.g. Mantri, far below the
// 200k ceiling) simply never sets the "_2" env vars below, and every shard-2
// code path here becomes a no-op automatically. This file must keep working
// unchanged for a single-shard deployment without any of its own config
// changing.
interface ShardConfig {
  id: number;
  project: string;
  location: string;
  datastoreId: string;
  engineId: string;
  base: string;
  auth: GoogleAuth;
}

// Shard 1 is always built, even with missing/empty env vars (matching the
// original single-shard code's behavior: it never threw at module load,
// just silently built broken URLs that would fail at the actual API call —
// needed so `next build`'s static route analysis doesn't crash in any
// environment without full secrets configured, e.g. a fresh checkout before
// .env.local exists, or this repo's own CI). Shard 2 stays genuinely
// optional (null) since most deployments never need it.
function buildShard(id: number, envSuffix: string, required: boolean): ShardConfig | null {
  const project = process.env[`VERTEX_SEARCH_PROJECT${envSuffix}`] || "";
  const datastoreId = process.env[`VERTEX_SEARCH_DATASTORE_ID${envSuffix}`] || "";
  const engineId = process.env[`VERTEX_SEARCH_ENGINE_ID${envSuffix}`] || "";
  if (!required && (!project || !datastoreId || !engineId)) return null;

  const location = process.env[`VERTEX_SEARCH_LOCATION${envSuffix}`] || "global";
  // Falls back to the unsuffixed credentials var so a single-shard
  // deployment (or a shard 2 that happens to share a service account) never
  // needs to duplicate it.
  const keyFilename = process.env[`GOOGLE_APPLICATION_CREDENTIALS${envSuffix}`] || process.env.GOOGLE_APPLICATION_CREDENTIALS;

  return {
    id,
    project,
    location,
    datastoreId,
    engineId,
    base: `https://discoveryengine.googleapis.com/v1/projects/${project}/locations/${location}/collections/default_collection`,
    auth: new GoogleAuth({ keyFilename, scopes: ["https://www.googleapis.com/auth/cloud-platform"] }),
  };
}

const SHARD_1 = buildShard(1, "", true)!;
const SHARD_2 = buildShard(2, "_2", false);
const SHARDS: ShardConfig[] = SHARD_2 ? [SHARD_1, SHARD_2] : [SHARD_1];

// Which shard new imports go to. Nyati sets this to 2 once shard 1's 200k
// ceiling is reached; a single-shard deployment never sets it and stays on
// shard 1 by default. Falls back to shard 1 if someone points this at a
// shard that isn't actually configured, rather than silently losing writes.
const ACTIVE_WRITE_SHARD: ShardConfig =
  SHARDS.find((s) => s.id === (Number(process.env.VERTEX_ACTIVE_WRITE_SHARD) || 1)) || SHARD_1;

async function authedFetch(shard: ShardConfig, url: string, init: RequestInit): Promise<Response> {
  const client = await shard.auth.getClient();
  const token = await client.getAccessToken();
  return fetch(url, {
    ...init,
    headers: {
      ...(init.headers || {}),
      Authorization: `Bearer ${token.token}`,
      "Content-Type": "application/json",
      "X-Goog-User-Project": shard.project,
    },
  });
}

// Discovery Engine document IDs only allow [a-zA-Z0-9-_] — our pool file
// names have dots, spaces, parentheses. Hash pool_name into a safe stable
// ID instead, and keep pool_name as a regular field for lookups. Shared
// across shards so the same file always maps to the same document ID no
// matter which one it ends up in.
export function vertexDocId(poolName: string): string {
  return crypto.createHash("md5").update(poolName, "utf-8").digest("hex");
}

export interface VertexRecord {
  pool_name: string;
  original_name: string;
  original_path: string;
  file_type: string;
  size_bytes: number;
  summary: string;
  keywords: string[];
}

export interface ImportOutcome {
  shard: number;
}

// Vertex AI Search caps this at 100 document-batch requests per MINUTE per
// project (confirmed from the real 429 response body: quota_limit
// "DocumentBatchRequestsPerMinutePerProject", limit 100). syncEngine runs
// 16 files concurrently, each calling this once — easy to burst past 100/min
// under real load. Genuinely transient (the quota window rolls over every
// minute), but this call previously had zero retry logic: a single 429 threw
// immediately, and since syncEngine writes the Firestore doc as "done" with
// the real summary BEFORE calling this, that failure overwrote it with
// status "failed" — discarding a summary that was already correctly
// generated, and requiring a full (paid) re-summarization through
// OpenRouter/Gemini just to retry what was actually only a rate-limited
// Vertex Search push. Retrying here instead fixes that at the source.
const IMPORT_MAX_ATTEMPTS = 5;
const IMPORT_BASE_BACKOFF_MS = 3000;
const IMPORT_MAX_BACKOFF_MS = 20_000;

export async function importRecords(records: VertexRecord[]): Promise<ImportOutcome> {
  const shard = ACTIVE_WRITE_SHARD;
  if (records.length === 0) return { shard: shard.id };

  const url = `${shard.base}/dataStores/${shard.datastoreId}/branches/0/documents:import`;
  const documents = records.map((r) => ({
    id: vertexDocId(r.pool_name),
    jsonData: JSON.stringify(r),
  }));

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < IMPORT_MAX_ATTEMPTS; attempt++) {
    const res = await authedFetch(shard, url, {
      method: "POST",
      body: JSON.stringify({ inlineSource: { documents } }),
    });
    const text = await res.text();

    if (!res.ok) {
      lastError = new Error(`Vertex AI Search import failed (shard ${shard.id}): ${res.status} ${text}`);
      // 429 (rate limit) and 5xx (transient server-side) are worth retrying;
      // anything else (400 bad request, 401/403 auth, 404 not found) will
      // fail identically every time, so don't waste the attempts.
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt === IMPORT_MAX_ATTEMPTS - 1) throw lastError;
      const backoff = Math.min(IMPORT_BASE_BACKOFF_MS * 2 ** attempt, IMPORT_MAX_BACKOFF_MS);
      const jitter = Math.random() * 1000;
      await new Promise((r) => setTimeout(r, backoff + jitter));
      continue;
    }

    // A 200 OK does NOT mean the documents were actually accepted — confirmed
    // live against a full datastore: Vertex returns "done": true with the
    // real rejection buried in metadata.failureCount / response.errorSamples
    // instead of a non-2xx status. Trusting res.ok alone is how Nyati's
    // datastore silently filled past 200,000 docs while every record kept
    // getting marked vertex_indexed: true. Parse the body on every success
    // response so a full-shard rejection is treated as the real failure it is.
    let body: { metadata?: { failureCount?: string }; response?: { errorSamples?: unknown[] } } = {};
    try {
      body = JSON.parse(text);
    } catch {
      // Empty/unparseable body on a 2xx is unusual but not itself evidence of
      // failure — fall through and treat as success rather than retry forever.
    }
    const failureCount = Number(body?.metadata?.failureCount ?? 0);
    if (failureCount > 0) {
      const samples = body?.response?.errorSamples ? JSON.stringify(body.response.errorSamples).slice(0, 500) : "";
      // Not retryable within this loop: a quota-full rejection won't resolve
      // by immediately retrying the same shard. The caller is responsible for
      // leaving the record un-indexed so a future sync (after the active
      // shard is switched, or the quota issue is resolved) picks it up again.
      throw new Error(`Vertex AI Search import rejected ${failureCount}/${records.length} document(s) (shard ${shard.id}): ${samples}`);
    }
    return { shard: shard.id };
  }
  throw lastError!;
}

// A file that's been re-marked "failed" (e.g. a retry-failed re-attempt that
// failed again) must not leave a stale, stale-but-searchable entry behind on
// ANY shard — without knowing in advance which shard (if any) a given file
// previously landed on, deleting from all configured shards is the only way
// to guarantee this. A delete for a document that was never on a given shard
// is a harmless 404, not an error.
export async function deleteRecord(poolName: string): Promise<void> {
  const id = vertexDocId(poolName);
  await Promise.all(
    SHARDS.map(async (shard) => {
      const url = `${shard.base}/dataStores/${shard.datastoreId}/branches/0/documents/${id}`;
      await authedFetch(shard, url, { method: "DELETE" }).catch(() => {});
    })
  );
}

export interface VertexSearchResult {
  pool_name: string;
  original_name: string;
  original_path: string;
  summary: string;
  file_type: string;
  score: number;
}

interface RawSearchResult {
  document?: { structData?: Record<string, unknown> };
  rankSignals?: { semanticSimilarityScore?: number; defaultRank?: number };
}

async function searchShard(shard: ShardConfig, query: string, pageSize: number): Promise<VertexSearchResult[]> {
  const url = `${shard.base}/engines/${shard.engineId}/servingConfigs/default_search:search`;
  try {
    const res = await authedFetch(shard, url, {
      method: "POST",
      body: JSON.stringify({ query, pageSize }),
    });
    if (!res.ok) {
      console.error(`[vertexSearch] shard ${shard.id} search failed: ${res.status} ${await res.text()}`);
      return [];
    }
    const data = await res.json();
    const results = (data.results || []) as RawSearchResult[];
    return results.map((r) => {
      const d = r.document?.structData || {};
      return {
        pool_name: String(d.pool_name ?? ""),
        original_name: String(d.original_name ?? ""),
        original_path: String(d.original_path ?? ""),
        summary: String(d.summary ?? ""),
        file_type: String(d.file_type ?? ""),
        score: r.rankSignals?.semanticSimilarityScore ?? r.rankSignals?.defaultRank ?? 0,
      };
    });
  } catch (err) {
    // One shard being unreachable (e.g. a billing issue on just that
    // project, seen live on Mantri) must degrade to "search the shards that
    // do work", not fail the whole query.
    console.error(`[vertexSearch] shard ${shard.id} search threw:`, err);
    return [];
  }
}

// Queries every configured shard in parallel and merges the results by
// score. A single-shard deployment (SHARDS.length === 1) behaves exactly as
// before — one request, no merge overhead.
export async function searchContent(query: string, pageSize = 20): Promise<VertexSearchResult[]> {
  const perShard = await Promise.all(SHARDS.map((shard) => searchShard(shard, query, pageSize)));
  const merged = perShard.flat().filter((r) => r.pool_name);

  // Every file is only ever imported into exactly one shard (tracked via
  // Firestore's vertex_shard field), so this shouldn't happen in normal
  // operation — but de-duping defensively means a one-off double-import
  // (e.g. a manual re-run, or a future migration edge case) shows up once in
  // results instead of twice, rather than relying on that invariant holding
  // perfectly forever.
  const byPoolName = new Map<string, VertexSearchResult>();
  for (const r of merged) {
    const existing = byPoolName.get(r.pool_name);
    if (!existing || r.score > existing.score) byPoolName.set(r.pool_name, r);
  }

  return [...byPoolName.values()].sort((a, b) => b.score - a.score);
}
