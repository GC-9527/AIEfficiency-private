import { createHash, randomUUID } from "node:crypto";
import { link, lstat, open, readFile, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import * as storyStore from "../store.js";
import {
  WORKFLOW_V2_SCHEMA_IDS,
  workflowV2SchemaRegistry,
} from "./schema-registry.js";

const ENVELOPE_FILE_PATTERN = /^(\d{12})\.json$/;
const CONTEXT_STREAM_PATTERN = /^[a-f0-9]{64}$/;
const MAX_REVISION = 999999999999;
const STAGE_RESULT_IDEMPOTENCY_PREFIX = "stage-result:";
// Keep a BOM in the decoded text so canonical byte comparison rejects it.
// TextDecoder's `ignoreBOM: true` means "do not strip the BOM".
const STRICT_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const STREAM_DIRECTORIES = Object.freeze({
  [WORKFLOW_V2_SCHEMA_IDS.stageContext]: "stage-context",
  [WORKFLOW_V2_SCHEMA_IDS.workflowCheckpoint]: "workflow-checkpoint",
  [WORKFLOW_V2_SCHEMA_IDS.evidenceManifest]: "evidence-manifest",
  [WORKFLOW_V2_SCHEMA_IDS.evidenceReceipt]: "evidence-receipt",
  [WORKFLOW_V2_SCHEMA_IDS.stageResultRecord]: "stage-result",
});

export class WorkflowV2EnvelopeStoreError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "WorkflowV2EnvelopeStoreError";
    this.code = code;
    this.details = details;
  }
}

function fail(message, code, details = {}) {
  throw new WorkflowV2EnvelopeStoreError(message, code, details);
}

function compareUtf16CodeUnits(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function assertValidUnicode(value) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        fail("canonical JSON 不允许未配对 UTF-16 surrogate", "WORKFLOW_V2_NON_CANONICAL_VALUE");
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      fail("canonical JSON 不允许未配对 UTF-16 surrogate", "WORKFLOW_V2_NON_CANONICAL_VALUE");
    }
  }
}

function renderCanonical(value, seen) {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") {
    assertValidUnicode(value);
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("canonical JSON 不允许非有限数值", "WORKFLOW_V2_NON_CANONICAL_VALUE");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) fail("canonical JSON 不允许循环引用", "WORKFLOW_V2_NON_CANONICAL_VALUE");
    for (const key of Reflect.ownKeys(value)) {
      if (key === "length") continue;
      if (typeof key !== "string" || !/^\d+$/.test(key) || String(Number(key)) !== key || Number(key) >= value.length) {
        fail("canonical JSON 数组不允许额外属性", "WORKFLOW_V2_NON_CANONICAL_VALUE");
      }
    }
    seen.add(value);
    const items = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        fail("canonical JSON 不允许稀疏数组", "WORKFLOW_V2_NON_CANONICAL_VALUE");
      }
      const entry = value[index];
      if (entry === undefined || typeof entry === "function" || typeof entry === "symbol" || typeof entry === "bigint") {
        fail("canonical JSON 数组包含不可序列化值", "WORKFLOW_V2_NON_CANONICAL_VALUE");
      }
      items.push(renderCanonical(entry, seen));
    }
    seen.delete(value);
    return `[${items.join(",")}]`;
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail("canonical JSON 只接受普通对象", "WORKFLOW_V2_NON_CANONICAL_VALUE");
    }
    if (seen.has(value)) fail("canonical JSON 不允许循环引用", "WORKFLOW_V2_NON_CANONICAL_VALUE");
    seen.add(value);
    const entries = [];
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string" || !Object.prototype.propertyIsEnumerable.call(value, key))) {
      fail("canonical JSON 对象不允许 Symbol 或非枚举属性", "WORKFLOW_V2_NON_CANONICAL_VALUE");
    }
    for (const key of keys) assertValidUnicode(key);
    for (const key of keys.sort(compareUtf16CodeUnits)) {
      const entry = value[key];
      if (entry === undefined || typeof entry === "function" || typeof entry === "symbol" || typeof entry === "bigint") {
        fail(`canonical JSON 字段 ${key} 不可序列化`, "WORKFLOW_V2_NON_CANONICAL_VALUE");
      }
      entries.push(`${JSON.stringify(key)}:${renderCanonical(entry, seen)}`);
    }
    seen.delete(value);
    return `{${entries.join(",")}}`;
  }
  fail("canonical JSON 包含不可序列化值", "WORKFLOW_V2_NON_CANONICAL_VALUE");
}

export function canonicalJson(value) {
  return renderCanonical(value, new Set());
}

export function canonicalSha256(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function deriveStageResultEnvelopeIdempotencyKey(payload) {
  return `${STAGE_RESULT_IDEMPOTENCY_PREFIX}${canonicalSha256({
    storyId: payload?.storyId,
    recordRevision: payload?.recordRevision,
    stageId: payload?.stageId,
    resultSchemaId: payload?.resultSchemaId,
    contextId: payload?.contextId,
    contextRevision: payload?.contextRevision,
    contextIdempotencyKey: payload?.contextIdempotencyKey,
  })}`;
}

function revisionFilename(revision) {
  if (!Number.isSafeInteger(revision) || revision < 1 || revision > MAX_REVISION) {
    fail(`无效 revision: ${revision}`, "WORKFLOW_V2_INVALID_REVISION", { revision });
  }
  return `${String(revision).padStart(12, "0")}.json`;
}

function assertTrustedTab(tab) {
  if (!tab || typeof tab !== "object" || !String(tab.id ?? "").trim()) {
    fail("必须传入已加载的 story tab", "WORKFLOW_V2_INVALID_TAB");
  }
  return String(tab.id);
}

function validateTarget(storageApi, tab, target, options) {
  try {
    return storageApi.validateStoryStorageTarget(tab, target, options);
  } catch (error) {
    // Two Gateway processes may both pass lstat before one wins mkdir.  Treat
    // EEXIST as a race only after the winner's directory is revalidated.
    if (options?.createDirectory && error?.code === "EEXIST") {
      try {
        return storageApi.validateStoryStorageTarget(tab, target, {
          ...options,
          createDirectory: false,
          mustExist: true,
          expectedType: "directory",
        });
      } catch (revalidationError) {
        error = revalidationError;
      }
    }
    fail(`Workflow v2 存储路径校验失败: ${error.message}`, "WORKFLOW_V2_PATH_BOUNDARY_REJECTED", {
      causeCode: error?.code || "",
    });
  }
}

function resolveStorePaths(tab, storageApi) {
  const storyId = assertTrustedTab(tab);
  let storage;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    try {
      storage = storageApi.getStoryStoragePaths(tab, { create: true });
      break;
    } catch (error) {
      if (error?.code === "EEXIST") continue;
      fail(`故事点存储目录不可用: ${error.message}`, "WORKFLOW_V2_PATH_BOUNDARY_REJECTED", {
        causeCode: error?.code || "",
      });
    }
  }
  if (!storage) {
    fail("故事点存储目录初始化竞争未收敛", "WORKFLOW_V2_PATH_BOUNDARY_REJECTED", { causeCode: "EEXIST" });
  }
  const workflowDirectory = path.join(storage.storyDirectory, "workflow-v2");
  validateTarget(storageApi, tab, workflowDirectory, { createDirectory: true, expectedType: "directory" });
  const envelopeDirectory = path.join(workflowDirectory, "envelopes");
  validateTarget(storageApi, tab, envelopeDirectory, {
    baseDirectory: workflowDirectory,
    createDirectory: true,
    expectedType: "directory",
  });
  const streamDirectories = new Map();
  for (const [schemaId, directoryName] of Object.entries(STREAM_DIRECTORIES)) {
    const directory = path.join(envelopeDirectory, directoryName);
    validateTarget(storageApi, tab, directory, {
      baseDirectory: envelopeDirectory,
      createDirectory: true,
      expectedType: "directory",
    });
    streamDirectories.set(schemaId, directory);
  }
  const lockPath = path.join(workflowDirectory, ".envelope-store.lock");
  validateTarget(storageApi, tab, lockPath, { baseDirectory: workflowDirectory, mustExist: false });
  return { storyId, storage, workflowDirectory, envelopeDirectory, streamDirectories, lockPath };
}

function contextStreamName(contextId) {
  if (typeof contextId !== "string" || !contextId) {
    fail("stage-context 必须提供非空 contextId", "WORKFLOW_V2_IDENTITY_MISMATCH");
  }
  return createHash("sha256").update(contextId, "utf8").digest("hex");
}

function streamKey(schemaId, contextId = null) {
  return schemaId === WORKFLOW_V2_SCHEMA_IDS.stageContext
    ? `${schemaId}\u0000${contextStreamName(contextId)}`
    : schemaId;
}

function resolveStreamDirectory(paths, tab, storageApi, schemaId, contextId = null, { create = false } = {}) {
  const baseDirectory = paths.streamDirectories.get(schemaId);
  if (!baseDirectory) fail(`不支持的 payload Schema: ${schemaId}`, "WORKFLOW_V2_SCHEMA_NOT_REGISTERED");
  if (schemaId !== WORKFLOW_V2_SCHEMA_IDS.stageContext) return baseDirectory;
  const directory = path.join(baseDirectory, contextStreamName(contextId));
  validateTarget(storageApi, tab, directory, {
    baseDirectory,
    createDirectory: create,
    mustExist: !create,
    expectedType: "directory",
  });
  return directory;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function acquireStoryLock(paths, tab, storageApi, { timeoutMs, pollMs }) {
  const token = `${process.pid}:${randomUUID()}`;
  const startedAt = Date.now();
  while (true) {
    validateTarget(storageApi, tab, paths.lockPath, { baseDirectory: paths.workflowDirectory, mustExist: false });
    let handle;
    let created = false;
    try {
      handle = await open(paths.lockPath, "wx", 0o600);
      created = true;
      await handle.writeFile(token, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      validateTarget(storageApi, tab, paths.lockPath, {
        baseDirectory: paths.workflowDirectory,
        mustExist: true,
        expectedType: "file",
      });
      return async () => {
        validateTarget(storageApi, tab, paths.lockPath, {
          baseDirectory: paths.workflowDirectory,
          mustExist: true,
          expectedType: "file",
        });
        let owner;
        try {
          owner = await readFile(paths.lockPath, "utf8");
        } catch (error) {
          fail(`Workflow v2 锁丢失: ${error.message}`, "WORKFLOW_V2_LOCK_LOST");
        }
        if (owner !== token) fail("Workflow v2 锁所有权已改变", "WORKFLOW_V2_LOCK_LOST");
        await unlink(paths.lockPath);
      };
    } catch (error) {
      try {
        await handle?.close();
      } catch {}
      if (created) {
        try {
          await unlink(paths.lockPath);
        } catch (cleanupError) {
          if (cleanupError?.code !== "ENOENT") {
            fail(`Workflow v2 锁清理失败: ${cleanupError.message}`, "WORKFLOW_V2_LOCK_CLEANUP_FAILED");
          }
        }
      }
      if (error instanceof WorkflowV2EnvelopeStoreError) throw error;
      if (error?.code !== "EEXIST") throw error;
      if (Date.now() - startedAt >= timeoutMs) {
        fail("Workflow v2 story 目录锁超时", "WORKFLOW_V2_LOCK_TIMEOUT");
      }
      await sleep(pollMs);
    }
  }
}

function unsignedEnvelope(envelope) {
  const { envelopeSha256: _ignored, ...unsigned } = envelope;
  return unsigned;
}

function assertEqual(actual, expected, label, code = "WORKFLOW_V2_IDENTITY_MISMATCH") {
  if (actual !== expected) fail(`${label} 与 envelope 不一致`, code, { actual, expected });
}

function assertPayloadIdentity(envelope, registry) {
  const payload = envelope.payload;
  if (
    envelope.payloadSchemaId !== WORKFLOW_V2_SCHEMA_IDS.stageResultRecord
    && typeof envelope.idempotencyKey === "string"
    && envelope.idempotencyKey.startsWith(STAGE_RESULT_IDEMPOTENCY_PREFIX)
  ) {
    fail(
      `${STAGE_RESULT_IDEMPOTENCY_PREFIX} namespace is reserved for stage-result records`,
      "WORKFLOW_V2_IDEMPOTENCY_NAMESPACE_RESERVED",
    );
  }
  switch (envelope.payloadSchemaId) {
    case WORKFLOW_V2_SCHEMA_IDS.stageContext:
      assertEqual(payload.story?.storyId, envelope.storyId, "stage-context storyId");
      assertEqual(payload.contextId, envelope.contextId, "stage-context contextId");
      assertEqual(payload.revision, envelope.revision, "stage-context revision");
      assertEqual(payload.idempotencyKey, envelope.idempotencyKey, "stage-context idempotencyKey");
      assertEqual(envelope.recordId, payload.contextId, "stage-context recordId");
      break;
    case WORKFLOW_V2_SCHEMA_IDS.workflowCheckpoint:
      assertEqual(payload.storyId, envelope.storyId, "workflow-checkpoint storyId");
      assertEqual(payload.revision, envelope.revision, "workflow-checkpoint revision");
      assertEqual(envelope.recordId, "workflow-checkpoint", "workflow-checkpoint recordId");
      assertEqual(envelope.contextId, null, "workflow-checkpoint contextId");
      break;
    case WORKFLOW_V2_SCHEMA_IDS.evidenceManifest:
      assertEqual(payload.storyId, envelope.storyId, "evidence-manifest storyId");
      assertEqual(envelope.recordId, "evidence-manifest", "evidence-manifest recordId");
      assertEqual(envelope.contextId, null, "evidence-manifest contextId");
      break;
    case WORKFLOW_V2_SCHEMA_IDS.evidenceReceipt:
      assertEqual(envelope.recordId, payload.receiptId, "evidence-receipt recordId");
      assertEqual(envelope.contextId, null, "evidence-receipt contextId");
      if (payload.idempotencyKey !== null) {
        assertEqual(payload.idempotencyKey, envelope.idempotencyKey, "evidence-receipt idempotencyKey");
      }
      break;
    case WORKFLOW_V2_SCHEMA_IDS.stageResultRecord:
      assertEqual(payload.storyId, envelope.storyId, "stage-result storyId");
      assertEqual(payload.recordRevision, envelope.revision, "stage-result recordRevision");
      assertEqual(envelope.recordId, "stage-result", "stage-result recordId");
      assertEqual(envelope.contextId, null, "stage-result contextId");
      assertEqual(
        envelope.idempotencyKey,
        deriveStageResultEnvelopeIdempotencyKey(payload),
        "stage-result envelope idempotencyKey",
      );
      registry.assertValid(payload.resultSchemaId, payload.result, "stage-result nested result");
      assertEqual(payload.result.contextId, payload.contextId, "stage-result nested contextId");
      assertEqual(payload.result.contextRevision, payload.contextRevision, "stage-result nested contextRevision");
      assertEqual(
        payload.result.idempotencyKey,
        payload.contextIdempotencyKey,
        "stage-result nested idempotencyKey",
      );
      assertEqual(
        payload.resultSha256,
        canonicalSha256(payload.result),
        "stage-result resultSha256",
        "WORKFLOW_V2_TAMPER_DETECTED",
      );
      break;
    default:
      fail(`不支持的 payload Schema: ${envelope.payloadSchemaId}`, "WORKFLOW_V2_SCHEMA_NOT_REGISTERED");
  }
}

function assertEnvelopeIntegrity(envelope, {
  expectedStoryId,
  previousEnvelope = null,
  filename = "",
} = {}, registry) {
  registry.assertValid(envelope.payloadSchemaId, envelope.payload, "workflow envelope payload");
  assertPayloadIdentity(envelope, registry);
  assertEqual(envelope.storyId, expectedStoryId, "storyId");
  if (filename) assertEqual(filename, revisionFilename(envelope.revision), "revision filename", "WORKFLOW_V2_REVISION_FILENAME_MISMATCH");
  assertEqual(envelope.payloadSha256, canonicalSha256(envelope.payload), "payloadSha256", "WORKFLOW_V2_TAMPER_DETECTED");
  assertEqual(envelope.envelopeSha256, canonicalSha256(unsignedEnvelope(envelope)), "envelopeSha256", "WORKFLOW_V2_TAMPER_DETECTED");
  assertEqual(
    envelope.previousEnvelopeSha256,
    previousEnvelope?.envelopeSha256 || null,
    "previousEnvelopeSha256",
    "WORKFLOW_V2_CHAIN_MISMATCH",
  );
}

function assertStageResultContextBinding(resultEnvelope, contextEnvelopes) {
  const payload = resultEnvelope.payload;
  const contextEnvelope = contextEnvelopes.find((entry) => (
    entry.contextId === payload.contextId
    && entry.revision === payload.contextRevision
  ));
  if (!contextEnvelope) {
    fail(
      `stage-result references a missing frozen StageContext: ${payload.contextId}@${payload.contextRevision}`,
      "WORKFLOW_V2_STAGE_CONTEXT_NOT_FOUND",
    );
  }
  assertEqual(contextEnvelope.storyId, resultEnvelope.storyId, "stage-result frozen context storyId");
  assertEqual(contextEnvelope.payload.stage.id, payload.stageId, "stage-result frozen context stageId");
  assertEqual(contextEnvelope.payload.output.schemaId, payload.resultSchemaId, "stage-result frozen context resultSchemaId");
  assertEqual(
    contextEnvelope.payload.idempotencyKey,
    payload.contextIdempotencyKey,
    "stage-result frozen context idempotencyKey",
  );
}

async function readRevisionStreamUnlocked(
  paths,
  tab,
  storageApi,
  schemaId,
  streamDirectory,
  registry,
  expectedContextStream = "",
) {
  const entries = await readdir(streamDirectory, { withFileTypes: true });
  const filenames = entries
    .filter((entry) => ENVELOPE_FILE_PATTERN.test(entry.name))
    .map((entry) => {
      if (!entry.isFile()) fail(`Envelope 不是普通文件: ${entry.name}`, "WORKFLOW_V2_PATH_BOUNDARY_REJECTED");
      return entry.name;
    })
    .sort();
  const envelopes = [];
  for (let index = 0; index < filenames.length; index += 1) {
    const filename = filenames[index];
    const pathname = path.join(streamDirectory, filename);
    validateTarget(storageApi, tab, pathname, {
      baseDirectory: streamDirectory,
      mustExist: true,
      expectedType: "file",
    });
    const fileStat = await lstat(pathname);
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) fail(`Envelope 路径不安全: ${filename}`, "WORKFLOW_V2_PATH_BOUNDARY_REJECTED");
    const bytes = await readFile(pathname);
    let raw;
    try {
      raw = STRICT_UTF8_DECODER.decode(bytes);
    } catch (error) {
      fail(`Envelope 不是合法 UTF-8: ${filename}: ${error.message}`, "WORKFLOW_V2_TAMPER_DETECTED");
    }
    let envelope;
    try {
      envelope = JSON.parse(raw);
    } catch (error) {
      fail(`Envelope JSON 损坏: ${filename}: ${error.message}`, "WORKFLOW_V2_TAMPER_DETECTED");
    }
    registry.assertValid(WORKFLOW_V2_SCHEMA_IDS.workflowEnvelope, envelope, "workflow envelope");
    if (raw !== canonicalJson(envelope)) fail(`Envelope 不是 canonical JSON: ${filename}`, "WORKFLOW_V2_TAMPER_DETECTED");
    assertEqual(envelope.payloadSchemaId, schemaId, "stream schemaId", "WORKFLOW_V2_STREAM_MISMATCH");
    assertEqual(envelope.revision, index + 1, "continuous revision", "WORKFLOW_V2_REVISION_GAP");
    assertEnvelopeIntegrity(envelope, {
      expectedStoryId: paths.storyId,
      previousEnvelope: envelopes.at(-1) || null,
      filename,
    }, registry);
    if (expectedContextStream) {
      assertEqual(
        contextStreamName(envelope.contextId),
        expectedContextStream,
        "stage-context stream",
        "WORKFLOW_V2_STREAM_MISMATCH",
      );
    }
    envelopes.push(envelope);
  }
  return envelopes;
}

async function readSchemaStreamsUnlocked(paths, tab, storageApi, schemaId, registry) {
  const baseDirectory = paths.streamDirectories.get(schemaId);
  if (schemaId !== WORKFLOW_V2_SCHEMA_IDS.stageContext) {
    const envelopes = await readRevisionStreamUnlocked(
      paths,
      tab,
      storageApi,
      schemaId,
      baseDirectory,
      registry,
    );
    return {
      envelopes,
      streams: new Map([[streamKey(schemaId), envelopes]]),
    };
  }

  const entries = (await readdir(baseDirectory, { withFileTypes: true }))
    .sort((left, right) => compareUtf16CodeUnits(left.name, right.name));
  const envelopes = [];
  const streams = new Map();
  for (const entry of entries) {
    if (!CONTEXT_STREAM_PATTERN.test(entry.name) || !entry.isDirectory()) {
      fail(`stage-context 流目录不合法: ${entry.name}`, "WORKFLOW_V2_PATH_BOUNDARY_REJECTED");
    }
    const directory = path.join(baseDirectory, entry.name);
    validateTarget(storageApi, tab, directory, {
      baseDirectory,
      mustExist: true,
      expectedType: "directory",
    });
    const stream = await readRevisionStreamUnlocked(
      paths,
      tab,
      storageApi,
      schemaId,
      directory,
      registry,
      entry.name,
    );
    envelopes.push(...stream);
    streams.set(`${schemaId}\u0000${entry.name}`, stream);
  }
  return { envelopes, streams };
}

function verifyGlobalConstraints(envelopes) {
  const idempotencyKeys = new Set();
  const receiptIds = new Set();
  const receiptOperations = new Map();
  for (const envelope of envelopes) {
    if (idempotencyKeys.has(envelope.idempotencyKey)) {
      fail(`重复 idempotencyKey: ${envelope.idempotencyKey}`, "WORKFLOW_V2_TAMPER_DETECTED");
    }
    idempotencyKeys.add(envelope.idempotencyKey);
    if (envelope.payloadSchemaId !== WORKFLOW_V2_SCHEMA_IDS.evidenceReceipt) continue;
    if (receiptIds.has(envelope.recordId)) {
      fail(`Receipt recordId 重复: ${envelope.recordId}`, "WORKFLOW_V2_RECEIPT_APPEND_ONLY_CONFLICT");
    }
    receiptIds.add(envelope.recordId);
    const operationId = envelope.payload.operationId;
    if (receiptOperations.has(operationId)) {
      fail(`Receipt operationId 重复: ${operationId}`, "WORKFLOW_V2_RECEIPT_OPERATION_CONFLICT");
    }
    receiptOperations.set(operationId, envelope.operationArgsSha256);
  }
  const contexts = envelopes.filter((entry) => entry.payloadSchemaId === WORKFLOW_V2_SCHEMA_IDS.stageContext);
  for (const envelope of envelopes) {
    if (envelope.payloadSchemaId === WORKFLOW_V2_SCHEMA_IDS.stageResultRecord) {
      assertStageResultContextBinding(envelope, contexts);
    }
  }
}

async function readAllUnlocked(paths, tab, storageApi, registry) {
  const bySchema = new Map();
  const byStream = new Map();
  const all = [];
  for (const schemaId of Object.keys(STREAM_DIRECTORIES)) {
    const schemaStreams = await readSchemaStreamsUnlocked(paths, tab, storageApi, schemaId, registry);
    bySchema.set(schemaId, schemaStreams.envelopes);
    for (const [key, stream] of schemaStreams.streams) byStream.set(key, stream);
    all.push(...schemaStreams.envelopes);
  }
  verifyGlobalConstraints(all);
  return { all, bySchema, byStream };
}

function sameReplayIdentity(existing, requested) {
  return existing.storyId === requested.storyId
    && existing.recordId === requested.recordId
    && existing.contextId === requested.contextId
    && existing.revision === requested.revision
    && existing.payloadSchemaId === requested.payloadSchemaId
    && existing.payloadSha256 === requested.payloadSha256
    && existing.operationArgsSha256 === requested.operationArgsSha256;
}

function storedEnvelopePath(paths, tab, storageApi, envelope) {
  const directory = resolveStreamDirectory(
    paths,
    tab,
    storageApi,
    envelope.payloadSchemaId,
    envelope.contextId,
  );
  const pathname = path.join(directory, revisionFilename(envelope.revision));
  validateTarget(storageApi, tab, pathname, {
    baseDirectory: directory,
    mustExist: true,
    expectedType: "file",
  });
  return pathname;
}

async function writeEnvelopeNoReplace(paths, tab, storageApi, envelope) {
  const streamDirectory = resolveStreamDirectory(
    paths,
    tab,
    storageApi,
    envelope.payloadSchemaId,
    envelope.contextId,
    { create: true },
  );
  const filename = revisionFilename(envelope.revision);
  const targetPath = path.join(streamDirectory, filename);
  const temporaryPath = path.join(streamDirectory, `.${filename}.${process.pid}.${randomUUID()}.tmp`);
  validateTarget(storageApi, tab, targetPath, { baseDirectory: streamDirectory, mustExist: false });
  validateTarget(storageApi, tab, temporaryPath, { baseDirectory: streamDirectory, mustExist: false });
  let handle;
  let linked = false;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(canonicalJson(envelope), "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    validateTarget(storageApi, tab, temporaryPath, {
      baseDirectory: streamDirectory,
      mustExist: true,
      expectedType: "file",
    });
    await link(temporaryPath, targetPath);
    linked = true;
    validateTarget(storageApi, tab, targetPath, {
      baseDirectory: streamDirectory,
      mustExist: true,
      expectedType: "file",
    });
  } catch (error) {
    if (error?.code === "EEXIST") {
      fail(`Envelope revision ${envelope.revision} 已存在`, "WORKFLOW_V2_ATOMIC_NO_OVERWRITE");
    }
    throw error;
  } finally {
    try {
      await handle?.close();
    } catch {}
    try {
      await unlink(temporaryPath);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        if (linked) fail(`Envelope 临时文件清理失败: ${error.message}`, "WORKFLOW_V2_TEMP_CLEANUP_FAILED");
        throw error;
      }
    }
  }
  return targetPath;
}

export class WorkflowV2EnvelopeStore {
  constructor({
    registry = workflowV2SchemaRegistry,
    storageApi = storyStore,
    lockTimeoutMs = 5000,
    lockPollMs = 10,
    now = () => new Date().toISOString(),
  } = {}) {
    this.registry = registry;
    this.storageApi = storageApi;
    this.lockTimeoutMs = lockTimeoutMs;
    this.lockPollMs = lockPollMs;
    this.now = now;
  }

  async append({
    tab,
    recordId,
    contextId = null,
    revision,
    idempotencyKey,
    payloadSchemaId,
    payload,
    operationArgs,
  }) {
    const paths = resolveStorePaths(tab, this.storageApi);
    revisionFilename(revision);
    if (!Object.hasOwn(STREAM_DIRECTORIES, payloadSchemaId)) {
      fail(`不支持的 payload Schema: ${payloadSchemaId}`, "WORKFLOW_V2_SCHEMA_NOT_REGISTERED");
    }
    const payloadSnapshot = JSON.parse(canonicalJson(payload));
    this.registry.assertValid(payloadSchemaId, payloadSnapshot, "workflow envelope payload");
    const isReceipt = payloadSchemaId === WORKFLOW_V2_SCHEMA_IDS.evidenceReceipt;
    if (isReceipt && operationArgs === undefined) {
      fail("Receipt envelope 必须显式提供 operationArgs", "WORKFLOW_V2_RECEIPT_ARGS_REQUIRED");
    }
    if (isReceipt && (operationArgs === null || typeof operationArgs !== "object" || Array.isArray(operationArgs))) {
      fail("Receipt operationArgs 必须是 JSON 对象", "WORKFLOW_V2_RECEIPT_ARGS_REQUIRED");
    }
    if (!isReceipt && operationArgs !== undefined) {
      fail("非 Receipt envelope 不接受 operationArgs", "WORKFLOW_V2_UNEXPECTED_OPERATION_ARGS");
    }
    const operationArgsSha256 = isReceipt
      ? canonicalSha256({
        action: payloadSnapshot.action,
        toolName: payloadSnapshot.toolName,
        rootId: payloadSnapshot.rootId ?? null,
        selector: payloadSnapshot.selector ?? null,
        operationArgs,
      })
      : null;
    const requested = {
      storyId: paths.storyId,
      recordId,
      contextId,
      revision,
      idempotencyKey,
      payloadSchemaId,
      payloadSha256: canonicalSha256(payloadSnapshot),
      operationArgsSha256,
      payload: payloadSnapshot,
    };
    assertPayloadIdentity(requested, this.registry);

    const release = await acquireStoryLock(paths, tab, this.storageApi, {
      timeoutMs: this.lockTimeoutMs,
      pollMs: this.lockPollMs,
    });
    try {
      const existing = await readAllUnlocked(paths, tab, this.storageApi, this.registry);
      if (payloadSchemaId === WORKFLOW_V2_SCHEMA_IDS.stageResultRecord) {
        assertStageResultContextBinding(
          requested,
          existing.bySchema.get(WORKFLOW_V2_SCHEMA_IDS.stageContext) || [],
        );
      }
      const idempotentExisting = existing.all.find((entry) => entry.idempotencyKey === idempotencyKey);
      if (idempotentExisting) {
        if (!sameReplayIdentity(idempotentExisting, requested)) {
          fail(`idempotencyKey 已绑定不同 envelope: ${idempotencyKey}`, "WORKFLOW_V2_IDEMPOTENCY_CONFLICT");
        }
        return {
          envelope: structuredClone(idempotentExisting),
          replayed: true,
          path: storedEnvelopePath(paths, tab, this.storageApi, idempotentExisting),
        };
      }

      if (isReceipt) {
        const receipts = existing.bySchema.get(WORKFLOW_V2_SCHEMA_IDS.evidenceReceipt) || [];
        const sameOperation = receipts.find((entry) => entry.payload.operationId === payloadSnapshot.operationId);
        if (sameOperation) {
          if (sameOperation.operationArgsSha256 !== operationArgsSha256) {
            fail(`operationId 已绑定不同参数: ${payloadSnapshot.operationId}`, "WORKFLOW_V2_RECEIPT_OPERATION_CONFLICT");
          }
          return {
            envelope: structuredClone(sameOperation),
            replayed: true,
            path: storedEnvelopePath(paths, tab, this.storageApi, sameOperation),
          };
        }
        if (receipts.some((entry) => entry.recordId === recordId)) {
          fail(`Receipt 只允许追加，receiptId 已存在: ${recordId}`, "WORKFLOW_V2_RECEIPT_APPEND_ONLY_CONFLICT");
        }
      }

      const requestedStreamKey = streamKey(payloadSchemaId, contextId);
      const stream = existing.byStream.get(requestedStreamKey) || [];
      const expectedRevision = stream.length + 1;
      if (revision < expectedRevision) {
        fail(`拒绝旧 revision ${revision}，期望 ${expectedRevision}`, "WORKFLOW_V2_STALE_REVISION");
      }
      if (revision > expectedRevision) {
        fail(`revision 不连续: ${revision}，期望 ${expectedRevision}`, "WORKFLOW_V2_REVISION_GAP");
      }

      const unsigned = {
        schemaVersion: "workflow-envelope-v2",
        storyId: paths.storyId,
        recordId,
        contextId,
        revision,
        idempotencyKey,
        payloadSchemaId,
        payloadSha256: requested.payloadSha256,
        operationArgsSha256,
        previousEnvelopeSha256: stream.at(-1)?.envelopeSha256 || null,
        createdAt: this.now(),
        payload: payloadSnapshot,
      };
      const envelope = { ...unsigned, envelopeSha256: canonicalSha256(unsigned) };
      this.registry.assertValid(WORKFLOW_V2_SCHEMA_IDS.workflowEnvelope, envelope, "workflow envelope");
      assertEnvelopeIntegrity(envelope, {
        expectedStoryId: paths.storyId,
        previousEnvelope: stream.at(-1) || null,
        filename: revisionFilename(revision),
      }, this.registry);
      const targetPath = await writeEnvelopeNoReplace(paths, tab, this.storageApi, envelope);
      return { envelope: structuredClone(envelope), replayed: false, path: targetPath };
    } finally {
      await release();
    }
  }

  async readAll({ tab, payloadSchemaId = "" }) {
    const paths = resolveStorePaths(tab, this.storageApi);
    if (payloadSchemaId && !Object.hasOwn(STREAM_DIRECTORIES, payloadSchemaId)) {
      fail(`不支持的 payload Schema: ${payloadSchemaId}`, "WORKFLOW_V2_SCHEMA_NOT_REGISTERED");
    }
    const release = await acquireStoryLock(paths, tab, this.storageApi, {
      timeoutMs: this.lockTimeoutMs,
      pollMs: this.lockPollMs,
    });
    try {
      const existing = await readAllUnlocked(paths, tab, this.storageApi, this.registry);
      const selected = payloadSchemaId ? existing.bySchema.get(payloadSchemaId) || [] : existing.all;
      return selected.map((entry) => structuredClone(entry));
    } finally {
      await release();
    }
  }

  async readRevision({ tab, payloadSchemaId, revision, contextId = null }) {
    if (!payloadSchemaId || !Object.hasOwn(STREAM_DIRECTORIES, payloadSchemaId)) {
      fail(`不支持的 payload Schema: ${payloadSchemaId || "<empty>"}`, "WORKFLOW_V2_SCHEMA_NOT_REGISTERED");
    }
    revisionFilename(revision);
    if (payloadSchemaId === WORKFLOW_V2_SCHEMA_IDS.stageContext && !contextId) {
      fail("读取 stage-context revision 时必须提供 contextId", "WORKFLOW_V2_IDENTITY_MISMATCH");
    }
    const envelopes = await this.readAll({ tab, payloadSchemaId });
    return structuredClone(envelopes.find((entry) => (
      entry.revision === revision
      && (payloadSchemaId !== WORKFLOW_V2_SCHEMA_IDS.stageContext || entry.contextId === contextId)
    )) || null);
  }
}

export const workflowV2EnvelopeStore = new WorkflowV2EnvelopeStore();

export function appendWorkflowV2Envelope(input) {
  return workflowV2EnvelopeStore.append(input);
}

export function readWorkflowV2Envelopes(input) {
  return workflowV2EnvelopeStore.readAll(input);
}

export function appendStageContext({ tab, payload }) {
  return workflowV2EnvelopeStore.append({
    tab,
    recordId: payload?.contextId,
    contextId: payload?.contextId,
    revision: payload?.revision,
    idempotencyKey: payload?.idempotencyKey,
    payloadSchemaId: WORKFLOW_V2_SCHEMA_IDS.stageContext,
    payload,
  });
}

export function appendWorkflowCheckpoint({ tab, revision, idempotencyKey, payload }) {
  return workflowV2EnvelopeStore.append({
    tab,
    recordId: "workflow-checkpoint",
    contextId: null,
    revision,
    idempotencyKey,
    payloadSchemaId: WORKFLOW_V2_SCHEMA_IDS.workflowCheckpoint,
    payload,
  });
}

export function appendEvidenceManifest({ tab, revision, idempotencyKey, payload }) {
  return workflowV2EnvelopeStore.append({
    tab,
    recordId: "evidence-manifest",
    contextId: null,
    revision,
    idempotencyKey,
    payloadSchemaId: WORKFLOW_V2_SCHEMA_IDS.evidenceManifest,
    payload,
  });
}

export function appendEvidenceReceipt({ tab, revision, idempotencyKey, operationArgs, payload }) {
  return workflowV2EnvelopeStore.append({
    tab,
    recordId: payload?.receiptId,
    contextId: null,
    revision,
    idempotencyKey,
    payloadSchemaId: WORKFLOW_V2_SCHEMA_IDS.evidenceReceipt,
    payload,
    operationArgs,
  });
}

export function appendStageResultRecord({ tab, payload }) {
  const payloadSnapshot = JSON.parse(canonicalJson(payload));
  workflowV2SchemaRegistry.assertValid(
    WORKFLOW_V2_SCHEMA_IDS.stageResultRecord,
    payloadSnapshot,
    "stage-result record",
  );
  return workflowV2EnvelopeStore.append({
    tab,
    recordId: "stage-result",
    contextId: null,
    revision: payloadSnapshot.recordRevision,
    idempotencyKey: deriveStageResultEnvelopeIdempotencyKey(payloadSnapshot),
    payloadSchemaId: WORKFLOW_V2_SCHEMA_IDS.stageResultRecord,
    payload: payloadSnapshot,
  });
}
