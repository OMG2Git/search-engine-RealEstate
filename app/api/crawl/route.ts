import { NextResponse } from "next/server";
import { runCrawlInBackground } from "@/lib/crawlEngine";
import { getCrawlProgress, isCrawlRunning } from "@/lib/crawlState";

export async function POST() {
  if (isCrawlRunning()) {
    return NextResponse.json({ started: false, alreadyRunning: true, ...getCrawlProgress() });
  }

  // Fire and forget — a full crawl over a real source tree can take a long
  // time, so this must not hold the HTTP response open. The client tracks
  // progress via GET /api/crawl/status instead.
  void runCrawlInBackground();

  return NextResponse.json({ started: true, alreadyRunning: false });
}
