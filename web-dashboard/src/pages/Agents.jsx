import React, { useState, useEffect } from "react";
import { createGatewayWebSocket, getApiUrl } from "../services/gateway.js";
import WorkflowList from "../components/WorkflowList.jsx";
import WorkflowEditor from "../components/WorkflowEditor.jsx";
import WorkflowMonitor from "../components/WorkflowMonitor.jsx";
import { getStatusDisplayLabel } from "../utils/statusDisplay.js";
import { authenticatedFetch } from "../services/adminAuth.js";

const AGENT_ROLES = [
  {
    id: "claude",
    name: "Claude Code",
    type: "主引擎",
    description: "强推理引擎，处理 Bug深度分析、SMALI逻辑修改等复杂任务",
    skills: ["bug-report", "smali-analyze", "resolution-adapt"],
    billing: "订阅制（Claude Max）",
    color: "from-violet-500 to-purple-600",
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    type: "辅助引擎",
    description: "免费引擎，处理日志初筛、配置生成、信息查询等简单任务",
    skills: ["日志筛选", "配置生成", "批量扫描"],
    billing: "免费 1000次/天",
    color: "from-blue-500 to-cyan-500",
  },
  {
    id: "codex",
    name: "OpenAI Codex",
    type: "代码引擎",
    description: "代码专精引擎，擅长代码生成、分析、修改和文件操作",
    skills: ["coding-agent", "github", "smali-analyze"],
    billing: "API 计费",
    color: "from-green-500 to-emerald-600",
  },
  {
    id: "hermes",
    name: "Hermes Agent",
    type: "本地智能体",
    description: "复用本机 Hermes 的模型、工具、记忆和规则完成 Agentic 任务",
    skills: ["本地工具", "Memory", "MCP/Plugins"],
    billing: "由本机 Hermes provider 配置决定",
    color: "from-amber-500 to-orange-600",
  },
];

export default function Agents() {
  const [activeTab, setActiveTab] = useState("engines"); // engines | workflows
  const [agents, setAgents] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [engineStatus, setEngineStatus] = useState({});
  const [workflowView, setWorkflowView] = useState({ mode: "list" }); // { mode: list|edit|monitor, data? }

  useEffect(() => {
    authenticatedFetch(getApiUrl("/api/status"))
      .then((r) => r.json())
      .then((d) => {
        if (d.success) {
          setAgents(d.data.agents);
        }
      })
      .catch(() => {});

    authenticatedFetch(getApiUrl("/api/tasks?limit=10"))
      .then((r) => r.json())
      .then((d) => { if (d.success) setTasks(d.data); })
      .catch(() => {});

    authenticatedFetch(getApiUrl("/api/config/engine-status"))
      .then((r) => r.json())
      .then((d) => { if (d.success) setEngineStatus(d.data); })
      .catch(() => {});
  }, []);

  // WebSocket 实时 agent 状态
  useEffect(() => {
    const ws = createGatewayWebSocket();
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === "agent_status") {
        setAgents((prev) => {
          const idx = prev.findIndex((a) => a.id === msg.data.id);
          if (idx >= 0) { const u = [...prev]; u[idx] = { ...u[idx], ...msg.data }; return u; }
          return [...prev, msg.data];
        });
      }
    };
    return () => ws.close();
  }, []);

  return (
    <div className="p-6 overflow-y-auto h-full space-y-6">
      {/* Tab 切换 */}
      <div className="flex items-center gap-1 border-b border-zinc-800 pb-0">
        {[
          { id: "engines", label: "引擎" },
          { id: "workflows", label: "工作流" },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => { setActiveTab(tab.id); if (tab.id === "workflows") setWorkflowView({ mode: "list" }); }}
            className={`text-sm px-4 py-2 -mb-px border-b-2 transition ${
              activeTab === tab.id
                ? "border-blue-500 text-zinc-200"
                : "border-transparent text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* 工作流 Tab */}
      {activeTab === "workflows" && (
        workflowView.mode === "edit" ? (
          <WorkflowEditor
            workflow={workflowView.data}
            onSave={() => setWorkflowView({ mode: "list" })}
            onCancel={() => setWorkflowView({ mode: "list" })}
          />
        ) : workflowView.mode === "monitor" ? (
          <WorkflowMonitor
            runId={workflowView.data}
            onBack={() => setWorkflowView({ mode: "list" })}
          />
        ) : (
          <WorkflowList
            onEdit={(wf) => setWorkflowView({ mode: "edit", data: wf })}
            onMonitor={(runId) => setWorkflowView({ mode: "monitor", data: runId })}
          />
        )
      )}

      {/* 引擎 Tab */}
      {activeTab === "engines" && <>

      {/* 引擎角色卡片 */}
      <div className="grid grid-cols-2 gap-4">
        {AGENT_ROLES.map((role) => {
          const status = engineStatus[role.id];
          return (
            <div key={role.id} className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center space-x-3">
                  <div className={`w-10 h-10 rounded-lg bg-gradient-to-br ${role.color} flex items-center justify-center text-white text-sm font-bold`}>
                    {role.name[0]}
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-zinc-100">{role.name}</h3>
                    <p className="text-xs text-zinc-500">{role.type}</p>
                  </div>
                </div>
                <StatusBadge status={status} />
              </div>

              <p className="text-xs text-zinc-400 mb-3">{role.description}</p>

              <div className="flex flex-wrap gap-1.5 mb-3">
                {role.skills.map((s) => (
                  <span key={s} className="text-xs px-2 py-0.5 rounded bg-zinc-800 text-zinc-400">{s}</span>
                ))}
              </div>

              <div className="text-xs text-zinc-600 border-t border-zinc-800 pt-2">{role.billing}</div>
            </div>
          );
        })}
      </div>

      {/* 运行中的 Agent 实例 */}
      <div>
        <h3 className="text-sm font-medium text-zinc-300 mb-3">运行中的 Worker</h3>
        {agents.length === 0 ? (
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-8 text-center text-sm text-zinc-600">
            当前没有活跃的 Agent Worker
          </div>
        ) : (
          <div className="space-y-2">
            {agents.map((agent) => (
              <div key={agent.id} className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 flex items-center justify-between">
                <div className="flex items-center space-x-3">
                  <span className={`w-2 h-2 rounded-full ${
                    agent.status === "running" ? "bg-green-500 animate-pulse" :
                    agent.status === "error" ? "bg-red-500" : "bg-zinc-600"
                  }`} />
                  <div>
                    <span className="text-sm text-zinc-200 font-mono">{agent.id}</span>
                    <span className="text-xs text-zinc-500 ml-2">{agent.engine}</span>
                  </div>
                </div>
                <div className="flex items-center space-x-4">
                  {agent.current_task_id && (
                    <span className="text-xs text-zinc-500 font-mono">任务: {agent.current_task_id.slice(0, 8)}</span>
                  )}
                  <span className={`text-xs px-2 py-0.5 rounded ${
                    agent.status === "running" ? "bg-green-500/10 text-green-400" :
                    agent.status === "error" ? "bg-red-500/10 text-red-400" : "bg-zinc-800 text-zinc-500"
                  }`}>{getStatusDisplayLabel(agent.status, `agent:${agent.id}:${agent.status || "idle"}`)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 最近任务 */}
      <div>
        <h3 className="text-sm font-medium text-zinc-300 mb-3">最近任务</h3>
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-zinc-800 text-zinc-500">
                <th className="text-left px-4 py-2 font-medium">任务</th>
                <th className="text-left px-4 py-2 font-medium">类型</th>
                <th className="text-left px-4 py-2 font-medium">引擎</th>
                <th className="text-left px-4 py-2 font-medium">状态</th>
                <th className="text-left px-4 py-2 font-medium">时间</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((t) => (
                <tr key={t.id} className="border-b border-zinc-800/50 hover:bg-zinc-800/30">
                  <td className="px-4 py-2.5 text-zinc-300 truncate max-w-[200px]">{t.title}</td>
                  <td className="px-4 py-2.5 text-zinc-500">{t.type}</td>
                  <td className="px-4 py-2.5 text-zinc-500">{t.assigned_engine || "-"}</td>
                  <td className="px-4 py-2.5">
                    <span className={`px-1.5 py-0.5 rounded ${
                      t.status === "completed" ? "bg-green-500/10 text-green-400" :
                      t.status === "running" ? "bg-blue-500/10 text-blue-400" :
                      t.status === "failed" ? "bg-red-500/10 text-red-400" : "bg-zinc-800 text-zinc-500"
                    }`}>{getStatusDisplayLabel(t.status, `task:${t.id}:${t.status || "pending"}`)}</span>
                  </td>
                  <td className="px-4 py-2.5 text-zinc-600">{t.created_at}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      </>}
    </div>
  );
}

function StatusBadge({ status }) {
  if (!status) return <span className="text-xs text-zinc-600">未检测</span>;
  if (status === "checking") return <span className="text-xs text-zinc-500">检测中...</span>;
  if (status.available) return <span className="text-xs px-2 py-0.5 rounded bg-green-500/10 text-green-400">可用</span>;
  return (
    <span className="text-xs px-2 py-0.5 rounded bg-red-500/10 text-red-400">
      {status.needLogin ? "需登录" : "不可用"}
    </span>
  );
}
