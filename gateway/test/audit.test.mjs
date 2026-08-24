/**
 * 管理员审计日志 单元测试（隔离 db）：记录、按时间倒序、since 过滤、id 去重(跨服务端合并)、对象前后值序列化。
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dbaudit-"));
process.env.GATEWAY_DB_PATH = path.join(tmp, "data.db");

let db;
before(async () => { db = await import("../db/sqlite.js"); });

test("addAudit + listAudit 按 ts 倒序", () => {
  db.addAudit({ id: "a1", ts: 1000, ip: "1.1.1.1", actor: "张三", role: "admin", action: "仓库.改", target: "repo:X", before: { name: "X", ssh: "old" }, after: { name: "X", ssh: "new" }, node: "n1" });
  db.addAudit({ id: "a2", ts: 2000, ip: "2.2.2.2", actor: "李四", role: "super", action: "车型.删", target: "车型:Y", before: { entries: [] }, after: null, node: "n1" });
  const list = db.listAudit({ limit: 10 });
  assert.equal(list.length, 2);
  assert.equal(list[0].id, "a2", "最新在前");
  assert.equal(list[1].id, "a1");
});

test("before/after 对象被序列化为 JSON 字符串存储", () => {
  const e = db.listAudit({}).find((x) => x.id === "a1");
  assert.equal(typeof e.before, "string");
  assert.deepEqual(JSON.parse(e.before), { name: "X", ssh: "old" });
  assert.deepEqual(JSON.parse(e.after), { name: "X", ssh: "new" });
});

test("id 去重：重复 id 不重复插入（跨服务端合并幂等）", () => {
  const n0 = db.listAudit({}).length;
  db.addAudit({ id: "a1", ts: 9999, actor: "重复", action: "x", target: "y" }); // 同 a1
  assert.equal(db.listAudit({}).length, n0, "同 id 不应新增");
  assert.equal(db.listAudit({}).find((x) => x.id === "a1").actor, "张三", "保留原值(IGNORE)");
});

test("since 过滤", () => {
  const since1500 = db.listAudit({ since: 1500 });
  assert.ok(since1500.every((x) => x.ts >= 1500));
  assert.ok(since1500.some((x) => x.id === "a2"));
  assert.ok(!since1500.some((x) => x.id === "a1"));
});

test("maxAuditTs", () => {
  assert.equal(db.maxAuditTs(), 2000);
});

test("字符串前后值直接存（不二次序列化）", () => {
  db.addAudit({ id: "a3", ts: 3000, action: "x", target: "z", before: "纯文本前", after: "纯文本后" });
  const e = db.listAudit({}).find((x) => x.id === "a3");
  assert.equal(e.before, "纯文本前");
  assert.equal(e.after, "纯文本后");
});
