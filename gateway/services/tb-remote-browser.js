/**
 * Teambition 远程浏览器登录（CDP screencast）
 * 服务器 Chromium 打开 TB 登录页，画面经 WS 推到 /tb-browser，登录态写入持久 Profile + config cookie。
 */
import puppeteer from "puppeteer-core";
import { mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";
import {
  TB_LOGIN_URL,
  TB_VIEWER_PATH,
  findBrowser,
  broadcastLoginStatus,
  saveTbLoginToConfig,
  waitForVerifiedTbLogin,
} from "./tb-browser-shared.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
export const TB_PROFILE_DIR = path.join(REPO_ROOT, "gateway", ".tmp", "tb-web-profile");

const PHASE = {
  NOT_LOGGED_IN: "NOT_LOGGED_IN",
  WAITING_FOR_SCAN: "WAITING_FOR_SCAN",
  VERIFYING: "VERIFYING",
  READY: "READY",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
  TIMEOUT: "TIMEOUT",
};

const MAX_WAIT_MS = 5 * 60 * 1000;
const POLL_MS = 2000;
const VIEWPORT = { width: 1280, height: 800 };
/** 客户端关掉 /tb-browser 后，给短暂重连窗口，再释放服务器 Chromium 会话 */
const VIEWER_GONE_GRACE_MS = 2500;
const TERMINAL_STATUS_TTL_MS = 30_000;

let session = null;
let viewerGoneTimer = null;
let lastRemoteStatus = null;
let terminalStatusTimer = null;
const viewerSessions = new WeakMap();

function clearViewerGoneTimer() {
  if (viewerGoneTimer) {
    clearTimeout(viewerGoneTimer);
    viewerGoneTimer = null;
  }
}

function clearTerminalStatusTimer() {
  if (terminalStatusTimer) {
    clearTimeout(terminalStatusTimer);
    terminalStatusTimer = null;
  }
}

function pruneDeadViewers(target = session) {
  if (!target?.viewers) return 0;
  for (const ws of [...target.viewers]) {
    // 1=OPEN；其余视为已断开
    if (!ws || ws.readyState !== 1) target.viewers.delete(ws);
  }
  return target.viewers.size;
}

export function countLiveRemoteViewers() {
  return pruneDeadViewers();
}

function canAutoReplaceBusySession() {
  if (!session?.busy) return true;
  // 验证中尽量别打断（临门一脚）
  if (session.phase === PHASE.VERIFYING) return false;
  return pruneDeadViewers() === 0;
}

export { canAutoReplaceBusySession as _canAutoReplaceBusySessionForTests };

function scheduleReleaseWhenViewersGone(target = session) {
  clearViewerGoneTimer();
  if (!target?.busy || session !== target) return;
  if (target.phase === PHASE.VERIFYING || target.phase === PHASE.READY) return;
  if (pruneDeadViewers(target) > 0) return;
  viewerGoneTimer = setTimeout(() => {
    viewerGoneTimer = null;
    if (session !== target || !target.busy) return;
    if (target.phase === PHASE.VERIFYING || target.phase === PHASE.READY) return;
    if (pruneDeadViewers(target) > 0) return;
    log("system", "info", "tb-remote", "远程扫码页已全部关闭，释放登录会话");
    cancelRemoteLogin().catch(() => {});
  }, VIEWER_GONE_GRACE_MS);
}

function emptyStatus() {
  return {
    mode: "remote",
    phase: PHASE.NOT_LOGGED_IN,
    status: "idle",
    message: "",
    busy: false,
    _updatedAt: 0,
    viewerUrl: TB_VIEWER_PATH,
    profileDir: "gateway/.tmp/tb-web-profile",
  };
}

export function getRemoteLoginStatus() {
  if (!session) return lastRemoteStatus ? { ...lastRemoteStatus } : emptyStatus();
  return sessionStatus(session);
}

function sessionStatus(value) {
  return {
    mode: "remote",
    phase: value.phase,
    status: value.status,
    message: value.message,
    busy: Boolean(value.busy),
    viewerUrl: TB_VIEWER_PATH,
    profileDir: "gateway/.tmp/tb-web-profile",
    user: value.user || undefined,
    userId: value.userId || undefined,
    _updatedAt: value.updatedAt || value._updatedAt || 0,
  };
}

function rememberRemoteStatus(value) {
  lastRemoteStatus = { ...value, busy: false };
  clearTerminalStatusTimer();
  if (!["success", "failed", "timeout", "cancelled"].includes(value.status)) return;
  const remembered = lastRemoteStatus;
  terminalStatusTimer = setTimeout(() => {
    terminalStatusTimer = null;
    if (lastRemoteStatus === remembered) lastRemoteStatus = null;
  }, TERMINAL_STATUS_TTL_MS);
  terminalStatusTimer.unref?.();
}

function publishDetachedStatus(status, message, phase, extra = {}) {
  const value = {
    ...emptyStatus(),
    status,
    message,
    phase,
    _updatedAt: Date.now(),
    ...extra,
  };
  rememberRemoteStatus(value);
  broadcastLoginStatus(status, message, {
    mode: "remote",
    viewerUrl: TB_VIEWER_PATH,
    phase,
    ...extra,
  });
  return value;
}

function setSessionState(target, status, message, phase, extra = {}) {
  if (!target || session !== target) return false;
  target.status = status;
  target.message = message;
  if (phase) target.phase = phase;
  target.updatedAt = Date.now();
  Object.assign(target, extra);
  rememberRemoteStatus(sessionStatus(target));
  broadcastLoginStatus(status, message, {
    mode: "remote",
    viewerUrl: TB_VIEWER_PATH,
    phase: target.phase,
    ...extra,
  });
  const payload = JSON.stringify({
    type: "tb_login_status",
    data: {
      status,
      message,
      mode: "remote",
      viewerUrl: TB_VIEWER_PATH,
      phase: target.phase,
      ...extra,
    },
  });
  for (const viewer of target.viewers || []) {
    if (viewer.readyState === 1) {
      try { viewer.send(payload); } catch {}
    }
  }
  return true;
}

function broadcastFrame(target, data, metadata = {}) {
  if (session !== target || !target?.viewers?.size) return;
  const payload = JSON.stringify({
    type: "tb_browser_frame",
    data: {
      image: data,
      width: metadata.deviceWidth || VIEWPORT.width,
      height: metadata.deviceHeight || VIEWPORT.height,
      phase: target.phase,
      status: target.status,
      message: target.message,
    },
  });
  for (const ws of target.viewers) {
    if (ws.readyState === 1) {
      try { ws.send(payload); } catch {}
    }
  }
}

export function attachTbBrowserViewer(ws) {
  if (!session) {
    try {
      ws.send(JSON.stringify({
        type: "tb_login_status",
        data: { status: "failed", message: "当前没有进行中的远程登录会话", mode: "remote", phase: PHASE.NOT_LOGGED_IN },
      }));
    } catch {}
    return false;
  }
  clearViewerGoneTimer();
  const target = session;
  target.viewers.add(ws);
  viewerSessions.set(ws, target);
  try {
    ws.send(JSON.stringify({
      type: "tb_login_status",
      data: {
        status: target.status,
        message: target.message,
        mode: "remote",
        viewerUrl: TB_VIEWER_PATH,
        phase: target.phase,
      },
    }));
  } catch {}
  const onClose = () => {
    target.viewers?.delete(ws);
    viewerSessions.delete(ws);
    scheduleReleaseWhenViewersGone(target);
  };
  ws.on("close", onClose);
  ws.on("error", onClose);
  return true;
}

/** 客户端显式离开扫码页（关闭窗口 / 刷新前） */
export function detachTbBrowserViewer(ws) {
  const target = viewerSessions.get(ws) || session;
  if (!target?.viewers) return false;
  const had = target.viewers.delete(ws);
  viewerSessions.delete(ws);
  if (had) scheduleReleaseWhenViewersGone(target);
  return had;
}

export async function handleTbBrowserInput(event = {}) {
  if (!session?.page || !session?.cdp) return false;
  if (![PHASE.WAITING_FOR_SCAN, PHASE.VERIFYING, PHASE.NOT_LOGGED_IN].includes(session.phase)) return false;

  const type = String(event.type || "");
  try {
    if (type === "click" || type === "mousedown" || type === "mouseup" || type === "mousemove") {
      const x = Number(event.x);
      const y = Number(event.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
      const button = event.button === "right" ? "right" : event.button === "middle" ? "middle" : "left";
      const map = {
        mousedown: "mousePressed",
        mouseup: "mouseReleased",
        mousemove: "mouseMoved",
        click: null,
      };
      if (type === "click") {
        await session.cdp.send("Input.dispatchMouseEvent", {
          type: "mousePressed", x, y, button, clickCount: 1,
        });
        await session.cdp.send("Input.dispatchMouseEvent", {
          type: "mouseReleased", x, y, button, clickCount: 1,
        });
      } else {
        await session.cdp.send("Input.dispatchMouseEvent", {
          type: map[type],
          x,
          y,
          button,
          clickCount: type === "mousedown" || type === "mouseup" ? 1 : 0,
        });
      }
      return true;
    }
    if (type === "wheel") {
      await session.cdp.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: Number(event.x) || 0,
        y: Number(event.y) || 0,
        deltaX: Number(event.deltaX) || 0,
        deltaY: Number(event.deltaY) || 0,
      });
      return true;
    }
    if (type === "keydown" || type === "keyup" || type === "keypress") {
      const key = String(event.key || "");
      if (!key) return false;
      await session.cdp.send("Input.dispatchKeyEvent", {
        type: type === "keyup" ? "keyUp" : type === "keypress" ? "char" : "keyDown",
        key,
        code: event.code || undefined,
        text: type === "keypress" ? key : undefined,
        windowsVirtualKeyCode: event.keyCode || undefined,
        nativeVirtualKeyCode: event.keyCode || undefined,
      });
      return true;
    }
  } catch (err) {
    log("system", "warn", "tb-remote", `输入转发失败: ${err.message}`);
  }
  return false;
}

async function startScreencast(page, target) {
  const cdp = await page.createCDPSession();
  await cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality: 55,
    maxWidth: VIEWPORT.width,
    maxHeight: VIEWPORT.height,
    everyNthFrame: 1,
  });
  cdp.on("Page.screencastFrame", async (frame) => {
    try {
      broadcastFrame(target, frame.data, frame.metadata || {});
      await cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId });
    } catch {}
  });
  return cdp;
}

async function cleanupBrowser(target) {
  if (!target) return;
  const cdp = target.cdp;
  const browser = target.browser;
  target.cdp = null;
  target.browser = null;
  target.page = null;
  try { await cdp?.send("Page.stopScreencast").catch(() => {}); } catch {}
  try { await browser?.close(); } catch {}
  for (const ws of target.viewers || []) {
    try { /* keep socket; just detach */ } catch {}
  }
}

/**
 * 启动远程登录会话（同步返回 viewerUrl；后台继续轮询）
 */
export async function startRemoteLoginSession({
  browserPath = findBrowser(),
  launch = puppeteer.launch.bind(puppeteer),
  waitForLogin = waitForVerifiedTbLogin,
  onVerified = () => {},
  onFailed = () => {},
} = {}) {
  if (session?.busy) {
    if (canAutoReplaceBusySession()) {
      log("system", "info", "tb-remote", "检测到旧会话无活跃扫码页，自动替换后重新启动");
      await cancelRemoteLogin();
    } else {
      return {
        success: false,
        mode: "remote",
        viewerUrl: TB_VIEWER_PATH,
        error: "已有登录窗口打开中，请完成或关闭后重试",
        phase: session.phase,
      };
    }
  }

  if (session && !session.busy) session = null;
  clearTerminalStatusTimer();
  lastRemoteStatus = null;
  if (!browserPath) {
    const error = "未找到 Chromium/Chrome，请安装后重试（或设置 BROWSER_PATH）";
    publishDetachedStatus("failed", error, PHASE.FAILED);
    return {
      success: false,
      mode: "remote",
      error,
      phase: PHASE.FAILED,
    };
  }

  mkdirSync(TB_PROFILE_DIR, { recursive: true });
  clearViewerGoneTimer();

  session = {
    busy: true,
    cancelled: false,
    phase: PHASE.NOT_LOGGED_IN,
    status: "launching",
    message: "正在启动远程浏览器...",
    viewers: new Set(),
    browser: null,
    page: null,
    cdp: null,
    onFailed,
    updatedAt: Date.now(),
  };
  const current = session;

  setSessionState(current, "launching", "正在启动远程浏览器...", PHASE.NOT_LOGGED_IN);

  try {
    const browser = await launch({
      executablePath: browserPath,
      headless: "new",
      userDataDir: TB_PROFILE_DIR,
      defaultViewport: VIEWPORT,
      args: [
        "--no-first-run",
        "--disable-extensions",
        "--disable-default-apps",
        "--disable-dev-shm-usage",
        "--no-sandbox",
        "--disable-gpu",
        "--window-size=1280,800",
        "--disable-blink-features=AutomationControlled",
      ],
    });
    if (session !== current || current.cancelled) {
      try { await browser.close(); } catch {}
      return { success: false, mode: "remote", error: "登录已取消", phase: PHASE.CANCELLED };
    }
    current.browser = browser;

    const page = await browser.newPage();
    if (session !== current || current.cancelled) {
      await cleanupBrowser(current);
      return { success: false, mode: "remote", error: "登录已取消", phase: PHASE.CANCELLED };
    }
    current.page = page;
    await page.setViewport(VIEWPORT);
    current.cdp = await startScreencast(page, current);

    await page.goto(TB_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
    if (session !== current || current.cancelled) {
      await cleanupBrowser(current);
      return { success: false, mode: "remote", error: "登录已取消", phase: PHASE.CANCELLED };
    }
    setSessionState(current, "waiting", "请在远程浏览器页面中扫码登录 Teambition...", PHASE.WAITING_FOR_SCAN);
    log("system", "info", "tb-remote", `远程登录会话已启动: ${browserPath}`);

    // 后台轮询，不阻塞 API 返回
    (async () => {
      try {
        const login = await waitForLogin({
          page,
          browser,
          isCancelled: () => session !== current || current.cancelled,
          maxWaitMs: MAX_WAIT_MS,
          pollMs: POLL_MS,
          onState: ({ status, message }) => setSessionState(
            current,
            status,
            message,
            status === "verifying" ? PHASE.VERIFYING : PHASE.WAITING_FOR_SCAN,
          ),
        });
        if (session !== current || current.cancelled) return;
        if (!login.success) {
          try { onFailed(login); } catch {}
          if (!current.cancelled) {
            const timedOut = login.reason === "timeout";
            setSessionState(
              current,
              timedOut ? "timeout" : "failed",
              timedOut ? "登录超时（5 分钟），请重试" : "登录窗口已关闭，请重试",
              timedOut ? PHASE.TIMEOUT : PHASE.FAILED,
            );
          }
          return;
        }
        const { cookie, userInfo } = login;
        saveTbLoginToConfig(userInfo, cookie);
        try { onVerified(userInfo); } catch {}
        const msg = `登录成功：${userInfo.name}（ID: ${userInfo.userId?.slice(-6) || "-"}）`;
        setSessionState(current, "success", msg, PHASE.READY, { user: userInfo.name, userId: userInfo.userId });
        log("system", "info", "tb-remote", `远程 Cookie 提取成功: ${userInfo.name} (${userInfo.userId})`);
      } catch (err) {
        try { onFailed({ success: false, error: err.message }); } catch {}
        if (session === current && !current.cancelled) {
          setSessionState(current, "failed", `登录失败: ${err.message}`, PHASE.FAILED);
          log("system", "error", "tb-remote", `远程提取失败: ${err.message}`);
        }
      } finally {
        await cleanupBrowser(current);
        current.busy = false;
        if (session === current) {
          // 保留 phase/status 供 status API 读取一会儿
          const timer = setTimeout(() => {
            if (session === current && !current.busy) session = null;
          }, TERMINAL_STATUS_TTL_MS);
          timer.unref?.();
        }
      }
    })();

    return {
      success: true,
      mode: "remote",
      viewerUrl: TB_VIEWER_PATH,
      message: "远程浏览器已启动，请在弹出的页面中扫码",
      phase: PHASE.WAITING_FOR_SCAN,
    };
  } catch (err) {
    if (session === current && !current.cancelled) {
      setSessionState(current, "failed", `登录失败: ${err.message}`, PHASE.FAILED);
      log("system", "error", "tb-remote", `启动失败: ${err.message}`);
    }
    await cleanupBrowser(current);
    current.busy = false;
    if (session === current) session = null;
    return {
      success: false,
      mode: "remote",
      error: err.message,
      phase: PHASE.FAILED,
    };
  }
}

export async function cancelRemoteLogin() {
  if (!session) return false;
  const current = session;
  clearViewerGoneTimer();
  current.cancelled = true;
  try { current.onFailed?.({ success: false, reason: "cancelled" }); } catch {}
  setSessionState(current, "cancelled", "登录已取消", PHASE.CANCELLED);
  await cleanupBrowser(current);
  current.busy = false;
  if (session === current) session = null;
  return true;
}

/** 测试辅助：重置模块态 */
export function _resetRemoteSessionForTests() {
  clearViewerGoneTimer();
  clearTerminalStatusTimer();
  session = null;
  lastRemoteStatus = null;
}

/** 测试辅助：注入假会话 */
export function _setRemoteSessionForTests( partial = {}) {
  clearViewerGoneTimer();
  session = {
    busy: true,
    cancelled: false,
    phase: PHASE.WAITING_FOR_SCAN,
    status: "waiting",
    message: "test",
    viewers: new Set(),
    browser: null,
    page: null,
    cdp: null,
    ...partial,
  };
  return session;
}
