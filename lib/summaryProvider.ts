import fs from "fs";
import type { SummaryResult } from "@/lib/gemini";
import { PROMPT, parseJsonResponse } from "@/lib/gemini";
import { renderPdfPagesInWorker } from "@/lib/renderPool";

// Opt-in alternative to calling Gemini directly — routes through OpenRouter
// instead, using google/gemini-2.5-flash-lite. In testing, this tokenized
// documents more efficiently than calling Gemini directly, at roughly 1/3
// the per-token price. NOT the default: this depends on a third-party
// (OpenRouter) continuing to have access to the model, and is worth
// validating at production scale before trusting it as primary. Set
// SUMMARY_PROVIDER=openrouter to use it.
const PROVIDER = process.env.SUMMARY_PROVIDER || "gemini-direct";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
// ":batch" looks like a same-call discounted pricing tier from OpenRouter's
// /models listing, but real testing proved that wrong: every call to
// "google/gemini-2.5-flash-lite:batch" via this normal chat-completions
// endpoint fails with 404 ("only available through the Batch API — use
// /api/v1/batches instead"). That's OpenRouter's separate async
// submit-then-poll job system, not implemented here. Standard tier (no
// ":batch") is what's actually confirmed working.
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "google/gemini-2.5-flash-lite";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// OpenRouter's image-content requests cap combined downloaded image size at
// 30MB (confirmed by testing — a 297-page document's images totalled 51MB
// and was rejected). Stay well under that — this is the size of ONE chunk,
// not the whole document; documents longer than this are split into
// multiple chunks (see summariseViaOpenRouterInner) rather than truncated.
const MAX_OPENROUTER_PAGES = 40;
const MAX_OPENROUTER_IMAGE_BYTES = 20 * 1024 * 1024; // stay under the 30MB cap with margin

// Real testing confirmed simply capping at MAX_OPENROUTER_PAGES silently
// dropped 86% of a 297-page real document from the summary (8 of 10 topic
// areas present in a full-document Gemini-direct summary were completely
// missing — see the comparison in conversation). Documents longer than one
// chunk are now split into multiple page-range chunks, each summarized
// separately, then merged into one final summary — so every page is
// actually seen. Capped at MAX_CHUNKS chunks (400 pages) as a sane ceiling
// for pathological cases; beyond that, the same "opening pages carry the
// identifying information" reasoning as the old cap applies.
const MAX_CHUNKS = 10;
// How many chunks to render+summarize at once for a single large document.
// Real testing found 3-way concurrent ~20MB chunk requests can exhaust
// local connection resources and fail with a raw TCP connect timeout
// (UND_ERR_CONNECT_TIMEOUT) before a single byte is even sent — a genuine
// network-layer issue, not something retries fix, since it recurs the same
// way each attempt. Sequential is the safe choice: the pipeline's real
// concurrency already comes from processing 16 different files at once
// (lib/syncEngine.ts) — a single large document's own chunks don't need to
// also compete for connections, since large multi-chunk files are the rare
// case, not the norm.
const CHUNK_CONCURRENCY = 1;

// Same retry shape as lib/gemini.ts's callGeminiWithRetry, so both paths
// behave consistently: transient failures (network blips, 429s, 5xx) get
// retried with backoff; genuinely bad requests (400/401/403/404) don't
// waste attempts retrying something that will never succeed.
const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 30_000;
const NON_RETRYABLE_STATUS = new Set([400, 401, 403, 404]);

// Hard ceilings so a single messy real-world file can never hang the whole
// pipeline — every promise this module returns is guaranteed to eventually
// resolve or reject, never hang indefinitely. A 15+ year archive will
// contain files that trigger edge cases no small test sample could surface.
// Real testing found 60s too tight for a near-max-size 40-page image chunk
// (~20MB of image data) — it was hitting this ceiling consistently on every
// retry rather than the request being genuinely stuck, defeating the point
// of retrying at all. 120s per attempt, still bounded by the 15-minute
// overall ceiling below regardless of how many attempts this takes.
const REQUEST_TIMEOUT_MS = 120_000; // per HTTP attempt
// Generous enough for a large multi-chunk document (up to MAX_CHUNKS calls
// plus one merge call) to genuinely finish, while still guaranteeing this
// never hangs forever regardless of how large or slow a single file is.
const OVERALL_FILE_TIMEOUT_MS = 15 * 60_000;

export function usingOpenRouter(): boolean {
  return PROVIDER === "openrouter";
}

function isRetryable(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (typeof status === "number") return !NON_RETRYABLE_STATUS.has(status);
  return true; // no status = network-level error (timeout, DNS, connection reset) — worth retrying
}

type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

function imagesToContent(imagePngs: Buffer[]): ContentPart[] {
  return [
    { type: "text", text: PROMPT },
    ...imagePngs.map((png) => ({
      type: "image_url" as const,
      image_url: { url: `data:image/png;base64,${png.toString("base64")}` },
    })),
  ];
}

function textToContent(extractedText: string): ContentPart[] {
  return [{ type: "text", text: `${PROMPT}\n\nFILE CONTENT:\n${extractedText}` }];
}

async function callOpenRouterOnce(content: ContentPart[]): Promise<SummaryResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        max_tokens: 2000,
        messages: [{ role: "user", content }],
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const err = new Error(`OpenRouter request failed: ${res.status} ${await res.text()}`) as Error & { status: number };
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content ?? "";
  return parseJsonResponse(text);
}

async function callOpenRouterWithRetry(content: ContentPart[]): Promise<SummaryResult> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await callOpenRouterOnce(content);
    } catch (err) {
      lastError = err;
      if (!isRetryable(err) || attempt === MAX_ATTEMPTS - 1) break;
      const backoff = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
      const jitter = Math.random() * 500;
      await new Promise((r) => setTimeout(r, backoff + jitter));
    }
  }
  throw lastError;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]);
}

const MERGE_PROMPT = `You are given several partial summaries, each covering a different, non-overlapping page range of the SAME real estate company document. Combine them into ONE single, cohesive summary of the whole document — do not just repeat one section, synthesize the important points across ALL of them.
Return strict JSON: {"summary": string, "keywords": string[]}.
summary: at most 200 words. State what the document overall IS and its purpose, and the most search-useful facts spanning all sections: project/party names, plot/survey numbers, key dates and amounts, document/reference numbers. Prioritise breadth across sections over depth on any one section.
keywords: 12-20 lowercase search terms combining the most useful, distinctive keywords across all sections — deduplicate near-identical ones.
Never use a double-quote character (") anywhere in the text — use a single quote (') instead, since the output must remain valid JSON.

PARTIAL SUMMARIES (in page order):
`;

async function mergePartialSummaries(partials: SummaryResult[]): Promise<SummaryResult> {
  if (partials.length === 1) return partials[0];
  const body = partials
    .map((p, i) => `Section ${i + 1} summary: ${p.summary}\nSection ${i + 1} keywords: ${p.keywords.join(", ")}`)
    .join("\n\n");
  return callOpenRouterWithRetry([{ type: "text", text: MERGE_PROMPT + body }]);
}

// Runs async tasks with bounded concurrency (a minimal alternative to
// pulling in p-limit just for this one internal use) — used to render and
// summarize a large document's chunks a few at a time rather than either
// fully sequential (slow) or fully parallel (could spike the render pool
// and API load for one single file well beyond what's reasonable).
async function mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

async function summariseChunk(filePath: string, startPage: number, endPage: number): Promise<SummaryResult> {
  const rendered = await renderPdfPagesInWorker(filePath, startPage, endPage, MAX_OPENROUTER_IMAGE_BYTES);
  if (rendered.pages.length === 0) {
    throw new Error(`No renderable pages in range ${startPage}-${endPage}`);
  }
  return callOpenRouterWithRetry(imagesToContent(rendered.pages));
}

async function summariseViaOpenRouterInner(filePath: string, isPdf: boolean): Promise<SummaryResult> {
  if (!isPdf) {
    const pages = [fs.readFileSync(filePath)];
    return callOpenRouterWithRetry(imagesToContent(pages));
  }

  // First chunk tells us the real total page count — most real files are
  // under MAX_OPENROUTER_PAGES and finish here with exactly the same single
  // call as before (no behavior/cost change for the common case).
  const first = await renderPdfPagesInWorker(filePath, 1, MAX_OPENROUTER_PAGES, MAX_OPENROUTER_IMAGE_BYTES);
  if (first.pages.length === 0) {
    throw new Error("No renderable pages/images to send");
  }
  const firstSummary = callOpenRouterWithRetry(imagesToContent(first.pages));

  if (first.totalPages <= MAX_OPENROUTER_PAGES) {
    return firstSummary;
  }

  // Document is larger than one chunk — build the remaining page-range
  // chunks and summarize each, capped at MAX_CHUNKS total (a sane ceiling
  // for pathologically large files, not a normal case).
  const totalChunksNeeded = Math.ceil(first.totalPages / MAX_OPENROUTER_PAGES);
  const chunkCount = Math.min(totalChunksNeeded, MAX_CHUNKS);
  const remainingRanges: Array<[number, number]> = [];
  for (let c = 1; c < chunkCount; c++) {
    const start = c * MAX_OPENROUTER_PAGES + 1;
    const end = Math.min(start + MAX_OPENROUTER_PAGES - 1, first.totalPages);
    remainingRanges.push([start, end]);
  }

  const restSummaries = await mapWithConcurrency(remainingRanges, CHUNK_CONCURRENCY, ([start, end]) =>
    summariseChunk(filePath, start, end)
  );

  const allPartials = [await firstSummary, ...restSummaries];
  return mergePartialSummaries(allPartials);
}

// Same entry shape as the direct-Gemini path: file bytes + which kind of
// file it is. Handles both PDF (rasterized to page images first — OpenRouter
// needs images, native PDF input requires a paid balance we don't rely on)
// and already-normalized-to-PNG images.
//
// PDF rendering runs on a separate worker thread (lib/renderPool.ts) rather
// than inline on Node's main thread — confirmed by testing that in-process
// rendering was the real bottleneck under concurrency (16 concurrent files
// took 60.8s in-process vs 9.9s once rendering was isolated onto its own
// thread), not OpenRouter's API itself.
//
// The whole thing is wrapped in a final timeout on top of the render pool's
// own timeout and the API retry logic's own per-attempt timeout — belt and
// braces, so that regardless of which layer something unexpected happens
// in, this function is guaranteed to settle within OVERALL_FILE_TIMEOUT_MS
// and never leave syncEngine's per-file processing hung on one bad file.
export async function summariseViaOpenRouter(filePath: string, isPdf: boolean): Promise<SummaryResult> {
  return withTimeout(summariseViaOpenRouterInner(filePath, isPdf), OVERALL_FILE_TIMEOUT_MS, `Summarising ${filePath}`);
}

// Text/office files (.txt/.csv/.md and .docx/.xlsx/.doc/.pptx/etc.) are
// extracted to plain text locally first (unchanged — same extractors as
// the direct-Gemini path), then summarized here instead of via Gemini
// directly. No rendering step needed (there's nothing to rasterize), so
// this is simpler than the PDF/image path — same retry/timeout hardening,
// just a plain text message instead of image content.
export async function summariseTextViaOpenRouter(extractedText: string): Promise<SummaryResult> {
  return withTimeout(
    callOpenRouterWithRetry(textToContent(extractedText)),
    OVERALL_FILE_TIMEOUT_MS,
    "Summarising extracted text"
  );
}
