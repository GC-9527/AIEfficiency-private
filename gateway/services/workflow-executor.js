import { randomUUID } from "crypto";
import { log, broadcastWorkflowUpdate } from "./logger.js";
import { createTask, createWorkflowRun, updateWorkflowRun } from "../db/sqlite.js";
import { runTask } from "./agent-runner.js";
import { DAGScheduler } from "./dag-scheduler.js";

// 活跃的工作流运行实例
export const activeWorkflowRuns = new Map();

/**
 * 执行工作流
 *
 * 内置机制（用户不可见）：
 * - Commander：工作流 config.commander.enabled=true 时，执行前 AI 自动分解用户输入为步骤
 * - Inspector：步骤 inspect=true 时，执行后 AI 自动审查该步骤输出，不合格重试
 */
export async function executeWorkflow(workflow, runId, inputVars = {}, sessionId = null, triggerSource = "web") {
  let steps = typeof workflow.steps === "string" ? JSON.parse(workflow.steps) : workflow.steps;
  const parentTaskId = randomUUID();
  const variables = { ...inputVars };
  const wfConfig = parseConfig(workflow.config);
  const roleStates = {};

  // 创建父任务
  createTask({
    id: parentTaskId,
    title: `工作流: ${workflow.name}`,
    description: `执行工作流 "${workflow.name}"`,
    type: "multi_step",
    status: "running",
    priority: 3,
    source: triggerSource,
    sourceId: sessionId,
  });

  // ===== 内置 Commander 阶段 =====
  // 触发条件：config.commander.enabled = true
  // 用户不需要创建 commander 步骤，系统自动在执行前用 AI 分解需求
  const cmdConfig = wfConfig?.roles?.commander;
  if (cmdConfig?.enabled) {
    // 使用 inputVars.input 或第一个步骤的 prompt 作为分解输入
    const cmdInput = inputVars.input || steps[0]?.prompt || "";
    if (cmdInput) {
      log(parentTaskId, "info", "commander", "统领者正在分解任务...");
      broadcastWorkflowUpdate(runId, sessionId, { status: "decomposing", stepStates: {}, workflowName: workflow.name });

      try {
        const decomposed = await runCommander(cmdInput, cmdConfig, parentTaskId, sessionId);
        if (decomposed && decomposed.length > 0) {
          steps = decomposed;
          log(parentTaskId, "info", "commander", `分解为 ${steps.length} 个步骤`);
        }
      } catch (err) {
        log(parentTaskId, "warn", "commander", `分解失败，使用原始步骤: ${err.message}`);
      }
    }
  }

  // 初始化 stepStates
  let stepStates = {};
  for (const step of steps) {
    stepStates[step.id] = { status: "pending", output: null, startedAt: null, completedAt: null };
  }

  // 创建 workflow_runs 记录
  createWorkflowRun({
    id: runId,
    workflowId: workflow.id,
    status: "running",
    stepStates: JSON.stringify(stepStates),
    variables: JSON.stringify(variables),
    parentTaskId,
    triggerSource,
    sessionId,
  });

  // 广播步骤元信息供前端渲染
  const stepsInfo = steps.map(s => ({
    id: s.id,
    title: s.title,
    dependsOn: s.dependsOn || [],
    engine: s.engine || "auto",
    inspect: s.inspect || false,
  }));
  broadcastWorkflowUpdate(runId, sessionId, { status: "running", stepStates, workflowName: workflow.name, steps: stepsInfo });
  log(parentTaskId, "info", "workflow", `开始执行: ${workflow.name} (${steps.length} 步)`);

  // 构造 DAGScheduler subtaskDefs
  const subtaskDefs = steps.map((step) => ({
    id: step.id,
    title: step.title,
    description: step.prompt || step.title,
    type: "general",
    engine: step.engine === "auto" ? undefined : step.engine,
    dependsOn: step.dependsOn || [],
    timeout: step.timeout,
    skill: step.skill || null,
    outputVar: step.outputVar || null,
    inspect: step.inspect || false,
  }));

  const scheduler = new DAGScheduler(subtaskDefs, parentTaskId, sessionId);
  const runState = { scheduler, aborted: false };
  activeWorkflowRuns.set(runId, runState);

  // 全局审查配置（最大重试次数、引擎等）
  const inspectorEngine = wfConfig?.roles?.inspector?.engine || null;
  const maxRetries = wfConfig?.roles?.inspector?.maxRetries || 3;

  // 劫持 runSubtask
  const originalRunSubtask = scheduler.runSubtask.bind(scheduler);
  scheduler.runSubtask = async function (subtaskId) {
    if (runState.aborted) return;

    const node = this.nodes.get(subtaskId);
    if (!node) return;

    const stepDef = steps.find((s) => s.id === subtaskId);
    const originalDescription = node.def.description;

    // 变量替换
    node.def.description = substituteVars(node.def.description, variables);

    // 更新状态 → running
    stepStates[subtaskId] = { ...stepStates[subtaskId], status: "running", startedAt: new Date().toISOString() };
    updateWorkflowRun(runId, { stepStates: JSON.stringify(stepStates) });
    broadcastWorkflowUpdate(runId, sessionId, { stepId: subtaskId, stepStatus: "running", stepStates });

    // 执行步骤
    await originalRunSubtask(subtaskId);

    let completedNode = this.nodes.get(subtaskId);
    let output = completedNode.result?.output || completedNode.result?.report || "";

    // ===== 内置 Inspector 审查（步骤级开关） =====
    const shouldInspect = stepDef?.inspect === true;
    if (shouldInspect && completedNode.status === "completed") {
      roleStates[subtaskId] = { inspections: [], retryCount: 0, currentAttempt: 1 };

      for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
        if (runState.aborted) break;

        // 广播审查状态
        stepStates[subtaskId] = { ...stepStates[subtaskId], status: "inspecting" };
        broadcastWorkflowUpdate(runId, sessionId, {
          stepId: subtaskId, stepStatus: "inspecting", stepStates,
          inspectAttempt: attempt, maxRetries,
        });
        log(parentTaskId, "info", "inspector", `审查 "${stepDef.title}" (第${attempt}次)`);

        // 执行审查
        const inspectResult = await runInspection(subtaskId, stepDef, output, inspectorEngine, parentTaskId, sessionId);

        roleStates[subtaskId].inspections.push({
          attempt,
          verdict: inspectResult.verdict,
          reason: inspectResult.reason,
          suggestions: inspectResult.suggestions || "",
          inspectedAt: new Date().toISOString(),
        });

        if (inspectResult.verdict === "pass") {
          log(parentTaskId, "info", "inspector", `"${stepDef.title}" 审查通过: ${inspectResult.reason}`);
          completedNode.status = "completed";
          stepStates[subtaskId] = { ...stepStates[subtaskId], status: "completed" };
          broadcastWorkflowUpdate(runId, sessionId, {
            stepId: subtaskId, stepStatus: "completed", stepStates,
            inspectVerdict: "pass", inspectReason: inspectResult.reason,
          });
          break;
        }

        log(parentTaskId, "warn", "inspector", `"${stepDef.title}" 未通过: ${inspectResult.reason}`);

        if (attempt >= maxRetries + 1) {
          log(parentTaskId, "error", "inspector", `"${stepDef.title}" 超过最大重试次数(${maxRetries})`);
          completedNode.status = "failed";
          stepStates[subtaskId] = { ...stepStates[subtaskId], status: "failed" };
          broadcastWorkflowUpdate(runId, sessionId, {
            stepId: subtaskId, stepStatus: "failed", stepStates,
            inspectVerdict: "fail", inspectReason: `超过最大重试次数(${maxRetries})`,
          });
          break;
        }

        // 注入反馈重试
        roleStates[subtaskId].retryCount++;
        roleStates[subtaskId].currentAttempt = attempt + 1;

        stepStates[subtaskId] = { ...stepStates[subtaskId], status: "retrying" };
        broadcastWorkflowUpdate(runId, sessionId, {
          stepId: subtaskId, stepStatus: "retrying", stepStates,
          retryAttempt: attempt + 1, inspectReason: inspectResult.reason,
        });

        node.def.description = substituteVars(originalDescription, variables)
          + `\n\n## 监察者反馈 (第${attempt}次审查未通过)\n`
          + `问题: ${inspectResult.reason}\n`
          + `建议: ${inspectResult.suggestions}\n`
          + `\n请根据以上反馈重新完成任务。`;

        node.status = "running";
        stepStates[subtaskId] = { ...stepStates[subtaskId], status: "running", startedAt: new Date().toISOString() };
        broadcastWorkflowUpdate(runId, sessionId, { stepId: subtaskId, stepStatus: "running", stepStates });

        await originalRunSubtask(subtaskId);
        completedNode = this.nodes.get(subtaskId);
        output = completedNode.result?.output || completedNode.result?.report || "";
      }

      updateWorkflowRun(runId, { roleStates: JSON.stringify(roleStates) });
    }

    // 存输出变量
    if (stepDef?.outputVar) {
      variables[stepDef.outputVar] = output;
    }

    stepStates[subtaskId] = {
      ...stepStates[subtaskId],
      status: completedNode.status,
      output: output.slice(0, 5000),
      completedAt: new Date().toISOString(),
    };
    updateWorkflowRun(runId, { stepStates: JSON.stringify(stepStates), variables: JSON.stringify(variables) });
    broadcastWorkflowUpdate(runId, sessionId, {
      stepId: subtaskId, stepStatus: completedNode.status, stepStates,
      output: output.slice(0, 2000),
    });
  };

  try {
    await scheduler.execute();
    const finalStatus = Array.from(scheduler.nodes.values()).some((n) => n.status === "failed") ? "failed" : "completed";
    updateWorkflowRun(runId, { status: finalStatus, stepStates: JSON.stringify(stepStates), variables: JSON.stringify(variables) });
    broadcastWorkflowUpdate(runId, sessionId, { status: finalStatus, stepStates });
    log(parentTaskId, "info", "workflow", `工作流完成: ${workflow.name} (${finalStatus})`);
    return { status: finalStatus, stepStates, variables };
  } catch (err) {
    const status = runState.aborted ? "aborted" : "failed";
    updateWorkflowRun(runId, { status, stepStates: JSON.stringify(stepStates) });
    broadcastWorkflowUpdate(runId, sessionId, { status, stepStates, error: err.message });
    log(parentTaskId, "error", "workflow", `工作流${status === "aborted" ? "已终止" : "失败"}: ${err.message}`);
    throw err;
  } finally {
    activeWorkflowRuns.delete(runId);
  }
}

export function abortWorkflowRun(runId) {
  const runState = activeWorkflowRuns.get(runId);
  if (!runState) return false;
  runState.aborted = true;
  runState.scheduler.abort();
  return true;
}

// ===== Commander =====

async function runCommander(inputPrompt, cmdConfig, parentTaskId, sessionId) {
  const taskId = randomUUID();
  const task = {
    id: taskId,
    title: "[统领] 任务分解",
    description: `## 需要分解的任务\n\n${inputPrompt}\n\n请将上述任务分解为可执行的步骤序列。`,
    type: "general",
    status: "pending",
    priority: 1,
    source: "web",
    sourceId: sessionId,
    parentTaskId,
    subtaskId: "_commander",
    explicitSkill: cmdConfig.skill || "workflow-commander",
    explicitEngine: cmdConfig.engine || null,
  };

  createTask(task);
  const result = await runTask(task);

  const jsonMatch = result.output.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error("Commander 输出未包含有效的步骤 JSON 数组");

  const parsed = JSON.parse(jsonMatch[0]);
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("Commander 返回空步骤列表");

  for (const step of parsed) {
    if (!step.id || !step.title) throw new Error(`步骤缺少 id 或 title`);
    step.dependsOn = step.dependsOn || [];
    step.engine = step.engine || "auto";
    step.inspect = step.inspect ?? false;
  }
  return parsed;
}

// ===== Inspector =====

async function runInspection(subtaskId, stepDef, output, inspectorEngine, parentTaskId, sessionId) {
  const taskId = randomUUID();
  const inspectPrompt = [
    `## 审查任务`,
    `### 步骤: ${stepDef.title}`,
    `### 执行指令:\n${stepDef.prompt || stepDef.title}`,
    `### 执行输出:\n${output.slice(0, 4000)}`,
    `\n请审查以上输出是否合格。`,
  ].join("\n");

  const task = {
    id: taskId,
    title: `[审查] ${stepDef.title}`,
    description: inspectPrompt,
    type: "general",
    status: "pending",
    priority: 2,
    source: "web",
    sourceId: sessionId,
    parentTaskId,
    subtaskId: `${subtaskId}_inspect`,
    explicitSkill: "workflow-inspector",
    explicitEngine: inspectorEngine,
  };

  try { createTask(task); } catch {}
  const result = await runTask(task);

  try {
    const jsonMatch = result.output.match(/\{[\s\S]*"verdict"[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.verdict === "pass" || parsed.verdict === "fail") return parsed;
    }
  } catch {}
  return { verdict: "pass", reason: "审查输出解析失败，默认通过", suggestions: "" };
}

// ===== Utils =====

function substituteVars(str, variables) {
  if (!str) return str;
  return str.replace(/\{\{(\w+)\}\}/g, (_, k) => variables[k] ?? "");
}

function parseConfig(config) {
  if (!config) return {};
  if (typeof config === "string") {
    try { return JSON.parse(config); } catch { return {}; }
  }
  return config;
}
