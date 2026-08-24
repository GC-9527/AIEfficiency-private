/**
 * devbench 任务按用户同步；故事点 tabs/closed 按设备存储，不参与 gossip。
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dbud-"));
process.env.GATEWAY_DB_PATH = path.join(tmp, "data.db");
process.env.GATEWAY_CONFIG_PATH = path.join(tmp, "gw.json");
process.env.DEVBENCH_CONFIG_PATH = path.join(tmp, "market.json");
process.env.AIEFFICIENCY_CLONE_PARENT = path.join(tmp, "clone-parent");
process.env.DEVBENCH_STORE_DIR = path.join(tmp, "store");
fs.mkdirSync(process.env.DEVBENCH_STORE_DIR, { recursive: true });
// 登录态：TB operatorId = u1
fs.writeFileSync(process.env.GATEWAY_CONFIG_PATH, JSON.stringify({ teambition: { operatorId: "u1" }, servers: { nodeId: "n1" } }));
// 预置一个旧的 tasks.json，验证迁移
fs.writeFileSync(path.join(process.env.DEVBENCH_STORE_DIR, "tasks.json"), JSON.stringify([{ id: "t-old", title: "历史任务" }]));

let db, store, cfg;
before(async () => {
  db = await import("../db/sqlite.js");
  cfg = await import("../services/config.js");
  store = await import("../services/devbench/store.js");
});

test("userKey 取 TB operatorId", () => {
  assert.equal(store.configUserKey(), "tb:u1");
});

test("首次读任务：迁移旧 tasks.json 进 DB(按用户)", () => {
  const list = store.listTasks();
  assert.ok(list.some((t) => t.id === "t-old"), "应迁移历史任务");
  const inDb = db.getUserData("tb:u1", "tasks");
  assert.ok(inDb.some((t) => t.id === "t-old"), "DB 已存该用户任务");
});

test("setUserData/getUserData + 单调时间戳", () => {
  const t1 = db.setUserData("tb:u1", "tabs", [{ id: "a" }], "n1");
  const t2 = db.setUserData("tb:u1", "tabs", [{ id: "a" }, { id: "b" }], "n1");
  assert.ok(t2 > t1, "时间戳单调递增");
  assert.equal(db.getUserData("tb:u1", "tabs").length, 2);
});

test("故事点 tabs/closed 使用本机设备桶", () => {
  const tab = store.createTab({ title: "本机故事点" });
  const key = store.storageUserKey("tabs");
  assert.match(key, /^device:[a-f0-9]{16}$/);
  assert.notEqual(key, "device:n1");
  assert.ok(db.getUserData(key, "tabs").some((t) => t.id === tab.id));
  const persisted = JSON.parse(fs.readFileSync(path.join(process.env.DEVBENCH_STORE_DIR, "machine-storage-id.json"), "utf8"));
  assert.equal(`device:${persisted.id}`, key, "本机设备身份必须持久化，供后续启动在系统查询瞬时失败时复用");
});

test("MachineGuid 查询瞬时失败时沿用持久身份，不得切换到 MAC 设备桶", () => {
  const canonical = store.resolveMachineStorageIdentity({
    guid: "stable-machine-guid",
    mac: "00:11:22:33:44:55",
  });
  const recovered = store.resolveMachineStorageIdentity({
    guid: "",
    mac: "00:11:22:33:44:55",
    cachedId: canonical.id,
  });
  const macOnly = store.resolveMachineStorageIdentity({
    guid: "",
    mac: "00:11:22:33:44:55",
  });

  assert.equal(recovered.id, canonical.id);
  assert.equal(recovered.sourceKind, "persisted");
  assert.notEqual(recovered.id, macOnly.id, "持久身份存在时不能因一次 MachineGuid 失败读到 MAC 桶");
});

test("新 Gateway 进程复用同一持久设备身份文件", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dbud-machine-id-restart-"));
  const storeDir = path.join(root, "store");
  const expectedId = store.machineStorageId();
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(
    path.join(storeDir, "machine-storage-id.json"),
    JSON.stringify({ version: 1, id: expectedId, sourceKind: "win-machine-guid" }),
    "utf8",
  );
  fs.writeFileSync(path.join(root, "gateway.json"), JSON.stringify({ servers: { nodeId: "restart-node" } }), "utf8");
  fs.writeFileSync(path.join(root, "market.json"), JSON.stringify({ projectDefs: [] }), "utf8");
  const storeUrl = pathToFileURL(path.resolve("gateway/services/devbench/store.js")).href;
  const child = spawnSync(process.execPath, [
    "--input-type=module",
    "--eval",
    // 保留 Node 启动时需要的真实 Windows 环境，进入子进程后再让 reg 命令不可解析，
    // 精确模拟新 Gateway 启动时 MachineGuid 查询失败而不是破坏 Node 自身初始化。
    `process.env.PATH = ""; delete process.env.SystemRoot; delete process.env.WINDIR; const { machineStorageId } = await import(${JSON.stringify(storeUrl)}); process.stdout.write(machineStorageId());`,
  ], {
    cwd: path.resolve("gateway"),
    encoding: "utf8",
    env: {
      ...process.env,
      GATEWAY_DB_PATH: path.join(root, "data.db"),
      GATEWAY_CONFIG_PATH: path.join(root, "gateway.json"),
      DEVBENCH_CONFIG_PATH: path.join(root, "market.json"),
      DEVBENCH_STORE_DIR: storeDir,
      AIEFFICIENCY_CLONE_PARENT: path.join(root, "clone-parent"),
    },
  });

  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, expectedId);
  const persisted = JSON.parse(fs.readFileSync(path.join(storeDir, "machine-storage-id.json"), "utf8"));
  assert.equal(persisted.sourceKind, "win-machine-guid", "缓存命中不得丢失最初的权威来源");
});

test("MachineGuid 恢复后覆盖过期缓存，避免复制旧缓存绑定到另一台机器", () => {
  const stale = store.resolveMachineStorageIdentity({ guid: "other-machine-guid" });
  const current = store.resolveMachineStorageIdentity({
    guid: "current-machine-guid",
    cachedId: stale.id,
    mac: "00:11:22:33:44:55",
  });

  assert.equal(current.sourceKind, "win-machine-guid");
  assert.notEqual(current.id, stale.id);
});

test("不同用户隔离", () => {
  db.setUserData("tb:u2", "tasks", [{ id: "x" }], "n1");
  assert.ok(!db.getUserData("tb:u2", "tasks").some((t) => t.id === "t-old"));
  assert.ok(db.getUserData("tb:u1", "tasks").some((t) => t.id === "t-old"));
});

test("mergeUserData 新者胜（gossip）", () => {
  const now = db.maxUserDataUpdated();
  // 来自对端、更新的版本
  db.mergeUserData({ user_key: "tb:u1", kind: "tasks", data: JSON.stringify([{ id: "t-new" }]), updated_at: now + 10000, node: "n2" });
  assert.deepEqual(db.getUserData("tb:u1", "tasks").map((t) => t.id), ["t-new"]);
  // 更旧的版本不覆盖
  db.mergeUserData({ user_key: "tb:u1", kind: "tasks", data: JSON.stringify([{ id: "stale" }]), updated_at: now + 1, node: "n3" });
  assert.deepEqual(db.getUserData("tb:u1", "tasks").map((t) => t.id), ["t-new"], "旧版本不应覆盖");
});

test("listUserDataSince 增量", () => {
  const ts = db.setUserData("tb:u1", "tasks", [{ id: "c1" }], "n1"); // 返回该行 updated_at
  const rows = db.listUserDataSince(ts);
  assert.ok(rows.some((r) => r.user_key === "tb:u1" && r.kind === "tasks"), "since=本行ts 应含本行");
  assert.ok(!db.listUserDataSince(ts + 1).some((r) => r.kind === "tasks"), "since>本行ts 不含");
});

test("tabs/closed 不参与 gossip 列表，远端合并也不能覆盖", () => {
  const ts = db.setUserData("tb:u1", "closed", [{ id: "c1" }], "n1");
  const rows = db.listUserDataSince(ts);
  assert.ok(!rows.some((r) => r.kind === "closed" || r.kind === "tabs"), "tabs/closed 不应出现在局域网用户数据同步里");
  const before = db.getUserData("tb:u1", "tabs");
  db.mergeUserData({ user_key: "tb:u1", kind: "tabs", data: JSON.stringify([{ id: "remote-tab" }]), updated_at: db.maxUserDataUpdated() + 10000, node: "remote" });
  assert.deepEqual(db.getUserData("tb:u1", "tabs"), before, "远端 tabs 不应覆盖本机打开状态");
});

test("deviceRuntime 不导出且全量替换保留本地运行时状态", () => {
  const localKey = "device:runtime-local";
  const localRuntime = {
    version: 1,
    devices: {
      serial1: {
        current: { storyId: "story-local", fencingToken: 7 },
        queue: [{ storyId: "story-next", requestId: "req-next" }],
      },
    },
  };
  db.setUserData(localKey, "deviceRuntime", localRuntime, "local-node");
  db.setUserData("tb:sync-source", "tasks", [{ id: "syncable-before-replace" }], "local-node");

  assert.ok(
    !db.listUserDataSince(0).some((row) => row.kind === "deviceRuntime"),
    "增量同步不得导出本机设备租约与队列",
  );
  assert.ok(
    !db.listSyncableUserDataRows().some((row) => row.kind === "deviceRuntime"),
    "全量同步快照不得导出本机设备租约与队列",
  );

  const before = db.getUserDataRecord(localKey, "deviceRuntime");
  const result = db.replaceSyncableUserDataRows([
    {
      user_key: "tb:replacement",
      kind: "tasks",
      data: [{ id: "syncable-after-replace" }],
      updated_at: Date.now(),
      node: "remote-node",
    },
    {
      user_key: localKey,
      kind: "deviceRuntime",
      data: { version: 1, devices: { serial1: { current: { storyId: "remote-story" } } } },
      updated_at: Date.now() + 1,
      node: "remote-node",
    },
  ], "restore-node");

  assert.equal(result.restored, 1, "传入的远端 deviceRuntime 行不得计入恢复数量");
  assert.deepEqual(
    db.getUserDataRecord(localKey, "deviceRuntime"),
    before,
    "全量替换不得删除或覆盖本机设备运行时行及其元数据",
  );
  assert.deepEqual(db.getUserData("tb:replacement", "tasks"), [{ id: "syncable-after-replace" }]);
  assert.equal(db.getUserData("tb:sync-source", "tasks"), null, "普通可同步旧行仍应被全量替换清理");
});

test("未登录用本机设备指纹（不与复制工程的其他设备误并）", () => {
  cfg.updateConfig({ teambition: { operatorId: "" } });
  const key = store.configUserKey();
  assert.match(key, /^device:[a-f0-9]{16}$/);
  assert.notEqual(key, "local:n1");
  cfg.updateConfig({ teambition: { operatorId: "u1" } }); // 复原
});
