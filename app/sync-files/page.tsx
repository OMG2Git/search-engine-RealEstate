"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { formatBytes, formatTime } from "@/lib/format";

interface RecentCrawlItem {
  name: string;
  sizeBytes: number;
  at: string;
}

type CrawlPhase = "idle" | "copying" | "done" | "stopped" | "error";

interface CrawlStatus {
  running: boolean;
  phase: CrawlPhase;
  done: number;
  bytesCopied: number;
  stopRequested: boolean;
  recent: RecentCrawlItem[];
  errorMessage?: string;
  pool: { totalFiles: number; totalBytes: number };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const PHASE_LABEL: Record<CrawlPhase, string> = {
  idle: "Idle",
  copying: "Copying new files…",
  done: "Up to date",
  stopped: "Stopped",
  error: "Error",
};

export default function SyncFilesPage() {
  const [status, setStatus] = useState<CrawlStatus | null>(null);
  const [polling, setPolling] = useState(false);
  const pollAbort = useRef(false);

  const fetchStatus = async () => {
    const res = await fetch("/api/crawl/status");
    const data: CrawlStatus = await res.json();
    setStatus(data);
    return data;
  };

  useEffect(() => {
    let ignore = false;
    fetch("/api/crawl/status")
      .then((res) => res.json())
      .then((data: CrawlStatus) => {
        if (!ignore) setStatus(data);
      });
    return () => {
      ignore = true;
    };
  }, []);

  const pollUntilIdle = async () => {
    pollAbort.current = false;
    setPolling(true);
    try {
      while (!pollAbort.current) {
        const data = await fetchStatus();
        if (!data.running) break;
        await sleep(1200);
      }
    } finally {
      setPolling(false);
    }
  };

  const start = async () => {
    await fetch("/api/crawl", { method: "POST" });
    pollUntilIdle();
  };

  const stop = async () => {
    pollAbort.current = true;
    await fetch("/api/crawl/stop", { method: "POST" });
    fetchStatus();
  };

  const isRunning = status?.running ?? false;

  return (
    <div className="flex flex-col flex-1 items-center bg-zinc-50 font-sans dark:bg-black">
      <main className="flex w-full max-w-3xl flex-col gap-6 px-6 py-12">
        <div className="flex items-center justify-between">
          <div>
            <Link href="/" className="text-sm text-zinc-500 hover:underline dark:text-zinc-400">
              ← Search
            </Link>
            <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">Sync New Files</h1>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              Finds files in the source folder not yet in the pool, copies them, then stops on its own.
            </p>
          </div>

          {isRunning ? (
            <button
              onClick={stop}
              className="shrink-0 rounded-full bg-red-600 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700"
            >
              Stop
            </button>
          ) : (
            <button
              onClick={start}
              disabled={polling}
              className="shrink-0 rounded-full bg-zinc-900 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
            >
              {status?.phase === "stopped" ? "Resume" : "Sync New Files"}
            </button>
          )}
        </div>

        {/* Stat tiles */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile label="Files in pool" value={status ? status.pool.totalFiles.toLocaleString() : "—"} />
          <StatTile label="Pool size" value={status ? formatBytes(status.pool.totalBytes) : "—"} />
          <StatTile label="Copied this run" value={status ? `${status.done} files` : "—"} />
          <StatTile label="Copied this run (size)" value={status ? formatBytes(status.bytesCopied) : "—"} />
        </div>

        {/* Progress — no known "total remaining": count-first cost as much time on a
            large network share as copying itself, and had to repeat on every restart.
            This shows live throughput of the current run instead of a percentage. */}
        <div className="flex flex-col gap-2 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-2 font-medium text-zinc-900 dark:text-zinc-50">
              <span
                className={`h-2 w-2 rounded-full ${
                  status?.phase === "copying"
                    ? "animate-pulse bg-blue-500"
                    : status?.phase === "stopped"
                      ? "bg-amber-500"
                      : status?.phase === "error"
                        ? "bg-red-500"
                        : "bg-zinc-300 dark:bg-zinc-600"
                }`}
              />
              {status ? PHASE_LABEL[status.phase] : "Loading…"}
            </span>
            {status && status.phase === "copying" && (
              <span className="font-mono text-xs text-zinc-500 dark:text-zinc-400">{status.done} copied so far</span>
            )}
          </div>

          {status?.phase === "copying" && (
            <div className="h-1.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
              <div className="h-full w-full animate-pulse rounded-full bg-blue-500" />
            </div>
          )}

          {status?.errorMessage && (
            <p className="rounded-lg bg-red-50 p-2 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">
              {status.errorMessage}
            </p>
          )}
        </div>

        {/* Live log — capped window, not endless scroll */}
        <div className="flex flex-col gap-2 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <span className="text-xs font-medium uppercase tracking-wide text-zinc-400">
            Recently copied {status && status.recent.length > 0 && `(last ${status.recent.length})`}
          </span>
          {!status || status.recent.length === 0 ? (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">Nothing copied yet this run.</p>
          ) : (
            <div className="flex max-h-96 flex-col gap-1 overflow-y-auto">
              {status.recent.map((item) => (
                <div
                  key={`${item.name}-${item.at}`}
                  className="flex items-center gap-2 border-b border-zinc-50 py-1.5 text-sm last:border-none dark:border-zinc-800/50"
                >
                  <span className="text-emerald-600">✓</span>
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
