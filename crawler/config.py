"""Crawler configuration: SOURCE_DIR, POOL_DIR, ignore rules.

Values come from env vars, with CLI args (parsed in crawler.py) taking
priority over them. Nothing here should be hardcoded per-machine.
"""

import fnmatch
import os
from pathlib import Path

SOURCE_DIR = os.environ.get("SOURCE_DIR", "")
POOL_DIR = os.environ.get("POOL_DIR", "")

# Names/patterns to skip while walking the source tree. Matched against
# the bare filename (not the full path) with fnmatch, so patterns like
# "~$*" and "*.lnk" work as glob patterns.
IGNORE_PATTERNS = [
    ".DS_Store",
    "Thumbs.db",
    "~$*",
    "*.tmp",
    "*.lnk",
]


def is_ignored(name: str) -> bool:
    """True if a file/dir name should be skipped (hidden files included)."""
    if name.startswith("."):
        return True
    return any(fnmatch.fnmatch(name, pattern) for pattern in IGNORE_PATTERNS)


def mapping_file(pool_dir: str) -> Path:
    return Path(pool_dir) / "file_mapping.json"
