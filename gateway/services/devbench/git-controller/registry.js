import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import * as defaultPersistence from "../../../db/sqlite.js";
import {
  GitControllerError,
  assertBranchName,
  assertRemoteId,
  canonicalizeExistingDirectory,
  canonicalizeManagedPath,
  pathInside,
  pathKey,
  resolveExecutable,
  runGitFile,
  safeRemoteUrl,
} from "./path-security.js";

const DEFAULT_BASE_SYNC_POLICY = Object.freeze({
  requireClean: true,
  fastForwardOnly: true,
  allowCheckout: false,
  allowAutomaticStash: false,
  allowMergeCommit: false,
  allowRemoteRewind: false,
  autoApplyWhenClean: false,
});

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function normalizedLocalRemote(value) {
  const input = String(value || "").trim();
  const resolved = canonicalizeExistingDirectory(input, { label: "registered local remote" });
  return `file://${pathKey(resolved).replace(/\\/g, "/")}`;
}

function normalizeSshUsername(value) {
  if (String(value || "").includes("%")) {
    throw new GitControllerError("GIT_CONTROLLER_REMOTE_INVALID", "Registered SSH username is invalid");
  }
  let username;
  try {
    username = decodeURIComponent(String(value || ""));
  } catch {
    throw new GitControllerError("GIT_CONTROLLER_REMOTE_INVALID", "Registered SSH username is invalid");
  }
  if (!username || !/^[A-Za-z0-9._-]{1,128}$/.test(username)) {
    throw new GitControllerError("GIT_CONTROLLER_REMOTE_INVALID", "Registered SSH username is invalid");
  }
  return username;
}

function normalizeSshHost(value) {
  const host = String(value || "").trim().toLowerCase();
  const dns = /^(?=.{1,253}$)[a-z0-9.-]+$/
    .test(host)
    && host.split(".").every((label) => (
      !!label
      && label.length <= 63
      && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
    ));
  const ipv6 = /^\[[0-9a-f:.]+\]$/;
  if (!dns && !ipv6.test(host)) {
    throw new GitControllerError("GIT_CONTROLLER_REMOTE_INVALID", "Registered SSH host is invalid");
  }
  return host;
}

function normalizeSshRepositoryPath(value) {
  if (String(value || "").includes("%")) {
    throw new GitControllerError("GIT_CONTROLLER_REMOTE_INVALID", "Registered SSH path is invalid");
  }
  let repositoryPath;
  try {
    repositoryPath = decodeURIComponent(String(value || ""));
  } catch {
    throw new GitControllerError("GIT_CONTROLLER_REMOTE_INVALID", "Registered SSH path is invalid");
  }
  repositoryPath = repositoryPath
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/i, "");
  if (
    !repositoryPath
    || repositoryPath.length > 4096
    || !/^[A-Za-z0-9._~+/-]+$/.test(repositoryPath)
    || repositoryPath.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new GitControllerError("GIT_CONTROLLER_REMOTE_INVALID", "Registered SSH path is invalid");
  }
  return repositoryPath;
}

export function canonicalRemoteIdentity(value) {
  const input = String(value || "").trim();
  if (!input) {
    throw new GitControllerError("GIT_CONTROLLER_REMOTE_MISSING", "Registered remote URL is empty");
  }
  if (input.includes("\0") || /[\r\n]/.test(input)) {
    throw new GitControllerError("GIT_CONTROLLER_REMOTE_INVALID", "Registered remote URL is invalid");
  }
  if (path.isAbsolute(input) || /^[A-Za-z]:[\\/]/.test(input)) {
    return normalizedLocalRemote(input);
  }
  if (/^file:\/\//i.test(input)) {
    let filePath;
    try {
      filePath = decodeURIComponent(new URL(input).pathname);
      if (process.platform === "win32" && /^\/[A-Za-z]:\//.test(filePath)) filePath = filePath.slice(1);
    } catch {
      throw new GitControllerError("GIT_CONTROLLER_REMOTE_INVALID", "Registered file remote is invalid");
    }
    return normalizedLocalRemote(filePath);
  }
  const scp = input.match(/^([^@\s/:]+)@([^:\s/]+):(.+)$/);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
    const username = normalizeSshUsername(scp[1]);
    const host = normalizeSshHost(scp[2]);
    const repositoryPath = normalizeSshRepositoryPath(scp[3]);
    return `ssh://${username}@${host}:22/${repositoryPath}`;
  }
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    throw new GitControllerError("GIT_CONTROLLER_REMOTE_INVALID", "Registered remote URL is invalid");
  }
  if (!["https:", "http:", "ssh:", "git:"].includes(parsed.protocol)) {
    throw new GitControllerError(
      "GIT_CONTROLLER_REMOTE_SCHEME_REJECTED",
      "Registered remote scheme is not allowed",
    );
  }
  if (parsed.password || (parsed.protocol !== "ssh:" && parsed.username)) {
    throw new GitControllerError(
      "GIT_CONTROLLER_EMBEDDED_CREDENTIAL_REJECTED",
      "Registered remote URLs must not contain embedded credentials",
    );
  }
  if (parsed.search || parsed.hash) {
    throw new GitControllerError(
      "GIT_CONTROLLER_REMOTE_INVALID",
      "Registered remote URLs must not contain query or fragment data",
    );
  }
  if (parsed.protocol === "ssh:") {
    const username = normalizeSshUsername(parsed.username);
    const host = normalizeSshHost(parsed.hostname);
    const port = parsed.port ? Number(parsed.port) : 22;
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      throw new GitControllerError("GIT_CONTROLLER_REMOTE_INVALID", "Registered SSH port is invalid");
    }
    const repositoryPath = normalizeSshRepositoryPath(parsed.pathname);
    return `ssh://${username}@${host}:${port}/${repositoryPath}`;
  }
  parsed.username = "";
  parsed.password = "";
  parsed.hash = "";
  parsed.search = "";
  parsed.hostname = parsed.hostname.toLowerCase();
  if (
    (parsed.protocol === "https:" && parsed.port === "443")
    || (parsed.protocol === "http:" && parsed.port === "80")
  ) {
    parsed.port = "";
  }
  parsed.pathname = parsed.pathname.replace(/\/+/g, "/").replace(/\/+$/g, "").replace(/\.git$/i, "");
  if (!parsed.hostname || !parsed.pathname || parsed.pathname.includes("..")) {
    throw new GitControllerError("GIT_CONTROLLER_REMOTE_INVALID", "Registered remote URL is invalid");
  }
  return parsed.toString().replace(/\/$/, "");
}

export function fingerprintRemote(value) {
  return sha256(canonicalRemoteIdentity(value));
}

function normalizeLogicalId(definition) {
  const value = String(
    definition?.logicalDefinitionId
      || definition?.definitionId
      || definition?.id
      || "",
  ).trim();
  if (!value || value.length > 200 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new GitControllerError(
      "GIT_CONTROLLER_LOGICAL_ID_INVALID",
      "Logical repository definition id is required",
    );
  }
  return value;
}

function normalizeCredentialRef(value, { required = false } = {}) {
  const credentialRef = String(value || "").trim();
  if (!credentialRef && !required) return "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(credentialRef)) {
    throw new GitControllerError(
      "GIT_CONTROLLER_CREDENTIAL_REF_INVALID",
      "Repository credentialRef must be a static protected descriptor id",
    );
  }
  return credentialRef;
}

function normalizeCredentialDescriptors(value) {
  const source = value instanceof Map ? [...value.entries()] : Object.entries(value || {});
  const descriptors = new Map();
  for (const [rawRef, rawDescriptor] of source) {
    const credentialRef = normalizeCredentialRef(rawRef, { required: true });
    if (!rawDescriptor || typeof rawDescriptor !== "object" || Array.isArray(rawDescriptor)) {
      throw new GitControllerError(
        "GIT_CONTROLLER_SSH_DESCRIPTOR_INVALID",
        "Protected SSH credential descriptor is invalid",
        { credentialRef },
      );
    }
    const descriptor = {};
    for (const field of ["sshBinaryPath", "privateKeyPath", "knownHostsPath"]) {
      const configured = String(rawDescriptor[field] || "").trim();
      if (!configured || !path.isAbsolute(configured) || configured.includes("\0")) {
        throw new GitControllerError(
          "GIT_CONTROLLER_SSH_DESCRIPTOR_INVALID",
          "Protected SSH credential descriptor requires absolute deployment paths",
          { credentialRef },
        );
      }
      descriptor[field] = path.resolve(configured);
    }
    descriptors.set(credentialRef, Object.freeze(descriptor));
  }
  return descriptors;
}

function normalizeBranches(value) {
  const branches = [...new Set((Array.isArray(value) ? value : [])
    .map((branch) => assertBranchName(branch)))].sort();
  if (!branches.length) {
    throw new GitControllerError(
      "GIT_CONTROLLER_BRANCHES_MISSING",
      "At least one allowed branch is required",
    );
  }
  return branches;
}

function normalizePublicationPolicy(value) {
  if (value == null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GitControllerError(
      "GIT_CONTROLLER_PUBLICATION_POLICY_INVALID",
      "Publication evidence policy must be a protected exact-SHA positive ledger object",
    );
  }
  const allowedFields = new Set([
    "schemaVersion",
    "mode",
    "evidenceId",
    "publishedCommitShas",
  ]);
  const unknownFields = Object.keys(value).filter((field) => !allowedFields.has(field));
  const schemaVersion = Number(value.schemaVersion);
  const mode = String(value.mode || "").trim();
  const evidenceId = String(value.evidenceId || "").trim();
  const rawShas = value.publishedCommitShas;
  if (
    unknownFields.length
    || schemaVersion !== 1
    || mode !== "PROTECTED_EXACT_SHA_POSITIVE_LEDGER"
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(evidenceId)
    || !Array.isArray(rawShas)
    || rawShas.length > 4096
  ) {
    throw new GitControllerError(
      "GIT_CONTROLLER_PUBLICATION_POLICY_INVALID",
      "Publication evidence policy is not a bounded protected exact-SHA positive ledger",
      { unknownFields: unknownFields.sort() },
    );
  }
  const publishedCommitShas = [...new Set(rawShas.map((rawSha) => {
    const sha = String(rawSha || "").trim().toLowerCase();
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha)) {
      throw new GitControllerError(
        "GIT_CONTROLLER_PUBLICATION_POLICY_INVALID",
        "Publication evidence ledger contains an invalid full commit SHA",
      );
    }
    return sha;
  }))].sort();
  const normalized = {
    schemaVersion,
    mode,
    evidenceId,
    publishedCommitShas,
  };
  return Object.freeze({
    ...normalized,
    publishedCommitShas: Object.freeze([...publishedCommitShas]),
    evidenceDigest: sha256(JSON.stringify(normalized)),
  });
}

function expectedRemoteFingerprints(definition) {
  const fingerprints = new Set();
  for (const value of Array.isArray(definition?.expectedRemoteFingerprints)
    ? definition.expectedRemoteFingerprints
    : []) {
    const fingerprint = String(value || "").trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(fingerprint)) {
      throw new GitControllerError(
        "GIT_CONTROLLER_REMOTE_FINGERPRINT_INVALID",
        "Expected remote fingerprint must be a SHA256 hex digest",
      );
    }
    fingerprints.add(fingerprint);
  }
  for (const value of Array.isArray(definition?.expectedRemoteUrls)
    ? definition.expectedRemoteUrls
    : []) {
    const remote = String(value || "").trim();
    if (remote) fingerprints.add(fingerprintRemote(remote));
  }
  if (!fingerprints.size) {
    throw new GitControllerError(
      "GIT_CONTROLLER_EXPECTED_REMOTE_REQUIRED",
      "Repository definition must include an expected remote URL or fingerprint",
    );
  }
  return [...fingerprints].sort();
}

function normalizeSubmoduleAllowlist(definition) {
  const values = [];
  for (const field of ["allowedSubmoduleUrls", "submoduleAllowlist"]) {
    const configured = definition?.[field];
    if (configured == null) continue;
    if (!Array.isArray(configured)) {
      throw new GitControllerError(
        "GIT_CONTROLLER_SUBMODULE_ALLOWLIST_INVALID",
        "Submodule allowlist must be an array of static remote URLs",
        { field },
      );
    }
    for (const item of configured) {
      const value = typeof item === "string" ? item : item?.url;
      if (typeof value !== "string" || !value.trim()) {
        throw new GitControllerError(
          "GIT_CONTROLLER_SUBMODULE_ALLOWLIST_INVALID",
          "Submodule allowlist entries must be static remote URLs",
          { field },
        );
      }
      const remoteUrl = value.trim();
      const canonicalRemote = canonicalRemoteIdentity(remoteUrl);
      values.push({
        remoteUrl,
        safeRemoteUrl: safeRemoteUrl(remoteUrl),
        canonicalRemote,
        remoteFingerprint: sha256(canonicalRemote),
      });
    }
  }
  const byFingerprint = new Map();
  for (const item of values) {
    const existing = byFingerprint.get(item.remoteFingerprint);
    if (existing && existing.canonicalRemote !== item.canonicalRemote) {
      throw new GitControllerError(
        "GIT_CONTROLLER_SUBMODULE_FINGERPRINT_COLLISION",
        "Submodule allowlist contains conflicting canonical remotes",
      );
    }
    byFingerprint.set(item.remoteFingerprint, item);
  }
  return [...byFingerprint.values()].sort((left, right) => (
    left.remoteFingerprint.localeCompare(right.remoteFingerprint)
  ));
}

function strictPolicy(value = {}) {
  const policy = { ...DEFAULT_BASE_SYNC_POLICY };
  for (const key of Object.keys(policy)) {
    if (Object.hasOwn(value || {}, key)) policy[key] = value[key] === true;
  }
  if (
    policy.requireClean !== true
    || policy.fastForwardOnly !== true
    || policy.allowCheckout
    || policy.allowAutomaticStash
    || policy.allowMergeCommit
    || policy.allowRemoteRewind
  ) {
    throw new GitControllerError(
      "GIT_CONTROLLER_UNSAFE_POLICY",
      "Repository policy weakens mandatory base protection",
    );
  }
  return Object.freeze(policy);
}

function configDigest(entry) {
  return sha256(JSON.stringify({
    repositoryId: entry.repositoryId,
    remoteId: entry.remoteId,
    remoteFingerprint: entry.remoteFingerprint,
    remoteScheme: entry.remoteScheme,
    credentialRef: entry.credentialRef,
    credentialStatus: entry.credentialStatus,
    baseRealpath: pathKey(entry.basePath),
    baseGitCommonRealpath: pathKey(entry.baseGitCommonPath),
    mirrorRealpath: pathKey(entry.mirrorPath),
    logicalDefinitionIds: entry.logicalDefinitionIds,
    allowedBranches: entry.allowedBranches,
    expectedRemoteFingerprints: entry.expectedRemoteFingerprints,
    allowedSubmoduleRemoteFingerprints: entry.allowedSubmoduleRemoteFingerprints,
    publicationPolicy: entry.publicationPolicy,
    baseSyncPolicy: entry.baseSyncPolicy,
    isolationMode: entry.isolationMode,
  }));
}

function immutableEntry(entry) {
  return Object.freeze({
    ...entry,
    logicalDefinitionIds: Object.freeze([...entry.logicalDefinitionIds]),
    allowedBranches: Object.freeze([...entry.allowedBranches]),
    expectedRemoteFingerprints: Object.freeze([...entry.expectedRemoteFingerprints]),
    allowedSubmoduleRemoteFingerprints: Object.freeze([
      ...entry.allowedSubmoduleRemoteFingerprints,
    ]),
    allowedSubmoduleRemotes: Object.freeze(entry.allowedSubmoduleRemotes.map((item) => (
      Object.freeze({ ...item })
    ))),
    publicationPolicy: entry.publicationPolicy
      ? Object.freeze({
          ...entry.publicationPolicy,
          publishedCommitShas: Object.freeze([
            ...entry.publicationPolicy.publishedCommitShas,
          ]),
        })
      : null,
    baseSyncPolicy: Object.freeze({ ...entry.baseSyncPolicy }),
  });
}

export class RepositoryRegistry {
  constructor({
    dataRoot,
    gitBinary = "git",
    gitBinaryAttestor = null,
    knownHostsPath = null,
    credentialDescriptors = {},
    credentialDescriptorAttestor = null,
    persistence = defaultPersistence,
    gitRunner = runGitFile,
  } = {}) {
    this.dataRoot = canonicalizeExistingDirectory(dataRoot, { label: "Git Controller data root" });
    this.gitBinary = resolveExecutable(gitBinary);
    this.gitBinaryAttestor = gitBinaryAttestor;
    this.credentialDescriptors = normalizeCredentialDescriptors(credentialDescriptors);
    if (
      credentialDescriptorAttestor != null
      && typeof credentialDescriptorAttestor !== "function"
    ) {
      throw new GitControllerError(
        "GIT_CONTROLLER_SSH_ATTESTOR_INVALID",
        "SSH descriptor attestor must be a Controller-owned function",
      );
    }
    this.credentialDescriptorAttestor = credentialDescriptorAttestor;
    this.disabledHooksPath = path.join(this.dataRoot, "git-hooks-disabled");
    fs.mkdirSync(this.disabledHooksPath, { recursive: true, mode: 0o700 });
    this.knownHostsPath = knownHostsPath
      ? path.resolve(knownHostsPath)
      : path.join(this.dataRoot, "ssh-known-hosts");
    if (!fs.existsSync(this.knownHostsPath)) {
      fs.writeFileSync(this.knownHostsPath, "", { encoding: "utf8", mode: 0o600, flag: "wx" });
    }
    this.persistence = persistence;
    this.gitRunner = gitRunner;
    this.entries = new Map();
    this.logicalToRepositoryIds = new Map();
    this.basePathToRepositoryIds = new Map();
    this.registrationErrors = [];
  }

  static async create(options = {}) {
    const registry = new RepositoryRegistry(options);
    const definitions = Array.isArray(options.definitions) ? options.definitions : [];
    await registry.verifyGitExecutable();
    for (const definition of definitions) {
      try {
        await registry.register(definition);
      } catch (error) {
        if (options.continueOnDefinitionError !== true) throw error;
        registry.registrationErrors.push(Object.freeze({
          logicalDefinitionId: String(
            definition?.logicalDefinitionId
            || definition?.definitionId
            || definition?.id
            || "",
          ).trim(),
          displayName: String(definition?.displayName || "").trim(),
          code: String(error?.code || "GIT_CONTROLLER_REGISTRATION_FAILED"),
          message: String(error?.message || "Repository registration failed").slice(0, 500),
        }));
      }
    }
    registry.registrationErrors = Object.freeze([...registry.registrationErrors]);
    return registry;
  }

  async verifyGitExecutable() {
    this.attestGitBinary();
    const result = await this.gitRunner({
      gitBinary: this.gitBinary,
      disabledHooksPath: this.disabledHooksPath,
      knownHostsPath: this.knownHostsPath,
      args: ["--version"],
      commandId: "git.version",
    });
    if (!/^git version \d+/i.test(result.stdout.trim())) {
      throw new GitControllerError(
        "GIT_CONTROLLER_EXECUTABLE_UNVERIFIED",
        "Configured Git executable did not identify itself as Git",
      );
    }
    return result.stdout.trim();
  }

  attestGitBinary() {
    if (this.gitBinaryAttestor) return this.gitBinaryAttestor();
    const stat = fs.lstatSync(this.gitBinary);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new GitControllerError(
        "GIT_CONTROLLER_EXECUTABLE_DRIFT",
        "Configured Git executable is no longer a single regular file",
      );
    }
    return { path: this.gitBinary };
  }

  attestCredentialDescriptor(credentialRefValue) {
    const credentialRef = normalizeCredentialRef(credentialRefValue, { required: true });
    const descriptor = this.credentialDescriptors.get(credentialRef);
    if (!descriptor) {
      throw new GitControllerError(
        "GIT_CONTROLLER_SSH_DESCRIPTOR_MISSING",
        "Repository credentialRef has no protected SSH descriptor",
        { credentialRef },
      );
    }
    if (this.credentialDescriptorAttestor) {
      this.credentialDescriptorAttestor(credentialRef);
    } else {
      for (const field of ["sshBinaryPath", "privateKeyPath", "knownHostsPath"]) {
        let stat;
        try {
          stat = fs.lstatSync(descriptor[field]);
        } catch {}
        if (!stat?.isFile() || stat.isSymbolicLink()) {
          throw new GitControllerError(
            "GIT_CONTROLLER_SSH_DESCRIPTOR_DRIFT",
            "Protected SSH credential descriptor is unavailable or unsafe",
            { credentialRef },
          );
        }
      }
    }
    return descriptor;
  }

  transportFor(entryValue, { remoteUrl = "" } = {}) {
    const entry = typeof entryValue === "string" ? this.get(entryValue) : entryValue;
    if (!entry || !this.entries.has(entry.repositoryId)) {
      throw new GitControllerError(
        "GIT_CONTROLLER_REPOSITORY_NOT_REGISTERED",
        "Repository is not registered for transport resolution",
      );
    }
    const canonicalRemote = remoteUrl ? canonicalRemoteIdentity(remoteUrl) : "";
    const remoteScheme = canonicalRemote
      ? canonicalRemote.slice(0, canonicalRemote.indexOf(":") + 1)
      : entry.remoteScheme;
    if (remoteScheme !== "ssh:") return null;
    return this.attestCredentialDescriptor(entry.credentialRef);
  }

  async inspectBase(basePath, remoteId) {
    const baseRealpath = canonicalizeExistingDirectory(basePath, { label: "base repository" });
    const commonArgs = [
      "-c",
      `safe.directory=${baseRealpath.replace(/\\/g, "/")}`,
      "-C",
      baseRealpath,
    ];
    const topLevel = (await this.gitRunner({
      gitBinary: this.gitBinary,
      disabledHooksPath: this.disabledHooksPath,
      knownHostsPath: this.knownHostsPath,
      args: [...commonArgs, "rev-parse", "--show-toplevel"],
      commandId: "registry.base-toplevel",
    })).stdout.trim();
    const topLevelRealpath = canonicalizeExistingDirectory(topLevel, { label: "base repository top-level" });
    if (pathKey(topLevelRealpath) !== pathKey(baseRealpath)) {
      throw new GitControllerError(
        "GIT_CONTROLLER_BASE_NOT_TOPLEVEL",
        "Configured base path is not the repository top-level",
      );
    }
    const baseGitCommonPath = canonicalizeExistingDirectory(
      (await this.gitRunner({
        gitBinary: this.gitBinary,
        disabledHooksPath: this.disabledHooksPath,
        knownHostsPath: this.knownHostsPath,
        args: [
          ...commonArgs,
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ],
        commandId: "registry.base-git-common-dir",
      })).stdout.trim(),
      { label: "base repository Git common directory" },
    );
    if (!pathInside(baseRealpath, baseGitCommonPath)) {
      throw new GitControllerError(
        "GIT_CONTROLLER_LINKED_BASE_REJECTED",
        "Registered base repository shares a Git common directory outside its top-level",
      );
    }
    const remoteUrl = (await this.gitRunner({
      gitBinary: this.gitBinary,
      disabledHooksPath: this.disabledHooksPath,
      knownHostsPath: this.knownHostsPath,
      args: [...commonArgs, "remote", "get-url", remoteId],
      commandId: "registry.remote-get-url",
    })).stdout.trim();
    const canonicalRemote = canonicalRemoteIdentity(remoteUrl);
    return {
      baseRealpath,
      baseGitCommonPath,
      remoteUrl,
      canonicalRemote,
      remoteFingerprint: sha256(canonicalRemote),
    };
  }

  async register(definition = {}) {
    const logicalDefinitionId = normalizeLogicalId(definition);
    const remoteId = assertRemoteId(definition.remoteId || "origin");
    const allowedBranches = normalizeBranches(definition.allowedBranches);
    const publicationPolicy = normalizePublicationPolicy(definition.publicationPolicy);
    const expectedFingerprints = expectedRemoteFingerprints(definition);
    const configuredSubmoduleRemotes = normalizeSubmoduleAllowlist(definition);
    const inspected = await this.inspectBase(definition.basePath, remoteId);
    const remoteScheme = inspected.canonicalRemote.slice(
      0,
      inspected.canonicalRemote.indexOf(":") + 1,
    ).toLowerCase();
    if (["http:", "git:"].includes(remoteScheme)) {
      throw new GitControllerError(
        "GIT_CONTROLLER_INSECURE_REMOTE_REJECTED",
        "Managed mirrors require HTTPS or an explicitly managed secure transport",
        { remoteScheme },
      );
    }
    const credentialRef = normalizeCredentialRef(definition.credentialRef, {
      required: remoteScheme === "ssh:",
    });
    if (remoteScheme === "ssh:") {
      this.attestCredentialDescriptor(credentialRef);
    } else if (credentialRef) {
      throw new GitControllerError(
        "GIT_CONTROLLER_CREDENTIAL_REF_UNEXPECTED",
        "credentialRef is only valid for protected SSH repository definitions",
      );
    }
    const credentialStatus = remoteScheme === "file:"
      ? "NOT_REQUIRED"
      : (
        remoteScheme === "ssh:"
          ? "READY"
          : (definition.allowAnonymousRemote === true ? "READY" : "MISSING")
      );
    if (!expectedFingerprints.includes(inspected.remoteFingerprint)) {
      throw new GitControllerError(
        "GIT_CONTROLLER_REMOTE_NOT_REGISTERED",
        "The base repository remote does not match the shared repository definition",
        {
          logicalDefinitionId,
          actualFingerprint: inspected.remoteFingerprint,
        },
      );
    }
    const repositoryId = `repo-${sha256(
      `${inspected.remoteFingerprint}\0${pathKey(inspected.baseRealpath)}`,
    )}`;
    const defaultMirrorPath = path.join(this.dataRoot, "git-mirrors", repositoryId, "repo.git");
    const mirrorPath = canonicalizeManagedPath(
      definition.mirrorPath || defaultMirrorPath,
      {
        allowedRoot: this.dataRoot,
        label: "managed bare mirror",
        allowMissing: true,
        expectedType: "directory",
      },
    );
    const mirrorCollision = [...this.entries.values()].find((candidate) => (
      candidate.repositoryId !== repositoryId
      && pathKey(candidate.mirrorPath) === pathKey(mirrorPath)
    ));
    const persistedRepositories = this.persistence.listGitControllerRepositories?.();
    if (
      persistedRepositories !== undefined
      && !Array.isArray(persistedRepositories)
    ) {
      throw new GitControllerError(
        "GIT_CONTROLLER_REGISTRY_PERSISTENCE_INVALID",
        "Persisted Git Controller repository catalog is invalid",
      );
    }
    for (const candidate of persistedRepositories || []) {
      if (
        !String(candidate?.repositoryId || "").trim()
        || !path.isAbsolute(String(candidate?.mirrorRealpath || ""))
      ) {
        throw new GitControllerError(
          "GIT_CONTROLLER_REGISTRY_PERSISTENCE_INVALID",
          "Persisted Git Controller mirror binding is invalid",
        );
      }
    }
    const persistedMirrorCollision = (persistedRepositories || []).find((candidate) => (
      String(candidate?.repositoryId || "") !== repositoryId
      && pathKey(candidate?.mirrorRealpath) === pathKey(mirrorPath)
    ));
    if (mirrorCollision || persistedMirrorCollision) {
      throw new GitControllerError(
        "GIT_CONTROLLER_MIRROR_PATH_CONFLICT",
        "Different physical repositories cannot share one managed bare mirror path",
        {
          repositoryId,
          conflictingRepositoryId: String(
            mirrorCollision?.repositoryId
            || persistedMirrorCollision?.repositoryId
            || "",
          ),
          persistedBinding: !!persistedMirrorCollision,
        },
      );
    }
    const lockPath = path.join(path.dirname(mirrorPath), "locks", "controller.lock");
    canonicalizeManagedPath(path.dirname(lockPath), {
      allowedRoot: this.dataRoot,
      label: "repository lock directory",
      allowMissing: true,
    });
    const policy = strictPolicy(definition.baseSyncPolicy);
    const previous = this.entries.get(repositoryId);
    if (previous && previous.credentialRef !== credentialRef) {
      throw new GitControllerError(
        "GIT_CONTROLLER_CREDENTIAL_BINDING_CONFLICT",
        "Physical repository definitions must bind the same credentialRef",
        { repositoryId },
      );
    }
    if (
      previous
      && (previous.publicationPolicy?.evidenceDigest || null)
        !== (publicationPolicy?.evidenceDigest || null)
    ) {
      throw new GitControllerError(
        "GIT_CONTROLLER_PUBLICATION_POLICY_CONFLICT",
        "Physical repository definitions must bind the same publication evidence policy",
        { repositoryId },
      );
    }
    const logicalDefinitionIds = [...new Set([
      ...(previous?.logicalDefinitionIds || []),
      logicalDefinitionId,
    ])].sort();
    const combinedBranches = [...new Set([
      ...(previous?.allowedBranches || []),
      ...allowedBranches,
    ])].sort();
    const combinedSubmoduleRemotesByFingerprint = new Map(
      (previous?.allowedSubmoduleRemotes || []).map((item) => [item.remoteFingerprint, item]),
    );
    for (const item of configuredSubmoduleRemotes) {
      combinedSubmoduleRemotesByFingerprint.set(item.remoteFingerprint, item);
    }
    const allowedSubmoduleRemotes = [...combinedSubmoduleRemotesByFingerprint.values()]
      .sort((left, right) => left.remoteFingerprint.localeCompare(right.remoteFingerprint));
    const allowedSubmoduleRemoteFingerprints = allowedSubmoduleRemotes
      .map((item) => item.remoteFingerprint);
    const entry = immutableEntry({
      repositoryId,
      displayName: String(definition.displayName || logicalDefinitionId).trim(),
      logicalDefinitionIds,
      basePath: inspected.baseRealpath,
      baseGitCommonPath: inspected.baseGitCommonPath,
      mirrorPath,
      lockPath,
      remoteId,
      remoteUrl: inspected.remoteUrl,
      safeRemoteUrl: safeRemoteUrl(inspected.remoteUrl),
      canonicalRemote: inspected.canonicalRemote,
      remoteFingerprint: inspected.remoteFingerprint,
      remoteScheme,
      credentialRef,
      credentialStatus,
      expectedRemoteFingerprints: [...new Set([
        ...(previous?.expectedRemoteFingerprints || []),
        ...expectedFingerprints,
      ])].sort(),
      allowedSubmoduleRemoteFingerprints,
      allowedSubmoduleRemotes,
      allowedBranches: combinedBranches,
      publicationPolicy,
      baseOwnershipMode: "MANAGED_SYNC",
      baseSyncPolicy: policy,
      isolationMode: String(definition.isolationMode || "separate-worker-identity"),
      registeredAt: previous?.registeredAt || Date.now(),
    });
    const digest = configDigest(entry);
    const persisted = this.persistence.getGitControllerRepository?.(repositoryId);
    if (persisted && persisted.configDigest !== digest) {
      const persistedCommonPath = String(persisted.baseGitCommonRealpath || "").trim();
      const samePhysicalBinding = pathKey(persisted.baseRealpath) === pathKey(entry.basePath)
        && (
          !persistedCommonPath
          || pathKey(persistedCommonPath) === pathKey(entry.baseGitCommonPath)
        )
        && pathKey(persisted.mirrorRealpath) === pathKey(entry.mirrorPath)
        && persisted.remoteFingerprint === entry.remoteFingerprint;
      if (!samePhysicalBinding) {
        throw new GitControllerError(
          "GIT_CONTROLLER_REGISTRY_BINDING_DRIFT",
          "Persisted physical repository binding does not match local configuration",
          { repositoryId },
        );
      }
    }
    this.entries.set(repositoryId, entry);
    const logicalRepositoryIds = this.logicalToRepositoryIds.get(logicalDefinitionId) || new Set();
    logicalRepositoryIds.add(repositoryId);
    this.logicalToRepositoryIds.set(logicalDefinitionId, logicalRepositoryIds);
    const baseKey = pathKey(entry.basePath);
    const baseRepositoryIds = this.basePathToRepositoryIds.get(baseKey) || new Set();
    baseRepositoryIds.add(repositoryId);
    this.basePathToRepositoryIds.set(baseKey, baseRepositoryIds);
    this.persistence.upsertGitControllerRepository?.({
      repositoryId,
      remoteId,
      remoteFingerprint: entry.remoteFingerprint,
      baseRealpath: entry.basePath,
      baseGitCommonRealpath: entry.baseGitCommonPath,
      mirrorRealpath: entry.mirrorPath,
      logicalDefinitionIds,
      allowedBranches: combinedBranches,
      configDigest: digest,
      registeredAt: entry.registeredAt,
      verifiedAt: Date.now(),
    });
    return entry;
  }

  list() {
    return [...this.entries.values()];
  }

  get(repositoryId) {
    const id = String(repositoryId || "").trim();
    const entry = this.entries.get(id);
    if (!entry) {
      throw new GitControllerError(
        "GIT_CONTROLLER_REPOSITORY_NOT_REGISTERED",
        "Repository id is not registered",
        { repositoryId: id },
      );
    }
    return entry;
  }

  getByLogicalDefinitionId(logicalDefinitionId, { basePath = "" } = {}) {
    const logicalId = String(logicalDefinitionId || "").trim();
    const repositoryIds = this.logicalToRepositoryIds.get(logicalId);
    if (!repositoryIds?.size) {
      throw new GitControllerError(
        "GIT_CONTROLLER_LOGICAL_REPOSITORY_NOT_REGISTERED",
        "Logical repository definition is not registered",
        { logicalDefinitionId: logicalId },
      );
    }
    let candidates = [...repositoryIds];
    if (String(basePath || "").trim()) {
      const canonicalBase = canonicalizeExistingDirectory(basePath, {
        label: "selected base repository",
      });
      candidates = candidates.filter((repositoryId) => (
        pathKey(this.get(repositoryId).basePath) === pathKey(canonicalBase)
      ));
      if (!candidates.length) {
        throw new GitControllerError(
          "GIT_CONTROLLER_BASE_NOT_REGISTERED",
          "Selected base path is not registered for this logical definition",
          { logicalDefinitionId: logicalId },
        );
      }
    }
    if (candidates.length !== 1) {
      throw new GitControllerError(
        "GIT_CONTROLLER_LOGICAL_REPOSITORY_AMBIGUOUS",
        "Logical repository definition maps to multiple physical checkouts",
        {
          logicalDefinitionId: logicalId,
          repositoryIds: candidates.sort(),
        },
      );
    }
    return this.get(candidates[0]);
  }

  getByBasePath(basePath) {
    const canonicalBase = canonicalizeExistingDirectory(basePath, {
      label: "selected base repository",
    });
    const repositoryIds = [...(this.basePathToRepositoryIds.get(pathKey(canonicalBase)) || [])];
    if (!repositoryIds.length) {
      throw new GitControllerError(
        "GIT_CONTROLLER_BASE_NOT_REGISTERED",
        "Selected base path is not registered",
      );
    }
    if (repositoryIds.length !== 1) {
      throw new GitControllerError(
        "GIT_CONTROLLER_BASE_REPOSITORY_AMBIGUOUS",
        "Selected base path maps to multiple physical repository identities",
        { repositoryIds: repositoryIds.sort() },
      );
    }
    return this.get(repositoryIds[0]);
  }

  assertBranch(repositoryId, branchValue) {
    const entry = this.get(repositoryId);
    const branch = assertBranchName(branchValue);
    if (!entry.allowedBranches.includes(branch)) {
      throw new GitControllerError(
        "GIT_CONTROLLER_BRANCH_NOT_ALLOWED",
        "Branch is not allowed for this repository",
        { repositoryId: entry.repositoryId, branch },
      );
    }
    return { entry, branch };
  }

  async verify(repositoryId) {
    const entry = this.get(repositoryId);
    if (entry.remoteScheme === "ssh:") this.attestCredentialDescriptor(entry.credentialRef);
    const inspected = await this.inspectBase(entry.basePath, entry.remoteId);
    if (
      pathKey(inspected.baseRealpath) !== pathKey(entry.basePath)
      || inspected.remoteFingerprint !== entry.remoteFingerprint
    ) {
      throw new GitControllerError(
        "GIT_CONTROLLER_REMOTE_FINGERPRINT_DRIFT",
        "Registered repository path or remote fingerprint changed",
        { repositoryId: entry.repositoryId },
      );
    }
    if (pathKey(inspected.baseGitCommonPath) !== pathKey(entry.baseGitCommonPath)) {
      throw new GitControllerError(
        "GIT_CONTROLLER_BASE_GIT_COMMON_DRIFT",
        "Registered base repository Git common directory changed",
        { repositoryId: entry.repositoryId },
      );
    }
    canonicalizeManagedPath(entry.mirrorPath, {
      allowedRoot: this.dataRoot,
      label: "managed bare mirror",
      allowMissing: true,
      expectedType: "directory",
    });
    this.persistence.upsertGitControllerRepository?.({
      repositoryId: entry.repositoryId,
      remoteId: entry.remoteId,
      remoteFingerprint: entry.remoteFingerprint,
      baseRealpath: entry.basePath,
      baseGitCommonRealpath: entry.baseGitCommonPath,
      mirrorRealpath: entry.mirrorPath,
      logicalDefinitionIds: entry.logicalDefinitionIds,
      allowedBranches: entry.allowedBranches,
      configDigest: configDigest(entry),
      registeredAt: entry.registeredAt,
      verifiedAt: Date.now(),
    });
    return entry;
  }

  async verifyWorkerProtectionBindings() {
    for (const entry of this.entries.values()) {
      await this.verify(entry.repositoryId);
    }
    return this.list();
  }

  async resolve(repositoryId, branchValue) {
    const { entry, branch } = this.assertBranch(repositoryId, branchValue);
    await this.verify(entry.repositoryId);
    return { entry, branch };
  }
}

export { DEFAULT_BASE_SYNC_POLICY };
