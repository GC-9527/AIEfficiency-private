import { createHash } from "node:crypto";

export const DEFAULT_PROMPT_V2_ROLLOUT = Object.freeze({
  percentage: 100,
  salt: "tb-workflow-prompt-v2",
  storyIds: Object.freeze([]),
  providers: Object.freeze([]),
});

function normalizedList(value, { lowerCase = false } = {}) {
  const entries = value
    .map((entry) => String(entry || "").trim())
    .filter(Boolean)
    .map((entry) => lowerCase ? entry.toLowerCase() : entry);
  return [...new Set(entries)].sort();
}

export function normalizePromptV2Rollout(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  let valid = value === undefined || (value && typeof value === "object" && !Array.isArray(value));
  const allowedKeys = new Set(["percentage", "salt", "storyIds", "providers", "valid"]);
  if (Object.keys(source).some((key) => !allowedKeys.has(key))) valid = false;
  if (Object.prototype.hasOwnProperty.call(source, "valid") && typeof source.valid !== "boolean") valid = false;
  if (source.valid === false) valid = false;
  const percentageSpecified = Object.prototype.hasOwnProperty.call(source, "percentage");
  const saltSpecified = Object.prototype.hasOwnProperty.call(source, "salt");
  const storyIdsSpecified = Object.prototype.hasOwnProperty.call(source, "storyIds");
  const providersSpecified = Object.prototype.hasOwnProperty.call(source, "providers");
  if (percentageSpecified && (!Number.isSafeInteger(source.percentage) || source.percentage < 0 || source.percentage > 100)) valid = false;
  if (saltSpecified && (typeof source.salt !== "string" || !source.salt.trim() || source.salt.trim().length > 128)) valid = false;
  if (storyIdsSpecified && !Array.isArray(source.storyIds)) valid = false;
  if (providersSpecified && !Array.isArray(source.providers)) valid = false;
  if (Array.isArray(source.storyIds) && source.storyIds.some((entry) => typeof entry !== "string")) valid = false;
  if (Array.isArray(source.providers) && source.providers.some((entry) => typeof entry !== "string")) valid = false;
  const percentage = valid
    ? (percentageSpecified ? source.percentage : DEFAULT_PROMPT_V2_ROLLOUT.percentage)
    : 0;
  const salt = valid && saltSpecified
    ? source.salt.trim()
    : DEFAULT_PROMPT_V2_ROLLOUT.salt;
  return {
    valid,
    percentage,
    salt,
    storyIds: valid && storyIdsSpecified ? normalizedList(source.storyIds) : [],
    providers: valid && providersSpecified ? normalizedList(source.providers, { lowerCase: true }) : [],
  };
}

function stableBucket(storyId, provider, salt) {
  const digest = createHash("sha256")
    .update(`${salt}\u0000${storyId}\u0000${provider}`, "utf8")
    .digest();
  return digest.readUInt32BE(0) % 100;
}

export function resolvePromptV2Rollout({ config, storyId, provider } = {}) {
  const id = String(storyId || "").trim();
  const engine = String(provider || "").trim().toLowerCase();
  const enabled = config?.workflowV2?.featureFlags?.promptV2 === true;
  const rollout = normalizePromptV2Rollout(config?.workflowV2?.promptV2Rollout);
  const bucket = id && engine ? stableBucket(id, engine, rollout.salt) : null;
  let reason = "enabled";
  let selected = enabled;
  if (!enabled) reason = "feature_flag_disabled";
  else if (!rollout.valid) { selected = false; reason = "rollout_config_invalid"; }
  else if (!id || !engine) { selected = false; reason = "identity_missing"; }
  else if (rollout.storyIds.length && !rollout.storyIds.includes(id)) { selected = false; reason = "story_not_allowlisted"; }
  else if (rollout.providers.length && !rollout.providers.includes(engine)) { selected = false; reason = "provider_not_allowlisted"; }
  else if (bucket >= rollout.percentage) { selected = false; reason = "outside_percentage"; }
  return {
    selected,
    reason,
    bucket,
    percentage: rollout.percentage,
    storyId: id,
    provider: engine,
  };
}

export function resolveCompatibilityStage({ tab, workflowKind = "", reportMode = "" } = {}) {
  const kind = String(workflowKind || "").trim().toLowerCase();
  if (kind === "code_review"
    || tab?.workMode === "code_review"
    || tab?.reviewContext?.kind === "git_commit") return null;
  if (kind === "triage") return "TRIAGE";
  if (kind === "repair" || kind === "fix") return "REPAIR";
  if (kind === "verify") return "VERIFY_EXECUTE";
  if (kind === "report") return String(reportMode || tab?.reportMode || "short").toLowerCase() === "expert"
    ? "REPORT_EXPERT"
    : "REPORT_SHORT";
  const phase = String(tab?.workflow?.phase || "").trim().toLowerCase();
  // A user-authored chat/follow-up is an independent turn. It must keep the
  // story/project/device context. REPAIR remains actionable, while a stale
  // triage/verify/report phase must not replace the user's current instruction.
  if (kind === "chat" || kind === "follow_up") {
    return phase === "fixing" || phase === "group_fixed" ? "REPAIR" : null;
  }
  // workflow.phase 决定当前回合属于哪一阶段。verify_blocked / verifying 是同一条 verify 阶段
  // 断点（设备未绑定或正在验收中），与显式 kind=verify 同享 VERIFY_EXECUTE 精简模板；
  // reporting 的两个变体由 reportMode 二次区分；group_fixed 与 fixing 同属修复完成段。
  if (phase === "fixing" || phase === "group_fixed") return "REPAIR";
  if (phase === "verifying" || phase === "verify_blocked") return "VERIFY_EXECUTE";
  if (phase === "reporting") {
    return String(reportMode || tab?.reportMode || "short").toLowerCase() === "expert"
      ? "REPORT_EXPERT"
      : "REPORT_SHORT";
  }
  return null;
}
