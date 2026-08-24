import React, { useState, useEffect } from "react";
import { getApiUrl } from "../services/gateway.js";
import { getStatusDisplayLabel } from "../utils/statusDisplay.js";
import { authenticatedFetch } from "../services/adminAuth.js";

export default function WorkflowList({ onEdit, onMonitor }) {
  const [workflows, setWorkflows] = useState([]);
  const [runs, setRuns] = useState([]);
  const [runVarsDialog, setRunVarsDialog] = useState(null); // { workflow, vars: "" }

  useEffect(() => {
    fetchWorkflows();
    fetchRuns();
  }, []);

  function fetchWorkflows() {
    authenticatedFetch(getApiUrl("/api/workflows"))
      .then((r) => r.json())
      .then((d) => { if (d.success) setWorkflows(d.data); })
      .catch(() => {});
  }

  function fetchRuns() {
    authenticatedFetch(getApiUrl("/api/workflow-runs?limit=10"))
      .then((r) => r.json())
      .then((d) => { if (d.success) setRuns(d.data); })
      .catch(() => {});
  }

  async function handleDelete(id) {
    if (!confirm("确定删除此工作流?")) return;
    await authenticatedFetch(getApiUrl(`/api/workflows/${id}`), { method: "DELETE" });
    fetchWorkflows();
  }

  async function handleRun(workflow) {
    setRunVarsDialog({ workflow, vars: "" });
  }

  async function confirmRun() {
    if (!runVarsDialog) return;
    const { workflow, vars } = runVarsDialog;
    let variables = {};
    if (vars.trim()) {
      try { variables = JSON.parse(vars); } catch {
        variables = { input: vars };
      }
    }
    setRunVarsDialog(null);

    const resp = await authenticatedFetch(getApiUrl(`/api/workflows/${workflow.id}/run`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ variables }),
    });
    const d = await resp.json();
    if (d.success) {
      onMonitor?.(d.data.runId);
      setTimeout(fetchRuns, 1000);
    }
  }

  function parseSteps(wf) {
    try { return JSON.parse(wf.steps); } catch { return []; }
  }

  return (
    <div className="space-y-6">
      {/* 工作流列表 */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-zinc-300">工作流模板</h3>
        <button
          onClick={() => onEdit?.(null)}
          className="text-xs px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition"
        >
          + 新建工作流
        </button>
      </div>

      {workflows.length === 0 ? (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-8 text-center text-sm text-zinc-600">
          暂无工作流，点击上方按钮创建
        </div>
      ) : (
        <div className="space-y-2">
          {workflows.map((wf) => {
            const steps = parseSteps(wf);
            return (
              <div key={wf.id} className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 flex items-center justify-between">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-zinc-200">{wf.name}</span>
                    <span className="text-xs px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-500">{steps.length} 步骤</span>
                  </div>
                  {wf.description && (
                    <p className="text-xs text-zinc-500 mt-1 truncate">{wf.description}</p>
                  )}
                </div>
                <div className="flex items-center gap-2 ml-4 shrink-0">
                  <button onClick={() => onEdit?.(wf)} className="text-xs px-2 py-1 rounded bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition">
                    编辑
                  </button>
                  <button onClick={() => handleRun(wf)} className="text-xs px-2 py-1 rounded bg-green-600/20 text-green-400 hover:bg-green-600/30 transition">
                    运行
                  </button>
                  <button onClick={() => handleDelete(wf.id)} className="text-xs px-2 py-1 rounded bg-red-600/10 text-red-400 hover:bg-red-600/20 transition">
                    删除
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 运行变量输入弹窗 */}
      {runVarsDialog && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center" onClick={() => setRunVarsDialog(null)}>
          <div className="bg-zinc-900 border border-zinc-700 rounded-xl p-5 w-96" onClick={(e) => e.stopPropagation()}>
            <h4 className="text-sm font-medium text-zinc-200 mb-3">运行: {runVarsDialog.workflow.name}</h4>
            <textarea
              value={runVarsDialog.vars}
              onChange={(e) => setRunVarsDialog((prev) => ({ ...prev, vars: e.target.value }))}
              placeholder='输入变量 (文本 或 JSON，如 {"input": "..."})'
              rows={4}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 resize-none outline-none focus:border-zinc-500"
            />
            <div className="flex justify-end gap-2 mt-3">
              <button onClick={() => setRunVarsDialog(null)} className="text-xs px-3 py-1.5 rounded text-zinc-400 hover:text-zinc-200">
                取消
              </button>
              <button onClick={confirmRun} className="text-xs px-3 py-1.5 rounded bg-green-600 hover:bg-green-500 text-white">
                开始运行
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 最近执行记录 */}
      <div>
        <h3 className="text-sm font-medium text-zinc-300 mb-3">最近执行</h3>
        {runs.length === 0 ? (
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 text-center text-xs text-zinc-600">
            暂无执行记录
          </div>
        ) : (
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-zinc-800 text-zinc-500">
                  <th className="text-left px-4 py-2 font-medium">工作流</th>
                  <th className="text-left px-4 py-2 font-medium">状态</th>
                  <th className="text-left px-4 py-2 font-medium">来源</th>
                  <th className="text-left px-4 py-2 font-medium">时间</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr
                    key={r.id}
                    onClick={() => onMonitor?.(r.id)}
                    className="border-b border-zinc-800/50 hover:bg-zinc-800/30 cursor-pointer"
                  >
                    <td className="px-4 py-2.5 text-zinc-300">{r.workflow_name || r.workflow_id?.slice(0, 8)}</td>
                    <td className="px-4 py-2.5">
                      <RunStatusBadge status={r.status} />
                    </td>
                    <td className="px-4 py-2.5 text-zinc-500">{r.trigger_source || "-"}</td>
                    <td className="px-4 py-2.5 text-zinc-600">{r.created_at}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function RunStatusBadge({ status }) {
  const styles = {
    pending: "bg-zinc-800 text-zinc-500",
    running: "bg-blue-500/10 text-blue-400",
    completed: "bg-green-500/10 text-green-400",
    failed: "bg-red-500/10 text-red-400",
    aborted: "bg-amber-500/10 text-amber-400",
  };
  return (
    <span className={`px-1.5 py-0.5 rounded ${styles[status] || styles.pending}`}>
      {getStatusDisplayLabel(status, `workflow-run:${status || "pending"}`)}
    </span>
  );
}
