#!/usr/bin/env python3
"""Crash-safe JSON persistence for performance-run evidence files."""

from __future__ import annotations

import json
import os
import uuid
from pathlib import Path
from typing import Any


def _sync_parent_directory(path: Path) -> None:
    """Best-effort directory sync after replace (not supported on Windows)."""
    flags = getattr(os, "O_RDONLY", 0)
    if hasattr(os, "O_DIRECTORY"):
        flags |= os.O_DIRECTORY
    try:
        descriptor = os.open(path, flags)
    except (OSError, TypeError):
        return
    try:
        os.fsync(descriptor)
    except OSError:
        pass
    finally:
        os.close(descriptor)


def atomic_write_json(path: Path, value: Any) -> None:
    """Write JSON through a same-directory temp file and atomically replace it.

    The previous target stays intact until the complete UTF-8 payload has been
    flushed and fsynced.  Any write/replace failure removes this attempt's temp
    file without touching the last valid target.
    """
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temp_path = target.with_name(
        f".{target.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp"
    )
    try:
        with temp_path.open("x", encoding="utf-8", newline="\n") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, target)
        _sync_parent_directory(target.parent)
    finally:
        try:
            temp_path.unlink()
        except FileNotFoundError:
            pass
