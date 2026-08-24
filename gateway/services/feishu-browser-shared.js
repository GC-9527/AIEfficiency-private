/**
 * 飞书项目网页 / MCP 远程浏览器共享常量与配置回写
 */
import { broadcastAll } from "./logger.js";
import { getConfig, updateConfig } from "./config.js";
import { canUseLocalGuiBrowser, findBrowser } from "./tb-browser-shared.js";

export const FEISHU_MCP_PAGE_URL = "https://project.feishu.cn/b/mcp";
/** 登录后选企业/空间列表（勿直接跳 /b/mcp，否则常报租户不合法） */
export const FEISHU_TENANT_PICKER_URL = "https://project.feishu.cn/";
/** 账号中心：切换企业 / 退出换号 */
export const FEISHU_ACCOUNT_HOME_URL = "https://accounts.feishu.cn/accounts/home";
export const FEISHU_VIEWER_PATH = "/feishu-browser";
export const FEISHU_PROFILE_REL = "gateway/.tmp/feishu-project-web-profile";

export { canUseLocalGuiBrowser, findBrowser };

/** 进入真实项目空间以绑定 meego_tenant_key（避免 /b/mcp 直接报「租户不合法」） */
export function getFeishuProjectWarmupUrl() {
  try {
    const feishu = getConfig()?.feishuProjectSync?.feishu || {};
    const home = String(feishu?.web?.homepageUrl || "").trim();
    if (home && /project\.feishu\.cn/i.test(home) && !/\/b\/mcp/i.test(home)) return home;
    const views = getConfig()?.feishuProjectSync?.sourceViews || [];
    for (const view of views) {
      const url = String(view?.url || "").trim();
      if (url && /project\.feishu\.cn/i.test(url) && !/\/b\/mcp/i.test(url)) return url;
    }
    const space = String(feishu.spaceKey || "intelligentspace").trim() || "intelligentspace";
    return `https://project.feishu.cn/${encodeURIComponent(space)}/bug/homepage`;
  } catch {
    return "https://project.feishu.cn/intelligentspace/bug/homepage";
  }
}

export function broadcastFeishuBrowserStatus(status, message, extra = {}) {
  broadcastAll(JSON.stringify({
    type: "feishu_login_status",
    data: { status, message, ...extra },
  }));
}

export function saveFeishuMcpTokenToConfig(token) {
  const value = String(token || "").trim();
  if (!value) throw new Error("empty MCP token");
  const current = getConfig();
  const currentSync = current.feishuProjectSync || {};
  const currentFeishu = currentSync.feishu || {};
  const currentMcp = currentFeishu.mcp || {};
  const nextSync = {
    ...currentSync,
    enabled: true,
    feishu: {
      ...currentFeishu,
      authMode: "mcp",
      mcp: {
        ...currentMcp,
        enabled: true,
        transport: currentMcp.transport || "http-oauth",
        serverUrl: currentMcp.serverUrl || "https://project.feishu.cn/mcp_server/v1",
        headerName: currentMcp.headerName || "X-Mcp-Token",
        token: value,
      },
    },
  };
  updateConfig({ feishuProjectSync: nextSync });
  return {
    tokenLength: value.length,
    authMode: "mcp",
  };
}
