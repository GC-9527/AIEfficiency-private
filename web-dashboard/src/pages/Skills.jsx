import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  createGatewayWebSocket,
  getApiUrl,
  getGatewayUrl,
  getWsUrl,
} from "../services/gateway.js";
import { authenticatedFetch } from "../services/adminAuth.js";
import { copyToClipboard } from "../utils/clipboard.js";

// Fallback：后端未返回 tag 时使用的默认映射
const TYPE_MAP = {
  "bug-report": { color: "text-red-400 bg-red-500/10", tag: "Bug分析" },
  "adb-helper": { color: "text-green-400 bg-green-500/10", tag: "ADB" },
  "smali-analyze": { color: "text-purple-400 bg-purple-500/10", tag: "SMALI" },
  "resolution-adapt": { color: "text-cyan-400 bg-cyan-500/10", tag: "适配" },
  "task-workflow": { color: "text-amber-400 bg-amber-500/10", tag: "工作流" },
  "web-search": { color: "text-blue-400 bg-blue-500/10", tag: "搜索" },
  "os-helper": { color: "text-orange-400 bg-orange-500/10", tag: "系统" },
};

const DEFAULT_META = { color: "text-zinc-400 bg-zinc-500/10", tag: "通用" };

function getSkillMeta(skill) {
  // 优先使用后端返回的 tag/color
  if (skill.tag || skill.color) {
    return {
      color: skill.color || DEFAULT_META.color,
      tag: skill.tag || TYPE_MAP[skill.id]?.tag || DEFAULT_META.tag,
    };
  }
  return TYPE_MAP[skill.id] || DEFAULT_META;
}

export default function Skills() {
  const [skills, setSkills] = useState([]);
  const [selected, setSelected] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [pushing, setPushing] = useState(null);
  const [toast, setToast] = useState(null);
  const [capabilities, setCapabilities] = useState(null);
  const [cloudSkillIds, setCloudSkillIds] = useState(new Set());
  const wsRef = useRef(null);
  const [showImport, setShowImport] = useState(false);
  const [importPath, setImportPath] = useState("");
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deletingSkillId, setDeletingSkillId] = useState("");

  const fetchSkills = useCallback(() => {
    fetch(getApiUrl("/api/skills"))
      .then((r) => r.json())
      .then((d) => {
        if (d.success) {
          setSkills(d.data);
          // 保持选中状态或选第一个
          setSelected((prev) => {
            if (prev) {
              const updated = d.data.find((s) => s.id === prev.id);
              if (updated) return updated;
            }
            return d.data.length > 0 ? d.data[0] : null;
          });
        }
      })
      .catch(() => {});
  }, []);

  const fetchCapabilities = useCallback(() => {
    fetch(getApiUrl("/api/skills/capabilities"))
      .then((r) => r.json())
      .then((d) => { if (d.success) setCapabilities(d.data); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchSkills();
    fetchCapabilities();
    // 获取云端 skill 列表用于对比
    fetch(`${window.location.origin}/api/skills`)
      .then((r) => r.json())
      .then((d) => { if (d.success) setCloudSkillIds(new Set(d.data.map(s => s.id))); })
      .catch(() => {});
  }, [fetchCapabilities, fetchSkills]);

  // 监听 WS skills_changed 事件，自动刷新
  useEffect(() => {
    const wsUrl = getWsUrl();
    if (!wsUrl) return;

    const ws = createGatewayWebSocket(wsUrl);
    wsRef.current = ws;

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "skills_changed") {
          fetchSkills();
          fetchCapabilities();
        }
      } catch {}
    };

    ws.onerror = () => {};
    ws.onclose = () => {};

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [fetchCapabilities, fetchSkills]);

  const showToast = (message, success = true) => {
    setToast({ message, success });
    setTimeout(() => setToast(null), 3000);
  };

  // 云端模式：配置了网关地址且网关不在当前页面同源
  const gatewayUrl = getGatewayUrl();
  const isCloudMode = (() => {
    if (!gatewayUrl) return false;
    try {
      const gw = new URL(gatewayUrl);
      return gw.origin !== window.location.origin;
    } catch { return false; }
  })();

  const handleSyncCloud = async () => {
    setSyncing(true);
    try {
      let res;
      if (isCloudMode) {
        // 云端→网关：从云端拉取 skills 到网关本地
        res = await authenticatedFetch(getApiUrl("/api/skills/pull-from-cloud"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cloudUrl: window.location.origin }),
        });
      } else {
        // 网关→云端：推送本地 skills 到云端
        res = await authenticatedFetch(getApiUrl("/api/skills/sync-cloud"), { method: "POST" });
      }
      const d = await res.json();
      if (d.success) {
        showToast(`${d.data.message}`, true);
        fetchSkills();
      } else {
        showToast(`同步失败: ${d.error}`, false);
      }
    } catch (err) {
      showToast(`同步失败: ${err.message}`, false);
    } finally {
      setSyncing(false);
    }
  };

  // 云端模式下自动同步：如果网关 skills 为空，自动从云端拉取
  const autoSynced = useRef(false);
  useEffect(() => {
    if (!isCloudMode || autoSynced.current) return;
    if (skills.length === 0 && gatewayUrl) {
      autoSynced.current = true;
      handleSyncCloud();
    }
  }, [isCloudMode, skills.length]);

  const handleDeleteSkill = async () => {
    const target = deleteTarget;
    if (!target || deletingSkillId) return;
    setDeletingSkillId(target.id);
    try {
      const encodedId = String(target.id)
        .split("/")
        .map((segment) => encodeURIComponent(segment))
        .join("/");
      const resp = await authenticatedFetch(getApiUrl(`/api/skills/${encodedId}`), { method: "DELETE" });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data.success) {
        showToast(`删除失败: ${data.error || `HTTP ${resp.status}`}`, false);
        return;
      }
      setDeleteTarget(null);
      showToast(data.data?.message || `已删除本地 Skill /${target.name}`, true);
      fetchSkills();
      fetchCapabilities();
    } catch (err) {
      showToast(`删除失败: ${err.message}`, false);
    } finally {
      setDeletingSkillId("");
    }
  };

  return (
    <div className="flex h-full relative">
      {/* Toast */}
      {toast && (
        <div className={`absolute top-4 right-4 z-50 px-4 py-2 rounded-lg text-sm shadow-lg ${
          toast.success ? "bg-green-500/20 text-green-300 border border-green-500/30" : "bg-red-500/20 text-red-300 border border-red-500/30"
        }`}>
          {toast.message}
        </div>
      )}

      {/* 左侧：能力摘要 + Skill 列表 */}
      <div className="w-72 border-r border-zinc-800 flex flex-col shrink-0">
        {/* 平台能力摘要 */}
        {capabilities && (
          <div className="border-b border-zinc-800 p-3 space-y-2 bg-zinc-900/50">
            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
              <span className="text-[10px] text-zinc-400 font-medium uppercase tracking-wider">平台能力</span>
            </div>
            <div className="flex flex-wrap gap-1">
              {capabilities.capabilities.slice(0, 8).map((c) => (
                <span key={c.skill} className={`text-[10px] px-1.5 py-0.5 rounded ${c.isModification ? "bg-amber-500/10 text-amber-400" : "bg-zinc-800 text-zinc-500"}`}>
                  /{c.skill}
                </span>
              ))}
            </div>
            <p className="text-[10px] text-zinc-600">
              {capabilities.engines.length} 引擎 | {capabilities.capabilities.length} 能力 | {capabilities.capabilities.filter(c => c.isModification).length} 涉及修改(自动审查)
            </p>
          </div>
        )}
        <div className="h-12 border-b border-zinc-800 flex items-center px-4 gap-2">
          <span className="text-sm font-medium text-zinc-300">Skills</span>
          <span className="text-xs text-zinc-600">{skills.length} 个</span>
          <div className="ml-auto flex items-center gap-1">
            <button
              onClick={() => { setShowImport(true); setImportPath(""); }}
              className="p-1.5 rounded hover:bg-zinc-700 text-zinc-500 hover:text-zinc-300 transition"
              title="导入本地文件/文件夹到 Skills"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
            </button>
            <button
              onClick={fetchSkills}
              className="p-1.5 rounded hover:bg-zinc-700 text-zinc-500 hover:text-zinc-300 transition"
              title="刷新列表"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
            <button
              onClick={handleSyncCloud}
              disabled={syncing}
              className="p-1.5 rounded hover:bg-zinc-700 text-zinc-500 hover:text-zinc-300 transition disabled:opacity-50"
              title={isCloudMode ? "从云端同步" : "同步到云端"}
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                {isCloudMode ? (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M9 19l3 3m0 0l3-3m-3 3V10" />
                ) : (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                )}
              </svg>
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {skills.map((skill) => {
            const meta = getSkillMeta(skill);
            return (
              <button
                key={skill.id}
                onClick={() => setSelected(skill)}
                className={`w-full text-left p-3 rounded-lg transition ${
                  selected?.id === skill.id
                    ? "bg-zinc-800 ring-1 ring-zinc-700"
                    : "hover:bg-zinc-800/50"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-zinc-200">/{skill.name}</span>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${meta.color}`}>{meta.tag}</span>
                </div>
                <p className="text-xs text-zinc-500 mt-1 line-clamp-2">{skill.description}</p>
              </button>
            );
          })}
        </div>
      </div>

      {/* 右侧详情 */}
      <div className="flex-1 overflow-y-auto">
        {selected ? (
          <div className="p-6">
            <div className="flex items-start justify-between gap-4 mb-1">
              <div className="flex items-center space-x-3 min-w-0">
                <h2 className="text-lg font-semibold text-zinc-100 truncate">/{selected.name}</h2>
                <span className={`shrink-0 text-xs px-2 py-0.5 rounded-full ${getSkillMeta(selected).color}`}>
                  {getSkillMeta(selected).tag}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setDeleteTarget(selected)}
                className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-red-500/30 bg-red-500/10 text-xs text-red-400 hover:bg-red-500/20 hover:text-red-300 transition"
                title="删除当前本地 Skill"
                data-testid="delete-skill-button"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
                删除本地 Skill
              </button>
            </div>
            <p className="text-sm text-zinc-400 mb-6">{selected.description}</p>

            <div className="bg-zinc-900 border border-zinc-800 rounded-lg">
              <div className="px-4 py-2 border-b border-zinc-800 flex items-center justify-between">
                <span className="text-xs text-zinc-500">Skill 定义</span>
                <button
                  onClick={() => copyToClipboard(selected.content || "")}
                  className="text-xs text-zinc-500 hover:text-zinc-300"
                >
                  复制
                </button>
              </div>
              <pre className="p-4 text-xs text-zinc-400 whitespace-pre-wrap leading-relaxed overflow-y-auto max-h-[calc(100vh-250px)]">
                {selected.content}
              </pre>
            </div>

            <div className="mt-4 flex items-center gap-3">
              <div className="flex-1 p-3 bg-zinc-800/50 rounded-lg">
                <p className="text-xs text-zinc-500">
                  使用方式：在聊天中发送任务描述（匹配关键词自动触发）或在 Claude Code CLI 中执行{" "}
                  <code className="bg-zinc-700 px-1.5 py-0.5 rounded text-zinc-300">/{selected.name}</code>
                </p>
              </div>
              {isCloudMode && !cloudSkillIds.has(selected.id) && (
                <button
                  onClick={async () => {
                    setPushing(selected.id);
                    try {
                      const resp = await authenticatedFetch(getApiUrl(`/api/skills/${selected.id}/push`), {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ cloudUrl: window.location.origin }),
                      });
                      const d = await resp.json();
                      if (d.success) {
                        showToast(d.data.message, true);
                        setCloudSkillIds(prev => new Set([...prev, selected.id]));
                      } else {
                        showToast(`推送失败: ${d.error}`, false);
                      }
                    } catch (err) {
                      showToast(`推送失败: ${err.message}`, false);
                    } finally {
                      setPushing(null);
                    }
                  }}
                  disabled={pushing === selected.id}
                  className="shrink-0 flex items-center gap-1.5 px-4 py-2.5 rounded-lg bg-blue-600/15 border border-blue-500/30 text-blue-400 hover:bg-blue-600/25 transition disabled:opacity-50 text-xs"
                  title="推送此 Skill 到云端，所有用户可见"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                  </svg>
                  {pushing === selected.id ? "推送中..." : "推送到云端"}
                </button>
              )}
              {isCloudMode && cloudSkillIds.has(selected.id) && (
                <span className="shrink-0 text-[10px] text-green-400/60 px-3 py-2">已在云端</span>
              )}
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-center h-full text-zinc-600">选择一个 Skill 查看详情</div>
        )}
      </div>

      {/* 导入 Skill 弹窗 */}
      {showImport && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setShowImport(false)}>
          <div className="bg-zinc-900 border border-zinc-700 rounded-xl w-[460px] shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-zinc-800">
              <h3 className="text-sm font-semibold text-zinc-200">导入 Skill</h3>
              <p className="text-xs text-zinc-500 mt-1">输入本地文件或文件夹路径，网关会将其复制到 Skills 目录</p>
            </div>
            <div className="px-5 py-4 space-y-3">
              <input
                value={importPath}
                onChange={e => setImportPath(e.target.value)}
                placeholder="文件路径或文件夹路径，如 D:\skills\my-skill.md 或 D:\skills\my-skill\"
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2.5 text-sm text-zinc-300 placeholder-zinc-600 outline-none focus:border-zinc-500 font-mono"
                onKeyDown={e => e.key === "Enter" && importPath.trim() && document.getElementById("btn-import")?.click()}
              />
              <p className="text-[10px] text-zinc-600">
                支持：单个 .md 文件 / 包含 .md + 脚本的文件夹（整个文件夹会作为子目录复制到 skills/）
              </p>
            </div>
            <div className="px-5 py-3 border-t border-zinc-800 flex justify-end gap-2">
              <button onClick={() => setShowImport(false)} className="px-4 py-2 text-xs rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400 transition">取消</button>
              <button
                id="btn-import"
                onClick={async () => {
                  if (!importPath.trim()) return;
                  try {
                    const resp = await authenticatedFetch(getApiUrl("/api/skills/import"), {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ path: importPath.trim() }),
                    });
                    const d = await resp.json();
                    if (d.success) {
                      showToast(d.data.message, true);
                      setShowImport(false);
                      fetchSkills();
                      fetchCapabilities();
                    } else {
                      showToast(`导入失败: ${d.error}`, false);
                    }
                  } catch (err) {
                    showToast(`导入失败: ${err.message}`, false);
                  }
                }}
                disabled={!importPath.trim()}
                className="px-4 py-2 text-xs rounded bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 text-white transition"
              >导入到本地</button>
            </div>
          </div>
        </div>
      )}

      {/* 删除 Skill 确认弹窗 */}
      {deleteTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => { if (!deletingSkillId) setDeleteTarget(null); }}
        >
          <div
            className="bg-zinc-900 border border-red-500/30 rounded-xl w-[480px] shadow-2xl"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-skill-title"
          >
            <div className="px-5 py-4 border-b border-zinc-800">
              <h3 id="delete-skill-title" className="text-sm font-semibold text-zinc-100">删除本地 Skill</h3>
              <p className="text-xs text-zinc-500 mt-1">此操作会立即删除当前网关中的本地文件，无法从面板撤销。</p>
            </div>
            <div className="px-5 py-4 space-y-3">
              <div className="rounded-lg border border-zinc-800 bg-zinc-950/70 px-3 py-2.5">
                <div className="text-sm font-medium text-zinc-200">/{deleteTarget.name}</div>
                <code className="mt-1 block break-all text-[10px] text-zinc-500">{deleteTarget.file}</code>
              </div>
              {String(deleteTarget.file || "").toLowerCase().endsWith("/skill.md") ? (
                <p className="text-xs leading-relaxed text-amber-300">
                  这是文件夹型 Skill，将同时删除它所在目录中的脚本、references、assets 等附属文件；同一集合中的其他 Skill 不受影响。
                </p>
              ) : (
                <p className="text-xs leading-relaxed text-zinc-400">将只删除该 Skill 的 Markdown 文件，邻近文件不会被删除。</p>
              )}
              {isCloudMode && cloudSkillIds.has(deleteTarget.id) && (
                <p className="text-xs leading-relaxed text-blue-300">
                  该 Skill 仍存在于云端；本次只删除本机网关副本，后续从云端同步时可能再次出现。
                </p>
              )}
              <p className="text-[10px] text-zinc-600">Git 管理的 Skill 可通过版本控制恢复；未提交的导入内容删除后不可恢复。</p>
            </div>
            <div className="px-5 py-3 border-t border-zinc-800 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                disabled={!!deletingSkillId}
                className="px-4 py-2 text-xs rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400 transition disabled:opacity-50"
              >取消</button>
              <button
                type="button"
                onClick={handleDeleteSkill}
                disabled={!!deletingSkillId}
                className="px-4 py-2 text-xs rounded bg-red-600 hover:bg-red-500 text-white transition disabled:bg-red-900/50 disabled:text-red-300/50"
                data-testid="confirm-delete-skill-button"
              >{deletingSkillId ? "删除中…" : "确认删除"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
