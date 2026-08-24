import { createHash } from "node:crypto";

const DEFAULT_SOURCES = ["detail", "note", "comments", "attachments", "tags"];
const SECRET_ASSIGNMENT = /["']?\b(api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret|private[-_ ]?key|password|passwd|pwd|authorization)\b["']?\s*[:=]\s*(?:(["'])([^\r\n]*?)\2|([^\s"'&,;}{]+))/gi;
const BEARER_TOKEN = /\bbearer\s+[a-z0-9._~+/=-]{8,}/gi;
const WINDOWS_PATH = /(?<![a-z0-9])(?:[a-z]:[\\/]|\\\\[^\\/\s]+[\\/])(?:[^\\/:*?"<>|\r\n\s;,=]+[\\/])*[^\\/:*?"<>|\r\n\s;,=]+/gi;
const USER_HOME_PATH = /(?<![a-z0-9:/])\/(?:home\/[^/\s]+|users\/[^/\s]+|root)(?:\/[^\s;,<>"']+)*/gi;
const POSIX_MACHINE_PATH = /(?<![a-z0-9:/])\/(?:opt|workspace|srv|tmp)(?:\/[^\s;,<>"']+)*/gi;
const EMAIL = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi;
const MOBILE = /(?<!\d)1[3-9]\d{9}(?!\d)/g;
const ADB_SERIAL_ASSIGNMENT = /\b(?:adb[-_ ]?serial|device[-_ ]?serial|serialno)\b\s*[:=]\s*[^\s,;]+/gi;
const VAULT_REFERENCE = /^vault:\/\/[a-z0-9._~/-]+$/i;

function secretAssignmentValue(quotedValue, unquotedValue) {
  return String(quotedValue ?? unquotedValue ?? "").trim();
}

function redactSecretAssignments(source) {
  SECRET_ASSIGNMENT.lastIndex = 0;
  return source.replace(
    SECRET_ASSIGNMENT,
    (match, key, _quote, quotedValue, unquotedValue) => (
      VAULT_REFERENCE.test(secretAssignmentValue(quotedValue, unquotedValue))
        ? match
        : `${key}=[REDACTED_SECRET]`
    ),
  );
}

function hasUnsafeSecretAssignment(source) {
  SECRET_ASSIGNMENT.lastIndex = 0;
  let match = SECRET_ASSIGNMENT.exec(source);
  while (match) {
    if (!VAULT_REFERENCE.test(secretAssignmentValue(match[3], match[4]))) {
      SECRET_ASSIGNMENT.lastIndex = 0;
      return true;
    }
    match = SECRET_ASSIGNMENT.exec(source);
  }
  SECRET_ASSIGNMENT.lastIndex = 0;
  return false;
}

function text(value, limit = 20_000) {
  return String(value ?? "").trim().slice(0, limit);
}

function iso(value, fallback = "") {
  const parsed = new Date(value || fallback);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : "";
}

function hash(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

/**
 * Sanitize text before it crosses the node boundary. Vault references are identifiers rather
 * than secret values and remain usable; raw credentials, PII and machine paths never do.
 */
export function sanitizeSharedTrainingText(value, limit = 20_000) {
  const source = text(value, limit);
  if (!source || VAULT_REFERENCE.test(source)) return source;
  return redactSecretAssignments(source)
    .replace(BEARER_TOKEN, "Bearer [REDACTED_SECRET]")
    .replace(ADB_SERIAL_ASSIGNMENT, "device-serial=[REDACTED_DEVICE]")
    .replace(WINDOWS_PATH, "[REDACTED_MACHINE_PATH]")
    .replace(USER_HOME_PATH, "[REDACTED_MACHINE_PATH]")
    .replace(POSIX_MACHINE_PATH, "[REDACTED_MACHINE_PATH]")
    .replace(EMAIL, "[REDACTED_EMAIL]")
    .replace(MOBILE, "[REDACTED_PHONE]");
}

function coverageRow(row) {
  if (!row || typeof row !== "object") {
    return {
      available: false,
      complete: false,
      error: "source coverage 未提供",
      count: 0,
      untrusted: false,
    };
  }
  const available = row?.available !== false;
  const complete = available && row?.complete !== false && !row?.error;
  return {
    available,
    complete,
    error: sanitizeSharedTrainingText(row?.error, 500),
    count: Math.max(0, Number(row?.count ?? row?.parsedCount ?? 0) || 0),
    untrusted: row?.untrusted === true,
    ...(iso(row?.capturedAt || row?.availableAt) ? {
      capturedAt: iso(row?.capturedAt || row?.availableAt),
    } : {}),
  };
}

export function normalizeSourceCoverage(input = {}, sources = DEFAULT_SOURCES) {
  return Object.fromEntries(sources.map((name) => [name, coverageRow(input?.[name])]));
}

function cloneCoverage(input = {}) {
  return Object.fromEntries(Object.entries(input || {}).map(([key, value]) => [
    key,
    value && typeof value === "object" ? { ...value } : value,
  ]));
}

export function evaluateSourceCoverage(sourceCoverage = {}, {
  required = ["detail"],
  optional = ["note", "comments", "attachments", "tags"],
} = {}) {
  const coverage = normalizeSourceCoverage(
    sourceCoverage,
    [...new Set([...required, ...optional, ...Object.keys(sourceCoverage || {})])],
  );
  const missingRequired = required.filter((name) => !coverage[name]?.available || !coverage[name]?.complete);
  const incompleteOptional = optional.filter((name) => !coverage[name]?.available || !coverage[name]?.complete);
  const optionalPenalty = optional.length > 0 ? incompleteOptional.length / optional.length : 0;
  return {
    status: missingRequired.length > 0 ? "NEED_MORE_INFO" : "READY",
    passed: missingRequired.length === 0,
    missingRequired,
    incompleteOptional,
    completeness: Math.max(0, Math.min(1, 1 - optionalPenalty * 0.25)),
    sourceCoverage: coverage,
  };
}

function availableAt(row = {}, fallback = "") {
  return iso(
    row?.availableAt
    || row?.createdAt
    || row?.updatedAt
    || row?.timestamp
    || fallback,
  );
}

function beforeCutoff(row, cutoff, fallback) {
  const timestamp = availableAt(row, fallback);
  return !!timestamp && timestamp <= cutoff;
}

function normalizeComment(row, index, fallback) {
  if (typeof row === "string") {
    return {
      id: `comment_${index + 1}`,
      availableAt: iso(fallback),
      text: sanitizeSharedTrainingText(row, 4000),
    };
  }
  return {
    id: sanitizeSharedTrainingText(row?.id || row?._id, 200) || `comment_${index + 1}`,
    availableAt: availableAt(row, fallback),
    text: sanitizeSharedTrainingText(
      row?.text || row?.content || row?.body || row?.description,
      4000,
    ),
  };
}

function normalizeAttachment(row, index, fallback) {
  const summary = row?.summary || row?.textSummary || (
    row?.status === "parsed" ? text(row?.text, 1000) : ""
  );
  return {
    id: sanitizeSharedTrainingText(row?.id || row?._id, 200) || `attachment_${index + 1}`,
    name: sanitizeSharedTrainingText(row?.name || row?.fileName, 300),
    availableAt: availableAt(row, fallback),
    status: text(row?.status, 80),
    parser: text(row?.parser, 80),
    contentHash: text(row?.contentHash, 100),
    textSummary: sanitizeSharedTrainingText(summary, 1000),
    untrusted: true,
  };
}

function compact(rows) {
  return rows.filter((row) => (
    Object.values(row).some((value) => value !== "" && value !== false && value !== undefined)
  ));
}

/**
 * Create a deterministic, immutable inference-time snapshot.
 *
 * Later comments/attachments are excluded to prevent label leakage. Raw attachment bodies and
 * download URLs are intentionally not persisted; only a bounded, sanitized summary and hash cross
 * the shared boundary.
 */
export function createInferenceSourceSnapshot(ticket = {}, {
  inferenceAt = new Date().toISOString(),
  requiredSources = ["detail"],
  optionalSources = ["note", "comments", "attachments", "tags"],
  ttlDays = 90,
  schemaVersion = "source-snapshot/v1",
} = {}) {
  const cutoff = iso(inferenceAt);
  if (!cutoff) throw new Error("inferenceAt 必须是合法时间");

  const coverageInput = cloneCoverage(ticket?.sourceCoverage);
  const sourceCapturedAt = (source) => iso(
    ticket?.sourceCoverage?.[source]?.capturedAt
    || ticket?.sourceCoverage?.[source]?.availableAt,
  );
  const captureState = {};
  for (const source of ["manual", "detail", "note", "tags"]) {
    const row = coverageInput[source];
    if (!row || typeof row !== "object" || row.available === false) {
      captureState[source] = { usable: false, missing: false, future: false };
      continue;
    }
    const capturedAt = sourceCapturedAt(source);
    const missing = !capturedAt;
    const future = !!capturedAt && capturedAt > cutoff;
    captureState[source] = { usable: !missing && !future, missing, future, capturedAt };
    if (missing || future) {
      coverageInput[source] = {
        ...row,
        available: row.available !== false,
        complete: false,
        error: missing
          ? `${source} capturedAt 缺失`
          : `${source} capturedAt 晚于 inferenceAt`,
      };
    }
  }
  const rawComments = Array.isArray(ticket?.comments) ? ticket.comments : [];
  const commentsCapture = sourceCapturedAt("comments") || iso(ticket?.snapshotAt);
  const commentsMissingTime = rawComments.filter((row) => !availableAt(row, commentsCapture)).length;
  const commentsAtCutoff = rawComments.filter((row) => beforeCutoff(row, cutoff, commentsCapture));
  const rawAttachments = Array.isArray(ticket?.attachments) ? ticket.attachments : [];
  const attachmentsCapture = sourceCapturedAt("attachments") || iso(ticket?.snapshotAt);
  const attachmentsMissingTime = rawAttachments.filter((row) => !availableAt(row, attachmentsCapture)).length;
  const attachmentsAtCutoff = rawAttachments.filter((row) => beforeCutoff(row, cutoff, attachmentsCapture));
  if (commentsMissingTime > 0) {
    coverageInput.comments = {
      ...(coverageInput.comments || {}),
      available: coverageInput.comments?.available !== false,
      complete: false,
      error: "评论 evidence.availableAt/capturedAt 缺失",
    };
  }
  if (attachmentsMissingTime > 0) {
    coverageInput.attachments = {
      ...(coverageInput.attachments || {}),
      available: coverageInput.attachments?.available !== false,
      complete: false,
      error: "附件 evidence.availableAt/capturedAt 缺失",
      untrusted: true,
    };
  }
  const gate = evaluateSourceCoverage(coverageInput, {
    required: requiredSources,
    optional: optionalSources,
  });
  const createdAt = iso(ticket?.createdAt);
  const ttl = Math.max(1, Math.trunc(Number(ttlDays) || 90));
  const expiresAt = new Date(new Date(cutoff).getTime() + ttl * 86_400_000).toISOString();
  const manualUsable = captureState.manual?.usable === true;
  const detailUsable = captureState.detail?.usable === true;
  const detailWasCaptured = coverageInput.detail?.available !== false
    && coverageInput.detail !== undefined;
  const noteWasCaptured = coverageInput.note?.available !== false
    && coverageInput.note !== undefined;
  const noteUsable = captureState.note?.usable === true;
  const tagsWereCaptured = coverageInput.tags?.available !== false
    && coverageInput.tags !== undefined;
  const tagsUsable = captureState.tags?.usable === true;

  const body = {
    schemaVersion: text(schemaVersion, 100),
    inferenceAt: cutoff,
    expiresAt,
    ticket: {
      id: sanitizeSharedTrainingText(ticket?.id || ticket?._id || ticket?.ticketId, 200),
      projectId: sanitizeSharedTrainingText(ticket?.projectId || ticket?.organizationProjectId, 200),
      createdAt,
      title: manualUsable || detailUsable
        ? sanitizeSharedTrainingText(ticket?.title || ticket?.name, 2000)
        : "",
      // 旧入口把 note 拼入 description；note 声明可用但时点不可信时，保守丢弃整个
      // description。detail/note 任一声明可用但时点不可信时也整体丢弃，避免通过
      // 兼容合并字段绕过 inferenceAt 门禁；纯手工输入则由 manual capturedAt 放行。
      description: (manualUsable || detailUsable)
        && (!detailWasCaptured || detailUsable)
        && (!noteWasCaptured || noteUsable)
        ? sanitizeSharedTrainingText(ticket?.description, 12_000)
        : "",
      note: noteUsable ? sanitizeSharedTrainingText(ticket?.note, 6000) : "",
      tags: (manualUsable || tagsUsable) && (!tagsWereCaptured || tagsUsable)
        ? [...new Set((Array.isArray(ticket?.tags) ? ticket.tags : [])
        .map((item) => sanitizeSharedTrainingText(item?.name || item, 200))
        .filter(Boolean))]
        : [],
      comments: compact(commentsAtCutoff.map((row, index) => normalizeComment(row, index, commentsCapture))),
      attachments: compact(
        attachmentsAtCutoff.map((row, index) => normalizeAttachment(row, index, attachmentsCapture)),
      ),
    },
    sourceCoverage: gate.sourceCoverage,
    sourceGate: {
      status: gate.status,
      passed: gate.passed,
      missingRequired: gate.missingRequired,
      incompleteOptional: gate.incompleteOptional,
      completeness: gate.completeness,
    },
    excludedFutureEvidence: {
      comments: rawComments.length - commentsAtCutoff.length - commentsMissingTime,
      attachments: rawAttachments.length - attachmentsAtCutoff.length - attachmentsMissingTime,
      ...Object.fromEntries(["detail", "note", "tags"]
        .filter((source) => captureState[source]?.future)
        .map((source) => [source, 1])),
    },
    excludedMissingTimeEvidence: {
      comments: commentsMissingTime,
      attachments: attachmentsMissingTime,
      ...Object.fromEntries(["detail", "note", "tags"]
        .filter((source) => captureState[source]?.missing)
        .map((source) => [source, 1])),
    },
  };
  const snapshot = {
    ...body,
    snapshotId: `src_${hash(JSON.stringify(stable(body))).slice(0, 24)}`,
  };
  return deepFreeze(snapshot);
}

export function scanSharedSnapshotViolations(value) {
  const findings = [];
  const rules = [
    ["windows_path", WINDOWS_PATH],
    ["user_home_path", USER_HOME_PATH],
    ["posix_machine_path", POSIX_MACHINE_PATH],
    ["bearer_token", BEARER_TOKEN],
    ["email", EMAIL],
    ["phone", MOBILE],
  ];
  const strings = [];
  const stack = [{ value, attachment: false }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (typeof current?.value === "string") {
      strings.push(current.value);
      continue;
    }
    if (!current?.value || typeof current.value !== "object") continue;
    if (Array.isArray(current.value)) {
      current.value.forEach((item) => stack.push({ value: item, attachment: current.attachment }));
      continue;
    }
    for (const [key, child] of Object.entries(current.value)) {
      const attachment = current.attachment || key === "attachments";
      if (
        typeof child === "string"
        && /^(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|private[_ -]?key|password|passwd|pwd|authorization)$/i.test(key)
        && child
        && !VAULT_REFERENCE.test(child)
      ) {
        findings.push("secret_assignment");
      }
      if (
        current.attachment
        && ["text", "content", "ocrText", "rawBody", "downloadUrl", "url"].includes(key)
      ) {
        findings.push("attachment_body");
      }
      if (child && typeof child === "object") stack.push({ value: child, attachment });
      else if (typeof child === "string") strings.push(child);
    }
  }
  for (const [type, pattern] of rules) {
    if (strings.some((valueText) => {
      const scanText = String(valueText).replace(/\[REDACTED_(?:SECRET|DEVICE|MACHINE_PATH|EMAIL|PHONE)\]/g, "");
      pattern.lastIndex = 0;
      return pattern.test(scanText);
    })) findings.push(type);
  }
  if (strings.some((valueText) => {
    const scanText = String(valueText)
      .replace(/\[REDACTED_SECRET\]/g, "vault://redacted/secret")
      .replace(/\[REDACTED_(?:DEVICE|MACHINE_PATH|EMAIL|PHONE)\]/g, "");
    return hasUnsafeSecretAssignment(scanText);
  })) findings.push("secret_assignment");
  return {
    portable: findings.length === 0,
    findings: [...new Set(findings)],
  };
}
