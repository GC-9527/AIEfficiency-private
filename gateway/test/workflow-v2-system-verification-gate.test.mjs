import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { buildTrustedSystemGate as buildTrustedSystemGateRaw } from "../services/devbench/workflow-v2/system-verification-gate.js";
import { buildStageReceiptRecorder } from "../services/devbench/workflow-v2/receipt-producer.js";
import { canonicalSha256 } from "../services/devbench/workflow-v2/envelope-store.js";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-v2-system-gate-"));
const storyDir = path.join(tempRoot, "story");
const blobDir = path.join(storyDir, "workflow-v2", "evidence-blobs");
fs.mkdirSync(blobDir, { recursive: true });

const STORY_ID = "story-system-gate-001";
const CONTEXT_ID = "ctx-system-gate-001";
const CONTEXT_REVISION = 3;
const ROOT_ID = "main";

const blobContent = "frozen-material-content";
const blobSha = createHash("sha256").update(blobContent).digest("hex");
const blobPath = path.join(blobDir, `${blobSha}.blob`);
fs.writeFileSync(blobPath, blobContent, "utf8");
const receiptOutput = "controlled system gate output";
const receiptOutputSha = createHash("sha256").update(receiptOutput).digest("hex");
const receiptOutputDir = path.join(storyDir, "workflow-v2", "receipt-output");
fs.mkdirSync(receiptOutputDir, { recursive: true });
fs.writeFileSync(path.join(receiptOutputDir, `${receiptOutputSha}.txt`), receiptOutput, "utf8");
const captureOutputDir = path.join(storyDir, "workflow-v2", "capture-output");
fs.mkdirSync(captureOutputDir, { recursive: true });
const materialArtifacts = Object.fromEntries(["video", "screenshot", "logcat"].map((requirement) => {
  const content = Buffer.from(`verified-${requirement}-material`, "utf8");
  const sha256 = createHash("sha256").update(content).digest("hex");
  fs.writeFileSync(path.join(captureOutputDir, `${sha256}.bin`), content);
  return [requirement, {
    outputRef: `storydev:/workflow-v2/capture-output/${sha256}.bin`,
    sha256,
  }];
}));

const storageApi = {
  getTab: () => ({ id: STORY_ID }),
  updateTab: () => {},
  getConversation: () => ({ nodes: [] }),
  tabProjectPaths: () => [{ role: "primary", projectId: "p1", path: path.join(tempRoot, "project") }],
  getStoryStoragePaths: () => ({ storyDirectory: storyDir, attachmentDirectory: path.join(storyDir, "archives") }),
  validateStoryStorageTarget: () => true,
};

function buildTrustedSystemGate(options) {
  return buildTrustedSystemGateRaw({ storageApi, ...options });
}

function planCase(caseId, action, mandatory) {
  return {
    caseId,
    title: caseId,
    storyIds: [STORY_ID],
    mandatory,
    executorId: `executor-${caseId}`,
    action,
    requirements: [],
    target: {
      rootId: ROOT_ID,
      flavor: null,
      buildType: null,
      deviceProfileId: null,
      environment: null,
    },
    preconditions: [],
    steps: ["run frozen executor"],
    assertions: ["exit code is zero"],
    evidenceRequirements: [`${action} receipt`],
    cleanup: [],
    failureDiagnostics: [],
  };
}

function dispatchFixture({ withPlan = true } = {}) {
  const cases = [
    planCase("case-build", "BUILD", true),
    planCase("case-test", "TEST", true),
    planCase("case-optional", "CAPTURE", false),
  ];
  return {
    stageId: "VERIFY_EXECUTE",
    contextId: CONTEXT_ID,
    contextRevision: CONTEXT_REVISION,
    executionStatus: { status: "READY", profileId: "profile-system-gate", blockers: [] },
    executionProfile: {
      profileId: "profile-system-gate",
      executors: cases.map((entry) => ({
        executorId: entry.executorId,
        action: entry.action,
        cwdRootId: ROOT_ID,
      })),
    },
    context: {
      story: { storyId: STORY_ID },
      data: withPlan
        ? {
          verificationPlan: {
            schemaVersion: "verification-plan-v2",
            planId: "plan-verify-001",
            profileId: "profile-system-gate",
            status: "READY",
            storyIds: [STORY_ID],
            mandatoryCapabilities: ["BUILD", "TEST"],
            blockers: [],
            cases,
          },
        }
        : {},
    },
  };
}

function receiptPayload({
  receiptId,
  action = receiptId === "r2" ? "TEST" : "BUILD",
  status = "PASS",
  contextId = CONTEXT_ID,
  contextRevision = CONTEXT_REVISION,
  caseId = receiptId === "r2" ? "case-test" : "case-build",
  executorId = `executor-${caseId}`,
  evidenceId = null,
  selector = {},
  outputRef = `storydev:/workflow-v2/receipt-output/${receiptOutputSha}.txt`,
  sha256 = receiptOutputSha,
}) {
  return {
    schemaVersion: "evidence-receipt-v2",
    receiptId,
    evidenceId,
    operationId: `op-${receiptId}`,
    action,
    status,
    toolName: "controlled_build",
    rootId: ROOT_ID,
    selector: { contextId, contextRevision, caseId, executorId, ...selector },
    startedAt: "2026-08-08T08:00:00.000Z",
    finishedAt: "2026-08-08T08:00:01.000Z",
    outputRef,
    sha256,
    summary: "test receipt",
    idempotencyKey: `op-${receiptId}`,
  };
}

function envelopeFor(payload) {
  return {
    schemaVersion: "workflow-envelope-v2",
    storyId: STORY_ID,
    recordId: payload.receiptId,
    contextId: null,
    revision: 1,
    idempotencyKey: `env-${payload.receiptId}-env`,
    payloadSchemaId: "https://example.local/schemas/evidence-receipt-v2.json",
    payloadSha256: canonicalSha256(payload),
    operationArgsSha256: createHash("sha256").update(JSON.stringify({ action: payload.action })).digest("hex"),
    previousEnvelopeSha256: null,
    createdAt: "2026-08-08T08:00:01.000Z",
    payload,
    envelopeSha256: createHash("sha256").update(`envelope-${payload.receiptId}`).digest("hex"),
  };
}

function resultFixture({ cases, planId = "plan-verify-001" }) {
  return { status: "COMPLETED", conclusion: "PASS", planId, cases };
}

function deepFrozen(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return true;
  if (!Object.isFrozen(value)) return false;
  seen.add(value);
  return Object.values(value).every((entry) => deepFrozen(entry, seen));
}

describe("M6 系统 VERIFY 门禁（trustedSystemGate）", () => {
  it("缺少冻结 verificationPlan 时拒绝（BLOCKED 语义）", async () => {
    const dispatch = dispatchFixture({ withPlan: false });
    const result = resultFixture({ cases: [] });
    await assert.rejects(
      () => buildTrustedSystemGate({ tab: storageApi.getTab(), dispatch, result }),
      (error) => error.code === "WORKFLOW_V2_SYSTEM_GATE_PLAN_MISSING",
    );
  });

  it("result.planId 与冻结计划不一致 → BLOCKED", async () => {
    const dispatch = dispatchFixture();
    const result = resultFixture({ cases: [], planId: "other-plan" });
    const gate = await buildTrustedSystemGate({ tab: storageApi.getTab(), dispatch, result });
    assert.equal(gate.status, "BLOCKED");
    assert.ok(deepFrozen(gate));
  });

  it("result.cases 与冻结计划不一致 → BLOCKED", async () => {
    const dispatch = dispatchFixture();
    const result = resultFixture({
      cases: [
        { caseId: "case-build", status: "PASS", receiptIds: ["r1"] },
        { caseId: "case-ghost", status: "PASS", receiptIds: ["r2"] },
      ],
    });
    const gate = await buildTrustedSystemGate({ tab: storageApi.getTab(), dispatch, result });
    assert.equal(gate.status, "BLOCKED");
  });

  it("计划没有 mandatory case → BLOCKED，不能系统计算 PASS", async () => {
    const dispatch = dispatchFixture();
    dispatch.context.data.verificationPlan.cases = [planCase("case-optional", "CAPTURE", false)];
    dispatch.context.data.verificationPlan.mandatoryCapabilities = [];
    const result = resultFixture({ cases: [{ caseId: "case-optional", status: "NOT_RUN", receiptIds: [] }] });
    const gate = await buildTrustedSystemGate({ tab: storageApi.getTab(), dispatch, result });
    assert.equal(gate.status, "BLOCKED");
  });

  it("旧 example 式 mandatoryCapabilities 与 mandatory cases 错位 → BLOCKED 且给出迁移诊断", async () => {
    const dispatch = dispatchFixture();
    const deviceCase = {
      ...planCase("case-device", "DEVICE_ACTION", true),
      evidenceRequirements: ["video", "screenshot", "logcat"],
    };
    dispatch.context.data.verificationPlan.cases = [deviceCase];
    dispatch.context.data.verificationPlan.mandatoryCapabilities = ["BUILD", "DEVICE_ACTION", "CAPTURE"];
    dispatch.executionProfile.executors = [{
      executorId: deviceCase.executorId,
      action: deviceCase.action,
      cwdRootId: ROOT_ID,
    }];
    const result = resultFixture({
      cases: [{ caseId: "case-device", status: "PASS", receiptIds: ["r-device"] }],
    });
    let reads = 0;
    const gate = await buildTrustedSystemGate({
      tab: storageApi.getTab(),
      dispatch,
      result,
      readEnvelopes: async () => { reads += 1; return []; },
    });
    assert.equal(gate.status, "BLOCKED");
    assert.match(gate.reason, /mandatoryCapabilities/);
    assert.deepEqual([...gate.details.missingMandatoryCases], ["BUILD", "CAPTURE"]);
    assert.equal(reads, 0);
  });

  it("mandatory case 只有主 DEVICE_ACTION 回执但缺 video/screenshot/logcat 材料 → FAIL", async () => {
    const dispatch = dispatchFixture();
    const deviceCase = {
      ...planCase("case-device", "DEVICE_ACTION", true),
      evidenceRequirements: ["video", "screenshot", "logcat"],
    };
    dispatch.context.data.verificationPlan.cases = [deviceCase];
    dispatch.context.data.verificationPlan.mandatoryCapabilities = ["DEVICE_ACTION"];
    dispatch.executionProfile.executors = [{
      executorId: deviceCase.executorId,
      action: deviceCase.action,
      cwdRootId: ROOT_ID,
    }];
    const result = resultFixture({
      cases: [{ caseId: "case-device", status: "PASS", receiptIds: ["r-device"] }],
    });
    const gate = await buildTrustedSystemGate({
      tab: storageApi.getTab(),
      dispatch,
      result,
      readEnvelopes: async () => [envelopeFor(receiptPayload({
        receiptId: "r-device",
        action: "DEVICE_ACTION",
        caseId: "case-device",
      }))],
    });
    assert.equal(gate.status, "FAIL");
    assert.match(gate.reason, /video/);
  });

  it("CAPTURE case 主回执与每项材料独立消费且均绑定同 context/root/case/executor → PASS", async () => {
    const dispatch = dispatchFixture();
    const captureCase = {
      ...planCase("case-capture", "CAPTURE", true),
      evidenceRequirements: ["video", "screenshot", "logcat"],
    };
    dispatch.context.data.verificationPlan.cases = [captureCase];
    dispatch.context.data.verificationPlan.mandatoryCapabilities = ["CAPTURE"];
    dispatch.executionProfile.executors = [{
      executorId: captureCase.executorId,
      action: captureCase.action,
      cwdRootId: ROOT_ID,
    }];
    const result = resultFixture({
      cases: [{ caseId: "case-capture", status: "PASS", receiptIds: ["r-capture-primary"] }],
    });
    const materialKind = { video: "VIDEO", screenshot: "IMAGE", logcat: "LOG" };
    const materialEnvelopes = Object.entries(materialKind).map(([requirement, kind]) => envelopeFor(receiptPayload({
      receiptId: `r-material-${requirement}`,
      action: "CAPTURE",
      caseId: "case-capture",
      evidenceId: `evidence-${requirement}`,
      selector: { evidenceRequirement: requirement, materialKind: kind },
      ...materialArtifacts[requirement],
    })));
    const gate = await buildTrustedSystemGate({
      tab: storageApi.getTab(),
      dispatch,
      result,
      readEnvelopes: async () => [
        envelopeFor(receiptPayload({
          receiptId: "r-capture-primary",
          action: "CAPTURE",
          caseId: "case-capture",
        })),
        ...materialEnvelopes,
      ],
    });
    assert.equal(gate.status, "PASS");
  });

  it("CAPTURE case 主回执不能同时复用为同一 evidenceRequirement 材料回执", async () => {
    const dispatch = dispatchFixture();
    const captureCase = {
      ...planCase("case-capture", "CAPTURE", true),
      evidenceRequirements: ["video"],
    };
    dispatch.context.data.verificationPlan.cases = [captureCase];
    dispatch.context.data.verificationPlan.mandatoryCapabilities = ["CAPTURE"];
    dispatch.executionProfile.executors = [{
      executorId: captureCase.executorId,
      action: captureCase.action,
      cwdRootId: ROOT_ID,
    }];
    const primary = receiptPayload({
      receiptId: "r-capture-primary",
      action: "CAPTURE",
      caseId: "case-capture",
      evidenceId: "evidence-video",
      selector: { evidenceRequirement: "video", materialKind: "VIDEO" },
      ...materialArtifacts.video,
    });
    const gate = await buildTrustedSystemGate({
      tab: storageApi.getTab(),
      dispatch,
      result: resultFixture({
        cases: [{ caseId: "case-capture", status: "PASS", receiptIds: [primary.receiptId] }],
      }),
      readEnvelopes: async () => [envelopeFor(primary)],
    });
    assert.equal(gate.status, "FAIL");
    assert.match(gate.reason, /缺少 video 独立可信材料回执/);
  });

  it("未知自由文本 evidenceRequirement → BLOCKED；合法计划的 VERIFY FAIL 不要求正向材料", async () => {
    const dispatch = dispatchFixture();
    const deviceCase = {
      ...planCase("case-device", "DEVICE_ACTION", true),
      evidenceRequirements: ["operator says evidence exists"],
    };
    dispatch.context.data.verificationPlan.cases = [deviceCase];
    dispatch.context.data.verificationPlan.mandatoryCapabilities = ["DEVICE_ACTION"];
    dispatch.executionProfile.executors = [{
      executorId: deviceCase.executorId,
      action: deviceCase.action,
      cwdRootId: ROOT_ID,
    }];
    const result = resultFixture({
      cases: [{ caseId: "case-device", status: "PASS", receiptIds: ["r-device"] }],
    });
    const blocked = await buildTrustedSystemGate({
      tab: storageApi.getTab(),
      dispatch,
      result,
      readEnvelopes: async () => { throw new Error("invalid plan must not read receipts"); },
    });
    assert.equal(blocked.status, "BLOCKED");
    assert.match(blocked.reason, /evidenceRequirement/);

    deviceCase.evidenceRequirements = ["video"];
    const failed = await buildTrustedSystemGate({
      tab: storageApi.getTab(),
      dispatch,
      result: resultFixture({
        cases: [{ caseId: "case-device", status: "FAIL", receiptIds: [] }],
      }),
      readEnvelopes: async () => [],
    });
    assert.equal(failed.status, "FAIL");
    assert.match(failed.reason, /状态不是 PASS/);
  });

  it("mandatory case NOT_RUN/BLOCKED/FAIL → FAIL（VER-001）", async () => {
    const dispatch = dispatchFixture();
    const result = resultFixture({
      cases: [
        { caseId: "case-build", status: "PASS", receiptIds: ["r1"] },
        { caseId: "case-test", status: "NOT_RUN", receiptIds: [] },
        { caseId: "case-optional", status: "NOT_RUN", receiptIds: [] },
      ],
    });
    const readEnvelopes = async () => [envelopeFor(receiptPayload({ receiptId: "r1" }))];
    const gate = await buildTrustedSystemGate({ tab: storageApi.getTab(), dispatch, result, readEnvelopes });
    assert.equal(gate.status, "FAIL");
  });

  it("mandatory case 声称的 receipt 不存在 → FAIL（EVD-001/VER-002）", async () => {
    const dispatch = dispatchFixture();
    const result = resultFixture({
      cases: [
        { caseId: "case-build", status: "PASS", receiptIds: ["ghost-receipt"] },
        { caseId: "case-test", status: "PASS", receiptIds: ["r2"] },
        { caseId: "case-optional", status: "NOT_RUN", receiptIds: [] },
      ],
    });
    const readEnvelopes = async () => [envelopeFor(receiptPayload({ receiptId: "r2" }))];
    const gate = await buildTrustedSystemGate({ tab: storageApi.getTab(), dispatch, result, readEnvelopes });
    assert.equal(gate.status, "FAIL");
  });

  it("receipt 未绑定当前冻结 context 或状态非 PASS → FAIL", async () => {
    const dispatch = dispatchFixture();
    const cases = [
      { caseId: "case-build", status: "PASS", receiptIds: ["r1"] },
      { caseId: "case-test", status: "PASS", receiptIds: ["r2"] },
      { caseId: "case-optional", status: "NOT_RUN", receiptIds: [] },
    ];
    const stale = await buildTrustedSystemGate({
      tab: storageApi.getTab(),
      dispatch,
      result: resultFixture({ cases }),
      readEnvelopes: async () => [envelopeFor(receiptPayload({ receiptId: "r1", contextRevision: CONTEXT_REVISION - 1 }))],
    });
    assert.equal(stale.status, "FAIL");
    const failed = await buildTrustedSystemGate({
      tab: storageApi.getTab(),
      dispatch,
      result: resultFixture({ cases }),
      readEnvelopes: async () => [envelopeFor(receiptPayload({ receiptId: "r1", status: "FAIL" }))],
    });
    assert.equal(failed.status, "FAIL");
    const wrongAction = await buildTrustedSystemGate({
      tab: storageApi.getTab(),
      dispatch,
      result: resultFixture({ cases }),
      readEnvelopes: async () => [envelopeFor(receiptPayload({ receiptId: "r1", action: "READ" }))],
    });
    assert.equal(wrongAction.status, "FAIL");
  });

  it("同一 receipt 被多个 mandatory case 复用 → FAIL", async () => {
    const dispatch = dispatchFixture();
    const result = resultFixture({
      cases: [
        { caseId: "case-build", status: "PASS", receiptIds: ["r1"] },
        { caseId: "case-test", status: "PASS", receiptIds: ["r1"] },
        { caseId: "case-optional", status: "NOT_RUN", receiptIds: [] },
      ],
    });
    const readEnvelopes = async () => [envelopeFor(receiptPayload({ receiptId: "r1" }))];
    const gate = await buildTrustedSystemGate({ tab: storageApi.getTab(), dispatch, result, readEnvelopes });
    assert.equal(gate.status, "FAIL");
  });

  it("全部 mandatory case 都有真实 PASS 回执 → PASS（系统结论，非模型文本）", async () => {
    const dispatch = dispatchFixture();
    const result = resultFixture({
      cases: [
        { caseId: "case-build", status: "PASS", receiptIds: ["r1"] },
        { caseId: "case-test", status: "PASS", receiptIds: ["r2"] },
        { caseId: "case-optional", status: "NOT_RUN", receiptIds: [] },
      ],
    });
    const readEnvelopes = async () => [
      envelopeFor(receiptPayload({ receiptId: "r1", action: "BUILD" })),
      envelopeFor(receiptPayload({ receiptId: "r2", action: "TEST" })),
    ];
    const gate = await buildTrustedSystemGate({ tab: storageApi.getTab(), dispatch, result, readEnvelopes });
    assert.equal(gate.status, "PASS");
    assert.equal(gate.storyId, STORY_ID);
    assert.equal(gate.contextId, CONTEXT_ID);
    assert.equal(gate.contextRevision, CONTEXT_REVISION);
    assert.equal(gate.resultSha256, canonicalSha256(result));
    assert.equal(gate.planId, "plan-verify-001");
    assert.ok(deepFrozen(gate));
  });

  it("非 mandatory case 状态不影响系统 PASS", async () => {
    const dispatch = dispatchFixture();
    const result = resultFixture({
      cases: [
        { caseId: "case-build", status: "PASS", receiptIds: ["r1"] },
        { caseId: "case-test", status: "PASS", receiptIds: ["r2"] },
        { caseId: "case-optional", status: "FAIL", receiptIds: [] },
      ],
    });
    const readEnvelopes = async () => [
      envelopeFor(receiptPayload({ receiptId: "r1" })),
      envelopeFor(receiptPayload({ receiptId: "r2", action: "TEST" })),
    ];
    const gate = await buildTrustedSystemGate({ tab: storageApi.getTab(), dispatch, result, readEnvelopes });
    assert.equal(gate.status, "PASS");
  });
});

describe("M6 系统证据回执生产（receipt producer）", () => {
  let receipts = [];
  let revisionCounter = 0;

  function harness() {
    receipts = [];
    revisionCounter = 0;
    const dispatch = {
      contextId: CONTEXT_ID,
      contextRevision: CONTEXT_REVISION,
      evidenceSnapshots: [
        {
          evidenceId: "evt-material-001",
          contentRef: `storydev:/workflow-v2/evidence-blobs/${blobSha}.blob`,
          sizeBytes: Buffer.byteLength(blobContent, "utf8"),
          sha256: blobSha,
        },
      ],
    };
    return buildStageReceiptRecorder({
      tab: storageApi.getTab(),
      dispatch,
      storageApi,
      readEnvelopes: async () => [...receipts],
      appendReceipt: async ({ revision, idempotencyKey, operationArgs, payload }) => {
        const duplicate = receipts.find((entry) => entry.idempotencyKey === idempotencyKey);
        if (duplicate) return { replayed: true, envelope: null };
        const envelope = { revision, idempotencyKey, operationArgs, payload };
        receipts.push(envelope);
        return { replayed: false, envelope };
      },
      now: () => "2026-08-08T08:00:00.000Z",
    });
  }

  it("读取冻结 blob 且哈希一致时产生 READ/PASS 回执", async () => {
    const recorder = harness();
    const stored = await recorder.recordRead({ absolutePath: blobPath, toolName: "read_file" });
    assert.ok(stored);
    assert.equal(stored.replayed, false);
    assert.equal(receipts.length, 1);
    const receipt = receipts[0].payload;
    assert.equal(receipt.action, "READ");
    assert.equal(receipt.status, "PASS");
    assert.equal(receipt.evidenceId, "evt-material-001");
    assert.equal(receipt.sha256, blobSha);
    assert.equal(receipt.selector.contextId, CONTEXT_ID);
    assert.equal(receipt.selector.contextRevision, CONTEXT_REVISION);
  });

  it("同一操作幂等重放不产生重复回执", async () => {
    const recorder = harness();
    await recorder.recordRead({ absolutePath: blobPath });
    const replay = await recorder.recordRead({ absolutePath: blobPath });
    assert.equal(replay.replayed, true);
    assert.equal(receipts.length, 1);
  });

  it("文件哈希漂移时不产生回执", async () => {
    const recorder = harness();
    const drifted = path.join(blobDir, `${blobSha}.blob`);
    fs.writeFileSync(drifted, "different-content", "utf8");
    const stored = await recorder.recordRead({ absolutePath: drifted });
    assert.equal(stored, null);
    assert.equal(receipts.length, 0);
    fs.writeFileSync(drifted, blobContent, "utf8");
  });

  it("不在 manifest 内的路径不产生回执", async () => {
    const recorder = harness();
    const stored = await recorder.recordRead({ absolutePath: path.join(storyDir, "unrelated.txt") });
    assert.equal(stored, null);
    assert.equal(receipts.length, 0);
  });

  it("回执 revision 按流连续追加", async () => {
    const recorder = harness();
    await recorder.recordRead({ absolutePath: blobPath });
    assert.equal(receipts[0].revision, 1);
  });

  it("manifest 暴露给执行层用于命中判定", async () => {
    const recorder = harness();
    assert.equal(recorder.manifest.length, 1);
    assert.equal(recorder.manifest[0].evidenceId, "evt-material-001");
    assert.equal(recorder.manifest[0].absolutePath, blobPath);
    assert.equal(recorder.storyId, STORY_ID);
  });
});

after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
