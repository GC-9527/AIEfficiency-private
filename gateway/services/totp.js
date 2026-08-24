/**
 * TOTP（RFC 6238 / Google Authenticator 兼容）——纯 Node crypto 实现，零依赖。
 * 用于管理后台超级管理员的动态验证码登录。
 */
import { createHmac, randomBytes } from "crypto";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** 随机生成 base32 密钥（默认 20 字节 = 160bit，Authenticator 标准）。 */
export function randomBase32Secret(bytes = 20) {
  const buf = randomBytes(bytes);
  let bits = "", out = "";
  for (const b of buf) bits += b.toString(2).padStart(8, "0");
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

/** base32 → Buffer（忽略空格/小写/padding）。 */
export function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/=+$/g, "").replace(/\s+/g, "");
  let bits = "";
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) continue;
    bits += idx.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

/** HOTP：给定计数器算 6 位码。 */
function hotp(secretBuf, counter, digits = 6) {
  const buf = Buffer.alloc(8);
  // 8 字节大端计数器（高位用 Math.floor 处理 >32bit）
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = createHmac("sha1", secretBuf).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(bin % 10 ** digits).padStart(digits, "0");
}

/** 当前 TOTP 码。time 为毫秒（默认现在），step 30s。 */
export function totp(secretBase32, { time = Date.now(), step = 30, digits = 6 } = {}) {
  const counter = Math.floor(time / 1000 / step);
  return hotp(base32Decode(secretBase32), counter, digits);
}

/** 校验用户输入的码，允许前后 window 个时间窗（默认 ±1，容忍时钟漂移）。 */
export function verifyTotp(secretBase32, token, { step = 30, digits = 6, window = 1, time = Date.now() } = {}) {
  const t = String(token || "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(t)) return false;
  const secretBuf = base32Decode(secretBase32);
  const counter = Math.floor(time / 1000 / step);
  for (let w = -window; w <= window; w++) {
    if (hotp(secretBuf, counter + w, digits) === t) return true;
  }
  return false;
}

/** 构造 otpauth:// URL（供 Authenticator 扫码/导入）。 */
export function buildOtpauthUrl({ secret, account = "superadmin", issuer = "AIEfficiency Admin" }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: "SHA1", digits: "6", period: "30" });
  return `otpauth://totp/${label}?${params.toString()}`;
}
