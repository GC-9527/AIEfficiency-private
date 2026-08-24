// AI 工作台 — 单 TaskDraft 端到端 pipeline。
// 状态机（21 个状态中，单 draft 顺序推进用 9 个）：
//   INPUT_PARSED → QUEUED_FOR_INFERENCE → INFERENCING → CANDIDATE_GENERATED
//                → SELF_CHECKING → {AUTO_READY | GROUP_CONFIRM_REQUIRED | MANUAL_INTERVENTION_REQUIRED}
//                → READY_TO_CREATE → CREATING → CREATED
//
// 规则：
//   - 真实推进：DB 写入即事实来源；不允许 setTimeout 模拟成功。
//   - 单 draft 顺序跑（不进入 execution_queue 并发池）；批量 (M3) 才走 4 类池。
//   - 幂等：createStoryPointFromTaskDraft 用 task_draft_id|fingerprint|snapshotId 做 idempotency_key。
//   - 确定性推导（不用 LLM）：从 normalizedInput 字段直接生成候选，方便 M9 测试复现。
//   - 状态切换失败抛 AiautoworkError(code=INVALID_STATE_TRANSITION)。

import db from "../../db/sqlite.js";
import { createHash, randomUUID } from "node:crypto";
import * as store from "./store.js";
import * as settings from "./settings.js";
import acceptanceService from "../acceptance/service.js";
import { AiautoworkError, ERROR_CODES } from "./error-codes.js";

// StoryPoint status enum（与 schema 注释一致）：全大写。
// TaskDraft status：驼峰。
const ALLOWED_TRANSITIONS = {
  INPUT_PARSED: ["QUEUED_FOR_INFERENCE", "INVALID_INPUT"],
  QUEUED_FOR_INFERENCE: ["INFERENCING", "INVALID_INPUT"],
  INFERENCING: ["CANDIDATE_GENERATED", "REPAIRING", "MANUAL_INTERVENTION_REQUIRED"],
  CANDIDATE_GENERATED: ["SELF_CHECKING"],
  SELF_CHECKING: ["AUTO_READY", "GROUP_CONFIRM_REQUIRED", "MANUAL_INTERVENTION_REQUIRED"],
  AUTO_READY: ["READY_TO_CREATE", "GROUP_CONFIRM_REQUIRED"],
  GROUP_CONFIRM_REQUIRED: ["READY_TO_CREATE", "AUTO_READY", "MANUAL_INTERVENTION_REQUIRED"],
  MANUAL_INTERVENTION_REQUIRED: ["MANUAL_EDITING", "READY_TO_CREATE"],
  MANUAL_EDITING: ["SELF_CHECKING", "READY_TO_CREATE"],
  REPAIRING: ["INFERENCING", "MANUAL_INTERVENTION_REQUIRED"],
  READY_TO_CREATE: ["CREATING", "CANCELLED"],
  CREATING: ["CREATED", "CREATE_FAILED"],
  CREATE_FAILED: ["CREATING", "CANCELLED"],
  CREATED: [],
  INVALID_INPUT: [],
  CANCELLED: [],
};

function assertTransition(from, to) {
  const allowed = ALLOWED_TRANSITIONS[from] || [];
  if (!allowed.includes(to)) {
    throw new AiautoworkError(ERROR_CODES.INVALID_STATE_TRANSITION,
      `不允许的状态切换 ${from} → ${to}`,
      { httpStatus: 409, details: { from, to, allowed } });
  }
}

function newId(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function sha(s) {
  return "sha256:" + createHash("sha256").update(String(s)).digest("hex");
}

function ensureDraft(id) {
  const draft = store.getTaskDraft(id);
  if (!draft) {
    throw new AiautoworkError(ERROR_CODES.NOT_FOUND, "TaskDraft 不存在", { httpStatus: 404, details: { id } });
  }
  return draft;
}

// ============ 确定性 AI 推导（stub，M4 接真实 LLM）============
// 输入：normalizedInput = { title, description?, fields?, refs?, ... }
// 输出：candidate = { fingerprint, decisions[], fields{}, signals{} }
export function deriveCandidate(draft) {
  const ni = draft.normalizedInput || {};
  const title = String(ni.title || "untitled");
  const desc = String(ni.description || "");
  const refs = Array.isArray(ni.refs) ? ni.refs : [];
  const explicitFields = (ni.fields && typeof ni.fields === "object") ? ni.fields : {};

  const defaultFields = {
    projectName: title.slice(0, 60),
    description: desc.slice(0, 240) || title,
    targetBranch: "main",
    buildFlavor: "debug",
    priority: "normal",
    tags: refs.length ? refs.slice(0, 5) : ["aiautowork"],
  };
  const fields = { ...defaultFields, ...explicitFields };

  const decisions = Object.keys(fields).map((k) => ({
    field_key: k,
    action: "adopt",
    confidence: 0.85,
    source: "default",
    locked: false,
  }));

  const fpMaterial = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join("|");
  const fingerprint = sha(fpMaterial);

  const fieldCount = Object.keys(fields).length;
  const lenScore = Math.min(40, title.length);
  const fieldScore = Math.min(40, fieldCount * 5);
  const descScore = desc ? 10 : 0;
  const overall = Math.min(100, 60 + lenScore / 6 + fieldScore / 4 + descScore);
  const critical = Math.max(0, Math.min(100, overall - 8));
  return {
    fingerprint,
    fields,
    decisions,
    signals: {
      overall: Math.round(overall),
      criticalMin: Math.round(critical),
      fieldScores: Object.fromEntries(Object.keys(fields).map((k) => [k, 0.85])),
      evidenceCoverage: desc ? 0.9 : 0.6,
      deterministicCheck: 1.0,
      independentAgreement: 0.85,
      metadataValidity: 1.0,
    },
    autoFixableCount: 0,
    blockerCount: 0,
  };
}

// ============ 确定性校验 ============
const REQUIRED_FIELDS = ["projectName", "targetBranch", "buildFlavor"];
export function validateCandidate(candidate) {
  const issues = [];
  for (const req of REQUIRED_FIELDS) {
    if (!candidate.fields || candidate.fields[req] == null || candidate.fields[req] === "") {
      issues.push({
        severity: "blocker",
        code: "MISSING_REQUIRED_FIELD",
        field_key: req,
        message: `缺少必填字段 ${req}`,
        auto_fixable: false,
      });
    }
  }
  for (const d of candidate.decisions || []) {
    if (typeof d.confidence === "number" && d.confidence < 0.6) {
      issues.push({
        severity: "error",
        code: "LOW_CONFIDENCE",
        field_key: d.field_key,
        message: `字段 ${d.field_key} 置信度 ${d.confidence} < 0.6`,
        auto_fixable: true,
        fix_strategy: "fallback_default",
      });
    }
  }
  return issues;
}

// 路由决策
export function decideRoute(draft, candidate, issues) {
  const blocking = issues.filter((i) => i.severity === "blocker").length;
  const scores = candidate.signals || {};
  const thr = settings.getRoutingThresholds();
  if (blocking > 0) {
    return { target: "MANUAL_INTERVENTION_REQUIRED", reason: `blocking issues=${blocking}` };
  }
  const overall = scores.overall || 0;
  const critical = scores.criticalMin || 0;
  if (overall >= thr.autoReadyOverall && critical >= thr.autoReadyCriticalMin) {
    return { target: "AUTO_READY", reason: `overall=${overall} criticalMin=${critical} hit autoReady` };
  }
  if (overall >= thr.groupConfirmOverallMin && critical >= thr.manualCriticalMax) {
    return { target: "GROUP_CONFIRM_REQUIRED", reason: `overall=${overall} in group range` };
  }
  return { target: "MANUAL_INTERVENTION_REQUIRED", reason: `overall=${overall} criticalMin=${critical} too low` };
}

// ============ 推进函数（每步都落库）============
export function inferTaskDraft(id) {
  const draft = ensureDraft(id);
  assertTransition(draft.status, "QUEUED_FOR_INFERENCE");
  store.updateTaskDraft(id, { status: "QUEUED_FOR_INFERENCE" });
  assertTransition("QUEUED_FOR_INFERENCE", "INFERENCING");
  store.updateTaskDraft(id, { status: "INFERENCING" });

  const candidate = deriveCandidate(draft);
  const version = (store.listCandidateAttempts(id).length || 0) + 1;

  // createCandidateAttempt 只接受 4 个字段；其余用 updateCandidateAttempt 落库
  const candRow = store.createCandidateAttempt({
    taskDraftId: id,
    version,
    inferrerEngine: "deterministic-stub",
    inferrerModel: "aiautowork-v1",
  });
  store.updateCandidateAttempt(candRow.id, {
    status: "generated",
    signals: candidate.signals,
    decisions: candidate.decisions,
    candidate: candidate.fields,
    evidence: { fingerprint: candidate.fingerprint, derivedAt: new Date().toISOString() },
    scoreOverall: candidate.signals.overall,
    scoreCriticalMinimum: candidate.signals.criticalMin,
    autoFixableCount: candidate.autoFixableCount,
    blockerCount: candidate.blockerCount,
    finishedAt: new Date().toISOString(),
  });

  store.updateTaskDraft(id, {
    status: "CANDIDATE_GENERATED",
    configFingerprint: candidate.fingerprint,
  });

  // 重新读 candidate 返回完整数据
  return {
    draft: store.getTaskDraft(id),
    candidate: { ...store.getCandidateAttempt(candRow.id), fingerprint: candidate.fingerprint },
  };
}

export function validateTaskDraft(id, { candidateId } = {}) {
  const draft = ensureDraft(id);
  assertTransition(draft.status, "SELF_CHECKING");
  store.updateTaskDraft(id, { status: "SELF_CHECKING" });

  let candidateRow;
  if (candidateId) {
    candidateRow = store.getCandidateAttempt(candidateId);
  } else {
    const list = store.listCandidateAttempts(id);
    candidateRow = list.find((c) => c.status === "generated") || list[0];
  }
  if (!candidateRow) {
    throw new AiautoworkError(ERROR_CODES.INTERNAL_ERROR, "无可校验候选", { httpStatus: 409 });
  }

  const candidate = {
    fields: candidateRow.candidate || {},
    decisions: candidateRow.decisions || [],
    signals: candidateRow.signals || {},
  };
  const issues = validateCandidate(candidate);

  // 清旧 issues（仅本 draft 的）
  const existing = store.listValidationIssues({ taskDraftId: id });
  for (const it of existing) {
    db.prepare("DELETE FROM validation_issues WHERE id = ?").run(it.id);
  }
  for (const i of issues) {
    store.createValidationIssue({
      taskDraftId: id,
      candidateId: candidateRow.id,
      stage: "validator",
      severity: i.severity,
      code: i.code,
      fieldKey: i.field_key,
      message: i.message,
      autoFixable: i.auto_fixable ? 1 : 0,
      fixStrategy: i.fix_strategy,
    });
  }

  const route = decideRoute(draft, candidate, issues);
  store.updateTaskDraft(id, { status: route.target });
  return {
    draft: store.getTaskDraft(id),
    route,
    issueCount: issues.length,
    blockerCount: issues.filter((i) => i.severity === "blocker").length,
  };
}

export function snapshotTaskDraft(id, { actor = "AI" } = {}) {
  const draft = ensureDraft(id);
  if (!["AUTO_READY", "GROUP_CONFIRM_REQUIRED"].includes(draft.status)) {
    throw new AiautoworkError(ERROR_CODES.INVALID_STATE_TRANSITION,
      `当前状态 ${draft.status} 不允许生成快照`,
      { httpStatus: 409 });
  }
  const list = store.listCandidateAttempts(id);
  const candRow = list.find((c) => c.status === "generated") || list[0];
  if (!candRow) {
    throw new AiautoworkError(ERROR_CODES.INTERNAL_ERROR, "无可快照候选", { httpStatus: 409 });
  }
  const snap = store.createSnapshot({
    taskDraftId: id,
    candidateId: candRow.id,
    fingerprint: draft.configFingerprint,
    decisions: candRow.decisions || {},
    evidence: candRow.evidence || {},
    snapshot: candRow.candidate || {},
    scoreOverall: candRow.scoreOverall,
    createdBy: actor,
  });
  store.addAuditEvent({
    actor,
    action: "snapshot_created",
    targetType: "task_draft",
    targetId: id,
    after: { snapshotId: snap.id, fingerprint: snap.fingerprint },
    reason: "single draft pipeline snapshot",
  });
  return { snapshot: snap };
}

export function createStoryPointFromTaskDraft(id, { actor = "AI" } = {}) {
  const draft = ensureDraft(id);
  const canCreate = ["AUTO_READY", "GROUP_CONFIRM_REQUIRED", "MANUAL_INTERVENTION_REQUIRED"].includes(draft.status);

  let snapshots = store.listSnapshotsByTaskDraft(id);
  let snap = snapshots[0];
  if (!snap) {
    if (!canCreate) {
      throw new AiautoworkError(ERROR_CODES.INVALID_STATE_TRANSITION,
        `当前状态 ${draft.status} 不允许创建故事点`,
        { httpStatus: 409 });
    }
    snap = snapshotTaskDraft(id, { actor }).snapshot;
  }

  const idempotencyKey = sha(`story:${id}|${draft.configFingerprint || ""}|${snap.id}`);
  const existing = store.getStoryPointByIdempotencyKey(idempotencyKey);
  if (existing) {
    acceptanceService.registerRuntimeStoryPointFromDraft({ draft, snapshot: snap, storyPoint: existing });
    return { storyPoint: existing, snapshot: snap, idempotent: true };
  }
  if (!canCreate) {
    throw new AiautoworkError(ERROR_CODES.INVALID_STATE_TRANSITION,
      `当前状态 ${draft.status} 不允许创建故事点`,
      { httpStatus: 409 });
  }

  assertTransition(draft.status, "READY_TO_CREATE");
  store.updateTaskDraft(id, { status: "READY_TO_CREATE" });
  assertTransition("READY_TO_CREATE", "CREATING");
  store.updateTaskDraft(id, { status: "CREATING" });

  // createStoryPoint 默认 PENDING；立刻 update 切到 CREATING → CREATED
  const sp = store.createStoryPoint({
    taskDraftId: id,
    idempotencyKey,
  });
  store.updateStoryPoint(sp.id, { status: "CREATING" });
  let updated;
  let devbenchStoryId;
  try {
    // 双轨验收 Phase 0：在故事点变成 CREATED 前，先冻结来源事实包并持久化路由。
    // 此处不运行门禁、不推进来源工单，也不改变旧业务完成判定。
    acceptanceService.registerRuntimeStoryPointFromDraft({ draft, snapshot: snap, storyPoint: sp });
    devbenchStoryId = `devbench_${newId("sp").replace(/^sp_/, "")}`;
    updated = store.updateStoryPoint(sp.id, {
      status: "CREATED",
      devbenchStoryId,
      finalizedAt: new Date().toISOString(),
    });
  } catch (error) {
    const message = `StoryPoint 来源规范化失败：${String(error?.message || error)}`;
    store.updateStoryPoint(sp.id, { status: "CREATE_FAILED", errorMessage: message });
    store.updateTaskDraft(id, { status: "CREATE_FAILED" });
    throw new AiautoworkError(ERROR_CODES.STORY_POINT_CREATE_FAILED, message, {
      httpStatus: 500,
      cause: error,
    });
  }
  store.updateTaskDraft(id, { status: "CREATED", finalizedAt: new Date().toISOString() });
  store.addAuditEvent({
    actor,
    action: "story_point_created",
    targetType: "task_draft",
    targetId: id,
    after: { storyPointId: updated.id, devbenchStoryId, snapshotId: snap.id, idempotencyKey },
    reason: "single draft pipeline create-story",
  });
  return { storyPoint: updated, snapshot: snap, idempotent: false };
}

// 一次跑完全流程（测试 & 手动触发）
export function runFullPipeline(id, { actor = "AI" } = {}) {
  const step1 = inferTaskDraft(id);
  const step2 = validateTaskDraft(id, { candidateId: step1.candidate.id });
  let snapshot = null;
  if (["AUTO_READY", "GROUP_CONFIRM_REQUIRED"].includes(step2.draft.status)) {
    snapshot = snapshotTaskDraft(id, { actor }).snapshot;
  }
  let storyPoint = null;
  if (["AUTO_READY", "GROUP_CONFIRM_REQUIRED", "MANUAL_INTERVENTION_REQUIRED"].includes(step2.draft.status)) {
    const r = createStoryPointFromTaskDraft(id, { actor });
    storyPoint = r.storyPoint;
  }
  return {
    candidate: step1.candidate,
    route: step2.route,
    issueCount: step2.issueCount,
    blockerCount: step2.blockerCount,
    snapshot,
    storyPoint,
    draft: store.getTaskDraft(id),
  };
}

export default {
  inferTaskDraft,
  validateTaskDraft,
  snapshotTaskDraft,
  createStoryPointFromTaskDraft,
  runFullPipeline,
  deriveCandidate,
  validateCandidate,
  decideRoute,
};
