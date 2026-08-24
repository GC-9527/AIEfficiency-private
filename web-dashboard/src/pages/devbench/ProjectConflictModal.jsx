/**
 * 工程占用冲突弹窗：从任务列表「再次开发/执行开发」打开故事点时，若其工程被其他故事点占用，
 * 列出所有被占用的工程，每个支持「手动输入工程路径」(放第一个) 或「下拉选择可用工程」来更改；
 * 下拉里被其他故事点占用 / 路径不存在的工程置灰不可选，并高亮显示 git 分支彩色徽标 + 是否含 WebApp。
 * 用户「取消」放弃(不落任何配置)，或「应用并打开」更新工程配置后强制打开故事点(不改的项＝接管原工程)。
 */
import React, { useState, useRef } from "react";
import { createPortal } from "react-dom";
import { BranchTag } from "./StoryTab.jsx";
import FolderPickerModal from "./FolderPickerModal.jsx";

const normP = (p) => String(p || "").replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();

// 单个被占用工程的"改用工程"选择器（自定义下拉，可放彩色分支徽标——原生 select 做不到）。
// 下拉列表用 Portal 渲染到 body + fixed 定位，避免被弹窗的 overflow-y-auto 容器截断。
function ProjPicker({ value, onChange, projects }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null); // { top, left, width } 视口坐标
  const btnRef = useRef(null);
  let label = "— 接管原工程（不更改，强制打开）—";
  if (value === "manual") label = "✎ 手动输入工程路径…";
  else if (value === "copy") label = "📋 复制一份新工程到指定目录…";
  else if (value.startsWith("id:")) { const p = projects.find((x) => `id:${x.id}` === value); if (p) label = p.name; }
  const selProj = value.startsWith("id:") ? projects.find((x) => `id:${x.id}` === value) : null;
  const toggle = () => {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      const margin = 10;
      const spaceBelow = window.innerHeight - r.bottom - margin;
      const spaceAbove = r.top - margin;
      // 下方放不下且上方更宽裕 → 向上弹；高度限制为该方向的可用空间（不足则内部滚动，绝不超出视口被截断）
      const up = spaceBelow < 240 && spaceAbove > spaceBelow;
      const left = Math.max(8, Math.min(r.left, window.innerWidth - 320));
      setPos({
        left, width: r.width,
        top: up ? undefined : Math.round(r.bottom + 4),
        bottom: up ? Math.round(window.innerHeight - r.top + 4) : undefined,
        maxHeight: Math.max(160, Math.round(up ? spaceAbove : spaceBelow)),
      });
    }
    setOpen((o) => !o);
  };
  const pick = (v) => { onChange(v); setOpen(false); };
  return (
    <div className="relative flex-1 min-w-0">
      <button ref={btnRef} onClick={toggle}
        className="w-full flex items-center gap-2 bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 hover:border-zinc-500 transition">
        <span className="truncate text-left flex-1">{label}{selProj?.webAppPath ? " (含WebApp)" : ""}</span>
        {selProj && <BranchTag branch={selProj.branch} exists={selProj.exists} />}
        <span className={`text-zinc-500 transition-transform ${open ? "rotate-180" : ""}`}>▾</span>
      </button>
      {open && pos && createPortal(
        <>
          <div className="fixed inset-0 z-[95]" onClick={() => setOpen(false)} />
          <div style={{ position: "fixed", top: pos.top, bottom: pos.bottom, left: pos.left, minWidth: pos.width, maxHeight: pos.maxHeight }}
            className="z-[96] w-max max-w-[680px] overflow-auto bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl py-1">
            {/* 本地工程会自动创建当前故事点专属 worktree。 */}
            <button onClick={() => pick("manual")} className="w-full text-left px-3 py-1.5 text-xs text-sky-300 hover:bg-zinc-800 whitespace-nowrap transition">✎ 手动输入工程路径…</button>
            <button onClick={() => pick("")} className="w-full text-left px-3 py-1.5 text-xs text-zinc-500 hover:bg-zinc-800 whitespace-nowrap transition">— 使用当前基仓并创建 worktree —</button>
            {projects.map((p) => {
              const disabled = !p.exists;
              return (
                <button key={p.id} disabled={disabled}
                  onClick={() => { if (!disabled) pick(`id:${p.id}`); }}
                  title={p.path}
                  className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs transition ${disabled ? "opacity-50 cursor-not-allowed" : "hover:bg-zinc-800"} ${value === `id:${p.id}` ? "bg-blue-600/20" : ""}`}>
                  <span className="text-zinc-200 whitespace-nowrap text-left">
                    {p.name}{p.webAppPath ? " (含WebApp)" : ""}{!p.exists ? " — 路径不存在" : " — 自动隔离"}
                  </span>
                  <BranchTag branch={p.branch} exists={p.exists} />
                </button>
              );
            })}
          </div>
        </>,
        document.body
      )}
    </div>
  );
}

export default function ProjectConflictModal({ error, occupied = [], occupiedDevices = [], projects = [], onCancel, onApply }) {
  // 用户在弹窗里做的所有更改【只存本地 state，不落任何后端配置】——
  // 只有点「应用并打开」(onApply) 才真正写入工程配置并打开；点「取消」(onCancel) 直接丢弃，
  // 原故事点保持关闭、工程配置原样不变（满足"取消则还原、不应用更改"的要求）。
  const [sel, setSel] = useState({});      // { [被占用工程名]: "" | "id:<projectId>" | "manual" | "copy" }
  const [paths, setPaths] = useState({});  // manual 时的手输路径
  const [copyDest, setCopyDest] = useState({}); // copy 时的目标父目录
  const [copyName, setCopyName] = useState({}); // copy 时的新文件夹名
  const [pickerFor, setPickerFor] = useState(null); // 正在用文件夹选择器为哪个 occName 选目标父目录
  const [busy, setBusy] = useState(false);

  const srcPathOf = (name) => projects.find((p) => p.name === name)?.path || "";

  // 选目标父目录：Electron 桌面端用原生对话框，Web 用浏览弹窗
  async function chooseDest(occName) {
    const native = window.electronAPI?.cardev?.pickFolder;
    if (native) {
      try {
        const r = await native({ title: "选择目标父目录" });
        const p = typeof r === "string" ? r : (r?.path || r?.folder || (Array.isArray(r) ? r[0] : "") || "");
        if (p) setCopyDest((m) => ({ ...m, [occName]: p }));
        return;
      } catch {}
    }
    setPickerFor(occName);
  }

  const [deviceSel, setDeviceSel] = useState({}); // { [serial]: "take" | "release" }，默认 take(接管)

  function buildRemaps() {
    const remaps = {};
    for (const o of occupied) {
      const v = sel[o.name] || "";
      if (v.startsWith("id:")) remaps[o.name] = { projectId: v.slice(3) };
      else if (v === "manual") { const p = (paths[o.name] || "").trim(); if (p) remaps[o.name] = { path: p }; }
      else if (v === "copy") {
        const srcPath = srcPathOf(o.name);
        const destDir = (copyDest[o.name] || "").trim();
        const newName = (copyName[o.name] || "").trim();
        if (srcPath && destDir && newName) remaps[o.name] = { copy: { srcPath, destDir, newName } };
      }
    }
    return remaps;
  }
  function buildDeviceActions() {
    const acts = {};
    for (const d of occupiedDevices) acts[d.serial] = deviceSel[d.serial] || "take";
    return acts;
  }

  async function apply() {
    setBusy(true);
    try { await onApply(buildRemaps(), buildDeviceActions()); } finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50" onClick={onCancel}>
      <div className="w-[600px] max-w-[94vw] max-h-[84vh] flex flex-col bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="shrink-0 px-4 py-3 border-b border-zinc-800 flex items-center gap-2">
          <span className="text-sm font-semibold text-zinc-100">⚠ 工程被占用，无法打开故事点</span>
          <button onClick={onCancel} className="ml-auto text-zinc-500 hover:text-zinc-200 text-sm px-1">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          <div className="text-[12px] text-amber-300/90 bg-amber-900/15 border border-amber-800/40 rounded p-2.5 leading-relaxed">
            {error || "该故事点的工程被其他故事点占用。"}
          </div>

          {occupied.length === 0 && occupiedDevices.length === 0 && (
            <div className="text-[12px] text-zinc-400">未能解析出具体被占用的工程/设备；可直接「强制打开」接管，或取消后在占用方释放。</div>
          )}

          {occupiedDevices.length > 0 && (
            <div className="space-y-2">
              <div className="text-[11px] text-zinc-500">被占用的设备：</div>
              {occupiedDevices.map((d) => {
                const a = deviceSel[d.serial] || "take";
                return (
                  <div key={d.serial} className="border border-zinc-800 rounded-lg px-3 py-2.5 bg-zinc-800/40 space-y-1.5">
                    <div className="text-[12px] text-zinc-200">
                      设备 <span className="font-medium text-cyan-200 font-mono">{d.serial}</span>
                      <span className="text-zinc-500"> — 被故事点「{d.owner}」占用</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button onClick={() => setDeviceSel((m) => ({ ...m, [d.serial]: "take" }))}
                        className={`text-[11px] px-2.5 py-1 rounded border transition ${a === "take" ? "bg-blue-600 border-blue-500 text-white" : "bg-zinc-900 border-zinc-700 text-zinc-300 hover:border-zinc-500"}`}>
                        接管设备（从「{d.owner}」释放，本故事点独占）
                      </button>
                      <button onClick={() => setDeviceSel((m) => ({ ...m, [d.serial]: "release" }))}
                        className={`text-[11px] px-2.5 py-1 rounded border transition ${a === "release" ? "bg-blue-600 border-blue-500 text-white" : "bg-zinc-900 border-zinc-700 text-zinc-300 hover:border-zinc-500"}`}>
                        不绑定该设备打开
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {occupied.length > 0 && (
            <div className="space-y-2.5">
              <div className="text-[11px] text-zinc-500">为每个被占用的工程选择替换（不选＝接管原工程强制打开）：</div>
              {occupied.map((o) => {
                const v = sel[o.name] || "";
                return (
                  <div key={o.name} className="border border-zinc-800 rounded-lg px-3 py-2.5 bg-zinc-800/40 space-y-1.5">
                    <div className="text-[12px] text-zinc-200">
                      工程 <span className="font-medium text-amber-200">{o.name}</span>
                      <span className="text-zinc-500"> — 被故事点「{o.owner}」占用</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] text-zinc-500 shrink-0">改用</span>
                      <ProjPicker
                        value={v}
                        onChange={(nv) => setSel((s) => ({ ...s, [o.name]: nv }))}
                        projects={projects}
                      />
                    </div>
                    {v === "manual" && (
                      <input
                        value={paths[o.name] || ""}
                        onChange={(e) => setPaths((m) => ({ ...m, [o.name]: e.target.value }))}
                        placeholder="选择或输入工程绝对路径"
                        className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 font-mono placeholder-zinc-600 outline-none focus:border-blue-500"
                      />
                    )}
                    {v === "copy" && (
                      <div className="space-y-1.5 pt-0.5">
                        <div className="text-[10px] text-zinc-500 font-mono truncate" title={srcPathOf(o.name)}>源：{srcPathOf(o.name) || "(未在工程列表找到该工程路径)"}</div>
                        <div className="flex items-center gap-1.5">
                          <input
                            value={copyDest[o.name] || ""}
                            onChange={(e) => setCopyDest((m) => ({ ...m, [o.name]: e.target.value }))}
                            placeholder="选择或输入目标父目录"
                            className="flex-1 bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 font-mono placeholder-zinc-600 outline-none focus:border-emerald-500"
                          />
                          <button type="button" onClick={() => chooseDest(o.name)}
                            className="shrink-0 text-[11px] px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 transition" title="浏览选择目标父目录">📁 选择</button>
                        </div>
                        <input
                          value={copyName[o.name] ?? `${o.name}_副本`}
                          onChange={(e) => setCopyName((m) => ({ ...m, [o.name]: e.target.value }))}
                          placeholder="新文件夹名"
                          className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 font-mono placeholder-zinc-600 outline-none focus:border-emerald-500"
                        />
                        <div className="text-[10px] text-zinc-600">复制到 目标父目录\新文件夹名（跳过 build/node_modules 等可再生目录，保留 .git 与源码）。复制可能较慢，请耐心等。</div>
                      </div>
                    )}
                  </div>
                );
              })}
              <div className="text-[10px] text-zinc-600">下拉里已被其他故事点占用 / 路径不存在的工程置灰不可选；分支以彩色徽标高亮显示。</div>
            </div>
          )}
        </div>

        <div className="shrink-0 px-4 py-3 border-t border-zinc-800 flex items-center gap-2">
          <span className="text-[10px] text-zinc-600">应用后将更新该故事点的工程配置并强制打开；接管的工程会与占用方共用，注意避免改混。</span>
          <button onClick={onCancel} disabled={busy} className="ml-auto text-[12px] px-3 py-1.5 rounded text-zinc-400 hover:text-zinc-200 transition">取消</button>
          <button onClick={apply} disabled={busy} className="text-[12px] px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white transition">
            {busy ? "应用中…" : "应用并打开"}
          </button>
        </div>
      </div>

      {pickerFor && (
        <FolderPickerModal
          title="选择目标父目录"
          initialPath={copyDest[pickerFor] || ""}
          onPick={(p) => setCopyDest((m) => ({ ...m, [pickerFor]: p }))}
          onClose={() => setPickerFor(null)}
        />
      )}
    </div>
  );
}
