import { NextResponse } from "next/server";
import { requestStop, getSyncProgress } from "@/lib/syncState";

export async function POST() {
  requestStop();
  return NextResponse.json(getSyncProgress());
}
