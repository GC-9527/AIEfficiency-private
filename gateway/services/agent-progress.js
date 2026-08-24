const MINUTE_MS = 60_000;

export const DEFAULT_API_MAX_TOOL_ITERATIONS = 80;
export const DEFAULT_AGENT_PROGRESS_POLICY = Object.freeze({
  meaningfulProgressWarningMs: 10 * MINUTE_MS,
  meaningfulProgressCancelMs: 60 * MINUTE_MS,
  apiActiveTurnMaxMs: 8 * 60 * MINUTE_MS,
  terminationVerifyMs: 15_000,
});

const AUTOMATIC_CONVERGENCE_CODES = new Set([
  "AI_NO_MEANINGFUL_PROGRESS",
  "API_AGENT_ACTIVE_TURN_TIMEOUT",
]);

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function minutesToMs(value, fallbackMs) {
  return Math.round(positiveNumber(value, fallbackMs / MINUTE_MS) * MINUTE_MS);
}

export function normalizeApiMaxToolIterations(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed === 15) {
    return DEFAULT_API_MAX_TOOL_ITERATIONS;
  }
  return Math.min(1000, Math.max(1, Math.floor(parsed)));
}

export function resolveAgentProgressPolicy(apiAgent = {}, overrides = {}) {
  const warningMs = positiveNumber(
    overrides.meaningfulProgressWarningMs,
    minutesToMs(apiAgent.meaningfulProgressWarningMinutes, DEFAULT_AGENT_PROGRESS_POLICY.meaningfulProgressWarningMs),
  );
  const requestedCancelMs = positiveNumber(
    overrides.meaningfulProgressCancelMs,
    minutesToMs(apiAgent.meaningfulProgressCancelMinutes, DEFAULT_AGENT_PROGRESS_POLICY.meaningfulProgressCancelMs),
  );
  const cancelMs = Math.max(warningMs + 1, requestedCancelMs);
  return Object.freeze({
    meaningfulProgressWarningMs: Math.round(warningMs),
    meaningfulProgressCancelMs: Math.round(cancelMs),
    apiActiveTurnMaxMs: Math.round(positiveNumber(
      overrides.apiActiveTurnMaxMs,
      minutesToMs(apiAgent.activeTurnMaxMinutes, DEFAULT_AGENT_PROGRESS_POLICY.apiActiveTurnMaxMs),
    )),
    terminationVerifyMs: Math.round(positiveNumber(
      overrides.terminationVerifyMs,
      positiveNumber(apiAgent.terminationVerifySeconds, DEFAULT_AGENT_PROGRESS_POLICY.terminationVerifyMs / 1000) * 1000,
    )),
  });
}

export function isMeaningfulProgressStream({ deltaType, chunk } = {}) {
  if (!chunk) return false;
  return deltaType === "text" || deltaType === "tool_output";
}

export function isAutomaticConvergenceError(error) {
  return AUTOMATIC_CONVERGENCE_CODES.has(String(error?.code || ""));
}

export function automaticConvergenceError(code, snapshot = {}) {
  const activeTurn = code === "API_AGENT_ACTIVE_TURN_TIMEOUT";
  const error = new Error(activeTurn
    ? "API Agent 本执行片段已达到总时限，已自动取消；故事点和已保存结果不会过期，可从检查点继续。"
    : "本执行片段长时间没有检测到可验证的业务推进，已自动取消；故事点和已保存结果不会过期，可从检查点继续。");
  return Object.assign(error, {
    code,
    timeoutKind: activeTurn ? "active_turn" : "meaningful_progress",
    terminalFailure: true,
    userStopped: false,
    resumable: true,
    storyLifetimeExpired: false,
    requiresTerminationVerification: true,
    progressState: "cancelling",
    executionStartedAt: snapshot.executionStartedAt || null,
    lastMeaningfulProgressAt: snapshot.lastMeaningfulProgressAt || null,
  });
}

function progressFingerprint(detail = {}) {
  if (detail.fingerprint) return String(detail.fingerprint).slice(0, 2048);
  const source = String(detail.source || detail.deltaType || "progress");
  const content = String(detail.chunk ?? detail.result ?? detail.detail ?? "");
  return `${source}:${content.slice(0, 1800)}`;
}

/**
 * Supervise one active execution slice. Story/task age is intentionally absent:
 * long-lived work continues through persisted checkpoints and later slices.
 */
export function createAgentExecutionSupervisor({
  policy,
  apiActiveTurn = false,
  onState,
  onCancel,
  now = () => Date.now(),
  schedule = (fn, delay) => setTimeout(fn, delay),
  unschedule = (timer) => clearTimeout(timer),
} = {}) {
  const resolved = policy || resolveAgentProgressPolicy();
  const executionStartedAt = now();
  let lastMeaningfulProgressAt = executionStartedAt;
  let state = "active";
  let warningTimer = null;
  let cancelTimer = null;
  let activeWarningTimer = null;
  let activeCancelTimer = null;
  let disposed = false;
  let cancelled = false;
  let activeTurnWarningIssued = false;
  let apiTurnStarted = false;
  const recentFingerprints = new Set();
  const recentOrder = [];

  const snapshot = (extra = {}) => ({
    state,
    executionStartedAt,
    lastMeaningfulProgressAt,
    warningAfterMs: resolved.meaningfulProgressWarningMs,
    cancelAfterMs: resolved.meaningfulProgressCancelMs,
    apiActiveTurnMaxMs: apiTurnStarted ? resolved.apiActiveTurnMaxMs : null,
    storyLifetimeExpired: false,
    ...extra,
  });
  const notify = (extra = {}) => {
    try { onState?.(snapshot(extra)); } catch {}
  };
  const cancel = (code) => {
    if (disposed || cancelled) return;
    cancelled = true;
    state = "cancelling";
    const error = automaticConvergenceError(code, snapshot());
    notify({ code, timeoutKind: error.timeoutKind, resumable: true });
    try { onCancel?.(error); } catch {}
  };
  const armMeaningfulTimers = () => {
    if (warningTimer) unschedule(warningTimer);
    if (cancelTimer) unschedule(cancelTimer);
    warningTimer = schedule(() => {
      if (disposed || cancelled) return;
      state = "warning";
      notify({
        code: "AI_MEANINGFUL_PROGRESS_WARNING",
        timeoutKind: "meaningful_progress",
        warningAt: now(),
      });
    }, resolved.meaningfulProgressWarningMs);
    cancelTimer = schedule(
      () => cancel("AI_NO_MEANINGFUL_PROGRESS"),
      resolved.meaningfulProgressCancelMs,
    );
    warningTimer?.unref?.();
    cancelTimer?.unref?.();
  };

  const armApiTurnTimers = () => {
    if (apiTurnStarted || disposed || cancelled) return;
    apiTurnStarted = true;
    const leadMs = Math.min(10 * MINUTE_MS, Math.max(1, Math.floor(resolved.apiActiveTurnMaxMs / 10)));
    activeWarningTimer = schedule(() => {
      if (disposed || cancelled) return;
      activeTurnWarningIssued = true;
      state = "warning";
      notify({
        code: "API_AGENT_ACTIVE_TURN_WARNING",
        timeoutKind: "active_turn",
        warningAt: now(),
        remainingMs: leadMs,
      });
    }, Math.max(0, resolved.apiActiveTurnMaxMs - leadMs));
    activeCancelTimer = schedule(
      () => cancel("API_AGENT_ACTIVE_TURN_TIMEOUT"),
      resolved.apiActiveTurnMaxMs,
    );
    activeWarningTimer?.unref?.();
    activeCancelTimer?.unref?.();
  };
  armMeaningfulTimers();
  if (apiActiveTurn) armApiTurnTimers();
  notify();

  return {
    snapshot,
    markMeaningfulProgress(detail = {}) {
      if (disposed || cancelled) return false;
      const fingerprint = progressFingerprint(detail);
      if (fingerprint && recentFingerprints.has(fingerprint)) return false;
      if (fingerprint) {
        recentFingerprints.add(fingerprint);
        recentOrder.push(fingerprint);
        if (recentOrder.length > 128) recentFingerprints.delete(recentOrder.shift());
      }
      lastMeaningfulProgressAt = now();
      state = activeTurnWarningIssued ? "warning" : "active";
      armMeaningfulTimers();
      notify({ source: detail.source || detail.deltaType || "progress" });
      return true;
    },
    startApiActiveTurn() {
      armApiTurnTimers();
    },
    dispose() {
      disposed = true;
      for (const timer of [warningTimer, cancelTimer, activeWarningTimer, activeCancelTimer]) {
        if (timer) unschedule(timer);
      }
    },
    get cancelled() { return cancelled; },
  };
}
