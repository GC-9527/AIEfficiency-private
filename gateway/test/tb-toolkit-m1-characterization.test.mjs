import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tb-toolkit-m1-"));
process.env.GATEWAY_CONFIG_PATH = path.join(tempRoot, "gateway.json");
process.env.GATEWAY_DB_PATH = path.join(tempRoot, "gateway.db");
process.env.DEVBENCH_CONFIG_PATH = path.join(tempRoot, "market.json");
process.env.DEVBENCH_STORE_DIR = path.join(tempRoot, "store");
process.env.AIEFFICIENCY_CLONE_PARENT = path.join(tempRoot, "clones");
fs.writeFileSync(process.env.GATEWAY_CONFIG_PATH, JSON.stringify({ servers: { nodeId: "m1-test" } }));

const fixture = JSON.parse(fs.readFileSync(
  new URL("./fixtures/tb-toolkit-m1-context.json", import.meta.url),
  "utf8",
));
const devbenchSource = fs.readFileSync(new URL("../services/devbench/index.js", import.meta.url), "utf8");
const routeSource = fs.readFileSync(new URL("../routes/devbench.js", import.meta.url), "utf8");

const {
  __testBuildTbContextSection,
  __testMergeTbAttachmentSnapshots,
  __testTbAttachmentsNeedConfirm,
  assignTbAttachmentLocalNames,
} = await import("../services/devbench/index.js");
const {
  __testBuildRejectTbSyncCandidate,
  formatShortTbComment,
} = await import("../services/devbench/tb-workflow.js");
const {
  canonicalStatus,
} = await import("../services/teambition.js");
const {
  buildTbTaskEntryPayload,
  parseTbTaskEntryInput,
} = await import("../services/devbench/tb-entry.js");
const {
  currentDevbenchActor,
  currentTbUserActor,
  principalRequiresTbTicketAccessCheck,
} = await import("../services/devbench-tb-user-access-policy.js");
const {
  runTbSyncSaga,
} = await import("../services/devbench/workflow-v2/tb-sync-saga.js");

after(() => {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
});

function pendingAttachments(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `fixture-${index + 1}`,
    name: `fixture-${index + 1}.log`,
    size: 128,
    url: `fixture://attachment/${index + 1}`,
  }));
}

function sourceSection(source, startToken, endToken) {
  const start = source.indexOf(startToken);
  const end = source.indexOf(endToken, start + startToken.length);
  assert.ok(start >= 0 && end > start, `${startToken} section must exist`);
  return source.slice(start, end);
}

test("M1 fixture 已脱敏且不包含 Cookie、Authorization、token 或签名 URL", () => {
  const serialized = JSON.stringify(fixture);
  assert.doesNotMatch(serialized, /cookie|authorization|access[_-]?token|refresh[_-]?token|x-amz-|signature=/i);
  assert.doesNotMatch(serialized, /[?&](?:token|signature|credential|security-token)=/i);
});

test("M1 TaskRef 与入口 payload 锁定 CARB、链接、状态、优先级和期限的当前映射", () => {
  assert.deepEqual(parseTbTaskEntryInput("15125"), {
    ok: true,
    kind: "number",
    lookup: "CARB-15125",
    display: "CARB-15125",
  });
  assert.equal(parseTbTaskEntryInput(fixture.resolved.ticketUrl).taskId, fixture.resolved.tbTaskId);

  const payload = buildTbTaskEntryPayload(fixture.resolved, fixture.detail);
  assert.equal(payload.tbTaskId, fixture.resolved.tbTaskId);
  assert.equal(payload.carbId, "CARB-15125");
  assert.equal(payload.statusName, "AI甄别");
  assert.equal(payload.priority, "P0");
  assert.equal(payload.deadline, "2026-08-31");
});

test("M1 BUG BASELINE TB-M0-004：所谓完整上下文会输出标题/描述/评论/附件，但静默遗漏状态、优先级、自定义字段、参与人和时间", () => {
  const rendered = __testBuildTbContextSection({ tbContext: fixture.tbContext });
  assert.match(rendered, /M1 脱敏工单/);
  assert.match(rendered, /DETAIL_SENTINEL_M1/);
  assert.match(rendered, /COMMENT_SENTINEL_M1/);
  assert.match(rendered, /ATTACHMENT_SENTINEL_M1\.log/);
  for (const missingSentinel of [
    "STATUS_SENTINEL_M1",
    "PRIORITY_SENTINEL_M1",
    "CUSTOM_FIELD_SENTINEL_M1",
    "PARTICIPANT_SENTINEL_M1",
    "CREATED_AT_SENTINEL_M1",
    "UPDATED_AT_SENTINEL_M1",
  ]) {
    assert.equal(rendered.includes(missingSentinel), false, `${missingSentinel} is currently omitted`);
  }
});

test("M1 BUG BASELINE TB-M0-004：fetchAndSaveTbContext 当前固定截断为最后 30 条且 ctx 没有完整字段键", () => {
  const section = sourceSection(
    devbenchSource,
    "export async function fetchAndSaveTbContext",
    "const TB_ATTACHMENT_MAX_COUNT",
  );
  const ctx = sourceSection(section, "const ctx = {", "try { store.updateTab");
  assert.match(section, /\.slice\(-30\)/);
  for (const key of ["statusName", "priority", "customFields", "participants", "createdAt", "updatedAt"]) {
    assert.doesNotMatch(ctx, new RegExp(`\\b${key}\\s*:`), `${key} is not persisted in current tbContext`);
  }
});

test("M1 附件聚合在 partial 读取时保留旧项、按稳定 id 合并且同名附件不互相覆盖", () => {
  const previous = [
    { id: "direct-1", name: "same.log", size: 10, source: "task", hasUrl: true },
  ];
  const fetched = [
    { id: "direct-1", name: "same.log", size: 11, source: "task", hasUrl: true },
    { id: "comment-2", name: "same.log", size: 11, source: "comment", hasUrl: true },
  ];
  const merged = __testMergeTbAttachmentSnapshots(previous, fetched, { complete: false });
  assert.deepEqual(merged.map((item) => item.id), ["direct-1", "comment-2"]);
  assert.equal(merged[0].size, 11);

  const forward = assignTbAttachmentLocalNames(merged);
  const reverse = assignTbAttachmentLocalNames([...merged].reverse());
  const namesById = (items) => Object.fromEntries(items.map((item) => [item.id, item.localName]));
  assert.deepEqual(namesById(forward), namesById(reverse));
  assert.notEqual(forward[0].localName, forward[1].localName);
});

test("M1 BUG BASELINE TB-M0-003：0/1/3/4 个附件均不确认，只有 11 个才触发当前数量门禁", () => {
  for (const count of [0, 1, 3, 4]) {
    assert.equal(__testTbAttachmentsNeedConfirm(pendingAttachments(count)).needConfirm, false, `current count=${count}`);
  }
  const eleven = __testTbAttachmentsNeedConfirm(pendingAttachments(11));
  assert.equal(eleven.needConfirm, true);
  assert.match(eleven.reasons.join("、"), /数量 11 个/);
});

test("M1 BUG BASELINE TB-M0-002：AI甄别没有逻辑状态，处理中/已解决分别被折叠到旧状态", () => {
  assert.equal(canonicalStatus("AI甄别"), null);
  assert.equal(canonicalStatus("处理中"), "修复中");
  assert.equal(canonicalStatus("已解决"), "可提测");
});

test("M1 BUG BASELINE TB-M0-007：当前短评为两行且拒绝候选仍携带 AI 模板前缀", () => {
  const report = "原因：缓存未清理导致旧状态残留\n措施：增加退出时清理缓存";
  assert.equal(
    formatShortTbComment(report),
    "原因：缓存未清理导致旧状态残留\n措施：增加退出时清理缓存",
  );
  const candidate = __testBuildRejectTbSyncCandidate(
    { id: "story-m1", ticketUrl: fixture.resolved.ticketUrl },
    { shortReport: report, at: 1 },
  );
  assert.match(candidate.commentText, /^🤖 AI 自动工作流\n\n/);
});

test("M1 BUG BASELINE TB-M0-001/011：kickTriage 先尝试状态流转，再检查工程/取上下文/准备附件，且该函数没有工单级 principal 复核", () => {
  const section = sourceSection(routeSource, "async function kickTriage", "// 工作流：点「执行开发」触发");
  const flow = section.indexOf("await onStartDev");
  const projectCheck = section.indexOf("store.getPrimaryProject");
  const context = section.indexOf("await fetchAndSaveTbContext");
  const attachment = section.indexOf("await prepareTbAttachmentsForAgent");
  assert.ok(flow >= 0 && projectCheck > flow && context > projectCheck && attachment > context);
  assert.doesNotMatch(section, /principalRequiresTbTicketAccessCheck|getCurrentUserAccessibleTask/);
});

test("M1 鉴权基线：普通 TB 身份必须同时具备 operatorId 与 Cookie，且被标记为需工单级检查", () => {
  assert.equal(currentTbUserActor({ teambition: { operatorId: "user-only" } }), null);
  assert.equal(currentTbUserActor({ teambition: { userCookie: "fixture-cookie" } }), null);
  const actor = currentTbUserActor({
    teambition: { operatorId: "user-m1", userCookie: "fixture-cookie", userName: "脱敏用户" },
  });
  assert.equal(principalRequiresTbTicketAccessCheck(actor), true);
  assert.equal(currentDevbenchActor(null, {
    teambition: { operatorId: "user-m1", userCookie: "fixture-cookie" },
  })?.role, "tb-user");
});

test("M1 重复调用/部分成功基线：评论写入歧义后不重写、不流转状态，当前调用不做第二次回读", async () => {
  const calls = { findComments: 0, postComment: 0, currentStatus: 0, flowStatus: 0 };
  const api = {
    findComments: async () => { calls.findComments += 1; return []; },
    postComment: async () => { calls.postComment += 1; throw new Error("fixture timeout"); },
    findAttachments: async () => [],
    uploadAttachment: async () => { throw new Error("must not upload"); },
    currentStatus: async () => { calls.currentStatus += 1; return "待处理"; },
    flowStatus: async () => { calls.flowStatus += 1; return { ok: true }; },
  };
  const result = await runTbSyncSaga({
    storyId: "story-m1-partial",
    tbTaskId: fixture.resolved.tbTaskId,
    reportRevision: "m1-r1",
    shortReport: "原因：写入确认丢失；措施：先远端回读。",
    attachment: null,
    fromStatus: "待处理",
    allowedFromStatuses: ["待处理"],
    targetStatus: "可提测",
    api,
  });
  assert.equal(result.ok, false);
  assert.equal(result.steps.comment.status, "pending_ambiguous");
  assert.equal(result.steps.status.status, "blocked");
  assert.equal(calls.postComment, 1);
  assert.equal(calls.findComments, 1, "当前调用只有写前查重；后续 durable 恢复负责只读对账");
  assert.equal(calls.flowStatus, 0);
});
