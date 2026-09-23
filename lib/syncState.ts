export interface RecentSyncItem {
  name: string;
  status: "done" | "failed";
  sizeBytes: number;
  at: string; // ISO timestamp
}

export interface SyncProgress {
  running: boolean;
  done: number;
  total: number;
  processed: number;
  failed: number;
  remaining: number;
  bytesProcessed: number;
  stopRequested: boolean;
  recent: RecentSyncItem[]; // most recent first, capped
}

const RECENT_LIMIT = 15;

const state: SyncProgress = {
  running: false,
  done: 0,
  total: 0,
  processed: 0,
  failed: 0,
  remaining: 0,
  bytesProcessed: 0,
  stopRequested: false,
  recent: [],
};

export function getSyncProgress(): SyncProgress {
  return { ...state, recent: [...state.recent] };
}

export function isSyncRunning(): boolean {
  return state.running;
}

// Atomically checks-and-sets "running" in one synchronous step — this is
// what actually prevents two overlapping sync runs, not a separate
// isSyncRunning() check followed later by startSync(). The previous code
// checked isSyncRunning() synchronously but didn't set state.running until
// after `await planSync(...)` (a real Firestore round-trip) — during that
// gap, a second call's isSyncRunning() check also saw `false` and slipped
// through, both then building an overlapping batch from the same stale
// "unprocessed" list. Confirmed as the real cause of real files
// (10038.pdf, 10039.pdf, 10-10-2013.pdf, IMG_0025.JPG, IMG_0028.JPG) each
// getting processed — and billed for — twice. Since this function has no
// await, there's no gap for another call to interleave in.
export function claimSyncRun(): boolean {
  if (state.running) return false;
  state.running = true;
  return true;
}

export function isStopRequested(): boolean {
  return state.stopRequested;
}

export function requestStop(): void {
  state.stopRequested = true;
}

export function startSync(total: number): void {
  state.running = true;
  state.done = 0;
  state.total = total;
  state.processed = 0;
  state.failed = 0;
  state.remaining = 0;
  state.bytesProcessed = 0;
  state.stopRequested = false; // a fresh Sync Now press always starts clean
  state.recent = [];
}

export function incrementSyncProgress(succeeded: boolean, sizeBytes: number): void {
  state.done += 1;
  if (succeeded) state.processed += 1;
  else state.failed += 1;
  state.bytesProcessed += sizeBytes;
}

export function addRecentSyncItem(item: RecentSyncItem): void {
  state.recent = [item, ...state.recent].slice(0, RECENT_LIMIT);
}

export function finishSync(remaining: number): void {
  state.running = false;
  state.remaining = remaining;
}
