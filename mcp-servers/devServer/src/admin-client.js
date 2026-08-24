import { randomUUID } from "node:crypto";

import { ENDPOINTS } from "./catalog.js";
import {
  currentRequestSignal,
  requestAbortError,
  throwIfRequestAborted,
} from "./request-context.js";
import {
  AppMarketError,
  parseLoginCurlFile,
  redactSecrets,
} from "./security.js";

const SUCCESS_BUSINESS_CODES = new Set([0, 200, "0", "200"]);

async function readResponseText(response, maxBytes) {
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > maxBytes) {
    throw new AppMarketError(
      "RESPONSE_TOO_LARGE",
      "后台响应超过允许大小",
      { status: response.status }
    );
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // Ignore cancellation failures; the size violation is authoritative.
      }
      throw new AppMarketError(
        "RESPONSE_TOO_LARGE",
        "后台响应超过允许大小",
        { status: response.status }
      );
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

function parseJson(text, requestId, status) {
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new AppMarketError("UPSTREAM_INVALID_JSON", "后台返回了无效 JSON", {
      requestId,
      status,
      retryable: true,
    });
  }
}

function validateBusinessResponse(data, requestId) {
  if (
    data &&
    typeof data === "object" &&
    Object.hasOwn(data, "code") &&
    !SUCCESS_BUSINESS_CODES.has(data.code)
  ) {
    throw new AppMarketError(
      "UPSTREAM_BUSINESS_ERROR",
      "后台业务响应未成功",
      {
        requestId,
        details: { businessCode: data.code },
      }
    );
  }
}

function normalizeEntries(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value).filter(([, item]) => item !== undefined);
}

function assertAllowedKeys(endpoint, kind, value) {
  const allowed = new Set(endpoint[kind] || []);
  for (const [key] of normalizeEntries(value)) {
    if (!allowed.has(key)) {
      throw new AppMarketError(
        "INVALID_ARGUMENT",
        `${endpoint.id} 不允许参数 ${key}`
      );
    }
  }
}

function assertAllowedValues(endpoint, kind, value) {
  const allowedByKey = endpoint[kind] || {};
  for (const [key, allowedValues] of Object.entries(allowedByKey)) {
    const actual = value?.[key];
    if (
      actual !== undefined &&
      actual !== null &&
      !allowedValues.includes(String(actual))
    ) {
      throw new AppMarketError(
        "INVALID_ARGUMENT",
        `${endpoint.id} 的 ${key} 不在允许值内`
      );
    }
  }
}

function resolveEndpointPath(endpoint, pathValues = {}) {
  const pathKeys =
    endpoint.allowedPathKeys || Object.keys(endpoint.allowedPathValues || {});
  const pathEndpoint = { ...endpoint, allowedPathKeys: pathKeys };
  assertAllowedKeys(pathEndpoint, "allowedPathKeys", pathValues);
  let path = endpoint.path;
  for (const key of pathKeys) {
    const value = String(pathValues[key] || "");
    const allowedValues = endpoint.allowedPathValues?.[key] || [];
    if (!value || !allowedValues.includes(value)) {
      throw new AppMarketError(
        "INVALID_ARGUMENT",
        `${endpoint.id} 的 ${key} 不在允许值内`
      );
    }
    path = path.replace(`{${key}}`, encodeURIComponent(value));
  }
  if (path.includes("{") || path.includes("}")) {
    throw new AppMarketError("INVALID_ARGUMENT", `${endpoint.id} 缺少路径参数`);
  }
  return path;
}

function assertEndpointAllowed(endpointId) {
  if (!Object.hasOwn(ENDPOINTS, endpointId)) {
    throw new AppMarketError("ENDPOINT_NOT_ALLOWED", "接口不在只读白名单中");
  }
  const endpoint = ENDPOINTS[endpointId];
  if (endpoint.internalAuth) {
    throw new AppMarketError("ENDPOINT_NOT_ALLOWED", "接口不在只读白名单中");
  }
  if (endpoint.method !== "GET" && !endpoint.readOnlyPost) {
    throw new AppMarketError("METHOD_NOT_ALLOWED", "接口方法不允许");
  }
  return endpoint;
}

function defaultAudit(event) {
  process.stderr.write(
    `${JSON.stringify({
      level: "audit",
      service: "appmarket-admin-readonly",
      ...event,
    })}\n`
  );
}

export class AppMarketAdminClient {
  constructor(config, options = {}) {
    this.config = config;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.now = options.now || (() => Date.now());
    this.audit = options.audit || defaultAudit;
    this.token = "";
    this.tokenExpiresAt = 0;
    this.loginState = null;
    this.fileCredentialsPromise = null;
  }

  credentialMode() {
    if (this.config.token) return "token";
    if (this.config.username || this.config.password) return "environment";
    if (this.config.loginCurlFile) return "credential-file";
    return "not-configured";
  }

  async credentials() {
    if (this.config.username || this.config.password) {
      return {
        username: this.config.username,
        password: this.config.password,
      };
    }
    if (this.config.loginCurlFile) {
      if (!this.fileCredentialsPromise) {
        this.fileCredentialsPromise = parseLoginCurlFile(
          this.config.loginCurlFile
        );
      }
      return this.fileCredentialsPromise;
    }
    return { username: "", password: "" };
  }

  async canRefreshToken() {
    if (this.config.token) return false;
    const { username, password } = await this.credentials();
    return Boolean(username && password);
  }

  async getToken(forceRefresh = false) {
    const signal = currentRequestSignal();
    if (signal?.aborted) throw requestAbortError(signal);
    if (this.config.token) return this.config.token;
    if (
      !forceRefresh &&
      this.token &&
      this.now() < this.tokenExpiresAt
    ) {
      return this.token;
    }
    let state = this.loginState;
    if (
      state &&
      (!state.accepting || state.controller.signal.aborted)
    ) {
      state = null;
    }
    if (!state) {
      const controller = new AbortController();
      state = {
        accepting: true,
        controller,
        promise: null,
        settled: false,
        waiters: 0,
      };
      state.promise = this.login(controller.signal)
        .then((token) => {
          if (
            this.loginState === state &&
            state.accepting &&
            !controller.signal.aborted
          ) {
            this.token = token;
            this.tokenExpiresAt = this.now() + this.config.tokenTtlMs;
          }
          return token;
        })
        .finally(() => {
          state.settled = true;
          if (this.loginState === state) {
            this.loginState = null;
          }
        });
      // A request can cancel before it attaches to the new shared promise.
      // Keep a rejection observer so an abandoned login never becomes unhandled.
      state.promise.catch(() => {});
      this.loginState = state;
    }
    return this.waitForLogin(state, signal);
  }

  async waitForLogin(state, signal) {
    state.waiters += 1;
    let abortFromCaller;
    let released = false;
    const releaseWaiter = (reason) => {
      if (released) return;
      released = true;
      state.waiters -= 1;
      if (state.waiters === 0 && !state.settled) {
        state.accepting = false;
        if (this.loginState === state) {
          this.loginState = null;
        }
        state.controller.abort(
          reason ||
            new AppMarketError("REQUEST_CANCELLED", "MCP 请求已取消")
        );
      }
    };
    try {
      if (!signal) return await state.promise;
      const cancellation = new Promise((_, reject) => {
        abortFromCaller = () => {
          const error = requestAbortError(signal);
          releaseWaiter(error);
          reject(error);
        };
        if (signal.aborted) {
          abortFromCaller();
        } else {
          signal.addEventListener("abort", abortFromCaller, { once: true });
        }
      });
      return await Promise.race([state.promise, cancellation]);
    } finally {
      if (abortFromCaller) {
        signal.removeEventListener("abort", abortFromCaller);
      }
      releaseWaiter(
        signal?.aborted ? requestAbortError(signal) : undefined
      );
    }
  }

  async login(externalSignal = currentRequestSignal()) {
    const { username, password } = await this.credentials();
    if (!username || !password) {
      throw new AppMarketError(
        "AUTH_NOT_CONFIGURED",
        "未配置应用市场后台只读认证环境变量"
      );
    }
    const requestId = randomUUID();
    const startedAt = this.now();
    try {
      const token = await this.fetchWithTimeout(
        `${this.config.baseUrl}${this.config.apiPrefix}/login`,
        {
          method: "POST",
          redirect: "manual",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json;charset=UTF-8",
            "User-Agent": "appmarket-admin-readonly-mcp/1.0",
            "X-Request-Id": requestId,
          },
          body: JSON.stringify({ username, password }),
        },
        async (response) => {
          if (response.status >= 300 && response.status < 400) {
            throw new AppMarketError(
              "UPSTREAM_REDIRECT_BLOCKED",
              "后台登录发生重定向",
              { requestId, status: response.status }
            );
          }
          if (!response.ok) {
            throw new AppMarketError("AUTH_FAILED", "应用市场后台认证失败", {
              requestId,
              status: response.status,
            });
          }
          const text = await readResponseText(
            response,
            this.config.maxResponseBytes
          );
          const data = parseJson(text, requestId, response.status);
          const receivedToken = data?.token || data?.data?.token;
          if (!receivedToken || typeof receivedToken !== "string") {
            throw new AppMarketError(
              "AUTH_FAILED",
              "后台登录未返回有效令牌",
              { requestId }
            );
          }
          return receivedToken;
        },
        externalSignal
      );
      this.audit({
        requestId,
        operation: "auth.login",
        result: "ok",
        durationMs: this.now() - startedAt,
      });
      return token;
    } catch (error) {
      this.audit({
        requestId,
        operation: "auth.login",
        result: error.code || "error",
        durationMs: this.now() - startedAt,
      });
      if (error instanceof AppMarketError) throw error;
      throw this.networkError(error, requestId);
    }
  }

  async fetchWithTimeout(
    url,
    options,
    handleResponse,
    externalSignal = currentRequestSignal()
  ) {
    if (externalSignal?.aborted) {
      throw requestAbortError(externalSignal);
    }
    const controller = new AbortController();
    let abortFromCaller;
    const cancellation = externalSignal
      ? new Promise((_, reject) => {
          abortFromCaller = () => {
            const error = requestAbortError(externalSignal);
            reject(error);
            controller.abort(error);
          };
          externalSignal.addEventListener("abort", abortFromCaller, {
            once: true,
          });
          if (externalSignal.aborted) {
            abortFromCaller();
          }
        })
      : null;
    let timeout;
    const deadline = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        const error = new Error("upstream deadline exceeded");
        error.name = "AbortError";
        reject(error);
      }, this.config.timeoutMs);
    });
    try {
      if (controller.signal.aborted) {
        return await cancellation;
      }
      const operation = (async () => {
        const response = await this.fetchImpl(url, {
          ...options,
          signal: controller.signal,
        });
        return handleResponse(response);
      })();
      return await Promise.race(
        cancellation ? [operation, deadline, cancellation] : [operation, deadline]
      );
    } finally {
      clearTimeout(timeout);
      controller.abort();
      if (abortFromCaller) {
        externalSignal.removeEventListener("abort", abortFromCaller);
      }
    }
  }

  networkError(error, requestId) {
    if (error?.name === "AbortError") {
      return new AppMarketError("UPSTREAM_TIMEOUT", "后台请求超时", {
        requestId,
        retryable: true,
      });
    }
    return new AppMarketError("UPSTREAM_NETWORK_ERROR", "无法连接应用市场后台", {
      requestId,
      retryable: true,
    });
  }

  buildRequest(endpoint, { query = {}, body = {}, pathValues = {} }) {
    assertAllowedKeys(endpoint, "allowedQueryKeys", query);
    assertAllowedKeys(endpoint, "allowedBodyKeys", body);
    assertAllowedValues(endpoint, "allowedQueryValues", query);
    assertAllowedValues(endpoint, "allowedBodyValues", body);
    const path = resolveEndpointPath(endpoint, pathValues);
    const url = new URL(
      `${this.config.apiPrefix}${path}`,
      this.config.baseUrl
    );
    if (
      url.origin !== this.config.baseUrl ||
      !url.pathname.startsWith(`${this.config.apiPrefix}/`)
    ) {
      throw new AppMarketError("ORIGIN_NOT_ALLOWED", "接口地址越过后台白名单");
    }
    for (const [key, value] of normalizeEntries(query)) {
      if (value === null || value === "") continue;
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(key, String(item));
      } else {
        url.searchParams.set(key, String(value));
      }
    }
    const options = {
      method: endpoint.method,
      redirect: "manual",
      headers: {
        Accept: "application/json, text/plain, */*",
        "User-Agent": "appmarket-admin-readonly-mcp/1.0",
      },
    };
    if (endpoint.method === "POST") {
      options.headers["Content-Type"] = "application/json;charset=UTF-8";
      options.body = JSON.stringify(body);
    }
    return { url, options };
  }

  async request(endpointId, args = {}, attempt = 0) {
    throwIfRequestAborted();
    const endpoint = assertEndpointAllowed(endpointId);
    const { url, options } = this.buildRequest(endpoint, args);
    const token = await this.getToken();
    throwIfRequestAborted();
    const requestId = randomUUID();
    const startedAt = this.now();
    options.headers.Authorization = `Bearer ${token}`;
    options.headers["X-Request-Id"] = requestId;

    try {
      const outcome = await this.fetchWithTimeout(
        url,
        options,
        async (response) => {
          if (response.status >= 300 && response.status < 400) {
            throw new AppMarketError(
              "UPSTREAM_REDIRECT_BLOCKED",
              "后台接口发生重定向",
              { requestId, status: response.status }
            );
          }
          if (response.status === 401) {
            return { unauthorized: true };
          }
          if (response.status === 403) {
            throw new AppMarketError(
              "FORBIDDEN",
              "当前后台账号无此只读接口权限",
              { requestId, status: response.status }
            );
          }
          if (response.status === 429) {
            throw new AppMarketError("RATE_LIMITED", "后台请求受到限流", {
              requestId,
              status: response.status,
              retryable: true,
            });
          }
          if (!response.ok) {
            throw new AppMarketError(
              "UPSTREAM_HTTP_ERROR",
              "后台接口请求失败",
              {
                requestId,
                status: response.status,
                retryable: response.status >= 500,
              }
            );
          }
          const text = await readResponseText(
            response,
            this.config.maxResponseBytes
          );
          const rawData = parseJson(text, requestId, response.status);
          validateBusinessResponse(rawData, requestId);
          return { data: redactSecrets(rawData) };
        }
      );
      if (outcome.unauthorized) {
        if (attempt === 0 && (await this.canRefreshToken())) {
          if (this.token === token) {
            this.token = "";
            this.tokenExpiresAt = 0;
            await this.getToken(true);
          } else {
            await this.getToken();
          }
          return this.request(endpointId, args, 1);
        }
        throw new AppMarketError("AUTH_FAILED", "后台认证已失效", {
          requestId,
          status: 401,
        });
      }
      const data = outcome.data;
      this.audit({
        requestId,
        operation: endpointId,
        method: endpoint.method,
        result: "ok",
        durationMs: this.now() - startedAt,
      });
      return {
        data,
        requestId,
        endpointId,
        environment: this.config.environment,
        fetchedAt: new Date(this.now()).toISOString(),
      };
    } catch (error) {
      this.audit({
        requestId,
        operation: endpointId,
        method: endpoint.method,
        result: error.code || "error",
        durationMs: this.now() - startedAt,
      });
      const requestSignal = currentRequestSignal();
      if (requestSignal?.aborted) {
        throw requestAbortError(requestSignal);
      }
      if (error instanceof AppMarketError) throw error;
      throw this.networkError(error, requestId);
    }
  }
}

export const __test = {
  assertAllowedKeys,
  assertEndpointAllowed,
  readResponseText,
  resolveEndpointPath,
};
