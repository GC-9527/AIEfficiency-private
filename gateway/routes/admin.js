/** Canonical administrator routes under /api/admin. */
import { randomUUID } from "crypto";
import { Router } from "express";
import {
  dingUserLogin,
  publicPrincipal,
  requireAdmin,
  requireAuth,
  requirePeerReplicationAuth,
  revokeSuperSessions,
  revokeToken,
  superAdminLogin,
  tbUserLogin,
} from "../services/admin-auth.js";
import {
  addAdminUser,
  addAudit,
  countAdminUsers,
  getAdminUser,
  getAdminUsersRevision,
  listAdminUsers,
  listAdminUsersSince,
  listAudit,
  removeAdminUser,
} from "../db/sqlite.js";
import { getDingtalkMembers } from "../services/dingtalk-members.js";
import { getDingOauthConfig, exchangeAuthCode } from "../services/dingtalk-oauth.js";
import { getOrgMembers } from "../services/teambition.js";
import { getTotpConfig, resetTotp } from "../services/admin-totp-store.js";
import { consumeTbLoginChallenge } from "../services/tb-login-challenge.js";

const router = Router();
const TOTP_ATTEMPT_WINDOW_MS = 5 * 60 * 1000;
const TOTP_BLOCK_MS = 15 * 60 * 1000;
const TOTP_MAX_FAILURES = 5;
const totpLoginAttempts = new Map();

function noStore(res) {
  res.set("Cache-Control", "no-store");
  return res;
}

function normalizedIp(value) {
  return String(value || "").trim().replace(/^::ffff:/, "");
}

function isLoopbackAddress(value) {
  const ip = normalizedIp(value);
  return ip === "127.0.0.1" || ip === "::1" || ip === "localhost";
}

/**
 * Vite is a loopback reverse proxy and appends the browser peer to XFF.
 * Trust XFF only when the immediate transport is loopback, and take the last
 * hop so a LAN caller cannot prepend a forged loopback address.
 */
export function originalClientIp(req) {
  const transport = normalizedIp(req.socket?.remoteAddress || req.ip || "");
  if (!isLoopbackAddress(transport)) return transport;
  const forwardedChain = String(req.headers?.["x-forwarded-for"] || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const forwarded = forwardedChain.at(-1) || "";
  return normalizedIp(forwarded) || transport;
}

function isLoopback(req) {
  return isLoopbackAddress(originalClientIp(req));
}

function totpAttemptState(req, now = Date.now()) {
  const key = originalClientIp(req) || "unknown";
  let state = totpLoginAttempts.get(key);
  if (!state || now - state.windowStarted >= TOTP_ATTEMPT_WINDOW_MS) {
    state = { failures: 0, windowStarted: now, blockedUntil: 0 };
    totpLoginAttempts.set(key, state);
  }
  return { key, state, now };
}

function rejectRateLimitedTotp(res, blockedUntil, now = Date.now()) {
  const retryAfter = Math.max(1, Math.ceil((blockedUntil - now) / 1000));
  res.set("Retry-After", String(retryAfter));
  return noStore(res).status(429).json({
    ok: false,
    code: "TOTP_RATE_LIMITED",
    error: "动态验证码失败次数过多，请稍后再试",
    retryAfter,
  });
}

function legacyTestLoginEnabled() {
  return String(process.env.NODE_ENV || "").trim().toLowerCase() === "test";
}

function disabledLegacyLogin(res, provider) {
  return noStore(res).status(410).json({
    ok: false,
    code: `LEGACY_${provider}_LOGIN_DISABLED`,
    error: "该旧登录入口已停用，请使用经过身份提供方验证的登录流程",
  });
}

function clientIp(req) {
  return originalClientIp(req);
}

function recordAdminAudit(req, action, target, before, after) {
  const principal = publicPrincipal(req.principal);
  addAudit({
    id: randomUUID(),
    ts: Date.now(),
    ip: clientIp(req),
    actor: principal?.subjectId || principal?.name || "unknown",
    role: principal?.role || "",
    action,
    target,
    before,
    after,
    node: "gateway",
  });
}

function requestedAuditLimit(value, fallback = 50) {
  return Math.max(1, Math.min(200, Number.parseInt(value, 10) || fallback));
}

export function totpSetupPayload(config, { localAccess = false } = {}) {
  const data = {
    enrolled: !!config.enrolled,
    account: config.account,
    issuer: config.issuer,
    secretFile: "gateway/.secrets/admin-totp.json",
  };
  if (localAccess) {
    data.secret = config.secret;
    data.otpauth = config.otpauth;
  }
  return data;
}

// ===== Authentication =====
router.post("/auth/login", (req, res) => {
  const attempt = totpAttemptState(req);
  if (attempt.state.blockedUntil > attempt.now) {
    return rejectRateLimitedTotp(res, attempt.state.blockedUntil, attempt.now);
  }
  const result = superAdminLogin(req.body?.code);
  if (result.ok) {
    totpLoginAttempts.delete(attempt.key);
  } else {
    attempt.state.failures += 1;
    if (attempt.state.failures >= TOTP_MAX_FAILURES) {
      attempt.state.blockedUntil = attempt.now + TOTP_BLOCK_MS;
      return rejectRateLimitedTotp(res, attempt.state.blockedUntil, attempt.now);
    }
  }
  noStore(res).status(result.ok ? 200 : 401).json(result);
});

router.get("/auth/totp/setup", (req, res) => {
  const config = getTotpConfig();
  const data = totpSetupPayload(config, { localAccess: isLoopback(req) });
  noStore(res).json({ ok: true, data });
});

router.post("/auth/totp/reset", requireAuth(["super"]), (req, res) => {
  if (!isLoopback(req)) {
    return res.status(403).json({ ok: false, code: "TOTP_RESET_LOCAL_ONLY", error: "仅可在网关本机重置密钥" });
  }
  const config = resetTotp();
  revokeSuperSessions({ reason: "totp-reset" });
  return noStore(res).json({
    ok: true,
    data: {
      secret: config.secret,
      otpauth: config.otpauth,
      secretFile: "gateway/.secrets/admin-totp.json",
    },
  });
});

// Body-supplied Ding identity is an explicit test-only compatibility channel.
// Production must use /auth/ding/callback, whose identity comes from DingTalk.
router.post("/auth/ding-login", (req, res) => {
  if (!legacyTestLoginEnabled()) return disabledLegacyLogin(res, "DING");
  const result = dingUserLogin(req.body?.dingUserid, req.body?.name, { authMethod: "test" });
  return noStore(res).status(result.ok ? 200 : 403).json(result);
});

router.get("/auth/ding/config", (req, res) => {
  noStore(res).json({ ok: true, data: getDingOauthConfig() });
});

router.post("/auth/ding/callback", async (req, res) => {
  try {
    const { dingUserid, name } = await exchangeAuthCode(req.body?.authCode);
    const result = dingUserLogin(dingUserid, name, { authMethod: "dingtalk_oauth" });
    if (!result.ok) return noStore(res).status(403).json({ ...result, dingUserid, name });
    return noStore(res).json(result);
  } catch (error) {
    return noStore(res).status(400).json({ ok: false, code: "DING_OAUTH_FAILED", error: error.message });
  }
});

router.post("/auth/tb-login", async (req, res) => {
  const claim = consumeTbLoginChallenge(req.body?.loginChallenge);
  if (!claim.ok) {
    const status = claim.code === "TB_LOGIN_CHALLENGE_PENDING" ? 409 : 401;
    return noStore(res).status(status).json(claim);
  }
  const result = tbUserLogin(claim.userInfo.userId, claim.userInfo.name);
  return noStore(res).status(result.ok ? 200 : 403).json(result);
});

router.get("/auth/me", requireAuth(), (req, res) => {
  noStore(res).json({ ok: true, data: publicPrincipal(req.principal) });
});

router.post("/auth/logout", requireAuth(), (req, res) => {
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  revokeToken(token);
  noStore(res).json({ ok: true });
});

// ===== Initial admin screen =====
router.get("/bootstrap", requireAdmin, (req, res) => {
  noStore(res).json({
    ok: true,
    data: { adminCount: countAdminUsers(), revision: getAdminUsersRevision() },
  });
});

router.get("/overview", requireAdmin, (req, res) => {
  const users = listAdminUsers();
  const revision = getAdminUsersRevision();
  noStore(res).json({
    ok: true,
    data: {
      revision,
      users,
      bootstrap: { adminCount: users.length, revision },
      audit: listAudit({ limit: requestedAuditLimit(req.query.auditLimit, 50) }),
    },
  });
});

router.get("/audit", requireAdmin, (req, res) => {
  noStore(res).json({
    ok: true,
    data: listAudit({ limit: requestedAuditLimit(req.query.limit, 50) }),
  });
});

// ===== Administrator membership =====
router.get("/users", requireAdmin, (req, res) => {
  noStore(res).json({ ok: true, data: listAdminUsers(), revision: getAdminUsersRevision() });
});

router.get("/users-since", requirePeerReplicationAuth, (req, res) => {
  res.json({
    ok: true,
    data: listAdminUsersSince(Number.parseInt(req.query.since, 10) || 0),
    revision: getAdminUsersRevision(),
  });
});

router.post("/users", requireAuth(["super"]), (req, res) => {
  const issuer = String(req.body?.subject?.issuer || req.body?.issuer || "teambition").trim().toLowerCase();
  const subjectId = String(req.body?.subject?.id || "").trim();
  const legacyId = String(req.body?.dingUserid || "").trim();
  if (!["teambition", "dingtalk"].includes(issuer)) {
    return res.status(400).json({
      ok: false,
      code: "ADMIN_SUBJECT_ISSUER_UNSUPPORTED",
      error: "管理员名单只接受经过验证的 Teambition 或钉钉组织身份",
    });
  }
  if (subjectId && legacyId && subjectId !== legacyId) {
    return res.status(400).json({ ok: false, code: "ADMIN_SUBJECT_MISMATCH", error: "subject 与 dingUserid 不一致" });
  }
  const userId = subjectId || legacyId;
  if (!userId) {
    return res.status(400).json({ ok: false, code: "ADMIN_SUBJECT_REQUIRED", error: "缺少组织用户 ID" });
  }
  const before = getAdminUser(userId, issuer);
  const user = addAdminUser({
    subject: { issuer, id: userId },
    name: req.body?.name,
    addedBy: publicPrincipal(req.principal)?.subjectId || req.principal.name,
  });
  recordAdminAudit(req, "管理员.设置", `admin:${issuer}:${userId}`, before, user);
  return noStore(res).json({ ok: true, data: user, revision: getAdminUsersRevision() });
});

router.delete("/users/:dingUserid", requireAuth(["super"]), (req, res) => {
  const before = getAdminUser(req.params.dingUserid);
  const result = removeAdminUser(req.params.dingUserid);
  recordAdminAudit(req, "管理员.移除", `admin:${req.params.dingUserid}`, before, null);
  return noStore(res).json({ ok: true, changes: result.changes, revision: getAdminUsersRevision() });
});

// ===== Organization member lookup =====
router.get("/members", requireAuth(["super"]), async (req, res) => {
  try {
    const members = await getOrgMembers({ q: req.query.q, force: req.query.refresh === "1" });
    return res.json({
      ok: true,
      data: members.slice(0, 1000).map((member) => ({
        subject: { issuer: "teambition", id: String(member.uid) },
        subjectId: `teambition:${member.uid}`,
        userId: String(member.uid),
        name: member.name,
        avatarUrl: member.avatarUrl || "",
      })),
      total: members.length,
    });
  } catch (error) {
    return res.json({ ok: false, error: error.message });
  }
});

router.get("/dingtalk/members", requireAuth(["super"]), async (req, res) => {
  try {
    const all = await getDingtalkMembers(req.query.refresh === "1");
    const query = String(req.query.q || "").trim().toLowerCase();
    const list = query
      ? all.filter((member) => member.name.toLowerCase().includes(query) || String(member.userid).toLowerCase().includes(query))
      : all;
    return res.json({
      ok: true,
      data: list.slice(0, 500).map((member) => ({
        subject: { issuer: "dingtalk", id: String(member.userid) },
        subjectId: `dingtalk:${member.userid}`,
        userId: String(member.userid),
        name: member.name,
        mobile: member.mobile || "",
      })),
      total: all.length,
    });
  } catch (error) {
    return res.json({ ok: false, error: error.message });
  }
});

export default router;
