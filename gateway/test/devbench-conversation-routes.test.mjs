import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, "../routes/devbench.js"), "utf8");

test("conversation routes keep legacy endpoints and expose branch commands", () => {
  assert.match(source, /router\.get\("\/tabs\/:id\/conversation"/);
  assert.match(source, /router\.post\("\/tabs\/:id\/send"/);
  assert.match(source, /router\.post\("\/tabs\/:id\/conversation\/edit-and-resend"/);
  assert.match(source, /router\.put\("\/tabs\/:id\/conversation\/head"/);
});

test("edit route requires external-state acknowledgement and optimistic revision", () => {
  assert.match(source, /EXTERNAL_STATE_ACKNOWLEDGEMENT_REQUIRED/);
  assert.match(source, /CONVERSATION_REVISION_CONFLICT/);
  assert.match(source, /CONVERSATION_AI_RUNNING/);
  assert.match(source, /CONVERSATION_QUEUE_NOT_EMPTY/);
});

test("legacy send accepts structured display input without removing content", () => {
  assert.match(source, /req\.body\?\.messageInput\?\.text/);
  assert.match(source, /displayContent/);
  assert.match(source, /messageConversationOptions/);
});

test("send idempotency lookup is inside the tab lock and before every delivery side effect", () => {
  const start = source.indexOf('router.post("/tabs/:id/send"');
  const end = source.indexOf("async function kickTriage", start);
  const route = source.slice(start, end);
  const lock = route.indexOf("acquireTabSendLock(req.params.id)");
  const lookup = route.indexOf("sendIdempotencyRecord(tab, sendIdempotencyMarker)");
  assert.ok(lock >= 0 && lookup > lock, "幂等查询必须位于 tab send lock 内");
  for (const sideEffect of [
    "refreshGitCommitLatestBranch",
    "fetchAndSaveTbNote",
    "injectIntoTask",
    "enqueueTabMessage",
    "kickTriage",
    "kickVerify",
    "kickReport",
    "sendTurnWithDeviceRuntime",
  ]) {
    assert.ok(route.indexOf(sideEffect) > lookup, `${sideEffect} 必须晚于幂等查询`);
  }
});

test("all user-message delivery paths enforce base-repository to worktree resolution", () => {
  assert.match(source, /prepareStoryMessageForAgent\(tab, content\)/);
  assert.match(source, /rejectUnsafeStoryRepositoryReference\(res, repositoryPathResolution\)/);
  assert.match(source, /repositoryPathResolution\.executionContent/);
  assert.match(source, /injectIntoTask\(tab\.runningTaskId, injectedContent\)/);
  assert.match(source, /freezeQueuedSendIdentity\(\s*tab\?\.id \|\| req\.params\.id,\s*content,\s*messageConversationOptions,/);
  assert.match(source, /enqueueTabMessage\(tab\.id, queuedMessage\)/);
  assert.match(source, /sendTurnWithDeviceRuntime\(runtime\.tab, content/);
  assert.match(source, /repositoryPathAlert: result\.repositoryPathAlert/);
});

test("自由聊天冻结为 chat，流程按钮和明确流程话术保留确定性阶段", () => {
  const sendStart = source.indexOf('router.post("/tabs/:id/send"');
  const sendEnd = source.indexOf("async function kickTriage", sendStart);
  const sendRoute = source.slice(sendStart, sendEnd);
  assert.match(source, /resolveUserTurnWorkflowKind/);
  assert.match(sendRoute, /userWorkflowKind\s*=\s*resolveUserTurnWorkflowKind\(tab, content\)/);
  assert.match(sendRoute, /workflowKind:\s*userWorkflowKind/);
  assert.match(sendRoute, /freeChatNeedsSeparateTurn\s*=\s*userWorkflowKind\s*===\s*"chat"/);
  assert.match(sendRoute, /!freeChatNeedsSeparateTurn\s*&&\s*taskAgentRunning\s*&&\s*await injectIntoTask/);
  assert.match(sendRoute, /isWorkflowVerifyRequest\(content\)/);
  assert.match(sendRoute, /isWorkflowReportSubmitRequest\(content\)/);

  const editStart = source.indexOf('router.post("/tabs/:id/conversation/edit-and-resend"');
  const editEnd = source.indexOf('router.put("/tabs/:id/conversation/head"', editStart);
  assert.match(source.slice(editStart, editEnd), /workflowKind:\s*resolveUserTurnWorkflowKind\(runtime\.tab, content\)/);

  const markFixedStart = source.indexOf('router.post("/tabs/:id/workflow/mark-fixed"');
  const markFixedEnd = source.indexOf('router.post("/tabs/:id/workflow/verify"', markFixedStart);
  assert.match(source.slice(markFixedStart, markFixedEnd), /workflowKind:\s*"repair"/);
});

test("Git 冲突 AI 修复在聊天区只显示短动作，同时保留完整安全 Prompt", () => {
  const start = source.indexOf("async function launchGitConflictResolution");
  const end = source.indexOf("// 让 AI 解决一个或多个 worktree", start);
  const flow = source.slice(start, end);

  assert.ok(start >= 0 && end > start, "应能定位 Git 冲突 AI 修复派发函数");
  assert.match(flow, /const displayContent = "修复Git合并冲突"/);
  assert.match(flow, /conversation:\s*\{[\s\S]*displayContent,[\s\S]*messageInput:\s*\{[\s\S]*text:\s*displayContent,[\s\S]*actionKind:\s*"git_conflict_resolution"/);
  assert.match(flow, /操作范围严格限制为列出的仓库路径和冲突文件/);
  assert.match(flow, /仅对该仓库列出的文件执行 git add -- <file>/);
  assert.match(flow, /不得执行 git commit、push、stash、reset、clean、切换分支或 merge --abort/);
  assert.doesNotMatch(flow, /sendTurnWithDeviceRuntime\(store\.getTab\(tab\.id\),\s*displayContent/);
});
