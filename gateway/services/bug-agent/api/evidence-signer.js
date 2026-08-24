/**
 * 证据下载短链签名（方案 §10.6.2）
 *
 * 工作流：
 *   GET /api/bug/evidence/:id
 *     → 200 { url: "/api/bug/evidence/download?token=<HMAC>&exp=<ts>&eid=<id>&uid=<uid>" }
 *
 *   GET /api/bug/evidence/download?token=&exp=&eid=&uid=
 *     → 校验签名 + 过期 + 一次性使用 → 返回 archived_path 的内容
 *
 * Token 不含权限信息，仅绑定 (evidence_id, user_id, exp)。
 * 一次性验证通过 token_use 存储（重入则拒）。
 */

import crypto from "node:crypto";

const DEFAULT_TTL_MS = 5 * 60 * 1000;

function getServerSecret() {
  const s = process.env.BUG_AGENT_SIGN_SECRET;
  if (!s || s.length < 32) {
    throw new Error(
      "BUG_AGENT_SIGN_SECRET env var required, must be >=32 chars (e.g. `openssl rand -hex 32`)"
    );
  }
  return s;
}

/**
 * 生成签名 token。
 *
 * @param {Object} p
 * @param {string|number} p.evidence_id
 * @param {string} p.user_id
 * @param {number} [p.ttl_ms]
 * @param {string} [p.secret] - 覆盖 env（测试用）
 * @param {number} [p.now]
 * @returns {{ token: string, exp: number, eid: string, uid: string }}
 */
export function signEvidenceUrl({ evidence_id, user_id, ttl_ms = DEFAULT_TTL_MS, secret, now }) {
  if (evidence_id == null) throw new Error("evidence_id required");
  if (!user_id) throw new Error("user_id required");
  const nowMs = now ?? Date.now();
  const exp = Math.floor((nowMs + ttl_ms) / 1000);
  const eid = String(evidence_id);
  const uid = String(user_id);
  const sec = secret || getServerSecret();
  const payload = `${eid}.${uid}.${exp}`;
  const token = crypto.createHmac("sha256", sec).update(payload, "utf8").digest("base64url");
  return { token, exp, eid, uid };
}

/**
 * 校验 token（不检查一次性使用；一次性由 tokenStore.markUsed 负责）。
 *
 * @returns {{ ok: boolean, reason?: string }}
 */
export function verifyEvidenceToken({ token, eid, uid, exp, secret, now }) {
  if (!token || !eid || !uid || !exp) return { ok: false, reason: "PARAMS_MISSING" };
  const expNum = Number(exp);
  if (!Number.isFinite(expNum)) return { ok: false, reason: "EXP_INVALID" };
  const nowMs = now ?? Date.now();
  if (expNum * 1000 < nowMs) return { ok: false, reason: "EXPIRED" };

  const sec = secret || getServerSecret();
  const payload = `${eid}.${uid}.${expNum}`;
  const expected = crypto.createHmac("sha256", sec).update(payload, "utf8").digest("base64url");
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return { ok: false, reason: "SIGNATURE_MISMATCH" };
  if (!crypto.timingSafeEqual(a, b)) return { ok: false, reason: "SIGNATURE_MISMATCH" };

  return { ok: true };
}

/**
 * 一次性使用存储（内存版，P1c 阶段替换为 SQLite token_use 表）
 */
export function createMemoryTokenStore() {
  const used = new Map(); // token -> expires_at
  function purge(now) {
    for (const [k, v] of used) if (v <= now) used.delete(k);
  }
  return {
    isUsed(token) {
      purge(Date.now());
      return used.has(token);
    },
    markUsed(token, exp_sec) {
      used.set(token, exp_sec * 1000);
    },
    size() {
      return used.size;
    },
    _clear() {
      used.clear();
    },
  };
}

/**
 * 一次性校验（拒重入）
 */
export function consumeEvidenceToken({ token, eid, uid, exp, secret, store, now }) {
  const base = verifyEvidenceToken({ token, eid, uid, exp, secret, now });
  if (!base.ok) return base;
  if (!store) return { ok: false, reason: "STORE_MISSING" };
  if (store.isUsed(token)) return { ok: false, reason: "TOKEN_REUSED" };
  store.markUsed(token, Number(exp));
  return { ok: true };
}

/**
 * 生成可供前端直接跳转的短链。
 *
 * @param {Object} p
 * @param {string|number} p.evidence_id
 * @param {string} p.user_id
 * @param {string} [p.basePath] - 默认 `/api/bug/evidence/download`
 * @returns {{ url: string, exp: number }}
 */
export function buildSignedEvidenceUrl({ evidence_id, user_id, basePath = "/api/bug/evidence/download", ttl_ms, secret, now }) {
  const { token, exp, eid, uid } = signEvidenceUrl({ evidence_id, user_id, ttl_ms, secret, now });
  const qs = new URLSearchParams({ token, exp: String(exp), eid, uid }).toString();
  return { url: `${basePath}?${qs}`, exp };
}
