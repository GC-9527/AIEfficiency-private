import assert from "node:assert/strict";
import { test } from "node:test";

import {
  needsDedicatedLocalGateway,
  requestRepoAccessFromLocalGateway,
} from "./repoAccessClient.mjs";

test("loopback 页面直接使用当前 Gateway，不重复探测 3001", async () => {
  let probes = 0;
  const result = await requestRepoAccessFromLocalGateway({
    browserOrigin: "http://localhost:3000",
    probeLocalGateway: async () => { probes += 1; return true; },
    requestRepoAccess: async (base) => ({ ok: true, data: { hasAccess: true, base } }),
  });

  assert.equal(probes, 0);
  assert.equal(result.data.hasAccess, true);
  assert.equal(result.data.base, undefined);
});

test("显式配置的 loopback Gateway 停止后返回不可判定，不退化为网络错误", async () => {
  const probes = [];
  let repoCalls = 0;
  const result = await requestRepoAccessFromLocalGateway({
    gatewayUrl: "http://127.0.0.1:3001",
    browserOrigin: "http://192.168.1.50:8080",
    probeLocalGateway: async (base) => {
      probes.push(base);
      return false;
    },
    requestRepoAccess: async () => {
      repoCalls += 1;
      return { ok: false, code: "NETWORK_ERROR", error: "Failed to fetch" };
    },
  });

  assert.deepEqual(probes, ["http://127.0.0.1:3001"]);
  assert.equal(repoCalls, 0);
  assert.equal(result.ok, true);
  assert.equal(result.data.hasAccess, null);
  assert.equal(result.data.needsLocalGateway, true);
});

test("显式 loopback 健康检查成功但仓库请求瞬断时仍返回不可判定", async () => {
  const result = await requestRepoAccessFromLocalGateway({
    gatewayUrl: "http://localhost:3001",
    browserOrigin: "http://192.168.1.50:8080",
    probeLocalGateway: async () => true,
    requestRepoAccess: async () => ({
      ok: false,
      code: "NETWORK_ERROR",
      error: "网络请求失败",
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.hasAccess, null);
  assert.equal(result.data.localGatewayUrl, "http://localhost:3001");
});

test("局域网服务端页面改由浏览器所在机器的本机 Gateway 检查", async () => {
  const calls = [];
  const result = await requestRepoAccessFromLocalGateway({
    gatewayUrl: "http://192.168.1.50:3001",
    browserOrigin: "http://192.168.1.50:3001",
    probeLocalGateway: async (base) => {
      calls.push(["health", base]);
      return true;
    },
    requestRepoAccess: async (base) => {
      calls.push(["repo", base]);
      return { ok: true, data: { hasAccess: true, transport: "https" } };
    },
  });

  assert.deepEqual(calls, [
    ["health", "http://127.0.0.1:3001"],
    ["repo", "http://127.0.0.1:3001"],
  ]);
  assert.equal(result.data.hasAccess, true);
  assert.equal(result.data.checkedBy, "local-gateway");
});

test("局域网页无法连接本机 Gateway 时返回不可判定，不误报无仓库权限", async () => {
  let repoCalls = 0;
  const result = await requestRepoAccessFromLocalGateway({
    browserOrigin: "http://10.20.30.40:3001",
    probeLocalGateway: async () => false,
    requestRepoAccess: async () => {
      repoCalls += 1;
      return { ok: true, data: { hasAccess: false } };
    },
  });

  assert.equal(repoCalls, 0, "不得拿局域网服务端的 SSH 结果冒充客户端权限");
  assert.equal(result.ok, true);
  assert.equal(result.data.hasAccess, null);
  assert.equal(result.data.needsLocalGateway, true);
});

test("本机 Gateway 明确检查失败时保留真实无权限结果", async () => {
  const result = await requestRepoAccessFromLocalGateway({
    browserOrigin: "http://10.20.30.40:3001",
    probeLocalGateway: async () => true,
    requestRepoAccess: async () => ({
      ok: true,
      data: { hasAccess: false, attempts: [{ transport: "https", ok: false }] },
    }),
  });

  assert.equal(result.data.hasAccess, false);
  assert.equal(result.data.checkedBy, "local-gateway");
});
