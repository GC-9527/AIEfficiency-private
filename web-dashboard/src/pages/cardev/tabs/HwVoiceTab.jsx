import React, { useEffect, useState } from "react";
import { Btn, Card, Field, Input, StatusBar, ButtonGrid } from "../ui.jsx";
import { cardevApi } from "../api.js";

const PRESETS = [
  { key: "PreviousMusic", label: "上一首" },
  { key: "ResumeMusic", label: "播放" },
  { key: "PauseMusic", label: "暂停" },
  { key: "NextMusic", label: "下一首" },
  { key: "FastForward", label: "快进" },
  { key: "FastRewind", label: "快退" },
  { key: "CloseVideo", label: "关闭视频" },
  { key: "CollectVideo", label: "收藏内容" },
  { key: "DiscollectVideo", label: "取消收藏" },
  { key: "OpenCollect", label: "打开我的收藏" },
];

export default function HwVoiceTab({ serial }) {
  const [text, setText] = useState("");
  const [history, setHistory] = useState([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [status, setStatus] = useState(null);

  useEffect(() => {
    cardevApi.getLastText("hw_voice_text").then((r) => r.value && setText(r.value));
  }, []);

  function showResult(label, r) {
    setStatus({
      type: r.ok ? "ok" : "err",
      text: `${label}: ${r.ok ? "OK" : (r.error || r.stderr || "失败")}\n${(r.stdout || "").trim()}`.slice(0, 800),
    });
  }

  async function runPreset(key) {
    showResult(`H方语音 ${key}`, await cardevApi.hwPreset(serial, key));
  }

  async function runText() {
    if (!text.trim()) return;
    cardevApi.setLastText("hw_voice_text", text);
    setHistory((h) => [...h, text]);
    setHistoryIdx(-1);
    const r = await cardevApi.hwText(serial, text);
    showResult(`H方语音 文本`, r);
    setText("");
  }

  function handleKey(e) {
    if (e.key === "Enter") { e.preventDefault(); runText(); }
    else if (e.key === "ArrowUp") {
      e.preventDefault();
      const next = historyIdx < 0 ? history.length - 1 : Math.max(0, historyIdx - 1);
      if (history[next] !== undefined) { setText(history[next]); setHistoryIdx(next); }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (historyIdx < 0) return;
      const next = historyIdx + 1;
      if (next >= history.length) { setText(""); setHistoryIdx(-1); }
      else { setText(history[next]); setHistoryIdx(next); }
    }
  }

  return (
    <div className="space-y-4">
      <Card title="常用 H 方语音指令">
        <ButtonGrid items={PRESETS} onClick={runPreset} disabled={!serial} />
      </Card>

      <Card title="模拟语音文本（com.huawei.voice.car）">
        <div className="flex gap-2">
          <Input value={text} onChange={setText} placeholder="请输入模拟的语音文字（回车执行 / ↑↓ 历史记录）"
            onKeyDown={handleKey} />
          <Btn onClick={runText} disabled={!serial || !text.trim()}>执行</Btn>
        </div>
      </Card>

      {status && <StatusBar status={status} />}
    </div>
  );
}
