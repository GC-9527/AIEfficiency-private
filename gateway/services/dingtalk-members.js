/**
 * 钉钉企业成员拉取（用 dingtalkAppKey/dingtalkAppSecret 走 OAPI）。
 * 超级管理员在管理后台据此搜索/选择成员设为管理员。带 token + 成员列表缓存。
 */
import { getConfig } from "./config.js";
import { log } from "./logger.js";

const OAPI = "https://oapi.dingtalk.com";
let tokenCache = { token: "", exp: 0 };
let membersCache = { list: [], ts: 0 };

export async function getAccessToken() {
  const cfg = getConfig();
  const key = cfg.dingtalkAppKey, secret = cfg.dingtalkAppSecret;
  if (!key || !secret) throw new Error("未配置钉钉应用凭证（dingtalkAppKey/dingtalkAppSecret）");
  if (tokenCache.token && tokenCache.exp > Date.now()) return tokenCache.token;
  const r = await fetch(`${OAPI}/gettoken?appkey=${encodeURIComponent(key)}&appsecret=${encodeURIComponent(secret)}`);
  const d = await r.json();
  if (d.errcode !== 0 || !d.access_token) throw new Error(`获取钉钉 token 失败: ${d.errmsg || d.errcode}`);
  tokenCache = { token: d.access_token, exp: Date.now() + (d.expires_in || 7200) * 1000 - 60000 };
  return tokenCache.token;
}

async function post(path, token, body) {
  const r = await fetch(`${OAPI}${path}?access_token=${token}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const d = await r.json();
  if (d.errcode !== 0) throw new Error(`${path} 失败: ${d.errmsg || d.errcode}`);
  return d;
}

// BFS 收集所有部门 id（含根 1）
async function allDeptIds(token) {
  const ids = [1];
  const queue = [1];
  while (queue.length) {
    const pid = queue.shift();
    try {
      const d = await post("/topapi/v2/department/listsub", token, { dept_id: pid });
      for (const dep of d.result || []) { ids.push(dep.dept_id); queue.push(dep.dept_id); }
    } catch { /* 某部门失败跳过 */ }
    if (ids.length > 2000) break; // 安全上限
  }
  return [...new Set(ids)];
}

/**
 * 拉取全部企业成员（去重）。返回 [{ userid, name, mobile }]。带 10 分钟缓存。force 强制刷新。
 * mobile 仅在钉钉应用有「通讯录手机号读取」权限时返回，否则为空串。
 */
export async function getDingtalkMembers(force) {
  if (!force && membersCache.list.length && Date.now() - membersCache.ts < 10 * 60 * 1000) return membersCache.list;
  const token = await getAccessToken();
  const deptIds = await allDeptIds(token);
  const byId = new Map();
  for (const deptId of deptIds) {
    let cursor = 0;
    for (let page = 0; page < 50; page++) {
      let d;
      try { d = await post("/topapi/v2/user/list", token, { dept_id: deptId, cursor, size: 100 }); }
      catch { break; }
      const res = d.result || {};
      for (const u of res.list || []) if (u.userid) byId.set(u.userid, { userid: u.userid, name: u.name || u.userid, mobile: u.mobile || "" });
      if (!res.has_more) break;
      cursor = res.next_cursor;
    }
  }
  const list = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, "zh"));
  membersCache = { list, ts: Date.now() };
  log("system", "info", "ding-members", `拉取钉钉成员 ${list.length} 人（含手机号 ${list.filter((m) => m.mobile).length} 人）`);
  return list;
}

/**
 * 按姓名解析手机号（用于钉钉机器人真 @）。names=["付浩","张明"]。
 * 返回 { resolved: {name: mobile}, missing: [name], mobiles: [mobile] }。
 * 需配 dingtalkAppKey/Secret 且应用有手机号读取权限；否则抛错/返回空 mobiles。
 */
export async function resolveMobilesByNames(names, force) {
  const want = (names || []).map((n) => String(n || "").trim()).filter(Boolean);
  const out = { resolved: {}, missing: [], mobiles: [] };
  if (!want.length) return out;
  let members = [];
  try { members = await getDingtalkMembers(force); } catch (e) { out.error = e.message; out.missing = want.slice(); return out; }
  for (const nm of want) {
    const hit = members.find((m) => m.name === nm && m.mobile) || members.find((m) => m.name === nm);
    if (hit && hit.mobile) { out.resolved[nm] = hit.mobile; out.mobiles.push(hit.mobile); }
    else out.missing.push(nm);
  }
  return out;
}
