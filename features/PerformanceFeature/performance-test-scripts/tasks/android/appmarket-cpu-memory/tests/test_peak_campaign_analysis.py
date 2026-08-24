from __future__ import annotations

import sys
import unittest
from datetime import datetime
from pathlib import Path


TEST_DIR = Path(__file__).resolve().parent
SRC_DIR = TEST_DIR.parent / "src"
sys.path.insert(0, str(SRC_DIR))

from analyze_peak_campaign import parse_meminfo_categories, phase_at, phase_boundaries


class PeakCampaignAnalysisTests(unittest.TestCase):
    def test_meminfo_categories_use_pss_column(self) -> None:
        raw = """
                   Pss  Private  Private     Swap      Rss     Heap     Heap     Heap
                 Total    Dirty    Clean    Dirty    Total     Size    Alloc     Free
                ------   ------   ------   ------   ------   ------   ------   ------
  Native Heap    58357    58328        0        0    61232        0        0        0
    .apk mmap    71370      404    54644        0    94608
   EGL mtrack    15948    15948        0        0    15948
        TOTAL   190939   101616    67932        0   354872        0        0        0
        """
        categories = parse_meminfo_categories(raw)
        self.assertAlmostEqual(56.9893, categories["Native Heap"], places=4)
        self.assertAlmostEqual(69.6973, categories[".apk mmap"], places=4)
        self.assertAlmostEqual(15.5742, categories["EGL mtrack"], places=4)

    def test_flow_events_map_samples_to_named_phase(self) -> None:
        events = [
            {"at": "2026-07-16 10:00:00", "step": "launch", "status": "started"},
            {"at": "2026-07-16 10:00:20", "step": "launch", "status": "passed"},
            {"at": "2026-07-16 10:01:00", "step": "browse_menu", "status": "clicked", "message": "安装管理"},
            {"at": "2026-07-16 10:01:10", "step": "browse_menu", "status": "clicked", "message": "问题与反馈"},
        ]
        boundaries = phase_boundaries(events)
        self.assertEqual("启动与首页加载", phase_at(datetime(2026, 7, 16, 10, 0, 5), boundaries))
        self.assertEqual("列表浏览与详情加载", phase_at(datetime(2026, 7, 16, 10, 0, 30), boundaries))
        self.assertEqual("安装管理", phase_at(datetime(2026, 7, 16, 10, 1, 5), boundaries))
        self.assertEqual("问题与反馈", phase_at(datetime(2026, 7, 16, 10, 1, 15), boundaries))


if __name__ == "__main__":
    unittest.main()
