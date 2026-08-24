/**
 * P-1 M2/M3 安全模块冒烟测试
 *
 * 覆盖：
 *   §10.6.3 飞书 Webhook 签名 + 时间戳 + 去重
 *   §10.6.2 证据 HMAC 签名短链 + 一次性
 *   §10.6.1 XSS 辅助（URL scheme / 转义 / CSP）
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  signFeishu,
  verifyFeishuWebhook,
  createMemoryDedup,
  safeEqual,
} from "../api/feishu-webhook.js";

import {
  signEvidenceUrl,
  verifyEvidenceToken,
  consumeEvidenceToken,
  createMemoryTokenStore,
  buildSignedEvidenceUrl,
} from "../api/evidence-signer.js";

import {
  escapeHtml,
  isSafeUrl,
  textifyForReport,
  defaultCSPHeader,
} from "../api/xss-safe.js";

// ---------- 飞书签名 ----------

const FS_SECRET = "test_secret_for_feishu_webhook_0123456789";

test("feishu: 正确签名通过校验", () => {
  const ts = Math.floor(Date.now() / 1000);
  const body = '{"event_id":"abc","type":"test"}';
  const sig = signFeishu({ timestamp: ts, nonce: "n1", body, secret: FS_SECRET });

  const r = verifyFeishuWebhook({
    secret: FS_SECRET,
    signature: sig,
    timestamp: ts,
    nonce: "n1",
    rawBody: body,
    requestId: "evt-1",
    dedup: createMemoryDedup(),
  });
  assert.equal(r.ok, true);
});

test("feishu: 签名篡改被拒", () => {
  const ts = Math.floor(Date.now() / 1000);
  const r = verifyFeishuWebhook({
    secret: FS_SECRET,
    signature: "tampered_base64xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx=",
    timestamp: ts,
    rawBody: '{"x":1}',
    requestId: "e",
    dedup: createMemoryDedup(),
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "SIGNATURE_MISMATCH");
});

test("feishu: 时间戳漂移 > 5min 被拒", () => {
  const stale = Math.floor(Date.now() / 1000) - 10 * 60; // 10 分钟前
  const body = '{"x":1}';
  const sig = signFeishu({ timestamp: stale, body, secret: FS_SECRET });
  const r = verifyFeishuWebhook({
    secret: FS_SECRET,
    signature: sig,
    timestamp: stale,
    rawBody: body,
    requestId: "e",
    dedup: createMemoryDedup(),
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "TIMESTAMP_SKEW");
});

test("feishu: 重放（相同 request_id）被拒", () => {
  const ts = Math.floor(Date.now() / 1000);
  const body = '{"event_id":"replay","type":"test"}';
  const sig = signFeishu({ timestamp: ts, body, secret: FS_SECRET });
  const dedup = createMemoryDedup();

  const first = verifyFeishuWebhook({
    secret: FS_SECRET, signature: sig, timestamp: ts, rawBody: body,
    requestId: "replay-1", dedup,
  });
  const second = verifyFeishuWebhook({
    secret: FS_SECRET, signature: sig, timestamp: ts, rawBody: body,
    requestId: "replay-1", dedup,
  });
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.reason, "REPLAYED");
});

test("feishu: secret 缺失被拒", () => {
  const r = verifyFeishuWebhook({
    secret: "", signature: "x", timestamp: Date.now() / 1000, rawBody: "{}",
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "SECRET_MISSING");
});

test("feishu: safeEqual 长度不同不崩", () => {
  assert.equal(safeEqual("abc", "abcd"), false);
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual(null, "x"), false);
});

// ---------- 证据签名短链 ----------

const EV_SECRET = "evidence_sign_secret_0123456789_ABCDEFGH";

test("evidence: 生成 + 校验签名 token 一致", () => {
  const { token, exp, eid, uid } = signEvidenceUrl({
    evidence_id: 1234, user_id: "alice", ttl_ms: 60000, secret: EV_SECRET,
  });
  const r = verifyEvidenceToken({ token, eid, uid, exp, secret: EV_SECRET });
  assert.equal(r.ok, true);
});

test("evidence: 过期 token 被拒", () => {
  const { token, exp, eid, uid } = signEvidenceUrl({
    evidence_id: 1, user_id: "alice", ttl_ms: 1000, secret: EV_SECRET,
    now: 1000000000000,
  });
  const r = verifyEvidenceToken({
    token, eid, uid, exp, secret: EV_SECRET, now: 1000000000000 + 2000,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "EXPIRED");
});

test("evidence: 篡改 evidence_id 被拒（签名不匹配）", () => {
  const { token, exp, uid } = signEvidenceUrl({
    evidence_id: 1, user_id: "alice", secret: EV_SECRET,
  });
  const r = verifyEvidenceToken({
    token, eid: "2", uid, exp, secret: EV_SECRET,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "SIGNATURE_MISMATCH");
});

test("evidence: 篡改 user_id 被拒", () => {
  const { token, exp, eid } = signEvidenceUrl({
    evidence_id: 1, user_id: "alice", secret: EV_SECRET,
  });
  const r = verifyEvidenceToken({
    token, eid, uid: "bob", exp, secret: EV_SECRET,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "SIGNATURE_MISMATCH");
});

test("evidence: 一次性 token 重用被拒", () => {
  const { token, exp, eid, uid } = signEvidenceUrl({
    evidence_id: 99, user_id: "alice", secret: EV_SECRET,
  });
  const store = createMemoryTokenStore();
  const r1 = consumeEvidenceToken({ token, eid, uid, exp, secret: EV_SECRET, store });
  const r2 = consumeEvidenceToken({ token, eid, uid, exp, secret: EV_SECRET, store });
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, "TOKEN_REUSED");
});

test("evidence: buildSignedEvidenceUrl 返回可解析的 query", () => {
  const { url } = buildSignedEvidenceUrl({
    evidence_id: 42, user_id: "alice", secret: EV_SECRET,
  });
  assert.ok(url.startsWith("/api/bug/evidence/download?"));
  const q = new URLSearchParams(url.split("?")[1]);
  assert.ok(q.has("token") && q.has("exp") && q.has("eid") && q.has("uid"));
  assert.equal(q.get("eid"), "42");
  assert.equal(q.get("uid"), "alice");
});

// ---------- XSS 辅助 ----------

test("xss: escapeHtml 基础转义", () => {
  assert.equal(escapeHtml("<script>alert(1)</script>"),
               "&lt;script&gt;alert(1)&lt;/script&gt;");
  assert.equal(escapeHtml(`"a"&'b'`), "&quot;a&quot;&amp;&#39;b&#39;");
  assert.equal(escapeHtml(null), "");
});

test("xss: isSafeUrl 拒 javascript:", () => {
  assert.equal(isSafeUrl("javascript:alert(1)").safe, false);
  assert.equal(isSafeUrl("JAVASCRIPT:alert(1)").safe, false);
  assert.equal(isSafeUrl("data:text/html,<script>").safe, false);
  assert.equal(isSafeUrl("vbscript:msgbox").safe, false);
  assert.equal(isSafeUrl("file:///etc/passwd").safe, false);
});

test("xss: isSafeUrl 允许 http/https/feishu/相对路径", () => {
  assert.equal(isSafeUrl("https://open.feishu.cn").safe, true);
  assert.equal(isSafeUrl("http://internal:3001").safe, true);
  assert.equal(isSafeUrl("feishu://msg/chat/xxx").safe, true);
  assert.equal(isSafeUrl("/api/bug/report/1").safe, true);
  assert.equal(isSafeUrl("./relative").safe, true);
});

test("xss: textifyForReport 保留内容但转义 HTML", () => {
  const r = textifyForReport("<img onerror=alert(1) src=x>");
  assert.ok(!r.includes("<img"));
  assert.ok(r.includes("&lt;img"));
});

test("xss: defaultCSPHeader 包含关键指令", () => {
  const csp = defaultCSPHeader("nonce-abc");
  assert.ok(csp.includes("default-src 'self'"));
  assert.ok(csp.includes("'nonce-nonce-abc'"));
  assert.ok(csp.includes("frame-ancestors 'none'"));
});
