import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import express from "express";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "devbench-tb-ticket-route-"));
process.env.GATEWAY_CONFIG_PATH = path.join(root, "gateway.json");
process.env.GATEWAY_DB_PATH = path.join(root, "gateway.db");
process.env.DEVBENCH_STORE_DIR = path.join(root, "store");
fs.writeFileSync(process.env.GATEWAY_CONFIG_PATH, JSON.stringify({
  role: "standalone",
  teambition: {
    operatorId: "tb-normal-user",
    userName: "普通 TB 用户",
    userCookie: "TB_SESSION=route-test",
  },
}), "utf8");

const { currentTbUserActor } = await import("../services/devbench-tb-user-access-policy.js");
const store = await import("../services/devbench/store.js");
const router = (await import("../routes/devbench.js")).default;

let server;
let base;
const originalFetch = globalThis.fetch;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.principal = currentTbUserActor();
    next();
  });
  app.use("/api/devbench", router);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}/api/devbench`;
});

after(async () => {
  globalThis.fetch = originalFetch;
  if (server) await new Promise((resolve) => server.close(resolve));
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
});

function upstreamResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function post(pathname, body) {
  return originalFetch(`${base}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function put(pathname, body) {
  return originalFetch(`${base}${pathname}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("普通 TB 用户可通过本人 Cookie 可见的 CARB 单号解析故事点入口", async () => {
  const task = {
    _id: "6a47ab5f34526c55d0b7224f",
    uniqueId: 13542,
    content: "当前用户可见的故事点工单",
    _projectId: "project-visible",
  };
  const upstreamUrls = [];
  globalThis.fetch = async (url) => {
    const value = String(url);
    upstreamUrls.push(value);
    if (value.includes("/api/v2/tasks/search?")) return upstreamResponse({ tasks: [task] });
    if (value.includes(`/api/tasks/${task._id}`)) return upstreamResponse(task);
    return upstreamResponse({}, 404);
  };

  const response = await post("/tb-task/resolve", { input: "CARB-13542" });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.data.tbTaskId, task._id);
  assert.equal(body.data.carbId, "CARB-13542");
  assert.ok(upstreamUrls.length >= 1);
  assert.ok(upstreamUrls.every((url) => !url.includes("open.teambition.com")));
});

test("普通 TB 用户无权读取目标单时解析与直接初始化都失败关闭", async () => {
  globalThis.fetch = async () => upstreamResponse({}, 403);

  const resolveResponse = await post("/tb-task/resolve", { input: "CARB-13543" });
  const resolveBody = await resolveResponse.json();
  assert.equal(resolveResponse.status, 403);
  assert.equal(resolveBody.code, "TB_TASK_ACCESS_DENIED");

  const initializeResponse = await post("/story-initializations", {
    title: "不可见工单故事点",
    ticketInput: "CARB-13543",
    configuration: {},
  });
  const initializeBody = await initializeResponse.json();
  assert.equal(initializeResponse.status, 403);
  assert.equal(initializeBody.code, "STORY_TICKET_ACCESS_DENIED");
});

test("普通 TB 用户切换远程模式时不能借已缓存任务绕过本人可见性校验", async () => {
  const taskId = "6a47ab5f34526c55d0b72250";
  store.importData({
    tasks: [{
      id: "cached-task-13545",
      carbId: "CARB-13545",
      tbTaskId: taskId,
      ticketUrl: `https://www.teambition.com/task/${taskId}`,
      title: "缓存中已有但当前用户不可见的工单",
    }],
  });
  const tab = store.createTab({ title: "远程拉取可见性门禁" });
  let lookupCount = 0;
  globalThis.fetch = async () => {
    lookupCount += 1;
    return upstreamResponse({}, 403);
  };

  const response = await put(`/tabs/${tab.id}/mode`, {
    mode: "remote",
    remotePull: { tbId: "CARB-13545", entries: [] },
  });
  const body = await response.json();
  assert.equal(response.status, 403);
  assert.equal(body.code, "TB_TASK_ACCESS_DENIED");
  assert.ok(lookupCount > 0);

  const unchanged = store.getTab(tab.id);
  assert.notEqual(unchanged.mode, "remote");
  assert.equal(String(unchanged.ticketUrl || ""), "");
});

test("普通 TB 用户切换远程模式时可自动绑定本人可见的 TB 单", async () => {
  const task = {
    _id: "6a47ab5f34526c55d0b72251",
    uniqueId: 13546,
    content: "当前用户可见的远程拉取工单",
  };
  const tab = store.createTab({ title: "远程拉取可见工单" });
  globalThis.fetch = async (url) => String(url).includes("/api/v2/tasks/search?")
    ? upstreamResponse({ tasks: [task] })
    : upstreamResponse({}, 404);

  const response = await put(`/tabs/${tab.id}/mode`, {
    mode: "remote",
    remotePull: { tbId: "CARB-13546", entries: [] },
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.data.mode, "remote");
  assert.equal(body.data.ticketUrl, `https://www.teambition.com/task/${task._id}`);
  assert.equal(body.autoTicket?.resolved?.userAccessVerified, true);
});

test("普通 TB 用户 Cookie 过期时保留重新登录提示而不是误报网关故障", async () => {
  globalThis.fetch = async () => upstreamResponse({}, 401);
  const response = await post("/tb-task/resolve", { input: "CARB-13544" });
  const body = await response.json();
  assert.equal(response.status, 401);
  assert.equal(body.code, "TB_LOGIN_EXPIRED");
  assert.equal(body.needLogin, true);

  const tab = store.createTab({ title: "Cookie 过期绑定门禁" });
  const bindResponse = await post(`/tabs/${tab.id}/ticket`, { url: "CARB-13544" });
  const bindBody = await bindResponse.json();
  assert.equal(bindResponse.status, 401);
  assert.equal(bindBody.code, "TB_LOGIN_EXPIRED");
  assert.equal(bindBody.needLogin, true);
  assert.equal(String(store.getTab(tab.id)?.ticketUrl || ""), "");
});
