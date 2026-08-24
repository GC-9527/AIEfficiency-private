#!/usr/bin/env python3
from __future__ import annotations

import contextlib
import csv
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

TEST_DIR = Path(__file__).resolve().parent
SRC_DIR = TEST_DIR.parent / "src"
sys.path.insert(0, str(SRC_DIR))

from analyze_appmarket_perf import build_platform_payload, summarize_report
from android_app_perf_sampler import (
    DiagnosticSample,
    Sample,
    append_live_diagnostic,
    append_live_sample,
    build_realtime_device_script,
    initialize_diagnostic_csv,
    initialize_live_csv,
)
from appmarket_perf_runner import RunnerError, build_parser as build_runner_parser, validate_args


PACKAGE_DIR = TEST_DIR.parent
CONFIG_PATH = PACKAGE_DIR / "config" / "appmarket_flow_config.json"


class RealtimeResourceStreamTests(unittest.TestCase):
    def make_sample(self, index: int, *, cpu: float | None = 1.23456) -> Sample:
        return Sample(
            sample_index=index,
            target_elapsed_s=index * 5.0,
            actual_elapsed_s=index * 5.0 + 0.123456,
            wall_time_local="2026-07-15 12:00:00",
            pids="100;101",
            process_names="com.appmarket.automotive;com.appmarket.automotive:worker",
            logical_cpus=8,
            cpu_one_core_equiv_pct=cpu,
            cpu_device_normalized_pct=None if cpu is None else cpu / 8,
            pss_mb=120.98765 + index,
            rss_mb=150.54321 + index,
            process_set_changed=1 if index == 1 else 0,
            collection_latency_s=0.234567,
            note="" if cpu is not None else "collection_error:test",
        )

    def test_each_sample_is_in_csv_before_live_event_returns(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / "metrics.csv"
            initialize_live_csv(output)
            captured = io.StringIO()
            with contextlib.redirect_stdout(captured):
                emitted = append_live_sample(output, self.make_sample(1))

            with output.open("r", newline="", encoding="utf-8-sig") as handle:
                rows = list(csv.DictReader(handle))
            self.assertEqual(1, len(rows))
            self.assertEqual("1.2346", rows[0]["cpu_one_core_equiv_pct"])
            self.assertEqual("121.9877", rows[0]["pss_mb"])

            line = captured.getvalue().strip()
            self.assertTrue(line.startswith("LIVE_SAMPLE_JSON="))
            payload = json.loads(line.split("=", 1)[1])
            self.assertEqual(emitted, payload)
            self.assertEqual(1.2346, payload["cpu_one_core_equiv_pct"])

    def test_null_error_sample_is_preserved_and_rows_append(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / "metrics.csv"
            initialize_live_csv(output)
            captured = io.StringIO()
            with contextlib.redirect_stdout(captured):
                append_live_sample(output, self.make_sample(1))
                append_live_sample(output, self.make_sample(2, cpu=None))

            with output.open("r", newline="", encoding="utf-8-sig") as handle:
                rows = list(csv.DictReader(handle))
            self.assertEqual(["1", "2"], [row["sample_index"] for row in rows])
            self.assertEqual("", rows[1]["cpu_one_core_equiv_pct"])
            events = [json.loads(line.split("=", 1)[1]) for line in captured.getvalue().splitlines()]
            self.assertIsNone(events[1]["cpu_one_core_equiv_pct"])
            self.assertEqual("collection_error:test", events[1]["note"])

    def test_diagnostic_stream_is_separate_and_preserves_rss_provenance(self) -> None:
        point = DiagnosticSample(
            diagnostic_index=3,
            target_elapsed_s=1.0,
            actual_elapsed_s=1.01234,
            source_timestamp_s=12345.67,
            wall_time_local="2026-07-16 12:00:00",
            pids="100",
            process_names="com.appmarket.automotive",
            logical_cpus=5,
            cpu_one_core_equiv_pct=10.0,
            cpu_device_normalized_pct=2.0,
            rss_mb=151.23456,
            rss_source_timestamp_s=12345.67,
            rss_fresh=True,
            process_set_changed=0,
            cpu_window_duration_s=0.5,
            collection_latency_s=0.01234,
            metric_source="device_proc_stream_500ms",
            note="",
        )
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            formal = root / "metrics.csv"
            diagnostic = root / "diagnostic_metrics.csv"
            initialize_live_csv(formal)
            initialize_diagnostic_csv(diagnostic)
            captured = io.StringIO()
            with contextlib.redirect_stdout(captured):
                append_live_diagnostic(diagnostic, point)

            with diagnostic.open("r", newline="", encoding="utf-8-sig") as handle:
                rows = list(csv.DictReader(handle))
            with formal.open("r", newline="", encoding="utf-8-sig") as handle:
                formal_rows = list(csv.DictReader(handle))

        self.assertEqual([], formal_rows)
        self.assertEqual("12345.67", rows[0]["rss_source_timestamp_s"])
        payload = json.loads(captured.getvalue().strip().split("=", 1)[1])
        self.assertTrue(payload["rss_fresh"])
        self.assertEqual(151.2346, payload["rss_mb"])

    def test_device_collector_is_one_persistent_framed_stream(self) -> None:
        script = build_realtime_device_script("com.appmarket.automotive", True)
        self.assertIn("while :; do", script)
        self.assertIn("__APP_PERF_BEGIN__", script)
        self.assertIn("__APP_PERF_RSS_DUE__", script)
        self.assertIn("__APP_PERF_END__", script)
        self.assertIn("sleep \"$delay\"", script)
        self.assertIn("ps -A -o PID,NAME", script)
        self.assertIn("index(name, package \":\")", script)

    def test_runner_defaults_to_standard_and_realtime_requires_formal_five_seconds(self) -> None:
        parser = build_runner_parser()
        standard = parser.parse_args(["--non-interactive", "--dry-run"])
        validate_args(standard)
        self.assertEqual("standard", standard.sampling_mode)
        self.assertEqual(5.0, standard.interval)

        realtime = parser.parse_args(
            ["--non-interactive", "--dry-run", "--sampling-mode", "realtime", "--interval", "10"]
        )
        with self.assertRaisesRegex(RunnerError, "requires --interval 5"):
            validate_args(realtime)

    def test_realtime_perfetto_gate_and_diagnostic_isolation(self) -> None:
        config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        rows = [
            {
                "sample_index": index + 1,
                "target_elapsed_s": (index + 1) * 5,
                "actual_elapsed_s": (index + 1) * 5,
                "pids": "100",
                "logical_cpus": 5.0,
                "cpu_one_core_equiv_pct": 1.0,
                "cpu_device_normalized_pct": 0.2,
                "pss_mb": 80.0,
                "rss_mb": 100.0,
            }
            for index in range(36)
        ]
        diagnostic_rows = [
            {
                "diagnostic_index": index + 1,
                "cpu_one_core_equiv_pct": 500.0,
                "cpu_device_normalized_pct": 100.0,
                "rss_mb": 9999.0,
            }
            for index in range(361)
        ]
        sampler = {
            "requested_duration_s": 180,
            "interval_s": 5,
            "expected_rows": 36,
            "sampling_mode": "realtime",
            "diagnostic": {"cpu_interval_ms": 500, "rss_interval_ms": 1000},
        }
        manifest = {
            "session_id": "realtime-isolation",
            "sampling_mode": "realtime",
            "package": "com.appmarket.automotive",
        }
        flow = {"mode": "launch-only", "status": "completed"}
        with tempfile.TemporaryDirectory() as temp:
            report = summarize_report(
                rows,
                sampler,
                manifest,
                flow,
                config,
                Path(temp),
                PACKAGE_DIR,
                diagnostic_rows,
                {"analysis_status": "COMPLETED", "threshold_status": "PASS"},
            )
        self.assertEqual("PASS", report["acceptance"])
        self.assertEqual(0.2, report["measurements"]["cpu_device_normalized_pct"]["peak"])
        self.assertEqual(100.0, report["diagnostic"]["measurements"]["cpu_device_normalized_pct"]["peak"])
        self.assertEqual(36, len(build_platform_payload(report, rows)["resourceSamples"]))

        with tempfile.TemporaryDirectory() as temp:
            unavailable = summarize_report(
                rows,
                sampler,
                manifest,
                flow,
                config,
                Path(temp),
                PACKAGE_DIR,
                diagnostic_rows,
                {"analysis_status": "UNAVAILABLE", "threshold_status": "INCONCLUSIVE"},
            )
        self.assertEqual("INCONCLUSIVE", unavailable["acceptance"])
        check = next(item for item in unavailable["checks"] if item["key"] == "perfetto_cpu_consistency")
        self.assertEqual("inconclusive", check["status"])


if __name__ == "__main__":
    unittest.main()
