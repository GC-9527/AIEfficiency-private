import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  diagnoseBaseProtectionHooks,
  installBaseProtectionHooks,
  listBaseProtectionHooks,
  previewUninstallBaseProtectionHooks,
  uninstallBaseProtectionHooks,
} from "./base-protection-hooks.js";
import {
  GitControllerError,
  assertIdempotencyKey,
  listAllRecoverableOperations,
  normalizeSha,
} from "./git-controller/index.js";

const HOOKS_BRANCH = "__hooks__";
const DEFAULT_PREVIEW_TTL_MS = 5 * 60_000;
const DEFAULT_MANAGEMENT_HELPER = fileURLToPath(
  new URL("./git-controller-ipc-helper.mjs", import.meta.url),
);
const ACTIONS = Object.freeze({
  install: Object.freeze({
    action: "install",
    previewKind: "HOOKS_INSTALL",
    operationType: "HOOKS_INSTALL",
    commandId: "hooks.install",
  }),
  uninstall: Object.freeze({
    action: "uninstall",
    previewKind: "HOOKS_UNINSTALL",
    operationType: "HOOKS_UNINSTALL",
    commandId: "hooks.uninstall",
  }),
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeAction(value) {
  const action = String(value || "").trim().toLowerCase();
  const descriptor = ACTIONS[action];
  if (!descriptor) {
    throw new GitControllerError(
      "GIT_CONTROLLER_HOOKS_ACTION_INVALID",
      "Managed hooks action must be install or uninstall",
    );
  }
  return descriptor;
}

function safeIssue(value) {
  const raw = String(value || "").trim();
  if (!raw) return "BASE_PROTECTION_UNKNOWN_ISSUE";
  const separator = raw.indexOf(":");
  if (separator < 0) return raw.slice(0, 160);
  const code = raw.slice(0, separator).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120);
  const detail = raw.slice(separator + 1).trim();
  if (/^(?:pre-commit|pre-push|post-checkout|post-merge|post-rewrite|reference-transaction)$/.test(detail)) {
    return `${code}:${detail}`;
  }
  return code || "BASE_PROTECTION_UNKNOWN_ISSUE";
}

function safeIssues(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(safeIssue))].sort();
}

function safeActor(value) {
  return String(value || "git-controller")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .slice(0, 200) || "git-controller";
}

function replayOrThrow(operation) {
  if (operation.status === "SUCCEEDED" && operation.result) {
    return { ...operation.result, replayed: true };
  }
  if (operation.status === "RUNNING") {
    throw new GitControllerError(
      "GIT_CONTROLLER_OPERATION_IN_PROGRESS",
      "An operation with this idempotency key is still running",
      { operationId: operation.operationId },
    );
  }
  const stored = operation.error || {};
  throw new GitControllerError(
    stored.code || operation.resultCode || "GIT_CONTROLLER_OPERATION_FAILED",
    stored.message || "The idempotent hooks operation previously failed",
    { ...(stored.details || {}), operationId: operation.operationId, replayed: true },
  );
}

function assertReplayBinding(operation, {
  previewId,
  expectedHead,
  candidateSha,
}) {
  if (
    operation.previewId !== previewId
    || operation.branch !== HOOKS_BRANCH
    || operation.expectedHead !== expectedHead
    || operation.candidateSha !== candidateSha
  ) {
    throw new GitControllerError(
      "GIT_CONTROLLER_IDEMPOTENCY_CONFLICT",
      "Idempotency key was already used for a different managed hooks request",
      { operationId: operation.operationId },
    );
  }
}

function asControllerError(error, fallbackCode) {
  if (error instanceof GitControllerError) return error;
  return new GitControllerError(
    fallbackCode,
    "Managed base-protection hooks operation failed",
    { cause: String(error?.code || "BASE_PROTECTION_OPERATION_FAILED").slice(0, 160) },
    { cause: error },
  );
}

function hooksResult(result = {}) {
  return {
    status: String(result.status || "UNKNOWN"),
    idempotent: result.idempotent === true,
    installed: safeIssues(result.installed),
    backedUp: safeIssues(result.backedUp),
    skipped: safeIssues(result.skipped),
    removed: safeIssues(result.removed),
    restored: safeIssues(result.restored),
    issues: safeIssues(result.issues),
    errorCode: result.errorCode ? safeIssue(result.errorCode) : null,
  };
}

function stateSignature(value = {}) {
  return sha256(JSON.stringify({
    action: value.action,
    status: value.status,
    eligible: value.eligible === true,
    blockerCode: value.blockerCode || null,
    issues: safeIssues(value.issues),
    validatorDigest: value.validatorDigest || null,
  }));
}

function validatorDescriptorDigest(descriptor) {
  if (!descriptor || typeof descriptor !== "object") {
    throw new GitControllerError(
      "GIT_CONTROLLER_HOOKS_CAPABILITY_UNAVAILABLE",
      "A managed capability validator is required before hooks can be installed",
    );
  }
  if (descriptor.type === "module") {
    const modulePath = path.resolve(String(descriptor.modulePath || ""));
    if (!path.isAbsolute(String(descriptor.modulePath || "")) || !fs.existsSync(modulePath)) {
      throw new GitControllerError(
        "GIT_CONTROLLER_HOOKS_CAPABILITY_UNAVAILABLE",
        "The managed capability validator module is unavailable",
      );
    }
    const stat = fs.lstatSync(modulePath);
    if (!stat.isFile() || stat.isSymbolicLink() || Number(stat.nlink || 1) !== 1) {
      throw new GitControllerError(
        "GIT_CONTROLLER_HOOKS_CAPABILITY_UNAVAILABLE",
        "The managed capability validator module is not a regular file",
      );
    }
    return sha256(JSON.stringify({
      type: "module",
      modulePath,
      moduleSha256: sha256(fs.readFileSync(modulePath)),
      exportName: String(descriptor.exportName || "validateCapability"),
    }));
  }
  if (descriptor.type === "command") {
    const executable = path.resolve(String(descriptor.executable || ""));
    if (!path.isAbsolute(String(descriptor.executable || "")) || !fs.existsSync(executable)) {
      throw new GitControllerError(
        "GIT_CONTROLLER_HOOKS_CAPABILITY_UNAVAILABLE",
        "The managed capability validator command is unavailable",
      );
    }
    const stat = fs.lstatSync(executable);
    if (!stat.isFile() || stat.isSymbolicLink() || Number(stat.nlink || 1) !== 1) {
      throw new GitControllerError(
        "GIT_CONTROLLER_HOOKS_CAPABILITY_UNAVAILABLE",
        "The managed capability validator command is not a regular file",
      );
    }
    return sha256(JSON.stringify({
      type: "command",
      executable,
      executableSha256: sha256(fs.readFileSync(executable)),
      args: Array.isArray(descriptor.args) ? descriptor.args.map(String) : [],
      timeoutMs: Math.max(100, Math.min(30_000, Number(descriptor.timeoutMs) || 5_000)),
    }));
  }
  throw new GitControllerError(
    "GIT_CONTROLLER_HOOKS_CAPABILITY_UNAVAILABLE",
    "A managed capability validator is required before hooks can be installed",
  );
}

function installedValidatorDigest(basePath) {
  try {
    const listed = listBaseProtectionHooks(basePath);
    if (!listed.managedRoot) return null;
    const manifestPath = path.join(listed.managedRoot, "manifest.json");
    const manifestStat = fs.lstatSync(manifestPath);
    if (
      !manifestStat.isFile()
      || manifestStat.isSymbolicLink()
      || Number(manifestStat.nlink || 1) !== 1
    ) {
      return "DRIFTED";
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const descriptor = manifest?.capability?.validator;
    if (!descriptor || descriptor.type === "none") return null;
    if (descriptor.type === "module") {
      const modulePath = path.resolve(String(descriptor.modulePath || ""));
      if (
        !path.isAbsolute(String(descriptor.modulePath || ""))
        || !fs.existsSync(modulePath)
        || fs.lstatSync(modulePath).isSymbolicLink()
        || Number(fs.lstatSync(modulePath).nlink || 1) !== 1
        || sha256(fs.readFileSync(modulePath)) !== String(descriptor.moduleSha256 || "")
      ) {
        return "DRIFTED";
      }
      return validatorDescriptorDigest({
        type: "module",
        modulePath,
        exportName: descriptor.exportName,
      });
    }
    if (descriptor.type === "command") {
      const executable = path.resolve(String(descriptor.executable || ""));
      if (
        !path.isAbsolute(String(descriptor.executable || ""))
        || !fs.existsSync(executable)
        || fs.lstatSync(executable).isSymbolicLink()
        || Number(fs.lstatSync(executable).nlink || 1) !== 1
        || sha256(fs.readFileSync(executable))
          !== String(descriptor.executableSha256 || "")
      ) {
        return "DRIFTED";
      }
      for (const record of descriptor.argFiles || []) {
        const filePath = path.resolve(String(record?.path || ""));
        if (
          !path.isAbsolute(String(record?.path || ""))
          || !fs.existsSync(filePath)
          || fs.lstatSync(filePath).isSymbolicLink()
          || Number(fs.lstatSync(filePath).nlink || 1) !== 1
          || sha256(fs.readFileSync(filePath)) !== String(record?.sha256 || "")
        ) {
          return "DRIFTED";
        }
      }
      return validatorDescriptorDigest(descriptor);
    }
    return null;
  } catch {
    return "DRIFTED";
  }
}

function managedJsonEvidence(basePath, relativeSegments) {
  try {
    const listed = listBaseProtectionHooks(basePath);
    const managedRootValue = String(listed?.managedRoot || "");
    if (!managedRootValue || !path.isAbsolute(managedRootValue)) return null;
    const managedRoot = path.resolve(managedRootValue);
    if (managedRoot === path.parse(managedRoot).root) return null;
    const target = path.resolve(managedRoot, ...relativeSegments);
    const relative = path.relative(managedRoot, target);
    if (
      !relative
      || relative.startsWith("..")
      || path.isAbsolute(relative)
      || !fs.existsSync(target)
    ) {
      return null;
    }
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || Number(stat.nlink || 1) !== 1) {
      return null;
    }
    const value = JSON.parse(fs.readFileSync(target, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : null;
  } catch {
    return null;
  }
}

function controllerOperationBinding(operation, preview, descriptor) {
  return Object.freeze({
    schemaVersion: 1,
    operationId: operation.operationId,
    previewId: operation.previewId,
    action: descriptor.action,
    expectedHead: operation.expectedHead,
    candidateSha: operation.candidateSha,
    stateSignature: String(preview?.payload?.stateSignature || ""),
    validatorDigest: preview?.payload?.validatorDigest || null,
    eligible: preview?.eligible === true,
  });
}

function bindingMatches(left, right) {
  return !!left && !!right && JSON.stringify(left) === JSON.stringify(right);
}

function installedOperationBinding(basePath) {
  return managedJsonEvidence(basePath, ["manifest.json"])
    ?.controller?.operationBinding || null;
}

function uninstallOperationEvidence(basePath) {
  return managedJsonEvidence(
    basePath,
    ["runtime", "uninstall-journal.json"],
  );
}

function previewStateMatchesInspection(preview, inspection) {
  return !!preview && !!inspection && (
    preview.eligible === inspection.eligible
    && String(preview.payload?.stateSignature || "") === inspection.stateSignature
    && (preview.payload?.validatorDigest || null)
      === (inspection.validatorDigest || null)
  );
}

function runtimeLeaseActive(repository) {
  const runtimeDirectory = path.join(repository.managedRoot, "runtime");
  if (!fs.existsSync(runtimeDirectory)) return false;
  try {
    return fs.readdirSync(runtimeDirectory)
      .filter((name) => name.endsWith(".lease") || name.endsWith(".lease.json"))
      .some((name) => {
        try {
          const stat = fs.statSync(path.join(runtimeDirectory, name));
          return stat.isFile() && stat.size > 0;
        } catch {
          return true;
        }
      });
  } catch {
    return true;
  }
}

export class ManagedHooksController {
  constructor(runtime, { previewTtlMs = DEFAULT_PREVIEW_TTL_MS } = {}) {
    const controller = runtime?.controller;
    if (
      !controller?.registry
      || !controller?.leaseManager
      || !controller?.journal
      || !controller?.audit
    ) {
      throw new GitControllerError(
        "GIT_CONTROLLER_DEPENDENCY_MISSING",
        "Managed hooks controller dependencies are incomplete",
      );
    }
    this.runtime = runtime;
    this.controller = controller;
    this.registry = controller.registry;
    this.leaseManager = controller.leaseManager;
    this.journal = controller.journal;
    this.audit = controller.audit;
    this.persistence = controller.journal.persistence;
    this.capabilityService = runtime.capabilityService || null;
    this.managementClientDescriptor = runtime.managementClientDescriptor || {
      type: "command",
      executable: process.execPath,
      helperPath: DEFAULT_MANAGEMENT_HELPER,
      fixedArgs: [],
      timeoutMs: 30_000,
    };
    this.runtimeExecutablePaths = Object.freeze({
      nodeBinary: path.resolve(String(runtime.nodeBinary || process.execPath)),
      gitBinary: path.resolve(String(this.registry.gitBinary || "")),
    });
    this.previewTtlMs = Math.max(10_000, Number(previewTtlMs) || DEFAULT_PREVIEW_TTL_MS);
  }

  async readHead(entry) {
    const result = await this.registry.gitRunner({
      gitBinary: this.registry.gitBinary,
      disabledHooksPath: this.registry.disabledHooksPath,
      knownHostsPath: this.registry.knownHostsPath,
      args: [
        "-c",
        `safe.directory=${entry.basePath.replace(/\\/g, "/")}`,
        "-C",
        entry.basePath,
        "rev-parse",
        "--verify",
        "HEAD^{commit}",
      ],
      commandId: "hooks.read-head",
    });
    return normalizeSha(result.stdout.trim(), { label: "base HEAD" });
  }

  currentControllerLease(entry, ownLease = null) {
    const current = this.persistence.getGitControllerRepositoryLease(entry.repositoryId);
    if (!current || Number(current.expiresAt || 0) <= Date.now()) return null;
    if (
      ownLease
      && current.leaseId === ownLease.leaseId
      && current.operationId === ownLease.operationId
      && Number(current.fencingToken) === Number(ownLease.fencingToken)
    ) {
      return null;
    }
    return current;
  }

  activityCheck(entry, ownLease = null) {
    return ({ repository }) => (
      runtimeLeaseActive(repository)
      || !!this.currentControllerLease(entry, ownLease)
    );
  }

  desiredValidatorDigest() {
    return validatorDescriptorDigest(this.capabilityService?.validatorDescriptor);
  }

  async resolveEntry(repositoryId) {
    const entry = this.registry.get(repositoryId);
    await this.registry.verify(entry.repositoryId);
    return entry;
  }

  inspectAction(entry, descriptor, { ownLease = null } = {}) {
    const controllerBusy = !!this.currentControllerLease(entry, ownLease);
    const desiredDigest = descriptor.action === "install"
      ? this.desiredValidatorDigest()
      : null;
    if (descriptor.action === "install") {
      const diagnosis = diagnoseBaseProtectionHooks(entry.basePath, {
        ignoreActivity: true,
        skipAuditProbe: true,
        runtimeExecutablePaths: this.runtimeExecutablePaths,
      });
      const issues = safeIssues(diagnosis.issues);
      let status = String(diagnosis.status || "NOT_INSTALLED");
      let blockerCode = null;
      if (controllerBusy) {
        issues.push("ACTIVE_REPOSITORY_LEASE");
        blockerCode = "GIT_CONTROLLER_REPOSITORY_BUSY";
      } else if (status === "ACTIVE") {
        const installedDigest = installedValidatorDigest(entry.basePath);
        if (installedDigest !== desiredDigest) {
          status = "DRIFTED";
          issues.push("CAPABILITY_VALIDATOR_DRIFT");
          blockerCode = "GIT_CONTROLLER_HOOKS_VALIDATOR_DRIFT";
        }
      } else if (!["NOT_INSTALLED", "ALREADY_UNINSTALLED"].includes(status)) {
        blockerCode = "GIT_CONTROLLER_HOOKS_DRIFTED";
      }
      const uniqueIssues = safeIssues(issues);
      const inspection = {
        action: descriptor.action,
        status,
        eligible: !blockerCode,
        blockerCode,
        issues: uniqueIssues,
        validatorDigest: desiredDigest,
      };
      return { ...inspection, stateSignature: stateSignature(inspection) };
    }

    const preview = previewUninstallBaseProtectionHooks(entry.basePath, {
      activeLeaseCheck: this.activityCheck(entry, ownLease),
      runtimeExecutablePaths: this.runtimeExecutablePaths,
    });
    const issues = safeIssues(preview.issues);
    let blockerCode = null;
    if (controllerBusy || issues.includes("ACTIVE_REPOSITORY_LEASE")) {
      blockerCode = "GIT_CONTROLLER_REPOSITORY_BUSY";
    } else if (issues.includes("ACTIVE_LEGACY_LINKED_WORKTREE")) {
      blockerCode = "GIT_CONTROLLER_HOOKS_LEGACY_WORKTREE_ACTIVE";
    } else if (!["READY", "ALREADY_UNINSTALLED"].includes(preview.status)) {
      blockerCode = "GIT_CONTROLLER_HOOKS_DRIFTED";
    }
    const inspection = {
      action: descriptor.action,
      status: String(preview.status || "DRIFTED"),
      eligible: !blockerCode && preview.canUninstall === true,
      blockerCode,
      issues,
      validatorDigest: null,
    };
    return { ...inspection, stateSignature: stateSignature(inspection) };
  }

  async diagnose({ repositoryId } = {}) {
    const entry = await this.resolveEntry(repositoryId);
    const head = await this.readHead(entry);
    const diagnosis = diagnoseBaseProtectionHooks(entry.basePath, {
      ignoreActivity: true,
      skipAuditProbe: true,
      runtimeExecutablePaths: this.runtimeExecutablePaths,
    });
    const issues = safeIssues(diagnosis.issues);
    let status = String(diagnosis.status || "NOT_INSTALLED");
    if (status === "ACTIVE") {
      let desiredDigest = null;
      try {
        desiredDigest = this.desiredValidatorDigest();
      } catch {
        desiredDigest = null;
      }
      if (!desiredDigest || installedValidatorDigest(entry.basePath) !== desiredDigest) {
        status = "DRIFTED";
        issues.push("CAPABILITY_VALIDATOR_DRIFT");
      }
    }
    return {
      repositoryId: entry.repositoryId,
      status,
      protected: status === "ACTIVE",
      operationActive: !!this.currentControllerLease(entry),
      head,
      issues: safeIssues(issues),
    };
  }

  async preview({ repositoryId, action: actionValue, ttlMs } = {}) {
    const descriptor = normalizeAction(actionValue);
    const entry = await this.resolveEntry(repositoryId);
    const head = await this.readHead(entry);
    const inspection = this.inspectAction(entry, descriptor);
    const now = Date.now();
    const stored = this.persistence.createGitControllerPreview({
      previewId: randomUUID(),
      repositoryId: entry.repositoryId,
      kind: descriptor.previewKind,
      branch: HOOKS_BRANCH,
      expectedHead: head,
      candidateSha: head,
      mirrorGeneration: 0,
      relationship: inspection.status,
      eligible: inspection.eligible,
      blockerCode: inspection.blockerCode,
      remoteFingerprint: entry.remoteFingerprint,
      payload: {
        action: descriptor.action,
        protectionStatus: inspection.status,
        issues: inspection.issues,
        stateSignature: inspection.stateSignature,
        validatorDigest: inspection.validatorDigest,
      },
      createdAt: now,
      expiresAt: now + Math.max(10_000, Number(ttlMs) || this.previewTtlMs),
    });
    return {
      previewId: stored.previewId,
      previewVersion: stored.previewVersion,
      repositoryId: entry.repositoryId,
      action: descriptor.action,
      expectedHead: head,
      candidateSha: head,
      protectionStatus: inspection.status,
      eligible: stored.eligible,
      blockerCode: stored.blockerCode,
      issues: inspection.issues,
      expiresAt: stored.expiresAt,
    };
  }

  validateExecutionPreview({
    entry,
    descriptor,
    preview,
    previewVersion,
    expectedHead: expectedValue,
    candidateSha: candidateValue,
  }) {
    if (
      !preview
      || preview.kind !== descriptor.previewKind
      || preview.repositoryId !== entry.repositoryId
      || preview.branch !== HOOKS_BRANCH
      || preview.payload?.action !== descriptor.action
    ) {
      throw new GitControllerError(
        "GIT_CONTROLLER_PREVIEW_MISMATCH",
        "Managed hooks preview does not match the requested repository and action",
      );
    }
    if (preview.status !== "ACTIVE" || preview.expiresAt <= Date.now()) {
      throw new GitControllerError(
        "GIT_CONTROLLER_PREVIEW_EXPIRED",
        "Managed hooks preview expired",
      );
    }
    if (Number(preview.previewVersion) !== Number(previewVersion)) {
      throw new GitControllerError(
        "GIT_CONTROLLER_PREVIEW_VERSION_MISMATCH",
        "Managed hooks preview version changed",
      );
    }
    const expectedHead = normalizeSha(expectedValue, { label: "expected base HEAD" });
    const candidateSha = normalizeSha(candidateValue, { label: "candidate base HEAD" });
    if (
      expectedHead !== candidateSha
      || preview.expectedHead !== expectedHead
      || preview.candidateSha !== candidateSha
      || preview.remoteFingerprint !== entry.remoteFingerprint
    ) {
      throw new GitControllerError(
        "GIT_CONTROLLER_PREVIEW_STALE",
        "Managed hooks exact HEAD fields no longer match the preview",
      );
    }
    if (!preview.eligible) {
      throw new GitControllerError(
        preview.blockerCode || "GIT_CONTROLLER_PREVIEW_BLOCKED",
        "Managed hooks preview is blocked by repository policy",
      );
    }
    return { expectedHead, candidateSha };
  }

  applyAction(entry, descriptor, ownLease, operationBinding = null) {
    if (descriptor.action === "install") {
      return installBaseProtectionHooks(entry.basePath, {
        capabilityValidatorDescriptor: this.capabilityService.validatorDescriptor,
        repositoryId: entry.repositoryId,
        managementClientDescriptor: this.managementClientDescriptor,
        runtimeExecutablePaths: this.runtimeExecutablePaths,
        controllerOperationBinding: operationBinding,
      });
    }
    return uninstallBaseProtectionHooks(entry.basePath, {
      activeLeaseCheck: this.activityCheck(entry, ownLease),
      runtimeExecutablePaths: this.runtimeExecutablePaths,
      controllerOperationBinding: operationBinding,
    });
  }

  assertActionResult(descriptor, result) {
    if (descriptor.action === "install" && result.status !== "ACTIVE") {
      throw new GitControllerError(
        result.errorCode || "GIT_CONTROLLER_HOOKS_INSTALL_FAILED",
        "Managed base-protection hooks were not activated",
        { status: String(result.status || "UNKNOWN"), issues: safeIssues(result.issues) },
      );
    }
    if (
      descriptor.action === "uninstall"
      && !["UNINSTALLED", "ALREADY_UNINSTALLED"].includes(result.status)
    ) {
      throw new GitControllerError(
        result.errorCode || "GIT_CONTROLLER_HOOKS_UNINSTALL_FAILED",
        "Managed base-protection hooks were not safely uninstalled",
        { status: String(result.status || "UNKNOWN"), issues: safeIssues(result.issues) },
      );
    }
  }

  assertRecoveryPreview(entry, operation, descriptor) {
    const consumed = this.persistence.consumeGitControllerPreview(
      operation.previewId,
      operation.operationId,
    );
    const preview = consumed?.preview;
    if (
      !consumed?.ok
      || !preview
      || preview.kind !== descriptor.previewKind
      || preview.repositoryId !== entry.repositoryId
      || preview.branch !== HOOKS_BRANCH
      || preview.payload?.action !== descriptor.action
      || preview.expectedHead !== operation.expectedHead
      || preview.candidateSha !== operation.candidateSha
      || preview.remoteFingerprint !== entry.remoteFingerprint
      || preview.eligible !== true
      || !/^[0-9a-f]{64}$/.test(String(preview.payload?.stateSignature || ""))
      || (
        descriptor.action === "install"
        && !/^[0-9a-f]{64}$/.test(String(preview.payload?.validatorDigest || ""))
      )
      || (
        descriptor.action === "uninstall"
        && preview.payload?.validatorDigest != null
      )
    ) {
      throw new GitControllerError(
        "GIT_CONTROLLER_HOOKS_RECOVERY_PREVIEW_INVALID",
        "Interrupted managed hooks operation is not bound to its exact preview",
        {
          operationId: operation.operationId,
          reason: consumed?.reason || "preview_binding_mismatch",
          recoveryRequired: true,
        },
      );
    }
    return preview;
  }

  prepareRecoveryOwnership(entry, operation) {
    const current = this.persistence.getGitControllerRepositoryLease(entry.repositoryId);
    if (current && current.operationId !== operation.operationId) {
      throw new GitControllerError(
        "GIT_CONTROLLER_REPOSITORY_BUSY",
        "Another Controller operation owns the repository during hooks recovery",
        {
          operationId: operation.operationId,
          leaseOperationId: current.operationId,
          recoveryRequired: true,
        },
      );
    }
    try {
      this.leaseManager.reclaimOrphanedOperation(entry, operation);
    } catch (error) {
      if (error?.code === "GIT_CONTROLLER_OPERATION_OWNER_ACTIVE") {
        throw new GitControllerError(
          "GIT_CONTROLLER_OPERATION_IN_PROGRESS",
          "The managed hooks operation is still owned by a live Controller",
          { operationId: operation.operationId },
          { cause: error },
        );
      }
      throw error;
    }
  }

  writeRecoveryPassAuditOnce({
    operation,
    descriptor,
    actor,
    startedAt,
    fencingToken,
    details = {},
  }) {
    if (typeof this.persistence.appendGitControllerAuditOnce !== "function") {
      throw new GitControllerError(
        "GIT_CONTROLLER_AUDIT_DEDUP_UNAVAILABLE",
        "Recovery PASS audit requires atomic durable de-duplication",
        { operationId: operation.operationId, recoveryRequired: true },
      );
    }
    const appended = this.persistence.appendGitControllerAuditOnce({
      auditId: randomUUID(),
      operationId: operation.operationId,
      repositoryId: operation.repositoryId,
      commandId: descriptor.commandId,
      action: `base-protection.hooks.${descriptor.action}`,
      branch: HOOKS_BRANCH,
      beforeSha: operation.expectedHead,
      candidateSha: operation.candidateSha,
      result: "PASS",
      durationMs: Date.now() - startedAt,
      fencingToken,
      actor: safeActor(actor),
      details: { recovered: true, ...details },
      createdAt: Date.now(),
    });
    if (!appended?.ok) {
      throw new GitControllerError(
        "GIT_CONTROLLER_AUDIT_WRITE_FAILED",
        "Recovery PASS audit could not be persisted atomically",
        {
          operationId: operation.operationId,
          reason: appended?.reason || "audit_failed",
          recoveryRequired: true,
        },
      );
    }
    return appended;
  }

  assertRecoveryState(entry, operation, descriptor, preview, inspection) {
    const binding = controllerOperationBinding(operation, preview, descriptor);
    if (previewStateMatchesInspection(preview, inspection)) {
      return { binding, exactPreviewState: true, exactOwnedMutation: false };
    }
    const mutationStarted = this.persistence.listGitControllerJournal(
      operation.operationId,
    ).some((row) => row.phase === "BASE_APPLYING");
    let exactOwnedMutation = false;
    if (mutationStarted && descriptor.action === "install") {
      exactOwnedMutation = bindingMatches(
        installedOperationBinding(entry.basePath),
        binding,
      );
    } else if (mutationStarted) {
      exactOwnedMutation = bindingMatches(
        uninstallOperationEvidence(entry.basePath)?.controllerOperationBinding,
        binding,
      );
    }
    if (!exactOwnedMutation) {
      throw new GitControllerError(
        "GIT_CONTROLLER_HOOKS_RECOVERY_STATE_DRIFT",
        "Managed hooks state no longer matches the consumed preview or this operation's exact durable mutation evidence",
        {
          operationId: operation.operationId,
          action: descriptor.action,
          previewEligible: preview.eligible === true,
          currentEligible: inspection.eligible === true,
          currentStatus: inspection.status,
          recoveryRequired: true,
        },
      );
    }
    return { binding, exactPreviewState: false, exactOwnedMutation: true };
  }

  async resumeInstallOperation(
    entry,
    operation,
    actor,
    verifyInstallation = null,
  ) {
    if (typeof verifyInstallation === "function") {
      await verifyInstallation();
    }
    const recoveryPreview = this.assertRecoveryPreview(
      entry,
      operation,
      ACTIONS.install,
    );
    this.prepareRecoveryOwnership(entry, operation);
    const startedAt = Date.now();
    let lease = null;
    try {
      lease = this.leaseManager.acquire(entry, {
        operationId: operation.operationId,
        kind: "hooks-install-recovery",
      });
      lease.assertCurrent();
      await this.registry.verify(entry.repositoryId);
      const currentHead = await this.readHead(entry);
      if (
        currentHead !== operation.expectedHead
        || currentHead !== operation.candidateSha
      ) {
        throw new GitControllerError(
          "GIT_CONTROLLER_PREVIEW_STALE",
          "Base HEAD changed before managed hooks install recovery",
        );
      }
      if (typeof verifyInstallation === "function") {
        await verifyInstallation();
      }
      const before = this.inspectAction(
        entry,
        ACTIONS.install,
        { ownLease: lease },
      );
      const recoveryState = this.assertRecoveryState(
        entry,
        operation,
        ACTIONS.install,
        recoveryPreview,
        before,
      );
      this.journal.append(operation, "BASE_APPLYING", {
        action: "install",
        recovery: true,
        protectionStatus: String(before.status || "UNKNOWN"),
        exactPreviewState: recoveryState.exactPreviewState,
        exactOwnedMutation: recoveryState.exactOwnedMutation,
      }, lease.fencingToken);
      const rawResult = this.applyAction(
        entry,
        ACTIONS.install,
        lease,
        recoveryState.binding,
      );
      this.assertActionResult(ACTIONS.install, rawResult);
      lease.assertCurrent();
      const diagnosis = diagnoseBaseProtectionHooks(entry.basePath, {
        ignoreActivity: true,
        skipAuditProbe: true,
        runtimeExecutablePaths: this.runtimeExecutablePaths,
      });
      if (
        diagnosis.status !== "ACTIVE"
        || installedValidatorDigest(entry.basePath) !== this.desiredValidatorDigest()
      ) {
        throw new GitControllerError(
          "GIT_CONTROLLER_HOOKS_VERIFY_FAILED",
          "Recovered managed hooks installation could not be verified",
          { status: String(diagnosis.status || "UNKNOWN") },
        );
      }
      this.journal.append(operation, "BASE_APPLIED", {
        action: "install",
        recovery: true,
        protectionStatus: "ACTIVE",
      }, lease.fencingToken);
      const result = {
        ok: true,
        operationId: operation.operationId,
        replayed: true,
        recovered: true,
        resultCode: "PASS",
        repositoryId: entry.repositoryId,
        action: "install",
        expectedHead: operation.expectedHead,
        candidateSha: operation.candidateSha,
        protectionStatus: "ACTIVE",
        changed: String(before.status || "") !== "ACTIVE",
        hooks: hooksResult(rawResult),
      };
      this.writeRecoveryPassAuditOnce({
        operation,
        descriptor: ACTIONS.install,
        actor,
        startedAt,
        fencingToken: lease.fencingToken,
        details: {
          beforeStatus: String(before.status || "UNKNOWN"),
          coreRecovered: rawResult.recovered === true,
        },
      });
      this.journal.succeed(operation, result, lease.fencingToken);
      return result;
    } catch (rawError) {
      const error = asControllerError(
        rawError,
        "GIT_CONTROLLER_HOOKS_INSTALL_RECOVERY_FAILED",
      );
      this.journal.fail(operation, error, {
        fencingToken: lease?.fencingToken || null,
        recoveryRequired: true,
        data: { recovery: true },
      });
      throw error;
    } finally {
      lease?.release();
    }
  }

  async resumeUninstallOperation(
    entry,
    operation,
    actor,
    verifyInstallation = null,
  ) {
    if (typeof verifyInstallation === "function") {
      await verifyInstallation();
    }
    const recoveryPreview = this.assertRecoveryPreview(
      entry,
      operation,
      ACTIONS.uninstall,
    );
    this.prepareRecoveryOwnership(entry, operation);
    const startedAt = Date.now();
    let lease = null;
    try {
      lease = this.leaseManager.acquire(entry, {
        operationId: operation.operationId,
        kind: "hooks-uninstall-recovery",
      });
      lease.assertCurrent();
      await this.registry.verify(entry.repositoryId);
      const currentHead = await this.readHead(entry);
      if (
        currentHead !== operation.expectedHead
        || currentHead !== operation.candidateSha
      ) {
        throw new GitControllerError(
          "GIT_CONTROLLER_PREVIEW_STALE",
          "Base HEAD changed before managed hooks uninstall recovery",
        );
      }
      if (typeof verifyInstallation === "function") {
        await verifyInstallation();
      }
      const before = this.inspectAction(
        entry,
        ACTIONS.uninstall,
        { ownLease: lease },
      );
      const recoveryState = this.assertRecoveryState(
        entry,
        operation,
        ACTIONS.uninstall,
        recoveryPreview,
        before,
      );
      this.journal.append(operation, "BASE_APPLYING", {
        action: "uninstall",
        recovery: true,
        protectionStatus: String(before.status || "UNKNOWN"),
        exactPreviewState: recoveryState.exactPreviewState,
        exactOwnedMutation: recoveryState.exactOwnedMutation,
      }, lease.fencingToken);
      const rawResult = this.applyAction(
        entry,
        ACTIONS.uninstall,
        lease,
        recoveryState.binding,
      );
      this.assertActionResult(ACTIONS.uninstall, rawResult);
      lease.assertCurrent();
      const diagnosis = diagnoseBaseProtectionHooks(entry.basePath, {
        ignoreActivity: true,
        skipAuditProbe: true,
        runtimeExecutablePaths: this.runtimeExecutablePaths,
      });
      if (!["ALREADY_UNINSTALLED", "NOT_INSTALLED"].includes(diagnosis.status)) {
        throw new GitControllerError(
          "GIT_CONTROLLER_HOOKS_VERIFY_FAILED",
          "Recovered managed hooks uninstall could not be verified",
          { status: String(diagnosis.status || "UNKNOWN") },
        );
      }
      this.journal.append(operation, "BASE_APPLIED", {
        action: "uninstall",
        recovery: true,
        protectionStatus: String(diagnosis.status),
      }, lease.fencingToken);
      const result = {
        ok: true,
        operationId: operation.operationId,
        replayed: true,
        recovered: true,
        resultCode: "PASS",
        repositoryId: entry.repositoryId,
        action: "uninstall",
        expectedHead: operation.expectedHead,
        candidateSha: operation.candidateSha,
        protectionStatus: "ALREADY_UNINSTALLED",
        changed: true,
        hooks: hooksResult(rawResult),
      };
      this.writeRecoveryPassAuditOnce({
        operation,
        descriptor: ACTIONS.uninstall,
        actor,
        startedAt,
        fencingToken: lease.fencingToken,
        details: { recovered: true },
      });
      this.journal.succeed(operation, result, lease.fencingToken);
      return result;
    } catch (rawError) {
      const error = asControllerError(
        rawError,
        "GIT_CONTROLLER_HOOKS_UNINSTALL_RECOVERY_FAILED",
      );
      this.journal.fail(operation, error, {
        fencingToken: lease?.fencingToken || null,
        recoveryRequired: true,
        data: { recovery: true },
      });
      throw error;
    } finally {
      lease?.release();
    }
  }

  async recover() {
    const operations = [
      ...listAllRecoverableOperations(this.persistence, {
        operationType: ACTIONS.install.operationType,
      }),
      ...listAllRecoverableOperations(this.persistence, {
        operationType: ACTIONS.uninstall.operationType,
      }),
    ].sort((left, right) => (
      Number(left.startedAt || 0) - Number(right.startedAt || 0)
      || String(left.operationId).localeCompare(String(right.operationId))
    ));
    const failures = [];
    let installed = 0;
    let uninstalled = 0;
    for (const operation of operations) {
      try {
        const entry = await this.resolveEntry(operation.repositoryId);
        if (
          operation.branch !== HOOKS_BRANCH
          || !operation.expectedHead
          || operation.expectedHead !== operation.candidateSha
        ) {
          throw new GitControllerError(
            "GIT_CONTROLLER_HOOKS_RECOVERY_BINDING_INVALID",
            "Interrupted managed hooks operation has an invalid exact-HEAD binding",
            {
              operationId: operation.operationId,
              recoveryRequired: true,
            },
          );
        }
        if (operation.operationType === ACTIONS.install.operationType) {
          await this.resumeInstallOperation(
            entry,
            operation,
            "controller:hooks-install-startup-recovery",
          );
          installed += 1;
        } else {
          await this.resumeUninstallOperation(
            entry,
            operation,
            "controller:hooks-uninstall-startup-recovery",
          );
          uninstalled += 1;
        }
      } catch (error) {
        const normalized = asControllerError(
          error,
          "GIT_CONTROLLER_HOOKS_STARTUP_RECOVERY_FAILED",
        );
        const journalRows = this.persistence.listGitControllerJournal(
          operation.operationId,
        );
        if (
          normalized.code === "GIT_CONTROLLER_HOOKS_RECOVERY_PREVIEW_INVALID"
          && operation.phase === "PREVIEWED"
          && journalRows.every((row) => row.phase === "PREVIEWED")
        ) {
          const interrupted = new GitControllerError(
            "GIT_CONTROLLER_HOOKS_INTERRUPTED_BEFORE_MUTATION",
            "Interrupted managed hooks operation was safely closed before mutation",
            { operationId: operation.operationId },
          );
          this.journal.fail(operation, interrupted);
          continue;
        }
        failures.push(normalized);
      }
    }
    if (failures.length) {
      throw new GitControllerError(
        "GIT_CONTROLLER_HOOKS_STARTUP_RECOVERY_BLOCKED",
        "One or more managed hooks operations require administrative recovery",
        {
          errors: failures.map((error) => error.code),
          recoveryRequired: true,
        },
      );
    }
    return {
      recovered: operations.length,
      installed,
      uninstalled,
    };
  }

  async standaloneUninstall({
    repositoryId,
    idempotencyKey: idempotencyValue,
    actor = "controller:standalone-hooks-uninstall",
  } = {}, {
    verifyInstallation = null,
  } = {}) {
    if (typeof verifyInstallation === "function") {
      await verifyInstallation();
    }
    const idempotencyKey = assertIdempotencyKey(idempotencyValue);
    const entry = await this.resolveEntry(repositoryId);
    const existing = this.persistence.getGitControllerOperationByIdempotency(
      entry.repositoryId,
      ACTIONS.uninstall.operationType,
      idempotencyKey,
    );
    if (existing) {
      if (["RUNNING", "RECOVERY_REQUIRED"].includes(existing.status)) {
        return this.resumeUninstallOperation(
          entry,
          existing,
          actor,
          verifyInstallation,
        );
      }
      return replayOrThrow(existing);
    }
    const preview = await this.preview({
      repositoryId: entry.repositoryId,
      action: "uninstall",
    });
    if (!preview.eligible) {
      throw new GitControllerError(
        preview.blockerCode || "GIT_CONTROLLER_HOOKS_UNINSTALL_BLOCKED",
        "Standalone managed hooks uninstall is blocked by live Controller state",
      );
    }
    return this.execute({
      repositoryId: entry.repositoryId,
      action: "uninstall",
      previewId: preview.previewId,
      previewVersion: preview.previewVersion,
      expectedHead: preview.expectedHead,
      candidateSha: preview.candidateSha,
      idempotencyKey,
      actor,
    }, {
      preMutationVerify: verifyInstallation,
    });
  }

  async execute({
    repositoryId,
    action: actionValue,
    previewId,
    previewVersion,
    expectedHead: expectedValue,
    candidateSha: candidateValue,
    idempotencyKey: idempotencyValue,
    actor = null,
  } = {}, {
    preMutationVerify = null,
  } = {}) {
    const descriptor = normalizeAction(actionValue);
    const idempotencyKey = assertIdempotencyKey(idempotencyValue);
    const entry = await this.resolveEntry(repositoryId);
    const expectedInput = normalizeSha(expectedValue, { label: "expected base HEAD" });
    const candidateInput = normalizeSha(candidateValue, { label: "candidate base HEAD" });
    const replayBinding = {
      previewId,
      expectedHead: expectedInput,
      candidateSha: candidateInput,
    };
    const existing = this.persistence.getGitControllerOperationByIdempotency(
      entry.repositoryId,
      descriptor.operationType,
      idempotencyKey,
    );
    if (existing) {
      assertReplayBinding(existing, replayBinding);
      if (["RUNNING", "RECOVERY_REQUIRED"].includes(existing.status)) {
        return descriptor.action === "install"
          ? this.resumeInstallOperation(
              entry,
              existing,
              actor,
              preMutationVerify,
            )
          : this.resumeUninstallOperation(
              entry,
              existing,
              actor,
              preMutationVerify,
            );
      }
      return replayOrThrow(existing);
    }
    const preview = this.persistence.getGitControllerPreview(previewId);
    const { expectedHead, candidateSha } = this.validateExecutionPreview({
      entry,
      descriptor,
      preview,
      previewVersion,
      expectedHead: expectedInput,
      candidateSha: candidateInput,
    });
    const begun = this.journal.begin({
      repositoryId: entry.repositoryId,
      operationType: descriptor.operationType,
      commandId: descriptor.commandId,
      idempotencyKey,
      previewId,
      branch: HOOKS_BRANCH,
      expectedHead,
      candidateSha,
    });
    if (!begun.created) {
      assertReplayBinding(begun.operation, replayBinding);
      if (["RUNNING", "RECOVERY_REQUIRED"].includes(begun.operation.status)) {
        return descriptor.action === "install"
          ? this.resumeInstallOperation(
              entry,
              begun.operation,
              actor,
              preMutationVerify,
            )
          : this.resumeUninstallOperation(
              entry,
              begun.operation,
              actor,
              preMutationVerify,
            );
      }
      return replayOrThrow(begun.operation);
    }
    const operation = begun.operation;
    const consumed = this.persistence.consumeGitControllerPreview(previewId, operation.operationId);
    if (!consumed?.ok) {
      const error = new GitControllerError(
        "GIT_CONTROLLER_PREVIEW_CONSUMED",
        "Managed hooks preview was already consumed",
      );
      this.journal.fail(operation, error);
      throw error;
    }

    const startedAt = Date.now();
    let lease = null;
    let mutationAttempted = false;
    let mutationCompleted = false;
    let beforeInspection = null;
    try {
      lease = this.leaseManager.acquire(entry, {
        operationId: operation.operationId,
        kind: `hooks-${descriptor.action}`,
      });
      lease.assertCurrent();
      await this.registry.verify(entry.repositoryId);
      const currentHead = await this.readHead(entry);
      if (currentHead !== expectedHead || currentHead !== candidateSha) {
        throw new GitControllerError(
          "GIT_CONTROLLER_PREVIEW_STALE",
          "Base HEAD changed after the managed hooks preview",
        );
      }
      beforeInspection = this.inspectAction(entry, descriptor, { ownLease: lease });
      if (
        beforeInspection.stateSignature !== preview.payload?.stateSignature
        || beforeInspection.validatorDigest !== (preview.payload?.validatorDigest || null)
      ) {
        throw new GitControllerError(
          "GIT_CONTROLLER_PREVIEW_STALE",
          "Managed hooks state changed after preview",
          {
            status: beforeInspection.status,
            blockerCode: beforeInspection.blockerCode,
          },
        );
      }
      if (!beforeInspection.eligible) {
        throw new GitControllerError(
          beforeInspection.blockerCode || "GIT_CONTROLLER_PREVIEW_BLOCKED",
          "Managed hooks operation is blocked by repository policy",
        );
      }
      if (typeof preMutationVerify === "function") {
        await preMutationVerify();
      }
      this.journal.append(operation, "BASE_PREFLIGHT_PASSED", {
        action: descriptor.action,
        protectionStatus: beforeInspection.status,
      }, lease.fencingToken);
      lease.assertCurrent();
      this.journal.append(operation, "BASE_APPLYING", {
        action: descriptor.action,
      }, lease.fencingToken);
      mutationAttempted = true;
      const operationBinding = (
        descriptor.action === "install"
          ? beforeInspection.status !== "ACTIVE"
          : beforeInspection.status === "READY"
      )
        ? controllerOperationBinding(operation, preview, descriptor)
        : null;
      const rawResult = this.applyAction(
        entry,
        descriptor,
        lease,
        operationBinding,
      );
      this.assertActionResult(descriptor, rawResult);
      mutationCompleted = (
        descriptor.action === "install"
          ? beforeInspection.status !== "ACTIVE"
          : beforeInspection.status === "READY"
      );
      lease.assertCurrent();

      const diagnosis = diagnoseBaseProtectionHooks(entry.basePath, {
        ignoreActivity: true,
        skipAuditProbe: true,
        runtimeExecutablePaths: this.runtimeExecutablePaths,
      });
      if (descriptor.action === "install") {
        const desiredDigest = this.desiredValidatorDigest();
        if (
          diagnosis.status !== "ACTIVE"
          || installedValidatorDigest(entry.basePath) !== desiredDigest
        ) {
          throw new GitControllerError(
            "GIT_CONTROLLER_HOOKS_VERIFY_FAILED",
            "Managed hooks installation could not be verified",
          );
        }
      } else if (!["ALREADY_UNINSTALLED", "NOT_INSTALLED"].includes(diagnosis.status)) {
        throw new GitControllerError(
          "GIT_CONTROLLER_HOOKS_VERIFY_FAILED",
          "Managed hooks removal could not be verified",
          { status: String(diagnosis.status || "UNKNOWN") },
        );
      }
      this.journal.append(operation, "BASE_APPLIED", {
        action: descriptor.action,
        protectionStatus: String(diagnosis.status || rawResult.status),
      }, lease.fencingToken);
      const sanitized = hooksResult(rawResult);
      const result = {
        ok: true,
        operationId: operation.operationId,
        replayed: false,
        resultCode: "PASS",
        repositoryId: entry.repositoryId,
        action: descriptor.action,
        expectedHead,
        candidateSha,
        protectionStatus: descriptor.action === "install" ? "ACTIVE" : "ALREADY_UNINSTALLED",
        changed: mutationCompleted,
        hooks: sanitized,
      };
      this.audit.write({
        operation,
        commandId: descriptor.commandId,
        action: `base-protection.hooks.${descriptor.action}`,
        branch: HOOKS_BRANCH,
        beforeSha: expectedHead,
        candidateSha,
        result: "PASS",
        durationMs: Date.now() - startedAt,
        fencingToken: lease.fencingToken,
        actor: safeActor(actor),
        details: {
          changed: mutationCompleted,
          beforeStatus: beforeInspection.status,
          afterStatus: result.protectionStatus,
        },
      });
      this.journal.succeed(operation, result, lease.fencingToken);
      return result;
    } catch (rawError) {
      const error = asControllerError(
        rawError,
        descriptor.action === "install"
          ? "GIT_CONTROLLER_HOOKS_INSTALL_FAILED"
          : "GIT_CONTROLLER_HOOKS_UNINSTALL_FAILED",
      );
      const recoveryRequired = mutationAttempted && (
        mutationCompleted
        || !["GIT_CONTROLLER_PREVIEW_STALE", "GIT_CONTROLLER_PREVIEW_BLOCKED"].includes(error.code)
      );
      try {
        this.audit.write({
          operation,
          commandId: descriptor.commandId,
          action: `base-protection.hooks.${descriptor.action}`,
          branch: HOOKS_BRANCH,
          beforeSha: expectedHead,
          candidateSha,
          result: recoveryRequired ? "RECOVERY_REQUIRED" : "FAIL",
          reason: error.code,
          durationMs: Date.now() - startedAt,
          fencingToken: lease?.fencingToken || null,
          actor: safeActor(actor),
          details: {
            mutationAttempted,
            mutationCompleted,
            beforeStatus: beforeInspection?.status || null,
          },
        });
      } catch (auditError) {
        const auditFailure = asControllerError(
          auditError,
          "GIT_CONTROLLER_AUDIT_WRITE_FAILED",
        );
        this.journal.fail(operation, auditFailure, {
          fencingToken: lease?.fencingToken || null,
          recoveryRequired: true,
          data: { precedingError: error.code },
        });
        throw auditFailure;
      }
      this.journal.fail(operation, error, {
        fencingToken: lease?.fencingToken || null,
        recoveryRequired,
      });
      throw error;
    } finally {
      lease?.release();
    }
  }
}

export function createManagedHooksController(runtime, options = {}) {
  if (
    runtime?.adapter === "process"
    && runtime?.hooks
    && typeof runtime.hooks.preview === "function"
    && typeof runtime.hooks.execute === "function"
    && typeof runtime.hooks.diagnose === "function"
  ) {
    return runtime.hooks;
  }
  return new ManagedHooksController(runtime, options);
}

export const __test = Object.freeze({
  ACTIONS,
  HOOKS_BRANCH,
  installedValidatorDigest,
  runtimeLeaseActive,
  safeIssue,
  stateSignature,
  validatorDescriptorDigest,
});
