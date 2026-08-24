import { randomUUID } from "node:crypto";
import * as defaultPersistence from "../../../db/sqlite.js";
import { GitControllerError, redactGitOutput } from "./path-security.js";

function sanitizeDetails(value, depth = 0) {
  if (depth > 6) return "[truncated]";
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return redactGitOutput(value).slice(0, 2000);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeDetails(item, depth + 1));
  if (typeof value === "object") {
    const result = {};
    for (const [key, item] of Object.entries(value).slice(0, 100)) {
      if (/password|passwd|authorization|credential|secret|token(?!$)/i.test(key)) {
        result[key] = "***";
      } else {
        result[key] = sanitizeDetails(item, depth + 1);
      }
    }
    return result;
  }
  return String(value);
}

export class ControllerAudit {
  constructor({ persistence = defaultPersistence, actor = "git-controller" } = {}) {
    this.persistence = persistence;
    this.actor = String(actor || "git-controller");
  }

  write({
    operation,
    commandId,
    action = commandId,
    branch = null,
    beforeSha = null,
    candidateSha = null,
    result,
    reason = null,
    durationMs = 0,
    fencingToken = null,
    actor = this.actor,
    details = {},
  }) {
    if (!operation?.operationId || !operation?.repositoryId) {
      throw new GitControllerError(
        "GIT_CONTROLLER_AUDIT_INVALID",
        "Audit requires a persisted controller operation",
      );
    }
    const auditId = randomUUID();
    try {
      this.persistence.appendGitControllerAudit({
        auditId,
        operationId: operation.operationId,
        repositoryId: operation.repositoryId,
        commandId,
        action,
        branch,
        beforeSha,
        candidateSha,
        result,
        reason,
        durationMs,
        fencingToken,
        actor,
        details: sanitizeDetails(details),
        createdAt: Date.now(),
      });
    } catch (error) {
      throw new GitControllerError(
        "GIT_CONTROLLER_AUDIT_WRITE_FAILED",
        "Controller audit could not be persisted",
        {
          operationId: operation.operationId,
          cause: error.code || error.message,
        },
        { cause: error },
      );
    }
    return auditId;
  }
}

export function createControllerAudit(options = {}) {
  return new ControllerAudit(options);
}
