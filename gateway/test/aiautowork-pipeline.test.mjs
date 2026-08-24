// AI 工作台 — 单 TaskDraft 端到端 pipeline 测试。
// 验证：状态机推进、候选落库、issues 写入、快照、StoryPoint 幂等。

import { test } from "node:test";
import assert from "node:assert/strict";
import db from "../db/sqlite.js";
import * as store from "../services/aiautowork/store.js";
import pipeline from "../services/aiautowork/pipeline.js";
import { AiautoworkError, ERROR_CODES } from "../services/aiautowork/error-codes.js";

function makeDraft(over = {}) {
  const unique = `m2-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return store.createTaskDraft({
    sourceType: "MANUAL",
    sourceRef: unique,
    normalizedInput: {
      title: `M2 pipeline test ${unique}`,
      description: "端到端冒烟",
      fields: { projectName: "demo-app", targetBranch: "main", buildFlavor: "debug" },
      refs: ["M2", "smoke"],
    },
    configHash: "ch-" + unique,
    policyVersion: "1",
    ...over,
  });
}

function cleanupDraft(id) {
  try {
    db.prepare("DELETE FROM validation_issues WHERE task_draft_id = ?").run(id);
    db.prepare("DELETE FROM config_candidate_attempts WHERE task_draft_id = ?").run(id);
    db.prepare("DELETE FROM resolved_config_snapshots WHERE task_draft_id = ?").run(id);
    db.prepare("DELETE FROM story_points WHERE task_draft_id = ?").run(id);
    db.prepare("DELETE FROM config_audit_events WHERE target_id = ? AND target_type = 'task_draft'").run(id);
    db.prepare("DELETE FROM task_drafts WHERE id = ?").run(id);
  } catch {}
}

test("deriveCandidate：确定性 + 指纹稳定", () => {
  const draft = makeDraft();
  try {
    const c1 = pipeline.deriveCandidate(draft);
    const c2 = pipeline.deriveCandidate(draft);
    assert.equal(c1.fingerprint, c2.fingerprint);
    assert.ok(c1.signals.overall >= 60 && c1.signals.overall <= 100);
    assert.ok(c1.signals.criticalMin <= c1.signals.overall);
    assert.ok(Array.isArray(c1.decisions));
    assert.ok(c1.decisions.length > 0);
    assert.ok(c1.fields.projectName);
  } finally {
    cleanupDraft(draft.id);
  }
});

test("validateCandidate：必填缺一抛 blocker", () => {
  const issues = pipeline.validateCandidate({
    fields: { projectName: "x" /* targetBranch, buildFlavor 缺 */ },
    decisions: [],
  });
  const blockers = issues.filter((i) => i.severity === "blocker");
  assert.ok(blockers.length >= 2);
  assert.ok(blockers.some((i) => i.field_key === "targetBranch"));
});

test("decideRoute：高分 → AUTO_READY；blocking → MANUAL", () => {
  const r1 = pipeline.decideRoute({}, { signals: { overall: 95, criticalMin: 80 } }, []);
  assert.equal(r1.target, "AUTO_READY");
  const r2 = pipeline.decideRoute({}, { signals: { overall: 80, criticalMin: 70 } }, []);
  assert.ok(["AUTO_READY", "GROUP_CONFIRM_REQUIRED"].includes(r2.target));
  const r3 = pipeline.decideRoute({}, { signals: { overall: 95, criticalMin: 80 } }, [{ severity: "blocker" }]);
  assert.equal(r3.target, "MANUAL_INTERVENTION_REQUIRED");
});

test("inferTaskDraft：INPUT_PARSED → CANDIDATE_GENERATED 且写入候选", () => {
  const draft = makeDraft();
  try {
    const before = store.getTaskDraft(draft.id);
    assert.equal(before.status, "INPUT_PARSED");
    const r = pipeline.inferTaskDraft(draft.id);
    assert.equal(r.draft.status, "CANDIDATE_GENERATED");
    assert.ok(r.candidate.id);
    assert.equal(r.candidate.status, "generated");
    assert.equal(r.candidate.taskDraftId, draft.id);
    assert.ok(r.candidate.scoreOverall >= 60);
    assert.ok(r.candidate.candidateJson || r.candidate.candidate);
    const after = store.getTaskDraft(draft.id);
    assert.ok(after.configFingerprint);
  } finally {
    cleanupDraft(draft.id);
  }
});

test("validateTaskDraft：CANDIDATE_GENERATED → SELF_CHECKING → 路由分桶", () => {
  const draft = makeDraft();
  try {
    const r1 = pipeline.inferTaskDraft(draft.id);
    const r2 = pipeline.validateTaskDraft(draft.id, { candidateId: r1.candidate.id });
    assert.equal(r2.draft.status, r2.route.target);
    assert.ok(["AUTO_READY", "GROUP_CONFIRM_REQUIRED", "MANUAL_INTERVENTION_REQUIRED"].includes(r2.route.target));
    // issues 列表
    const issues = store.listValidationIssues({ taskDraftId: draft.id });
    assert.ok(Array.isArray(issues));
  } finally {
    cleanupDraft(draft.id);
  }
});

test("snapshotTaskDraft：仅 AUTO_READY/GROUP_CONFIRM_REQUIRED 可快照", () => {
  const draft = makeDraft();
  try {
    // INPUT_PARSED 状态禁止
    let caught = null;
    try { pipeline.snapshotTaskDraft(draft.id); } catch (e) { caught = e; }
    assert.ok(caught);
    assert.equal(caught.code, ERROR_CODES.INVALID_STATE_TRANSITION);

    pipeline.inferTaskDraft(draft.id);
    pipeline.validateTaskDraft(draft.id);
    const snap = pipeline.snapshotTaskDraft(draft.id);
    assert.ok(snap.snapshot.id);
    assert.ok(snap.snapshot.fingerprint);
  } finally {
    cleanupDraft(draft.id);
  }
});

test("createStoryPointFromTaskDraft：幂等 + 终态 CREATED", () => {
  const draft = makeDraft();
  try {
    pipeline.inferTaskDraft(draft.id);
    pipeline.validateTaskDraft(draft.id);
    const r1 = pipeline.createStoryPointFromTaskDraft(draft.id);
    assert.equal(r1.storyPoint.status, "CREATED");
    assert.ok(r1.storyPoint.devbenchStoryId);
    assert.equal(r1.idempotent, false);
    const r2 = pipeline.createStoryPointFromTaskDraft(draft.id);
    assert.equal(r2.idempotent, true);
    assert.equal(r2.storyPoint.id, r1.storyPoint.id);
    const finalDraft = store.getTaskDraft(draft.id);
    assert.equal(finalDraft.status, "CREATED");
    assert.ok(finalDraft.finalizedAt);
  } finally {
    cleanupDraft(draft.id);
  }
});

test("runFullPipeline：一条命令走完整链路", () => {
  const draft = makeDraft();
  try {
    const r = pipeline.runFullPipeline(draft.id);
    assert.equal(r.draft.status, "CREATED");
    assert.ok(r.candidate && r.candidate.id);
    assert.ok(r.route);
    assert.ok(r.snapshot && r.snapshot.id);
    assert.ok(r.storyPoint && r.storyPoint.id);
  } finally {
    cleanupDraft(draft.id);
  }
});

test("状态机：禁止越级切换", () => {
  const draft = makeDraft();
  try {
    // INPUT_PARSED 直接 snapshot 应抛 INVALID_STATE_TRANSITION
    let caught = null;
    try { pipeline.snapshotTaskDraft(draft.id); } catch (e) { caught = e; }
    assert.ok(caught);
    assert.equal(caught.code, ERROR_CODES.INVALID_STATE_TRANSITION);
  } finally {
    cleanupDraft(draft.id);
  }
});

test("缺 sourceType 创建 TaskDraft 抛 INVALID_INPUT", () => {
  let caught = null;
  try { store.createTaskDraft({}); } catch (e) { caught = e; }
  assert.ok(caught);
  assert.equal(caught.code, ERROR_CODES.INVALID_INPUT);
});

test("TaskDraft 不存在抛 NOT_FOUND 404", () => {
  let caught = null;
  try { pipeline.inferTaskDraft("td_does_not_exist_zzz"); } catch (e) { caught = e; }
  assert.ok(caught);
  assert.equal(caught.code, ERROR_CODES.NOT_FOUND);
  assert.equal(caught.httpStatus, 404);
});