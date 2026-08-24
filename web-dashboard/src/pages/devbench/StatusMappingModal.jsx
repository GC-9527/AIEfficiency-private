/**
 * TB 状态映射设置弹窗 —— 把工作流的"逻辑状态"映射到当前 TB 项目 taskflow 的真实状态名。
 * 不同项目状态命名各异（如"修复中"可能叫"处理中/开发中"），配了优先用、未配回退内置同义词。
 * 真实状态名从该项目 taskflow 拉取；映射值仅管理员可改，团队共享、按 TB 项目隔离。
 */
import React, { useEffect, useState } from "react";
import { devbenchApi } from "./api.js";
import { useIsAdmin } from "../../services/adminAuth.js";

// 逻辑状态 + 各自在工作流里的用途说明
const LOGICALS = [
  { key: "待处理", hint: "新建/待办（执行开发的起点）" },
  { key: "待确认", hint: "点执行开发/开始甄别后流转到此（已认领）" },
  { key: "修复中", hint: "甄别确认是本侧问题后流转" },
  { key: "可提测", hint: "修复完成后流转" },
  { key: "已拒绝", hint: "确认非本侧问题后流转" },
];

export default function StatusMappingModal({ projectId, onClose, onToast }) {
  const { isAdmin } = useIsAdmin();
  const [statuses, setStatuses] = useState([]);   // [{id,name}] 该项目真实状态
  const [mapping, setMapping] = useState({});     // { 逻辑状态: 真实状态名 }
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  const loadStatuses = async () => {
    setLoading(true); setErr("");
    const r = await devbenchApi.getTaskflowStatuses(projectId);
    setLoading(false);
    if (r.ok) setStatuses(r.data || []);
    else setErr((r.error || "拉取状态失败") + (r.needLogin ? "（需 TB 登录）" : ""));
  };
  useEffect(() => {
    loadStatuses();
    devbenchApi.getStatusMapping(projectId).then((r) => { if (r.ok) setMapping(r.data || {}); });
  }, [projectId]); // eslint-disable-line

  async function onSet(logical, realName) {
    setMapping((m) => ({ ...m, [logical]: realName }));
    const r = await devbenchApi.setStatusMapping(logical, realName, projectId);
    if (!r.ok) { onToast?.(r.error || "保存失败"); devbenchApi.getStatusMapping(projectId).then((x) => { if (x.ok) setMapping(x.data || {}); }); }
    else onToast?.(realName ? `已映射「${logical}」→「${realName}」` : `已清除「${logical}」的映射`);
  }

  const names = statuses.map((s) => s.name);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70" onClick={onClose}>
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl w-[680px] max-h-[88vh] flex flex-col shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-zinc-800 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-zinc-100">TB 状态映射设置</h2>
            <p className="text-[11px] text-zinc-500 mt-0.5">把工作流逻辑状态映射到当前 TB 项目的真实状态名。配了优先用，未配回退内置同义词。</p>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200 text-lg leading-none">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          <div className="flex items-center gap-2">
            <button onClick={loadStatuses} disabled={loading}
              className="text-[11px] px-2 py-0.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-300 hover:bg-zinc-700 disabled:opacity-60">
              {loading ? "拉取中…" : "↻ 拉取该项目状态"}
            </button>
            <span className="text-[10px] text-zinc-500">
              {statuses.length ? `该项目 taskflow 共 ${statuses.length} 个状态` : "未拉到状态"}
            </span>
            {err && <span className="text-[11px] text-red-400">{err}</span>}
          </div>
          {!loading && !statuses.length && (
            <div className="text-[10px] text-amber-400/90 leading-relaxed">
              没拉到状态，常见原因：① 未做 TB「一键登录」（开放平台常不暴露 taskflow 状态，需 Cookie 兜底）；② 当前 TB 项目 id 不对（projectId=<span className="font-mono">{projectId || "(空)"}</span>）。
              请到「设置 → Teambition」一键登录后重试；仍为空时看网关日志 <span className="font-mono">teambition</span> 行。
            </div>
          )}
          {statuses.length > 0 && (
            <div className="text-[10px] text-zinc-600">可选真实状态：{names.join(" / ")}</div>
          )}
          {!isAdmin && <p className="text-[11px] text-zinc-500">普通成员只读；映射仅管理员可改。</p>}

          <div className="grid grid-cols-[110px_1fr] gap-2 text-[10px] text-zinc-500 px-1">
            <span>逻辑状态</span><span>对应该项目的真实状态</span>
          </div>
          <div className="space-y-1.5">
            {LOGICALS.map((l) => {
              const cur = mapping[l.key] || "";
              return (
                <div key={l.key} className="grid grid-cols-[110px_1fr] gap-2 items-center">
                  <div className="text-[12px] text-zinc-200">
                    {l.key}
                    <div className="text-[10px] text-zinc-600 leading-tight">{l.hint}</div>
                  </div>
                  <select value={cur} disabled={!isAdmin} onChange={(e) => onSet(l.key, e.target.value)}
                    className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-[12px] text-zinc-200 outline-none disabled:opacity-60">
                    <option value="">（未配置 · 用内置同义词）</option>
                    {cur && !names.includes(cur) && <option value={cur}>{cur}（当前·不在状态列表）</option>}
                    {names.map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </div>
              );
            })}
          </div>
          <p className="text-[10px] text-zinc-600 leading-relaxed">
            提示：若工作流提示“找不到与「修复中」匹配的状态”，在这里把「修复中」选成该项目里对应的真实状态即可。
          </p>
        </div>

        <div className="px-5 py-3 border-t border-zinc-800 flex justify-end">
          <button onClick={onClose} className="px-4 py-1.5 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300">完成</button>
        </div>
      </div>
    </div>
  );
}
