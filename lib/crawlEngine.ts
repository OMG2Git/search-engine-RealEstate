import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import path from "path";
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

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set in .env.local`);
  return value;
}

let currentChild: ChildProcessWithoutNullStreams | null = null;

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
      reject(err);
    });

    child.on("close", (code) => {
      currentChild = null;
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

export function stopCrawl(): void {
  requestCrawlStop();
  if (currentChild) {
    // Hard-terminate — Windows has no real signal delivery to a subprocess,
    // so this is the same as a crash. The crawler is already checkpointed
    // and proven safe to resume after abrupt termination (verified at
    // 20,000 files with zero data loss or duplication).
    currentChild.kill();
  }
}
