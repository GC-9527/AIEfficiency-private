import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const SENSITIVE_FIELD_NAMES = new Set([
  "authorization",
  "cookie",
  "setcookie",
  "username",
  "loginname",
  "password",
  "passwd",
  "pwd",
  "pass",
  "token",
  "apitoken",
  "idtoken",
  "jwttoken",
  "bearertoken",
  "jwt",
  "admintoken",
  "accesstoken",
  "refreshtoken",
  "apikey",
  "xapikey",
  "secret",
  "secretkey",
  "accesskeysecret",
  "secretaccesskey",
  "awssecretaccesskey",
  "ossaccesskeysecret",
  "clientsecret",
  "privatekey",
  "credential",
  "credentials",
  "session",
  "sessionid",
]);

const SENSITIVE_QUERY_NAMES = new Set([
  "authorization",
  "auth",
  "username",
  "loginname",
  "password",
  "passwd",
  "pwd",
  "token",
  "admintoken",
  "accesstoken",
  "refreshtoken",
  "session",
  "sessionid",
  "apikey",
  "signature",
  "sign",
  "secret",
  "credential",
  "expires",
  "xamzcredential",
  "xamzsignature",
  "xamzsecuritytoken",
  "xamzexpires",
  "xgoogcredential",
  "xgoogsignature",
  "xgoogexpires",
  "awsaccesskeyid",
  "ossaccesskeyid",
  "securitytoken",
]);

export class AppMarketError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "AppMarketError";
    this.code = code;
    this.retryable = Boolean(options.retryable);
    this.status = options.status;
    this.requestId = options.requestId;
    this.details = options.details;
  }
}

function canonicalFieldName(value) {
  return String(value).replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

export function isSensitiveFieldName(value) {
  return SENSITIVE_FIELD_NAMES.has(canonicalFieldName(value));
}

export function sanitizeUrl(value) {
  if (typeof value !== "string" || !/^https?:\/\//i.test(value)) return value;
  let url;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  let changed = false;
  if (url.username || url.password) {
    url.username = "";
    url.password = "";
    changed = true;
  }
  if (url.hash) {
    url.hash = "";
    changed = true;
  }
  for (const key of [...url.searchParams.keys()]) {
    if (SENSITIVE_QUERY_NAMES.has(canonicalFieldName(key))) {
      url.searchParams.set(key, "[REDACTED]");
      changed = true;
    }
  }
  return changed ? url.toString() : value;
}

export function redactSecrets(value, depth = 0, seen = new WeakSet()) {
  if (depth > 20) return "[MAX_DEPTH]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return sanitizeUrl(value);
  if (typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item, depth + 1, seen));
  }
  // Backend JSON may contain keys such as "__proto__". A null-prototype
  // object keeps those keys as data instead of mutating the output prototype.
  const output = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    output[key] = isSensitiveFieldName(key)
      ? "[REDACTED]"
      : redactSecrets(item, depth + 1, seen);
  }
  return output;
}

export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

export function sha256(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export async function parseLoginCurlFile(path) {
  if (!path) return { username: "", password: "" };
  let text;
  try {
    const statLimit = 1024 * 1024;
    text = await readFile(path, { encoding: "utf8" });
    if (Buffer.byteLength(text, "utf8") > statLimit) {
      throw new AppMarketError(
        "CREDENTIAL_FILE_TOO_LARGE",
        "登录材料文件超过 1 MiB 限制"
      );
    }
  } catch (error) {
    if (error instanceof AppMarketError) throw error;
    throw new AppMarketError(
      "CREDENTIAL_FILE_UNREADABLE",
      "无法读取 APPMARKET_ADMIN_LOGIN_CURL_FILE"
    );
  }

  const normalized = text.replace(/\^/g, "").replace(/\\"/g, '"');
  const jsonMatch = normalized.match(
    /"username"\s*:\s*"([^"]+)"[\s\S]*?"password"\s*:\s*"([^"]+)"/i
  );
  if (jsonMatch) {
    return { username: jsonMatch[1], password: jsonMatch[2] };
  }
  const formUser = normalized.match(/(?:^|[?&;\s])username=([^&;\s"']+)/i);
  const formPassword = normalized.match(
    /(?:^|[?&;\s])password=([^&;\s"']+)/i
  );
  return {
    username: formUser?.[1] || "",
    password: formPassword?.[1] || "",
  };
}

export function publicError(error, fallbackRequestId) {
  const known =
    error instanceof AppMarketError
      ? error
      : new AppMarketError("INTERNAL_ERROR", "MCP 服务内部错误");
  return {
    status: "error",
    error: {
      code: known.code,
      message: known.message,
      retryable: known.retryable,
      requestId: known.requestId || fallbackRequestId || null,
      ...(known.status ? { upstreamStatus: known.status } : {}),
      ...(known.details ? { details: redactSecrets(known.details) } : {}),
    },
  };
}
