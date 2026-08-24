import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  ToolkitError,
  ToolkitOperationState,
  UpdatePhase,
  buildStableIdempotencyKey,
  formatReasonMeasure,
  normalizeTicketContext,
  normalizeTaskNo,
  planFingerprint,
  redactErrorMessage,
  redactSecrets,
  resolveExactStatusRef,
  sha256,
  stableStringify,
} from "../../tb-domain/src/index.js";
import { prepareTicket } from "./prepare-ticket.js";
import { resolveGitIsolation } from "./git-isolation.js";

function readJson(file, code = "LOCAL_STATE_INVALID") {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { throw new ToolkitError(code, `本地状态文件无法解析：${path.basename(file)}`); }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const part = `${file}.${process.pid}.${randomUUID()}.part`;
  try {
    fs.writeFileSync(part, `${JSON.stringify(redactSecrets(value), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(part, file);
  } finally {
    try { fs.rmSync(part, { force: true }); } catch {}
  }
}

function journalRoot(repoPath) {
  const isolation = resolveGitIsolation(repoPath);
  return {
    gitRoot: isolation.gitRoot,
    root: path.resolve(path.dirname(isolation.excludeFile), "..", "tb-ticket-toolkit"),
  };
}

function taskNoFromRef(taskRef) {
  if (taskRef && typeof taskRef === "object") return normalizeTaskNo(taskRef.taskNo || taskRef.carbId || "");
  return normalizeTaskNo(taskRef);
}

function contextPathFor(gitRoot, taskRef) {
  return path.join(gitRoot, "temp", taskNoFromRef(taskRef), "ticket-context.json");
}

function taskStatus(snapshot) {
  const status = snapshot?.detail?.taskflowstatus || snapshot?.detail?.status || {};
  return {
    statusId: String(status?._id || status?.id || snapshot?.detail?.taskflowstatusId || ""),
    displayName: String(status?.name || status?.title || snapshot?.detail?.taskflowstatusName || ""),
  };
}

function versionToken(snapshot) {
  return String(snapshot?.detail?.versionToken || snapshot?.detail?.updatedAt || snapshot?.detail?.updated || "");
}

function commentText(value) {
  let content = value?.content;
  if (typeof content === "string") {
    try { content = JSON.parse(content); } catch { return String(content).trim(); }
  }
  if (content && typeof content === "object") {
    return String(content.text || content.markdown || content.comment || content.content || "").trim();
  }
  return String(value?.text || value?.body || value?.message || "").trim();
}

function allowedByList(plan, allowlist) {
  if (!Array.isArray(allowlist) || allowlist.length === 0) return false;
  const values = new Set(allowlist.map((value) => String(value || "").trim()).filter(Boolean));
  return values.has(plan.taskSnapshot.taskId) || values.has(plan.taskSnapshot.taskNo);
}

function statusMatches(left, right) {
  if (left?.statusId && right?.statusId) return String(left.statusId) === String(right.statusId);
  return String(left?.displayName || "").normalize("NFKC").trim().toLowerCase()
    === String(right?.displayName || "").normalize("NFKC").trim().toLowerCase();
}

export function createFileOperationStore({ repoPath, now = () => Date.now(), lockLeaseMs = 30 * 60_000 } = {}) {
  const locations = journalRoot(repoPath);
  const directories = {
    plans: path.join(locations.root, "plans"),
    operations: path.join(locations.root, "operations"),
    idempotency: path.join(locations.root, "idempotency"),
    locks: path.join(locations.root, "locks"),
  };
  Object.values(directories).forEach((directory) => fs.mkdirSync(directory, { recursive: true }));
  const planFile = (id) => path.join(directories.plans, `${String(id)}.json`);
  const operationFile = (id) => path.join(directories.operations, `${String(id)}.json`);
  const idempotencyFile = (key) => path.join(directories.idempotency, `${sha256(key)}.json`);
  const lockFile = (taskId) => path.join(directories.locks, `${sha256(taskId)}.lock`);

  return Object.freeze({
    ...locations,
    savePlan(plan) { writeJsonAtomic(planFile(plan.planId), plan); },
    getPlan(planId) {
      const file = planFile(planId);
      if (!fs.existsSync(file)) throw new ToolkitError("PLAN_NOT_FOUND", "更新计划不存在");
      return readJson(file);
    },
    listPlans() {
      return fs.readdirSync(directories.plans).filter((name) => name.endsWith(".json"))
        .map((name) => readJson(path.join(directories.plans, name)));
    },
    saveOperation(operation) {
      writeJsonAtomic(operationFile(operation.operationId), operation);
      writeJsonAtomic(idempotencyFile(operation.idempotencyKey), { operationId: operation.operationId });
    },
    getOperation(operationId) {
      const file = operationFile(operationId);
      if (!fs.existsSync(file)) throw new ToolkitError("OPERATION_NOT_FOUND", "操作记录不存在");
      return readJson(file);
    },
    findByIdempotency(key) {
      const file = idempotencyFile(key);
      if (!fs.existsSync(file)) return null;
      return this.getOperation(readJson(file).operationId);
    },
    acquire(taskId, correlationId) {
      const file = lockFile(taskId);
      const token = `${now()}-${process.pid}-${randomUUID()}`;
      const body = { taskId, correlationId, token, pid: process.pid, acquiredAt: now(), expiresAt: now() + lockLeaseMs };
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const fd = fs.openSync(file, "wx", 0o600);
          fs.writeFileSync(fd, `${JSON.stringify(body)}\n`, "utf8");
          fs.closeSync(fd);
          return { ...body, file };
        } catch (error) {
          if (error?.code !== "EEXIST") throw error;
          let existing = null;
          try { existing = readJson(file, "LOCK_INVALID"); } catch {}
          if (Number(existing?.expiresAt || 0) > now()) throw new ToolkitError("LOCKED", "该 TB 单已有远端写者持有租约");
          try { fs.rmSync(file, { force: true }); } catch {}
        }
      }
      throw new ToolkitError("LOCKED", "无法取得该 TB 单写租约");
    },
    assertOwner(lock) {
      const current = readJson(lock.file, "LOCK_LOST");
      if (current.token !== lock.token || Number(current.expiresAt || 0) <= now()) throw new ToolkitError("LOCK_LOST", "远端写租约已丢失或过期");
    },
    release(lock) {
      try {
        const current = readJson(lock.file, "LOCK_LOST");
        if (current.token === lock.token) fs.rmSync(lock.file, { force: true });
      } catch {}
    },
  });
}

export function createToolkitApplication({
  provider,
  repoPath = process.cwd(),
  profile = "read",
  writeEnabled = false,
  allowedTaskRefs = [],
  planTtlMs = 15 * 60_000,
  now = () => Date.now(),
  store = null,
} = {}) {
  if (!provider || typeof provider.readTicket !== "function" || typeof provider.getWorkflow !== "function") {
    throw new ToolkitError("PROVIDER_CONFIG_INVALID", "toolkit application requires a complete provider");
  }
  const operationStore = store || createFileOperationStore({ repoPath, now });

  async function readContext(taskRef) {
    const snapshot = await provider.readTicket(taskRef);
    return { snapshot, context: normalizeTicketContext(snapshot, { collectedAt: new Date(now()).toISOString() }) };
  }

  async function workflowGet(taskRef) {
    return provider.getWorkflow(taskRef);
  }

  async function updatePlan(input = {}) {
    const phase = String(input.phase || "").toUpperCase();
    if (!Object.values(UpdatePhase).includes(phase)) throw new ToolkitError("INVALID_ARGUMENT", "phase 只能是 TRIAGE 或 RESOLUTION");
    const style = formatReasonMeasure({ phase, reason: input.reason, measure: input.measure });
    const localFile = contextPathFor(operationStore.gitRoot, input.taskRef);
    if (!fs.existsSync(localFile)) throw new ToolkitError("PREPARE_REQUIRED", "必须先成功调用 tb_ticket_prepare");
    const prepared = readJson(localFile);
    if (prepared.contextDigest !== input.contextDigest) throw new ToolkitError("CONTEXT_CHANGED", "输入 contextDigest 与本地准备快照不一致");
    if ((prepared.attachments || []).some((item) => item.selected && item.downloadStatus !== "DOWNLOADED")) {
      throw new ToolkitError("PREPARE_NOT_READY", "选中附件尚未全部下载完成");
    }
    const { snapshot, context } = await readContext(input.taskRef);
    if (context.contextDigest !== input.contextDigest) throw new ToolkitError("CONTEXT_CHANGED", "Teambition 上下文已变化，请重新 prepare");
    const workflow = await workflowGet(input.taskRef);
    const targetStatus = resolveExactStatusRef(input.targetStatus, workflow.statuses);
    if (input.expectedCurrentStatus && !statusMatches(resolveExactStatusRef(input.expectedCurrentStatus, [workflow.currentStatus]), workflow.currentStatus)) {
      throw new ToolkitError("CONFLICT", "当前状态与预期状态不一致");
    }
    const evidenceRefs = Array.isArray(input.evidenceRefs) ? input.evidenceRefs : [];
    if (!evidenceRefs.length) throw new ToolkitError("EVIDENCE_INSUFFICIENT", "更新计划至少需要一条证据");
    if (phase === UpdatePhase.RESOLUTION) {
      if (evidenceRefs.some((item) => String(item?.result || "").toUpperCase() === "FAIL")
        || !evidenceRefs.some((item) => String(item?.result || "").toUpperCase() === "PASS")) {
        throw new ToolkitError("EVIDENCE_INSUFFICIENT", "RESOLUTION 需要至少一条 PASS 且不能包含 FAIL 证据");
      }
      const priorTriage = operationStore.listPlans()
        .filter((plan) => plan.phase === UpdatePhase.TRIAGE && plan.taskSnapshot?.taskId === context.task.taskId)
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
      if (priorTriage?.proposedChanges?.comment === style.comment) {
        throw new ToolkitError("COMMENT_STYLE_REJECTED", "RESOLUTION 评论必须基于最终证据重新生成，不能复用 TRIAGE 评论");
      }
    }
    const sourceIdentity = String(input.source?.commit || input.source?.workflowRunId || "").trim();
    if (!sourceIdentity) throw new ToolkitError("EVIDENCE_INSUFFICIENT", "source.commit 或 source.workflowRunId 至少提供一个");
    const createdAt = new Date(now()).toISOString();
    const plan = {
      schemaVersion: 1,
      planId: randomUUID(),
      fingerprint: "",
      createdAt,
      expiresAt: new Date(now() + planTtlMs).toISOString(),
      phase,
      taskRef: input.taskRef,
      taskSnapshot: {
        taskId: context.task.taskId,
        taskNo: context.task.taskNo,
        currentStatus: workflow.currentStatus,
        versionToken: versionToken(snapshot),
        contextDigest: context.contextDigest,
      },
      workflowSnapshot: {
        projectId: workflow.projectId,
        taskflowId: workflow.taskflowId,
        workflowVersion: workflow.workflowVersion,
      },
      proposedChanges: { targetStatus, comment: style.comment, commentHash: style.commentHash },
      normalizedReason: style.reason,
      normalizedMeasure: style.measure,
      styleChecks: style.checks.map((check) => ({ check, result: "PASS" })),
      evidenceRefs: redactSecrets(evidenceRefs),
      evidenceDigest: sha256(stableStringify(redactSecrets(evidenceRefs))),
      source: redactSecrets(input.source || {}),
      idempotencyKey: String(input.idempotencyKey || "").trim() || buildStableIdempotencyKey({
        taskId: context.task.taskId,
        phase,
        targetStatus,
        comment: style.comment,
        sourceCommitOrWorkflowRunId: sourceIdentity,
      }),
      revalidated: phase === UpdatePhase.RESOLUTION,
      applyAllowed: profile === "write" && writeEnabled && allowedByList({ taskSnapshot: context.task }, allowedTaskRefs),
      blockers: [],
    };
    plan.fingerprint = planFingerprint(plan);
    operationStore.savePlan(plan);
    return redactSecrets(plan);
  }

  async function freshSnapshotMatches(plan) {
    const { snapshot, context } = await readContext(plan.taskRef);
    const workflow = await workflowGet(plan.taskRef);
    return {
      snapshot,
      context,
      workflow,
      matches: context.contextDigest === plan.taskSnapshot.contextDigest
        && versionToken(snapshot) === plan.taskSnapshot.versionToken
        && statusMatches(workflow.currentStatus, plan.taskSnapshot.currentStatus),
    };
  }

  async function updateApply({ planId, fingerprint, idempotencyKey, apply = false } = {}) {
    if (profile !== "write") throw new ToolkitError("WRITE_DISABLED", "read profile does not expose remote apply");
    if (!writeEnabled) throw new ToolkitError("WRITE_DISABLED", "Teambition remote writes are disabled by configuration");
    if (apply !== true) throw new ToolkitError("WRITE_DISABLED", "apply=true is required for a remote write");
    const plan = operationStore.getPlan(planId);
    if (planFingerprint(plan) !== plan.fingerprint || String(fingerprint || "") !== plan.fingerprint) throw new ToolkitError("PLAN_TAMPERED", "计划指纹不一致");
    if (String(idempotencyKey || "").trim() !== plan.idempotencyKey) throw new ToolkitError("PLAN_TAMPERED", "幂等键与计划不一致");
    if (!allowedByList(plan, allowedTaskRefs)) throw new ToolkitError("FORBIDDEN", "任务不在真实写入白名单中");
    const existing = operationStore.findByIdempotency(plan.idempotencyKey);
    if (!existing && now() >= Date.parse(plan.expiresAt)) throw new ToolkitError("PLAN_EXPIRED", "更新计划已过期");
    if (existing?.state === ToolkitOperationState.COMPLETED) return existing;
    const operation = existing || {
      schemaVersion: 1,
      operationId: randomUUID(),
      correlationId: randomUUID(),
      planId: plan.planId,
      idempotencyKey: plan.idempotencyKey,
      taskId: plan.taskSnapshot.taskId,
      taskNo: plan.taskSnapshot.taskNo,
      phase: plan.phase,
      state: ToolkitOperationState.PLANNED,
      steps: {
        comment: { state: "PENDING", attempts: 0 },
        status: { state: "PENDING", attempts: 0 },
      },
      createdAt: new Date(now()).toISOString(),
      updatedAt: new Date(now()).toISOString(),
      safeToResume: true,
      nextAction: "apply comment then status",
    };
    operationStore.saveOperation(operation);
    const lock = operationStore.acquire(plan.taskSnapshot.taskId, operation.correlationId);
    try {
      const fresh = await freshSnapshotMatches(plan);
      if (!fresh.matches && !existing && !statusMatches(fresh.workflow.currentStatus, plan.proposedChanges.targetStatus)) {
        operation.state = ToolkitOperationState.CONFLICT;
        operation.safeToResume = false;
        operation.nextAction = "refresh context and create a new plan";
        operation.updatedAt = new Date(now()).toISOString();
        operationStore.saveOperation(operation);
        return operation;
      }
      operation.state = ToolkitOperationState.APPLYING;
      operation.updatedAt = new Date(now()).toISOString();
      operationStore.saveOperation(operation);

      if (!["DONE", "DEDUPED"].includes(operation.steps.comment.state)) {
        operationStore.assertOwner(lock);
        operation.steps.comment.attempts += 1;
        let comments = [];
        try { comments = await provider.listComments(plan.taskRef); }
        catch (error) {
          operation.steps.comment = { ...operation.steps.comment, state: "UNKNOWN", error: redactErrorMessage(error) };
          operation.state = ToolkitOperationState.PARTIAL;
          operation.nextAction = "retry the same operation after comment readback is available";
          operation.updatedAt = new Date(now()).toISOString();
          operationStore.saveOperation(operation);
          return operation;
        }
        if (comments.some((item) => commentText(item) === plan.proposedChanges.comment)) {
          operation.steps.comment = { ...operation.steps.comment, state: "DEDUPED", readbackVerified: true };
        } else {
          try { await provider.writeComment(plan.taskSnapshot.taskId, plan.proposedChanges.comment); }
          catch (error) { operation.steps.comment.error = redactErrorMessage(error); }
          try { comments = await provider.listComments(plan.taskRef); } catch { comments = []; }
          if (comments.some((item) => commentText(item) === plan.proposedChanges.comment)) {
            operation.steps.comment = { ...operation.steps.comment, state: "DONE", readbackVerified: true, error: null };
          } else {
            operation.steps.comment = { ...operation.steps.comment, state: "UNKNOWN", readbackVerified: false, error: operation.steps.comment.error || "评论写入后回读未确认" };
            operation.state = ToolkitOperationState.PARTIAL;
            operation.nextAction = "retry the same operation; only the missing comment step will run";
            operation.updatedAt = new Date(now()).toISOString();
            operationStore.saveOperation(operation);
            return operation;
          }
        }
        operation.state = ToolkitOperationState.COMMENT_APPLIED;
        operation.updatedAt = new Date(now()).toISOString();
        operationStore.saveOperation(operation);
      }

      if (!["DONE", "DEDUPED"].includes(operation.steps.status.state)) {
        operationStore.assertOwner(lock);
        operation.steps.status.attempts += 1;
        let workflow = await provider.getWorkflow(plan.taskRef);
        if (statusMatches(workflow.currentStatus, plan.proposedChanges.targetStatus)) {
          operation.steps.status = { ...operation.steps.status, state: "DEDUPED", readbackVerified: true };
        } else {
          resolveExactStatusRef(plan.proposedChanges.targetStatus, workflow.statuses);
          try { await provider.updateStatus(plan.taskSnapshot.taskId, plan.proposedChanges.targetStatus); }
          catch (error) { operation.steps.status.error = redactErrorMessage(error); }
          try { workflow = await provider.getWorkflow(plan.taskRef); } catch {}
          if (statusMatches(workflow.currentStatus, plan.proposedChanges.targetStatus)) {
            operation.steps.status = { ...operation.steps.status, state: "DONE", readbackVerified: true, error: null };
          } else {
            operation.steps.status = { ...operation.steps.status, state: "UNKNOWN", readbackVerified: false, error: operation.steps.status.error || "状态写入后回读未确认" };
            operation.state = ToolkitOperationState.PARTIAL;
            operation.nextAction = "retry the same operation; only the missing status step will run";
            operation.updatedAt = new Date(now()).toISOString();
            operationStore.saveOperation(operation);
            return operation;
          }
        }
      }

      operation.state = ToolkitOperationState.COMPLETED;
      operation.finalTaskSnapshot = { ...(await provider.getWorkflow(plan.taskRef)).currentStatus };
      operation.readbackVerified = true;
      operation.safeToResume = false;
      operation.nextAction = "none";
      operation.updatedAt = new Date(now()).toISOString();
      operationStore.saveOperation(operation);
      return operation;
    } finally {
      operationStore.release(lock);
    }
  }

  return Object.freeze({
    profile,
    writeEnabled,
    repoPath,
    provider,
    store: operationStore,
    prepare: (input) => prepareTicket({ provider, repoPath, ...input }),
    getPreparedContext(taskRef) {
      const file = contextPathFor(operationStore.gitRoot, taskRef);
      if (!fs.existsSync(file)) throw new ToolkitError("PREPARE_REQUIRED", "必须先成功调用 tb_ticket_prepare");
      return readJson(file);
    },
    readContext,
    workflowGet,
    updatePlan,
    updateApply,
    operationGet: (operationId) => operationStore.getOperation(operationId),
  });
}
