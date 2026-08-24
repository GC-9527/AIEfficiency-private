/**
 * 定时任务调度器
 * 启动时加载所有 enabled=1 的任务，注册到 node-cron
 */
import cron from "node-cron";
import { randomUUID } from "crypto";
import { listScheduledTasks, updateScheduledTask } from "../db/sqlite.js";
import { runTask } from "./agent-runner.js";
import { createTask } from "../db/sqlite.js";
import { sendOutput } from "./output-adapters.js";
import { log } from "./logger.js";

// taskId → cron.ScheduledTask
const activeCrons = new Map();

/**
 * 初始化：加载并注册所有启用的定时任务
 */
export function initScheduler() {
  const tasks = listScheduledTasks();
  let count = 0;
  for (const task of tasks) {
    if (task.enabled) {
      registerCron(task);
      count++;
    }
  }
  if (count > 0) {
    console.log(`[scheduler] 已加载 ${count} 个定时任务`);
  }
}

/**
 * 注册单个 cron 任务
 */
export function registerCron(task) {
  // 先移除旧的
  unregisterCron(task.id);

  if (!cron.validate(task.cron_expr)) {
    log("system", "warn", "scheduler", `无效的 cron 表达式: ${task.cron_expr} (任务: ${task.name})`);
    return false;
  }

  const job = cron.schedule(task.cron_expr, () => {
    executeScheduledTask(task).catch((err) => {
      log("system", "error", "scheduler", `定时任务执行异常: ${task.name} - ${err.message}`);
    });
  }, { timezone: "Asia/Shanghai" });

  activeCrons.set(task.id, job);
  log("system", "info", "scheduler", `注册定时任务: ${task.name} (${task.cron_expr})`);
  return true;
}

/**
 * 取消注册
 */
export function unregisterCron(taskId) {
  const job = activeCrons.get(taskId);
  if (job) {
    job.stop();
    activeCrons.delete(taskId);
  }
}

/**
 * 执行定时任务
 */
async function executeScheduledTask(scheduledTask) {
  const taskId = randomUUID();
  log("system", "info", "scheduler", `开始执行定时任务: ${scheduledTask.name}`);

  // 更新最后运行时间
  updateScheduledTask(scheduledTask.id, {
    lastRunAt: new Date().toISOString(),
    lastStatus: "running",
  });

  // 创建实际任务
  const task = {
    id: taskId,
    title: `[定时] ${scheduledTask.name}`,
    description: scheduledTask.prompt,
    type: "general",
    status: "pending",
    priority: 3,
    source: "schedule",
    sourceId: scheduledTask.id,
    explicitSkill: scheduledTask.skill || null,
    explicitEngine: scheduledTask.engine || null,
  };

  try {
    createTask(task);
    const result = await runTask(task);
    const output = result.output || result.report || "";

    // 发送到输出渠道
    await sendOutput(
      scheduledTask.output_target || "log",
      scheduledTask.output_config,
      output,
      scheduledTask.name
    );

    updateScheduledTask(scheduledTask.id, {
      lastStatus: "completed",
      lastOutputExcerpt: output.slice(0, 500),
    });

    log("system", "info", "scheduler", `定时任务完成: ${scheduledTask.name}`);
  } catch (err) {
    updateScheduledTask(scheduledTask.id, {
      lastStatus: "failed",
      lastOutputExcerpt: `错误: ${err.message}`.slice(0, 500),
    });
    log("system", "error", "scheduler", `定时任务失败: ${scheduledTask.name} - ${err.message}`);
  }
}

/**
 * 立即执行（手动触发）
 */
export async function runScheduledTaskNow(scheduledTask) {
  return executeScheduledTask(scheduledTask);
}

/**
 * 获取所有活跃 cron 的状态
 */
export function getActiveCount() {
  return activeCrons.size;
}
