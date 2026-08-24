import { createHash, randomUUID } from 'node:crypto';
import { boundedPush, deepClone, nonEmptyString, nowIso, sanitizeTaskId } from './utils.mjs';
import { resolvePolicy } from './policy.mjs';

const VISUAL_CHANNELS = new Set(['visual', 'computer_use']);
const SENSITIVE_POLICY_KEYS = {
  authentication: 'onAuthentication',
  captcha: 'onCaptcha',
  two_factor_authentication: 'onTwoFactorAuthentication',
  admin_authorization: 'onAdminAuthorization',
  physical_device_action: 'onPhysicalDeviceAction',
  irreversible_production_action: 'onIrreversibleProductionAction'
};

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function digestResult(result) {
  return createHash('sha256').update(JSON.stringify(canonicalize(result))).digest('hex');
}

function initialCounters() {
  return {
    discoveryScreenshots: 0,
    verificationScreenshots: 0,
    otherScreenshots: 0,
    visualActions: 0,
    coordinateActions: 0,
    visualCostUnits: 0,
    noProgressEvents: 0,
    consecutiveNoProgress: 0,
    sameScreenRepeats: 0,
    targetFailures: {},
    actualInputImageTokens: 0
  };
}

export class VisualOperationGuard {
  constructor(rawPolicy, options = {}, existingState = null) {
    const mode = options.mode || existingState?.mode || rawPolicy.defaultMode;
    this.rawPolicy = deepClone(rawPolicy);
    this.policy = resolvePolicy(rawPolicy, mode);
    this.task = {
      taskId: sanitizeTaskId(options.taskId || existingState?.task?.taskId || randomUUID()),
      mode,
      taskType: options.taskType || existingState?.task?.taskType || 'generic',
      unattended: options.unattended ?? existingState?.task?.unattended ?? Boolean(this.policy.runtime?.unattended)
    };
    this.state = existingState ? deepClone(existingState) : {
      version: '1.0.0',
      task: deepClone(this.task),
      status: 'PREFLIGHT_REQUIRED',
      phase: 'NEW',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      preflight: null,
      checkpoint: null,
      counters: initialCounters(),
      lastScreenFingerprint: null,
      pendingAuthorizations: {},
      activeExecutions: {},
      completedExecutions: {},
      handoff: null,
      lastHandoff: null,
      handoffConfirmationRemaining: 0,
      events: []
    };
    this.state.task = deepClone(this.task);
    // Backward-compatible state migration for snapshots created before the
    // two-phase authorization protocol was introduced.
    this.state.pendingAuthorizations ??= {};
    this.state.activeExecutions ??= {};
    this.state.completedExecutions ??= {};
    this.state.counters ??= initialCounters();
    this.state.events ??= [];
    this.state.handoffConfirmationRemaining ??= 0;
  }

  static fromState(rawPolicy, state) {
    return new VisualOperationGuard(rawPolicy, {
      taskId: state.task.taskId,
      mode: state.task.mode,
      taskType: state.task.taskType,
      unattended: state.task.unattended
    }, state);
  }

  get taskId() {
    return this.task.taskId;
  }

  audit(type, payload = {}) {
    const event = { id: randomUUID(), at: nowIso(), type, ...deepClone(payload) };
    boundedPush(this.state.events, event, 200);
    this.state.updatedAt = event.at;
    return event;
  }

  preflight(input) {
    const errors = this.#validatePreflight(input);
    if (errors.length > 0) {
      this.audit('PREFLIGHT_REJECTED', { errors });
      return this.#decision(false, 'PREFLIGHT_INVALID', errors.join('; '), {
        status: 'PREFLIGHT_REQUIRED', nextAction: 'Complete every required preflight field and category.'
      });
    }

    this.state.preflight = deepClone(input);
    this.state.phase = 'PREFLIGHT_COMPLETE';

    const sensitive = this.#firstSensitiveFlag(input.sensitiveFlags || []);
    if (sensitive) return this.#handoff(`敏感操作需要人工接管：${sensitive}`, { sensitiveFlag: sensitive });

    if (this.#isVisualChoice(input.chosenChannel)) {
      const available = this.#availableStructuredAlternative(input.alternatives);
      if (available && this.policy.preflight.rejectVisualWhenHigherPriorityAvailable) {
        this.state.status = 'READY_STRUCTURED';
        this.audit('STRUCTURED_ALTERNATIVE_REQUIRED', { category: available.category, strategyId: available.strategyId, channels: available.channelsChecked });
        return this.#decision(false, 'USE_STRUCTURED_ALTERNATIVE', `存在可用的高优先级结构化方式：${available.category}`, {
          status: this.state.status,
          structuredAlternative: available,
          nextAction: 'Use the available structured strategy instead of visual automation.'
        });
      }

      const visual = this.policy.visual;
      if (!visual.enabled) return this.#handoff('当前模式禁止视觉工具。', { reasonCode: 'VISUAL_DISABLED' });
      if (input.estimatedScreenTransitions > visual.handoffWhenEstimatedScreenTransitionsGt) {
        return this.#handoff(`预计页面切换 ${input.estimatedScreenTransitions} 次，超过阈值 ${visual.handoffWhenEstimatedScreenTransitionsGt}。`, { reasonCode: 'ESTIMATED_SCREEN_TRANSITIONS_EXCEEDED' });
      }
      if (input.estimatedVisualActions > visual.handoffWhenEstimatedVisualActionsGt) {
        return this.#handoff(`预计视觉动作 ${input.estimatedVisualActions} 次，超过阈值 ${visual.handoffWhenEstimatedVisualActionsGt}。`, { reasonCode: 'ESTIMATED_VISUAL_ACTIONS_EXCEEDED' });
      }
      this.state.status = 'READY_VISUAL';
    } else {
      this.state.status = 'READY_STRUCTURED';
    }

    this.audit('PREFLIGHT_ACCEPTED', { chosenChannel: input.chosenChannel, status: this.state.status });
    return this.#decision(true, 'PREFLIGHT_ACCEPTED', '结构化预检通过。', {
      status: this.state.status,
      nextAction: this.state.status === 'READY_VISUAL' ? 'Visual tools may request scoped authorization.' : 'Execute the selected structured strategy.'
    });
  }

  authorize(request) {
    if (!request || typeof request !== 'object') {
      return this.#decision(false, 'INVALID_REQUEST', 'authorize request must be an object');
    }
    if (['NEEDS_HUMAN_INPUT', 'BLOCKED_NEEDS_HUMAN', 'COMPLETED'].includes(this.state.status)) {
      return this.#decision(false, 'TASK_NOT_EXECUTABLE', `Task status is ${this.state.status}`, { status: this.state.status, handoff: this.state.handoff });
    }

    this.#purgeExpiredAuthorizations();
    if (Object.keys(this.state.pendingAuthorizations).length >= this.policy.authorization.maxPendingPerTask) {
      this.audit('TOOL_AUTHORIZATION_DENIED', { code: 'TOO_MANY_PENDING_AUTHORIZATIONS', toolName: request.toolName });
      return this.#decision(false, 'TOO_MANY_PENDING_AUTHORIZATIONS', '当前任务存在过多尚未开始的工具授权。', {
        status: this.state.status,
        nextAction: 'Begin or allow pending authorizations to expire before requesting another tool.'
      });
    }
    if (Object.keys(this.state.activeExecutions).length >= this.policy.authorization.maxActivePerTask) {
      this.audit('TOOL_AUTHORIZATION_DENIED', { code: 'TOO_MANY_ACTIVE_EXECUTIONS', toolName: request.toolName });
      return this.#decision(false, 'TOO_MANY_ACTIVE_EXECUTIONS', '当前任务存在过多正在执行且尚未回报结果的工具。', {
        status: this.state.status,
        nextAction: 'Wait for active executions to report results before authorizing another tool.'
      });
    }

    const isScreenshot = request.operationType === 'screenshot';
    const isVisualAction = request.operationType === 'visual_action' || request.coordinateBased === true || VISUAL_CHANNELS.has(request.channel);
    const requiresGuard = isScreenshot || isVisualAction;

    if (!requiresGuard) {
      const authorizationId = this.#reserveAuthorization(request, 0);
      this.audit('STRUCTURED_TOOL_AUTHORIZED', { authorizationId, toolName: request.toolName, channel: request.channel });
      return this.#decision(true, 'ALLOW', '结构化工具已授权。', {
        authorizationId,
        expiresAt: this.state.pendingAuthorizations[authorizationId].expiresAt,
        status: this.state.status,
        visualCostUnits: 0
      });
    }

    if (this.policy.preflight.requiredBeforeVisual && !this.state.preflight) {
      this.state.status = 'PREFLIGHT_REQUIRED';
      this.audit('VISUAL_TOOL_DENIED', { code: 'REQUIRE_PREFLIGHT', toolName: request.toolName });
      return this.#decision(false, 'REQUIRE_PREFLIGHT', '第一次视觉操作前必须完成结构化预检。', {
        status: this.state.status,
        nextAction: 'Submit target state, success criteria, alternatives, estimates, and chosen channel.'
      });
    }

    const sensitive = this.#firstSensitiveFlag([request.sensitiveFlag].filter(Boolean));
    if (sensitive) return this.#handoff(`敏感操作需要人工接管：${sensitive}`, { sensitiveFlag: sensitive });

    if (!this.policy.visual.enabled) return this.#handoff('当前模式禁止视觉工具。', { reasonCode: 'VISUAL_DISABLED' });

    if (Number.isFinite(request.estimatedRemainingActions) && request.estimatedRemainingActions > this.policy.visual.handoffWhenEstimatedVisualActionsGt) {
      return this.#handoff(`剩余视觉动作预计 ${request.estimatedRemainingActions} 次，超过阈值。`, { reasonCode: 'ESTIMATED_REMAINING_ACTIONS_EXCEEDED' });
    }

    if (isScreenshot && request.handoffConfirmation === true && this.state.handoffConfirmationRemaining > 0) {
      return this.#authorizeHandoffConfirmation(request);
    }
    if (isScreenshot) return this.#authorizeScreenshot(request);
    return this.#authorizeVisualAction(request);
  }

  beginExecution(input) {
    const authorizationId = typeof input === 'string' ? input : input?.authorizationId;
    if (!nonEmptyString(authorizationId)) {
      return this.#decision(false, 'INVALID_BEGIN_REQUEST', 'authorizationId is required');
    }
    if (['NEEDS_HUMAN_INPUT', 'BLOCKED_NEEDS_HUMAN', 'COMPLETED'].includes(this.state.status)) {
      return this.#decision(false, 'TASK_NOT_EXECUTABLE', `Task status is ${this.state.status}`, {
        status: this.state.status,
        handoff: this.state.handoff
      });
    }

    this.#purgeExpiredAuthorizations(authorizationId);
    if (this.state.activeExecutions[authorizationId]) {
      return this.#decision(false, 'AUTHORIZATION_ALREADY_CONSUMED', '工具授权已经被消费，不能并发或重复执行。', {
        status: this.state.status,
        authorizationId
      });
    }

    const pending = this.state.pendingAuthorizations[authorizationId];
    if (!pending) {
      return this.#decision(false, 'UNKNOWN_AUTHORIZATION', 'authorizationId is unknown, expired, cancelled, or already completed');
    }
    if (Date.parse(pending.expiresAt) <= Date.now()) {
      delete this.state.pendingAuthorizations[authorizationId];
      this.audit('AUTHORIZATION_EXPIRED', { authorizationId, toolName: pending.request?.toolName || null });
      return this.#decision(false, 'AUTHORIZATION_EXPIRED', '工具开始授权已过期，必须重新申请。', {
        status: this.state.status,
        authorizationId
      });
    }
    if (Object.keys(this.state.activeExecutions).length >= this.policy.authorization.maxActivePerTask) {
      return this.#decision(false, 'TOO_MANY_ACTIVE_EXECUTIONS', '当前任务正在执行的工具数量已达到上限。', {
        status: this.state.status,
        authorizationId,
        nextAction: 'Wait for an active execution to report its result, then retry begin.'
      });
    }

    delete this.state.pendingAuthorizations[authorizationId];
    const startedAt = nowIso();
    const resultExpiresAt = new Date(Date.now() + this.policy.authorization.executionResultTtlSeconds * 1000).toISOString();
    this.state.activeExecutions[authorizationId] = {
      ...pending,
      startedAt,
      resultExpiresAt
    };
    this.audit('EXECUTION_STARTED', {
      authorizationId,
      toolName: pending.request?.toolName || null,
      startedAt,
      resultExpiresAt
    });
    return this.#decision(true, 'EXECUTION_STARTED', '一次性工具授权已消费，允许执行。', {
      status: this.state.status,
      authorizationId,
      executionId: authorizationId,
      resultExpiresAt
    });
  }

  recordResult(result) {
    if (!result || typeof result !== 'object' || !nonEmptyString(result.authorizationId)) {
      return this.#decision(false, 'INVALID_RESULT', 'authorizationId is required');
    }

    const authorizationId = result.authorizationId;
    this.#purgeExpiredAuthorizations(authorizationId);
    const completed = this.state.completedExecutions[authorizationId];
    if (completed) {
      const incomingDigest = digestResult(result);
      if (incomingDigest !== completed.resultDigest) {
        this.audit('EXECUTION_RESULT_REPLAY_CONFLICT', {
          authorizationId,
          toolName: completed.toolName || null
        });
        return this.#decision(false, 'RESULT_REPLAY_CONFLICT', '同一授权提交了不同的重复结果，已拒绝覆盖原结果。', {
          status: this.state.status,
          authorizationId
        });
      }
      this.audit('EXECUTION_RESULT_REPLAYED', { authorizationId, toolName: completed.toolName || null });
      return { ...deepClone(completed.decision), replayed: true, replayedAt: nowIso() };
    }
    const pending = this.state.pendingAuthorizations[authorizationId];
    if (pending && Date.parse(pending.expiresAt) <= Date.now()) {
      delete this.state.pendingAuthorizations[authorizationId];
      this.audit('AUTHORIZATION_EXPIRED', { authorizationId, toolName: pending.request?.toolName || null });
      return this.#decision(false, 'AUTHORIZATION_EXPIRED', '工具开始授权已过期，必须重新申请。', {
        status: this.state.status,
        authorizationId
      });
    }
    if (pending) {
      return this.#decision(false, 'EXECUTION_NOT_STARTED', '必须先调用 beginExecution 消费一次性授权，再执行工具并回报结果。', {
        status: this.state.status,
        authorizationId
      });
    }
    const execution = this.state.activeExecutions[authorizationId];
    if (!execution) {
      return this.#decision(false, 'UNKNOWN_AUTHORIZATION', 'authorizationId is unknown, expired, cancelled, or already completed');
    }
    if (Date.parse(execution.resultExpiresAt) <= Date.now()) {
      delete this.state.activeExecutions[authorizationId];
      this.audit('EXECUTION_RESULT_EXPIRED', { authorizationId, toolName: execution.request?.toolName || null });
      return this.#decision(false, 'EXECUTION_RESULT_EXPIRED', '工具结果回报窗口已过期。', {
        status: this.state.status,
        authorizationId
      });
    }
    delete this.state.activeExecutions[authorizationId];
    const finalize = (decision) => this.#rememberCompletedExecution(authorizationId, result, execution, decision);

    // A concurrent tool may finish after another tool has completed the task.
    // Consume and audit the late result without allowing it to reopen the task.
    if (['NEEDS_HUMAN_INPUT', 'BLOCKED_NEEDS_HUMAN', 'COMPLETED'].includes(this.state.status)) {
      this.audit('LATE_TOOL_RESULT_IGNORED', {
        authorizationId,
        toolName: execution.request?.toolName || null,
        success: result.success === true
      });
      return finalize(this.#decision(true, 'LATE_RESULT_IGNORED', '任务已经完成或进入人工接管，迟到的工具结果仅审计不再改变状态。', {
        status: this.state.status
      }));
    }

    const success = result.success === true;
    const progress = result.progress === true;
    const targetId = execution.request.targetId;

    if (targetId) {
      if (success) this.state.counters.targetFailures[targetId] = 0;
      else this.state.counters.targetFailures[targetId] = (this.state.counters.targetFailures[targetId] || 0) + 1;
    }

    if (progress) {
      this.state.counters.consecutiveNoProgress = 0;
      this.state.counters.sameScreenRepeats = 0;
    } else {
      this.state.counters.noProgressEvents += 1;
      this.state.counters.consecutiveNoProgress += 1;
    }

    if (nonEmptyString(result.screenFingerprint)) {
      if (result.screenFingerprint === this.state.lastScreenFingerprint) {
        this.state.counters.sameScreenRepeats += 1;
      } else {
        this.state.lastScreenFingerprint = result.screenFingerprint;
        if (progress) this.state.counters.sameScreenRepeats = 0;
      }
    }

    if (nonEmptyString(result.checkpoint)) this.state.checkpoint = result.checkpoint.trim();
    const actualTokens = result.actualUsage?.inputImageTokens;
    if (Number.isFinite(actualTokens) && actualTokens >= 0) this.state.counters.actualInputImageTokens += actualTokens;

    this.audit('TOOL_RESULT_RECORDED', {
      authorizationId,
      toolName: execution.request.toolName,
      success,
      progress,
      targetId: targetId || null,
      checkpoint: this.state.checkpoint,
      hasScreenFingerprint: nonEmptyString(result.screenFingerprint)
    });

    if (result.completed === true) {
      this.state.status = 'COMPLETED';
      this.state.phase = 'COMPLETED';
      const cancelledPending = Object.keys(this.state.pendingAuthorizations).length;
      this.state.pendingAuthorizations = {};
      this.audit('TASK_COMPLETED', { cancelledPendingAuthorizations: cancelledPending });
      return finalize(this.#decision(true, 'COMPLETED', '任务已完成。', { status: this.state.status }));
    }

    if (targetId && (this.state.counters.targetFailures[targetId] || 0) >= this.policy.visual.maxRetriesPerTarget) {
      return finalize(this.#handoff(`目标 ${targetId} 已连续失败 ${this.state.counters.targetFailures[targetId]} 次。`, { reasonCode: 'TARGET_RETRY_LIMIT_REACHED', targetId }));
    }
    if (this.state.counters.sameScreenRepeats > this.policy.visual.maxSameScreenRepeats) {
      return finalize(this.#handoff('连续操作后画面没有有效变化。', { reasonCode: 'SAME_SCREEN_LIMIT_REACHED' }));
    }
    if (this.state.counters.consecutiveNoProgress >= this.policy.visual.maxNoProgressEvents) {
      return finalize(this.#handoff(`连续 ${this.state.counters.consecutiveNoProgress} 次操作没有有效进展。`, { reasonCode: 'NO_PROGRESS_LIMIT_REACHED' }));
    }

    return finalize(this.#decision(true, 'RESULT_RECORDED', '工具结果已记录。', {
      status: this.state.status,
      counters: deepClone(this.state.counters)
    }));
  }

  requestHandoff(details = {}) {
    return this.#handoff(details.reason || '任务主动请求人工接管。', details);
  }

  resumeAfterHandoff(details = {}) {
    if (!['NEEDS_HUMAN_INPUT', 'BLOCKED_NEEDS_HUMAN'].includes(this.state.status) || !this.state.handoff) {
      return this.#decision(false, 'TASK_NOT_WAITING_FOR_HUMAN', '当前任务不处于人工接管状态。', { status: this.state.status });
    }
    if (details.confirmed !== true) {
      return this.#decision(false, 'HUMAN_ACTION_NOT_CONFIRMED', '必须明确确认人工步骤已经完成。', { status: this.state.status });
    }
    const expectedReply = this.state.handoff.reply;
    if (this.policy.humanHandoff.fixedReplyRequired && expectedReply && details.userReply !== expectedReply) {
      return this.#decision(false, 'HANDOFF_REPLY_MISMATCH', '用户回复与人工接管要求的固定回复不一致。', {
        status: this.state.status,
        expectedReply
      });
    }

    const previous = deepClone(this.state.handoff);
    this.state.lastHandoff = previous;
    this.state.handoff = null;
    this.state.counters.consecutiveNoProgress = 0;
    this.state.counters.sameScreenRepeats = 0;
    this.state.handoffConfirmationRemaining = Number(this.policy.humanHandoff.confirmationMaxActions || 0);
    if (nonEmptyString(details.checkpoint)) this.state.checkpoint = details.checkpoint.trim();
    if (!this.state.preflight) this.state.status = 'PREFLIGHT_REQUIRED';
    else this.state.status = this.#isVisualChoice(this.state.preflight.chosenChannel) ? 'READY_VISUAL' : 'READY_STRUCTURED';
    this.state.phase = 'RESUMED';
    this.audit('HUMAN_HANDOFF_RESUMED', {
      previousStatus: previous.status,
      checkpoint: this.state.checkpoint,
      confirmationRemaining: this.state.handoffConfirmationRemaining
    });
    return this.#decision(true, 'RESUMED', '已从人工接管检查点恢复。', {
      status: this.state.status,
      checkpoint: this.state.checkpoint,
      confirmationRemaining: this.state.handoffConfirmationRemaining,
      nextAction: 'Confirm the target state once, then continue from the saved checkpoint.'
    });
  }

  markCheckpoint(checkpoint) {
    if (!nonEmptyString(checkpoint)) return this.#decision(false, 'INVALID_CHECKPOINT', 'checkpoint must be non-empty');
    this.state.checkpoint = checkpoint.trim();
    this.audit('CHECKPOINT_UPDATED', { checkpoint: this.state.checkpoint });
    return this.#decision(true, 'CHECKPOINT_UPDATED', '检查点已保存。', { checkpoint: this.state.checkpoint });
  }

  snapshot() {
    return deepClone(this.state);
  }

  #authorizeHandoffConfirmation(request) {
    if (request.screenshotKind !== 'verification' || request.regionScoped !== true) {
      return this.#decision(false, 'HANDOFF_CONFIRMATION_MUST_BE_SCOPED', '人工接管恢复后的视觉确认只能使用一次区域验证截图。', {
        status: this.state.status,
        nextAction: 'Use screenshotKind=verification, regionScoped=true, handoffConfirmation=true.'
      });
    }
    if (!this.policy.visual.enabled) {
      return this.#decision(false, 'VISUAL_DISABLED', '当前模式禁止视觉确认，请使用结构化状态查询。', {
        status: this.state.status,
        nextAction: 'Use a structured status query instead of a screenshot.'
      });
    }
    const cost = this.policy.visual.costUnits.verificationRegionScreenshot;
    this.state.handoffConfirmationRemaining -= 1;
    this.state.counters.verificationScreenshots += 1;
    this.state.counters.visualCostUnits += cost;
    const authorizationId = this.#reserveAuthorization({ ...request, screenshotKind: 'verification', regionScoped: true }, cost);
    this.audit('HANDOFF_CONFIRMATION_AUTHORIZED', { authorizationId, toolName: request.toolName, cost });
    return this.#decision(true, 'ALLOW_HANDOFF_CONFIRMATION', '人工接管后的单次区域验证截图已授权。', {
      authorizationId,
      expiresAt: this.state.pendingAuthorizations[authorizationId].expiresAt,
      status: this.state.status,
      visualCostUnits: cost,
      confirmationRemaining: this.state.handoffConfirmationRemaining
    });
  }

  #authorizeScreenshot(request) {
    const kind = ['discovery', 'verification', 'other'].includes(request.screenshotKind) ? request.screenshotKind : 'other';
    const regionScoped = request.regionScoped === true;
    const counters = this.state.counters;
    const visual = this.policy.visual;

    if (visual.requireRegionScopedAfterDiscovery && counters.discoveryScreenshots > 0 && !regionScoped) {
      this.audit('VISUAL_TOOL_DENIED', { code: 'REGION_REQUIRED', toolName: request.toolName, kind });
      return this.#decision(false, 'REGION_REQUIRED', '首次探索截图之后必须只截取目标区域。', { nextAction: 'Crop to the target app, panel, or element region.' });
    }

    const key = kind === 'discovery' ? 'discoveryScreenshots' : kind === 'verification' ? 'verificationScreenshots' : 'otherScreenshots';
    const limitKey = kind === 'discovery' ? 'maxDiscoveryScreenshots' : kind === 'verification' ? 'maxVerificationScreenshots' : 'maxOtherScreenshots';
    if (counters[key] >= visual[limitKey]) {
      return this.#handoff(`${kind} 截图已达到上限 ${visual[limitKey]}。`, { reasonCode: 'SCREENSHOT_BUDGET_EXCEEDED', screenshotKind: kind });
    }

    const cost = this.#screenshotCost(kind, regionScoped);
    if (counters.visualCostUnits + cost > visual.maxVisualCostUnits) {
      return this.#handoff(`视觉成本将超过上限 ${visual.maxVisualCostUnits}。`, { reasonCode: 'VISUAL_COST_BUDGET_EXCEEDED' });
    }

    counters[key] += 1;
    counters.visualCostUnits += cost;
    const authorizationId = this.#reserveAuthorization({ ...request, screenshotKind: kind, regionScoped }, cost);
    this.state.status = 'READY_VISUAL';
    this.audit('VISUAL_TOOL_AUTHORIZED', { authorizationId, toolName: request.toolName, operationType: 'screenshot', screenshotKind: kind, regionScoped, cost });
    return this.#decision(true, 'ALLOW', '截图已授权。', {
      authorizationId,
      expiresAt: this.state.pendingAuthorizations[authorizationId].expiresAt,
      status: this.state.status,
      visualCostUnits: cost,
      remainingVisualCostUnits: visual.maxVisualCostUnits - counters.visualCostUnits
    });
  }

  #authorizeVisualAction(request) {
    const counters = this.state.counters;
    const visual = this.policy.visual;
    const coordinate = request.coordinateBased === true;
    const targetId = nonEmptyString(request.targetId) ? request.targetId.trim() : null;

    if (counters.visualActions >= visual.maxVisualActions) {
      return this.#handoff(`视觉动作已达到上限 ${visual.maxVisualActions}。`, { reasonCode: 'VISUAL_ACTION_BUDGET_EXCEEDED' });
    }
    if (coordinate && counters.coordinateActions >= visual.maxCoordinateActions) {
      return this.#handoff(`坐标动作已达到上限 ${visual.maxCoordinateActions}。`, { reasonCode: 'COORDINATE_ACTION_BUDGET_EXCEEDED' });
    }
    if (targetId && (counters.targetFailures[targetId] || 0) >= visual.maxRetriesPerTarget) {
      return this.#handoff(`目标 ${targetId} 已达到失败重试上限。`, { reasonCode: 'TARGET_RETRY_LIMIT_REACHED', targetId });
    }

    const cost = coordinate ? visual.costUnits.coordinateAction : visual.costUnits.nonCoordinateVisualAction;
    if (counters.visualCostUnits + cost > visual.maxVisualCostUnits) {
      return this.#handoff(`视觉成本将超过上限 ${visual.maxVisualCostUnits}。`, { reasonCode: 'VISUAL_COST_BUDGET_EXCEEDED' });
    }

    counters.visualActions += 1;
    if (coordinate) counters.coordinateActions += 1;
    counters.visualCostUnits += cost;
    const authorizationId = this.#reserveAuthorization({ ...request, targetId }, cost);
    this.state.status = 'READY_VISUAL';
    this.audit('VISUAL_TOOL_AUTHORIZED', { authorizationId, toolName: request.toolName, operationType: 'visual_action', coordinateBased: coordinate, targetId, cost });
    return this.#decision(true, 'ALLOW', '视觉动作已授权。', {
      authorizationId,
      expiresAt: this.state.pendingAuthorizations[authorizationId].expiresAt,
      status: this.state.status,
      visualCostUnits: cost,
      remainingVisualCostUnits: visual.maxVisualCostUnits - counters.visualCostUnits
    });
  }

  #rememberCompletedExecution(authorizationId, result, execution, decision) {
    const completedAt = nowIso();
    const replayExpiresAt = new Date(Date.now() + this.policy.authorization.resultReplayTtlSeconds * 1000).toISOString();
    this.state.completedExecutions[authorizationId] = {
      authorizationId,
      toolName: execution.request?.toolName || null,
      completedAt,
      replayExpiresAt,
      resultDigest: digestResult(result),
      decision: deepClone(decision)
    };

    const entries = Object.values(this.state.completedExecutions)
      .sort((a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt));
    while (entries.length > this.policy.authorization.maxCompletedPerTask) {
      const oldest = entries.shift();
      if (oldest) delete this.state.completedExecutions[oldest.authorizationId];
    }
    this.audit('EXECUTION_RESULT_FINALIZED', {
      authorizationId,
      toolName: execution.request?.toolName || null,
      decisionCode: decision.code,
      replayExpiresAt
    });
    return decision;
  }

  #reserveAuthorization(request, cost) {
    const authorizationId = randomUUID();
    const issuedAt = nowIso();
    const expiresAt = new Date(Date.now() + this.policy.authorization.ttlSeconds * 1000).toISOString();
    this.state.pendingAuthorizations[authorizationId] = {
      authorizationId,
      issuedAt,
      expiresAt,
      request: deepClone(request),
      visualCostUnits: cost
    };
    return authorizationId;
  }

  #purgeExpiredAuthorizations(excludeAuthorizationId = null) {
    const now = Date.now();
    for (const [authorizationId, pending] of Object.entries(this.state.pendingAuthorizations)) {
      if (authorizationId !== excludeAuthorizationId && Date.parse(pending.expiresAt) <= now) {
        delete this.state.pendingAuthorizations[authorizationId];
        this.audit('AUTHORIZATION_EXPIRED', { authorizationId, toolName: pending.request?.toolName || null });
      }
    }
    for (const [authorizationId, execution] of Object.entries(this.state.activeExecutions)) {
      if (authorizationId !== excludeAuthorizationId && Date.parse(execution.resultExpiresAt) <= now) {
        delete this.state.activeExecutions[authorizationId];
        this.audit('EXECUTION_RESULT_EXPIRED', { authorizationId, toolName: execution.request?.toolName || null });
      }
    }
    for (const [authorizationId, completed] of Object.entries(this.state.completedExecutions)) {
      if (Date.parse(completed.replayExpiresAt) <= now) {
        delete this.state.completedExecutions[authorizationId];
        this.audit('EXECUTION_RESULT_REPLAY_EXPIRED', { authorizationId, toolName: completed.toolName || null });
      }
    }
  }

  #screenshotCost(kind, regionScoped) {
    const costs = this.policy.visual.costUnits;
    if (kind === 'discovery') return regionScoped ? costs.discoveryRegionScreenshot : costs.discoveryFullscreenScreenshot;
    if (kind === 'verification') return regionScoped ? costs.verificationRegionScreenshot : costs.verificationFullscreenScreenshot;
    return regionScoped ? costs.otherRegionScreenshot : costs.otherFullscreenScreenshot;
  }

  #validatePreflight(input) {
    const errors = [];
    if (!input || typeof input !== 'object') return ['preflight input must be an object'];
    if (!nonEmptyString(input.targetState)) errors.push('targetState is required');
    if (!Array.isArray(input.successCriteria) || input.successCriteria.length === 0 || input.successCriteria.some((x) => !nonEmptyString(x))) errors.push('successCriteria must contain non-empty items');
    if (!Number.isInteger(input.estimatedScreenTransitions) || input.estimatedScreenTransitions < 0) errors.push('estimatedScreenTransitions must be a non-negative integer');
    if (!Number.isInteger(input.estimatedVisualActions) || input.estimatedVisualActions < 0) errors.push('estimatedVisualActions must be a non-negative integer');
    if (!(input.coreInteractionUnderTest === null || nonEmptyString(input.coreInteractionUnderTest))) errors.push('coreInteractionUnderTest must be a string or null');
    if (!nonEmptyString(input.chosenChannel)) errors.push('chosenChannel is required');
    if (!input.alternatives || typeof input.alternatives !== 'object') errors.push('alternatives is required');

    for (const category of this.policy.preflight.requiredCategories) {
      const value = input.alternatives?.[category.id];
      if (!value || typeof value !== 'object') {
        errors.push(`alternatives.${category.id} is required`);
        continue;
      }
      if (!this.policy.preflight.allowedStatuses.includes(value.status)) errors.push(`alternatives.${category.id}.status is invalid`);
      if (!Array.isArray(value.channelsChecked)) errors.push(`alternatives.${category.id}.channelsChecked must be an array`);
      if (this.policy.preflight.reasonRequired && !nonEmptyString(value.reason)) errors.push(`alternatives.${category.id}.reason is required`);
      if (value.status === 'available' && this.policy.preflight.availableStrategyRequired && !nonEmptyString(value.strategyId)) errors.push(`alternatives.${category.id}.strategyId is required when available`);
    }
    return errors;
  }

  #availableStructuredAlternative(alternatives) {
    for (const category of this.policy.preflight.requiredCategories) {
      const value = alternatives?.[category.id];
      if (value?.status === 'available') return { category: category.id, ...deepClone(value) };
    }
    return null;
  }

  #firstSensitiveFlag(flags) {
    for (const flag of flags) {
      const key = SENSITIVE_POLICY_KEYS[flag];
      if (key && this.policy.humanHandoff?.[key] === true) return flag;
    }
    return null;
  }

  #isVisualChoice(channel) {
    return VISUAL_CHANNELS.has(channel);
  }

  #handoff(reason, details = {}) {
    const unattended = this.task.unattended === true;
    const status = unattended ? this.policy.unattended.status || 'BLOCKED_NEEDS_HUMAN' : 'NEEDS_HUMAN_INPUT';
    const checkpoint = details.checkpoint || this.state.checkpoint || this.state.preflight?.targetState || '尚未保存具体检查点';
    const steps = Array.isArray(details.steps) && details.steps.length > 0 ? details.steps : [
      '手动完成当前无法可靠自动化的前置操作。',
      '停留在下面指定的页面或设备状态。',
      '使用固定回复通知 AI 从检查点恢复。'
    ];
    const stayAt = details.stayAt || this.state.preflight?.targetState || '目标页面或目标设备状态';
    const reply = details.reply || `已完成：${stayAt}`;
    const text = [
      'NEEDS_USER_ACTION',
      '',
      '原因：',
      reason,
      '',
      '请完成：',
      ...steps.map((step, index) => `${index + 1}. ${step}`),
      '',
      '请停留在：',
      stayAt,
      '',
      '完成后回复：',
      reply,
      '',
      'AI 已保存的检查点：',
      checkpoint
    ].join('\n');

    const cancelledPendingAuthorizations = Object.keys(this.state.pendingAuthorizations).length;
    this.state.pendingAuthorizations = {};
    this.state.status = status;
    this.state.phase = 'HANDOFF';
    this.state.checkpoint = checkpoint;
    this.state.handoff = {
      status,
      reason,
      reasonCode: details.reasonCode || null,
      steps,
      stayAt,
      reply,
      checkpoint,
      text,
      actions: unattended ? {
        saveCheckpoint: this.policy.unattended.saveCheckpoint !== false,
        releaseResourceLocks: this.policy.unattended.releaseResourceLocks === true,
        notify: this.policy.unattended.notify === true,
        continueOtherTasks: this.policy.unattended.continueOtherTasks === true
      } : { saveCheckpoint: true }
    };
    this.audit('HUMAN_HANDOFF_REQUIRED', {
      status,
      reason,
      reasonCode: details.reasonCode || null,
      checkpoint,
      cancelledPendingAuthorizations
    });
    return this.#decision(false, status, reason, { status, handoff: deepClone(this.state.handoff) });
  }

  #decision(allowed, code, reason, extra = {}) {
    return {
      allowed,
      code,
      reason,
      taskId: this.taskId,
      at: nowIso(),
      ...deepClone(extra)
    };
  }
}
