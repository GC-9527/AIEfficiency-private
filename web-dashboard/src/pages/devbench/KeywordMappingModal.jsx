/**
 * 关键词映射设置弹窗 —— 把 TB 单里的标题、项目、迭代、标签、附件名和评论关键词
 * 映射到应用、车型、仓库、分支或 Flavor，供训练与执行开发时推理工程配置。
 */
import React, { useEffect, useState } from "react";
import { devbenchApi } from "./api.js";
import { useIsAdmin } from "../../services/adminAuth.js";
import { keywordGovernanceStatus } from "./aiTrainingGovernanceModel.mjs";

const GROUPS = [
  { key: "title", label: "标题关键词映射", hint: "训练/执行开发时从 TB 单标题命中，也可手动新增", syncable: false },
  { key: "project", label: "项目关键词映射", hint: "TB 单「项目>任务列表」（如 平台组件>阿维塔_8678平台_应用市场）", syncable: true },
  { key: "iteration", label: "迭代关键词映射", hint: "TB 单对应的迭代（Sprint）", syncable: true },
  { key: "tag", label: "标签映射", hint: "TB 单的标签", syncable: true },
  { key: "attachment", label: "附件关键词映射", hint: "训练/执行开发时从 TB 单附件名命中", syncable: false },
  { key: "comment", label: "评论关键词映射", hint: "训练/执行开发时从 TB 单评论内容命中", syncable: false },
];

function uniqueOptions(options = []) {
  const result = [];
  const seen = new Set();
  for (const option of options) {
    const value = String(option?.value ?? option ?? "").trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push({ value, label: String(option?.label || value).trim() || value });
  }
  return result;
}

function optionsFromRemoteConfig(config = {}) {
  const projectDefs = Array.isArray(config.projectDefs) ? config.projectDefs : [];
  const vehicleMap = config.vehicleMap && typeof config.vehicleMap === "object" ? config.vehicleMap : {};
  const applications = [];
  const vehicles = [];
  const repositories = projectDefs.map((def) => ({
    value: def?.id,
    label: def?.name && def.name !== def.id ? `${def.name}（${def.id}）` : def?.id,
  }));
  const branches = [];
  const flavors = [];

  for (const [vehicle, mapping] of Object.entries(vehicleMap)) {
    vehicles.push(vehicle);
    const apps = Array.isArray(mapping?.apps) ? mapping.apps : [];
    for (const app of apps) {
      applications.push(app?.appName);
      for (const repo of (Array.isArray(app?.repos) ? app.repos : [])) {
        const repositoryId = repo?.repoId || repo?.projectId;
        if (repositoryId) repositories.push(repositoryId);
        branches.push(repo?.branch);
        flavors.push(repo?.flavor);
      }
    }
    for (const entry of (Array.isArray(mapping?.entries) ? mapping.entries : [])) {
      const repositoryId = entry?.projectId || entry?.repoId;
      if (repositoryId) repositories.push(repositoryId);
      branches.push(entry?.branch);
      flavors.push(entry?.flavor);
    }
  }

  return {
    app: uniqueOptions(applications),
    vehicle: uniqueOptions(vehicles),
    repository: uniqueOptions(repositories),
    branch: uniqueOptions(branches),
    flavor: uniqueOptions(flavors),
  };
}

function Section({ g, data, targetOptions, isAdmin, onSync, onSet, onDel, defaultOpen }) {
  const [open, setOpen] = useState(defaultOpen);
  const [syncing, setSyncing] = useState(false);
  const [q, setQ] = useState("");
  const [newKey, setNewKey] = useState("");
  const keys = Object.keys(data || {}).filter((k) => k.toLowerCase().includes(q.trim().toLowerCase()));
  const suggestionCount = Object.values(data || {}).filter((mapping) => keywordGovernanceStatus(mapping) === "suggestion").length;
  async function sync() { setSyncing(true); await onSync(g.key); setSyncing(false); }
  async function addKey() {
    const key = newKey.trim();
    if (!key || Object.prototype.hasOwnProperty.call(data || {}, key)) return;
    await onSet(g.key, key, "", "", { status: "draft", origin: "manual" });
    setNewKey("");
  }
  return (
    <div className="border border-zinc-800 rounded-lg">
      <div className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-zinc-800/40" onClick={() => setOpen((v) => !v)}>
        <span className={`text-zinc-500 transition-transform ${open ? "rotate-90" : ""}`}>▸</span>
        <span className="text-[12px] font-medium text-zinc-200">{g.label}</span>
        <span className="text-[10px] text-zinc-600">{g.hint}</span>
        <span className="text-[10px] text-zinc-500">（{Object.keys(data || {}).length}）</span>
        {suggestionCount ? <span className="rounded border border-amber-900/60 bg-amber-950/25 px-1.5 py-0.5 text-[8px] text-amber-300">待审批 {suggestionCount}</span> : null}
        {isAdmin && g.syncable && <button onClick={(e) => { e.stopPropagation(); sync(); }} disabled={syncing} className="ml-auto text-[11px] px-2 py-0.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-300 hover:bg-zinc-700 disabled:opacity-60">{syncing ? "同步中…" : "↻ 同步 TB"}</button>}
      </div>
      {open && (
        <div className="px-3 pb-3 space-y-1.5">
          {Object.keys(data || {}).length > 8 && (
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="过滤 key…" className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-[11px] text-zinc-200 placeholder-zinc-600 outline-none" />
          )}
          {isAdmin && (
            <div className="flex items-center gap-2">
              <input value={newKey} onChange={(e) => setNewKey(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addKey(); } }} placeholder="手动新增规则 key" className="min-w-0 flex-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-[11px] text-zinc-200 placeholder-zinc-600 outline-none" />
              <button onClick={addKey} disabled={!newKey.trim() || Object.prototype.hasOwnProperty.call(data || {}, newKey.trim())} className="shrink-0 text-[11px] px-2 py-1 rounded bg-cyan-800/60 border border-cyan-700/60 text-cyan-100 hover:bg-cyan-700/60 disabled:cursor-not-allowed disabled:opacity-40">＋ 新增规则</button>
            </div>
          )}
          <div className="grid grid-cols-[minmax(120px,1fr)_72px_104px_minmax(120px,1fr)_auto] gap-2 text-[10px] text-zinc-500 px-1">
            <span>规则 key</span><span>状态</span><span>映射维度</span><span>目标值</span><span></span>
          </div>
          <div className="max-h-[40vh] overflow-auto space-y-1">
            {!keys.length && <div className="text-[11px] text-zinc-600 py-2">{Object.keys(data || {}).length ? "无匹配" : g.syncable ? "同步 TB 或手动新增规则" : "请手动新增规则 key"}</div>}
            {keys.map((k) => {
              const m = data[k] || {};
              const opts = targetOptions[m.category] || [];
              const governanceStatus = keywordGovernanceStatus(m);
              return (
                <div key={k} className="grid grid-cols-[minmax(120px,1fr)_72px_104px_minmax(120px,1fr)_auto] gap-2 items-center">
                  <span className="text-[11px] text-zinc-300 font-mono truncate" title={k}>{k}</span>
                  <span className={`rounded border px-1.5 py-1 text-center text-[8px] ${governanceStatus === "active" ? "border-emerald-900/60 bg-emerald-950/25 text-emerald-300" : governanceStatus === "approved" ? "border-cyan-900/60 bg-cyan-950/25 text-cyan-300" : governanceStatus === "revoked" ? "border-rose-900/60 bg-rose-950/25 text-rose-300" : "border-amber-900/60 bg-amber-950/25 text-amber-300"}`}>
                    {governanceStatus === "active" ? "已生效" : governanceStatus === "approved" ? "已审批" : governanceStatus === "revoked" ? "已撤销" : "suggestion"}
                  </span>
                  <select value={m.category || ""} disabled={!isAdmin} onChange={(e) => onSet(g.key, k, e.target.value, "", { status: "suggestion", origin: m.origin || "review" })}
                    className="bg-zinc-800 border border-zinc-700 rounded px-1 py-1 text-[11px] text-zinc-200 outline-none disabled:opacity-60">
                    <option value="">—</option>
                    <option value="app">应用</option>
                    <option value="vehicle">车型</option>
                    <option value="repository">仓库</option>
                    <option value="branch">分支</option>
                    <option value="flavor">Flavor</option>
                  </select>
                  <select value={m.value || ""} disabled={!isAdmin || !m.category} onChange={(e) => onSet(g.key, k, m.category, e.target.value, { status: e.target.value ? "active" : "suggestion", origin: m.origin || "manual_review" })}
                    className="bg-zinc-800 border border-zinc-700 rounded px-1 py-1 text-[11px] text-zinc-200 outline-none disabled:opacity-60">
                    <option value="">{m.category ? "— 选择 —" : "先选类别"}</option>
                    {m.value && !opts.some((option) => option.value === m.value) && <option value={m.value}>{m.value}</option>}
                    {opts.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                  {isAdmin && <button onClick={() => onDel(g.key, k)} className="px-1.5 py-1 text-[11px] rounded bg-zinc-800 hover:bg-red-600/30 text-zinc-500 hover:text-red-300">删</button>}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export default function KeywordMappingModal({ projectId, onClose, onToast }) {
  const { isAdmin } = useIsAdmin();
  const [data, setData] = useState(null);
  const [targetOptions, setTargetOptions] = useState({ app: [], vehicle: [], repository: [], branch: [], flavor: [] });

  const load = () => devbenchApi.getKeywordMappings(projectId).then((r) => { if (r.ok) setData(r.data); });
  useEffect(() => {
    load();
    devbenchApi.getRemoteConfig(projectId).then((r) => { if (r.ok) setTargetOptions(optionsFromRemoteConfig(r.data)); });
  }, [projectId]); // eslint-disable-line

  async function onSync(group) {
    const r = await devbenchApi.syncKeywordGroup(group, projectId);
    if (r.ok) { onToast?.(`同步完成，新增 ${r.data.added} 个（共 ${r.data.total}）`); await load(); }
    else onToast?.((r.error || "同步失败") + (r.needLogin ? "（需 TB 登录）" : ""));
  }
  async function onSet(group, key, category, value, governance = {}) {
    // 乐观更新
    setData((d) => ({ ...(d || {}), [group]: { ...(d?.[group] || {}), [key]: { category, value, ...(governance || {}) } } }));
    const r = await devbenchApi.setKeywordMapping(group, key, category, value, projectId, governance);
    if (!r.ok) { onToast?.(r.error || "保存失败"); await load(); }
    else if (category && value) onToast?.("关键词 suggestion 已人工批准并映射；是否进入 serving 以 Gateway 治理状态为准");
  }
  async function onDel(group, key) {
    if (!window.confirm(`确认撤销关键词「${key}」吗？治理版会保留历史，不应物理抹除审计记录。`)) return;
    setData((d) => { const g = { ...(d?.[group] || {}) }; delete g[key]; return { ...(d || {}), [group]: g }; });
    const result = await devbenchApi.deleteKeywordMapping(group, key, projectId);
    if (!result.ok) {
      onToast?.(result.error || "撤销失败");
      await load();
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70" onClick={onClose}>
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl w-[820px] max-h-[88vh] flex flex-col shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-zinc-800 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-zinc-100">关键词映射设置</h2>
            <p className="text-[11px] text-zinc-500 mt-0.5">自动采集的原始字符串只显示为 suggestion；人工选择维度和值后才成为已批准映射。一次性标题、评论和附件名不应未经审批直接进入 serving。</p>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200 text-lg leading-none">✕</button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-2">
          {!isAdmin && <p className="text-[11px] text-zinc-500">普通成员只读；映射值仅管理员可修正。</p>}
          {data && GROUPS.map((g, i) => (
            <Section key={g.key} g={g} data={data[g.key]} targetOptions={targetOptions} isAdmin={isAdmin}
              onSync={onSync} onSet={onSet} onDel={onDel} defaultOpen={i === 0} />
          ))}
        </div>
        <div className="px-5 py-3 border-t border-zinc-800 flex justify-end">
          <button onClick={onClose} className="px-4 py-1.5 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300">完成</button>
        </div>
      </div>
    </div>
  );
}
