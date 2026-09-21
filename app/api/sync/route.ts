import { NextRequest, NextResponse } from "next/server";
import { runSyncInBackground } from "@/lib/syncEngine";
import { getSyncProgress, isSyncRunning } from "@/lib/syncState";

export async function POST(request: NextRequest) {
  const retryFailed = request.nextUrl.searchParams.get("retryFailed") === "true";

  if (isSyncRunning()) {
    return NextResponse.json({ started: false, alreadyRunning: true, ...getSyncProgress() });
  }

  // Fire and forget: do not await. Large syncs can take many minutes, and
  // holding the HTTP response open that long risks the request timing out.
  // The client tracks progress via GET /api/sync/status instead.
  void runSyncInBackground(retryFailed);

  return NextResponse.json({ started: true, alreadyRunning: false });
}
