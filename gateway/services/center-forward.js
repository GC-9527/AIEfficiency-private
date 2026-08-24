import { getConfig } from "./config.js";
import { verifyToken } from "./admin-auth.js";
import {
  configuredOutboundM2MToken,
  encodeForwardedPrincipal,
  FORWARDED_PRINCIPAL_HEADER,
  forwardedRequestBinding,
  isTrustedPeerOrigin,
  normalizeHttpOrigin,
  normalizeM2MToken,
} from "./m2m-auth.js";

function browserPrincipal(req) {
  const token = String(req?.headers?.authorization || "")
    .replace(/^Bearer\s+/i, "")
    .trim();
  return verifyToken(token);
}

export function prepareNodeCenterRequest(req, {
  config = getConfig(),
  requestedHost = "",
  headers = {},
  selfOrigins = [],
  allowedRoles = ["node"],
  outboundToken,
} = {}) {
  const role = String(process.env.ROLE || config.role || "standalone").trim().toLowerCase();
  if (!(Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles]).includes(role)) {
    return { forward: false };
  }

  const rawHost = String(
    requestedHost
      || config.claudeProxyClient?.host
      || config.servers?.selectedHost
      || "",
  ).trim();
  const base = normalizeHttpOrigin(rawHost);
  if (!base || !isTrustedPeerOrigin(base, config, { selfOrigins })) {
    return {
      forward: true,
      ok: false,
      status: 503,
      code: "CENTER_M2M_TARGET_NOT_TRUSTED",
      error: "中心服务端不是管理员明确登记的可信 peer，已拒绝转发",
    };
  }

  const token = outboundToken === undefined
    ? configuredOutboundM2MToken(config)
    : normalizeM2MToken(outboundToken);
  if (!token) {
    return {
      forward: true,
      ok: false,
      status: 503,
      code: "CENTER_M2M_TOKEN_REQUIRED",
      error: "node 未配置独立的中心 M2M 出站口令，已拒绝转发",
    };
  }

  const outgoing = new Headers(headers || {});
  outgoing.delete("Authorization");
  outgoing.delete(FORWARDED_PRINCIPAL_HEADER);
  outgoing.set("Authorization", `Bearer ${token}`);
  const encodedPrincipal = encodeForwardedPrincipal(browserPrincipal(req), forwardedRequestBinding(req));
  if (encodedPrincipal) outgoing.set(FORWARDED_PRINCIPAL_HEADER, encodedPrincipal);
  return {
    forward: true,
    ok: true,
    base,
    headers: outgoing,
    redirect: "error",
  };
}

export function createNodeCenterAuthorizer(requestedHost, {
  allowedRoles = ["node"],
  getCurrentConfig = getConfig,
} = {}) {
  const expectedOrigin = normalizeHttpOrigin(requestedHost);
  return async ({ url } = {}) => {
    let requestOrigin = "";
    try {
      const parsed = new URL(String(url || ""));
      if (parsed.username || parsed.password || parsed.hash) throw new Error("unsafe center request URL");
      requestOrigin = normalizeHttpOrigin(parsed.origin);
    } catch {
      // The common failure below deliberately does not echo the supplied URL.
    }
    if (!expectedOrigin || requestOrigin !== expectedOrigin) {
      const error = new Error("center request target changed or is not a pure trusted origin");
      error.code = "CENTER_M2M_TARGET_CHANGED";
      throw error;
    }
    const prepared = prepareNodeCenterRequest(null, {
      config: getCurrentConfig(),
      requestedHost: expectedOrigin,
      allowedRoles,
    });
    if (!prepared.ok) {
      const error = new Error(prepared.error || "center M2M request rejected");
      error.code = prepared.code || "CENTER_M2M_FORWARD_REJECTED";
      throw error;
    }
    const token = String(prepared.headers.get("Authorization") || "")
      .replace(/^Bearer\s+/i, "")
      .trim();
    if (!token) {
      const error = new Error("center M2M token is required");
      error.code = "CENTER_M2M_TOKEN_REQUIRED";
      throw error;
    }
    return {
      token,
      origin: prepared.base,
      redirect: prepared.redirect,
    };
  };
}

export function sendCenterForwardFailure(res, prepared) {
  return res.status(prepared?.status || 503).json({
    ok: false,
    code: prepared?.code || "CENTER_M2M_FORWARD_REJECTED",
    error: prepared?.error || "中心 M2M 转发已失败关闭",
  });
}
