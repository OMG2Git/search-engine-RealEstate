import fs from "fs";
import path from "path";
import { GoogleGenAI } from "@google/genai";
import mammoth from "mammoth";
import * as XLSX from "xlsx";
import { PDFDocument } from "pdf-lib";
import WordExtractor from "word-extractor";
import { OfficeParser } from "officeparser";
import sharp from "sharp";
import { usingOpenRouter, summariseViaOpenRouter, summariseTextViaOpenRouter } from "@/lib/summaryProvider";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const SUMMARY_MODEL = "gemini-2.5-flash";

const MAX_TEXT_CHARS = 100_000;

// Gemini's own hard ceilings (not ours) — inline PDFs: 50MB or 1000 pages,
// whichever is hit first; general inline data (images etc.): 100MB. A small
// safety margin is kept below each so we never bump the exact boundary.
const MAX_PDF_BYTES = 45 * 1024 * 1024;
const MAX_PDF_PAGES = 900;
const MAX_IMAGE_BYTES = 90 * 1024 * 1024;

export type FileClass = "pdf" | "image" | "text" | "office" | "other";

// Gemini's inline API only documents/reliably accepts PNG, JPEG, WEBP,
// HEIC, HEIF — confirmed the hard way: image/tiff returns a flat 400
// "Unsupported MIME type" even though .tif/.tiff are extremely common for
// older scanned office documents. Rather than maintain a guess-and-hope
// list of "which formats does Gemini actually accept", every image gets
// normalised to PNG locally (via sharp) before it's ever sent — see
// normaliseImageToPng. This set is only used for file classification.
const IMAGE_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp",
  ".tiff", ".tif", ".avif", ".jfif", ".heic", ".heif",
]);

const TEXT_EXT = new Set([".txt", ".csv", ".md"]);
// .docx/.xlsx handled by mammoth/xlsx (already proven in production). The
// legacy binary formats (.doc, pre-2007 Word) and modern OOXML/ODF formats
// (.pptx, .rtf, .odt, .ods, .odp) are handled by two additional local
// extractors below — see extractOfficeText.
const OFFICE_EXT = new Set([".docx", ".xlsx", ".xls", ".doc", ".pptx", ".rtf", ".odt", ".ods", ".odp"]);

export function classify(filename: string): FileClass {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".pdf") return "pdf";
  if (IMAGE_EXT.has(ext)) return "image";
  if (TEXT_EXT.has(ext)) return "text";
  if (OFFICE_EXT.has(ext)) return "office";
  return "other";
}

export interface SummaryResult {
  summary: string;
  keywords: string[];
}

export const PROMPT = `You are indexing files for a real estate company. Describe this file so that an employee can find it later even if they only vaguely remember it.
Return strict JSON: {"summary": string, "keywords": string[]}.
summary: at most 200 words. State what the document IS (agreement, brochure, floor plan, invoice, site photo, approval letter, ledger, tender...), who or what it concerns, and its purpose. Prioritise the facts most useful for search: project/party names, plot or survey numbers, key dates and amounts, document/reference numbers. If the document has many similar line items (a long ledger, a multi-subject transcript), summarise the pattern and list only the most distinctive entries rather than every single one. For images, describe what is visually shown AND transcribe significant visible text. Be concrete. Use exact names and numbers that appear in the file. Do not add information that is not there. Never use a double-quote character (") anywhere in the text — use a single quote (') instead, since the output must remain valid JSON.
keywords: 12-20 lowercase search terms — project names, document type, key people and parties, plot/survey/reference numbers, locations, years.`;

// Gemini can still occasionally slip a raw double-quote into a string value
// despite the prompt's instruction not to (e.g. quoting a disclaimer
// verbatim) — that alone makes JSON.parse throw even though the response is
// otherwise perfectly good. Repair it once before giving up: escape any
// unescaped inner quote within the summary value's own text.
function repairInnerQuotes(text: string): string {
  // Greedy match up to the LAST "keywords" -- spans across any unescaped
  // inner quotes that would make a lazy match stop too early. Escapes only
  // quotes not already escaped.
  const match = text.match(/"summary"\s*:\s*"([\s\S]*)"\s*,\s*"keywords"/);
  if (!match || match.index === undefined) return text;
  const fixed = match[1].replace(/(?<!\\)"/g, '\\"');
  return text.slice(0, match.index) + `"summary": "${fixed}", "keywords"` + text.slice(match.index + match[0].length);
}

export function parseJsonResponse(text: string): SummaryResult {
  const cleaned = text.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/, "");
  let parsed: { summary?: unknown; keywords?: unknown };
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    parsed = JSON.parse(repairInnerQuotes(cleaned));
  }
  const summary = typeof parsed.summary === "string" ? parsed.summary : "";
  const keywords = Array.isArray(parsed.keywords)
    ? parsed.keywords.map((k: unknown) => String(k).toLowerCase())
    : [];
  return { summary, keywords };
}

const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 30_000;

// Codes that mean "this exact request will never succeed" — no point retrying.
// Anything else (429, 5xx, or a network-level failure with no status at all —
// DNS hiccup, connection reset, timeout) is treated as transient and retried,
// since this runs unattended for many hours and a blip must not lose a file.
const NON_RETRYABLE_STATUS = new Set([400, 401, 403, 404]);

function isRetryable(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (typeof status === "number") return !NON_RETRYABLE_STATUS.has(status);
  return true; // no status = network-level error (fetch failed, ENOTFOUND, ECONNRESET, timeout...)
}

async function callGeminiWithRetry(parts: Array<Record<string, unknown>>): Promise<SummaryResult> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: SUMMARY_MODEL,
        contents: [{ role: "user", parts }],
        config: { responseMimeType: "application/json" },
      });
      const text = response.text ?? "";
      return parseJsonResponse(text);
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

function fallbackSummary(originalName: string, originalPath: string): SummaryResult {
  const tokens = tokenise(`${originalName} ${originalPath}`);
  return {
    summary: `File "${originalName}" located at ${originalPath}. Content was not read (unsupported file type).`,
    keywords: [...new Set(tokens)].slice(0, 20),
  };
}

export function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

async function firstNPages(original: PDFDocument, n: number): Promise<Buffer> {
  const trimmed = await PDFDocument.create();
  const indices = Array.from({ length: n }, (_, i) => i);
  const copiedPages = await trimmed.copyPages(original, indices);
  copiedPages.forEach((p) => trimmed.addPage(p));
  return Buffer.from(await trimmed.save());
}

// Trim an oversized PDF down instead of giving up on it — a 500-page scanned
// agreement still gets a real, content-based summary from its opening pages
// rather than a filename-only placeholder. The tail of a huge document is
// rarely where the identifying information lives anyway.
//
// Oversized can mean too many pages OR too few pages with huge embedded
// images (page trimming alone doesn't shrink per-page bytes), so this keeps
// halving the page count and re-measuring until it actually fits, rather
// than trimming once and hoping.
async function trimPdfForInline(bytes: Buffer): Promise<Buffer | null> {
  const original = await PDFDocument.load(bytes, { ignoreEncryption: true });
  let pageCount = Math.min(original.getPageCount(), MAX_PDF_PAGES);

  while (pageCount >= 1) {
    const candidate = await firstNPages(original, pageCount);
    if (candidate.length <= MAX_PDF_BYTES) return candidate;
    pageCount = Math.floor(pageCount / 2);
  }
  return null; // even a single page doesn't fit — genuinely pathological
}

// Converts any readable image format to PNG, which Gemini's inline API is
// confirmed to accept. Multi-page/multi-frame TIFFs (common for scanned
// documents) are read at their first page only — same "opening pages carry
// the identifying information" reasoning as the PDF trimming above.
// Returns null for a genuinely corrupt/unreadable file rather than throwing,
// so one bad image degrades to a fallback summary instead of failing the
// whole sync attempt with no useful message.
async function normaliseImageToPng(bytes: Buffer): Promise<Buffer | null> {
  try {
    return await sharp(bytes, { page: 0 }).png().toBuffer();
  } catch {
    return null;
  }
}

const wordExtractor = new WordExtractor();

async function extractOfficeText(filePath: string, ext: string): Promise<string> {
  if (ext === ".docx") {
    const { value } = await mammoth.extractRawText({ path: filePath });
    return value;
  }
  if (ext === ".xlsx" || ext === ".xls") {
    // Read the buffer ourselves (not XLSX.readFile(path)) so a real fs error
    // — ENOENT, EACCES, a file locked by another program — surfaces with its
    // actual message. XLSX.readFile wraps any read failure in its own
    // generic "Cannot access file <path>" string, which hides the real cause.
    const buffer = fs.readFileSync(filePath);
    const workbook = XLSX.read(buffer, { type: "buffer" });
    return workbook.SheetNames.map((name) => XLSX.utils.sheet_to_csv(workbook.Sheets[name])).join("\n\n");
  }
  if (ext === ".doc") {
    // Legacy pre-2007 binary Word format — mammoth/officeparser don't read
    // this at all, it needs its own dedicated extractor.
    const doc = await wordExtractor.extract(filePath);
    return doc.getBody();
  }
  // .pptx, .rtf, .odt, .ods, .odp — modern OOXML/ODF formats officeparser
  // handles directly.
  const ast = await OfficeParser.parseOffice(filePath);
  return ast.toText();
}

export async function summariseFile(
  filePath: string,
  originalName: string,
  originalPath: string
): Promise<SummaryResult> {
  const fileClass = classify(originalName);
  const ext = path.extname(originalName).toLowerCase();

  if (fileClass === "other") {
    return fallbackSummary(originalName, originalPath);
  }

  const stat = fs.statSync(filePath);

  if (fileClass === "pdf") {
    if (usingOpenRouter()) {
      return summariseViaOpenRouter(filePath, true);
    }
    let bytes: Buffer = fs.readFileSync(filePath);
    if (bytes.length > MAX_PDF_BYTES) {
      const trimmed = await trimPdfForInline(bytes);
      if (!trimmed) return fallbackSummary(originalName, originalPath); // genuinely pathological file
      bytes = trimmed;
    }
    return callGeminiWithRetry([
      { text: PROMPT },
      { inlineData: { mimeType: "application/pdf", data: bytes.toString("base64") } },
    ]);
  }

  if (fileClass === "image") {
    // No practical way to "trim" an image the way a PDF's pages can be cut
    // down — 90MB is already far beyond any realistic site photo or scan,
    // so a file exceeding it is either corrupt or an unusual raw/TIFF export.
    if (stat.size > MAX_IMAGE_BYTES) return fallbackSummary(originalName, originalPath);
    const original = fs.readFileSync(filePath);
    const png = await normaliseImageToPng(original);
    if (!png) return fallbackSummary(originalName, originalPath); // genuinely unreadable/corrupt image
    if (usingOpenRouter()) {
      // Write the normalized PNG next to the source so summariseViaOpenRouter
      // can read it the same way it reads a rasterized PDF page — avoids a
      // second code path just for "bytes already in memory".
      const tmpPath = `${filePath}.__openrouter.png`;
      fs.writeFileSync(tmpPath, png);
      try {
        return await summariseViaOpenRouter(tmpPath, false);
      } finally {
        fs.unlinkSync(tmpPath);
      }
    }
    return callGeminiWithRetry([
      { text: PROMPT },
      { inlineData: { mimeType: "image/png", data: png.toString("base64") } },
    ]);
  }

  if (fileClass === "text") {
    const raw = fs.readFileSync(filePath, "utf-8").slice(0, MAX_TEXT_CHARS);
    if (usingOpenRouter()) return summariseTextViaOpenRouter(raw);
    return callGeminiWithRetry([{ text: `${PROMPT}\n\nFILE CONTENT:\n${raw}` }]);
  }

  // office
  const raw = (await extractOfficeText(filePath, ext)).slice(0, MAX_TEXT_CHARS);
  if (!raw.trim()) return fallbackSummary(originalName, originalPath);
  if (usingOpenRouter()) return summariseTextViaOpenRouter(raw);
  return callGeminiWithRetry([{ text: `${PROMPT}\n\nFILE CONTENT:\n${raw}` }]);
}
