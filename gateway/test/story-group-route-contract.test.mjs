import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, "../routes/devbench.js"), "utf8");
const storeSource = fs.readFileSync(path.join(here, "../services/devbench/store.js"), "utf8");
const sqliteSource = fs.readFileSync(path.join(here, "../db/sqlite.js"), "utf8");

test("group join/active 在 provision 前取计划并在 store mutation 传入 source token", () => {
  const joinStart = source.indexOf('router.post("/tabs/:id/group/join"');
  const activeStart = source.indexOf('router.post("/tabs/:id/group/active"');
  const leaveStart = source.indexOf('router.post("/tabs/:id/group/leave"');
  assert.ok(joinStart >= 0 && activeStart > joinStart && leaveStart > activeStart);
  const join = source.slice(joinStart, activeStart);
  const active = source.slice(activeStart, leaveStart);
  assert.ok(join.indexOf("store.planGroupJoin") < join.indexOf("provisionLocalStoryWorkspace"));
  assert.match(join, /expectedSourceToken:\s*groupPlan\.token/);
  assert.ok(active.indexOf("store.planGroupActive") < active.indexOf("provisionLocalStoryWorkspace"));
  assert.ok(active.indexOf("if (groupPlan.idempotent)") < active.indexOf("provisionLocalStoryWorkspace"));
  assert.match(active, /expectedSourceToken:\s*groupPlan\.token/);
});

test("group join/active 的最终 CAS 与写入使用同一个 BEGIN IMMEDIATE 状态原语", () => {
  const joinStart = storeSource.indexOf("export function joinGroup(");
  const renameStart = storeSource.indexOf("export function renameGroup(", joinStart);
  const activeStart = storeSource.indexOf("export function setGroupActive(");
  const leaveStart = storeSource.indexOf("export function leaveGroup(", activeStart);
  assert.ok(joinStart >= 0 && renameStart > joinStart && activeStart >= 0 && leaveStart > activeStart);

  const join = storeSource.slice(joinStart, renameStart);
  const active = storeSource.slice(activeStart, leaveStart);
  for (const [name, body, planner] of [
    ["joinGroup", join, "groupJoinPlanFromTabs"],
    ["setGroupActive", active, "groupActivePlanFromTabs"],
  ]) {
    const transaction = body.indexOf("updateDevbenchStoryState(");
    const recompute = body.indexOf(planner);
    const compare = body.indexOf("groupSourceChanged(");
    const write = body.indexOf("tabs: visibleTabs");
    assert.ok(transaction >= 0, `${name} 必须使用原子故事点状态更新原语`);
    assert.ok(transaction < recompute && recompute < compare && compare < write,
      `${name} 必须在同一事务回调内按 plan 重算、token 比较、状态写入的顺序执行`);
    assert.doesNotMatch(body, /\bloadTabs\s*\(/, `${name} 最终提交不能事务外读取 tabs`);
    assert.doesNotMatch(body, /\bsaveTabs\s*\(/, `${name} 最终提交不能事务外覆盖 tabs`);
  }

  const primitiveStart = sqliteSource.indexOf("export function updateDevbenchStoryState(");
  const primitiveEnd = sqliteSource.indexOf("export function mergeUserData(", primitiveStart);
  assert.ok(primitiveStart >= 0 && primitiveEnd > primitiveStart);
  assert.match(sqliteSource.slice(primitiveStart, primitiveEnd), /return run\.immediate\(\)/,
    "原子故事点状态更新原语必须以 BEGIN IMMEDIATE 执行");
});
