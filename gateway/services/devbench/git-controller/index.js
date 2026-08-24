import os from "node:os";
import { randomUUID } from "node:crypto";
import * as defaultPersistence from "../../../db/sqlite.js";
import { RepositoryRegistry } from "./registry.js";
import { createRepositoryLeaseManager } from "./lease.js";
import {
  createOperationJournal,
  listAllRecoverableOperations,
} from "./journal.js";
import { createControllerAudit } from "./audit.js";
import { createMirrorSyncService } from "./mirror-sync.js";
import { createBaseSyncService } from "./base-sync.js";
import {
  GitControllerError,
  runGitFile,
  streamGitNulRecords,
} from "./path-security.js";

export async function createGitController({
  definitions,
  dataRoot,
  gitBinary = "git",
  ownerInstance = `${os.hostname()}:${process.pid}:${randomUUID()}`,
  persistence = defaultPersistence,
  gitRunner,
  gitBinaryAttestor,
  knownHostsPath,
  credentialDescriptors,
  credentialDescriptorAttestor,
  gitNulStreamer,
  mirrorFaultInjector,
  leaseProcessIdentityProbe,
  leaseProcessContainment = null,
  leaseProcessTreeRecoveryProbe = null,
  leaseProcessContainmentAssertLive = null,
  leaseTtlMs = 30_000,
  previewTtlMs = 5 * 60_000,
  capabilityIssuer = null,
  continueOnDefinitionError = false,
} = {}) {
  if (
    leaseProcessContainmentAssertLive != null
    && typeof leaseProcessContainmentAssertLive !== "function"
  ) {
    throw new GitControllerError(
      "GIT_CONTROLLER_PROCESS_CONTAINMENT_ASSERT_INVALID",
      "Process containment live assertion must be a synchronous Controller-owned function",
    );
  }
  const rawGitRunner = gitRunner || runGitFile;
  const rawGitNulStreamer = gitNulStreamer || streamGitNulRecords;
  const guardedGitRunner = leaseProcessContainmentAssertLive
    ? (options = {}) => rawGitRunner({
        ...options,
        beforeGitSpawn: leaseProcessContainmentAssertLive,
      })
    : rawGitRunner;
  const guardedGitNulStreamer = leaseProcessContainmentAssertLive
    ? (options = {}) => rawGitNulStreamer({
        ...options,
        beforeGitSpawn: leaseProcessContainmentAssertLive,
      })
    : rawGitNulStreamer;
  const registry = await RepositoryRegistry.create({
    definitions,
    dataRoot,
    gitBinary,
    persistence,
    gitRunner: guardedGitRunner,
    gitBinaryAttestor,
    knownHostsPath,
    credentialDescriptors,
    credentialDescriptorAttestor,
    continueOnDefinitionError,
  });
  const leaseManager = createRepositoryLeaseManager({
    dataRoot: registry.dataRoot,
    persistence,
    ownerInstance,
    ttlMs: leaseTtlMs,
    processIdentityProbe: leaseProcessIdentityProbe,
    processContainment: leaseProcessContainment,
    processTreeRecoveryProbe: leaseProcessTreeRecoveryProbe,
    processContainmentAssertLive: leaseProcessContainmentAssertLive,
  });
  const journal = createOperationJournal({ persistence, ownerInstance });
  const audit = createControllerAudit({ persistence, actor: ownerInstance });
  const mirror = createMirrorSyncService({
    registry,
    persistence,
    leaseManager,
    journal,
    audit,
    gitRunner: guardedGitRunner,
    faultInjector: mirrorFaultInjector,
    previewTtlMs,
  });
  if (registry.list().some((entry) => entry.publicationPolicy)) {
    mirror.setRewritePublicationProvider(async ({
      repositoryId,
      droppedCommits = [],
      droppedCommitsTruncated = false,
    } = {}) => {
      const entry = registry.get(repositoryId);
      const policy = entry.publicationPolicy;
      if (!policy) {
        return {
          status: "UNKNOWN",
          publishedCommits: [],
          truncated: false,
          evidenceCode: "PROTECTED_PUBLICATION_LEDGER_MISSING",
        };
      }
      if (droppedCommitsTruncated === true) {
        return {
          status: "UNKNOWN",
          publishedCommits: [],
          truncated: true,
          evidenceId: policy.evidenceId,
          evidenceDigest: policy.evidenceDigest,
          evidenceCode: "PROTECTED_PUBLICATION_LEDGER_DROPPED_SET_TRUNCATED",
        };
      }
      const dropped = new Set(droppedCommits.map((value) => String(value).toLowerCase()));
      const publishedCommits = policy.publishedCommitShas
        .filter((sha) => dropped.has(sha));
      return {
        status: publishedCommits.length ? "PRESENT" : "UNKNOWN",
        publishedCommits,
        truncated: false,
        evidenceId: policy.evidenceId,
        evidenceDigest: policy.evidenceDigest,
        evidenceCode: publishedCommits.length
          ? "PROTECTED_EXACT_SHA_POSITIVE_LEDGER"
          : "PROTECTED_PUBLICATION_LEDGER_ABSENCE_UNPROVEN",
      };
    });
  }
  const base = createBaseSyncService({
    registry,
    mirror,
    persistence,
    leaseManager,
    journal,
    audit,
    gitRunner: guardedGitRunner,
    gitNulStreamer: guardedGitNulStreamer,
    previewTtlMs,
    capabilityIssuer,
  });
  await mirror.recover();
  await base.recover();

  return Object.freeze({
    registry,
    registrationErrors: registry.registrationErrors,
    leaseManager,
    journal,
    audit,
    mirror,
    base,
    resolvePhysicalRepository(logicalDefinitionId, options = {}) {
      return registry.getByLogicalDefinitionId(logicalDefinitionId, options);
    },
    async syncStatus({ repositoryId, branch: branchValue } = {}) {
      const { entry, branch } = await registry.resolve(repositoryId, branchValue);
      const accepted = await mirror.readAccepted(entry, branch, {
        mirrorMayBeMissing: true,
      });
      return {
        repositoryId: entry.repositoryId,
        branch,
        mirror: accepted.state,
        mirrorPresent: accepted.mirrorPresent,
        mirrorStatus: accepted.mirrorStatus,
        lease: persistence.getGitControllerRepositoryLease(entry.repositoryId),
        recoverableOperations: listAllRecoverableOperations(persistence, {
          repositoryId: entry.repositoryId,
        }),
      };
    },
    recoverableOperations(limit = 100) {
      return persistence.listGitControllerRecoverableOperations(limit);
    },
  });
}

export * from "./path-security.js";
export * from "./registry.js";
export * from "./lease.js";
export * from "./journal.js";
export * from "./audit.js";
export * from "./mirror-sync.js";
export * from "./base-sync.js";
export * from "./internal-refs.js";
