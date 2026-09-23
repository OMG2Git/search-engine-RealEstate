import fs from "fs";
import path from "path";

export interface MappingRecord {
  original_path: string;
  original_name: string;
  size_bytes: number;
  modified_at: string;
  copied_at: string;
}

export type Mapping = Record<string, MappingRecord>;

const POOL_DIR = process.env.POOL_DIR || "";
const MAPPING_TTL_MS = 10_000;

let cachedMapping: Mapping | null = null;
let cachedAt = 0;

function mappingPath(): string {
  return path.join(POOL_DIR, "file_mapping.json");
}

export function getPoolDir(): string {
  return POOL_DIR;
}

export function getMapping(): Mapping {
  const now = Date.now();
  if (cachedMapping && now - cachedAt < MAPPING_TTL_MS) {
    return cachedMapping;
  }
  try {
    const raw = fs.readFileSync(mappingPath(), "utf-8");
    cachedMapping = JSON.parse(raw) as Mapping;
  } catch {
    cachedMapping = {};
  }
  cachedAt = now;
  return cachedMapping;
}

export interface PoolStats {
  totalFiles: number;
  totalBytes: number;
}

// All-time totals across every crawl run so far, not just the current one —
// used by the Sync New Files page to show "N files / X GB in the pool" as
// context alongside this run's live progress.
export function getPoolStats(): PoolStats {
  const mapping = getMapping();
  const records = Object.values(mapping);
  return {
    totalFiles: records.length,
    totalBytes: records.reduce((sum, r) => sum + (r.size_bytes || 0), 0),
  };
}

export function listPoolFiles(): string[] {
  if (!POOL_DIR || !fs.existsSync(/* turbopackIgnore: true */ POOL_DIR)) return [];
  return fs
    .readdirSync(/* turbopackIgnore: true */ POOL_DIR)
    .filter(
      (name) =>
        name !== "file_mapping.json" &&
        name !== ".stop_requested" &&
        !name.endsWith(".part") &&
        !name.endsWith(".tmp") &&
        // Transient per-summarization temp file (see lib/gemini.ts's image
        // handling) — written directly into the pool dir while OpenRouter
        // summarizes an image, then deleted. A sync run's file listing can
        // race against one that's mid-flight and briefly pick it up as if
        // it were a real, unprocessed pool file (confirmed: 11 of these
        // logged as "no mapping entry" in one real run).
        !name.endsWith(".__openrouter.png")
    );
}
