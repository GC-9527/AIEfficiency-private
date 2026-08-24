import React, { useEffect, useState } from "react";
import { Btn, Card, Field, Input, StatusBar, Grid } from "../ui.jsx";
import { cardevApi, getClipboardFiles } from "../api.js";
import { isElectron, pickFile, showInFolder } from "../electron.js";
import {
  engineeringModeButtonLabel,
  resolveEngineeringModeDeviceFlow,
} from "../engineeringModeDeviceSelection.mjs";

function PathPicker({ value, onChange, placeholder, accept, title }) {
  const electron = isElectron();

  async function paste() {
    const files = await getClipboardFiles();
    if (!files.length) return;
    const found = accept ? files.find((p) => p.toLowerCase().endsWith(accept)) : files[0];
    if (found) onChange(found);
  }

  async function browse() {
    const filters = [];
    if (accept === ".apk") filters.push({ name: "APK", extensions: ["apk"] });
    else if (accept === ".xapk") filters.push({ name: "XAPK", extensions: ["xapk"] });
    filters.push({ name: "All", extensions: ["*"] });
    const picked = await pickFile({ title: title || "选择文件", filters });
    if (picked) onChange(picked);
  }

  return (
    <div className="flex gap-2">
      <Input value={value} onChange={onChange} placeholder={placeholder} />
      {electron && <Btn variant="ghost" onClick={browse} title="选择本机文件">选择文件</Btn>}
      <Btn variant="ghost" onClick={paste} title="读取剪贴板中的文件路径">从剪贴板</Btn>
      {electron && value && (
        <Btn variant="ghost" onClick={() => showInFolder(value)} title="在资源管理器中定位">定位</Btn>
      )}
    </div>
  );
}

function EngineeringModeDeviceDialog({ pluginName, devices, selectedSerial, onSelect, onCancel, onConfirm, busy }) {
  useEffect(() => {
    function onKeyDown(event) {
      if (event.key === "Escape" && !busy) onCancel();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onCancel]);

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
      onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="engineering-device-dialog-title"
        className="w-full max-w-lg overflow-hidden rounded-2xl border border-zinc-700/80 bg-gradient-to-b from-zinc-900 to-zinc-950 shadow-[0_28px_90px_rgba(0,0,0,.72)]"
      >
        <div className="flex items-start justify-between gap-4 border-b border-zinc-800 px-5 py-4">
          <div>
            <div className="mb-1 flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-500/15 text-lg" aria-hidden="true">⌨</span>
              <h2 id="engineering-device-dialog-title" className="text-base font-semibold text-zinc-100">选择要进入{pluginName}的车机</h2>
            </div>
            <p className="text-xs leading-5 text-zinc-500">检测到多台在线车机。请选择目标设备；{pluginName}插件将在执行时生成并输入对应密码。</p>
          </div>
          <button
            type="button"
            aria-label="关闭设备选择"
            className="rounded-lg px-2 py-1 text-lg text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={onCancel}
            disabled={busy}
          >×</button>
        </div>

        <div className="max-h-[52vh] space-y-2 overflow-y-auto p-4">
          {devices.map((device) => {
            const id = String(device.id || device.serial || "");
            const model = String(device.model || device.product || "").replaceAll("_", " ");
            const selected = id === selectedSerial;
            return (
              <button
                key={id}
                type="button"
                aria-pressed={selected}
                onClick={() => onSelect(id)}
                disabled={busy}
                className={`group flex w-full items-center gap-3 rounded-xl border p-3 text-left transition ${
                  selected
                    ? "border-blue-500/70 bg-blue-500/10 shadow-[0_0_0_1px_rgba(59,130,246,.12)]"
                    : "border-zinc-800 bg-zinc-900/60 hover:border-zinc-700 hover:bg-zinc-800/70"
                }`}
              >
                <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${selected ? "border-blue-400 bg-blue-500" : "border-zinc-600"}`}>
                  {selected && <span className="h-2 w-2 rounded-full bg-white" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={`block truncate text-sm text-zinc-100 ${model ? "font-medium" : "font-mono"}`}>{model || id}</span>
                  <span className="mt-0.5 block truncate font-mono text-[11px] text-zinc-500">
                    {model ? `${id} · ` : ""}{device.ip ? `IP ${device.ip}` : "USB / 本地 ADB 连接"}
                  </span>
                </span>
                <span className="rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-300">在线</span>
              </button>
            );
          })}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-zinc-800 bg-zinc-950/70 px-5 py-4">
          <p className="text-[11px] text-zinc-600">只会操作本次确认的设备</p>
          <div className="flex gap-2">
            <Btn variant="ghost" onClick={onCancel} disabled={busy}>取消</Btn>
            <Btn onClick={() => onConfirm(selectedSerial)} disabled={busy || !selectedSerial}>
              {busy ? "正在打开..." : "确认并打开"}
            </Btn>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ApkInstallTab({ serial, onSerialChange }) {
  const [apkPath, setApkPath] = useState("");
  const [xapkPath, setXapkPath] = useState("");
  const [pushLocal, setPushLocal] = useState("");
  const [pushRemote, setPushRemote] = useState("/sdcard/");
  const [mediaApk, setMediaApk] = useState("");
  const [hwApk, setHwApk] = useState("");
  const [status, setStatus] = useState(null);
  const [engineeringPlugins, setEngineeringPlugins] = useState([]);
  const [engineeringBusy, setEngineeringBusy] = useState(false);
  const [engineeringDialog, setEngineeringDialog] = useState(null);

  useEffect(() => {
    cardevApi.getLastText("apk_path").then((r) => r.value && setApkPath(r.value));
    cardevApi.getLastText("xapk_path").then((r) => r.value && setXapkPath(r.value));
    cardevApi.getLastText("push_local").then((r) => r.value && setPushLocal(r.value));
    cardevApi.getLastText("push_remote").then((r) => r.value && setPushRemote(r.value));
    cardevApi.getLastText("media_apk").then((r) => r.value && setMediaApk(r.value));
    cardevApi.getLastText("hw_apk").then((r) => r.value && setHwApk(r.value));
    cardevApi.listEngineeringModePlugins().then((r) => {
      if (r.ok && Array.isArray(r.plugins)) setEngineeringPlugins(r.plugins);
    }).catch(() => {});
  }, []);

  function showResult(label, r) {
    setStatus({
      type: r.ok ? "ok" : "err",
      text: `${label}: ${r.ok ? "OK" : (r.error || r.stderr || "失败")}\n${(r.stdout || "").trim()}`.slice(0, 1200),
    });
  }

  async function openEngineeringMode(plugin, targetSerial) {
    setEngineeringDialog(null);
    setEngineeringBusy(true);
    onSerialChange?.(targetSerial);
    setStatus({ type: "info", text: `正在 ${targetSerial} 上进入${plugin.displayName}...` });
    try {
      const r = await cardevApi.enterEngineeringMode(plugin.id, targetSerial);
      setStatus({
        type: r.ok ? "ok" : "err",
        text: r.ok
          ? `已在 ${targetSerial} 进入${plugin.displayName}${r.password ? `，动态密码：${r.password}` : ""}`
          : `进入${plugin.displayName}失败：${r.error || r.stderr || "未知错误"}`,
      });
    } catch (error) {
      setStatus({ type: "err", text: `进入${plugin.displayName}失败：${error?.message || "无法连接网关"}` });
    } finally {
      setEngineeringBusy(false);
    }
  }

  async function prepareEngineeringMode(plugin) {
    if (engineeringBusy) return;
    setEngineeringBusy(true);
    setStatus({ type: "info", text: "正在检查在线车机..." });
    try {
      const r = await cardevApi.listDevices();
      if (!r.ok) {
        setStatus({ type: "err", text: r.error || "读取车机列表失败，请确认 ADB 已就绪。" });
        setEngineeringBusy(false);
        return;
      }
      const flow = resolveEngineeringModeDeviceFlow(r.devices);
      if (flow.kind === "none") {
        setStatus({ type: "err", text: "没有可操作的在线车机。请先连接车机，并确认设备状态为 device。" });
        setEngineeringBusy(false);
        return;
      }
      if (flow.kind === "direct") {
        await openEngineeringMode(plugin, flow.selectedSerial);
        return;
      }
      setEngineeringDialog({ plugin, devices: flow.devices, selectedSerial: flow.selectedSerial });
      setStatus(null);
      setEngineeringBusy(false);
    } catch (error) {
      setStatus({ type: "err", text: `读取车机列表失败：${error?.message || "无法连接网关"}` });
      setEngineeringBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Grid minWidth={360}>
        <Card title="常用命令">
          <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }}>
            <Btn block variant="secondary" onClick={async () => showResult("启动 DRM", await cardevApi.startDrm(serial))} disabled={!serial}>新开 DRM 进程</Btn>
            <Btn block variant="secondary" onClick={async () => showResult("杀死应用市场进程", await cardevApi.killMarket(serial))} disabled={!serial}>杀死应用市场进程</Btn>
            {engineeringPlugins.map((plugin) => (
              <Btn
                key={plugin.id}
                block
                variant="secondary"
                onClick={() => prepareEngineeringMode(plugin)}
                disabled={engineeringBusy}
                title={`使用${plugin.manufacturer}插件进入对应车机工程模式`}
              >{engineeringBusy ? "正在处理..." : engineeringModeButtonLabel(plugin)}</Btn>
            ))}
          </div>
        </Card>

        <Card title="H 方语音相关配置">
          <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }}>
            <Btn block variant="secondary" onClick={async () => showResult("国家码 IL", await cardevApi.hwRegionIL(serial))} disabled={!serial}>设国家码为以色列</Btn>
            <Btn block variant="secondary" onClick={async () => showResult("测试 URL", await cardevApi.hwTestUrl(serial))} disabled={!serial}>设语音测试环境</Btn>
            <Btn block variant="secondary" onClick={async () => showResult("打开语音设置", await cardevApi.hwSetting(serial))} disabled={!serial}>打开语音设置</Btn>
            <Btn block variant="danger" onClick={async () => showResult("清除语音数据", await cardevApi.hwClear(serial))} disabled={!serial}>清除 H 语音包数据</Btn>
          </div>
        </Card>
      </Grid>

      <Grid minWidth={400}>
        <Card title="安装 APK">
          <div className="space-y-3">
            <Field label="APK 路径">
              <PathPicker value={apkPath} onChange={(v) => { setApkPath(v); cardevApi.setLastText("apk_path", v); }}
                accept=".apk" placeholder="本机绝对路径，例如 D:\\xxx\\app.apk" />
            </Field>
            <Btn block onClick={async () => showResult("install apk", await cardevApi.installApk(serial, apkPath))}
              disabled={!serial || !apkPath}>adb install -r</Btn>
            <Field label="XAPK 路径">
              <PathPicker value={xapkPath} onChange={(v) => { setXapkPath(v); cardevApi.setLastText("xapk_path", v); }}
                accept=".xapk" placeholder="本机绝对路径，例如 D:\\xxx\\app.xapk" />
            </Field>
            <Btn block onClick={async () => showResult("install xapk", await cardevApi.installXapk(serial, xapkPath))}
              disabled={!serial || !xapkPath}>解压并 install-multiple</Btn>
          </div>
        </Card>

        <Card title="推送文件到设备">
          <div className="space-y-3">
            <Field label="本机文件路径">
              <PathPicker value={pushLocal} onChange={(v) => { setPushLocal(v); cardevApi.setLastText("push_local", v); }}
                placeholder="例如 D:\\path\\file.zip" />
            </Field>
            <Field label="设备目标路径">
              <Input value={pushRemote} onChange={(v) => { setPushRemote(v); cardevApi.setLastText("push_remote", v); }}
                placeholder="/sdcard/" />
            </Field>
            <Btn block onClick={async () => showResult("adb push", await cardevApi.pushFile(serial, pushLocal, pushRemote))}
              disabled={!serial || !pushLocal}>adb push</Btn>
          </div>
        </Card>
      </Grid>

      <Grid minWidth={400}>
        <Card title="媒体空间分步装载">
          <Field label="MediaSpace APK 路径（仅 step2 需要）">
            <PathPicker value={mediaApk} onChange={(v) => { setMediaApk(v); cardevApi.setLastText("media_apk", v); }}
              accept=".apk" placeholder="MediaSpace 调试包绝对路径" />
          </Field>
          <div className="grid gap-2 mt-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))" }}>
            <Btn block onClick={async () => showResult("MediaSpace step1", await cardevApi.mediaSpaceStep("step1", serial))} disabled={!serial}>第一步：卸载老包</Btn>
            <Btn block onClick={async () => showResult("MediaSpace step2", await cardevApi.mediaSpaceStep("step2", serial, mediaApk))} disabled={!serial || !mediaApk}>第二步：上传+链接</Btn>
            <Btn block variant="danger" onClick={async () => showResult("MediaSpace step3", await cardevApi.mediaSpaceStep("step3", serial))} disabled={!serial}>第三步：清缓存</Btn>
          </div>
        </Card>

        <Card title="H 方语音包分步装载">
          <Field label="HwVoice APK 路径（仅 step2 需要）">
            <PathPicker value={hwApk} onChange={(v) => { setHwApk(v); cardevApi.setLastText("hw_apk", v); }}
              accept=".apk" placeholder="HwVoice 调试包绝对路径" />
          </Field>
          <div className="grid gap-2 mt-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))" }}>
            <Btn block onClick={async () => showResult("HwVoice step1", await cardevApi.hwVoiceStep("step1", serial))} disabled={!serial}>第一步：卸载老包</Btn>
            <Btn block onClick={async () => showResult("HwVoice step2", await cardevApi.hwVoiceStep("step2", serial, hwApk))} disabled={!serial || !hwApk}>第二步：上传+链接</Btn>
            <Btn block variant="danger" onClick={async () => showResult("HwVoice step3", await cardevApi.hwVoiceStep("step3", serial))} disabled={!serial}>第三步：清缓存</Btn>
          </div>
        </Card>
      </Grid>

      {status && <StatusBar status={status} />}
      {engineeringDialog && (
        <EngineeringModeDeviceDialog
          pluginName={engineeringDialog.plugin.displayName}
          devices={engineeringDialog.devices}
          selectedSerial={engineeringDialog.selectedSerial}
          busy={engineeringBusy}
          onSelect={(selectedSerial) => setEngineeringDialog((current) => ({ ...current, selectedSerial }))}
          onCancel={() => setEngineeringDialog(null)}
          onConfirm={(targetSerial) => openEngineeringMode(engineeringDialog.plugin, targetSerial)}
        />
      )}
    </div>
  );
}
