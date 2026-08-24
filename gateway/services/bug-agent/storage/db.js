/**
 * Bug Agent 数据库连接管理（方案 §6 / §10.4）
 *
 * 约定：
 *   - 所有写操作经 `writeQueue` 串行化（跨库 ATTACH 下防锁冲突）
 *   - WAL + busy_timeout 5s
 *   - lazy open：首次访问才打开连接
 *
 * 开发 / 生产路径：
 *   默认根 = process.env.BUG_AGENT_DB_ROOT
 *          || path.join(gatewayRoot, 'knowledge')
 *
 * 测试：使用 openFromConfig({ inMemory: true }) 建立临时内存库。
 */

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SCHEMA_COMMON, SCHEMA_APP } from "./schema.js";
import { seedPresetTree } from "../memory/tree-preset.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const GATEWAY_ROOT = path.resolve(__dirname, "../../..");

function defaultRoot() {
  return process.env.BUG_AGENT_DB_ROOT || path.join(GATEWAY_ROOT, "knowledge");
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function applyPragmas(db) {
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
}

/**
 * Storage 主句柄。一个实例管理 common + N 个 app.db。
 */
export class BugAgentStorage {
  constructor({ root, inMemory = false } = {}) {
    this.inMemory = inMemory;
    this.root = inMemory ? ":memory:" : (root || defaultRoot());
    this.common = null;
    this.apps = new Map(); // package_name -> Database
    this._writeQueue = Promise.resolve();
    if (!inMemory) ensureDir(this.root);
  }

  openCommon() {
    if (this.common) return this.common;
    if (this.inMemory) {
      this.common = new Database(":memory:");
    } else {
      this.common = new Database(path.join(this.root, "common.db"));
    }
    applyPragmas(this.common);
    this.common.exec(SCHEMA_COMMON);
    return this.common;
  }

  openApp(pkg) {
    if (this.apps.has(pkg)) return this.apps.get(pkg);
    let db;
    if (this.inMemory) {
      db = new Database(":memory:");
    } else {
      const appsDir = path.join(this.root, "apps");
      ensureDir(appsDir);
      db = new Database(path.join(appsDir, `${pkg}.db`));
    }
    applyPragmas(db);
    db.exec(SCHEMA_APP);
    // 首次 open 时 seed 预置 25 节点（幂等）
    try { seedPresetTree(db); } catch (_e) { /* non-fatal */ }
    this.apps.set(pkg, db);
    return db;
  }

  openQuarantine() {
    return this.openApp("__quarantine__");
  }

  /**
   * 选择 TB 单应归属哪个库。已登记走 app，否则 quarantine。
   */
  resolveTargetDb(package_name) {
    const common = this.openCommon();
    const row = common
      .prepare("SELECT db_path FROM case_catalog WHERE package_name = ? LIMIT 1")
      .get(package_name);
    if (row && row.db_path && row.db_path !== "__quarantine__") {
      return { db: this.openApp(package_name), pkg: package_name, quarantined: false };
    }
    return { db: this.openQuarantine(), pkg: package_name, quarantined: true };
  }

  /**
   * 所有写操作串行化。调用：await storage.enqueueWrite(() => db.prepare(...).run(...))
   */
  enqueueWrite(fn) {
    const next = this._writeQueue.then(() => Promise.resolve(fn()));
    this._writeQueue = next.catch(() => {}); // 防止单个失败阻塞队列
    return next;
  }

  close() {
    if (this.common) this.common.close();
    for (const db of this.apps.values()) db.close();
    this.common = null;
    this.apps.clear();
  }
}

// ---------- CRUD 帮助函数 ----------

/**
 * 以 tb_id 查询 case（跨 common.case_catalog 定位，再到对应 app 库取完整记录）。
 */
export function findCaseByTbId(storage, tb_id) {
  const common = storage.openCommon();
  const row = common
    .prepare("SELECT * FROM case_catalog WHERE tb_id = ?")
    .get(tb_id);
  if (!row) return null;
  const db = row.db_path === "__quarantine__" ? storage.openQuarantine() : storage.openApp(row.package_name);
  const full = db.prepare("SELECT * FROM cases WHERE tb_id = ?").get(tb_id);
  return full ? { catalog: row, case: full } : null;
}

/**
 * 插入 case：同时写 case_catalog + 对应 app/quarantine.cases，事务内完成。
 */
export function insertCase(storage, row) {
  const { db, pkg, quarantined } = storage.resolveTargetDb(row.package_name);
  const common = storage.openCommon();

  const dbPath = quarantined ? "__quarantine__" : pkg;

  // 使用 savepoint 因为我们对两个 Database 连接写入（无跨库事务）。
  // 先写 app，再写 common；失败时在 app 做 DELETE 补偿。
  const info = db
    .prepare(
      `INSERT INTO cases (tb_id, package_name, title, raw_content, exception_class,
         error_code, log_tag, process_name, signal, reporter_id,
         suspicious_prompt_injection, source_time)
       VALUES (@tb_id, @package_name, @title, @raw_content, @exception_class,
         @error_code, @log_tag, @process_name, @signal, @reporter_id,
         @suspicious_prompt_injection, @source_time)`
    )
    .run({
      tb_id: row.tb_id,
      package_name: row.package_name,
      title: row.title || null,
      raw_content: row.raw_content,
      exception_class: row.exception_class || null,
      error_code: row.error_code || null,
      log_tag: row.log_tag || null,
      process_name: row.process_name || null,
      signal: row.signal || null,
      reporter_id: row.reporter_id || null,
      suspicious_prompt_injection: row.suspicious_prompt_injection ? 1 : 0,
      source_time: row.source_time || null,
    });

  try {
    common
      .prepare(
        `INSERT OR REPLACE INTO case_catalog (tb_id, package_name, component_tag, db_path, title, category)
         VALUES (@tb_id, @package_name, @component_tag, @db_path, @title, @category)`
      )
      .run({
        tb_id: row.tb_id,
        package_name: row.package_name,
        component_tag: row.component_tag || "app",
        db_path: dbPath,
        title: row.title || null,
        category: null,
      });
  } catch (e) {
    // 回滚 app.cases 写入
    db.prepare("DELETE FROM cases WHERE id = ?").run(info.lastInsertRowid);
    throw e;
  }

  return { case_id: info.lastInsertRowid, db_path: dbPath };
}

/**
 * 按 case_id 更新分类结果。
 */
export function updateCaseClassification(storage, { package_name, case_id, category, sub_category, confidence }) {
  const { db } = storage.resolveTargetDb(package_name);
  db.prepare(
    `UPDATE cases SET category=@category, sub_category=@sub_category,
       confidence=@confidence, analyzed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id=@case_id`
  ).run({ case_id, category, sub_category, confidence });

  // 同步 case_catalog.category：通过 case_id 反查 tb_id（在 app 库内），
  // 然后在 common.db 按 tb_id 精确更新
  const tbRow = db.prepare("SELECT tb_id FROM cases WHERE id = ?").get(case_id);
  if (tbRow && tbRow.tb_id) {
    const common = storage.openCommon();
    common.prepare("UPDATE case_catalog SET category = ? WHERE tb_id = ?").run(category, tbRow.tb_id);
  }
}

// ---------- task_state ----------

export function upsertTaskState(storage, row) {
  const common = storage.openCommon();
  common
    .prepare(
      `INSERT INTO task_state (task_id, tb_id, status, progress, result_ref,
         error_code, raw_output, attempt, degraded, started_at, updated_at)
       VALUES (@task_id, @tb_id, @status, @progress, @result_ref,
         @error_code, @raw_output, @attempt, @degraded, @started_at, @updated_at)
       ON CONFLICT(tb_id) DO UPDATE SET
         status=excluded.status,
         progress=excluded.progress,
         result_ref=excluded.result_ref,
         error_code=excluded.error_code,
         raw_output=excluded.raw_output,
         attempt=excluded.attempt,
         degraded=excluded.degraded,
         updated_at=excluded.updated_at`
    )
    .run({
      task_id: row.task_id,
      tb_id: row.tb_id,
      status: row.status,
      progress: row.progress ?? 0,
      result_ref: row.result_ref || null,
      error_code: row.error_code || null,
      raw_output: row.raw_output || null,
      attempt: row.attempt ?? 0,
      degraded: row.degraded ? 1 : 0,
      started_at: row.started_at || null,
      updated_at: row.updated_at || new Date().toISOString(),
    });
}

export function findTaskByTbId(storage, tb_id) {
  const common = storage.openCommon();
  return common.prepare("SELECT * FROM task_state WHERE tb_id = ?").get(tb_id) || null;
}

export function findTaskById(storage, task_id) {
  const common = storage.openCommon();
  return common.prepare("SELECT * FROM task_state WHERE task_id = ?").get(task_id) || null;
}

// ---------- evidence ----------

export function insertEvidence(storage, package_name, row) {
  const { db } = storage.resolveTargetDb(package_name);
  const info = db
    .prepare(
      `INSERT INTO evidence_spans (case_id, source_type, source_sha256, archived_path,
         line_start, line_end, text_snapshot, tag, owner_package, ownership_confidence, source_time)
       VALUES (@case_id, @source_type, @source_sha256, @archived_path,
         @line_start, @line_end, @text_snapshot, @tag, @owner_package, @ownership_confidence, @source_time)`
    )
    .run({
      case_id: row.case_id,
      source_type: row.source_type,
      source_sha256: row.source_sha256,
      archived_path: row.archived_path,
      line_start: row.line_start ?? null,
      line_end: row.line_end ?? null,
      text_snapshot: row.text_snapshot,
      tag: row.tag || null,
      owner_package: row.owner_package || null,
      ownership_confidence: row.ownership_confidence ?? 1.0,
      source_time: row.source_time || null,
    });
  return info.lastInsertRowid;
}

export function listEvidenceByCase(storage, package_name, case_id) {
  const { db } = storage.resolveTargetDb(package_name);
  return db
    .prepare("SELECT * FROM evidence_spans WHERE case_id = ? ORDER BY id ASC")
    .all(case_id);
}

// ---------- reports ----------

export function insertReport(storage, package_name, row) {
  const { db } = storage.resolveTargetDb(package_name);
  const info = db
    .prepare(
      `INSERT INTO reports (case_id, content, evidence_refs, matched_rules,
         matched_tree_nodes, decision_trace, is_degraded, status)
       VALUES (@case_id, @content, @evidence_refs, @matched_rules,
         @matched_tree_nodes, @decision_trace, @is_degraded, @status)`
    )
    .run({
      case_id: row.case_id,
      content: row.content,
      evidence_refs: row.evidence_refs ? JSON.stringify(row.evidence_refs) : null,
      matched_rules: row.matched_rules ? JSON.stringify(row.matched_rules) : null,
      matched_tree_nodes: row.matched_tree_nodes ? JSON.stringify(row.matched_tree_nodes) : null,
      decision_trace: row.decision_trace ? JSON.stringify(row.decision_trace) : null,
      is_degraded: row.is_degraded ? 1 : 0,
      status: row.status || "active",
    });
  return info.lastInsertRowid;
}

export function getReportById(storage, package_name, report_id) {
  const { db } = storage.resolveTargetDb(package_name);
  return db.prepare("SELECT * FROM reports WHERE id = ?").get(report_id) || null;
}

// ---------- ratings ----------

export function insertRating(storage, package_name, row) {
  const { db } = storage.resolveTargetDb(package_name);
  const info = db
    .prepare(
      `INSERT INTO ratings (report_id, rater_id, score, comment, channel)
       VALUES (@report_id, @rater_id, @score, @comment, @channel)`
    )
    .run({
      report_id: row.report_id,
      rater_id: row.rater_id || null,
      score: row.score,
      comment: row.comment || null,
      channel: row.channel || "api",
    });
  return info.lastInsertRowid;
}
