import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createHash,
  createPublicKey,
  randomBytes,
} from "node:crypto";
import {
  GIT_CONTROLLER_MAX_MESSAGE_BYTES,
  GIT_PROCESS_CONTAINMENT_MODES,
  createControllerRequest,
  currentProcessIdentity,
  publicKeyFingerprint,
  readProtectedFile,
  validateControllerEndpoint,
  verifyGitProcessContainmentReceiptEnvelope,
  verifyControllerResponseEnvelope,
} from "./git-controller-process-protocol.js";
import { GitControllerError } from "./git-controller/index.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
export const GIT_CONTROLLER_FIXED_CLIENT_CONFIG_PATH = path.resolve(
  MODULE_DIRECTORY,
  "../../config/git-controller-client.json",
);

function clientError(code, message, details = {}, cause) {
  return new GitControllerError(code, message, details, cause ? { cause } : undefined);
}

function safeConfigJson(configPath) {
  const buffer = readProtectedFile(configPath, {
    label: "Git Controller client configuration",
  });
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch (error) {
    throw clientError(
      "GIT_CONTROLLER_CLIENT_CONFIG_INVALID",
      "Git Controller client configuration is not valid JSON",
      {},
      error,
    );
  }
}

export function readGitControllerClientConfig({
  configPath = process.env.DEVBENCH_GIT_CONTROLLER_CLIENT_CONFIG
    || GIT_CONTROLLER_FIXED_CLIENT_CONFIG_PATH,
  gatewayIdentity = currentProcessIdentity(),
} = {}) {
  const sourcePath = String(configPath || "").trim();
  if (!sourcePath) {
    throw clientError(
      "GIT_CONTROLLER_CLIENT_CONFIG_REQUIRED",
      "Production requires a protected Git Controller client configuration",
    );
  }
  if (
    path.resolve(sourcePath) !== GIT_CONTROLLER_FIXED_CLIENT_CONFIG_PATH
    && String(process.env.NODE_ENV || "").toLowerCase() !== "test"
  ) {
    throw clientError(
      "GIT_CONTROLLER_CLIENT_CONFIG_PATH_INVALID",
      "Git Controller client configuration must use the fixed protected deployment path",
    );
  }
  const raw = safeConfigJson(sourcePath);
  const endpoint = validateControllerEndpoint(raw.endpoint);
  const expectedControllerIdentity = String(raw.expectedControllerIdentity || "").trim();
  const expectedEndpointAclFingerprint = String(
    raw.expectedEndpointAclFingerprint || "",
  ).trim().toLowerCase();
  if (!expectedControllerIdentity || expectedControllerIdentity === gatewayIdentity) {
    throw clientError(
      "GIT_CONTROLLER_IDENTITY_NOT_SEPARATE",
      "Git Controller must run under an OS identity distinct from Gateway",
    );
  }
  if (!/^[0-9a-f]{64}$/.test(expectedEndpointAclFingerprint)) {
    throw clientError(
      "GIT_CONTROLLER_ENDPOINT_ACL_ATTESTATION_REQUIRED",
      "Production requires a pinned Controller endpoint ACL attestation",
    );
  }
  const clientId = String(raw.clientId || "").trim();
  const ipcGid = raw.ipcGid;
  if (
    process.platform !== "win32"
    && (
      !Number.isSafeInteger(ipcGid)
      || ipcGid < 0
      || !/^uid:[0-9]+$/.test(expectedControllerIdentity)
      || !/^uid:[0-9]+$/.test(gatewayIdentity)
      || !new Set([
        typeof process.getgid === "function" ? process.getgid() : -1,
        ...(typeof process.getgroups === "function" ? process.getgroups() : []),
      ]).has(ipcGid)
    )
  ) {
    throw clientError(
      "GIT_CONTROLLER_IPC_GROUP_REQUIRED",
      "Unix Gateway client requires the protected numeric Controller ipcGid",
    );
  }
  const publicKeyBytes = readProtectedFile(raw.serverPublicKeyPath, {
    label: "Git Controller public trust anchor",
  });
  const publicKey = createPublicKey(publicKeyBytes);
  const expectedKeyFingerprint = publicKeyFingerprint(
    publicKey.export({ type: "spki", format: "der" }),
  );
  if (
    raw.serverPublicKeySha256
    && String(raw.serverPublicKeySha256).toLowerCase() !== expectedKeyFingerprint
  ) {
    throw clientError(
      "GIT_CONTROLLER_TRUST_ANCHOR_DRIFT",
      "Git Controller public trust anchor fingerprint has drifted",
    );
  }
  const secret = readProtectedFile(raw.clientSecretPath, {
    label: "Git Controller client authentication secret",
    secret: true,
  });
  if (secret.length < 32) {
    throw clientError(
      "GIT_CONTROLLER_CLIENT_SECRET_WEAK",
      "Git Controller client authentication secret must contain at least 32 bytes",
    );
  }
  const containmentRaw = raw.gitProcessContainment;
  const expectedMode = GIT_PROCESS_CONTAINMENT_MODES[process.platform];
  const containmentFields = new Set([
    "schemaVersion",
    "mode",
    "containerPolicyId",
    "policyDigest",
    "guardianPublicKeyPath",
    "guardianKeyId",
    "guardianBinarySha256",
    "gitBinarySha256",
  ]);
  if (
    !expectedMode
    || !containmentRaw
    || typeof containmentRaw !== "object"
    || Array.isArray(containmentRaw)
    || Object.keys(containmentRaw).some((key) => !containmentFields.has(key))
    || [...containmentFields].some((key) => !Object.hasOwn(containmentRaw, key))
    || Number(containmentRaw.schemaVersion) !== 2
    || containmentRaw.mode !== expectedMode
    || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(
      String(containmentRaw.containerPolicyId || ""),
    )
    || !/^[0-9a-f]{64}$/.test(String(containmentRaw.policyDigest || ""))
    || !/^[0-9a-f]{64}$/.test(String(containmentRaw.guardianKeyId || ""))
    || !/^[0-9a-f]{64}$/.test(String(containmentRaw.guardianBinarySha256 || ""))
    || !/^[0-9a-f]{64}$/.test(String(containmentRaw.gitBinarySha256 || ""))
  ) {
    throw clientError(
      "GIT_CONTROLLER_PROCESS_TREE_POLICY_REQUIRED",
      "Client configuration must pin the native guardian containment policy",
    );
  }
  let guardianPublicKey;
  try {
    guardianPublicKey = createPublicKey(readProtectedFile(
      containmentRaw.guardianPublicKeyPath,
      { label: "Git process-tree guardian public key" },
    ));
  } catch (error) {
    throw clientError(
      "GIT_CONTROLLER_PROCESS_TREE_GUARDIAN_KEY_INVALID",
      "Pinned native guardian public key is unavailable or invalid",
      {},
      error,
    );
  }
  const guardianKeyId = publicKeyFingerprint(
    guardianPublicKey.export({ type: "spki", format: "der" }),
  );
  if (guardianKeyId !== containmentRaw.guardianKeyId) {
    throw clientError(
      "GIT_CONTROLLER_PROCESS_TREE_GUARDIAN_KEY_DRIFT",
      "Native guardian public key does not match the pinned key id",
    );
  }
  const gitProcessContainmentPolicy = Object.freeze({
    schemaVersion: 2,
    mode: expectedMode,
    containerPolicyId: containmentRaw.containerPolicyId,
    policyDigest: containmentRaw.policyDigest,
    guardianKeyId,
    guardianBinarySha256: containmentRaw.guardianBinarySha256,
    gitBinarySha256: containmentRaw.gitBinarySha256,
    guardianPublicKey,
  });
  return Object.freeze({
    configPath: path.resolve(sourcePath),
    endpoint,
    expectedControllerIdentity,
    expectedEndpointAclFingerprint,
    expectedKeyFingerprint,
    publicKey,
    clientId,
    secret,
    gitProcessContainmentPolicy,
    gatewayIdentity,
    ipcGid: process.platform === "win32" ? null : ipcGid,
    timeoutMs: Math.max(1_000, Math.min(120_000, Number(raw.timeoutMs) || DEFAULT_TIMEOUT_MS)),
  });
}

function decodeControllerError(body) {
  const error = body?.error || {};
  return clientError(
    String(error.code || "GIT_CONTROLLER_REMOTE_ERROR"),
    String(error.message || "Git Controller command failed"),
    error.details && typeof error.details === "object" ? error.details : {},
  );
}

export class GitControllerProcessClient {
  constructor(config, {
    connect = net.createConnection,
    now = () => Date.now(),
  } = {}) {
    this.config = config;
    this.connect = connect;
    this.now = now;
    this.catalog = [];
    this.warnings = [];
  }

  async call(commandId, payload = {}) {
    if (process.platform !== "win32") {
      const stat = fs.lstatSync(this.config.endpoint);
      const expectedUid = Number(String(this.config.expectedControllerIdentity).slice(4));
      const descriptor = `unix-socket:uid:${stat.uid}:gid:${stat.gid}:mode:0660`;
      const fingerprint = createHash("sha256").update(descriptor).digest("hex");
      if (
        !stat.isSocket()
        || stat.isSymbolicLink()
        || stat.uid !== expectedUid
        || stat.gid !== this.config.ipcGid
        || (stat.mode & 0o777) !== 0o660
        || fingerprint !== this.config.expectedEndpointAclFingerprint
      ) {
        throw clientError(
          "GIT_CONTROLLER_ENDPOINT_ACL_DRIFT",
          "Live Unix Controller socket owner, group, mode, or pinned fingerprint has drifted",
        );
      }
    }
    const request = createControllerRequest({
      commandId,
      payload,
      clientId: this.config.clientId,
      clientIdentity: this.config.gatewayIdentity,
      secret: this.config.secret,
      now: this.now(),
    });
    const envelope = await new Promise((resolve, reject) => {
      let settled = false;
      let bytes = 0;
      let text = "";
      const socket = this.connect(this.config.endpoint);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(clientError(
          "GIT_CONTROLLER_UNAVAILABLE",
          "Timed out waiting for the independent Git Controller",
        ));
      }, this.config.timeoutMs);
      const finish = (callback) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
      };
      socket.setEncoding("utf8");
      socket.once("connect", () => {
        socket.write(`${JSON.stringify(request)}\n`);
      });
      socket.on("data", (chunk) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > GIT_CONTROLLER_MAX_MESSAGE_BYTES) {
          finish(() => {
            socket.destroy();
            reject(clientError(
              "GIT_CONTROLLER_RESPONSE_TOO_LARGE",
              "Git Controller response exceeded the protocol limit",
            ));
          });
          return;
        }
        text += chunk;
        const newline = text.indexOf("\n");
        if (newline < 0) return;
        finish(() => {
          socket.end();
          try {
            resolve(JSON.parse(text.slice(0, newline)));
          } catch (error) {
            reject(clientError(
              "GIT_CONTROLLER_RESPONSE_INVALID",
              "Git Controller returned invalid JSON",
              {},
              error,
            ));
          }
        });
      });
      socket.once("error", (error) => finish(() => reject(clientError(
        "GIT_CONTROLLER_UNAVAILABLE",
        "Independent Git Controller endpoint is unavailable",
        { cause: String(error?.code || "SOCKET_ERROR") },
        error,
      ))));
      socket.once("close", () => {
        if (!settled) {
          finish(() => reject(clientError(
            "GIT_CONTROLLER_UNAVAILABLE",
            "Independent Git Controller closed the connection without a response",
          )));
        }
      });
    });
    const verified = verifyControllerResponseEnvelope(envelope, {
      publicKey: this.config.publicKey,
      expectedEndpoint: this.config.endpoint,
      expectedControllerIdentity: this.config.expectedControllerIdentity,
      expectedEndpointAclFingerprint: this.config.expectedEndpointAclFingerprint,
      expectedKeyFingerprint: this.config.expectedKeyFingerprint,
      requestId: request.requestId,
      now: this.now(),
      gatewayIdentity: this.config.gatewayIdentity,
    });
    if (!verified.body?.ok) throw decodeControllerError(verified.body);
    return verified.body.data;
  }

  async initialize() {
    const attestationChallenge = randomBytes(24).toString("hex");
    const description = await this.call("runtime.describe", {
      attestationChallenge,
    });
    const containment = description?.gitProcessContainment;
    const policy = this.config.gitProcessContainmentPolicy;
    const descriptionFields = new Set([
      "isolationLevel",
      "gitProcessContainment",
      "adapter",
      "repositories",
      "warnings",
      "storyPathBudget",
    ]);
    const containmentFields = new Set(["isolationLevel", "receipt", "signature"]);
    if (
      !description
      || typeof description !== "object"
      || Array.isArray(description)
      || Object.keys(description).some((key) => !descriptionFields.has(key))
      || description.isolationLevel !== "STRONG"
      || !containment
      || typeof containment !== "object"
      || Array.isArray(containment)
      || Object.keys(containment).some((key) => !containmentFields.has(key))
      || [...containmentFields].some((key) => !Object.hasOwn(containment, key))
      || containment.isolationLevel !== "STRONG"
      || !policy
    ) {
      throw clientError(
        "GIT_CONTROLLER_ATTESTATION_WEAK",
        "Independent Git Controller did not return a guardian-signed STRONG receipt",
      );
    }
    let verified;
    try {
      const receipt = containment.receipt;
      verified = verifyGitProcessContainmentReceiptEnvelope({
        receipt,
        signature: containment.signature,
      }, {
        publicKey: policy.guardianPublicKey,
        platform: process.platform,
        mode: policy.mode,
        daemonInstanceId: receipt?.daemonInstanceId,
        ownerPid: receipt?.pid,
        ownerProcessStartIdentity: receipt?.processStartIdentity,
        controllerIdentity: this.config.expectedControllerIdentity,
        challenge: attestationChallenge,
        containerPolicyId: policy.containerPolicyId,
        containerEpoch: receipt?.containerEpoch,
        policyDigest: policy.policyDigest,
        guardianKeyId: policy.guardianKeyId,
        guardianBinarySha256: policy.guardianBinarySha256,
        gitBinarySha256: policy.gitBinarySha256,
        guardianInstanceId: receipt?.guardianInstanceId,
        now: this.now(),
      });
    } catch (error) {
      throw clientError(
        "GIT_CONTROLLER_ATTESTATION_WEAK",
        "Independent Git Controller guardian receipt verification failed",
        { cause: String(error?.code || "GUARDIAN_RECEIPT_INVALID") },
        error,
      );
    }
    this.gitProcessContainment = Object.freeze({
      isolationLevel: "STRONG",
      ...verified,
    });
    this.catalog = Array.isArray(description.repositories) ? description.repositories : [];
    this.warnings = Array.isArray(description.warnings) ? description.warnings : [];
    return this;
  }
}

function normalizePathKey(value) {
  const resolved = path.resolve(String(value || "")).replace(/[\\/]+/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function normalizeBaselineStrategy(value = "MERGE") {
  const normalized = String(value || "MERGE").trim().toUpperCase().replace(/-/g, "_");
  if (!["FF_ONLY", "MERGE"].includes(normalized)) {
    throw clientError(
      "STORY_BASELINE_STRATEGY_REJECTED",
      "Story baseline strategy must be FF_ONLY or MERGE",
    );
  }
  return normalized;
}

function createRegistryFacade(client) {
  const entries = client.catalog.map((entry) => Object.freeze({ ...entry }));
  const byId = new Map(entries.map((entry) => [entry.repositoryId, entry]));
  return Object.freeze({
    entries,
    get(repositoryId) {
      const entry = byId.get(String(repositoryId || ""));
      if (!entry) {
        throw clientError(
          "GIT_CONTROLLER_REPOSITORY_NOT_REGISTERED",
          "Repository ID is not registered by the independent Git Controller",
        );
      }
      return entry;
    },
    getByBasePath(basePath) {
      const key = normalizePathKey(basePath);
      const matches = entries.filter((entry) => {
        const baseKey = normalizePathKey(entry.basePath);
        return key === baseKey || key.startsWith(`${baseKey}/`);
      }).sort((left, right) => (
        normalizePathKey(right.basePath).length - normalizePathKey(left.basePath).length
      ));
      const longestLength = matches.length
        ? normalizePathKey(matches[0].basePath).length
        : 0;
      const best = matches.filter(
        (entry) => normalizePathKey(entry.basePath).length === longestLength,
      );
      if (best.length !== 1) {
        throw clientError(
          best.length
            ? "GIT_CONTROLLER_REPOSITORY_AMBIGUOUS"
            : "GIT_CONTROLLER_BASE_NOT_REGISTERED",
          "Base repository does not resolve to one managed physical repository",
        );
      }
      return best[0];
    },
    async verify(repositoryId) {
      return client.call("registry.verify", { repositoryId });
    },
    async resolve(repositoryId, branch) {
      const entry = this.get(repositoryId);
      if (!entry.allowedBranches.includes(branch)) {
        throw clientError(
          "GIT_CONTROLLER_BRANCH_NOT_ALLOWED",
          "Branch is not present in the static Controller registry",
        );
      }
      await client.call("registry.verify", { repositoryId });
      return { entry, branch };
    },
  });
}

export async function createGitControllerProcessRuntime(options = {}) {
  const config = options.config || readGitControllerClientConfig(options);
  const client = await new GitControllerProcessClient(config, options).initialize();
  const registry = createRegistryFacade(client);
  const call = (commandId) => (payload = {}) => client.call(commandId, payload);
  const controller = Object.freeze({
    registry,
    registrationErrors: client.warnings,
    leaseManager: Object.freeze({
      acquire() {
        throw clientError(
          "GIT_CONTROLLER_CROSS_PROCESS_LEASE_REQUIRED",
          "Gateway cannot acquire a Controller repository lease in process; move this operation behind a structured Controller command",
        );
      },
    }),
    mirror: Object.freeze({
      preview: call("mirror.preview"),
      execute: call("mirror.execute"),
      readAccepted(entry, branch) {
        return client.call("mirror.read-accepted", {
          repositoryId: entry.repositoryId,
          branch,
        });
      },
      resolveAcceptedCandidate: call("mirror.resolve-accepted"),
    }),
    base: Object.freeze({
      preflight(entry, branch, candidateSha) {
        return client.call("base.preflight", {
          repositoryId: entry.repositoryId,
          branch,
          candidateSha,
        });
      },
      preview: call("base.preview"),
      execute: call("base.execute"),
    }),
    syncStatus: call("sync.status"),
  });
  return Object.freeze({
    adapter: "process",
    isolationLevel: client.gitProcessContainment.isolationLevel,
    client,
    controller,
    hooks: Object.freeze({
      diagnose: call("hooks.diagnose"),
      preview: call("hooks.preview"),
      execute: call("hooks.execute"),
      standaloneUninstall: call("hooks.standalone-uninstall"),
    }),
    storyBaseline: Object.freeze({
      preview(payload = {}) {
        return client.call("story.baseline.preview", {
          tabId: payload.tabId,
          repositoryId: payload.repositoryId || payload.repository?.repositoryId,
          strategy: normalizeBaselineStrategy(payload.strategy),
        });
      },
      execute(payload = {}) {
        return client.call("story.baseline.execute", {
          tabId: payload.tabId,
          repositoryId: payload.repositoryId || payload.repository?.repositoryId,
          strategy: normalizeBaselineStrategy(payload.strategy),
          previewId: payload.previewId,
          previewVersion: payload.previewVersion,
          expectedHead: payload.expectedHead,
          candidateSha: payload.candidateSha,
          mirrorGeneration: payload.mirrorGeneration,
          idempotencyKey: payload.idempotencyKey,
          actor: payload.actor,
        });
      },
    }),
    accepted: Object.freeze({
      refresh: call("story.accepted.refresh"),
    }),
    storyRepositories: Object.freeze({
      provision(payload = {}) {
        const repositoryId = String(payload.repositoryId || "");
        const exactSha = String(payload.exactSha || "").toLowerCase();
        if (
          !String(payload.idempotencyKey || "").trim()
          && String(process.env.NODE_ENV || "").trim().toLowerCase() !== "test"
        ) {
          throw new GitControllerError(
            "GIT_CONTROLLER_IDEMPOTENCY_KEY_REQUIRED",
            "Production story provision requires a workflow-attempt idempotency key",
          );
        }
        const idempotencyKey = payload.idempotencyKey || createHash("sha256")
          .update([
            "story-repository-provision",
            String(payload.tabId || ""),
            repositoryId,
            String(payload.branch || ""),
            exactSha,
            String(payload.detached === true),
            String(payload.primary === true),
            String(payload.legacyMigration?.sourcePath || ""),
            String(payload.legacyMigration?.stateDigest || ""),
          ].join("\0"))
          .digest("hex");
        return client.call("story.repository.provision", {
          tabId: payload.tabId,
          repositoryId,
          branch: payload.branch,
          exactSha,
          idempotencyKey,
          detached: payload.detached === true,
          primary: payload.primary === true,
          ...(payload.legacyMigration && typeof payload.legacyMigration === "object"
            ? {
                legacySourcePath: payload.legacyMigration.sourcePath,
                legacyStateDigest: payload.legacyMigration.stateDigest,
              }
            : {}),
        });
      },
      previewLegacyMigration(payload = {}) {
        return client.call("story.repository.legacy-migration-preview", {
          tabId: payload.tabId,
          repositoryId: payload.repositoryId,
          sourcePath: payload.sourcePath,
        });
      },
      inspect: call("story.repository.inspect"),
      commit(payload = {}) {
        return client.call("story.repository.commit", {
          tabId: payload.tabId,
          repositoryId: payload.repositoryId,
          operationId: payload.operationId,
          expectedHead: payload.expectedHead,
          expectedBranch: payload.expectedBranch,
          targetFlavor: payload.targetFlavor,
          changeSummary: payload.changeSummary,
          declaredChanges: payload.declaredChanges,
          requiredCheckReceiptIds: payload.requiredCheckReceiptIds,
        });
      },
      retirePreview: call("story.repository.retire-preview"),
      retire(payload = {}) {
        const idempotencyKey = payload.idempotencyKey || createHash("sha256")
          .update([
            "story-repository-retire",
            String(payload.tabId || ""),
            String(payload.repositoryId || ""),
            String(payload.previewId || ""),
            String(payload.previewVersion ?? ""),
            String(payload.expectedHead || "").toLowerCase(),
            String(payload.registryGeneration ?? ""),
            String(payload.force === true),
          ].join("\0"))
          .digest("hex");
        return client.call("story.repository.retire", {
          tabId: payload.tabId,
          repositoryId: payload.repositoryId,
          previewId: payload.previewId,
          previewVersion: payload.previewVersion,
          expectedHead: payload.expectedHead,
          registryGeneration: payload.registryGeneration,
          force: payload.force === true,
          idempotencyKey,
          actor: payload.actor,
        });
      },
      cleanup(payload = {}) {
        const idempotencyKey = payload.idempotencyKey || createHash("sha256")
          .update([
            "story-repository-cleanup",
            String(payload.tabId || ""),
            String(payload.repositoryId || ""),
            String(payload.provisionOperationId || ""),
            String(payload.expectedBaseRevision || "").toLowerCase(),
            String(payload.expectedHead || "").toLowerCase(),
            String(payload.registryGeneration ?? ""),
          ].join("\0"))
          .digest("hex");
        return client.call("story.repository.cleanup", {
          tabId: payload.tabId,
          repositoryId: payload.repositoryId,
          provisionOperationId: payload.provisionOperationId,
          expectedBaseRevision: payload.expectedBaseRevision,
          expectedHead: payload.expectedHead,
          registryGeneration: payload.registryGeneration,
          idempotencyKey,
        });
      },
    }),
    definitions: client.catalog,
    warnings: client.warnings,
  });
}

export const __test = Object.freeze({
  createRegistryFacade,
  normalizeBaselineStrategy,
  normalizePathKey,
});
