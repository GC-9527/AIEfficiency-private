import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-v2-tb-durable-"));
const cloneParent = path.join(root, "clone-parent");
process.env.NODE_ENV = "test";
process.env.GATEWAY_DB_PATH = path.join(root, "gateway.db");
process.env.GATEWAY_CONFIG_PATH = path.join(root, "gateway.json");
process.env.DEVBENCH_CONFIG_PATH = path.join(root, "market.json");
process.env.DEVBENCH_LOCAL_PROJECTS_PATH = path.join(root, "local-projects.json");
process.env.DEVBENCH_STORE_DIR = path.join(root, "store");
process.env.AIEFFICIENCY_CLONE_PARENT = cloneParent;
process.env.DEVBENCH_SYNC_SCOPE = `tb-durable-${Date.now()}`;
process.env.ROLE = "standalone";

fs.mkdirSync(cloneParent, { recursive: true });
fs.writeFileSync(process.env.GATEWAY_CONFIG_PATH, JSON.stringify({
  role: "standalone",
  servers: { nodeId: "tb-durable-test", discovery: false, peers: [] },
}), "utf8");
fs.writeFileSync(process.env.DEVBENCH_CONFIG_PATH, "{}", "utf8");
fs.writeFileSync(process.env.DEVBENCH_LOCAL_PROJECTS_PATH, JSON.stringify({
  version: 2,
  cloneParent,
  projects: [],
}), "utf8");

const nonce = `${Date.now()}-${Math.random()}`;
const storeA = await import(`../services/devbench/store.js?tb-durable-store-a=${nonce}`);
const storeB = await import(`../services/devbench/store.js?tb-durable-store-b=${nonce}`);
const workflowA = await import(`../services/devbench/tb-workflow.js?tb-durable-gateway-a=${nonce}`);
const workflowB = await import(`../services/devbench/tb-workflow.js?tb-durable-gateway-b=${nonce}`);
const {
  tbSyncAttachmentKey,
  tbSyncCommentKey,
  tbSyncStatusKey,
} = await import("../services/devbench/workflow-v2/tb-sync-saga.js");

const TB_TASK_ID = "0123456789abcdef01234567";
const TB_URL = `https://www.teambition.com/task/${TB_TASK_ID}`;

after(() => {
  // better-sqlite3 keeps the process-local handle open until process exit on
  // Windows, so cleanup is best-effort here.
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function createStory(title, { withAttachment = false } = {}) {
  const created = storeA.createTab({ title });
  storeA.updateTab(created.id, {
    ticketUrl: TB_URL,
    workflow: { enabled: true, phase: "reporting" },
  });
  const tab = storeA.getTab(created.id);
  let attachment = null;
  if (withAttachment) {
    const storage = storeA.getStoryStoragePaths(tab, { create: true });
    const bytes = Buffer.from(`durable attachment for ${created.id}`, "utf8");
    const absPath = path.join(storage.reportsDirectory, "acceptance.pdf");
    fs.writeFileSync(absPath, bytes);
    attachment = {
      sourceStoryId: created.id,
      absPath,
      fileName: "acceptance.pdf",
      sha256: sha256(bytes),
    };
  }
  return { tab: storeA.getTab(created.id), attachment };
}

function candidate(attachment = null, overrides = {}) {
  return {
    kind: "report",
    reportRevision: "durable-report-revision-1",
    commentText: "原因：并发 Gateway 缺少持久 owner。措施：增加 SQLite fencing outbox。",
    attachment,
    allowedFromStatuses: ["修复中"],
    targetStatus: "可提测",
    terminalPhase: "testable",
    reportMode: attachment ? "expert" : "short",
    terminalUpdates: {
      reportedAt: 1_000,
      reportHtmlRel: attachment ? "storydev:/reports/acceptance.html" : null,
      reportPdfRel: attachment ? "storydev:/reports/acceptance.pdf" : null,
    },
    createdAt: 1_000,
    ...overrides,
  };
}

function remoteApi(remote, counters, {
  blockFirstCommentRead = null,
  crashAfterCommentWrite = false,
  omitCommentSideEffect = false,
  crashAfterAttachmentWrite = false,
  crashAfterStatusWrite = false,
} = {}) {
  let firstCommentRead = true;
  return {
    async findComments(meta) {
      counters.reads++;
      assert.equal(meta.readOnly, true);
      if (firstCommentRead && blockFirstCommentRead) {
        firstCommentRead = false;
        blockFirstCommentRead.enter();
        await blockFirstCommentRead.release;
      }
      return structuredClone(remote.comments);
    },
    async postComment(text, meta) {
      counters.commentWrites++;
      counters.writeMeta.push(meta);
      if (!omitCommentSideEffect) remote.comments.push({ id: `comment-${counters.commentWrites}`, content: text });
      if (crashAfterCommentWrite) throw new Error("connection lost after remote comment write");
      return { ok: true };
    },
    async findAttachments(meta) {
      counters.reads++;
      assert.equal(meta.readOnly, true);
      return structuredClone(remote.attachments);
    },
    async uploadAttachment(_absPath, meta) {
      counters.attachmentWrites++;
      counters.writeMeta.push(meta);
      remote.attachments.push({
        id: `attachment-${counters.attachmentWrites}`,
        fileName: remote.expectedAttachment.fileName,
        sha256: remote.expectedAttachment.sha256,
      });
      if (crashAfterAttachmentWrite) throw new Error("connection lost after remote attachment write");
      return { ok: true };
    },
    async currentStatus(meta) {
      counters.reads++;
      assert.equal(meta.readOnly, true);
      return remote.status;
    },
    async flowStatus(target, meta) {
      counters.statusWrites++;
      counters.writeMeta.push(meta);
      remote.status = target;
      if (crashAfterStatusWrite) throw new Error("connection lost after remote status write");
      return { ok: true };
    },
  };
}

function emptyCounters() {
  return { reads: 0, commentWrites: 0, attachmentWrites: 0, statusWrites: 0, writeMeta: [] };
}

function durableStepKeys(pending) {
  return {
    comment: tbSyncCommentKey({
      storyId: pending.storyId,
      reportRevision: pending.reportRevision,
      content: pending.commentText,
    }),
    attachment: pending.attachment ? tbSyncAttachmentKey({
      storyId: pending.storyId,
      reportRevision: pending.reportRevision,
      fileSha256: pending.attachment.sha256,
      fileName: pending.attachment.fileName,
    }) : "",
    status: tbSyncStatusKey({
      storyId: pending.storyId,
      allowedFromStatuses: pending.allowedFromStatuses,
      targetStatus: pending.targetStatus,
      reportRevision: pending.reportRevision,
    }),
  };
}

test("两个 Gateway 对同 payload 只有一个 durable owner，评论/附件/状态各写一次并原子结算", { timeout: 30_000 }, async () => {
  const { tab, attachment } = createStory(`TB durable concurrency ${Date.now()}`, { withAttachment: true });
  const frozen = candidate(attachment);
  const remote = { comments: [], attachments: [], status: "修复中", expectedAttachment: attachment };
  const ownerCounters = emptyCounters();
  const losingCounters = emptyCounters();
  let enteredResolve;
  let releaseResolve;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  const release = new Promise((resolve) => { releaseResolve = resolve; });
  const ownerApi = remoteApi(remote, ownerCounters, {
    blockFirstCommentRead: { enter: enteredResolve, release },
  });
  const losingApi = remoteApi(remote, losingCounters);

  const firstPromise = workflowA.runPersistedTbSync(tab, frozen, {
    expectedKind: "report",
    storeApi: storeA,
    api: ownerApi,
  });
  await entered;

  const conflict = await workflowB.runPersistedTbSync(storeB.getTab(tab.id), candidate(attachment, {
    commentText: "different canonical payload",
  }), {
    expectedKind: "report",
    storeApi: storeB,
    api: losingApi,
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, "TB_SYNC_OPERATION_PAYLOAD_CONFLICT");
  assert.equal(conflict.conflict, true);
  assert.deepEqual(losingCounters, emptyCounters(), "conflicting payload must make zero remote calls");

  const second = await workflowB.runPersistedTbSync(storeB.getTab(tab.id), candidate(attachment, {
    createdAt: 2_000,
  }), {
    expectedKind: "report",
    storeApi: storeB,
    api: losingApi,
  });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.operation.fencingToken > 1, true);

  releaseResolve();
  const first = await firstPromise;
  assert.equal(first.ok, false, "stale owner must lose its CAS before every write");
  assert.equal(ownerCounters.commentWrites, 0);
  assert.equal(ownerCounters.attachmentWrites, 0);
  assert.equal(ownerCounters.statusWrites, 0);
  assert.equal(losingCounters.commentWrites, 1);
  assert.equal(losingCounters.attachmentWrites, 1);
  assert.equal(losingCounters.statusWrites, 1);
  assert.deepEqual(losingCounters.writeMeta.map((meta) => meta.step), ["comment", "attachment", "status"]);
  for (const meta of losingCounters.writeMeta) {
    assert.match(meta.operationId, /^tb-sync:/);
    assert.match(meta.idempotencyKey, /^tb-sync-step:/);
    assert.equal(Number.isSafeInteger(meta.fencingToken), true);
    assert.equal(meta.readOnly, false);
  }

  const persisted = storeB.getTab(tab.id).workflow;
  assert.equal(persisted.phase, "testable");
  assert.equal(Object.hasOwn(persisted, "tbSyncPending"), false);
  assert.equal(persisted.tbSyncOperation.status, "completed");
  assert.equal(persisted.tbSyncOperation.outbox.comment.state, "completed");
  assert.equal(persisted.tbSyncOperation.outbox.attachment.state, "completed");
  assert.equal(persisted.tbSyncOperation.outbox.status.state, "completed");
  assert.deepEqual(persisted.tbSyncLedger, persisted.tbSyncOperation.ledger);

  const replayCounters = emptyCounters();
  const replay = await workflowB.runPersistedTbSync(storeB.getTab(tab.id), frozen, {
    expectedKind: "report",
    storeApi: storeB,
    api: remoteApi(remote, replayCounters),
  });
  assert.equal(replay.ok, true);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replayCounters, emptyCounters());
});

test("A 在 begin 前崩溃时 B 可 planned-only CAS 接管，A 的旧 fencing 永久禁止 late write", async () => {
  const { tab, attachment } = createStory(`TB durable planned takeover ${Date.now()}`, { withAttachment: true });
  const frozen = candidate(attachment, { reportRevision: "planned-takeover-revision" });
  const pending = workflowA.__testSealTbSyncPending({
    ...frozen,
    storyId: tab.id,
    tbTaskId: TB_TASK_ID,
  });
  const stepKeys = durableStepKeys(pending);
  const ownerA = "planned-owner-a";
  const ownerB = "planned-owner-b";
  const reservedA = storeA.reserveTabTbSyncOperation({
    tabId: tab.id,
    tbTaskId: TB_TASK_ID,
    pending,
    stepKeys,
    ownerToken: ownerA,
  });
  assert.equal(reservedA.ok, true);
  assert.deepEqual(
    Object.values(reservedA.operation.outbox).map((entry) => entry.state),
    ["planned", "planned", "planned"],
  );

  const reservedB = storeB.reserveTabTbSyncOperation({
    tabId: tab.id,
    tbTaskId: TB_TASK_ID,
    pending,
    stepKeys,
    ownerToken: ownerB,
  });
  assert.equal(reservedB.ok, true);
  assert.equal(reservedB.plannedTakeover, true);
  assert.equal(reservedB.operation.status, "owned");
  assert.equal(reservedB.operation.fencingToken, reservedA.operation.fencingToken + 1);

  const remote = { comments: [], attachments: [], status: "修复中", expectedAttachment: attachment };
  const counters = emptyCounters();
  const staleBegin = storeA.beginTabTbSyncStepWrite({
    tabId: tab.id,
    operationId: reservedA.operation.operationId,
    payloadSha256: reservedA.operation.payloadSha256,
    ownerToken: ownerA,
    fencingToken: reservedA.operation.fencingToken,
    step: "comment",
    key: stepKeys.comment,
  });
  assert.equal(staleBegin.ok, false);
  assert.equal(staleBegin.code, "TB_SYNC_OPERATION_CAS_MISMATCH");
  assert.deepEqual(counters, emptyCounters(), "stale owner CAS failure must precede every remote call");

  const completed = await workflowB.runPersistedTbSync(storeB.getTab(tab.id), frozen, {
    expectedKind: "report",
    storeApi: storeB,
    api: remoteApi(remote, counters),
    ownerToken: ownerB,
  });
  assert.equal(completed.ok, true, JSON.stringify(completed));
  assert.equal(counters.commentWrites, 1);
  assert.equal(counters.attachmentWrites, 1);
  assert.equal(counters.statusWrites, 1);
  assert.equal(storeB.getTab(tab.id).workflow.tbSyncOperation.status, "completed");
});

test("进程 A 评论写后崩溃，进程 B 只读核对后接管后续步骤且不重写评论", async () => {
  const { tab } = createStory(`TB durable ambiguous ${Date.now()}`);
  const frozen = candidate(null, { reportRevision: "ambiguous-revision" });
  const remote = { comments: [], attachments: [], status: "修复中", expectedAttachment: null };
  const firstCounters = emptyCounters();
  const first = await workflowA.runPersistedTbSync(tab, frozen, {
    expectedKind: "report",
    storeApi: storeA,
    api: remoteApi(remote, firstCounters, { crashAfterCommentWrite: true }),
  });
  assert.equal(first.ok, false);
  assert.equal(firstCounters.commentWrites, 1);
  let persisted = storeA.getTab(tab.id).workflow;
  assert.equal(persisted.phase, "sync_pending");
  assert.equal(persisted.tbSyncOperation.status, "ambiguous");
  assert.equal(persisted.tbSyncOperation.outbox.comment.state, "ambiguous");
  assert.equal(persisted.tbSyncOperation.outbox.comment.writeAttempts, 1);

  const otherCounters = emptyCounters();
  const other = await workflowB.runPersistedTbSync(storeB.getTab(tab.id), frozen, {
    expectedKind: "report",
    storeApi: storeB,
    api: remoteApi(remote, otherCounters),
  });
  assert.equal(other.ok, true, JSON.stringify(other));
  assert.equal(otherCounters.commentWrites, 0, "new owner must not rewrite the ambiguous comment");
  assert.equal(otherCounters.reads > 0, true, "new owner must reconcile by remote readback");
  assert.equal(otherCounters.statusWrites, 1, "new owner may continue a never-attempted next step after confirmation");
  persisted = storeB.getTab(tab.id).workflow;
  assert.equal(persisted.phase, "testable");
  assert.equal(persisted.tbSyncOperation.status, "completed");
  assert.equal(persisted.tbSyncOperation.outbox.comment.state, "completed");
  assert.equal(persisted.tbSyncOperation.fencingToken > 1, true);

  const staleOwnerCounters = emptyCounters();
  const staleOwner = await workflowA.runPersistedTbSync(storeA.getTab(tab.id), frozen, {
    expectedKind: "report",
    storeApi: storeA,
    api: remoteApi(remote, staleOwnerCounters),
  });
  assert.equal(staleOwner.ok, true);
  assert.equal(staleOwner.replayed, true);
  assert.deepEqual(staleOwnerCounters, emptyCounters());
  assert.equal(firstCounters.commentWrites + otherCounters.commentWrites, 1);
});

test("新 owner 回读未命中时保持 reconcile-only；后续 Gateway 也只能只读核对并零重写", async () => {
  const { tab } = createStory(`TB durable reconcile miss ${Date.now()}`);
  const frozen = candidate(null, { reportRevision: "reconcile-miss-revision" });
  const remote = { comments: [], attachments: [], status: "修复中", expectedAttachment: null };
  const firstCounters = emptyCounters();
  const first = await workflowA.runPersistedTbSync(tab, frozen, {
    expectedKind: "report",
    storeApi: storeA,
    api: remoteApi(remote, firstCounters, {
      crashAfterCommentWrite: true,
      omitCommentSideEffect: true,
    }),
  });
  assert.equal(first.ok, false);
  assert.equal(storeA.getTab(tab.id).workflow.tbSyncOperation.status, "ambiguous");

  const reconcilerCounters = emptyCounters();
  const reconciler = await workflowB.runPersistedTbSync(storeB.getTab(tab.id), frozen, {
    expectedKind: "report",
    storeApi: storeB,
    api: remoteApi(remote, reconcilerCounters),
  });
  assert.equal(reconciler.ok, false);
  assert.equal(reconcilerCounters.reads > 0, true);
  assert.equal(reconcilerCounters.commentWrites, 0);
  assert.equal(reconcilerCounters.statusWrites, 0);
  assert.equal(storeB.getTab(tab.id).workflow.tbSyncOperation.status, "reconciling");

  const thirdStore = await import(`../services/devbench/store.js?tb-durable-store-c=${nonce}`);
  const thirdWorkflow = await import(`../services/devbench/tb-workflow.js?tb-durable-gateway-c=${nonce}`);
  const thirdCounters = emptyCounters();
  const third = await thirdWorkflow.runPersistedTbSync(thirdStore.getTab(tab.id), frozen, {
    expectedKind: "report",
    storeApi: thirdStore,
    api: remoteApi(remote, thirdCounters),
  });
  assert.equal(third.ok, false);
  assert.equal(thirdCounters.reads > 0, true);
  assert.equal(thirdCounters.commentWrites, 0);
  assert.equal(thirdCounters.attachmentWrites, 0);
  assert.equal(thirdCounters.statusWrites, 0);
  assert.equal(thirdStore.getTab(tab.id).workflow.tbSyncOperation.status, "reconciling");
});

test("附件和状态写后崩溃也由新 owner 只读确认，已尝试步骤均不重写", async () => {
  for (const crashStep of ["attachment", "status"]) {
    const { tab, attachment } = createStory(`TB durable ${crashStep} crash ${Date.now()}`, { withAttachment: true });
    const frozen = candidate(attachment, { reportRevision: `${crashStep}-crash-revision` });
    const remote = { comments: [], attachments: [], status: "修复中", expectedAttachment: attachment };
    const firstCounters = emptyCounters();
    const first = await workflowA.runPersistedTbSync(tab, frozen, {
      expectedKind: "report",
      storeApi: storeA,
      api: remoteApi(remote, firstCounters, {
        crashAfterAttachmentWrite: crashStep === "attachment",
        crashAfterStatusWrite: crashStep === "status",
      }),
    });
    assert.equal(first.ok, false, crashStep);
    assert.equal(storeA.getTab(tab.id).workflow.tbSyncOperation.status, "ambiguous");

    const recoveryCounters = emptyCounters();
    const recovered = await workflowB.runPersistedTbSync(storeB.getTab(tab.id), frozen, {
      expectedKind: "report",
      storeApi: storeB,
      api: remoteApi(remote, recoveryCounters),
    });
    assert.equal(recovered.ok, true, `${crashStep}: ${JSON.stringify(recovered)}`);
    assert.equal(recoveryCounters.commentWrites, 0, crashStep);
    assert.equal(recoveryCounters.attachmentWrites, 0, crashStep);
    if (crashStep === "status") assert.equal(recoveryCounters.statusWrites, 0, crashStep);
    assert.equal(storeB.getTab(tab.id).workflow.phase, "testable");
    assert.equal(storeB.getTab(tab.id).workflow.tbSyncOperation.status, "completed");
  }
});

test("远端成功但 acknowledgement 落库失败时禁止重写，只读回读可完成结算", async () => {
  const { tab } = createStory(`TB durable ack failure ${Date.now()}`);
  const frozen = candidate(null, { reportRevision: "ack-failure-revision" });
  const remote = { comments: [], attachments: [], status: "修复中", expectedAttachment: null };
  const counters = emptyCounters();
  let failAck = true;
  const flakyStore = {
    ...storeA,
    recordTabTbSyncStep(args) {
      if (failAck && args.step === "comment" && args.state === "write_acknowledged") {
        failAck = false;
        return { ok: false, statusCode: 500, code: "TEST_ACK_PERSIST_FAILED", error: "simulated disk failure" };
      }
      return storeA.recordTabTbSyncStep(args);
    },
  };
  const first = await workflowA.runPersistedTbSync(tab, frozen, {
    expectedKind: "report",
    storeApi: flakyStore,
    api: remoteApi(remote, counters),
  });
  assert.equal(first.ok, false);
  assert.equal(counters.commentWrites, 1);
  assert.equal(storeA.getTab(tab.id).workflow.tbSyncOperation.outbox.comment.state, "ambiguous");

  const retryCounters = emptyCounters();
  const retry = await workflowA.runPersistedTbSync(storeA.getTab(tab.id), frozen, {
    expectedKind: "report",
    storeApi: storeA,
    api: remoteApi(remote, retryCounters),
  });
  assert.equal(retry.ok, true, JSON.stringify(retry));
  assert.equal(counters.commentWrites + retryCounters.commentWrites, 1);
  assert.equal(storeA.getTab(tab.id).workflow.tbSyncOperation.status, "completed");
});

test("全部 outbox 已确认但 terminal 结算失败时，新 Gateway 零远端调用完成原子结算", async () => {
  const { tab } = createStory(`TB durable settlement recovery ${Date.now()}`);
  const frozen = candidate(null, { reportRevision: "settlement-recovery-revision" });
  const remote = { comments: [], attachments: [], status: "修复中", expectedAttachment: null };
  const counters = emptyCounters();
  const failedSettleStore = {
    ...storeA,
    settleTabTbSyncOperation() {
      return { ok: false, statusCode: 500, code: "TEST_SETTLEMENT_FAILED", error: "simulated settlement failure" };
    },
  };
  const first = await workflowA.runPersistedTbSync(tab, frozen, {
    expectedKind: "report",
    storeApi: failedSettleStore,
    api: remoteApi(remote, counters),
  });
  assert.equal(first.ok, false);
  const pending = storeA.getTab(tab.id).workflow;
  assert.equal(pending.phase, "sync_pending");
  assert.equal(pending.tbSyncOperation.status, "owned");
  assert.equal(pending.tbSyncOperation.outbox.comment.state, "completed");
  assert.equal(pending.tbSyncOperation.outbox.status.state, "completed");

  const recoveryCounters = emptyCounters();
  const recovered = await workflowB.runPersistedTbSync(storeB.getTab(tab.id), frozen, {
    expectedKind: "report",
    storeApi: storeB,
    api: remoteApi(remote, recoveryCounters),
  });
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  assert.deepEqual(recoveryCounters, emptyCounters());
  const completed = storeB.getTab(tab.id).workflow;
  assert.equal(completed.phase, "testable");
  assert.equal(completed.tbSyncOperation.status, "completed");
  assert.deepEqual(completed.tbSyncLedger, completed.tbSyncOperation.ledger);
});
