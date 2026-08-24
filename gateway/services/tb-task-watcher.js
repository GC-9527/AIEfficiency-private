/**
 * Teambition 任务监控服务
 * 定时扫描分配给我的新任务，触发分析
 */
import cron from "node-cron";
import { getConfig } from "./config.js";
import { getMyTasks, getTaskCommentsWithStatus, searchTask } from "./teambition.js";

import { getTbTaskRecord, upsertTbTaskRecord, listTbTaskRecords, deleteTbTaskRecord } from "../db/sqlite.js";
import { analyzeTbTask, resumeSuspendedTask } from "./tb-task-analyzer.js";
import { log } from "./logger.js";

let cronJobs = [];

/**
 * 初始化（网关启动时调用）
 */
export function initTbTaskWatcher() {
  const config = getConfig();
  const watcher = config.tbTaskWatcher || {};
  if (!watcher.enabled) return;

  // 每天 9:00 和 18:00 自动扫描
  cronJobs.push(cron.schedule("0 9 * * *", () => syncAndAnalyze(), { timezone: "Asia/Shanghai" }));
  cronJobs.push(cron.schedule("0 18 * * *", () => syncAndAnalyze(), { timezone: "Asia/Shanghai" }));

  // 挂起任务每 15 分钟检查一次新评论（工作时间 8:00-20:00）
  cronJobs.push(cron.schedule("*/15 8-20 * * 1-5", () => checkSuspendedTasks(), { timezone: "Asia/Shanghai" }));

  console.log("[tb-watcher] TB 任务监控已启动（每天 9:00 / 18:00，挂起任务每 15 分钟检查）");
  log("system", "info", "tb-watcher", "TB 任务监控已启动");
}

/**
 * 扫描并分析新任务
 */
export async function syncAndAnalyze() {
  const config = getConfig();
  const watcher = config.tbTaskWatcher || {};
  if (!watcher.executorId) {
    log("system", "warn", "tb-watcher", "未配置 executorId，跳过扫描");
    return { scanned: 0, newTasks: 0 };
  }

  log("system", "info", "tb-watcher", "开始扫描 TB 任务...");

  try {
    const tasks = await getMyTasks(watcher.executorId, watcher.projectIds || []);
    log("system", "info", "tb-watcher", `扫描到 ${tasks.length} 个任务`);

    let newCount = 0;
    for (const task of tasks) {
      const taskId = task.taskId || task._id;
      const existing = getTbTaskRecord(taskId);

      if (existing && existing.status === "completed") {
        continue; // 已分析过
      }

      // 检查 TB 评论是否已有 AI 分析标记（仅自动扫描时跳过，不影响手动分析）
      if (!existing) {
        let hasAiComment = false;
        try {
          hasAiComment = await checkAiCommentExists(taskId);
        } catch (error) {
          log("system", "warn", "tb-watcher", `无法确认任务 ${taskId} 是否已有 AI 评论，跳过本轮自动分析: ${error.message}`);
          continue;
        }
        if (hasAiComment) {
          // 记录为已完成但不阻止重新分析
          const carbId = buildCarbId(task);
          upsertTbTaskRecord({
            id: taskId, carbId, title: task.content || "",
            status: "completed", analysisSummary: "（TB 上已有 AI 分析评论，可点重新分析获取完整报告）",
            commentPosted: 1, detectedAt: new Date().toISOString(),
          });
          continue;
        }
      }

      // 新任务或之前失败的 → 排队分析
      const carbId = (task.content || "").match(/CARB-\d+/)?.[0] || null;
      upsertTbTaskRecord({
        id: taskId, carbId, title: task.content || "",
        projectName: "", groupName: "",
        priority: ["紧急", "普通", "较低"][task.priority] || "普通",
        creatorId: task.creatorId || "", executorId: task.executorId || "",
        status: "pending", detectedAt: new Date().toISOString(),
      });
      newCount++;
    }

    log("system", "info", "tb-watcher", `发现 ${newCount} 个待分析任务`);

    // 逐个分析待处理任务（仅 analyzeEnabled 开启时；只同步不分析时可关掉）
    const analyzeEnabled = watcher.analyzeEnabled !== false;
    const pending = analyzeEnabled ? listTbTaskRecords({ status: "pending" }) : [];
    for (const record of pending) {
      try {
        await analyzeTbTask(record.id);
      } catch (err) {
        log("system", "error", "tb-watcher", `分析失败 ${record.carb_id || record.id}: ${err.message}`);
      }
    }

    // 检查挂起任务是否有新评论
    await checkSuspendedTasks();

    return { scanned: tasks.length, newTasks: newCount };
  } catch (err) {
    log("system", "error", "tb-watcher", `扫描失败: ${err.message}`);
    return { scanned: 0, newTasks: 0, error: err.message };
  }
}

/**
 * 检查挂起任务是否有新评论（补充资料后自动恢复）
 */
async function checkSuspendedTasks() {
  const suspended = listTbTaskRecords({ status: "suspended" });
  if (suspended.length === 0) return;

  log("system", "info", "tb-watcher", `检查 ${suspended.length} 个挂起任务的新评论`);

  for (const record of suspended) {
    try {
      const comments = await getTaskComments(record.id);
      // 只看挂起之后的新评论（排除 AI 自己发的）
      const suspendedAt = new Date(record.analyzed_at || record.detected_at).getTime();
      const newHumanComments = comments.filter(c => {
        let content = c.content;
        if (typeof content === "string") {
          try { content = JSON.parse(content); } catch {}
        }
        const text = content?.comment || content || "";
        const isAi = typeof text === "string" && (text.includes("🤖") || text.includes("AI 分析") || text.includes("NEED_MORE_INFO") || text.includes("⏸️"));
        const commentTime = new Date(c.created || c.createTime || 0).getTime();
        return !isAi && commentTime > suspendedAt;
      });

      if (newHumanComments.length > 0) {
        log("system", "info", "tb-watcher", `挂起任务 ${record.carb_id || record.id} 有 ${newHumanComments.length} 条新评论，恢复分析`);
        try {
          await resumeSuspendedTask(record.id, newHumanComments);
        } catch (err) {
          log("system", "error", "tb-watcher", `恢复分析失败 ${record.id}: ${err.message}`);
        }
      }
    } catch (err) {
      log("system", "debug", "tb-watcher", `检查挂起任务评论失败 ${record.id}: ${err.message}`);
    }
  }
}

/**
 * 分析指定任务
 * 支持输入: CARB-8728 / 8728 / MongoDB ObjectId
 */
export async function analyzeSpecificTask(taskIdOrCarbId) {
  const input = taskIdOrCarbId.trim();
  // 提取纯数字编号（CARB-8728 → 8728，8728 → 8728）
  const uniqueIdMatch = input.match(/^(?:CARB-)?(\d+)$/i);
  const uniqueIdNum = uniqueIdMatch ? parseInt(uniqueIdMatch[1]) : null;

  // 先查本地是否已有记录（按 id / carb_id 匹配，排除临时 pending 记录）
  let record = getTbTaskRecord(input);
  if (!record && uniqueIdNum) {
    record = getTbTaskRecord(`CARB-${uniqueIdNum}`);
  }
  // pending_ 开头的是临时占位记录，不是真实 TB 任务，需要重新搜索
  if (record && record.id.startsWith("pending_")) {
    record = null;
  }

  if (!record) {
    log("system", "info", "tb-watcher", `本地无记录，从 TB 拉取: ${input}`);

    // 按项目全量搜索（不限执行人，覆盖所有分页）
    const match = await findTaskInProject(input, uniqueIdNum);

    if (!match) throw new Error(`未找到任务: ${input}（尝试了 uniqueId=${uniqueIdNum}、taskId、标题匹配）`);

    const taskId = match.taskId || match._id;
    const carbId = buildCarbId(match);

    // 删除同 carbId 的临时 pending 记录（由 /analyze 路由预创建，避免重复）
    if (carbId) {
      const existing = listTbTaskRecords({ limit: 50 }).filter(
        r => r.carb_id === carbId && r.id.startsWith("pending_")
      );
      for (const old of existing) deleteTbTaskRecord(old.id);
    }

    upsertTbTaskRecord({
      id: taskId, carbId, title: match.content || "",
      priority: ["紧急", "普通", "较低"][match.priority] || "普通",
      creatorId: match.creatorId || "", executorId: match.executorId || "",
      status: "pending", detectedAt: new Date().toISOString(),
    });
    record = getTbTaskRecord(taskId);
  }

  await analyzeTbTask(record.id);
  return getTbTaskRecord(record.id);
}

/**
 * 精准搜索任务（开放平台 API，按 uniqueId / taskId 查）
 */
async function findTaskInProject(input, uniqueIdNum) {
  const found = await searchTask(input);
  if (found) {
    log("system", "info", "tb-watcher", `找到任务: ${found.taskId} uniqueId=${found.uniqueId} (${found.content?.slice(0, 40)})`);
    return found;
  }
  return null;
}

/**
 * 检查任务评论中是否已有 AI 分析标记
 */
async function checkAiCommentExists(taskId) {
  const result = await getTaskCommentsWithStatus(taskId);
  if (!result.available) throw new Error(result.error || "TB 评论数据源不可用");
  if (!result.complete) throw new Error(result.error || "TB 评论读取不完整");
  return result.items.some(c => {
    let content = c.content ?? c.comment ?? "";
    if (typeof content === "string") {
      try { content = JSON.parse(content); } catch {}
    }
    const text = typeof content === "object"
      ? String(content?.comment || content?.title || "")
      : String(content || "");
    return text.includes("🤖") || text.includes("AI 自动") || text.includes("AI 分析");
  });
}

/**
 * 生成 CARB ID
 * 优先用 uniqueId（真实企业），fallback 从标题解析（测试企业）
 */
function buildCarbId(task) {
  if (task.uniqueId) return `CARB-${task.uniqueId}`;
  const match = (task.content || "").match(/CARB-\d+/);
  return match ? match[0] : null;
}

export function stopTbTaskWatcher() {
  cronJobs.forEach(j => j.stop());
  cronJobs = [];
}
