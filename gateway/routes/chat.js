import { Router } from "express";
import { randomUUID } from "crypto";
import {
  addChatMessage,
  getChatMessages,
  clearChatMessages,
  createTask,
  updateTask,
  getTask,
  createChatSession,
  listChatSessions,
  getChatSession,
  updateChatSession,
  updateChatSessionCliId,
  deleteChatSession,
  getSessionMessages,
  getSessionMessageCount,
} from "../db/sqlite.js";
import { classifyTask, dispatch as dispatchTask, needsDecomposition, parseExplicitSkill } from "../services/dispatcher.js";
import { runTask } from "../services/agent-runner.js";
import { log, broadcastChatMessage, broadcastDecomposition, broadcastSubtaskUpdate } from "../services/logger.js";
import { getModificationSkills } from "../services/capability-doc.js";
import { decomposeTask, summarizeResults, planTask } from "../services/task-decomposer.js";
import { DAGScheduler } from "../services/dag-scheduler.js";
import { getConfig } from "../services/config.js";
import { executeWorkflow } from "../services/workflow-executor.js";
import { maybeGenerateSummary } from "../services/context-manager.js";
import { runLLM as runLLMFromDecomposer } from "../services/task-decomposer.js";
import { requestPrincipal } from "../services/admin-auth.js";

const router = Router();

router.use((req, res, next) => {
  const environment = String(process.env.NODE_ENV || "").trim().toLowerCase();
  if (
    environment === "test"
    || (
      environment === "development"
      && String(process.env.AIEFFICIENCY_ALLOW_UNAUTHENTICATED_CHAT_API || "") === "1"
    )
  ) return next();
  const principal = requestPrincipal(req);
  if (!principal) {
    return res.status(401).json({
      success: false,
      code: "CHAT_API_AUTH_REQUIRED",
      error: "AI 对话执行接口要求已认证身份",
    });
  }
  req.principal = principal;
  return next();
});

// 活跃的 DAG 调度器（parentTaskId → DAGScheduler），供 tasks.js stop 路由使用
export const activeSchedulers = new Map();

// 任务是否已被用户停止：stop 路由会把 running/pending 任务置为 failed。
// 规划/降级等异步收尾路径必须复查，避免把已停止的任务"复活"继续执行。
function isTaskStopped(taskId) {
  const t = getTask(taskId);
  return !t || t.status === "failed" || t.status === "completed";
}

// ========== 会话路由 ==========

// 列出所有会话
router.get("/sessions", (req, res) => {
  const { limit } = req.query;
  const sessions = listChatSessions({ limit: limit ? parseInt(limit) : 50 });
  res.json({ success: true, data: sessions });
});

// 创建新会话
router.post("/sessions", (req, res) => {
  const id = randomUUID();
  const title = req.body.title || "新对话";
  createChatSession(id, title);
  const session = getChatSession(id);
  res.json({ success: true, data: session });
});

// 更新会话（修改标题自动锁定 / 切换置顶）
router.put("/sessions/:id", (req, res) => {
  const session = getChatSession(req.params.id);
  if (!session) return res.status(404).json({ success: false, error: "会话不存在" });
  const { title, pinned } = req.body;
  const updates = {};
  if (typeof title === "string") {
    if (!title.trim()) return res.status(400).json({ success: false, error: "标题不能为空" });
    updates.title = title.trim().slice(0, 80);
    updates.title_locked = 1;
  }
  if (pinned !== undefined) {
    updates.pinned = pinned ? 1 : 0;
  }
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ success: false, error: "无可更新字段" });
  }
  updateChatSession(req.params.id, updates);
  const updated = getChatSession(req.params.id);
  res.json({ success: true, data: updated });
});

// 删除会话
router.delete("/sessions/:id", (req, res) => {
  const session = getChatSession(req.params.id);
  if (!session) return res.status(404).json({ success: false, error: "会话不存在" });
  deleteChatSession(req.params.id);
  res.json({ success: true });
});

// 工具：根据 sessionId 找到正在运行的 DAG 调度器
function findActiveSchedulerBySession(sessionId) {
  for (const scheduler of activeSchedulers.values()) {
    if (scheduler.sessionId === sessionId) return scheduler;
  }
  return null;
}

// 给运行中的子任务追加补充上下文（不立即重试）
router.post("/sessions/:id/subtask/:subId/supplement", (req, res) => {
  const sessionId = req.params.id;
  const subId = req.params.subId;
  const { content } = req.body;
  if (!content?.trim()) return res.status(400).json({ success: false, error: "补充内容不能为空" });

  const scheduler = findActiveSchedulerBySession(sessionId);
  if (!scheduler) return res.status(404).json({ success: false, error: "未找到运行中的 DAG 调度器" });

  const ok = scheduler.addSupplement(subId, content.trim());
  if (!ok) return res.status(404).json({ success: false, error: "子任务不存在" });
  res.json({ success: true });
});

// 重试失败的子任务（可选携带补充信息）
router.post("/sessions/:id/subtask/:subId/retry", async (req, res) => {
  const sessionId = req.params.id;
  const subId = req.params.subId;
  const { supplement } = req.body || {};

  const scheduler = findActiveSchedulerBySession(sessionId);
  if (!scheduler) return res.status(404).json({ success: false, error: "未找到运行中的 DAG 调度器（可能已结束）" });

  // 异步触发重试，立即返回响应
  res.json({ success: true, data: { message: "重试已触发" } });

  scheduler.retrySubtask(subId, supplement?.trim() || null).catch((err) => {
    log(scheduler.parentTaskId, "error", "dag-scheduler", `重试子任务异常: ${err.message}`);
  });
});

// 获取会话消息（支持分页：offset=0 取最新 limit 条）
router.get("/sessions/:id/messages", (req, res) => {
  const session = getChatSession(req.params.id);
  if (!session) return res.status(404).json({ success: false, error: "会话不存在" });
  const { limit, offset } = req.query;
  const opts = { limit: limit ? parseInt(limit) : 200 };
  if (offset !== undefined) opts.offset = parseInt(offset);
  const messages = getSessionMessages(req.params.id, opts).map((m) => {
    if (m.transcript_json) {
      try { m.transcript = JSON.parse(m.transcript_json); } catch {}
    }
    delete m.transcript_json;
    return m;
  });
  const total = getSessionMessageCount(req.params.id);
  res.json({ success: true, data: messages, total });
});

// 在会话内发送消息
router.post("/sessions/:id/send", async (req, res) => {
  const sessionId = req.params.id;
  const session = getChatSession(sessionId);
  if (!session) return res.status(404).json({ success: false, error: "会话不存在" });

  const { content } = req.body;
  if (!content?.trim()) {
    return res.status(400).json({ success: false, error: "消息不能为空" });
  }

  const text = content.trim();

  // 保存用户消息
  addChatMessage("user", text, null, null, sessionId);

  // 首条消息时自动设置会话标题（仅未锁定时）
  const existingMessages = getSessionMessages(sessionId, { limit: 1 });
  if (existingMessages.length <= 1 && !session?.title_locked) {
    updateChatSession(sessionId, { title: text.slice(0, 40) });
  } else {
    // 更新会话时间
    updateChatSession(sessionId, {});
  }

  const taskId = randomUUID();

  // 解析显式 /skill-name 命令
  const explicit = parseExplicitSkill(text);

  // 工作流触发路径
  if (explicit?.workflow) {
    const workflow = explicit.workflow;
    const runId = randomUUID();
    addChatMessage("assistant", `正在执行工作流: ${workflow.name}`, null, "workflow", sessionId);
    broadcastChatMessage({
      role: "assistant",
      content: `正在执行工作流: ${workflow.name}`,
      engine: "workflow",
      session_id: sessionId,
      created_at: new Date().toISOString(),
    });

    res.json({
      success: true,
      data: { taskId, type: "workflow", sessionId, engine: "workflow", workflowRunId: runId },
    });

    executeWorkflow(workflow, runId, { input: explicit.rest || text }, sessionId, "chat")
      .then((result) => {
        const report = `工作流 "${workflow.name}" 执行完成 (${result.status})`;
        addChatMessage("assistant", report, null, "workflow", sessionId);
        broadcastChatMessage({
          role: "assistant",
          content: report,
          engine: "workflow",
          session_id: sessionId,
          created_at: new Date().toISOString(),
        });
      })
      .catch((err) => {
        const errMsg = `工作流执行失败: ${err.message}`;
        addChatMessage("assistant", errMsg, null, "workflow", sessionId);
        broadcastChatMessage({
          role: "assistant",
          content: errMsg,
          engine: "workflow",
          session_id: sessionId,
          created_at: new Date().toISOString(),
        });
      });
    return;
  }

  const effectiveText = explicit ? (explicit.rest || text) : text;
  const config = getConfig();

  // ===== 快速路径：显式 /skill 命令，跳过 AI 规划 =====
  if (explicit?.skill) {
    const taskType = classifyTask(effectiveText);
    const dispatchInfo = dispatchTask({
      id: taskId, title: text.slice(0, 80), description: effectiveText,
      type: taskType, explicitSkill: explicit.skill,
    });
    const cliSessionId = dispatchInfo.engine === "claude" ? session.claude_session_id : session.gemini_session_id;
    const task = {
      id: taskId, title: text.slice(0, 80), description: effectiveText || text,
      type: taskType, status: "pending", priority: 3, source: "web", sourceId: sessionId,
      cliSessionId: cliSessionId || null, explicitSkill: explicit.skill,
    };
    if (!task.cliSessionId) {
      task.chatHistory = getSessionMessages(sessionId, { limit: 20 }).slice(0, -1);
    }
    createTask(task);
    log(taskId, "info", "chat", `快速路径: /${explicit.skill} → ${dispatchInfo.engine}`);

    runSingleTask(task, dispatchInfo, sessionId);
    res.json({ success: true, data: { taskId, type: taskType, sessionId, engine: dispatchInfo.engine, skill: dispatchInfo.skill } });
    return;
  }

  // ===== 路径选择：简单任务直接执行，复合任务才走 AI 规划 =====
  const taskType = classifyTask(effectiveText);
  const shouldPlan = config.enableDecomposition && needsDecomposition(text);

  // 预调度（regex 分类）
  const dispatchInfo = dispatchTask({
    id: taskId, title: text.slice(0, 80), description: effectiveText, type: taskType,
  });
  const cliSessionId = dispatchInfo.engine === "claude" ? session.claude_session_id : session.gemini_session_id;

  // 构建基础任务对象
  const task = {
    id: taskId, title: text.slice(0, 80), description: effectiveText || text,
    type: taskType, status: "pending", priority: 3, source: "web", sourceId: sessionId,
    cliSessionId: cliSessionId || null, explicitSkill: dispatchInfo.skill || null,
  };
  if (!task.cliSessionId) {
    task.chatHistory = getSessionMessages(sessionId, { limit: 20 }).slice(0, -1);
  }
  createTask(task);

  if (!shouldPlan) {
    // ===== 简单任务：直接执行（不走 AI 规划，零额外开销） =====
    log(taskId, "info", "chat", `直接执行: ${task.title} (${taskType}) → ${dispatchInfo.engine}${dispatchInfo.skill ? ` /${dispatchInfo.skill}` : ""}`);
    res.json({
      success: true,
      data: { taskId, type: taskType, sessionId, engine: dispatchInfo.engine, skill: dispatchInfo.skill },
    });
    runSingleTask(task, dispatchInfo, sessionId);
    return;
  }

  // ===== 复合任务：AI 智能规划 =====
  const planEngine = config.decompositionEngine || "gemini";
  res.json({
    success: true,
    data: { taskId, type: taskType, sessionId, engine: planEngine, planning: true },
  });

  const dagStartTime = Date.now();
  (async () => {
    try {
      log(taskId, "info", "planner", "检测到复合任务，AI 正在规划...");
      const plan = await planTask(text, planEngine);

      // 规划期间用户可能已点击停止（stop 路由已将任务置 failed）：禁止复活
      if (isTaskStopped(taskId)) {
        log(taskId, "warn", "planner", "任务在规划期间已被用户停止，放弃继续执行");
        return;
      }

      if (plan.needsSplit && plan.tasks.length > 1) {
        // ===== 多任务：DAG 调度 =====
        const subtaskDefs = plan.tasks.map(t => ({
          id: t.id, title: t.title, description: t.description, type: "general",
          engine: t.engine === "auto" ? undefined : t.engine,
          dependsOn: t.dependsOn || [], skill: t.skill || null, inspect: t.inspect || false,
        }));

        const scheduler = new DAGScheduler(subtaskDefs, taskId, sessionId);

        // 注册调度器与置 running 必须在同一同步块内完成（中间无 await）：
        // 用户点击停止要么命中上方 isTaskStopped 检查（未启动）、要么命中已注册的
        // 调度器（stop 路由 abort 生效），不存在"停止够不到"的窗口。
        if (isTaskStopped(taskId)) {
          log(taskId, "warn", "planner", "任务在规划完成到启动子任务之间已被用户停止，放弃执行");
          return;
        }
        activeSchedulers.set(taskId, scheduler);
        updateTask(taskId, { status: "running", decomposition: JSON.stringify(plan) });
        log(taskId, "info", "planner", `规划为 ${plan.tasks.length} 个子任务`);
        broadcastDecomposition(taskId, sessionId, { subtasks: plan.tasks });

        const originalRun = scheduler.runSubtask.bind(scheduler);
        scheduler.runSubtask = async function(subtaskId) {
          await originalRun(subtaskId);
          const node = this.nodes.get(subtaskId);
          const taskDef = plan.tasks.find(t => t.id === subtaskId);
          if (config.enableInspection && taskDef?.inspect && node?.status === "completed") {
            await inspectSubtask(node, taskDef, taskId, sessionId);
          }
        };

        const results = await scheduler.execute();
        activeSchedulers.delete(taskId);

        // 子任务执行期间用户可能已点击停止（stop 路由 abort 调度器并将父任务置 failed）：
        // 不得再执行汇总并把状态覆盖为 completed。
        if (isTaskStopped(taskId)) {
          log(taskId, "warn", "chat", "任务在子任务执行期间已被用户停止，跳过汇总");
          return;
        }

        log(taskId, "info", "chat", "所有子任务完成，开始汇总...");
        const summary = await summarizeResults(text, results, config.summaryEngine || "gemini", sessionId, taskId);

        // 汇总期间用户可能已点击停止（stop 路由已把任务置 failed）：不得覆盖为 completed
        if (isTaskStopped(taskId)) {
          log(taskId, "warn", "chat", "任务在汇总期间已被用户停止，放弃完成收尾");
          return;
        }

        const dagDuration = Date.now() - dagStartTime;
        updateTask(taskId, { status: "completed", result: JSON.stringify({ plan, results }), report: summary });
        addChatMessage("assistant", summary, taskId, "multi", sessionId);
        broadcastChatMessage({
          role: "assistant", content: summary, task_id: taskId, engine: "multi",
          session_id: sessionId, decomposed: true, subtaskCount: plan.tasks.length,
          duration: dagDuration, created_at: new Date().toISOString(),
        });
      } else {
        // AI 判定不需要拆分 → 用 AI 分配的 Skill 执行
        const planned = plan.tasks[0];
        if (planned.skill) task.explicitSkill = planned.skill;
        log(taskId, "info", "planner", `AI 判定无需拆分${planned.skill ? `, Skill: /${planned.skill}` : ""}`);
        if (isTaskStopped(taskId)) {
          log(taskId, "warn", "planner", "任务在规划判定期间已被用户停止，放弃继续执行");
          return;
        }
        await runSingleTask(task, dispatchInfo, sessionId);
      }
    } catch (err) {
      activeSchedulers.delete(taskId);
      log(taskId, "warn", "chat", `AI 规划失败 (${err.message})，使用 regex 分类直接执行`);
      // 降级：任务对象已创建，直接执行即可（但用户已停止时不得复活）
      if (isTaskStopped(taskId)) {
        log(taskId, "warn", "chat", "任务在规划失败降级前已被用户停止，放弃继续执行");
        return;
      }
      await runSingleTask(task, dispatchInfo, sessionId);
    }
  })();
});

function partialTextFromTranscript(transcript = []) {
  if (!Array.isArray(transcript)) return "";
  const parts = transcript
    .filter((item) => item && item.type === "text" && item.content)
    .map((item) => String(item.content));
  if (!parts.length) return "";
  return parts.join("\n\n").trim();
}

function failureMessageWithPartial(err) {
  const base = `执行失败: ${err?.message || "未知错误"}`;
  const partial = String(err?.partialOutput || "").trim() || partialTextFromTranscript(err?.transcript);
  if (!partial) return base;
  return `${partial.trimEnd()}\n\n---\n${base}`;
}

// 抽取单任务执行逻辑
async function runSingleTask(task, dispatchInfo, sessionId) {
  const startTime = Date.now();
  try {
    const result = await runTask(task);
    // 保存 CLI 返回的 session_id 供后续续接
    if (result.cliSessionId) {
      updateChatSessionCliId(sessionId, dispatchInfo.engine, result.cliSessionId);
    }

    let report = result.report || result.output || "";

    // 单任务监察：涉及修改的 Skill 自动审查
    const config = getConfig();
    if (config.enableInspection && report) {
      const modSkills = getModificationSkills();
      const skill = dispatchInfo.skill || task.explicitSkill || "";
      if (modSkills.has(skill)) {
        log(task.id, "info", "inspector", `单任务涉及修改 (/${skill})，触发监察审查`);
        const verdict = await runInspectionOnOutput(
          task.title, task.description, report, task.id, sessionId, skill
        );

        if (verdict.verdict === "fail" && (config.maxInspectionRetries ?? 1) > 0) {
          // 重试
          log(task.id, "warn", "inspector", `审查未通过，重试中: ${verdict.reason}`);
          const retryDesc = `${task.description}\n\n---\n## 审查反馈（请修正）\n- 问题: ${verdict.reason}\n- 建议: ${verdict.suggestions || "请改进输出质量"}`;
          const retryTask = {
            ...task, id: randomUUID(), description: retryDesc, status: "pending",
          };
          try { createTask(retryTask); } catch {}
          try {
            const retryResult = await runTask(retryTask);
            const retryReport = retryResult.report || retryResult.output || "";
            const retryVerdict = await runInspectionOnOutput(task.title, retryDesc, retryReport, task.id, sessionId, skill);
            if (retryVerdict.verdict === "pass") {
              report = retryReport;
              report += `\n\n<!-- INSPECT:${JSON.stringify({ verdict: "pass", reason: "经审查修正后通过", retried: true })} -->`;
            } else {
              report = retryReport;
              report += `\n\n<!-- INSPECT:${JSON.stringify({ verdict: "fail", reason: retryVerdict.reason, suggestions: retryVerdict.suggestions, retried: true })} -->`;
            }
          } catch (err) {
            log(task.id, "error", "inspector", `重试失败: ${err.message}`);
            report += `\n\n<!-- INSPECT:${JSON.stringify({ verdict: "fail", reason: verdict.reason, suggestions: verdict.suggestions, retried: false })} -->`;
          }
        } else if (verdict.verdict === "fail") {
          report += `\n\n<!-- INSPECT:${JSON.stringify({ verdict: "fail", reason: verdict.reason, suggestions: verdict.suggestions, retried: false })} -->`;
        } else {
          report += `\n\n<!-- INSPECT:${JSON.stringify({ verdict: "pass", reason: verdict.reason || "审查通过", retried: false })} -->`;
        }
      }
    }

    const duration = Date.now() - startTime;
    const transcript = Array.isArray(result.transcript) && result.transcript.length > 0 ? result.transcript : null;
    addChatMessage("assistant", report, task.id, dispatchInfo.engine, sessionId, transcript);
    broadcastChatMessage({
      role: "assistant",
      content: report,
      task_id: task.id,
      engine: dispatchInfo.engine,
      session_id: sessionId,
      duration,
      transcript,
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    const duration = Date.now() - startTime;
    const errMsg = failureMessageWithPartial(err);
    const transcript = Array.isArray(err.transcript) && err.transcript.length > 0 ? err.transcript : null;
    addChatMessage("assistant", errMsg, task.id, dispatchInfo.engine || null, sessionId, transcript);
    broadcastChatMessage({
      role: "assistant",
      content: errMsg,
      task_id: task.id,
      engine: dispatchInfo.engine || null,
      session_id: sessionId,
      duration,
      transcript,
      created_at: new Date().toISOString(),
    });
  }

  // 异步触发对话摘要（不阻塞响应）
  if (sessionId) {
    maybeGenerateSummary(sessionId, runLLMFromDecomposer).catch(() => {});
  }
}

// ========== 审查辅助函数 ==========

function createTaskRecord(taskId, text, type, sessionId) {
  const task = {
    id: taskId, title: text.slice(0, 80), description: text,
    type, status: "running", priority: 3, source: "web", sourceId: sessionId,
  };
  try { createTask(task); } catch {}
  return task;
}

// 按 Skill 类型的差异化审查侧重点
const SKILL_INSPECT_CRITERIA = {
  "smali-analyze": "代码修改类：重点审查语法是否正确、修改逻辑是否合理、是否有安全隐患、是否包含 diff/patch 或修改说明",
  "coding-agent": "代码修改类：重点审查代码语法、逻辑合理性、是否有安全漏洞、是否说明了修改原因",
  "resolution-adapt": "适配类：重点审查是否包含目标分辨率/DPI 参数、设备覆盖是否完整、是否有回退方案",
  "apk-repack": "打包类：重点审查流程是否完整、签名方式是否说明、是否有验证步骤",
  "bug-report": "分析报告类：重点审查是否有明确结论、证据是否充分、是否有根因分析和复现步骤",
};

/**
 * 智能截断输出：保留头部和尾部（关键信息通常在首尾）
 */
function smartTruncateOutput(output, maxLen = 5000) {
  if (output.length <= maxLen) return output;
  const headLen = Math.floor(maxLen * 0.5);
  const tailLen = Math.floor(maxLen * 0.4);
  return output.slice(0, headLen) + "\n\n...(省略中间部分)...\n\n" + output.slice(-tailLen);
}

async function runInspectionOnOutput(title, description, output, parentTaskId, sessionId, skill = "") {
  const config = getConfig();
  const truncated = smartTruncateOutput(output);

  // 差异化审查标准
  const extraCriteria = SKILL_INSPECT_CRITERIA[skill] || "";
  const criteriaLine = extraCriteria ? `\n### 审查侧重点\n${extraCriteria}\n` : "";

  const inspectPrompt = [
    `## 审查任务`,
    `### 步骤: ${title}`,
    `### 执行指令:\n${description}`,
    criteriaLine,
    `### 执行输出:\n${truncated}`,
    `\n请审查以上输出是否合格。`,
  ].filter(Boolean).join("\n");

  const inspectEngine = config.inspectionEngine || "gemini";
  const inspectTask = {
    id: randomUUID(),
    title: `[审查] ${title}`,
    description: inspectPrompt,
    type: "general",
    status: "pending",
    priority: 2,
    source: "web",
    sourceId: sessionId,
    parentTaskId,
    explicitSkill: "workflow-inspector",
    explicitEngine: inspectEngine,
  };

  try { createTask(inspectTask); } catch {}
  const result = await runTask(inspectTask);

  try {
    const jsonMatch = result.output.match(/\{[\s\S]*"verdict"[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.verdict === "pass" || parsed.verdict === "fail") return parsed;
    }
  } catch {}
  return { verdict: "pass", reason: "审查输出解析失败，默认通过", suggestions: "" };
}

async function inspectSubtask(node, taskDef, parentTaskId, sessionId) {
  const output = node.result?.output || node.result?.report || "";
  if (!output) return;

  const config = getConfig();
  const maxRetries = config.maxInspectionRetries ?? 1;
  const skill = taskDef.skill || "";

  // 广播：开始审查
  broadcastSubtaskUpdate(parentTaskId, sessionId, taskDef.id, "inspecting", null);

  const result = await runInspectionOnOutput(taskDef.title, taskDef.description, output, parentTaskId, sessionId, skill);

  if (result.verdict === "fail" && maxRetries > 0) {
    // 重试：将审查反馈注入原描述，重新执行
    log(parentTaskId, "warn", "inspector", `子任务 "${taskDef.title}" 审查未通过，重试中: ${result.reason}`);
    broadcastSubtaskUpdate(parentTaskId, sessionId, taskDef.id, "retrying", null);

    const retryDesc = `${taskDef.description}\n\n---\n## 审查反馈（请根据以下意见修正）\n- 问题: ${result.reason}\n- 建议: ${result.suggestions || "请改进输出质量"}`;
    const retryTask = {
      id: randomUUID(),
      title: taskDef.title,
      description: retryDesc,
      type: "general",
      status: "pending",
      priority: 2,
      source: "web",
      sourceId: sessionId,
      parentTaskId,
      explicitSkill: skill || undefined,
    };
    try { createTask(retryTask); } catch {}

    try {
      const retryResult = await runTask(retryTask);
      const retryOutput = retryResult.output || retryResult.report || "";

      // 二次审查
      broadcastSubtaskUpdate(parentTaskId, sessionId, taskDef.id, "inspecting", null);
      const retryVerdict = await runInspectionOnOutput(taskDef.title, retryDesc, retryOutput, parentTaskId, sessionId, skill);

      if (retryVerdict.verdict === "pass") {
        log(parentTaskId, "info", "inspector", `子任务 "${taskDef.title}" 重试后审查通过`);
        node.result.output = retryOutput;
        node.result.report = retryOutput;
        node.result.inspectVerdict = "pass";
        node.result.inspectReason = "经审查修正后通过";
        node.result.inspectRetried = true;
      } else {
        log(parentTaskId, "warn", "inspector", `子任务 "${taskDef.title}" 重试后仍未通过: ${retryVerdict.reason}`);
        node.result.output = retryOutput;
        node.result.report = retryOutput;
        node.result.inspectVerdict = "fail";
        node.result.inspectReason = retryVerdict.reason;
        node.result.inspectRetried = true;
        node.result.inspectSuggestions = retryVerdict.suggestions;
      }
    } catch (err) {
      log(parentTaskId, "error", "inspector", `重试执行失败: ${err.message}`);
      node.result.inspectVerdict = "fail";
      node.result.inspectReason = result.reason;
      node.result.inspectRetried = false;
    }
  } else if (result.verdict === "fail") {
    log(parentTaskId, "warn", "inspector", `子任务 "${taskDef.title}" 审查未通过: ${result.reason}`);
    node.result.inspectVerdict = "fail";
    node.result.inspectReason = result.reason;
    node.result.inspectSuggestions = result.suggestions;
  } else {
    log(parentTaskId, "info", "inspector", `子任务 "${taskDef.title}" 审查通过`);
    node.result.inspectVerdict = "pass";
    node.result.inspectReason = result.reason || "审查通过";
  }

  // 广播：审查完成
  broadcastSubtaskUpdate(parentTaskId, sessionId, taskDef.id, "completed", null, {
    inspectVerdict: node.result.inspectVerdict,
    inspectReason: node.result.inspectReason,
    inspectRetried: node.result.inspectRetried || false,
  });
}

// ========== 兼容原有路由 ==========

// 获取聊天历史（全局）
router.get("/", (req, res) => {
  const { limit } = req.query;
  const messages = getChatMessages({ limit: limit ? parseInt(limit) : 50 });
  res.json({ success: true, data: messages.reverse() });
});

// 发送消息（兼容旧接口，无会话）
router.post("/send", async (req, res) => {
  const { content } = req.body;
  if (!content?.trim()) {
    return res.status(400).json({ success: false, error: "消息不能为空" });
  }

  const trimmed = content.trim();
  addChatMessage("user", trimmed);

  const taskId = randomUUID();
  const explicitOld = parseExplicitSkill(trimmed);
  const effectiveTextOld = explicitOld ? (explicitOld.rest || trimmed) : trimmed;
  const taskType = classifyTask(effectiveTextOld);

  const task = {
    id: taskId,
    title: trimmed.slice(0, 80),
    description: effectiveTextOld || trimmed,
    type: taskType,
    status: "pending",
    priority: 3,
    source: "web",
    sourceId: null,
    explicitSkill: explicitOld?.skill || null,
  };

  createTask(task);
  log(taskId, "info", "chat", `新对话任务: ${task.title} (${taskType})`);

  runTask(task)
    .then((result) => {
      const report = result.report || result.output || "";
      const transcript = Array.isArray(result.transcript) && result.transcript.length > 0 ? result.transcript : null;
      addChatMessage("assistant", report, taskId, task.assigned_engine, null, transcript);
      broadcastChatMessage({
        role: "assistant",
        content: report,
        task_id: taskId,
        engine: task.assigned_engine,
        session_id: null,
        transcript,
        created_at: new Date().toISOString(),
      });
    })
    .catch((err) => {
      const errMsg = failureMessageWithPartial(err);
      const transcript = Array.isArray(err.transcript) && err.transcript.length > 0 ? err.transcript : null;
      addChatMessage("assistant", errMsg, taskId, task.assigned_engine || null, null, transcript);
      broadcastChatMessage({
        role: "assistant",
        content: errMsg,
        task_id: taskId,
        engine: task.assigned_engine || null,
        session_id: null,
        transcript,
        created_at: new Date().toISOString(),
      });
    });

  const dispatchInfo = dispatchTask(task);

  res.json({
    success: true,
    data: { taskId, type: taskType, engine: dispatchInfo.engine, skill: dispatchInfo.skill },
  });
});

// 清空聊天
router.delete("/", (req, res) => {
  clearChatMessages();
  res.json({ success: true });
});

export default router;
