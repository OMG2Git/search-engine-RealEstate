"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { formatBytes, formatTime } from "@/lib/format";

interface RecentSyncItem {
  name: string;
  status: "done" | "failed";
  sizeBytes: number;
  at: string;
}

interface SyncStatus {
  running: boolean;
  done: number;
  total: number;
  processed: number;
  failed: number;
  remaining: number;
  bytesProcessed: number;
  stopRequested: boolean;
  recent: RecentSyncItem[];
  firestore: { totalDone: number; totalBytes: number };
}

type Phase = "idle" | "running" | "stopped";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default function SyncSummariesPage() {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [cumulative, setCumulative] = useState({ processed: 0, failed: 0, bytes: 0 });
  const stopRequestedRef = useRef(false);

  const fetchStatus = async () => {
    const res = await fetch("/api/sync/status");
    const data: SyncStatus = await res.json();
    setStatus(data);
    return data;
  };

  useEffect(() => {
    let ignore = false;
    fetch("/api/sync/status")
      .then((res) => res.json())
      .then((data: SyncStatus) => {
        if (!ignore) setStatus(data);
      });
    return () => {
      ignore = true;
    };
  }, []);

  const runOneBatch = async (retryFailed: boolean): Promise<SyncStatus> => {
    await fetch(`/api/sync${retryFailed ? "?retryFailed=true" : ""}`, { method: "POST" });
    while (true) {
      await sleep(1200);
      const data = await fetchStatus();
      if (!data.running) return data;
    }
  };

  const start = async (retryFailed = false) => {
    stopRequestedRef.current = false;
    setPhase("running");
    setCumulative({ processed: 0, failed: 0, bytes: 0 });

    try {
      while (true) {
        const data = await runOneBatch(retryFailed);
        setCumulative((c) => ({
          processed: c.processed + data.processed,
          failed: c.failed + data.failed,
          bytes: c.bytes + data.bytesProcessed,
        }));
        if (stopRequestedRef.current) return setPhase("stopped");
        if (data.remaining <= 0) return setPhase("idle");
        // more work remains, no stop requested — keep going automatically
      }
    } catch {
      setPhase("idle");
    }
  };

  const stop = async () => {
    stopRequestedRef.current = true;
    await fetch("/api/sync/stop", { method: "POST" });
  };

  const isRunning = phase === "running";
  const progressPct = status && status.total > 0 ? Math.round((status.done / status.total) * 100) : 0;

  return (
    <div className="flex flex-col flex-1 items-center bg-zinc-50 font-sans dark:bg-black">
      <main className="flex w-full max-w-3xl flex-col gap-6 px-6 py-12">
        <div className="flex items-center justify-between">
          <div>
            <Link href="/" className="text-sm text-zinc-500 hover:underline dark:text-zinc-400">
              ← Search
            </Link>
            <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">Sync Summaries</h1>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              Summarises and indexes unprocessed pool files with Gemini, one by one.
            </p>
          </div>

          <div className="flex shrink-0 gap-2">
            {isRunning ? (
              <button
                onClick={stop}
                className="rounded-full bg-red-600 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700"
              >
                Stop
              </button>
            ) : (
              <>
                {status && status.firestore.totalDone > 0 && (
                  <button
                    onClick={() => start(true)}
                    className="rounded-full border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                  >
                    Retry failed
                  </button>
                )}
                <button
                  onClick={() => start(false)}
                  className="rounded-full bg-zinc-900 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
                >
                  {phase === "stopped" ? "Resume" : "Sync Now"}
                </button>
              </>
            )}
          </div>
        </div>

        {/* Stat tiles */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile label="Indexed (all-time)" value={status ? status.firestore.totalDone.toLocaleString() : "—"} />
          <StatTile label="Indexed size" value={status ? formatBytes(status.firestore.totalBytes) : "—"} />
          <StatTile
            label="This session"
            value={`${cumulative.processed} done${cumulative.failed ? `, ${cumulative.failed} failed` : ""}`}
          />
          <StatTile label="Processed this session" value={formatBytes(cumulative.bytes)} />
        </div>

        {/* Progress */}
        <div className="flex flex-col gap-2 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-2 font-medium text-zinc-900 dark:text-zinc-50">
              <span
                className={`h-2 w-2 rounded-full ${
                  phase === "running"
                    ? "animate-pulse bg-blue-500"
                    : phase === "stopped"
                      ? "bg-amber-500"
                      : "bg-zinc-300 dark:bg-zinc-600"
                }`}
              />
              {phase === "running" ? "Syncing…" : phase === "stopped" ? "Stopped" : "Idle"}
            </span>
            {status && status.total > 0 && (
              <span className="font-mono text-xs text-zinc-500 dark:text-zinc-400">
                batch: {status.done} / {status.total}
                {status.remaining > 0 ? ` · ${status.remaining} remaining overall` : ""}
              </span>
            )}
          </div>

          {status && status.total > 0 && (
            <div className="h-1.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
              <div className="h-full rounded-full bg-blue-500 transition-all" style={{ width: `${progressPct}%` }} />
            </div>
          )}
        </div>

        {/* Live log — capped window, not endless scroll */}
        <div className="flex flex-col gap-2 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <span className="text-xs font-medium uppercase tracking-wide text-zinc-400">
            Recently synced {status && status.recent.length > 0 && `(last ${status.recent.length})`}
          </span>
          {!status || status.recent.length === 0 ? (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">Nothing synced yet this session.</p>
          ) : (
            <div className="flex max-h-96 flex-col gap-1 overflow-y-auto">
              {status.recent.map((item) => (
                <div
                  key={`${item.name}-${item.at}`}
                  className="flex items-center gap-2 border-b border-zinc-50 py-1.5 text-sm last:border-none dark:border-zinc-800/50"
                >
                  <span className={item.status === "done" ? "text-emerald-600" : "text-red-500"}>
                    {item.status === "done" ? "✓" : "✕"}
                  </span>
                  <span className="flex-1 truncate text-zinc-700 dark:text-zinc-300">{item.name}</span>
                  <span className="shrink-0 font-mono text-xs text-zinc-400">{formatBytes(item.sizeBytes)}</span>
                  <span className="shrink-0 font-mono text-xs text-zinc-400">{formatTime(item.at)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
      <span className="text-xs text-zinc-400">{label}</span>
      <span className="font-mono text-lg font-semibold text-zinc-900 dark:text-zinc-50">{value}</span>
    </div>
  );
}
