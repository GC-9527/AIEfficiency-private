/**
 * 工程配置弹窗 —— 应用工程配置 + 仓库定义 + 车型源码配置。
 * 应用工程配置：应用 → 关联 Git 仓库 → 多个本机路径，路径选定后读取并显示各自分支。
 * 仓库定义：团队共享的仓库元数据（管理员维护）。
 */
import React, { useEffect, useRef, useState } from "react";
import { devbenchApi } from "./api.js";
import { usePermission } from "../../services/adminAuth.js";
import StudioBtn from "./StudioBtn.jsx";
import VehicleSourceModal from "./VehicleSourceModal.jsx";
import WorkspaceBundleEditor from "./WorkspaceBundleEditor.jsx";
import { createProjectConfigCache } from "./projectConfigCache.mjs";
import {
  editableWorkspaceBundle,
  workspaceBundleDraftError,
  workspaceBundlePayload,
} from "./workspaceBundleModel.mjs";

const projectConfigCache = createProjectConfigCache();

// 本机工程级 git 信息缓存：模块级内存 Map + localStorage 持久化。
// 目的：切换 Tab 重新挂载 ProjectGitCell 时立即用缓存渲染，不闪"读取中…"；挂载后再后台刷新保持实时。
const GIT_INFO_CACHE_KEY = "devbench_project_git_info_cache_v1";
const gitInfoMemory = new Map(); // path -> { data, ts }
try {
  const raw = localStorage.getItem(GIT_INFO_CACHE_KEY);
  if (raw) {
    const obj = JSON.parse(raw) || {};
    for (const [k, v] of Object.entries(obj)) gitInfoMemory.set(k, v);
  }
} catch {}
function persistGitInfoCache() {
  try {
    const obj = {};
    for (const [k, v] of gitInfoMemory.entries()) obj[k] = v;
    localStorage.setItem(GIT_INFO_CACHE_KEY, JSON.stringify(obj));
  } catch {}
}
function setGitInfoCache(repoPath, data) {
  gitInfoMemory.set(repoPath, { data, ts: Date.now() });
  persistGitInfoCache();
}
function getGitInfoCache(repoPath) {
  return gitInfoMemory.get(repoPath) || null;
}

// 仓库定义缓存：模块级内存 + localStorage，重开弹窗不闪"仓库定义加载中…"。
const DEFS_CACHE_KEY = "devbench_project_defs_cache_v1";
let defsMemory = null;
try {
  const raw = localStorage.getItem(DEFS_CACHE_KEY);
  if (raw) defsMemory = JSON.parse(raw) || null;
} catch {}
function setDefsCache(defs) {
  defsMemory = defs;
  try { localStorage.setItem(DEFS_CACHE_KEY, JSON.stringify(defs)); } catch {}
}
function getDefsCache() {
  return defsMemory;
}

// 本机工程级分支选择器：按工程路径加载 git 信息，支持搜索本地/远程分支并切换。
// 与故事点 BranchPicker 同口径，但不依赖故事点 tab —— 供本机工程列表切换分支用。
function ProjectBranchPicker({ repoPath, branch, branches, remoteBranches, disabled, onPick, onRefresh }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const inputRef = useRef(null);
  useEffect(() => {
    if (open) {
      const t = setTimeout(() => inputRef.current?.focus(), 10);
      return () => clearTimeout(t);
    }
  }, [open]);
  const ql = q.trim().toLowerCase();
  const matchLocal = (branches || []).filter((b) => b.toLowerCase().includes(ql));
  const matchRemote = (remoteBranches || []).filter((b) => b.toLowerCase().includes(ql));
  const close = () => { setOpen(false); setQ(""); };
  const pick = (b) => {
    close();
    if (b && b !== branch) onPick?.(b);
  };
  return (
    <div className="relative min-w-[150px] max-w-[220px]">
      <button
        type="button"
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        className="w-full flex items-center gap-1.5 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-[11px] hover:border-zinc-500 disabled:opacity-50 transition"
        title={branch || "未检出分支"}
      >
        <span className={`flex-1 text-left font-mono truncate ${branch ? "text-emerald-300" : "text-zinc-500"}`}>{branch || "—"}</span>
        <span className={`text-zinc-500 transition-transform ${open ? "rotate-180" : ""}`}>▾</span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={close} />
          <div className="absolute left-0 top-full mt-1 z-40 w-[280px] max-w-[80vw] bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl">
            <div className="p-1.5 border-b border-zinc-800 flex items-center gap-1">
              <input
                ref={inputRef}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") close();
                  if (e.key === "Enter") {
                    e.preventDefault();
                    const first = matchLocal[0] || matchRemote[0];
                    if (first) pick(first);
                  }
                }}
                placeholder="输入过滤分支（回车选第一个）"
                className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-[11px] text-zinc-100 placeholder-zinc-600 outline-none focus:border-zinc-500 font-mono"
              />
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onRefresh?.(); }}
                title="重新拉取远程分支"
                className="px-1.5 py-1 text-[11px] rounded bg-zinc-800 border border-zinc-700 text-zinc-400 hover:text-zinc-200"
              >↻</button>
            </div>
            <div className="max-h-64 overflow-auto py-1">
              {matchLocal.length > 0 && <div className="px-2 py-0.5 text-[10px] text-zinc-600">本地分支</div>}
              {matchLocal.map((b) => (
                <button
                  key={"l-" + b}
                  type="button"
                  onClick={() => pick(b)}
                  className={`w-full text-left px-2.5 py-1 text-[11px] font-mono truncate hover:bg-zinc-800 transition ${b === branch ? "text-emerald-300 bg-emerald-900/15" : "text-zinc-200"}`}
                  title={b}
                >{b === branch ? "✓ " : ""}{b}</button>
              ))}
              {matchRemote.length > 0 && <div className="px-2 py-0.5 text-[10px] text-zinc-600 mt-1">远程分支（切换将建本地跟踪）</div>}
              {matchRemote.map((b) => (
                <button
                  key={"r-" + b}
                  type="button"
                  onClick={() => pick(b)}
                  className="w-full text-left px-2.5 py-1 text-[11px] font-mono truncate text-indigo-300 hover:bg-zinc-800 transition"
                  title={b}
                >{b}</button>
              ))}
              {!matchLocal.length && !matchRemote.length && <div className="px-2.5 py-2 text-[11px] text-zinc-600">无匹配分支</div>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// 单行工程的 git 分支区：主工程分支 + WebApp 分支 + 拉取远程按钮 + dirty/stash 指示 + Android Studio 打开按钮。
function ProjectGitCell({ repoPath, label, onToast, onChanged }) {
  // 用缓存初始化，避免 Tab 切换重新挂载时闪"读取中…"
  const cached = getGitInfoCache(repoPath);
  const [info, setInfo] = useState(cached?.data || null);
  const [loading, setLoading] = useState(!cached);
  const [switching, setSwitching] = useState(false);
  const [fetching, setFetching] = useState(false);

  const load = async () => {
    if (!repoPath) { setInfo(null); setLoading(false); return; }
    // 已有缓存数据时不闪"读取中…"，仅后台刷新
    setLoading((prev) => prev || !info);
    const r = await devbenchApi.projectGitInfo(repoPath);
    setLoading(false);
    if (r.ok) {
      setInfo(r.data);
      setGitInfoCache(repoPath, r.data);
    } else {
      // 接口失败：清掉缓存，避免显示过期分支
      gitInfoMemory.delete(repoPath);
      try { persistGitInfoCache(); } catch {}
      setInfo(null);
    }
  };
  useEffect(() => {
    // 立即用缓存渲染（已在 useState 初始值里），再后台刷新保持实时
    load(); /* eslint-disable-next-line */
  }, [repoPath]);

  async function doFetch() {
    setFetching(true);
    const r = await devbenchApi.projectGitFetch(repoPath);
    setFetching(false);
    onToast?.(r.ok ? `${label} 已拉取远程分支` : (r.error || "拉取失败"));
    await load();
  }
  async function doCheckout(branch) {
    setSwitching(true);
    let r = await devbenchApi.projectGitCheckout(repoPath, branch);
    if (!r.ok && r.code === "GIT_BRANCH_IN_USE_BY_WORKTREE" && r.data?.canRehome) {
      const owner = r.data.ownerTitle
        ? `${r.data.ownerClosed ? "已关闭故事点" : "故事点"}「${r.data.ownerTitle}」`
        : "另一个 worktree";
      const confirmed = window.confirm(
        `分支「${r.data.branch || branch}」正在被${owner}使用。\n\n`
        + "是否先把该 worktree 迁移到独立 story/ 分支并保留本地修改，然后继续切换工程分支？",
      );
      if (confirmed) {
        r = await devbenchApi.projectGitCheckout(repoPath, branch, {
          rehomeOccupiedWorktree: true,
          confirmation: "迁移并切换",
        });
      }
    }
    setSwitching(false);
    if (!r.ok) { onToast?.(r.error || "切换分支失败"); await load(); return; }
    const migration = r.data.rehome?.storyBranch
      ? `；占用 worktree 已迁移到 ${r.data.rehome.storyBranch}，本地修改已保留`
      : "";
    onToast?.(`${label} 已切到 ${branch}${r.data.stashed ? "（原改动已自动暂存）" : ""}${migration}`);
    await load();
    await onChanged?.();
  }

  if (!repoPath) {
    return <span className="text-[11px] text-zinc-600 italic">无</span>;
  }
  if (loading && !info) return <span className="text-[11px] text-zinc-500">读取中…</span>;
  if (!info) {
    return (
      <span className="text-[11px] text-zinc-600 italic" title="路径不存在或不是 git 仓库">
        非仓库
      </span>
    );
  }
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <ProjectBranchPicker
        repoPath={repoPath}
        branch={info.branch}
        branches={info.branches}
        remoteBranches={info.remoteBranches}
        disabled={switching}
        onPick={doCheckout}
        onRefresh={doFetch}
      />
      {info.repoDefName && (
        <span
          className="text-[10px] text-indigo-300 font-mono truncate max-w-[200px]"
          title={`仓库定义：${info.repoDefName}${info.remoteUrl ? `\n${info.remoteUrl}` : ""}`}
        >📦 {info.repoDefName}</span>
      )}
      {!info.repoDefName && info.remoteUrl && (
        <span
          className="text-[10px] text-zinc-500 font-mono truncate max-w-[260px]"
          title={info.remoteUrl}
        >{info.remoteUrl}</span>
      )}
      {switching && <span className="text-[11px] text-zinc-500">切换中…</span>}
      {fetching && <span className="text-[11px] text-zinc-500">拉取中…</span>}
      {info.dirty && (
        <span className="text-amber-400 text-[11px]" title={`${info.dirtyCount} 处改动（切换会自动暂存，含未跟踪）`}>
          ●{info.dirtyCount}
        </span>
      )}
      {info.hasStashForBranch && (
        <span className="text-red-400 text-[11px] font-bold" title="该分支有未还原的暂存">!</span>
      )}
      <StudioBtn path={repoPath} onToast={onToast} compact />
    </div>
  );
}

// 从路径末段推导显示名：D:\a\b\2026AISdkV4 -> 2026AISdkV4
function deriveName(p) {
  const segs = String(p || "").replace(/[\\/]+$/, "").split(/[\\/]+/).filter(Boolean);
  return segs.length ? segs[segs.length - 1] : "";
}

function normPath(p) {
  return String(p || "").replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
}

function draftId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function hydrateApplicationLayout(applications, projects) {
  const byId = new Map((projects || []).map((project) => [project.id, project]));
  return (applications || []).map((application) => ({
    ...application,
    repositories: (application.repositories || []).map((repository) => ({
      ...repository,
      paths: (repository.projectIds || []).map((projectId) => byId.get(projectId)).filter(Boolean),
    })),
  }));
}

function applicationLayoutPayload(applications) {
  return (applications || []).map((application) => ({
    id: application.id,
    name: String(application.name || "").trim(),
    repositories: (application.repositories || []).map((repository) => ({
      repositoryId: String(repository.repositoryId || "").trim(),
      projectIds: [...new Set((repository.paths || []).map((project) => project.id).filter(Boolean))],
    })),
  }));
}

function refreshApplicationProjects(applications, projects) {
  const byId = new Map((projects || []).map((project) => [project.id, project]));
  return (applications || []).map((application) => ({
    ...application,
    repositories: application.repositories.map((repository) => ({
      ...repository,
      paths: repository.paths.map((project) => (
        project.id && byId.has(project.id) ? { ...project, ...byId.get(project.id) } : project
      )),
    })),
  }));
}

const PROJECT_TYPE_OPTIONS = [
  ["application", "应用工程"],
  ["sdk", "SDK 工程"],
  ["tooling", "脚本/工具工程"],
  ["service", "服务工程"],
  ["repository", "通用仓库"],
];

function listText(value) {
  if (Array.isArray(value)) return value.join(", ");
  return String(value || "");
}

function parseList(value) {
  return [...new Set(String(value || "").split(/[,，;；\n]+/).map((item) => item.trim()).filter(Boolean))];
}

function editableDef(def = {}) {
  return {
    ...def,
    projectType: def.projectType || "application",
    inferenceEnabled: def.inferenceEnabled === true,
    _inferenceKeywordsInput: listText(def.inferenceKeywords),
    _requiresRepositoriesInput: listText(def.requiresRepositories),
    _inheritVariantInput: listText(def.inheritVariant),
    defaultBranch: def.defaultBranch || "",
    defaultFlavor: def.defaultFlavor || "",
    branchOptions: Array.isArray(def.branchOptions) ? def.branchOptions : [],
    flavorOptions: Array.isArray(def.flavorOptions) ? def.flavorOptions : [],
    inferenceOrder: Number(def.inferenceOrder) || 0,
    inferenceRole: def.inferenceRole || "",
    workspaceBundle: editableWorkspaceBundle(def.workspaceBundle, def.id),
  };
}

function emptyDef() {
  return editableDef({ name: "", https: "", ssh: "" });
}

function projectDefPayload(def = {}) {
  return {
    id: def.id,
    name: def.name,
    https: def.https,
    ssh: def.ssh,
    projectType: def.projectType || "application",
    inferenceEnabled: def.inferenceEnabled === true,
    inferenceKeywords: parseList(def._inferenceKeywordsInput ?? def.inferenceKeywords),
    requiresRepositories: parseList(def._requiresRepositoriesInput ?? def.requiresRepositories),
    inheritVariant: parseList(def._inheritVariantInput ?? def.inheritVariant),
    defaultBranch: def.defaultBranch || "",
    defaultFlavor: def.defaultFlavor || "",
    branchOptions: Array.isArray(def.branchOptions) ? def.branchOptions : [],
    flavorOptions: Array.isArray(def.flavorOptions) ? def.flavorOptions : [],
    inferenceOrder: Number(def.inferenceOrder) || 0,
    inferenceRole: def.inferenceRole || "",
    workspaceBundle: workspaceBundlePayload(def.workspaceBundle, def.id),
  };
}

export default function ProjectConfigModal({ projects, projectId, initialTab = "projects", onClose, onChanged }) {
  // 团队仓库定义与车型配置使用同一份后端 capability；历史父级布尔值不再覆盖共享会话。
  const canEditDefinitions = usePermission("vehicle-config:edit");
  const canEditDefinitionsRef = useRef(canEditDefinitions);
  useEffect(() => { canEditDefinitionsRef.current = canEditDefinitions; }, [canEditDefinitions]);
  const normalizedInitialTab = ["projects", "defs", "vehicle"].includes(initialTab) ? initialTab : "projects";
  const cachedLayout = projectConfigCache.read(projectId);
  const [tab, setTab] = useState(normalizedInitialTab); // projects=本机工程列表 | defs=仓库定义 | vehicle=车型源码配置
  const [vehicleVisited, setVehicleVisited] = useState(normalizedInitialTab === "vehicle");
  const [vehicleConfigDirty, setVehicleConfigDirty] = useState(false);
  const [toast, setToast] = useState("");
  function showToast(msg) {
    setToast(msg);
    setTimeout(() => setToast(""), 2400);
  }
  // 运行时仍使用扁平工程列表；本弹窗用 applications 保存“应用 → 仓库 → 多路径”的本机视图。
  const [rows, setRows] = useState(() => (cachedLayout?.rows || projects || []).map((p) => ({ ...p })));
  const [applications, setApplications] = useState(() => cachedLayout?.applications || []);
  // null 表示父面板尚未取得候选，不能用“未知”覆盖车型面板已有的独立缓存；已加载的空数组才是有效真值。
  const [applicationOptions, setApplicationOptions] = useState(() => cachedLayout ? cachedLayout.applicationOptions : null);
  const applicationOptionsRef = useRef(applicationOptions);
  const [layoutLoading, setLayoutLoading] = useState(() => !cachedLayout);
  const [layoutDirty, setLayoutDirty] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [err, setErr] = useState("");
  // 工程定义（来自 TB 应用分类，git 由管理员配）—— 仅管理员可增删改
  // 用缓存初始化，重开弹窗不闪"仓库定义加载中…"；挂载后再后台刷新保持实时。
  const cachedDefs = getDefsCache();
  const [defs, setDefs] = useState(() => cachedDefs ? cachedDefs.map(editableDef) : null);
  const [defAdding, setDefAdding] = useState(() => emptyDef());
  const [defBusy, setDefBusy] = useState(false);
  const loadDefs = () => devbenchApi.getProjectDefs().then((r) => {
    if (r.ok) {
      const mapped = (r.data || []).map(editableDef);
      setDefs(mapped);
      setDefsCache(mapped);
    }
  });
  useEffect(() => { loadDefs(); }, []);
  useEffect(() => {
    const cached = projectConfigCache.read(projectId);
    if (cached) {
      setRows(cached.rows);
      setApplications(cached.applications);
      setApplicationOptions(cached.applicationOptions);
      applicationOptionsRef.current = cached.applicationOptions;
      setLayoutLoading(false);
    }
    reloadProjectLayout({ showLoading: !cached });
    devbenchApi.getAppCategories(false, projectId).then((result) => {
      if (result.ok) {
        const nextOptions = result.data || [];
        setApplicationOptions(nextOptions);
        applicationOptionsRef.current = nextOptions;
        // 候选接口可能比布局接口更早返回；没有完整布局时不创建假的空快照。
        if (projectConfigCache.read(projectId)) {
          projectConfigCache.write(projectId, { applicationOptions: nextOptions });
        }
      }
    });
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  function requestClose() {
    if (vehicleConfigDirty && !confirm("车型源码配置还有未发布改动，确认关闭工程配置？")) return;
    onClose();
  }
  function setDef(idx, field, val) {
    if (!canEditDefinitionsRef.current) return;
    setDefs((ds) => ds.map((d, i) => (i === idx ? { ...d, [field]: val, _dirty: true } : d)));
  }
  async function saveDef(d) {
    if (!canEditDefinitionsRef.current) return;
    if (!d.name?.trim()) { setErr("仓库名不能为空"); return; }
    const bundleError = workspaceBundleDraftError(d.workspaceBundle, defs, d.id);
    if (bundleError) { setErr(bundleError); return; }
    setDefBusy(true); setErr("");
    const r = await devbenchApi.upsertProjectDef(projectDefPayload(d));
    setDefBusy(false);
    if (r.ok) await loadDefs(); else setErr(r.error || "保存仓库失败");
  }
  async function removeDef(d) {
    if (!canEditDefinitionsRef.current) return;
    if (!confirm(`删除仓库「${d.name}」？(车型映射里引用它的条目会失效)`)) return;
    setDefBusy(true); setErr("");
    const r = await devbenchApi.deleteProjectDef(d.id);
    setDefBusy(false);
    if (r.ok) await loadDefs(); else setErr(r.error || "删除失败");
  }
  async function addDef() {
    if (!canEditDefinitionsRef.current) return;
    if (!defAdding.name.trim()) { setErr("工程名称不能为空"); return; }
    setDefBusy(true); setErr("");
    const r = await devbenchApi.upsertProjectDef(projectDefPayload(defAdding));
    setDefBusy(false);
    if (r.ok) { setDefAdding(emptyDef()); await loadDefs(); }
    else setErr(r.error || "添加失败");
  }

  function changeApplicationName(ai, name) {
    const matched = (defs || []).find((definition) => (
      String(definition.name || "").toLowerCase() === String(name || "").trim().toLowerCase()
    ));
    setApplications((items) => items.map((application, index) => {
      if (index !== ai) return application;
      let repositories = application.repositories || [];
      if (matched && !repositories.some((repository) => repository.repositoryId === matched.id)) {
        const emptyIndex = repositories.findIndex((repository) => !repository.repositoryId && !repository.paths.length);
        if (emptyIndex >= 0) {
          repositories = repositories.map((repository, repositoryIndex) => (
            repositoryIndex === emptyIndex
              ? { ...repository, repositoryId: matched.id, _repositoryInput: matched.name }
              : repository
          ));
        } else {
          repositories = [...repositories, {
            repositoryId: matched.id,
            _repositoryInput: matched.name,
            paths: [],
          }];
        }
      }
      return { ...application, name, repositories };
    }));
    setLayoutDirty(true);
  }

  function addApplication() {
    setApplications((items) => [...items, {
      id: draftId("application"),
      name: "",
      repositories: [],
    }]);
    setLayoutDirty(true);
  }

  function removeApplication(ai) {
    const application = applications[ai];
    if (application.repositories.some((repository) => repository.paths.length)) {
      setErr("请先移除该应用下的本机路径，再删除应用");
      return;
    }
    setApplications((items) => items.filter((_, index) => index !== ai));
    setLayoutDirty(true);
  }

  function addRepository(ai) {
    setApplications((items) => items.map((application, index) => index === ai ? {
      ...application,
      repositories: [...application.repositories, { repositoryId: "", _repositoryInput: "", paths: [] }],
    } : application));
    setLayoutDirty(true);
  }

  function updateRepository(ai, ri, input) {
    const value = String(input || "");
    const matched = (defs || []).find((definition) => (
      String(definition.id || "").toLowerCase() === value.trim().toLowerCase()
      || String(definition.name || "").toLowerCase() === value.trim().toLowerCase()
    ));
    setApplications((items) => items.map((application, index) => index === ai ? {
      ...application,
      repositories: application.repositories.map((repository, repositoryIndex) => (
        repositoryIndex === ri ? {
          ...repository,
          repositoryId: matched?.id || "",
          _repositoryInput: value,
        } : repository
      )),
    } : application));
    setLayoutDirty(true);
  }

  function removeRepository(ai, ri) {
    if (applications[ai].repositories[ri].paths.length) {
      setErr("请先移除仓库下的本机路径，再删除关联仓库");
      return;
    }
    setApplications((items) => items.map((application, index) => index === ai ? {
      ...application,
      repositories: application.repositories.filter((_, repositoryIndex) => repositoryIndex !== ri),
    } : application));
    setLayoutDirty(true);
  }

  function addLocalPath(ai, ri) {
    setApplications((items) => items.map((application, index) => index === ai ? {
      ...application,
      repositories: application.repositories.map((repository, repositoryIndex) => repositoryIndex === ri ? {
        ...repository,
        paths: [...repository.paths, { _draftId: draftId("path"), id: "", name: "", path: "" }],
      } : repository),
    } : application));
    setLayoutDirty(true);
  }

  function updateLocalPath(ai, ri, pi, patch) {
    setApplications((items) => items.map((application, index) => index === ai ? {
      ...application,
      repositories: application.repositories.map((repository, repositoryIndex) => repositoryIndex === ri ? {
        ...repository,
        paths: repository.paths.map((project, projectIndex) => projectIndex === pi ? {
          ...project,
          ...patch,
          _dirty: true,
        } : project),
      } : repository),
    } : application));
    setLayoutDirty(true);
  }

  function validateLayout(items) {
    for (const application of items) {
      if (!String(application.name || "").trim()) return "应用名称不能为空";
      for (const repository of application.repositories) {
        if (!repository.repositoryId) return `应用「${application.name}」存在未选择仓库的配置`;
        const unsaved = repository.paths.find((project) => !project.id && String(project.path || "").trim());
        if (unsaved) return "存在尚未保存的本机路径，请先保存路径";
      }
    }
    return "";
  }

  async function persistApplicationLayout(items = applications, { announce = true, projectRows = rows } = {}) {
    const invalid = validateLayout(items);
    if (invalid) { setErr(invalid); return false; }
    const result = await devbenchApi.saveProjectApplications(applicationLayoutPayload(items));
    if (!result.ok) { setErr(result.error || "应用工程配置保存失败"); return false; }
    const savedApplications = hydrateApplicationLayout(
      Array.isArray(result.applications) ? result.applications : applicationLayoutPayload(items),
      projectRows,
    );
    setApplications(savedApplications);
    setLayoutDirty(false);
    setErr("");
    projectConfigCache.write(projectId, { rows: projectRows, applications: savedApplications, applicationOptions: applicationOptionsRef.current || [] });
    if (announce) showToast("应用工程配置已保存");
    return true;
  }

  async function saveApplicationLayout() {
    if (busyId) return;
    setBusyId("layout");
    await persistApplicationLayout();
    setBusyId(null);
  }

  async function saveLocalPath(ai, ri, pi) {
    const project = applications[ai].repositories[ri].paths[pi];
    const projectPath = String(project.path || "").trim();
    const name = String(project.name || "").trim() || deriveName(projectPath);
    if (!projectPath || !name) { setErr("本机路径不能为空，且必须能确定显示名称"); return; }
    const duplicate = rows.find((candidate) => candidate.id !== project.id && normPath(candidate.path) === normPath(projectPath));
    if (duplicate) { setErr(`该路径已由「${duplicate.name}」配置`); return; }
    const key = project.id || project._draftId;
    setBusyId(key); setErr("");
    const saved = await devbenchApi.saveProject({ id: project.id || undefined, name, path: projectPath });
    if (!saved.ok) { setBusyId(null); setErr(saved.error || "本机路径保存失败"); return; }
    const listed = await devbenchApi.listProjects();
    const nextRows = listed.ok ? (listed.data || []) : [...rows, saved.project];
    const fresh = nextRows.find((candidate) => candidate.id === saved.project.id) || saved.project;
    const nextApplications = applications.map((application, applicationIndex) => applicationIndex === ai ? {
      ...application,
      repositories: application.repositories.map((repository, repositoryIndex) => repositoryIndex === ri ? {
        ...repository,
        paths: repository.paths.map((candidate, projectIndex) => projectIndex === pi ? fresh : candidate),
      } : repository),
    } : application);
    setApplications(nextApplications);
    setRows(nextRows);
    onChanged?.(nextRows);
    const linked = await persistApplicationLayout(nextApplications, { announce: false, projectRows: nextRows });
    setBusyId(null);
    if (linked) {
      showToast(`已保存路径并读取分支：${fresh.branch || "未识别"}`);
    }
  }

  async function removeLocalPath(ai, ri, pi) {
    const project = applications[ai].repositories[ri].paths[pi];
    const nextApplications = applications.map((application, applicationIndex) => applicationIndex === ai ? {
      ...application,
      repositories: application.repositories.map((repository, repositoryIndex) => repositoryIndex === ri ? {
        ...repository,
        paths: repository.paths.filter((_, projectIndex) => projectIndex !== pi),
      } : repository),
    } : application);
    if (!project.id) { setApplications(nextApplications); setLayoutDirty(true); return; }
    const referenceCount = applications.reduce((total, application) => total + application.repositories.reduce(
      (count, repository) => count + repository.paths.filter((candidate) => candidate.id === project.id).length,
      0,
    ), 0);
    if (!confirm(`移除本机路径「${project.path}」？不会删除磁盘文件。`)) return;
    setBusyId(project.id); setErr("");
    if (referenceCount <= 1) {
      const removed = await devbenchApi.deleteProject(project.id);
      if (!removed.ok) { setBusyId(null); setErr(removed.error || "移除失败"); return; }
    }
    setApplications(nextApplications);
    if (referenceCount > 1) await persistApplicationLayout(nextApplications, { announce: false });
    await reloadProjectLayout();
    setBusyId(null);
  }

  async function reloadProjectLayout({ showLoading = true } = {}) {
    if (showLoading) setLayoutLoading(true);
    const [projectResult, applicationResult] = await Promise.all([
      devbenchApi.listProjects(),
      devbenchApi.getProjectApplications(),
    ]);
    setLayoutLoading(false);
    if (!projectResult.ok || !applicationResult.ok) {
      setErr(projectResult.error || applicationResult.error || "应用工程配置加载失败");
      return;
    }
    const nextRows = projectResult.data || [];
    const nextApplications = hydrateApplicationLayout(applicationResult.data || [], nextRows);
    setRows(nextRows);
    setApplications(nextApplications);
    setLayoutDirty(false);
    const cachedOptions = projectConfigCache.read(projectId)?.applicationOptions || applicationOptionsRef.current || [];
    projectConfigCache.write(projectId, { rows: nextRows, applications: nextApplications, applicationOptions: cachedOptions });
    onChanged?.(nextRows);
  }

  async function reload() {
    await reloadProjectLayout();
  }

  async function reloadBranches() {
    const result = await devbenchApi.listProjects();
    if (result.ok) {
      const nextRows = result.data || [];
      setRows(nextRows);
      setApplications((items) => {
        const nextApplications = refreshApplicationProjects(items, nextRows);
        projectConfigCache.write(projectId, { rows: nextRows, applications: nextApplications, applicationOptions: applicationOptionsRef.current || [] });
        return nextApplications;
      });
      onChanged?.(nextRows);
    }
  }

  // ===== 工程配置 导入/导出（跨机/跨项目/desktop↔web 同步）=====
  const fileRef = useRef(null);
  const [porting, setPorting] = useState(false);
  const [importPrompt, setImportPrompt] = useState(null); // { fileName, applications:[...], projects:[...], hasCloneParent, cloneParent }
  const [clearPrompt, setClearPrompt] = useState(false);
  async function doExport() {
    setPorting(true);
    const r = await devbenchApi.exportProjects();
    setPorting(false);
    if (!r.ok) { setErr(r.error || "导出失败"); return; }
    const blob = new Blob([JSON.stringify(r.data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    a.href = url; a.download = `devbench-local-projects-${stamp}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }
  async function onPickImport(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setErr("");
    let data;
    try { data = JSON.parse(await file.text()); } catch { setErr("文件不是有效的 JSON"); return; }
    const projects = Array.isArray(data?.projects) ? data.projects : (Array.isArray(data) ? data : null);
    const importedApplications = Array.isArray(data?.applications) ? data.applications : [];
    const hasCloneParent = !!data && !Array.isArray(data) && Object.prototype.hasOwnProperty.call(data, "cloneParent");
    if ((!projects || !projects.length) && !importedApplications.length && !hasCloneParent) { setErr("文件里没有应用、本机工程或克隆父路径配置"); return; }
    setImportPrompt({
      fileName: file.name,
      applications: importedApplications,
      projects: projects || [],
      hasCloneParent,
      cloneParent: hasCloneParent ? String(data.cloneParent || "") : "",
    });
  }
  async function runImport(mode) {
    const prompt = importPrompt;
    setImportPrompt(null);
    if (!prompt) return;
    setPorting(true);
    // 只导入本机路径配置（payload 不含 tasks），避免动到任务列表。
    const payload = {
      type: "devbench-projects",
      version: 4,
      applications: prompt.applications,
      projects: prompt.projects,
    };
    if (prompt.hasCloneParent) payload.cloneParent = prompt.cloneParent;
    const r = await devbenchApi.importSync(payload, mode);
    setPorting(false);
    if (!r.ok) { setErr(r.error || "导入失败"); return; }
    await reload();
    setErr("");
  }

  async function clearAllProjects() {
    setClearPrompt(false);
    setPorting(true);
    setErr("");
    const r = await devbenchApi.clearProjects();
    setPorting(false);
    if (!r.ok) { setErr(r.error || "清空失败"); return; }
    await reload();
  }

  const inputCls = "bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-[11px] text-zinc-200 placeholder-zinc-600 outline-none focus:border-zinc-500";
  const selectableApplicationNames = [...new Set([
    ...(applicationOptions || []),
    ...(defs || []).map((definition) => definition.name),
  ].map((name) => String(name || "").trim()).filter(Boolean))];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
      <div data-testid="project-config-modal" className="bg-zinc-900 border border-zinc-700 rounded-xl w-[1120px] max-w-[96vw] max-h-[88vh] flex flex-col shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-zinc-800 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-zinc-100">工程配置</h2>
            <p className="text-[11px] text-zinc-500 mt-0.5">统一维护应用本机路径、团队仓库定义与车型源码预置。</p>
          </div>
          <button onClick={requestClose} className="text-zinc-500 hover:text-zinc-200 text-lg leading-none">✕</button>
        </div>

        {/* Tab 导航 */}
        <div className="flex gap-1 px-5 border-b border-zinc-800" role="tablist" aria-label="工程配置视图">
          <button
            type="button"
            role="tab"
            data-testid="project-config-tab-projects"
            aria-selected={tab === "projects"}
            onClick={() => setTab("projects")}
            className={`shrink-0 border-b-2 px-3.5 py-2.5 text-[11px] transition ${tab === "projects" ? "border-blue-500 text-zinc-50" : "border-transparent text-zinc-500 hover:text-zinc-300"}`}
          >应用工程配置</button>
          <button
            type="button"
            role="tab"
            data-testid="project-config-tab-defs"
            aria-selected={tab === "defs"}
            onClick={() => setTab("defs")}
            className={`shrink-0 border-b-2 px-3.5 py-2.5 text-[11px] transition ${tab === "defs" ? "border-blue-500 text-zinc-50" : "border-transparent text-zinc-500 hover:text-zinc-300"}`}
          >仓库定义</button>
          <button
            type="button"
            role="tab"
            data-testid="project-config-tab-vehicle"
            aria-selected={tab === "vehicle"}
            onClick={() => { setVehicleVisited(true); setTab("vehicle"); }}
            className={`shrink-0 border-b-2 px-3.5 py-2.5 text-[11px] transition ${tab === "vehicle" ? "border-blue-500 text-zinc-50" : "border-transparent text-zinc-500 hover:text-zinc-300"}`}
          >车型源码配置</button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          {/* ===== Tab 1: 应用 → 关联 Git 仓库 → 多个本机路径 ===== */}
          {tab === "projects" && (
            <>
              <datalist id="project-application-options">
                {selectableApplicationNames.map((name) => <option key={name} value={name} />)}
              </datalist>
              <datalist id="project-repository-options">
                {(defs || []).map((definition) => <option key={definition.id} value={definition.name}>{definition.id}</option>)}
              </datalist>
              <div className="rounded-xl border border-cyan-900/45 bg-cyan-950/15 px-3 py-2.5 text-[11px] leading-relaxed text-cyan-100/85">
                先从应用角度配置：应用名可以输入，也可以搜索选择 TB 应用分类或仓库定义名称；选中同名仓库定义时会自动建立关联。每个关联仓库可登记多个本机路径，路径输入后会自动读取当前 Git 分支。WebApp 与其他仓库完全相同，需要单独添加、单独选择路径。
              </div>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-xs font-semibold text-zinc-200">已配置应用</h3>
                  <p className="mt-0.5 text-[10px] text-zinc-600">{applications.length} 个应用，{rows.length} 个本机工程路径</p>
                </div>
                <div className="flex items-center gap-2">
                  {layoutDirty && <span className="text-[10px] text-amber-400">有未保存的分组调整</span>}
                  <button
                    type="button"
                    onClick={saveApplicationLayout}
                    disabled={!layoutDirty || busyId === "layout"}
                    data-testid="save-project-application-layout"
                    className="rounded-lg bg-blue-600 px-3 py-1.5 text-[11px] text-white hover:bg-blue-500 disabled:opacity-40"
                  >保存应用配置</button>
                  <button
                    type="button"
                    onClick={addApplication}
                    data-testid="add-project-application"
                    className="rounded-lg bg-emerald-600 px-3 py-1.5 text-[11px] text-white hover:bg-emerald-500"
                  >＋ 添加应用</button>
                </div>
              </div>

              {layoutLoading && <div className="py-10 text-center text-[11px] text-zinc-500">正在读取应用工程配置…</div>}
              {!layoutLoading && !applications.length && (
                <button
                  type="button"
                  onClick={addApplication}
                  className="w-full rounded-xl border border-dashed border-zinc-700 bg-zinc-950/20 py-10 text-center text-[11px] text-zinc-500 hover:border-zinc-500 hover:text-zinc-300"
                >尚未配置应用，点击添加第一个应用</button>
              )}

              {!layoutLoading && applications.map((application, ai) => (
                <section key={application.id || ai} data-testid="project-application-card" className="overflow-visible rounded-xl border border-zinc-700/80 bg-zinc-950/25">
                  <div className="flex items-end gap-3 border-b border-zinc-800 px-3 py-3">
                    <label className="min-w-0 flex-1">
                      <span className="mb-1 block text-[10px] font-medium text-zinc-400">应用名称</span>
                      <input
                        list="project-application-options"
                        data-testid="project-application-name"
                        className={`${inputCls} w-full text-xs`}
                        value={application.name || ""}
                        onChange={(event) => changeApplicationName(ai, event.target.value)}
                        placeholder="输入应用名称，或展开后搜索选择"
                      />
                    </label>
                    <span className="mb-1 text-[10px] text-zinc-600">与 TB 应用分类、仓库定义名称联动</span>
                    <button type="button" onClick={() => addRepository(ai)} className="rounded bg-indigo-600/80 px-2.5 py-1.5 text-[11px] text-white hover:bg-indigo-500">＋ 关联仓库</button>
                    <button type="button" onClick={() => removeApplication(ai)} className="rounded bg-zinc-800 px-2.5 py-1.5 text-[11px] text-zinc-500 hover:bg-red-950/50 hover:text-red-300">删除应用</button>
                  </div>

                  <div className="space-y-2.5 p-3">
                    {!application.repositories.length && (
                      <button type="button" onClick={() => addRepository(ai)} className="w-full rounded-lg border border-dashed border-zinc-800 py-4 text-[10px] text-zinc-600 hover:border-zinc-600 hover:text-zinc-400">为此应用添加关联 Git 仓库</button>
                    )}
                    {application.repositories.map((repository, ri) => {
                      const definition = (defs || []).find((candidate) => candidate.id === repository.repositoryId);
                      const repositoryInput = repository._repositoryInput ?? definition?.name ?? repository.repositoryId;
                      return (
                        <div key={`${application.id}-${repository.repositoryId || ri}`} data-testid="project-repository-card" className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-2.5">
                          <div className="flex items-end gap-2">
                            <label className="min-w-0 flex-1">
                              <span className="mb-1 block text-[9px] text-zinc-500">关联 Git 仓库</span>
                              <input
                                list="project-repository-options"
                                data-testid="project-repository-search"
                                className={`${inputCls} w-full`}
                                value={repositoryInput || ""}
                                onChange={(event) => updateRepository(ai, ri, event.target.value)}
                                placeholder="输入名称搜索仓库定义"
                              />
                            </label>
                            <div className="min-w-0 flex-[1.4] pb-1 text-[10px] text-zinc-600">
                              {definition
                                ? <span className="block truncate font-mono" title={definition.ssh || definition.https}>{definition.ssh || definition.https || "未配置 Git 地址"}</span>
                                : <span className="text-amber-500/80">请选择已有仓库定义</span>}
                            </div>
                            <button type="button" onClick={() => addLocalPath(ai, ri)} disabled={!repository.repositoryId} className="rounded bg-zinc-800 px-2.5 py-1.5 text-[11px] text-zinc-300 hover:bg-zinc-700 disabled:opacity-40">＋ 本机路径</button>
                            <button type="button" onClick={() => removeRepository(ai, ri)} className="rounded px-2 py-1.5 text-[11px] text-zinc-600 hover:bg-red-950/40 hover:text-red-300">移除仓库</button>
                          </div>

                          <div className="mt-2 space-y-2">
                            {!repository.paths.length && <div className="rounded border border-dashed border-zinc-800 px-3 py-3 text-center text-[10px] text-zinc-700">尚未登记本机路径；同一仓库可以添加多份 checkout</div>}
                            {repository.paths.map((project, pi) => {
                              const pathKey = project.id || project._draftId || pi;
                              return (
                                <div key={pathKey} data-testid="project-local-path-row" className="rounded-lg border border-zinc-800/80 bg-zinc-950/45 p-2">
                                  <div className="grid grid-cols-[150px_minmax(280px,1fr)_auto] items-center gap-2">
                                    <input
                                      className={inputCls}
                                      value={project.name || ""}
                                      onChange={(event) => updateLocalPath(ai, ri, pi, { name: event.target.value, _nameTouched: true })}
                                      placeholder="显示名（可自动取路径末段）"
                                    />
                                    <input
                                      className={`${inputCls} font-mono ${project.exists === false ? "border-red-500/50" : ""}`}
                                      value={project.path || ""}
                                      onChange={(event) => {
                                        const nextPath = event.target.value;
                                        updateLocalPath(ai, ri, pi, {
                                          path: nextPath,
                                          name: project._nameTouched ? project.name : deriveName(nextPath),
                                        });
                                      }}
                                      placeholder="输入或粘贴本机工程绝对路径"
                                      title={project.exists === false ? "路径不存在" : project.path}
                                    />
                                    <div className="flex items-center gap-1">
                                      <button type="button" onClick={() => saveLocalPath(ai, ri, pi)} disabled={busyId === pathKey} className={`rounded px-2 py-1 text-[11px] ${project._dirty || !project.id ? "bg-blue-600 text-white hover:bg-blue-500" : "bg-zinc-800 text-zinc-400"}`}>{busyId === pathKey ? "…" : "保存路径"}</button>
                                      <button type="button" onClick={() => removeLocalPath(ai, ri, pi)} className="rounded px-2 py-1 text-[11px] text-zinc-600 hover:bg-red-950/40 hover:text-red-300">移除</button>
                                    </div>
                                  </div>
                                  <div className="mt-2 grid grid-cols-[150px_minmax(280px,1fr)_auto] items-center gap-2">
                                    <span className="text-right text-[10px] text-zinc-600">当前 Git 分支</span>
                                    <ProjectGitCell repoPath={project.path} label={project.name || definition?.name || "工程"} onToast={showToast} onChanged={reloadBranches} />
                                    <span />
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              ))}
            </>
          )}

          {/* ===== Tab 2: 仓库定义 ===== */}
          {tab === "defs" && defs && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-medium text-zinc-300">仓库定义</span>
                <span className="text-[10px] text-zinc-600">仓库定义可被多个应用关联；SDK、WebApp、工具等仓库均按独立定义参与 RAG 推理</span>
                {!canEditDefinitions && <span className="ml-auto text-[10px] text-zinc-500">🔒 当前身份无仓库定义编辑权限</span>}
              </div>
              {defs.map((d, idx) => (
                <div key={d.id} data-testid={`project-definition-${d.id}`} className="rounded-lg border border-zinc-800 bg-zinc-950/25 p-2.5 space-y-2">
                  <div className="grid grid-cols-[150px_minmax(260px,1fr)_140px_130px_auto] gap-2 items-end">
                    <label className="min-w-0">
                      <span className="mb-1 block text-[9px] text-zinc-600">仓库名</span>
                      <input className={inputCls + (canEditDefinitions ? "" : " opacity-60")} readOnly={!canEditDefinitions} value={d.name || ""} onChange={(e) => setDef(idx, "name", e.target.value)} />
                    </label>
                    <label className="min-w-0">
                      <span className="mb-1 block text-[9px] text-zinc-600">git ssh（https 自动推断）</span>
                      <input className={inputCls + " w-full font-mono" + (canEditDefinitions ? "" : " opacity-60")} readOnly={!canEditDefinitions} value={d.ssh || ""} onChange={(e) => setDef(idx, "ssh", e.target.value)} placeholder="git@…:….git" />
                    </label>
                    <label>
                      <span className="mb-1 block text-[9px] text-zinc-600">工程类型</span>
                      <select className={inputCls + " w-full" + (canEditDefinitions ? "" : " opacity-60")} disabled={!canEditDefinitions} value={d.projectType || "application"} onChange={(e) => setDef(idx, "projectType", e.target.value)}>
                        {PROJECT_TYPE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                      </select>
                    </label>
                    <label className={`flex h-[28px] items-center gap-2 rounded border border-zinc-800 px-2 text-[10px] text-zinc-400 ${canEditDefinitions ? "cursor-pointer" : "opacity-60"}`}>
                      <input type="checkbox" disabled={!canEditDefinitions} checked={d.inferenceEnabled === true} onChange={(e) => setDef(idx, "inferenceEnabled", e.target.checked)} />
                      可独立推理
                    </label>
                    {canEditDefinitions && (
                      <div className="flex items-center gap-1">
                        <button data-testid={`save-project-definition-${d.id}`} onClick={() => saveDef(d)} disabled={defBusy} className="px-2 py-1 text-[11px] rounded bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-60">保存</button>
                        <button onClick={() => removeDef(d)} disabled={defBusy} className="px-1.5 py-1 text-[11px] rounded bg-zinc-800 hover:bg-red-600/30 text-zinc-500 hover:text-red-300">删</button>
                      </div>
                    )}
                  </div>
                  <div className="grid grid-cols-[1.25fr_1fr_0.8fr_0.9fr_0.75fr] gap-2">
                    <label className="min-w-0">
                      <span className="mb-1 block text-[9px] text-zinc-600">推理关键词 inferenceKeywords</span>
                      <input className={inputCls + " w-full" + (canEditDefinitions ? "" : " opacity-60")} readOnly={!canEditDefinitions} value={d._inferenceKeywordsInput || ""} onChange={(e) => setDef(idx, "_inferenceKeywordsInput", e.target.value)} placeholder="语音, voice, tts" />
                    </label>
                    <label className="min-w-0">
                      <span className="mb-1 block text-[9px] text-zinc-600">依赖主仓库 requiresRepositories</span>
                      <input className={inputCls + " w-full font-mono" + (canEditDefinitions ? "" : " opacity-60")} readOnly={!canEditDefinitions} value={d._requiresRepositoriesInput || ""} onChange={(e) => setDef(idx, "_requiresRepositoriesInput", e.target.value)} placeholder="appMarket（填仓库 ID）" />
                    </label>
                    <label className="min-w-0">
                      <span className="mb-1 block text-[9px] text-zinc-600">继承维度 inheritVariant</span>
                      <input className={inputCls + " w-full font-mono" + (canEditDefinitions ? "" : " opacity-60")} readOnly={!canEditDefinitions} value={d._inheritVariantInput || ""} onChange={(e) => setDef(idx, "_inheritVariantInput", e.target.value)} placeholder="vehicle, branch, flavor" />
                    </label>
                    <label className="min-w-0">
                      <span className="mb-1 block text-[9px] text-zinc-600">默认分支 defaultBranch</span>
                      <input className={inputCls + " w-full font-mono" + (canEditDefinitions ? "" : " opacity-60")} readOnly={!canEditDefinitions} value={d.defaultBranch || ""} onChange={(e) => setDef(idx, "defaultBranch", e.target.value)} placeholder="可空" />
                    </label>
                    <label className="min-w-0">
                      <span className="mb-1 block text-[9px] text-zinc-600">默认 Flavor</span>
                      <input className={inputCls + " w-full font-mono" + (canEditDefinitions ? "" : " opacity-60")} readOnly={!canEditDefinitions} value={d.defaultFlavor || ""} onChange={(e) => setDef(idx, "defaultFlavor", e.target.value)} placeholder="可空" />
                    </label>
                  </div>
                  <p className="text-[9px] text-zinc-700">依赖型仓库仅在主仓库已命中且关键词命中时追加；无依赖且开启“可独立推理”时，可作为无独立应用的工程直接命中。</p>
                  <WorkspaceBundleEditor
                    definition={d}
                    definitions={defs}
                    disabled={!canEditDefinitions}
                    onChange={(workspaceBundle) => setDef(idx, "workspaceBundle", workspaceBundle)}
                  />
                </div>
              ))}
              {canEditDefinitions && (
                <div className="rounded-lg border border-dashed border-zinc-700 bg-zinc-950/20 p-2.5 space-y-2">
                  <div className="grid grid-cols-[150px_minmax(260px,1fr)_140px_130px_auto] gap-2 items-end">
                    <input className={inputCls} value={defAdding.name} onChange={(e) => setDefAdding((a) => ({ ...a, name: e.target.value }))} placeholder="新增仓库名" />
                    <input className={inputCls + " w-full font-mono"} value={defAdding.ssh} onChange={(e) => setDefAdding((a) => ({ ...a, ssh: e.target.value }))} placeholder="git@...:....git（https 自动推断）" />
                    <select className={inputCls + " w-full"} value={defAdding.projectType} onChange={(e) => setDefAdding((a) => ({ ...a, projectType: e.target.value }))}>
                      {PROJECT_TYPE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                    <label className="flex h-[28px] cursor-pointer items-center gap-2 rounded border border-zinc-800 px-2 text-[10px] text-zinc-400">
                      <input type="checkbox" checked={defAdding.inferenceEnabled === true} onChange={(e) => setDefAdding((a) => ({ ...a, inferenceEnabled: e.target.checked }))} />
                      可独立推理
                    </label>
                    <button onClick={addDef} disabled={defBusy} className="px-2 py-1 text-[11px] rounded bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-60">＋添加</button>
                  </div>
                  <div className="grid grid-cols-[1.25fr_1fr_0.8fr_0.9fr_0.75fr] gap-2">
                    <input className={inputCls + " w-full"} value={defAdding._inferenceKeywordsInput || ""} onChange={(e) => setDefAdding((a) => ({ ...a, _inferenceKeywordsInput: e.target.value }))} placeholder="推理关键词：语音, voice, tts" />
                    <input className={inputCls + " w-full font-mono"} value={defAdding._requiresRepositoriesInput || ""} onChange={(e) => setDefAdding((a) => ({ ...a, _requiresRepositoriesInput: e.target.value }))} placeholder="依赖主仓库 ID：appMarket" />
                    <input className={inputCls + " w-full font-mono"} value={defAdding._inheritVariantInput || ""} onChange={(e) => setDefAdding((a) => ({ ...a, _inheritVariantInput: e.target.value }))} placeholder="继承：vehicle" />
                    <input className={inputCls + " w-full font-mono"} value={defAdding.defaultBranch || ""} onChange={(e) => setDefAdding((a) => ({ ...a, defaultBranch: e.target.value }))} placeholder="默认分支（可空）" />
                    <input className={inputCls + " w-full font-mono"} value={defAdding.defaultFlavor || ""} onChange={(e) => setDefAdding((a) => ({ ...a, defaultFlavor: e.target.value }))} placeholder="默认 Flavor（可空）" />
                  </div>
                </div>
              )}
              <p className="text-[10px] text-zinc-600">克隆/拉分支默认用 ssh（需本机配 ssh key）。本地源码仍由仓库名+分支映射；工程定义与 RAG 推理元数据参与局域网共享。{!canEditDefinitions && " 仓库定义由具有车型配置编辑权限的管理员统一维护。"}</p>
            </div>
          )}
          {tab === "defs" && !defs && (
            <div className="text-[11px] text-zinc-500 py-6 text-center">仓库定义加载中…</div>
          )}

          {vehicleVisited && (
            <div data-testid="project-config-vehicle-panel" className={tab === "vehicle" ? "block" : "hidden"}>
              <VehicleSourceModal
                embedded
                projectId={projectId}
                projectDefs={defs}
                applicationOptions={applicationOptions}
                repositorySubscriptions={applicationLayoutPayload(applications)}
                onClose={requestClose}
                onToast={showToast}
                onDirtyChange={setVehicleConfigDirty}
              />
            </div>
          )}

          {toast && <p className="text-[11px] text-emerald-400">{toast}</p>}
          {err && <p className="text-[11px] text-red-400">{err}</p>}
        </div>

        <div className="px-5 py-3 border-t border-zinc-800 flex justify-between items-center gap-2">
          <span className="text-[10px] text-zinc-600 truncate">
            {tab === "projects"
              ? "提示：备份包含应用分组、本机路径和克隆父路径；还原后请确认路径可用。切换分支若有改动会自动暂存。"
              : tab === "defs"
                ? "提示：仓库定义由管理员统一维护，参与局域网共享。"
                : "提示：车型源码预置用于新建远程拉取故事点，未发布改动会在关闭工程配置前提醒。"}
          </span>
          <div className="flex items-center gap-2 shrink-0">
            {tab === "projects" && (
              <>
                <button onClick={() => setClearPrompt(true)} disabled={porting || rows.length === 0}
                  className="px-2.5 py-1.5 text-[11px] rounded-lg border border-red-900/70 bg-red-950/30 hover:bg-red-900/40 text-red-300 disabled:opacity-60 transition"
                  title="清空应用分组与本机工程路径，不删除磁盘文件">一键清空</button>
                <button onClick={doExport} disabled={porting}
                  className="px-2.5 py-1.5 text-[11px] rounded-lg border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 disabled:opacity-60 transition"
                  title="备份应用分组、本机工程路径和克隆父路径为文件">⤓ 备份</button>
                <button onClick={() => fileRef.current?.click()} disabled={porting}
                  className="px-2.5 py-1.5 text-[11px] rounded-lg border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 disabled:opacity-60 transition"
                  title="从备份文件还原应用分组、本机工程路径和克隆父路径">⤒ 还原</button>
                <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={onPickImport} />
              </>
            )}
            <button onClick={requestClose} className="px-4 py-1.5 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300">完成</button>
          </div>
        </div>
      </div>

      {/* 工程配置导入模式选择 */}
      {importPrompt && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60">
          <div className="w-[440px] max-w-[92vw] bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="px-4 py-3 border-b border-zinc-800 text-sm font-semibold text-zinc-100">还原本机路径配置</div>
            <div className="px-4 py-4 text-sm text-zinc-300 leading-relaxed space-y-2">
              <div className="text-[12px] text-zinc-400 font-mono truncate" title={importPrompt.fileName}>📄 {importPrompt.fileName}</div>
              <div className="text-[12px]">应用 <span className="text-zinc-100 font-medium">{importPrompt.applications.length}</span> 个</div>
              <div className="text-[12px]">工程 <span className="text-zinc-100 font-medium">{importPrompt.projects.length}</span> 个</div>
              <div className="text-[12px]">克隆父路径 <span className={importPrompt.hasCloneParent ? "text-zinc-100 font-medium break-all" : "text-zinc-600"}>{importPrompt.hasCloneParent ? (importPrompt.cloneParent || "（默认值）") : "备份中未包含，将保留本机当前值"}</span></div>
              <div className="text-[11px] text-zinc-500 leading-relaxed pt-1">
                <strong className="text-zinc-300">合并</strong>：保留本地，按应用、工程 id/路径增量补充与更新（推荐）。<br />
                <strong className="text-zinc-300">替换</strong>：用文件内容整表覆盖本地应用与工程路径。备份含克隆父路径时，两种模式都会还原该本机值。
              </div>
            </div>
            <div className="px-4 py-3 border-t border-zinc-800 flex items-center justify-end gap-2">
              <button onClick={() => setImportPrompt(null)} className="px-3 py-1.5 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition">取消</button>
              <button onClick={() => runImport("replace")} className="px-3 py-1.5 text-xs rounded-lg bg-red-600/80 hover:bg-red-500 text-white transition">整表替换</button>
              <button onClick={() => runImport("merge")} className="px-3 py-1.5 text-xs rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition">合并导入</button>
            </div>
          </div>
        </div>
      )}

      {clearPrompt && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60">
          <div className="w-[440px] max-w-[92vw] bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="px-4 py-3 border-b border-zinc-800 text-sm font-semibold text-zinc-100">确认清空本地工程列表</div>
            <div className="px-4 py-4 text-sm text-zinc-300 leading-relaxed">
              将清空当前机器保存的 {rows.length} 个工程配置，不会删除磁盘中的工程文件；已打开故事点需要重新选择工程。建议先点击“备份”。
            </div>
            <div className="px-4 py-3 border-t border-zinc-800 flex items-center justify-end gap-2">
              <button onClick={() => setClearPrompt(false)} className="px-3 py-1.5 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition">取消</button>
              <button onClick={clearAllProjects} className="px-3 py-1.5 text-xs rounded-lg bg-red-600 hover:bg-red-500 text-white transition">确认清空</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
