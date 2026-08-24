import assert from "node:assert/strict";
import test from "node:test";

import {
  adjudicateConfigInferenceAnnotations,
  createApprovedConfigInferenceLabel,
  previewAnnotationImpact,
} from "../services/devbench/machine-learn/annotation-governance.js";

const target = {
  targetId: "repo:main",
  targetRole: "primary",
  order: 1,
  appName: "AppMarket",
  vehicle: "P162",
  repositoryId: "appmarket",
  branch: "release/p162",
  flavor: "p162ProdRelease",
};

const annotation = (id, reviewerId, overrides = {}) => ({
  id,
  caseId: "CASE-1",
  reviewerId,
  revision: 1,
  status: "annotation",
  decision: "corrected",
  targets: [target],
  sourceGatePassed: true,
  snapshotApplied: true,
  ...overrides,
});

test("两位不同评审员一致时生成可追溯 approved label", () => {
  const adjudication = adjudicateConfigInferenceAnnotations([
    annotation("A1", "U1"),
    annotation("A2", "U2"),
  ]);
  assert.equal(adjudication.status, "approved");
  assert.equal(adjudication.distinctReviewerCount, 2);
  const label = createApprovedConfigInferenceLabel(adjudication, {
    id: "L1",
    approvedAt: "2026-07-29T00:00:00.000Z",
    registryRevision: "registry-3",
  });
  assert.equal(label.status, "approved");
  assert.equal(label.servingEligible, true);
  assert.deepEqual(label.sourceAnnotationIds, ["A1", "A2"]);
  assert.deepEqual(label.reviewerIds, ["U1", "U2"]);
  assert.match(label.fingerprint, /^[a-f0-9]{64}$/);
});

test("同一评审员重复提交不能伪造双人一致", () => {
  const result = adjudicateConfigInferenceAnnotations([
    annotation("A1", "U1", { revision: 1 }),
    annotation("A2", "U1", { revision: 2 }),
  ]);
  assert.equal(result.status, "insufficient_reviewers");
  assert.equal(result.distinctReviewerCount, 1);
});

test("不同标签即使一方达到人数仍要求独立裁决", () => {
  const result = adjudicateConfigInferenceAnnotations([
    annotation("A1", "U1"),
    annotation("A2", "U2"),
    annotation("A3", "U3", {
      targets: [{ ...target, repositoryId: "settings" }],
    }),
  ]);
  assert.equal(result.status, "adjudication_required");
  assert.equal(result.labelGroups.length, 2);
  assert.throws(() => createApprovedConfigInferenceLabel(result), /完成裁决/);
});

test("来源、symbolic、快照和注册表变更门禁阻止进入 approved label", () => {
  const result = adjudicateConfigInferenceAnnotations([
    annotation("A1", "U1", {
      sourceGatePassed: false,
      unresolvedSymbolic: true,
      snapshotApplied: false,
      registryChangeStatus: "pending",
    }),
    annotation("A2", "U2"),
  ]);
  assert.equal(result.status, "blocked");
  assert.deepEqual(
    new Set(result.blockers),
    new Set([
      "SOURCE_GATE_NOT_PASSED",
      "SYMBOLIC_UNRESOLVED",
      "SNAPSHOT_NOT_APPLIED",
      "REGISTRY_CHANGE_NOT_ACTIVE",
    ]),
  );
});

test("未知 decision、正向空目标、缺失 snapshotApplied 和 rejected registry 均 fail closed", () => {
  const unknown = adjudicateConfigInferenceAnnotations([
    annotation("A1", "U1", { decision: "banana" }),
    annotation("A2", "U2", { decision: "banana" }),
  ]);
  assert.equal(unknown.status, "blocked");
  assert.ok(unknown.blockers.includes("DECISION_INVALID"));

  const empty = adjudicateConfigInferenceAnnotations([
    annotation("A3", "U1", {
      targets: [],
      snapshotApplied: undefined,
      registryChangeStatus: "rejected",
    }),
    annotation("A4", "U2", {
      targets: [],
      snapshotApplied: undefined,
      registryChangeStatus: "rejected",
    }),
  ]);
  assert.equal(empty.status, "blocked");
  assert.ok(empty.blockers.includes("TARGET_GRAPH_REQUIRED"));
  assert.ok(empty.blockers.includes("SNAPSHOT_NOT_APPLIED"));
  assert.ok(empty.blockers.includes("REGISTRY_CHANGE_NOT_ACTIVE"));
});

test("approved label 深度不可变，targets 不能在 fingerprint 不变时被篡改", () => {
  const adjudication = adjudicateConfigInferenceAnnotations([
    annotation("A1", "U1"),
    annotation("A2", "U2"),
  ]);
  const label = createApprovedConfigInferenceLabel(adjudication, {
    id: "L_IMMUTABLE",
    approvedAt: "2026-07-29T00:00:00.000Z",
  });
  const fingerprint = label.fingerprint;
  assert.throws(() => {
    label.label.targets[0].repositoryId = "tampered";
  }, /read only|Cannot assign/);
  assert.equal(label.fingerprint, fingerprint);
  assert.equal(label.label.targets[0].repositoryId, "appmarket");
});

test("撤销前影响预览列出 serving、dataset 与 active run 引用", () => {
  const impact = previewAnnotationImpact(annotation("A1", "U1"), {
    servingSamples: [{ id: "S1", sourceAnnotationIds: ["A1"] }],
    datasetCases: [{ id: "D1", annotationId: "A1" }],
    activeRuns: [{ id: "R1", caseId: "CASE-1" }],
  });
  assert.deepEqual(impact.servingSamples, ["S1"]);
  assert.deepEqual(impact.datasetCases, ["D1"]);
  assert.deepEqual(impact.activeRuns, ["R1"]);
});

test("approved label 保留共享稳定 logicalKey，但不携带本机 actualValue", () => {
  const adjudication = adjudicateConfigInferenceAnnotations([
    annotation("A1", "U1"),
    annotation("A2", "U2"),
  ]);
  const label = createApprovedConfigInferenceLabel(adjudication, {
    id: "L_PORTABLE_KEY",
    approvedAt: "2026-07-29T00:00:00.000Z",
    portableTargets: [{
      ...target,
      fieldBindings: {
        branch: {
          logicalKey: "K_CFG_BRANCH_P162",
          actualValue: "D:/private/worktree/feature",
          revision: 17,
        },
      },
    }],
  });
  assert.deepEqual(label.label.targets[0].fieldBindings, {
    branch: { logicalKey: "K_CFG_BRANCH_P162" },
  });
  assert.equal(JSON.stringify(label).includes("D:/private/worktree"), false);
  assert.throws(() => createApprovedConfigInferenceLabel(adjudication, {
    portableTargets: [{ ...target, branch: "feature/other" }],
  }), /目标图不一致/);
});
