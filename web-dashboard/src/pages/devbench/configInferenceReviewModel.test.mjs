import assert from "node:assert/strict";
import test from "node:test";

import {
  configInferenceDisplayText,
  configInferenceSessionKey,
  configInferenceReviewRecovery,
  configInferenceRunProjectId,
  defaultConfigInferenceReviewDecision,
  defaultConfigInferenceReviewRating,
  recoveredReviewSession,
  replaceConfigSuggestWithRefreshedSession,
} from "./configInferenceReviewModel.mjs";

test("配置推理表单只展示可读标量，不把异常对象渲染成对象字符串", () => {
  assert.equal(configInferenceDisplayText(" AppMarket "), "AppMarket");
  assert.equal(configInferenceDisplayText(8678), "8678");
  assert.equal(configInferenceDisplayText(false), "false");
  assert.equal(configInferenceDisplayText({ repositoryName: "AppMarket" }), "");
  assert.equal(configInferenceDisplayText(["AppMarket"]), "");
  assert.equal(configInferenceDisplayText(null), "");
});

test("信息不足或空目标预测默认按信息不足确认，确认并继续不会提交非法正向空目标", () => {
  assert.equal(defaultConfigInferenceReviewDecision({ prediction: { status: "NEED_MORE_INFO", targets: [] } }), "insufficient");
  assert.equal(defaultConfigInferenceReviewDecision({ prediction: { status: "NEED_MORE_INFO", targets: [{ repositoryId: "appMarket" }] } }), "insufficient");
  assert.equal(defaultConfigInferenceReviewDecision({ prediction: { status: "READY", targets: [] } }), "insufficient");
  assert.equal(defaultConfigInferenceReviewDecision({ prediction: { status: "READY", targets: [{ repositoryId: "appMarket" }] } }), "correct");
  assert.equal(defaultConfigInferenceReviewDecision({ prediction: { status: "NEED_MORE_INFO", targets: [] } }, { decision: "corrected" }), "corrected");
  assert.equal(defaultConfigInferenceReviewDecision({}, null, true), "corrected");
  assert.equal(defaultConfigInferenceReviewRating("insufficient"), 1);
  assert.equal(defaultConfigInferenceReviewRating("correct"), 5);
  assert.equal(defaultConfigInferenceReviewRating("corrected"), 3);
  assert.equal(defaultConfigInferenceReviewRating("insufficient", { rating: 2 }), 2);
});

test("同一 run 原位升级规则后生成新的人工确认 session key", () => {
  const stale = {
    id: "run-1",
    version: "config-inference-rules-v1",
    predictionRevision: 0,
    updatedAt: 100,
    ticket: { ticketId: "6a53397ecc68c293ea295e88", title: "【极氪】【9X】【AppMarket】" },
    prediction: { createdAt: 90, targets: [{ vehicle: "avatr8678" }] },
  };
  const refreshed = {
    ...stale,
    version: "config-inference-rules-v2",
    predictionRevision: 1,
    updatedAt: 200,
    refresh: { refreshedAt: 200 },
    prediction: { createdAt: 190, targets: [{ vehicle: "zeekr9x" }] },
  };

  assert.equal(configInferenceSessionKey({ ...stale }), configInferenceSessionKey(stale));
  assert.notEqual(configInferenceSessionKey(refreshed), configInferenceSessionKey(stale));
});

test("开发前复核只消费当前 run 的 stale 409 重算结果", () => {
  const current = { tabId: "tab-1", session: { id: "run-1", version: "v1" }, kickAfter: true };
  const response = {
    ok: false,
    stale: true,
    refreshed: true,
    data: { id: "run-1", version: "v2", predictionRevision: 1 },
  };

  const replaced = replaceConfigSuggestWithRefreshedSession(current, "run-1", response);
  assert.notEqual(replaced, current);
  assert.equal(replaced.session, response.data);
  assert.equal(replaced.tabId, "tab-1");
  assert.equal(replaced.kickAfter, true);
  assert.equal(replaceConfigSuggestWithRefreshedSession(current, "another-run", response), current);
  assert.equal(replaceConfigSuggestWithRefreshedSession(current, "run-1", { ...response, refreshed: false }), current);
});

test("评分恢复使用 run 自身项目并只携带服务端重建所需上下文", () => {
  const run = {
    id: "run-1",
    projectId: "project-run",
    trainingSessionId: "training-1",
    version: "rules-v3",
    registryVersion: "registry-9",
    createdAt: 123,
    ticket: { tbTaskId: "ticket-1", title: "TB 标题" },
    prediction: { status: "NEED_HUMAN_CONFIRMATION", targets: [{ repositoryId: "appMarket" }] },
    options: { repositories: [{ id: "secret-not-needed" }] },
  };
  assert.equal(configInferenceRunProjectId(run, "panel-project"), "project-run");
  assert.equal(configInferenceRunProjectId({}, "panel-project"), "panel-project");
  assert.deepEqual(configInferenceReviewRecovery(run), {
    ticket: run.ticket,
    trainingSessionId: "training-1",
    expectedPrediction: run.prediction,
    version: "rules-v3",
    registryVersion: "registry-9",
    createdAt: 123,
  });
});

test("服务器恢复结果变化时保留纠正目标和评分草稿", () => {
  const draft = { decision: "corrected", rating: 2, correctedPrediction: { targets: [{ repositoryId: "webApp" }] } };
  const session = recoveredReviewSession({ recovered: true, data: { id: "run-1", updatedAt: 200 } }, draft);
  assert.equal(session.id, "run-1");
  assert.deepEqual(session._reviewDraft, draft);
  assert.equal(recoveredReviewSession({ recovered: false, data: { id: "run-2" } }, draft).id, "run-2");
});
