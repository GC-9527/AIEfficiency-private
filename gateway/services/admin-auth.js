/**
 * Canonical administrator authentication and authorization primitives.
 *
 * `admin_users` is only an administrator membership list. A `super` principal
 * can only be created by a successful local TOTP login and is never accepted
 * from database replication or a forwarded M2M principal.
 */
import { createHash, randomBytes } from "crypto";
import {
  deleteAuthToken,
  getAdminUser,
  getAdminUsersRevision,
  loadAuthTokens,
  onAdminUsersChanged,
  saveAuthToken,
} from "../db/sqlite.js";
import { verifyTotp } from "./totp.js";
import { getTotpConfig, markEnrolled } from "./admin-totp-store.js";
import { emitWs, log } from "./logger.js";
import { getConfig } from "./config.js";
import {
  decodeForwardedPrincipal,
  FORWARDED_PRINCIPAL_HEADER,
  forwardedRequestBinding,
  inspectInboundM2MRequest,
} from "./m2m-auth.js";

const TOKENS = new Map(); // token hash -> persisted principal
const FORWARDED_NONCES = new Map(); // nonce -> expiresAt
const TTL = 24 * 60 * 60 * 1000;
const LOCAL_SUPER_SUBJECT = Object.freeze({ issuer: "local", id: "totp-super" });
const ADMIN_AUTH_ISSUER_BY_METHOD = Object.freeze({
  dingtalk_oauth: "dingtalk",
  teambition_login: "teambition",
});

const ADMIN_CAPABILITIES = Object.freeze([
  "admin:read",
  "audit:read",
  "vehicle-config:read",
  "vehicle-config:edit",
  // Compatibility alias for older callers; new routes use edit.
  "vehicle-config:write",
  "vehicle-config:publish",
  "vehicle-config:retry",
  "vehicle-config:resolve",
]);
const SUPER_CAPABILITIES = Object.freeze([
  ...ADMIN_CAPABILITIES,
  "admin:manage",
  "admin:totp:reset",
  "vehicle-config:force-repair",
]);

function isNodeTestRuntime() {
  return String(process.env.NODE_ENV || "").trim().toLowerCase() === "test"
    || !!String(process.env.NODE_TEST_CONTEXT || "").trim()
    || process.execArgv.includes("--test");
}

function newToken() { return randomBytes(24).toString("hex"); }
function tokenHash(token) {
  return `sha256:${createHash("sha256").update(String(token || ""), "utf8").digest("hex")}`;
}

function normalizeSubject(subject, fallbackIssuer = "", fallbackId = "") {
  const issuer = String(subject?.issuer || fallbackIssuer || "").trim().toLowerCase();
  const id = String(subject?.id || fallbackId || "").trim();
  return issuer && id ? { issuer, id } : null;
}

function principalSubjectId(principal) {
  return String(principal?.subject?.id || principal?.userId || principal?.dingUserid || "").trim();
}

function isPersistedAdminSession(principal) {
  const expectedIssuer = ADMIN_AUTH_ISSUER_BY_METHOD[principal?.authMethod];
  return principal?.role === "admin"
    && !!expectedIssuer
    && normalizeSubject(principal?.subject)?.issuer === expectedIssuer;
}

function normalizeIssuedPrincipal(principal) {
  const input = principal && typeof principal === "object" ? principal : {};
  const role = String(input.role || "").trim().toLowerCase();

  // Direct token issuance is retained only as an isolated node:test fixture.
  // Production admin and super sessions must come from the login functions.
  if (isNodeTestRuntime() && !input.authMethod) {
    const id = String(input.dingUserid || input.userId || input.id || input.name || randomBytes(8).toString("hex"));
    return {
      ...input,
      role,
      authMethod: "test",
      subject: normalizeSubject(input.subject, "test", id),
    };
  }
  if (isNodeTestRuntime() && input.authMethod === "test") {
    const id = String(input.subject?.id || input.dingUserid || input.userId || input.id || input.name || randomBytes(8).toString("hex"));
    return {
      ...input,
      role,
      authMethod: "test",
      subject: normalizeSubject(input.subject, "test", id),
    };
  }

  if (role === "super") {
    const subject = normalizeSubject(input.subject);
    if (input.authMethod !== "totp" || subject?.issuer !== LOCAL_SUPER_SUBJECT.issuer || subject?.id !== LOCAL_SUPER_SUBJECT.id) {
      throw new Error("SUPER_REQUIRES_TOTP");
    }
    return { ...input, role: "super", subject, dingUserid: null, userId: subject.id };
  }

  if (role === "admin") {
    const subject = normalizeSubject(input.subject);
    const expectedIssuer = ADMIN_AUTH_ISSUER_BY_METHOD[input.authMethod];
    if (!expectedIssuer || subject?.issuer !== expectedIssuer) {
      throw new Error("ADMIN_REQUIRES_VERIFIED_IDENTITY");
    }
    return { ...input, role: "admin", subject, userId: subject.id };
  }

  return { ...input, role, subject: normalizeSubject(input.subject) };
}

// Restore only hashed, unexpired tokens. Legacy privileged tokens are loaded
// but fail closed during verifyToken because they lack the canonical subject
// and authMethod contract.
try {
  for (const row of loadAuthTokens()) {
    TOKENS.set(row.tokenHash, { ...row.data, exp: row.exp, expiresAt: row.exp });
  }
} catch {}

function deleteTokenByKey(key) {
  if (!key) return;
  TOKENS.delete(key);
  try { deleteAuthToken(key); } catch {}
}

export function capabilitiesForPrincipal(principal) {
  if (isSuperPrincipal(principal)) return [...SUPER_CAPABILITIES];
  if (principal?.role === "admin") return [...ADMIN_CAPABILITIES];
  return [];
}

export function hasPermission(principal, capability) {
  const required = String(capability || "").trim();
  return !!required && capabilitiesForPrincipal(principal).includes(required);
}

export function isSuperPrincipal(principal) {
  if (!principal || principal.forwardedByM2M === true || principal.role !== "super") return false;
  if (isNodeTestRuntime() && principal.authMethod === "test") return true;
  const subject = normalizeSubject(principal.subject);
  return principal.authMethod === "totp"
    && subject?.issuer === LOCAL_SUPER_SUBJECT.issuer
    && subject?.id === LOCAL_SUPER_SUBJECT.id;
}

export function isAdminPrincipal(principal) {
  return isSuperPrincipal(principal) || principal?.role === "admin";
}

export function publicPrincipal(principal) {
  if (!principal) return null;
  const subject = normalizeSubject(principal.subject);
  return {
    subject,
    subjectId: subject ? `${subject.issuer}:${subject.id}` : null,
    userId: principal.userId || subject?.id || null,
    dingUserid: principal.dingUserid || null,
    role: isSuperPrincipal(principal) ? "super" : String(principal.role || ""),
    name: String(principal.name || ""),
    authMethod: String(principal.authMethod || ""),
    capabilities: capabilitiesForPrincipal(principal),
    issuedAt: Number(principal.issuedAt) || null,
    expiresAt: Number(principal.expiresAt || principal.exp) || null,
    authzRevision: Number(principal.authzRevision) || 0,
  };
}

export function issueToken(principal) {
  const normalized = normalizeIssuedPrincipal(principal);
  const token = newToken();
  const issuedAt = Date.now();
  const exp = issuedAt + TTL;
  const stored = { ...normalized, issuedAt, expiresAt: exp, exp };
  TOKENS.set(tokenHash(token), stored);
  try { saveAuthToken(token, stored, exp); } catch {}
  return token;
}

export function verifyToken(token) {
  const key = token ? tokenHash(token) : "";
  const stored = key && TOKENS.get(key);
  if (!stored) return null;
  if (Number(stored.exp) < Date.now()) {
    deleteTokenByKey(key);
    return null;
  }

  if (stored.role === "super") {
    if (!isSuperPrincipal(stored)) {
      deleteTokenByKey(key);
      return null;
    }
    return { ...stored, capabilities: capabilitiesForPrincipal(stored) };
  }

  if (stored.role === "admin") {
    if (stored.authMethod === "test" && isNodeTestRuntime()) {
      return { ...stored, capabilities: capabilitiesForPrincipal(stored) };
    }
    if (!isPersistedAdminSession(stored)) {
      deleteTokenByKey(key);
      return null;
    }
    const id = principalSubjectId(stored);
    const current = id ? getAdminUser(id, stored.subject?.issuer) : null;
    if (!current || current.role !== "admin" || Number(current.updatedAt) !== Number(stored.authzRevision)) {
      deleteTokenByKey(key);
      return null;
    }
    const refreshed = {
      ...stored,
      role: "admin",
      name: current.name || stored.name,
      authzRevision: current.updatedAt,
    };
    return { ...refreshed, capabilities: capabilitiesForPrincipal(refreshed) };
  }

  return stored;
}

export function requestPrincipal(req, { allowM2M = false } = {}) {
  const token = String(req?.headers?.authorization || "")
    .replace(/^Bearer\s+/i, "")
    .trim();
  const browserPrincipal = verifyToken(token);
  if (browserPrincipal || !allowM2M) return browserPrincipal;

  const m2m = inspectInboundM2MRequest(req, getConfig());
  if (!m2m.authenticated) return null;
  const forwarded = decodeForwardedPrincipal(req?.headers?.[FORWARDED_PRINCIPAL_HEADER]);
  if (forwarded) {
    const now = Date.now();
    const binding = forwardedRequestBinding(req);
    const current = ["dingtalk", "teambition"].includes(forwarded.subject?.issuer)
      ? getAdminUser(forwarded.subject.id, forwarded.subject.issuer)
      : null;
    if (
      forwarded.issuedAt > now + 5_000
      || forwarded.expiresAt < now
      || forwarded.method !== binding.method
      || forwarded.path !== binding.path
      || forwarded.bodySha256 !== binding.bodySha256
      || FORWARDED_NONCES.has(forwarded.nonce)
      || !current
      || Number(current.updatedAt) !== Number(forwarded.authzRevision)
    ) return null;
    for (const [nonce, expiresAt] of FORWARDED_NONCES) {
      if (expiresAt < now) FORWARDED_NONCES.delete(nonce);
    }
    FORWARDED_NONCES.set(forwarded.nonce, forwarded.expiresAt);
    return {
      ...forwarded,
      name: current.name || forwarded.name,
      authMethod: "m2m-forwarded",
      forwardedByM2M: true,
      capabilities: forwarded.role === "admin" ? [...ADMIN_CAPABILITIES] : [],
    };
  }
  return {
    role: "m2m",
    name: "trusted-node",
    subject: { issuer: "m2m", id: "trusted-node" },
    authMethod: "m2m",
    dingUserid: null,
    forwardedByM2M: true,
    capabilities: [],
  };
}

export function revokeToken(token) {
  deleteTokenByKey(tokenHash(token));
}

export function revokeAdminSessions(subjectId) {
  const id = String(subjectId || "").trim();
  if (!id) return 0;
  let revoked = 0;
  for (const [key, principal] of TOKENS) {
    if (principal?.role === "admin" && principalSubjectId(principal) === id) {
      deleteTokenByKey(key);
      revoked += 1;
    }
  }
  return revoked;
}

export function revokeSuperSessions({ reason = "super-session-revoked" } = {}) {
  let revoked = 0;
  for (const [key, principal] of TOKENS) {
    if (principal?.role === "super") {
      deleteTokenByKey(key);
      revoked += 1;
    }
  }
  emitWs("admin_authz_invalidated", {
    scope: "super",
    reason,
    revision: getAdminUsersRevision(),
    revoked,
  });
  return revoked;
}

// DB writes and LAN replication both pass through these helpers. Revocation is
// therefore immediate on the node that accepted the membership change, and a
// revisioned WS event makes all open admin surfaces revalidate `/auth/me`.
onAdminUsersChanged((change) => {
  const revoked = revokeAdminSessions(change?.dingUserid);
  emitWs("admin_authz_invalidated", {
    scope: "admin",
    subjectId: change?.subjectId || change?.dingUserid || null,
    reason: change?.action || "membership-changed",
    revision: Number(change?.revision) || getAdminUsersRevision(),
    revoked,
  });
});

export function superAdminLogin(code) {
  const { secret } = getTotpConfig();
  if (!verifyTotp(secret, code)) return { ok: false, code: "TOTP_INVALID", error: "验证码错误或已过期" };
  markEnrolled();
  const principal = {
    role: "super",
    name: "超级管理员",
    dingUserid: null,
    userId: LOCAL_SUPER_SUBJECT.id,
    subject: { ...LOCAL_SUPER_SUBJECT },
    authMethod: "totp",
    authzRevision: getAdminUsersRevision(),
  };
  const token = issueToken(principal);
  log("system", "info", "admin-auth", "超级管理员登录（TOTP）");
  return { ok: true, token, ...publicPrincipal({ ...principal, expiresAt: Date.now() + TTL }) };
}

export function dingUserLogin(dingUserid, name, { authMethod = "dingtalk_oauth" } = {}) {
  const id = String(dingUserid || "").trim();
  const admin = id ? getAdminUser(id, "dingtalk") : null;
  if (!admin) return { ok: false, code: "ADMIN_MEMBERSHIP_REQUIRED", error: "该钉钉用户不是管理员，请联系超级管理员添加" };
  const principal = {
    role: "admin",
    name: admin.name || name || id,
    dingUserid: id,
    userId: id,
    subject: { issuer: "dingtalk", id },
    authMethod: authMethod === "test" && isNodeTestRuntime() ? "test" : "dingtalk_oauth",
    authzRevision: admin.updatedAt,
  };
  const token = issueToken(principal);
  return { ok: true, token, ...publicPrincipal({ ...principal, expiresAt: Date.now() + TTL }) };
}

export function tbUserLogin(uid, name) {
  const id = String(uid || "").trim();
  if (!id) return { ok: false, code: "TB_IDENTITY_REQUIRED", error: "未取得 TB 用户身份" };
  const admin = getAdminUser(id, "teambition");
  if (!admin) {
    return {
      ok: false,
      code: "ADMIN_MEMBERSHIP_REQUIRED",
      error: "该 TB 用户不是管理员，请联系超级管理员添加",
      identified: { uid: id, name },
    };
  }
  const principal = {
    role: "admin",
    name: admin.name || name || id,
    dingUserid: null,
    userId: id,
    subject: { issuer: "teambition", id },
    authMethod: "teambition_login",
    authzRevision: admin.updatedAt,
  };
  const token = issueToken(principal);
  return { ok: true, token, ...publicPrincipal({ ...principal, expiresAt: Date.now() + TTL }) };
}

function roleAllowed(principal, role) {
  if (role === "super") return isSuperPrincipal(principal);
  if (role === "admin") return principal?.role === "admin";
  return principal?.role === role;
}

export function requireAuth(roles) {
  const allow = roles ? (Array.isArray(roles) ? roles : [roles]) : null;
  return (req, res, next) => {
    const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    const principal = verifyToken(token);
    if (!principal) {
      return res.status(401).json({ ok: false, code: "AUTH_REQUIRED", error: "未登录、会话已过期或已被撤销" });
    }
    if (allow && !allow.some((role) => roleAllowed(principal, role))) {
      return res.status(403).json({ ok: false, code: "PERMISSION_DENIED", error: "权限不足" });
    }
    req.principal = principal;
    return next();
  };
}

export function requireAdmin(req, res, next) {
  return requireAuth(["super", "admin"])(req, res, next);
}

export function requirePeerReplicationAuth(req, res, next) {
  if (String(process.env.NODE_ENV || "").trim().toLowerCase() === "test") return next();
  const m2m = inspectInboundM2MRequest(req, getConfig());
  if (!m2m.authenticated) {
    return res.status(401).json({
      ok: false,
      code: m2m.configured ? "M2M_TOKEN_INVALID" : "M2M_INBOUND_TOKEN_REQUIRED",
      error: "节点复制接口要求有效的 M2M 入站口令",
    });
  }
  req.principal = {
    role: "m2m",
    name: "trusted-peer",
    subject: { issuer: "m2m", id: "trusted-peer" },
    authMethod: "m2m",
    forwardedByM2M: true,
  };
  return next();
}
