import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-state-recovery-"));
process.env.GATEWAY_DB_PATH = path.join(tmp, "data.db");
process.env.GATEWAY_CONFIG_PATH = path.join(tmp, "gateway.json");
fs.writeFileSync(process.env.GATEWAY_CONFIG_PATH, JSON.stringify({
  servers: { nodeId: "runtime-state-recovery-test" },
}));

const runtimeDb = await import("../db/sqlite.js");
const {
  isTaskAgentRunningAnywhere,
  isTaskAgentRunningAnywhereAsync,
  reconcileInactiveTaskRuntimeState,
  reconcileInactiveTaskRuntimeStateAsync,
  reconcileStaleRuntimeStates,
} = await import("../services/agent-runner.js");
const {
  captureProcessIdentity,
  captureProcessIdentitySync,
  identityObservationKeepsLease,
  isSameLiveProcess,
  isSameLiveProcessAsync,
} = await import("../services/process-identity.js");

function createRunningTask(taskId, agentId) {
  runtimeDb.createTask({
    id: taskId,
    title: taskId,
    description: "runtime recovery regression",
    type: "general",
    status: "running",
    priority: 3,
    source: "devbench",
    sourceId: `session-${taskId}`,
  });
  runtimeDb.upsertAgent({
    id: agentId,
    name: agentId,
    engine: "codex",
    status: "running",
    currentTaskId: taskId,
  });
}

test("过期 runtime lease 校验进程启动身份并原子收敛陈旧持久化状态", async () => {
  const currentIdentity = captureProcessIdentitySync(process.pid);
  assert.ok(currentIdentity, "测试进程必须能取得不可变启动身份");
  assert.equal(await isSameLiveProcessAsync(process.pid, currentIdentity), true);
  assert.equal(await isSameLiveProcessAsync(process.pid, `${currentIdentity}-reused`), false);
  assert.equal(identityObservationKeepsLease(currentIdentity, ""), true, "身份查询临时失败时须保守保护已登记 worker");
  assert.equal(identityObservationKeepsLease("", currentIdentity), false, "无身份旧行不得在 TTL 后只凭 PID 续命");

  runtimeDb.upsertTaskRuntimeLease({
    leaseId: "identity-may-be-null",
    taskId: "identity-may-be-null",
    ownerInstance: "identity-test",
    ownerPid: process.pid,
    workerPid: 2_147_483_647,
    ttlMs: 5000,
  });
  assert.equal(runtimeDb.listTaskRuntimeLeases("identity-may-be-null").length, 1);

  const liveTaskId = "expired-but-same-worker";
  createRunningTask(liveTaskId, "agent-expired-but-same-worker");
  runtimeDb.upsertTaskRuntimeLease({
    leaseId: "same-worker-lease",
    taskId: liveTaskId,
    ownerInstance: "crashed-gateway",
    ownerPid: process.pid + 1000,
    workerPid: process.pid,
    workerIdentity: currentIdentity,
    now: Date.now() - 60_000,
    ttlMs: 5000,
  });
  assert.equal(await isTaskAgentRunningAnywhereAsync(liveTaskId), true);
  assert.equal((await reconcileInactiveTaskRuntimeStateAsync(liveTaskId)).active, true);
  assert.equal(runtimeDb.getTask(liveTaskId).status, "running");
  runtimeDb.removeTaskRuntimeLease("same-worker-lease", "crashed-gateway");

  const reusedTaskId = "expired-pid-reused";
  createRunningTask(reusedTaskId, "agent-expired-pid-reused");
  runtimeDb.upsertTaskRuntimeLease({
    leaseId: "pid-reused-lease",
    taskId: reusedTaskId,
    ownerInstance: "old-crashed-gateway",
    ownerPid: process.pid + 2000,
    workerPid: process.pid,
    workerIdentity: `${currentIdentity}-different-process`,
    now: Date.now() - 60_000,
    ttlMs: 5000,
  });
  assert.equal(await isTaskAgentRunningAnywhereAsync(reusedTaskId), false);
  const settled = await reconcileInactiveTaskRuntimeStateAsync(reusedTaskId);
  assert.equal(settled.active, false);
  assert.equal(settled.taskUpdated, 1);
  assert.equal(settled.agentsCleared, 1);
  assert.equal(runtimeDb.getTask(reusedTaskId).status, "failed");
  assert.equal(JSON.parse(runtimeDb.getTask(reusedTaskId).result).code, "STALE_RUNTIME_LEASE");
  const agent = runtimeDb.getAgents().find((item) => item.id === "agent-expired-pid-reused");
  assert.equal(agent.status, "idle");
  assert.equal(agent.current_task_id, null);
  assert.equal(runtimeDb.listTaskRuntimeLeases(reusedTaskId).length, 0);
});

test("超过 24 小时的已完成任务 runtime 行仍校验 worker 身份并安全回收", async () => {
  const currentIdentity = captureProcessIdentitySync(process.pid);
  const liveTaskId = "completed-live-api-worker";
  runtimeDb.createTask({
    id: liveTaskId,
    title: liveTaskId,
    description: "completed parent with live API worker",
    type: "general",
    status: "completed",
    priority: 3,
    source: "devbench",
    sourceId: `session-${liveTaskId}`,
  });
  runtimeDb.upsertTaskRuntimeLease({
    leaseId: "completed-live-worker-lease",
    taskId: liveTaskId,
    ownerInstance: "old-api-owner",
    ownerPid: process.pid + 3000,
    workerPid: process.pid,
    workerIdentity: currentIdentity,
    now: Date.now() - 48 * 60 * 60 * 1000,
    ttlMs: 5000,
  });
  assert.equal(runtimeDb.listTaskRuntimeLeases(liveTaskId).length, 1);
  assert.ok(runtimeDb.listRuntimeStateTaskIds().includes(liveTaskId));
  await import("../services/agent-runner.js").then((m) => m.reconcileStaleRuntimeStatesAsync());
  assert.equal(runtimeDb.listTaskRuntimeLeases(liveTaskId).length, 1, "存活 worker 的历史租约不能被时间窗口误删");
  runtimeDb.removeTaskRuntimeLease("completed-live-worker-lease", "old-api-owner");

  const deadTaskId = "completed-dead-api-worker";
  runtimeDb.createTask({
    id: deadTaskId,
    title: deadTaskId,
    description: "completed parent with dead API worker",
    type: "general",
    status: "completed",
    priority: 3,
    source: "devbench",
    sourceId: `session-${deadTaskId}`,
  });
  runtimeDb.upsertTaskRuntimeLease({
    leaseId: "completed-dead-worker-lease",
    taskId: deadTaskId,
    ownerInstance: "dead-api-owner",
    ownerPid: 2_147_483_646,
    workerPid: 2_147_483_647,
    workerIdentity: "win:dead-worker",
    now: Date.now() - 48 * 60 * 60 * 1000,
    ttlMs: 5000,
  });
  assert.equal(runtimeDb.listTaskRuntimeLeases(deadTaskId).length, 1);
  assert.ok(runtimeDb.listRuntimeStateTaskIds().includes(deadTaskId));
  const { reconcileStaleRuntimeStatesAsync } = await import("../services/agent-runner.js");
  const summary = await reconcileStaleRuntimeStatesAsync();
  assert.ok(summary.settled >= 1);
  assert.equal(runtimeDb.listTaskRuntimeLeases(deadTaskId).length, 0);
  assert.equal(runtimeDb.getTask(deadTaskId).status, "completed");
});

test("卡住任务强制清理：心跳续租的 worker_pid=null 租约可被 removeTaskRuntimeLeasesForTask 收敛", async () => {
  // 复现 API 引擎（minimax 等）任务挂起后的假象：worker_pid 为空，但心跳定时器持续续租，
  // 租约永不过期 → isTaskAgentRunningAnywhere 永远 true。stop 端点用 removeTaskRuntimeLeasesForTask 强制清理。
  const stalledTaskId = "stalled-api-task";
  runtimeDb.createTask({
    id: stalledTaskId,
    title: stalledTaskId,
    description: "stalled api task with leaked heartbeat",
    type: "general",
    status: "running",
    priority: 3,
    source: "devbench",
    sourceId: `session-${stalledTaskId}`,
  });
  runtimeDb.upsertTaskRuntimeLease({
    leaseId: "stalled-task-lifecycle",
    taskId: stalledTaskId,
    ownerInstance: "gateway-stalled",
    ownerPid: process.pid,
    workerPid: null,
    workerIdentity: "",
    ttlMs: 15_000,
  });
  runtimeDb.upsertTaskRuntimeLease({
    leaseId: "stalled-agent-minimax",
    taskId: stalledTaskId,
    ownerInstance: "gateway-stalled",
    ownerPid: process.pid,
    workerPid: null,
    workerIdentity: "",
    ttlMs: 15_000,
  });
  // 租约 active（未过期）→ isTaskAgentRunningAnywhere 短路返回 true（假象运行态）
  assert.equal(runtimeDb.hasActiveTaskRuntimeLease(stalledTaskId), true);
  assert.equal(await isTaskAgentRunningAnywhereAsync(stalledTaskId), true);

  // 强制按 task 清理所有租约（不论 owner / 过期与否）
  const result = runtimeDb.removeTaskRuntimeLeasesForTask(stalledTaskId);
  assert.equal(result.changes, 2);
  assert.equal(runtimeDb.listTaskRuntimeLeases(stalledTaskId).length, 0);
  assert.equal(runtimeDb.hasActiveTaskRuntimeLease(stalledTaskId), false);
  assert.equal(await isTaskAgentRunningAnywhereAsync(stalledTaskId), false);
});

test("releaseWorktreeResourceLeasesForTask 按 task_id 清理指定 kind 的 worktree 租约", () => {
  const taskA = "wt-task-a";
  const claimA = runtimeDb.claimWorktreeResourceLease({
    resourceKeys: ["tab:aaa"],
    leaseToken: "token-a",
    kind: "ai",
    tabId: "tab-a",
    taskId: taskA,
    ownerInstance: "wt-owner-a",
    ownerPid: process.pid,
    ttlMs: 15_000,
  });
  assert.equal(claimA.ok, true, `claim ai 应成功，实际 ${JSON.stringify(claimA)}`);
  const claimB = runtimeDb.claimWorktreeResourceLease({
    resourceKeys: ["tab:bbb"],
    leaseToken: "token-b",
    kind: "mutation",
    tabId: "tab-b",
    taskId: taskA,
    ownerInstance: "wt-owner-a",
    ownerPid: process.pid,
    ttlMs: 15_000,
  });
  assert.equal(claimB.ok, true, `claim mutation 应成功，实际 ${JSON.stringify(claimB)}`);
  // 只清 kind=ai，mutation 租约保留
  const cleared = runtimeDb.releaseWorktreeResourceLeasesForTask(taskA, "ai");
  assert.ok(cleared.changes >= 1, `应清理至少 1 条 ai 租约，实际 ${cleared.changes}`);
  const remaining = runtimeDb.listWorktreeResourceLeases(["tab:aaa", "tab:bbb"]);
  assert.equal(remaining.filter((l) => l.kind === "ai" && l.task_id === taskA).length, 0);
  assert.ok(remaining.some((l) => l.kind === "mutation"));
  // 清理 mutation 残留，避免影响后续测试
  runtimeDb.releaseWorktreeResourceLeasesForTask(taskA, "mutation");
});
