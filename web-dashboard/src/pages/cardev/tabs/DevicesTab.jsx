import React, { useEffect, useState } from "react";
import { Btn, Card, Input, Field, StatusBar } from "../ui.jsx";
import { cardevApi } from "../api.js";

export default function DevicesTab({ serial, onSerialChange }) {
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(false);
  const [ip, setIp] = useState("");
  const [status, setStatus] = useState(null);

  async function refresh() {
    setLoading(true);
    setStatus(null);
    const r = await cardevApi.listDevices();
    setLoading(false);
    if (r.ok) {
      setDevices(r.devices);
      // 自动选第一个 device 状态的设备
      if (!serial && r.devices.length) {
        const first = r.devices.find((d) => d.status === "device") || r.devices[0];
        if (first) onSerialChange?.(first.id);
      }
    } else {
      setStatus({ type: "err", text: r.error || "刷新失败（请确保系统已安装 adb）" });
    }
  }

  useEffect(() => { refresh(); }, []);

  async function doConnect() {
    if (!ip.trim()) return;
    setStatus({ type: "info", text: "连接中..." });
    const r = await cardevApi.connect(ip.trim());
    setStatus({ type: r.ok ? "ok" : "err", text: r.output || r.error || "" });
    if (r.ok) refresh();
  }

  async function doDisconnect(target) {
    setStatus({ type: "info", text: `断开 ${target} ...` });
    const r = await cardevApi.disconnect(target);
    setStatus({ type: r.ok ? "ok" : "err", text: r.output || r.error || "" });
    refresh();
  }

  async function doScrcpy(target) {
    setStatus({ type: "info", text: `启动投屏 ${target} ...` });
    const r = await cardevApi.scrcpy(target);
    setStatus({
      type: r.ok ? "ok" : "err",
      text: r.ok
        ? `已在新窗口启动: ${r.command || `scrcpy -s ${target}`}（如未弹出窗口请确认 scrcpy 已加入 PATH）`
        : `启动失败: ${r.error || "scrcpy 不可用"}`,
    });
  }

  return (
    <div className="space-y-4">
      <Card title="车机设备" action={<Btn variant="secondary" onClick={refresh} disabled={loading}>{loading ? "刷新中..." : "刷新"}</Btn>}>
        {!devices.length ? (
          <p className="text-xs text-zinc-500">未发现已连接设备。请先 adb connect 或 USB 连接车机。</p>
        ) : (
          <table className="w-full text-xs">
            <thead className="text-zinc-500">
              <tr className="text-left border-b border-zinc-800">
                <th className="py-1.5 pr-2">选择</th>
                <th className="py-1.5 pr-2">序列号 / IP</th>
                <th className="py-1.5 pr-2">IP</th>
                <th className="py-1.5 pr-2">状态</th>
                <th className="py-1.5">操作</th>
              </tr>
            </thead>
            <tbody>
              {devices.map((d) => (
                <tr key={d.id} className="border-b border-zinc-900 hover:bg-zinc-900/40">
                  <td className="py-1.5 pr-2">
                    <input type="radio" checked={serial === d.id} onChange={() => onSerialChange?.(d.id)} />
                  </td>
                  <td className="py-1.5 pr-2 font-mono text-zinc-300">{d.id}</td>
                  <td className="py-1.5 pr-2 font-mono text-zinc-500">{d.ip || "—"}</td>
                  <td className="py-1.5 pr-2">
                    <span className={d.status === "device" ? "text-green-400" : "text-amber-400"}>
                      {d.status}
                    </span>
                  </td>
                  <td className="py-1.5">
                    <div className="flex gap-1.5">
                      <Btn onClick={() => doScrcpy(d.id)} disabled={d.status !== "device"} title="在新控制台窗口启动 scrcpy 投屏">投屏</Btn>
                      <Btn variant="ghost" onClick={() => doDisconnect(d.id)}>断开</Btn>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="网络连接（adb connect）">
        <div className="flex gap-2 items-end">
          <div className="flex-1">
            <Field label="车机 IP（默认端口 5555）">
              <Input value={ip} onChange={setIp} placeholder="192.168.x.x 或 192.168.x.x:5555"
                onKeyDown={(e) => e.key === "Enter" && doConnect()} />
            </Field>
          </div>
          <Btn onClick={doConnect} disabled={!ip.trim()}>连接</Btn>
        </div>
        <p className="text-[11px] text-zinc-600 mt-2">
          提示：可以在「设备」页扫描局域网车机；本页仅做基本 adb 连接管理。
        </p>
      </Card>

      {status && <StatusBar status={status} />}
    </div>
  );
}
