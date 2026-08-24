import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../services/devbench/index.js", import.meta.url), "utf8");
const runnerSource = fs.readFileSync(new URL("../services/agent-runner.js", import.meta.url), "utf8");
const routesSource = fs.readFileSync(new URL("../routes/devbench.js", import.meta.url), "utf8");

function section(from, to, input = source) {
  const start = input.indexOf(from);
  const end = input.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start, `missing section ${from} -> ${to}`);
  return input.slice(start, end);
}

test("Prompt overlay 在真实派发边界由服务端解析且与 Full V2 同轮互斥", () => {
  const boundary = section("async function sendTurnAtDispatchBoundary", "export async function sendTurnWithDeviceRuntime");
  assert.match(boundary, /resolvePromptOverlaySelection\(configSnapshot, latest, engine, stageId\)/);
  assert.match(boundary, /rollout\.selected && promptOverlaySelection\.selected/);
  assert.match(boundary, /PROMPT_COMPATIBILITY_OVERLAY_MODE_CONFLICT/);

  const direct = section("export function sendTurn(", "// 旧故事点 docSlug");
  assert.match(direct, /resolvePromptOverlaySelection\(dispatchConfig, tab, engine, compatibilityStage\)/);
  assert.match(direct, /opts = \{ \.\.\.opts, promptOverlay \}/);
  assert.match(direct, /preparePromptOverlayDescriptor\(promptOverlaySelection\)/);
});

test("Prompt overlay task 保持 legacy，且不获得 StageContext、tool policy 或 receipt recorder", () => {
  const modeSetup = section("const compatibilityPromptTurn", "const editingConversation");
  assert.match(modeSetup, /const promptOverlayTurn = opts\.promptOverlay\?\.selected === true/);
  assert.doesNotMatch(modeSetup, /promptOverlayTurn.*workflowV2PromptTurn/);

  const taskSetup = section("const task = {", "// 先建任务行");
  assert.match(taskSetup, /promptMode:\s*workflowV2PromptTurn \? opts\.workflowV2Dispatch\.promptMode : "legacy"/);
  assert.match(taskSetup, /promptVariant:\s*promptOverlayTurn \? PROMPT_COMPATIBILITY_OVERLAY_VARIANT : "legacy"/);
  assert.match(taskSetup, /stageToolPolicy:\s*workflowV2PromptTurn \?/);
  assert.match(taskSetup, /stageReceiptRecorder:\s*workflowV2PromptTurn &&/);
  assert.doesNotMatch(taskSetup, /stageToolPolicy:\s*promptOverlayTurn|stageReceiptRecorder:\s*promptOverlayTurn/);

  const cliClassifier = section("export function isWorkflowV2CliPromptTurn", "export function assertWorkflowV2CliWorkerBoundary", runnerSource);
  assert.match(cliClassifier, /promptMode === "structured" \|\| promptMode === "compatibility"/);
  assert.doesNotMatch(cliClassifier, /promptVariant|phase2_overlay/);
});

test("Prompt overlay 只改变 Prompt，结果解析与 TB 结算保持 legacy", () => {
  const success = section("const onTurnSuccess = async", "const onTurnFailure =");
  assert.doesNotMatch(source, /prompt-overlay-result-gate|validatePromptOverlayWorkflowResult|promptOverlayGate/);
  const legacyParse = success.indexOf("wf = parseWorkflowMarkers(reviewClean)");
  const legacyApply = success.indexOf("} else if (!structuredPromptTurn && triggerWorkflow)", legacyParse);
  assert.ok(legacyParse >= 0 && legacyApply > legacyParse);
  assert.match(success.slice(legacyApply), /applyWorkflow\(store\.getTab\(tab\.id\) \|\| tab, wf/);
});

test("Prompt overlay 排队身份由服务端冻结，策略漂移和报告模式漂移均阻断", () => {
  assert.match(source, /export function freezePromptOverlayDecisionForQueue/);
  assert.match(source, /PROMPT_COMPATIBILITY_OVERLAY_QUEUE_POLICY_DRIFT/);
  assert.match(source, /PROMPT_COMPATIBILITY_OVERLAY_REPORT_MODE_STALE/);
  assert.match(routesSource, /freezeQueuedSendForCurrentPromptPolicy/);
  assert.match(routesSource, /promptOverlayDecision:\s*current\.promptOverlayDecision/);
  const deviceQueue = section("if (acquisition.status === \"queued\")", "if (acquisition.status !== \"acquired\"", source);
  assert.match(deviceQueue, /freezePromptOverlayDecisionForQueue\(latestTab, content, opts\)/);
  assert.match(deviceQueue, /promptOverlayDecision/);
});

test("Prompt overlay CLI stale-session 重试复用字节一致 Prompt 且审计失败关闭", () => {
  assert.match(source, /const frozenPromptRetryTurn = workflowV2PromptTurn \|\| promptOverlayTurn/);
  assert.match(source, /const freshPrompt = frozenPromptRetryTurn\s*\? promptOverride/);
  assert.match(source, /PROMPT_COMPATIBILITY_OVERLAY_RETRY_PERSIST_FAILED/);
});

test("Full V2 缺 confined executor 的原阻断仍保留", () => {
  const executionGate = section("function assertWorkflowV2ExecutionReady", "function workflowV2ResultDispatchPolicy");
  assert.match(executionGate, /WORKFLOW_V2_RECEIPT_CONFINED_EXECUTOR_UNAVAILABLE/);
  assert.match(executionGate, /throw error/);
});
