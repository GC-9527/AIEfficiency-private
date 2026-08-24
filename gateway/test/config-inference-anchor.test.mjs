import test from "node:test";
import assert from "node:assert/strict";

import { inferConfigFromTicket } from "../services/devbench/config-inference.js";

const applicationDefs = [
  { id: "market", name: "应用市场", ssh: "git@example.com:apps/market.git" },
  { id: "settings", name: "系统设置", ssh: "git@example.com:apps/settings.git" },
];

const vehicleKeywordMappings = {
  tag: {
    "车型X": { category: "vehicle", value: "vehicle-x" },
  },
};

function applicationTarget(repoId, targetRole = "primary", order = 1) {
  return {
    repoId,
    branch: `release/${repoId}`,
    flavor: "vehicleX",
    targetRole,
    order,
  };
}

test("同一车型命中两个应用主工程时返回信息不足且不暴露非法目标图", () => {
  const result = inferConfigFromTicket({
    ticket: { title: "车型X 通用问题", tags: ["车型X"] },
    projectDefs: applicationDefs,
    vehicleMap: {
      "vehicle-x": {
        apps: [
          { appName: "应用市场", repos: [applicationTarget("market")] },
          { appName: "系统设置", repos: [applicationTarget("settings")] },
        ],
      },
    },
    keywordMappings: vehicleKeywordMappings,
  });

  assert.equal(result.status, "NEED_MORE_INFO");
  assert.deepEqual(result.targets, []);
  assert.deepEqual(result.dimensions.repositoryId, []);
  assert.equal(result.confidenceScore, 0);
  assert.ok(result.missingInformation.some((item) => item.includes("执行锚点")));
});

test("应用主工程与独立工具工程同时命中时返回信息不足且不暴露非法目标图", () => {
  const result = inferConfigFromTicket({
    ticket: { title: "车型X 脚本工具协同问题", tags: ["车型X"] },
    projectDefs: [
      applicationDefs[0],
      {
        id: "ai-tool",
        name: "AI 脚本工具",
        ssh: "git@example.com:tools/ai-tool.git",
        projectType: "tooling",
        inferenceEnabled: true,
        inferenceRole: "standalone",
        inferenceKeywords: ["脚本工具"],
        defaultBranch: "main",
      },
    ],
    vehicleMap: {
      "vehicle-x": {
        apps: [{ appName: "应用市场", repos: [applicationTarget("market")] }],
      },
    },
    keywordMappings: vehicleKeywordMappings,
  });

  assert.equal(result.status, "NEED_MORE_INFO");
  assert.deepEqual(result.targets, []);
  assert.ok(result.missingInformation.some((item) => item.includes("执行锚点")));
});

test("单个应用主工程及其依赖工程仍返回合法目标图", () => {
  const result = inferConfigFromTicket({
    ticket: { title: "车型X 应用问题", tags: ["车型X"] },
    projectDefs: applicationDefs,
    vehicleMap: {
      "vehicle-x": {
        apps: [{
          appName: "应用市场",
          repos: [
            applicationTarget("market", "primary", 1),
            applicationTarget("settings", "dependency", 2),
          ],
        }],
      },
    },
    keywordMappings: vehicleKeywordMappings,
  });

  assert.equal(result.status, "NEED_HUMAN_CONFIRMATION");
  assert.deepEqual(
    result.targets.map((target) => [target.repositoryId, target.targetRole]),
    [["market", "primary"], ["settings", "dependency"]],
  );
});

test("单个独立工具工程仍可作为唯一执行锚点", () => {
  const result = inferConfigFromTicket({
    ticket: { title: "AI 脚本工具运行失败" },
    projectDefs: [{
      id: "ai-tool",
      name: "AI 脚本工具",
      ssh: "git@example.com:tools/ai-tool.git",
      projectType: "tooling",
      inferenceEnabled: true,
      inferenceRole: "standalone",
      inferenceKeywords: ["脚本工具"],
      defaultBranch: "main",
    }],
  });

  assert.equal(result.status, "NEED_HUMAN_CONFIRMATION");
  assert.deepEqual(
    result.targets.map((target) => [target.repositoryId, target.targetRole]),
    [["ai-tool", "standalone"]],
  );
});
