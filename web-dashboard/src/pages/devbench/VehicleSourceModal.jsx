/**
 * 车型源码配置弹窗 —— 车型 → 应用[] → 仓库[]{git分支, flavor}。
 * 应用来自 TB「应用分类」；仓库来自「工程配置」的仓库定义；同一应用可挂多个仓库(同仓库不同分支亦可)。
 * 用于「远程拉取」模式按需 clone 多个仓库并切分支。车型与仓库定义写入 SQLite 共享配置，克隆父路径仅存本机。
 */
import React, { useEffect, useRef, useState } from "react";
import { devbenchApi } from "./api.js";
import { authenticatedFetch, useAdminSession } from "../../services/adminAuth.js";
import { ADMIN_AUTH_CHANGED_EVENT, createGatewayWebSocket, getApiUrl } from "../../services/gateway.js";
import RemoteBranchSelect from "./RemoteBranchSelect.jsx";
import {
  createInitialVehiclePresetPublicationPlan,
  createVehiclePublicationPreview,
  describeVehicleAutomaticDiscovery,
  describeVehiclePublicationTarget,
  describeVehicleSyncConnection,
  normalizeVehicleSyncPeerOrigin,
  resolveVehicleSourceAccess,
  retainUnpublishedFlavors,
} from "./vehicleSourceAdminState.mjs";

// === 车型源码配置缓存：模块级内存 Map + localStorage，重开弹窗不重新加载 ===
// 按 projectId 缓存 { cfg, repos, appOptions, ts }，打开即用缓存渲染、后台再刷新。
const VEHICLE_CFG_CACHE_KEY = "devbench_vehicle_source_cache_v1";
const vehicleCfgMemory = new Map(); // projectId -> { cfg, repos, appOptions, ts }
let vehicleCfgMemoryLoaded = false;
function loadVehicleCfgMemory() {
  if (vehicleCfgMemoryLoaded) return;
  vehicleCfgMemoryLoaded = true;
  try {
    const raw = localStorage.getItem(VEHICLE_CFG_CACHE_KEY);
    if (raw) {
      const obj = JSON.parse(raw) || {};
      for (const [k, v] of Object.entries(obj)) vehicleCfgMemory.set(k, v);
    }
  } catch { /* ignore */ }
}
function saveVehicleCfgMemory(projectId, patch) {
  loadVehicleCfgMemory();
  const prev = vehicleCfgMemory.get(projectId) || {};
  const next = { ...prev, ...patch, ts: Date.now() };
  vehicleCfgMemory.set(projectId, next);
  try {
    const obj = {};
    for (const [k, v] of vehicleCfgMemory.entries()) obj[k] = v;
    localStorage.setItem(VEHICLE_CFG_CACHE_KEY, JSON.stringify(obj));
  } catch { /* ignore */ }
}
function readVehicleCfgMemory(projectId) {
  loadVehicleCfgMemory();
  return vehicleCfgMemory.get(projectId) || null;
}

// 单个车型：apps[{appName, repos[{repoId,branch,flavor}]}]
function MappingRow({ flavor, value, repos, appOptions, onSave, onDraft, onDelete, onDirty, busy, canEdit, canPublish, unpublished }) {
  const [apps, setApps] = useState(() => (value?.apps || []).map((a) => ({ appName: a.appName || "", repos: (a.repos || []).map((r) => ({ ...r })) })));
  const [prodDir, setProdDir] = useState(() => value?.prodReleaseDir || "");
  const [needsResign, setNeedsResign] = useState(() => !!value?.needsResign);
  const [editing, setEditing] = useState(() => !(value?.apps || []).length && !value?.prodReleaseDir);
  const [locallyDirty, setLocallyDirty] = useState(false);
  const repoName = (id) => repos.find((d) => d.id === id)?.name || id;

  useEffect(() => {
    if (locallyDirty) return;
    setApps((value?.apps || []).map((a) => ({ appName: a.appName || "", repos: (a.repos || []).map((r) => ({ ...r })) })));
    setProdDir(value?.prodReleaseDir || "");
    setNeedsResign(!!value?.needsResign);
  }, [value, locallyDirty]);

  useEffect(() => {
    if (!canEdit) setEditing(false);
  }, [canEdit]);

  const markDirty = () => {
    if (!canEdit) return;
    setLocallyDirty(true);
    onDirty?.(flavor, true);
  };
  const setApp = (ai, patch) => { markDirty(); setApps((xs) => xs.map((a, i) => (i === ai ? { ...a, ...patch } : a))); };
  const addApp = () => { markDirty(); setApps((xs) => [...xs, { appName: appOptions[0] || "", repos: [] }]); };
  const delApp = (ai) => { markDirty(); setApps((xs) => xs.filter((_, i) => i !== ai)); };
  const setRepo = (ai, ri, patch) => { markDirty(); setApps((xs) => xs.map((a, i) => i === ai ? { ...a, repos: a.repos.map((r, j) => (j === ri ? { ...r, ...patch } : r)) } : a)); };
  const addRepo = (ai) => { markDirty(); setApps((xs) => xs.map((a, i) => i === ai ? { ...a, repos: [...a.repos, { repoId: repos[0]?.id || "", branch: "", flavor }] } : a)); };
  const delRepo = (ai, ri) => { markDirty(); setApps((xs) => xs.map((a, i) => i === ai ? { ...a, repos: a.repos.filter((_, j) => j !== ri) } : a)); };

  function currentMapping() {
    const clean = apps.map((a) => ({ appName: a.appName, repos: a.repos.filter((r) => r.repoId) })).filter((a) => a.appName || a.repos.length);
    return { apps: clean, prodReleaseDir: prodDir.trim(), needsResign };
  }

  async function doSave() {
    if (!canPublish) return;
    await onSave(flavor, currentMapping());
  }

  async function doDraft() {
    if (!canEdit) return;
    await onDraft(flavor, currentMapping());
  }

  if (!editing || !canEdit) {
    return (
      <div className="border border-zinc-800 rounded-lg px-2.5 py-1.5 flex items-start gap-2 bg-zinc-800/20">
        <span className="text-[11px] text-fuchsia-300 font-mono bg-zinc-950/60 border border-fuchsia-800/40 rounded px-2 py-0.5 shrink-0 mt-0.5">{flavor}</span>
        <span className="flex-1 text-[11px] text-zinc-400 font-mono space-y-0.5">
          {apps.length ? apps.map((a, i) => (
            <div key={i} className="truncate">
              <span className="text-zinc-300">{a.appName || "(未命名应用)"}</span>：
              {a.repos.length ? a.repos.map((r, j) => <span key={j}>{j > 0 ? "，" : ""}{repoName(r.repoId)}<span className="text-indigo-300">@{r.branch || "—"}</span>{r.flavor && r.flavor !== flavor ? `(${r.flavor})` : ""}</span>) : <span className="text-zinc-600">无仓库</span>}
            </div>
          )) : <span className="text-zinc-600">未配置应用</span>}
          <div className="truncate text-[10px]">
            <span className="text-zinc-500">生产发布目录：</span>
            {prodDir ? <span className="text-emerald-300/90" title={prodDir}>{prodDir}</span> : <span className="text-zinc-600">未设置</span>}
            <span className="ml-2 text-zinc-500">重新签名：</span>
            {needsResign ? <span className="text-amber-300">需要（消息标 _未签名、不@人）</span> : <span className="text-zinc-600">不需要</span>}
          </div>
        </span>
        {canEdit
          ? <>
              <button onClick={() => setEditing(true)} disabled={busy} className="px-2.5 py-1 text-[11px] rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-100 shrink-0">配置</button>
              <button onClick={() => onDelete(flavor)} disabled={busy} className="px-2 py-1 text-[11px] rounded bg-zinc-800 hover:bg-red-600/30 text-zinc-500 hover:text-red-300 shrink-0">删除</button>
            </>
          : <span className="text-[10px] text-zinc-600 shrink-0">🔒 只读</span>}
      </div>
    );
  }

  return (
    <div className="border border-zinc-700 rounded-lg p-2.5 space-y-2 bg-zinc-800/30">
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-fuchsia-300 font-mono bg-zinc-950/60 border border-fuchsia-800/40 rounded px-2 py-0.5">{flavor}</span>
        <span className="text-[10px] text-zinc-500">车型 / 默认 flavor</span>
        {unpublished && <span className="rounded border border-amber-700/50 bg-amber-950/30 px-1.5 py-0.5 text-[10px] text-amber-300">未发布</span>}
        <div className="ml-auto flex items-center gap-1.5">
          {!!(value?.apps || []).length && <button onClick={() => setEditing(false)} disabled={busy} className="px-2 py-1 text-[11px] rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400">收起</button>}
          <button onClick={doDraft} disabled={busy || !canEdit} className="px-2.5 py-1 text-[11px] rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-100 disabled:opacity-60">{busy ? "…" : "保存草稿"}</button>
          <button onClick={doSave} disabled={busy || !canPublish} className="px-2.5 py-1 text-[11px] rounded bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-60">{busy ? "…" : "预览并发布"}</button>
          <button onClick={() => onDelete(flavor)} disabled={busy || !canPublish} className="px-2 py-1 text-[11px] rounded bg-zinc-800 hover:bg-red-600/30 text-zinc-500 hover:text-red-300">删除</button>
        </div>
      </div>

      {apps.map((a, ai) => (
        <div key={ai} className="border border-zinc-800 rounded-lg p-2 space-y-1.5 bg-zinc-900/40">
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-zinc-500 w-10 shrink-0">应用</span>
            <select value={a.appName} onChange={(e) => setApp(ai, { appName: e.target.value })}
              className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-[11px] text-zinc-200 outline-none">
              <option value="">— 选择应用 —</option>
              {appOptions.map((n) => <option key={n} value={n}>{n}</option>)}
              {a.appName && !appOptions.includes(a.appName) && <option value={a.appName}>{a.appName}</option>}
            </select>
            <button onClick={() => addRepo(ai)} disabled={!repos.length} className="text-[11px] px-2 py-1 rounded bg-zinc-800 border border-zinc-700 text-zinc-300 hover:bg-zinc-700 disabled:opacity-50 shrink-0">＋ 添加仓库</button>
            <button onClick={() => delApp(ai)} className="px-1.5 py-1 text-[11px] rounded bg-zinc-800 hover:bg-red-600/30 text-zinc-500 hover:text-red-300 shrink-0">删应用</button>
          </div>
          {a.repos.map((r, ri) => (
            <div key={ri} className="flex items-center gap-2 pl-12">
              <select value={r.repoId} onChange={(e) => setRepo(ai, ri, { repoId: e.target.value })}
                className="w-28 shrink-0 bg-zinc-800 border border-zinc-700 rounded px-1.5 py-1 text-[11px] text-zinc-200 outline-none">
                {!repos.length && <option value="">无仓库</option>}
                {repos.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
              <RemoteBranchSelect key={r.repoId} repo={r.repoId} value={r.branch} onChange={(b) => setRepo(ai, ri, { branch: b })} placeholder="选择远程分支" />
              <input value={r.flavor ?? ""} onChange={(e) => setRepo(ai, ri, { flavor: e.target.value })}
                placeholder="flavor" title="默认与车型同名"
                className="w-24 shrink-0 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-[11px] text-zinc-200 placeholder-zinc-600 outline-none font-mono" />
              <button onClick={() => delRepo(ai, ri)} className="px-1.5 py-1 text-[11px] rounded bg-zinc-800 hover:bg-red-600/30 text-zinc-500 hover:text-red-300 shrink-0">×</button>
            </div>
          ))}
          {!a.repos.length && <p className="text-[10px] text-zinc-600 pl-12">点「＋ 添加仓库」为该应用关联仓库+分支</p>}
        </div>
      ))}
      <button onClick={addApp} disabled={!appOptions.length && !apps.length} className="text-[11px] px-2 py-1 rounded bg-emerald-700/40 border border-emerald-700/50 text-emerald-200 hover:bg-emerald-700/60">＋ 添加应用</button>
      {!repos.length && <p className="text-[10px] text-amber-500/80">还没有仓库定义，请先在「工程配置」里添加仓库。</p>}

      {/* 生产发布目录：每车型一个，「发布生产」时 prod release 包+mapping 拷到此处（UNC/本地均可，局域网同步） */}
      <div className="border-t border-zinc-800 pt-2 mt-1">
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-zinc-400 w-16 shrink-0">生产发布目录</span>
          <input value={prodDir} onChange={(e) => { markDirty(); setProdDir(e.target.value); }}
            placeholder="基目录 \\192.168.200.108\PtzjShare\CarBox\Geely\E22H-GP（或含 Temp_日期 的完整目录）"
            className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-[11px] text-zinc-200 placeholder-zinc-600 outline-none font-mono" />
        </div>
        <p className="text-[10px] text-zinc-600 pl-[4.5rem] mt-0.5">填<b>基目录</b>会自动补成 <code className="text-zinc-500">基目录\&lt;本周五YYYY-MMDD&gt;\Temp_&lt;今天YYYYMMDD&gt;</code>；若直接填到含 <code className="text-zinc-500">Temp_日期</code> 的<b>完整目录</b>则原样使用。「发布生产」把 prod release 包 + mapping 压缩包拷进去、更新 ReadMe.txt 并钉钉通知。</p>
        <label className="flex items-center gap-1.5 text-[10px] text-zinc-400 mt-1.5 pl-[0.1rem] cursor-pointer">
          <input type="checkbox" checked={needsResign} onChange={(e) => { markDirty(); setNeedsResign(e.target.checked); }} className="accent-amber-500" />
          需要重新签名（默认不需要）：勾选后「发布生产」钉钉消息版本号带 <code className="text-amber-300">_未签名</code> 后缀、且<b>不 @付浩/张明</b>
        </label>
      </div>
    </div>
  );
}

export default function VehicleSourceModal({
  projectId,
  projectDefs,
  applicationOptions,
  repositorySubscriptions,
  onClose,
  onToast,
  embedded = false,
  onDirtyChange,
}) {
  // 权限只取全局已验证会话。父组件历史布尔值不再覆盖共享真相。
  const adminSession = useAdminSession();
  const { canRead, canEdit, canPublish, canResolve, canRetry } = resolveVehicleSourceAccess(adminSession);
  const canManageLanPeers = adminSession.isAdmin && adminSession.canMutate;
  // 初始化时优先用缓存：有缓存则即时渲染、不闪空状态，后台再刷新
  const cachedOnMount = readVehicleCfgMemory(projectId);
  const [cfg, setCfg] = useState(() => cachedOnMount?.cfg ?? null);
  const [repos, setRepos] = useState(() => cachedOnMount?.repos ?? []);       // 仓库定义
  const [appOptions, setAppOptions] = useState(() => cachedOnMount?.appOptions ?? []); // TB 应用分类
  const [cloneParent, setCloneParent] = useState(() => cachedOnMount?.cfg?.cloneParent ?? "");
  const [newFlavor, setNewFlavor] = useState("");
  const [busy, setBusy] = useState("");
  const [appErr, setAppErr] = useState("");
  const [loadError, setLoadError] = useState("");
  const [importMode, setImportMode] = useState("merge");
  const [dirtyFlavors, setDirtyFlavors] = useState(() => new Set());
  const [publicationPreview, setPublicationPreview] = useState(null);
  const [publication, setPublication] = useState(null);
  const [initialPresetReport, setInitialPresetReport] = useState(null);
  const [remoteNotice, setRemoteNotice] = useState(null);
  const [conflicts, setConflicts] = useState([]);
  const [lanPeerHost, setLanPeerHost] = useState("");
  const [lanPeerResult, setLanPeerResult] = useState(null);
  const fileInputRef = useRef(null);
  const dirtyFlavorsRef = useRef(dirtyFlavors);
  const publicationRef = useRef(publication);
  const canEditRef = useRef(canEdit);
  const canResolveRef = useRef(canResolve);
  const canPublishRef = useRef(canPublish);
  const previewSequenceRef = useRef(0);
  const publishingRef = useRef(false);
  const publicationTarget = describeVehiclePublicationTarget(cfg?.sync);
  const syncConnection = describeVehicleSyncConnection(cfg?.sync);
  const automaticDiscovery = describeVehicleAutomaticDiscovery(cfg?.sync);

  useEffect(() => { dirtyFlavorsRef.current = dirtyFlavors; }, [dirtyFlavors]);
  useEffect(() => { publicationRef.current = publication; }, [publication]);
  useEffect(() => { canEditRef.current = canEdit; }, [canEdit]);
  useEffect(() => { canResolveRef.current = canResolve; }, [canResolve]);
  useEffect(() => { canPublishRef.current = canPublish; }, [canPublish]);
  useEffect(() => { onDirtyChange?.(dirtyFlavors.size > 0); }, [dirtyFlavors, onDirtyChange]);
  useEffect(() => {
    if (!Array.isArray(projectDefs)) return;
    setRepos(projectDefs);
    saveVehicleCfgMemory(projectId, { repos: projectDefs });
  }, [projectDefs, projectId]);
  useEffect(() => {
    if (!Array.isArray(applicationOptions)) return;
    setAppOptions(applicationOptions);
    saveVehicleCfgMemory(projectId, { appOptions: applicationOptions });
  }, [applicationOptions, projectId]);

  const reload = async () => {
    const r = await devbenchApi.getRemoteConfig(projectId);
    if (r.ok) {
      setLoadError("");
      setCfg(r.data);
      setCloneParent(r.data.cloneParent || "");
      saveVehicleCfgMemory(projectId, { cfg: r.data });
    } else {
      // 缓存只用于首屏加速，权威来源失败后不能继续把旧快照展示成最新配置。
      setCfg(null);
      setLoadError(r.error || "车型配置权威来源读取失败");
    }
    return r;
  };
  const reloadConflicts = async () => {
    if (!canResolveRef.current) return [];
    const result = await devbenchApi.getVehicleConfigConflicts();
    if (result.ok && canResolveRef.current) {
      const rows = result.data || [];
      setConflicts(rows);
      return rows;
    }
    return null;
  };
  useEffect(() => {
    setInitialPresetReport(null);
    reload();
    devbenchApi.getProjectDefs().then((r) => {
      if (r.ok) { setRepos(r.data || []); saveVehicleCfgMemory(projectId, { repos: r.data || [] }); }
    });
    devbenchApi.getAppCategories(false, projectId).then((r) => {
      if (r.ok) { setAppOptions(r.data || []); saveVehicleCfgMemory(projectId, { appOptions: r.data || [] }); setAppErr(""); }
      else setAppErr(r.error || "");
    });
  }, [projectId]); // eslint-disable-line

  useEffect(() => {
    if (!canResolve) {
      setConflicts([]);
      return;
    }
    reloadConflicts();
  }, [canResolve, projectId]); // eslint-disable-line

  useEffect(() => {
    if (!canPublish) {
      previewSequenceRef.current += 1;
      setPublicationPreview(null);
    }
  }, [canPublish]);

  useEffect(() => {
    let ws;
    let stopped = false;
    let reconnectTimer = null;
    const connect = () => {
      if (stopped) return;
      try { ws = createGatewayWebSocket(); }
      catch {
        reconnectTimer = setTimeout(connect, 1500);
        return;
      }
      ws.onmessage = (event) => {
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.type === "shared_config_changed"
          && (message.data?.projectIds || []).includes(projectId)) {
          if (dirtyFlavorsRef.current.size) setRemoteNotice(message.data);
          else { reload(); reloadConflicts(); }
        }
        if (message.type === "shared_config_delivery_changed"
          && message.data?.changeSetId === publicationRef.current?.changeSetId) {
          setPublication((current) => ({ ...(current || {}), ...message.data }));
        }
        if (message.type === "shared_config_conflicts_changed") reloadConflicts();
      };
      ws.onclose = () => { if (!stopped) reconnectTimer = setTimeout(connect, 1500); };
    };
    const reconnectForAuth = () => {
      try { ws?.close(); } catch {}
      if (!stopped && !reconnectTimer) reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, 0);
    };
    connect();
    window.addEventListener(ADMIN_AUTH_CHANGED_EVENT, reconnectForAuth);
    return () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      window.removeEventListener(ADMIN_AUTH_CHANGED_EVENT, reconnectForAuth);
      try { ws?.close(); } catch {}
    };
  }, [projectId]); // eslint-disable-line

  function updateDirty(flavor, dirty) {
    setDirtyFlavors((current) => {
      const next = new Set(current);
      dirty ? next.add(flavor) : next.delete(flavor);
      return next;
    });
  }

  async function connectLanPeer() {
    if (!canManageLanPeers || busy === "lan-peer") return;
    const normalized = normalizeVehicleSyncPeerOrigin(lanPeerHost);
    if (!normalized.ok) {
      setLanPeerResult({ ok: false, message: normalized.error });
      return;
    }
    setBusy("lan-peer");
    setLanPeerResult({ ok: true, pending: true, message: `正在连接 ${normalized.origin}…` });
    try {
      const response = await authenticatedFetch(getApiUrl("/api/discovery/peers"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host: normalized.origin }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) {
        throw new Error(result.error || `连接失败（HTTP ${response.status}）`);
      }
      const probe = result.meta?.probe || null;
      if (probe && !probe.reachable) {
        setLanPeerResult({
          ok: false,
          message: `地址已保存，但当前无法访问 ${normalized.origin}；请检查地址、端口和网络后重试。`,
        });
        return;
      }
      if (probe && ["invalid-advertisement", "different-group", "discovery-info-invalid", "self"].includes(probe.reason)) {
        setLanPeerResult({
          ok: false,
          message: `目标可达，但没有可加入的车型同步组（${probe.reason}）。请确认对方管理员已发布车型配置。`,
        });
        return;
      }

      let latest = null;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        latest = await reload();
        if (latest.ok && (Number(latest.data?.sync?.connectedPeers) > 0
          || (latest.data?.sync?.members || []).some((member) => member.online))) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      const connected = latest?.ok && (Number(latest.data?.sync?.connectedPeers) > 0
        || (latest.data?.sync?.members || []).some((member) => member.online));
      const message = connected
        ? `已连接 ${probe?.nodeName || normalized.origin}，车型配置已刷新。`
        : `已登记 ${normalized.origin}，正在等待加密同步连接；页面会在配置到达时自动刷新。`;
      setLanPeerResult({ ok: true, message });
      onToast?.(message);
    } catch (error) {
      setLanPeerResult({ ok: false, message: error.message || "局域网 Gateway 连接失败" });
    } finally {
      setBusy("");
    }
  }

  function requestClose() {
    if (dirtyFlavors.size && !confirm(`还有 ${dirtyFlavors.size} 个车型改动未发布，确认关闭？`)) return;
    onClose();
  }

  async function saveParent() {
    setBusy("parent");
    const r = await devbenchApi.updateRemoteConfig({ cloneParent }, projectId);
    setBusy("");
    if (r.ok) { onToast?.("克隆父路径已保存"); setCfg(r.data); saveVehicleCfgMemory(projectId, { cfg: r.data }); } else onToast?.(r.error || "保存失败");
  }

  async function previewInitialPresets() {
    if (!cfg || !canEditRef.current || !canPublishRef.current || busy) return;
    setBusy("initialize");
    setInitialPresetReport(null);
    const scanned = await devbenchApi.previewVehicleInitialPresets(projectId, repositorySubscriptions);
    if (!scanned.ok) {
      setBusy("");
      setInitialPresetReport({ ...(scanned.report || {}), error: scanned.error || "初始预置扫描失败" });
      onToast?.(scanned.error || "初始预置扫描失败");
      return;
    }
    const report = scanned.data?.report || {};
    setInitialPresetReport(report);
    const plan = createInitialVehiclePresetPublicationPlan({
      currentMap: cfg?.vehicleMap || {},
      generatedMap: scanned.data?.vehicleMap || {},
      configSpace: cfg?.sync?.teamConfigSpace,
      projectId,
      revision: cfg?.revision,
      entityRevisions: cfg?.sync?.entityRevisions || {},
    });
    if (!plan.request.changes.length) {
      setBusy("");
      onToast?.(report.generatedVehicles
        ? "扫描完成，现有自定义配置已包含全部候选，无需发布"
        : "扫描完成，目标分支中没有发现可生成的车型配置");
      return;
    }
    const preview = await devbenchApi.previewVehicleConfigPublication(plan.request);
    setBusy("");
    if (!preview.ok) { onToast?.(preview.error || "初始预置发布预览失败"); return; }
    if (!canEditRef.current || !canPublishRef.current) return;
    setPublicationPreview(createVehiclePublicationPreview(
      { ...preview.data, initialPresetReport: report },
      preview.data?.publicationRequest || plan.request,
      () => globalThis.crypto?.randomUUID?.()
        || `vehicle-initial-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    ));
    setDirtyFlavors((current) => new Set([...current, ...plan.changedFlavors]));
    onToast?.(`已生成 ${plan.changedFlavors.length} 个车型候选，请检查预览后确认发布`);
  }
  function publicationBody(flavor, mapping, action = "set") {
    return {
      configSpace: cfg?.sync?.teamConfigSpace,
      projectId,
      baseRevision: String(cfg?.revision || "0"),
      changes: [{
        flavor,
        action,
        mapping: action === "delete" ? null : mapping,
        baseRevision: cfg?.sync?.entityRevisions?.[flavor] || "0",
      }],
    };
  }

  async function saveDraft(flavor, mapping) {
    if (!canEditRef.current) return false;
    setBusy(flavor);
    const r = await devbenchApi.saveVehicleConfigDraft(
      `vehicle-${projectId}-${flavor}`,
      publicationBody(flavor, mapping),
    );
    setBusy("");
    onToast?.(r.ok ? `草稿已保存：${flavor}（${publicationTarget.draftSuffix}）` : (r.error || "草稿保存失败"));
    return r.ok;
  }

  async function previewMapping(flavor, mapping, action = "set") {
    if (!canPublishRef.current) return false;
    const sequence = ++previewSequenceRef.current;
    setBusy(flavor);
    const body = publicationBody(flavor, mapping, action);
    const r = await devbenchApi.previewVehicleConfigPublication(body);
    setBusy((current) => current === flavor ? "" : current);
    if (sequence !== previewSequenceRef.current || !canPublishRef.current) return false;
    if (!r.ok) { onToast?.(r.error || "预览失败"); return false; }
    setPublicationPreview(createVehiclePublicationPreview(
      r.data,
      r.data?.publicationRequest || body,
      () => globalThis.crypto?.randomUUID?.()
        || `vehicle-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    ));
    return true;
  }

  async function confirmPublication() {
    if (!canPublishRef.current || !publicationPreview?.request || publishingRef.current) return;
    const preview = publicationPreview;
    publishingRef.current = true;
    setBusy("publish");
    const r = await devbenchApi.publishVehicleConfig({
      ...preview.request,
      idempotencyKey: preview.idempotencyKey,
    });
    publishingRef.current = false;
    setBusy("");
    if (!canPublishRef.current) return;
    if (!r.ok) { onToast?.(r.error || "发布失败"); return; }
    setPublication(r.data);
    setPublicationPreview(null);
    setDirtyFlavors((current) => retainUnpublishedFlavors(current, preview.request.changes));
    setRemoteNotice(null);
    await reload();
    await reloadConflicts();
    onToast?.(r.data?.noOp
      ? "配置未变化，无需发布"
      : `${publicationTarget.committedMessage || (r.data?.publicationScope === "local" ? "已发布到当前服务" : "已发布到团队")}：变更集 ${r.data?.changeSetId || ""}`);
  }

  async function syncNow() {
    if (!canRead || busy) return;
    setBusy("sync");
    try {
      const result = await devbenchApi.syncVehicleSourceConfig(projectId);
      if (!result.ok) {
        onToast?.(result.error || "主动同步失败");
        return;
      }
      const conflictRows = await reloadConflicts();
      if (dirtyFlavorsRef.current.size) {
        setRemoteNotice({ manualSync: true, requestId: result.data?.requestId });
      } else {
        await reload();
      }
      const conflictCount = Math.max(
        Number(result.data?.conflictCount) || 0,
        Array.isArray(conflictRows) ? conflictRows.length : 0,
      );
      if (result.data?.requestedPeers > 0) {
        onToast?.(`已向 ${result.data.requestedPeers} 个在线节点发起双向增量同步${conflictCount ? `，发现 ${conflictCount} 个并发冲突` : ""}`);
      } else if (result.data?.status === "waiting-for-publisher") {
        onToast?.("已广播主动发现请求，等待局域网内已发布节点响应");
      } else {
        onToast?.("已唤醒局域网同步；当前节点离线，上线后将自动续传");
      }
    } finally {
      setBusy("");
    }
  }

  async function deleteMapping(flavor) {
    if (!canPublishRef.current) return;
    if (!confirm(`预览删除车型预置「${flavor}」？确认发布前不会影响团队配置。`)) return;
    updateDirty(flavor, true);
    await previewMapping(flavor, null, "delete");
  }

  async function resolveConflict(conflict, mapping, label) {
    if (!canResolveRef.current) return;
    if (!confirm(`确认${label}并发布冲突解决操作？该操作会同步到所有团队节点。`)) return;
    setBusy(`conflict:${conflict.conflictId}`);
    const r = await devbenchApi.resolveVehicleConfigConflict(conflict.conflictId, {
      mapping,
      idempotencyKey: globalThis.crypto?.randomUUID?.() || `resolve-${Date.now()}`,
    });
    setBusy("");
    if (!r.ok) { onToast?.(r.error || "冲突处理失败"); return; }
    setPublication(r.data);
    await reload();
    await reloadConflicts();
    onToast?.("冲突解决操作已发布");
  }
  function addFlavor() {
    if (!canEditRef.current) return;
    const f = newFlavor.trim();
    if (!f) return;
    if (cfg?.vehicleMap?.[f]) { onToast?.("该车型已存在"); return; }
    setCfg((c) => ({ ...c, vehicleMap: { ...(c?.vehicleMap || {}), [f]: { apps: [] } } }));
    updateDirty(f, true);
    setNewFlavor("");
  }

  async function exportConfig() {
    setBusy("export");
    const r = await devbenchApi.exportVehicleSourceConfig(projectId);
    setBusy("");
    if (!r.ok) { onToast?.(r.error || "导出失败"); return; }
    const data = r.data || {};
    const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `devbench-vehicle-source-${projectId || "default"}-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    onToast?.(`已导出 ${Object.keys(data.vehicleMap || {}).length} 个车型配置`);
  }

  async function importFile(file) {
    if (!file || !canEditRef.current || !canPublishRef.current) return;
    if (file.size > 1024 * 1024) { onToast?.("导入文件超过 1 MiB 上限"); return; }
    let data;
    try { data = JSON.parse(await file.text()); } catch { onToast?.("导入文件不是有效 JSON"); return; }
    if ((data?.type && data.type !== "devbench-vehicle-source-config") || Number(data?.version || 1) !== 1) {
      onToast?.("导入文件类型或版本不受支持");
      return;
    }
    const importedMap = data?.vehicleMap || data?.config?.vehicleMap || {};
    const count = Object.keys(importedMap).length;
    if (!count) { onToast?.("导入文件未包含车型配置"); return; }
    const ok = confirm(`${importMode === "replace" ? "替换" : "合并"}导入 ${count} 个车型配置？${importMode === "replace" ? "\n当前未出现在导入文件中的车型会被删除。" : ""}`);
    if (!ok) return;
    setBusy("import");
    const changes = Object.entries(importedMap).map(([flavor, mapping]) => ({
      flavor,
      action: "set",
      mapping,
      baseRevision: cfg?.sync?.entityRevisions?.[flavor] || "0",
    }));
    if (importMode === "replace") {
      for (const flavor of Object.keys(cfg?.vehicleMap || {})) {
        if (Object.hasOwn(importedMap, flavor)) continue;
        changes.push({
          flavor,
          action: "delete",
          mapping: null,
          baseRevision: cfg?.sync?.entityRevisions?.[flavor] || "0",
        });
      }
    }
    const request = {
      configSpace: cfg?.sync?.teamConfigSpace,
      projectId,
      baseRevision: String(cfg?.revision || "0"),
      changes,
      projectDefs: Array.isArray(data?.projectDefs)
        ? data.projectDefs.map((definition) => ({ action: "set", definition }))
        : [],
    };
    const r = await devbenchApi.previewVehicleConfigPublication(request);
    setBusy("");
    if (!r.ok) { onToast?.(r.error || "导入失败"); return; }
    if (!canEditRef.current || !canPublishRef.current) return;
    setPublicationPreview(createVehiclePublicationPreview(
      r.data,
      r.data?.publicationRequest || request,
      () => globalThis.crypto?.randomUUID?.()
        || `vehicle-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    ));
    setDirtyFlavors(new Set(changes.map((row) => row.flavor)));
    onToast?.(`已完成 ${changes.length} 项导入 dry-run，请在预览中确认后原子发布`);
  }

  const flavors = cfg ? Object.keys(cfg.vehicleMap || {}) : [];
  return (
    <div className={embedded ? "contents" : "fixed inset-0 z-[60] flex items-center justify-center bg-black/70"}>
      <div className={embedded ? "contents" : "bg-zinc-900 border border-zinc-700 rounded-xl w-[820px] max-h-[88vh] flex flex-col shadow-2xl"} onClick={(e) => e.stopPropagation()}>
        {!embedded && <div className="px-5 py-4 border-b border-zinc-800 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-zinc-100">车型源码配置</h2>
            <p className="text-[11px] text-zinc-500 mt-0.5">车型 → 应用 → 仓库+分支。应用来自 TB「应用分类」，仓库来自「工程配置」。同一应用可挂多个仓库。</p>
          </div>
          <button onClick={requestClose} className="text-zinc-500 hover:text-zinc-200 text-lg leading-none">✕</button>
        </div>}

        <div className={embedded ? "space-y-4" : "flex-1 overflow-y-auto px-5 py-4 space-y-4"}>
          {embedded && (
            <div className="rounded-xl border border-fuchsia-900/40 bg-fuchsia-950/10 px-3 py-2.5 text-[11px] leading-relaxed text-fuchsia-100/85">
              按车型维护应用、仓库、远程分支、默认 flavor 与生产发布设置；仓库候选来自同一工程配置面板中的“仓库定义”。
            </div>
          )}
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2 text-[10px]">
            <span className="text-zinc-500">运行 profile</span><span className="font-mono text-zinc-300">{cfg?.sync?.runtimeProfile || "—"}</span>
            <span className="text-zinc-500">同步团队</span><span className="font-mono text-zinc-300 truncate">{cfg?.sync?.teamConfigSpace || "—"}</span>
            <span className="text-zinc-500">配置来源</span><span className={`font-mono truncate ${syncConnection.state === "connected" || syncConnection.state === "center" ? "text-emerald-300" : syncConnection.state === "offline" || syncConnection.state === "disconnected" ? "text-amber-300" : "text-zinc-300"}`}>{syncConnection.label}</span>
            <span className="text-zinc-500">本机同步角色</span><span className="font-mono text-cyan-300">{cfg?.sync?.localSyncMode || cfg?.sync?.syncMode || "—"} · {cfg?.sync?.localNodeName || cfg?.sync?.nodeName || cfg?.sync?.localNodeId || cfg?.sync?.nodeId || "—"}</span>
            <div className="col-span-2 mt-1 flex min-w-0 items-center justify-between gap-3 border-t border-zinc-800 pt-2">
              <span className="min-w-0 text-zinc-500">主动发现在线节点，并按版本向量双向补齐增量；并发异值会进入冲突列表。</span>
              <button
                type="button"
                data-testid="vehicle-source-sync-now"
                onClick={syncNow}
                disabled={!canRead || !!busy}
                aria-busy={busy === "sync"}
                className="shrink-0 rounded border border-cyan-800/70 bg-cyan-950/40 px-2.5 py-1 text-[10px] text-cyan-200 hover:bg-cyan-900/50 disabled:cursor-not-allowed disabled:opacity-45"
              >
                {busy === "sync" ? "同步中…" : "立即同步"}
              </button>
            </div>
          </div>

          {syncConnection.canConnect && (
            <div data-testid="vehicle-lan-auto-discovery" className="rounded-lg border border-cyan-900/50 bg-cyan-950/15 px-3 py-2.5">
              <div className="flex min-w-0 items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[11px] font-medium text-cyan-200">{automaticDiscovery.label}</p>
                  <p className="mt-1 text-[10px] leading-relaxed text-zinc-500">
                    {automaticDiscovery.detail} {syncConnection.detail}
                  </p>
                </div>
                <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[9px] ${syncConnection.state === "connected"
                  ? "border-emerald-800/70 bg-emerald-950/30 text-emerald-300"
                  : "border-cyan-800/60 bg-cyan-950/30 text-cyan-300"}`}>
                  {syncConnection.state === "connected" ? "已同步" : "后台运行"}
                </span>
              </div>
              {canManageLanPeers && (
                <details data-testid="vehicle-lan-peer-recovery" className="mt-2 border-t border-cyan-950/80 pt-2">
                  <summary className="cursor-pointer select-none text-[10px] text-zinc-500 hover:text-zinc-300">
                    高级恢复：仅在部署引导节点不可用时手工登记
                  </summary>
                  <div data-testid="vehicle-lan-peer-connect" className="mt-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        type="url"
                        data-testid="vehicle-lan-peer-origin"
                        value={lanPeerHost}
                        onChange={(event) => setLanPeerHost(event.target.value)}
                        onKeyDown={(event) => { if (event.key === "Enter") void connectLanPeer(); }}
                        placeholder="http://192.168.10.110:3001"
                        aria-label="高级恢复 Gateway 地址"
                        className="min-w-[260px] flex-1 rounded border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 font-mono text-[11px] text-zinc-200 outline-none focus:border-cyan-700"
                      />
                      <button
                        type="button"
                        data-testid="vehicle-lan-peer-connect-submit"
                        onClick={connectLanPeer}
                        disabled={busy === "lan-peer"}
                        className="rounded bg-cyan-700 px-3 py-1.5 text-[11px] text-white hover:bg-cyan-600 disabled:opacity-50"
                      >{busy === "lan-peer" ? "连接中…" : "登记并重试"}</button>
                    </div>
                    <p className="mt-1.5 text-[10px] leading-relaxed text-zinc-600">
                      地址只提交给当前 Gateway；远端浏览器登录态不会跨机器复用，后续同步仍由设备签名和加密通道完成。
                    </p>
                    {lanPeerResult?.message && (
                      <p className={`mt-1.5 text-[10px] ${lanPeerResult.pending ? "text-cyan-300" : lanPeerResult.ok ? "text-emerald-300" : "text-red-300"}`}>
                        {lanPeerResult.message}
                      </p>
                    )}
                  </div>
                </details>
              )}
            </div>
          )}

          {loadError && (
            <div className="rounded-lg border border-red-800/60 bg-red-950/25 px-3 py-2 text-[11px] text-red-200">
              无法读取车型配置权威来源：{loadError}。已隐藏浏览器缓存中的旧车型列表，避免误认为它是最新配置。
              <button onClick={reload} className="ml-2 rounded bg-red-900/50 px-2 py-0.5 hover:bg-red-800/60">重试</button>
            </div>
          )}

          {!!publicationTarget.notice && (
            <div className={`rounded-lg border px-3 py-2 text-[11px] ${publicationTarget.scope === "read-only"
              ? "border-red-800/60 bg-red-950/20 text-red-200"
              : "border-amber-700/50 bg-amber-950/25 text-amber-200"}`}>
              {publicationTarget.notice}
            </div>
          )}

          {remoteNotice && (
            <div className="rounded-lg border border-amber-700/50 bg-amber-950/30 px-3 py-2 text-[11px] text-amber-200">
              {remoteNotice.manualSync
                ? "主动同步已发起。为保护当前未发布编辑，页面没有自动载入远端增量；请先保存草稿，再刷新并重新预览基线。"
                : "团队配置已在其它节点更新。当前本地编辑未被覆盖；请先保存草稿，再刷新并重新预览基线。"}
              <button onClick={() => { if (!dirtyFlavors.size || confirm("刷新会放弃当前未发布编辑，继续？")) { setDirtyFlavors(new Set()); setRemoteNotice(null); reload(); } }}
                className="ml-2 rounded bg-amber-800/50 px-2 py-0.5 hover:bg-amber-700/60">刷新</button>
            </div>
          )}

          {publication && (
            <div className="rounded-lg border border-emerald-800/50 bg-emerald-950/20 px-3 py-2 text-[10px] text-zinc-300">
              变更集 <code className="text-emerald-300">{publication.changeSetId}</code>：
              本机已应用 {publication.applied || 1}，待投递 {publication.pending || 0}，离线 {publication.offline || 0}，
              冲突 {publication.conflict || 0}，失败 {publication.failed || 0}
              {((publication.offline || 0) + (publication.failed || 0)) > 0 && (
                <button onClick={async () => {
                  if (!canRetry) return;
                  const r = await devbenchApi.retryVehicleConfigPublication(publication.changeSetId);
                  if (r.ok) setPublication(r.data);
                  else onToast?.(r.error || "重试失败");
                }} disabled={!canRetry} className="ml-2 rounded bg-zinc-700 px-2 py-0.5 hover:bg-zinc-600 disabled:opacity-40">重试投递</button>
              )}
            </div>
          )}

          {!!conflicts.length && (
            <div className="rounded-lg border border-red-800/60 bg-red-950/20 px-3 py-2">
              <div className="text-[11px] font-medium text-red-200">待处理并发冲突 {conflicts.length}</div>
              <div className="mt-2 space-y-2">
                {conflicts.map((conflict) => (
                  <div key={conflict.conflictId} className="flex items-center gap-2 rounded border border-red-900/50 bg-zinc-950/40 px-2 py-1.5 text-[10px]">
                    <code className="min-w-0 flex-1 truncate text-zinc-300">{conflict.entityKey}</code>
                    <span className="text-zinc-600">{conflict.localRevision?.slice(0, 8)} ↔ {conflict.remoteRevision?.slice(0, 8)}</span>
                    <button
                      onClick={() => resolveConflict(conflict, conflict.localPayload, "保留本机值")}
                      disabled={!canResolve || busy === `conflict:${conflict.conflictId}`}
                      className="rounded bg-zinc-700 px-2 py-1 text-zinc-200 hover:bg-zinc-600 disabled:opacity-50">
                      保留本机
                    </button>
                    <button
                      onClick={() => resolveConflict(conflict, conflict.remotePayload, "采用对端值")}
                      disabled={!canResolve || busy === `conflict:${conflict.conflictId}`}
                      className="rounded bg-red-800/60 px-2 py-1 text-red-100 hover:bg-red-700/70 disabled:opacity-50">
                      采用对端
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 克隆父路径（人人可改，本机路径） */}
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-zinc-400 w-24 shrink-0">克隆父路径</span>
            <input value={cloneParent} onChange={(e) => setCloneParent(e.target.value)}
              data-testid="vehicle-source-clone-parent"
              placeholder="选择或输入克隆父目录"
              className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-[11px] text-zinc-200 placeholder-zinc-600 outline-none font-mono" />
            <button type="button" onClick={() => setCloneParent(cfg?.defaultCloneParent || "")}
              data-testid="vehicle-source-clone-parent-default"
              disabled={!cfg?.defaultCloneParent || busy === "parent"}
              title={cfg?.defaultCloneParent ? `设置为本机默认克隆父路径：${cfg.defaultCloneParent}` : "默认克隆父路径不可用"}
              className="px-2.5 py-1 text-[11px] rounded border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 disabled:opacity-45">默认</button>
            <button onClick={saveParent} disabled={busy === "parent"} className="px-2.5 py-1 text-[11px] rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-100 disabled:opacity-60">保存</button>
          </div>
          <p className="text-[10px] text-zinc-600 -mt-2 ml-24">克隆路径规则：父路径\&lt;车型&gt;\&lt;年月&gt;\&lt;仓库名&gt;-&lt;TB单号&gt;。</p>

          {/* 车型映射列表 */}
          <div className="border border-zinc-800 rounded-lg px-3 py-2 bg-zinc-950/30 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] font-medium text-zinc-300">导入 / 导出</span>
              <span className="text-[10px] text-zinc-600">仅车型源码配置，可跨设备使用 JSON 文件迁移</span>
              <button onClick={exportConfig} disabled={busy === "export"} className="ml-auto px-2.5 py-1 text-[11px] rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 disabled:opacity-60">导出配置</button>
              {canEdit && canPublish && <button onClick={() => fileInputRef.current?.click()} disabled={busy === "import"} className="px-2.5 py-1 text-[11px] rounded bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-60">导入配置</button>}
              <input
                ref={fileInputRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; importFile(file); }}
              />
            </div>
            {canEdit && canPublish && (
              <div className="flex flex-wrap items-center gap-2 text-[10px] text-zinc-400">
                <span className="text-zinc-500">导入方式</span>
                <button onClick={() => setImportMode("merge")} className={`px-2 py-0.5 rounded border ${importMode === "merge" ? "border-blue-500 bg-blue-950/40 text-blue-200" : "border-zinc-700 bg-zinc-800 text-zinc-400"}`}>合并</button>
                <button onClick={() => setImportMode("replace")} className={`px-2 py-0.5 rounded border ${importMode === "replace" ? "border-blue-500 bg-blue-950/40 text-blue-200" : "border-zinc-700 bg-zinc-800 text-zinc-400"}`}>替换</button>
                <span className="ml-2 text-zinc-600">先 dry-run，确认后将车型及其依赖仓库定义作为单个变更集发布；本机克隆/发布路径不会传播。</span>
              </div>
            )}
          </div>

          <div className="space-y-2.5">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-medium text-zinc-300">车型 → 应用 → 仓库+分支预置</span>
              {appErr && <span className="text-[10px] text-amber-500/80">（应用分类未拉取：{appErr}）</span>}
              {canEdit && (
                <button
                  type="button"
                  data-testid="vehicle-source-generate-initial-presets"
                  onClick={previewInitialPresets}
                  disabled={!cfg || !!busy || !canPublish}
                  title={canPublish
                    ? "扫描仓库订阅中的应用市场远程 release/*、v202605-ui、v202601 分支，并进入批量发布预览"
                    : "当前身份没有车型配置发布权限"}
                  className="sm:ml-auto rounded border border-fuchsia-800/60 bg-fuchsia-950/30 px-2.5 py-1 text-[10px] text-fuchsia-200 hover:bg-fuchsia-900/40 disabled:cursor-not-allowed disabled:opacity-50"
                >{busy === "initialize" ? "正在扫描远程分支…" : "根据仓库订阅生成初始预置"}</button>
              )}
              {!canEdit && <span className="text-[10px] text-zinc-500 ml-auto">🔒 当前身份无车型配置编辑权限</span>}
            </div>
            {initialPresetReport && (
              <div
                data-testid="vehicle-source-initial-preset-report"
                className={`break-words rounded border px-2.5 py-2 text-[10px] leading-relaxed ${initialPresetReport.error ? "border-red-900/60 bg-red-950/20 text-red-300" : "border-zinc-800 bg-zinc-950/40 text-zinc-400"}`}
              >
                {initialPresetReport.error ? initialPresetReport.error : (
                  <>
                    已按 {initialPresetReport.subscribedApplications || 0} 个应用、{initialPresetReport.subscribedRepositories || 0} 个仓库订阅扫描；
                    匹配远程分支 {initialPresetReport.matchedBranches || 0} 个，发现配置分支 {initialPresetReport.configBranches || 0} 个，
                    生成车型 {initialPresetReport.generatedVehicles || 0} 个 / 映射 {initialPresetReport.generatedMappings || 0} 条。
                    {!!initialPresetReport.skippedRepositories?.length && (
                      <span className="ml-1 text-zinc-500">其它仓库继续支持下方手工添加映射。</span>
                    )}
                    {!!initialPresetReport.warnings?.length && (
                      <div className="mt-1 text-amber-400">扫描警告：{initialPresetReport.warnings.slice(0, 3).join("；")}</div>
                    )}
                  </>
                )}
              </div>
            )}
            {flavors.length === 0 && <div className="text-[11px] text-zinc-600 py-2">{canEdit ? "还没有车型预置，下方添加一个（如 avatr8678、geelye22）。" : "管理员还没有配置车型预置。"}</div>}
            {flavors.map((f) => (
              <MappingRow
                key={`${f}:${cfg?.sync?.entityRevisions?.[f] || "draft"}`}
                flavor={f}
                value={cfg.vehicleMap[f]}
                repos={repos}
                appOptions={appOptions}
                onSave={previewMapping}
                onDraft={saveDraft}
                onDelete={deleteMapping}
                onDirty={updateDirty}
                busy={busy === f}
                canEdit={canEdit}
                canPublish={canPublish}
                unpublished={!cfg?.sync?.entityRevisions?.[f]}
              />
            ))}
          </div>

          {/* 新增车型（仅管理员） */}
          {canEdit && (
            <div className="flex items-center gap-2 pt-2 border-t border-zinc-800">
              <input value={newFlavor} onChange={(e) => setNewFlavor(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") addFlavor(); }}
                placeholder="新增车型名（也是默认 flavor，如 avatr8678）"
                className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-[11px] text-zinc-200 placeholder-zinc-600 outline-none font-mono" />
              <button onClick={addFlavor} className="px-2.5 py-1 text-[11px] rounded bg-emerald-600 hover:bg-emerald-500 text-white">＋添加车型</button>
            </div>
          )}
        </div>

        {!embedded && <div className="px-5 py-3 border-t border-zinc-800 flex justify-between items-center">
          <span className="text-[10px] text-zinc-600">预置后，新建「远程拉取」故事点选该车型即自动带出应用+仓库+分支。</span>
          <button onClick={requestClose} className="px-4 py-1.5 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300">完成</button>
        </div>}
      </div>

      {publicationPreview && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70">
          <div className="w-[620px] max-h-[75vh] overflow-y-auto rounded-xl border border-zinc-700 bg-zinc-900 p-5 shadow-2xl">
            <h3 className="text-sm font-semibold text-zinc-100">{publicationTarget.heading}</h3>
            <p className="mt-1 text-[11px] text-zinc-500">
              配置空间 <code>{publicationPreview.configSpace}</code>，
              {publicationTarget.scope === "local"
                ? " 当前服务本地提交，"
                : publicationTarget.scope === "center"
                  ? ` 中心 ${cfg?.sync?.sourceHost || "Gateway"}，`
                  : ` 目标成员 ${publicationPreview.members?.length || 0}，`}
              现有冲突 {publicationPreview.existingConflicts?.length || 0}
            </p>
            {!!publicationPreview.conflicts?.length && (
              <div className="mt-3 rounded border border-red-800/60 bg-red-950/30 p-2 text-[11px] text-red-200">
                检测到 {publicationPreview.conflicts.length} 个基线冲突，请刷新后重试，当前不可发布。
              </div>
            )}
            {publicationPreview.initialPresetReport && (
              <div data-testid="vehicle-source-initial-preset-preview" className="mt-3 rounded border border-fuchsia-900/50 bg-fuchsia-950/20 p-2.5 text-[10px] text-zinc-300">
                <div className="font-medium text-fuchsia-200">仓库订阅扫描结果</div>
                <div className="mt-1 text-zinc-400">
                  远程匹配 {publicationPreview.initialPresetReport.matchedBranches || 0} 个分支，
                  {publicationPreview.initialPresetReport.configBranches || 0} 个分支含车型配置；
                  将提交 {publicationPreview.request?.changes?.length || 0} 个车型的追加变更，现有自定义项不会删除或覆盖。
                </div>
                <div className="mt-2 max-h-32 space-y-1 overflow-y-auto font-mono text-zinc-400">
                  {(publicationPreview.request?.changes || []).map((change) => (
                    <div key={change.flavor} className="break-all">
                      <span className="text-fuchsia-300">{change.flavor}</span>
                      {": "}
                      {(change.mapping?.apps || []).flatMap((application) => (
                        (application.repos || []).map((repository) => `${application.appName || "(未命名应用)"} → ${repository.repoId}@${repository.branch}`)
                      )).join("；")}
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="mt-3 space-y-2 text-[11px]">
              {[
                ["新增", publicationPreview.diff?.added, "text-emerald-300"],
                ["修改", publicationPreview.diff?.modified, "text-blue-300"],
                ["删除", publicationPreview.diff?.deleted, "text-red-300"],
              ].map(([label, rows, color]) => (
                <div key={label}>
                  <span className={color}>{label} {rows?.length || 0}</span>
                  {!!rows?.length && <span className="ml-2 font-mono text-zinc-400">{rows.map((row) => row.flavor).join("、")}</span>}
                </div>
              ))}
              <div className="text-zinc-500">无实际变化 {publicationPreview.diff?.noOp || 0}</div>
              <div className="text-zinc-400">依赖仓库定义 {publicationPreview.projectDefChanges?.length || 0}</div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setPublicationPreview(null)} className="rounded bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700">取消</button>
              <button onClick={confirmPublication}
                disabled={!canPublish || busy === "publish" || !!publicationPreview.conflicts?.length}
                className="rounded bg-blue-600 px-3 py-1.5 text-xs text-white hover:bg-blue-500 disabled:opacity-50">
                {busy === "publish" ? "发布中…" : "确认发布"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
