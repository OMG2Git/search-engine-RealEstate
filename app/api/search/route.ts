import { NextRequest, NextResponse } from "next/server";
import { search } from "@/lib/search";

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get("q")?.trim() ?? "";
  if (!q) return NextResponse.json([]);

  try {
    const results = await search(q);
    return NextResponse.json(results);
  } catch (err) {
    console.error("SEARCH ERROR:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
