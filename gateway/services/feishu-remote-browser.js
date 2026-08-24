/**
 * 飞书项目远程浏览器（CDP screencast）
 * 无桌面 Linux：服务器 Chromium 打开飞书登录/MCP 页，画面推到 /feishu-browser。
 * Profile 与 feishu-web-session 共用 gateway/.tmp/feishu-project-web-profile。
 */
import puppeteer from "puppeteer-core";
import { mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";
import {
  FEISHU_MCP_PAGE_URL,
  FEISHU_TENANT_PICKER_URL,
  FEISHU_ACCOUNT_HOME_URL,
  FEISHU_VIEWER_PATH,
  FEISHU_PROFILE_REL,
  findBrowser,
  broadcastFeishuBrowserStatus,
  saveFeishuMcpTokenToConfig,
  getFeishuProjectWarmupUrl,
} from "./feishu-browser-shared.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
export const FEISHU_PROFILE_DIR = path.join(REPO_ROOT, "gateway", ".tmp", "feishu-project-web-profile");

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
const POLL_MS = 2500;
const TENANT_WAIT_MS = 4500;
const VIEWPORT = { width: 1440, height: 900 };
const VIEWER_GONE_GRACE_MS = 2500;

let session = null;
let viewerGoneTimer = null;

function clearViewerGoneTimer() {
  if (viewerGoneTimer) {
    clearTimeout(viewerGoneTimer);
    viewerGoneTimer = null;
  }
}

function pruneDeadViewers() {
  if (!session?.viewers) return 0;
  for (const ws of [...session.viewers]) {
    if (!ws || ws.readyState !== 1) session.viewers.delete(ws);
  }
  return session.viewers.size;
}

export function countLiveFeishuRemoteViewers() {
  return pruneDeadViewers();
}

function canAutoReplaceBusySession() {
  if (!session?.busy) return true;
  // 成功态短暂保留；其余无活跃 viewer 时可替换
  if (session.phase === PHASE.READY) return pruneDeadViewers() === 0;
  return pruneDeadViewers() === 0;
}

export { canAutoReplaceBusySession as _canAutoReplaceBusyFeishuSessionForTests };

function scheduleReleaseWhenViewersGone() {
  clearViewerGoneTimer();
  if (!session?.busy) return;
  // READY 保留一会儿给前端读成功态；VERIFYING 若用户已关页则释放，避免一直卡在“提取中”
  if (session.phase === PHASE.READY) return;
  if (pruneDeadViewers() > 0) return;
  viewerGoneTimer = setTimeout(() => {
    viewerGoneTimer = null;
    if (!session?.busy) return;
    if (session.phase === PHASE.READY) return;
    if (pruneDeadViewers() > 0) return;
    log("system", "info", "feishu-remote", "远程扫码页已全部关闭，释放登录会话");
    cancelFeishuRemoteSession().catch(() => {});
  }, VIEWER_GONE_GRACE_MS);
}

function emptyStatus() {
  return {
    mode: "remote",
    phase: PHASE.NOT_LOGGED_IN,
    status: "idle",
    message: "",
    viewerUrl: FEISHU_VIEWER_PATH,
    profileDir: FEISHU_PROFILE_REL,
    purpose: "",
  };
}

export function getFeishuRemoteStatus() {
  if (!session) return emptyStatus();
  return {
    mode: "remote",
    phase: session.phase,
    status: session.status,
    message: session.message,
    viewerUrl: FEISHU_VIEWER_PATH,
    profileDir: FEISHU_PROFILE_REL,
    purpose: session.purpose || "",
    tokenLength: session.tokenLength || undefined,
  };
}

function setSessionState(status, message, phase, extra = {}) {
  if (!session) return;
  session.status = status;
  session.message = message;
  if (phase) session.phase = phase;
  Object.assign(session, extra);
  broadcastFeishuBrowserStatus(status, message, {
    mode: "remote",
    viewerUrl: FEISHU_VIEWER_PATH,
    phase: session.phase,
    purpose: session.purpose,
    ...extra,
  });
}

function broadcastFrame(data, metadata = {}) {
  if (!session?.viewers?.size) return;
  const payload = JSON.stringify({
    type: "feishu_browser_frame",
    data: {
      image: data,
      width: metadata.deviceWidth || VIEWPORT.width,
      height: metadata.deviceHeight || VIEWPORT.height,
      phase: session.phase,
      status: session.status,
      message: session.message,
    },
  });
  for (const ws of session.viewers) {
    if (ws.readyState === 1) {
      try { ws.send(payload); } catch {}
    }
  }
}

export function attachFeishuBrowserViewer(ws) {
  if (!session) {
    try {
      ws.send(JSON.stringify({
        type: "feishu_login_status",
        data: {
          status: "failed",
          message: "当前没有进行中的飞书远程登录会话",
          mode: "remote",
          phase: PHASE.NOT_LOGGED_IN,
        },
      }));
    } catch {}
    return false;
  }
  clearViewerGoneTimer();
  session.viewers.add(ws);
  try {
    ws.send(JSON.stringify({
      type: "feishu_login_status",
      data: {
        status: session.status,
        message: session.message,
        mode: "remote",
        viewerUrl: FEISHU_VIEWER_PATH,
        phase: session.phase,
        purpose: session.purpose,
      },
    }));
  } catch {}
  const onClose = () => {
    session?.viewers?.delete(ws);
    scheduleReleaseWhenViewersGone();
  };
  ws.on("close", onClose);
  ws.on("error", onClose);
  return true;
}

export function detachFeishuBrowserViewer(ws) {
  if (!session?.viewers) return false;
  const had = session.viewers.delete(ws);
  if (had) scheduleReleaseWhenViewersGone();
  return had;
}

function normalizeMouseButton(button) {
  if (button === "right") return "right";
  if (button === "middle") return "middle";
  return "left";
}

/**
 * 在主文档与各 iframe 中尝试点「扫码登录」类入口。
 */
export async function trySwitchFeishuQrLogin(page) {
  if (!page) return { ok: false, reason: "no-page" };
  const frames = page.frames?.() || [page.mainFrame?.()].filter(Boolean);
  const script = () => {
    const labels = ["扫码登录", "二维码登录", "扫一扫登录", "二维码", "QR Code", "Scan"];
    const nodes = Array.from(document.querySelectorAll("a,button,div,span,li,label,p"));
    for (const el of nodes) {
      const text = String(el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
      if (!text || text.length > 20) continue;
      if (!labels.some((label) => text === label || text.includes(label))) continue;
      const clickable = el.closest("a,button,[role='tab'],[role='button'],.login-type-item") || el;
      try {
        clickable.click();
        return { ok: true, text, tag: clickable.tagName };
      } catch {}
    }
    // data / aria 兜底
    const byAttr = document.querySelector(
      "[data-login-type*='qr'],[data-type*='qr'],[aria-label*='扫码'],[aria-label*='二维码']",
    );
    if (byAttr) {
      try {
        byAttr.click();
        return { ok: true, text: byAttr.getAttribute("aria-label") || "attr", tag: byAttr.tagName };
      } catch {}
    }
    return { ok: false };
  };

  for (const frame of frames) {
    try {
      const result = await frame.evaluate(script);
      if (result?.ok) {
        log("system", "info", "feishu-remote", `已切换扫码登录: ${result.text || ""}`);
        return result;
      }
    } catch {
      // cross-origin frame 忽略
    }
  }
  return { ok: false, reason: "qr-entry-not-found" };
}

export async function handleFeishuBrowserInput(event = {}) {
  if (!session?.page) return false;
  if (![PHASE.WAITING_FOR_SCAN, PHASE.VERIFYING, PHASE.NOT_LOGGED_IN].includes(session.phase)) return false;

  const type = String(event.type || "");
  const page = session.page;
  try {
    if (type === "switch_qr") {
      const result = await trySwitchFeishuQrLogin(page);
      if (result?.ok) {
        setSessionState("waiting", "已切换到扫码登录，请用飞书 App 扫码", PHASE.WAITING_FOR_SCAN);
      } else {
        setSessionState("waiting", "未找到扫码入口，请直接点击画面中的「扫码登录」", PHASE.WAITING_FOR_SCAN);
      }
      return true;
    }
    if (type === "open_tenant_picker" || type === "switch_tenant") {
      if (session) {
        session.tenantWarmed = false;
        session.waitingTenantPick = true;
        session.tenantPickOpenedAt = Date.now();
      }
      await openFeishuTenantPicker(page);
      setSessionState(
        "waiting",
        "请点击开通了「飞书项目」的企业卡片；选完后会自动继续提取 Token",
        PHASE.VERIFYING,
      );
      return true;
    }
    if (type === "switch_account") {
      if (session) {
        session.tenantWarmed = false;
        session.waitingTenantPick = false;
        session.capturedToken = "";
      }
      setSessionState("waiting", "正在打开账号中心，可切换企业或退出后换号扫码…", PHASE.WAITING_FOR_SCAN);
      await page.goto(FEISHU_ACCOUNT_HOME_URL, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
      return true;
    }
    if (type === "open_project_space") {
      if (session) {
        session.tenantWarmed = false;
        session.waitingTenantPick = false;
      }
      const warm = await ensureFeishuTenantContext(page, { force: true });
      if (session) {
        session.tenantWarmed = !!warm.ok;
        session.waitingTenantPick = !warm.ok;
      }
      setSessionState(
        "waiting",
        warm.ok
          ? "已进入项目空间并绑定租户，继续提取 MCP Token…"
          : "未绑定租户：请点「切换企业」选开通了飞书项目的企业，或点画面中的企业卡片",
        PHASE.VERIFYING,
      );
      if (warm.ok) {
        await page.goto(FEISHU_MCP_PAGE_URL, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
      }
      return true;
    }

    // 坐标必须是页面 CSS 视口像素（与 screencast metadata.deviceWidth/Height 对齐）
    if (type === "click" || type === "mousedown" || type === "mouseup" || type === "mousemove") {
      const x = Number(event.x);
      const y = Number(event.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
      const button = normalizeMouseButton(event.button);
      // 优先 page.mouse：对 iframe / 命中测试更稳；失败再回退 CDP
      try {
        if (type === "mousemove") {
          await page.mouse.move(x, y);
        } else if (type === "mousedown") {
          await page.mouse.move(x, y);
          await page.mouse.down({ button });
        } else if (type === "mouseup") {
          await page.mouse.move(x, y);
          await page.mouse.up({ button });
        } else if (type === "click") {
          await page.mouse.click(x, y, { button, delay: 40 });
        }
        return true;
      } catch (mouseErr) {
        if (!session.cdp) throw mouseErr;
        const cdpType = type === "mousedown"
          ? "mousePressed"
          : type === "mouseup"
            ? "mouseReleased"
            : type === "mousemove"
              ? "mouseMoved"
              : null;
        if (type === "click") {
          await session.cdp.send("Input.dispatchMouseEvent", {
            type: "mousePressed", x, y, button, clickCount: 1, buttons: 1,
          });
          await session.cdp.send("Input.dispatchMouseEvent", {
            type: "mouseReleased", x, y, button, clickCount: 1, buttons: 0,
          });
        } else {
          await session.cdp.send("Input.dispatchMouseEvent", {
            type: cdpType,
            x,
            y,
            button,
            clickCount: type === "mousedown" || type === "mouseup" ? 1 : 0,
            buttons: type === "mousedown" ? 1 : 0,
          });
        }
        return true;
      }
    }
    if (type === "wheel") {
      const x = Number(event.x) || 0;
      const y = Number(event.y) || 0;
      try {
        await page.mouse.wheel({ deltaX: Number(event.deltaX) || 0, deltaY: Number(event.deltaY) || 0 });
      } catch {
        if (session.cdp) {
          await session.cdp.send("Input.dispatchMouseEvent", {
            type: "mouseWheel",
            x,
            y,
            deltaX: Number(event.deltaX) || 0,
            deltaY: Number(event.deltaY) || 0,
          });
        }
      }
      return true;
    }
    if (type === "keydown" || type === "keyup" || type === "keypress") {
      const key = String(event.key || "");
      if (!key) return false;
      if (type === "keydown") await page.keyboard.down(key).catch(() => {});
      else if (type === "keyup") await page.keyboard.up(key).catch(() => {});
      else await page.keyboard.press(key).catch(() => {});
      return true;
    }
  } catch (err) {
    log("system", "warn", "feishu-remote", `输入转发失败: ${err.message}`);
  }
  return false;
}

async function startScreencast(page) {
  const cdp = await page.createCDPSession();
  await cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality: 72,
    maxWidth: VIEWPORT.width,
    maxHeight: VIEWPORT.height,
    everyNthFrame: 1,
  });
  cdp.on("Page.screencastFrame", async (frame) => {
    try {
      broadcastFrame(frame.data, frame.metadata || {});
      await cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId });
    } catch {}
  });
  return cdp;
}

function pickTokenFromJson(json) {
  if (!json || typeof json !== "object") return "";
  const data = json.data && typeof json.data === "object" ? json.data : json;
  const direct = [
    data.user_token, data.mcp_token, data.access_token, data.token,
    data.mcpToken, data.userToken, json.user_token, json.mcp_token, json.token,
  ];
  for (const value of direct) {
    if (typeof value === "string" && value.trim().length >= 12) return value.trim();
  }
  const stack = [json];
  const seen = new Set();
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object" || seen.has(cur)) continue;
    seen.add(cur);
    for (const [key, value] of Object.entries(cur)) {
      if (typeof value === "string"
        && /token/i.test(key)
        && !/(csrf|refresh|msToken|tea_cache)/i.test(key)
        && value.trim().length >= 16) {
        return value.trim();
      }
      if (value && typeof value === "object") stack.push(value);
    }
  }
  return "";
}

function isFeishuLoginHost(url = "") {
  try {
    const host = new URL(String(url || "")).hostname;
    return /(^|\.)accounts\.feishu\.cn$/i.test(host)
      || /(^|\.)passport\.feishu\.cn$/i.test(host)
      || /(^|\.)login\.feishu\.cn$/i.test(host)
      || /(^|\.)accounts\.larksuite\.com$/i.test(host);
  } catch {
    return false;
  }
}

function isFeishuProjectHost(url = "") {
  try {
    return /(^|\.)project\.feishu\.cn$/i.test(new URL(String(url || "")).hostname);
  } catch {
    return false;
  }
}

async function readProjectCookieMap(page) {
  try {
    const cookies = await page.cookies("https://project.feishu.cn");
    return Object.fromEntries(cookies.map((c) => [c.name, c.value]));
  } catch {
    return {};
  }
}

async function hasFeishuProjectSession(page) {
  try {
    const names = new Set(Object.keys(await readProjectCookieMap(page)));
    return names.has("session")
      || names.has("meego_user_key")
      || names.has("sl_session");
  } catch {
    return false;
  }
}

async function readCsrfFromPage(page) {
  const byName = await readProjectCookieMap(page);
  return byName.meego_csrf_token || byName.swp_csrf_token || byName._csrf_token || "";
}

async function readTenantKeyFromPage(page) {
  const byName = await readProjectCookieMap(page);
  return byName.meego_tenant_key || byName.login_tenant_key || "";
}

/**
 * 打开企业/空间选择页，供用户手动点选（轮询期间勿反复 goto 抢走画面）。
 */
async function openFeishuTenantPicker(page) {
  log("system", "info", "feishu-remote", `打开企业选择页: ${FEISHU_TENANT_PICKER_URL}`);
  await page.goto(FEISHU_TENANT_PICKER_URL, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1800));
  await trySelectFeishuTenant(page);
  return page.url();
}

/**
 * 登录后先进入配置的项目空间，写入 meego_tenant_key；必要时点选企业租户。
 */
async function ensureFeishuTenantContext(page, { force = false } = {}) {
  const tenantBefore = await readTenantKeyFromPage(page);
  if (tenantBefore && !force) {
    return { ok: true, tenant: tenantBefore, warmed: false };
  }

  const warmupUrl = getFeishuProjectWarmupUrl();
  setSessionState(
    "waiting",
    `登录成功，正在进入项目空间绑定租户…`,
    PHASE.VERIFYING,
  );
  log("system", "info", "feishu-remote", `租户预热: ${warmupUrl}`);
  await page.goto(warmupUrl, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 2200));
  await trySelectFeishuTenant(page);
  await new Promise((r) => setTimeout(r, 1200));

  let tenant = await readTenantKeyFromPage(page);
  if (tenant) return { ok: true, tenant, warmed: true, warmupUrl };

  // 预热 URL 未写出租户 cookie：落到企业列表页让用户点选（勿立刻再跳 /b/mcp）
  await openFeishuTenantPicker(page);
  await new Promise((r) => setTimeout(r, 1500));
  tenant = await readTenantKeyFromPage(page);
  return { ok: !!tenant, tenant, warmed: true, warmupUrl };
}

async function trySelectFeishuTenant(page) {
  try {
    const preferred = (() => {
      try {
        return String(getFeishuProjectWarmupUrl().match(/project\.feishu\.cn\/([^/?#]+)/i)?.[1] || "").trim();
      } catch {
        return "";
      }
    })();
    const frames = page.frames?.() || [page.mainFrame?.()].filter(Boolean);
    const script = (preferredKey) => {
      const textOf = (el) => String(el?.innerText || el?.textContent || "").replace(/\s+/g, " ").trim();
      const labels = [
        "进入企业", "选择企业", "进入团队", "进入空间", "进入项目", "进入", "继续",
        "Enter", "Select", "Continue", "Choose organization",
      ];
      const nodes = Array.from(document.querySelectorAll("button,a,div,li,span,[role='button'],[role='option']"));
      if (preferredKey) {
        for (const el of nodes) {
          const text = textOf(el);
          if (text && text.toLowerCase().includes(String(preferredKey).toLowerCase())) {
            const clickable = el.closest("button,a,[role='button'],[role='option'],li,div") || el;
            try { clickable.click(); return { ok: true, via: "preferred", text: text.slice(0, 40) }; } catch {}
          }
        }
      }
      for (const el of nodes) {
        const text = textOf(el);
        if (!text || text.length > 40) continue;
        if (!labels.some((label) => text === label || text.includes(label))) continue;
        const clickable = el.closest("button,a,[role='button']") || el;
        try { clickable.click(); return { ok: true, via: "label", text }; } catch {}
      }
      return { ok: false };
    };
    for (const frame of frames) {
      try {
        const result = await frame.evaluate(script, preferred);
        if (result?.ok) {
          log("system", "info", "feishu-remote", `已自动点选租户入口: ${result.text || result.via}`);
          return result;
        }
      } catch {
        // cross-origin
      }
    }
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

async function extractMcpTokenFromPage(page) {
  // 必须在 project.feishu.cn 文档下；相对路径在登录域会 404
  const currentUrl = page.url();
  if (!isFeishuProjectHost(currentUrl) || isFeishuLoginHost(currentUrl)) {
    return {
      status: 0,
      code: 0,
      msg: `当前不在飞书项目域（${currentUrl}）`,
      token: "",
      needLogin: true,
    };
  }

  const csrfFromCookie = await readCsrfFromPage(page);
  const tenantFromCookie = await readTenantKeyFromPage(page);
  return page.evaluate(async ({ csrfSeed, tenantSeed }) => {
    const cookieMap = Object.fromEntries(document.cookie.split("; ").filter(Boolean).map((entry) => {
      const idx = entry.indexOf("=");
      if (idx < 0) return [entry, ""];
      return [entry.slice(0, idx), decodeURIComponent(entry.slice(idx + 1))];
    }));
    const csrf = csrfSeed
      || cookieMap.meego_csrf_token
      || cookieMap.swp_csrf_token
      || cookieMap._csrf_token
      || "";
    const tenant = tenantSeed
      || cookieMap.meego_tenant_key
      || cookieMap.login_tenant_key
      || "";
    const ts = String(Date.now());
    const endpoint = "https://project.feishu.cn/goapi/v5/mcp_server/settings/get_or_init_token?meegoGwPath=/goapi/v5/mcp_server/settings/get_or_init_token";
    const bodies = tenant
      ? [{}, { tenant_key: tenant }, { tenantKey: tenant }]
      : [{}];
    const headerVariants = [
      {
        "Content-Type": "application/json",
        "X-MEego-CSRF-Token": csrf,
      },
      {
        "Content-Type": "application/json",
        "x-meego-csrf-token": csrf,
        "x-meego-from": "web",
        "x-meego-gw-path": "/goapi/v5/mcp_server/settings/get_or_init_token",
        "x-meego-request-source": "aief-sync",
        "x-request-timestamp": ts,
        "x-sw-referer": location.href,
        "x-lark-gw": "1",
        ...(tenant ? { "x-meego-tenant-key": tenant } : {}),
      },
    ];

    const pick = (json) => {
      if (!json || typeof json !== "object") return "";
      const data = json.data && typeof json.data === "object" ? json.data : json;
      for (const key of ["user_token", "mcp_token", "access_token", "token", "mcpToken", "userToken"]) {
        const value = data?.[key] || json?.[key];
        if (typeof value === "string" && value.trim().length >= 12) return value.trim();
      }
      return "";
    };

    let last = {
      status: 0, code: 0, msg: "", token: "", raw: "", needLogin: false, dataKeys: [],
      tenantLen: tenant.length, csrfLen: csrf.length,
    };
    for (const headers of headerVariants) {
      for (const body of bodies) {
        const resp = await fetch(endpoint, {
          method: "POST",
          credentials: "include",
          headers,
          body: JSON.stringify(body),
        });
        const text = await resp.text();
        let json = null;
        try { json = JSON.parse(text); } catch {}
        const token = pick(json);
        last = {
          status: resp.status,
          code: json?.code,
          msg: json?.msg || json?.message || "",
          dataKeys: Object.keys(json?.data || {}),
          token,
          raw: token ? "" : text.slice(0, 300),
          needLogin: resp.status === 401
            || resp.status === 403
            || /login|未登录|请先登录|扫码|no.?auth|unauthorized/i.test(`${json?.msg || ""} ${text.slice(0, 200)}`),
          csrfLen: csrf.length,
          tenantLen: tenant.length,
          tenantIllegal: /租户不合法|invalid.?tenant|tenant.*(invalid|illegal)/i.test(String(json?.msg || "")),
        };
        if (token) return last;
      }
    }

    // DOM 兜底：设置页常把 token 放在 input/textarea/code 里
    const nodes = Array.from(document.querySelectorAll("input,textarea,code,pre,[data-token]"));
    for (const el of nodes) {
      const value = String(el.value || el.textContent || el.getAttribute?.("data-token") || "").trim();
      if (value.length >= 20 && !/\s/.test(value) && !/csrf/i.test(value)) {
        return { ...last, token: value, msg: "dom", status: 200 };
      }
    }
    return last;
  }, { csrfSeed: csrfFromCookie, tenantSeed: tenantFromCookie }).catch((err) => ({
    status: 0,
    code: 0,
    msg: err?.message || String(err),
    token: "",
    needLogin: true,
  }));
}

async function tryClickMcpTokenControls(page) {
  try {
    return await page.evaluate(() => {
      const labels = ["获取 Token", "生成 Token", "创建 Token", "复制 Token", "Get Token", "Generate", "Create Token"];
      const nodes = Array.from(document.querySelectorAll("button,a,div,span"));
      for (const el of nodes) {
        const text = String(el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
        if (!text || text.length > 24) continue;
        if (!labels.some((label) => text === label || text.includes(label))) continue;
        const clickable = el.closest("button,a,[role='button']") || el;
        try {
          clickable.click();
          return { ok: true, text };
        } catch {}
      }
      return { ok: false };
    });
  } catch {
    return { ok: false };
  }
}

function attachTokenResponseHook(page) {
  const onResponse = async (resp) => {
    try {
      if (!session || session.cancelled) return;
      const url = resp.url();
      if (!/mcp_server|get_or_init_token|mcp.*token/i.test(url)) return;
      if (!/project\.feishu\.cn/i.test(url)) return;
      const ct = String(resp.headers()["content-type"] || "");
      if (!/json/i.test(ct) && !/text/i.test(ct)) return;
      const text = await resp.text().catch(() => "");
      let json = null;
      try { json = JSON.parse(text); } catch {}
      const token = pickTokenFromJson(json) || "";
      if (token) {
        session.capturedToken = token;
        log("system", "info", "feishu-remote", `网络响应捕获到 MCP Token（len=${token.length}）`);
      }
    } catch {}
  };
  page.on("response", onResponse);
  return () => {
    try { page.off("response", onResponse); } catch {}
  };
}

async function pollUntilDone(page, browser) {
  const start = Date.now();
  const purpose = session?.purpose || "mcp-token";
  let lastExtractHint = "";
  let extractAttempts = 0;
  let verifyingSince = 0;

  while (Date.now() - start < MAX_WAIT_MS) {
    if (!session || session.cancelled) return { kind: "cancelled" };
    if (!browser.isConnected()) return { kind: "closed" };

    try {
      if (session.capturedToken) {
        return { kind: "token", token: session.capturedToken };
      }

      const url = page.url();
      const loggedIn = await hasFeishuProjectSession(page);

      if (purpose === "web-login") {
        if (loggedIn && isFeishuProjectHost(url) && !isFeishuLoginHost(url)) {
          setSessionState("waiting", "检测到飞书网页登录态，正在确认...", PHASE.VERIFYING);
          await new Promise((r) => setTimeout(r, 1200));
          if (await hasFeishuProjectSession(page)) {
            return { kind: "web-ready", url: page.url() };
          }
        } else if (session.phase === PHASE.VERIFYING) {
          setSessionState("waiting", "请在远程浏览器页面中扫码登录飞书项目...", PHASE.WAITING_FOR_SCAN);
        }
      } else if (purpose === "mcp-token" || purpose === "auth") {
        if (!loggedIn) {
          if (session.phase === PHASE.VERIFYING) {
            setSessionState(
              "waiting",
              "尚未完成飞书项目登录，请继续扫码（登录成功后会自动提取 Token）",
              PHASE.WAITING_FOR_SCAN,
            );
          }
        } else {
          if (session.phase !== PHASE.VERIFYING) {
            verifyingSince = Date.now();
            setSessionState("waiting", "登录成功，正在绑定项目租户并提取 MCP Token...", PHASE.VERIFYING);
          } else if (verifyingSince && Date.now() - verifyingSince > 120_000) {
            setSessionState(
              "failed",
              `提取 MCP Token 超时：${lastExtractHint || "接口未返回 token"}。请确认扫码账号所属企业已开通飞书项目，并在远程页选手动选择该企业。`,
              PHASE.FAILED,
            );
            return { kind: "failed", error: lastExtractHint || "extract-timeout" };
          }

          extractAttempts += 1;

          // 用户正在选企业：只轮询 cookie，不要反复 goto 抢走点击
          if (session.waitingTenantPick) {
            const tenantNow = await readTenantKeyFromPage(page);
            if (tenantNow) {
              session.waitingTenantPick = false;
              session.tenantWarmed = true;
              log("system", "info", "feishu-remote", `用户已选择租户: ${String(tenantNow).slice(0, 12)}…`);
              setSessionState("waiting", "已绑定企业租户，正在提取 MCP Token…", PHASE.VERIFYING);
            } else {
              // 软点选一次；超过 40s 仍无租户则温和提示，不强制跳转
              await trySelectFeishuTenant(page);
              const onMcp = /\/b\/mcp/i.test(page.url());
              if (onMcp && Date.now() - (session.tenantPickOpenedAt || 0) > 8000) {
                // 误停在 MCP 页且无租户：拉回企业列表一次
                session.tenantPickOpenedAt = Date.now();
                await openFeishuTenantPicker(page);
              }
              setSessionState(
                "waiting",
                "请在远程页点选开通了「飞书项目」的企业（可点顶栏「切换企业」）；选完后自动继续",
                PHASE.VERIFYING,
              );
              await new Promise((r) => setTimeout(r, TENANT_WAIT_MS));
              continue;
            }
          }

          // 首次：尝试进入配置空间绑定 meego_tenant_key
          if (!session.tenantWarmed) {
            const warm = await ensureFeishuTenantContext(page, { force: false });
            if (!warm.ok) {
              session.waitingTenantPick = true;
              session.tenantPickOpenedAt = Date.now();
              session.tenantWarmed = false;
              lastExtractHint = "未绑定到飞书项目企业租户";
              setSessionState(
                "waiting",
                "未绑定企业租户：请在远程页点选开通了飞书项目的企业（顶栏可「切换企业 / 切换账号」）",
                PHASE.VERIFYING,
              );
              await new Promise((r) => setTimeout(r, TENANT_WAIT_MS));
              continue;
            }
            session.tenantWarmed = true;
            session.waitingTenantPick = false;
            log("system", "info", "feishu-remote", `租户已绑定: ${String(warm.tenant).slice(0, 12)}…`);
          }

          // 再打开 MCP 设置页提取
          if (!/\/b\/mcp/i.test(page.url()) || isFeishuLoginHost(page.url())) {
            await page.goto(FEISHU_MCP_PAGE_URL, {
              waitUntil: "domcontentloaded",
              timeout: 45000,
            }).catch(() => {});
            await new Promise((r) => setTimeout(r, 2000));
          }

          const afterUrl = page.url();
          if (!isFeishuProjectHost(afterUrl) || isFeishuLoginHost(afterUrl)) {
            lastExtractHint = `跳转后仍在登录页：${afterUrl.slice(0, 80)}`;
            session.tenantWarmed = false;
            session.waitingTenantPick = false;
            setSessionState("waiting", lastExtractHint, PHASE.WAITING_FOR_SCAN);
          } else {
            if (extractAttempts === 2 || extractAttempts === 5) {
              await tryClickMcpTokenControls(page);
              await new Promise((r) => setTimeout(r, 1200));
            }
            const extracted = await extractMcpTokenFromPage(page);
            if (extracted.token) {
              return { kind: "token", token: extracted.token };
            }
            if (session.capturedToken) {
              return { kind: "token", token: session.capturedToken };
            }
            lastExtractHint = extracted.msg
              || extracted.raw
              || `HTTP ${extracted.status || 0} code=${extracted.code ?? "-"} csrf=${extracted.csrfLen ?? 0} tenant=${extracted.tenantLen ?? 0}`;

            if (extracted.tenantIllegal || /租户不合法/i.test(lastExtractHint)) {
              // 停在企业选择页等用户操作，禁止每 2.5s 强制预热跳转
              session.tenantWarmed = false;
              if (!session.waitingTenantPick) {
                session.waitingTenantPick = true;
                session.tenantPickOpenedAt = Date.now();
                await openFeishuTenantPicker(page);
              }
              setSessionState(
                "waiting",
                "租户不合法：请点顶栏「切换企业」选择开通了飞书项目的企业，或「切换账号」换号后重试",
                PHASE.VERIFYING,
              );
              log("system", "warn", "feishu-remote", `提取 Token 租户不合法，等待用户选择企业`);
              await new Promise((r) => setTimeout(r, TENANT_WAIT_MS));
              continue;
            } else if (extractAttempts === 1 || extractAttempts % 3 === 0) {
              log("system", "warn", "feishu-remote", `提取 Token 未成功: ${lastExtractHint}`);
              setSessionState(
                "waiting",
                `正在提取 MCP Token…（${String(lastExtractHint).slice(0, 90)}）`,
                PHASE.VERIFYING,
              );
            }
          }
        }
      }
    } catch (err) {
      lastExtractHint = err?.message || String(err);
      if (!browser.isConnected()) return { kind: "closed" };
      log("system", "warn", "feishu-remote", `轮询异常: ${lastExtractHint}`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  setSessionState(
    "timeout",
    `登录/提取超时（5 分钟）${lastExtractHint ? `：${String(lastExtractHint).slice(0, 80)}` : ""}`,
    PHASE.TIMEOUT,
  );
  return { kind: "timeout" };
}

async function cleanupBrowser() {
  const current = session;
  if (!current) return;
  try { await current.cdp?.send("Page.stopScreencast").catch(() => {}); } catch {}
  try { await current.browser?.close(); } catch {}
}

/**
 * @param {{ purpose?: 'mcp-token'|'web-login'|'auth', url?: string }} opts
 */
export async function startFeishuRemoteSession(opts = {}) {
  const purpose = ["mcp-token", "web-login", "auth"].includes(opts.purpose)
    ? opts.purpose
    : "mcp-token";
  const targetUrl = String(opts.url || FEISHU_MCP_PAGE_URL).trim() || FEISHU_MCP_PAGE_URL;

  if (session?.busy) {
    if (canAutoReplaceBusySession()) {
      log("system", "info", "feishu-remote", "检测到旧会话无活跃扫码页，自动替换后重新启动");
      await cancelFeishuRemoteSession();
    } else {
      return {
        success: false,
        ok: false,
        mode: "remote",
        viewerUrl: FEISHU_VIEWER_PATH,
        error: "已有飞书登录窗口打开中，请完成或关闭后重试",
        phase: session.phase,
        purpose: session.purpose,
      };
    }
  }

  const browserPath = findBrowser();
  if (!browserPath) {
    return {
      success: false,
      ok: false,
      mode: "remote",
      error: "未找到 Chromium/Chrome，请安装后重试（或设置 BROWSER_PATH）",
      phase: PHASE.FAILED,
    };
  }

  mkdirSync(FEISHU_PROFILE_DIR, { recursive: true });
  clearViewerGoneTimer();

  session = {
    busy: true,
    cancelled: false,
    purpose,
    phase: PHASE.NOT_LOGGED_IN,
    status: "launching",
    message: "正在启动飞书远程浏览器...",
    viewers: new Set(),
    browser: null,
    page: null,
    cdp: null,
    capturedToken: "",
    detachTokenHook: null,
    tenantWarmed: false,
    waitingTenantPick: false,
    tenantPickOpenedAt: 0,
  };

  setSessionState("launching", "正在启动飞书远程浏览器...", PHASE.NOT_LOGGED_IN);

  try {
    const browser = await puppeteer.launch({
      executablePath: browserPath,
      headless: "new",
      userDataDir: FEISHU_PROFILE_DIR,
      defaultViewport: VIEWPORT,
      args: [
        "--no-first-run",
        "--disable-extensions",
        "--disable-default-apps",
        "--disable-dev-shm-usage",
        "--no-sandbox",
        "--disable-gpu",
        "--window-size=1440,900",
        "--lang=zh-CN",
        "--accept-lang=zh-CN,zh,en-US,en",
        "--font-render-hinting=medium",
        "--disable-blink-features=AutomationControlled",
      ],
    });
    session.browser = browser;

    const page = await browser.newPage();
    session.page = page;
    await page.setViewport(VIEWPORT);
    await page.setExtraHTTPHeaders({
      "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
    }).catch(() => {});
    session.detachTokenHook = attachTokenResponseHook(page);
    session.cdp = await startScreencast(page);

    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
    // 登录页常默认密码态：自动尝试切到扫码，并在 2s/5s 再试一次（iframe 晚加载）
    setTimeout(() => { trySwitchFeishuQrLogin(page).catch(() => {}); }, 1200);
    setTimeout(() => { trySwitchFeishuQrLogin(page).catch(() => {}); }, 3500);
    const waitMsg = purpose === "web-login"
      ? "请在远程浏览器页面中扫码登录飞书项目..."
      : "请在远程浏览器页面中扫码登录飞书，完成后将自动获取 MCP Token...";
    setSessionState("waiting", waitMsg, PHASE.WAITING_FOR_SCAN);
    log("system", "info", "feishu-remote", `远程会话已启动 purpose=${purpose} browser=${browserPath}`);

    (async () => {
      try {
        const result = await pollUntilDone(page, browser);
        if (!result || result.kind === "cancelled" || result.kind === "closed") {
          if (session && !session.cancelled && session.phase !== PHASE.TIMEOUT && session.phase !== PHASE.FAILED) {
            setSessionState("failed", "登录超时或窗口被关闭", PHASE.FAILED);
          }
          return;
        }
        if (result.kind === "timeout" || result.kind === "failed") return;

        if (result.kind === "token") {
          const saved = saveFeishuMcpTokenToConfig(result.token);
          const msg = `MCP Token 已写入（长度 ${saved.tokenLength}）`;
          setSessionState("success", msg, PHASE.READY, { tokenLength: saved.tokenLength });
          log("system", "info", "feishu-remote", msg);
          return;
        }

        if (result.kind === "web-ready") {
          setSessionState("success", "飞书网页登录成功，Profile 已保存", PHASE.READY, { url: result.url });
          log("system", "info", "feishu-remote", `网页登录成功: ${result.url}`);
        }
      } catch (err) {
        setSessionState("failed", `登录失败: ${err.message}`, PHASE.FAILED);
        log("system", "error", "feishu-remote", `远程会话失败: ${err.message}`);
      } finally {
        try { session?.detachTokenHook?.(); } catch {}
        await cleanupBrowser();
        if (session) {
          session.busy = false;
          session.browser = null;
          session.page = null;
          session.cdp = null;
          session.detachTokenHook = null;
          setTimeout(() => {
            if (session && !session.busy) session = null;
          }, 30_000);
        }
      }
    })();

    return {
      success: true,
      ok: true,
      pending: true,
      mode: "remote",
      viewerUrl: FEISHU_VIEWER_PATH,
      message: "远程浏览器已启动，请在弹出的页面中扫码",
      phase: PHASE.WAITING_FOR_SCAN,
      purpose,
      profileDir: FEISHU_PROFILE_REL,
      url: targetUrl,
      opened: true,
    };
  } catch (err) {
    setSessionState("failed", `启动失败: ${err.message}`, PHASE.FAILED);
    log("system", "error", "feishu-remote", `启动失败: ${err.message}`);
    await cleanupBrowser();
    session = null;
    return {
      success: false,
      ok: false,
      mode: "remote",
      error: err.message,
      phase: PHASE.FAILED,
    };
  }
}

export async function cancelFeishuRemoteSession() {
  if (!session) return false;
  clearViewerGoneTimer();
  session.cancelled = true;
  setSessionState("cancelled", "登录已取消", PHASE.CANCELLED);
  await cleanupBrowser();
  session.busy = false;
  session.browser = null;
  session.page = null;
  session.cdp = null;
  session = null;
  return true;
}

export function _resetFeishuRemoteSessionForTests() {
  clearViewerGoneTimer();
  session = null;
}

export function _setFeishuRemoteSessionForTests(partial = {}) {
  clearViewerGoneTimer();
  session = {
    busy: true,
    cancelled: false,
    purpose: "mcp-token",
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
