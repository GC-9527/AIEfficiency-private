const GENERATED_E2E_TITLE = /^E2E\s+e2e-\d{10,}-[a-z0-9]{3,}$/i;

function text(value) {
  return String(value || "").trim();
}

function headerValue(headers, name) {
  if (!headers || typeof headers !== "object") return "";
  const direct = headers[name];
  if (direct !== undefined) return text(Array.isArray(direct) ? direct[0] : direct);
  const key = Object.keys(headers).find((item) => item.toLowerCase() === name.toLowerCase());
  const value = key ? headers[key] : "";
  return text(Array.isArray(value) ? value[0] : value);
}

export function isGeneratedE2eStoryTitle(title) {
  return GENERATED_E2E_TITLE.test(text(title));
}

export function isIsolatedDevbenchTestRuntime(env = process.env) {
  return text(env.NODE_ENV).toLowerCase() === "test"
    && !!text(env.GATEWAY_DB_PATH)
    && !!text(env.DEVBENCH_STORE_DIR);
}

export function inspectStoryCreateRequest({
  title,
  headers = {},
  env = process.env,
} = {}) {
  const generatedE2eTitle = isGeneratedE2eStoryTitle(title);
  const declaredE2e = !!headerValue(headers, "x-devbench-e2e-run");
  const automated = generatedE2eTitle || declaredE2e;
  if (!automated) {
    return {
      ok: true,
      automated: false,
      isolated: false,
      source: headerValue(headers, "x-devbench-request-source") || "browser_or_api",
    };
  }

  const isolated = isIsolatedDevbenchTestRuntime(env);
  const source = declaredE2e
    ? `e2e:${headerValue(headers, "x-devbench-e2e-run").slice(0, 80)}`
    : "generated_e2e_title";
  if (isolated) return { ok: true, automated: true, isolated: true, source };

  return {
    ok: false,
    automated: true,
    isolated: false,
    source,
    statusCode: 409,
    code: "E2E_STORY_REQUIRES_ISOLATED_RUNTIME",
    error: "检测到自动化 E2E 故事点；当前 Gateway 使用真实 devbench 数据，已拒绝创建。请使用 NODE_ENV=test，并同时设置独立的 GATEWAY_DB_PATH 与 DEVBENCH_STORE_DIR。",
  };
}

export function storyCreateAuditFields(req = {}) {
  const headers = req.headers || {};
  return {
    requestId: text(headerValue(headers, "x-request-id") || headerValue(headers, "x-idempotency-key")).slice(0, 100) || "-",
    source: text(headerValue(headers, "x-devbench-request-source")).slice(0, 80) || "browser_or_api",
    userAgent: text(headerValue(headers, "user-agent")).replace(/\s+/g, " ").slice(0, 160) || "-",
    remote: text(req.ip || req.socket?.remoteAddress).slice(0, 80) || "-",
  };
}
