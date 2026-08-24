#!/usr/bin/env python3
"""Analyze AppMarket CPU/PSS samples, evaluate workbook KPIs, and ingest them."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import re
import statistics
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Iterable

from performance_json_io import atomic_write_json
from performance_pdf_report import PdfReportError, write_pdf_reports


SCRIPT_ID_PATTERN = re.compile(r"^[A-Za-z][A-Za-z0-9_.-]*$")
WORKFLOW_MODES = {"full", "launch-only"}
MAX_WORKFLOW_STEPS = 100
MAX_EVENT_STEPS = 20
UI_RUN_KINDS = {"workflow", "live"}
UI_VIEW_KINDS = {"dashboard", "live", "table", "artifacts", "report", "json"}
UI_SAMPLING_MODES = {"standard", "realtime"}


def find_repo_root(start: Path) -> Path:
    for candidate in (start, *start.parents):
        if (candidate / ".git").exists() and (candidate / "AGENTS.md").exists():
            return candidate
    return start


def relative_path(path: Path | None, root: Path) -> str | None:
    if path is None:
        return None
    resolved = path.resolve()
    try:
        return resolved.relative_to(root.resolve()).as_posix()
    except ValueError:
        return path.name


def read_json(path: Path | None, default: Any) -> Any:
    if path is None or not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        return default


def safe_script_text(
    value: Any,
    max_length: int,
    *,
    allow_empty: bool = False,
    pattern: re.Pattern[str] | None = None,
) -> str | None:
    if not isinstance(value, str) or "\0" in value or "\r" in value or "\n" in value:
        return None
    normalized = value.strip()
    if not normalized and not allow_empty:
        return None
    if len(normalized) > max_length or (pattern is not None and normalized and not pattern.fullmatch(normalized)):
        return None
    return normalized


def safe_feature_file_path(value: Any, *, python_only: bool = False) -> str | None:
    feature_path = safe_script_text(value, 500)
    if feature_path is None or "\\" in feature_path or ":" in feature_path:
        return None
    parts = feature_path.split("/")
    if (
        not feature_path.startswith("features/PerformanceFeature/")
        or (python_only and not feature_path.lower().endswith(".py"))
        or any(not part or part in {".", ".."} or part.endswith((".", " ")) for part in parts)
    ):
        return None
    return feature_path


def safe_script_runner(value: Any) -> str | None:
    return safe_feature_file_path(value, python_only=True)


def safe_script_string_list(
    value: Any,
    *,
    max_items: int,
    max_length: int,
    feature_paths: bool = False,
) -> list[str] | None:
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > max_items:
        return None
    normalized: list[str] = []
    for raw in value:
        item = safe_feature_file_path(raw) if feature_paths else safe_script_text(raw, max_length)
        if item is None or item in normalized:
            return None
        normalized.append(item)
    return normalized


def project_performance_workflow(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    raw_steps = value.get("steps")
    if not isinstance(raw_steps, list) or not 1 <= len(raw_steps) <= MAX_WORKFLOW_STEPS:
        return None

    step_keys: set[str] = set()
    mapped_events: set[str] = set()
    steps: list[dict[str, Any]] = []
    for raw_step in raw_steps:
        if not isinstance(raw_step, dict):
            return None
        key = safe_script_text(raw_step.get("key"), 80, pattern=SCRIPT_ID_PATTERN)
        label = safe_script_text(raw_step.get("label"), 120)
        raw_events = raw_step.get("eventSteps")
        if key is None or label is None or key in step_keys:
            return None
        if not isinstance(raw_events, list) or not 1 <= len(raw_events) <= MAX_EVENT_STEPS:
            return None

        event_steps: list[str] = []
        for raw_event in raw_events:
            event_step = safe_script_text(raw_event, 80, pattern=SCRIPT_ID_PATTERN)
            if event_step is None or event_step in mapped_events:
                return None
            mapped_events.add(event_step)
            event_steps.append(event_step)

        raw_modes = raw_step.get("modes", ["full", "launch-only"])
        if not isinstance(raw_modes, list) or not raw_modes:
            return None
        modes: list[str] = []
        for raw_mode in raw_modes:
            if not isinstance(raw_mode, str) or raw_mode not in WORKFLOW_MODES or raw_mode in modes:
                return None
            modes.append(raw_mode)

        step_keys.add(key)
        steps.append({"key": key, "label": label, "eventSteps": event_steps, "modes": modes})
    return {"steps": steps}


def project_performance_ui_field(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    key = safe_script_text(value.get("key"), 80, pattern=SCRIPT_ID_PATTERN)
    label = safe_script_text(value.get("label"), 120)
    unit = safe_script_text(value.get("unit", ""), 24, allow_empty=True)
    color = safe_script_text(value.get("color", ""), 7, allow_empty=True)
    decimals = value.get("decimals", 2)
    if key is None or label is None or unit is None or color is None:
        return None
    if color and not re.fullmatch(r"#[0-9A-Fa-f]{6}", color):
        return None
    if not isinstance(decimals, int) or isinstance(decimals, bool) or not 0 <= decimals <= 6:
        return None
    return {"key": key, "label": label, "unit": unit, "color": color, "decimals": decimals}


def project_performance_ui_section(value: Any, kinds: set[str]) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    section_id = safe_script_text(value.get("id"), 80, pattern=SCRIPT_ID_PATTERN)
    kind = safe_script_text(value.get("kind"), 40)
    label = safe_script_text(value.get("label"), 120)
    title = safe_script_text(value.get("title", value.get("label")), 160)
    description = safe_script_text(value.get("description", ""), 500, allow_empty=True)
    source = safe_script_text(value.get("source", ""), 100, allow_empty=True)
    empty_text = safe_script_text(value.get("emptyText", ""), 300, allow_empty=True)
    show_in_history = value.get("showInHistory", kind != "live")
    if None in (section_id, kind, label, title, description, source, empty_text):
        return None
    if kind not in kinds or not isinstance(show_in_history, bool):
        return None
    if source not in {"", "samples", "diagnosticSamples"} and not re.fullmatch(r"event:[A-Za-z][A-Za-z0-9_.-]{0,79}", source):
        return None
    if kind == "live" and not source:
        return None
    sampling_modes = value.get("samplingModes", ["standard", "realtime"])
    if (
        not isinstance(sampling_modes, list)
        or not sampling_modes
        or len(sampling_modes) > len(UI_SAMPLING_MODES)
        or any(mode not in UI_SAMPLING_MODES for mode in sampling_modes)
        or len(set(sampling_modes)) != len(sampling_modes)
    ):
        return None
    projected_lists: dict[str, list[dict[str, Any]]] = {}
    for list_key in ("metrics", "columns"):
        raw_fields = value.get(list_key, [])
        if not isinstance(raw_fields, list) or len(raw_fields) > 40:
            return None
        fields = [project_performance_ui_field(field) for field in raw_fields]
        if any(field is None for field in fields):
            return None
        keys = [field["key"] for field in fields if field is not None]
        if len(set(keys)) != len(keys):
            return None
        projected_lists[list_key] = [field for field in fields if field is not None]
    if kind == "live" and not projected_lists["metrics"]:
        return None
    artifact_keys = safe_script_string_list(value.get("artifactKeys"), max_items=50, max_length=120)
    if artifact_keys is None or any(SCRIPT_ID_PATTERN.fullmatch(key) is None for key in artifact_keys):
        return None
    return {
        "id": section_id,
        "kind": kind,
        "label": label,
        "title": title,
        "description": description,
        "source": source,
        "samplingModes": sampling_modes,
        "showInHistory": show_in_history,
        "metrics": projected_lists["metrics"],
        "columns": projected_lists["columns"],
        "artifactKeys": artifact_keys,
        "emptyText": empty_text,
    }


def project_performance_ui(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict) or value.get("schemaVersion") != 1:
        return None
    raw_run_sections = value.get("runSections", [])
    raw_views = value.get("views")
    if not isinstance(raw_run_sections, list) or len(raw_run_sections) > 20:
        return None
    if not isinstance(raw_views, list) or not 1 <= len(raw_views) <= 20:
        return None
    run_sections = [project_performance_ui_section(section, UI_RUN_KINDS) for section in raw_run_sections]
    views = [project_performance_ui_section(section, UI_VIEW_KINDS) for section in raw_views]
    if any(section is None for section in [*run_sections, *views]):
        return None
    ids = [section["id"] for section in [*run_sections, *views] if section is not None]
    if len(set(ids)) != len(ids):
        return None
    default_view = safe_script_text(value.get("defaultView", views[0]["id"]), 80, pattern=SCRIPT_ID_PATTERN)
    if default_view is None or default_view not in {view["id"] for view in views if view is not None}:
        return None
    return {
        "schemaVersion": 1,
        "defaultView": default_view,
        "runSections": [section for section in run_sections if section is not None],
        "views": [section for section in views if section is not None],
    }


def project_performance_script(value: Any) -> dict[str, Any] | None:
    """Return only the public, validated script metadata written by the gateway."""
    if not isinstance(value, dict):
        return None
    script_id = safe_script_text(value.get("id"), 80, pattern=SCRIPT_ID_PATTERN)
    name = safe_script_text(value.get("name"), 120)
    description = safe_script_text(value.get("description"), 500, allow_empty=True)
    category = safe_script_text(value.get("category", "未分类"), 80)
    tags = safe_script_string_list(value.get("tags"), max_items=20, max_length=40)
    source_files = safe_script_string_list(
        value.get("sourceFiles"),
        max_items=50,
        max_length=500,
        feature_paths=True,
    )
    version = safe_script_text(value.get("version", "1"), 40)
    managed_value = value.get("managed", False)
    managed = managed_value if isinstance(managed_value, bool) else None
    raw_manifest_path = value.get("manifestPath", "")
    manifest_path = (
        ""
        if raw_manifest_path == ""
        else safe_feature_file_path(raw_manifest_path)
    )
    runner = safe_script_runner(value.get("runner"))
    workflow = project_performance_workflow(value.get("workflow"))
    ui = project_performance_ui(value.get("ui")) if value.get("ui") is not None else None
    if None in (
        script_id,
        name,
        description,
        category,
        tags,
        source_files,
        version,
        managed,
        manifest_path,
        runner,
        workflow,
    ):
        return None
    if value.get("ui") is not None and ui is None:
        return None
    projected = {
        "id": script_id,
        "name": name,
        "description": description,
        "category": category,
        "tags": tags,
        "sourceFiles": source_files,
        "version": version,
        "managed": managed,
        "manifestPath": manifest_path,
        "runner": runner,
        "workflow": workflow,
    }
    if ui is not None:
        projected["ui"] = ui
    return projected


def as_float(value: Any) -> float | None:
    if value in (None, ""):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def metric_stats(values: Iterable[float | None]) -> dict[str, float | int | None]:
    clean = [float(value) for value in values if value is not None and math.isfinite(float(value))]
    return {
        "valid_samples": len(clean),
        "mean": round(statistics.fmean(clean), 4) if clean else None,
        "peak": round(max(clean), 4) if clean else None,
        "min": round(min(clean), 4) if clean else None,
    }


def read_samples(path: Path) -> list[dict[str, Any]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        rows: list[dict[str, Any]] = []
        for raw in csv.DictReader(handle):
            row = dict(raw)
            for key in (
                "sample_index",
                "target_elapsed_s",
                "actual_elapsed_s",
                "logical_cpus",
                "cpu_one_core_equiv_pct",
                "cpu_device_normalized_pct",
                "pss_mb",
                "rss_mb",
                "process_set_changed",
                "collection_latency_s",
                "cpu_source_start_s",
                "cpu_source_end_s",
                "cpu_window_duration_s",
                "pss_source_elapsed_s",
                "rss_source_timestamp_s",
            ):
                row[key] = as_float(row.get(key))
            rows.append(row)
        return rows


def read_diagnostic_samples(path: Path | None) -> list[dict[str, Any]]:
    if path is None or not path.is_file():
        return []
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        rows: list[dict[str, Any]] = []
        for raw in csv.DictReader(handle):
            row = dict(raw)
            for key in (
                "diagnostic_index",
                "target_elapsed_s",
                "actual_elapsed_s",
                "source_timestamp_s",
                "logical_cpus",
                "cpu_one_core_equiv_pct",
                "cpu_device_normalized_pct",
                "rss_mb",
                "rss_source_timestamp_s",
                "process_set_changed",
                "cpu_window_duration_s",
                "collection_latency_s",
            ):
                row[key] = as_float(row.get(key))
            row["rss_fresh"] = str(row.get("rss_fresh") or "").strip().lower() in {
                "1",
                "true",
                "yes",
            }
            rows.append(row)
        return rows


def check_limit(
    key: str,
    label: str,
    actual: float | int | None,
    limit: float | int,
    unit: str,
) -> dict[str, Any]:
    if actual is None:
        status = "inconclusive"
    else:
        status = "pass" if float(actual) <= float(limit) else "fail"
    return {
        "key": key,
        "label": label,
        "status": status,
        "actual": actual,
        "limit": limit,
        "comparison": "<=",
        "unit": unit,
    }


def check_minimum(
    key: str,
    label: str,
    actual: float | int | None,
    minimum: float | int,
    unit: str,
) -> dict[str, Any]:
    if actual is None:
        status = "inconclusive"
    else:
        status = "pass" if float(actual) >= float(minimum) else "fail"
    return {
        "key": key,
        "label": label,
        "status": status,
        "actual": actual,
        "limit": minimum,
        "comparison": ">=",
        "unit": unit,
    }


def check_protocol_minimum(
    key: str,
    label: str,
    actual: float | int | None,
    minimum: float | int,
    unit: str,
) -> dict[str, Any]:
    item = check_minimum(key, label, actual, minimum, unit)
    if item["status"] == "fail":
        item["status"] = "inconclusive"
    return item


def summarize_screenrecord(manifest: dict[str, Any]) -> dict[str, Any]:
    raw = manifest.get("screenrecord")
    raw = raw if isinstance(raw, dict) else {}
    enabled = bool(manifest.get("capture_screenrecord") or raw.get("enabled"))
    segments: list[dict[str, Any]] = []
    for entry in raw.get("segments", []):
        if not isinstance(entry, dict):
            continue
        local_name = Path(str(entry.get("local_path") or "")).name
        item = {
            "index": entry.get("index"),
            "file": f"flow/video/{local_name}" if local_name else None,
            "bytes": entry.get("bytes"),
            "pulled": bool(entry.get("pulled")),
            "status": entry.get("status"),
        }
        if entry.get("elapsed_s") is not None:
            item["elapsed_s"] = entry.get("elapsed_s")
        if entry.get("exit_code") is not None:
            item["exit_code"] = entry.get("exit_code")
        segments.append(item)
    pulled_count = raw.get("pulled_segment_count")
    if pulled_count is None:
        pulled_count = sum(1 for item in segments if item["pulled"])
    return {
        "enabled": enabled,
        "status": raw.get("status") or ("not_started" if enabled else "disabled"),
        "segment_seconds": raw.get("segment_seconds"),
        "bit_rate": raw.get("bit_rate"),
        "planned_segment_count": raw.get("planned_segment_count", 0),
        "pulled_segment_count": pulled_count,
        "segments": segments,
    }


def summarize_report(
    samples: list[dict[str, Any]],
    sampler_summary: dict[str, Any],
    manifest: dict[str, Any],
    flow: dict[str, Any],
    config: dict[str, Any],
    artifact_dir: Path,
    repo_root: Path,
    diagnostic_samples: list[dict[str, Any]] | None = None,
    perfetto_validation: dict[str, Any] | None = None,
) -> dict[str, Any]:
    thresholds = config.get("thresholds", {})
    script = project_performance_script(config.get("_performance_script"))
    duration = as_float(sampler_summary.get("requested_duration_s")) or as_float(manifest.get("duration_s")) or 180.0
    interval = as_float(sampler_summary.get("interval_s")) or as_float(manifest.get("interval_s")) or 5.0
    expected_rows = int(sampler_summary.get("expected_rows") or round(duration / interval))
    minimum_ratio = float(thresholds.get("minimum_valid_sample_ratio", 0.9))

    multi = metric_stats(row.get("cpu_one_core_equiv_pct") for row in samples)
    normalized = metric_stats(row.get("cpu_device_normalized_pct") for row in samples)
    pss = metric_stats(row.get("pss_mb") for row in samples)
    rss = metric_stats(row.get("rss_mb") for row in samples)
    diagnostic_samples = diagnostic_samples or []
    perfetto_validation = perfetto_validation or {}
    sampling_mode = str(
        sampler_summary.get("sampling_mode")
        or manifest.get("sampling_mode")
        or "standard"
    )
    diagnostic_cpu = metric_stats(
        row.get("cpu_device_normalized_pct") for row in diagnostic_samples
    )
    diagnostic_multi = metric_stats(
        row.get("cpu_one_core_equiv_pct") for row in diagnostic_samples
    )
    diagnostic_rss = metric_stats(row.get("rss_mb") for row in diagnostic_samples)
    logical_cpu_values = sorted(
        {int(value) for value in (row.get("logical_cpus") for row in samples) if value is not None}
    )
    expected_cpus = int(thresholds.get("expected_logical_cpus", 5))
    valid_primary = min(
        int(multi["valid_samples"] or 0),
        int(normalized["valid_samples"] or 0),
        int(pss["valid_samples"] or 0),
    )
    valid_ratio = round(valid_primary / expected_rows, 4) if expected_rows else 0.0

    checks = [
        check_protocol_minimum(
            "protocol_duration_s",
            "客户场景采样时长",
            duration,
            float(thresholds.get("required_duration_s", 180)),
            "s",
        ),
        check_protocol_minimum(
            "protocol_sample_rows",
            "客户场景采样窗口数",
            len(samples),
            int(thresholds.get("required_sample_rows", 36)),
            "rows",
        ),
        check_minimum(
            "valid_sample_ratio",
            "有效 CPU/PSS 采样覆盖率",
            valid_ratio,
            minimum_ratio,
            "ratio",
        ),
        check_limit(
            "cpu_customer_single_peak_pct",
            "客户口径 CPU 单核峰值",
            normalized["peak"],
            float(thresholds.get("cpu_customer_single_peak_pct", 3.3)),
            "%",
        ),
        check_limit(
            "cpu_multi_core_peak_pct",
            "CPU 多核累计峰值",
            multi["peak"],
            float(thresholds.get("cpu_multi_core_peak_pct", 16.5)),
            "%",
        ),
        check_limit(
            "cpu_customer_mean_pct",
            "客户口径 CPU 均值",
            normalized["mean"],
            float(thresholds.get("cpu_customer_mean_pct", 1.25)),
            "%",
        ),
        check_limit(
            "pss_peak_mb",
            "Total PSS 5 秒观测峰值",
            pss["peak"],
            float(thresholds.get("pss_peak_mb", 190)),
            "MiB",
        ),
        check_limit(
            "pss_mean_mb",
            "Total PSS 均值",
            pss["mean"],
            float(thresholds.get("pss_mean_mb", 140)),
            "MiB",
        ),
        {
            "key": "logical_cpu_topology",
            "label": "采样设备逻辑 CPU 核数口径",
            "status": (
                "pass"
                if logical_cpu_values == [expected_cpus]
                else ("fail" if logical_cpu_values else "inconclusive")
            ),
            "actual": logical_cpu_values,
            "limit": expected_cpus,
            "comparison": "all ==",
            "unit": "cores",
        },
    ]

    flow_mode = str(flow.get("mode") or manifest.get("flow_mode") or "unknown")
    if flow_mode == "full":
        flow_ok = (
            flow.get("status") == "completed"
            and bool(flow.get("download_install_completed"))
            and not flow.get("menus_missing")
        )
        checks.append(
            {
                "key": "full_flow",
                "label": "启动→详情→下载安装→我的二级菜单完整流程",
                "status": "pass" if flow_ok else "fail",
                "actual": flow.get("status", "missing"),
                "limit": "completed",
                "comparison": "==",
                "unit": "",
            }
        )

    perfetto_analysis_status = str(
        perfetto_validation.get("analysis_status") or "NOT_REQUESTED"
    ).upper()
    perfetto_threshold_status = str(
        perfetto_validation.get("threshold_status") or "NOT_EVALUATED"
    ).upper()
    if sampling_mode == "realtime":
        if perfetto_analysis_status == "COMPLETED" and perfetto_threshold_status == "PASS":
            perfetto_check_status = "pass"
        elif perfetto_analysis_status == "COMPLETED" and perfetto_threshold_status == "FAIL":
            perfetto_check_status = "fail"
        else:
            perfetto_check_status = "inconclusive"
        checks.append(
            {
                "key": "perfetto_cpu_consistency",
                "label": "Perfetto 调度 CPU 与 5 秒正式窗口一致性",
                "status": perfetto_check_status,
                "actual": f"{perfetto_analysis_status}/{perfetto_threshold_status}",
                "limit": "COMPLETED/PASS",
                "comparison": "==",
                "unit": "",
            }
        )

    statuses = {item["status"] for item in checks}
    acceptance = "FAIL" if "fail" in statuses else ("INCONCLUSIVE" if "inconclusive" in statuses else "PASS")
    warnings: list[str] = []
    if logical_cpu_values and logical_cpu_values != [expected_cpus]:
        warnings.append(
            f"采样设备逻辑 CPU 数为 {logical_cpu_values}，工作簿单核/多核阈值按 {expected_cpus} 核口径配置。"
        )
    elif not logical_cpu_values:
        warnings.append(f"未采集到逻辑 CPU 核数，无法确认 {expected_cpus} 核指标口径。")
    if sampler_summary.get("cancelled"):
        warnings.append("采样被取消，报告仅包含已落盘的部分窗口。")
    if sampling_mode == "realtime" and perfetto_analysis_status != "COMPLETED":
        reasons = ", ".join(str(value) for value in perfetto_validation.get("reason_codes", []) if value)
        warnings.append(
            "实时诊断的 Perfetto CPU 校验证据不可用"
            + (f"：{reasons}" if reasons else "。")
        )
    elif sampling_mode == "realtime" and perfetto_threshold_status == "FAIL":
        warnings.append("Perfetto 调度 CPU 与 /proc 5 秒正式窗口偏差超过一致性阈值。")
    warnings.extend(str(value) for value in manifest.get("warnings", []) if value)
    warnings.extend(str(value) for value in flow.get("warnings", []) if value)

    report = {
        "schema_version": 1,
        "session_id": str(manifest.get("session_id") or uuid.uuid4()),
        "scenario": "resource_profile",
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "acceptance": acceptance,
        "package": manifest.get("package") or sampler_summary.get("package") or "com.appmarket.automotive",
        "flavor": manifest.get("flavor") or "",
        "round": manifest.get("round") or f"resource_{time.strftime('%Y%m%d_%H%M%S')}",
        "device": manifest.get("device", {}),
        "app": manifest.get("app", {}),
        "sampling": {
            "mode": sampling_mode,
            "requested_duration_s": duration,
            "interval_s": interval,
            "expected_rows": expected_rows,
            "actual_rows": len(samples),
            "valid_primary_rows": valid_primary,
            "valid_sample_ratio": valid_ratio,
            "rows_with_process_change": sampler_summary.get("rows_with_process_change", 0),
            "cancelled": bool(sampler_summary.get("cancelled")),
            "cpu_interval_ms": (
                sampler_summary.get("diagnostic", {}).get("cpu_interval_ms")
                if isinstance(sampler_summary.get("diagnostic"), dict)
                else int(interval * 1000)
            ),
            "rss_interval_ms": (
                sampler_summary.get("diagnostic", {}).get("rss_interval_ms")
                if isinstance(sampler_summary.get("diagnostic"), dict)
                else int(interval * 1000)
            ),
            "pss_interval_ms": int(interval * 1000),
        },
        "measurements": {
            "cpu_multi_core_pct": multi,
            "cpu_device_normalized_pct": normalized,
            "pss_mb": pss,
            "rss_mb": rss,
            "logical_cpu_values": logical_cpu_values,
        },
        "metric_definitions": {
            "cpu_multi_core_pct": "技术字段 cpu_one_core_equiv_pct；100% 表示持续占满一个逻辑核，可超过 100%。",
            "cpu_device_normalized_pct": "技术字段 cpu_device_normalized_pct；占整机全部逻辑 CPU 容量的比例。本报告按工作簿映射为客户单核口径。",
            "memory": "主指标为目标包主进程及 package:* 子进程 Total PSS 之和；峰值是 5 秒窗口观测峰值。",
        },
        "thresholds": thresholds,
        "checks": checks,
        "flow": flow,
        "screenrecord": summarize_screenrecord(manifest),
        "diagnostic": {
            "enabled": sampling_mode == "realtime",
            "sampling_mode": sampling_mode,
            "actual_rows": len(diagnostic_samples),
            "collector": sampler_summary.get("diagnostic", {}),
            "measurements": {
                "cpu_device_normalized_pct": diagnostic_cpu,
                "cpu_one_core_equiv_pct": diagnostic_multi,
                "rss_mb": diagnostic_rss,
            },
        },
        "perfetto_validation": perfetto_validation,
        "warnings": list(dict.fromkeys(warnings)),
        "artifact_dir": relative_path(artifact_dir, repo_root),
    }
    if script is not None:
        report["script"] = script
    report["optimization_advice"] = build_optimization_advice(report, samples)
    return report


def build_platform_payload(report: dict[str, Any], samples: list[dict[str, Any]]) -> dict[str, Any]:
    measurements = report["measurements"]
    normalized = measurements["cpu_device_normalized_pct"]
    multi = measurements["cpu_multi_core_pct"]
    pss = measurements["pss_mb"]
    rss = measurements["rss_mb"]
    metrics: list[dict[str, Any]] = []
    summary_metrics = (
        ("fg", "cpu:fgPeak", normalized["peak"]),
        ("fg", "cpu:fgAvg", normalized["mean"]),
        ("fg", "mem:fgPeakPss", pss["peak"]),
        ("fg", "mem:fgAvgPss", pss["mean"]),
        ("resource_summary", "cpu:multiCorePeak", multi["peak"]),
        ("resource_summary", "cpu:multiCoreAvg", multi["mean"]),
        ("resource_summary", "mem:rssPeak", rss["peak"]),
        ("resource_summary", "mem:rssAvg", rss["mean"]),
    )
    for metric_type, name, value in summary_metrics:
        if value is not None:
            metrics.append({"type": metric_type, "name": name, "value": value})
    for row in samples:
        for metric_type, name, key in (
            ("cpu", "cpu:appPercent", "cpu_device_normalized_pct"),
            ("cpu", "cpu:multiCorePercent", "cpu_one_core_equiv_pct"),
            ("memory", "mem:pssMb", "pss_mb"),
            ("memory", "mem:rssMb", "rss_mb"),
        ):
            value = row.get(key)
            if value is not None:
                metrics.append({"type": metric_type, "name": name, "value": value})

    device = report.get("device", {})
    app = report.get("app", {})
    profile = {key: value for key, value in report.items() if key not in {"platform_payload", "upload"}}
    return {
        "sessionId": report["session_id"],
        "scenario": "resource_profile",
        "flavor": report.get("flavor", ""),
        "appVersion": app.get("version_name", ""),
        "appVersionCode": app.get("version_code", 0),
        "deviceModel": device.get("model", ""),
        "deviceBrand": device.get("brand", ""),
        "deviceId": device.get("serial", ""),
        "round": report.get("round", ""),
        "startup": {},
        "metrics": metrics,
        "events": [],
        # Preserve every derived CSV row in the backend raw_json envelope.
        # Raw /proc and dumpsys responses remain in the local JSONL artifact.
        "resourceSamples": [dict(row) for row in samples],
        "resourceProfile": profile,
    }


def fmt(value: Any, digits: int = 2) -> str:
    return "—" if value is None else f"{float(value):.{digits}f}"


def build_optimization_advice(
    report: dict[str, Any],
    samples: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Build deterministic recommendations that point back to checks/samples."""
    checks = {
        str(item.get("key")): item
        for item in report.get("checks", [])
        if isinstance(item, dict) and item.get("key")
    }
    advice: list[dict[str, Any]] = []

    def failed(*keys: str) -> list[str]:
        return [
            key for key in keys
            if str(checks.get(key, {}).get("status", "pass")).lower() != "pass"
        ]

    def check_evidence(keys: list[str]) -> list[str]:
        evidence: list[str] = []
        for key in keys:
            check = checks.get(key, {})
            actual = check.get("actual")
            limit = check.get("limit")
            unit = str(check.get("unit") or "")
            evidence.append(
                f"{check.get('label') or key}：实测 {actual}{unit}，"
                f"要求 {check.get('comparison') or ''} {limit}{unit}，"
                f"状态 {str(check.get('status') or 'inconclusive').upper()}"
            )
        return evidence

    def peak_sample(metric_key: str) -> dict[str, Any] | None:
        candidates = [row for row in samples if as_float(row.get(metric_key)) is not None]
        if not candidates:
            return None
        row = max(candidates, key=lambda value: float(value.get(metric_key)))
        return {
            "sample_index": row.get("sample_index"),
            "elapsed_s": row.get("actual_elapsed_s"),
            "metric": metric_key,
            "value": row.get(metric_key),
        }

    def add(
        advice_id: str,
        priority: str,
        title: str,
        related_checks: list[str],
        evidence: list[str],
        actions: list[str],
        verification: list[str],
        source_samples: list[dict[str, Any]] | None = None,
    ) -> None:
        advice.append(
            {
                "id": advice_id,
                "priority": priority,
                "title": title,
                "related_checks": related_checks,
                "evidence": evidence,
                "actions": actions,
                "verification": verification,
                "source_samples": source_samples or [],
            }
        )

    protocol_keys = failed("protocol_duration_s", "protocol_sample_rows", "valid_sample_ratio")
    if protocol_keys:
        add(
            "complete-customer-protocol",
            "P0",
            "先补齐正式 3 分钟采样证据",
            protocol_keys,
            check_evidence(protocol_keys),
            [
                "按 180 秒、每 5 秒一次执行完整业务工作流，目标为 36 个有效窗口。",
                "保持设备、应用版本、录屏与 Perfetto 开关一致，避免工具开销改变基线。",
                "若采样缺失，先排查 adb 抖动、进程重启和单次采集耗时，再判断性能阈值。",
            ],
            ["复测后 protocol_duration_s、protocol_sample_rows、valid_sample_ratio 均应为 PASS。"],
        )

    topology_keys = failed("logical_cpu_topology")
    if topology_keys:
        add(
            "align-cpu-topology",
            "P0",
            "校准逻辑 CPU 核数与客户阈值口径",
            topology_keys,
            check_evidence(topology_keys),
            [
                "确认本轮设备逻辑核数，并按相同核数重新解释整机归一化与单核等效值。",
                "不要直接把不同核数设备的 CPU 百分比放在同一阈值下比较。",
            ],
            ["同一轮所有采样点的 logical_cpus 应稳定等于配置 expected_logical_cpus。"],
        )

    cpu_keys = failed(
        "cpu_customer_single_peak_pct",
        "cpu_multi_core_peak_pct",
        "cpu_customer_mean_pct",
    )
    if cpu_keys:
        sources = [value for value in [peak_sample("cpu_one_core_equiv_pct"), peak_sample("cpu_device_normalized_pct")] if value]
        add(
            "reduce-cpu-hotspots",
            "P1",
            "定位 CPU 峰值并压缩持续计算",
            cpu_keys,
            check_evidence(cpu_keys),
            [
                "以 source_samples 标记的峰值窗口为时间锚点，单独复跑 Perfetto，查看主线程、下载/安装轮询和列表渲染热点。",
                "合并重复网络/数据库查询，对轮询与搜索输入做节流，避免页面滚动时重复绑定或全量刷新。",
                "将可延后工作移出首屏与主线程，并对下载安装状态更新采用增量刷新。",
            ],
            [
                "相同脚本连续复测至少 3 轮，CPU 均值和峰值均回到对应阈值内。",
                "优化前后使用同一设备、版本、脚本和录屏设置。",
            ],
            sources,
        )

    memory_keys = failed("pss_peak_mb", "pss_mean_mb")
    if memory_keys:
        source = peak_sample("pss_mb")
        add(
            "reduce-memory-retention",
            "P1",
            "区分内存峰值与持续驻留并缩减 PSS",
            memory_keys,
            check_evidence(memory_keys),
            [
                "在 source_samples 对应窗口核对大图解码、WebView、下载页缓存和详情页对象是否仍被引用。",
                "为图片与列表缓存设置容量上限，页面退出时释放观察者、回调和临时安装资源。",
                "若 PSS 随菜单遍历持续上升，增加一次 Heap Dump/内存分配诊断运行，正式阈值轮不同时开启高开销分析器。",
            ],
            [
                "完成同脚本 3 轮复测，PSS 均值与 5 秒观测峰值分别低于配置阈值。",
                "比较流程结束返回首页后的 PSS，确认不会逐轮累积。",
            ],
            [source] if source else [],
        )

    flow_keys = failed("full_flow")
    if flow_keys:
        add(
            "stabilize-test-workflow",
            "P0",
            "先修复业务工作流覆盖再判定性能",
            flow_keys,
            check_evidence(flow_keys),
            [
                "根据 flow/flow_events.jsonl 中最后一个成功步骤修正控件选择器和等待条件。",
                "确认下载安装完成且“我的”全部二级菜单均被遍历，避免把不完整场景的低负载误判为通过。",
            ],
            ["下一轮 full_flow 为 PASS，且工作流快照与所选脚本 ID 一致。"],
        )

    changed_rows = int(report.get("sampling", {}).get("rows_with_process_change") or 0)
    if changed_rows:
        add(
            "verify-process-set-stability",
            "P1",
            "核对应用子进程变化对 CPU/PSS 聚合的影响",
            [],
            [f"采样汇总记录到 {changed_rows} 个窗口发生目标进程集合变化。"],
            [
                "结合 raw/sampler_raw_commands.jsonl 确认新增/消失的 package:* 子进程及发生时间。",
                "检查下载、WebView 或安装相关子进程退出后内存是否正常回落。",
            ],
            ["复测报告中的进程变化可被业务步骤解释，且主进程/子进程 PSS 聚合无缺口。"],
        )

    if not advice:
        cpu_source = peak_sample("cpu_one_core_equiv_pct")
        memory_source = peak_sample("pss_mb")
        add(
            "preserve-passing-baseline",
            "P2",
            "固化本轮通过基线并持续回归",
            [str(item.get("key")) for item in report.get("checks", []) if item.get("key")],
            [f"本轮结论为 {report.get('acceptance')}，当前已定义检查项没有失败或证据不足。"],
            [
                "保存设备、应用版本、脚本快照、阈值和原始采样作为可复现基线。",
                "后续版本仍执行同脚本 3 轮，使用均值的中位数及各轮峰值最大值比较。",
                "若出现回退，再围绕 source_samples 的峰值窗口开启专项 Perfetto/Heap 诊断。",
            ],
            ["同环境连续 3 轮均保持 PASS，且均值/峰值没有显著回退。"],
            [value for value in (cpu_source, memory_source) if value],
        )

    priority_rank = {"P0": 0, "P1": 1, "P2": 2}
    advice.sort(key=lambda item: (priority_rank.get(item["priority"], 9), item["id"]))
    return advice


def optimization_advice_markdown(report: dict[str, Any]) -> str:
    lines = [
        "# 应用市场性能优化建议",
        "",
        f"- 会话：`{report.get('session_id', '')}`",
        f"- 轮次：`{report.get('round', '')}`",
        f"- 结论：**{report.get('acceptance', 'INCONCLUSIVE')}**",
        "- 说明：每条建议均包含关联检查、实测证据和复验条件，可回溯到同轮 `report.json` 与原始采样。",
        "",
    ]
    for item in report.get("optimization_advice", []):
        lines += [
            f"## [{item.get('priority', 'P2')}] {item.get('title', '')}",
            "",
            f"- 建议编号：`{item.get('id', '')}`",
            f"- 关联检查：{', '.join(item.get('related_checks', [])) or '无（来自采样稳定性证据）'}",
            "- 证据：",
        ]
        lines += [f"  - {value}" for value in item.get("evidence", [])]
        if item.get("source_samples"):
            lines.append(f"  - 峰值采样：`{json.dumps(item['source_samples'], ensure_ascii=False)}`")
        lines.append("- 建议动作：")
        lines += [f"  - {value}" for value in item.get("actions", [])]
        lines.append("- 复验标准：")
        lines += [f"  - {value}" for value in item.get("verification", [])]
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def artifact_entry(
    key: str,
    label: str,
    path: Path,
    media_type: str,
    repo_root: Path,
    *,
    include_integrity: bool = False,
) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "key": key,
        "label": label,
        "path": relative_path(path, repo_root),
        "media_type": media_type,
    }
    if include_integrity and path.is_file():
        entry["bytes"] = path.stat().st_size
        entry["sha256"] = sha256_file(path)
    return entry


def markdown_report(report: dict[str, Any]) -> str:
    m = report["measurements"]
    s = report["sampling"]
    diagnostic = report.get("diagnostic", {})
    perfetto = report.get("perfetto_validation", {})
    lines = [
        "# 应用市场 CPU / 内存性能摸测报告",
        "",
        f"- 结论：**{report['acceptance']}**",
        f"- 包名：`{report['package']}`",
        f"- 轮次：`{report['round']}`",
        f"- 模式：`{s.get('mode', 'standard')}`",
        f"- 采样：每 {fmt(s['interval_s'], 0)} 秒一次，{s['actual_rows']}/{s['expected_rows']} 行，有效覆盖率 {fmt(s['valid_sample_ratio'] * 100)}%",
        f"- 产物目录：`{report['artifact_dir']}`",
        "",
        "## 指标结果",
        "",
        "| 指标 | 均值 | 5 秒观测峰值 |",
        "|---|---:|---:|",
        f"| CPU 多核累计（单核等效） | {fmt(m['cpu_multi_core_pct']['mean'])}% | {fmt(m['cpu_multi_core_pct']['peak'])}% |",
        f"| CPU 整机归一化（工作簿客户单核映射） | {fmt(m['cpu_device_normalized_pct']['mean'])}% | {fmt(m['cpu_device_normalized_pct']['peak'])}% |",
        f"| Total PSS | {fmt(m['pss_mb']['mean'])} MiB | {fmt(m['pss_mb']['peak'])} MiB |",
        f"| RSS（辅助） | {fmt(m['rss_mb']['mean'])} MiB | {fmt(m['rss_mb']['peak'])} MiB |",
        "",
    ]
    if diagnostic.get("enabled"):
        dm = diagnostic.get("measurements", {})
        dcpu = dm.get("cpu_device_normalized_pct", {})
        drss = dm.get("rss_mb", {})
        lines += [
            "## 实时诊断",
            "",
            f"- 高频点：{diagnostic.get('actual_rows', 0)}；CPU {s.get('cpu_interval_ms', 500)}ms，RSS {s.get('rss_interval_ms', 1000)}ms，PSS {s.get('pss_interval_ms', 5000)}ms。",
            f"- 500ms CPU：均值 {fmt(dcpu.get('mean'))}% / 峰值 {fmt(dcpu.get('peak'))}%（仅诊断，不参与旧阈值）。",
            f"- 1s RSS：均值 {fmt(drss.get('mean'))} MiB / 峰值 {fmt(drss.get('peak'))} MiB。",
            f"- Perfetto 校验：{perfetto.get('analysis_status', 'unavailable')} / {perfetto.get('threshold_status', 'INCONCLUSIVE')}。",
            "",
        ]
    lines += [
        "## 阈值检查",
        "",
        "| 检查项 | 实测 | 要求 | 结果 |",
        "|---|---:|---:|:---:|",
    ]
    for check in report["checks"]:
        actual = check["actual"]
        actual_text = fmt(actual) if isinstance(actual, (int, float)) else str(actual)
        limit = check["limit"]
        limit_text = fmt(limit) if isinstance(limit, (int, float)) else str(limit)
        lines.append(
            f"| {check['label']} | {actual_text}{check['unit']} | {check['comparison']} {limit_text}{check['unit']} | {check['status'].upper()} |"
        )
    if report.get("warnings"):
        lines += ["", "## 注意事项", ""]
        lines += [f"- {warning}" for warning in report["warnings"]]
    if report.get("optimization_advice"):
        lines += ["", "## 优化建议", ""]
        for item in report["optimization_advice"]:
            lines += [
                f"### [{item['priority']}] {item['title']}",
                "",
                f"- 建议编号：`{item['id']}`",
                f"- 关联检查：{', '.join(item['related_checks']) or '无'}",
                f"- 证据：{'；'.join(item['evidence'])}",
                f"- 动作：{'；'.join(item['actions'])}",
                f"- 复验：{'；'.join(item['verification'])}",
                "",
            ]
    lines += [
        "",
        "## 口径",
        "",
        "- CPU 多核累计使用 `cpu_one_core_equiv_pct = 100 × N × ΔP / ΔT`。",
        "- CPU 整机归一化使用 `cpu_device_normalized_pct = 100 × ΔP / ΔT`。",
        "- 内存主指标为目标包全部进程 Total PSS 之和；RSS 仅辅助观察。",
    ]
    return "\n".join(lines) + "\n"


def upload_payload(gateway: str, payload: dict[str, Any]) -> dict[str, Any]:
    url = gateway.rstrip("/") + "/api/performance/ingest"
    request = urllib.request.Request(
        url,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            body = response.read().decode("utf-8", "replace")
            return {"status": "uploaded", "url": url, "response": json.loads(body)}
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError) as exc:
        return {"status": "failed", "url": url, "error": str(exc)}


def build_parser() -> argparse.ArgumentParser:
    config_dir = Path(__file__).resolve().parent.parent / "config"
    parser = argparse.ArgumentParser(description="Analyze AppMarket resource samples")
    parser.add_argument("--csv", type=Path, required=True)
    parser.add_argument("--sampler-summary", type=Path, default=None)
    parser.add_argument("--diagnostic-csv", type=Path, default=None)
    parser.add_argument("--perfetto-validation", type=Path, default=None)
    parser.add_argument("--perfetto-trace", type=Path, default=None)
    parser.add_argument("--manifest", type=Path, default=None)
    parser.add_argument("--flow-result", type=Path, default=None)
    parser.add_argument("--config", type=Path, default=config_dir / "appmarket_flow_config.json")
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument("--artifact-dir", type=Path, default=None)
    parser.add_argument("--gateway", default="")
    parser.add_argument("--no-upload", action="store_true")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    if not args.csv.exists():
        print(f"ERROR: CSV does not exist: {args.csv}")
        return 2
    samples = read_samples(args.csv)
    diagnostic_samples = read_diagnostic_samples(args.diagnostic_csv)
    sampler_summary = read_json(args.sampler_summary, {})
    perfetto_validation = read_json(args.perfetto_validation, {})
    manifest = read_json(args.manifest, {})
    flow = read_json(args.flow_result, {"mode": manifest.get("flow_mode", "unknown"), "status": "missing"})
    config = read_json(args.config, {})
    repo_root = find_repo_root(Path(__file__).resolve().parent)
    artifact_dir = args.artifact_dir or args.csv.parent
    report = summarize_report(
        samples,
        sampler_summary,
        manifest,
        flow,
        config,
        artifact_dir,
        repo_root,
        diagnostic_samples,
        perfetto_validation,
    )
    args.out_dir.mkdir(parents=True, exist_ok=True)
    json_path = args.out_dir / "report.json"
    md_path = args.out_dir / "report.md"
    summary_pdf_path = args.out_dir / "report_summary.pdf"
    detailed_pdf_path = args.out_dir / "report_detailed.pdf"
    advice_path = args.out_dir / "optimization_advice.md"
    payload_path = args.out_dir / "platform_payload.json"
    report["artifacts"] = [
        artifact_entry("metrics_csv", "逐点指标 CSV", args.csv, "text/csv", repo_root),
        artifact_entry("report_json", "分析报告 JSON", json_path, "application/json", repo_root),
        artifact_entry("report_md", "分析报告 Markdown", md_path, "text/markdown", repo_root),
        artifact_entry("report_pdf_summary", "性能报告 PDF（简版）", summary_pdf_path, "application/pdf", repo_root),
        artifact_entry("report_pdf_detailed", "性能报告 PDF（详细版）", detailed_pdf_path, "application/pdf", repo_root),
        artifact_entry("optimization_advice", "性能优化建议", advice_path, "text/markdown", repo_root),
        artifact_entry("platform_payload", "平台上报原文", payload_path, "application/json", repo_root),
    ]
    if args.diagnostic_csv and args.diagnostic_csv.is_file():
        report["artifacts"].append(
            artifact_entry(
                "diagnostic_metrics_csv",
                "实时诊断 CPU/RSS CSV",
                args.diagnostic_csv,
                "text/csv",
                repo_root,
            )
        )
    if args.perfetto_validation and args.perfetto_validation.is_file():
        report["artifacts"].append(
            artifact_entry(
                "perfetto_cpu_validation",
                "Perfetto CPU 校验 JSON",
                args.perfetto_validation,
                "application/json",
                repo_root,
            )
        )
    if args.perfetto_trace and args.perfetto_trace.is_file():
        report["artifacts"].append(
            artifact_entry(
                "perfetto_trace",
                "Perfetto 原始 Trace",
                args.perfetto_trace,
                "application/octet-stream",
                repo_root,
            )
        )
    advice_path.write_text(optimization_advice_markdown(report), encoding="utf-8")
    pdf_error: str | None = None
    # Re-analysis must not leave an older PDF looking like the current report
    # when dependency/font/layout validation fails before a new file is built.
    summary_pdf_path.unlink(missing_ok=True)
    detailed_pdf_path.unlink(missing_ok=True)
    try:
        _pdf_paths, font_info = write_pdf_reports(report, samples, args.out_dir)
    except PdfReportError as exc:
        pdf_error = str(exc)
        report["pdf"] = {"status": "failed", "error": pdf_error}
        report["warnings"] = list(dict.fromkeys([*report.get("warnings", []), f"PDF 报告生成失败：{pdf_error}"]))
    else:
        report["pdf"] = {
            "status": "completed",
            "summary": relative_path(summary_pdf_path, repo_root),
            "detailed": relative_path(detailed_pdf_path, repo_root),
            "font": font_info,
        }

    payload = build_platform_payload(report, samples)
    report["platform_payload"] = {
        "session_id": payload["sessionId"],
        "metrics_count": len(payload["metrics"]),
        "endpoint": "/api/performance/ingest",
    }
    if args.gateway and not args.no_upload:
        report["upload"] = upload_payload(args.gateway, payload)
    else:
        report["upload"] = {"status": "skipped"}

    atomic_write_json(json_path, report)
    md_path.write_text(markdown_report(report), encoding="utf-8")
    atomic_write_json(payload_path, payload)
    if args.manifest and args.manifest.exists() and isinstance(manifest, dict):
        manifest["acceptance"] = report["acceptance"]
        manifest["report_json"] = relative_path(json_path, repo_root)
        manifest["report_md"] = relative_path(md_path, repo_root)
        manifest["optimization_advice"] = relative_path(advice_path, repo_root)
        manifest["reports"] = {
            "json": manifest["report_json"],
            "markdown": manifest["report_md"],
            "optimization_advice": manifest["optimization_advice"],
        }
        if summary_pdf_path.is_file():
            manifest["report_pdf_summary"] = relative_path(summary_pdf_path, repo_root)
            manifest["reports"]["pdf_summary"] = manifest["report_pdf_summary"]
        else:
            manifest.pop("report_pdf_summary", None)
        if detailed_pdf_path.is_file():
            manifest["report_pdf_detailed"] = relative_path(detailed_pdf_path, repo_root)
            manifest["reports"]["pdf_detailed"] = manifest["report_pdf_detailed"]
        else:
            manifest.pop("report_pdf_detailed", None)
        artifact_paths = {
            "metrics_csv": args.csv,
            "report_json": json_path,
            "report_md": md_path,
            "report_pdf_summary": summary_pdf_path,
            "report_pdf_detailed": detailed_pdf_path,
            "optimization_advice": advice_path,
            "platform_payload": payload_path,
        }
        if args.diagnostic_csv and args.diagnostic_csv.is_file():
            artifact_paths["diagnostic_metrics_csv"] = args.diagnostic_csv
        if args.perfetto_validation and args.perfetto_validation.is_file():
            artifact_paths["perfetto_cpu_validation"] = args.perfetto_validation
        if args.perfetto_trace and args.perfetto_trace.is_file():
            artifact_paths["perfetto_trace"] = args.perfetto_trace
        labels_and_types = {
            entry["key"]: (entry["label"], entry["media_type"])
            for entry in report["artifacts"]
        }
        manifest["artifacts"] = [
            artifact_entry(key, labels_and_types[key][0], path, labels_and_types[key][1], repo_root, include_integrity=True)
            for key, path in artifact_paths.items()
            if path.is_file()
        ]
        if pdf_error:
            manifest["report_generation_error"] = pdf_error
        else:
            manifest.pop("report_generation_error", None)
        manifest["last_analyzed_at"] = report["generated_at"]
        atomic_write_json(args.manifest, manifest)
    print(f"REPORT_JSON={relative_path(json_path, repo_root)}")
    print(f"REPORT_MD={relative_path(md_path, repo_root)}")
    if summary_pdf_path.is_file():
        print(f"REPORT_PDF_SUMMARY={relative_path(summary_pdf_path, repo_root)}")
    if detailed_pdf_path.is_file():
        print(f"REPORT_PDF_DETAILED={relative_path(detailed_pdf_path, repo_root)}")
    print(f"OPTIMIZATION_ADVICE={relative_path(advice_path, repo_root)}")
    print(f"ACCEPTANCE={report['acceptance']}")
    print(f"UPLOAD={report['upload']['status']}")
    if pdf_error:
        print(f"ERROR: {pdf_error}")
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
