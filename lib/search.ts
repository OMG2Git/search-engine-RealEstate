import { filesCollection } from "@/lib/firestore";
import { FieldPath } from "@google-cloud/firestore";
import { getNameIndex } from "@/lib/nameIndex";
import { tokenise } from "@/lib/gemini";
import { searchContent as vertexSearchContent } from "@/lib/vertexSearch";

// Enough candidates for several pages of results client-side, while staying
// cheap: ranking itself is in-memory, and fetching full docs for this many
// IDs is a handful of chunked Firestore "in" queries (capped at 30 each).
const RESULT_LIMIT = 100;
const FIRESTORE_IN_LIMIT = 30; // Firestore "in" operator caps at 30 values

const STOPWORDS = new Set([
  "the", "a", "an", "of", "for", "and", "or", "to", "in", "on", "with", "is", "are", "was", "were",
]);

export interface SearchResult {
  pool_name: string;
  original_name: string;
  original_path: string;
  summary: string;
  file_type: string;
  score: number;
  matched_on: string[];
}

function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

// A flat "ratio > 0.8" threshold unfairly punishes short words — a single
// typo in a 4-letter word ("wllo" for "wilo") already costs 25% of the
// ratio and fails an 80% bar. Use an absolute edit-distance budget that
// scales with word length instead — the same table Elasticsearch's
// "fuzziness: AUTO" uses, since it's a well-proven calibration: very short
// words must match exactly, short words forgive one typo, longer words
// forgive two.
function maxEditDistance(len: number): number {
  if (len <= 2) return 0;
  if (len <= 5) return 1;
  return 2;
}

function isFuzzyMatch(a: string, b: string): boolean {
  const maxLen = Math.max(a.length, b.length);
  // Cheap pre-filter: skip the O(len*len) DP entirely when the length gap
  // alone already exceeds what any allowed edit distance could bridge.
  if (Math.abs(a.length - b.length) > maxEditDistance(maxLen)) return false;
  return levenshteinDistance(a, b) <= maxEditDistance(maxLen);
}

function scoreNameMatch(query: string, name: string): number {
  const q = query.toLowerCase().trim();
  const n = name.toLowerCase();
  if (!q) return 0;
  if (n === q) return 1.0;
  if (n.startsWith(q)) return 0.9;
  if (n.includes(q)) return 0.8;
  const qTokens = tokenise(q);
  const nTokens = tokenise(n);
  if (qTokens.length > 0 && qTokens.every((t) => nTokens.includes(t))) return 0.7;

  // Fuzzy matching is compared against the name WITHOUT its extension —
  // people type "agreemnt" not "agreemnt.pdf", and comparing against the
  // full name (with a 3-4 char extension) drags the ratio below threshold.
  const dotIdx = n.lastIndexOf(".");
  const stem = dotIdx > 0 ? n.slice(0, dotIdx) : n;

  if (isFuzzyMatch(q, stem)) return 0.6;

  // A typo'd guess at just PART of the name — the file is actually
  // "trypandoc (20).docx" but a user typing "trypandc" only remembers the
  // meaningful word, not a trailing "(20)". Try the query against each
  // individual word in the name too, not only the name as a whole.
  if (q.length >= 4 && nTokens.some((tok) => tok.length >= 4 && isFuzzyMatch(q, tok))) return 0.55;
  return 0;
}

function queryTokens(query: string): string[] {
  return tokenise(query).filter((t) => !STOPWORDS.has(t));
}

// A query token counts as matching a keyword if either contains the other —
// this is what makes "denser" find a stored keyword like "denserai" (a
// compound word/brand name Gemini wrote as one token, no space to split on).
// Firestore's array-contains-any only does exact whole-element matches, so
// this runs against the in-memory keyword index instead (same proven
// approach as name search — instant, no per-query network round trip).
// Substring tolerance only kicks in when both sides are reasonably long —
// otherwise a short keyword like "n" or "a" (a legitimate single-letter
// keyword, e.g. the "N" in a logo) would trivially substring-match almost
// any query, since a 1-2 character string is a substring of nearly anything.
const MIN_SUBSTRING_MATCH_LEN = 4;

// Gemini's keyword list is curated (10-20 terms — mostly names, document
// type, institution) and is NOT exhaustive of everything the summary
// mentions — a course subject like "Database Management Systems" may show
// up in the summary text but never make Gemini's keyword shortlist. Relying
// on the keywords array alone means keyword mode structurally can't find
// such terms no matter how good the matching logic is. So: a keyword-array
// hit scores full credit; a plain substring hit in the summary text (a
// looser, uncurated signal) scores partial credit as a fallback.
const SUMMARY_MATCH_WEIGHT = 0.6;
// Last-resort tier: a typo in the query itself (name search already forgives
// these; keyword search didn't). Only tried against the keywords array — it's
// small and bounded per doc (~20-60 short entries), so this stays cheap even
// at tens of thousands of documents, unlike fuzzy-matching arbitrary summary
// text would be.
const FUZZY_MATCH_WEIGHT = 0.5;

function keywordEntryScore(tokens: string[], keywords: string[], summary: string): number {
  if (tokens.length === 0) return 0;
  const summaryLower = summary.toLowerCase();
  let scoreSum = 0;
  for (const t of tokens) {
    // Only "stored keyword contains the query" — e.g. "denser" finding
    // "denserai". The reverse ("query contains a short stored keyword") is
    // NOT a reliable signal: "marksheet" trivially contains the unrelated
    // keyword "mark" (from a logo's "brand mark"), so allowing it back-matches
    // documents on pure coincidence rather than an intentional partial query.
    const keywordHit = keywords.some((k) => {
      if (k === t) return true;
      if (t.length < MIN_SUBSTRING_MATCH_LEN || k.length < MIN_SUBSTRING_MATCH_LEN) return false;
      return k.includes(t);
    });
    if (keywordHit) {
      scoreSum += 1;
      continue;
    }
    if (t.length >= MIN_SUBSTRING_MATCH_LEN && summaryLower.includes(t)) {
      scoreSum += SUMMARY_MATCH_WEIGHT;
      continue;
    }
    const fuzzyHit = t.length >= MIN_SUBSTRING_MATCH_LEN && keywords.some((k) => isFuzzyMatch(t, k));
    if (fuzzyHit) scoreSum += FUZZY_MATCH_WEIGHT;
  }
  return scoreSum / tokens.length;
}

interface Candidate {
  id: string;
  nameScore: number;
  keywordScore: number;
  contentScore: number;
  // Present only for a hit that came from Vertex and isn't already in the
  // name/keyword candidate set — Vertex's structData carries everything
  // needed to render the result, so this skips a redundant Firestore fetch.
  vertexData?: { pool_name: string; original_name: string; original_path: string; summary: string; file_type: string };
}

// File name match is the single highest-priority signal — a user typing
// (part of) the actual file name should always see it first, ahead of any
// keyword/semantic match no matter how strong. Adding a large fixed tier
// (rather than just weighting name higher) makes this a hard guarantee, not
// a tendency that a strong enough keyword/content score could still beat.
const NAME_MATCH_TIER = 1000;

// Below the name tier, keyword and semantic (AI) matches are merged into one
// combined relevance score rather than kept as separate modes/tiers — a
// file that both of them agree on is more likely to be the right one than a
// file either signal alone picked, so agreement is rewarded with a bonus on
// top of the stronger of the two signals.
const AGREEMENT_BONUS_WEIGHT = 0.3;

function combineScore(c: Candidate): number {
  if (c.nameScore > 0) return NAME_MATCH_TIER + c.nameScore;
  const base = Math.max(c.keywordScore, c.contentScore);
  const agreementBonus = Math.min(c.keywordScore, c.contentScore) * AGREEMENT_BONUS_WEIGHT;
  return base + agreementBonus;
}

// Single, unopinionated search: the caller never chooses a mode. Name,
// keyword, and AI/semantic (Vertex) signals are all gathered for the same
// query and merged into one ranked list, in-process, before anything is
// returned — see combineScore for the priority rule.
export async function search(query: string): Promise<SearchResult[]> {
  const q = query.trim();
  if (!q) return [];

  const index = await getNameIndex();
  const tokens = queryTokens(q);

  const candidates = new Map<string, Candidate>();
  for (const entry of index) {
    const nameScore = scoreNameMatch(q, entry.original_name);
    const keywordScore = tokens.length > 0 ? keywordEntryScore(tokens, entry.keywords, entry.summary) : 0;
    if (nameScore > 0 || keywordScore > 0) {
      candidates.set(entry.id, { id: entry.id, nameScore, keywordScore, contentScore: 0 });
    }
  }

  // Vertex AI Search must never take the whole search down — e.g. its
  // billing account being temporarily disabled (seen live in production)
  // should degrade to name+keyword results only, not fail every search.
  let contentResults: Awaited<ReturnType<typeof vertexSearchContent>> = [];
  try {
    contentResults = await vertexSearchContent(q, RESULT_LIMIT);
  } catch (err) {
    console.error("[search] Vertex content search failed, continuing with name/keyword results only:", err);
  }

  for (const r of contentResults) {
    if (!r.pool_name) continue;
    const existing = candidates.get(r.pool_name);
    if (existing) {
      existing.contentScore = r.score;
    } else {
      candidates.set(r.pool_name, { id: r.pool_name, nameScore: 0, keywordScore: 0, contentScore: r.score, vertexData: r });
    }
  }

  const ranked = [...candidates.values()]
    .map((c) => ({ ...c, finalScore: combineScore(c) }))
    .sort((a, b) => b.finalScore - a.finalScore)
    .slice(0, RESULT_LIMIT);

  if (ranked.length === 0) return [];

  // Firestore is the source of truth for status/current data — fetch full
  // docs for every candidate that came from the name/keyword index. Vertex-
  // only hits already carry full structData and are indexed==done by
  // construction (only "done" files are ever imported), so they skip this.
  const needsFetch = ranked.filter((c) => !c.vertexData).map((c) => c.id);
  const docById = new Map<string, FirebaseFirestore.DocumentData>();
  for (let i = 0; i < needsFetch.length; i += FIRESTORE_IN_LIMIT) {
    const chunk = needsFetch.slice(i, i + FIRESTORE_IN_LIMIT);
    const docs = await filesCollection.where(FieldPath.documentId(), "in", chunk).get();
    for (const d of docs.docs) docById.set(d.id, d.data()!);
  }

  const results: SearchResult[] = [];
  for (const c of ranked) {
    const matchedOn: string[] = [];
    if (c.nameScore > 0) matchedOn.push("name");
    if (c.keywordScore > 0) matchedOn.push("keyword");
    if (c.contentScore > 0) matchedOn.push("content");

    if (c.vertexData) {
      results.push({ ...c.vertexData, score: c.finalScore, matched_on: matchedOn });
      continue;
    }

    const data = docById.get(c.id);
    if (!data || data.status !== "done") continue;
    results.push({
      pool_name: data.pool_name,
      original_name: data.original_name,
      original_path: data.original_path,
      summary: data.summary ?? "",
      file_type: data.file_type,
      score: c.finalScore,
      matched_on: matchedOn,
    });
  }
  return results;
}
