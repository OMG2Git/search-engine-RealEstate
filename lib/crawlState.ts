export interface RecentCrawlItem {
  name: string;
  sizeBytes: number;
  at: string; // ISO timestamp
}

// No "counting" phase — pre-scanning a 700GB network share just to learn a
// total remaining count cost as much time as the copy itself, and had to be
// repeated in full on every restart. We now go straight to copying and just
// report what has actually happened so far (done count, bytes copied), not
// a remaining/total figure that would require a second full tree walk.
export type CrawlPhase = "idle" | "copying" | "done" | "stopped" | "error";

export interface CrawlProgress {
  running: boolean;
  phase: CrawlPhase;
  done: number; // files copied so far this run
  bytesCopied: number;
  stopRequested: boolean;
  recent: RecentCrawlItem[]; // most recent first, capped
  errorMessage?: string;
}

const RECENT_LIMIT = 15;

const state: CrawlProgress = {
  running: false,
  phase: "idle",
  done: 0,
  bytesCopied: 0,
  stopRequested: false,
  recent: [],
};

export function getCrawlProgress(): CrawlProgress {
  return { ...state, recent: [...state.recent] };
}

export function isCrawlRunning(): boolean {
  return state.running;
}

export function isCrawlStopRequested(): boolean {
  return state.stopRequested;
}

export function requestCrawlStop(): void {
  state.stopRequested = true;
}

export function startCrawl(): void {
  state.running = true;
  state.phase = "copying";
  state.done = 0;
  state.bytesCopied = 0;
  state.stopRequested = false;
  state.recent = [];
  state.errorMessage = undefined;
}

export function addCrawlProgress(item: RecentCrawlItem): void {
  state.done += 1;
  state.bytesCopied += item.sizeBytes;
  state.recent = [item, ...state.recent].slice(0, RECENT_LIMIT);
}

export function finishCrawl(phase: "done" | "stopped" | "error", errorMessage?: string): void {
  state.running = false;
  state.phase = phase;
  state.errorMessage = errorMessage;
}
