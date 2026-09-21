import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import path from "path";
import fs from "fs";
import readline from "readline";
import {
  startCrawl,
  addCrawlProgress,
  finishCrawl,
  isCrawlRunning,
  isCrawlStopRequested,
  requestCrawlStop,
} from "@/lib/crawlState";

const CRAWLER_DIR = path.join(process.cwd(), "crawler");
// Overridable in case a deployment's venv lives somewhere non-standard, but
// this matches the layout used everywhere else in this project.
const PYTHON_PATH = process.env.CRAWLER_PYTHON_PATH || path.join(CRAWLER_DIR, "venv", "Scripts", "python.exe");
const SCRIPT_PATH = path.join(CRAWLER_DIR, "crawler.py");
// Must match STOP_FLAG_NAME in crawler/crawler.py.
const STOP_FLAG_NAME = ".stop_requested";
// How long to wait for the crawler to notice the flag, finish its current
// file, and exit on its own before giving up and hard-killing it anyway —
// a safety net, not the normal path.
const GRACEFUL_STOP_TIMEOUT_MS = 60_000;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set in .env.local`);
  return value;
}

let currentChild: ChildProcessWithoutNullStreams | null = null;
// Resolves once the currently-running child has actually exited (any way —
// clean finish, graceful stop, or killed) — lets stopCrawl() wait for a
// real graceful exit before falling back to a hard kill, instead of just
// firing kill() immediately.
let currentChildExited: Promise<void> | null = null;
// So stopCrawl() knows where to write the stop-flag file without needing
// its own copy of requireEnv("POOL_DIR") — set right before each spawn.
let currentPoolDir: string | null = null;

// Matches: [123] copied name.ext (0.05 GB) bytes=54321
// The greedy name-capture correctly handles filenames that themselves
// contain parentheses (very common — "Agreement (2).pdf") because the
// "bytes=N" suffix is a unique anchor only the real end of the line has.
const COPY_LINE = /^\[\d+\]\s+copied\s+(.+)\s+\([\d.]+\s*GB\)\s+bytes=(\d+)$/;

function handleStdoutLine(line: string): void {
  console.log("[crawler]", line);
  const m = line.match(COPY_LINE);
  if (m) {
    addCrawlProgress({ name: m[1], sizeBytes: Number(m[2]), at: new Date().toISOString() });
  }
}

function runPython(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(/* turbopackIgnore: true */ PYTHON_PATH, [SCRIPT_PATH, ...args], { cwd: CRAWLER_DIR });
    currentChild = child;
    let resolveExited: () => void;
    currentChildExited = new Promise((r) => {
      resolveExited = r;
    });
    let stdoutBuf = "";
    let stderrBuf = "";

    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      stdoutBuf += line + "\n";
      handleStdoutLine(line);
    });

    child.stderr.on("data", (d) => {
      const text = d.toString();
      stderrBuf += text;
      console.error("[crawler stderr]", text);
    });

    child.on("error", (err) => {
      currentChild = null;
      resolveExited();
      reject(err);
    });

    child.on("close", (code) => {
      currentChild = null;
      resolveExited();
      resolve({ code, stdout: stdoutBuf, stderr: stderrBuf });
    });
  });
}

// Runs in the background — the caller does not await this. Goes straight to
// copying: no separate --count-new / disk-space pre-scan pass first. On a
// large network share, a full pre-scan just to learn a "total remaining"
// count took as long as copying itself, and had to repeat from scratch on
// every restart. The crawler's own mapping-based skip logic already tells
// us what's already done and what's next in a single pass, so we just
// report done-so-far as it happens rather than done-out-of-a-known-total.
// Still a one-shot run (no --watch), so it stops on its own once the pass
// over the source tree completes — safe to trigger from a button.
export async function runCrawlInBackground(): Promise<void> {
  if (isCrawlRunning()) return;
  startCrawl();

  try {
    const sourceDir = requireEnv("SOURCE_DIR");
    const poolDir = requireEnv("POOL_DIR");
    currentPoolDir = poolDir;

    const copyResult = await runPython(["--source", sourceDir, "--pool", poolDir, "--skip-disk-check"]);
    if (isCrawlStopRequested()) return finishCrawl("stopped");

    if (copyResult.code === 0) {
      finishCrawl("done");
    } else {
      finishCrawl("error", copyResult.stderr.slice(-2000) || `crawler exited with code ${copyResult.code}`);
    }
  } catch (err) {
    finishCrawl("error", String((err as Error)?.message ?? err));
  }
}

// Graceful by default: writes a flag file the crawler checks between files
// (crawler.py's stop_requested()) so it can finish its current file, save
// the mapping, and exit cleanly — instead of the old behavior of an
// immediate hard kill, which on Windows gives the crawler zero chance to
// run any of its own cleanup code (Node's child.kill() maps straight to
// TerminateProcess there; confirmed data loss risk, not just theoretical —
// see the mapping/pool-folder mismatch this replaced). Hard-kill is now
// only a last-resort fallback if the crawler doesn't exit on its own
// within GRACEFUL_STOP_TIMEOUT_MS.
export async function stopCrawl(): Promise<void> {
  requestCrawlStop();
  if (!currentChild) return;

  if (!currentPoolDir) {
    // No pool dir on record to write the flag into — shouldn't normally
    // happen, but a stop request must still do *something*.
    currentChild.kill();
    return;
  }

  try {
    fs.writeFileSync(path.join(currentPoolDir, STOP_FLAG_NAME), "");
  } catch (err) {
    console.error("[crawlEngine] failed to write stop flag, falling back to hard kill:", err);
    currentChild.kill();
    return;
  }

  const exited = currentChildExited;
  if (!exited) return;

  const timedOut = await Promise.race([
    exited.then(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), GRACEFUL_STOP_TIMEOUT_MS)),
  ]);

  if (timedOut && currentChild) {
    console.error(
      `[crawlEngine] crawler did not exit within ${GRACEFUL_STOP_TIMEOUT_MS}ms of stop request — hard-killing`
    );
    currentChild.kill();
  }
}
