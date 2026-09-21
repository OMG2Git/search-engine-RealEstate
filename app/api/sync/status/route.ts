import { NextResponse } from "next/server";
import { getSyncProgress } from "@/lib/syncState";
import { getFirestoreStats } from "@/lib/firestore";

export async function GET() {
  const [progress, firestoreStats] = await Promise.all([getSyncProgress(), getFirestoreStats()]);
  return NextResponse.json({ ...progress, firestore: firestoreStats });
}
