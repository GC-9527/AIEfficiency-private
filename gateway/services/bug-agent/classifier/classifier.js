/**
 * 分类 orchestrator（方案 §5 STEP 1-9 精简版，P0 MVP 阶段）
 *
 * 当前实现范围：
 *   STEP 1 输入校验 + 幂等
 *   STEP 2 证据归档（简化：整份 raw_content 作一条 evidence）
 *   STEP 3 结构化字段抽取（基本正则）
 *   STEP 5 决策表硬判定（三门控占位，P1d' 会完善）
 *   STEP 7 LLM 分类（safeCallLlm）
 *   STEP 8 报告落盘
 *
 * 尚未覆盖（后续阶段）：
 *   STEP 4 L1 会话记忆
 *   STEP 5b 两阶段召回
 *   STEP 5.4 证据回查三层归一化（P1d'）
 *   STEP 5.5 归属解析器（P1d'）
 *   STEP 6 记忆树下钻（P2a）
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { buildPrompt } from "../llm/prompt-builder.js";
import { detectPromptInjection } from "../llm/injection-detector.js";
import { safeCallLlm } from "../llm/safe-call.js";
import { resolveOwnership } from "../ingest/ownership-resolver.js";
import { verifyReasoning, adjustConfidence } from "./evidence-verifier.js";
import { resolveLeafNode, attachCaseToNode } from "../memory/tree-ops.js";
import { recordLlmCost, checkBudget } from "../ops/llm-budget.js";
import {
  insertCase,
  insertEvidence,
  insertReport,
  updateCaseClassification,
  findCaseByTbId,
  upsertTaskState,
  findTaskByTbId,
} from "../storage/db.js";

// ---------- utility ----------

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}
function nowUtc() {
  return new Date().toISOString();
}

function archiveContent(storage, content, ext = "txt") {
  const hash = sha256(content);
  if (storage.inMemory) {
    return { sha256: hash, archived_path: `inmem://${hash}.${ext}` };
  }
  const month = new Date().toISOString().slice(0, 7);
  const dir = path.join(storage.root, "archive", month);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${hash}.${ext}`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, content);
  return { sha256: hash, archived_path: file };
}

// ---------- STEP 3 结构化抽取（精简版） ----------

const STRUCT_EXTRACTORS = {
  exception_class: [
    /Exception|Error"?\s*:?\s*([a-zA-Z_][\w$.]+(?:Exception|Error))/,
    /^\s*([a-zA-Z_][\w$.]+(?:Exception|Error))\b/m,
  ],
  signal: [/signal\s+(\d+)\s+\(SIG\w+\)/],
  error_code: [/errno\s*=?\s*(-?\d+)/, /\berror\s+code[:\s]+(-?\d+)/i],
  log_tag: [/\b[EWVID]\/([A-Za-z_][\w-]*)\s*\(/],
  process_name: [/Process:\s*([a-zA-Z_][\w.]*)/, /com\.\w+(?:\.\w+)+/],
};

function extractStructured(text) {
  const out = {};
  for (const [key, patterns] of Object.entries(STRUCT_EXTRACTORS)) {
    for (const p of patterns) {
      const m = text.match(p);
      if (m) {
        out[key] = m[1] || m[0];
        break;
      }
    }
  }
  return out;
}

// ---------- STEP 5 决策表三门控（占位实现，P1d' 由 priority-rules.js 完全取代） ----------

import { evalPriorityRules } from "./priority-rules.js";

// ---------- 主 orchestrator ----------

/**
 * @param {Object} input
 * @param {string} input.tb_id
 * @param {string} input.package_name
 * @param {string} input.title
 * @param {string} input.raw_content
 * @param {string} [input.log_attachment] - 整份日志文本
 * @param {string} [input.reporter_id]
 * @param {Object} [ctx]
 * @param {BugAgentStorage} ctx.storage
 * @param {Object} [ctx._deps] - 测试替身
 */
export async function analyzeTbCase(input, ctx) {
  const { storage, _deps = {} } = ctx;
  if (!storage) throw new Error("ctx.storage required");

  const task_id = _deps.task_id || crypto.randomUUID();
  const t_start = nowUtc();

  // ---- STEP 1 校验 + 幂等 ----
  if (!input.tb_id || !input.package_name || !input.title || !input.raw_content) {
    const e = new Error("missing required field (tb_id/package_name/title/raw_content)");
    e.code = "VALIDATION";
    throw e;
  }

  const existingTask = findTaskByTbId(storage, input.tb_id);
  if (existingTask && existingTask.status === "succeeded") {
    return { task_id: existingTask.task_id, idempotent: true, result: existingTask.result_ref };
  }

  upsertTaskState(storage, {
    task_id, tb_id: input.tb_id, status: "running", progress: 0.1,
    started_at: t_start, updated_at: t_start,
  });

  // Prompt 注入预检
  const injection = detectPromptInjection(`${input.title}\n${input.raw_content}`);
  const suspicious = injection.suspicious;

  // 结构化字段抽取
  const structured = extractStructured([input.title, input.raw_content, input.log_attachment || ""].join("\n"));

  // ---- 插入 case + case_catalog ----
  let caseInfo;
  try {
    caseInfo = insertCase(storage, {
      ...input,
      ...structured,
      suspicious_prompt_injection: suspicious,
      source_time: null,
    });
  } catch (e) {
    // tb_id 冲突（另一个分析已落盘）：重查
    const again = findCaseByTbId(storage, input.tb_id);
    if (again) {
      caseInfo = { case_id: again.case.id, db_path: again.catalog.db_path };
    } else {
      throw e;
    }
  }
  const case_id = caseInfo.case_id;

  // ---- STEP 2 证据归档（含 §5.5 归属解析） ----
  const evidenceIds = [];
  const evidencesInMemory = []; // 给后续决策表/LLM/回查复用

  function ingest(source_type, content, source_type_for_archive) {
    const archived = archiveContent(storage, content, source_type_for_archive || "txt");
    const spans = resolveOwnership({ source_type, content, case_package: input.package_name });
    for (const span of spans) {
      const id = insertEvidence(storage, input.package_name, {
        case_id,
        source_type,
        source_sha256: archived.sha256,
        archived_path: archived.archived_path,
        line_start: span.line_start,
        line_end: span.line_end,
        text_snapshot: (span.text_snapshot || "").slice(0, 8000),
        tag: span.tag,
        owner_package: span.owner_package,
        ownership_confidence: span.ownership_confidence,
      });
      evidenceIds.push(id);
      evidencesInMemory.push({
        id,
        source_type,
        text_snapshot: span.text_snapshot || "",
        owner_package: span.owner_package,
        ownership_confidence: span.ownership_confidence,
      });
    }
  }

  ingest("tb_content", input.raw_content, "txt");
  if (input.log_attachment) ingest("logcat", input.log_attachment, "log");
  if (input.anr_trace) ingest("anr_trace", input.anr_trace, "anr");
  if (input.dumpsys) ingest("dumpsys", input.dumpsys, "dump");
  if (input.systrace) ingest("systrace", input.systrace, "trace");

  // ---- STEP 5 决策表 ----
  const evidences = evidencesInMemory;

  const ruleResult = evalPriorityRules({
    tb_text: `${input.title}\n${input.raw_content}`,
    evidences: evidences.map((e) => ({
      ...e,
      owner_package: e.owner_package || input.package_name,
      ownership_confidence: 1.0,
    })),
    case_package: input.package_name,
  });

  let classification;
  let reason_from;
  let llm_usage = null;
  let is_degraded = false;
  let weak_hints = [];

  if (ruleResult.hit) {
    // Fast path：三门全过
    classification = {
      category: ruleResult.rule.target_category,
      sub_category: ruleResult.rule.target_sub_category,
      confidence: ruleResult.rule.base_confidence,
      reasoning_steps: [{
        claim: `决策表命中 ${ruleResult.rule.id}`,
        evidence_refs: evidenceIds.map((i) => `e:${i}`),
      }],
    };
    reason_from = "rule";
  } else {
    weak_hints = ruleResult.weak_hints || [];
    // ---- STEP 7 LLM ----
    const prompt = buildPrompt({
      tb_title: input.title,
      tb_body: input.raw_content,
      evidences: evidences.map((e, i) => ({
        id: evidenceIds[i],
        source_type: e.source_type,
        text_snapshot: e.text_snapshot?.slice(0, 4000) || "",
      })),
      rules: weak_hints,
    });

    // §11.5 预算熔断：超限直接降级
    const budget = checkBudget(storage);
    const llmCall = _deps.safeCallLlm || safeCallLlm;
    const r = budget.over_limit
      ? { ok: true, degraded: true, reason: "DAILY_BUDGET_EXCEEDED",
          data: {
            category: weak_hints[0]?.target_category || "其他",
            sub_category: weak_hints[0]?.target_sub_category || "待归类",
            confidence: 0.4,
            reasoning_steps: [{ claim: "预算熔断降级", evidence_refs: ["degraded:budget"] }],
          },
          attempts: 0 }
      : await llmCall({ prompt, weak_hints });

    if (!r.ok) {
      upsertTaskState(storage, {
        task_id, tb_id: input.tb_id, status: "failed", progress: 1.0,
        error_code: r.error_code, raw_output: r.raw_output,
        attempt: r.attempts, updated_at: nowUtc(),
      });
      return { task_id, ok: false, error_code: r.error_code };
    }
    classification = r.data;
    is_degraded = !!r.degraded;
    reason_from = is_degraded ? `degraded:${r.reason}` : "llm";
    llm_usage = r.usage || null;

    // §5.4 三层归一化回查
    const verify = verifyReasoning({
      reasoning_steps: classification.reasoning_steps,
      evidences: evidencesInMemory,
    });
    classification._verify = verify;
    classification.confidence = adjustConfidence(classification.confidence, verify);

    // §11.5 记录 LLM 成本
    if (llm_usage && llm_usage.input_tokens != null) {
      recordLlmCost(storage, {
        tokens_in: llm_usage.input_tokens || 0,
        tokens_out: llm_usage.output_tokens || 0,
        degraded: is_degraded,
      });
    }
  }

  // ---- STEP 8 报告落盘 ----
  updateCaseClassification(storage, {
    package_name: input.package_name,
    case_id,
    category: classification.category,
    sub_category: classification.sub_category,
    confidence: classification.confidence,
  });

  const reportContent = buildReportMarkdown({
    input, classification, evidences, evidenceIds,
    is_degraded, reason_from, suspicious,
  });

  // §7.7 挂接 case → memory_tree 叶子节点（若已 seed）
  let matched_tree_nodes = null;
  try {
    const { db: appDb } = storage.resolveTargetDb(input.package_name);
    const leaf = resolveLeafNode(appDb, {
      category: classification.category,
      sub_category: classification.sub_category,
    });
    if (leaf) {
      attachCaseToNode(appDb, {
        node_id: leaf.id,
        case_id,
        node_version: leaf.version || 1,
      });
      matched_tree_nodes = [{ node_id: leaf.id, version: leaf.version || 1 }];
    }
  } catch (_e) {
    // 树未 seed 时跳过，不阻塞主流程
  }

  const report_id = insertReport(storage, input.package_name, {
    case_id,
    content: reportContent,
    evidence_refs: evidenceIds,
    matched_rules: ruleResult.hit ? [ruleResult.rule.id] : weak_hints.map((h) => h.id),
    matched_tree_nodes,
    decision_trace: { rule_result: ruleResult, reason_from, is_degraded, suspicious },
    is_degraded,
    status: "active",
  });

  upsertTaskState(storage, {
    task_id, tb_id: input.tb_id, status: "succeeded", progress: 1.0,
    result_ref: `report:${report_id}`,
    degraded: is_degraded,
    // 即便最终 status='succeeded'（走降级），也把降级 reason 写入 error_code，
    // 方便前端 /api/bug/task/:id 直接看到具体原因（NO_API_KEY / TIMEOUT / 等）
    error_code: is_degraded ? (reason_from.replace(/^degraded:/, "") || null) : null,
    updated_at: nowUtc(),
  });

  return {
    task_id, ok: true, case_id, report_id,
    classification, is_degraded, reason_from, usage: llm_usage,
  };
}

function buildReportMarkdown({ input, classification, evidences, evidenceIds, is_degraded, reason_from, suspicious }) {
  const degradedWarn = is_degraded
    ? "> ⚠️ **LLM 不可用，本报告为规则降级结果，建议人工复核**\n\n"
    : "";
  const suspiciousWarn = suspicious
    ? "> ⚠️ **检测到可疑 Prompt 注入特征，已标记审查**\n\n"
    : "";
  const steps = (classification.reasoning_steps || [])
    .map((s) => `- ${s.claim} ${s.evidence_refs.map((r) => `[${r}]`).join(" ")}`)
    .join("\n");

  return `# ${input.title}

${degradedWarn}${suspiciousWarn}- **TB**: ${input.tb_id}
- **包名**: ${input.package_name}
- **分类**: ${classification.category} / ${classification.sub_category}
- **置信度**: ${(classification.confidence * 100).toFixed(0)}%
- **判定来源**: ${reason_from}

## 推理链

${steps || "_(空)_"}

## 证据索引

${evidenceIds.map((id, i) => `- [e:${id}] ${evidences[i].source_type}`).join("\n")}
`;
}
