import React, { useEffect, useState } from "react";
import { Btn, Card, Field, Input, Select, StatusBar, Grid } from "../ui.jsx";
import { cardevApi } from "../api.js";

const ACTIONS = [
  { value: "open", label: "打开" },
  { value: "close", label: "关闭" },
  { value: "select", label: "选中" },
  { value: "play", label: "play" },
  { value: "switch", label: "switch" },
];

export default function VoiceSeeTab({ serial }) {
  const [action, setAction] = useState("open");
  const [name, setName] = useState("");
  const [status, setStatus] = useState(null);

  useEffect(() => {
    cardevApi.getLastText("voice_see_name").then((r) => r.value && setName(r.value));
  }, []);

  function showResult(label, r) {
    setStatus({
      type: r.ok ? "ok" : "err",
      text: `${label}: ${r.ok ? "OK" : (r.error || r.stderr || "失败")}\n${(r.stdout || "").trim()}`.slice(0, 800),
    });
  }

  async function exec() {
    if (!name.trim()) return;
    cardevApi.setLastText("voice_see_name", name);
    showResult(`可见可说 ${action}`, await cardevApi.voiceSee(serial, action, name));
  }

  return (
    <div className="space-y-4">
      <Grid minWidth={320}>
        <Card title="可见可说指令">
          <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }}>
            <Btn block variant="secondary" onClick={async () => showResult("buildTree", await cardevApi.buildTree(serial))} disabled={!serial}>构建无障碍树</Btn>
            <Btn block variant="secondary" onClick={async () => showResult("mockHotWords", await cardevApi.hotWords(serial))} disabled={!serial}>模拟语音助手激活</Btn>
          </div>
        </Card>

        <Card title="ADB 可见可说语音指令">
          <div className="flex gap-2 items-end">
            <Field label="动作">
              <Select value={action} onChange={setAction} options={ACTIONS} />
            </Field>
            <div className="flex-1">
              <Field label="目标名称">
                <Input value={name} onChange={setName} placeholder="例如 播放 / 收藏 / 视频名称"
                  onKeyDown={(e) => e.key === "Enter" && exec()} />
              </Field>
            </div>
            <Btn onClick={exec} disabled={!serial || !name.trim()}>执行</Btn>
          </div>
        </Card>
      </Grid>

      {status && <StatusBar status={status} />}
    </div>
  );
}
