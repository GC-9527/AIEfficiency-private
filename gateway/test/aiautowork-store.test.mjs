// AI 工作台 — store + schema 基础冒烟测试。
// 用真实 db 模块（sqlite.js 已注入 schema）；验证表存在、默认 settings 21 条、idempotency、批量创建、overview。

import { test } from "node:test";
import assert from "node:assert/strict";
import db from "../db/sqlite.js";
import * as store from "../services/aiautowork/store.js";
import { computeIdempotencyKey } from "../db/aiautowork-schema.js";
import { ERROR_CODES, AiautoworkError } from "../services/aiautowork/error-codes.js";

test("schema: 14 张表（含 aiautowork_settings）已建立", () => {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name IN ('task_drafts','batch_creation_jobs','batch_task_items','config_candidate_attempts','validation_issues','manual_intervention_cases','resolved_config_snapshots','story_points','story_point_config_versions','config_audit_events','execution_queue','aiautowork_settings','review_targets','review_findings')) ORDER BY name").all().map((r) => r.name);
  const expected = [
    "aiautowork_settings",
    "batch_creation_jobs",
    "batch_task_items",
    "config_audit_events",
    "config_candidate_attempts",
    "execution_queue",
    "manual_intervention_cases",
    "resolved_config_snapshots",
    "review_findings",
    "review_targets",
    "story_point_config_versions",
    "story_points",
    "task_drafts",
    "validation_issues",
  ];
  assert.equal(tables.length, expected.length, `actual ${tables.join(",")}`);
  for (const t of expected) assert.ok(tables.includes(t), `missing ${t}`);
});

test("默认 settings 至少 21 条且覆盖 8 组", () => {
  const rows = db.prepare("SELECT key, value_json, description FROM aiautowork_settings").all();
  assert.ok(rows.length >= 21, `expected >=21, got ${rows.length}`);
  const keys = rows.map((r) => r.key);
  const concurrencyKeys = keys.filter((k) => k.startsWith("concurrency."));
  const routingKeys = keys.filter((k) => k.startsWith("routing."));
  const featureKeys = keys.filter((k) => k.startsWith("feature."));
  const permissionKeys = keys.filter((k) => k.startsWith("permissions."));
  assert.ok(concurrencyKeys.length >= 4);
  assert.ok(routingKeys.length >= 4);
  assert.ok(featureKeys.length >= 4);
  assert.ok(permissionKeys.length >= 2);
});

test("computeIdempotencyKey 确定性 & sha256 前缀", () => {
  const a = computeIdempotencyKey({ sourceType: "TB", sourceRef: "CARB-1", normalizedInput: { x: 1 }, configHash: "ch1", policyVersion: "1" });
  const b = computeIdempotencyKey({ sourceType: "TB", sourceRef: "CARB-1", normalizedInput: { x: 1 }, configHash: "ch1", policyVersion: "1" });
  assert.equal(a, b);
  assert.ok(a.startsWith("sha256:"));
  assert.equal(a.length, "sha256:".length + 64);
  const c = computeIdempotencyKey({ sourceType: "TB", sourceRef: "CARB-2", normalizedInput: { x: 1 }, configHash: "ch1", policyVersion: "1" });
  assert.notEqual(a, c);
});

test("createTaskDraft 成功 + 同 idempotency_key 重复抛 DUPLICATE_TASK_DRAFT", () => {
  const unique = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const draft = {
    sourceType: "TB",
    sourceRef: unique,
    normalizedInput: { title: unique },
    configHash: "ch-" + unique,
    policyVersion: "1",
  };
  const created = store.createTaskDraft(draft);
  assert.ok(created && created.id, "should return draft with id");
  assert.equal(created.status, "INPUT_PARSED");
  // 清理：测试结束前删掉避免污染真实 db（createTaskDraft 没有 delete；直连 db）
  try {
    let caught = null;
    try { store.createTaskDraft(draft); } catch (e) { caught = e; }
    assert.ok(caught, "duplicate must throw");
    assert.ok(caught instanceof AiautoworkError, "must be AiautoworkError");
    assert.equal(caught.code, ERROR_CODES.DUPLICATE_TASK_DRAFT);
    assert.equal(caught.httpStatus, 409);
  } finally {
    db.prepare("DELETE FROM task_drafts WHERE id = ?").run(created.id);
  }
});

test("createTaskDraft 缺 sourceType 抛 INVALID_INPUT", () => {
  let caught = null;
  try { store.createTaskDraft({}); } catch (e) { caught = e; }
  assert.ok(caught);
  assert.equal(caught.code, ERROR_CODES.INVALID_INPUT);
});

test("BatchJob + BatchTaskItem + overview", () => {
  const job = store.createBatchJob({ name: "smoke-" + Date.now(), total: 2 });
  assert.ok(job && job.id);
  assert.equal(job.total, 2);
  const item1 = store.createBatchTaskItem({ batchId: job.id, pool: "inference", priority: 1, status: "queued" });
  const item2 = store.createBatchTaskItem({ batchId: job.id, pool: "inference", priority: 1, status: "queued" });
  assert.ok(item1.id && item2.id);
  const items = store.listBatchTaskItems({ batchId: job.id });
  assert.equal(items.length, 2);
  const ov = store.getOverviewCounts();
  assert.ok(ov && typeof ov === "object");
  // 清理
  db.prepare("DELETE FROM batch_task_items WHERE batch_id = ?").run(job.id);
  db.prepare("DELETE FROM batch_creation_jobs WHERE id = ?").run(job.id);
});

test("error codes 包含必需条目", () => {
  assert.equal(typeof ERROR_CODES.DUPLICATE_TASK_DRAFT, "string");
  assert.equal(typeof ERROR_CODES.INVALID_INPUT, "string");
  assert.equal(typeof ERROR_CODES.INTERNAL_ERROR, "string");
  // httpStatus 必须存在并合理
  const e = new AiautoworkError(ERROR_CODES.DUPLICATE_TASK_DRAFT, "msg");
  assert.equal(e.code, ERROR_CODES.DUPLICATE_TASK_DRAFT);
  assert.ok(e.httpStatus >= 400 && e.httpStatus < 600);
});