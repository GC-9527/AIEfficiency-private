from __future__ import annotations

import csv
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

TEST_DIR = Path(__file__).resolve().parent
PACKAGE_DIR = TEST_DIR.parent
SRC_DIR = PACKAGE_DIR / "src"
CONFIG_PATH = PACKAGE_DIR / "config" / "appmarket_flow_config.json"
sys.path.insert(0, str(SRC_DIR))

from analyze_appmarket_perf import (
    build_platform_payload,
    main as analyze_main,
    optimization_advice_markdown,
    project_performance_script,
    summarize_report,
)
from android_app_perf_sampler import (
    CpuSnapshot,
    ProcCpu,
    Sample,
    append_live_sample,
    compute_cpu_percentages,
    initialize_live_csv,
    parse_meminfo_kb,
    parse_system_cpu,
)
from appmarket_perf_runner import (
    SCREENRECORD_OVERHEAD_WARNING,
    RunnerError,
    build_screenrecord_command,
    copy_rotating_logcat_stream,
    plan_screenrecord_segments,
    stop_remote_perfetto,
    write_json as write_runner_json,
)
from appmarket_flow import AdbClient, FlowError, FlowRunner, UiTree
from performance_json_io import atomic_write_json
from performance_pdf_report import PdfReportError, write_pdf_reports


class AtomicJsonWriteTests(unittest.TestCase):
    def test_replace_failure_preserves_previous_manifest_and_removes_temp(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            manifest_path = Path(temp) / "run_manifest.json"
            previous = {"session_id": "stable", "status": "collecting", "samples": 12}
            manifest_path.write_text(
                json.dumps(previous, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )

            with (
                patch("performance_json_io.os.replace", side_effect=OSError("injected replace fault")),
                self.assertRaisesRegex(OSError, "injected replace fault"),
            ):
                write_runner_json(manifest_path, {"status": "completed"})

            self.assertEqual(previous, json.loads(manifest_path.read_text(encoding="utf-8")))
            self.assertEqual([], list(manifest_path.parent.glob(".run_manifest.json.*.tmp")))

    def test_partial_temp_write_preserves_previous_manifest_and_removes_temp(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            manifest_path = Path(temp) / "run_manifest.json"
            previous = {"session_id": "stable", "status": "analyzing"}
            manifest_path.write_text(
                json.dumps(previous, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )

            def torn_dump(_value, handle, **_kwargs):
                handle.write('{"status": "comp')
                handle.flush()
                raise OSError("injected torn write")

            with (
                patch("performance_json_io.json.dump", side_effect=torn_dump),
                self.assertRaisesRegex(OSError, "injected torn write"),
            ):
                atomic_write_json(manifest_path, {"status": "completed"})

            self.assertEqual(previous, json.loads(manifest_path.read_text(encoding="utf-8")))
            self.assertEqual([], list(manifest_path.parent.glob(".run_manifest.json.*.tmp")))


class PerfettoCancellationTests(unittest.TestCase):
    def test_stop_targets_only_the_unique_remote_trace(self) -> None:
        remote_trace = (
            "/data/misc/perfetto-traces/"
            "appmarket_2164b86e-e48b-4679-8e40-c5aa9e5e0f0e.pftrace"
        )
        with patch("appmarket_perf_runner.run_text", return_value="") as run:
            stop_remote_perfetto("adb", "device-1", remote_trace)

        command = run.call_args.args[0]
        self.assertEqual(["adb", "-s", "device-1", "shell", "pkill", "-INT", "-f"], command[:-1])
        self.assertIn("2164b86e", command[-1])
        self.assertNotEqual("perfetto", command[-1])
        self.assertFalse(run.call_args.kwargs["check"])

    def test_stop_rejects_unscoped_or_shell_like_trace_paths(self) -> None:
        for remote_trace in (
            "/data/misc/perfetto-traces/other.pftrace",
            "/data/misc/perfetto-traces/appmarket_x;pkill perfetto.pftrace",
        ):
            with self.subTest(remote_trace=remote_trace), self.assertRaises(RunnerError):
                stop_remote_perfetto("adb", "device-1", remote_trace)

def ui_xml(marker: str, *, sticky_download: bool = False) -> str:
    download = (
        "<node package='pkg' resource-id='pkg:id/downloadButton' text='下载' "
        "clickable='true' enabled='true' bounds='[700,500][900,580]' />"
        if sticky_download
        else ""
    )
    return (
        "<?xml version='1.0' encoding='UTF-8'?>"
        "<hierarchy><node package='pkg' resource-id='pkg:id/home_root' "
        "bounds='[0,0][1000,600]'>"
        f"<node package='pkg' text='{marker}' bounds='[200,100][600,400]' />"
        f"{download}</node></hierarchy>"
    )


class SequenceAdb:
    def __init__(self, xml_values: list[str]) -> None:
        self.xml_values = list(xml_values)
        self.last_xml = self.xml_values[-1]
        self.dump_count = 0
        self.shell_calls: list[tuple[str, ...]] = []

    def dump_ui(self) -> tuple[str, UiTree]:
        self.dump_count += 1
        if self.xml_values:
            self.last_xml = self.xml_values.pop(0)
        return self.last_xml, UiTree(self.last_xml)

    def shell(self, *args: str, timeout: float = 30.0) -> str:
        self.shell_calls.append(tuple(args))
        return ""

    def screenshot(self, path: Path) -> None:
        path.write_bytes(b"\x89PNG\r\n\x1a\n")


class AdbClientTests(unittest.TestCase):
    def test_screenshot_strips_automotive_multiple_display_warning(self) -> None:
        client = AdbClient()
        png = b"\x89PNG\r\n\x1a\n" + b"test-payload"
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "screen.png"
            with patch.object(
                client,
                "run",
                return_value=b"[Warning] Multiple displays were found\n" + png,
            ):
                client.screenshot(path)
            self.assertEqual(path.read_bytes(), png)


class SamplerTests(unittest.TestCase):
    def test_live_sample_is_flushed_to_csv_and_emitted_as_the_same_row(self) -> None:
        sample = Sample(
            sample_index=1,
            target_elapsed_s=5.0,
            actual_elapsed_s=5.123456,
            wall_time_local="2026-07-15 12:00:00",
            pids="10;11",
            process_names="pkg;pkg:worker",
            logical_cpus=8,
            cpu_one_core_equiv_pct=8.123456,
            cpu_device_normalized_pct=1.015432,
            pss_mb=128.765432,
            rss_mb=160.25,
            process_set_changed=0,
            collection_latency_s=0.234567,
            note="",
        )
        with tempfile.TemporaryDirectory() as temp:
            csv_path = Path(temp) / "metrics.csv"
            initialize_live_csv(csv_path)
            stdout = io.StringIO()
            with redirect_stdout(stdout):
                emitted = append_live_sample(csv_path, sample)
            with csv_path.open("r", newline="", encoding="utf-8-sig") as handle:
                rows = list(csv.DictReader(handle))

        self.assertEqual(1, len(rows))
        self.assertEqual("1", rows[0]["sample_index"])
        self.assertEqual("5.1235", rows[0]["actual_elapsed_s"])
        marker = stdout.getvalue().strip()
        self.assertTrue(marker.startswith("LIVE_SAMPLE_JSON="))
        self.assertEqual(emitted, json.loads(marker.split("=", 1)[1]))

    def test_cpu_percentages_keep_both_conventions(self) -> None:
        previous = CpuSnapshot(1000, 5, (ProcCpu(10, "pkg", 100, 1),))
        current = CpuSnapshot(1500, 5, (ProcCpu(10, "pkg", 110, 1),))
        multi, normalized, changed, note = compute_cpu_percentages(previous, current)
        self.assertEqual(10.0, multi)
        self.assertEqual(2.0, normalized)
        self.assertFalse(changed)
        self.assertEqual("", note)

    def test_android_raw_parsers(self) -> None:
        total, cpus = parse_system_cpu("cpu 10 0 5 80 5 0 0 0\ncpu0 1 0 1 9\ncpu1 2 0 1 8\n")
        self.assertEqual(100, total)
        self.assertEqual(2, cpus)
        pss, rss = parse_meminfo_kb("TOTAL PSS: 143,360 TOTAL RSS: 180,224")
        self.assertEqual(143360, pss)
        self.assertEqual(180224, rss)


class FlowSelectorTests(unittest.TestCase):
    def test_selector_and_clickable_parent(self) -> None:
        xml = """<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
        <hierarchy rotation='0'><node package='com.appmarket.automotive' clickable='true' enabled='true' bounds='[0,0][300,200]' resource-id='card'>
          <node package='com.appmarket.automotive' clickable='false' enabled='true' bounds='[10,10][100,80]' text='测试应用' />
        </node></hierarchy>"""
        tree = UiTree(xml)
        item = tree.find([{"text": "测试应用"}], "com.appmarket.automotive")[0]
        parent = tree.clickable_ancestor(item)
        self.assertEqual("card", parent.resource_id)
        self.assertEqual((0, 0, 300, 200), parent.bounds)

    def test_checked_state_and_unlabelled_fallback_are_safe(self) -> None:
        xml = """<?xml version='1.0' encoding='UTF-8'?>
        <hierarchy><node package='pkg' bounds='[0,0][1000,600]'>
          <node text='首页' resource-id='pkg:id/rb_home' class='android.widget.RadioButton'
                package='pkg' clickable='true' enabled='true' checked='true' bounds='[0,0][180,80]' />
          <node text='' resource-id='' class='android.view.ViewGroup' package='pkg'
                clickable='true' enabled='true' bounds='[300,100][700,400]' />
        </node></hierarchy>"""
        tree = UiTree(xml)
        home = tree.find([{"resource_id": "rb_home"}], "pkg")[0]
        self.assertTrue(home.checked)
        self.assertFalse(home.checkable)
        runner = object.__new__(FlowRunner)
        runner.package = "pkg"
        self.assertIsNone(runner.choose_app_candidate(tree, []))

    def test_default_selectors_match_v1_0_80_home_and_prefer_clickable_app_card(self) -> None:
        config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        xml = """<?xml version='1.0' encoding='UTF-8'?>
        <hierarchy><node package='com.appmarket.automotive' bounds='[0,0][2560,1380]'>
          <node package='com.appmarket.automotive' resource-id='com.appmarket.automotive:id/home_rec_rv'
                clickable='false' enabled='true' bounds='[0,171][2560,1380]'>
            <node package='com.appmarket.automotive' resource-id='com.appmarket.automotive:id/item_hot_rec_root'
                  clickable='false' enabled='true' bounds='[56,243][813,376]' />
            <node package='com.appmarket.automotive' resource-id='com.appmarket.automotive:id/item_hot_rec_root'
                  clickable='true' enabled='true' bounds='[56,496][813,629]' />
          </node>
        </node></hierarchy>"""
        tree = UiTree(xml)
        self.assertTrue(tree.find(config["selectors"]["home_ready"], "com.appmarket.automotive"))
        cards = tree.find(config["selectors"]["app_card"], "com.appmarket.automotive")
        runner = object.__new__(FlowRunner)
        runner.package = "com.appmarket.automotive"
        selected = runner.choose_app_candidate(tree, cards)
        self.assertIsNotNone(selected)
        self.assertTrue(selected.clickable)
        self.assertEqual((56, 496, 813, 629), selected.bounds)

    def test_open_action_is_not_treated_as_download_and_next_card_is_selected(self) -> None:
        config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        xml = """<?xml version='1.0' encoding='UTF-8'?>
        <hierarchy><node package='com.appmarket.automotive' bounds='[0,0][2560,1380]'>
          <node package='com.appmarket.automotive' resource-id='com.appmarket.automotive:id/item_hot_rec_root'
                clickable='true' enabled='true' bounds='[572,706][1436,883]'>
            <node package='com.appmarket.automotive' resource-id='com.appmarket.automotive:id/tv_name'
                  text='Deezer' bounds='[748,707][1256,760]' />
            <node package='com.appmarket.automotive' resource-id='com.appmarket.automotive:id/downloadBtn'
                  clickable='true' enabled='true' bounds='[1296,734][1436,814]'>
              <node package='com.appmarket.automotive' resource-id='com.appmarket.automotive:id/tvText'
                    text='打开' clickable='true' enabled='true' bounds='[1326,754][1406,795]' />
            </node>
          </node>
          <node package='com.appmarket.automotive' resource-id='com.appmarket.automotive:id/item_hot_rec_root'
                clickable='true' enabled='true' bounds='[1596,706][2460,883]'>
            <node package='com.appmarket.automotive' resource-id='com.appmarket.automotive:id/tv_name'
                  text='安全测试应用' bounds='[1772,707][2280,760]' />
            <node package='com.appmarket.automotive' resource-id='com.appmarket.automotive:id/downloadBtn'
                  clickable='true' enabled='true' bounds='[2320,734][2460,814]'>
              <node package='com.appmarket.automotive' resource-id='com.appmarket.automotive:id/tvText'
                    text='下载' clickable='true' enabled='true' bounds='[2350,754][2430,795]' />
            </node>
          </node>
        </node></hierarchy>"""
        tree = UiTree(xml)
        cards = tree.find(config["selectors"]["app_card"], "com.appmarket.automotive")
        runner = object.__new__(FlowRunner)
        runner.package = "com.appmarket.automotive"

        selected = runner.choose_app_candidate(
            tree,
            cards,
            download_selectors=config["selectors"]["download"],
            installed_selectors=config["selectors"]["installed"],
        )
        self.assertIsNotNone(selected)
        self.assertEqual((1596, 706, 2460, 883), tree.clickable_ancestor(selected).bounds)

        open_button = tree.find(
            [{"resource_id": "downloadBtn"}], "com.appmarket.automotive"
        )[0]
        self.assertEqual(
            ("installed", "打开"),
            runner.app_action_state(
                tree,
                open_button,
                config["selectors"]["download"],
                config["selectors"]["installed"],
            ),
        )
        self.assertIsNone(
            runner.choose_app_candidate(
                tree,
                [cards[0]],
                download_selectors=config["selectors"]["download"],
                installed_selectors=config["selectors"]["installed"],
            )
        )

    def test_home_ready_requires_three_consecutive_identical_digests(self) -> None:
        adb = SequenceAdb([ui_xml("A"), ui_xml("B"), ui_xml("B"), ui_xml("B")])
        with tempfile.TemporaryDirectory() as temp:
            runner = FlowRunner(adb, "pkg", {}, Path(temp))
            with patch("appmarket_flow.time.sleep", return_value=None):
                _xml, tree, nodes = runner.wait_for(
                    [{"resource_id": "home_root"}],
                    1,
                    stable_samples=3,
                )
        self.assertEqual(4, adb.dump_count)
        self.assertEqual(UiTree(ui_xml("B")).digest, tree.digest)
        self.assertTrue(nodes)

    def test_launch_only_emits_the_declared_terminal_flow_event(self) -> None:
        xml = """<?xml version='1.0' encoding='UTF-8'?>
        <hierarchy><node package='pkg' resource-id='pkg:id/home_root' bounds='[0,0][1000,600]'>
          <node package='pkg' resource-id='pkg:id/home_tab' text='首页' checkable='true'
                checked='true' clickable='true' enabled='true' bounds='[0,0][180,80]' />
        </node></hierarchy>"""
        config = {
            "timeouts": {"page_ready_s": 1, "home_stable_samples": 1},
            "selectors": {
                "home_tab": [{"resource_id": "home_tab"}],
                "home_ready": [{"resource_id": "home_root"}],
            },
            "secondary_menus": [],
        }
        adb = SequenceAdb([xml, xml])
        with tempfile.TemporaryDirectory() as temp:
            runner = FlowRunner(adb, "pkg", config, Path(temp))
            stdout = io.StringIO()
            with patch("appmarket_flow.time.sleep", return_value=None), redirect_stdout(stdout):
                result = runner.run("launch-only", launch_app=False)

        self.assertEqual("completed", result["status"])
        self.assertEqual(
            [("launch", "started"), ("launch", "passed"), ("flow", "completed")],
            [(event["step"], event["status"]) for event in runner.events],
        )
        self.assertIn("[flow] flow: completed - 启动流程结束", stdout.getvalue())

    def test_sticky_download_does_not_skip_scrolling_to_stable_bottom(self) -> None:
        initial = UiTree(ui_xml("top", sticky_download=True))
        bottom = ui_xml("bottom", sticky_download=True)
        adb = SequenceAdb([bottom, bottom, bottom])
        with tempfile.TemporaryDirectory() as temp:
            runner = FlowRunner(adb, "pkg", {}, Path(temp))
            with patch("appmarket_flow.time.sleep", return_value=None):
                _xml, final_tree, swipes = runner.scroll_detail_to_bottom(initial)
        swipe_calls = [call for call in adb.shell_calls if call[:2] == ("input", "swipe")]
        self.assertEqual(3, swipes)
        self.assertEqual(3, len(swipe_calls))
        self.assertTrue(final_tree.find([{"resource_id": "downloadButton"}], "pkg"))

    def test_click_rejects_dangerous_label_anywhere_in_click_target_subtree(self) -> None:
        xml = """<?xml version='1.0' encoding='UTF-8'?>
        <hierarchy><node package='pkg' bounds='[0,0][1000,600]'>
          <node package='pkg' clickable='true' enabled='true' bounds='[100,100][800,500]'>
            <node package='pkg' text='普通入口' clickable='false' enabled='true'
                  bounds='[120,120][400,200]' />
            <node package='pkg' text='删除账号' clickable='false' enabled='true'
                  bounds='[120,220][400,300]' />
          </node>
        </node></hierarchy>"""
        tree = UiTree(xml)
        selected = tree.find([{"text": "普通入口"}], "pkg")[0]
        adb = SequenceAdb([xml])
        with tempfile.TemporaryDirectory() as temp:
            runner = FlowRunner(adb, "pkg", {}, Path(temp))
            with self.assertRaisesRegex(FlowError, "Refusing dangerous UI action"):
                runner.click(tree, selected, "dangerous-click")
        self.assertNotIn(("input", "tap", "450", "300"), adb.shell_calls)
        self.assertFalse(any(call[:2] == ("input", "tap") for call in adb.shell_calls))


class RunnerTests(unittest.TestCase):
    def test_screenrecord_segment_plan_and_command_cover_long_runs(self) -> None:
        self.assertEqual([170, 170], plan_screenrecord_segments(180))
        self.assertEqual(22, len(plan_screenrecord_segments(3600)))
        command = build_screenrecord_command(
            "adb",
            "SERIAL",
            "/sdcard/appmarket_perf_test_001.mp4",
        )
        self.assertEqual(
            [
                "adb", "-s", "SERIAL", "shell", "screenrecord",
                "--bit-rate", "4000000", "--time-limit", "170",
                "/sdcard/appmarket_perf_test_001.mp4",
            ],
            command,
        )

    def test_logcat_pipe_rotation_keeps_only_the_two_newest_segments(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            current = Path(temp) / "logcat.txt"
            state: dict[str, object] = {}
            copy_rotating_logcat_stream(
                io.BytesIO(b"abcdefghijklmnopqrstuvwxyz"),
                current,
                segment_bytes=10,
                state=state,
            )
            previous = Path(temp) / "logcat.previous.txt"
            self.assertEqual(b"klmnopqrst", previous.read_bytes())
            self.assertEqual(b"uvwxyz", current.read_bytes())
            self.assertEqual(2, state["rotations"])
            self.assertEqual(26, state["bytes"])
            self.assertEqual("", state["error"])


class AnalyzerTests(unittest.TestCase):
    def test_pdf_pair_is_not_published_when_detailed_generation_fails(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            out_dir = Path(temp)
            summary = out_dir / "report_summary.pdf"
            detailed = out_dir / "report_detailed.pdf"
            summary.write_bytes(b"stale-summary")
            detailed.write_bytes(b"stale-detailed")

            def build_summary(path: Path, *_args: object) -> None:
                path.write_bytes(b"new-summary")

            with (
                patch("performance_pdf_report.register_cjk_font", return_value=("TestFont", "test", True)),
                patch("performance_pdf_report._styles", return_value={}),
                patch("performance_pdf_report._build_summary", side_effect=build_summary),
                patch("performance_pdf_report._build_detailed", side_effect=RuntimeError("detail layout failed")),
            ):
                with self.assertRaisesRegex(PdfReportError, "report_detailed.pdf"):
                    write_pdf_reports({}, [], out_dir)

            self.assertFalse(summary.exists())
            self.assertFalse(detailed.exists())
            self.assertFalse((out_dir / "report_summary.pdf.tmp").exists())
            self.assertFalse((out_dir / "report_detailed.pdf.tmp").exists())

    def test_report_passes_and_payload_preserves_decimals(self) -> None:
        config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        config["_performance_script"] = {
            "id": "appmarket-default",
            "name": "应用市场完整性能测试",
            "description": "启动并遍历应用市场，同时采集 CPU 与内存。",
            "runner": "features/PerformanceFeature/performance-test-scripts/tasks/android/appmarket-cpu-memory/runner.py",
            "workflow": {
                "steps": [
                    {
                        "key": "launch",
                        "label": "启动并等待首页",
                        "eventSteps": ["launch", "select_home"],
                        "modes": ["full", "launch-only"],
                    },
                    {
                        "key": "detail",
                        "label": "进入应用详情",
                        "eventSteps": ["open_detail"],
                        "modes": ["full"],
                    },
                ],
            },
            "flow": {"selectors": {"secret": "must-not-leak"}},
        }
        rows = []
        for index in range(36):
            rows.append(
                {
                    "sample_index": index + 1,
                    "target_elapsed_s": (index + 1) * 5,
                    "actual_elapsed_s": (index + 1) * 5 + 0.1,
                    "wall_time_local": "2026-07-15 00:00:00",
                    "pids": "10;11",
                    "process_names": "pkg;pkg:download",
                    "logical_cpus": 5.0,
                    "cpu_one_core_equiv_pct": 5.125,
                    "cpu_device_normalized_pct": 1.025,
                    "pss_mb": 120.25,
                    "rss_mb": 150.5,
                    "process_set_changed": 0,
                    "collection_latency_s": 0.2,
                    "note": "",
                }
            )
        sampler = {
            "requested_duration_s": 180,
            "interval_s": 5,
            "expected_rows": 36,
            "total_rows": 36,
            "cancelled": False,
            "rows_with_process_change": 0,
        }
        flow = {
            "mode": "full",
            "status": "completed",
            "download_install_completed": True,
            "menus_missing": [],
            "menus_visited": ["下载管理", "更新管理", "设置"],
        }
        manifest = {
            "session_id": "test-session",
            "round": "resource_test",
            "package": "com.appmarket.automotive",
            "flavor": "avatr8678",
            "device": {"serial": "SERIAL", "model": "Mock", "brand": "Test"},
            "app": {"version_name": "1.2.3", "version_code": 123},
            "capture_screenrecord": True,
            "screenrecord": {
                "enabled": True,
                "status": "completed",
                "segment_seconds": 170,
                "bit_rate": 4_000_000,
                "planned_segment_count": 2,
                "pulled_segment_count": 2,
                "segments": [
                    {
                        "index": 1,
                        "remote_path": "/sdcard/should_not_be_reported.mp4",
                        "local_path": "segment_001.mp4",
                        "bytes": 1234,
                        "pulled": True,
                        "status": "finished",
                    }
                ],
            },
            "warnings": [SCREENRECORD_OVERHEAD_WARNING],
        }
        with tempfile.TemporaryDirectory() as temp:
            report = summarize_report(
                rows,
                sampler,
                manifest,
                flow,
                config,
                Path(temp),
                PACKAGE_DIR,
            )
        self.assertEqual("PASS", report["acceptance"])
        topology = next(check for check in report["checks"] if check["key"] == "logical_cpu_topology")
        self.assertEqual("pass", topology["status"])
        self.assertEqual([5], topology["actual"])
        self.assertIn(SCREENRECORD_OVERHEAD_WARNING, report["warnings"])
        self.assertEqual("completed", report["screenrecord"]["status"])
        self.assertEqual("flow/video/segment_001.mp4", report["screenrecord"]["segments"][0]["file"])
        self.assertNotIn("remote_path", report["screenrecord"]["segments"][0])
        self.assertEqual("appmarket-default", report["script"]["id"])
        self.assertEqual(["launch", "select_home"], report["script"]["workflow"]["steps"][0]["eventSteps"])
        self.assertNotIn("flow", report["script"])
        payload = build_platform_payload(report, rows)
        fg_peak = next(metric for metric in payload["metrics"] if metric["name"] == "cpu:fgPeak")
        self.assertEqual(1.025, fg_peak["value"])
        self.assertEqual(36 * 4 + 8, len(payload["metrics"]))
        self.assertEqual(36, len(payload["resourceSamples"]))
        self.assertEqual("10;11", payload["resourceSamples"][0]["pids"])
        self.assertEqual(5, payload["resourceSamples"][0]["target_elapsed_s"])
        self.assertIn(SCREENRECORD_OVERHEAD_WARNING, payload["resourceProfile"]["warnings"])
        self.assertEqual(1234, payload["resourceProfile"]["screenrecord"]["segments"][0]["bytes"])
        self.assertEqual(report["script"], payload["resourceProfile"]["script"])

    def test_script_projection_rejects_unsafe_metadata_and_drops_unknown_fields(self) -> None:
        projected = project_performance_script(
            {
                "id": "custom-script",
                "name": "自定义脚本",
                "description": "",
                "category": "应用市场",
                "tags": ["CPU", "内存"],
                "sourceFiles": ["features/PerformanceFeature/custom/run.py"],
                "version": "2026.07",
                "managed": True,
                "manifestPath": "features/PerformanceFeature/performance-test-scripts/custom/task.json",
                "runner": "features/PerformanceFeature/custom/run.py",
                "workflow": {
                    "steps": [
                        {
                            "key": "launch",
                            "label": "启动",
                            "eventSteps": ["launch"],
                            "selectors": {"password": "must-not-leak"},
                        }
                    ],
                    "private": {"token": "must-not-leak"},
                },
                "environment": {"token": "must-not-leak"},
            }
        )
        self.assertEqual(
            {
                "id": "custom-script",
                "name": "自定义脚本",
                "description": "",
                "category": "应用市场",
                "tags": ["CPU", "内存"],
                "sourceFiles": ["features/PerformanceFeature/custom/run.py"],
                "version": "2026.07",
                "managed": True,
                "manifestPath": "features/PerformanceFeature/performance-test-scripts/custom/task.json",
                "runner": "features/PerformanceFeature/custom/run.py",
                "workflow": {
                    "steps": [
                        {
                            "key": "launch",
                            "label": "启动",
                            "eventSteps": ["launch"],
                            "modes": ["full", "launch-only"],
                        }
                    ]
                },
            },
            projected,
        )
        self.assertIsNone(
            project_performance_script(
                {
                    **projected,
                    "sourceFiles": ["features/PerformanceFeature/../../secrets.txt"],
                }
            )
        )

    def test_script_projection_preserves_valid_ui_snapshot(self) -> None:
        task = json.loads(
            (PACKAGE_DIR / "profiles" / "full" / "task.json").read_text(encoding="utf-8")
        )
        projected = project_performance_script(
            {
                **task,
                "managed": True,
                "manifestPath": (
                    "features/PerformanceFeature/performance-test-scripts/tasks/android/"
                    "appmarket-cpu-memory/profiles/full/task.json"
                ),
            }
        )
        self.assertIsNotNone(projected)
        self.assertEqual("acceptance-dashboard", projected["ui"]["defaultView"])
        self.assertEqual(
            ["验收指标", "原始采样与产物", "完整测试报表"],
            [view["label"] for view in projected["ui"]["views"]],
        )
        self.assertIsNone(
            project_performance_script(
                {
                    **projected,
                    "runner": "features/PerformanceFeature/../../secrets.py",
                }
            )
        )
        self.assertIsNone(
            project_performance_script(
                {
                    **projected,
                    "workflow": {
                        "steps": [
                            {"key": "one", "label": "一", "eventSteps": ["same"]},
                            {"key": "two", "label": "二", "eventSteps": ["same"]},
                        ]
                    },
                }
            )
        )

    def test_short_smoke_run_is_not_reported_as_customer_pass(self) -> None:
        config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        rows = [
            {
                "logical_cpus": 5.0,
                "cpu_one_core_equiv_pct": 1.0,
                "cpu_device_normalized_pct": 0.2,
                "pss_mb": 80.0,
                "rss_mb": 100.0,
            }
            for _ in range(2)
        ]
        with tempfile.TemporaryDirectory() as temp:
            report = summarize_report(
                rows,
                {"requested_duration_s": 10, "interval_s": 5, "expected_rows": 2},
                {"session_id": "short"},
                {"mode": "launch-only", "status": "completed"},
                config,
                Path(temp),
                PACKAGE_DIR,
            )
        self.assertEqual("INCONCLUSIVE", report["acceptance"])
        statuses = {check["key"]: check["status"] for check in report["checks"]}
        self.assertEqual("inconclusive", statuses["protocol_duration_s"])
        self.assertEqual("inconclusive", statuses["protocol_sample_rows"])

    def test_mixed_logical_cpu_counts_fail_even_when_other_metrics_pass(self) -> None:
        config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        rows = [
            {
                "logical_cpus": 5.0 if index < 18 else 8.0,
                "cpu_one_core_equiv_pct": 1.0,
                "cpu_device_normalized_pct": 0.2,
                "pss_mb": 80.0,
                "rss_mb": 100.0,
            }
            for index in range(36)
        ]
        with tempfile.TemporaryDirectory() as temp:
            report = summarize_report(
                rows,
                {
                    "requested_duration_s": 180,
                    "interval_s": 5,
                    "expected_rows": 36,
                    "cancelled": False,
                },
                {"session_id": "mixed-cpu-topology"},
                {"mode": "launch-only", "status": "completed"},
                config,
                Path(temp),
                PACKAGE_DIR,
            )
        self.assertEqual("FAIL", report["acceptance"])
        topology = next(check for check in report["checks"] if check["key"] == "logical_cpu_topology")
        self.assertEqual("fail", topology["status"])
        self.assertEqual([5, 8], topology["actual"])
        self.assertTrue(any("[5, 8]" in warning for warning in report["warnings"]))

    def test_failed_cpu_and_memory_checks_create_traceable_advice(self) -> None:
        config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        rows = [
            {
                "sample_index": index + 1,
                "actual_elapsed_s": (index + 1) * 5,
                "logical_cpus": 5.0,
                "cpu_one_core_equiv_pct": 25.0 if index == 8 else 20.0,
                "cpu_device_normalized_pct": 5.0 if index == 8 else 4.0,
                "pss_mb": 220.0 if index == 11 else 200.0,
                "rss_mb": 260.0,
            }
            for index in range(36)
        ]
        with tempfile.TemporaryDirectory() as temp:
            report = summarize_report(
                rows,
                {"requested_duration_s": 180, "interval_s": 5, "expected_rows": 36},
                {"session_id": "optimization-evidence"},
                {"mode": "launch-only", "status": "completed"},
                config,
                Path(temp),
                PACKAGE_DIR,
            )

        by_id = {item["id"]: item for item in report["optimization_advice"]}
        self.assertIn("reduce-cpu-hotspots", by_id)
        self.assertIn("reduce-memory-retention", by_id)
        cpu = by_id["reduce-cpu-hotspots"]
        memory = by_id["reduce-memory-retention"]
        self.assertIn("cpu_customer_mean_pct", cpu["related_checks"])
        self.assertEqual(9, cpu["source_samples"][0]["sample_index"])
        self.assertIn("pss_peak_mb", memory["related_checks"])
        self.assertEqual(12, memory["source_samples"][0]["sample_index"])
        advice_md = optimization_advice_markdown(report)
        self.assertIn("reduce-cpu-hotspots", advice_md)
        self.assertIn("实测", advice_md)
        self.assertIn("复验标准", advice_md)

    def test_analyzer_keeps_raw_files_and_registers_both_pdfs_and_advice(self) -> None:
        fieldnames = [
            "sample_index", "target_elapsed_s", "actual_elapsed_s", "wall_time_local",
            "pids", "process_names", "logical_cpus", "cpu_one_core_equiv_pct",
            "cpu_device_normalized_pct", "pss_mb", "rss_mb", "process_set_changed",
            "collection_latency_s", "note",
        ]
        rows = [
            {
                "sample_index": index + 1,
                "target_elapsed_s": (index + 1) * 5,
                "actual_elapsed_s": (index + 1) * 5 + 0.1,
                "wall_time_local": "2026-07-16 00:00:00",
                "pids": "10",
                "process_names": "com.appmarket.automotive",
                "logical_cpus": 5,
                "cpu_one_core_equiv_pct": 3.0,
                "cpu_device_normalized_pct": 0.6,
                "pss_mb": 100.0,
                "rss_mb": 130.0,
                "process_set_changed": 0,
                "collection_latency_s": 0.2,
                "note": "",
            }
            for index in range(2)
        ]
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            raw = root / "raw"
            flow_dir = root / "flow"
            analysis = root / "analysis"
            raw.mkdir()
            flow_dir.mkdir()
            csv_path = raw / "metrics.csv"
            with csv_path.open("w", encoding="utf-8-sig", newline="") as handle:
                writer = csv.DictWriter(handle, fieldnames=fieldnames)
                writer.writeheader()
                writer.writerows(rows)
            original_csv = csv_path.read_bytes()
            summary_path = raw / "sampler_summary.json"
            summary_path.write_text(
                json.dumps({"requested_duration_s": 10, "interval_s": 5, "expected_rows": 2}),
                encoding="utf-8",
            )
            flow_path = flow_dir / "flow_result.json"
            flow_path.write_text(
                json.dumps({"mode": "launch-only", "status": "completed"}),
                encoding="utf-8",
            )
            manifest_path = root / "run_manifest.json"
            manifest_path.write_text(
                json.dumps(
                    {
                        "session_id": "pdf-artifact-test",
                        "round": "resource_pdf_test",
                        "package": "com.appmarket.automotive",
                        "device": {"serial": "SERIAL", "model": "中文测试设备"},
                        "app": {"version_name": "1.2.3", "version_code": 123},
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            argv = [
                "analyze_appmarket_perf.py",
                "--csv", str(csv_path),
                "--sampler-summary", str(summary_path),
                "--manifest", str(manifest_path),
                "--flow-result", str(flow_path),
                "--config", str(CONFIG_PATH),
                "--out-dir", str(analysis),
                "--artifact-dir", str(root),
                "--no-upload",
            ]
            stdout = io.StringIO()
            with patch.object(sys, "argv", argv), redirect_stdout(stdout):
                exit_code = analyze_main()

            self.assertEqual(0, exit_code, stdout.getvalue())
            self.assertEqual(original_csv, csv_path.read_bytes(), "原始 CSV 不应被改写")
            expected = [
                "report.json", "report.md", "report_summary.pdf", "report_detailed.pdf",
                "optimization_advice.md", "platform_payload.json",
            ]
            for name in expected:
                self.assertTrue((analysis / name).is_file(), name)
            for name in ("report_summary.pdf", "report_detailed.pdf"):
                data = (analysis / name).read_bytes()
                self.assertTrue(data.startswith(b"%PDF-"), name)
                self.assertIn(b"%%EOF", data[-64:], name)
                self.assertGreater(len(data), 5000, name)

            report = json.loads((analysis / "report.json").read_text(encoding="utf-8"))
            artifact_keys = {item["key"] for item in report["artifacts"]}
            self.assertEqual(
                {
                    "metrics_csv", "report_json", "report_md", "report_pdf_summary",
                    "report_pdf_detailed", "optimization_advice", "platform_payload",
                },
                artifact_keys,
            )
            self.assertEqual("INCONCLUSIVE", report["acceptance"])
            self.assertEqual("complete-customer-protocol", report["optimization_advice"][0]["id"])
            self.assertIn("font", report["pdf"])

            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertTrue(manifest["reports"]["pdf_summary"].endswith("report_summary.pdf"))
            self.assertTrue(manifest["reports"]["pdf_detailed"].endswith("report_detailed.pdf"))
            manifest_artifacts = {item["key"]: item for item in manifest["artifacts"]}
            for key in artifact_keys:
                self.assertEqual(64, len(manifest_artifacts[key]["sha256"]), key)
                self.assertGreater(manifest_artifacts[key]["bytes"], 0, key)
            self.assertIn("REPORT_PDF_SUMMARY=", stdout.getvalue())
            self.assertIn("OPTIMIZATION_ADVICE=", stdout.getvalue())

            failed_stdout = io.StringIO()
            with (
                patch.object(sys, "argv", argv),
                patch(
                    "analyze_appmarket_perf.write_pdf_reports",
                    side_effect=PdfReportError("离线字体不可用"),
                ),
                redirect_stdout(failed_stdout),
            ):
                failed_exit = analyze_main()
            self.assertEqual(3, failed_exit)
            self.assertEqual(original_csv, csv_path.read_bytes(), "PDF 失败时也不能改写原始 CSV")
            self.assertTrue((analysis / "report.json").is_file())
            self.assertTrue((analysis / "report.md").is_file())
            self.assertTrue((analysis / "optimization_advice.md").is_file())
            self.assertFalse((analysis / "report_summary.pdf").exists())
            self.assertFalse((analysis / "report_detailed.pdf").exists())
            failed_report = json.loads((analysis / "report.json").read_text(encoding="utf-8"))
            self.assertEqual("failed", failed_report["pdf"]["status"])
            self.assertIn("离线字体不可用", failed_report["pdf"]["error"])
            failed_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual("离线字体不可用", failed_manifest["report_generation_error"])
            failed_artifacts = {item["key"] for item in failed_manifest["artifacts"]}
            self.assertNotIn("report_pdf_summary", failed_artifacts)
            self.assertNotIn("report_pdf_detailed", failed_artifacts)
            self.assertIn("ERROR: 离线字体不可用", failed_stdout.getvalue())


if __name__ == "__main__":
    unittest.main()
