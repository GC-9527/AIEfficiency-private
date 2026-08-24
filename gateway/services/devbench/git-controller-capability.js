import fs from "node:fs";
import path from "node:path";
import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { fileURLToPath } from "node:url";

export const CAPABILITY_ROOT_ENV = "DEVBENCH_GIT_CONTROLLER_CAPABILITY_ROOT";

const FORMAT_VERSION = 1;
const TOKEN_PREFIX = "dvc1";
const ROOT_MARKER_NAME = "capability-root.json";
const SECRET_NAME = "capability.key";
const STATE_DIRECTORY_NAME = "nonce-state";
const DEFAULT_TTL_MS = 120_000;
const MAX_TOKEN_BYTES = 16 * 1024;
const MAX_STATE_BYTES = 64 * 1024;
const DEFAULT_LOCK_TIMEOUT_MS = 3_000;
const REFERENCE_HOOK = "reference-transaction";
const REFERENCE_PHASES = new Set(["prepared", "committed", "aborted"]);
const NON_REFERENCE_HOOKS = new Set([
  "pre-commit",
  "pre-rebase",
  "pre-merge-commit",
  "pre-push",
]);

class CapabilityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "GitControllerCapabilityError";
    this.code = code;
  }
}

function failure(reason) {
  return Object.freeze({ ok: false, reason: String(reason || "CAPABILITY_REJECTED") });
}

function success(reason, details = {}) {
  return Object.freeze({
    ok: true,
    reason: String(reason || "CAPABILITY_VALID"),
    ...details,
  });
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function mac(secret, domain, value) {
  return createHmac("sha256", secret)
    .update(`devbench-git-controller:${domain}:v${FORMAT_VERSION}\0`, "utf8")
    .update(value)
    .digest();
}

function macText(secret, domain, value) {
  return mac(secret, domain, value).toString("base64url");
}

function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function pathInside(root, target) {
  const relative = path.relative(root, target);
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertAbsolutePath(value, label) {
  const text = String(value || "").trim();
  if (!text || text.includes("\0") || !path.isAbsolute(text)) {
    throw new CapabilityError("CAPABILITY_ROOT_INVALID", `${label} must be an absolute path`);
  }
  return path.resolve(text);
}

function existingSegments(target) {
  const parsed = path.parse(target);
  const segments = target.slice(parsed.root.length).split(/[\\/]+/).filter(Boolean);
  const result = [];
  let current = parsed.root;
  for (const segment of segments) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) break;
    result.push(current);
  }
  return result;
}

function assertNoLinkedSegments(target, label) {
  for (const segment of existingSegments(target)) {
    const stat = fs.lstatSync(segment);
    if (stat.isSymbolicLink()) {
      throw new CapabilityError("CAPABILITY_PATH_DRIFT", `${label} traverses a linked path`);
    }
  }
}

function chmodBestEffort(target, mode) {
  try {
    fs.chmodSync(target, mode);
  } catch {
    // Windows ACLs do not map completely to POSIX modes. The Controller data
    // root must additionally be ACL-restricted by its service installer.
  }
}

function assertPlainDirectory(target, label) {
  assertNoLinkedSegments(target, label);
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new CapabilityError("CAPABILITY_PATH_DRIFT", `${label} is not a plain directory`);
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new CapabilityError("CAPABILITY_STATE_PERMISSIONS", `${label} is not private`);
  }
  const real = fs.realpathSync.native(target);
  if (pathKey(real) !== pathKey(target)) {
    throw new CapabilityError("CAPABILITY_PATH_DRIFT", `${label} resolves to another path`);
  }
  return real;
}

function ensurePlainDirectory(target, label, { create = false } = {}) {
  assertNoLinkedSegments(target, label);
  if (!fs.existsSync(target)) {
    if (!create) {
      throw new CapabilityError("CAPABILITY_ROOT_UNAVAILABLE", `${label} is unavailable`);
    }
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  }
  if (create) chmodBestEffort(target, 0o700);
  const resolved = assertPlainDirectory(target, label);
  return resolved;
}

function assertManagedPath(root, target, label) {
  const resolved = path.resolve(target);
  if (!pathInside(root, resolved)) {
    throw new CapabilityError("CAPABILITY_PATH_ESCAPE", `${label} escaped the capability root`);
  }
  assertNoLinkedSegments(resolved, label);
  return resolved;
}

function assertPlainFile(target, label, { expectedBytes = null } = {}) {
  assertNoLinkedSegments(target, label);
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new CapabilityError("CAPABILITY_STATE_DRIFT", `${label} is not a plain file`);
  }
  if (stat.nlink !== 1) {
    throw new CapabilityError("CAPABILITY_STATE_DRIFT", `${label} has an invalid link count`);
  }
  if (expectedBytes != null && stat.size !== expectedBytes) {
    throw new CapabilityError("CAPABILITY_STATE_DRIFT", `${label} has an invalid size`);
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new CapabilityError("CAPABILITY_STATE_PERMISSIONS", `${label} is not private`);
  }
  return stat;
}

function writeExclusive(target, data, mode = 0o600) {
  let fd = null;
  try {
    fd = fs.openSync(target, "wx", mode);
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    chmodBestEffort(target, mode);
  } finally {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

function atomicReplace(target, data, mode = 0o600) {
  const parent = path.dirname(target);
  const temporary = path.join(parent, `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  let fd = null;
  let previous = "";
  try {
    fd = fs.openSync(temporary, "wx", mode);
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    chmodBestEffort(temporary, mode);
    if (process.platform === "win32" && fs.existsSync(target)) {
      previous = `${target}.${randomUUID()}.old`;
      fs.renameSync(target, previous);
      try {
        fs.renameSync(temporary, target);
      } catch (error) {
        if (!fs.existsSync(target) && fs.existsSync(previous)) {
          fs.renameSync(previous, target);
        }
        throw error;
      }
      fs.rmSync(previous, { force: true });
      previous = "";
    } else {
      fs.renameSync(temporary, target);
    }
  } finally {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
    try {
      fs.rmSync(temporary, { force: true });
    } catch {}
    if (previous) {
      // A leftover backup is evidence of an interrupted state transition.
      // Keep it for diagnosis and fail closed on the missing/invalid target.
    }
  }
}

function parseJsonFile(target, maximumBytes = MAX_STATE_BYTES) {
  const stat = assertPlainFile(target, "capability state");
  if (stat.size <= 0 || stat.size > maximumBytes) {
    throw new CapabilityError("CAPABILITY_STATE_DRIFT", "capability state size is invalid");
  }
  return JSON.parse(fs.readFileSync(target, "utf8"));
}

function createSecret(secretPath) {
  try {
    writeExclusive(secretPath, randomBytes(32), 0o600);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
}

function readSecret(secretPath) {
  assertPlainFile(secretPath, "capability secret", { expectedBytes: 32 });
  return fs.readFileSync(secretPath);
}

function signedRecord(secret, domain, body) {
  return {
    ...body,
    mac: macText(secret, domain, canonicalJson(body)),
  };
}

function verifySignedRecord(secret, domain, record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const { mac: actualText, ...body } = record;
  if (typeof actualText !== "string") return null;
  let actual;
  try {
    actual = Buffer.from(actualText, "base64url");
  } catch {
    return null;
  }
  const expected = mac(secret, domain, canonicalJson(body));
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  return body;
}

function initializeRoot(root) {
  const secretPath = assertManagedPath(root, path.join(root, SECRET_NAME), "capability secret");
  const markerPath = assertManagedPath(root, path.join(root, ROOT_MARKER_NAME), "capability root marker");
  createSecret(secretPath);
  const secret = readSecret(secretPath);
  if (!fs.existsSync(markerPath)) {
    const body = {
      formatVersion: FORMAT_VERSION,
      rootId: randomUUID(),
      keyId: sha256(secret),
      createdAt: new Date().toISOString(),
    };
    try {
      writeExclusive(
        markerPath,
        `${JSON.stringify(signedRecord(secret, "root", body), null, 2)}\n`,
        0o600,
      );
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
}

function openRoot(dataRoot, { create = false } = {}) {
  const configured = assertAbsolutePath(dataRoot, "capability root");
  if (create) {
    ensurePlainDirectory(configured, "capability root", { create: true });
    initializeRoot(configured);
  }
  const root = ensurePlainDirectory(configured, "capability root");
  const secretPath = assertManagedPath(root, path.join(root, SECRET_NAME), "capability secret");
  const markerPath = assertManagedPath(root, path.join(root, ROOT_MARKER_NAME), "capability root marker");
  if (!fs.existsSync(secretPath) || !fs.existsSync(markerPath)) {
    throw new CapabilityError("CAPABILITY_ROOT_UNAVAILABLE", "capability root is incomplete");
  }
  const secret = readSecret(secretPath);
  let markerRecord;
  try {
    markerRecord = parseJsonFile(markerPath);
  } catch {
    throw new CapabilityError("CAPABILITY_ROOT_DRIFT", "capability root marker is unavailable");
  }
  const marker = verifySignedRecord(secret, "root", markerRecord);
  if (
    !marker
    || marker.formatVersion !== FORMAT_VERSION
    || typeof marker.rootId !== "string"
    || marker.keyId !== sha256(secret)
  ) {
    throw new CapabilityError("CAPABILITY_ROOT_DRIFT", "capability root marker drifted");
  }
  const stateRootConfigured = assertManagedPath(
    root,
    path.join(root, STATE_DIRECTORY_NAME),
    "capability nonce state",
  );
  const stateRoot = ensurePlainDirectory(
    stateRootConfigured,
    "capability nonce state",
    { create },
  );
  if (!pathInside(root, stateRoot)) {
    throw new CapabilityError("CAPABILITY_PATH_ESCAPE", "capability nonce state escaped its root");
  }
  return Object.freeze({ root, secret, marker, stateRoot });
}

function requiredText(value, label, { maximum = 512, pattern = null } = {}) {
  const text = String(value ?? "");
  if (
    !text
    || text.length > maximum
    || /[\x00-\x1f\x7f]/.test(text)
    || (pattern && !pattern.test(text))
  ) {
    throw new CapabilityError("CAPABILITY_CONTEXT_INVALID", `${label} is invalid`);
  }
  return text;
}

function normalizeSha(value, label) {
  return requiredText(String(value || "").toLowerCase(), label, {
    maximum: 64,
    pattern: /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/,
  });
}

function normalizeFingerprint(value) {
  return requiredText(String(value || "").toLowerCase(), "repositoryFingerprint", {
    maximum: 64,
    pattern: /^[0-9a-f]{64}$/,
  });
}

function normalizeFencingToken(value) {
  const text = requiredText(value, "fencingToken", {
    maximum: 32,
    pattern: /^[1-9][0-9]*$/,
  });
  if (BigInt(text) > BigInt("9223372036854775807")) {
    throw new CapabilityError("CAPABILITY_CONTEXT_INVALID", "fencingToken is out of range");
  }
  return text;
}

function normalizeHookPhaseSequence(input) {
  if (!Array.isArray(input) || input.length === 0 || input.length > 8) {
    throw new CapabilityError("CAPABILITY_CONTEXT_INVALID", "hookPhaseSequence is invalid");
  }
  const normalized = input.map((entry) => {
    if (typeof entry === "string") {
      const text = entry.trim();
      if (REFERENCE_PHASES.has(text)) return { hook: REFERENCE_HOOK, phase: text };
      if (NON_REFERENCE_HOOKS.has(text)) return { hook: text, phase: "once" };
      const separator = text.lastIndexOf(":");
      if (separator > 0) {
        return { hook: text.slice(0, separator), phase: text.slice(separator + 1) };
      }
      throw new CapabilityError("CAPABILITY_CONTEXT_INVALID", "hookPhaseSequence entry is invalid");
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new CapabilityError("CAPABILITY_CONTEXT_INVALID", "hookPhaseSequence entry is invalid");
    }
    return { hook: String(entry.hook || ""), phase: String(entry.phase || "once") };
  });
  const unique = new Set();
  let hasReference = false;
  let hasNonReference = false;
  for (const item of normalized) {
    if (item.hook === REFERENCE_HOOK) {
      hasReference = true;
      if (!REFERENCE_PHASES.has(item.phase)) {
        throw new CapabilityError("CAPABILITY_CONTEXT_INVALID", "reference phase is invalid");
      }
    } else {
      hasNonReference = true;
      if (!NON_REFERENCE_HOOKS.has(item.hook) || item.phase !== "once") {
        throw new CapabilityError("CAPABILITY_CONTEXT_INVALID", "non-reference hook phase is invalid");
      }
    }
    const key = `${item.hook}\0${item.phase}`;
    if (unique.has(key)) {
      throw new CapabilityError("CAPABILITY_CONTEXT_INVALID", "hookPhaseSequence contains duplicates");
    }
    unique.add(key);
  }
  if (hasReference && hasNonReference) {
    throw new CapabilityError(
      "CAPABILITY_CONTEXT_INVALID",
      "one capability cannot mix reference and non-reference hooks",
    );
  }
  if (hasReference) {
    const phases = normalized.map((item) => item.phase);
    if (phases[0] !== "prepared" || !phases.some((phase) => phase === "committed" || phase === "aborted")) {
      throw new CapabilityError(
        "CAPABILITY_CONTEXT_INVALID",
        "reference transaction must start at prepared and include a terminal phase",
      );
    }
  } else if (normalized.length !== 1) {
    throw new CapabilityError(
      "CAPABILITY_CONTEXT_INVALID",
      "non-reference capability must bind exactly one hook",
    );
  }
  return normalized;
}

async function resolveFingerprintForIssue(context, resolver) {
  if (context.repositoryFingerprint) return normalizeFingerprint(context.repositoryFingerprint);
  if (typeof resolver !== "function") {
    throw new CapabilityError(
      "CAPABILITY_CONTEXT_INVALID",
      "repositoryFingerprint resolver is unavailable",
    );
  }
  const resolved = await resolver(String(context.repositoryId || ""));
  const value = typeof resolved === "string"
    ? resolved
    : resolved?.repositoryFingerprint || resolved?.fingerprint;
  return normalizeFingerprint(value);
}

function normalizeExpiry(context, now, maximumTtlMs) {
  const issuedAt = Number.isFinite(Number(context.issuedAt))
    ? Math.trunc(Number(context.issuedAt))
    : now;
  const explicitExpiry = typeof context.expiresAt === "string"
    ? Date.parse(context.expiresAt)
    : Number(context.expiresAt);
  const requestedTtl = Number(context.ttlMs);
  const requestedExpiry = Number.isFinite(explicitExpiry)
    ? Math.trunc(explicitExpiry)
    : Number.isFinite(requestedTtl)
      ? issuedAt + Math.trunc(requestedTtl)
      : issuedAt + maximumTtlMs;
  const expiresAt = Math.min(requestedExpiry, issuedAt + maximumTtlMs);
  if (
    !Number.isSafeInteger(issuedAt)
    || !Number.isSafeInteger(expiresAt)
    || issuedAt > now + 5_000
    || expiresAt <= now
  ) {
    throw new CapabilityError("CAPABILITY_CONTEXT_INVALID", "capability TTL is invalid");
  }
  return { issuedAt, expiresAt };
}

function defaultHeadByPhase(commandId, expectedHead, candidateSha, sequence) {
  const fetchLike = /(?:^|[._-])fetch(?:[._-]|$)/i.test(commandId);
  const result = {};
  for (const item of sequence) {
    const key = `${item.hook}:${item.phase}`;
    if (item.hook !== REFERENCE_HOOK || item.phase !== "committed" || fetchLike) {
      result[key] = expectedHead;
    } else {
      result[key] = candidateSha;
    }
  }
  return result;
}

function tokenPayload({
  context,
  repositoryFingerprint,
  issuedAt,
  expiresAt,
  sequence,
  nonce,
}) {
  const operationId = requiredText(context.operationId, "operationId");
  const repositoryId = requiredText(context.repositoryId, "repositoryId");
  const commandId = requiredText(context.commandId, "commandId");
  const branch = requiredText(context.branch, "branch", { maximum: 1_024 });
  const expectedHead = normalizeSha(context.expectedHead, "expectedHead");
  const candidateSha = normalizeSha(context.candidateSha, "candidateSha");
  if (expectedHead.length !== candidateSha.length) {
    throw new CapabilityError(
      "CAPABILITY_CONTEXT_INVALID",
      "expectedHead and candidateSha use different object formats",
    );
  }
  const fencingToken = normalizeFencingToken(context.fencingToken);
  return {
    version: FORMAT_VERSION,
    operationId,
    repositoryId,
    repositoryFingerprint,
    commandId,
    branch,
    expectedHead,
    candidateSha,
    fencingToken,
    issuedAt,
    expiresAt,
    nonce,
    hookPhaseSequence: sequence,
    hookHeadByPhase: defaultHeadByPhase(commandId, expectedHead, candidateSha, sequence),
  };
}

function encodeToken(secret, payload) {
  const encodedPayload = Buffer.from(canonicalJson(payload), "utf8").toString("base64url");
  const signature = mac(secret, "token", `${TOKEN_PREFIX}.${encodedPayload}`).toString("base64url");
  return `${TOKEN_PREFIX}.${encodedPayload}.${signature}`;
}

function decodeAndVerifyToken(secret, token) {
  const text = String(token || "");
  if (!text || Buffer.byteLength(text) > MAX_TOKEN_BYTES || /[\x00-\x20\x7f]/.test(text)) {
    throw new CapabilityError("CAPABILITY_INVALID", "capability is invalid");
  }
  const parts = text.split(".");
  if (
    parts.length !== 3
    || parts[0] !== TOKEN_PREFIX
    || !/^[A-Za-z0-9_-]+$/.test(parts[1])
    || !/^[A-Za-z0-9_-]+$/.test(parts[2])
  ) {
    throw new CapabilityError("CAPABILITY_INVALID", "capability is invalid");
  }
  let actual;
  try {
    actual = Buffer.from(parts[2], "base64url");
  } catch {
    throw new CapabilityError("CAPABILITY_INVALID", "capability is invalid");
  }
  const expected = mac(secret, "token", `${parts[0]}.${parts[1]}`);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new CapabilityError("CAPABILITY_INVALID", "capability is invalid");
  }
  let payload;
  try {
    const decoded = Buffer.from(parts[1], "base64url");
    if (decoded.length <= 0 || decoded.length > MAX_TOKEN_BYTES) throw new Error("size");
    payload = JSON.parse(decoded.toString("utf8"));
  } catch {
    throw new CapabilityError("CAPABILITY_INVALID", "capability is invalid");
  }
  if (
    !payload
    || payload.version !== FORMAT_VERSION
    || typeof payload.nonce !== "string"
    || !Array.isArray(payload.hookPhaseSequence)
  ) {
    throw new CapabilityError("CAPABILITY_INVALID", "capability is invalid");
  }
  return payload;
}

function noncePaths(openedRoot, nonce) {
  const digest = sha256(Buffer.from(String(nonce), "utf8"));
  const shard = assertManagedPath(
    openedRoot.stateRoot,
    path.join(openedRoot.stateRoot, digest.slice(0, 2)),
    "capability nonce shard",
  );
  const statePath = assertManagedPath(
    openedRoot.stateRoot,
    path.join(shard, `${digest.slice(2)}.json`),
    "capability nonce state",
  );
  const lockPath = assertManagedPath(
    openedRoot.stateRoot,
    path.join(shard, `${digest.slice(2)}.lock`),
    "capability nonce lock",
  );
  return { digest, shard, statePath, lockPath };
}

function createInitialState(openedRoot, token, payload) {
  const paths = noncePaths(openedRoot, payload.nonce);
  ensurePlainDirectory(paths.shard, "capability nonce shard", { create: true });
  if (!pathInside(openedRoot.stateRoot, paths.shard)) {
    throw new CapabilityError("CAPABILITY_PATH_ESCAPE", "capability nonce shard escaped its root");
  }
  const body = {
    formatVersion: FORMAT_VERSION,
    rootId: openedRoot.marker.rootId,
    nonceDigest: paths.digest,
    tokenDigest: sha256(Buffer.from(token, "utf8")),
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
    status: "ISSUED",
    sequence: [],
    revision: 0,
  };
  try {
    writeExclusive(
      paths.statePath,
      `${JSON.stringify(signedRecord(openedRoot.secret, "state", body), null, 2)}\n`,
      0o600,
    );
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new CapabilityError("CAPABILITY_NONCE_COLLISION", "capability nonce collision");
    }
    throw error;
  }
}

function readState(openedRoot, statePath, token, payload, nonceDigest) {
  if (!fs.existsSync(statePath)) {
    throw new CapabilityError("CAPABILITY_STATE_UNAVAILABLE", "capability state is unavailable");
  }
  let record;
  try {
    record = parseJsonFile(statePath);
  } catch {
    throw new CapabilityError("CAPABILITY_STATE_DRIFT", "capability state drifted");
  }
  const body = verifySignedRecord(openedRoot.secret, "state", record);
  if (
    !body
    || body.formatVersion !== FORMAT_VERSION
    || body.rootId !== openedRoot.marker.rootId
    || body.nonceDigest !== nonceDigest
    || body.tokenDigest !== sha256(Buffer.from(token, "utf8"))
    || body.issuedAt !== payload.issuedAt
    || body.expiresAt !== payload.expiresAt
    || !Array.isArray(body.sequence)
    || !Number.isSafeInteger(body.revision)
  ) {
    throw new CapabilityError("CAPABILITY_STATE_DRIFT", "capability state drifted");
  }
  return body;
}

function writeState(openedRoot, statePath, body) {
  const record = signedRecord(openedRoot.secret, "state", body);
  atomicReplace(statePath, `${JSON.stringify(record, null, 2)}\n`, 0o600);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function acquireLock(lockPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const lockId = randomUUID();
  while (Date.now() <= deadline) {
    let fd = null;
    try {
      fd = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(fd, `${JSON.stringify({ lockId, pid: process.pid, at: Date.now() })}\n`);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      chmodBestEffort(lockPath, 0o600);
      return {
        release() {
          try {
            const current = JSON.parse(fs.readFileSync(lockPath, "utf8"));
            if (current?.lockId === lockId) fs.rmSync(lockPath, { force: true });
          } catch {
            // Never remove a lock that cannot be proven to be ours.
          }
        },
      };
    } catch (error) {
      if (fd != null) {
        try {
          fs.closeSync(fd);
        } catch {}
      }
      if (error?.code !== "EEXIST") {
        throw new CapabilityError("CAPABILITY_STATE_UNAVAILABLE", "capability lock is unavailable");
      }
      await delay(4 + Math.floor(Math.random() * 9));
    }
  }
  throw new CapabilityError("CAPABILITY_STATE_BUSY", "capability state is busy");
}

function allowedPhase(payload, hook, phase) {
  return payload.hookPhaseSequence.some(
    (item) => item?.hook === hook && item?.phase === phase,
  );
}

function expectedHeadFor(payload, hook, phase) {
  return payload.hookHeadByPhase?.[`${hook}:${phase}`] || "";
}

function validateStaticContext(payload, hookContext, now) {
  if (!Number.isSafeInteger(payload.issuedAt) || !Number.isSafeInteger(payload.expiresAt)) {
    throw new CapabilityError("CAPABILITY_INVALID", "capability timing is invalid");
  }
  if (payload.expiresAt <= now || payload.issuedAt > now + 5_000) {
    throw new CapabilityError("CAPABILITY_EXPIRED", "capability expired");
  }
  const fingerprint = normalizeFingerprint(hookContext.repositoryFingerprint);
  if (fingerprint !== payload.repositoryFingerprint) {
    throw new CapabilityError("CAPABILITY_REPOSITORY_MISMATCH", "repository does not match");
  }
  const branch = requiredText(hookContext.branch, "branch", { maximum: 1_024 });
  if (branch !== payload.branch) {
    throw new CapabilityError("CAPABILITY_BRANCH_MISMATCH", "branch does not match");
  }
  const hook = requiredText(hookContext.hook, "hook", { maximum: 64 });
  const args = Array.isArray(hookContext.args) ? hookContext.args.map(String) : [];
  const phase = hook === REFERENCE_HOOK
    ? String(hookContext.phase || args[0] || "")
    : String(hookContext.phase || "once");
  if (!allowedPhase(payload, hook, phase)) {
    throw new CapabilityError("CAPABILITY_HOOK_MISMATCH", "hook phase does not match");
  }
  const head = normalizeSha(hookContext.head, "head");
  if (head !== expectedHeadFor(payload, hook, phase)) {
    throw new CapabilityError("CAPABILITY_HEAD_MISMATCH", "HEAD does not match");
  }
  return { hook, phase };
}

function nextState(current, hook, phase, now) {
  if (current.status === "CONSUMED") {
    throw new CapabilityError("CAPABILITY_REPLAYED", "capability was already consumed");
  }
  if (hook !== REFERENCE_HOOK) {
    if (current.status !== "ISSUED" || current.sequence.length !== 0) {
      throw new CapabilityError("CAPABILITY_REPLAYED", "capability was already consumed");
    }
    return {
      ...current,
      status: "CONSUMED",
      sequence: [{ hook, phase: "once", at: now }],
      consumedAt: now,
      terminalPhase: "once",
      revision: current.revision + 1,
    };
  }
  if (phase === "prepared") {
    if (current.status !== "ISSUED" || current.sequence.length !== 0) {
      throw new CapabilityError("CAPABILITY_REPLAYED", "prepared phase was already consumed");
    }
    return {
      ...current,
      status: "PREPARED",
      sequence: [{ hook, phase, at: now }],
      revision: current.revision + 1,
    };
  }
  if (
    (phase === "committed" || phase === "aborted")
    && current.status === "PREPARED"
    && current.sequence.length === 1
    && current.sequence[0]?.hook === REFERENCE_HOOK
    && current.sequence[0]?.phase === "prepared"
  ) {
    return {
      ...current,
      status: "CONSUMED",
      sequence: [...current.sequence, { hook, phase, at: now }],
      consumedAt: now,
      terminalPhase: phase,
      revision: current.revision + 1,
    };
  }
  throw new CapabilityError("CAPABILITY_PHASE_INVALID", "reference transaction phase is invalid");
}

function reasonFor(error) {
  if (error instanceof CapabilityError) return error.code;
  return "CONTROLLER_UNAVAILABLE";
}

async function validateAtRoot(dataRoot, hookContext, { lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS } = {}) {
  let openedRoot;
  try {
    openedRoot = openRoot(dataRoot, { create: false });
  } catch (error) {
    return failure(reasonFor(error));
  }
  let payload;
  const token = String(hookContext?.capability || "");
  try {
    payload = decodeAndVerifyToken(openedRoot.secret, token);
    const { hook, phase } = validateStaticContext(payload, hookContext || {}, Date.now());
    const paths = noncePaths(openedRoot, payload.nonce);
    if (!fs.existsSync(paths.shard)) {
      throw new CapabilityError("CAPABILITY_STATE_UNAVAILABLE", "capability state is unavailable");
    }
    assertPlainDirectory(paths.shard, "capability nonce shard");
    const lock = await acquireLock(paths.lockPath, Math.max(50, Number(lockTimeoutMs) || DEFAULT_LOCK_TIMEOUT_MS));
    try {
      const now = Date.now();
      if (payload.expiresAt <= now) {
        throw new CapabilityError("CAPABILITY_EXPIRED", "capability expired");
      }
      const current = readState(
        openedRoot,
        paths.statePath,
        token,
        payload,
        paths.digest,
      );
      if (current.expiresAt <= now) {
        throw new CapabilityError("CAPABILITY_EXPIRED", "capability expired");
      }
      const updated = nextState(current, hook, phase, now);
      writeState(openedRoot, paths.statePath, updated);
      return success(
        updated.status === "CONSUMED" ? "CAPABILITY_CONSUMED" : "CAPABILITY_PREPARED",
        { terminal: updated.status === "CONSUMED" },
      );
    } finally {
      lock.release();
    }
  } catch (error) {
    return failure(reasonFor(error));
  }
}

export function createGitControllerCapabilityService({
  dataRoot,
  resolveRepositoryFingerprint = null,
  maxTtlMs = DEFAULT_TTL_MS,
  lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
} = {}) {
  const maximumTtl = Math.max(1, Math.min(10 * 60_000, Number(maxTtlMs) || DEFAULT_TTL_MS));
  const opened = openRoot(dataRoot, { create: true });
  const expectedRootId = opened.marker.rootId;
  const expectedKeyId = opened.marker.keyId;

  function reopen() {
    const current = openRoot(opened.root, { create: false });
    if (
      current.marker.rootId !== expectedRootId
      || current.marker.keyId !== expectedKeyId
    ) {
      throw new CapabilityError("CAPABILITY_ROOT_DRIFT", "capability root identity drifted");
    }
    return current;
  }

  const issue = async (context = {}) => {
    const current = reopen();
    const now = Date.now();
    const repositoryFingerprint = await resolveFingerprintForIssue(
      context,
      resolveRepositoryFingerprint,
    );
    const { issuedAt, expiresAt } = normalizeExpiry(context, now, maximumTtl);
    const sequence = normalizeHookPhaseSequence(context.hookPhaseSequence);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const nonce = randomBytes(24).toString("base64url");
      const payload = tokenPayload({
        context,
        repositoryFingerprint,
        issuedAt,
        expiresAt,
        sequence,
        nonce,
      });
      const token = encodeToken(current.secret, payload);
      try {
        createInitialState(current, token, payload);
        return token;
      } catch (error) {
        if (error?.code !== "CAPABILITY_NONCE_COLLISION") throw error;
      }
    }
    throw new CapabilityError("CAPABILITY_NONCE_COLLISION", "unable to allocate capability nonce");
  };

  return Object.freeze({
    dataRoot: opened.root,
    environment: Object.freeze({ [CAPABILITY_ROOT_ENV]: opened.root }),
    validatorDescriptor: Object.freeze({
      type: "module",
      modulePath: fileURLToPath(import.meta.url),
      exportName: "validateCapability",
    }),
    issue,
    issuer: issue,
    validateCapability: (hookContext) => validateAtRoot(opened.root, hookContext, { lockTimeoutMs }),
  });
}

export function createCapabilityIssuer(options = {}) {
  return createGitControllerCapabilityService(options).issuer;
}

/**
 * Manifest module descriptor entry point. The Controller service must inject
 * DEVBENCH_GIT_CONTROLLER_CAPABILITY_ROOT into its own narrowly scoped Git
 * command environment. Absence, path drift, secret drift and state drift all
 * fail closed.
 */
export async function validateCapability(hookContext = {}) {
  const root = String(process.env[CAPABILITY_ROOT_ENV] || "");
  if (!root) return failure("CAPABILITY_ROOT_UNAVAILABLE");
  return validateAtRoot(root, hookContext);
}
