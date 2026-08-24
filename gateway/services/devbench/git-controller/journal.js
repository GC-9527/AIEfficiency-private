import { randomUUID } from "node:crypto";
import os from "node:os";
import * as defaultPersistence from "../../../db/sqlite.js";
import { GitControllerError, redactGitOutput } from "./path-security.js";
import { processStartIdentity } from "./lease.js";

export const CONTROLLER_PHASES = Object.freeze([
  "PREVIEWED",
  "MIRROR_FETCHING",
  "MIRROR_RETENTION_VERIFIED",
  "MIRROR_PUBLISHING",
  "MIRROR_ACCEPTED",
  "MIRROR_MAINTENANCE_RUNNING",
  "MIRROR_MAINTENANCE_VERIFIED",
  "STORY_RETIRE_QUARANTINING",
  "STORY_RETIRE_QUARANTINED",
  "STORY_PROVISION_CREATING",
  "STORY_PROVISION_CREATED",
  "STORY_PROVISION_LEGACY_MIGRATED",
  "STORY_PROVISION_ACL_APPLIED",
  "STORY_PROVISION_REGISTRY_RECORDED",
  "WORKER_PROBE_REGISTRY_COMMITTED",
  "WORKER_PROBE_RECONCILING",
  "WORKER_PROBE_RECONCILED",
  "BASE_PREFLIGHT_PASSED",
  "BASE_OBJECTS_FETCHED",
  "BASE_APPLYING",
  "BASE_APPLIED",
  "VERIFIED",
  "FAILED",
  "RECOVERY_REQUIRED",
]);

function assertPhase(value) {
  const phase = String(value || "").trim();
  if (!CONTROLLER_PHASES.includes(phase)) {
    throw new GitControllerError(
      "GIT_CONTROLLER_PHASE_INVALID",
      "Controller journal phase is invalid",
      { phase },
    );
  }
  return phase;
}

export function serializeControllerError(error) {
  let details = {};
  if (error?.details && typeof error.details === "object") {
    try {
      details = JSON.parse(redactGitOutput(JSON.stringify(error.details)));
    } catch {
      details = { serializationFailed: true };
    }
  }
  return {
    code: String(error?.code || "GIT_CONTROLLER_ERROR"),
    message: redactGitOutput(error?.message || "Git Controller operation failed").slice(0, 1000),
    details,
  };
}

export class OperationJournal {
  constructor({
    persistence = defaultPersistence,
    ownerInstance,
    ownerHostname = os.hostname(),
    ownerPid = process.pid,
    processIdentityProbe = processStartIdentity,
  } = {}) {
    this.persistence = persistence;
    this.ownerInstance = String(ownerInstance || "").trim();
    this.ownerHostname = String(ownerHostname || "").trim();
    this.ownerPid = Number(ownerPid);
    this.ownerProcessStartIdentity = String(
      processIdentityProbe?.(this.ownerPid) || "",
    ).trim();
  }

  begin({
    repositoryId,
    operationType,
    commandId,
    idempotencyKey,
    previewId,
    branch,
    expectedHead,
    candidateSha,
  }) {
    const operationId = randomUUID();
    const started = this.persistence.beginGitControllerOperation({
      operationId,
      repositoryId,
      operationType,
      commandId,
      idempotencyKey,
      previewId,
      branch,
      expectedHead,
      candidateSha,
      phase: "PREVIEWED",
      ownerInstance: this.ownerInstance,
      ownerHostname: this.ownerHostname,
      ownerPid: this.ownerPid,
      ownerProcessStartIdentity: this.ownerProcessStartIdentity,
      startedAt: Date.now(),
    });
    if (!started.created) return { created: false, operation: started.operation };
    this.persistence.appendGitControllerJournal({
      operationId,
      repositoryId,
      phase: "PREVIEWED",
      data: {
        commandId,
        previewId,
        branch,
        expectedHead: expectedHead || null,
        candidateSha: candidateSha || null,
      },
      createdAt: Date.now(),
    });
    return { created: true, operation: this.persistence.getGitControllerOperation(operationId) };
  }

  append(operation, phaseValue, data = {}, fencingToken = null) {
    const phase = assertPhase(phaseValue);
    this.persistence.appendGitControllerJournal({
      operationId: operation.operationId,
      repositoryId: operation.repositoryId,
      phase,
      fencingToken,
      data,
      createdAt: Date.now(),
    });
    return this.persistence.getGitControllerOperation(operation.operationId);
  }

  stageRecovery(
    operation,
    result,
    {
      phase: phaseValue = "BASE_APPLYING",
      data = {},
      fencingToken = null,
    } = {},
  ) {
    const phase = assertPhase(phaseValue);
    if (typeof this.persistence.stageGitControllerOperationRecovery !== "function") {
      throw new GitControllerError(
        "GIT_CONTROLLER_RECOVERY_CHECKPOINT_UNAVAILABLE",
        "Durable operation recovery checkpoints are unavailable",
        { operationId: operation?.operationId || null },
      );
    }
    const staged = this.persistence.stageGitControllerOperationRecovery({
      operationId: operation.operationId,
      ownerInstance: this.ownerInstance,
      phase,
      fencingToken,
      result,
      data,
      createdAt: Date.now(),
    });
    if (!staged?.ok) {
      throw new GitControllerError(
        "GIT_CONTROLLER_RECOVERY_CHECKPOINT_FAILED",
        "Durable operation recovery checkpoint could not be fenced and persisted",
        {
          operationId: operation.operationId,
          reason: staged?.reason || "checkpoint_failed",
        },
      );
    }
    return staged.operation;
  }

  succeed(operation, result, fencingToken = null) {
    this.append(operation, "VERIFIED", {
      resultCode: result?.resultCode || "PASS",
    }, fencingToken);
    return this.persistence.finishGitControllerOperation(operation.operationId, {
      status: "SUCCEEDED",
      phase: "VERIFIED",
      resultCode: result?.resultCode || "PASS",
      result,
      fencingToken,
      completedAt: Date.now(),
    });
  }

  fail(operation, error, {
    fencingToken = null,
    recoveryRequired = false,
    data = {},
  } = {}) {
    const serialized = serializeControllerError(error);
    const phase = recoveryRequired ? "RECOVERY_REQUIRED" : "FAILED";
    this.append(operation, phase, {
      ...data,
      error: serialized,
    }, fencingToken);
    return this.persistence.finishGitControllerOperation(operation.operationId, {
      status: recoveryRequired ? "RECOVERY_REQUIRED" : "FAILED",
      phase,
      resultCode: serialized.code,
      error: serialized,
      fencingToken,
      completedAt: Date.now(),
    });
  }
}

export function listAllRecoverableOperations(persistence, {
  operationType = "",
  repositoryId = "",
  batchSize = 100,
} = {}) {
  if (typeof persistence?.listGitControllerRecoverableOperations !== "function") {
    throw new GitControllerError(
      "GIT_CONTROLLER_RECOVERY_PERSISTENCE_INVALID",
      "Controller persistence cannot enumerate recoverable operations",
    );
  }
  const limit = Math.max(1, Math.min(1000, Number(batchSize) || 100));
  const operations = [];
  const seen = new Set();
  let afterUpdatedAt = null;
  let afterOperationId = "";
  for (;;) {
    const page = persistence.listGitControllerRecoverableOperations({
      operationType,
      repositoryId,
      limit,
      ...(afterOperationId ? { afterUpdatedAt, afterOperationId } : {}),
    });
    if (!Array.isArray(page)) {
      throw new GitControllerError(
        "GIT_CONTROLLER_RECOVERY_PERSISTENCE_INVALID",
        "Controller persistence returned an invalid recovery page",
      );
    }
    for (const operation of page) {
      if (!operation?.operationId || seen.has(operation.operationId)) {
        throw new GitControllerError(
          "GIT_CONTROLLER_RECOVERY_PAGINATION_INVALID",
          "Controller recovery pagination did not advance monotonically",
        );
      }
      seen.add(operation.operationId);
      operations.push(operation);
    }
    if (page.length < limit) break;
    const last = page.at(-1);
    const nextUpdatedAt = Number(last?.updatedAt);
    const nextOperationId = String(last?.operationId || "");
    if (
      !Number.isFinite(nextUpdatedAt)
      || nextUpdatedAt < 0
      || !nextOperationId
      || (
        afterOperationId
        && nextUpdatedAt === afterUpdatedAt
        && nextOperationId === afterOperationId
      )
    ) {
      throw new GitControllerError(
        "GIT_CONTROLLER_RECOVERY_PAGINATION_INVALID",
        "Controller recovery pagination cursor is invalid",
      );
    }
    afterUpdatedAt = nextUpdatedAt;
    afterOperationId = nextOperationId;
  }
  return operations;
}

export function createOperationJournal(options = {}) {
  return new OperationJournal(options);
}
