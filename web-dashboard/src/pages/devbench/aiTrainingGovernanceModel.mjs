const text = (value) => String(value ?? "").trim();
const object = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});
const epoch = (value) => {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && text(value)) return numeric;
  const parsed = Date.parse(text(value));
  return Number.isFinite(parsed) ? parsed : 0;
};

export const SOURCE_COVERAGE_DEFINITIONS = Object.freeze([
  { key: "manual", label: "人工输入", defaultRequired: false },
  { key: "detail", label: "TB 详情", defaultRequired: false },
  { key: "note", label: "TB 备注", defaultRequired: false },
  { key: "comments", label: "TB 评论", defaultRequired: false },
  { key: "attachments", label: "TB 附件", defaultRequired: false },
  { key: "tags", label: "TB 标签", defaultRequired: false },
]);

export const KNOWLEDGE_SCOPES = Object.freeze([
  { value: "global", label: "全局共享", shared: true, needsId: false },
  { value: "project", label: "项目共享", shared: true, needsId: true },
  { value: "environment", label: "环境共享", shared: true, needsId: true },
  { value: "node", label: "本机绑定", shared: false, needsId: false },
  { value: "user", label: "用户私有", shared: false, needsId: true },
  { value: "task", label: "故事点覆盖", shared: true, needsId: true },
]);

const GOVERNANCE_STATUS_ALIASES = Object.freeze({
  pending: "annotation",
  submitted: "annotation",
  draft: "annotation",
  annotated: "annotation",
  rejected: "revoked",
  superseded: "revoked",
  retired: "revoked",
  serving: "active",
  published: "active",
});

export const GOVERNANCE_STATUS_META = Object.freeze({
  unreviewed: { label: "待标注", tone: "text-amber-300", border: "border-amber-900/60 bg-amber-950/25" },
  annotation: { label: "Annotation · 待审批", tone: "text-cyan-300", border: "border-cyan-900/60 bg-cyan-950/25" },
  approved: { label: "Approved · 已审批", tone: "text-emerald-300", border: "border-emerald-900/60 bg-emerald-950/25" },
  active: { label: "Active · 已生效", tone: "text-violet-300", border: "border-violet-900/60 bg-violet-950/25" },
  revoked: { label: "Revoked · 已撤销", tone: "text-rose-300", border: "border-rose-900/60 bg-rose-950/25" },
});

function sourceCoverageObject(session = {}) {
  const candidates = [
    session?.sourceCoverage,
    session?.ticket?.sourceCoverage,
    session?.prediction?.sourceCoverage,
    session?.inputSnapshot?.sourceCoverage,
    session?.snapshot?.sourceCoverage,
  ];
  for (const candidate of candidates) {
    const coverage = object(candidate);
    if (Object.keys(coverage).length) return coverage;
  }
  return {};
}

function requiredSourceKeys(session = {}, coverage = {}) {
  const configuredSources = [
    session?.sourceCoverageGate?.required,
    session?.sourceCoverageGate?.requiredSources,
    session?.sourceGate?.required,
    session?.sourceGate?.requiredSources,
    session?.sourceCoverageGate?.missingRequired,
    session?.sourceGate?.missingRequired,
    session?.prediction?.policy?.requiredSources,
    session?.policy?.requiredSources,
    coverage.requiredSources,
  ];
  const hasExplicitPolicy = configuredSources.some(Array.isArray)
    || session?.sourceCoverageGate?.applicable === false;
  const configured = configuredSources
    .flatMap((value) => Array.isArray(value) ? value : [])
    .map(text)
    .filter(Boolean);
  for (const [key, row] of Object.entries(coverage)) {
    if (object(row).required === true) configured.push(key);
  }
  if (hasExplicitPolicy || configured.length) return new Set(configured);
  return new Set(Object.keys(coverage).length ? SOURCE_COVERAGE_DEFINITIONS.filter((row) => row.defaultRequired).map((row) => row.key) : []);
}

function sourceState(raw = {}) {
  const explicit = text(raw.status).toLowerCase();
  if (["complete", "partial", "failed", "missing"].includes(explicit)) return explicit;
  if (raw.available === false) return "failed";
  if (raw.available === true && raw.complete === false) return "partial";
  if (raw.available === true) return "complete";
  return "missing";
}

export function sourceCoverageRows(session = {}) {
  const coverage = sourceCoverageObject(session);
  const required = requiredSourceKeys(session, coverage);
  const definitions = [...SOURCE_COVERAGE_DEFINITIONS];
  for (const [key, value] of Object.entries(coverage)) {
    if (!Object.keys(object(value)).length) continue;
    if (!definitions.some((row) => row.key === key)) definitions.push({ key, label: key, defaultRequired: false });
  }
  return definitions.map((definition) => {
    const raw = object(coverage[definition.key]);
    const state = sourceState(raw);
    const count = Number(raw.count);
    return {
      ...definition,
      raw,
      state,
      required: required.has(definition.key),
      count: Number.isFinite(count) ? count : null,
      message: text(raw.error || raw.message),
      source: text(raw.source),
    };
  });
}

export function configInferenceSourceGate(session = {}, decision = "correct") {
  const coverage = sourceCoverageObject(session);
  const backendGate = object(session?.sourceCoverageGate || session?.sourceGate);
  const hasSnapshot = Object.keys(coverage).length > 0
    || backendGate.applicable === true
    || typeof backendGate.passed === "boolean"
    || Array.isArray(backendGate.missingRequired)
    || Array.isArray(backendGate.required)
    || Array.isArray(backendGate.requiredSources);
  const rows = sourceCoverageRows(session);
  const incompleteRows = hasSnapshot
    ? rows.filter((row) => (
        row.state !== "complete"
        && (backendGate.applicable !== false || Object.prototype.hasOwnProperty.call(coverage, row.key))
      ))
    : [];
  if (backendGate.passed === false && !incompleteRows.some((row) => row.key === "backend_gate")) {
    incompleteRows.push({
      key: "backend_gate",
      label: "后端来源门禁",
      state: "failed",
      required: false,
      message: text(backendGate.error || backendGate.reason || "后端记录的来源采集不完整"),
    });
  }
  const warnings = hasSnapshot ? incompleteRows : rows;
  const positiveDecision = ["correct", "corrected"].includes(text(decision));
  return {
    hasSnapshot,
    rows,
    blockers: [],
    warnings,
    positiveDecision,
    allowed: true,
    advisoryOnly: true,
    status: !hasSnapshot ? "legacy" : warnings.length ? "warning" : "complete",
  };
}

const CONFIG_INFERENCE_CONFLICT_LABELS = Object.freeze({
  appName: "应用",
  vehicle: "车型",
  repositoryId: "Git 仓库",
  branch: "分支",
  flavor: "Flavor",
  applicationRepository: "应用与仓库组合",
});

function stableJsonText(value) {
  if (Array.isArray(value)) return `[${value.map(stableJsonText).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJsonText(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function orderedConflictTargets(targets = []) {
  return (Array.isArray(targets) ? targets : [])
    .map((target, index) => ({ target: object(target), index }))
    .sort((left, right) => {
      const explicitOrder = (row) => Number.isFinite(Number(row.target.order)) && Number(row.target.order) > 0
        ? Math.trunc(Number(row.target.order))
        : Number.POSITIVE_INFINITY;
      const rank = (target) => target.targetRole === "primary" ? 0 : target.targetRole === "standalone" ? 1 : 2;
      const leftOrder = explicitOrder(left);
      const rightOrder = explicitOrder(right);
      if (leftOrder !== rightOrder) return leftOrder < rightOrder ? -1 : 1;
      return rank(left.target) - rank(right.target) || left.index - right.index;
    })
    .map(({ target }, index) => ({
      appName: text(target.appName),
      vehicle: text(target.vehicle),
      repositoryId: text(target.repositoryId),
      branch: text(target.branch),
      flavor: text(target.flavor),
      targetRole: ["primary", "dependency", "standalone"].includes(text(target.targetRole))
        ? text(target.targetRole)
        : index === 0 ? "primary" : "dependency",
      repositoryOnly: target.repositoryOnly === true,
      order: index + 1,
    }));
}

export function configInferenceConflictTargetFingerprint(targets = []) {
  return stableJsonText(orderedConflictTargets(targets));
}

function configInferenceConflictItems(session = {}) {
  const conflicts = object(session?.prediction?.quality?.conflicts || session?.quality?.conflicts);
  const declared = Array.isArray(conflicts.items) ? conflicts.items : [];
  const fallbackDimensions = [
    ...(Array.isArray(conflicts.reviewDimensions) ? conflicts.reviewDimensions : []),
    ...(Array.isArray(conflicts.hardDimensions) ? conflicts.hardDimensions : []),
    ...(Array.isArray(conflicts.softDimensions) ? conflicts.softDimensions : []),
  ].map(text).filter(Boolean);
  const source = declared.length ? declared : [...new Set(fallbackDimensions)].map((dimension) => ({ dimension }));
  const seen = new Set();
  return source.flatMap((raw) => {
    const item = object(raw);
    const dimension = text(item.dimension);
    if (!dimension || item.resolutionRequired === false || seen.has(dimension)) return [];
    seen.add(dimension);
    const candidates = (Array.isArray(item.candidates) ? item.candidates : []).map((candidate) => {
      const row = object(candidate);
      return {
        value: text(row.value),
        sourceGroups: (Array.isArray(row.sourceGroups) ? row.sourceGroups : []).map(text).filter(Boolean),
        signalIds: (Array.isArray(row.signalIds) ? row.signalIds : []).map(text).filter(Boolean),
        keywords: (Array.isArray(row.keywords) ? row.keywords : []).map(text).filter(Boolean),
        highestPriority: Number(row.highestPriority) || 0,
      };
    }).filter((candidate) => candidate.value);
    return [{
      id: text(item.id || `source_conflict:${dimension}`),
      dimension,
      label: CONFIG_INFERENCE_CONFLICT_LABELS[dimension] || dimension,
      recommendedValue: text(item.recommendedValue),
      candidates,
    }];
  });
}

function conflictCurrentValue(targets, dimension) {
  const rows = orderedConflictTargets(targets);
  const anchor = rows.find((row) => row.targetRole === "primary")
    || rows.find((row) => row.targetRole === "standalone")
    || rows[0]
    || {};
  if (dimension === "applicationRepository") {
    return [anchor.appName, anchor.repositoryId].filter(Boolean).join(" / ");
  }
  return text(anchor[dimension]);
}

export function configInferenceConflictGate(session = {}, decision = "correct", resolutions = {}, targets = []) {
  const items = configInferenceConflictItems(session);
  const targetFingerprint = configInferenceConflictTargetFingerprint(targets);
  const submitted = object(resolutions);
  const rows = items.map((item) => {
    const resolution = object(submitted[item.dimension]);
    const resolved = text(decision) === "corrected"
      && resolution.acknowledged === true
      && text(resolution.targetFingerprint) === targetFingerprint;
    return {
      ...item,
      currentValue: conflictCurrentValue(targets, item.dimension),
      resolved,
    };
  });
  const positiveDecision = ["correct", "corrected"].includes(text(decision));
  const unresolved = positiveDecision ? rows.filter((row) => !row.resolved) : [];
  return {
    rows,
    unresolved,
    targetFingerprint,
    positiveDecision,
    requiresCorrection: positiveDecision && rows.length > 0,
    allowed: !positiveDecision || unresolved.length === 0,
  };
}

export function confidencePresentation(prediction = {}) {
  const calibration = object(prediction.calibration);
  const kind = text(prediction.confidenceKind || calibration.kind || calibration.status).toLowerCase();
  const calibratedValue = prediction.calibratedProbability;
  const hasCalibratedProbability = calibratedValue !== null
    && calibratedValue !== undefined
    && calibratedValue !== ""
    && Number.isFinite(Number(calibratedValue));
  // A method/status flag alone must never relabel a heuristic score as probability.
  const calibrated = hasCalibratedProbability;
  const raw = Number(calibrated
    ? calibratedValue
    : prediction.heuristicConfidence ?? prediction.confidenceScore ?? prediction.confidence);
  const value = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw > 1 ? raw / 100 : raw)) : null;
  return {
    calibrated,
    value,
    label: calibrated ? "校准正确概率" : "启发式匹配分",
    note: calibrated
      ? text(calibration.method || prediction.calibrationMethod || "已通过独立数据集校准")
      : ["calibrated", "probability", "isotonic", "platt"].includes(kind)
        ? "校准器未返回概率，本次仍按启发式分展示"
        : "未校准，不能解释为预测正确概率",
  };
}

function firstFinite(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number > 1 ? number / 100 : number;
  }
  return null;
}

export function trainingMetricSummary(metrics = {}) {
  return {
    humanAgreementRate: firstFinite(
      metrics.humanAgreementRate,
      metrics.reviewAgreementRate,
      metrics.exactAccuracy,
    ),
    targetGraphExactRate: firstFinite(
      metrics.targetGraphExactRate,
      metrics.orderedTargetGraphExactMatch,
      metrics.evaluation?.targetGraphExactRate,
    ),
    evaluatedCases: Number(metrics.evaluatedCases || metrics.evaluation?.cases || 0),
    coverage: firstFinite(metrics.evaluationCoverage, metrics.coverage, metrics.evaluation?.coverage),
    ece: firstFinite(metrics.ece, metrics.calibration?.ece, metrics.evaluation?.ece),
  };
}

function normalizedGovernanceStatus(value, fallback = "annotation") {
  const status = text(value).toLowerCase();
  const normalized = GOVERNANCE_STATUS_ALIASES[status] || status;
  return GOVERNANCE_STATUS_META[normalized] ? normalized : fallback;
}

export function annotationGovernance(run = {}) {
  const annotation = object(run.annotation || run.governance?.annotation || run.review?.annotation);
  const explicitStatus = annotation.status
    || run.governanceStatus
    || run.review?.governanceStatus
    || run.sample?.governanceStatus
    || run.sample?.status
    || run._learnedSample?.governanceStatus
    || run._learnedSample?.status;
  const status = explicitStatus
    ? normalizedGovernanceStatus(explicitStatus)
    : run.review
      ? "annotation"
      : "unreviewed";
  const id = text(
    annotation.id
    || run.annotationId
    || run.review?.annotationId
    || run.sample?.annotationId
    || run._learnedSample?.annotationId,
  );
  return {
    id,
    caseId: text(annotation.caseId || run.caseId || run.id),
    status,
    meta: GOVERNANCE_STATUS_META[status] || GOVERNANCE_STATUS_META.annotation,
    legacy: !!run.review && !explicitStatus,
    reason: text(annotation.reason || run.review?.governanceReason),
    updatedAt: epoch(annotation.updatedAt || run.review?.reviewedAt || run.updatedAt),
    canApprove: status === "annotation",
    canRevoke: ["annotation", "approved", "active"].includes(status),
    canRestore: status === "revoked",
  };
}

export function governanceSummary(data = {}) {
  const explicit = object(data.governance?.summary || data.governanceSummary);
  const counts = { annotation: 0, approved: 0, active: 0, revoked: 0, unreviewed: 0 };
  for (const run of Array.isArray(data.runs) ? data.runs : []) {
    counts[annotationGovernance(run).status]++;
  }
  return {
    annotation: Number(explicit.annotation ?? explicit.pendingApproval ?? counts.annotation) || 0,
    approved: Number(explicit.approved ?? counts.approved) || 0,
    active: Number(explicit.active ?? counts.active) || 0,
    revoked: Number(explicit.revoked ?? counts.revoked) || 0,
    unreviewed: Number(explicit.unreviewed ?? counts.unreviewed) || 0,
    release: text(data.governance?.activeRelease?.name || data.activeRelease?.name || explicit.release),
  };
}

export function evaluationSummary(data = {}) {
  const evaluation = object(
    data.evaluation?.latest
    || data.evaluations?.latest
    || data.governance?.evaluation
    || data.datasetEvaluation,
  );
  const metrics = object(evaluation.metrics);
  return {
    available: !!(evaluation.id || evaluation.datasetVersion || Object.keys(metrics).length),
    id: text(evaluation.id),
    datasetVersion: text(evaluation.datasetVersion || evaluation.dataset?.version),
    status: text(evaluation.status || "not_started"),
    cases: Number(evaluation.cases || metrics.cases || 0),
    targetGraphExactRate: firstFinite(metrics.targetGraphExactRate, metrics.orderedTargetGraphExactMatch),
    repositoryTop3Recall: firstFinite(metrics.repositoryTop3Recall, metrics.top3Recall),
    coverage: firstFinite(metrics.coverage),
    ece: firstFinite(metrics.ece),
    evaluatedAt: epoch(evaluation.evaluatedAt || evaluation.updatedAt),
  };
}

export function knowledgeScopeMeta(scope) {
  const value = text(typeof scope === "object" ? scope.type || scope.scope || scope.value : scope).toLowerCase() || "project";
  return KNOWLEDGE_SCOPES.find((row) => row.value === value) || KNOWLEDGE_SCOPES[1];
}

function knowledgeRevisionRows(binding = {}) {
  const modern = Array.isArray(binding.valueRevisions)
    ? binding.valueRevisions
    : Array.isArray(binding.revisions)
      ? binding.revisions
      : [];
  if (modern.length) {
    return modern.map((row) => ({
      ...object(row),
      id: text(row?.id),
      revision: Math.max(0, Math.trunc(Number(row?.revision) || 0)),
      actualValue: text(row?.actualValue ?? row?.value),
      status: normalizedGovernanceStatus(row?.status || "annotation"),
      scope: knowledgeScopeMeta(row?.scope),
      scopeId: text(row?.scopeId),
      reason: text(row?.reason),
      updatedAt: epoch(row?.updatedAt || row?.createdAt),
      updatedBy: text(row?.updatedBy || row?.reviewer || row?.createdBy),
    })).sort((left, right) => right.revision - left.revision);
  }
  return (Array.isArray(binding.history) ? binding.history : []).map((row) => ({
    id: text(row?.id),
    revision: Math.max(0, Math.trunc(Number(row?.revision) || 0)),
    actualValue: text(row?.actualValue ?? row?.to),
    previousActualValue: text(row?.previousActualValue ?? row?.from),
    status: "revoked",
    scope: knowledgeScopeMeta(binding.scope),
    scopeId: text(binding.scopeId),
    reason: text(row?.reason),
    updatedAt: epoch(row?.updatedAt || row?.at),
    updatedBy: text(row?.updatedBy || row?.reviewer || row?.by),
  })).sort((left, right) => right.revision - left.revision);
}

export function normalizeKnowledgeBinding(binding = {}, projectId = "") {
  const revisions = knowledgeRevisionRows(binding);
  const explicitActive = object(binding.activeValue || binding.activeRevision);
  const current = Object.keys(explicitActive).length
    ? {
        ...explicitActive,
        id: text(explicitActive.id),
        actualValue: text(explicitActive.actualValue ?? explicitActive.value),
        revision: Math.max(0, Math.trunc(Number(explicitActive.revision) || 0)),
        status: normalizedGovernanceStatus(explicitActive.status || "active"),
        scope: knowledgeScopeMeta(explicitActive.scope || binding.scope),
        scopeId: text(explicitActive.scopeId || binding.scopeId || projectId),
      }
    : revisions.find((row) => row.status === "active")
      || revisions[0]
      || {
        id: text(binding.valueId),
        actualValue: text(binding.actualValue),
        revision: Math.max(0, Math.trunc(Number(binding.revision) || 0)),
        status: text(binding.status) ? normalizedGovernanceStatus(binding.status) : "active",
        scope: knowledgeScopeMeta(binding.scope),
        scopeId: text(binding.scopeId || projectId),
      };
  const scope = current.scope || knowledgeScopeMeta(binding.scope);
  return {
    ...binding,
    keyId: text(binding.keyId),
    logicalKey: text(binding.logicalKey || binding.key || binding.id),
    current,
    actualValue: text(current.actualValue ?? binding.actualValue),
    revision: Math.max(0, Math.trunc(Number(binding.revision ?? current.revision) || 0)),
    status: current.status,
    revisions,
    scope,
    scopeId: current.scopeId || text(binding.scopeId || (scope.value === "project" ? projectId : "")),
    governanceV2: !!(binding.keyId || revisions.some((row) => row.id) || binding.governanceVersion >= 2),
  };
}

export function looksMachineLocalValue(value) {
  const raw = text(value);
  return /(?:^|[\s=;,(["'])(?:[a-z]:[\\/]|\\\\)/i.test(raw)
    || /^file:/i.test(raw)
    || /(?:^|[\s=;,(["'])\/(?!\/)[a-z0-9._-]+(?:\/[^\s;,<>"']+)+/i.test(raw);
}

export function validateKnowledgeDraft({ actualValue, scope = "project", scopeId = "", reason = "" } = {}) {
  const value = text(actualValue);
  const meta = knowledgeScopeMeta(scope);
  if (!value) return { ok: false, error: "实际值不能为空" };
  if (meta.needsId && !text(scopeId)) return { ok: false, error: `${meta.label}必须填写作用域 ID` };
  if (meta.value !== "node" && looksMachineLocalValue(value)) {
    return { ok: false, error: "共享作用域禁止保存盘符、UNC、用户目录等机器路径；请改用“本机绑定”" };
  }
  if (!text(reason)) return { ok: false, error: "治理变更必须填写原因" };
  return {
    ok: true,
    scope: meta.value,
    scopeId: text(scopeId),
    actualValue: value,
    reason: text(reason),
    localOnly: !meta.shared,
    machineBinding: meta.value === "node",
  };
}

export function keywordGovernanceStatus(mapping = {}) {
  const explicit = text(mapping.status).toLowerCase();
  if (["suggestion", "draft", "pending"].includes(explicit)) return "suggestion";
  if (["rejected", "retired", "revoked"].includes(explicit)) return "revoked";
  if (explicit === "approved") return "approved";
  if (explicit === "active") return "active";
  return text(mapping.category) && text(mapping.value) ? "active" : "suggestion";
}
