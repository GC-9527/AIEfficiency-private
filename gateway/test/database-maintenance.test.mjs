import { test } from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { maintainDatabase } from "../tools/maintain-data-db.mjs";

const BACKUP_TYPE = "devbench-sync-local-backup";

function createLegacyDatabase(dbPath) {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE devbench_userdata (
      user_key TEXT,
      kind TEXT,
      data TEXT,
      updated_at INTEGER,
      node TEXT,
      PRIMARY KEY (user_key, kind)
    );
    CREATE TABLE devbench_sync_backups (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      source TEXT NOT NULL,
      label TEXT,
      note TEXT,
      summary TEXT,
      data TEXT NOT NULL,
      node TEXT
    );
    CREATE TABLE devbench_sync_backup_settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  const shared = {
    projectDefs: [
      { id: "real", name: "Real", https: "https://code.example.org/real.git" },
      { id: "market", name: "Fixture", https: "https://example.com/fixture.git" },
    ],
    byProject: {
      real: { keywordMappings: { tag: { real: { category: "app", value: "real" } } } },
      "project-a": { aiTraining: { configInference: { settings: { fixture: true } } } },
    },
    sharedOps: [
      {
        id: "real-op",
        node: "real-node",
        version: 100,
        at: 100,
        type: "byProject.set",
        projectId: "real",
        path: ["keywordMappings", "tag", "real"],
        value: { category: "app", value: "real" },
      },
      {
        id: "fixture-op",
        node: "fixture-node",
        version: 101,
        at: 101,
        type: "byProject.delete",
        projectId: "project-a",
        path: ["aiTraining", "configInference", "settings"],
      },
    ],
    sharedOpClocks: {
      "byProject/real/keywordMappings/tag/real": { id: "real-op", version: 100 },
      "byProject/project-a/aiTraining/configInference/settings": { id: "fixture-op", version: 101 },
    },
    _sharedVersion: 101,
  };
  db.prepare(`
    INSERT INTO devbench_userdata (user_key, kind, data, updated_at, node)
    VALUES ('__devbench_shared__', 'shared', ?, 101, 'fixture-node')
  `).run(JSON.stringify(shared));
  db.prepare(`
    INSERT INTO devbench_userdata (user_key, kind, data, updated_at, node)
    VALUES ('tb:user', 'tasks', ?, 101, 'fixture-node')
  `).run(JSON.stringify([{ id: "task-1", title: "task" }]));
  const insert = db.prepare(`
    INSERT INTO devbench_sync_backups
      (id, created_at, source, label, note, summary, data, node)
    VALUES (?, ?, ?, ?, '', '{}', ?, 'fixture-node')
  `);
  for (let i = 1; i <= 3; i++) {
    insert.run(
      `auto-${i}`,
      i,
      "auto",
      `auto ${i}`,
      JSON.stringify({
        type: BACKUP_TYPE,
        version: 1,
        createdAt: i,
        node: "fixture-node",
        sharedBundle: { ...shared, version: 100 + i },
        userDataRows: [{
          user_key: "tb:user",
          kind: "tasks",
          data: [{ id: `task-${i}`, title: "x".repeat(20_000) }],
          updated_at: i,
          node: "fixture-node",
        }],
      }),
    );
  }
  insert.run(
    "manual-1",
    4,
    "manual",
    "manual",
    JSON.stringify({
      type: BACKUP_TYPE,
      version: 1,
      createdAt: 4,
      node: "fixture-node",
      sharedBundle: { ...shared, version: 104 },
      userDataRows: [],
    }),
  );
  db.close();
}

test("database maintenance preserves a verified backup, retains manual snapshots and compacts legacy data", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "database-maintenance-"));
  const dbPath = path.join(root, "data.db");
  const backupDir = path.join(root, "backups");
  createLegacyDatabase(dbPath);
  const originalBytes = fs.statSync(dbPath).size;

  const dryRun = await maintainDatabase({
    dbPath,
    backupDir,
    keepAuto: 2,
    apply: false,
    confirmOffline: false,
    vacuum: true,
  });
  assert.equal(dryRun.mode, "dry-run");
  assert.equal(dryRun.planned.deleteAutoBackups, 1);
  assert.equal(fs.existsSync(backupDir), false);

  const result = await maintainDatabase({
    dbPath,
    backupDir,
    keepAuto: 2,
    apply: true,
    confirmOffline: true,
    vacuum: true,
  });
  assert.equal(result.mode, "applied");
  assert.equal(result.backupVerification.quickCheck, "ok");
  assert.equal(result.backupVerification.backupCount, 4);
  assert.equal(result.changes.pruning.deleted, 1);
  assert.equal(result.changes.pruning.retained, 2);
  assert.equal(result.changes.migration.migrated, 3);
  assert.equal(result.changes.sharedCleanup.removedOps, 1);
  assert.equal(result.changes.sharedCleanup.removedClocks, 1);
  assert.equal(result.after.quickCheck, "ok");
  assert.equal(result.after.autoBackupCount, 2);
  assert.equal(result.after.backupCount, 3);
  assert.equal(result.after.legacyBackupCount, 0);
  assert.ok(result.after.fileBytes < originalBytes);
  assert.ok(fs.statSync(result.backupPath).size > 0);

  const db = new Database(dbPath, { readonly: true });
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM devbench_sync_backups WHERE source='manual'").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM devbench_sync_backups WHERE id='auto-1'").get().count, 0);
    const retained = db.prepare(`
      SELECT b.data AS legacy_data, p.encoding, p.data AS blob_data
      FROM devbench_sync_backups b
      JOIN devbench_sync_backup_blobs p ON p.blob_hash=b.blob_hash
      WHERE b.id='manual-1'
    `).get();
    assert.equal(retained.legacy_data, "");
    const decoded = retained.encoding === "gzip-json-v1"
      ? gunzipSync(retained.blob_data).toString("utf8")
      : retained.blob_data.toString("utf8");
    const payload = JSON.parse(decoded);
    assert.equal(payload.version, 2);
    assert.equal(payload.sharedBundle.sharedOps, undefined);

    const shared = JSON.parse(
      db.prepare("SELECT data FROM devbench_userdata WHERE user_key='__devbench_shared__' AND kind='shared'").get().data,
    );
    assert.equal(shared.projectDefs.some((def) => def.id === "market"), false);
    assert.equal(shared.byProject["project-a"], undefined);
    assert.deepEqual(shared.sharedOps.map((op) => op.id), ["real-op"]);
    assert.equal(Object.hasOwn(shared.sharedOpClocks, "byProject/project-a/aiTraining/configInference/settings"), false);
    assert.equal(shared.byProject.real.keywordMappings.tag.real.value, "real");
  } finally {
    db.close();
  }
});
