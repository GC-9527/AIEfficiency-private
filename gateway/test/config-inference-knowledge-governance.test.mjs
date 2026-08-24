import assert from "node:assert/strict";
import test from "node:test";
import {
  activateKnowledgeValueRevision,
  createKnowledgeKey,
  createKnowledgeValueRevision,
  knowledgeValueImpact,
  resolveKnowledgeValue,
  rollbackKnowledgeValueRevision,
  transitionKnowledgeValueRevision,
} from "../services/devbench/machine-learn/knowledge-governance.js";

function key() {
  return createKnowledgeKey({
    canonicalKey: "branch-policy.appmarket.8678.release",
    dimension: "branch",
    scopePolicy: ["global", "project", "environment", "node", "task"],
    legacyLogicalKey: "ci.branch.release-old.123",
  }, { idFactory: () => "K_stable", now: 0 });
}

test("knowledge key 身份与 actual value 无关并保留旧 logicalKey alias", () => {
  const value = key();
  assert.equal(value.keyId, "K_stable");
  assert.deepEqual(value.aliases, ["ci.branch.release-old.123"]);
  assert.equal(Object.hasOwn(value, "actualValue"), false);
});

test("共享 value 拒绝机器路径和 secret，本机 scope 可保存路径", () => {
  const value = key();
  assert.throws(() => createKnowledgeValueRevision(value, [], {
    scope: "project",
    scopeId: "p1",
    actualValue: "D:\\workspace\\repo",
    reason: "bad",
  }), /本机绝对路径/);
  assert.throws(() => createKnowledgeValueRevision(value, [], {
    scope: "project",
    scopeId: "p1",
    actualValue: "token=very-secret-token-value",
    reason: "bad",
  }), /secret/);
  assert.throws(() => createKnowledgeValueRevision(value, [], {
    scope: "project",
    scopeId: "p1",
    actualValue: "output=D:\\workspace\\release",
    reason: "内嵌路径也不能共享",
  }), /本机绝对路径/);
  assert.throws(() => createKnowledgeValueRevision(value, [], {
    scope: "project",
    scopeId: "p1",
    actualValue: "api_key=secret-value",
    reason: "API 凭据不能共享",
  }), /secret/);
  for (const actualValue of ["/root/private", "/tmp/private", "/var/lib/private", "checkout=/root/private"]) {
    assert.throws(() => createKnowledgeValueRevision(value, [], {
      scope: "project",
      scopeId: "p1",
      actualValue,
      reason: "Unix 绝对路径不能共享",
    }), /本机绝对路径/);
  }
  const local = createKnowledgeValueRevision(value, [], {
    scope: "node",
    scopeId: "node-a",
    actualValue: "D:\\workspace\\repo",
    reason: "本机源码位置",
  });
  assert.equal(local.storage, "local");
});

test("revision 使用 CAS，按 draft→approved→active 发布并可回滚", () => {
  const value = key();
  const firstDraft = createKnowledgeValueRevision(value, [], {
    scope: "project",
    scopeId: "p1",
    actualValue: "release/one",
    expectedRevision: 0,
    reason: "first",
  }, { operator: "alice", now: 1 });
  const firstApproved = transitionKnowledgeValueRevision(firstDraft, "approved", { operator: "bob", now: 2 });
  let revisions = activateKnowledgeValueRevision([firstApproved], firstApproved.id, { operator: "bob", now: 3 });
  assert.equal(revisions[0].status, "active");

  assert.throws(() => createKnowledgeValueRevision(value, revisions, {
    scope: "project",
    scopeId: "p1",
    actualValue: "release/two",
    expectedRevision: 0,
    reason: "stale",
  }), (error) => error.code === "KNOWLEDGE_VALUE_REVISION_CONFLICT");

  const secondDraft = createKnowledgeValueRevision(value, revisions, {
    scope: "project",
    scopeId: "p1",
    actualValue: "release/two",
    expectedRevision: 1,
    reason: "second",
  }, { operator: "alice", now: 4 });
  const secondApproved = transitionKnowledgeValueRevision(secondDraft, "approved", { operator: "bob", now: 5 });
  revisions = activateKnowledgeValueRevision([...revisions, secondApproved], secondApproved.id, { operator: "bob", now: 6 });
  assert.deepEqual(revisions.map((row) => row.status), ["retired", "active"]);

  revisions = rollbackKnowledgeValueRevision(revisions, {
    keyId: value.keyId,
    scope: "project",
    scopeId: "p1",
    targetRevision: 1,
    operator: "bob",
    reason: "发现回归",
    now: 7,
  });
  assert.deepEqual(revisions.map((row) => row.status), ["active", "retired"]);
});

test("不同 knowledge key 的相同 scope 独立计算 CAS revision", () => {
  const firstKey = key();
  const secondKey = createKnowledgeKey({
    keyId: "K_second",
    canonicalKey: "branch.secondary",
    dimension: "branch",
    scopePolicy: ["project"],
  });
  const firstRevision = createKnowledgeValueRevision(firstKey, [], {
    scope: "project",
    scopeId: "p1",
    actualValue: "release/one",
    expectedRevision: 0,
    reason: "first key",
  });
  const secondRevision = createKnowledgeValueRevision(secondKey, [firstRevision], {
    scope: "project",
    scopeId: "p1",
    actualValue: "release/two",
    expectedRevision: 0,
    reason: "second key",
  });
  assert.equal(secondRevision.revision, 1);
  assert.equal(secondRevision.keyId, "K_second");
});

test("解析遵循 task > node > environment > project > global", () => {
  const value = key();
  const active = (scope, scopeId, actualValue, revision) => ({
    id: `${scope}-${revision}`,
    keyId: value.keyId,
    scope,
    scopeId,
    actualValue,
    revision,
    status: "active",
    storage: ["node", "user"].includes(scope) ? "local" : "shared",
  });
  const revisions = [
    active("global", "", "global", 1),
    active("project", "p1", "project", 1),
    active("environment", "prod", "environment", 1),
    active("node", "n1", "node", 1),
    active("task", "t1", "task", 1),
  ];
  assert.equal(resolveKnowledgeValue(value, revisions, {
    projectId: "p1", environmentId: "prod", nodeId: "n1", taskId: "t1",
  }).actualValue, "task");
  assert.equal(resolveKnowledgeValue(value, revisions, {
    projectId: "p1", environmentId: "prod", nodeId: "n1",
  }).actualValue, "node");
  assert.equal(resolveKnowledgeValue(value, revisions, {
    projectId: "p1", environmentId: "prod",
  }).actualValue, "environment");
});

test("keyId 非法字符拒绝而不是归一化碰撞，defaultValue 必须走 revision", () => {
  assert.throws(
    () => createKnowledgeKey({
      keyId: "K/A",
      canonicalKey: "branch.bad",
      dimension: "branch",
    }),
    /只能包含/,
  );
  assert.throws(
    () => createKnowledgeKey({
      keyId: "K_default",
      canonicalKey: "branch.default",
      dimension: "branch",
      defaultValue: "token=super-secret",
    }),
    /value revision/,
  );
});

test("retired key 和没有 active revision 的 key 均 fail closed", () => {
  const retired = { ...key(), status: "retired" };
  assert.deepEqual(
    resolveKnowledgeValue(retired, [], {}).reason,
    "knowledge_key_inactive",
  );
  assert.deepEqual(
    resolveKnowledgeValue(key(), [], {}).reason,
    "active_value_missing",
  );
});

test("impact 只统计引用同一不可变 keyId 的样本和活动 run", () => {
  const impact = knowledgeValueImpact([
    { keyId: "K_stable", status: "active" },
    { keyId: "K_other", status: "active" },
  ], {
    keyId: "K_stable",
    sampleReferences: [{ id: "s1", keyIds: ["K_stable"] }, { id: "s2", keyIds: ["K_other"] }],
    activeRuns: [{ id: "r1", keyId: "K_stable" }],
  });
  assert.equal(impact.revisions, 1);
  assert.equal(impact.sampleCount, 1);
  assert.equal(impact.activeRunCount, 1);
});
