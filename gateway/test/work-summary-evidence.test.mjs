import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aiefficiency-work-summary-"));
process.env.GATEWAY_DB_PATH = path.join(tempRoot, "gateway.db");
process.env.DEVBENCH_CONFIG_PATH = path.join(tempRoot, "market-projects.json");
process.env.DEVBENCH_STORE_DIR = path.join(tempRoot, "store");

const { collectAiSessions } = await import("../services/devbench/work-summary-evidence.js");
const {
  buildDataContext,
  buildPrompt,
  DEFAULT_WEEKLY_TEMPLATE,
  extractSummaryTemplateSource,
  markdownToPlainText,
  normalizeReportPeriod,
  normalizeSummaryOutputModes,
  reportMeta,
  sanitizeAnalyzedSummaryTemplate,
  selectSummaryTextEngine,
} = await import("../services/devbench/report.js");
const { readApiTextStream } = await import("../services/api-engine.js");

function writeJsonl(filePath, events) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
}

test("工作总结周期：custom 大小写和空白规范化，非法值拒绝", () => {
  assert.equal(normalizeReportPeriod(" custom "), "custom");
  assert.equal(normalizeReportPeriod("CUSTOM"), "custom");
  assert.equal(normalizeReportPeriod("自定义"), "");
  assert.equal(normalizeReportPeriod(""), "");
  assert.deepEqual(
    reportMeta("custom", "2026-07-20", "2026-07-27"),
    {
      word: "custom",
      since: "2026-07-20",
      until: "2026-07-27",
      label: "2026-07-20~2026-07-27工作总结",
      fileBase: "20260720-20260727工作总结",
      isPerf: false,
    },
  );
});

test("AI 会话索引：Claude/Codex 同 cwd 不串线，跨日期会话可识别，热索引不重读", async () => {
  const claudeRoot = path.join(tempRoot, "claude-projects");
  const codexRoot = path.join(tempRoot, "codex-sessions");
  const backupRoot = path.join(tempRoot, "claude-backup");
  const cachePath = path.join(tempRoot, "cache", "sessions.json");
  const cwd = path.join(tempRoot, "same-project");

  writeJsonl(path.join(claudeRoot, "encoded-project", "claude-session.jsonl"), [
    { type: "user", timestamp: "2026-07-10T01:00:00.000Z", cwd, message: { content: "修复 Claude 路径问题" } },
    { type: "assistant", timestamp: "2026-07-10T01:01:00.000Z", cwd, message: { content: [{ type: "text", text: "已完成 Claude 修复" }] } },
    { type: "user", timestamp: "2026-07-10T01:02:00.000Z", cwd, message: { content: [{ type: "tool_result", content: "大段工具输出" }] } },
  ]);

  const codexFile = path.join(codexRoot, "2026", "07", "09", "rollout-cross-day.jsonl");
  writeJsonl(codexFile, [
    { type: "session_meta", timestamp: "2026-07-09T23:50:00.000Z", payload: { cwd } },
    {
      type: "response_item",
      timestamp: "2026-07-10T02:00:00.000Z",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "实现 Codex 增量索引" }] },
    },
    {
      type: "response_item",
      timestamp: "2026-07-10T02:01:00.000Z",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "已完成 Codex 增量索引" }] },
    },
  ]);

  const options = {
    since: "2026-07-10",
    until: "2026-07-10",
    homeDir: tempRoot,
    claudeProjects: claudeRoot,
    claudeBackupProjects: backupRoot,
    codexSessions: codexRoot,
    cachePath,
  };
  const cold = await collectAiSessions(options);
  assert.equal(cold.byProject.length, 2);
  assert.deepEqual(new Set(cold.byProject.map((group) => group.engine)), new Set(["claude", "codex"]));
  assert.ok(cold.byProject.every((group) => group.project === cwd));
  assert.equal(cold.stats.parsedFiles, 2);
  assert.ok(cold.stats.bytesRead > 0);
  assert.equal(cold.stats.messageCount, 4, "tool_result 不应进入总结证据");

  const warm = await collectAiSessions(options);
  assert.equal(warm.stats.parsedFiles, 0);
  assert.equal(warm.stats.cacheHits, 2);
  assert.equal(warm.stats.bytesRead, 0);

  const beforeSize = fs.statSync(codexFile).size;
  fs.appendFileSync(codexFile, `${JSON.stringify({
    type: "response_item",
    timestamp: "2026-07-10T03:00:00.000Z",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "只读取新增字节" }] },
  })}\n`, "utf8");
  const incremental = await collectAiSessions(options);
  const codex = incremental.byProject.find((group) => group.engine === "codex");
  assert.equal(incremental.stats.parsedFiles, 1);
  assert.equal(incremental.stats.incrementalFiles, 1);
  assert.ok(incremental.stats.bytesRead < beforeSize);
  assert.equal(codex.prompts.length, 2);
});

test("工作总结上下文：简洁版与报告版使用不同预算，模板对所有周期生效", () => {
  const gitData = Array.from({ length: 8 }, (_, repoIndex) => ({
    name: `repo-${repoIndex}`,
    total: { files: 20, insertions: 100, deletions: 10 },
    commits: Array.from({ length: 80 }, (_, commitIndex) => ({
      date: "2026-07-10",
      hash: `${repoIndex}${commitIndex}`.padEnd(8, "0"),
      message: `提交 ${repoIndex}-${commitIndex} ${"细节".repeat(80)}`,
    })),
  }));
  const cliData = Array.from({ length: 40 }, (_, groupIndex) => ({
    engine: groupIndex % 2 ? "codex" : "claude",
    project: `D:/workspace/project-${groupIndex}`,
    sessionCount: 3,
    prompts: Array.from({ length: 30 }, (_, promptIndex) => ({
      ts: promptIndex,
      text: `工程 ${groupIndex} 指令 ${promptIndex} ${"实现细节".repeat(80)}`,
    })),
    assistants: Array.from({ length: 10 }, (_, answerIndex) => ({
      ts: answerIndex,
      text: `工程 ${groupIndex} 回答 ${answerIndex} ${"结果".repeat(80)}`,
    })),
  }));
  const chatData = Array.from({ length: 20 }, (_, storyIndex) => ({
    title: `故事点-${storyIndex}`,
    messages: Array.from({ length: 20 }, (_, messageIndex) => ({
      role: messageIndex % 2 ? "assistant" : "user",
      engine: "codex",
      content: `消息 ${storyIndex}-${messageIndex} ${"内容".repeat(100)}`,
    })),
  }));

  const context = buildDataContext(gitData, chatData, cliData);
  assert.ok(context.text.length <= 18000);
  assert.equal(context.stats.truncated, true);
  assert.match(context.text, /repo-7/);
  assert.match(context.text, /project-39/);

  const meta = reportMeta("custom", "2026-07-01", "2026-07-10");
  const concisePrompt = buildPrompt(meta, context.text, "");
  const reportPrompt = buildPrompt(meta, context.text, "成果\n图片\n附件", {
    mode: "report",
    templateName: "项目汇报",
  });
  assert.ok(concisePrompt.length < 32000);
  assert.match(concisePrompt, /简洁版/);
  assert.match(concisePrompt, /本周完成工作/);
  assert.match(reportPrompt, /报告版/);
  assert.match(reportPrompt, /选定模板：项目汇报/);
  assert.match(reportPrompt, /🎬视频/);

  const plain = markdownToPlainText("# 标题\n\n- **成果**：[链接](https://example.test)");
  assert.equal(plain, "标题\n- 成果：链接");
});

test("工作总结输出模式默认高效简洁版，也支持双版本与空选择", () => {
  assert.deepEqual(normalizeSummaryOutputModes(), { concise: true, report: false });
  assert.deepEqual(
    normalizeSummaryOutputModes({ concise: true, report: true }),
    { concise: true, report: true },
  );
  assert.deepEqual(
    normalizeSummaryOutputModes({ concise: false, report: false }),
    { concise: false, report: false },
  );
  assert.deepEqual(DEFAULT_WEEKLY_TEMPLATE.split("\n"), [
    "本周完成工作",
    "下周工作计划",
    "本周工作总结",
    "需协调与帮助",
    "图片",
    "附件",
  ]);
});

test("上传模板文件：文本可提取，AI 返回内容会去除代码围栏", async () => {
  const extracted = await extractSummaryTemplateSource({
    buffer: Buffer.from("本周成果\n下周计划", "utf8"),
    fileName: "周报.md",
    mimeType: "text/markdown",
  });
  assert.equal(extracted.kind, "text");
  assert.equal(extracted.text, "本周成果\n下周计划");
  assert.equal(sanitizeAnalyzedSummaryTemplate("```markdown\n成果\n附件\n```"), "成果\n附件");
});

test("工作总结 AI：CLI 兼容服务映射到同配置的纯文本 API", () => {
  const config = {
    apiEngines: {
      volcengine: { enabled: true, apiKey: "test-key", model: "ark-code-latest" },
      atlas: { enabled: true, apiKey: "atlas-key", model: "zai-org/glm-5.1" },
    },
  };
  assert.equal(selectSummaryTextEngine("claude-volcengine", config), "volcengine");
  assert.equal(selectSummaryTextEngine("claude-atlas", config), "atlas");
  assert.equal(selectSummaryTextEngine("codex-atlas", config), "atlas");
  assert.equal(selectSummaryTextEngine("hermes-atlas", config), "atlas");
  assert.equal(selectSummaryTextEngine("codex", config), "codex");
  assert.equal(selectSummaryTextEngine("claude-volcengine", { apiEngines: {} }), "claude-volcengine");
  assert.equal(selectSummaryTextEngine("claude-atlas", { apiEngines: {} }), "claude-atlas");
});

test("工作总结 AI：流式正文与思考分离并保留 usage", async () => {
  const encoder = new TextEncoder();
  const response = {
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"分析"}}]}\r\n'));
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"# 总结"}}]}\n'));
        controller.enqueue(encoder.encode('data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3}}\n'));
        controller.enqueue(encoder.encode("data: [DONE]\n"));
        controller.close();
      },
    }),
  };
  const chunks = [];
  const result = await readApiTextStream(response, {
    onChunk: (chunk, type) => chunks.push([type, chunk]),
  });
  assert.equal(result.text, "# 总结");
  assert.deepEqual(chunks, [["thinking", "分析"], ["text", "# 总结"]]);
  assert.deepEqual(result.usage, {
    inputTokens: 12,
    outputTokens: 3,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: null,
  });
  assert.equal(result.finishReason, "");
});
