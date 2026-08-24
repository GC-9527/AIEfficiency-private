import { spawn } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { log, broadcastChatStream } from "./logger.js";
import { getConfig } from "./config.js";
import { registerProcess, unregisterProcess, killProcessTree } from "./agent-runner.js";
import { getCapabilitySummary, getModificationSkills } from "./capability-doc.js";
import { isApiEngine, callApiEngine } from "./api-engine.js";
import { getPlatformContext } from "./platform-context.js";
import { ensureExternalTempDirectory } from "./external-temp.js";
import { buildHermesOneshotArgs, hermesExecutable, isHermesEngine } from "./hermes-cli.js";

function createPromptTempFile(prompt, purpose) {
  const promptTempDir = ensureExternalTempDirectory(["aiefficiency", "decomposer-prompts"], {
    avoidRoots: [process.cwd()],
  });
  const safePurpose = String(purpose || "task").replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 40) || "task";
  const file = join(promptTempDir, `prompt-${safePurpose}-${randomUUID()}.txt`);
  try {
    writeFileSync(file, prompt, { encoding: "utf-8", flag: "wx", mode: 0o600 });
    return file;
  } catch (error) {
    try { unlinkSync(file); } catch {}
    throw error;
  }
}

function cleanupPromptTempFile(file) {
  if (!file) return;
  try { unlinkSync(file); } catch {}
}

/**
 * 调用 LLM 拆分复合任务为子任务
 * @returns {{ needsSplit: boolean, reason: string, subtasks: Array<{id, title, description, type, engine, dependsOn}> }}
 */
export async function decomposeTask(userMessage, engine = "gemini") {
  const config = getConfig();
  const maxSubtasks = config.maxSubtasks || 5;

  // Gemini 不可用时降级 Claude
  if (engine === "gemini" && !config.geminiEnabled) {
    engine = "claude";
  }

  const prompt = `你是一个任务分析器。分析用户的请求，判断是否需要拆分为多个子任务。

规则：
1. 如果请求包含多个独立或有依赖关系的步骤，则拆分
2. 如果是单一简单任务，不拆分
3. 最多拆分为 ${maxSubtasks} 个子任务
4. 每个子任务应该是独立可执行的
5. 用 dependsOn 数组表示依赖关系（引用其他子任务的 id）

请严格返回以下 JSON 格式（不要包含其他文字）：
{
  "needsSplit": true/false,
  "reason": "拆分/不拆分的原因",
  "subtasks": [
    {
      "id": "sub_1",
      "title": "子任务标题",
      "description": "详细描述",
      "type": "bug_analysis|log_filter|adb_operation|general|...",
      "engine": "claude|gemini|codex|hermes",
      "dependsOn": []
    }
  ]
}

用户请求：
${userMessage}`;

  try {
    const result = await runLLM(engine, prompt, "decompose");
    return parseDecompositionResult(result);
  } catch (err) {
    log("system", "warn", "decomposer", `拆分调用失败(${engine}): ${err.message}`);
    return { needsSplit: false, reason: `拆分失败: ${err.message}`, subtasks: [] };
  }
}

/**
 * AI 智能任务规划器
 * 输入：用户消息 + 平台能力摘要
 * 输出：执行计划（Skill分配、引擎建议、依赖、审查标记）
 */
export async function planTask(userMessage, engine = "gemini") {
  const config = getConfig();
  if (engine === "gemini" && !config.geminiEnabled) engine = "claude";

  const capSummary = getCapabilitySummary();
  const platformCtx = getPlatformContext();
  const maxSubtasks = config.maxSubtasks || 5;

  const prompt = `你是任务规划器。根据用户请求和平台能力，制定执行计划。

${platformCtx}

## 平台能力
${capSummary}

## 规划规则
1. 简单单一任务（查询、单步操作）→ needsSplit: false，直接分配一个任务
2. 复合任务（多步骤、有依赖）→ needsSplit: true，拆分为子任务（最多${maxSubtasks}个）
3. 为每个任务分配最合适的 Skill（从平台能力列表中选，无匹配则 skill 留空）
4. 涉及代码/文件修改的任务 → inspect: true（强制审查）
5. 引擎建议：复杂推理用 claude，简单查询用 gemini，代码操作用 codex，本机工具/记忆工作流可用 hermes（均须已启用）
6. 用 dependsOn 表示依赖关系
7. 子任务 description 中必须包含完整的文件路径和 API 地址（参考上方平台环境信息）

## 用户请求
${userMessage}

严格返回 JSON（不要其他文字）：
{
  "needsSplit": false,
  "tasks": [{
    "id": "task_1",
    "title": "任务标题",
    "description": "详细描述（给AI执行用的prompt）",
    "skill": "skill-id或空字符串",
    "engine": "claude|gemini|codex|hermes|auto",
    "inspect": false,
    "dependsOn": []
  }]
}`;

  try {
    const result = await runLLM(engine, prompt, "plan");
    const plan = parsePlanResult(result);

    // 硬兜底：修改类 Skill 强制 inspect
    const modSkills = getModificationSkills();
    for (const task of plan.tasks) {
      if (modSkills.has(task.skill)) {
        task.inspect = true;
      }
    }

    return plan;
  } catch (err) {
    log("system", "warn", "planner", `AI规划失败(${engine}): ${err.message}`);
    // 降级：不拆分，不分配 Skill
    return {
      needsSplit: false,
      tasks: [{
        id: "task_1",
        title: userMessage.slice(0, 50),
        description: userMessage,
        skill: "",
        engine: "auto",
        inspect: false,
        dependsOn: [],
      }],
    };
  }
}

function parsePlanResult(rawOutput) {
  const defaultPlan = {
    needsSplit: false,
    tasks: [{ id: "task_1", title: "", description: "", skill: "", engine: "auto", inspect: false, dependsOn: [] }],
  };

  if (!rawOutput || !rawOutput.trim()) return defaultPlan;

  // 尝试提取 JSON
  const candidates = [
    () => JSON.parse(rawOutput.trim()),
    () => { const m = rawOutput.match(/\{[\s\S]*"tasks"[\s\S]*\}/); return m ? JSON.parse(m[0]) : null; },
    () => { const m = rawOutput.match(/```(?:json)?\s*([\s\S]*?)```/); return m ? JSON.parse(m[1].trim()) : null; },
  ];

  for (const tryParse of candidates) {
    try {
      const parsed = tryParse();
      if (parsed && Array.isArray(parsed.tasks) && parsed.tasks.length > 0) {
        // 规范化
        for (const t of parsed.tasks) {
          t.id = t.id || `task_${Math.random().toString(36).slice(2, 6)}`;
          t.skill = t.skill || "";
          t.engine = t.engine || "auto";
          t.inspect = t.inspect ?? false;
          t.dependsOn = t.dependsOn || [];
        }
        return parsed;
      }
    } catch {}
  }

  return defaultPlan;
}

/**
 * 汇总所有子任务结果为统一回复
 */
export async function summarizeResults(userMessage, results, engine = "gemini", sessionId = null, parentTaskId = null) {
  const config = getConfig();
  if (engine === "gemini" && !config.geminiEnabled) {
    engine = "claude";
  }

  let resultsText = "";
  for (const r of results) {
    const statusLabel = r.status === "completed" ? "成功" : "失败";
    const output = r.output ? r.output.slice(0, 2000) : "(无输出)";
    resultsText += `### 子任务: ${r.title} [${statusLabel}]\n${output}\n\n`;
  }

  const prompt = `你是一个任务汇总助手。用户发出了一个复合请求，系统已将其拆分为多个子任务并分别执行。
请根据以下子任务的执行结果，为用户生成一份清晰、完整的汇总回复。

用户原始请求：
${userMessage}

各子任务执行结果：
${resultsText}

请生成结构化的汇总报告，包括：
1. 整体执行情况概述
2. 各子任务的关键发现/结果
3. 如有失败的子任务，说明原因和建议
4. 综合结论或下一步建议`;

  try {
    const result = await runLLM(engine, prompt, "summarize", sessionId, parentTaskId);
    return result;
  } catch (err) {
    log("system", "warn", "decomposer", `汇总调用失败: ${err.message}`);
    // 降级：拼接子任务结果
    let fallback = "## 任务执行汇总\n\n";
    for (const r of results) {
      fallback += `### ${r.title} (${r.status === "completed" ? "成功" : "失败"})\n`;
      fallback += (r.output || "(无输出)").slice(0, 1000) + "\n\n";
    }
    return fallback;
  }
}

/**
 * 调用 CLI 引擎执行 prompt
 */
export function runLLM(engine, prompt, purpose, sessionId = null, parentTaskId = null) {
  // API 引擎走 HTTP 调用
  if (isApiEngine(engine)) {
    return callApiEngine(engine, prompt);
  }

  return new Promise((resolve, reject) => {
    let command, args;
    if (engine === "claude") {
      command = "claude";
      args = ["-p", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"];
    } else if (engine === "codex") {
      command = "codex";
      args = ["--quiet"];
    } else if (isHermesEngine(engine)) {
      command = hermesExecutable();
      args = [];
    } else {
      command = "gemini";
      args = [];
    }

    const runId = randomUUID();
    let tmpFile = "";
    let proc;
    try {
      tmpFile = createPromptTempFile(prompt, purpose);
      if (isHermesEngine(engine)) args = buildHermesOneshotArgs({ promptFile: tmpFile });
      proc = spawn(command, args, {
        cwd: process.cwd(),
        shell: !isHermesEngine(engine),
        windowsHide: true,
        env: { ...process.env },
        stdio: ["pipe", "pipe", "pipe"],
        ...(process.platform !== "win32" ? { detached: true } : {}),
      });
    } catch (error) {
      cleanupPromptTempFile(tmpFile);
      reject(new Error(`启动 ${engine} 失败: ${error.message}`));
      return;
    }

    const processKey = `decomposer-${purpose}-${runId}`;
    let stdout = "";
    let stderr = "";
    let stdoutBuffer = "";
    let settled = false;
    let timeout = null;

    const cleanup = () => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      unregisterProcess(processKey);
      cleanupPromptTempFile(tmpFile);
    };
    const finishResolve = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    proc.stdin.on("error", (error) => {
      try { killProcessTree(proc); } catch {}
      finishReject(new Error(`向 ${engine} 发送 prompt 失败: ${error.message}`));
    });

    try {
      registerProcess(processKey, proc, parentTaskId || "system", parentTaskId);
      if (isHermesEngine(engine)) proc.stdin.end();
      else {
        proc.stdin.write(prompt);
        proc.stdin.end();
      }
    } catch (error) {
      try { killProcessTree(proc); } catch {}
      finishReject(new Error(`启动 ${engine} 失败: ${error.message}`));
      return;
    }

    proc.stdout.on("data", (data) => {
      const text = data.toString();
      if (engine === "claude") {
        stdoutBuffer += text;
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop();
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const event = JSON.parse(trimmed);
            if (event.type === "assistant" && event.message?.content) {
              for (const block of event.message.content) {
                if (block.type === "text" && block.text) {
                  stdout += block.text;
                  // 汇总时流式推送
                  if (purpose === "summarize" && sessionId) {
                    broadcastChatStream({
                      taskId: parentTaskId || "summary",
                      sessionId,
                      chunk: block.text,
                      engine,
                      deltaType: "summary",
                    });
                  }
                }
              }
            } else if (event.type === "result" && event.result) {
              stdout = event.result;
            }
          } catch {
            stdout += trimmed;
          }
        }
      } else {
        stdout += text;
        // Gemini 汇总时也流式推送
        if (purpose === "summarize" && sessionId) {
          broadcastChatStream({
            taskId: parentTaskId || "summary",
            sessionId,
            chunk: text,
            engine,
            deltaType: "summary",
          });
        }
      }
    });

    proc.stderr.on("data", (data) => { stderr += data.toString(); });

    proc.on("close", (code) => {
      // 处理残留 buffer
      if (engine === "claude" && stdoutBuffer.trim()) {
        try {
          const event = JSON.parse(stdoutBuffer.trim());
          if (event.type === "result" && event.result) stdout = event.result;
        } catch {}
      }

      if (code === 0) {
        finishResolve(stdout);
      } else {
        finishReject(new Error(`${engine} 退出码 ${code}: ${(stderr || stdout).slice(0, 300)}`));
      }
    });

    proc.on("error", (error) => {
      finishReject(new Error(`启动 ${engine} 失败: ${error.message}`));
    });

    // 拆分/汇总超时：3分钟
    timeout = setTimeout(() => {
      killProcessTree(proc);
      finishReject(new Error(`${purpose} 超时(3分钟)`));
    }, 3 * 60 * 1000);
  });
}

/**
 * 解析 LLM 拆分结果
 */
function parseDecompositionResult(rawOutput) {
  const defaultResult = { needsSplit: false, reason: "解析失败，降级为不拆分", subtasks: [] };

  if (!rawOutput || !rawOutput.trim()) return defaultResult;

  // 尝试直接解析
  try {
    const parsed = JSON.parse(rawOutput.trim());
    if (typeof parsed.needsSplit === "boolean") return parsed;
  } catch {}

  // 尝试提取 JSON 块
  const jsonMatch = rawOutput.match(/\{[\s\S]*"needsSplit"[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (typeof parsed.needsSplit === "boolean") return parsed;
    } catch {}
  }

  // 尝试从 markdown code block 中提取
  const codeBlockMatch = rawOutput.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    try {
      const parsed = JSON.parse(codeBlockMatch[1].trim());
      if (typeof parsed.needsSplit === "boolean") return parsed;
    } catch {}
  }

  return defaultResult;
}
