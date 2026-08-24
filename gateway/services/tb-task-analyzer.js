/**
 * Teambition 任务分析器
 * 下载附件 → 构建 prompt → AI 分析 → 保存报告 → 发评论
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { randomUUID } from "crypto";
import { getConfig } from "./config.js";
import {
  getTaskDetail, getTaskComments, getTaskAttachments,
  downloadAttachment, getUserInfo, postTaskComment,
} from "./teambition.js";
import { updateTbTaskRecord, getTbTaskRecord } from "../db/sqlite.js";
import { runTask } from "./agent-runner.js";
import { createTask } from "../db/sqlite.js";
import { log, broadcastAll } from "./logger.js";

function broadcastTbStatus(id, status, extra = {}) {
  broadcastAll(JSON.stringify({ type: "tb_task_update", data: { id, status, ...extra } }));
}

/**
 * 分析单个 TB 任务
 */
export async function analyzeTbTask(tbTaskId) {
  const config = getConfig();
  const watcher = config.tbTaskWatcher || {};

  updateTbTaskRecord(tbTaskId, { status: "downloading" });
  broadcastTbStatus(tbTaskId, "downloading", { message: "正在拉取任务详情和附件..." });
  log("system", "info", "tb-analyzer", `开始分析: ${tbTaskId}`);

  try {
    // 1. 拉取任务详情
    const task = await getTaskDetail(tbTaskId);
    if (!task) throw new Error("任务不存在或无权限");

    const carbId = buildCarbId(task) || tbTaskId;
    const localDir = getLocalDir(carbId);
    mkdirSync(join(localDir, "attachments"), { recursive: true });

    // 获取人员信息
    const [creator, executor] = await Promise.all([
      getUserInfo(task.creatorId),
      getUserInfo(task.executorId),
    ]);

    updateTbTaskRecord(tbTaskId, {
      carbId, title: task.content || "",
      creatorId: task.creatorId || "", creatorName: creator.name,
      executorId: task.executorId || "", executorName: executor.name,
      localDir,
    });

    // 保存任务信息
    writeFileSync(join(localDir, "task-info.json"), JSON.stringify(task, null, 2), "utf-8");

    // 2. 拉取评论
    const comments = await getTaskComments(tbTaskId);
    writeFileSync(join(localDir, "comments.json"), JSON.stringify(comments, null, 2), "utf-8");

    // 3. 拉取并下载附件
    const attachments = await getTaskAttachments(tbTaskId);
    const attachmentInfo = [];
    for (const att of attachments) {
      const name = att.fileName || att.name || `attachment_${attachmentInfo.length}`;
      // 权限不足的占位文件
      if (att._noDownload || att._noPermission) {
        attachmentInfo.push({
          name, fileId: att.id, downloaded: false, source: att._source || "",
          reason: att._reason || "无法下载",
        });
        continue;
      }
      const url = att.downloadUrl || att.url || att.thumbnail;
      if (!url) { attachmentInfo.push({ name, fileId: att.id, downloaded: false, reason: "无下载地址" }); continue; }
      try {
        const destPath = join(localDir, "attachments", name);
        const size = await downloadAttachment(url, destPath);
        attachmentInfo.push({ name, fileId: att.id, downloaded: true, size, path: destPath });
      } catch (err) {
        attachmentInfo.push({ name, fileId: att.id, downloaded: false, reason: err.message });
      }
    }

    // 保存附件元信息到 DB
    updateTbTaskRecord(tbTaskId, {
      status: "analyzing",
      attachmentsJson: JSON.stringify(attachmentInfo),
    });
    broadcastTbStatus(tbTaskId, "analyzing", { message: "AI 正在分析任务..." });

    // 4. 构建 AI prompt（含信息充分性判断指令，不传本地路径）
    const prompt = buildAnalysisPrompt(task, comments, attachmentInfo, creator, executor, carbId);

    // 5. AI 分析（走完整的 dispatch → runTask 链路）
    const aiTaskId = randomUUID();
    const aiTask = {
      id: aiTaskId,
      title: `[TB分析] ${carbId} ${(task.content || "").slice(0, 40)}`,
      description: prompt,
      type: "bug_analysis",
      status: "pending",
      priority: 2,
      source: "tb-analyzer",
      sourceId: tbTaskId,
    };
    createTask(aiTask);
    const result = await runTask(aiTask);
    const report = result.output || result.report || "";

    // 6. 保存报告
    writeFileSync(join(localDir, "analysis-report.md"), report, "utf-8");

    // 7. 检测 AI 是否标记信息不足（<!-- NEED_MORE_INFO: ... -->）
    const needMoreMatch = report.match(/<!--\s*NEED_MORE_INFO:\s*([\s\S]*?)-->/);
    if (needMoreMatch) {
      const missingInfo = needMoreMatch[1].trim();
      log("system", "info", "tb-analyzer", `信息不足，挂起等待补充: ${carbId}`);

      // 发评论 @提单人 请求补充
      const creatorMention = task.creatorId ? `<at data-id="${task.creatorId}"></at>` : (creator.name || "提单人");
      const suspendComment = [
        `⏸️ AI 分析挂起 — 需要补充资料`,
        ``,
        `${creatorMention} 您好，此任务的分析因以下信息缺失暂时挂起，请补充后回复：`,
        ``,
        missingInfo,
        ``,
        `---`,
        `🤖 补充后 AI 将自动继续分析`,
      ].join("\n");

      // 仅在自动发布评论开启时发挂起评论
      if (watcher.autoComment !== false) {
        try {
          await postTaskComment(tbTaskId, suspendComment);
          log("system", "info", "tb-analyzer", `已发挂起评论到 TB: ${tbTaskId}`);
        } catch (err) {
          log("system", "warn", "tb-analyzer", `发挂起评论失败: ${err.message}`);
        }
      } else {
        log("system", "info", "tb-analyzer", `自动评论已关闭，挂起评论仅保存在本地: ${tbTaskId}`);
      }

      const partialSummary = extractSummary(report.replace(/<!--[\s\S]*?-->/g, ""));
      updateTbTaskRecord(tbTaskId, {
        status: "suspended",
        analysisSummary: partialSummary || `信息不足，等待补充: ${missingInfo.slice(0, 200)}`,
        analyzedAt: new Date().toISOString(),
        errorMessage: `待补充: ${missingInfo.slice(0, 300)}`,
      });
      broadcastTbStatus(tbTaskId, "suspended", { message: `等待补充资料: ${missingInfo.slice(0, 100)}`, carbId });
      return { success: true, id: tbTaskId, carbId, suspended: true, missingInfo };
    }

    // 8. 信息充分 → 正常完成
    const summary = extractSummary(report);
    const hasDownloadFailed = attachmentInfo.some(a => !a.downloaded);

    updateTbTaskRecord(tbTaskId, {
      status: "completed",
      analysisSummary: summary,
      analyzedAt: new Date().toISOString(),
    });

    // 9. 发评论到 TB
    if (hasDownloadFailed) {
      // 附件下载失败 → 不发评论，通知执行人
      const failedNames = attachmentInfo.filter(a => !a.downloaded).map(a => a.name).join(", ");
      log("system", "warn", "tb-analyzer", `附件下载失败，跳过发评论: ${failedNames}`);
      broadcastTbStatus(tbTaskId, "completed", {
        analysisSummary: summary, carbId,
        warning: `附件下载失败(${failedNames})，分析报告已生成但未发送评论`,
      });
    } else if (watcher.autoComment !== false) {
      const cleanSummary = stripLocalPaths(summary);
      await postCommentToTb(tbTaskId, cleanSummary, creator, executor);
      updateTbTaskRecord(tbTaskId, { commentPosted: 1 });
    }

    broadcastTbStatus(tbTaskId, "completed", { analysisSummary: summary, carbId });
    log("system", "info", "tb-analyzer", `分析完成: ${carbId}`);
    return { success: true, id: tbTaskId, carbId, summary };

  } catch (err) {
    updateTbTaskRecord(tbTaskId, {
      status: "failed",
      errorMessage: err.message,
    });
    broadcastTbStatus(tbTaskId, "failed", { errorMessage: err.message });
    log("system", "error", "tb-analyzer", `分析失败 ${tbTaskId}: ${err.message}`);
    throw err;
  }
}

/**
 * 构建分析 prompt
 */
function buildAnalysisPrompt(task, comments, attachments, creator, executor, carbId) {
  const parts = [];

  parts.push(`## 任务分析\n\n请分析以下 Teambition 任务并给出结论。\n`);

  parts.push(`### 任务信息`);
  parts.push(`- ID: ${carbId}`);
  parts.push(`- 标题: ${task.content || ""}`);
  parts.push(`- 优先级: ${["紧急", "普通", "较低"][task.priority] || "普通"}`);
  parts.push(`- 建单人: ${creator.name} | 执行人: ${executor.name}`);
  if (task.dueDate) parts.push(`- 截止时间: ${task.dueDate}`);
  parts.push(`- 状态: ${task.isDone ? "已完成" : "进行中"}`);
  parts.push("");

  if (task.note) {
    parts.push(`### 任务描述\n${task.note}\n`);
  }

  // 评论（解析 JSON 格式的 content，提取真正的评论文本和评论者）
  if (comments.length > 0) {
    parts.push(`### 评论记录 (${comments.length} 条)`);
    parts.push(`> 以下为任务相关人员的讨论记录，请结合评论内容进行分析，评论中的讨论可能包含关键线索。\n`);
    for (const c of comments.slice(-30)) {
      const time = (c.created || c.createTime || "").slice(0, 16).replace("T", " ");
      const who = c.creatorId || "未知";
      // content 可能是 JSON 字符串，需要二次解析
      let commentText = "";
      let raw = c.content;
      if (typeof raw === "string") {
        try { raw = JSON.parse(raw); } catch {}
      }
      if (typeof raw === "object" && raw !== null) {
        // 提取 comment 字段
        if (typeof raw.comment === "string") {
          commentText = raw.comment;
        } else if (typeof raw.comment === "object") {
          commentText = JSON.stringify(raw.comment);
        }
        // 如果 comment 为空但有 title
        if (!commentText && raw.title) commentText = raw.title;
      } else if (typeof raw === "string") {
        commentText = raw;
      }
      if (!commentText) commentText = c.action || "(无文本内容)";
      parts.push(`- [${time}] (${who}): ${commentText.slice(0, 500)}`);
    }
    parts.push("");
  }

  // 附件
  if (attachments.length > 0) {
    const downloadedCount = attachments.filter(a => a.downloaded).length;
    parts.push(`### 附件 (${attachments.length} 个，${downloadedCount} 个已下载到本地)`);
    parts.push(`> 注意：标注为 [已下载] 的附件已获取成功。请基于文件名、类型和已提取的内容片段进行分析。不要在报告中提及文件路径或存储位置。\n`);
    for (const att of attachments) {
      if (att.downloaded) {
        const label = `[已下载] ${att.name} (${formatBytes(att.size)})`;
        // 文本类文件：读取关键内容
        if (/\.(txt|log|csv|xml|json|conf|prop)$/i.test(att.name) && att.size < 2000000) {
          try {
            const content = readFileSync(att.path, "utf-8");
            const lines = content.split("\n");
            const excerpt = extractLogExcerpt(content);
            if (excerpt) {
              parts.push(`- ${label} — 发现以下关键日志片段：`);
              parts.push(`  \`\`\`\n  ${excerpt}\n  \`\`\``);
            } else {
              // 无关键词匹配时，提供文件头尾供 AI 理解日志上下文
              const headTail = lines.slice(0, 20).join("\n") + "\n...(中间省略)...\n" + lines.slice(-20).join("\n");
              parts.push(`- ${label} — 无明显错误关键词，以下为日志头尾：`);
              parts.push(`  \`\`\`\n  ${headTail.slice(0, 3000)}\n  \`\`\``);
            }
          } catch {
            parts.push(`- ${label} — 文本文件，读取失败`);
          }
        } else if (/\.(mp4|avi|mov|mkv|webm)$/i.test(att.name)) {
          parts.push(`- ${label} — 视频文件，已保存到本地可回放查看，无法嵌入文本分析`);
        } else if (/\.(png|jpg|jpeg|gif|bmp|webp)$/i.test(att.name)) {
          parts.push(`- ${label} — 图片/截图，已保存到本地，无法嵌入文本分析`);
        } else if (/\.(zip|rar|7z|gz|tar)$/i.test(att.name)) {
          parts.push(`- ${label} — 压缩包，已保存到本地可手动解压查看`);
        } else {
          parts.push(`- ${label}`);
        }
      } else {
        parts.push(`- [未下载] ${att.name} — 原因: ${att.reason}`);
      }
    }
    parts.push("");
  }

  parts.push(`### 分析要求`);
  parts.push(``);
  parts.push(`**核心原则：基于证据分析，严禁推测**`);
  parts.push(`- 如果有日志内容，**必须逐行分析日志**，从中找出错误堆栈、异常信息、时间线、进程状态等关键证据`);
  parts.push(`- 不要说"建议查看日志"或"建议核查"——日志已经提供给你了，你必须实际分析它`);
  parts.push(`- 每个结论必须有日志/评论中的具体证据支撑，引用原文（文件名+行内容）`);
  parts.push(`- 如果评论中有人员讨论，必须读取并结合讨论内容分析（评论可能包含问题定位、原因说明、临时方案等关键信息）`);
  parts.push(`- 不要重复任务描述作为分析结论，要给出日志/评论中发现的**新信息**`);
  parts.push(``);
  parts.push(`**信息充分性判断**`);
  parts.push(`- 有日志 + 有描述/评论 = 信息充分，必须完成分析`);
  parts.push(`- 有附件已下载（即使你看不到二进制内容如视频/图片）+ 有描述 = 信息充分`);
  parts.push(`- 只有完全缺失关键信息（无描述、无评论、无附件）时才标记：<!-- NEED_MORE_INFO: ... -->`);
  parts.push(``);
  parts.push(`**输出格式**`);
  parts.push(`1. 用非技术语言总结问题（产品、项目管理、测试都能看懂）`);
  parts.push(`2. 日志分析部分：列出发现的关键错误/异常，引用具体日志行`);
  parts.push(`3. 评论分析部分：如有讨论，总结讨论结论和待确认事项`);
  parts.push(`4. 给出根因判断（基于证据）和可操作建议`);
  parts.push(`5. **严禁**出现本地文件路径、下载链接，只引用文件名`);
  parts.push(`\n请按以下格式输出：`);
  parts.push(`# ${carbId} 分析报告\n`);
  parts.push(`> 🤖 此报告由 AI 自动分析生成\n`);
  parts.push(`## 问题概述\n[1-2 句话]\n`);
  parts.push(`## 日志分析\n[从日志中发现的关键证据，引用具体错误行]\n`);
  parts.push(`## 评论讨论要点\n[总结相关人员的讨论结论]\n`);
  parts.push(`## 根因判断\n[基于证据的根因分析]\n`);
  parts.push(`## 建议\n- [ ] ...\n`);
  parts.push(`\n（若信息不足，在最后添加 <!-- NEED_MORE_INFO: ... --> 标记）`);

  return parts.join("\n");
}

/**
 * 发评论到 TB
 */
async function postCommentToTb(taskId, summary, creator, executor) {
  // 清理本地路径 + 拼接评论
  const cleanSummary = stripLocalPaths(summary);

  const comment = [
    `📊 AI 分析结论\n`,
    cleanSummary,
    `\n---`,
    `🤖 此分析由 AI 自动整理`,
  ].join("\n");

  try {
    await postTaskComment(taskId, comment);
    log("system", "info", "tb-analyzer", `已发评论到 TB: ${taskId}`);
  } catch (err) {
    log("system", "warn", "tb-analyzer", `发评论失败: ${err.message}`);
  }
}

/**
 * 提取报告摘要
 */
function extractSummary(report) {
  // 优先取"结论"段
  const conclusionMatch = report.match(/##\s*结论\s*\n([\s\S]*?)(?=\n##|\n$|$)/);
  if (conclusionMatch) return conclusionMatch[1].trim().slice(0, 500);
  // 否则取前 500 字
  return report.slice(0, 500);
}

/**
 * 从日志中提取关键段落（错误、异常、crash 相关）
 */
function extractLogExcerpt(content) {
  const lines = content.split("\n");
  const keywords = /error|exception|crash|fatal|fail|panic|anr|oom|kill|died|abort|timeout|denied|stacktrace|caused by|nullpointer|illegalstate|securityexception/i;
  const relevant = [];
  const seen = new Set();
  for (let i = 0; i < lines.length; i++) {
    if (keywords.test(lines[i])) {
      const start = Math.max(0, i - 3);
      const end = Math.min(lines.length, i + 10);
      const block = lines.slice(start, end).join("\n");
      // 去重：跳过已收录的相同错误
      const sig = lines[i].replace(/\d/g, "").slice(0, 60);
      if (seen.has(sig)) continue;
      seen.add(sig);
      relevant.push(block);
      if (relevant.join("\n").length > 8000) break;
    }
  }
  return relevant.join("\n...\n").slice(0, 10000) || null;
}

function getLocalDir(carbId) {
  const config = getConfig();
  const watcher = config.tbTaskWatcher || {};
  const baseDir = watcher.localDir || config.workDir || join(homedir(), "tb-tasks");
  return join(baseDir, carbId || "unknown");
}

/**
 * 生成 CARB ID
 * 优先用 task.uniqueId（真实企业），fallback 从标题解析（测试企业）
 */
function buildCarbId(task) {
  if (task.uniqueId) return `CARB-${task.uniqueId}`;
  const match = (task.content || "").match(/CARB-\d+/);
  return match ? match[0] : null;
}

/**
 * 清除报告中的本地路径信息
 */
function stripLocalPaths(text) {
  return text
    // Windows 路径 C:\xxx\yyy 或 C:/xxx/yyy
    .replace(/[A-Z]:[\\\/][\w\\\/.\-~]+/gi, "[本地文件]")
    // Unix 路径 /home/xxx /tmp/xxx
    .replace(/\/(?:home|tmp|Users|var|opt)\/[\w\/.\-~]+/g, "[本地文件]")
    // 明确的本地目录提示
    .replace(/本地目录[：:]\s*\S+/g, "")
    .replace(/已保存到本地\S*/g, "已保存")
    .replace(/已下载到本地\S*/g, "已下载");
}

function formatBytes(bytes) {
  if (!bytes) return "0B";
  if (bytes < 1024) return bytes + "B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + "KB";
  return (bytes / 1024 / 1024).toFixed(1) + "MB";
}

/**
 * 恢复挂起的任务（收到补充资料后重新分析）
 * @param {string} tbTaskId - TB 任务 ID
 * @param {Array} newComments - 挂起后新增的评论列表
 */
export async function resumeSuspendedTask(tbTaskId, newComments = []) {
  const record = getTbTaskRecord(tbTaskId);
  if (!record || record.status !== "suspended") return;

  log("system", "info", "tb-analyzer", `收到补充资料，恢复分析: ${tbTaskId}`);
  updateTbTaskRecord(tbTaskId, { status: "pending", errorMessage: "" });
  broadcastTbStatus(tbTaskId, "pending", { message: "收到补充资料，准备重新分析..." });

  // 直接重新跑完整分析（会拉取最新评论和附件）
  await analyzeTbTask(tbTaskId);
}
