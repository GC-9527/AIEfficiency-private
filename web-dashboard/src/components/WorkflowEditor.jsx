import React, { useState, useEffect } from "react";
import { getApiUrl } from "../services/gateway.js";
import WorkflowCanvas from "./workflow/WorkflowCanvas.jsx";
import { stepsToFlow, flowToSteps } from "./workflow/workflowUtils.js";
import { authenticatedFetch } from "../services/adminAuth.js";

export default function WorkflowEditor({ workflow, onSave, onCancel }) {
  const [initialData, setInitialData] = useState(null);
  const [skills, setSkills] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [config, setConfig] = useState(() => {
    try {
      return typeof workflow?.config === "string" ? JSON.parse(workflow.config || "{}") : (workflow?.config || {});
    } catch { return {}; }
  });

  useEffect(() => {
    let steps = [];
    if (workflow) {
      try {
        steps = typeof workflow.steps === "string" ? JSON.parse(workflow.steps) : workflow.steps;
      } catch { steps = []; }
    }
    const { nodes, edges } = stepsToFlow(steps);
    setInitialData({ nodes, edges });
  }, [workflow]);

  useEffect(() => {
    authenticatedFetch(getApiUrl("/api/skills"))
      .then((r) => r.json())
      .then((d) => { if (d.success) setSkills(d.data); })
      .catch(() => {});
  }, []);

  async function handleSave({ name, description, nodes, edges }) {
    if (!name.trim()) { setError("请输入工作流名称"); return; }
    const steps = flowToSteps(nodes, edges);
    if (steps.some((s) => !s.title.trim())) { setError("每个步骤需要标题"); return; }

    setSaving(true);
    setError("");

    try {
      const url = workflow?.id
        ? getApiUrl(`/api/workflows/${workflow.id}`)
        : getApiUrl("/api/workflows");
      const method = workflow?.id ? "PUT" : "POST";
      const resp = await authenticatedFetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), description, steps, config }),
      });
      const text = await resp.text();
      let d;
      try {
        d = JSON.parse(text);
      } catch {
        throw new Error("网关未连接或返回异常，请检查网关地址和服务状态");
      }
      if (d.success) {
        onSave?.(d.data);
      } else {
        setError(d.error || "保存失败");
      }
    } catch (err) {
      setError(err.message);
    }
    setSaving(false);
  }

  if (!initialData) {
    return <div className="p-6 text-center text-sm text-zinc-500">加载中...</div>;
  }

  function updateRoleConfig(role, field, value) {
    setConfig((prev) => ({
      ...prev,
      roles: {
        ...prev.roles,
        [role]: { ...(prev.roles?.[role] || {}), [field]: value },
      },
    }));
  }

  return (
    <div className="h-[calc(100vh-10rem)] flex">
      <div className="flex-1">
        <WorkflowCanvas
          mode="edit"
          initialNodes={initialData.nodes}
          initialEdges={initialData.edges}
          name={workflow?.name || ""}
          description={workflow?.description || ""}
          skills={skills}
          saving={saving}
          error={error}
          onSave={handleSave}
          onCancel={onCancel}
        />
      </div>

      {/* 工作流设置侧边栏 */}
      <div className="w-64 border-l border-zinc-800 bg-zinc-900/50 overflow-y-auto p-4 space-y-4 shrink-0">
        <h4 className="text-sm font-medium text-zinc-300">工作流设置</h4>

        {/* Commander */}
        <div className="space-y-2">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={config.roles?.commander?.enabled || false}
              onChange={(e) => updateRoleConfig("commander", "enabled", e.target.checked)}
              className="rounded border-zinc-600"
            />
            <span className="text-xs text-purple-400 font-medium">自动分解任务</span>
          </label>
          <p className="text-[10px] text-zinc-600 ml-5 leading-relaxed">
            启用后，执行前 AI 自动将输入分解为多个步骤。适合只写需求描述、不想手动拆步骤的场景。
          </p>
          {config.roles?.commander?.enabled && (
            <div className="ml-5">
              <label className="text-[10px] text-zinc-500">分解引擎</label>
              <select
                value={config.roles.commander.engine || "claude"}
                onChange={(e) => updateRoleConfig("commander", "engine", e.target.value)}
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-300 outline-none"
              >
                <option value="claude">Claude</option>
                <option value="gemini">Gemini</option>
              </select>
            </div>
          )}
        </div>

        <div className="border-t border-zinc-800" />

        {/* Inspector 全局设置 */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-amber-500" />
            <span className="text-xs text-amber-400 font-medium">审查设置</span>
          </div>
          <p className="text-[10px] text-zinc-600 leading-relaxed">
            在每个步骤中可独立开关"启用审查"。以下是审查的全局配置。
          </p>
          <div className="space-y-2">
            <div>
              <label className="text-[10px] text-zinc-500">审查引擎</label>
              <select
                value={config.roles?.inspector?.engine || "claude"}
                onChange={(e) => updateRoleConfig("inspector", "engine", e.target.value)}
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-300 outline-none"
              >
                <option value="claude">Claude</option>
                <option value="gemini">Gemini</option>
              </select>
            </div>
            <div>
              <label className="text-[10px] text-zinc-500">最大重试次数</label>
              <input
                type="number"
                min={1}
                max={5}
                value={config.roles?.inspector?.maxRetries || 3}
                onChange={(e) => updateRoleConfig("inspector", "maxRetries", parseInt(e.target.value) || 3)}
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-300 outline-none"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
