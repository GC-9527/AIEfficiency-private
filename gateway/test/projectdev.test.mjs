/**
 * projectdev 后端测试（node:test）：
 *  ① SQLite CRUD 往返（projects/runs/events）。
 *  ② validateSpec 正确通过 / 缺字段报错。
 *  ③ 不调 claude 的 dry run：里程碑用 file_exists 指向已存在文件 → orchestrator 早退路径，status=completed。
 *
 * 隔离：临时 GATEWAY_DB_PATH + 临时 stateDir（参照 store.test.mjs 约定），不污染真实库/工程。
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "projectdev-"));
process.env.GATEWAY_DB_PATH = path.join(tmp, "data.db");

let db, kernel;
before(async () => {
  db = await import("../db/sqlite.js");
  kernel = await import("../services/projectdev/kernel/index.js");
});

test("SQLite CRUD：projects 往返（upsert/get/list/update/delete）", () => {
  const id = "proj-test-1";
  const spec = { specId: "s1", projectDir: tmp, vision: "v", milestones: [{ id: "m1", title: "t", prompt: "p" }] };
  const row = db.upsertProjectDevProject({ id, name: "项目甲", spec, status: "idle", userKey: "u1", node: "n1" });
  assert.equal(row.id, id);
  assert.equal(row.name, "项目甲");

  const got = db.getProjectDevProject(id);
  assert.equal(got.status, "idle");
  assert.equal(got.userKey, "u1");
  assert.deepEqual(JSON.parse(got.spec).milestones[0].id, "m1"); // spec 以 JSON 字符串存

  // 更新：改名 + 状态，created_at 保留
  const created = got.createdAt;
  const upd = db.upsertProjectDevProject({ id, name: "项目乙", spec, status: "running", userKey: "u1" });
  assert.equal(upd.name, "项目乙");
  assert.equal(upd.status, "running");
  assert.equal(upd.createdAt, created, "created_at 应保留");

  assert.ok(db.listProjectDevProjects().some((p) => p.id === id));

  db.deleteProjectDevProject(id);
  assert.equal(db.getProjectDevProject(id), undefined);
});

test("SQLite CRUD：runs + events 往返 + getLatestRun + listProjectDevEvents 增量", () => {
  const pid = "proj-test-2";
  db.upsertProjectDevProject({ id: pid, name: "p", spec: { specId: "s" }, status: "idle" });

  const runId = "run-A";
  db.insertProjectDevRun({ runId, projectId: pid, status: "running", state: { sessionCostUsd: 0 } });
  let run = db.getProjectDevRun(runId);
  assert.equal(run.status, "running");
  assert.deepEqual(run.state, { sessionCostUsd: 0 }); // state 自动 JSON.parse

  db.updateProjectDevRun(runId, { status: "completed", state: { sessionCostUsd: 1.5 }, finishedAt: new Date().toISOString() });
  run = db.getProjectDevRun(runId);
  assert.equal(run.status, "completed");
  assert.equal(run.state.sessionCostUsd, 1.5);
  assert.ok(run.finishedAt);

  // 第二个 run（更晚）→ getLatestRun 取它
  const runB = "run-B";
  db.insertProjectDevRun({ runId: runB, projectId: pid, status: "running", state: null });
  assert.equal(db.getLatestRun(pid).runId, runB);

  // events 增量
  const e1 = db.insertProjectDevEvent({ projectId: pid, runId, ts: "t1", type: "run_start", data: { specId: "s" } });
  const e2 = db.insertProjectDevEvent({ projectId: pid, runId, ts: "t2", type: "milestone_start", data: { id: "m1" } });
  assert.ok(e2 > e1);
  const all = db.listProjectDevEvents(pid, 0, 100);
  assert.equal(all.length, 2);
  assert.deepEqual(all[0].data, { specId: "s" }); // data 自动 JSON.parse
  const since = db.listProjectDevEvents(pid, e1, 100);
  assert.equal(since.length, 1);
  assert.equal(since[0].type, "milestone_start");

  db.deleteProjectDevProject(pid);
  assert.equal(db.listProjectDevEvents(pid, 0, 100).length, 0, "删除项目应连带清理 events");
  assert.equal(db.getLatestRun(pid), null, "删除项目应连带清理 runs");
});

test("validateSpec：完整 spec 通过 / 缺字段报错", () => {
  const ok = kernel.validateSpec({
    specId: "s", projectDir: "/tmp/x", vision: "愿景",
    milestones: [{ id: "m1", title: "标题", prompt: "做点啥" }],
  });
  assert.deepEqual(ok, []);

  const bad = kernel.validateSpec({ milestones: [{ title: "无 id 无 prompt" }] });
  assert.ok(bad.some((e) => /specId/.test(e)));
  assert.ok(bad.some((e) => /projectDir/.test(e)));
  assert.ok(bad.some((e) => /vision/.test(e)));
  assert.ok(bad.some((e) => /缺少 id/.test(e)));
  assert.ok(bad.some((e) => /缺少 prompt/.test(e)));

  assert.deepEqual(kernel.validateSpec(null), ["spec 必须是对象"]);
});

test("dry run（不调 claude）：file_exists 指向已存在文件 → 早退 → status=completed", async () => {
  // 在临时工程目录放一个文件，作为里程碑的 file_exists 验收目标
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "projectdev-proj-"));
  fs.writeFileSync(path.join(projectDir, "README.md"), "# hi");
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "projectdev-state-"));

  const spec = {
    specId: "dry-1",
    projectDir,
    vision: "干跑：仅验收已满足，不应驱动 claude",
    milestones: [
      { id: "m1", title: "确保 README 存在", prompt: "(不会用到)", acceptance: [{ type: "file_exists", path: "README.md" }] },
    ],
  };
  assert.deepEqual(kernel.validateSpec(spec), []);

  const events = [];
  const { status, state } = await kernel.runOrchestrator({
    spec, stateDir,
    hooks: { onEvent: (evt) => events.push(evt.type) },
  });

  assert.equal(status, "completed");
  assert.equal(state.milestones.m1.status, "completed");
  assert.ok(events.includes("run_start"));
  assert.ok(events.includes("milestone_done"));
  assert.ok(events.includes("run_done"));
  assert.ok(!events.includes("turn"), "早退路径不应有 turn 事件（即未驱动 claude）");
  // run-state.json 已落盘（可断点续跑）
  assert.ok(fs.existsSync(path.join(stateDir, "run-state.json")));
});
