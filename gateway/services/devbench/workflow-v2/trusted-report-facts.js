import { canonicalSha256, readWorkflowV2Envelopes } from "./envelope-store.js";
import { WORKFLOW_V2_SCHEMA_IDS, workflowV2SchemaRegistry } from "./schema-registry.js";
import { WORKFLOW_V2_GIT_SETTLEMENT_SCHEMA_VERSION } from "./repair-commit-settlement.js";

const TRUSTED_REPAIR_FACTS = Symbol("workflow-v2-trusted-repair-facts");
const REPAIR_STAGE_ID = "REPAIR";

export class WorkflowV2TrustedReportFactsError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "WorkflowV2TrustedReportFactsError";
    this.code = code;
    this.details = details;
  }
}

function fail(message, code, details = {}) {
  throw new WorkflowV2TrustedReportFactsError(message, code, details);
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

export function isGenericShortReportFact(value) {
  const text = String(value || "").replace(/[\s，。！？、：:；;]/g, "");
  return /^(原因|措施|暂无|无|待定|未知|不清楚|同上|参考(?:上述|上文|前文)|已说明)$/i.test(text)
    || /^(?:问题|根因|方案|修复)?(?:已)?(?:定位|解决|修复|处理|完成|查明|确认|说明|见上)$/i.test(text);
}

function assertSpecificFact(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized || Array.from(normalized).length < 2 || isGenericShortReportFact(normalized)) {
    fail(`可信 REPAIR 结果缺少具体${label}`, "WORKFLOW_V2_REPORT_FACTS_INCOMPLETE", { label });
  }
  if(/[\r\n\u0000-\u001f\u007f]/u.test(normalized)) {
    fail(`可信 REPAIR ${label} 含控制字符`, "WORKFLOW_V2_REPORT_FACTS_INVALID", { label });
  }
  return normalized;
}

function assertAcceptedRepairRecord(envelope, storyId) {
  const payload = envelope?.payload;
  try {
    workflowV2SchemaRegistry.assertValid(WORKFLOW_V2_SCHEMA_IDS.stageResultRecord, payload, "trusted repair stage-result");
  } catch (error) {
    fail("REPAIR stage-result record 不符合 Schema", "WORKFLOW_V2_REPORT_FACTS_RECORD_INVALID", {
      causeCode: String(error?.code || ""),
    });
  }
  if (envelope?.storyId !== storyId
    || payload.storyId !== storyId
    || envelope.payloadSchemaId !== WORKFLOW_V2_SCHEMA_IDS.stageResultRecord
    || envelope.recordId !== "stage-result"
    || envelope.contextId !== null
    || envelope.revision !== payload.recordRevision
    || payload.stageId !== REPAIR_STAGE_ID
    || payload.resultSchemaId !== WORKFLOW_V2_SCHEMA_IDS.repairResult
    || payload.resultSha256 !== canonicalSha256(payload.result)) {
    fail("REPAIR stage-result record 身份或摘要不可信", "WORKFLOW_V2_REPORT_FACTS_RECORD_INVALID");
  }

  const result = payload.result;
  if (result.status !== "COMPLETED"
    || result.outcome !== "FIXED"
    || result.nextStage !== "LOCAL_GATE"
    || !Array.isArray(result.changes)
    || result.changes.length === 0
    || !Array.isArray(result.localChecks)
    || result.localChecks.length === 0
    || result.changes.some((entry) => !String(entry?.rootId || "").trim()
      || !String(entry?.path || "").trim()
      || !String(entry?.summary || "").trim()
      || !Array.isArray(entry?.receiptIds)
      || entry.receiptIds.length === 0)
    || result.localChecks.some((entry) => !String(entry?.name || "").trim()
      || entry.status !== "PASS"
      || !Array.isArray(entry?.receiptIds)
      || entry.receiptIds.length === 0)) {
    fail("REPAIR stage-result 未满足已 receipt-gated 接受的修复条件", "WORKFLOW_V2_REPORT_FACTS_REPAIR_NOT_ACCEPTED");
  }
  return { payload, result };
}

function gitSettlementBinding(settlement) {
  return {
    schemaVersion: settlement?.schemaVersion,
    storyId: settlement?.storyId,
    stageId: settlement?.stageId,
    contextId: settlement?.contextId,
    contextRevision: settlement?.contextRevision,
    contextIdempotencyKey: settlement?.contextIdempotencyKey,
    resultSha256: settlement?.resultSha256,
    rootId: settlement?.rootId,
    repositoryId: settlement?.repositoryId,
    expectedHead: settlement?.expectedHead,
    expectedBranch: settlement?.expectedBranch,
    targetFlavor: settlement?.targetFlavor,
    changeSummary: settlement?.changeSummary,
    declaredChanges: settlement?.declaredChanges,
    requiredCheckReceiptIds: settlement?.requiredCheckReceiptIds,
    editStateSha256: settlement?.editStateSha256,
    editStateVersionSha256: settlement?.editStateVersionSha256,
    editReceiptIds: settlement?.editReceiptIds,
  };
}

function assertCommittedRepairSettlement(tab, payload) {
  const settlement = tab?.workflowV2Compatibility?.gitSettlement;
  const commitSha = String(settlement?.commitSha || "").trim().toLowerCase();
  const binding = gitSettlementBinding(settlement);
  if (!settlement
    || settlement.schemaVersion !== WORKFLOW_V2_GIT_SETTLEMENT_SCHEMA_VERSION
    || settlement.status !== "COMMITTED"
    || settlement.storyId !== payload.storyId
    || settlement.stageId !== REPAIR_STAGE_ID
    || settlement.contextId !== payload.contextId
    || settlement.contextRevision !== payload.contextRevision
    || settlement.contextIdempotencyKey !== payload.contextIdempotencyKey
    || settlement.resultSha256 !== payload.resultSha256
    || settlement.bindingSha256 !== canonicalSha256(binding)
    || !/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(commitSha)
    || !String(settlement.operationId || "").startsWith("workflow-v2-repair-commit:")
    || !Array.isArray(settlement.declaredChanges)
    || settlement.declaredChanges.length === 0
    || !Array.isArray(settlement.requiredCheckReceiptIds)
    || settlement.requiredCheckReceiptIds.length === 0
    || !/^[a-f0-9]{64}$/.test(String(settlement.editStateSha256 || ""))
    || !/^[a-f0-9]{64}$/.test(String(settlement.editStateVersionSha256 || ""))
    || !Array.isArray(settlement.editReceiptIds)
    || settlement.editReceiptIds.length === 0) {
    fail(
      "REPAIR stage-result 尚未绑定已完成的权威 Git 结算",
      "WORKFLOW_V2_REPORT_FACTS_GIT_SETTLEMENT_MISSING",
    );
  }
  const repositoryId = String(settlement.repositoryId || "").trim();
  const entries = Array.isArray(tab?.worktree?.entries) ? tab.worktree.entries : [];
  const matches = entries.filter((entry) => (
    [entry?.repositoryId, entry?.baseProjectId, entry?.projectId]
      .some((value) => String(value || "").trim() === repositoryId)
    && String(entry?.branch || "").trim() === settlement.expectedBranch
    && String(entry?.revision || entry?.head || "").trim().toLowerCase() === commitSha
    && String(entry?.head || "").trim().toLowerCase() === commitSha
  ));
  if (matches.length !== 1) {
    fail(
      "权威 Git 结算与当前故事 worktree HEAD 不一致",
      "WORKFLOW_V2_REPORT_FACTS_GIT_SETTLEMENT_STALE",
      { repositoryId, matches: matches.length },
    );
  }
  return settlement;
}

function freezeTrustedFacts({ storyId, payload, result, settlement, cause, measure }) {
  const facts = {
    source: "workflow-v2/structured-repair-stage-result",
    storyId,
    stageId: REPAIR_STAGE_ID,
    recordRevision: payload.recordRevision,
    contextId: payload.contextId,
    contextRevision: payload.contextRevision,
    resultSha256: payload.resultSha256,
    gitCommitSha: settlement.commitSha,
    gitOperationId: settlement.operationId,
    cause,
    measure,
  };
  Object.defineProperty(facts, TRUSTED_REPAIR_FACTS, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: true,
  });
  return deepFreeze(facts);
}

/**
 * 从当前故事 append-only stage-result 流中取得最新、已经过 REPAIR 结果门禁
 * 后才会被记录的事实。此函数刻意不读取 tab.workflow.fixShortReport 等 legacy
 * 字段，避免旧文本进入 v2 确定性短报告路径。
 */
export async function loadTrustedRepairReportFacts({
  tab,
  readEnvelopes = readWorkflowV2Envelopes,
} = {}) {
  const storyId = String(tab?.id || "").trim();
  if (!storyId || typeof readEnvelopes !== "function") {
    fail("缺少当前故事或可信 stage-result reader", "WORKFLOW_V2_REPORT_FACTS_SOURCE_MISSING");
  }
  let records;
  try {
    records = await readEnvelopes({ tab, payloadSchemaId: WORKFLOW_V2_SCHEMA_IDS.stageResultRecord });
  } catch (error) {
    fail("读取可信 REPAIR stage-result 失败", "WORKFLOW_V2_REPORT_FACTS_READ_FAILED", {
      causeCode: String(error?.code || ""),
    });
  }
  if (!Array.isArray(records)) {
    fail("可信 stage-result reader 未返回数组", "WORKFLOW_V2_REPORT_FACTS_READ_FAILED");
  }
  const repairs = records
    .filter((entry) => entry?.payload?.stageId === REPAIR_STAGE_ID)
    .sort((left, right) => Number(right?.payload?.recordRevision || 0) - Number(left?.payload?.recordRevision || 0));
  if (!repairs.length) {
    fail("当前故事没有已接受的结构化 REPAIR stage-result", "WORKFLOW_V2_REPORT_FACTS_SOURCE_MISSING", { storyId });
  }
  const { payload, result } = assertAcceptedRepairRecord(repairs[0], storyId);
  const settlement = assertCommittedRepairSettlement(tab, payload);
  const cause = assertSpecificFact(result.userFriendlyCause, "原因");
  const measure = assertSpecificFact(result.userFriendlyMeasure, "措施");
  return freezeTrustedFacts({ storyId, payload, result, settlement, cause, measure });
}

/** 仅供同一进程内的确定性渲染器确认事实来源，不能由 JSON/legacy 文本伪造。 */
export function assertTrustedRepairReportFacts(reportFacts) {
  if (!reportFacts || typeof reportFacts !== "object" || reportFacts[TRUSTED_REPAIR_FACTS] !== true
    || !Object.isFrozen(reportFacts)
    || reportFacts.source !== "workflow-v2/structured-repair-stage-result"
    || reportFacts.stageId !== REPAIR_STAGE_ID
    || !String(reportFacts.storyId || "").trim()
    || !Number.isSafeInteger(reportFacts.recordRevision)
    || reportFacts.recordRevision < 1
    || !/^[a-f0-9]{64}$/.test(String(reportFacts.resultSha256 || ""))
    || !/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(String(reportFacts.gitCommitSha || ""))
    || !String(reportFacts.gitOperationId || "").startsWith("workflow-v2-repair-commit:")) {
    fail("REPORT_SHORT 只接受当前故事已 receipt-gated 的 REPAIR facts", "WORKFLOW_V2_REPORT_FACTS_UNTRUSTED");
  }
  return Object.freeze({
    cause: assertSpecificFact(reportFacts.cause, "原因"),
    measure: assertSpecificFact(reportFacts.measure, "措施"),
  });
}
