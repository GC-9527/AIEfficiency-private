import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-observability-"));
process.env.GATEWAY_DB_PATH = path.join(tempRoot, "gateway.db");
process.env.GATEWAY_CONFIG_PATH = path.join(tempRoot, "gateway.json");
process.env.DEVBENCH_CONFIG_PATH = path.join(tempRoot, "market.json");
process.env.DEVBENCH_STORE_DIR = path.join(tempRoot, "store");
process.env.AIEFFICIENCY_CLONE_PARENT = path.join(tempRoot, "clone-parent");
fs.writeFileSync(process.env.GATEWAY_CONFIG_PATH, JSON.stringify({ servers: { nodeId: "workflow-observability" } }), "utf8");

const sqlite = await import("../db/sqlite.js");
const store = await import("../services/devbench/store.js");
const {
  __testClassifyWorkflowObservationOutcome,
  __testObserveTbWrite,
  applyWorkflow,
} = await import("../services/devbench/tb-workflow.js");

after(() => {
  sqlite.default.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("报告校验阻断形成需重试率，TB 相同成功写入形成重复候选指标", async () => {
  const created = store.createTab({ title: "CARB-OBS 工作流观测" });
  const tab = store.updateTab(created.id, {
    ticketUrl: "https://www.teambition.com/task/0123456789abcdef01234567",
    workflow: {
      enabled: true,
      phase: "reporting",
      fixShortReport: "问题原因为空指针未拦截，解决措施为增加判空并补充回归测试。",
    },
  });

  const blocked = await applyWorkflow(tab, {
    kind: "report_done",
    shortReport: "任务状态：已完成",
    detailReport: "任务状态：已完成",
  }, {
    taskId: "report-task",
    attemptId: "report-attempt",
    workflowKind: "report",
    stage: "REPORT_SHORT",
  });
  assert.equal(blocked.blocked, true);
  assert.equal(
    __testClassifyWorkflowObservationOutcome({ phase: "reporting" }, "reporting"),
    "no_transition",
  );
  assert.equal(
    __testClassifyWorkflowObservationOutcome({ phase: "testable" }, "reporting"),
    "advanced",
  );

  sqlite.recordWorkflowStageObservation({
    storyId: tab.id,
    taskId: "report-missing-marker-task",
    attemptId: "report-missing-marker-attempt",
    workflowKind: "report",
    stage: "REPORT",
    phaseBefore: "reporting",
    phaseAfter: "reporting",
    outcome: "no_transition",
    reportValidationRetry: true,
  });

  const fingerprint = createHash("sha256").update("same-comment", "utf8").digest("hex");
  const first = sqlite.recordTbWriteObservation({
    storyId: tab.id,
    tbTaskId: "0123456789abcdef01234567",
    writeKind: "comment",
    payloadSha256: fingerprint,
    outcome: "succeeded",
  });
  const second = sqlite.recordTbWriteObservation({
    storyId: tab.id,
    tbTaskId: "0123456789abcdef01234567",
    writeKind: "comment",
    payloadSha256: fingerprint,
    outcome: "succeeded",
  });
  sqlite.recordTbWriteObservation({
    storyId: tab.id,
    tbTaskId: "0123456789abcdef01234567",
    writeKind: "comment",
    payloadSha256: createHash("sha256").update("failed-comment", "utf8").digest("hex"),
    outcome: "failed",
    errorCode: "HTTP_503",
  });
  assert.equal(first.duplicateCandidate, false);
  assert.equal(second.duplicateCandidate, true);

  __testObserveTbWrite({
    storyId: tab.id,
    tbTaskId: "0123456789abcdef01234567",
    writeKind: "status",
    payload: { logicalName: "可提测" },
    result: { ok: true },
  });
  const wrappedObservation = sqlite.default.prepare(`
    SELECT story_id, payload_sha256, outcome
    FROM tb_write_observations
    WHERE write_kind = 'status'
  `).get();
  assert.equal(wrappedObservation.story_id, tab.id);
  assert.match(wrappedObservation.payload_sha256, /^[a-f0-9]{64}$/);
  assert.equal(wrappedObservation.outcome, "succeeded");

  const metrics = sqlite.getWorkflowObservability({ days: 1 });
  assert.deepEqual(metrics.report, {
    validationAttempts: 2,
    retryRequired: 2,
    retryRequiredRate: 1,
  });
  assert.deepEqual(metrics.stages, [{
    stage: "REPORT",
    attempts: 1,
    advanced: 0,
    blocked: 0,
    execution_failed: 0,
    stopped: 0,
    no_transition: 1,
    measured_attempts: 1,
    advancement_rate: 0,
  }, {
    stage: "REPORT_SHORT",
    attempts: 1,
    advanced: 0,
    blocked: 1,
    execution_failed: 0,
    stopped: 0,
    no_transition: 0,
    measured_attempts: 1,
    advancement_rate: 0,
  }]);
  assert.deepEqual(metrics.tbWrites, [{
    write_kind: "comment",
    attempts: 3,
    succeeded: 2,
    failed: 1,
    skipped: 0,
    duplicate_candidates: 1,
    duplicate_candidate_rate: 0.5,
  }, {
    write_kind: "status",
    attempts: 1,
    succeeded: 1,
    failed: 0,
    skipped: 0,
    duplicate_candidates: 0,
    duplicate_candidate_rate: 0,
  }]);
  assert.doesNotThrow(() => sqlite.getWorkflowObservability({ days: Number.POSITIVE_INFINITY }));
  assert.doesNotThrow(() => sqlite.getWorkflowObservability({ days: -10 }));
});
