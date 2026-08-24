import assert from "node:assert/strict";
import test from "node:test";

import {
  buildApprovedCaseRetrievalIndex,
  evaluateCaseMemoryCompatibility,
  retrieveApprovedConfigInferenceCases,
  tokenizeConfigInferenceText,
} from "../services/devbench/machine-learn/case-retriever.js";

const memory = (id, overrides = {}) => ({
  id,
  serving: { status: "active" },
  availableAt: "2026-01-01T00:00:00.000Z",
  projectId: "P1",
  target: {
    vehicle: "P162",
    appName: "AppMarket",
    repositoryId: "appmarket",
  },
  ticket: {
    title: "应用市场安装失败",
    description: "包管理和下载模块异常",
  },
  ...overrides,
});

test("中文 n-gram 和代码标识同时进入稀疏检索 token", () => {
  const tokens = tokenizeConfigInferenceText("应用市场 MainFragment.kt com.example.app");
  assert.ok(tokens.includes("应用"));
  assert.ok(tokens.includes("应用市"));
  assert.ok(tokens.includes("mainfragment"));
  assert.ok(tokens.includes("example"));
});

test("索引排除未批准、未来、revoked 和 started 实际执行", () => {
  const index = buildApprovedCaseRetrievalIndex([
    memory("ok"),
    memory("pending", { serving: { status: "pending" } }),
    memory("future", { availableAt: "2026-03-01T00:00:00.000Z" }),
    memory("approved-future", {
      availableAt: "2026-01-01T00:00:00.000Z",
      approvedAt: "2026-03-01T00:00:00.000Z",
    }),
    memory("time-missing", { availableAt: "", createdAt: "" }),
    memory("revoked", { revokedAt: "2026-01-02T00:00:00.000Z" }),
    memory("started", {
      recordType: "actual_execution",
      outcome: "started",
    }),
    memory("accepted", {
      recordType: "actual_execution",
      outcome: "accepted",
    }),
  ], { inferenceAt: "2026-02-01T00:00:00.000Z" });
  assert.deepEqual(index.documents.map((row) => row.id), ["ok", "accepted"]);
  assert.deepEqual(
    new Set(index.excluded.map((row) => row.reason)),
    new Set([
      "NOT_APPROVED",
      "FUTURE_MEMORY",
      "MEMORY_TIME_MISSING",
      "REVOKED_OR_SUPERSEDED",
      "EXECUTION_NOT_ACCEPTED",
    ]),
  );
});

test("应用/仓库未知时 application-specific memory 只能解释、不能加分", async () => {
  const item = memory("appmarket");
  const compatibility = evaluateCaseMemoryCompatibility(item, {
    projectId: "P1",
    vehicle: "P162",
  });
  assert.equal(compatibility.compatible, false);
  assert.equal(compatibility.explanationOnly, true);

  const index = buildApprovedCaseRetrievalIndex([item]);
  const scoring = await retrieveApprovedConfigInferenceCases(index, {
    projectId: "P1",
    vehicle: "P162",
    title: "应用市场",
  });
  assert.deepEqual(scoring, []);
  const explanation = await retrieveApprovedConfigInferenceCases(index, {
    projectId: "P1",
    vehicle: "P162",
    title: "应用市场",
  }, { includeExplanationOnly: true });
  assert.equal(explanation.length, 1);
  assert.equal(explanation[0].score, 0);
  assert.equal(explanation[0].eligibleForScoring, false);
});

test("同车型跨应用记忆被统一 compatibility predicate 隔离", async () => {
  const index = buildApprovedCaseRetrievalIndex([
    memory("appmarket"),
    memory("settings", {
      target: {
        vehicle: "P162",
        appName: "Settings",
        repositoryId: "settings",
      },
      ticket: { title: "设置页蓝牙异常" },
    }),
  ]);
  const rows = await retrieveApprovedConfigInferenceCases(index, {
    projectId: "P1",
    vehicle: "P162",
    appName: "Settings",
    title: "设置页异常",
  });
  assert.deepEqual(rows.map((row) => row.id), ["settings"]);
});

test("embedding 只能重排合法候选，不能绕过项目和注册表上下文", async () => {
  const index = buildApprovedCaseRetrievalIndex([
    memory("legal"),
    memory("other-project", { projectId: "P2" }),
  ]);
  const rows = await retrieveApprovedConfigInferenceCases(index, {
    projectId: "P1",
    appName: "AppMarket",
    title: "完全不同表达",
  }, {
    embeddingSimilarity: async (_query, document) => (
      document.includes("应用市场") ? 0.9 : 1
    ),
  });
  assert.deepEqual(rows.map((row) => row.id), ["legal"]);
  assert.ok(rows[0].denseScore > 0);
});

test("索引快照深度不可变，原样本撤销后即使未重建也不会继续召回", async () => {
  const source = memory("mutable");
  const index = buildApprovedCaseRetrievalIndex([source], {
    inferenceAt: "2026-02-01T00:00:00.000Z",
  });
  assert.throws(() => {
    index.documents[0].memory.target.repositoryId = "tampered";
  }, /read only|Cannot assign/);
  source.serving.status = "revoked";
  source.revokedAt = "2026-01-10T00:00:00.000Z";
  const rows = await retrieveApprovedConfigInferenceCases(index, {
    projectId: "P1",
    appName: "AppMarket",
    title: "应用市场",
  });
  assert.deepEqual(rows, []);
});
