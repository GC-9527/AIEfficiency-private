/**
 * 日志保留 单测（隔离 db）：按天清理、条数兜底、按日期查询。
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "logret-"));
process.env.GATEWAY_DB_PATH = path.join(tmp, "data.db");

let db;
before(async () => {
  db = await import("../db/sqlite.js");
  db.default.prepare("INSERT OR IGNORE INTO tasks (id, title) VALUES ('t1','测试任务')").run(); // 满足 task_logs 外键
});

// 直接插入带指定 created_at 的日志（绕过 addLog 的默认时间）
function seed(rawDb, daysAgo, msg) {
  rawDb.prepare("INSERT INTO task_logs (task_id, level, module, message, created_at) VALUES (?,?,?,?, datetime('now','localtime', ?))")
    .run("t1", "info", "test", msg, `-${daysAgo} days`);
}

test("pruneOldLogs 删超过 N 天、保留近期", async () => {
  const raw = (await import("../db/sqlite.js")).default;
  seed(raw, 30, "很旧");
  seed(raw, 20, "较旧");
  seed(raw, 5, "近期1");
  seed(raw, 0, "今天");
  const before = db.getRecentLogs({ limit: 100 }).length;
  assert.ok(before >= 4);
  const removed = db.pruneOldLogs({ days: 14, maxRows: 0 }); // 只按时间删
  assert.equal(removed, 2, "应删掉 30 天与 20 天两条");
  const msgs = db.getRecentLogs({ limit: 100 }).map((l) => l.message);
  assert.ok(msgs.includes("近期1") && msgs.includes("今天"));
  assert.ok(!msgs.includes("很旧") && !msgs.includes("较旧"));
});

test("getRecentLogs days 过滤", () => {
  const last7 = db.getRecentLogs({ limit: 100, days: 7 });
  assert.ok(last7.every((l) => l.message !== "很旧"));
  assert.ok(last7.some((l) => l.message === "今天"));
});

test("getLogsByDate 取指定日历日", () => {
  const d = new Date(); // 用本地日期匹配 SQLite date(created_at)(localtime)，避免 UTC 跨日界差一天
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const rows = db.getLogsByDate(today);
  assert.ok(rows.some((l) => l.message === "今天"));
});

test("maxRows 兜底保留最新 N 条", async () => {
  const raw = (await import("../db/sqlite.js")).default;
  for (let i = 0; i < 10; i++) seed(raw, 0, `批量${i}`);
  const removed = db.pruneOldLogs({ days: 0, maxRows: 3 }); // 不按时间，只留最新3条
  assert.ok(removed >= 1);
  assert.equal(db.getRecentLogs({ limit: 100 }).length, 3);
});

test("addLog persists system logs through an internal archive task", () => {
  db.addLog("system", "info", "feishu-project-sync", "[records-refresh] refresh-log-system");

  const refreshRows = db.searchLogs({ keyword: "refresh-log-system", limit: 10 });
  assert.equal(refreshRows.length, 1);
  assert.equal(refreshRows[0].task_id, "system");
  assert.equal(db.getTask("system")?.source, "system_log");
});
