import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

test("历史 TB ObjectId 管理员迁移为 Teambition subject，不再误标钉钉", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "admin-subject-migration-"));
  const dbPath = path.join(tempDir, "legacy.db");
  const configPath = path.join(tempDir, "gateway.json");
  fs.writeFileSync(configPath, "{}");

  const legacyDb = new Database(dbPath);
  legacyDb.exec(`
    CREATE TABLE admin_users (
      ding_userid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      added_by TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER,
      deleted_at INTEGER DEFAULT 0,
      node TEXT
    );
  `);
  const insert = legacyDb.prepare("INSERT INTO admin_users (ding_userid, name, role, added_by, created_at, updated_at, deleted_at, node) VALUES (?, ?, 'admin', '', ?, ?, 0, '')");
  insert.run("57ad8e2fa45d0cba20025b7a", "历史 TB 管理员", 1000, 1000);
  insert.run("ding-user-legacy", "历史钉钉管理员", 1001, 1001);
  legacyDb.close();

  process.env.GATEWAY_DB_PATH = dbPath;
  process.env.GATEWAY_CONFIG_PATH = configPath;
  const sqlite = await import(`../db/sqlite.js?admin-subject-migration=${Date.now()}`);
  try {
    const tb = sqlite.getAdminUser("57ad8e2fa45d0cba20025b7a");
    assert.deepEqual(tb.subject, { issuer: "teambition", id: "57ad8e2fa45d0cba20025b7a" });
    assert.equal(tb.subjectId, "teambition:57ad8e2fa45d0cba20025b7a");
    assert.equal(sqlite.getAdminUser(tb.userId, "dingtalk"), null);

    const ding = sqlite.getAdminUser("ding-user-legacy");
    assert.deepEqual(ding.subject, { issuer: "dingtalk", id: "ding-user-legacy" });
  } finally {
    sqlite.default.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
