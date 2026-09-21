import { NextResponse } from "next/server";
import { getCrawlProgress } from "@/lib/crawlState";
import { getPoolStats } from "@/lib/pool";

export async function GET() {
  return NextResponse.json({ ...getCrawlProgress(), pool: getPoolStats() });
}
