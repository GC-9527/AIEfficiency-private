from __future__ import annotations

import sys
import unittest
from pathlib import Path


TEST_DIR = Path(__file__).resolve().parent
TOOLS_DIR = TEST_DIR.parent / "tools"
sys.path.insert(0, str(TOOLS_DIR))

from capture_cpu_callstacks import event_matches, parse_report_csv, symbol_category


class PeakDiagnosticToolTests(unittest.TestCase):
    def test_simpleperf_csv_and_symbol_category(self) -> None:
        raw = (
            "Cmdline: /system/bin/simpleperf record -p 100\n"
            "Arch: arm64\n"
            "Event: cpu-cycles\n"
            "Samples: 42\n"
            "\n"
            "Overhead,Command,Pid,Tid,Shared Object,Symbol\n"
            "12.50%,DefaultDispatch,100,101,app.odex,com.appmarket.Work.run\n"
        )
        rows = parse_report_csv(raw)
        self.assertEqual(1, len(rows))
        self.assertEqual(12.5, rows[0]["overhead_pct"])
        self.assertEqual("DefaultDispatch", rows[0]["Command"])
        self.assertEqual("应用业务代码", symbol_category(rows[0]["Symbol"], rows[0]["Shared Object"]))

    def test_simpleperf_csv_without_header_is_empty(self) -> None:
        self.assertEqual([], parse_report_csv("Cmdline: simpleperf record\nSamples: 0\n"))

    def test_phase_event_matching_is_exact(self) -> None:
        event = {"step": "browse_menu", "status": "clicked", "message": "安装管理"}
        self.assertTrue(event_matches("install-manager", event))
        self.assertFalse(event_matches("privacy", event))


if __name__ == "__main__":
    unittest.main()
