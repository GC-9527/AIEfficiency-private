import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  buildHermesOneshotArgs,
  hermesExecutable,
  hermesInstallGuide,
  hermesPromptReference,
  normalizeHermesUsage,
} from "../services/hermes-cli.js";

test("Hermes oneshot 仅在命令行传临时文件引用，不内联完整 Prompt", () => {
  const promptFile = path.resolve("tmp", "prompt.txt");
  const usageFile = path.resolve("tmp", "usage.json");
  const args = buildHermesOneshotArgs({ promptFile, usageFile, model: "deepseek-v4-flash" });
  assert.equal(args[0], "--oneshot");
  assert.match(args[1], /Read the complete UTF-8 file/);
  assert.equal(args[1].includes(JSON.stringify(promptFile)), true);
  assert.deepEqual(args.slice(2), ["--model", "deepseek-v4-flash", "--usage-file", usageFile]);
  assert.doesNotMatch(hermesPromptReference(promptFile), /\r|\n/);
});

test("Hermes usage JSON 映射到网关统一字段", () => {
  assert.deepEqual(normalizeHermesUsage({
    input_tokens: 10,
    output_tokens: 4,
    cache_read_tokens: 3,
    cache_write_tokens: 2,
    reasoning_tokens: 1,
    total_tokens: 20,
    api_calls: 2,
    estimated_cost_usd: 0.01,
    model: "local-model",
    provider: "local-provider",
    completed: true,
    failed: false,
  }), {
    inputTokens: 10,
    outputTokens: 4,
    cacheReadTokens: 3,
    cacheCreationTokens: 2,
    reasoningTokens: 1,
    totalTokens: 20,
    apiCalls: 2,
    costUsd: 0.01,
    model: "local-model",
    provider: "local-provider",
    completed: true,
    failed: false,
  });
});

test("Hermes 命令与安装提示按平台生成，允许本机显式覆盖命令路径", () => {
  assert.equal(hermesExecutable("win32", {}), "hermes.exe");
  assert.equal(hermesExecutable("linux", {}), "hermes");
  assert.equal(hermesExecutable("win32", { AIEFF_HERMES_EXECUTABLE: "D:\\tools\\hermes.exe" }), "D:\\tools\\hermes.exe");
  assert.match(hermesInstallGuide("win32").command, /install\.ps1/);
  assert.equal(hermesInstallGuide("win32").manualOnly, true);
});
