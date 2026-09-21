import { NextResponse } from "next/server";
import { stopCrawl } from "@/lib/crawlEngine";
import { getCrawlProgress } from "@/lib/crawlState";

export async function POST() {
  // Fire-and-forget on purpose — a graceful stop can take up to a minute
  // (crawler finishes its current file, saves, exits), and the button
  // shouldn't block waiting for that. Progress/status polling already
  // shows "stopped" once it actually happens.
  stopCrawl().catch((err) => console.error("[api/crawl/stop] stopCrawl failed:", err));
  return NextResponse.json(getCrawlProgress());
}
