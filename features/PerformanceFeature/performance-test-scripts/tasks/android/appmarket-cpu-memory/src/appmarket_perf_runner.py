#!/usr/bin/env python3
"""One-command AppMarket resource collection and analysis orchestrator."""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Sequence

from appmarket_flow import FlowError, run_flow
from performance_json_io import atomic_write_json


SOURCE_DIR = Path(__file__).resolve().parent
PACKAGE_ROOT = SOURCE_DIR.parent
CONFIG_DIR = PACKAGE_ROOT / "config"
SAMPLER = SOURCE_DIR / "android_app_perf_sampler.py"
ANALYZER = SOURCE_DIR / "analyze_appmarket_perf.py"
PERFETTO_VALIDATOR = SOURCE_DIR / "perfetto_cpu_validator.py"
DEFAULT_CONFIG = CONFIG_DIR / "appmarket_flow_config.json"
PERFETTO_CONFIG = CONFIG_DIR / "appmarket_perfetto.pbtxt"
PERFETTO_VALIDATION_CONFIG = CONFIG_DIR / "appmarket_perfetto_validation.pbtxt"
SCREENRECORD_SEGMENT_SECONDS = 170
SCREENRECORD_BIT_RATE = 4_000_000
LOGCAT_SEGMENT_BYTES = 64 * 1024 * 1024
SCREENRECORD_OVERHEAD_WARNING = (
    "screenrecord_enabled:录屏会产生视频编码、GPU、内存和存储 I/O 开销，"
    "可能扰动 CPU/内存测量；正式对比请保持各轮录屏设置一致。"
)


class RunnerError(RuntimeError):
    pass


def find_repo_root(start: Path) -> Path:
    for candidate in (start, *start.parents):
        if (candidate / ".git").exists() and (candidate / "AGENTS.md").exists():
            return candidate
    raise RunnerError("Cannot locate repository root")


def safe_name(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", value).strip("._-")
    return cleaned or "unknown"


def relative_path(path: Path, root: Path) -> str:
    try:
        return path.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return path.name


def adb_base(adb: str, serial: str) -> list[str]:
    command = [adb]
    if serial:
        command += ["-s", serial]
    return command


def run_text(command: Sequence[str], timeout: float = 30.0, check: bool = True) -> str:
    try:
        completed = subprocess.run(
            list(command),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            check=False,
        )
    except FileNotFoundError as exc:
        raise RunnerError(f"Cannot find executable: {command[0]}") from exc
    except subprocess.TimeoutExpired as exc:
        raise RunnerError(f"Command timed out: {' '.join(command)}") from exc
    if check and completed.returncode != 0:
        message = completed.stderr.strip() or completed.stdout.strip()
        raise RunnerError(f"Command failed ({completed.returncode}): {' '.join(command)}\n{message}")
    return completed.stdout.replace("\r\n", "\n").strip()


def list_devices(adb: str) -> list[dict[str, str]]:
    output = run_text([adb, "devices", "-l"], timeout=15.0)
    devices: list[dict[str, str]] = []
    for line in output.splitlines()[1:]:
        parts = line.split()
        if len(parts) < 2:
            continue
        item = {"serial": parts[0], "state": parts[1], "model": ""}
        for part in parts[2:]:
            if part.startswith("model:"):
                item["model"] = part.split(":", 1)[1]
        devices.append(item)
    return devices


def choose_device(adb: str, requested: str, interactive: bool, dry_run: bool) -> str:
    if dry_run:
        return requested or "DEVICE_SERIAL"
    devices = list_devices(adb)
    ready = [item for item in devices if item["state"] == "device"]
    if requested:
        match = next((item for item in devices if item["serial"] == requested), None)
        if match is None:
            raise RunnerError(f"Requested adb device is not connected: {requested}")
        if match["state"] != "device":
            raise RunnerError(f"Device {requested} is not ready (state={match['state']})")
        return requested
    if len(ready) == 1:
        return ready[0]["serial"]
    if not ready:
        states = ", ".join(f"{item['serial']}={item['state']}" for item in devices) or "none"
        raise RunnerError(f"No ready adb device; detected: {states}")
    if not interactive:
        raise RunnerError("Multiple adb devices are connected; pass --serial")
    print("检测到多个设备：")
    for index, item in enumerate(ready, 1):
        print(f"  {index}. {item['serial']}  {item['model']}")
    while True:
        answer = input(f"请选择设备 [1-{len(ready)}，默认 1]: ").strip() or "1"
        if answer.isdigit() and 1 <= int(answer) <= len(ready):
            return ready[int(answer) - 1]["serial"]
        print("输入无效，请重试。")


def prompt_number(label: str, current: float) -> float:
    answer = input(f"{label} [默认 {current:g}]: ").strip()
    if not answer:
        return current
    try:
        return float(answer)
    except ValueError:
        print("输入不是数字，沿用默认值。")
        return current


def prompt_yes_no(label: str, current: bool) -> bool:
    default = "Y/n" if current else "y/N"
    answer = input(f"{label} [{default}]: ").strip().lower()
    if not answer:
        return current
    return answer in {"y", "yes", "1", "是"}


def collect_device_info(adb: str, serial: str, package: str) -> tuple[dict[str, Any], dict[str, Any], str]:
    base = adb_base(adb, serial)

    def shell(*args: str) -> str:
        return run_text([*base, "shell", *args], timeout=20.0, check=False)

    state = run_text([*base, "get-state"], timeout=10.0)
    if state != "device":
        raise RunnerError(f"Device is not ready: {serial} state={state}")
    package_path = shell("pm", "path", package)
    if not package_path.startswith("package:"):
        raise RunnerError(f"Package is not installed on {serial}: {package}")
    props = {
        "serial": serial,
        "model": shell("getprop", "ro.product.model"),
        "brand": shell("getprop", "ro.product.brand"),
        "device": shell("getprop", "ro.product.device"),
        "build_fingerprint": shell("getprop", "ro.build.fingerprint"),
        "android_release": shell("getprop", "ro.build.version.release"),
        "sdk": shell("getprop", "ro.build.version.sdk"),
    }
    package_dump = shell("dumpsys", "package", package)
    version_name_match = re.search(r"\bversionName=([^\s]+)", package_dump)
    version_code_match = re.search(r"\bversionCode=(\d+)", package_dump)
    app = {
        "version_name": version_name_match.group(1) if version_name_match else "",
        "version_code": int(version_code_match.group(1)) if version_code_match else 0,
        "package_path": package_path.splitlines()[0].removeprefix("package:"),
    }
    return props, app, package_dump


def write_json(path: Path, value: Any) -> None:
    atomic_write_json(path, value)


def tee_output(pipe: Any, log_path: Path, prefix: str = "") -> None:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with log_path.open("w", encoding="utf-8") as handle:
        for line in iter(pipe.readline, ""):
            handle.write(line)
            handle.flush()
            # One write keeps structured LIVE_SAMPLE_JSON records intact even
            # while the UI-flow thread is also writing progress to stdout.
            sys.stdout.write(prefix + line.rstrip("\r\n") + "\n")
            sys.stdout.flush()


def copy_rotating_logcat_stream(
    pipe: Any,
    current_path: Path,
    *,
    segment_bytes: int = LOGCAT_SEGMENT_BYTES,
    state: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Drain adb logcat through a pipe while retaining only the newest 2 segments.

    Passing adb a regular output file lets it inherit that file handle; if the
    Python parent is force-killed, adb can then keep writing forever.  A pipe
    makes the writer lose its reader with the parent, while rotation bounds the
    normal-run footprint and keeps the most recent failure evidence.
    """
    if segment_bytes <= 0:
        raise ValueError("segment_bytes must be positive")
    result = state if state is not None else {}
    result.update({"bytes": 0, "rotations": 0, "error": ""})
    previous_path = current_path.with_name(f"{current_path.stem}.previous{current_path.suffix}")
    current_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        previous_path.unlink(missing_ok=True)
        handle = current_path.open("wb")
        segment_written = 0
        try:
            while True:
                chunk = pipe.read(64 * 1024)
                if not chunk:
                    break
                view = memoryview(chunk)
                offset = 0
                while offset < len(view):
                    available = segment_bytes - segment_written
                    take = min(available, len(view) - offset)
                    handle.write(view[offset : offset + take])
                    handle.flush()
                    segment_written += take
                    result["bytes"] += take
                    offset += take
                    if segment_written >= segment_bytes:
                        handle.close()
                        previous_path.unlink(missing_ok=True)
                        current_path.replace(previous_path)
                        result["rotations"] += 1
                        handle = current_path.open("wb")
                        segment_written = 0
        finally:
            handle.close()
    except (OSError, ValueError) as exc:
        result["error"] = str(exc)
    return result


def terminate_process(process: subprocess.Popen[Any] | None, timeout_s: float = 5.0) -> None:
    if process is None or process.poll() is not None:
        return
    try:
        process.terminate()
        process.wait(timeout=timeout_s)
    except Exception:
        try:
            process.kill()
        except Exception:
            pass


def plan_screenrecord_segments(
    duration_s: float,
    segment_seconds: int = SCREENRECORD_SEGMENT_SECONDS,
) -> list[int]:
    """Return full screenrecord time limits needed to cover the sample window.

    The final process is stopped cooperatively when sampling finishes, so every
    planned segment uses the same Android-safe 170-second limit. This avoids a
    short final segment ending just before the last metric snapshot is flushed.
    """
    if duration_s <= 0:
        raise ValueError("duration_s must be positive")
    if segment_seconds <= 0 or segment_seconds > 180:
        raise ValueError("segment_seconds must be in 1..180")
    return [segment_seconds] * int(math.ceil(duration_s / segment_seconds))


def build_screenrecord_command(
    adb: str,
    serial: str,
    remote_path: str,
    *,
    segment_seconds: int = SCREENRECORD_SEGMENT_SECONDS,
    bit_rate: int = SCREENRECORD_BIT_RATE,
) -> list[str]:
    if not remote_path.startswith("/"):
        raise ValueError("remote_path must be absolute")
    if segment_seconds <= 0 or segment_seconds > 180:
        raise ValueError("segment_seconds must be in 1..180")
    if bit_rate <= 0:
        raise ValueError("bit_rate must be positive")
    return [
        *adb_base(adb, serial),
        "shell",
        "screenrecord",
        "--bit-rate",
        str(bit_rate),
        "--time-limit",
        str(segment_seconds),
        remote_path,
    ]


class ScreenRecordCapture:
    """Best-effort segmented device recording that never owns run success."""

    def __init__(
        self,
        adb: str,
        serial: str,
        run_id: str,
        duration_s: float,
        output_dir: Path,
        *,
        segment_seconds: int = SCREENRECORD_SEGMENT_SECONDS,
        bit_rate: int = SCREENRECORD_BIT_RATE,
    ) -> None:
        self.adb = adb
        self.serial = serial
        self.output_dir = output_dir
        self.segment_seconds = segment_seconds
        self.bit_rate = bit_rate
        self.planned_segment_count = len(plan_screenrecord_segments(duration_s, segment_seconds))
        self.remote_prefix = f"/sdcard/appmarket_perf_{safe_name(run_id)[:48]}"
        self.stop_event = threading.Event()
        self.ready_event = threading.Event()
        self.thread: threading.Thread | None = None
        self.current_process: subprocess.Popen[Any] | None = None
        self.records: list[dict[str, Any]] = []
        self.warnings: list[str] = []
        self._lock = threading.Lock()
        self._result: dict[str, Any] | None = None

    def _warn(self, value: str) -> None:
        if value not in self.warnings:
            self.warnings.append(value)

    def start(self) -> None:
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.thread = threading.Thread(target=self._record_loop, name="appmarket-screenrecord", daemon=True)
        self.thread.start()
        if not self.ready_event.wait(timeout=5.0):
            self._warn("screenrecord_start_unconfirmed")

    def _record_loop(self) -> None:
        quick_failures = 0
        index = 0
        try:
            while not self.stop_event.is_set():
                index += 1
                remote_path = f"{self.remote_prefix}_{index:03d}.mp4"
                local_path = self.output_dir / f"segment_{index:03d}.mp4"
                log_path = self.output_dir / f"segment_{index:03d}.screenrecord.log"
                record: dict[str, Any] = {
                    "index": index,
                    "remote_path": remote_path,
                    "local_path": local_path.name,
                    "status": "starting",
                }
                with self._lock:
                    self.records.append(record)
                started = time.monotonic()
                try:
                    with log_path.open("wb") as log_handle:
                        process = subprocess.Popen(
                            build_screenrecord_command(
                                self.adb,
                                self.serial,
                                remote_path,
                                segment_seconds=self.segment_seconds,
                                bit_rate=self.bit_rate,
                            ),
                            stdout=log_handle,
                            stderr=subprocess.STDOUT,
                        )
                        with self._lock:
                            self.current_process = process
                            record["status"] = "recording"
                        self.ready_event.set()
                        while process.poll() is None and not self.stop_event.wait(0.2):
                            pass
                        if self.stop_event.is_set() and process.poll() is None:
                            # stop_and_collect sends an Android-side SIGINT so
                            # screenrecord can finalize the MP4 before pulling.
                            try:
                                process.wait(timeout=8.0)
                            except subprocess.TimeoutExpired:
                                terminate_process(process, timeout_s=2.0)
                        exit_code = process.poll()
                except (OSError, ValueError) as exc:
                    record["status"] = "start_failed"
                    record["error"] = str(exc)
                    self._warn(f"screenrecord_segment_{index:03d}_start_failed:{exc}")
                    self.ready_event.set()
                    break
                finally:
                    with self._lock:
                        self.current_process = None

                elapsed = time.monotonic() - started
                record["elapsed_s"] = round(elapsed, 3)
                record["exit_code"] = exit_code
                record["status"] = "stopped" if self.stop_event.is_set() else "finished"
                if self.stop_event.is_set():
                    break
                if exit_code not in {0, None} and elapsed < 3.0:
                    quick_failures += 1
                    self._warn(f"screenrecord_segment_{index:03d}_exit_code:{exit_code}")
                    if quick_failures >= 2:
                        self._warn("screenrecord_stopped_after_repeated_quick_failures")
                        break
                    time.sleep(0.3)
                else:
                    quick_failures = 0
        except Exception as exc:  # recording must never fail the metric run
            self._warn(f"screenrecord_worker_failed:{exc}")
        finally:
            self.ready_event.set()

    def status(self, state: str = "recording") -> dict[str, Any]:
        return {
            "enabled": True,
            "status": state,
            "segment_seconds": self.segment_seconds,
            "bit_rate": self.bit_rate,
            "planned_segment_count": self.planned_segment_count,
            "segments": [dict(record) for record in self.records],
            "warnings": list(self.warnings),
        }

    def stop_and_collect(self) -> dict[str, Any]:
        if self._result is not None:
            return self._result
        self.stop_event.set()
        try:
            run_text(
                [*adb_base(self.adb, self.serial), "shell", "pkill", "-INT", "screenrecord"],
                timeout=8.0,
                check=False,
            )
        except RunnerError as exc:
            self._warn(f"screenrecord_stop_signal_failed:{exc}")
        if self.thread is not None:
            self.thread.join(timeout=12.0)
        if self.thread is not None and self.thread.is_alive():
            with self._lock:
                process = self.current_process
            terminate_process(process, timeout_s=2.0)
            self.thread.join(timeout=3.0)
            if self.thread.is_alive():
                self._warn("screenrecord_worker_did_not_stop")

        pulled = 0
        for record in self.records:
            remote_path = str(record["remote_path"])
            local_path = self.output_dir / str(record["local_path"])
            if record.get("status") == "start_failed":
                continue
            try:
                run_text(
                    [*adb_base(self.adb, self.serial), "pull", remote_path, str(local_path)],
                    timeout=180.0,
                    check=False,
                )
                if local_path.exists() and local_path.stat().st_size > 0:
                    record["bytes"] = local_path.stat().st_size
                    record["pulled"] = True
                    pulled += 1
                else:
                    record["pulled"] = False
                    self._warn(f"screenrecord_segment_{int(record['index']):03d}_pull_failed")
            except (OSError, RunnerError) as exc:
                record["pulled"] = False
                self._warn(f"screenrecord_segment_{int(record['index']):03d}_pull_failed:{exc}")
            finally:
                try:
                    run_text(
                        [*adb_base(self.adb, self.serial), "shell", "rm", "-f", remote_path],
                        timeout=20.0,
                        check=True,
                    )
                    record["remote_cleaned"] = True
                except RunnerError as exc:
                    record["remote_cleaned"] = False
                    self._warn(f"screenrecord_segment_{int(record['index']):03d}_cleanup_failed:{exc}")

        status = "completed" if pulled and not self.warnings else ("partial" if pulled else "failed")
        self._result = self.status(status)
        self._result["pulled_segment_count"] = pulled
        return self._result


def start_perfetto(
    adb: str,
    serial: str,
    duration_s: float,
    run_id: str,
    raw_dir: Path,
    config_path: Path = PERFETTO_CONFIG,
) -> tuple[subprocess.Popen[Any], str, Path, Any]:
    if not config_path.exists():
        raise RunnerError(f"Perfetto config is missing: {config_path}")
    config_text = config_path.read_text(encoding="utf-8")
    config_text = re.sub(
        r"(?m)^duration_ms:\s*\d+\s*$",
        f"duration_ms: {int(duration_s * 1000)}",
        config_text,
        count=1,
    )
    effective_config = raw_dir / "appmarket_perfetto_effective.pbtxt"
    effective_config.write_text(config_text, encoding="utf-8")
    remote_trace = f"/data/misc/perfetto-traces/appmarket_{safe_name(run_id)}.pftrace"
    base = adb_base(adb, serial)
    log_handle = (raw_dir / "perfetto.log").open("wb")
    process = subprocess.Popen(
        [*base, "shell", "perfetto", "--txt", "-c", "-", "-o", remote_trace],
        stdin=subprocess.PIPE,
        stdout=log_handle,
        stderr=subprocess.STDOUT,
    )
    try:
        assert process.stdin is not None
        process.stdin.write(config_text.encode("utf-8"))
        process.stdin.close()
    except Exception as exc:
        terminate_process(process)
        log_handle.close()
        raise RunnerError(f"Could not stream Perfetto config through adb: {exc}") from exc
    return process, remote_trace, effective_config, log_handle


def stop_remote_perfetto(adb: str, serial: str, remote_trace: str) -> str:
    """Stop only the Perfetto process writing this run's trace.

    Terminating the host-side ``adb shell perfetto`` process does not stop the
    detached Android Perfetto process.  Match the unique output path in the
    full command line so cancelling one test cannot interrupt another trace.
    """
    if not re.fullmatch(
        r"/data/misc/perfetto-traces/appmarket_[A-Za-z0-9._-]+\.pftrace",
        remote_trace,
    ):
        raise RunnerError(f"Unsafe Perfetto trace path: {remote_trace}")
    return run_text(
        [
            *adb_base(adb, serial),
            "shell",
            "pkill",
            "-INT",
            "-f",
            re.escape(remote_trace),
        ],
        timeout=10.0,
        check=False,
    )


def run_perfetto_cpu_validation(
    trace_path: Path,
    csv_path: Path,
    package: str,
    output_path: Path,
    log_path: Path,
    trace_processor: str = "",
) -> dict[str, Any]:
    """Run trace processing in an isolated process and always leave JSON evidence."""
    command = [
        sys.executable,
        str(PERFETTO_VALIDATOR),
        "--trace", str(trace_path),
        "--csv", str(csv_path),
        "--package", package,
        "--out", str(output_path),
    ]
    if trace_processor:
        command += ["--trace-processor", trace_processor]
    fallback: dict[str, Any] = {
        "schema_version": 1,
        "analysis_status": "UNAVAILABLE",
        "threshold_status": "INCONCLUSIVE",
        "reason_codes": ["validator_not_completed"],
        "source": {"trace_file": trace_path.name},
        "window": {},
        "quality": {},
        "metrics": {"windows": []},
        "sampler_comparison": {},
        "checks": [],
    }
    try:
        completed = subprocess.run(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=180.0,
            check=False,
        )
        log_path.write_text(completed.stdout, encoding="utf-8")
        if completed.returncode != 0:
            fallback["reason_codes"] = [f"validator_exit_{completed.returncode}"]
    except subprocess.TimeoutExpired as exc:
        output = exc.stdout if isinstance(exc.stdout, str) else ""
        log_path.write_text(output + "\nvalidator timed out after 180s\n", encoding="utf-8")
        fallback["reason_codes"] = ["validator_timeout"]
    except OSError as exc:
        log_path.write_text(f"validator launch failed: {exc}\n", encoding="utf-8")
        fallback["reason_codes"] = ["validator_launch_failed"]

    try:
        value = json.loads(output_path.read_text(encoding="utf-8"))
        if isinstance(value, dict):
            return value
    except (OSError, json.JSONDecodeError):
        pass
    write_json(output_path, fallback)
    return fallback


def build_parser() -> argparse.ArgumentParser:
    repo_root = find_repo_root(SOURCE_DIR)
    parser = argparse.ArgumentParser(description="AppMarket one-click CPU/PSS performance run")
    parser.add_argument("--adb", default="adb")
    parser.add_argument("--serial", default="")
    parser.add_argument("--package", default="com.appmarket.automotive")
    parser.add_argument("--duration", type=float, default=180.0)
    parser.add_argument("--interval", type=float, default=5.0)
    parser.add_argument("--sampling-mode", choices=("standard", "realtime"), default="standard")
    parser.add_argument("--flavor", default="")
    parser.add_argument("--flow-mode", choices=("full", "launch-only"), default=None)
    parser.add_argument("--test-app-title", default="")
    parser.add_argument("--capture-perfetto", action="store_true")
    parser.add_argument(
        "--trace-processor",
        default=os.environ.get("PERFETTO_TRACE_PROCESSOR", ""),
        help="optional portable trace_processor_shell path used by the Perfetto Python API",
    )
    parser.add_argument(
        "--capture-screenrecord",
        action="store_true",
        help="record the device screen in 170-second MP4 segments (adds measurement overhead)",
    )
    parser.add_argument("--gateway", default="http://127.0.0.1:3001")
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument(
        "--out-root",
        type=Path,
        default=repo_root / "docs" / "tempFiles" / "appmarket-performance",
    )
    parser.add_argument("--run-id", default="")
    parser.add_argument("--stop-file", type=Path, default=None)
    parser.add_argument("--non-interactive", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    return parser


def validate_args(args: argparse.Namespace) -> None:
    if not re.fullmatch(r"[A-Za-z0-9_.]+", args.package):
        raise RunnerError("--package contains unsupported characters")
    if args.duration <= 0 or args.interval <= 0:
        raise RunnerError("duration and interval must be positive")
    ratio = args.duration / args.interval
    if not math_is_close_integer(ratio):
        raise RunnerError("duration must be an exact multiple of interval")
    if args.duration > 3600 or args.interval > 60:
        raise RunnerError("duration must be <=3600s and interval <=60s")
    if args.sampling_mode == "realtime" and abs(args.interval - 5.0) > 1e-9:
        raise RunnerError("realtime mode requires --interval 5 so formal CPU/PSS remains 5 seconds")
    if args.flavor and not re.fullmatch(r"[A-Za-z0-9_.-]+", args.flavor):
        raise RunnerError("--flavor contains unsupported characters")
    if args.trace_processor and not Path(args.trace_processor).is_file():
        raise RunnerError(f"trace processor does not exist: {args.trace_processor}")


def math_is_close_integer(value: float) -> bool:
    return abs(value - round(value)) <= 1e-9


def main() -> int:
    args = build_parser().parse_args()
    interactive = not args.non_interactive
    try:
        if interactive:
            print("\n应用市场 CPU/PSS 一键摸测")
            print("默认口径：180 秒、每 5 秒一次、主进程 + package:* 子进程。\n")
            args.duration = prompt_number("采样时长（秒）", args.duration)
            args.interval = prompt_number("采样间隔（秒）", args.interval)
            args.sampling_mode = (
                "realtime"
                if prompt_yes_no("启用实时诊断（CPU 500ms / RSS 1s / PSS 5s）", False)
                else "standard"
            )
            full_flow = prompt_yes_no("执行详情页下载安装及“我的”白名单菜单流程", True)
            args.flow_mode = "full" if full_flow else "launch-only"
            args.capture_perfetto = prompt_yes_no("同时采集 Perfetto 调度原始 trace（诊断用途）", False)
            args.capture_screenrecord = prompt_yes_no(
                "同时分段录屏（会产生编码开销并可能扰动性能数据）",
                args.capture_screenrecord,
            )
            if full_flow and not args.test_app_title:
                args.test_app_title = input("固定测试应用名称（留空则按安全规则选择首个应用）: ").strip()
        if args.flow_mode is None:
            args.flow_mode = "full"
        if args.sampling_mode == "realtime":
            # Realtime diagnosis promises an end-of-run scheduler check.
            args.capture_perfetto = True
        validate_args(args)
        serial = choose_device(args.adb, args.serial, interactive, args.dry_run)
    except RunnerError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    run_id = args.run_id or str(uuid.uuid4())
    stamp = time.strftime("%Y%m%d_%H%M%S")
    run_dir = args.out_root.resolve() / f"run_{stamp}_{safe_name(run_id)[:8]}"
    raw_dir = run_dir / "raw"
    flow_dir = run_dir / "flow"
    analysis_dir = run_dir / "analysis"
    trace_dir = run_dir / "trace"
    for directory in (raw_dir, flow_dir, analysis_dir, trace_dir):
        directory.mkdir(parents=True, exist_ok=True)
    stop_file = args.stop_file or (run_dir / ".stop")
    repo_root = find_repo_root(SOURCE_DIR)
    manifest_path = run_dir / "run_manifest.json"
    effective_flow_config = raw_dir / "effective_flow_config.json"
    manifest: dict[str, Any] = {
        "schema_version": 1,
        "session_id": run_id,
        "round": f"resource_{stamp}_{safe_name(run_id)[:8]}",
        "status": "starting",
        "started_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "package": args.package,
        "flavor": args.flavor,
        "duration_s": args.duration,
        "interval_s": args.interval,
        "sampling_mode": args.sampling_mode,
        "diagnostic_intervals": {
            "cpu_interval_ms": 500 if args.sampling_mode == "realtime" else int(args.interval * 1000),
            "rss_interval_ms": 1000 if args.sampling_mode == "realtime" else int(args.interval * 1000),
            "pss_interval_ms": int(args.interval * 1000),
        },
        "flow_mode": args.flow_mode,
        "capture_perfetto": bool(args.capture_perfetto),
        "trace_processor_configured": bool(args.trace_processor),
        "capture_screenrecord": bool(args.capture_screenrecord),
        "serial": serial,
        "artifact_dir": relative_path(run_dir, repo_root),
        "flow_config_source": relative_path(args.config, repo_root),
        "effective_flow_config": relative_path(effective_flow_config, repo_root),
    }
    write_json(manifest_path, manifest)
    live_meta: dict[str, Any] = {
        "schema_version": 1,
        "runId": run_id,
        # choose_device() has already completed. Keep this resolved serial
        # frozen for the whole run so live projection cannot drift to another
        # connected device when adb topology changes.
        "serial": serial,
        "package": args.package,
        "flavor": args.flavor,
        "duration_s": args.duration,
        "interval_s": args.interval,
        "expected_samples": int(round(args.duration / args.interval)),
        "sampling_mode": args.sampling_mode,
        "cpu_interval_ms": 500 if args.sampling_mode == "realtime" else int(args.interval * 1000),
        "rss_interval_ms": 1000 if args.sampling_mode == "realtime" else int(args.interval * 1000),
        "pss_interval_ms": int(args.interval * 1000),
        "artifact_dir": manifest["artifact_dir"],
        "phase": "preflight",
    }

    def emit_live_meta(phase: str, **extra: Any) -> None:
        live_meta.update(extra)
        live_meta["phase"] = phase
        print(
            "LIVE_META_JSON="
            + json.dumps(live_meta, ensure_ascii=False, separators=(",", ":")),
            flush=True,
        )

    # Expose the artifact root and resolved device before slow device/app
    # preflight starts. The gateway validates the relative path again.
    print(f"ARTIFACT_DIR={manifest['artifact_dir']}", flush=True)
    emit_live_meta("preflight")
    try:
        shutil.copyfile(args.config, effective_flow_config)
    except OSError as exc:
        manifest["status"] = "failed"
        manifest["error"] = f"Could not preserve flow config {args.config}: {exc}"
        manifest["completed_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
        write_json(manifest_path, manifest)
        print(f"ERROR: {manifest['error']}", file=sys.stderr)
        emit_live_meta("failed", error=manifest["error"])
        print(f"ARTIFACT_DIR={relative_path(run_dir, repo_root)}")
        return 2

    sampler_command = [
        sys.executable,
        str(SAMPLER),
        "--adb", args.adb,
        "--serial", serial,
        "--package", args.package,
        "--duration", f"{args.duration:g}",
        "--interval", f"{args.interval:g}",
        "--wait-process-timeout", "60",
        "--out", str(raw_dir / "metrics.csv"),
        "--summary-out", str(raw_dir / "sampler_summary.json"),
        "--raw-out", str(raw_dir / "sampler_raw_commands.jsonl"),
        "--stop-file", str(stop_file),
    ]
    if args.sampling_mode == "realtime":
        sampler_command += [
            "--sampling-mode", "realtime",
            "--diagnostic-out", str(raw_dir / "diagnostic_metrics.csv"),
            "--diagnostic-raw-out", str(raw_dir / "realtime_stream.jsonl"),
        ]
    if args.dry_run:
        print("DRY RUN")
        print("Sampler:", subprocess.list2cmdline(sampler_command))
        print(f"Flow: {args.flow_mode} package={args.package} serial={serial}")
        if args.capture_screenrecord:
            print(
                f"Screenrecord: {len(plan_screenrecord_segments(args.duration))} planned "
                f"segment(s), {SCREENRECORD_SEGMENT_SECONDS}s each"
            )
        print(f"Artifacts: {relative_path(run_dir, repo_root)}")
        manifest["status"] = "dry_run"
        if args.capture_screenrecord:
            manifest["screenrecord"] = {
                "enabled": True,
                "status": "dry_run",
                "segment_seconds": SCREENRECORD_SEGMENT_SECONDS,
                "bit_rate": SCREENRECORD_BIT_RATE,
                "planned_segment_count": len(plan_screenrecord_segments(args.duration)),
                "segments": [],
                "warnings": [SCREENRECORD_OVERHEAD_WARNING],
            }
            manifest["warnings"] = [SCREENRECORD_OVERHEAD_WARNING]
        write_json(manifest_path, manifest)
        emit_live_meta("dry_run")
        return 0

    sampler_process: subprocess.Popen[Any] | None = None
    logcat_process: subprocess.Popen[Any] | None = None
    logcat_thread: threading.Thread | None = None
    logcat_capture_state: dict[str, Any] = {}
    logcat_finalized = False
    perfetto_process: subprocess.Popen[Any] | None = None
    local_trace_path: Path | None = None
    screenrecord_capture: ScreenRecordCapture | None = None
    screenrecord_finalized = False
    perfetto_log_handle: Any = None
    logcat_err: Any = None
    flow_result: dict[str, Any] = {"mode": args.flow_mode, "status": "missing"}
    sampler_code: int | None = None
    cancelled = False
    warnings: list[str] = []
    if args.capture_screenrecord:
        warnings.append(SCREENRECORD_OVERHEAD_WARNING)

    def finalize_screenrecord() -> None:
        nonlocal screenrecord_capture, screenrecord_finalized
        if screenrecord_finalized or not args.capture_screenrecord:
            return
        screenrecord_finalized = True
        if screenrecord_capture is None:
            manifest["screenrecord"] = {
                "enabled": True,
                "status": "failed",
                "segment_seconds": SCREENRECORD_SEGMENT_SECONDS,
                "bit_rate": SCREENRECORD_BIT_RATE,
                "planned_segment_count": len(plan_screenrecord_segments(args.duration)),
                "segments": [],
                "warnings": ["screenrecord_not_started"],
            }
            warnings.append("screenrecord_not_started")
        else:
            try:
                result = screenrecord_capture.stop_and_collect()
                manifest["screenrecord"] = result
                warnings.extend(str(value) for value in result.get("warnings", []) if value)
            except Exception as exc:  # never let recording own the run result
                warning = f"screenrecord_finalize_failed:{exc}"
                warnings.append(warning)
                manifest["screenrecord"] = screenrecord_capture.status("failed")
                manifest["screenrecord"]["warnings"] = list(
                    dict.fromkeys([*manifest["screenrecord"].get("warnings", []), warning])
                )
        manifest["warnings"] = list(dict.fromkeys(warnings))
        try:
            write_json(manifest_path, manifest)
        except OSError:
            pass

    def finalize_logcat() -> None:
        nonlocal logcat_process, logcat_thread, logcat_finalized
        if logcat_finalized:
            return
        logcat_finalized = True
        terminate_process(logcat_process)
        logcat_process = None
        if logcat_thread is not None:
            logcat_thread.join(timeout=8.0)
            if logcat_thread.is_alive():
                warnings.append("logcat_capture_thread_did_not_stop")
        rotations = int(logcat_capture_state.get("rotations", 0) or 0)
        error = str(logcat_capture_state.get("error", "") or "")
        if rotations:
            warnings.append(f"logcat_rotated:{rotations}")
        if error:
            warnings.append(f"logcat_capture_failed:{error}")
        logcat_path = raw_dir / "logcat.txt"
        previous_path = raw_dir / "logcat.previous.txt"
        manifest["logcat"] = {
            "path": relative_path(logcat_path, repo_root),
            "previous_path": relative_path(previous_path, repo_root) if previous_path.exists() else "",
            "retained_bytes": sum(
                path.stat().st_size for path in (previous_path, logcat_path) if path.exists()
            ),
            "streamed_bytes": int(logcat_capture_state.get("bytes", 0) or 0),
            "rotations": rotations,
            "error": error,
        }

    try:
        if stop_file.exists():
            raise RunnerError("Run was cancelled before preflight completed")
        device, app, package_dump = collect_device_info(args.adb, serial, args.package)
        manifest["device"] = device
        manifest["app"] = app
        manifest["status"] = "collecting"
        write_json(manifest_path, manifest)
        write_json(raw_dir / "device_info.json", {"device": device, "app": app})
        (raw_dir / "dumpsys_package.txt").write_text(package_dump, encoding="utf-8")
        emit_live_meta("collecting", device=device, app=app)

        base = adb_base(args.adb, serial)
        logcat_err = (raw_dir / "logcat.stderr.txt").open("wb")
        logcat_process = subprocess.Popen(
            [
                *base,
                "logcat",
                "-b", "main",
                "-b", "system",
                "-b", "crash",
                "-v", "threadtime",
                "-T", "1",
            ],
            stdout=subprocess.PIPE,
            stderr=logcat_err,
        )
        if logcat_process.stdout is None:
            raise RunnerError("Could not open adb logcat output pipe")
        logcat_thread = threading.Thread(
            target=copy_rotating_logcat_stream,
            args=(logcat_process.stdout, raw_dir / "logcat.txt"),
            kwargs={"state": logcat_capture_state},
            name="appmarket-logcat",
            daemon=True,
        )
        logcat_thread.start()

        if args.capture_perfetto:
            try:
                perfetto_duration_s = args.duration + (15.0 if args.sampling_mode == "realtime" else 0.0)
                perfetto_process, remote_trace, _effective, perfetto_log_handle = start_perfetto(
                    args.adb,
                    serial,
                    perfetto_duration_s,
                    run_id,
                    raw_dir,
                    PERFETTO_VALIDATION_CONFIG if args.sampling_mode == "realtime" else PERFETTO_CONFIG,
                )
                manifest["perfetto_remote_trace"] = remote_trace
                manifest["perfetto_duration_s"] = perfetto_duration_s
                write_json(manifest_path, manifest)
            except RunnerError as exc:
                warnings.append(f"perfetto_start_failed:{exc}")
                perfetto_process = None

        if args.capture_screenrecord:
            try:
                screenrecord_capture = ScreenRecordCapture(
                    args.adb,
                    serial,
                    run_id,
                    args.duration,
                    flow_dir / "video",
                )
                screenrecord_capture.start()
                manifest["screenrecord"] = screenrecord_capture.status()
                write_json(manifest_path, manifest)
            except Exception as exc:  # recording is auxiliary evidence only
                warnings.append(f"screenrecord_start_failed:{exc}")
                screenrecord_capture = None

        # Establish the target PID before the sampler takes its initial CPU
        # snapshot.  Previously run_flow() force-stopped the package after the
        # sampler had started, so scheduling differences could turn a healthy
        # run into old-PID -> missing -> new-PID samples.
        run_text([*base, "shell", "am", "force-stop", args.package], timeout=20.0)
        run_text(
            [
                *base,
                "shell",
                "monkey",
                "-p", args.package,
                "-c", "android.intent.category.LAUNCHER",
                "1",
            ],
            timeout=30.0,
        )
        manifest["launch_prepared_before_sampler"] = True
        write_json(manifest_path, manifest)

        sampler_process = subprocess.Popen(
            sampler_command,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        tee_thread = threading.Thread(
            target=tee_output,
            args=(sampler_process.stdout, raw_dir / "sampler.log", "[sample] "),
            daemon=True,
        )
        tee_thread.start()

        flow_result = run_flow(
            adb_executable=args.adb,
            serial=serial,
            package=args.package,
            config_path=effective_flow_config,
            output_dir=flow_dir,
            stop_file=stop_file,
            mode=args.flow_mode,
            fixed_app_title=args.test_app_title,
            launch_app=False,
        )
        while sampler_process.poll() is None:
            if stop_file.exists():
                cancelled = True
            time.sleep(0.25)
        sampler_code = sampler_process.returncode
        tee_thread.join(timeout=3.0)
        cancelled = cancelled or sampler_code == 130 or flow_result.get("status") == "cancelled"
        finalize_screenrecord()
        finalize_logcat()

        if perfetto_process is not None:
            remote_trace = str(manifest.get("perfetto_remote_trace", ""))
            if cancelled and remote_trace and perfetto_process.poll() is None:
                try:
                    stop_remote_perfetto(args.adb, serial, remote_trace)
                    warnings.append("perfetto_stopped_for_cancellation")
                except RunnerError as exc:
                    warnings.append(f"perfetto_cancel_signal_failed:{exc}")
            try:
                perfetto_process.wait(timeout=20.0)
            except subprocess.TimeoutExpired:
                warnings.append("perfetto_did_not_finish_within_grace_period")
                if remote_trace:
                    try:
                        stop_remote_perfetto(args.adb, serial, remote_trace)
                    except RunnerError as exc:
                        warnings.append(f"perfetto_stop_signal_failed:{exc}")
                try:
                    perfetto_process.wait(timeout=8.0)
                except subprocess.TimeoutExpired:
                    terminate_process(perfetto_process)
            if perfetto_log_handle:
                perfetto_log_handle.flush()
            if perfetto_process.returncode not in {None, 0}:
                warnings.append(f"perfetto_exit_code:{perfetto_process.returncode}")
            if remote_trace:
                local_trace = trace_dir / "appmarket.pftrace"
                pull = run_text([*base, "pull", remote_trace, str(local_trace)], timeout=120.0, check=False)
                if not local_trace.exists() or local_trace.stat().st_size == 0:
                    warnings.append(f"perfetto_pull_failed:{pull}")
                else:
                    local_trace_path = local_trace
                    manifest["perfetto_trace"] = relative_path(local_trace, repo_root)
                run_text([*base, "shell", "rm", "-f", remote_trace], timeout=20.0, check=False)

        if not (raw_dir / "metrics.csv").exists():
            raise RunnerError(f"Sampler did not produce metrics.csv (exit={sampler_code})")

        perfetto_validation_path: Path | None = None
        if args.capture_perfetto:
            perfetto_validation_path = analysis_dir / "perfetto_cpu_validation.json"
            validation = run_perfetto_cpu_validation(
                local_trace_path or (trace_dir / "appmarket.pftrace"),
                raw_dir / "metrics.csv",
                args.package,
                perfetto_validation_path,
                analysis_dir / "perfetto_cpu_validator.log",
                args.trace_processor,
            )
            manifest["perfetto_validation"] = relative_path(perfetto_validation_path, repo_root)
            analysis_status = str(validation.get("analysis_status") or "UNAVAILABLE").upper()
            manifest["perfetto_validation_status"] = analysis_status
            threshold_status = validation.get("threshold_status", "INCONCLUSIVE")
            if analysis_status != "COMPLETED":
                warnings.append(
                    "perfetto_validation_"
                    + analysis_status.lower()
                    + ":"
                    + ",".join(str(value) for value in validation.get("reason_codes", []))
                )
            elif threshold_status not in {"PASS", "NOT_EVALUATED"}:
                warnings.append(f"perfetto_threshold_status:{threshold_status}")

        manifest["status"] = "analyzing"
        manifest["sampler_exit_code"] = sampler_code
        manifest["flow"] = flow_result
        manifest["warnings"] = list(dict.fromkeys(warnings))
        write_json(manifest_path, manifest)
        emit_live_meta("analyzing")
        analyzer_command = [
            sys.executable,
            str(ANALYZER),
            "--csv", str(raw_dir / "metrics.csv"),
            "--sampler-summary", str(raw_dir / "sampler_summary.json"),
            "--manifest", str(manifest_path),
            "--flow-result", str(flow_dir / "flow_result.json"),
            "--config", str(effective_flow_config),
            "--out-dir", str(analysis_dir),
            "--artifact-dir", str(run_dir),
        ]
        if args.gateway:
            analyzer_command += ["--gateway", args.gateway]
        if args.sampling_mode == "realtime":
            analyzer_command += ["--diagnostic-csv", str(raw_dir / "diagnostic_metrics.csv")]
        if perfetto_validation_path is not None:
            analyzer_command += ["--perfetto-validation", str(perfetto_validation_path)]
        if local_trace_path is not None:
            analyzer_command += ["--perfetto-trace", str(local_trace_path)]
        analysis = subprocess.run(
            analyzer_command,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )
        (analysis_dir / "analyzer.log").write_text(analysis.stdout, encoding="utf-8")
        print(analysis.stdout, end="")
        # The analyzer registers every completed JSON/Markdown/PDF/advice
        # artifact. Reload even on analyzer failure so raw/partial report
        # evidence and the precise report_generation_error are not erased by
        # this runner's older in-memory manifest.
        try:
            analyzed_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            if isinstance(analyzed_manifest, dict):
                manifest.update(analyzed_manifest)
        except (OSError, json.JSONDecodeError):
            pass
        if analysis.returncode != 0:
            raise RunnerError(f"Analyzer failed (exit={analysis.returncode})")

        report_path = analysis_dir / "report.json"
        report = json.loads(report_path.read_text(encoding="utf-8"))
        manifest["status"] = "cancelled" if cancelled else "completed"
        manifest["completed_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
        manifest["acceptance"] = report.get("acceptance", "INCONCLUSIVE")
        manifest["report_json"] = relative_path(report_path, repo_root)
        write_json(manifest_path, manifest)
        emit_live_meta(
            "cancelled" if cancelled else "completed",
            acceptance=manifest["acceptance"],
            upload_status=str(report.get("upload", {}).get("status", "unknown")),
        )
        print(f"RESULT_JSON={relative_path(report_path, repo_root)}")
        print(f"ARTIFACT_DIR={relative_path(run_dir, repo_root)}")
        print(f"运行结果：{manifest['acceptance']}，产物 {manifest['artifact_dir']}")
        return 130 if cancelled else 0
    except (RunnerError, FlowError, OSError, json.JSONDecodeError) as exc:
        manifest["status"] = "cancelled" if stop_file.exists() else "failed"
        manifest["error"] = str(exc)
        manifest["completed_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
        analyzed_warnings = manifest.get("warnings", [])
        analyzed_warnings = analyzed_warnings if isinstance(analyzed_warnings, list) else []
        manifest["warnings"] = list(dict.fromkeys([*analyzed_warnings, *warnings]))
        write_json(manifest_path, manifest)
        emit_live_meta(manifest["status"], error=manifest["error"])
        print(f"ERROR: {exc}", file=sys.stderr)
        print(f"ARTIFACT_DIR={relative_path(run_dir, repo_root)}")
        return 130 if stop_file.exists() else 2
    except KeyboardInterrupt:
        stop_file.parent.mkdir(parents=True, exist_ok=True)
        stop_file.touch()
        manifest["status"] = "cancelled"
        manifest["completed_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
        write_json(manifest_path, manifest)
        emit_live_meta("cancelled")
        print("用户取消，正在停止采集。")
        return 130
    finally:
        terminate_process(sampler_process)
        finalize_logcat()
        finalize_screenrecord()
        if perfetto_process is not None and perfetto_process.poll() is None:
            remote_trace = str(manifest.get("perfetto_remote_trace", ""))
            if remote_trace:
                try:
                    stop_remote_perfetto(args.adb, serial, remote_trace)
                except RunnerError as exc:
                    warnings.append(f"perfetto_cleanup_signal_failed:{exc}")
            terminate_process(perfetto_process)
        remote_trace = str(manifest.get("perfetto_remote_trace", ""))
        if remote_trace:
            try:
                run_text(
                    [*adb_base(args.adb, serial), "shell", "rm", "-f", remote_trace],
                    timeout=20.0,
                    check=False,
                )
            except RunnerError as exc:
                warnings.append(f"perfetto_remote_cleanup_failed:{exc}")
        for handle in (logcat_err, perfetto_log_handle):
            try:
                if handle:
                    handle.close()
            except Exception:
                pass
        analyzed_warnings = manifest.get("warnings", [])
        analyzed_warnings = analyzed_warnings if isinstance(analyzed_warnings, list) else []
        manifest["warnings"] = list(dict.fromkeys([*analyzed_warnings, *warnings]))
        try:
            write_json(manifest_path, manifest)
        except OSError:
            pass


if __name__ == "__main__":
    raise SystemExit(main())
