import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, test } from "node:test";

import { api as aiAutoWorkApi } from "./aiautowork/api.js";
import { cardevApi } from "./cardev/api.js";
import {
  __resetAdminSessionForTests,
} from "../services/adminAuth.js";
import { setGatewayAdminToken, startTbTasksLogin } from "../services/gateway.js";

const originalFetch = globalThis.fetch;
const originalLocalStorage = globalThis.localStorage;
const originalWindow = globalThis.window;
const token = "6a".repeat(24);
let requests;

function createLocalStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

beforeEach(() => {
  requests = [];
  globalThis.localStorage = createLocalStorage();
  globalThis.window = {
    location: new URL("https://panel.example/devices"),
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
  };
  globalThis.fetch = async (input, init = {}) => {
    requests.push({ input: String(input), init });
    return new Response(JSON.stringify({ ok: true, data: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  assert.equal(setGatewayAdminToken(token), true);
});

afterEach(() => {
  __resetAdminSessionForTests();
  globalThis.fetch = originalFetch;
  globalThis.localStorage = originalLocalStorage;
  globalThis.window = originalWindow;
});

test("AI Workbench keeps reads anonymous and authenticates writes without changing payloads", async () => {
  await aiAutoWorkApi.health();
  await aiAutoWorkApi.createTaskDraft({ title: "draft" });

  assert.equal(requests[0].input, "/api/aiautowork/health");
  assert.equal(new Headers(requests[0].init.headers).has("Authorization"), false);
  assert.equal(requests[1].input, "/api/aiautowork/task-drafts");
  assert.equal(requests[1].init.method, "POST");
  assert.equal(requests[1].init.headers.get("Authorization"), `Bearer ${token}`);
  assert.equal(requests[1].init.headers.get("Content-Type"), "application/json");
  assert.equal(requests[1].init.body, JSON.stringify({ title: "draft" }));
});

test("CarDev keeps GET semantics and authenticates POST and DELETE", async () => {
  await cardevApi.listDevices();
  await cardevApi.connect("192.0.2.10");
  await cardevApi.deleteCommand("command-1");

  assert.equal(new Headers(requests[0].init.headers).has("Authorization"), false);
  assert.equal(requests[1].init.method, "POST");
  assert.equal(requests[1].init.headers.get("Authorization"), `Bearer ${token}`);
  assert.equal(requests[1].init.body, JSON.stringify({ ip: "192.0.2.10" }));
  assert.equal(requests[2].init.method, "DELETE");
  assert.equal(requests[2].init.headers.get("Authorization"), `Bearer ${token}`);
  assert.equal(requests[2].init.body, undefined);
});

test("Devices safeFetch uses the shared authenticated transport only for writes", () => {
  const source = readFileSync(new URL("./Devices.jsx", import.meta.url), "utf8");
  const safeFetch = source.slice(
    source.indexOf("async function safeFetch"),
    source.indexOf("async function handleDiscover"),
  );

  assert.match(source, /import \{ authenticatedFetch \} from "\.\.\/services\/adminAuth\.js"/);
  assert.match(safeFetch, /method === "GET" \|\| method === "HEAD"/);
  assert.match(safeFetch, /\? fetch\s*:\s*authenticatedFetch/);
  assert.match(safeFetch, /await transport\(url, options\)/);
  assert.doesNotMatch(safeFetch, /await fetch\(url, options\)/);
});

test("TB 普通用户扫码公开，但其它业务写入和手工 Cookie 仍使用管理员传输", async () => {
  const publicLogin = await startTbTasksLogin();
  assert.equal(publicLogin.success, true);
  assert.equal(new Headers(requests[0].init.headers).has("Authorization"), false);

  const skills = readFileSync(new URL("./Skills.jsx", import.meta.url), "utf8");
  const tbTasks = readFileSync(new URL("./TbTasks.jsx", import.meta.url), "utf8");
  const settings = readFileSync(new URL("./Settings.jsx", import.meta.url), "utf8");
  const feishu = readFileSync(new URL("./FeishuProjectSync.jsx", import.meta.url), "utf8");
  const taskPanel = readFileSync(new URL("./devbench/TaskPanel.jsx", import.meta.url), "utf8");

  assert.match(skills, /import \{ authenticatedFetch \} from "\.\.\/services\/adminAuth\.js"/);
  assert.equal((skills.match(/authenticatedFetch\(getApiUrl/g) || []).length, 5);
  assert.match(tbTasks, /import \{ authenticatedFetch \} from "\.\.\/services\/adminAuth\.js"/);
  assert.equal((tbTasks.match(/authenticatedFetch\(getApiUrl/g) || []).length, 6);
  assert.match(settings, /\["POST", "PUT", "PATCH", "DELETE"\]\.includes\(method\)/);
  assert.match(settings, /\? authenticatedFetch\s*:\s*fetch/);
  const atlasGlobalConfigHandler = settings.slice(
    settings.indexOf("async function applyAtlasToClient"),
    settings.indexOf("async function copyVolcengineOpenCodeConfig"),
  );
  assert.match(atlasGlobalConfigHandler, /authenticatedFetch\(getApiUrl\(`\/api\/config\/atlas\/apply\//);
  assert.doesNotMatch(atlasGlobalConfigHandler, /await fetch\(/, "Atlas 全局配置写入必须携带管理员身份");
  assert.match(settings, /startTbTasksLogin\(\)/);
  assert.doesNotMatch(settings, /管理员登录后提取/);
  const tbProjectList = settings.slice(
    settings.indexOf("function TbProjectList"),
    settings.indexOf("function TbCookieCheck"),
  );
  assert.match(tbProjectList, /fetch\(\s*getApiUrl\("\/api\/devbench\/tb-projects\/available"\)/);
  assert.doesNotMatch(tbProjectList, /authHeaders/, "普通 TB 用户拉取可选项目不应依赖管理员头函数");
  const cancelHandler = settings.slice(
    settings.indexOf("async function handleCancel()"),
    settings.indexOf("async function saveManualCookie()"),
  );
  assert.ok(
    cancelHandler.indexOf('status: "cancelled"') < cancelHandler.indexOf("await fetch"),
    "取消提示应先乐观落地，不能被浏览器关闭耗时阻塞",
  );
  assert.equal(
    (cancelHandler.match(/status: "cancelled"/g) || []).length,
    2,
    "取消响应后应再次固定终态，避免中途轮询把友好提示覆盖为 waiting",
  );
  const manualCookieHandler = settings.slice(
    settings.indexOf("async function saveManualCookie()"),
    settings.indexOf("const health = status"),
  );
  assert.match(manualCookieHandler, /authenticatedFetch\(getApiUrl\("\/api\/tb-tasks\/cookie-verify-save"\)/);
  assert.doesNotMatch(settings, /onManualSave/, "手工 Cookie 不得先走通用配置保存再验证");
  assert.match(feishu, /startTbTasksLogin\(\)/);
  assert.match(taskPanel, /startTbTasksLogin\(\)/);
  assert.match(taskPanel, /fetch\(getApiUrl\("\/api\/tb-tasks\/login\/cancel"\)/);
  assert.match(taskPanel, /loginChallenge/);
});
