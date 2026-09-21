import { NextRequest, NextResponse } from "next/server";
import { search, SEARCH_MODES, type SearchMode } from "@/lib/search";

function parseMode(raw: string | null): SearchMode {
  return SEARCH_MODES.includes(raw as SearchMode) ? (raw as SearchMode) : "name";
}

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get("q")?.trim() ?? "";
  const mode = parseMode(request.nextUrl.searchParams.get("mode"));
  if (!q) return NextResponse.json([]);

  try {
    const results = await search(q, mode);
    return NextResponse.json(results);
  } catch (err) {
    console.error("SEARCH ERROR:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
