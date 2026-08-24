import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const unitTmp = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-v2-deterministic-report-production-"));
process.env.GATEWAY_DB_PATH = path.join(unitTmp, "data.db");
process.env.GATEWAY_CONFIG_PATH = path.join(unitTmp, "gateway.json");
process.env.DEVBENCH_CONFIG_PATH = path.join(unitTmp, "market.json");
process.env.DEVBENCH_LOCAL_PROJECTS_PATH = path.join(unitTmp, "local-projects.json");
process.env.DEVBENCH_STORE_DIR = path.join(unitTmp, "store");
process.env.AIEFFICIENCY_CLONE_PARENT = path.join(unitTmp, "clone-parent");
fs.writeFileSync(process.env.GATEWAY_CONFIG_PATH, JSON.stringify({ servers: { nodeId: "deterministic-report-unit" } }));

const { kickReport } = await import("../services/devbench/index.js");

const TB_URL = "https://www.teambition.com/task/0123456789abcdef01234567";

function tabFixture(id, extra = {}) {
  return {
    id,
    title: id,
    ticketUrl: TB_URL,
    primaryProjectId: "project-main",
    reportMode: "short",
    workflow: { enabled: true, phase: "reporting", fixedAt: 10, verifyPassedAt: 20 },
    ...extra,
  };
}

function fakeStore(tabs) {
  const rows = new Map(tabs.map((tab) => [tab.id, structuredClone(tab)]));
  return {
    getTab(id) {
      const value = rows.get(id);
      return value ? structuredClone(value) : null;
    },
    updateTab(id, patch) {
      const current = rows.get(id);
      const next = { ...current, ...structuredClone(patch) };
      rows.set(id, next);
      return structuredClone(next);
    },
    getPrimaryProject() {
      return { id: "project-main", path: unitTmp };
    },
    getGroupMembers(groupId) {
      return [...rows.values()].filter((tab) => tab.groupId === groupId).map((tab) => structuredClone(tab));
    },
  };
}

function deterministicConfig() {
  return { workflowV2: { featureFlags: { shortReportDeterministic: true } } };
}

test("kickReport 的确定性短报告路径零 Provider、零工具调用并直接结算", async () => {
  const tab = tabFixture("deterministic-single");
  const storeApi = fakeStore([tab]);
  let providerCalls = 0;
  let applied = null;
  const result = await kickReport(tab.id, "", null, {
    storeApi,
    config: deterministicConfig(),
    loadFacts: async ({ tab: current }) => ({ storyId: current.id }),
    renderShortReport: ({ reportFacts }) => ({
      ok: true,
      text: `原因：${reportFacts.storyId}缓存键缺少车型。措施：补充车型维度并增加回归测试。`,
    }),
    applyWorkflowFn: async (_tab, workflow) => {
      applied = workflow;
      return { phase: "testable", sync: { commentOk: true } };
    },
    sendTurnFn: async () => { providerCalls++; throw new Error("Provider 不应被调用"); },
  });

  assert.equal(result.ok, true);
  assert.equal(result.deterministic, true);
  assert.equal(result.started, false);
  assert.equal(providerCalls, 0);
  assert.equal(applied.kind, "report_done");
  assert.equal(applied.deterministic, true);
  assert.match(applied.shortReport, /^原因：.+。措施：.+。$/u);
});

test("可信 facts 缺失时保持 reporting，零 Provider、零 TB 结算", async () => {
  const tab = tabFixture("deterministic-blocked");
  const storeApi = fakeStore([tab]);
  let providerCalls = 0;
  let applyCalls = 0;
  const result = await kickReport(tab.id, "", null, {
    storeApi,
    config: deterministicConfig(),
    loadFacts: async () => { throw Object.assign(new Error("没有已接受的 REPAIR facts"), { code: "FACTS_MISSING" }); },
    applyWorkflowFn: async () => { applyCalls++; return { phase: "testable" }; },
    sendTurnFn: async () => { providerCalls++; return {}; },
  });

  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert.equal(result.phase, "reporting");
  assert.equal(providerCalls, 0);
  assert.equal(applyCalls, 0);
  assert.match(storeApi.getTab(tab.id).workflow.reportError, /REPAIR facts/);
});

test("跳过测试验收的确定性短报告保留未执行边界且不调用 Provider", async () => {
  const tab = tabFixture("deterministic-skipped", {
    skipTestAcceptance: true,
    workflow: { enabled: true, phase: "reporting", fixedAt: 10 },
  });
  const storeApi = fakeStore([tab]);
  let applied = null;
  let providerCalls = 0;
  const result = await kickReport(tab.id, "", null, {
    storeApi,
    config: deterministicConfig(),
    loadFacts: async () => ({ storyId: tab.id }),
    renderShortReport: () => ({ ok: true, text: "原因：状态未刷新。措施：刷新状态。" }),
    applyWorkflowFn: async (_tab, workflow) => { applied = workflow; return { phase: "testable" }; },
    sendTurnFn: async () => { providerCalls++; return {}; },
  });

  assert.equal(result.ok, true);
  assert.equal(providerCalls, 0);
  assert.match(applied.shortReport, /测试验收：已按用户选择跳过，本轮未执行/);
  assert.doesNotMatch(applied.shortReport, /验收通过/);
});

test("全短报告故事点组逐成员读取各自 facts，不复用组长文案", async () => {
  const groupId = "group-short";
  const leader = tabFixture("group-short-leader", { groupId });
  const member = tabFixture("group-short-member", { groupId });
  const storeApi = fakeStore([leader, member]);
  let applied = null;
  let providerCalls = 0;
  const result = await kickReport(leader.id, "", null, {
    storeApi,
    config: deterministicConfig(),
    loadFacts: async ({ tab: current }) => ({ storyId: current.id }),
    renderShortReport: ({ reportFacts }) => ({
      ok: true,
      text: `原因：${reportFacts.storyId}映射缺失。措施：补齐映射并增加校验。`,
    }),
    applyWorkflowFn: async (_tab, workflow) => { applied = workflow; return { phase: "testable" }; },
    sendTurnFn: async () => { providerCalls++; return {}; },
  });

  assert.equal(result.ok, true);
  assert.equal(providerCalls, 0);
  assert.notEqual(applied.memberShortReports[leader.id], applied.memberShortReports[member.id]);
  assert.match(applied.memberShortReports[leader.id], new RegExp(leader.id));
  assert.match(applied.memberShortReports[member.id], new RegExp(member.id));
});

test("故事点组含专家模式时保持现有专家 Provider 路径", async () => {
  const groupId = "group-mixed";
  const leader = tabFixture("group-mixed-leader", { groupId });
  const expert = tabFixture("group-mixed-expert", { groupId, reportMode: "expert" });
  const storeApi = fakeStore([leader, expert]);
  let providerCalls = 0;
  let factsCalls = 0;
  const result = await kickReport(leader.id, "", null, {
    storeApi,
    config: deterministicConfig(),
    loadFacts: async () => { factsCalls++; return {}; },
    sendTurnFn: async () => { providerCalls++; return { taskId: "provider-task" }; },
  });

  assert.equal(result.started, true);
  assert.equal(result.reportMode, "expert");
  assert.equal(providerCalls, 1);
  assert.equal(factsCalls, 0);
});

test("sync_pending 报告重试直接恢复冻结 Saga，零 Provider", async () => {
  const tab = tabFixture("deterministic-resume", {
    workflow: {
      enabled: true,
      phase: "sync_pending",
      tbSyncPending: { kind: "report" },
    },
  });
  const storeApi = fakeStore([tab]);
  let providerCalls = 0;
  let resumeCalls = 0;
  const result = await kickReport(tab.id, "", null, {
    storeApi,
    config: deterministicConfig(),
    resumePendingTbSyncFn: async () => {
      resumeCalls++;
      return { ok: true, phase: "testable", resumed: true };
    },
    sendTurnFn: async () => { providerCalls++; return {}; },
  });

  assert.equal(result.resumed, true);
  assert.equal(result.pending, false);
  assert.equal(resumeCalls, 1);
  assert.equal(providerCalls, 0);
});

test("未通过 VERIFY PASS 或不在 reporting 阶段时短报告零 Provider、零 TB 结算", async () => {
  for (const [id, workflow, code] of [
    ["report-without-verify", { enabled: true, phase: "reporting", fixedAt: 10 }, "WORKFLOW_REPORT_VERIFY_REQUIRED"],
    ["report-from-fixing", { enabled: true, phase: "fixing", fixedAt: 10, verifyPassedAt: 20 }, "WORKFLOW_REPORT_PHASE_INVALID"],
  ]) {
    const tab = tabFixture(id, { workflow });
    const storeApi = fakeStore([tab]);
    let providerCalls = 0;
    let applyCalls = 0;
    let factsCalls = 0;
    const result = await kickReport(tab.id, "", null, {
      storeApi,
      config: deterministicConfig(),
      loadFacts: async () => { factsCalls++; return {}; },
      applyWorkflowFn: async () => { applyCalls++; return {}; },
      sendTurnFn: async () => { providerCalls++; return {}; },
    });

    assert.equal(result.started, false);
    assert.equal(result.blocked, true);
    assert.equal(result.code, code);
    assert.equal(factsCalls, 0);
    assert.equal(applyCalls, 0);
    assert.equal(providerCalls, 0);
  }
});

after(() => {
  try { fs.rmSync(unitTmp, { recursive: true, force: true }); } catch {}
});
