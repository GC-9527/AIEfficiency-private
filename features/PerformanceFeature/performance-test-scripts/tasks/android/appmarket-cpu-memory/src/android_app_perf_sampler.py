#!/usr/bin/env python3
"""Sample Android app CPU and memory through adb.

CPU metrics:
  cpu_one_core_equiv_pct:
      100% means the process used one logical CPU core continuously.
      On an N-core device the theoretical maximum is N * 100%.
  cpu_device_normalized_pct:
      Share of all logical CPU capacity. Range is normally 0..100%.

Memory metrics:
  pss_mb:
      Sum of Total PSS for all matching package processes. This is the
      recommended process RAM-weight metric for comparisons on Android.
  rss_mb:
      Sum of process RSS. Shared pages can be counted more than once when the
      app has multiple processes, so PSS should be the primary acceptance metric.

The script matches the main process name and colon-suffixed processes, for
example com.example.app and com.example.app:remote.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import re
import statistics
import subprocess
import sys
import threading
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Iterable, Sequence


class AdbError(RuntimeError):
    pass


class SamplingCancelled(RuntimeError):
    pass


class RawCommandRecorder:
    """Append the exact adb command outputs used to derive each metric."""

    def __init__(self, path: Path | None) -> None:
        self.path = path
        if self.path:
            self.path.parent.mkdir(parents=True, exist_ok=True)

    def append(
        self,
        command: Sequence[str],
        stdout: str,
        stderr: str,
        returncode: int,
        elapsed_s: float,
    ) -> None:
        if not self.path:
            return
        row = {
            "wall_time_local": time.strftime("%Y-%m-%d %H:%M:%S"),
            "command": list(command),
            "returncode": returncode,
            "elapsed_s": round(elapsed_s, 4),
            "stdout": stdout,
            "stderr": stderr,
        }
        with self.path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")


@dataclass(frozen=True)
class ProcCpu:
    pid: int
    name: str
    ticks: int
    start_ticks: int


@dataclass(frozen=True)
class CpuSnapshot:
    system_ticks: int
    logical_cpus: int
    processes: tuple[ProcCpu, ...]
    source_timestamp_s: float | None = None


@dataclass
class Sample:
    sample_index: int
    target_elapsed_s: float
    actual_elapsed_s: float
    wall_time_local: str
    pids: str
    process_names: str
    logical_cpus: int | None
    cpu_one_core_equiv_pct: float | None
    cpu_device_normalized_pct: float | None
    pss_mb: float | None
    rss_mb: float | None
    process_set_changed: int
    collection_latency_s: float
    note: str
    sampling_mode: str = "standard"
    cpu_metric_source: str = "adb_proc_snapshot"
    cpu_source_start_s: float | None = None
    cpu_source_end_s: float | None = None
    cpu_window_duration_s: float | None = None
    pss_metric_source: str = "dumpsys_meminfo_local"
    pss_source_elapsed_s: float | None = None
    rss_metric_source: str = "dumpsys_meminfo_local"
    rss_source_timestamp_s: float | None = None


@dataclass
class DiagnosticSample:
    diagnostic_index: int
    target_elapsed_s: float
    actual_elapsed_s: float
    source_timestamp_s: float
    wall_time_local: str
    pids: str
    process_names: str
    logical_cpus: int | None
    cpu_one_core_equiv_pct: float | None
    cpu_device_normalized_pct: float | None
    rss_mb: float | None
    rss_source_timestamp_s: float | None
    rss_fresh: bool
    process_set_changed: int
    cpu_window_duration_s: float | None
    collection_latency_s: float
    metric_source: str
    note: str


SAMPLE_FIELDNAMES = [field.name for field in Sample.__dataclass_fields__.values()]
DIAGNOSTIC_FIELDNAMES = [field.name for field in DiagnosticSample.__dataclass_fields__.values()]


def sample_output_row(sample: Sample) -> dict[str, object]:
    """Return the exact values shared by the live event and final CSV."""
    row = asdict(sample)
    for key in (
        "target_elapsed_s",
        "actual_elapsed_s",
        "cpu_one_core_equiv_pct",
        "cpu_device_normalized_pct",
        "pss_mb",
        "rss_mb",
        "rss_source_timestamp_s",
        "collection_latency_s",
        "cpu_source_start_s",
        "cpu_source_end_s",
        "cpu_window_duration_s",
        "pss_source_elapsed_s",
        "rss_source_timestamp_s",
    ):
        value = row[key]
        if isinstance(value, float):
            row[key] = round(value, 4)
    return row


def diagnostic_output_row(sample: DiagnosticSample) -> dict[str, object]:
    row = asdict(sample)
    for key in (
        "target_elapsed_s",
        "actual_elapsed_s",
        "source_timestamp_s",
        "cpu_one_core_equiv_pct",
        "cpu_device_normalized_pct",
        "rss_mb",
        "cpu_window_duration_s",
        "collection_latency_s",
    ):
        value = row[key]
        if isinstance(value, float):
            row[key] = round(value, 4)
    return row


def initialize_live_csv(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.DictWriter(handle, fieldnames=SAMPLE_FIELDNAMES)
        writer.writeheader()
        handle.flush()


def append_live_sample(path: Path, sample: Sample) -> dict[str, object]:
    """Durably expose one sample before the next five-second interval starts."""
    row = sample_output_row(sample)
    # The header is initialized once by sample(). Appending without utf-8-sig
    # avoids writing an extra BOM before every row.
    with path.open("a", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=SAMPLE_FIELDNAMES)
        writer.writerow(row)
        handle.flush()
    print("LIVE_SAMPLE_JSON=" + json.dumps(row, ensure_ascii=False, separators=(",", ":")), flush=True)
    return row


def initialize_diagnostic_csv(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.DictWriter(handle, fieldnames=DIAGNOSTIC_FIELDNAMES)
        writer.writeheader()
        handle.flush()


def append_live_diagnostic(path: Path, sample: DiagnosticSample) -> dict[str, object]:
    """Persist one diagnostic point before exposing it to the Gateway."""
    row = diagnostic_output_row(sample)
    with path.open("a", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=DIAGNOSTIC_FIELDNAMES)
        writer.writerow(row)
        handle.flush()
    print("LIVE_DIAGNOSTIC_JSON=" + json.dumps(row, ensure_ascii=False, separators=(",", ":")), flush=True)
    return row


class Adb:
    def __init__(
        self,
        executable: str = "adb",
        serial: str | None = None,
        recorder: RawCommandRecorder | None = None,
    ) -> None:
        self.base = [executable]
        if serial:
            self.base += ["-s", serial]
        self.recorder = recorder or RawCommandRecorder(None)

    def run(self, args: Sequence[str], timeout: float = 20.0) -> str:
        cmd = [*self.base, *args]
        started = time.monotonic()
        try:
            completed = subprocess.run(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout,
                check=False,
            )
        except FileNotFoundError as exc:
            raise AdbError(
                f"Cannot find adb executable: {self.base[0]!r}. Add Android SDK "
                "platform-tools to PATH or pass --adb."
            ) from exc
        except subprocess.TimeoutExpired as exc:
            raise AdbError(f"adb command timed out after {timeout}s: {' '.join(cmd)}") from exc

        stdout = completed.stdout.replace("\r\n", "\n")
        stderr = completed.stderr.replace("\r\n", "\n")
        self.recorder.append(
            command=cmd,
            stdout=stdout,
            stderr=stderr,
            returncode=completed.returncode,
            elapsed_s=time.monotonic() - started,
        )

        if completed.returncode != 0:
            message = stderr.strip() or stdout.strip()
            raise AdbError(
                f"adb command failed ({completed.returncode}): {' '.join(cmd)}\n{message}"
            )
        return stdout

    def shell(self, command: str, timeout: float = 20.0) -> str:
        return self.run(["shell", command], timeout=timeout)

    def assert_device(self) -> None:
        state = self.run(["get-state"], timeout=10.0).strip()
        if state != "device":
            raise AdbError(f"Device is not ready; adb state is {state!r}")


_PS_PID_NAME = re.compile(r"^\s*(\d+)\s+(\S+)\s*$")
_CPU_LINE = re.compile(r"^cpu(\d*)\s+(.+)$")
_TOTAL_PSS = re.compile(r"\bTOTAL\s+PSS:\s*([0-9,]+)\b", re.IGNORECASE)
_TOTAL_RSS = re.compile(r"\bTOTAL\s+RSS:\s*([0-9,]+)\b", re.IGNORECASE)
_LEGACY_TOTAL = re.compile(r"^\s*TOTAL\s+([0-9,]+)\b", re.MULTILINE)
_VM_RSS = re.compile(r"^VmRSS:\s*([0-9]+)\s*kB\s*$", re.MULTILINE)


def _matches_package(name: str, package: str, include_colon_processes: bool) -> bool:
    if name == package:
        return True
    return include_colon_processes and name.startswith(package + ":")


def list_package_processes(
    adb: Adb, package: str, include_colon_processes: bool
) -> list[tuple[int, str]]:
    """Return (pid, process_name) for the package.

    Uses the modern toybox ps format first and falls back to the generic format.
    """
    outputs: list[str] = []
    for command in ("ps -A -o PID,NAME", "ps -A"):
        try:
            outputs.append(adb.shell(command, timeout=10.0))
            break
        except AdbError:
            continue

    if not outputs:
        raise AdbError("Unable to run ps on the device")

    out = outputs[0]
    found: dict[int, str] = {}
    for raw_line in out.splitlines():
        line = raw_line.strip()
        if not line or line.upper().startswith("PID ") or line.upper() == "PID NAME":
            continue

        match = _PS_PID_NAME.match(line)
        if match:
            pid = int(match.group(1))
            name = match.group(2)
        else:
            parts = line.split()
            # Generic Android ps generally has USER PID ... NAME.
            if len(parts) < 2 or not parts[1].isdigit():
                continue
            pid = int(parts[1])
            name = parts[-1]

        if _matches_package(name, package, include_colon_processes):
            found[pid] = name

    # Exact-main-process fallback for builds with an unusual ps implementation.
    if not found:
        try:
            pidof = adb.shell(f"pidof {package}", timeout=5.0).strip()
        except AdbError:
            pidof = ""
        for token in pidof.split():
            if token.isdigit():
                found[int(token)] = package

    return sorted(found.items())


def parse_system_cpu(text: str) -> tuple[int, int]:
    aggregate: list[int] | None = None
    logical_cpus = 0
    for line in text.splitlines():
        match = _CPU_LINE.match(line.strip())
        if not match:
            continue
        suffix, values_text = match.groups()
        values = [int(value) for value in values_text.split() if value.isdigit()]
        if not values:
            continue
        if suffix == "":
            # user, nice, system, idle, iowait, irq, softirq, steal.
            # guest and guest_nice are already included in user/nice and should
            # not be added again.
            aggregate = values[:8]
        else:
            logical_cpus += 1

    if aggregate is None or logical_cpus <= 0:
        raise ValueError("Could not parse aggregate/per-core CPU counters from /proc/stat")
    return sum(aggregate), logical_cpus


def parse_proc_stat(pid: int, name: str, line: str) -> ProcCpu:
    # Field 2 (comm) is enclosed in parentheses and may contain spaces.
    closing = line.rfind(")")
    opening = line.find("(")
    if opening < 0 or closing <= opening:
        raise ValueError(f"Invalid /proc/{pid}/stat line")
    tail = line[closing + 2 :].split()  # Starts at field 3 (state).
    if len(tail) < 20:
        raise ValueError(f"Incomplete /proc/{pid}/stat line")
    utime = int(tail[11])  # field 14
    stime = int(tail[12])  # field 15
    start_ticks = int(tail[19])  # field 22
    return ProcCpu(pid=pid, name=name, ticks=utime + stime, start_ticks=start_ticks)


def take_cpu_snapshot(adb: Adb, processes: Sequence[tuple[int, str]]) -> CpuSnapshot:
    command_parts = [
        "echo __UPTIME__",
        "cat /proc/uptime",
        "echo __CPU__",
        "grep '^cpu' /proc/stat",
    ]
    for pid, _ in processes:
        command_parts += [f"echo __PID__ {pid}", f"cat /proc/{pid}/stat 2>/dev/null || true"]
    out = adb.shell("; ".join(command_parts), timeout=15.0)

    cpu_text: list[str] = []
    pid_lines: dict[int, str] = {}
    current_pid: int | None = None
    in_cpu = False
    in_uptime = False
    source_timestamp_s: float | None = None

    for raw_line in out.splitlines():
        line = raw_line.strip()
        if line == "__UPTIME__":
            in_uptime = True
            in_cpu = False
            current_pid = None
            continue
        if line == "__CPU__":
            in_uptime = False
            in_cpu = True
            current_pid = None
            continue
        if line.startswith("__PID__ "):
            in_cpu = False
            parts = line.split()
            current_pid = int(parts[1]) if len(parts) == 2 and parts[1].isdigit() else None
            continue
        if in_uptime and line:
            try:
                source_timestamp_s = float(line.split()[0])
            except (ValueError, IndexError):
                source_timestamp_s = None
            in_uptime = False
        elif in_cpu and line.startswith("cpu"):
            cpu_text.append(line)
        elif current_pid is not None and line:
            pid_lines[current_pid] = line
            current_pid = None

    system_ticks, logical_cpus = parse_system_cpu("\n".join(cpu_text))
    name_by_pid = dict(processes)
    parsed: list[ProcCpu] = []
    for pid, line in pid_lines.items():
        try:
            parsed.append(parse_proc_stat(pid, name_by_pid.get(pid, str(pid)), line))
        except (ValueError, IndexError):
            continue

    return CpuSnapshot(
        system_ticks=system_ticks,
        logical_cpus=logical_cpus,
        processes=tuple(sorted(parsed, key=lambda proc: proc.pid)),
        source_timestamp_s=source_timestamp_s,
    )


def parse_meminfo_kb(text: str) -> tuple[int | None, int | None]:
    pss_match = _TOTAL_PSS.search(text)
    rss_match = _TOTAL_RSS.search(text)
    pss_kb = int(pss_match.group(1).replace(",", "")) if pss_match else None
    rss_kb = int(rss_match.group(1).replace(",", "")) if rss_match else None

    # Older Android versions expose a table whose TOTAL row starts with PSS.
    if pss_kb is None:
        legacy = _LEGACY_TOTAL.search(text)
        if legacy:
            pss_kb = int(legacy.group(1).replace(",", ""))
    return pss_kb, rss_kb


def read_memory_kb(adb: Adb, processes: Sequence[tuple[int, str]]) -> tuple[int | None, int | None, list[str]]:
    if not processes:
        return None, None, ["process_not_running"]

    total_pss = 0
    total_rss = 0
    pss_count = 0
    rss_count = 0
    notes: list[str] = []

    for pid, _ in processes:
        try:
            # A regular per-process meminfo dump asks the app process for a
            # full report and forces an Explicit GC on this Android build.
            # --local reads system-side accounting instead, so the 5-second
            # sampler does not manufacture CPU/GC load in the target app.
            meminfo = adb.shell(f"dumpsys meminfo --local {pid}", timeout=20.0)
        except AdbError as exc:
            notes.append(f"meminfo_failed_pid_{pid}")
            continue

        pss_kb, rss_kb = parse_meminfo_kb(meminfo)
        if pss_kb is not None:
            total_pss += pss_kb
            pss_count += 1
        else:
            notes.append(f"pss_unavailable_pid_{pid}")

        if rss_kb is None:
            try:
                status = adb.shell(f"cat /proc/{pid}/status 2>/dev/null || true", timeout=5.0)
                match = _VM_RSS.search(status)
                if match:
                    rss_kb = int(match.group(1))
            except AdbError:
                pass

        if rss_kb is not None:
            total_rss += rss_kb
            rss_count += 1
        else:
            notes.append(f"rss_unavailable_pid_{pid}")

    return (
        total_pss if pss_count else None,
        total_rss if rss_count else None,
        notes,
    )


def identity_map(snapshot: CpuSnapshot) -> dict[int, tuple[int, int, str]]:
    return {
        proc.pid: (proc.start_ticks, proc.ticks, proc.name)
        for proc in snapshot.processes
    }


def compute_cpu_percentages(
    previous: CpuSnapshot, current: CpuSnapshot
) -> tuple[float | None, float | None, bool, str]:
    prev = identity_map(previous)
    curr = identity_map(current)
    prev_ids = {(pid, values[0], values[2]) for pid, values in prev.items()}
    curr_ids = {(pid, values[0], values[2]) for pid, values in curr.items()}
    changed = prev_ids != curr_ids

    delta_system = current.system_ticks - previous.system_ticks
    if delta_system <= 0:
        return None, None, changed, "invalid_system_cpu_delta"
    if not previous.processes or not current.processes:
        return None, None, changed, "process_not_running"
    if changed:
        # A new/restarted process has unknown CPU time before its first snapshot;
        # reporting a partial interval would look precise but be wrong.
        return None, None, True, "process_set_changed_cpu_interval_invalid"

    delta_process = 0
    for pid, (start_ticks, curr_ticks, _name) in curr.items():
        prev_start, prev_ticks, _ = prev[pid]
        if start_ticks != prev_start or curr_ticks < prev_ticks:
            return None, None, True, "process_restarted_cpu_interval_invalid"
        delta_process += curr_ticks - prev_ticks

    device_pct = 100.0 * delta_process / delta_system
    logical_cpus = current.logical_cpus
    one_core_equiv_pct = device_pct * logical_cpus
    return one_core_equiv_pct, device_pct, False, ""


REALTIME_CPU_INTERVAL_S = 0.5
REALTIME_RSS_INTERVAL_S = 1.0


@dataclass(frozen=True)
class RealtimePoint:
    diagnostic: DiagnosticSample
    snapshot: CpuSnapshot
    processes: tuple[tuple[int, str], ...]


def build_realtime_device_script(
    package: str,
    include_colon_processes: bool,
    cpu_interval_s: float = REALTIME_CPU_INTERVAL_S,
) -> str:
    """Build the device-side persistent /proc collector.

    Process discovery is refreshed once per second. CPU counters are emitted
    every 500 ms and VmRSS is emitted once per second through the same adb
    stream, avoiding a new adb process for every diagnostic point.
    """
    include_colon = "1" if include_colon_processes else "0"
    return f"""#!/system/bin/sh
package='{package}'
include_colon='{include_colon}'
interval='{cpu_interval_s:g}'
seq=0
next_due=''
trap 'exit 0' HUP TERM INT
discover_targets() {{
  ps -A -o PID,NAME 2>/dev/null | awk -v package="$package" -v children="$include_colon" '
    NR > 1 {{
      pid=$1
      name=$2
      if (name == package || (children == "1" && index(name, package ":") == 1)) {{
        print pid ":" name
      }}
    }}'
}}
targets=$(discover_targets)
printf '__APP_PERF_COLLECTOR_PID__\\t%s\\n' "$$"
while :; do
  if [ -n "$next_due" ]; then
    now=$(cut -d ' ' -f 1 /proc/uptime)
    delay=$(awk -v due="$next_due" -v now="$now" '
      BEGIN {{
        remaining = due - now
        if (remaining > 0.001) printf "%.3f", remaining
        else print "0"
      }}')
    [ "$delay" = '0' ] || sleep "$delay"
  fi
  loop_started=$(cut -d ' ' -f 1 /proc/uptime)
  if [ -z "$next_due" ]; then
    next_due="$loop_started"
  fi
  seq=$((seq + 1))
  printf '__APP_PERF_BEGIN__\\t%s\\t%s\\n' "$seq" "$loop_started"
  grep '^cpu' /proc/stat
  rss_due=0
  if [ $((seq % 2)) -eq 1 ]; then
    rss_due=1
    printf '__APP_PERF_RSS_DUE__\\n'
  fi
  for target in $targets; do
    pid=${{target%%:*}}
    name=${{target#*:}}
    [ -r "/proc/$pid/stat" ] || continue
    printf '__APP_PERF_PID__\\t%s\\t%s\\n' "$pid" "$name"
    cat "/proc/$pid/stat" 2>/dev/null || true
    if [ "$rss_due" = '1' ]; then
      rss=$(grep '^VmRSS:' "/proc/$pid/status" 2>/dev/null | awk '{{print $2}}')
      if [ -n "$rss" ]; then
        printf '__APP_PERF_RSS__\\t%s\\t%s\\n' "$pid" "$rss"
      fi
    fi
  done
  printf '__APP_PERF_END__\\t%s\\n' "$seq"
  if [ $((seq % 2)) -eq 0 ]; then
    targets=$(discover_targets)
  fi
  next_due=$(awk -v due="$next_due" -v interval="$interval" '
    BEGIN {{ printf "%.3f", due + interval }}')
done
"""


def build_realtime_point(
    *,
    sequence: int,
    source_timestamp_s: float,
    cpu_lines: Sequence[str],
    processes: Sequence[tuple[int, str]],
    pid_stat_lines: dict[int, str],
    rss_by_pid: dict[int, int],
    rss_fresh: bool,
    previous: CpuSnapshot | None,
    first_source_timestamp_s: float,
    actual_elapsed_s: float,
    collection_latency_s: float,
) -> RealtimePoint:
    system_ticks, logical_cpus = parse_system_cpu("\n".join(cpu_lines))
    name_by_pid = dict(processes)
    parsed: list[ProcCpu] = []
    notes: list[str] = []
    for pid, line in pid_stat_lines.items():
        try:
            parsed.append(parse_proc_stat(pid, name_by_pid.get(pid, str(pid)), line))
        except (ValueError, IndexError):
            notes.append(f"proc_stat_unavailable_pid_{pid}")
    snapshot = CpuSnapshot(
        system_ticks=system_ticks,
        logical_cpus=logical_cpus,
        processes=tuple(sorted(parsed, key=lambda proc: proc.pid)),
        source_timestamp_s=source_timestamp_s,
    )
    if previous is None:
        one_core_pct = None
        device_pct = None
        changed = False
        notes.append("cpu_baseline")
        cpu_window_s = None
    else:
        one_core_pct, device_pct, changed, cpu_note = compute_cpu_percentages(previous, snapshot)
        if cpu_note:
            notes.append(cpu_note)
        cpu_window_s = (
            source_timestamp_s - previous.source_timestamp_s
            if previous.source_timestamp_s is not None
            else None
        )
        if cpu_window_s is not None and cpu_window_s <= 0:
            cpu_window_s = None
            notes.append("invalid_source_timestamp_delta")

    rss_mb = None
    if rss_fresh:
        if rss_by_pid:
            rss_mb = sum(rss_by_pid.values()) / 1024.0
        else:
            notes.append("rss_unavailable")
    diagnostic = DiagnosticSample(
        diagnostic_index=sequence,
        target_elapsed_s=max(0.0, source_timestamp_s - first_source_timestamp_s),
        actual_elapsed_s=max(0.0, actual_elapsed_s),
        source_timestamp_s=source_timestamp_s,
        wall_time_local=time.strftime("%Y-%m-%d %H:%M:%S"),
        pids=";".join(str(pid) for pid, _ in processes),
        process_names=";".join(name for _, name in processes),
        logical_cpus=logical_cpus,
        cpu_one_core_equiv_pct=one_core_pct,
        cpu_device_normalized_pct=device_pct,
        rss_mb=rss_mb,
        rss_source_timestamp_s=source_timestamp_s if rss_fresh else None,
        rss_fresh=bool(rss_fresh),
        process_set_changed=int(changed),
        cpu_window_duration_s=cpu_window_s,
        collection_latency_s=max(0.0, collection_latency_s),
        metric_source="device_proc_stream_500ms",
        note=";".join(dict.fromkeys(notes)),
    )
    return RealtimePoint(
        diagnostic=diagnostic,
        snapshot=snapshot,
        processes=tuple(sorted(processes)),
    )


class RealtimeCollector:
    """Own a persistent adb stream and expose timestamped diagnostic points."""

    def __init__(
        self,
        adb: Adb,
        package: str,
        include_colon_processes: bool,
        diagnostic_out: Path,
        raw_stream_out: Path,
    ) -> None:
        self.adb = adb
        self.package = package
        self.include_colon_processes = include_colon_processes
        self.diagnostic_out = diagnostic_out
        self.raw_stream_out = raw_stream_out
        self.device_script_out = diagnostic_out.with_name("realtime_collector_device.sh")
        self.remote_script = f"/data/local/tmp/appmarket_perf_{time.time_ns()}.sh"
        self.points: list[RealtimePoint] = []
        self._condition = threading.Condition()
        self._process: subprocess.Popen[str] | None = None
        self._thread: threading.Thread | None = None
        self._batch: dict[str, Any] | None = None
        self._pending_pid: int | None = None
        self._previous_snapshot: CpuSnapshot | None = None
        self._first_source_timestamp_s: float | None = None
        self._host_start_s = 0.0
        self._remote_pid: int | None = None
        self._error: str | None = None
        self._stopping = False
        self.stopped_cleanly = False

    def start(self, host_start_s: float) -> None:
        initialize_diagnostic_csv(self.diagnostic_out)
        self.raw_stream_out.parent.mkdir(parents=True, exist_ok=True)
        self.device_script_out.write_text(
            build_realtime_device_script(self.package, self.include_colon_processes),
            encoding="utf-8",
            newline="\n",
        )
        self.adb.run(["push", str(self.device_script_out), self.remote_script], timeout=20.0)
        self.adb.shell(f"chmod 700 {self.remote_script}", timeout=10.0)
        self._host_start_s = host_start_s
        try:
            self._process = subprocess.Popen(
                [*self.adb.base, "exec-out", "sh", self.remote_script],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
            )
        except OSError as exc:
            self._cleanup_remote()
            raise AdbError(f"Could not start realtime adb collector: {exc}") from exc
        self._thread = threading.Thread(
            target=self._read_loop,
            name="appmarket-realtime-proc-collector",
            daemon=True,
        )
        self._thread.start()

    def _read_loop(self) -> None:
        process = self._process
        if process is None or process.stdout is None:
            with self._condition:
                self._error = "realtime collector stdout is unavailable"
                self._condition.notify_all()
            return
        try:
            with self.raw_stream_out.open("w", encoding="utf-8") as raw_handle:
                for raw_line in process.stdout:
                    received_s = time.monotonic()
                    line = raw_line.rstrip("\r\n")
                    raw_handle.write(
                        json.dumps(
                            {"received_monotonic_s": round(received_s, 6), "line": line},
                            ensure_ascii=False,
                        )
                        + "\n"
                    )
                    raw_handle.flush()
                    self._consume_line(line, received_s)
        except Exception as exc:  # Preserve a precise failure for the main sampler.
            with self._condition:
                if not self._stopping:
                    self._error = f"realtime collector reader failed: {exc}"
                self._condition.notify_all()
        finally:
            return_code = process.poll()
            if return_code is None:
                try:
                    return_code = process.wait(timeout=1.0)
                except subprocess.TimeoutExpired:
                    return_code = None
            with self._condition:
                if not self._stopping and self._error is None:
                    self._error = f"realtime collector exited unexpectedly (code={return_code})"
                self._condition.notify_all()

    def _consume_line(self, line: str, received_s: float) -> None:
        if line.startswith("__APP_PERF_COLLECTOR_PID__\t"):
            token = line.split("\t", 1)[1]
            if token.isdigit():
                self._remote_pid = int(token)
            return
        if line.startswith("__APP_PERF_BEGIN__\t"):
            parts = line.split("\t")
            if len(parts) != 3:
                return
            try:
                sequence = int(parts[1])
                source_timestamp_s = float(parts[2])
            except ValueError:
                return
            self._batch = {
                "sequence": sequence,
                "source_timestamp_s": source_timestamp_s,
                "cpu_lines": [],
                "processes": [],
                "pid_stat_lines": {},
                "rss_by_pid": {},
                "rss_fresh": False,
                "received_start_s": received_s,
            }
            self._pending_pid = None
            return
        batch = self._batch
        if batch is None:
            return
        if line == "__APP_PERF_RSS_DUE__":
            batch["rss_fresh"] = True
            return
        if line.startswith("__APP_PERF_PID__\t"):
            parts = line.split("\t", 2)
            self._pending_pid = int(parts[1]) if len(parts) == 3 and parts[1].isdigit() else None
            if self._pending_pid is not None:
                batch["processes"].append((self._pending_pid, parts[2]))
            return
        if line.startswith("__APP_PERF_RSS__\t"):
            parts = line.split("\t")
            if len(parts) == 3 and parts[1].isdigit() and parts[2].isdigit():
                batch["rss_by_pid"][int(parts[1])] = int(parts[2])
            return
        if line.startswith("__APP_PERF_END__\t"):
            parts = line.split("\t")
            if len(parts) == 2 and parts[1].isdigit() and int(parts[1]) == batch["sequence"]:
                self._finalize_batch(batch, received_s)
            self._batch = None
            self._pending_pid = None
            return
        if line.startswith("cpu"):
            batch["cpu_lines"].append(line)
            return
        if self._pending_pid is not None:
            if line and not line.startswith("cat:"):
                batch["pid_stat_lines"][self._pending_pid] = line
            self._pending_pid = None

    def _finalize_batch(self, batch: dict[str, Any], received_s: float) -> None:
        source_timestamp_s = float(batch["source_timestamp_s"])
        if self._first_source_timestamp_s is None:
            self._first_source_timestamp_s = source_timestamp_s
        try:
            point = build_realtime_point(
                sequence=int(batch["sequence"]),
                source_timestamp_s=source_timestamp_s,
                cpu_lines=list(batch["cpu_lines"]),
                processes=list(batch["processes"]),
                pid_stat_lines=dict(batch["pid_stat_lines"]),
                rss_by_pid=dict(batch["rss_by_pid"]),
                rss_fresh=bool(batch["rss_fresh"]),
                previous=self._previous_snapshot,
                first_source_timestamp_s=self._first_source_timestamp_s,
                actual_elapsed_s=received_s - self._host_start_s,
                collection_latency_s=received_s - float(batch["received_start_s"]),
            )
        except (ValueError, TypeError, KeyError) as exc:
            with self._condition:
                self._error = f"invalid realtime collector batch: {exc}"
                self._condition.notify_all()
            return
        append_live_diagnostic(self.diagnostic_out, point.diagnostic)
        with self._condition:
            self.points.append(point)
            self._previous_snapshot = point.snapshot
            self._condition.notify_all()

    def wait_for_boundary(
        self,
        target_elapsed_s: float,
        stop_file: Path | None,
        grace_s: float = 30.0,
    ) -> RealtimePoint:
        deadline = self._host_start_s + target_elapsed_s + grace_s
        with self._condition:
            while True:
                if stop_file and stop_file.exists():
                    raise SamplingCancelled("sampling cancelled while waiting for realtime CPU data")
                for point in self.points:
                    if point.diagnostic.target_elapsed_s + 1e-6 >= target_elapsed_s:
                        return point
                if self._error:
                    raise AdbError(self._error)
                if time.monotonic() >= deadline:
                    raise AdbError(
                        f"realtime collector did not reach t={target_elapsed_s:g}s within {grace_s:g}s grace"
                    )
                self._condition.wait(timeout=0.2)

    def latest_rss(self, boundary: RealtimePoint) -> tuple[float | None, float | None]:
        with self._condition:
            for point in reversed(self.points):
                if point.diagnostic.diagnostic_index > boundary.diagnostic.diagnostic_index:
                    continue
                if point.diagnostic.rss_mb is not None:
                    return point.diagnostic.rss_mb, point.diagnostic.source_timestamp_s
        return None, None

    def summary(self, duration_s: float) -> dict[str, object]:
        with self._condition:
            points = list(self.points)

        def stats(values: Iterable[float | None]) -> dict[str, float | int | None]:
            clean = finite_values(values)
            return {
                "valid_samples": len(clean),
                "mean": round(statistics.fmean(clean), 4) if clean else None,
                "peak": round(max(clean), 4) if clean else None,
                "min": round(min(clean), 4) if clean else None,
            }

        return {
            "status": "completed" if self.stopped_cleanly and not self._error else "failed",
            "cpu_interval_ms": int(REALTIME_CPU_INTERVAL_S * 1000),
            "rss_interval_ms": int(REALTIME_RSS_INTERVAL_S * 1000),
            "pss_interval_ms": 5000,
            "expected_cpu_points": int(round(duration_s / REALTIME_CPU_INTERVAL_S)) + 1,
            "actual_cpu_points": len(points),
            "cpu_device_normalized_pct": stats(
                point.diagnostic.cpu_device_normalized_pct for point in points
            ),
            "cpu_one_core_equiv_pct": stats(
                point.diagnostic.cpu_one_core_equiv_pct for point in points
            ),
            "rss_mb": stats(point.diagnostic.rss_mb for point in points),
            "stream_error": self._error,
            "stopped_cleanly": self.stopped_cleanly,
        }

    def _cleanup_remote(self) -> None:
        try:
            self.adb.shell(f"rm -f {self.remote_script}", timeout=10.0)
        except AdbError:
            pass

    def stop(self) -> None:
        self._stopping = True
        if self._remote_pid is not None:
            command = (
                f"if [ -r /proc/{self._remote_pid}/cmdline ]; then "
                f"cmd=$(tr '\\000' ' ' < /proc/{self._remote_pid}/cmdline 2>/dev/null); "
                f"case \"$cmd\" in *\"{self.remote_script}\"*) kill {self._remote_pid} 2>/dev/null || true ;; esac; "
                "fi; "
                f"rm -f {self.remote_script}"
            )
            try:
                self.adb.shell(command, timeout=10.0)
            except AdbError:
                pass
        process = self._process
        if process is not None and process.poll() is None:
            try:
                process.wait(timeout=3.0)
            except subprocess.TimeoutExpired:
                process.terminate()
                try:
                    process.wait(timeout=2.0)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=2.0)
        if self._thread is not None:
            self._thread.join(timeout=3.0)
        self._cleanup_remote()
        self.stopped_cleanly = bool(
            (process is None or process.poll() is not None)
            and (self._thread is None or not self._thread.is_alive())
        )


def finite_values(values: Iterable[float | None]) -> list[float]:
    return [float(value) for value in values if value is not None and math.isfinite(value)]


def summarize(
    samples: Sequence[Sample],
    package: str,
    duration: float,
    interval: float,
    *,
    cancelled: bool = False,
    sampling_mode: str = "standard",
    diagnostic: dict[str, object] | None = None,
) -> dict[str, object]:
    def stats(values: Iterable[float | None]) -> dict[str, float | int | None]:
        clean = finite_values(values)
        return {
            "valid_samples": len(clean),
            "mean": round(statistics.fmean(clean), 4) if clean else None,
            "peak": round(max(clean), 4) if clean else None,
            "min": round(min(clean), 4) if clean else None,
        }

    result: dict[str, object] = {
        "package": package,
        "requested_duration_s": duration,
        "interval_s": interval,
        "sampling_mode": sampling_mode,
        "expected_rows": int(round(duration / interval)),
        "total_rows": len(samples),
        "cancelled": cancelled,
        "cpu_one_core_equiv_pct": stats(s.cpu_one_core_equiv_pct for s in samples),
        "cpu_device_normalized_pct": stats(s.cpu_device_normalized_pct for s in samples),
        "pss_mb": stats(s.pss_mb for s in samples),
        "rss_mb": stats(s.rss_mb for s in samples),
        "rows_with_process_change": sum(s.process_set_changed for s in samples),
        "metric_definitions": {
            "cpu_one_core_equiv_pct": "100% equals one logical core fully occupied; may exceed 100%",
            "cpu_device_normalized_pct": "share of all logical CPU capacity; normally 0..100%",
            "pss_mb": "sum of Android Total PSS for matching package processes",
            "rss_mb": "sum of RSS; shared pages may be counted repeatedly across processes",
        },
    }
    if diagnostic is not None:
        result["diagnostic"] = diagnostic
    return result


def write_csv(path: Path, samples: Sequence[Sample]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.DictWriter(handle, fieldnames=SAMPLE_FIELDNAMES)
        writer.writeheader()
        for sample in samples:
            writer.writerow(sample_output_row(sample))


def wait_for_process(
    adb: Adb,
    package: str,
    include_colon_processes: bool,
    timeout_s: float,
    stop_file: Path | None = None,
) -> list[tuple[int, str]]:
    deadline = time.monotonic() + timeout_s
    while True:
        if stop_file and stop_file.exists():
            raise SamplingCancelled("sampling cancelled before the package process appeared")
        processes = list_package_processes(adb, package, include_colon_processes)
        if processes:
            return processes
        if time.monotonic() >= deadline:
            raise AdbError(
                f"Package process {package!r} did not appear within {timeout_s:.1f}s. "
                "Launch the app first or use --launch."
            )
        time.sleep(0.25)


def launch_package(adb: Adb, package: str) -> None:
    # monkey is part of the Android platform and resolves the package's launcher
    # activity without requiring the activity class name.
    adb.shell(f"monkey -p {package} -c android.intent.category.LAUNCHER 1", timeout=20.0)


def sample_realtime(
    args: argparse.Namespace,
    adb: Adb,
    include_colon: bool,
) -> tuple[list[Sample], dict[str, object]]:
    """Collect 500 ms CPU / 1 s RSS while preserving formal 5 s rows."""
    sample_count = int(round(args.duration / args.interval))
    if sample_count <= 0:
        raise ValueError("duration/interval must produce at least one sample")
    diagnostic_out = args.diagnostic_out or args.out.with_name("diagnostic_metrics.csv")
    diagnostic_raw_out = args.diagnostic_raw_out or args.out.with_name("realtime_stream.jsonl")
    initialize_live_csv(args.out)
    start = time.monotonic()
    collector = RealtimeCollector(
        adb=adb,
        package=args.package,
        include_colon_processes=include_colon,
        diagnostic_out=diagnostic_out,
        raw_stream_out=diagnostic_raw_out,
    )
    rows: list[Sample] = []
    cancelled = False
    collector_started = False
    collector_stopped = False
    print(
        f"Realtime diagnostics for {args.package}: CPU every {REALTIME_CPU_INTERVAL_S:g}s, "
        f"RSS every {REALTIME_RSS_INTERVAL_S:g}s; formal CPU/PSS every {args.interval:g}s "
        f"for {args.duration:g}s ({sample_count} formal rows)",
        flush=True,
    )
    try:
        collector.start(start)
        collector_started = True
        previous_boundary = collector.wait_for_boundary(0.0, args.stop_file)
        for index in range(1, sample_count + 1):
            target_elapsed = index * args.interval
            try:
                boundary = collector.wait_for_boundary(target_elapsed, args.stop_file)
            except SamplingCancelled:
                cancelled = True
                print("Sampling cancellation requested; writing partial results.", flush=True)
                break

            collection_start = time.monotonic()
            note_parts: list[str] = []
            processes = list(boundary.processes)
            one_core_pct, device_pct, changed, cpu_note = compute_cpu_percentages(
                previous_boundary.snapshot,
                boundary.snapshot,
            )
            if cpu_note:
                note_parts.append(cpu_note)
            rss_mb, rss_source_timestamp_s = collector.latest_rss(boundary)

            # Stop the persistent stream at the requested final CPU boundary;
            # the final formal PSS snapshot is collected immediately afterward.
            if index == sample_count:
                collector.stop()
                collector_stopped = True

            pss_kb, _dumpsys_rss_kb, mem_notes = read_memory_kb(adb, processes)
            note_parts.extend(mem_notes)
            pss_source_elapsed = time.monotonic() - start

            actual_elapsed = time.monotonic() - start
            latency = time.monotonic() - collection_start
            cpu_start_s = previous_boundary.snapshot.source_timestamp_s
            cpu_end_s = boundary.snapshot.source_timestamp_s
            cpu_window_s = (
                cpu_end_s - cpu_start_s
                if cpu_start_s is not None and cpu_end_s is not None
                else None
            )
            row = Sample(
                sample_index=index,
                target_elapsed_s=target_elapsed,
                actual_elapsed_s=actual_elapsed,
                wall_time_local=time.strftime("%Y-%m-%d %H:%M:%S"),
                pids=";".join(str(pid) for pid, _ in processes),
                process_names=";".join(name for _, name in processes),
                logical_cpus=boundary.snapshot.logical_cpus,
                cpu_one_core_equiv_pct=one_core_pct,
                cpu_device_normalized_pct=device_pct,
                pss_mb=(pss_kb / 1024.0) if pss_kb is not None else None,
                rss_mb=rss_mb,
                process_set_changed=int(changed),
                collection_latency_s=latency,
                note=";".join(dict.fromkeys(note_parts)),
                sampling_mode="realtime",
                cpu_metric_source="device_proc_stream_500ms_boundary",
                cpu_source_start_s=cpu_start_s,
                cpu_source_end_s=cpu_end_s,
                cpu_window_duration_s=cpu_window_s,
                pss_metric_source="dumpsys_meminfo_local_5s",
                pss_source_elapsed_s=pss_source_elapsed,
                rss_metric_source="proc_status_1s",
                rss_source_timestamp_s=rss_source_timestamp_s,
            )
            rows.append(row)
            append_live_sample(args.out, row)
            previous_boundary = boundary
            cpu_display = "N/A" if one_core_pct is None else f"{one_core_pct:.2f}% core-equiv"
            pss_display = "N/A" if pss_kb is None else f"{pss_kb / 1024.0:.2f} MiB PSS"
            print(
                f"[{index:02d}/{sample_count}] t={actual_elapsed:7.2f}s  "
                f"CPU={cpu_display:>18}  MEM={pss_display:>16}  "
                f"PIDs={[pid for pid, _ in processes]}",
                flush=True,
            )
    finally:
        if collector_started and not collector_stopped:
            collector.stop()

    diagnostic_summary = collector.summary(args.duration)
    diagnostic_summary.update(
        {
            "csv": diagnostic_out.name,
            "raw_stream": diagnostic_raw_out.name,
            "device_script": collector.device_script_out.name,
        }
    )
    return rows, summarize(
        rows,
        args.package,
        args.duration,
        args.interval,
        cancelled=cancelled,
        sampling_mode="realtime",
        diagnostic=diagnostic_summary,
    )


def sample(args: argparse.Namespace) -> tuple[list[Sample], dict[str, object]]:
    raw_out = getattr(args, "raw_out", None)
    stop_file = getattr(args, "stop_file", None)
    adb = Adb(args.adb, args.serial, recorder=RawCommandRecorder(raw_out))
    adb.assert_device()

    if args.launch:
        launch_package(adb, args.package)

    include_colon = not args.main_process_only
    processes = wait_for_process(
        adb,
        args.package,
        include_colon_processes=include_colon,
        timeout_s=args.wait_process_timeout,
        stop_file=stop_file,
    )

    if getattr(args, "sampling_mode", "standard") == "realtime":
        return sample_realtime(args, adb, include_colon)

    baseline = take_cpu_snapshot(adb, processes)
    if not baseline.processes:
        raise AdbError(
            "The device did not allow reading /proc/<pid>/stat for the target process. "
            "Use Perfetto on this build, or ask the OEM for a userdebug/eng image or shell access."
        )

    sample_count = int(round(args.duration / args.interval))
    if sample_count <= 0:
        raise ValueError("duration/interval must produce at least one sample")
    initialize_live_csv(args.out)

    print(
        f"Sampling {args.package} every {args.interval:g}s for {args.duration:g}s "
        f"({sample_count} rows); initial PIDs: {[pid for pid, _ in processes]}",
        flush=True,
    )

    start = time.monotonic()
    previous = baseline
    rows: list[Sample] = []
    cancelled = False

    for index in range(1, sample_count + 1):
        target_elapsed = index * args.interval
        while True:
            if stop_file and stop_file.exists():
                cancelled = True
                break
            sleep_s = start + target_elapsed - time.monotonic()
            if sleep_s <= 0:
                break
            time.sleep(min(0.25, sleep_s))
        if cancelled:
            print("Sampling cancellation requested; writing partial results.", flush=True)
            break

        collection_start = time.monotonic()
        note_parts: list[str] = []
        try:
            processes = list_package_processes(adb, args.package, include_colon)
            current = take_cpu_snapshot(adb, processes)
            one_core_pct, device_pct, changed, cpu_note = compute_cpu_percentages(previous, current)
            if cpu_note:
                note_parts.append(cpu_note)

            pss_kb, rss_kb, mem_notes = read_memory_kb(adb, processes)
            note_parts.extend(mem_notes)

            actual_elapsed = time.monotonic() - start
            latency = time.monotonic() - collection_start
            cpu_start_s = previous.source_timestamp_s
            cpu_end_s = current.source_timestamp_s
            cpu_window_s = (
                cpu_end_s - cpu_start_s
                if cpu_start_s is not None and cpu_end_s is not None
                else None
            )
            row = Sample(
                sample_index=index,
                target_elapsed_s=target_elapsed,
                actual_elapsed_s=actual_elapsed,
                wall_time_local=time.strftime("%Y-%m-%d %H:%M:%S"),
                pids=";".join(str(pid) for pid, _ in processes),
                process_names=";".join(name for _, name in processes),
                logical_cpus=current.logical_cpus,
                cpu_one_core_equiv_pct=one_core_pct,
                cpu_device_normalized_pct=device_pct,
                pss_mb=(pss_kb / 1024.0) if pss_kb is not None else None,
                rss_mb=(rss_kb / 1024.0) if rss_kb is not None else None,
                process_set_changed=int(changed),
                collection_latency_s=latency,
                note=";".join(dict.fromkeys(note_parts)),
                sampling_mode="standard",
                cpu_metric_source="adb_proc_snapshot_5s",
                cpu_source_start_s=cpu_start_s,
                cpu_source_end_s=cpu_end_s,
                cpu_window_duration_s=cpu_window_s,
                pss_metric_source="dumpsys_meminfo_local_5s",
                pss_source_elapsed_s=actual_elapsed,
                rss_metric_source="dumpsys_meminfo_local_5s",
                rss_source_timestamp_s=current.source_timestamp_s,
            )
            rows.append(row)
            append_live_sample(args.out, row)
            previous = current

            cpu_display = "N/A" if one_core_pct is None else f"{one_core_pct:.2f}% core-equiv"
            pss_display = "N/A" if pss_kb is None else f"{pss_kb / 1024.0:.2f} MiB PSS"
            print(
                f"[{index:02d}/{sample_count}] t={actual_elapsed:7.2f}s  "
                f"CPU={cpu_display:>18}  MEM={pss_display:>16}  "
                f"PIDs={[pid for pid, _ in processes]}",
                flush=True,
            )
        except (AdbError, ValueError) as exc:
            actual_elapsed = time.monotonic() - start
            latency = time.monotonic() - collection_start
            row = Sample(
                sample_index=index,
                target_elapsed_s=target_elapsed,
                actual_elapsed_s=actual_elapsed,
                wall_time_local=time.strftime("%Y-%m-%d %H:%M:%S"),
                pids="",
                process_names="",
                logical_cpus=None,
                cpu_one_core_equiv_pct=None,
                cpu_device_normalized_pct=None,
                pss_mb=None,
                rss_mb=None,
                process_set_changed=1,
                collection_latency_s=latency,
                note=f"collection_error:{str(exc).replace(';', ',')}",
                sampling_mode="standard",
                cpu_metric_source="adb_proc_snapshot_5s",
            )
            rows.append(row)
            append_live_sample(args.out, row)
            print(f"[{index:02d}/{sample_count}] collection error: {exc}", file=sys.stderr, flush=True)

    return rows, summarize(
        rows,
        args.package,
        args.duration,
        args.interval,
        cancelled=cancelled,
        sampling_mode="standard",
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Sample Android package CPU and memory through adb and write CSV/JSON outputs."
    )
    parser.add_argument("--package", default="com.appmarket.automotive")
    parser.add_argument("--duration", type=float, default=180.0, help="total duration in seconds")
    parser.add_argument("--interval", type=float, default=5.0, help="sampling interval in seconds")
    parser.add_argument(
        "--sampling-mode",
        choices=("standard", "realtime"),
        default="standard",
        help="standard=5s adb snapshots; realtime=500ms CPU + 1s RSS with formal 5s rows",
    )
    parser.add_argument("--out", type=Path, default=Path("appmarket_metrics.csv"))
    parser.add_argument(
        "--summary-out",
        type=Path,
        default=None,
        help="summary JSON path; defaults to <out stem>_summary.json",
    )
    parser.add_argument("--adb", default="adb", help="adb executable path")
    parser.add_argument("--serial", default=None, help="adb device serial when multiple devices are connected")
    parser.add_argument(
        "--raw-out",
        type=Path,
        default=None,
        help="JSONL transcript containing the raw adb/proc/meminfo responses",
    )
    parser.add_argument(
        "--diagnostic-out",
        type=Path,
        default=None,
        help="realtime diagnostic CSV; defaults to diagnostic_metrics.csv beside --out",
    )
    parser.add_argument(
        "--diagnostic-raw-out",
        type=Path,
        default=None,
        help="raw persistent collector stream; defaults to realtime_stream.jsonl beside --out",
    )
    parser.add_argument(
        "--stop-file",
        type=Path,
        default=None,
        help="finish cleanly with partial outputs when this file appears",
    )
    parser.add_argument("--launch", action="store_true", help="launch the package before sampling")
    parser.add_argument(
        "--wait-process-timeout",
        type=float,
        default=30.0,
        help="seconds to wait for the package process",
    )
    parser.add_argument(
        "--main-process-only",
        action="store_true",
        help="exclude colon-suffixed processes such as package:remote",
    )
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    if args.duration <= 0 or args.interval <= 0:
        parser.error("--duration and --interval must be positive")
    if args.sampling_mode == "realtime" and not math.isclose(
        args.interval, 5.0, rel_tol=0.0, abs_tol=1e-9
    ):
        parser.error("realtime mode requires --interval 5 so formal CPU/PSS remains 5 seconds")
    if not re.fullmatch(r"[A-Za-z0-9_.]+", args.package):
        parser.error("--package contains unsupported characters")
    ratio = args.duration / args.interval
    if not math.isclose(ratio, round(ratio), rel_tol=0.0, abs_tol=1e-9):
        parser.error("--duration must be an exact multiple of --interval")

    summary_path = args.summary_out or args.out.with_name(args.out.stem + "_summary.json")

    try:
        rows, summary = sample(args)
        summary_path.parent.mkdir(parents=True, exist_ok=True)
        summary_path.write_text(
            json.dumps(summary, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    except SamplingCancelled as exc:
        print(f"CANCELLED: {exc}", file=sys.stderr)
        return 130
    except (AdbError, ValueError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    print(f"CSV: {args.out.resolve()}")
    print(f"Summary: {summary_path.resolve()}")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 130 if summary.get("cancelled") else 0


if __name__ == "__main__":
    raise SystemExit(main())
