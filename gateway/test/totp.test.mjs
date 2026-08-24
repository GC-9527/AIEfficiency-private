/**
 * TOTP（RFC 6238）单元测试：标准向量、base32 往返、校验时间窗、边界/异常输入、otpauth URL。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { totp, verifyTotp, base32Decode, randomBase32Secret, buildOtpauthUrl } from "../services/totp.js";

// RFC 6238 测试向量：secret = ASCII "12345678901234567890" → base32
const SEC = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

test("RFC6238 标准向量（8 位）", () => {
  assert.equal(totp(SEC, { time: 59000, digits: 8 }), "94287082");
  assert.equal(totp(SEC, { time: 1111111109000, digits: 8 }), "07081804");
  assert.equal(totp(SEC, { time: 1234567890000, digits: 8 }), "89005924");
  assert.equal(totp(SEC, { time: 2000000000000, digits: 8 }), "69279037");
});

test("6 位码 = 8 位码后 6 位", () => {
  assert.equal(totp(SEC, { time: 59000, digits: 6 }), "287082");
});

test("base32 解码（忽略空格/小写/padding）", () => {
  const a = base32Decode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  assert.equal(a.toString("ascii"), "12345678901234567890");
  // 大小写/空格/padding 等价
  assert.deepEqual(base32Decode("gezd gnbv === "), base32Decode("GEZDGNBV"));
});

test("randomBase32Secret 长度与字符集", () => {
  const s = randomBase32Secret();
  assert.match(s, /^[A-Z2-7]+$/);
  assert.equal(s.length, 32); // 20 字节 → 32 个 base32 字符
  assert.notEqual(randomBase32Secret(), randomBase32Secret()); // 随机
});

test("verifyTotp 正确码通过、错误码拒绝", () => {
  const now = 1700000000000;
  const code = totp(SEC, { time: now });
  assert.equal(verifyTotp(SEC, code, { time: now }), true);
  assert.equal(verifyTotp(SEC, "000000", { time: now }), false);
  assert.equal(verifyTotp(SEC, code.split("").reverse().join(""), { time: now }), false);
});

test("verifyTotp 时间窗容忍 ±1 步（30s）", () => {
  const now = 1700000000000;
  const prev = totp(SEC, { time: now - 30000 });
  const next = totp(SEC, { time: now + 30000 });
  assert.equal(verifyTotp(SEC, prev, { time: now }), true, "前一窗口应通过");
  assert.equal(verifyTotp(SEC, next, { time: now }), true, "后一窗口应通过");
  // 超出窗口（±2 步）应拒绝
  const far = totp(SEC, { time: now + 90000 });
  assert.equal(verifyTotp(SEC, far, { time: now }), false, "±3 步应拒绝");
});

test("verifyTotp 边界/异常输入", () => {
  const now = Date.now();
  assert.equal(verifyTotp(SEC, "", { time: now }), false);
  assert.equal(verifyTotp(SEC, null, { time: now }), false);
  assert.equal(verifyTotp(SEC, "12345", { time: now }), false, "非 6 位拒绝");
  assert.equal(verifyTotp(SEC, "abcdef", { time: now }), false, "非数字拒绝");
  assert.equal(verifyTotp(SEC, " 287082 ", { time: 59000 }), true, "去空白后匹配");
});

test("buildOtpauthUrl 结构", () => {
  const url = buildOtpauthUrl({ secret: "ABC", account: "superadmin", issuer: "X" });
  assert.match(url, /^otpauth:\/\/totp\//);
  assert.match(url, /secret=ABC/);
  assert.match(url, /period=30/);
  assert.match(url, /digits=6/);
});
