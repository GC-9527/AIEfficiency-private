/**
 * Teambition 浏览器登录共享工具（本机弹窗 / 远程 screencast 共用）
 */
import { existsSync } from "fs";
import { broadcastAll } from "./logger.js";
import { getConfig, updateConfig } from "./config.js";

export const TB_LOGIN_URL = "https://account.teambition.com/login";
export const TB_VIEWER_PATH = "/tb-browser";
export const TB_USER_INFO_URL = "https://www.teambition.com/api/users/me";

export const TB_COOKIE_STATUS = Object.freeze({
  VALID: "valid",
  MISSING: "missing",
  EXPIRED: "expired",
  INVALID: "invalid",
  UNAVAILABLE: "unavailable",
});

export const BROWSER_PATHS = [
  process.env.BROWSER_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  "/snap/bin/chromium",
].filter(Boolean);

export function findBrowser() {
  for (const p of BROWSER_PATHS) {
    if (p && existsSync(p)) return p;
  }
  return null;
}

/**
 * 本机有 GUI 时可直接 headed 弹窗；Linux 无 DISPLAY 时走远程 viewer。
 */
export function canUseLocalGuiBrowser({ platform = process.platform, env = process.env, browserPath = findBrowser() } = {}) {
  if (!browserPath) return false;
  if (platform === "win32" || platform === "darwin") return true;
  return Boolean(String(env.DISPLAY || "").trim());
}

export function broadcastLoginStatus(status, message, extra = {}) {
  broadcastAll(JSON.stringify({ type: "tb_login_status", data: { status, message, ...extra } }));
}

function result(status, code, reason, extra = {}, now = Date.now) {
  return {
    valid: status === TB_COOKIE_STATUS.VALID,
    status,
    code,
    reason,
    checkedAt: new Date(now()).toISOString(),
    ...extra,
  };
}

function responseMessage(body, secret = "") {
  if (!body || typeof body !== "object") return "";
  const message = String(body.message || body.error || body.error_description || "").trim();
  return secret && message.includes(secret) ? message.split(secret).join("[已隐藏]") : message;
}

/**
 * 验证用户 Cookie，并区分缺失、过期、格式无效和 TB 服务不可用。
 * Cookie 只进入请求头，不会出现在返回对象、日志或错误消息中。
 */
export async function probeTbCookie(cookie, { request = globalThis.fetch, now = Date.now } = {}) {
  const value = String(cookie || "").trim();
  if (!value) {
    return result(TB_COOKIE_STATUS.MISSING, "COOKIE_MISSING", "尚未保存 Teambition 登录信息", { hasCookie: false }, now);
  }
  if (typeof request !== "function") {
    return result(TB_COOKIE_STATUS.UNAVAILABLE, "TB_UNAVAILABLE", "当前环境无法连接 Teambition", { hasCookie: true }, now);
  }

  try {
    const resp = await request(TB_USER_INFO_URL, {
      headers: { Cookie: value, Accept: "application/json" },
      redirect: "manual",
    });
    const httpStatus = Number(resp?.status || 0);
    const location = String(resp?.headers?.get?.("location") || "");
    const isRedirect = [301, 302, 303, 307, 308].includes(httpStatus);
    const isLoginRedirect = /account\.teambition\.com|\/login(?:[/?#]|$)/i.test(location);
    if ([401, 403].includes(httpStatus) || (isRedirect && isLoginRedirect)) {
      return result(TB_COOKIE_STATUS.EXPIRED, "COOKIE_EXPIRED", "登录已过期，请重新登录提取", { hasCookie: true, httpStatus }, now);
    }
    if (isRedirect) {
      return result(TB_COOKIE_STATUS.UNAVAILABLE, "TB_UNAVAILABLE", "Teambition 暂时无法验证，请稍后重试", { hasCookie: true, httpStatus }, now);
    }

    const text = typeof resp?.text === "function" ? await resp.text() : "";
    let data = null;
    try {
      data = text
        ? JSON.parse(text)
        : (typeof resp?.json === "function" ? await resp.json() : null);
    } catch { data = null; }
    const userId = data?._id || data?.id;
    if (resp.ok && userId) {
      const userInfo = {
        userId,
        name: data.name || data.nickname || "(未知用户)",
        email: data.email,
        avatar: data.avatarUrl,
      };
      return result(TB_COOKIE_STATUS.VALID, "COOKIE_VALID", "Cookie 有效", {
        hasCookie: true,
        httpStatus,
        user: userInfo.name,
        id: userInfo.userId,
        userInfo,
      }, now);
    }

    if (httpStatus >= 500 || httpStatus === 408 || httpStatus === 429) {
      return result(TB_COOKIE_STATUS.UNAVAILABLE, "TB_UNAVAILABLE", "Teambition 暂时无法验证，请稍后重试", { hasCookie: true, httpStatus }, now);
    }
    const contentType = String(resp?.headers?.get?.("content-type") || "");
    const responseUrl = String(resp?.url || "");
    const isHtml = /text\/html/i.test(contentType) || /<!doctype|<html/i.test(text);
    if (!data && isHtml) {
      const isLoginHtml = /account\.teambition\.com/i.test(responseUrl)
        || /<title[^>]*>[^<]*(?:登录|登陆|log\s*in|sign\s*in)[^<]*<\/title>/i.test(text)
        || /<input[^>]+(?:name|id)=["'][^"']*(?:password|username|login)[^"']*["']/i.test(text)
        || /<input[^>]+type=["']password["']/i.test(text)
        || /<form[^>]+action=["'][^"']*(?:account\.teambition\.com|\/login)[^"']*["']/i.test(text);
      if (isLoginHtml) {
        return result(TB_COOKIE_STATUS.EXPIRED, "COOKIE_EXPIRED", "登录已过期，请重新登录提取", { hasCookie: true, httpStatus }, now);
      }
      const isTemporaryHtml = /维护|maintenance|temporarily\s+unavailable|service\s+unavailable|系统升级|升级中|稍后(?:再试|重试)|服务繁忙|过载/i.test(text);
      return isTemporaryHtml
        ? result(TB_COOKIE_STATUS.UNAVAILABLE, "TB_UNAVAILABLE", "Teambition 暂时无法验证，请稍后重试", { hasCookie: true, httpStatus }, now)
        : result(TB_COOKIE_STATUS.INVALID, "COOKIE_INVALID", "Teambition 返回了无法识别的页面，请重新登录提取", { hasCookie: true, httpStatus }, now);
    }
    const message = responseMessage(data, value);
    return result(TB_COOKIE_STATUS.INVALID, "COOKIE_INVALID", message || "Cookie 无效，请重新登录提取", { hasCookie: true, httpStatus }, now);
  } catch (error) {
    return result(TB_COOKIE_STATUS.UNAVAILABLE, "TB_UNAVAILABLE", "无法连接 Teambition，请检查网络后重试", { hasCookie: true }, now);
  }
}

export async function fetchTbUserInfo(cookie, options) {
  const health = await probeTbCookie(cookie, options);
  return health.valid ? health.userInfo : null;
}

/** 手工候选 Cookie 也必须先验证，成功后才替换已保存值。 */
export async function verifyAndSaveTbCookie(cookie, { validateCookie = probeTbCookie } = {}) {
  const candidate = String(cookie || "").trim();
  let health;
  try {
    health = await validateCookie(candidate);
  } catch {
    return result(TB_COOKIE_STATUS.UNAVAILABLE, "TB_UNAVAILABLE", "暂时无法验证 Cookie，请稍后重试", { hasCookie: Boolean(candidate) });
  }
  if (!health?.valid || !health.userInfo) return health;
  saveTbLoginToConfig(health.userInfo, candidate);
  return health;
}

/**
 * 浏览器完成跳转后仍要等待 Cookie 真正可用，避免部分/过期 Cookie 被误存。
 */
export async function waitForVerifiedTbLogin({
  page,
  browser,
  isCancelled = () => false,
  onState = () => {},
  validateCookie = probeTbCookie,
  maxWaitMs = 5 * 60 * 1000,
  pollMs = 2000,
  recheckMs = 6000,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const startedAt = now();
  let lastCookie = "";
  let lastCheckedAt = 0;
  let lastHealth = null;

  while (now() - startedAt < maxWaitMs) {
    if (isCancelled()) return { success: false, reason: "cancelled", health: lastHealth };
    if (!browser?.isConnected?.()) return { success: false, reason: "closed", health: lastHealth };
    try {
      if (looksLikeTbWorkspaceUrl(page?.url?.())) {
        const cookies = await page.cookies("https://www.teambition.com");
        const candidate = cookiesToHeader(cookies);
        const currentTime = now();
        if (candidate && (candidate !== lastCookie || currentTime - lastCheckedAt >= recheckMs)) {
          lastCookie = candidate;
          lastCheckedAt = currentTime;
          onState({ status: "verifying", message: "已检测到登录信息，正在验证账号…" });
          lastHealth = await validateCookie(candidate);
          if (lastHealth?.valid && lastHealth.userInfo) {
            return { success: true, cookie: candidate, userInfo: lastHealth.userInfo, health: lastHealth };
          }
          const temporarilyUnavailable = lastHealth?.status === TB_COOKIE_STATUS.UNAVAILABLE;
          onState({
            status: "waiting",
            message: temporarilyUnavailable
              ? "已检测到登录信息，但 Teambition 暂时无法验证；将自动重试…"
              : "登录信息尚未生效，请在浏览器中继续完成登录…",
          });
        }
      }
    } catch {
      if (!browser?.isConnected?.()) return { success: false, reason: "closed", health: lastHealth };
    }
    await sleep(pollMs);
  }

  return { success: false, reason: "timeout", health: lastHealth };
}

export function saveTbLoginToConfig(userInfo, cookie) {
  const config = getConfig();
  const tb = {
    ...(config.teambition || {}),
    userCookie: cookie,
    userCookieUpdatedAt: new Date().toISOString(),
    ...(userInfo.userId ? { operatorId: userInfo.userId } : {}),
  };
  const watcher = {
    ...(config.tbTaskWatcher || {}),
    ...(userInfo.userId ? { executorId: userInfo.userId } : {}),
  };
  updateConfig({ teambition: tb, tbTaskWatcher: watcher });
}

export function cookiesToHeader(cookies = []) {
  return cookies
    .filter((cookie) => cookie?.name && cookie?.value != null)
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

export function looksLikeTbWorkspaceUrl(url = "") {
  try {
    const parsed = new URL(String(url || ""));
    const host = parsed.hostname.toLowerCase();
    return ["teambition.com", "www.teambition.com"].includes(host)
      && !/^\/login(?:[/?#]|$)/i.test(parsed.pathname);
  } catch {
    return false;
  }
}
