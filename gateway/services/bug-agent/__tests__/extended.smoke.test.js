/**
 * 扩展模块冒烟测试（P2a / P3 / P4 / P7 / P8 / 聚类/规则提炼骨架）
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";

import { BugAgentStorage } from "../storage/db.js";

// ---- P4 ----
import {
  smoothedRuleScore,
  computeRulePrior,
  updateOnRating,
  cronWeeklyNormalization,
} from "../scoring/weight-updater.js";

// ---- P3 ----
import {
  appendSessionMemory,
  listSessionMemory,
  cronCleanupExpiredSessions,
  getOrCreateProfile,
  addExpertise,
  addContribution,
  selfProfile,
  offboardProfile,
  reactivateProfile,
  purgeUser,
} from "../memory/session-memory.js";

// ---- P2a ----
import { seedPresetTree, PRESET_TREE } from "../memory/tree-preset.js";
import {
  resolveLeafNode,
  attachCaseToNode,
  retrieveSimilarCases,
  deprecateNode,
  mergeNodes,
} from "../memory/tree-ops.js";

// ---- P8 ----
import { cronRetentionPurge } from "../ops/retention-cron.js";
import {
  computeCostUsd,
  checkBudget,
  recordLlmCost,
  listRecentCost,
} from "../ops/llm-budget.js";

// ---- P7 ----
import {
  validateGoldenSet,
  appendGoldenCase,
  loadGoldenSet,
} from "../testing/golden-set.js";
import {
  runGoldenRegression,
  evaluateRegressionGate,
} from "../testing/regression.js";
import { evaluateJudgeGate } from "../testing/llm-judge.js";

// ---- P2b / P5 骨架 ----
import {
  runDailyClusterCron,
  shouldTriggerLlmClustering,
} from "../memory/cluster-cron.js";
import {
  findCandidateGroups,
  proposeRule,
  approveRule,
  rejectRule,
  runWeeklyRuleMiner,
} from "../ops/rule-miner.js";

import { insertCase, insertEvidence, insertReport } from "../storage/db.js";
import { analyzeTbCase } from "../classifier/classifier.js";

let storage;
before(() => {
  storage = new BugAgentStorage({ inMemory: true });
});

// ========= P4 评分权重 =========

test("P4: smoothedRuleScore 平滑更新", () => {
  const before = 1.0;
  const after = smoothedRuleScore(before, 5, 10);
  assert.ok(after > before, "高分应提升权重");
  assert.ok(after <= 5.0);
});

test("P4: smoothedRuleScore 低分下降", () => {
  const before = 2.0;
  const after = smoothedRuleScore(before, 1, 5);
  assert.ok(after < before);
});

test("P4: computeRulePrior 空数组返回 0", () => {
  assert.equal(computeRulePrior([]), 0);
});

test("P4: computeRulePrior 输出在 [0,1]", () => {
  const p = computeRulePrior([{ rule_score: 3, hit_count: 50 }, { rule_score: 4, hit_count: 100 }]);
  assert.ok(p >= 0 && p <= 1);
});

test("P4: 低分评分 (<=2) 标记 report pending_review + 权重更新", async () => {
  await analyzeTbCase(
    { tb_id: "P4-001", package_name: "com.xxx.music", title: "启动后闪退",
      raw_content: "打开应用后立即闪退", log_attachment: "FATAL EXCEPTION: main\n  Process: com.xxx.music, PID: 1" },
    { storage }
  );
  // 找到该 case 的 report
  const { db } = storage.resolveTargetDb("com.xxx.music");
  const rep = db.prepare("SELECT id FROM reports WHERE case_id=(SELECT id FROM cases WHERE tb_id=?)").get("P4-001");
  assert.ok(rep);

  // 插入规则 + ratings
  const rr = db.prepare("INSERT INTO rules (pattern, category, sub_category, status) VALUES ('x','代码问题','Java Crash','active')").run();
  db.prepare("UPDATE reports SET matched_rules=? WHERE id=?").run(JSON.stringify([rr.lastInsertRowid]), rep.id);

  const result = updateOnRating(storage, {
    report_id: rep.id, package_name: "com.xxx.music", score: 2,
    matched_rule_ids: [rr.lastInsertRowid],
  });
  assert.equal(result.rules_updated, 1);

  const repAfter = db.prepare("SELECT status FROM reports WHERE id=?").get(rep.id);
  assert.equal(repAfter.status, "pending_review");
});

test("P4: cronWeeklyNormalization 冷衰减 + 归档", () => {
  const { db } = storage.resolveTargetDb("com.xxx.music");
  db.prepare(
    "INSERT INTO rules (pattern, category, sub_category, status, updated_at) VALUES ('old','代码问题','x','active', '2020-01-01T00:00:00Z')"
  ).run();
  const stats = cronWeeklyNormalization(storage, { package_name: "com.xxx.music" });
  assert.ok(stats.rules_archived >= 1, `rules_archived=${stats.rules_archived}`);
});

// ========= P3 会话记忆 =========

test("P3: appendSessionMemory + listSessionMemory", () => {
  appendSessionMemory(storage, { session_id: "S1", case_id: 1, content: "用户补充：刚升级系统" });
  appendSessionMemory(storage, { session_id: "S1", case_id: 1, content: "只在冷启动出现" });
  const rows = listSessionMemory(storage, { session_id: "S1", case_id: 1 });
  assert.equal(rows.length, 2);
});

test("P3: TTL 过期被清理", () => {
  const common = storage.openCommon();
  // 手造一条过期 session
  common.prepare(
    "INSERT INTO session_memory (session_id, case_id, content, expires_at) VALUES ('STALE', 1, 'old', '2000-01-01T00:00:00Z')"
  ).run();
  const before = common.prepare("SELECT COUNT(*) c FROM session_memory").get().c;
  const r = cronCleanupExpiredSessions(storage);
  assert.ok(r.deleted >= 1);
  const after = common.prepare("SELECT COUNT(*) c FROM session_memory").get().c;
  assert.ok(after < before);
});

test("P3: profile 懒创建 + expertise/contribution 累加", () => {
  getOrCreateProfile(storage, "alice");
  addExpertise(storage, "alice", "AudioFocus");
  addExpertise(storage, "alice", "AudioFocus"); // 去重
  addContribution(storage, "alice", 5);
  const p = selfProfile(storage, "alice");
  assert.equal(p.user_id, "alice");
  assert.deepEqual(p.expertise, ["AudioFocus"]);
  assert.equal(p.contribution_score, 5);
});

test("P3: 离职软删除 + 再入职", () => {
  getOrCreateProfile(storage, "bob");
  offboardProfile(storage, "bob");
  assert.equal(selfProfile(storage, "bob"), null);
  reactivateProfile(storage, "bob");
  assert.ok(selfProfile(storage, "bob"));
});

test("P3: purgeUser 物理删除 profile + reporter_id 置空 + 写 purge_log", () => {
  const { db } = storage.resolveTargetDb("com.xxx.music");
  db.prepare("UPDATE cases SET reporter_id='charlie' WHERE tb_id='P4-001'").run();
  getOrCreateProfile(storage, "charlie");

  purgeUser(storage, "charlie", "admin");

  assert.equal(selfProfile(storage, "charlie"), null);
  const r = db.prepare("SELECT reporter_id FROM cases WHERE tb_id='P4-001'").get();
  assert.equal(r.reporter_id, null);

  const common = storage.openCommon();
  const log = common.prepare("SELECT * FROM purge_log WHERE target='charlie'").get();
  assert.ok(log);
});

// ========= P2a 记忆树 =========

test("P2a: 预置树 seed 幂等", () => {
  const { db } = storage.resolveTargetDb("com.xxx.music");
  const first = seedPresetTree(db);
  const second = seedPresetTree(db);
  assert.ok(first.created + first.skipped >= 20);
  assert.equal(second.created, 0, "第二次 seed 不应新增");
});

test("P2a: resolveLeafNode 按 sub_category 匹配", () => {
  const { db } = storage.resolveTargetDb("com.xxx.music");
  const leaf = resolveLeafNode(db, { category: "代码问题", sub_category: "Java Crash" });
  assert.ok(leaf);
});

test("P2a: resolveLeafNode 未知 sub_category fallback 到 待归类", () => {
  const { db } = storage.resolveTargetDb("com.xxx.music");
  const leaf = resolveLeafNode(db, { category: "未知类", sub_category: "也是未知" });
  assert.ok(leaf);
});

test("P2a: attachCaseToNode + retrieveSimilarCases", () => {
  const { db } = storage.resolveTargetDb("com.xxx.music");
  // 创建一个 node + case，测试挂接
  const nodeRow = db.prepare("SELECT id, version FROM memory_tree WHERE title LIKE '%ANR%' AND level=2 LIMIT 1").get();
  assert.ok(nodeRow);

  const caseRow = db.prepare("SELECT id FROM cases WHERE tb_id='P4-001'").get();
  attachCaseToNode(db, { node_id: nodeRow.id, case_id: caseRow.id, node_version: nodeRow.version });

  const results = retrieveSimilarCases(db, { query_text: "ANR", top_node_n: 3, top_case_n: 5 });
  const hasMusic = results.some((r) => r.cases.some((c) => c.tb_id === "P4-001"));
  assert.ok(hasMusic);
});

test("P2a: deprecateNode 迁移 case 到父节点", () => {
  const { db } = storage.resolveTargetDb("com.xxx.music");
  // 新建一个叶子节点 + 挂 case
  const parent = db.prepare("SELECT id FROM memory_tree WHERE title='稳定性类' LIMIT 1").get();
  const leaf = db.prepare(
    "INSERT INTO memory_tree (parent_id, level, title, status) VALUES (?, 2, 'test-leaf', 'active')"
  ).run(parent.id);
  const caseRow = db.prepare("SELECT id FROM cases LIMIT 1").get();
  attachCaseToNode(db, { node_id: leaf.lastInsertRowid, case_id: caseRow.id, node_version: 1 });

  const r = deprecateNode(db, leaf.lastInsertRowid);
  assert.equal(r.moved, 1);
  assert.equal(r.into_parent, parent.id);

  const node = db.prepare("SELECT status FROM memory_tree WHERE id=?").get(leaf.lastInsertRowid);
  assert.equal(node.status, "deprecated");
});

test("P2a: mergeNodes 合并兄弟节点", () => {
  const { db } = storage.resolveTargetDb("com.xxx.music");
  const parent = db.prepare("SELECT id FROM memory_tree WHERE title='音频类' LIMIT 1").get();
  const a = db.prepare("INSERT INTO memory_tree (parent_id, level, title, status) VALUES (?, 2, 'temp-a', 'active')").run(parent.id);
  const b = db.prepare("INSERT INTO memory_tree (parent_id, level, title, status) VALUES (?, 2, 'temp-b', 'active')").run(parent.id);

  const r = mergeNodes(db, { source_node_ids: [a.lastInsertRowid, b.lastInsertRowid], merged_title: "merged-ab" });
  assert.ok(r.merged_id);

  const aNow = db.prepare("SELECT status FROM memory_tree WHERE id=?").get(a.lastInsertRowid);
  assert.equal(aNow.status, "deprecated");
});

// ========= P8 数据保留 + 成本 =========

test("P8: computeCostUsd 定价正确", () => {
  // 1M in + 1M out = 0.80 + 4.00 = 4.80
  assert.ok(Math.abs(computeCostUsd(1_000_000, 1_000_000) - 4.80) < 0.001);
});

test("P8: recordLlmCost 累加到同日 row", () => {
  recordLlmCost(storage, { tokens_in: 10000, tokens_out: 1000 });
  recordLlmCost(storage, { tokens_in: 20000, tokens_out: 2000 });
  const recent = listRecentCost(storage, 1);
  assert.ok(recent.length >= 1);
  const today = recent[0];
  assert.ok(today.tokens_in >= 30000);
  assert.ok(today.tokens_out >= 3000);
});

test("P8: checkBudget 返回剩余值", () => {
  const b = checkBudget(storage, { budget_usd: 10 });
  assert.ok(b.usd >= 0);
  assert.ok(b.remaining <= 10);
  assert.ok(typeof b.over_limit === "boolean");
});

test("P8: cronRetentionPurge dry_run 不改数据", () => {
  const r = cronRetentionPurge(storage, { package_name: "com.xxx.music", dry_run: true });
  assert.ok(r.dry_run);
});

test("P8: cronRetentionPurge 超期 case 被脱敏", () => {
  const { db } = storage.resolveTargetDb("com.xxx.music");
  db.prepare(
    "INSERT INTO cases (tb_id, package_name, title, raw_content, created_at, legal_hold) VALUES ('OLD-001','com.xxx.music','老 case','敏感正文','2020-01-01T00:00:00Z', 0)"
  ).run();
  const r = cronRetentionPurge(storage, { package_name: "com.xxx.music" });
  assert.ok(r.cases_scrubbed >= 1);
  const scrubbed = db.prepare("SELECT raw_content FROM cases WHERE tb_id='OLD-001'").get();
  assert.equal(scrubbed.raw_content, "");
});

test("P8: legal_hold case 不被脱敏", () => {
  const { db } = storage.resolveTargetDb("com.xxx.music");
  db.prepare(
    "INSERT INTO cases (tb_id, package_name, title, raw_content, created_at, legal_hold) VALUES ('LEGAL-001','com.xxx.music','诉讼 case','敏感正文','2020-01-01T00:00:00Z', 1)"
  ).run();
  cronRetentionPurge(storage, { package_name: "com.xxx.music" });
  const row = db.prepare("SELECT raw_content FROM cases WHERE tb_id='LEGAL-001'").get();
  assert.ok(row.raw_content && row.raw_content.length > 0);
});

// ========= P7 测试体系 =========

test("P7: validateGoldenSet 捕获缺字段", () => {
  const r = validateGoldenSet([
    { tb_id: "G1", package_name: "com.x", raw_content: "x", expected_category: "代码问题" },
    { tb_id: "G1", package_name: "com.x", raw_content: "x", expected_category: "代码问题" }, // duplicate
    { tb_id: "G2", package_name: "com.x", raw_content: "x", expected_category: "性能问题" }, // invalid cat
  ]);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("duplicate")));
  assert.ok(r.errors.some((e) => e.includes("expected_category")));
});

test("P7: runGoldenRegression 基础统计", async () => {
  const golden = [
    { tb_id: "GR-001", package_name: "com.xxx.music", title: "启动后闪退",
      raw_content: "crash", log_attachment: "FATAL EXCEPTION: main\n  Process: com.xxx.music, PID: 1",
      expected_category: "代码问题", expected_sub_category: "Java Crash" },
  ];
  const r = await runGoldenRegression(golden, { storage });
  assert.equal(r.total, 1);
  assert.equal(r.category_correct, 1);
  assert.equal(r.category_accuracy, 1);
});

test("P7: evaluateRegressionGate 下降 > 5% 拦截", () => {
  const r = evaluateRegressionGate(
    { category_accuracy: 0.70 },
    { category_accuracy: 0.80 }
  );
  assert.equal(r.should_block, true);
});

test("P7: evaluateJudgeGate 低于 0.75 阈值拦截", () => {
  assert.equal(evaluateJudgeGate(0.7).should_block, true);
  assert.equal(evaluateJudgeGate(0.8).should_block, false);
});

// ========= P2b 聚类骨架 =========

test("P2b: shouldTriggerLlmClustering 阈值判断", () => {
  const pending20 = new Array(20).fill({ exception_class: "X" });
  const history5 = new Array(5).fill({ exception_class: "X" });
  assert.equal(shouldTriggerLlmClustering(pending20, history5), true);
  assert.equal(shouldTriggerLlmClustering(new Array(5).fill({}), history5), false);
});

test("P2b: runDailyClusterCron 跑通骨架（embedding 关闭）", async () => {
  const r = await runDailyClusterCron(storage, "com.xxx.music", {
    resolveLeaf: resolveLeafNode,
    attach: attachCaseToNode,
  });
  assert.equal(r.package_name, "com.xxx.music");
  assert.equal(r.embedding_enabled, false);
  assert.ok(typeof r.new_cases === "number");
});

// ========= P5 规则提炼骨架 =========

test("P5: findCandidateGroups 无数据返回空", () => {
  const { db } = storage.resolveTargetDb("com.xxx.other-pkg");
  const groups = findCandidateGroups(db);
  assert.equal(groups.length, 0);
});

test("P5: proposeRule 写 pending_review", () => {
  const { db } = storage.resolveTargetDb("com.xxx.music");
  const r = proposeRule(db, {
    category: "代码问题",
    sub_category: "新模式",
    pattern: "xxx",
    conclusion: "待审核",
  });
  const row = db.prepare("SELECT status FROM rules WHERE id=?").get(r.id);
  assert.equal(row.status, "pending_review");
});

test("P5: approveRule / rejectRule", () => {
  const { db } = storage.resolveTargetDb("com.xxx.music");
  const r = proposeRule(db, { category: "UI 问题", sub_category: "布局", pattern: "y", conclusion: "x" });
  approveRule(db, r.id);
  assert.equal(db.prepare("SELECT status FROM rules WHERE id=?").get(r.id).status, "active");

  const r2 = proposeRule(db, { category: "UI 问题", sub_category: "样式", pattern: "z", conclusion: "w" });
  rejectRule(db, r2.id, "不够通用");
  assert.equal(db.prepare("SELECT status FROM rules WHERE id=?").get(r2.id).status, "rejected");
});
