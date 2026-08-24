/**
 * 工作报告生成服务
 * 聚合多数据源 → AI 总结 → 输出 Markdown 文件
 */
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { getConfig } from "./config.js";
import { getTasksInRange, checkTeambitionStatus } from "./teambition.js";
import { log } from "./logger.js";
import { runTask } from "./agent-runner.js";
import { createTask, getChatMessagesInRange, getTasksInRange as getLocalTasksInRange } from "../db/sqlite.js";
import { randomUUID } from "crypto";
import * as devbenchStore from "./devbench/store.js";
import { collectGitData, getAuthoritativeWorkReportRepositories } from "./work-report-repositories.js";

// ========== 时间范围计算 ==========

/**
 * 根据报告类型计算时间范围
 * @param {"week"|"month"|"quarter"|"year"} period
 * @param {string} [refDate] - 参考日期 (YYYY-MM-DD)，默认今天
 * @returns {{ since: string, until: string, label: string }}
 */
export function calcDateRange(period, refDate) {
  const ref = refDate ? new Date(refDate) : new Date();
  let since, until, label;

  switch (period) {
    case "week": {
      const day = ref.getDay() || 7; // 周日=7
      since = new Date(ref);
      since.setDate(ref.getDate() - day + 1); // 本周一
      until = new Date(since);
      until.setDate(since.getDate() + 6); // 本周日
      label = `${fmt(since)} ~ ${fmt(until)} 周报`;
      break;
    }
    case "month": {
      since = new Date(ref.getFullYear(), ref.getMonth(), 1);
      until = new Date(ref.getFullYear(), ref.getMonth() + 1, 0);
      label = `${ref.getFullYear()}年${ref.getMonth() + 1}月 月报`;
      break;
    }
    case "quarter": {
      const q = Math.floor(ref.getMonth() / 3);
      since = new Date(ref.getFullYear(), q * 3, 1);
      until = new Date(ref.getFullYear(), q * 3 + 3, 0);
      label = `${ref.getFullYear()}年Q${q + 1} 季报`;
      break;
    }
    case "year": {
      since = new Date(ref.getFullYear(), 0, 1);
      until = new Date(ref.getFullYear(), 11, 31);
      label = `${ref.getFullYear()}年 年报`;
      break;
    }
    default:
      throw new Error(`不支持的报告周期: ${period}`);
  }

  return { since: fmt(since), until: fmt(until), label };
}

function fmt(d) {
  return d.toISOString().slice(0, 10);
}

// ========== 数据采集 ==========

/**
 * 采集聊天记录摘要
 */
function collectChatData(since, until) {
  try {
    const messages = getChatMessagesInRange(since, until);

    const userMessages = messages.filter(m => m.role === "user");
    const assistantMessages = messages.filter(m => m.role === "assistant");

    // 提取用户请求摘要（去重，取前30条）
    const requests = [...new Set(userMessages.map(m => m.content.slice(0, 100)))].slice(0, 30);

    // 引擎使用统计
    const engineCounts = {};
    for (const m of assistantMessages) {
      if (m.engine) {
        engineCounts[m.engine] = (engineCounts[m.engine] || 0) + 1;
      }
    }

    return {
      totalMessages: messages.length,
      userRequests: userMessages.length,
      aiResponses: assistantMessages.length,
      engineCounts,
      requests,
    };
  } catch (err) {
    log("system", "warn", "report", `采集聊天数据失败: ${err.message}`);
    return { totalMessages: 0, userRequests: 0, aiResponses: 0, engineCounts: {}, requests: [] };
  }
}

/**
 * 采集任务完成统计
 */
function collectTaskData(since, until) {
  try {
    const tasks = getLocalTasksInRange(since, until);

    const statusCounts = {};
    const typeCounts = {};
    for (const t of tasks) {
      statusCounts[t.status || "unknown"] = (statusCounts[t.status || "unknown"] || 0) + 1;
      typeCounts[t.type || "general"] = (typeCounts[t.type || "general"] || 0) + 1;
    }

    return { total: tasks.length, statusCounts, typeCounts, tasks: tasks.slice(0, 50) };
  } catch (err) {
    log("system", "warn", "report", `采集任务数据失败: ${err.message}`);
    return { total: 0, statusCounts: {}, typeCounts: {}, tasks: [] };
  }
}

// ========== 报告生成 ==========

/**
 * 生成工作报告
 * @param {"week"|"month"|"quarter"|"year"} period
 * @param {object} options
 * @param {string} [options.refDate] - 参考日期
 * @param {string} [options.sessionId] - 聊天会话 ID（用于广播进度）
 * @returns {{ filePath: string, summary: string }}
 */
export async function generateReport(period, options = {}) {
  const config = getConfig();
  const { since, until, label } = calcDateRange(period, options.refDate);

  log("system", "info", "report", `开始生成 ${label}，范围 ${since} ~ ${until}`);

  // 1. 并行采集数据
  const gitRepos = await getAuthoritativeWorkReportRepositories(devbenchStore, config);
  const [gitData, chatData, taskData, tbStatus] = await Promise.all([
    Promise.resolve(collectGitData(gitRepos, since, until)),
    Promise.resolve(collectChatData(since, until)),
    Promise.resolve(collectTaskData(since, until)),
    checkTeambitionStatus(),
  ]);

  // TB 任务（如果可用）
  let tbData = [];
  if (tbStatus.available) {
    try {
      tbData = await getTasksInRange(since, until);
      log("system", "info", "report", `Teambition: 获取到 ${tbData.length} 条任务`);
    } catch (err) {
      log("system", "warn", "report", `Teambition 数据获取失败: ${err.message}`);
    }
  }

  // 2. 构建数据摘要（传给 AI）
  const dataSummary = buildDataSummary(label, since, until, gitData, chatData, taskData, tbData);

  // 3. 调用 AI 生成报告
  const aiPrompt = `## 任务：生成工作报告

请根据以下采集到的工作数据，生成一份专业的 ${label}。

${dataSummary}

## 报告要求
1. 使用 Markdown 格式
2. 包含以下章节：
   - 概述（一段话总结本周期的工作重点和成果）
   - 代码开发（基于 Git 提交，按项目分类总结）
   - 任务完成情况（基于平台任务和 Teambition 数据）
   - AI 工具使用情况（基于聊天和引擎统计）
   - 下周/下期计划（基于未完成任务和趋势推断）
3. 语言：中文
4. 语气：专业、简洁、有数据支撑
5. 开头用一级标题写报告名称和时间范围`;

  let reportContent;
  try {
    const engine = config.defaultEngine || "claude";
    const taskId = randomUUID();
    const task = {
      id: taskId,
      title: `生成${label}`,
      description: aiPrompt,
      type: "general",
      status: "pending",
      priority: 2,
      source: "web",
      sourceId: options.sessionId || null,
    };
    createTask(task);
    const result = await runTask(task);
    reportContent = result.output || result.report || "";
  } catch (err) {
    log("system", "warn", "report", `AI 生成失败 (${err.message})，使用原始数据`);
    reportContent = `# ${label}\n\n${dataSummary}`;
  }

  // 4. 写入文件
  const outputDir = config.reportOutputDir || join(homedir(), "ai-reports");
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const fileName = `${label.replace(/[\/\\:*?"<>|]/g, "-")}_${since}_${until}.md`;
  const filePath = join(outputDir, fileName);
  writeFileSync(filePath, reportContent, "utf-8");

  log("system", "info", "report", `报告已生成: ${filePath}`);

  // 生成聊天中显示的简要摘要
  const summary = generateChatSummary(label, filePath, gitData, chatData, taskData, tbData);

  return { filePath, summary, fullContent: reportContent };
}

/**
 * 构建传给 AI 的数据摘要
 */
function buildDataSummary(label, since, until, gitData, chatData, taskData, tbData) {
  const sections = [];

  sections.push(`### 报告周期: ${label} (${since} ~ ${until})`);

  // Git 数据
  if (gitData.length > 0) {
    sections.push("\n### Git 提交记录");
    for (const repo of gitData) {
      if (repo.error) {
        sections.push(`\n**${repo.name}**: 获取失败 - ${repo.error}`);
        continue;
      }
      sections.push(`\n**${repo.name}** — ${repo.total.commits} 次提交, ${repo.total.files} 文件变更, +${repo.total.insertions} -${repo.total.deletions}`);
      // 列出提交（最多20条）
      for (const c of repo.commits.slice(0, 20)) {
        sections.push(`- [${c.date}] ${c.hash} ${c.message}`);
      }
      if (repo.commits.length > 20) {
        sections.push(`- ...还有 ${repo.commits.length - 20} 条提交`);
      }
    }
  }

  // 平台任务
  if (taskData.total > 0) {
    sections.push("\n### 平台任务统计");
    sections.push(`总计 ${taskData.total} 个任务`);
    for (const [status, count] of Object.entries(taskData.statusCounts)) {
      sections.push(`- ${status}: ${count}`);
    }
  }

  // Teambition 任务
  if (tbData.length > 0) {
    sections.push("\n### Teambition 任务");
    const completed = tbData.filter(t => t.status === "completed");
    const open = tbData.filter(t => t.status !== "completed");
    sections.push(`总计 ${tbData.length} 条 (已完成 ${completed.length}, 进行中 ${open.length})`);
    for (const t of tbData.slice(0, 30)) {
      sections.push(`- [${t.status === "completed" ? "done" : "open"}] ${t.title}`);
    }
  }

  // 聊天记录
  if (chatData.totalMessages > 0) {
    sections.push("\n### AI 工具使用");
    sections.push(`用户请求 ${chatData.userRequests} 次, AI 回复 ${chatData.aiResponses} 次`);
    if (Object.keys(chatData.engineCounts).length > 0) {
      sections.push("引擎分布: " + Object.entries(chatData.engineCounts).map(([e, c]) => `${e}(${c})`).join(", "));
    }
    if (chatData.requests.length > 0) {
      sections.push("\n主要请求:");
      for (const r of chatData.requests.slice(0, 15)) {
        sections.push(`- ${r}`);
      }
    }
  }

  return sections.join("\n");
}

/**
 * 生成聊天中显示的简要摘要
 */
function generateChatSummary(label, filePath, gitData, chatData, taskData, tbData) {
  const lines = [`**${label}** 已生成\n`];

  // 关键数据
  const totalCommits = gitData.reduce((sum, r) => sum + (r.total?.commits || 0), 0);
  if (totalCommits > 0) {
    lines.push(`- Git: ${totalCommits} 次提交，涉及 ${gitData.filter(r => !r.error).length} 个仓库`);
  }
  if (taskData.total > 0) {
    const done = taskData.statusCounts.completed || 0;
    lines.push(`- 平台任务: ${taskData.total} 个 (完成 ${done})`);
  }
  if (tbData.length > 0) {
    const done = tbData.filter(t => t.status === "completed").length;
    lines.push(`- Teambition: ${tbData.length} 条 (完成 ${done})`);
  }
  if (chatData.userRequests > 0) {
    lines.push(`- AI 交互: ${chatData.userRequests} 次请求`);
  }

  lines.push(`\n报告文件: \`${filePath}\``);

  return lines.join("\n");
}
