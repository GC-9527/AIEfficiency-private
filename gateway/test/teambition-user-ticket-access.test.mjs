import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-ticket-access-"));
process.env.GATEWAY_CONFIG_PATH = path.join(root, "gateway.json");
fs.writeFileSync(process.env.GATEWAY_CONFIG_PATH, "{}", "utf8");

let config;
let teambition;

before(async () => {
  config = await import("../services/config.js");
  teambition = await import("../services/teambition.js");
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

test("普通用户按 TB 链接读取时只使用当前 Cookie 并返回可见工单", async () => {
  const originalFetch = globalThis.fetch;
  const taskId = "6a47ab5f34526c55d0b7224f";
  config.updateConfig({ teambition: { operatorId: "tb-user", userCookie: "TB_SESSION=user-visible" } });
  let request = null;
  globalThis.fetch = async (url, options) => {
    request = { url: String(url), options };
    return response({
      _id: taskId,
      uniqueId: 13542,
      content: "当前用户可见工单",
      _projectId: "project-visible",
    });
  };
  try {
    const task = await teambition.getCurrentUserAccessibleTask(`https://www.teambition.com/task/${taskId}`);
    assert.equal(task.taskId, taskId);
    assert.equal(task.uniqueId, 13542);
    assert.equal(task.title, "当前用户可见工单");
    assert.equal(request.url, `https://www.teambition.com/api/tasks/${taskId}`);
    assert.equal(request.options.headers.Cookie, "TB_SESSION=user-visible");
    assert.doesNotMatch(request.url, /open\.teambition\.com/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("普通用户按 CARB 单号读取时只接受 Cookie 搜索中精确可见的单号", async () => {
  const originalFetch = globalThis.fetch;
  config.updateConfig({ teambition: { operatorId: "tb-user", userCookie: "TB_SESSION=user-search" } });
  globalThis.fetch = async () => response({ tasks: [
    { _id: "111111111111111111111111", uniqueId: 13541, content: "其它单" },
    { _id: "222222222222222222222222", uniqueId: 13542, content: "目标单" },
  ] });
  try {
    const task = await teambition.getCurrentUserAccessibleTask("CARB-13542");
    assert.equal(task.taskId, "222222222222222222222222");
    assert.equal(task.title, "目标单");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("当前 Cookie 无权读取目标 TB 单时失败关闭，不回退应用服务账号", async () => {
  const originalFetch = globalThis.fetch;
  config.updateConfig({ teambition: {
    operatorId: "tb-user",
    userCookie: "TB_SESSION=no-access",
    appId: "service-app",
    appSecret: "service-secret",
  } });
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return response({}, 403);
  };
  try {
    assert.equal(await teambition.getCurrentUserAccessibleTask("CARB-13542"), null);
    assert.equal(urls.length, 1);
    assert.doesNotMatch(urls[0], /open\.teambition\.com/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("缺少或过期 Cookie 时返回可引导重新登录的认证错误", async () => {
  config.updateConfig({ teambition: { operatorId: "tb-user", userCookie: "" } });
  await assert.rejects(
    () => teambition.getCurrentUserAccessibleTask("CARB-13542"),
    (error) => error.code === "TB_LOGIN_REQUIRED" && error.needLogin === true,
  );

  const originalFetch = globalThis.fetch;
  config.updateConfig({ teambition: { operatorId: "tb-user", userCookie: "expired" } });
  globalThis.fetch = async () => response({}, 401);
  try {
    await assert.rejects(
      () => teambition.getCurrentUserAccessibleTask("CARB-13542"),
      (error) => error.code === "TB_LOGIN_EXPIRED" && error.needLogin === true,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
