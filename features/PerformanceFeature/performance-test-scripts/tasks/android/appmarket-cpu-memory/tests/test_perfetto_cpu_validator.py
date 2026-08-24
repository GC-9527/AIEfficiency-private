from __future__ import annotations

import csv
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch


TEST_DIR = Path(__file__).resolve().parent
PACKAGE_DIR = TEST_DIR.parent
SRC_DIR = PACKAGE_DIR / "src"
sys.path.insert(0, str(SRC_DIR))

import perfetto_cpu_validator as validator
from perfetto_cpu_validator import (
    SamplerWindow,
    WindowParseResult,
    empty_result,
    evaluate_query_results,
    parse_named_queries,
    parse_sampler_rows,
    percentile,
    render_window_query,
    validate_trace,
)


def sampler_row(
    sample_index: int,
    start_s: float,
    end_s: float,
    sampler_pct: float,
    logical_cpus: int = 5,
) -> dict[str, object]:
    return {
        "sample_index": sample_index,
        "cpu_source_start_s": start_s,
        "cpu_source_end_s": end_s,
        "logical_cpus": logical_cpus,
        "cpu_device_normalized_pct": sampler_pct,
    }


def parsed_windows(count: int = 2, sampler_pct: float = 2.0) -> WindowParseResult:
    rows = [
        sampler_row(index, 100.0 + (index - 1) * 5.0, 100.0 + index * 5.0, sampler_pct)
        for index in range(1, count + 1)
    ]
    return parse_sampler_rows(rows)


def query_row(window: SamplerWindow, scheduled_ns: int, coverage: float = 1.0) -> dict[str, object]:
    return {
        "sample_index": window.sample_index,
        "trace_start_ns": 99_000_000_000,
        "trace_end_ns": 200_000_000_000,
        "sched_start_ns": 99_000_000_000,
        "sched_end_ns": 200_000_000_000,
        "trace_coverage_ratio": coverage,
        "target_sched_ns": scheduled_ns,
        "target_sched_slice_count": 2,
    }


class SamplerWindowTests(unittest.TestCase):
    def test_parse_sampler_rows_keeps_safe_non_overlapping_windows(self) -> None:
        parsed = parse_sampler_rows(
            [
                sampler_row(2, 105.0, 110.0, 1.5),
                sampler_row(1, 100.0, 105.0, 1.0),
                sampler_row(2, 110.0, 115.0, 2.0),
                sampler_row(3, 104.0, 106.0, 1.0),
                sampler_row(4, 115.0, 115.0, 1.0),
            ]
        )
        self.assertEqual([1, 2], [window.sample_index for window in parsed.windows])
        self.assertEqual(5, parsed.total_rows)
        self.assertIn("row_3:duplicate_sample_index", parsed.issues)
        self.assertIn("sample_3:overlapping_cpu_window", parsed.issues)
        self.assertIn("row_5:invalid_cpu_source_window", parsed.issues)

    def test_missing_source_boundaries_produce_no_valid_window(self) -> None:
        parsed = parse_sampler_rows(
            [
                {
                    "sample_index": "1",
                    "logical_cpus": "5",
                    "cpu_device_normalized_pct": "1.0",
                    "cpu_source_start_s": "",
                    "cpu_source_end_s": "",
                }
            ]
        )
        self.assertEqual((), parsed.windows)
        self.assertEqual(("row_1:invalid_cpu_source_window",), parsed.issues)

    def test_percentile_uses_linear_interpolation(self) -> None:
        self.assertEqual(1.0, percentile([1.0], 0.95))
        self.assertAlmostEqual(3.85, percentile([1.0, 2.0, 3.0, 4.0], 0.95))
        self.assertIsNone(percentile([], 0.95))


class SqlTemplateTests(unittest.TestCase):
    def test_checked_in_sql_has_both_named_queries_and_safe_substitution(self) -> None:
        queries = parse_named_queries(validator.SQL_PATH.read_text(encoding="utf-8"))
        self.assertEqual({"data_loss", "window_metrics"}, set(queries))
        window = SamplerWindow(1, 100.0, 105.0, 5, 1.25)
        rendered = render_window_query(
            queries["window_metrics"],
            [window],
            "com.appmarket.automotive",
        )
        self.assertIn("sched_slice", rendered)
        self.assertIn("'com.appmarket.automotive'", rendered)
        self.assertIn("'com.appmarket.automotive:*'", rendered)
        self.assertIn("(1, 100000000000, 105000000000, 5, 1.25)", rendered)
        self.assertNotIn("__WINDOW_VALUES__", rendered)

    def test_package_validation_rejects_sql_metacharacters(self) -> None:
        window = SamplerWindow(1, 1.0, 2.0, 5, 1.0)
        with self.assertRaisesRegex(ValueError, "package"):
            render_window_query("__WINDOW_VALUES__ __PACKAGE_EXACT__ __PACKAGE_CHILD_GLOB__", [window], "pkg' OR 1=1")


class VerdictTests(unittest.TestCase):
    def base(self, parsed: WindowParseResult) -> dict[str, object]:
        result = empty_result(
            "com.appmarket.automotive",
            Path("appmarket.pftrace"),
            Path("metrics.csv"),
        )
        self.assertTrue(parsed.windows)
        return result

    def test_matching_trace_and_sampler_pass(self) -> None:
        parsed = parse_sampler_rows(
            [
                sampler_row(1, 100.0, 105.0, 2.0),
                sampler_row(2, 105.0, 110.0, 4.0),
            ]
        )
        rows = [
            query_row(parsed.windows[0], 500_000_000),
            query_row(parsed.windows[1], 1_000_000_000),
        ]
        result = evaluate_query_results(self.base(parsed), parsed, rows, [])
        self.assertEqual("COMPLETED", result["analysis_status"])
        self.assertEqual("PASS", result["threshold_status"])
        self.assertEqual(1.5, result["metrics"]["cpu_seconds"])
        self.assertEqual(15.0, result["metrics"]["cpu_one_core_equiv_mean_pct"])
        self.assertEqual(3.0, result["metrics"]["cpu_device_normalized_mean_pct"])
        self.assertEqual(0.0, result["sampler_comparison"]["mean_abs_device_pct_delta"])

    def test_delta_threshold_failure_is_a_performance_fail(self) -> None:
        parsed = parsed_windows(count=2, sampler_pct=0.0)
        rows = [query_row(window, 500_000_000) for window in parsed.windows]
        result = evaluate_query_results(self.base(parsed), parsed, rows, [])
        self.assertEqual("COMPLETED", result["analysis_status"])
        self.assertEqual("FAIL", result["threshold_status"])
        self.assertEqual(2.0, result["sampler_comparison"]["mean_abs_device_pct_delta"])
        self.assertEqual("FAIL", result["checks"][2]["status"])
        self.assertEqual("FAIL", result["checks"][3]["status"])

    def test_less_than_eighty_percent_window_coverage_is_inconclusive(self) -> None:
        parsed = parsed_windows(count=5, sampler_pct=2.0)
        rows = [query_row(window, 500_000_000) for window in parsed.windows[:3]]
        result = evaluate_query_results(self.base(parsed), parsed, rows, [])
        self.assertEqual("PARTIAL", result["analysis_status"])
        self.assertEqual("INCONCLUSIVE", result["threshold_status"])
        self.assertEqual(0.6, result["window"]["coverage_ratio"])
        self.assertIn("insufficient_window_coverage", result["reason_codes"])

    def test_eighty_percent_window_coverage_can_be_compared(self) -> None:
        parsed = parsed_windows(count=5, sampler_pct=2.0)
        rows = [query_row(window, 500_000_000) for window in parsed.windows[:4]]
        result = evaluate_query_results(self.base(parsed), parsed, rows, [])
        self.assertEqual("COMPLETED", result["analysis_status"])
        self.assertEqual("PASS", result["threshold_status"])
        self.assertEqual(0.8, result["window"]["coverage_ratio"])
        self.assertIn("partial_window_coverage", result["reason_codes"])

    def test_data_loss_invalidates_an_otherwise_matching_trace(self) -> None:
        parsed = parsed_windows(count=2, sampler_pct=2.0)
        rows = [query_row(window, 500_000_000) for window in parsed.windows]
        loss = [{"name": "traced_buf_chunks_overwritten", "idx": 0, "severity": "data_loss", "source": "trace", "value": 1}]
        result = evaluate_query_results(self.base(parsed), parsed, rows, loss)
        self.assertEqual("INVALID", result["analysis_status"])
        self.assertEqual("INCONCLUSIVE", result["threshold_status"])
        self.assertIn("trace_data_loss", result["reason_codes"])

    def test_partially_covered_individual_window_is_not_compared(self) -> None:
        parsed = parsed_windows(count=1, sampler_pct=2.0)
        rows = [query_row(parsed.windows[0], 500_000_000, coverage=0.95)]
        result = evaluate_query_results(self.base(parsed), parsed, rows, [])
        self.assertEqual("UNAVAILABLE", result["analysis_status"])
        self.assertEqual(0, result["window"]["compared_count"])
        self.assertIn("no_trace_covered_windows", result["reason_codes"])


class CliDegradationTests(unittest.TestCase):
    def test_missing_inputs_write_fixed_unavailable_schema_and_exit_zero(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            output = root / "analysis" / "perfetto_cpu_validation.json"
            with redirect_stdout(io.StringIO()):
                code = validator.main(
                    [
                        "--trace", str(root / "missing.pftrace"),
                        "--csv", str(root / "missing.csv"),
                        "--package", "com.appmarket.automotive",
                        "--out", str(output),
                    ]
                )
            self.assertEqual(0, code)
            result = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual("UNAVAILABLE", result["analysis_status"])
            self.assertEqual("INCONCLUSIVE", result["threshold_status"])
            self.assertEqual("sampler_csv_missing", result["reason_codes"][0])
            self.assertEqual(
                {
                    "schema_version", "generated_at", "analysis_status", "threshold_status",
                    "reason_codes", "source", "window", "quality", "metrics",
                    "sampler_comparison", "checks",
                },
                set(result),
            )

    def test_mocked_trace_query_exercises_full_validation_without_real_trace(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            trace = root / "fake.pftrace"
            trace.write_bytes(b"not-a-real-trace")
            csv_path = root / "metrics.csv"
            with csv_path.open("w", encoding="utf-8", newline="") as handle:
                writer = csv.DictWriter(handle, fieldnames=list(sampler_row(1, 100, 105, 2).keys()))
                writer.writeheader()
                writer.writerow(sampler_row(1, 100, 105, 2))
            queried = query_row(SamplerWindow(1, 100, 105, 5, 2), 500_000_000)
            engine = {
                "processor_backend": "mock",
                "processor_package_version": "test",
                "processor_native_version": "test",
                "processor_binary": None,
                "processor_binary_sha256": None,
            }
            with patch("perfetto_cpu_validator.query_perfetto", return_value=([queried], [], engine)):
                result = validate_trace(trace, csv_path, "com.appmarket.automotive")
            self.assertEqual("COMPLETED", result["analysis_status"])
            self.assertEqual("PASS", result["threshold_status"])
            self.assertEqual("mock", result["source"]["processor_backend"])
            self.assertEqual(64, len(result["source"]["trace_sha256"]))
            self.assertEqual(64, len(result["source"]["sql_sha256"]))

    def test_unwritable_output_is_the_only_runtime_exit_two(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with (
                patch("perfetto_cpu_validator.atomic_write_json", side_effect=OSError("read only")),
                redirect_stdout(io.StringIO()),
            ):
                code = validator.main(
                    [
                        "--trace", str(root / "missing.pftrace"),
                        "--csv", str(root / "missing.csv"),
                        "--package", "com.appmarket.automotive",
                        "--out", str(root / "result.json"),
                    ]
                )
            self.assertEqual(2, code)

    def test_invalid_package_is_an_argument_error(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as raised:
                    validator.main(
                        [
                            "--trace", str(root / "trace"),
                            "--csv", str(root / "csv"),
                            "--package", "bad package",
                            "--out", str(root / "out"),
                        ]
                    )
            self.assertEqual(2, raised.exception.code)


if __name__ == "__main__":
    unittest.main()
