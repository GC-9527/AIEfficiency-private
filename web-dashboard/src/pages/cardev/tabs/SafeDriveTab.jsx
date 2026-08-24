import React, { useEffect, useState } from "react";
import { Btn, Card, Field, Input, StatusBar, Grid } from "../ui.jsx";
import { cardevApi } from "../api.js";

export default function SafeDriveTab({ serial }) {
  const [speed, setSpeed] = useState("0");
  const [gear, setGear] = useState("1");
  const [randomRunning, setRandomRunning] = useState(false);
  const [status, setStatus] = useState(null);

  useEffect(() => {
    cardevApi.getLastText("safe_drive_speed").then((r) => r.value && setSpeed(r.value));
    cardevApi.getLastText("safe_drive_gear").then((r) => r.value && setGear(r.value));
  }, []);

  function showResult(label, r) {
    setStatus({
      type: r.ok ? "ok" : "err",
      text: `${label}: ${r.ok ? "OK" : (r.error || r.stderr || "失败")}\n${(r.stdout || "").trim()}`.slice(0, 600),
    });
  }

  const send = (label, fn) => async () => showResult(label, await fn());

  async function startRandom() {
    const r = await cardevApi.randomStart(serial, 1000);
    if (r.ok) setRandomRunning(true);
    showResult("启动 1s 5km/h 随机切换", r);
  }
  async function stopRandom() {
    const r = await cardevApi.randomStop(serial);
    setRandomRunning(false);
    showResult("停止随机切换", r);
  }

  return (
    <div className="space-y-4">
      <Card title="走行规制指令">
        <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))" }}>
          <Btn block onClick={send("正在浏览视频", () => cardevApi.watching(serial, true))} disabled={!serial}>走行规制 正在浏览视频</Btn>
          <Btn block onClick={send("没有浏览视频", () => cardevApi.watching(serial, false))} disabled={!serial}>走行规制 没有浏览视频</Btn>
          {randomRunning ? (
            <Btn block variant="danger" onClick={stopRandom} disabled={!serial}>停止 1s 切换</Btn>
          ) : (
            <Btn block onClick={startRandom} disabled={!serial}>1秒 5km/h 上下切换</Btn>
          )}
        </div>
      </Card>

      <Grid minWidth={320}>
        <Card title="速度控制">
          <div className="flex gap-2 items-end">
            <div className="flex-1">
              <Field label="速度（km/h）">
                <Input type="number" value={speed} onChange={(v) => { setSpeed(v); cardevApi.setLastText("safe_drive_speed", v); }}
                  placeholder="0~300" min="0" max="300" step="0.01" />
              </Field>
            </div>
            <Btn onClick={send(`设速 ${speed}`, () => cardevApi.speed(serial, speed))} disabled={!serial}>模拟速度</Btn>
          </div>
        </Card>

        <Card title="档位控制">
          <div className="flex gap-2 items-end">
            <div className="flex-1">
              <Field label="档位 1~7">
                <Input type="number" value={gear} onChange={(v) => { setGear(v); cardevApi.setLastText("safe_drive_gear", v); }}
                  placeholder="1~7" min="1" max="7" step="1" />
              </Field>
            </div>
            <Btn onClick={send(`换挡 ${gear}`, () => cardevApi.gear(serial, gear))} disabled={!serial}>模拟档位</Btn>
          </div>
        </Card>
      </Grid>

      <Card title="走行规制 raw command">
        <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))" }}>
          <Btn block variant="secondary" onClick={send("initSafeDrive", () => cardevApi.rawSafe(serial, "initSafeDrive"))} disabled={!serial}>初始化走行</Btn>
          <Btn block variant="secondary" onClick={send("closeSafeDrive", () => cardevApi.rawSafe(serial, "closeSafeDrive"))} disabled={!serial}>关闭走行</Btn>
          <Btn block variant="secondary" onClick={send(`gearChange ${gear}`, () => cardevApi.gear(serial, gear))} disabled={!serial}>设置档位</Btn>
          <Btn block variant="secondary" onClick={send(`speedChange ${speed}`, () => cardevApi.speed(serial, speed))} disabled={!serial}>设置速度</Btn>
        </div>
      </Card>

      {status && <StatusBar status={status} />}
    </div>
  );
}
