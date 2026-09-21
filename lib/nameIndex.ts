import { filesCollection } from "@/lib/firestore";

// Despite the name (kept for now to limit the diff), this backs both name
// search and keyword search — it's the shared in-memory index of everything
// needed to score a query without a per-search Firestore round trip.
export interface NameIndexEntry {
  id: string;
  original_name: string;
  pool_name: string;
  keywords: string[];
  summary: string;
}

let cache: NameIndexEntry[] | null = null;

async function load(): Promise<NameIndexEntry[]> {
  const snap = await filesCollection.select("original_name", "pool_name", "keywords", "summary").get();
  return snap.docs.map((d) => ({
    id: d.id,
    original_name: d.get("original_name") as string,
    pool_name: d.get("pool_name") as string,
    keywords: (d.get("keywords") as string[]) || [],
    summary: (d.get("summary") as string) || "",
  }));
}

export async function getNameIndex(): Promise<NameIndexEntry[]> {
  if (!cache) cache = await load();
  return cache;
}

export async function refreshNameIndex(): Promise<void> {
  cache = await load();
}
