/**
 * Teambition Cookie 自动提取器
 * - 本机 GUI：headed Chrome/Edge 弹窗扫码
 * - 无桌面 Linux：远程 CDP screencast（/tb-browser）
 */
import puppeteer from "puppeteer-core";
import { log } from "./logger.js";
import {
  TB_LOGIN_URL,
  findBrowser,
  canUseLocalGuiBrowser,
  broadcastLoginStatus,
  saveTbLoginToConfig,
  waitForVerifiedTbLogin,
} from "./tb-browser-shared.js";
import { startRemoteLoginSession, cancelRemoteLogin, getRemoteLoginStatus } from "./tb-remote-browser.js";

let activeBrowser = null;
let localSession = null;
let localStatus = emptyLocalStatus();

function emptyLocalStatus() {
  return {
    mode: "local",
    phase: "NOT_LOGGED_IN",
    status: "idle",
    message: "",
    busy: false,
  };
}

function setLocalStatus(status, message, phase, extra = {}) {
  localStatus = {
    ...localStatus,
    status,
    message,
    phase: phase || localStatus.phase,
    updatedAt: Date.now(),
    ...extra,
  };
  broadcastLoginStatus(status, message, {
    mode: "local",
    phase: localStatus.phase,
    ...extra,
  });
}

function setLocalSessionStatus(target, status, message, phase, extra = {}) {
  if (!target || localSession !== target) return false;
  setLocalStatus(status, message, phase, extra);
  return true;
}

function retainCompletedLocalStatus() {
  const completedAt = localStatus.updatedAt;
  const timer = setTimeout(() => {
    if (!localStatus.busy && localStatus.updatedAt === completedAt) localStatus = emptyLocalStatus();
  }, 30_000);
  timer.unref?.();
}

export function getTbLoginStatus() {
  const remote = getRemoteLoginStatus();
  const localActive = localStatus.busy || localStatus.status !== "idle";
  const remoteActive = remote?.busy || remote?.status !== "idle";
  const useLocal = localStatus.busy
    || (!remote?.busy && localActive && (!remoteActive || (localStatus.updatedAt || 0) >= (remote?._updatedAt || 0)));
  const selected = useLocal ? localStatus : remote;
  const { updatedAt: _updatedAt, _updatedAt: _remoteUpdatedAt, cancelled: _cancelled, ...publicStatus } = selected;
  return publicStatus;
}

/**
 * 启动登录并提取 Cookie。
 * @returns {Promise<{success: boolean, mode?: string, viewerUrl?: string, cookie?: string, user?: string, error?: string, phase?: string, message?: string}>}
 */
export async function extractTbCookie(options = {}) {
  if (canUseLocalGuiBrowser()) {
    return extractTbCookieLocal(options);
  }
  return startRemoteLoginSession(options);
}

async function extractTbCookieLocal({
  browserPath = findBrowser(),
  launch = puppeteer.launch.bind(puppeteer),
  waitForLogin = waitForVerifiedTbLogin,
  onVerified = () => {},
} = {}) {
  if (localStatus.busy || activeBrowser || localSession) {
    return { success: false, mode: "local", error: "已有登录窗口打开中，请完成或关闭后重试" };
  }

  if (!browserPath) {
    const error = "未找到 Chrome/Edge 浏览器，请安装后重试";
    setLocalStatus("failed", error, "FAILED", { busy: false });
    retainCompletedLocalStatus();
    return { success: false, mode: "local", error };
  }

  log("system", "info", "tb-cookie", `启动本机浏览器: ${browserPath}`);
  const current = { browser: null, cancelled: false };
  localSession = current;
  setLocalSessionStatus(current, "launching", "正在启动浏览器…", "NOT_LOGGED_IN", { busy: true, cancelled: false });

  try {
    const browser = await launch({
      executablePath: browserPath,
      headless: false,
      defaultViewport: { width: 1200, height: 800 },
      args: [
        "--no-first-run",
        "--disable-extensions",
        "--disable-default-apps",
        "--window-size=1200,800",
      ],
    });
    if (localSession !== current || current.cancelled) {
      try { await browser.close(); } catch {}
      return { success: false, mode: "local", error: "登录已取消" };
    }
    current.browser = browser;
    activeBrowser = browser;

    const page = await browser.newPage();
    await page.goto(TB_LOGIN_URL, { waitUntil: "networkidle2", timeout: 30000 });
    if (localSession !== current || current.cancelled) {
      return { success: false, mode: "local", error: "登录已取消" };
    }

    setLocalSessionStatus(current, "waiting", "请在弹出的浏览器中完成 Teambition 登录…", "WAITING_FOR_SCAN", { busy: true });
    log("system", "info", "tb-cookie", "等待用户登录...");

    const login = await waitForLogin({
      page,
      browser,
      isCancelled: () => localSession !== current || current.cancelled,
      onState: ({ status, message }) => setLocalSessionStatus(
        current,
        status,
        message,
        status === "verifying" ? "VERIFYING" : "WAITING_FOR_SCAN",
        { busy: true },
      ),
    });

    if (localSession !== current || current.cancelled) {
      return { success: false, mode: "local", error: "登录已取消" };
    }

    if (login.success) {
      const { cookie, userInfo } = login;
      saveTbLoginToConfig(userInfo, cookie);
      try { onVerified(userInfo); } catch {}
      const msg = `登录成功：${userInfo.name}（ID: ${userInfo.userId?.slice(-6) || "-"}）`;
      setLocalSessionStatus(current, "success", msg, "READY", {
        busy: false,
        user: userInfo.name,
        userId: userInfo.userId,
      });
      log("system", "info", "tb-cookie", `Cookie 提取成功: ${userInfo.name} (${userInfo.userId})`);
      return { success: true, mode: "local", cookie, user: userInfo.name, userId: userInfo.userId, message: msg };
    }

    if (login.reason === "cancelled") {
      return { success: false, mode: "local", error: "登录已取消" };
    }
    const timedOut = login.reason === "timeout";
    const error = timedOut ? "登录超时（5 分钟），请重试" : "登录窗口已关闭，请重试";
    setLocalSessionStatus(current, timedOut ? "timeout" : "failed", error, timedOut ? "TIMEOUT" : "FAILED", { busy: false });
    return { success: false, mode: "local", error };
  } catch (err) {
    if (localSession !== current || current.cancelled) {
      return { success: false, mode: "local", error: "登录已取消" };
    }
    setLocalSessionStatus(current, "failed", `登录失败：${err.message}`, "FAILED", { busy: false });
    log("system", "error", "tb-cookie", `提取失败: ${err.message}`);
    return { success: false, mode: "local", error: err.message };
  } finally {
    const browser = current.browser;
    current.browser = null;
    if (activeBrowser === browser) activeBrowser = null;
    if (browser) {
      try { await browser.close(); } catch {}
    }
    if (localSession === current) {
      localSession = null;
      localStatus.busy = false;
      retainCompletedLocalStatus();
    }
  }
}

/**
 * 取消正在进行的登录（本机或远程）
 */
export async function cancelTbLogin() {
  let cancelled = false;
  const current = localSession;
  if (current || activeBrowser || localStatus.busy) {
    if (current) current.cancelled = true;
    const browser = current?.browser || activeBrowser;
    if (activeBrowser === browser) activeBrowser = null;
    if (browser) {
      if (current?.browser === browser) current.browser = null;
      try { await browser.close(); } catch {}
    }
    if (!current || localSession === current) {
      if (localSession === current) localSession = null;
      setLocalStatus("cancelled", "登录已取消", "CANCELLED", { busy: false, cancelled: true });
      retainCompletedLocalStatus();
    }
    cancelled = true;
  }
  const remoteCancelled = await cancelRemoteLogin();
  return cancelled || remoteCancelled;
}

export { canUseLocalGuiBrowser, findBrowser } from "./tb-browser-shared.js";

/** 测试辅助：用可控浏览器/轮询验证本机会话代际隔离。 */
export function _extractTbCookieLocalForTests(options = {}) {
  return extractTbCookieLocal(options);
}

export async function _resetLocalSessionForTests() {
  const current = localSession;
  if (current) current.cancelled = true;
  const browser = current?.browser || activeBrowser;
  current && (current.browser = null);
  activeBrowser = null;
  localSession = null;
  try { await browser?.close(); } catch {}
  localStatus = emptyLocalStatus();
}
