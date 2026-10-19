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
// Tracks a load already in flight so concurrent callers share it instead of
// each starting their own full Firestore scan — every search now needs this
// index (unlike before, when only name/keyword mode did), so several
// searches landing close together on a cold cache used to each kick off
// their own multi-second full-collection fetch, compounding into search
// requests taking 70+ seconds apiece. Seen live on Mantri: a user typing
// "iceberg" fired 5+ overlapping searches, each racing to reload the same
// ~26,000-doc index from scratch.
let loading: Promise<NameIndexEntry[]> | null = null;

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
  if (cache) return cache;
  if (!loading) {
    loading = load()
      .then((data) => {
        cache = data;
        return data;
      })
      .finally(() => {
        loading = null;
      });
  }
  return loading;
}

export async function refreshNameIndex(): Promise<void> {
  cache = await load();
}
