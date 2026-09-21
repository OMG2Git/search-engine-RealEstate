import crypto from "crypto";
import { GoogleAuth } from "google-auth-library";

const PROJECT = process.env.VERTEX_SEARCH_PROJECT || "";
const LOCATION = process.env.VERTEX_SEARCH_LOCATION || "global";
const DATASTORE_ID = process.env.VERTEX_SEARCH_DATASTORE_ID || "";
const ENGINE_ID = process.env.VERTEX_SEARCH_ENGINE_ID || "";

const BASE = `https://discoveryengine.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/collections/default_collection`;

const auth = new GoogleAuth({
  keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS,
  scopes: ["https://www.googleapis.com/auth/cloud-platform"],
});

async function authedFetch(url: string, init: RequestInit): Promise<Response> {
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init.headers || {}),
      Authorization: `Bearer ${token.token}`,
      "Content-Type": "application/json",
      "X-Goog-User-Project": PROJECT,
    },
  });
  return res;
}

// Discovery Engine document IDs only allow [a-zA-Z0-9-_] — our pool file
// names have dots, spaces, parentheses. Hash pool_name into a safe stable
// ID instead, and keep pool_name as a regular field for lookups.
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

export async function importRecords(records: VertexRecord[]): Promise<void> {
  if (records.length === 0) return;
  const url = `${BASE}/dataStores/${DATASTORE_ID}/branches/0/documents:import`;
  const documents = records.map((r) => ({
    id: vertexDocId(r.pool_name),
    jsonData: JSON.stringify(r),
  }));
  const res = await authedFetch(url, {
    method: "POST",
    body: JSON.stringify({ inlineSource: { documents } }),
  });
  if (!res.ok) {
    throw new Error(`Vertex AI Search import failed: ${res.status} ${await res.text()}`);
  }
}

export async function deleteRecord(poolName: string): Promise<void> {
  const url = `${BASE}/dataStores/${DATASTORE_ID}/branches/0/documents/${vertexDocId(poolName)}`;
  await authedFetch(url, { method: "DELETE" });
}

export interface VertexSearchResult {
  pool_name: string;
  original_name: string;
  original_path: string;
  summary: string;
  file_type: string;
  score: number;
}

export async function searchContent(query: string, pageSize = 20): Promise<VertexSearchResult[]> {
  const url = `${BASE}/engines/${ENGINE_ID}/servingConfigs/default_search:search`;
  const res = await authedFetch(url, {
    method: "POST",
    body: JSON.stringify({ query, pageSize }),
  });
  if (!res.ok) {
    throw new Error(`Vertex AI Search query failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  const results = (data.results || []) as Array<{
    document?: { structData?: Record<string, unknown> };
    rankSignals?: { semanticSimilarityScore?: number; defaultRank?: number };
  }>;

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
}
