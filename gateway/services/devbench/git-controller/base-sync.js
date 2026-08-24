import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import * as defaultPersistence from "../../../db/sqlite.js";
import {
  GitControllerError,
  assertIdempotencyKey,
  canonicalizeExistingDirectory,
  normalizeSha,
  pathInside,
  pathKey,
  runGitFile,
  streamGitNulRecords,
} from "./path-security.js";
import {
  canonicalRemoteIdentity,
  fingerprintRemote,
} from "./registry.js";
import { listAllRecoverableOperations } from "./journal.js";
import { controllerBaseDestinationRef } from "./internal-refs.js";

const BASE_PREVIEW_KIND = "BASE_SYNC";
const BASE_OPERATION_TYPE = "BASE_SYNC";
const BASE_COMMAND_ID = "base.sync.fast-forward";

function asControllerError(error, fallbackCode = "GIT_CONTROLLER_BASE_SYNC_FAILED") {
  if (error instanceof GitControllerError) return error;
  return new GitControllerError(
    fallbackCode,
    "Managed base repository synchronization failed",
    { cause: error?.code || error?.message || String(error) },
    { cause: error },
  );
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
    stored.message || "The idempotent operation previously failed",
    { ...(stored.details || {}), operationId: operation.operationId, replayed: true },
  );
}

function assertReplayBinding(operation, {
  previewId,
  branch,
  expectedHead,
  candidateSha,
}) {
  if (
    operation.previewId !== previewId
    || operation.branch !== branch
    || operation.expectedHead !== expectedHead
    || operation.candidateSha !== candidateSha
  ) {
    throw new GitControllerError(
      "GIT_CONTROLLER_IDEMPOTENCY_CONFLICT",
      "Idempotency key was already used for a different base synchronization request",
      { operationId: operation.operationId },
    );
  }
}

function statusClassification(output) {
  const lines = String(output || "").split(/\r?\n/).filter(Boolean);
  const untracked = lines.filter((line) => line.startsWith("? "));
  const ignored = lines.filter((line) => line.startsWith("! "));
  const tracked = lines.filter((line) => !line.startsWith("? ") && !line.startsWith("! "));
  return {
    clean: tracked.length === 0 && untracked.length === 0,
    tracked,
    untracked,
    ignored,
    lines,
  };
}

function parseGitBoolean(value, { key } = {}) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["", "true", "yes", "on", "1"].includes(normalized)) return true;
  if (["false", "no", "off", "0"].includes(normalized)) return false;
  throw new GitControllerError(
    "GIT_CONTROLLER_BASE_CONFIG_UNTRUSTED",
    "Base repository local config contains an invalid boolean",
    { key: String(key || "") },
  );
}

function repositoryRelativePath(record, {
  allowDirectorySuffix = false,
  label = "repository path",
} = {}) {
  if (!Buffer.isBuffer(record) || !record.length) {
    throw new Error(`${label}-record`);
  }
  const text = record.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(record)) {
    throw new Error(`${label}-encoding`);
  }
  const directory = allowDirectorySuffix && text.endsWith("/");
  const value = directory ? text.slice(0, -1) : text;
  if (
    !value
    || value.length > 4096
    || value.startsWith("/")
    || value.endsWith("/")
    || value.includes("\\")
    || value.includes("//")
    || /^[A-Za-z]:/.test(value)
    || /[\x00-\x1f\x7f]/.test(value)
    || value.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`${label}-invalid`);
  }
  return value;
}

function repositoryPathComparisonKey(value, { ignoreCase = false } = {}) {
  const normalized = String(value || "").normalize("NFC");
  return ignoreCase ? normalized.toLowerCase() : normalized;
}

function lowerBoundRepositoryPath(sorted, target) {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (sorted[middle].key < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function findRepositoryPathCollision(sortedWrites, writeByKey, ignoredPath, options = {}) {
  const ignoredKey = repositoryPathComparisonKey(ignoredPath, options);
  const exact = writeByKey.get(ignoredKey);
  if (exact) return exact;

  let separator = ignoredKey.indexOf("/");
  while (separator > 0) {
    const ancestor = writeByKey.get(ignoredKey.slice(0, separator));
    if (ancestor) return ancestor;
    separator = ignoredKey.indexOf("/", separator + 1);
  }

  const descendantPrefix = `${ignoredKey}/`;
  const index = lowerBoundRepositoryPath(sortedWrites, descendantPrefix);
  const descendant = sortedWrites[index];
  return descendant?.key.startsWith(descendantPrefix) ? descendant : null;
}

function candidateSubmoduleBlocked(reason, details = {}) {
  return {
    eligible: false,
    blockerCode: "BASE_SYNC_BLOCKED_CANDIDATE_SUBMODULE",
    status: "BLOCKED",
    reason,
    submoduleCount: Number(details.submoduleCount) || 0,
    verifiedCommitCount: Number(details.verifiedCommitCount) || 0,
    ...details,
  };
}

function validSubmodulePath(value) {
  const input = String(value || "");
  if (
    !input
    || input.length > 4096
    || input.startsWith("/")
    || input.endsWith("/")
    || input.includes("\\")
    || input.includes("//")
    || /[\x00-\x1f\x7f]/.test(input)
    || /^[A-Za-z]:/.test(input)
  ) {
    return false;
  }
  const segments = input.split("/");
  return segments.every((segment) => (
    segment
    && segment !== "."
    && segment !== ".."
    && segment.toLowerCase() !== ".git"
  ));
}

function parseTreeRecord(record) {
  if (!Buffer.isBuffer(record) || !record.length) throw new Error("tree-record");
  const text = record.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(record)) throw new Error("tree-record-encoding");
  const tab = text.indexOf("\t");
  if (tab <= 0) throw new Error("tree-record");
  const metadata = text.slice(0, tab).match(
    /^([0-7]{6}) ([a-z]+) ([0-9a-f]{40}|[0-9a-f]{64})$/,
  );
  const treePath = text.slice(tab + 1);
  if (
    !metadata
    || !treePath
    || treePath.length > 4096
    || treePath.startsWith("/")
    || treePath.includes("\\")
    || treePath.includes("//")
    || /[\x00-\x1f\x7f]/.test(treePath)
    || treePath.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("tree-record");
  }
  return {
    mode: metadata[1],
    type: metadata[2],
    sha: metadata[3],
    path: treePath,
  };
}

function parseGitmodulesConfig(output) {
  const modules = new Map();
  for (const record of String(output || "").split("\0").filter(Boolean)) {
    const separator = record.indexOf("\n");
    if (separator <= 0) throw new Error("gitmodules-record");
    const key = record.slice(0, separator);
    const value = record.slice(separator + 1);
    const matched = key.match(/^submodule\.(.+)\.([a-z][a-z0-9-]*)$/i);
    if (!matched) throw new Error("gitmodules-key");
    const name = matched[1];
    const field = matched[2].toLowerCase();
    if (
      !name
      || /[\x00-\x1f\x7f]/.test(name)
      || value.includes("\0")
    ) {
      throw new Error("gitmodules-record");
    }
    const current = modules.get(name) || { name };
    // The base-sync transaction never initializes submodules. Keep the
    // accepted manifest deliberately smaller than Git's full .gitmodules
    // grammar so a later, separate submodule stage cannot inherit executable
    // update commands or other behavior from an untrusted candidate.
    if (!["path", "url"].includes(field)) throw new Error("gitmodules-field");
    if (Object.hasOwn(current, field)) throw new Error("gitmodules-duplicate");
    current[field] = value;
    modules.set(name, current);
  }
  return [...modules.values()];
}

export class BaseSyncService {
  constructor({
    registry,
    mirror,
    persistence = defaultPersistence,
    leaseManager,
    journal,
    audit,
    gitRunner = runGitFile,
    gitNulStreamer = streamGitNulRecords,
    previewTtlMs = 5 * 60_000,
    capabilityIssuer = null,
  } = {}) {
    if (!registry || !mirror || !leaseManager || !journal || !audit) {
      throw new GitControllerError(
        "GIT_CONTROLLER_DEPENDENCY_MISSING",
        "Base sync service dependencies are incomplete",
      );
    }
    this.registry = registry;
    this.mirror = mirror;
    this.persistence = persistence;
    this.leaseManager = leaseManager;
    this.journal = journal;
    this.audit = audit;
    this.gitRunner = gitRunner;
    if (typeof gitNulStreamer !== "function") {
      throw new GitControllerError(
        "GIT_CONTROLLER_STREAM_RUNNER_INVALID",
        "Candidate tree stream runner must be a Controller-owned function",
      );
    }
    this.gitNulStreamer = gitNulStreamer;
    this.previewTtlMs = Math.max(10_000, Number(previewTtlMs) || 5 * 60_000);
    if (capabilityIssuer != null && typeof capabilityIssuer !== "function") {
      throw new GitControllerError(
        "GIT_CONTROLLER_CAPABILITY_ISSUER_INVALID",
        "Base protection capability issuer must be a function",
      );
    }
    this.capabilityIssuer = capabilityIssuer;
  }

  baseArgs(entry, args) {
    // A successful fetch may otherwise start detached auto-maintenance after
    // its direct process exits. Keep every implicit writer disabled so the
    // repository lease and Git-child ledger cover the complete mutation.
    return [
      "-c",
      "gc.auto=0",
      "-c",
      "gc.autoDetach=false",
      "-c",
      "maintenance.auto=false",
      "-c",
      "maintenance.autoDetach=false",
      "-c",
      `safe.directory=${entry.basePath.replace(/\\/g, "/")}`,
      "-C",
      entry.basePath,
      ...args,
    ];
  }

  mirrorArgs(entry, args) {
    return ["--git-dir", entry.mirrorPath, ...args];
  }

  async run(entry, args, options = {}) {
    this.registry.attestGitBinary();
    const remoteUrl = String(options.remoteUrl || "");
    let protocol = "file";
    let sshTransport = null;
    if (remoteUrl) {
      if (
        !args.includes("ls-remote")
        || args.includes("fetch")
        || args.includes("push")
        || !args.includes(remoteUrl)
      ) {
        throw new GitControllerError(
          "GIT_CONTROLLER_BASE_REMOTE_WRITE_FORBIDDEN",
          "Candidate remote verification permits only fixed ls-remote reads",
        );
      }
      const canonicalRemote = canonicalRemoteIdentity(remoteUrl);
      protocol = canonicalRemote.slice(0, canonicalRemote.indexOf(":"));
      if (!["file", "https", "ssh"].includes(protocol)) {
        throw new GitControllerError(
          "GIT_CONTROLLER_TRANSPORT_REJECTED",
          "Base synchronization requested an unapproved remote transport",
        );
      }
      if (protocol === "ssh") {
        sshTransport = this.registry.transportFor(entry, { remoteUrl });
      }
    }
    return this.gitRunner({
      gitBinary: this.registry.gitBinary,
      disabledHooksPath: this.registry.disabledHooksPath,
      trustedHooksPath: options.trustedHooksPath || null,
      knownHostsPath: this.registry.knownHostsPath,
      args,
      commandId: options.commandId,
      timeoutMs: options.timeoutMs,
      maxOutputBytes: options.maxOutputBytes,
      okExitCodes: options.okExitCodes || [0],
      env: {
        ...(options.env || {}),
        GIT_ALLOW_PROTOCOL: protocol,
        GIT_PROTOCOL_FROM_USER: "0",
      },
      sshTransport,
      secrets: [entry.remoteUrl, ...(options.secrets || [])],
      childLifecycle: options.childLifecycle || null,
    });
  }

  async runMutation(entry, args, lease, options = {}) {
    if (!lease || typeof lease.gitChildGuard !== "function") {
      throw new GitControllerError(
        "GIT_CONTROLLER_MUTATION_LEASE_REQUIRED",
        "Repository-mutating Git commands require a child-tracking lease",
        { repositoryId: entry.repositoryId, commandId: options.commandId || null },
      );
    }
    lease.assertCurrent();
    return this.run(entry, args, {
      ...options,
      childLifecycle: lease.gitChildGuard(options.commandId),
    });
  }

  async localRepositoryPolicy(entry) {
    const configPath = path.join(entry.basePath, ".git", "config");
    const gitDirectory = path.dirname(configPath);
    const configStat = fs.lstatSync(configPath);
    const gitDirectoryStat = fs.lstatSync(gitDirectory);
    if (
      !configStat.isFile()
      || configStat.isSymbolicLink()
      || configStat.nlink !== 1
      || !gitDirectoryStat.isDirectory()
      || gitDirectoryStat.isSymbolicLink()
    ) {
      throw new GitControllerError(
        "GIT_CONTROLLER_BASE_CONFIG_UNTRUSTED",
        "Base repository local config is not a single protected regular file",
      );
    }
    const rawConfig = fs.readFileSync(configPath);
    const listed = await this.run(entry, [
      "config",
      "--file",
      configPath,
      "--no-includes",
      "--null",
      "--list",
    ], { commandId: "base.local-config-policy" });
    const records = String(listed.stdout || "").split("\0").filter(Boolean).map((record) => {
      const separator = record.indexOf("\n");
      if (separator <= 0) {
        throw new GitControllerError(
          "GIT_CONTROLLER_BASE_CONFIG_UNTRUSTED",
          "Base repository local config contains an invalid record",
        );
      }
      return {
        key: record.slice(0, separator).toLowerCase(),
        value: record.slice(separator + 1),
      };
    });
    const allowedExact = new Set([
      "core.repositoryformatversion",
      "core.filemode",
      "core.bare",
      "core.logallrefupdates",
      "core.ignorecase",
      "core.symlinks",
      "core.autocrlf",
      "core.longpaths",
      "core.precomposeunicode",
      "core.protectntfs",
      "core.protecthfs",
      "core.hookspath",
      "user.name",
      "user.email",
    ]);
    const remotePrefix = `remote.${String(entry.remoteId).toLowerCase()}.`;
    const branchNames = new Set(
      (entry.allowedBranches || []).map((branch) => String(branch).toLowerCase()),
    );
    let hooksPath = "";
    let ignoreCase = false;
    for (const { key, value } of records) {
      let allowed = allowedExact.has(key);
      if (key === `${remotePrefix}url` || key === `${remotePrefix}fetch`) allowed = true;
      const branchMatch = key.match(/^branch\.(.+)\.(remote|merge)$/);
      if (branchMatch && branchNames.has(branchMatch[1].toLowerCase())) allowed = true;
      if (!allowed) {
        throw new GitControllerError(
          "GIT_CONTROLLER_BASE_CONFIG_UNTRUSTED",
          "Base repository local config contains a key outside the Controller allowlist",
          { key },
        );
      }
      if (key === "core.hookspath") hooksPath = value;
      if (key === "core.ignorecase") {
        ignoreCase = parseGitBoolean(value, { key });
      }
      if (key === `${remotePrefix}url`) {
        const configured = canonicalRemoteIdentity(value, entry.basePath);
        if (configured !== entry.canonicalRemote) {
          throw new GitControllerError(
            "GIT_CONTROLLER_BASE_CONFIG_UNTRUSTED",
            "Base repository remote URL differs from the static Controller definition",
          );
        }
      }
    }
    if (hooksPath) {
      const expectedHooksPath = path.join(
        entry.basePath,
        ".git",
        "devbench-base-protection",
        "hooks",
      );
      let actualHooksPath = "";
      try {
        if (!path.isAbsolute(hooksPath)) {
          throw new Error("hooksPath is not absolute");
        }
        actualHooksPath = canonicalizeExistingDirectory(hooksPath, {
          label: "managed base protection hooks",
        });
      } catch (error) {
        throw new GitControllerError(
          "GIT_CONTROLLER_BASE_CONFIG_UNTRUSTED",
          "Base repository hooksPath is not the managed Controller hooks directory",
          {},
          { cause: error },
        );
      }
      if (path.resolve(actualHooksPath) !== path.resolve(expectedHooksPath)) {
        throw new GitControllerError(
          "GIT_CONTROLLER_BASE_CONFIG_UNTRUSTED",
          "Base repository hooksPath differs from the managed Controller hooks directory",
        );
      }
    }
    const infoAttributesPath = path.join(entry.basePath, ".git", "info", "attributes");
    let infoAttributesFingerprint = null;
    if (fs.existsSync(infoAttributesPath)) {
      const infoStat = fs.lstatSync(infoAttributesPath);
      if (!infoStat.isFile() || infoStat.isSymbolicLink() || infoStat.nlink !== 1) {
        throw new GitControllerError(
          "GIT_CONTROLLER_LOCAL_ATTRIBUTES_UNTRUSTED",
          "Base repository info/attributes is not a protected regular file",
        );
      }
      const info = fs.readFileSync(infoAttributesPath);
      const active = info.toString("utf8")
        .split(/\r?\n/)
        .some((line) => line.trim() && !line.trimStart().startsWith("#"));
      if (active) {
        throw new GitControllerError(
          "GIT_CONTROLLER_LOCAL_ATTRIBUTES_UNTRUSTED",
          "Base repository info/attributes must not contain local attribute rules",
        );
      }
      infoAttributesFingerprint = createHash("sha256").update(info).digest("hex");
    }
    const after = fs.lstatSync(configPath);
    if (
      after.size !== configStat.size
      || after.mtimeMs !== configStat.mtimeMs
      || after.ino !== configStat.ino
    ) {
      throw new GitControllerError(
        "GIT_CONTROLLER_BASE_CONFIG_RACE",
        "Base repository local config changed during policy inspection",
      );
    }
    return {
      hooksPath,
      ignoreCase,
      configFingerprint: createHash("sha256").update(rawConfig).digest("hex"),
      infoAttributesFingerprint,
    };
  }

  async capabilityEnv({
    entry,
    operation,
    lease,
    commandId,
    branch,
    expectedHead,
    candidateSha,
    hooksPath,
  }) {
    let trustedHooksPath = "";
    if (hooksPath) {
      const expected = path.join(
        entry.basePath,
        ".git",
        "devbench-base-protection",
        "hooks",
      );
      let actual;
      try {
        actual = canonicalizeExistingDirectory(hooksPath, {
          label: "managed base protection hooks",
        });
      } catch (error) {
        throw new GitControllerError(
          "GIT_CONTROLLER_HOOKS_PATH_UNTRUSTED",
          "Configured base hooksPath is not a protected managed hooks directory",
          {},
          { cause: error },
        );
      }
      if (path.resolve(actual) !== path.resolve(expected)) {
        throw new GitControllerError(
          "GIT_CONTROLLER_HOOKS_PATH_UNTRUSTED",
          "Configured base hooksPath does not equal the Controller managed hooks directory",
        );
      }
      trustedHooksPath = actual;
    }
    const managedHooksActive = /(?:^|[\\/])devbench-base-protection(?:[\\/]|$)/i.test(
      trustedHooksPath,
    );
    if (!this.capabilityIssuer) {
      if (managedHooksActive) {
        throw new GitControllerError(
          "BASE_PROTECTION_ISSUER_UNAVAILABLE",
          "Managed base protection is active but no Controller capability issuer is configured",
          { repositoryId: entry.repositoryId, commandId },
        );
      }
      return {};
    }
    if (!managedHooksActive) {
      throw new GitControllerError(
        "GIT_CONTROLLER_BASE_PROTECTION_INACTIVE",
        "Controller capability issuance requires the exact managed base hooks directory",
      );
    }
    lease.assertCurrent();
    const issuedAt = Date.now();
    const context = Object.freeze({
      operationId: operation.operationId,
      repositoryId: entry.repositoryId,
      commandId,
      branch,
      expectedHead,
      candidateSha,
      fencingToken: lease.fencingToken,
      issuedAt,
      expiresAt: Math.min(lease.expiresAt, issuedAt + 120_000),
      hookPhaseSequence: Object.freeze(["prepared", "committed", "aborted"]),
    });
    let issued;
    try {
      issued = await this.capabilityIssuer(context);
    } catch (error) {
      throw new GitControllerError(
        "BASE_PROTECTION_ISSUER_UNAVAILABLE",
        "Base protection capability could not be issued",
        { repositoryId: entry.repositoryId, commandId, cause: error.code || error.message },
        { cause: error },
      );
    }
    const token = typeof issued === "string"
      ? issued
      : String(
        issued?.capability
        || issued?.token
        || issued?.DEVBENCH_BASE_PROTECTION_CAPABILITY
        || "",
      );
    if (!token || token.length > 16_384 || /[\x00\r\n]/.test(token)) {
      throw new GitControllerError(
        "BASE_PROTECTION_CAPABILITY_INVALID",
        "Base protection capability issuer returned an invalid token",
        { repositoryId: entry.repositoryId, commandId },
      );
    }
    const issuedEnvironment = typeof issued === "object" && issued
      ? (issued.environment || issued.env || {})
      : {};
    if (
      !issuedEnvironment
      || typeof issuedEnvironment !== "object"
      || Array.isArray(issuedEnvironment)
    ) {
      throw new GitControllerError(
        "BASE_PROTECTION_CAPABILITY_INVALID",
        "Base protection capability environment is invalid",
        { repositoryId: entry.repositoryId, commandId },
      );
    }
    const environment = {};
    for (const [key, value] of Object.entries(issuedEnvironment)) {
      if (key !== "DEVBENCH_GIT_CONTROLLER_CAPABILITY_ROOT") {
        throw new GitControllerError(
          "BASE_PROTECTION_CAPABILITY_ENV_REJECTED",
          "Capability issuer returned an unexpected environment variable",
          { repositoryId: entry.repositoryId, commandId, key },
        );
      }
      const normalized = String(value || "");
      if (!normalized || normalized.length > 4096 || /[\x00\r\n]/.test(normalized)) {
        throw new GitControllerError(
          "BASE_PROTECTION_CAPABILITY_INVALID",
          "Base protection capability root is invalid",
          { repositoryId: entry.repositoryId, commandId },
        );
      }
      environment[key] = normalized;
    }
    return {
      ...environment,
      DEVBENCH_BASE_PROTECTION_CAPABILITY: token,
      DEVBENCH_BASE_PROTECTION_CONTROLLER_MUTATION: "1",
    };
  }

  async gitPath(entry, name) {
    const result = await this.run(entry, this.baseArgs(entry, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      name,
    ]), {
      commandId: `base.git-path.${name.replace(/[^A-Za-z0-9]+/g, "-")}`,
    });
    return path.resolve(result.stdout.trim());
  }

  async classifyRelationship(entry, head, candidateSha) {
    if (head === candidateSha) return "UNCHANGED";
    const candidateInBase = await this.run(entry, this.baseArgs(entry, [
      "cat-file",
      "-e",
      `${candidateSha}^{commit}`,
    ]), {
      commandId: "base.candidate-exists",
      okExitCodes: [0, 1, 128],
    });
    if (candidateInBase.exitCode === 0) {
      const forward = await this.run(entry, this.baseArgs(entry, [
        "merge-base",
        "--is-ancestor",
        head,
        candidateSha,
      ]), {
        commandId: "base.classify-forward",
        okExitCodes: [0, 1],
      });
      if (forward.exitCode === 0) return "FAST_FORWARD";
      const ahead = await this.run(entry, this.baseArgs(entry, [
        "merge-base",
        "--is-ancestor",
        candidateSha,
        head,
      ]), {
        commandId: "base.classify-ahead",
        okExitCodes: [0, 1],
      });
      return ahead.exitCode === 0 ? "BASE_AHEAD" : "BASE_DIVERGED";
    }
    const headInMirror = await this.run(entry, this.mirrorArgs(entry, [
      "cat-file",
      "-e",
      `${head}^{commit}`,
    ]), {
      commandId: "base.head-exists-in-mirror",
      okExitCodes: [0, 1, 128],
    });
    if (headInMirror.exitCode !== 0) return "BASE_DIVERGED";
    const forwardInMirror = await this.run(entry, this.mirrorArgs(entry, [
      "merge-base",
      "--is-ancestor",
      head,
      candidateSha,
    ]), {
      commandId: "base.classify-forward-in-mirror",
      okExitCodes: [0, 1],
    });
    return forwardInMirror.exitCode === 0 ? "FAST_FORWARD" : "BASE_DIVERGED";
  }

  async candidateSubmodulePreflight(entry, candidateSha) {
    const tree = [];
    let attributeFileCount = 0;
    let gitlinkCount = 0;
    try {
      this.registry.attestGitBinary();
      await this.gitNulStreamer({
        gitBinary: this.registry.gitBinary,
        disabledHooksPath: this.registry.disabledHooksPath,
        knownHostsPath: this.registry.knownHostsPath,
        args: this.mirrorArgs(entry, [
          "ls-tree",
          "-rz",
          "-r",
          "--full-tree",
          candidateSha,
        ]),
        commandId: "base.candidate-submodules-tree",
        timeoutMs: 120_000,
        env: {
          GIT_ALLOW_PROTOCOL: "file",
          GIT_PROTOCOL_FROM_USER: "0",
        },
        maxTotalBytes: 512 * 1024 * 1024,
        maxRecords: 2_000_000,
        maxRecordBytes: 16 * 1024,
        onRecord(record) {
          const item = parseTreeRecord(record);
          if (item.mode === "160000") {
            gitlinkCount += 1;
            if (gitlinkCount > 10_000) throw new Error("candidate-gitlink-limit");
            tree.push(item);
            return;
          }
          if (item.path === ".gitmodules") {
            tree.push(item);
            return;
          }
          if (item.type === "blob" && path.posix.basename(item.path) === ".gitattributes") {
            attributeFileCount += 1;
            if (attributeFileCount <= 129) tree.push(item);
          }
        },
      });
    } catch {
      return candidateSubmoduleBlocked("CANDIDATE_TREE_UNREADABLE");
    }
    const gitlinks = tree.filter((item) => item.mode === "160000" && item.type === "commit");
    const attributeFiles = tree.filter((item) => (
      item.type === "blob"
      && path.posix.basename(item.path) === ".gitattributes"
    ));
    if (attributeFileCount > 128) {
      return candidateSubmoduleBlocked("CANDIDATE_ATTRIBUTES_OVERFLOW", {
        blockerCode: "BASE_SYNC_BLOCKED_CANDIDATE_ATTRIBUTES",
      });
    }
    for (const attributeFile of attributeFiles) {
      let content;
      try {
        content = (await this.run(entry, this.mirrorArgs(entry, [
          "cat-file",
          "blob",
          attributeFile.sha,
        ]), {
          commandId: "base.candidate-attributes-read",
        })).stdout;
      } catch {
        return candidateSubmoduleBlocked("CANDIDATE_ATTRIBUTES_UNREADABLE", {
          blockerCode: "BASE_SYNC_BLOCKED_CANDIDATE_ATTRIBUTES",
          attributePath: attributeFile.path,
        });
      }
      const executableRule = String(content || "").split(/\r?\n/).find((line) => {
        const normalized = line.trim();
        if (!normalized || normalized.startsWith("#")) return false;
        return /(?:^|\s)[!-]?(?:filter|diff|merge)(?:\s|=|$)/i.test(normalized);
      });
      if (executableRule) {
        return candidateSubmoduleBlocked("CANDIDATE_EXECUTABLE_ATTRIBUTES", {
          blockerCode: "BASE_SYNC_BLOCKED_CANDIDATE_ATTRIBUTES",
          attributePath: attributeFile.path,
        });
      }
    }
    const malformedGitlinks = tree.filter((item) => (
      item.mode === "160000" && item.type !== "commit"
    ));
    const gitmodulesEntries = tree.filter((item) => item.path === ".gitmodules");
    if (malformedGitlinks.length || gitmodulesEntries.length > 1) {
      return candidateSubmoduleBlocked("CANDIDATE_SUBMODULE_TREE_INVALID", {
        submoduleCount: gitlinks.length,
      });
    }
    if (!gitlinks.length && !gitmodulesEntries.length) {
      return {
        eligible: true,
        blockerCode: null,
        status: "NOT_PRESENT",
        reason: null,
        submoduleCount: 0,
        verifiedCommitCount: 0,
      };
    }
    if (
      !gitmodulesEntries.length
      || gitmodulesEntries[0].type !== "blob"
      || !["100644", "100755"].includes(gitmodulesEntries[0].mode)
    ) {
      return candidateSubmoduleBlocked("CANDIDATE_GITMODULES_MISSING_OR_INVALID", {
        submoduleCount: gitlinks.length,
      });
    }

    let modules;
    try {
      const result = await this.run(entry, this.mirrorArgs(entry, [
        "config",
        "-z",
        "--blob",
        `${candidateSha}:.gitmodules`,
        "--list",
      ]), {
        commandId: "base.candidate-gitmodules-parse",
      });
      modules = parseGitmodulesConfig(result.stdout);
    } catch {
      return candidateSubmoduleBlocked("CANDIDATE_GITMODULES_UNPARSABLE", {
        submoduleCount: gitlinks.length,
      });
    }

    const gitlinksByPath = new Map();
    for (const gitlink of gitlinks) {
      if (!validSubmodulePath(gitlink.path)) {
        return candidateSubmoduleBlocked("CANDIDATE_SUBMODULE_PATH_INVALID", {
          submoduleCount: gitlinks.length,
        });
      }
      const collisionKey = gitlink.path.toLowerCase();
      if (gitlinksByPath.has(collisionKey)) {
        return candidateSubmoduleBlocked("CANDIDATE_SUBMODULE_PATH_DUPLICATE", {
          submoduleCount: gitlinks.length,
        });
      }
      gitlinksByPath.set(collisionKey, gitlink);
    }
    const modulesByPath = new Map();
    for (const module of modules) {
      if (!validSubmodulePath(module.path) || typeof module.url !== "string" || !module.url.trim()) {
        return candidateSubmoduleBlocked("CANDIDATE_GITMODULES_MAPPING_INVALID", {
          submoduleCount: gitlinks.length,
        });
      }
      const collisionKey = module.path.toLowerCase();
      if (modulesByPath.has(collisionKey)) {
        return candidateSubmoduleBlocked("CANDIDATE_SUBMODULE_PATH_DUPLICATE", {
          submoduleCount: gitlinks.length,
        });
      }
      modulesByPath.set(collisionKey, module);
    }
    if (
      modulesByPath.size !== gitlinksByPath.size
      || [...modulesByPath.keys()].some((key) => !gitlinksByPath.has(key))
    ) {
      return candidateSubmoduleBlocked("CANDIDATE_GITMODULES_GITLINK_MISMATCH", {
        submoduleCount: gitlinks.length,
      });
    }

    const allowedByFingerprint = new Map(
      (entry.allowedSubmoduleRemotes || []).map((item) => [item.remoteFingerprint, item]),
    );
    const advertisedByFingerprint = new Map();
    let verifiedCommitCount = 0;
    for (const [collisionKey, module] of modulesByPath) {
      let canonicalRemote;
      let remoteFingerprint;
      try {
        canonicalRemote = canonicalRemoteIdentity(module.url);
        remoteFingerprint = fingerprintRemote(module.url);
      } catch {
        return candidateSubmoduleBlocked("CANDIDATE_SUBMODULE_URL_INVALID", {
          submoduleCount: gitlinks.length,
          verifiedCommitCount,
        });
      }
      const allowed = allowedByFingerprint.get(remoteFingerprint);
      if (!allowed || allowed.canonicalRemote !== canonicalRemote) {
        return candidateSubmoduleBlocked("CANDIDATE_SUBMODULE_URL_NOT_ALLOWED", {
          submoduleCount: gitlinks.length,
          verifiedCommitCount,
          remoteFingerprint,
        });
      }
      let advertised = advertisedByFingerprint.get(remoteFingerprint);
      if (!advertised) {
        let result;
        try {
          result = await this.run(entry, [
            "ls-remote",
            "--heads",
            "--tags",
            allowed.remoteUrl,
          ], {
            commandId: "base.candidate-submodule-ls-remote",
            timeoutMs: 60_000,
            secrets: [allowed.remoteUrl],
            remoteUrl: allowed.remoteUrl,
          });
        } catch {
          return candidateSubmoduleBlocked("CANDIDATE_SUBMODULE_REMOTE_UNVERIFIED", {
            submoduleCount: gitlinks.length,
            verifiedCommitCount,
            remoteFingerprint,
          });
        }
        advertised = new Set();
        for (const line of result.stdout.split(/\r?\n/).filter(Boolean)) {
          const matched = line.match(/^([0-9a-f]{40}|[0-9a-f]{64})\trefs\/(?:heads|tags)\/[^\x00-\x20\x7f]+(?:\^\{\})?$/);
          if (!matched) {
            return candidateSubmoduleBlocked("CANDIDATE_SUBMODULE_ADVERTISEMENT_INVALID", {
              submoduleCount: gitlinks.length,
              verifiedCommitCount,
              remoteFingerprint,
            });
          }
          advertised.add(matched[1]);
        }
        advertisedByFingerprint.set(remoteFingerprint, advertised);
      }
      const gitlink = gitlinksByPath.get(collisionKey);
      if (!advertised.has(gitlink.sha)) {
        return candidateSubmoduleBlocked("CANDIDATE_SUBMODULE_COMMIT_NOT_ADVERTISED", {
          submoduleCount: gitlinks.length,
          verifiedCommitCount,
          remoteFingerprint,
        });
      }
      verifiedCommitCount += 1;
    }
    return {
      eligible: true,
      blockerCode: null,
      status: "VERIFIED",
      reason: null,
      submoduleCount: gitlinks.length,
      verifiedCommitCount,
    };
  }

  async ignoredPathCollisionPreflight(entry, head, candidateSha, {
    ignoreCase = false,
  } = {}) {
    if (head === candidateSha) {
      return {
        eligible: true,
        blockerCode: null,
        status: "UNCHANGED",
        candidateWriteCount: 0,
        ignoredPathCount: 0,
        conflictCount: 0,
        conflicts: [],
      };
    }

    const writes = [];
    try {
      this.registry.attestGitBinary();
      await this.gitNulStreamer({
        gitBinary: this.registry.gitBinary,
        disabledHooksPath: this.registry.disabledHooksPath,
        knownHostsPath: this.registry.knownHostsPath,
        args: this.mirrorArgs(entry, [
          "diff",
          "--name-only",
          "--no-renames",
          "--diff-filter=ACMRTUXB",
          "-z",
          head,
          candidateSha,
          "--",
        ]),
        commandId: "base.candidate-write-paths",
        timeoutMs: 120_000,
        env: {
          GIT_ALLOW_PROTOCOL: "file",
          GIT_PROTOCOL_FROM_USER: "0",
        },
        maxTotalBytes: 128 * 1024 * 1024,
        maxRecords: 250_000,
        maxRecordBytes: 16 * 1024,
        onRecord(record) {
          const value = repositoryRelativePath(record, {
            label: "candidate-write-path",
          });
          writes.push({
            key: repositoryPathComparisonKey(value, { ignoreCase }),
            path: value,
          });
        },
      });
    } catch (error) {
      throw new GitControllerError(
        "BASE_SYNC_IGNORED_COLLISION_SCAN_FAILED",
        "Candidate write paths could not be bounded and verified",
        { phase: "candidate-write-paths" },
        { cause: error },
      );
    }

    writes.sort((left, right) => (
      left.key < right.key ? -1 : (left.key > right.key ? 1 : 0)
    ));
    const uniqueWrites = [];
    const writeByKey = new Map();
    for (const write of writes) {
      if (writeByKey.has(write.key)) continue;
      writeByKey.set(write.key, write);
      uniqueWrites.push(write);
    }
    if (!uniqueWrites.length) {
      return {
        eligible: true,
        blockerCode: null,
        status: "VERIFIED",
        candidateWriteCount: 0,
        ignoredPathCount: 0,
        conflictCount: 0,
        conflicts: [],
      };
    }

    let ignoredPathCount = 0;
    let conflictCount = 0;
    const conflicts = [];
    try {
      this.registry.attestGitBinary();
      await this.gitNulStreamer({
        gitBinary: this.registry.gitBinary,
        disabledHooksPath: this.registry.disabledHooksPath,
        knownHostsPath: this.registry.knownHostsPath,
        args: this.baseArgs(entry, [
          "ls-files",
          "--others",
          "--ignored",
          "--exclude-standard",
          "--directory",
          "--no-empty-directory",
          "-z",
          "--",
        ]),
        commandId: "base.ignored-paths",
        timeoutMs: 120_000,
        env: {
          GIT_ALLOW_PROTOCOL: "file",
          GIT_PROTOCOL_FROM_USER: "0",
        },
        maxTotalBytes: 256 * 1024 * 1024,
        maxRecords: 1_000_000,
        maxRecordBytes: 16 * 1024,
        onRecord(record) {
          ignoredPathCount += 1;
          const ignoredPath = repositoryRelativePath(record, {
            allowDirectorySuffix: true,
            label: "ignored-path",
          });
          const candidate = findRepositoryPathCollision(
            uniqueWrites,
            writeByKey,
            ignoredPath,
            { ignoreCase },
          );
          if (candidate) {
            conflictCount += 1;
            if (conflicts.length < 50) {
              conflicts.push({
                ignoredPath,
                candidatePath: candidate.path,
              });
            }
          }
        },
      });
    } catch (error) {
      throw new GitControllerError(
        "BASE_SYNC_IGNORED_COLLISION_SCAN_FAILED",
        "Ignored working-tree paths could not be bounded and verified",
        { phase: "ignored-paths" },
        { cause: error },
      );
    }

    return {
      eligible: conflictCount === 0,
      blockerCode: conflictCount ? "BASE_SYNC_BLOCKED_IGNORED_COLLISION" : null,
      status: conflictCount ? "BLOCKED" : "VERIFIED",
      candidateWriteCount: uniqueWrites.length,
      ignoredPathCount,
      conflictCount,
      conflicts,
    };
  }

  async preflight(entry, branch, candidateSha) {
    // Inspect the raw local config before any Git command is allowed to use
    // the repository. --no-includes plus an exact key allowlist prevents
    // include/url/protocol/filter/credential and custom-driver execution.
    const localPolicy = await this.localRepositoryPolicy(entry);
    const candidateSubmodules = await this.candidateSubmodulePreflight(entry, candidateSha);
    const topLevel = canonicalizeExistingDirectory((await this.run(entry, this.baseArgs(entry, [
      "rev-parse",
      "--show-toplevel",
    ]), {
      commandId: "base.preflight-toplevel",
    })).stdout.trim(), { label: "base repository top-level" });
    if (pathKey(topLevel) !== pathKey(entry.basePath)) {
      throw new GitControllerError(
        "GIT_CONTROLLER_BASE_BINDING_DRIFT",
        "Base repository top-level changed from the registered path",
      );
    }
    const commonDir = canonicalizeExistingDirectory((await this.run(entry, this.baseArgs(entry, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]), {
      commandId: "base.preflight-common-dir",
    })).stdout.trim(), { label: "base repository common directory" });
    if (!pathInside(entry.basePath, commonDir)) {
      throw new GitControllerError(
        "GIT_CONTROLLER_LINKED_BASE_REJECTED",
        "Registered base repository shares a Git common directory outside its top-level",
      );
    }
    const branchResult = await this.run(entry, this.baseArgs(entry, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "HEAD",
    ]), {
      commandId: "base.preflight-branch",
      okExitCodes: [0, 1],
    });
    const currentBranch = branchResult.exitCode === 0 ? branchResult.stdout.trim() : null;
    const head = normalizeSha((await this.run(entry, this.baseArgs(entry, [
      "rev-parse",
      "--verify",
      "HEAD^{commit}",
    ]), {
      commandId: "base.preflight-head",
    })).stdout.trim(), { label: "base HEAD" });
    const status = statusClassification((await this.run(entry, this.baseArgs(entry, [
      "status",
      "--porcelain=v2",
      "--untracked-files=all",
      "--ignored=matching",
    ]), {
      commandId: "base.preflight-status",
    })).stdout);
    const inProgressNames = [
      "MERGE_HEAD",
      "rebase-merge",
      "rebase-apply",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
      "BISECT_LOG",
      "index.lock",
    ];
    const inProgress = [];
    for (const name of inProgressNames) {
      const markerPath = await this.gitPath(entry, name);
      if (!pathInside(entry.basePath, markerPath) && !pathInside(commonDir, markerPath)) {
        throw new GitControllerError(
          "GIT_CONTROLLER_GIT_PATH_DRIFT",
          "Git operation marker resolved outside the registered repository",
          { marker: name },
        );
      }
      if (fs.existsSync(markerPath)) inProgress.push(name);
    }
    const shallow = (await this.run(entry, this.baseArgs(entry, [
      "rev-parse",
      "--is-shallow-repository",
    ]), {
      commandId: "base.preflight-shallow",
    })).stdout.trim() === "true";
    const submoduleResult = await this.run(entry, this.baseArgs(entry, [
      "submodule",
      "status",
      "--recursive",
    ]), {
      commandId: "base.preflight-submodules",
      okExitCodes: [0, 1, 128],
    });
    const unsafeSubmodules = submoduleResult.stdout
      .split(/\r?\n/)
      .filter((line) => /^[-+U]/.test(line));
    const hooksPath = localPolicy.hooksPath;
    const relationship = await this.classifyRelationship(entry, head, candidateSha);
    let ignoredPathSafety = {
      eligible: true,
      blockerCode: null,
      status: "NOT_APPLICABLE",
      candidateWriteCount: 0,
      ignoredPathCount: 0,
      conflictCount: 0,
      conflicts: [],
    };
    if (
      candidateSubmodules.eligible
      && !inProgress.length
      && currentBranch === branch
      && status.clean
      && !shallow
      && !unsafeSubmodules.length
      && status.ignored.length
      && ["UNCHANGED", "FAST_FORWARD"].includes(relationship)
    ) {
      ignoredPathSafety = await this.ignoredPathCollisionPreflight(
        entry,
        head,
        candidateSha,
        { ignoreCase: localPolicy.ignoreCase },
      );
    }

    let blockerCode = null;
    if (!candidateSubmodules.eligible) blockerCode = candidateSubmodules.blockerCode;
    else if (inProgress.length) blockerCode = "BASE_SYNC_BLOCKED_OPERATION_IN_PROGRESS";
    else if (currentBranch !== branch) blockerCode = "BASE_SYNC_BLOCKED_WRONG_BRANCH";
    else if (status.tracked.length) blockerCode = "BASE_SYNC_BLOCKED_DIRTY";
    else if (status.untracked.length) blockerCode = "BASE_SYNC_BLOCKED_UNTRACKED";
    else if (shallow) blockerCode = "BASE_SYNC_BLOCKED_SHALLOW";
    else if (unsafeSubmodules.length) blockerCode = "BASE_SYNC_BLOCKED_SUBMODULE";
    else if (!ignoredPathSafety.eligible) blockerCode = ignoredPathSafety.blockerCode;
    else if (relationship === "BASE_AHEAD") blockerCode = "BASE_SYNC_BLOCKED_AHEAD";
    else if (relationship === "BASE_DIVERGED") blockerCode = "BASE_SYNC_BLOCKED_DIVERGED";

    return {
      eligible: !blockerCode,
      blockerCode,
      relationship,
      head,
      currentBranch,
      topLevel,
      commonDir,
      clean: status.clean,
      trackedChanges: status.tracked,
      untrackedChanges: status.untracked,
      inProgress,
      shallow,
      unsafeSubmodules,
      candidateSubmodules,
      ignoredPathSafety,
      hooksPath,
      ignoreCase: localPolicy.ignoreCase,
      configFingerprint: localPolicy.configFingerprint,
      infoAttributesFingerprint: localPolicy.infoAttributesFingerprint,
      remoteFingerprint: entry.remoteFingerprint,
    };
  }

  async acceptedCandidate(entry, branch) {
    if (!fs.existsSync(entry.mirrorPath)) {
      throw new GitControllerError(
        "GIT_CONTROLLER_MIRROR_NOT_INITIALIZED",
        "Managed mirror has not been initialized",
      );
    }
    const accepted = await this.mirror.readAccepted(entry, branch);
    if (!accepted.acceptedSha || !accepted.state) {
      throw new GitControllerError(
        "GIT_CONTROLLER_ACCEPTED_SHA_MISSING",
        "No validated accepted SHA exists for this branch",
      );
    }
    if (accepted.state.remoteFingerprint !== entry.remoteFingerprint) {
      throw new GitControllerError(
        "GIT_CONTROLLER_REMOTE_FINGERPRINT_DRIFT",
        "Accepted mirror state belongs to a different remote fingerprint",
      );
    }
    return accepted;
  }

  async preview({ repositoryId, branch: branchValue, ttlMs } = {}) {
    const { entry, branch } = await this.registry.resolve(repositoryId, branchValue);
    const previewId = randomUUID();
    const lease = this.leaseManager.acquire(entry, {
      operationId: previewId,
      kind: "base-preview",
    });
    try {
      lease.assertCurrent();
      const accepted = await this.acceptedCandidate(entry, branch);
      const checks = await this.preflight(entry, branch, accepted.acceptedSha);
      const now = Date.now();
      const stored = this.persistence.createGitControllerPreview({
        previewId,
        repositoryId: entry.repositoryId,
        kind: BASE_PREVIEW_KIND,
        branch,
        expectedHead: checks.head,
        candidateSha: accepted.acceptedSha,
        mirrorGeneration: accepted.state.generation,
        relationship: checks.relationship,
        eligible: checks.eligible,
        blockerCode: checks.blockerCode,
        remoteFingerprint: entry.remoteFingerprint,
        payload: {
          currentBranch: checks.currentBranch,
          clean: checks.clean,
          trackedChangeCount: checks.trackedChanges.length,
          untrackedChangeCount: checks.untrackedChanges.length,
          inProgress: checks.inProgress,
          shallow: checks.shallow,
          unsafeSubmoduleCount: checks.unsafeSubmodules.length,
          candidateSubmodules: checks.candidateSubmodules,
          ignoredPathSafety: checks.ignoredPathSafety,
          hooksPath: checks.hooksPath,
          configFingerprint: checks.configFingerprint,
          infoAttributesFingerprint: checks.infoAttributesFingerprint,
        },
        createdAt: now,
        expiresAt: now + Math.max(10_000, Number(ttlMs) || this.previewTtlMs),
      });
      return {
        previewId: stored.previewId,
        previewVersion: stored.previewVersion,
        repositoryId: entry.repositoryId,
        branch,
        expectedHead: checks.head,
        candidateSha: accepted.acceptedSha,
        mirrorGeneration: accepted.state.generation,
        relationship: checks.relationship,
        eligible: checks.eligible,
        blockerCode: checks.blockerCode,
        checks: stored.payload,
        expiresAt: stored.expiresAt,
      };
    } finally {
      lease.release();
    }
  }

  validateExecutionPreview({
    entry,
    branch,
    preview,
    previewVersion,
    expectedHead,
    candidateSha,
  }) {
    if (
      !preview
      || preview.kind !== BASE_PREVIEW_KIND
      || preview.repositoryId !== entry.repositoryId
      || preview.branch !== branch
    ) {
      throw new GitControllerError(
        "GIT_CONTROLLER_PREVIEW_MISMATCH",
        "Base sync preview does not match the requested repository and branch",
      );
    }
    if (preview.status !== "ACTIVE" || preview.expiresAt <= Date.now()) {
      throw new GitControllerError("GIT_CONTROLLER_PREVIEW_EXPIRED", "Base sync preview expired");
    }
    if (Number(preview.previewVersion) !== Number(previewVersion)) {
      throw new GitControllerError(
        "GIT_CONTROLLER_PREVIEW_VERSION_MISMATCH",
        "Base sync preview version changed",
      );
    }
    const expected = normalizeSha(expectedHead, { label: "expected base HEAD" });
    const candidate = normalizeSha(candidateSha, { label: "candidate SHA" });
    if (
      preview.expectedHead !== expected
      || preview.candidateSha !== candidate
      || preview.remoteFingerprint !== entry.remoteFingerprint
    ) {
      throw new GitControllerError(
        "GIT_CONTROLLER_PREVIEW_STALE",
        "Base sync exact SHA fields no longer match the preview",
      );
    }
    if (!preview.eligible) {
      throw new GitControllerError(
        preview.blockerCode || "GIT_CONTROLLER_PREVIEW_BLOCKED",
        "Base sync preview is blocked by repository state",
        { checks: preview.payload || null },
      );
    }
    return { expected, candidate };
  }

  async verifyAcceptedStillCurrent(entry, branch, preview, candidate) {
    const accepted = await this.acceptedCandidate(entry, branch);
    if (
      accepted.acceptedSha !== candidate
      || Number(accepted.state.generation) !== Number(preview.mirrorGeneration)
    ) {
      throw new GitControllerError(
        "GIT_CONTROLLER_PREVIEW_STALE",
        "Managed mirror accepted SHA or generation changed after preview",
      );
    }
    return accepted;
  }

  assertRecoveryPreview(operation, entry) {
    const preview = this.persistence.getGitControllerPreview(operation.previewId);
    if (
      !preview
      || preview.kind !== BASE_PREVIEW_KIND
      || preview.repositoryId !== entry.repositoryId
      || preview.branch !== operation.branch
      || preview.expectedHead !== operation.expectedHead
      || preview.candidateSha !== operation.candidateSha
      || preview.remoteFingerprint !== entry.remoteFingerprint
      || !preview.eligible
    ) {
      throw new GitControllerError(
        "GIT_CONTROLLER_BASE_RECOVERY_REQUIRED",
        "Interrupted base synchronization no longer has an exact durable preview binding",
        { operationId: operation.operationId },
      );
    }
    return preview;
  }

  async inspectRecoveryLocalState(entry) {
    const localPolicy = await this.localRepositoryPolicy(entry);
    const topLevel = canonicalizeExistingDirectory((await this.run(
      entry,
      this.baseArgs(entry, ["rev-parse", "--show-toplevel"]),
      { commandId: "base.recovery-toplevel" },
    )).stdout.trim(), { label: "base recovery top-level" });
    if (pathKey(topLevel) !== pathKey(entry.basePath)) {
      throw new GitControllerError(
        "GIT_CONTROLLER_BASE_BINDING_DRIFT",
        "Base repository top-level changed during startup recovery",
      );
    }
    const commonDir = canonicalizeExistingDirectory((await this.run(
      entry,
      this.baseArgs(entry, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ]),
      { commandId: "base.recovery-common-dir" },
    )).stdout.trim(), { label: "base recovery common directory" });
    if (!pathInside(entry.basePath, commonDir)) {
      throw new GitControllerError(
        "GIT_CONTROLLER_LINKED_BASE_REJECTED",
        "Registered base repository shares recovery state outside its top-level",
      );
    }
    const branchResult = await this.run(entry, this.baseArgs(entry, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "HEAD",
    ]), {
      commandId: "base.recovery-branch",
      okExitCodes: [0, 1],
    });
    const head = normalizeSha((await this.run(entry, this.baseArgs(entry, [
      "rev-parse",
      "--verify",
      "HEAD^{commit}",
    ]), {
      commandId: "base.recovery-head",
    })).stdout.trim(), { label: "base recovery HEAD" });
    const status = statusClassification((await this.run(entry, this.baseArgs(entry, [
      "status",
      "--porcelain=v2",
      "--untracked-files=all",
    ]), {
      commandId: "base.recovery-status",
    })).stdout);
    const inProgress = [];
    for (const name of [
      "MERGE_HEAD",
      "rebase-merge",
      "rebase-apply",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
      "BISECT_LOG",
      "index.lock",
    ]) {
      const markerPath = await this.gitPath(entry, name);
      if (!pathInside(entry.basePath, markerPath) && !pathInside(commonDir, markerPath)) {
        throw new GitControllerError(
          "GIT_CONTROLLER_GIT_PATH_DRIFT",
          "Git recovery marker resolved outside the registered repository",
          { marker: name },
        );
      }
      if (fs.existsSync(markerPath)) inProgress.push(name);
    }
    return {
      head,
      currentBranch: branchResult.exitCode === 0 ? branchResult.stdout.trim() : null,
      clean: status.clean,
      inProgress,
      hooksPath: localPolicy.hooksPath,
      configFingerprint: localPolicy.configFingerprint,
      infoAttributesFingerprint: localPolicy.infoAttributesFingerprint,
    };
  }

  async verifyPostApplyState(entry, branch, candidate, preview) {
    await this.registry.verify(entry.repositoryId);
    const verified = await this.preflight(entry, branch, candidate);
    if (
      verified.head !== candidate
      || verified.currentBranch !== branch
      || !verified.clean
      || verified.inProgress.length
      || verified.hooksPath !== String(preview.payload?.hooksPath || "")
      || verified.configFingerprint !== String(preview.payload?.configFingerprint || "")
      || (verified.infoAttributesFingerprint || null)
        !== (preview.payload?.infoAttributesFingerprint || null)
    ) {
      throw new GitControllerError(
        "GIT_CONTROLLER_POST_VERIFY_FAILED",
        "Base repository failed exact-SHA post verification",
        {
          expectedHead: candidate,
          actualHead: verified.head,
          currentBranch: verified.currentBranch,
          clean: verified.clean,
          inProgress: verified.inProgress,
        },
      );
    }
    return verified;
  }

  async recover() {
    const operations = listAllRecoverableOperations(this.persistence, {
      operationType: BASE_OPERATION_TYPE,
    });
    const unresolved = [];
    let safelyFailed = 0;
    let succeeded = 0;
    for (const operation of operations) {
      let lease = null;
      let reclaimed = false;
      try {
        const entry = this.registry.get(operation.repositoryId);
        this.leaseManager.reclaimOrphanedOperation(entry, operation);
        reclaimed = true;
        const branch = String(operation.branch || "");
        const expected = normalizeSha(operation.expectedHead, {
          label: "base recovery before HEAD",
        });
        const candidate = normalizeSha(operation.candidateSha, {
          label: "base recovery target HEAD",
        });
        const preview = this.assertRecoveryPreview(operation, entry);
        const phases = this.persistence.listGitControllerJournal(operation.operationId)
          .map((row) => row.phase);
        const reachedApplying = phases.includes("BASE_APPLYING");
        const reachedApplied = phases.includes("BASE_APPLIED");
        lease = this.leaseManager.acquire(entry, {
          operationId: operation.operationId,
          kind: "base-sync-recovery",
        });
        lease.assertCurrent();
        await this.registry.verify(entry.repositoryId);
        const state = await this.inspectRecoveryLocalState(entry);
        const policyUnchanged = (
          state.currentBranch === branch
          && state.clean
          && state.inProgress.length === 0
          && state.hooksPath === String(preview.payload?.hooksPath || "")
          && state.configFingerprint === String(preview.payload?.configFingerprint || "")
          && (state.infoAttributesFingerprint || null)
            === (preview.payload?.infoAttributesFingerprint || null)
        );

        if (
          state.head === candidate
          && policyUnchanged
          && (reachedApplying || reachedApplied)
        ) {
          const verified = await this.verifyPostApplyState(
            entry,
            branch,
            candidate,
            preview,
          );
          const result = {
            ok: true,
            operationId: operation.operationId,
            replayed: false,
            recovered: true,
            resultCode: "PASS",
            repositoryId: entry.repositoryId,
            branch,
            beforeHead: expected,
            head: verified.head,
            candidateSha: candidate,
            mirrorGeneration: preview.mirrorGeneration,
            relationship: preview.relationship,
          };
          const existingPassAudit = this.persistence.listGitControllerAudit({
            operationId: operation.operationId,
          }).some((row) => (
            row.action === "base.fast-forward.apply"
            && row.result === "PASS"
            && row.beforeSha === expected
            && row.candidateSha === candidate
          ));
          if (!existingPassAudit) {
            this.audit.write({
              operation,
              commandId: BASE_COMMAND_ID,
              action: "base.fast-forward.apply",
              branch,
              beforeSha: expected,
              candidateSha: candidate,
              result: "PASS",
              reason: "startup-recovery",
              durationMs: Math.max(0, Date.now() - Number(operation.startedAt || 0)),
              fencingToken: lease.fencingToken,
              actor: "controller:base-recovery",
              details: {
                recovered: true,
                recoveredFromPhase: operation.phase,
                mirrorGeneration: preview.mirrorGeneration,
              },
            });
          }
          this.journal.succeed(operation, result, lease.fencingToken);
          succeeded += 1;
          continue;
        }

        if (
          state.head === expected
          && policyUnchanged
          && !reachedApplied
        ) {
          const interrupted = new GitControllerError(
            "GIT_CONTROLLER_INTERRUPTED_BEFORE_BASE_APPLY",
            "Interrupted base synchronization was safely closed before the base HEAD moved",
            {
              operationId: operation.operationId,
              beforeHead: expected,
              targetHead: candidate,
            },
          );
          this.audit.write({
            operation,
            commandId: BASE_COMMAND_ID,
            action: "base.fast-forward.recovery",
            branch,
            beforeSha: expected,
            candidateSha: candidate,
            result: "FAIL",
            reason: interrupted.code,
            durationMs: Math.max(0, Date.now() - Number(operation.startedAt || 0)),
            fencingToken: lease.fencingToken,
            actor: "controller:base-recovery",
            details: { recoveredFromPhase: operation.phase },
          });
          this.journal.fail(operation, interrupted, {
            fencingToken: lease.fencingToken,
          });
          safelyFailed += 1;
          continue;
        }

        throw new GitControllerError(
          "GIT_CONTROLLER_BASE_RECOVERY_REQUIRED",
          "Interrupted base synchronization cannot be reconciled from exact HEAD and clean-state evidence",
          {
            operationId: operation.operationId,
            phase: operation.phase,
            beforeHead: expected,
            targetHead: candidate,
            actualHead: state.head,
            currentBranch: state.currentBranch,
            clean: state.clean,
            inProgress: state.inProgress,
          },
        );
      } catch (rawError) {
        const error = asControllerError(rawError, "GIT_CONTROLLER_BASE_RECOVERY_REQUIRED");
        if (reclaimed) {
          try {
            this.journal.fail(operation, error, {
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
        "GIT_CONTROLLER_BASE_RECOVERY_BLOCKED",
        "One or more base synchronization operations require administrative recovery",
        { errors: unresolved.map((error) => error.code) },
      );
    }
    return {
      recovered: operations.length,
      safelyFailed,
      succeeded,
    };
  }

  async execute({
    repositoryId,
    branch: branchValue,
    previewId,
    previewVersion,
    expectedHead: expectedHeadValue,
    candidateSha: candidateValue,
    idempotencyKey: idempotencyValue,
    actor = null,
  } = {}) {
    const idempotencyKey = assertIdempotencyKey(idempotencyValue);
    const { entry, branch } = await this.registry.resolve(repositoryId, branchValue);
    const expectedInput = normalizeSha(expectedHeadValue, { label: "expected base HEAD" });
    const candidateInput = normalizeSha(candidateValue, { label: "candidate SHA" });
    const replayBinding = {
      previewId,
      branch,
      expectedHead: expectedInput,
      candidateSha: candidateInput,
    };
    const existing = this.persistence.getGitControllerOperationByIdempotency(
      entry.repositoryId,
      BASE_OPERATION_TYPE,
      idempotencyKey,
    );
    if (existing) {
      assertReplayBinding(existing, replayBinding);
      return replayOrThrow(existing);
    }
    const preview = this.persistence.getGitControllerPreview(previewId);
    const { expected, candidate } = this.validateExecutionPreview({
      entry,
      branch,
      preview,
      previewVersion,
      expectedHead: expectedInput,
      candidateSha: candidateInput,
    });
    const begun = this.journal.begin({
      repositoryId: entry.repositoryId,
      operationType: BASE_OPERATION_TYPE,
      commandId: BASE_COMMAND_ID,
      idempotencyKey,
      previewId,
      branch,
      expectedHead: expected,
      candidateSha: candidate,
    });
    if (!begun.created) {
      assertReplayBinding(begun.operation, replayBinding);
      return replayOrThrow(begun.operation);
    }
    const operation = begun.operation;
    const consumed = this.persistence.consumeGitControllerPreview(previewId, operation.operationId);
    if (!consumed?.ok) {
      const error = new GitControllerError(
        "GIT_CONTROLLER_PREVIEW_CONSUMED",
        "Base sync preview was already consumed",
      );
      this.journal.fail(operation, error);
      throw error;
    }

    const startedAt = Date.now();
    let lease = null;
    let applyStarted = false;
    let baseApplied = false;
    let relationship = preview.relationship;
    try {
      lease = this.leaseManager.acquire(entry, {
        operationId: operation.operationId,
        kind: "base-sync",
      });
      lease.assertCurrent();
      await this.verifyAcceptedStillCurrent(entry, branch, preview, candidate);
      let checks = await this.preflight(entry, branch, candidate);
      if (!checks.eligible) {
        throw new GitControllerError(
          checks.blockerCode,
          "Base repository no longer satisfies the synchronization preflight",
          {
            relationship: checks.relationship,
            candidateSubmodules: checks.candidateSubmodules,
            ignoredPathSafety: checks.ignoredPathSafety,
          },
        );
      }
      if (checks.head !== expected) {
        throw new GitControllerError(
          "GIT_CONTROLLER_EXPECTED_HEAD_CHANGED",
          "Base HEAD changed after preview",
          { expectedHead: expected, actualHead: checks.head },
        );
      }
      relationship = checks.relationship;
      this.journal.append(operation, "BASE_PREFLIGHT_PASSED", {
        beforeHead: expected,
        targetHead: candidate,
        branch,
        relationship,
      }, lease.fencingToken);
      lease.assertCurrent();
      await this.registry.verify(entry.repositoryId);
      const acceptedRef = this.mirror.acceptedRef(entry, branch);
      const destinationRef = controllerBaseDestinationRef(entry.remoteId, branch);
      const fetchCapabilityEnv = await this.capabilityEnv({
        entry,
        operation,
        lease,
        commandId: "base.fetch-accepted",
        branch,
        expectedHead: expected,
        candidateSha: candidate,
        hooksPath: checks.hooksPath,
      });
      await this.runMutation(entry, this.baseArgs(entry, [
        "fetch",
        "--no-auto-maintenance",
        "--atomic",
        "--no-tags",
        "--no-write-fetch-head",
        entry.mirrorPath,
        `${acceptedRef}:${destinationRef}`,
      ]), lease, {
        commandId: "base.fetch-accepted",
        timeoutMs: 120_000,
        env: fetchCapabilityEnv,
        trustedHooksPath: checks.hooksPath || null,
      });
      const fetchedSha = normalizeSha((await this.run(entry, this.baseArgs(entry, [
        "rev-parse",
        "--verify",
        `${destinationRef}^{commit}`,
      ]), {
        commandId: "base.verify-fetched-ref",
      })).stdout.trim(), { label: "base fetched SHA" });
      if (fetchedSha !== candidate) {
        throw new GitControllerError(
          "GIT_CONTROLLER_FETCHED_SHA_MISMATCH",
          "Base repository fetched ref differs from the previewed candidate",
          { candidateSha: candidate, fetchedSha },
        );
      }
      await this.verifyAcceptedStillCurrent(entry, branch, preview, candidate);
      checks = await this.preflight(entry, branch, candidate);
      if (!checks.eligible || checks.head !== expected || checks.currentBranch !== branch) {
        throw new GitControllerError(
          checks.blockerCode || "GIT_CONTROLLER_PREFLIGHT_CHANGED",
          "Base repository changed while accepted objects were being fetched",
          {
            expectedHead: expected,
            actualHead: checks.head,
            candidateSubmodules: checks.candidateSubmodules,
            ignoredPathSafety: checks.ignoredPathSafety,
          },
        );
      }
      if (
        checks.hooksPath !== String(preview.payload?.hooksPath || "")
        || checks.configFingerprint !== String(preview.payload?.configFingerprint || "")
        || (checks.infoAttributesFingerprint || null)
          !== (preview.payload?.infoAttributesFingerprint || null)
      ) {
        throw new GitControllerError(
          "GIT_CONTROLLER_BASE_CONFIG_DRIFT",
          "Base repository local policy files changed after preview",
        );
      }
      relationship = checks.relationship;
      if (!["UNCHANGED", "FAST_FORWARD"].includes(relationship)) {
        throw new GitControllerError(
          relationship === "BASE_AHEAD"
            ? "BASE_SYNC_BLOCKED_AHEAD"
            : "BASE_SYNC_BLOCKED_DIVERGED",
          "Base repository cannot be fast-forwarded to the exact accepted SHA",
          { relationship },
        );
      }
      this.journal.append(operation, "BASE_OBJECTS_FETCHED", {
        beforeHead: expected,
        targetHead: candidate,
        destinationRef,
        relationship,
      }, lease.fencingToken);
      if (expected !== candidate) {
        lease.assertCurrent();
        await this.registry.verify(entry.repositoryId);
        applyStarted = true;
        this.journal.append(operation, "BASE_APPLYING", {
          beforeHead: expected,
          targetHead: candidate,
          branch,
        }, lease.fencingToken);
        const mergeCapabilityEnv = await this.capabilityEnv({
          entry,
          operation,
          lease,
          commandId: "base.merge-fast-forward",
          branch,
          expectedHead: expected,
          candidateSha: candidate,
          hooksPath: checks.hooksPath,
        });
        await this.runMutation(entry, this.baseArgs(entry, [
          "merge",
          "--ff-only",
          "--no-overwrite-ignore",
          candidate,
        ]), lease, {
          commandId: "base.merge-fast-forward",
          timeoutMs: 120_000,
          env: mergeCapabilityEnv,
          trustedHooksPath: checks.hooksPath || null,
        });
      }
      baseApplied = true;
      this.journal.append(operation, "BASE_APPLIED", {
        beforeHead: expected,
        targetHead: candidate,
        branch,
      }, lease.fencingToken);
      lease.assertCurrent();
      const verified = await this.verifyPostApplyState(entry, branch, candidate, preview);
      const result = {
        ok: true,
        operationId: operation.operationId,
        replayed: false,
        resultCode: "PASS",
        repositoryId: entry.repositoryId,
        branch,
        beforeHead: expected,
        head: verified.head,
        candidateSha: candidate,
        mirrorGeneration: preview.mirrorGeneration,
        relationship,
      };
      this.audit.write({
        operation,
        commandId: BASE_COMMAND_ID,
        action: "base.fast-forward.apply",
        branch,
        beforeSha: expected,
        candidateSha: candidate,
        result: "PASS",
        durationMs: Date.now() - startedAt,
        fencingToken: lease.fencingToken,
        actor,
        details: {
          mirrorGeneration: preview.mirrorGeneration,
          relationship,
        },
      });
      this.journal.succeed(operation, result, lease.fencingToken);
      return result;
    } catch (rawError) {
      const error = asControllerError(rawError);
      let currentHead = null;
      let dirty = null;
      try {
        currentHead = normalizeSha((await this.run(entry, this.baseArgs(entry, [
          "rev-parse",
          "--verify",
          "HEAD^{commit}",
        ]), {
          commandId: "base.failure-head",
        })).stdout.trim(), { label: "base failure HEAD" });
        dirty = !statusClassification((await this.run(entry, this.baseArgs(entry, [
          "status",
          "--porcelain=v2",
          "--untracked-files=all",
        ]), {
          commandId: "base.failure-status",
        })).stdout).clean;
      } catch {}
      const recoveryRequired = baseApplied
        || (applyStarted && (currentHead !== expected || dirty === true))
        || error.code === "GIT_CONTROLLER_POST_VERIFY_FAILED";
      try {
        this.audit.write({
          operation,
          commandId: BASE_COMMAND_ID,
          action: "base.fast-forward.apply",
          branch,
          beforeSha: expected,
          candidateSha: candidate,
          result: recoveryRequired ? "RECOVERY_REQUIRED" : "FAIL",
          reason: error.code,
          durationMs: Date.now() - startedAt,
          fencingToken: lease?.fencingToken || null,
          actor,
          details: { relationship, currentHead, dirty },
        });
      } catch (auditError) {
        const auditFailure = asControllerError(auditError, "GIT_CONTROLLER_AUDIT_WRITE_FAILED");
        this.journal.fail(operation, auditFailure, {
          fencingToken: lease?.fencingToken || null,
          recoveryRequired: true,
          data: { precedingError: error.code, currentHead, dirty },
        });
        throw auditFailure;
      }
      this.journal.fail(operation, error, {
        fencingToken: lease?.fencingToken || null,
        recoveryRequired,
        data: { currentHead, dirty },
      });
      throw error;
    } finally {
      lease?.release();
    }
  }
}

export function createBaseSyncService(options = {}) {
  return new BaseSyncService(options);
}

export {
  BASE_COMMAND_ID,
  BASE_OPERATION_TYPE,
  BASE_PREVIEW_KIND,
};
