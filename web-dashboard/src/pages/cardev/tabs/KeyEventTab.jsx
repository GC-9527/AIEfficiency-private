import React, { useState } from "react";
import { Btn, Card, StatusBar, ButtonGrid } from "../ui.jsx";
import { cardevApi } from "../api.js";

const KEYS = [
  { key: "previous", label: "方控上一个" },
  { key: "play", label: "方控播放" },
  { key: "pause", label: "方控暂停" },
  { key: "next", label: "方控下一个" },
];

export default function KeyEventTab({ serial }) {
  const [status, setStatus] = useState(null);
  async function send(key) {
    const r = await cardevApi.keyEvent(serial, key);
    setStatus({
      type: r.ok ? "ok" : "err",
      text: `方控 ${key}: ${r.ok ? "OK" : (r.error || r.stderr || "失败")}`,
    });
  }
  return (
    <div className="space-y-4">
      <Card title="方控指令（adb input keyevent）">
        <ButtonGrid items={KEYS} onClick={send} disabled={!serial} />
      </Card>
      {status && <StatusBar status={status} />}
    </div>
  );
}
