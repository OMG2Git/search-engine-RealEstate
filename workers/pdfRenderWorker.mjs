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
const workerPath = path.join(process.cwd(), "node_modules", "pdfjs-dist", "legacy", "build", "pdf.worker.mjs");
pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).href;
const standardFontDataUrl = pathToFileURL(
  path.join(process.cwd(), "node_modules", "pdfjs-dist", "standard_fonts") + path.sep
).href;
// Recent pdfjs-dist versions moved JBIG2/JPEG2000 decoding into WASM
// modules loaded from this directory. Without it, both the WASM path AND
// its JS fallback fail (the fallback has a bug building its module path by
// string concatenation, producing a literal "null..." prefix) — pages
// using JBIG2 compression (very common in old scanned black-and-white
// documents) then silently have that image content dropped instead of
// rendered, degrading summary quality without ever throwing an error.
const wasmUrl = pathToFileURL(
  path.join(process.cwd(), "node_modules", "pdfjs-dist", "wasm") + path.sep
).href;

// Renders pages [startPage, endPage] (1-indexed, inclusive) — not always
// "the first N pages". Large documents get split into multiple chunks
// (see lib/summaryProvider.ts's chunking logic) so every page is actually
// seen instead of silently truncating a big file to just its opening pages.
async function renderJob(filePath, startPage, endPage, maxImageBytes) {
  const bytes = fs.readFileSync(filePath);
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(bytes), standardFontDataUrl, wasmUrl }).promise;
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
  return { totalPages, pagesSent: pages.length, pages };
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
      { id, ok: true, totalPages: result.totalPages, pagesSent: result.pagesSent, buffers },
      buffers
    );
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: String(err?.message ?? err) });
  }
});
