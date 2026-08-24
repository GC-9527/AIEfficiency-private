/**
 * 飞书 Webhook 签名校验与重放防护（方案 §10.6.3）
 *
 * 校验三件事：
 *   1. HMAC-SHA256 签名（X-Lark-Signature）
 *   2. 时间戳（X-Lark-Request-Timestamp）偏差 < 5 分钟
 *   3. request_id 去重（10 分钟滑动窗口）
 *
 * 提供 Express 中间件 `feishuWebhookVerifier`，失败 → 401 + 审计日志。
 */

import crypto from "node:crypto";

const SKEW_MS = 5 * 60 * 1000;
const DEDUP_TTL_MS = 10 * 60 * 1000;

/**
 * 生成签名（给调用方/测试使用）：
 *   signature = base64(hmac_sha256(secret, timestamp + nonce + body))
 *
 * 官方文档：
 *   https://open.feishu.cn/document/ukTMukTMukTM/uETMwYjLxEDM24SMxAjN
 */
export function signFeishu({ timestamp, nonce = "", body, secret }) {
  if (!secret) throw new Error("feishu secret required");
  const stringToSign = `${timestamp}${nonce}${body}`;
  return crypto.createHmac("sha256", secret).update(stringToSign, "utf8").digest("base64");
}

export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * 创建去重存储（内存版，P1c 阶段可替换为 SQLite `webhook_dedup` 表）
 */
export function createMemoryDedup(ttl_ms = DEDUP_TTL_MS) {
  const m = new Map(); // request_id -> expires_at
  function purge(now) {
    for (const [k, v] of m) if (v <= now) m.delete(k);
  }
  return {
    has(id) {
      purge(Date.now());
      return m.has(id);
    },
    add(id) {
      m.set(id, Date.now() + ttl_ms);
    },
    size() {
      return m.size;
    },
    _clear() {
      m.clear();
    },
  };
}

/**
 * 核心校验函数。独立于 express，便于测试。
 *
 * @param {Object} p
 * @param {string} p.secret         - 飞书应用 Verification Token 或 Encrypt Key
 * @param {string} p.signature      - X-Lark-Signature header
 * @param {string|number} p.timestamp - X-Lark-Request-Timestamp（秒）
 * @param {string} p.nonce          - X-Lark-Request-Nonce（可空）
 * @param {string} p.rawBody        - 请求体原文（未反序列化）
 * @param {string} p.requestId      - 用于去重的 ID（飞书 event_id）
 * @param {Object} p.dedup          - 去重存储（createMemoryDedup 或 SQLite 包装）
 * @param {number} [p.now]          - 当前时间戳（ms），便于测试
 * @returns {{ ok: boolean, reason?: string }}
 */
export function verifyFeishuWebhook({ secret, signature, timestamp, nonce, rawBody, requestId, dedup, now }) {
  if (!secret) return { ok: false, reason: "SECRET_MISSING" };
  if (!signature) return { ok: false, reason: "SIGNATURE_MISSING" };
  if (!timestamp) return { ok: false, reason: "TIMESTAMP_MISSING" };
  if (rawBody == null) return { ok: false, reason: "BODY_MISSING" };

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: "TIMESTAMP_INVALID" };

  const nowMs = now ?? Date.now();
  const drift = Math.abs(nowMs - ts * 1000);
  if (drift > SKEW_MS) return { ok: false, reason: "TIMESTAMP_SKEW" };

  const expected = signFeishu({ timestamp, nonce: nonce || "", body: rawBody, secret });
  if (!safeEqual(signature, expected)) return { ok: false, reason: "SIGNATURE_MISMATCH" };

  if (requestId && dedup) {
    if (dedup.has(requestId)) return { ok: false, reason: "REPLAYED" };
    dedup.add(requestId);
  }

  return { ok: true };
}

/**
 * Express 中间件工厂。
 * 使用前必须确保 req.rawBody 已填充（见下方 `rawBodyCapture`）。
 */
export function feishuWebhookVerifier({ getSecret, dedup, logger }) {
  const _dedup = dedup || createMemoryDedup();
  return function (req, res, next) {
    const result = verifyFeishuWebhook({
      secret: typeof getSecret === "function" ? getSecret(req) : getSecret,
      signature: req.headers["x-lark-signature"],
      timestamp: req.headers["x-lark-request-timestamp"],
      nonce: req.headers["x-lark-request-nonce"],
      rawBody: req.rawBody || "",
      requestId: req.headers["x-lark-event-id"] || req.body?.event_id,
      dedup: _dedup,
    });
    if (!result.ok) {
      if (logger) logger("warn", "feishu-webhook", `verify failed: ${result.reason}`);
      res.status(401).json({ error: "webhook verify failed", reason: result.reason });
      return;
    }
    next();
  };
}

/**
 * rawBody 捕获中间件（express.json() 之前挂载）。
 * 原因：签名基于原始字节，JSON.stringify 可能丢失字段顺序。
 */
export function rawBodyCapture(req, res, next) {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    req.rawBody = Buffer.concat(chunks).toString("utf8");
    try {
      req.body = req.rawBody ? JSON.parse(req.rawBody) : {};
    } catch {
      req.body = {};
    }
    next();
  });
  req.on("error", next);
}
