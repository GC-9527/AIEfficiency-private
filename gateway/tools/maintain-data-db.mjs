// DevBench SQLite 离线维护：先生成并校验一致性备份，再执行有界清理。
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultDbPath = resolve(scriptDir, "../db/data.db");
const defaultBackupDir = resolve(scriptDir, "../../docs/tempFiles/database-maintenance");
const SYNTHETIC_SHARED_PROJECT_IDS = new Set([
  "acceptance-project",
  "project-a",
  "resolve-invariants-project",
  "project-config-writeback",
  "value-binding-concurrency-project",
  "symbol-resolution-concurrency-project",
]);
const SYNTHETIC_PROJECT_DEF_IDS = new Set([
  "market",
  "web",
  "same-name-a",
  "same-name-b",
  "custom-app",
  "voice-sdk-custom",
]);
const BACKUP_TYPE = "devbench-sync-local-backup";
const GZIP_ENCODING = "gzip-json-v1";
const JSON_ENCODING = "json-utf8-v1";

function usage() {
  return [
    "用法：node tools/maintain-data-db.mjs [选项]",
    "",
    "默认仅分析，不修改数据库。",
    "  --db <path>              数据库路径",
    "  --keep-auto <count>      自动备份保留数量，默认 48",
    "  --backup-dir <path>      一致性备份输出目录",
    "  --apply                  执行维护",
    "  --confirm-offline        确认目标 Gateway 已停止（--apply 必需）",
    "  --vacuum                 执行 VACUUM，物理回收文件空间",
    "  --help                   显示帮助",
  ].join("\n");
}

export function parseArgs(argv = []) {
  const options = {
    dbPath: defaultDbPath,
    keepAuto: 48,
    backupDir: defaultBackupDir,
    apply: false,
    confirmOffline: false,
    vacuum: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--db=")) options.dbPath = resolve(arg.slice("--db=".length));
    else if (arg.startsWith("--keep-auto=")) options.keepAuto = Number(arg.slice("--keep-auto=".length));
    else if (arg.startsWith("--backup-dir=")) options.backupDir = resolve(arg.slice("--backup-dir=".length));
    else if (arg === "--db") options.dbPath = resolve(String(argv[++i] || ""));
    else if (arg === "--keep-auto") options.keepAuto = Number(argv[++i]);
    else if (arg === "--backup-dir") options.backupDir = resolve(String(argv[++i] || ""));
    else if (arg === "--apply") options.apply = true;
    else if (arg === "--confirm-offline") options.confirmOffline = true;
    else if (arg === "--vacuum") options.vacuum = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`未知参数：${arg}`);
  }
  if (!Number.isInteger(options.keepAuto) || options.keepAuto < 1 || options.keepAuto > 1000) {
    throw new Error("--keep-auto 必须是 1 到 1000 之间的整数");
  }
  if (!options.dbPath) throw new Error("--db 不能为空");
  if (!options.backupDir) throw new Error("--backup-dir 不能为空");
  return options;
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function stableJsonText(value) {
  if (Array.isArray(value)) return `[${value.map(stableJsonText).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJsonText(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function safeJson(value, fallback = null) {
  try {
    return JSON.parse(String(value || ""));
  } catch {
    return fallback;
  }
}

function isKnownSyntheticProjectDef(def = {}) {
  const id = String(def?.id || "").trim();
  if (!SYNTHETIC_PROJECT_DEF_IDS.has(id)) return false;
  const remotes = `${String(def?.https || "")} ${String(def?.ssh || "")}`.toLowerCase();
  return remotes.includes("example.com");
}

function cleanSharedValue(value = {}) {
  if (!isPlainObject(value)) return { value, changed: false, removedProjects: 0, removedProjectDefs: 0 };
  const projectDefs = Array.isArray(value.projectDefs)
    ? value.projectDefs.filter((def) => !isKnownSyntheticProjectDef(def))
    : value.projectDefs;
  const byProject = isPlainObject(value.byProject) ? { ...value.byProject } : value.byProject;
  let removedProjects = 0;
  if (isPlainObject(byProject)) {
    for (const projectId of SYNTHETIC_SHARED_PROJECT_IDS) {
      if (!Object.prototype.hasOwnProperty.call(byProject, projectId)) continue;
      delete byProject[projectId];
      removedProjects++;
    }
  }
  const removedProjectDefs = Array.isArray(value.projectDefs)
    ? value.projectDefs.length - projectDefs.length
    : 0;
  const changed = removedProjects > 0 || removedProjectDefs > 0;
  return {
    value: changed
      ? {
          ...value,
          ...(Array.isArray(value.projectDefs) ? { projectDefs } : {}),
          ...(isPlainObject(value.byProject) ? { byProject } : {}),
        }
      : value,
    changed,
    removedProjects,
    removedProjectDefs,
  };
}

function portableUserDataRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    user_key: String(row?.user_key || ""),
    kind: String(row?.kind || ""),
    data: row?.data ?? [],
  }));
}

function compactBackupPayload(rawData) {
  const parsed = safeJson(rawData, null);
  if (!isPlainObject(parsed) || parsed.type !== BACKUP_TYPE) {
    throw new Error("备份内容不是受支持的 DevBench 共享备份");
  }
  const source = isPlainObject(parsed.sharedBundle) ? parsed.sharedBundle : {};
  const cleaned = cleanSharedValue(source).value;
  const sharedBundle = {
    projectDefs: Array.isArray(cleaned.projectDefs) ? cleaned.projectDefs : [],
    byProject: isPlainObject(cleaned.byProject) ? cleaned.byProject : {},
    dingtalkMsgConfig: isPlainObject(cleaned.dingtalkMsgConfig) ? cleaned.dingtalkMsgConfig : null,
    vehicleMapSeededAt: Number(cleaned.vehicleMapSeededAt) || 0,
  };
  const userDataRows = portableUserDataRows(parsed.userDataRows);
  const data = {
    type: BACKUP_TYPE,
    version: 2,
    sharedBundle,
    userDataRows,
  };
  const contentHash = createHash("sha256")
    .update(stableJsonText({ sharedBundle, userDataRows }))
    .digest("hex");
  return {
    data,
    contentHash,
    sharedVersion: Number(source.version || source._sharedVersion) || 0,
    sharedOpsCount: Array.isArray(source.sharedOps) ? source.sharedOps.length : 0,
  };
}

function encodeJson(value) {
  const raw = Buffer.from(JSON.stringify(value), "utf8");
  const gzip = gzipSync(raw, { level: 6 });
  return {
    blobHash: createHash("sha256").update(raw).digest("hex"),
    encoding: gzip.length < raw.length ? GZIP_ENCODING : JSON_ENCODING,
    rawBytes: raw.length,
    storedBytes: Math.min(gzip.length, raw.length),
    data: gzip.length < raw.length ? gzip : raw,
  };
}

function ensureBackupSchema(db) {
  const columns = db.prepare("PRAGMA table_info(devbench_sync_backups)").all();
  if (!columns.some((column) => column.name === "blob_hash")) {
    db.exec("ALTER TABLE devbench_sync_backups ADD COLUMN blob_hash TEXT");
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS devbench_sync_backup_blobs (
      blob_hash TEXT PRIMARY KEY,
      encoding TEXT NOT NULL,
      raw_bytes INTEGER NOT NULL,
      stored_bytes INTEGER NOT NULL,
      data BLOB NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_devbench_sync_backups_blob
      ON devbench_sync_backups(blob_hash);
  `);
}

function databaseStats(db, dbPath) {
  const tableExists = (name) => !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
  ).get(name);
  const pageSize = Number(db.pragma("page_size", { simple: true })) || 0;
  const pageCount = Number(db.pragma("page_count", { simple: true })) || 0;
  const freePages = Number(db.pragma("freelist_count", { simple: true })) || 0;
  const backupCount = tableExists("devbench_sync_backups")
    ? Number(db.prepare("SELECT COUNT(*) AS count FROM devbench_sync_backups").get().count) || 0
    : 0;
  const autoBackupCount = tableExists("devbench_sync_backups")
    ? Number(db.prepare("SELECT COUNT(*) AS count FROM devbench_sync_backups WHERE source='auto'").get().count) || 0
    : 0;
  const legacyBackupCount = tableExists("devbench_sync_backups")
    && db.prepare("PRAGMA table_info(devbench_sync_backups)").all().some((column) => column.name === "blob_hash")
    ? Number(db.prepare("SELECT COUNT(*) AS count FROM devbench_sync_backups WHERE COALESCE(blob_hash, '')=''").get().count) || 0
    : backupCount;
  const blobStats = tableExists("devbench_sync_backup_blobs")
    ? db.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(stored_bytes),0) AS bytes, COALESCE(SUM(raw_bytes),0) AS raw_bytes FROM devbench_sync_backup_blobs").get()
    : { count: 0, bytes: 0, raw_bytes: 0 };
  const shared = tableExists("devbench_userdata")
    ? db.prepare("SELECT data FROM devbench_userdata WHERE user_key='__devbench_shared__' AND kind='shared'").get()
    : null;
  const sharedData = safeJson(shared?.data, {});
  const sharedOps = Array.isArray(sharedData?.sharedOps) ? sharedData.sharedOps : [];
  const sharedProjects = isPlainObject(sharedData?.byProject) ? sharedData.byProject : {};
  const sharedProjectDefs = Array.isArray(sharedData?.projectDefs) ? sharedData.projectDefs : [];
  return {
    fileBytes: existsSync(dbPath) ? statSync(dbPath).size : 0,
    allocatedBytes: pageSize * pageCount,
    reclaimableBytes: pageSize * freePages,
    pageSize,
    pageCount,
    freePages,
    backupCount,
    autoBackupCount,
    legacyBackupCount,
    uniqueBlobCount: Number(blobStats.count) || 0,
    backupBlobBytes: Number(blobStats.bytes) || 0,
    backupBlobRawBytes: Number(blobStats.raw_bytes) || 0,
    sharedVersion: Number(sharedData?._sharedVersion) || 0,
    sharedOpsCount: sharedOps.length,
    sharedClockCount: Object.keys(isPlainObject(sharedData?.sharedOpClocks) ? sharedData.sharedOpClocks : {}).length,
    syntheticSharedOpsCount: sharedOps.filter((op) => (
      SYNTHETIC_SHARED_PROJECT_IDS.has(String(op?.projectId || ""))
      || (op?.type === "projectDef.set" && isKnownSyntheticProjectDef(op.value))
    )).length,
    syntheticProjectCount: Object.keys(sharedProjects)
      .filter((projectId) => SYNTHETIC_SHARED_PROJECT_IDS.has(projectId)).length,
    syntheticProjectDefCount: sharedProjectDefs.filter(isKnownSyntheticProjectDef).length,
    sharedJsonBytes: Buffer.byteLength(String(shared?.data || ""), "utf8"),
    quickCheck: String(db.pragma("quick_check", { simple: true }) || ""),
  };
}

function migrateRetainedBackups(db) {
  const rows = db.prepare(`
    SELECT id, created_at, summary, data
    FROM devbench_sync_backups
    WHERE COALESCE(blob_hash, '') = ''
    ORDER BY created_at ASC, id ASC
  `).all();
  const insertBlob = db.prepare(`
    INSERT OR IGNORE INTO devbench_sync_backup_blobs
      (blob_hash, encoding, raw_bytes, stored_bytes, data, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const updateBackup = db.prepare(`
    UPDATE devbench_sync_backups
    SET data='', blob_hash=?, summary=?
    WHERE id=?
  `);
  let migrated = 0;
  let rawBytes = 0;
  let storedBytes = 0;
  for (const row of rows) {
    const compact = compactBackupPayload(row.data);
    const encoded = encodeJson(compact.data);
    const summary = {
      ...(safeJson(row.summary, {}) || {}),
      sharedVersion: compact.sharedVersion,
      sharedOpsCount: compact.sharedOpsCount,
      contentHash: compact.contentHash,
    };
    insertBlob.run(
      encoded.blobHash,
      encoded.encoding,
      encoded.rawBytes,
      encoded.storedBytes,
      encoded.data,
      Number(row.created_at) || Date.now(),
    );
    updateBackup.run(encoded.blobHash, JSON.stringify(summary), row.id);
    migrated++;
    rawBytes += encoded.rawBytes;
    storedBytes += encoded.storedBytes;
  }
  return { migrated, rawBytes, storedBytes };
}

function pruneAutoBackups(db, keepAuto) {
  const rows = db.prepare(`
    SELECT id FROM devbench_sync_backups
    WHERE source='auto'
    ORDER BY created_at DESC, id DESC
    LIMIT -1 OFFSET ?
  `).all(keepAuto);
  const remove = db.prepare("DELETE FROM devbench_sync_backups WHERE id=?");
  for (const row of rows) remove.run(row.id);
  const retained = Number(
    db.prepare("SELECT COUNT(*) AS count FROM devbench_sync_backups WHERE source='auto'").get().count,
  ) || 0;
  return { deleted: rows.length, retained };
}

function cleanLiveSharedState(db) {
  const row = db.prepare(`
    SELECT data, updated_at, node
    FROM devbench_userdata
    WHERE user_key='__devbench_shared__' AND kind='shared'
  `).get();
  if (!row) return { changed: false, removedOps: 0, removedClocks: 0, removedProjects: 0, removedProjectDefs: 0 };
  const value = safeJson(row.data, null);
  if (!isPlainObject(value)) throw new Error("共享状态 JSON 无法解析");
  const cleanedRoot = cleanSharedValue(value);
  const next = cleanedRoot.changed ? cleanedRoot.value : { ...value };
  const removedOpIds = new Set();
  const originalOps = Array.isArray(value.sharedOps) ? value.sharedOps : [];
  next.sharedOps = originalOps.filter((op) => {
    const remove = SYNTHETIC_SHARED_PROJECT_IDS.has(String(op?.projectId || ""))
      || (op?.type === "projectDef.set" && isKnownSyntheticProjectDef(op.value));
    if (remove && op?.id) removedOpIds.add(String(op.id));
    return !remove;
  });
  const clocks = isPlainObject(value.sharedOpClocks) ? value.sharedOpClocks : {};
  const nextClocks = {};
  let removedClocks = 0;
  for (const [key, clock] of Object.entries(clocks)) {
    const syntheticProjectClock = [...SYNTHETIC_SHARED_PROJECT_IDS]
      .some((projectId) => key.startsWith(`byProject/${projectId}/`));
    if (syntheticProjectClock || removedOpIds.has(String(clock?.id || ""))) {
      removedClocks++;
      continue;
    }
    nextClocks[key] = clock;
  }
  next.sharedOpClocks = nextClocks;
  const removedOps = originalOps.length - next.sharedOps.length;
  const changed = cleanedRoot.changed || removedOps > 0 || removedClocks > 0;
  if (!changed) {
    return {
      changed: false,
      removedOps: 0,
      removedClocks: 0,
      removedProjects: 0,
      removedProjectDefs: 0,
    };
  }
  const now = Date.now();
  next._sharedVersion = Math.max(Number(value._sharedVersion) + 1 || 0, now);
  db.prepare(`
    UPDATE devbench_userdata
    SET data=?, updated_at=?
    WHERE user_key='__devbench_shared__' AND kind='shared'
  `).run(JSON.stringify(next), now);
  return {
    changed: true,
    removedOps,
    removedClocks,
    removedProjects: cleanedRoot.removedProjects,
    removedProjectDefs: cleanedRoot.removedProjectDefs,
    previousVersion: Number(value._sharedVersion) || 0,
    sharedVersion: next._sharedVersion,
  };
}

function updateRetentionSetting(db, keepAuto) {
  const key = "devbench-sync-backup";
  const current = safeJson(
    db.prepare("SELECT value FROM devbench_sync_backup_settings WHERE key=?").get(key)?.value,
    {},
  ) || {};
  const next = {
    enabled: current.enabled !== false,
    intervalMinutes: Math.max(5, Math.min(10080, Number(current.intervalMinutes) || 60)),
    maxAutoBackups: keepAuto,
    lastAutoBackupAt: Number(current.lastAutoBackupAt) || 0,
  };
  db.prepare(`
    INSERT INTO devbench_sync_backup_settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `).run(key, JSON.stringify(next));
  return next;
}

function timestampText(now = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "-",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join("");
}

function verifyBackup(backupPath, expected) {
  const backup = new Database(backupPath, { readonly: true });
  try {
    const actual = {
      quickCheck: String(backup.pragma("quick_check", { simple: true }) || ""),
      backupCount: Number(backup.prepare("SELECT COUNT(*) AS count FROM devbench_sync_backups").get().count) || 0,
      userDataCount: Number(backup.prepare("SELECT COUNT(*) AS count FROM devbench_userdata").get().count) || 0,
    };
    if (actual.quickCheck !== "ok"
      || actual.backupCount !== expected.backupCount
      || actual.userDataCount !== expected.userDataCount) {
      throw new Error(`一致性备份校验失败：${JSON.stringify(actual)}`);
    }
    return actual;
  } finally {
    backup.close();
  }
}

export async function maintainDatabase(options) {
  if (!existsSync(options.dbPath)) throw new Error(`数据库不存在：${options.dbPath}`);
  if (options.apply && !options.confirmOffline) {
    throw new Error("--apply 必须同时提供 --confirm-offline，确认目标 Gateway 已停止");
  }
  const db = new Database(options.dbPath, options.apply ? {} : { readonly: true });
  db.pragma("busy_timeout = 5000");
  try {
    const before = databaseStats(db, options.dbPath);
    const autoToDelete = Math.max(0, before.autoBackupCount - options.keepAuto);
    if (!options.apply) {
      return {
        mode: "dry-run",
        dbPath: options.dbPath,
        keepAuto: options.keepAuto,
        planned: {
          deleteAutoBackups: autoToDelete,
          migrateLegacyBackups: Math.min(
            before.legacyBackupCount,
            Math.max(0, before.backupCount - autoToDelete),
          ),
          cleanSyntheticSharedState: before.syntheticSharedOpsCount > 0
            || before.syntheticProjectCount > 0
            || before.syntheticProjectDefCount > 0,
          vacuum: options.vacuum,
        },
        before,
      };
    }

    mkdirSync(options.backupDir, { recursive: true });
    const backupPath = join(options.backupDir, `data-before-maintenance-${timestampText()}.db`);
    const userDataCount = Number(
      db.prepare("SELECT COUNT(*) AS count FROM devbench_userdata").get().count,
    ) || 0;
    await db.backup(backupPath);
    const backupVerification = verifyBackup(backupPath, {
      backupCount: before.backupCount,
      userDataCount,
    });

    let transactionResult;
    const transaction = db.transaction(() => {
      ensureBackupSchema(db);
      const pruning = pruneAutoBackups(db, options.keepAuto);
      const migration = migrateRetainedBackups(db);
      const sharedCleanup = cleanLiveSharedState(db);
      const orphanedBlobs = db.prepare(`
        DELETE FROM devbench_sync_backup_blobs
        WHERE NOT EXISTS (
          SELECT 1 FROM devbench_sync_backups b
          WHERE b.blob_hash=devbench_sync_backup_blobs.blob_hash
        )
      `).run().changes;
      const settings = updateRetentionSetting(db, options.keepAuto);
      transactionResult = { pruning, migration, sharedCleanup, orphanedBlobs, settings };
    });
    transaction();

    db.pragma("wal_checkpoint(TRUNCATE)");
    if (options.vacuum) db.exec("VACUUM");
    db.pragma("wal_checkpoint(TRUNCATE)");
    const after = databaseStats(db, options.dbPath);
    if (after.quickCheck !== "ok") throw new Error(`维护后 quick_check 失败：${after.quickCheck}`);
    return {
      mode: "applied",
      dbPath: options.dbPath,
      keepAuto: options.keepAuto,
      backupPath,
      backupVerification,
      vacuumed: options.vacuum,
      before,
      changes: transactionResult,
      after,
    };
  } finally {
    db.close();
  }
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
      return;
    }
    const result = await maintainDatabase(options);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`[database-maintenance] ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
