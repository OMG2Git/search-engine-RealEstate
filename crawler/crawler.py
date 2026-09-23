"""Document crawler: flattens a nested source tree into a flat pool folder.

Usage:
    python crawler.py --source ./test_source --pool ./test_pool
    python crawler.py --source ./test_source --pool ./test_pool --watch

The crawler only ever copies. It never moves, never deletes, and never
writes into the source tree.
"""

import argparse
import hashlib
import os
import re
import shutil
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import config
import mapping as mapping_mod

ERROR_LOG = "errors.log"
STOP_FLAG_NAME = ".stop_requested"  # graceful-stop signal file, see stop_requested() below
SAVE_EVERY = 10  # checkpoint interval — how many copied files between mapping saves / progress prints
# Deliberately low: on Windows, the app's Stop button hard-kills this
# process (Node's child.kill() maps to TerminateProcess on Windows, giving
# this code zero chance to run its own cleanup/finally block). The mapping
# only ever gets saved at a checkpoint or a clean finish, so this interval
# is the real ceiling on how many already-copied files could go unrecorded
# if Stop is pressed mid-run. Lower = less to lose per hard-kill, at the
# cost of rewriting the whole mapping file more often — 10 is a reasonable
# balance for a run with hundreds of thousands of files.
MAX_STEM_LEN = 180 - 40  # leave room for "__<hash>" + extension


def fmt_gb(num_bytes: int) -> str:
    return f"{num_bytes / (1024 ** 3):.2f} GB"


def fmt_rate(num_bytes: int, elapsed_seconds: float) -> str:
    if elapsed_seconds <= 0:
        return "-- MB/s"
    mb_per_s = (num_bytes / (1024 ** 2)) / elapsed_seconds
    return f"{mb_per_s:.1f} MB/s"


def to_long_path(path_str: str) -> str:
    """Prefix with \\\\?\\ (or \\\\?\\UNC\\ for network shares) so Windows file
    APIs accept paths beyond the classic 260-char MAX_PATH limit. Only used
    right at each actual file-I/O call — everything else (walking, relative
    path display, mapping keys) keeps working with plain paths unchanged."""
    if os.name != "nt" or path_str.startswith("\\\\?\\"):
        return path_str
    if path_str.startswith("\\\\"):
        return "\\\\?\\UNC\\" + path_str[2:]
    return "\\\\?\\" + path_str


def stop_requested(pool_dir: Path) -> bool:
    """Graceful-stop signal, checked once per file in the main copy loop.

    On Windows the app's Stop button can't send a real signal a Python
    process can catch (Node's child.kill() is a hard TerminateProcess with
    zero chance to run cleanup code) — a plain flag file is a simple,
    reliable, cross-platform way to ask this process to finish its current
    file, save the mapping, and exit cleanly instead of being killed
    mid-write. Node writes the file to request a stop and waits (with a
    timeout) for this process to exit on its own before falling back to a
    hard kill.
    """
    return (pool_dir / STOP_FLAG_NAME).exists()


def log_error(path: str, reason: str) -> None:
    with open(ERROR_LOG, "a", encoding="utf-8") as f:
        f.write(f"{datetime.now().isoformat()}\t{path}\t{reason}\n")


def sanitise_stem(stem: str) -> str:
    """Strip characters illegal on Windows/most filesystems, cap length."""
    stem = re.sub(r'[<>:"/\\|?*]', "_", stem).strip()
    if not stem:
        stem = "file"
    return stem[:MAX_STEM_LEN]


def walk_source(source_dir: str):
    """os.walk SOURCE_DIR, skip ignored names, yield absolute file paths."""
    for root, dirs, files in os.walk(source_dir):
        dirs[:] = [d for d in dirs if not config.is_ignored(d)]
        for name in files:
            if config.is_ignored(name):
                continue
            yield os.path.abspath(os.path.join(root, name))


def resolve_pool_name(original_name: str, source_path: str, taken_names: set) -> str:
    """Return a pool-folder-safe, collision-free name for this source file.

    Deterministic: the same source_path always produces the same pool name,
    which is what makes resuming a crawl and dedupe possible.
    """
    stem = sanitise_stem(Path(original_name).stem)
    ext = Path(original_name).suffix
    candidate = f"{stem}{ext}"
    if candidate not in taken_names:
        return candidate
    digest = hashlib.md5(source_path.encode("utf-8")).hexdigest()[:8]
    return f"{stem}__{digest}{ext}"


def copy_file(src: str, dest: Path) -> None:
    """Copy to dest.part then rename, so a crash never leaves a half-file.
    The rename retries transient Windows "Access is denied" failures (see
    mapping.replace_with_retry) — real archive runs at high write volume hit
    this regularly (54 files in one 8500-file run before this fix), each one
    previously a silently-dropped file rather than an actually-copied one.
    """
    part_path = dest.with_name(dest.name + ".part")
    shutil.copy2(to_long_path(src), to_long_path(str(part_path)))
    mapping_mod.replace_with_retry(to_long_path(str(part_path)), to_long_path(str(dest)))


def relative_original_path(source_path: str, source_dir: str) -> str:
    """Original path shown in results: SourceDirName/.../file.ext (forward slashes, any OS)."""
    rel = Path(source_dir).name / Path(source_path).relative_to(source_dir)
    return rel.as_posix()


def build_record(source_path: str, original_name: str, source_dir: str) -> dict:
    st = os.stat(to_long_path(source_path))
    return {
        "original_path": relative_original_path(source_path, source_dir),
        "original_name": original_name,
        "size_bytes": st.st_size,
        "modified_at": datetime.fromtimestamp(st.st_mtime).isoformat(),
        "copied_at": datetime.now(timezone.utc).isoformat(),
    }


def process_one_file(source_path: str, source_dir: str, pool_dir: Path, mapping: dict, taken_names: set) -> str:
    """Copy one source file into the pool and record it. Returns the pool name."""
    original_name = os.path.basename(source_path)
    pool_name = resolve_pool_name(original_name, source_path, taken_names)
    dest = pool_dir / pool_name
    try:
        copy_file(source_path, dest)
    except Exception:
        # Claim this name even though the copy failed. Without this, a
        # DIFFERENT source file that happens to share the same original
        # filename — very common in this archive, generic scan names like
        # "pg.no.7.pdf" recur across dozens of unrelated folders — would
        # resolve to this exact same pool name next and try to write
        # through the exact same stuck .part file, failing identically.
        # Confirmed as the real cause of a burst of repeated failures all
        # sharing a handful of generic filenames across unrelated folders,
        # not independent bad luck on 80+ different files. A later resume
        # rebuilds taken_names from scratch (mapping.keys() only, since this
        # file never made it into the mapping), so the original source file
        # still gets to retry the plain name once whatever's blocking it
        # clears.
        taken_names.add(pool_name)
        # Best-effort cleanup of the stray .part file: if this process's
        # own half-written leftover is what's actually blocking later
        # attempts (rather than an external lock), removing it stops it
        # from also blocking every other same-named file for the rest of
        # this run. If something else genuinely has it locked, this quietly
        # fails too, which is fine — nothing worse happens either way.
        part_path = dest.with_name(dest.name + ".part")
        try:
            os.remove(to_long_path(str(part_path)))
        except OSError:
            pass
        raise
    record = build_record(source_path, original_name, source_dir)
    mapping_mod.add_entry(mapping, pool_name, record)
    taken_names.add(pool_name)
    return pool_name


def dry_run(source_dir: str) -> None:
    """Report total file count and size without copying anything."""
    total_files = 0
    total_bytes = 0
    for source_path in walk_source(source_dir):
        try:
            total_bytes += os.path.getsize(to_long_path(source_path))
            total_files += 1
        except OSError as exc:
            print(f"[error] {source_path}: {exc}")
    gb = total_bytes / (1024 ** 3)
    print(f"\nDry run complete. {total_files} files, {gb:.2f} GB total.")
    print(f"Recommended free space on the pool volume: {gb * 1.1:.2f} GB (10% safety margin).")


def count_new(source_dir: str, pool_dir: Path) -> None:
    """Count files not yet in the mapping, without copying anything. Prints a
    machine-parseable final line so a caller (e.g. the Next.js app spawning
    this as a subprocess) can read an exact "new files remaining" total
    before starting the real copy — same idea as --dry-run, but mapping-aware
    (only counts what's actually new, not the whole source tree)."""
    mapping_path = config.mapping_file(str(pool_dir))
    mapping = mapping_mod.load_mapping(mapping_path)
    source_index = mapping_mod.build_source_index(mapping)

    new_files = 0
    new_bytes = 0
    scanned = 0
    heartbeat_start = time.time()
    for source_path in walk_source(source_dir):
        scanned += 1
        candidate_original_path = relative_original_path(source_path, source_dir)
        if mapping_mod.is_already_copied(source_index, candidate_original_path):
            continue
        try:
            new_bytes += os.path.getsize(to_long_path(source_path))
            new_files += 1
        except OSError as exc:
            print(f"[error] {source_path}: {exc}")

        # A network share can take a long time to fully enumerate/stat before
        # any copying starts. Without this, stdout stays silent the whole
        # time and the UI looks frozen on "counting" — print periodically so
        # it's visibly alive, and roughly how much longer this phase will take.
        if scanned % 2000 == 0:
            elapsed = time.time() - heartbeat_start
            rate = scanned / elapsed if elapsed > 0 else 0
            print(f"[counting] scanned {scanned} files so far ({new_files} new) — {rate:.0f} files/s")

    print(f"NEW_FILES_COUNT:{new_files} NEW_BYTES:{new_bytes}")


def check_disk_space(source_dir: str, pool_dir: Path, new_bytes_hint: int | None = None) -> None:
    """Refuse to start if free space on the pool volume < bytes about to be
    copied * 1.1. When new_bytes_hint is given (the --count-new phase already
    computed it), skip re-walking the whole source tree a second time just
    for this check — on a large network share that redundant walk alone can
    take as long as the counting phase itself."""
    if new_bytes_hint is not None:
        total_bytes = new_bytes_hint
    else:
        total_bytes = 0
        for source_path in walk_source(source_dir):
            try:
                total_bytes += os.path.getsize(to_long_path(source_path))
            except OSError:
                pass

    pool_dir.mkdir(parents=True, exist_ok=True)
    free_bytes = shutil.disk_usage(pool_dir).free
    required_bytes = int(total_bytes * 1.1)

    if free_bytes < required_bytes:
        source_gb = total_bytes / (1024 ** 3)
        free_gb = free_bytes / (1024 ** 3)
        required_gb = required_bytes / (1024 ** 3)
        print(
            f"Error: not enough free space on the pool volume.\n"
            f"  New data to copy: {source_gb:.2f} GB\n"
            f"  Required (with 10% margin): {required_gb:.2f} GB\n"
            f"  Free on pool volume: {free_gb:.2f} GB\n"
            f"Free up space or point --pool at a larger volume, then re-run."
        )
        sys.exit(1)


def initial_crawl(source_dir: str, pool_dir: Path) -> None:
    mapping_path = config.mapping_file(str(pool_dir))
    mapping = mapping_mod.load_mapping(mapping_path)
    source_index = mapping_mod.build_source_index(mapping)
    taken_names = set(mapping.keys())

    pool_dir.mkdir(parents=True, exist_ok=True)

    # Clear any stale flag from a previous run so a fresh run doesn't
    # immediately think it's been asked to stop before it even starts.
    stop_flag_path = pool_dir / STOP_FLAG_NAME
    if stop_flag_path.exists():
        stop_flag_path.unlink()

    already_done = len(mapping)
    bytes_already_done = sum(rec.get("size_bytes", 0) for rec in mapping.values())
    if already_done:
        print(
            f"Resuming: {already_done} files already in the mapping "
            f"({fmt_gb(bytes_already_done)}) — these will be skipped.\n"
        )

    copied = 0
    skipped = 0
    errors = 0
    bytes_copied = 0
    start_time = time.time()
    interrupted = False
    fatal_error = False

    def checkpoint():
        elapsed = time.time() - start_time
        print(
            f"[checkpoint] copied={copied} skipped={skipped} errors={errors} "
            f"| this run: {fmt_gb(bytes_copied)} at {fmt_rate(bytes_copied, elapsed)} "
            f"| pool total: {fmt_gb(bytes_already_done + bytes_copied)}"
        )

    try:
        try:
            for source_path in walk_source(source_dir):
                if stop_requested(pool_dir):
                    interrupted = True
                    print("\nStop requested — saving checkpoint and exiting cleanly.")
                    try:
                        (pool_dir / STOP_FLAG_NAME).unlink()
                    except OSError:
                        pass
                    break

                candidate_original_path = relative_original_path(source_path, source_dir)

                if mapping_mod.is_already_copied(source_index, candidate_original_path):
                    skipped += 1
                    # On a resume, a long run of already-copied files (e.g. the
                    # first tens of thousands of files on every later run)
                    # produces no output at all otherwise — looks identical to a hang.
                    if skipped % 2000 == 0:
                        print(f"[skipping already-copied] {skipped} so far...")
                    continue

                try:
                    file_size = os.path.getsize(to_long_path(source_path))
                    pool_name = process_one_file(source_path, source_dir, pool_dir, mapping, taken_names)
                    source_index.add(candidate_original_path)
                    copied += 1
                    bytes_copied += file_size
                    # bytes=N is a machine-parseable suffix for callers spawning this as a
                    # subprocess (the Next.js "Sync New Files" button) — fmt_gb rounds to
                    # 2 decimals, which loses precision for small files when accumulating
                    # a running total.
                    print(f"[{copied + skipped + errors}] copied {pool_name} ({fmt_gb(file_size)}) bytes={file_size}")
                except Exception as exc:
                    errors += 1
                    log_error(source_path, str(exc))
                    print(f"[error] {source_path}: {exc}")

                if copied % SAVE_EVERY == 0 and copied > 0:
                    mapping_mod.save_mapping(mapping_path, mapping)
                    checkpoint()
        except KeyboardInterrupt:
            interrupted = True
            print("\nStopping (Ctrl+C received)... saving checkpoint, please wait.")
        except Exception as exc:
            # A single unexpected exception here must never cost the mapping
            # entries for everything already copied this run (a real crash
            # once cost 34 copied-but-unrecorded files) — save what we have,
            # then let the process actually exit with a nonzero code so the
            # caller (Next.js) surfaces it as an error instead of silently
            # looking like a clean finish.
            interrupted = True
            fatal_error = True
            print(f"\n[fatal] {exc.__class__.__name__}: {exc}")
    finally:
        mapping_mod.save_mapping(mapping_path, mapping)
        checkpoint()

    if fatal_error:
        print(
            f"\nStopped by an unexpected error. Progress up to this point is saved — "
            f"re-run the exact same command to resume; already-copied files will be skipped automatically."
        )
        sys.exit(1)
    elif interrupted:
        print(
            f"\nStopped early by user. Progress is saved — re-run the exact same command "
            f"to resume from here; already-copied files will be skipped automatically."
        )
        sys.exit(130)  # conventional exit code for SIGINT
    else:
        print(f"\nDone. copied={copied} skipped={skipped} errors={errors} | total copied this run: {fmt_gb(bytes_copied)}")


def wait_until_stable(path: Path, initial_delay: float = 2.0, cap: float = 60.0) -> bool:
    """Wait for a file to stop growing before copying it (debounce writes)."""
    time.sleep(initial_delay)
    deadline = time.time() + cap
    last_size = -1
    stable_count = 0
    while time.time() < deadline:
        if not path.exists():
            return False
        size = path.stat().st_size
        if size == last_size:
            stable_count += 1
            if stable_count >= 2:
                return True
        else:
            stable_count = 0
            last_size = size
        time.sleep(1.0)
    return path.exists()


def make_watch_handler(source_dir: str, pool_dir: Path, mapping: dict, taken_names: set,
                        source_index: set, mapping_path: Path, stats: dict):
    from watchdog.events import FileSystemEventHandler

    class Handler(FileSystemEventHandler):
        def _handle_path(self, path_str: str):
            path = Path(path_str)
            if path.is_dir():
                self._sweep_dir(path)
                return
            if config.is_ignored(path.name):
                return
            if not wait_until_stable(path):
                return
            source_path = str(path.resolve())
            candidate_original_path = relative_original_path(source_path, source_dir)
            if mapping_mod.is_already_copied(source_index, candidate_original_path):
                return
            try:
                file_size = os.path.getsize(to_long_path(source_path))
                pool_name = process_one_file(source_path, source_dir, pool_dir, mapping, taken_names)
                source_index.add(candidate_original_path)
                mapping_mod.save_mapping(mapping_path, mapping)
                stats["copied"] += 1
                stats["bytes"] += file_size
                print(f"[watch] copied {pool_name} ({fmt_gb(file_size)}) <- {source_path}")
            except Exception as exc:
                log_error(source_path, str(exc))
                print(f"[watch][error] {source_path}: {exc}")

        def _sweep_dir(self, dir_path: Path):
            for source_path in walk_source(str(dir_path)):
                self._handle_path(source_path)

        def on_created(self, event):
            if not event.is_directory:
                self._handle_path(event.src_path)
            else:
                self._sweep_dir(Path(event.src_path))

        def on_moved(self, event):
            if not event.is_directory:
                self._handle_path(event.dest_path)
            else:
                self._sweep_dir(Path(event.dest_path))

    return Handler()


HEARTBEAT_SECONDS = 300  # print "still alive" status even when nothing new arrives


def watch(source_dir: str, pool_dir: Path) -> None:
    from watchdog.observers import Observer

    mapping_path = config.mapping_file(str(pool_dir))
    mapping = mapping_mod.load_mapping(mapping_path)
    source_index = mapping_mod.build_source_index(mapping)
    taken_names = set(mapping.keys())

    pool_dir.mkdir(parents=True, exist_ok=True)

    stats = {"copied": 0, "bytes": 0}
    handler = make_watch_handler(source_dir, pool_dir, mapping, taken_names, source_index, mapping_path, stats)
    observer = Observer()
    observer.schedule(handler, source_dir, recursive=True)
    observer.start()
    start_time = time.time()
    print(f"Watching {source_dir} for new files... (Ctrl+C to stop cleanly)")

    try:
        while True:
            time.sleep(HEARTBEAT_SECONDS)
            elapsed_min = (time.time() - start_time) / 60
            print(
                f"[heartbeat] still watching after {elapsed_min:.0f} min "
                f"| {stats['copied']} file(s) copied this session ({fmt_gb(stats['bytes'])})"
            )
    except KeyboardInterrupt:
        print("\nStopping (Ctrl+C received)...")
        observer.stop()
        observer.join()
        mapping_mod.save_mapping(mapping_path, mapping)
        print(
            f"Stopped cleanly. Mapping saved. This session: {stats['copied']} file(s), "
            f"{fmt_gb(stats['bytes'])}. Re-run the same command anytime to resume watching."
        )


def main():
    try:
        # Windows defaults stdout/stderr to the legacy system codepage (e.g.
        # cp1252) when the process is piped (as it is when the Next.js app
        # spawns this), not UTF-8. Real-world filenames from a 15+ year
        # archive routinely contain characters that codepage can't encode
        # (curly quotes, bullets, non-English text) — printing one without
        # this would crash the whole crawl with UnicodeEncodeError.
        sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
        sys.stderr.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
    except AttributeError:
        pass

    parser = argparse.ArgumentParser(description="Document crawler: flatten source tree into pool folder.")
    parser.add_argument("--source", default=config.SOURCE_DIR, help="Source directory to crawl.")
    parser.add_argument("--pool", default=config.POOL_DIR, help="Destination flat pool directory.")
    parser.add_argument("--watch", action="store_true", help="Watch for new files after the initial crawl.")
    parser.add_argument("--dry-run", action="store_true", help="Report file count and total size, copy nothing.")
    parser.add_argument("--count-new", action="store_true",
                         help="Report how many files are new (not yet in the mapping), copy nothing.")
    parser.add_argument("--new-bytes-hint", type=int, default=None,
                         help="Bytes of new data already known from a prior --count-new pass, so the "
                              "disk-space check can skip re-walking the whole source tree.")
    parser.add_argument("--skip-disk-check", action="store_true",
                         help="Skip the pre-copy disk-space check entirely (it requires a full extra "
                              "walk of the source tree when no --new-bytes-hint is given, which on a "
                              "large network share can take as long as the copy itself).")
    args = parser.parse_args()

    if not args.source or not args.pool:
        print("Error: --source and --pool are required (or set SOURCE_DIR / POOL_DIR env vars).")
        sys.exit(1)

    source_dir = str(Path(args.source).resolve())
    pool_dir = Path(args.pool).resolve()

    if not Path(source_dir).is_dir():
        print(f"Error: source directory does not exist: {source_dir}")
        sys.exit(1)

    if args.dry_run:
        dry_run(source_dir)
        return

    if args.count_new:
        count_new(source_dir, pool_dir)
        return

    if not args.skip_disk_check:
        check_disk_space(source_dir, pool_dir, new_bytes_hint=args.new_bytes_hint)
    initial_crawl(source_dir, pool_dir)

    if args.watch:
        watch(source_dir, pool_dir)


if __name__ == "__main__":
    main()
