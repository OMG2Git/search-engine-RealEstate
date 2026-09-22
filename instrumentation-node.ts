// Only ever imported from instrumentation.ts's Node.js branch — see the
// comment there for why the split exists.
import fs from "fs";
import path from "path";

const logsDir = path.join(process.cwd(), "logs");
fs.mkdirSync(logsDir, { recursive: true });

// One file per calendar day, appended to across every restart that day —
// avoids both an unbounded single file over weeks of use and losing
// history every time the dev server restarts, which happens often during
// active debugging.
const dateStr = new Date().toISOString().slice(0, 10);
const logPath = path.join(logsDir, `${dateStr}.log`);
const fileStream = fs.createWriteStream(logPath, { flags: "a" });

// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_CODES = /\x1b\[[0-9;]*m/g;

// Teeing at the raw stdout/stderr stream level (rather than patching
// console.log/warn/error) is deliberate and was the actual fix here: Next's
// own dev-server request logs ("GET / 200 in 123ms") and Turbopack's
// compile-progress output write directly to these streams, bypassing
// console.* entirely. Patching only console.* was tested first and
// confirmed to silently miss all of that — the single most useful part of
// the output for debugging. Tee-ing the streams instead captures
// literally everything that would ever reach the terminal, console.*
// output included, since console.log/info write through process.stdout
// and console.warn/error through process.stderr under the hood anyway.
function tee(streamName: "stdout" | "stderr"): void {
  const target = process[streamName];
  const original = target.write.bind(target);
  target.write = ((chunk: unknown, ...rest: unknown[]) => {
    const text = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : String(chunk);
    // Strip ANSI color codes for the file copy only — the live terminal
    // still gets the original, colored chunk via `original(...)` below.
    // Left in, the saved file is full of raw escape sequences that make it
    // much harder to read when handed over for debugging later.
    fileStream.write(text.replace(ANSI_ESCAPE_CODES, ""));
    return (original as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof target.write;
}

fileStream.write(`\n=== server started ${new Date().toISOString()} (pid ${process.pid}) ===\n`);
tee("stdout");
tee("stderr");

console.log(`[logging] writing full session log to ${logPath}`);
