import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  createIndependentStoryRepository,
  independentStoryRepositoryPath,
  inspectIndependentStoryRepository,
  rollbackCreatedIndependentStoryRepository,
} from "./git-controller/story-repository.js";
import {
  GitControllerError,
  assertIdempotencyKey,
  listAllRecoverableOperations,
  normalizeSha,
  pathInside,
} from "./git-controller/index.js";
import {
  WORKER_DEPLOYMENT_PROBE_CONFIG_PATH,
  createManagedWorkerProbeProtectionCallbacks,
  enumerateControllerInaccessibleEntries,
  loadManagedWorkerDeploymentProbeConfig,
  reconcileManagedWorkerDeploymentProbeConfig,
} from "../worker-isolation-deployment.js";
import {
  STORY_BASELINE_METADATA_KEYS,
  validateStoryBaselineRegistryRecoveryMarker,
} from "./story-baseline-registry-recovery.js";
import {
  analyzeAuthoritativeFlavorDiff,
  buildSystemCommitMessage,
  validateFlavorAgainstCatalog,
  validateSystemCommitMessage,
} from "./workflow-v2/build-diff-gate.js";
import {
  deriveWorkflowV2EditState,
  receiptBindsWorkflowV2EditState,
  verifyWorkflowV2EditStateFiles,
} from "./workflow-v2/edit-state-binding.js";

const WINDOWS_SYSTEM32 = "C:\\Windows\\System32";
const WINDOWS_ICACLS = path.join(WINDOWS_SYSTEM32, "icacls.exe");
const WINDOWS_POWERSHELL = path.join(
  WINDOWS_SYSTEM32,
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
const UNIX_SETFACL = "/usr/bin/setfacl";
const UNIX_GETFACL = "/usr/bin/getfacl";

const PROVISION_OPERATION = "STORY_REPOSITORY_PROVISION";
const CLEANUP_OPERATION = "STORY_REPOSITORY_CLEANUP";
const RETIRE_OPERATION = "STORY_REPOSITORY_RETIRE";
const COMMIT_OPERATION = "STORY_REPOSITORY_COMMIT";
const RETIRE_PREVIEW_KIND = "STORY_REPOSITORY_RETIRE";
const RETIRE_PREVIEW_TTL_MS = 5 * 60_000;
const WORKER_PROBE_PENDING_SCHEMA = "devbench.worker-probe-reconcile-pending.v1";
const REGISTRY_TOPOLOGY_NOOP = Symbol("registry-topology-noop");

function storyRegistryMetadata(row = {}) {
  return Object.fromEntries(
    STORY_BASELINE_METADATA_KEYS.map((key) => [key, row[key]]),
  );
}

function storyRegistryMetadataEquals(row, expected) {
  return STORY_BASELINE_METADATA_KEYS.every((key) => row?.[key] === expected?.[key]);
}

function registryTopologyNoop(result) {
  return { [REGISTRY_TOPOLOGY_NOOP]: true, result };
}

function normalizedControllerPath(value, platform = process.platform) {
  const resolved = path.resolve(String(value || ""))
    .replace(/[\\/]+/g, "/")
    .replace(/\/+$/, "");
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

function fsyncControllerDirectory(directoryPath) {
  if (process.platform === "win32") return false;
  const descriptor = fs.openSync(directoryPath, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  return true;
}

function uniqueControllerPaths(values) {
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    const resolved = path.resolve(String(value || ""));
    const key = normalizedControllerPath(resolved);
    if (!value || !path.isAbsolute(String(value)) || seen.has(key)) continue;
    seen.add(key);
    result.push(resolved);
  }
  return result.sort((left, right) => (
    normalizedControllerPath(left).localeCompare(normalizedControllerPath(right))
  ));
}

function workerProbeTopologyDigest(topology = {}) {
  return createHash("sha256").update(JSON.stringify({
    generation: Number(topology.generation),
    stories: [...(topology.stories || [])].map((story) => ({
      storyId: story.storyId,
      cwd: normalizedControllerPath(story.cwd),
      allowedRoots: story.allowedRoots.map((value) => normalizedControllerPath(value)).sort(),
      writeDeniedRoots: story.writeDeniedRoots
        .map((value) => normalizedControllerPath(value)).sort(),
      inaccessibleRoots: story.inaccessibleRoots
        .map((value) => normalizedControllerPath(value)).sort(),
      workerIdentity: String(story.workerIdentity || "").toLowerCase(),
      aclFingerprints: [...story.aclFingerprints].sort(),
    })).sort((left, right) => left.storyId.localeCompare(right.storyId)),
  })).digest("hex");
}

function asControllerError(error, fallback = "STORY_REPOSITORY_CONTROLLER_FAILED") {
  if (error instanceof GitControllerError) return error;
  return new GitControllerError(
    String(error?.code || fallback),
    String(error?.message || "Managed story repository operation failed"),
    {},
    { cause: error },
  );
}

function replay(operation, expected) {
  if (
    ("branch" in expected && operation.branch !== expected.branch)
    || (
      "candidateSha" in expected
      && String(operation.candidateSha || "") !== String(expected.candidateSha || "")
    )
    || (
      "expectedHead" in expected
      && String(operation.expectedHead || "") !== String(expected.expectedHead || "")
    )
    || (
      "previewId" in expected
      && String(operation.previewId || "") !== String(expected.previewId || "")
    )
  ) {
    throw new GitControllerError(
      "GIT_CONTROLLER_IDEMPOTENCY_CONFLICT",
      "Idempotency key was already used for another story repository request",
    );
  }
  if (operation.status === "SUCCEEDED" && operation.result) {
    return { ...operation.result, replayed: true };
  }
  if (operation.status === "RUNNING") {
    throw new GitControllerError(
      "GIT_CONTROLLER_OPERATION_IN_PROGRESS",
      "Story repository operation is still running",
      { operationId: operation.operationId },
    );
  }
  const stored = operation.error || {};
  throw new GitControllerError(
    stored.code || operation.resultCode || "GIT_CONTROLLER_OPERATION_FAILED",
    stored.message || "Idempotent story repository operation previously failed",
    stored.details || {},
  );
}

function storyBranch(storyId, repositoryId) {
  const body = String(storyId || "")
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 48) || "story";
  const suffix = createHash("sha256")
    .update(`${storyId}\0${repositoryId}`)
    .digest("hex")
    .slice(0, 12);
  return `story/${body}_${suffix}`;
}

function operationBinding(kind, values) {
  const digest = createHash("sha256")
    .update([kind, ...values.map((value) => String(value ?? ""))].join("\0"))
    .digest("hex");
  return `__${kind}__/${digest}`;
}

function candidateContentPreflightEvidence(result = {}) {
  const evidence = {
    eligible: result.eligible === true,
    blockerCode: String(result.blockerCode || "") || null,
    status: String(result.status || "") || null,
    reason: String(result.reason || "") || null,
    submoduleCount: Math.max(0, Number(result.submoduleCount) || 0),
    verifiedCommitCount: Math.max(0, Number(result.verifiedCommitCount) || 0),
  };
  return {
    ...evidence,
    digest: createHash("sha256")
      .update(JSON.stringify(evidence))
      .digest("hex"),
  };
}

function candidateContentPreflightEvidenceValid(value) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || value.eligible !== true
    || !/^[0-9a-f]{64}$/.test(String(value.digest || ""))
  ) {
    return false;
  }
  return candidateContentPreflightEvidence(value).digest === value.digest;
}

function storyGit(
  gitBinary,
  disabledHooksPath,
  repositoryPath,
  args,
  gitSpawnGuard = null,
  runOptions = {},
) {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (
      /^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG_PARAMETERS|CONFIG_COUNT|EXEC_PATH|TEMPLATE_DIR)$/i.test(key)
      || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/i.test(key)
    ) {
      delete environment[key];
    }
  }
  environment.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_ATTR_NOSYSTEM = "1";
  environment.GIT_TERMINAL_PROMPT = "0";
  environment.GIT_NO_REPLACE_OBJECTS = "1";
  environment.LC_ALL = "C";
  environment.LANG = "C";
  if (gitSpawnGuard != null && typeof gitSpawnGuard !== "function") {
    throw new GitControllerError(
      "GIT_CONTROLLER_GIT_SPAWN_GUARD_INVALID",
      "Story repository Git spawn guard must be a synchronous Controller-owned function",
    );
  }
  const guardResult = gitSpawnGuard?.();
  if (guardResult && typeof guardResult.then === "function") {
    throw new GitControllerError(
      "GIT_CONTROLLER_GIT_SPAWN_GUARD_ASYNC",
      "Story repository Git spawn guard must complete synchronously before process creation",
    );
  }
  const output = execFileSync(
    gitBinary,
    [
      "--no-optional-locks",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.untrackedCache=false",
      "-c",
      `core.hooksPath=${disabledHooksPath.replace(/\\/g, "/")}`,
      "-c",
      "diff.external=",
      "-c",
      `core.attributesFile=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
      "-c",
      "credential.helper=",
      "-c",
      "credential.interactive=never",
      "-c",
      `safe.directory=${path.resolve(repositoryPath).replace(/\\/g, "/")}`,
      "-C",
      repositoryPath,
      ...args,
    ],
    {
      encoding: runOptions.encoding === null ? null : "utf8",
      windowsHide: true,
      timeout: Number(runOptions.timeoutMs || 30_000),
      maxBuffer: Number(runOptions.maxBuffer || 4 * 1024 * 1024),
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (runOptions.encoding === null) return output || Buffer.alloc(0);
  const text = String(output || "");
  return runOptions.trim === false ? text : text.trim();
}

function textLines(value) {
  return String(value || "").split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
}

function normalizeCommitRelativePath(value) {
  const normalized = String(value || "").trim().replace(/\\/g, "/");
  const segments = normalized.split("/");
  if (
    !normalized
    || normalized.length > 500
    || path.isAbsolute(normalized)
    || segments.some((segment) => !segment || segment === "." || segment === "..")
    || segments[0].toLowerCase() === ".git"
    || /[\0\r\n]/.test(normalized)
  ) {
    throw new GitControllerError(
      "STORY_REPOSITORY_COMMIT_PATH_INVALID",
      "Declared commit changes must be canonical repository-relative paths",
      { path: normalized.slice(0, 300) },
    );
  }
  return normalized;
}

function assertCommitPathInsideRepository(repositoryPath, relativePath) {
  const normalized = normalizeCommitRelativePath(relativePath);
  const root = path.resolve(repositoryPath);
  const target = path.resolve(root, ...normalized.split("/"));
  if (!pathInside(root, target) || normalizedControllerPath(target) === normalizedControllerPath(root)) {
    throw new GitControllerError(
      "STORY_REPOSITORY_COMMIT_PATH_OUTSIDE_ROOT",
      "Commit path resolves outside the Controller-owned story repository",
      { path: normalized },
    );
  }
  let current = root;
  for (const segment of normalized.split("/")) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) break;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new GitControllerError(
        "STORY_REPOSITORY_COMMIT_PATH_LINK_REJECTED",
        "Commit path contains a symbolic link or junction",
        { path: normalized },
      );
    }
  }
  if (fs.existsSync(target)) {
    const realTarget = fs.realpathSync.native
      ? fs.realpathSync.native(target)
      : fs.realpathSync(target);
    if (!pathInside(root, realTarget)) {
      throw new GitControllerError(
        "STORY_REPOSITORY_COMMIT_PATH_OUTSIDE_ROOT",
        "Commit path realpath escapes the Controller-owned story repository",
        { path: normalized },
      );
    }
  }
  return normalized;
}

function nulGitRecords(value) {
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : String(value || "");
  return text.split("\0").filter(Boolean);
}

function storyCommitStatus(gitBinary, disabledHooksPath, repositoryPath, gitSpawnGuard) {
  const records = nulGitRecords(storyGit(
    gitBinary,
    disabledHooksPath,
    repositoryPath,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    gitSpawnGuard,
    { encoding: null, maxBuffer: 16 * 1024 * 1024 },
  ));
  const paths = [];
  const entries = [];
  let unmerged = false;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.length < 4 || record[2] !== " ") {
      throw new GitControllerError(
        "STORY_REPOSITORY_COMMIT_STATUS_INVALID",
        "Git status returned an unrecognized porcelain record",
      );
    }
    const status = record.slice(0, 2);
    const changedPath = normalizeCommitRelativePath(record.slice(3));
    paths.push(changedPath);
    const renamed = /[RC]/.test(status);
    let sourcePath = null;
    if (renamed) {
      sourcePath = normalizeCommitRelativePath(records[++index]);
      paths.push(sourcePath);
    }
    if (status.includes("U") || ["AA", "DD"].includes(status)) unmerged = true;
    entries.push({ status, path: changedPath, sourcePath });
  }
  const hiddenIndex = nulGitRecords(storyGit(
    gitBinary,
    disabledHooksPath,
    repositoryPath,
    ["ls-files", "-v", "-z"],
    gitSpawnGuard,
    { encoding: null, maxBuffer: 16 * 1024 * 1024 },
  )).filter((record) => /^[Ssh] /.test(record));
  return {
    entries,
    paths: [...new Set(paths)].sort(),
    unmerged,
    hiddenIndex: hiddenIndex.map((record) => record.slice(2)).sort(),
  };
}

function exactPathSet(actual, expected, code, message) {
  const left = [...new Set((actual || []).map(normalizeCommitRelativePath))].sort();
  const right = [...new Set((expected || []).map(normalizeCommitRelativePath))].sort();
  if (left.length !== right.length || left.some((value, index) => value !== right[index])) {
    throw new GitControllerError(code, message, { actual: left, expected: right });
  }
  return left;
}

function normalizeCommitRequest(payload = {}) {
  const declaredChanges = (Array.isArray(payload.declaredChanges)
    ? payload.declaredChanges
    : []).map(normalizeCommitRelativePath).sort();
  const requiredCheckReceiptIds = (Array.isArray(payload.requiredCheckReceiptIds)
    ? payload.requiredCheckReceiptIds.map((value) => String(value || "").trim())
    : []).sort();
  if (
    !declaredChanges.length
    || new Set(declaredChanges).size !== declaredChanges.length
    || !requiredCheckReceiptIds.length
    || new Set(requiredCheckReceiptIds).size !== requiredCheckReceiptIds.length
    || requiredCheckReceiptIds.some((value) => !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value))
  ) {
    throw new GitControllerError(
      "STORY_REPOSITORY_COMMIT_REQUEST_INVALID",
      "Commit requires unique declared changes and required check receipt identities",
    );
  }
  const summary = String(payload.changeSummary || "").trim().replace(/\s+/g, " ");
  if (!summary || summary.length > 120 || !/[\u3400-\u9fff]/u.test(summary)) {
    throw new GitControllerError(
      "STORY_REPOSITORY_COMMIT_SUMMARY_INVALID",
      "Commit change summary must be a bounded Chinese description",
    );
  }
  const targetFlavor = String(payload.targetFlavor || "").trim();
  const expectedBranch = String(payload.expectedBranch || "").trim();
  const operationId = assertIdempotencyKey(payload.operationId);
  const expectedHead = normalizeSha(payload.expectedHead, {
    label: "story repository expected HEAD",
  });
  if (!targetFlavor || !expectedBranch) {
    throw new GitControllerError(
      "STORY_REPOSITORY_COMMIT_REQUEST_INVALID",
      "Commit requires expected branch and target Flavor",
    );
  }
  return Object.freeze({
    tabId: String(payload.tabId || "").trim(),
    repositoryId: String(payload.repositoryId || "").trim(),
    operationId,
    expectedHead,
    expectedBranch,
    targetFlavor,
    changeSummary: summary,
    declaredChanges: Object.freeze(declaredChanges),
    requiredCheckReceiptIds: Object.freeze(requiredCheckReceiptIds),
  });
}

function commitRequestBinding(request) {
  return operationBinding("story_commit", [
    request.tabId,
    request.repositoryId,
    request.operationId,
    request.expectedHead,
    request.expectedBranch,
    request.targetFlavor.toLowerCase(),
    request.changeSummary,
    ...request.declaredChanges,
    "--required-checks--",
    ...request.requiredCheckReceiptIds,
  ]);
}

function commitReadback(gitBinary, disabledHooksPath, repositoryPath, commitSha, gitSpawnGuard) {
  const sha = normalizeSha(storyGit(
    gitBinary,
    disabledHooksPath,
    repositoryPath,
    ["rev-parse", "--verify", `${commitSha}^{commit}`],
    gitSpawnGuard,
  ), { label: "story repository commit readback SHA" });
  const message = storyGit(
    gitBinary,
    disabledHooksPath,
    repositoryPath,
    ["show", "-s", "--format=%B", sha],
    gitSpawnGuard,
    { trim: false, maxBuffer: 128 * 1024 },
  ).trimEnd();
  const parents = textLines(storyGit(
    gitBinary,
    disabledHooksPath,
    repositoryPath,
    ["show", "-s", "--format=%P", sha],
    gitSpawnGuard,
  )).flatMap((line) => line.split(/\s+/)).filter(Boolean).map((value) => value.toLowerCase());
  const changedPaths = nulGitRecords(storyGit(
    gitBinary,
    disabledHooksPath,
    repositoryPath,
    ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "--no-renames", "-z", sha],
    gitSpawnGuard,
    { encoding: null, maxBuffer: 16 * 1024 * 1024 },
  )).map(normalizeCommitRelativePath).sort();
  return { sha, message, parents, changedPaths };
}

function stableCanonicalValue(value) {
  if (Array.isArray(value)) return value.map(stableCanonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableCanonicalValue(value[key])]),
    );
  }
  return value;
}

function canonicalObjectSha256(value) {
  return createHash("sha256")
    .update(JSON.stringify(stableCanonicalValue(value)))
    .digest("hex");
}

function plainDirectory(value, label) {
  const resolved = path.resolve(String(value || ""));
  if (!fs.existsSync(resolved)) {
    throw new GitControllerError(
      "STORY_REPOSITORY_COMMIT_TRUST_SOURCE_MISSING",
      `${label} is unavailable`,
    );
  }
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new GitControllerError(
      "STORY_REPOSITORY_COMMIT_TRUST_SOURCE_INVALID",
      `${label} must be a plain Controller-readable directory`,
    );
  }
  const real = fs.realpathSync.native
    ? fs.realpathSync.native(resolved)
    : fs.realpathSync(resolved);
  if (normalizedControllerPath(real) !== normalizedControllerPath(resolved)) {
    throw new GitControllerError(
      "STORY_REPOSITORY_COMMIT_TRUST_SOURCE_INVALID",
      `${label} path contains a symbolic link or junction`,
    );
  }
  return resolved;
}

function readControllerWorkflowReceipts(storyDevRoot, storyId) {
  const root = plainDirectory(storyDevRoot, "Workflow evidence root");
  const matches = [];
  for (const storyEntry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!storyEntry.isDirectory() || storyEntry.isSymbolicLink()) continue;
    const storyDirectory = path.join(root, storyEntry.name);
    const receiptDirectory = path.join(
      storyDirectory,
      "workflow-v2",
      "envelopes",
      "evidence-receipt",
    );
    if (!fs.existsSync(receiptDirectory)) continue;
    plainDirectory(receiptDirectory, "Workflow receipt stream");
    const files = fs.readdirSync(receiptDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^\d{12}\.json$/.test(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name));
    let previousEnvelopeSha256 = null;
    let streamStoryId = null;
    const receipts = [];
    for (const file of files) {
      const filePath = path.join(receiptDirectory, file.name);
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || Number(stat.nlink || 1) !== 1) {
        throw new GitControllerError(
          "STORY_REPOSITORY_COMMIT_RECEIPT_STORE_INVALID",
          "Workflow receipt record is not a single plain file",
        );
      }
      let envelope;
      try {
        envelope = JSON.parse(fs.readFileSync(filePath, "utf8"));
      } catch {
        throw new GitControllerError(
          "STORY_REPOSITORY_COMMIT_RECEIPT_STORE_INVALID",
          "Workflow receipt record is invalid JSON",
        );
      }
      const { envelopeSha256, ...unsigned } = envelope || {};
      const payload = envelope?.payload;
      streamStoryId ||= String(envelope?.storyId || "");
      if (
        envelope?.payloadSchemaId !== "https://example.local/schemas/evidence-receipt-v2.json"
        || !streamStoryId
        || envelope?.storyId !== streamStoryId
        || envelope?.recordId !== payload?.receiptId
        || envelope?.contextId !== null
        || envelope?.revision !== Number(file.name.slice(0, 12))
        || envelope?.payloadSha256 !== canonicalObjectSha256(payload)
        || envelopeSha256 !== canonicalObjectSha256(unsigned)
        || envelope?.previousEnvelopeSha256 !== previousEnvelopeSha256
      ) {
        throw new GitControllerError(
          "STORY_REPOSITORY_COMMIT_RECEIPT_TAMPERED",
          "Workflow receipt hash chain or story binding is invalid",
        );
      }
      previousEnvelopeSha256 = envelopeSha256;
      receipts.push({ envelope, payload, storyDirectory });
    }
    if (receipts.length && streamStoryId === String(storyId)) {
      matches.push({ storyDirectory, receipts });
    }
  }
  if (matches.length !== 1) {
    throw new GitControllerError(
      matches.length
        ? "STORY_REPOSITORY_COMMIT_RECEIPT_STORY_AMBIGUOUS"
        : "STORY_REPOSITORY_COMMIT_RECEIPT_STORY_MISSING",
      "Workflow receipt store does not resolve to one exact story",
      { storyId, matches: matches.length },
    );
  }
  return matches[0];
}

function defaultControllerFlavorPolicy(repositoryPath, {
  expectedHead,
  gitBinary,
  disabledHooksPath,
  gitSpawnGuard,
} = {}) {
  const root = path.resolve(repositoryPath);
  const catalog = new Set();
  const sourceSets = {};
  let authoritativeCatalog = false;
  const readAtExpectedHead = (relativePath) => {
    try {
      return storyGit(
        gitBinary,
        disabledHooksPath,
        root,
        ["show", `${expectedHead}:${relativePath}`],
        gitSpawnGuard,
        { trim: false, maxBuffer: 2 * 1024 * 1024 },
      );
    } catch {
      return null;
    }
  };
  const configText = readAtExpectedHead("flavorConfig.json");
  if (configText != null) {
    let parsed;
    try { parsed = JSON.parse(configText); } catch {
      throw new GitControllerError(
        "STORY_REPOSITORY_COMMIT_FLAVOR_CATALOG_INVALID",
        "Expected-HEAD Flavor catalog JSON is invalid",
      );
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new GitControllerError(
        "STORY_REPOSITORY_COMMIT_FLAVOR_CATALOG_INVALID",
        "Flavor catalog JSON must be an object",
      );
    }
    for (const name of Object.keys(parsed)) catalog.add(name);
    authoritativeCatalog = true;
  }
  if (!authoritativeCatalog) {
    for (const relative of ["project_flavor.gradle", "app/project_flavor.gradle"]) {
      const text = readAtExpectedHead(relative);
      if (text == null) continue;
      for (const match of text.matchAll(/(?:^|\n)\s*([A-Za-z][A-Za-z0-9_]*)\s*\{/g)) {
        if (!["productFlavors", "android", "buildTypes"].includes(match[1])) {
          catalog.add(match[1]);
        }
      }
      for (const match of text.matchAll(/\bcreate\s*\(\s*["']([A-Za-z][A-Za-z0-9_]*)["']\s*\)/g)) {
        catalog.add(match[1]);
      }
    }
    authoritativeCatalog = catalog.size > 0;
  }
  const treePaths = nulGitRecords(storyGit(
    gitBinary,
    disabledHooksPath,
    root,
    ["ls-tree", "-r", "--name-only", "-z", expectedHead],
    gitSpawnGuard,
    { encoding: null, maxBuffer: 16 * 1024 * 1024 },
  ));
  for (const treePath of treePaths) {
    const normalized = normalizeCommitRelativePath(treePath);
    const match = normalized.match(/(?:^|\/)src\/([^/]+)(?:\/|$)/i);
    if (!match) continue;
    const name = match[1];
    const key = name.toLowerCase();
    const segments = normalized.split("/");
    const srcIndex = segments.findIndex((segment) => segment.toLowerCase() === "src");
    const sourceRoot = segments.slice(0, srcIndex + 2).join("/");
    sourceSets[key] ||= sourceRoot;
      if (
        !authoritativeCatalog
        && !["main", "test", "androidtest", "testfixtures", "debug", "release"].includes(key)
      ) {
        catalog.add(name);
      }
  }
  if (authoritativeCatalog) {
    const allowedSourceSetNames = new Set([
      "main",
      ...[...catalog].map((name) => name.toLowerCase()),
    ]);
    for (const name of Object.keys(sourceSets)) {
      if (!allowedSourceSetNames.has(name)) delete sourceSets[name];
    }
  }
  return {
    catalog: [...catalog].sort(),
    sourceSets,
    mainImpactApproved: false,
    source: authoritativeCatalog ? "repository-catalog" : "repository-source-sets",
  };
}

const LEGACY_MIGRATION_MAX_PATHS = 250_000;
const LEGACY_MIGRATION_MAX_BYTES = 20 * 1024 * 1024 * 1024;

function nullSeparatedGitPaths(value, label) {
  const paths = String(value || "").split("\0").filter(Boolean);
  if (paths.length > LEGACY_MIGRATION_MAX_PATHS) {
    throw new GitControllerError(
      "STORY_REPOSITORY_LEGACY_MIGRATION_TOO_LARGE",
      `${label} exceeds the bounded legacy migration path limit`,
      { count: paths.length, limit: LEGACY_MIGRATION_MAX_PATHS },
    );
  }
  return paths;
}

function canonicalExistingDirectory(value, label) {
  const input = String(value || "").trim();
  if (!input || !path.isAbsolute(input)) {
    throw new GitControllerError(
      "STORY_REPOSITORY_LEGACY_SOURCE_INVALID",
      `${label} must be an absolute directory`,
    );
  }
  let resolved;
  try {
    resolved = fs.realpathSync.native
      ? fs.realpathSync.native(input)
      : fs.realpathSync(input);
  } catch {
    throw new GitControllerError(
      "STORY_REPOSITORY_LEGACY_SOURCE_MISSING",
      `${label} no longer exists`,
    );
  }
  if (!fs.statSync(resolved).isDirectory()) {
    throw new GitControllerError(
      "STORY_REPOSITORY_LEGACY_SOURCE_INVALID",
      `${label} is not a directory`,
    );
  }
  return path.resolve(resolved);
}

function assertLegacyRelativePath(root, relativePath, label = "legacy story path") {
  const value = String(relativePath || "").replace(/\\/g, "/");
  const segments = value.split("/");
  if (
    !value
    || value.includes("\0")
    || path.isAbsolute(value)
    || segments.some((segment) => !segment || segment === "." || segment === "..")
    || segments[0].toLowerCase() === ".git"
  ) {
    throw new GitControllerError(
      "STORY_REPOSITORY_LEGACY_PATH_INVALID",
      `${label} is outside the legacy worktree`,
      { path: value.slice(0, 300) },
    );
  }
  const target = path.resolve(root, ...segments);
  if (!pathInside(root, target) || normalizedControllerPath(target) === normalizedControllerPath(root)) {
    throw new GitControllerError(
      "STORY_REPOSITORY_LEGACY_PATH_INVALID",
      `${label} escapes the legacy worktree`,
      { path: value.slice(0, 300) },
    );
  }
  let current = path.resolve(root);
  for (const segment of segments) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) break;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new GitControllerError(
        "STORY_REPOSITORY_LEGACY_CONTENT_LINK",
        "Legacy story migration rejects symbolic links and junctions",
        { path: value.slice(0, 300) },
      );
    }
  }
  return target;
}

function stableFileDigest(filePath, relativePath) {
  const before = fs.lstatSync(filePath);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new GitControllerError(
      "STORY_REPOSITORY_LEGACY_CONTENT_TYPE",
      "Legacy story migration accepts regular files only",
      { path: String(relativePath || "").slice(0, 300) },
    );
  }
  const hash = createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < before.size) {
      const read = fs.readSync(
        descriptor,
        buffer,
        0,
        Math.min(buffer.length, before.size - offset),
        offset,
      );
      if (!read) break;
      hash.update(buffer.subarray(0, read));
      offset += read;
    }
    const after = fs.fstatSync(descriptor);
    if (
      after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || (before.ino && after.ino && before.ino !== after.ino)
    ) {
      throw new GitControllerError(
        "STORY_REPOSITORY_LEGACY_SOURCE_CHANGED",
        "Legacy story file changed while it was being inspected",
        { path: String(relativePath || "").slice(0, 300) },
      );
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return {
    size: before.size,
    mode: before.mode & 0o777,
    digest: hash.digest("hex"),
  };
}

function legacySourceGit(
  gitBinary,
  disabledHooksPath,
  sourcePath,
  args,
  gitSpawnGuard,
) {
  return storyGit(
    gitBinary,
    disabledHooksPath,
    sourcePath,
    args,
    gitSpawnGuard,
    { trim: false, maxBuffer: 64 * 1024 * 1024, timeoutMs: 120_000 },
  );
}

function legacySourceGitBuffer(
  gitBinary,
  disabledHooksPath,
  sourcePath,
  args,
  gitSpawnGuard,
) {
  return storyGit(
    gitBinary,
    disabledHooksPath,
    sourcePath,
    args,
    gitSpawnGuard,
    {
      encoding: null,
      trim: false,
      maxBuffer: 512 * 1024 * 1024,
      timeoutMs: 180_000,
    },
  );
}

function inspectLegacyMigrationSource({
  gitBinary,
  disabledHooksPath,
  gitSpawnGuard,
  sourcePath,
  entry,
  storyRoot,
  dataRoot,
}) {
  const source = canonicalExistingDirectory(sourcePath, "Legacy story worktree");
  const basePath = canonicalExistingDirectory(entry.basePath, "Registered base repository");
  if (
    normalizedControllerPath(source) === normalizedControllerPath(basePath)
    || pathInside(storyRoot, source)
    || pathInside(dataRoot, source)
  ) {
    throw new GitControllerError(
      "STORY_REPOSITORY_LEGACY_SOURCE_BOUNDARY_INVALID",
      "Legacy migration source must be an old linked worktree outside Controller-owned roots",
    );
  }
  const topLevelRaw = legacySourceGit(
    gitBinary,
    disabledHooksPath,
    source,
    ["rev-parse", "--show-toplevel"],
    gitSpawnGuard,
  ).trim();
  const topLevel = canonicalExistingDirectory(topLevelRaw, "Legacy story Git top-level");
  if (normalizedControllerPath(topLevel) !== normalizedControllerPath(source)) {
    throw new GitControllerError(
      "STORY_REPOSITORY_LEGACY_SOURCE_BOUNDARY_INVALID",
      "Legacy migration source is not the exact Git worktree root",
    );
  }
  const commonRaw = legacySourceGit(
    gitBinary,
    disabledHooksPath,
    source,
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    gitSpawnGuard,
  ).trim();
  const commonPath = canonicalExistingDirectory(
    path.isAbsolute(commonRaw) ? commonRaw : path.resolve(source, commonRaw),
    "Legacy story Git common directory",
  );
  const registeredCommon = canonicalExistingDirectory(
    entry.baseGitCommonPath,
    "Registered base Git common directory",
  );
  if (normalizedControllerPath(commonPath) !== normalizedControllerPath(registeredCommon)) {
    throw new GitControllerError(
      "STORY_REPOSITORY_LEGACY_GIT_IDENTITY_MISMATCH",
      "Legacy story worktree does not share the registered base repository identity",
    );
  }

  const sparse = (() => {
    try {
      return legacySourceGit(
        gitBinary,
        disabledHooksPath,
        source,
        ["config", "--bool", "core.sparseCheckout"],
        gitSpawnGuard,
      ).trim() === "true";
    } catch {
      return false;
    }
  })();
  const headRevision = normalizeSha(
    legacySourceGit(
      gitBinary,
      disabledHooksPath,
      source,
      ["rev-parse", "--verify", "HEAD^{commit}"],
      gitSpawnGuard,
    ).trim(),
    { label: "legacy story HEAD" },
  );
  const branch = legacySourceGit(
    gitBinary,
    disabledHooksPath,
    source,
    ["branch", "--show-current"],
    gitSpawnGuard,
  ).trim();
  const statusRaw = legacySourceGit(
    gitBinary,
    disabledHooksPath,
    source,
    ["status", "--porcelain=v1", "-z", "-uall"],
    gitSpawnGuard,
  );
  const trackedPaths = [...new Set(nullSeparatedGitPaths(
    legacySourceGit(
      gitBinary,
      disabledHooksPath,
      source,
      ["ls-files", "-z"],
      gitSpawnGuard,
    ),
    "Tracked file list",
  ))].sort();
  const untrackedPaths = [...new Set(nullSeparatedGitPaths(
    legacySourceGit(
      gitBinary,
      disabledHooksPath,
      source,
      ["ls-files", "--others", "--exclude-standard", "-z"],
      gitSpawnGuard,
    ),
    "Untracked file list",
  ))].sort();
  const dirtyTrackedPaths = [...new Set(nullSeparatedGitPaths(
    legacySourceGit(
      gitBinary,
      disabledHooksPath,
      source,
      ["diff", "--name-only", "-z", "HEAD"],
      gitSpawnGuard,
    ),
    "Changed tracked file list",
  ))].sort();
  const unmergedPaths = [...new Set(nullSeparatedGitPaths(
    legacySourceGit(
      gitBinary,
      disabledHooksPath,
      source,
      ["diff", "--name-only", "--diff-filter=U", "-z"],
      gitSpawnGuard,
    ),
    "Unmerged file list",
  ))].sort();
  const stageRows = textLines(legacySourceGit(
    gitBinary,
    disabledHooksPath,
    source,
    ["ls-files", "--stage"],
    gitSpawnGuard,
  ));
  const specialIndexPaths = stageRows
    .filter((line) => /^(?:120000|160000) /.test(line))
    .map((line) => line.slice(line.indexOf("\t") + 1))
    .filter(Boolean);
  const hiddenIndexPaths = nullSeparatedGitPaths(
    legacySourceGit(
      gitBinary,
      disabledHooksPath,
      source,
      ["ls-files", "-v", "-z"],
      gitSpawnGuard,
    ),
    "Hidden index flag list",
  )
    .filter((line) => /^[Ssh] /.test(line))
    .map((line) => line.slice(2))
    .filter(Boolean);
  const stashOids = textLines(legacySourceGit(
    gitBinary,
    disabledHooksPath,
    source,
    ["stash", "list", "--format=%H"],
    gitSpawnGuard,
  ));

  const changedPaths = [...new Set([...dirtyTrackedPaths, ...untrackedPaths])].sort();
  const changedContent = [];
  let changedBytes = 0;
  for (const relativePath of changedPaths) {
    const absolutePath = assertLegacyRelativePath(source, relativePath);
    if (!fs.existsSync(absolutePath)) {
      changedContent.push({ path: relativePath, deleted: true });
      continue;
    }
    const file = stableFileDigest(absolutePath, relativePath);
    changedBytes += file.size;
    if (changedBytes > LEGACY_MIGRATION_MAX_BYTES) {
      throw new GitControllerError(
        "STORY_REPOSITORY_LEGACY_MIGRATION_TOO_LARGE",
        "Legacy story changed files exceed the bounded migration size limit",
        { bytes: changedBytes, limit: LEGACY_MIGRATION_MAX_BYTES },
      );
    }
    changedContent.push({ path: relativePath, ...file });
  }
  for (const relativePath of trackedPaths) assertLegacyRelativePath(source, relativePath);

  const blockers = [
    ...(sparse ? [{
      code: "LEGACY_SPARSE_CHECKOUT",
      message: "旧工作区启用了 sparse checkout，请先恢复完整工作区",
    }] : []),
    ...(unmergedPaths.length ? [{
      code: "LEGACY_UNMERGED_CHANGES",
      message: `旧工作区有 ${unmergedPaths.length} 个未解决冲突，请先解决冲突`,
    }] : []),
    ...(stashOids.length ? [{
      code: "LEGACY_STASH_PRESENT",
      message: `旧工作区有 ${stashOids.length} 份 stash，请先应用或另行备份`,
    }] : []),
    ...(specialIndexPaths.length ? [{
      code: "LEGACY_SPECIAL_GIT_ENTRIES",
      message: "旧工作区包含符号链接或 submodule，需先改为普通文件/目录",
    }] : []),
    ...(hiddenIndexPaths.length ? [{
      code: "LEGACY_HIDDEN_INDEX_FLAGS",
      message: `旧工作区有 ${hiddenIndexPaths.length} 个 skip-worktree/assume-unchanged 文件，请先清除隐藏索引标记`,
    }] : []),
  ];
  const stateDigest = createHash("sha256").update(JSON.stringify({
    source: normalizedControllerPath(source),
    commonPath: normalizedControllerPath(commonPath),
    headRevision,
    branch,
    statusDigest: createHash("sha256").update(statusRaw).digest("hex"),
    trackedPathsDigest: createHash("sha256").update(trackedPaths.join("\0")).digest("hex"),
    untrackedPaths,
    changedContent,
    stashOids,
    sparse,
    unmergedPaths,
    specialIndexPaths,
    hiddenIndexPaths,
  })).digest("hex");
  return {
    sourcePath: source,
    headRevision,
    branch,
    stateDigest,
    trackedPaths,
    untrackedPaths,
    changedPaths,
    dirtyTrackedCount: dirtyTrackedPaths.length,
    untrackedCount: untrackedPaths.length,
    changedBytes,
    stashCount: stashOids.length,
    unmergedCount: unmergedPaths.length,
    hiddenIndexCount: hiddenIndexPaths.length,
    blockers,
    canMigrate: blockers.length === 0,
    changedFiles: changedPaths.slice(0, 30),
  };
}

function copyStableLegacyFile(sourcePath, targetPath, relativePath) {
  const before = fs.lstatSync(sourcePath);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new GitControllerError(
      "STORY_REPOSITORY_LEGACY_CONTENT_TYPE",
      "Legacy story migration accepts regular files only",
      { path: String(relativePath || "").slice(0, 300) },
    );
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);
  if (process.platform !== "win32") fs.chmodSync(targetPath, before.mode & 0o777);
  const after = fs.lstatSync(sourcePath);
  if (
    after.size !== before.size
    || after.mtimeMs !== before.mtimeMs
    || (before.ino && after.ino && before.ino !== after.ino)
  ) {
    throw new GitControllerError(
      "STORY_REPOSITORY_LEGACY_SOURCE_CHANGED",
      "Legacy story changed while its files were being copied",
      { path: String(relativePath || "").slice(0, 300) },
    );
  }
}

function applyLegacyWorktreeSnapshot({
  gitBinary,
  disabledHooksPath,
  gitSpawnGuard,
  sourceState,
  targetPath,
  candidateSha,
  patchRoot,
  expectedStateDigest,
  inspectSource,
}) {
  if (!sourceState.canMigrate) {
    throw new GitControllerError(
      "STORY_REPOSITORY_LEGACY_MIGRATION_BLOCKED",
      sourceState.blockers[0]?.message || "Legacy story migration is blocked",
      { blockers: sourceState.blockers },
    );
  }
  if (sourceState.stateDigest !== expectedStateDigest) {
    throw new GitControllerError(
      "STORY_REPOSITORY_LEGACY_PREVIEW_STALE",
      "旧工作区在预览后发生变化，请重新检查再升级",
    );
  }
  const target = canonicalExistingDirectory(targetPath, "Independent story repository");
  try {
    legacySourceGit(
      gitBinary,
      disabledHooksPath,
      sourceState.sourcePath,
      ["cat-file", "-e", `${candidateSha}^{commit}`],
      gitSpawnGuard,
    );
  } catch (error) {
    throw new GitControllerError(
      "STORY_REPOSITORY_LEGACY_BASE_OBJECT_MISSING",
      "旧工作区缺少 Controller accepted 基线对象，无法生成无损迁移快照",
      {},
      { cause: error },
    );
  }
  const patch = legacySourceGitBuffer(
    gitBinary,
    disabledHooksPath,
    sourceState.sourcePath,
    [
      "diff",
      "--binary",
      "--full-index",
      "--no-ext-diff",
      "--no-renames",
      candidateSha,
      "--",
      ".",
    ],
    gitSpawnGuard,
  );
  if (patch.length > 512 * 1024 * 1024) {
    throw new GitControllerError(
      "STORY_REPOSITORY_LEGACY_MIGRATION_TOO_LARGE",
      "Legacy story tracked-file patch exceeds the bounded migration size limit",
      { bytes: patch.length, limit: 512 * 1024 * 1024 },
    );
  }
  const patchDirectory = fs.mkdtempSync(path.join(
    canonicalExistingDirectory(patchRoot, "Controller migration patch root"),
    "legacy-story-migration-",
  ));
  const patchPath = path.join(patchDirectory, "snapshot.patch");
  try {
    fs.writeFileSync(patchPath, patch, { mode: 0o600 });
    if (patch.length) {
      legacySourceGit(
        gitBinary,
        disabledHooksPath,
        target,
        ["apply", "--binary", "--whitespace=nowarn", patchPath],
        gitSpawnGuard,
      );
      // A reverse dry-run proves that every tracked-file hunk, deletion, new file
      // and binary payload now exists in the target exactly as described by the
      // source snapshot, without staging or mutating the target.
      legacySourceGit(
        gitBinary,
        disabledHooksPath,
        target,
        ["apply", "--check", "--reverse", "--binary", patchPath],
        gitSpawnGuard,
      );
    }
  } finally {
    fs.rmSync(patchDirectory, { recursive: true, force: true });
  }

  let copiedFiles = 0;
  let copiedBytes = 0;
  for (const relativePath of sourceState.untrackedPaths) {
    const sourceFile = assertLegacyRelativePath(
      sourceState.sourcePath,
      relativePath,
      "legacy untracked path",
    );
    const destination = assertLegacyRelativePath(target, relativePath, "independent story path");
    const stat = fs.lstatSync(sourceFile);
    copiedBytes += stat.size;
    if (copiedBytes > LEGACY_MIGRATION_MAX_BYTES) {
      throw new GitControllerError(
        "STORY_REPOSITORY_LEGACY_MIGRATION_TOO_LARGE",
        "Legacy story snapshot exceeds the bounded migration size limit",
        { bytes: copiedBytes, limit: LEGACY_MIGRATION_MAX_BYTES },
      );
    }
    copyStableLegacyFile(sourceFile, destination, relativePath);
    copiedFiles += 1;
  }

  const finalSourceState = inspectSource();
  if (finalSourceState.stateDigest !== expectedStateDigest) {
    throw new GitControllerError(
      "STORY_REPOSITORY_LEGACY_SOURCE_CHANGED",
      "旧工作区在迁移过程中发生变化，已停止升级，请重新检查",
    );
  }
  const sourcePatchDigest = createHash("sha256").update(patch).digest("hex");
  return {
    sourceHeadRevision: sourceState.headRevision,
    sourceBranch: sourceState.branch,
    sourceStateDigest: sourceState.stateDigest,
    copiedFiles,
    copiedBytes,
    patchBytes: patch.length,
    patchDigest: sourcePatchDigest,
    dirtyTrackedCount: sourceState.dirtyTrackedCount,
    untrackedCount: sourceState.untrackedCount,
    changedFiles: sourceState.changedFiles,
  };
}

function retireStateSignature(value) {
  return createHash("sha256").update(JSON.stringify({
    repositoryPath: path.resolve(value.repositoryPath),
    baseRevision: value.baseRevision,
    headRevision: value.headRevision,
    branch: value.branch,
    detached: value.detached,
    entryGeneration: value.entryGeneration,
    aclFingerprint: value.aclFingerprint,
    worktreeContentDigest: value.worktreeContentDigest,
    dirtyFiles: value.dirtyFiles,
    stashOids: value.stashOids,
    unpushedCount: value.unpushedCount,
    localRefs: value.localRefs,
    reflogOids: value.reflogOids,
    unreachableObjects: value.unreachableObjects,
    inspectionErrors: value.inspectionErrors,
  })).digest("hex");
}

function retireContentSignature(value) {
  return createHash("sha256").update(JSON.stringify({
    baseRevision: value.baseRevision,
    headRevision: value.headRevision,
    branch: value.branch,
    detached: value.detached,
    dirtyFiles: [...(value.dirtyFiles || [])].sort(),
    stashOids: [...(value.stashOids || [])].sort(),
    unpushedCount: value.unpushedCount,
    localRefs: [...(value.localRefs || [])].sort(),
    reflogOids: [...(value.reflogOids || [])].sort(),
    unreachableObjects: [...(value.unreachableObjects || [])].sort(),
    worktreeContentDigest: value.worktreeContentDigest,
  })).digest("hex");
}

function storyRegistryEntrySignature(value) {
  const entry = value && typeof value === "object" ? value : {};
  return createHash("sha256").update(JSON.stringify(
    Object.fromEntries(
      Object.keys(entry).sort().map((key) => [key, entry[key]]),
    ),
  )).digest("hex");
}

function provisionRollbackStateSignature(value) {
  return createHash("sha256").update(JSON.stringify({
    repositoryPath: path.resolve(value.repositoryPath),
    baseRevision: value.baseRevision,
    headRevision: value.headRevision,
    branch: value.branch,
    detached: value.detached,
    sourceRef: value.sourceRef,
    mirrorGeneration: value.mirrorGeneration,
    dirtyFiles: [...(value.dirtyFiles || [])].sort(),
    refs: [...(value.refs || [])].sort(),
    stashOids: [...(value.stashOids || [])].sort(),
    reflogOids: [...(value.reflogOids || [])].sort(),
    unreachableObjects: [...(value.unreachableObjects || [])].sort(),
    worktreeContentDigest: value.worktreeContentDigest,
  })).digest("hex");
}

function captureProvisionRollbackState(
  gitBinary,
  disabledHooksPath,
  repositoryPath,
  inspected,
  gitSpawnGuard = null,
) {
  const dirtyFiles = textLines(storyGit(
    gitBinary,
    disabledHooksPath,
    repositoryPath,
    ["status", "--porcelain=v1", "-uall"],
    gitSpawnGuard,
  )).sort();
  const refs = textLines(storyGit(
    gitBinary,
    disabledHooksPath,
    repositoryPath,
    ["for-each-ref", "--format=%(refname)%00%(objectname)", "refs"],
    gitSpawnGuard,
  )).map((line) => {
    const separator = line.indexOf("\0");
    const refName = line.slice(0, separator);
    const objectId = line.slice(separator + 1).trim().toLowerCase();
    if (
      separator <= 0
      || !refName.startsWith("refs/")
      || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(objectId)
    ) {
      throw new GitControllerError(
        "STORY_REPOSITORY_COMPENSATION_STATE_INVALID",
        "Story repository rollback ref state is invalid",
      );
    }
    return `${refName}\0${objectId}`;
  }).sort();
  const stashOids = textLines(storyGit(
    gitBinary,
    disabledHooksPath,
    repositoryPath,
    ["stash", "list", "--format=%H"],
    gitSpawnGuard,
  )).map((value) => value.toLowerCase()).sort();
  const reflogOids = [...new Set(textLines(storyGit(
    gitBinary,
    disabledHooksPath,
    repositoryPath,
    ["reflog", "show", "--all", "--format=%H"],
    gitSpawnGuard,
  )).map((value) => value.toLowerCase()))].sort();
  const unreachableObjects = textLines(storyGit(
    gitBinary,
    disabledHooksPath,
    repositoryPath,
    ["fsck", "--unreachable", "--no-reflogs", "--no-progress"],
    gitSpawnGuard,
  )).filter((line) => (
    /^unreachable (?:blob|commit|tag|tree) [0-9a-f]{40,64}$/.test(line)
  )).sort();
  if (
    refs.length > 512
    || stashOids.length > 512
    || reflogOids.length > 512
    || unreachableObjects.length > 512
  ) {
    throw new GitControllerError(
      "STORY_REPOSITORY_COMPENSATION_STATE_OVERFLOW",
      "Story repository rollback state exceeds the bounded attestation limit",
    );
  }
  for (const objectId of [...stashOids, ...reflogOids]) {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(objectId)) {
      throw new GitControllerError(
        "STORY_REPOSITORY_COMPENSATION_STATE_INVALID",
        "Story repository rollback object state is invalid",
      );
    }
  }
  const state = {
    repositoryPath: path.resolve(repositoryPath),
    baseRevision: inspected.baseRevision,
    headRevision: inspected.headRevision,
    branch: inspected.branch,
    detached: inspected.detached === true,
    sourceRef: inspected.sourceRef,
    mirrorGeneration: Number(inspected.mirrorGeneration),
    dirtyFiles,
    refs,
    stashOids,
    reflogOids,
    unreachableObjects,
    worktreeContentDigest: worktreeContentDigest(repositoryPath),
  };
  return {
    ...state,
    signature: provisionRollbackStateSignature(state),
  };
}

function worktreeContentDigest(repositoryPath) {
  const hash = createHash("sha256");
  const pending = [repositoryPath];
  while (pending.length) {
    const current = pending.pop();
    const relative = path.relative(repositoryPath, current).replace(/\\/g, "/");
    if (relative === ".git" || relative.startsWith(".git/")) continue;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new GitControllerError(
        "STORY_REPOSITORY_CONTENT_LINK",
        "Story worktree content digest rejects symbolic links",
      );
    }
    if (stat.isDirectory()) {
      hash.update(`D\0${relative}\0${stat.mode & 0o777}\0`);
      const children = fs.readdirSync(current)
        .sort((left, right) => right.localeCompare(left));
      for (const name of children) pending.push(path.join(current, name));
      continue;
    }
    if (!stat.isFile()) {
      throw new GitControllerError(
        "STORY_REPOSITORY_CONTENT_TYPE",
        "Story worktree contains an unsupported filesystem object",
      );
    }
    hash.update(`F\0${relative}\0${stat.mode & 0o777}\0${stat.size}\0`);
    const fd = fs.openSync(current, "r");
    try {
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let offset = 0;
      while (offset < stat.size) {
        const read = fs.readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
        if (!read) break;
        hash.update(buffer.subarray(0, read));
        offset += read;
      }
      const after = fs.fstatSync(fd);
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) {
        throw new GitControllerError(
          "STORY_REPOSITORY_CONTENT_RACE",
          "Story worktree changed while computing the retirement digest",
        );
      }
    } finally {
      fs.closeSync(fd);
    }
  }
  return hash.digest("hex");
}

function inspectHiddenGitState(
  gitBinary,
  disabledHooksPath,
  repositoryPath,
  registered,
  inspected,
  gitSpawnGuard = null,
) {
  const refOutput = storyGit(gitBinary, disabledHooksPath, repositoryPath, [
    "for-each-ref",
    "--format=%(refname)%00%(objectname)",
    "refs/heads",
    "refs/tags",
    "refs/notes",
    "refs/replace",
  ], gitSpawnGuard);
  const currentHeadRef = inspected.detached || !inspected.branch
    ? ""
    : `refs/heads/${inspected.branch}`;
  const refs = textLines(refOutput).map((line) => {
    const separator = line.indexOf("\0");
    if (separator <= 0) throw new Error("invalid local ref record");
    const refName = line.slice(0, separator);
    const objectId = line.slice(separator + 1).trim().toLowerCase();
    if (
      !refName.startsWith("refs/")
      || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(objectId)
    ) {
      throw new Error("invalid local ref record");
    }
    return { refName, objectId };
  });
  const localRefs = refs
    .filter(({ refName }) => refName !== currentHeadRef)
    .map(({ refName, objectId }) => `${refName}\0${objectId}`)
    .sort();
  const reflogOids = [...new Set(textLines(storyGit(
    gitBinary,
    disabledHooksPath,
    repositoryPath,
    ["reflog", "show", "--all", "--format=%H"],
    gitSpawnGuard,
  )).map((value) => value.toLowerCase()))].sort();
  if (reflogOids.some((value) => !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value))) {
    throw new Error("invalid reflog object id");
  }
  const riskTips = [...new Set([
    ...refs.map(({ objectId }) => objectId),
    ...reflogOids,
  ])];
  // Keep the command line bounded. Overflow is an inspection failure and
  // therefore blocks both normal and forced retirement.
  if (riskTips.length > 256 || localRefs.length > 256 || reflogOids.length > 256) {
    throw new GitControllerError(
      "STORY_REPOSITORY_HIDDEN_STATE_OVERFLOW",
      "Story repository has too many refs or reflog entries for bounded retirement inspection",
    );
  }
  const count = riskTips.length
    ? storyGit(gitBinary, disabledHooksPath, repositoryPath, [
      "rev-list",
      "--count",
      ...riskTips,
      "--not",
      registered.baseRevision,
    ], gitSpawnGuard)
    : "0";
  if (!/^\d+$/.test(count)) throw new Error("invalid hidden commit count");
  const unreachableObjects = textLines(storyGit(
    gitBinary,
    disabledHooksPath,
    repositoryPath,
    ["fsck", "--unreachable", "--no-reflogs", "--no-progress"],
    gitSpawnGuard,
  )).filter((line) => /^unreachable (?:blob|commit|tag|tree) [0-9a-f]{40,64}$/.test(line))
    .sort();
  if (unreachableObjects.length > 256) {
    throw new GitControllerError(
      "STORY_REPOSITORY_HIDDEN_STATE_OVERFLOW",
      "Story repository has too many unreachable objects for bounded retirement inspection",
    );
  }
  return {
    localRefs,
    reflogOids,
    unreachableObjects,
    unpushedCount: Number(count),
  };
}

function protectControllerQuarantine(quarantineRoot, controllerIdentity, platform = process.platform) {
  fs.mkdirSync(quarantineRoot, { recursive: true, mode: 0o700 });
  revokeStoryRepositoryForQuarantine(quarantineRoot, controllerIdentity, platform);
}

function revokeStoryRepositoryForQuarantine(
  repositoryPath,
  controllerIdentity,
  platform = process.platform,
) {
  if (platform === "win32") {
    const controllerSid = normalizedWorkerIdentity(controllerIdentity, platform).slice(4);
    const encoded = Buffer.from(repositoryPath, "utf8").toString("base64");
    const script = [
      "$ErrorActionPreference='Stop'",
      `$target=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))`,
      `$owner=New-Object Security.Principal.SecurityIdentifier('${controllerSid}')`,
      "$allowed=@($owner,(New-Object Security.Principal.SecurityIdentifier('S-1-5-18')),(New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))",
      "function Set-ProtectedAcl($item){",
      " $acl=if($item.PSIsContainer){New-Object Security.AccessControl.DirectorySecurity}else{New-Object Security.AccessControl.FileSecurity}",
      " $acl.SetAccessRuleProtection($true,$false);$acl.SetOwner($owner)",
      " foreach($sid in $allowed){",
      "  $inherit=if($item.PSIsContainer){'ContainerInherit,ObjectInherit'}else{'None'}",
      "  $rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl',$inherit,'None','Allow')",
      "  $acl.AddAccessRule($rule)",
      " }",
      " Set-Acl -LiteralPath $item.FullName -AclObject $acl",
      "}",
      "$root=Get-Item -LiteralPath $target -Force",
      "if(($root.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'root reparse point'}",
      // Seal the create/rename/delete-child entry point before enumerating.
      // New descendants therefore inherit only the Controller policy.
      "Set-ProtectedAcl $root",
      "$first=@(Get-ChildItem -LiteralPath $target -Force -Recurse -ErrorAction Stop)",
      "if(@($first|Where-Object{($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0}).Count){throw 'reparse point'}",
      "foreach($item in @($first|Sort-Object {$_.FullName.Length} -Descending)){Set-ProtectedAcl $item}",
      "$second=@(Get-ChildItem -LiteralPath $target -Force -Recurse -ErrorAction Stop)",
      "if(@($second|Where-Object{($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0}).Count){throw 'reparse point after seal'}",
      "$firstNames=@($first|ForEach-Object{$_.FullName}|Sort-Object)",
      "$secondNames=@($second|ForEach-Object{$_.FullName}|Sort-Object)",
      "if((Compare-Object $firstNames $secondNames).Count){throw 'repository changed while sealing ACL'}",
      "$attest=@($second)+@(Get-Item -LiteralPath $target -Force)",
      "$bad=@($attest|ForEach-Object{",
      " $acl=Get-Acl -LiteralPath $_.FullName",
      " if(-not $acl.AreAccessRulesProtected){return $_.FullName}",
      " foreach($ace in $acl.Access){",
      "  $sid=try{$ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value}catch{$ace.IdentityReference.Value}",
      `  if(@('${controllerSid}','S-1-5-18','S-1-5-32-544') -notcontains $sid){return $_.FullName}`,
      "  if($ace.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow){return $_.FullName}",
      " }",
      "})",
      "if($bad.Count){throw 'quarantine ACL attestation failed'}",
    ].join(";");
    execFileSync(
      WINDOWS_POWERSHELL,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, timeout: 30_000, stdio: "ignore" },
    );
    return;
  }
  if (platform !== "linux") {
    throw new GitControllerError(
      "STORY_REPOSITORY_QUARANTINE_ACL_UNSUPPORTED",
      "Story quarantine ACL revocation is unsupported on this platform",
    );
  }
  const controllerUid = Number(
    normalizedWorkerIdentity(controllerIdentity, platform).slice(4),
  );
  const rootStat = fs.lstatSync(repositoryPath);
  if (
    !Number.isSafeInteger(controllerUid)
    || rootStat.uid !== controllerUid
    || rootStat.isSymbolicLink()
    || !rootStat.isDirectory()
  ) {
    throw new GitControllerError(
      "STORY_REPOSITORY_QUARANTINE_OWNER",
      "Story repository is not owned by the attested Controller UID",
    );
  }
  // Seal the root first so the Worker cannot add/rename descendants while
  // named/default ACLs are removed from the existing tree.
  execFileSync(UNIX_SETFACL, ["-b", repositoryPath], { timeout: 15_000 });
  execFileSync(UNIX_SETFACL, ["-k", repositoryPath], { timeout: 15_000 });
  fs.chmodSync(repositoryPath, 0o700);
  const enumerate = () => {
    const paths = [];
    const pending = [repositoryPath];
    while (pending.length) {
      const current = pending.pop();
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) {
        throw new GitControllerError(
          "STORY_REPOSITORY_QUARANTINE_LINK",
          "Story repository contains a link during quarantine",
        );
      }
      paths.push(current);
      if (stat.isDirectory()) {
        for (const name of fs.readdirSync(current)) pending.push(path.join(current, name));
      }
    }
    return paths.sort();
  };
  const first = enumerate();
  execFileSync(UNIX_SETFACL, ["-R", "-b", repositoryPath], { timeout: 30_000 });
  execFileSync(UNIX_SETFACL, ["-R", "-k", repositoryPath], { timeout: 30_000 });
  for (const current of first) {
    const stat = fs.lstatSync(current);
    if (stat.uid !== controllerUid) {
      throw new GitControllerError(
        "STORY_REPOSITORY_QUARANTINE_OWNER",
        "Story repository descendant is not owned by the attested Controller UID",
      );
    }
    fs.chmodSync(current, stat.isDirectory() ? 0o700 : 0o600);
  }
  const second = enumerate();
  if (JSON.stringify(first) !== JSON.stringify(second)) {
    throw new GitControllerError(
      "STORY_REPOSITORY_QUARANTINE_RACE",
      "Story repository changed while Worker ACLs were being revoked",
    );
  }
  for (const current of second) {
    const acl = execFileSync(UNIX_GETFACL, ["-cp", current], {
      encoding: "utf8",
      timeout: 15_000,
    });
    if (
      /^default:/m.test(acl)
      || /^(?:user|group):[^:]+:/m.test(acl)
      || fs.lstatSync(current).uid !== controllerUid
    ) {
      throw new GitControllerError(
        "STORY_REPOSITORY_QUARANTINE_ACL_DRIFT",
        "Story repository still contains a named/default ACL after revocation",
      );
    }
  }
}

function assertTargetInsideRoot(root, storyId, repositoryId) {
  const target = independentStoryRepositoryPath(root, storyId, repositoryId);
  if (!pathInside(root, target) || path.dirname(path.dirname(target)) !== path.resolve(root)) {
    throw new GitControllerError(
      "STORY_REPOSITORY_PATH_ESCAPE",
      "Derived story repository path escaped the fixed Controller story root",
    );
  }
  return target;
}

function normalizedWorkerIdentity(value, platform = process.platform) {
  const identity = String(value || "").trim();
  if (platform === "win32") {
    const sid = identity.replace(/^sid:/i, "").toUpperCase();
    return /^S-\d(?:-\d+)+$/.test(sid) ? `sid:${sid}` : "";
  }
  const match = identity.match(/^uid:([0-9]+)$/);
  return match && Number.isSafeInteger(Number(match[1])) ? `uid:${Number(match[1])}` : "";
}

function powershellDirectorySddl(target) {
  const encoded = Buffer.from(target, "utf8").toString("base64");
  const script = [
    "$ErrorActionPreference='Stop'",
    `$target=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))`,
    "$acl=Get-Acl -LiteralPath $target",
    "$owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value",
    "$sddl=$acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]'Owner,Group,Access')",
    "[pscustomobject]@{owner=$owner;sddl=$sddl}|ConvertTo-Json -Compress",
  ].join(";");
  const raw = execFileSync(
    WINDOWS_POWERSHELL,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 64 * 1024,
    },
  ).trim();
  const parsed = JSON.parse(raw);
  return {
    owner: String(parsed.owner || "").toUpperCase(),
    sddl: String(parsed.sddl || ""),
  };
}

function powershellStoryAclTreeEvidence({
  storyDirectory,
  repositoryPath,
  controllerSid,
  workerSid,
  gatewaySids,
  managerSids,
  apply,
}) {
  const policy = Buffer.from(JSON.stringify({
    storyDirectory,
    repositoryPath,
    controllerSid,
    workerSid,
    gatewaySids,
    managerSids,
    apply: apply === true,
  }), "utf8").toString("base64");
  const script = [
    "$ErrorActionPreference='Stop'",
    `$cfg=([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${policy}'))|ConvertFrom-Json)`,
    "$story=[IO.Path]::GetFullPath([string]$cfg.storyDirectory)",
    "$repo=[IO.Path]::GetFullPath([string]$cfg.repositoryPath)",
    "$controller=New-Object Security.Principal.SecurityIdentifier([string]$cfg.controllerSid)",
    "$worker=New-Object Security.Principal.SecurityIdentifier([string]$cfg.workerSid)",
    "$system=New-Object Security.Principal.SecurityIdentifier('S-1-5-18')",
    "$admins=New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')",
    "$gateways=@($cfg.gatewaySids|ForEach-Object{New-Object Security.Principal.SecurityIdentifier([string]$_)})",
    "$managers=@($cfg.managerSids|ForEach-Object{New-Object Security.Principal.SecurityIdentifier([string]$_)})",
    "function Add-Rule($acl,$sid,$rights,$inherit,$type){$rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,$rights,$inherit,'None',$type);[void]$acl.AddAccessRule($rule)}",
    "function New-PolicyAcl([bool]$container,[bool]$writable,[bool]$seal){",
    " $acl=if($container){New-Object Security.AccessControl.DirectorySecurity}else{New-Object Security.AccessControl.FileSecurity}",
    " $acl.SetAccessRuleProtection($true,$false);$acl.SetOwner($controller)",
    " $inherit=if($container){'ContainerInherit,ObjectInherit'}else{'None'}",
    " if(-not $seal){Add-Rule $acl $worker 'ChangePermissions,TakeOwnership' $inherit 'Deny'}",
    " Add-Rule $acl $controller 'FullControl' $inherit 'Allow'",
    " Add-Rule $acl $system 'FullControl' $inherit 'Allow'",
    " Add-Rule $acl $admins 'FullControl' $inherit 'Allow'",
    " if(-not $seal){",
    "  Add-Rule $acl $worker $(if($writable){'Modify'}else{'ReadAndExecute'}) $inherit 'Allow'",
    "  foreach($sid in $gateways){Add-Rule $acl $sid 'ReadAndExecute' $inherit 'Allow'}",
    "  foreach($sid in $managers){Add-Rule $acl $sid $(if($writable){'Modify'}else{'ReadAndExecute'}) $inherit 'Allow'}",
    " }",
    " return $acl",
    "}",
    "function Set-Policy($item,[bool]$writable,[bool]$seal){$acl=New-PolicyAcl $item.PSIsContainer $writable $seal;Set-Acl -LiteralPath $item.FullName -AclObject $acl}",
    "function Get-Sddl($acl){return $acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]'Owner,Access')}",
    "function Assert-Policy($item,[bool]$writable,[string]$relative){",
    " if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw ('reparse point: '+$item.FullName)}",
    " $actual=Get-Acl -LiteralPath $item.FullName",
    " if(-not $actual.AreAccessRulesProtected){throw ('inherited DACL: '+$item.FullName)}",
    " $owner=$actual.GetOwner([Security.Principal.SecurityIdentifier]).Value",
    " if($owner -ne $controller.Value){throw ('owner drift: '+$item.FullName)}",
    " $expected=New-PolicyAcl $item.PSIsContainer $writable $false",
    " $actualSddl=Get-Sddl $actual;$expectedSddl=Get-Sddl $expected",
    " if($actualSddl -ne $expectedSddl){throw ('DACL drift: '+$item.FullName)}",
    " return ($relative+'`t'+$(if($item.PSIsContainer){'directory'}else{'file'})+'`t'+$actualSddl)",
    "}",
    "function Snapshot-Tree(){",
    " $root=Get-Item -LiteralPath $repo -Force",
    " if(($root.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'repository root reparse point'}",
    " $children=@(Get-ChildItem -LiteralPath $repo -Force -Recurse -ErrorAction Stop)",
    " if($children.Count -gt 250000){throw 'repository ACL tree exceeds bound'}",
    " $items=@($children)+@($root)",
    " $records=@()",
    " foreach($item in @($items|Sort-Object FullName)){",
    "  $relative=if($item.FullName -eq $repo){'.'}else{(($item.FullName.Substring($repo.Length) -replace '^[\\\\/]+','') -replace '\\\\','/')}",
    "  $records+=Assert-Policy $item $true $relative",
    " }",
    " return $records",
    "}",
    "$storyItem=Get-Item -LiteralPath $story -Force",
    "$repoItem=Get-Item -LiteralPath $repo -Force",
    "if(-not $storyItem.PSIsContainer -or -not $repoItem.PSIsContainer){throw 'story repository path is not a directory'}",
    "if([bool]$cfg.apply){",
    " Set-Policy $storyItem $false $false",
    " Set-Policy $repoItem $true $true",
    " $first=@(Get-ChildItem -LiteralPath $repo -Force -Recurse -ErrorAction Stop)",
    " if(@($first|Where-Object{($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0}).Count){throw 'repository reparse point'}",
    " if($first.Count -gt 250000){throw 'repository ACL tree exceeds bound'}",
    " foreach($item in @($first|Sort-Object {$_.FullName.Length} -Descending)){Set-Policy $item $true $false}",
    " $second=@(Get-ChildItem -LiteralPath $repo -Force -Recurse -ErrorAction Stop)",
    " if(@($second|Where-Object{($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0}).Count){throw 'repository reparse point after seal'}",
    " $firstNames=@($first|ForEach-Object{$_.FullName}|Sort-Object)",
    " $secondNames=@($second|ForEach-Object{$_.FullName}|Sort-Object)",
    " if((Compare-Object $firstNames $secondNames).Count){throw 'repository changed while sealing ACL'}",
    " Set-Policy $repoItem $true $false",
    "}",
    "$parentOne=Assert-Policy (Get-Item -LiteralPath $story -Force) $false '.'",
    "$snapshotOne=@(Snapshot-Tree)",
    "$parentTwo=Assert-Policy (Get-Item -LiteralPath $story -Force) $false '.'",
    "$snapshotTwo=@(Snapshot-Tree)",
    "if($parentOne -ne $parentTwo -or (Compare-Object $snapshotOne $snapshotTwo).Count){throw 'repository changed while attesting ACL'}",
    "$payload=[Text.Encoding]::UTF8.GetBytes([string]::Join(\"`n\",$snapshotTwo))",
    "$sha=[Security.Cryptography.SHA256]::Create()",
    "try{$treeDigest=([BitConverter]::ToString($sha.ComputeHash($payload))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}",
    "$parentAcl=Get-Acl -LiteralPath $story",
    "$rootAcl=Get-Acl -LiteralPath $repo",
    "[pscustomobject]@{parentOwner=$parentAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value;parentSddl=(Get-Sddl $parentAcl);rootOwner=$rootAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value;rootSddl=(Get-Sddl $rootAcl);treeDigest=$treeDigest;entryCount=$snapshotTwo.Count}|ConvertTo-Json -Compress",
  ].join(";");
  const raw = execFileSync(
    WINDOWS_POWERSHELL,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 45_000,
      maxBuffer: 128 * 1024,
    },
  ).trim();
  const parsed = JSON.parse(raw);
  if (
    !/^[0-9a-f]{64}$/.test(String(parsed.treeDigest || ""))
    || !Number.isSafeInteger(Number(parsed.entryCount))
    || Number(parsed.entryCount) < 1
    || Number(parsed.entryCount) > 250_001
  ) {
    throw new GitControllerError(
      "STORY_REPOSITORY_WORKER_ACL_UNVERIFIED",
      "Story repository recursive ACL evidence is malformed or incomplete",
    );
  }
  return {
    parent: {
      owner: String(parsed.parentOwner || "").toUpperCase(),
      sddl: String(parsed.parentSddl || ""),
    },
    root: {
      owner: String(parsed.rootOwner || "").toUpperCase(),
      sddl: String(parsed.rootSddl || ""),
    },
    treeDigest: String(parsed.treeDigest),
    entryCount: Number(parsed.entryCount),
  };
}

function windowsSddlAces(sddl) {
  return [...String(sddl || "").matchAll(/\(([^()]*)\)/g)].map((match) => {
    const fields = match[1].split(";");
    return {
      type: fields[0] || "",
      flags: fields[1] || "",
      rights: fields[2] || "",
      sid: String(fields[5] || "").toUpperCase(),
    };
  });
}

function rightsAllowWrite(value) {
  const rights = String(value || "").toUpperCase();
  if (/(?:GA|GW|FA|FW|WD|AD|DC|WO|SD)/.test(rights)) return true;
  if (!/^0X[0-9A-F]+$/.test(rights)) return false;
  const bits = Number.parseInt(rights.slice(2), 16);
  const writeMask = 0x2 | 0x4 | 0x10 | 0x40 | 0x100 | 0x10000 | 0x40000 | 0x80000
    | 0x10000000 | 0x40000000;
  return (bits & writeMask) !== 0;
}

function rightsAllowAclMutation(value) {
  const rights = String(value || "").toUpperCase();
  if (!/^0X[0-9A-F]+$/.test(rights)) {
    return /(?:GA|FA|WD|WO)/.test(rights);
  }
  const bits = Number.parseInt(rights.slice(2), 16);
  return (bits & (0x40000 | 0x80000)) !== 0;
}

function rightsAreAclMutationOnly(value) {
  const rights = String(value || "").toUpperCase();
  if (/^0X[0-9A-F]+$/.test(rights)) {
    const bits = Number.parseInt(rights.slice(2), 16);
    const mask = 0x40000 | 0x80000;
    return (bits & mask) === mask && (bits & ~mask) === 0;
  }
  return rights.includes("WD")
    && rights.includes("WO")
    && rights.replace(/WD|WO/g, "") === "";
}

function rightsCapabilities(value) {
  const rights = String(value || "").toUpperCase();
  if (/^0X[0-9A-F]+$/.test(rights)) {
    const bits = Number.parseInt(rights.slice(2), 16);
    return {
      read: (bits & (0x1 | 0x80000000)) !== 0,
      execute: (bits & (0x20 | 0x20000000)) !== 0,
      write: rightsAllowWrite(rights),
    };
  }
  return {
    read: /(?:GA|GR|FA|FR)/.test(rights),
    execute: /(?:GA|GX|FA|FX)/.test(rights),
    write: rightsAllowWrite(rights),
  };
}

function principalHasReadExecuteOnly(aces, sid) {
  const matching = aces.filter((ace) => ace.type === "A" && ace.sid === sid);
  if (!matching.length) return false;
  const effective = matching.reduce((result, ace) => {
    const capabilities = rightsCapabilities(ace.rights);
    return {
      read: result.read || capabilities.read,
      execute: result.execute || capabilities.execute,
      write: result.write || capabilities.write,
    };
  }, { read: false, execute: false, write: false });
  return effective.read && effective.execute && !effective.write;
}

function assertWindowsStoryAcl({
  evidence,
  controllerSid,
  workerSid,
  gatewaySids,
  managerSids,
  workerWritable,
} = {}) {
  const controller = controllerSid.toUpperCase();
  const worker = workerSid.toUpperCase();
  const gateways = gatewaySids.map((sid) => sid.toUpperCase());
  const managers = managerSids.map((sid) => sid.toUpperCase());
  const allowed = new Set([
    controller,
    worker,
    ...gateways,
    ...managers,
    "SY",
    "BA",
    "S-1-5-18",
    "S-1-5-32-544",
  ]);
  if (evidence.owner !== controller) {
    throw new GitControllerError(
      "STORY_REPOSITORY_WORKER_ACL_OWNER",
      "Story repository ACL owner is not the attested Controller identity",
    );
  }
  const aces = windowsSddlAces(evidence.sddl);
  const denyAces = aces.filter((ace) => ace.type === "D");
  const allowAces = aces.filter((ace) => ace.type === "A");
  if (
    !aces.length
    || aces.some((ace) => !["A", "D"].includes(ace.type))
    || aces.some((ace) => !allowed.has(ace.sid))
    || denyAces.length !== 1
    || denyAces[0].sid !== worker
    || !rightsAreAclMutationOnly(denyAces[0].rights)
    || allowAces.some((ace) => (
      ace.sid === worker && rightsAllowAclMutation(ace.rights)
    ))
    || !allowAces.some((ace) => ace.sid === controller && rightsAllowWrite(ace.rights))
    || gateways.some((sid) => !principalHasReadExecuteOnly(aces, sid))
    || managers.some((sid) => (
      workerWritable
        ? !aces.some((ace) => ace.type === "A" && ace.sid === sid && rightsAllowWrite(ace.rights))
        : !principalHasReadExecuteOnly(aces, sid)
    ))
    || (workerWritable && !aces.some((ace) => (
      ace.type === "A" && ace.sid === worker && rightsAllowWrite(ace.rights)
    )))
    || (!workerWritable && !principalHasReadExecuteOnly(aces, worker))
  ) {
    throw new GitControllerError(
      "STORY_REPOSITORY_WORKER_ACL_UNVERIFIED",
      "Story ACL owner or DACL allowlist does not match Controller policy",
    );
  }
}

function protectStoryRepositoryForWorker({
  repositoryPath,
  workerIdentity,
  controllerIdentity,
  gatewayIdentities = [],
  humanManagerIdentities = [],
  allWorkerIdentities = [],
  storyRoot,
  platform = process.platform,
  apply = true,
} = {}) {
  const worker = normalizedWorkerIdentity(workerIdentity, platform);
  const controller = normalizedWorkerIdentity(controllerIdentity, platform);
  if (!worker || !controller || worker === controller) {
    throw new GitControllerError(
      "STORY_REPOSITORY_WORKER_IDENTITY_INVALID",
      "Story repository requires distinct attested Controller and Worker identities",
    );
  }
  let descriptor;
  if (platform === "win32") {
    const workerSid = worker.slice(4);
    const controllerSid = controller.slice(4);
    const gatewaySids = gatewayIdentities.map((identity) => (
      normalizedWorkerIdentity(identity, platform).slice(4)
    ));
    const managerSids = humanManagerIdentities.map((identity) => (
      normalizedWorkerIdentity(identity, platform).slice(4)
    ));
    if ([...gatewaySids, ...managerSids].some((sid) => !sid)) {
      throw new GitControllerError(
        "STORY_REPOSITORY_WORKER_IDENTITY_INVALID",
        "Story repository gateway or manager SID is invalid",
      );
    }
    const storyDirectory = path.dirname(repositoryPath);
    if (apply) execFileSync(
      WINDOWS_ICACLS,
      [
        storyRoot,
        "/grant:r",
        `*${workerSid}:(RX)`,
        ...gatewaySids.map((sid) => `*${sid}:(RX)`),
        ...managerSids.map((sid) => `*${sid}:(RX)`),
      ],
      { windowsHide: true, timeout: 15_000, stdio: "ignore" },
    );
    const recursiveEvidence = powershellStoryAclTreeEvidence({
      storyDirectory,
      repositoryPath,
      controllerSid,
      workerSid,
      gatewaySids,
      managerSids,
      apply,
    });
    const parentEvidence = recursiveEvidence.parent;
    const leafEvidence = recursiveEvidence.root;
    const parentSddl = parentEvidence.sddl;
    const leafSddl = leafEvidence.sddl;
    assertWindowsStoryAcl({
      evidence: parentEvidence,
      controllerSid,
      workerSid,
      gatewaySids,
      managerSids,
      workerWritable: false,
    });
    assertWindowsStoryAcl({
      evidence: leafEvidence,
      controllerSid,
      workerSid,
      gatewaySids,
      managerSids,
      workerWritable: true,
    });
    if (
      !parentSddl.toUpperCase().includes(workerSid.toUpperCase())
      || !leafSddl.toUpperCase().includes(workerSid.toUpperCase())
    ) {
      throw new GitControllerError(
        "STORY_REPOSITORY_WORKER_ACL_UNVERIFIED",
        "Live story ACL does not contain the expected Worker SID",
      );
    }
    for (const other of allWorkerIdentities) {
      const normalized = normalizedWorkerIdentity(other, platform);
      if (normalized && normalized !== worker) {
        const sid = normalized.slice(4).toUpperCase();
        if (parentSddl.toUpperCase().includes(sid) || leafSddl.toUpperCase().includes(sid)) {
          throw new GitControllerError(
            "STORY_REPOSITORY_WORKER_ACL_CROSS_STORY",
            "Story ACL grants access to another registered Worker",
          );
        }
      }
    }
    descriptor = [
      `windows-story-parent:${parentSddl}`,
      `windows-story-tree:${recursiveEvidence.treeDigest}:${recursiveEvidence.entryCount}`,
    ].join("\n");
  } else if (platform === "linux") {
    const workerUid = worker.slice(4);
    const controllerUid = controller.slice(4);
    const gatewayUids = gatewayIdentities.map((identity) => (
      normalizedWorkerIdentity(identity, platform).slice(4)
    ));
    const managerUids = humanManagerIdentities.map((identity) => (
      normalizedWorkerIdentity(identity, platform).slice(4)
    ));
    const storyDirectory = path.dirname(repositoryPath);
    if (apply) execFileSync(UNIX_SETFACL, [
      "-m",
      [
        `u:${workerUid}:--x`,
        ...gatewayUids.map((uid) => `u:${uid}:--x`),
        ...managerUids.map((uid) => `u:${uid}:--x`),
        "m::--x",
      ].join(","),
      storyRoot,
    ], {
      timeout: 15_000,
    });
    if (apply) execFileSync(UNIX_SETFACL, ["-b", storyDirectory], { timeout: 15_000 });
    if (apply) fs.chmodSync(storyDirectory, 0o700);
    if (apply) execFileSync(UNIX_SETFACL, [
      "-m",
      [
        `u:${workerUid}:--x`,
        ...gatewayUids.map((uid) => `u:${uid}:--x`),
        ...managerUids.map((uid) => `u:${uid}:--x`),
        "m::--x",
      ].join(","),
      storyDirectory,
    ], {
      timeout: 15_000,
    });
    if (apply) execFileSync(UNIX_SETFACL, [
      "-R", "-m",
      [
        `u:${controllerUid}:rwX`,
        `u:${workerUid}:rwX`,
        ...gatewayUids.map((uid) => `u:${uid}:r-X`),
        ...managerUids.map((uid) => `u:${uid}:rwX`),
        "m::rwX",
        "o::---",
      ].join(","),
      repositoryPath,
    ], { timeout: 30_000, windowsHide: true });
    const pending = [repositoryPath];
    while (pending.length) {
      const directory = pending.pop();
      if (apply) execFileSync(UNIX_SETFACL, [
        "-d", "-m",
        [
          `u:${controllerUid}:rwx`,
          `u:${workerUid}:rwx`,
          ...gatewayUids.map((uid) => `u:${uid}:r-x`),
          ...managerUids.map((uid) => `u:${uid}:rwx`),
          "m::rwx",
          "o::---",
        ].join(","),
        directory,
      ], { timeout: 15_000 });
      for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
        if (item.isSymbolicLink()) {
          throw new GitControllerError(
            "STORY_REPOSITORY_WORKER_ACL_LINK",
            "Story repository contains a symlink while applying Worker ACL",
          );
        }
        if (item.isDirectory()) pending.push(path.join(directory, item.name));
      }
    }
    const parentAcl = execFileSync(
      UNIX_GETFACL,
      ["-cp", storyDirectory],
      { encoding: "utf8", timeout: 15_000 },
    ).trim();
    const leafAcl = execFileSync(
      UNIX_GETFACL,
      ["-cp", repositoryPath],
      { encoding: "utf8", timeout: 15_000 },
    ).trim();
    const parentOwner = fs.statSync(storyDirectory).uid;
    const leafOwner = fs.statSync(repositoryPath).uid;
    const allowedUids = new Set([
      controllerUid,
      workerUid,
      ...gatewayUids,
      ...managerUids,
    ]);
    const namedUids = [...`${parentAcl}\n${leafAcl}`.matchAll(
      /^(?:default:)?user:([0-9]+):/gm,
    )].map((match) => match[1]);
    if (
      String(parentOwner) !== controllerUid
      || String(leafOwner) !== controllerUid
      || !new RegExp(`^user:${workerUid}:--x$`, "m").test(parentAcl)
      || !new RegExp(`^user:${workerUid}:rw[x-]$`, "m").test(leafAcl)
      || gatewayUids.some((uid) => (
        !new RegExp(`^user:${uid}:--x$`, "m").test(parentAcl)
        || !new RegExp(`^user:${uid}:r-x$`, "m").test(leafAcl)
      ))
      || managerUids.some((uid) => (
        !new RegExp(`^user:${uid}:--x$`, "m").test(parentAcl)
        || !new RegExp(`^user:${uid}:rwx$`, "m").test(leafAcl)
      ))
      || namedUids.some((uid) => !allowedUids.has(uid))
    ) {
      throw new GitControllerError(
        "STORY_REPOSITORY_WORKER_ACL_UNVERIFIED",
        "Live story ACL does not contain the expected Worker UID",
      );
    }
    for (const other of allWorkerIdentities) {
      const normalized = normalizedWorkerIdentity(other, platform);
      if (
        normalized
        && normalized !== worker
        && new RegExp(`^user:${normalized.slice(4)}:`, "m").test(`${parentAcl}\n${leafAcl}`)
      ) {
        throw new GitControllerError(
          "STORY_REPOSITORY_WORKER_ACL_CROSS_STORY",
          "Story ACL grants access to another registered Worker",
        );
      }
    }
    descriptor = `linux-story-parent:${parentAcl}\nlinux-story-leaf:${leafAcl}`;
  } else {
    throw new GitControllerError(
      "STORY_REPOSITORY_WORKER_ACL_UNSUPPORTED",
      "This platform cannot attest per-story Worker filesystem ACLs",
    );
  }
  return {
    workerIdentity: worker,
    aclFingerprint: createHash("sha256").update(descriptor).digest("hex"),
    aclDescriptor: descriptor,
  };
}

function revokeStoryRootWorkerTraversal(storyRoot, workerIdentity, platform = process.platform) {
  const worker = normalizedWorkerIdentity(workerIdentity, platform);
  if (!worker) return;
  if (platform === "win32") {
    execFileSync(
      WINDOWS_ICACLS,
      [storyRoot, "/remove:g", `*${worker.slice(4)}`],
      { windowsHide: true, timeout: 15_000, stdio: "ignore" },
    );
  } else if (platform === "linux") {
    execFileSync(UNIX_SETFACL, ["-x", `u:${worker.slice(4)}`, storyRoot], {
      timeout: 15_000,
    });
  }
}

export class StoryRepositoryController {
  constructor({
    controller,
    storyRoot,
    dataRoot,
    workerIdentities = {},
    gatewayIdentities = [],
    humanManagerIdentities = [],
    controllerIdentity = process.platform === "win32"
      ? ""
      : `uid:${typeof process.getuid === "function" ? process.getuid() : ""}`,
    aclProtector = protectStoryRepositoryForWorker,
    aclAttestor = null,
    aclRevoker = revokeStoryRootWorkerTraversal,
    quarantineProtector = protectControllerQuarantine,
    repositoryQuarantineRevoker = revokeStoryRepositoryForQuarantine,
    faultInjector = null,
    workerSecretRoots = [],
    workerProbeConfigPath = WORKER_DEPLOYMENT_PROBE_CONFIG_PATH,
    workerProbeReconciler = reconcileManagedWorkerDeploymentProbeConfig,
    workerProbeProtection = null,
    gitSpawnGuard = null,
    requiredCheckVerifier = null,
    flavorPolicyResolver = null,
  } = {}) {
    if (
      !controller?.registry
      || !controller?.mirror
      || !controller?.leaseManager
      || !controller?.journal
      || !controller?.audit
    ) {
      throw new GitControllerError(
        "GIT_CONTROLLER_DEPENDENCY_MISSING",
        "Story repository Controller requires a complete Git Controller",
      );
    }
    this.controller = controller;
    this.storyRoot = path.resolve(String(storyRoot || ""));
    this.dataRoot = path.resolve(String(dataRoot || ""));
    if (!path.isAbsolute(String(storyRoot || ""))) {
      throw new GitControllerError(
        "STORY_REPOSITORY_ROOT_REQUIRED",
        "Controller story root must be absolute",
      );
    }
    if (!path.isAbsolute(String(dataRoot || ""))) {
      throw new GitControllerError(
        "GIT_CONTROLLER_DATA_ROOT_INVALID",
        "Story repository registry requires Controller data root",
      );
    }
    this.registryDirectory = path.join(this.dataRoot, "story-repositories");
    this.registryPath = path.join(this.registryDirectory, "registry.json");
    this.workflowEvidenceRoot = path.join(
      path.dirname(path.dirname(this.dataRoot)),
      "AllDocs",
      "StoryDev",
    );
    fs.mkdirSync(this.registryDirectory, { recursive: true });
    this.registryMutation = Promise.resolve();
    this.workerIdentities = Object.freeze({ ...workerIdentities });
    this.gatewayIdentities = Object.freeze([...gatewayIdentities]);
    this.humanManagerIdentities = Object.freeze([...humanManagerIdentities]);
    this.controllerIdentity = controllerIdentity;
    if (gitSpawnGuard != null && typeof gitSpawnGuard !== "function") {
      throw new GitControllerError(
        "GIT_CONTROLLER_GIT_SPAWN_GUARD_INVALID",
        "Story repository Git spawn guard must be a synchronous Controller-owned function",
      );
    }
    this.gitSpawnGuard = gitSpawnGuard;
    if (requiredCheckVerifier != null && typeof requiredCheckVerifier !== "function") {
      throw new GitControllerError(
        "STORY_REPOSITORY_CHECK_VERIFIER_INVALID",
        "Story commit required-check verifier must be a Controller-owned function",
      );
    }
    if (requiredCheckVerifier != null && process.env.NODE_ENV !== "test") {
      throw new GitControllerError(
        "STORY_REPOSITORY_CHECK_VERIFIER_OVERRIDE_FORBIDDEN",
        "Production Story Controller must verify required checks from its own receipt stream",
      );
    }
    if (flavorPolicyResolver != null && typeof flavorPolicyResolver !== "function") {
      throw new GitControllerError(
        "STORY_REPOSITORY_FLAVOR_POLICY_INVALID",
        "Story commit Flavor policy resolver must be a Controller-owned function",
      );
    }
    this.requiredCheckVerifier = requiredCheckVerifier;
    this.flavorPolicyResolver = flavorPolicyResolver;
    this.gitBinary = controller.registry.gitBinary;
    if (!path.isAbsolute(this.gitBinary) || !fs.statSync(this.gitBinary).isFile()) {
      throw new GitControllerError(
        "STORY_REPOSITORY_GIT_BINARY_INVALID",
        "Story repository Controller requires the registry verified absolute Git binary",
      );
    }
    this.disabledHooksPath = path.join(this.dataRoot, "story-hooks-disabled");
    fs.mkdirSync(this.disabledHooksPath, { recursive: true, mode: 0o700 });
    this.aclProtector = aclProtector;
    this.aclAttestor = aclAttestor || ((options) => protectStoryRepositoryForWorker({
      ...options,
      apply: false,
    }));
    this.aclRevoker = aclRevoker;
    this.quarantineRoot = path.join(this.storyRoot, ".controller-quarantine");
    this.quarantineProtector = quarantineProtector;
    this.repositoryQuarantineRevoker = repositoryQuarantineRevoker;
    this.faultInjector = faultInjector;
    this.quarantineProtector(this.quarantineRoot, this.controllerIdentity);
    const testMode = process.env.NODE_ENV === "test";
    this.workerProbeEnabled = !testMode
      || workerSecretRoots.length > 0
      || workerProbeProtection !== null
      || workerProbeReconciler !== reconcileManagedWorkerDeploymentProbeConfig;
    if (
      !testMode
      && (
        workerProbeReconciler !== reconcileManagedWorkerDeploymentProbeConfig
        || workerProbeProtection !== null
        || path.resolve(workerProbeConfigPath) !== WORKER_DEPLOYMENT_PROBE_CONFIG_PATH
      )
    ) {
      throw new GitControllerError(
        "WORKER_DEPLOYMENT_PROBE_OVERRIDE_FORBIDDEN",
        "Production Controller cannot override the fixed probe writer, protection, or path",
      );
    }
    this.workerSecretRoots = Object.freeze(uniqueControllerPaths([
      ...workerSecretRoots,
      ...(!testMode ? [
        this.dataRoot,
        path.dirname(WORKER_DEPLOYMENT_PROBE_CONFIG_PATH),
      ] : []),
    ]));
    if (this.workerProbeEnabled && this.workerSecretRoots.length === 0) {
      throw new GitControllerError(
        "WORKER_DEPLOYMENT_SECRET_ROOTS_REQUIRED",
        "Controller worker topology requires protected secret roots",
      );
    }
    this.workerProbeConfigPath = path.resolve(workerProbeConfigPath);
    this.workerProbeReconciler = workerProbeReconciler;
    this.workerProbeProtection = this.workerProbeEnabled
      ? (
          workerProbeProtection
          || createManagedWorkerProbeProtectionCallbacks({
            controllerIdentity: this.controllerIdentity,
            gatewayIdentities: this.gatewayIdentities,
            humanManagerIdentities: this.humanManagerIdentities,
            workerIdentities: this.workerIdentities,
          })
        )
      : null;
    this.workerProbePendingPath = path.join(
      this.registryDirectory,
      "worker-probe-reconcile.pending.json",
    );
    this.workerProbeReconcileBlocked = null;
    this.storyRetentionProvider = () => this.readRegistry().entries.map((row) => ({
      storyId: row.storyId,
      repositoryId: row.repositoryId,
      baseRevision: row.baseRevision,
      sourceRef: row.sourceRef,
    }));
    if (typeof this.controller.mirror.setStoryBaseRetentionProvider === "function") {
      this.controller.mirror.setStoryBaseRetentionProvider(this.storyRetentionProvider);
    } else if (!testMode) {
      throw new GitControllerError(
        "GIT_CONTROLLER_STORY_RETENTION_UNAVAILABLE",
        "Production Story Controller requires managed mirror story-base retention",
      );
    }
  }

  readRegistry() {
    if (!fs.existsSync(this.registryPath)) return { version: 1, generation: 0, entries: [] };
    const stat = fs.lstatSync(this.registryPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new GitControllerError(
        "STORY_REPOSITORY_REGISTRY_DRIFT",
        "Controller story registry is not a regular file",
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.registryPath, "utf8"));
    } catch {
      throw new GitControllerError(
        "STORY_REPOSITORY_REGISTRY_DRIFT",
        "Controller story registry is invalid",
      );
    }
    if (
      parsed?.version !== 1
      || !Number.isSafeInteger(parsed.generation)
      || parsed.generation < 0
      || !Array.isArray(parsed.entries)
    ) {
      throw new GitControllerError(
        "STORY_REPOSITORY_REGISTRY_DRIFT",
        "Controller story registry schema is invalid",
      );
    }
    const keys = new Set();
    const primaryStories = new Set();
    for (const row of parsed.entries) {
      const key = `${row.storyId}\0${row.repositoryId}`;
      if (
        keys.has(key)
        || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(String(row.baseRevision || ""))
        || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(String(row.headRevision || ""))
        || !Number.isSafeInteger(row.entryGeneration)
        || row.entryGeneration < 1
        || !/^[0-9a-f]{64}$/.test(String(row.aclFingerprint || ""))
        || !normalizedWorkerIdentity(row.workerIdentity)
        || (
          row.isPrimary !== undefined
          && typeof row.isPrimary !== "boolean"
        )
        || (
          row.lastAppliedBaselineOperationId != null
          && !String(row.lastAppliedBaselineOperationId).trim()
        )
      ) {
        throw new GitControllerError(
          "STORY_REPOSITORY_REGISTRY_DRIFT",
          "Controller story registry entry is invalid or duplicated",
        );
      }
      if (row.isPrimary === true) {
        if (primaryStories.has(row.storyId)) {
          throw new GitControllerError(
            "STORY_REPOSITORY_REGISTRY_DRIFT",
            "Controller story registry contains multiple primary repositories",
          );
        }
        primaryStories.add(row.storyId);
      }
      keys.add(key);
      const expected = assertTargetInsideRoot(
        this.storyRoot,
        row.storyId,
        row.repositoryId,
      );
      if (path.resolve(String(row.repositoryPath || "")) !== expected) {
        throw new GitControllerError(
          "STORY_REPOSITORY_REGISTRY_PATH_DRIFT",
          "Controller story registry contains a non-canonical path",
        );
      }
    }
    return parsed;
  }

  async reconcileMirrorRetentions({
    kind = "story-retention-reconcile",
  } = {}) {
    if (
      typeof this.controller.mirror.reconcileStoryBaseRetentions !== "function"
    ) {
      if (process.env.NODE_ENV === "test") {
        return { reconciled: 0, skippedForTest: true, repositories: [] };
      }
      throw new GitControllerError(
        "GIT_CONTROLLER_STORY_RETENTION_UNAVAILABLE",
        "Production Story Controller cannot reconcile managed mirror retention refs",
      );
    }
    const registry = this.readRegistry();
    const repositories = [];
    for (const entry of this.controller.registry.list()) {
      await this.controller.registry.verify(entry.repositoryId);
      const rows = registry.entries.filter(
        (row) => row.repositoryId === entry.repositoryId,
      );
      if (!fs.existsSync(entry.mirrorPath)) {
        if (rows.length) {
          throw new GitControllerError(
            "GIT_CONTROLLER_STORY_RETENTION_MIRROR_MISSING",
            "An active story repository has no managed mirror for exact-SHA retention",
            {
              repositoryId: entry.repositoryId,
              activeStories: rows.map((row) => row.storyId),
            },
          );
        }
        repositories.push({
          repositoryId: entry.repositoryId,
          skipped: true,
          reason: "mirror_not_initialized",
        });
        continue;
      }
      const lease = this.controller.leaseManager.acquire(entry, {
        operationId: `${kind}:${randomUUID()}`,
        kind,
      });
      try {
        lease.assertCurrent();
        repositories.push(
          await this.controller.mirror.reconcileStoryBaseRetentions(
            entry,
            lease,
            registry.entries,
          ),
        );
      } finally {
        lease.release();
      }
    }
    return Object.freeze({
      reconciled: repositories.filter((item) => !item.skipped).length,
      registryGeneration: registry.generation,
      repositories,
    });
  }

  async withRegistryMutation(callback) {
    const previous = this.registryMutation;
    let release;
    this.registryMutation = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      return await callback();
    } finally {
      release();
    }
  }

  writeRegistryDocument(document) {
    for (const name of fs.readdirSync(this.registryDirectory)) {
      if (!/^\.registry-[0-9a-f-]+\.tmp$/i.test(name)) continue;
      const residue = path.join(this.registryDirectory, name);
      const stat = fs.lstatSync(residue);
      if (stat.isFile() && !stat.isSymbolicLink()) fs.rmSync(residue, { force: true });
    }
    const temporary = path.join(
      this.registryDirectory,
      `.registry-${randomUUID()}.tmp`,
    );
    const descriptor = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(descriptor, `${JSON.stringify(document, null, 2)}\n`, "utf8");
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, this.registryPath);
    if (process.platform !== "win32") {
      const directory = fs.openSync(this.registryDirectory, "r");
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    }
    return document;
  }

  async mutateRegistry(mutator) {
    return this.withRegistryMutation(() => {
      if (this.workerProbeReconcileBlocked) throw this.workerProbeReconcileBlocked;
      const registry = this.readRegistry();
      const next = mutator(structuredClone(registry)) || registry;
      next.generation = registry.generation + 1;
      return this.writeRegistryDocument(next);
    });
  }

  buildWorkerProbeTopology(registry = this.readRegistry()) {
    const catalog = [...this.controller.registry.entries.values()];
    const baseRoots = uniqueControllerPaths(catalog.map((entry) => entry.basePath));
    const baseGitCommonRoots = uniqueControllerPaths(
      catalog.map((entry) => entry.baseGitCommonPath),
    );
    const mirrorRoots = uniqueControllerPaths(catalog.map((entry) => entry.mirrorPath));
    if (
      this.workerProbeEnabled
      && (
        !baseRoots.length
        || !mirrorRoots.length
        || catalog.some((entry) => !String(entry.baseGitCommonPath || "").trim())
      )
    ) {
      throw new GitControllerError(
        "WORKER_DEPLOYMENT_CONTROLLER_TOPOLOGY_INCOMPLETE",
        "Controller registry must provide every protected base, canonical Git common-dir, and managed mirror root",
      );
    }
    const rowsByStory = new Map();
    for (const row of registry.entries) {
      const rows = rowsByStory.get(row.storyId) || [];
      rows.push(row);
      rowsByStory.set(row.storyId, rows);
    }
    const stories = [];
    const everyStoryPath = registry.entries.map((row) => row.repositoryPath);
    for (const [storyId, rawRows] of [...rowsByStory].sort(
      ([left], [right]) => left.localeCompare(right),
    )) {
      const rows = [...rawRows].sort((left, right) => (
        Number(right.isPrimary === true) - Number(left.isPrimary === true)
        || left.repositoryId.localeCompare(right.repositoryId)
      ));
      const primaryCount = rows.filter((row) => row.isPrimary === true).length;
      if (primaryCount > 1) {
        throw new GitControllerError(
          "WORKER_DEPLOYMENT_CONTROLLER_TOPOLOGY_INVALID",
          "Controller story registry contains multiple primary repositories",
          { storyId },
        );
      }
      const workerIdentity = normalizedWorkerIdentity(this.workerIdentities[storyId]);
      if (
        !workerIdentity
        || rows.some((row) => row.workerIdentity !== workerIdentity)
      ) {
        throw new GitControllerError(
          "WORKER_DEPLOYMENT_CONTROLLER_IDENTITY_DRIFT",
          "Active story repositories must match the protected Controller Worker policy",
          { storyId },
        );
      }
      const allowedRoots = uniqueControllerPaths(rows.map((row) => row.repositoryPath));
      const own = new Set(
        allowedRoots.map((value) => normalizedControllerPath(value)),
      );
      const writeDeniedRoots = [...baseRoots];
      const inaccessibleRoots = uniqueControllerPaths([
        ...baseGitCommonRoots,
        ...mirrorRoots,
        ...everyStoryPath.filter((candidate) => !own.has(normalizedControllerPath(candidate))),
        ...this.workerSecretRoots,
      ]);
      stories.push({
        storyId,
        cwd: rows[0].repositoryPath,
        allowedRoots,
        writeDeniedRoots,
        inaccessibleRoots,
        workerIdentity,
        aclFingerprints: [...new Set(rows.map((row) => row.aclFingerprint))].sort(),
      });
    }
    return Object.freeze({
      generation: registry.generation,
      stories: Object.freeze(stories.map((story) => Object.freeze(story))),
    });
  }

  readWorkerProbeConfig({ allowMissing = false } = {}) {
    if (!this.workerProbeEnabled) return null;
    try {
      return loadManagedWorkerDeploymentProbeConfig(this.workerProbeConfigPath, {
        gatewayIdentity: this.gatewayIdentities[0],
        aclVerifier: this.workerProbeProtection.configAclVerifier,
        allowMissingStoryRoots: true,
      });
    } catch (error) {
      if (allowMissing && error?.code === "WORKER_DEPLOYMENT_CONFIG_MISSING") return null;
      throw error;
    }
  }

  workerProbeTopologyMatches(topology, config) {
    if (!config || config.generation !== topology.generation) return false;
    const actualIds = Object.keys(config.stories).sort();
    const expectedIds = topology.stories.map((story) => story.storyId).sort();
    if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) return false;
    const samePaths = (left, right) => JSON.stringify(
      uniqueControllerPaths(left).map((value) => normalizedControllerPath(value)),
    ) === JSON.stringify(
      uniqueControllerPaths(right).map((value) => normalizedControllerPath(value)),
    );
    const inaccessibleManifests = new Map();
    return topology.stories.every((story) => {
      const actual = config.stories[story.storyId];
      const manifestKey = JSON.stringify(
        uniqueControllerPaths(story.inaccessibleRoots)
          .map((value) => normalizedControllerPath(value)),
      );
      if (!inaccessibleManifests.has(manifestKey)) {
        inaccessibleManifests.set(
          manifestKey,
          enumerateControllerInaccessibleEntries(story.inaccessibleRoots),
        );
      }
      return actual
        && normalizedControllerPath(actual.cwd) === normalizedControllerPath(story.cwd)
        && samePaths(actual.allowedRoots, story.allowedRoots)
        && samePaths(actual.writeDeniedRoots, story.writeDeniedRoots)
        && samePaths(actual.inaccessibleRoots, story.inaccessibleRoots)
        && JSON.stringify(actual.inaccessibleEntries || [])
          === JSON.stringify(inaccessibleManifests.get(manifestKey))
        && String(actual.workerIdentity || "").toLowerCase()
          === String(story.workerIdentity || "").toLowerCase()
        && JSON.stringify([...actual.aclFingerprints].sort())
          === JSON.stringify([...story.aclFingerprints].sort());
    });
  }

  writeWorkerProbePending(topology, {
    operationId = "",
    reason = "",
  } = {}) {
    if (!this.workerProbeEnabled) return null;
    const document = {
      schema: WORKER_PROBE_PENDING_SCHEMA,
      version: 1,
      registryGeneration: topology.generation,
      topologyDigest: workerProbeTopologyDigest(topology),
      operationId: String(operationId || ""),
      reason: String(reason || "").slice(0, 160),
      createdAt: Date.now(),
    };
    const temporary = path.join(
      this.registryDirectory,
      `.worker-probe-pending-${randomUUID()}.tmp`,
    );
    const descriptor = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(descriptor, `${JSON.stringify(document)}\n`, "utf8");
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, this.workerProbePendingPath);
    if (process.platform !== "win32") {
      const directory = fs.openSync(this.registryDirectory, "r");
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    }
    return document;
  }

  clearWorkerProbePending() {
    if (!fs.existsSync(this.workerProbePendingPath)) return;
    const stat = fs.lstatSync(this.workerProbePendingPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new GitControllerError(
        "WORKER_DEPLOYMENT_RECONCILE_PENDING_DRIFT",
        "Worker probe recovery marker is not a regular Controller-owned file",
      );
    }
    fs.rmSync(this.workerProbePendingPath, { force: true });
    if (process.platform !== "win32") {
      const directory = fs.openSync(this.registryDirectory, "r");
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    }
  }

  appendProbePhase(operation, phase, data, fencingToken) {
    if (!operation) return;
    this.controller.journal.append(operation, phase, data, fencingToken);
  }

  reconcileWorkerProbeTopology(topology, {
    operation = null,
    fencingToken = null,
    reason = "",
  } = {}) {
    if (!this.workerProbeEnabled) {
      return {
        generation: topology.generation,
        storiesRequiringProbe: [],
        removedStoryIds: [],
        staleSentinelsRemoved: 0,
        disabledForTest: true,
      };
    }
    const previous = this.readWorkerProbeConfig({ allowMissing: true });
    if (this.workerProbeTopologyMatches(topology, previous)) {
      return {
        generation: topology.generation,
        storiesRequiringProbe: [],
        removedStoryIds: [],
        staleSentinelsRemoved: 0,
        alreadyCurrent: true,
      };
    }
    if (previous && topology.generation <= previous.generation) {
      throw new GitControllerError(
        "WORKER_DEPLOYMENT_RECONCILE_GENERATION_DIVERGED",
        "Controller registry generation cannot safely advance the probe topology",
        {
          registryGeneration: topology.generation,
          probeGeneration: previous.generation,
        },
      );
    }
    this.appendProbePhase(operation, "WORKER_PROBE_RECONCILING", {
      registryGeneration: topology.generation,
      previousProbeGeneration: previous?.generation || 0,
      topologyDigest: workerProbeTopologyDigest(topology),
      reason,
    }, fencingToken);
    const result = this.workerProbeReconciler(topology, {
      configPath: this.workerProbeConfigPath,
      expectedPreviousGeneration: previous?.generation || 0,
      controllerIdentity: this.controllerIdentity,
      gatewayIdentities: this.gatewayIdentities,
      ...this.workerProbeProtection,
    });
    this.appendProbePhase(operation, "WORKER_PROBE_RECONCILED", {
      generation: result.generation,
      storiesRequiringProbe: result.storiesRequiringProbe,
      removedStoryIds: result.removedStoryIds,
    }, fencingToken);
    return result;
  }

  probeReconcileError(error, registryGeneration, {
    compensated = false,
    compensationError = null,
  } = {}) {
    return new GitControllerError(
      "WORKER_DEPLOYMENT_TOPOLOGY_RECONCILE_FAILED",
      compensated
        ? "Worker probe topology publication failed; Controller restored the prior registry topology"
        : "Worker probe topology publication failed; Controller recovery is required",
      {
        registryGeneration,
        causeCode: String(error?.code || "WORKER_PROBE_RECONCILE_FAILED"),
        causeMessage: String(error?.message || "Worker probe reconcile failed").slice(0, 300),
        compensated,
        recoveryRequired: !compensated,
        compensationCode: compensationError
          ? String(compensationError?.code || "WORKER_PROBE_COMPENSATION_FAILED")
          : null,
      },
      { cause: error },
    );
  }

  async mutateRegistryTopology(mutator, {
    operation = null,
    fencingToken = null,
    reason = "",
    compensateOnFailure = false,
  } = {}) {
    return this.withRegistryMutation(async () => {
      if (this.workerProbeReconcileBlocked) throw this.workerProbeReconcileBlocked;
      const previous = this.readRegistry();
      const mutation = mutator(structuredClone(previous));
      if (mutation?.[REGISTRY_TOPOLOGY_NOOP] === true) {
        return {
          registry: previous,
          probe: null,
          noop: true,
          result: mutation.result,
        };
      }
      const next = mutation || structuredClone(previous);
      next.generation = previous.generation + 1;
      if (!this.workerProbeEnabled) {
        this.writeRegistryDocument(next);
        return {
          registry: next,
          probe: {
            generation: next.generation,
            storiesRequiringProbe: [],
            removedStoryIds: [],
            staleSentinelsRemoved: 0,
            disabledForTest: true,
          },
        };
      }
      if (typeof this.controller.registry.verifyWorkerProtectionBindings === "function") {
        await this.controller.registry.verifyWorkerProtectionBindings();
      }
      const topology = this.buildWorkerProbeTopology(next);
      this.writeWorkerProbePending(topology, {
        operationId: operation?.operationId,
        reason,
      });
      this.writeRegistryDocument(next);
      this.appendProbePhase(operation, "WORKER_PROBE_REGISTRY_COMMITTED", {
        registryGeneration: next.generation,
        topologyDigest: workerProbeTopologyDigest(topology),
      }, fencingToken);
      try {
        const probe = this.reconcileWorkerProbeTopology(topology, {
          operation,
          fencingToken,
          reason,
        });
        this.clearWorkerProbePending();
        this.workerProbeReconcileBlocked = null;
        return { registry: next, probe };
      } catch (error) {
        if (compensateOnFailure) {
          const rollback = structuredClone(previous);
          rollback.generation = next.generation + 1;
          const rollbackTopology = this.buildWorkerProbeTopology(rollback);
          try {
            this.writeWorkerProbePending(rollbackTopology, {
              operationId: operation?.operationId,
              reason: `${reason}:compensation`,
            });
            this.writeRegistryDocument(rollback);
            const compensation = this.reconcileWorkerProbeTopology(rollbackTopology, {
              operation,
              fencingToken,
              reason: `${reason}:compensation`,
            });
            this.clearWorkerProbePending();
            this.workerProbeReconcileBlocked = null;
            throw this.probeReconcileError(error, next.generation, {
              compensated: true,
              compensationError: null,
            });
          } catch (compensationError) {
            if (
              compensationError?.code === "WORKER_DEPLOYMENT_TOPOLOGY_RECONCILE_FAILED"
              && compensationError?.details?.compensated === true
            ) {
              throw compensationError;
            }
            const blocked = this.probeReconcileError(error, next.generation, {
              compensated: false,
              compensationError,
            });
            this.workerProbeReconcileBlocked = blocked;
            throw blocked;
          }
        }
        const blocked = this.probeReconcileError(error, next.generation);
        this.workerProbeReconcileBlocked = blocked;
        throw blocked;
      }
    });
  }

  async recoverWorkerProbeTopology() {
    if (!this.workerProbeEnabled) {
      return { recovered: false, disabledForTest: true, storiesRequiringProbe: [] };
    }
    return this.withRegistryMutation(async () => {
      this.workerProbeReconcileBlocked = null;
      let registry = this.readRegistry();
      let current = this.readWorkerProbeConfig({ allowMissing: true });
      if (typeof this.controller.registry.verifyWorkerProtectionBindings === "function") {
        await this.controller.registry.verifyWorkerProtectionBindings();
      }
      let topology = this.buildWorkerProbeTopology(registry);
      if (this.workerProbeTopologyMatches(topology, current)) {
        this.clearWorkerProbePending();
        return {
          recovered: false,
          generation: topology.generation,
          storiesRequiringProbe: [],
        };
      }
      if (
        registry.generation === 0
        || (current && registry.generation <= current.generation)
      ) {
        registry = structuredClone(registry);
        registry.generation = Math.max(
          registry.generation,
          Number(current?.generation || 0),
        ) + 1;
        topology = this.buildWorkerProbeTopology(registry);
        this.writeWorkerProbePending(topology, { reason: "restart-recovery-cas" });
        this.writeRegistryDocument(registry);
      } else {
        this.writeWorkerProbePending(topology, { reason: "restart-recovery" });
      }
      const result = this.reconcileWorkerProbeTopology(topology, {
        reason: "restart-recovery",
      });
      this.clearWorkerProbePending();
      this.workerProbeReconcileBlocked = null;
      current = this.readWorkerProbeConfig();
      if (!this.workerProbeTopologyMatches(topology, current)) {
        throw new GitControllerError(
          "WORKER_DEPLOYMENT_RECONCILE_RECOVERY_UNVERIFIED",
          "Recovered Worker probe topology does not match the Controller registry",
        );
      }
      return {
        recovered: true,
        generation: result.generation,
        storiesRequiringProbe: result.storiesRequiringProbe,
      };
    });
  }

  registryEntry(tabId, repositoryId) {
    return this.readRegistry().entries.find((row) => (
      row.storyId === String(tabId)
      && row.repositoryId === String(repositoryId)
    )) || null;
  }

  async recordRepository(repository, provisionOperation, acl, {
    primary = false,
    fencingToken = null,
  } = {}) {
    const row = {
      storyId: repository.storyId,
      repositoryId: repository.repositoryId,
      repositoryPath: path.resolve(repository.repositoryPath),
      baseRevision: repository.baseRevision,
      acceptedTipRevision: repository.acceptedTipRevision,
      sourceRef: repository.sourceRef,
      remoteId: repository.remoteId,
      mirrorGeneration: repository.mirrorGeneration,
      headRevision: repository.headRevision,
      branch: repository.branch,
      detached: repository.detached === true,
      entryGeneration: 1,
      lastAppliedBaselineOperationId: null,
      createdByProvisionOperationId: repository.created === true
        ? provisionOperation.operationId
        : null,
      workerIdentity: acl.workerIdentity,
      aclFingerprint: acl.aclFingerprint,
      isPrimary: primary === true,
      updatedAt: Date.now(),
    };
    const mutation = await this.mutateRegistryTopology((registry) => {
      const index = registry.entries.findIndex((entry) => (
        entry.storyId === row.storyId && entry.repositoryId === row.repositoryId
      ));
      if (index >= 0) {
        const existing = registry.entries[index];
        if (
          existing.repositoryPath !== row.repositoryPath
          || existing.baseRevision !== row.baseRevision
        ) {
          throw new GitControllerError(
            "STORY_REPOSITORY_EXACT_SHA_CONFLICT",
            "Controller story registry conflicts with requested exact repository",
          );
        }
        row.entryGeneration = Number(existing.entryGeneration || 0) + 1;
        row.lastAppliedBaselineOperationId =
          existing.lastAppliedBaselineOperationId || null;
        row.createdByProvisionOperationId = existing.createdByProvisionOperationId || null;
        row.isPrimary = primary === true || existing.isPrimary === true;
        registry.entries[index] = row;
      } else {
        if (!registry.entries.some((entry) => (
          entry.storyId === row.storyId && entry.isPrimary === true
        ))) {
          row.isPrimary = true;
        }
        registry.entries.push(row);
      }
      if (row.isPrimary) {
        for (const entry of registry.entries) {
          if (
            entry.storyId === row.storyId
            && entry.repositoryId !== row.repositoryId
          ) {
            entry.isPrimary = false;
          }
        }
      }
      registry.entries.sort((left, right) => (
        left.storyId.localeCompare(right.storyId)
        || left.repositoryId.localeCompare(right.repositoryId)
      ));
      return registry;
    }, {
      operation: provisionOperation,
      fencingToken,
      reason: "story-provision",
      compensateOnFailure: true,
    });
    const next = mutation.registry;
    return {
      row: next.entries.find((entry) => (
        entry.storyId === row.storyId && entry.repositoryId === row.repositoryId
      )),
      registryGeneration: next.generation,
      probe: mutation.probe,
    };
  }

  captureBaselineMetadataRecoveryPrior(tabId, repositoryId) {
    const storyId = String(tabId || "");
    const managedRepositoryId = String(repositoryId || "");
    const registry = this.readRegistry();
    const row = registry.entries.find((entry) => (
      entry.storyId === storyId && entry.repositoryId === managedRepositoryId
    ));
    if (!row) {
      throw new GitControllerError(
        "STORY_REPOSITORY_NOT_REGISTERED",
        "Controller story repository is not registered",
      );
    }
    return Object.freeze({
      tabId: storyId,
      repositoryId: managedRepositoryId,
      registryGeneration: registry.generation,
      entryGeneration: row.entryGeneration,
      metadata: Object.freeze(storyRegistryMetadata(row)),
    });
  }

  async inspectBaselineMetadataRecovery(markerValue) {
    const marker = validateStoryBaselineRegistryRecoveryMarker(markerValue);
    const row = this.registryEntry(marker.tabId, marker.repositoryId);
    if (!row) {
      throw new GitControllerError(
        "STORY_BASELINE_REGISTRY_RECOVERY_CONFLICT",
        "Story baseline recovery target is no longer registered",
        {
          recoveryRequired: true,
          operationId: marker.operationId,
          tabId: marker.tabId,
          repositoryId: marker.repositoryId,
        },
      );
    }
    const inspected = await inspectIndependentStoryRepository(row.repositoryPath, {
      storyId: marker.tabId,
      repositoryId: marker.repositoryId,
      gitBinary: this.gitBinary,
      disabledHooksPath: this.disabledHooksPath,
      gitSpawnGuard: this.gitSpawnGuard,
    });
    if (
      !inspected
      || STORY_BASELINE_METADATA_KEYS.some(
        (key) => inspected[key] !== marker.patch[key],
      )
    ) {
      throw new GitControllerError(
        "STORY_BASELINE_OPERATION_RECOVERY_STATE_MISMATCH",
        "Orphaned story baseline does not match its exact durable Git recovery state",
        {
          recoveryRequired: true,
          operationId: marker.operationId,
          tabId: marker.tabId,
          repositoryId: marker.repositoryId,
          expectedBaseRevision: marker.patch.baseRevision,
          actualBaseRevision: inspected?.baseRevision || null,
          expectedHeadRevision: marker.patch.headRevision,
          actualHeadRevision: inspected?.headRevision || null,
          expectedMirrorGeneration: marker.patch.mirrorGeneration,
          actualMirrorGeneration: inspected?.mirrorGeneration ?? null,
        },
      );
    }
    const acl = this.aclAttestor({
      repositoryPath: row.repositoryPath,
      workerIdentity: row.workerIdentity,
      controllerIdentity: this.controllerIdentity,
      gatewayIdentities: this.gatewayIdentities,
      humanManagerIdentities: this.humanManagerIdentities,
      allWorkerIdentities: Object.values(this.workerIdentities),
      storyRoot: this.storyRoot,
    });
    if (
      acl.workerIdentity !== row.workerIdentity
      || acl.aclFingerprint !== row.aclFingerprint
    ) {
      throw new GitControllerError(
        "STORY_REPOSITORY_WORKER_ACL_DRIFT",
        "Live story repository ACL differs from Controller registry attestation",
        {
          recoveryRequired: true,
          operationId: marker.operationId,
          tabId: marker.tabId,
          repositoryId: marker.repositoryId,
        },
      );
    }
    return Object.freeze(inspected);
  }

  async applyBaselineMetadataRecovery(markerValue) {
    const marker = validateStoryBaselineRegistryRecoveryMarker(markerValue);
    const mutation = await this.mutateRegistryTopology((registry) => {
      const row = registry.entries.find((entry) => (
        entry.storyId === marker.tabId
        && entry.repositoryId === marker.repositoryId
      ));
      if (!row) {
        throw new GitControllerError(
          "STORY_BASELINE_REGISTRY_RECOVERY_CONFLICT",
          "Story baseline recovery target is no longer registered",
          {
            recoveryRequired: true,
            operationId: marker.operationId,
            tabId: marker.tabId,
            repositoryId: marker.repositoryId,
            expectedRegistryGeneration: marker.expectedRegistryGeneration,
            actualRegistryGeneration: registry.generation,
          },
        );
      }
      if (
        row.entryGeneration === marker.expectedEntryGeneration + 1
        && storyRegistryMetadataEquals(row, marker.patch)
        && row.lastAppliedBaselineOperationId === marker.operationId
        && registry.generation >= marker.expectedRegistryGeneration + 1
      ) {
        return registryTopologyNoop({
          applied: false,
          alreadyApplied: true,
          operationId: marker.operationId,
          registryGeneration: registry.generation,
          entryGeneration: row.entryGeneration,
        });
      }
      if (
        registry.generation !== marker.expectedRegistryGeneration
        || row.entryGeneration !== marker.expectedEntryGeneration
        || !storyRegistryMetadataEquals(row, marker.expectedOld)
      ) {
        throw new GitControllerError(
          "STORY_BASELINE_REGISTRY_RECOVERY_CONFLICT",
          "Story baseline recovery CAS no longer matches the exact prior registry state",
          {
            recoveryRequired: true,
            operationId: marker.operationId,
            tabId: marker.tabId,
            repositoryId: marker.repositoryId,
            expectedRegistryGeneration: marker.expectedRegistryGeneration,
            actualRegistryGeneration: registry.generation,
            expectedEntryGeneration: marker.expectedEntryGeneration,
            actualEntryGeneration: row.entryGeneration,
            oldBaseRevision: marker.expectedOld.baseRevision,
            actualBaseRevision: row.baseRevision,
            oldHeadRevision: marker.expectedOld.headRevision,
            actualHeadRevision: row.headRevision,
            lastAppliedBaselineOperationId:
              row.lastAppliedBaselineOperationId || null,
            newBaseRevision: marker.patch.baseRevision,
            newHeadRevision: marker.patch.headRevision,
          },
        );
      }
      for (const key of STORY_BASELINE_METADATA_KEYS) row[key] = marker.patch[key];
      row.entryGeneration = marker.expectedEntryGeneration + 1;
      row.lastAppliedBaselineOperationId = marker.operationId;
      row.updatedAt = Date.now();
      return registry;
    }, {
      reason: `story-baseline-registry-recovery:${marker.operationId}`,
    });
    if (mutation.noop) return mutation.result;
    const row = mutation.registry.entries.find((entry) => (
      entry.storyId === marker.tabId && entry.repositoryId === marker.repositoryId
    ));
    return Object.freeze({
      applied: true,
      alreadyApplied: false,
      operationId: marker.operationId,
      registryGeneration: mutation.registry.generation,
      entryGeneration: row.entryGeneration,
      workerProbeGeneration: mutation.probe?.generation
        ?? mutation.registry.generation,
    });
  }

  async updateMetadata(tabId, repositoryId, patch = {}) {
    await this.mutateRegistryTopology((registry) => {
      const row = registry.entries.find((entry) => (
        entry.storyId === String(tabId) && entry.repositoryId === String(repositoryId)
      ));
      if (!row) {
        throw new GitControllerError(
          "STORY_REPOSITORY_NOT_REGISTERED",
          "Controller story repository is not registered",
        );
      }
      for (const key of [
        "baseRevision", "sourceRef", "remoteId", "mirrorGeneration",
        "headRevision", "branch", "detached",
      ]) {
        if (patch[key] !== undefined) row[key] = patch[key];
      }
      row.entryGeneration = Number(row.entryGeneration || 0) + 1;
      row.updatedAt = Date.now();
      return registry;
    }, {
      reason: "story-metadata-update",
    });
    return this.resolve({ tabId, repositoryId });
  }

  async resolve({ tabId, repositoryId } = {}) {
    const row = this.registryEntry(tabId, repositoryId);
    if (!row) {
      throw new GitControllerError(
        "STORY_REPOSITORY_NOT_REGISTERED",
        "Controller story repository is not registered",
      );
    }
    const inspected = await inspectIndependentStoryRepository(row.repositoryPath, {
      storyId: tabId,
      repositoryId,
      gitBinary: this.gitBinary,
      disabledHooksPath: this.disabledHooksPath,
      gitSpawnGuard: this.gitSpawnGuard,
    });
    if (!inspected) {
      throw new GitControllerError(
        "STORY_REPOSITORY_MISSING",
        "Registered Controller story repository is missing",
      );
    }
    if (
      inspected.baseRevision !== row.baseRevision
      || inspected.sourceRef !== row.sourceRef
      || inspected.mirrorGeneration !== row.mirrorGeneration
    ) {
      throw new GitControllerError(
        "STORY_REPOSITORY_REGISTRY_METADATA_DRIFT",
        "Story repository metadata differs from Controller registry",
      );
    }
    const acl = this.aclAttestor({
      repositoryPath: row.repositoryPath,
      workerIdentity: row.workerIdentity,
      controllerIdentity: this.controllerIdentity,
      gatewayIdentities: this.gatewayIdentities,
      humanManagerIdentities: this.humanManagerIdentities,
      allWorkerIdentities: Object.values(this.workerIdentities),
      storyRoot: this.storyRoot,
    });
    if (
      acl.workerIdentity !== row.workerIdentity
      || acl.aclFingerprint !== row.aclFingerprint
    ) {
      throw new GitControllerError(
        "STORY_REPOSITORY_WORKER_ACL_DRIFT",
        "Live story repository ACL differs from Controller registry attestation",
      );
    }
    return inspected;
  }

  async inspect({ tabId, repositoryId } = {}) {
    this.controller.registry.get(repositoryId);
    const inspected = await this.resolve({ tabId, repositoryId });
    const registered = this.registryEntry(tabId, repositoryId);
    return {
      ...inspected,
      workerIdentity: registered.workerIdentity,
      aclFingerprint: registered.aclFingerprint,
    };
  }

  async verifyCommitRequiredChecks(request) {
    if (
      typeof this.requiredCheckVerifier === "function"
      && process.env.NODE_ENV !== "test"
    ) {
      throw new GitControllerError(
        "STORY_REPOSITORY_CHECK_VERIFIER_OVERRIDE_FORBIDDEN",
        "Production Story Controller must verify required checks from its own receipt stream",
      );
    }
    const verify = typeof this.requiredCheckVerifier === "function"
      ? this.requiredCheckVerifier
      : async ({ storyId, receiptIds, repositoryPath, declaredChanges }) => {
          const stream = readControllerWorkflowReceipts(this.workflowEvidenceRoot, storyId);
          const byId = new Map(stream.receipts.map((entry) => [entry.payload.receiptId, entry]));
          const verifiedReceiptIds = [];
          let identity = null;
          for (const receiptId of receiptIds) {
            const entry = byId.get(receiptId);
            const payload = entry?.payload;
            const selector = payload?.selector;
            if (
              !payload
              || payload.status !== "PASS"
              || !["BUILD", "TEST"].includes(payload.action)
              || !payload.rootId
              || !selector
              || typeof selector.contextId !== "string"
              || !selector.contextId
              || !Number.isSafeInteger(selector.contextRevision)
              || selector.contextRevision < 1
              || !/^[0-9a-f]{64}$/.test(String(selector.editStateSha256 || ""))
              || !/^[0-9a-f]{64}$/.test(String(selector.editStateVersionSha256 || ""))
              || !payload.operationId
              || !payload.idempotencyKey
              || entry.envelope.idempotencyKey !== payload.idempotencyKey
              || !Number.isFinite(Date.parse(String(payload.startedAt || "")))
              || !Number.isFinite(Date.parse(String(payload.finishedAt || "")))
              || !payload.outputRef
              || !/^[0-9a-f]{64}$/i.test(String(payload.sha256 || ""))
            ) {
              return { ok: false, verifiedReceiptIds };
            }
            const candidateIdentity = {
              contextId: selector.contextId,
              contextRevision: selector.contextRevision,
              rootId: payload.rootId,
              editStateSha256: selector.editStateSha256,
              editStateVersionSha256: selector.editStateVersionSha256,
            };
            if (identity && canonicalObjectSha256(identity) !== canonicalObjectSha256(candidateIdentity)) {
              return { ok: false, verifiedReceiptIds };
            }
            identity ||= candidateIdentity;
            if (payload.outputRef && payload.sha256) {
              const prefix = "storydev:/";
              if (!String(payload.outputRef).startsWith(prefix)) {
                return { ok: false, verifiedReceiptIds };
              }
              const relative = String(payload.outputRef).slice(prefix.length).replace(/\\/g, "/");
              const outputPath = assertCommitPathInsideRepository(
                entry.storyDirectory,
                relative,
              );
              const absoluteOutput = path.join(
                entry.storyDirectory,
                ...outputPath.split("/"),
              );
              if (
                !fs.existsSync(absoluteOutput)
                || !fs.lstatSync(absoluteOutput).isFile()
                || createHash("sha256").update(fs.readFileSync(absoluteOutput)).digest("hex")
                  !== String(payload.sha256).toLowerCase()
              ) {
                return { ok: false, verifiedReceiptIds };
              }
            }
            verifiedReceiptIds.push(receiptId);
          }
          if (!identity) return { ok: false, verifiedReceiptIds };
          let editState;
          try {
            editState = deriveWorkflowV2EditState({
              envelopes: stream.receipts.map((entry) => entry.envelope),
              storyId,
              contextId: identity.contextId,
              contextRevision: identity.contextRevision,
              rootId: identity.rootId,
              requireChanges: true,
            });
            if (editState.editStateSha256 !== identity.editStateSha256
              || editState.editStateVersionSha256 !== identity.editStateVersionSha256
              || receiptIds.some((receiptId) => !receiptBindsWorkflowV2EditState(byId.get(receiptId)?.payload, editState))) {
              return { ok: false, verifiedReceiptIds: [] };
            }
            verifyWorkflowV2EditStateFiles({
              absoluteRoot: repositoryPath,
              state: editState,
              expectedPaths: declaredChanges,
            });
          } catch {
            return { ok: false, verifiedReceiptIds: [] };
          }
          return {
            ok: true,
            verifiedReceiptIds,
            editState,
            evidenceDigest: canonicalObjectSha256(
              {
                receiptEnvelopeSha256: stream.receipts
                  .filter((entry) => receiptIds.includes(entry.payload.receiptId))
                  .map((entry) => entry.envelope.envelopeSha256)
                  .sort(),
                editStateSha256: editState.editStateSha256,
                editStateVersionSha256: editState.editStateVersionSha256,
              },
            ),
          };
        };
    const registered = this.registryEntry(request.tabId, request.repositoryId);
    if (!registered?.repositoryPath) {
      throw new GitControllerError(
        "STORY_REPOSITORY_NOT_REGISTERED",
        "Controller story repository is not registered",
      );
    }
    const verdict = await verify({
      storyId: request.tabId,
      repositoryId: request.repositoryId,
      expectedHead: request.expectedHead,
      expectedBranch: request.expectedBranch,
      targetFlavor: request.targetFlavor,
      receiptIds: [...request.requiredCheckReceiptIds],
      repositoryPath: registered.repositoryPath,
      declaredChanges: [...request.declaredChanges],
    });
    const verifiedReceiptIds = verdict === true
      ? [...request.requiredCheckReceiptIds]
      : (Array.isArray(verdict?.verifiedReceiptIds)
          ? verdict.verifiedReceiptIds.map((value) => String(value || "").trim()).sort()
          : []);
    if (verdict !== true && verdict?.ok !== true) {
      throw new GitControllerError(
        "STORY_REPOSITORY_COMMIT_REQUIRED_CHECK_FAILED",
        "One or more required check receipts are missing, failed, or not bound to this story",
        { receiptIds: request.requiredCheckReceiptIds },
      );
    }
    exactPathSet(
      verifiedReceiptIds,
      request.requiredCheckReceiptIds,
      "STORY_REPOSITORY_COMMIT_REQUIRED_CHECK_MISMATCH",
      "Required check verifier did not attest the exact requested receipt set",
    );
    const evidence = {
      receiptIds: [...request.requiredCheckReceiptIds],
      verifierEvidenceDigest: String(verdict?.evidenceDigest || "") || null,
      editStateSha256: String(verdict?.editState?.editStateSha256 || "") || null,
      editStateVersionSha256: String(verdict?.editState?.editStateVersionSha256 || "") || null,
    };
    return Object.freeze({
      ...evidence,
      ...(verdict?.editState ? { editState: verdict.editState } : {}),
      digest: createHash("sha256").update(JSON.stringify(evidence)).digest("hex"),
    });
  }

  verifyStagedCommitEditState(request, editState) {
    if (!editState) return;
    const registered = this.registryEntry(request.tabId, request.repositoryId);
    if (!registered?.repositoryPath) {
      throw new GitControllerError("STORY_REPOSITORY_NOT_REGISTERED", "Controller story repository is not registered");
    }
    verifyWorkflowV2EditStateFiles({
      absoluteRoot: registered.repositoryPath,
      state: editState,
      expectedPaths: request.declaredChanges,
    });
    for (const entry of editState.files) {
      const staged = nulGitRecords(storyGit(
        this.gitBinary,
        this.disabledHooksPath,
        registered.repositoryPath,
        ["ls-files", "--stage", "-z", "--", entry.path],
        this.gitSpawnGuard,
        { encoding: null, maxBuffer: 1024 * 1024 },
      ));
      if (!entry.afterExists) {
        if (staged.length !== 0) {
          throw new GitControllerError(
            "STORY_REPOSITORY_COMMIT_EDIT_STATE_STAGED_MISMATCH",
            "Staged deletion does not match the latest EDIT state",
            { path: entry.path },
          );
        }
        continue;
      }
      if (staged.length !== 1) {
        throw new GitControllerError(
          "STORY_REPOSITORY_COMMIT_EDIT_STATE_STAGED_MISMATCH",
          "Staged file identity does not match the latest EDIT state",
          { path: entry.path },
        );
      }
      const bytes = storyGit(
        this.gitBinary,
        this.disabledHooksPath,
        registered.repositoryPath,
        ["show", `:${entry.path}`],
        this.gitSpawnGuard,
        { encoding: null, maxBuffer: 64 * 1024 * 1024 },
      );
      const stagedSha256 = createHash("sha256").update(bytes).digest("hex");
      if (stagedSha256 !== entry.afterSha256) {
        throw new GitControllerError(
          "STORY_REPOSITORY_COMMIT_EDIT_STATE_STAGED_MISMATCH",
          "Staged file bytes do not match the latest EDIT state",
          { path: entry.path },
        );
      }
    }
  }

  async resolveCommitFlavorPolicy(request, changedPaths) {
    const rawPolicy = typeof this.flavorPolicyResolver === "function"
      ? await this.flavorPolicyResolver({
          storyId: request.tabId,
          repositoryId: request.repositoryId,
          targetFlavor: request.targetFlavor,
          changedPaths: [...changedPaths],
        })
      : defaultControllerFlavorPolicy(
          this.registryEntry(request.tabId, request.repositoryId)?.repositoryPath,
          {
            expectedHead: request.expectedHead,
            gitBinary: this.gitBinary,
            disabledHooksPath: this.disabledHooksPath,
            gitSpawnGuard: this.gitSpawnGuard,
          },
        );
    const policy = rawPolicy && typeof rawPolicy === "object" && !Array.isArray(rawPolicy)
      ? rawPolicy
      : {};
    const catalog = Array.isArray(policy.catalog) ? policy.catalog : [];
    if (catalog.length === 0) {
      throw new GitControllerError(
        "STORY_REPOSITORY_COMMIT_FLAVOR_CATALOG_REQUIRED",
        "Authoritative commit requires a non-empty Controller-resolved Flavor catalog",
      );
    }
    const catalogVerdict = validateFlavorAgainstCatalog({
      flavor: request.targetFlavor,
      catalog,
    });
    if (!catalogVerdict.ok) {
      throw new GitControllerError(
        "STORY_REPOSITORY_COMMIT_FLAVOR_NOT_ALLOWED",
        "Story target Flavor is not present in the trusted project catalog",
        { targetFlavor: request.targetFlavor, known: catalogVerdict.known || [] },
      );
    }
    const diffVerdict = analyzeAuthoritativeFlavorDiff({
      changedPaths,
      targetFlavor: request.targetFlavor,
      sourceSets: policy.sourceSets && typeof policy.sourceSets === "object"
        ? policy.sourceSets
        : {},
    });
    if (!diffVerdict.ok) {
      throw new GitControllerError(
        "STORY_REPOSITORY_COMMIT_OTHER_FLAVOR_CHANGED",
        "Commit diff contains changes for a non-target Flavor",
        { blockers: diffVerdict.blockers },
      );
    }
    if ((diffVerdict.warnings || []).length > 0 && policy.mainImpactApproved !== true) {
      throw new GitControllerError(
        "STORY_REPOSITORY_COMMIT_MAIN_IMPACT_APPROVAL_REQUIRED",
        "Public main sourceSet changes require an explicit trusted impact approval",
        { warnings: diffVerdict.warnings },
      );
    }
    return Object.freeze({
      targetFlavor: request.targetFlavor,
      catalogUnavailable: catalogVerdict.catalogUnavailable === true,
      inferred: diffVerdict.inferred === true,
      warnings: Object.freeze([...(diffVerdict.warnings || [])]),
    });
  }

  commitMessage(request) {
    const message = buildSystemCommitMessage({
      storyId: request.tabId,
      operationId: request.operationId,
      targetFlavor: request.targetFlavor,
      summary: request.changeSummary,
      details: `变更文件数: ${request.declaredChanges.length}\n检查回执数: ${request.requiredCheckReceiptIds.length}`,
    });
    const verdict = validateSystemCommitMessage(message);
    if (!verdict.ok) {
      throw new GitControllerError(
        "STORY_REPOSITORY_COMMIT_MESSAGE_INVALID",
        "System-generated commit message failed the Controller policy",
        { issues: verdict.issues },
      );
    }
    return message.trimEnd();
  }

  commitRecoveryBinding(operation) {
    const row = this.controller.journal.persistence
      .listGitControllerJournal(operation.operationId)
      .find((entry) => entry.phase === "BASE_APPLYING" && entry.data?.commitRequest);
    if (!row) return null;
    const request = normalizeCommitRequest(row.data.commitRequest);
    const message = this.commitMessage(request);
    const binding = commitRequestBinding(request);
    if (
      request.repositoryId !== operation.repositoryId
      || request.operationId !== operation.idempotencyKey
      || request.expectedHead !== String(operation.expectedHead || "").toLowerCase()
      || binding !== operation.branch
      || createHash("sha256").update(message).digest("hex") !== row.data.messageSha256
      || !/^[0-9a-f]{64}$/.test(String(row.data.requiredCheckDigest || ""))
      || !row.data.flavorEvidence
      || typeof row.data.flavorEvidence !== "object"
    ) {
      throw new GitControllerError(
        "STORY_REPOSITORY_COMMIT_RECOVERY_BINDING_INVALID",
        "Interrupted commit journal is not bound to the exact authoritative request",
        { operationId: operation.operationId, recoveryRequired: true },
      );
    }
    return { request, message, binding, journal: row.data };
  }

  assertCommitReadback(binding, commitSha) {
    const registered = this.registryEntry(
      binding.request.tabId,
      binding.request.repositoryId,
    );
    if (!registered) {
      throw new GitControllerError(
        "STORY_REPOSITORY_NOT_REGISTERED",
        "Controller story repository is not registered",
      );
    }
    const readback = commitReadback(
      this.gitBinary,
      this.disabledHooksPath,
      registered.repositoryPath,
      commitSha,
      this.gitSpawnGuard,
    );
    if (
      readback.parents.length !== 1
      || readback.parents[0] !== binding.request.expectedHead
      || readback.message !== binding.message
    ) {
      throw new GitControllerError(
        "STORY_REPOSITORY_COMMIT_READBACK_MISMATCH",
        "Committed SHA, parent, or message does not match the authoritative request",
        { commitSha: readback.sha, recoveryRequired: true },
      );
    }
    exactPathSet(
      readback.changedPaths,
      binding.request.declaredChanges,
      "STORY_REPOSITORY_COMMIT_READBACK_DIFF_MISMATCH",
      "Committed diff does not match the exact declared change set",
    );
    return { registered, readback };
  }

  async finalizeRecoveredCommit(operation, binding, lease, {
    replayed = true,
    recovered = true,
  } = {}) {
    lease.assertCurrent();
    const registered = this.registryEntry(
      binding.request.tabId,
      binding.request.repositoryId,
    );
    const liveBranch = storyGit(
      this.gitBinary,
      this.disabledHooksPath,
      registered.repositoryPath,
      ["branch", "--show-current"],
      this.gitSpawnGuard,
    );
    const liveHead = normalizeSha(storyGit(
      this.gitBinary,
      this.disabledHooksPath,
      registered.repositoryPath,
      ["rev-parse", "--verify", "HEAD^{commit}"],
      this.gitSpawnGuard,
    ), { label: "story repository recovered HEAD" });
    if (liveBranch !== binding.request.expectedBranch) {
      throw new GitControllerError(
        "STORY_REPOSITORY_COMMIT_BRANCH_DRIFT",
        "Story branch changed while commit recovery was running",
        { recoveryRequired: true, actualBranch: liveBranch },
      );
    }
    if (liveHead === binding.request.expectedHead) {
      const interrupted = new GitControllerError(
        "STORY_REPOSITORY_COMMIT_INTERRUPTED_BEFORE_COMMIT",
        "Interrupted authoritative commit was closed before Git changed HEAD",
        { operationId: operation.operationId },
      );
      this.controller.journal.fail(operation, interrupted, {
        fencingToken: lease.fencingToken,
      });
      throw interrupted;
    }
    const { readback } = this.assertCommitReadback(binding, liveHead);
    await this.updateMetadata(
      binding.request.tabId,
      binding.request.repositoryId,
      { headRevision: readback.sha, branch: liveBranch },
    );
    const dirtyAfterCommit = storyCommitStatus(
      this.gitBinary,
      this.disabledHooksPath,
      registered.repositoryPath,
      this.gitSpawnGuard,
    ).paths;
    const result = {
      ok: true,
      resultCode: "PASS",
      operationId: binding.request.operationId,
      controllerOperationId: operation.operationId,
      replayed,
      recovered,
      repositoryId: binding.request.repositoryId,
      tabId: binding.request.tabId,
      branch: liveBranch,
      beforeSha: binding.request.expectedHead,
      commitSha: readback.sha,
      message: readback.message,
      changedPaths: [...readback.changedPaths],
      targetFlavor: binding.request.targetFlavor,
      requiredCheckReceiptIds: [...binding.request.requiredCheckReceiptIds],
      dirtyAfterCommit,
      flavorWarnings: [...(binding.journal.flavorEvidence.warnings || [])],
    };
    this.controller.audit.write({
      operation,
      commandId: "story.repository.commit",
      action: "story.repository.commit",
      branch: liveBranch,
      beforeSha: binding.request.expectedHead,
      candidateSha: readback.sha,
      result: "PASS",
      fencingToken: lease.fencingToken,
      actor: recovered ? "controller:story-commit-recovery" : "controller:story-commit",
      details: {
        storyId: binding.request.tabId,
        targetFlavor: binding.request.targetFlavor,
        changedPathCount: readback.changedPaths.length,
        recovered,
      },
    });
    this.controller.journal.succeed(operation, result, lease.fencingToken);
    return result;
  }

  async recoverCommitOperation(operation, { reclaimed = false } = {}) {
    const binding = this.commitRecoveryBinding(operation);
    if (!binding) {
      throw new GitControllerError(
        "STORY_REPOSITORY_COMMIT_RECOVERY_BINDING_INVALID",
        "Interrupted commit has no durable pre-commit binding",
        { operationId: operation.operationId, recoveryRequired: true },
      );
    }
    const entry = this.controller.registry.get(operation.repositoryId);
    if (!reclaimed && operation.status === "RUNNING") {
      const activeLease = this.controller.journal.persistence
        .getGitControllerRepositoryLease?.(entry.repositoryId);
      if (activeLease) {
        throw new GitControllerError(
          "GIT_CONTROLLER_OPERATION_IN_PROGRESS",
          "Authoritative story commit is still running",
          { operationId: operation.operationId },
        );
      }
    }
    let lease = null;
    try {
      lease = this.controller.leaseManager.acquire(entry, {
        operationId: operation.operationId,
        kind: "story-repository-commit-recovery",
      });
      return await this.finalizeRecoveredCommit(operation, binding, lease);
    } finally {
      lease?.release();
    }
  }

  async recoverCommitOperations() {
    const operations = listAllRecoverableOperations(
      this.controller.journal.persistence,
      { operationType: COMMIT_OPERATION },
    );
    const unresolved = [];
    let succeeded = 0;
    let safelyFailed = 0;
    for (const operation of operations) {
      try {
        const entry = this.controller.registry.get(operation.repositoryId);
        this.controller.leaseManager.reclaimOrphanedOperation(entry, operation);
        await this.recoverCommitOperation(operation, { reclaimed: true });
        succeeded += 1;
      } catch (error) {
        if (error?.code === "STORY_REPOSITORY_COMMIT_INTERRUPTED_BEFORE_COMMIT") {
          safelyFailed += 1;
        } else {
          unresolved.push(asControllerError(
            error,
            "STORY_REPOSITORY_COMMIT_RECOVERY_REQUIRED",
          ));
        }
      }
    }
    if (unresolved.length) {
      throw new GitControllerError(
        "STORY_REPOSITORY_COMMIT_RECOVERY_BLOCKED",
        "One or more authoritative story commits require administrative recovery",
        { errors: unresolved.map((error) => error.code) },
      );
    }
    return { recovered: operations.length, succeeded, safelyFailed };
  }

  async commit(payload = {}) {
    const request = normalizeCommitRequest(payload);
    const entry = this.controller.registry.get(request.repositoryId);
    await this.controller.registry.verify(entry.repositoryId);
    const registered = this.registryEntry(request.tabId, entry.repositoryId);
    if (!registered) {
      throw new GitControllerError(
        "STORY_REPOSITORY_NOT_REGISTERED",
        "Controller story repository is not registered",
      );
    }
    const expectedPath = assertTargetInsideRoot(
      this.storyRoot,
      request.tabId,
      entry.repositoryId,
    );
    if (normalizedControllerPath(registered.repositoryPath) !== normalizedControllerPath(expectedPath)) {
      throw new GitControllerError(
        "STORY_REPOSITORY_REGISTRY_PATH_DRIFT",
        "Controller story repository path is outside its canonical owned root",
      );
    }
    const journalBranch = commitRequestBinding(request);
    const begun = this.controller.journal.begin({
      repositoryId: entry.repositoryId,
      operationType: COMMIT_OPERATION,
      commandId: "story.repository.commit",
      idempotencyKey: request.operationId,
      previewId: null,
      branch: journalBranch,
      expectedHead: request.expectedHead,
      candidateSha: null,
    });
    if (!begun.created) {
      const existing = begun.operation;
      if (
        existing.branch !== journalBranch
        || String(existing.expectedHead || "").toLowerCase() !== request.expectedHead
      ) {
        throw new GitControllerError(
          "GIT_CONTROLLER_IDEMPOTENCY_CONFLICT",
          "Commit operationId was already bound to another authoritative request",
        );
      }
      if (existing.status === "SUCCEEDED" && existing.result) {
        return { ...existing.result, replayed: true };
      }
      if (["RUNNING", "RECOVERY_REQUIRED"].includes(existing.status)) {
        return this.recoverCommitOperation(existing);
      }
      return replay(existing, { branch: journalBranch, expectedHead: request.expectedHead });
    }
    const operation = begun.operation;
    let lease = null;
    let commitStarted = false;
    try {
      lease = this.controller.leaseManager.acquire(entry, {
        operationId: operation.operationId,
        kind: "story-repository-commit",
      });
      lease.assertCurrent();
      await this.controller.registry.verify(entry.repositoryId);
      const liveHead = normalizeSha(storyGit(
        this.gitBinary,
        this.disabledHooksPath,
        registered.repositoryPath,
        ["rev-parse", "--verify", "HEAD^{commit}"],
        this.gitSpawnGuard,
      ), { label: "story repository live HEAD" });
      const liveBranch = storyGit(
        this.gitBinary,
        this.disabledHooksPath,
        registered.repositoryPath,
        ["branch", "--show-current"],
        this.gitSpawnGuard,
      );
      if (liveHead !== request.expectedHead) {
        throw new GitControllerError(
          "STORY_REPOSITORY_COMMIT_HEAD_MISMATCH",
          "Story repository HEAD differs from the expected authoritative revision",
          { expectedHead: request.expectedHead, actualHead: liveHead },
        );
      }
      if (liveBranch !== request.expectedBranch) {
        throw new GitControllerError(
          "STORY_REPOSITORY_COMMIT_BRANCH_MISMATCH",
          "Story repository branch differs from the expected authoritative branch",
          { expectedBranch: request.expectedBranch, actualBranch: liveBranch },
        );
      }
      const status = storyCommitStatus(
        this.gitBinary,
        this.disabledHooksPath,
        registered.repositoryPath,
        this.gitSpawnGuard,
      );
      if (status.unmerged) {
        throw new GitControllerError(
          "STORY_REPOSITORY_COMMIT_UNMERGED",
          "Story repository contains unmerged paths",
        );
      }
      if (status.hiddenIndex.length) {
        throw new GitControllerError(
          "STORY_REPOSITORY_COMMIT_HIDDEN_INDEX_FLAGS",
          "Story repository contains skip-worktree or assume-unchanged index flags",
          { paths: status.hiddenIndex },
        );
      }
      exactPathSet(
        status.paths,
        request.declaredChanges,
        "STORY_REPOSITORY_COMMIT_UNDECLARED_CHANGE",
        "Live dirty paths do not exactly match the declared change set",
      );
      for (const relativePath of request.declaredChanges) {
        assertCommitPathInsideRepository(registered.repositoryPath, relativePath);
      }
      const checks = await this.verifyCommitRequiredChecks(request);
      const flavorEvidence = await this.resolveCommitFlavorPolicy(request, status.paths);
      const message = this.commitMessage(request);
      this.controller.journal.append(operation, "BASE_APPLYING", {
        commitRequest: {
          ...request,
          declaredChanges: [...request.declaredChanges],
          requiredCheckReceiptIds: [...request.requiredCheckReceiptIds],
        },
        repositoryPath: registered.repositoryPath,
        messageSha256: createHash("sha256").update(message).digest("hex"),
        requiredCheckDigest: checks.digest,
        flavorEvidence,
      }, lease.fencingToken);
      lease.assertCurrent();
      storyGit(
        this.gitBinary,
        this.disabledHooksPath,
        registered.repositoryPath,
        ["add", "-A", "--", ...request.declaredChanges],
        this.gitSpawnGuard,
        { timeoutMs: 60_000, maxBuffer: 16 * 1024 * 1024 },
      );
      const stagedPaths = nulGitRecords(storyGit(
        this.gitBinary,
        this.disabledHooksPath,
        registered.repositoryPath,
        ["diff", "--cached", "--name-only", "--no-renames", "-z", "HEAD", "--"],
        this.gitSpawnGuard,
        { encoding: null, maxBuffer: 16 * 1024 * 1024 },
      ));
      exactPathSet(
        stagedPaths,
        request.declaredChanges,
        "STORY_REPOSITORY_COMMIT_STAGED_DIFF_MISMATCH",
        "Controller staging index does not exactly match declared changes",
      );
      this.verifyStagedCommitEditState(request, checks.editState);
      const beforeCommitStatus = storyCommitStatus(
        this.gitBinary,
        this.disabledHooksPath,
        registered.repositoryPath,
        this.gitSpawnGuard,
      );
      exactPathSet(
        beforeCommitStatus.paths,
        request.declaredChanges,
        "STORY_REPOSITORY_COMMIT_DIRTY_SET_DRIFT",
        "Dirty path set changed while the Controller was staging",
      );
      lease.assertCurrent();
      commitStarted = true;
      storyGit(
        this.gitBinary,
        this.disabledHooksPath,
        registered.repositoryPath,
        [
          "-c", "user.name=DevBench Git Controller",
          "-c", "user.email=devbench-git-controller@localhost",
          "commit", "--no-gpg-sign", "--cleanup=verbatim", "-m", message,
        ],
        this.gitSpawnGuard,
        { timeoutMs: 120_000, maxBuffer: 16 * 1024 * 1024 },
      );
      const committedHead = normalizeSha(storyGit(
        this.gitBinary,
        this.disabledHooksPath,
        registered.repositoryPath,
        ["rev-parse", "--verify", "HEAD^{commit}"],
        this.gitSpawnGuard,
      ), { label: "story repository committed HEAD" });
      if (this.faultInjector) {
        await this.faultInjector("after-story-repository-commit", {
          operation,
          request,
          commitSha: committedHead,
        });
      }
      const binding = {
        request,
        message,
        binding: journalBranch,
        journal: { flavorEvidence, requiredCheckDigest: checks.digest },
      };
      return await this.finalizeRecoveredCommit(operation, binding, lease, {
        replayed: false,
        recovered: false,
      });
    } catch (rawError) {
      const error = asControllerError(rawError, "STORY_REPOSITORY_COMMIT_FAILED");
      let recoveryRequired = false;
      if (commitStarted) {
        try {
          const currentHead = normalizeSha(storyGit(
            this.gitBinary,
            this.disabledHooksPath,
            registered.repositoryPath,
            ["rev-parse", "--verify", "HEAD^{commit}"],
            this.gitSpawnGuard,
          ), { label: "story repository failure HEAD" });
          recoveryRequired = currentHead !== request.expectedHead;
        } catch {
          recoveryRequired = true;
        }
      }
      this.controller.journal.fail(operation, error, {
        fencingToken: lease?.fencingToken || null,
        recoveryRequired,
      });
      throw error;
    } finally {
      lease?.release();
    }
  }

  inspectLegacyMigrationSource(entry, sourcePath) {
    return inspectLegacyMigrationSource({
      gitBinary: this.gitBinary,
      disabledHooksPath: this.disabledHooksPath,
      gitSpawnGuard: this.gitSpawnGuard,
      sourcePath,
      entry,
      storyRoot: this.storyRoot,
      dataRoot: this.dataRoot,
    });
  }

  async previewLegacyMigration({ tabId, repositoryId, sourcePath } = {}) {
    const storyId = String(tabId || "").trim();
    if (!storyId) {
      throw new GitControllerError(
        "STORY_REPOSITORY_STORY_ID_REQUIRED",
        "Legacy story migration requires a story id",
      );
    }
    const entry = this.controller.registry.get(repositoryId);
    await this.controller.registry.verify(entry.repositoryId);
    const workerIdentity = normalizedWorkerIdentity(this.workerIdentities[storyId]);
    if (!workerIdentity) {
      throw new GitControllerError(
        "STORY_REPOSITORY_WORKER_IDENTITY_MISSING",
        "Protected Controller policy has no Worker identity for this story",
      );
    }
    const state = this.inspectLegacyMigrationSource(entry, sourcePath);
    return {
      ok: true,
      resultCode: state.canMigrate ? "PASS" : "BLOCKED",
      repositoryId: entry.repositoryId,
      sourcePath: state.sourcePath,
      sourceHeadRevision: state.headRevision,
      sourceBranch: state.branch,
      stateDigest: state.stateDigest,
      dirtyTrackedCount: state.dirtyTrackedCount,
      untrackedCount: state.untrackedCount,
      changedBytes: state.changedBytes,
      stashCount: state.stashCount,
      unmergedCount: state.unmergedCount,
      hiddenIndexCount: state.hiddenIndexCount,
      changedFiles: state.changedFiles,
      blockers: state.blockers,
      canMigrate: state.canMigrate,
      workerIdentity,
    };
  }

  provisionRecoveryBinding(operation, journalRows) {
    const creating = journalRows.find(
      (row) => row.phase === "STORY_PROVISION_CREATING",
    );
    if (!creating) return null;
    const data = creating.data || {};
    const storyId = String(data.storyId || "").trim();
    const repositoryId = String(data.repositoryId || "").trim();
    const sourceBranch = String(data.sourceBranch || "").trim();
    const workerIdentity = normalizedWorkerIdentity(data.workerIdentity);
    const legacyMigration = data.legacyMigration && typeof data.legacyMigration === "object"
      ? {
          sourcePath: path.resolve(String(data.legacyMigration.sourcePath || "")),
          stateDigest: String(data.legacyMigration.stateDigest || "").toLowerCase(),
        }
      : null;
    const candidateSha = normalizeSha(data.candidateSha, {
      label: "story provision recovery candidate SHA",
    });
    const repositoryPath = assertTargetInsideRoot(
      this.storyRoot,
      storyId,
      repositoryId,
    );
    const expectedBinding = operationBinding("story_provision", [
      storyId,
      repositoryId,
      sourceBranch,
      data.detached === true,
      data.primary === true,
      legacyMigration?.sourcePath || "",
      legacyMigration?.stateDigest || "",
    ]);
    if (
      !storyId
      || repositoryId !== operation.repositoryId
      || candidateSha !== operation.candidateSha
      || operation.branch !== expectedBinding
      || normalizedControllerPath(repositoryPath)
        !== normalizedControllerPath(data.repositoryPath)
      || workerIdentity !== normalizedWorkerIdentity(this.workerIdentities[storyId])
      || typeof data.targetExistedBefore !== "boolean"
      || (
        data.registryExistedBefore !== undefined
        && typeof data.registryExistedBefore !== "boolean"
      )
      || (
        data.registryExistedBefore === true
        && (
          !Number.isSafeInteger(Number(data.priorRegistryEntryGeneration))
          || Number(data.priorRegistryEntryGeneration) < 1
          || !/^[0-9a-f]{64}$/.test(String(data.priorRegistrySignature || ""))
          || (
            data.priorCreatedByProvisionOperationId !== null
            && typeof data.priorCreatedByProvisionOperationId !== "string"
          )
        )
      )
      || String(data.sourceRef || "") !== `refs/heads/${sourceBranch}`
      || !Number.isSafeInteger(Number(data.mirrorGeneration))
      || Number(data.mirrorGeneration) < 0
      || !candidateContentPreflightEvidenceValid(
        data.candidateContentPreflight,
      )
      || (
        legacyMigration
        && (
          !path.isAbsolute(String(data.legacyMigration.sourcePath || ""))
          || !/^[0-9a-f]{64}$/.test(legacyMigration.stateDigest)
        )
      )
    ) {
      throw new GitControllerError(
        "STORY_REPOSITORY_PROVISION_RECOVERY_BINDING_INVALID",
        "Interrupted story provision journal does not preserve an exact Controller binding",
        { operationId: operation.operationId },
      );
    }
    return {
      ...data,
      storyId,
      repositoryId,
      sourceBranch,
      workerIdentity,
      candidateSha,
      repositoryPath,
      mirrorGeneration: Number(data.mirrorGeneration),
      provisionBranch: String(data.provisionBranch || ""),
      registryExistedBefore: data.registryExistedBefore === true,
      priorRegistryEntryGeneration: data.registryExistedBefore === true
        ? Number(data.priorRegistryEntryGeneration)
        : null,
      priorRegistrySignature: data.registryExistedBefore === true
        ? String(data.priorRegistrySignature)
        : null,
      priorCreatedByProvisionOperationId: data.registryExistedBefore === true
        ? data.priorCreatedByProvisionOperationId
        : null,
      legacyMigration,
    };
  }

  writeProvisionRecoveryAudit(operation, binding, {
    result,
    reason,
    fencingToken,
    details = {},
  }) {
    const existing = this.controller.journal.persistence.listGitControllerAudit({
      operationId: operation.operationId,
    }).some((row) => (
      row.action === "story.repository.provision"
      && row.result === result
      && (
        result === "PASS"
        || row.reason === (reason || null)
      )
    ));
    if (existing) return;
    this.controller.audit.write({
      operation,
      commandId: "story.repository.provision",
      action: "story.repository.provision",
      branch: binding?.sourceBranch || null,
      candidateSha: binding?.candidateSha || operation.candidateSha || null,
      result,
      reason: reason || null,
      durationMs: Math.max(0, Date.now() - Number(operation.startedAt || 0)),
      fencingToken,
      actor: "controller:story-provision-recovery",
      details: {
        storyId: binding?.storyId || null,
        recovered: true,
        ...details,
      },
    });
  }

  provisionRollbackState(operation) {
    const created = this.controller.journal.persistence
      .listGitControllerJournal(operation.operationId)
      .findLast((row) => (
        (
          row.phase === "STORY_PROVISION_CREATED"
          || row.phase === "STORY_PROVISION_LEGACY_MIGRATED"
          || row.phase === "STORY_PROVISION_ACL_APPLIED"
        )
        && row.data?.rollbackState
      ));
    const state = created?.data?.rollbackState;
    if (
      !state
      || typeof state !== "object"
      || Array.isArray(state)
      || !/^[0-9a-f]{64}$/.test(String(state.signature || ""))
      || provisionRollbackStateSignature(state) !== state.signature
    ) {
      throw new GitControllerError(
        "STORY_REPOSITORY_COMPENSATION_STATE_UNVERIFIED",
        "Story provision has no valid exact no-change rollback attestation",
        { operationId: operation.operationId, recoveryRequired: true },
      );
    }
    return state;
  }

  assertProvisionRollbackUnchanged(operation, inspected) {
    const expected = this.provisionRollbackState(operation);
    const current = captureProvisionRollbackState(
      this.gitBinary,
      this.disabledHooksPath,
      inspected.repositoryPath,
      inspected,
      this.gitSpawnGuard,
    );
    if (
      normalizedControllerPath(current.repositoryPath)
        !== normalizedControllerPath(expected.repositoryPath)
      || current.signature !== expected.signature
    ) {
      throw new GitControllerError(
        "STORY_REPOSITORY_COMPENSATION_STATE_DRIFT",
        "Story repository changed after creation and cannot be deleted by compensation",
        {
          operationId: operation.operationId,
          expectedSignature: expected.signature,
          actualSignature: current.signature,
          recoveryRequired: true,
        },
      );
    }
    return current;
  }

  async recoverProvisionOperations() {
    const commitRecovery = await this.recoverCommitOperations();
    const operations = listAllRecoverableOperations(
      this.controller.journal.persistence,
      { operationType: PROVISION_OPERATION },
    );
    const unresolved = [];
    let rolledBack = 0;
    let succeeded = 0;
    let safelyFailed = 0;
    for (const operation of operations) {
      let entry = null;
      let lease = null;
      let reclaimed = false;
      try {
        entry = this.controller.registry.get(operation.repositoryId);
        this.controller.leaseManager.reclaimOrphanedOperation(entry, operation);
        reclaimed = true;
        lease = this.controller.leaseManager.acquire(entry, {
          operationId: operation.operationId,
          kind: "story-repository-provision-recovery",
        });
        lease.assertCurrent();
        const journalRows = this.controller.journal.persistence
          .listGitControllerJournal(operation.operationId);
        const binding = this.provisionRecoveryBinding(operation, journalRows);
        if (!binding) {
          if (
            operation.phase === "PREVIEWED"
            && journalRows.every((row) => row.phase === "PREVIEWED")
          ) {
            const interrupted = new GitControllerError(
              "STORY_REPOSITORY_PROVISION_INTERRUPTED_BEFORE_CREATE",
              "Interrupted story provision was safely closed before repository creation",
              { operationId: operation.operationId },
            );
            this.controller.journal.fail(operation, interrupted);
            safelyFailed += 1;
            continue;
          }
          throw new GitControllerError(
            "STORY_REPOSITORY_PROVISION_RECOVERY_BINDING_INVALID",
            "Interrupted story provision has no durable pre-create binding",
            { operationId: operation.operationId },
          );
        }

        const { entry: resolvedEntry, branch } = await this.controller.registry.resolve(
          binding.repositoryId,
          binding.sourceBranch,
        );
        if (resolvedEntry.repositoryId !== entry.repositoryId) {
          throw new GitControllerError(
            "STORY_REPOSITORY_PROVISION_RECOVERY_BINDING_INVALID",
            "Interrupted story provision resolved to a different Controller repository",
          );
        }
        if (branch !== binding.sourceBranch) {
          throw new GitControllerError(
            "STORY_REPOSITORY_PROVISION_RECOVERY_BINDING_INVALID",
            "Interrupted story provision source branch is no longer registered",
          );
        }
        await this.controller.registry.verify(entry.repositoryId);
        const registered = this.registryEntry(
          binding.storyId,
          binding.repositoryId,
        );
        const inspected = await inspectIndependentStoryRepository(
          binding.repositoryPath,
          {
            storyId: binding.storyId,
            repositoryId: binding.repositoryId,
            gitBinary: this.gitBinary,
            disabledHooksPath: this.disabledHooksPath,
            gitSpawnGuard: this.gitSpawnGuard,
          },
        );

        if (
          registered
          && binding.registryExistedBefore
          && registered.entryGeneration === binding.priorRegistryEntryGeneration
          && storyRegistryEntrySignature(registered)
            === binding.priorRegistrySignature
        ) {
          if (
            !inspected
            || inspected.baseRevision !== binding.candidateSha
            || inspected.headRevision !== binding.candidateSha
            || inspected.sourceRef !== binding.sourceRef
            || Number(inspected.mirrorGeneration) !== binding.mirrorGeneration
            || inspected.detached !== (binding.detached === true)
            || inspected.branch !== (binding.detached === true
              ? ""
              : binding.provisionBranch)
          ) {
            throw new GitControllerError(
              "STORY_REPOSITORY_PROVISION_RECOVERY_REQUIRED",
              "Rebuilt story repository no longer matches its exact pre-publication state",
              { operationId: operation.operationId },
            );
          }
          this.assertProvisionRollbackUnchanged(operation, inspected);
          if (binding.targetExistedBefore === false) {
            await rollbackCreatedIndependentStoryRepository(
              { ...inspected, created: true },
              {
                gitBinary: this.gitBinary,
                disabledHooksPath: this.disabledHooksPath,
                gitSpawnGuard: this.gitSpawnGuard,
              },
            );
            if (fs.existsSync(binding.repositoryPath)) {
              throw new GitControllerError(
                "STORY_REPOSITORY_PROVISION_RECOVERY_REQUIRED",
                "Interrupted retained-SHA rebuild rollback did not remove the exact target",
              );
            }
            const storyDirectory = path.dirname(binding.repositoryPath);
            if (
              path.dirname(storyDirectory) === this.storyRoot
              && fs.existsSync(storyDirectory)
              && fs.readdirSync(storyDirectory).length === 0
            ) {
              fs.rmdirSync(storyDirectory);
            }
            rolledBack += 1;
          } else {
            safelyFailed += 1;
          }
          const interrupted = new GitControllerError(
            "STORY_REPOSITORY_PROVISION_INTERRUPTED_BEFORE_REGISTRY_PUBLISH",
            "Interrupted story provision left the prior registry binding unchanged",
            { operationId: operation.operationId },
          );
          this.writeProvisionRecoveryAudit(operation, binding, {
            result: "FAIL",
            reason: interrupted.code,
            fencingToken: lease.fencingToken,
            details: {
              retainedShaRebuild: binding.targetExistedBefore === false,
              rolledBack: binding.targetExistedBefore === false,
            },
          });
          this.controller.journal.fail(operation, interrupted, {
            fencingToken: lease.fencingToken,
          });
          continue;
        }

        if (registered) {
          if (
            !inspected
            || normalizedControllerPath(registered.repositoryPath)
              !== normalizedControllerPath(binding.repositoryPath)
            || registered.baseRevision !== binding.candidateSha
            || registered.headRevision !== binding.candidateSha
            || registered.sourceRef !== binding.sourceRef
            || Number(registered.mirrorGeneration) !== binding.mirrorGeneration
            || registered.workerIdentity !== binding.workerIdentity
            || (binding.primary === true && registered.isPrimary !== true)
            || (
              !binding.registryExistedBefore
              && binding.targetExistedBefore === false
              && registered.createdByProvisionOperationId !== operation.operationId
            )
            || (
              binding.registryExistedBefore
              && (
                registered.entryGeneration
                  !== binding.priorRegistryEntryGeneration + 1
                || registered.createdByProvisionOperationId
                  !== binding.priorCreatedByProvisionOperationId
              )
            )
          ) {
            throw new GitControllerError(
              "STORY_REPOSITORY_PROVISION_RECOVERY_REQUIRED",
              "Registered story repository does not exactly match the interrupted provision",
              { operationId: operation.operationId },
            );
          }
          const resolved = await this.resolve({
            tabId: binding.storyId,
            repositoryId: binding.repositoryId,
          });
          this.assertProvisionRollbackUnchanged(operation, resolved);
          if (
            resolved.baseRevision !== binding.candidateSha
            || resolved.headRevision !== binding.candidateSha
            || resolved.branch !== (binding.detached === true
              ? ""
              : binding.provisionBranch)
            || resolved.detached !== (binding.detached === true)
          ) {
            throw new GitControllerError(
              "STORY_REPOSITORY_PROVISION_RECOVERY_REQUIRED",
              "Live story repository failed exact-SHA provision recovery verification",
              { operationId: operation.operationId },
            );
          }
          const registry = this.readRegistry();
          const topology = this.buildWorkerProbeTopology(registry);
          const probe = this.workerProbeEnabled
            ? this.readWorkerProbeConfig()
            : null;
          if (
            this.workerProbeEnabled
            && !this.workerProbeTopologyMatches(topology, probe)
          ) {
            throw new GitControllerError(
              "STORY_REPOSITORY_PROVISION_RECOVERY_REQUIRED",
              "Worker probe topology is not reconciled with the recovered story registry",
              { operationId: operation.operationId },
            );
          }
          const repository = {
            ...resolved,
            created: binding.targetExistedBefore === false,
            reused: binding.targetExistedBefore === true,
          };
          const result = {
            ok: true,
            resultCode: "PASS",
            operationId: operation.operationId,
            replayed: false,
            recovered: true,
            created: repository.created,
            reused: repository.reused,
            repository,
            registryGeneration: registered.entryGeneration,
            workerIdentity: registered.workerIdentity,
            aclFingerprint: registered.aclFingerprint,
            workerProbeGeneration: probe?.generation ?? registry.generation,
            storiesRequiringProbe: [...new Set(
              registry.entries.map((row) => row.storyId),
            )].sort(),
          };
          this.writeProvisionRecoveryAudit(operation, binding, {
            result: "PASS",
            reason: "startup-recovery",
            fencingToken: lease.fencingToken,
            details: { created: result.created },
          });
          this.controller.journal.succeed(
            operation,
            result,
            lease.fencingToken,
          );
          succeeded += 1;
          continue;
        }

        if (!inspected && binding.targetExistedBefore === false) {
          const interrupted = new GitControllerError(
            "STORY_REPOSITORY_PROVISION_INTERRUPTED_BEFORE_PUBLISH",
            "Interrupted story provision was safely closed before repository publication",
            { operationId: operation.operationId },
          );
          this.writeProvisionRecoveryAudit(operation, binding, {
            result: "FAIL",
            reason: interrupted.code,
            fencingToken: lease.fencingToken,
          });
          this.controller.journal.fail(operation, interrupted, {
            fencingToken: lease.fencingToken,
          });
          safelyFailed += 1;
          continue;
        }
        if (
          inspected
          && binding.targetExistedBefore === false
          && inspected.baseRevision === binding.candidateSha
          && inspected.headRevision === binding.candidateSha
          && inspected.sourceRef === binding.sourceRef
          && Number(inspected.mirrorGeneration) === binding.mirrorGeneration
          && inspected.detached === (binding.detached === true)
          && inspected.branch === (binding.detached === true
            ? ""
            : binding.provisionBranch)
        ) {
          this.assertProvisionRollbackUnchanged(operation, inspected);
          const removed = await rollbackCreatedIndependentStoryRepository(
            { ...inspected, created: true },
            {
              gitBinary: this.gitBinary,
              disabledHooksPath: this.disabledHooksPath,
              gitSpawnGuard: this.gitSpawnGuard,
            },
          );
          if (fs.existsSync(binding.repositoryPath)) {
            throw new GitControllerError(
              "STORY_REPOSITORY_PROVISION_RECOVERY_REQUIRED",
              "Interrupted story repository rollback did not remove the exact target",
            );
          }
          const storyDirectory = path.dirname(binding.repositoryPath);
          if (
            path.dirname(storyDirectory) === this.storyRoot
            && fs.existsSync(storyDirectory)
            && fs.readdirSync(storyDirectory).length === 0
          ) {
            fs.rmdirSync(storyDirectory);
          }
          const interrupted = new GitControllerError(
            "STORY_REPOSITORY_PROVISION_INTERRUPTED_ROLLED_BACK",
            "Interrupted newly-created story repository was safely rolled back",
            { operationId: operation.operationId },
          );
          this.writeProvisionRecoveryAudit(operation, binding, {
            result: "FAIL",
            reason: interrupted.code,
            fencingToken: lease.fencingToken,
            details: { removed: removed.removed === true },
          });
          this.controller.journal.fail(operation, interrupted, {
            fencingToken: lease.fencingToken,
          });
          rolledBack += 1;
          continue;
        }
        throw new GitControllerError(
          "STORY_REPOSITORY_PROVISION_RECOVERY_REQUIRED",
          "Interrupted story provision target cannot be safely attributed or reconciled",
          {
            operationId: operation.operationId,
            targetExistedBefore: binding.targetExistedBefore,
            targetExists: !!inspected,
          },
        );
      } catch (rawError) {
        const error = asControllerError(
          rawError,
          "STORY_REPOSITORY_PROVISION_RECOVERY_REQUIRED",
        );
        if (reclaimed) {
          try {
            this.controller.journal.fail(operation, error, {
              fencingToken: lease?.fencingToken || null,
              recoveryRequired: true,
            });
          } catch {}
        }
        unresolved.push(error);
      } finally {
        lease?.release();
      }
    }
    if (unresolved.length) {
      throw new GitControllerError(
        "STORY_REPOSITORY_PROVISION_RECOVERY_BLOCKED",
        "One or more story provision operations require administrative recovery",
        { errors: unresolved.map((error) => error.code) },
      );
    }
    return {
      recovered: operations.length,
      rolledBack,
      safelyFailed,
      succeeded,
      commitRecovery,
    };
  }

  async provision({
    tabId,
    repositoryId,
    branch,
    exactSha,
    idempotencyKey: key,
    detached = false,
    primary = false,
    legacyMigration = null,
    actor = "controller:story-provision",
  } = {}) {
    const idempotencyKey = assertIdempotencyKey(key);
    const candidateSha = normalizeSha(exactSha, { label: "story repository exact SHA" });
    const { entry, branch: sourceBranch } = await this.controller.registry.resolve(
      repositoryId,
      branch,
    );
    const migrationRequest = legacyMigration && typeof legacyMigration === "object"
      ? {
          sourcePath: path.resolve(String(legacyMigration.sourcePath || "")),
          stateDigest: String(legacyMigration.stateDigest || "").trim().toLowerCase(),
        }
      : null;
    if (
      migrationRequest
      && (
        !path.isAbsolute(String(legacyMigration.sourcePath || ""))
        || !/^[0-9a-f]{64}$/.test(migrationRequest.stateDigest)
      )
    ) {
      throw new GitControllerError(
        "STORY_REPOSITORY_LEGACY_MIGRATION_REQUEST_INVALID",
        "Legacy migration requires an absolute Controller-inspected source and state digest",
      );
    }
    const workerIdentity = normalizedWorkerIdentity(
      this.workerIdentities[String(tabId || "")],
    );
    if (!workerIdentity) {
      throw new GitControllerError(
        "STORY_REPOSITORY_WORKER_IDENTITY_MISSING",
        "Protected Controller policy has no Worker identity for this story",
      );
    }
    assertTargetInsideRoot(this.storyRoot, tabId, entry.repositoryId);
    const registered = this.registryEntry(tabId, entry.repositoryId);
    if (registered && registered.baseRevision !== candidateSha) {
      throw new GitControllerError(
        "STORY_REPOSITORY_EXACT_SHA_CONFLICT",
        "Existing Controller story registry baseline differs from requested exact SHA",
      );
    }
    if (
      registered
      && registered.sourceRef !== `refs/heads/${sourceBranch}`
    ) {
      throw new GitControllerError(
        "STORY_REPOSITORY_SOURCE_REF_CONFLICT",
        "Existing Controller story retention is bound to a different source branch",
        {
          expectedSourceRef: registered.sourceRef,
          requestedSourceRef: `refs/heads/${sourceBranch}`,
        },
      );
    }
    const journalBranch = operationBinding("story_provision", [
      tabId,
      entry.repositoryId,
      sourceBranch,
      detached === true,
      primary === true,
      migrationRequest?.sourcePath || "",
      migrationRequest?.stateDigest || "",
    ]);
    const begun = this.controller.journal.begin({
      repositoryId: entry.repositoryId,
      operationType: PROVISION_OPERATION,
      commandId: "story.repository.provision",
      idempotencyKey,
      previewId: null,
      branch: journalBranch,
      expectedHead: null,
      candidateSha,
    });
    if (!begun.created) {
      return replay(begun.operation, { branch: journalBranch, candidateSha });
    }
    const operation = begun.operation;
    let lease = null;
    let createdRepository = null;
    let createdRollbackState = null;
    let legacyMigrationMutating = false;
    const startedAt = Date.now();
    try {
      lease = this.controller.leaseManager.acquire(entry, {
        operationId: operation.operationId,
        kind: "story-repository-provision",
      });
      lease.assertCurrent();
      await this.controller.registry.verify(entry.repositoryId);
      const currentRegistered = this.registryEntry(tabId, entry.repositoryId);
      if (
        currentRegistered
        && (
          currentRegistered.baseRevision !== candidateSha
          || currentRegistered.sourceRef !== `refs/heads/${sourceBranch}`
        )
      ) {
        throw new GitControllerError(
          "STORY_REPOSITORY_EXACT_SHA_CONFLICT",
          "Controller story registry changed before exact-SHA retention was acquired",
        );
      }
      let storyRetention = null;
      let accepted;
      if (currentRegistered) {
        storyRetention = await this.controller.mirror.ensureStoryBaseRetention(
          entry,
          currentRegistered,
          lease,
          { commandId: "story.provision-retention-existing" },
        );
        accepted = await this.controller.mirror.resolveRetainedStoryCandidate({
          repositoryId: entry.repositoryId,
          branch: sourceBranch,
          storyId: tabId,
          candidateSha,
        });
      } else {
        accepted = await this.controller.mirror.resolveAcceptedCandidate({
          repositoryId: entry.repositoryId,
          branch: sourceBranch,
          candidateSha,
        });
      }
      if (
        typeof this.controller.base?.candidateSubmodulePreflight !== "function"
      ) {
        throw new GitControllerError(
          "STORY_REPOSITORY_CANDIDATE_PREFLIGHT_UNAVAILABLE",
          "Story provision requires the Controller candidate content preflight",
        );
      }
      const candidateContentPreflight = candidateContentPreflightEvidence(
        await this.controller.base.candidateSubmodulePreflight(
          entry,
          candidateSha,
        ),
      );
      if (!candidateContentPreflight.eligible) {
        throw new GitControllerError(
          "STORY_REPOSITORY_CANDIDATE_CONTENT_BLOCKED",
          "Accepted story candidate contains unverified submodules or executable attributes",
          {
            blockerCode: candidateContentPreflight.blockerCode,
            status: candidateContentPreflight.status,
            reason: candidateContentPreflight.reason,
            submoduleCount: candidateContentPreflight.submoduleCount,
            verifiedCommitCount: candidateContentPreflight.verifiedCommitCount,
          },
        );
      }
      if (!storyRetention) {
        storyRetention = await this.controller.mirror.ensureStoryBaseRetention(
          entry,
          {
            storyId: String(tabId),
            repositoryId: entry.repositoryId,
            baseRevision: candidateSha,
            sourceRef: accepted.sourceRef,
          },
          lease,
          { commandId: "story.provision-retention-new" },
        );
      }
      lease.assertCurrent();
      const repositoryPath = assertTargetInsideRoot(
        this.storyRoot,
        tabId,
        entry.repositoryId,
      );
      const targetExistedBefore = fs.existsSync(repositoryPath);
      const provisionBranch = storyBranch(tabId, entry.repositoryId);
      this.controller.journal.append(operation, "STORY_PROVISION_CREATING", {
        storyId: String(tabId),
        repositoryId: entry.repositoryId,
        repositoryPath,
        sourceBranch,
        sourceRef: accepted.sourceRef,
        acceptedTipRevision: accepted.acceptedTipSha,
        mirrorGeneration: accepted.mirrorGeneration,
        candidateSha,
        workerIdentity,
        provisionBranch,
        detached: detached === true,
        primary: primary === true,
        targetExistedBefore,
        registryExistedBefore: !!currentRegistered,
        priorRegistryEntryGeneration: currentRegistered?.entryGeneration ?? null,
        priorRegistrySignature: currentRegistered
          ? storyRegistryEntrySignature(currentRegistered)
          : null,
        priorCreatedByProvisionOperationId:
          currentRegistered?.createdByProvisionOperationId ?? null,
        legacyMigration: migrationRequest,
        candidateContentPreflight,
        storyRetention,
      }, lease.fencingToken);
      if (typeof lease.gitChildGuard !== "function") {
        throw new GitControllerError(
          "GIT_CONTROLLER_MUTATION_LEASE_REQUIRED",
          "Story repository Git mutations require a child-tracking repository lease",
          {
            repositoryId: entry.repositoryId,
            storyId: String(tabId),
          },
        );
      }
      let repository = await createIndependentStoryRepository({
        root: this.storyRoot,
        storyId: tabId,
        accepted,
        branch: provisionBranch,
        detached: detached === true,
        leaseGuard: () => {
          lease.assertCurrent();
          return true;
        },
        gitChildGuard: (commandId) => lease.gitChildGuard(commandId),
        gitSpawnGuard: this.gitSpawnGuard,
        gitBinary: this.gitBinary,
        disabledHooksPath: this.disabledHooksPath,
      });
      if (repository.created === true) createdRepository = repository;
      createdRollbackState = captureProvisionRollbackState(
        this.gitBinary,
        this.disabledHooksPath,
        repository.repositoryPath,
        repository,
        this.gitSpawnGuard,
      );
      this.controller.journal.append(operation, "STORY_PROVISION_CREATED", {
        storyId: String(tabId),
        repositoryId: entry.repositoryId,
        repositoryPath: repository.repositoryPath,
        baseRevision: repository.baseRevision,
        headRevision: repository.headRevision,
        created: repository.created === true,
        reused: repository.reused === true,
        rollbackState: createdRollbackState,
      }, lease.fencingToken);
      let legacyMigrationResult = null;
      if (migrationRequest) {
        if (repository.reused === true || currentRegistered) {
          throw new GitControllerError(
            "STORY_REPOSITORY_LEGACY_MIGRATION_TARGET_EXISTS",
            "Legacy snapshot migration is only allowed while creating a new independent story repository",
          );
        }
        const inspectSource = () => this.inspectLegacyMigrationSource(
          entry,
          migrationRequest.sourcePath,
        );
        const sourceState = inspectSource();
        legacyMigrationMutating = true;
        legacyMigrationResult = applyLegacyWorktreeSnapshot({
          gitBinary: this.gitBinary,
          disabledHooksPath: this.disabledHooksPath,
          gitSpawnGuard: this.gitSpawnGuard,
          sourceState,
          targetPath: repository.repositoryPath,
          candidateSha,
          patchRoot: this.dataRoot,
          expectedStateDigest: migrationRequest.stateDigest,
          inspectSource,
        });
        const migratedRepository = await inspectIndependentStoryRepository(
          repository.repositoryPath,
          {
            storyId: tabId,
            repositoryId: entry.repositoryId,
            gitBinary: this.gitBinary,
            disabledHooksPath: this.disabledHooksPath,
            gitSpawnGuard: this.gitSpawnGuard,
          },
        );
        if (
          !migratedRepository
          || migratedRepository.baseRevision !== candidateSha
          || migratedRepository.headRevision !== candidateSha
        ) {
          throw new GitControllerError(
            "STORY_REPOSITORY_LEGACY_MIGRATION_BASELINE_DRIFT",
            "Legacy snapshot migration changed the independent repository baseline",
          );
        }
        repository = { ...migratedRepository, created: true, reused: false };
        createdRollbackState = captureProvisionRollbackState(
          this.gitBinary,
          this.disabledHooksPath,
          repository.repositoryPath,
          repository,
          this.gitSpawnGuard,
        );
        legacyMigrationMutating = false;
        this.controller.journal.append(operation, "STORY_PROVISION_LEGACY_MIGRATED", {
          storyId: String(tabId),
          repositoryId: entry.repositoryId,
          sourceHeadRevision: legacyMigrationResult.sourceHeadRevision,
          sourceBranch: legacyMigrationResult.sourceBranch,
          sourceStateDigest: legacyMigrationResult.sourceStateDigest,
          copiedFiles: legacyMigrationResult.copiedFiles,
          copiedBytes: legacyMigrationResult.copiedBytes,
          patchBytes: legacyMigrationResult.patchBytes,
          patchDigest: legacyMigrationResult.patchDigest,
          dirtyTrackedCount: legacyMigrationResult.dirtyTrackedCount,
          untrackedCount: legacyMigrationResult.untrackedCount,
          rollbackState: createdRollbackState,
        }, lease.fencingToken);
      }
      if (this.faultInjector) {
        await this.faultInjector("after-story-provision-created", {
          operation,
          repository,
          currentRegistered,
        });
      }
      if (repository.baseRevision !== candidateSha) {
        throw new GitControllerError(
          "STORY_REPOSITORY_EXACT_SHA_CONFLICT",
          "Existing independent story repository baseline differs from requested exact SHA",
          {
            requestedSha: candidateSha,
            existingSha: repository.baseRevision,
          },
        );
      }
      const acl = this.aclProtector({
        repositoryPath: repository.repositoryPath,
        workerIdentity,
        controllerIdentity: this.controllerIdentity,
        gatewayIdentities: this.gatewayIdentities,
        humanManagerIdentities: this.humanManagerIdentities,
        allWorkerIdentities: Object.values(this.workerIdentities),
        storyRoot: this.storyRoot,
      });
      createdRollbackState = captureProvisionRollbackState(
        this.gitBinary,
        this.disabledHooksPath,
        repository.repositoryPath,
        repository,
        this.gitSpawnGuard,
      );
      this.controller.journal.append(operation, "STORY_PROVISION_ACL_APPLIED", {
        storyId: String(tabId),
        repositoryId: entry.repositoryId,
        workerIdentity: acl.workerIdentity,
        aclFingerprint: acl.aclFingerprint,
        rollbackState: createdRollbackState,
      }, lease.fencingToken);
      lease.assertCurrent();
      const recorded = await this.recordRepository(repository, operation, acl, {
        primary,
        fencingToken: lease.fencingToken,
      });
      this.controller.journal.append(operation, "STORY_PROVISION_REGISTRY_RECORDED", {
        storyId: String(tabId),
        repositoryId: entry.repositoryId,
        registryGeneration: recorded.registryGeneration,
        entryGeneration: recorded.row.entryGeneration,
        workerProbeGeneration: recorded.probe.generation,
      }, lease.fencingToken);
      if (this.faultInjector) {
        await this.faultInjector("after-story-provision-registry-recorded", {
          operation,
          repository,
          recorded,
          currentRegistered,
        });
      }
      const result = {
        ok: true,
        resultCode: "PASS",
        operationId: operation.operationId,
        replayed: false,
        created: repository.created === true,
        reused: repository.reused === true,
        repository,
        registryGeneration: recorded.row.entryGeneration,
        workerIdentity: acl.workerIdentity,
        aclFingerprint: acl.aclFingerprint,
        workerProbeGeneration: recorded.probe.generation,
        storiesRequiringProbe: recorded.probe.storiesRequiringProbe,
        storyRetention,
        legacyMigration: legacyMigrationResult,
      };
      this.controller.audit.write({
        operation,
        commandId: "story.repository.provision",
        action: "story.repository.provision",
        branch: sourceBranch,
        candidateSha,
        result: "PASS",
        durationMs: Date.now() - startedAt,
        fencingToken: lease.fencingToken,
        actor,
        details: {
          storyId: tabId,
          created: result.created,
          legacyMigrated: !!legacyMigrationResult,
        },
      });
      this.controller.journal.succeed(operation, result, lease.fencingToken);
      return result;
    } catch (rawError) {
      let error = asControllerError(rawError);
      let recoveryRequired = error?.details?.recoveryRequired === true;
      if (createdRepository && !this.registryEntry(tabId, entry.repositoryId)) {
        try {
          if (!createdRollbackState) {
            throw new GitControllerError(
              "STORY_REPOSITORY_COMPENSATION_STATE_UNVERIFIED",
              "Story repository creation failed before rollback state was attested",
              { recoveryRequired: true },
            );
          }
          const current = await inspectIndependentStoryRepository(
            createdRepository.repositoryPath,
            {
              storyId: tabId,
              repositoryId: entry.repositoryId,
              gitBinary: this.gitBinary,
              disabledHooksPath: this.disabledHooksPath,
              gitSpawnGuard: this.gitSpawnGuard,
            },
          );
          if (!current) {
            throw new GitControllerError(
              "STORY_REPOSITORY_COMPENSATION_STATE_UNVERIFIED",
              "Newly-created story repository disappeared before compensation",
              { recoveryRequired: true },
            );
          }
          const currentState = captureProvisionRollbackState(
            this.gitBinary,
            this.disabledHooksPath,
            current.repositoryPath,
            current,
            this.gitSpawnGuard,
          );
          if (
            legacyMigrationMutating
            && current.baseRevision === candidateSha
            && current.headRevision === candidateSha
            && current.sourceRef === `refs/heads/${sourceBranch}`
            && current.branch === (detached === true ? "" : storyBranch(tabId, entry.repositoryId))
          ) {
            // The Controller may fail after it has applied part or all of the legacy
            // snapshot but before the migrated rollback phase is journaled. The target
            // is still a newly-created, leased Controller leaf with the exact baseline;
            // attest its current contents so compensation can remove only that leaf.
            createdRollbackState = currentState;
          }
          if (currentState.signature !== createdRollbackState.signature) {
            throw new GitControllerError(
              "STORY_REPOSITORY_COMPENSATION_STATE_DRIFT",
              "Story repository changed after creation and cannot be deleted by compensation",
              {
                expectedSignature: createdRollbackState.signature,
                actualSignature: currentState.signature,
                recoveryRequired: true,
              },
            );
          }
          await rollbackCreatedIndependentStoryRepository(createdRepository, {
            gitBinary: this.gitBinary,
            disabledHooksPath: this.disabledHooksPath,
            gitSpawnGuard: this.gitSpawnGuard,
          });
          createdRepository = null;
        } catch (rollbackError) {
          recoveryRequired = true;
          error = asControllerError(
            rollbackError,
            "STORY_REPOSITORY_COMPENSATION_STATE_UNVERIFIED",
          );
        }
      } else if (createdRepository) {
        // A pre-existing registry row can describe an active story whose
        // physical repository is being rebuilt from its retained exact SHA.
        // Never delete such a repository in the generic catch path: startup
        // recovery must distinguish pre-record rollback from post-record
        // completion using the durable prior-row binding.
        recoveryRequired = true;
      }
      try {
        const orphan = await inspectIndependentStoryRepository(
          assertTargetInsideRoot(this.storyRoot, tabId, entry.repositoryId),
          {
            storyId: tabId,
            repositoryId: entry.repositoryId,
            gitBinary: this.gitBinary,
            disabledHooksPath: this.disabledHooksPath,
            gitSpawnGuard: this.gitSpawnGuard,
          },
        );
        recoveryRequired = recoveryRequired
          || (!!orphan && !this.registryEntry(tabId, entry.repositoryId));
      } catch {
        recoveryRequired = true;
      }
      this.controller.journal.fail(operation, error, {
        fencingToken: lease?.fencingToken || null,
        recoveryRequired,
      });
      throw error;
    } finally {
      lease?.release();
    }
  }

  async inspectRetireState(tabId, repositoryId, {
    persistObservedHead = false,
  } = {}) {
    const entry = this.controller.registry.get(repositoryId);
    let registered = this.registryEntry(tabId, entry.repositoryId);
    if (!registered) {
      throw new GitControllerError(
        "STORY_REPOSITORY_NOT_REGISTERED",
        "Controller story repository is not registered",
      );
    }
    const expectedPath = assertTargetInsideRoot(this.storyRoot, tabId, entry.repositoryId);
    if (path.resolve(registered.repositoryPath) !== expectedPath) {
      throw new GitControllerError(
        "STORY_REPOSITORY_REGISTRY_PATH_DRIFT",
        "Controller story registry path is not the canonical owned leaf",
      );
    }
    const inspectionErrors = [];
    let inspected = null;
    try {
      inspected = await inspectIndependentStoryRepository(expectedPath, {
        storyId: tabId,
        repositoryId: entry.repositoryId,
        gitBinary: this.gitBinary,
        disabledHooksPath: this.disabledHooksPath,
        gitSpawnGuard: this.gitSpawnGuard,
      });
    } catch (error) {
      inspectionErrors.push(String(error?.code || "STORY_REPOSITORY_INSPECTION_FAILED"));
    }
    if (inspected) {
      try {
        const acl = this.aclAttestor({
          repositoryPath: registered.repositoryPath,
          workerIdentity: registered.workerIdentity,
          controllerIdentity: this.controllerIdentity,
          gatewayIdentities: this.gatewayIdentities,
          humanManagerIdentities: this.humanManagerIdentities,
          allWorkerIdentities: Object.values(this.workerIdentities),
          storyRoot: this.storyRoot,
        });
        if (acl.aclFingerprint !== registered.aclFingerprint) {
          throw new GitControllerError(
            "STORY_REPOSITORY_WORKER_ACL_DRIFT",
            "Live story ACL differs from the registered fingerprint",
          );
        }
      } catch (error) {
        inspectionErrors.push(String(error?.code || "STORY_REPOSITORY_WORKER_ACL_DRIFT"));
      }
    }
    if (
      persistObservedHead
      && inspected
      && registered.headRevision !== inspected.headRevision
    ) {
      await this.mutateRegistryTopology((registry) => {
        const row = registry.entries.find((candidate) => (
          candidate.storyId === String(tabId)
          && candidate.repositoryId === entry.repositoryId
        ));
        if (
          !row
          || row.entryGeneration !== registered.entryGeneration
          || row.repositoryPath !== registered.repositoryPath
        ) {
          throw new GitControllerError(
            "STORY_REPOSITORY_RETIRE_STALE",
            "Story repository registry changed while observing current HEAD",
          );
        }
        row.headRevision = inspected.headRevision;
        row.branch = inspected.branch;
        row.detached = inspected.detached;
        row.entryGeneration += 1;
        row.updatedAt = Date.now();
        return registry;
      }, {
        reason: "story-retire-head-observation",
      });
      registered = this.registryEntry(tabId, entry.repositoryId);
    }
    const dirtyFiles = [];
    const stashOids = [];
    let localRefs = [];
    let reflogOids = [];
    let unreachableObjects = [];
    let unpushedCount = 0;
    let contentDigest = null;
    if (inspected) {
      try {
        dirtyFiles.push(...textLines(storyGit(this.gitBinary, this.disabledHooksPath, expectedPath, [
          "status", "--porcelain=v1", "-uall",
        ], this.gitSpawnGuard)).slice(0, 200));
      } catch (error) {
        inspectionErrors.push(String(error?.code || "STORY_REPOSITORY_STATUS_FAILED"));
      }
      try {
        stashOids.push(...textLines(storyGit(this.gitBinary, this.disabledHooksPath, expectedPath, [
          "stash", "list", "--format=%H",
        ], this.gitSpawnGuard)));
      } catch (error) {
        inspectionErrors.push(String(error?.code || "STORY_REPOSITORY_STASH_FAILED"));
      }
      try {
        const hidden = inspectHiddenGitState(
          this.gitBinary,
          this.disabledHooksPath,
          expectedPath,
          registered,
          inspected,
          this.gitSpawnGuard,
        );
        localRefs = hidden.localRefs;
        reflogOids = hidden.reflogOids;
        unreachableObjects = hidden.unreachableObjects;
        unpushedCount = hidden.unpushedCount;
      } catch (error) {
        unpushedCount = null;
        inspectionErrors.push(String(error?.code || "STORY_REPOSITORY_HIDDEN_STATE_FAILED"));
      }
      try {
        contentDigest = worktreeContentDigest(expectedPath);
      } catch (error) {
        inspectionErrors.push(String(error?.code || "STORY_REPOSITORY_CONTENT_DIGEST_FAILED"));
      }
    }
    const blockers = [
      ...(dirtyFiles.length ? [{
        type: "dirty",
        count: dirtyFiles.length,
        message: `${dirtyFiles.length} uncommitted or untracked files`,
      }] : []),
      ...(stashOids.length ? [{
        type: "stash",
        count: stashOids.length,
        message: `${stashOids.length} stashes`,
      }] : []),
      ...(Number(unpushedCount) > 0 ? [{
        type: "unpushed",
        count: unpushedCount,
        message: `${unpushedCount} commits outside the exact story baseline reachability`,
      }] : []),
      ...(localRefs.length ? [{
        type: "local-refs",
        count: localRefs.length,
        message: `${localRefs.length} additional local refs`,
      }] : []),
      ...(unreachableObjects.length ? [{
        type: "unreachable",
        count: unreachableObjects.length,
        message: `${unreachableObjects.length} unreachable Git objects`,
      }] : []),
      ...inspectionErrors.map((code) => ({
        type: "inspection",
        count: 1,
        message: code,
      })),
    ];
    const state = {
      storyId: String(tabId),
      repositoryId: entry.repositoryId,
      repositoryPath: registered.repositoryPath,
      exists: !!inspected,
      baseRevision: registered.baseRevision,
      headRevision: inspected?.headRevision || registered.headRevision,
      branch: inspected?.branch ?? registered.branch,
      detached: inspected?.detached ?? registered.detached,
      entryGeneration: registered.entryGeneration,
      workerIdentity: registered.workerIdentity,
      aclFingerprint: registered.aclFingerprint,
      worktreeContentDigest: contentDigest,
      dirtyFiles,
      dirtyCount: dirtyFiles.length,
      stashOids,
      stashCount: stashOids.length,
      localRefs,
      localRefCount: localRefs.length,
      reflogOids,
      unreachableObjects,
      unreachableObjectCount: unreachableObjects.length,
      unpushedCount,
      inspectionErrors,
      blockers,
      safe: blockers.length === 0,
      forceAllowed: inspectionErrors.length === 0,
    };
    return {
      ...state,
      stateSignature: retireStateSignature(state),
    };
  }

  async retirePreview({
    tabId,
    repositoryId,
    ttlMs,
  } = {}) {
    const state = await this.inspectRetireState(tabId, repositoryId, {
      persistObservedHead: true,
    });
    const entry = this.controller.registry.get(repositoryId);
    const now = Date.now();
    const stored = this.controller.journal.persistence.createGitControllerPreview({
      previewId: randomUUID(),
      repositoryId: entry.repositoryId,
      kind: RETIRE_PREVIEW_KIND,
      branch: operationBinding("story_retire", [tabId, entry.repositoryId]),
      expectedHead: state.headRevision,
      baseRevision: state.baseRevision,
      candidateSha: state.baseRevision,
      mirrorGeneration: state.entryGeneration,
      relationship: state.safe ? "SAFE" : "RISK_PRESENT",
      eligible: state.safe,
      blockerCode: state.safe ? null : "STORY_REPOSITORY_RETIRE_RISK",
      remoteFingerprint: entry.remoteFingerprint,
      payload: {
        storyId: String(tabId),
        repositoryPath: state.repositoryPath,
        entryGeneration: state.entryGeneration,
        stateSignature: state.stateSignature,
        forceAllowed: state.forceAllowed,
        exists: state.exists,
      },
      createdAt: now,
      expiresAt: now + Math.max(10_000, Number(ttlMs) || RETIRE_PREVIEW_TTL_MS),
    });
    return {
      previewId: stored.previewId,
      previewVersion: stored.previewVersion,
      expiresAt: stored.expiresAt,
      ...state,
    };
  }

  async inspectQuarantinedContent(repositoryPath, registered) {
    const inspected = await inspectIndependentStoryRepository(repositoryPath, {
      storyId: registered.storyId,
      repositoryId: registered.repositoryId,
      gitBinary: this.gitBinary,
      disabledHooksPath: this.disabledHooksPath,
      gitSpawnGuard: this.gitSpawnGuard,
    });
    if (!inspected) {
      throw new GitControllerError(
        "STORY_REPOSITORY_QUARANTINE_MISSING",
        "Quarantined story repository is missing",
      );
    }
    const dirtyFiles = textLines(storyGit(
      this.gitBinary,
      this.disabledHooksPath,
      repositoryPath,
      ["status", "--porcelain=v1", "-uall"],
      this.gitSpawnGuard,
    ));
    const stashOids = textLines(storyGit(
      this.gitBinary,
      this.disabledHooksPath,
      repositoryPath,
      ["stash", "list", "--format=%H"],
      this.gitSpawnGuard,
    ));
    const hidden = inspectHiddenGitState(
      this.gitBinary,
      this.disabledHooksPath,
      repositoryPath,
      registered,
      inspected,
      this.gitSpawnGuard,
    );
    return {
      ...inspected,
      dirtyFiles,
      stashOids,
      localRefs: hidden.localRefs,
      reflogOids: hidden.reflogOids,
      unreachableObjects: hidden.unreachableObjects,
      unpushedCount: hidden.unpushedCount,
      worktreeContentDigest: worktreeContentDigest(repositoryPath),
    };
  }

  writeQuarantineManifest(operation, registered, state, quarantinePath) {
    const manifestPath = path.join(this.quarantineRoot, `${operation.operationId}.json`);
    const manifest = {
      version: 1,
      operationId: operation.operationId,
      operationType: operation.operationType,
      previewId: operation.previewId || null,
      storyId: registered.storyId,
      repositoryId: registered.repositoryId,
      originalPath: registered.repositoryPath,
      quarantinePath,
      originalExisted: state.exists !== false,
      expectedContentSignature: retireContentSignature(state),
      expectedStateSignature: state.stateSignature || null,
      expectedHead: state.headRevision,
      baseRevision: registered.baseRevision,
      entryGeneration: registered.entryGeneration,
      provisionOperationId: registered.createdByProvisionOperationId || null,
      createdAt: Date.now(),
    };
    const fd = fs.openSync(manifestPath, "wx", 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(manifest)}\n`, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fsyncControllerDirectory(this.quarantineRoot);
    return { manifest, manifestPath };
  }

  writeMissingRemovalTombstone(operation, registered, state, lease) {
    const quarantinePath = path.join(
      this.quarantineRoot,
      `${operation.operationId}-${createHash("sha256")
        .update(registered.repositoryId)
        .digest("hex")
        .slice(0, 16)}`,
    );
    const { manifest, manifestPath } = this.writeQuarantineManifest(
      operation,
      registered,
      state,
      quarantinePath,
    );
    this.controller.journal.append(operation, "STORY_RETIRE_QUARANTINING", {
      manifest: path.basename(manifestPath),
      expectedHead: state.headRevision,
      expectedContentSignature: manifest.expectedContentSignature,
      originalExisted: false,
    }, lease.fencingToken);
    return {
      removed: false,
      alreadyMissing: true,
      quarantinePath,
      manifestPath,
    };
  }

  async quarantineAndDelete(operation, registered, state, lease) {
    const quarantinePath = path.join(
      this.quarantineRoot,
      `${operation.operationId}-${createHash("sha256")
        .update(registered.repositoryId)
        .digest("hex")
        .slice(0, 16)}`,
    );
    const { manifest, manifestPath } = this.writeQuarantineManifest(
      operation,
      registered,
      state,
      quarantinePath,
    );
    this.controller.journal.append(operation, "STORY_RETIRE_QUARANTINING", {
      manifest: path.basename(manifestPath),
      expectedHead: state.headRevision,
      expectedContentSignature: manifest.expectedContentSignature,
    }, lease.fencingToken);
    this.repositoryQuarantineRevoker(
      registered.repositoryPath,
      this.controllerIdentity,
    );
    lease.assertCurrent();
    fs.renameSync(registered.repositoryPath, quarantinePath);
    fsyncControllerDirectory(path.dirname(registered.repositoryPath));
    fsyncControllerDirectory(this.quarantineRoot);
    this.controller.journal.append(operation, "STORY_RETIRE_QUARANTINED", {
      manifest: path.basename(manifestPath),
      expectedHead: state.headRevision,
    }, lease.fencingToken);
    if (this.faultInjector) {
      await this.faultInjector("after-story-quarantine-rename", {
        operation,
        registered,
        quarantinePath,
        manifestPath,
      });
    }
    const quarantined = await this.inspectQuarantinedContent(quarantinePath, registered);
    if (retireContentSignature(quarantined) !== manifest.expectedContentSignature) {
      throw new GitControllerError(
        "STORY_REPOSITORY_QUARANTINE_DRIFT",
        "Story repository changed while it was being quarantined",
      );
    }
    fs.rmSync(quarantinePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    fsyncControllerDirectory(this.quarantineRoot);
    return { removed: true, quarantinePath, manifestPath };
  }

  validateQuarantineManifest(name, manifest, operation) {
    const expectedOriginal = assertTargetInsideRoot(
      this.storyRoot,
      manifest?.storyId,
      manifest?.repositoryId,
    );
    const quarantinePath = path.resolve(String(manifest?.quarantinePath || ""));
    const operationType = String(operation?.operationType || "");
    if (
      manifest?.version !== 1
      || name !== `${manifest.operationId}.json`
      || !operation
      || ![RETIRE_OPERATION, CLEANUP_OPERATION].includes(operationType)
      || !["RUNNING", "RECOVERY_REQUIRED", "SUCCEEDED"].includes(operation.status)
      || operation.operationId !== manifest.operationId
      || operation.repositoryId !== manifest.repositoryId
      || (
        manifest.operationType
        && manifest.operationType !== operationType
      )
      || (
        manifest.previewId != null
        && manifest.previewId !== (operation.previewId || null)
      )
      || operation.expectedHead !== manifest.expectedHead
      || operation.candidateSha !== manifest.baseRevision
      || (
        manifest.originalExisted !== undefined
        && typeof manifest.originalExisted !== "boolean"
      )
      || !/^[A-Za-z0-9._-]{1,200}$/.test(String(manifest.operationId || ""))
      || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(String(manifest.expectedHead || ""))
      || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(String(manifest.baseRevision || ""))
      || !/^[0-9a-f]{64}$/.test(String(manifest.expectedContentSignature || ""))
      || (
        manifest.expectedStateSignature != null
        && !/^[0-9a-f]{64}$/.test(String(manifest.expectedStateSignature))
      )
      || !Number.isSafeInteger(Number(manifest.entryGeneration))
      || Number(manifest.entryGeneration) < 1
      || path.resolve(manifest.originalPath) !== expectedOriginal
      || path.dirname(quarantinePath) !== this.quarantineRoot
      || !path.basename(quarantinePath).startsWith(`${manifest.operationId}-`)
    ) {
      throw new GitControllerError(
        "STORY_REPOSITORY_QUARANTINE_MANIFEST_INVALID",
        "Story quarantine recovery manifest is not exactly bound to its durable operation",
      );
    }
    if (operationType === RETIRE_OPERATION) {
      const quarantineCheckpoint = this.controller.journal.persistence
        .listGitControllerJournal(operation.operationId)
        .find((row) => (
          row.phase === "STORY_RETIRE_QUARANTINING"
          && row.data?.manifest === name
          && row.data?.expectedContentSignature
            === manifest.expectedContentSignature
        ));
      const preview = this.controller.journal.persistence.getGitControllerPreview(
        operation.previewId,
      );
      if (
        !preview
        || preview.kind !== RETIRE_PREVIEW_KIND
        || preview.repositoryId !== manifest.repositoryId
        || preview.expectedHead !== manifest.expectedHead
        || preview.candidateSha !== manifest.baseRevision
        || preview.payload?.storyId !== String(manifest.storyId)
        || path.resolve(preview.payload?.repositoryPath || "") !== expectedOriginal
        || Number(preview.payload?.entryGeneration) !== Number(manifest.entryGeneration)
        || (
          manifest.expectedStateSignature
            ? preview.payload?.stateSignature !== manifest.expectedStateSignature
            : !quarantineCheckpoint
        )
      ) {
        throw new GitControllerError(
          "STORY_REPOSITORY_QUARANTINE_PREVIEW_BINDING_INVALID",
          "Story retire quarantine manifest does not match its consumed exact-state preview",
        );
      }
    } else {
      const provisionOperationId = String(manifest.provisionOperationId || "");
      const provisionOperation = this.controller.journal.persistence
        .getGitControllerOperation(provisionOperationId);
      const expectedBranch = operationBinding("story_cleanup", [
        manifest.storyId,
        manifest.repositoryId,
        provisionOperationId,
        manifest.baseRevision,
        manifest.expectedHead,
        manifest.entryGeneration,
      ]);
      if (
        !provisionOperationId
        || !provisionOperation
        || provisionOperation.operationType !== PROVISION_OPERATION
        || operation.branch !== expectedBranch
      ) {
        throw new GitControllerError(
          "STORY_REPOSITORY_CLEANUP_RECOVERY_BINDING_INVALID",
          "Story cleanup quarantine is not bound to its exact provision operation",
        );
      }
      this.provisionRollbackState(provisionOperation);
    }
    return {
      ...manifest,
      operationType,
      originalExisted: manifest.originalExisted !== false,
      expectedOriginal,
      quarantinePath,
    };
  }

  writeRemovalRecoveryAudit(operation, manifest, fencingToken) {
    const action = operation.operationType === CLEANUP_OPERATION
      ? "story.repository.cleanup"
      : "story.repository.retire";
    const existing = this.controller.journal.persistence.listGitControllerAudit({
      operationId: operation.operationId,
    }).some((row) => row.action === action && row.result === "PASS");
    if (existing) return;
    const row = {
      auditId: randomUUID(),
      operationId: operation.operationId,
      repositoryId: operation.repositoryId,
      commandId: action,
      action,
      branch: operation.operationType === CLEANUP_OPERATION
        ? "__story_cleanup__"
        : null,
      beforeSha: manifest.expectedHead,
      candidateSha: manifest.baseRevision,
      result: "PASS",
      reason: "startup-recovery",
      durationMs: Math.max(0, Date.now() - Number(operation.startedAt || 0)),
      fencingToken,
      actor: "controller:story-removal-recovery",
      details: {
        storyId: String(manifest.storyId),
        removed: manifest.originalExisted !== false,
        alreadyMissing: manifest.originalExisted === false,
        recovered: true,
        operationType: operation.operationType,
      },
      createdAt: Date.now(),
    };
    if (
      typeof this.controller.journal.persistence.appendGitControllerAuditOnce
        === "function"
    ) {
      const appended = this.controller.journal.persistence
        .appendGitControllerAuditOnce(row);
      if (!appended?.ok) {
        throw new GitControllerError(
          "STORY_REPOSITORY_QUARANTINE_RECOVERY_AUDIT_FAILED",
          "Recovered story removal PASS audit could not be persisted",
          { operationId: operation.operationId, reason: appended?.reason },
        );
      }
      return;
    }
    this.controller.audit.write({
      operation,
      commandId: row.commandId,
      action: row.action,
      branch: row.branch,
      beforeSha: row.beforeSha,
      candidateSha: row.candidateSha,
      result: row.result,
      reason: row.reason,
      durationMs: row.durationMs,
      fencingToken,
      actor: row.actor,
      details: row.details,
    });
  }

  async closeUnmanifestedRemovalOperations(manifestOperationIds) {
    const operations = [
      ...listAllRecoverableOperations(
        this.controller.journal.persistence,
        { operationType: RETIRE_OPERATION },
      ),
      ...listAllRecoverableOperations(
        this.controller.journal.persistence,
        { operationType: CLEANUP_OPERATION },
      ),
    ].filter((operation) => !manifestOperationIds.has(operation.operationId));
    const failures = [];
    let safelyFailed = 0;
    for (const operation of operations) {
      let reclaimed = false;
      let lease = null;
      try {
        const entry = this.controller.registry.get(operation.repositoryId);
        this.controller.leaseManager.reclaimOrphanedOperation(entry, operation);
        reclaimed = true;
        lease = this.controller.leaseManager.acquire(entry, {
          operationId: operation.operationId,
          kind: "story-removal-recovery",
        });
        lease.assertCurrent();
        const phases = this.controller.journal.persistence
          .listGitControllerJournal(operation.operationId)
          .map((row) => row.phase);
        if (
          operation.status === "RUNNING"
          && operation.phase === "PREVIEWED"
          && phases.every((phase) => phase === "PREVIEWED")
        ) {
          this.controller.journal.fail(operation, new GitControllerError(
            "STORY_REPOSITORY_REMOVAL_INTERRUPTED_BEFORE_QUARANTINE",
            "Interrupted story removal was safely closed before quarantine publication",
          ), { fencingToken: lease.fencingToken });
          safelyFailed += 1;
          continue;
        }
        throw new GitControllerError(
          "STORY_REPOSITORY_QUARANTINE_MANIFEST_MISSING",
          "Recoverable story removal has no durable quarantine manifest",
          {
            recoveryRequired: true,
            operationId: operation.operationId,
            operationType: operation.operationType,
            phases,
          },
        );
      } catch (rawError) {
        const error = asControllerError(
          rawError,
          "STORY_REPOSITORY_QUARANTINE_RECOVERY_FAILED",
        );
        if (reclaimed) {
          try {
            this.controller.journal.fail(operation, error, {
              fencingToken: lease?.fencingToken || null,
              recoveryRequired: true,
            });
          } catch {}
        }
        failures.push(error);
      } finally {
        lease?.release();
      }
    }
    return { operations, safelyFailed, failures };
  }

  async recoverQuarantines() {
    const manifests = fs.readdirSync(this.quarantineRoot)
      .filter((name) => /^[A-Za-z0-9._-]{1,200}\.json$/.test(name));
    const manifestOperationIds = new Set(
      manifests.map((name) => name.slice(0, -".json".length)),
    );
    const missing = await this.closeUnmanifestedRemovalOperations(
      manifestOperationIds,
    );
    const failures = [...missing.failures];
    let recovered = 0;
    for (const name of manifests) {
      const manifestPath = path.join(this.quarantineRoot, name);
      let operation = null;
      let lease = null;
      let reclaimed = false;
      try {
        const rawManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        operation = this.controller.journal.persistence.getGitControllerOperation(
          rawManifest.operationId,
        );
        const entry = operation
          ? this.controller.registry.get(operation.repositoryId)
          : null;
        if (entry) {
          this.controller.leaseManager.reclaimOrphanedOperation(
            entry,
            operation,
          );
          reclaimed = true;
          lease = this.controller.leaseManager.acquire(entry, {
            operationId: operation.operationId,
            kind: operation.operationType === CLEANUP_OPERATION
              ? "story-cleanup-recovery"
              : "story-retire-recovery",
          });
          lease.assertCurrent();
        }
        const manifest = this.validateQuarantineManifest(
          name,
          rawManifest,
          operation,
        );
        const registered = this.registryEntry(
          manifest.storyId,
          manifest.repositoryId,
        );
        if (
          registered
          && (
            registered.repositoryPath !== manifest.expectedOriginal
            || registered.entryGeneration !== Number(manifest.entryGeneration)
            || registered.headRevision !== manifest.expectedHead
            || registered.baseRevision !== manifest.baseRevision
            || (
              operation.operationType === CLEANUP_OPERATION
              && registered.createdByProvisionOperationId
                !== String(manifest.provisionOperationId || "")
            )
          )
        ) {
          throw new GitControllerError(
            "STORY_REPOSITORY_QUARANTINE_REGISTRY_DRIFT",
            "Story registry changed while quarantine recovery was pending",
          );
        }
        const originalExists = fs.existsSync(manifest.expectedOriginal);
        const quarantineExists = fs.existsSync(manifest.quarantinePath);
        if (originalExists && quarantineExists) {
          throw new GitControllerError(
            "STORY_REPOSITORY_QUARANTINE_CONFLICT",
            "Both original and quarantined story repositories exist",
          );
        }
        if (originalExists) {
          this.repositoryQuarantineRevoker(
            manifest.expectedOriginal,
            this.controllerIdentity,
          );
          lease.assertCurrent();
          fs.renameSync(manifest.expectedOriginal, manifest.quarantinePath);
          fsyncControllerDirectory(path.dirname(manifest.expectedOriginal));
          fsyncControllerDirectory(this.quarantineRoot);
        }
        if (fs.existsSync(manifest.quarantinePath)) {
          const binding = registered || {
            storyId: String(manifest.storyId),
            repositoryId: String(manifest.repositoryId),
            baseRevision: manifest.baseRevision,
          };
          const inspected = await this.inspectQuarantinedContent(
            manifest.quarantinePath,
            binding,
          );
          if (
            inspected.headRevision !== manifest.expectedHead
            || retireContentSignature(inspected)
              !== manifest.expectedContentSignature
          ) {
            throw new GitControllerError(
              "STORY_REPOSITORY_QUARANTINE_DRIFT",
              "Quarantined story repository changed before recovery",
            );
          }
          fs.rmSync(manifest.quarantinePath, {
            recursive: true,
            force: true,
            maxRetries: 3,
            retryDelay: 100,
          });
          fsyncControllerDirectory(this.quarantineRoot);
        }
        let recoveryProbe = null;
        if (registered) {
          const mutation = await this.mutateRegistryTopology((registry) => {
            registry.entries = registry.entries.filter((row) => !(
              row.storyId === String(manifest.storyId)
              && row.repositoryId === String(manifest.repositoryId)
              && row.repositoryPath === manifest.expectedOriginal
              && row.entryGeneration === Number(manifest.entryGeneration)
            ));
            return registry;
          }, {
            operation: operation.status === "SUCCEEDED" ? null : operation,
            fencingToken: lease.fencingToken,
            reason: operation.operationType === CLEANUP_OPERATION
              ? "story-cleanup-recovery"
              : "story-retire-recovery",
          });
          recoveryProbe = mutation.probe;
        }
        const retentionRegistry = this.readRegistry();
        const storyRetentions =
          await this.controller.mirror.reconcileStoryBaseRetentions(
            entry,
            lease,
            retentionRegistry.entries,
          );
        const currentProbe = this.workerProbeEnabled
          ? this.readWorkerProbeConfig({ allowMissing: true })
          : null;
        const result = {
          ok: true,
          operationId: operation.operationId,
          replayed: false,
          recovered: true,
          resultCode: "PASS",
          removed: manifest.originalExisted !== false,
          alreadyMissing: manifest.originalExisted === false,
          repositoryId: manifest.repositoryId,
          storyId: String(manifest.storyId),
          repositoryPath: manifest.expectedOriginal,
          workerProbeGeneration: recoveryProbe?.generation
            ?? currentProbe?.generation
            ?? this.readRegistry().generation,
          storiesRequiringProbe: recoveryProbe?.storiesRequiringProbe || [],
          storyRetentions,
        };
        this.writeRemovalRecoveryAudit(
          operation,
          manifest,
          lease.fencingToken,
        );
        if (operation.status !== "SUCCEEDED") {
          this.controller.journal.succeed(
            operation,
            result,
            lease.fencingToken,
          );
        }
        fs.rmSync(manifestPath, { force: true });
        fsyncControllerDirectory(this.quarantineRoot);
        const storyDirectory = path.dirname(manifest.expectedOriginal);
        if (
          path.dirname(storyDirectory) === this.storyRoot
          && fs.existsSync(storyDirectory)
          && fs.readdirSync(storyDirectory).length === 0
        ) {
          fs.rmdirSync(storyDirectory);
          fsyncControllerDirectory(this.storyRoot);
        }
        recovered += 1;
      } catch (rawError) {
        const error = asControllerError(
          rawError,
          "STORY_REPOSITORY_QUARANTINE_RECOVERY_FAILED",
        );
        if (
          reclaimed
          && operation
          && operation.status !== "SUCCEEDED"
        ) {
          try {
            this.controller.journal.fail(operation, error, {
              fencingToken: lease?.fencingToken || null,
              recoveryRequired: true,
            });
          } catch {}
        }
        failures.push(error);
      } finally {
        lease?.release();
      }
    }
    if (failures.length) {
      throw new GitControllerError(
        "STORY_REPOSITORY_QUARANTINE_RECOVERY_BLOCKED",
        "One or more story repository quarantines require administrative recovery",
        { errors: failures.map((error) => error.code) },
      );
    }
    return {
      recovered,
      safelyFailed: missing.safelyFailed,
      scannedOperations: missing.operations.length,
    };
  }

  async retire({
    tabId,
    repositoryId,
    previewId,
    previewVersion,
    expectedHead,
    registryGeneration,
    force = false,
    idempotencyKey: key,
    actor = "controller:story-retire",
  } = {}) {
    const idempotencyKey = assertIdempotencyKey(key);
    const entry = this.controller.registry.get(repositoryId);
    const normalizedHead = normalizeSha(expectedHead, {
      label: "story retire expected HEAD",
    });
    const journalBranch = operationBinding("story_retire", [
      tabId,
      entry.repositoryId,
      previewId,
      previewVersion,
      registryGeneration,
      force === true,
    ]);
    const existingOperation = this.controller.journal.persistence
      .getGitControllerOperationByIdempotency?.(
        entry.repositoryId,
        RETIRE_OPERATION,
        idempotencyKey,
      );
    if (existingOperation) {
      return replay(existingOperation, {
        branch: journalBranch,
        expectedHead: normalizedHead,
        previewId,
      });
    }
    const preview = this.controller.journal.persistence.getGitControllerPreview(previewId);
    if (
      !preview
      || preview.kind !== RETIRE_PREVIEW_KIND
      || preview.repositoryId !== entry.repositoryId
      || preview.payload?.storyId !== String(tabId)
      || preview.expectedHead !== normalizedHead
      || Number(preview.mirrorGeneration) !== Number(registryGeneration)
    ) {
      throw new GitControllerError(
        "STORY_REPOSITORY_RETIRE_PREVIEW_MISMATCH",
        "Story retire preview does not match the exact registered repository state",
      );
    }
    if (
      preview.status !== "ACTIVE"
      || preview.expiresAt <= Date.now()
      || Number(preview.previewVersion) !== Number(previewVersion)
    ) {
      throw new GitControllerError(
        "STORY_REPOSITORY_RETIRE_PREVIEW_EXPIRED",
        "Story retire preview is expired or already consumed",
      );
    }
    if (!force && preview.eligible !== true) {
      throw new GitControllerError(
        "STORY_REPOSITORY_RETIRE_RISK",
        "Story repository contains local state; explicit force confirmation is required",
      );
    }
    if (force && preview.payload?.forceAllowed !== true) {
      throw new GitControllerError(
        "STORY_REPOSITORY_RETIRE_FORCE_BLOCKED",
        "Story repository ownership or inspection could not be proven",
      );
    }
    const begun = this.controller.journal.begin({
      repositoryId: entry.repositoryId,
      operationType: RETIRE_OPERATION,
      commandId: "story.repository.retire",
      idempotencyKey,
      previewId,
      branch: journalBranch,
      expectedHead: normalizedHead,
      candidateSha: preview.candidateSha,
    });
    if (!begun.created) {
      return replay(begun.operation, {
        branch: journalBranch,
        candidateSha: preview.candidateSha,
        expectedHead: normalizedHead,
        previewId,
      });
    }
    const operation = begun.operation;
    const consumed = this.controller.journal.persistence.consumeGitControllerPreview(
      previewId,
      operation.operationId,
    );
    if (!consumed.ok) {
      const error = new GitControllerError(
        "STORY_REPOSITORY_RETIRE_PREVIEW_CONSUMED",
        "Story retire preview was already consumed or expired",
      );
      this.controller.journal.fail(operation, error);
      throw error;
    }
    let lease = null;
    const startedAt = Date.now();
    try {
      lease = this.controller.leaseManager.acquire(entry, {
        operationId: operation.operationId,
        kind: "story-repository-retire",
      });
      lease.assertCurrent();
      const registered = this.registryEntry(tabId, entry.repositoryId);
      if (
        !registered
        || registered.repositoryPath !== preview.payload.repositoryPath
        || registered.headRevision !== normalizedHead
        || registered.entryGeneration !== Number(registryGeneration)
      ) {
        throw new GitControllerError(
          "STORY_REPOSITORY_RETIRE_STALE",
          "Story repository registry changed after retire preview",
        );
      }
      const state = await this.inspectRetireState(tabId, entry.repositoryId);
      if (
        state.stateSignature !== preview.payload.stateSignature
        || state.headRevision !== normalizedHead
        || state.entryGeneration !== Number(registryGeneration)
      ) {
        throw new GitControllerError(
          "STORY_REPOSITORY_RETIRE_STALE",
          "Story repository changed after retire preview",
        );
      }
      if (!force && !state.safe) {
        throw new GitControllerError(
          "STORY_REPOSITORY_RETIRE_RISK",
          "Story repository acquired local state after retire preview",
        );
      }
      if (force && !state.forceAllowed) {
        throw new GitControllerError(
          "STORY_REPOSITORY_RETIRE_FORCE_BLOCKED",
          "Story repository ownership or inspection changed after retire preview",
        );
      }
      lease.assertCurrent();
      const removed = state.exists
        ? await this.quarantineAndDelete(operation, registered, state, lease)
        : this.writeMissingRemovalTombstone(
            operation,
            registered,
            state,
            lease,
          );
      const registryMutation = await this.mutateRegistryTopology((registry) => {
        const current = registry.entries.find((row) => (
          row.storyId === String(tabId) && row.repositoryId === entry.repositoryId
        ));
        if (
          !current
          || current.repositoryPath !== registered.repositoryPath
          || current.entryGeneration !== registered.entryGeneration
          || current.headRevision !== registered.headRevision
        ) {
          throw new GitControllerError(
            "STORY_REPOSITORY_RETIRE_STALE",
            "Story repository registry changed before retirement commit",
          );
        }
        registry.entries = registry.entries.filter((row) => row !== current);
        return registry;
      }, {
        operation,
        fencingToken: lease.fencingToken,
        reason: "story-retire",
      });
      if (this.faultInjector) {
        await this.faultInjector("after-story-retire-registry-removed", {
          operation,
          registered,
          manifestPath: removed.manifestPath,
        });
      }
      const storyRetentions =
        await this.controller.mirror.reconcileStoryBaseRetentions(
          entry,
          lease,
          registryMutation.registry.entries,
        );
      const storyDirectory = path.dirname(registered.repositoryPath);
      const remaining = this.readRegistry().entries;
      if (
        !remaining.some((row) => row.storyId === String(tabId))
        && path.dirname(storyDirectory) === this.storyRoot
        && fs.existsSync(storyDirectory)
        && fs.readdirSync(storyDirectory).length === 0
      ) {
        fs.rmdirSync(storyDirectory);
      }
      if (
        !remaining.some((row) => row.workerIdentity === registered.workerIdentity)
        && !Object.values(this.workerIdentities).includes(registered.workerIdentity)
      ) {
        this.aclRevoker(this.storyRoot, registered.workerIdentity);
      }
      const result = {
        ok: true,
        resultCode: "PASS",
        operationId: operation.operationId,
        replayed: false,
        removed: removed.removed === true,
        alreadyMissing: removed.alreadyMissing === true,
        repositoryId: entry.repositoryId,
        storyId: String(tabId),
        repositoryPath: registered.repositoryPath,
        workerProbeGeneration: registryMutation.probe.generation,
        storiesRequiringProbe: registryMutation.probe.storiesRequiringProbe,
        storyRetentions,
      };
      this.controller.audit.write({
        operation,
        commandId: "story.repository.retire",
        action: "story.repository.retire",
        branch: state.branch || "__detached__",
        beforeSha: normalizedHead,
        candidateSha: registered.baseRevision,
        result: "PASS",
        durationMs: Date.now() - startedAt,
        fencingToken: lease.fencingToken,
        actor,
        details: {
          storyId: String(tabId),
          force: force === true,
          removed: result.removed,
        },
      });
      this.controller.journal.succeed(operation, result, lease.fencingToken);
      if (removed.manifestPath) {
        fs.rmSync(removed.manifestPath, { force: true });
        fsyncControllerDirectory(this.quarantineRoot);
      }
      return result;
    } catch (rawError) {
      const error = asControllerError(rawError, "STORY_REPOSITORY_RETIRE_FAILED");
      this.controller.journal.fail(operation, error, {
        fencingToken: lease?.fencingToken || null,
        recoveryRequired: (
          !this.registryEntry(tabId, entry.repositoryId)
          || fs.existsSync(path.join(this.quarantineRoot, `${operation.operationId}.json`))
        ),
      });
      throw error;
    } finally {
      lease?.release();
    }
  }

  async cleanup({
    tabId,
    repositoryId,
    idempotencyKey: key,
    provisionOperationId,
    expectedBaseRevision,
    expectedHead,
    registryGeneration,
    actor = "controller:story-provision-compensation",
  } = {}) {
    const idempotencyKey = assertIdempotencyKey(key);
    const entry = this.controller.registry.get(repositoryId);
    const normalizedBase = normalizeSha(expectedBaseRevision, {
      label: "story cleanup expected base SHA",
    });
    const normalizedHead = normalizeSha(expectedHead, {
      label: "story cleanup expected HEAD",
    });
    const journalBranch = operationBinding("story_cleanup", [
      tabId,
      entry.repositoryId,
      provisionOperationId,
      normalizedBase,
      normalizedHead,
      registryGeneration,
    ]);
    const existingOperation = this.controller.journal.persistence
      .getGitControllerOperationByIdempotency?.(
        entry.repositoryId,
        CLEANUP_OPERATION,
        idempotencyKey,
      );
    if (existingOperation) {
      return replay(existingOperation, {
        branch: journalBranch,
        candidateSha: normalizedBase,
        expectedHead: normalizedHead,
      });
    }
    const registered = this.registryEntry(tabId, entry.repositoryId);
    if (
      !registered
      || registered.createdByProvisionOperationId !== String(provisionOperationId || "")
      || registered.baseRevision !== normalizedBase
      || registered.headRevision !== normalizedHead
      || Number(registered.entryGeneration) !== Number(registryGeneration)
    ) {
      throw new GitControllerError(
        "STORY_REPOSITORY_COMPENSATION_NOT_AUTHORIZED",
        "Story cleanup is not bound to the exact newly-created provision result",
      );
    }
    assertTargetInsideRoot(this.storyRoot, tabId, entry.repositoryId);
    const existing = registered
      ? await this.resolve({ tabId, repositoryId: entry.repositoryId })
      : null;
    const candidateSha = existing?.baseRevision || null;
    const begun = this.controller.journal.begin({
      repositoryId: entry.repositoryId,
      operationType: CLEANUP_OPERATION,
      commandId: "story.repository.cleanup",
      idempotencyKey,
      previewId: null,
      branch: journalBranch,
      expectedHead: normalizedHead,
      candidateSha: normalizedBase,
    });
    if (!begun.created) {
      return replay(begun.operation, {
        branch: journalBranch,
        candidateSha: normalizedBase,
        expectedHead: normalizedHead,
      });
    }
    const operation = begun.operation;
    let lease = null;
    try {
      lease = this.controller.leaseManager.acquire(entry, {
        operationId: operation.operationId,
        kind: "story-repository-cleanup",
      });
      lease.assertCurrent();
      const current = this.registryEntry(tabId, entry.repositoryId);
      if (
        !current
        || current.createdByProvisionOperationId !== provisionOperationId
        || current.baseRevision !== normalizedBase
        || current.headRevision !== normalizedHead
        || current.entryGeneration !== registryGeneration
      ) {
        throw new GitControllerError(
          "STORY_REPOSITORY_COMPENSATION_STALE",
          "Story cleanup binding changed after lease acquisition",
        );
      }
      const verified = await this.resolve({ tabId, repositoryId: entry.repositoryId });
      if (
        verified.baseRevision !== normalizedBase
        || verified.headRevision !== normalizedHead
      ) {
        throw new GitControllerError(
          "STORY_REPOSITORY_COMPENSATION_STALE",
          "Story repository changed after provision and cannot be compensated",
        );
      }
      const provisionOperation = this.controller.journal.persistence
        .getGitControllerOperation(String(provisionOperationId || ""));
      if (
        !provisionOperation
        || provisionOperation.operationType !== PROVISION_OPERATION
        || provisionOperation.operationId !== registered.createdByProvisionOperationId
      ) {
        throw new GitControllerError(
          "STORY_REPOSITORY_COMPENSATION_STATE_UNVERIFIED",
          "Story cleanup cannot load the exact provision rollback attestation",
          { recoveryRequired: true },
        );
      }
      this.assertProvisionRollbackUnchanged(provisionOperation, verified);
      const cleanupState = await this.inspectRetireState(
        tabId,
        entry.repositoryId,
      );
      if (
        cleanupState.repositoryPath !== registered.repositoryPath
        || cleanupState.baseRevision !== normalizedBase
        || cleanupState.headRevision !== normalizedHead
        || cleanupState.entryGeneration !== Number(registryGeneration)
      ) {
        throw new GitControllerError(
          "STORY_REPOSITORY_COMPENSATION_STALE",
          "Story cleanup exact quarantine binding changed before deletion",
          { recoveryRequired: true },
        );
      }
      const removed = existing
        ? await this.quarantineAndDelete(
          operation,
          registered,
          cleanupState,
          lease,
        )
        : { removed: false };
      const registryMutation = await this.mutateRegistryTopology((registry) => {
        registry.entries = registry.entries.filter((row) => !(
          row.storyId === String(tabId)
          && row.repositoryId === entry.repositoryId
        ));
        return registry;
      }, {
        operation,
        fencingToken: lease.fencingToken,
        reason: "story-provision-cleanup",
      });
      const storyRetentions =
        await this.controller.mirror.reconcileStoryBaseRetentions(
          entry,
          lease,
          registryMutation.registry.entries,
        );
      const remainingForStory = this.readRegistry().entries.some(
        (row) => row.storyId === String(tabId),
      );
      const storyDirectory = path.dirname(registered.repositoryPath);
      if (
        !remainingForStory
        && path.dirname(storyDirectory) === this.storyRoot
        && fs.existsSync(storyDirectory)
        && fs.readdirSync(storyDirectory).length === 0
      ) {
        fs.rmdirSync(storyDirectory);
      }
      const identityStillUsed = this.readRegistry().entries.some(
        (row) => row.workerIdentity === registered.workerIdentity,
      );
      if (
        !identityStillUsed
        && !Object.values(this.workerIdentities).includes(registered.workerIdentity)
      ) {
        this.aclRevoker(this.storyRoot, registered.workerIdentity);
      }
      const result = {
        ok: true,
        resultCode: "PASS",
        operationId: operation.operationId,
        replayed: false,
        removed: removed.removed === true,
        workerProbeGeneration: registryMutation.probe.generation,
        storiesRequiringProbe: registryMutation.probe.storiesRequiringProbe,
        storyRetentions,
      };
      this.controller.audit.write({
        operation,
        commandId: "story.repository.cleanup",
        action: "story.repository.cleanup",
        branch: "__story_cleanup__",
        beforeSha: existing?.headRevision || null,
        candidateSha,
        result: "PASS",
        fencingToken: lease.fencingToken,
        actor,
        details: { storyId: tabId, removed: result.removed },
      });
      this.controller.journal.succeed(operation, result, lease.fencingToken);
      if (removed.manifestPath) {
        fs.rmSync(removed.manifestPath, { force: true });
        fsyncControllerDirectory(this.quarantineRoot);
      }
      return result;
    } catch (rawError) {
      const error = asControllerError(rawError);
      this.controller.journal.fail(operation, error, {
        fencingToken: lease?.fencingToken || null,
        recoveryRequired: true,
      });
      throw error;
    } finally {
      lease?.release();
    }
  }
}

export function createStoryRepositoryController(options = {}) {
  return new StoryRepositoryController(options);
}

export const __test = Object.freeze({
  assertTargetInsideRoot,
  assertWindowsStoryAcl,
  rightsAllowWrite,
  storyGit,
  storyBranch,
  windowsSddlAces,
});
