import React, { useMemo, useState } from "react";

import {
  POLICY_CONDITION_FIELDS,
  POLICY_FIELD_DEFINITIONS,
  POLICY_OPERATORS,
  createPolicyCondition,
  createPolicyRule,
  createPolicyStrategy,
  createPolicyTarget,
  parsePolicyLines,
  policyConditionSummary,
  policyEntityDisplayName,
  priorityMappingForUi,
  policyPreviewSample,
  policyRuleSummary,
  policyRoutingForUi,
  policyRulesByPriority,
  policySummary,
  policyTargetSummary,
  stringifyPolicyLines,
  updatePolicyEntry,
  updatePolicyEntryConfig,
} from "./feishuProjectSyncPolicyModel.js";

const VIEWS = [
  ["rules", "路由规则"],
  ["targets", "目标档案"],
  ["strategies", "同步策略"],
  ["preview", "命中预览"],
];

export default function FeishuSyncPolicyPanel({
  config,
  setCfg,
  readOnly = false,
  tbProjects = {},
  tbTasklists = {},
  tbSprints = {},
  onLoadTbProjects,
  onLoadTbTasklists,
  onLoadTbSprints,
  onPreview,
}) {
  const [view, setView] = useState("rules");
  const routing = policyRoutingForUi(config);
  const summary = policySummary(config);
  const priorityRows = priorityMappingForUi(config);
  const setRouting = (key, value) => setCfg(`routing.${key}`, value);
  return (
    <section className="overflow-hidden rounded-xl border border-cyan-900/60 bg-gradient-to-br from-zinc-950 via-zinc-950 to-cyan-950/20 shadow-xl shadow-black/20">
      <div className="border-b border-cyan-950/80 bg-gradient-to-r from-cyan-950/55 via-zinc-950 to-blue-950/30 px-4 py-4">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold tracking-wide text-cyan-100">Source → Target 同步策略中心</h3>
              <span className={`rounded-full border px-2 py-0.5 text-[10px] ${routing.enabled ? "border-emerald-700/60 bg-emerald-950/40 text-emerald-300" : "border-zinc-700 bg-zinc-900 text-zinc-500"}`}>
                {routing.enabled ? "策略路由已启用" : "策略路由已停用"}
              </span>
            </div>
            <p className="mt-1 max-w-3xl text-xs leading-relaxed text-zinc-400">
              按优先级匹配来源 Project、迭代、业务线或任意飞书字段；命中后选择目标档案与字段同步策略。未命中时自动回退当前 legacy 目标。
            </p>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center text-[10px]">
            <PolicyMetric label="生效规则" value={summary.enabledRules} />
            <PolicyMetric label="可用目标" value={summary.targets} />
            <PolicyMetric label="同步策略" value={summary.strategies} />
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <PolicyToggle
            label="启用策略路由"
            checked={routing.enabled}
            disabled={readOnly}
            onChange={(checked) => setRouting("enabled", checked)}
          />
          <label className="ml-auto flex items-center gap-2 text-[11px] text-zinc-400">
            默认目标
            <PolicySelect value={routing.defaultTargetId} disabled={readOnly} onChange={(value) => setRouting("defaultTargetId", value)}>
              {routing.targets.map((target) => <option key={target.id} value={target.id}>{policyEntityDisplayName(target, "未命名目标档案")}</option>)}
            </PolicySelect>
          </label>
          <label className="flex items-center gap-2 text-[11px] text-zinc-400">
            默认策略
            <PolicySelect value={routing.defaultStrategyId} disabled={readOnly} onChange={(value) => setRouting("defaultStrategyId", value)}>
              {routing.strategies.map((strategy) => <option key={strategy.id} value={strategy.id}>{policyEntityDisplayName(strategy, "未命名同步策略")}</option>)}
            </PolicySelect>
          </label>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-zinc-800/80 bg-black/20 px-3 py-2 text-[10px]">
          <span className="mr-1 font-medium text-zinc-400">飞书优先级 → TB</span>
          {priorityRows.map((row) => (
            <span key={row.source} className="rounded-full border border-cyan-900/60 bg-cyan-950/25 px-2 py-1 text-cyan-200">
              {row.source} → {row.label}<span className="ml-1 text-cyan-700">({row.target ?? "-"})</span>
            </span>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap gap-1 border-b border-zinc-800 bg-zinc-950/80 px-3 py-2">
        {VIEWS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setView(id)}
            className={`rounded-md px-3 py-1.5 text-xs transition ${view === id ? "bg-cyan-500/15 text-cyan-200 ring-1 ring-cyan-700/60" : "text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300"}`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="p-4">
        {view === "rules" && <PolicyRulesEditor routing={routing} readOnly={readOnly} onChange={(rules) => setRouting("rules", rules)} />}
        {view === "targets" && (
          <PolicyTargetsEditor
            config={config}
            routing={routing}
            readOnly={readOnly}
            tbProjects={tbProjects}
            tbTasklists={tbTasklists}
            tbSprints={tbSprints}
            onLoadTbProjects={onLoadTbProjects}
            onLoadTbTasklists={onLoadTbTasklists}
            onLoadTbSprints={onLoadTbSprints}
            onChange={(targets) => setRouting("targets", targets)}
          />
        )}
        {view === "strategies" && <PolicyStrategiesEditor routing={routing} readOnly={readOnly} onChange={(strategies) => setRouting("strategies", strategies)} />}
        {view === "preview" && <PolicyPreview config={config} readOnly={readOnly} onPreview={onPreview} />}
      </div>
    </section>
  );
}

function PolicyRulesEditor({ routing, readOnly, onChange }) {
  const ordered = policyRulesByPriority(routing.rules);
  const updateRule = (index, patch) => onChange(updatePolicyEntry(routing.rules, index, patch));
  const updateCondition = (ruleIndex, conditionIndex, patch) => {
    const conditions = (routing.rules[ruleIndex]?.conditions || []).map((condition, index) => index === conditionIndex ? { ...condition, ...patch } : condition);
    updateRule(ruleIndex, { conditions });
  };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="text-xs text-zinc-400">优先级数字越大越先执行；默认采用首条命中规则。</div>
        <button type="button" disabled={readOnly} onClick={() => onChange([...routing.rules, createPolicyRule(routing)])} className="ml-auto rounded-md bg-cyan-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-cyan-500 disabled:bg-zinc-800 disabled:text-zinc-600">新增规则</button>
      </div>
      {ordered.map(({ rule, index }, rank) => (
        <div key={`${rule.id}-${index}`} className={`rounded-lg border p-3 ${rule.enabled !== false ? "border-cyan-900/70 bg-zinc-950/90" : "border-zinc-800 bg-zinc-950/50"}`}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded bg-cyan-500/10 px-2 py-1 text-[10px] font-semibold text-cyan-200">优先顺序 #{rank + 1}</span>
            <PolicyToggle label={rule.enabled !== false ? "生效中" : "已停用"} checked={rule.enabled !== false} disabled={readOnly} onChange={(enabled) => updateRule(index, { enabled })} />
            {rule.builtin && <span className="rounded border border-violet-800/50 bg-violet-950/25 px-2 py-0.5 text-[10px] text-violet-300">内置兼容规则</span>}
            <button type="button" disabled={readOnly || rule.builtin} onClick={() => onChange(routing.rules.filter((_, current) => current !== index))} className="ml-auto rounded border border-zinc-800 px-2 py-1 text-[10px] text-zinc-500 hover:border-red-800 hover:text-red-300 disabled:opacity-40">删除</button>
          </div>
          <PolicyRuleReadableSummary rule={rule} routing={routing} />
          <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
            <PolicyInput label="规则名称" value={rule.name} disabled={readOnly} onChange={(name) => updateRule(index, { name })} className="xl:col-span-2" />
            <PolicyInput label="优先级" type="number" value={rule.priority ?? 0} disabled={readOnly} onChange={(priority) => updateRule(index, { priority: Number(priority) || 0 })} />
            <PolicyLabeledSelect label="目标档案" value={rule.targetId || routing.defaultTargetId} disabled={readOnly} onChange={(targetId) => updateRule(index, { targetId })} options={routing.targets.map((target) => [target.id, policyEntityDisplayName(target, "未命名目标档案")])} />
            <PolicyLabeledSelect label="同步策略" value={rule.strategyId || routing.defaultStrategyId} disabled={readOnly} onChange={(strategyId) => updateRule(index, { strategyId })} options={routing.strategies.map((strategy) => [strategy.id, policyEntityDisplayName(strategy, "未命名同步策略")])} />
          </div>
          <TechnicalIdDetails label="规则技术标识" value={rule.id} disabled={readOnly || rule.builtin} onChange={(id) => updateRule(index, { id })} />
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-zinc-900 pt-3">
            <span className="text-[11px] text-zinc-500">条件关系</span>
            <PolicySelect value={rule.match || "all"} disabled={readOnly} onChange={(match) => updateRule(index, { match })}>
              <option value="all">全部满足 (AND)</option>
              <option value="any">任一满足 (OR)</option>
            </PolicySelect>
            <button type="button" disabled={readOnly} onClick={() => updateRule(index, { conditions: [...(rule.conditions || []), createPolicyCondition()] })} className="rounded border border-zinc-700 px-2.5 py-1 text-[11px] text-zinc-300 hover:bg-zinc-900 disabled:text-zinc-600">添加条件</button>
          </div>
          <div className="mt-2 space-y-2">
            {(rule.conditions || []).map((condition, conditionIndex) => (
              <div key={conditionIndex} className="rounded border border-zinc-900 bg-zinc-900/40 p-2">
                <div className="mb-2 text-[11px] font-medium text-cyan-200">{policyConditionSummary(condition)}</div>
                <div className="grid gap-2 lg:grid-cols-[150px_150px_1fr_1fr_34px]">
                  <PolicySelect value={condition.field || "source.projectKey"} disabled={readOnly} onChange={(field) => updateCondition(index, conditionIndex, { field })}>
                    {POLICY_CONDITION_FIELDS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </PolicySelect>
                  <PolicySelect value={condition.operator || "equals"} disabled={readOnly} onChange={(operator) => updateCondition(index, conditionIndex, { operator })}>
                    {POLICY_OPERATORS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </PolicySelect>
                  <textarea value={stringifyPolicyLines(condition.values)} disabled={readOnly || ["exists", "empty"].includes(condition.operator)} onChange={(event) => updateCondition(index, conditionIndex, { values: parsePolicyLines(event.target.value) })} placeholder="匹配值，每行一个" className="min-h-9 rounded border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-200 outline-none focus:border-cyan-700 disabled:text-zinc-600" />
                  {condition.field === "fields" ? (
                    <input value={stringifyPolicyLines(condition.fieldNames)} disabled={readOnly} onChange={(event) => updateCondition(index, conditionIndex, { fieldNames: parsePolicyLines(event.target.value) })} placeholder="飞书字段显示名称，如：功能模块" className="h-9 rounded border border-zinc-800 bg-zinc-950 px-2 text-xs text-zinc-200 outline-none focus:border-cyan-700" />
                  ) : <div className="flex items-center text-[10px] text-zinc-600">标准字段已使用可读名称</div>}
                  <button type="button" disabled={readOnly} onClick={() => updateRule(index, { conditions: rule.conditions.filter((_, current) => current !== conditionIndex) })} className="rounded border border-zinc-800 text-zinc-500 hover:text-red-300 disabled:opacity-40">×</button>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  <PolicyToggle label="区分大小写" checked={condition.caseSensitive === true} disabled={readOnly} onChange={(caseSensitive) => updateCondition(index, conditionIndex, { caseSensitive })} />
                  {condition.field === "fields" && (
                    <details className="text-[10px] text-zinc-500">
                      <summary className="cursor-pointer hover:text-zinc-300">飞书字段技术 Key（仅名称无法唯一定位时填写）</summary>
                      <input value={stringifyPolicyLines(condition.fieldKeys)} disabled={readOnly} onChange={(event) => updateCondition(index, conditionIndex, { fieldKeys: parsePolicyLines(event.target.value) })} placeholder="每行一个字段 Key" className="mt-2 h-9 min-w-72 rounded border border-zinc-800 bg-zinc-950 px-2 font-mono text-xs text-zinc-200 outline-none focus:border-cyan-700" />
                    </details>
                  )}
                </div>
              </div>
            ))}
            {!(rule.conditions || []).length && <div className="rounded border border-amber-800/40 bg-amber-950/20 px-3 py-2 text-xs text-amber-200">无条件规则会命中所有工单，请确认优先级和目标。</div>}
          </div>
        </div>
      ))}
      {!ordered.length && <PolicyEmpty title="尚未配置路由规则" detail="所有工单暂时使用默认目标与默认策略。" />}
    </div>
  );
}

function PolicyTargetsEditor({ config, routing, readOnly, tbProjects, tbTasklists, tbSprints, onLoadTbProjects, onLoadTbTasklists, onLoadTbSprints, onChange }) {
  const projects = tbProjects?.projects || [];
  const tasklists = tbTasklists?.tasklists || [];
  const sprints = tbSprints?.sprints || [];
  const updateTarget = (index, patch) => onChange(updatePolicyEntry(routing.targets, index, patch));
  const updateConfig = (index, patch) => onChange(updatePolicyEntryConfig(routing.targets, index, patch));
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
        目标档案集中维护 Project、任务列表、迭代和默认负责人；规则通过档案名称选择目标。
        <button type="button" disabled={readOnly} onClick={() => onChange([...routing.targets, createPolicyTarget()])} className="ml-auto rounded-md bg-cyan-600 px-3 py-1.5 text-xs text-white hover:bg-cyan-500 disabled:bg-zinc-800 disabled:text-zinc-600">新增目标档案</button>
      </div>
      {routing.targets.map((target, index) => {
        const effective = target.inheritLegacy === false ? (target.config || {}) : { ...(config?.teambition || {}), ...(target.config || {}) };
        return (
          <div key={`${target.id}-${index}`} className="rounded-lg border border-zinc-800 bg-zinc-950/90 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <PolicyToggle label={target.enabled !== false ? "可用" : "停用"} checked={target.enabled !== false} disabled={readOnly} onChange={(enabled) => updateTarget(index, { enabled })} />
              {target.builtin && <span className="rounded border border-violet-800/50 px-2 py-0.5 text-[10px] text-violet-300">内置档案</span>}
              <span className="text-[10px] text-zinc-600">{target.inheritLegacy === false ? "独立配置" : "继承主目标，按需覆盖"}</span>
              <button type="button" disabled={readOnly || target.builtin} onClick={() => onChange(routing.targets.filter((_, current) => current !== index))} className="ml-auto rounded border border-zinc-800 px-2 py-1 text-[10px] text-zinc-500 hover:text-red-300 disabled:opacity-40">删除</button>
            </div>
            <div className="mt-3 rounded border border-cyan-950/70 bg-cyan-950/10 px-3 py-2 text-[11px] text-zinc-300">
              {Object.values(policyTargetSummary(target, config?.teambition || {})).join(" / ")}
            </div>
            <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              <PolicyInput label="档案名称" value={target.name} disabled={readOnly} onChange={(name) => updateTarget(index, { name })} />
              <PolicyLabeledSelect label="Target 类型" value={target.system || "teambition"} disabled={readOnly} onChange={(system) => updateTarget(index, { system })} options={[["teambition", "Teambition"], ["jira", "JIRA（待适配器）"], ["redmine", "Redmine（待适配器）"], ["zentao", "禅道（待适配器）"], ["gitlab", "GitLab Issue（待适配器）"], ["github", "GitHub Issue（待适配器）"]]} />
              <PolicyToggle label="继承主目标" checked={target.inheritLegacy !== false} disabled={readOnly} onChange={(inheritLegacy) => updateTarget(index, { inheritLegacy })} />
            </div>
            <TechnicalIdDetails label="档案技术标识" value={target.id} disabled={readOnly || target.builtin} onChange={(id) => updateTarget(index, { id })} />
            {target.system === "teambition" && (
              <div className="mt-3 grid gap-3 border-t border-zinc-900 pt-3 md:grid-cols-2 xl:grid-cols-4">
                <PolicyLabeledSelect label="Project" value={effective.projectId || ""} disabled={readOnly} onFocus={() => onLoadTbProjects?.()} onChange={(projectId) => { const row = projects.find((entry) => String(entry.id) === projectId) || {}; updateConfig(index, { projectId, projectName: row.name || "" }); onLoadTbTasklists?.({ projectId, refresh: true }); onLoadTbSprints?.({ projectId, refresh: true }); }} options={[[effective.projectId || "", effective.projectName || "项目名称未解析"], ...projects.filter((row) => row.id !== effective.projectId).map((row) => [row.id, row.name || "项目名称未解析"])]} />
                <PolicyLabeledSelect label="Tasklist" value={effective.tasklistId || ""} disabled={readOnly} onFocus={() => onLoadTbTasklists?.({ allProjects: true })} onChange={(tasklistId) => { const row = tasklists.find((entry) => String(entry.id || entry.tasklistId) === tasklistId) || {}; updateConfig(index, { tasklistId, tasklistName: row.name || row.title || "", projectPathName: row.pathName || row.projectPathName || "", projectId: row.projectId || effective.projectId }); }} options={[[effective.tasklistId || "", effective.projectPathName || effective.tasklistName || "任务列表名称未解析"], ...tasklists.filter((row) => String(row.id || row.tasklistId) !== String(effective.tasklistId)).map((row) => [row.id || row.tasklistId, row.pathName || row.projectPathName || row.name || row.title || "任务列表名称未解析"])]} />
                <PolicyLabeledSelect label="迭代" value={effective.sprintId || ""} disabled={readOnly} onFocus={() => onLoadTbSprints?.({ projectId: effective.projectId })} onChange={(sprintId) => { const row = sprints.find((entry) => String(entry.id || entry.sprintId) === sprintId) || {}; updateConfig(index, { sprintId, sprintName: row.name || row.title || "", sprintUrl: row.url || "" }); }} options={[[effective.sprintId || "", effective.sprintName || "迭代名称未解析"], ...sprints.filter((row) => String(row.id || row.sprintId) !== String(effective.sprintId)).map((row) => [row.id || row.sprintId, row.name || row.title || "迭代名称未解析"])]} />
                <PolicyInput label="默认负责人姓名" value={effective.defaultExecutorName || ""} disabled={readOnly} onChange={(defaultExecutorName) => updateConfig(index, { defaultExecutorName })} />
                <PolicyInput label="项目归属 / 业务线" value={effective.projectPathName || ""} disabled={readOnly} onChange={(projectPathName) => updateConfig(index, { projectPathName })} className="xl:col-span-2" />
                <details className="xl:col-span-2 rounded border border-zinc-900 bg-zinc-950/60 px-3 py-2 text-[10px] text-zinc-500">
                  <summary className="cursor-pointer hover:text-zinc-300">技术标识（仅下拉无法解析或排障时编辑）</summary>
                  <div className="mt-3 grid gap-3 md:grid-cols-2">
                    <PolicyInput label="Project ID" value={effective.projectId || ""} disabled={readOnly} mono onChange={(projectId) => updateConfig(index, { projectId })} />
                    <PolicyInput label="Tasklist ID" value={effective.tasklistId || ""} disabled={readOnly} mono onChange={(tasklistId) => updateConfig(index, { tasklistId })} />
                    <PolicyInput label="Sprint ID" value={effective.sprintId || ""} disabled={readOnly} mono onChange={(sprintId) => updateConfig(index, { sprintId })} />
                    <PolicyInput label="默认负责人 ID" value={effective.defaultExecutorId || ""} disabled={readOnly} mono onChange={(defaultExecutorId) => updateConfig(index, { defaultExecutorId })} />
                  </div>
                </details>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function PolicyStrategiesEditor({ routing, readOnly, onChange }) {
  const updateStrategy = (index, patch) => onChange(updatePolicyEntry(routing.strategies, index, patch));
  const updateField = (strategyIndex, field, patch) => updateStrategy(strategyIndex, {
    fields: {
      ...(routing.strategies[strategyIndex]?.fields || {}),
      [field]: { ...(routing.strategies[strategyIndex]?.fields?.[field] || {}), ...patch },
    },
  });
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
        每个策略独立控制标题、描述、附件、评论、状态、标签、优先级、负责人和字段映射。
        <button type="button" disabled={readOnly} onClick={() => onChange([...routing.strategies, createPolicyStrategy()])} className="ml-auto rounded-md bg-cyan-600 px-3 py-1.5 text-xs text-white hover:bg-cyan-500 disabled:bg-zinc-800 disabled:text-zinc-600">新增同步策略</button>
      </div>
      {routing.strategies.map((strategy, index) => (
        <div key={`${strategy.id}-${index}`} className="rounded-lg border border-zinc-800 bg-zinc-950/90 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <PolicyToggle label={strategy.enabled !== false ? "可用" : "停用"} checked={strategy.enabled !== false} disabled={readOnly} onChange={(enabled) => updateStrategy(index, { enabled })} />
            {strategy.builtin && <span className="rounded border border-violet-800/50 px-2 py-0.5 text-[10px] text-violet-300">兼容策略</span>}
            <button type="button" disabled={readOnly || strategy.builtin} onClick={() => onChange(routing.strategies.filter((_, current) => current !== index))} className="ml-auto rounded border border-zinc-800 px-2 py-1 text-[10px] text-zinc-500 hover:text-red-300 disabled:opacity-40">删除</button>
          </div>
          <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <PolicyInput label="策略名称" value={strategy.name} disabled={readOnly} onChange={(name) => updateStrategy(index, { name })} />
            <PolicyInput label="标题模板（留空继承）" value={strategy.titleTemplate || ""} disabled={readOnly} onChange={(titleTemplate) => updateStrategy(index, { titleTemplate })} className="xl:col-span-2" />
          </div>
          <TechnicalIdDetails label="策略技术标识" value={strategy.id} disabled={readOnly || strategy.builtin} onChange={(id) => updateStrategy(index, { id })} />
          <div className="mt-3 overflow-x-auto rounded border border-zinc-900">
            <table className="w-full min-w-[720px] text-left text-xs">
              <thead className="bg-zinc-900/70 text-[10px] uppercase tracking-wide text-zinc-500"><tr><th className="px-3 py-2">字段</th><th className="px-3 py-2">是否同步</th><th className="px-3 py-2">同步方式</th><th className="px-3 py-2">说明</th></tr></thead>
              <tbody>
                {POLICY_FIELD_DEFINITIONS.map((field) => {
                  const policy = strategy.fields?.[field.key] || {};
                  return (
                    <tr key={field.key} className="border-t border-zinc-900">
                      <td className="px-3 py-2 font-medium text-zinc-200">{field.label}</td>
                      <td className="px-3 py-2"><PolicyToggle label={policy.enabled !== false ? "同步" : "不更新"} checked={policy.enabled !== false} disabled={readOnly} onChange={(enabled) => updateField(index, field.key, { enabled })} /></td>
                      <td className="px-3 py-2"><PolicySelect value={policy.mode || field.modes[0][0]} disabled={readOnly} onChange={(mode) => updateField(index, field.key, { mode })}>{field.modes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</PolicySelect></td>
                      <td className="px-3 py-2 text-[11px] text-zinc-500">{field.key === "title" ? "TB 创建时标题必填；关闭仅影响后续更新。" : policy.enabled === false ? "创建与更新均不写入该字段。" : "按本策略处理。"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}

function PolicyPreview({ config, readOnly, onPreview }) {
  const sampleRule = policyRulesByPriority(policyRoutingForUi(config).rules)
    .find(({ rule }) => rule.enabled !== false)?.rule || null;
  const [sample, setSample] = useState(() => JSON.stringify(policyPreviewSample(), null, 2));
  const [action, setAction] = useState("update");
  const [state, setState] = useState({ loading: false, error: "", data: null });
  const decision = state.data?.policyDecision;
  const run = async () => {
    setState({ loading: true, error: "", data: null });
    try {
      const data = await onPreview?.(JSON.parse(sample), action);
      setState({ loading: false, error: "", data });
    } catch (error) {
      setState({ loading: false, error: error?.message || String(error), data: null });
    }
  };
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
      <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="text-xs font-medium text-zinc-200">工单样例</div>
          <button type="button" onClick={() => setSample(JSON.stringify(policyPreviewSample(), null, 2))} className="ml-auto rounded border border-zinc-700 px-2 py-1 text-[10px] text-zinc-300 hover:bg-zinc-900">默认目标样例</button>
          <button type="button" disabled={!sampleRule} onClick={() => setSample(JSON.stringify(policyPreviewSample(sampleRule), null, 2))} className="rounded border border-zinc-700 px-2 py-1 text-[10px] text-zinc-300 hover:bg-zinc-900 disabled:text-zinc-700">{sampleRule ? `${policyEntityDisplayName(sampleRule, "未命名规则")}样例` : "暂无可用规则"}</button>
        </div>
        <textarea value={sample} onChange={(event) => setSample(event.target.value)} className="mt-3 min-h-[340px] w-full rounded border border-zinc-800 bg-black/40 p-3 font-mono text-xs leading-relaxed text-zinc-300 outline-none focus:border-cyan-700" />
        <div className="mt-3 flex items-center gap-2">
          <PolicySelect value={action} onChange={setAction}><option value="create">模拟创建</option><option value="update">模拟更新</option></PolicySelect>
          <button type="button" disabled={readOnly || state.loading || !onPreview} onClick={run} className="rounded bg-cyan-600 px-4 py-2 text-xs font-medium text-white hover:bg-cyan-500 disabled:bg-zinc-800 disabled:text-zinc-600">{state.loading ? "正在计算" : "预览规则命中"}</button>
          <span className="text-[10px] text-zinc-600">纯预览，不写 TB、不写同步记录</span>
        </div>
        {state.error && <div className="mt-3 rounded border border-red-800/50 bg-red-950/25 px-3 py-2 text-xs text-red-200">{state.error}</div>}
      </div>
      <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
        {!decision ? <PolicyEmpty title="等待预览" detail="选择样例或粘贴飞书工单 JSON，即可查看命中规则、目标档案、策略字段和逐条判断。" /> : (
          <div className="space-y-3">
            <div className={`rounded-lg border p-3 ${decision.matched ? "border-emerald-800/60 bg-emerald-950/20" : "border-amber-800/60 bg-amber-950/20"}`}>
              <div className="text-[10px] uppercase tracking-widest text-zinc-500">Rule decision</div>
              <div className="mt-1 text-sm font-semibold text-zinc-100">{decision.matched ? `命中：${policyEntityDisplayName(decision.matchedRule, "未命名规则")}` : "未命中特定规则，已使用默认路由"}</div>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <DecisionValue label="目标档案" value={`${policyEntityDisplayName(decision.target, "未命名目标档案")} · ${decision.target?.system}`} />
                <DecisionValue label="同步策略" value={policyEntityDisplayName(decision.strategy, "未命名同步策略")} />
                <DecisionValue label="项目 / 任务列表" value={`${decision.target?.config?.projectPathName || decision.target?.config?.projectName || "项目名称未解析"} / ${decision.target?.config?.tasklistName || "任务列表名称未解析"}`} />
                <DecisionValue label="迭代" value={decision.target?.config?.sprintName || "迭代名称未解析"} />
              </div>
            </div>
            <div>
              <div className="mb-2 text-[11px] font-medium text-zinc-300">字段策略结果</div>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {(state.data?.strategyEffects || []).map((effect) => <DecisionValue key={effect.field} label={effect.field} value={`${effect.action} · ${effect.mode}`} />)}
              </div>
            </div>
            <div>
              <div className="mb-2 text-[11px] font-medium text-zinc-300">规则判断轨迹</div>
              <div className="max-h-64 space-y-2 overflow-auto pr-1">
                {(decision.trace || []).map((trace) => (
                  <div key={trace.ruleId} className={`rounded border px-3 py-2 text-[11px] ${trace.matched ? "border-emerald-800/50 bg-emerald-950/15 text-emerald-200" : "border-zinc-800 bg-zinc-900/40 text-zinc-500"}`}>
                    <div className="flex items-center gap-2"><span>{trace.matched ? "✓" : "—"}</span><span className="font-medium">{trace.ruleName || "未命名规则"}</span><span className="ml-auto">优先级 {trace.priority}</span></div>
                    {(trace.conditions || []).map((condition, index) => <div key={index} className="mt-1 text-[10px] opacity-80">{policyConditionSummary({ ...condition, values: condition.expected })} → {condition.matched ? "命中" : "未命中"}</div>)}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function PolicyMetric({ label, value }) {
  return <div className="min-w-16 rounded border border-cyan-900/50 bg-black/20 px-2 py-1"><div className="text-sm font-semibold text-cyan-100">{value}</div><div className="text-zinc-500">{label}</div></div>;
}

function PolicyRuleReadableSummary({ rule, routing }) {
  const summary = policyRuleSummary(rule, routing);
  return (
    <div className="mt-3 rounded-lg border border-cyan-900/50 bg-cyan-950/15 px-3 py-2" data-testid={`policy-rule-summary-${rule.id}`}>
      <div className="text-[10px] uppercase tracking-wider text-cyan-700">当前生效条件</div>
      <div className="mt-1 text-xs leading-relaxed text-cyan-100">{summary.conditionText}</div>
      <div className="mt-1 text-[10px] text-zinc-500">命中后：{summary.targetName} / {summary.strategyName}</div>
    </div>
  );
}

function TechnicalIdDetails({ label, value, disabled, onChange }) {
  return (
    <details className="mt-2 text-[10px] text-zinc-600">
      <summary className="cursor-pointer hover:text-zinc-400">{label}（仅配置引用或排障时需要）</summary>
      <input value={value || ""} disabled={disabled} onChange={(event) => onChange?.(event.target.value)} className="mt-2 h-8 min-w-72 rounded border border-zinc-800 bg-zinc-950 px-2 font-mono text-[11px] text-zinc-300 outline-none focus:border-cyan-700 disabled:text-zinc-600" />
    </details>
  );
}

function PolicyInput({ label, value = "", onChange, disabled = false, mono = false, type = "text", className = "" }) {
  return <label className={`block ${className}`}><span className="mb-1 block text-[10px] text-zinc-500">{label}</span><input type={type} value={value ?? ""} disabled={disabled} onChange={(event) => onChange?.(event.target.value)} className={`h-9 w-full rounded border border-zinc-800 bg-zinc-950 px-2 text-xs text-zinc-200 outline-none focus:border-cyan-700 disabled:text-zinc-600 ${mono ? "font-mono" : ""}`} /></label>;
}

function PolicyLabeledSelect({ label, value, options, onChange, disabled = false, onFocus }) {
  const unique = useMemo(() => {
    const seen = new Set();
    return (options || []).filter(([optionValue]) => {
      const key = String(optionValue || "");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [options]);
  return <label className="block"><span className="mb-1 block text-[10px] text-zinc-500">{label}</span><PolicySelect value={value || ""} disabled={disabled} onFocus={onFocus} onChange={onChange}>{unique.map(([optionValue, optionLabel]) => <option key={optionValue || "empty"} value={optionValue}>{optionLabel || optionValue || "未配置"}</option>)}</PolicySelect></label>;
}

function PolicySelect({ value, onChange, disabled = false, onFocus, children }) {
  return <select value={value ?? ""} disabled={disabled} onFocus={onFocus} onChange={(event) => onChange?.(event.target.value)} className="h-9 min-w-0 rounded border border-zinc-800 bg-zinc-950 px-2 text-xs text-zinc-200 outline-none focus:border-cyan-700 disabled:text-zinc-600">{children}</select>;
}

function PolicyToggle({ label, checked, onChange, disabled = false }) {
  return <label className="inline-flex items-center gap-2 text-[11px] text-zinc-400"><input type="checkbox" checked={!!checked} disabled={disabled} onChange={(event) => onChange?.(event.target.checked)} className="accent-cyan-500" /><span>{label}</span></label>;
}

function PolicyEmpty({ title, detail }) {
  return <div className="flex min-h-40 flex-col items-center justify-center rounded-lg border border-dashed border-zinc-800 bg-zinc-950/60 px-6 text-center"><div className="text-sm font-medium text-zinc-300">{title}</div><div className="mt-1 max-w-xl text-xs leading-relaxed text-zinc-600">{detail}</div></div>;
}

function DecisionValue({ label, value }) {
  return <div className="rounded border border-zinc-800 bg-black/20 px-2.5 py-2"><div className="text-[9px] uppercase tracking-wider text-zinc-600">{label}</div><div className="mt-0.5 break-all text-[11px] text-zinc-300">{value || "-"}</div></div>;
}
