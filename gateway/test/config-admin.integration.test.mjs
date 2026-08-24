/**
 * /api/config 字段级管理员权限 集成测试（隔离 config/db/totp）：
 *   - 管理员字段(role/claudeProxy/executor/distributedExecution/servers.nodeName/servers.nodeOwnerName/servers.inboundToken)：无管理员 token → 403
 *   - 普通字段(maxSubtasks 等)：无 token 也可改
 *   - 管理员 token 改管理员字段 → 成功 + 写审计(config:xxx)
 *   - 统一入站口令 servers.inboundToken 可被管理员写入
 * 用隔离 ADMIN_TOTP_DIR 生成临时 TOTP 密钥换取 super token，绝不触碰真实密钥。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { totp } from "../services/totp.js";
import { bootGateway, waitHealth } from "./_helpers.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cfgadm-"));
const PORT = 39601;
const cfgPath = path.join(tmp, "gw.json");
fs.writeFileSync(cfgPath, JSON.stringify({ role: "standalone", maxSubtasks: 5 }));

const base = `http://localhost:${PORT}`;
const put = (body, token) => fetch(`${base}/api/config`, {
  method: "PUT", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});
const putCodeup = (body, extraHeaders = {}) => fetch(`${base}/api/config/codeup`, {
  method: "PUT", headers: { "Content-Type": "application/json", ...extraHeaders }, body: JSON.stringify(body),
});
const getCfg = () => fetch(`${base}/api/config`).then((r) => r.json()).then((d) => d.data);

let srv, token;
before(async () => {
  srv = bootGateway({ port: PORT, role: "standalone", gwCfg: cfgPath, market: path.join(tmp, "m.json"), storeDir: path.join(tmp, "s"), dbPath: path.join(tmp, "data.db"), totpDir: path.join(tmp, "secrets") });
  await waitHealth(PORT, srv);
  // 取隔离的临时 TOTP 密钥 → 算码 → 登录拿 super token
  const setup = await fetch(`${base}/api/admin/auth/totp/setup`).then((r) => r.json());
  const secret = setup.data?.secret || setup.secret;
  assert.ok(secret, "未拿到隔离 TOTP 密钥");
  const code = totp(secret);
  const login = await fetch(`${base}/api/admin/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) }).then((r) => r.json());
  assert.ok(login.ok && login.token, "TOTP 登录失败");
  token = login.token;
}, { timeout: 40000 });
after(() => { try { srv.kill(); } catch {} });

test("普通字段无 token 可改", async () => {
  const cur = await getCfg();
  const r = await put({ ...cur, maxSubtasks: 9 });
  const d = await r.json();
  assert.equal(r.status, 200, JSON.stringify(d));
  assert.equal(d.success, true);
  assert.equal((await getCfg()).maxSubtasks, 9);
});

test("API Key 对客户端脱敏，提交掩码不会覆盖真实 Key", async () => {
  const cur = await getCfg();
  const deepseek = { ...(cur.apiEngines?.deepseek || {}), enabled: true, apiKey: "integration-secret-key" };
  const r = await put(
    { ...cur, apiEngines: { ...(cur.apiEngines || {}), deepseek } },
    token,
  );
  const body = await r.json();
  assert.equal(r.status, 200);
  assert.equal(body.data.apiEngines.deepseek.apiKey, "********");
  const masked = await getCfg();
  assert.equal(masked.apiEngines.deepseek.apiKey, "********");

  // 设置页修改其它字段时会把掩码原样提交；后端必须恢复原 Key。
  await put({ ...masked, maxSubtasks: 10 });
  const stored = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  assert.equal(stored.apiEngines.deepseek.apiKey, "integration-secret-key");
});

test("Atlas 全局客户端配置接口无管理员 token 时 fail closed", async () => {
  const response = await fetch(`${base}/api/config/atlas/apply/codex`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiKey: "must-not-be-written",
      baseUrl: "https://api.atlascloud.ai/v1",
      model: "zai-org/glm-5.1",
    }),
  });
  const body = await response.json();
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(body.success, false);
  assert.doesNotMatch(JSON.stringify(body), /must-not-be-written/);
});

test("Teambition Cookie 和 App Secret 仅管理员可改、对客户端脱敏且掩码回传不覆盖", async () => {
  const unauthenticatedManual = await fetch(`${base}/api/tb-tasks/cookie-verify-save`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cookie: "sid=blocked" }),
  });
  assert.ok([401, 403].includes(unauthenticatedManual.status));

  const unauthenticated = await put({
    teambition: { appId: "tb-app", appSecret: "tb-app-secret", userCookie: "sid=blocked" },
  });
  assert.equal(unauthenticated.status, 403);

  const saved = await put({
    teambition: { appId: "tb-app", appSecret: "tb-app-secret", userCookie: "sid=stored-secret" },
  }, token);
  const savedBody = await saved.json();
  assert.equal(saved.status, 200, JSON.stringify(savedBody));
  assert.equal(savedBody.data.teambition.appSecret, "***");
  assert.equal(savedBody.data.teambition.userCookie, "***");
  assert.equal(savedBody.data.teambition.userCookieConfigured, true);
  assert.doesNotMatch(JSON.stringify(savedBody), /tb-app-secret|stored-secret/);

  const masked = await getCfg();
  const updated = await put({
    teambition: { ...masked.teambition, operatorId: "operator-2" },
  }, token);
  assert.equal(updated.status, 200);
  const stored = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  assert.equal(stored.teambition.appSecret, "tb-app-secret");
  assert.equal(stored.teambition.userCookie, "sid=stored-secret");
  assert.equal(stored.teambition.operatorId, "operator-2");
  assert.equal("userCookieConfigured" in stored.teambition, false);
});

test("Codeup 敏感接口拒绝非本机网页来源", async () => {
  const headers = { "Content-Type": "application/json", Origin: "https://untrusted.example" };
  const beforeCodeup = JSON.parse(fs.readFileSync(cfgPath, "utf8")).codeup;
  const check = await fetch(`${base}/api/config/codeup/check`, {
    method: "POST",
    headers,
    body: JSON.stringify({ edition: "central", organizationId: "org-untrusted", accessToken: "pt-untrusted-secret" }),
  });
  const checkBody = await check.json();
  assert.equal(check.status, 403);
  assert.equal(check.headers.get("cache-control"), "no-store");
  assert.equal(checkBody.success, false);
  assert.doesNotMatch(JSON.stringify(checkBody), /pt-untrusted-secret/);

  const dedicatedWrite = await putCodeup({
    edition: "central",
    organizationId: "org-untrusted",
    accessToken: "pt-untrusted-secret",
  }, { Origin: "https://untrusted.example" });
  assert.equal(dedicatedWrite.status, 403);
  assert.equal(dedicatedWrite.headers.get("cache-control"), "no-store");

  const cur = await getCfg();
  const write = await fetch(`${base}/api/config`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      ...cur,
      codeup: { ...(cur.codeup || {}), organizationId: "org-untrusted", accessToken: "pt-untrusted-secret" },
    }),
  });
  assert.equal(write.status, 403);
  assert.equal(write.headers.get("cache-control"), "no-store");
  const stored = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  assert.deepEqual(stored.codeup, beforeCodeup);
});

test("Codeup 只读检测缺少令牌时不调用外部服务且禁止缓存", async () => {
  const response = await fetch(`${base}/api/config/codeup/check`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ edition: "central", organizationId: "org-local" }),
  });
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(body.reason, "missing_config");
  assert.deepEqual(body.missing, ["accessToken"]);
});

test("Codeup 个人令牌对客户端脱敏，提交掩码不会覆盖真实令牌", async () => {
  const beforeMaxSubtasks = (await getCfg()).maxSubtasks;
  const r = await putCodeup({
    edition: "central",
    organizationId: "org-integration",
    accessToken: "pt-integration-secret",
  });
  const body = await r.json();
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.equal(body.data.codeup.accessToken, "***");
  assert.equal(body.data.codeup.accessTokenConfigured, true);
  assert.equal(body.data.codeup.accessTokenManagedByEnvironment, false);
  assert.equal((await getCfg()).maxSubtasks, beforeMaxSubtasks, "专用接口不得覆盖其它配置");

  const masked = await getCfg();
  assert.equal(masked.codeup.accessToken, "***");
  await put({ ...masked, maxSubtasks: 11 });
  const stored = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  assert.equal(stored.codeup.accessToken, "pt-integration-secret");
  assert.equal("accessTokenConfigured" in stored.codeup, false);

  const cleared = await putCodeup({ ...masked.codeup, accessToken: "" });
  const clearedBody = await cleared.json();
  assert.equal(cleared.status, 200);
  assert.equal(clearedBody.data.codeup.accessTokenConfigured, false);
  assert.equal(JSON.parse(fs.readFileSync(cfgPath, "utf8")).codeup.accessToken, "");
});

test("Codeup 专用保存接口拒绝明文 Region 接入点", async () => {
  const response = await putCodeup({
    edition: "region",
    apiBaseUrl: "http://codeup.region.example",
    accessToken: "pt-region-secret",
  });
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(body.reason, "invalid_api_base");
  assert.doesNotMatch(JSON.stringify(body), /pt-region-secret/);
  assert.notEqual(JSON.parse(fs.readFileSync(cfgPath, "utf8")).codeup.accessToken, "pt-region-secret");
});

test("Codeup 环境变量展示有效值且专用接口不能覆盖", async () => {
  const envTmp = fs.mkdtempSync(path.join(os.tmpdir(), "cfgadm-codeup-env-"));
  const envCfgPath = path.join(envTmp, "gw.json");
  const envPort = 39602;
  fs.writeFileSync(envCfgPath, JSON.stringify({
    role: "standalone",
    codeup: {
      edition: "central",
      apiBaseUrl: "https://openapi-rdc.aliyuncs.com",
      organizationId: "org-stored",
      accessToken: "pt-stored-secret",
    },
  }));
  const envServer = bootGateway({
    port: envPort,
    role: "standalone",
    gwCfg: envCfgPath,
    market: path.join(envTmp, "m.json"),
    storeDir: path.join(envTmp, "s"),
    dbPath: path.join(envTmp, "data.db"),
    totpDir: path.join(envTmp, "secrets"),
    extraEnv: {
      CODEUP_ACCESS_TOKEN: "pt-env-secret",
      CODEUP_ORGANIZATION_ID: "org-env",
      CODEUP_EDITION: "region",
      CODEUP_API_BASE_URL: "https://codeup.region.example",
    },
  });
  try {
    await waitHealth(envPort, envServer);
    const envBase = `http://localhost:${envPort}`;
    const read = await fetch(`${envBase}/api/config`);
    const readBody = await read.json();
    const effective = readBody.data.codeup;
    assert.equal(read.headers.get("cache-control"), "no-store");
    assert.equal(effective.accessToken, "***");
    assert.equal(effective.accessTokenManagedByEnvironment, true);
    assert.equal(effective.organizationId, "org-env");
    assert.equal(effective.organizationIdManagedByEnvironment, true);
    assert.equal(effective.edition, "region");
    assert.equal(effective.editionManagedByEnvironment, true);
    assert.equal(effective.apiBaseUrl, "https://codeup.region.example");
    assert.equal(effective.apiBaseUrlManagedByEnvironment, true);
    assert.doesNotMatch(JSON.stringify(readBody), /pt-env-secret|pt-stored-secret/);

    const write = await fetch(`${envBase}/api/config/codeup`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        edition: "central",
        apiBaseUrl: "https://replacement.example",
        organizationId: "org-replacement",
        accessToken: "pt-replacement-secret",
        reviewerName: "新评审人",
      }),
    });
    const writeBody = await write.json();
    assert.equal(write.status, 200);
    assert.equal(writeBody.data.codeup.edition, "region");
    assert.equal(writeBody.data.codeup.accessTokenManagedByEnvironment, true);
    assert.doesNotMatch(JSON.stringify(writeBody), /pt-env-secret|pt-stored-secret|pt-replacement-secret/);
    const stored = JSON.parse(fs.readFileSync(envCfgPath, "utf8")).codeup;
    assert.equal(stored.accessToken, "pt-stored-secret");
    assert.equal(stored.organizationId, "org-stored");
    assert.equal(stored.edition, "central");
    assert.equal(stored.reviewerName, "新评审人");
  } finally {
    try { envServer.kill(); } catch {}
  }
}, { timeout: 40000 });

test("管理员字段 role 无 token → 403 且不落库", async () => {
  const cur = await getCfg();
  const before = cur.role;
  const r = await put({ ...cur, role: "server" });
  assert.equal(r.status, 403);
  assert.equal((await getCfg()).role, before, "未授权不应改动 role");
});

test("管理员字段 claudeProxy 无 token → 403", async () => {
  const cur = await getCfg();
  const r = await put({ ...cur, claudeProxy: { ...cur.claudeProxy, enabled: true, maxConcurrent: 5 } });
  assert.equal(r.status, 403);
  assert.equal((await getCfg()).claudeProxy.enabled, false);
});

test("管理员字段 distributedExecution 无 token → 403", async () => {
  const cur = await getCfg();
  const before = cur.distributedExecution?.enabled !== false;
  const r = await put({ ...cur, distributedExecution: { ...(cur.distributedExecution || {}), enabled: !before } });
  assert.equal(r.status, 403);
  assert.equal((await getCfg()).distributedExecution.enabled !== false, before);
});

test("车型配置中心和 LAN 传输策略只能由管理员修改", async () => {
  const cur = await getCfg();
  const center = await put({
    vehicleConfigCenter: { enabled: true, host: "http://center.example:3001", token: "blocked-token" },
  });
  assert.equal(center.status, 403);
  const transport = await put({
    lanSync: { ...(cur.lanSync || {}), allowInsecureTransport: true },
  });
  assert.equal(transport.status, 403);
  const discoverySeed = await put({
    servers: { ...(cur.servers || {}), discoverySeeds: ["http://192.168.10.110:3001"] },
  });
  assert.equal(discoverySeed.status, 403);
  const after = await getCfg();
  assert.equal(after.vehicleConfigCenter.enabled, false);
  assert.equal(after.lanSync.allowInsecureTransport, false);
  assert.deepEqual(after.servers.discoverySeeds || [], []);
});

test("管理员可以预置跨子网签名发现引导节点", async () => {
  const cur = await getCfg();
  const response = await put({
    servers: { ...(cur.servers || {}), discoverySeeds: ["http://192.168.10.110:3001"] },
  }, token);
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(body.data.servers.discoverySeeds, ["http://192.168.10.110:3001"]);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(cfgPath, "utf8")).servers.discoverySeeds,
    ["http://192.168.10.110:3001"],
  );
});

test("车型配置中心口令对客户端脱敏且掩码回传不覆盖", async () => {
  const saved = await put({
    vehicleConfigCenter: {
      enabled: true,
      host: "http://center.example:3001",
      token: "vehicle-center-secret",
    },
    servers: { ...(await getCfg()).servers, peers: ["http://center.example:3001"] },
  }, token);
  const body = await saved.json();
  assert.equal(saved.status, 200, JSON.stringify(body));
  assert.equal(body.data.vehicleConfigCenter.token, "***");
  assert.doesNotMatch(JSON.stringify(body), /vehicle-center-secret/);

  const masked = await getCfg();
  const roundTrip = await put({ vehicleConfigCenter: masked.vehicleConfigCenter }, token);
  assert.equal(roundTrip.status, 200);
  assert.equal(
    JSON.parse(fs.readFileSync(cfgPath, "utf8")).vehicleConfigCenter.token,
    "vehicle-center-secret",
  );
});

test("管理员 token 改 role + 统一入站口令 → 成功", async () => {
  const cur = await getCfg();
  const r = await put({ ...cur, role: "server", servers: { ...cur.servers, nodeName: "中心甲", inboundToken: "lan-secret-1" } }, token);
  const d = await r.json();
  assert.equal(r.status, 200);
  assert.equal(d.success, true);
  const after = await getCfg();
  assert.equal(after.role, "server");
  assert.equal(after.servers.nodeName, "中心甲");
  assert.equal(after.servers.nodeOwnerName, "超级管理员");
  assert.equal(after.servers.inboundToken, "***", "配置读取不得向浏览器返回 M2M 明文口令");
  assert.equal(
    JSON.parse(fs.readFileSync(cfgPath, "utf8")).servers.inboundToken,
    "lan-secret-1",
    "落盘配置仍应保存真实 M2M 口令",
  );
  const maskedRoundTrip = await put({ ...after, maxSubtasks: 10 });
  assert.equal(maskedRoundTrip.status, 200, "掩码配置回传不应覆盖口令或误触管理员变更");
  assert.equal(
    JSON.parse(fs.readFileSync(cfgPath, "utf8")).servers.inboundToken,
    "lan-secret-1",
  );
  const info = await fetch(`${base}/api/discovery/info`).then((x) => x.json());
  assert.equal(info.data.name, "超级管理员-中心甲");
});

test("管理员改动写入审计(config:xxx，秘钥脱敏)", async () => {
  const r = await fetch(`${base}/api/devbench/audit`, { headers: { Authorization: `Bearer ${token}` } }).then((x) => x.json());
  assert.equal(r.ok, true);
  const targets = r.data.map((e) => e.target);
  assert.ok(targets.includes("config:role"), `应有 config:role 审计，实际: ${targets}`);
  assert.ok(targets.includes("config:servers.inboundToken"), "应有 inboundToken 审计");
  // 脱敏：inboundToken 的 after 不得是明文
  const e = r.data.find((x) => x.target === "config:servers.inboundToken");
  assert.ok(!String(e.after).includes("lan-secret-1"), "入站口令审计须脱敏");
});
