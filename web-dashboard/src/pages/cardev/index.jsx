/**
 * CarDev 页面入口：保留原有八类调试能力，只重组视觉层级与交互语义。
 */
import React, { useState } from "react";
import DevicesTab from "./tabs/DevicesTab.jsx";
import VoiceTab from "./tabs/VoiceTab.jsx";
import HwVoiceTab from "./tabs/HwVoiceTab.jsx";
import KeyEventTab from "./tabs/KeyEventTab.jsx";
import VoiceSeeTab from "./tabs/VoiceSeeTab.jsx";
import SafeDriveTab from "./tabs/SafeDriveTab.jsx";
import ApkInstallTab from "./tabs/ApkInstallTab.jsx";
import MyCommandTab from "./tabs/MyCommandTab.jsx";
import Clock from "./Clock.jsx";

const TABS = [
  { id: "devices", label: "设备", Comp: DevicesTab },
  { id: "voice", label: "常用语音", Comp: VoiceTab },
  { id: "hwvoice", label: "H 方语音", Comp: HwVoiceTab },
  { id: "key", label: "方控", Comp: KeyEventTab },
  { id: "voicesee", label: "可见可说", Comp: VoiceSeeTab },
  { id: "safedrive", label: "走行规制", Comp: SafeDriveTab },
  { id: "apk", label: "车机装", Comp: ApkInstallTab },
  { id: "custom", label: "自定义命令", Comp: MyCommandTab },
];

const SERIAL_KEY = "cardev_selected_serial";

export default function CarDev() {
  const [active, setActive] = useState("devices");
  const [serial, setSerial] = useState(() => localStorage.getItem(SERIAL_KEY) || "");

  function changeSerial(nextSerial) {
    setSerial(nextSerial || "");
    if (nextSerial) localStorage.setItem(SERIAL_KEY, nextSerial);
    else localStorage.removeItem(SERIAL_KEY);
  }

  function moveTab(event, index) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const nextIndex = (index + direction + TABS.length) % TABS.length;
    setActive(TABS[nextIndex].id);
    document.getElementById(`cardev-tab-${TABS[nextIndex].id}`)?.focus({ preventScroll: true });
  }

  const currentDevice = serial;
  const ActivePanel = TABS.find((tab) => tab.id === active)?.Comp || DevicesTab;

  return (
    <div
      className="cardev-workbench h-full flex flex-col"
      data-ui-region="cardev-workbench"
      aria-label="车机调试工具"
    >
      <header className="cardev-header">
        <div className="cardev-header__summary">
          <div className="cardev-title-group">
            <div className="cardev-title-row">
              <h1>车机调试</h1>
              <Clock className="cardev-clock" />
            </div>
            <p>连接设备，运行语音、方控、走行与安装调试任务。</p>
          </div>

          <div
            className="cardev-device-context"
            data-device-state={currentDevice ? "connected" : "idle"}
            title={currentDevice || "请先在设备页选择在线车机"}
          >
            <span className="cardev-device-context__dot" aria-hidden="true" />
            <span className="cardev-device-context__label">当前设备</span>
            <span className="cardev-device-context__value">
              {currentDevice || "尚未选择，请前往设备页"}
            </span>
          </div>
        </div>

        <nav className="cardev-tab-rail" role="tablist" aria-label="调试任务分类">
          {TABS.map((tab, index) => (
            <button
              key={tab.id}
              id={`cardev-tab-${tab.id}`}
              type="button"
              role="tab"
              aria-selected={active === tab.id}
              aria-controls={`cardev-panel-${tab.id}`}
              tabIndex={active === tab.id ? 0 : -1}
              onClick={() => setActive(tab.id)}
              onKeyDown={(event) => moveTab(event, index)}
              className="cardev-tab"
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="cardev-content">
        <div
          id={`cardev-panel-${active}`}
          className="cardev-content__inner"
          role="tabpanel"
          aria-labelledby={`cardev-tab-${active}`}
          tabIndex={0}
        >
          <ActivePanel serial={serial} onSerialChange={changeSerial} />
        </div>
      </main>
    </div>
  );
}
