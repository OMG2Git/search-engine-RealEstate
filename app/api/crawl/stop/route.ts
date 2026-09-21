import { NextResponse } from "next/server";
import { stopCrawl } from "@/lib/crawlEngine";
import { getCrawlProgress } from "@/lib/crawlState";

export async function POST() {
  stopCrawl();
  return NextResponse.json(getCrawlProgress());
}
