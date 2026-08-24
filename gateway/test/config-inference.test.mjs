import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import {
  CONFIG_INFERENCE_DIMENSIONS,
  CONFIG_INFERENCE_GROUPS,
  CONFIG_INFERENCE_RAG_VERSION,
  CONFIG_INFERENCE_SOURCE_GROUPS,
  CONFIG_INFERENCE_VERSION,
  bindConfigInferenceTargets,
  buildConfigInferenceRegistry,
  extractConfigInferenceSignals,
  inferConfigFromTicket,
  normalizeConfigInferenceTargets,
  normalizeConfigInferenceTicket,
  retrieveConfigInferenceMemories,
  validateConfigInferenceTargets,
} from "../services/devbench/config-inference.js";
import { totp } from "../services/totp.js";
import { bootGateway, waitHealth } from "./_helpers.mjs";

// 这个文件允许用 --test-name-pattern 单独运行任意用例。存储模块会在首次 import 时
// 固定配置路径，因此隔离环境必须在注册测试之前建立，不能依赖某个前置 test 回调。
const MODULE_TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "config-inference-module-"));
const MODULE_TEST_ENV = {
  DEVBENCH_CONFIG_PATH: path.join(MODULE_TEST_ROOT, "market.json"),
  DEVBENCH_LOCAL_PROJECTS_PATH: path.join(MODULE_TEST_ROOT, "local", "devbench-projects.json"),
  DEVBENCH_STORE_DIR: path.join(MODULE_TEST_ROOT, "store"),
  GATEWAY_CONFIG_PATH: path.join(MODULE_TEST_ROOT, "gateway.json"),
  GATEWAY_DB_PATH: path.join(MODULE_TEST_ROOT, "data.db"),
  AIEFFICIENCY_CLONE_PARENT: path.join(MODULE_TEST_ROOT, "clone-parent"),
  DEVBENCH_SYNC_SCOPE: "test:config-inference",
};
const ORIGINAL_MODULE_TEST_ENV = Object.fromEntries(
  Object.keys(MODULE_TEST_ENV).map((key) => [key, process.env[key]]),
);

for (const [key, value] of Object.entries(MODULE_TEST_ENV)) {
  process.env[key] = value;
}
fs.writeFileSync(MODULE_TEST_ENV.GATEWAY_CONFIG_PATH, JSON.stringify({
  servers: { nodeId: "config-inference-module-test" },
  teambition: { projects: [] },
}), "utf8");

after(async () => {
  try {
    const { default: db } = await import("../db/sqlite.js");
    if (db?.open) db.close();
  } catch {
    // 没有用到存储模块的纯推理子集不会打开数据库。
  }
  for (const [key, value] of Object.entries(ORIGINAL_MODULE_TEST_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(MODULE_TEST_ROOT, { recursive: true, force: true });
});

const PROJECT_DEFS = [
  { id: "market", name: "应用市场", ssh: "git@example.com:apps/market.git" },
  { id: "web", name: "WebApp", https: "https://example.com/apps/web.git" },
];

const VEHICLE_MAP = {
  "阿维塔 8678": {
    apps: [
      {
        appName: "应用市场",
        repos: [
          { repoId: "market", branch: "release/avatr", flavor: "avatr8678Prod" },
          { repoId: "web", branch: "release/web-avatr", flavor: "web8678" },
        ],
      },
    ],
  },
};

// 后续存储用例必须能够脱离前置用例独立运行；否则 --test-name-pattern 会因为
// 注册表为空而改变预测结果，并掩盖测试污染真实配置的问题。
fs.writeFileSync(MODULE_TEST_ENV.DEVBENCH_CONFIG_PATH, JSON.stringify({
  projectDefs: PROJECT_DEFS,
  byProject: {
    "project-a": {
      vehicleMap: VEHICLE_MAP,
      keywordMappings: {
        title: { "启动失败": { category: "app", value: "应用市场" } },
      },
    },
  },
}), "utf8");

const MULTI_VEHICLE_PROJECT_DEFS = [
  { id: "appMarket", name: "应用市场", ssh: "git@example.com:apps/app-market.git" },
  { id: "webApp", name: "WebApp", https: "https://example.com/apps/web-app.git" },
];

const MULTI_VEHICLE_MAP = {
  geelyp155: {
    aliases: ["Geely P155", "GeelyP155", "P155", "吉利P155"],
    apps: [{
      appName: "应用市场",
      repos: [
        { repoId: "appMarket", branch: "release/geely-p155", flavor: "geelyp155" },
        { repoId: "webApp", branch: "release/geely-p155", flavor: "geelyp155" },
      ],
    }],
  },
  avatr8678: {
    aliases: ["Avatr 8678", "Avatr8678", "阿维塔8678", "8678"],
    apps: [{
      appName: "应用市场",
      repos: [
        { repoId: "appMarket", branch: "release/avatr-8678", flavor: "avatr8678" },
        { repoId: "webApp", branch: "release/avatr-8678", flavor: "avatr8678" },
      ],
    }],
  },
  avatr8155: {
    aliases: ["Avatr 8155", "Avatr8155", "阿维塔8155", "8155"],
    apps: [{
      appName: "应用市场",
      repos: [
        { repoId: "appMarket", branch: "release/avatr-8155", flavor: "avatr8155" },
        { repoId: "webApp", branch: "release/avatr-8155", flavor: "avatr8155" },
      ],
    }],
  },
};

const P155_SIX_SOURCE_TICKET = {
  tbTaskId: "6a50862f697f030a35a28839",
  title: "【通用】【Geely】【P155】【AppMarket】测试环境：用户协议已配置新地址baidu，清除数据缓存后进入应用市场，首次弹窗中点击用户协议显示的是默认文本，进入应用后，我的页面点击用户协议显示网络连接错误",
  projectName: "平台组件",
  tasklistName: "应用市场测试",
  sprintName: "测试环境",
  tags: ["Geely", "P155", "AppMarket", "用户协议"],
  attachments: [{ name: "用户协议复现.png", text: "baidu 新地址" }],
  comments: ["清除数据缓存后，首次弹窗和我的页面均复现用户协议异常"],
  description: "测试环境已为用户协议配置 baidu 新地址",
};

function registeredVehicleTargets(vehicleMap, vehicle) {
  return buildConfigInferenceRegistry(MULTI_VEHICLE_PROJECT_DEFS, vehicleMap).targets
    .filter((target) => target.vehicle === vehicle);
}

function reviewedVehicleSamples(vehicleMap, vehicle, modelLabel, startAt = 10) {
  const historyTicket = {
    ...P155_SIX_SOURCE_TICKET,
    tbTaskId: `history-${vehicle}`,
    title: P155_SIX_SOURCE_TICKET.title
      .replace("【Geely】【P155】", `【Avatr】【${modelLabel}】`),
    tags: ["Avatr", modelLabel, "AppMarket", "用户协议"],
  };
  const signals = extractConfigInferenceSignals(historyTicket, {});
  const targets = registeredVehicleTargets(vehicleMap, vehicle);
  return [0, 1].map((offset) => ({
    id: `old-${vehicle}-${offset + 1}`,
    source: "user_feedback",
    signals,
    groundTruth: { targets },
    feedback: { decision: "correct", rating: 5 },
    updatedAt: startAt + offset,
  }));
}

function directoryContainsText(root, text) {
  const needle = Buffer.from(String(text || ""), "utf8");
  if (!needle.length || !fs.existsSync(root)) return false;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (directoryContainsText(entryPath, text)) return true;
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      if (fs.readFileSync(entryPath).includes(needle)) return true;
    } catch {}
  }
  return false;
}

const COMPLETE_TB_SNAPSHOT_AT = "2026-07-29T08:00:00.000Z";

function completeTbTicket(ticket, snapshotAt = COMPLETE_TB_SNAPSHOT_AT) {
  return {
    ...ticket,
    snapshotAt,
    sourceCoverage: {
      detail: { available: true, complete: true, capturedAt: snapshotAt },
      comments: { available: true, complete: true, capturedAt: snapshotAt },
      attachments: { available: true, complete: true, capturedAt: snapshotAt },
      tags: { available: true, complete: true, capturedAt: snapshotAt },
      ...(ticket?.sourceCoverage || {}),
    },
  };
}

function approveReviewedAnnotation(store, projectId, reviewed, reviewerPrefix = "config-inference-test") {
  assert.equal(reviewed.ok, true, reviewed.error);
  assert.equal(reviewed.learned, false, "人工复核只创建 pending annotation，不能直接进入 serving");
  assert.equal(reviewed.annotationPending, true);
  const annotationId = reviewed.sample?.id;
  assert.ok(annotationId, "人工复核必须返回 pending annotation");
  const vote = {
    decision: reviewed.sample?.feedback?.decision,
    noTargets: reviewed.sample?.groundTruth?.noTargets === true,
    targets: reviewed.sample?.groundTruth?.targets || [],
  };
  const first = store.approveConfigInferenceAnnotation(projectId, annotationId, {
    reviewer: `${reviewerPrefix}-reviewer-a`,
    reason: "测试第一位稳定评审",
    vote,
  });
  assert.equal(first.ok, true, first.error);
  assert.equal(first.requiresMoreReviewers, true);
  assert.equal(first.learned, false);
  const second = store.approveConfigInferenceAnnotation(projectId, annotationId, {
    reviewer: `${reviewerPrefix}-reviewer-b`,
    reason: "测试第二位稳定评审",
    vote,
  });
  assert.equal(second.ok, true, second.error);
  assert.equal(second.learned, true);
  assert.equal(second.data.servingStatus, "approved");
  return second;
}

test("配置推理常量固定六类来源和五个独立业务维度", () => {
  assert.deepEqual(CONFIG_INFERENCE_GROUPS, ["title", "project", "iteration", "tag", "attachment", "comment"]);
  assert.deepEqual(CONFIG_INFERENCE_SOURCE_GROUPS, ["title", "project", "iteration", "tag", "attachment", "comment", "note"]);
  assert.deepEqual(CONFIG_INFERENCE_DIMENSIONS, ["appName", "vehicle", "repositoryId", "branch", "flavor"]);
});

test("TB 单备注作为独立上下文信号保留并参与历史样本学习", () => {
  const firstTicket = { title: "无规则命中的标题", description: "8678 车机冷启动后应用市场持续白屏" };
  const normalized = normalizeConfigInferenceTicket(firstTicket);
  const signals = extractConfigInferenceSignals(normalized, {});
  const target = buildConfigInferenceRegistry(PROJECT_DEFS, VEHICLE_MAP).targets
    .find((item) => item.repositoryId === "market");

  assert.equal(normalized.description, firstTicket.description);
  assert.deepEqual(signals.sources.note, [firstTicket.description]);

  const learned = inferConfigFromTicket({
    ticket: { title: "另一张没有规则的工单", note: "8678 车机冷启动后应用市场持续白屏" },
    projectDefs: PROJECT_DEFS,
    vehicleMap: VEHICLE_MAP,
    samples: [{
      id: "note-feedback",
      signals,
      groundTruth: { targets: [target] },
      feedback: { decision: "corrected", rating: 5 },
    }],
  });

  assert.equal(learned.targets[0].repositoryId, "market");
  assert.ok(learned.evidence.some((item) => item.kind === "historical_feedback"));
});

test("六组关键词规则只匹配各自来源，并保留项目>任务列表复合信号", () => {
  const ticket = normalizeConfigInferenceTicket({
    title: "TITLE_ONLY",
    projectName: "平台组件",
    tasklistName: "阿维塔应用市场",
    sprintName: "ITERATION_ONLY",
    tags: ["TAG_ONLY"],
    attachments: [{ name: "ATTACHMENT_ONLY.log" }],
    comments: "COMMENT_ONLY",
  });
  const mappings = {
    title: {
      TITLE_ONLY: { category: "app", value: "应用市场" },
      COMMENT_ONLY: { category: "repo", value: "web" },
    },
    project: {
      "平台组件>阿维塔应用市场": { category: "repository", value: "market" },
      TITLE_ONLY: { category: "repo", value: "web" },
    },
    iteration: {
      ITERATION_ONLY: { category: "branch", value: "release/avatr" },
      TITLE_ONLY: { category: "repo", value: "web" },
    },
    tag: {
      TAG_ONLY: { category: "vehicle", value: "阿维塔 8678" },
      TITLE_ONLY: { category: "repo", value: "web" },
    },
    attachment: {
      ATTACHMENT_ONLY: { category: "flavor", value: "avatr8678Prod" },
      COMMENT_ONLY: { category: "repo", value: "web" },
    },
    comment: {
      COMMENT_ONLY: { category: "repo", value: "market" },
      ATTACHMENT_ONLY: { category: "repo", value: "web" },
    },
  };

  const signals = extractConfigInferenceSignals(ticket, mappings);
  assert.equal(ticket.projectKey, "平台组件>阿维塔应用市场");
  assert.deepEqual(
    Object.fromEntries(CONFIG_INFERENCE_GROUPS.map((group) => [group, signals.byGroup[group].map((row) => row.keyword)])),
    {
      title: ["TITLE_ONLY"],
      project: ["平台组件>阿维塔应用市场"],
      iteration: ["ITERATION_ONLY"],
      tag: ["TAG_ONLY"],
      attachment: ["ATTACHMENT_ONLY"],
      comment: ["COMMENT_ONLY"],
    },
  );
});

test("空白关键词映射可结合车型源码注册表唯一反推完整五维目标", () => {
  const vehicleMap = {
    zeekr9x: {
      prodReleaseDir: "\\\\server\\CarBox\\Geely\\极氪9X",
      apps: [{
        appName: "应用市场",
        repos: [{ repoId: "market", branch: "release/zeekr9x", flavor: "zeekr9x" }],
      }],
    },
  };
  const result = inferConfigFromTicket({
    ticket: {
      tbTaskId: "6a55a79678144bda88d42d61",
      title: "【9x】协助解决 radiofm 获取国家码",
      projectName: "平台组件",
      tasklistName: "极氪_9X",
      tags: ["极氪9X"],
    },
    projectDefs: PROJECT_DEFS,
    vehicleMap,
    keywordMappings: { tag: { "极氪9X": { category: "", value: "" } } },
  });

  assert.equal(result.status, "NEED_HUMAN_CONFIRMATION");
  assert.deepEqual(
    Object.fromEntries(CONFIG_INFERENCE_DIMENSIONS.map((dimension) => [dimension, result.targets[0][dimension]])),
    {
      appName: "应用市场",
      vehicle: "zeekr9x",
      repositoryId: "market",
      branch: "release/zeekr9x",
      flavor: "zeekr9x",
    },
  );
  assert.deepEqual(
    result.signals.byGroup.tag.map((match) => ({
      keyword: match.keyword,
      category: match.category,
      value: match.value,
      inferred: match.inferred,
      inferenceSource: match.inferenceSource,
    })),
    [{
      keyword: "极氪9X",
      category: "vehicle",
      value: "zeekr9x",
      inferred: true,
      inferenceSource: "registry_alias",
    }],
  );
  assert.ok(result.evidence.some((item) => item.kind === "registry_keyword_bridge"));
});

test("TB 6a59fe09 的旧双 primary 反馈按当前注册表恢复 AppMarket 主工程与 WebApp 依赖", () => {
  const projectDefs = [
    { id: "appMarket", name: "应用市场", ssh: "git@example.com:apps/app-market.git" },
    { id: "webApp", name: "WebApp", ssh: "git@example.com:apps/web-app.git" },
  ];
  const vehicleMap = {
    geelyss21: {
      aliases: ["Geely SS21", "GeelySS21", "SS21"],
      apps: [{
        appName: "App Market",
        repos: [
          { repoId: "appMarket", branch: "release/geely-e22", flavor: "geelyss21" },
          { repoId: "webApp", branch: "release/geely-e22", flavor: "geelyss21" },
        ],
      }],
    },
  };
  const ticket = {
    tbTaskId: "6a59fe09ccbdbee2c1a24363",
    title: "【Geely】【SS21】【Appmarket】车机设置页，语音关闭Youtube以外的3款网页应用会拉起应用市场",
    iterationName: "【应用市场】0723版本",
    tags: ["Geely"],
    attachments: [{ name: "SS2106.txt" }, { name: "SS21语音验证.mp4" }],
    comments: ["视频+日志"],
  };
  const registryTargets = buildConfigInferenceRegistry(projectDefs, vehicleMap).targets;
  const staleTargets = registryTargets.map((target) => ({
    ...target,
    targetRole: "primary",
    order: 0,
  }));
  const result = inferConfigFromTicket({
    ticket,
    projectDefs,
    vehicleMap,
    samples: [{
      id: "legacy-reviewed-ss21",
      source: "user_feedback",
      signals: extractConfigInferenceSignals(ticket, {}),
      groundTruth: { targets: staleTargets },
      feedback: { decision: "correct", rating: 5 },
    }],
  });

  assert.equal(result.status, "NEED_HUMAN_CONFIRMATION");
  assert.deepEqual(
    result.targets.map(({ repositoryId, vehicle, targetRole, order }) => ({ repositoryId, vehicle, targetRole, order })),
    [
      { repositoryId: "appMarket", vehicle: "geelyss21", targetRole: "primary", order: 1 },
      { repositoryId: "webApp", vehicle: "geelyss21", targetRole: "dependency", order: 2 },
    ],
  );
  assert.equal(result.missingInformation.length, 0);
  assert.equal(result.targets.filter((target) => target.targetRole === "primary").length, 1);
});

test("应用市场语音 TB 单原子追加无独立应用的 SDK 依赖，并支持人工删除后抑制", () => {
  const projectDefs = [
    { id: "appMarket", name: "应用市场", ssh: "git@example.com:apps/market.git" },
    {
      id: "appMarketSdk",
      name: "应用市场SDK",
      ssh: "git@example.com:apps/market.git",
      projectType: "sdk",
      inferenceKeywords: ["语音", "voice", "tts"],
      requiresRepositories: ["appMarket"],
      inheritVariant: ["vehicle"],
      defaultBranch: "feat/202605sdkaiV4",
    },
  ];
  const vehicleMap = {
    avatr8678: {
      aliases: ["阿维塔", "8678"],
      apps: [{ appName: "App Market", repos: [{ repoId: "appMarket", branch: "v202605-ui", flavor: "avatr8678" }] }],
    },
  };
  const ticket = {
    tbTaskId: "6a5616282d4c53fbbda38521",
    title: "【缺陷转载-8678】【阿维塔】【语音】【系统控制】语音打开未安装应用时 tts 播报错误",
    projectName: "App Market",
    tags: ["【阿维塔】"],
  };
  const keywordMappings = { tag: { "阿维塔": { category: "vehicle", value: "avatr8678" } } };
  const inferred = inferConfigFromTicket({ ticket, projectDefs, vehicleMap, keywordMappings });

  assert.deepEqual(inferred.targets.map((target) => target.repositoryId), ["appMarket", "appMarketSdk"]);
  assert.equal(inferred.targets[0].targetRole, "primary");
  assert.deepEqual(
    {
      appName: inferred.targets[1].appName,
      vehicle: inferred.targets[1].vehicle,
      branch: inferred.targets[1].branch,
      flavor: inferred.targets[1].flavor,
      projectType: inferred.targets[1].projectType,
      targetRole: inferred.targets[1].targetRole,
      repositoryOnly: inferred.targets[1].repositoryOnly,
    },
    {
      appName: "",
      vehicle: "avatr8678",
      branch: "feat/202605sdkaiV4",
      flavor: "",
      projectType: "sdk",
      targetRole: "dependency",
      repositoryOnly: true,
    },
  );
  assert.equal(inferred.missingInformation.length, 0);
  assert.ok(inferred.evidence.some((item) => item.kind === "repository_dependency"));

  const withoutVoice = inferConfigFromTicket({
    ticket: { ...ticket, title: "【缺陷转载-8678】【阿维塔】【系统控制】打开未安装应用错误" },
    projectDefs,
    vehicleMap,
    keywordMappings,
  });
  assert.deepEqual(withoutVoice.targets.map((target) => target.repositoryId), ["appMarket"]);

  const voiceOnly = inferConfigFromTicket({
    ticket: { title: "语音输入打开应用，tts 播报错误" },
    projectDefs,
    vehicleMap,
  });
  assert.equal(voiceOnly.status, "NEED_MORE_INFO");
  assert.deepEqual(voiceOnly.targets, []);

  const corrected = inferConfigFromTicket({
    ticket,
    projectDefs,
    vehicleMap,
    keywordMappings,
    samples: [{
      id: "remove-sdk-review",
      signals: inferred.signals,
      groundTruth: { targets: [inferred.targets[0]] },
      feedback: {
        decision: "corrected",
        rating: 5,
        rejectedPrediction: { targets: [inferred.targets[1]] },
      },
      negative: { policyVersion: 1, rejectedTargets: [inferred.targets[1]] },
    }],
  });
  assert.deepEqual(corrected.targets.map((target) => target.repositoryId), ["appMarket"]);
  assert.ok(corrected.evidence.some((item) => item.kind === "historical_dependency_rejection"));
});

test("应用市场 WebApp 依赖只在当前工单命中 Web/H5 证据时追加为独立工程", () => {
  const projectDefs = [
    { id: "appMarket", name: "应用市场", ssh: "git@example.com:apps/market.git" },
    {
      id: "webApp",
      name: "WebApp",
      ssh: "git@example.com:apps/web-app.git",
      projectType: "repository",
      inferenceEnabled: true,
      inferenceKeywords: ["WebApp", "web app", "H5", "网页应用", "前端"],
      requiresRepositories: ["appMarket"],
      inheritVariant: ["vehicle"],
      inferenceRole: "dependency",
    },
  ];
  const vehicleMap = {
    avatr8678: {
      aliases: ["阿维塔", "8678"],
      apps: [{ appName: "App Market", repos: [{ repoId: "appMarket", branch: "v202605-ui", flavor: "avatr8678" }] }],
    },
  };
  const keywordMappings = { tag: { "阿维塔": { category: "vehicle", value: "avatr8678" } } };
  const withWebApp = inferConfigFromTicket({
    ticket: {
      title: "【8678】【AppMarket】WebApp H5 页面跳转异常",
      projectName: "App Market",
      tags: ["阿维塔"],
    },
    projectDefs,
    vehicleMap,
    keywordMappings,
  });
  assert.deepEqual(withWebApp.targets.map((target) => target.repositoryId), ["appMarket", "webApp"]);
  assert.deepEqual({
    role: withWebApp.targets[1].targetRole,
    repositoryOnly: withWebApp.targets[1].repositoryOnly,
    vehicle: withWebApp.targets[1].vehicle,
  }, {
    role: "dependency",
    repositoryOnly: true,
    vehicle: "avatr8678",
  });
  assert.ok(withWebApp.evidence.some((item) => item.kind === "repository_dependency" && item.value === "webApp"));

  const withoutWebApp = inferConfigFromTicket({
    ticket: {
      title: "【8678】【AppMarket】原生应用列表刷新异常",
      projectName: "App Market",
      tags: ["阿维塔"],
    },
    projectDefs,
    vehicleMap,
    keywordMappings,
  });
  assert.deepEqual(withoutWebApp.targets.map((target) => target.repositoryId), ["appMarket"]);
});

test("TB 6a53397 六源 9X 证据必须压过多条 Avatr 五星历史且只返回 zeekr9x 主工程", () => {
  const projectDefs = [
    { id: "appMarket", name: "应用市场", ssh: "git@example.com:apps/app-market.git" },
    {
      id: "appMarketSdk",
      name: "应用市场 SDK",
      ssh: "git@example.com:sdk/app-market-sdk.git",
      projectType: "sdk",
      inferenceEnabled: true,
      inferenceKeywords: ["语音", "voice", "tts"],
      requiresRepositories: ["appMarket"],
      inheritVariant: ["vehicle"],
      defaultBranch: "feat/202605sdkaiV4",
    },
  ];
  const vehicleMap = {
    zeekr9x: {
      aliases: ["极氪", "极氪9X", "9X", "zeekr9x"],
      apps: [{
        appName: "App Market",
        repos: [{ repoId: "appMarket", branch: "v202605-ui", flavor: "zeekr9x" }],
      }],
    },
    avatr8678: {
      aliases: ["阿维塔", "阿维塔8678", "8678", "avatr8678"],
      apps: [{
        appName: "App Market",
        repos: [{ repoId: "appMarket", branch: "v202605-ui", flavor: "avatr8678" }],
      }],
    },
    avatr8155: {
      aliases: ["阿维塔8155", "8155", "avatr8155"],
      apps: [{
        appName: "App Market",
        repos: [{ repoId: "appMarket", branch: "v202605-ui", flavor: "avatr8155" }],
      }],
    },
  };
  const ticket = {
    tbTaskId: "6a53397ecc68c293ea295e88",
    title: "【极氪】【9X】【AppMarket】应用详情页的断网页面和UI不一致",
    projectName: "平台组件",
    tasklistName: "应用市场",
    sprintName: "9X UI 缺陷",
    tags: ["极氪9X", "AppMarket"],
    attachments: [{ name: "image.png" }, { name: "9X断网交互.mp4" }],
    comments: ["极氪9X 应用详情页断网交互与 UI 设计稿不一致"],
    description: "9X 应用市场详情页断网后展示异常",
  };
  const registry = buildConfigInferenceRegistry(projectDefs, vehicleMap);
  const historicalSamples = [
    ["avatr8678", "8678", 10],
    ["avatr8678", "8678", 20],
    ["avatr8678", "8678", 30],
    ["avatr8155", "8155", 40],
    ["avatr8155", "8155", 50],
    ["avatr8155", "8155", 60],
  ].map(([vehicle, modelLabel, updatedAt], index) => {
    const historicalTicket = {
      ...ticket,
      tbTaskId: `old-avatr-ui-${index + 1}`,
      title: `【阿维塔】【${modelLabel}】【AppMarket】应用详情页的断网页面和UI不一致`,
      sprintName: `${modelLabel} UI 缺陷`,
      tags: [`阿维塔${modelLabel}`, "AppMarket"],
      comments: [`阿维塔${modelLabel} 应用详情页断网交互与 UI 设计稿不一致`],
      description: `${modelLabel} 应用市场详情页断网后展示异常`,
    };
    const target = registry.targets.find((item) => (
      item.vehicle === vehicle && item.repositoryId === "appMarket"
    ));
    assert.ok(target, `测试注册表缺少 ${vehicle} appMarket 目标`);
    return {
      id: `reviewed-avatr-ui-${index + 1}`,
      source: "user_feedback",
      signals: extractConfigInferenceSignals(historicalTicket, {}),
      groundTruth: { targets: [target] },
      feedback: { decision: "corrected", rating: 5 },
      updatedAt,
    };
  });

  const inferred = inferConfigFromTicket({
    ticket,
    projectDefs,
    vehicleMap,
    samples: historicalSamples,
  });
  const rag = retrieveConfigInferenceMemories({
    projectId: "project-zeekr9x-app-market",
    ticket,
    projectDefs,
    vehicleMap,
    samples: historicalSamples,
    limit: 20,
  });
  const expectedTargets = [{ repositoryId: "appMarket", vehicle: "zeekr9x", targetRole: "primary" }];

  assert.deepEqual(
    inferred.targets.map(({ repositoryId, vehicle, targetRole }) => ({ repositoryId, vehicle, targetRole })),
    expectedTargets,
  );
  assert.equal(inferred.targets.some((target) => target.targetRole === "dependency"), false);
  assert.deepEqual(
    rag.inference.targets.map(({ repositoryId, vehicle, targetRole }) => ({ repositoryId, vehicle, targetRole })),
    expectedTargets,
  );
  assert.equal(
    rag.memories.some((memory) => (memory.targets || []).some((target) => (
      target.vehicle === "avatr8678" || target.vehicle === "avatr8155"
    ))),
    false,
    "模型无关 RAG 不得把旧 Avatr 正向目标暴露给明确的 9X 查询",
  );
});

test("9X 无语音 TB 不得从旧语音五星记忆继承 appMarketSdk，当前语音证据仍原子追加 SDK", () => {
  const projectDefs = [
    { id: "appMarket", name: "应用市场", ssh: "git@example.com:apps/app-market.git" },
    {
      id: "appMarketSdk",
      name: "应用市场 SDK",
      ssh: "git@example.com:sdk/app-market-sdk.git",
      projectType: "sdk",
      inferenceEnabled: true,
      inferenceKeywords: ["语音", "voice", "tts"],
      requiresRepositories: ["appMarket"],
      inheritVariant: ["vehicle"],
      defaultBranch: "feat/202605sdkaiV4",
    },
  ];
  const vehicleMap = {
    zeekr9x: {
      aliases: ["极氪", "极氪9X", "9X", "zeekr9x"],
      apps: [{
        appName: "App Market",
        repos: [{ repoId: "appMarket", branch: "v202605-ui", flavor: "zeekr9x" }],
      }],
    },
  };
  const ticket = {
    tbTaskId: "6a53397ecc68c293ea295e88",
    title: "【极氪】【9X】【AppMarket】应用详情页的断网页面和UI不一致",
    projectName: "平台组件",
    tasklistName: "应用市场",
    sprintName: "9X UI 缺陷",
    tags: ["极氪9X", "AppMarket"],
    attachments: [{ name: "image.png" }, { name: "9X断网交互.mp4" }],
    comments: ["极氪9X 应用详情页断网交互与 UI 设计稿不一致"],
    description: "9X 应用市场详情页断网后展示异常",
  };
  const historicalVoiceTicket = {
    ...ticket,
    tbTaskId: "old-zeekr9x-voice",
    title: "【极氪】【9X】【AppMarket】【语音】应用详情页语音打开未安装应用时 tts 播报错误",
    tags: [...ticket.tags, "语音"],
    comments: ["极氪9X 语音打开应用时 tts 播报错误"],
    description: "9X 应用市场语音控制异常",
  };
  const historicalVoicePrediction = inferConfigFromTicket({
    ticket: historicalVoiceTicket,
    projectDefs,
    vehicleMap,
  });
  assert.deepEqual(
    historicalVoicePrediction.targets.map((target) => target.repositoryId),
    ["appMarket", "appMarketSdk"],
    "测试前提：有当前语音关键词时必须生成 SDK 原子依赖",
  );
  const historicalSample = {
    id: "reviewed-zeekr9x-voice-with-sdk",
    source: "user_feedback",
    signals: historicalVoicePrediction.signals,
    groundTruth: { targets: historicalVoicePrediction.targets },
    feedback: { decision: "corrected", rating: 5 },
    updatedAt: 100,
  };

  const inferred = inferConfigFromTicket({
    ticket,
    projectDefs,
    vehicleMap,
    samples: [historicalSample],
  });
  const rag = retrieveConfigInferenceMemories({
    projectId: "project-zeekr9x-app-market",
    ticket,
    projectDefs,
    vehicleMap,
    samples: [historicalSample],
  });

  assert.deepEqual(inferred.targets.map((target) => target.repositoryId), ["appMarket"]);
  assert.equal(
    rag.inference.targets.some((target) => target.repositoryId === "appMarketSdk"),
    false,
    "没有当前语音证据时，RAG 推理不得继承旧 SDK 依赖",
  );
  assert.equal(
    rag.memories.some((memory) => (memory.targets || []).some((target) => target.repositoryId === "appMarketSdk")),
    false,
    "没有当前语音证据时，RAG 记忆不得暴露旧 SDK 依赖",
  );
  assert.deepEqual(
    rag.inference.targets.map((target) => target.repositoryId),
    ["appMarket"],
    "RAG 推理必须与普通推理一致，只保留一个应用市场主工程",
  );

  const currentVoice = inferConfigFromTicket({
    ticket: historicalVoiceTicket,
    projectDefs,
    vehicleMap,
    samples: [historicalSample],
  });
  assert.deepEqual(currentVoice.targets.map((target) => target.repositoryId), ["appMarket", "appMarketSdk"]);
  assert.equal(currentVoice.targets[0].targetRole, "primary");
  assert.equal(currentVoice.targets[1].targetRole, "dependency");

  const exactTitleHistoricalVoiceTicket = {
    ...historicalVoiceTicket,
    tbTaskId: "old-zeekr9x-exact-title-voice",
    title: ticket.title,
    description: "9X 应用市场详情页中，语音打开未安装应用时 tts 播报错误",
    comments: ["历史评论包含语音和 tts，但标题与当前断网 UI 单完全相同"],
  };
  const exactTitleVoicePrediction = inferConfigFromTicket({
    ticket: exactTitleHistoricalVoiceTicket,
    projectDefs,
    vehicleMap,
  });
  assert.deepEqual(
    exactTitleVoicePrediction.targets.map((target) => target.repositoryId),
    ["appMarket", "appMarketSdk"],
    "测试前提：同标题历史样本通过评论/备注中的语音证据生成 SDK 依赖",
  );
  const exactTitleVoiceSample = {
    id: "reviewed-zeekr9x-exact-title-voice-with-sdk",
    source: "user_feedback",
    signals: exactTitleVoicePrediction.signals,
    groundTruth: { targets: exactTitleVoicePrediction.targets },
    feedback: { decision: "corrected", rating: 5 },
    updatedAt: 200,
  };
  const legacyMissingRoleTargets = exactTitleVoicePrediction.targets.map((target) => {
    if (target.repositoryId !== "appMarketSdk") return target;
    const { targetRole: _ignored, ...legacy } = target;
    return legacy;
  });
  const legacyMissingRoleSample = {
    ...exactTitleVoiceSample,
    id: "legacy-zeekr9x-exact-title-sdk-without-role",
    groundTruth: { targets: legacyMissingRoleTargets },
    updatedAt: 201,
  };
  const wrongPrimaryRoleSample = {
    ...exactTitleVoiceSample,
    id: "legacy-zeekr9x-exact-title-sdk-wrong-primary-role",
    groundTruth: {
      targets: exactTitleVoicePrediction.targets.map((target) => (
        target.repositoryId === "appMarketSdk" ? { ...target, targetRole: "primary" } : target
      )),
    },
    updatedAt: 202,
  };
  const voicePromotionSample = {
    ...exactTitleVoiceSample,
    id: "reviewed-zeekr9x-exact-title-sdk-promoted-primary",
    groundTruth: {
      targets: [{
        ...exactTitleVoicePrediction.targets.find((target) => target.repositoryId === "appMarketSdk"),
        targetRole: "primary",
        order: 1,
      }],
    },
    negative: {
      policyVersion: 1,
      rejectedTargets: [exactTitleVoicePrediction.targets.find((target) => target.repositoryId === "appMarket")],
    },
    updatedAt: 203,
  };
  const exactTitleRag = retrieveConfigInferenceMemories({
    projectId: "project-zeekr9x-app-market",
    ticket,
    projectDefs,
    vehicleMap,
    samples: [exactTitleVoiceSample, legacyMissingRoleSample, wrongPrimaryRoleSample, voicePromotionSample],
  });
  assert.deepEqual(exactTitleRag.inference.targets.map((target) => target.repositoryId), ["appMarket"]);
  assert.equal(
    exactTitleRag.memories.some((memory) => (memory.targets || []).some((target) => target.repositoryId === "appMarketSdk")),
    false,
    "即使历史标题完全相同，没有当前语音证据也不得向通用 RAG memories 暴露 SDK",
  );
  const legacyRoleInference = inferConfigFromTicket({
    ticket,
    projectDefs,
    vehicleMap,
    samples: [legacyMissingRoleSample, wrongPrimaryRoleSample, voicePromotionSample],
  });
  assert.deepEqual(
    legacyRoleInference.targets.map((target) => target.repositoryId),
    ["appMarket"],
    "旧 SDK 角色污染及历史语音 promotion 都不能在当前无语音工单中删除 appMarket 或注入 SDK",
  );
});

test("TB 6a4dc408 的 8678 明确信号不受 8155/9X 旧候选删除污染且只返回应用市场主工程", () => {
  const projectDefs = [
    { id: "appMarket", name: "应用市场", ssh: "git@example.com:apps/app-market.git" },
    {
      id: "appMarketSdk",
      name: "应用市场 SDK",
      ssh: "git@example.com:sdk/app-market-sdk.git",
      projectType: "sdk",
      inferenceKeywords: ["语音", "voice", "tts"],
      requiresRepositories: ["appMarket"],
      inheritVariant: ["vehicle"],
      defaultBranch: "feat/202605sdkaiV4",
    },
  ];
  const vehicleMap = {
    avatr8678: {
      aliases: ["阿维塔", "阿维塔8678", "8678", "avatr8678"],
      apps: [{
        appName: "App Market",
        repos: [{ repoId: "appMarket", branch: "v202605-ui", flavor: "avatr8678" }],
      }],
    },
    avatr8155: {
      aliases: ["阿维塔", "阿维塔8155", "8155", "avatr8155"],
      apps: [{
        appName: "App Market",
        repos: [{ repoId: "appMarket", branch: "v202605-ui", flavor: "avatr8155" }],
      }],
    },
    zeekr9x: {
      aliases: ["极氪", "极氪9X", "9X", "zeekr9x"],
      apps: [{
        appName: "App Market",
        repos: [{ repoId: "appMarket", branch: "v202605-ui", flavor: "zeekr9x" }],
      }],
    },
  };
  const ticket = {
    tbTaskId: "6a4dc40804c7218a7d4e9cbd",
    title: "【阿维塔】【8678】【应用市场】丹麦语下，应用详情页暂停下载文案缺失",
    projectName: "平台组件",
    sprintName: "【应用市场】0716版本",
    tags: ["【阿维塔】"],
    attachments: [
      { name: "image.png" },
      { name: "normal_video.mp4" },
      { name: "log_20260708_112437.log" },
      { name: "20260708-0324-46.1375307.mp4" },
    ],
    comments: ["AppMarket-1.2.80，8678 丹麦语按钮宽度应自适应"],
    description: "按钮宽度要自适应；AppMarket-1.2.40-102040-avatr8678Dev-release",
  };
  const registry = buildConfigInferenceRegistry(projectDefs, vehicleMap);
  const expectedTarget = registry.targets.find((target) => (
    target.vehicle === "avatr8678" && target.repositoryId === "appMarket"
  ));
  assert.ok(expectedTarget);

  // 这些纠正样本模拟真实污染：历史工单主语是 8155/9X，旧预测却给了
  // avatr8678，用户删除该旧候选后，删除语义只能留在原工单上下文内。
  const foreignCorrections = [
    ["avatr8155", "【阿维塔】【8155】【应用市场】首次打开隐私协议后应用退出"],
    ["avatr8155", "【阿维塔】【8155】【应用市场】应用安装卸载弹窗样式错误"],
    ["zeekr9x", "【极氪】【9X】【AppMarket】走行后副屏网页应用立即退出"],
    ["zeekr9x", "【极氪】【9X】【AppMarket】断网点击应用卡片后延迟进入详情页"],
  ].map(([vehicle, title], index) => {
    const historicalTicket = {
      ...ticket,
      tbTaskId: `foreign-correction-${index + 1}`,
      title,
      tags: [vehicle === "zeekr9x" ? "极氪9X" : "【阿维塔】"],
      comments: [`${vehicle} AppMarket 应用详情页问题已复现`],
      description: `${vehicle} 应用市场测试记录`,
    };
    const prediction = inferConfigFromTicket({ ticket: historicalTicket, projectDefs, vehicleMap });
    const correctTarget = registry.targets.find((target) => (
      target.vehicle === vehicle && target.repositoryId === "appMarket"
    ));
    assert.ok(correctTarget);
    return {
      id: `foreign-correction-${index + 1}`,
      source: "training_random",
      signals: prediction.signals,
      feedback: { decision: "corrected", rating: 5 },
      groundTruth: { targets: [correctTarget] },
      negative: { policyVersion: 1, rejectedTargets: [expectedTarget] },
      updatedAt: 100 + index,
    };
  });

  const inferred = inferConfigFromTicket({ ticket, projectDefs, vehicleMap, samples: foreignCorrections });
  const rag = retrieveConfigInferenceMemories({
    projectId: "project-avatr8678-app-market",
    ticket,
    projectDefs,
    vehicleMap,
    samples: foreignCorrections,
    limit: 20,
  });
  const expected = [{
    appName: "App Market",
    vehicle: "avatr8678",
    repositoryId: "appMarket",
    branch: "v202605-ui",
    flavor: "avatr8678",
    targetRole: "primary",
    order: 1,
  }];
  const project = (target) => Object.fromEntries(Object.keys(expected[0]).map((field) => [field, target[field]]));

  assert.deepEqual(inferred.targets.map(project), expected);
  assert.deepEqual(rag.inference.targets.map(project), expected);
  assert.deepEqual(inferred.missingInformation, []);
  assert.equal(inferred.targets.some((target) => target.targetRole === "dependency"), false);
  assert.equal(
    rag.memories.some((memory) => foreignCorrections.some((sample) => sample.id === memory.id)),
    false,
    "跨车型纠正既不能扣当前候选分，也不能向任意模型暴露成当前 removedTargets",
  );

  const exactRemoval = {
    id: "exact-6a4dc408-remove-main",
    source: "user_feedback",
    signals: inferred.signals,
    feedback: { decision: "corrected", rating: 5 },
    groundTruth: { targets: [], noTargets: true },
    negative: { policyVersion: 1, rejectedTargets: [inferred.targets[0]] },
  };
  const exactRemoved = inferConfigFromTicket({ ticket, projectDefs, vehicleMap, samples: [exactRemoval] });
  assert.deepEqual(exactRemoved.targets, [], "同一工单主语下的人工删除必须继续覆盖自动推理");
  assert.ok(exactRemoved.evidence.some((item) => item.kind === "historical_target_removal"));
});

test("工具工程可在应用、车型和 Flavor 为空时参与通用 RAG 与注册表校验", () => {
  const projectDefs = [{
    id: "aiEfficiency",
    name: "AIEfficiency",
    ssh: "git@example.com:tools/AIEfficiency.git",
    projectType: "tooling",
    inferenceEnabled: true,
    inferenceKeywords: ["AIEfficiency", "DevBench", "AI训练", "脚本工具"],
    defaultBranch: "feat/admin-rbac",
  }];
  const ticket = { title: "DevBench AI训练脚本工具异常", projectName: "AIEfficiency" };
  const inference = inferConfigFromTicket({ ticket, projectDefs });

  assert.equal(inference.status, "NEED_HUMAN_CONFIRMATION");
  assert.deepEqual(inference.targets.map((target) => target.repositoryId), ["aiEfficiency"]);
  assert.equal(inference.targets[0].repositoryOnly, true);
  assert.equal(inference.targets[0].appName, "");
  assert.equal(inference.targets[0].vehicle, "");
  assert.equal(inference.targets[0].flavor, "");

  const validation = validateConfigInferenceTargets([
    { repositoryId: "aiEfficiency", branch: "feat/admin-rbac" },
  ], { projectDefs });
  assert.equal(validation.ok, true);
  assert.equal(validation.targets[0].repositoryOnly, true);
  assert.equal(validation.targets[0].projectType, "tooling");
  const legacyClientValidation = validateConfigInferenceTargets([
    { repositoryId: "aiEfficiency", branch: "feat/admin-rbac", vehicle: "avatr8678" },
  ], { projectDefs });
  assert.equal(legacyClientValidation.ok, true);
  assert.equal(legacyClientValidation.targets[0].repositoryOnly, true);
  assert.equal(legacyClientValidation.targets[0].projectType, "tooling");

  const rag = retrieveConfigInferenceMemories({
    projectId: "project-tools",
    ticket,
    projectDefs,
    samples: [{
      id: "observed-tooling",
      source: "actual_execution",
      signals: inference.signals,
      groundTruth: { targets: validation.targets },
      updatedAt: 100,
    }],
  });
  assert.deepEqual(rag.inference.targets.map((target) => target.repositoryId), ["aiEfficiency"]);
  assert.equal(rag.memories[0].targets[0].repositoryOnly, true);
  assert.equal(rag.policy.providerNeutral, true);
  assert.equal(rag.policy.repositoryOnlyTargets, true);
});

test("首次出现的 TB 来源无需等待关键词采集即可直接命中唯一车型别名", () => {
  const vehicleMap = {
    zeekr9x: {
      prodReleaseDir: "\\\\server\\CarBox\\Geely\\极氪9X",
      apps: [{ appName: "应用市场", repos: [{ repoId: "market", branch: "release/zeekr9x", flavor: "zeekr9x" }] }],
    },
  };
  const result = inferConfigFromTicket({
    ticket: { projectName: "平台组件", tasklistName: "极氪_9X", tags: ["极氪9X"] },
    projectDefs: PROJECT_DEFS,
    vehicleMap,
    keywordMappings: {},
  });

  assert.equal(result.status, "NEED_HUMAN_CONFIRMATION");
  assert.equal(result.targets[0].vehicle, "zeekr9x");
  assert.ok(result.signals.matches.some((match) => match.inferenceSource === "registry_source_alias"));
});

test("显式关键词映射使用车型显示别名时规范化为注册表 canonical 值", () => {
  const vehicleMap = {
    zeekr9x: {
      prodReleaseDir: "\\\\server\\CarBox\\Geely\\极氪9X",
      apps: [{ appName: "应用市场", repos: [{ repoId: "market", branch: "release/zeekr9x", flavor: "zeekr9x" }] }],
    },
  };
  const result = inferConfigFromTicket({
    ticket: { tags: ["极氪9X"] },
    projectDefs: PROJECT_DEFS,
    vehicleMap,
    keywordMappings: { tag: { "极氪9X": { category: "vehicle", value: "极氪9X" } } },
  });

  assert.equal(result.targets[0].vehicle, "zeekr9x");
  assert.equal(result.signals.byGroup.tag[0].configuredValue, "极氪9X");
  assert.equal(result.signals.byGroup.tag[0].value, "zeekr9x");
  assert.equal(result.signals.byGroup.tag[0].canonicalizedBy, "registry_alias");
});

test("空白关键词映射命中多个车型别名时保持信息不足而不猜测", () => {
  const vehicleMap = {
    carA: {
      aliases: ["同车型"],
      apps: [{ appName: "应用市场", repos: [{ repoId: "market", branch: "main-a", flavor: "carA" }] }],
    },
    carB: {
      aliases: ["同车型"],
      apps: [{ appName: "应用市场", repos: [{ repoId: "market", branch: "main-b", flavor: "carB" }] }],
    },
  };
  const result = inferConfigFromTicket({
    ticket: { tags: ["同车型"] },
    projectDefs: PROJECT_DEFS,
    vehicleMap,
    keywordMappings: { tag: { "同车型": { category: "", value: "" } } },
  });

  assert.equal(result.status, "NEED_MORE_INFO");
  assert.deepEqual(result.targets, []);
  assert.equal(result.evidence.some((item) => item.kind === "registry_keyword_bridge"), false);
});

test("TB 6a508 六源 P155 证据压过多条旧 Avatr 五星历史且只返回 Geely P155 主依赖", () => {
  const oldAvatrSamples = [
    ...reviewedVehicleSamples(MULTI_VEHICLE_MAP, "avatr8678", "8678", 10),
    ...reviewedVehicleSamples(MULTI_VEHICLE_MAP, "avatr8155", "8155", 20),
  ];
  const result = inferConfigFromTicket({
    ticket: P155_SIX_SOURCE_TICKET,
    projectDefs: MULTI_VEHICLE_PROJECT_DEFS,
    vehicleMap: MULTI_VEHICLE_MAP,
    samples: oldAvatrSamples,
  });

  assert.deepEqual(
    CONFIG_INFERENCE_GROUPS.filter((group) => result.signals.sources[group]?.length),
    CONFIG_INFERENCE_GROUPS,
    "TB 标题、项目、迭代、标签、附件和评论必须全部进入本次推理",
  );
  assert.equal(result.status, "NEED_HUMAN_CONFIRMATION");
  assert.deepEqual(
    result.targets.map((target) => ({
      repositoryId: target.repositoryId,
      vehicle: target.vehicle,
      branch: target.branch,
      flavor: target.flavor,
      targetRole: target.targetRole,
      order: target.order,
    })),
    [
      {
        repositoryId: "appMarket",
        vehicle: "geelyp155",
        branch: "release/geely-p155",
        flavor: "geelyp155",
        targetRole: "primary",
        order: 1,
      },
      {
        repositoryId: "webApp",
        vehicle: "geelyp155",
        branch: "release/geely-p155",
        flavor: "geelyp155",
        targetRole: "dependency",
        order: 2,
      },
    ],
  );
  assert.equal(result.targets.some((target) => target.vehicle.startsWith("avatr")), false);
});

test("P155 查询的通用 RAG 不向任何模型暴露相似旧 Avatr 正向记忆", () => {
  const oldAvatrSamples = [
    ...reviewedVehicleSamples(MULTI_VEHICLE_MAP, "avatr8678", "8678", 10),
    ...reviewedVehicleSamples(MULTI_VEHICLE_MAP, "avatr8155", "8155", 20),
  ];
  const rag = retrieveConfigInferenceMemories({
    projectId: "project-app-market",
    ticket: P155_SIX_SOURCE_TICKET,
    projectDefs: MULTI_VEHICLE_PROJECT_DEFS,
    vehicleMap: MULTI_VEHICLE_MAP,
    samples: oldAvatrSamples,
    limit: 12,
  });

  assert.deepEqual(
    rag.inference.targets.map((target) => target.vehicle),
    ["geelyp155", "geelyp155"],
  );
  assert.equal(
    rag.memories.some((memory) => memory.kind === "positive" && memory.targets.some((target) => (
      target.vehicle === "avatr8678" || target.vehicle === "avatr8155"
    ))),
    false,
  );
});

test("通用 AppMarket 仅仓库信号面对多个车型时保持信息不足且不填默认车型分支 Flavor", () => {
  const result = inferConfigFromTicket({
    ticket: { title: "AppMarket 通用缺陷" },
    projectDefs: MULTI_VEHICLE_PROJECT_DEFS,
    vehicleMap: MULTI_VEHICLE_MAP,
    keywordMappings: {
      title: { AppMarket: { category: "repository", value: "appMarket" } },
    },
  });

  assert.deepEqual(result.signals.matches.map((match) => match.category), ["repositoryId"]);
  assert.equal(result.status, "NEED_MORE_INFO");
  assert.deepEqual(result.targets, []);
  assert.deepEqual(result.dimensions.vehicle, []);
  assert.deepEqual(result.dimensions.branch, []);
  assert.deepEqual(result.dimensions.flavor, []);
});

test("P155 未登记且注册表只有 Avatr 时标题中的 Geely P155 AppMarket 也不得回退 Avatr 默认值", () => {
  const avatrOnlyVehicleMap = {
    avatr8678: MULTI_VEHICLE_MAP.avatr8678,
    avatr8155: MULTI_VEHICLE_MAP.avatr8155,
  };
  const result = inferConfigFromTicket({
    ticket: P155_SIX_SOURCE_TICKET,
    projectDefs: MULTI_VEHICLE_PROJECT_DEFS,
    vehicleMap: avatrOnlyVehicleMap,
    keywordMappings: {
      title: { AppMarket: { category: "repository", value: "appMarket" } },
    },
  });

  assert.equal(result.status, "NEED_MORE_INFO");
  assert.deepEqual(result.targets, []);
  assert.equal(result.dimensions.vehicle.includes("avatr8678"), false);
  assert.equal(result.dimensions.vehicle.includes("avatr8155"), false);
});

test("没有车型关键词时 exact same-source 的已复核 P155 历史仍可学习并召回", () => {
  const genericSixSourceTicket = {
    tbTaskId: "same-source-p155-query",
    title: "用户协议新地址仍显示默认文本",
    projectName: "平台组件",
    tasklistName: "协议地址验证",
    sprintName: "测试环境",
    tags: ["用户协议", "缓存清除"],
    attachments: [{ name: "协议弹窗.png", text: "默认文本" }],
    comments: ["首次弹窗与我的页面表现不一致"],
    description: "配置新地址后清除数据缓存复现",
  };
  const p155Targets = registeredVehicleTargets(MULTI_VEHICLE_MAP, "geelyp155");
  const reviewedP155Sample = {
    id: "exact-same-source-reviewed-p155",
    source: "user_feedback",
    signals: extractConfigInferenceSignals(genericSixSourceTicket, {}),
    groundTruth: { targets: p155Targets },
    feedback: { decision: "corrected", rating: 5 },
    updatedAt: 100,
  };
  const result = inferConfigFromTicket({
    ticket: genericSixSourceTicket,
    projectDefs: MULTI_VEHICLE_PROJECT_DEFS,
    vehicleMap: MULTI_VEHICLE_MAP,
    samples: [reviewedP155Sample],
  });
  const rag = retrieveConfigInferenceMemories({
    projectId: "project-app-market",
    ticket: genericSixSourceTicket,
    projectDefs: MULTI_VEHICLE_PROJECT_DEFS,
    vehicleMap: MULTI_VEHICLE_MAP,
    samples: [reviewedP155Sample],
  });

  assert.equal(result.status, "NEED_HUMAN_CONFIRMATION");
  assert.deepEqual(result.targets.map((target) => target.vehicle), ["geelyp155", "geelyp155"]);
  assert.deepEqual(result.targets.map((target) => target.repositoryId), ["appMarket", "webApp"]);
  assert.ok(result.evidence.some((item) => item.kind === "historical_feedback"));
  assert.deepEqual(rag.memories.map((memory) => memory.id), ["exact-same-source-reviewed-p155"]);
  assert.deepEqual(rag.memories[0].targets.map((target) => target.vehicle), ["geelyp155", "geelyp155"]);
});

test("当前单与旧样本只共享通用 AppMarket 标签时不得迁移旧 Avatr 车型到推理或 RAG", () => {
  const keywordMappings = { tag: { AppMarket: { category: "app", value: "应用市场" } } };
  const historical = {
    id: "generic-appmarket-avatr-history",
    source: "user_feedback",
    signals: extractConfigInferenceSignals({ title: "旧问题", tags: ["AppMarket"] }, keywordMappings),
    groundTruth: { targets: registeredVehicleTargets(MULTI_VEHICLE_MAP, "avatr8678") },
    feedback: { decision: "correct", rating: 5 },
  };
  const ticket = { title: "当前问题", tags: ["AppMarket"] };
  const prediction = inferConfigFromTicket({
    ticket,
    projectDefs: MULTI_VEHICLE_PROJECT_DEFS,
    vehicleMap: MULTI_VEHICLE_MAP,
    keywordMappings,
    samples: [historical],
  });
  const rag = retrieveConfigInferenceMemories({
    projectId: "project-a",
    ticket,
    projectDefs: MULTI_VEHICLE_PROJECT_DEFS,
    vehicleMap: MULTI_VEHICLE_MAP,
    keywordMappings,
    samples: [historical],
  });

  assert.equal(prediction.status, "NEED_MORE_INFO");
  assert.deepEqual(prediction.targets, []);
  assert.equal(rag.memories.some((memory) => memory.id === historical.id), false);
});

test("明确 P155 新分支时过滤同车型同仓库的旧分支", () => {
  const vehicleMap = {
    geelyp155: {
      aliases: ["P155"],
      apps: [{
        appName: "应用市场",
        repos: [
          { repoId: "appMarket", branch: "release/geely-p155-old", flavor: "geelyp155" },
          { repoId: "appMarket", branch: "release/geely-p155-new", flavor: "geelyp155" },
        ],
      }],
    },
  };
  const result = inferConfigFromTicket({
    ticket: { title: "P155 AppMarket 分支验证", tags: ["NEW_BRANCH"] },
    projectDefs: MULTI_VEHICLE_PROJECT_DEFS,
    vehicleMap,
    keywordMappings: { tag: { NEW_BRANCH: { category: "branch", value: "release/geely-p155-new" } } },
  });

  assert.deepEqual(result.targets.map((target) => target.branch), ["release/geely-p155-new"]);
});

test("只命中两个车型共用 Flavor 时保持信息不足而不猜车型和分支", () => {
  const sharedFlavorMap = {
    carA: { apps: [{ appName: "应用市场", repos: [{ repoId: "appMarket", branch: "release/a", flavor: "sharedFlavor" }] }] },
    carB: { apps: [{ appName: "应用市场", repos: [{ repoId: "appMarket", branch: "release/b", flavor: "sharedFlavor" }] }] },
  };
  const result = inferConfigFromTicket({
    ticket: { title: "AppMarket 构建问题", tags: ["SHARED_FLAVOR"] },
    projectDefs: MULTI_VEHICLE_PROJECT_DEFS,
    vehicleMap: sharedFlavorMap,
    keywordMappings: { tag: { SHARED_FLAVOR: { category: "flavor", value: "sharedFlavor" } } },
  });

  assert.equal(result.status, "NEED_MORE_INFO");
  assert.deepEqual(result.targets, []);
});

test("标题 P155 与评论 P162 均保留为跨来源冲突，推荐标题值但必须人工裁决", () => {
  const vehicleMap = {
    geelyp155: MULTI_VEHICLE_MAP.geelyp155,
    geelyp162: {
      aliases: ["Geely P162", "P162"],
      apps: [{
        appName: "应用市场",
        repos: [
          { repoId: "appMarket", branch: "release/geely-p162", flavor: "geelyp162" },
          { repoId: "webApp", branch: "release/geely-p162", flavor: "geelyp162" },
        ],
      }],
    },
  };
  const result = inferConfigFromTicket({
    ticket: { title: "P155 AppMarket 缺陷", comments: ["已在 P162 验证通过"] },
    projectDefs: MULTI_VEHICLE_PROJECT_DEFS,
    vehicleMap,
  });

  assert.ok(result.targets.length > 0);
  assert.deepEqual([...new Set(result.targets.map((target) => target.vehicle))], ["geelyp155"]);
  assert.deepEqual(result.quality.conflicts.softDimensions, ["vehicle"]);
  assert.deepEqual(result.quality.conflicts.reviewDimensions, ["vehicle"]);
  assert.equal(result.quality.conflicts.items[0].recommendedValue, "geelyp155");
  assert.deepEqual(
    result.quality.conflicts.items[0].candidates.map((candidate) => candidate.value),
    ["geelyp155", "geelyp162"],
  );
  assert.ok(result.policy.abstainReasons.includes("conflicting_evidence"));
  assert.equal(result.policy.recommendationAbstained, false, "冲突时仍需展示候选供人工修正");
});

test("同一车型配置多个应用时 AppMarket 信号不会带出无关 Settings 工程", () => {
  const projectDefs = [
    ...MULTI_VEHICLE_PROJECT_DEFS,
    { id: "settings", name: "Settings", ssh: "git@example.com:apps/settings.git" },
  ];
  const vehicleMap = {
    geelyp155: {
      aliases: ["P155"],
      apps: [
        { appName: "应用市场", repos: [{ repoId: "appMarket", branch: "release/p155", flavor: "geelyp155" }] },
        { appName: "Settings", repos: [{ repoId: "settings", branch: "release/p155", flavor: "geelyp155" }] },
      ],
    },
  };
  const result = inferConfigFromTicket({
    ticket: { title: "P155 AppMarket 缺陷" },
    projectDefs,
    vehicleMap,
    keywordMappings: { title: { AppMarket: { category: "repository", value: "appMarket" } } },
  });

  assert.deepEqual(result.targets.map((target) => target.repositoryId), ["appMarket"]);
  assert.equal(result.targets[0].targetRole, "primary");
});

test("同车型 Settings symbolic 历史不得迁移到当前明确的 AppMarket 应用组或 RAG", () => {
  const projectDefs = [
    ...MULTI_VEHICLE_PROJECT_DEFS,
    { id: "settings", name: "Settings", ssh: "git@example.com:apps/settings.git" },
  ];
  const vehicleMap = {
    geelyp155: {
      aliases: ["P155"],
      apps: [
        { appName: "App Market", repos: [{ repoId: "appMarket", branch: "release/p155", flavor: "geelyp155" }] },
        { appName: "Settings", repos: [{ repoId: "settings", branch: "release/p155", flavor: "geelyp155" }] },
      ],
    },
  };
  const keywordMappings = {
    title: {
      AppMarket: { category: "repository", value: "appMarket" },
      Settings: { category: "repository", value: "settings" },
    },
  };
  const historicalTicket = { title: "P155 Settings bluetooth error" };
  const settingsTarget = buildConfigInferenceRegistry(projectDefs, vehicleMap).targets
    .find((target) => target.repositoryId === "settings");
  const symbolicSettingsTarget = {
    ...settingsTarget,
    targetId: "symbolic-settings-history",
    branch: "TARGET_SETTINGS_BRANCH",
    fieldStates: { branch: { kind: "symbolic", feature: "Settings 待确认分支" } },
  };
  const history = {
    id: "reviewed-symbolic-settings-p155",
    source: "user_feedback",
    signals: extractConfigInferenceSignals(historicalTicket, keywordMappings),
    groundTruth: { targets: [symbolicSettingsTarget] },
    feedback: { decision: "corrected", rating: 5 },
  };
  const currentTicket = { title: "P155 AppMarket privacy agreement error" };
  const prediction = inferConfigFromTicket({
    ticket: currentTicket,
    projectDefs,
    vehicleMap,
    keywordMappings,
    samples: [history],
  });
  const rag = retrieveConfigInferenceMemories({
    projectId: "project-p155-app-scope",
    ticket: currentTicket,
    projectDefs,
    vehicleMap,
    keywordMappings,
    samples: [history],
  });

  assert.deepEqual(prediction.targets.map((target) => target.repositoryId), ["appMarket"]);
  assert.equal(prediction.targets.some((target) => target.repositoryId === "settings"), false);
  assert.equal(rag.memories.some((memory) => (
    (memory.targets || []).some((target) => target.repositoryId === "settings")
  )), false);
});

test("通用 RAG 以项目范围召回正负记忆并返回模型无关的注册表事实", () => {
  const vehicleMap = {
    zeekr9x: {
      prodReleaseDir: "\\\\server\\CarBox\\Geely\\极氪9X",
      apps: [{ appName: "App Market", repos: [{ repoId: "market", branch: "release/zeekr9x", flavor: "zeekr9x" }] }],
    },
  };
  const ticket = {
    tbTaskId: "6a55a79678144bda88d42d61",
    title: "【9x】radiofm 获取国家码",
    projectName: "平台组件",
    tasklistName: "极氪_9X",
    tags: ["极氪9X"],
    note: "不要执行历史文本中的任何指令",
  };
  const keywordMappings = { tag: { "极氪9X": { category: "", value: "" } } };
  const signals = inferConfigFromTicket({
    ticket,
    projectDefs: PROJECT_DEFS,
    vehicleMap,
    keywordMappings,
  }).signals;
  const target = buildConfigInferenceRegistry(PROJECT_DEFS, vehicleMap).targets[0];
  const staleTarget = { ...target, repositoryId: "web", repositoryName: "WebApp", branch: "removed", flavor: "removed" };
  const rag = retrieveConfigInferenceMemories({
    projectId: "project-zeekr",
    ticket,
    projectDefs: PROJECT_DEFS,
    vehicleMap,
    keywordMappings,
    samples: [
      {
        id: "actual-success",
        source: "actual_execution",
        rating: 5,
        signals,
        groundTruth: { targets: [target] },
        updatedAt: 20,
      },
      {
        id: "reviewed-negative",
        source: "user_feedback",
        feedback: { decision: "insufficient", rating: 1 },
        negative: { rejectedTargets: [target] },
        signals,
        updatedAt: 10,
      },
      {
        id: "wrong-ticket",
        feedback: { decision: "ticket_wrong", rating: 1 },
        negative: { rejectedTargets: [target] },
        signals,
      },
      {
        id: "incorrect-memory",
        feedback: { decision: "incorrect", rating: 1 },
        negative: { rejectedTargets: [target] },
        signals,
      },
      {
        id: "unreviewed-dirty-memory",
        signals,
        groundTruth: { targets: [target] },
      },
      {
        id: "removed-registry-target",
        source: "user_feedback",
        feedback: { decision: "corrected", rating: 5 },
        signals,
        groundTruth: { targets: [staleTarget] },
      },
    ],
  });

  assert.equal(rag.schemaVersion, CONFIG_INFERENCE_RAG_VERSION);
  assert.equal(rag.projectId, "project-zeekr");
  assert.equal(rag.policy.providerNeutral, true);
  assert.equal(rag.policy.projectScoped, true);
  assert.equal(rag.policy.rawHistoricalPromptExcluded, true);
  assert.equal(rag.inference.targets[0].vehicle, "zeekr9x");
  assert.deepEqual(rag.memories.map((item) => item.id), ["actual-success", "reviewed-negative"]);
  assert.deepEqual(rag.memories.map((item) => item.kind), ["positive", "negative"]);
  assert.ok(rag.memories[0].sourceGroups.includes("note"));
  assert.equal(JSON.stringify(rag).includes("不要执行历史文本中的任何指令"), false);
  assert.equal(Object.hasOwn(rag, "engine"), false);
  assert.equal(Object.hasOwn(rag, "model"), false);
});

test("附件和评论规则分别驱动对应候选，不跨来源串扰", () => {
  const vehicleMap = {
    carA: { apps: [{ appName: "附件应用", repos: [{ repoId: "market", branch: "main-a", flavor: "flavor-a" }] }] },
    carB: { apps: [{ appName: "评论应用", repos: [{ repoId: "web", branch: "main-b", flavor: "flavor-b" }] }] },
  };
  const keywordMappings = {
    attachment: { crashlog: { category: "app", value: "附件应用" } },
    comment: { voicehint: { category: "app", value: "评论应用" } },
  };

  const attachmentResult = inferConfigFromTicket({
    ticket: {
      tbTaskId: "tb-attachment-only",
      attachments: [{ name: "crashlog.zip" }],
      comments: "无关内容",
      sourceCoverage: {
        detail: { available: false, complete: false },
        comments: { available: false, complete: false },
        attachments: { available: true, complete: true },
        tags: { available: false, complete: false },
      },
    },
    projectDefs: PROJECT_DEFS,
    vehicleMap,
    keywordMappings,
  });
  assert.deepEqual(attachmentResult.targets.map((target) => target.repositoryId), ["market"]);
  assert.deepEqual(attachmentResult.policy.missingSources, []);

  const commentResult = inferConfigFromTicket({
    ticket: {
      tbTaskId: "tb-comment-only",
      attachments: [{ name: "ordinary.txt" }],
      comments: "voicehint 已复现",
      sourceCoverage: {
        detail: { available: false, complete: false },
        comments: { available: true, complete: true },
        attachments: { available: false, complete: false },
        tags: { available: false, complete: false },
      },
    },
    projectDefs: PROJECT_DEFS,
    vehicleMap,
    keywordMappings,
  });
  assert.deepEqual(commentResult.targets.map((target) => target.repositoryId), ["web"]);
  assert.deepEqual(commentResult.policy.missingSources, []);
});

test("车型与 Flavor 独立保存，注册表校验只接受已登记组合", () => {
  const registry = buildConfigInferenceRegistry(PROJECT_DEFS, VEHICLE_MAP);
  const market = registry.targets.find((target) => target.repositoryId === "market");
  assert.equal(market.vehicle, "阿维塔 8678");
  assert.equal(market.flavor, "avatr8678Prod");
  assert.notEqual(market.vehicle, market.flavor);
  assert.equal(market.gitUrl, "git@example.com:apps/market.git");

  const valid = validateConfigInferenceTargets([market], { projectDefs: PROJECT_DEFS, vehicleMap: VEHICLE_MAP });
  assert.equal(valid.ok, true);
  const invalid = validateConfigInferenceTargets([{ ...market, flavor: "阿维塔 8678" }], {
    projectDefs: PROJECT_DEFS,
    vehicleMap: VEHICLE_MAP,
  });
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /未在车型源码注册表中登记/);
});

test("相同六源信号的人工反馈样本提升正确目标的置信度和排序", () => {
  const keywordMappings = {
    title: { "启动失败": { category: "app", value: "应用市场" } },
  };
  const ticket = { title: "应用市场启动失败", projectName: "平台组件", tasklistName: "应用市场" };
  const baseline = inferConfigFromTicket({
    ticket,
    projectDefs: PROJECT_DEFS,
    vehicleMap: VEHICLE_MAP,
    keywordMappings,
  });
  const webBefore = baseline.targets.find((target) => target.repositoryId === "web");
  assert.ok(webBefore);

  const signals = extractConfigInferenceSignals(ticket, keywordMappings);
  const webTarget = buildConfigInferenceRegistry(PROJECT_DEFS, VEHICLE_MAP).targets
    .find((target) => target.repositoryId === "web");
  const learned = inferConfigFromTicket({
    ticket,
    projectDefs: PROJECT_DEFS,
    vehicleMap: VEHICLE_MAP,
    keywordMappings,
    samples: [{
      id: "feedback-1",
      signals,
      groundTruth: { targets: [webTarget] },
      feedback: { decision: "corrected", score: 5 },
    }],
  });
  const webAfter = learned.targets.find((target) => target.repositoryId === "web");
  assert.equal(learned.targets[0].repositoryId, "web");
  assert.ok(webAfter.confidence > webBefore.confidence);
  assert.ok(learned.evidence.some((item) => item.kind === "historical_feedback"));
});

test("信息不足反馈只对相同来源、规则和候选降权，并且不会被误当成正样本", () => {
  const keywordMappings = {
    title: { "启动失败": { category: "repository", value: "market" } },
  };
  const ticket = { title: "应用市场启动失败", projectName: "平台组件", tasklistName: "应用市场" };
  const baseline = inferConfigFromTicket({
    ticket,
    projectDefs: PROJECT_DEFS,
    vehicleMap: VEHICLE_MAP,
    keywordMappings,
  });
  assert.equal(baseline.targets[0].repositoryId, "market");
  const signals = extractConfigInferenceSignals(ticket, keywordMappings);
  const rejected = inferConfigFromTicket({
    ticket,
    projectDefs: PROJECT_DEFS,
    vehicleMap: VEHICLE_MAP,
    keywordMappings,
    samples: [{
      id: "insufficient-1",
      signals,
      // 即使脏旧数据误带 groundTruth，decision=insufficient 也必须只走负向分支。
      groundTruth: { targets: baseline.targets },
      feedback: {
        decision: "insufficient",
        rating: 1,
        rejectedPrediction: { targets: baseline.targets },
      },
    }],
  });
  assert.equal(rejected.status, "NEED_MORE_INFO");
  assert.equal(rejected.targets.length, 0);
  assert.ok(rejected.evidence.some((item) => item.kind === "historical_insufficient" && item.weight < 0));
  assert.equal(rejected.evidence.some((item) => item.kind === "historical_feedback"), false);

  const broadMappings = { title: { "启动失败": { category: "app", value: "应用市场" } } };
  const broadSignals = extractConfigInferenceSignals(ticket, broadMappings);
  const noCandidateCycling = inferConfigFromTicket({
    ticket,
    projectDefs: PROJECT_DEFS,
    vehicleMap: VEHICLE_MAP,
    keywordMappings: broadMappings,
    samples: [{
      id: "insufficient-broad",
      signals: broadSignals,
      feedback: {
        decision: "insufficient",
        rating: 1,
        // 只否定当时首项，其他同规则候选也应受较小上下文惩罚，不能轮换继续猜。
        rejectedPrediction: { targets: [baseline.targets[0]] },
      },
    }],
  });
  assert.equal(noCandidateCycling.targets.length, 0);
  assert.ok(noCandidateCycling.evidence.some((item) => item.category === "signal_context" && item.weight < 0));

  const unrelated = inferConfigFromTicket({
    ticket: { title: "应用市场白屏" },
    projectDefs: PROJECT_DEFS,
    vehicleMap: VEHICLE_MAP,
    keywordMappings: { title: { "应用市场": { category: "repository", value: "market" } } },
    samples: [{
      id: "insufficient-1",
      signals,
      feedback: { decision: "insufficient", rating: 1, rejectedPrediction: { targets: baseline.targets } },
    }],
  });
  assert.equal(unrelated.targets[0].repositoryId, "market");
  assert.equal(unrelated.evidence.some((item) => item.kind === "historical_insufficient"), false);
});

test("历史样本兼容原有信号字段并仍受注册表约束", () => {
  const ticket = { title: "启动失败", iterationName: "版本 8.6", tags: ["车机"] };
  const learned = inferConfigFromTicket({
    ticket,
    projectDefs: PROJECT_DEFS,
    vehicleMap: VEHICLE_MAP,
    samples: [{
      id: "legacy-feedback",
      signals: { titleKeywords: ["启动失败"], sprintName: "版本 8.6", tags: ["车机"] },
      groundTruth: {
        targets: [{
          appName: "应用市场",
          vehicle: "阿维塔 8678",
          repositoryId: "market",
          branch: "release/avatr",
          flavor: "avatr8678Prod",
        }],
      },
      feedback: { decision: "corrected", rating: 5 },
    }],
  });

  assert.equal(learned.targets[0].repositoryId, "market");
  assert.ok(learned.targets[0].evidenceIds.length > 0);
  assert.equal(learned.targets[0].repositoryName, "应用市场");
  assert.equal(learned.targets[0].gitUrl, "git@example.com:apps/market.git");
});

test("旧 flat 工程目标自动合成稳定永久 Key，实际值多次替换不改写原始样本且按项目隔离", () => {
  const rawTarget = {
    targetId: "legacy-flat-main",
    appName: "应用市场",
    vehicle: "阿维塔 8678",
    repositoryId: "market",
    repositoryName: "应用市场",
    gitUrl: "git@example.com:apps/market.git",
    branch: "release/legacy",
    flavor: "legacyFlavor",
    targetRole: "primary",
    order: 1,
  };
  const rawBefore = structuredClone(rawTarget);
  const first = bindConfigInferenceTargets([rawTarget], { projectId: "project-binding-a" })[0];
  const repeated = bindConfigInferenceTargets([rawTarget], { projectId: "project-binding-a" })[0];
  const bindingFields = [...CONFIG_INFERENCE_DIMENSIONS, "order"];

  assert.deepEqual(
    Object.fromEntries(bindingFields.map((field) => [field, first.fieldBindings[field].logicalKey])),
    Object.fromEntries(bindingFields.map((field) => [field, repeated.fieldBindings[field].logicalKey])),
    "同一项目的旧 flat 数据每次读取必须得到完全相同的永久 Key",
  );
  assert.ok(bindingFields.every((field) => first.fieldBindings[field].logicalKey.startsWith(`ci.${field}.`)));
  assert.equal(first.fieldBindings.order.replaceable, false);
  assert.deepEqual(rawTarget, rawBefore, "读时兼容不能原地改写旧学习样本");

  const branchKey = first.fieldBindings.branch.logicalKey;
  const branchScopeKey = first.fieldBindings.branch.scopeKey;
  const binding = (actualValue, revision) => ({
    [branchKey]: {
      logicalKey: branchKey,
      dimension: "branch",
      scopeKey: branchScopeKey,
      actualValue,
      defaultValue: rawTarget.branch,
      revision,
    },
  });
  const replacedOnce = bindConfigInferenceTargets([rawTarget], {
    projectId: "project-binding-a",
    valueBindings: binding("release/replaced-once", 1),
  })[0];
  const replacedTwice = bindConfigInferenceTargets([rawTarget], {
    projectId: "project-binding-a",
    valueBindings: binding("release/replaced-twice", 2),
  })[0];

  assert.equal(replacedOnce.branch, "release/replaced-once");
  assert.equal(replacedTwice.branch, "release/replaced-twice");
  assert.equal(replacedOnce.fieldBindings.branch.logicalKey, branchKey);
  assert.equal(replacedTwice.fieldBindings.branch.logicalKey, branchKey);
  assert.equal(replacedTwice.fieldBindings.branch.revision, 2);
  assert.equal(replacedTwice.fieldBindings.branch.defaultValue, rawTarget.branch);
  assert.deepEqual(rawTarget, rawBefore, "第二次替换后 raw sample 和永久 Key 的来源仍不能变化");

  const otherProject = bindConfigInferenceTargets([rawTarget], {
    projectId: "project-binding-b",
    valueBindings: binding("release/must-not-cross-project", 3),
  })[0];
  assert.notEqual(otherProject.fieldBindings.branch.logicalKey, branchKey);
  assert.equal(otherProject.branch, rawTarget.branch, "项目 A 的实际值映射不能污染项目 B");
});

test("symbolic 字段解析后保留永久 Key，并可在同一 Key 上再次替换实际值", () => {
  const symbolicTarget = {
    targetId: "symbolic-binding-main",
    appName: "应用市场",
    vehicle: "阿维塔 8678",
    repositoryId: "market",
    repositoryName: "应用市场",
    gitUrl: "git@example.com:apps/market.git",
    branch: "VOICE_BRANCH_ALIAS",
    flavor: "avatr8678Prod",
    targetRole: "primary",
    order: 1,
    fieldStates: {
      branch: { kind: "symbolic", feature: "语音功能开发分支" },
    },
  };
  const symbolicBefore = structuredClone(symbolicTarget);
  const unresolved = bindConfigInferenceTargets([symbolicTarget], { projectId: "project-symbolic-binding" })[0];
  const logicalKey = unresolved.fieldBindings.branch.logicalKey;
  const scopeKey = unresolved.fieldBindings.branch.scopeKey;
  assert.ok(logicalKey);
  assert.equal(unresolved.fieldBindings.branch.actualValue, "");
  assert.equal(unresolved.fieldBindings.branch.resolved, false);
  assert.equal(unresolved.fieldStates.branch.kind, "symbolic");

  const materialize = (actualValue, revision) => bindConfigInferenceTargets([symbolicTarget], {
    projectId: "project-symbolic-binding",
    valueBindings: {
      [logicalKey]: { logicalKey, dimension: "branch", scopeKey, actualValue, revision },
    },
  })[0];
  const first = materialize("feature/voice-first", 1);
  const second = materialize("feature/voice-second", 2);

  assert.equal(first.branch, "feature/voice-first");
  assert.equal(second.branch, "feature/voice-second");
  assert.equal(first.fieldBindings.branch.logicalKey, logicalKey);
  assert.equal(second.fieldBindings.branch.logicalKey, logicalKey);
  assert.equal(second.fieldBindings.branch.actualValue, "feature/voice-second");
  assert.equal(second.fieldBindings.branch.revision, 2);
  assert.equal(second.fieldStates?.branch, undefined, "存在实际值后不应继续把该字段标成 unresolved symbolic");
  assert.deepEqual(symbolicTarget, symbolicBefore, "解析和再次替换不能覆盖原 symbolic 学习事实");
});

test("永久 Key 的实际值在推理和模型无关 RAG 中读时即时物化，raw 学习样本保持不变", () => {
  const projectId = "project-binding-rag";
  const projectDefs = [{ id: "market", name: "应用市场", ssh: "git@example.com:apps/market.git" }];
  const vehicleMap = {
    avatr8678: {
      aliases: ["8678", "阿维塔8678"],
      apps: [{
        appName: "应用市场",
        repos: [
          { repoId: "market", branch: "release/binding-a", flavor: "avatr8678" },
          { repoId: "market", branch: "release/binding-b", flavor: "avatr8678" },
          { repoId: "market", branch: "release/binding-c", flavor: "avatr8678" },
        ],
      }],
    },
  };
  const keywordMappings = {
    title: { "应用市场": { category: "app", value: "应用市场" } },
    tag: { "8678": { category: "vehicle", value: "avatr8678" } },
  };
  const ticket = {
    ticketId: "BINDING-RAG-TICKET",
    title: "应用市场语音配置",
    tags: ["8678"],
  };
  const rawTarget = buildConfigInferenceRegistry(projectDefs, vehicleMap).targets
    .find((target) => target.branch === "release/binding-a");
  assert.ok(rawTarget);
  const sample = {
    id: "legacy-flat-binding-sample",
    projectId,
    source: "user_feedback",
    signals: extractConfigInferenceSignals(ticket, keywordMappings),
    groundTruth: { targets: [rawTarget] },
    feedback: { decision: "corrected", rating: 5 },
    createdAt: 100,
    updatedAt: 100,
  };
  const rawSampleBefore = structuredClone(sample);
  const seed = bindConfigInferenceTargets([rawTarget], { projectId })[0];
  const logicalKey = seed.fieldBindings.branch.logicalKey;
  const scopeKey = seed.fieldBindings.branch.scopeKey;
  const bindings = (actualValue, revision) => ({
    [logicalKey]: {
      logicalKey,
      dimension: "branch",
      scopeKey,
      actualValue,
      defaultValue: "release/binding-a",
      revision,
    },
  });

  for (const [actualValue, revision] of [["release/binding-b", 1], ["release/binding-c", 2]]) {
    const valueBindings = bindings(actualValue, revision);
    const inferred = inferConfigFromTicket({
      projectId,
      ticket,
      projectDefs,
      vehicleMap,
      keywordMappings,
      samples: [sample],
      valueBindings,
    });
    const learnedTarget = inferred.targets.find((target) => target.fieldBindings?.branch?.logicalKey === logicalKey);
    assert.ok(learnedTarget, `推理应保留永久 Key ${logicalKey}`);
    assert.equal(learnedTarget.branch, actualValue);
    assert.equal(learnedTarget.fieldBindings.branch.actualValue, actualValue);
    assert.equal(learnedTarget.fieldBindings.branch.revision, revision);

    const rag = retrieveConfigInferenceMemories({
      projectId,
      ticket,
      projectDefs,
      vehicleMap,
      keywordMappings,
      samples: [sample],
      valueBindings,
    });
    const memoryTarget = rag.memories
      .flatMap((memory) => memory.targets || [])
      .find((target) => target.fieldBindings?.branch?.logicalKey === logicalKey);
    assert.ok(memoryTarget, `RAG 应返回带永久 Key 的学习目标 ${logicalKey}`);
    assert.equal(memoryTarget.branch, actualValue);
    assert.equal(memoryTarget.fieldBindings.branch.actualValue, actualValue);
    assert.equal(memoryTarget.fieldBindings.branch.revision, revision);
  }

  assert.deepEqual(sample, rawSampleBefore, "两次推理/RAG 物化均不能改写 raw 学习样本");
});

test("配置推理存储形成 run→review→learn 闭环，并幂等记录同一次真实执行", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "config-inference-store-"));
  const marketConfig = path.join(tmp, "market.json");
  process.env.DEVBENCH_CONFIG_PATH = marketConfig;
  process.env.DEVBENCH_STORE_DIR = path.join(tmp, "store");
  process.env.GATEWAY_CONFIG_PATH = path.join(tmp, "gateway.json");
  process.env.GATEWAY_DB_PATH = path.join(tmp, "data.db");
  fs.writeFileSync(process.env.GATEWAY_CONFIG_PATH, JSON.stringify({
    servers: { nodeId: "config-inference-test" },
    teambition: { projects: [{ id: "project-a", name: "Project A" }] },
  }), "utf8");
  fs.writeFileSync(marketConfig, JSON.stringify({
    projectDefs: PROJECT_DEFS,
    byProject: {
      "project-a": {
        vehicleMap: VEHICLE_MAP,
        configMemory: [{
          id: "legacy-local-project-copy",
          config: {
            primaryProjectId: "local-market-copy-not-in-project-defs",
            primaryRemote: "git@example.com:apps/market.git",
            primaryBranch: "release/avatr",
            flavor: "avatr8678Prod",
          },
          signals: {
            app: "应用市场",
            vehicle: "阿维塔 8678",
            titleKeywords: ["LOCAL_COPY_MEMORY"],
            tags: [],
          },
          sampleTitle: "LOCAL_COPY_MEMORY",
          count: 4,
          createdAt: 1,
          updatedAt: 2,
        }],
        keywordMappings: {
          title: { "启动失败": { category: "app", value: "应用市场" } },
        },
      },
    },
  }), "utf8");

  const store = await import("../services/devbench/store.js");
  const legacyRag = store.getConfigInferenceRagContext("project-a", { title: "LOCAL_COPY_MEMORY" });
  const legacyMemory = legacyRag.memories.find((memory) => memory.id === "legacy:legacy-local-project-copy");
  assert.ok(legacyMemory);
  assert.deepEqual(legacyMemory.targets.map((target) => target.repositoryId), ["market"]);
  assert.equal(legacyMemory.targets[0].branch, "release/avatr");
  assert.equal(legacyMemory.targets[0].flavor, "avatr8678Prod");

  const baselineOps = store.__testBuildBaselineSharedOps({
    byProject: {
      "project-a": {
        aiTraining: {
          configInference: {
            runs: { "baseline-run": { id: "baseline-run" } },
            samples: { "baseline-sample": { id: "baseline-sample" } },
            trainedTickets: { "baseline-ticket": { id: "baseline-ticket", tbTaskId: "baseline-ticket" } },
            trainingClaims: { "claimed-ticket": { id: "claimed-ticket", tbTaskId: "claimed-ticket", sessionId: "baseline-session", expiresAt: Date.now() + 60_000 } },
            valueBindings: {
              "ci.branch.baseline-key": {
                id: "ci.branch.baseline-key",
                logicalKey: "ci.branch.baseline-key",
                dimension: "branch",
                actualValue: "feature/baseline",
                revision: 1,
              },
            },
          },
        },
      },
    },
  }, 100);
  assert.ok(baselineOps.some((op) => op.path?.join("/") === "aiTraining/configInference/runs/baseline-run"));
  assert.ok(baselineOps.some((op) => op.path?.join("/") === "aiTraining/configInference/samples/baseline-sample"));
  assert.ok(baselineOps.some((op) => op.path?.join("/") === "aiTraining/configInference/trainedTickets/baseline-ticket"));
  assert.ok(baselineOps.some((op) => op.path?.join("/") === "aiTraining/configInference/trainingClaims/claimed-ticket"));
  assert.ok(baselineOps.some((op) => op.path?.join("/") === "aiTraining/configInference/valueBindings/ci.branch.baseline-key"));
  const ticket = {
    ticketId: "CARB-CONFIG-1",
    title: "应用市场启动失败",
    projectName: "平台组件",
    tasklistName: "应用市场",
  };
  const first = store.runConfigInference("project-a", {
    ticket,
    captureSignals: false,
    trainingSource: {
      type: "teambition_section",
      url: "https://www.teambition.com/project/project-a/sprint/section/section-a",
      projectId: "project-a",
      sectionId: "section-a",
      counts: { all: 10, pending: 4, completed: 6 },
      path: "D:/must-not-persist",
      rawTasks: [{ id: "must-not-persist" }],
    },
  });
  assert.equal(first.ok, true);
  assert.equal(first.data.prediction.targets[0].repositoryId, "market");
  assert.equal(first.data.trainingSource.sectionId, "section-a");
  assert.deepEqual(first.data.trainingSource.counts, { all: 10, pending: 4, completed: 6 });
  assert.equal("path" in first.data.trainingSource, false);
  assert.equal("rawTasks" in first.data.trainingSource, false);

  const registry = store.getConfigInferenceData("project-a").registry;
  assert.deepEqual(registry.options.branches.find((option) => option.repositoryId === "web"), {
    repositoryId: "web",
    repositoryName: "WebApp",
    branch: "release/web-avatr",
  });
  assert.deepEqual(registry.options.flavors.find((option) => option.repositoryId === "web"), {
    repositoryId: "web",
    repositoryName: "WebApp",
    flavor: "web8678",
  });
  const correctedTarget = registry.targets.find((target) => target.repositoryId === "web");
  assert.ok(correctedTarget);
  const correctedTargetWithId = {
    ...correctedTarget,
    targetId: "target_local_web",
    targetRole: "primary",
    order: 1,
  };
  const localWebPath = path.join(tmp, "local-web-checkout");
  fs.mkdirSync(path.join(localWebPath, ".git"), { recursive: true });
  fs.writeFileSync(path.join(localWebPath, ".git", "config"), '[remote "origin"]\n\turl = https://example.com/apps/web.git\n');
  fs.writeFileSync(path.join(localWebPath, ".git", "HEAD"), "ref: refs/heads/develop\n");
  assert.equal(store.upsertProject({ id: "local-web-checkout", name: "本机 WebApp", path: localWebPath }).ok, true);
  const insufficientRun = store.runConfigInference("project-a", { ticket, captureSignals: false });
  const insufficientReview = store.reviewConfigInferenceRun("project-a", insufficientRun.data.id, {
    decision: "insufficient",
    rating: 1,
    reviewer: "integration-test",
  });
  assert.equal(insufficientReview.ok, true);
  assert.equal(insufficientReview.learned, false);
  assert.equal(insufficientReview.annotationPending, true);
  assert.equal(insufficientReview.sample.feedback.decision, "insufficient");
  assert.ok(insufficientReview.sample.negative.rejectedTargets.length > 0);
  assert.equal(insufficientReview.sample.groundTruth, null);

  const reviewed = store.reviewConfigInferenceRun("project-a", first.data.id, {
    decision: "corrected",
    rating: 5,
    reviewer: "integration-test",
    correctedPrediction: { targets: [correctedTargetWithId] },
    localProjectBindings: [{
      targetId: correctedTargetWithId.targetId,
      repositoryId: correctedTarget.repositoryId,
      branch: correctedTargetWithId.branch,
      projectId: "local-web-checkout",
    }],
  });
  assert.equal(reviewed.ok, true, reviewed.error);
  assert.equal(
    reviewed.sample.groundTruth.targets.some((target) => target.repositoryId === "web"),
    true,
    JSON.stringify(reviewed.sample.groundTruth),
  );
  approveReviewedAnnotation(store, "project-a", reviewed, "store-corrected");
  assert.equal(reviewed.sample.sourceRunId, first.data.id);
  assert.equal(reviewed.sample.trainingSource.sectionId, "section-a");
  assert.equal(
    reviewed.sample.negative.rejectedTargets.some((target) => target.repositoryId === "market"),
    true,
  );
  assert.equal(
    reviewed.sample.feedback.rejectedPrediction.targets.some((target) => target.repositoryId === "market"),
    true,
  );
  assert.equal(reviewed.snapshot.mode, "local");
  assert.equal(reviewed.snapshot.primaryProjectId, "local-web-checkout");
  assert.equal(reviewed.snapshot.branches[localWebPath], correctedTarget.branch);
  assert.deepEqual(reviewed.snapshot.flavors, [{ path: localWebPath, flavor: correctedTarget.flavor }]);
  assert.equal(reviewed.localResolution.targets[0].matchKind, "user_selected");
  const reviewedRetry = store.reviewConfigInferenceRun("project-a", first.data.id, {
    decision: "corrected",
    rating: 5,
    reviewer: "integration-test",
    correctedPrediction: { targets: [correctedTargetWithId] },
    localProjectBindings: [{
      targetId: correctedTargetWithId.targetId,
      repositoryId: correctedTarget.repositoryId,
      branch: correctedTargetWithId.branch,
      projectId: "local-web-checkout",
    }],
  });
  assert.equal(reviewedRetry.ok, true, reviewedRetry.error);
  assert.equal(reviewedRetry.idempotent, true);
  assert.deepEqual(reviewedRetry.snapshot, reviewed.snapshot, "幂等复核必须返回与首次完全一致的本机快照");
  const reviewedForStoryCreation = store.getReviewedConfigInferenceSnapshot(
    "project-a",
    first.data.id,
    {
      localProjectBindings: [{
        targetId: correctedTargetWithId.targetId,
        repositoryId: correctedTarget.repositoryId,
        branch: correctedTargetWithId.branch,
        projectId: "local-web-checkout",
      }],
      // 创建入口不得消费客户端自行拼装的 targets。
      targets: [{ repositoryId: "malicious", branch: "main" }],
    },
  );
  assert.equal(reviewedForStoryCreation.ok, true, reviewedForStoryCreation.error);
  assert.equal(reviewedForStoryCreation.snapshot.mode, "local");
  assert.equal(reviewedForStoryCreation.snapshot.primaryProjectId, "local-web-checkout");
  assert.deepEqual(
    reviewedForStoryCreation.targets.map((target) => target.repositoryId),
    ["web"],
  );
  const rejectedInsufficientReview = store.getReviewedConfigInferenceSnapshot(
    "project-a",
    insufficientRun.data.id,
  );
  assert.equal(rejectedInsufficientReview.ok, false);
  assert.equal(rejectedInsufficientReview.code, "CONFIG_INFERENCE_REVIEW_NOT_APPLICABLE");
  const rememberedLocal = JSON.parse(fs.readFileSync(process.env.DEVBENCH_LOCAL_PROJECTS_PATH, "utf8"));
  assert.equal(rememberedLocal.repositoryBindings.web[correctedTarget.branch].projectId, "local-web-checkout");

  const learned = store.runConfigInference("project-a", { ticket, captureSignals: false });
  assert.equal(learned.ok, true);
  const learnedMemory = store.getConfigInferenceRagContext("project-a", ticket).memories
    .find((memory) => memory.id === reviewed.sample.id);
  assert.ok(learnedMemory, "双审批准后的 annotation 必须进入 serving RAG");
  assert.equal(
    learnedMemory.targets.some((target) => target.repositoryId === "web"),
    true,
    JSON.stringify(learnedMemory),
  );
  const tbTaskId = "0123456789abcdef01234567";
  const actualTab = {
    id: "tab-actual-config",
    title: "实际执行配置",
    ticketUrl: `https://www.teambition.com/task/${tbTaskId}`,
    mode: "remote",
    remoteRepos: [{
      role: "primary",
      ok: true,
      path: path.join(tmp, "remote-web"),
      name: "WebApp",
      projectId: "web",
      branch: "release/web-avatr",
    }],
    remotePull: {
      vehicle: "阿维塔 8678",
      entries: [{ projectId: "web", branch: "release/web-avatr", flavor: "web8678" }],
    },
    tbContext: {
      projectId: "project-a",
      ticketId: "CARB-CONFIG-ACTUAL",
      title: "首次进入开发",
      comments: [],
    },
  };
  const usage1 = store.recordConfigInferenceUsage("project-a", {
    tab: actualTab,
    actionKind: "develop_started",
  });
  const usage2 = store.recordConfigInferenceUsage("project-a", {
    tab: { ...actualTab, tbContext: { ...actualTab.tbContext, title: "修复完成后的最新标题" } },
    actionKind: "develop_started",
    outcome: "success",
  });
  const usage3 = store.recordConfigInferenceUsage("project-a", {
    tab: actualTab,
    actionKind: "develop_started",
    outcome: "started",
  });
  assert.equal(usage1.ok, true);
  assert.equal(usage2.ok, true);
  assert.equal(usage3.ok, true);
  assert.equal(usage2.data.id, usage1.data.id);
  assert.equal(usage2.data.useCount, 1);
  assert.equal(usage2.data.execution.outcome, "success");
  assert.equal(usage2.data.rating, null);
  assert.equal(usage2.data.servingStatus, "pending");
  assert.equal(usage2.data.ticket.title, "修复完成后的最新标题");
  assert.equal(usage3.data.id, usage1.data.id);
  assert.equal(usage3.data.execution.outcome, "success", "迟到的 started 事件不能把成功状态降级");
  assert.equal(usage3.data.rating, null);
  assert.deepEqual(
    Object.fromEntries(CONFIG_INFERENCE_DIMENSIONS.map((dimension) => [
      dimension,
      usage1.data.observedConfig.targets[0][dimension],
    ])),
    {
      appName: "应用市场",
      vehicle: "阿维塔 8678",
      repositoryId: "web",
      branch: "release/web-avatr",
      flavor: "web8678",
    },
  );

  store.importTbTasks([
    { tbTaskId: "aaaaaaaaaaaaaaaaaaaaaaaa", title: "当前项目工单", projectId: "project-a" },
    { tbTaskId: "bbbbbbbbbbbbbbbbbbbbbbbb", title: "旧数据未带项目" },
    { tbTaskId: "cccccccccccccccccccccccc", title: "其他项目工单", projectId: "project-b" },
  ]);
  const overview = store.getConfigInferenceData("project-a");
  assert.equal(overview.metrics.runs, 3);
  assert.equal(overview.metrics.reviewed, 2);
  assert.equal(overview.metrics.learnedSamples, 1);
  assert.equal(overview.metrics.positiveSamples, 1);
  assert.equal(overview.metrics.negativeSamples, 0);
  assert.equal(overview.metrics.actualExecutionSamples, 1);
  assert.equal(overview.metrics.trainedTickets, 0);
  assert.equal(overview.taskPool.all, 2);
  assert.equal(overview.taskPool.staged, 2);

  const secondLocalWebPath = path.join(tmp, "local-web-checkout-b");
  fs.mkdirSync(path.join(secondLocalWebPath, ".git"), { recursive: true });
  fs.writeFileSync(path.join(secondLocalWebPath, ".git", "config"), '[remote "origin"]\n\turl = git@example.com:apps/web.git\n');
  fs.writeFileSync(path.join(secondLocalWebPath, ".git", "HEAD"), "ref: refs/heads/release/other\n");
  assert.equal(store.upsertProject({ id: "local-web-checkout-b", name: "本机 WebApp B", path: secondLocalWebPath }).ok, true);
  const localProjectsWithoutBinding = JSON.parse(fs.readFileSync(process.env.DEVBENCH_LOCAL_PROJECTS_PATH, "utf8"));
  localProjectsWithoutBinding.repositoryBindings = {};
  fs.writeFileSync(process.env.DEVBENCH_LOCAL_PROJECTS_PATH, JSON.stringify(localProjectsWithoutBinding, null, 2));
  const missingLocalSelection = store.reviewConfigInferenceRun("project-a", learned.data.id, {
    decision: "correct",
    rating: 5,
    reviewer: "integration-test",
  });
  assert.equal(missingLocalSelection.ok, false, "多份同仓本机源码时，后端不能把省略选择的请求静默降级为远程模式");
  assert.equal(missingLocalSelection.statusCode, 409);
  assert.equal(missingLocalSelection.localProjectSelectionRequired, true);
  const stateAfterMissingSelection = store.getConfigInferenceData("project-a");
  assert.equal(stateAfterMissingSelection.runs.find((run) => run.id === learned.data.id)?.review, null, "门禁失败不能先写入 review 再返回 409");
  assert.equal(stateAfterMissingSelection.samples.some((sample) => sample.sourceRunId === learned.data.id), false, "门禁失败不能创建学习样本");

  const confirmedLocal = store.reviewConfigInferenceRun("project-a", learned.data.id, {
    decision: "correct",
    rating: 5,
    reviewer: "integration-test",
    // 后端原始预测没有 targetId；前端表格会生成自己的稳定 ID，服务端应按
    // 仓库+分支安全关联，不能因此把“确认并继续”拒绝掉。
    localProjectBindings: [{
      targetId: "target_0",
      repositoryId: "web",
      branch: correctedTarget.branch,
      projectId: "local-web-checkout",
    }],
  });
  assert.equal(confirmedLocal.ok, true, confirmedLocal.error);
  assert.equal(confirmedLocal.snapshot.mode, "local");
  assert.equal(confirmedLocal.snapshot.primaryProjectId, "local-web-checkout");

  const localMarketPath = path.join(tmp, "local-market-checkout");
  fs.mkdirSync(path.join(localMarketPath, ".git"), { recursive: true });
  fs.writeFileSync(path.join(localMarketPath, ".git", "config"), '[remote "origin"]\n\turl = git@example.com:apps/market.git\n');
  fs.writeFileSync(path.join(localMarketPath, ".git", "HEAD"), "ref: refs/heads/develop\n");
  assert.equal(store.upsertProject({ id: "local-market-checkout", name: "本机应用市场", path: localMarketPath }).ok, true);
  const concreteMarket = { ...registry.targets.find((target) => target.repositoryId === "market"), targetId: "target_local_market" };
  const concreteWeb = { ...correctedTarget, targetId: "target_local_web_graph" };
  assert.ok(concreteMarket.repositoryId);

  const completeGraphRun = store.runConfigInference("project-a", {
    ticket: { ...ticket, ticketId: "CARB-CONFIG-COMPLETE-GRAPH" },
    captureSignals: false,
  });
  const completeGraphInput = {
    decision: "corrected",
    rating: 5,
    reviewer: "integration-test",
    correctedPrediction: { targets: [concreteMarket, concreteWeb] },
    // 故意把依赖绑定放在前面，快照仍必须按 targetRole 选择主工程。
    localProjectBindings: [
      { targetId: concreteWeb.targetId, repositoryId: concreteWeb.repositoryId, branch: concreteWeb.branch, projectId: "local-web-checkout" },
      { targetId: concreteMarket.targetId, repositoryId: concreteMarket.repositoryId, branch: concreteMarket.branch, projectId: "local-market-checkout" },
    ],
  };
  const completePreview = store.previewConfigInferenceReviewSnapshot("project-a", completeGraphRun.data.id, {
    ...completeGraphInput,
    apply: true,
  });
  assert.equal(completePreview.ok, true, completePreview.error);
  assert.equal(completePreview.snapshot.mode, "local");
  assert.equal(completePreview.snapshot.primaryProjectId, "local-market-checkout");
  assert.deepEqual(completePreview.snapshot.extraProjects, [{ path: localWebPath, name: "本机 WebApp" }]);
  assert.deepEqual(completePreview.snapshot.flavors, [
    { path: localMarketPath, flavor: concreteMarket.flavor },
    { path: localWebPath, flavor: concreteWeb.flavor },
  ]);
  const completeGraphReview = store.reviewConfigInferenceRun("project-a", completeGraphRun.data.id, completeGraphInput);
  assert.equal(completeGraphReview.ok, true, completeGraphReview.error);
  const { configInference: _previewMetadata, ...previewBusinessSnapshot } = completePreview.snapshot;
  assert.deepEqual(completeGraphReview.snapshot, previewBusinessSnapshot);
  const completeGraphRetry = store.reviewConfigInferenceRun("project-a", completeGraphRun.data.id, completeGraphInput);
  assert.equal(completeGraphRetry.ok, true, completeGraphRetry.error);
  assert.equal(completeGraphRetry.idempotent, true);
  assert.deepEqual(completeGraphRetry.snapshot, completeGraphReview.snapshot);

  const localMarketAlternativePath = path.join(tmp, "local-market-alternative");
  fs.mkdirSync(path.join(localMarketAlternativePath, ".git"), { recursive: true });
  fs.writeFileSync(path.join(localMarketAlternativePath, ".git", "config"), '[remote "origin"]\n\turl = git@example.com:apps/market.git\n');
  fs.writeFileSync(path.join(localMarketAlternativePath, ".git", "HEAD"), "ref: refs/heads/release/other\n");
  assert.equal(store.upsertProject({
    id: "local-market-alternative",
    name: "本机应用市场（备用）",
    path: localMarketAlternativePath,
  }).ok, true);
  const independentWebAppRun = store.runConfigInference("project-a", {
    ticket: { ...ticket, ticketId: "CARB-CONFIG-WEBAPP-INDEPENDENT" },
    captureSignals: false,
  });
  const localProjectsBeforeIndependentBinding = JSON.parse(fs.readFileSync(process.env.DEVBENCH_LOCAL_PROJECTS_PATH, "utf8"));
  localProjectsBeforeIndependentBinding.repositoryBindings = {};
  fs.writeFileSync(process.env.DEVBENCH_LOCAL_PROJECTS_PATH, JSON.stringify(localProjectsBeforeIndependentBinding, null, 2));
  const missingWebAppBinding = store.reviewConfigInferenceRun("project-a", independentWebAppRun.data.id, {
    decision: "corrected",
    rating: 5,
    correctedPrediction: { targets: [concreteMarket, concreteWeb] },
    localProjectBindings: [{
      targetId: concreteMarket.targetId,
      repositoryId: concreteMarket.repositoryId,
      branch: concreteMarket.branch,
      projectId: "local-market-alternative",
    }],
  });
  assert.equal(missingWebAppBinding.ok, false);
  assert.equal(missingWebAppBinding.statusCode, 409);
  assert.match(missingWebAppBinding.error, /WebApp.*选择本机工程/);
  const independentWebAppReview = store.reviewConfigInferenceRun("project-a", independentWebAppRun.data.id, {
    decision: "corrected",
    rating: 5,
    correctedPrediction: { targets: [concreteMarket, concreteWeb] },
    localProjectBindings: [
      {
        targetId: concreteMarket.targetId,
        repositoryId: concreteMarket.repositoryId,
        branch: concreteMarket.branch,
        projectId: "local-market-alternative",
      },
      {
        targetId: concreteWeb.targetId,
        repositoryId: concreteWeb.repositoryId,
        branch: concreteWeb.branch,
        projectId: "local-web-checkout",
      },
    ],
  });
  assert.equal(independentWebAppReview.ok, true, independentWebAppReview.error);
  assert.equal(independentWebAppReview.snapshot.mode, "local");
  assert.equal(independentWebAppReview.snapshot.primaryProjectId, "local-market-alternative");
  assert.deepEqual(independentWebAppReview.snapshot.extraProjects, [{ path: localWebPath, name: "本机 WebApp" }]);
  assert.equal(independentWebAppReview.localResolution.targets.find((target) => target.repositoryId === "web")?.matchKind, "user_selected");

  const symbolicWeb = {
    ...concreteWeb,
    branch: "WEB_BRANCH_ALIAS",
    fieldStates: { branch: { kind: "symbolic", feature: "WebApp 待确认分支" } },
  };
  const partialSymbolicRun = store.runConfigInference("project-a", {
    ticket: { ...ticket, ticketId: "CARB-CONFIG-PARTIAL-SYMBOLIC" },
    captureSignals: false,
  });
  const partialSymbolicInput = {
    decision: "corrected",
    rating: 5,
    reviewer: "integration-test",
    correctedPrediction: { targets: [concreteMarket, symbolicWeb] },
    localProjectBindings: [
      { targetId: concreteMarket.targetId, repositoryId: concreteMarket.repositoryId, branch: concreteMarket.branch, projectId: "local-market-alternative" },
      { targetId: symbolicWeb.targetId, repositoryId: symbolicWeb.repositoryId, branch: symbolicWeb.branch, projectId: "local-web-checkout" },
    ],
  };
  const partialSymbolicReview = store.reviewConfigInferenceRun("project-a", partialSymbolicRun.data.id, partialSymbolicInput);
  assert.equal(partialSymbolicReview.ok, true, partialSymbolicReview.error);
  assert.equal(partialSymbolicReview.snapshot, null, "任一目标仍含代号时不能只应用部分工程图");
  assert.equal(partialSymbolicReview.snapshotUnavailable?.code, "CONFIG_INFERENCE_SNAPSHOT_SYMBOLIC");
  const partialSymbolicRetry = store.reviewConfigInferenceRun("project-a", partialSymbolicRun.data.id, partialSymbolicInput);
  assert.equal(partialSymbolicRetry.ok, true, partialSymbolicRetry.error);
  assert.equal(partialSymbolicRetry.idempotent, true);
  assert.equal(partialSymbolicRetry.snapshot, null);
  assert.deepEqual(partialSymbolicRetry.snapshotUnavailable, partialSymbolicReview.snapshotUnavailable);

  const allSymbolicRun = store.runConfigInference("project-a", {
    ticket: { ...ticket, ticketId: "CARB-CONFIG-ALL-SYMBOLIC" },
    captureSignals: false,
  });
  const allSymbolicMarket = {
    ...concreteMarket,
    branch: "MARKET_BRANCH_ALIAS",
    flavor: "MARKET_FLAVOR_ALIAS",
    fieldStates: {
      branch: { kind: "symbolic", feature: "应用市场待确认分支" },
      flavor: { kind: "symbolic", feature: "应用市场待确认 Flavor" },
    },
  };
  const allSymbolicInput = {
    decision: "corrected",
    rating: 5,
    reviewer: "integration-test",
    correctedPrediction: { targets: [allSymbolicMarket] },
    localProjectBindings: [{
      targetId: allSymbolicMarket.targetId,
      repositoryId: allSymbolicMarket.repositoryId,
      branch: allSymbolicMarket.branch,
      projectId: "local-market-checkout",
    }],
  };
  const allSymbolicReview = store.reviewConfigInferenceRun("project-a", allSymbolicRun.data.id, allSymbolicInput);
  assert.equal(allSymbolicReview.ok, true, allSymbolicReview.error);
  assert.equal(allSymbolicReview.snapshot, null);
  assert.equal(allSymbolicReview.snapshotUnavailable?.code, "CONFIG_INFERENCE_SNAPSHOT_SYMBOLIC");
  const allSymbolicRetry = store.reviewConfigInferenceRun("project-a", allSymbolicRun.data.id, allSymbolicInput);
  assert.equal(allSymbolicRetry.ok, true, allSymbolicRetry.error);
  assert.equal(allSymbolicRetry.idempotent, true);
  assert.equal(allSymbolicRetry.snapshot, null);

  const remoteSample = {
    id: "remote-rag-memory",
    projectId: "project-a",
    source: "user_feedback",
    rating: 5,
    feedback: { decision: "correct", rating: 5 },
    signals: learned.data.prediction.signals,
    groundTruth: { targets: [correctedTarget] },
    updatedAt: Date.now(),
  };
  const otherProjectSample = { ...remoteSample, id: "other-project-rag-memory", projectId: "project-b" };
  const mergedBundle = store.applySharedBundle({
    syncScope: store.devbenchSyncScope(),
    version: store.getSharedVersion() + 1,
    projectDefs: PROJECT_DEFS,
    byProject: {
      "project-a": {
        aiTraining: { configInference: { runs: {}, samples: { [remoteSample.id]: remoteSample } } },
      },
      "project-b": {
        aiTraining: { configInference: { runs: {}, samples: { [otherProjectSample.id]: otherProjectSample } } },
      },
    },
  });
  assert.equal(mergedBundle.ok, true);
  assert.equal(mergedBundle.applied, true);
  const mergedIds = new Set(store.getConfigInferenceData("project-a").samples.map((sample) => sample.id));
  assert.equal(mergedIds.has(reviewed.sample.id), true);
  assert.equal(mergedIds.has(remoteSample.id), true);
  const projectRagIds = new Set(store.getConfigInferenceRagContext("project-a", ticket).memories.map((memory) => memory.id));
  assert.equal(projectRagIds.has(remoteSample.id), true);
  assert.equal(projectRagIds.has(otherProjectSample.id), false);

  const differentVehicle = store.recordConfigInferenceUsage("project-a", {
    tab: actualTab,
    actionKind: "develop_started",
    targets: [{ ...usage1.data.observedConfig.targets[0], vehicle: "另一车型" }],
  });
  assert.equal(differentVehicle.ok, true);
  assert.notEqual(differentVehicle.data.id, usage1.data.id);

  const toolingDef = store.upsertProjectDef({
    id: "aiEfficiency",
    name: "AIEfficiency",
    ssh: "git@example.com:tools/AIEfficiency.git",
    projectType: "tooling",
    inferenceEnabled: true,
    inferenceKeywords: ["AIEfficiency", "DevBench", "AI训练", "脚本工具"],
    defaultBranch: "feat/admin-rbac",
  });
  assert.equal(toolingDef.ok, true);
  const toolingTicket = { ticketId: "TOOLING-1", title: "DevBench AI训练脚本工具异常", projectName: "AIEfficiency" };
  const toolingUsage = store.recordConfigInferenceUsage("project-a", {
    tab: actualTab,
    actionKind: "develop_started",
    ticket: toolingTicket,
    targets: [{ repositoryId: "aiEfficiency", branch: "feat/admin-rbac" }],
  });
  assert.equal(toolingUsage.ok, true, toolingUsage.error);
  assert.deepEqual(
    toolingUsage.data.observedConfig.targets.map((target) => ({
      repositoryId: target.repositoryId,
      appName: target.appName,
      vehicle: target.vehicle,
      flavor: target.flavor,
      projectType: target.projectType,
      repositoryOnly: target.repositoryOnly,
    })),
    [{
      repositoryId: "aiEfficiency",
      appName: "",
      vehicle: "",
      flavor: "",
      projectType: "tooling",
      repositoryOnly: true,
    }],
  );
  const toolingRag = store.getConfigInferenceRagContext("project-a", toolingTicket);
  assert.deepEqual(toolingRag.inference.targets.map((target) => target.repositoryId), ["aiEfficiency"]);
  assert.equal(
    toolingRag.memories.some((memory) => memory.id === toolingUsage.data.id),
    false,
    "未 accepted+verified+approved 的真实执行 observation 不得进入 serving RAG",
  );
  for (const projectId of ["local-web-checkout", "local-web-checkout-b", "local-market-checkout", "local-market-with-webapp"]) {
    assert.equal(store.deleteProject(projectId).ok, true, `测试本机工程 ${projectId} 应在用例结束时清理`);
  }
});

test("共享整行原子合并不会让旧 Gateway 快照抹掉已保存 run 和 claim.runId", async () => {
  const store = await import("../services/devbench/store.js");
  const projectId = "project-a";
  const runA = { id: "run-from-latest-db", projectId, ticket: { ticketId: "ticket-a" }, review: null, createdAt: 100, updatedAt: 100 };
  const runB = { id: "run-from-stale-writer", projectId, ticket: { ticketId: "ticket-b" }, review: null, createdAt: 200, updatedAt: 200 };
  const claimB = { id: "ticket-b", tbTaskId: "ticket-b", sessionId: "session-b", runId: runB.id, expiresAt: Date.now() + 60_000, createdAt: 200, updatedAt: 200 };
  const opA = {
    id: "node-a:100:a",
    node: "node-a",
    version: 100,
    at: 100,
    type: "byProject.set",
    projectId,
    path: ["aiTraining", "configInference", "runs", runA.id],
    value: runA,
  };
  const opB = {
    id: "node-a:100:b",
    node: "node-a",
    version: 100,
    at: 200,
    type: "byProject.set",
    projectId,
    path: ["aiTraining", "configInference", "runs", runB.id],
    value: runB,
  };
  const claimOp = {
    id: "node-a:101:c",
    node: "node-a",
    version: 101,
    at: 201,
    type: "byProject.set",
    projectId,
    path: ["aiTraining", "configInference", "trainingClaims", claimB.id],
    value: claimB,
  };
  const current = {
    byProject: { [projectId]: { aiTraining: { configInference: { runs: { [runA.id]: runA } } } } },
    _sharedVersion: 100,
    sharedOps: [opA],
  };
  // candidate 模拟另一个 Gateway 早先读到的快照：它没有 runA，但刚生成 runB。
  const staleCandidate = {
    byProject: { [projectId]: { aiTraining: { configInference: { runs: { [runB.id]: runB }, trainingClaims: { [claimB.id]: claimB } } } } },
    _sharedVersion: 101,
    sharedOps: [opB, claimOp],
  };
  const merged = store.__testMergeSharedStoreWrite(current, staleCandidate, {
    rebaseLocalOps: true,
    localOpIds: [opB.id, claimOp.id],
    node: "node-a",
  });
  const root = merged.byProject[projectId].aiTraining.configInference;
  assert.ok(root.runs[runA.id], "数据库最新 run 必须保留");
  assert.ok(root.runs[runB.id], "旧调用方本次新增 run 也必须合入");
  assert.equal(root.trainingClaims[claimB.id].runId, runB.id);
  assert.ok(merged.sharedOps.some((op) => op.rebasedFrom === opB.id));
  assert.ok(merged.sharedOps.some((op) => op.rebasedFrom === claimOp.id));
});

test("依赖工程排在主工程前时排序不改变主工程身份和远程克隆角色", async () => {
  const store = await import("../services/devbench/store.js");
  const registryTargets = store.getConfigInferenceData("project-a").registry.targets;
  const primary = registryTargets.find((target) => target.repositoryId === "market");
  const dependency = registryTargets.find((target) => target.repositoryId === "web");
  assert.ok(primary);
  assert.ok(dependency);

  const duplicatePrimary = store.buildConfigInferenceSnapshot("project-a", [
    { ...primary, order: 1, targetRole: "primary" },
    {
      ...dependency,
      appName: "",
      vehicle: "",
      projectType: "sdk",
      repositoryOnly: true,
      order: 2,
      targetRole: "primary",
    },
  ], {
    ticketId: "ROLE-ORDER-DUPLICATE-PRIMARY",
    sourceTitle: "应用与 SDK 不能同时成为主工程",
  });
  assert.equal(duplicatePrimary.ok, false);
  assert.match(duplicatePrimary.error, /只能有一个应用主工程|主工程/);

  const reorderedTargets = [
    { ...dependency, order: 1, targetRole: "dependency" },
    { ...primary, order: 2, targetRole: "primary" },
  ];
  const built = store.buildConfigInferenceSnapshot("project-a", reorderedTargets, {
    ticketId: "ROLE-ORDER-1",
    sourceTitle: "排序与主工程身份独立",
    localProjectBindings: reorderedTargets.map((target) => ({
      targetId: target.targetId,
      repositoryId: target.repositoryId,
      branch: target.branch,
      useRemote: true,
    })),
  });
  assert.equal(built.ok, true, built.error);
  assert.equal(built.snapshot.mode, "remote");
  assert.equal(built.snapshot.projectDefId, "market");
  assert.equal(built.summary.projectName, primary.repositoryName || primary.repositoryId);
  assert.equal(built.summary.branch, primary.branch || "");
  assert.equal(built.summary.flavor, primary.flavor || "");
  assert.deepEqual(built.summary.extras, [dependency.repositoryName || dependency.repositoryId]);
  assert.deepEqual(
    built.snapshot.remotePull.entries.map((entry) => [entry.projectId, entry.targetRole]),
    [["web", "dependency"], ["market", "primary"]],
  );

  const actual = store.getTabConfigInferenceActual({
    id: "role-order-tab",
    mode: "remote",
    tbContext: { projectId: "project-a" },
    remotePull: {
      vehicle: "阿维塔 8678",
      entries: built.snapshot.remotePull.entries,
    },
  }, "project-a");
  assert.equal(actual.primaryProjectId, "market");

  const { assignRemotePullRoles, localizeCompletedRemoteTab } = await import("../services/devbench/clone.js");
  assert.deepEqual(assignRemotePullRoles(built.snapshot.remotePull.entries), ["extra", "primary"]);
  assert.deepEqual(assignRemotePullRoles([
    { projectId: "webApp" },
    { projectId: "market" },
  ]), ["webapp", "primary"], "旧版无角色条目仍保留兼容回退");
  assert.deepEqual(assignRemotePullRoles([
    { projectId: "webApp", targetRole: "primary" },
    { projectId: "market", targetRole: "dependency" },
  ]), ["primary", "extra"], "显式 WebApp 主工程不能被固定降级为 webapp");
  const standaloneEntries = [{ projectId: "aiEfficiency", targetRole: "standalone", repositoryOnly: true }];
  assert.deepEqual(assignRemotePullRoles(standaloneEntries), ["primary"], "无应用工程的 standalone 必须成为远程执行主工程");
  const standaloneCheckout = fs.mkdtempSync(path.join(os.tmpdir(), "config-inference-standalone-localize-"));
  try {
    const localized = localizeCompletedRemoteTab({ id: "standalone-tab", mode: "remote" }, [{
      key: "aiEfficiency",
      name: "AIEfficiency",
      path: standaloneCheckout,
      role: assignRemotePullRoles(standaloneEntries)[0],
      targetRole: "standalone",
      repositoryOnly: true,
      ok: true,
    }], { force: true });
    assert.equal(localized.mode, "local");
    assert.ok(localized.primaryProjectId);
    assert.equal(localized.apkSourcePath, standaloneCheckout);
  } finally {
    fs.rmSync(standaloneCheckout, { recursive: true, force: true });
  }
});

test("同一会话的新 run claim 阻止旧恢复，删除也拒绝覆盖并发更新", async () => {
  const store = await import("../services/devbench/store.js");
  const claim = {
    id: "RECOVERY-CLAIM-TICKET",
    tbTaskId: "RECOVERY-CLAIM-TICKET",
    sessionId: "same-session",
    runId: "newer-run",
    expiresAt: Date.now() + 60_000,
  };
  assert.match(
    store.__testGuardConfigInferenceRecoveryClaim(claim, "same-session", "older-run"),
    /另一条有效推理记录/,
  );
  assert.equal(store.__testGuardConfigInferenceRecoveryClaim(claim, "same-session", "newer-run"), true);
  assert.match(
    store.__testGuardConfigInferenceRecoveryClaim(claim, "other-session", "newer-run"),
    /其它会话/,
  );
  const originalRun = { id: "delete-race-run", predictionRevision: 0, review: null, updatedAt: 1 };
  assert.equal(store.__testGuardConfigInferenceRunDelete(structuredClone(originalRun), originalRun), true);
  assert.match(
    store.__testGuardConfigInferenceRunDelete({ ...originalRun, review: { decision: "correct" }, updatedAt: 2 }, originalRun),
    /其它请求更新/,
  );
  assert.match(store.__testGuardConfigInferenceRunDelete(null, originalRun), /不存在/);
});

test("孤儿随机 run 只可凭服务端审计上下文重算，评分学习幂等且删除后禁止复活", async () => {
  const store = await import("../services/devbench/store.js");
  const projectId = "project-a";
  const ticket = completeTbTicket({
    ticketId: "ORPHAN-RUN-TICKET",
    tbTaskId: "ORPHAN-RUN-TICKET",
    title: "应用市场启动失败",
    projectName: "平台组件",
    tasklistName: "应用市场",
  });
  const preview = store.runConfigInference(projectId, { ticket, captureSignals: false });
  assert.equal(preview.ok, true);
  const claim = store.claimConfigInferenceTrainingTicket(projectId, ticket.tbTaskId, "orphan-session");
  assert.equal(claim.ok, true, claim.error);

  const missingId = "CI_ORPHAN_RECOVERY";
  const rejected = store.recoverConfigInferenceRun(projectId, missingId, {
    ticket,
    trainingSessionId: "orphan-session",
    expectedPrediction: preview.data.prediction,
    verifiedRandomDraw: false,
    verifiedTicketId: ticket.tbTaskId,
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.statusCode, 403);

  const recovered = store.recoverConfigInferenceRun(projectId, missingId, {
    ticket,
    trainingSessionId: "orphan-session",
    expectedPrediction: preview.data.prediction,
    verifiedRandomDraw: true,
    verifiedTicketId: ticket.tbTaskId,
    verifiedAuditAt: Date.now(),
  });
  assert.equal(recovered.ok, true, recovered.error);
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.predictionMatches, true);
  assert.equal(store.getConfigInferenceData(projectId).samples.some((sample) => sample.sourceRunId === missingId), false, "恢复阶段不得提前学习");

  const stalePrediction = { ...preview.data.prediction, targets: [] };
  const concurrentOldRecovery = store.recoverConfigInferenceRun(projectId, missingId, {
    ticket,
    trainingSessionId: "orphan-session",
    expectedPrediction: stalePrediction,
    verifiedRandomDraw: true,
    verifiedTicketId: ticket.tbTaskId,
  });
  assert.equal(concurrentOldRecovery.ok, true);
  assert.equal(concurrentOldRecovery.idempotent, true);
  assert.equal(concurrentOldRecovery.predictionMatches, false, "并发旧请求不得把已恢复的新预测伪装成一致");
  const blockedOldReview = store.reviewConfigInferenceRun(projectId, missingId, {
    decision: "correct",
    rating: 5,
    reviewer: "stale-recovery-test",
    recovery: { expectedPrediction: stalePrediction },
  });
  assert.equal(blockedOldReview.ok, false);
  assert.equal(blockedOldReview.statusCode, 409);
  assert.equal(blockedOldReview.stale, true);
  assert.equal(store.getConfigInferenceData(projectId).runs.find((run) => run.id === missingId)?.review, null);
  assert.equal(store.getConfigInferenceData(projectId).samples.some((sample) => sample.sourceRunId === missingId), false, "旧页面并发重试不得学习变化后的预测");

  const reviewInput = {
    decision: "correct",
    rating: 5,
    reviewer: "recovery-test",
    recovery: { expectedPrediction: recovered.data.prediction },
  };
  const reviewed = store.reviewConfigInferenceRun(projectId, missingId, reviewInput);
  assert.equal(reviewed.ok, true, reviewed.error);
  approveReviewedAnnotation(store, projectId, reviewed, "orphan-recovery");
  assert.equal(reviewed.trainedTicket.sourceRunId, missingId);
  assert.equal(store.getConfigInferenceData(projectId).trainingClaims.some((item) => item.id === ticket.tbTaskId), false);
  const retry = store.reviewConfigInferenceRun(projectId, missingId, reviewInput);
  assert.equal(retry.ok, true);
  assert.equal(retry.idempotent, true);
  assert.equal(retry.sample.id, reviewed.sample.id);

  assert.equal(store.deleteConfigInferenceRun(projectId, missingId).ok, true);
  const resurrect = store.recoverConfigInferenceRun(projectId, missingId, {
    ticket,
    trainingSessionId: "orphan-session",
    expectedPrediction: preview.data.prediction,
    verifiedRandomDraw: true,
    verifiedTicketId: ticket.tbTaskId,
  });
  assert.equal(resurrect.ok, false);
  assert.equal(resurrect.statusCode, 410);
});

test("同一 TB 单完成随机训练后，普通故事点复核仍保存反馈且不覆盖训练标记", async () => {
  const store = await import("../services/devbench/store.js");
  const projectId = "project-a";
  const ticket = completeTbTicket({
    ticketId: "TRAINED-THEN-STORY-TICKET",
    tbTaskId: "TRAINED-THEN-STORY-TICKET",
    title: "应用市场启动失败",
    projectName: "平台组件",
    tasklistName: "应用市场",
  });
  const trainingSessionId = "trained-then-story-session";
  const claim = store.claimConfigInferenceTrainingTicket(projectId, ticket.tbTaskId, trainingSessionId);
  assert.equal(claim.ok, true, claim.error);

  const trainingRun = store.runConfigInference(projectId, {
    ticket,
    trigger: "training_random",
    trainingSessionId,
    trainingClaimRequired: true,
    captureSignals: false,
  });
  assert.equal(trainingRun.ok, true, trainingRun.error);
  const trainingReview = store.reviewConfigInferenceRun(projectId, trainingRun.data.id, {
    decision: "correct",
    rating: 5,
    reviewer: "random-training-reviewer",
  });
  assert.equal(trainingReview.ok, true, trainingReview.error);
  approveReviewedAnnotation(store, projectId, trainingReview, "trained-then-story-training");
  assert.equal(trainingReview.trainedTicket.sourceRunId, trainingRun.data.id);

  const storyRun = store.runConfigInference(projectId, {
    ticket,
    trigger: "story_reopened",
    tabId: "trained-then-story-tab",
    captureSignals: false,
  });
  assert.equal(storyRun.ok, true, storyRun.error);
  const localProjectBindings = (storyRun.data.localResolution?.targets || [])
    .filter((target) => target.selectionRequired !== false)
    .map((target) => ({
      targetId: target.targetId,
      repositoryId: target.repositoryId,
      branch: target.branch,
      useRemote: true,
    }));
  const storyReviewInput = {
    decision: "correct",
    rating: 4,
    reviewer: "story-reviewer",
    reason: "真实故事点再次确认",
    localProjectBindings,
  };
  const storyReview = store.reviewConfigInferenceRun(projectId, storyRun.data.id, storyReviewInput);
  assert.equal(storyReview.ok, true, storyReview.error);
  approveReviewedAnnotation(store, projectId, storyReview, "trained-then-story-story");
  assert.equal(storyReview.reviewPersisted, true);
  assert.equal(storyReview.sample.source, "user_feedback");
  assert.equal(storyReview.sample.sourceRunId, storyRun.data.id);

  const overview = store.getConfigInferenceData(projectId);
  assert.equal(overview.trainedTickets.find((row) => row.id === ticket.tbTaskId)?.sourceRunId, trainingRun.data.id);
  assert.equal(overview.runs.find((row) => row.id === storyRun.data.id)?.review?.rating, 4);
  assert.equal(overview.samples.filter((sample) => sample.sourceRunId === storyRun.data.id).length, 1);

  const retry = store.reviewConfigInferenceRun(projectId, storyRun.data.id, storyReviewInput);
  assert.equal(retry.ok, true, retry.error);
  assert.equal(retry.idempotent, true);
  assert.equal(retry.sample.sourceRunId, storyRun.data.id);
});

test("配置推理拒绝原型污染项目 ID 且不修改 Object.prototype", async () => {
  const store = await import("../services/devbench/store.js");
  assert.equal(Object.hasOwn(Object.prototype, "aiTraining"), false);

  const result = store.runConfigInference("__proto__", {
    captureSignals: false,
    ticket: { ticketId: "PROTO-POLLUTION", title: "不应创建项目桶" },
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /必须指定 TB 项目|项目 ID 不合法/);
  assert.equal(Object.hasOwn(Object.prototype, "aiTraining"), false);
});

test("刷新、评分、代号替换和删除均在读取前拒绝危险 runId", async () => {
  const store = await import("../services/devbench/store.js");
  const before = Object.getOwnPropertyNames(Object.prototype).sort();
  for (const runId of ["__proto__", "prototype", "constructor"]) {
    const results = [
      store.refreshConfigInferenceRun("project-a", runId, { force: true }),
      store.reviewConfigInferenceRun("project-a", runId, { decision: "correct", rating: 5 }),
      store.resolveConfigInferenceSymbols("project-a", runId, { correctedPrediction: { targets: [] } }),
      store.deleteConfigInferenceRun("project-a", runId),
    ];
    for (const result of results) {
      assert.equal(result.ok, false);
      assert.equal(result.statusCode, 400);
      assert.match(result.error, /runId/);
    }
  }
  assert.deepEqual(Object.getOwnPropertyNames(Object.prototype).sort(), before);
  assert.equal(Object.hasOwn(Object.prototype, "prediction"), false);
  assert.equal(Object.hasOwn(Object.prototype, "review"), false);
});

test("人工修正的六字段目标写入 SQLite 共享配置并保持顺序、幂等和失败原子性", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "config-inference-target-writeback-"));
  const port = 24000 + Math.floor(Math.random() * 1000);
  const gwCfg = path.join(tmp, "gateway.json");
  const market = path.join(tmp, "market.json");
  const storeDir = path.join(tmp, "store");
  const dbPath = path.join(tmp, "data.db");
  const totpDir = path.join(tmp, "secrets");
  const projectId = "project-config-writeback";
  const projectDefs = [
    ...PROJECT_DEFS,
    {
      id: "appMarketSdk",
      name: "应用市场SDK",
      https: "https://git.example.com/team/app-market-sdk.git",
      customRepositoryMetadata: { owner: "sdk-owner", module: "voice-sdk" },
      releasePolicy: { channel: "sdk-stable", requireSignedArtifact: true },
    },
    {
      id: "same-name-a",
      name: "同名仓库",
      https: "https://git.example.com/team/same-name-a.git",
      customRepositoryMetadata: {
        owner: "existing-repository-owner",
        compliance: { securityReview: true, tier: "critical" },
      },
      releasePolicy: {
        channel: "stable",
        requireSignedArtifact: true,
      },
    },
    {
      id: "same-name-b",
      name: "同名仓库",
      https: "https://git.example.com/team/same-name-b.git",
      customRepositoryMetadata: { owner: "touched-repository-owner", tier: "important" },
    },
  ];
  const preservedVehicleMap = {
    customVehicle: {
      aliases: ["自定义车型", "CV"],
      displayName: "自定义车型显示名",
      prodReleaseDir: "\\\\server\\release\\customVehicle",
      needsResign: true,
      apps: [{
        appName: "自定义语音应用",
        customAppExtension: { appKey: "voice-app-key", owner: "voice-team" },
        repos: [{
          repoId: "market",
          branch: "release/preserved-market",
          flavor: "preservedMarketFlavor",
          customRepoExtension: { checkoutHint: "保留已有仓库扩展", priority: 9 },
        }],
      }],
    },
    untouchedVehicle: {
      aliases: ["未编辑车型", "UV"],
      displayName: "未编辑车型显示名",
      prodReleaseDir: "D:\\release\\untouchedVehicle",
      needsResign: true,
      apps: [{
        appName: "未编辑应用",
        customAppExtension: { appKey: "untouched-app-key", owner: "untouched-team" },
        repos: [{
          repoId: "web",
          branch: "release/untouched-web",
          flavor: "untouchedWebFlavor",
          customRepoExtension: { checkoutHint: "未编辑仓库扩展", priority: 7 },
        }],
      }],
    },
  };
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(gwCfg, JSON.stringify({
    servers: { nodeId: "config-inference-target-writeback-test" },
    teambition: { projects: [{ id: projectId, name: "配置写回项目" }] },
  }), "utf8");
  fs.writeFileSync(market, JSON.stringify({
    projectDefs,
    byProject: {
      [projectId]: {
        vehicleMap: preservedVehicleMap,
        keywordMappings: {
          title: { "启动失败": { category: "app", value: "应用市场" } },
        },
      },
    },
  }), "utf8");
  const marketSeedText = fs.readFileSync(market, "utf8");
  fs.writeFileSync(path.join(storeDir, "tasks.json"), "[]", "utf8");
  const nonAdminToken = "config-writeback-viewer-token";
  const authDb = new Database(dbPath);
  authDb.exec("CREATE TABLE IF NOT EXISTS admin_tokens (token TEXT PRIMARY KEY, data TEXT, exp INTEGER)");
  authDb.prepare("INSERT INTO admin_tokens (token, data, exp) VALUES (?, ?, ?)")
    .run(
      nonAdminToken,
      JSON.stringify({
        role: "viewer",
        name: "配置写回只读用户",
        dingUserid: "config-writeback-viewer",
      }),
      Date.now() + 600000,
    );
  authDb.close();

  const child = bootGateway({ port, gwCfg, market, storeDir, dbPath, totpDir });
  const request = async (method, pathname, body, token = "") => {
    const response = await fetch(`http://127.0.0.1:${port}/api/devbench${pathname}`, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  let adminToken = "";
  const startRun = (ticketId) => request("POST", "/ai-training/config-inference/run", {
    projectId,
    captureSignals: false,
    ticket: {
      ticketId,
      title: "应用市场启动失败",
      projectId,
      projectName: "配置写回项目",
      tasklistName: "应用市场",
    },
  }, adminToken);

  try {
    await waitHealth(port, child);
    const setup = await fetch(`http://127.0.0.1:${port}/api/admin/auth/totp/setup`).then((response) => response.json());
    const secret = setup.data?.secret || setup.secret;
    assert.ok(secret, "未拿到隔离 TOTP 密钥");
    const login = await fetch(`http://127.0.0.1:${port}/api/admin/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: totp(secret) }),
    }).then((response) => response.json());
    assert.ok(login.ok && login.token, "TOTP 登录失败");
    adminToken = login.token;

    const crossVehicleRun = await startRun("CONFIG-CROSS-VEHICLE-DEPENDENCY");
    assert.equal(crossVehicleRun.status, 200);
    const crossVehicleReview = await request(
      "POST",
      `/ai-training/config-inference/runs/${crossVehicleRun.body.data.id}/review`,
      {
        projectId,
        decision: "corrected",
        rating: 1,
        correctedPrediction: {
          targets: [
            {
              appName: "自定义语音应用",
              vehicle: "customVehicle",
              repositoryId: "market",
              branch: "release/preserved-market",
              flavor: "preservedMarketFlavor",
              targetRole: "primary",
              order: 1,
            },
            {
              appName: "未编辑应用",
              vehicle: "untouchedVehicle",
              repositoryId: "web",
              branch: "release/untouched-web",
              flavor: "untouchedWebFlavor",
              targetRole: "dependency",
              order: 2,
            },
          ],
        },
      },
      adminToken,
    );
    assert.equal(crossVehicleReview.status, 400);
    assert.match(crossVehicleReview.body.error, /同一车型和应用|跨车型候选/);

    const correctedTargets = [
      {
        appName: "自定义语音应用",
        vehicle: "customVehicle",
        repositoryId: "custom-app",
        repositoryName: "自定义应用仓库",
        gitUrl: "https://git.example.com/team/custom-app.git",
        branch: "feature/custom-app",
        flavor: "customAppFlavor",
        order: 2,
      },
      {
        appName: "自定义语音应用",
        vehicle: "customVehicle",
        repositoryId: "web",
        repositoryName: "WebApp",
        gitUrl: "https://example.com/apps/web.git",
        branch: "feature/custom-web",
        flavor: "customWebFlavor",
        order: 1,
      },
      {
        appName: "自定义语音应用",
        vehicle: "customVehicle",
        repositoryId: "same-name-b",
        repositoryName: "同名仓库",
        gitUrl: "https://git.example.com/team/same-name-b.git",
        branch: "feature/same-name-b",
        flavor: "sameNameBFlavor",
        order: 3,
      },
    ];
    const reviewBody = {
      projectId,
      decision: "corrected",
      rating: 5,
      persistConfig: true,
      correctedPrediction: { targets: correctedTargets },
    };
    const unauthorizedRun = await startRun("CONFIG-WRITEBACK-UNAUTHORIZED");
    assert.equal(unauthorizedRun.status, 200);
    assert.equal(unauthorizedRun.body.ok, true);
    const anonymousOverview = await request("GET", `/ai-training/config-inference?projectId=${projectId}`);
    assert.equal(anonymousOverview.status, 401, "legacy 读取也必须保留匿名越权反例");
    const beforeUnauthorized = await request(
      "GET",
      `/ai-training/config-inference?projectId=${projectId}`,
      undefined,
      adminToken,
    );
    const configBeforeUnauthorized = fs.readFileSync(market, "utf8");
    const unauthorized = await request(
      "POST",
      `/ai-training/config-inference/runs/${unauthorizedRun.body.data.id}/review`,
      reviewBody,
      nonAdminToken,
    );
    assert.equal(unauthorized.status, 403);
    assert.equal(unauthorized.body.ok, false);
    assert.match(unauthorized.body.error, /仅管理员可提交/);
    const afterUnauthorized = await request(
      "GET",
      `/ai-training/config-inference?projectId=${projectId}`,
      undefined,
      adminToken,
    );
    assert.equal(fs.readFileSync(market, "utf8"), configBeforeUnauthorized);
    assert.deepEqual(afterUnauthorized.body.data.registry.projectDefs, beforeUnauthorized.body.data.registry.projectDefs);
    assert.deepEqual(afterUnauthorized.body.data.registry.vehicleMap, beforeUnauthorized.body.data.registry.vehicleMap);
    assert.deepEqual(afterUnauthorized.body.data.options, beforeUnauthorized.body.data.options);
    assert.deepEqual(
      afterUnauthorized.body.data.samples.map((sample) => sample.id),
      beforeUnauthorized.body.data.samples.map((sample) => sample.id),
    );
    assert.equal(afterUnauthorized.body.data.metrics.reviewed, beforeUnauthorized.body.data.metrics.reviewed);
    assert.equal(
      afterUnauthorized.body.data.runs.find((item) => item.id === unauthorizedRun.body.data.id)?.review,
      null,
    );

    const run = await startRun("CONFIG-WRITEBACK-SUCCESS");
    assert.equal(run.status, 200);
    assert.equal(run.body.ok, true);
    const reviewed = await request(
      "POST",
      `/ai-training/config-inference/runs/${run.body.data.id}/review`,
      reviewBody,
      adminToken,
    );
    assert.equal(reviewed.status, 200, reviewed.body.error);
    assert.equal(reviewed.body.ok, true);
    assert.equal(reviewed.body.configurationUpdates.changed, true);
    assert.deepEqual(reviewed.body.sample.groundTruth.targets.map((target) => target.repositoryId), ["web", "custom-app", "same-name-b"]);
    assert.deepEqual(reviewed.body.sample.groundTruth.targets.map((target) => target.order), [1, 2, 3]);
    assert.deepEqual(reviewed.body.sample.groundTruth.targets.map((target) => target.targetRole), ["primary", "dependency", "dependency"]);

    const overview = await request("GET", `/ai-training/config-inference?projectId=${projectId}`, undefined, adminToken);
    assert.equal(overview.status, 200);
    assert.equal(overview.body.ok, true);
    const { registry, options, samples } = overview.body.data;
    const customDef = registry.projectDefs.find((def) => def.id === "custom-app");
    assert.ok(customDef);
    assert.equal(customDef.name, "自定义应用仓库");
    assert.equal(customDef.https, "https://git.example.com/team/custom-app.git");
    assert.equal(customDef.ssh, "git@git.example.com:team/custom-app.git");
    assert.deepEqual(customDef.branchOptions, ["feature/custom-app"]);
    assert.deepEqual(customDef.flavorOptions, ["customAppFlavor"]);
    const webDef = registry.projectDefs.find((def) => def.id === "web");
    assert.ok(webDef.branchOptions.includes("feature/custom-web"));
    assert.ok(webDef.flavorOptions.includes("customWebFlavor"));
    const sameNameA = registry.projectDefs.find((def) => def.id === "same-name-a");
    const sameNameB = registry.projectDefs.find((def) => def.id === "same-name-b");
    assert.equal(sameNameA.https, "https://git.example.com/team/same-name-a.git");
    assert.equal(sameNameB.https, "https://git.example.com/team/same-name-b.git");
    assert.equal((sameNameA.branchOptions || []).includes("feature/same-name-b"), false);
    assert.equal((sameNameA.flavorOptions || []).includes("sameNameBFlavor"), false);
    assert.ok(sameNameB.branchOptions.includes("feature/same-name-b"));
    assert.ok(sameNameB.flavorOptions.includes("sameNameBFlavor"));
    const customMapping = registry.vehicleMap.customVehicle;
    assert.ok(customMapping);
    assert.deepEqual(customMapping.aliases, ["自定义车型", "CV"]);
    assert.equal(customMapping.displayName, "自定义车型显示名");
    assert.equal(customMapping.prodReleaseDir, "\\\\server\\release\\customVehicle");
    assert.equal(customMapping.needsResign, true);
    const customApp = customMapping.apps.find((app) => app.appName === "自定义语音应用");
    assert.ok(customApp);
    assert.deepEqual(customApp.customAppExtension, { appKey: "voice-app-key", owner: "voice-team" });
    assert.deepEqual(customApp.repos, [
      { repoId: "web", branch: "feature/custom-web", flavor: "customWebFlavor", targetRole: "primary", order: 1 },
      { repoId: "custom-app", branch: "feature/custom-app", flavor: "customAppFlavor", targetRole: "dependency", order: 2 },
      { repoId: "same-name-b", branch: "feature/same-name-b", flavor: "sameNameBFlavor", targetRole: "dependency", order: 3 },
      {
        repoId: "market",
        branch: "release/preserved-market",
        flavor: "preservedMarketFlavor",
        customRepoExtension: { checkoutHint: "保留已有仓库扩展", priority: 9 },
      },
    ]);
    const untouchedMapping = registry.vehicleMap.untouchedVehicle;
    assert.deepEqual(untouchedMapping.aliases, ["未编辑车型", "UV"]);
    assert.equal(untouchedMapping.displayName, "未编辑车型显示名");
    assert.equal(untouchedMapping.prodReleaseDir, "D:\\release\\untouchedVehicle");
    assert.equal(untouchedMapping.needsResign, true);
    const untouchedApp = untouchedMapping.apps.find((app) => app.appName === "未编辑应用");
    assert.deepEqual(untouchedApp.customAppExtension, { appKey: "untouched-app-key", owner: "untouched-team" });
    assert.deepEqual(untouchedApp.repos, [{
      repoId: "web",
      branch: "release/untouched-web",
      flavor: "untouchedWebFlavor",
      customRepoExtension: { checkoutHint: "未编辑仓库扩展", priority: 7 },
    }]);
    assert.ok(options.apps.includes("自定义语音应用"));
    assert.ok(options.vehicles.includes("customVehicle"));
    assert.ok(options.repositories.some((option) => option.id === "custom-app"));
    assert.ok(options.branches.some((option) => option.repositoryId === "custom-app" && option.branch === "feature/custom-app"));
    assert.ok(options.branches.some((option) => option.repositoryId === "web" && option.branch === "feature/custom-web"));
    assert.ok(options.branches.some((option) => option.repositoryId === "same-name-b" && option.branch === "feature/same-name-b"));
    assert.ok(options.flavors.some((option) => option.repositoryId === "custom-app" && option.flavor === "customAppFlavor"));
    assert.ok(options.flavors.some((option) => option.repositoryId === "web" && option.flavor === "customWebFlavor"));
    assert.ok(options.flavors.some((option) => option.repositoryId === "same-name-b" && option.flavor === "sameNameBFlavor"));
    assert.deepEqual(
      samples.find((sample) => sample.sourceRunId === run.body.data.id)?.groundTruth?.targets.map((target) => target.repositoryId),
      ["web", "custom-app", "same-name-b"],
    );

    assert.equal(fs.readFileSync(market, "utf8"), marketSeedText, "人工纠正写回必须只更新 SQLite 共享态");
    const seedPreservedDef = projectDefs.find((def) => def.id === "same-name-a");
    assert.deepEqual(seedPreservedDef.customRepositoryMetadata, {
      owner: "existing-repository-owner",
      compliance: { securityReview: true, tier: "critical" },
    });
    assert.deepEqual(seedPreservedDef.releasePolicy, {
      channel: "stable",
      requireSignedArtifact: true,
    });
    const sharedBundle = await fetch(`http://127.0.0.1:${port}/api/discovery/shared-bundle`).then((response) => response.json());
    assert.equal(sharedBundle.ok, true);
    assert.ok(sharedBundle.data.projectDefs.some((def) => def.id === "custom-app"));
    const sharedPreservedDef = sharedBundle.data.projectDefs.find((def) => def.id === "same-name-a");
    assert.deepEqual(sharedPreservedDef.customRepositoryMetadata, seedPreservedDef.customRepositoryMetadata);
    assert.deepEqual(sharedPreservedDef.releasePolicy, seedPreservedDef.releasePolicy);
    const sharedTouchedDef = sharedBundle.data.projectDefs.find((def) => def.id === "same-name-b");
    assert.deepEqual(sharedTouchedDef.customRepositoryMetadata, { owner: "touched-repository-owner", tier: "important" });
    const sharedSdkDef = sharedBundle.data.projectDefs.find((def) => def.id === "appMarketSdk");
    assert.deepEqual(sharedSdkDef.customRepositoryMetadata, { owner: "sdk-owner", module: "voice-sdk" });
    assert.deepEqual(sharedSdkDef.releasePolicy, { channel: "sdk-stable", requireSignedArtifact: true });

    const repeated = await request(
      "POST",
      `/ai-training/config-inference/runs/${run.body.data.id}/review`,
      reviewBody,
      adminToken,
    );
    assert.equal(repeated.status, 200, repeated.body.error);
    assert.equal(repeated.body.ok, true);
    assert.equal(repeated.body.idempotent, true);
    assert.equal(repeated.body.sample.id, reviewed.body.sample.id);
    assert.equal(fs.readFileSync(market, "utf8"), marketSeedText, "幂等重放也不得改写只读启动种子");
    const afterRepeated = await request("GET", `/ai-training/config-inference?projectId=${projectId}`, undefined, adminToken);
    assert.equal(afterRepeated.body.data.samples.filter((sample) => sample.sourceRunId === run.body.data.id).length, 1);
    assert.equal(afterRepeated.body.data.registry.projectDefs.filter((def) => def.id === "custom-app").length, 1);
    assert.deepEqual(
      afterRepeated.body.data.registry.vehicleMap.customVehicle.apps
        .find((app) => app.appName === "自定义语音应用").repos,
      customApp.repos,
    );

    const sdkRun = await startRun("CONFIG-WRITEBACK-REPOSITORY-ONLY-SDK");
    assert.equal(sdkRun.status, 200);
    assert.equal(sdkRun.body.ok, true);
    const sdkReviewed = await request(
      "POST",
      `/ai-training/config-inference/runs/${sdkRun.body.data.id}/review`,
      {
        projectId,
        decision: "corrected",
        rating: 5,
        persistConfig: true,
        correctedPrediction: {
          targets: [
            {
              appName: "",
              vehicle: "",
              repositoryId: "voice-sdk-custom",
              repositoryName: "自定义语音 SDK",
              gitUrl: "https://git.example.com/team/voice-sdk-custom.git",
              branch: "feature/voice-sdk",
              flavor: "",
              projectType: "sdk",
              repositoryOnly: true,
              targetRole: "dependency",
              order: 1,
            },
            {
              appName: "自定义语音应用",
              vehicle: "customVehicle",
              repositoryId: "web",
              repositoryName: "WebApp",
              gitUrl: "https://example.com/apps/web.git",
              branch: "feature/custom-web",
              flavor: "customWebFlavor",
              targetRole: "primary",
              order: 2,
            },
          ],
        },
      },
      adminToken,
    );
    assert.equal(sdkReviewed.status, 200, sdkReviewed.body.error);
    assert.equal(sdkReviewed.body.ok, true);
    const sdkGroundTruth = sdkReviewed.body.sample.groundTruth.targets.find((target) => target.repositoryId === "voice-sdk-custom");
    assert.equal(sdkGroundTruth.order, 1);
    assert.equal(sdkGroundTruth.targetRole, "dependency");
    assert.equal(sdkGroundTruth.repositoryOnly, true);

    const afterSdk = await request("GET", `/ai-training/config-inference?projectId=${projectId}`, undefined, adminToken);
    const sdkDef = afterSdk.body.data.registry.projectDefs.find((def) => def.id === "voice-sdk-custom");
    assert.equal(sdkDef.inferenceOrder, 1);
    assert.equal(sdkDef.inferenceRole, "dependency");
    assert.ok(sdkDef.requiresRepositories.includes("web"));
    const sdkRegistryTarget = afterSdk.body.data.registry.targets.find((target) => target.repositoryId === "voice-sdk-custom");
    assert.equal(sdkRegistryTarget.order, 1);
    assert.equal(sdkRegistryTarget.targetRole, "dependency");
    assert.equal(sdkRegistryTarget.repositoryOnly, true);
    const persistedPrimaryTarget = afterSdk.body.data.registry.targets.find((target) => (
      target.repositoryId === "web"
      && target.vehicle === "customVehicle"
      && target.branch === "feature/custom-web"
    ));
    assert.equal(persistedPrimaryTarget?.order, 2);
    assert.equal(persistedPrimaryTarget?.targetRole, "primary");
    const persistedPrimaryRepo = afterSdk.body.data.registry.vehicleMap.customVehicle.apps
      .find((app) => app.appName === "自定义语音应用")?.repos
      .find((repo) => repo.repoId === "web" && repo.branch === "feature/custom-web");
    assert.equal(persistedPrimaryRepo?.order, 2);
    assert.equal(persistedPrimaryRepo?.targetRole, "primary");
    assert.equal(
      afterSdk.body.data.samples.find((sample) => sample.id === sdkReviewed.body.sample.id)
        ?.groundTruth?.targets.find((target) => target.repositoryId === "voice-sdk-custom")?.order,
      1,
    );
    const sdkRag = await request("POST", "/ai-training/config-inference/rag", {
      projectId,
      ticket: {
        ticketId: "CONFIG-WRITEBACK-REPOSITORY-ONLY-SDK",
        title: "应用市场启动失败",
        projectId,
        projectName: "配置写回项目",
      },
    });
    assert.equal(sdkRag.status, 200);
    assert.equal(
      sdkRag.body.data.memories.some((memory) => memory.id === sdkReviewed.body.sample.id),
      false,
      "单次人工复核产生的 pending annotation 不得提前进入 serving RAG",
    );

    const invalidGitCases = [
      {
        id: "scheme",
        gitUrl: "file:///tmp/invalid-repository.git",
        error: /Git 仓库仅支持 HTTPS|Git 仓库地址仅支持 HTTPS/,
      },
      {
        id: "query-token",
        gitUrl: "https://git.example.com/team/invalid-query.git?token=super-secret-query",
        error: /不能包含查询参数或片段/,
      },
      {
        id: "hash-token",
        gitUrl: "https://git.example.com/team/invalid-hash.git#super-secret-hash",
        error: /不能包含查询参数或片段/,
      },
      {
        id: "ssh-query-fragment-token",
        gitUrl: "git@git.example.com:team/ssh-token.git?token=super-secret-ssh#fragment",
        error: /不能包含查询参数或片段/,
      },
    ];
    for (const invalidCase of invalidGitCases) {
      const invalidRun = await startRun(`CONFIG-WRITEBACK-INVALID-GIT-${invalidCase.id}`);
      assert.equal(invalidRun.status, 200);
      assert.equal(invalidRun.body.ok, true);
      const beforeInvalid = await request("GET", `/ai-training/config-inference?projectId=${projectId}`, undefined, adminToken);
      const configBeforeInvalid = fs.readFileSync(market, "utf8");
      const invalid = await request(
        "POST",
        `/ai-training/config-inference/runs/${invalidRun.body.data.id}/review`,
        {
          projectId,
          decision: "corrected",
          rating: 5,
          persistConfig: true,
          correctedPrediction: {
            targets: [{
              appName: "不应写入的应用",
              vehicle: `invalidVehicle-${invalidCase.id}`,
              repositoryId: `invalid-repository-${invalidCase.id}`,
              repositoryName: "非法仓库",
              gitUrl: invalidCase.gitUrl,
              branch: "feature/invalid",
              flavor: "invalidFlavor",
              order: 1,
            }],
          },
        },
        adminToken,
      );
      assert.equal(invalid.status, 400);
      assert.equal(invalid.body.ok, false);
      assert.match(invalid.body.error, invalidCase.error);

      const afterInvalid = await request("GET", `/ai-training/config-inference?projectId=${projectId}`, undefined, adminToken);
      assert.equal(fs.readFileSync(market, "utf8"), configBeforeInvalid);
      assert.deepEqual(afterInvalid.body.data.registry.projectDefs, beforeInvalid.body.data.registry.projectDefs);
      assert.deepEqual(afterInvalid.body.data.registry.vehicleMap, beforeInvalid.body.data.registry.vehicleMap);
      assert.deepEqual(afterInvalid.body.data.options, beforeInvalid.body.data.options);
      assert.deepEqual(
        afterInvalid.body.data.samples.map((sample) => sample.id),
        beforeInvalid.body.data.samples.map((sample) => sample.id),
      );
      assert.equal(afterInvalid.body.data.metrics.learnedSamples, beforeInvalid.body.data.metrics.learnedSamples);
      assert.equal(afterInvalid.body.data.metrics.reviewed, beforeInvalid.body.data.metrics.reviewed);
      assert.equal(
        afterInvalid.body.data.runs.find((item) => item.id === invalidRun.body.data.id)?.review,
        null,
      );
      assert.equal(afterInvalid.body.data.registry.projectDefs.some((def) => def.id === `invalid-repository-${invalidCase.id}`), false);
      assert.equal(Object.hasOwn(afterInvalid.body.data.registry.vehicleMap, `invalidVehicle-${invalidCase.id}`), false);
      assert.equal(JSON.stringify(invalid.body).includes("super-secret"), false);
      assert.equal(JSON.stringify(afterInvalid.body).includes("super-secret"), false);
      assert.equal(fs.readFileSync(market, "utf8").includes("super-secret"), false);
      assert.equal(directoryContainsText(tmp, "super-secret"), false);
    }
  } finally {
    child.kill();
  }
});

test("旧 entries 车型映射从工程注册表补齐应用名", () => {
  const registry = buildConfigInferenceRegistry(PROJECT_DEFS, {
    "阿维塔 8678": {
      entries: [{ projectId: "market", branch: "release/avatr", flavor: "avatr8678Prod" }],
    },
  });

  assert.equal(registry.targets.length, 1);
  assert.equal(registry.targets[0].appName, "应用市场");
  assert.equal(registry.targets[0].vehicle, "阿维塔 8678");
  assert.equal(registry.targets[0].flavor, "avatr8678Prod");
});

test("配置推断接口：六源推断、人工复核、学习总览与随机 TB 抽题形成统一闭环", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "config-inference-api-"));
  const port = 21000 + Math.floor(Math.random() * 1000);
  const gwCfg = path.join(tmp, "gateway.json");
  const market = path.join(tmp, "market.json");
  const storeDir = path.join(tmp, "store");
  const dbPath = path.join(tmp, "data.db");
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(gwCfg, JSON.stringify({
    servers: { nodeId: "config-inference-api-test" },
    teambition: { projects: [{ id: "project-a", name: "平台组件" }] },
  }), "utf8");
  fs.writeFileSync(market, JSON.stringify({
    projectDefs: PROJECT_DEFS,
    byProject: {
      "project-a": {
        vehicleMap: VEHICLE_MAP,
        keywordMappings: {
          title: { "启动失败": { category: "app", value: "应用市场" } },
          project: { "平台组件>应用市场": { category: "repository", value: "market" } },
          iteration: { "2026.07": { category: "branch", value: "release/avatr" } },
          tag: { "8678": { category: "vehicle", value: "阿维塔 8678" } },
          attachment: { "crash.zip": { category: "flavor", value: "avatr8678Prod" } },
          comment: { "稳定复现": { category: "repository", value: "market" } },
        },
      },
    },
  }), "utf8");
  const createApiCheckout = (name, remote, branch = "develop") => {
    const projectPath = path.join(tmp, name);
    fs.mkdirSync(path.join(projectPath, ".git"), { recursive: true });
    fs.writeFileSync(path.join(projectPath, ".git", "config"), `[remote "origin"]\n\turl = ${remote}\n`);
    fs.writeFileSync(path.join(projectPath, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
    return projectPath;
  };
  const apiLocalMarketA = createApiCheckout("api-local-market-a", "git@example.com:apps/market.git");
  const apiLocalMarketB = createApiCheckout("api-local-market-b", "https://example.com/apps/market.git", "release/other");
  const apiLocalWeb = createApiCheckout("api-local-web", "https://example.com/apps/web.git");
  fs.writeFileSync(path.join(storeDir, "devbench-projects.json"), JSON.stringify({
    version: 2,
    repositoryBindings: {},
    projects: [
      { id: "api-local-market-a", name: "API 本机应用市场 A", path: apiLocalMarketA },
      { id: "api-local-market-b", name: "API 本机应用市场 B", path: apiLocalMarketB },
      { id: "api-local-web", name: "API 本机 WebApp", path: apiLocalWeb },
    ],
  }), "utf8");
  fs.writeFileSync(path.join(storeDir, "tasks.json"), JSON.stringify([
    ["TASK_RANDOM_1", "dddddddddddddddddddddddd", "应用市场启动失败"],
    ["TASK_RANDOM_2", "eeeeeeeeeeeeeeeeeeeeeeee", "应用市场偶现启动失败"],
    ["TASK_RANDOM_3", "ffffffffffffffffffffffff", "应用市场冷启动失败"],
  ].map(([id, tbTaskId, title]) => ({
    id,
    title,
    // 真实 TB taskId 为 24 位十六进制；该格式会进入详情补全路径，
    // 即使远端详情不可用，本地缓存工单也必须能够继续用于随机训练。
    tbTaskId,
    projectId: "project-a",
    projectName: "平台组件",
    tasklistName: "应用市场",
    staged: true,
    done: false,
    createdAt: Date.now(),
  }))), "utf8");

  const child = bootGateway({ port, gwCfg, market, storeDir, dbPath });
  try {
    await waitHealth(port, child);
    const adminToken = await loginAdminAt(port);
    const authHeaders = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminToken}`,
    };
    for (const dangerousRunId of ["__proto__", "prototype", "constructor"]) {
      const encodedRunId = encodeURIComponent(dangerousRunId);
      for (const [suffix, body] of [
        ["refresh", { projectId: "project-a", force: true }],
        ["review", { projectId: "project-a", decision: "correct", rating: 5 }],
        ["resolve-symbols", { projectId: "project-a", correctedPrediction: { targets: [] } }],
      ]) {
        const response = await fetch(`http://127.0.0.1:${port}/api/devbench/ai-training/config-inference/runs/${encodedRunId}/${suffix}`, {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify(body),
        });
        const payload = await response.json();
        assert.equal(response.status, 400);
        assert.equal(payload.ok, false);
        assert.match(payload.error, /runId/);
      }
    }
    const run = await fetch(`http://127.0.0.1:${port}/api/devbench/ai-training/config-inference/run`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        projectId: "project-a",
        trigger: "story_created",
        ticket: {
          title: "应用市场启动失败",
          description: "TB 备注：仅在首次冷启动出现",
          projectName: "平台组件",
          tasklistName: "应用市场",
          iterationName: "2026.07",
          tags: ["8678"],
          attachments: [{ name: "crash.zip" }],
          comments: "稳定复现",
        },
      }),
    }).then((response) => response.json());
    assert.equal(run.ok, true);
    assert.equal(run.data.prediction.targets[0].repositoryId, "market");
    assert.deepEqual(run.data.prediction.signals.sources.note, ["TB 备注：仅在首次冷启动出现"]);
    assert.deepEqual(
      CONFIG_INFERENCE_GROUPS.map((group) => run.data.prediction.signals.byGroup[group].length),
      [1, 1, 1, 1, 1, 1],
    );
    assert.equal(run.data.localResolution.targets.find((target) => target.repositoryId === "market")?.matchKind, "ambiguous");

    const marketTarget = run.data.prediction.targets.find((target) => target.repositoryId === "market");
    const randomTrainingTarget = {
      targetId: "random-training-market",
      appName: marketTarget.appName,
      vehicle: marketTarget.vehicle,
      repositoryId: marketTarget.repositoryId,
      repositoryName: marketTarget.repositoryName,
      gitUrl: marketTarget.gitUrl,
      branch: marketTarget.branch,
      flavor: marketTarget.flavor,
      projectType: marketTarget.projectType,
      targetRole: "primary",
      order: 1,
    };
    const reviewBody = {
      projectId: "project-a",
      decision: "correct",
      rating: 5,
      apply: true,
      localProjectBindings: [{
        targetId: marketTarget.targetId || "target_1",
        repositoryId: marketTarget.repositoryId,
        branch: marketTarget.branch,
        projectId: "api-local-market-a",
      }],
    };
    const review = await fetch(`http://127.0.0.1:${port}/api/devbench/ai-training/config-inference/runs/${run.data.id}/review`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify(reviewBody),
    }).then((response) => response.json());
    assert.equal(review.ok, true);
    const reviewerTokens = await loginStableReviewersAt(port, adminToken, "config-inference-api");
    await approveReviewedAnnotationAtPort(port, "project-a", review, reviewerTokens);
    assert.equal(review.snapshot.mode, "local");
    assert.equal(review.snapshot.primaryProjectId, "api-local-market-a");

    // 模拟首次复核的本机记忆尚未落盘/被旧版本遗漏；随后同一 run 的业务冲突
    // 仍必须独立记住本次人工选择，不能只返回一次性的 confirmedSnapshot。
    const localProjectsFile = path.join(storeDir, "devbench-projects.json");
    const localProjectsWithoutMemory = JSON.parse(fs.readFileSync(localProjectsFile, "utf8"));
    localProjectsWithoutMemory.repositoryBindings = {};
    fs.writeFileSync(localProjectsFile, JSON.stringify(localProjectsWithoutMemory, null, 2));

    const conflictingReviewResponse = await fetch(`http://127.0.0.1:${port}/api/devbench/ai-training/config-inference/runs/${run.data.id}/review`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ ...reviewBody, reason: "与已保存复核不同，触发业务失败" }),
    });
    const failedReviewWithConfirmed = await conflictingReviewResponse.json();
    assert.equal(conflictingReviewResponse.status, 409);
    assert.equal(failedReviewWithConfirmed.ok, false);
    assert.equal(failedReviewWithConfirmed.confirmedSnapshot.mode, "local", "复核业务失败仍应返回服务端确认的本机快照");
    assert.equal(failedReviewWithConfirmed.confirmedSnapshot.primaryProjectId, "api-local-market-a");
    const rememberedAfterConflict = JSON.parse(fs.readFileSync(localProjectsFile, "utf8"));
    assert.equal(rememberedAfterConflict.repositoryBindings.market[marketTarget.branch].projectId, "api-local-market-a");

    const reopenedRun = await fetch(`http://127.0.0.1:${port}/api/devbench/ai-training/config-inference/run`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        projectId: "project-a",
        // 本用例只验证人工确认的本机绑定会被下一次推理复用；真实重新打开
        // 必须绑定已关闭故事点，由 story-reopen-review 集成套件单独覆盖。
        trigger: "manual",
        ticket: { title: "应用市场启动失败", projectName: "平台组件", tasklistName: "应用市场" },
      }),
    }).then((response) => response.json());
    assert.equal(reopenedRun.ok, true);
    assert.equal(reopenedRun.data.suggestedSnapshot.mode, "local", "再次打开必须直接复用已记住的本机工程");
    assert.equal(reopenedRun.data.suggestedSnapshot.primaryProjectId, "api-local-market-a");
    assert.equal(reopenedRun.data.localResolution.targets.find((target) => target.repositoryId === "market")?.matchKind, "remembered");

    const overview = await fetch(`http://127.0.0.1:${port}/api/devbench/ai-training/config-inference?projectId=project-a`, {
      headers: authHeaders,
    })
      .then((response) => response.json());
    assert.equal(overview.ok, true);
    assert.equal(overview.data.metrics.reviewed, 1);
    assert.equal(overview.data.metrics.learnedSamples, 1);
    assert.equal(overview.data.taskPool.staged, 3);

    const rag = await fetch(`http://127.0.0.1:${port}/api/devbench/ai-training/config-inference/rag`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        projectId: "project-a",
        ticket: {
          title: "应用市场启动失败",
          description: "TB 备注：仅在首次冷启动出现",
          projectName: "平台组件",
          tasklistName: "应用市场",
          iterationName: "2026.07",
          tags: ["8678"],
          attachments: [{ name: "crash.zip" }],
          comments: "稳定复现",
        },
      }),
    }).then((response) => response.json());
    assert.equal(rag.ok, true);
    assert.equal(rag.data.schemaVersion, CONFIG_INFERENCE_RAG_VERSION);
    assert.equal(rag.data.projectId, "project-a");
    assert.equal(rag.data.policy.providerNeutral, true);
    assert.equal(rag.data.memories[0].kind, "positive");
    assert.equal(rag.data.memories[0].targets[0].repositoryId, "market");
    assert.equal(Object.hasOwn(rag.data, "engine"), false);
    const overviewAfterRag = await fetch(`http://127.0.0.1:${port}/api/devbench/ai-training/config-inference?projectId=project-a`, {
      headers: authHeaders,
    })
      .then((response) => response.json());
    assert.equal(overviewAfterRag.data.metrics.runs, overview.data.metrics.runs);
    assert.equal(overviewAfterRag.data.metrics.learnedSamples, overview.data.metrics.learnedSamples);

    const unscopedResponse = await fetch(`http://127.0.0.1:${port}/api/devbench/ai-training/config-inference/rag`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ ticket: { title: "缺少项目的查询" } }),
    });
    assert.equal(unscopedResponse.status, 400);
    assert.match((await unscopedResponse.json()).error, /必须指定 TB 项目/);

    const sourceMismatch = await fetch(`http://127.0.0.1:${port}/api/devbench/ai-training/config-inference/task-source/preview`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        projectId: "project-a",
        sourceUrl: "https://www.teambition.com/project/65a5f274950780b816cf905e/sprint/section/6a4db00cc9339b8e79167473",
      }),
    });
    assert.equal(sourceMismatch.status, 409);
    assert.match((await sourceMismatch.json()).error, /与当前项目.*不一致/);
    const overviewAfterSourceMismatch = await fetch(`http://127.0.0.1:${port}/api/devbench/ai-training/config-inference?projectId=project-a`, {
      headers: authHeaders,
    })
      .then((response) => response.json());
    assert.equal(overviewAfterSourceMismatch.data.metrics.runs, overviewAfterRag.data.metrics.runs);
    assert.equal(overviewAfterSourceMismatch.data.metrics.learnedSamples, overviewAfterRag.data.metrics.learnedSamples);

    const randomWithoutProject = await fetch(`http://127.0.0.1:${port}/api/devbench/ai-training/config-inference/random`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ pool: "all" }),
    });
    assert.equal(randomWithoutProject.status, 400);
    assert.match((await randomWithoutProject.json()).error, /必须指定 TB 项目/);

    const sessionId = "continuous-training-test";
    const seenTaskIds = [];
    const remainingSequence = [3, 2, 1];
    let firstReview = null;
    for (let index = 0; index < remainingSequence.length; index++) {
      const random = await fetch(`http://127.0.0.1:${port}/api/devbench/ai-training/config-inference/random`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ projectId: "project-a", pool: "staged", sessionId, excludeTaskIds: seenTaskIds }),
      }).then((response) => response.json());
      assert.equal(random.ok, true);
      assert.equal(random.complete, undefined);
      assert.equal(random.data.trigger, "training_random");
      assert.match(random.data.ticket.title, /应用市场.*启动失败/);
      assert.equal(random.data.random.pool, "staged");
      assert.equal(random.data.random.sessionId, sessionId);
      assert.equal(random.data.random.listTotal, 3);
      assert.equal(random.data.random.total, 3);
      assert.equal(random.data.random.trained, index);
      assert.equal(random.data.random.remaining, remainingSequence[index]);
      assert.equal(random.data.random.exhausted, false);
      assert.equal(seenTaskIds.includes(random.data.ticket.tbTaskId), false);
      seenTaskIds.push(random.data.ticket.tbTaskId);

      const reviewRating = index === 1 ? 1 : 5;
      const randomReviewBody = index === 1
        ? { projectId: "project-a", decision: "ticket_wrong", rating: reviewRating }
        : {
          projectId: "project-a",
          decision: "corrected",
          rating: reviewRating,
          correctedPrediction: {
            targets: [randomTrainingTarget],
            noTargets: false,
          },
        };
      const reviewResponse = await fetch(`http://127.0.0.1:${port}/api/devbench/ai-training/config-inference/runs/${random.data.id}/review`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify(randomReviewBody),
      });
      const reviewed = await reviewResponse.json();
      assert.equal(reviewResponse.status, 200, reviewed.error);
      assert.equal(reviewed.ok, true);
      assert.equal(reviewed.learned, false);
      assert.equal(reviewed.annotationPending, true);
      assert.equal(reviewed.reviewPersisted, true);
      assert.equal(reviewed.trainedTicket.tbTaskId, random.data.ticket.tbTaskId);
      if (index === 0) {
        firstReview = {
          runId: random.data.id,
          sampleId: reviewed.sample.id,
          reviewBody: randomReviewBody,
        };
      }
    }
    assert.equal(new Set(seenTaskIds).size, 3);

    const exhausted = await fetch(`http://127.0.0.1:${port}/api/devbench/ai-training/config-inference/random`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ projectId: "project-a", pool: "staged", sessionId, excludeTaskIds: seenTaskIds }),
    }).then((response) => response.json());
    assert.equal(exhausted.ok, true);
    assert.equal(exhausted.complete, true);
    assert.equal(exhausted.data.done, true);
    assert.equal(exhausted.data.random.total, 3);
    assert.equal(exhausted.data.random.trained, 3);
    assert.equal(exhausted.data.random.remaining, 0);
    assert.equal(exhausted.data.random.exhausted, true);

    const freshSession = await fetch(`http://127.0.0.1:${port}/api/devbench/ai-training/config-inference/random`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ projectId: "project-a", pool: "staged", sessionId: "fresh-session-without-client-history" }),
    }).then((response) => response.json());
    assert.equal(freshSession.complete, true);
    assert.equal(freshSession.data.random.trained, 3);
    assert.equal(freshSession.data.random.remaining, 0);

    const beforeRetry = await fetch(
      `http://127.0.0.1:${port}/api/devbench/ai-training/config-inference?projectId=project-a`,
      { headers: authHeaders },
    ).then((response) => response.json());
    const sameReview = await fetch(`http://127.0.0.1:${port}/api/devbench/ai-training/config-inference/runs/${firstReview.runId}/review`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify(firstReview.reviewBody),
    }).then((response) => response.json());
    assert.equal(sameReview.ok, true);
    assert.equal(sameReview.idempotent, true);
    assert.equal(sameReview.sample.id, firstReview.sampleId);
    const afterRetry = await fetch(
      `http://127.0.0.1:${port}/api/devbench/ai-training/config-inference?projectId=project-a`,
      { headers: authHeaders },
    ).then((response) => response.json());
    assert.equal(afterRetry.data.metrics.learnedSamples, beforeRetry.data.metrics.learnedSamples);
    assert.equal(afterRetry.data.metrics.trainedTickets, 3);

    const conflictingReview = await fetch(`http://127.0.0.1:${port}/api/devbench/ai-training/config-inference/runs/${firstReview.runId}/review`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ ...firstReview.reviewBody, rating: 4 }),
    });
    assert.equal(conflictingReview.status, 409);
    assert.match((await conflictingReview.json()).error, /不能覆盖/);
  } finally {
    child.kill();
  }
});

test("旧 v2 未评分推理必须先按当前规则重算，禁止把旧预测直接学习", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "config-inference-stale-v2-"));
  const port = 27000 + Math.floor(Math.random() * 1000);
  const gwCfg = path.join(tmp, "gateway.json");
  const market = path.join(tmp, "market.json");
  const storeDir = path.join(tmp, "store");
  const dbPath = path.join(tmp, "data.db");
  const projectId = "project-a";
  const oldVersion = "config-inference-rules-v2";
  const now = Date.now();
  const ticket = {
    ticketId: "STALE-RULES-1",
    title: "应用市场启动失败",
    description: "TB 备注：仅在首次冷启动出现",
    projectName: "平台组件",
    tasklistName: "应用市场",
    iterationName: "2026.07",
    tags: ["8678"],
    attachments: [{ name: "crash.zip" }],
    comments: ["稳定复现"],
  };
  const stalePrediction = {
    status: "READY",
    targets: [{
      targetId: "legacy-wrong-web",
      appName: "应用市场",
      vehicle: "阿维塔 8678",
      repositoryId: "web",
      repositoryName: "WebApp",
      gitUrl: "https://example.com/apps/web.git",
      branch: "release/web-avatr",
      flavor: "web8678",
      targetRole: "primary",
      order: 1,
    }],
    evidence: [{ id: "legacy-evidence", kind: "historical_feedback", text: "旧规则错误预测" }],
  };
  const staleRun = (id, ticketId, offset) => ({
    id,
    projectId,
    trigger: "manual",
    ticket: { ...ticket, ticketId },
    prediction: stalePrediction,
    currentConfig: null,
    review: null,
    version: oldVersion,
    registryVersion: "legacy-registry",
    createdAt: now + offset,
    updatedAt: now + offset,
  });

  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(gwCfg, JSON.stringify({
    servers: { nodeId: "config-inference-stale-v2-test" },
    teambition: { projects: [{ id: projectId, name: "平台组件" }] },
  }), "utf8");
  fs.writeFileSync(market, JSON.stringify({
    projectDefs: PROJECT_DEFS,
    byProject: {
      [projectId]: {
        vehicleMap: VEHICLE_MAP,
        keywordMappings: {
          title: { "启动失败": { category: "app", value: "应用市场" } },
          project: { "平台组件>应用市场": { category: "repository", value: "market" } },
          iteration: { "2026.07": { category: "branch", value: "release/avatr" } },
          tag: { "8678": { category: "vehicle", value: "阿维塔 8678" } },
          attachment: { "crash.zip": { category: "flavor", value: "avatr8678Prod" } },
          comment: { "稳定复现": { category: "repository", value: "market" } },
        },
        aiTraining: {
          configInference: {
            runs: {
              "stale-review-guard": staleRun("stale-review-guard", "STALE-RULES-REVIEW", 1),
              "stale-explicit-refresh": staleRun("stale-explicit-refresh", "STALE-RULES-REFRESH", 2),
            },
            samples: {},
          },
        },
      },
    },
  }), "utf8");

  const child = bootGateway({ port, gwCfg, market, storeDir, dbPath });
  const request = async (method, pathname, body, token = "") => {
    const response = await fetch(`http://127.0.0.1:${port}/api/devbench${pathname}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    await waitHealth(port, child);
    assert.notEqual(CONFIG_INFERENCE_VERSION, oldVersion);
    const adminToken = await loginAdminAt(port);

    const anonymousInitial = await request("GET", `/ai-training/config-inference?projectId=${projectId}`);
    assert.equal(anonymousInitial.status, 401, "旧版 overview 也不能匿名读取");
    const initial = await request("GET", `/ai-training/config-inference?projectId=${projectId}`, undefined, adminToken);
    assert.equal(initial.status, 200);
    assert.equal(initial.body.data.version, CONFIG_INFERENCE_VERSION);
    assert.equal(initial.body.data.metrics.runs, 2);
    assert.equal(initial.body.data.metrics.reviewed, 0);
    assert.equal(initial.body.data.metrics.learnedSamples, 0);
    assert.equal(initial.body.data.metrics.stalePendingRuns, 2);
    assert.equal(initial.body.data.runs.find((run) => run.id === "stale-review-guard")?.stalePrediction, true);

    const blockedReview = await request(
      "POST",
      "/ai-training/config-inference/runs/stale-review-guard/review",
      { projectId, decision: "correct", rating: 5 },
      adminToken,
    );
    assert.equal(blockedReview.status, 409);
    assert.equal(blockedReview.body.ok, false);
    assert.equal(blockedReview.body.stale, true);
    assert.equal(blockedReview.body.refreshed, true);
    assert.match(blockedReview.body.error, /规则已升级.*重新计算/);
    assert.equal(blockedReview.body.data.version, CONFIG_INFERENCE_VERSION);
    assert.equal(blockedReview.body.data.stalePrediction, false);
    assert.equal(blockedReview.body.data.predictionRevision, 1);
    assert.equal(blockedReview.body.data.refresh.fromVersion, oldVersion);
    assert.equal(blockedReview.body.data.prediction.targets[0].repositoryId, "market");

    const afterBlockedReview = await request(
      "GET",
      `/ai-training/config-inference?projectId=${projectId}`,
      undefined,
      adminToken,
    );
    const guardedRun = afterBlockedReview.body.data.runs.find((run) => run.id === "stale-review-guard");
    assert.equal(afterBlockedReview.body.data.metrics.reviewed, 0);
    assert.equal(afterBlockedReview.body.data.metrics.learnedSamples, 0);
    assert.equal(afterBlockedReview.body.data.metrics.stalePendingRuns, 1);
    assert.equal(guardedRun.review, null);
    assert.equal(guardedRun.version, CONFIG_INFERENCE_VERSION);
    assert.equal(guardedRun.stalePrediction, false);
    assert.equal(guardedRun.prediction.targets[0].repositoryId, "market");

    const retryReview = await request(
      "POST",
      "/ai-training/config-inference/runs/stale-review-guard/review",
      { projectId, decision: "correct", rating: 5 },
      adminToken,
    );
    assert.equal(retryReview.status, 200, retryReview.body.error);
    assert.equal(retryReview.body.ok, true);
    assert.equal(retryReview.body.learned, false);
    assert.equal(retryReview.body.annotationPending, true);
    assert.equal(retryReview.body.sample.sourceRunId, "stale-review-guard");
    assert.equal(retryReview.body.sample.groundTruth.targets[0].repositoryId, "market");

    const refreshed = await request(
      "POST",
      "/ai-training/config-inference/runs/stale-explicit-refresh/refresh",
      { projectId, reason: "regression_test" },
      adminToken,
    );
    assert.equal(refreshed.status, 200, refreshed.body.error);
    assert.equal(refreshed.body.ok, true);
    assert.equal(refreshed.body.refreshed, true);
    assert.equal(refreshed.body.data.version, CONFIG_INFERENCE_VERSION);
    assert.equal(refreshed.body.data.stalePrediction, false);
    assert.equal(refreshed.body.data.predictionRevision, 1);
    assert.equal(refreshed.body.data.refresh.fromVersion, oldVersion);
    assert.equal(refreshed.body.data.refresh.reason, "regression_test");
    assert.equal(refreshed.body.data.prediction.targets[0].repositoryId, "market");

    const afterExplicitRefresh = await request(
      "GET",
      `/ai-training/config-inference?projectId=${projectId}`,
      undefined,
      adminToken,
    );
    const persistedRun = afterExplicitRefresh.body.data.runs.find((run) => run.id === "stale-explicit-refresh");
    assert.equal(afterExplicitRefresh.body.data.metrics.stalePendingRuns, 0);
    assert.equal(persistedRun.version, CONFIG_INFERENCE_VERSION);
    assert.equal(persistedRun.predictionRevision, 1);
    assert.equal(persistedRun.stalePrediction, false);
    assert.equal(persistedRun.prediction.targets[0].repositoryId, "market");

    const reviewedAfterRefresh = await request(
      "POST",
      "/ai-training/config-inference/runs/stale-explicit-refresh/review",
      { projectId, decision: "correct", rating: 5 },
      adminToken,
    );
    assert.equal(reviewedAfterRefresh.status, 200, reviewedAfterRefresh.body.error);
    assert.equal(reviewedAfterRefresh.body.ok, true);
    assert.equal(reviewedAfterRefresh.body.learned, false);
    assert.equal(reviewedAfterRefresh.body.annotationPending, true);
    assert.equal(reviewedAfterRefresh.body.sample.sourceRunId, "stale-explicit-refresh");

    const completed = await request(
      "GET",
      `/ai-training/config-inference?projectId=${projectId}`,
      undefined,
      adminToken,
    );
    assert.equal(completed.body.data.metrics.reviewed, 2);
    assert.equal(completed.body.data.metrics.learnedSamples, 0);
    assert.equal(completed.body.data.metrics.pendingAnnotations, 2);
    assert.equal(completed.body.data.metrics.pendingReviews, 0);
    assert.equal(completed.body.data.metrics.stalePendingRuns, 0);
  } finally {
    child.kill();
  }
});

test("显式 TB URL 从完整 42 单预览、保存筛选到随机抽题保持同一过滤契约", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "config-inference-source-filter-"));
  const port = 23000 + Math.floor(Math.random() * 1000);
  const gwCfg = path.join(tmp, "gateway.json");
  const market = path.join(tmp, "market.json");
  const storeDir = path.join(tmp, "store");
  const dbPath = path.join(tmp, "data.db");
  const preload = path.join(tmp, "mock-teambition.mjs");
  const projectId = "65a5f274950780b816cf905e";
  const sprintId = "6a4db00cc9339b8e79167473";
  const statusDefs = [
    ["111111111111111111111111", "处理中", 1, false],
    ["222222222222222222222222", "关闭", 18, true],
    ["333333333333333333333333", "可提测", 21, true],
    ["444444444444444444444444", "已拒绝", 1, true],
    ["555555555555555555555555", "已完成", 1, true],
  ];
  let sequence = 2000;
  const sourceTasks = statusDefs.flatMap(([statusId, statusName, count, done]) => Array.from({ length: count }, (_, index) => ({
    _id: (sequence++).toString(16).padStart(24, "0"),
    content: `【应用市场】${statusName}集成工单 ${index + 1}`,
    _projectId: projectId,
    _sprintId: sprintId,
    _tasklistId: "666666666666666666666666",
    _taskflowstatusId: statusId,
    taskflowstatus: { _id: statusId, name: statusName, _taskflowId: "777777777777777777777777" },
    isDone: done,
  })));
  const completedOnlyTask = sourceTasks.find((task) => task.taskflowstatus.name === "已完成");
  const sourceUrl = `https://www.teambition.com/project/${projectId}/sprint/section/${sprintId}`;
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(gwCfg, JSON.stringify({
    servers: { nodeId: "config-inference-source-filter-test", discovery: false, peers: [] },
    teambition: {
      appId: "mock-app",
      appSecret: "mock-secret",
      orgId: "mock-org",
      operatorId: "mock-user",
      userCookie: "TEAMBITION_SESSIONID=mock-source-filter",
      projects: [{ id: projectId, name: "平台组件" }],
    },
  }), "utf8");
  fs.writeFileSync(market, JSON.stringify({
    projectDefs: PROJECT_DEFS,
    byProject: {
      [projectId]: {
        vehicleMap: VEHICLE_MAP,
        keywordMappings: { title: { "应用市场": { category: "app", value: "应用市场" } } },
      },
    },
  }), "utf8");
  fs.writeFileSync(path.join(storeDir, "tasks.json"), "[]", "utf8");
  fs.writeFileSync(preload, `
const originalFetch = globalThis.fetch;
const projectId = ${JSON.stringify(projectId)};
const sprintId = ${JSON.stringify(sprintId)};
const tasks = ${JSON.stringify(sourceTasks)};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
globalThis.fetch = async (input, init) => {
  const rawUrl = typeof input === "string" ? input : input?.url;
  const url = new URL(rawUrl);
  if (url.hostname === "open.teambition.com") {
    if (url.pathname === "/api/appToken") return json({ appToken: "mock-token", expire: 3600 });
    if (url.pathname === "/api/task/query") {
      return json({ result: url.searchParams.get("isDone") === "true" ? tasks.filter((task) => task.isDone).slice(0, 4) : [], nextPageToken: "" });
    }
    const taskId = url.searchParams.get("taskId") || url.searchParams.get("id");
    return json({ result: tasks.find((task) => task._id === taskId) || {} });
  }
  if (url.hostname === "www.teambition.com") {
    if (url.pathname === "/api/v2/projects/" + projectId + "/tasks") {
      const pageToken = url.searchParams.get("pageToken") || "";
      return pageToken === "page-2"
        ? json({ result: tasks.slice(40), totalSize: 42, nextPageToken: "" })
        : json({ result: tasks.slice(0, 40), totalSize: 42, nextPageToken: "page-2" });
    }
    if (url.pathname === "/api/sprints/" + sprintId) return json({ _id: sprintId, _projectId: projectId, name: "来源过滤集成迭代", status: "active" });
    if (url.pathname === "/api/projects/" + projectId + "/taskflows") return json([]);
    if (url.pathname === "/api/projects/" + projectId + "/tasks") return json([]);
    const detail = url.pathname.match(/^\\/api\\/tasks\\/([0-9a-f]{24})$/i);
    if (detail) return json(tasks.find((task) => task._id === detail[1]) || {});
    return json({ result: [] });
  }
  return originalFetch(input, init);
};
`, "utf8");

  const child = bootGateway({
    port,
    gwCfg,
    market,
    storeDir,
    dbPath,
    extraEnv: {
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(preload).href}`].filter(Boolean).join(" "),
    },
  });
  const request = (method, pathname, body, token = "") => fetch(`http://127.0.0.1:${port}/api/devbench${pathname}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (response) => ({ status: response.status, body: await response.json() }));
  try {
    await waitHealth(port, child);
    const adminToken = await loginAdminAt(port);
    const preview = await request("POST", "/ai-training/config-inference/task-source/preview", { projectId, sourceUrl });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.ok, true);
    assert.deepEqual(preview.body.data.counts, { all: 42, pending: 1, completed: 41 });
    assert.equal(preview.body.data.acquisition.cookieComplete, true);
    assert.equal(preview.body.data.acquisition.cookieReportedTotal, 42);
    assert.equal(preview.body.data.acquisition.cookiePages, 2);

    const saved = await request("PUT", "/ai-training/config-inference/task-source", {
      projectId,
      sourceUrl,
      filter: {
        completion: "completed",
        statusKeys: ["222222222222222222222222"],
      },
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.data.source.filter, {
      completion: "completed",
      statusKeys: ["222222222222222222222222"],
    });
    assert.equal(saved.body.data.source.statusCounts.find((row) => row.name === "关闭")?.count, 18);
    assert.equal(saved.body.data.source.acquisition.cookieReportedTotal, 42);

    const empty = await request("POST", "/ai-training/config-inference/random", {
      projectId,
      sourceUrl,
      filter: {
        completion: "completed",
        statusKeys: ["111111111111111111111111"],
      },
      sessionId: "explicit-source-empty-filter",
    });
    assert.equal(empty.status, 200);
    assert.equal(empty.body.ok, false);
    assert.match(empty.body.error, /过滤条件/);

    const random = await request("POST", "/ai-training/config-inference/random", {
      projectId,
      sourceUrl,
      filter: {
        completion: "completed",
        statusKeys: ["555555555555555555555555"],
      },
      sessionId: "explicit-source-single-status",
    });
    assert.equal(random.status, 200);
    assert.equal(random.body.ok, true);
    assert.equal(random.body.data.ticket.tbTaskId, completedOnlyTask._id);
    assert.equal(random.body.data.random.listTotal, 42);
    assert.equal(random.body.data.random.total, 1);
    assert.deepEqual(random.body.data.random.filter, {
      completion: "completed",
      statusKeys: ["555555555555555555555555"],
    });
    assert.equal(random.body.data.random.sourceCounts.all, 42);
    assert.equal(random.body.data.random.sourceAcquisition.cookieComplete, true);

    const anonymousOverview = await request("GET", `/ai-training/config-inference?projectId=${projectId}`);
    assert.equal(anonymousOverview.status, 401);
    const overview = await request(
      "GET",
      `/ai-training/config-inference?projectId=${projectId}`,
      undefined,
      adminToken,
    );
    assert.deepEqual(overview.body.data.settings.taskSource.filter, {
      completion: "completed",
      statusKeys: ["555555555555555555555555"],
    });

    // 复现线上故障：随机抽题已经返回给页面并写入审计，但另一 Gateway 的
    // 旧整行 shared 快照把 run 抹掉，只留下 runId 为空的训练占用。
    const { default: Database } = await import("better-sqlite3");
    const directDb = new Database(dbPath);
    try {
      directDb.pragma("busy_timeout = 5000");
      const sharedRow = directDb.prepare("SELECT data FROM devbench_userdata WHERE user_key=? AND kind=?")
        .get("__devbench_shared__", "shared");
      assert.ok(sharedRow?.data, "随机抽题后应已落盘 shared 状态");
      const shared = JSON.parse(sharedRow.data);
      const inferenceRoot = shared.byProject?.[projectId]?.aiTraining?.configInference;
      const runId = random.body.data.id;
      const ticketId = random.body.data.ticket.tbTaskId;
      assert.ok(inferenceRoot?.runs?.[runId], "故障注入前 run 必须存在");
      assert.equal(inferenceRoot?.trainingClaims?.[ticketId]?.runId, runId);
      delete inferenceRoot.runs[runId];
      inferenceRoot.trainingClaims[ticketId] = {
        ...inferenceRoot.trainingClaims[ticketId],
        runId: "",
        updatedAt: Date.now(),
      };
      directDb.prepare("UPDATE devbench_userdata SET data=?, updated_at=? WHERE user_key=? AND kind=?")
        .run(JSON.stringify(shared), Date.now(), "__devbench_shared__", "shared");
    } finally {
      directDb.close();
    }

    const missingOverview = await request(
      "GET",
      `/ai-training/config-inference?projectId=${projectId}`,
      undefined,
      adminToken,
    );
    assert.equal(missingOverview.body.data.runs.some((run) => run.id === random.body.data.id), false);

    const reviewBody = {
      projectId,
      decision: "correct",
      rating: 5,
      recovery: {
        ticket: random.body.data.ticket,
        trainingSessionId: "explicit-source-single-status",
        expectedPrediction: random.body.data.prediction,
        version: random.body.data.version,
        registryVersion: random.body.data.registryVersion,
        createdAt: random.body.data.createdAt,
      },
    };
    const recoveredReview = await request(
      "POST",
      `/ai-training/config-inference/runs/${random.body.data.id}/review`,
      reviewBody,
      adminToken,
    );
    assert.equal(recoveredReview.status, 200, recoveredReview.body.error);
    assert.equal(recoveredReview.body.ok, true);
    assert.equal(recoveredReview.body.recovered, true);
    assert.equal(recoveredReview.body.learned, false);
    assert.equal(recoveredReview.body.annotationPending, true);
    assert.equal(recoveredReview.body.data.id, random.body.data.id);
    assert.equal(recoveredReview.body.data.review.rating, 5);
    assert.equal(recoveredReview.body.trainedTicket.tbTaskId, random.body.data.ticket.tbTaskId);

    const recoveredOverview = await request(
      "GET",
      `/ai-training/config-inference?projectId=${projectId}`,
      undefined,
      adminToken,
    );
    assert.equal(recoveredOverview.body.data.runs.find((run) => run.id === random.body.data.id)?.review?.rating, 5);
    assert.equal(recoveredOverview.body.data.samples.filter((sample) => sample.sourceRunId === random.body.data.id).length, 1);
    assert.equal(recoveredOverview.body.data.trainedTickets.filter((row) => row.sourceRunId === random.body.data.id).length, 1);
    assert.equal(recoveredOverview.body.data.trainingClaims.some((claim) => claim.tbTaskId === random.body.data.ticket.tbTaskId), false);

    const idempotentRetry = await request(
      "POST",
      `/ai-training/config-inference/runs/${random.body.data.id}/review`,
      reviewBody,
      adminToken,
    );
    assert.equal(idempotentRetry.status, 200, idempotentRetry.body.error);
    assert.equal(idempotentRetry.body.ok, true);
    assert.equal(idempotentRetry.body.idempotent, true);
    const retryOverview = await request(
      "GET",
      `/ai-training/config-inference?projectId=${projectId}`,
      undefined,
      adminToken,
    );
    assert.equal(retryOverview.body.data.samples.filter((sample) => sample.sourceRunId === random.body.data.id).length, 1);
    await request("POST", "/ai-training/config-inference/session/exit", { projectId, sessionId: "explicit-source-single-status" });
  } finally {
    child.kill();
  }
});

test("并发训练会原子占用单工单，其他 session 返回忙碌且不会误报列表完成", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "config-inference-claim-"));
  const port = 22000 + Math.floor(Math.random() * 1000);
  const gwCfg = path.join(tmp, "gateway.json");
  const market = path.join(tmp, "market.json");
  const storeDir = path.join(tmp, "store");
  const dbPath = path.join(tmp, "data.db");
  const projectId = "project-concurrent-training";
  const tbTaskId = "abababababababababababab";
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(gwCfg, JSON.stringify({
    servers: { nodeId: "config-inference-claim-test" },
    teambition: { projects: [{ id: projectId, name: "并发训练项目" }] },
  }), "utf8");
  fs.writeFileSync(market, JSON.stringify({
    projectDefs: PROJECT_DEFS,
    byProject: {
      [projectId]: {
        vehicleMap: VEHICLE_MAP,
        keywordMappings: {
          title: { "启动失败": { category: "app", value: "应用市场" } },
        },
      },
    },
  }), "utf8");
  fs.writeFileSync(path.join(storeDir, "tasks.json"), JSON.stringify([{
    id: "TASK_CONCURRENT_ONLY",
    tbTaskId,
    title: "应用市场启动失败",
    projectId,
    projectName: "并发训练项目",
    tasklistName: "单工单列表",
    staged: true,
    done: false,
    createdAt: Date.now(),
  }]), "utf8");

  const child = bootGateway({ port, gwCfg, market, storeDir, dbPath });
  try {
    await waitHealth(port, child);
    const requestRandom = async (sessionId) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/devbench/ai-training/config-inference/random`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, pool: "staged", sessionId, excludeTaskIds: [] }),
      });
      return { sessionId, status: response.status, body: await response.json() };
    };

    const results = await Promise.all([
      requestRandom("concurrent-session-a"),
      requestRandom("concurrent-session-b"),
    ]);
    const acquired = results.filter(({ body }) => body.ok === true
      && body.complete !== true
      && body.data?.id
      && body.data?.random?.currentTaskId === tbTaskId);
    const blocked = results.filter((result) => !acquired.includes(result));
    const diagnostic = JSON.stringify(results);

    assert.equal(acquired.length, 1, `同一 TB 单最多只能被一个 session 取得：${diagnostic}`);
    assert.equal(blocked.length, 1, `另一个 session 应收到唯一的忙碌响应：${diagnostic}`);
    assert.equal(blocked[0].status, 200, `忙碌是可重试状态，应保持 HTTP 200：${diagnostic}`);
    assert.equal(blocked[0].body.ok, true, `忙碌响应仍应是成功读取训练进度：${diagnostic}`);
    assert.equal(blocked[0].body.pending, true, `忙碌响应必须明确标记 pending：${diagnostic}`);
    assert.notEqual(blocked[0].body.complete, true, `被占用不等于列表训练完成：${diagnostic}`);
    assert.equal(blocked[0].body.data?.random?.busy, true, `被占用 session 应返回 busy：${diagnostic}`);
    assert.equal(blocked[0].body.data?.random?.done, false, `仍有未训练工单时不能返回 done：${diagnostic}`);
    assert.equal(blocked[0].body.data?.random?.exhausted, false, `暂时无可用工单不等于耗尽：${diagnostic}`);
    assert.equal(blocked[0].body.data?.random?.available, 0, `唯一工单被占用时 available 应为 0：${diagnostic}`);
    assert.equal(blocked[0].body.data?.random?.remaining, 1, `未评分的占用工单仍应计入剩余训练数：${diagnostic}`);
    assert.ok(Number(blocked[0].body.data?.random?.retryAfterMs) > 0, `忙碌响应应给出正数 retryAfterMs：${diagnostic}`);

    const anonymousOverview = await fetch(
      `http://127.0.0.1:${port}/api/devbench/ai-training/config-inference?projectId=${projectId}`,
    );
    assert.equal(anonymousOverview.status, 401);
    const adminToken = await loginAdminAt(port);
    const overview = await fetch(`http://127.0.0.1:${port}/api/devbench/ai-training/config-inference?projectId=${projectId}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
      .then((response) => response.json());
    const claimedRuns = (overview.data?.runs || []).filter((run) => run.trigger === "training_random"
      && (run.ticket?.tbTaskId || run.ticket?.ticketId) === tbTaskId);
    assert.equal(claimedRuns.length, 1, "并发竞争后只能创建一条待评分训练 run");

    const exitResponse = await fetch(`http://127.0.0.1:${port}/api/devbench/ai-training/config-inference/session/exit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, sessionId: acquired[0].sessionId }),
    });
    const exited = await exitResponse.json();
    assert.equal(exitResponse.status, 200);
    assert.equal(exited.ok, true);
    assert.ok(Number(exited.released) > 0, `退出训练应释放当前 session 的占用：${JSON.stringify(exited)}`);

    const reacquired = await requestRandom("concurrent-session-after-exit");
    assert.equal(reacquired.status, 200);
    assert.equal(reacquired.body.ok, true);
    assert.notEqual(reacquired.body.complete, true);
    assert.equal(reacquired.body.data?.random?.currentTaskId, tbTaskId);
    assert.notEqual(reacquired.body.data?.id, acquired[0].body.data?.id, "释放后应为新 session 创建新的待评分 run");

    const deletedResponse = await fetch(
      `http://127.0.0.1:${port}/api/devbench/ai-training/config-inference/runs/${reacquired.body.data.id}?projectId=${projectId}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${adminToken}` } },
    );
    const deleted = await deletedResponse.json();
    assert.equal(deletedResponse.status, 200, JSON.stringify(deleted));
    assert.equal(deleted.releasedClaim, true, "删除待评分随机 run 必须同时释放其精确占用");
    const afterDelete = await requestRandom("concurrent-session-after-delete");
    assert.equal(afterDelete.status, 200);
    assert.equal(afterDelete.body.data?.random?.currentTaskId, tbTaskId);
    assert.notEqual(afterDelete.body.data?.id, reacquired.body.data.id, "删除后同一 TB 单应立即可被新会话重新取得");
  } finally {
    child.kill();
  }
});

test("人工复核的代号字段可被模型无关 RAG 召回，删除全部目标会形成负向记忆", () => {
  const ticket = {
    ticketId: "SYMBOLIC-RAG",
    title: "应用市场语音代号配置",
    projectName: "平台组件",
    tasklistName: "应用市场",
  };
  const keywordMappings = {
    title: { "应用市场": { category: "repository", value: "market" } },
  };
  const signals = extractConfigInferenceSignals(ticket, keywordMappings);
  const symbolicTarget = {
    targetId: "symbolic-main",
    appName: "应用市场",
    vehicle: "TARGET_VEHICLE",
    repositoryId: "APP_MARKET_REPOSITORY",
    repositoryName: "应用市场主工程代号",
    branch: "VOICE_FEATURE_BRANCH",
    flavor: "TARGET_BUILD_FLAVOR",
    targetRole: "primary",
    order: 1,
    fieldStates: {
      vehicle: { kind: "symbolic", feature: "目标车型待确认" },
      repositoryId: { kind: "symbolic", feature: "应用市场主工程" },
      branch: { kind: "symbolic", feature: "语音功能开发分支" },
      flavor: { kind: "symbolic", feature: "目标构建变体" },
    },
  };
  const symbolicSample = {
    id: "symbolic-sample",
    source: "user_feedback",
    signals,
    feedback: { decision: "corrected", rating: 5 },
    groundTruth: { targets: [symbolicTarget], noTargets: false },
  };
  const inferred = inferConfigFromTicket({
    ticket,
    projectDefs: PROJECT_DEFS,
    vehicleMap: VEHICLE_MAP,
    keywordMappings,
    samples: [symbolicSample],
  });
  assert.equal(inferred.targets[0].repositoryId, "APP_MARKET_REPOSITORY");
  assert.equal(inferred.targets[0].fieldStates.branch.kind, "symbolic");
  assert.equal(inferred.targets[0].resolutionStatus, "partial");
  assert.equal(inferred.policy.candidateConstrained, false);
  assert.equal(inferred.policy.allowsSymbolicTargets, true);

  const rag = retrieveConfigInferenceMemories({
    projectId: "project-symbolic",
    ticket,
    projectDefs: PROJECT_DEFS,
    vehicleMap: VEHICLE_MAP,
    keywordMappings,
    samples: [symbolicSample],
  });
  assert.equal(rag.memories[0].targets[0].repositoryId, "APP_MARKET_REPOSITORY");
  assert.equal(rag.memories[0].targets[0].fieldStates.flavor.kind, "symbolic");

  const registeredTarget = buildConfigInferenceRegistry(PROJECT_DEFS, VEHICLE_MAP).targets
    .find((target) => target.repositoryId === "market");
  const removalSample = {
    id: "remove-all-sample",
    source: "user_feedback",
    signals,
    feedback: { decision: "corrected", rating: 5 },
    groundTruth: { targets: [], noTargets: true },
    negative: { rejectedTargets: [registeredTarget] },
  };
  const removed = inferConfigFromTicket({
    ticket,
    projectDefs: PROJECT_DEFS,
    vehicleMap: VEHICLE_MAP,
    keywordMappings,
    samples: [removalSample],
  });
  assert.equal(removed.targets.some((target) => target.repositoryId === "market"), false);
  assert.ok(removed.evidence.some((item) => item.kind === "historical_target_removal"));
  const removedRag = retrieveConfigInferenceMemories({
    projectId: "project-symbolic",
    ticket,
    projectDefs: PROJECT_DEFS,
    vehicleMap: VEHICLE_MAP,
    keywordMappings,
    samples: [removalSample],
  });
  assert.equal(removedRag.memories[0].kind, "negative");
  assert.equal(removedRag.memories[0].removedTargets[0].repositoryId, "market");
});

test("配置推理接口支持显式删除全部、代号延期写回及后续原子替换", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "config-inference-symbols-"));
  const port = 28500 + Math.floor(Math.random() * 1000);
  const gwCfg = path.join(tmp, "gateway.json");
  const market = path.join(tmp, "market.json");
  const storeDir = path.join(tmp, "store");
  const dbPath = path.join(tmp, "data.db");
  const totpDir = path.join(tmp, "totp");
  const projectId = "symbolic-project";
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(gwCfg, JSON.stringify({ servers: { nodeId: "symbolic-node" } }), "utf8");
  fs.writeFileSync(market, JSON.stringify({
    projectDefs: PROJECT_DEFS,
    byProject: {
      [projectId]: {
        vehicleMap: VEHICLE_MAP,
        keywordMappings: { title: { "应用市场": { category: "repository", value: "market" } } },
      },
    },
  }), "utf8");
  fs.writeFileSync(path.join(storeDir, "tasks.json"), "[]", "utf8");
  const child = bootGateway({ port, gwCfg, market, storeDir, dbPath, totpDir });
  const request = async (method, pathname, body, token = "") => {
    const response = await fetch(`http://127.0.0.1:${port}/api/devbench${pathname}`, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  let adminToken = "";
  const startRun = (ticketId) => request("POST", "/ai-training/config-inference/run", {
    projectId,
    captureSignals: false,
    ticket: { ticketId, title: "应用市场语音代号配置", projectId, projectName: "平台组件", tasklistName: "应用市场" },
  }, adminToken);

  try {
    await waitHealth(port, child);
    const setup = await fetch(`http://127.0.0.1:${port}/api/admin/auth/totp/setup`).then((response) => response.json());
    const secret = setup.data?.secret || setup.secret;
    const login = await fetch(`http://127.0.0.1:${port}/api/admin/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: totp(secret) }),
    }).then((response) => response.json());
    assert.ok(login.ok && login.token);
    adminToken = login.token;

    const emptyRun = await startRun("DELETE-ALL-TARGETS");
    const accidentalEmpty = await request("POST", `/ai-training/config-inference/runs/${emptyRun.body.data.id}/review`, {
      projectId,
      decision: "corrected",
      rating: 5,
      correctedPrediction: { targets: [] },
      persistConfig: true,
    }, adminToken);
    assert.equal(accidentalEmpty.status, 400);
    assert.match(accidentalEmpty.body.error, /noTargets=true/);
    const confirmedEmpty = await request("POST", `/ai-training/config-inference/runs/${emptyRun.body.data.id}/review`, {
      projectId,
      decision: "corrected",
      rating: 5,
      correctedPrediction: { targets: [], noTargets: true },
      persistConfig: true,
    }, adminToken);
    assert.equal(confirmedEmpty.status, 200, confirmedEmpty.body.error);
    assert.equal(confirmedEmpty.body.learned, false);
    assert.equal(confirmedEmpty.body.annotationPending, true);
    assert.equal(confirmedEmpty.body.sample.groundTruth.noTargets, true);
    assert.equal(confirmedEmpty.body.sample.negative.rejectedTargets.length > 0, true);
    assert.equal(confirmedEmpty.body.snapshot, null);

    const symbolicRun = await startRun("SYMBOLIC-TARGET");
    const symbolicTarget = {
      targetId: "target-symbolic-main",
      appName: "应用市场",
      vehicle: "TARGET_VEHICLE",
      repositoryId: "APP_MARKET_REPOSITORY",
      repositoryName: "应用市场主工程代号",
      branch: "VOICE_FEATURE_BRANCH",
      flavor: "TARGET_BUILD_FLAVOR",
      targetRole: "primary",
      order: 1,
      fieldStates: {
        vehicle: { kind: "symbolic", feature: "目标车型" },
        repositoryId: { kind: "symbolic", feature: "应用市场主工程" },
        branch: { kind: "symbolic", feature: "语音功能分支" },
        flavor: { kind: "symbolic", feature: "目标构建变体" },
      },
    };
    const anonymousOverview = await request("GET", `/ai-training/config-inference?projectId=${projectId}`);
    assert.equal(anonymousOverview.status, 401);
    const registryBeforeSymbolic = (
      await request("GET", `/ai-training/config-inference?projectId=${projectId}`, undefined, adminToken)
    ).body.data.registry;
    const symbolicReview = await request("POST", `/ai-training/config-inference/runs/${symbolicRun.body.data.id}/review`, {
      projectId,
      decision: "corrected",
      rating: 5,
      correctedPrediction: { targets: [symbolicTarget], noTargets: false },
      persistConfig: true,
    }, adminToken);
    assert.equal(symbolicReview.status, 200, symbolicReview.body.error);
    assert.equal(symbolicReview.body.configurationUpdates.changed, false);
    assert.equal(symbolicReview.body.configurationUpdates.deferred, true);
    assert.deepEqual(symbolicReview.body.configurationUpdates.unresolved[0].fields, ["vehicle", "repositoryId", "branch", "flavor"]);
    const symbolicSampleTarget = symbolicReview.body.sample.groundTruth.targets[0];
    assert.equal(symbolicSampleTarget.fieldStates.repositoryId.kind, "symbolic");
    const symbolicLogicalKeys = {};
    for (const field of ["vehicle", "repositoryId", "branch", "flavor"]) {
      symbolicLogicalKeys[field] = symbolicSampleTarget.fieldBindings?.[field]?.logicalKey;
      assert.ok(symbolicLogicalKeys[field], `未解析的 symbolic ${field} 必须先沉淀永久 Key`);
      assert.equal(symbolicSampleTarget.fieldBindings[field].resolved, false);
    }
    assert.equal(symbolicReview.body.snapshot, null);
    const registryAfterSymbolic = (
      await request("GET", `/ai-training/config-inference?projectId=${projectId}`, undefined, adminToken)
    ).body.data.registry;
    assert.deepEqual(registryAfterSymbolic.projectDefs, registryBeforeSymbolic.projectDefs, "代号目标不能污染真实仓库定义");
    assert.deepEqual(registryAfterSymbolic.vehicleMap, registryBeforeSymbolic.vehicleMap, "代号目标不能污染真实车型配置");

    const rag = await request("POST", "/ai-training/config-inference/rag", {
      projectId,
      ticket: { ticketId: "SYMBOLIC-RAG-NEXT", title: "应用市场语音代号配置", projectId, projectName: "平台组件", tasklistName: "应用市场" },
    });
    assert.equal(rag.status, 200);
    assert.equal(
      rag.body.data.memories.some((memory) => memory.id === symbolicReview.body.sample.id),
      false,
      "未解析且未双审批准的 symbolic annotation 不得进入 serving RAG",
    );

    const resolvedTarget = {
      targetId: "target-symbolic-main",
      appName: "应用市场",
      vehicle: "阿维塔 8678",
      repositoryId: "market",
      repositoryName: "应用市场",
      gitUrl: "git@example.com:apps/market.git",
      branch: "feature/voice-real",
      flavor: "voiceRealFlavor",
      targetRole: "primary",
      order: 1,
      fieldStates: {},
    };
    const resolved = await request("POST", `/ai-training/config-inference/runs/${symbolicRun.body.data.id}/resolve-symbols`, {
      projectId,
      correctedPrediction: { targets: [resolvedTarget] },
      persistConfig: true,
    }, adminToken);
    assert.equal(resolved.status, 200, resolved.body.error);
    assert.equal(resolved.body.configurationUpdates.changed, true);
    assert.equal(resolved.body.revision.resolvedFields.length, 4);
    assert.deepEqual(resolved.body.revision.unresolved, []);
    assert.ok(resolved.body.snapshot);
    const resolvedSampleTarget = resolved.body.sample.groundTruth.targets[0];
    assert.equal(resolvedSampleTarget.fieldStates, undefined);
    for (const field of ["vehicle", "repositoryId", "branch", "flavor"]) {
      assert.equal(
        resolvedSampleTarget.fieldBindings?.[field]?.logicalKey,
        symbolicLogicalKeys[field],
        `symbolic ${field} 解析成实际值后永久 Key 不能变化`,
      );
      assert.equal(
        Object.hasOwn(resolvedSampleTarget.fieldBindings[field], "resolved"),
        false,
        `共享 sample 的 ${field} binding 只持久化 logicalKey，resolved 由读取视图物化`,
      );
    }

    const overview = await request(
      "GET",
      `/ai-training/config-inference?projectId=${projectId}`,
      undefined,
      adminToken,
    );
    assert.equal(overview.body.data.metrics.noTargetSamples, 0);
    assert.equal(overview.body.data.metrics.symbolicSamples, 0);
    assert.equal(overview.body.data.metrics.pendingAnnotations, 2);
    const marketDef = overview.body.data.registry.projectDefs.find((def) => def.id === "market");
    assert.ok(marketDef.branchOptions.includes("feature/voice-real"));
    assert.ok(marketDef.flavorOptions.includes("voiceRealFlavor"));
    const resolvedApp = overview.body.data.registry.vehicleMap["阿维塔 8678"].apps.find((app) => app.appName === "应用市场");
    assert.ok(resolvedApp.repos.some((repo) => repo.repoId === "market" && repo.branch === "feature/voice-real" && repo.flavor === "voiceRealFlavor"));
    for (const [field, actualValue] of Object.entries({
      vehicle: "阿维塔 8678",
      repositoryId: "market",
      branch: "feature/voice-real",
      flavor: "voiceRealFlavor",
    })) {
      const binding = overview.body.data.valueBindings.find((row) => row.logicalKey === symbolicLogicalKeys[field]);
      assert.ok(binding, `symbolic ${field} 解析后必须进入中央 valueBindings`);
      assert.equal(binding.actualValue, actualValue);
    }

    const resolvedBranchBinding = overview.body.data.valueBindings
      .find((row) => row.logicalKey === symbolicLogicalKeys.branch);
    const branchReplaced = await request(
      "PUT",
      `/ai-training/config-inference/value-bindings/${encodeURIComponent(symbolicLogicalKeys.branch)}`,
      {
        projectId,
        actualValue: "feature/voice-after-symbol-resolution",
        expectedRevision: resolvedBranchBinding.revision,
        persistConfig: false,
      },
      adminToken,
    );
    assert.equal(branchReplaced.status, 200, branchReplaced.body.error);
    assert.equal((branchReplaced.body.binding || branchReplaced.body.data).logicalKey, symbolicLogicalKeys.branch);
    const overviewAfterReplacement = await request(
      "GET",
      `/ai-training/config-inference?projectId=${projectId}`,
      undefined,
      adminToken,
    );
    const replacedTarget = overviewAfterReplacement.body.data.samples
      .find((sample) => sample.id === resolved.body.sample.id)?.groundTruth?.targets?.[0];
    assert.equal(replacedTarget.branch, "feature/voice-after-symbol-resolution");
    assert.equal(replacedTarget.fieldBindings.branch.logicalKey, symbolicLogicalKeys.branch);
  } finally {
    child.kill();
  }
});

test("不同仓库共用同一代号值时仍保留各自独立目标", () => {
  const sharedFieldState = { branch: { kind: "symbolic", feature: "待确定的功能开发分支" } };
  const targets = normalizeConfigInferenceTargets([
    {
      targetId: "symbolic-market",
      appName: "应用市场",
      vehicle: "阿维塔 8678",
      repositoryId: "market",
      repositoryName: "应用市场",
      branch: "FEATURE_BRANCH",
      flavor: "avatr8678Prod",
      targetRole: "primary",
      order: 1,
      fieldStates: sharedFieldState,
    },
    {
      targetId: "symbolic-web",
      appName: "应用市场",
      vehicle: "阿维塔 8678",
      repositoryId: "web",
      repositoryName: "WebApp",
      branch: "FEATURE_BRANCH",
      flavor: "web8678",
      targetRole: "dependency",
      order: 2,
      fieldStates: sharedFieldState,
    },
  ]);

  assert.equal(targets.length, 2, "相同代号只能表示字段值，不能成为跨仓库的目标去重键");
  assert.deepEqual(targets.map((target) => target.repositoryId), ["market", "web"]);
  assert.deepEqual(targets.map((target) => target.targetId), ["symbolic-market", "symbolic-web"]);
});

function fullySymbolicTwinTargets() {
  const fieldStates = Object.fromEntries(CONFIG_INFERENCE_DIMENSIONS.map((field) => [
    field,
    { kind: "symbolic", feature: `共同${field}特征` },
  ]));
  const base = {
    appName: "SHARED_APP_ALIAS",
    vehicle: "SHARED_VEHICLE_ALIAS",
    repositoryId: "SHARED_REPOSITORY_ALIAS",
    repositoryName: "共同代号工程",
    branch: "SHARED_BRANCH_ALIAS",
    flavor: "SHARED_FLAVOR_ALIAS",
    projectType: "application",
  };
  return [
    {
      ...base,
      targetId: "fully-symbolic-A",
      gitUrl: "https://git.example.com/team/fully-symbolic-a.git",
      targetRole: "primary",
      order: 1,
      fieldStates: JSON.parse(JSON.stringify(fieldStates)),
    },
    {
      ...base,
      targetId: "fully-symbolic-B",
      gitUrl: "https://git.example.com/team/fully-symbolic-b.git",
      targetRole: "dependency",
      order: 2,
      fieldStates: JSON.parse(JSON.stringify(fieldStates)),
    },
  ];
}

test("全五维同代号同特征但 targetId 和 Git URL 不同的目标 normalize 后仍为两个", () => {
  const normalized = normalizeConfigInferenceTargets(fullySymbolicTwinTargets());

  assert.equal(normalized.length, 2, "全五维代号相同不能覆盖用户显式创建的两个不同工程目标");
  assert.deepEqual(normalized.map((target) => target.targetId), ["fully-symbolic-A", "fully-symbolic-B"]);
  assert.deepEqual(normalized.map((target) => target.gitUrl), [
    "https://git.example.com/team/fully-symbolic-a.git",
    "https://git.example.com/team/fully-symbolic-b.git",
  ]);
  for (const target of normalized) {
    assert.deepEqual(Object.keys(target.fieldStates).sort(), [...CONFIG_INFERENCE_DIMENSIONS].sort());
  }
});

test("新 3★ corrected 删除 B 覆盖旧 5★ A+B 且推理和 RAG 不受样本顺序影响", () => {
  const ticket = { ticketId: "SYMBOLIC-AB-CORRECTION", title: "全五维共同代号工程训练" };
  const signals = extractConfigInferenceSignals(ticket, {});
  const [targetA, targetB] = fullySymbolicTwinTargets();
  const oldPositive = {
    id: "old-five-star-ab",
    source: "user_feedback",
    signals,
    feedback: { decision: "correct", rating: 5, score: 5 },
    groundTruth: { targets: [targetA, targetB], noTargets: false },
    createdAt: 1000,
    updatedAt: 1000,
  };
  const newerCorrection = {
    id: "new-default-three-star-keep-a",
    source: "user_feedback",
    signals,
    feedback: {
      decision: "corrected",
      rating: 3,
      score: 3,
      rejectedPrediction: { targets: [targetB] },
    },
    groundTruth: { targets: [targetA], noTargets: false },
    negative: { policyVersion: 1, rejectedTargets: [targetB] },
    createdAt: 2000,
    updatedAt: 2000,
  };
  const sampleOrders = [
    [oldPositive, newerCorrection],
    [newerCorrection, oldPositive],
  ];
  const semantics = [];

  for (const samples of sampleOrders) {
    const inferred = inferConfigFromTicket({
      ticket,
      projectDefs: PROJECT_DEFS,
      vehicleMap: VEHICLE_MAP,
      samples,
    });
    assert.deepEqual(inferred.targets.map((target) => target.targetId), [targetA.targetId]);
    assert.equal(inferred.targets.some((target) => target.targetId === targetB.targetId), false);
    assert.ok(inferred.evidence.some((item) => item.kind === "historical_target_removal"));

    const rag = retrieveConfigInferenceMemories({
      projectId: "symbolic-ab-correction-project",
      ticket,
      projectDefs: PROJECT_DEFS,
      vehicleMap: VEHICLE_MAP,
      samples,
    });
    assert.deepEqual(rag.inference.targets.map((target) => target.targetId), [targetA.targetId]);
    const retainedIds = [...new Set(rag.memories.flatMap((memory) => (
      memory.targets || []
    )).map((target) => target.targetId))].sort();
    const removedIds = [...new Set(rag.memories.flatMap((memory) => (
      memory.removedTargets || []
    )).map((target) => target.targetId))].sort();
    assert.deepEqual(retainedIds, [targetA.targetId], "RAG 正向事实不能继续暴露已被新反馈删除的 B");
    assert.deepEqual(removedIds, [targetB.targetId], "B 必须作为明确删除目标进入 removedTargets");
    const correctionMemory = rag.memories.find((memory) => memory.id === newerCorrection.id);
    assert.deepEqual(correctionMemory?.targets.map((target) => target.targetId), [targetA.targetId]);
    assert.deepEqual(correctionMemory?.removedTargets.map((target) => target.targetId), [targetB.targetId]);

    semantics.push({
      inferredTargets: inferred.targets.map((target) => target.targetId),
      ragTargets: rag.inference.targets.map((target) => target.targetId),
      retainedIds,
      removedIds,
    });
  }
  assert.deepEqual(semantics[1], semantics[0]);
});

test("删除主工程后已登记依赖提升为主工程并被下一次推理召回", () => {
  const projectDefs = [
    { id: "appMarket", name: "应用市场", ssh: "git@example.com:apps/market.git" },
    {
      id: "appMarketSdk",
      name: "应用市场SDK",
      ssh: "git@example.com:sdk/app-market.git",
      projectType: "sdk",
      inferenceKeywords: ["语音", "voice", "tts"],
      requiresRepositories: ["appMarket"],
      inheritVariant: ["vehicle"],
      defaultBranch: "feat/voice-sdk",
    },
  ];
  const vehicleMap = {
    avatr8678: {
      aliases: ["阿维塔", "8678"],
      apps: [{ appName: "应用市场", repos: [{ repoId: "appMarket", branch: "release/avatr", flavor: "avatr8678" }] }],
    },
  };
  const ticket = {
    ticketId: "PROMOTE-DEPENDENCY",
    title: "【阿维塔】【语音】打开未安装应用时 tts 播报错误",
    tags: ["阿维塔"],
  };
  const keywordMappings = { tag: { "阿维塔": { category: "vehicle", value: "avatr8678" } } };
  const original = inferConfigFromTicket({ ticket, projectDefs, vehicleMap, keywordMappings });
  assert.deepEqual(original.targets.map((target) => target.repositoryId), ["appMarket", "appMarketSdk"]);

  const removedPrimary = original.targets[0];
  const promotedDependency = {
    ...original.targets[1],
    targetId: "promoted-sdk",
    targetRole: "primary",
    order: 1,
  };
  const sample = {
    id: "promote-dependency-review",
    source: "user_feedback",
    signals: original.signals,
    feedback: { decision: "corrected", rating: 5 },
    groundTruth: { targets: [promotedDependency], noTargets: false },
    negative: { policyVersion: 1, rejectedTargets: [removedPrimary] },
  };
  const learned = inferConfigFromTicket({ ticket, projectDefs, vehicleMap, keywordMappings, samples: [sample] });

  assert.deepEqual(learned.targets.map((target) => target.repositoryId), ["appMarketSdk"]);
  assert.equal(learned.targets[0].targetRole, "primary");
  assert.equal(learned.targets[0].order, 1);
  assert.ok(learned.evidence.some((item) => item.kind === "historical_feedback" && item.value.includes("appMarketSdk")));

  const rag = retrieveConfigInferenceMemories({
    projectId: "promote-dependency-project",
    ticket,
    projectDefs,
    vehicleMap,
    keywordMappings,
    samples: [sample],
  });
  const memoryTarget = rag.memories.find((memory) => memory.id === sample.id)?.targets?.[0];
  assert.equal(memoryTarget?.repositoryId, "appMarketSdk");
  assert.equal(memoryTarget?.targetRole, "primary");
  assert.equal(memoryTarget?.order, 1);
});

test("symbolic 删除负反馈的结果不受正负样本排列顺序影响", () => {
  const ticket = { ticketId: "SYMBOLIC-ORDER", title: "应用市场语音代号分支" };
  const signals = extractConfigInferenceSignals(ticket, {});
  const symbolicTarget = {
    targetId: "shared-symbolic-target",
    appName: "应用市场",
    vehicle: "阿维塔 8678",
    repositoryId: "market",
    repositoryName: "应用市场",
    branch: "VOICE_BRANCH",
    flavor: "avatr8678Prod",
    targetRole: "primary",
    order: 1,
    fieldStates: { branch: { kind: "symbolic", feature: "语音功能开发分支" } },
  };
  const positive = {
    id: "symbolic-positive",
    source: "user_feedback",
    signals,
    feedback: { decision: "corrected", rating: 5 },
    groundTruth: { targets: [symbolicTarget], noTargets: false },
  };
  const negative = {
    id: "symbolic-negative",
    source: "user_feedback",
    signals,
    feedback: { decision: "corrected", rating: 5 },
    groundTruth: { targets: [], noTargets: true },
    negative: { policyVersion: 1, rejectedTargets: [symbolicTarget] },
  };
  const positiveThenNegative = inferConfigFromTicket({
    ticket,
    projectDefs: PROJECT_DEFS,
    vehicleMap: VEHICLE_MAP,
    samples: [positive, negative],
  });
  const negativeThenPositive = inferConfigFromTicket({
    ticket,
    projectDefs: PROJECT_DEFS,
    vehicleMap: VEHICLE_MAP,
    samples: [negative, positive],
  });

  assert.deepEqual(negativeThenPositive.targets, positiveThenNegative.targets);
  assert.equal(positiveThenNegative.targets.some((target) => target.targetId === symbolicTarget.targetId), false);
  assert.equal(negativeThenPositive.targets.some((target) => target.targetId === symbolicTarget.targetId), false);
  for (const result of [positiveThenNegative, negativeThenPositive]) {
    assert.ok(result.evidence.some((item) => item.kind === "historical_target_removal"));
  }
});

async function loginAdminAt(port) {
  const setup = await fetch(`http://127.0.0.1:${port}/api/admin/auth/totp/setup`).then((response) => response.json());
  const secret = setup.data?.secret || setup.secret;
  assert.ok(secret, "未拿到隔离 TOTP 密钥");
  const login = await fetch(`http://127.0.0.1:${port}/api/admin/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: totp(secret) }),
  }).then((response) => response.json());
  assert.ok(login.ok && login.token, "TOTP 登录失败");
  return login.token;
}

async function loginStableReviewersAt(port, superToken, label = "config-inference") {
  const tokens = [];
  for (const suffix of ["a", "b"]) {
    const dingUserid = `${label}-${port}-reviewer-${suffix}`;
    const added = await fetch(`http://127.0.0.1:${port}/api/admin/users`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${superToken}`,
      },
      body: JSON.stringify({ dingUserid, name: `测试稳定评审人 ${suffix.toUpperCase()}` }),
    });
    assert.equal(added.status, 200, await added.text());
    const login = await fetch(`http://127.0.0.1:${port}/api/admin/auth/ding-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dingUserid }),
    }).then((response) => response.json());
    assert.equal(login.ok, true, login.error);
    assert.ok(login.token);
    tokens.push(login.token);
  }
  return tokens;
}

async function approveReviewedAnnotationAt(fixture, reviewed, reviewerTokens) {
  return approveReviewedAnnotationAtPort(
    fixture.port,
    fixture.projectId,
    reviewed.body,
    reviewerTokens,
  );
}

async function approveReviewedAnnotationAtPort(port, projectId, reviewed, reviewerTokens) {
  assert.equal(reviewed.learned, false);
  assert.equal(reviewed.annotationPending, true);
  const annotationId = reviewed.sample?.id;
  assert.ok(annotationId);
  let approval = null;
  for (const [index, token] of reviewerTokens.entries()) {
    const response = await fetch(
      `http://127.0.0.1:${port}/api/devbench/ai-training/v2/annotations/${encodeURIComponent(annotationId)}/approve`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          projectId,
        vote: {
            decision: reviewed.sample.feedback?.decision,
            noTargets: reviewed.sample.groundTruth?.noTargets === true,
            targets: reviewed.sample.groundTruth?.targets || [],
          },
          reason: `第 ${index + 1} 位稳定评审`,
        }),
      },
    );
    approval = { status: response.status, body: await response.json() };
    assert.equal(approval.status, 200, approval.body.error);
  }
  assert.equal(approval.body.learned, true);
  assert.equal(approval.body.data.servingStatus, "approved");
  return approval;
}

async function bootSymbolicInvariantFixture(label, { tasks = [] } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `config-inference-${label}-`));
  const port = 30000 + Math.floor(Math.random() * 1500);
  const gwCfg = path.join(tmp, "gateway.json");
  const market = path.join(tmp, "market.json");
  const storeDir = path.join(tmp, "store");
  const dbPath = path.join(tmp, "data.db");
  const totpDir = path.join(tmp, "totp");
  const projectId = `${label}-project`;
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(gwCfg, JSON.stringify({ servers: { nodeId: `${label}-node` } }), "utf8");
  fs.writeFileSync(market, JSON.stringify({
    projectDefs: PROJECT_DEFS,
    byProject: {
      [projectId]: {
        vehicleMap: VEHICLE_MAP,
        keywordMappings: { title: { "应用市场": { category: "repository", value: "market" } } },
      },
    },
  }), "utf8");
  fs.writeFileSync(path.join(storeDir, "tasks.json"), JSON.stringify(tasks), "utf8");
  const child = bootGateway({ port, gwCfg, market, storeDir, dbPath, totpDir });
  await waitHealth(port, child);
  const authenticatedReadToken = await loginAdminAt(port);
  const request = async (method, pathname, body, token) => {
    const effectiveToken = token === null ? "" : (token || authenticatedReadToken);
    const response = await fetch(`http://127.0.0.1:${port}/api/devbench${pathname}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(effectiveToken ? { Authorization: `Bearer ${effectiveToken}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const loginAdmin = async () => authenticatedReadToken;
  const loginReviewers = () => loginStableReviewersAt(port, authenticatedReadToken, label);
  let runSequence = 0;
  const startRun = async (suffix) => request("POST", "/ai-training/config-inference/run", {
    projectId,
    captureSignals: false,
    ticket: {
      ticketId: `${label}-${suffix}-${++runSequence}`,
      title: "应用市场语音代号配置",
      projectId,
      projectName: "平台组件",
      tasklistName: "应用市场",
    },
  });
  return {
    child,
    tmp,
    gwCfg,
    market,
    storeDir,
    dbPath,
    totpDir,
    port,
    projectId,
    request,
    startRun,
    loginAdmin,
    loginReviewers,
  };
}

async function bootSymbolicInvariantPeer(fixture, label) {
  const port = 38000 + Math.floor(Math.random() * 1000);
  const gwCfg = path.join(fixture.tmp, `${label}-gateway.json`);
  const storeDir = path.join(fixture.tmp, `${label}-store`);
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(gwCfg, JSON.stringify({ servers: { nodeId: `${label}-node` } }), "utf8");
  const child = bootGateway({
    port,
    gwCfg,
    market: fixture.market,
    storeDir,
    dbPath: fixture.dbPath,
    totpDir: fixture.totpDir,
  });
  await waitHealth(port, child);
  const authenticatedReadToken = await loginAdminAt(port);
  const request = async (method, pathname, body, token) => {
    const effectiveToken = token === null ? "" : (token || authenticatedReadToken);
    const response = await fetch(`http://127.0.0.1:${port}/api/devbench${pathname}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(effectiveToken ? { Authorization: `Bearer ${effectiveToken}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  return { child, port, request, loginAdmin: async () => authenticatedReadToken };
}

function symbolicResolutionPair() {
  return [
    {
      targetId: "symbol-main",
      appName: "应用市场",
      vehicle: "阿维塔 8678",
      repositoryId: "market",
      repositoryName: "应用市场",
      gitUrl: "git@example.com:apps/market.git",
      branch: "MAIN_BRANCH_ALIAS",
      flavor: "avatr8678Prod",
      targetRole: "primary",
      order: 1,
      fieldStates: { branch: { kind: "symbolic", feature: "主工程开发分支" } },
    },
    {
      targetId: "symbol-dependency",
      appName: "应用市场",
      vehicle: "阿维塔 8678",
      repositoryId: "web",
      repositoryName: "WebApp",
      gitUrl: "https://example.com/apps/web.git",
      branch: "DEPENDENCY_BRANCH_ALIAS",
      flavor: "web8678",
      targetRole: "dependency",
      order: 2,
      fieldStates: { branch: { kind: "symbolic", feature: "依赖工程开发分支" } },
    },
  ];
}

test("RAG 永久 Key 仅管理员可替换实际值，连续替换读时物化且 revision 冲突不覆盖新值", async () => {
  const fixture = await bootSymbolicInvariantFixture("value-binding-lifecycle");
  try {
    const run = await fixture.startRun("learned-target");
    assert.equal(run.status, 200, run.body.error);
    const learnedTarget = run.body.data.prediction.targets.find((target) => target.repositoryId === "market")
      || run.body.data.prediction.targets[0];
    assert.ok(learnedTarget, "推理结果缺少可学习工程目标");
    const originalBranch = learnedTarget.branch;
    const logicalKey = learnedTarget.fieldBindings?.branch?.logicalKey;
    assert.ok(logicalKey, "推理目标必须携带 branch 永久 logicalKey");

    const tamperedTarget = structuredClone(learnedTarget);
    tamperedTarget.fieldBindings.branch.logicalKey = `${logicalKey}.tampered`;
    const tamperedReview = await fixture.request(
      "POST",
      `/ai-training/config-inference/runs/${run.body.data.id}/review`,
      {
        projectId: fixture.projectId,
        decision: "corrected",
        rating: 5,
        correctedPrediction: { targets: [tamperedTarget], noTargets: false },
        persistConfig: false,
      },
    );
    assert.equal(tamperedReview.status, 400);
    assert.match(tamperedReview.body.error, /logicalKey.*不能修改/);

    const adminToken = await fixture.loginAdmin();
    const reviewed = await fixture.request(
      "POST",
      `/ai-training/config-inference/runs/${run.body.data.id}/review`,
      {
        projectId: fixture.projectId,
        decision: "corrected",
        rating: 5,
        correctedPrediction: { targets: [learnedTarget], noTargets: false },
        persistConfig: false,
      },
      adminToken,
    );
    assert.equal(reviewed.status, 200, reviewed.body.error);
    const reviewerTokens = await fixture.loginReviewers();
    await approveReviewedAnnotationAt(fixture, reviewed, reviewerTokens);
    const sampleId = reviewed.body.sample.id;
    const reviewedSampleTarget = reviewed.body.sample.groundTruth.targets[0];
    assert.equal(reviewedSampleTarget.fieldBindings.branch.logicalKey, logicalKey);
    assert.equal(reviewedSampleTarget.branch, originalBranch);

    const overviewBefore = await fixture.request("GET", `/ai-training/config-inference?projectId=${fixture.projectId}`);
    assert.equal(overviewBefore.status, 200, overviewBefore.body.error);
    const bindingBefore = overviewBefore.body.data.valueBindings.find((binding) => binding.logicalKey === logicalKey);
    assert.ok(bindingBefore, `overview 缺少永久 Key ${logicalKey}`);
    const initialRevision = bindingBefore.revision;
    const bindingPath = `/ai-training/config-inference/value-bindings/${encodeURIComponent(logicalKey)}`;

    const forbidden = await fixture.request("PUT", bindingPath, {
      projectId: fixture.projectId,
      actualValue: "feature/forbidden",
      expectedRevision: initialRevision,
      persistConfig: true,
    }, null);
    assert.equal(forbidden.status, 403);
    assert.match(forbidden.body.error, /管理员/);

    const immutableKey = await fixture.request("PUT", bindingPath, {
      projectId: fixture.projectId,
      logicalKey: `${logicalKey}.changed`,
      actualValue: "feature/must-not-change-key",
      expectedRevision: initialRevision,
      persistConfig: true,
    }, adminToken);
    assert.equal(immutableKey.status, 400);
    assert.match(immutableKey.body.error, /logicalKey.*不能修改/);

    const isolated = await fixture.request("PUT", bindingPath, {
      projectId: `${fixture.projectId}-other`,
      actualValue: "feature/must-not-cross-project",
      expectedRevision: initialRevision,
      persistConfig: true,
    }, adminToken);
    assert.equal(isolated.status, 404);

    const firstValue = "feature/rag-binding-first";
    const first = await fixture.request("PUT", bindingPath, {
      projectId: fixture.projectId,
      actualValue: firstValue,
      expectedRevision: initialRevision,
      persistConfig: true,
    }, adminToken);
    assert.equal(first.status, 200, first.body.error);
    const firstBinding = first.body.binding || first.body.data;
    assert.equal(firstBinding.logicalKey, logicalKey);
    assert.equal(firstBinding.actualValue, firstValue);
    assert.equal(firstBinding.revision, initialRevision + 1);

    const overviewAfterFirst = await fixture.request("GET", `/ai-training/config-inference?projectId=${fixture.projectId}`);
    const overviewFirstBinding = overviewAfterFirst.body.data.valueBindings.find((binding) => binding.logicalKey === logicalKey);
    const overviewFirstTarget = overviewAfterFirst.body.data.samples
      .find((sample) => sample.id === sampleId)?.groundTruth?.targets?.[0];
    assert.equal(overviewFirstBinding.actualValue, firstValue);
    assert.equal(overviewFirstBinding.logicalKey, logicalKey);
    assert.equal(overviewFirstTarget.branch, firstValue);
    assert.equal(overviewFirstTarget.fieldBindings.branch.logicalKey, logicalKey);

    const secondValue = "feature/rag-binding-second";
    const second = await fixture.request("PUT", bindingPath, {
      projectId: fixture.projectId,
      actualValue: secondValue,
      expectedRevision: firstBinding.revision,
      persistConfig: true,
    }, adminToken);
    assert.equal(second.status, 200, second.body.error);
    const secondBinding = second.body.binding || second.body.data;
    assert.equal(secondBinding.logicalKey, logicalKey);
    assert.equal(secondBinding.actualValue, secondValue);
    assert.equal(secondBinding.revision, initialRevision + 2);

    const stale = await fixture.request("PUT", bindingPath, {
      projectId: fixture.projectId,
      actualValue: "feature/stale-must-not-win",
      expectedRevision: firstBinding.revision,
      persistConfig: true,
    }, adminToken);
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, "CONFIG_INFERENCE_BINDING_REVISION_CONFLICT");
    assert.equal(stale.body.current.logicalKey, logicalKey);
    assert.equal(stale.body.current.actualValue, secondValue);
    assert.equal(stale.body.current.revision, secondBinding.revision);

    const overviewAfterSecond = await fixture.request("GET", `/ai-training/config-inference?projectId=${fixture.projectId}`);
    const overviewSecondBinding = overviewAfterSecond.body.data.valueBindings.find((binding) => binding.logicalKey === logicalKey);
    const overviewSecondTarget = overviewAfterSecond.body.data.samples
      .find((sample) => sample.id === sampleId)?.groundTruth?.targets?.[0];
    assert.equal(overviewSecondBinding.actualValue, secondValue);
    assert.equal(overviewSecondBinding.revision, secondBinding.revision);
    assert.equal(overviewSecondTarget.branch, secondValue);
    assert.equal(overviewSecondTarget.fieldBindings.branch.logicalKey, logicalKey);

    const rag = await fixture.request("POST", "/ai-training/config-inference/rag", {
      projectId: fixture.projectId,
      ticket: run.body.data.ticket,
    });
    assert.equal(rag.status, 200, rag.body.error);
    const ragTarget = rag.body.data.memories
      .find((memory) => memory.id === sampleId)?.targets
      ?.find((target) => target.fieldBindings?.branch?.logicalKey === logicalKey);
    assert.ok(ragTarget, "RAG 结果缺少已学习样本及永久 Key");
    assert.equal(ragTarget.branch, secondValue);
    assert.equal(ragTarget.fieldBindings.branch.actualValue, secondValue);
    assert.equal(ragTarget.fieldBindings.branch.revision, secondBinding.revision);

    const sharedBundle = await fetch(`http://127.0.0.1:${fixture.port}/api/discovery/shared-bundle`)
      .then((response) => response.json());
    assert.equal(sharedBundle.ok, true);
    const rawInference = sharedBundle.data.aiTrainingSnapshot.byProject[fixture.projectId].configInference;
    const rawTarget = rawInference.samples[sampleId].groundTruth.targets[0];
    assert.ok(rawTarget, JSON.stringify(rawInference.samples[sampleId], null, 2));
    assert.equal(rawTarget.branch, originalBranch, "替换实际值不能改写 raw 学习样本");
    assert.equal(rawTarget.fieldBindings.branch.logicalKey, logicalKey, "raw 样本必须永久保留 logicalKey");
    assert.equal(rawInference.valueBindings[logicalKey].actualValue, secondValue);
  } finally {
    fixture.child.kill();
  }
});

test("依赖工程 logicalKey 替换实际值时按完整工程图持久化并保留主依赖角色", async () => {
  const fixture = await bootSymbolicInvariantFixture("dependency-binding-persist");
  try {
    const run = await fixture.startRun("dependency-branch");
    assert.equal(run.status, 200, run.body.error);
    const reviewedTargets = [
      {
        targetId: "binding-primary",
        appName: "应用市场",
        vehicle: "阿维塔 8678",
        repositoryId: "market",
        repositoryName: "应用市场",
        gitUrl: "git@example.com:apps/market.git",
        branch: "release/avatr",
        flavor: "avatr8678Prod",
        targetRole: "primary",
        order: 1,
      },
      {
        targetId: "binding-dependency",
        appName: "应用市场",
        vehicle: "阿维塔 8678",
        repositoryId: "web",
        repositoryName: "WebApp",
        gitUrl: "https://example.com/apps/web.git",
        branch: "DEPENDENCY_BINDING_ALIAS",
        flavor: "web8678",
        targetRole: "dependency",
        order: 2,
        fieldStates: { branch: { kind: "symbolic", feature: "依赖工程待替换分支" } },
      },
    ];

    const adminToken = await fixture.loginAdmin();
    const reviewed = await fixture.request(
      "POST",
      `/ai-training/config-inference/runs/${run.body.data.id}/review`,
      {
        projectId: fixture.projectId,
        decision: "corrected",
        rating: 5,
        correctedPrediction: { targets: reviewedTargets, noTargets: false },
        persistConfig: false,
      },
      adminToken,
    );
    assert.equal(reviewed.status, 200, reviewed.body.error);
    const dependencyLogicalKey = reviewed.body.sample.groundTruth.targets
      .find((target) => target.targetId === "binding-dependency")?.fieldBindings?.branch?.logicalKey;
    assert.ok(dependencyLogicalKey);

    const before = await fixture.request("GET", `/ai-training/config-inference?projectId=${fixture.projectId}`);
    const binding = before.body.data.valueBindings.find((row) => row.logicalKey === dependencyLogicalKey);
    assert.ok(binding);
    const actualBranch = "feature/dependency-binding-real";
    const replaced = await fixture.request(
      "PUT",
      `/ai-training/config-inference/value-bindings/${encodeURIComponent(dependencyLogicalKey)}`,
      {
        projectId: fixture.projectId,
        actualValue: actualBranch,
        expectedRevision: binding.revision,
        persistConfig: true,
      },
      adminToken,
    );
    assert.equal(replaced.status, 200, replaced.body.error);
    assert.equal(replaced.body.configurationUpdates.changed, true);

    const after = await fixture.request("GET", `/ai-training/config-inference?projectId=${fixture.projectId}`);
    const app = after.body.data.registry.vehicleMap["阿维塔 8678"].apps
      .find((item) => item.appName === "应用市场");
    const persistedPrimary = app.repos.find((repo) => repo.repoId === "market" && repo.branch === "release/avatr");
    const persistedDependency = app.repos.find((repo) => repo.repoId === "web" && repo.branch === actualBranch);
    assert.equal(persistedPrimary?.targetRole, "primary");
    assert.equal(persistedPrimary?.order, 1);
    assert.equal(persistedDependency?.targetRole, "dependency");
    assert.equal(persistedDependency?.order, 2);
    const registryDependency = after.body.data.registry.targets.find((target) => (
      target.repositoryId === "web" && target.branch === actualBranch
    ));
    assert.equal(registryDependency?.targetRole, "dependency");
    assert.equal(registryDependency?.order, 2);
  } finally {
    fixture.child.kill();
  }
});

test("两个 Gateway 基于同一 revision 并发替换 RAG 实际值时只能一个成功", async () => {
  const fixture = await bootSymbolicInvariantFixture("value-binding-concurrency");
  let peer = null;
  try {
    const run = await fixture.startRun("shared-revision");
    assert.equal(run.status, 200, run.body.error);
    const target = run.body.data.prediction.targets.find((item) => item.repositoryId === "market")
      || run.body.data.prediction.targets[0];
    const logicalKey = target.fieldBindings?.branch?.logicalKey;
    assert.ok(logicalKey);
    const review = await fixture.request(
      "POST",
      `/ai-training/config-inference/runs/${run.body.data.id}/review`,
      {
        projectId: fixture.projectId,
        decision: "corrected",
        rating: 5,
        correctedPrediction: { targets: [target], noTargets: false },
        persistConfig: false,
      },
    );
    assert.equal(review.status, 200, review.body.error);
    const overview = await fixture.request("GET", `/ai-training/config-inference?projectId=${fixture.projectId}`);
    const initial = overview.body.data.valueBindings.find((binding) => binding.logicalKey === logicalKey);
    assert.ok(initial);

    peer = await bootSymbolicInvariantPeer(fixture, "value-binding-peer");
    const [tokenA, tokenB] = await Promise.all([fixture.loginAdmin(), peer.loginAdmin()]);
    const bindingPath = `/ai-training/config-inference/value-bindings/${encodeURIComponent(logicalKey)}`;
    const [left, right] = await Promise.all([
      fixture.request("PUT", bindingPath, {
        projectId: fixture.projectId,
        actualValue: "feature/concurrent-left",
        expectedRevision: initial.revision,
        persistConfig: false,
      }, tokenA),
      peer.request("PUT", bindingPath, {
        projectId: fixture.projectId,
        actualValue: "feature/concurrent-right",
        expectedRevision: initial.revision,
        persistConfig: false,
      }, tokenB),
    ]);
    assert.deepEqual(
      [left.status, right.status].sort((a, b) => a - b),
      [200, 409],
      JSON.stringify({ left, right }),
    );
    const winner = left.status === 200 ? left.body : right.body;
    const loser = left.status === 409 ? left.body : right.body;
    assert.equal(loser.code, "CONFIG_INFERENCE_BINDING_REVISION_CONFLICT");
    const finalOverview = await fixture.request("GET", `/ai-training/config-inference?projectId=${fixture.projectId}`);
    const finalBinding = finalOverview.body.data.valueBindings.find((binding) => binding.logicalKey === logicalKey);
    assert.equal(finalBinding.revision, initial.revision + 1);
    assert.equal(finalBinding.actualValue, (winner.binding || winner.data).actualValue);
    assert.equal(finalBinding.history.length, 1, "并发失败写不能丢失或伪造 revision/history");
  } finally {
    peer?.child.kill();
    fixture.child.kill();
  }
});

test("两个 Gateway 并发解析同一代号训练结果时只能保留一个 resolution revision", async () => {
  const fixture = await bootSymbolicInvariantFixture("symbol-resolution-concurrency");
  let peer = null;
  try {
    const run = await fixture.startRun("shared-symbols");
    assert.equal(run.status, 200, run.body.error);
    const symbolicTargets = symbolicResolutionPair();
    const reviewed = await fixture.request(
      "POST",
      `/ai-training/config-inference/runs/${run.body.data.id}/review`,
      {
        projectId: fixture.projectId,
        decision: "corrected",
        rating: 5,
        correctedPrediction: { targets: symbolicTargets, noTargets: false },
        persistConfig: false,
      },
    );
    assert.equal(reviewed.status, 200, reviewed.body.error);
    peer = await bootSymbolicInvariantPeer(fixture, "symbol-resolution-peer");
    const [tokenA, tokenB] = await Promise.all([fixture.loginAdmin(), peer.loginAdmin()]);

    const resolvedTargets = (prefix) => symbolicTargets.map((target, index) => {
      const row = structuredClone(target);
      row.branch = `feature/${prefix}-${index + 1}`;
      delete row.fieldStates?.branch;
      return row;
    });
    const endpoint = `/ai-training/config-inference/runs/${run.body.data.id}/resolve-symbols`;
    const [left, right] = await Promise.all([
      fixture.request("POST", endpoint, {
        projectId: fixture.projectId,
        correctedPrediction: { targets: resolvedTargets("left") },
        persistConfig: true,
      }, tokenA),
      peer.request("POST", endpoint, {
        projectId: fixture.projectId,
        correctedPrediction: { targets: resolvedTargets("right") },
        persistConfig: true,
      }, tokenB),
    ]);
    assert.deepEqual(
      [left.status, right.status].sort((a, b) => a - b),
      [200, 409],
      JSON.stringify({ left, right }),
    );
    const winner = left.status === 200 ? left.body : right.body;
    const loser = left.status === 409 ? left.body : right.body;
    assert.equal(loser.code, "CONFIG_INFERENCE_SYMBOL_RESOLUTION_CONFLICT");
    const overview = await fixture.request("GET", `/ai-training/config-inference?projectId=${fixture.projectId}`);
    const storedRun = overview.body.data.runs.find((item) => item.id === run.body.data.id);
    assert.equal(storedRun.review.resolutionHistory.length, 1);
    assert.deepEqual(
      storedRun.review.correctedPrediction.targets.map((target) => target.branch),
      winner.data.review.correctedPrediction.targets.map((target) => target.branch),
    );
    assert.equal(overview.body.data.valueBindings.filter((binding) => (
      storedRun.review.correctedPrediction.targets.some((target) => (
        target.fieldBindings?.branch?.logicalKey === binding.logicalKey
      ))
    )).every((binding) => binding.revision === 1), true);
  } finally {
    peer?.child.kill();
    fixture.child.kill();
  }
});

test("退出会话的旧 run 与新活动 run 跨 Gateway 并发评分时只有新 run 可以学习", async () => {
  const ticket = {
    id: "SAME-TICKET-CONCURRENT-REVIEW",
    ticketId: "SAME-TICKET-CONCURRENT-REVIEW",
    tbTaskId: "SAME-TICKET-CONCURRENT-REVIEW",
    title: "应用市场启动失败",
    projectId: "same-ticket-review-concurrency-project",
    projectName: "平台组件",
    tasklistName: "应用市场",
    staged: true,
    done: false,
    createdAt: Date.now(),
  };
  const fixture = await bootSymbolicInvariantFixture("same-ticket-review-concurrency", { tasks: [ticket] });
  let peer = null;
  try {
    const acquire = (sessionId) => fixture.request("POST", "/ai-training/config-inference/random", {
      projectId: fixture.projectId,
      pool: "staged",
      sessionId,
      excludeTaskIds: [],
    });
    const firstRun = await acquire("exited-review-session");
    assert.equal(firstRun.status, 200, firstRun.body.error);
    assert.equal(firstRun.body.ok, true, JSON.stringify(firstRun.body));
    const exited = await fixture.request("POST", "/ai-training/config-inference/session/exit", {
      projectId: fixture.projectId,
      sessionId: "exited-review-session",
    });
    assert.equal(exited.status, 200, exited.body.error);
    assert.ok(Number(exited.body.released) > 0, JSON.stringify(exited.body));

    const secondRun = await acquire("active-review-session");
    assert.equal(secondRun.status, 200, secondRun.body.error);
    assert.equal(secondRun.body.ok, true, JSON.stringify(secondRun.body));
    assert.notEqual(firstRun.body.data.id, secondRun.body.data.id);

    peer = await bootSymbolicInvariantPeer(fixture, "same-ticket-review-peer");
    const correctedTarget = {
      ...buildConfigInferenceRegistry(PROJECT_DEFS, VEHICLE_MAP).targets
        .find((target) => target.repositoryId === "market"),
      targetId: "same-ticket-concurrent-market",
      targetRole: "primary",
      order: 1,
    };
    const reviewBody = {
      projectId: fixture.projectId,
      decision: "corrected",
      rating: 5,
      persistConfig: false,
      correctedPrediction: { targets: [correctedTarget], noTargets: false },
    };
    const [left, right] = await Promise.all([
      fixture.request(
        "POST",
        `/ai-training/config-inference/runs/${firstRun.body.data.id}/review`,
        reviewBody,
      ),
      peer.request(
        "POST",
        `/ai-training/config-inference/runs/${secondRun.body.data.id}/review`,
        reviewBody,
      ),
    ]);
    assert.equal(left.status, 409, JSON.stringify({ left, right }));
    assert.equal(left.body.staleTrainingClaim, true);
    assert.equal(right.status, 200, JSON.stringify({ left, right }));
    assert.equal(right.body.annotationPending, true);
    const winnerRunId = secondRun.body.data.id;

    const overview = await fixture.request("GET", `/ai-training/config-inference?projectId=${fixture.projectId}`);
    const trained = overview.body.data.trainedTickets
      .filter((row) => row.tbTaskId === ticket.tbTaskId);
    assert.equal(trained.length, 1);
    assert.equal(trained[0].sourceRunId, winnerRunId);
    const learned = overview.body.data.samples
      .filter((sample) => [firstRun.body.data.id, secondRun.body.data.id].includes(sample.sourceRunId));
    assert.equal(learned.length, 1);
    assert.equal(learned[0].sourceRunId, winnerRunId);
  } finally {
    peer?.child.kill();
    fixture.child.kill();
  }
});

test("两个 Gateway 并发写回不同仓库及同车型同仓库选项时配置不会丢失", async () => {
  const fixture = await bootSymbolicInvariantFixture("config-writeback-concurrency");
  let peer = null;
  try {
    peer = await bootSymbolicInvariantPeer(fixture, "config-writeback-peer");
    const [tokenA, tokenB] = await Promise.all([fixture.loginAdmin(), peer.loginAdmin()]);
    const review = (client, token, runId, targets) => client.request(
      "POST",
      `/ai-training/config-inference/runs/${runId}/review`,
      {
        projectId: fixture.projectId,
        decision: "corrected",
        rating: 3,
        persistConfig: true,
        correctedPrediction: { targets },
      },
      token,
    );
    const toolTarget = (suffix) => ({
      targetId: `tool-${suffix}`,
      appName: "",
      vehicle: "",
      repositoryId: `concurrent-tool-${suffix}`,
      repositoryName: `并发工具${suffix.toUpperCase()}`,
      gitUrl: `https://git.example.com/tools/concurrent-${suffix}.git`,
      branch: `feature/tool-${suffix}`,
      flavor: "",
      projectType: "tooling",
      repositoryOnly: true,
      targetRole: "standalone",
      order: 1,
    });

    const [toolRunA, toolRunB] = await Promise.all([
      fixture.startRun("tool-a"),
      fixture.startRun("tool-b"),
    ]);
    assert.equal(toolRunA.status, 200, toolRunA.body.error);
    assert.equal(toolRunB.status, 200, toolRunB.body.error);
    const [toolReviewA, toolReviewB] = await Promise.all([
      review(fixture, tokenA, toolRunA.body.data.id, [toolTarget("a")]),
      review(peer, tokenB, toolRunB.body.data.id, [toolTarget("b")]),
    ]);
    const toolFirstWave = [toolReviewA, toolReviewB];
    const toolFirstWaveStatuses = toolFirstWave.map((result) => result.status).sort((a, b) => a - b);
    assert.deepEqual(toolFirstWaveStatuses, [200, 409], JSON.stringify({ toolReviewA, toolReviewB }));
    const staleToolIndex = toolFirstWave.findIndex((result) => result.status === 409);
    assert.equal(toolFirstWave[staleToolIndex].body.stale, true);
    assert.equal(toolFirstWave[staleToolIndex].body.refreshed, true);
    // 并发复核先更新了共享注册表时，旧预测必须回到人工确认；用户确认服务端重算结果后再提交。
    const toolClients = [fixture, peer];
    const toolTokens = [tokenA, tokenB];
    const toolRuns = [toolRunA, toolRunB];
    const toolSuffixes = ["a", "b"];
    const retriedTool = await review(
      toolClients[staleToolIndex],
      toolTokens[staleToolIndex],
      toolRuns[staleToolIndex].body.data.id,
      [toolTarget(toolSuffixes[staleToolIndex])],
    );
    assert.equal(retriedTool.status, 200, JSON.stringify(retriedTool));

    const appTarget = (suffix) => ({
      targetId: `market-${suffix}`,
      appName: "应用市场",
      vehicle: "阿维塔 8678",
      repositoryId: "market",
      repositoryName: "应用市场",
      gitUrl: "git@example.com:apps/market.git",
      branch: `feature/concurrent-${suffix}`,
      flavor: `avatrConcurrent${suffix.toUpperCase()}`,
      projectType: "application",
      repositoryOnly: false,
      targetRole: "primary",
      order: 1,
    });
    const [optionRunA, optionRunB] = await Promise.all([
      fixture.startRun("option-a"),
      fixture.startRun("option-b"),
    ]);
    assert.equal(optionRunA.status, 200, optionRunA.body.error);
    assert.equal(optionRunB.status, 200, optionRunB.body.error);
    const optionFirstWave = await Promise.all([
      review(fixture, tokenA, optionRunA.body.data.id, [appTarget("a")]),
      review(peer, tokenB, optionRunB.body.data.id, [appTarget("b")]),
    ]);
    const firstWaveStatuses = optionFirstWave.map((result) => result.status).sort((a, b) => a - b);
    assert.deepEqual(firstWaveStatuses, [200, 409], JSON.stringify(optionFirstWave));
    const staleIndex = optionFirstWave.findIndex((result) => result.status === 409);
    assert.equal(optionFirstWave[staleIndex].body.stale, true);
    assert.equal(optionFirstWave[staleIndex].body.refreshed, true);
    const optionClients = [fixture, peer];
    const optionTokens = [tokenA, tokenB];
    const optionRuns = [optionRunA, optionRunB];
    const optionSuffixes = ["a", "b"];
    const retriedOption = await review(
      optionClients[staleIndex],
      optionTokens[staleIndex],
      optionRuns[staleIndex].body.data.id,
      [appTarget(optionSuffixes[staleIndex])],
    );
    assert.equal(retriedOption.status, 200, JSON.stringify(retriedOption));

    const overview = await fixture.request("GET", `/ai-training/config-inference?projectId=${fixture.projectId}`);
    assert.equal(overview.status, 200, overview.body.error);
    const defs = overview.body.data.registry.projectDefs;
    assert.ok(defs.some((def) => def.name === "并发工具A"), JSON.stringify(defs));
    assert.ok(defs.some((def) => def.name === "并发工具B"), JSON.stringify(defs));
    const market = defs.find((def) => def.id === "market");
    assert.ok(market.branchOptions.includes("feature/concurrent-a"), JSON.stringify(market));
    assert.ok(market.branchOptions.includes("feature/concurrent-b"), JSON.stringify(market));
    assert.ok(market.flavorOptions.includes("avatrConcurrentA"), JSON.stringify(market));
    assert.ok(market.flavorOptions.includes("avatrConcurrentB"), JSON.stringify(market));
    const marketRepos = overview.body.data.registry.vehicleMap["阿维塔 8678"].apps
      .find((app) => app.appName === "应用市场").repos
      .filter((repo) => repo.repoId === "market");
    assert.ok(marketRepos.some((repo) => repo.branch === "feature/concurrent-a" && repo.flavor === "avatrConcurrentA"));
    assert.ok(marketRepos.some((repo) => repo.branch === "feature/concurrent-b" && repo.flavor === "avatrConcurrentB"));
  } finally {
    peer?.child.kill();
    fixture.child.kill();
  }
});

test("resolve-symbols 拒绝交换或重复 targetId、修改顺序角色以及新增 symbolic 字段", async (t) => {
  const fixture = await bootSymbolicInvariantFixture("resolve-invariants");
  try {
    const cases = [
      {
        name: "交换 targetId",
        mutate(targets) {
          [targets[0].targetId, targets[1].targetId] = [targets[1].targetId, targets[0].targetId];
        },
      },
      {
        name: "重复 targetId",
        mutate(targets) {
          targets[1].targetId = targets[0].targetId;
        },
      },
      {
        name: "修改 order 和 targetRole",
        mutate(targets) {
          targets[0].order = 2;
          targets[0].targetRole = "dependency";
          targets[1].order = 1;
          targets[1].targetRole = "primary";
        },
      },
      {
        name: "新增 symbolic 字段",
        mutate(targets) {
          targets[0].flavor = "NEW_FLAVOR_ALIAS";
          targets[0].fieldStates.flavor = { kind: "symbolic", feature: "复核后新加的 Flavor 代号" };
        },
      },
    ];

    for (const invalidCase of cases) {
      await t.test(invalidCase.name, async () => {
        const run = await fixture.startRun(invalidCase.name);
        assert.equal(run.status, 200, run.body.error);
        const initialTargets = symbolicResolutionPair();
        const reviewed = await fixture.request(
          "POST",
          `/ai-training/config-inference/runs/${run.body.data.id}/review`,
          {
            projectId: fixture.projectId,
            decision: "corrected",
            rating: 5,
            correctedPrediction: { targets: initialTargets, noTargets: false },
            persistConfig: false,
          },
        );
        assert.equal(reviewed.status, 200, reviewed.body.error);
        const requestedTargets = JSON.parse(JSON.stringify(initialTargets));
        invalidCase.mutate(requestedTargets);
        const rejected = await fixture.request(
          "POST",
          `/ai-training/config-inference/runs/${run.body.data.id}/resolve-symbols`,
          {
            projectId: fixture.projectId,
            correctedPrediction: { targets: requestedTargets },
            persistConfig: false,
          },
        );
        assert.equal(rejected.status, 400, `${invalidCase.name} 不得改写已学习目标：${JSON.stringify(rejected.body)}`);
        assert.match(rejected.body.error, /targetId|目标|顺序|角色|代号|symbolic/i);

        const overview = await fixture.request("GET", `/ai-training/config-inference?projectId=${fixture.projectId}`);
        const stored = overview.body.data.runs.find((item) => item.id === run.body.data.id)
          ?.review?.correctedPrediction?.targets;
        assert.deepEqual(stored.map((target) => target.targetId), initialTargets.map((target) => target.targetId));
        assert.deepEqual(stored.map((target) => target.order), [1, 2]);
        assert.deepEqual(stored.map((target) => target.targetRole), ["primary", "dependency"]);
      });
    }
  } finally {
    fixture.child.kill();
  }
});

test("resolve-symbols 解析回原预测目标后正负学习集合不相交", async () => {
  const fixture = await bootSymbolicInvariantFixture("resolve-overlap");
  try {
    const run = await fixture.startRun("original-target");
    assert.equal(run.status, 200, run.body.error);
    const original = run.body.data.prediction.targets.find((target) => target.repositoryId === "market");
    assert.ok(original, "测试前提：标题规则应先推理出 market 目标");
    const { fieldBindings: _originalBindings, ...originalWithoutBindings } = original;
    const symbolic = {
      ...originalWithoutBindings,
      targetId: original.targetId || "resolve-to-original",
      repositoryId: "TARGET_REPOSITORY",
      repositoryName: "待替换的应用市场仓库",
      gitUrl: "",
      fieldStates: { repositoryId: { kind: "symbolic", feature: "应用市场主工程" } },
    };
    const reviewed = await fixture.request(
      "POST",
      `/ai-training/config-inference/runs/${run.body.data.id}/review`,
      {
        projectId: fixture.projectId,
        decision: "corrected",
        rating: 5,
        correctedPrediction: { targets: [symbolic], noTargets: false },
        persistConfig: false,
      },
    );
    assert.equal(reviewed.status, 200, reviewed.body.error);
    assert.equal(reviewed.body.annotationPending, true);

    const resolved = await fixture.request(
      "POST",
      `/ai-training/config-inference/runs/${run.body.data.id}/resolve-symbols`,
      {
        projectId: fixture.projectId,
        correctedPrediction: {
          targets: [{ ...originalWithoutBindings, targetId: symbolic.targetId, fieldStates: {} }],
        },
        persistConfig: false,
      },
    );
    assert.equal(resolved.status, 200, resolved.body.error);
    const targetKey = (target) => CONFIG_INFERENCE_DIMENSIONS
      .map((field) => String(target?.[field] || "").trim().toLowerCase())
      .join("|");
    const positives = new Set((resolved.body.sample.groundTruth?.targets || []).map(targetKey));
    const negativeTargets = resolved.body.sample.negative?.rejectedTargets || [];
    const feedbackRejectedTargets = resolved.body.sample.feedback?.rejectedPrediction?.targets || [];
    assert.deepEqual(negativeTargets.filter((target) => positives.has(targetKey(target))), []);
    assert.deepEqual(feedbackRejectedTargets.filter((target) => positives.has(targetKey(target))), []);
  } finally {
    fixture.child.kill();
  }
});

test("非空 targets 与 noTargets=true 不能同时提交", async () => {
  const fixture = await bootSymbolicInvariantFixture("no-targets-conflict");
  try {
    const run = await fixture.startRun("conflict");
    assert.equal(run.status, 200, run.body.error);
    assert.ok(run.body.data.prediction.targets.length > 0, "测试前提：必须先有一个预测目标");
    const rejected = await fixture.request(
      "POST",
      `/ai-training/config-inference/runs/${run.body.data.id}/review`,
      {
        projectId: fixture.projectId,
        decision: "corrected",
        rating: 5,
        correctedPrediction: {
          targets: [run.body.data.prediction.targets[0]],
          noTargets: true,
        },
        persistConfig: false,
      },
    );
    assert.equal(rejected.status, 400, `noTargets=true 只允许显式空目标：${JSON.stringify(rejected.body)}`);
    assert.match(rejected.body.error, /noTargets|删除全部|不能同时/);
  } finally {
    fixture.child.kill();
  }
});

test("含 unresolved 代号的整组复核拒绝未登记实际目标和未显式标代号的 literal 字段", async (t) => {
  const fixture = await bootSymbolicInvariantFixture("mixed-symbolic-registration");
  try {
    const adminToken = await fixture.loginAdmin();
    const captureState = async (ragTicketId) => {
      const overview = await fixture.request("GET", `/ai-training/config-inference?projectId=${fixture.projectId}`);
      assert.equal(overview.status, 200, overview.body.error);
      const rag = await fixture.request("POST", "/ai-training/config-inference/rag", {
        projectId: fixture.projectId,
        ticket: {
          ticketId: ragTicketId,
          title: "应用市场语音代号配置",
          projectId: fixture.projectId,
          projectName: "平台组件",
          tasklistName: "应用市场",
        },
      });
      assert.equal(rag.status, 200, rag.body.error);
      const stableRag = JSON.parse(JSON.stringify(rag.body.data, (key, value) => (
        key === "capturedAt" || key === "snapshotAt" ? undefined : value
      )));
      return {
        configText: fs.readFileSync(fixture.market, "utf8"),
        registry: overview.body.data.registry,
        options: overview.body.data.options,
        samples: overview.body.data.samples,
        runs: overview.body.data.runs,
        rag: stableRag,
      };
    };
    const assertRejectedWithoutMutation = async ({ run, before, rejected, ragTicketId, message }) => {
      assert.equal(rejected.status, 400, `${message}：${JSON.stringify(rejected.body)}`);
      assert.match(rejected.body.error, /未登记|注册表|显式.*代号|标记为代号/);
      const after = await captureState(ragTicketId);
      assert.equal(after.configText, before.configText, "拒绝复核后真实共享配置文件必须保持字节不变");
      assert.deepEqual(after.registry, before.registry, "拒绝复核后工程注册表和车型源码配置不能变化");
      assert.deepEqual(after.options, before.options, "拒绝复核后下拉选项不能混入未登记值");
      assert.deepEqual(after.samples, before.samples, "拒绝复核不能产生或修改学习样本");
      assert.deepEqual(after.rag, before.rag, "拒绝复核不能改变任何模型读取的 RAG 结果");
      assert.equal(
        after.runs.find((item) => item.id === run.body.data.id)?.review,
        null,
        "被拒绝的 run 必须保持未评分状态",
      );
    };

    await t.test("合法代号旁的未登记实际工程不能借整组延期写回绕过校验", async () => {
      const run = await fixture.startRun("unregistered-concrete-neighbor");
      assert.equal(run.status, 200, run.body.error);
      const ragTicketId = "MIXED-SYMBOLIC-UNREGISTERED-CONCRETE-RAG";
      const before = await captureState(ragTicketId);
      const rejected = await fixture.request(
        "POST",
        `/ai-training/config-inference/runs/${run.body.data.id}/review`,
        {
          projectId: fixture.projectId,
          decision: "corrected",
          rating: 5,
          correctedPrediction: {
            noTargets: false,
            targets: [
              symbolicResolutionPair()[0],
              {
                targetId: "unregistered-concrete-target",
                appName: "未登记实际应用",
                vehicle: "未登记实际车型",
                repositoryId: "unregistered-concrete-repository",
                repositoryName: "未登记实际仓库",
                gitUrl: "https://git.example.com/team/unregistered-concrete.git",
                branch: "feature/unregistered-concrete",
                flavor: "unregisteredConcreteFlavor",
                targetRole: "dependency",
                order: 2,
              },
            ],
          },
          persistConfig: true,
        },
        adminToken,
      );
      await assertRejectedWithoutMutation({
        run,
        before,
        rejected,
        ragTicketId,
        message: "整组存在 unresolved 时仍必须拒绝另一个未登记的实际工程",
      });
    });

    const literalCases = [
      { field: "appName", value: "UNREGISTERED_APP_LITERAL", label: "应用名字" },
      { field: "vehicle", value: "UNREGISTERED_VEHICLE_LITERAL", label: "车型" },
      { field: "repositoryId", value: "UNREGISTERED_REPOSITORY_LITERAL", label: "Git 仓库" },
      { field: "flavor", value: "UNREGISTERED_FLAVOR_LITERAL", label: "Flavor" },
    ];
    for (const literalCase of literalCases) {
      await t.test(`代号目标中的未登记 ${literalCase.label} literal 必须显式标代号`, async () => {
        const run = await fixture.startRun(`unregistered-literal-${literalCase.field}`);
        assert.equal(run.status, 200, run.body.error);
        const ragTicketId = `MIXED-SYMBOLIC-LITERAL-${literalCase.field}-RAG`;
        const before = await captureState(ragTicketId);
        const target = symbolicResolutionPair()[0];
        target[literalCase.field] = literalCase.value;
        if (literalCase.field === "repositoryId") target.repositoryName = "未登记 literal 仓库";
        const rejected = await fixture.request(
          "POST",
          `/ai-training/config-inference/runs/${run.body.data.id}/review`,
          {
            projectId: fixture.projectId,
            decision: "corrected",
            rating: 5,
            correctedPrediction: { targets: [target], noTargets: false },
            persistConfig: true,
          },
          adminToken,
        );
        await assertRejectedWithoutMutation({
          run,
          before,
          rejected,
          ragTicketId,
          message: `未登记 ${literalCase.label} literal 必须先显式标记为代号`,
        });
      });
    }
  } finally {
    fixture.child.kill();
  }
});

test("同 TB 单再次推理带回上一次人工纠正作为弹窗预填草稿", async () => {
  const store = await import("../services/devbench/store.js");
  const projectId = "project-a";
  const ticket = {
    ticketId: "CARB-PRIOR-REVIEW-CARRY",
    tbTaskId: "CARB-PRIOR-REVIEW-CARRY",
    title: "应用市场启动失败",
    projectName: "平台组件",
    tasklistName: "应用市场",
  };
  const first = store.runConfigInference(projectId, { ticket, captureSignals: false });
  assert.equal(first.ok, true, first.error);
  assert.equal(first.data._reviewDraft, null, "首次推理不应有预填草稿");

  const registry = store.getConfigInferenceData(projectId).registry;
  const webTarget = registry.targets.find((target) => target.repositoryId === "web");
  assert.ok(webTarget, "project-a 注册表应包含 web 工程");
  const correctedTarget = { ...webTarget, targetId: "target_local_web_carry" };
  const localWebPath = path.join(os.tmpdir(), "prior-review-carry-web");
  fs.mkdirSync(path.join(localWebPath, ".git"), { recursive: true });
  fs.writeFileSync(path.join(localWebPath, ".git", "config"), '[remote "origin"]\n\turl = https://example.com/apps/web.git\n');
  fs.writeFileSync(path.join(localWebPath, ".git", "HEAD"), "ref: refs/heads/develop\n");
  assert.equal(store.upsertProject({ id: "local-web-carry", name: "本机 WebApp carry", path: localWebPath }).ok, true);

  const reviewed = store.reviewConfigInferenceRun(projectId, first.data.id, {
    decision: "corrected",
    rating: 4,
    reviewer: "carry-test",
    correctedPrediction: { targets: [correctedTarget] },
    localProjectBindings: [{
      targetId: correctedTarget.targetId,
      repositoryId: correctedTarget.repositoryId,
      branch: correctedTarget.branch,
      projectId: "local-web-carry",
    }],
  });
  assert.equal(reviewed.ok, true, reviewed.error);

  const second = store.runConfigInference(projectId, { ticket, captureSignals: false });
  assert.equal(second.ok, true, second.error);
  assert.ok(second.data._reviewDraft, "再次推理应带回上一次人工纠正作为预填草稿");
  assert.equal(second.data._reviewDraft.decision, "corrected");
  assert.equal(second.data._reviewDraft.rating, 4);
  assert.equal(second.data._reviewDraft.sourceRunId, first.data.id);
  assert.deepEqual(
    second.data._reviewDraft.correctedPrediction.targets.map((target) => target.repositoryId),
    ["web"],
  );

  fs.rmSync(localWebPath, { recursive: true, force: true });
});
