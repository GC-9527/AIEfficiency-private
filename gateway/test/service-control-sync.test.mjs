import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(REPO_ROOT, "service-control-electron", "scripts", "sync-dev-profile-data.cjs");
const TMP_ROOT = path.join(REPO_ROOT, "gateway", ".tmp");

function prepareRoot(root, shared, marketText) {
  const gatewayDir = path.join(root, "gateway");
  const dbDir = path.join(gatewayDir, "db");
  fs.mkdirSync(dbDir, { recursive: true });
  fs.mkdirSync(path.join(root, "configs"), { recursive: true });
  fs.writeFileSync(path.join(gatewayDir, "package.json"), "{\"private\":true}\n", "utf8");
  fs.writeFileSync(path.join(root, "configs", "market-projects.json"), marketText, "utf8");

  const db = new Database(path.join(dbDir, "data.db"));
  db.exec(`
    CREATE TABLE devbench_userdata (
      user_key TEXT,
      kind TEXT,
      data TEXT,
      updated_at INTEGER,
      node TEXT,
      PRIMARY KEY (user_key, kind)
    );
    CREATE TABLE admin_users (
      ding_userid TEXT PRIMARY KEY,
      name TEXT,
      role TEXT,
      added_by TEXT,
      created_at INTEGER,
      updated_at INTEGER,
      deleted_at INTEGER DEFAULT 0,
      node TEXT
    );
  `);
  db.prepare(`
    INSERT INTO devbench_userdata (user_key, kind, data, updated_at, node)
    VALUES ('__devbench_shared__', 'shared', ?, ?, ?)
  `).run(JSON.stringify(shared), Number(shared._sharedVersion || 1), "fixture");
  db.close();
}

function readShared(root) {
  const db = new Database(path.join(root, "gateway", "db", "data.db"), { readonly: true });
  const row = db.prepare(`
    SELECT data, updated_at, node
    FROM devbench_userdata
    WHERE user_key='__devbench_shared__' AND kind='shared'
  `).get();
  db.close();
  return { ...row, parsed: JSON.parse(row.data) };
}

function runSync(sourceRoot, targetRoot, extraOptions = {}) {
  const stdout = execFileSync(process.execPath, [
    SCRIPT,
    sourceRoot,
    targetRoot,
    JSON.stringify({
      projectDefs: true,
      dingtalkMsgConfig: true,
      vehicleMap: true,
      keywordMappings: true,
      statusMap: true,
      configMemory: true,
      lessons: true,
      ...extraOptions,
    }),
  ], { cwd: REPO_ROOT, encoding: "utf8" });
  return JSON.parse(stdout.trim());
}

function insertAdmin(root, row) {
  const db = new Database(path.join(root, "gateway", "db", "data.db"));
  db.prepare(`
    INSERT INTO admin_users
      (ding_userid, name, role, added_by, created_at, updated_at, deleted_at, node)
    VALUES
      (@ding_userid, @name, @role, @added_by, @created_at, @updated_at, @deleted_at, @node)
  `).run(row);
  db.close();
}

test("Service Control 共享数据库同步默认合并车型，重复执行不抬版本且不碰 Git 种子", () => {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const work = fs.mkdtempSync(path.join(TMP_ROOT, "service-control-sync-"));
  const sourceRoot = path.join(work, "source");
  const targetRoot = path.join(work, "target");
  const sourceSeed = "{\"projects\":[],\"_comment\":\"source seed\"}\n";
  const targetSeed = "{\"projects\":[],\"_comment\":\"target seed\"}\n";
  try {
    prepareRoot(sourceRoot, {
      projectDefs: [{ id: "source-repo", name: "源仓库", https: "https://example.com/source.git" }],
      dingtalkMsgConfig: { publish: { signed: [{ name: "源联系人", mobile: "" }], unsigned: [] } },
      byProject: { p: {
        vehicleMap: { car: { entries: [{ repoId: "source-repo", branch: "main" }] } },
        keywordMappings: { tag: { 新标签: { category: "app", value: "new" } } },
        statusMap: { ready: "已就绪" },
        configMemory: [{ id: "memory-source", value: "source" }],
        lessons: [{ id: "lesson-source", value: "source" }],
      } },
      _sharedVersion: 200,
      sharedOps: [],
      sharedOpClocks: {},
    }, sourceSeed);
    const restoreOp = {
      id: "target-node:90:restore",
      node: "target-node",
      version: 90,
      at: 90,
      type: "shared.restore",
      idValue: "fixture-backup",
      value: { projectDefs: [], byProject: {}, dingtalkMsgConfig: null },
    };
    prepareRoot(targetRoot, {
      projectDefs: [{ id: "removed-repo", name: "待删除仓库", https: "https://example.com/removed.git" }],
      dingtalkMsgConfig: { publish: { signed: [], unsigned: [] } },
      byProject: { p: {
        vehicleMap: { old: { entries: [] } },
        keywordMappings: { tag: { 旧标签: { category: "app", value: "old" } } },
        statusMap: { pending: "待处理" },
        configMemory: [{ id: "memory-target", value: "target" }],
        lessons: [{ id: "lesson-target", value: "target" }],
      } },
      _sharedVersion: 100,
      sharedOps: [restoreOp],
      sharedOpClocks: {},
      sharedRestoreClock: { version: 90, node: "target-node", id: restoreOp.id, at: 90 },
    }, targetSeed);

    const first = runSync(sourceRoot, targetRoot);
    assert.equal(first.ok, true);
    assert.equal(first.shared.updated, true);
    assert.equal(first.shared.generatedOps, 10);
    const afterFirst = readShared(targetRoot);
    assert.deepEqual(afterFirst.parsed.projectDefs, [{ id: "source-repo", name: "源仓库", https: "https://example.com/source.git" }]);
    assert.equal(afterFirst.parsed.byProject.p.vehicleMap.car.entries[0].branch, "main");
    assert.deepEqual(afterFirst.parsed.byProject.p.vehicleMap.old, { entries: [] }, "默认同步不得删除目标独有车型");
    assert.equal(afterFirst.parsed.byProject.p.keywordMappings.tag["新标签"].value, "new");
    assert.equal(afterFirst.parsed.byProject.p.keywordMappings.tag["旧标签"], undefined);
    assert.deepEqual(afterFirst.parsed.byProject.p.statusMap, { ready: "已就绪" });
    assert.deepEqual(afterFirst.parsed.byProject.p.configMemory.map((row) => row.id), ["memory-target", "memory-source"]);
    assert.deepEqual(afterFirst.parsed.byProject.p.lessons.map((row) => row.id), ["lesson-target", "lesson-source"]);
    assert.ok(afterFirst.parsed.sharedOps.some((op) => op.type === "projectDef.set" && op.value.id === "source-repo"));
    assert.ok(afterFirst.parsed.sharedOps.some((op) => op.type === "projectDef.delete" && op.idValue === "removed-repo"));
    assert.ok(afterFirst.parsed.sharedOps.some((op) => op.type === "dingtalkMsgConfig.set"));
    assert.ok(afterFirst.parsed.sharedOps.some((op) => op.type === "byProject.set" && op.path.join("/") === "vehicleMap/car"));
    assert.equal(afterFirst.parsed.sharedOps.some((op) => op.type === "byProject.delete" && op.path.join("/") === "vehicleMap/old"), false);
    assert.ok(afterFirst.parsed.sharedOps.some((op) => op.type === "lesson.set" && op.value.id === "lesson-source"));
    assert.ok(afterFirst.parsed.sharedOps.some((op) => op.type === "configMemory.set" && op.value.id === "memory-source"));
    assert.ok(afterFirst.parsed.sharedOps.some((op) => op.type === "shared.restore" && op.id === restoreOp.id));
    assert.ok(afterFirst.parsed.sharedOps
      .filter((op) => op.id !== restoreOp.id)
      .every((op) => op.restoreEpoch === restoreOp.id));

    const second = runSync(sourceRoot, targetRoot);
    assert.equal(second.ok, true);
    assert.equal(second.shared.updated, false);
    assert.equal(second.shared.generatedOps, 0);
    const afterSecond = readShared(targetRoot);
    assert.equal(afterSecond.updated_at, afterFirst.updated_at);
    assert.equal(afterSecond.data, afterFirst.data);
    assert.equal(fs.readFileSync(path.join(sourceRoot, "configs", "market-projects.json"), "utf8"), sourceSeed);
    assert.equal(fs.readFileSync(path.join(targetRoot, "configs", "market-projects.json"), "utf8"), targetSeed);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test("Service Control 对经验和配置记忆优先保留源端最新 200 条，第二次同步立即幂等", () => {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const work = fs.mkdtempSync(path.join(TMP_ROOT, "service-control-sync-limit-"));
  const sourceRoot = path.join(work, "source");
  const targetRoot = path.join(work, "target");
  const targetRows = (prefix) => Array.from({ length: 200 }, (_, index) => ({ id: `${prefix}-shared-${index}`, value: `target-${index}` }));
  const sourceRows = (prefix) => [
    ...Array.from({ length: 100 }, (_, index) => ({ id: `${prefix}-shared-${index}`, value: `source-${index}` })),
    ...Array.from({ length: 100 }, (_, index) => ({ id: `${prefix}-new-${index}`, value: `source-new-${index}` })),
  ];
  try {
    prepareRoot(sourceRoot, {
      byProject: { p: { lessons: sourceRows("lesson"), configMemory: sourceRows("memory") } },
      _sharedVersion: 200,
      sharedOps: [],
      sharedOpClocks: {},
    }, "{\"projects\":[]}\n");
    prepareRoot(targetRoot, {
      byProject: { p: { lessons: targetRows("lesson"), configMemory: targetRows("memory") } },
      _sharedVersion: 100,
      sharedOps: [],
      sharedOpClocks: {},
    }, "{\"projects\":[]}\n");

    const first = runSync(sourceRoot, targetRoot);
    assert.equal(first.ok, true);
    assert.equal(first.shared.updated, true);
    assert.equal(first.shared.generatedOps, 600);
    const afterFirst = readShared(targetRoot);
    assert.equal(afterFirst.parsed.byProject.p.lessons.length, 200);
    assert.equal(afterFirst.parsed.byProject.p.configMemory.length, 200);
    assert.deepEqual(afterFirst.parsed.byProject.p.lessons, sourceRows("lesson"));
    assert.deepEqual(afterFirst.parsed.byProject.p.configMemory, sourceRows("memory"));
    const counts = afterFirst.parsed.sharedOps.reduce((out, op) => {
      out[op.type] = (out[op.type] || 0) + 1;
      return out;
    }, {});
    assert.deepEqual(counts, {
      "lesson.set": 200,
      "lesson.delete": 100,
      "configMemory.set": 200,
      "configMemory.delete": 100,
    });

    const second = runSync(sourceRoot, targetRoot);
    assert.equal(second.shared.updated, false);
    assert.equal(readShared(targetRoot).data, afterFirst.data);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test("Service Control 管理员数据相同后重复同步不再执行 UPSERT", () => {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const work = fs.mkdtempSync(path.join(TMP_ROOT, "service-control-sync-admin-"));
  const sourceRoot = path.join(work, "source");
  const targetRoot = path.join(work, "target");
  const shared = { byProject: {}, _sharedVersion: 1, sharedOps: [], sharedOpClocks: {} };
  const admin = {
    ding_userid: "admin-1", name: "管理员", role: "admin", added_by: "super",
    created_at: 10, updated_at: 20, deleted_at: 0, node: "source-node",
  };
  try {
    prepareRoot(sourceRoot, shared, "{\"projects\":[]}\n");
    prepareRoot(targetRoot, shared, "{\"projects\":[]}\n");
    insertAdmin(sourceRoot, admin);

    const first = runSync(sourceRoot, targetRoot, { adminUsers: true });
    assert.equal(first.adminRows, 1);
    const second = runSync(sourceRoot, targetRoot, { adminUsers: true });
    assert.equal(second.adminRows, 0);

    const targetDb = new Database(path.join(targetRoot, "gateway", "db", "data.db"), { readonly: true });
    assert.deepEqual(targetDb.prepare("SELECT * FROM admin_users WHERE ding_userid=?").get(admin.ding_userid), admin);
    targetDb.close();
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});
