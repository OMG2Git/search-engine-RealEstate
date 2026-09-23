// Persistent worker thread: renders PDF pages to PNG images on a separate
// OS thread, so CPU-heavy rendering never blocks Node's main event loop or
// serializes across concurrent files. Lives outside the Next.js/lib source
// tree on purpose — spawned by path via worker_threads, not imported through
// the app's module graph, so Turbopack never tries to bundle it (the same
// reason the native @napi-rs/canvas addon needed serverExternalPackages).
import { parentPort } from "worker_threads";
import path from "path";
import { pathToFileURL } from "url";
import fs from "fs";
import { createCanvas } from "@napi-rs/canvas";

const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
// workerSrc goes through a dynamic import() internally, which needs an
// actual file:// URL (a plain Windows path won't resolve there).
const workerPath = path.join(process.cwd(), "node_modules", "pdfjs-dist", "legacy", "build", "pdf.worker.mjs");
pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).href;
// standardFontDataUrl/wasmUrl are different: under Node, pdfjs-dist loads
// them via NodeBinaryDataFactory, whose _fetch() calls fs.readFile(url)
// directly — never fetch(). fs.readFile only auto-parses an actual URL
// object; a plain string that merely looks like "file:///C:/..." is
// treated as a literal (garbage) relative path and fails with ENOENT.
// These must stay as plain OS path strings, not file:// URLs — confirmed
// by reproducing the exact failure and fixing it this way directly against
// the real jbig2.wasm file on disk (see conversation this landed in).
// pdfjs-dist's own validation also requires a literal trailing "/"
// regardless of OS (path.sep would be "\" on Windows and get rejected) —
// Node's fs functions accept forward slashes on Windows fine either way.
// Recent pdfjs-dist versions moved JBIG2/JPEG2000 decoding into WASM
// modules loaded from the wasmUrl directory; standard (non-embedded) fonts
// come from standardFontDataUrl. Without working paths to both, pages using
// either silently lose that content instead of rendering it, degrading
// summary quality without ever throwing a visible error.
const standardFontDataUrl = path.join(process.cwd(), "node_modules", "pdfjs-dist", "standard_fonts") + "/";
const wasmUrl = path.join(process.cwd(), "node_modules", "pdfjs-dist", "wasm") + "/";
// Same missing-resource-path issue as wasmUrl/standardFontDataUrl above, for
// a third pdfjs resource: some embedded fonts (confirmed hit by real
// Marathi/Devanagari-script documents in this archive) need an external CMap
// to map character codes to glyphs, and without cMapUrl that font's text
// fails to render with "Ensure that the `cMapUrl` API parameter is
// provided." — silently degrading that page's content the same way the
// earlier two gaps did. cMapPacked: true because pdfjs-dist ships these as
// packed binary .bcmap files (confirmed: not plain-text .cmap).
const cMapUrl = path.join(process.cwd(), "node_modules", "pdfjs-dist", "cmaps") + "/";
const cMapPacked = true;

// Renders pages [startPage, endPage] (1-indexed, inclusive) — not always
// "the first N pages". Large documents get split into multiple chunks
// (see lib/summaryProvider.ts's chunking logic) so every page is actually
// seen instead of silently truncating a big file to just its opening pages.
// pdfjs reports problems like the cMapUrl/wasm/font gaps above via its own
// internal warn() (-> console.warn) rather than throwing — the page still
// "succeeds" with that content silently missing, so there was previously no
// way to tell which files were actually affected short of matching up
// timestamps by hand. Capturing console.warn only for the duration of this
// one job and returning what it caught (tagged with the filename by the
// caller below) makes every affected file identifiable after the fact,
// searchable in the persistent session log — this is what was actually
// asked for: "find a way to figure out" which files these hit.
async function renderJob(filePath, startPage, endPage, maxImageBytes) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => {
    warnings.push(args.map(String).join(" "));
    originalWarn(...args);
  };

  try {
    const bytes = fs.readFileSync(filePath);
    const doc = await pdfjsLib.getDocument({ data: new Uint8Array(bytes), standardFontDataUrl, wasmUrl, cMapUrl, cMapPacked }).promise;
    const totalPages = doc.numPages;
    const lastPage = Math.min(endPage, totalPages);

    const pages = [];
    let totalBytes = 0;
    for (let i = startPage; i <= lastPage; i++) {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: 1.5 });
      const canvas = createCanvas(viewport.width, viewport.height);
      const ctx = canvas.getContext("2d");
      await page.render({ canvasContext: ctx, canvas, viewport }).promise;
      const png = canvas.toBuffer("image/png");
      if (totalBytes + png.length > maxImageBytes) break;
      pages.push(png);
      totalBytes += png.length;
    }
    return { totalPages, pagesSent: pages.length, pages, warnings };
  } finally {
    console.warn = originalWarn;
  }
}

parentPort.on("message", async (msg) => {
  const { id, filePath, startPage, endPage, maxImageBytes } = msg;
  try {
    const result = await renderJob(filePath, startPage, endPage, maxImageBytes);
    // Transfer the underlying ArrayBuffers instead of copying — pages are
    // already-encoded PNG bytes, no reason to clone them across the thread
    // boundary when a zero-copy transfer works just as well.
    const buffers = result.pages.map((p) => p.buffer.slice(p.byteOffset, p.byteOffset + p.byteLength));
    parentPort.postMessage(
      { id, ok: true, filePath, totalPages: result.totalPages, pagesSent: result.pagesSent, buffers, warnings: result.warnings },
      buffers
    );
  } catch (err) {
    parentPort.postMessage({ id, ok: false, filePath, error: String(err?.message ?? err) });
  }
});
