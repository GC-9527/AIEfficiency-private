/**
 * 工具命令面板（居中悬浮）—— 故事点的常用 Git/工程命令入口
 * 目前实现：Local Changes（类 Android Studio：列出各工程的待提交改动 + 未跟踪文件）
 *  - 每个工程可展开/收起
 *  - 未跟踪文件按文件夹树形展开/收起
 *  - 展开/收起全部
 * 后续可继续往命令网格里加按钮。
 */
import React, { useEffect, useMemo, useState } from "react";
import { devbenchApi } from "./api.js";

export default function ToolsPanel({ tabId, onClose, onToast }) {
  const [showMockDevices, setShowMockDevices] = useState(false);
  const [wikiSyncing, setWikiSyncing] = useState(false);

  // 从内网 AIWiki 把"应用市场"相关词条一键同步到本故事点主工程的 docs/wiki/
  async function syncMarketWiki() {
    if (wikiSyncing) return;
    setWikiSyncing(true);
    onToast?.("正在从 AIWiki 同步应用市场 Wiki…");
    const r = await devbenchApi.aiwikiSync({ tabId });
    setWikiSyncing(false);
    if (r?.ok) {
      const n = r.data?.files?.length || 0;
      const sk = r.data?.skipped?.length || 0;
      onToast?.(`已同步 ${n} 篇到 ${r.data?.projectName || "工程"} ${r.data?.dir || ""}${sk ? `（跳过 ${sk}）` : ""}`);
    } else onToast?.(r?.error || "同步失败");
  }

  const commands = [
    { key: "mock-devices", label: "设备模拟", icon: "📐", desc: "模拟设备分辨率/DPI（wm size/density）", onClick: () => setShowMockDevices(true), enabled: true },
    { key: "sync-wiki", label: wikiSyncing ? "同步中…" : "同步应用市场Wiki", icon: "📥", desc: "从内网 AIWiki 拉取应用市场词条到主工程 docs/wiki/（手动同步，非实时）", onClick: syncMarketWiki, enabled: !wikiSyncing },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="w-[480px] max-w-[92vw] max-h-[80vh] flex flex-col bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 px-4 py-3 border-b border-zinc-800 flex items-center gap-2">
          <span className="text-sm font-semibold text-zinc-100">🛠 工具命令</span>
          <span className="text-[11px] text-zinc-500">点按钮执行对应命令</span>
          <button onClick={onClose} className="ml-auto text-zinc-500 hover:text-zinc-200 text-sm px-1">✕</button>
        </div>
        <div className="p-3 grid grid-cols-2 gap-2 overflow-y-auto">
          {commands.map((c) => (
            <button
              key={c.key}
              onClick={c.enabled ? c.onClick : undefined}
              disabled={!c.enabled}
              className="text-left px-3 py-2.5 rounded-lg border border-zinc-700 bg-zinc-800/60 hover:bg-zinc-800 hover:border-zinc-600 disabled:opacity-50 transition"
              title={c.desc}
            >
              <div className="text-sm text-zinc-100 flex items-center gap-1.5">{c.icon} {c.label}</div>
              <div className="text-[10px] text-zinc-500 mt-0.5 truncate">{c.desc}</div>
            </button>
          ))}
        </div>
      </div>

      {showMockDevices && (
        <MockDevicePanel tabId={tabId} onClose={() => setShowMockDevices(false)} onToast={onToast} />
      )}
    </div>
  );
}

// 设备模拟面板（更高层级，盖在命令面板之上）—— 维护 wm size/density 预设并一键应用/还原
function MockDevicePanel({ tabId, onClose, onToast }) {
  const [list, setList] = useState(null);
  const [busy, setBusy] = useState(""); // 正在执行的预设 id 或 "reset"
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: "", density: "", size: "" });

  async function load() {
    const r = await devbenchApi.listMockDevices();
    if (r.ok) setList(r.data || []);
    else { onToast?.(r.error || "获取设备列表失败"); setList([]); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  async function apply(d) {
    setBusy(d.id);
    const r = await devbenchApi.applyMockDevice(tabId, { density: d.density, size: d.size });
    setBusy("");
    onToast?.(r.ok ? `已模拟「${d.name}」 ${d.size} · ${d.density}dpi` : (r.error || "模拟失败"));
  }

  async function reset() {
    setBusy("reset");
    const r = await devbenchApi.resetMockDevice(tabId);
    setBusy("");
    onToast?.(r.ok ? "已还原设备分辨率/DPI" : (r.error || "还原失败"));
  }

  async function reboot(d) {
    if (!window.confirm(`重启绑定的设备？\n（让「${d.name}」的 DPI/分辨率对所有 App 与系统 UI 彻底生效，设备会断开重连）`)) return;
    setBusy(`reboot:${d.id}`);
    const r = await devbenchApi.rebootMockDevice(tabId);
    setBusy("");
    onToast?.(r.ok ? "已发送重启命令，设备重启后请重新投屏" : (r.error || "重启失败"));
  }

  async function submitAdd() {
    const body = { name: form.name.trim(), density: form.density.trim(), size: form.size.trim() };
    if (!body.name || !body.density || !body.size) { onToast?.("请填写设备名、density、wm size"); return; }
    const r = await devbenchApi.addMockDevice(body);
    if (r.ok) {
      setForm({ name: "", density: "", size: "" });
      setAdding(false);
      load();
    } else {
      onToast?.(r.error || "新增失败");
    }
  }

  async function remove(d) {
    if (!window.confirm(`删除预设「${d.name}」？`)) return;
    const r = await devbenchApi.deleteMockDevice(d.id);
    if (r.ok) load();
    else onToast?.(r.error || "删除失败");
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="w-[560px] max-w-[94vw] max-h-[86vh] flex flex-col bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 px-4 py-3 border-b border-zinc-800 flex items-center gap-2">
          <span className="text-sm font-semibold text-zinc-100">📐 设备模拟</span>
          <span className="text-[11px] text-zinc-500">点设备即套用 wm size/density 到当前设备</span>
          <div className="ml-auto flex items-center gap-1.5">
            <button
              onClick={reset}
              disabled={busy === "reset"}
              className="text-[11px] px-2 py-0.5 rounded bg-amber-700/40 hover:bg-amber-700/60 text-amber-200 border border-amber-700/50 disabled:opacity-50"
              title="adb shell wm density reset + wm size reset"
            >{busy === "reset" ? "还原中…" : "↺ 还原"}</button>
            <button onClick={() => setAdding((v) => !v)} className="text-[11px] px-2 py-0.5 rounded bg-blue-600 hover:bg-blue-500 text-white">＋ 新增</button>
            <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200 text-sm px-1">✕</button>
          </div>
        </div>

        {adding && (
          <div className="shrink-0 px-4 py-3 border-b border-zinc-800 bg-zinc-950/40 grid grid-cols-[1fr,90px,120px,auto] gap-2 items-center">
            <input
              autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="设备名 如 avatar-8155"
              className="px-2 py-1.5 rounded bg-zinc-800 border border-zinc-700 text-xs text-zinc-100 placeholder-zinc-600 focus:border-blue-500 outline-none"
            />
            <input
              value={form.density} onChange={(e) => setForm({ ...form, density: e.target.value })}
              placeholder="density 160" inputMode="numeric"
              className="px-2 py-1.5 rounded bg-zinc-800 border border-zinc-700 text-xs text-zinc-100 placeholder-zinc-600 focus:border-blue-500 outline-none"
            />
            <input
              value={form.size} onChange={(e) => setForm({ ...form, size: e.target.value })}
              placeholder="wm size 1440x2560"
              title="填 wm size 实参，按设备自然方向顺序。竖屏自然的车机面板：标称横屏 2560×1440 → 这里填 1440x2560"
              onKeyDown={(e) => { if (e.key === "Enter") submitAdd(); }}
              className="px-2 py-1.5 rounded bg-zinc-800 border border-zinc-700 text-xs text-zinc-100 placeholder-zinc-600 focus:border-blue-500 outline-none"
            />
            <button onClick={submitAdd} className="text-xs px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white">保存</button>
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-3 py-3 space-y-1.5">
          {list === null ? (
            <div className="text-center text-zinc-600 text-xs py-10">加载中…</div>
          ) : list.length === 0 ? (
            <div className="text-center text-zinc-600 text-xs py-10">还没有设备预设，点右上「＋ 新增」添加一个</div>
          ) : (
            list.map((d) => (
              <div key={d.id} className="flex items-center gap-2 px-3 py-2 rounded-lg border border-zinc-800 bg-zinc-800/40 hover:border-zinc-700">
                <button
                  onClick={() => apply(d)}
                  disabled={!!busy}
                  className="flex-1 flex items-center gap-3 text-left disabled:opacity-50"
                  title={`adb shell wm density ${d.density} + wm size ${d.size}`}
                >
                  <span className="text-sm text-zinc-100 font-medium truncate">{d.name}</span>
                  <span className="text-[11px] font-mono text-sky-300/80 shrink-0">{d.size}</span>
                  <span className="text-[11px] font-mono text-violet-300/80 shrink-0">{d.density} dpi</span>
                </button>
                <button
                  onClick={() => apply(d)}
                  disabled={!!busy}
                  className="text-[11px] px-2.5 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50 shrink-0"
                >{busy === d.id ? "应用中…" : "模拟"}</button>
                <button
                  onClick={() => reboot(d)}
                  disabled={!!busy}
                  className="text-[11px] px-2.5 py-1 rounded bg-orange-700/50 hover:bg-orange-700/70 text-orange-200 border border-orange-700/50 disabled:opacity-50 shrink-0"
                  title="重启绑定的设备，让新 DPI/分辨率对所有 App 彻底生效（adb reboot）"
                >{busy === `reboot:${d.id}` ? "重启中…" : "↻ 重启"}</button>
                <button
                  onClick={() => remove(d)}
                  className="text-zinc-600 hover:text-red-400 text-sm px-1 shrink-0"
                  title="删除该预设"
                >🗑</button>
              </div>
            ))
          )}
        </div>

        <div className="shrink-0 px-4 py-2 border-t border-zinc-800 text-[10px] text-zinc-600">
          模拟应用到本故事点绑定的设备；未绑定时若仅一台在线设备则自动选用。还原 = wm density/size reset。
          <span className="text-zinc-500"> wm size 按设备自然方向填：竖屏自然的车机标称 2560×1440 → 填 1440x2560。</span>
        </div>
      </div>
    </div>
  );
}
