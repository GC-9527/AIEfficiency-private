import { randomUUID } from "node:crypto";
import { GitControllerError } from "./git-controller/path-security.js";

export const STORY_BASELINE_OPERATION_TYPE = "STORY_BASELINE_SYNC";
export const STORY_BASELINE_REGISTRY_RECOVERY_SCHEMA =
  "devbench.story-baseline-registry-recovery.v1";
export const STORY_BASELINE_METADATA_KEYS = Object.freeze([
  "baseRevision",
  "sourceRef",
  "remoteId",
  "mirrorGeneration",
  "headRevision",
  "branch",
  "detached",
]);

const MARKER_KEYS = Object.freeze([
  "expectedEntryGeneration",
  "expectedOld",
  "expectedRegistryGeneration",
  "idempotencyKey",
  "operationId",
  "patch",
  "repositoryId",
  "schema",
  "tabId",
  "version",
].sort());

function recoveryError(code, message, details = {}) {
  return new GitControllerError(code, message, {
    recoveryRequired: true,
    ...details,
  });
}

function metadataDocument(value, label) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort())
      !== JSON.stringify([...STORY_BASELINE_METADATA_KEYS].sort())
  ) {
    throw recoveryError(
      "STORY_BASELINE_REGISTRY_RECOVERY_MARKER_INVALID",
      `${label} must contain the exact story registry metadata field set`,
    );
  }
  const document = Object.fromEntries(
    STORY_BASELINE_METADATA_KEYS.map((key) => [key, value[key]]),
  );
  if (
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(String(document.baseRevision || ""))
    || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(String(document.headRevision || ""))
    || !String(document.sourceRef || "").startsWith("refs/heads/")
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(String(document.remoteId || ""))
    || !Number.isSafeInteger(document.mirrorGeneration)
    || document.mirrorGeneration < 0
    || typeof document.branch !== "string"
    || typeof document.detached !== "boolean"
  ) {
    throw recoveryError(
      "STORY_BASELINE_REGISTRY_RECOVERY_MARKER_INVALID",
      `${label} contains invalid story registry metadata`,
    );
  }
  return Object.freeze(document);
}

export function validateStoryBaselineRegistryRecoveryPrior(prior) {
  if (
    !prior
    || typeof prior !== "object"
    || Array.isArray(prior)
    || JSON.stringify(Object.keys(prior).sort())
      !== JSON.stringify([
        "entryGeneration",
        "metadata",
        "registryGeneration",
        "repositoryId",
        "tabId",
      ])
    || !String(prior.tabId || "").trim()
    || !String(prior.repositoryId || "").trim()
    || !Number.isSafeInteger(prior.registryGeneration)
    || prior.registryGeneration < 0
    || !Number.isSafeInteger(prior.entryGeneration)
    || prior.entryGeneration < 1
  ) {
    throw recoveryError(
      "STORY_BASELINE_REGISTRY_RECOVERY_PRIOR_INVALID",
      "Story baseline registry recovery prior state is invalid",
    );
  }
  return Object.freeze({
    tabId: String(prior.tabId),
    repositoryId: String(prior.repositoryId),
    registryGeneration: prior.registryGeneration,
    entryGeneration: prior.entryGeneration,
    metadata: metadataDocument(prior.metadata, "expectedOld"),
  });
}

export function createStoryBaselineRegistryRecoveryMarker({
  prior,
  patch,
  operationId,
  idempotencyKey,
} = {}) {
  const expected = validateStoryBaselineRegistryRecoveryPrior(prior);
  return validateStoryBaselineRegistryRecoveryMarker({
    schema: STORY_BASELINE_REGISTRY_RECOVERY_SCHEMA,
    version: 1,
    tabId: expected.tabId,
    repositoryId: expected.repositoryId,
    operationId: String(operationId || ""),
    idempotencyKey: String(idempotencyKey || ""),
    expectedRegistryGeneration: expected.registryGeneration,
    expectedEntryGeneration: expected.entryGeneration,
    expectedOld: expected.metadata,
    patch: metadataDocument(patch, "patch"),
  });
}

export function validateStoryBaselineRegistryRecoveryMarker(marker, operation = null) {
  if (
    !marker
    || typeof marker !== "object"
    || Array.isArray(marker)
    || JSON.stringify(Object.keys(marker).sort()) !== JSON.stringify(MARKER_KEYS)
    || marker.schema !== STORY_BASELINE_REGISTRY_RECOVERY_SCHEMA
    || marker.version !== 1
    || !String(marker.tabId || "").trim()
    || !String(marker.repositoryId || "").trim()
    || !String(marker.operationId || "").trim()
    || !String(marker.idempotencyKey || "").trim()
    || !Number.isSafeInteger(marker.expectedRegistryGeneration)
    || marker.expectedRegistryGeneration < 0
    || !Number.isSafeInteger(marker.expectedEntryGeneration)
    || marker.expectedEntryGeneration < 1
  ) {
    throw recoveryError(
      "STORY_BASELINE_REGISTRY_RECOVERY_MARKER_INVALID",
      "Story baseline registry recovery marker is invalid",
    );
  }
  if (
    operation
    && (
      marker.operationId !== operation.operationId
      || marker.idempotencyKey !== operation.idempotencyKey
      || marker.repositoryId !== operation.repositoryId
      || operation.operationType !== STORY_BASELINE_OPERATION_TYPE
      || !["RUNNING", "SUCCEEDED"].includes(operation.status)
      || marker.patch.baseRevision !== operation.candidateSha
      || operation.result?.operationId !== operation.operationId
      || operation.result?.repositoryId !== operation.repositoryId
      || operation.result?.storyId !== marker.tabId
      || operation.result?.candidateSha !== operation.candidateSha
      || STORY_BASELINE_METADATA_KEYS.some(
        (key) => operation.result?.entryPatch?.[key] !== marker.patch[key],
      )
    )
  ) {
    throw recoveryError(
      "STORY_BASELINE_REGISTRY_RECOVERY_BINDING_INVALID",
      "Story baseline registry recovery marker does not match its durable operation",
      { operationId: String(operation?.operationId || "") },
    );
  }
  return Object.freeze({
    schema: marker.schema,
    version: 1,
    tabId: String(marker.tabId),
    repositoryId: String(marker.repositoryId),
    operationId: String(marker.operationId),
    idempotencyKey: String(marker.idempotencyKey),
    expectedRegistryGeneration: marker.expectedRegistryGeneration,
    expectedEntryGeneration: marker.expectedEntryGeneration,
    expectedOld: metadataDocument(marker.expectedOld, "expectedOld"),
    patch: metadataDocument(marker.patch, "patch"),
  });
}

export function storyBaselineRecoveryMarkerFromOperation(operation) {
  const marker = operation?.result?.registryRecoveryMarker;
  if (!marker) return null;
  return validateStoryBaselineRegistryRecoveryMarker(marker, operation);
}

export async function recoverStoryBaselineOperationMetadata({
  storyRepositories,
  persistence,
  operation,
} = {}) {
  if (operation?.result?.registryRecoveryState !== "PENDING") {
    return {
      recovered: false,
      markerNotPending: true,
      operation,
    };
  }
  const marker = storyBaselineRecoveryMarkerFromOperation(operation);
  if (!marker) return { recovered: false, markerMissing: true };
  const recovery = await storyRepositories.applyBaselineMetadataRecovery(marker);
  if (typeof persistence?.acknowledgeStoryBaselineRegistryRecovery !== "function") {
    throw recoveryError(
      "STORY_BASELINE_REGISTRY_RECOVERY_ACK_UNAVAILABLE",
      "Story baseline registry recovery acknowledgement is unavailable",
      { operationId: operation.operationId },
    );
  }
  const acknowledged = persistence.acknowledgeStoryBaselineRegistryRecovery({
    operationId: operation.operationId,
    idempotencyKey: operation.idempotencyKey,
    registryGeneration: recovery.registryGeneration,
    entryGeneration: recovery.entryGeneration,
    appliedAt: Date.now(),
  });
  if (!acknowledged?.ok) {
    throw recoveryError(
      "STORY_BASELINE_REGISTRY_RECOVERY_ACK_FAILED",
      "Story baseline registry recovery acknowledgement failed",
      {
        operationId: operation.operationId,
        reason: acknowledged?.reason || "ack_failed",
      },
    );
  }
  return {
    ...recovery,
    acknowledged: true,
    operation: acknowledged.operation,
  };
}

export async function recoverStoryBaselineMetadataByIdempotency({
  storyRepositories,
  persistence,
  repositoryId,
  idempotencyKey,
} = {}) {
  if (typeof persistence?.getGitControllerOperationByIdempotency !== "function") {
    throw recoveryError(
      "STORY_BASELINE_REGISTRY_RECOVERY_PERSISTENCE_INVALID",
      "Story baseline recovery requires the durable operation journal",
    );
  }
  const operation = persistence.getGitControllerOperationByIdempotency(
    String(repositoryId || ""),
    STORY_BASELINE_OPERATION_TYPE,
    String(idempotencyKey || ""),
  );
  if (!operation || operation.status !== "SUCCEEDED") {
    return { found: !!operation, operation, recovered: false };
  }
  const recovery = await recoverStoryBaselineOperationMetadata({
    storyRepositories,
    persistence,
    operation,
  });
  return { found: true, operation, ...recovery };
}

function ensureRecoveredBaselinePassAudit(persistence, operation) {
  if (typeof persistence?.appendGitControllerAuditOnce !== "function") {
    throw recoveryError(
      "STORY_BASELINE_OPERATION_RECOVERY_AUDIT_UNAVAILABLE",
      "Orphaned story baseline recovery requires a durable de-duplicated PASS audit",
      {
        operationId: operation.operationId,
        repositoryId: operation.repositoryId,
      },
    );
  }
  const result = operation.result || {};
  const appended = persistence.appendGitControllerAuditOnce({
    auditId: randomUUID(),
    operationId: operation.operationId,
    repositoryId: operation.repositoryId,
    commandId: operation.commandId || "story.baseline.refresh",
    action: "story.baseline.apply",
    branch: operation.branch || null,
    beforeSha: operation.expectedHead || result.beforeHead || null,
    candidateSha: operation.candidateSha || result.candidateSha || null,
    result: "PASS",
    reason: "recovered_after_controller_crash",
    durationMs: Math.max(0, Date.now() - Number(operation.startedAt || Date.now())),
    fencingToken: operation.fencingToken,
    actor: "controller:startup-recovery",
    details: {
      storyId: result.storyId || null,
      previousBaseRevision: result.previousBaseRevision || null,
      mirrorGeneration: result.mirrorGeneration ?? null,
      relationship: result.relationship || null,
      recoveredAfterCrash: true,
    },
    createdAt: Date.now(),
  });
  if (!appended?.ok) {
    throw recoveryError(
      "STORY_BASELINE_OPERATION_RECOVERY_AUDIT_FAILED",
      "Orphaned story baseline PASS audit could not be persisted",
      {
        operationId: operation.operationId,
        repositoryId: operation.repositoryId,
        reason: appended?.reason || "audit_failed",
      },
    );
  }
  return appended;
}

export async function recoverAllStoryBaselineMetadata({
  storyRepositories,
  persistence,
  leaseManager = storyRepositories?.controller?.leaseManager,
  repositoryRegistry = storyRepositories?.controller?.registry,
} = {}) {
  if (
    typeof persistence?.listGitControllerOperationsByType !== "function"
    || typeof persistence?.getGitControllerOperation !== "function"
  ) {
    throw recoveryError(
      "STORY_BASELINE_REGISTRY_RECOVERY_PERSISTENCE_INVALID",
      "Daemon startup recovery requires durable operation enumeration",
    );
  }
  const operations = persistence.listGitControllerOperationsByType(
    STORY_BASELINE_OPERATION_TYPE,
  );
  const results = [];
  let orphanedCompleted = 0;
  for (const listedOperation of operations) {
    let operation = persistence.getGitControllerOperation(
      listedOperation.operationId,
    ) || listedOperation;
    if (operation.status === "FAILED") continue;
    if (operation.status === "RECOVERY_REQUIRED") {
      throw recoveryError(
        "STORY_BASELINE_STARTUP_RECOVERY_REQUIRED",
        "A story baseline operation requires manual recovery before Controller startup",
        {
          operationId: operation.operationId,
          repositoryId: operation.repositoryId,
          resultCode: operation.resultCode,
        },
      );
    }
    if (operation.status === "RUNNING") {
      if (
        typeof leaseManager?.reclaimOrphanedOperation !== "function"
        || typeof repositoryRegistry?.get !== "function"
        || typeof persistence?.recoverGitControllerOperation !== "function"
      ) {
        throw recoveryError(
          "STORY_BASELINE_OPERATION_RECOVERY_DEPENDENCY_INVALID",
          "RUNNING story baseline recovery requires owner, lease and repository recovery services",
          {
            operationId: operation.operationId,
            repositoryId: operation.repositoryId,
          },
        );
      }
      const repository = repositoryRegistry.get(operation.repositoryId);
      leaseManager.reclaimOrphanedOperation(repository, operation);
      let marker;
      let inspected;
      try {
        if (operation.result?.registryRecoveryState !== "PENDING") {
          throw recoveryError(
            "STORY_BASELINE_OPERATION_RECOVERY_CHECKPOINT_MISSING",
            "Orphaned story baseline has no explicit pending recovery checkpoint",
            {
              operationId: operation.operationId,
              repositoryId: operation.repositoryId,
              phase: operation.phase,
            },
          );
        }
        marker = storyBaselineRecoveryMarkerFromOperation(operation);
        if (!marker) {
          throw recoveryError(
            "STORY_BASELINE_OPERATION_RECOVERY_CHECKPOINT_MISSING",
            "Orphaned story baseline has no exact durable recovery checkpoint",
            {
              operationId: operation.operationId,
              repositoryId: operation.repositoryId,
              phase: operation.phase,
            },
          );
        }
        if (typeof storyRepositories?.inspectBaselineMetadataRecovery !== "function") {
          throw recoveryError(
            "STORY_BASELINE_OPERATION_RECOVERY_INSPECTOR_INVALID",
            "Story repository exact-state recovery inspector is unavailable",
            {
              operationId: operation.operationId,
              repositoryId: operation.repositoryId,
            },
          );
        }
        inspected = await storyRepositories.inspectBaselineMetadataRecovery(marker);
        ensureRecoveredBaselinePassAudit(persistence, operation);
      } catch (error) {
        const serialized = {
          code: String(error?.code || "STORY_BASELINE_OPERATION_RECOVERY_FAILED"),
          message: String(
            error?.message || "Story baseline orphan recovery failed",
          ).slice(0, 1000),
          details: {
            ...(error?.details && typeof error.details === "object"
              ? error.details
              : {}),
            recoveryRequired: true,
          },
        };
        const failed = persistence.recoverGitControllerOperation({
          operationId: operation.operationId,
          expectedOwnerInstance: operation.ownerInstance,
          expectedUpdatedAt: operation.updatedAt,
          status: "RECOVERY_REQUIRED",
          phase: "RECOVERY_REQUIRED",
          resultCode: serialized.code,
          result: operation.result,
          error: serialized,
          fencingToken: operation.fencingToken,
          data: {
            reason: serialized.code,
            exactStateVerified: false,
          },
          completedAt: Date.now(),
        });
        if (!failed?.ok && failed?.operation?.status !== "RECOVERY_REQUIRED") {
          throw recoveryError(
            "STORY_BASELINE_OPERATION_RECOVERY_CAS_FAILED",
            "Orphaned story baseline recovery state changed concurrently",
            {
              operationId: operation.operationId,
              repositoryId: operation.repositoryId,
              reason: failed?.reason || "recovery_cas_failed",
            },
          );
        }
        throw recoveryError(
          "STORY_BASELINE_STARTUP_RECOVERY_REQUIRED",
          "Orphaned story baseline requires manual recovery before Controller startup",
          {
            operationId: operation.operationId,
            repositoryId: operation.repositoryId,
            reason: serialized.code,
          },
        );
      }
      const recoveredResult = Object.freeze({
        ...operation.result,
        recoveredAfterCrash: true,
        recoveredHeadRevision: inspected.headRevision,
      });
      const completed = persistence.recoverGitControllerOperation({
        operationId: operation.operationId,
        expectedOwnerInstance: operation.ownerInstance,
        expectedUpdatedAt: operation.updatedAt,
        status: "SUCCEEDED",
        phase: "VERIFIED",
        resultCode: recoveredResult.resultCode || "PASS",
        result: recoveredResult,
        error: null,
        fencingToken: operation.fencingToken,
        data: {
          resultCode: recoveredResult.resultCode || "PASS",
          recoveredAfterCrash: true,
          headRevision: inspected.headRevision,
        },
        completedAt: Date.now(),
      });
      if (!completed?.ok) {
        if (completed?.operation?.status !== "SUCCEEDED") {
          throw recoveryError(
            "STORY_BASELINE_OPERATION_RECOVERY_CAS_FAILED",
            "Orphaned story baseline completion changed concurrently",
            {
              operationId: operation.operationId,
              repositoryId: operation.repositoryId,
              reason: completed?.reason || "recovery_cas_failed",
            },
          );
        }
        operation = completed.operation;
      } else {
        operation = completed.operation;
        orphanedCompleted += 1;
      }
    }
    if (operation.status !== "SUCCEEDED") continue;
    if (
      !operation?.result?.registryRecoveryMarker
      || operation.result.registryRecoveryState !== "PENDING"
    ) {
      continue;
    }
    results.push(await recoverStoryBaselineOperationMetadata({
      storyRepositories,
      persistence,
      operation,
    }));
  }
  return Object.freeze({
    scanned: operations.length,
    markers: results.length,
    applied: results.filter((item) => item.applied === true).length,
    alreadyApplied: results.filter((item) => item.alreadyApplied === true).length,
    orphanedCompleted,
  });
}
