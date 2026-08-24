import { createHash, randomBytes, timingSafeEqual } from "crypto";

export const FORWARDED_PRINCIPAL_HEADER = "x-aiefficiency-forwarded-principal";

export function normalizeHttpOrigin(value) {
  const raw = String(value || "").trim();
  if (!raw || !/^https?:\/\/[^/?#\\\s]+\/?$/i.test(raw)) return "";
  try {
    const parsed = new URL(raw);
    if (!["http:", "https:"].includes(parsed.protocol)) return "";
    if (parsed.username || parsed.password) return "";
    if ((parsed.pathname && parsed.pathname !== "/") || parsed.search || parsed.hash) return "";
    return parsed.origin;
  } catch {
    return "";
  }
}

export function normalizeM2MToken(value) {
  const token = String(value || "").trim();
  if (!token || token.length > 4096 || !/^[\x21-\x7e]+$/.test(token)) return "";
  return token;
}

export function configuredInboundM2MToken(config = {}) {
  return normalizeM2MToken(
    config.servers?.inboundToken
      || config.claudeProxy?.token
      || "",
  );
}

export function configuredOutboundM2MToken(config = {}) {
  return normalizeM2MToken(config.claudeProxyClient?.token || "");
}

export function configuredPeerOutboundM2MToken(config = {}) {
  return normalizeM2MToken(
    config.claudeProxyClient?.token
      || config.servers?.inboundToken
      || config.claudeProxy?.token
      || "",
  );
}

export function trustedPeerOrigins(config = {}) {
  return new Set(
    (Array.isArray(config.servers?.peers) ? config.servers.peers : [])
      .map(normalizeHttpOrigin)
      .filter(Boolean),
  );
}

export function isTrustedPeerOrigin(value, config = {}, { selfOrigins = [] } = {}) {
  const origin = normalizeHttpOrigin(value);
  if (!origin) return false;
  if (trustedPeerOrigins(config).has(origin)) return true;
  return (Array.isArray(selfOrigins) ? selfOrigins : [selfOrigins])
    .map(normalizeHttpOrigin)
    .filter(Boolean)
    .includes(origin);
}

export function inspectInboundM2MRequest(req, config = {}) {
  const expected = configuredInboundM2MToken(config);
  const presented = normalizeM2MToken(
    String(req?.headers?.authorization || "").replace(/^Bearer\s+/i, ""),
  );
  if (!expected || !presented) {
    return { configured: !!expected, authenticated: false };
  }
  const expectedBytes = Buffer.from(expected);
  const presentedBytes = Buffer.from(presented);
  const authenticated = expectedBytes.length === presentedBytes.length
    && timingSafeEqual(expectedBytes, presentedBytes);
  return { configured: true, authenticated };
}

export function forwardedRequestBinding(req) {
  const method = String(req?.method || "GET").trim().toUpperCase();
  const path = String(req?.originalUrl || req?.url || "/").trim();
  const body = ["GET", "HEAD", "OPTIONS"].includes(method) ? null : (req?.body ?? {});
  const bodySha256 = createHash("sha256")
    .update(JSON.stringify(body), "utf8")
    .digest("hex");
  return { method, path, bodySha256 };
}

export function encodeForwardedPrincipal(principal, requestBinding = {}) {
  // Local TOTP is a node-local break-glass identity and is never delegated.
  if (!principal || String(principal.role || "") !== "admin") return "";
  const subjectId = String(
    principal.subject?.id
      || principal.userId
      || principal.dingUserid
      || "",
  ).trim().slice(0, 160);
  if (!subjectId) return "";
  const subjectIssuer = String(principal.subject?.issuer || "").trim().toLowerCase().slice(0, 80);
  const authzRevision = Number(principal.authzRevision) || 0;
  const method = String(requestBinding.method || "").trim().toUpperCase();
  const path = String(requestBinding.path || "").trim();
  const bodySha256 = String(requestBinding.bodySha256 || "").trim().toLowerCase();
  if (
    !["dingtalk", "teambition"].includes(subjectIssuer)
    || authzRevision <= 0
    || !/^[A-Z]+$/.test(method)
    || !path.startsWith("/")
    || !/^[0-9a-f]{64}$/.test(bodySha256)
  ) return "";
  const issuedAt = Date.now();
  return Buffer.from(JSON.stringify({
    role: "admin",
    name: String(principal.name || "").slice(0, 160),
    dingUserid: String(principal.dingUserid || "").slice(0, 160),
    userId: subjectId,
    subject: { issuer: subjectIssuer, id: subjectId },
    authzRevision,
    method,
    path,
    bodySha256,
    issuedAt,
    expiresAt: issuedAt + 30_000,
    nonce: randomBytes(16).toString("hex"),
    delegatedFromRole: "admin",
  }), "utf8").toString("base64url");
}

export function decodeForwardedPrincipal(value) {
  const encoded = String(value || "").trim();
  if (!encoded || encoded.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    const role = String(parsed?.role || "");
    if (role !== "admin") return null;
    const subjectId = String(parsed?.subject?.id || parsed?.userId || parsed?.dingUserid || "").trim().slice(0, 160);
    if (!subjectId) return null;
    const subjectIssuer = String(parsed?.subject?.issuer || "").trim().toLowerCase().slice(0, 80);
    const authzRevision = Number(parsed?.authzRevision) || 0;
    const method = String(parsed?.method || "").trim().toUpperCase();
    const path = String(parsed?.path || "").trim();
    const bodySha256 = String(parsed?.bodySha256 || "").trim().toLowerCase();
    const issuedAt = Number(parsed?.issuedAt) || 0;
    const expiresAt = Number(parsed?.expiresAt) || 0;
    const nonce = String(parsed?.nonce || "").trim().toLowerCase();
    if (
      !["dingtalk", "teambition"].includes(subjectIssuer)
      || authzRevision <= 0
      || !/^[A-Z]+$/.test(method)
      || !path.startsWith("/")
      || !/^[0-9a-f]{64}$/.test(bodySha256)
      || !/^[0-9a-f]{32}$/.test(nonce)
      || issuedAt <= 0
      || expiresAt <= issuedAt
      || expiresAt - issuedAt > 30_000
    ) return null;
    return {
      role: "admin",
      name: String(parsed?.name || "").slice(0, 160),
      dingUserid: String(parsed?.dingUserid || "").slice(0, 160) || null,
      userId: subjectId,
      subject: { issuer: subjectIssuer, id: subjectId },
      authzRevision,
      method,
      path,
      bodySha256,
      issuedAt,
      expiresAt,
      nonce,
      delegatedFromRole: "admin",
      forwardedByM2M: true,
    };
  } catch {
    return null;
  }
}
