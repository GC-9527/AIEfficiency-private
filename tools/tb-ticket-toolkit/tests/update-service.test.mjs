import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { formatReasonMeasure } from "../packages/tb-domain/src/index.js";
import { createFileOperationStore, createToolkitApplication } from "../packages/tb-application/src/update-service.js";
import { createTempGitRepo, removeTree, richSnapshot } from "./helpers.mjs";

const TASK_ID = "0123456789abcdef01234567";
const cleanups = [];
afterEach(() => { for (const root of cleanups.splice(0)) removeTree(root); });

function fixture({ profile = "write", writeEnabled = true, allowlist = ["CARB-15125"], now } = {}) {
  const repoPath = createTempGitRepo("tb-toolkit-m3-");
  cleanups.push(repoPath);
  const snapshot = richSnapshot();
  snapshot.detail.taskflowstatus = { _id: "status-triage", name: "AI甄别", _taskflowId: "flow-1" };
  snapshot.detail.updated = "2026-08-23T00:00:00.000Z";
  const calls = [];
  const behavior = { comment: "success", status: "success" };
  const statuses = [
    { statusId: "status-triage", displayName: "AI甄别", taskflowId: "flow-1" },
    { statusId: "status-done", displayName: "已完成", taskflowId: "flow-1" },
  ];
  const provider = {
    behavior,
    snapshot,
    calls,
    async readTicket() { calls.push("read"); return structuredClone(snapshot); },
    async openAttachment() { throw new Error("no attachments"); },
    async getWorkflow() {
      calls.push("workflow");
      return {
        task: structuredClone(snapshot.resolved), projectId: "project-m2", taskflowId: "flow-1", workflowVersion: snapshot.detail.updated,
        currentStatus: { statusId: snapshot.detail.taskflowstatus._id, displayName: snapshot.detail.taskflowstatus.name },
        triageStatus: statuses[0], statuses: structuredClone(statuses), transitions: [], complete: true,
      };
    },
    async listComments() { calls.push("comments-readback"); return structuredClone(snapshot.comments.items); },
    async writeComment(_taskId, content) {
      calls.push("comment-write");
      if (behavior.comment !== "fail-before-write") snapshot.comments.items.push({ _id: `new-${snapshot.comments.items.length}`, content: { text: content } });
      if (behavior.comment !== "success") throw new Error("comment upstream failed Authorization: Bearer secret");
    },
    async updateStatus(_taskId, target) {
      calls.push("status-write");
      if (behavior.status !== "fail-before-write") snapshot.detail.taskflowstatus = { _id: target.statusId, name: target.displayName, _taskflowId: "flow-1" };
      if (behavior.status !== "success") throw new Error("status upstream failed ?signature=secret");
    },
  };
  const application = createToolkitApplication({ provider, repoPath, profile, writeEnabled, allowedTaskRefs: allowlist, ...(now ? { now } : {}) });
  return { repoPath, provider, application, statuses };
}

async function preparedPlan(ctx, overrides = {}) {
  const prepared = await ctx.application.prepare({ taskRef: "CARB-15125" });
  assert.equal(prepared.state, "READY");
  return ctx.application.updatePlan({
    phase: "RESOLUTION",
    taskRef: "CARB-15125",
    expectedCurrentStatus: { statusId: "status-triage" },
    targetStatus: { statusId: "status-done" },
    contextDigest: prepared.contextDigest,
    reason: "官方状态工具缺少本地幂等和未知结果恢复保护",
    measure: "接入统一写计划并通过隔离回读测试验证评论和状态顺序",
    evidenceRefs: [{ kind: "integration_test", result: "PASS", summary: "隔离测试通过" }],
    source: { commit: "fixture-commit", actor: "test" },
    ...overrides,
  });
}

test("评论样式固定原因/措施并拒绝空泛、完成态误报和敏感路径", () => {
  const valid = formatReasonMeasure({
    phase: "TRIAGE",
    reason: "官方写工具本身没有本地恢复记录",
    measure: "增加计划指纹、幂等键和回读验证测试",
  });
  assert.equal(valid.comment, "原因：官方写工具本身没有本地恢复记录；措施：增加计划指纹、幂等键和回读验证测试。");
  assert.throws(() => formatReasonMeasure({ phase: "TRIAGE", reason: "待分析", measure: "处理" }), { code: "COMMENT_STYLE_REJECTED" });
  assert.throws(() => formatReasonMeasure({ phase: "TRIAGE", reason: "问题已解决", measure: "修改实现并测试已通过" }), { code: "COMMENT_STYLE_REJECTED" });
  assert.throws(() => formatReasonMeasure({ phase: "RESOLUTION", reason: "路径错误", measure: "修改 D:\\secret\\token.txt 并验证" }), { code: "COMMENT_STYLE_REJECTED" });
});

test("计划绑定准备上下文、精确工作流状态、证据、过期时间和指纹", async () => {
  const ctx = fixture();
  const plan = await preparedPlan(ctx);
  assert.equal(plan.proposedChanges.targetStatus.statusId, "status-done");
  assert.equal(plan.applyAllowed, true);
  assert.match(plan.fingerprint, /^[a-f0-9]{64}$/);
  assert.match(plan.idempotencyKey, /^tbfix:resolution:/);

  ctx.statuses.push({ statusId: "status-done-duplicate", displayName: "重复", taskflowId: "flow-1" });
  await assert.rejects(() => preparedPlan(ctx, { targetStatus: { displayName: "不存在" } }), { code: "INVALID_TRANSITION" });
});

test("read profile、全局写开关和任务白名单分别失败关闭", async () => {
  for (const options of [
    { profile: "read", writeEnabled: true, allowlist: ["CARB-15125"], code: "WRITE_DISABLED" },
    { profile: "write", writeEnabled: false, allowlist: ["CARB-15125"], code: "WRITE_DISABLED" },
    { profile: "write", writeEnabled: true, allowlist: [], code: "FORBIDDEN" },
  ]) {
    const ctx = fixture(options);
    const plan = await preparedPlan(ctx);
    await assert.rejects(
      () => ctx.application.updateApply({ planId: plan.planId, fingerprint: plan.fingerprint, idempotencyKey: plan.idempotencyKey, apply: true }),
      { code: options.code },
    );
  }
});

test("远端写入严格评论后状态并逐步回读，重复幂等调用不双写", async () => {
  const ctx = fixture();
  const plan = await preparedPlan(ctx);
  ctx.provider.calls.length = 0;
  const input = { planId: plan.planId, fingerprint: plan.fingerprint, idempotencyKey: plan.idempotencyKey, apply: true };
  const first = await ctx.application.updateApply(input);
  const writesAfterFirst = ctx.provider.calls.filter((item) => item.endsWith("-write"));
  const second = await ctx.application.updateApply(input);
  assert.equal(first.state, "COMPLETED");
  assert.equal(second.operationId, first.operationId);
  assert.deepEqual(writesAfterFirst, ["comment-write", "status-write"]);
  assert.deepEqual(ctx.provider.calls.filter((item) => item.endsWith("-write")), writesAfterFirst);
  assert.equal(first.steps.comment.readbackVerified, true);
  assert.equal(first.steps.status.readbackVerified, true);
});

test("评论成功但状态未知时持久化 PARTIAL，恢复同一 operation 只补状态", async () => {
  const ctx = fixture();
  const plan = await preparedPlan(ctx);
  ctx.provider.behavior.status = "fail-before-write";
  ctx.provider.calls.length = 0;
  const input = { planId: plan.planId, fingerprint: plan.fingerprint, idempotencyKey: plan.idempotencyKey, apply: true };
  const partial = await ctx.application.updateApply(input);
  assert.equal(partial.state, "PARTIAL");
  assert.equal(partial.steps.comment.state, "DONE");
  assert.equal(partial.steps.status.state, "UNKNOWN");
  assert.doesNotMatch(JSON.stringify(partial), /Bearer secret|signature=secret/i);

  ctx.provider.behavior.status = "success";
  const recovered = await ctx.application.updateApply(input);
  assert.equal(recovered.operationId, partial.operationId);
  assert.equal(recovered.state, "COMPLETED");
  assert.equal(ctx.provider.calls.filter((item) => item === "comment-write").length, 1);
  assert.equal(ctx.provider.calls.filter((item) => item === "status-write").length, 2);

  const restarted = createToolkitApplication({ provider: ctx.provider, repoPath: ctx.repoPath, profile: "write", writeEnabled: true, allowedTaskRefs: ["CARB-15125"] });
  assert.equal(restarted.operationGet(partial.operationId).state, "COMPLETED");
});

test("请求报错但评论回读存在时视为已完成，不重复评论", async () => {
  const ctx = fixture();
  const plan = await preparedPlan(ctx);
  ctx.provider.behavior.comment = "throw-after-write";
  const result = await ctx.application.updateApply({ planId: plan.planId, fingerprint: plan.fingerprint, idempotencyKey: plan.idempotencyKey, apply: true });
  assert.equal(result.state, "COMPLETED");
  assert.equal(result.steps.comment.state, "DONE");
  assert.equal(ctx.provider.calls.filter((item) => item === "comment-write").length, 1);
});

test("计划过期、指纹不符和上下文漂移分别关闭", async () => {
  let clock = Date.parse("2026-08-23T00:00:00.000Z");
  const expiredCtx = fixture({ now: () => clock });
  const expiredPlan = await preparedPlan(expiredCtx);
  clock += 16 * 60_000;
  await assert.rejects(
    () => expiredCtx.application.updateApply({ planId: expiredPlan.planId, fingerprint: expiredPlan.fingerprint, idempotencyKey: expiredPlan.idempotencyKey, apply: true }),
    { code: "PLAN_EXPIRED" },
  );

  const tamperCtx = fixture();
  const tamperPlan = await preparedPlan(tamperCtx);
  await assert.rejects(
    () => tamperCtx.application.updateApply({ planId: tamperPlan.planId, fingerprint: "0".repeat(64), idempotencyKey: tamperPlan.idempotencyKey, apply: true }),
    { code: "PLAN_TAMPERED" },
  );

  const driftCtx = fixture();
  const driftPlan = await preparedPlan(driftCtx);
  driftCtx.provider.snapshot.detail.content = "远端标题变化";
  driftCtx.provider.snapshot.resolved.title = "远端标题变化";
  const conflict = await driftCtx.application.updateApply({ planId: driftPlan.planId, fingerprint: driftPlan.fingerprint, idempotencyKey: driftPlan.idempotencyKey, apply: true });
  assert.equal(conflict.state, "CONFLICT");
  assert.equal(conflict.safeToResume, false);
});

test("同一任务只允许一个未过期写租约", () => {
  const ctx = fixture();
  const store = createFileOperationStore({ repoPath: ctx.repoPath });
  const first = store.acquire(TASK_ID, "correlation-1");
  assert.throws(() => store.acquire(TASK_ID, "correlation-2"), { code: "LOCKED" });
  store.release(first);
  const second = store.acquire(TASK_ID, "correlation-2");
  store.release(second);
});

test("写租约有界过期且旧 fencing token 不能释放新 owner", () => {
  const ctx = fixture();
  let clock = 1000;
  const store = createFileOperationStore({ repoPath: ctx.repoPath, now: () => clock, lockLeaseMs: 100 });
  const stale = store.acquire(TASK_ID, "correlation-old");
  clock = 1101;
  const current = store.acquire(TASK_ID, "correlation-new");
  store.release(stale);
  assert.throws(() => store.acquire(TASK_ID, "correlation-third"), { code: "LOCKED" });
  store.release(current);
});
