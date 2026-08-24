import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { ToolkitError, redactErrorMessage, redactSecrets } from "../../tb-domain/src/index.js";

export const OFFICIAL_MCP_PACKAGE = "@tng/teambition-openapi-mcp";
export const OFFICIAL_MCP_VERSION = "0.2.2";
export const OFFICIAL_READ_TOOL_NAMES = Object.freeze([
  "queryTaskV3",
  "listTaskActivitiesV3",
  "listFilesV3",
  "getFileDetailV3",
  "searchTaskflowsV3",
  "searchTaskflowStatusesV3",
]);
export const OFFICIAL_WRITE_TOOL_NAMES = Object.freeze(["createTaskCommentV3", "updateTaskStatusV3"]);
export const OFFICIAL_MCP_KNOWN_GAPS = Object.freeze([
  "read-rich-ta<REDACTED_API_KEY>",
  "cookie-fallback-for-openapi-permission-gaps",
  "read-attachment-bytes",
]);

const TOOLKIT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const requireFromToolkit = createRequire(path.join(TOOLKIT_ROOT, "package.json"));
const MAX_PAGES = 5;

function childEnvironment(env) {
  return Object.fromEntries(Object.entries(env || process.env).filter(([, value]) => typeof value === "string"));
}

export function resolveOfficialMcpRegistration(options = {}) {
  const packageFile = options.packageFile || requireFromToolkit.resolve(`${OFFICIAL_MCP_PACKAGE}/package.json`);
  const pkg = JSON.parse(fs.readFileSync(packageFile, "utf8"));
  const packageRoot = path.dirname(packageFile);
  const authMode = options.authMode === "user" ? "user" : "app";
  const defaults = options.profile === "write"
    ? [...OFFICIAL_READ_TOOL_NAMES, ...OFFICIAL_WRITE_TOOL_NAMES]
    : OFFICIAL_READ_TOOL_NAMES;
  const tools = [...new Set((options.tools || defaults).map((value) => String(value || "").trim()).filter(Boolean))];
  const entry = path.join(packageRoot, "dist", "cli.js");
  const args = [entry, authMode === "user" ? "user-mcp" : "mcp", "--tools", tools.join(",")];
  if (options.basePath) args.push("--base-path", String(options.basePath));
  const requestedTimeout = Number(options.toolTimeoutMs);
  return Object.freeze({
    packageName: pkg.name,
    packageVersion: pkg.version,
    command: path.resolve(options.nodePath || process.execPath),
    args,
    cwd: TOOLKIT_ROOT,
    authMode,
    envNames: authMode === "user" ? ["TB_MCP_USER_TOKEN"] : ["TB_MCP_APP_ID", "TB_MCP_APP_SECRET", "TB_MCP_ORG_ID"],
    tools,
    entry,
    toolTimeoutMs: Number.isFinite(requestedTimeout) && requestedTimeout > 0 ? requestedTimeout : 180_000,
  });
}

export function inspectOfficialMcpRuntime(options = {}) {
  const problems = [];
  let registration = null;
  try {
    registration = resolveOfficialMcpRegistration(options);
    if (registration.packageName !== OFFICIAL_MCP_PACKAGE) problems.push(`unexpected package: ${registration.packageName}`);
    if (registration.packageVersion !== OFFICIAL_MCP_VERSION) {
      problems.push(`official MCP version drift: expected ${OFFICIAL_MCP_VERSION}, got ${registration.packageVersion}`);
    }
    if (!fs.existsSync(registration.entry)) problems.push("official MCP CLI entry is missing");
  } catch (error) {
    problems.push(redactErrorMessage(error));
  }
  return { ok: problems.length === 0, registration, problems };
}

function parseToolPayload(result, toolName, { redact = true } = {}) {
  if (result?.isError) {
    const message = (result.content || []).filter((item) => item?.type === "text").map((item) => item.text).join("\n") || `${toolName} failed`;
    throw new ToolkitError("OFFICIAL_MCP_TOOL_FAILED", redactErrorMessage(message));
  }
  const text = (result?.content || []).find((item) => item?.type === "text")?.text;
  if (!text) throw new ToolkitError("OFFICIAL_MCP_RESULT_INVALID", `${toolName} returned no JSON text`);
  try {
    const parsed = JSON.parse(String(text).replace(/^API Response \(Status: \d+\):\s*/i, ""));
    return redact ? redactSecrets(parsed) : parsed;
  } catch {
    throw new ToolkitError("OFFICIAL_MCP_RESULT_INVALID", `${toolName} returned non-JSON content`);
  }
}

function unwrapPayload(payload) {
  let value = payload;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!value || typeof value !== "object" || Array.isArray(value)) break;
    if ("data" in value) value = value.data;
    else if ("result" in value) value = value.result;
    else break;
  }
  return value;
}

function payloadItems(payload) {
  const value = unwrapPayload(payload);
  if (Array.isArray(value)) return value;
  for (const key of ["items", "tasks", "results", "works", "activities", "taskflows", "taskflowstatuses"]) {
    if (Array.isArray(value?.[key])) return value[key];
  }
  return value && typeof value === "object" ? [value] : [];
}

function nextPageToken(payload) {
  const queue = [payload];
  for (let depth = 0; depth < 4 && queue.length; depth += 1) {
    const next = [];
    for (const value of queue) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const token = String(value.nextPageToken || value.pageTokenNext || "").trim();
      if (token) return token;
      for (const key of ["data", "result"]) if (value[key]) next.push(value[key]);
    }
    queue.splice(0, queue.length, ...next);
  }
  return "";
}

function taskQuery(taskRef) {
  if (taskRef && typeof taskRef === "object") {
    if (String(taskRef.taskId || "").trim()) return { taskId: String(taskRef.taskId).trim() };
    if (String(taskRef.taskNo || "").trim()) return taskQuery(taskRef.taskNo);
  }
  const value = String(taskRef || "").trim();
  if (!value) throw new ToolkitError("TASK_REF_REQUIRED", "taskRef is required");
  if (/^[a-f\d]{24}$/i.test(value)) return { taskId: value };
  const shortId = value.match(/(?:^|[-_])(\d+)$/)?.[1] || (/^\d+$/.test(value) ? value : "");
  if (!shortId) throw new ToolkitError("TASK_REF_UNSUPPORTED", "official queryTaskV3 requires a taskId or numeric task number");
  return { shortIds: shortId };
}

function resolvedTask(detail, fallbackRef) {
  const taskId = String(detail?.taskId || detail?._id || detail?.id || "").trim();
  if (!taskId) throw new ToolkitError("OFFICIAL_MCP_RESULT_INVALID", "queryTaskV3 result has no task ID");
  const numeric = detail?.uniqueId ?? detail?.shortId ?? String(fallbackRef || "").match(/(\d+)$/)?.[1];
  return {
    taskId,
    taskNo: numeric == null || String(numeric).trim() === "" ? String(fallbackRef || "") : `CARB-${numeric}`,
    title: String(detail?.content || detail?.title || ""),
  };
}

function attachmentId(value) {
  return String(value?.attachmentId || value?.workId || value?._id || value?.id || "").trim();
}

function attachmentName(value) {
  const base = String(value?.fileName || value?.name || value?.title || "attachment").trim();
  const ext = String(value?.ext || "").replace(/^\./, "");
  return ext && !base.toLowerCase().endsWith(`.${ext.toLowerCase()}`) ? `${base}.${ext}` : base;
}

function attachmentUrl(value) {
  return String(value?.downloadUrl || value?.url || value?.signedUrl || value?.downloadURL || "").trim();
}

function normalizeAttachment(value, source, sourceRef = null, inheritedAt = "") {
  return {
    attachmentId: attachmentId(value),
    source,
    sourceRef,
    originalName: attachmentName(value),
    size: Number(value?.fileSize ?? value?.size ?? 0) || 0,
    mimeType: String(value?.mimeType || value?.contentType || ""),
    uploader: value?.creator || value?.uploader || null,
    createdAt: value?.createdAt || value?.created || inheritedAt || null,
  };
}

function commentFiles(activity) {
  let content = activity?.content;
  if (typeof content === "string") {
    try { content = JSON.parse(content); } catch { content = {}; }
  }
  return Array.isArray(content?.files) ? content.files : [];
}

function uniqueById(items) {
  const output = [];
  const positions = new Map();
  for (const item of items.filter(Boolean)) {
    const id = attachmentId(item);
    if (!id) continue;
    if (!positions.has(id)) {
      positions.set(id, output.length);
      output.push(item);
    } else {
      const index = positions.get(id);
      output[index] = { ...output[index], ...Object.fromEntries(Object.entries(item).filter(([, value]) => value != null && value !== "")) };
    }
  }
  return output;
}

async function collectPages(session, toolName, baseArguments, { maxPages = MAX_PAGES } = {}) {
  const items = [];
  const seen = new Set();
  let token = "";
  for (let page = 0; page < maxPages; page += 1) {
    const result = await session.callTool({ name: toolName, arguments: { ...baseArguments, ...(token ? { pageToken: token } : {}) } });
    const payload = parseToolPayload(result, toolName, { redact: false });
    items.push(...payloadItems(payload));
    const next = nextPageToken(payload);
    if (!next) return { items, complete: true, error: "" };
    if (seen.has(next)) return { items, complete: false, error: `${toolName} returned a repeated page token` };
    seen.add(next);
    token = next;
  }
  return { items, complete: false, error: `${toolName} exceeded ${maxPages} pages` };
}

function taskProjectId(detail) {
  return String(detail?.projectId || detail?._projectId || detail?.project?._id || detail?.project?.id || "").trim();
}

function taskflowId(detail) {
  return String(detail?.taskflowId || detail?._taskflowId || detail?.taskflowstatus?._taskflowId || detail?.taskflowstatus?.taskflowId || "").trim();
}

function statusId(value) {
  return String(value?.statusId || value?.taskflowstatusId || value?._id || value?.id || "").trim();
}

function statusName(value) {
  return String(value?.name || value?.title || value?.displayName || value?.tfsName || "").trim();
}

function sameName(left, right) {
  const normalize = (value) => String(value || "").normalize("NFKC").trim().toLowerCase().replace(/\s+/g, "");
  return normalize(left) === normalize(right);
}

export function createOfficialTeambitionGateway(session, options = {}) {
  if (!session || typeof session.callTool !== "function") {
    throw new ToolkitError("OFFICIAL_MCP_CONFIG_INVALID", "an official MCP callTool session is required");
  }
  const sources = new Map();
  const operatorId = String(options.operatorId || "").trim();

  async function queryTask(taskRef) {
    const result = await session.callTool({ name: "queryTaskV3", arguments: taskQuery(taskRef) });
    const candidates = payloadItems(parseToolPayload(result, "queryTaskV3", { redact: false }));
    if (candidates.length === 0) throw new ToolkitError("TASK_REF_NOT_FOUND", `task not found: ${taskRef}`);
    if (candidates.length !== 1) throw new ToolkitError("TASK_REF_AMBIGUOUS", `task reference matched ${candidates.length} tasks`);
    return { detail: candidates[0], resolved: resolvedTask(candidates[0], taskRef) };
  }

  async function readTicket(taskRef) {
    const { detail, resolved } = await queryTask(taskRef);
    const projectId = taskProjectId(detail);
    let commentsResult;
    try {
      commentsResult = await collectPages(session, "listTaskActivitiesV3", { taskId: resolved.taskId, pageSize: 100, actions: "comment", orderBy: "created" });
    } catch (error) {
      commentsResult = { items: [], complete: false, error: redactErrorMessage(error) };
    }
    let directFiles = { items: [], complete: false, error: projectId ? "official files were not read" : "task projectId is unavailable" };
    if (projectId) {
      try {
        directFiles = await collectPages(session, "listFilesV3", { parentId: resolved.taskId, projectId, pageSize: 100 });
      } catch (error) {
        directFiles = { items: [], complete: false, error: redactErrorMessage(error) };
      }
    }
    const commentRows = [];
    for (const activity of commentsResult.items) {
      for (const file of commentFiles(activity)) {
        commentRows.push({ ...file, _sourceRef: String(activity?._id || activity?.id || ""), _inheritedAt: activity?.createdAt || activity?.created || "" });
      }
    }
    const raw = uniqueById([...directFiles.items, ...commentRows]);
    const missingDetailIds = raw.filter((item) => !attachmentUrl(item)).map(attachmentId).filter(Boolean);
    for (let offset = 0; offset < missingDetailIds.length; offset += 100) {
      const ids = missingDetailIds.slice(offset, offset + 100);
      try {
        const result = await session.callTool({ name: "getFileDetailV3", arguments: { workIds: ids.join(","), needSign: true } });
        raw.push(...payloadItems(parseToolPayload(result, "getFileDetailV3", { redact: false })));
      } catch (error) {
        directFiles.complete = false;
        directFiles.error = [directFiles.error, redactErrorMessage(error)].filter(Boolean).join("; ");
      }
    }
    const merged = uniqueById(raw);
    const attachments = merged.map((item) => {
      const normalized = normalizeAttachment(item, item._sourceRef ? "comment" : "task", item._sourceRef || null, item._inheritedAt || "");
      const url = attachmentUrl(item);
      if (url) sources.set(normalized.attachmentId, { url, size: normalized.size, mimeType: normalized.mimeType, taskRef: resolved.taskNo });
      return normalized;
    });
    const unavailable = attachments.filter((item) => !sources.has(item.attachmentId));
    const attachmentsComplete = directFiles.complete && commentsResult.complete && unavailable.length === 0;
    return {
      resolved,
      detail: redactSecrets(detail),
      comments: {
        available: commentsResult.complete || commentsResult.items.length > 0,
        complete: commentsResult.complete,
        source: "official-mcp",
        items: redactSecrets(commentsResult.items),
        error: commentsResult.complete ? "" : commentsResult.error,
      },
      attachments: {
        available: directFiles.complete || commentsResult.complete || attachments.length > 0,
        complete: attachmentsComplete,
        source: "official-mcp",
        items: redactSecrets(attachments),
        error: attachmentsComplete ? "" : [directFiles.error, commentsResult.error, unavailable.length ? `${unavailable.length} attachment download source(s) unavailable` : ""].filter(Boolean).join("; "),
      },
      note: { ok: false, error: "official MCP 0.2.2 does not expose complete rich-note and remark-image reads" },
    };
  }

  async function getWorkflow(taskRef) {
    const { detail, resolved } = await queryTask(taskRef);
    const projectId = taskProjectId(detail);
    const currentTaskflowId = taskflowId(detail);
    if (!projectId) throw new ToolkitError("WORKFLOW_PROJECT_UNAVAILABLE", "task projectId is unavailable");
    const flows = await collectPages(session, "searchTaskflowsV3", { projectId, pageSize: 100 });
    const statuses = await collectPages(session, "searchTaskflowStatusesV3", { projectId, pageSize: 100, ...(currentTaskflowId ? { tfIds: currentTaskflowId } : {}) });
    const filtered = currentTaskflowId
      ? statuses.items.filter((item) => String(item?.taskflowId || item?._taskflowId || item?.tfId || "") === currentTaskflowId)
      : statuses.items;
    const triageMatches = filtered.filter((item) => sameName(statusName(item), "AI甄别"));
    if (triageMatches.length !== 1) {
      throw new ToolkitError("TRIAGE_STATUS_NOT_FOUND", triageMatches.length ? "multiple AI甄别 statuses matched the current workflow" : "AI甄别 status was not found in the current workflow");
    }
    const current = detail.taskflowstatus || { _id: detail.taskflowstatusId || detail._taskflowstatusId, name: detail.taskflowstatusName || detail.statusName };
    return redactSecrets({
      task: resolved,
      projectId,
      taskflowId: currentTaskflowId || null,
      workflowVersion: String(detail.updatedAt || detail.updated || ""),
      taskflows: flows.items,
      statuses: filtered.map((item) => ({
        statusId: statusId(item), displayName: statusName(item),
        taskflowId: String(item?.taskflowId || item?._taskflowId || item?.tfId || "") || null,
        position: item?.pos ?? item?.position ?? null,
      })),
      transitions: [],
      transitionEvidence: "official MCP exposes same-workflow statuses; the upstream API remains the authority for transition legality",
      currentStatus: { statusId: statusId(current), displayName: statusName(current) },
      triageStatus: {
        displayName: statusName(triageMatches[0]), statusId: statusId(triageMatches[0]),
        resolutionSource: "official-mcp:searchTaskflowStatusesV3:exact-current-workflow-match",
      },
      complete: flows.complete && statuses.complete,
      warnings: [flows.error, statuses.error].filter(Boolean),
    });
  }

  return Object.freeze({
    kind: "official-teambition-mcp",
    officialPackage: `${OFFICIAL_MCP_PACKAGE}@${OFFICIAL_MCP_VERSION}`,
    knownGaps: [...OFFICIAL_MCP_KNOWN_GAPS],
    readTicket,
    getWorkflow,
    getAttachmentSource(id) { const source = sources.get(String(id || "")); return source ? { ...source } : null; },
    async openAttachment(id) {
      const source = sources.get(String(id || ""));
      if (!source) throw new ToolkitError("ATTACHMENT_NOT_FOUND", "attachment source is unavailable; refresh ticket context");
      if (typeof options.attachmentReader !== "function") throw new ToolkitError("OFFICIAL_MCP_CAPABILITY_GAP", "official MCP returns metadata but does not stream attachment bytes");
      return options.attachmentReader(source);
    },
    async listComments(taskRef) {
      const snapshot = await readTicket(taskRef);
      if (!snapshot.comments.complete) throw new ToolkitError("CONTEXT_INCOMPLETE", snapshot.comments.error);
      return snapshot.comments.items;
    },
    async writeComment(taskId, comment) {
      if (!operatorId) throw new ToolkitError("AUTH_REQUIRED", "TB_MCP_OPERATOR_ID is required for official write tools");
      return parseToolPayload(await session.callTool({
        name: "createTaskCommentV3",
        arguments: { "x-operator-id": operatorId, taskId, requestBody: { content: String(comment || ""), renderMode: "markdown" } },
      }), "createTaskCommentV3");
    },
    async updateStatus(taskId, targetStatus) {
      if (!operatorId) throw new ToolkitError("AUTH_REQUIRED", "TB_MCP_OPERATOR_ID is required for official write tools");
      const id = String(targetStatus?.statusId || targetStatus?.id || "").trim();
      const name = String(targetStatus?.displayName || targetStatus?.name || "").trim();
      if (!id && !name) throw new ToolkitError("INVALID_TRANSITION", "target status is missing");
      return parseToolPayload(await session.callTool({
        name: "updateTaskStatusV3",
        arguments: { "x-operator-id": operatorId, taskId, requestBody: { ...(id ? { taskflowstatusId: id } : {}), ...(name ? { tfsName: name } : {}) } },
      }), "updateTaskStatusV3");
    },
  });
}

export async function connectOfficialTeambitionMcp(options = {}) {
  const inspected = inspectOfficialMcpRuntime(options);
  if (!inspected.ok) throw new ToolkitError("OFFICIAL_MCP_NOT_READY", inspected.problems.join("; "));
  const registration = inspected.registration;
  const env = childEnvironment(options.env || process.env);
  const missing = registration.envNames.filter((name) => name !== "TB_MCP_ORG_ID" && !env[name]);
  if (missing.length) throw new ToolkitError("OFFICIAL_MCP_AUTH_REQUIRED", `missing environment variables: ${missing.join(", ")}`);
  const transport = new StdioClientTransport({ command: registration.command, args: registration.args, cwd: registration.cwd, env, stderr: "pipe" });
  transport.stderr?.resume();
  const client = new Client({ name: "aiefficiency-tb-ticket-toolkit", version: "0.6.0" });
  try {
    await client.connect(transport);
  } catch (error) {
    try { await transport.close(); } catch {}
    throw new ToolkitError("OFFICIAL_MCP_CONNECT_FAILED", redactErrorMessage(error));
  }
  return {
    registration,
    callTool: (request) => client.callTool(request, undefined, { timeout: registration.toolTimeoutMs, maxTotalTimeout: registration.toolTimeoutMs }),
    listTools: () => client.listTools(),
    async close() {
      try { await client.close(); } finally { try { await transport.close(); } catch {} }
    },
  };
}
