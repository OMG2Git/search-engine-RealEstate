"""Read-only diagnostic: count files before/after a given last-modified date.

Does not touch, copy, or move anything — just walks the source tree and
reads each file's mtime (a single stat() call already used by the OS).
Use this to decide how much of the source tree is actually worth running
through the summarization pipeline before sizing cost/time for that job.

Usage:
    python check_age.py --source "\\\\192.168.10.15\\Land Dept" --threshold 2020-06-10
"""

import argparse
import os
import sys
import time
from datetime import datetime
from pathlib import Path

import config

HEARTBEAT_EVERY = 5000  # print progress every N files scanned


def to_long_path(path_str: str) -> str:
    """Same \\\\?\\ / \\\\?\\UNC\\ prefixing as crawler.py — needed so a stat()
    call doesn't fail with WinError 3 on paths beyond the 260-char limit."""
    if os.name != "nt" or path_str.startswith("\\\\?\\"):
        return path_str
    if path_str.startswith("\\\\"):
        return "\\\\?\\UNC\\" + path_str[2:]
    return "\\\\?\\" + path_str


def walk_source(source_dir: str):
    for root, dirs, files in os.walk(source_dir):
        dirs[:] = [d for d in dirs if not config.is_ignored(d)]
        for name in files:
            if config.is_ignored(name):
                continue
            yield os.path.abspath(os.path.join(root, name))


def fmt_gb(num_bytes: int) -> str:
    return f"{num_bytes / (1024 ** 3):.2f} GB"


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
    except AttributeError:
        pass

    parser = argparse.ArgumentParser(description="Count files before/after a last-modified threshold date.")
    parser.add_argument("--source", default=config.SOURCE_DIR, help="Source directory to scan.")
    parser.add_argument("--threshold", required=True, help="Threshold date, format YYYY-MM-DD (e.g. 2020-06-10).")
    args = parser.parse_args()

    if not args.source:
        print("Error: --source is required (or set SOURCE_DIR env var).")
        sys.exit(1)

    source_dir = str(Path(args.source).resolve())
    if not Path(source_dir).is_dir():
        print(f"Error: source directory does not exist: {source_dir}")
        sys.exit(1)

    try:
        threshold_date = datetime.strptime(args.threshold, "%Y-%m-%d")
    except ValueError:
        print("Error: --threshold must be in YYYY-MM-DD format, e.g. 2020-06-10")
        sys.exit(1)
    threshold_ts = threshold_date.timestamp()

    print(f"Scanning {source_dir}")
    print(f"Threshold (last-modified): {args.threshold} — files modified BEFORE this go in 'before', on/after go in 'after'.\n")

    before_count = before_bytes = 0
    after_count = after_bytes = 0
    error_count = 0
    scanned = 0
    start_time = time.time()

    for source_path in walk_source(source_dir):
        scanned += 1
        try:
            st = os.stat(to_long_path(source_path))
        except OSError as exc:
            error_count += 1
            print(f"[error] {source_path}: {exc}")
            continue

        if st.st_mtime < threshold_ts:
            before_count += 1
            before_bytes += st.st_size
        else:
            after_count += 1
            after_bytes += st.st_size

        if scanned % HEARTBEAT_EVERY == 0:
            elapsed = time.time() - start_time
            rate = scanned / elapsed if elapsed > 0 else 0
            print(
                f"[scanning] {scanned} files so far — {rate:.0f} files/s "
                f"| before={before_count} after={after_count}"
            )

    elapsed = time.time() - start_time
    print(f"\nDone in {elapsed / 3600:.2f} hours ({scanned} files scanned, {error_count} unreadable).\n")
    print(f"Before {args.threshold}: {before_count} files ({fmt_gb(before_bytes)})")
    print(f"After  {args.threshold}: {after_count} files ({fmt_gb(after_bytes)})")
    print(f"\nTotal: {before_count + after_count} files ({fmt_gb(before_bytes + after_bytes)})")


if __name__ == "__main__":
    main()
