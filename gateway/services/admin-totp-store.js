/**
 * 管理后台超管 TOTP 密钥存取。
 * 密钥落到 gateway/.secrets/admin-totp.json（已在 .gitignore，严禁提交）。
 * 首次访问自动生成；enrolled 标记首次绑定成功后，setup 接口不再向远端泄露密钥。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { randomBase32Secret, buildOtpauthUrl } from "./totp.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// 密钥目录（测试可用 ADMIN_TOTP_DIR 覆盖，避免动到真实密钥）
const SECRET_DIR = process.env.ADMIN_TOTP_DIR || join(__dirname, "..", ".secrets");
export const SECRET_PATH = join(SECRET_DIR, "admin-totp.json");

let cache = null;

function load() {
  if (cache) return cache;
  if (existsSync(SECRET_PATH)) {
    try { cache = JSON.parse(readFileSync(SECRET_PATH, "utf8")); return cache; } catch { /* 损坏则重建 */ }
  }
  return null;
}

function persist(data) {
  if (!existsSync(SECRET_DIR)) mkdirSync(SECRET_DIR, { recursive: true });
  writeFileSync(SECRET_PATH, JSON.stringify(data, null, 2), "utf8");
  cache = data;
}

/** 取得（必要时生成）超管 TOTP 配置。返回 { secret, otpauth, account, issuer, enrolled, createdAt }。 */
export function getTotpConfig() {
  let data = load();
  if (!data) {
    const account = "superadmin";
    const issuer = "AIEfficiency Admin";
    const secret = randomBase32Secret();
    data = { secret, account, issuer, otpauth: buildOtpauthUrl({ secret, account, issuer }), enrolled: false, createdAt: new Date().toISOString() };
    persist(data);
  }
  return data;
}

/** 首次校验成功后标记已绑定（之后 setup 不再对远端暴露密钥）。 */
export function markEnrolled() {
  const data = getTotpConfig();
  if (!data.enrolled) { data.enrolled = true; persist(data); }
}

/** 重置密钥（丢手机/换设备时本机重新绑定）。返回新配置。 */
export function resetTotp() {
  const account = "superadmin", issuer = "AIEfficiency Admin";
  const secret = randomBase32Secret();
  const data = { secret, account, issuer, otpauth: buildOtpauthUrl({ secret, account, issuer }), enrolled: false, createdAt: new Date().toISOString() };
  persist(data);
  return data;
}
