import { createHash } from "node:crypto";
import {
  defaultFeishuProjectWebConfig,
  dedupeWorkItems,
  extractFeishuWorkItemsFromJson,
} from "./feishu-web-session.js";

export const DEFAULT_FEISHU_MCP_SERVER_URL = "https://project.feishu.cn/mcp_server/v1";
export const DEFAULT_FEISHU_MCP_HEADER_NAME = "X-Mcp-Token";

const DEFAULT_PROTOCOL_VERSION = "2025-03-26";
const CLIENT_INFO = { name: "AIEfficiency Feishu Project Sync", version: "1.0.0" };
const FIELD_CONFIG_CACHE_TTL_MS = 10 * 60 * 1000;
const MCP_STATUS_CACHE_TTL_MS = 30 * 1000;
const MCP_STATUS_ERROR_CACHE_TTL_MS = 5 * 1000;
const MCP_USER_LABEL_CACHE_TTL_MS = 15 * 60 * 1000;
const MCP_USER_LABEL_ERROR_CACHE_TTL_MS = 60 * 1000;
const MCP_USER_LABEL_TEAM_LOOKUP_CONCURRENCY = 8;
const DEFAULT_MCP_WORK_ITEM_FIELDS = [
  "work_item_id",
  "name",
  "auto_number",
  "work_item_status",
  "priority",
  "updated_at",
  "start_time",
  "description",
];
const DEFECT_DESCRIPTION_FIELD_KEYS = ["field_ee70e6"];
const VEHICLE_DEFECT_RELATION_FIELD_KEYS = new Set(["field0a156d"]);
const fieldConfigCache = new Map();
const mcpUserLabelCache = new Map();
let mcpStatusCache = {
  key: "",
  value: null,
  expiresAt: 0,
  inFlight: null,
};

export function defaultFeishuProjectMcpConfig() {
  return {
    enabled: false,
    transport: "http-oauth",
    serverUrl: DEFAULT_FEISHU_MCP_SERVER_URL,
    headerName: DEFAULT_FEISHU_MCP_HEADER_NAME,
    token: "",
    toolName: "",
    workItemTypeName: "",
    assigneeFieldKey: "current_status_operator",
    timeoutMs: 30000,
    retryAttempts: 3,
    retryBaseDelayMs: 500,
    retryMaxDelayMs: 3000,
  };
}

function mcpStatusCacheKey(cfg = {}) {
  return createHash("sha256").update(JSON.stringify({
    enabled: !!cfg.enabled,
    transport: cfg.transport,
    serverUrl: cfg.serverUrl,
    headerName: cfg.headerName,
    token: cfg.token,
    timeoutMs: cfg.timeoutMs,
  })).digest("hex");
}

export function clearFeishuProjectMcpStatusCache() {
  mcpStatusCache = {
    key: "",
    value: null,
    expiresAt: 0,
    inFlight: null,
  };
  mcpUserLabelCache.clear();
}

function mcpSecretVariants(syncConfig = {}) {
  const token = normalizeMcpConfig(syncConfig).token;
  if (!token) return [];
  const variants = new Set([token, encodeURIComponent(token)]);
  if (token.length >= 8) {
    variants.add(Buffer.from(token, "utf8").toString("base64"));
    variants.add(Buffer.from(token, "utf8").toString("base64url"));
  }
  return [...variants].filter(Boolean).sort((left, right) => right.length - left.length);
}

function redactMcpString(value, secretVariants) {
  let output = String(value ?? "");
  for (const secret of secretVariants) {
    output = output.split(secret).join("[REDACTED]");
  }
  return output;
}

function sanitizeMcpValue(value, secretVariants, seen = new WeakSet()) {
  if (typeof value === "string") return redactMcpString(value, secretVariants);
  if (value == null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    const output = value.map((item) => sanitizeMcpValue(item, secretVariants, seen));
    seen.delete(value);
    return output;
  }
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    const safeKey = redactMcpString(key, secretVariants);
    if (safeKey === "__proto__" || safeKey === "prototype" || safeKey === "constructor") continue;
    output[safeKey] = sanitizeMcpValue(item, secretVariants, seen);
  }
  seen.delete(value);
  return output;
}

export function sanitizeFeishuProjectMcpPayload(payload = {}, syncConfig = {}) {
  return sanitizeMcpValue(payload, mcpSecretVariants(syncConfig));
}

export function sanitizeFeishuProjectMcpStatus(status = {}, syncConfig = {}) {
  return sanitizeFeishuProjectMcpPayload(status, syncConfig);
}

export function sanitizeFeishuProjectMcpError(error, syncConfig = {}) {
  const secretVariants = mcpSecretVariants(syncConfig);
  if (!error || typeof error !== "object") {
    return new Error(redactMcpString(error || "MCP request failed", secretVariants));
  }
  for (const key of Object.keys(error)) {
    try {
      error[key] = sanitizeMcpValue(error[key], secretVariants);
    } catch {
      // Keep the original error shape when a runtime exposes a read-only property.
    }
  }
  if (typeof error.message === "string") error.message = redactMcpString(error.message, secretVariants);
  if (typeof error.stack === "string") error.stack = redactMcpString(error.stack, secretVariants);
  return error;
}

export async function getFeishuProjectMcpStatus(syncConfig = {}, { forceRefresh = false } = {}) {
  const cfg = normalizeMcpConfig(syncConfig);
  const cacheKey = mcpStatusCacheKey(cfg);
  const now = Date.now();
  if (!forceRefresh && mcpStatusCache.key === cacheKey && mcpStatusCache.value && mcpStatusCache.expiresAt > now) {
    return mcpStatusCache.value;
  }
  if (mcpStatusCache.key === cacheKey && mcpStatusCache.inFlight) return mcpStatusCache.inFlight;

  const inFlight = probeFeishuProjectMcpStatus(cfg).then((value) => {
    if (mcpStatusCache.key === cacheKey) {
      mcpStatusCache.value = value;
      mcpStatusCache.expiresAt = Date.now() + (value.connected ? MCP_STATUS_CACHE_TTL_MS : MCP_STATUS_ERROR_CACHE_TTL_MS);
    }
    return value;
  }).finally(() => {
    if (mcpStatusCache.key === cacheKey) mcpStatusCache.inFlight = null;
  });
  mcpStatusCache = {
    key: cacheKey,
    value: forceRefresh ? null : (mcpStatusCache.key === cacheKey ? mcpStatusCache.value : null),
    expiresAt: forceRefresh ? 0 : (mcpStatusCache.key === cacheKey ? mcpStatusCache.expiresAt : 0),
    inFlight,
  };
  return inFlight;
}

async function probeFeishuProjectMcpStatus(cfg) {
  const base = {
    configured: !!cfg.serverUrl,
    enabled: !!cfg.enabled,
    transport: cfg.transport,
    serverUrl: cfg.serverUrl,
    headerName: cfg.headerName,
    hasHeaderToken: !!cfg.token,
    connected: false,
    initialized: false,
    needsAuthorization: false,
    authorizationUrl: "",
    toolCount: 0,
    tools: [],
  };
  if (!cfg.serverUrl) return sanitizeFeishuProjectMcpStatus({ ...base, error: "MCP serverUrl is empty" }, cfg);

  const client = new FeishuProjectMcpHttpClient(cfg);
  try {
    const tools = await client.listTools();
    return sanitizeFeishuProjectMcpStatus({
      ...base,
      connected: true,
      initialized: true,
      sessionReady: !!client.sessionId,
      toolCount: tools.length,
      tools: summarizeTools(tools),
      effectiveTransport: client.usedHeaderAuth ? "http-header" : "http-oauth",
    }, cfg);
  } catch (err) {
    return sanitizeFeishuProjectMcpStatus({
      ...base,
      needsAuthorization: isAuthorizationError(err),
      authorizationUrl: authorizationUrlFromError(err),
      error: err?.message || String(err),
      statusCode: err?.status || 0,
      wwwAuthenticate: err?.wwwAuthenticate || "",
      effectiveTransport: client.usedHeaderAuth ? "http-header" : cfg.transport,
    }, cfg);
  }
}

export async function getFeishuProjectMcpFilterMetadata(syncConfig = {}, options = {}) {
  try {
    const result = await getFeishuProjectMcpFilterMetadataUnsafe(syncConfig, options);
    return sanitizeFeishuProjectMcpPayload(result, syncConfig);
  } catch (error) {
    throw sanitizeFeishuProjectMcpError(error, syncConfig);
  }
}

async function getFeishuProjectMcpFilterMetadataUnsafe(syncConfig = {}, options = {}) {
  const cfg = normalizeMcpConfig(syncConfig);
  const client = options.client || new FeishuProjectMcpHttpClient(cfg);
  await client.initialize();
  const tools = await client.listTools();
  const resolvedContext = await resolveMcpProjectContext(client, tools, syncConfig, options).catch(() => ({}));
  const projectKey = stringValue(resolvedContext.projectKey || syncConfig?.feishu?.spaceKey || options.projectKey);
  const workItemType = stringValue(
    resolvedContext.workItemApiName
      || resolvedContext.workItemTypeKey
      || syncConfig?.feishu?.workItemTypeKey
      || options.workItemType,
  );

  const [fields, roles] = await Promise.all([
    tools.some((tool) => tool.name === "list_workitem_field_config")
      ? listMcpConfigPages(client, "list_workitem_field_config", {
        project_key: projectKey,
        work_item_type: workItemType,
      }, "field")
      : Promise.resolve([]),
    tools.some((tool) => tool.name === "list_workitem_role_config")
      ? listMcpConfigPages(client, "list_workitem_role_config", {
        project_key: projectKey,
        work_item_type: workItemType,
      }, "role")
      : Promise.resolve([]),
  ]);

  return {
    ok: true,
    source: "feishu-mcp",
    projectKey,
    workItemTypeKey: workItemType,
    workItemTypeName: resolvedContext.workItemTypeName || "",
    fields,
    roles,
    generatedAt: new Date().toISOString(),
  };
}

export async function captureFeishuProjectMcpItems(syncConfig = {}, options = {}) {
  try {
    const result = await captureFeishuProjectMcpItemsUnsafe(syncConfig, options);
    return sanitizeFeishuProjectMcpPayload(result, syncConfig);
  } catch (error) {
    throw sanitizeFeishuProjectMcpError(error, syncConfig);
  }
}

async function captureFeishuProjectMcpItemsUnsafe(syncConfig = {}, options = {}) {
  const cfg = normalizeMcpConfig(syncConfig);
  const limit = clampLimit(options.limit || syncConfig?.sync?.batchSize, 20, 200);
  const requestedProblemNos = problemNosFromOptions(options);
  const captureLimit = requestedProblemNos.length
    ? clampLimit(
      options.problemNoCandidateLimit || options.scope?.problemNoCandidateLimit || syncConfig?.sync?.problemNoCandidateLimit,
      Math.max(limit, requestedProblemNos.length, 50),
      200,
    )
    : limit;
  if (!cfg.serverUrl) {
    return { ok: false, source: "feishu-mcp", error: "MCP serverUrl is empty", items: [], total: 0 };
  }

  const client = new FeishuProjectMcpHttpClient(cfg);
  const tools = await client.listTools();
  const selectedTool = chooseWorkItemTool(tools, { ...options, configuredToolName: cfg.toolName });
  if (!selectedTool) {
    return {
      ok: false,
      source: "feishu-mcp",
      error: "No readable Feishu work item MCP tool was found. Configure feishu.mcp.toolName after checking the tool list.",
      items: [],
      total: 0,
      tools: summarizeTools(tools),
    };
  }

  const resolvedContext = selectedTool.name === "search_by_mql"
    ? await resolveMcpProjectContext(client, tools, syncConfig, options).catch(() => ({}))
    : {};
  const fieldKeys = mcpReadFieldKeys(await resolveMcpWorkItemFieldKeys(client, tools, syncConfig, resolvedContext, options).catch(() => []), {
    ...contextForSync(syncConfig, options),
    ...resolvedContext,
  });
  const args = buildToolArguments(selectedTool, syncConfig, { ...options, limit: captureLimit, resolvedContext, fieldKeys }, cfg);
  if (selectedTool.name === "get_workitem_brief" && fieldKeys.length && !args.fields) {
    args.fields = fieldKeys;
  }
  if (selectedTool.name === "get_workitem_brief" && args.fields?.length && (!args.page_size || Number(args.page_size) < 200)) {
    args.page_size = 200;
  }
  const call = await callWorkItemToolWithFallback(client, selectedTool, args, syncConfig, {
    ...options,
    limit: captureLimit,
    resolvedContext,
    fieldKeys,
    availableTools: tools,
  }, cfg);
  const result = call.result;
  const effectiveArgs = call.arguments || args;
  if (result?.isError) {
    const errorText = toolResultText(result);
    if (isRetryableMcpToolError(errorText)) {
      const fallback = await fallbackMcpCaptureForExplicitIds(client, tools, syncConfig, {
        ...options,
        limit,
        resolvedContext,
        fieldKeys,
      }, cfg, selectedTool, effectiveArgs, errorText);
      if (fallback) return fallback;
    }
    return {
      ok: false,
      source: "feishu-mcp",
      error: friendlyMcpToolError(errorText, selectedTool, effectiveArgs) || `MCP tool ${selectedTool.name} returned isError=true`,
      tool: summarizeTool(selectedTool),
      arguments: effectiveArgs,
      items: [],
      total: 0,
      tools: summarizeTools(tools),
    };
  }

  const payloads = extractPayloadsFromToolResult(result);
  let items = dedupeWorkItems(
    workItemsFromMcpPayloads(payloads, syncConfig, resolvedContext, cfg.serverUrl),
  );
  if (selectedTool.name === "search_by_mql" && options.hydrate !== false && tools.some((tool) => tool.name === "get_workitem_brief")) {
    items = await hydrateMcpWorkItems(client, items, syncConfig, resolvedContext, {
      limit: captureLimit,
      maxPages: clampLimit(options.hydrateMaxPages || cfg.hydrateMaxPages, 5, 10),
      fieldKeys,
    }).catch(() => items);
  }
  const missingProblemNos = requestedProblemNos.length ? missingProblemNosFromItems(items, requestedProblemNos) : [];
  if (requestedProblemNos.length) items = filterMcpItemsByProblemNos(items, requestedProblemNos);
  items = items.slice(0, limit);
  let childWarning = "";
  if (options.includeAttachments ?? syncConfig?.sync?.includeAttachments ?? true) {
    items = await hydrateMcpAttachments(client, tools, items, syncConfig, resolvedContext, {
      limit,
      maxPages: clampLimit(options.commentMaxPages || cfg.commentMaxPages, 5, 20),
    }).catch((err) => {
      childWarning = `MCP attachment hydration failed: ${err?.message || String(err)}`;
      return items;
    });
    const hydrationWarnings = items.flatMap((item) => item._attachmentHydrationWarnings || []);
    if (!childWarning && hydrationWarnings.length) childWarning = hydrationWarnings.join("; ");
    if (hydrationWarnings.length) {
      items = items.map(({ _attachmentHydrationWarnings, ...item }) => item);
    }
  }

  return {
    ok: true,
    source: "feishu-mcp",
    total: items.length,
    items,
    tool: summarizeTool(selectedTool),
    arguments: effectiveArgs,
    fallback: call.fallback || undefined,
    payloadCount: payloads.length,
    tools: summarizeTools(tools),
    effectiveTransport: client.usedHeaderAuth ? "http-header" : "http-oauth",
    refreshAttachmentDownload: (attachment, item) => refreshFeishuProjectMcpAttachmentDownload(
      attachment,
      item,
      syncConfig,
      { client },
    ),
    requestedProblemNos: requestedProblemNos.length ? requestedProblemNos : undefined,
    missingWorkItemNos: missingProblemNos.length ? missingProblemNos : undefined,
    warning: [
      call.fallback?.warning,
      childWarning,
      missingProblemNos.length ? `MCP call succeeded, but no exact work item matched requested problem number(s): ${missingProblemNos.join(", ")}` : "",
      items.length ? "" : "MCP call succeeded, but no work item shaped payload was detected.",
    ].filter(Boolean).join("; "),
  };
}

export async function refreshFeishuProjectMcpAttachmentDownload(attachment = {}, item = {}, syncConfig = {}, options = {}) {
  const sourceWorkItemId = stringValue(
    attachment.sourceWorkItemId
      || item.work_item_id
      || item.sourceWorkItemId
      || item.id
      || attachment.source_work_item_id,
  );
  const sourceProjectKey = stringValue(
    attachment.sourceProjectKey
      || attachment.source_project_key
      || item.space_key
      || item.sourceProjectKey
      || syncConfig?.feishu?.spaceKey,
  );
  const originalUrl = stringValue(attachment.sourceUrl || attachment.originalUrl || attachment.url);
  if (!sourceWorkItemId || !sourceProjectKey || !isFeishuProjectFileUrl(originalUrl)) {
    throw new Error("Feishu attachment download URL cannot be refreshed because its source context is incomplete");
  }

  const normalized = normalizeMcpAttachment({
    ...attachment,
    sourceUrl: originalUrl,
    originalUrl,
  }, {
    sourceWorkItemId,
    sourceCommentId: attachment.sourceCommentId,
  }, attachment.id || attachment.file_id || `work-item-${sourceWorkItemId}-attachment`);
  if (!normalized) throw new Error("Feishu attachment source URL is not supported by MCP download signing");

  const cfg = normalizeMcpConfig(syncConfig);
  const client = options.client || new FeishuProjectMcpHttpClient(cfg);
  return signMcpAttachmentDownload(client, normalized, {
    ...item,
    id: sourceWorkItemId,
    work_item_id: sourceWorkItemId,
    space_key: sourceProjectKey,
  }, syncConfig, {
    projectKey: sourceProjectKey,
  }, {
    throwOnError: true,
  });
}

export class FeishuProjectMcpHttpClient {
  constructor(config = {}) {
    this.config = normalizeMcpConfig({ feishu: { mcp: config } });
    this.nextId = 1;
    this.initialized = false;
    this.sessionId = "";
    this.usedHeaderAuth = this.config.transport === "http-header";
  }

  async initialize() {
    if (this.initialized) return this.initializeResult || {};
    const result = await this.request("initialize", {
      protocolVersion: this.config.protocolVersion || DEFAULT_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      clientInfo: CLIENT_INFO,
    });
    this.initialized = true;
    this.initializeResult = result || {};
    await this.notify("notifications/initialized", {});
    return this.initializeResult;
  }

  async listTools() {
    await this.initialize();
    const result = await this.request("tools/list", {});
    return normalizeTools(result);
  }

  async callTool(name, args = {}) {
    if (!name) throw new Error("MCP tool name is required");
    await this.initialize();
    return this.request("tools/call", { name, arguments: args || {} });
  }

  async notify(method, params = {}) {
    await this.postJson({ jsonrpc: "2.0", method, params }, { notification: true });
  }

  async request(method, params = {}) {
    const id = this.nextId++;
    const response = await this.postJson({ jsonrpc: "2.0", id, method, params });
    if (response?.error) {
      throw new FeishuProjectMcpRpcError(sanitizeFeishuProjectMcpPayload(response.error, this.config));
    }
    return response?.result ?? response;
  }

  async postJson(payload, { notification = false } = {}) {
    let lastError = null;
    for (const useHeaderAuth of this.authAttemptOrder()) {
      try {
        const parsed = await this.postOnce(payload, { notification, useHeaderAuth });
        this.usedHeaderAuth = !!useHeaderAuth;
        return parsed;
      } catch (err) {
        const safeError = sanitizeFeishuProjectMcpError(err, this.config);
        lastError = safeError;
        if (!isAuthorizationError(safeError) || !this.config.token || useHeaderAuth) throw safeError;
        this.usedHeaderAuth = true;
      }
    }
    throw lastError;
  }

  authAttemptOrder() {
    if (this.usedHeaderAuth) return [true];
    if (this.config.transport === "http-header") return [true];
    if (this.config.token) return [false, true];
    return [false];
  }

  async postOnce(payload, { notification = false, useHeaderAuth = false } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const headers = {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      };
      if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
      if (useHeaderAuth && this.config.token) headers[this.config.headerName] = this.config.token;

      const resp = await fetch(this.config.serverUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        redirect: "manual",
        signal: controller.signal,
      });
      const sessionId = resp.headers.get("mcp-session-id");
      if (sessionId) this.sessionId = sessionId;

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        const safeErrorResponse = sanitizeFeishuProjectMcpPayload({
          status: resp.status,
          statusText: resp.statusText,
          body: text,
          location: resp.headers.get("location") || "",
          wwwAuthenticate: resp.headers.get("www-authenticate") || "",
        }, this.config);
        throw new FeishuProjectMcpHttpError(safeErrorResponse);
      }

      if (notification || resp.status === 202 || resp.status === 204) return {};
      const text = await resp.text();
      if (!text.trim()) return {};
      return sanitizeFeishuProjectMcpPayload(
        parseMcpHttpBody(text, resp.headers.get("content-type") || "", payload.id),
        this.config,
      );
    } catch (err) {
      if (err?.name === "AbortError") throw new Error(`MCP request timed out after ${this.config.timeoutMs}ms`);
      throw sanitizeFeishuProjectMcpError(err, this.config);
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class FeishuProjectMcpHttpError extends Error {
  constructor({ status, statusText, body, location, wwwAuthenticate }) {
    const details = body ? `: ${clip(body, 500)}` : "";
    super(`MCP HTTP ${status} ${statusText || ""}${details}`.trim());
    this.name = "FeishuProjectMcpHttpError";
    this.status = status;
    this.body = body;
    this.location = location;
    this.wwwAuthenticate = wwwAuthenticate;
    this.needsAuthorization = status === 401 || status === 403 || (status >= 300 && status < 400);
  }
}

export class FeishuProjectMcpRpcError extends Error {
  constructor(error) {
    super(error?.message || "MCP JSON-RPC error");
    this.name = "FeishuProjectMcpRpcError";
    this.code = error?.code;
    this.data = error?.data;
  }
}

export function normalizeMcpConfig(syncConfig = {}) {
  const defaults = defaultFeishuProjectMcpConfig();
  const feishu = syncConfig.feishu || syncConfig;
  const mcp = feishu.mcp || syncConfig.mcp || syncConfig || {};
  const transport = normalizeTransport(mcp.transport || defaults.transport);
  return {
    ...defaults,
    ...mcp,
    enabled: mcp.enabled === true || !!mcp.serverUrl || !!mcp.token,
    transport,
    serverUrl: normalizeServerUrl(mcp.serverUrl || defaults.serverUrl),
    headerName: String(mcp.headerName || defaults.headerName).trim() || defaults.headerName,
    token: String(mcp.token || process.env.FEISHU_PROJECT_MCP_TOKEN || process.env.MCP_USER_TOKEN || "").trim(),
    toolName: String(mcp.toolName || mcp.queryToolName || "").trim(),
    timeoutMs: clampLimit(mcp.timeoutMs, defaults.timeoutMs, 120000),
  };
}

function normalizeTransport(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (["header", "http-header", "token"].includes(raw)) return "http-header";
  return "http-oauth";
}

function normalizeServerUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (!/^https?:$/i.test(parsed.protocol)) return "";
    return parsed.toString();
  } catch {
    return "";
  }
}

function parseMcpHttpBody(text, contentType, id) {
  const messages = /text\/event-stream/i.test(contentType)
    ? parseSseMessages(text)
    : [parseJsonText(text)].filter(Boolean);
  if (!messages.length) return {};
  const byId = messages.find((message) => message && message.id === id);
  const useful = byId || messages.find((message) => message?.error || message?.result) || messages.at(-1);
  return useful || {};
}

function parseSseMessages(text) {
  const messages = [];
  let dataLines = [];
  const flush = () => {
    if (!dataLines.length) return;
    const data = dataLines.join("\n").trim();
    dataLines = [];
    if (!data || data === "[DONE]") return;
    const parsed = parseJsonText(data);
    if (parsed) messages.push(parsed);
  };
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line.trim()) {
      flush();
      continue;
    }
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  flush();
  return messages;
}

function parseJsonText(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizeTools(result) {
  const tools = Array.isArray(result?.tools)
    ? result.tools
    : Array.isArray(result)
      ? result
      : [];
  return tools.filter((tool) => tool?.name);
}

function chooseWorkItemTool(tools = [], options = {}) {
  const explicit = String(options.toolName || options.configuredToolName || "").trim();
  if (explicit) {
    const hit = tools.find((tool) => tool.name === explicit);
    if (hit) return hit;
    return { name: explicit, description: "Configured MCP tool" };
  }
  const ids = [
    ...(Array.isArray(options.workItemIds) ? options.workItemIds : []),
    ...(Array.isArray(options.scope?.workItemIds) ? options.scope.workItemIds : []),
    options.workItemId || options.scope?.workItemId || "",
  ].map((x) => String(x || "").trim()).filter((x) => x && !isProblemNoLike(x));
  if (ids.length) {
    const brief = tools.find((tool) => tool.name === "get_workitem_brief");
    if (brief) return brief;
  }
  const mql = tools.find((tool) => tool.name === "search_by_mql");
  if (mql) return mql;
  const scored = tools.map((tool) => ({ tool, score: scoreTool(tool) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored[0]?.tool || null;
}

function scoreTool(tool = {}) {
  const text = `${tool.name || ""}\n${tool.title || ""}\n${tool.description || ""}`.toLowerCase();
  let score = 0;
  if (/work[_\s-]?item|workitem|issue|bug|defect|ticket/.test(text)) score += 30;
  if (/search|query|list|find|get|read/.test(text)) score += 18;
  if (/project|space|meegle|feishu|lark/.test(text)) score += 8;
  if (/create|update|delete|remove|close|transition|comment|upload|write|set/.test(text)) score -= 40;
  return score;
}

function problemNosFromOptions(options = {}) {
  const ids = [
    options.workItemIds,
    options.workItemId,
    options.scope?.workItemIds,
    options.scope?.workItemId,
  ].flatMap((value) => normalizeStringList(value));
  const explicit = [
    options.workItemNos,
    options.workItemNo,
    options.problemNos,
    options.problemNo,
    options.sourceProblemNos,
    options.sourceProblemNo,
    options.scope?.workItemNos,
    options.scope?.workItemNo,
    options.scope?.problemNos,
    options.scope?.problemNo,
    options.scope?.sourceProblemNos,
    options.scope?.sourceProblemNo,
  ].flatMap((value) => normalizeStringList(value));
  return uniq([
    ...ids.filter(isProblemNoLike),
    ...explicit,
  ].map(normalizeProblemNo).filter(isProblemNoLike));
}

function normalizeProblemNo(value = "") {
  return stringValue(value).replace(/\s+/g, "").toUpperCase();
}

function isProblemNoLike(value = "") {
  return /^[A-Z][A-Z0-9]+-\d{2,}$/i.test(normalizeProblemNo(value));
}

function buildToolArguments(tool, syncConfig = {}, options = {}, mcpConfig = {}) {
  const cfg = syncConfig || {};
  const feishu = cfg.feishu || {};
  const web = feishu.web || defaultFeishuProjectWebConfig();
  const ids = [
    ...(Array.isArray(options.workItemIds) ? options.workItemIds : []),
    ...(Array.isArray(options.scope?.workItemIds) ? options.scope.workItemIds : []),
    options.workItemId || options.scope?.workItemId || "",
  ].map((x) => String(x || "").trim()).filter((x) => x && !isProblemNoLike(x));
  const problemNos = problemNosFromOptions(options);
  const context = {
    ids,
    problemNos,
    limit: clampLimit(options.limit || cfg.sync?.batchSize, 20, 200),
    query: String(options.query || options.keyword || options.search || problemNos.join(" ")).trim(),
    spaceKey: String(options.resolvedContext?.projectKey || options.projectKey || options.scope?.projectKey || feishu.spaceKey || "").trim(),
    sourceSpaceKey: String(options.projectKey || options.scope?.projectKey || feishu.spaceKey || "").trim(),
    typeKey: String(options.typeKey || options.scope?.typeKey || options.sourceView?.sourceWorkItemTypeKey || feishu.workItemTypeKey || "").trim(),
    workItemTypeName: String(
      options.resolvedContext?.workItemTypeName
      || options.typeName
      || options.workItemTypeName
      || options.sourceView?.sourceWorkItemTypeKey
      || feishu.workItemTypeKey
      || feishu.mcp?.workItemTypeName
      || ""
    ).trim(),
    mql: String(options.mql || options.scope?.mql || feishu.mcp?.mql || "").trim(),
    assigneeFieldKey: String(options.assigneeFieldKey || options.scope?.assigneeFieldKey || feishu.mcp?.assigneeFieldKey || cfg.sync?.assigneeFieldKey || "current_status_operator").trim(),
    requiredAssigneeKeywords: cfg.sync?.assigneePrefilter === false ? [] : normalizeStringList(options.requiredAssigneeKeywords || options.scope?.requiredAssigneeKeywords || cfg.sync?.requiredAssigneeKeywords),
    filters: normalizeMcpReadFilters(syncConfig, options),
    readScopeMatch: String(options.readScopeMatch || options.scope?.match || options.scope?.readScope?.match || cfg.sync?.readScope?.match || "all").trim(),
    sourceView: normalizeSourceView(syncConfig, options),
    sort: normalizeMcpSortRules(options.sort || options.scope?.sort || cfg.sync?.sort),
    fieldKeys: mcpReadFieldKeys(normalizeStringList(options.fieldKeys || options.scope?.fieldKeys || syncConfig?.feishu?.mcp?.fieldKeys || syncConfig?.feishu?.mcp?.fields || syncConfig?.feishu?.fieldKeys), {
      ...options.resolvedContext,
      typeKey: String(options.typeKey || options.scope?.typeKey || options.sourceView?.sourceWorkItemTypeKey || feishu.workItemTypeKey || "").trim(),
      workItemTypeName: String(
        options.resolvedContext?.workItemTypeName
        || options.typeName
        || options.workItemTypeName
        || options.sourceView?.sourceWorkItemTypeKey
        || feishu.workItemTypeKey
        || feishu.mcp?.workItemTypeName
        || ""
      ).trim(),
    }),
    homepageUrl: String(options.url || options.sourceViewUrl || web.homepageUrl || "").trim(),
    includeComments: options.includeComments ?? cfg.sync?.includeComments ?? true,
    includeAttachments: options.includeAttachments ?? cfg.sync?.includeAttachments ?? true,
  };

  const schema = tool.inputSchema || tool.input_schema || tool.schema || {};
  const props = schema?.properties && typeof schema.properties === "object" ? schema.properties : null;
  const args = {};
  if (props) {
    for (const [key, propSchema] of Object.entries(props)) {
      const value = valueForToolProperty(key, propSchema || {}, context);
      if (value !== undefined) args[key] = value;
    }
  } else {
    Object.assign(args, {
      space_key: context.spaceKey,
      project_key: context.spaceKey,
      work_item_type_key: context.typeKey,
      type_key: context.typeKey,
      work_item_ids: ids,
      work_item_nos: problemNos,
      problem_nos: problemNos,
      source_view_id: context.sourceView.viewId,
      view_id: context.sourceView.viewId,
      view_url: context.sourceView.url,
      limit: context.limit,
      query: context.query,
      order_by: sortArgumentForSchema(context.sort, { type: "array" }),
      include_comments: context.includeComments,
      include_attachments: context.includeAttachments,
    });
  }

  return cleanObject({
    ...args,
    ...(options.arguments && typeof options.arguments === "object" ? options.arguments : {}),
    ...(mcpConfig.arguments && typeof mcpConfig.arguments === "object" ? mcpConfig.arguments : {}),
  });
}

function valueForToolProperty(key, schema, context) {
  const norm = normalizeKey(key);
  const type = String(schema.type || "").toLowerCase();
  const enumValues = Array.isArray(schema.enum) ? schema.enum.map(String) : [];
  if (norm === "mql") return context.mql || buildDefaultMql(context);
  if (/workitemids|issueids|ticketids|ids$/.test(norm)) {
    if (!context.ids.length) return undefined;
    return type === "string" ? context.ids.join(",") : context.ids;
  }
  if (/workitemnos|issuenos|ticketnos|bugnos|problemnos|numbers/.test(norm)) {
    if (!context.problemNos.length) return undefined;
    return type === "string" ? context.problemNos.join(",") : context.problemNos;
  }
  if (/workitemid|issueid|ticketid|^id$/.test(norm)) return context.ids[0] || undefined;
  if (/workitemtype|issuetype|typekey/.test(norm)) return context.typeKey || enumMatch(enumValues, context.typeKey);
  if (/space|projectkey|projectid/.test(norm)) return context.spaceKey || enumMatch(enumValues, context.spaceKey);
  if (/workobjectviewid|sourceviewid|viewid|viewkey|viewtoken/.test(norm)) return context.sourceView.viewId || undefined;
  if (/workobjectviewurl|sourceviewurl|viewurl/.test(norm)) return context.sourceView.url || undefined;
  if (/viewscope|sourceviewscope/.test(norm)) return context.sourceView.scope || undefined;
  if (/viewnode|sourcenode/.test(norm)) return context.sourceView.node || undefined;
  if (/^fields$|fieldkeys|fieldkeylist|rowfieldlist/.test(norm)) return context.fieldKeys?.length ? context.fieldKeys : undefined;
  if (/pagesize|limit|count|size/.test(norm)) return context.limit;
  if (/^page$|pagenum|pageindex/.test(norm)) return 1;
  if (/orderby|sortby|sortfields|sortfield|orderfields/.test(norm)) return sortArgumentForSchema(context.sort, schema);
  if (/query|keyword|search|text/.test(norm)) return context.query || undefined;
  if (/url|homepage|link/.test(norm)) return context.homepageUrl || undefined;
  if (/includecomments|withcomments|loadcomments/.test(norm)) return !!context.includeComments;
  if (/includeattachments|withattachments|loadattachments/.test(norm)) return !!context.includeAttachments;
  if (schema.default !== undefined) return schema.default;
  return undefined;
}

async function callWorkItemToolWithFallback(client, tool, args, syncConfig = {}, options = {}, mcpConfig = {}) {
  let result;
  let errorText = "";
  let thrownError = null;
  try {
    result = await callMcpToolWithRetry(client, tool.name, args, mcpConfig, options);
    if (tool.name !== "search_by_mql" || !result?.isError) return { result, arguments: args };
    errorText = toolResultText(result);
  } catch (err) {
    if (tool.name !== "search_by_mql") {
      throw friendlyMcpToolException(err, tool, args);
    }
    thrownError = err;
    errorText = err?.message || String(err);
  }

  if (isMcpAmbiguousUserLabelError(errorText) && !hasExplicitMql(syncConfig, options, mcpConfig)) {
    const userLabelRetry = await buildMcpAmbiguousUserLabelRetry(
      client,
      tool,
      args,
      errorText,
      syncConfig,
      options,
      mcpConfig,
    );
    if (userLabelRetry) {
      try {
        const retryResult = await callMcpToolWithRetry(client, tool.name, userLabelRetry.arguments, mcpConfig, options);
        if (!retryResult?.isError) {
          return {
            result: retryResult,
            arguments: userLabelRetry.arguments,
            fallback: userLabelRetry.fallback,
          };
        }
      } catch {
        // Preserve the original actionable ambiguity error if the ID-based retry also fails.
      }
    }
  }

  if (!isMcpWorkItemTypeLabelError(errorText) || hasExplicitMql(syncConfig, options, mcpConfig)) {
    if (result?.isError) return { result, arguments: args };
    throw friendlyMcpToolException(thrownError || new Error(errorText || "MCP search_by_mql failed"), tool, args);
  }
  const fallbackArgsList = buildMqlFallbackArguments(tool, syncConfig, options, mcpConfig, args);
  let lastError = null;
  for (const fallbackArgs of fallbackArgsList) {
    try {
      const fallbackResult = await callMcpToolWithRetry(client, tool.name, fallbackArgs, mcpConfig, options);
      if (!fallbackResult?.isError) {
        return {
          result: fallbackResult,
          arguments: fallbackArgs,
          fallback: {
            reason: "work_item_type_label_retry",
            originalError: errorText,
            originalArguments: args,
          },
        };
      }
      lastError = new Error(toolResultText(fallbackResult) || `MCP tool ${tool.name} returned isError=true`);
    } catch (err) {
      lastError = err;
    }
  }
  if (result?.isError) return { result, arguments: args };
  throw friendlyMcpToolException(lastError || new Error(errorText), tool, args);
}

async function buildMcpAmbiguousUserLabelRetry(client, tool, args = {}, errorText = "", syncConfig = {}, options = {}, mcpConfig = {}) {
  const label = mcpAmbiguousUserLabel(errorText);
  const mql = String(args.mql || "").trim();
  if (!label || !mql) return null;
  const projectKey = String(
    args.project_key
      || options.resolvedContext?.projectKey
      || options.projectKey
      || options.scope?.projectKey
      || syncConfig?.feishu?.spaceKey
      || "",
  ).trim();
  if (!projectKey) return null;
  const tools = Array.isArray(options.availableTools) && options.availableTools.length
    ? options.availableTools
    : await client.listTools().catch(() => []);
  const userKeys = await resolveMcpProjectUserLabel(
    client,
    tools,
    projectKey,
    label,
    mcpConfig,
    options,
  ).catch(() => []);
  if (!userKeys.length) return null;
  const nextMql = rebuildMqlWithResolvedUserLabel(
    tool,
    args,
    syncConfig,
    options,
    mcpConfig,
    label,
    userKeys,
  );
  if (!nextMql || nextMql === mql) return null;
  return {
    arguments: cleanObject({ ...args, mql: nextMql }),
    fallback: {
      reason: "ambiguous_user_label_resolved",
      userLabel: label,
      resolvedUserCount: userKeys.length,
      warning: `飞书人员“${label}”存在同名，已按当前空间团队中的 ${userKeys.length} 个在职账号使用 user_key 唯一匹配。`,
    },
  };
}

async function resolveMcpProjectUserLabel(client, tools = [], projectKey = "", label = "", mcpConfig = {}, options = {}) {
  const cacheKey = mcpUserLabelCacheKey(mcpConfig, projectKey, label);
  const cached = mcpUserLabelCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.userKeys;

  const toolNames = new Set(tools.map((tool) => tool?.name).filter(Boolean));
  if (!toolNames.has("search_user_info")) return cacheMcpUserLabel(cacheKey, []);
  const directUsers = await searchMcpUsers(client, [label], projectKey, mcpConfig, options);
  const directMatches = directUsers.filter((user) => mcpUserDisplayName(user) === label && mcpUserIsActive(user));
  if (directMatches.length) {
    return cacheMcpUserLabel(cacheKey, directMatches.map(mcpUserKey).filter(Boolean));
  }
  if (!toolNames.has("list_project_team") || !toolNames.has("list_team_members")) {
    return cacheMcpUserLabel(cacheKey, []);
  }

  const teams = await listMcpProjectTeams(client, projectKey, mcpConfig, options);
  const memberKeys = new Set();
  await forEachWithConcurrency(teams, MCP_USER_LABEL_TEAM_LOOKUP_CONCURRENCY, async (team) => {
    const teamId = String(team?.team_id || team?.teamId || team?.id || "").trim();
    if (!teamId) return;
    const result = await callMcpToolWithRetry(client, "list_team_members", {
      project_key: projectKey,
      team_id: teamId,
      query: label,
    }, mcpConfig, options).catch(() => null);
    for (const payload of extractPayloadsFromToolResult(result)) {
      if (!payload || typeof payload !== "object") continue;
      const members = Array.isArray(payload.members) ? payload.members : [];
      for (const member of members) {
        const key = typeof member === "object" ? mcpUserKey(member) : String(member || "").trim();
        if (key) memberKeys.add(key);
      }
    }
  });
  if (!memberKeys.size) return cacheMcpUserLabel(cacheKey, []);

  const verified = await searchMcpUsers(client, [...memberKeys], projectKey, mcpConfig, options);
  const exactKeys = verified
    .filter((user) => mcpUserDisplayName(user) === label && mcpUserIsActive(user))
    .map(mcpUserKey)
    .filter(Boolean);
  return cacheMcpUserLabel(cacheKey, exactKeys);
}

async function listMcpProjectTeams(client, projectKey = "", mcpConfig = {}, options = {}) {
  const teams = [];
  let pageToken = "";
  for (let page = 0; page < 20; page += 1) {
    const result = await callMcpToolWithRetry(client, "list_project_team", cleanObject({
      project_key: projectKey,
      page_token: pageToken,
    }), mcpConfig, options);
    const payloads = extractPayloadsFromToolResult(result);
    const pagePayload = payloads.find((payload) => payload && typeof payload === "object" && Array.isArray(payload.data));
    if (!pagePayload) break;
    teams.push(...pagePayload.data);
    pageToken = String(pagePayload.next_page_token || pagePayload.nextPageToken || "").trim();
    if (!pageToken) break;
  }
  return uniqBy(teams, (team) => String(team?.team_id || team?.teamId || team?.id || ""));
}

async function searchMcpUsers(client, values = [], projectKey = "", mcpConfig = {}, options = {}) {
  const users = [];
  const normalized = normalizeStringList(values);
  for (let offset = 0; offset < normalized.length; offset += 20) {
    const userKeys = normalized.slice(offset, offset + 20);
    const result = await callMcpToolWithRetry(client, "search_user_info", {
      user_keys: userKeys,
      project_key: projectKey,
      need_all_status: false,
    }, mcpConfig, options).catch(() => null);
    users.push(...extractPayloadsFromToolResult(result)
      .flatMap((payload) => Array.isArray(payload) ? payload : [payload])
      .filter((payload) => payload && typeof payload === "object" && !!mcpUserKey(payload)));
  }
  return uniqBy(users, mcpUserKey);
}

async function forEachWithConcurrency(values = [], concurrency = 1, action = async () => {}) {
  const list = Array.isArray(values) ? values : [];
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), list.length) }, async () => {
    while (cursor < list.length) {
      const index = cursor;
      cursor += 1;
      await action(list[index], index);
    }
  }));
}

function mcpUserLabelCacheKey(mcpConfig = {}, projectKey = "", label = "") {
  return createHash("sha256").update(JSON.stringify({
    serverUrl: mcpConfig.serverUrl || "",
    token: mcpConfig.token || "",
    projectKey,
    label,
  })).digest("hex");
}

function cacheMcpUserLabel(cacheKey, userKeys = []) {
  const normalized = uniq(normalizeStringList(userKeys));
  mcpUserLabelCache.set(cacheKey, {
    userKeys: normalized,
    expiresAt: Date.now() + (normalized.length ? MCP_USER_LABEL_CACHE_TTL_MS : MCP_USER_LABEL_ERROR_CACHE_TTL_MS),
  });
  return normalized;
}

function mcpUserKey(user = {}) {
  return String(user?.user_key || user?.userKey || user?.username || user?.key || user?.id || "").trim();
}

function mcpUserDisplayName(user = {}) {
  return String(user?.name_cn || user?.name || user?.display_name || user?.displayName || user?.label || "").trim();
}

function mcpUserIsActive(user = {}) {
  const status = normalizeKey(user?.status || user?.user_status || "");
  return !status || ["active", "activated", "enabled", "onjob", "on_job"].includes(status);
}

function rebuildMqlWithResolvedUserLabel(tool = {}, args = {}, syncConfig = {}, options = {}, mcpConfig = {}, label = "", userKeys = []) {
  const originalMql = String(args.mql || "").trim();
  const resolvedValues = uniq(normalizeStringList(userKeys)).map((userKey) => `<id:${userKey}>`);
  if (!originalMql || !label || !resolvedValues.length) return originalMql;

  let replaced = false;
  const assigneeFieldKey = String(
    options.assigneeFieldKey
      || options.scope?.assigneeFieldKey
      || syncConfig?.feishu?.mcp?.assigneeFieldKey
      || syncConfig?.sync?.assigneeFieldKey
      || "current_status_operator",
  ).trim();
  const filters = normalizeMcpReadFilters(syncConfig, options).map((filter) => {
    if (!isMcpUserReferenceFilter(filter, assigneeFieldKey) || !filter.values.includes(label)) return filter;
    replaced = true;
    return {
      ...filter,
      values: filter.values.flatMap((value) => value === label ? resolvedValues : [value]),
    };
  });
  const requiredAssigneeKeywords = normalizeStringList(
    options.requiredAssigneeKeywords
      || options.scope?.requiredAssigneeKeywords
      || syncConfig?.sync?.requiredAssigneeKeywords,
  ).flatMap((value) => {
    if (value !== label) return [value];
    replaced = true;
    return resolvedValues;
  });
  if (!replaced) return originalMql;

  const { mql: _configuredMql, ...retryMcpArguments } = mcpConfig.arguments || {};
  const rebuiltArgs = buildToolArguments(tool, syncConfig, {
    ...options,
    mql: "",
    filters,
    requiredAssigneeKeywords,
    scope: {
      ...(options.scope || {}),
      mql: "",
      filters,
      requiredAssigneeKeywords,
    },
  }, {
    ...mcpConfig,
    arguments: retryMcpArguments,
  });
  return String(rebuiltArgs.mql || "").trim() || originalMql;
}

function isMcpUserReferenceFilter(filter = {}, assigneeFieldKey = "") {
  if (normalizeKey(filter.kind) === "role") return true;
  const fieldKey = stringValue(filter.fieldKey);
  if (fieldKey && normalizeKey(fieldKey) === normalizeKey(assigneeFieldKey)) return true;
  const text = `${fieldKey} ${stringValue(filter.fieldName)}`;
  return /(?:^|[_\s])(user|users|person|people|member|members|owner|owners|assignee|assignees|operator|operators|participant|participants|watcher|watchers)(?:$|[_\s])|人员|负责人|责任人|处理人|参与者|关注人|成员/i.test(text);
}

async function fallbackMcpCaptureForExplicitIds(client, tools = [], syncConfig = {}, options = {}, mcpConfig = {}, selectedTool = {}, originalArgs = {}, errorText = "") {
  const ids = workItemIdsFromOptions(options).slice(0, clampLimit(options.limit || syncConfig?.sync?.batchSize, idsFallbackLimit(workItemIdsFromOptions(options)), 200));
  if (!ids.length) return null;

  const searchTool = selectedTool.name === "search_by_mql"
    ? null
    : tools.find((tool) => tool.name === "search_by_mql");
  const warningBase = `Feishu MCP ${selectedTool.name || "tool"} hit a transient remote metadata/network error; dry-run used a degraded fallback for explicit work item ids.`;
  const resolvedContext = options.resolvedContext || {};

  if (searchTool) {
    const mql = buildMqlForWorkItemIds(syncConfig, resolvedContext, options, ids);
    if (mql) {
      const searchArgs = cleanObject({
        ...buildToolArguments(searchTool, syncConfig, {
          ...options,
          limit: Math.max(ids.length, 20),
          mql,
          scope: { ...(options.scope || {}), mql },
        }, mcpConfig),
        mql,
      });
      try {
        const fallbackCall = await callWorkItemToolWithFallback(client, searchTool, searchArgs, syncConfig, {
          ...options,
          limit: Math.max(ids.length, 20),
          mql,
          scope: { ...(options.scope || {}), mql },
        }, mcpConfig);
        if (!fallbackCall.result?.isError) {
          const payloads = extractPayloadsFromToolResult(fallbackCall.result);
          const items = dedupeWorkItems(
            workItemsFromMcpPayloads(payloads, syncConfig, resolvedContext, mcpConfig.serverUrl),
          ).slice(0, ids.length);
          if (items.length) {
            return {
              ok: true,
              source: "feishu-mcp",
              degraded: true,
              total: items.length,
              items,
              tool: summarizeTool(searchTool),
              arguments: fallbackCall.arguments || searchArgs,
              fallback: {
                reason: "transient_mcp_error_search_by_id",
                originalTool: summarizeTool(selectedTool),
                originalArguments: originalArgs,
                originalError: clip(errorText, 1000),
              },
              payloadCount: payloads.length,
              tools: summarizeTools(tools),
              effectiveTransport: client.usedHeaderAuth ? "http-header" : "http-oauth",
              warning: `${warningBase} Fallback search_by_mql succeeded.`,
            };
          }
        }
      } catch {
        // Fall through to identity-only fallback; dry-run should remain inspectable.
      }
    }
  }

  const items = buildMinimalMcpWorkItemsFromIds(ids, syncConfig, resolvedContext, errorText);
  return {
    ok: true,
    source: "feishu-mcp",
    degraded: true,
    total: items.length,
    items,
    tool: summarizeTool(selectedTool),
    arguments: originalArgs,
    fallback: {
      reason: "transient_mcp_error_minimal_identity",
      originalTool: summarizeTool(selectedTool),
      originalArguments: originalArgs,
      originalError: clip(errorText, 1000),
    },
    payloadCount: 0,
    tools: summarizeTools(tools),
    effectiveTransport: client.usedHeaderAuth ? "http-header" : "http-oauth",
    warning: `${warningBase} Only work item identity was available because Feishu detail/search fallback also failed or was unavailable.`,
  };
}

function idsFallbackLimit(ids = []) {
  return Math.max(1, Math.min(ids.length || 20, 200));
}

function workItemsFromMcpPayloads(payloads = [], syncConfig = {}, resolvedContext = {}, sourceUrl = "") {
  const briefItems = payloads
    .filter((payload) => payload?.work_item_attribute || payload?.work_item_fields)
    .map((payload) => normalizeBriefWorkItemPayload(payload, {}, syncConfig, resolvedContext));
  const mqlItems = payloads.flatMap((payload) => extractMqlWorkItems(payload, syncConfig, resolvedContext));
  return [
    ...briefItems,
    ...mqlItems,
    ...payloads.flatMap((payload) => extractFeishuWorkItemsFromJson(payload, { sourceUrl })),
  ];
}

function filterMcpItemsByProblemNos(items = [], problemNos = []) {
  const requested = uniq(normalizeStringList(problemNos).map(normalizeProblemNo).filter(isProblemNoLike));
  if (!requested.length) return items;
  return (items || []).flatMap((item) => {
    const matchedProblemNo = requested.find((problemNo) => mcpItemMatchesProblemNo(item, problemNo));
    return matchedProblemNo ? [annotateMcpItemProblemNo(item, matchedProblemNo)] : [];
  });
}

function missingProblemNosFromItems(items = [], problemNos = []) {
  const requested = uniq(normalizeStringList(problemNos).map(normalizeProblemNo).filter(isProblemNoLike));
  if (!requested.length) return [];
  return requested.filter((problemNo) => !(items || []).some((item) => mcpItemMatchesProblemNo(item, problemNo)));
}

function mcpItemMatchesProblemNo(item = {}, expectedNo = "") {
  const expected = normalizeProblemNo(expectedNo);
  if (!expected) return false;
  const direct = [
    item.work_item_no,
    item.workItemNo,
    item.auto_number,
    item.autoNumber,
    item.problemNo,
    item.problem_no,
    item.sourceProblemNo,
    item.sourceWorkItemNo,
    item.name,
    item.title,
    item.work_item_name,
    item.display_id,
    item.displayId,
    item.identifier,
    item.number,
    item.no,
  ].map(normalizeProblemNo).filter(Boolean);
  if (direct.includes(expected)) return true;
  if ([item.auto_number, item.autoNumber, item.raw?.auto_number, item.raw?.autoNumber].some((value) => autoNumberMatchesProblemNo(value, expected))) {
    return true;
  }
  for (const field of item.fields || []) {
    const keyText = `${field.key || ""}\n${field.field_key || ""}\n${field.name || ""}\n${field.field_name || ""}`;
    const valueText = displayMqlValue(field.value ?? field.display_value ?? field.displayValue);
    if (isAutoNumberFieldName(keyText) && autoNumberMatchesProblemNo(valueText, expected)) return true;
    if (isProblemNoFieldName(keyText) && normalizeProblemNo(valueText) === expected) return true;
    if (problemNosFromText(valueText).map(normalizeProblemNo).includes(expected)) return true;
  }
  const text = [
    item.source_url,
    item.url,
    item.sourceWorkItemUrl,
    JSON.stringify(item.raw || {}),
  ].filter(Boolean).join("\n");
  return problemNosFromText(text).map(normalizeProblemNo).includes(expected);
}

function annotateMcpItemProblemNo(item = {}, problemNo = "") {
  const expected = normalizeProblemNo(problemNo);
  if (!expected) return item;
  const existing = [
    item.work_item_no,
    item.workItemNo,
    item.problemNo,
    item.problem_no,
    item.sourceProblemNo,
    item.sourceWorkItemNo,
  ].map(normalizeProblemNo).find(isProblemNoLike);
  if (existing) return item;
  return cleanObject({
    ...item,
    work_item_no: expected,
    workItemNo: expected,
    problemNo: expected,
    sourceProblemNo: expected,
    sourceWorkItemNo: expected,
  });
}

function isProblemNoFieldName(value = "") {
  return /(work.?item.?no|work.?item.?key|issue.?key|issue.?no|ticket.?no|bug.?no|display.?id|identifier|\bno\b|number|编号|单号|工单号|问题编号|缺陷编号)/i.test(String(value || ""));
}

function isAutoNumberFieldName(value = "") {
  return /auto.?number|\bautonumber\b|\u81ea\u589e\u6570\u5b57/i.test(String(value || ""));
}

function autoNumberMatchesProblemNo(value, problemNo = "") {
  const expected = autoNumberFromProblemNo(problemNo);
  if (!expected) return false;
  const actual = normalizeAutoNumber(value);
  return !!actual && actual === expected;
}

function autoNumberFromProblemNo(value = "") {
  const match = normalizeProblemNo(value).match(/-(\d+)$/);
  return match ? normalizeAutoNumber(match[1]) : "";
}

function normalizeAutoNumber(value = "") {
  const text = displayMqlValue(value).replace(/\s+/g, "").trim();
  if (!/^\d+$/.test(text)) return "";
  return text.replace(/^0+(?=\d)/, "");
}

function problemNosFromText(text = "") {
  return String(text || "").match(/\b[A-Z][A-Z0-9]+-\d{2,}\b/gi) || [];
}

function buildMinimalMcpWorkItemsFromIds(ids = [], syncConfig = {}, resolvedContext = {}, errorText = "") {
  const feishu = syncConfig?.feishu || {};
  const spaceKey = stringValue(resolvedContext.projectSimpleName || resolvedContext.projectKey || feishu.spaceKey);
  const typeKey = stringValue(resolvedContext.workItemApiName || resolvedContext.workItemTypeKey || feishu.workItemTypeKey);
  return ids.map((id) => cleanObject({
    id,
    work_item_id: id,
    title: id,
    name: id,
    work_item_name: id,
    space_key: spaceKey,
    work_item_type_key: typeKey,
    source_url: renderSourceUrl(feishu, spaceKey, typeKey, id),
    fields: [],
    raw: {
      work_item_id: id,
      _mcpDegraded: true,
      _mcpError: clip(errorText, 1000),
    },
  }));
}

function buildMqlForWorkItemIds(syncConfig = {}, resolvedContext = {}, options = {}, ids = []) {
  const context = {
    ...contextForSync(syncConfig, options),
    ...resolvedContext,
    spaceKey: resolvedContext.projectKey || contextForSync(syncConfig, options).spaceKey,
    workItemTypeName: resolvedContext.workItemTypeName || contextForSync(syncConfig, options).workItemTypeName,
  };
  const project = context.projectKey || context.spaceKey || context.sourceSpaceKey;
  const type = context.workItemTypeName || context.workItemApiName || context.workItemTypeKey || context.typeKey;
  if (!project || !type || !ids.length) return "";
  const filterFields = normalizeMcpReadFilters({ sync: { readScope: { filters: context.filters || [] } } })
    .map((filter) => mqlFieldForFilter(filter))
    .filter(Boolean);
  const fields = mcpReadFieldKeys([...filterFields, context.assigneeFieldKey], context);
  const where = `${quoteMqlIdentifier("work_item_id")} IN (${ids.map(quoteMqlString).join(", ")})`;
  return `SELECT ${fields.map((field) => quoteMqlIdentifier(field)).join(", ")} FROM ${quoteMqlIdentifier(project)}.${quoteMqlIdentifier(type)} WHERE ${where} LIMIT ${clampLimit(ids.length, 20, 200)}`;
}

async function callMcpToolWithRetry(client, name, args = {}, mcpConfig = {}, options = {}) {
  const retry = normalizeMcpRetryConfig(mcpConfig, options);
  let lastError = null;
  let lastResult = null;
  for (let attempt = 0; attempt < retry.attempts; attempt += 1) {
    try {
      const result = await client.callTool(name, args);
      if (!result?.isError || !isRetryableMcpToolError(toolResultText(result))) return result;
      lastResult = result;
      if (attempt >= retry.attempts - 1) return result;
    } catch (err) {
      lastError = err;
      if (attempt >= retry.attempts - 1 || !isRetryableMcpToolError(err)) throw err;
    }
    await sleep(retryDelayMs(retry, attempt));
  }
  if (lastResult) return lastResult;
  throw lastError || new Error(`MCP tool ${name} failed`);
}

function normalizeMcpRetryConfig(mcpConfig = {}, options = {}) {
  const retry = (options.retry && typeof options.retry === "object" ? options.retry : null)
    || (mcpConfig.retry && typeof mcpConfig.retry === "object" ? mcpConfig.retry : {});
  return {
    attempts: clampLimit(options.retryAttempts ?? retry.attempts ?? mcpConfig.retryAttempts, 3, 8),
    baseDelayMs: clampMs(options.retryBaseDelayMs ?? retry.baseDelayMs ?? mcpConfig.retryBaseDelayMs, 500, 30000),
    maxDelayMs: clampMs(options.retryMaxDelayMs ?? retry.maxDelayMs ?? mcpConfig.retryMaxDelayMs, 3000, 60000),
  };
}

function retryDelayMs(retry = {}, attempt = 0) {
  const base = Math.max(0, Number(retry.baseDelayMs || 0));
  const max = Math.max(base, Number(retry.maxDelayMs || base));
  return Math.min(max, base * (2 ** attempt));
}

function isRetryableMcpToolError(value) {
  if (!value) return false;
  if (value instanceof FeishuProjectMcpHttpError) {
    return [408, 409, 425, 429].includes(Number(value.status)) || Number(value.status) >= 500;
  }
  const text = mcpErrorText(value);
  if (!text) return false;
  return /remote or network error|POOL_FAILURE|RemoteConnectionFailure|get connection failed|THRIFT_INGRESS|error_code=1115|metadata error\s*\(Code:\s*3001\)|Code:\s*3001|MultiQueryFieldsV3|ECONNRESET|ETIMEDOUT|ECONNREFUSED|socket hang up|network|timeout|timed out/i.test(text);
}

function mcpErrorText(value) {
  if (typeof value === "string") return value;
  const parts = [
    value?.message,
    value?.body,
    value?.data && safeStringify(value.data),
    value?.cause?.message,
  ].filter(Boolean);
  return parts.length ? parts.join("\n") : String(value || "");
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function workItemIdsFromOptions(options = {}) {
  return uniq([
    ...(Array.isArray(options.workItemIds) ? options.workItemIds : []),
    ...(Array.isArray(options.scope?.workItemIds) ? options.scope.workItemIds : []),
    options.workItemId || options.scope?.workItemId || "",
  ].map((x) => String(x || "").trim()).filter(Boolean));
}

function buildMqlFallbackArguments(tool, syncConfig = {}, options = {}, mcpConfig = {}, originalArgs = {}) {
  const resolved = options.resolvedContext || {};
  const candidates = workItemTypeCandidates(syncConfig, options)
    .filter((candidate) => candidate && normalizeKey(candidate) !== normalizeKey(resolved.workItemTypeName || resolved.workItemApiName || resolved.workItemTypeKey));
  const out = [];
  for (const candidate of candidates) {
    const nextContext = {
      ...resolved,
      workItemTypeName: candidate,
      workItemApiName: resolved.workItemApiName || resolved.workItemTypeKey,
    };
    const nextArgs = buildToolArguments(tool, syncConfig, {
      ...options,
      mql: "",
      scope: { ...(options.scope || {}), mql: "" },
      resolvedContext: nextContext,
    }, mcpConfig);
    const mql = nextArgs.mql || buildDefaultMql({
      ...contextForSync(syncConfig, options),
      ...nextContext,
      spaceKey: nextContext.projectKey || nextContext.projectSimpleName || contextForSync(syncConfig, options).spaceKey,
      workItemTypeName: candidate,
    });
    if (!mql || out.some((entry) => entry.mql === mql)) continue;
    out.push(cleanObject({ ...originalArgs, ...nextArgs, mql }));
  }
  return out;
}

function hasExplicitMql(syncConfig = {}, options = {}, mcpConfig = {}) {
  return !!String(
    options.mql
      || options.scope?.mql
      || options.arguments?.mql
      || syncConfig?.feishu?.mcp?.mql
      || mcpConfig.arguments?.mql
      || "",
  ).trim();
}

function contextForSync(syncConfig = {}, options = {}) {
  const feishu = syncConfig?.feishu || {};
  const sourceView = normalizeSourceView(syncConfig, options);
  return {
    spaceKey: String(options.projectKey || options.scope?.projectKey || feishu.spaceKey || "").trim(),
    sourceSpaceKey: String(options.projectKey || options.scope?.projectKey || feishu.spaceKey || "").trim(),
    typeKey: String(options.typeKey || options.scope?.typeKey || feishu.workItemTypeKey || "").trim(),
    assigneeFieldKey: String(options.assigneeFieldKey || options.scope?.assigneeFieldKey || feishu.mcp?.assigneeFieldKey || syncConfig?.sync?.assigneeFieldKey || "current_status_operator").trim(),
    requiredAssigneeKeywords: syncConfig?.sync?.assigneePrefilter === false ? [] : normalizeStringList(options.requiredAssigneeKeywords || options.scope?.requiredAssigneeKeywords || syncConfig?.sync?.requiredAssigneeKeywords),
    filters: normalizeMcpReadFilters(syncConfig, options),
    readScopeMatch: String(options.readScopeMatch || options.scope?.match || options.scope?.readScope?.match || syncConfig?.sync?.readScope?.match || "all").trim(),
    sourceView,
    sort: normalizeMcpSortRules(options.sort || options.scope?.sort || syncConfig?.sync?.sort),
    limit: clampLimit(options.limit || syncConfig?.sync?.batchSize, 20, 200),
  };
}

function mcpReadFieldKeys(fields = [], context = {}) {
  return uniq([
    ...DEFAULT_MCP_WORK_ITEM_FIELDS,
    ...normalizeStringList(fields),
    ...(isDefectMcpWorkItemType(context) ? DEFECT_DESCRIPTION_FIELD_KEYS : []),
  ].filter(Boolean));
}

function isDefectMcpWorkItemType(context = {}) {
  const text = [
    context.workItemTypeName,
    context.workItemApiName,
    context.workItemTypeKey,
    context.typeKey,
  ].map(stringValue).filter(Boolean).join(" ");
  return !!text && /bug|defect|\u7f3a\u9677|\u95ee\u9898/i.test(text);
}

function workItemTypeCandidates(syncConfig = {}, options = {}) {
  const feishu = syncConfig?.feishu || {};
  const resolved = options.resolvedContext || {};
  const configured = normalizeStringList([
    options.workItemTypeName,
    options.typeName,
    feishu.mcp?.workItemTypeName,
    feishu.mcp?.workItemTypeLabel,
  ]);
  const resolvedCandidates = Array.isArray(resolved.workItemTypeCandidates)
    ? resolved.workItemTypeCandidates.flatMap((item) => [item.name, item.label, item.typeName, item.apiName, item.typeKey])
    : [];
  return uniq([
    ...configured,
    resolved.workItemTypeName,
    resolved.workItemTypeLabel,
    ...resolvedCandidates,
  ].map(stringValue).filter(Boolean));
}

function isMcpWorkItemTypeLabelError(text = "") {
  return /work item type label|work_item_type.*label|type label.*not found/i.test(String(text || ""));
}

function isMcpAmbiguousUserLabelError(text = "") {
  return /user label\s*['"][^'"]+['"]\s*is not unique/i.test(String(text || ""));
}

function mcpAmbiguousUserLabel(text = "") {
  return String(text || "").match(/user label\s*['"]([^'"]+)['"]\s*is not unique/i)?.[1]?.trim() || "";
}

function friendlyMcpToolError(text = "", tool = {}, args = {}) {
  const raw = String(text || "").trim();
  if (isMcpAmbiguousUserLabelError(raw)) {
    const label = mcpAmbiguousUserLabel(raw);
    const mql = args?.mql ? ` Current MQL: ${args.mql}` : "";
    return `Feishu MCP could not uniquely resolve user label "${label}". Configure that person with a unique user_key (MQL form <id:user_key>) instead of a duplicate display name.${mql} Original error: ${raw}`;
  }
  if (!isMcpWorkItemTypeLabelError(raw)) return raw;
  const mql = args?.mql ? ` Current MQL: ${args.mql}` : "";
  return `Feishu MCP could not find the configured work item type label. Set feishu.mcp.workItemTypeName to the Feishu Project work item type display name/label (for example the Chinese type name shown in project settings), or configure feishu.mcp.mql explicitly.${mql} Original error: ${raw}`;
}

function friendlyMcpToolException(err, tool = {}, args = {}) {
  const message = friendlyMcpToolError(err?.message || String(err), tool, args);
  if (!message || message === err?.message) return err;
  const next = new Error(message);
  next.cause = err;
  next.code = err?.code;
  next.data = err?.data;
  return next;
}

function normalizeMcpWorkItemType(type = {}) {
  if (!type || typeof type !== "object") return {};
  const name = stringValue(type.name || type.type_name || type.work_item_type_name || type.display_name || type.label);
  const label = stringValue(type.label || type.name || type.type_name || type.display_name);
  const apiName = stringValue(type.api_name || type.apiName || type.work_item_type_api_name || type.key);
  const typeKey = stringValue(type.type_key || type.typeKey || type.work_item_type_key || type.id || type.key);
  return cleanObject({
    name,
    label,
    apiName,
    typeKey,
    raw: type,
  });
}

function matchesMcpWorkItemType(type = {}, expected = "") {
  const target = normalizeKey(expected);
  if (!target) return false;
  return [
    type.name,
    type.label,
    type.apiName,
    type.typeKey,
  ].some((value) => normalizeKey(value) === target);
}

async function resolveMcpProjectContext(client, tools = [], syncConfig = {}, options = {}) {
  const feishu = syncConfig?.feishu || {};
  const sourceProjectKey = String(options.projectKey || options.scope?.projectKey || feishu.spaceKey || "").trim();
  const sourceTypeKey = String(options.typeKey || options.scope?.typeKey || feishu.workItemTypeKey || "").trim();
  const context = {
    projectKey: sourceProjectKey,
    projectSimpleName: sourceProjectKey,
    workItemTypeKey: sourceTypeKey,
    workItemApiName: sourceTypeKey,
    workItemTypeName: String(sourceTypeKey || feishu.mcp?.workItemTypeName || "").trim(),
    workItemTypeCandidates: [],
  };
  if (!sourceProjectKey) return context;

  if (tools.some((tool) => tool.name === "search_project_info")) {
    const projectResult = await callMcpToolWithRetry(client, "search_project_info", { project_key: sourceProjectKey, page_num: 1 }, syncConfig?.feishu?.mcp || {}, options);
    const projects = extractPayloadsFromToolResult(projectResult).flatMap((payload) => {
      if (Array.isArray(payload?.projects)) return payload.projects;
      if (Array.isArray(payload?.list)) return payload.list;
      return [];
    });
    const project = projects.find((item) => item.simple_name === sourceProjectKey || item.project_key === sourceProjectKey)
      || projects[0];
    if (project?.project_key) context.projectKey = project.project_key;
    if (project?.simple_name) context.projectSimpleName = project.simple_name;
    if (project?.name) context.projectName = project.name;
  }

  if (tools.some((tool) => tool.name === "list_workitem_types")) {
    const typeResult = await callMcpToolWithRetry(client, "list_workitem_types", { project_key: context.projectKey || sourceProjectKey }, syncConfig?.feishu?.mcp || {}, options);
    const types = extractPayloadsFromToolResult(typeResult).flatMap((payload) => {
      if (Array.isArray(payload?.list)) return payload.list;
      if (Array.isArray(payload?.work_item_types)) return payload.work_item_types;
      if (Array.isArray(payload)) return payload;
      return [];
    });
    context.workItemTypeCandidates = types.map(normalizeMcpWorkItemType).filter((item) => item.name || item.label || item.apiName || item.typeKey);
    const matched = sourceTypeKey
      ? context.workItemTypeCandidates.find((item) => matchesMcpWorkItemType(item, sourceTypeKey))
      : null;
    if (matched) {
      const normalized = normalizeMcpWorkItemType(matched);
      if (normalized.typeKey) context.workItemTypeKey = normalized.typeKey;
      if (normalized.apiName) context.workItemApiName = normalized.apiName;
      if (normalized.label) context.workItemTypeLabel = normalized.label;
      if (normalized.name || normalized.label) context.workItemTypeName = normalized.name || normalized.label;
    } else if (sourceTypeKey) {
      // 指定了工单类型时禁止静默回退到 types[0]，否则多来源会把 bug_double_eight 错读成默认 bug。
      context.workItemTypeKey = sourceTypeKey;
      context.workItemApiName = sourceTypeKey;
      context.workItemTypeName = sourceTypeKey;
    } else if (context.workItemTypeCandidates[0]) {
      const normalized = context.workItemTypeCandidates[0];
      if (normalized.typeKey) context.workItemTypeKey = normalized.typeKey;
      if (normalized.apiName) context.workItemApiName = normalized.apiName;
      if (normalized.label) context.workItemTypeLabel = normalized.label;
      if (normalized.name || normalized.label) context.workItemTypeName = normalized.name || normalized.label;
    }
  }

  return context;
}

async function resolveMcpWorkItemFieldKeys(client, tools = [], syncConfig = {}, resolvedContext = {}, options = {}) {
  const configured = normalizeStringList(
    options.fieldKeys
      || syncConfig?.feishu?.mcp?.fieldKeys
      || syncConfig?.feishu?.mcp?.fields
      || syncConfig?.feishu?.fieldKeys,
  );
  if (configured.length) return uniq(configured);
  if (!tools.some((tool) => tool.name === "list_workitem_field_config")) return [];

  const feishu = syncConfig?.feishu || {};
  const projectKey = stringValue(resolvedContext.projectKey || feishu.spaceKey);
  const workItemType = stringValue(
    resolvedContext.workItemApiName
      || resolvedContext.workItemTypeKey
      || feishu.mcp?.workItemTypeName
      || feishu.workItemTypeKey,
  );
  if (!projectKey || !workItemType) return [];

  const cacheKey = `${projectKey}/${workItemType}`;
  const cached = fieldConfigCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < FIELD_CONFIG_CACHE_TTL_MS) return cached.keys;

  const keys = [];
  for (let page = 1; page <= 20; page += 1) {
    const result = await callMcpToolWithRetry(client, "list_workitem_field_config", cleanObject({
      project_key: projectKey,
      work_item_type: workItemType,
      page_num: page,
    }), syncConfig?.feishu?.mcp || {}, options);
    const payload = extractPayloadsFromToolResult(result).find((candidate) => Array.isArray(candidate?.list));
    const fields = payload?.list || [];
    for (const field of fields) {
      const key = stringValue(field.field_key || field.key);
      if (key) keys.push(key);
    }
    const pagination = payload?.pagination || {};
    if (!pagination.has_more) break;
  }

  const normalized = uniq(keys).slice(0, 500);
  fieldConfigCache.set(cacheKey, { ts: Date.now(), keys: normalized });
  return normalized;
}

async function listMcpConfigPages(client, toolName, baseArgs = {}, kind = "field") {
  const out = [];
  for (let page = 1; page <= 20; page += 1) {
    const result = await callMcpToolWithRetry(client, toolName, cleanObject({
      ...baseArgs,
      page_num: page,
    }));
    const payloads = extractPayloadsFromToolResult(result);
    const rows = payloads.flatMap((payload) => {
      if (Array.isArray(payload?.list)) return payload.list;
      if (Array.isArray(payload?.fields)) return payload.fields;
      if (Array.isArray(payload?.roles)) return payload.roles;
      if (Array.isArray(payload?.items)) return payload.items;
      if (Array.isArray(payload)) return payload;
      return [];
    });
    out.push(...rows.map((row) => kind === "role" ? normalizeMcpRoleConfig(row) : normalizeMcpFieldConfig(row)).filter((row) => row.key));
    const pagination = payloads.map((payload) => payload?.pagination).find(Boolean) || {};
    if (!pagination.has_more && !pagination.hasMore) break;
  }
  return uniqBy(out, (row) => row.key);
}

function normalizeMcpFieldConfig(field = {}) {
  const key = stringValue(field.field_key || field.fieldKey || field.key || field.id);
  const name = stringValue(field.field_name || field.fieldName || field.name || field.label || field.display_name || field.displayName) || key;
  return cleanObject({
    kind: "field",
    key,
    name,
    type: stringValue(field.field_type || field.fieldType || field.type || field.value_type || field.valueType),
    options: normalizeMcpOptions(field.option || field.options || field.enum_options || field.enumOptions || field.values),
  });
}

function normalizeMcpRoleConfig(role = {}) {
  const key = stringValue(role.role_id || role.roleId || role.key || role.id);
  const name = stringValue(role.role_name || role.roleName || role.name || role.label) || key;
  return cleanObject({
    kind: "role",
    key,
    name,
    type: "role",
    options: normalizeMcpOptions(role.option || role.options || role.users || role.members || role.values),
  });
}

function normalizeMcpOptions(options = []) {
  const list = Array.isArray(options) ? options : [];
  return list.map((option) => {
    if (option == null || option === "") return null;
    if (typeof option !== "object") {
      const text = stringValue(option);
      return text ? { value: text, label: text } : null;
    }
    const value = stringValue(option.option_id || option.optionId || option.user_key || option.userKey || option.key || option.id || option.value || option.name || option.option_name || option.optionName);
    const label = stringValue(option.option_name || option.optionName || option.name || option.display_name || option.displayName || option.label || option.value || value);
    if (!value && !label) return null;
    return {
      value: value || label,
      label: label || value,
    };
  }).filter(Boolean);
}

function buildDefaultMql(context = {}) {
  const q = "`";
  const assigneeFieldKey = stringValue(context.assigneeFieldKey || "current_status_operator");
  const filterFields = normalizeMcpReadFilters({ sync: { readScope: { filters: context.filters || [] } } })
    .map((filter) => mqlFieldForFilter(filter))
    .filter(Boolean);
  const fields = mcpReadFieldKeys([...filterFields, assigneeFieldKey], context);
  const project = context.spaceKey || context.sourceSpaceKey;
  const type = context.workItemTypeName || context.typeKey;
  const limit = clampLimit(context.limit, 20, 200);
  if (!project || !type) return "";
  const where = buildMqlWhere(context);
  const orderBy = buildMqlOrderBy(context);
  return `SELECT ${fields.map((field) => quoteMqlIdentifier(field)).join(", ")} FROM ${quoteMqlIdentifier(project)}.${quoteMqlIdentifier(type)}${where ? ` WHERE ${where}` : ""}${orderBy ? ` ORDER BY ${orderBy}` : ""} LIMIT ${limit}`;
}

function buildMqlWhere(context = {}) {
  const problemNoWhere = buildMqlProblemNoWhere(context);
  if (problemNoWhere) return problemNoWhere;
  const filterWhere = buildMqlReadScopeWhere(context);
  const assigneeWhere = filterWhere ? "" : buildMqlAssigneeWhere(context);
  return [filterWhere || assigneeWhere]
    .filter(Boolean)
    .map((condition, _index, conditions) => conditions.length > 1 ? `(${condition})` : condition)
    .join(" AND ");
}

function buildMqlProblemNoWhere(context = {}) {
  const problemNos = uniq(normalizeStringList(context.problemNos).map(normalizeProblemNo).filter(isProblemNoLike));
  if (!problemNos.length) return "";
  const autoNumbers = uniq(problemNos.map(autoNumberFromProblemNo).filter(Boolean));
  const nameField = quoteMqlIdentifier("name");
  const autoNumberField = quoteMqlIdentifier("auto_number");
  const conditions = [];
  if (autoNumbers.length === 1) conditions.push(`${autoNumberField} = ${quoteMqlString(autoNumbers[0])}`);
  else if (autoNumbers.length > 1) conditions.push(`${autoNumberField} IN (${autoNumbers.map(quoteMqlString).join(", ")})`);
  if (problemNos.length === 1) conditions.push(`${nameField} = ${quoteMqlString(problemNos[0])}`);
  else conditions.push(`${nameField} IN (${problemNos.map(quoteMqlString).join(", ")})`);
  return conditions.map((condition) => conditions.length > 1 ? `(${condition})` : condition).join(" OR ");
}

function buildMqlReadScopeWhere(context = {}) {
  const filters = normalizeMcpReadFilters({ sync: { readScope: { filters: context.filters || [] } } }).filter((filter) => filter.enabled !== false);
  if (!filters.length) return "";
  const conditions = filters.map((filter) => buildMqlFilterCondition(filter)).filter(Boolean);
  if (!conditions.length) return "";
  const joiner = String(context.readScopeMatch || "all").toLowerCase() === "any" ? " OR " : " AND ";
  return conditions.map((condition) => conditions.length > 1 ? `(${condition})` : condition).join(joiner);
}

function buildMqlFilterCondition(filter = {}) {
  const field = mqlFieldForFilter(filter);
  if (!field) return "";
  const operator = normalizeKey(filter.operator || "containsAny");
  const values = normalizeStringList(filter.values || filter.optionValues || filter.value);
  if (["exists", "notempty", "isnotempty"].includes(operator)) return `${quoteMqlIdentifier(field)} is not null`;
  if (["empty", "isempty"].includes(operator)) return `${quoteMqlIdentifier(field)} is null`;
  if (!values.length) return "";
  const valueExpr = values.map(quoteMqlString).join(", ");
  if (["notcontainsany", "notin", "notbelongs"].includes(operator)) {
    return `none_match(${quoteMqlIdentifier(field)}, x -> x in (${valueExpr}))`;
  }
  if (["equals", "eq", "is"].includes(operator)) return `${quoteMqlIdentifier(field)} = ${quoteMqlString(values[0])}`;
  return `any_match(${quoteMqlIdentifier(field)}, x -> x in (${valueExpr}))`;
}

function buildMqlAssigneeWhere(context = {}) {
  const fieldKey = stringValue(context.assigneeFieldKey || "current_status_operator");
  const keywords = normalizeStringList(context.requiredAssigneeKeywords);
  if (!fieldKey || !keywords.length) return "";
  return `${quoteMqlIdentifier(fieldKey)} IN (${keywords.map(quoteMqlString).join(", ")})`;
}

function buildMqlOrderBy(context = {}) {
  const sort = normalizeMcpSortRules(context.sort).filter((rule) => rule.enabled !== false);
  return sort.map((rule) => {
    const field = rule.fieldKey || rule.fieldName;
    if (!field) return "";
    return `${quoteMqlIdentifier(field)} ${rule.direction === "asc" ? "ASC" : "DESC"}`;
  }).filter(Boolean).join(", ");
}

function quoteMqlIdentifier(value) {
  return `\`${String(value || "").replace(/`/g, "``")}\``;
}

function mqlFieldForFilter(filter = {}) {
  const kind = normalizeKey(filter.kind);
  const name = stringValue(filter.fieldName || filter.name || filter.roleName);
  if (kind === "role" && name) return name.startsWith("__") ? name : `__${name}`;
  return stringValue(filter.fieldKey || filter.fieldName);
}

function quoteMqlString(value) {
  return `'${String(value || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function normalizeMcpReadFilters(syncConfig = {}, options = {}) {
  const scope = options.scope || {};
  const raw = Array.isArray(options.filters) ? options.filters
    : Array.isArray(scope.filters) ? scope.filters
    : Array.isArray(scope.readScope?.filters) ? scope.readScope.filters
    : syncConfig?.sync?.readScope?.enabled === false ? []
    : Array.isArray(syncConfig?.sync?.readScope?.filters) ? syncConfig.sync.readScope.filters
    : [];
  return raw.map((filter, index) => {
    if (!filter || typeof filter !== "object") return null;
    const fieldKey = stringValue(filter.fieldKey || filter.key || filter.roleId || "");
    const fieldName = stringValue(filter.fieldName || filter.name || filter.roleName || fieldKey);
    if (!fieldKey && !fieldName) return null;
    return {
      id: stringValue(filter.id) || `${fieldKey || fieldName}-${index}`,
      enabled: filter.enabled !== false,
      kind: stringValue(filter.kind || (fieldKey.startsWith("role_") ? "role" : "field")) || "field",
      fieldKey,
      fieldName,
      operator: stringValue(filter.operator || "containsAny"),
      values: normalizeStringList(filter.values || filter.optionValues || filter.value),
    };
  }).filter(Boolean);
}

function normalizeSourceView(syncConfig = {}, options = {}) {
  const scope = options.scope || {};
  const configured = syncConfig?.feishu?.sourceView && typeof syncConfig.feishu.sourceView === "object" ? syncConfig.feishu.sourceView : {};
  const scoped = scope.sourceView && typeof scope.sourceView === "object" ? scope.sourceView : {};
  const url = stringValue(options.sourceViewUrl || options.viewUrl || scoped.url || configured.url || options.url || syncConfig?.feishu?.web?.homepageUrl);
  const parsed = parseFeishuProjectViewUrl(url);
  return cleanObject({
    url,
    viewId: stringValue(options.sourceViewId || options.viewId || scoped.viewId || configured.viewId || parsed.viewId),
    scope: stringValue(scoped.scope || configured.scope || parsed.scope),
    node: stringValue(scoped.node || configured.node || parsed.node),
    sourceProjectKey: stringValue(options.projectKey || scope.projectKey || scoped.sourceProjectKey || parsed.sourceProjectKey || syncConfig?.feishu?.spaceKey),
    sourceWorkItemTypeKey: stringValue(options.typeKey || scope.typeKey || scoped.sourceWorkItemTypeKey || parsed.sourceWorkItemTypeKey || syncConfig?.feishu?.workItemTypeKey),
  });
}

function parseFeishuProjectViewUrl(url = "") {
  try {
    const parsed = new URL(String(url || ""));
    if (!/(^|\.)project\.feishu\.cn$/i.test(parsed.hostname)) return {};
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (normalizeKey(parts[1]) !== "workobjectview") return {};
    return {
      sourceProjectKey: parts[0] || "",
      sourceWorkItemTypeKey: parts[2] || "",
      viewId: parts[3] || "",
      scope: parsed.searchParams.get("scope") || "",
      node: parsed.searchParams.get("node") || "",
    };
  } catch {
    return {};
  }
}

function normalizeMcpSortRules(sort = []) {
  const list = Array.isArray(sort) ? sort : (sort && typeof sort === "object" ? [sort] : []);
  return list.map((rule, index) => {
    if (!rule || typeof rule !== "object") return null;
    const fieldKey = stringValue(rule.fieldKey || rule.key || rule.field || rule.column || "");
    const fieldName = stringValue(rule.fieldName || rule.name || rule.label || fieldKey);
    const directionRaw = stringValue(rule.direction || rule.order || rule.sort || "desc").toLowerCase();
    const direction = ["asc", "ascending", "1"].includes(directionRaw) ? "asc" : "desc";
    if (!fieldKey && !fieldName) return null;
    return {
      id: stringValue(rule.id) || `${fieldKey || fieldName}-${index}`,
      enabled: rule.enabled !== false,
      fieldKey,
      fieldName,
      direction,
    };
  }).filter(Boolean);
}

function sortArgumentForSchema(sort = [], schema = {}) {
  const rules = normalizeMcpSortRules(sort).filter((rule) => rule.enabled !== false);
  if (!rules.length) return undefined;
  const type = String(schema.type || "").toLowerCase();
  if (type === "string") {
    return rules.map((rule) => `${rule.fieldKey || rule.fieldName} ${rule.direction}`).join(", ");
  }
  return rules.map((rule) => ({
    field_key: rule.fieldKey || rule.fieldName,
    fieldKey: rule.fieldKey || rule.fieldName,
    field_name: rule.fieldName || rule.fieldKey,
    fieldName: rule.fieldName || rule.fieldKey,
    direction: rule.direction,
    order: rule.direction,
  }));
}

function enumMatch(values, value) {
  if (!value) return undefined;
  const hit = values.find((candidate) => normalizeKey(candidate) === normalizeKey(value));
  return hit || undefined;
}

function extractPayloadsFromToolResult(result) {
  const payloads = [];
  collect(result);
  return payloads.length ? payloads : [result];

  function collect(value) {
    if (value == null || value === "") return;
    if (Array.isArray(value)) {
      for (const item of value) collect(item);
      return;
    }
    if (typeof value === "string") {
      payloads.push(...parseJsonCandidates(value));
      return;
    }
    if (typeof value !== "object") return;
    if (value.type === "text" && typeof value.text === "string") {
      payloads.push(...parseJsonCandidates(value.text));
      return;
    }
    if (value.type === "resource" && value.resource) {
      collect(value.resource.text || value.resource.blob || value.resource);
      return;
    }
    if (value.structuredContent) collect(value.structuredContent);
    if (value.content) collect(value.content);
    if (value.json) collect(value.json);
    if (value.data) collect(value.data);
    if (value.result) collect(value.result);
    if (value.items) collect(value.items);
    payloads.push(value);
  }
}

function extractMqlWorkItems(payload, syncConfig = {}, resolvedContext = {}) {
  const groups = payload?.data && typeof payload.data === "object" ? Object.values(payload.data) : [];
  const rows = groups.flatMap((group) => Array.isArray(group) ? group : []);
  if (!rows.length) return [];
  const feishu = syncConfig?.feishu || {};
  return rows.map((row) => {
    const fields = Array.isArray(row?.moql_field_list) ? row.moql_field_list : [];
    const out = {
      fields: [],
      space_key: feishu.spaceKey || resolvedContext.projectSimpleName || resolvedContext.projectKey,
      work_item_type_key: feishu.workItemTypeKey || resolvedContext.workItemApiName || resolvedContext.workItemTypeKey,
      _mcpResolvedProjectKey: resolvedContext.projectKey,
      _mcpResolvedWorkItemTypeKey: resolvedContext.workItemTypeKey,
      _mcpResolvedWorkItemTypeName: resolvedContext.workItemTypeName,
      raw: row,
    };
    for (const field of fields) {
      const value = normalizeMqlFieldValue(field);
      const key = field.key || "";
      const name = field.name || key;
      if (key) out[key] = value;
      if (name && !out[name]) out[name] = value;
      out.fields.push({
        field_key: key,
        field_name: name,
        value,
        display_value: displayMqlValue(value),
        field_type: field.value_type || "",
        raw: field,
      });
    }
    const id = stringValue(out.work_item_id || out["工作项id"] || out.id);
    const title = displayMqlValue(out.name || out["名称"] || out["问题编号"] || id);
    if (id) {
      out.id = id;
      out.work_item_id = id;
      out.source_url = renderSourceUrl(feishu, out.space_key, out.work_item_type_key, id);
    }
    out.title = title || id || "(untitled)";
    out.work_item_name = out.title;
    return out;
  }).filter((item) => item.work_item_id || item.id);
}

function normalizeMqlFieldValue(field = {}) {
  const value = field.value || {};
  if (Object.prototype.hasOwnProperty.call(value, "string_value")) return value.string_value;
  if (Object.prototype.hasOwnProperty.call(value, "long_value")) return value.long_value;
  if (Object.prototype.hasOwnProperty.call(value, "double_value")) return value.double_value;
  if (Object.prototype.hasOwnProperty.call(value, "bool_value")) return value.bool_value;
  if (value.user_value) return normalizeMqlUser(value.user_value);
  if (Array.isArray(value.user_value_list)) return value.user_value_list.map(normalizeMqlUser);
  if (value.key_label_value) return value.key_label_value;
  if (Array.isArray(value.key_label_value_list)) return value.key_label_value_list;
  if (Array.isArray(value.string_value_list)) return value.string_value_list;
  if (Array.isArray(value.long_value_list)) return value.long_value_list;
  if (Object.keys(value).length) return value;
  return "";
}

function normalizeMqlUser(user = {}) {
  if (!user || typeof user !== "object") return user;
  const name = stringValue(user.name || user.name_cn || user.name_en || user.display_name || user.label);
  return cleanObject({
    ...user,
    userKey: user.user_key || user.userKey,
    name,
  });
}

function displayMqlValue(value) {
  if (value == null || value === "") return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(displayMqlValue).filter(Boolean).join(", ");
  if (typeof value === "object") return value.label || value.name || value.name_cn || value.name_en || value.value || value.key || value.user_key || JSON.stringify(value);
  return String(value);
}

function renderSourceUrl(feishu = {}, spaceKey = "", typeKey = "", id = "") {
  const template = feishu.sourceUrlTemplate || "{baseUrl}/{spaceKey}/{workItemTypeKey}/detail/{workItemId}";
  const vars = {
    ...feishu,
    baseUrl: feishu.baseUrl || "https://project.feishu.cn",
    spaceKey,
    workItemTypeKey: typeKey,
    workItemId: id,
  };
  return template.replace(/\{([^}]+)\}/g, (_, key) => String(vars[key] ?? ""));
}

function fileNameFromUrl(url) {
  try {
    const pathname = new URL(String(url || "")).pathname;
    return decodeURIComponent(pathname.split("/").filter(Boolean).pop() || "");
  } catch {
    return "";
  }
}

function isFeishuProjectFileUrl(url) {
  try {
    const parsed = new URL(String(url || ""));
    return /(^|\.)project\.feishu\.cn$/i.test(parsed.hostname)
      && (/\/file\//i.test(parsed.pathname) || /\/tos\/file\//i.test(parsed.pathname));
  } catch {
    return false;
  }
}

async function hydrateMcpWorkItems(client, items = [], syncConfig = {}, resolvedContext = {}, options = {}) {
  const hydrated = [];
  for (const item of items.slice(0, options.limit || items.length)) {
    const id = stringValue(item.work_item_id || item.id);
    if (!id) {
      hydrated.push(item);
      continue;
    }
    let pageToken = "";
    let payload = null;
    const allFields = [];
    for (let page = 0; page < (options.maxPages || 5); page += 1) {
      const result = await callMcpToolWithRetry(client, "get_workitem_brief", cleanObject({
        project_key: resolvedContext.projectKey || item._mcpResolvedProjectKey || syncConfig?.feishu?.spaceKey,
        work_item_id: id,
        fields: options.fieldKeys?.length ? options.fieldKeys : ["_all"],
        page_size: 200,
        page_token: pageToken,
      }), syncConfig?.feishu?.mcp || {}, options);
      const pagePayload = extractPayloadsFromToolResult(result).find((candidate) => candidate?.work_item_attribute || candidate?.work_item_fields);
      if (!pagePayload) break;
      payload = payload ? mergeBriefPayload(payload, pagePayload) : pagePayload;
      if (Array.isArray(pagePayload.work_item_fields)) allFields.push(...pagePayload.work_item_fields);
      const pagination = pagePayload.pagination || {};
      if (!pagination.has_more || !pagination.next_page_token) break;
      pageToken = pagination.next_page_token;
    }
    if (!payload) {
      hydrated.push(item);
      continue;
    }
    payload.work_item_fields = allFields.length ? allFields : payload.work_item_fields;
    hydrated.push(normalizeBriefWorkItemPayload(payload, item, syncConfig, resolvedContext));
  }
  return hydrated;
}

async function hydrateMcpAttachments(client, tools = [], items = [], syncConfig = {}, resolvedContext = {}, options = {}) {
  const canListComments = tools.some((tool) => tool.name === "list_workitem_comments");
  const canReadRelatedWorkItems = tools.some((tool) => tool.name === "get_workitem_brief");
  const canSignDownload = tools.some((tool) => tool.name === "get_download_url");
  const hydrated = [];
  for (const item of items.slice(0, options.limit || items.length)) {
    const id = stringValue(item.work_item_id || item.id);
    if (!id) {
      hydrated.push(item);
      continue;
    }
    const comments = canListComments
      ? await listMcpWorkItemComments(client, item, syncConfig, resolvedContext, options)
      : [];
    const related = canReadRelatedWorkItems
      ? await listMcpRelatedVehicleAttachments(client, item, syncConfig, resolvedContext, options)
      : { attachments: [], warnings: [] };
    let attachments = mergeMcpAttachments(
      item.attachments || [],
      extractMcpWorkItemFieldAttachments(item),
      comments.flatMap((comment) => extractMcpCommentAttachments(comment, item)),
      related.attachments,
    );
    if (canSignDownload && attachments.length) {
      const signed = [];
      for (const attachment of attachments) {
        signed.push(await signMcpAttachmentDownload(client, attachment, item, syncConfig, resolvedContext));
      }
      attachments = signed;
    }
    hydrated.push({
      ...item,
      attachments,
      ...(related.warnings.length ? { _attachmentHydrationWarnings: related.warnings } : {}),
    });
  }
  return hydrated;
}

async function listMcpRelatedVehicleAttachments(client, item = {}, syncConfig = {}, resolvedContext = {}, options = {}) {
  const refs = relatedVehicleWorkItemRefs(item).slice(0, clampLimit(options.relatedVehicleLimit, 5, 20));
  if (!refs.length) return { attachments: [], warnings: [] };

  const projectKey = stringValue(item.space_key || syncConfig?.feishu?.spaceKey || resolvedContext.projectKey || item._mcpResolvedProjectKey);
  const attachments = [];
  const warnings = [];
  for (const ref of refs) {
    try {
      let payload = null;
      const allFields = [];
      let pageToken = "";
      for (let page = 0; page < (options.maxPages || 5); page += 1) {
        const result = await callMcpToolWithRetry(client, "get_workitem_brief", cleanObject({
          url: syncConfig?.feishu?.sourceView?.url || syncConfig?.feishu?.web?.homepageUrl,
          project_key: projectKey,
          work_item_id: ref.id,
          fields: mcpReadFieldKeys(["_all"], resolvedContext),
          page_size: 200,
          page_token: pageToken,
        }), syncConfig?.feishu?.mcp || {}, options);
        if (result?.isError) throw new Error(toolResultText(result) || "Feishu MCP get_workitem_brief returned an error");
        const pagePayload = extractPayloadsFromToolResult(result).find((candidate) => candidate?.work_item_attribute || candidate?.work_item_fields);
        if (!pagePayload) break;
        payload = payload ? mergeBriefPayload(payload, pagePayload) : pagePayload;
        if (Array.isArray(pagePayload.work_item_fields)) allFields.push(...pagePayload.work_item_fields);
        const pagination = pagePayload.pagination || {};
        if (!pagination.has_more || !pagination.next_page_token) break;
        pageToken = pagination.next_page_token;
      }
      if (!payload) continue;
      payload.work_item_fields = allFields.length ? allFields : payload.work_item_fields;
      const relatedItem = normalizeBriefWorkItemPayload(payload, {
        id: ref.id,
        work_item_id: ref.id,
        title: ref.name || ref.id,
        _mcpResolvedProjectKey: projectKey,
      }, syncConfig, resolvedContext);
      const ownedProject = payload.work_item_attribute?.owned_project || payload.work_item_attribute?.ownedProject || {};
      const sourceProjectKey = stringValue(ownedProject.simple_name || ownedProject.simpleName || ownedProject.key || projectKey);
      attachments.push(...extractMcpWorkItemFieldAttachments({
        ...relatedItem,
        space_key: sourceProjectKey,
        sourceProjectKey,
        _mcpResolvedProjectKey: stringValue(ownedProject.key || sourceProjectKey),
      }));
    } catch (err) {
      warnings.push(`Related vehicle attachment read failed for ${ref.name || ref.id}: ${err?.message || String(err)}`);
    }
  }
  return { attachments: mergeMcpAttachments(attachments), warnings };
}

function relatedVehicleWorkItemRefs(item = {}) {
  const refs = [];
  const fields = Array.isArray(item.fields) ? item.fields : [];
  for (const field of fields) {
    if (!isVehicleDefectRelationField(field)) continue;
    refs.push(...workItemRefsFromRelationValue(field.value));
  }
  for (const [key, value] of Object.entries(item)) {
    if (!VEHICLE_DEFECT_RELATION_FIELD_KEYS.has(normalizeKey(key))) continue;
    refs.push(...workItemRefsFromRelationValue(value));
  }
  const currentId = stringValue(item.work_item_id || item.id);
  const seen = new Set();
  return refs.filter((ref) => {
    if (!ref.id || ref.id === currentId || seen.has(ref.id)) return false;
    seen.add(ref.id);
    return true;
  });
}

function isVehicleDefectRelationField(field = {}) {
  const keys = [field.key, field.field_key].map(normalizeKey).filter(Boolean);
  if (keys.some((key) => VEHICLE_DEFECT_RELATION_FIELD_KEYS.has(key))) return true;
  const name = stringValue(field.name || field.field_name);
  return /\u5173\u8054.*\u6574\u8f66.*\u7f3a\u9677|\u6574\u8f66.*\u7f3a\u9677.*\u5173\u8054/.test(name);
}

function workItemRefsFromRelationValue(value) {
  const out = [];
  const visit = (node, depth = 0) => {
    if (depth > 4 || node == null) return;
    if (Array.isArray(node)) {
      node.forEach((child) => visit(child, depth + 1));
      return;
    }
    if (typeof node !== "object") return;
    const id = stringValue(node.work_item_id || node.workItemId || node.id);
    if (id) {
      out.push({ id, name: stringValue(node.name || node.title || node.work_item_name || node.workItemName) });
      return;
    }
    for (const key of ["value", "values", "items", "list", "records", "work_items", "workItems"]) {
      if (node[key] != null) visit(node[key], depth + 1);
    }
  };
  visit(value);
  return out;
}

async function listMcpWorkItemComments(client, item = {}, syncConfig = {}, resolvedContext = {}, options = {}) {
  const comments = [];
  const workItemId = stringValue(item.work_item_id || item.id);
  const projectKey = stringValue(resolvedContext.projectKey || item._mcpResolvedProjectKey || syncConfig?.feishu?.spaceKey || item.space_key);
  for (let page = 1; page <= (options.maxPages || 5); page += 1) {
    const result = await callMcpToolWithRetry(client, "list_workitem_comments", cleanObject({
      project_key: projectKey,
      work_item_id: workItemId,
      page_num: page,
    }), syncConfig?.feishu?.mcp || {}, options);
    const payload = extractPayloadsFromToolResult(result).find((candidate) => Array.isArray(candidate?.comments) || Array.isArray(candidate?.list));
    const pageComments = payload?.comments || payload?.list || [];
    comments.push(...pageComments);
    const pagination = payload?.pagination || {};
    const totalPages = Number(payload?.total_page || payload?.totalPages || pagination.total_page || pagination.totalPages || 0);
    if (pagination.has_more === false || (totalPages && page >= totalPages) || !pageComments.length) break;
    if (pagination.has_more !== true && !totalPages) break;
  }
  return comments;
}

function extractMcpCommentAttachments(comment = {}, item = {}) {
  const rawContent = comment.content || comment.text || comment.body || comment.comment || comment.rich_text || "";
  const content = stringValue(rawContent) || displayMqlValue(rawContent);
  const sourceCommentId = stringValue(comment.comment_id || comment.id || comment.uuid);
  const defaults = {
    sourceCommentId,
    sourceWorkItemId: stringValue(item.work_item_id || item.id),
    sourceProjectKey: stringValue(item.space_key || item._mcpResolvedProjectKey),
  };
  const found = attachmentValuesFromContainer(comment)
    .map((attachment, index) => normalizeMcpAttachment(attachment, defaults, `comment-${sourceCommentId || "unknown"}-${index + 1}`))
    .filter(Boolean);
  const add = (url, marker = "", title = "") => {
    const normalized = normalizeMcpAttachment({ url, marker, name: title || marker }, defaults, `${sourceCommentId || "comment"}-${found.length + 1}`);
    if (!normalized) return;
    if (found.some((entry) => mcpAttachmentKey(entry) === mcpAttachmentKey(normalized))) return;
    found.push(normalized);
  };

  if (content) {
    for (const match of content.matchAll(/!\[[^\]]*]\((https?:\/\/[^)\s]+)\)\s*(?:<!--\s*([^>]+?)\s*-->)?/g)) {
      add(match[1], stringValue(match[2]));
    }
    for (const match of content.matchAll(/\[([^\]]+)]\((https?:\/\/[^)\s]+)\)/g)) {
      add(match[2], "", stringValue(match[1]));
    }
  }
  return found;
}

function extractMcpWorkItemFieldAttachments(item = {}) {
  const values = [];
  for (const field of item.fields || []) {
    if (!isMcpAttachmentField(field)) continue;
    values.push(...attachmentValues(field.value));
  }
  for (const key of ["field_2cb6f7", "attachments", "attachment_list", "attachmentList", "files", "file_list", "fileList"]) {
    values.push(...attachmentValues(item[key]));
  }
  const defaults = {
    sourceWorkItemId: stringValue(item.work_item_id || item.id),
    sourceProjectKey: stringValue(item.space_key || item._mcpResolvedProjectKey),
  };
  return values
    .map((attachment, index) => normalizeMcpAttachment(attachment, defaults, `work-item-${defaults.sourceWorkItemId || "unknown"}-${index + 1}`))
    .filter(Boolean);
}

function isMcpAttachmentField(field = {}) {
  const keys = [field.key, field.field_key, field.name, field.field_name, field.type, field.field_type]
    .map(normalizeKey)
    .filter(Boolean);
  return keys.some((key) => [
    "field2cb6f7",
    "attachment",
    "attachments",
    "attachmentlist",
    "file",
    "files",
    "filelist",
    "附件",
  ].includes(key));
}

function attachmentValuesFromContainer(container = {}) {
  const out = [];
  for (const key of ["attachments", "attachment_list", "attachmentList", "files", "file_list", "fileList"]) {
    out.push(...attachmentValues(container?.[key]));
  }
  return out;
}

function attachmentValues(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  for (const key of ["attachments", "items", "list", "records", "files", "file_list", "fileList", "attachment_list", "attachmentList"]) {
    if (Array.isArray(value[key])) return value[key];
  }
  return hasMcpAttachmentUrl(value) ? [value] : [];
}

function normalizeMcpAttachment(raw = {}, defaults = {}, fallbackId = "") {
  const source = raw && typeof raw === "object" ? raw : { name: raw };
  const sourceUrlCandidate = stringValue(source.sourceUrl || source.source_url || source.originalUrl || source.original_url || source.fileUrl || source.file_url || source.url);
  const downloadUrlCandidate = stringValue(source.downloadUrl || source.download_url || source.url || source.fileUrl || source.file_url);
  const sourceUrl = isFeishuProjectFileUrl(sourceUrlCandidate)
    ? sourceUrlCandidate.split("#")[0]
    : (isFeishuProjectFileUrl(downloadUrlCandidate) ? downloadUrlCandidate.split("#")[0] : "");
  if (!sourceUrl) return null;
  const marker = stringValue(source.marker || source.uid || source.uuid || source.imageId || source.image_id || source.fileToken || source.file_token);
  const id = stringValue(source.id || source.file_id || source.fileId || source.attachment_id || source.attachmentId || source.uid || source.uuid || source.fileToken || source.file_token || source.token || marker || fallbackId);
  const fileName = stringValue(source.fileName || source.file_name || source.filename || source.name || source.title) || fileNameFromUrl(sourceUrl) || id;
  const downloadHeaders = source.downloadHeaders || source.download_headers;
  return cleanObject({
    id,
    file_id: id,
    fileName,
    name: fileName,
    fileSize: Number(source.fileSize || source.file_size || source.size || source.size_bytes || source.sizeBytes || 0),
    mimeType: stringValue(source.mimeType || source.mime_type || source.contentType || source.content_type || source.type),
    url: downloadUrlCandidate || sourceUrl,
    sourceUrl,
    originalUrl: sourceUrl,
    sourceCommentId: stringValue(source.sourceCommentId || source.source_comment_id || source.commentId || source.comment_id || defaults.sourceCommentId),
    marker,
    sourceWorkItemId: stringValue(source.sourceWorkItemId || source.source_work_item_id || defaults.sourceWorkItemId),
    sourceProjectKey: stringValue(source.sourceProjectKey || source.source_project_key || defaults.sourceProjectKey),
    downloadHeaders: downloadHeaders && typeof downloadHeaders === "object" && !Array.isArray(downloadHeaders) ? downloadHeaders : undefined,
    isMultipart: source.isMultipart ?? source.is_multipart,
    multipart: source.multipart && typeof source.multipart === "object" ? source.multipart : undefined,
  });
}

function hasMcpAttachmentUrl(value = {}) {
  return [value.sourceUrl, value.source_url, value.originalUrl, value.original_url, value.downloadUrl, value.download_url, value.fileUrl, value.file_url, value.url]
    .some((url) => isFeishuProjectFileUrl(url));
}

function mcpAttachmentKey(attachment = {}) {
  return stringValue(attachment.id || attachment.file_id || attachment.sourceUrl || attachment.originalUrl || attachment.url);
}

async function signMcpAttachmentDownload(client, attachment = {}, item = {}, syncConfig = {}, resolvedContext = {}, options = {}) {
  const projectKey = stringValue(attachment.sourceProjectKey || attachment.source_project_key || resolvedContext.projectKey || item._mcpResolvedProjectKey || syncConfig?.feishu?.spaceKey || item.space_key);
  const workItemId = stringValue(attachment.sourceWorkItemId || attachment.source_work_item_id || item.work_item_id || item.id);
  const originalUrl = attachment.sourceUrl || attachment.originalUrl || attachment.url;
  if (!projectKey || !workItemId || !originalUrl) return attachment;
  let lastError = null;
  const fileUrls = [...new Set([
    withoutFeishuProjectDownloadFlag(originalUrl),
    withFeishuProjectDownloadFlag(originalUrl),
  ].filter(Boolean))];
  for (const fileUrl of fileUrls) {
    try {
      const result = await callMcpToolWithRetry(client, "get_download_url", {
        project_key: projectKey,
        work_item_id: workItemId,
        file_url: fileUrl,
      }, syncConfig?.feishu?.mcp || {});
      if (result?.isError) throw new Error(toolResultText(result) || "Feishu MCP get_download_url returned an error");
      const payload = extractPayloadsFromToolResult(result).find((candidate) => candidate?.download_url || candidate?.downloadUrl);
      const downloadUrl = stringValue(payload?.download_url || payload?.downloadUrl);
      const sign = stringValue(payload?.sign);
      if (!downloadUrl) throw new Error("Feishu MCP get_download_url returned no download URL");
      return cleanObject({
        ...attachment,
        url: downloadUrl,
        sourceUrl: originalUrl,
        downloadHeaders: sign ? { "X-Meego-File-Sign": sign } : {},
        downloadExpiresAt: payload?.sign_expire_time || payload?.signExpireTime || "",
        isMultipart: payload?.is_multipart,
        multipart: payload?.multipart && typeof payload.multipart === "object" ? payload.multipart : undefined,
      });
    } catch (err) {
      lastError = err;
    }
  }
  if (options.throwOnError) throw lastError || new Error("Feishu MCP get_download_url failed");
  return attachment;
}

function withoutFeishuProjectDownloadFlag(url) {
  try {
    const parsed = new URL(String(url || ""));
    if (!/(^|\.)project\.feishu\.cn$/i.test(parsed.hostname)) return String(url || "");
    parsed.searchParams.delete("dflag");
    return parsed.toString();
  } catch {
    return String(url || "");
  }
}

function withFeishuProjectDownloadFlag(url) {
  try {
    const parsed = new URL(String(url || ""));
    if (!/(^|\.)project\.feishu\.cn$/i.test(parsed.hostname)) return String(url || "");
    if (!/\/goapi\/v5\/platform\/file\/stream\/download\//i.test(parsed.pathname)) return String(url || "");
    parsed.searchParams.set("dflag", "t");
    return parsed.toString();
  } catch {
    return String(url || "");
  }
}

function mergeMcpAttachments(...groups) {
  const out = [];
  const seen = new Set();
  for (const attachment of groups.flat()) {
    const key = mcpAttachmentKey(attachment);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(attachment);
  }
  return out;
}

function mergeBriefPayload(base = {}, page = {}) {
  return {
    ...base,
    ...page,
    work_item_attribute: { ...(base.work_item_attribute || {}), ...(page.work_item_attribute || {}) },
    work_item_fields: [
      ...(base.work_item_fields || []),
      ...(page.work_item_fields || []),
    ],
  };
}

function normalizeBriefWorkItemPayload(payload = {}, fallback = {}, syncConfig = {}, resolvedContext = {}) {
  const feishu = syncConfig?.feishu || {};
  const attr = payload.work_item_attribute || {};
  const ownedProject = attr.owned_project || {};
  const workItemType = attr.work_item_type || {};
  const id = stringValue(attr.work_item_id || fallback.work_item_id || fallback.id);
  const spaceKey = feishu.spaceKey || ownedProject.simple_name || ownedProject.key || resolvedContext.projectSimpleName || resolvedContext.projectKey;
  const typeKey = feishu.workItemTypeKey || resolvedContext.workItemApiName || workItemType.key || resolvedContext.workItemTypeKey;
  const out = {
    ...fallback,
    id,
    work_item_id: id,
    title: attr.work_item_name || fallback.title || id,
    name: attr.work_item_name || fallback.name || id,
    work_item_name: attr.work_item_name || fallback.work_item_name || id,
    space_key: spaceKey,
    work_item_type_key: typeKey,
    source_url: renderSourceUrl(feishu, spaceKey, typeKey, id),
    created_at: attr.create_time || fallback.created_at,
    updated_at: attr.update_time || fallback.updated_at,
    creator: attr.create_by || fallback.creator,
    reporter: attr.create_by || fallback.reporter,
    status: attr.work_item_status || fallback.status,
    raw: payload,
    fields: Array.isArray(fallback.fields) ? [...fallback.fields] : [],
  };
  for (const role of attr.role_members || attr.roleMembers || []) {
    const key = role.key || role.role_key || role.roleKey || "";
    const name = role.name || role.role_name || role.roleName || key;
    const value = Array.isArray(role.members) ? role.members : [];
    if (key) out[key] = value;
    if (name) out[name] = value;
    const normalized = {
      field_key: key,
      field_name: name,
      value,
      display_value: displayMqlValue(value),
      field_type: "role",
      raw: role,
    };
    const existingIndex = out.fields.findIndex((existing) => key
      ? existing.field_key === key
      : name && existing.field_name === name);
    if (existingIndex >= 0) out.fields[existingIndex] = { ...out.fields[existingIndex], ...normalized };
    else out.fields.push(normalized);
  }
  for (const field of payload.work_item_fields || []) {
    const key = field.key || "";
    const name = field.name || key;
    const value = field.value;
    if (key) out[key] = value;
    if (name && !out[name]) out[name] = value;
    const normalized = {
      field_key: key,
      field_name: name,
      value,
      display_value: displayMqlValue(value),
      raw: field,
    };
    if (!out.fields.some((existing) => existing.field_key === normalized.field_key || existing.field_name === normalized.field_name)) {
      out.fields.push(normalized);
    }
  }
  return out;
}

function parseJsonCandidates(text) {
  const raw = String(text || "").trim();
  if (!raw) return [];
  const direct = parseJsonText(raw);
  if (direct) return [direct];

  const candidates = [];
  const fenced = [...raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1].trim());
  for (const part of fenced) {
    const parsed = parseJsonText(part);
    if (parsed) candidates.push(parsed);
  }
  if (candidates.length) return candidates;

  for (const [startChar, endChar] of [["{", "}"], ["[", "]"]]) {
    const start = raw.indexOf(startChar);
    const end = raw.lastIndexOf(endChar);
    if (start >= 0 && end > start) {
      const parsed = parseJsonText(raw.slice(start, end + 1));
      if (parsed) return [parsed];
    }
  }
  return [{ text: raw }];
}

function toolResultText(result) {
  const texts = [];
  for (const entry of result?.content || []) {
    if (entry?.type === "text" && entry.text) texts.push(entry.text);
  }
  return texts.join("\n").trim();
}

function summarizeTools(tools = []) {
  return tools.slice(0, 50).map(summarizeTool);
}

function summarizeTool(tool = {}) {
  const props = tool.inputSchema?.properties || tool.input_schema?.properties || tool.schema?.properties || {};
  return cleanObject({
    name: tool.name || "",
    title: tool.title || "",
    description: clip(tool.description || "", 240),
    inputProperties: Object.keys(props).slice(0, 50),
  });
}

function isAuthorizationError(err) {
  return !!(err?.needsAuthorization || err?.status === 401 || err?.status === 403 || (err?.status >= 300 && err?.status < 400));
}

function authorizationUrlFromError(err) {
  if (err?.location) return err.location;
  const source = `${err?.wwwAuthenticate || ""}\n${err?.body || ""}`;
  const named = source.match(/(?:authorization_uri|authorization_url|resource_metadata|resource_metadata_url|uri)="([^"]+)"/i);
  if (named) return named[1];
  const url = source.match(/https?:\/\/[^\s"',)]+/i);
  return url ? url[0] : "";
}

function cleanObject(obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj || {})) {
    if (value == null || value === "" || (Array.isArray(value) && !value.length)) continue;
    out[key] = value;
  }
  return out;
}

function normalizeKey(value) {
  return String(value || "").trim().toLowerCase().replace(/[\s_.-]+/g, "");
}

function stringValue(value) {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") return String(value);
  return "";
}

function normalizeStringList(value) {
  if (Array.isArray(value)) return value.map((entry) => stringValue(entry)).filter(Boolean);
  if (value == null || value === "") return [];
  return String(value).split(/[\n,;]+/).map((entry) => entry.trim()).filter(Boolean);
}

function uniq(list = []) {
  return [...new Set(list)];
}

function uniqBy(list = [], keyFn = (item) => item) {
  const seen = new Set();
  const out = [];
  for (const item of list || []) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function clampLimit(value, fallback = 20, max = 1000) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

function clampMs(value, fallback = 0, max = 60000) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(Math.floor(n), max);
}

function clip(value, max = 500) {
  const text = String(value || "");
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}

function sleep(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, n));
}
