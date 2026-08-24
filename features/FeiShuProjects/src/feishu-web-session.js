import { createRequire } from "module";
import { spawn } from "child_process";
import { existsSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  canUseLocalGuiBrowser,
  FEISHU_MCP_PAGE_URL,
  FEISHU_VIEWER_PATH,
} from "../../../gateway/services/feishu-browser-shared.js";
import { startFeishuRemoteSession } from "../../../gateway/services/feishu-remote-browser.js";

const requireFromGateway = createRequire(new URL("../../../gateway/package.json", import.meta.url));
const puppeteer = requireFromGateway("puppeteer-core");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../../..");
const PROFILE_DIR = path.join(REPO_ROOT, "gateway", ".tmp", "feishu-project-web-profile");

const DEFAULT_HOME_URL = "https://project.feishu.cn/intelligentspace/bug/homepage";
const BROWSER_PATHS = [
  process.env.BROWSER_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  "/snap/bin/chromium",
  "/usr/bin/microsoft-edge",
].filter(Boolean);

async function closeActiveFeishuBrowser() {
  if (!activeBrowser) return;
  try { await activeBrowser.close(); } catch {}
  activeBrowser = null;
  activePage = null;
}

function preferRemoteFeishuBrowser() {
  if (String(process.env.FEISHU_FORCE_REMOTE_BROWSER || "").trim() === "1") return true;
  return !canUseLocalGuiBrowser({ browserPath: findBrowser() || undefined });
}

let activeBrowser = null;
let activePage = null;

const PASSIVE_WEB_STATUS_REASON = "进入飞书同步页面时已跳过自动打开 Puppeteer profile 检测，避免弹出空白浏览器窗口；需要使用网页态时请点击飞书网页登录。";

export function defaultFeishuProjectWebConfig() {
  return {
    homepageUrl: DEFAULT_HOME_URL,
    profileDir: "gateway/.tmp/feishu-project-web-profile",
    captureMaxResponses: 80,
  };
}

export function normalizeFeishuWebUrl(url = "") {
  const raw = String(url || "").trim() || DEFAULT_HOME_URL;
  try {
    const parsed = new URL(raw);
    if (!/(^|\.)project\.feishu\.cn$/i.test(parsed.hostname)) return DEFAULT_HOME_URL;
    return parsed.toString();
  } catch {
    return DEFAULT_HOME_URL;
  }
}

export async function openFeishuProjectWebLogin({ url } = {}) {
  const targetUrl = normalizeFeishuWebUrl(url);
  if (preferRemoteFeishuBrowser()) {
    await closeActiveFeishuBrowser();
    return startFeishuRemoteSession({ purpose: "web-login", url: targetUrl });
  }
  const browser = await ensureBrowser({ headless: false });
  const page = activePage || await browser.newPage();
  activePage = page;
  await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  return {
    opened: true,
    mode: "local",
    url: page.url(),
    profileDir: path.relative(REPO_ROOT, PROFILE_DIR).replace(/\\/g, "/"),
  };
}

export async function getFeishuProjectWebStatus({ url, timeoutMs = 30000, passive = false, allowActivePageRead = false } = {}) {
  const targetUrl = normalizeFeishuWebUrl(url);
  if (passive) return getPassiveFeishuProjectWebStatus(targetUrl, { allowActivePageRead });
  const { browser, page, owned, active } = await getPageForRead({ headless: true });
  try {
    const currentUrl = page.url?.() || "";
    if (!active || shouldNavigateForFeishuStatus(currentUrl)) {
      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs }).catch(() => {});
      await sleep(2500);
    } else {
      // Do not navigate the visible login page while the QR code is awaiting confirmation.
      await sleep(500);
    }
    return await readFeishuProjectWebStatusFromPage(page, targetUrl, { passive: false });
  } finally {
    if (owned) await browser.close().catch(() => {});
  }
}

async function getPassiveFeishuProjectWebStatus(targetUrl, { allowActivePageRead = false } = {}) {
  if (!allowActivePageRead) return passiveFeishuWebStatus(targetUrl);
  const page = await existingFeishuWebPage();
  if (!page) return passiveFeishuWebStatus(targetUrl);
  const currentUrl = page.url?.() || "";
  if (shouldSkipPassiveFeishuStatusRead(currentUrl)) {
    return passiveFeishuWebStatus(targetUrl, currentUrl);
  }
  await sleep(300);
  return readFeishuProjectWebStatusFromPage(page, targetUrl, { passive: true, activePageRead: true });
}

async function readFeishuProjectWebStatusFromPage(page, homepageUrl, { passive = false, activePageRead = false } = {}) {
  const text = await pageText(page);
  const finalUrl = page.url();
  const cookies = await page.cookies("https://project.feishu.cn").catch(() => []);
  const loggedIn = looksLoggedIn(finalUrl, text, cookies);
  return {
    valid: loggedIn,
    loggedIn,
    finalUrl,
    homepageUrl,
    cookieCount: cookies.length,
    reason: loggedIn ? "" : reasonFromPage(finalUrl, text, cookies),
    profileDir: profileDirForResponse(),
    passive: !!passive,
    activePageRead: !!activePageRead,
    skippedBrowserLaunch: false,
  };
}

function passiveFeishuWebStatus(homepageUrl, finalUrl = "") {
  return {
    valid: false,
    loggedIn: false,
    finalUrl,
    homepageUrl,
    cookieCount: 0,
    reason: PASSIVE_WEB_STATUS_REASON,
    profileDir: profileDirForResponse(),
    passive: true,
    activePageRead: false,
    skippedBrowserLaunch: true,
  };
}

function shouldSkipPassiveFeishuStatusRead(currentUrl = "") {
  const raw = String(currentUrl || "").trim();
  return !raw || raw === "about:blank" || shouldNavigateForFeishuStatus(raw);
}

export async function captureFeishuProjectWebItems({
  url,
  limit = 20,
  timeoutMs = 60000,
  workItemIds = [],
  spaceKey = "",
  workItemTypeKey = "",
} = {}) {
  const targetUrl = normalizeFeishuWebUrl(url);
  const maxItems = Math.max(1, Math.min(Number(limit) || 20, 200));
  const detailIds = normalizeStringList(workItemIds).slice(0, maxItems);
  const { browser, page, owned } = await getPageForRead({ headless: true });
  const responses = [];
  const fromNetwork = [];

  page.on("response", async (response) => {
    if (responses.length >= 80) return;
    const responseUrl = response.url();
    if (!/(project\.feishu\.cn|larksuite|feishu)/i.test(responseUrl)) return;
    const headers = response.headers?.() || {};
    const contentType = headers["content-type"] || headers["Content-Type"] || "";
    if (!/json/i.test(contentType) && !/\/api\/|open_api|graphql|work_item|workitem/i.test(responseUrl)) return;
    try {
      const data = await response.json();
      const items = extractFeishuWorkItemsFromJson(data, { sourceUrl: responseUrl });
      if (items.length) {
        fromNetwork.push(...items);
        responses.push({ url: responseUrl, status: response.status(), items: items.length });
      }
    } catch {}
  });

  try {
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await sleep(detailIds.length ? 1000 : 0);
    if (detailIds.length) {
      const text = await pageText(page);
      const finalUrl = page.url();
      const cookies = await page.cookies("https://project.feishu.cn").catch(() => []);
      if (!looksLoggedIn(finalUrl, text, cookies)) {
        return {
          ok: false,
          needLogin: true,
          error: reasonFromPage(finalUrl, text, cookies),
          finalUrl,
          items: [],
          responses,
        };
      }
      const detailItems = [];
      const detailResponses = [];
      for (const workItemId of detailIds) {
        const detail = await fetchFeishuProjectWebDetail(page, {
          workItemId,
          spaceKey,
          workItemTypeKey,
        });
        detailResponses.push({
          workItemId,
          ok: detail.ok,
          status: detail.status,
          code: detail.code,
          error: detail.error || "",
        });
        if (detail.ok) {
          const item = normalizeFeishuWebDetailWorkItem(detail.json, {
            workItemId,
            spaceKey,
            workItemTypeKey,
            sourceUrl: detail.detailUrl,
          });
          if (item) detailItems.push(item);
        }
      }
      const items = dedupeWorkItems(detailItems).slice(0, maxItems);
      if (!items.length) {
        const detailError = detailResponses.find((item) => item.error)?.error || "";
        return {
          ok: false,
          error: detailError ? `Feishu web detail fetch failed: ${detailError}` : "Feishu web detail fetch returned no work items",
          finalUrl,
          homepageUrl: targetUrl,
          items: [],
          total: 0,
          source: {
            detailItems: 0,
            requestedDetailItems: detailIds.length,
            detailResponses,
            responses,
          },
        };
      }
      return {
        ok: true,
        finalUrl,
        homepageUrl: targetUrl,
        items,
        total: items.length,
        source: {
          detailItems: items.length,
          requestedDetailItems: detailIds.length,
          detailResponses,
          networkItems: dedupeWorkItems(fromNetwork).length,
          responses,
        },
      };
    }
    for (let i = 0; i < 6; i += 1) {
      await page.evaluate(() => window.scrollBy(0, Math.max(500, window.innerHeight || 700))).catch(() => {});
      await sleep(1200);
      if (dedupeWorkItems(fromNetwork).length >= maxItems) break;
    }
    await sleep(2500);
    const text = await pageText(page);
    const finalUrl = page.url();
    const cookies = await page.cookies("https://project.feishu.cn").catch(() => []);
    if (!looksLoggedIn(finalUrl, text, cookies)) {
      return {
        ok: false,
        needLogin: true,
        error: reasonFromPage(finalUrl, text, cookies),
        finalUrl,
        items: [],
        responses,
      };
    }
    const fromDom = await extractFeishuWorkItemsFromDom(page);
    const items = dedupeWorkItems([...fromNetwork, ...fromDom]).slice(0, maxItems);
    return {
      ok: true,
      finalUrl,
      homepageUrl: targetUrl,
      items,
      total: items.length,
      source: {
        networkItems: dedupeWorkItems(fromNetwork).length,
        domItems: dedupeWorkItems(fromDom).length,
        responses,
      },
    };
  } finally {
    if (owned) await browser.close().catch(() => {});
  }
}

export async function getFeishuProjectMcpTokenFromWeb({ timeoutMs = 45000, forceRemote = false } = {}) {
  // 先尝试已有 Profile 静默取 Token；失败且无本机 GUI 时走远程扫码页
  let quick = null;
  try {
    quick = await extractFeishuMcpTokenWithHeadless({ timeoutMs });
    if (quick?.ok && quick.token) return quick;
  } catch (err) {
    quick = {
      ok: false,
      error: err?.message || String(err),
      tokenLength: 0,
    };
  }

  if (forceRemote || preferRemoteFeishuBrowser()) {
    await closeActiveFeishuBrowser();
    const remote = await startFeishuRemoteSession({
      purpose: "mcp-token",
      url: FEISHU_MCP_PAGE_URL,
    });
    if (!remote.success) {
      return {
        ok: false,
        mode: "remote",
        viewerUrl: remote.viewerUrl || FEISHU_VIEWER_PATH,
        error: remote.error || quick?.error || "启动飞书远程登录失败",
        previousError: quick?.error,
      };
    }
    return {
      ok: true,
      pending: true,
      mode: "remote",
      viewerUrl: remote.viewerUrl || FEISHU_VIEWER_PATH,
      message: remote.message || "远程浏览器已启动，请在弹出的页面中扫码获取 MCP Token",
      purpose: "mcp-token",
      previousError: quick?.error,
    };
  }

  return quick || {
    ok: false,
    error: "Feishu MCP token not returned",
    tokenLength: 0,
  };
}

async function extractFeishuMcpTokenWithHeadless({ timeoutMs = 45000 } = {}) {
  const { browser, page, owned } = await getPageForRead({ headless: true });
  try {
    await page.goto(FEISHU_MCP_PAGE_URL, { waitUntil: "networkidle2", timeout: timeoutMs }).catch(() => {});
    await sleep(1500);
    const cookies = await page.cookies("https://project.feishu.cn").catch(() => []);
    const cookieMapPuppeteer = Object.fromEntries(cookies.map((c) => [c.name, c.value]));
    const csrfSeed = cookieMapPuppeteer.meego_csrf_token || cookieMapPuppeteer.swp_csrf_token || cookieMapPuppeteer._csrf_token || "";
    const result = await page.evaluate(async (csrfFromPuppeteer) => {
      const cookieMap = Object.fromEntries(document.cookie.split("; ").filter(Boolean).map((entry) => {
        const idx = entry.indexOf("=");
        if (idx < 0) return [entry, ""];
        return [entry.slice(0, idx), decodeURIComponent(entry.slice(idx + 1))];
      }));
      const csrf = csrfFromPuppeteer || cookieMap.meego_csrf_token || cookieMap.swp_csrf_token || cookieMap._csrf_token || "";
      const ts = String(Date.now());
      const endpoint = "https://project.feishu.cn/goapi/v5/mcp_server/settings/get_or_init_token?meegoGwPath=/goapi/v5/mcp_server/settings/get_or_init_token";
      const resp = await fetch(endpoint, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "x-meego-csrf-token": csrf,
          "X-MEego-CSRF-Token": csrf,
          "x-meego-from": "web",
          "x-meego-gw-path": "/goapi/v5/mcp_server/settings/get_or_init_token",
          "x-meego-request-source": "aief-sync",
          "x-request-timestamp": ts,
          "x-sw-referer": location.href,
        },
        body: "{}",
      });
      const text = await resp.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      const data = json?.data && typeof json.data === "object" ? json.data : {};
      const token = data.user_token || data.mcp_token || data.access_token || data.token || json?.token || "";
      return {
        status: resp.status,
        code: json?.code,
        msg: json?.msg || "",
        dataKeys: Object.keys(data),
        token,
        raw: token ? "" : text.slice(0, 500),
        pageUrl: location.href,
      };
    }, csrfSeed);
    if (!result.token) {
      return {
        ok: false,
        mode: "local",
        error: result.msg || result.raw || "Feishu MCP token not returned",
        status: result.status,
        code: result.code,
        dataKeys: result.dataKeys || [],
        tokenLength: 0,
        pageUrl: result.pageUrl,
      };
    }
    return {
      ok: true,
      mode: "local",
      token: result.token,
      tokenLength: String(result.token).length,
      status: result.status,
      code: result.code,
    };
  } finally {
    if (owned) await browser.close().catch(() => {});
  }
}

async function fetchFeishuProjectWebDetail(page, { workItemId, spaceKey = "", workItemTypeKey = "" } = {}) {
  const id = stringValue(workItemId);
  const project = stringValue(spaceKey) || "intelligentspace";
  const type = stringValue(workItemTypeKey) || "bug";
  const detailUrl = `https://project.feishu.cn/${encodeURIComponent(project)}/${encodeURIComponent(type)}/detail/${encodeURIComponent(id)}`;
  return page.evaluate(async ({ id: browserId, project: browserProject, type: browserType, detailUrl: browserDetailUrl }) => {
    const cookieMap = Object.fromEntries(document.cookie.split("; ").filter(Boolean).map((entry) => {
      const idx = entry.indexOf("=");
      if (idx < 0) return [entry, ""];
      return [entry.slice(0, idx), decodeURIComponent(entry.slice(idx + 1))];
    }));
    const csrf = cookieMap.meego_csrf_token || cookieMap.swp_csrf_token || cookieMap._csrf_token || "";
    const timestamp = String(Date.now());
    const body = {
      project_simple_name: browserProject,
      work_item_api_name: browserType,
      work_item_id: /^\d+$/.test(String(browserId)) ? Number(browserId) : browserId,
      modules: [{
        key: "detail",
        params: {
          first_screen: true,
          visible_area: { enable: true },
        },
      }],
      version: "2",
    };
    const resp = await fetch("/goapi/v5/workitem/v1/demand_fetch", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "x-meego-api-name": "APIDemandFetchWorkItem",
        "x-meego-csrf-token": csrf,
        "x-meego-from": "web",
        "x-meego-gw-path": "/goapi/v5/workitem/v1/demand_fetch",
        "x-meego-request-source": "aief-sync",
        "x-request-timestamp": timestamp,
        "x-sw-referer": browserDetailUrl,
      },
      body: JSON.stringify(body),
    });
    const text = await resp.text();
    let json = null;
    try { json = text ? JSON.parse(text) : {}; } catch {}
    const code = json?.code ?? json?.err_code ?? json?.errno ?? 0;
    const msg = json?.msg || json?.message || json?.error_msg || "";
    return {
      ok: resp.ok && !(code && Number(code) !== 0),
      status: resp.status,
      code,
      error: resp.ok ? msg : (msg || text.slice(0, 300)),
      json,
      detailUrl: browserDetailUrl,
    };
  }, { id, project, type, detailUrl }).catch((err) => ({
    ok: false,
    status: 0,
    code: 0,
    error: err?.message || String(err),
    json: null,
    detailUrl,
  }));
}

export async function openFeishuProjectSystemUrl(url) {
  const targetUrl = normalizeFeishuSystemAuthUrl(url);
  if (preferRemoteFeishuBrowser()) {
    await closeActiveFeishuBrowser();
    return startFeishuRemoteSession({ purpose: "auth", url: targetUrl });
  }
  const platform = process.platform;
  const command = platform === "win32"
    ? "rundll32.exe"
    : platform === "darwin"
      ? "open"
      : "xdg-open";
  const args = platform === "win32"
    ? ["url.dll,FileProtocolHandler", targetUrl]
    : [targetUrl];
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.on("error", () => {});
  child.unref();
  return {
    opened: true,
    mode: "local",
    url: targetUrl,
    opener: platform === "win32" ? "windows-url-handler" : command,
  };
}

export async function withFeishuWebPage({ url, headless = true, timeoutMs = 60000 } = {}, handler) {
  if (typeof handler !== "function") throw new Error("withFeishuWebPage handler is required");
  const targetUrl = normalizeFeishuDocumentUrl(url);
  const { browser, page, owned } = await getPageForRead({ headless });
  try {
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs }).catch(() => {});
    await ensureFeishuDocumentReady(page, { headless, timeoutMs, targetUrl });
    return await handler(page, { url: targetUrl, browser });
  } finally {
    if (owned) await browser.close().catch(() => {});
  }
}

async function ensureFeishuDocumentReady(page, { headless = true, timeoutMs = 60000, targetUrl = "" } = {}) {
  const deadline = Date.now() + Math.max(5000, Number(timeoutMs) || 60000);
  let last = null;
  for (;;) {
    last = await readFeishuDocumentAccessState(page, targetUrl);
    if (!last.needLogin) return last;
    if (headless || Date.now() >= deadline) throwFeishuDocumentLoginError(last);
    await sleep(1500);
  }
}

async function readFeishuDocumentAccessState(page, targetUrl = "") {
  const finalUrl = page.url?.() || "";
  const text = await pageText(page);
  const content = `${finalUrl}\n${text}`.toLowerCase();
  let host = "";
  try { host = new URL(finalUrl).hostname; } catch {}
  const authHost = /(^|\.)accounts\.feishu\.cn$/i.test(host)
    || /(^|\.)passport\.feishu\.cn$/i.test(host)
    || /(^|\.)login\.feishu\.cn$/i.test(host);
  const documentHost = isFeishuRelatedHost(host) && !authHost;
  const loginText = /login|sign in|passport|accounts\.feishu|扫码登录|密码登录|登录飞书|请先登录|未登录|切换用户|切换帐号|切换账号|选择帐号|选择账号|switch account|change account/i.test(content);
  const needLogin = authHost || (!documentHost && loginText) || /请先登录|未登录|登录飞书/i.test(content);
  return {
    ok: !needLogin,
    needLogin,
    finalUrl,
    targetUrl,
    reason: needLogin ? "飞书在线表格需要登录或切换到有权限的用户，完成后会继续执行。" : "",
    profileDir: profileDirForResponse(),
  };
}

function throwFeishuDocumentLoginError(state = {}) {
  const err = new Error(state.reason || "Feishu document login is required");
  err.needLogin = true;
  err.finalUrl = state.finalUrl || "";
  err.targetUrl = state.targetUrl || "";
  err.profileDir = state.profileDir || profileDirForResponse();
  throw err;
}

async function ensureBrowser({ headless = false } = {}) {
  if (activeBrowser?.isConnected?.()) return activeBrowser;
  mkdirSync(PROFILE_DIR, { recursive: true });
  const executablePath = findBrowser();
  if (!executablePath) throw new Error("Chrome/Edge executable not found. Set BROWSER_PATH to continue.");
  activeBrowser = await puppeteer.launch({
    executablePath,
    headless,
    userDataDir: PROFILE_DIR,
    defaultViewport: headless ? { width: 1366, height: 900 } : null,
    args: [
      "--no-first-run",
      "--disable-default-apps",
      "--window-size=1366,900",
    ],
  });
  activeBrowser.on("disconnected", () => {
    activeBrowser = null;
    activePage = null;
  });
  return activeBrowser;
}

async function getPageForRead({ headless = true } = {}) {
  if (activeBrowser?.isConnected?.()) {
    const page = activePage || (await activeBrowser.pages())[0] || await activeBrowser.newPage();
    activePage = page;
    return { browser: activeBrowser, page, owned: false, active: true };
  }
  mkdirSync(PROFILE_DIR, { recursive: true });
  const executablePath = findBrowser();
  if (!executablePath) throw new Error("Chrome/Edge executable not found. Set BROWSER_PATH to continue.");
  const browser = await puppeteer.launch({
    executablePath,
    headless,
    userDataDir: PROFILE_DIR,
    defaultViewport: { width: 1366, height: 900 },
    args: [
      "--no-first-run",
      "--disable-default-apps",
      "--window-size=1366,900",
    ],
  });
  const page = await browser.newPage();
  return { browser, page, owned: true, active: false };
}

async function existingFeishuWebPage() {
  if (!activeBrowser?.isConnected?.()) return null;
  if (activePage && !activePage.isClosed?.()) return activePage;
  const pages = await activeBrowser.pages().catch(() => []);
  activePage = pages.find((page) => !page.isClosed?.()) || null;
  return activePage;
}

function findBrowser() {
  for (const p of BROWSER_PATHS) if (existsSync(p)) return p;
  return "";
}

function profileDirForResponse() {
  return path.relative(REPO_ROOT, PROFILE_DIR).replace(/\\/g, "/");
}

export function shouldNavigateForFeishuStatus(currentUrl = "") {
  const raw = String(currentUrl || "").trim();
  if (!raw || raw === "about:blank") return true;
  try {
    const host = new URL(raw).hostname;
    return !isFeishuRelatedHost(host);
  } catch {
    return true;
  }
}

function normalizeFeishuSystemAuthUrl(url = "") {
  const raw = String(url || "").trim() || "https://project.feishu.cn/b/mcp";
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Invalid Feishu authorization URL");
  }
  if (!/^https?:$/i.test(parsed.protocol) || !isFeishuRelatedHost(parsed.hostname)) {
    throw new Error("Refusing to open non-Feishu authorization URL");
  }
  return parsed.toString();
}

function normalizeFeishuDocumentUrl(url = "") {
  const raw = String(url || "").trim();
  if (!raw) throw new Error("Feishu document URL is required");
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Invalid Feishu document URL");
  }
  if (!/^https?:$/i.test(parsed.protocol) || !isFeishuRelatedHost(parsed.hostname)) {
    throw new Error("Refusing to open non-Feishu document URL");
  }
  return parsed.toString();
}

function isFeishuRelatedHost(host = "") {
  return /(^|\.)feishu\.cn$/i.test(host)
    || /(^|\.)larksuite\.com$/i.test(host)
    || /(^|\.)larksuite\.cn$/i.test(host);
}

async function pageText(page) {
  try {
    return await page.evaluate(() => document.body?.innerText || "");
  } catch {
    return "";
  }
}

function looksLoggedIn(url, text, cookies = []) {
  let host = "";
  try { host = new URL(url).hostname; } catch {}
  const content = `${url}\n${text}`.toLowerCase();
  const hasProjectHost = /(^|\.)project\.feishu\.cn$/i.test(host);
  const hasCookie = cookies.some((c) => /session|token|login|passport|sid|uid/i.test(c.name || ""));
  const loginText = /扫码登录|验证码登录|密码登录|登录飞书|sign in|login|passport|accounts\.feishu/i.test(content);
  const projectText = /工作项|项目|缺陷|问题|需求|任务|迭代|project|bug|homepage/i.test(content);
  return hasProjectHost && (projectText || hasCookie) && !loginText;
}

function reasonFromPage(url, text, cookies = []) {
  const content = `${url}\n${text}`.toLowerCase();
  if (/login|passport|accounts|扫码登录|验证码登录|登录飞书/i.test(content)) return "飞书网页登录态未完成或已过期";
  if (!cookies.length) return "未检测到 project.feishu.cn 登录 Cookie";
  return "无法确认当前飞书项目页面已登录";
}

export function extractFeishuWorkItemsFromJson(data, options = {}) {
  const out = [];
  const seen = new WeakSet();
  walk(data, 0);
  return out;

  function walk(value, depth) {
    if (depth > 12 || value == null) return;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 1000)) walk(item, depth + 1);
      return;
    }
    if (typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);

    const candidate = normalizeWorkItemCandidate(value, options);
    if (candidate) out.push(candidate);
    for (const child of Object.values(value)) {
      if (child && typeof child === "object") walk(child, depth + 1);
    }
  }
}

export function normalizeFeishuWebDetailWorkItem(data, options = {}) {
  const source = unwrapFeishuWebDetailData(data);
  const id = stringValue(firstDeepValue(source, [
    "work_item_id",
    "workItemId",
    "work_object_id",
    "workObjectId",
    "issue_id",
    "issueId",
    "id",
  ]) || options.workItemId);
  if (!id) return null;
  const fields = extractFeishuWebFields(data);
  const spaceKey = stringValue(firstDeepValue(source, [
    "space_key",
    "spaceKey",
    "project_simple_name",
    "projectSimpleName",
    "project_key",
    "projectKey",
  ]) || options.spaceKey);
  const typeKey = stringValue(firstDeepValue(source, [
    "work_item_type_key",
    "workItemTypeKey",
    "work_item_api_name",
    "workItemApiName",
    "type_key",
    "typeKey",
  ]) || options.workItemTypeKey);
  const title = webTextValue(firstFieldValue(fields, ["title", "name", "work_item_name", "workItemName"]))
    || webTextValue(firstDeepValue(source, ["title", "name", "summary", "work_item_name", "workItemName"]))
    || id;
  const workItemNo = webTextValue(firstFieldValue(fields, ["work_item_no", "workItemNo", "problem_no", "problemNo", "auto_number", "autoNumber"]))
    || webTextValue(firstDeepValue(source, ["work_item_no", "workItemNo", "problem_no", "problemNo", "auto_number", "autoNumber"]));
  const sourceUrl = stringValue(options.sourceUrl)
    || stringValue(firstDeepValue(source, ["source_url", "sourceUrl", "web_url", "webUrl", "url", "href", "link"]))
    || (spaceKey && typeKey ? `https://project.feishu.cn/${spaceKey}/${typeKey}/detail/${id}` : "");
  return {
    ...source,
    id,
    work_item_id: id,
    work_item_no: workItemNo || undefined,
    title,
    name: title,
    work_item_type_key: typeKey || undefined,
    space_key: spaceKey || undefined,
    source_url: sourceUrl || undefined,
    fields,
    raw: data,
    _captureSource: "web-detail",
  };
}

export function extractFeishuWebFields(data) {
  const byKey = new Map();
  const seen = new WeakSet();
  const names = collectFeishuWebFieldNames(data);
  walk(data, 0);
  return Array.from(byKey.values());

  function add(field) {
    const key = stringValue(field?.field_key || field?.fieldKey || field?.key || field?.uuid);
    if (!key) return;
    const value = field?.value ?? field?.field_value ?? field?.fieldValue ?? "";
    if (!hasWebValue(value)) return;
    const normalized = normKey(key);
    const fieldName = stringValue(field?.field_name || field?.fieldName || field?.name || field?.label)
      || names.get(normalized)
      || key;
    const next = {
      field_key: key,
      field_name: fieldName,
      field_type: stringValue(field?.field_type || field?.fieldType || field?.type || field?.uiType),
      value,
      display_value: webTextValue(value),
    };
    const current = byKey.get(normalized);
    if (!current || (!webTextValue(current.value) && webTextValue(next.value))) byKey.set(normalized, next);
  }

  function walk(value, depth) {
    if (depth > 18 || value == null) return;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 2000)) walk(item, depth + 1);
      return;
    }
    if (typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);

    for (const [key, child] of Object.entries(value)) {
      if (isLikelyWebFieldKey(key) && hasWebValue(child)) {
        add({
          field_key: key,
          field_name: names.get(normKey(key)) || key,
          value: normalizeWebFieldValue(child),
        });
      }
    }

    const explicitKey = stringValue(firstCaseInsensitive(value, ["field_key", "fieldKey", "uuid"]));
    const genericKey = stringValue(firstCaseInsensitive(value, ["key", "id"]));
    const fieldKey = explicitKey || (isLikelyWebFieldKey(genericKey) ? genericKey : "");
    if (fieldKey && hasFieldValueShape(value)) {
      add({
        field_key: fieldKey,
        field_name: stringValue(firstCaseInsensitive(value, ["field_name", "fieldName", "name", "label"])) || names.get(normKey(fieldKey)) || fieldKey,
        field_type: stringValue(firstCaseInsensitive(value, ["field_type", "fieldType", "type", "uiType"])),
        value: normalizeWebFieldValue(value),
      });
    }

    for (const child of Object.values(value)) {
      if (child && typeof child === "object") walk(child, depth + 1);
    }
  }
}

function unwrapFeishuWebDetailData(data) {
  const candidates = [
    data?.data?.work_item,
    data?.data?.workItem,
    data?.data?.work_item_detail,
    data?.data?.workItemDetail,
    data?.data?.detail,
    data?.data,
    data?.work_item,
    data?.workItem,
    data,
  ];
  return candidates.find((candidate) => candidate && typeof candidate === "object" && !Array.isArray(candidate)) || {};
}

function collectFeishuWebFieldNames(data) {
  const names = new Map();
  const seen = new WeakSet();
  walk(data, 0);
  return names;

  function walk(value, depth) {
    if (depth > 14 || value == null) return;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 2000)) walk(item, depth + 1);
      return;
    }
    if (typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    const key = stringValue(firstCaseInsensitive(value, ["field_key", "fieldKey", "uuid", "key", "id"]));
    const name = stringValue(firstCaseInsensitive(value, ["field_name", "fieldName", "name", "label", "title"]));
    if (key && name && (isLikelyWebFieldKey(key) || /field/i.test(Object.keys(value).join(" ")))) {
      names.set(normKey(key), name);
    }
    for (const child of Object.values(value)) {
      if (child && typeof child === "object") walk(child, depth + 1);
    }
  }
}

function normalizeWebFieldValue(value) {
  if (value == null || isPrimitive(value) || Array.isArray(value)) return value;
  if (typeof value !== "object") return value;

  const uiValue = firstCaseInsensitive(value, ["uiValue", "ui_value"]);
  if (uiValue !== null && uiValue !== undefined) {
    return normalizeWebUiValue(uiValue, firstCaseInsensitive(value, ["uiType", "ui_type", "type"]));
  }
  const direct = firstCaseInsensitive(value, ["field_value", "fieldValue", "display_value", "displayValue", "text", "plain_text", "plainText", "content"]);
  if (direct !== null && direct !== undefined && direct !== value) return direct;
  if (Object.prototype.hasOwnProperty.call(value, "value") || Object.prototype.hasOwnProperty.call(value, "values")) {
    const nested = firstCaseInsensitive(value, ["value", "values"]);
    if (nested !== value) return nested;
  }
  return normalizeWebUiValue(value, "");
}

function normalizeWebUiValue(uiValue, uiType = "") {
  if (uiValue == null || isPrimitive(uiValue) || Array.isArray(uiValue)) return uiValue;
  if (typeof uiValue !== "object") return uiValue;
  const typed = stringValue(uiType);
  const typedValue = typed ? firstCaseInsensitive(uiValue, [typed]) : null;
  if (typedValue !== null && typedValue !== undefined && typedValue !== uiValue) return normalizeWebUiValue(typedValue, "");
  for (const key of [
    "richText",
    "rich_text",
    "textarea",
    "text",
    "input",
    "select",
    "cascadeSelect",
    "cascade_select",
    "date",
    "number",
    "user",
    "member",
    "people",
  ]) {
    const nested = firstCaseInsensitive(uiValue, [key]);
    if (nested !== null && nested !== undefined && nested !== uiValue) return normalizeWebUiValue(nested, "");
  }
  const content = firstCaseInsensitive(uiValue, ["content", "contents", "children", "blocks", "paragraphs"]);
  if (content !== null && content !== undefined && content !== uiValue) return uiValue;
  const direct = firstCaseInsensitive(uiValue, ["value", "values", "label", "name", "displayValue", "display_value", "plainText", "plain_text"]);
  if (direct !== null && direct !== undefined && direct !== uiValue) return direct;
  return uiValue;
}

function firstFieldValue(fields, keys) {
  const wanted = new Set((keys || []).map(normKey));
  const field = (fields || []).find((item) => wanted.has(normKey(item.field_key)) || wanted.has(normKey(item.field_name)));
  return field?.value ?? "";
}

function firstDeepValue(data, keys = []) {
  const wanted = new Set(keys.map(normKey));
  const seen = new WeakSet();
  return walk(data, 0);

  function walk(value, depth) {
    if (depth > 12 || value == null) return null;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 2000)) {
        const found = walk(item, depth + 1);
        if (found !== null && found !== undefined && found !== "") return found;
      }
      return null;
    }
    if (typeof value !== "object") return null;
    if (seen.has(value)) return null;
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      if (wanted.has(normKey(key)) && child !== null && child !== undefined && child !== "") return child;
    }
    for (const child of Object.values(value)) {
      if (child && typeof child === "object") {
        const found = walk(child, depth + 1);
        if (found !== null && found !== undefined && found !== "") return found;
      }
    }
    return null;
  }
}

function hasFieldValueShape(obj = {}) {
  return ["uiValue", "ui_value", "field_value", "fieldValue", "display_value", "displayValue", "value", "values", "text", "content"]
    .some((key) => firstCaseInsensitive(obj, [key]) !== null && firstCaseInsensitive(obj, [key]) !== undefined);
}

function hasWebValue(value) {
  if (value === undefined || value === null || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isPrimitive(value)) return String(value).trim() !== "";
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function webTextValue(value) {
  if (value === undefined || value === null || value === "") return "";
  if (isPrimitive(value)) return String(value).trim();
  if (Array.isArray(value)) return value.map(webTextValue).filter(Boolean).join(", ");
  if (typeof value !== "object") return String(value).trim();
  for (const key of ["plain_text", "plainText", "text", "display_value", "displayValue", "label", "name", "title"]) {
    const direct = firstCaseInsensitive(value, [key]);
    if (isPrimitive(direct) && String(direct).trim()) return String(direct).trim();
  }
  const nested = firstCaseInsensitive(value, ["value", "values", "content", "contents", "children", "items", "blocks", "paragraphs"]);
  if (nested !== null && nested !== undefined && nested !== value) {
    const shown = webTextValue(nested);
    if (shown) return shown;
  }
  return "";
}

function isLikelyWebFieldKey(key = "") {
  const text = stringValue(key);
  if (!text) return false;
  if (/^field_[a-z0-9]+$/i.test(text)) return true;
  const normalized = normKey(text);
  return [
    "title",
    "name",
    "summary",
    "description",
    "desc",
    "detail",
    "details",
    "body",
    "content",
    "defectdescription",
    "bugdescription",
    "status",
    "priority",
    "severity",
    "assignee",
    "assignees",
    "reporter",
    "creator",
    "createdby",
    "duedate",
    "deadline",
    "createdat",
    "updatedat",
    "workitemno",
    "problemno",
    "autonumber",
    "currentstatusoperator",
  ].includes(normalized);
}

function normalizeWorkItemCandidate(obj = {}, options = {}) {
  const id = stringValue(first(obj, [
    "work_item_id",
    "workItemId",
    "work_object_id",
    "workObjectId",
    "issue_id",
    "issueId",
    "id",
  ]));
  const title = stringValue(first(obj, [
    "work_item_name",
    "workItemName",
    "work_item_title",
    "workItemTitle",
    "title",
    "name",
    "summary",
    "content",
  ]));
  const typeKey = stringValue(first(obj, ["work_item_type_key", "workItemTypeKey", "type_key", "typeKey"]));
  const spaceKey = stringValue(first(obj, ["space_key", "spaceKey", "project_key", "projectKey"]));
  const url = stringValue(first(obj, ["source_url", "sourceUrl", "web_url", "webUrl", "url", "href", "link"]));
  if (!id || (!title && !/detail/i.test(url) && !typeKey)) return null;
  if (id.length < 4 && !/^\d+$/.test(id)) return null;
  return {
    ...obj,
    id,
    work_item_id: id,
    title: title || id,
    name: title || id,
    work_item_type_key: typeKey || undefined,
    space_key: spaceKey || undefined,
    source_url: url || options.sourceUrl || undefined,
    _captureSource: options.sourceUrl || "",
  };
}

async function extractFeishuWorkItemsFromDom(page) {
  const rows = await page.evaluate(() => {
    const out = [];
    const links = Array.from(document.querySelectorAll("a[href*='/detail/'], a[href*='work_item'], a[href*='workItem']"));
    for (const link of links.slice(0, 500)) {
      const href = link.href || "";
      const m = href.match(/\/detail\/([^/?#]+)/i) || href.match(/[?&](?:work_item_id|workItemId|id)=([^&#]+)/i);
      const id = m ? decodeURIComponent(m[1]) : "";
      const container = link.closest("[role='row'], tr, li, article, .row, .item") || link.parentElement;
      const text = (container?.innerText || link.innerText || "").trim().replace(/\s+/g, " ");
      const title = text.split(/\n| {2,}/).find(Boolean) || link.textContent?.trim() || id;
      if (id) out.push({ id, work_item_id: id, title, name: title, source_url: href, _captureSource: "dom" });
    }
    return out;
  }).catch(() => []);
  return rows.map((row) => normalizeWorkItemCandidate(row, { sourceUrl: row.source_url })).filter(Boolean);
}

export function dedupeWorkItems(items = []) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const id = stringValue(item?.work_item_id || item?.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(item);
  }
  return out;
}

function first(obj, keys) {
  for (const key of keys) {
    if (obj && obj[key] !== undefined && obj[key] !== null && obj[key] !== "") return obj[key];
  }
  return "";
}

function firstCaseInsensitive(obj, keys) {
  if (!obj || typeof obj !== "object") return null;
  for (const key of keys || []) {
    if (Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined && obj[key] !== null && obj[key] !== "") return obj[key];
    const normalized = normKey(key);
    const hit = Object.keys(obj).find((candidate) => normKey(candidate) === normalized);
    if (hit && obj[hit] !== undefined && obj[hit] !== null && obj[hit] !== "") return obj[hit];
  }
  return null;
}

function normKey(value) {
  return String(value || "").trim().toLowerCase().replace(/[\s_-]+/g, "");
}

function isPrimitive(value) {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function stringValue(value) {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return "";
}

function normalizeStringList(value) {
  if (Array.isArray(value)) return value.flatMap(normalizeStringList);
  if (value === undefined || value === null || value === "") return [];
  return String(value)
    .split(/[\n,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
