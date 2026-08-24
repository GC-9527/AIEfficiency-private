#!/usr/bin/env python3
"""Managed performance-task entry point for the AppMarket profiler."""

from pathlib import Path
import runpy
import sys


def main() -> None:
    try:
        import reportlab  # noqa: F401 - mandatory PDF report dependency
    except ImportError as exc:
        raise SystemExit(
            "Missing performance report dependency: run "
            "`python -m pip install -r features/PerformanceFeature/"
            "performance-test-scripts/tasks/android/appmarket-cpu-memory/requirements.txt`"
        ) from exc
    package_root = Path(__file__).resolve().parent
    source_dir = package_root / "src"
    target = source_dir / "appmarket_perf_runner.py"
    if not target.is_file():
        raise SystemExit(f"AppMarket performance runner not found: {target}")
    sys.path.insert(0, str(source_dir))
    runpy.run_path(str(target), run_name="__main__")


if __name__ == "__main__":
    main()
