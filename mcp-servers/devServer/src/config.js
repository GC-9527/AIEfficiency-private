import { AppMarketError } from "./security.js";

export const DEFAULT_BASE_URL = "http://appgallery-manage.hssstg.com:1080";
export const DEFAULT_API_PREFIX = "/admin-api";

const DEFAULT_ALLOWED_ORIGINS = new Set([new URL(DEFAULT_BASE_URL).origin]);

function positiveInteger(raw, fallback, minimum, maximum, name) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new AppMarketError(
      "CONFIG_INVALID",
      `${name} 必须是 ${minimum} 到 ${maximum} 之间的整数`
    );
  }
  return value;
}

function configuredAllowedOrigins(env) {
  const configured = String(env.APPMARKET_ADMIN_ALLOWED_ORIGINS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const values = configured.length ? configured : [...DEFAULT_ALLOWED_ORIGINS];
  const origins = new Set();
  for (const value of values) {
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      throw new AppMarketError(
        "CONFIG_INVALID",
        "APPMARKET_ADMIN_ALLOWED_ORIGINS 包含无效 URL"
      );
    }
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      (parsed.pathname && parsed.pathname !== "/") ||
      parsed.search ||
      parsed.hash
    ) {
      throw new AppMarketError(
        "CONFIG_INVALID",
        "允许的后台地址必须是无凭据、无路径、无查询参数的 HTTP(S) origin"
      );
    }
    origins.add(parsed.origin);
  }
  return origins;
}

export function normalizeBaseUrl(raw, allowedOrigins) {
  let parsed;
  try {
    parsed = new URL(String(raw || DEFAULT_BASE_URL).trim());
  } catch {
    throw new AppMarketError("CONFIG_INVALID", "后台地址不是有效 URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new AppMarketError("CONFIG_INVALID", "后台地址只允许 HTTP(S)");
  }
  if (
    parsed.username ||
    parsed.password ||
    (parsed.pathname && parsed.pathname !== "/") ||
    parsed.search ||
    parsed.hash
  ) {
    throw new AppMarketError(
      "CONFIG_INVALID",
      "后台地址必须是无凭据、无路径、无查询参数的 origin"
    );
  }
  if (!allowedOrigins.has(parsed.origin)) {
    throw new AppMarketError(
      "ORIGIN_NOT_ALLOWED",
      "后台地址不在 APPMARKET_ADMIN_ALLOWED_ORIGINS 白名单中"
    );
  }
  return parsed.origin;
}

export function loadConfig(env = process.env) {
  const allowedOrigins = configuredAllowedOrigins(env);
  const baseUrl = normalizeBaseUrl(
    env.APPMARKET_ADMIN_BASE_URL || DEFAULT_BASE_URL,
    allowedOrigins
  );
  return Object.freeze({
    environment: env.APPMARKET_ADMIN_ENVIRONMENT || "stg",
    baseUrl,
    apiPrefix: DEFAULT_API_PREFIX,
    allowedOrigins,
    token: env.APPMARKET_ADMIN_TOKEN || "",
    username: env.APPMARKET_ADMIN_USERNAME || "",
    password: env.APPMARKET_ADMIN_PASSWORD || "",
    loginCurlFile: env.APPMARKET_ADMIN_LOGIN_CURL_FILE || "",
    timeoutMs: positiveInteger(
      env.APPMARKET_ADMIN_TIMEOUT_MS,
      20_000,
      1_000,
      120_000,
      "APPMARKET_ADMIN_TIMEOUT_MS"
    ),
    maxResponseBytes: positiveInteger(
      env.APPMARKET_ADMIN_MAX_RESPONSE_BYTES,
      5 * 1024 * 1024,
      16 * 1024,
      20 * 1024 * 1024,
      "APPMARKET_ADMIN_MAX_RESPONSE_BYTES"
    ),
    tokenTtlMs: positiveInteger(
      env.APPMARKET_ADMIN_TOKEN_TTL_MS,
      25 * 60 * 1000,
      60_000,
      24 * 60 * 60 * 1000,
      "APPMARKET_ADMIN_TOKEN_TTL_MS"
    ),
  });
}
