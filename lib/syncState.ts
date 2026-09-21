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
