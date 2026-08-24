import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const unitTmp = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-v2-tb-workflow-sync-"));
process.env.GATEWAY_DB_PATH = path.join(unitTmp, "data.db");
process.env.GATEWAY_CONFIG_PATH = path.join(unitTmp, "gateway.json");
process.env.DEVBENCH_CONFIG_PATH = path.join(unitTmp, "market.json");
process.env.DEVBENCH_LOCAL_PROJECTS_PATH = path.join(unitTmp, "local-projects.json");
process.env.DEVBENCH_STORE_DIR = path.join(unitTmp, "store");
process.env.AIEFFICIENCY_CLONE_PARENT = path.join(unitTmp, "clone-parent");
fs.writeFileSync(process.env.GATEWAY_CONFIG_PATH, JSON.stringify({ servers: { nodeId: "tb-sync-unit" } }));

const {
  __testBuildReportTbSyncCandidate,
  __testSealTbSyncPending,
  __testSyncGroupReportDoneToTb,
  confirmReject,
  reportSubmissionReadiness,
  runPersistedTbSync,
} = await import("../services/devbench/tb-workflow.js");
const {
  tbSyncAttachmentKey,
  tbSyncCommentKey,
  tbSyncStatusKey,
} = await import("../services/devbench/workflow-v2/tb-sync-saga.js");

const TB_URL = "https://www.teambition.com/task/0123456789abcdef01234567";

function makeTab(id, workflow = {}, extra = {}) {
  return {
    id,
    title: id,
    ticketUrl: TB_URL,
    workflow: { enabled: true, phase: "reporting", ...workflow },
    ...extra,
  };
}

function fakeStore(tabs, storyRoots = new Map()) {
  const rows = new Map(tabs.map((tab) => [tab.id, structuredClone(tab)]));
  return {
    getTab(id) {
      const row = rows.get(id);
      return row ? structuredClone(row) : null;
    },
    updateTab(id, patch) {
      const current = rows.get(id);
      if (!current) throw new Error(`missing tab ${id}`);
      const next = { ...current, ...structuredClone(patch) };
      rows.set(id, next);
      return structuredClone(next);
    },
    getGroupMembers(groupId) {
      return [...rows.values()].filter((tab) => tab.groupId === groupId).map((tab) => structuredClone(tab));
    },
    getStoryStoragePaths(tab) {
      const storyDirectory = storyRoots.get(tab.id);
      if (!storyDirectory) throw new Error(`missing story storage ${tab.id}`);
      return { storyDirectory };
    },
    validateStoryStorageTarget(tab, candidate, { baseDirectory, mustExist = false, expectedType } = {}) {
      const root = path.resolve(baseDirectory || storyRoots.get(tab.id));
      const target = path.resolve(candidate);
      const relative = path.relative(root, target);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        if (target !== root) throw new Error("outside story storage");
      }
      if (mustExist && !fs.existsSync(target)) throw new Error("missing story artifact");
      if (expectedType === "file" && !fs.statSync(target).isFile()) throw new Error("not a file");
      return target;
    },
  };
}

const VOLATILE_TEST_STORE_OPT_IN = Object.freeze({ allowVolatileTestStore: true });

function reportCandidate(overrides = {}) {
  return {
    kind: "report",
    reportRevision: "report-revision-1",
    commentText: "原因：缓存键未包含车型。措施：补充车型维度并增加回归测试。",
    attachment: null,
    allowedFromStatuses: ["待处理", "待确认", "修复中"],
    targetStatus: "可提测",
    terminalPhase: "testable",
    reportMode: "short",
    terminalUpdates: { reportedAt: 1000, reportHtmlRel: null, reportPdfRel: null },
    createdAt: 1000,
    ...overrides,
  };
}

function successSaga(input) {
  const commentKey = tbSyncCommentKey({
    storyId: input.storyId,
    reportRevision: input.reportRevision,
    content: input.shortReport,
  });
  const statusKey = tbSyncStatusKey({
    storyId: input.storyId,
    allowedFromStatuses: input.allowedFromStatuses,
    targetStatus: input.targetStatus,
    reportRevision: input.reportRevision,
  });
  const attachmentKey = input.attachment
    ? tbSyncAttachmentKey({
      storyId: input.storyId,
      reportRevision: input.reportRevision,
      fileSha256: input.attachment.sha256,
      fileName: input.attachment.fileName,
    })
    : null;
  return {
    ok: true,
    pending: [],
    errors: [],
    steps: {
      comment: { status: "done", key: commentKey },
      attachment: input.attachment
        ? { status: "done", key: attachmentKey }
        : { status: "skipped", reason: "无附件" },
      status: { status: "done", key: statusKey, to: input.targetStatus },
    },
    ledger: {
      schemaVersion: "tb-sync-saga-v1",
      reportRevision: input.reportRevision,
      comment: { key: commentKey, at: 1 },
      attachment: attachmentKey ? { key: attachmentKey, at: 1 } : null,
      status: { key: statusKey, at: 1 },
    },
  };
}

function failedSaga(input, step = "comment") {
  return {
    ok: false,
    pending: [step],
    errors: [`${step} pending`],
    steps: {
      comment: step === "comment" ? { status: "pending_ambiguous" } : { status: "done" },
      attachment: { status: "skipped" },
      status: { status: "blocked" },
    },
    ledger: { schemaVersion: "tb-sync-saga-v1", reportRevision: input.reportRevision },
  };
}

test("TB payload 先持久化再执行 Saga，完整成功后才进入 testable", async () => {
  const tab = makeTab("story-persist-first");
  const storeApi = fakeStore([tab]);
  let observedPending = null;
  const result = await runPersistedTbSync(tab, reportCandidate(), {
    ...VOLATILE_TEST_STORE_OPT_IN,
    expectedKind: "report",
    storeApi,
    sagaRunner: async (input) => {
      observedPending = storeApi.getTab(tab.id).workflow;
      return successSaga(input);
    },
  });

  assert.equal(observedPending.phase, "sync_pending");
  assert.equal(observedPending.tbSyncPending.reportRevision, "report-revision-1");
  assert.equal(result.ok, true);
  assert.equal(storeApi.getTab(tab.id).workflow.phase, "testable");
  assert.equal(Object.hasOwn(storeApi.getTab(tab.id).workflow, "tbSyncPending"), false);
});

test("store 缺少 durable capability 时默认 fail-closed 且零 Saga/零 TB 调用", async () => {
  const tab = makeTab("story-durable-store-required");
  const storeApi = fakeStore([tab]);
  let sagaCalls = 0;
  let remoteCalls = 0;
  const result = await runPersistedTbSync(tab, reportCandidate(), {
    expectedKind: "report",
    storeApi,
    sagaRunner: async () => {
      sagaCalls++;
      throw new Error("volatile Saga must not run without explicit test opt-in");
    },
    api: new Proxy({}, {
      get() {
        return async () => { remoteCalls++; return { ok: true }; };
      },
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.phase, "sync_pending");
  assert.equal(result.statusCode, 503);
  assert.equal(result.code, "TB_SYNC_DURABLE_STORE_REQUIRED");
  assert.equal(result.blocked, true);
  assert.equal(result.durableBlocked, true);
  assert.deepEqual(result.missingCapabilities, [
    "reserveTabTbSyncOperation",
    "beginTabTbSyncStepWrite",
    "recordTabTbSyncStep",
    "settleTabTbSyncOperation",
  ]);
  assert.equal(sagaCalls, 0);
  assert.equal(remoteCalls, 0);
  assert.equal(storeApi.getTab(tab.id).workflow.phase, "reporting");
});

test("失败重试严格复用首次冻结的 comment/hash/revision，忽略新 candidate", async () => {
  const tab = makeTab("story-retry-frozen");
  const storeApi = fakeStore([tab]);
  const seen = [];
  const first = await runPersistedTbSync(tab, reportCandidate(), {
    ...VOLATILE_TEST_STORE_OPT_IN,
    expectedKind: "report",
    storeApi,
    sagaRunner: async (input) => {
      seen.push(input);
      return failedSaga(input);
    },
  });
  assert.equal(first.ok, false);

  const second = await runPersistedTbSync(storeApi.getTab(tab.id), reportCandidate({
    reportRevision: "changed-revision",
    commentText: "篡改后的新评论",
  }), {
    ...VOLATILE_TEST_STORE_OPT_IN,
    expectedKind: "report",
    storeApi,
    sagaRunner: async (input) => {
      seen.push(input);
      return successSaga(input);
    },
  });

  assert.equal(second.ok, true);
  assert.equal(seen[1].reportRevision, "report-revision-1");
  assert.equal(seen[1].shortReport, reportCandidate().commentText);
});

test("同故事并发重试被串行化，已完成同 revision 不再次执行 Saga", async () => {
  const tab = makeTab("story-concurrent");
  const storeApi = fakeStore([tab]);
  let calls = 0;
  let enteredResolve;
  let releaseResolve;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  const release = new Promise((resolve) => { releaseResolve = resolve; });
  const runner = async (input) => {
    calls++;
    enteredResolve();
    await release;
    return successSaga(input);
  };

  const first = runPersistedTbSync(tab, reportCandidate(), { ...VOLATILE_TEST_STORE_OPT_IN, expectedKind: "report", storeApi, sagaRunner: runner });
  await entered;
  const second = runPersistedTbSync(tab, reportCandidate(), { ...VOLATILE_TEST_STORE_OPT_IN, expectedKind: "report", storeApi, sagaRunner: runner });
  releaseResolve();
  const [a, b] = await Promise.all([first, second]);

  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(b.replayed, true);
  assert.equal(calls, 1);
});

test("冻结附件字节漂移时零 Saga、零 TB 写并保持 sync_pending", async () => {
  const tab = makeTab("story-attachment-drift");
  const storyDirectory = path.join(unitTmp, tab.id);
  fs.mkdirSync(storyDirectory, { recursive: true });
  const artifactPath = path.join(storyDirectory, "report.pdf");
  fs.writeFileSync(artifactPath, "original");
  const storeApi = fakeStore([tab], new Map([[tab.id, storyDirectory]]));
  const candidate = __testBuildReportTbSyncCandidate(tab, {
    commentText: reportCandidate().commentText,
    artifact: { absPath: artifactPath, fileName: "report.pdf", rel: "storydev:/reports/report.pdf" },
    reportMode: "expert",
    pdfRel: "storydev:/reports/report.pdf",
    storeApi,
  });
  fs.writeFileSync(artifactPath, "changed");
  let calls = 0;
  const result = await runPersistedTbSync(tab, candidate, {
    ...VOLATILE_TEST_STORE_OPT_IN,
    expectedKind: "report",
    storeApi,
    sagaRunner: async () => { calls++; throw new Error("must not run"); },
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /SHA-256/);
  assert.equal(calls, 0);
  assert.equal(storeApi.getTab(tab.id).workflow.phase, "sync_pending");
});

test("持久 payload 被篡改时 fail closed 且不执行 Saga", async () => {
  const tab = makeTab("story-corrupt-pending");
  const sealed = __testSealTbSyncPending({ ...reportCandidate(), storyId: tab.id, tbTaskId: "0123456789abcdef01234567" });
  tab.workflow = { ...tab.workflow, phase: "sync_pending", tbSyncPending: { ...sealed, commentText: "tampered" } };
  const storeApi = fakeStore([tab]);
  let calls = 0;
  const result = await runPersistedTbSync(tab, null, {
    ...VOLATILE_TEST_STORE_OPT_IN,
    expectedKind: "report",
    storeApi,
    sagaRunner: async () => { calls++; throw new Error("must not run"); },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /哈希不一致/);
  assert.equal(calls, 0);
});

test("拒绝同步失败不沉淀经验也不进入 rejected，重试成功后才结算", async () => {
  const tab = makeTab("story-reject", {
    phase: "reject_pending",
    pendingReject: {
      shortReport: "该问题由服务端配置缺失导致，不属于客户端缺陷。",
      reason: "服务端配置缺失",
      detailAbsPath: null,
      detailRel: null,
      lesson: { cause: "服务端配置缺失", prevention: "先核对配置" },
      at: 321,
    },
  });
  const storeApi = fakeStore([tab]);
  let lessons = 0;
  let usage = 0;
  const common = {
    ...VOLATILE_TEST_STORE_OPT_IN,
    storeApi,
    api: {},
    persistLessonFn: () => { lessons++; return { id: "lesson" }; },
    recordConfigUsageFn: () => { usage++; },
    pushWorkflowMsgFn: () => {},
  };
  const failed = await confirmReject(tab.id, {
    ...common,
    sagaRunner: async (input) => failedSaga(input, "comment"),
  });
  assert.equal(failed.ok, false);
  assert.equal(storeApi.getTab(tab.id).workflow.phase, "sync_pending");
  assert.ok(storeApi.getTab(tab.id).workflow.pendingReject);
  assert.equal(lessons, 0);
  assert.equal(usage, 0);

  const completed = await confirmReject(tab.id, {
    ...common,
    sagaRunner: async (input) => successSaga(input),
  });
  assert.equal(completed.ok, true);
  assert.equal(completed.resumed, true);
  assert.equal(storeApi.getTab(tab.id).workflow.phase, "rejected");
  assert.equal(storeApi.getTab(tab.id).workflow.pendingReject, null);
  assert.equal(lessons, 1);
  assert.equal(usage, 1);
});

test("故事点组只有 Saga 完整成功的成员进入 testable", async () => {
  const groupId = "group-1";
  const leader = makeTab("group-leader", {
    phase: "reporting",
    verifyPassedAt: 100,
    groupAcceptanceContext: { items: [{ tabId: "group-leader" }, { tabId: "group-member" }] },
    fixShortReport: "原因：状态缓存未隔离。措施：按车型隔离并补回归测试。",
  }, { groupId, reportMode: "short" });
  const member = makeTab("group-member", {
    phase: "reporting",
    fixedAt: 99,
    fixShortReport: "原因：配置映射缺少车型。措施：补齐映射并增加校验。",
  }, { groupId, reportMode: "short" });
  const storeApi = fakeStore([leader, member]);
  const result = await __testSyncGroupReportDoneToTb(
    leader,
    { shortReport: leader.workflow.fixShortReport },
    null,
    null,
    null,
    {
      ...VOLATILE_TEST_STORE_OPT_IN,
      storeApi,
      sagaRunner: async (input) => input.storyId === leader.id ? successSaga(input) : failedSaga(input),
      apiFactory: () => ({}),
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.failed, 1);
  assert.equal(storeApi.getTab(leader.id).workflow.phase, "testable");
  assert.equal(storeApi.getTab(member.id).workflow.phase, "sync_pending");
  assert.ok(storeApi.getTab(member.id).workflow.tbSyncPending);
});

test("report_done 业务门禁接受真实 VERIFY PASS 或显式跳过并保留修复完成事实", () => {
  assert.deepEqual(
    reportSubmissionReadiness(makeTab("report-ready", { verifyPassedAt: 100 })),
    { ok: true, code: "WORKFLOW_REPORT_READY", error: null },
  );
  assert.equal(
    reportSubmissionReadiness(makeTab("report-no-verify")).code,
    "WORKFLOW_REPORT_VERIFY_REQUIRED",
  );
  assert.deepEqual(
    reportSubmissionReadiness(makeTab("report-skipped", { fixedAt: 99 }, { skipTestAcceptance: true })),
    { ok: true, code: "WORKFLOW_REPORT_READY_WITH_TEST_ACCEPTANCE_SKIPPED", error: null, skipped: true },
  );
  assert.equal(
    reportSubmissionReadiness(makeTab("report-skipped-no-fix", {}, { skipTestAcceptance: true })).code,
    "WORKFLOW_REPORT_FIX_REQUIRED",
  );
  assert.equal(
    reportSubmissionReadiness(makeTab("report-wrong-phase", { phase: "fixing", verifyPassedAt: 100 })).code,
    "WORKFLOW_REPORT_PHASE_INVALID",
  );
});

after(() => {
  try { fs.rmSync(unitTmp, { recursive: true, force: true }); } catch {}
});
