import { test } from "node:test";
import assert from "node:assert/strict";
import {
  codeupApiBaseError,
  codeupChangeRequestWebUrl,
  codeupRepositoryPathFromRemote,
  createCodeupChangeRequest,
  listCodeupOrganizations,
  missingCodeupPrConfig,
  probeCodeupConnection,
} from "../services/codeup.js";

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(data); },
  };
}

function baseConfig(overrides = {}) {
  return {
    apiBaseUrl: "https://openapi-rdc.aliyuncs.com",
    edition: "central",
    organizationId: "org-123",
    accessToken: "pt-secret",
    repositoryId: "",
    repositoryPath: "",
    reviewerUserIds: [],
    reviewerName: "阳荣峰",
    changesUrl: "https://codeup.aliyun.com/xunihezi/AppMarket/changes",
    ...overrides,
  };
}

test("Codeup remote 地址解析为仓库全路径", () => {
  assert.equal(codeupRepositoryPathFromRemote("git@codeup.aliyun.com:xunihezi/AppMarket.git"), "xunihezi/AppMarket");
  assert.equal(codeupRepositoryPathFromRemote("https://codeup.aliyun.com/xunihezi/AppMarket.git"), "xunihezi/AppMarket");
  assert.equal(codeupRepositoryPathFromRemote("https://codeup.aliyun.com/xunihezi/AppMarket/changes"), "xunihezi/AppMarket");
  assert.equal(codeupRepositoryPathFromRemote("git@example.com:xunihezi/AppMarket.git"), "");
  assert.equal(
    codeupRepositoryPathFromRemote("git@codeup.region.example:xunihezi/AppMarket.git", { allowAnyHost: true }),
    "xunihezi/AppMarket",
  );
});

test("Codeup MR 详情地址只返回标准 change 审核页", () => {
  assert.equal(
    codeupChangeRequestWebUrl({ data: { result: { detailUrl: "https://codeup.aliyun.com/xunihezi/AppMarket/change/8" } } }),
    "https://codeup.aliyun.com/xunihezi/AppMarket/change/8",
  );
  assert.equal(
    codeupChangeRequestWebUrl({ result: {
      localId: 9,
      webUrl: "https://codeup.aliyun.com/xunihezi/AppMarket/merge_request/9",
    } }, {
      changesUrl: "https://codeup.aliyun.com/xunihezi/AppMarket/changes",
    }),
    "https://codeup.aliyun.com/xunihezi/AppMarket/change/9",
  );
  assert.equal(codeupChangeRequestWebUrl({ webUrl: "https://codeup.aliyun.com/xunihezi/AppMarket" }), "");
  assert.equal(codeupChangeRequestWebUrl({ localId: 10, webUrl: "javascript:alert(1)" }), "");
});

test("Codeup PR 必填配置仅保留个人令牌和中心版组织 ID", () => {
  assert.deepEqual(missingCodeupPrConfig(baseConfig()), []);
  assert.deepEqual(missingCodeupPrConfig(baseConfig({ organizationId: "", accessToken: "" })), ["accessToken", "organizationId"]);
  assert.deepEqual(missingCodeupPrConfig(baseConfig({ edition: "region", organizationId: "" })), []);
});

test("个人令牌可只读发现当前用户加入的组织且不会进入 URL", async () => {
  const calls = [];
  const fetchMock = async (url, options) => {
    calls.push({ url: String(url), options });
    return jsonResponse([
      { id: "org-1", name: "组织一" },
      { _id: "org-2", name: "组织二" },
    ]);
  };
  const result = await listCodeupOrganizations(baseConfig({ apiBaseUrl: "https://malicious.example", organizationId: "" }), fetchMock);

  assert.equal(result.ok, true);
  assert.deepEqual(result.organizations, [
    { id: "org-1", name: "组织一", description: "" },
    { id: "org-2", name: "组织二", description: "" },
  ]);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/oapi\/v1\/platform\/organizations\?/);
  assert.doesNotMatch(calls[0].url, /pt-secret|accessToken/);
  assert.equal(calls[0].options.headers["x-yunxiao-token"], "pt-secret");
  assert.match(calls[0].url, /^https:\/\/openapi-rdc\.aliyuncs\.com\//);
});

test("Region 接入点必须使用无凭据、无查询参数的 HTTPS URL", async () => {
  assert.match(codeupApiBaseError({ edition: "region", apiBaseUrl: "http://codeup.region.example" }), /HTTPS/);
  assert.match(codeupApiBaseError({ edition: "region", apiBaseUrl: "https://user:pass@codeup.region.example" }), /用户名或密码/);
  assert.match(codeupApiBaseError({ edition: "region", apiBaseUrl: "https://codeup.region.example?token=bad" }), /查询参数/);
  assert.equal(codeupApiBaseError({ edition: "region", apiBaseUrl: "https://codeup.region.example" }), "");

  let called = false;
  const result = await probeCodeupConnection(baseConfig({
    apiBaseUrl: "http://codeup.region.example",
    edition: "region",
    organizationId: "",
  }), async () => { called = true; });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid_api_base");
  assert.equal(called, false);
});

test("连接检测只读查询一条仓库且不创建 MR", async () => {
  const calls = [];
  const fetchMock = async (url, options) => {
    calls.push({ url: String(url), options });
    return jsonResponse([{ id: 2813489, name: "AppMarket", pathWithNamespace: "xunihezi/AppMarket" }]);
  };
  const result = await probeCodeupConnection(baseConfig(), fetchMock);

  assert.equal(result.ok, true);
  assert.equal(result.repositoryVisible, true);
  assert.deepEqual(result.repository, { id: 2813489, name: "AppMarket", path: "xunihezi/AppMarket" });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/organizations\/org-123\/repositories\?/);
  assert.equal(calls[0].options.method, "GET");
  assert.doesNotMatch(calls[0].url, /changeRequests|merge_requests|pt-secret/);
});

test("新版 OAPI 自动发现仓库和评审人后创建合并请求", async () => {
  const calls = [];
  const fetchMock = async (url, options) => {
    calls.push({ url: String(url), options });
    if (calls.length === 1) {
      return jsonResponse({
        id: 2813489,
        name: "AppMarket",
        path: "AppMarket",
        pathWithNamespace: "xunihezi/AppMarket",
        webUrl: "https://codeup.aliyun.com/xunihezi/AppMarket",
      });
    }
    if (calls.length === 2) {
      return jsonResponse([{ name: "阳荣峰", username: "yangrf", userId: "user-reviewer-1" }]);
    }
    return jsonResponse({
      localId: 1,
      webUrl: "https://codeup.aliyun.com/xunihezi/AppMarket/merge_request/1",
    }, 201);
  };

  const result = await createCodeupChangeRequest(baseConfig(), {
    repositoryPath: "xunihezi/AppMarket",
    sourceBranch: "fix/CARB-1",
    targetBranch: "main",
    title: "#CARB-1# 修复",
    description: "description",
    workItemId: "tb-1",
  }, fetchMock);

  assert.equal(result.ok, true);
  assert.equal(result.webUrl, "https://codeup.aliyun.com/xunihezi/AppMarket/change/1");
  assert.equal(result.repository.id, 2813489);
  assert.deepEqual(result.reviewerUserIds, ["user-reviewer-1"]);
  assert.equal(calls.length, 3);
  assert.match(calls[0].url, /\/oapi\/v1\/codeup\/organizations\/org-123\/repositories\/xunihezi%2FAppMarket$/);
  assert.match(calls[1].url, /\/repositories\/2813489\/members$/);
  assert.match(calls[2].url, /\/repositories\/2813489\/changeRequests$/);
  for (const call of calls) {
    assert.equal(call.options.headers["x-yunxiao-token"], "pt-secret");
    assert.doesNotMatch(call.url, /accessToken|pt-secret/);
  }
  const body = JSON.parse(calls[2].options.body);
  assert.equal(body.sourceProjectId, 2813489);
  assert.equal(body.targetProjectId, 2813489);
  assert.deepEqual(body.reviewerUserIds, ["user-reviewer-1"]);
  assert.equal(body.workItemIds, "tb-1");
  assert.equal("reviewerIds" in body, false);
  assert.equal("createFrom" in body, false);
});

test("评审人查询失败不会阻断 MR 创建", async () => {
  const calls = [];
  const fetchMock = async (url, options) => {
    calls.push({ url: String(url), options });
    if (calls.length === 1) return jsonResponse({ message: "member scope denied" }, 403);
    return jsonResponse({ webUrl: "https://codeup.aliyun.com/mr/2" }, 201);
  };
  const result = await createCodeupChangeRequest(baseConfig({ repositoryId: "2813489" }), {
    sourceBranch: "fix/CARB-2",
    targetBranch: "main",
    title: "#CARB-2# 修复",
    description: "description",
  }, fetchMock);

  assert.equal(result.ok, true);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /不指定评审人创建 MR/);
  const body = JSON.parse(calls[1].options.body);
  assert.equal("reviewerUserIds" in body, false);
});

test("显式仓库和新版评审人 ID 可直接创建且无需发现请求", async () => {
  const calls = [];
  const fetchMock = async (url, options) => {
    calls.push({ url: String(url), options });
    return jsonResponse({ webUrl: "https://codeup.aliyun.com/mr/3" }, 201);
  };
  const result = await createCodeupChangeRequest(baseConfig({
    repositoryId: "2813489",
    reviewerUserIds: ["user-1", "user-2"],
  }), {
    sourceBranch: "fix/CARB-3",
    targetBranch: "main",
    title: "#CARB-3# 修复",
  }, fetchMock);

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(body.reviewerUserIds, ["user-1", "user-2"]);
});

test("创建 MR 仅返回 localId 时补出可自动打开的对应详情页", async () => {
  const result = await createCodeupChangeRequest(baseConfig({
    repositoryId: "2813489",
    reviewerUserIds: ["user-1"],
  }), {
    sourceBranch: "fix/CARB-9-geely-e22",
    targetBranch: "release/geely-e22",
    title: "#CARB-9# 修复",
  }, async () => jsonResponse({ data: { localId: 42 } }, 201));

  assert.equal(result.ok, true);
  assert.equal(result.localId, 42);
  assert.equal(result.webUrl, "https://codeup.aliyun.com/xunihezi/AppMarket/change/42");
});

test("Region 版使用实例接入点且不拼接 organizationId", async () => {
  const calls = [];
  const fetchMock = async (url, options) => {
    calls.push({ url: String(url), options });
    return jsonResponse({ webUrl: "https://codeup.region.example/mr/4" }, 201);
  };
  const result = await createCodeupChangeRequest(baseConfig({
    apiBaseUrl: "https://codeup.region.example",
    edition: "region",
    organizationId: "",
    repositoryId: "2813489",
    reviewerName: "",
  }), {
    sourceBranch: "fix/CARB-REGION",
    targetBranch: "main",
    title: "#CARB-REGION# 修复",
  }, fetchMock);

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://codeup.region.example/oapi/v1/codeup/repositories/2813489/changeRequests");
  assert.doesNotMatch(calls[0].url, /organizations/);
});

test("仓库发现失败时返回可用于页面兜底的明确错误", async () => {
  const fetchMock = async () => jsonResponse({ message: "repository not found" }, 404);
  const result = await createCodeupChangeRequest(baseConfig(), {
    repositoryPath: "xunihezi/MissingRepo",
    sourceBranch: "fix/CARB-4",
    targetBranch: "main",
    title: "#CARB-4# 修复",
  }, fetchMock);

  assert.equal(result.ok, false);
  assert.equal(result.reason, "repository_resolution_failed");
  assert.match(result.error, /查询 Codeup 仓库“xunihezi\/MissingRepo”失败/);
});
