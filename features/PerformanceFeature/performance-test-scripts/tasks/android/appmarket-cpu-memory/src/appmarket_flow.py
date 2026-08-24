#!/usr/bin/env python3
"""Host-side AppMarket UI flow using only Android platform tools.

The script reads the accessibility hierarchy with ``uiautomator dump`` and
performs input through ``adb shell input``.  It intentionally limits secondary
menus to the allow-list in appmarket_flow_config.json.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Sequence


class FlowError(RuntimeError):
    pass


class FlowCancelled(FlowError):
    pass


_BOUNDS = re.compile(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]")
_DANGEROUS = re.compile(
    r"(退出|注销|删除账号|清除数据|恢复出厂|购买|支付|卸载|logout|sign out|"
    r"delete account|factory reset|purchase|pay|uninstall)",
    re.IGNORECASE,
)


def _bool_attr(value: str | None) -> bool:
    return str(value).lower() == "true"


def _regex(pattern: str, value: str) -> bool:
    try:
        return re.search(pattern, value or "") is not None
    except re.error as exc:
        raise FlowError(f"Invalid selector regex {pattern!r}: {exc}") from exc


@dataclass(frozen=True)
class UiNode:
    element: ET.Element
    parent: ET.Element | None

    @property
    def text(self) -> str:
        return self.element.attrib.get("text", "")

    @property
    def description(self) -> str:
        return self.element.attrib.get("content-desc", "")

    @property
    def resource_id(self) -> str:
        return self.element.attrib.get("resource-id", "")

    @property
    def package(self) -> str:
        return self.element.attrib.get("package", "")

    @property
    def clickable(self) -> bool:
        return _bool_attr(self.element.attrib.get("clickable"))

    @property
    def enabled(self) -> bool:
        return self.element.attrib.get("enabled", "true").lower() != "false"

    @property
    def checked(self) -> bool:
        return _bool_attr(self.element.attrib.get("checked"))

    @property
    def checkable(self) -> bool:
        return _bool_attr(self.element.attrib.get("checkable"))

    @property
    def bounds(self) -> tuple[int, int, int, int] | None:
        match = _BOUNDS.fullmatch(self.element.attrib.get("bounds", ""))
        if not match:
            return None
        return tuple(int(value) for value in match.groups())  # type: ignore[return-value]

    @property
    def label(self) -> str:
        return self.text or self.description or self.resource_id or self.element.attrib.get("class", "node")


class UiTree:
    def __init__(self, xml_text: str) -> None:
        try:
            self.root = ET.fromstring(xml_text)
        except ET.ParseError as exc:
            raise FlowError(f"Could not parse uiautomator hierarchy: {exc}") from exc
        self.parent_by_id: dict[int, ET.Element] = {}
        for parent in self.root.iter():
            for child in parent:
                self.parent_by_id[id(child)] = parent
        self.nodes = [UiNode(node, self.parent_by_id.get(id(node))) for node in self.root.iter("node")]
        self.by_id = {id(node.element): node for node in self.nodes}

    @property
    def digest(self) -> str:
        compact = []
        for node in self.nodes:
            compact.append(
                "|".join(
                    (
                        node.resource_id,
                        node.text,
                        node.description,
                        node.element.attrib.get("bounds", ""),
                        node.element.attrib.get("clickable", ""),
                    )
                )
            )
        return hashlib.sha256("\n".join(compact).encode("utf-8")).hexdigest()

    @property
    def screen_size(self) -> tuple[int, int]:
        right = 0
        bottom = 0
        for node in self.nodes:
            if node.bounds:
                right = max(right, node.bounds[2])
                bottom = max(bottom, node.bounds[3])
        return right or 1920, bottom or 1080

    def find(self, selectors: Sequence[dict[str, Any]], package: str = "") -> list[UiNode]:
        found: list[UiNode] = []
        for node in self.nodes:
            if package and node.package and node.package != package:
                continue
            if any(self._matches(node, selector) for selector in selectors):
                found.append(node)
        return found

    def find_within(
        self,
        root: UiNode,
        selectors: Sequence[dict[str, Any]],
        package: str = "",
    ) -> list[UiNode]:
        """Find matching nodes inside one actionable subtree only.

        AppMarket reuses the same ``downloadBtn`` resource ID for both
        downloadable and already-installed apps.  Scoping the semantic label
        check to the selected card/button prevents an unrelated ``Open`` label
        elsewhere on the page from changing the action classification.
        """
        found: list[UiNode] = []
        for element in root.element.iter("node"):
            node = self.by_id.get(id(element))
            if node is None:
                continue
            if package and node.package and node.package != package:
                continue
            if any(self._matches(node, selector) for selector in selectors):
                found.append(node)
        return found

    @staticmethod
    def _matches(node: UiNode, selector: dict[str, Any]) -> bool:
        if "resource_id" in selector:
            expected = str(selector["resource_id"])
            if node.resource_id != expected and not node.resource_id.endswith("/" + expected):
                return False
        if "resource_id_regex" in selector:
            entry_name = node.resource_id.rsplit("/", 1)[-1]
            if not _regex(str(selector["resource_id_regex"]), entry_name):
                return False
        if "text" in selector and node.text != str(selector["text"]):
            return False
        if "text_regex" in selector and not _regex(str(selector["text_regex"]), node.text):
            return False
        if "desc_regex" in selector and not _regex(str(selector["desc_regex"]), node.description):
            return False
        if "clickable" in selector and node.clickable != bool(selector["clickable"]):
            return False
        if "enabled" in selector and node.enabled != bool(selector["enabled"]):
            return False
        return True

    def clickable_ancestor(self, node: UiNode) -> UiNode:
        current = node
        for _ in range(7):
            if current.clickable and current.enabled and current.bounds:
                return current
            if current.parent is None:
                break
            parent = self.by_id.get(id(current.parent))
            if parent is None:
                break
            current = parent
        return node


class AdbClient:
    def __init__(self, executable: str = "adb", serial: str = "") -> None:
        self.base = [executable]
        if serial:
            self.base += ["-s", serial]

    def run(self, args: Sequence[str], timeout: float = 30.0, binary: bool = False) -> str | bytes:
        command = [*self.base, *args]
        try:
            completed = subprocess.run(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=timeout,
                check=False,
            )
        except FileNotFoundError as exc:
            raise FlowError(f"Cannot find adb executable: {self.base[0]}") from exc
        except subprocess.TimeoutExpired as exc:
            raise FlowError(f"adb timed out: {' '.join(command)}") from exc
        if completed.returncode != 0:
            message = completed.stderr.decode("utf-8", "replace").strip()
            raise FlowError(f"adb failed ({completed.returncode}): {' '.join(command)}: {message}")
        if binary:
            return completed.stdout
        return completed.stdout.decode("utf-8", "replace").replace("\r\n", "\n")

    def shell(self, *args: str, timeout: float = 30.0) -> str:
        return str(self.run(["shell", *args], timeout=timeout))

    def dump_ui(self) -> tuple[str, UiTree]:
        remote = "/data/local/tmp/appmarket_perf_window.xml"
        last_error: FlowError | None = None
        # uiautomator is a separate device-side process.  On the vehicle it can
        # occasionally be reclaimed with exit 137 while the app is inflating a
        # detail page.  A bounded retry keeps that infrastructure event from
        # invalidating the business flow without hiding persistent failures.
        for attempt in range(3):
            try:
                self.shell("uiautomator", "dump", "--compressed", remote, timeout=20.0)
                xml_text = str(self.run(["exec-out", "cat", remote], timeout=15.0))
                start = xml_text.find("<?xml")
                if start > 0:
                    xml_text = xml_text[start:]
                return xml_text, UiTree(xml_text)
            except FlowError as exc:
                last_error = exc
                if attempt < 2:
                    # A crashing dump can leave UiAutomation registered briefly
                    # in system_server.  Retrying immediately only produces
                    # "already registered" and another exit 137.
                    time.sleep(5.0 * (attempt + 1))
        assert last_error is not None
        raise last_error

    def screenshot(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        data = self.run(["exec-out", "screencap", "-p"], timeout=20.0, binary=True)
        # Automotive builds can print a multiple-display warning to stdout
        # before the PNG stream.  Keep only the real PNG payload so evidence
        # remains viewable without changing which display screencap selects.
        payload = bytes(data)
        signature = b"\x89PNG\r\n\x1a\n"
        start = payload.find(signature)
        if start < 0:
            raise FlowError("screencap output does not contain a PNG signature")
        path.write_bytes(payload[start:])


class FlowRunner:
    def __init__(
        self,
        adb: AdbClient,
        package: str,
        config: dict[str, Any],
        output_dir: Path,
        stop_file: Path | None = None,
    ) -> None:
        self.adb = adb
        self.package = package
        self.config = config
        self.output_dir = output_dir
        self.stop_file = stop_file
        self.events_path = output_dir / "flow_events.jsonl"
        self.checkpoint_dir = output_dir / "ui"
        self.events: list[dict[str, Any]] = []
        self.warnings: list[str] = []
        self._checkpoint_index = 0

    def check_cancelled(self) -> None:
        if self.stop_file and self.stop_file.exists():
            raise FlowCancelled("flow cancellation requested")

    def event(self, step: str, status: str, message: str, **details: Any) -> None:
        row = {
            "at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "step": step,
            "status": status,
            "message": message,
            **details,
        }
        self.events.append(row)
        self.events_path.parent.mkdir(parents=True, exist_ok=True)
        with self.events_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
        print(f"[flow] {step}: {status} - {message}", flush=True)

    def checkpoint(self, name: str, xml_text: str | None = None) -> UiTree:
        self.check_cancelled()
        if xml_text is None:
            xml_text, tree = self.adb.dump_ui()
        else:
            tree = UiTree(xml_text)
        self._checkpoint_index += 1
        safe = re.sub(r"[^A-Za-z0-9_.-]+", "_", name)
        stem = f"{self._checkpoint_index:02d}_{safe}"
        self.checkpoint_dir.mkdir(parents=True, exist_ok=True)
        (self.checkpoint_dir / f"{stem}.xml").write_text(xml_text, encoding="utf-8")
        try:
            self.adb.screenshot(self.checkpoint_dir / f"{stem}.png")
        except FlowError as exc:
            self.warnings.append(f"screenshot_failed:{exc}")
        return tree

    def wait_for(
        self,
        selectors: Sequence[dict[str, Any]],
        timeout_s: float,
        *,
        allow_package_fallback: bool = False,
        reject_digest: str = "",
        stable_samples: int = 1,
    ) -> tuple[str, UiTree, list[UiNode]]:
        if stable_samples < 1:
            raise ValueError("stable_samples must be >= 1")
        deadline = time.monotonic() + timeout_s
        previous_digest = ""
        stable_count = 0
        last_xml = ""
        last_tree: UiTree | None = None
        while time.monotonic() < deadline:
            self.check_cancelled()
            xml_text, tree = self.adb.dump_ui()
            last_xml, last_tree = xml_text, tree
            candidates = tree.find(selectors, self.package) if selectors else []
            package_nodes = [node for node in tree.nodes if node.package == self.package]
            matched = candidates
            required_samples = stable_samples
            if not matched and allow_package_fallback and package_nodes:
                matched = package_nodes
                # Preserve the prior fallback behavior: a generic package-only
                # match must be seen twice even when the caller does not ask
                # for additional stability.
                required_samples = max(2, stable_samples)
            if matched and tree.digest != reject_digest:
                stable_count = stable_count + 1 if tree.digest == previous_digest else 1
                previous_digest = tree.digest
                if stable_count >= required_samples:
                    return xml_text, tree, matched
            else:
                previous_digest = ""
                stable_count = 0
            time.sleep(0.5)
        if last_tree is not None:
            raise FlowError(
                f"Timed out after {timeout_s:g}s waiting for the configured UI state "
                f"(last digest {last_tree.digest[:12]})"
            )
        raise FlowError("No UI hierarchy was available before the timeout")

    def click(self, tree: UiTree, node: UiNode, step: str, display_label: str = "") -> None:
        target = tree.clickable_ancestor(node)
        bounds = target.bounds or node.bounds
        if not bounds:
            raise FlowError(f"Node has no usable bounds: {node.label}")
        # The accessibility node selected by a selector is often an
        # unclickable label whose clickable ancestor is an otherwise
        # unlabelled container.  Inspect the complete target subtree as well
        # as the original node so a dangerous label/resource id cannot be
        # hidden below that container (including in a sibling child).
        action_elements = [node.element, *target.element.iter()]
        seen_elements: set[int] = set()
        action_text: list[str] = []
        for element in action_elements:
            if id(element) in seen_elements:
                continue
            seen_elements.add(id(element))
            action_text.extend(
                (
                    element.attrib.get("text", ""),
                    element.attrib.get("content-desc", ""),
                    element.attrib.get("resource-id", ""),
                )
            )
        if _DANGEROUS.search(" ".join(action_text)):
            raise FlowError(f"Refusing dangerous UI action: {target.label}")
        left, top, right, bottom = bounds
        if right <= left or bottom <= top:
            raise FlowError(f"Invalid node bounds for {target.label}: {bounds}")
        x, y = (left + right) // 2, (top + bottom) // 2
        self.adb.shell("input", "tap", str(x), str(y))
        self.event(
            step,
            "clicked",
            display_label or target.label,
            x=x,
            y=y,
            resource_id=target.resource_id,
            target_label=target.label,
        )

    def app_action_state(
        self,
        tree: UiTree,
        node: UiNode,
        download_selectors: Sequence[dict[str, Any]],
        installed_selectors: Sequence[dict[str, Any]],
    ) -> tuple[str, str]:
        target = tree.clickable_ancestor(node)
        installed = tree.find_within(target, installed_selectors, self.package)
        if installed:
            return "installed", installed[0].label
        downloadable = tree.find_within(target, download_selectors, self.package)
        if downloadable:
            return "downloadable", downloadable[0].label
        return "unknown", ""

    def choose_app_candidate(
        self,
        tree: UiTree,
        configured: Sequence[UiNode],
        *,
        download_selectors: Sequence[dict[str, Any]] = (),
        installed_selectors: Sequence[dict[str, Any]] = (),
    ) -> UiNode | None:
        candidates = list(configured)
        if not candidates:
            candidates = [
                node
                for node in tree.nodes
                if node.package == self.package and node.enabled and (node.clickable or node.parent is not None)
            ]
        ranked: list[tuple[int, UiNode]] = []
        seen: set[tuple[int, int, int, int]] = set()
        screen_width, screen_height = tree.screen_size
        for node in candidates:
            target = tree.clickable_ancestor(node)
            bounds = target.bounds
            if not bounds or bounds in seen:
                continue
            seen.add(bounds)
            text = " ".join((target.text, target.description, node.text, node.description)).strip()
            resource_text = " ".join((target.resource_id, node.resource_id))
            if _DANGEROUS.search(text):
                continue
            if re.search(r"^(首页|我的|搜索|Home|My|Me|Search)$", text, re.I):
                continue
            if re.search(r"(?i)(search|nav|tab|profile|recommend_empty|empty_state)", resource_text):
                continue
            if not configured and not (node.text or node.description):
                continue
            if download_selectors or installed_selectors:
                action_state, _ = self.app_action_state(
                    tree,
                    node,
                    download_selectors,
                    installed_selectors,
                )
                # The home page uses the same resource ID for "下载" and
                # "打开".  Never enter an already-installed app and never
                # guess when the card exposes no recognized action semantics.
                if action_state != "downloadable":
                    continue
            left, top, right, bottom = bounds
            width, height = right - left, bottom - top
            # Automotive layouts keep navigation/search in a side rail. A
            # fallback candidate must be in the content area; otherwise fail
            # safely and ask for selector calibration instead of tapping UI
            # chrome when the catalog is empty.
            if not configured and left < screen_width * 0.18:
                continue
            if width < 40 or height < 40 or width * height > screen_width * screen_height * 0.5:
                continue
            score = 0
            score += 40 if configured else 0
            score += 15 if target.clickable else 0
            score += 20 if node.text or node.description else 0
            score += 10 if 80 < top < 900 else 0
            score += min(20, (width * height) // 10_000)
            ranked.append((score, node))
        ranked.sort(key=lambda item: item[0], reverse=True)
        return ranked[0][1] if ranked else None

    def find_downloadable_app(
        self,
        home_tree: UiTree,
        selectors: dict[str, Any],
        *,
        max_swipes: int = 12,
    ) -> tuple[UiTree, UiNode | None]:
        """Find an explicitly downloadable card with bounded catalog scrolling."""
        previous_digest = home_tree.digest
        unchanged = 0
        for index in range(max_swipes + 1):
            configured = home_tree.find(selectors.get("app_card", []), self.package)
            candidate = self.choose_app_candidate(
                home_tree,
                configured,
                download_selectors=selectors.get("download", []),
                installed_selectors=selectors.get("installed", []),
            )
            if candidate is not None:
                return home_tree, candidate
            if index == max_swipes or unchanged >= 2:
                break
            self.check_cancelled()
            screen_width, screen_height = home_tree.screen_size
            x = int(screen_width * 0.62)
            start_y = int(screen_height * 0.80)
            end_y = int(screen_height * 0.30)
            self.adb.shell(
                "input", "swipe", str(x), str(start_y), str(x), str(end_y), "500"
            )
            self.event(
                "scroll_catalog",
                "progress",
                f"寻找可下载测试应用：下滑 {index + 1}/{max_swipes}",
            )
            time.sleep(0.4)
            _, home_tree = self.adb.dump_ui()
            if home_tree.digest == previous_digest:
                unchanged += 1
            else:
                unchanged = 0
            previous_digest = home_tree.digest
        return home_tree, None

    def find_app_by_title(
        self,
        home_tree: UiTree,
        title: str,
        *,
        max_swipes: int = 12,
    ) -> tuple[UiTree, UiNode | None]:
        """Find a configured test app, scrolling only the Home catalog.

        A fixed title is used for repeatable performance runs. Automotive home
        pages expose only the first rows to accessibility, so an exact title
        below the fold must be brought on screen before it can be selected.
        """
        previous_digest = home_tree.digest
        unchanged = 0
        for index in range(max_swipes + 1):
            title_nodes = home_tree.find([{"text": title}], self.package)
            if title_nodes:
                return home_tree, title_nodes[0]
            if index == max_swipes or unchanged >= 2:
                break
            self.check_cancelled()
            screen_width, screen_height = home_tree.screen_size
            x = int(screen_width * 0.62)
            start_y = int(screen_height * 0.80)
            end_y = int(screen_height * 0.30)
            self.adb.shell(
                "input", "swipe", str(x), str(start_y), str(x), str(end_y), "500"
            )
            self.event("scroll_catalog", "progress", f"查找 {title}：下滑 {index + 1}/{max_swipes}")
            time.sleep(0.4)
            _, home_tree = self.adb.dump_ui()
            if home_tree.digest == previous_digest:
                unchanged += 1
            else:
                unchanged = 0
            previous_digest = home_tree.digest
        return home_tree, None

    def scroll_detail_to_bottom(
        self,
        detail_tree: UiTree,
        *,
        max_swipes: int = 20,
        stable_unchanged_transitions: int = 2,
    ) -> tuple[str, UiTree, int]:
        """Scroll until the hierarchy stays unchanged across bottom swipes.

        This deliberately does not inspect the download selector. Automotive
        layouts often use a sticky download button that is visible before the
        descriptive content reaches the bottom.
        """
        if max_swipes < 1 or stable_unchanged_transitions < 1:
            raise ValueError("scroll stability limits must be positive")
        previous_digest = detail_tree.digest
        unchanged = 0
        detail_xml = ""
        for index in range(max_swipes):
            self.check_cancelled()
            screen_width, screen_height = detail_tree.screen_size
            x = screen_width // 2
            start_y = int(screen_height * 0.80)
            end_y = int(screen_height * 0.22)
            self.adb.shell(
                "input", "swipe", str(x), str(start_y), str(x), str(end_y), "500"
            )
            self.event("scroll_detail", "progress", f"下滑 {index + 1}/{max_swipes}")
            time.sleep(0.4)
            detail_xml, detail_tree = self.adb.dump_ui()
            if detail_tree.digest == previous_digest:
                unchanged += 1
            else:
                unchanged = 0
            previous_digest = detail_tree.digest
            if unchanged >= stable_unchanged_transitions:
                self.event(
                    "scroll_detail",
                    "passed",
                    "详情页已稳定在底部",
                    swipes=index + 1,
                    unchanged_transitions=unchanged,
                )
                return detail_xml, detail_tree, index + 1
        raise FlowError(
            f"Detail page did not reach a stable bottom after {max_swipes} swipes"
        )

    def run(
        self,
        mode: str,
        fixed_app_title: str = "",
        *,
        launch_app: bool = True,
    ) -> dict[str, Any]:
        selectors = self.config.get("selectors", {})
        timeout_cfg = self.config.get("timeouts", {})
        ready_timeout = float(timeout_cfg.get("page_ready_s", 30))
        install_timeout = float(timeout_cfg.get("install_s", 120))
        dwell_s = float(timeout_cfg.get("menu_dwell_s", 2))
        home_stable_samples = int(timeout_cfg.get("home_stable_samples", 3))
        result: dict[str, Any] = {
            "mode": mode,
            "status": "running",
            "download_install_completed": False,
            "menus_configured": len(self.config.get("secondary_menus", [])),
            "menus_visited": [],
            "menus_missing": [],
        }
        try:
            self.event("launch", "started", self.package)
            if launch_app:
                self.adb.shell("am", "force-stop", self.package)
                self.adb.shell(
                    "monkey", "-p", self.package, "-c", "android.intent.category.LAUNCHER", "1",
                    timeout=30.0,
                )
            # The automotive Home accessibility tree contains transient null
            # children while its first card rows inflate.  The platform's
            # uiautomator dumper crashes on that state; a five-second settle was
            # verified on-device and still leaves launch CPU inside sampling.
            time.sleep(5.0)
            _, initial_tree, _ = self.wait_for(
                [], ready_timeout, allow_package_fallback=True
            )
            home_tabs = initial_tree.find(selectors.get("home_tab", []), self.package)
            if not home_tabs:
                raise FlowError("The Home tab was not found; calibrate selectors.home_tab")
            if not any(node.checked for node in home_tabs):
                self.click(initial_tree, home_tabs[0], "select_home")
                time.sleep(0.8)
            home_xml, home_tree, _ = self.wait_for(
                selectors.get("home_ready", []),
                ready_timeout,
                stable_samples=home_stable_samples,
            )
            selected_home = home_tree.find(selectors.get("home_tab", []), self.package)
            checkable_home = [node for node in selected_home if node.checkable]
            if checkable_home and not any(node.checked for node in checkable_home):
                raise FlowError("The Home tab did not become active")
            self.checkpoint("home_ready", home_xml)
            self.event(
                "launch",
                "passed",
                "应用市场首页已完全加载并稳定",
                stable_samples=home_stable_samples,
            )
            if mode == "launch-only":
                result["status"] = "completed"
                self.event("flow", "completed", "启动流程结束")
                return result

            # The install and profile-menu branches are independent evidence.
            # If the current region has no catalog, keep browsing the safe My
            # menus and report a partial flow instead of losing that evidence.
            try:
                empty_nodes = home_tree.find(selectors.get("catalog_empty", []), self.package)
                if empty_nodes:
                    message = next(
                        (node.text or node.description for node in empty_nodes if node.text or node.description),
                        "catalog empty",
                    )
                    raise FlowError(f"Catalog is empty: {message}")
                title = fixed_app_title or str(self.config.get("fixed_test_app_title", ""))
                if title:
                    home_tree, app_node = self.find_app_by_title(home_tree, title)
                    if app_node is not None:
                        action_state, action_label = self.app_action_state(
                            home_tree,
                            app_node,
                            selectors.get("download", []),
                            selectors.get("installed", []),
                        )
                        if action_state == "installed":
                            raise FlowError(
                                f"Configured test app {title!r} is already installed "
                                f"(action={action_label or 'Open'}); choose a safe uninstalled test app"
                            )
                        if action_state != "downloadable":
                            raise FlowError(
                                f"Configured test app {title!r} has no recognized download action"
                            )
                else:
                    home_tree, app_node = self.find_downloadable_app(home_tree, selectors)
                if app_node is None:
                    raise FlowError(
                        "No uninstalled app with a Download/Install/Get action was found; "
                        "configure a safe test app title or prepare an uninstalled test app"
                    )
                self.click(home_tree, app_node, "open_detail")
                time.sleep(0.8)
                detail_xml, detail_tree, _ = self.wait_for(
                    selectors.get("detail_ready", []),
                    ready_timeout,
                    allow_package_fallback=True,
                    reject_digest=home_tree.digest,
                )
                self.checkpoint("detail_ready", detail_xml)

                detail_xml, detail_tree, _ = self.scroll_detail_to_bottom(detail_tree)
                self.checkpoint("detail_bottom", detail_xml)
                download_nodes = detail_tree.find(selectors.get("download", []))
                if not download_nodes:
                    raise FlowError("Download/install button was not found after scrolling")
                download_node: UiNode | None = None
                installed_label = ""
                for candidate in download_nodes:
                    action_state, action_label = self.app_action_state(
                        detail_tree,
                        candidate,
                        selectors.get("download", []),
                        selectors.get("installed", []),
                    )
                    if action_state == "installed":
                        installed_label = action_label
                        continue
                    if action_state == "downloadable":
                        download_node = candidate
                        break
                if download_node is None and installed_label:
                    raise FlowError(
                        "Selected app is already installed "
                        f"(action={installed_label}); refusing to click Open as if it were Download"
                    )
                if download_node is None:
                    raise FlowError("No semantically valid Download/Install/Get action was found")
                self.click(detail_tree, download_node, "download_install")

                deadline = time.monotonic() + install_timeout
                installed = False
                while time.monotonic() < deadline:
                    self.check_cancelled()
                    xml_text, tree = self.adb.dump_ui()
                    if tree.find(selectors.get("installed", [])):
                        installed = True
                        self.checkpoint("installed", xml_text)
                        break
                    installer = tree.find(selectors.get("installer_action", []))
                    if installer:
                        self.click(tree, installer[0], "installer_confirm")
                        time.sleep(0.8)
                        continue
                    time.sleep(0.75)
                if not installed:
                    raise FlowError(f"Installation did not reach an Installed/Open state in {install_timeout:g}s")
                result["download_install_completed"] = True
                self.event("download_install", "passed", "下载与安装完成")
            except FlowCancelled:
                raise
            except FlowError as exc:
                result["download_install_error"] = str(exc)
                self.warnings.append(f"download_install_failed:{exc}")
                self.event("download_install", "failed", str(exc))

            # Return to the app-market surface, preferring its explicit Home
            # tab before pressing Back (Back from an already-empty Home would
            # otherwise close the app).
            for _ in range(6):
                xml_text, tree = self.adb.dump_ui()
                if any(node.package == self.package for node in tree.nodes):
                    home_tabs = tree.find(selectors.get("home_tab", []), self.package)
                    if home_tabs:
                        self.click(tree, home_tabs[0], "return_home")
                        time.sleep(0.5)
                        break
                self.adb.shell("input", "keyevent", "KEYCODE_BACK")
                time.sleep(0.5)
            home_xml, home_tree, _ = self.wait_for(
                selectors.get("home_ready", []), ready_timeout, allow_package_fallback=True
            )
            self.checkpoint("home_returned", home_xml)

            my_nodes = home_tree.find(selectors.get("my_tab", []), self.package)
            if not my_nodes:
                raise FlowError("The My/Profile tab was not found; calibrate selectors.my_tab")
            self.click(home_tree, my_nodes[0], "open_my")
            my_xml, my_tree, _ = self.wait_for(
                selectors.get("my_ready", []),
                ready_timeout,
                allow_package_fallback=True,
                reject_digest=home_tree.digest,
            )
            self.checkpoint("my_ready", my_xml)

            for menu in self.config.get("secondary_menus", []):
                self.check_cancelled()
                label = str(menu.get("label", "menu"))
                menu_id = str(menu.get("id", label))
                xml_text, my_tree = self.adb.dump_ui()
                menu_nodes = my_tree.find(menu.get("selectors", []), self.package)
                if not menu_nodes:
                    result["menus_missing"].append(label)
                    self.warnings.append(f"menu_not_found:{label}")
                    self.event("browse_menu", "skipped", f"未找到白名单菜单：{label}")
                    continue
                self.click(my_tree, menu_nodes[0], "browse_menu", display_label=label)
                time.sleep(dwell_s)
                self.checkpoint(f"menu_{menu_id}")
                result["menus_visited"].append(label)
                self.adb.shell("input", "keyevent", "KEYCODE_BACK")
                self.wait_for(selectors.get("my_ready", []), ready_timeout, allow_package_fallback=True)

            result["status"] = (
                "completed"
                if result["download_install_completed"] and not result["menus_missing"]
                else "partial"
            )
            self.event("flow", result["status"], "模拟操作结束")
            return result
        except FlowCancelled as exc:
            result["status"] = "cancelled"
            result["error"] = str(exc)
            self.event("flow", "cancelled", str(exc))
            return result
        except Exception as exc:
            result["status"] = "failed"
            result["error"] = str(exc)
            self.event("flow", "failed", str(exc))
            try:
                self.checkpoint("failure")
            except Exception:
                pass
            return result
        finally:
            result["warnings"] = list(dict.fromkeys(self.warnings))


def load_config(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise FlowError(f"Cannot read flow config {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise FlowError("Flow config root must be a JSON object")
    return value


def run_flow(
    *,
    adb_executable: str,
    serial: str,
    package: str,
    config_path: Path,
    output_dir: Path,
    stop_file: Path | None = None,
    mode: str = "full",
    fixed_app_title: str = "",
    launch_app: bool = True,
) -> dict[str, Any]:
    config = load_config(config_path)
    output_dir.mkdir(parents=True, exist_ok=True)
    runner = FlowRunner(AdbClient(adb_executable, serial), package, config, output_dir, stop_file)
    result = runner.run(
        mode,
        fixed_app_title=fixed_app_title,
        launch_app=launch_app,
    )
    (output_dir / "flow_result.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return result


def build_parser() -> argparse.ArgumentParser:
    config_dir = Path(__file__).resolve().parent.parent / "config"
    parser = argparse.ArgumentParser(description="Simulate the AppMarket resource-performance flow")
    parser.add_argument("--adb", default="adb")
    parser.add_argument("--serial", default="")
    parser.add_argument("--package", default="com.appmarket.automotive")
    parser.add_argument("--config", type=Path, default=config_dir / "appmarket_flow_config.json")
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument("--stop-file", type=Path, default=None)
    parser.add_argument("--mode", choices=("full", "launch-only"), default="full")
    parser.add_argument("--test-app-title", default="")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    if not re.fullmatch(r"[A-Za-z0-9_.]+", args.package):
        print("ERROR: unsupported package name", file=sys.stderr)
        return 2
    result = run_flow(
        adb_executable=args.adb,
        serial=args.serial,
        package=args.package,
        config_path=args.config,
        output_dir=args.out_dir,
        stop_file=args.stop_file,
        mode=args.mode,
        fixed_app_title=args.test_app_title,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get("status") in {"completed", "partial"} else 2


if __name__ == "__main__":
    raise SystemExit(main())
