"""Load/save/append file_mapping.json — the pool folder's index.

Key = pool file name. Value = record with the original source path plus
size/mtime/copied-at bookkeeping. Written atomically so a crash or a
Ctrl-C never leaves a half-written (corrupt) JSON on disk.
"""

import json
import os
import time
from pathlib import Path


def load_mapping(mapping_path: Path) -> dict:
    """Return the mapping dict, or {} if the file doesn't exist yet."""
    if not mapping_path.exists():
        return {}
    with open(mapping_path, "r", encoding="utf-8") as f:
        return json.load(f)


def replace_with_retry(src: Path, dest: Path, attempts: int = 6, base_delay: float = 0.25) -> None:
    """os.replace() with retries for a Windows-specific transient failure.

    On Windows, antivirus/indexing software (Defender, in particular) very
    commonly opens a freshly-written file for a brief scan right after it's
    created — during that window, os.replace() over it fails with
    PermissionError (WinError 5, "Access is denied"), even though nothing
    is actually wrong with the file. It's self-resolving within
    milliseconds to a couple seconds. Confirmed as the real cause of a
    crawl run dying outright (a bare, unretried os.replace() call here was
    caught by the crawler's top-level "unexpected exception" handler and
    treated as fatal, killing an otherwise-healthy 8500+-file run over one
    such hiccup) — see the conversation this was fixed in.
    """
    for attempt in range(attempts):
        try:
            os.replace(src, dest)
            return
        except PermissionError:
            if attempt == attempts - 1:
                raise
            time.sleep(base_delay * (2 ** attempt))


def save_mapping(mapping_path: Path, mapping: dict) -> None:
    """Atomic write: write to a .tmp file, then os.replace() over the real one."""
    tmp_path = mapping_path.with_suffix(mapping_path.suffix + ".tmp")
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(mapping, f, indent=2, ensure_ascii=False)
    replace_with_retry(tmp_path, mapping_path)


def add_entry(mapping: dict, pool_name: str, record: dict) -> None:
    mapping[pool_name] = record


def build_source_index(mapping: dict) -> set:
    """Reverse index of already-copied absolute source paths, for O(1) lookups."""
    return {record["original_path"] for record in mapping.values()}


def is_already_copied(source_index: set, source_path: str) -> bool:
    return source_path in source_index
