#!/usr/bin/env python3
"""Validate sampler CPU windows against scheduler time from a Perfetto trace.

The validator is intentionally an evidence-side tool: missing optional tooling,
an unavailable trace, or unsafe windows produce a machine-readable
UNAVAILABLE/INCONCLUSIVE result and exit successfully.  Only invalid CLI
arguments or an unwritable output path are process failures.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import importlib.metadata
import math
import re
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

from performance_json_io import atomic_write_json


SCHEMA_VERSION = 1
MEAN_ABS_DEVICE_PCT_LIMIT = 0.5
P95_ABS_DEVICE_PCT_LIMIT = 1.0
MIN_WINDOW_COVERAGE = 0.8
MIN_INDIVIDUAL_TRACE_COVERAGE = 0.999
PACKAGE_PATTERN = re.compile(r"^[A-Za-z0-9_.]+$")
QUERY_MARKER = re.compile(r"^\s*--\s*PERFETTO_QUERY:\s*([a-z][a-z0-9_]*)\s*$")
SQL_PATH = Path(__file__).resolve().parent.parent / "diagnostics" / "appmarket_cpu_validation.sql"


class ValidationUnavailable(RuntimeError):
    """The trace cannot be evaluated because an optional input/tool is absent."""

    def __init__(self, reason_code: str, message: str = "") -> None:
        super().__init__(message or reason_code)
        self.reason_code = reason_code


class TraceInvalid(RuntimeError):
    """The trace or SQL result is present but cannot be trusted."""

    def __init__(self, reason_code: str, message: str = "") -> None:
        super().__init__(message or reason_code)
        self.reason_code = reason_code


@dataclass(frozen=True)
class SamplerWindow:
    sample_index: int
    start_s: float
    end_s: float
    logical_cpus: int
    sampler_device_pct: float

    @property
    def start_ns(self) -> int:
        return int(round(self.start_s * 1_000_000_000))

    @property
    def end_ns(self) -> int:
        return int(round(self.end_s * 1_000_000_000))

    @property
    def duration_ns(self) -> int:
        return self.end_ns - self.start_ns


@dataclass(frozen=True)
class WindowParseResult:
    windows: tuple[SamplerWindow, ...]
    total_rows: int
    issues: tuple[str, ...]


def _finite_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def _positive_integer(value: Any) -> int | None:
    parsed = _finite_float(value)
    if parsed is None or parsed <= 0 or abs(parsed - round(parsed)) > 1e-9:
        return None
    return int(round(parsed))


def validate_package(package: str) -> str:
    normalized = str(package or "").strip()
    if not PACKAGE_PATTERN.fullmatch(normalized):
        raise ValueError("package must contain only ASCII letters, digits, dots, and underscores")
    return normalized


def parse_sampler_rows(rows: Iterable[Mapping[str, Any]]) -> WindowParseResult:
    """Parse exact device-BOOTTIME CPU boundaries from sampler CSV rows."""
    raw_rows = list(rows)
    candidates: list[SamplerWindow] = []
    issues: list[str] = []
    seen_indexes: set[int] = set()

    for position, row in enumerate(raw_rows, 1):
        sample_index = _positive_integer(row.get("sample_index"))
        start_s = _finite_float(row.get("cpu_source_start_s"))
        end_s = _finite_float(row.get("cpu_source_end_s"))
        logical_cpus = _positive_integer(row.get("logical_cpus"))
        sampler_pct = _finite_float(row.get("cpu_device_normalized_pct"))
        if sample_index is None:
            issues.append(f"row_{position}:invalid_sample_index")
            continue
        if sample_index in seen_indexes:
            issues.append(f"row_{position}:duplicate_sample_index")
            continue
        seen_indexes.add(sample_index)
        if start_s is None or end_s is None or start_s < 0 or end_s <= start_s:
            issues.append(f"row_{position}:invalid_cpu_source_window")
            continue
        if logical_cpus is None:
            issues.append(f"row_{position}:invalid_logical_cpus")
            continue
        if sampler_pct is None or sampler_pct < 0:
            issues.append(f"row_{position}:invalid_sampler_cpu")
            continue
        window = SamplerWindow(sample_index, start_s, end_s, logical_cpus, sampler_pct)
        if window.duration_ns <= 0:
            issues.append(f"row_{position}:window_rounds_to_zero")
            continue
        candidates.append(window)

    accepted: list[SamplerWindow] = []
    for window in sorted(candidates, key=lambda item: (item.start_ns, item.sample_index)):
        if accepted and window.start_ns < accepted[-1].end_ns:
            issues.append(f"sample_{window.sample_index}:overlapping_cpu_window")
            continue
        accepted.append(window)
    return WindowParseResult(tuple(accepted), len(raw_rows), tuple(issues))


def read_sampler_windows(path: Path) -> WindowParseResult:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return parse_sampler_rows(csv.DictReader(handle))


def parse_named_queries(text: str) -> dict[str, str]:
    """Split one checked-in SQL file into independently executable queries."""
    result: dict[str, str] = {}
    current_name: str | None = None
    current_lines: list[str] = []

    def finish() -> None:
        nonlocal current_name, current_lines
        if current_name is None:
            return
        query = "\n".join(current_lines).strip()
        if not query:
            raise ValueError(f"SQL query {current_name!r} is empty")
        if current_name in result:
            raise ValueError(f"duplicate SQL query {current_name!r}")
        result[current_name] = query

    for line in text.splitlines():
        marker = QUERY_MARKER.match(line)
        if marker:
            finish()
            current_name = marker.group(1)
            current_lines = []
        elif current_name is not None:
            current_lines.append(line)
    finish()
    return result


def sql_string(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def render_window_query(template: str, windows: Sequence[SamplerWindow], package: str) -> str:
    package = validate_package(package)
    if not windows:
        raise ValueError("at least one sampler window is required")
    values = ",\n    ".join(
        "(" + ", ".join(
            (
                str(window.sample_index),
                str(window.start_ns),
                str(window.end_ns),
                str(window.logical_cpus),
                repr(float(window.sampler_device_pct)),
            )
        ) + ")"
        for window in windows
    )
    replacements = {
        "__WINDOW_VALUES__": values,
        "__PACKAGE_EXACT__": sql_string(package),
        "__PACKAGE_CHILD_GLOB__": sql_string(package + ":*"),
    }
    rendered = template
    for marker, value in replacements.items():
        if marker not in rendered:
            raise ValueError(f"SQL template is missing {marker}")
        rendered = rendered.replace(marker, value)
    return rendered


def percentile(values: Sequence[float], quantile: float) -> float | None:
    clean = sorted(float(value) for value in values if math.isfinite(float(value)))
    if not clean:
        return None
    if not 0 <= quantile <= 1:
        raise ValueError("quantile must be between zero and one")
    if len(clean) == 1:
        return clean[0]
    position = (len(clean) - 1) * quantile
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return clean[lower]
    weight = position - lower
    return clean[lower] * (1 - weight) + clean[upper] * weight


def _round(value: float | None, digits: int = 6) -> float | None:
    return None if value is None else round(float(value), digits)


def _check(
    key: str,
    actual: float | int | None,
    limit: float | int,
    comparison: str,
    unit: str,
    status: str = "INCONCLUSIVE",
) -> dict[str, Any]:
    return {
        "key": key,
        "actual": actual,
        "limit": limit,
        "comparison": comparison,
        "unit": unit,
        "status": status,
    }


def empty_result(package: str, trace: Path, csv_path: Path) -> dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "analysis_status": "UNAVAILABLE",
        "threshold_status": "INCONCLUSIVE",
        "reason_codes": [],
        "source": {
            "package": package,
            "trace_file": trace.name,
            "sampler_csv_file": csv_path.name,
            "sql_file": SQL_PATH.name,
            "trace_bytes": None,
            "trace_sha256": None,
            "sql_sha256": None,
            "processor_backend": None,
            "processor_package_version": None,
            "processor_native_version": None,
            "processor_binary": None,
            "processor_binary_sha256": None,
        },
        "window": {
            "requested_count": 0,
            "valid_count": 0,
            "compared_count": 0,
            "start_s": None,
            "end_s": None,
            "requested_duration_s": 0.0,
            "compared_duration_s": 0.0,
            "coverage_ratio": 0.0,
            "minimum_individual_trace_coverage": None,
        },
        "quality": {
            "sampler_window_issues": [],
            "trace_start_ns": None,
            "trace_end_ns": None,
            "sched_start_ns": None,
            "sched_end_ns": None,
            "target_sched_slice_count": 0,
            "data_loss": [],
            "errors": [],
        },
        "metrics": {
            "cpu_seconds": None,
            "cpu_one_core_equiv_mean_pct": None,
            "cpu_one_core_equiv_peak_pct": None,
            "cpu_device_normalized_mean_pct": None,
            "cpu_device_normalized_peak_pct": None,
            "windows": [],
        },
        "sampler_comparison": {
            "compared_windows": 0,
            "mean_abs_device_pct_delta": None,
            "p95_abs_device_pct_delta": None,
            "max_abs_device_pct_delta": None,
            "mean_abs_device_pct_limit": MEAN_ABS_DEVICE_PCT_LIMIT,
            "p95_abs_device_pct_limit": P95_ABS_DEVICE_PCT_LIMIT,
            "minimum_window_coverage": MIN_WINDOW_COVERAGE,
            "deltas": [],
        },
        "checks": [
            _check("trace_data_loss", None, 0, "==", "rows"),
            _check("window_coverage", 0.0, MIN_WINDOW_COVERAGE, ">=", "ratio"),
            _check(
                "mean_abs_device_pct_delta",
                None,
                MEAN_ABS_DEVICE_PCT_LIMIT,
                "<=",
                "percentage_points",
            ),
            _check(
                "p95_abs_device_pct_delta",
                None,
                P95_ABS_DEVICE_PCT_LIMIT,
                "<=",
                "percentage_points",
            ),
        ],
    }


def _append_reason(result: dict[str, Any], reason_code: str) -> None:
    reasons = result["reason_codes"]
    if reason_code not in reasons:
        reasons.append(reason_code)


def _populate_window_input(result: dict[str, Any], parsed: WindowParseResult) -> None:
    result["window"]["requested_count"] = parsed.total_rows
    result["window"]["valid_count"] = len(parsed.windows)
    result["quality"]["sampler_window_issues"] = list(parsed.issues)
    if parsed.windows:
        result["window"]["start_s"] = _round(min(window.start_s for window in parsed.windows), 9)
        result["window"]["end_s"] = _round(max(window.end_s for window in parsed.windows), 9)
        result["window"]["requested_duration_s"] = _round(
            sum(window.duration_ns for window in parsed.windows) / 1_000_000_000,
            6,
        )
    if parsed.issues:
        _append_reason(result, "invalid_sampler_windows")


def _row_value(row: Mapping[str, Any] | Any, key: str) -> Any:
    return row.get(key) if isinstance(row, Mapping) else getattr(row, key, None)


def _optional_int(value: Any) -> int | None:
    parsed = _finite_float(value)
    return None if parsed is None else int(round(parsed))


def evaluate_query_results(
    result: dict[str, Any],
    parsed: WindowParseResult,
    window_rows: Sequence[Mapping[str, Any]],
    data_loss_rows: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    """Pure verdict calculation over already queried Trace Processor rows."""
    _populate_window_input(result, parsed)
    result["quality"]["data_loss"] = [dict(row) for row in data_loss_rows]
    result["checks"][0] = _check(
        "trace_data_loss",
        len(data_loss_rows),
        0,
        "==",
        "rows",
        "PASS" if not data_loss_rows else "INCONCLUSIVE",
    )

    rows_by_index: dict[int, Mapping[str, Any]] = {}
    for row in window_rows:
        sample_index = _optional_int(_row_value(row, "sample_index"))
        if sample_index is not None and sample_index not in rows_by_index:
            rows_by_index[sample_index] = row

    if window_rows:
        first = window_rows[0]
        for source_key, quality_key in (
            ("trace_start_ns", "trace_start_ns"),
            ("trace_end_ns", "trace_end_ns"),
            ("sched_start_ns", "sched_start_ns"),
            ("sched_end_ns", "sched_end_ns"),
        ):
            result["quality"][quality_key] = _optional_int(_row_value(first, source_key))

    compared: list[dict[str, Any]] = []
    individual_coverages: list[float] = []
    total_sched_ns = 0
    total_duration_ns = 0
    normalized_weighted = 0.0
    target_slice_count = 0

    for window in parsed.windows:
        row = rows_by_index.get(window.sample_index)
        if row is None:
            continue
        coverage = _finite_float(_row_value(row, "trace_coverage_ratio"))
        coverage = max(0.0, min(1.0, coverage)) if coverage is not None else 0.0
        individual_coverages.append(coverage)
        if coverage < MIN_INDIVIDUAL_TRACE_COVERAGE:
            continue
        scheduled_ns = _optional_int(_row_value(row, "target_sched_ns"))
        slice_count = _optional_int(_row_value(row, "target_sched_slice_count"))
        if scheduled_ns is None or scheduled_ns < 0:
            continue
        scheduled_ns = min(scheduled_ns, window.duration_ns * window.logical_cpus)
        one_core_pct = 100.0 * scheduled_ns / window.duration_ns
        device_pct = one_core_pct / window.logical_cpus
        delta = device_pct - window.sampler_device_pct
        detail = {
            "sample_index": window.sample_index,
            "start_s": _round(window.start_s, 9),
            "end_s": _round(window.end_s, 9),
            "duration_s": _round(window.duration_ns / 1_000_000_000, 6),
            "logical_cpus": window.logical_cpus,
            "trace_coverage_ratio": _round(coverage, 6),
            "target_sched_ns": scheduled_ns,
            "target_sched_slice_count": slice_count or 0,
            "cpu_one_core_equiv_pct": _round(one_core_pct),
            "cpu_device_normalized_pct": _round(device_pct),
            "sampler_device_normalized_pct": _round(window.sampler_device_pct),
            "device_pct_delta": _round(delta),
            "abs_device_pct_delta": _round(abs(delta)),
        }
        compared.append(detail)
        total_sched_ns += scheduled_ns
        total_duration_ns += window.duration_ns
        normalized_weighted += device_pct * window.duration_ns
        target_slice_count += slice_count or 0

    requested_count = parsed.total_rows
    coverage_ratio = len(compared) / requested_count if requested_count else 0.0
    result["window"]["compared_count"] = len(compared)
    result["window"]["compared_duration_s"] = _round(total_duration_ns / 1_000_000_000, 6)
    result["window"]["coverage_ratio"] = _round(coverage_ratio, 6)
    result["window"]["minimum_individual_trace_coverage"] = (
        _round(min(individual_coverages), 6) if individual_coverages else None
    )
    result["quality"]["target_sched_slice_count"] = target_slice_count
    result["metrics"]["windows"] = compared

    absolute_deltas = [float(item["abs_device_pct_delta"]) for item in compared]
    mean_abs = sum(absolute_deltas) / len(absolute_deltas) if absolute_deltas else None
    p95_abs = percentile(absolute_deltas, 0.95)
    max_abs = max(absolute_deltas) if absolute_deltas else None
    result["sampler_comparison"].update(
        {
            "compared_windows": len(compared),
            "mean_abs_device_pct_delta": _round(mean_abs),
            "p95_abs_device_pct_delta": _round(p95_abs),
            "max_abs_device_pct_delta": _round(max_abs),
            "deltas": [
                {
                    "sample_index": item["sample_index"],
                    "device_pct_delta": item["device_pct_delta"],
                    "abs_device_pct_delta": item["abs_device_pct_delta"],
                }
                for item in compared
            ],
        }
    )

    if total_duration_ns:
        one_core_values = [float(item["cpu_one_core_equiv_pct"]) for item in compared]
        device_values = [float(item["cpu_device_normalized_pct"]) for item in compared]
        result["metrics"].update(
            {
                "cpu_seconds": _round(total_sched_ns / 1_000_000_000),
                "cpu_one_core_equiv_mean_pct": _round(100.0 * total_sched_ns / total_duration_ns),
                "cpu_one_core_equiv_peak_pct": _round(max(one_core_values)),
                "cpu_device_normalized_mean_pct": _round(normalized_weighted / total_duration_ns),
                "cpu_device_normalized_peak_pct": _round(max(device_values)),
            }
        )

    coverage_pass = coverage_ratio >= MIN_WINDOW_COVERAGE
    mean_pass = mean_abs is not None and mean_abs <= MEAN_ABS_DEVICE_PCT_LIMIT
    p95_pass = p95_abs is not None and p95_abs <= P95_ABS_DEVICE_PCT_LIMIT
    result["checks"][1] = _check(
        "window_coverage",
        _round(coverage_ratio, 6),
        MIN_WINDOW_COVERAGE,
        ">=",
        "ratio",
        "PASS" if coverage_pass else "INCONCLUSIVE",
    )
    result["checks"][2] = _check(
        "mean_abs_device_pct_delta",
        _round(mean_abs),
        MEAN_ABS_DEVICE_PCT_LIMIT,
        "<=",
        "percentage_points",
        "PASS" if mean_pass else ("FAIL" if mean_abs is not None else "INCONCLUSIVE"),
    )
    result["checks"][3] = _check(
        "p95_abs_device_pct_delta",
        _round(p95_abs),
        P95_ABS_DEVICE_PCT_LIMIT,
        "<=",
        "percentage_points",
        "PASS" if p95_pass else ("FAIL" if p95_abs is not None else "INCONCLUSIVE"),
    )

    if data_loss_rows:
        result["analysis_status"] = "INVALID"
        result["threshold_status"] = "INCONCLUSIVE"
        _append_reason(result, "trace_data_loss")
    elif not compared:
        result["analysis_status"] = "UNAVAILABLE"
        result["threshold_status"] = "INCONCLUSIVE"
        _append_reason(result, "no_trace_covered_windows")
    elif not coverage_pass:
        result["analysis_status"] = "PARTIAL"
        result["threshold_status"] = "INCONCLUSIVE"
        _append_reason(result, "insufficient_window_coverage")
    else:
        result["analysis_status"] = "COMPLETED"
        result["threshold_status"] = "PASS" if mean_pass and p95_pass else "FAIL"
        if coverage_ratio < 1.0:
            _append_reason(result, "partial_window_coverage")
    return result


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _native_tool_info(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise ValidationUnavailable("trace_processor_missing", "configured trace processor is not a file")
    try:
        completed = subprocess.run(
            [str(path), "--version"],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=10.0,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ValidationUnavailable("trace_processor_unavailable", str(exc)) from exc
    if completed.returncode != 0:
        raise ValidationUnavailable(
            "trace_processor_unavailable",
            f"trace processor --version exited {completed.returncode}",
        )
    return {
        "processor_native_version": completed.stdout.strip().splitlines()[0] if completed.stdout.strip() else "unknown",
        "processor_binary": path.name,
        "processor_binary_sha256": sha256_file(path),
    }


def _query_rows(tp: Any, sql: str, columns: Sequence[str]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for row in tp.query(sql):
        rows.append({column: _row_value(row, column) for column in columns})
    return rows


def query_perfetto(
    trace: Path,
    queries: Mapping[str, str],
    trace_processor: Path | None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    """Execute the two checked-in queries using Perfetto's Python RPC API."""
    try:
        from perfetto.trace_processor import TraceProcessor, TraceProcessorConfig
    except (ImportError, ModuleNotFoundError) as exc:
        raise ValidationUnavailable("perfetto_python_missing", str(exc)) from exc

    try:
        package_version = importlib.metadata.version("perfetto")
    except importlib.metadata.PackageNotFoundError:
        package_version = "unknown"
    engine_info: dict[str, Any] = {
        "processor_backend": "python_api_explicit_binary" if trace_processor else "python_api_default",
        "processor_package_version": package_version,
        "processor_native_version": None,
        "processor_binary": None,
        "processor_binary_sha256": None,
    }
    if trace_processor is not None:
        engine_info.update(_native_tool_info(trace_processor))

    tp: Any = None
    try:
        if trace_processor is None:
            tp = TraceProcessor(trace=str(trace))
        else:
            tp = TraceProcessor(
                trace=str(trace),
                config=TraceProcessorConfig(bin_path=str(trace_processor)),
            )
    except Exception as exc:
        raise ValidationUnavailable("trace_processor_unavailable", str(exc)) from exc

    try:
        data_loss = _query_rows(
            tp,
            queries["data_loss"],
            ("name", "idx", "severity", "source", "value"),
        )
        windows = _query_rows(
            tp,
            queries["window_metrics"],
            (
                "sample_index",
                "trace_start_ns",
                "trace_end_ns",
                "sched_start_ns",
                "sched_end_ns",
                "trace_coverage_ratio",
                "target_sched_ns",
                "target_sched_slice_count",
            ),
        )
    except Exception as exc:
        raise TraceInvalid("trace_query_failed", str(exc)) from exc
    finally:
        try:
            if tp is not None:
                tp.close()
        except Exception:
            pass
    return windows, data_loss, engine_info


def validate_trace(
    trace: Path,
    csv_path: Path,
    package: str,
    trace_processor: Path | None = None,
) -> dict[str, Any]:
    result = empty_result(package, trace, csv_path)
    try:
        trace_bytes = trace.stat().st_size if trace.is_file() else 0
    except OSError as exc:
        trace_bytes = 0
        _append_reason(result, "trace_unreadable")
        result["quality"]["errors"].append(type(exc).__name__)
    if not csv_path.is_file():
        _append_reason(result, "sampler_csv_missing")
        if trace_bytes <= 0 and "trace_unreadable" not in result["reason_codes"]:
            _append_reason(result, "trace_missing")
        return result
    try:
        parsed = read_sampler_windows(csv_path)
    except (OSError, csv.Error, UnicodeError) as exc:
        _append_reason(result, "sampler_csv_unreadable")
        result["quality"]["errors"].append(type(exc).__name__)
        return result
    _populate_window_input(result, parsed)
    if not parsed.windows:
        _append_reason(result, "sampler_windows_unavailable")
        return result
    if trace_bytes <= 0:
        if "trace_unreadable" not in result["reason_codes"]:
            _append_reason(result, "trace_missing")
        return result
    if not SQL_PATH.is_file():
        _append_reason(result, "validation_sql_missing")
        return result

    result["source"]["trace_bytes"] = trace_bytes
    try:
        result["source"]["trace_sha256"] = sha256_file(trace)
    except OSError as exc:
        _append_reason(result, "trace_unreadable")
        result["quality"]["errors"].append(type(exc).__name__)
        return result
    try:
        sql_text = SQL_PATH.read_text(encoding="utf-8")
        result["source"]["sql_sha256"] = hashlib.sha256(sql_text.encode("utf-8")).hexdigest()
        queries = parse_named_queries(sql_text)
        if set(queries) != {"data_loss", "window_metrics"}:
            raise ValueError("SQL file must define data_loss and window_metrics queries")
        queries["window_metrics"] = render_window_query(
            queries["window_metrics"],
            parsed.windows,
            package,
        )
    except (OSError, UnicodeError, ValueError) as exc:
        result["analysis_status"] = "INVALID"
        _append_reason(result, "validation_sql_invalid")
        result["quality"]["errors"].append(type(exc).__name__)
        return result

    try:
        window_rows, data_loss_rows, engine_info = query_perfetto(
            trace,
            queries,
            trace_processor,
        )
        result["source"].update(engine_info)
        return evaluate_query_results(result, parsed, window_rows, data_loss_rows)
    except ValidationUnavailable as exc:
        _append_reason(result, exc.reason_code)
        result["quality"]["errors"].append(type(exc).__name__)
        return result
    except TraceInvalid as exc:
        result["analysis_status"] = "INVALID"
        _append_reason(result, exc.reason_code)
        result["quality"]["errors"].append(type(exc).__name__)
        return result
    except Exception as exc:
        result["analysis_status"] = "INVALID"
        _append_reason(result, "unexpected_validation_error")
        result["quality"]["errors"].append(type(exc).__name__)
        return result


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Validate AppMarket CPU sampler windows with Perfetto")
    parser.add_argument("--trace", type=Path, required=True)
    parser.add_argument("--csv", type=Path, required=True)
    parser.add_argument("--package", required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--trace-processor", type=Path, default=None)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        package = validate_package(args.package)
    except ValueError as exc:
        parser.error(str(exc))
    result = validate_trace(args.trace, args.csv, package, args.trace_processor)
    try:
        atomic_write_json(args.out, result)
    except (OSError, TypeError, ValueError) as exc:
        print(f"ERROR: could not write Perfetto CPU validation JSON: {exc}")
        return 2
    print(f"PERFETTO_CPU_VALIDATION_JSON={args.out}")
    print(f"PERFETTO_CPU_ANALYSIS_STATUS={result['analysis_status']}")
    print(f"PERFETTO_CPU_THRESHOLD_STATUS={result['threshold_status']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
