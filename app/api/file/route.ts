import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import mammoth from "mammoth";
import * as XLSX from "xlsx";
import { getPoolDir } from "@/lib/pool";

const MIME_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".tiff": "image/tiff",
  ".avif": "image/avif",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".md": "text/markdown",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

// Browsers have no native viewer for these — render them as HTML for inline viewing.
// The real file is still served as-is when ?download=1 is passed.
const HTML_PREVIEWABLE = new Set([".docx", ".xlsx"]);

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function wrapHtml(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
  body { font-family: -apple-system, Segoe UI, Arial, sans-serif; max-width: 900px; margin: 40px auto; padding: 0 20px; line-height: 1.6; color: #1a1a1a; }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; }
  td, th { border: 1px solid #ccc; padding: 4px 8px; font-size: 14px; }
  img { max-width: 100%; }
</style></head>
<body>${bodyHtml}</body></html>`;
}

async function renderPreviewHtml(filePath: string, ext: string, safeName: string): Promise<string> {
  if (ext === ".docx") {
    const { value } = await mammoth.convertToHtml({ path: filePath });
    return wrapHtml(safeName, value);
  }
  const workbook = XLSX.readFile(filePath);
  const sheetsHtml = workbook.SheetNames.map(
    (name) => `<h2>${escapeHtml(name)}</h2>${XLSX.utils.sheet_to_html(workbook.Sheets[name])}`
  ).join("\n");
  return wrapHtml(safeName, sheetsHtml);
}

export async function GET(request: NextRequest) {
  const rawName = request.nextUrl.searchParams.get("name");
  if (!rawName) return NextResponse.json({ error: "missing name" }, { status: 400 });

  const safeName = path.basename(rawName);
  const poolDir = path.resolve(getPoolDir());
  const resolvedPath = path.resolve(poolDir, safeName);

  if (!resolvedPath.startsWith(poolDir + path.sep)) {
    return NextResponse.json({ error: "invalid file name" }, { status: 400 });
  }

  if (!fs.existsSync(resolvedPath)) {
    return NextResponse.json({ error: "file not found" }, { status: 404 });
  }

  const ext = path.extname(safeName).toLowerCase();
  const download = request.nextUrl.searchParams.get("download") === "1";

  if (!download && HTML_PREVIEWABLE.has(ext)) {
    try {
      const html = await renderPreviewHtml(resolvedPath, ext, safeName);
      return new NextResponse(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    } catch {
      // fall through to raw file if conversion fails
    }
  }

  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  const buffer = fs.readFileSync(resolvedPath);
  return new NextResponse(buffer, {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${safeName}"`,
    },
  });
}
