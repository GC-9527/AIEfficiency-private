#!/usr/bin/env python3
"""Generate self-contained Chinese PDF reports for AppMarket performance runs.

The implementation intentionally embeds an available local CJK font so the
result can be opened offline on another machine without depending on a browser
or a running dashboard.  ReportLab is imported lazily: collection can still
start and produce a precise dependency error during analysis if it is missing.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Iterable
from xml.sax.saxutils import escape


class PdfReportError(RuntimeError):
    """Raised when a portable PDF cannot be produced."""


def _text(value: Any, fallback: str = "—") -> str:
    if value is None or value == "":
        return fallback
    return str(value)


def _number(value: Any, digits: int = 2, suffix: str = "") -> str:
    if value is None:
        return "—"
    try:
        return f"{float(value):.{digits}f}{suffix}"
    except (TypeError, ValueError):
        return _text(value)


def _paragraph(value: Any, style: Any) -> Any:
    from reportlab.platypus import Paragraph

    return Paragraph(escape(_text(value)).replace("\n", "<br/>"), style)


def _font_candidates() -> Iterable[Path]:
    override = os.environ.get("PERFORMANCE_PDF_FONT", "").strip()
    if override:
        yield Path(override).expanduser()

    windir = Path(os.environ.get("WINDIR", r"C:\Windows"))
    for name in (
        "Deng.ttf",
        "simhei.ttf",
        "simsunb.ttf",
        "msyh.ttc",
        "Noto Sans SC (TrueType).otf",
    ):
        yield windir / "Fonts" / name

    for name in (
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf",
        "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
        "/System/Library/Fonts/PingFang.ttc",
    ):
        yield Path(name)


def register_cjk_font() -> tuple[str, str, bool]:
    """Register an embedded system CJK font, with a standard CID fallback."""
    try:
        from reportlab.pdfbase import pdfmetrics
        from reportlab.pdfbase.ttfonts import TTFont
    except ImportError as exc:  # pragma: no cover - environment-dependent branch
        raise PdfReportError(
            "生成 PDF 需要 ReportLab；请在离线部署镜像中预装 reportlab>=4.0"
        ) from exc

    font_name = "PerformanceReportCJK"
    registered = set(pdfmetrics.getRegisteredFontNames())
    if font_name in registered:
        return font_name, "already-registered", True

    errors: list[str] = []
    for candidate in _font_candidates():
        try:
            if not candidate.is_file():
                continue
            pdfmetrics.registerFont(TTFont(font_name, str(candidate), subfontIndex=0))
            # Keep machine-specific absolute font paths out of reports/uploads.
            return font_name, f"system-font:{candidate.name}", True
        except Exception as exc:  # ReportLab raises several font-specific types.
            errors.append(f"{candidate.name}:{exc}")

    # STSong-Light is ReportLab's offline Simplified-Chinese CID fallback.  It
    # keeps generation functional on minimal CI images; Windows production uses
    # an embedded Deng/SimHei font and therefore does not enter this branch.
    try:
        from reportlab.pdfbase.cidfonts import UnicodeCIDFont

        fallback = "STSong-Light"
        if fallback not in set(pdfmetrics.getRegisteredFontNames()):
            pdfmetrics.registerFont(UnicodeCIDFont(fallback))
        return fallback, "ReportLab STSong-Light CID fallback", False
    except Exception as exc:  # pragma: no cover - only on broken ReportLab install
        detail = "; ".join(errors[-3:])
        raise PdfReportError(f"找不到可用中文字体，无法生成 PDF。{detail}; {exc}") from exc


def _styles(font_name: str) -> dict[str, Any]:
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_CENTER
    from reportlab.lib.styles import ParagraphStyle

    return {
        "title": ParagraphStyle(
            "PerfTitle", fontName=font_name, fontSize=20, leading=28,
            textColor=colors.HexColor("#152238"), alignment=TA_CENTER, spaceAfter=16,
        ),
        "subtitle": ParagraphStyle(
            "PerfSubtitle", fontName=font_name, fontSize=13, leading=18,
            textColor=colors.HexColor("#1D4ED8"), spaceBefore=10, spaceAfter=7,
        ),
        "body": ParagraphStyle(
            "PerfBody", fontName=font_name, fontSize=9.5, leading=14,
            textColor=colors.HexColor("#26364A"), wordWrap="CJK", spaceAfter=4,
        ),
        "small": ParagraphStyle(
            "PerfSmall", fontName=font_name, fontSize=7.5, leading=10,
            textColor=colors.HexColor("#425466"), wordWrap="CJK",
        ),
        "table": ParagraphStyle(
            "PerfTable", fontName=font_name, fontSize=7.5, leading=10,
            textColor=colors.HexColor("#1F2937"), wordWrap="CJK",
        ),
        "check": ParagraphStyle(
            "PerfCheck", fontName=font_name, fontSize=11, leading=16,
            textColor=colors.HexColor("#111827"), spaceAfter=7,
        ),
    }


def _table(rows: list[list[Any]], widths: list[float], styles: dict[str, Any], *, header: bool = True) -> Any:
    from reportlab.lib import colors
    from reportlab.platypus import Table, TableStyle

    converted = [
        [cell if hasattr(cell, "wrap") else _paragraph(cell, styles["table"]) for cell in row]
        for row in rows
    ]
    table = Table(converted, colWidths=widths, repeatRows=1 if header else 0, hAlign="LEFT")
    commands: list[tuple[Any, ...]] = [
        ("FONTNAME", (0, 0), (-1, -1), styles["table"].fontName),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("GRID", (0, 0), (-1, -1), 0.35, colors.HexColor("#CBD5E1")),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]
    if header and rows:
        commands += [
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#E8EEF8")),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#0F2A52")),
        ]
        if len(rows) > 1:
            commands.append(("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F8FAFC")]))
    table.setStyle(TableStyle(commands))
    return table


def _check_summary(report: dict[str, Any]) -> str:
    counts = {"pass": 0, "fail": 0, "inconclusive": 0}
    for check in report.get("checks", []):
        status = str(check.get("status", "inconclusive")).lower()
        counts[status if status in counts else "inconclusive"] += 1
    return f"通过 {counts['pass']} 项 / 失败 {counts['fail']} 项 / 证据不足 {counts['inconclusive']} 项"


def _metric_rows(report: dict[str, Any]) -> list[list[Any]]:
    metrics = report.get("measurements", {})
    return [
        ["指标", "均值", "峰值", "最小值", "有效点"],
        ["CPU 多核累计", _number(metrics.get("cpu_multi_core_pct", {}).get("mean"), suffix="%"),
         _number(metrics.get("cpu_multi_core_pct", {}).get("peak"), suffix="%"),
         _number(metrics.get("cpu_multi_core_pct", {}).get("min"), suffix="%"),
         _text(metrics.get("cpu_multi_core_pct", {}).get("valid_samples"))],
        ["CPU 整机归一化", _number(metrics.get("cpu_device_normalized_pct", {}).get("mean"), suffix="%"),
         _number(metrics.get("cpu_device_normalized_pct", {}).get("peak"), suffix="%"),
         _number(metrics.get("cpu_device_normalized_pct", {}).get("min"), suffix="%"),
         _text(metrics.get("cpu_device_normalized_pct", {}).get("valid_samples"))],
        ["Total PSS", _number(metrics.get("pss_mb", {}).get("mean"), suffix=" MiB"),
         _number(metrics.get("pss_mb", {}).get("peak"), suffix=" MiB"),
         _number(metrics.get("pss_mb", {}).get("min"), suffix=" MiB"),
         _text(metrics.get("pss_mb", {}).get("valid_samples"))],
        ["RSS（辅助）", _number(metrics.get("rss_mb", {}).get("mean"), suffix=" MiB"),
         _number(metrics.get("rss_mb", {}).get("peak"), suffix=" MiB"),
         _number(metrics.get("rss_mb", {}).get("min"), suffix=" MiB"),
         _text(metrics.get("rss_mb", {}).get("valid_samples"))],
    ]


def _check_rows(report: dict[str, Any]) -> list[list[Any]]:
    rows: list[list[Any]] = [["检查项", "实测", "要求", "结果"]]
    for check in report.get("checks", []):
        actual = check.get("actual")
        actual_text = _number(actual) if isinstance(actual, (int, float)) else _text(actual)
        limit = check.get("limit")
        limit_text = _number(limit) if isinstance(limit, (int, float)) else _text(limit)
        unit = _text(check.get("unit"), "")
        rows.append([
            check.get("label"), f"{actual_text}{unit}",
            f"{_text(check.get('comparison'), '')} {limit_text}{unit}".strip(),
            str(check.get("status", "inconclusive")).upper(),
        ])
    return rows


def _advice_blocks(report: dict[str, Any], styles: dict[str, Any], limit: int | None = None) -> list[Any]:
    from reportlab.platypus import KeepTogether, Spacer

    blocks: list[Any] = []
    advice = list(report.get("optimization_advice", []))
    if limit is not None:
        advice = advice[:limit]
    for item in advice:
        evidence = "；".join(_text(value) for value in item.get("evidence", [])) or "见对应检查项"
        actions = "；".join(_text(value) for value in item.get("actions", [])) or "保持当前基线"
        verify = "；".join(_text(value) for value in item.get("verification", [])) or "下一轮复测确认"
        content = [
            _paragraph(f"[{_text(item.get('priority'), 'P2')}] {_text(item.get('title'))}", styles["check"]),
            _paragraph(f"建议编号：{_text(item.get('id'))}　关联检查：{', '.join(item.get('related_checks', [])) or '无'}", styles["small"]),
            _paragraph(f"证据：{evidence}", styles["body"]),
            _paragraph(f"动作：{actions}", styles["body"]),
            _paragraph(f"复验：{verify}", styles["body"]),
            Spacer(1, 5),
        ]
        blocks.append(KeepTogether(content))
    return blocks


def _footer(font_name: str):
    def draw(canvas: Any, doc: Any) -> None:
        from reportlab.lib.colors import HexColor

        canvas.saveState()
        canvas.setFont(font_name, 7.5)
        canvas.setFillColor(HexColor("#64748B"))
        canvas.drawString(doc.leftMargin, 18, "应用市场性能测试自动报告 · 原始 JSON/CSV/日志保留在同轮产物目录")
        canvas.drawRightString(doc.pagesize[0] - doc.rightMargin, 18, f"第 {doc.page} 页")
        canvas.restoreState()

    return draw


def _build_summary(path: Path, report: dict[str, Any], styles: dict[str, Any], font_name: str) -> None:
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.units import mm
    from reportlab.platypus import SimpleDocTemplate, Spacer

    sampling = report.get("sampling", {})
    story: list[Any] = [
        _paragraph("应用市场 CPU / 内存性能报告（简版）", styles["title"]),
        _table(
            [
                ["结论", report.get("acceptance"), "检查汇总", _check_summary(report)],
                ["测试轮次", report.get("round"), "生成时间", report.get("generated_at")],
                ["包名", report.get("package"), "设备", report.get("device", {}).get("model")],
                ["采样", f"{sampling.get('actual_rows', 0)}/{sampling.get('expected_rows', 0)} 点",
                 "覆盖率", _number(float(sampling.get("valid_sample_ratio") or 0) * 100, suffix="%")],
                ["采样模式", sampling.get("mode", "standard"), "Perfetto 校验",
                 f"{report.get('perfetto_validation', {}).get('analysis_status', 'not_requested')} / {report.get('perfetto_validation', {}).get('threshold_status', 'NOT_EVALUATED')}"],
            ],
            [28 * mm, 55 * mm, 28 * mm, 55 * mm], styles, header=False,
        ),
        Spacer(1, 10),
        _paragraph("核心指标", styles["subtitle"]),
        _table(_metric_rows(report), [48 * mm, 29 * mm, 29 * mm, 29 * mm, 22 * mm], styles),
        _paragraph("未通过或证据不足项", styles["subtitle"]),
    ]
    notable = [
        check for check in report.get("checks", [])
        if str(check.get("status", "")).lower() != "pass"
    ]
    if notable:
        story.append(_table(_check_rows({"checks": notable}), [71 * mm, 31 * mm, 41 * mm, 22 * mm], styles))
    else:
        story.append(_paragraph("本轮所有已定义检查项均通过。", styles["body"]))
    # 简版控制在约一页，只保留优先级最高的两条；详细版列出全部建议与复验条件。
    story += [_paragraph("优先优化建议", styles["subtitle"]), *_advice_blocks(report, styles, limit=2)]
    if report.get("warnings"):
        story.append(_paragraph("注意事项", styles["subtitle"]))
        for warning in report["warnings"][:6]:
            story.append(_paragraph(f"• {warning}", styles["body"]))

    doc = SimpleDocTemplate(
        str(path), pagesize=A4, rightMargin=16 * mm, leftMargin=16 * mm,
        topMargin=15 * mm, bottomMargin=15 * mm,
        title="应用市场 CPU / 内存性能报告（简版）", author="AIEfficiency",
    )
    footer = _footer(font_name)
    doc.build(story, onFirstPage=footer, onLaterPages=footer)


def _build_detailed(
    path: Path,
    report: dict[str, Any],
    samples: list[dict[str, Any]],
    styles: dict[str, Any],
    font_name: str,
) -> None:
    from reportlab.lib.pagesizes import A4, landscape
    from reportlab.lib.units import mm
    from reportlab.platypus import PageBreak, SimpleDocTemplate

    sampling = report.get("sampling", {})
    script = report.get("script", {})
    story: list[Any] = [
        _paragraph("应用市场 CPU / 内存性能报告（详细版）", styles["title"]),
        _paragraph("测试身份与采样口径", styles["subtitle"]),
        _table(
            [
                ["字段", "值", "字段", "值"],
                ["结论", report.get("acceptance"), "会话 ID", report.get("session_id")],
                ["测试轮次", report.get("round"), "生成时间", report.get("generated_at")],
                ["包名", report.get("package"), "版本", report.get("app", {}).get("version_name")],
                ["设备序列号", report.get("device", {}).get("serial"), "设备型号", report.get("device", {}).get("model")],
                ["测试脚本", script.get("name") or "历史脚本未登记", "脚本 ID", script.get("id") or "—"],
                ["采样间隔", _number(sampling.get("interval_s"), 0, " 秒"),
                 "采样点", f"{sampling.get('actual_rows', 0)}/{sampling.get('expected_rows', 0)}"],
                ["采样模式", sampling.get("mode", "standard"), "诊断频率",
                 f"CPU {sampling.get('cpu_interval_ms', 500)}ms / RSS {sampling.get('rss_interval_ms', 1000)}ms / PSS {sampling.get('pss_interval_ms', 5000)}ms"],
                ["Perfetto 分析", report.get("perfetto_validation", {}).get("analysis_status", "not_requested"),
                 "一致性结果", report.get("perfetto_validation", {}).get("threshold_status", "NOT_EVALUATED")],
                ["有效覆盖率", _number(float(sampling.get("valid_sample_ratio") or 0) * 100, suffix="%"),
                 "流程状态", report.get("flow", {}).get("status")],
            ],
            [35 * mm, 85 * mm, 35 * mm, 85 * mm], styles,
        ),
        _paragraph("汇总指标", styles["subtitle"]),
        _table(_metric_rows(report), [62 * mm, 42 * mm, 42 * mm, 42 * mm, 38 * mm], styles),
        _paragraph("阈值与协议检查", styles["subtitle"]),
        _table(_check_rows(report), [100 * mm, 40 * mm, 65 * mm, 28 * mm], styles),
        PageBreak(),
        _paragraph("每 5 秒采样明细", styles["subtitle"]),
    ]

    sample_rows: list[list[Any]] = [["序号", "目标时间", "实际时间", "CPU 多核累计", "CPU 整机归一化", "PSS", "RSS", "进程变化/备注"]]
    for row in samples:
        notes: list[str] = []
        if row.get("process_set_changed") not in (None, 0, 0.0, "0"):
            notes.append("进程集合变化")
        if row.get("note"):
            notes.append(str(row["note"]))
        sample_rows.append([
            _text(row.get("sample_index")),
            _number(row.get("target_elapsed_s"), 1, "s"),
            _number(row.get("actual_elapsed_s"), 1, "s"),
            _number(row.get("cpu_one_core_equiv_pct"), 2, "%"),
            _number(row.get("cpu_device_normalized_pct"), 2, "%"),
            _number(row.get("pss_mb"), 2, " MiB"),
            _number(row.get("rss_mb"), 2, " MiB"),
            "；".join(notes) or "—",
        ])
    story.append(_table(sample_rows, [15 * mm, 25 * mm, 25 * mm, 34 * mm, 38 * mm, 31 * mm, 31 * mm, 48 * mm], styles))
    story += [PageBreak(), _paragraph("优化建议（可追溯）", styles["subtitle"])]
    story += _advice_blocks(report, styles)

    workflow_steps = script.get("workflow", {}).get("steps", []) if isinstance(script, dict) else []
    story.append(_paragraph("脚本工作流定义", styles["subtitle"]))
    if workflow_steps:
        workflow_rows = [["节点", "名称", "事件映射", "模式"]]
        for step in workflow_steps:
            workflow_rows.append([
                step.get("key"), step.get("label"), ", ".join(step.get("eventSteps", [])),
                ", ".join(step.get("modes", [])),
            ])
        story.append(_table(workflow_rows, [45 * mm, 75 * mm, 75 * mm, 45 * mm], styles))
    else:
        story.append(_paragraph("本轮未登记脚本工作流快照。", styles["body"]))

    if report.get("warnings"):
        story.append(_paragraph("告警与限制", styles["subtitle"]))
        for warning in report["warnings"]:
            story.append(_paragraph(f"• {warning}", styles["body"]))

    story.append(_paragraph("指标定义与原始证据", styles["subtitle"]))
    for key, definition in report.get("metric_definitions", {}).items():
        story.append(_paragraph(f"{key}：{definition}", styles["body"]))
    story.append(_paragraph(f"本轮产物根目录：{report.get('artifact_dir', '—')}", styles["body"]))
    story.append(_paragraph("原始数据：raw/metrics.csv、raw/sampler_raw_commands.jsonl、flow/flow_events.jsonl；机器报告：analysis/report.json。", styles["body"]))

    page = landscape(A4)
    doc = SimpleDocTemplate(
        str(path), pagesize=page, rightMargin=12 * mm, leftMargin=12 * mm,
        topMargin=12 * mm, bottomMargin=14 * mm,
        title="应用市场 CPU / 内存性能报告（详细版）", author="AIEfficiency",
    )
    footer = _footer(font_name)
    doc.build(story, onFirstPage=footer, onLaterPages=footer)


def write_pdf_reports(
    report: dict[str, Any],
    samples: list[dict[str, Any]],
    out_dir: Path,
) -> tuple[dict[str, Path], dict[str, Any]]:
    """Write both PDFs atomically enough for artifact scanners.

    ReportLab writes each target only after document construction succeeds.  A
    temporary name prevents a partially generated PDF from being advertised.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    font_name, font_source, embedded = register_cjk_font()
    styles = _styles(font_name)
    targets = {
        "report_pdf_summary": out_dir / "report_summary.pdf",
        "report_pdf_detailed": out_dir / "report_detailed.pdf",
    }
    builders = {
        "report_pdf_summary": lambda path: _build_summary(path, report, styles, font_name),
        "report_pdf_detailed": lambda path: _build_detailed(path, report, samples, styles, font_name),
    }
    # Build the pair completely before publishing either file. If the second
    # build or rename fails, remove both final targets so artifact scanners can
    # never expose a stale or half-generated report pair.
    temporaries = {
        key: target.with_suffix(target.suffix + ".tmp")
        for key, target in targets.items()
    }
    for path in [*targets.values(), *temporaries.values()]:
        path.unlink(missing_ok=True)
    try:
        for key, target in targets.items():
            try:
                builders[key](temporaries[key])
            except PdfReportError:
                raise
            except Exception as exc:
                raise PdfReportError(f"生成 {target.name} 失败：{exc}") from exc
        for key, target in targets.items():
            temporaries[key].replace(target)
    except Exception as exc:
        for target in targets.values():
            target.unlink(missing_ok=True)
        if isinstance(exc, PdfReportError):
            raise
        raise PdfReportError(f"发布 PDF 报告失败：{exc}") from exc
    finally:
        for temporary in temporaries.values():
            temporary.unlink(missing_ok=True)
    return targets, {"name": font_name, "source": font_source, "embedded": embedded}
