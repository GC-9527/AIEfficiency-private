export const DEFAULT_FEISHU_EXTRACTOR_CONFIG = {
  baseUrl: "https://project.feishu.cn",
  pluginId: "",
  pluginSecret: "",
  userKey: "",
  spaceKey: "intelligentspace",
  workItemTypeKey: "bug",
  sourceUrlTemplate: "{baseUrl}/{spaceKey}/{workItemTypeKey}/detail/{workItemId}",
  tokenPath: "/open_api/authen/plugin_token",
  searchPathTemplate: "/open_api/{spaceKey}/work_item/{workItemTypeKey}/search",
  detailPathTemplate: "/open_api/{spaceKey}/work_item/{workItemTypeKey}/{workItemId}",
  fieldMetadataPathTemplate: "",
  fieldsPathTemplate: "",
  commentsPathTemplate: "",
  attachmentsPathTemplate: "",
  tokenHeaderName: "Authorization",
  tokenHeaderPrefix: "Bearer ",
  userKeyHeaderName: "X-USER-KEY",
  requestTimeoutMs: 30000,
  pageSize: 50,
  maxPages: 1000,
  retry: {
    attempts: 4,
    baseDelayMs: 400,
    maxDelayMs: 5000,
    statusCodes: [408, 409, 425, 429, 500, 502, 503, 504],
    apiCodes: [429, 500, 502, 503, 504],
  },
  rateLimit: {
    requestsPerSecond: 3,
    minIntervalMs: 0,
  },
};

export class FeishuProjectRateLimiter {
  constructor(config = {}) {
    const requestsPerSecond = Number(config.requestsPerSecond || 0);
    const minIntervalMs = Number(config.minIntervalMs || 0);
    this.intervalMs = Math.max(minIntervalMs, requestsPerSecond > 0 ? Math.ceil(1000 / requestsPerSecond) : 0);
    this.nextAt = 0;
  }

  async wait() {
    if (!this.intervalMs) return;
    const now = Date.now();
    const waitMs = Math.max(0, this.nextAt - now);
    this.nextAt = Math.max(now, this.nextAt) + this.intervalMs;
    if (waitMs > 0) await sleep(waitMs);
  }
}

export class FeishuProjectExtractor {
  constructor(config = {}, options = {}) {
    this.config = normalizeFeishuExtractorConfig(config);
    this.fetchImpl = options.fetchImpl || globalThis.fetch?.bind(globalThis);
    this.rateLimiter = options.rateLimiter || new FeishuProjectRateLimiter(this.config.rateLimit);
    this.fieldMetadataProvider = options.fieldMetadataProvider || null;
    this.onFieldMetadata = options.onFieldMetadata || null;
    this.tokenCache = { token: "", expiresAt: 0, pending: null };
    this.fieldMetadataCache = new Map();
  }

  isReady() {
    const f = this.config;
    return !!(f.baseUrl && f.pluginId && f.pluginSecret && f.userKey && f.spaceKey && f.workItemTypeKey);
  }

  clearToken() {
    this.tokenCache = { token: "", expiresAt: 0, pending: null };
  }

  getTokenCacheInfo() {
    return {
      hasToken: !!this.tokenCache.token,
      expiresAt: this.tokenCache.expiresAt ? new Date(this.tokenCache.expiresAt).toISOString() : "",
    };
  }

  async getToken(options = {}) {
    return this.getPluginToken(options);
  }

  async getPluginToken({ forceRefresh = false } = {}) {
    const now = Date.now();
    if (!forceRefresh && this.tokenCache.token && now < this.tokenCache.expiresAt) return this.tokenCache.token;
    if (!forceRefresh && this.tokenCache.pending) return this.tokenCache.pending;
    const f = this.config;
    if (!f.baseUrl || !f.pluginId || !f.pluginSecret) {
      throw new Error("Feishu Project plugin credentials are incomplete");
    }

    this.tokenCache.pending = this.requestJson("POST", f.tokenPath, {
      skipAuth: true,
      body: {
        plugin_id: f.pluginId,
        plugin_secret: f.pluginSecret,
        pluginId: f.pluginId,
        pluginSecret: f.pluginSecret,
      },
    }).then((data) => {
      const token = data?.data?.token
        || data?.data?.access_token
        || data?.data?.plugin_token
        || data?.token
        || data?.access_token
        || data?.plugin_token;
      if (!token) throw new Error(`Feishu Project token missing: ${clip(JSON.stringify(data))}`);
      const expiresIn = Number(data?.data?.expire || data?.data?.expires_in || data?.expire || data?.expires_in || 3600);
      this.tokenCache.token = String(token);
      this.tokenCache.expiresAt = Date.now() + Math.max(60, expiresIn - 300) * 1000;
      return this.tokenCache.token;
    }).finally(() => {
      this.tokenCache.pending = null;
    });
    return this.tokenCache.pending;
  }

  async request(method, pathTemplate, body = null, vars = {}, options = {}) {
    if (!this.isReady()) throw new Error("Feishu Project credentials are incomplete");
    const f = this.config;
    for (let authAttempt = 0; authAttempt < 2; authAttempt++) {
      const token = await this.getPluginToken({ forceRefresh: authAttempt > 0 });
      try {
        return await this.requestJson(method, pathTemplate, {
          ...options,
          body,
          vars,
          headers: {
            [f.tokenHeaderName || "Authorization"]: `${f.tokenHeaderPrefix || ""}${token}`,
            [f.userKeyHeaderName || "X-USER-KEY"]: f.userKey,
            ...(options.headers || {}),
          },
        });
      } catch (err) {
        if (authAttempt === 0 && isAuthError(err)) {
          this.clearToken();
          continue;
        }
        throw err;
      }
    }
    throw new Error("Feishu Project auth retry exhausted");
  }

  async requestJson(method, pathTemplate, { body = null, vars = {}, headers = {}, skipAuth = false, timeoutMs = null } = {}) {
    const f = this.config;
    const path = renderTemplate(pathTemplate, { ...f, ...vars });
    const init = {
      method,
      headers: cleanObject({
        "Content-Type": body == null ? "" : "application/json",
        ...headers,
      }),
      body: body == null ? undefined : JSON.stringify(body),
    };
    if (!skipAuth && !headers[f.tokenHeaderName || "Authorization"]) {
      throw new Error("Feishu Project auth header is missing");
    }
    return this.fetchJsonWithRetry(absUrl(f.baseUrl, path), init, { timeoutMs: timeoutMs || f.requestTimeoutMs });
  }

  async fetchJsonWithRetry(url, init, { timeoutMs = 30000 } = {}) {
    const retry = this.config.retry || {};
    const attempts = Math.max(1, Number(retry.attempts || 1));
    let lastErr = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      await this.rateLimiter.wait();
      try {
        const resp = await fetchWithTimeout(this.fetchImpl, url, init, timeoutMs);
        const data = await safeJson(resp);
        const apiCode = getApiErrorCode(data);
        if (resp.ok && apiCode == null) return data;
        const err = new FeishuProjectHttpError(resp, data, apiCode);
        if (attempt >= attempts - 1 || !shouldRetry(err, retry)) throw err;
        await sleep(getRetryDelayMs(err, retry, attempt));
        lastErr = err;
      } catch (err) {
        if (attempt >= attempts - 1 || !shouldRetry(err, retry)) throw err;
        await sleep(getRetryDelayMs(err, retry, attempt));
        lastErr = err;
      }
    }
    throw lastErr || new Error("Feishu Project request failed");
  }

  async searchWorkItems({ pageSize, pageToken, filter, query, orderBy, extraBody, spaceKey, workItemTypeKey } = {}) {
    const f = this.config;
    const size = Math.min(Number(pageSize || f.pageSize || 50), 200);
    const body = cleanObject({
      ...(extraBody || {}),
      page_size: size,
      pageSize: size,
      page_token: pageToken || "",
      pageToken: pageToken || "",
      filter,
      query,
      order_by: orderBy,
      orderBy,
    });
    const data = await this.request("POST", f.searchPathTemplate, body, { spaceKey, workItemTypeKey });
    const result = unwrapResult(data);
    const items = firstArray(result, ["items", "list", "work_items", "workItems", "records"]) || [];
    const nextPageToken = stringValue(getFirst(result, ["next_page_token", "nextPageToken", "page_token", "pageToken", "next_token", "nextToken"]));
    const hasMoreValue = getFirst(result, ["has_more", "hasMore", "more"]);
    return {
      items,
      nextPageToken,
      hasMore: typeof hasMoreValue === "boolean" ? hasMoreValue : !!nextPageToken,
      raw: data,
    };
  }

  async *iterateSearchPages(options = {}) {
    const maxPages = Math.max(1, Number(options.maxPages || this.config.maxPages || 1000));
    let pageToken = options.pageToken || "";
    for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
      const page = await this.searchWorkItems({ ...options, pageToken });
      yield { ...page, pageIndex };
      pageToken = page.nextPageToken || "";
      if (!page.items.length || !page.hasMore || !pageToken) break;
    }
  }

  async getWorkItemDetail(workItemId, options = {}) {
    const f = this.config;
    const data = await this.request("GET", f.detailPathTemplate, null, {
      ...options,
      workItemId,
    });
    return unwrapWorkItem(data);
  }

  async getFieldMetadata(options = {}) {
    const f = this.config;
    const spaceKey = options.spaceKey || f.spaceKey;
    const workItemTypeKey = options.workItemTypeKey || f.workItemTypeKey;
    const cacheKey = `${spaceKey}:${workItemTypeKey}`;
    if (!options.forceRefresh && this.fieldMetadataCache.has(cacheKey)) {
      return this.fieldMetadataCache.get(cacheKey);
    }

    let raw = null;
    if (this.fieldMetadataProvider) {
      raw = await this.fieldMetadataProvider({ spaceKey, workItemTypeKey, client: this });
    } else if (options.fieldMetadata) {
      raw = options.fieldMetadata;
    } else if (f.fieldMetadata) {
      raw = f.fieldMetadata;
    } else {
      const pathTemplate = f.fieldMetadataPathTemplate || f.fieldsPathTemplate || "";
      raw = pathTemplate ? await this.request("GET", pathTemplate, null, { spaceKey, workItemTypeKey }) : { fields: [] };
    }

    const metadata = normalizeFeishuFieldMetadata(raw);
    this.fieldMetadataCache.set(cacheKey, metadata);
    if (this.onFieldMetadata) await this.onFieldMetadata(metadata, { spaceKey, workItemTypeKey, client: this, raw });
    return metadata;
  }

  async getComments(workItemId, options = {}) {
    const f = this.config;
    if (!f.commentsPathTemplate) return [];
    return this.fetchPagedCollection(f.commentsPathTemplate, ["comments", "items", "list"], workItemId, options);
  }

  async listWorkItemComments(workItemId, options = {}) {
    return this.getComments(workItemId, options);
  }

  async getAttachments(workItemId, options = {}) {
    const f = this.config;
    if (!f.attachmentsPathTemplate) return [];
    return this.fetchPagedCollection(f.attachmentsPathTemplate, ["attachments", "items", "list"], workItemId, options);
  }

  async listWorkItemAttachments(workItemId, options = {}) {
    return this.getAttachments(workItemId, options);
  }

  async fetchPagedCollection(pathTemplate, arrayKeys, workItemId, options = {}) {
    const pageSize = Math.min(Number(options.pageSize || this.config.pageSize || 50), 200);
    const maxPages = Math.max(1, Number(options.maxPages || this.config.maxPages || 1000));
    const out = [];
    let pageToken = options.pageToken || "";
    for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
      const path = appendQuery(pathTemplate, {
        page_size: pageSize,
        pageSize: pageSize,
        page_token: pageToken || "",
        pageToken: pageToken || "",
      });
      const data = await this.request("GET", path, null, { ...options, workItemId });
      const result = unwrapResult(data);
      const items = firstArray(result, arrayKeys) || [];
      out.push(...items);
      pageToken = stringValue(getFirst(result, ["next_page_token", "nextPageToken", "page_token", "pageToken", "next_token", "nextToken"]));
      const hasMore = getFirst(result, ["has_more", "hasMore", "more"]);
      if (!items.length || !(typeof hasMore === "boolean" ? hasMore : !!pageToken) || !pageToken) break;
    }
    return out;
  }

  async hydrateWorkItem(item, options = {}) {
    const ref = extractWorkItemRef(item, this.config);
    const detail = ref.workItemId ? await this.getWorkItemDetail(ref.workItemId, ref) : { ...item };
    const fieldMetadata = options.fieldMetadata === undefined
      ? await this.getFieldMetadata(ref).catch(() => null)
      : options.fieldMetadata;
    if (fieldMetadata) detail._fieldMetadata = fieldMetadata;
    if (options.includeComments !== false && ref.workItemId && !hasArray(detail, ["comments", "comment_list", "commentList"])) {
      detail.comments = await this.getComments(ref.workItemId, ref);
    }
    if (options.includeAttachments !== false && ref.workItemId && !hasArray(detail, ["attachments", "attachment_list", "attachmentList"])) {
      detail.attachments = await this.getAttachments(ref.workItemId, ref);
    }
    return detail;
  }

  async fetchWorkItems({ limit, filter, query, orderBy, includeComments = true, includeAttachments = true, includeFieldMetadata = true, pageSize, maxPages, extraBody } = {}) {
    const out = [];
    const metadata = includeFieldMetadata ? await this.getFieldMetadata().catch(() => null) : null;
    for await (const page of this.iterateSearchPages({ filter, query, orderBy, pageSize, maxPages, extraBody })) {
      for (const item of page.items) {
        out.push(await this.hydrateWorkItem(item, {
          includeComments,
          includeAttachments,
          fieldMetadata: metadata,
        }));
        if (limit && out.length >= limit) return out;
      }
    }
    return out;
  }

  async fetchWorkItemsByIds(workItemIds, { includeComments = true, includeAttachments = true, includeFieldMetadata = true } = {}) {
    const metadata = includeFieldMetadata ? await this.getFieldMetadata().catch(() => null) : null;
    const out = [];
    for (const workItemId of workItemIds || []) {
      out.push(await this.hydrateWorkItem({ work_item_id: workItemId }, {
        includeComments,
        includeAttachments,
        fieldMetadata: metadata,
      }));
    }
    return out;
  }
}

export function normalizeFeishuExtractorConfig(config = {}) {
  return deepMerge(DEFAULT_FEISHU_EXTRACTOR_CONFIG, config || {});
}

export function normalizeFeishuFieldMetadata(raw) {
  if (!raw) return { fields: [], raw };
  if (Array.isArray(raw)) return { fields: raw.map(normalizeFieldMeta).filter((f) => f.key), raw };
  if (Array.isArray(raw.fields)) return { fields: raw.fields.map(normalizeFieldMeta).filter((f) => f.key), raw: raw.raw ?? raw };
  const result = unwrapResult(raw);
  const fields = firstArray(result, ["fields", "items", "list", "field_list", "fieldList", "custom_fields", "customFields"]) || [];
  return { fields: fields.map(normalizeFieldMeta).filter((f) => f.key), raw };
}

export function extractWorkItemRef(item = {}, defaults = {}) {
  return {
    spaceKey: stringValue(getFirst(item, ["space_key", "spaceKey", "project_key", "projectKey"])) || defaults.spaceKey,
    workItemTypeKey: stringValue(getFirst(item, ["work_item_type_key", "workItemTypeKey", "type_key", "typeKey"])) || defaults.workItemTypeKey,
    workItemId: stringValue(getFirst(item, ["id", "work_item_id", "workItemId", "issue_id", "workObjectId"])),
  };
}

class FeishuProjectHttpError extends Error {
  constructor(resp, data, apiCode = null) {
    const suffix = apiCode == null ? `HTTP ${resp.status}` : `API code ${apiCode}`;
    super(`Feishu Project ${suffix}: ${clip(JSON.stringify(data))}`);
    this.name = "FeishuProjectHttpError";
    this.status = resp.status;
    this.apiCode = apiCode;
    this.data = data;
    this.retryAfter = parseRetryAfter(resp.headers?.get?.("retry-after"));
  }
}

function normalizeFieldMeta(f = {}) {
  const key = stringValue(getFirst(f, ["field_key", "fieldKey", "key", "id", "name"]));
  return {
    key,
    name: stringValue(getFirst(f, ["field_name", "fieldName", "name", "label", "display_name", "displayName"])) || key,
    type: stringValue(getFirst(f, ["field_type", "fieldType", "type", "value_type", "valueType"])),
    options: getFirst(f, ["options", "enum_options", "enumOptions", "values"]) || [],
    raw: f,
  };
}

function unwrapResult(data) {
  return data?.data?.result || data?.data || data?.result || data || {};
}

function unwrapWorkItem(data) {
  return data?.data?.work_item
    || data?.data?.workItem
    || data?.data?.item
    || data?.result?.work_item
    || data?.result?.workItem
    || data?.result
    || data?.data
    || data;
}

async function fetchWithTimeout(fetchImpl, url, init, timeoutMs) {
  if (!fetchImpl) throw new Error("global fetch is unavailable");
  if (!timeoutMs) return fetchImpl(url, init);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function safeJson(resp) {
  const text = await resp.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

function getApiErrorCode(data) {
  const code = data?.err_code ?? data?.errCode ?? data?.code;
  if (code == null || code === 0 || code === "0" || code === 200 || code === "200") return null;
  return code;
}

function shouldRetry(err, retry = {}) {
  if (err?.name === "AbortError") return true;
  if (err instanceof FeishuProjectHttpError) {
    const statusCodes = retry.statusCodes || [];
    const apiCodes = retry.apiCodes || [];
    return statusCodes.includes(Number(err.status)) || apiCodes.includes(Number(err.apiCode));
  }
  return /fetch|network|socket|timeout|aborted|ECONNRESET|ETIMEDOUT/i.test(err?.message || String(err));
}

function getRetryDelayMs(err, retry = {}, attempt = 0) {
  if (Number.isFinite(err?.retryAfter)) return Math.max(0, err.retryAfter);
  const base = Math.max(0, Number(retry.baseDelayMs ?? 400));
  const max = Math.max(base, Number(retry.maxDelayMs ?? 5000));
  return Math.min(max, base * (2 ** attempt));
}

function isAuthError(err) {
  return err instanceof FeishuProjectHttpError && (err.status === 401 || err.status === 403);
}

function parseRetryAfter(value) {
  if (!value) return null;
  const n = Number(value);
  if (Number.isFinite(n)) return n * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

function appendQuery(path, params = {}) {
  const pairs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  if (!pairs.length) return path;
  const joiner = String(path).includes("?") ? "&" : "?";
  return `${path}${joiner}${pairs.join("&")}`;
}

function hasArray(obj, keys) {
  return keys.some((key) => Array.isArray(getFirst(obj, [key])));
}

function firstArray(obj, keys) {
  for (const key of keys || []) {
    const value = getFirst(obj, [key]);
    if (Array.isArray(value)) return value;
  }
  return null;
}

function getFirst(obj, keys) {
  for (const key of keys || []) {
    const v = getCaseInsensitive(obj, key);
    if (v != null && v !== "") return v;
  }
  return null;
}

function getCaseInsensitive(obj, key) {
  if (!obj || typeof obj !== "object") return null;
  if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  const nk = normKey(key);
  const hit = Object.keys(obj).find((k) => normKey(k) === nk);
  return hit ? obj[hit] : null;
}

function normKey(v) {
  return String(v || "").trim().toLowerCase().replace(/[\s_-]+/g, "");
}

function stringValue(v) {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

function renderTemplate(template, vars = {}) {
  return String(template || "").replace(/\{([^}]+)\}/g, (_, k) => String(vars[k] ?? ""));
}

function absUrl(base, path) {
  if (/^https?:\/\//i.test(path)) return path;
  return `${String(base || "").replace(/\/+$/, "")}/${String(path || "").replace(/^\/+/, "")}`;
}

function cleanObject(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v == null || v === "" || (Array.isArray(v) && !v.length)) continue;
    out[k] = v;
  }
  return out;
}

function deepMerge(...objs) {
  const out = {};
  for (const obj of objs) {
    for (const [k, v] of Object.entries(obj || {})) {
      if (v && typeof v === "object" && !Array.isArray(v)) out[k] = deepMerge(out[k] || {}, v);
      else out[k] = v;
    }
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function clip(s, n = 500) {
  s = String(s || "");
  return s.length <= n ? s : `${s.slice(0, n)}...`;
}
