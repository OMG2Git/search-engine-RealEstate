"""Load/save/append file_mapping.json — the pool folder's index.

Key = pool file name. Value = record with the original source path plus
size/mtime/copied-at bookkeeping. Written atomically so a crash or a
Ctrl-C never leaves a half-written (corrupt) JSON on disk.
"""

import json
import os
from pathlib import Path


def load_mapping(mapping_path: Path) -> dict:
    """Return the mapping dict, or {} if the file doesn't exist yet."""
    if not mapping_path.exists():
        return {}
    with open(mapping_path, "r", encoding="utf-8") as f:
        return json.load(f)


def save_mapping(mapping_path: Path, mapping: dict) -> None:
    """Atomic write: write to a .tmp file, then os.replace() over the real one."""
    tmp_path = mapping_path.with_suffix(mapping_path.suffix + ".tmp")
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(mapping, f, indent=2, ensure_ascii=False)
    os.replace(tmp_path, mapping_path)


def add_entry(mapping: dict, pool_name: str, record: dict) -> None:
    mapping[pool_name] = record


def build_source_index(mapping: dict) -> set:
    """Reverse index of already-copied absolute source paths, for O(1) lookups."""
    return {record["original_path"] for record in mapping.values()}


def is_already_copied(source_index: set, source_path: str) -> bool:
    return source_path in source_index
