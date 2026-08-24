import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "config-inference-governance-store-"));
process.env.DEVBENCH_CONFIG_PATH = path.join(tmp, "market.json");
process.env.DEVBENCH_LOCAL_PROJECTS_PATH = path.join(tmp, "local", "devbench-projects.json");
process.env.DEVBENCH_STORE_DIR = path.join(tmp, "store");
process.env.GATEWAY_CONFIG_PATH = path.join(tmp, "gateway.json");
process.env.GATEWAY_DB_PATH = path.join(tmp, "gateway.db");
process.env.AIEFFICIENCY_CLONE_PARENT = path.join(tmp, "clone-parent");

fs.writeFileSync(process.env.GATEWAY_CONFIG_PATH, JSON.stringify({
  servers: { nodeId: "governance-store-test" },
  teambition: {
    projects: [
      { id: "project-governance", name: "治理测试" },
      { id: "project-release", name: "发布治理测试" },
      { id: "project-machine", name: "跨机隔离测试" },
      { id: "project-conflict", name: "跨来源冲突测试" },
    ],
  },
}), "utf8");
fs.writeFileSync(process.env.DEVBENCH_CONFIG_PATH, JSON.stringify({
  projectDefs: [{
    id: "market",
    name: "应用市场",
    ssh: "git@example.com:apps/market.git",
  }],
  byProject: {
    "project-governance": {
      keywordMappings: {
        title: {
          "启动失败": { category: "app", value: "应用市场" },
        },
      },
      vehicleMap: {
        "测试车型": {
          apps: [{
            appName: "应用市场",
            repos: [{ repoId: "market", branch: "release/base", flavor: "demoProd" }],
          }],
        },
      },
    },
    "project-release": {
      keywordMappings: {
        title: {
          "启动失败": { category: "app", value: "应用市场" },
        },
      },
      vehicleMap: {
        "测试车型": {
          apps: [{
            appName: "应用市场",
            repos: [{ repoId: "market", branch: "release/base", flavor: "demoProd" }],
          }],
        },
      },
    },
    "project-machine": {
      keywordMappings: {
        title: {
          "启动失败": { category: "app", value: "应用市场" },
        },
      },
      vehicleMap: {
        "测试车型": {
          apps: [{
            appName: "应用市场",
            repos: [{ repoId: "market", branch: "release/base", flavor: "demoProd" }],
          }],
        },
      },
    },
    "project-conflict": {
      keywordMappings: {
        title: {
          MARKET: { category: "app", value: "Market" },
          CAR_A: { category: "vehicle", value: "carA" },
        },
        comment: {
          CAR_B: { category: "vehicle", value: "carB" },
        },
      },
      vehicleMap: {
        carA: {
          apps: [{
            appName: "Market",
            repos: [{ repoId: "market", branch: "release/a", flavor: "carAProd" }],
          }],
        },
        carB: {
          apps: [{
            appName: "Market",
            repos: [{ repoId: "market", branch: "release/b", flavor: "carBProd" }],
          }],
        },
      },
    },
  },
}), "utf8");

const store = await import("../services/devbench/store.js");
const { configInferenceConflictTargetFingerprint } = await import("../../web-dashboard/src/pages/devbench/aiTrainingGovernanceModel.mjs");

test.after(async () => {
  try {
    const { default: db } = await import("../db/sqlite.js");
    if (db?.open) db.close();
  } catch {}
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("跨来源冲突的正向复核必须逐项裁决，且裁决绑定最终目标图", () => {
  const run = store.runConfigInference("project-conflict", {
    captureSignals: false,
    ticket: {
      ticketId: "CASE-CONFLICT-1",
      projectId: "project-conflict",
      title: "MARKET CAR_A",
      comments: ["CAR_B"],
    },
  });
  assert.equal(run.ok, true, run.error);
  assert.ok(run.data.prediction.targets.length > 0);
  assert.deepEqual(run.data.prediction.quality.conflicts.reviewDimensions, ["vehicle"]);

  const directApproval = store.reviewConfigInferenceRun("project-conflict", run.data.id, {
    decision: "correct",
    rating: 5,
    reviewer: "conflict-reviewer",
  });
  assert.equal(directApproval.ok, false);
  assert.equal(directApproval.code, "CONFIG_INFERENCE_CONFLICT_REVIEW_REQUIRED");

  const correctedPrediction = { targets: run.data.prediction.targets };
  const missingResolution = store.reviewConfigInferenceRun("project-conflict", run.data.id, {
    decision: "corrected",
    rating: 4,
    reviewer: "conflict-reviewer",
    correctedPrediction,
  });
  assert.equal(missingResolution.ok, false);
  assert.equal(missingResolution.code, "CONFIG_INFERENCE_CONFLICT_REVIEW_REQUIRED");
  assert.ok(missingResolution.targetFingerprint);
  assert.equal(
    missingResolution.targetFingerprint,
    configInferenceConflictTargetFingerprint(correctedPrediction.targets),
    "前后端必须对同一目标图生成一致的冲突裁决指纹",
  );
  assert.equal(
    missingResolution.targetFingerprint,
    store.__testConfigInferenceConflictTargetFingerprint(correctedPrediction.targets),
  );

  const staleResolution = store.reviewConfigInferenceRun("project-conflict", run.data.id, {
    decision: "corrected",
    rating: 4,
    reviewer: "conflict-reviewer",
    correctedPrediction,
    conflictResolutions: {
      vehicle: { acknowledged: true, selectedValue: "carA", targetFingerprint: "stale-target" },
    },
  });
  assert.equal(staleResolution.ok, false);
  assert.equal(staleResolution.code, "CONFIG_INFERENCE_CONFLICT_REVIEW_REQUIRED");

  const reviewed = store.reviewConfigInferenceRun("project-conflict", run.data.id, {
    decision: "corrected",
    rating: 4,
    reviewer: "conflict-reviewer",
    correctedPrediction,
    conflictResolutions: {
      vehicle: {
        acknowledged: true,
        selectedValue: "carA",
        targetFingerprint: missingResolution.targetFingerprint,
      },
    },
  });
  assert.equal(reviewed.ok, true, reviewed.error);
  assert.equal(reviewed.data.review.conflictResolutions.vehicle.acknowledged, true);
  assert.equal(
    store.getReviewedConfigInferenceSnapshot("project-conflict", run.data.id).ok,
    true,
  );
});

test("annotation 审批、撤销和恢复 revision 与 serving 样本分离", () => {
  const run = store.runConfigInference("project-governance", {
    captureSignals: false,
    ticket: {
      ticketId: "CASE-GOVERNANCE-1",
      projectId: "project-governance",
      title: "应用市场启动失败",
    },
  });
  assert.equal(run.ok, true, run.error);
  const reviewed = store.reviewConfigInferenceRun("project-governance", run.data.id, {
    decision: "correct",
    rating: 5,
    reviewer: "annotator",
  });
  assert.equal(reviewed.ok, true, reviewed.error);
  assert.equal(reviewed.learned, false);
  assert.equal(reviewed.annotationPending, true);
  assert.equal(reviewed.sample.serving.status, "pending");
  assert.equal(store.getConfigInferenceData("project-governance").metrics.learnedSamples, 0);

  const firstVote = store.approveConfigInferenceAnnotation(
    "project-governance",
    reviewed.sample.id,
    { reviewer: "admin-a", reason: "复核通过" },
  );
  assert.equal(firstVote.ok, true, firstVote.error);
  assert.equal(firstVote.requiresMoreReviewers, true);
  assert.equal(firstVote.data.servingStatus, "pending");
  assert.equal(store.getConfigInferenceData("project-governance").metrics.learnedSamples, 0);

  const duplicateVote = store.approveConfigInferenceAnnotation(
    "project-governance",
    reviewed.sample.id,
    { reviewer: "admin-a", reason: "duplicate reviewer vote" },
  );
  assert.equal(duplicateVote.ok, true, duplicateVote.error);
  assert.equal(duplicateVote.idempotent, true);
  assert.equal(duplicateVote.data.servingStatus, "pending");

  const approved = store.approveConfigInferenceAnnotation(
    "project-governance",
    reviewed.sample.id,
    { reviewer: "admin-b", reason: "independent second reviewer" },
  );
  assert.equal(approved.ok, true, approved.error);
  assert.equal(approved.data.servingStatus, "approved");
  assert.equal(store.getConfigInferenceData("project-governance").metrics.learnedSamples, 1);

  const revoked = store.revokeConfigInferenceAnnotation(
    "project-governance",
    reviewed.sample.id,
    { reviewer: "admin-a", reason: "发现错误" },
  );
  assert.equal(revoked.ok, true, revoked.error);
  assert.equal(store.getConfigInferenceData("project-governance").metrics.learnedSamples, 0);

  const restored = store.restoreConfigInferenceAnnotation(
    "project-governance",
    reviewed.sample.id,
    { reviewer: "admin-b", reason: "重建标注 revision" },
  );
  assert.equal(restored.ok, true, restored.error);
  assert.equal(restored.requiresApproval, true);
  assert.notEqual(restored.data.id, reviewed.sample.id);
  assert.equal(restored.data.annotation.restoredFrom, reviewed.sample.id);
  assert.equal(restored.data.servingStatus, "pending");
  assert.equal(store.getConfigInferenceData("project-governance").metrics.learnedSamples, 0);

  const firstRestoreVote = store.approveConfigInferenceAnnotation(
    "project-governance",
    restored.data.id,
    { reviewer: "admin-c", reason: "批准新 revision" },
  );
  assert.equal(firstRestoreVote.ok, true, firstRestoreVote.error);
  assert.equal(firstRestoreVote.data.servingStatus, "pending");
  const approvedRestore = store.approveConfigInferenceAnnotation(
    "project-governance",
    restored.data.id,
    { reviewer: "admin-d", reason: "independent restore reviewer" },
  );
  assert.equal(approvedRestore.ok, true, approvedRestore.error);
  assert.equal(store.getConfigInferenceData("project-governance").metrics.learnedSamples, 1);
});

test("恶意 annotation vote 不能把本机 Value、revision 或伪造 logicalKey 写入共享历史", async () => {
  const run = store.runConfigInference("project-governance", {
    captureSignals: false,
    ticket: {
      ticketId: "CASE-GOVERNANCE-VOTE-PRIVACY",
      projectId: "project-governance",
      title: "应用市场启动失败",
    },
  });
  assert.equal(run.ok, true, run.error);
  const reviewed = store.reviewConfigInferenceRun("project-governance", run.data.id, {
    decision: "correct",
    rating: 5,
    reviewer: "vote-privacy-annotator",
  });
  assert.equal(reviewed.ok, true, reviewed.error);
  const canonicalTarget = structuredClone(reviewed.sample.groundTruth.targets[0]);
  const canonicalLogicalKey = canonicalTarget.fieldBindings?.branch?.logicalKey;
  assert.ok(canonicalLogicalKey);
  const maliciousTarget = structuredClone(canonicalTarget);
  maliciousTarget.fieldBindings.branch = {
    logicalKey: "K_CFG_FORGED_CLIENT_KEY",
    actualValue: "D:/private/vote-worktree",
    defaultValue: "password=VOTE-DEFAULT-SECRET",
    sourceValue: "/root/private/vote-source",
    revision: 777777,
  };
  const vote = {
    decision: "correct",
    noTargets: false,
    targets: [maliciousTarget],
  };
  for (const reviewer of ["vote-privacy-admin-a", "vote-privacy-admin-b"]) {
    const approval = store.approveConfigInferenceAnnotation(
      "project-governance",
      reviewed.sample.id,
      {
        reviewer,
        reviewerName: "D:/private/reviewer-name",
        reason: "password=VOTE-REASON-SECRET D:/private/reason",
        vote,
      },
    );
    assert.equal(approval.ok, true, approval.error);
  }

  const { getUserData } = await import("../db/sqlite.js");
  const rawShared = getUserData("__devbench_shared__", "shared");
  const rawSample = rawShared.byProject["project-governance"]
    .aiTraining.configInference.samples[reviewed.sample.id];
  const serialized = JSON.stringify(rawSample);
  for (const forbidden of [
    "D:/private/vote-worktree",
    "VOTE-DEFAULT-SECRET",
    "/root/private/vote-source",
    "K_CFG_FORGED_CLIENT_KEY",
    "777777",
    "D:/private/reviewer-name",
    "VOTE-REASON-SECRET",
    "D:/private/reason",
  ]) {
    assert.equal(serialized.includes(forbidden), false, `共享 annotation 泄露 ${forbidden}`);
  }
  assert.equal(rawSample.annotation.votes.length, 2);
  for (const storedVote of rawSample.annotation.votes) {
    const binding = storedVote.targets[0].fieldBindings.branch;
    assert.equal(binding.logicalKey, canonicalLogicalKey);
    for (const field of ["actualValue", "defaultValue", "sourceValue", "revision"]) {
      assert.equal(Object.hasOwn(binding, field), false);
    }
  }
  assert.equal(
    rawSample.approvedLabel.label.targets[0].fieldBindings.branch.logicalKey,
    canonicalLogicalKey,
  );
});

test("knowledge value 使用不可变 keyId，经 draft、approve、activate 后生效", () => {
  const keys = store.listConfigInferenceKnowledgeKeys("project-governance");
  assert.equal(keys.ok, true, keys.error);
  const branchKey = keys.data.find((row) => row.dimension === "branch");
  assert.ok(branchKey);
  assert.match(branchKey.keyId, /^K_CFG_/);

  const draft = store.createConfigInferenceKnowledgeRevision(
    "project-governance",
    branchKey.keyId,
    {
      scope: "project",
      scopeId: "project-governance",
      actualValue: "release/governed",
      expectedRevision: 0,
      reason: "治理测试",
      operator: "admin-a",
    },
  );
  assert.equal(draft.ok, true, draft.error);
  assert.equal(draft.data.status, "draft");
  assert.equal(
    store.listConfigInferenceKnowledgeKeys("project-governance")
      .data.find((row) => row.keyId === branchKey.keyId).effective.actualValue,
    branchKey.effective.actualValue,
  );

  const approved = store.approveConfigInferenceKnowledgeRevision(
    "project-governance",
    branchKey.keyId,
    draft.data.id,
    { operator: "admin-b", reason: "审批" },
  );
  assert.equal(approved.ok, true, approved.error);
  assert.equal(approved.data.status, "approved");

  const activated = store.activateConfigInferenceKnowledgeRevision(
    "project-governance",
    branchKey.keyId,
    draft.data.id,
    { operator: "admin-b", reason: "发布" },
  );
  assert.equal(activated.ok, true, activated.error);
  assert.equal(activated.data.status, "active");
  const activeKey = store.listConfigInferenceKnowledgeKeys("project-governance")
    .data.find((row) => row.keyId === branchKey.keyId);
  assert.equal(activeKey.effective.actualValue, "release/governed");
  assert.equal(activeKey.effective.revisionId, draft.data.id);
});

test("真实执行 started/success 只保留 observation，accepted 才进入 serving", () => {
  const projectPath = path.join(tmp, "local-market");
  fs.mkdirSync(path.join(projectPath, ".git"), { recursive: true });
  fs.writeFileSync(
    path.join(projectPath, ".git", "config"),
    '[remote "origin"]\n\turl = git@example.com:apps/market.git\n',
    "utf8",
  );
  fs.writeFileSync(path.join(projectPath, ".git", "HEAD"), "ref: refs/heads/release/base\n", "utf8");
  assert.equal(store.upsertProject({ id: "market", name: "应用市场", path: projectPath }).ok, true);
  const tab = store.createTab({ title: "CASE-OBSERVATION", projectDefId: "market" });
  const configured = store.updateTab(tab.id, {
    mode: "remote",
    primaryProjectId: "market",
    flavors: [{ path: projectPath, flavor: "demoProd" }],
    tbContext: {
      projectId: "project-governance",
      ticketId: "CASE-OBSERVATION",
      title: "应用市场启动失败",
      sourceCoverage: {},
    },
  });

  const started = store.recordConfigInferenceUsage("project-governance", {
    tab: configured,
    outcome: "started",
  });
  assert.equal(started.ok, true, started.error);
  assert.equal(started.learned, false);
  assert.equal(started.data.servingStatus, "pending");
  assert.equal(started.data.groundTruth, null);

  const success = store.recordConfigInferenceUsage("project-governance", {
    tab: configured,
    outcome: "success",
    verified: true,
    verifiedBy: "acceptance-agent",
  });
  assert.equal(success.ok, true, success.error);
  assert.equal(success.learned, false);
  assert.equal(success.data.observation.verified, true);

  const blocked = store.recordConfigInferenceUsage("project-governance", {
    tab: configured,
    outcome: "accepted",
    verified: true,
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, "CONFIG_INFERENCE_EXECUTION_ACCEPTANCE_REQUIRED");

  const accepted = store.recordConfigInferenceUsage("project-governance", {
    tab: configured,
    outcome: "accepted",
    verified: true,
    approved: true,
    reviewer: "admin-a",
  });
  assert.equal(accepted.ok, true, accepted.error);
  assert.equal(accepted.learned, true);
  assert.equal(accepted.data.servingStatus, "approved");
  assert.equal(accepted.data.groundTruth.targets.length, 1);

  const reverted = store.recordConfigInferenceUsage("project-governance", {
    tab: configured,
    outcome: "reverted",
    reviewer: "admin-a",
    reason: "上线回滚",
  });
  assert.equal(reverted.ok, true, reverted.error);
  assert.equal(reverted.learned, false);
  assert.equal(reverted.data.servingStatus, "revoked");
});

test("node/user 实际值只在本机响应物化，共享 run 与样本仅保存 logicalKey/canonical 值", async () => {
  const seed = store.runConfigInference("project-machine", {
    captureSignals: false,
    ticket: {
      ticketId: "CASE-MACHINE-SEED",
      projectId: "project-machine",
      title: "应用市场启动失败",
    },
  });
  assert.equal(seed.ok, true, seed.error);
  const seededReview = store.reviewConfigInferenceRun("project-machine", seed.data.id, {
    decision: "correct",
    rating: 5,
    reviewer: "machine-seed-reviewer",
  });
  assert.equal(seededReview.ok, true, seededReview.error);
  const key = store.listConfigInferenceKnowledgeKeys("project-machine")
    .data.find((row) => row.dimension === "branch");
  assert.ok(key?.keyId);
  const bound = store.upsertConfigInferenceMachineBinding("project-machine", key.keyId, {
    actualValue: "/root/private",
    expectedRevision: 0,
    reason: "验证本机路径不进入共享训练数据",
    operator: "machine-admin",
  });
  assert.equal(bound.ok, true, bound.error);

  const run = store.runConfigInference("project-machine", {
    captureSignals: false,
    tabId: "local-tab-must-not-cross-node",
    ticket: {
      ticketId: "CASE-MACHINE-PRIVATE",
      projectId: "project-machine",
      title: "应用市场启动失败",
    },
  });
  assert.equal(run.ok, true, run.error);
  assert.equal(run.data.prediction.targets[0].branch, "/root/private");

  const { getUserData } = await import("../db/sqlite.js");
  let rawShared = getUserData("__devbench_shared__", "shared");
  let serialized = JSON.stringify(rawShared);
  const leakedAt = serialized.indexOf("/root/private");
  assert.equal(
    leakedAt >= 0,
    false,
    leakedAt >= 0 ? serialized.slice(Math.max(0, leakedAt - 240), leakedAt + 320) : "",
  );
  const rawRun = rawShared.byProject["project-machine"].aiTraining.configInference.runs[run.data.id];
  assert.equal(Object.hasOwn(rawRun, "tabId"), false);
  assert.equal(Object.hasOwn(rawRun.inferenceRevisions, "machineBindingRevision"), false);
  assert.equal(rawRun.prediction.targets[0].branch, "release/base");
  assert.ok(rawRun.prediction.targets[0].fieldBindings.branch.logicalKey);
  assert.equal(Object.hasOwn(rawRun.prediction.targets[0].fieldBindings.branch, "actualValue"), false);

  const reviewed = store.reviewConfigInferenceRun("project-machine", run.data.id, {
    decision: "corrected",
    correctedPrediction: {
      targets: [{
        appName: "应用市场",
        vehicle: "测试车型",
        repositoryId: "market",
        branch: "release/base",
        flavor: "demoProd",
        targetRole: "primary",
        order: 1,
      }],
    },
    rating: 5,
    reviewer: "machine-reviewer",
  });
  assert.equal(reviewed.ok, true, reviewed.error);
  rawShared = getUserData("__devbench_shared__", "shared");
  serialized = JSON.stringify(rawShared.byProject["project-machine"].aiTraining.configInference);
  assert.equal(serialized.includes("/root/private"), false);
  assert.ok(rawShared.byProject["project-machine"].aiTraining.configInference.samples[reviewed.sample.id]);
});

test("Golden Set、离线评测与 release 草稿走生产 store，未过门禁不能影响 serving", async () => {
  const snapshotAt = "2026-07-20T00:00:00.000Z";
  const rawAttachmentBody = `api_key=ATTACHMENT-SECRET ${"X".repeat(1200)} BODY-ONLY-MARKER`;
  const run = store.runConfigInference("project-release", {
    captureSignals: false,
    ticket: {
      ticketId: "CASE-RELEASE-1",
      projectId: "project-release",
      title: "应用市场启动失败",
      description: "password=hunter2 C:\\Users\\alice\\secret.txt alice@example.com",
      comments: [{
        id: "comment-1",
        text: "authorization=COMMENT-SECRET 联系 13800138000",
        availableAt: snapshotAt,
      }],
      attachments: [{
        id: "attachment-1",
        name: "startup.log",
        text: rawAttachmentBody,
        downloadUrl: "https://example.com/private?token=RAW-URL-SECRET",
        status: "parsed",
        parser: "utf8-text",
        availableAt: snapshotAt,
      }],
      snapshotAt,
      sourceCoverage: {
        detail: { available: true, complete: true, capturedAt: snapshotAt },
        comments: { available: true, complete: true, capturedAt: snapshotAt },
        attachments: { available: true, complete: true, capturedAt: snapshotAt },
      },
    },
  });
  assert.equal(run.ok, true, run.error);
  assert.equal(run.data.prediction.servingRelease.status, "legacy_unreleased");
  assert.equal(run.data.prediction.servingRelease.effectiveAutoExecution, false);

  const reviewed = store.reviewConfigInferenceRun("project-release", run.data.id, {
    decision: "corrected",
    correctedPrediction: {
      status: "NEED_HUMAN_CONFIRMATION",
      targets: [{
        appName: "应用市场",
        vehicle: "测试车型",
        repositoryId: "market",
        branch: "release/base",
        flavor: "demoProd",
        targetRole: "primary",
        order: 1,
      }],
    },
    rating: 5,
    reviewer: "annotator-release",
  });
  assert.equal(reviewed.ok, true, reviewed.error);
  const first = store.approveConfigInferenceAnnotation(
    "project-release",
    reviewed.sample.id,
    { reviewer: "release-reviewer-a", reason: "第一位独立评审" },
  );
  assert.equal(first.ok, true, first.error);
  const second = store.approveConfigInferenceAnnotation(
    "project-release",
    reviewed.sample.id,
    { reviewer: "release-reviewer-b", reason: "第二位独立评审" },
  );
  assert.equal(second.ok, true, second.error);
  assert.equal(second.data.servingStatus, "approved");
  const approvedSampleIds = [reviewed.sample.id];
  for (let index = 2; index <= 7; index++) {
    const caseSnapshotAt = `2026-07-${String(19 + index).padStart(2, "0")}T00:00:00.000Z`;
    const extraRun = store.runConfigInference("project-release", {
      captureSignals: false,
      ticket: {
        ticketId: `CASE-RELEASE-${index}`,
        projectId: "project-release",
        title: `应用市场启动失败 场景-${index}`,
        snapshotAt: caseSnapshotAt,
        sourceCoverage: {
          detail: { available: true, complete: true, capturedAt: caseSnapshotAt },
        },
      },
    });
    assert.equal(extraRun.ok, true, extraRun.error);
    const extraReview = store.reviewConfigInferenceRun("project-release", extraRun.data.id, {
      decision: "corrected",
      correctedPrediction: {
        targets: [{
          appName: "应用市场",
          vehicle: "测试车型",
          repositoryId: "market",
          branch: "release/base",
          flavor: "demoProd",
          targetRole: "primary",
          order: 1,
        }],
      },
      rating: 5,
      reviewer: `annotator-release-${index}`,
    });
    assert.equal(extraReview.ok, true, extraReview.error);
    const extraFirst = store.approveConfigInferenceAnnotation(
      "project-release",
      extraReview.sample.id,
      { reviewer: `release-reviewer-a-${index}`, reason: "第一位独立评审" },
    );
    assert.equal(extraFirst.ok, true, extraFirst.error);
    const extraSecond = store.approveConfigInferenceAnnotation(
      "project-release",
      extraReview.sample.id,
      { reviewer: `release-reviewer-b-${index}`, reason: "第二位独立评审" },
    );
    assert.equal(extraSecond.ok, true, extraSecond.error);
    approvedSampleIds.push(extraReview.sample.id);
  }

  const rawUpload = store.createConfigInferenceDataset("project-release", {
    cases: [{ id: "forged", approvedLabel: { status: "approved" } }],
    operator: "release-admin",
    reason: "尝试绕过内部 annotation",
  });
  assert.equal(rawUpload.ok, false);

  const dataset = store.createConfigInferenceDataset("project-release", {
    datasetVersion: "golden-release-test",
    caseRefs: approvedSampleIds.map((sampleId) => ({ sampleId })),
    operator: "release-admin",
    reason: "冻结双审样本",
  });
  assert.equal(dataset.ok, true, dataset.error);
  assert.equal(dataset.data.validation.ok, true);
  assert.ok(dataset.data.validation.splitCounts.dev > 0);
  assert.ok(dataset.data.validation.splitCounts.test > 0);
  assert.equal(dataset.data.cases[0].approvedLabel.reviewerIds.length, 2);
  assert.equal(dataset.data.cases[0].evidence[0].sourceType, "detail");
  assert.equal(Object.hasOwn(dataset.data.cases[0], "prediction"), false);
  assert.equal(dataset.data.cases[0].ticket.ticketId, "CASE-RELEASE-1");
  assert.equal(dataset.data.evaluationMode, "candidate_replay_v1");
  assert.ok(dataset.data.servingSampleRevision);
  assert.match(dataset.data.cases[0].ticket.description, /\[REDACTED_SECRET\]/);
  assert.match(dataset.data.cases[0].ticket.description, /\[REDACTED_MACHINE_PATH\]/);
  assert.match(dataset.data.cases[0].ticket.comments, /\[REDACTED_SECRET\]/);
  assert.equal(Object.hasOwn(dataset.data.cases[0].ticket.attachments[0], "text"), false);
  assert.equal(Object.hasOwn(dataset.data.cases[0].ticket.attachments[0], "downloadUrl"), false);

  const rawShared = (await import("../db/sqlite.js"))
    .getUserData("__devbench_shared__", "shared");
  const rawSerialized = JSON.stringify(
    rawShared.byProject["project-release"].aiTraining.configInference,
  );
  for (const forbidden of [
    "hunter2",
    "ATTACHMENT-SECRET",
    "COMMENT-SECRET",
    "RAW-URL-SECRET",
    "BODY-ONLY-MARKER",
    "C:\\\\Users\\\\alice\\\\secret.txt",
    "alice@example.com",
    "13800138000",
  ]) {
    assert.equal(rawSerialized.includes(forbidden), false, `共享存储泄漏 ${forbidden}`);
  }

  const evaluation = store.evaluateConfigInferenceDatasetRelease("project-release", {
    datasetId: dataset.data.id,
    split: "test",
    operator: "release-admin",
    reason: "独立 test 评测",
  });
  assert.equal(evaluation.ok, true, evaluation.error);
  assert.equal(evaluation.data.validation.ok, true);
  assert.equal(evaluation.data.evaluationMode, "candidate_replay_v1");
  assert.equal(evaluation.data.candidateReplay.predictor, "inferConfigFromTicket");
  assert.equal(evaluation.data.candidateReplay.trainingSplitOnly, true);
  assert.equal(evaluation.data.candidateReplay.sourceDatasetHash, dataset.data.hash);
  assert.equal(evaluation.data.gate.canaryReady, false);

  const release = store.createConfigInferenceServingRelease("project-release", {
    datasetId: dataset.data.id,
    evaluationId: evaluation.data.id,
    operator: "release-admin",
    reason: "创建不可激活的门禁草稿",
  });
  assert.equal(release.ok, true, release.error);
  assert.equal(release.data.release.status, "draft");
  assert.equal(release.data.artifact.candidateTraining.trainingSplitOnly, true);
  assert.ok(release.data.artifact.candidateTraining.trainingCaseIds.length > 0);
  assert.equal(
    release.data.artifact.candidateTraining.trainingCaseIds.length,
    release.data.artifact.candidateTraining.approvedLabelFingerprints.length,
  );

  const blocked = store.transitionConfigInferenceServingRelease(
    "project-release",
    release.data.release.id,
    {
      status: "shadow",
      operator: "release-admin",
      reason: "样本不足时不得进入 shadow",
    },
  );
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, "CONFIG_INFERENCE_RELEASE_SCOPE_REQUIRED");
  assert.equal(store.listConfigInferenceServingReleases("project-release").data.serving.status, "legacy_unreleased");

  const shadow = store.transitionConfigInferenceServingRelease(
    "project-release",
    release.data.release.id,
    {
      status: "shadow",
      approvedVehicles: ["测试车型"],
      operator: "release-admin",
      reason: "进入仅双算、不改变用户结果的 shadow",
    },
  );
  assert.equal(shadow.ok, true, shadow.error);
  assert.equal(shadow.data.release.status, "shadow");
  assert.deepEqual(shadow.data.release.rolloutPolicy.approvedVehicles, ["测试车型"]);

  const shadowRun = store.runConfigInference("project-release", {
    captureSignals: false,
    ticket: {
      ticketId: "CASE-RELEASE-SHADOW-1",
      projectId: "project-release",
      title: "应用市场启动失败",
    },
  });
  assert.equal(shadowRun.ok, true, shadowRun.error);
  assert.equal(shadowRun.data.releaseTrial.releaseId, release.data.release.id);
  assert.equal(shadowRun.data.releaseTrial.selected, true);
  assert.ok(shadowRun.data.releaseTrial.candidatePrediction);
  assert.equal(
    shadowRun.data.releaseTrial.candidateTrainingHash,
    release.data.artifact.candidateTraining.materialHash,
  );
  const shadowReview = store.reviewConfigInferenceRun("project-release", shadowRun.data.id, {
    decision: "corrected",
    correctedPrediction: {
      targets: [{
        appName: "应用市场",
        vehicle: "测试车型",
        repositoryId: "market",
        branch: "release/base",
        flavor: "demoProd",
        targetRole: "primary",
        order: 1,
      }],
    },
    rating: 5,
    reviewer: "shadow-reviewer",
  });
  assert.equal(shadowReview.ok, true, shadowReview.error);
  const beforeApproval = store.listConfigInferenceServingReleases("project-release")
    .data.releases.find((row) => row.id === release.data.release.id);
  assert.equal((beforeApproval.onlineObservations || []).length, 0, "首次复核不能提前污染 online gate");
  const shadowVote = {
    decision: shadowReview.sample.feedback.decision,
    noTargets: shadowReview.sample.groundTruth.noTargets === true,
    targets: shadowReview.sample.groundTruth.targets,
  };
  const firstShadowApproval = store.approveConfigInferenceAnnotation(
    "project-release",
    shadowReview.sample.id,
    { reviewer: "shadow-reviewer-a", reason: "第一位 shadow 评审", vote: shadowVote },
  );
  assert.equal(firstShadowApproval.ok, true, firstShadowApproval.error);
  assert.equal(firstShadowApproval.requiresMoreReviewers, true);
  const secondShadowApproval = store.approveConfigInferenceAnnotation(
    "project-release",
    shadowReview.sample.id,
    { reviewer: "shadow-reviewer-b", reason: "第二位 shadow 评审", vote: shadowVote },
  );
  assert.equal(secondShadowApproval.ok, true, secondShadowApproval.error);
  assert.ok(secondShadowApproval.releaseObservation);
  const observedRelease = store.listConfigInferenceServingReleases("project-release")
    .data.releases.find((row) => row.id === release.data.release.id);
  assert.equal(observedRelease.onlineObservations.length, 1);
  assert.equal(observedRelease.onlineObservations[0].runId, shadowRun.data.id);
  assert.equal(observedRelease.onlineObservations[0].eligible, true);
  assert.equal(observedRelease.onlineObservations[0].reviewerIds.length, 2);
  assert.ok(observedRelease.onlineObservations[0].caseFingerprint);
  assert.equal(typeof observedRelease.onlineObservations[0].candidateExact, "boolean");
  assert.equal(observedRelease.onlineGate.ready, false);
  assert.ok(observedRelease.onlineGate.reasons.includes("online_sample_insufficient"));
  const postApprovalRun = store.runConfigInference("project-release", {
    captureSignals: false,
    ticket: {
      ticketId: "CASE-RELEASE-SHADOW-2",
      projectId: "project-release",
      title: "应用市场第二条 shadow 工单",
    },
  });
  assert.equal(postApprovalRun.ok, true, postApprovalRun.error);
  assert.equal(postApprovalRun.data.releaseTrial?.releaseId, release.data.release.id);
  assert.equal(
    postApprovalRun.data.releaseTrial?.candidateTrainingHash,
    release.data.artifact.candidateTraining.materialHash,
  );
});

test("shadow 在线门禁要求 200 个跨 14 天观测、批准车型覆盖且候选不回退", () => {
  const startedAt = Date.UTC(2026, 6, 1);
  const duration = 14 * 24 * 60 * 60 * 1000;
  const observations = Array.from({ length: 200 }, (_value, index) => ({
    schemaVersion: "config-inference-release-observation-v1",
    id: `OBS-${index}`,
    releaseId: "REL-ONLINE",
    artifactId: "ART-ONLINE",
    runId: `RUN-${index}`,
    caseFingerprint: `CASE-${index}`,
    approvedLabelFingerprint: `LABEL-${index}`,
    reviewerIds: ["reviewer-a", "reviewer-b"],
    stage: "shadow",
    trafficPercent: 0,
    selected: true,
    eligible: true,
    baselineExact: true,
    candidateExact: true,
    regressed: false,
    sourcePolicyViolation: false,
    vehiclePolicyViolation: false,
    vehicles: ["测试车型"],
    observedAt: startedAt + Math.round(duration * index / 199),
  }));
  const release = {
    id: "REL-ONLINE",
    artifactId: "ART-ONLINE",
    projectId: "project-release",
    status: "shadow",
    trafficPercent: 0,
    rolloutPolicy: {
      stage: "shadow",
      trafficPercent: 0,
      stageStartedAt: startedAt,
      approvedVehicles: ["测试车型"],
    },
    onlineObservations: observations,
  };
  const passed = store.__testEvaluateConfigInferenceOnlineReleaseGate(release, {
    now: startedAt + duration,
  });
  assert.equal(passed.ready, true, passed.reasons.join(","));
  assert.equal(passed.eligibleCases, 200);
  assert.equal(passed.candidateExactRate, 1);

  const replayed = store.__testEvaluateConfigInferenceOnlineReleaseGate({
    ...release,
    onlineObservations: observations.map((row) => ({ ...row, caseFingerprint: "SAME-TB-TASK" })),
  }, { now: startedAt + duration });
  assert.equal(replayed.ready, false);
  assert.equal(replayed.eligibleCases, 1);
  assert.ok(replayed.reasons.includes("online_sample_insufficient"));

  const tooFast = store.__testEvaluateConfigInferenceOnlineReleaseGate({
    ...release,
    onlineObservations: observations.map((row) => ({
      ...row,
      observedAt: startedAt + Math.min(24 * 60 * 60 * 1000, row.observedAt - startedAt),
    })),
  }, { now: startedAt + duration });
  assert.equal(tooFast.ready, false);
  assert.ok(tooFast.reasons.includes("online_duration_insufficient"));

  const regressed = store.__testEvaluateConfigInferenceOnlineReleaseGate({
    ...release,
    onlineObservations: observations.map((row, index) => index === 199 ? {
      ...row,
      candidateExact: false,
      regressed: true,
    } : row),
  }, { now: startedAt + duration });
  assert.equal(regressed.ready, false);
  assert.ok(regressed.reasons.includes("candidate_regression"));
  assert.ok(regressed.reasons.includes("candidate_accuracy_below_baseline"));
});
