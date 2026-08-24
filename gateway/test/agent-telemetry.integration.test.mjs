import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-telemetry-integration-"));
const dbPath = path.join(tempRoot, "gateway.db");
const configPath = path.join(tempRoot, "gateway.json");
const artifactRoots = [];

process.env.NODE_ENV = "test";
process.env.GATEWAY_DB_PATH = dbPath;
process.env.GATEWAY_CONFIG_PATH = configPath;
fs.writeFileSync(configPath, JSON.stringify({
  defaultEngine: "deepseek",
  autoFallback: false,
  apiMaxToolIterations: 5,
  workDir: tempRoot,
  apiAgent: { workspaceIsolation: true, commandPolicy: "workspace" },
  apiEngines: {
    deepseek: {
      enabled: true,
      name: "DeepSeek",
      baseUrl: "https://deepseek.invalid",
      apiKey: "test-only-key",
      model: "deepseek-fixture",
      thinkingEnabled: false,
    },
  },
}), "utf8");

// 模拟 M0 之前已经存在的最小 token_usage 表，模块加载必须把它原地升级。
const legacyDb = new Database(dbPath);
legacyDb.exec(`
  CREATE TABLE token_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT,
    engine TEXT NOT NULL,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    succeeded INTEGER,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  );
  INSERT INTO token_usage (task_id, engine, input_tokens, output_tokens, succeeded)
  VALUES ('legacy-m0-row', 'deepseek', 5, 2, 1)
`);
legacyDb.close();

const sqlite = await import("../db/sqlite.js");
const { runTask } = await import("../services/agent-runner.js");
const { analyzeSummaryTemplateFile } = await import("../services/devbench/report.js");
const configService = await import("../services/config.js");

const originalFetch = global.fetch;

function sseResponse({ content = "", toolCalls = [], finishReason = "stop", usage = null } = {}) {
  const encoder = new TextEncoder();
  const events = [];
  if (content) events.push({ choices: [{ delta: { content } }] });
  toolCalls.forEach((call, index) => {
    events.push({
      choices: [{
        delta: {
          tool_calls: [{
            index,
            id: call.id,
            type: "function",
            function: { name: call.function.name, arguments: "" },
          }],
        },
      }],
    });
    events.push({
      choices: [{
        delta: {
          tool_calls: [{ index, function: { arguments: call.function.arguments } }],
        },
      }],
    });
  });
  events.push({ choices: [{ delta: {}, finish_reason: finishReason }], ...(usage ? { usage } : {}) });
  const body = new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return { ok: true, status: 200, body, text: async () => "", json: async () => ({}) };
}

function createTask({ id, prompt, attemptId }) {
  const task = {
    id,
    title: "telemetry integration",
    description: "描述字段不能代替实际 Prompt",
    promptOverride: prompt,
    type: "general",
    status: "pending",
    priority: 3,
    source: "test",
    sourceId: `session-${id}`,
    explicitEngine: "deepseek",
    allowEngineFallback: false,
    cwd: tempRoot,
    workflowKind: "storydev",
    telemetryContext: {
      storyId: "story-integration",
      attemptId,
      workflowKind: "storydev",
      stage: "REPAIR",
      contextId: "context-integration",
      contextRevision: 3,
      turnAttempt: 1,
    },
  };
  sqlite.createTask(task);
  artifactRoots.push(path.join(os.tmpdir(), "aiefficiency", "api-artifacts", id));
  return task;
}

function usageRows(where = "1=1") {
  return sqlite.default.prepare(`SELECT * FROM token_usage WHERE ${where} ORDER BY id`).all();
}

after(() => {
  global.fetch = originalFetch;
  sqlite.default.close();
  const artifactBase = path.resolve(os.tmpdir(), "aiefficiency", "api-artifacts");
  for (const candidate of artifactRoots) {
    const resolved = path.resolve(candidate);
    const relative = path.relative(artifactBase, resolved);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("旧 token_usage 表升级后具备可查询的执行遥测列", () => {
  const columns = new Set(sqlite.default.prepare("PRAGMA table_info(token_usage)").all().map((row) => row.name));
  for (const name of [
    "usage_source",
    "prompt_chars",
    "prompt_sha256",
    "request_attempts",
    "retry_count",
    "tool_rounds",
    "execution_succeeded",
  ]) {
    assert.equal(columns.has(name), true, `missing migrated column ${name}`);
  }
  const migrated = sqlite.default.prepare("SELECT * FROM token_usage WHERE task_id = ?").get("legacy-m0-row");
  assert.equal(migrated.execution_succeeded, 1);
  assert.equal(migrated.usage_source, "estimated");
});

test("两个 Gateway 同时升级同一旧库不会因重复列而启动失败", async () => {
  const raceDbPath = path.join(tempRoot, "migration-race.db");
  const raceDb = new Database(raceDbPath);
  raceDb.exec(`
    CREATE TABLE token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT,
      engine TEXT NOT NULL,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    )
  `);
  raceDb.close();

  const sqliteUrl = new URL("../db/sqlite.js", import.meta.url).href;
  const childCode = `const module = await import(${JSON.stringify(sqliteUrl)}); module.default.close();`;
  const runImporter = () => new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", childCode], {
      cwd: process.cwd(),
      env: { ...process.env, GATEWAY_DB_PATH: raceDbPath },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stderr }));
  });
  const results = await Promise.all([runImporter(), runImporter()]);
  assert.deepEqual(results.map((item) => item.code), [0, 0], JSON.stringify(results));

  const verified = new Database(raceDbPath, { readonly: true });
  const columns = new Set(verified.prepare("PRAGMA table_info(token_usage)").all().map((row) => row.name));
  verified.close();
  assert.equal(columns.has("execution_succeeded"), true);
  assert.equal(columns.has("usage_source"), true);
});

test("两个 Gateway 对相同 TB 写入指纹并发观测时只标记一个重复候选", async () => {
  const sqliteUrl = new URL("../db/sqlite.js", import.meta.url).href;
  const tbTaskId = "fedcba987654321001234567";
  const fingerprint = createHash("sha256").update(`cross-gateway-${randomUUID()}`, "utf8").digest("hex");
  const startAt = Date.now() + 500;
  const childCode = `
    const module = await import(${JSON.stringify(sqliteUrl)});
    const delay = Math.max(0, Number(process.env.OBS_START_AT) - Date.now());
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    const result = module.recordTbWriteObservation({
      storyId: "story-cross-gateway",
      tbTaskId: ${JSON.stringify(tbTaskId)},
      writeKind: "comment",
      payloadSha256: ${JSON.stringify(fingerprint)},
      outcome: "succeeded",
    });
    process.stdout.write(JSON.stringify({ duplicateCandidate: result.duplicateCandidate }));
    module.default.close();
  `;
  const runWriter = () => new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", childCode], {
      cwd: process.cwd(),
      env: { ...process.env, GATEWAY_DB_PATH: dbPath, OBS_START_AT: String(startAt) },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  const results = await Promise.all([runWriter(), runWriter()]);
  assert.deepEqual(results.map((item) => item.code), [0, 0], JSON.stringify(results));
  assert.deepEqual(
    results.map((item) => JSON.parse(item.stdout).duplicateCandidate).sort(),
    [false, true],
  );
  const rows = sqlite.default.prepare(`
    SELECT duplicate_candidate
    FROM tb_write_observations
    WHERE tb_task_id = ? AND write_kind = 'comment' AND payload_sha256 = ?
  `).all(tbTaskId, fingerprint);
  assert.equal(rows.length, 2);
  assert.equal(rows.reduce((sum, row) => sum + row.duplicate_candidate, 0), 1);
});

test("API → agent-runner → SQLite 对成功和失败执行各持久化一次", async () => {
  const successId = `telemetry-success-${randomUUID()}`;
  const successPrompt = "精确 😀 Prompt";
  global.fetch = async () => sseResponse({
    toolCalls: [{
      id: "finish-success",
      function: {
        name: "finish_task",
        arguments: JSON.stringify({
          status: "completed",
          summary: "遥测集成链路完成",
          changes: [],
          verification: ["fixture"],
          remaining: [],
          final_response: "任务状态：已完成\n\n遥测集成链路完成。",
        }),
      },
    }],
    finishReason: "tool_calls",
    usage: {
      prompt_tokens: 73,
      completion_tokens: 11,
      prompt_cache_hit_tokens: 4,
      cache_creation_input_tokens: 2,
    },
  });
  const successTask = createTask({ id: successId, prompt: successPrompt, attemptId: "attempt-success" });
  const result = await runTask(successTask);
  assert.equal(result.telemetry.executionSucceeded, true);

  const [successRow] = usageRows(`task_id = '${successId}'`);
  assert.equal(usageRows(`task_id = '${successId}'`).length, 1);
  assert.equal(successRow.usage_source, "provider");
  assert.equal(successRow.input_tokens, 73);
  assert.equal(successRow.output_tokens, 11);
  assert.equal(successRow.cache_read_tokens, 4);
  assert.equal(successRow.cache_creation_tokens, 2);
  assert.equal(successRow.prompt_chars, Array.from(successPrompt).length);
  assert.equal(successRow.prompt_sha256, createHash("sha256").update(successPrompt, "utf8").digest("hex"));
  assert.equal(successRow.request_count, 1);
  assert.equal(successRow.request_attempts, 1);
  assert.equal(successRow.tool_rounds, 1);
  assert.equal(successRow.tool_calls, 1);
  assert.equal(successRow.execution_succeeded, 1);

  const unavailableId = `telemetry-unavailable-${randomUUID()}`;
  global.fetch = async () => sseResponse({
    toolCalls: [{
      id: "finish-unavailable",
      function: {
        name: "finish_task",
        arguments: JSON.stringify({
          status: "completed",
          summary: "Provider 未返回 usage",
          changes: [],
          verification: ["fixture"],
          remaining: [],
          final_response: "任务状态：已完成\n\nProvider 未返回 usage。",
        }),
      },
    }],
    finishReason: "tool_calls",
  });
  const unavailableTask = createTask({
    id: unavailableId,
    prompt: "API 无 usage Prompt",
    attemptId: "attempt-unavailable",
  });
  const unavailableResult = await runTask(unavailableTask);
  assert.equal(unavailableResult.telemetry.usage.source, "unavailable");
  const [unavailableRow] = usageRows(`task_id = '${unavailableId}'`);
  assert.equal(unavailableRow.usage_source, "unavailable");
  assert.equal(unavailableRow.input_tokens, 0);
  assert.equal(unavailableRow.output_tokens, 0);
  assert.equal(unavailableRow.execution_succeeded, 1);

  const failureId = `telemetry-failure-${randomUUID()}`;
  global.fetch = async () => ({
    ok: false,
    status: 500,
    body: null,
    text: async () => "fatal fixture failure",
  });
  const failureTask = createTask({ id: failureId, prompt: "失败 Prompt", attemptId: "attempt-failure" });
  await assert.rejects(runTask(failureTask), /500/);

  const failureRows = usageRows(`task_id = '${failureId}'`);
  assert.equal(failureRows.length, 1);
  assert.equal(failureRows[0].usage_source, "unavailable");
  assert.equal(failureRows[0].input_tokens, 0);
  assert.equal(failureRows[0].output_tokens, 0);
  assert.equal(failureRows[0].request_count, 0);
  assert.equal(failureRows[0].request_attempts, 1);
  assert.equal(failureRows[0].execution_succeeded, 0);
  const storedFailure = JSON.parse(sqlite.getTask(failureId).result);
  assert.equal(storedFailure.telemetry.executionSucceeded, false);
  assert.equal(storedFailure.telemetry.usage.source, "unavailable");
});

test("agent-runner 实际 API 链路冻结 structured descriptor 并传入唯一 finish_stage", async () => {
  const id = `telemetry-structured-${randomUUID()}`;
  const prompt = "STRUCTURED PROVIDER INTEGRATION";
  const task = createTask({ id, prompt, attemptId: "attempt-structured" });
  const structuredOutput = {
    mode: "structured",
    strategy: "finish_stage",
    schemaId: "urn:aiefficiency:workflow-v2:integration-result",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: { conclusion: { type: "string", enum: ["PASS", "FAIL"] } },
      required: ["conclusion"],
    },
    contextId: "context-structured-integration",
    contextRevision: 9,
    idempotencyKey: "story-integration:VERIFY:9",
  };
  Object.assign(task, {
    promptMode: "structured",
    promptSha256: createHash("sha256").update(prompt, "utf8").digest("hex"),
    cliSessionId: null,
    streamingInput: false,
    imagePaths: [],
    structuredOutput,
    telemetryContext: {
      ...task.telemetryContext,
      promptMode: "structured",
      contextId: structuredOutput.contextId,
      contextRevision: structuredOutput.contextRevision,
      contextHash: "c".repeat(64),
      schemaId: structuredOutput.schemaId,
      idempotencyKey: structuredOutput.idempotencyKey,
      stage: "VERIFY",
    },
  });
  const requests = [];
  global.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return sseResponse({
      toolCalls: [{
        id: "finish-structured-integration",
        function: {
          name: "finish_stage",
          arguments: JSON.stringify({ conclusion: "PASS" }),
        },
      }],
      finishReason: "tool_calls",
      usage: { prompt_tokens: 31, completion_tokens: 4 },
    });
  };

  const running = runTask(task);
  structuredOutput.schema.properties.conclusion.enum.push("MUTATED");
  structuredOutput.schemaId = "mutated-after-runTask";
  task.telemetryContext.contextId = "mutated-after-runTask";
  const result = await running;

  const terminalTools = requests[0].tools.filter((tool) => ["finish_task", "finish_stage"].includes(tool.function.name));
  assert.deepEqual(terminalTools.map((tool) => tool.function.name), ["finish_stage"]);
  assert.deepEqual(terminalTools[0].function.parameters.properties.conclusion.enum, ["PASS", "FAIL"]);
  assert.equal(result.structuredSchemaId, "urn:aiefficiency:workflow-v2:integration-result");
  assert.deepEqual(result.structuredResult, { conclusion: "PASS" });
  assert.equal(result.report, "");
  assert.equal(result.telemetry.contextId, "context-structured-integration");
  assert.equal(result.telemetry.requestAttempts, 1);
  const [usageRow] = usageRows(`task_id = '${id}'`);
  assert.equal(usageRow.input_tokens, 31);
  assert.equal(usageRow.output_tokens, 4);
  const stored = sqlite.getTask(id);
  const apiReadableResult = JSON.parse(stored.result);
  assert.equal(apiReadableResult.schemaId, "urn:aiefficiency:workflow-v2:integration-result");
  assert.equal(apiReadableResult.contextId, "context-structured-integration");
  assert.equal(apiReadableResult.contextRevision, 9);
  assert.equal(apiReadableResult.usage.inputTokens, 31);
  assert.equal(apiReadableResult.usage.outputTokens, 4);
  assert.equal(apiReadableResult.telemetry.contextId, "context-structured-integration");
  assert.equal(apiReadableResult.telemetry.executionSucceeded, true);
  assert.equal(Object.hasOwn(apiReadableResult, "structuredResult"), false);
  assert.equal(Object.hasOwn(apiReadableResult, "receiptIds"), false);
  assert.equal(Object.hasOwn(apiReadableResult, "transcript"), false);
  assert.doesNotMatch(JSON.stringify(stored), /"conclusion":"PASS"/, "task API 数据源不得泄漏 raw structured result");
});

test("API 预检失败且未发出 Provider 请求时持久化零请求计数", async () => {
  const taskId = `telemetry-preflight-${randomUUID()}`;
  const originalApiEngines = structuredClone(configService.getConfigValue("apiEngines"));
  const originalFetchForTest = global.fetch;
  let fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls += 1;
    throw new Error("预检失败时不应调用 fetch");
  };

  try {
    configService.updateConfig({
      apiEngines: {
        ...originalApiEngines,
        deepseek: { ...originalApiEngines.deepseek, baseUrl: "" },
      },
    });
    const task = createTask({
      id: taskId,
      prompt: "API 预检失败 Prompt",
      attemptId: "attempt-preflight",
    });
    await assert.rejects(runTask(task), /Base URL/);
    assert.equal(fetchCalls, 0);

    const rows = usageRows(`task_id = '${taskId}'`);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].request_attempts, 0);
    assert.equal(rows[0].request_count, 0);
    assert.equal(rows[0].input_tokens, 0);
    assert.equal(rows[0].output_tokens, 0);
    assert.equal(rows[0].usage_source, "unavailable");
    assert.equal(rows[0].execution_succeeded, 0);

    const stored = JSON.parse(sqlite.getTask(taskId).result);
    assert.equal(stored.telemetry.requestAttempts, 0);
    assert.equal(stored.telemetry.requestCount, 0);
    assert.deepEqual(stored.telemetry.requests, []);
  } finally {
    try {
      configService.updateConfig({ apiEngines: originalApiEngines });
    } finally {
      global.fetch = originalFetchForTest;
    }
  }
});

test("工作总结兼容重试与失败都使用纯文本 API 的真实遥测落库", async () => {
  let requestCount = 0;
  global.fetch = async () => {
    requestCount += 1;
    if (requestCount === 1) {
      return {
        ok: false,
        status: 400,
        body: null,
        text: async () => "unsupported stream_options",
      };
    }
    return sseResponse({
      content: "## 项目\n- [填写内容]",
      usage: { prompt_tokens: 41, completion_tokens: 9 },
    });
  };

  const analyzed = await analyzeSummaryTemplateFile({
    buffer: Buffer.from("项目：示例\n进展：示例", "utf8"),
    fileName: "summary.txt",
    mimeType: "text/plain",
  });
  assert.equal(analyzed.ok, true);
  assert.equal(requestCount, 2);

  const succeeded = usageRows("workflow_kind = 'report_template' AND execution_succeeded = 1");
  assert.equal(succeeded.length, 1);
  assert.equal(succeeded[0].usage_source, "provider");
  assert.equal(succeeded[0].request_count, 1);
  assert.equal(succeeded[0].request_attempts, 2);
  assert.equal(succeeded[0].retry_count, 1);
  assert.equal(succeeded[0].input_tokens, 41);
  assert.equal(succeeded[0].output_tokens, 9);
  assert.ok(succeeded[0].prompt_chars > 0);
  assert.ok(succeeded[0].system_chars > 0);

  global.fetch = async () => ({
    ok: false,
    status: 503,
    body: null,
    text: async () => "report fixture unavailable",
  });
  await assert.rejects(
    analyzeSummaryTemplateFile({
      buffer: Buffer.from("项目：失败示例", "utf8"),
      fileName: "summary-failure.txt",
      mimeType: "text/plain",
    }),
    /503/,
  );
  const failed = usageRows("workflow_kind = 'report_template' AND execution_succeeded = 0");
  assert.equal(failed.length, 1);
  assert.equal(failed[0].usage_source, "unavailable");
  assert.equal(failed[0].request_count, 0);
  assert.equal(failed[0].request_attempts, 1);
});
