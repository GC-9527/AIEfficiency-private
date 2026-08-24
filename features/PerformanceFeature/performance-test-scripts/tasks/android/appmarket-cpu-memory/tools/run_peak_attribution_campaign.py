#!/usr/bin/env python3
"""Run a repeatable AppMarket CPU/PSS campaign and preserve environment evidence.

The existing task runner remains the source of truth for every individual run.
This wrapper only repeats it, captures before/after thermal state, validates the
required artifacts, and writes a campaign-level manifest. It deliberately does
not record the screen so the video encoder does not become part of the measured
CPU and memory load.
"""

from __future__ import annotations

import argparse
import json
import re
import statistics
import subprocess
import sys
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Sequence


PACKAGE = "com.appmarket.automotive"
ARTIFACT_RE = re.compile(r"^ARTIFACT_DIR=(.+)$", re.MULTILINE)


def find_repo_root(start: Path) -> Path:
    for candidate in (start, *start.parents):
        if (candidate / ".git").exists():
            return candidate
    raise RuntimeError(f"repository root not found from {start}")


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)


def run_text(command: Sequence[str], timeout: float = 30.0) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        list(command),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        check=False,
    )


def adb_text(adb: str, serial: str, *args: str, timeout: float = 30.0) -> str:
    completed = run_text([adb, "-s", serial, *args], timeout=timeout)
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout).strip()
        raise RuntimeError(f"adb {' '.join(args)} failed: {detail}")
    return completed.stdout.strip()


def parse_thermal(raw: str) -> list[dict[str, Any]]:
    sensors: list[dict[str, Any]] = []
    for line in raw.splitlines():
        parts = line.strip().split("|", 1)
        if len(parts) != 2:
            continue
        name, value_text = parts
        try:
            raw_value = float(value_text)
        except ValueError:
            continue
        # Android kernels commonly expose milli-Celsius. Some vendor zones use
        # deci-Celsius or Celsius, so preserve the raw value and only normalize
        # values whose scale is unambiguous.
        celsius = raw_value / 1000.0 if abs(raw_value) >= 1000 else raw_value
        sensors.append({"name": name, "raw": raw_value, "celsius": round(celsius, 3)})
    return sensors


def capture_device_state(adb: str, serial: str) -> dict[str, Any]:
    thermal_script = (
        'for z in /sys/class/thermal/thermal_zone*; do '
        '[ -r "$z/type" ] || continue; '
        'printf "%s|%s\\n" "$(cat "$z/type")" "$(cat "$z/temp")"; done'
    )
    raw_thermal = adb_text(adb, serial, "shell", thermal_script, timeout=30.0)
    battery = adb_text(adb, serial, "shell", "dumpsys battery", timeout=30.0)
    state = {
        "captured_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "serial": serial,
        "model": adb_text(adb, serial, "shell", "getprop ro.product.model"),
        "build_type": adb_text(adb, serial, "shell", "getprop ro.build.type"),
        "cpu_online": adb_text(adb, serial, "shell", "cat /sys/devices/system/cpu/online"),
        "thermal": parse_thermal(raw_thermal),
        "thermal_raw": raw_thermal,
        "battery_raw": battery,
    }
    candidates = [
        sensor for sensor in state["thermal"]
        if any(token in sensor["name"].lower() for token in ("cpu", "soc", "cluster", "ap"))
    ]
    if candidates:
        state["cpu_thermal_max_c"] = max(sensor["celsius"] for sensor in candidates)
    return state


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"expected JSON object: {path}")
    return value


def metric_value(report: dict[str, Any], metric: str, field: str) -> float | None:
    value = report.get("measurements", {}).get(metric, {}).get(field)
    return float(value) if isinstance(value, (int, float)) else None


def summarize_round(
    index: int,
    return_code: int,
    artifact_dir: Path | None,
    repo_root: Path,
    thermal_before: dict[str, Any],
    thermal_after: dict[str, Any],
) -> dict[str, Any]:
    summary: dict[str, Any] = {
        "index": index,
        "runner_exit_code": return_code,
        "artifact_dir": (
            artifact_dir.relative_to(repo_root).as_posix()
            if artifact_dir is not None and artifact_dir.is_relative_to(repo_root)
            else str(artifact_dir or "")
        ),
        "thermal_before": thermal_before,
        "thermal_after": thermal_after,
    }
    if artifact_dir is None:
        summary["validation"] = "artifact_dir_missing"
        return summary
    manifest_path = artifact_dir / "run_manifest.json"
    report_path = artifact_dir / "analysis" / "report.json"
    metrics_path = artifact_dir / "raw" / "metrics.csv"
    flow_path = artifact_dir / "flow" / "flow_result.json"
    missing = [
        path.name for path in (manifest_path, report_path, metrics_path, flow_path)
        if not path.is_file()
    ]
    if missing:
        summary["validation"] = "missing_artifacts"
        summary["missing"] = missing
        return summary
    manifest = read_json(manifest_path)
    report = read_json(report_path)
    flow = read_json(flow_path)
    summary.update(
        {
            "validation": "complete",
            "session_id": manifest.get("session_id"),
            "status": manifest.get("status"),
            "acceptance": report.get("acceptance"),
            "sampling_mode": report.get("sampling", {}).get("mode"),
            "actual_rows": report.get("sampling", {}).get("actual_rows"),
            "flow_status": flow.get("status"),
            "download_install_completed": flow.get("download_install_completed"),
            "menus_visited": flow.get("menus_visited", []),
            "cpu_normalized_mean_pct": metric_value(report, "cpu_device_normalized_pct", "mean"),
            "cpu_normalized_peak_pct": metric_value(report, "cpu_device_normalized_pct", "peak"),
            "cpu_multi_core_mean_pct": metric_value(report, "cpu_multi_core_pct", "mean"),
            "cpu_multi_core_peak_pct": metric_value(report, "cpu_multi_core_pct", "peak"),
            "pss_mean_mb": metric_value(report, "pss_mb", "mean"),
            "pss_peak_mb": metric_value(report, "pss_mb", "peak"),
            "rss_mean_mb": metric_value(report, "rss_mb", "mean"),
            "rss_peak_mb": metric_value(report, "rss_mb", "peak"),
        }
    )
    return summary


def stats(values: list[float]) -> dict[str, float | int | None]:
    if not values:
        return {"count": 0, "mean": None, "median": None, "min": None, "max": None}
    return {
        "count": len(values),
        "mean": round(statistics.fmean(values), 4),
        "median": round(statistics.median(values), 4),
        "min": round(min(values), 4),
        "max": round(max(values), 4),
    }


def aggregate(rounds: list[dict[str, Any]]) -> dict[str, Any]:
    complete = [item for item in rounds if item.get("validation") == "complete"]
    metric_fields = (
        "cpu_normalized_mean_pct",
        "cpu_normalized_peak_pct",
        "cpu_multi_core_mean_pct",
        "cpu_multi_core_peak_pct",
        "pss_mean_mb",
        "pss_peak_mb",
        "rss_mean_mb",
        "rss_peak_mb",
    )
    return {
        "requested_rounds": len(rounds),
        "complete_rounds": len(complete),
        "full_flow_rounds": sum(item.get("flow_status") == "completed" for item in complete),
        "download_install_rounds": sum(bool(item.get("download_install_completed")) for item in complete),
        "acceptance_counts": {
            name: sum(item.get("acceptance") == name for item in complete)
            for name in ("PASS", "FAIL", "PARTIAL", "BLOCKED")
        },
        "metrics": {
            field: stats(
                [float(item[field]) for item in complete if isinstance(item.get(field), (int, float))]
            )
            for field in metric_fields
        },
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run a repeatable 10-round AppMarket peak campaign")
    parser.add_argument("--adb", default="adb")
    parser.add_argument("--serial", required=True)
    parser.add_argument("--rounds", type=int, default=10)
    parser.add_argument("--duration", type=float, default=180.0)
    parser.add_argument("--interval", type=float, default=5.0)
    parser.add_argument("--sampling-mode", choices=("standard", "realtime"), default="realtime")
    parser.add_argument("--cooldown", type=float, default=15.0)
    parser.add_argument("--test-app-title", default="")
    parser.add_argument("--gateway", default="http://127.0.0.1:3001")
    parser.add_argument("--out-dir", type=Path, default=None)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    if args.rounds < 1 or args.rounds > 50:
        raise SystemExit("--rounds must be between 1 and 50")
    if args.duration <= 0 or args.interval <= 0 or args.cooldown < 0:
        raise SystemExit("duration/interval must be positive and cooldown non-negative")

    script = Path(__file__).resolve()
    repo_root = find_repo_root(script)
    task_root = script.parent.parent
    runner = task_root / "runner.py"
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    campaign_id = str(uuid.uuid4())
    out_dir = (args.out_dir or (
        repo_root / "docs" / "tempFiles" / "appmarket-peak-analysis"
        / f"campaign_{stamp}_{campaign_id[:8]}"
    )).resolve()
    formal_root = out_dir / "formal_runs"
    log_dir = out_dir / "control"
    formal_root.mkdir(parents=True, exist_ok=True)
    log_dir.mkdir(parents=True, exist_ok=True)

    root_result = run_text([args.adb, "-s", args.serial, "root"], timeout=30.0)
    if root_result.returncode != 0:
        raise SystemExit(f"adb root failed: {(root_result.stderr or root_result.stdout).strip()}")
    adb_text(args.adb, args.serial, "wait-for-device", timeout=30.0)
    installed = adb_text(args.adb, args.serial, "shell", f"pm path {PACKAGE}")
    if not installed.startswith("package:"):
        raise SystemExit(f"{PACKAGE} is not installed on {args.serial}")

    campaign: dict[str, Any] = {
        "schema_version": 1,
        "campaign_id": campaign_id,
        "started_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "status": "running",
        "serial": args.serial,
        "package": PACKAGE,
        "settings": {
            "rounds": args.rounds,
            "duration_s": args.duration,
            "interval_s": args.interval,
            "sampling_mode": args.sampling_mode,
            "flow_mode": "full",
            "capture_screenrecord": False,
            "cooldown_s": args.cooldown,
            "test_app_title": args.test_app_title,
        },
        "rounds": [],
    }
    manifest_path = out_dir / "campaign_manifest.json"
    write_json(manifest_path, campaign)
    print(f"CAMPAIGN_DIR={out_dir.relative_to(repo_root).as_posix()}", flush=True)

    for index in range(1, args.rounds + 1):
        print(f"[campaign] round {index}/{args.rounds} preparing", flush=True)
        before = capture_device_state(args.adb, args.serial)
        run_id = f"peak-{campaign_id[:8]}-r{index:02d}"
        command = [
            sys.executable,
            str(runner),
            "--non-interactive",
            "--adb", args.adb,
            "--serial", args.serial,
            "--package", PACKAGE,
            "--duration", f"{args.duration:g}",
            "--interval", f"{args.interval:g}",
            "--sampling-mode", args.sampling_mode,
            "--flow-mode", "full",
            "--out-root", str(formal_root),
            "--run-id", run_id,
            "--gateway", args.gateway,
        ]
        if args.test_app_title:
            command += ["--test-app-title", args.test_app_title]
        started = time.monotonic()
        completed = run_text(command, timeout=args.duration + 300.0)
        elapsed = time.monotonic() - started
        combined = completed.stdout + ("\n--- STDERR ---\n" + completed.stderr if completed.stderr else "")
        log_path = log_dir / f"round_{index:02d}.runner.log"
        log_path.write_text(combined, encoding="utf-8")
        matches = ARTIFACT_RE.findall(completed.stdout)
        artifact_dir: Path | None = None
        if matches:
            candidate = Path(matches[-1].strip())
            artifact_dir = candidate if candidate.is_absolute() else (repo_root / candidate).resolve()
        after = capture_device_state(args.adb, args.serial)
        round_summary = summarize_round(
            index,
            completed.returncode,
            artifact_dir,
            repo_root,
            before,
            after,
        )
        round_summary["elapsed_s"] = round(elapsed, 3)
        round_summary["runner_log"] = log_path.relative_to(repo_root).as_posix()
        campaign["rounds"].append(round_summary)
        campaign["aggregate"] = aggregate(campaign["rounds"])
        write_json(manifest_path, campaign)
        print(
            "[campaign] round "
            f"{index}/{args.rounds} exit={completed.returncode} "
            f"validation={round_summary.get('validation')} "
            f"flow={round_summary.get('flow_status')} "
            f"cpu_peak={round_summary.get('cpu_normalized_peak_pct')}% "
            f"pss_peak={round_summary.get('pss_peak_mb')}MiB",
            flush=True,
        )
        if index < args.rounds and args.cooldown:
            print(f"[campaign] cooldown {args.cooldown:g}s", flush=True)
            time.sleep(args.cooldown)

    campaign["status"] = "completed"
    campaign["completed_at"] = datetime.now().astimezone().isoformat(timespec="seconds")
    campaign["aggregate"] = aggregate(campaign["rounds"])
    write_json(manifest_path, campaign)
    print(f"CAMPAIGN_MANIFEST={manifest_path.relative_to(repo_root).as_posix()}", flush=True)
    return 0 if campaign["aggregate"]["complete_rounds"] == args.rounds else 1


if __name__ == "__main__":
    raise SystemExit(main())
