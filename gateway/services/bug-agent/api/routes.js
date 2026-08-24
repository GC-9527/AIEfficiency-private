/**
 * Bug Agent HTTP 路由（方案 §10.3，P0 MVP 子集）
 *
 * 挂载方式（server.js）：
 *   import { createBugAgentRouter } from './services/bug-agent/api/routes.js';
 *   app.use('/api/bug', createBugAgentRouter({ storage, logger }));
 */

import express from "express";
import fs from "node:fs";

import { analyzeTbCase } from "../classifier/classifier.js";
import {
  findTaskByTbId,
  findTaskById,
  findCaseByTbId,
  getReportById,
  insertRating,
  listEvidenceByCase,
} from "../storage/db.js";
import { updateOnRating } from "../scoring/weight-updater.js";
import {
  appendSessionMemory,
  listSessionMemory,
  selfProfile,
  purgeUser,
} from "../memory/session-memory.js";
import {
  buildSignedEvidenceUrl,
  consumeEvidenceToken,
  createMemoryTokenStore,
} from "./evidence-signer.js";
import {
  feishuWebhookVerifier,
  rawBodyCapture,
  createMemoryDedup,
} from "./feishu-webhook.js";
import { defaultCSPHeader } from "./xss-safe.js";
import { listRecentCost, checkBudget } from "../ops/llm-budget.js";
import { transformTbRecordToInput } from "../ingest/tb-adapter.js";
import { fetchTbTaskById } from "../ingest/tb-fetcher.js";
import { listTbTaskRecords, getTbTaskRecord } from "../../../db/sqlite.js";

/**
 * @param {Object} deps
 * @param {BugAgentStorage} deps.storage
 * @param {Function} [deps.logger] - (level, module, msg) => void
 * @param {Function} [deps.getFeishuSecret] - (req) => string
 */
export function createBugAgentRouter(deps) {
  const { storage, logger } = deps || {};
  if (!storage) throw new Error("storage required");

  const router = express.Router();
  const tokenStore = createMemoryTokenStore();
  const fsDedup = createMemoryDedup();

  router.use((req, res, next) => {
    res.setHeader("content-security-policy", defaultCSPHeader());
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    next();
  });

  // ---------- POST /analyze ----------
  router.post("/analyze", express.json({ limit: "4mb" }), async (req, res) => {
    try {
      const { tb_id, package_name, title, raw_content, log_attachment, reporter_id } = req.body || {};
      if (!tb_id || !package_name || !title || !raw_content) {
        return res.status(400).json({ error: "missing required: tb_id/package_name/title/raw_content" });
      }

      // 幂等检查
      const existing = findTaskByTbId(storage, tb_id);
      if (existing && existing.status === "succeeded") {
        return res.json({
          task_id: existing.task_id,
          status: existing.status,
          result_ref: existing.result_ref,
          idempotent: true,
        });
      }

      // 异步触发；立即返回 task_id
      const task_id = req.body._task_id || undefined;
      const p = analyzeTbCase(
        { tb_id, package_name, title, raw_content, log_attachment, reporter_id },
        { storage, _deps: { task_id } }
      );

      // 提交前记录 running 由 analyzeTbCase 内部完成
      if (req.body._wait === true) {
        const r = await p;
        return res.json(r);
      } else {
        p.catch((e) => logger && logger("error", "bug-agent", `analyze error: ${e.message}`));
        const justEnq = findTaskByTbId(storage, tb_id);
        res.status(202).json({
          task_id: justEnq?.task_id,
          status: justEnq?.status || "pending",
        });
      }
    } catch (e) {
      res.status(500).json({ error: e.message, code: e.code });
    }
  });

  // ---------- GET /tasks （列出最近任务，含基本分类信息） ----------
  router.get("/tasks", (req, res) => {
    const limit = Math.min(200, Number(req.query.limit) || 50);
    const status = req.query.status;
    const common = storage.openCommon();
    const rows = status
      ? common.prepare("SELECT * FROM task_state WHERE status=? ORDER BY updated_at DESC LIMIT ?").all(status, limit)
      : common.prepare("SELECT * FROM task_state ORDER BY updated_at DESC LIMIT ?").all(limit);
    // 附带 package_name 与 category（从 case_catalog 反查）
    const out = rows.map((t) => {
      const cat = common.prepare("SELECT package_name, category, title FROM case_catalog WHERE tb_id=?").get(t.tb_id);
      return {
        task_id: t.task_id,
        tb_id: t.tb_id,
        status: t.status,
        progress: t.progress,
        result_ref: t.result_ref,
        error_code: t.error_code,
        degraded: !!t.degraded,
        updated_at: t.updated_at,
        started_at: t.started_at,
        package_name: cat?.package_name || null,
        category: cat?.category || null,
        title: cat?.title || null,
      };
    });
    res.json(out);
  });

  // ---------- GET /cases （分页 + 过滤） ----------
  router.get("/cases", (req, res) => {
    const pkg = req.query.pkg;
    const category = req.query.category;
    const limit = Math.min(200, Number(req.query.limit) || 50);
    const offset = Math.max(0, Number(req.query.offset) || 0);

    // 扫 case_catalog 获取包列表，再从对应 app.db 取 cases
    const common = storage.openCommon();
    const filters = [];
    const params = [];
    if (pkg) { filters.push("package_name=?"); params.push(pkg); }
    if (category) { filters.push("category=?"); params.push(category); }
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const catalogRows = common.prepare(
      `SELECT * FROM case_catalog ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset);
    const total = common.prepare(`SELECT COUNT(*) AS c FROM case_catalog ${where}`).get(...params).c;

    const cases = catalogRows.map((cat) => {
      const { db } = storage.resolveTargetDb(cat.package_name);
      const row = db.prepare(
        `SELECT id, tb_id, package_name, title, category, sub_category, confidence,
                created_at, analyzed_at, suspicious_prompt_injection
         FROM cases WHERE tb_id=?`
      ).get(cat.tb_id);
      return row || null;
    }).filter(Boolean);

    res.json({ total, limit, offset, items: cases });
  });

  // ---------- GET /tree ----------
  router.get("/tree", (req, res) => {
    const pkg = req.query.pkg;
    if (!pkg) return res.status(400).json({ error: "pkg required" });
    const { db } = storage.resolveTargetDb(pkg);
    const nodes = db.prepare(
      `SELECT id, parent_id, level, title, summary, weight, hit_count, status, version, last_hit_at
       FROM memory_tree ORDER BY level ASC, id ASC`
    ).all();
    res.json(nodes);
  });

  // ---------- GET /rules ----------
  router.get("/rules", (req, res) => {
    const pkg = req.query.pkg;
    if (!pkg) return res.status(400).json({ error: "pkg required" });
    const { db } = storage.resolveTargetDb(pkg);
    const rules = db.prepare(
      "SELECT * FROM rules ORDER BY rule_score DESC LIMIT 200"
    ).all();
    res.json(rules);
  });

  // ---------- GET /tb-import/list （列出 TB 任务供选择导入） ----------
  router.get("/tb-import/list", (req, res) => {
    try {
      const limit = Math.min(200, Number(req.query.limit) || 50);
      const status = req.query.status;
      const rows = listTbTaskRecords({ status, limit }) || [];
      // 精简字段，避免泄露敏感数据
      const slim = rows.map((r) => ({
        id: r.id,
        carb_id: r.carb_id,
        title: r.title,
        project_name: r.project_name,
        executor_name: r.executor_name,
        status: r.status,
        has_local_dir: !!r.local_dir,
        has_attachments: !!r.attachments_json && r.attachments_json !== "[]",
        analyzed_at: r.analyzed_at,
        detected_at: r.detected_at,
      }));
      res.json(slim);
    } catch (e) {
      if (logger) logger("error", "bug-agent", `tb-import list failed: ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  });

  // ---------- GET /tb-import/:tb_id/preview （从本地 tb_task_records 预填充） ----------
  router.get("/tb-import/:tb_id/preview", (req, res) => {
    try {
      const tb_id = req.params.tb_id;
      const record = getTbTaskRecord(tb_id);
      if (!record) return res.status(404).json({ error: "TB task not found in local cache" });
      const input = transformTbRecordToInput(record);
      res.json(input);
    } catch (e) {
      if (logger) logger("error", "bug-agent", `tb-import preview failed: ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  });

  // ---------- POST /tb-import/fetch （**实时**从 Teambition 平台按单号拉取） ----------
  router.post("/tb-import/fetch", express.json(), async (req, res) => {
    try {
      const tb_id = (req.body?.tb_id || req.query?.tb_id || "").toString().trim();
      if (!tb_id) return res.status(400).json({ error: "tb_id required (e.g. CARB-12345 / 12345 / ObjectId)" });
      if (logger) logger("info", "bug-agent", `tb-import fetch: ${tb_id}`);
      const input = await fetchTbTaskById(tb_id);
      res.json(input);
    } catch (e) {
      const code = e.code || "FETCH_ERROR";
      const status = code === "TB_NOT_FOUND" ? 404 : code === "BAD_QUERY" ? 400 : 500;
      if (logger) logger("warn", "bug-agent", `tb-import fetch failed: ${code} - ${e.message}`);
      res.status(status).json({ error: e.message, code });
    }
  });

  // ---------- GET /packages （已登记包列表） ----------
  router.get("/packages", (req, res) => {
    const common = storage.openCommon();
    const rows = common.prepare(
      `SELECT package_name, COUNT(*) AS case_count, MAX(created_at) AS last_seen
       FROM case_catalog GROUP BY package_name ORDER BY last_seen DESC`
    ).all();
    res.json(rows);
  });

  // ---------- GET /task/:task_id ----------
  router.get("/task/:task_id", (req, res) => {
    const row = findTaskById(storage, req.params.task_id);
    if (!row) return res.status(404).json({ error: "task not found" });
    res.json({
      task_id: row.task_id,
      tb_id: row.tb_id,
      status: row.status,
      progress: row.progress,
      result_ref: row.result_ref,
      error_code: row.error_code,
      degraded: !!row.degraded,
      updated_at: row.updated_at,
    });
  });

  // ---------- GET /report/:id ----------
  router.get("/report/:id", (req, res) => {
    const reportId = Number(req.params.id);
    if (!Number.isFinite(reportId)) return res.status(400).json({ error: "invalid id" });

    // 跨所有 app 库查找（P0 简化：先在 quarantine 找，未来走 case_catalog）
    const pkg = req.query.pkg;
    if (!pkg) return res.status(400).json({ error: "pkg query required" });
    const report = getReportById(storage, pkg, reportId);
    if (!report) return res.status(404).json({ error: "report not found" });

    res.json({
      id: report.id,
      case_id: report.case_id,
      content: report.content,
      evidence_refs: safeParseJson(report.evidence_refs),
      matched_rules: safeParseJson(report.matched_rules),
      is_degraded: !!report.is_degraded,
      status: report.status,
      created_at: report.created_at,
    });
  });

  // ---------- GET /case/:tb_id ----------
  router.get("/case/:tb_id", (req, res) => {
    const found = findCaseByTbId(storage, req.params.tb_id);
    if (!found) return res.status(404).json({ error: "case not found" });
    const evidences = listEvidenceByCase(storage, found.case.package_name, found.case.id);
    // 返回精简后的 evidence 详情：含前 600 字 text_snapshot 预览 + 元信息
    const evidenceDigest = evidences.map((e) => ({
      id: e.id,
      source_type: e.source_type,
      tag: e.tag,
      owner_package: e.owner_package,
      ownership_confidence: e.ownership_confidence,
      line_start: e.line_start,
      line_end: e.line_end,
      source_sha256: e.source_sha256,
      text_length: e.text_snapshot ? e.text_snapshot.length : 0,
      preview: e.text_snapshot ? e.text_snapshot.slice(0, 600) : "",
      truncated: e.text_snapshot && e.text_snapshot.length > 600,
    }));
    res.json({
      case: found.case,
      catalog: found.catalog,
      evidence_count: evidences.length,
      evidences: evidenceDigest,
    });
  });

  // ---------- POST /rate ----------
  router.post("/rate", express.json(), (req, res) => {
    const { report_id, score, comment, rater_id, channel, pkg } = req.body || {};
    if (!report_id || !score || !pkg) {
      return res.status(400).json({ error: "report_id/score/pkg required" });
    }
    if (score < 1 || score > 5) return res.status(400).json({ error: "score must be 1-5" });
    const id = insertRating(storage, pkg, { report_id, score, comment, rater_id, channel });

    // 评分触发权重反哺（§8.2 / §8.3）
    try {
      const rep = getReportById(storage, pkg, report_id);
      const matched = rep && rep.matched_rules ? safeParseJson(rep.matched_rules) : [];
      if (Array.isArray(matched) && matched.length > 0) {
        updateOnRating(storage, {
          report_id, package_name: pkg, score,
          matched_rule_ids: matched.filter((m) => Number.isInteger(m)),
          rater_id,
        });
      }
    } catch (e) {
      if (logger) logger("warn", "bug-agent", `weight update failed: ${e.message}`);
    }

    res.json({ id });
  });

  // ---------- 会话记忆 ----------
  router.post("/session/memory", express.json(), (req, res) => {
    const { session_id, case_id, content } = req.body || {};
    if (!session_id || !content) return res.status(400).json({ error: "session_id/content required" });
    res.json(appendSessionMemory(storage, { session_id, case_id, content }));
  });

  router.get("/session/memory", (req, res) => {
    const { session_id, case_id, limit } = req.query;
    if (!session_id) return res.status(400).json({ error: "session_id required" });
    const rows = listSessionMemory(storage, {
      session_id,
      case_id: case_id ? Number(case_id) : null,
      limit: limit ? Number(limit) : 50,
    });
    res.json(rows);
  });

  // ---------- 工程师画像自查看 ----------
  router.get("/profile/self", (req, res) => {
    const user_id = req.query.uid || req.headers["x-user-id"];
    if (!user_id) return res.status(400).json({ error: "uid required" });
    const p = selfProfile(storage, String(user_id));
    if (!p) return res.status(404).json({ error: "profile not found" });
    res.json(p);
  });

  // ---------- PII 擦除 ----------
  router.post("/admin/purge-pii", express.json(), (req, res) => {
    const { user_id, operator } = req.body || {};
    if (!user_id) return res.status(400).json({ error: "user_id required" });
    purgeUser(storage, user_id, operator || "admin");
    res.json({ ok: true });
  });

  // ---------- LLM 成本查看 ----------
  router.get("/admin/llm-cost", (req, res) => {
    const days = Number(req.query.days) || 30;
    res.json({
      budget: checkBudget(storage),
      recent: listRecentCost(storage, days),
    });
  });

  // ---------- GET /evidence/:id （返回签名短链）----------
  router.get("/evidence/:id", (req, res) => {
    const user_id = req.query.uid || req.headers["x-user-id"] || "anonymous";
    try {
      const { url, exp } = buildSignedEvidenceUrl({
        evidence_id: req.params.id,
        user_id: String(user_id),
      });
      res.json({ url, exp });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---------- GET /evidence/download ----------
  router.get("/evidence/download", (req, res) => {
    const { token, exp, eid, uid } = req.query;
    const pkg = req.query.pkg;
    const r = consumeEvidenceToken({ token, eid, uid, exp, store: tokenStore });
    if (!r.ok) {
      if (logger) logger("warn", "bug-agent", `evidence token invalid: ${r.reason}`);
      return res.status(401).json({ error: "invalid token", reason: r.reason });
    }
    if (!pkg) return res.status(400).json({ error: "pkg query required" });

    const evidences = listEvidenceByCase(storage, pkg, Number(eid));
    // P0 简化：按 id 查找（正确做法应走 cross-db index）
    const all = storage.openApp(pkg).prepare("SELECT * FROM evidence_spans WHERE id = ?").get(Number(eid));
    if (!all) return res.status(404).json({ error: "evidence not found" });

    if (all.archived_path && all.archived_path.startsWith("inmem://")) {
      return res.json({ text_snapshot: all.text_snapshot, inmem: true });
    }
    if (all.archived_path && fs.existsSync(all.archived_path)) {
      res.setHeader("content-type", "text/plain; charset=utf-8");
      return fs.createReadStream(all.archived_path).pipe(res);
    }
    res.json({ text_snapshot: all.text_snapshot });
  });

  // ---------- POST /webhook/feishu ----------
  router.post(
    "/webhook/feishu",
    rawBodyCapture,
    feishuWebhookVerifier({
      getSecret: () => process.env.BUG_AGENT_FEISHU_SECRET || "",
      dedup: fsDedup,
      logger,
    }),
    (req, res) => {
      // 飞书验证握手（url_verification）
      if (req.body && req.body.type === "url_verification" && req.body.challenge) {
        return res.json({ challenge: req.body.challenge });
      }
      // 其他事件：当前 P0 阶段仅 ACK，P4 阶段接入评分 / 补齐证据按钮回调
      if (logger) logger("info", "bug-agent", `feishu event received: ${req.body?.type || "unknown"}`);
      res.json({ ok: true });
    }
  );

  return router;
}

function safeParseJson(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}
