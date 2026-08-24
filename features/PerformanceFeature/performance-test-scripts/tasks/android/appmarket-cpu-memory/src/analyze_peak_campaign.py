#!/usr/bin/env python3
"""Aggregate a repeated AppMarket campaign and attribute peak CPU/PSS phases."""

from __future__ import annotations

import argparse
import csv
import json
import math
import re
import statistics
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable, Sequence


PACKAGE = "com.appmarket.automotive"
MEMORY_CATEGORIES = (
    "Native Heap", "Dalvik Heap", "Dalvik Other", "Stack", "Ashmem", "Other dev",
    ".so mmap", ".jar mmap", ".apk mmap", ".ttf mmap", ".dex mmap", ".oat mmap",
    ".art mmap", "Other mmap", "EGL mtrack", "Unknown",
)
LOG_PATTERNS = {
    "app_secure_native": re.compile(r"APP_MKT_NATIVE"),
    "network_verbose": re.compile(r"APP_MKT_NET"),
    "elog_header": re.compile(r"ELOG_HEADER"),
    "installed_app_scan": re.compile(r"InstalledUpdateAppDate"),
    "app_warmup": re.compile(r"APP_WARMUP"),
    "webview_preload": re.compile(r"WebViewPreloader|WebViewPreheat", re.IGNORECASE),
    "skipped_frames": re.compile(r"Skipped\s+\d+\s+frames", re.IGNORECASE),
}


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"expected JSON object: {path}")
    return value


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def parse_float(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def parse_time(value: str) -> datetime:
    return datetime.strptime(value, "%Y-%m-%d %H:%M:%S")


def percentile(values: Sequence[float], quantile: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    position = (len(ordered) - 1) * quantile
    low = math.floor(position)
    high = math.ceil(position)
    if low == high:
        return ordered[low]
    fraction = position - low
    return ordered[low] * (1.0 - fraction) + ordered[high] * fraction


def stats(values: Iterable[float | None]) -> dict[str, float | int | None]:
    valid = [float(value) for value in values if value is not None and math.isfinite(float(value))]
    if not valid:
        return {"count": 0, "mean": None, "median": None, "p95": None, "min": None, "max": None}
    return {
        "count": len(valid),
        "mean": round(statistics.fmean(valid), 4),
        "median": round(statistics.median(valid), 4),
        "p95": round(float(percentile(valid, 0.95)), 4),
        "min": round(min(valid), 4),
        "max": round(max(valid), 4),
    }


def read_csv(path: Path) -> list[dict[str, Any]]:
    with path.open("r", encoding="utf-8-sig", newline="") as stream:
        return [dict(row) for row in csv.DictReader(stream)]


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    if not path.is_file():
        return rows
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            rows.append(value)
    return rows


def event_time(events: Sequence[dict[str, Any]], predicate: Any) -> datetime | None:
    for event in events:
        if predicate(event):
            try:
                return parse_time(str(event["at"]))
            except (KeyError, ValueError):
                continue
    return None


def phase_boundaries(events: Sequence[dict[str, Any]]) -> list[tuple[datetime, str]]:
    definitions = (
        (lambda e: e.get("step") == "launch" and e.get("status") == "started", "启动与首页加载"),
        (lambda e: e.get("step") == "launch" and e.get("status") == "passed", "列表浏览与详情加载"),
        (lambda e: e.get("step") == "download_install" and e.get("status") == "clicked", "下载与安装"),
        (lambda e: e.get("step") == "download_install" and e.get("status") == "passed", "返回首页"),
        (lambda e: e.get("step") == "open_my" and e.get("status") == "clicked", "我的页面"),
        (lambda e: e.get("step") == "browse_menu" and e.get("message") == "更新管理", "更新管理"),
        (lambda e: e.get("step") == "browse_menu" and e.get("message") == "安装管理", "安装管理"),
        (lambda e: e.get("step") == "browse_menu" and e.get("message") == "问题与反馈", "问题与反馈"),
        (lambda e: e.get("step") == "browse_menu" and e.get("message") == "关于我们", "关于我们"),
        (lambda e: e.get("step") == "browse_menu" and e.get("message") == "用户协议", "用户协议"),
        (lambda e: e.get("step") == "browse_menu" and e.get("message") == "隐私政策", "隐私政策"),
        (lambda e: e.get("step") == "flow" and e.get("status") == "completed", "流程后稳态"),
    )
    boundaries: list[tuple[datetime, str]] = []
    for predicate, phase in definitions:
        value = event_time(events, predicate)
        if value is not None:
            boundaries.append((value, phase))
    return sorted(boundaries, key=lambda item: item[0])


def phase_at(value: datetime, boundaries: Sequence[tuple[datetime, str]]) -> str:
    phase = "采样准备"
    for boundary, name in boundaries:
        if value < boundary:
            break
        phase = name
    return phase


def parse_meminfo_categories(raw: str) -> dict[str, float]:
    categories: dict[str, float] = {}
    in_table = False
    pattern = re.compile(r"^\s*(.+?)\s+(\d+)\s+(?:\d+\s+){3,}\d+\s*$")
    # Some vendor dumps leave the heap columns blank, so fall back to reading
    # only the first numeric PSS column after the known category name.
    fallback = re.compile(r"^\s*(.+?)\s+(\d+)\s+")
    for line in raw.splitlines():
        if line.lstrip().startswith("Pss  Private"):
            in_table = True
            continue
        if not in_table:
            continue
        if line.lstrip().startswith("TOTAL"):
            break
        match = pattern.match(line) or fallback.match(line)
        if not match:
            continue
        name = match.group(1).strip()
        if name in MEMORY_CATEGORIES:
            categories[name] = round(int(match.group(2)) / 1024.0, 4)
    return categories


def meminfo_snapshots(raw_commands: Path) -> list[dict[str, Any]]:
    snapshots: list[dict[str, Any]] = []
    for row in read_jsonl(raw_commands):
        command = row.get("command")
        joined = " ".join(str(item) for item in command) if isinstance(command, list) else str(command or "")
        if "dumpsys meminfo --local" not in joined or int(row.get("returncode", 1)) != 0:
            continue
        snapshots.append(
            {
                "wall_time_local": row.get("wall_time_local"),
                "categories_mb": parse_meminfo_categories(str(row.get("stdout", ""))),
            }
        )
    return snapshots


def count_log_patterns(raw_dir: Path) -> dict[str, Any]:
    counts = {name: 0 for name in LOG_PATTERNS}
    total_bytes = 0
    files: list[str] = []
    for path in sorted(raw_dir.glob("logcat*.txt")):
        # stderr contains adb diagnostics rather than device log records.
        if "stderr" in path.name:
            continue
        files.append(path.name)
        total_bytes += path.stat().st_size
        with path.open("r", encoding="utf-8", errors="replace") as stream:
            for line in stream:
                for name, pattern in LOG_PATTERNS.items():
                    if pattern.search(line):
                        counts[name] += 1
    return {"retained_bytes": total_bytes, "files": files, "counts": counts}


def write_csv(path: Path, rows: Sequence[dict[str, Any]], fields: Sequence[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(fields), extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def window_threads(trace: Path, windows: Sequence[dict[str, Any]]) -> tuple[list[dict[str, Any]], str]:
    try:
        from perfetto.trace_processor import TraceProcessor
    except (ImportError, ModuleNotFoundError) as exc:
        return [], f"perfetto_python_missing:{exc}"
    values: list[str] = []
    valid_windows: list[dict[str, Any]] = []
    for index, window in enumerate(windows):
        start_s = parse_float(window.get("start_s"))
        end_s = parse_float(window.get("end_s"))
        if start_s is None or end_s is None or end_s <= start_s:
            continue
        label = re.sub(r"[^A-Za-z0-9_-]", "_", str(window.get("label", f"window_{index}")))
        values.append(f"('{label}',{int(start_s * 1_000_000_000)},{int(end_s * 1_000_000_000)})")
        valid_windows.append({**window, "label": label})
    if not values:
        return [], "no_valid_windows"
    sql = f"""
        WITH windows(label, start_ns, end_ns) AS (VALUES {','.join(values)}),
        clipped AS (
          SELECT w.label, t.tid, p.pid,
                 COALESCE(t.name, printf('tid-%d', t.tid)) AS thread_name,
                 MAX(0, MIN(s.ts + s.dur, w.end_ns) - MAX(s.ts, w.start_ns)) AS clipped_dur
          FROM windows w
          JOIN sched s ON s.ts < w.end_ns AND s.ts + s.dur > w.start_ns
          JOIN thread t USING(utid)
          JOIN process p USING(upid)
          WHERE p.name GLOB '{PACKAGE}*'
        )
        SELECT label, tid, pid, thread_name, SUM(clipped_dur) AS cpu_ns, COUNT(*) AS slices
        FROM clipped
        GROUP BY label, tid, pid, thread_name
        ORDER BY label, cpu_ns DESC
    """
    tp: Any = None
    try:
        tp = TraceProcessor(trace=str(trace))
        raw_rows = [
            {
                "label": getattr(row, "label", ""),
                "tid": int(getattr(row, "tid", 0) or 0),
                "pid": int(getattr(row, "pid", 0) or 0),
                "thread_name": str(getattr(row, "thread_name", "") or ""),
                "cpu_ns": int(getattr(row, "cpu_ns", 0) or 0),
                "slices": int(getattr(row, "slices", 0) or 0),
            }
            for row in tp.query(sql)
        ]
    except Exception as exc:
        return [], f"trace_query_failed:{exc}"
    finally:
        if tp is not None:
            try:
                tp.close()
            except Exception:
                pass

    metadata = {item["label"]: item for item in valid_windows}
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in raw_rows:
        grouped[row["label"]].append(row)
    result: list[dict[str, Any]] = []
    for label, rows in grouped.items():
        total_ns = sum(row["cpu_ns"] for row in rows)
        for rank, row in enumerate(sorted(rows, key=lambda item: item["cpu_ns"], reverse=True)[:20], 1):
            thread_name = "main" if row["tid"] == row["pid"] else row["thread_name"]
            result.append(
                {
                    **metadata[label],
                    "label": label,
                    "rank": rank,
                    "thread_name": thread_name,
                    "tid": row["tid"],
                    "cpu_ms": round(row["cpu_ns"] / 1_000_000.0, 3),
                    "window_cpu_share_pct": round(100.0 * row["cpu_ns"] / total_ns, 3) if total_ns else 0.0,
                    "slices": row["slices"],
                }
            )
    return result, "completed"


def analyze(campaign_manifest: Path, out_dir: Path, skip_trace: bool = False) -> dict[str, Any]:
    campaign = read_json(campaign_manifest)
    repo_root = next((path for path in campaign_manifest.resolve().parents if (path / ".git").exists()), None)
    if repo_root is None:
        raise RuntimeError("repository root not found")
    formal_rows: list[dict[str, Any]] = []
    realtime_rows: list[dict[str, Any]] = []
    peak_events: list[dict[str, Any]] = []
    thread_rows: list[dict[str, Any]] = []
    trace_status: list[dict[str, Any]] = []
    round_results: list[dict[str, Any]] = []
    peak_category_rows: list[dict[str, Any]] = []

    for campaign_round in campaign.get("rounds", []):
        if campaign_round.get("validation") != "complete":
            continue
        index = int(campaign_round["index"])
        artifact = Path(str(campaign_round["artifact_dir"]))
        run_dir = artifact if artifact.is_absolute() else repo_root / artifact
        metrics_path = run_dir / "raw" / "metrics.csv"
        diagnostic_path = run_dir / "raw" / "diagnostic_metrics.csv"
        flow_path = run_dir / "flow" / "flow_events.jsonl"
        raw_commands = run_dir / "raw" / "sampler_raw_commands.jsonl"
        log_profile = count_log_patterns(run_dir / "raw")
        events = read_jsonl(flow_path)
        boundaries = phase_boundaries(events)
        metrics = read_csv(metrics_path)
        memory = meminfo_snapshots(raw_commands)
        for sample_index, row in enumerate(metrics):
            wall = parse_time(row["wall_time_local"])
            category_values = memory[sample_index]["categories_mb"] if sample_index < len(memory) else {}
            item = {
                "round": index,
                "sample_index": int(row["sample_index"]),
                "wall_time_local": row["wall_time_local"],
                "phase": phase_at(wall, boundaries),
                "target_elapsed_s": parse_float(row.get("target_elapsed_s")),
                "actual_elapsed_s": parse_float(row.get("actual_elapsed_s")),
                "cpu_device_normalized_pct": parse_float(row.get("cpu_device_normalized_pct")),
                "cpu_one_core_equiv_pct": parse_float(row.get("cpu_one_core_equiv_pct")),
                "pss_mb": parse_float(row.get("pss_mb")),
                "rss_mb": parse_float(row.get("rss_mb")),
                "cpu_source_start_s": parse_float(row.get("cpu_source_start_s")),
                "cpu_source_end_s": parse_float(row.get("cpu_source_end_s")),
                "memory_categories_mb": category_values,
                "run_dir": run_dir.relative_to(repo_root).as_posix(),
            }
            formal_rows.append(item)
        if diagnostic_path.is_file():
            for row in read_csv(diagnostic_path):
                wall = parse_time(row["wall_time_local"])
                realtime_rows.append(
                    {
                        "round": index,
                        "diagnostic_index": int(row["diagnostic_index"]),
                        "wall_time_local": row["wall_time_local"],
                        "phase": phase_at(wall, boundaries),
                        "cpu_device_normalized_pct": parse_float(row.get("cpu_device_normalized_pct")),
                        "cpu_one_core_equiv_pct": parse_float(row.get("cpu_one_core_equiv_pct")),
                        "rss_mb": parse_float(row.get("rss_mb")),
                        "source_timestamp_s": parse_float(row.get("source_timestamp_s")),
                        "cpu_window_duration_s": parse_float(row.get("cpu_window_duration_s")),
                    }
                )

        run_formal = [row for row in formal_rows if row["round"] == index]
        run_realtime = [row for row in realtime_rows if row["round"] == index]
        cpu_peak = max(
            (row for row in run_formal if row["cpu_device_normalized_pct"] is not None),
            key=lambda row: row["cpu_device_normalized_pct"],
        )
        pss_peak = max(
            (row for row in run_formal if row["pss_mb"] is not None),
            key=lambda row: row["pss_mb"],
        )
        realtime_peak = max(
            (row for row in run_realtime if row["cpu_device_normalized_pct"] is not None),
            key=lambda row: row["cpu_device_normalized_pct"],
            default=None,
        )
        peak_events.extend(
            [
                {"round": index, "metric": "cpu_5s", "value": cpu_peak["cpu_device_normalized_pct"], **cpu_peak},
                {"round": index, "metric": "pss_snapshot", "value": pss_peak["pss_mb"], **pss_peak},
            ]
        )
        if realtime_peak is not None:
            peak_events.append(
                {"round": index, "metric": "cpu_realtime", "value": realtime_peak["cpu_device_normalized_pct"], **realtime_peak}
            )
        for category, value in pss_peak["memory_categories_mb"].items():
            peak_category_rows.append(
                {"round": index, "phase": pss_peak["phase"], "category": category, "pss_mb": value}
            )

        windows: list[dict[str, Any]] = [
            {
                "label": "cpu_5s_peak",
                "round": index,
                "metric": "cpu_5s",
                "phase": cpu_peak["phase"],
                "start_s": cpu_peak["cpu_source_start_s"],
                "end_s": cpu_peak["cpu_source_end_s"],
            },
            {
                "label": "pss_peak_context",
                "round": index,
                "metric": "pss_snapshot",
                "phase": pss_peak["phase"],
                "start_s": pss_peak["cpu_source_start_s"],
                "end_s": pss_peak["cpu_source_end_s"],
            },
        ]
        if realtime_peak is not None and realtime_peak["source_timestamp_s"] is not None:
            duration = realtime_peak["cpu_window_duration_s"] or 0.5
            windows.append(
                {
                    "label": "cpu_realtime_peak",
                    "round": index,
                    "metric": "cpu_realtime",
                    "phase": realtime_peak["phase"],
                    "start_s": realtime_peak["source_timestamp_s"] - duration,
                    "end_s": realtime_peak["source_timestamp_s"],
                }
            )
        trace = run_dir / "trace" / "appmarket.pftrace"
        if skip_trace:
            status = "skipped"
            rows = []
        elif trace.is_file():
            rows, status = window_threads(trace, windows)
        else:
            rows, status = [], "trace_missing"
        for row in rows:
            row["run_dir"] = run_dir.relative_to(repo_root).as_posix()
        thread_rows.extend(rows)
        trace_status.append({"round": index, "status": status, "trace_file": trace.name})
        round_results.append(
            {
                "round": index,
                "flow_status": campaign_round.get("flow_status"),
                "download_install_completed": campaign_round.get("download_install_completed"),
                "cpu_5s_peak": cpu_peak,
                "cpu_realtime_peak": realtime_peak,
                "pss_peak": pss_peak,
                "meminfo_snapshot_count": len(memory),
                "log_profile": log_profile,
                "trace_thread_status": status,
            }
        )

    phase_groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in formal_rows:
        phase_groups[row["phase"]].append(row)
    phase_summary = [
        {
            "phase": phase,
            "sample_count": len(rows),
            "cpu_device_normalized_pct": stats(row["cpu_device_normalized_pct"] for row in rows),
            "cpu_one_core_equiv_pct": stats(row["cpu_one_core_equiv_pct"] for row in rows),
            "pss_mb": stats(row["pss_mb"] for row in rows),
            "rss_mb": stats(row["rss_mb"] for row in rows),
        }
        for phase, rows in phase_groups.items()
    ]
    phase_summary.sort(key=lambda row: row["pss_mb"]["max"] or -1, reverse=True)

    category_groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in peak_category_rows:
        category_groups[row["category"]].append(row)
    category_summary = [
        {
            "category": category,
            "snapshot_count": len(rows),
            "pss_mb": stats(row["pss_mb"] for row in rows),
            "peak_phases": dict(Counter(row["phase"] for row in rows)),
        }
        for category, rows in category_groups.items()
    ]
    category_summary.sort(key=lambda row: row["pss_mb"]["mean"] or -1, reverse=True)

    thread_groups: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for row in thread_rows:
        thread_groups[(row["metric"], row["thread_name"])].append(row)
    thread_summary = [
        {
            "metric": metric,
            "thread_name": thread,
            "observations": len(rows),
            "rounds": sorted({int(row["round"]) for row in rows}),
            "cpu_ms": stats(parse_float(row["cpu_ms"]) for row in rows),
            "window_cpu_share_pct": stats(parse_float(row["window_cpu_share_pct"]) for row in rows),
            "phases": dict(Counter(row["phase"] for row in rows)),
        }
        for (metric, thread), rows in thread_groups.items()
    ]
    thread_summary.sort(
        key=lambda row: (row["metric"], -(row["cpu_ms"]["mean"] or 0), row["thread_name"])
    )

    result = {
        "schema_version": 1,
        "generated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "campaign_manifest": campaign_manifest.relative_to(repo_root).as_posix(),
        "campaign_id": campaign.get("campaign_id"),
        "settings": campaign.get("settings", {}),
        "data_quality": {
            "requested_rounds": campaign.get("settings", {}).get("rounds"),
            "complete_rounds": len(round_results),
            "full_flow_rounds": sum(row["flow_status"] == "completed" for row in round_results),
            "download_install_rounds": sum(bool(row["download_install_completed"]) for row in round_results),
            "formal_sample_count": len(formal_rows),
            "realtime_sample_count": len(realtime_rows),
            "trace_status": trace_status,
        },
        "overall": {
            "cpu_5s_normalized_pct": stats(row["cpu_device_normalized_pct"] for row in formal_rows),
            "cpu_5s_multi_core_pct": stats(row["cpu_one_core_equiv_pct"] for row in formal_rows),
            "cpu_realtime_normalized_pct": stats(row["cpu_device_normalized_pct"] for row in realtime_rows),
            "pss_mb": stats(row["pss_mb"] for row in formal_rows),
            "rss_mb": stats(row["rss_mb"] for row in formal_rows),
            "per_round_cpu_5s_peak_pct": stats(
                row["cpu_5s_peak"]["cpu_device_normalized_pct"] for row in round_results
            ),
            "per_round_cpu_realtime_peak_pct": stats(
                row["cpu_realtime_peak"]["cpu_device_normalized_pct"]
                for row in round_results if row["cpu_realtime_peak"] is not None
            ),
            "per_round_pss_peak_mb": stats(row["pss_peak"]["pss_mb"] for row in round_results),
            "per_round_log_retained_mb": stats(
                row["log_profile"]["retained_bytes"] / 1024 / 1024 for row in round_results
            ),
            "per_round_app_secure_native_log_lines": stats(
                float(row["log_profile"]["counts"]["app_secure_native"]) for row in round_results
            ),
            "per_round_network_verbose_log_lines": stats(
                float(row["log_profile"]["counts"]["network_verbose"]) for row in round_results
            ),
        },
        "peak_phase_counts": {
            metric: dict(Counter(row["phase"] for row in peak_events if row["metric"] == metric))
            for metric in ("cpu_5s", "cpu_realtime", "pss_snapshot")
        },
        "phase_summary": phase_summary,
        "memory_categories_at_round_pss_peaks": category_summary,
        "thread_summary_at_peak_windows": thread_summary,
        "rounds": round_results,
        "peak_events": peak_events,
    }
    write_json(out_dir / "campaign_peak_analysis.json", result)
    formal_flat = [
        {**{key: value for key, value in row.items() if key != "memory_categories_mb"}, **row["memory_categories_mb"]}
        for row in formal_rows
    ]
    write_csv(
        out_dir / "formal_samples_with_phase.csv",
        formal_flat,
        (
            "round", "sample_index", "wall_time_local", "phase", "target_elapsed_s", "actual_elapsed_s",
            "cpu_device_normalized_pct", "cpu_one_core_equiv_pct", "pss_mb", "rss_mb",
            *MEMORY_CATEGORIES, "run_dir",
        ),
    )
    write_csv(
        out_dir / "peak_events.csv",
        peak_events,
        (
            "round", "metric", "value", "sample_index", "diagnostic_index", "wall_time_local", "phase",
            "cpu_device_normalized_pct", "cpu_one_core_equiv_pct", "pss_mb", "rss_mb",
            "cpu_source_start_s", "cpu_source_end_s", "source_timestamp_s", "cpu_window_duration_s", "run_dir",
        ),
    )
    write_csv(
        out_dir / "thread_peak_attribution.csv",
        thread_rows,
        (
            "round", "metric", "phase", "label", "rank", "thread_name", "tid", "cpu_ms",
            "window_cpu_share_pct", "slices", "start_s", "end_s", "run_dir",
        ),
    )
    write_csv(
        out_dir / "memory_category_at_round_peaks.csv",
        peak_category_rows,
        ("round", "phase", "category", "pss_mb"),
    )
    return result


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Analyze repeated AppMarket peak CPU/PSS data")
    parser.add_argument("--campaign-manifest", type=Path, required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument("--skip-trace", action="store_true")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    result = analyze(args.campaign_manifest.resolve(), args.out_dir.resolve(), args.skip_trace)
    quality = result["data_quality"]
    print(
        f"campaign rounds={quality['complete_rounds']}/{quality['requested_rounds']} "
        f"formal_samples={quality['formal_sample_count']} realtime_samples={quality['realtime_sample_count']}"
    )
    return 0 if quality["complete_rounds"] == quality["requested_rounds"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
