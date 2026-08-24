import test from "node:test";
import assert from "node:assert/strict";
import {
  CONFIG_INFERENCE_QUALITY_VERSION,
  extractConfigInferenceSignals,
  inferConfigFromTicket,
  normalizeConfigInferenceTicket,
  retrieveConfigInferenceMemories,
} from "../services/devbench/config-inference.js";

const PROJECT_DEFS = [
  { id: "market", name: "应用市场" },
  { id: "settings", name: "设置" },
];

const SINGLE_APP_MAP = {
  p155: {
    aliases: ["P155", "吉利P155"],
    apps: [{
      appName: "应用市场",
      repos: [{
        repoId: "market",
        branch: "release/p155",
        flavor: "geelyp155Prod",
        targetRole: "primary",
      }],
    }],
  },
};

const MULTI_APP_MAP = {
  p155: {
    aliases: ["P155", "吉利P155"],
    apps: [
      {
        appName: "应用市场",
        repos: [{
          repoId: "market",
          branch: "release/p155",
          flavor: "geelyp155Prod",
          targetRole: "primary",
        }],
      },
      {
        appName: "设置",
        repos: [{
          repoId: "settings",
          branch: "release/settings-p155",
          flavor: "settingsP155Prod",
          targetRole: "primary",
        }],
      },
    ],
  },
};

const TWO_VEHICLE_MAP = {
  ...SINGLE_APP_MAP,
  p162: {
    aliases: ["P162", "吉利P162"],
    apps: [{
      appName: "应用市场",
      repos: [{
        repoId: "market",
        branch: "release/p162",
        flavor: "geelyp162Prod",
        targetRole: "primary",
      }],
    }],
  },
};

const APP_VEHICLE_MAPPINGS = {
  title: {
    应用市场: { category: "app", value: "应用市场" },
    P155: { category: "vehicle", value: "p155" },
    P162: { category: "vehicle", value: "p162" },
  },
};

function targetFor(vehicleMap, vehicle, appName = "应用市场") {
  const app = vehicleMap[vehicle].apps.find((item) => item.appName === appName);
  const repo = app.repos[0];
  return {
    appName,
    vehicle,
    repositoryId: repo.repoId,
    repositoryName: PROJECT_DEFS.find((item) => item.id === repo.repoId)?.name || repo.repoId,
    branch: repo.branch,
    flavor: repo.flavor,
    projectType: "application",
    targetRole: repo.targetRole || "primary",
    repositoryOnly: false,
    order: 1,
  };
}

test("ticket 归一化保留 sourceCoverage、评论/附件 provenance 与时间信息", () => {
  const ticket = normalizeConfigInferenceTicket({
    tbTaskId: "tb-quality-1",
    projectId: "tb-project",
    title: "P155 应用市场构建失败",
    createdAt: 1_700_000_000_000,
    updatedAt: "2026-07-28T09:00:00.000Z",
    snapshotAt: "2026-07-29T09:00:00.000Z",
    comments: [{
      id: "comment-1",
      content: "评论正文",
      author: { id: "user-1", name: "评审人" },
      createdAt: "2026-07-28T10:00:00.000Z",
      availableAt: "2026-07-28T10:01:00.000Z",
    }],
    attachments: [{
      id: "attachment-1",
      name: "build.log",
      text: "assembleGeelyp155ProdRelease failed",
      source: "teambition",
      mimeType: "text/plain",
      createdAt: "2026-07-28T11:00:00.000Z",
      availableAt: "2026-07-28T11:01:00.000Z",
    }],
    sourceCoverage: {
      requiredSources: ["detail", "comments"],
      detail: { available: true, complete: true, capturedAt: "2026-07-29T08:59:00.000Z" },
      comments: {
        available: true,
        complete: false,
        count: 1,
        source: "teambition",
        error: "下一页读取失败",
      },
    },
  });

  assert.equal(ticket.projectId, "tb-project");
  assert.equal(ticket.createdAt, 1_700_000_000_000);
  assert.equal(ticket.updatedAt, "2026-07-28T09:00:00.000Z");
  assert.equal(ticket.commentItems[0].authorId, "user-1");
  assert.equal(ticket.commentItems[0].authorName, "评审人");
  assert.equal(ticket.commentItems[0].availableAt, "2026-07-28T10:01:00.000Z");
  assert.equal(ticket.attachments[0].source, "teambition");
  assert.equal(ticket.attachments[0].mimeType, "text/plain");
  assert.equal(ticket.attachments[0].createdAt, "2026-07-28T11:00:00.000Z");
  assert.deepEqual(ticket.sourceCoverage.requiredSources, ["detail", "comments"]);
  assert.equal(ticket.sourceCoverage.comments.complete, false);
  assert.equal(ticket.sourceCoverage.comments.error, "下一页读取失败");
});

test("否定语境不命中被排除车型，肯定车型仍可进入注册表候选", () => {
  const result = inferConfigFromTicket({
    ticket: { title: "应用市场不是 P162，是 P155 的启动问题" },
    projectDefs: PROJECT_DEFS,
    vehicleMap: TWO_VEHICLE_MAP,
    keywordMappings: APP_VEHICLE_MAPPINGS,
  });

  const vehicleMatches = result.signals.matches
    .filter((match) => match.category === "vehicle")
    .map((match) => match.value);
  assert.deepEqual(vehicleMatches, ["p155"]);
  assert.equal(result.status, "NEED_HUMAN_CONFIRMATION");
  assert.equal(result.targets[0].vehicle, "p155");
  assert.equal(result.targets.some((target) => target.vehicle === "p162"), false);
});

test("中文 char n-gram 混合相似度可召回轻微改写的已批准案例", () => {
  const historicalTicket = { title: "P155 应用市场详情页面断网以后按钮无法点击" };
  const currentTicket = { title: "P155 应用市场详情页面断网后按钮无法点击" };
  const sample = {
    id: "approved-chinese-paraphrase",
    state: "approved",
    source: "user_feedback",
    signals: inferConfigFromTicket({
      ticket: historicalTicket,
      projectDefs: PROJECT_DEFS,
      vehicleMap: SINGLE_APP_MAP,
    }).signals,
    groundTruth: { targets: [targetFor(SINGLE_APP_MAP, "p155")] },
    feedback: { decision: "correct", rating: 5 },
  };

  const rag = retrieveConfigInferenceMemories({
    projectId: "project-quality",
    ticket: currentTicket,
    projectDefs: PROJECT_DEFS,
    vehicleMap: SINGLE_APP_MAP,
    samples: [sample],
  });

  assert.equal(rag.memories[0]?.id, sample.id);
  assert.ok(rag.memories[0].similarity >= 0.9, `similarity=${rag.memories[0].similarity}`);
  assert.ok(rag.memories[0].sourceGroups.includes("title"));
});

test("任一可用来源均可推理，缺失来源只降低启发式置信并保留采集告警", () => {
  const base = {
    tbTaskId: "tb-source-quality",
    title: "P155 应用市场启动失败",
  };
  const fullCoverage = {
    detail: { available: true, complete: true },
    note: { available: true, complete: true },
    comments: { available: true, complete: true },
    attachments: { available: true, complete: true },
    tags: { available: true, complete: true },
  };
  const full = inferConfigFromTicket({
    ticket: { ...base, sourceCoverage: fullCoverage },
    projectDefs: PROJECT_DEFS,
    vehicleMap: SINGLE_APP_MAP,
    keywordMappings: APP_VEHICLE_MAPPINGS,
  });
  const optionalPartial = inferConfigFromTicket({
    ticket: {
      ...base,
      sourceCoverage: {
        ...fullCoverage,
        comments: { available: true, complete: false, error: "分页中断" },
        attachments: { available: false, complete: false, error: "附件服务不可用" },
      },
    },
    projectDefs: PROJECT_DEFS,
    vehicleMap: SINGLE_APP_MAP,
    keywordMappings: APP_VEHICLE_MAPPINGS,
  });
  const requiredMissing = inferConfigFromTicket({
    ticket: {
      ...base,
      sourceCoverage: {
        ...fullCoverage,
        requiredSources: ["detail"],
        detail: { available: false, complete: false, error: "详情读取失败" },
      },
    },
    projectDefs: PROJECT_DEFS,
    vehicleMap: SINGLE_APP_MAP,
    keywordMappings: APP_VEHICLE_MAPPINGS,
  });

  assert.equal(full.status, "NEED_HUMAN_CONFIRMATION");
  assert.equal(optionalPartial.status, "NEED_HUMAN_CONFIRMATION");
  assert.ok(optionalPartial.confidenceScore < full.confidenceScore);
  assert.equal(requiredMissing.status, "NEED_HUMAN_CONFIRMATION");
  assert.ok(requiredMissing.targets.length > 0);
  assert.equal(requiredMissing.policy.abstainReasons.includes("required_source_incomplete"), false);
  assert.deepEqual(requiredMissing.policy.missingSources, []);
  assert.deepEqual(requiredMissing.quality.source.declaredMissing, ["detail"]);
  assert.ok(requiredMissing.confidenceScore < full.confidenceScore);
});

test("serving 仅消费 approved/active/verified、时间有效且已验证执行的样本，旧样本保持兼容", () => {
  const ticket = {
    title: "P155 应用市场启动失败",
    snapshotAt: "2026-07-29T09:00:00.000Z",
  };
  const signals = extractConfigInferenceSignals(ticket, APP_VEHICLE_MAPPINGS);
  const target = targetFor(SINGLE_APP_MAP, "p155");
  const samples = [
    {
      id: "draft-memory",
      state: "draft",
      source: "user_feedback",
      signals,
      groundTruth: { targets: [target] },
      feedback: { decision: "correct", rating: 5 },
    },
    {
      id: "approved-memory",
      state: "approved",
      source: "user_feedback",
      signals,
      groundTruth: { targets: [target] },
      feedback: { decision: "correct", rating: 5 },
    },
    {
      id: "future-memory",
      state: "approved",
      availableAt: "2026-07-29T09:00:01.000Z",
      source: "user_feedback",
      signals,
      groundTruth: { targets: [target] },
      feedback: { decision: "correct", rating: 5 },
    },
    {
      id: "started-memory",
      source: "actual_execution",
      execution: { outcome: "started" },
      signals,
      groundTruth: { targets: [target] },
    },
    {
      id: "verified-execution",
      source: "actual_execution",
      execution: { outcome: "success" },
      signals,
      groundTruth: { targets: [target] },
    },
    {
      id: "legacy-memory",
      source: "user_feedback",
      signals,
      groundTruth: { targets: [target] },
      feedback: { decision: "corrected", rating: 4 },
    },
  ];

  const rag = retrieveConfigInferenceMemories({
    projectId: "project-serving",
    ticket,
    projectDefs: PROJECT_DEFS,
    vehicleMap: SINGLE_APP_MAP,
    keywordMappings: APP_VEHICLE_MAPPINGS,
    samples,
  });
  const ids = rag.memories.map((memory) => memory.id);

  assert.ok(ids.includes("approved-memory"));
  assert.ok(ids.includes("verified-execution"));
  assert.ok(ids.includes("legacy-memory"));
  assert.equal(ids.includes("draft-memory"), false);
  assert.equal(ids.includes("future-memory"), false);
  assert.equal(ids.includes("started-memory"), false);
  assert.equal(rag.quality.servingSamples.filtered, 3);
  assert.equal(rag.quality.servingSamples.filteredByState.future, 1);
  assert.equal(rag.quality.servingSamples.legacyCompatible, 1);
});

test("车型相同但应用上下文未知时，结构化推理与 RAG 都不接受跨应用正记忆", () => {
  const ticket = { title: "P155 车机启动异常" };
  const sample = {
    id: "settings-positive",
    state: "approved",
    source: "user_feedback",
    signals: extractConfigInferenceSignals(ticket, {}),
    groundTruth: { targets: [targetFor(MULTI_APP_MAP, "p155", "设置")] },
    feedback: { decision: "correct", rating: 5 },
  };
  const inference = inferConfigFromTicket({
    ticket,
    projectDefs: PROJECT_DEFS,
    vehicleMap: MULTI_APP_MAP,
    samples: [sample],
  });
  const rag = retrieveConfigInferenceMemories({
    projectId: "project-context",
    ticket,
    projectDefs: PROJECT_DEFS,
    vehicleMap: MULTI_APP_MAP,
    samples: [sample],
  });

  assert.equal(inference.status, "NEED_MORE_INFO");
  assert.deepEqual(inference.targets, []);
  assert.ok(inference.policy.abstainReasons.includes("margin_below_threshold"));
  assert.equal(inference.quality.margin.value, 0);
  assert.deepEqual(rag.memories, []);
  assert.equal(rag.policy.applicationRepositoryContextSharedWithInference, true);
});

test("置信度明确区分 heuristic 与 calibration，并输出 registry stale 元数据", () => {
  const fresh = inferConfigFromTicket({
    ticket: { title: "P155 应用市场启动失败" },
    projectDefs: PROJECT_DEFS,
    vehicleMap: SINGLE_APP_MAP,
    keywordMappings: APP_VEHICLE_MAPPINGS,
    registryVersion: "registry-current",
  });
  const stale = inferConfigFromTicket({
    ticket: { title: "P155 应用市场启动失败" },
    projectDefs: PROJECT_DEFS,
    vehicleMap: SINGLE_APP_MAP,
    keywordMappings: APP_VEHICLE_MAPPINGS,
    registryVersion: "registry-current",
    expectedRegistryVersion: "registry-old",
    expectedRuleVersion: "config-inference-rules-v2",
  });

  assert.equal(fresh.versions.qualityVersion, CONFIG_INFERENCE_QUALITY_VERSION);
  assert.equal(fresh.versions.registryVersion, "registry-current");
  assert.match(fresh.versions.registryFingerprint, /^registry-v1-/);
  assert.equal(fresh.confidenceMetadata.kind, "heuristic");
  assert.equal(fresh.confidenceMetadata.calibrated, false);
  assert.equal(fresh.confidenceMetadata.calibratedProbability, null);
  assert.equal(fresh.policy.confidenceKind, "heuristic");
  assert.equal(stale.versions.stale, true);
  assert.deepEqual(
    stale.versions.staleReasons.sort(),
    ["registry_version_mismatch", "rule_version_mismatch"],
  );
  assert.equal(stale.status, "NEED_MORE_INFO");
  assert.deepEqual(stale.targets, []);
  assert.ok(stale.policy.abstainReasons.includes("registry_invalid"));
});

test("结构化证据按 snapshotAt 截断未来评论，并作为不可信证据元数据输出", () => {
  const result = inferConfigFromTicket({
    ticket: {
      title: "P155 应用市场构建失败",
      snapshotAt: "2026-07-29T10:00:00.000Z",
      attachments: [{
        id: "build-log",
        name: "build.log",
        text: "执行 assembleGeelyp155ProdRelease 失败",
        availableAt: "2026-07-29T09:00:00.000Z",
      }],
      comments: [{
        id: "future-comment",
        text: "未来才出现 com.example.future.HiddenActivity",
        availableAt: "2026-07-29T11:00:00.000Z",
      }],
    },
    projectDefs: PROJECT_DEFS,
    vehicleMap: SINGLE_APP_MAP,
    keywordMappings: APP_VEHICLE_MAPPINGS,
  });

  assert.ok(result.structuredEvidence.some((item) => (
    item.kind === "gradle_task" && item.value === "assembleGeelyp155ProdRelease"
  )));
  assert.equal(result.structuredEvidence.some((item) => item.value.includes("com.example.future")), false);
  assert.equal(result.structuredEvidence.every((item) => item.untrusted === true), true);
  assert.equal(result.quality.structuredEvidence.count, result.structuredEvidence.length);
});
