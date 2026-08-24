#!/usr/bin/env python3
"""Capture simpleperf call stacks for one AppMarket workflow phase.

This is a diagnostic replay. Sampling call stacks adds overhead, so its runner
metrics are never eligible for the formal ten-round threshold decision.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import re
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Sequence


PACKAGE = "com.appmarket.automotive"
DEFAULT_RECORD_SECONDS = {"startup": 20.0, "install-manager": 15.0, "privacy": 15.0, "full": 175.0}


def find_repo_root(start: Path) -> Path:
    for candidate in (start, *start.parents):
        if (candidate / ".git").exists():
            return candidate
    raise RuntimeError(f"repository root not found from {start}")


SCRIPT = Path(__file__).resolve()
TASK_ROOT = SCRIPT.parent.parent


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
    return completed.stdout


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    return value if isinstance(value, dict) else {}


def read_events(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        return []
    result: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            result.append(value)
    return result


def event_matches(phase: str, event: dict[str, Any]) -> bool:
    if phase == "install-manager":
        return event.get("step") == "browse_menu" and event.get("status") == "clicked" and event.get("message") == "安装管理"
    if phase == "privacy":
        return event.get("step") == "browse_menu" and event.get("status") == "clicked" and event.get("message") == "隐私政策"
    return False


def drain(stream: Any, lines: list[str]) -> None:
    for line in iter(stream.readline, ""):
        lines.append(line)
    stream.close()


def main_pid(adb: str, serial: str) -> int | None:
    completed = run_text([adb, "-s", serial, "shell", "pidof", PACKAGE], timeout=15.0)
    if completed.returncode != 0:
        return None
    values = [item for item in completed.stdout.strip().split() if item.isdigit()]
    return int(values[0]) if values else None


def wait_for_trigger(
    adb: str,
    serial: str,
    phase: str,
    runner_root: Path,
    run_id: str,
    process: subprocess.Popen[str],
    timeout_s: float,
) -> tuple[Path, int, dict[str, Any] | None]:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        candidates = sorted(runner_root.glob(f"run_*_{run_id[:8]}"), key=lambda path: path.stat().st_mtime)
        if candidates:
            run_dir = candidates[-1]
            manifest_path = run_dir / "run_manifest.json"
            manifest = read_json(manifest_path) if manifest_path.is_file() else {}
            pid = main_pid(adb, serial)
            if phase in ("startup", "full"):
                if pid is not None and manifest.get("launch_prepared_before_sampler"):
                    return run_dir, pid, None
            else:
                event = next(
                    (item for item in read_events(run_dir / "flow" / "flow_events.jsonl") if event_matches(phase, item)),
                    None,
                )
                if event is not None and pid is not None:
                    return run_dir, pid, event
        if process.poll() is not None:
            raise RuntimeError(f"runner exited before {phase} trigger; exit={process.returncode}")
        time.sleep(0.2)
    raise RuntimeError(f"timed out waiting for {phase} trigger")


def parse_percent(value: Any) -> float | None:
    text = str(value or "").strip()
    if text.endswith("%"):
        try:
            return float(text[:-1])
        except ValueError:
            return None
    return None


def parse_report_csv(raw: str) -> list[dict[str, Any]]:
    raw_lines = raw.splitlines()
    header_index = next(
        (index for index, line in enumerate(raw_lines) if line.startswith("Overhead,")),
        None,
    )
    if header_index is None:
        return []
    # Android simpleperf prefixes --csv output with human-readable metadata
    # (Cmdline/Arch/Event/Samples/Event count).  Start DictReader at the real
    # CSV header so those lines can't silently become bogus column names.
    lines = [line for line in raw_lines[header_index:] if line.strip()]
    reader = csv.DictReader(io.StringIO("\n".join(lines)))
    rows: list[dict[str, Any]] = []
    for row in reader:
        normalized = {str(key or "").strip(): value for key, value in row.items()}
        percent = next((parse_percent(value) for value in normalized.values() if parse_percent(value) is not None), None)
        if percent is None:
            continue
        rows.append({**normalized, "overhead_pct": percent})
    return rows


def symbol_category(symbol: str, shared_object: str) -> str:
    lowered = f"{symbol} {shared_object}".lower()
    if "com.appmarket" in lowered:
        return "应用业务代码"
    if any(token in lowered for token in ("glide", "bitmap", "skia", "hwui")):
        return "图片/渲染"
    if any(token in lowered for token in ("okhttp", "retrofit", "ssl", "socket", "cronet")):
        return "网络"
    if any(token in lowered for token in ("kotlinx.coroutines", "defaultdispatcher")):
        return "协程/调度"
    if any(token in lowered for token in ("android.view", "android.widget", "renderthread", "choreographer")):
        return "Android UI"
    if any(token in lowered for token in ("libart", "art::", "gc", "heap")):
        return "ART/GC"
    if "libwebviewchromium" in lowered or "chromium" in lowered:
        return "WebView/Chromium"
    if lowered.strip():
        return "系统/第三方"
    return "未知"


def summarize(flat_rows: list[dict[str, Any]], thread_rows: list[dict[str, Any]]) -> dict[str, Any]:
    top_symbols: list[dict[str, Any]] = []
    for row in sorted(flat_rows, key=lambda item: float(item["overhead_pct"]), reverse=True)[:150]:
        symbol = str(row.get("Symbol") or row.get("symbol") or "")
        shared = str(row.get("Shared Object") or row.get("shared object") or row.get("dso") or "")
        top_symbols.append(
            {
                "overhead_pct": row["overhead_pct"],
                "command": row.get("Command") or row.get("command"),
                "pid": row.get("Pid") or row.get("pid"),
                "tid": row.get("Tid") or row.get("tid"),
                "shared_object": shared,
                "symbol": symbol,
                "category": symbol_category(symbol, shared),
            }
        )
    top_threads = [
        {
            "overhead_pct": row["overhead_pct"],
            "command": row.get("Command") or row.get("command"),
            "pid": row.get("Pid") or row.get("pid"),
            "tid": row.get("Tid") or row.get("tid"),
        }
        for row in sorted(thread_rows, key=lambda item: float(item["overhead_pct"]), reverse=True)[:80]
    ]
    category_totals: dict[str, float] = {}
    for row in top_symbols:
        category_totals[row["category"]] = category_totals.get(row["category"], 0.0) + float(row["overhead_pct"])
    return {
        "top_threads": top_threads,
        "top_symbols": top_symbols,
        "category_overhead_pct_sum": dict(sorted(category_totals.items(), key=lambda item: item[1], reverse=True)),
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Capture AppMarket simpleperf call stacks")
    parser.add_argument("--adb", default="adb")
    parser.add_argument("--serial", required=True)
    parser.add_argument("--phase", choices=tuple(DEFAULT_RECORD_SECONDS), required=True)
    parser.add_argument("--record-seconds", type=float, default=None)
    parser.add_argument("--frequency", type=int, default=99)
    parser.add_argument("--runner-duration", type=float, default=180.0)
    parser.add_argument("--gateway", default="http://127.0.0.1:3001")
    parser.add_argument(
        "--test-app-title",
        default="",
        help="固定完整流程中的测试应用，避免诊断复测受首页候选状态影响",
    )
    parser.add_argument("--out-dir", type=Path, default=None)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    if args.frequency < 1 or args.frequency > 1000:
        raise SystemExit("--frequency must be between 1 and 1000")
    record_seconds = args.record_seconds or DEFAULT_RECORD_SECONDS[args.phase]
    if record_seconds <= 0:
        raise SystemExit("--record-seconds must be positive")
    repo_root = find_repo_root(SCRIPT)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    diagnostic_id = str(uuid.uuid4())
    out_dir = (args.out_dir or (
        repo_root / "docs" / "tempFiles" / "appmarket-peak-analysis"
        / f"simpleperf_{args.phase}_{stamp}_{diagnostic_id[:8]}"
    )).resolve()
    runner_root = out_dir / "runner"
    runner_root.mkdir(parents=True, exist_ok=True)
    stop_file = out_dir / ".stop"
    root = run_text([args.adb, "-s", args.serial, "root"], timeout=30.0)
    if root.returncode != 0:
        raise SystemExit(f"adb root failed: {(root.stderr or root.stdout).strip()}")
    adb_text(args.adb, args.serial, "wait-for-device")

    run_id = f"cpu-{args.phase}-{diagnostic_id[:8]}"
    runner_command = [
        sys.executable,
        str(TASK_ROOT / "runner.py"),
        "--non-interactive", "--adb", args.adb, "--serial", args.serial,
        "--package", PACKAGE, "--duration", f"{args.runner_duration:g}", "--interval", "5",
        "--sampling-mode", "standard", "--flow-mode", "full", "--run-id", run_id,
        "--out-root", str(runner_root), "--stop-file", str(stop_file), "--gateway", args.gateway,
    ]
    if args.test_app_title:
        runner_command += ["--test-app-title", args.test_app_title]
    runner = subprocess.Popen(
        runner_command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    assert runner.stdout is not None
    runner_lines: list[str] = []
    thread = threading.Thread(target=drain, args=(runner.stdout, runner_lines), daemon=True)
    thread.start()
    error = ""
    matched_event: dict[str, Any] | None = None
    run_dir: Path | None = None
    pid = 0
    remote = f"/data/local/tmp/appmarket_{args.phase.replace('-', '_')}_{diagnostic_id[:8]}.perf.data"
    try:
        run_dir, pid, matched_event = wait_for_trigger(
            args.adb,
            args.serial,
            args.phase,
            runner_root,
            run_id,
            runner,
            args.runner_duration + 120.0,
        )
        adb_text(args.adb, args.serial, "shell", f"rm -f {remote}")
        record = run_text(
            [
                args.adb, "-s", args.serial, "shell", "simpleperf", "record",
                "-p", str(pid), "--duration", f"{record_seconds:g}", "-f", str(args.frequency),
                "-g", "-o", remote,
            ],
            timeout=record_seconds + 180.0,
        )
        (out_dir / "simpleperf_record.log").write_text(
            record.stdout + ("\n--- STDERR ---\n" + record.stderr if record.stderr else ""),
            encoding="utf-8",
        )
        if record.returncode != 0:
            raise RuntimeError("simpleperf record failed")
        raw_data = out_dir / "perf.data"
        pull = run_text([args.adb, "-s", args.serial, "pull", remote, str(raw_data)], timeout=180.0)
        (out_dir / "perf_data_pull.log").write_text(
            pull.stdout + ("\n--- STDERR ---\n" + pull.stderr if pull.stderr else ""),
            encoding="utf-8",
        )
        if pull.returncode != 0 or not raw_data.is_file():
            raise RuntimeError("failed to pull perf.data")

        flat = run_text(
            [args.adb, "-s", args.serial, "shell", "simpleperf", "report", "-i", remote, "--csv", "--sort", "comm,pid,tid,dso,symbol"],
            timeout=180.0,
        )
        threads = run_text(
            [args.adb, "-s", args.serial, "shell", "simpleperf", "report", "-i", remote, "--csv", "--sort", "comm,pid,tid"],
            timeout=180.0,
        )
        callgraph = run_text(
            [
                args.adb, "-s", args.serial, "shell", "simpleperf", "report", "-i", remote,
                "-g", "--children", "--full-callgraph", "--percent-limit", "0.1",
                "--sort", "comm,pid,tid,dso,symbol",
            ],
            timeout=300.0,
        )
        (out_dir / "simpleperf_flat.csv").write_text(flat.stdout, encoding="utf-8")
        (out_dir / "simpleperf_threads.csv").write_text(threads.stdout, encoding="utf-8")
        (out_dir / "simpleperf_callgraph.txt").write_text(callgraph.stdout, encoding="utf-8")
        (out_dir / "simpleperf_report.stderr.log").write_text(
            "\n--- FLAT ---\n" + flat.stderr + "\n--- THREADS ---\n" + threads.stderr + "\n--- CALLGRAPH ---\n" + callgraph.stderr,
            encoding="utf-8",
        )
        if flat.returncode != 0 or threads.returncode != 0 or callgraph.returncode != 0:
            raise RuntimeError("one or more simpleperf reports failed")
        flat_rows = parse_report_csv(flat.stdout)
        thread_rows = parse_report_csv(threads.stdout)
        report_summary = summarize(flat_rows, thread_rows)
        adb_text(args.adb, args.serial, "shell", f"rm -f {remote}")
        stop_file.write_text("simpleperf diagnostic complete\n", encoding="utf-8")
    except Exception as exc:
        error = str(exc)
        report_summary = {}
        stop_file.write_text(f"simpleperf diagnostic failed: {error}\n", encoding="utf-8")
        try:
            adb_text(args.adb, args.serial, "shell", f"rm -f {remote}")
        except Exception:
            pass

    try:
        runner_exit = runner.wait(timeout=max(90.0, args.runner_duration + 120.0))
    except subprocess.TimeoutExpired:
        runner.terminate()
        try:
            runner_exit = runner.wait(timeout=10.0)
        except subprocess.TimeoutExpired:
            runner.kill()
            runner_exit = runner.wait(timeout=10.0)
    thread.join(timeout=5.0)
    (out_dir / "runner.log").write_text("".join(runner_lines), encoding="utf-8")
    manifest = {
        "schema_version": 1,
        "diagnostic_id": diagnostic_id,
        "phase": args.phase,
        "status": "completed" if report_summary and not error else "failed",
        "captured_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "serial": args.serial,
        "package": PACKAGE,
        "pid": pid,
        "matched_event": matched_event,
        "settings": {"record_seconds": record_seconds, "frequency_hz": args.frequency, "callgraph": "dwarf (-g)"},
        "methodology": {
            "formal_metrics_eligible": False,
            "reason": "simpleperf sampling adds diagnostic overhead",
        },
        "runner_exit_code": runner_exit,
        "runner_artifact_dir": (
            run_dir.relative_to(repo_root).as_posix()
            if run_dir is not None and run_dir.is_relative_to(repo_root)
            else str(run_dir or "")
        ),
        "summary": report_summary,
        "error": error,
    }
    (out_dir / "simpleperf_summary.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"DIAGNOSTIC_DIR={out_dir.relative_to(repo_root).as_posix()}")
    print(f"STATUS={manifest['status']}")
    if error:
        print(f"ERROR={error}", file=sys.stderr)
    return 0 if manifest["status"] == "completed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
