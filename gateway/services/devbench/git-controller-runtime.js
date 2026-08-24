import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as store from "./store.js";
import {
  GitControllerError,
  createGitController,
} from "./git-controller/index.js";
import { createGitControllerCapabilityService } from "./git-controller-capability.js";
import { diagnoseBaseProtectionHooks } from "./base-protection-hooks.js";
import { createStoryBaselineService } from "./story-baseline.js";
import {
  GIT_CONTROLLER_FIXED_CLIENT_CONFIG_PATH,
  createGitControllerProcessRuntime,
} from "./git-controller-client.js";
import {
  storyAcceptedRefreshIdempotencyKey,
} from "./git-controller-process-protocol.js";

let cachedKey = "";
let cachedRuntimePromise = null;
let cachedProcessConfig = "";
let cachedProcessRuntimePromise = null;

function pathKey(value) {
  const resolved = path.resolve(String(value || "")).replace(/[\\/]+/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isInside(root, candidate) {
  const parent = pathKey(root);
  const child = pathKey(candidate);
  return !!parent && !!child && (parent === child || child.startsWith(`${parent}/`));
}

function normalizeBranch(value) {
  const branch = String(value || "").trim().replace(/^refs\/heads\//, "");
  if (
    !branch
    || branch.endsWith("(detached)")
    || /^(?:[0-9a-f]{7,64})$/i.test(branch)
    || !/^[A-Za-z0-9._/-]+$/.test(branch)
    || branch.startsWith(".")
    || branch.startsWith("/")
    || branch.endsWith(".")
    || branch.endsWith("/")
    || branch.includes("..")
    || branch.includes("//")
    || branch.includes("@{")
    || branch.split("/").some((segment) => segment.endsWith(".lock"))
  ) {
    return "";
  }
  return branch;
}

function gitTopLevel(candidate) {
  const input = String(candidate || "").trim();
  if (!input || !path.isAbsolute(input) || !fs.existsSync(input)) return "";
  try {
    return path.resolve(execFileSync(
      "git",
      ["-C", input, "rev-parse", "--show-toplevel"],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 256 * 1024,
      },
    ).trim());
  } catch {
    return "";
  }
}

function definitionRemoteKeys(definition = {}) {
  return [...new Set(
    [definition.ssh, definition.https]
      .map((value) => store.repositoryKey(value))
      .filter(Boolean),
  )];
}

function physicalCandidates() {
  const result = [];
  for (const project of store.listProjects()) {
    if (project?.path) {
      result.push({
        configuredPath: project.path,
        displayName: project.name || path.basename(project.path),
      });
    }
    if (project?.webAppPath) {
      result.push({
        configuredPath: project.webAppPath,
        displayName: `${project.name || path.basename(project.path || "")}/WebApp`,
      });
    }
  }
  return result;
}

export function buildGitControllerDefinitions() {
  const sharedDefinitions = store.getProjectDefs();
  const sharedByRemote = new Map();
  for (const definition of sharedDefinitions) {
    for (const key of definitionRemoteKeys(definition)) {
      const rows = sharedByRemote.get(key) || [];
      rows.push(definition);
      sharedByRemote.set(key, rows);
    }
  }
  const emitted = new Set();
  const definitions = [];
  const warnings = [];

  for (const candidate of physicalCandidates()) {
    const basePath = gitTopLevel(candidate.configuredPath);
    if (!basePath) {
      warnings.push({
        code: "GIT_CONTROLLER_LOCAL_REPOSITORY_INVALID",
        displayName: candidate.displayName,
      });
      continue;
    }
    const actualRemote = store.gitRemoteUrl(basePath);
    const actualRemoteKey = store.repositoryKey(actualRemote);
    const matched = actualRemoteKey ? (sharedByRemote.get(actualRemoteKey) || []) : [];
    if (!matched.length) {
      warnings.push({
        code: "GIT_CONTROLLER_REMOTE_NOT_REGISTERED",
        displayName: candidate.displayName,
      });
      continue;
    }
    for (const logical of matched) {
      const branches = [...new Set([
        logical.defaultBranch,
        ...(Array.isArray(logical.branchOptions) ? logical.branchOptions : []),
      ].map(normalizeBranch).filter(Boolean))].sort();
      if (!branches.length) {
        warnings.push({
          code: "GIT_CONTROLLER_BRANCHES_MISSING",
          displayName: candidate.displayName,
          logicalDefinitionId: logical.id,
        });
        continue;
      }
      const unique = `${pathKey(basePath)}\0${logical.id}`;
      if (emitted.has(unique)) continue;
      emitted.add(unique);
      definitions.push({
        logicalDefinitionId: logical.id,
        displayName: candidate.displayName,
        basePath,
        remoteId: "origin",
        expectedRemoteUrls: [logical.ssh, logical.https].filter(Boolean),
        allowedBranches: branches,
        allowedSubmoduleUrls: logical.allowedSubmoduleUrls,
        submoduleAllowlist: logical.submoduleAllowlist,
        baseSyncPolicy: {
          requireClean: true,
          fastForwardOnly: true,
          allowCheckout: false,
          allowAutomaticStash: false,
          allowMergeCommit: false,
          allowRemoteRewind: false,
          autoApplyWhenClean: false,
        },
        isolationMode: "separate-worker-identity",
      });
    }
  }
  definitions.sort((left, right) => (
    pathKey(left.basePath).localeCompare(pathKey(right.basePath))
    || left.logicalDefinitionId.localeCompare(right.logicalDefinitionId)
  ));
  return { definitions, warnings };
}

function runtimeDataRoot() {
  const configuredCloneParent = String(store.ensureCloneParentReady() || "").trim();
  if (!configuredCloneParent || !path.isAbsolute(configuredCloneParent)) {
    throw new GitControllerError(
      "GIT_CONTROLLER_DATA_ROOT_MISSING",
      "DevBench clone parent must be a configured absolute path",
    );
  }
  const cloneParent = path.resolve(configuredCloneParent);
  const dataRoot = path.join(cloneParent, ".devbench", "git-controller");
  for (const project of store.listProjects()) {
    for (const candidate of [project?.path, project?.webAppPath].filter(Boolean)) {
      const top = gitTopLevel(candidate);
      if (top && isInside(top, dataRoot)) {
        throw new GitControllerError(
          "GIT_CONTROLLER_DATA_ROOT_INSIDE_BASE",
          "Git Controller data root cannot be inside a base repository",
        );
      }
    }
  }
  fs.mkdirSync(dataRoot, { recursive: true });
  return dataRoot;
}

function digestRuntime(definitions, dataRoot) {
  return createHash("sha256").update(JSON.stringify({
    dataRoot: pathKey(dataRoot),
    definitions: definitions.map((definition) => ({
      logicalDefinitionId: definition.logicalDefinitionId,
      basePath: pathKey(definition.basePath),
      mirrorPath: definition.mirrorPath ? pathKey(definition.mirrorPath) : "",
      remoteId: String(definition.remoteId || "origin"),
      expectedRemoteUrls: definition.expectedRemoteUrls.map((value) => store.repositoryKey(value)),
      allowedBranches: definition.allowedBranches,
      allowedSubmoduleUrls: definition.allowedSubmoduleUrls || null,
      submoduleAllowlist: definition.submoduleAllowlist || null,
      credentialRef: String(definition.credentialRef || ""),
      allowAnonymousRemote: definition.allowAnonymousRemote === true,
      isolationMode: String(definition.isolationMode || ""),
      baseSyncPolicy: definition.baseSyncPolicy || null,
      publicationPolicy: definition.publicationPolicy || null,
    })),
  })).digest("hex");
}

function registryDiagnosticCodes(values, fallbackCode) {
  const list = Array.isArray(values)
    ? values
    : (values == null ? [] : [values]);
  return list.map((value) => {
    const code = typeof value === "object" && value !== null
      ? String(value.code || "").trim()
      : "";
    return code || fallbackCode;
  });
}

export function assertGitControllerRegistryComplete({
  registrationErrors = [],
  warnings = [],
} = {}) {
  const registrationErrorCodes = registryDiagnosticCodes(
    registrationErrors,
    "GIT_CONTROLLER_REGISTRATION_FAILED",
  );
  const warningCodes = registryDiagnosticCodes(
    warnings,
    "GIT_CONTROLLER_RUNTIME_WARNING",
  );
  if (!registrationErrorCodes.length && !warningCodes.length) return true;
  throw new GitControllerError(
    "GIT_CONTROLLER_REGISTRY_INCOMPLETE",
    "Git Controller cannot start with incomplete repository registration",
    {
      registrationErrorCount: registrationErrorCodes.length,
      warningCount: warningCodes.length,
      registrationErrorCodes,
      warningCodes,
    },
  );
}

export async function getLocalGitControllerRuntimeForDaemon({
  forceReload = false,
  definitionsOverride = null,
  dataRootOverride = "",
  warningsOverride = null,
  gitBinaryOverride = "",
  gitBinaryAttestor = null,
  knownHostsPathOverride = "",
  credentialDescriptorsOverride = {},
  credentialDescriptorAttestor = null,
  leaseProcessContainment = null,
  leaseProcessTreeRecoveryProbe = null,
  leaseProcessContainmentAssertLive = null,
  continueOnDefinitionError = true,
} = {}) {
  const discovered = definitionsOverride
    ? {
        definitions: definitionsOverride,
        warnings: Array.isArray(warningsOverride) ? warningsOverride : [],
      }
    : buildGitControllerDefinitions();
  const { definitions, warnings } = discovered;
  if (continueOnDefinitionError !== true) {
    assertGitControllerRegistryComplete({ warnings });
  }
  const dataRoot = dataRootOverride
    ? path.resolve(String(dataRootOverride))
    : runtimeDataRoot();
  const credentialRefs = Object.keys(credentialDescriptorsOverride || {}).sort().join(",");
  const warningDigest = createHash("sha256")
    .update(JSON.stringify(registryDiagnosticCodes(
      warnings,
      "GIT_CONTROLLER_RUNTIME_WARNING",
    )))
    .digest("hex");
  const registrationMode = continueOnDefinitionError === true
    ? "continue-on-definition-error"
    : "require-complete-registry";
  const key = [
    digestRuntime(definitions, dataRoot),
    gitBinaryOverride,
    knownHostsPathOverride,
    credentialRefs,
    registrationMode,
    warningDigest,
    leaseProcessContainment?.containerEpoch || "",
  ].join(":");
  if (forceReload || !cachedRuntimePromise || cachedKey !== key) {
    cachedKey = key;
    cachedRuntimePromise = (async () => {
      let controllerReference = null;
      const capabilityService = createGitControllerCapabilityService({
        dataRoot: path.join(dataRoot, "capabilities"),
        resolveRepositoryFingerprint(repositoryId) {
          if (!controllerReference) {
            throw new GitControllerError(
              "GIT_CONTROLLER_CAPABILITY_CONTROLLER_UNAVAILABLE",
              "Git Controller is not ready to issue a base capability",
            );
          }
          const entry = controllerReference.registry.get(repositoryId);
          const diagnosis = diagnoseBaseProtectionHooks(entry.basePath, {
            ignoreActivity: true,
            skipAuditProbe: true,
          });
          if (
            diagnosis.status !== "ACTIVE"
            || !/^[0-9a-f]{64}$/i.test(String(diagnosis.repositoryFingerprint || ""))
          ) {
            throw new GitControllerError(
              "GIT_CONTROLLER_BASE_PROTECTION_INACTIVE",
              "Managed base protection must be active before issuing a write capability",
              {
                repositoryId: entry.repositoryId,
                protectionStatus: diagnosis.status,
                protectionIssues: diagnosis.issues || [],
              },
            );
          }
          return diagnosis.repositoryFingerprint;
        },
      });
      const controller = await createGitController({
        definitions,
        dataRoot,
        gitBinary: gitBinaryOverride || "git",
        gitBinaryAttestor,
        knownHostsPath: knownHostsPathOverride || null,
        credentialDescriptors: credentialDescriptorsOverride,
        credentialDescriptorAttestor,
        leaseProcessContainment,
        leaseProcessTreeRecoveryProbe,
        leaseProcessContainmentAssertLive,
        capabilityIssuer: async (context) => ({
          capability: await capabilityService.issue(context),
          environment: capabilityService.environment,
        }),
        continueOnDefinitionError: continueOnDefinitionError === true,
      });
      controllerReference = controller;
      const runtimeWarnings = [
        ...warnings,
        ...(Array.isArray(controller.registrationErrors) ? controller.registrationErrors : []),
      ];
      if (continueOnDefinitionError !== true) {
        assertGitControllerRegistryComplete({
          registrationErrors: controller.registrationErrors,
          warnings,
        });
      }
      const storyBaseline = createStoryBaselineService({ controller });
      return {
        controller,
        storyBaseline,
        capabilityService,
        dataRoot,
        definitions,
        warnings: runtimeWarnings,
      };
    })().catch((error) => {
      if (cachedKey === key) {
        cachedKey = "";
        cachedRuntimePromise = null;
      }
      throw error;
    });
  }
  return cachedRuntimePromise;
}

export async function getInProcessGitControllerRuntimeForTests(options = {}) {
  if (String(process.env.NODE_ENV || "").trim().toLowerCase() !== "test") {
    throw new GitControllerError(
      "GIT_CONTROLLER_TEST_ADAPTER_FORBIDDEN",
      "The in-process Git Controller test adapter requires NODE_ENV=test",
    );
  }
  return getLocalGitControllerRuntimeForDaemon(options);
}

export async function getGitControllerRuntime({
  forceReload = false,
} = {}) {
  const environment = String(process.env.NODE_ENV || "").trim().toLowerCase();
  const adapter = String(process.env.DEVBENCH_GIT_CONTROLLER_ADAPTER || "")
    .trim()
    .toLowerCase();
  const explicitTestAdapter = adapter === "in-process-test";
  const explicitDevelopmentAdapter = adapter === "in-process-dev"
    && environment === "development"
    && String(process.env.DEVBENCH_ALLOW_IN_PROCESS_GIT_CONTROLLER || "") === "1";
  if (explicitTestAdapter) {
    return getInProcessGitControllerRuntimeForTests({ forceReload });
  }
  if (adapter === "in-process-dev" && !explicitDevelopmentAdapter) {
    throw new GitControllerError(
      "GIT_CONTROLLER_IN_PROCESS_FORBIDDEN",
      "In-process Controller development adapter requires NODE_ENV=development and an explicit unsafe development opt-in",
    );
  }
  const useProcess = !explicitDevelopmentAdapter;
  if (useProcess) {
    if (adapter === "in-process") {
      throw new GitControllerError(
        "GIT_CONTROLLER_IN_PROCESS_FORBIDDEN",
        "Git Controller cannot run inside the Gateway process",
      );
    }
    const configPath = String(
      process.env.DEVBENCH_GIT_CONTROLLER_CLIENT_CONFIG
      || GIT_CONTROLLER_FIXED_CLIENT_CONFIG_PATH,
    ).trim();
    if (!configPath || !fs.existsSync(configPath)) {
      throw new GitControllerError(
        "GIT_CONTROLLER_CLIENT_CONFIG_REQUIRED",
        "Production requires an independent Git Controller endpoint and trust policy",
      );
    }
    if (
      forceReload
      || !cachedProcessRuntimePromise
      || cachedProcessConfig !== configPath
    ) {
      cachedProcessConfig = configPath;
      cachedProcessRuntimePromise = createGitControllerProcessRuntime({
        configPath,
      }).catch((error) => {
        if (cachedProcessConfig === configPath) {
          cachedProcessConfig = "";
          cachedProcessRuntimePromise = null;
        }
        throw error;
      });
    }
    return cachedProcessRuntimePromise;
  }
  return getLocalGitControllerRuntimeForDaemon({ forceReload });
}

export async function resolveControllerRepositoryByBase(basePath, {
  branch = "",
} = {}) {
  const runtime = await getGitControllerRuntime();
  if (runtime.adapter === "process") {
    const entry = runtime.controller.registry.getByBasePath(basePath);
    const normalized = normalizeBranch(branch);
    if (!normalized) {
      throw new GitControllerError(
        "GIT_CONTROLLER_BRANCH_REQUIRED",
        "A statically registered source branch is required",
      );
    }
    await runtime.controller.registry.resolve(entry.repositoryId, normalized);
    return { ...runtime, entry, branch: normalized };
  }
  const top = gitTopLevel(basePath);
  if (!top) {
    throw new GitControllerError(
      "GIT_CONTROLLER_BASE_NOT_REGISTERED",
      "Selected base repository is unavailable",
    );
  }
  const entry = runtime.controller.registry.getByBasePath(top);
  const normalized = normalizeBranch(branch) || normalizeBranch(store.gitBranch(top));
  if (!normalized) {
    throw new GitControllerError(
      "GIT_CONTROLLER_BRANCH_REQUIRED",
      "A registered source branch is required",
    );
  }
  await runtime.controller.registry.resolve(entry.repositoryId, normalized);
  return { ...runtime, entry, branch: normalized };
}

export async function refreshAcceptedForStory({
  basePath,
  branch,
  storyId,
  exactSha = "",
} = {}) {
  const runtime = await resolveControllerRepositoryByBase(basePath, { branch });
  if (runtime.accepted?.refresh) {
    const idempotencyKey = storyAcceptedRefreshIdempotencyKey({
      storyId,
      repositoryId: runtime.entry.repositoryId,
      branch: runtime.branch,
      exactSha,
    });
    const descriptor = await runtime.accepted.refresh({
      repositoryId: runtime.entry.repositoryId,
      branch: runtime.branch,
      storyId: String(storyId || ""),
      exactSha: String(exactSha || ""),
      idempotencyKey,
    });
    return {
      ...descriptor,
      baseRevision: descriptor.candidateSha,
    };
  }
  const preview = await runtime.controller.mirror.preview({
    repositoryId: runtime.entry.repositoryId,
    branch: runtime.branch,
  });
  if (!preview.eligible) {
    throw new GitControllerError(
      preview.blockerCode || "GIT_CONTROLLER_MIRROR_REFRESH_BLOCKED",
      "Remote candidate did not pass the managed mirror policy",
      { relationship: preview.relationship },
    );
  }
  const idempotencyKey = createHash("sha256").update([
    "story-provision",
    String(storyId || ""),
    runtime.entry.repositoryId,
    runtime.branch,
    String(preview.candidateSha || ""),
  ].join("\0")).digest("hex");
  const accepted = await runtime.controller.mirror.execute({
    repositoryId: runtime.entry.repositoryId,
    branch: runtime.branch,
    previewId: preview.previewId,
    previewVersion: preview.previewVersion,
    expectedAcceptedSha: preview.lastAcceptedSha || "",
    candidateSha: preview.candidateSha,
    idempotencyKey,
    actor: "controller:story-provision",
  });
  const requestedSha = String(exactSha || accepted.candidateSha).trim().toLowerCase();
  const descriptor = await runtime.controller.mirror.resolveAcceptedCandidate({
    repositoryId: runtime.entry.repositoryId,
    branch: runtime.branch,
    candidateSha: requestedSha,
  });
  return {
    ...descriptor,
    baseRevision: descriptor.candidateSha,
  };
}

export function resetGitControllerRuntimeForTests() {
  cachedKey = "";
  cachedRuntimePromise = null;
  cachedProcessConfig = "";
  cachedProcessRuntimePromise = null;
}

export const __test = Object.freeze({
  gitTopLevel,
  normalizeBranch,
  pathKey,
});
