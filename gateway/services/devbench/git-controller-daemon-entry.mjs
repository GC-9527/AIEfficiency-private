import {
  assertGitControllerRegistryComplete,
  getLocalGitControllerRuntimeForDaemon,
} from "./git-controller-runtime.js";
import { createStoryRepositoryController } from "./story-repository-controller.js";
import {
  recoverAllStoryBaselineMetadata,
} from "./story-baseline-registry-recovery.js";
import { createManagedHooksController } from "./managed-hooks-controller.js";
import {
  GitControllerError,
  listAllRecoverableOperations,
} from "./git-controller/index.js";
import {
  acquireGitControllerDaemonInstanceLock,
  assertGitControllerDaemonEndpointAvailable,
  createGitControllerDaemon,
  attestGitControllerDeploymentFile,
  prepareGitControllerDataRoot,
  prepareGitControllerStoryRoot,
  readGitControllerDaemonConfig,
} from "./git-controller-daemon.js";

// Marks the dedicated Controller process for Controller-owned deployment
// topology writers. Gateway child processes never set this marker themselves.
process.env.DEVBENCH_GIT_CONTROLLER_DAEMON_RUNTIME = "1";

const config = readGitControllerDaemonConfig();
const assertContainmentLive = () => config.gitProcessContainment.refresh();
prepareGitControllerDataRoot(config);
const daemonInstanceLock = acquireGitControllerDaemonInstanceLock(config);
try {
  await assertGitControllerDaemonEndpointAvailable(config);
} catch (error) {
  daemonInstanceLock?.release?.();
  throw error;
}
prepareGitControllerStoryRoot(config);
assertContainmentLive();
const localRuntime = await getLocalGitControllerRuntimeForDaemon({
  forceReload: true,
  definitionsOverride: config.definitions,
  dataRootOverride: config.dataRoot,
  warningsOverride: [],
  gitBinaryOverride: config.gitBinaryPath,
  knownHostsPathOverride: config.knownHostsPath,
  credentialDescriptorsOverride: config.credentialDescriptors,
  credentialDescriptorAttestor: config.credentialDescriptorAttestor,
  leaseProcessContainment: config.gitProcessContainment,
  leaseProcessTreeRecoveryProbe:
    config.gitProcessContainment.proveEmpty,
  leaseProcessContainmentAssertLive: assertContainmentLive,
  continueOnDefinitionError: false,
  gitBinaryAttestor: () => {
    const git = attestGitControllerDeploymentFile({
      filePath: config.gitBinaryPath,
      expectedSha256: config.gitBinarySha256,
      expectedAclSha256: config.gitBinaryAclSha256,
      executable: true,
    });
    attestGitControllerDeploymentFile({
      filePath: config.knownHostsPath,
      expectedSha256: config.knownHostsSha256,
      expectedAclSha256: config.knownHostsAclSha256,
      label: "Git fallback known_hosts",
      driftCode: "GIT_CONTROLLER_KNOWN_HOSTS_DRIFT",
    });
    return git;
  },
});
assertGitControllerRegistryComplete({
  registrationErrors: localRuntime.controller.registrationErrors,
  warnings: localRuntime.warnings,
});
const storyRepositories = createStoryRepositoryController({
  controller: localRuntime.controller,
  storyRoot: config.storyRoot,
  dataRoot: config.dataRoot,
  workerIdentities: config.workerIdentities,
  gatewayIdentities: config.gatewayIdentities,
  humanManagerIdentities: config.humanManagerIdentities,
  controllerIdentity: config.controllerIdentity,
  workerSecretRoots: config.workerSecretRoots,
  gitSpawnGuard: assertContainmentLive,
});
assertContainmentLive();
await storyRepositories.recoverWorkerProbeTopology();
assertContainmentLive();
await storyRepositories.recoverProvisionOperations();
assertContainmentLive();
await recoverAllStoryBaselineMetadata({
  storyRepositories,
  persistence: localRuntime.controller.journal.persistence,
  leaseManager: localRuntime.controller.leaseManager,
  repositoryRegistry: localRuntime.controller.registry,
});
assertContainmentLive();
await storyRepositories.recoverQuarantines();
assertContainmentLive();
await storyRepositories.reconcileMirrorRetentions({
  kind: "story-retention-startup-reconcile",
});
const managedHooks = createManagedHooksController(localRuntime);
assertContainmentLive();
await managedHooks.recover();
const unhandledRecoverableOperations = listAllRecoverableOperations(
  localRuntime.controller.journal.persistence,
);
if (unhandledRecoverableOperations.length) {
  throw new GitControllerError(
    "GIT_CONTROLLER_RECOVERY_UNHANDLED",
    "Controller startup found recoverable operations without a completed recovery path",
    {
      operations: unhandledRecoverableOperations.map((operation) => ({
        operationId: operation.operationId,
        operationType: operation.operationType,
        repositoryId: operation.repositoryId,
        phase: operation.phase,
        status: operation.status,
      })),
    },
  );
}
const runtime = Object.freeze({
  ...localRuntime,
  storyRoot: config.storyRoot,
  storyPathBudget: config.storyPathBudget,
  workerIdentities: config.workerIdentities,
  gatewayIdentities: config.gatewayIdentities,
  humanManagerIdentities: config.humanManagerIdentities,
  workerSecretRoots: config.workerSecretRoots,
  controllerIdentity: config.controllerIdentity,
  gitProcessContainment: config.gitProcessContainment,
  gitSpawnGuard: assertContainmentLive,
  storyRepositories,
  managedHooks,
});
const daemon = await createGitControllerDaemon({
  runtime,
  config,
  instanceLock: daemonInstanceLock,
});
const readyContainment = daemon.getReadyAttestation();

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  try {
    await daemon.close();
    process.exitCode = 0;
  } catch (error) {
    process.stderr.write(
      `[git-controller] ${signal} shutdown failed: ${String(error?.code || error)}\n`,
    );
    process.exitCode = 1;
  }
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

process.stdout.write(JSON.stringify({
  ok: true,
  service: "devbench-git-controller",
  isolationLevel: readyContainment.isolationLevel,
  gitProcessContainment: readyContainment,
  endpoint: config.endpoint,
  controllerIdentity: config.controllerIdentity,
  endpointAclFingerprint: config.endpointAclFingerprint,
  keyFingerprint: config.keyFingerprint,
  storyPathBudget: config.storyPathBudget,
}) + "\n");
