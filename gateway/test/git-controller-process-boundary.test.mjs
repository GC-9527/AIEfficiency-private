import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { hostname, tmpdir } from "node:os";
import {
  generateKeyPairSync,
  randomUUID,
  sign,
} from "node:crypto";
import { spawn } from "node:child_process";
import { test } from "node:test";
import {
  __test as gitControllerClientTest,
  GitControllerProcessClient,
} from "../services/devbench/git-controller-client.js";
import {
  GitControllerDaemon,
  acquireGitControllerDaemonInstanceLock,
  assertGitControllerStoryPathBudget,
  attestGitControllerProcessTreeContainment,
  createGitControllerCommandDispatcher,
  diagnoseGitControllerStoryPathBudget,
  prepareGitControllerDataRoot,
  probeUnixControllerEndpoint,
  refreshStoryAcceptedRevision,
  validateGitControllerProcessTreeAttestation,
  validateUnixIpcIdentityPolicy,
} from "../services/devbench/git-controller-daemon.js";
import {
  createStoryBaselineRegistryRecoveryMarker,
  recoverAllStoryBaselineMetadata,
} from "../services/devbench/story-baseline-registry-recovery.js";
import {
  __test as gitControllerProtocolTest,
  GIT_CONTROLLER_PROTOCOL_VERSION,
  canonicalProtocolJson,
  createControllerRequest,
  currentProcessIdentity,
  publicKeyFingerprint,
  readProtectedFile,
  storyAcceptedRefreshIdempotencyKey,
  validateControllerCommand,
  validateControllerEndpoint,
  verifyControllerResponseEnvelope,
} from "../services/devbench/git-controller-process-protocol.js";
import {
  assertGitControllerRegistryComplete,
  getLocalGitControllerRuntimeForDaemon,
  getGitControllerRuntime,
  resetGitControllerRuntimeForTests,
} from "../services/devbench/git-controller-runtime.js";
import {
  createRepositoryLeaseManager,
  processStartIdentity,
} from "../services/devbench/git-controller/lease.js";
import {
  __test as gitPathSecurityTest,
  resolveExecutable,
  runGitFile,
  streamGitNulRecords,
} from "../services/devbench/git-controller/path-security.js";

function endpoint(name) {
  const suffix = `${name}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return process.platform === "win32"
    ? `\\\\.\\pipe\\devbench-git-controller-${suffix}`
    : path.join(tmpdir(), `devbench-git-controller-${suffix}.sock`);
}

function containmentMode(platform = process.platform) {
  return platform === "win32"
    ? "WINDOWS_JOB_KILL_ON_CLOSE"
    : "LINUX_CGROUP_V2_SUPERVISED";
}

function signedGuardianEnvelope(receipt, privateKey) {
  return {
    receipt,
    signature: sign(
      null,
      Buffer.from(canonicalProtocolJson(receipt)),
      privateKey,
    ).toString("base64"),
  };
}

function createSyntheticContainment({
  controllerIdentity = currentProcessIdentity(),
  containerEpoch = `test-epoch-${randomUUID()}`,
  guardianInstanceId = `test-guardian-${randomUUID()}`,
  daemonInstanceId = randomUUID(),
  now = () => Date.now(),
} = {}) {
  const guardianKeys = generateKeyPairSync("ed25519");
  const guardianKeyId = publicKeyFingerprint(
    guardianKeys.publicKey.export({ type: "spki", format: "der" }),
  );
  const guardianBinarySha256 = "2".repeat(64);
  const guardianAclSha256 = "3".repeat(64);
  const gitBinarySha256 = "4".repeat(64);
  const policyDigest = "5".repeat(64);
  const containerPolicyId = "devbench-git-controller-v2";
  const mode = containmentMode();
  const guardianPublicKeyPem = guardianKeys.publicKey.export({
    type: "spki",
    format: "pem",
  });
  let guardianAvailable = true;
  const runner = (_executable, args) => {
    if (!guardianAvailable) throw new Error("guardian channel closed");
    const issuedAt = Number(now());
    if (args[0] === "--devbench-attest-git-process-tree-v2") {
      const receipt = {
        schemaVersion: 2,
        receiptType: "GIT_PROCESS_TREE_CONTAINMENT",
        daemonInstanceId: args[1],
        pid: Number(args[2]),
        processStartIdentity: args[3],
        controllerIdentity,
        challenge: args[4],
        platform: process.platform,
        mode,
        containerPolicyId: args[7],
        containerEpoch,
        policyDigest: args[6],
        guardianKeyId: args[8],
        guardianInstanceId,
        guardianPid: 4242,
        guardianProcessStartIdentity: process.platform === "win32"
          ? "windows-start:4242"
          : "linux-start:4242",
        guardianBinarySha256,
        gitBinarySha256: args[5],
        issuedAt,
        expiresAt: issuedAt + 5_000,
        currentProcessContained: true,
        childInheritanceEnforced: true,
        breakawayDenied: true,
        controllerExitKillsTree: true,
        recoveryCanProveEmpty: true,
      };
      return `DEVBENCH_GIT_PROCESS_TREE_ATTESTATION_V2=${
        Buffer.from(JSON.stringify(
          signedGuardianEnvelope(receipt, guardianKeys.privateKey),
        )).toString("base64url")
      }\n`;
    }
    if (args[0] === "--devbench-seal-and-prove-git-process-tree-empty-v2") {
      const receipt = {
        schemaVersion: 2,
        receiptType: "GIT_PROCESS_TREE_RECOVERY_EMPTY",
        daemonInstanceId: args[1],
        challenge: args[4],
        platform: process.platform,
        mode,
        containerPolicyId: args[6],
        currentContainerEpoch: args[2],
        priorContainerEpoch: args[3],
        policyDigest: args[5],
        guardianKeyId: args[7],
        guardianInstanceId,
        guardianBinarySha256,
        gitBinarySha256: args[8],
        tombstoneId: `tombstone-${randomUUID()}`,
        sealedAt: issuedAt,
        issuedAt,
        expiresAt: issuedAt + 5_000,
        containerSealed: true,
        activeProcessCount: 0,
      };
      return `DEVBENCH_GIT_PROCESS_TREE_EMPTY_V2=${
        Buffer.from(JSON.stringify(
          signedGuardianEnvelope(receipt, guardianKeys.privateKey),
        )).toString("base64url")
      }\n`;
    }
    throw new Error(`unexpected guardian command: ${args[0]}`);
  };
  const descriptor = {
    schemaVersion: 2,
    mode,
    guardianPath: process.platform === "win32"
      ? "C:\\protected\\devbench-git-guardian.exe"
      : "/protected/devbench-git-guardian",
    guardianSha256: guardianBinarySha256,
    guardianAclSha256,
    guardianPublicKeyPath: process.platform === "win32"
      ? "C:\\protected\\devbench-git-guardian.pub"
      : "/protected/devbench-git-guardian.pub",
    guardianKeyId,
    containerPolicyId,
    policyDigest,
  };
  const session = attestGitControllerProcessTreeContainment({
    descriptor,
    controllerIdentity,
    gitBinarySha256,
    daemonInstanceId,
    now,
    runner,
    fileAttestor: () => ({
      path: descriptor.guardianPath,
      contentSha256: guardianBinarySha256,
      aclSha256: guardianAclSha256,
    }),
    publicKeyReader: () => guardianPublicKeyPem,
  });
  const clientPolicy = Object.freeze({
    schemaVersion: 2,
    mode,
    containerPolicyId,
    policyDigest,
    guardianKeyId,
    guardianBinarySha256,
    gitBinarySha256,
    guardianPublicKey: guardianKeys.publicKey,
  });
  return {
    clientPolicy,
    descriptor,
    guardianKeys,
    disableGuardian() {
      guardianAvailable = false;
    },
    runner,
    session,
  };
}

test("daemon deployment schema endpoint is compatible with runtime string endpoints", () => {
  const schema = JSON.parse(fs.readFileSync(
    new URL("../config/git-controller-daemon.schema.example.json", import.meta.url),
    "utf8",
  ));
  assert.equal(schema.properties.endpoint.type, "string");
  assert.equal(schema.properties.endpoint.minLength, 1);
  assert.ok(schema.required.includes("gitProcessContainment"));
  assert.equal(
    schema.properties.gitProcessContainment.$ref,
    "#/$defs/gitProcessContainment",
  );
  assert.equal(schema.$defs.gitProcessContainment.properties.schemaVersion.const, 2);
  assert.ok(schema.$defs.gitProcessContainment.required.includes("guardianKeyId"));
  assert.ok(schema.$defs.gitProcessContainment.required.includes("policyDigest"));
  assert.equal(
    schema.$defs.gitProcessContainment.required.includes("expectedContainerIdentity"),
    false,
  );
  assert.equal(
    schema.$defs.gitProcessContainment.properties.mode.enum.includes(
      "MACOS_NATIVE_TREE_SUPERVISOR",
    ),
    false,
  );
  const clientSchema = JSON.parse(fs.readFileSync(
    new URL("../config/git-controller-client.schema.example.json", import.meta.url),
    "utf8",
  ));
  assert.ok(clientSchema.required.includes("gitProcessContainment"));
  assert.equal(
    clientSchema.$defs.gitProcessContainment.properties.schemaVersion.const,
    2,
  );
  assert.ok(
    clientSchema.$defs.gitProcessContainment.required.includes("guardianKeyId"),
  );

  const windowsEndpoint = String.raw`\\.\pipe\devbench-git-controller-production`;
  assert.equal(
    validateControllerEndpoint(windowsEndpoint, { platform: "win32" }),
    windowsEndpoint,
  );
  const unixEndpoint = path.resolve(tmpdir(), "devbench-git-controller-production.sock");
  assert.equal(
    validateControllerEndpoint(unixEndpoint, { platform: "linux" }),
    unixEndpoint,
  );
  assert.throws(
    () => validateControllerEndpoint({}, { platform: "win32" }),
    { code: "GIT_CONTROLLER_ENDPOINT_INVALID" },
  );
});

test("STRONG process-tree evidence is guardian-signed, challenge-bound, and short-lived", () => {
  const controllerIdentity = currentProcessIdentity();
  const synthetic = createSyntheticContainment({ controllerIdentity });
  const challenge = "a".repeat(48);
  synthetic.session.refresh({ attestationChallenge: challenge });
  const evidence = synthetic.session.publicEvidence({ attestationChallenge: challenge });
  const receipt = evidence.receipt;
  const verificationOptions = {
    publicKey: synthetic.clientPolicy.guardianPublicKey,
    platform: process.platform,
    mode: synthetic.clientPolicy.mode,
    daemonInstanceId: receipt.daemonInstanceId,
    ownerPid: process.pid,
    ownerProcessStartIdentity: receipt.processStartIdentity,
    controllerIdentity,
    challenge,
    containerPolicyId: synthetic.clientPolicy.containerPolicyId,
    containerEpoch: receipt.containerEpoch,
    policyDigest: synthetic.clientPolicy.policyDigest,
    guardianKeyId: synthetic.clientPolicy.guardianKeyId,
    guardianBinarySha256: synthetic.clientPolicy.guardianBinarySha256,
    gitBinarySha256: synthetic.clientPolicy.gitBinarySha256,
    guardianInstanceId: receipt.guardianInstanceId,
    now: Date.now(),
  };
  const attested = validateGitControllerProcessTreeAttestation({
    receipt,
    signature: evidence.signature,
  }, verificationOptions);
  assert.equal(attested.controllerExitKillsTree, true);
  const rsaKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  assert.throws(
    () => validateGitControllerProcessTreeAttestation({
      receipt,
      signature: evidence.signature,
    }, {
      ...verificationOptions,
      publicKey: rsaKeys.publicKey,
    }),
    { code: "GIT_CONTROLLER_PROCESS_TREE_GUARDIAN_KEY_ALGORITHM_INVALID" },
  );
  assert.throws(
    () => validateGitControllerProcessTreeAttestation({
      receipt: { ...receipt, challenge: "b".repeat(48) },
      signature: evidence.signature,
    }, verificationOptions),
    { code: "GIT_CONTROLLER_PROCESS_TREE_ATTESTATION_INVALID" },
  );
});

test("protected native guardian issues a branded session and signed recovery tombstone", () => {
  const synthetic = createSyntheticContainment();
  assert.equal(synthetic.session.isolationLevel, "STRONG");
  assert.match(synthetic.session.containerEpoch, /^test-epoch-/);
  const proof = synthetic.session.proveEmpty({
    containerEpoch: `prior-epoch-${randomUUID()}`,
  });
  assert.equal(proof.containerSealed, true);
  assert.equal(proof.containerClosed, true);
  assert.equal(proof.activeProcessCount, 0);
  assert.match(proof.tombstoneId, /^tombstone-/);
});

test("shared mirror and base Git execution force Windows longpaths without restoring ambient config", () => {
  assert.deepEqual(
    gitPathSecurityTest.gitLongPathsConfigArgs("win32"),
    ["-c", "core.longpaths=true"],
  );
  assert.deepEqual(gitPathSecurityTest.gitLongPathsConfigArgs("linux"), []);
  const executionRoot = fs.mkdtempSync(path.join(tmpdir(), "git-controller-longpaths-"));
  try {
    const knownHostsPath = path.join(executionRoot, "known-hosts");
    fs.writeFileSync(knownHostsPath, "");
    const common = {
      gitBinary: process.execPath,
      disabledHooksPath: executionRoot,
      knownHostsPath,
      env: {},
    };
    const executions = [
      gitPathSecurityTest.prepareGitExecution({
        ...common,
        commandId: "test.mirror.longpaths",
        args: ["--git-dir", path.join(executionRoot, "mirror.git"), "fetch"],
      }),
      gitPathSecurityTest.prepareGitExecution({
        ...common,
        commandId: "test.base.longpaths",
        args: [
          "-C",
          path.join(executionRoot, "base"),
          "merge",
          "--ff-only",
          "a".repeat(40),
        ],
      }),
    ];
    for (const execution of executions) {
      const longPathsIndex = execution.hardenedArgs.indexOf("core.longpaths=true");
      if (process.platform === "win32") {
        assert.ok(longPathsIndex > 0);
        assert.equal(execution.hardenedArgs[longPathsIndex - 1], "-c");
        assert.equal(
          execution.hardenedArgs.filter((arg) => arg === "core.longpaths=true").length,
          1,
        );
        assert.equal(execution.executionEnv.GIT_CONFIG_GLOBAL, "NUL");
      } else {
        assert.equal(longPathsIndex, -1);
        assert.equal(execution.executionEnv.GIT_CONFIG_GLOBAL, "/dev/null");
      }
      assert.equal(execution.executionEnv.GIT_CONFIG_NOSYSTEM, "1");
    }
  } finally {
    fs.rmSync(executionRoot, { recursive: true, force: true });
  }
});

test("daemon story-root diagnostics budget creating UUID paths and deep tracked files", async () => {
  const storyRoot = path.resolve(tmpdir(), "devbench-story-path-budget");
  const budget = diagnoseGitControllerStoryPathBudget(storyRoot, {
    platform: "win32",
    trackedRelativePathBudget: 512,
  });
  assert.equal(budget.creatingLeafLength, 106);
  assert.equal(
    budget.creatingRepositoryPathLength - budget.finalRepositoryPathLength,
    47,
  );
  assert.equal(
    budget.projectedTrackedPathLength,
    budget.creatingRepositoryPathLength + 1 + 512,
  );
  assert.equal(budget.longPathsRequired, true);
  assert.equal(budget.exceedsWindowsExtendedLimit, false);
  assert.equal(budget.status, "LONG_PATHS_REQUIRED");
  const dispatch = createGitControllerCommandDispatcher({
    controller: {
      registry: { entries: new Map() },
      mirror: {},
      base: {},
      registrationErrors: [],
    },
    managedHooks: {},
    storyRepositories: {},
    storyPathBudget: budget,
    warnings: [],
  });
  assert.deepEqual(
    (await dispatch("runtime.describe", {})).storyPathBudget,
    budget,
  );

  const oversizedRoot = path.resolve(
    path.parse(storyRoot).root,
    "x".repeat(32_000),
  );
  assert.throws(
    () => assertGitControllerStoryPathBudget(oversizedRoot, {
      platform: "win32",
      trackedRelativePathBudget: 1_024,
    }),
    {
      code: "GIT_CONTROLLER_STORY_ROOT_PATH_BUDGET_EXCEEDED",
    },
  );
});

test("story accepted refresh reuses the original mirror preview after a lost response", async () => {
  const candidateSha = "a".repeat(40);
  const payload = {
    storyId: "story-lost-response",
    repositoryId: "repository-main",
    branch: "main",
    exactSha: candidateSha,
  };
  payload.idempotencyKey = storyAcceptedRefreshIdempotencyKey(payload);
  let operation = null;
  let previewCount = 0;
  const controller = {
    journal: {
      persistence: {
        getGitControllerOperationByIdempotency() {
          return operation;
        },
      },
    },
    mirror: {
      async preview() {
        previewCount += 1;
        return {
          eligible: true,
          previewId: "preview-original",
          previewVersion: 7,
          lastAcceptedSha: null,
          candidateSha,
        };
      },
      async execute(request) {
        if (!operation) {
          operation = {
            previewId: request.previewId,
            expectedHead: null,
            candidateSha: request.candidateSha,
          };
        } else {
          assert.equal(request.previewId, "preview-original");
          assert.equal(request.candidateSha, candidateSha);
        }
        return { candidateSha, replayed: operation.previewId === request.previewId };
      },
      async resolveAcceptedCandidate(request) {
        return request;
      },
    },
  };

  const first = await refreshStoryAcceptedRevision(controller, payload);
  const replay = await refreshStoryAcceptedRevision(controller, payload);
  assert.equal(first.candidateSha, candidateSha);
  assert.deepEqual(replay, first);
  assert.equal(previewCount, 1);
  await assert.rejects(
    refreshStoryAcceptedRevision(controller, {
      ...payload,
      exactSha: "b".repeat(40),
    }),
    { code: "GIT_CONTROLLER_IDEMPOTENCY_BINDING_INVALID" },
  );
});

test("process Controller normalizes story baseline strategy before protocol validation", () => {
  assert.equal(gitControllerClientTest.normalizeBaselineStrategy("merge"), "MERGE");
  assert.equal(gitControllerClientTest.normalizeBaselineStrategy("ff-only"), "FF_ONLY");
  assert.throws(
    () => gitControllerClientTest.normalizeBaselineStrategy("rebase"),
    { code: "STORY_BASELINE_STRATEGY_REJECTED" },
  );
});

function baselineMetadata({
  baseRevision,
  headRevision = baseRevision,
  mirrorGeneration,
} = {}) {
  return {
    baseRevision,
    sourceRef: "refs/heads/main",
    remoteId: "origin",
    mirrorGeneration,
    headRevision,
    branch: "story/process-boundary",
    detached: false,
  };
}

function baselineRecoveryHarness({ status = "SUCCEEDED" } = {}) {
  const oldSha = "a".repeat(40);
  const candidateSha = "b".repeat(40);
  const operationId = randomUUID();
  const idempotencyKey = randomUUID();
  const prior = {
    tabId: "story-process-recovery",
    repositoryId: "repository-main",
    registryGeneration: 7,
    entryGeneration: 3,
    metadata: baselineMetadata({
      baseRevision: oldSha,
      mirrorGeneration: 1,
    }),
  };
  const patch = baselineMetadata({
    baseRevision: candidateSha,
    mirrorGeneration: 2,
  });
  const marker = createStoryBaselineRegistryRecoveryMarker({
    prior,
    patch,
    operationId,
    idempotencyKey,
  });
  let operation = {
    operationId,
    repositoryId: prior.repositoryId,
    operationType: "STORY_BASELINE_SYNC",
    commandId: "story.baseline.refresh",
    idempotencyKey,
    previewId: "preview-process-recovery",
    branch: "main",
    expectedHead: oldSha,
    candidateSha,
    status,
    phase: status === "RUNNING" ? "BASE_APPLIED" : "VERIFIED",
    resultCode: status === "SUCCEEDED" ? "PASS" : null,
    result: {
      ok: true,
      operationId,
      replayed: false,
      resultCode: "PASS",
      repositoryId: prior.repositoryId,
      storyId: prior.tabId,
      candidateSha,
      entryPatch: {
        ...patch,
        baseRef: patch.sourceRef,
        resolvedRef: patch.sourceRef,
      },
      registryRecoveryMarker: marker,
      registryRecoveryState: "PENDING",
    },
    error: null,
    ownerInstance: "dead-controller-instance",
    ownerHostname: hostname(),
    ownerPid: 2_147_483_647,
    ownerProcessStartIdentity: "windows-start:111",
    fencingToken: 41,
    startedAt: 1,
    updatedAt: 2,
    completedAt: status === "SUCCEEDED" ? 3 : null,
  };
  const state = {
    registryGeneration: prior.registryGeneration,
    entryGeneration: prior.entryGeneration,
    metadata: { ...prior.metadata },
    applyCount: 0,
    reclaimCount: 0,
    lastAppliedBaselineOperationId: null,
    journal: [],
    audits: status === "SUCCEEDED"
      ? [{
        auditId: randomUUID(),
        operationId,
        action: "story.baseline.apply",
        result: "PASS",
      }]
      : [],
  };
  const persistence = {
    listGitControllerOperationsByType(operationType) {
      assert.equal(operationType, "STORY_BASELINE_SYNC");
      return [operation];
    },
    getGitControllerOperation(id) {
      return id === operation.operationId ? operation : null;
    },
    recoverGitControllerOperation(request) {
      if (
        operation.status !== "RUNNING"
        || request.expectedOwnerInstance !== operation.ownerInstance
        || request.expectedUpdatedAt !== operation.updatedAt
      ) {
        return {
          ok: false,
          reason: "operation_recovery_cas_failed",
          operation,
        };
      }
      operation = {
        ...operation,
        status: request.status,
        phase: request.phase,
        resultCode: request.resultCode,
        result: request.result,
        error: request.error,
        updatedAt: request.completedAt,
        completedAt: request.completedAt,
      };
      state.journal.push({
        operationId: operation.operationId,
        phase: request.phase,
        data: request.data,
      });
      return { ok: true, operation };
    },
    acknowledgeStoryBaselineRegistryRecovery(request) {
      if (
        operation.status !== "SUCCEEDED"
        || operation.result?.registryRecoveryState !== "PENDING"
        || request.operationId !== operation.operationId
        || request.idempotencyKey !== operation.idempotencyKey
      ) {
        return {
          ok: false,
          reason: "operation_not_acknowledgeable",
          operation,
        };
      }
      operation = {
        ...operation,
        result: {
          ...operation.result,
          registryRecoveryState: "APPLIED",
          registryRecoveryRegistryGeneration: request.registryGeneration,
          registryRecoveryEntryGeneration: request.entryGeneration,
        },
        updatedAt: request.appliedAt,
      };
      return { ok: true, replay: false, operation };
    },
    appendGitControllerAuditOnce(row) {
      const existing = state.audits.find((audit) => (
        audit.operationId === row.operationId
        && audit.action === row.action
        && audit.result === row.result
      ));
      if (existing) return { ok: true, replay: true, auditId: existing.auditId };
      state.audits.push(row);
      return { ok: true, replay: false, auditId: row.auditId };
    },
  };
  const storyRepositories = {
    async inspectBaselineMetadataRecovery(value) {
      assert.deepEqual(value, marker);
      return { ...patch };
    },
    async applyBaselineMetadataRecovery(value) {
      assert.deepEqual(value, marker);
      state.applyCount += 1;
      const oldMatches = (
        state.registryGeneration === marker.expectedRegistryGeneration
        && state.entryGeneration === marker.expectedEntryGeneration
        && Object.entries(marker.expectedOld).every(
          ([key, expected]) => state.metadata[key] === expected,
        )
      );
      const newMatches = (
        state.registryGeneration >= marker.expectedRegistryGeneration + 1
        && state.entryGeneration === marker.expectedEntryGeneration + 1
        && state.lastAppliedBaselineOperationId === marker.operationId
        && Object.entries(marker.patch).every(
          ([key, expected]) => state.metadata[key] === expected,
        )
      );
      if (newMatches) {
        return {
          applied: false,
          alreadyApplied: true,
          registryGeneration: state.registryGeneration,
          entryGeneration: state.entryGeneration,
        };
      }
      assert.equal(oldMatches, true);
      state.registryGeneration += 1;
      state.entryGeneration += 1;
      state.metadata = { ...marker.patch };
      state.lastAppliedBaselineOperationId = marker.operationId;
      return {
        applied: true,
        alreadyApplied: false,
        registryGeneration: state.registryGeneration,
        entryGeneration: state.entryGeneration,
      };
    },
  };
  const leaseManager = {
    reclaimOrphanedOperation(repository, currentOperation) {
      assert.equal(repository.repositoryId, prior.repositoryId);
      assert.equal(currentOperation.operationId, operationId);
      state.reclaimCount += 1;
      return { orphaned: true };
    },
  };
  const repositoryRegistry = {
    get(repositoryId) {
      assert.equal(repositoryId, prior.repositoryId);
      return {
        repositoryId,
        lockPath: path.join(tmpdir(), `${operationId}.lock`),
      };
    },
  };
  return {
    marker,
    patch,
    persistence,
    storyRepositories,
    leaseManager,
    repositoryRegistry,
    state,
    operation: () => operation,
  };
}

test("process dispatcher resolves accepted tip B instead of stale story base A", async () => {
  const oldSha = "a".repeat(40);
  const acceptedSha = "b".repeat(40);
  const idempotencyKey = randomUUID();
  const operationId = randomUUID();
  const repository = {
    repositoryMode: "independent-repository",
    storyId: "story-a-to-b",
    repositoryId: "repository-main",
    repositoryPath: path.join(tmpdir(), "story-a-to-b"),
    worktreePath: path.join(tmpdir(), "story-a-to-b"),
    baseRevision: oldSha,
    sourceRef: "refs/heads/main",
    remoteId: "origin",
    mirrorGeneration: 1,
    headRevision: oldSha,
    branch: "story/a-to-b",
    detached: false,
  };
  const prior = {
    tabId: repository.storyId,
    repositoryId: repository.repositoryId,
    registryGeneration: 5,
    entryGeneration: 2,
    metadata: baselineMetadata({
      baseRevision: oldSha,
      mirrorGeneration: 1,
    }),
  };
  prior.metadata.branch = repository.branch;
  const patch = baselineMetadata({
    baseRevision: acceptedSha,
    mirrorGeneration: 2,
  });
  patch.branch = repository.branch;
  const marker = createStoryBaselineRegistryRecoveryMarker({
    prior,
    patch,
    operationId,
    idempotencyKey,
  });
  const acceptedRequests = [];
  let applyCount = 0;
  let durableOperation = null;
  const persistence = {
    getGitControllerOperationByIdempotency() {
      return null;
    },
    getGitControllerOperation(id) {
      return id === operationId ? durableOperation : null;
    },
    acknowledgeStoryBaselineRegistryRecovery(request) {
      assert.equal(request.operationId, operationId);
      durableOperation = {
        ...durableOperation,
        result: {
          ...durableOperation.result,
          registryRecoveryState: "APPLIED",
        },
      };
      return { ok: true, operation: durableOperation };
    },
  };
  const controller = {
    registry: {
      entries: new Map(),
      gitBinary: process.execPath,
      async resolve(repositoryId, branch) {
        assert.equal(repositoryId, repository.repositoryId);
        assert.equal(branch, "main");
        return {
          entry: {
            repositoryId,
            remoteId: "origin",
          },
          branch,
        };
      },
    },
    mirror: {
      async readAccepted(entry, branch) {
        assert.equal(entry.repositoryId, repository.repositoryId);
        assert.equal(branch, "main");
        return {
          acceptedSha,
          state: { generation: 2 },
        };
      },
      async resolveAcceptedCandidate(request) {
        acceptedRequests.push(request);
        assert.equal(request.candidateSha, acceptedSha);
        return {
          repositoryId: repository.repositoryId,
          remoteId: "origin",
          branch: "main",
          sourceRef: "refs/heads/main",
          mirrorPath: path.join(tmpdir(), "managed-mirror.git"),
          candidateSha: acceptedSha,
          acceptedTipSha: acceptedSha,
          mirrorGeneration: 2,
        };
      },
    },
    base: {},
    leaseManager: {},
    journal: { persistence },
    audit: {},
  };
  const storyRepositories = {
    async resolve() {
      return repository;
    },
    captureBaselineMetadataRecoveryPrior() {
      return prior;
    },
    async applyBaselineMetadataRecovery(value) {
      assert.deepEqual(value, marker);
      applyCount += 1;
      return {
        applied: true,
        alreadyApplied: false,
        registryGeneration: 6,
        entryGeneration: 3,
      };
    },
  };
  const storyBaseline = {
    persistence,
    async preview(request) {
      assert.equal(request.repository.baseRevision, oldSha);
      assert.equal(request.accepted.candidateSha, acceptedSha);
      return {
        candidateSha: acceptedSha,
        mirrorGeneration: 2,
      };
    },
    async execute(request) {
      assert.equal(request.repository.baseRevision, oldSha);
      assert.equal(request.accepted.candidateSha, acceptedSha);
      assert.equal(request.candidateSha, acceptedSha);
      assert.deepEqual(request.registryMetadataPrior, prior);
      const result = {
        ok: true,
        operationId,
        replayed: false,
        resultCode: "PASS",
        repositoryId: repository.repositoryId,
        storyId: repository.storyId,
        candidateSha: acceptedSha,
        entryPatch: {
          ...patch,
          baseRef: patch.sourceRef,
          resolvedRef: patch.sourceRef,
        },
        registryRecoveryMarker: marker,
        registryRecoveryState: "PENDING",
      };
      durableOperation = {
        operationId,
        repositoryId: repository.repositoryId,
        operationType: "STORY_BASELINE_SYNC",
        idempotencyKey,
        candidateSha: acceptedSha,
        status: "SUCCEEDED",
        result,
      };
      return result;
    },
  };
  const dispatch = createGitControllerCommandDispatcher({
    controller,
    storyRepositories,
    storyBaseline,
  });
  const preview = await dispatch("story.baseline.preview", {
    tabId: repository.storyId,
    repositoryId: repository.repositoryId,
    strategy: "FF_ONLY",
  });
  assert.equal(preview.candidateSha, acceptedSha);
  const result = await dispatch("story.baseline.execute", {
    tabId: repository.storyId,
    repositoryId: repository.repositoryId,
    strategy: "FF_ONLY",
    previewId: "preview-a-to-b",
    previewVersion: 1,
    expectedHead: oldSha,
    candidateSha: preview.candidateSha,
    mirrorGeneration: preview.mirrorGeneration,
    idempotencyKey,
  });
  assert.equal(result.candidateSha, acceptedSha);
  assert.equal(acceptedRequests.length, 2);
  assert.equal(applyCount, 1);
});

test("startup completes an orphaned RUNNING baseline checkpoint and replay does not bump generation", async () => {
  const fixture = baselineRecoveryHarness({ status: "RUNNING" });
  const first = await recoverAllStoryBaselineMetadata(fixture);
  assert.equal(first.orphanedCompleted, 1);
  assert.equal(first.applied, 1);
  assert.equal(fixture.operation().status, "SUCCEEDED");
  assert.equal(fixture.operation().result.recoveredAfterCrash, true);
  assert.equal(fixture.operation().result.registryRecoveryState, "APPLIED");
  assert.equal(fixture.state.reclaimCount, 1);
  assert.equal(fixture.state.registryGeneration, 8);
  assert.equal(fixture.state.entryGeneration, 4);
  assert.equal(
    fixture.state.lastAppliedBaselineOperationId,
    fixture.operation().operationId,
  );
  assert.deepEqual(
    fixture.state.journal.map((entry) => entry.phase),
    ["VERIFIED"],
  );
  assert.equal(fixture.state.audits.length, 1);
  assert.equal(fixture.state.audits[0].beforeSha, "a".repeat(40));
  assert.equal(fixture.state.audits[0].candidateSha, "b".repeat(40));
  assert.equal(
    fixture.state.audits[0].details.recoveredAfterCrash,
    true,
  );

  const replay = await recoverAllStoryBaselineMetadata(fixture);
  assert.equal(replay.orphanedCompleted, 0);
  assert.equal(replay.markers, 0);
  assert.equal(fixture.state.registryGeneration, 8);
  assert.equal(fixture.state.entryGeneration, 4);
  assert.equal(fixture.state.audits.length, 1);
});

test("startup closes the SUCCEEDED-before-registry kill window exactly once", async () => {
  const fixture = baselineRecoveryHarness({ status: "SUCCEEDED" });
  const first = await recoverAllStoryBaselineMetadata(fixture);
  assert.equal(first.applied, 1);
  assert.equal(fixture.state.registryGeneration, 8);
  assert.equal(fixture.state.entryGeneration, 4);

  const second = await recoverAllStoryBaselineMetadata(fixture);
  assert.equal(second.markers, 0);
  assert.equal(fixture.state.registryGeneration, 8);
  assert.equal(fixture.state.entryGeneration, 4);
  assert.equal(fixture.state.applyCount, 1);
});

test("startup marks a partial orphan baseline RECOVERY_REQUIRED and does not continue", async () => {
  const fixture = baselineRecoveryHarness({ status: "RUNNING" });
  fixture.storyRepositories.inspectBaselineMetadataRecovery = async () => {
    const error = new Error("partial baseline metadata");
    error.code = "STORY_BASELINE_OPERATION_RECOVERY_STATE_MISMATCH";
    error.details = { recoveryRequired: true };
    throw error;
  };
  await assert.rejects(
    recoverAllStoryBaselineMetadata(fixture),
    (error) => (
      error.code === "STORY_BASELINE_STARTUP_RECOVERY_REQUIRED"
      && error.details?.reason
        === "STORY_BASELINE_OPERATION_RECOVERY_STATE_MISMATCH"
    ),
  );
  assert.equal(fixture.operation().status, "RECOVERY_REQUIRED");
  assert.equal(
    fixture.operation().resultCode,
    "STORY_BASELINE_OPERATION_RECOVERY_STATE_MISMATCH",
  );
  assert.deepEqual(
    fixture.state.journal.map((entry) => entry.phase),
    ["RECOVERY_REQUIRED"],
  );
  await assert.rejects(
    recoverAllStoryBaselineMetadata(fixture),
    { code: "STORY_BASELINE_STARTUP_RECOVERY_REQUIRED" },
  );
});

test("startup skips acknowledged A-to-B marker and only acknowledges pending B-to-C lineage", async () => {
  const shaA = "a".repeat(40);
  const shaB = "b".repeat(40);
  const shaC = "c".repeat(40);
  const repositoryId = "repository-sequential";
  const tabId = "story-sequential";
  const operationAtoB = randomUUID();
  const operationBtoC = randomUUID();
  const keyAtoB = randomUUID();
  const keyBtoC = randomUUID();
  const metadataA = baselineMetadata({
    baseRevision: shaA,
    mirrorGeneration: 1,
  });
  const metadataB = baselineMetadata({
    baseRevision: shaB,
    mirrorGeneration: 2,
  });
  const metadataC = baselineMetadata({
    baseRevision: shaC,
    mirrorGeneration: 3,
  });
  const markerAtoB = createStoryBaselineRegistryRecoveryMarker({
    prior: {
      tabId,
      repositoryId,
      registryGeneration: 20,
      entryGeneration: 5,
      metadata: metadataA,
    },
    patch: metadataB,
    operationId: operationAtoB,
    idempotencyKey: keyAtoB,
  });
  const markerBtoC = createStoryBaselineRegistryRecoveryMarker({
    prior: {
      tabId,
      repositoryId,
      registryGeneration: 21,
      entryGeneration: 6,
      metadata: metadataB,
    },
    patch: metadataC,
    operationId: operationBtoC,
    idempotencyKey: keyBtoC,
  });
  const operation = (operationId, idempotencyKey, candidateSha, marker, state) => ({
    operationId,
    repositoryId,
    operationType: "STORY_BASELINE_SYNC",
    commandId: "story.baseline.refresh",
    idempotencyKey,
    previewId: `preview-${operationId}`,
    branch: "main",
    expectedHead: marker.expectedOld.headRevision,
    candidateSha,
    status: "SUCCEEDED",
    phase: "VERIFIED",
    resultCode: "PASS",
    result: {
      ok: true,
      operationId,
      resultCode: "PASS",
      repositoryId,
      storyId: tabId,
      candidateSha,
      entryPatch: {
        ...marker.patch,
        baseRef: marker.patch.sourceRef,
        resolvedRef: marker.patch.sourceRef,
      },
      registryRecoveryMarker: marker,
      registryRecoveryState: state,
    },
    ownerInstance: `owner-${operationId}`,
    startedAt: 1,
    updatedAt: 2,
  });
  const operations = new Map([
    [
      operationAtoB,
      operation(operationAtoB, keyAtoB, shaB, markerAtoB, "APPLIED"),
    ],
    [
      operationBtoC,
      operation(operationBtoC, keyBtoC, shaC, markerBtoC, "PENDING"),
    ],
  ]);
  let generation = 22;
  let entryGeneration = 7;
  let lastAppliedBaselineOperationId = operationBtoC;
  let metadata = { ...metadataC };
  let applyCount = 0;
  const persistence = {
    listGitControllerOperationsByType() {
      return [...operations.values()];
    },
    getGitControllerOperation(id) {
      return operations.get(id) || null;
    },
    acknowledgeStoryBaselineRegistryRecovery(request) {
      const current = operations.get(request.operationId);
      assert.equal(current.result.registryRecoveryState, "PENDING");
      const acknowledged = {
        ...current,
        result: {
          ...current.result,
          registryRecoveryState: "APPLIED",
        },
      };
      operations.set(request.operationId, acknowledged);
      return { ok: true, operation: acknowledged };
    },
  };
  const storyRepositories = {
    async applyBaselineMetadataRecovery(marker) {
      applyCount += 1;
      assert.equal(marker.operationId, operationBtoC);
      assert.equal(lastAppliedBaselineOperationId, marker.operationId);
      assert.equal(entryGeneration, marker.expectedEntryGeneration + 1);
      assert.deepEqual(metadata, marker.patch);
      return {
        applied: false,
        alreadyApplied: true,
        registryGeneration: generation,
        entryGeneration,
      };
    },
  };
  const recovered = await recoverAllStoryBaselineMetadata({
    storyRepositories,
    persistence,
  });
  assert.equal(recovered.markers, 1);
  assert.equal(recovered.alreadyApplied, 1);
  assert.equal(applyCount, 1);
  assert.equal(generation, 22);
  assert.equal(entryGeneration, 7);
  assert.equal(lastAppliedBaselineOperationId, operationBtoC);
  assert.equal(
    operations.get(operationAtoB).result.registryRecoveryState,
    "APPLIED",
  );
  assert.equal(
    operations.get(operationBtoC).result.registryRecoveryState,
    "APPLIED",
  );
});

test("daemon entry runs baseline recovery before listen and ready output", () => {
  const source = fs.readFileSync(
    new URL("../services/devbench/git-controller-daemon-entry.mjs", import.meta.url),
    "utf8",
  );
  const singleton = source.indexOf(
    "const daemonInstanceLock = acquireGitControllerDaemonInstanceLock",
  );
  const endpointPreflight = source.indexOf(
    "await assertGitControllerDaemonEndpointAvailable",
  );
  const strictRegistry = source.indexOf("continueOnDefinitionError: false");
  const completeRegistry = source.indexOf(
    "assertGitControllerRegistryComplete",
    strictRegistry,
  );
  const recovery = source.indexOf("await recoverAllStoryBaselineMetadata");
  const quarantineRecovery = source.indexOf(
    "await storyRepositories.recoverQuarantines",
  );
  const retentionReconcile = source.indexOf(
    "await storyRepositories.reconcileMirrorRetentions",
  );
  const hooksRecovery = source.indexOf("await managedHooks.recover");
  const daemon = source.indexOf("await createGitControllerDaemon");
  const ready = source.indexOf("process.stdout.write");
  assert.ok(singleton >= 0);
  assert.ok(endpointPreflight >= 0);
  assert.ok(singleton < endpointPreflight);
  assert.ok(endpointPreflight < recovery);
  assert.ok(singleton < recovery);
  assert.ok(strictRegistry > endpointPreflight);
  assert.ok(completeRegistry > strictRegistry);
  assert.ok(completeRegistry < recovery);
  assert.ok(recovery >= 0);
  assert.ok(quarantineRecovery > recovery);
  assert.ok(retentionReconcile > quarantineRecovery);
  assert.ok(hooksRecovery > retentionReconcile);
  assert.ok(recovery < daemon);
  assert.ok(hooksRecovery < daemon);
  assert.ok(daemon < ready);
});

test("daemon registry guard rejects every partial registration diagnostic with a stable code", () => {
  assert.equal(assertGitControllerRegistryComplete(), true);
  assert.throws(
    () => assertGitControllerRegistryComplete({
      registrationErrors: [{
        code: "GIT_CONTROLLER_MIRROR_PATH_CONFLICT",
        message: "redacted",
      }],
    }),
    (error) => (
      error.code === "GIT_CONTROLLER_REGISTRY_INCOMPLETE"
      && error.details.registrationErrorCount === 1
      && error.details.warningCount === 0
      && error.details.registrationErrorCodes[0]
        === "GIT_CONTROLLER_MIRROR_PATH_CONFLICT"
    ),
  );
  assert.throws(
    () => assertGitControllerRegistryComplete({
      warnings: ["repository discovery was incomplete"],
    }),
    (error) => (
      error.code === "GIT_CONTROLLER_REGISTRY_INCOMPLETE"
      && error.details.registrationErrorCount === 0
      && error.details.warningCount === 1
      && error.details.warningCodes[0] === "GIT_CONTROLLER_RUNTIME_WARNING"
    ),
  );
});

test("strict daemon runtime does not reuse a lenient partial-registry cache entry", async (t) => {
  const root = fs.mkdtempSync(path.join(
    tmpdir(),
    "git-controller-runtime-registry-cache-",
  ));
  t.after(() => {
    resetGitControllerRuntimeForTests();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const definitions = [{
    logicalDefinitionId: "missing-runtime-repository",
    displayName: "Missing runtime repository",
    basePath: path.join(root, "missing-base"),
    remoteId: "origin",
    expectedRemoteUrls: ["file:///missing-runtime-repository.git"],
    allowedBranches: ["main"],
  }];
  resetGitControllerRuntimeForTests();
  const lenient = await getLocalGitControllerRuntimeForDaemon({
    definitionsOverride: definitions,
    dataRootOverride: path.join(root, "data"),
    warningsOverride: [],
    continueOnDefinitionError: true,
  });
  assert.equal(lenient.controller.registrationErrors.length, 1);
  assert.equal(lenient.warnings.length, 1);
  const strictRegistrationCode = lenient.controller.registrationErrors[0].code;

  await assert.rejects(
    () => getLocalGitControllerRuntimeForDaemon({
      definitionsOverride: definitions,
      dataRootOverride: path.join(root, "data"),
      warningsOverride: [],
      continueOnDefinitionError: false,
    }),
    (error) => error.code === strictRegistrationCode,
  );
  await assert.rejects(
    () => getLocalGitControllerRuntimeForDaemon({
      definitionsOverride: [],
      dataRootOverride: path.join(root, "warning-data"),
      warningsOverride: [{ code: "GIT_CONTROLLER_DISCOVERY_PARTIAL" }],
      continueOnDefinitionError: false,
    }),
    (error) => (
      error.code === "GIT_CONTROLLER_REGISTRY_INCOMPLETE"
      && error.details.warningCount === 1
      && error.details.warningCodes[0] === "GIT_CONTROLLER_DISCOVERY_PARTIAL"
    ),
  );
});

function fixture(name = "valid") {
  const keys = generateKeyPairSync("ed25519");
  const publicDer = keys.publicKey.export({ type: "spki", format: "der" });
  const socket = endpoint(name);
  const secret = Buffer.alloc(48, 0x42);
  const fingerprint = publicKeyFingerprint(publicDer);
  const endpointAclFingerprint = "d".repeat(64);
  const controllerIdentity = process.platform === "win32"
    ? "sid:S-1-5-21-100-200-300-400"
    : currentProcessIdentity();
  const containment = createSyntheticContainment({ controllerIdentity });
  const daemonConfig = Object.freeze({
    endpoint: socket,
    controllerIdentity,
    privateKey: keys.privateKey,
    keyFingerprint: fingerprint,
    endpointAclFingerprint,
    gitProcessContainment: containment.session,
    clients: new Map([["gateway", secret]]),
  });
  const clientConfig = Object.freeze({
    endpoint: socket,
    expectedControllerIdentity: daemonConfig.controllerIdentity,
    expectedKeyFingerprint: fingerprint,
    expectedEndpointAclFingerprint: endpointAclFingerprint,
    publicKey: keys.publicKey,
    clientId: "gateway",
    secret,
    gitProcessContainmentPolicy: containment.clientPolicy,
    gatewayIdentity: process.platform === "win32"
      ? "sid:S-1-5-21-100-200-300-401"
      : `uid:${Number(process.getuid()) + 1}`,
    timeoutMs: 5_000,
  });
  return { containment, keys, daemonConfig, clientConfig };
}

async function withDaemon(setup, fn) {
  const daemon = new GitControllerDaemon({
    config: setup.daemonConfig,
    endpointAttestor: () => ({
      fingerprint: setup.daemonConfig.endpointAclFingerprint,
    }),
    dispatch: async (commandId, payload) => {
      if (commandId !== "runtime.describe") {
        return { commandId };
      }
      const evidence = setup.daemonConfig.gitProcessContainment.publicEvidence({
        attestationChallenge: payload.attestationChallenge,
      });
      return {
        isolationLevel: "STRONG",
        gitProcessContainment: evidence,
        adapter: "process-daemon",
        repositories: [],
        warnings: [],
      };
    },
  });
  await daemon.listen();
  try {
    await fn(daemon);
  } finally {
    await daemon.close();
  }
}

function unixDaemonSetup(name) {
  const setup = fixture(name);
  const dataRoot = fs.mkdtempSync(path.join(tmpdir(), `git-controller-${name}-`));
  fs.chmodSync(dataRoot, 0o700);
  return {
    ...setup,
    dataRoot,
    daemonConfig: Object.freeze({
      ...setup.daemonConfig,
      endpoint: path.join(dataRoot, "controller.sock"),
      dataRoot,
      controllerIdentity: currentProcessIdentity(),
      ipcGid: process.getgid(),
    }),
  };
}

function startRawUnixSocket(socketPath) {
  const script = [
    'const net = require("node:net");',
    "const endpoint = process.argv[1];",
    "const server = net.createServer(() => {});",
    "server.listen(endpoint, () => process.stdout.write('READY\\n'));",
    "process.on('SIGTERM', () => server.close(() => process.exit(0)));",
  ].join("");
  const child = spawn(process.execPath, ["-e", script, socketPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`raw Unix socket did not start: ${stderr}`));
    }, 5_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (!stdout.includes("READY")) return;
      clearTimeout(timeout);
      resolve(child);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (stdout.includes("READY")) return;
      clearTimeout(timeout);
      reject(new Error(`raw Unix socket exited before ready: ${code || signal}: ${stderr}`));
    });
  });
}

function waitForChildExit(child) {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", resolve));
}

test("Unix daemon singleton refuses a second live owner without disturbing its endpoint", {
  skip: process.platform === "win32",
}, async (t) => {
  const setup = unixDaemonSetup("singleton-live");
  t.after(() => fs.rmSync(setup.dataRoot, { recursive: true, force: true }));
  const options = {
    config: setup.daemonConfig,
    endpointAttestor: () => ({
      fingerprint: setup.daemonConfig.endpointAclFingerprint,
    }),
    dispatch: async () => ({ ok: true }),
  };
  const first = new GitControllerDaemon(options);
  const second = new GitControllerDaemon(options);
  await first.listen();
  try {
    const before = fs.lstatSync(setup.daemonConfig.endpoint);
    await assert.rejects(
      () => second.listen(),
      { code: "GIT_CONTROLLER_DAEMON_ALREADY_RUNNING" },
    );
    const after = fs.lstatSync(setup.daemonConfig.endpoint);
    assert.equal(after.isSocket(), true);
    assert.equal(after.ino, before.ino);
    assert.equal(
      (await probeUnixControllerEndpoint(setup.daemonConfig.endpoint)).live,
      true,
    );
  } finally {
    await second.close();
    await first.close();
  }
});

test("Unix daemon fails closed on a live unowned socket instead of unlinking it", {
  skip: process.platform === "win32",
}, async (t) => {
  const setup = unixDaemonSetup("live-unowned-socket");
  let rawServer = await startRawUnixSocket(setup.daemonConfig.endpoint);
  t.after(async () => {
    if (rawServer?.exitCode == null && rawServer?.signalCode == null) {
      rawServer.kill("SIGTERM");
      await waitForChildExit(rawServer);
    }
    fs.rmSync(setup.dataRoot, { recursive: true, force: true });
  });
  const before = fs.lstatSync(setup.daemonConfig.endpoint);
  const daemon = new GitControllerDaemon({
    config: setup.daemonConfig,
    endpointAttestor: () => ({
      fingerprint: setup.daemonConfig.endpointAclFingerprint,
    }),
    dispatch: async () => ({ ok: true }),
  });
  await assert.rejects(
    () => daemon.listen(),
    { code: "GIT_CONTROLLER_ENDPOINT_LIVE" },
  );
  const after = fs.lstatSync(setup.daemonConfig.endpoint);
  assert.equal(after.isSocket(), true);
  assert.equal(after.ino, before.ino);
  assert.equal(rawServer.exitCode, null);
  await daemon.close();
});

test("Unix daemon archives a proven stale socket and binds the replacement atomically", {
  skip: process.platform === "win32",
}, async (t) => {
  const setup = unixDaemonSetup("stale-socket");
  const rawServer = await startRawUnixSocket(setup.daemonConfig.endpoint);
  rawServer.kill("SIGKILL");
  await waitForChildExit(rawServer);
  assert.equal(fs.lstatSync(setup.daemonConfig.endpoint).isSocket(), true);
  assert.equal(
    (await probeUnixControllerEndpoint(setup.daemonConfig.endpoint)).live,
    false,
  );
  const daemon = new GitControllerDaemon({
    config: setup.daemonConfig,
    endpointAttestor: () => ({
      fingerprint: setup.daemonConfig.endpointAclFingerprint,
    }),
    dispatch: async () => ({ ok: true }),
  });
  t.after(async () => {
    await daemon.close();
    fs.rmSync(setup.dataRoot, { recursive: true, force: true });
  });
  await daemon.listen();
  assert.equal(fs.lstatSync(setup.daemonConfig.endpoint).isSocket(), true);
  assert.equal(
    (await probeUnixControllerEndpoint(setup.daemonConfig.endpoint)).live,
    true,
  );
  assert.equal(
    fs.readdirSync(setup.dataRoot).some((name) => name.includes(".sock.stale.")),
    false,
  );
});

test("Unix singleton archives only a lock whose PID/start identity is proven stale", {
  skip: process.platform === "win32",
}, (t) => {
  const setup = unixDaemonSetup("stale-lock");
  t.after(() => fs.rmSync(setup.dataRoot, { recursive: true, force: true }));
  const lockPath = path.join(setup.dataRoot, "git-controller-daemon.instance.lock");
  fs.writeFileSync(lockPath, `${JSON.stringify({
    schemaVersion: 1,
    lockId: randomUUID(),
    pid: 987654,
    processStartIdentity: "linux-start:stale",
    endpoint: setup.daemonConfig.endpoint,
    controllerIdentity: setup.daemonConfig.controllerIdentity,
    acquiredAt: 1,
  })}\n`, { mode: 0o600 });
  const lock = acquireGitControllerDaemonInstanceLock(setup.daemonConfig, {
    platform: "linux",
    ownerPid: 123456,
    processIdentityProbe: (pid) => (
      pid === 123456 ? "linux-start:new" : "linux-start:stale"
    ),
    pidAliveProbe: () => false,
  });
  try {
    assert.ok(lock.recoveredLockPath);
    assert.equal(fs.existsSync(lock.recoveredLockPath), true);
    assert.equal(JSON.parse(fs.readFileSync(lock.lockPath, "utf8")).lockId, lock.owner.lockId);
  } finally {
    assert.equal(lock.release().ok, true);
  }
});

function signedEnvelope({
  keys,
  requestId,
  endpoint: socket,
  controllerIdentity,
  keyFingerprint,
  body = { ok: true, data: {} },
}) {
  const unsigned = {
    version: GIT_CONTROLLER_PROTOCOL_VERSION,
    requestId,
    timestamp: Date.now(),
    endpoint: socket,
    controllerIdentity,
    keyFingerprint,
    endpointAclFingerprint: "d".repeat(64),
    body,
  };
  return {
    ...unsigned,
    signature: sign(
      null,
      Buffer.from(canonicalProtocolJson(unsigned)),
      keys.privateKey,
    ).toString("base64"),
  };
}

test("independent daemon/client completes a signed STRONG handshake", async () => {
  const setup = fixture("handshake");
  await withDaemon(setup, async () => {
    const client = await new GitControllerProcessClient(setup.clientConfig).initialize();
    assert.equal(client.catalog.length, 0);
  });
});

test("daemon refuses a plain STRONG object without a branded guardian session", async () => {
  const setup = fixture("weak-process-tree");
  const daemon = new GitControllerDaemon({
    config: {
      ...setup.daemonConfig,
      gitProcessContainment: {
        isolationLevel: "STRONG",
      },
    },
    endpointAttestor: () => ({
      fingerprint: setup.daemonConfig.endpointAclFingerprint,
    }),
    dispatch: async () => ({ ok: true }),
  });
  await assert.rejects(
    () => daemon.listen(),
    { code: "GIT_CONTROLLER_PROCESS_TREE_CONTAINMENT_REQUIRED" },
  );
  await daemon.close();
});

test("client rejects a legacy STRONG claim without structured tree evidence", async () => {
  const setup = fixture("legacy-strong-claim");
  const client = new GitControllerProcessClient(setup.clientConfig);
  client.call = async () => ({
    isolationLevel: "STRONG",
    adapter: "process-daemon",
    repositories: [],
  });
  await assert.rejects(
    () => client.initialize(),
    { code: "GIT_CONTROLLER_ATTESTATION_WEAK" },
  );
});

test("client rejects a Controller-signed response with an invalid guardian receipt", async () => {
  const setup = fixture("guardian-signature-invalid");
  const daemon = new GitControllerDaemon({
    config: setup.daemonConfig,
    endpointAttestor: () => ({
      fingerprint: setup.daemonConfig.endpointAclFingerprint,
    }),
    dispatch: async (commandId, payload) => {
      assert.equal(commandId, "runtime.describe");
      const evidence = setup.daemonConfig.gitProcessContainment.publicEvidence({
        attestationChallenge: payload.attestationChallenge,
      });
      return {
        isolationLevel: "STRONG",
        gitProcessContainment: {
          ...evidence,
          signature: `${evidence.signature.slice(0, -2)}AA`,
        },
        adapter: "process-daemon",
        repositories: [],
        warnings: [],
      };
    },
  });
  await daemon.listen();
  try {
    const client = new GitControllerProcessClient(setup.clientConfig);
    await assert.rejects(
      () => client.initialize(),
      { code: "GIT_CONTROLLER_ATTESTATION_WEAK" },
    );
  } finally {
    await daemon.close();
  }
});

test("daemon fail-closes every command after the guardian channel is lost", async () => {
  const setup = fixture("guardian-channel-closed");
  const daemon = new GitControllerDaemon({
    config: setup.daemonConfig,
    endpointAttestor: () => ({
      fingerprint: setup.daemonConfig.endpointAclFingerprint,
    }),
    dispatch: async () => ({ unexpected: true }),
  });
  await daemon.listen();
  setup.containment.disableGuardian();
  try {
    const client = new GitControllerProcessClient(setup.clientConfig);
    await assert.rejects(
      () => client.initialize(),
      { code: "GIT_CONTROLLER_PROCESS_TREE_ATTESTATION_FAILED" },
    );
    assert.equal(daemon.failStopped, true);
    assert.equal(daemon.ready, false);
  } finally {
    await daemon.close();
  }
});

test("client rejects a valid guardian signature when its receipt is stale", async () => {
  const setup = fixture("guardian-receipt-stale");
  const evidence = setup.daemonConfig.gitProcessContainment.publicEvidence();
  const client = new GitControllerProcessClient(setup.clientConfig, {
    now: () => evidence.receipt.expiresAt + 20_000,
  });
  client.call = async (_commandId, payload) => {
    const refreshed = setup.daemonConfig.gitProcessContainment.publicEvidence({
      attestationChallenge: payload.attestationChallenge,
    });
    return {
      isolationLevel: "STRONG",
      gitProcessContainment: refreshed,
      adapter: "process-daemon",
      repositories: [],
      warnings: [],
    };
  };
  await assert.rejects(
    () => client.initialize(),
    { code: "GIT_CONTROLLER_ATTESTATION_WEAK" },
  );
});

test("live endpoint ACL evidence rejects an incorrect pinned fingerprint", async () => {
  const setup = fixture("live-acl-drift");
  const daemon = new GitControllerDaemon({
    config: setup.daemonConfig,
    dispatch: async () => ({ ok: true }),
  });
  await assert.rejects(
    () => daemon.listen(),
    { code: "GIT_CONTROLLER_ENDPOINT_ACL_DRIFT" },
  );
  await daemon.close();
});

test("data root ACL is applied by the real platform probe and pinned", () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), "git-controller-root-acl-"));
  let actualFingerprint = "";
  try {
    assert.throws(
      () => prepareGitControllerDataRoot({
        dataRoot: root,
        dataRootAclSha256: "0".repeat(64),
        controllerIdentity: currentProcessIdentity(),
      }),
      (error) => {
        actualFingerprint = String(error?.details?.actualFingerprint || "");
        return error?.code === "GIT_CONTROLLER_DATA_ROOT_ACL_DRIFT"
          && /^[0-9a-f]{64}$/.test(actualFingerprint);
      },
    );
    const result = prepareGitControllerDataRoot({
      dataRoot: root,
      dataRootAclSha256: actualFingerprint,
      controllerIdentity: currentProcessIdentity(),
    });
    assert.equal(result.fingerprint, actualFingerprint);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("protocol rejects raw args, paths and unknown commands before transport", () => {
  assert.throws(
    () => validateControllerCommand("base.execute", {
      repositoryId: "repo-1",
      branch: "main",
      previewId: "preview-1",
      previewVersion: 1,
      expectedHead: "a".repeat(40),
      candidateSha: "b".repeat(40),
      idempotencyKey: "idem-1",
      args: ["reset", "--hard"],
    }),
    { code: "GIT_CONTROLLER_COMMAND_FIELD_REJECTED" },
  );
  assert.throws(
    () => validateControllerCommand("mirror.preview", {
      repositoryId: "repo-1",
      branch: "main",
      path: "D:\\base",
    }),
    { code: "GIT_CONTROLLER_COMMAND_FIELD_REJECTED" },
  );
  assert.throws(
    () => validateControllerCommand("git.raw", {}),
    { code: "GIT_CONTROLLER_COMMAND_NOT_ALLOWED" },
  );
  const mirrorApproval = {
    repositoryId: "repo-1",
    branch: "main",
    previewId: "preview-1",
    previewVersion: 1,
    expectedAcceptedSha: "a".repeat(40),
    candidateSha: "b".repeat(40),
    idempotencyKey: "idem-impact-1",
    adminApprovedImpactDigest: "c".repeat(64),
  };
  assert.equal(
    validateControllerCommand("mirror.execute", mirrorApproval)
      .payload.adminApprovedImpactDigest,
    "c".repeat(64),
  );
  assert.throws(
    () => validateControllerCommand("mirror.execute", {
      ...mirrorApproval,
      adminApprovedImpactDigest: "c".repeat(63),
    }),
    { code: "GIT_CONTROLLER_COMMAND_FIELD_INVALID" },
  );
});

test("legacy story migration crosses the Controller protocol only as validated scalar fields", () => {
  const sourcePath = path.resolve(tmpdir(), "legacy-story-source");
  const stateDigest = "d".repeat(64);
  const preview = {
    tabId: "story-legacy-1",
    repositoryId: "repo-1",
    sourcePath,
  };
  assert.deepEqual(
    validateControllerCommand("story.repository.legacy-migration-preview", preview),
    {
      commandId: "story.repository.legacy-migration-preview",
      payload: preview,
    },
  );
  const provision = {
    tabId: "story-legacy-1",
    repositoryId: "repo-1",
    branch: "main",
    exactSha: "a".repeat(40),
    idempotencyKey: "legacy-story-provision-1",
    detached: false,
    primary: true,
    legacySourcePath: sourcePath,
    legacyStateDigest: stateDigest,
  };
  assert.deepEqual(
    validateControllerCommand("story.repository.provision", provision),
    { commandId: "story.repository.provision", payload: provision },
  );
  const { legacySourcePath: _omittedSourcePath, ...missingSourcePath } = provision;
  assert.throws(
    () => validateControllerCommand("story.repository.provision", missingSourcePath),
    { code: "GIT_CONTROLLER_COMMAND_FIELD_REQUIRED" },
  );
  assert.throws(
    () => validateControllerCommand("story.repository.provision", {
      ...provision,
      legacyMigration: { sourcePath, stateDigest },
    }),
    { code: "GIT_CONTROLLER_COMMAND_FIELD_REJECTED" },
  );
  assert.throws(
    () => validateControllerCommand("story.repository.legacy-migration-preview", {
      ...preview,
      sourcePath: "relative/story",
    }),
    { code: "GIT_CONTROLLER_COMMAND_FIELD_INVALID" },
  );
});

test("Controller daemon reconstructs the internal legacy migration request after protocol validation", async () => {
  const sourcePath = path.resolve(tmpdir(), "legacy-story-source");
  const stateDigest = "e".repeat(64);
  let provisionPayload = null;
  let previewPayload = null;
  const dispatch = createGitControllerCommandDispatcher({
    controller: {
      registry: { entries: new Map() },
      mirror: {},
      base: {},
    },
    managedHooks: {},
    storyRepositories: {
      async provision(payload) {
        provisionPayload = payload;
        return { ok: true };
      },
      async previewLegacyMigration(payload) {
        previewPayload = payload;
        return { ok: true };
      },
    },
  });
  const preview = {
    tabId: "story-legacy-2",
    repositoryId: "repo-2",
    sourcePath,
  };
  await dispatch(
    "story.repository.legacy-migration-preview",
    validateControllerCommand(
      "story.repository.legacy-migration-preview",
      preview,
    ).payload,
  );
  assert.deepEqual(previewPayload, preview);
  const provision = {
    tabId: "story-legacy-2",
    repositoryId: "repo-2",
    branch: "main",
    exactSha: "a".repeat(40),
    idempotencyKey: "legacy-story-provision-2",
    detached: false,
    primary: true,
    legacySourcePath: sourcePath,
    legacyStateDigest: stateDigest,
  };
  await dispatch(
    "story.repository.provision",
    validateControllerCommand("story.repository.provision", provision).payload,
  );
  assert.deepEqual(provisionPayload, {
    tabId: provision.tabId,
    repositoryId: provision.repositoryId,
    branch: provision.branch,
    exactSha: provision.exactSha,
    idempotencyKey: provision.idempotencyKey,
    detached: false,
    primary: true,
    legacyMigration: {
      sourcePath,
      stateDigest,
    },
  });
});

test("standalone hooks uninstall accepts only the exact installation identity tuple", () => {
  const payload = {
    repositoryId: "repo-1",
    installationId: "install-1234",
    manifestSha256: "a".repeat(64),
    idempotencyKey: "standalone-uninstall-install-1234",
  };
  assert.deepEqual(
    validateControllerCommand("hooks.standalone-uninstall", payload),
    { commandId: "hooks.standalone-uninstall", payload },
  );
  assert.throws(
    () => validateControllerCommand("hooks.standalone-uninstall", {
      ...payload,
      repositoryPath: "D:\\protected-base",
    }),
    { code: "GIT_CONTROLLER_COMMAND_FIELD_REJECTED" },
  );
  assert.throws(
    () => validateControllerCommand("hooks.standalone-uninstall", {
      ...payload,
      manifestSha256: "a".repeat(63),
    }),
    { code: "GIT_CONTROLLER_COMMAND_FIELD_INVALID" },
  );
  assert.throws(
    () => validateControllerCommand("hooks.standalone-uninstall", {
      ...payload,
      installationId: "",
    }),
    { code: "GIT_CONTROLLER_COMMAND_FIELD_REQUIRED" },
  );
});

test("story retire protocol is preview-bound and rejects Gateway filesystem targets", () => {
  const payload = {
    tabId: "story-1",
    repositoryId: "repo-1",
    previewId: "preview-1",
    previewVersion: 1,
    expectedHead: "a".repeat(40),
    registryGeneration: 2,
    force: false,
    idempotencyKey: "retire-1",
  };
  assert.equal(
    validateControllerCommand("story.repository.retire", payload).commandId,
    "story.repository.retire",
  );
  assert.throws(
    () => validateControllerCommand("story.repository.retire", {
      ...payload,
      repositoryPath: "D:\\story-repositories\\story-1\\repo-1",
    }),
    { code: "GIT_CONTROLLER_COMMAND_FIELD_REJECTED" },
  );
  assert.throws(
    () => validateControllerCommand("story.repository.retire", {
      ...payload,
      force: "true",
    }),
    { code: "GIT_CONTROLLER_COMMAND_FIELD_INVALID" },
  );
});

test("daemon rejects a forged client MAC", async () => {
  const setup = fixture("forged-request");
  const daemon = new GitControllerDaemon({
    config: setup.daemonConfig,
    dispatch: async () => ({ ok: true }),
  });
  const request = createControllerRequest({
    commandId: "runtime.describe",
    payload: { attestationChallenge: "a".repeat(48) },
    clientId: "gateway",
    secret: setup.clientConfig.secret,
  });
  request.mac = `${request.mac.slice(0, -1)}${request.mac.endsWith("0") ? "1" : "0"}`;
  assert.throws(
    () => daemon.verifyRequest(request),
    { code: "GIT_CONTROLLER_REQUEST_SIGNATURE_INVALID" },
  );
});

test("daemon consumes request nonces and rejects replay", () => {
  const setup = fixture("replay");
  const daemon = new GitControllerDaemon({
    config: setup.daemonConfig,
    dispatch: async () => ({ ok: true }),
  });
  const request = createControllerRequest({
    commandId: "runtime.describe",
    payload: { attestationChallenge: "b".repeat(48) },
    clientId: "gateway",
    secret: setup.clientConfig.secret,
  });
  daemon.verifyRequest(request);
  assert.throws(
    () => daemon.verifyRequest(request),
    { code: "GIT_CONTROLLER_REQUEST_REPLAYED" },
  );
});

test("daemon binds a client credential to its protected OS identity policy", () => {
  const setup = fixture("client-identity");
  const expectedIdentity = "sid:S-1-5-21-100-200-300-401";
  const daemon = new GitControllerDaemon({
    config: {
      ...setup.daemonConfig,
      clients: new Map([[
        "gateway",
        { secret: setup.clientConfig.secret, expectedIdentity },
      ]]),
    },
    dispatch: async () => ({ ok: true }),
  });
  const request = createControllerRequest({
    commandId: "runtime.describe",
    payload: { attestationChallenge: "c".repeat(48) },
    clientId: "gateway",
    secret: setup.clientConfig.secret,
    clientIdentity: "sid:S-1-5-21-100-200-300-999",
  });
  assert.throws(
    () => daemon.verifyRequest(request),
    { code: "GIT_CONTROLLER_CLIENT_IDENTITY_MISMATCH" },
  );
});

test("protected Controller trust files reject hard links", (t) => {
  const root = fs.mkdtempSync(path.join(tmpdir(), "git-controller-hardlink-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = path.join(root, "trust.json");
  const linked = path.join(root, "trust-link.json");
  fs.writeFileSync(original, "{}");
  fs.linkSync(original, linked);
  assert.throws(
    () => readProtectedFile(original, { label: "test trust file" }),
    { code: "GIT_CONTROLLER_TRUST_FILE_INVALID" },
  );
});

test("protected Controller trust files reject a linked parent segment", (t) => {
  const root = fs.mkdtempSync(path.join(tmpdir(), "git-controller-parent-link-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const realParent = path.join(root, "real-parent");
  const linkedParent = path.join(root, "linked-parent");
  fs.mkdirSync(realParent);
  fs.writeFileSync(path.join(realParent, "trust.json"), "{}");
  try {
    fs.symlinkSync(
      realParent,
      linkedParent,
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    if (["EPERM", "EACCES"].includes(error?.code)) {
      t.skip("current host cannot create a directory link");
      return;
    }
    throw error;
  }
  assert.throws(
    () => readProtectedFile(path.join(linkedParent, "trust.json"), {
      label: "test trust file",
    }),
    { code: "GIT_CONTROLLER_TRUST_FILE_INVALID" },
  );
});

test("protected Controller trust files reject a writable parent chain", (t) => {
  const realTempRoot = fs.realpathSync.native(tmpdir());
  const root = fs.mkdtempSync(path.join(realTempRoot, "git-controller-parent-mode-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "trust.json");
  fs.writeFileSync(target, "{}");
  if (process.platform !== "win32") {
    fs.chmodSync(root, 0o770);
    fs.chmodSync(target, 0o600);
  }
  assert.throws(
    () => readProtectedFile(target, { label: "test trust file" }),
    { code: "GIT_CONTROLLER_TRUST_FILE_PERMISSIONS" },
  );
});

test("Unix protected parent and secret modes stay fail-closed", () => {
  const snapshot = (parentUid, parentMode, leafMode = 0o100600) => ({
    leaf: { mode: BigInt(leafMode) },
    parents: [{
      path: "/protected",
      stat: { uid: BigInt(parentUid), mode: BigInt(parentMode) },
    }],
  });
  assert.doesNotThrow(() => gitControllerProtocolTest.validateUnixProtectedPath(
    snapshot(1001, 0o40750),
    { label: "test trust file", serviceUid: 1001 },
  ));
  assert.throws(
    () => gitControllerProtocolTest.validateUnixProtectedPath(
      snapshot(1001, 0o40770),
      { label: "test trust file", serviceUid: 1001 },
    ),
    { code: "GIT_CONTROLLER_TRUST_FILE_PERMISSIONS" },
  );
  assert.throws(
    () => gitControllerProtocolTest.validateUnixProtectedPath(
      snapshot(1002, 0o40750),
      { label: "test trust file", serviceUid: 1001 },
    ),
    { code: "GIT_CONTROLLER_TRUST_FILE_PERMISSIONS" },
  );
  assert.throws(
    () => gitControllerProtocolTest.validateUnixProtectedPath(
      snapshot(1001, 0o40750, 0o100640),
      { label: "test trust file", secret: true, serviceUid: 1001 },
    ),
    { code: "GIT_CONTROLLER_TRUST_FILE_PERMISSIONS" },
  );
});

test("Windows protected parent probe covers every rename and ACL mutation right", () => {
  const source = fs.readFileSync(
    new URL("../services/devbench/git-controller-process-protocol.js", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("function probeWindowsProtectedPath");
  const end = source.indexOf("\nfunction validateWindowsProtectedPath", start);
  const body = source.slice(start, end);
  for (const right of [
    "CreateFiles",
    "CreateDirectories",
    "Delete",
    "DeleteSubdirectoriesAndFiles",
    "ChangePermissions",
    "TakeOwnership",
  ]) {
    assert.match(body, new RegExp(`FileSystemRights]::${right}`));
  }
  assert.match(body, /RawSecurityDescriptor/);
  assert.match(body, /DiscretionaryAcl/);
  assert.match(body, /FileAttributes]::ReparsePoint/);
});

test("protected Controller trust files use the verified fd for a normal read", (t) => {
  const root = fs.mkdtempSync(path.join(tmpdir(), "git-controller-fd-read-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "trust.json");
  fs.writeFileSync(target, "{\"trusted\":true}");
  let aclProbes = 0;
  const content = gitControllerProtocolTest.readProtectedFileWithInternals(
    target,
    { label: "test trust file", platform: "win32" },
    {
      windowsAclProbe() {
        aclProbes += 1;
        return { unsafe: [], invalid: [], descriptor: "stable-test-acl" };
      },
    },
  );
  assert.equal(content.toString("utf8"), "{\"trusted\":true}");
  assert.equal(aclProbes, 2);
});

test("protected Controller trust files reject a pre-open parent rename swap", (t) => {
  const root = fs.mkdtempSync(path.join(tmpdir(), "git-controller-rename-swap-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const trustedParent = path.join(root, "trusted-parent");
  const replacementParent = path.join(root, "replacement-parent");
  const displacedParent = path.join(root, "displaced-parent");
  fs.mkdirSync(trustedParent);
  fs.mkdirSync(replacementParent);
  const target = path.join(trustedParent, "trust.json");
  fs.writeFileSync(target, "{\"trusted\":true}");
  fs.writeFileSync(
    path.join(replacementParent, "trust.json"),
    "{\"trusted\":false}",
  );
  assert.throws(
    () => gitControllerProtocolTest.readProtectedFileWithInternals(
      target,
      { label: "test trust file", platform: "win32" },
      {
        windowsAclProbe: () => ({
          unsafe: [],
          invalid: [],
          descriptor: "stable-test-acl",
        }),
        afterValidation() {
          fs.renameSync(trustedParent, displacedParent);
          fs.renameSync(replacementParent, trustedParent);
        },
      },
    ),
    { code: "GIT_CONTROLLER_TRUST_FILE_IDENTITY_DRIFT" },
  );
});

test("protected Controller trust files reject fd state drift during a read", (t) => {
  const root = fs.mkdtempSync(path.join(tmpdir(), "git-controller-fd-drift-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "trust.json");
  fs.writeFileSync(target, "{\"trusted\":true}");
  assert.throws(
    () => gitControllerProtocolTest.readProtectedFileWithInternals(
      target,
      { label: "test trust file", platform: "win32" },
      {
        windowsAclProbe: () => ({
          unsafe: [],
          invalid: [],
          descriptor: "stable-test-acl",
        }),
        afterRead() {
          fs.writeFileSync(target, "{\"trusted\":false,\"drift\":true}");
        },
      },
    ),
    { code: "GIT_CONTROLLER_TRUST_FILE_IDENTITY_DRIFT" },
  );
});

test("deployment-file attestation hashes the fd-bound protected read", () => {
  const source = fs.readFileSync(
    new URL("../services/devbench/git-controller-daemon.js", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("export function attestGitControllerDeploymentFile");
  const end = source.indexOf("\nexport function validateUnixIpcIdentityPolicy", start);
  const body = source.slice(start, end);
  assert.match(body, /const content = readProtectedFile\(/);
  assert.doesNotMatch(body, /fs\.readFileSync\(/);
});

test("Unix IPC group policy permits cross-UID Gateway but excludes every Worker", () => {
  const memberships = new Map([
    ["1001", [2000]],
    ["1002", [2000]],
    ["1003", [2000]],
    ["1101", [3000]],
  ]);
  assert.deepEqual(validateUnixIpcIdentityPolicy({
    controllerIdentity: "uid:1001",
    gatewayIdentities: ["uid:1002"],
    humanManagerIdentities: ["uid:1003"],
    workerIdentities: { story: "uid:1101" },
    ipcGid: 2000,
    groupsForUid: (uid) => memberships.get(uid) || [],
  }).excludedWorkerUids, ["1101"]);
  assert.throws(() => validateUnixIpcIdentityPolicy({
    controllerIdentity: "uid:1001",
    gatewayIdentities: ["uid:1002"],
    humanManagerIdentities: ["uid:1003"],
    workerIdentities: { story: "uid:1101" },
    ipcGid: 2000,
    groupsForUid: () => [2000],
  }), { code: "GIT_CONTROLLER_IPC_GROUP_UNSAFE" });
});

test("story root startup ACL is a stable full identity-policy allowlist", () => {
  const source = fs.readFileSync(
    new URL("../services/devbench/git-controller-daemon.js", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("export function prepareGitControllerStoryRoot");
  const end = source.indexOf("\nfunction publicRepositoryEntry", start);
  const body = source.slice(start, end);
  assert.doesNotMatch(body, /prepareGitControllerDataRoot\(/);
  assert.match(body, /config\.gatewayIdentities/);
  assert.match(body, /config\.humanManagerIdentities/);
  assert.match(body, /Object\.values\(config\.workerIdentities/);
  assert.match(body, /\.sort\(\)/);
  assert.match(body, /u:\$\{uid\}:--x/);
  assert.match(body, /\*\$\{sid\}:\(RX\)/);
});

test("stale lease recovery distinguishes PID reuse by process start identity", (t) => {
  const root = fs.mkdtempSync(path.join(tmpdir(), "git-controller-pid-reuse-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lockPath = path.join(root, "controller.lock");
  fs.writeFileSync(lockPath, JSON.stringify({
    schemaVersion: 2,
    lockRevision: 1,
    gitChildren: {},
    repositoryId: "repo",
    leaseId: "old-lease",
    operationId: "old-operation",
    ownerPid: process.pid,
    ownerProcessStartIdentity: "windows-start:111",
    hostname: hostname(),
    fencingToken: 1,
    expiresAt: 1,
  }));
  const manager = createRepositoryLeaseManager({
    dataRoot: root,
    persistence: { appendGitControllerAudit() {} },
    ownerInstance: "test-owner",
    processIdentityProbe: () => "windows-start:222",
  });
  const recovered = manager.recoverStaleLock(
    { repositoryId: "repo" },
    lockPath,
    { lease: { operationId: "new-operation", fencingToken: 2 } },
    Date.now(),
  );
  assert.equal(recovered.ownerProcessStartIdentity, "windows-start:111");
  assert.equal(fs.existsSync(lockPath), false);

  const activeLock = {
    schemaVersion: 2,
    lockRevision: 1,
    gitChildren: {},
    repositoryId: "repo",
    leaseId: "active-lease",
    operationId: "active-operation",
    ownerPid: process.pid,
    ownerProcessStartIdentity: "windows-start:222",
    hostname: hostname(),
    fencingToken: 1,
    expiresAt: 1,
  };
  fs.writeFileSync(lockPath, JSON.stringify(activeLock));
  assert.throws(
    () => manager.recoverStaleLock(
      { repositoryId: "repo" },
      lockPath,
      { lease: { operationId: "new-operation", fencingToken: 2 } },
      Date.now(),
    ),
    { code: "GIT_CONTROLLER_OS_LOCK_CONFLICT" },
  );
  const unboundManager = createRepositoryLeaseManager({
    dataRoot: root,
    persistence: { appendGitControllerAudit() {} },
    ownerInstance: "test-owner-unbound",
    processIdentityProbe: () => `alive-unbound:${process.pid}`,
  });
  assert.throws(
    () => unboundManager.recoverStaleLock(
      { repositoryId: "repo" },
      lockPath,
      { lease: { operationId: "new-operation", fencingToken: 2 } },
      Date.now(),
    ),
    { code: "GIT_CONTROLLER_OS_LOCK_CONFLICT" },
  );
});

test("Git child ledger is persisted before spawn and cleared before command resolution", async (t) => {
  const root = fs.mkdtempSync(path.join(tmpdir(), "git-controller-child-ledger-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lockPath = path.join(root, "repository.lock");
  const knownHostsPath = path.join(root, "known_hosts");
  fs.writeFileSync(knownHostsPath, "");
  let activeLease = null;
  let lastFence = 0;
  const persistence = {
    claimGitControllerRepositoryLease(request) {
      const now = Number(request.now);
      activeLease = {
        repositoryId: request.repositoryId,
        leaseId: request.leaseId,
        operationId: request.operationId,
        kind: request.kind,
        ownerInstance: request.ownerInstance,
        ownerHostname: request.ownerHostname,
        ownerPid: request.ownerPid,
        ownerProcessStartIdentity: request.ownerProcessStartIdentity,
        fencingToken: ++lastFence,
        acquiredAt: now,
        heartbeatAt: now,
        expiresAt: now + Number(request.ttlMs),
      };
      return { ok: true, lease: { ...activeLease } };
    },
    assertGitControllerRepositoryLease(request) {
      return (
        activeLease
        && activeLease.repositoryId === request.repositoryId
        && activeLease.leaseId === request.leaseId
        && activeLease.ownerInstance === request.ownerInstance
        && activeLease.fencingToken === request.fencingToken
        && activeLease.expiresAt > request.now
      )
        ? { ok: true, lease: { ...activeLease } }
        : { ok: false };
    },
    renewGitControllerRepositoryLease(request) {
      const current = this.assertGitControllerRepositoryLease(request);
      if (!current.ok) return { ok: false };
      activeLease.heartbeatAt = request.now;
      activeLease.expiresAt = request.now + Number(request.ttlMs);
      return { ok: true, expiresAt: activeLease.expiresAt };
    },
    releaseGitControllerRepositoryLease(request) {
      const matches = !!(
        activeLease
        && activeLease.repositoryId === request.repositoryId
        && activeLease.leaseId === request.leaseId
        && activeLease.ownerInstance === request.ownerInstance
        && activeLease.fencingToken === request.fencingToken
      );
      if (matches) activeLease = null;
      return { ok: matches };
    },
    appendGitControllerAudit() {},
  };
  const manager = createRepositoryLeaseManager({
    dataRoot: root,
    persistence,
    ownerInstance: "child-ledger-owner",
    ttlMs: 30_000,
    processIdentityProbe: () => "windows-start:222",
  });
  const repository = { repositoryId: "repo-child-ledger", lockPath };
  const lease = manager.acquire(repository, {
    operationId: "operation-child-ledger",
    kind: "mirror-refresh",
  });
  const delegate = lease.gitChildGuard("test.git-version");
  const phases = [];
  const childLifecycle = {
    beforeSpawn() {
      const ticket = delegate.beforeSpawn();
      const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      const child = lock.gitChildren[ticket];
      phases.push(child.state);
      assert.equal(child.pid, null);
      return ticket;
    },
    afterSpawn(ticket, child) {
      const result = delegate.afterSpawn(ticket, child);
      const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      phases.push(lock.gitChildren[ticket].state);
      assert.equal(lock.gitChildren[ticket].pid, child.pid);
      return result;
    },
    afterClose(ticket, child) {
      const result = delegate.afterClose(ticket, child);
      const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      phases.push(Object.keys(lock.gitChildren).length === 0 ? "CLEARED" : "PRESENT");
      return result;
    },
    spawnFailed(ticket, error) {
      return delegate.spawnFailed(ticket, error);
    },
  };
  const result = await runGitFile({
    gitBinary: resolveExecutable("git"),
    disabledHooksPath: root,
    knownHostsPath,
    args: ["--version"],
    commandId: "test.git-version",
    childLifecycle,
    beforeGitSpawn() {
      phases.push("CONTAINMENT");
    },
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(phases, ["SPAWNING", "CONTAINMENT", "RUNNING", "CLEARED"]);
  const blockedTarget = path.join(root, "guard-failure-must-not-start.git");
  const guardFailure = Object.assign(new Error("guardian channel closed"), {
    code: "GIT_CONTROLLER_PROCESS_TREE_ATTESTATION_FAILED",
  });
  await assert.rejects(
    runGitFile({
      gitBinary: resolveExecutable("git"),
      disabledHooksPath: root,
      knownHostsPath,
      args: ["init", "--bare", blockedTarget],
      commandId: "test.guard-failure-clears-ledger",
      childLifecycle: lease.gitChildGuard("test.guard-failure-clears-ledger"),
      beforeGitSpawn() {
        throw guardFailure;
      },
    }),
    (error) => error === guardFailure,
  );
  const lockAfterGuardFailure = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  assert.deepEqual(lockAfterGuardFailure.gitChildren, {});
  assert.equal(fs.existsSync(blockedTarget), false);
  assert.equal(lease.release().ok, true);
  assert.equal(fs.existsSync(lockPath), false);
});

test("guardian loss prevents regular and streamed Git from creating a process", async (t) => {
  const root = fs.mkdtempSync(path.join(tmpdir(), "git-controller-spawn-guard-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const knownHostsPath = path.join(root, "known_hosts");
  const regularTarget = path.join(root, "regular-would-have-spawned.git");
  const streamTarget = path.join(root, "stream-would-have-spawned.git");
  fs.writeFileSync(knownHostsPath, "");
  const synthetic = createSyntheticContainment();
  synthetic.disableGuardian();
  const assertContainmentLive = () => synthetic.session.refresh();
  let afterSpawnCalled = false;
  let afterCloseCalled = false;
  let spawnFailedCalled = false;
  await assert.rejects(
    runGitFile({
      gitBinary: resolveExecutable("git"),
      disabledHooksPath: root,
      knownHostsPath,
      args: ["init", "--bare", regularTarget],
      commandId: "test.guardian-loss-regular",
      beforeGitSpawn: assertContainmentLive,
      childLifecycle: {
        beforeSpawn() {
          return "regular-ticket";
        },
        afterSpawn() {
          afterSpawnCalled = true;
        },
        afterClose() {
          afterCloseCalled = true;
        },
        spawnFailed(ticket) {
          assert.equal(ticket, "regular-ticket");
          spawnFailedCalled = true;
        },
      },
    }),
    { code: "GIT_CONTROLLER_PROCESS_TREE_ATTESTATION_FAILED" },
  );
  assert.equal(afterSpawnCalled, false);
  assert.equal(afterCloseCalled, false);
  assert.equal(spawnFailedCalled, true);
  assert.equal(fs.existsSync(regularTarget), false);

  let recordCount = 0;
  await assert.rejects(
    streamGitNulRecords({
      gitBinary: resolveExecutable("git"),
      disabledHooksPath: root,
      knownHostsPath,
      args: ["init", "--bare", streamTarget],
      commandId: "test.guardian-loss-stream",
      beforeGitSpawn: assertContainmentLive,
      onRecord() {
        recordCount += 1;
      },
    }),
    { code: "GIT_CONTROLLER_PROCESS_TREE_ATTESTATION_FAILED" },
  );
  assert.equal(recordCount, 0);
  assert.equal(fs.existsSync(streamTarget), false);
});

test("Git execution fails closed when a child lifecycle issues no spawn ticket", async (t) => {
  const root = fs.mkdtempSync(path.join(tmpdir(), "git-controller-child-ticket-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const knownHostsPath = path.join(root, "known_hosts");
  fs.writeFileSync(knownHostsPath, "");
  let afterSpawnCalled = false;
  await assert.rejects(
    runGitFile({
      gitBinary: resolveExecutable("git"),
      disabledHooksPath: root,
      knownHostsPath,
      args: ["--version"],
      commandId: "test.missing-child-ticket",
      childLifecycle: {
        beforeSpawn() {
          return null;
        },
        afterSpawn() {
          afterSpawnCalled = true;
        },
        afterClose() {},
        spawnFailed() {},
      },
    }),
    { code: "GIT_CONTROLLER_GIT_CHILD_TICKET_INVALID" },
  );
  assert.equal(afterSpawnCalled, false);
});

test("orphan recovery blocks live or unverifiable Git children and release preserves their lock", (t) => {
  const root = fs.mkdtempSync(path.join(tmpdir(), "git-controller-orphan-child-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lockPath = path.join(root, "repository.lock");
  const repository = { repositoryId: "repo-orphan-child", lockPath };
  const containmentBase = {
    schemaVersion: 2,
    platform: process.platform === "darwin" ? "linux" : process.platform,
    mode: containmentMode(),
    containerPolicyId: "devbench-git-controller-v2",
    policyDigest: "5".repeat(64),
    guardianKeyId: "6".repeat(64),
  };
  const priorContainment = {
    ...containmentBase,
    daemonInstanceId: randomUUID(),
    containerEpoch: `prior-epoch-${randomUUID()}`,
  };
  const currentContainment = {
    ...containmentBase,
    daemonInstanceId: randomUUID(),
    containerEpoch: `current-epoch-${randomUUID()}`,
  };
  const baseLock = {
    schemaVersion: 2,
    lockRevision: 7,
    repositoryId: repository.repositoryId,
    leaseId: "dead-lease",
    operationId: "dead-operation",
    kind: "mirror-refresh",
    ownerInstance: "dead-owner",
    ownerPid: 2_147_483_647,
    ownerProcessStartIdentity: "windows-start:111",
    hostname: hostname(),
    fencingToken: 4,
    acquiredAt: 1,
    heartbeatAt: 1,
    expiresAt: 1,
    processContainment: priorContainment,
  };
  let observedChildIdentity = "windows-start:222";
  const audits = [];
  let treeRecoveryCalls = 0;
  const recoveryProbe = ({ containerEpoch }) => {
    treeRecoveryCalls += 1;
    return {
      ok: true,
      containerSealed: true,
      containerClosed: true,
      activeProcessCount: 0,
      containerEpoch,
      currentContainerEpoch: currentContainment.containerEpoch,
      tombstoneId: `test-tombstone-${treeRecoveryCalls}`,
    };
  };
  const manager = createRepositoryLeaseManager({
    dataRoot: root,
    persistence: {
      appendGitControllerAudit(row) {
        audits.push(row);
      },
    },
    ownerInstance: "replacement-owner",
    processIdentityProbe: (pid) => (
      Number(pid) === process.pid ? observedChildIdentity : null
    ),
    processContainment: currentContainment,
    processTreeRecoveryProbe: recoveryProbe,
    processContainmentAssertLive() {},
  });
  const running = {
    executionId: "git-child-1",
    commandId: "mirror.cleanup-unpublished-history.delete",
    state: "RUNNING",
    pid: process.pid,
    processStartIdentity: "windows-start:222",
    startedAt: 1,
    spawnedAt: 2,
  };
  fs.writeFileSync(lockPath, JSON.stringify({
    ...baseLock,
    schemaVersion: 1,
    gitChildren: undefined,
  }));
  assert.throws(
    () => manager.recoverStaleLock(
      repository,
      lockPath,
      { lease: { operationId: "replacement-operation", fencingToken: 5 } },
      Date.now(),
    ),
    { code: "GIT_CONTROLLER_OS_LOCK_CHILD_LEDGER_UNVERIFIED" },
  );
  assert.equal(fs.existsSync(lockPath), true);

  fs.writeFileSync(lockPath, JSON.stringify({
    ...baseLock,
    gitChildren: { [running.executionId]: running },
  }));
  assert.throws(
    () => manager.recoverStaleLock(
      repository,
      lockPath,
      { lease: { operationId: "replacement-operation", fencingToken: 5 } },
      Date.now(),
    ),
    { code: "GIT_CONTROLLER_OS_LOCK_GIT_CHILD_ACTIVE" },
  );
  assert.equal(fs.existsSync(lockPath), true);
  const recoveryLease = {
    repositoryId: repository.repositoryId,
    leaseId: baseLock.leaseId,
    operationId: baseLock.operationId,
    kind: baseLock.kind,
    ownerInstance: baseLock.ownerInstance,
    ownerHostname: baseLock.hostname,
    ownerPid: baseLock.ownerPid,
    ownerProcessStartIdentity: baseLock.ownerProcessStartIdentity,
    fencingToken: baseLock.fencingToken,
    acquiredAt: baseLock.acquiredAt,
    heartbeatAt: baseLock.heartbeatAt,
    expiresAt: baseLock.expiresAt,
  };
  let orphanReleaseAttempted = false;
  const startupManager = createRepositoryLeaseManager({
    dataRoot: root,
    ownerInstance: "startup-replacement-owner",
    processIdentityProbe: (pid) => (
      Number(pid) === process.pid ? "windows-start:222" : null
    ),
    persistence: {
      getGitControllerRepositoryLease() {
        return recoveryLease;
      },
      releaseOrphanedGitControllerRepositoryLease() {
        orphanReleaseAttempted = true;
        return { ok: true };
      },
      appendGitControllerAudit() {},
    },
    processContainment: currentContainment,
    processTreeRecoveryProbe: recoveryProbe,
    processContainmentAssertLive() {},
  });
  assert.throws(
    () => startupManager.reclaimOrphanedOperation(repository, {
      operationId: baseLock.operationId,
      repositoryId: repository.repositoryId,
      operationType: "MIRROR_REFRESH",
      commandId: "mirror.accepted.publish",
      ownerInstance: baseLock.ownerInstance,
      ownerHostname: baseLock.hostname,
      ownerPid: baseLock.ownerPid,
      ownerProcessStartIdentity: baseLock.ownerProcessStartIdentity,
      fencingToken: baseLock.fencingToken,
    }),
    { code: "GIT_CONTROLLER_OS_LOCK_GIT_CHILD_ACTIVE" },
  );
  assert.equal(orphanReleaseAttempted, false);
  assert.equal(fs.existsSync(lockPath), true);

  observedChildIdentity = null;
  assert.throws(
    () => manager.recoverStaleLock(
      repository,
      lockPath,
      { lease: { operationId: "replacement-operation", fencingToken: 5 } },
      Date.now(),
    ),
    { code: "GIT_CONTROLLER_OS_LOCK_GIT_CHILD_UNVERIFIED" },
  );
  assert.equal(fs.existsSync(lockPath), true);

  const spawning = {
    executionId: "git-child-spawning",
    commandId: "mirror.publish-accepted",
    state: "SPAWNING",
    pid: null,
    processStartIdentity: null,
    startedAt: 3,
  };
  fs.writeFileSync(lockPath, JSON.stringify({
    ...baseLock,
    lockRevision: 8,
    gitChildren: { [spawning.executionId]: spawning },
  }));
  assert.throws(
    () => manager.recoverStaleLock(
      repository,
      lockPath,
      { lease: { operationId: "replacement-operation", fencingToken: 5 } },
      Date.now(),
    ),
    { code: "GIT_CONTROLLER_OS_LOCK_GIT_CHILD_UNCERTAIN" },
  );
  assert.equal(fs.existsSync(lockPath), true);

  fs.writeFileSync(lockPath, JSON.stringify({
    ...baseLock,
    lockRevision: 9,
    gitChildren: { [running.executionId]: running },
  }));
  observedChildIdentity = "windows-start:333";
  const recovered = manager.recoverStaleLock(
    repository,
    lockPath,
    { lease: { operationId: "replacement-operation", fencingToken: 5 } },
    Date.now(),
  );
  assert.equal(recovered.gitChildren[running.executionId].pid, process.pid);
  assert.equal(fs.existsSync(lockPath), false);
  assert.equal(audits.length, 1);
  assert.equal(
    audits[0].details.processTreeProof.processTreeContainerSealed,
    true,
  );
  assert.equal(treeRecoveryCalls, 1);

  fs.writeFileSync(lockPath, JSON.stringify({
    ...baseLock,
    lockRevision: 10,
    gitChildren: {},
  }));
  manager.recoverStaleLock(
    repository,
    lockPath,
    { lease: { operationId: "replacement-operation-empty", fencingToken: 6 } },
    Date.now(),
  );
  assert.equal(fs.existsSync(lockPath), false);
  assert.equal(treeRecoveryCalls, 2);
  assert.equal(
    audits[1].details.processTreeProof.processTreeContainerSealed,
    true,
  );

  const releaseLockPath = path.join(root, "release.lock");
  let leaseRow = null;
  const releaseManager = createRepositoryLeaseManager({
    dataRoot: root,
    ownerInstance: "release-owner",
    ttlMs: 30_000,
    processIdentityProbe: () => "windows-start:444",
    persistence: {
      claimGitControllerRepositoryLease(request) {
        leaseRow = {
          ...request,
          fencingToken: 1,
          acquiredAt: request.now,
          heartbeatAt: request.now,
          expiresAt: request.now + request.ttlMs,
        };
        return { ok: true, lease: { ...leaseRow } };
      },
      assertGitControllerRepositoryLease() {
        return leaseRow ? { ok: true, lease: { ...leaseRow } } : { ok: false };
      },
      renewGitControllerRepositoryLease(request) {
        leaseRow.expiresAt = request.now + request.ttlMs;
        return { ok: true, expiresAt: leaseRow.expiresAt };
      },
      releaseGitControllerRepositoryLease() {
        leaseRow = null;
        return { ok: true };
      },
      appendGitControllerAudit() {},
    },
  });
  const guardedLease = releaseManager.acquire({
    repositoryId: "repo-release-child",
    lockPath: releaseLockPath,
  }, {
    operationId: "release-operation",
    kind: "mirror-refresh",
  });
  guardedLease.beginGitSpawn("mirror.publish-accepted");
  const release = guardedLease.release();
  assert.equal(release.childGuarded, true);
  assert.equal(release.lockRemoved, false);
  assert.equal(fs.existsSync(releaseLockPath), true);
});

test("baseline startup recovery proves orphaning from PID, start identity and exact lease", (t) => {
  const root = fs.mkdtempSync(path.join(tmpdir(), "git-controller-baseline-orphan-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lockPath = path.join(root, "controller.lock");
  const operationId = randomUUID();
  const repository = {
    repositoryId: "repo-baseline-orphan",
    lockPath,
  };
  const ownerInstance = "dead-controller-owner";
  const ownerPid = 2_147_483_647;
  let lease = {
    repositoryId: repository.repositoryId,
    leaseId: randomUUID(),
    operationId,
    kind: "story-baseline-sync",
    ownerInstance,
    ownerHostname: hostname(),
    ownerPid,
    ownerProcessStartIdentity: "windows-start:111",
    fencingToken: 17,
    acquiredAt: 1,
    heartbeatAt: 1,
    expiresAt: Date.now() + 60_000,
  };
  const lock = {
    schemaVersion: 2,
    lockRevision: 1,
    gitChildren: {},
    repositoryId: repository.repositoryId,
    leaseId: lease.leaseId,
    operationId,
    kind: lease.kind,
    ownerInstance,
    ownerPid,
    ownerProcessStartIdentity: lease.ownerProcessStartIdentity,
    hostname: hostname(),
    fencingToken: lease.fencingToken,
    acquiredAt: 1,
    heartbeatAt: 1,
    expiresAt: lease.expiresAt,
  };
  fs.writeFileSync(lockPath, JSON.stringify(lock));
  const audits = [];
  const persistence = {
    getGitControllerRepositoryLease() {
      return lease;
    },
    releaseOrphanedGitControllerRepositoryLease(request) {
      assert.equal(request.operationId, operationId);
      assert.equal(request.leaseId, lease.leaseId);
      assert.equal(request.ownerPid, ownerPid);
      lease = null;
      return { ok: true };
    },
    appendGitControllerAudit(row) {
      audits.push(row);
    },
  };
  const manager = createRepositoryLeaseManager({
    dataRoot: root,
    persistence,
    ownerInstance: "startup-recovery-owner",
    processIdentityProbe: () => null,
  });
  const operation = {
    operationId,
    repositoryId: repository.repositoryId,
    ownerInstance,
    ownerHostname: hostname(),
    ownerPid,
    ownerProcessStartIdentity: "windows-start:111",
    fencingToken: 17,
  };
  const recovered = manager.reclaimOrphanedOperation(repository, operation);
  assert.equal(recovered.orphaned, true);
  assert.equal(recovered.ownerPidAlive, false);
  assert.equal(lease, null);
  assert.equal(fs.existsSync(lockPath), false);
  assert.equal(fs.existsSync(recovered.staleLockPath), true);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].reason, "owner_process_stopped");

  const activeLockPath = path.join(root, "active.lock");
  const activeOperationId = randomUUID();
  const activeStart = "windows-start:222";
  const activeLease = {
    repositoryId: "repo-baseline-active",
    leaseId: randomUUID(),
    operationId: activeOperationId,
    kind: "story-baseline-sync",
    ownerInstance: "active-controller-owner",
    ownerHostname: hostname(),
    ownerPid: process.pid,
    ownerProcessStartIdentity: activeStart,
    fencingToken: 18,
    acquiredAt: 1,
    heartbeatAt: 1,
    expiresAt: Date.now() + 60_000,
  };
  fs.writeFileSync(activeLockPath, JSON.stringify({
    schemaVersion: 2,
    lockRevision: 1,
    gitChildren: {},
    ...activeLease,
    hostname: hostname(),
  }));
  const activeManager = createRepositoryLeaseManager({
    dataRoot: root,
    persistence: {
      getGitControllerRepositoryLease() {
        return activeLease;
      },
    },
    ownerInstance: "other-startup-owner",
    processIdentityProbe: () => activeStart,
  });
  assert.throws(
    () => activeManager.reclaimOrphanedOperation({
      repositoryId: activeLease.repositoryId,
      lockPath: activeLockPath,
    }, {
      operationId: activeOperationId,
      repositoryId: activeLease.repositoryId,
      ownerInstance: activeLease.ownerInstance,
      ownerHostname: hostname(),
      ownerPid: process.pid,
      ownerProcessStartIdentity: activeStart,
      fencingToken: activeLease.fencingToken,
    }),
    { code: "GIT_CONTROLLER_OPERATION_OWNER_ACTIVE" },
  );
  assert.equal(fs.existsSync(activeLockPath), true);
});

test("client rejects a forged Controller response", () => {
  const setup = fixture("forged-response");
  const requestId = "a".repeat(32);
  const envelope = signedEnvelope({
    keys: setup.keys,
    requestId,
    endpoint: setup.clientConfig.endpoint,
    controllerIdentity: setup.clientConfig.expectedControllerIdentity,
    keyFingerprint: setup.clientConfig.expectedKeyFingerprint,
  });
  envelope.body.data.escalated = true;
  assert.throws(
    () => verifyControllerResponseEnvelope(envelope, {
      publicKey: setup.clientConfig.publicKey,
      expectedEndpoint: setup.clientConfig.endpoint,
      expectedControllerIdentity: setup.clientConfig.expectedControllerIdentity,
      expectedEndpointAclFingerprint: setup.clientConfig.expectedEndpointAclFingerprint,
      expectedKeyFingerprint: setup.clientConfig.expectedKeyFingerprint,
      requestId,
      gatewayIdentity: setup.clientConfig.gatewayIdentity,
    }),
    { code: "GIT_CONTROLLER_RESPONSE_SIGNATURE_INVALID" },
  );
});

test("client rejects signed endpoint drift", () => {
  const setup = fixture("endpoint-drift");
  const requestId = "b".repeat(32);
  const envelope = signedEnvelope({
    keys: setup.keys,
    requestId,
    endpoint: endpoint("drifted"),
    controllerIdentity: setup.clientConfig.expectedControllerIdentity,
    keyFingerprint: setup.clientConfig.expectedKeyFingerprint,
  });
  assert.throws(
    () => verifyControllerResponseEnvelope(envelope, {
      publicKey: setup.clientConfig.publicKey,
      expectedEndpoint: setup.clientConfig.endpoint,
      expectedControllerIdentity: setup.clientConfig.expectedControllerIdentity,
      expectedEndpointAclFingerprint: setup.clientConfig.expectedEndpointAclFingerprint,
      expectedKeyFingerprint: setup.clientConfig.expectedKeyFingerprint,
      requestId,
      gatewayIdentity: setup.clientConfig.gatewayIdentity,
    }),
    { code: "GIT_CONTROLLER_ATTESTATION_MISMATCH" },
  );
});

test("client rejects Controller attestation from the Gateway OS identity", () => {
  const setup = fixture("same-identity");
  const requestId = "c".repeat(32);
  const envelope = signedEnvelope({
    keys: setup.keys,
    requestId,
    endpoint: setup.clientConfig.endpoint,
    controllerIdentity: setup.clientConfig.gatewayIdentity,
    keyFingerprint: setup.clientConfig.expectedKeyFingerprint,
  });
  assert.throws(
    () => verifyControllerResponseEnvelope(envelope, {
      publicKey: setup.clientConfig.publicKey,
      expectedEndpoint: setup.clientConfig.endpoint,
      expectedControllerIdentity: setup.clientConfig.gatewayIdentity,
      expectedEndpointAclFingerprint: setup.clientConfig.expectedEndpointAclFingerprint,
      expectedKeyFingerprint: setup.clientConfig.expectedKeyFingerprint,
      requestId,
      gatewayIdentity: setup.clientConfig.gatewayIdentity,
    }),
    { code: "GIT_CONTROLLER_ATTESTATION_MISMATCH" },
  );
});

test("production runtime fails closed without independent Controller config", async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousAdapter = process.env.DEVBENCH_GIT_CONTROLLER_ADAPTER;
  const previousConfig = process.env.DEVBENCH_GIT_CONTROLLER_CLIENT_CONFIG;
  process.env.NODE_ENV = "production";
  delete process.env.DEVBENCH_GIT_CONTROLLER_ADAPTER;
  delete process.env.DEVBENCH_GIT_CONTROLLER_CLIENT_CONFIG;
  resetGitControllerRuntimeForTests();
  try {
    await assert.rejects(
      () => getGitControllerRuntime(),
      { code: "GIT_CONTROLLER_CLIENT_CONFIG_REQUIRED" },
    );
  } finally {
    if (previousNodeEnv == null) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousAdapter == null) delete process.env.DEVBENCH_GIT_CONTROLLER_ADAPTER;
    else process.env.DEVBENCH_GIT_CONTROLLER_ADAPTER = previousAdapter;
    if (previousConfig == null) delete process.env.DEVBENCH_GIT_CONTROLLER_CLIENT_CONFIG;
    else process.env.DEVBENCH_GIT_CONTROLLER_CLIENT_CONFIG = previousConfig;
    resetGitControllerRuntimeForTests();
  }
});

test("normal launcher with empty NODE_ENV also fails closed instead of using in-process", async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousAdapter = process.env.DEVBENCH_GIT_CONTROLLER_ADAPTER;
  const previousConfig = process.env.DEVBENCH_GIT_CONTROLLER_CLIENT_CONFIG;
  delete process.env.NODE_ENV;
  delete process.env.DEVBENCH_GIT_CONTROLLER_ADAPTER;
  delete process.env.DEVBENCH_GIT_CONTROLLER_CLIENT_CONFIG;
  resetGitControllerRuntimeForTests();
  try {
    await assert.rejects(
      () => getGitControllerRuntime(),
      { code: "GIT_CONTROLLER_CLIENT_CONFIG_REQUIRED" },
    );
  } finally {
    if (previousNodeEnv == null) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousAdapter == null) delete process.env.DEVBENCH_GIT_CONTROLLER_ADAPTER;
    else process.env.DEVBENCH_GIT_CONTROLLER_ADAPTER = previousAdapter;
    if (previousConfig == null) delete process.env.DEVBENCH_GIT_CONTROLLER_CLIENT_CONFIG;
    else process.env.DEVBENCH_GIT_CONTROLLER_CLIENT_CONFIG = previousConfig;
    resetGitControllerRuntimeForTests();
  }
});

test("Gateway process provision branch delegates repository creation and avoids local Git", () => {
  const source = fs.readFileSync(
    new URL("../routes/devbench.js", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("async function provisionLocalStoryWorkspace");
  const end = source.indexOf("\nfunction isMutationLeaseLoss", start);
  const body = source.slice(start, end);
  assert.match(body, /selectedGitControllerRuntime\.adapter === "process"/);
  assert.match(body, /processControllerRuntime\.storyRepositories\.provision\(/);
  assert.match(body, /worktreeMutationAttemptToken\(tab\)/);
  assert.match(body, /story-repository-provision-attempt-v1/);
  assert.match(body, /idempotencyKey:\s*provisionIdempotencyKey/);
  assert.match(body, /processControllerRuntime\s*\?[\s\S]*:\s*await provisionStoryWorktrees\(/);
  const branchGuard = body.indexOf('selectedGitControllerRuntime.adapter === "process"');
  const localGitBranch = body.indexOf("store.gitBranch(currentPath)");
  assert.ok(branchGuard >= 0 && branchGuard < localGitBranch);

  const resolver = fs.readFileSync(
    new URL("../services/devbench/git-controller-runtime.js", import.meta.url),
    "utf8",
  );
  const resolverStart = resolver.indexOf("export async function resolveControllerRepositoryByBase");
  const resolverEnd = resolver.indexOf("\nexport async function refreshAcceptedForStory", resolverStart);
  const resolverBody = resolver.slice(resolverStart, resolverEnd);
  assert.ok(resolverBody.indexOf('runtime.adapter === "process"') < resolverBody.indexOf("gitTopLevel(basePath)"));

  const retireStart = source.indexOf("async function cleanupStoryWorktreesWithController");
  const retireEnd = source.indexOf("\n/**", retireStart);
  const retireBody = source.slice(retireStart, retireEnd);
  assert.match(retireBody, /runtime\.storyRepositories\.retire\(/);
  assert.doesNotMatch(retireBody, /fs\.rmSync|rmSync\(/);
  const manager = fs.readFileSync(
    new URL("../services/devbench/worktree-manager.js", import.meta.url),
    "utf8",
  );
  const independentGate = manager.indexOf(
    'code: "STORY_REPOSITORY_CONTROLLER_RETIRE_REQUIRED"',
  );
  assert.ok(independentGate >= 0);
  assert.doesNotMatch(manager, /removeIndependentStoryRepository|independentRemoval/);

  const reopenStart = source.indexOf('router.post("/tabs/reopen-closed"');
  const reopenEnd = source.indexOf('router.post("/tabs/:id/primary"', reopenStart);
  const reopenBody = source.slice(reopenStart, reopenEnd);
  assert.match(reopenBody, /deferCommit:\s*true/);
  assert.match(reopenBody, /for\s*\(const preparedTab of preparedTabs\)/);
  assert.match(reopenBody, /deferStoreCommit:\s*true/);
  assert.match(reopenBody, /commitPreparedReopen/);
  assert.match(reopenBody, /workspace\.rollback\(\)/);
  assert.match(reopenBody, /abortPreparedReopen/);

  const clientSource = fs.readFileSync(
    new URL("../services/devbench/git-controller-client.js", import.meta.url),
    "utf8",
  );
  const provisionStart = clientSource.indexOf("provision(payload = {})");
  const provisionEnd = clientSource.indexOf("\n      inspect:", provisionStart);
  const provisionBody = clientSource.slice(provisionStart, provisionEnd);
  assert.match(provisionBody, /GIT_CONTROLLER_IDEMPOTENCY_KEY_REQUIRED/);
  assert.match(provisionBody, /process\.env\.NODE_ENV/);
  assert.match(provisionBody, /payload\.idempotencyKey/);
});
