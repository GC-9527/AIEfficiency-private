/**
 * Local Changes（类 Android Studio）：列出本故事点各工程的待提交改动 + 未跟踪文件。
 *  - 每个工程可展开/收起
 *  - 未跟踪文件按文件夹树形展开/收起，或切到「全部文件」平铺
 *  - 展开/收起全部
 * 入口在故事点头部 Git Update 旁（从原工具命令面板移出）。
 */
import React, { useEffect, useMemo, useState } from "react";
import { devbenchApi } from "./api.js";

// Git 状态码 → 中文含义 + 颜色
function statusInfo(xy) {
  const x = xy[0], y = xy[1];
  if (xy.includes("D")) return { label: "删除", color: "text-red-300" };
  if (x === "A") return { label: "新增(已暂存)", color: "text-emerald-300" };
  if (x === "R") return { label: "重命名", color: "text-violet-300" };
  if (x === "M" || y === "M") return { label: y === "M" && x !== "M" ? "已修改(未暂存)" : "已修改", color: "text-amber-300" };
  return { label: xy.trim() || "改动", color: "text-zinc-300" };
}

// 把相对路径列表构建成文件夹树： { dirPath, folders: Map, files: string[] }
function buildTree(paths) {
  const root = { dirPath: "", folders: new Map(), files: [] };
  for (const p of paths || []) {
    const parts = String(p).split("/");
    const fileName = parts.pop();
    let node = root, cur = "";
    for (const part of parts) {
      cur = cur ? `${cur}/${part}` : part;
      if (!node.folders.has(part)) node.folders.set(part, { dirPath: cur, folders: new Map(), files: [] });
      node = node.folders.get(part);
    }
    node.files.push(fileName);
  }
  return root;
}

// 递归统计节点下文件总数（含子文件夹）
function countFiles(node) {
  let n = node.files.length;
  for (const child of node.folders.values()) n += countFiles(child);
  return n;
}

export default function LocalChangesPanel({ tabId, refreshKey = 0, onClose, onToast }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState(() => new Set()); // 折叠节点 key（仓库 / 未跟踪文件夹）
  const [untrackedView, setUntrackedView] = useState({}); // { [repoPath]: "tree" | "flat" }，按工程独立，默认 tree
  const viewOf = (p) => untrackedView[p] || "tree";
  const setView = (p, v) => setUntrackedView((m) => ({ ...m, [p]: v }));

  async function load() {
    setLoading(true);
    const r = await devbenchApi.gitLocalChanges(tabId);
    if (r.ok) setData(r.data || []);
    else onToast?.(r.error || "获取本地改动失败");
    setLoading(false);
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [tabId, refreshKey]);

  const isCollapsed = (k) => collapsed.has(k);
  const toggle = (k) => setCollapsed((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });

  // 所有可折叠节点 key（仓库 + 各仓库未跟踪文件夹），供"展开/收起全部"
  const allKeys = useMemo(() => {
    const keys = [];
    for (const repo of data || []) {
      keys.push(`R|${repo.path}`);
      const walk = (node) => {
        for (const child of node.folders.values()) { keys.push(`U|${repo.path}|${child.dirPath}`); walk(child); }
      };
      walk(buildTree(repo.untracked || []));
    }
    return keys;
  }, [data]);

  const anyCollapsed = collapsed.size > 0;
  const toggleAll = () => setCollapsed(anyCollapsed ? new Set() : new Set(allKeys));

  // 某工程未跟踪文件树的所有文件夹 key（只影响该工程的展开/收起）
  const repoUntrackedKeys = (repo) => {
    const keys = [];
    const walk = (node) => { for (const c of node.folders.values()) { keys.push(`U|${repo.path}|${c.dirPath}`); walk(c); } };
    walk(buildTree(repo.untracked || []));
    return keys;
  };
  const repoUntrackedAnyCollapsed = (repo) => repoUntrackedKeys(repo).some((k) => collapsed.has(k));
  const toggleRepoUntracked = (repo) => {
    const keys = repoUntrackedKeys(repo);
    setCollapsed((s) => {
      const n = new Set(s);
      if (keys.some((k) => n.has(k))) keys.forEach((k) => n.delete(k)); // 有折叠的 → 全展开
      else keys.forEach((k) => n.add(k)); // 全收起
      return n;
    });
  };

  const totalChanged = (data || []).reduce((n, r) => n + (r.changed?.length || 0), 0);
  const totalUntracked = (data || []).reduce((n, r) => n + (r.untracked?.length || 0), 0);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="w-[760px] max-w-[94vw] max-h-[86vh] flex flex-col bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 px-4 py-3 border-b border-zinc-800 flex items-center gap-2">
          <span className="text-sm font-semibold text-zinc-100">📝 Local Changes（Git）</span>
          {!loading && <span className="text-[11px] text-zinc-500">改动 {totalChanged} · 未跟踪 {totalUntracked}</span>}
          <div className="ml-auto flex items-center gap-1.5">
            <button onClick={toggleAll} className="text-[11px] px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700" title="展开/收起全部">
              {anyCollapsed ? "展开全部" : "收起全部"}
            </button>
            <button onClick={load} className="text-[11px] px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700" title="刷新">↻ 刷新</button>
            <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200 text-sm px-1">✕</button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2">
          {loading ? (
            <div className="text-center text-zinc-600 text-xs py-10">读取 git 状态中…</div>
          ) : !data || data.length === 0 ? (
            <div className="text-center text-zinc-600 text-xs py-10">本故事点没有可检查的工程</div>
          ) : (
            data.map((repo) => {
              const rKey = `R|${repo.path}`;
              const rCol = isCollapsed(rKey);
              const total = (repo.changed?.length || 0) + (repo.untracked?.length || 0);
              return (
                <div key={repo.path} className="border border-zinc-800 rounded-lg overflow-hidden">
                  {/* 工程头（可展开/收起） */}
                  <button
                    onClick={() => toggle(rKey)}
                    className="w-full px-3 py-2 bg-zinc-950/60 border-b border-zinc-800 flex items-center gap-2 text-left hover:bg-zinc-900"
                  >
                    <span className={`text-zinc-500 text-[10px] transition-transform ${rCol ? "" : "rotate-90"}`}>▶</span>
                    <span className="text-xs font-medium text-zinc-200 truncate">{repo.name}</span>
                    {repo.branch && <span className="text-[10px] font-mono text-amber-300 shrink-0">⎇ {repo.branch}</span>}
                    {repo.exists && repo.isRepo && <span className="text-[10px] text-zinc-500 shrink-0">（{total}）</span>}
                    <span className="text-[10px] text-zinc-600 truncate flex-1 font-mono text-right" title={repo.path}>{repo.path}</span>
                  </button>

                  {!rCol && (
                    <div className="px-3 py-2 text-[11px]">
                      {!repo.exists ? (
                        <div className="text-zinc-600">路径不存在</div>
                      ) : !repo.isRepo ? (
                        <div className="text-zinc-600">非 git 仓库{repo.error ? `（${repo.error}）` : ""}</div>
                      ) : (repo.changed.length === 0 && repo.untracked.length === 0) ? (
                        <div className="text-emerald-400/80">工作区干净，无改动 ✓</div>
                      ) : (
                        <div className="space-y-2">
                          {/* 改动文件（待提交） */}
                          {repo.changed.length > 0 && (
                            <div>
                              <div className="text-[10px] text-zinc-500 mb-1">改动文件（待提交，{repo.changed.length}）</div>
                              <div className="space-y-0.5">
                                {repo.changed.map((c, i) => {
                                  const s = statusInfo(c.xy);
                                  return (
                                    <div key={i} className="flex items-center gap-2 font-mono">
                                      <span className={`shrink-0 w-[92px] text-[10px] ${s.color}`}>{s.label}</span>
                                      <span className="text-zinc-300 truncate" title={c.file}>{c.file}</span>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          )}

                          {/* 未跟踪文件：每个工程独立切换 tree=按目录分组 / flat=全部文件 */}
                          {repo.untracked.length > 0 && (
                            <div>
                              <div className="mb-1 flex items-center gap-2">
                                <span className="text-[10px] text-zinc-500">未跟踪文件（未加入 git，{repo.untracked.length}）</span>
                                <div className="flex items-center rounded border border-zinc-700 overflow-hidden" title="该工程未跟踪文件的显示方式（只影响此组）">
                                  <button
                                    onClick={() => setView(repo.path, "tree")}
                                    className={`text-[10px] px-1.5 py-0.5 transition ${viewOf(repo.path) === "tree" ? "bg-blue-600 text-white" : "bg-zinc-800 text-zinc-400 hover:text-zinc-200"}`}
                                  >📁 按目录</button>
                                  <button
                                    onClick={() => setView(repo.path, "flat")}
                                    className={`text-[10px] px-1.5 py-0.5 transition border-l border-zinc-700 ${viewOf(repo.path) === "flat" ? "bg-blue-600 text-white" : "bg-zinc-800 text-zinc-400 hover:text-zinc-200"}`}
                                  >📄 全部文件</button>
                                </div>
                                {viewOf(repo.path) === "tree" && repoUntrackedKeys(repo).length > 0 && (
                                  <button
                                    onClick={() => toggleRepoUntracked(repo)}
                                    className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700"
                                    title="展开/收起本工程未跟踪文件的所有目录（只影响此组）"
                                  >{repoUntrackedAnyCollapsed(repo) ? "展开" : "收起"}</button>
                                )}
                              </div>
                              {viewOf(repo.path) === "tree" ? (
                                <TreeNode
                                  repoPath={repo.path}
                                  node={buildTree(repo.untracked)}
                                  depth={0}
                                  isCollapsed={isCollapsed}
                                  toggle={toggle}
                                />
                              ) : (
                                <div className="space-y-0.5">
                                  {[...repo.untracked].sort((a, b) => a.localeCompare(b)).map((f) => (
                                    <div key={f} className="flex items-center gap-1.5 font-mono px-1 py-0.5">
                                      <span className="text-sky-300/70 shrink-0">📄</span>
                                      <span className="text-zinc-400 truncate" title={f}>{f}</span>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

// 未跟踪文件的文件夹树（递归渲染，按文件夹折叠）
function TreeNode({ repoPath, node, depth, isCollapsed, toggle }) {
  const folders = [...node.folders.values()].sort((a, b) => a.dirPath.localeCompare(b.dirPath));
  const files = [...node.files].sort((a, b) => a.localeCompare(b));
  const pad = (d) => ({ paddingLeft: `${d * 14}px` });
  return (
    <div className="space-y-0.5">
      {folders.map((f) => {
        const k = `U|${repoPath}|${f.dirPath}`;
        const col = isCollapsed(k);
        const name = f.dirPath.split("/").pop();
        return (
          <div key={f.dirPath}>
            <button
              onClick={() => toggle(k)}
              style={pad(depth)}
              className="w-full flex items-center gap-1.5 text-left hover:bg-zinc-800/50 rounded px-1 py-0.5"
            >
              <span className={`text-zinc-500 text-[9px] transition-transform ${col ? "" : "rotate-90"}`}>▶</span>
              <span className="text-zinc-300">📁 {name}</span>
              <span className="text-[10px] text-zinc-600">{countFiles(f)}</span>
            </button>
            {!col && (
              <TreeNode repoPath={repoPath} node={f} depth={depth + 1} isCollapsed={isCollapsed} toggle={toggle} />
            )}
          </div>
        );
      })}
      {files.map((fn) => (
        <div key={fn} style={pad(depth + 1)} className="flex items-center gap-1.5 font-mono px-1 py-0.5">
          <span className="text-sky-300/70">📄</span>
          <span className="text-zinc-400 truncate" title={fn}>{fn}</span>
        </div>
      ))}
    </div>
  );
}
