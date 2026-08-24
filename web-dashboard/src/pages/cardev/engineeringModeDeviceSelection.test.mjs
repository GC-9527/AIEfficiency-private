import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("CarDev workbench exposes an accessible, responsive design contract", () => {
  const page = readFileSync(new URL("./index.jsx", import.meta.url), "utf8");
  const ui = readFileSync(new URL("./ui.jsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../../index.css", import.meta.url), "utf8");

  assert.match(page, /data-ui-region="cardev-workbench"/);
  assert.match(page, /aria-label="车机调试工具"/);
  assert.match(page, /role="tablist"/);
  assert.match(page, /role="tab"/);
  assert.match(page, /aria-selected=\{active === tab\.id\}/);
  assert.match(page, /role="tabpanel"/);
  assert.match(page, /data-device-state=\{currentDevice \? "connected" : "idle"\}/);

  assert.match(ui, /aria-busy=\{loading \|\| undefined\}/);
  assert.match(ui, /data-state=\{interactionState\}/);
  assert.match(ui, /className="cardev-field__label"/);
  assert.match(ui, /cardev-field__helper/);

  assert.match(css, /\.cardev-workbench/);
  assert.match(css, /\.cardev-tab-rail\s*\{[\s\S]*?overflow-x:\s*auto/);
  assert.match(css, /\.cardev-card__body\s*\{[\s\S]*?overflow-x:\s*auto/);
  assert.match(css, /@media\s*\(pointer:\s*coarse\)/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
});

import {
  connectedEngineeringModeDevices,
  engineeringModeButtonLabel,
  resolveEngineeringModeDeviceFlow,
} from "./engineeringModeDeviceSelection.mjs";

test("厂商插件按钮明确显示厂商名称", () => {
  assert.equal(
    engineeringModeButtonLabel({ id: "geely", displayName: "Geely车机工程模式" }),
    "进入Geely车机工程模式",
  );
});

test("工程模式设备流忽略离线、未授权和重复设备", () => {
  const devices = connectedEngineeringModeDevices([
    { id: "CAR-1", status: "device" },
    { id: "CAR-1", status: "device" },
    { id: "CAR-2", status: "offline" },
    { id: "CAR-3", status: "unauthorized" },
  ]);
  assert.deepEqual(devices, [{ id: "CAR-1", status: "device" }]);
});

test("仅一台在线车机时直接执行", () => {
  assert.deepEqual(resolveEngineeringModeDeviceFlow([
    { id: "CAR-OFFLINE", status: "offline" },
    { id: "CAR-ONLINE", status: "device", ip: "192.0.2.20" },
  ], "CAR-OFFLINE"), {
    kind: "direct",
    devices: [{ id: "CAR-ONLINE", status: "device", ip: "192.0.2.20" }],
    selectedSerial: "CAR-ONLINE",
  });
});

test("多台在线车机时必须由用户主动选择，避免误操作当前设备", () => {
  const flow = resolveEngineeringModeDeviceFlow([
    { id: "CAR-1", status: "device" },
    { id: "CAR-2", status: "device" },
  ]);
  assert.equal(flow.kind, "choose");
  assert.equal(flow.selectedSerial, "");
  assert.deepEqual(flow.devices.map((device) => device.id), ["CAR-1", "CAR-2"]);
});

test("没有在线车机时不允许执行", () => {
  assert.deepEqual(resolveEngineeringModeDeviceFlow([
    { id: "CAR-1", status: "offline" },
  ]), { kind: "none", devices: [], selectedSerial: "" });
});

test("车机装常用命令接入可访问的多设备选择弹窗", () => {
  const source = readFileSync(new URL("./tabs/ApkInstallTab.jsx", import.meta.url), "utf8");
  assert.match(source, /engineeringPlugins\.map\(\(plugin\)/);
  assert.match(source, /onClick=\{\(\) => prepareEngineeringMode\(plugin\)\}/);
  assert.match(source, /engineeringModeButtonLabel\(plugin\)/);
  assert.match(source, /resolveEngineeringModeDeviceFlow\(r\.devices\)/);
  assert.match(source, /enterEngineeringMode\(plugin\.id, targetSerial\)/);
  assert.match(source, /flow\.kind === "direct"/);
  assert.match(source, /role="dialog"/);
  assert.match(source, /aria-modal="true"/);
  assert.match(source, /aria-pressed=\{selected\}/);
  assert.match(source, /disabled=\{busy \|\| !selectedSerial\}/);
});
