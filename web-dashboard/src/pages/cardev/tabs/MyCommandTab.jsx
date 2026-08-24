import React, { useEffect, useState } from "react";
import { Btn, Card, Field, Input, StatusBar, Grid } from "../ui.jsx";
import { cardevApi } from "../api.js";

export default function MyCommandTab({ serial }) {
  const [items, setItems] = useState([]);
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [status, setStatus] = useState(null);

  async function refresh() {
    const r = await cardevApi.listCommands();
    if (r.ok) setItems(r.data);
  }

  useEffect(() => { refresh(); }, []);

  async function add() {
    if (!name.trim() || !command.trim()) return;
    const r = await cardevApi.addCommand({ name, command });
    setStatus({ type: r.ok ? "ok" : "err", text: r.ok ? "已保存" : (r.error || "保存失败") });
    if (r.ok) { setName(""); setCommand(""); refresh(); }
  }

  async function exec(cmd) {
    const r = await cardevApi.execCommand(serial, cmd);
    setStatus({
      type: r.ok ? "ok" : "err",
      text: `执行: ${cmd}\n${r.ok ? "OK" : (r.error || r.stderr || "失败")}\n${(r.stdout || "").trim()}`.slice(0, 1200),
    });
  }

  async function remove(id) {
    await cardevApi.deleteCommand(id);
    refresh();
  }

  return (
    <div className="space-y-4">
      <Grid minWidth={400}>
        <Card title="新增自定义 ADB 命令">
          <div className="space-y-3">
            <Field label="名称">
              <Input value={name} onChange={setName} placeholder="例如：截屏" />
            </Field>
            <Field label="命令" hint="必须以 adb 开头；如已选择设备会自动注入 -s">
              <Input value={command} onChange={setCommand} placeholder="例如：adb shell screencap -p /sdcard/s.png" />
            </Field>
            <Btn block onClick={add} disabled={!name.trim() || !command.trim()}>保存</Btn>
          </div>
        </Card>

        <Card title="已保存的命令">
          {!items.length ? (
            <p className="text-xs text-zinc-500">尚未保存任何命令。</p>
          ) : (
            <div className="space-y-2 max-h-[420px] overflow-y-auto pr-1">
              {items.map((it) => (
                <div key={it.id} className="bg-zinc-950/50 border border-zinc-800 rounded p-2.5 flex items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-zinc-200 truncate">{it.name}</div>
                    <div className="text-[11px] text-zinc-500 font-mono break-all">{it.command}</div>
                  </div>
                  <div className="flex gap-1.5 shrink-0">
                    <Btn onClick={() => exec(it.command)} disabled={!serial}>执行</Btn>
                    <Btn variant="danger" onClick={() => remove(it.id)}>删除</Btn>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </Grid>

      {status && <StatusBar status={status} />}
    </div>
  );
}
