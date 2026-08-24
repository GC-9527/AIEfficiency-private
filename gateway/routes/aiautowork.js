// AI Workbench 路由层（HTTP API）。
// 保留下列端点的最小可用骨架；后续里程碑将逐个补完解析/推导/批次/手工/确认/执行逻辑。

import { Router } from "express";
import * as store from "../services/aiautowork/store.js";
import settings from "../services/aiautowork/settings.js";
import pipeline from "../services/aiautowork/pipeline.js";
import acceptanceService from "../services/acceptance/service.js";
import { AiautoworkError, ERROR_CODES } from "../services/aiautowork/error-codes.js";
import { requireAdmin } from "../services/admin-auth.js";

const router = Router();

// 查询端点继续服务于节点/中心概览；所有会改变任务、设置或执行状态的
// HTTP 方法统一使用管理员会话，避免各端点自行解释角色或信任 actor header。
router.use((req, res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  return requireAdmin(req, res, next);
});

// 统一错误处理
function wrap(handler) {
  return (req, res, next) => {
    try {
      const result = handler(req, res, next);
      if (result && typeof result.then === "function") {
        result.then((data) => {
          if (!res.headersSent) res.json({ ok: true, data });
        }).catch(next);
      } else if (!res.headersSent && result !== undefined) {
        res.json({ ok: true, data: result });
      }
    } catch (e) { next(e); }
  };
}

function sendError(res, err) {
  if (err instanceof AiautoworkError) {
    return res.status(err.httpStatus).json(err.toJSON());
  }
  console.error("[aiautowork] unhandled error:", err);
  return res.status(500).json({ ok: false, error: { code: ERROR_CODES.INTERNAL_ERROR, message: String(err.message || err) } });
}

function acceptanceWrap(handler) {
  return wrap((req, res, next) => {
    try {
      return handler(req, res, next);
    } catch (error) {
      if (error instanceof TypeError) {
        throw new AiautoworkError(ERROR_CODES.INVALID_INPUT, error.message, { httpStatus: 400 });
      }
      throw error;
    }
  });
}

router.use((req, res, next) => {
  res.set("X-Aiautowork-Module", "1");
  next();
});

// 健康检查
router.get("/health", (req, res) => {
  res.json({ ok: true, ok: true, data: { status: "ok", module: "aiautowork", timestamp: new Date().toISOString() } });
});

// 概览
router.get("/overview", wrap(() => {
  const counts = store.getOverviewCounts();
  const featureFlags = settings.getFeatureFlags();
  const concurrency = settings.getConcurrencyLimits();
  return { counts, featureFlags, concurrency };
}));

// ===== task drafts =====

router.post("/task-drafts", wrap((req) => {
  const body = req.body || {};
  const draft = store.createTaskDraft({
    sourceType: body.sourceType,
    sourceRef: body.sourceRef,
    rawInput: body.rawInput,
    normalizedInput: body.normalizedInput,
    configHash: body.configHash,
    policyVersion: body.policyVersion,
    createdBy: body.createdBy || (req.headers["x-aiautowork-actor"] || null),
    node: body.node || null,
    sourcePriority: body.sourcePriority,
  });
  return draft;
}));

router.get("/task-drafts", wrap((req) => {
  return {
    items: store.listTaskDrafts({
      status: req.query.status,
      sourceType: req.query.sourceType,
      limit: Math.min(parseInt(req.query.limit) || 50, 200),
      offset: parseInt(req.query.offset) || 0,
    }),
  };
}));

router.get("/task-drafts/:id", wrap((req) => {
  const draft = store.getTaskDraft(req.params.id);
  if (!draft) throw new AiautoworkError(ERROR_CODES.NOT_FOUND, "TaskDraft 不存在", { httpStatus: 404 });
  // 顺便返回候选列表与 issues
  const candidates = store.listCandidateAttempts(req.params.id);
  const issues = store.listValidationIssues({ taskDraftId: req.params.id });
  return { draft, candidates, issues };
}));

router.patch("/task-drafts/:id", wrap((req) => {
  const updated = store.updateTaskDraft(req.params.id, req.body || {});
  return updated;
}));

// ===== 单 TaskDraft pipeline（M2）=====

router.post("/task-drafts/:id/infer", wrap((req) => pipeline.inferTaskDraft(req.params.id)));

router.post("/task-drafts/:id/validate", wrap((req) => {
  const candidateId = req.body && req.body.candidateId;
  return pipeline.validateTaskDraft(req.params.id, { candidateId });
}));

router.post("/task-drafts/:id/snapshot", wrap((req) => {
  const actor = (req.body && req.body.actor) || req.headers["x-aiautowork-actor"] || "AI";
  return pipeline.snapshotTaskDraft(req.params.id, { actor });
}));

router.post("/task-drafts/:id/create-story", wrap((req) => {
  const actor = (req.body && req.body.actor) || req.headers["x-aiautowork-actor"] || "AI";
  return pipeline.createStoryPointFromTaskDraft(req.params.id, { actor });
}));

router.post("/task-drafts/:id/run-full-pipeline", wrap((req) => {
  const actor = (req.body && req.body.actor) || req.headers["x-aiautowork-actor"] || "AI";
  return pipeline.runFullPipeline(req.params.id, { actor });
}));

// 列出某 TaskDraft 的派生数据
router.get("/task-drafts/:id/candidates", wrap((req) => {
  return { items: store.listCandidateAttempts(req.params.id) };
}));

router.get("/task-drafts/:id/issues", wrap((req) => {
  return { items: store.listValidationIssues({ taskDraftId: req.params.id }) };
}));

router.get("/task-drafts/:id/snapshots", wrap((req) => {
  return { items: store.listSnapshotsByTaskDraft(req.params.id) };
}));

// ===== batch =====

router.post("/batches", wrap((req) => {
  const body = req.body || {};
  return store.createBatchJob({
    name: body.name,
    description: body.description,
    configTemplate: body.configTemplate,
    total: body.total || 0,
    createdBy: body.createdBy || null,
    node: body.node || null,
  });
}));

router.get("/batches", wrap((req) => {
  return {
    items: store.listBatchJobs({
      status: req.query.status,
      limit: Math.min(parseInt(req.query.limit) || 50, 200),
      offset: parseInt(req.query.offset) || 0,
    }),
  };
}));

router.get("/batches/:id", wrap((req) => {
  const batch = store.getBatchJob(req.params.id);
  if (!batch) throw new AiautoworkError(ERROR_CODES.NOT_FOUND, "Batch 不存在", { httpStatus: 404 });
  const items = store.listBatchTaskItems({ batchId: req.params.id, limit: 200 });
  return { batch, items };
}));

router.get("/batches/:id/items", wrap((req) => {
  return {
    items: store.listBatchTaskItems({
      batchId: req.params.id,
      status: req.query.status,
      pool: req.query.pool,
      limit: Math.min(parseInt(req.query.limit) || 200, 500),
      offset: parseInt(req.query.offset) || 0,
    }),
  };
}));

router.patch("/batches/:id", wrap((req) => {
  const body = req.body || {};
  const allowed = ["name", "description", "status", "pauseReason", "completed", "failed", "skipped", "startedAt", "finishedAt"];
  const patch = Object.fromEntries(Object.entries(body).filter(([k]) => allowed.includes(k)));
  return store.updateBatchJob(req.params.id, patch);
}));

// ===== manual cases =====

router.get("/manual-cases", wrap((req) => {
  return {
    items: store.listManualCases({
      status: req.query.status,
      taskDraftId: req.query.taskDraftId,
      limit: Math.min(parseInt(req.query.limit) || 100, 500),
    }),
  };
}));

router.post("/manual-cases", wrap((req) => {
  const body = req.body || {};
  return store.createManualCase({
    taskDraftId: body.taskDraftId,
    openedReason: body.openedReason,
    openedBy: body.openedBy,
    reasonCode: body.reasonCode,
    payload: body.payload,
  });
}));

router.patch("/manual-cases/:id", wrap((req) => {
  const body = req.body || {};
  return store.updateManualCase(req.params.id, body);
}));

// ===== execution queue =====

router.get("/execution-queue", wrap((req) => {
  return {
    items: store.listExecutionQueue({
      pool: req.query.pool,
      status: req.query.status,
      limit: Math.min(parseInt(req.query.limit) || 100, 500),
    }),
  };
}));

router.post("/execution-queue", wrap((req) => {
  const body = req.body || {};
  return store.enqueueExecution({
    taskDraftId: body.taskDraftId,
    batchItemId: body.batchItemId,
    priority: body.priority || 5,
    pool: body.pool,
    queueReason: body.queueReason,
    payload: body.payload,
  });
}));

// ===== settings =====

router.get("/settings", wrap(() => {
  return { groups: settings.getGroupedSettings() };
}));

router.get("/settings/groups", wrap(() => {
  return { groups: settings.getSettingGroups() };
}));

router.put("/settings", wrap((req) => {
  const body = req.body || {};
  const patch = body.patch || body;
  const actor = req.headers["x-aiautowork-actor"] || body.actor || null;
  const reason = body.reason || null;
  return settings.updateSettings(patch, { actor, reason });
}));

// ===== acceptance v4.1（Phase 0：只报告/双写，不执行真实来源回写） =====

router.post("/acceptance/route", acceptanceWrap((req) => {
  return acceptanceService.routeTask(req.body || {});
}));

router.post("/acceptance/story-points/normalize", acceptanceWrap((req) => {
  return acceptanceService.normalizeStoryPoint(req.body || {});
}));

router.post("/acceptance/project-runs", acceptanceWrap((req) => {
  return acceptanceService.createProjectRun(req.body || {});
}));

router.post("/acceptance/story-runs", acceptanceWrap((req) => {
  return acceptanceService.createStoryRun(req.body || {});
}));

router.post("/acceptance/dual-runs", acceptanceWrap((req) => {
  return acceptanceService.createDualRuns(req.body || {});
}));

router.post("/acceptance/runs/:id/resume", acceptanceWrap((req) => {
  return acceptanceService.resumeRun(req.params.id, req.body || {});
}));

router.post("/acceptance/runs/:id/evidence", acceptanceWrap((req) => {
  return acceptanceService.addEvidence(req.params.id, req.body || {});
}));

// 验收证据可能包含命令、仓库和环境标识；即使是 GET 也必须使用管理员 Principal。
router.get("/acceptance/runs", requireAdmin, acceptanceWrap((req) => {
  const runs = acceptanceService.listRuns({
    protocol: req.query.protocol,
    status: req.query.status,
    storyPointId: req.query.storyPointId,
    projectTaskId: req.query.projectTaskId,
    limit: Math.min(parseInt(req.query.limit) || 100, 500),
  });
  return { runs, items: runs };
}));

router.get("/acceptance/runs/:id", requireAdmin, acceptanceWrap((req) => {
  const run = acceptanceService.getRun(req.params.id);
  if (!run) throw new AiautoworkError(ERROR_CODES.NOT_FOUND, "AcceptanceRun 不存在", { httpStatus: 404 });
  return run;
}));

router.get("/acceptance/story-points/:id/runs", requireAdmin, acceptanceWrap((req) => {
  const runs = acceptanceService.listStoryRuns(req.params.id, Math.min(parseInt(req.query.limit) || 100, 500));
  return { runs, items: runs };
}));

// ===== audit =====

router.get("/audit", wrap((req) => {
  return {
    items: store.listAuditEvents({
      actor: req.query.actor,
      action: req.query.action,
      targetType: req.query.targetType,
      targetId: req.query.targetId,
      limit: Math.min(parseInt(req.query.limit) || 100, 500),
    }),
  };
}));

// ===== review targets =====

router.get("/review-targets", wrap((req) => {
  return {
    items: store.listReviewTargets({
      state: req.query.state,
      limit: Math.min(parseInt(req.query.limit) || 50, 200),
    }),
  };
}));

router.post("/review-targets", wrap((req) => {
  const body = req.body || {};
  return store.createReviewTarget({
    sourceType: body.sourceType,
    repoId: body.repoId,
    targetRef: body.targetRef,
    baseRef: body.baseRef,
    title: body.title,
  });
}));

router.get("/review-targets/:id", wrap((req) => {
  const target = store.getReviewTarget(req.params.id);
  if (!target) throw new AiautoworkError(ERROR_CODES.NOT_FOUND, "ReviewTarget 不存在", { httpStatus: 404 });
  const findings = store.listReviewFindings({ reviewTargetId: req.params.id });
  return { target, findings };
}));

router.get("/findings", wrap((req) => {
  return {
    items: store.listReviewFindings({
      reviewTargetId: req.query.reviewTargetId,
      state: req.query.state,
      severity: req.query.severity,
      limit: Math.min(parseInt(req.query.limit) || 200, 500),
    }),
  };
}));

// ===== 通用 404 兜底 =====

router.use((req, res) => {
  res.status(404).json({ ok: false, error: { code: ERROR_CODES.NOT_FOUND, message: `API ${req.method} ${req.path} 未实现` } });
});

// 错误处理
router.use((err, req, res, next) => {
  sendError(res, err);
});

export default router;
