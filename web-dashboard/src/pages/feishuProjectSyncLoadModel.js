export const FEISHU_SYNC_INITIAL_REQUESTS = Object.freeze({
  config: Object.freeze({ path: "/config", timeoutMs: 8000 }),
  records: Object.freeze({ path: "/records?limit=100&enrich=0", timeoutMs: 8000 }),
});

export const FEISHU_SYNC_ERROR_REQUESTS = Object.freeze([
  Object.freeze({ key: "errors", path: "/errors?limit=80&status=open", timeoutMs: 8000 }),
  Object.freeze({ key: "retryable", path: "/retryable-errors?limit=80", timeoutMs: 8000 }),
  Object.freeze({ key: "rawPayloads", path: "/raw-payloads?limit=20&includePayload=0", timeoutMs: 8000 }),
]);

export function feishuMcpConnectionStatus(feishuMcp = {}) {
  if (!feishuMcp.checked) {
    return { ok: false, label: "待检测", detail: "正在检测 MCP 连接" };
  }
  if (feishuMcp.degraded) {
    return {
      ok: false,
      label: "连接检查失败",
      detail: feishuMcp.error
        || (feishuMcp.lastConnected
          ? "本次连接检查失败；上次连接记录仅供参考，已保存的登录配置仍保留"
          : "本次连接检查失败；已保存的登录配置仍保留"),
    };
  }
  if (feishuMcp.connected) {
    return { ok: true, label: "已连接", detail: `${feishuMcp.toolCount || 0} tools` };
  }
  return {
    ok: false,
    label: "未就绪",
    detail: feishuMcp.error || (feishuMcp.needsAuthorization ? "需要授权" : "MCP 未连接"),
  };
}

function settleRequest(request, spec) {
  return Promise.resolve()
    .then(() => request(spec.path, { timeoutMs: spec.timeoutMs }))
    .then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error }),
    );
}

export function createFeishuProjectSyncLoader({ request }) {
  if (typeof request !== "function") throw new TypeError("request must be a function");

  let errorsCache = null;
  let errorsInFlight = null;

  return {
    loadInitial() {
      // Both requests are background work. The view owns the short reveal deadline,
      // so even a hung config endpoint cannot keep the whole route behind a mask.
      return {
        config: settleRequest(request, FEISHU_SYNC_INITIAL_REQUESTS.config),
        records: settleRequest(request, FEISHU_SYNC_INITIAL_REQUESTS.records),
      };
    },

    async loadErrors({ force = false } = {}) {
      if (!force && errorsCache) return { ...errorsCache, cached: true };
      if (errorsInFlight) return errorsInFlight;

      errorsInFlight = Promise.all(
        FEISHU_SYNC_ERROR_REQUESTS.map(async (spec) => ({
          key: spec.key,
          result: await settleRequest(request, spec),
        })),
      ).then((results) => {
        const data = {
          errors: [],
          retryable: [],
          rawPayloads: [],
          failures: [],
          cached: false,
        };
        for (const { key, result } of results) {
          if (result.ok) data[key] = Array.isArray(result.value) ? result.value : [];
          else data.failures.push({ key, error: result.error });
        }
        errorsCache = data;
        return data;
      }).finally(() => {
        errorsInFlight = null;
      });

      return errorsInFlight;
    },

    clearErrorsCache() {
      errorsCache = null;
    },
  };
}
