#!/usr/bin/env python3
"""Replay one AppMarket phase and capture its managed/native memory image.

Heap dumping stops the managed runtime and can trigger GC, so this script is
for a dedicated diagnostic replay only. It must not be mixed into the formal
CPU/PSS rounds used for threshold decisions.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Sequence


PACKAGE = "com.appmarket.automotive"
PHASE_SETTLE_S = {"startup": 4.0, "install-manager": 2.0, "privacy": 2.0}


def find_repo_root(start: Path) -> Path:
    for candidate in (start, *start.parents):
        if (candidate / ".git").exists():
            return candidate
    raise RuntimeError(f"repository root not found from {start}")


SCRIPT = Path(__file__).resolve()
TASK_ROOT = SCRIPT.parent.parent
SRC_DIR = TASK_ROOT / "src"
sys.path.insert(0, str(SRC_DIR))

from hprof_heap_histogram import HistogramParser, write_csv, write_json


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


def event_matches(phase: str, event: dict[str, Any]) -> bool:
    if phase == "startup":
        return event.get("step") == "launch" and event.get("status") == "started"
    if phase == "install-manager":
        return (
            event.get("step") == "browse_menu"
            and event.get("status") == "clicked"
            and event.get("message") == "安装管理"
        )
    if phase == "privacy":
        return (
            event.get("step") == "browse_menu"
            and event.get("status") == "clicked"
            and event.get("message") == "隐私政策"
        )
    return False


def parse_processes(raw: str) -> list[dict[str, Any]]:
    processes: list[dict[str, Any]] = []
    for line in raw.splitlines():
        value = line.strip()
        if not value or value.upper().startswith("PID"):
            continue
        parts = value.split(None, 1)
        if len(parts) != 2 or not parts[0].isdigit():
            continue
        if parts[1] == PACKAGE or parts[1].startswith(PACKAGE + ":"):
            processes.append({"pid": int(parts[0]), "name": parts[1]})
    return processes


def wait_for_processes(adb: str, serial: str, timeout_s: float = 15.0) -> list[dict[str, Any]]:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        raw = adb_text(adb, serial, "shell", "ps -A -o PID,NAME", timeout=15.0)
        processes = parse_processes(raw)
        if processes:
            return processes
        time.sleep(0.25)
    raise RuntimeError(f"no {PACKAGE} process appeared within {timeout_s:g}s")


def wait_for_remote_file(adb: str, serial: str, remote: str, timeout_s: float = 60.0) -> int:
    deadline = time.monotonic() + timeout_s
    previous = -1
    stable = 0
    while time.monotonic() < deadline:
        output = adb_text(
            adb,
            serial,
            "shell",
            f"if [ -f {remote} ]; then stat -c %s {remote}; else echo 0; fi",
            timeout=15.0,
        ).strip()
        try:
            size = int(output.splitlines()[-1])
        except (ValueError, IndexError):
            size = 0
        stable = stable + 1 if size > 0 and size == previous else 0
        if stable >= 2:
            return size
        previous = size
        time.sleep(1.0)
    raise RuntimeError(f"heap dump {remote} did not stabilize within {timeout_s:g}s")


def capture_process(
    adb: str,
    serial: str,
    process: dict[str, Any],
    out_dir: Path,
    hprof_conv: str,
) -> dict[str, Any]:
    pid = int(process["pid"])
    name = str(process["name"])
    safe_name = name.replace(":", "_").replace(".", "_")
    process_dir = out_dir / f"pid_{pid}_{safe_name}"
    process_dir.mkdir(parents=True, exist_ok=True)

    commands: dict[str, tuple[str, float]] = {
        "meminfo_before.txt": (f"dumpsys meminfo --local {pid}", 45.0),
        "smaps_rollup.txt": (f"cat /proc/{pid}/smaps_rollup", 30.0),
        "status.txt": (f"cat /proc/{pid}/status", 15.0),
        "threads.txt": (
            f"for t in /proc/{pid}/task/*; do printf '%s|' \"${{t##*/}}\"; cat \"$t/comm\"; done",
            30.0,
        ),
        "showmap.txt": (f"showmap -v {pid}", 60.0),
    }
    command_errors: list[str] = []
    for filename, (shell_command, timeout) in commands.items():
        try:
            output = adb_text(adb, serial, "shell", shell_command, timeout=timeout)
            (process_dir / filename).write_text(output, encoding="utf-8")
        except Exception as exc:  # preserve the remaining evidence on partial devices
            command_errors.append(f"{filename}:{exc}")

    remote = f"/data/local/tmp/appmarket_{safe_name}_{pid}.hprof"
    adb_text(adb, serial, "shell", f"rm -f {remote}")
    dump = run_text(
        [adb, "-s", serial, "shell", "am", "dumpheap", str(pid), remote],
        timeout=90.0,
    )
    (process_dir / "dumpheap.log").write_text(
        dump.stdout + ("\n--- STDERR ---\n" + dump.stderr if dump.stderr else ""),
        encoding="utf-8",
    )
    if dump.returncode != 0:
        raise RuntimeError(f"am dumpheap failed for {name}/{pid}")
    remote_size = wait_for_remote_file(adb, serial, remote)
    android_hprof = process_dir / "heap.android.hprof"
    pull = run_text([adb, "-s", serial, "pull", remote, str(android_hprof)], timeout=180.0)
    (process_dir / "pull.log").write_text(
        pull.stdout + ("\n--- STDERR ---\n" + pull.stderr if pull.stderr else ""),
        encoding="utf-8",
    )
    adb_text(adb, serial, "shell", f"rm -f {remote}")
    if pull.returncode != 0 or not android_hprof.is_file():
        raise RuntimeError(f"failed to pull heap dump for {name}/{pid}")

    standard_hprof = process_dir / "heap.standard.hprof"
    conversion = run_text([hprof_conv, str(android_hprof), str(standard_hprof)], timeout=180.0)
    (process_dir / "hprof-conv.log").write_text(
        conversion.stdout + ("\n--- STDERR ---\n" + conversion.stderr if conversion.stderr else ""),
        encoding="utf-8",
    )
    if conversion.returncode != 0 or not standard_hprof.is_file():
        raise RuntimeError(f"hprof-conv failed for {name}/{pid}")

    histogram = HistogramParser(standard_hprof, largest_limit=200).parse()
    histogram_json = process_dir / "heap_histogram.json"
    histogram_csv = process_dir / "heap_histogram.csv"
    write_json(histogram_json, histogram)
    write_csv(histogram_csv, histogram["classes"])
    try:
        after = adb_text(adb, serial, "shell", f"dumpsys meminfo --local {pid}", timeout=45.0)
        (process_dir / "meminfo_after.txt").write_text(after, encoding="utf-8")
    except Exception as exc:
        command_errors.append(f"meminfo_after.txt:{exc}")

    return {
        "pid": pid,
        "name": name,
        "remote_hprof_bytes": remote_size,
        "android_hprof_bytes": android_hprof.stat().st_size,
        "standard_hprof_bytes": standard_hprof.stat().st_size,
        "histogram_summary": histogram["summary"],
        "top_classes": histogram["classes"][:30],
        "top_categories": histogram["categories"][:20],
        "command_errors": command_errors,
        "artifact_dir": process_dir.name,
    }


def read_events(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        return []
    events: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            events.append(value)
    return events


def drain_output(stream: Any, lines: list[str]) -> None:
    for line in iter(stream.readline, ""):
        lines.append(line)
    stream.close()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Capture an AppMarket phase heap image")
    parser.add_argument("--adb", default="adb")
    parser.add_argument("--serial", required=True)
    parser.add_argument("--phase", choices=tuple(PHASE_SETTLE_S), required=True)
    parser.add_argument("--duration", type=float, default=180.0)
    parser.add_argument("--interval", type=float, default=5.0)
    parser.add_argument("--gateway", default="http://127.0.0.1:3001")
    parser.add_argument(
        "--test-app-title",
        default="",
        help="固定完整流程中的测试应用，避免诊断复测受首页候选状态影响",
    )
    parser.add_argument("--hprof-conv", default="")
    parser.add_argument("--out-dir", type=Path, default=None)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    repo_root = find_repo_root(SCRIPT)
    hprof_conv = args.hprof_conv or shutil.which("hprof-conv")
    if not hprof_conv:
        raise SystemExit("hprof-conv was not found; install Android SDK platform-tools or pass --hprof-conv")
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    diagnostic_id = str(uuid.uuid4())
    out_dir = (args.out_dir or (
        repo_root / "docs" / "tempFiles" / "appmarket-peak-analysis"
        / f"heap_{args.phase}_{stamp}_{diagnostic_id[:8]}"
    )).resolve()
    runner_root = out_dir / "runner"
    evidence_dir = out_dir / "evidence"
    runner_root.mkdir(parents=True, exist_ok=True)
    evidence_dir.mkdir(parents=True, exist_ok=True)
    stop_file = out_dir / ".stop"

    root = run_text([args.adb, "-s", args.serial, "root"], timeout=30.0)
    if root.returncode != 0:
        raise SystemExit(f"adb root failed: {(root.stderr or root.stdout).strip()}")
    adb_text(args.adb, args.serial, "wait-for-device")

    run_id = f"heap-{args.phase}-{diagnostic_id[:8]}"
    command = [
        sys.executable,
        str(TASK_ROOT / "runner.py"),
        "--non-interactive",
        "--adb", args.adb,
        "--serial", args.serial,
        "--package", PACKAGE,
        "--duration", f"{args.duration:g}",
        "--interval", f"{args.interval:g}",
        "--sampling-mode", "standard",
        "--flow-mode", "full",
        "--run-id", run_id,
        "--out-root", str(runner_root),
        "--stop-file", str(stop_file),
        "--gateway", args.gateway,
    ]
    if args.test_app_title:
        command += ["--test-app-title", args.test_app_title]
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    assert process.stdout is not None
    output_lines: list[str] = []
    drain_thread = threading.Thread(target=drain_output, args=(process.stdout, output_lines), daemon=True)
    drain_thread.start()

    run_dir: Path | None = None
    matched_event: dict[str, Any] | None = None
    deadline = time.monotonic() + args.duration + 180.0
    try:
        while time.monotonic() < deadline:
            candidates = sorted(runner_root.glob(f"run_*_{run_id[:8]}"), key=lambda path: path.stat().st_mtime)
            if candidates:
                run_dir = candidates[-1]
                events = read_events(run_dir / "flow" / "flow_events.jsonl")
                matched_event = next((event for event in events if event_matches(args.phase, event)), None)
                if matched_event is not None:
                    break
            if process.poll() is not None:
                raise RuntimeError(f"runner exited before phase {args.phase}; exit={process.returncode}")
            time.sleep(0.25)
        if run_dir is None or matched_event is None:
            raise RuntimeError(f"phase {args.phase} was not observed before timeout")
        time.sleep(PHASE_SETTLE_S[args.phase])
        processes = wait_for_processes(args.adb, args.serial)
        # The main process owns the application object graph. Preserve other
        # package processes in the manifest/meminfo evidence without pretending
        # their native renderer heaps are part of this Java histogram.
        main_processes = [item for item in processes if item["name"] == PACKAGE]
        if not main_processes:
            raise RuntimeError("main AppMarket process not found at snapshot time")
        package_meminfo = adb_text(args.adb, args.serial, "shell", f"dumpsys meminfo --local {PACKAGE}", timeout=60.0)
        (evidence_dir / "package_meminfo_before.txt").write_text(package_meminfo, encoding="utf-8")
        results = [
            capture_process(args.adb, args.serial, item, evidence_dir, str(hprof_conv))
            for item in main_processes
        ]
        stop_file.write_text("diagnostic snapshot complete\n", encoding="utf-8")
    except Exception as exc:
        error = str(exc)
        stop_file.write_text(f"diagnostic failed: {error}\n", encoding="utf-8")
        results = []
    else:
        error = ""

    try:
        runner_exit = process.wait(timeout=max(60.0, args.duration + 120.0))
    except subprocess.TimeoutExpired:
        process.terminate()
        try:
            runner_exit = process.wait(timeout=10.0)
        except subprocess.TimeoutExpired:
            process.kill()
            runner_exit = process.wait(timeout=10.0)
    drain_thread.join(timeout=5.0)
    runner_log = out_dir / "runner.log"
    runner_log.write_text("".join(output_lines), encoding="utf-8")

    manifest = {
        "schema_version": 1,
        "diagnostic_id": diagnostic_id,
        "phase": args.phase,
        "status": "completed" if results and not error else "failed",
        "captured_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "serial": args.serial,
        "package": PACKAGE,
        "methodology": {
            "formal_metrics_eligible": False,
            "reason": "am dumpheap pauses the runtime and can trigger GC",
            "phase_settle_s": PHASE_SETTLE_S[args.phase],
            "heap_scope": "main process managed Java heap shallow histogram",
        },
        "matched_event": matched_event,
        "processes_at_snapshot": processes if matched_event is not None and "processes" in locals() else [],
        "heap_processes": results,
        "runner_exit_code": runner_exit,
        "runner_artifact_dir": (
            run_dir.relative_to(repo_root).as_posix()
            if run_dir is not None and run_dir.is_relative_to(repo_root)
            else str(run_dir or "")
        ),
        "error": error,
    }
    write_json(out_dir / "diagnostic_manifest.json", manifest)
    print(f"DIAGNOSTIC_DIR={out_dir.relative_to(repo_root).as_posix()}")
    print(f"STATUS={manifest['status']}")
    if error:
        print(f"ERROR={error}", file=sys.stderr)
    return 0 if manifest["status"] == "completed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
