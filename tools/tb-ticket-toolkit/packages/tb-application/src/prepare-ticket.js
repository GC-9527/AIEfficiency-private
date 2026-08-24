import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  AttachmentPrepareState,
  ToolkitError,
  assignAttachmentLocalNames,
  decideAttachmentSelection,
  normalizeTicketContext,
  redactErrorMessage,
} from "../../tb-domain/src/index.js";
import { assertSafeRepoPath, prepareGitIsolation } from "./git-isolation.js";

const DEFAULT_LIMITS = Object.freeze({
  autoDownloadMaxCount: 3,
  maxSingleFileBytes: 100 * 1024 * 1024,
  maxTotalBytes: 300 * 1024 * 1024,
});

function relativePosix(root, target) {
  return path.relative(root, target).split(path.sep).join("/");
}

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new ToolkitError("LOCAL_STATE_INVALID", `本地状态文件无法解析：${path.basename(file)}`);
  }
}

function writeJsonAtomic(file, value, gitRoot) {
  assertSafeRepoPath(gitRoot, file);
  const part = `${file}.${process.pid}.${randomUUID()}.part`;
  try {
    fs.writeFileSync(part, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(part, file);
  } finally {
    try { fs.rmSync(part, { force: true }); } catch {}
  }
}

async function* bodyChunks(result) {
  const body = result?.body ?? result;
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
    yield Buffer.from(body);
    return;
  }
  if (body && typeof body[Symbol.asyncIterator] === "function") {
    for await (const chunk of body) yield Buffer.from(chunk);
    return;
  }
  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        if (next.value?.byteLength) yield Buffer.from(next.value);
      }
    } finally {
      try { reader.releaseLock?.(); } catch {}
    }
    return;
  }
  throw new ToolkitError("ATTACHMENT_RESPONSE_INVALID", "附件 provider 未返回可读取的字节流");
}

function sha256File(file) {
  const hash = createHash("sha256");
  const fd = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    while (true) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function reusableReceipt(receipt, manifestDigest, gitRoot) {
  if (!receipt || receipt.manifestDigest !== manifestDigest || !receipt.localRelativePath || !receipt.sha256) return null;
  const target = assertSafeRepoPath(gitRoot, path.join(gitRoot, receipt.localRelativePath));
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return null;
  const digest = sha256File(target);
  const size = fs.statSync(target).size;
  return digest === receipt.sha256 && size === receipt.size ? { ...receipt, reused: true } : null;
}

async function downloadOne({ provider, attachment, isolation, manifestDigest, limits, totalSoFar }) {
  if (attachment.size != null && attachment.size > limits.maxSingleFileBytes) {
    throw new ToolkitError("ATTACHMENT_TOO_LARGE", `附件 ${attachment.originalName} 超过单文件上限`);
  }
  const target = assertSafeRepoPath(isolation.gitRoot, path.join(isolation.tempDirectory, attachment.localName));
  const part = assertSafeRepoPath(isolation.gitRoot, `${target}.${process.pid}.${randomUUID()}.part`);
  const hash = createHash("sha256");
  let size = 0;
  let fd = null;
  try {
    const response = await provider.openAttachment(attachment.attachmentId);
    const declared = Number(response?.size ?? response?.contentLength ?? 0);
    if (declared > limits.maxSingleFileBytes) throw new ToolkitError("ATTACHMENT_TOO_LARGE", `附件 ${attachment.originalName} 超过单文件上限`);
    if (declared > 0 && totalSoFar + declared > limits.maxTotalBytes) {
      throw new ToolkitError("ATTACHMENT_TOTAL_TOO_LARGE", "选中附件超过总大小上限");
    }
    fd = fs.openSync(part, "wx", 0o600);
    for await (const chunk of bodyChunks(response)) {
      size += chunk.length;
      if (size > limits.maxSingleFileBytes) throw new ToolkitError("ATTACHMENT_TOO_LARGE", `附件 ${attachment.originalName} 超过单文件上限`);
      if (totalSoFar + size > limits.maxTotalBytes) throw new ToolkitError("ATTACHMENT_TOTAL_TOO_LARGE", "选中附件超过总大小上限");
      fs.writeSync(fd, chunk);
      hash.update(chunk);
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    const digest = hash.digest("hex");
    if (fs.existsSync(target)) {
      const existingDigest = sha256File(target);
      const existingSize = fs.statSync(target).size;
      if (existingDigest !== digest || existingSize !== size) {
        throw new ToolkitError("LOCAL_FILE_CONFLICT", `本地附件 ${attachment.localName} 已存在且内容不同，禁止覆盖`);
      }
      fs.rmSync(part, { force: true });
    } else {
      fs.renameSync(part, target);
    }
    return {
      attachmentId: attachment.attachmentId,
      originalName: attachment.originalName,
      localRelativePath: relativePosix(isolation.gitRoot, target),
      size,
      sha256: digest,
      manifestDigest,
      reused: false,
    };
  } finally {
    try { if (fd != null) fs.closeSync(fd); } catch {}
    try { fs.rmSync(part, { force: true }); } catch {}
  }
}

function publicGitIsolation(isolation) {
  return {
    gitRoot: isolation.gitRoot,
    excludeFile: isolation.excludeFile,
    ignoreRule: isolation.ignoreRule,
    verified: isolation.verified,
  };
}

function applyReceiptsToContext(context, selectedIds, receipts, failedId = null, failedCode = null) {
  const receiptById = new Map(receipts.map((item) => [item.attachmentId, item]));
  const selected = new Set(selectedIds);
  for (const item of context.attachments) {
    const receipt = receiptById.get(item.attachmentId);
    item.selected = selected.has(item.attachmentId);
    if (receipt) {
      item.downloadStatus = "DOWNLOADED";
      item.localRelativePath = receipt.localRelativePath;
      item.sha256 = receipt.sha256;
      item.errorCode = null;
    } else if (item.attachmentId === failedId) {
      item.downloadStatus = "FAILED";
      item.errorCode = failedCode;
    } else if (item.selected) {
      item.downloadStatus = "PENDING";
    } else {
      item.downloadStatus = "NOT_SELECTED";
    }
  }
}

export async function prepareTicket({
  provider,
  repoPath,
  taskRef,
  selection = null,
  limits: limitOverrides = {},
  now = () => new Date().toISOString(),
} = {}) {
  if (!provider || typeof provider.readTicket !== "function" || typeof provider.openAttachment !== "function") {
    throw new ToolkitError("PROVIDER_CONFIG_INVALID", "tb_ticket_prepare 需要只读 provider");
  }
  const limits = { ...DEFAULT_LIMITS, ...limitOverrides };
  const snapshot = await provider.readTicket(taskRef);
  const context = normalizeTicketContext(snapshot, { collectedAt: now() });
  const isolation = prepareGitIsolation({ repoPath, taskNo: context.task.taskNo });
  context.gitIsolation = publicGitIsolation(isolation);
  context.attachments = assignAttachmentLocalNames(context.attachments);

  const contextPath = path.join(isolation.tempDirectory, "ticket-context.json");
  const manifestPath = path.join(isolation.tempDirectory, "attachment-manifest.json");
  const selectionPath = path.join(isolation.tempDirectory, "attachment-selection.json");
  const receiptsPath = path.join(isolation.tempDirectory, "attachment-receipts.json");
  const sourceBlockers = [];
  if (snapshot.comments?.available !== true || snapshot.comments?.complete !== true) {
    sourceBlockers.push({
      field: "comments",
      reason: redactErrorMessage(snapshot.comments?.error || "comment coverage is incomplete"),
    });
  }
  if (snapshot.attachments?.available !== true || snapshot.attachments?.complete !== true) {
    sourceBlockers.push({
      field: "attachments",
      reason: redactErrorMessage(snapshot.attachments?.error || "attachment coverage is incomplete"),
    });
  }
  if (snapshot.note?.ok !== true) {
    sourceBlockers.push({
      field: "remarks",
      reason: redactErrorMessage(snapshot.note?.error || "rich note coverage is incomplete"),
    });
  }
  if (sourceBlockers.length) {
    writeJsonAtomic(contextPath, context, isolation.gitRoot);
    return {
      state: AttachmentPrepareState.BLOCKED,
      task: { taskId: context.task.taskId, taskNo: context.task.taskNo, title: context.task.title },
      contextDigest: context.contextDigest,
      contextFile: relativePosix(isolation.gitRoot, contextPath),
      downloads: [],
      choices: [],
      blockers: sourceBlockers,
      gitIsolation: publicGitIsolation(isolation),
      error: {
        code: "CONTEXT_INCOMPLETE",
        message: "required Teambition comment or attachment coverage is incomplete",
      },
    };
  }
  const previousSelection = selection ? null : readJson(selectionPath);
  const decision = decideAttachmentSelection(context.attachments, {
    selection,
    savedSelection: previousSelection,
    autoDownloadMaxCount: limits.autoDownloadMaxCount,
  });
  const manifest = {
    schemaVersion: 1,
    taskId: context.task.taskId,
    taskNo: context.task.taskNo,
    contextDigest: context.contextDigest,
    manifestDigest: decision.manifestDigest,
    attachments: context.attachments.map(({ localName, ...item }) => ({ ...item, localName })),
    collectedAt: context.collectedAt,
  };
  writeJsonAtomic(contextPath, context, isolation.gitRoot);
  writeJsonAtomic(manifestPath, manifest, isolation.gitRoot);

  const baseResult = {
    task: { taskId: context.task.taskId, taskNo: context.task.taskNo, title: context.task.title },
    contextDigest: context.contextDigest,
    contextFile: relativePosix(isolation.gitRoot, contextPath),
    manifestFile: relativePosix(isolation.gitRoot, manifestPath),
    choices: decision.choices,
    downloads: [],
    selectionRestored: decision.restored,
    gitIsolation: publicGitIsolation(isolation),
  };
  if (decision.state === AttachmentPrepareState.NEEDS_ATTACHMENT_SELECTION) {
    return { ...baseResult, state: AttachmentPrepareState.NEEDS_ATTACHMENT_SELECTION };
  }

  writeJsonAtomic(selectionPath, decision.selectionReceipt, isolation.gitRoot);
  const priorReceiptsFile = readJson(receiptsPath);
  const priorReceipts = Array.isArray(priorReceiptsFile?.receipts) ? priorReceiptsFile.receipts : [];
  const receipts = [];
  const selectedById = new Map(context.attachments.map((item) => [item.attachmentId, item]));
  const selectedAttachments = decision.selectedIds.map((id) => selectedById.get(id));
  const metadataTotal = selectedAttachments.reduce((sum, item) => sum + (Number(item?.size) || 0), 0);
  if (metadataTotal > limits.maxTotalBytes) {
    const error = new ToolkitError("ATTACHMENT_TOTAL_TOO_LARGE", "选中附件元数据合计超过总大小上限");
    applyReceiptsToContext(context, decision.selectedIds, receipts, decision.selectedIds[0] || null, error.code);
    writeJsonAtomic(contextPath, context, isolation.gitRoot);
    return { ...baseResult, state: AttachmentPrepareState.BLOCKED, error: { code: error.code, message: error.message } };
  }

  let total = 0;
  for (const attachment of selectedAttachments) {
    const prior = priorReceipts.find((item) => item.attachmentId === attachment.attachmentId);
    const reused = reusableReceipt(prior, decision.manifestDigest, isolation.gitRoot);
    if (reused) {
      receipts.push(reused);
      total += reused.size;
      continue;
    }
    try {
      const receipt = await downloadOne({
        provider,
        attachment,
        isolation,
        manifestDigest: decision.manifestDigest,
        limits,
        totalSoFar: total,
      });
      receipts.push(receipt);
      total += receipt.size;
      writeJsonAtomic(receiptsPath, { schemaVersion: 1, manifestDigest: decision.manifestDigest, receipts }, isolation.gitRoot);
    } catch (error) {
      const normalized = error instanceof ToolkitError
        ? error
        : new ToolkitError("ATTACHMENT_DOWNLOAD_FAILED", error);
      const code = normalized.code === "TOOLKIT_ERROR" ? "ATTACHMENT_DOWNLOAD_FAILED" : normalized.code;
      const publicCode = ["ATTACHMENT_TOO_LARGE", "ATTACHMENT_TOTAL_TOO_LARGE", "LOCAL_FILE_CONFLICT"].includes(code)
        ? code
        : "ATTACHMENT_DOWNLOAD_FAILED";
      applyReceiptsToContext(context, decision.selectedIds, receipts, attachment.attachmentId, publicCode);
      writeJsonAtomic(contextPath, context, isolation.gitRoot);
      writeJsonAtomic(manifestPath, { ...manifest, attachments: context.attachments }, isolation.gitRoot);
      writeJsonAtomic(receiptsPath, { schemaVersion: 1, manifestDigest: decision.manifestDigest, receipts }, isolation.gitRoot);
      return {
        ...baseResult,
        state: AttachmentPrepareState.BLOCKED,
        downloads: receipts,
        error: { code: publicCode, message: redactErrorMessage(normalized.message) },
      };
    }
  }

  applyReceiptsToContext(context, decision.selectedIds, receipts);
  writeJsonAtomic(contextPath, context, isolation.gitRoot);
  writeJsonAtomic(manifestPath, { ...manifest, attachments: context.attachments }, isolation.gitRoot);
  writeJsonAtomic(receiptsPath, { schemaVersion: 1, manifestDigest: decision.manifestDigest, receipts }, isolation.gitRoot);
  return {
    ...baseResult,
    state: AttachmentPrepareState.READY,
    downloads: receipts,
    receiptFile: relativePosix(isolation.gitRoot, receiptsPath),
  };
}
