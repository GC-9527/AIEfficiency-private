/**
 * 数据保留闭环（方案 §4.5）
 *
 * 每周 cron：
 *   - cases.raw_content 超 3 年 → 脱敏（置空，保留元数据）
 *   - evidence_spans.text_snapshot 超 2 年 → 置空（保留 sha256）
 *   - reports 超 3 年 → 归档到 reports_archived 表（P 阶段：直接标 status='archived'）
 *   - session_memory 过期 → 物理删除（已在 session-memory.js 实现）
 *
 * legal_hold=1 的 case 不受保留期约束。
 */

const RETENTION_CASE_DAYS = 3 * 365;
const RETENTION_EVIDENCE_DAYS = 2 * 365;
const RETENTION_REPORT_DAYS = 3 * 365;

function isoDaysAgo(days, now = Date.now()) {
  return new Date(now - days * 86400_000).toISOString();
}

export function cronRetentionPurge(storage, { package_name, now, dry_run = false } = {}) {
  if (!package_name) throw new Error("package_name required");
  const { db } = storage.resolveTargetDb(package_name);
  const nowMs = now || Date.now();

  const caseCutoff = isoDaysAgo(RETENTION_CASE_DAYS, nowMs);
  const evCutoff = isoDaysAgo(RETENTION_EVIDENCE_DAYS, nowMs);
  const repCutoff = isoDaysAgo(RETENTION_REPORT_DAYS, nowMs);

  const stats = { cases_scrubbed: 0, evidence_scrubbed: 0, reports_archived: 0, dry_run };

  const selectCases = db.prepare(
    "SELECT id FROM cases WHERE legal_hold=0 AND created_at < ? AND raw_content != ''"
  ).all(caseCutoff);
  const scrubCase = db.prepare("UPDATE cases SET raw_content='' WHERE id=?");

  const selectEv = db.prepare(
    "SELECT id FROM evidence_spans WHERE ingested_at < ? AND text_snapshot != ''"
  ).all(evCutoff);
  const scrubEv = db.prepare("UPDATE evidence_spans SET text_snapshot='' WHERE id=?");

  const selectReports = db.prepare(
    "SELECT id FROM reports WHERE created_at < ? AND status != 'archived'"
  ).all(repCutoff);
  const archiveReport = db.prepare("UPDATE reports SET status='archived' WHERE id=?");

  if (dry_run) {
    return {
      cases_scrubbed: selectCases.length,
      evidence_scrubbed: selectEv.length,
      reports_archived: selectReports.length,
      dry_run: true,
    };
  }

  const tx = db.transaction(() => {
    for (const r of selectCases) { scrubCase.run(r.id); stats.cases_scrubbed++; }
    for (const r of selectEv) { scrubEv.run(r.id); stats.evidence_scrubbed++; }
    for (const r of selectReports) { archiveReport.run(r.id); stats.reports_archived++; }
  });
  tx();

  return stats;
}
