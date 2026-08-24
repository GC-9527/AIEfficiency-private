import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import path from "node:path";

import { canonicalSha256 } from "./envelope-store.js";

export const WORKFLOW_V2_EDIT_STATE_SCHEMA_VERSION = "workflow-v2-edit-state-v1";

const SHA256 = /^[a-f0-9]{64}$/;

export class WorkflowV2EditStateError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "WorkflowV2EditStateError";
    this.code = code;
    this.details = details;
  }
}

function fail(message, code, details = {}) {
  throw new WorkflowV2EditStateError(message, code, details);
}

export function normalizeWorkflowV2EditPath(value) {
  const normalized = String(value || "").trim().replace(/\\/g, "/");
  const segments = normalized.split("/");
  if (!normalized
    || normalized.length > 500
    || path.posix.isAbsolute(normalized)
    || /^[A-Za-z]:\//.test(normalized)
    || segments.some((segment) => !segment || segment === "." || segment === "..")
    || segments[0].toLowerCase() === ".git"
    || /[\u0000\r\n]/u.test(normalized)) {
    fail(
      "EDIT receipt path is not a canonical repository-relative path",
      "WORKFLOW_V2_EDIT_STATE_PATH_INVALID",
      { path: normalized.slice(0, 300) },
    );
  }
  return normalized;
}

function validEditTransition(receipt) {
  const selector = receipt?.selector;
  if (receipt?.action !== "EDIT" || receipt?.status !== "PASS"
    || !selector || typeof selector.beforeExists !== "boolean"
    || typeof selector.afterExists !== "boolean") return false;
  if (selector.beforeExists !== (typeof selector.beforeSha256 === "string" && SHA256.test(selector.beforeSha256))) return false;
  if (selector.afterExists !== (typeof selector.afterSha256 === "string" && SHA256.test(selector.afterSha256))) return false;
  if (!selector.beforeExists && selector.beforeSha256 !== null) return false;
  if (!selector.afterExists && selector.afterSha256 !== null) return false;
  return selector.beforeExists !== selector.afterExists
    || selector.beforeSha256 !== selector.afterSha256;
}

function stateDigest(rootId, files) {
  return canonicalSha256({
    schemaVersion: WORKFLOW_V2_EDIT_STATE_SCHEMA_VERSION,
    rootId,
    files: files.map(({ path: relativePath, afterExists, afterSha256 }) => ({
      path: relativePath,
      afterExists,
      afterSha256,
    })),
  });
}

/**
 * Derive the authoritative final EDIT state from an append-only receipt stream.
 * Array order is the persisted stream order; for each path the last PASS EDIT
 * wins.  The state digest intentionally contains only normalized final bytes,
 * while versionSha256 also binds the exact latest receipt generation so an
 * intervening edit cannot be hidden by restoring the same bytes.
 */
export function deriveWorkflowV2EditState({
  envelopes = [],
  storyId,
  contextId,
  contextRevision,
  rootId,
  requireChanges = false,
} = {}) {
  if (!Array.isArray(envelopes)) {
    fail("evidence receipt stream is not an array", "WORKFLOW_V2_EDIT_STATE_STREAM_INVALID");
  }
  const normalizedStoryId = String(storyId || "").trim();
  const normalizedContextId = String(contextId || "").trim();
  const normalizedRootId = String(rootId || "").trim();
  if (!normalizedStoryId || !normalizedContextId || !Number.isSafeInteger(contextRevision) || contextRevision < 1
    || !normalizedRootId) {
    fail("edit state identity is incomplete", "WORKFLOW_V2_EDIT_STATE_IDENTITY_INVALID");
  }
  const latest = new Map();
  for (let index = 0; index < envelopes.length; index += 1) {
    const envelope = envelopes[index];
    const receipt = envelope?.payload && typeof envelope.payload === "object"
      ? envelope.payload
      : envelope;
    if (receipt?.action !== "EDIT" || receipt?.status !== "PASS"
      || receipt?.rootId !== normalizedRootId
      || receipt?.selector?.contextId !== normalizedContextId
      || receipt?.selector?.contextRevision !== contextRevision) continue;
    if (envelope?.storyId !== undefined && String(envelope.storyId) !== normalizedStoryId) {
      fail("EDIT receipt stream belongs to another story", "WORKFLOW_V2_EDIT_STATE_STORY_MISMATCH");
    }
    if (!validEditTransition(receipt)) {
      fail(
        "PASS EDIT receipt lacks an exact before/after byte transition",
        "WORKFLOW_V2_EDIT_STATE_RECEIPT_INVALID",
        { receiptId: String(receipt?.receiptId || "") },
      );
    }
    const relativePath = normalizeWorkflowV2EditPath(receipt.selector.path);
    const receiptId = String(receipt.receiptId || "").trim();
    if (!receiptId) {
      fail("PASS EDIT receipt has no identity", "WORKFLOW_V2_EDIT_STATE_RECEIPT_INVALID");
    }
    latest.set(relativePath, Object.freeze({
      path: relativePath,
      afterExists: receipt.selector.afterExists,
      afterSha256: receipt.selector.afterSha256,
      receiptId,
      streamRevision: Number.isSafeInteger(envelope?.revision) ? envelope.revision : index + 1,
      envelopeSha256: SHA256.test(String(envelope?.envelopeSha256 || ""))
        ? String(envelope.envelopeSha256)
        : null,
    }));
  }
  const files = Object.freeze([...latest.values()].sort((left, right) => (
    left.path < right.path ? -1 : (left.path > right.path ? 1 : 0)
  )));
  if (requireChanges && files.length === 0) {
    fail("no PASS EDIT receipt exists for the target context/root", "WORKFLOW_V2_EDIT_STATE_EMPTY");
  }
  const editStateSha256 = stateDigest(normalizedRootId, files);
  const editStateVersionSha256 = canonicalSha256({
    schemaVersion: WORKFLOW_V2_EDIT_STATE_SCHEMA_VERSION,
    storyId: normalizedStoryId,
    contextId: normalizedContextId,
    contextRevision,
    rootId: normalizedRootId,
    latestReceipts: files.map(({ path: relativePath, receiptId, streamRevision, envelopeSha256 }) => ({
      path: relativePath,
      receiptId,
      streamRevision,
      envelopeSha256,
    })),
  });
  return Object.freeze({
    schemaVersion: WORKFLOW_V2_EDIT_STATE_SCHEMA_VERSION,
    storyId: normalizedStoryId,
    contextId: normalizedContextId,
    contextRevision,
    rootId: normalizedRootId,
    files,
    editStateSha256,
    editStateVersionSha256,
  });
}

function sameOrChild(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function sha256File(filename) {
  return createHash("sha256").update(readFileSync(filename)).digest("hex");
}

function inspectPath(root, relativePath) {
  const absolute = path.resolve(root, ...relativePath.split("/"));
  if (!sameOrChild(root, absolute) || absolute === root) {
    fail("EDIT state path escapes its repository root", "WORKFLOW_V2_EDIT_STATE_PATH_ESCAPE", { path: relativePath });
  }
  let current = root;
  for (const segment of relativePath.split("/")) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (error?.code === "ENOENT") return { exists: false, sha256: null };
      throw error;
    }
    if (stat.isSymbolicLink()) {
      fail("EDIT state path contains a symbolic link", "WORKFLOW_V2_EDIT_STATE_SYMLINK_REJECTED", { path: relativePath });
    }
  }
  const stat = lstatSync(absolute);
  if (!stat.isFile()) {
    fail("EDIT state target is not a regular file", "WORKFLOW_V2_EDIT_STATE_FILE_TYPE_INVALID", { path: relativePath });
  }
  const real = realpathSync(absolute);
  if (!sameOrChild(realpathSync(root), real)) {
    fail("EDIT state target resolves outside its repository root", "WORKFLOW_V2_EDIT_STATE_PATH_ESCAPE", { path: relativePath });
  }
  return { exists: true, sha256: sha256File(real) };
}

/** Re-read the actual final file/deletion state without trusting the model. */
export function verifyWorkflowV2EditStateFiles({ absoluteRoot, state, expectedPaths = null } = {}) {
  const root = path.resolve(String(absoluteRoot || ""));
  let rootStat;
  try {
    rootStat = lstatSync(root);
  } catch (error) {
    fail(`repository root is unavailable: ${error?.message || error}`, "WORKFLOW_V2_EDIT_STATE_ROOT_UNAVAILABLE");
  }
  if (!path.isAbsolute(String(absoluteRoot || "")) || !rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    fail("repository root is not a plain absolute directory", "WORKFLOW_V2_EDIT_STATE_ROOT_INVALID");
  }
  if (!state || state.schemaVersion !== WORKFLOW_V2_EDIT_STATE_SCHEMA_VERSION || !Array.isArray(state.files)
    || !SHA256.test(String(state.editStateSha256 || ""))
    || !SHA256.test(String(state.editStateVersionSha256 || ""))) {
    fail("edit state binding is invalid", "WORKFLOW_V2_EDIT_STATE_BINDING_INVALID");
  }
  const paths = state.files.map((entry) => normalizeWorkflowV2EditPath(entry.path));
  if (new Set(paths).size !== paths.length || paths.some((value, index) => value !== [...paths].sort()[index])) {
    fail("edit state paths are duplicated or not canonical-sorted", "WORKFLOW_V2_EDIT_STATE_BINDING_INVALID");
  }
  if (expectedPaths !== null) {
    const expected = [...new Set((Array.isArray(expectedPaths) ? expectedPaths : [])
      .map(normalizeWorkflowV2EditPath))].sort();
    if (expected.length !== paths.length || expected.some((value, index) => value !== paths[index])) {
      fail(
        "declared changes do not exactly match the latest PASS EDIT paths",
        "WORKFLOW_V2_EDIT_STATE_DECLARED_CHANGE_MISMATCH",
        { expected, actual: paths },
      );
    }
  }
  for (const entry of state.files) {
    const actual = inspectPath(root, entry.path);
    if (actual.exists !== entry.afterExists || actual.sha256 !== entry.afterSha256) {
      fail(
        "repository bytes no longer match the latest PASS EDIT receipt",
        "WORKFLOW_V2_EDIT_STATE_FILE_MISMATCH",
        { path: entry.path, expectedExists: entry.afterExists, actualExists: actual.exists },
      );
    }
  }
  if (stateDigest(state.rootId, state.files) !== state.editStateSha256) {
    fail("edit state digest does not match its file entries", "WORKFLOW_V2_EDIT_STATE_DIGEST_MISMATCH");
  }
  return Object.freeze({ ok: true, editStateSha256: state.editStateSha256, editStateVersionSha256: state.editStateVersionSha256 });
}

export function receiptBindsWorkflowV2EditState(receipt, state) {
  return !!receipt
    && receipt?.selector?.editStateSha256 === state?.editStateSha256
    && receipt?.selector?.editStateVersionSha256 === state?.editStateVersionSha256;
}
