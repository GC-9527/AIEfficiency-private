/**
 * 钉钉扫码登录（阶段B）。新版 OAuth2 流程：
 *   前端用 AppKey 唤起扫码 → 拿到 authCode → 后端用此 code 换 userAccessToken
 *   → /contact/users/me 拿 unionId → 用企业 token 把 unionId 映射成企业 userid
 *   → 对照 admin_users 名单签发后台 token。
 * 复用 dingtalk-members 的企业 access_token（同一个内部应用 AppKey/AppSecret）。
 */
import { getConfig } from "./config.js";
import { getAccessToken } from "./dingtalk-members.js";

const API = "https://api.dingtalk.com";
const OAPI = "https://oapi.dingtalk.com";

/** 前端构建扫码二维码所需配置（不含 secret）。 */
export function getDingOauthConfig() {
  const cfg = getConfig();
  const clientId = cfg.dingtalkAppKey || "";
  const redirectUri = (cfg.adminAuth && cfg.adminAuth.dingRedirectUri) || "";
  return {
    enabled: !!(clientId && cfg.dingtalkAppSecret),
    clientId,
    redirectUri, // 为空时前端用当前页面 origin 兜底
  };
}

/** 用扫码 authCode 换取用户身份。返回 { dingUserid, name, unionId }，失败抛错。 */
export async function exchangeAuthCode(authCode) {
  const cfg = getConfig();
  const clientId = cfg.dingtalkAppKey, clientSecret = cfg.dingtalkAppSecret;
  if (!clientId || !clientSecret) throw new Error("未配置钉钉应用凭证（dingtalkAppKey/dingtalkAppSecret）");
  if (!authCode) throw new Error("缺少 authCode");

  // 1) authCode → userAccessToken
  const tr = await fetch(`${API}/v1.0/oauth2/userAccessToken`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId, clientSecret, code: authCode, grantType: "authorization_code" }),
  });
  const td = await tr.json();
  if (!td.accessToken) throw new Error(`换取用户 token 失败: ${td.message || td.code || tr.status}`);

  // 2) userAccessToken → 个人信息（含 unionId）
  const mr = await fetch(`${API}/v1.0/contact/users/me`, {
    headers: { "x-acs-dingtalk-access-token": td.accessToken },
  });
  const me = await mr.json();
  const unionId = me.unionId || me.unionid;
  if (!unionId) throw new Error(`获取钉钉用户信息失败: ${me.message || me.code || mr.status}`);
  const nick = me.nick || me.nickname || "";

  // 3) unionId → 企业 userid（用企业 access_token）
  const corpToken = await getAccessToken();
  const ur = await fetch(`${OAPI}/topapi/user/getbyunionid?access_token=${corpToken}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ unionid: unionId }),
  });
  const ud = await ur.json();
  if (ud.errcode !== 0 || !ud.result?.userid) {
    throw new Error(`映射企业 userid 失败: ${ud.errmsg || ud.errcode}（该钉钉账号可能不在本企业）`);
  }

  return { dingUserid: ud.result.userid, name: nick, unionId };
}
