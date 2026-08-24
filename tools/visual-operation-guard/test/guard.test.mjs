import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { VisualOperationGuard } from '../src/index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const policy = JSON.parse(await readFile(resolve(here, './fixtures/policy.json'), 'utf8'));

function alternatives(status = 'unavailable') {
  const value = (channels, strategyId) => ({
    status,
    channelsChecked: channels,
    reason: status === 'available' ? 'available for test' : 'checked and unavailable for test',
    ...(status === 'available' ? { strategyId } : {})
  });
  return {
    structured_integration: value(['mcp', 'api'], 'api-route'),
    command_or_config: value(['cli', 'adb'], 'adb-route'),
    direct_navigation: value(['route', 'deep_link'], 'deep-route'),
    structured_ui: value(['playwright', 'accessibility'], 'selector-route')
  };
}

function visualPreflight(overrides = {}) {
  return {
    targetState: 'target page',
    successCriteria: ['target visible'],
    estimatedScreenTransitions: 2,
    estimatedVisualActions: 3,
    coreInteractionUnderTest: 'click target button',
    chosenChannel: 'visual',
    alternatives: alternatives('unavailable'),
    ...overrides
  };
}

function beginAndRecord(guard, authorization, result) {
  assert.equal(authorization.allowed, true, `authorization failed: ${authorization.code}`);
  const started = guard.beginExecution({ authorizationId: authorization.authorizationId });
  assert.equal(started.allowed, true, `begin failed: ${started.code}`);
  assert.equal(started.code, 'EXECUTION_STARTED');
  return guard.recordResult({ authorizationId: authorization.authorizationId, ...result });
}

test('requires preflight before screenshot', () => {
  const guard = new VisualOperationGuard(policy, { taskId: 't-preflight', mode: 'balanced' });
  const decision = guard.authorize({ toolName: 'computer.screenshot', channel: 'visual', operationType: 'screenshot', screenshotKind: 'discovery' });
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, 'REQUIRE_PREFLIGHT');
});

test('rejects visual choice when structured alternative is available', () => {
  const guard = new VisualOperationGuard(policy, { taskId: 't-structured', mode: 'balanced' });
  const input = visualPreflight();
  input.alternatives.direct_navigation = {
    status: 'available',
    channelsChecked: ['deep_link'],
    strategyId: 'open-directly',
    reason: 'deep link exists'
  };
  const decision = guard.preflight(input);
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, 'USE_STRUCTURED_ALTERNATIVE');
  assert.equal(decision.structuredAlternative.strategyId, 'open-directly');
});

test('enforces screenshot budget', () => {
  const guard = new VisualOperationGuard(policy, { taskId: 't-budget', mode: 'balanced' });
  assert.equal(guard.preflight(visualPreflight()).allowed, true);
  const first = guard.authorize({ toolName: 'computer.screenshot', channel: 'visual', operationType: 'screenshot', screenshotKind: 'discovery', regionScoped: false });
  beginAndRecord(guard, first, { success: true, progress: true, screenFingerprint: 'screen-1', checkpoint: 'opened app' });
  const second = guard.authorize({ toolName: 'computer.screenshot', channel: 'visual', operationType: 'screenshot', screenshotKind: 'discovery', regionScoped: true });
  assert.equal(second.allowed, false);
  assert.equal(second.code, 'NEEDS_HUMAN_INPUT');
});

test('requires a region after the discovery screenshot', () => {
  const guard = new VisualOperationGuard(policy, { taskId: 't-region', mode: 'balanced' });
  guard.preflight(visualPreflight());
  const first = guard.authorize({ toolName: 'computer.screenshot', channel: 'visual', operationType: 'screenshot', screenshotKind: 'discovery', regionScoped: false });
  beginAndRecord(guard, first, { success: true, progress: true, screenFingerprint: 'screen-1' });
  const verify = guard.authorize({ toolName: 'computer.screenshot', channel: 'visual', operationType: 'screenshot', screenshotKind: 'verification', regionScoped: false });
  assert.equal(verify.allowed, false);
  assert.equal(verify.code, 'REGION_REQUIRED');
});

test('stops after consecutive no-progress results', () => {
  const guard = new VisualOperationGuard(policy, { taskId: 't-no-progress', mode: 'balanced' });
  guard.preflight(visualPreflight());
  const one = guard.authorize({ toolName: 'computer.click', channel: 'visual', operationType: 'visual_action', coordinateBased: true, targetId: 'button-a' });
  const oneResult = beginAndRecord(guard, one, { success: false, progress: false, screenFingerprint: 'same' });
  assert.equal(oneResult.code, 'RESULT_RECORDED');
  const two = guard.authorize({ toolName: 'computer.click', channel: 'visual', operationType: 'visual_action', coordinateBased: true, targetId: 'button-b' });
  const twoResult = beginAndRecord(guard, two, { success: false, progress: false, screenFingerprint: 'same' });
  assert.equal(twoResult.allowed, false);
  assert.equal(twoResult.code, 'NEEDS_HUMAN_INPUT');
});

test('unattended mode blocks and requests lock release', () => {
  const guard = new VisualOperationGuard(policy, { taskId: 't-unattended', mode: 'unattended', unattended: true });
  const decision = guard.preflight(visualPreflight({ estimatedVisualActions: 20 }));
  assert.equal(decision.code, 'BLOCKED_NEEDS_HUMAN');
  assert.equal(decision.handoff.actions.releaseResourceLocks, true);
  assert.equal(decision.handoff.actions.continueOtherTasks, true);
});

test('strict_ci disables visual tools', () => {
  const guard = new VisualOperationGuard(policy, { taskId: 't-strict', mode: 'strict_ci' });
  const decision = guard.preflight(visualPreflight());
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, 'BLOCKED_NEEDS_HUMAN');
});

test('resumes from human handoff with fixed reply and one scoped confirmation', () => {
  const guard = new VisualOperationGuard(policy, { taskId: 't-resume', mode: 'balanced' });
  guard.preflight(visualPreflight());

  const discovery = guard.authorize({ toolName: 'computer.screenshot', channel: 'visual', operationType: 'screenshot', screenshotKind: 'discovery', regionScoped: false });
  beginAndRecord(guard, discovery, { success: true, progress: true, screenFingerprint: 'd1' });
  for (let i = 0; i < 2; i += 1) {
    const verification = guard.authorize({ toolName: 'computer.screenshot', channel: 'visual', operationType: 'screenshot', screenshotKind: 'verification', regionScoped: true });
    beginAndRecord(guard, verification, { success: true, progress: true, screenFingerprint: `v${i}` });
  }

  const handoff = guard.requestHandoff({
    reason: 'manual navigation is faster',
    steps: ['open target page'],
    stayAt: 'target page',
    reply: '已进入目标页面',
    checkpoint: 'before manual navigation'
  });
  assert.equal(handoff.code, 'NEEDS_HUMAN_INPUT');

  const wrong = guard.resumeAfterHandoff({ confirmed: true, userReply: 'done' });
  assert.equal(wrong.code, 'HANDOFF_REPLY_MISMATCH');

  const resumed = guard.resumeAfterHandoff({ confirmed: true, userReply: '已进入目标页面', checkpoint: 'target page opened' });
  assert.equal(resumed.code, 'RESUMED');
  assert.equal(resumed.confirmationRemaining, 1);

  const confirmation = guard.authorize({
    toolName: 'computer.screenshot',
    channel: 'visual',
    operationType: 'screenshot',
    screenshotKind: 'verification',
    regionScoped: true,
    handoffConfirmation: true
  });
  assert.equal(confirmation.allowed, true);
  assert.equal(confirmation.code, 'ALLOW_HANDOFF_CONFIRMATION');
  beginAndRecord(guard, confirmation, { success: true, progress: true, screenFingerprint: 'human-target' });

  const secondConfirmation = guard.authorize({
    toolName: 'computer.screenshot', channel: 'visual', operationType: 'screenshot', screenshotKind: 'verification', regionScoped: true, handoffConfirmation: true
  });
  assert.equal(secondConfirmation.allowed, false);
});

test('result is rejected until beginExecution consumes the authorization', () => {
  const guard = new VisualOperationGuard(policy, { taskId: 't-not-started', mode: 'balanced' });
  const authorization = guard.authorize({ toolName: 'adb.shell', channel: 'adb', operationType: 'structured_command' });
  const result = guard.recordResult({ authorizationId: authorization.authorizationId, success: true, progress: true });
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'EXECUTION_NOT_STARTED');
});

test('start authorization expires before execution begins', () => {
  const guard = new VisualOperationGuard(policy, { taskId: 't-start-expiry', mode: 'balanced' });
  const authorization = guard.authorize({ toolName: 'adb.shell', channel: 'adb', operationType: 'structured_command' });
  assert.equal(authorization.allowed, true);
  assert.ok(authorization.expiresAt);
  guard.state.pendingAuthorizations[authorization.authorizationId].expiresAt = new Date(Date.now() - 1000).toISOString();
  const expired = guard.beginExecution({ authorizationId: authorization.authorizationId });
  assert.equal(expired.code, 'AUTHORIZATION_EXPIRED');
  const reused = guard.beginExecution({ authorizationId: authorization.authorizationId });
  assert.equal(reused.code, 'UNKNOWN_AUTHORIZATION');
});

test('authorization is consumed once and cannot execute concurrently', () => {
  const guard = new VisualOperationGuard(policy, { taskId: 't-single-use', mode: 'balanced' });
  const authorization = guard.authorize({ toolName: 'adb.shell', channel: 'adb', operationType: 'structured_command' });
  const firstBegin = guard.beginExecution({ authorizationId: authorization.authorizationId });
  assert.equal(firstBegin.code, 'EXECUTION_STARTED');
  assert.ok(firstBegin.resultExpiresAt);
  const secondBegin = guard.beginExecution({ authorizationId: authorization.authorizationId });
  assert.equal(secondBegin.code, 'AUTHORIZATION_ALREADY_CONSUMED');
  const recorded = guard.recordResult({ authorizationId: authorization.authorizationId, success: true, progress: true });
  assert.equal(recorded.code, 'RESULT_RECORDED');
  const replayedResult = guard.recordResult({ authorizationId: authorization.authorizationId, success: true, progress: true });
  assert.equal(replayedResult.code, 'RESULT_RECORDED');
  assert.equal(replayedResult.replayed, true);
  const conflictingResult = guard.recordResult({ authorizationId: authorization.authorizationId, success: false, progress: false });
  assert.equal(conflictingResult.code, 'RESULT_REPLAY_CONFLICT');
});

test('execution result window expires independently from start authorization', () => {
  const guard = new VisualOperationGuard(policy, { taskId: 't-result-expiry', mode: 'balanced' });
  const authorization = guard.authorize({ toolName: 'adb.shell', channel: 'adb', operationType: 'structured_command' });
  guard.beginExecution({ authorizationId: authorization.authorizationId });
  guard.state.activeExecutions[authorization.authorizationId].resultExpiresAt = new Date(Date.now() - 1000).toISOString();
  const expired = guard.recordResult({ authorizationId: authorization.authorizationId, success: true, progress: true });
  assert.equal(expired.code, 'EXECUTION_RESULT_EXPIRED');
  assert.equal(guard.snapshot().activeExecutions[authorization.authorizationId], undefined);
});

test('limits pending authorizations per task', () => {
  const limitedPolicy = JSON.parse(JSON.stringify(policy));
  limitedPolicy.authorization.maxPendingPerTask = 1;
  const guard = new VisualOperationGuard(limitedPolicy, { taskId: 't-pending-limit', mode: 'balanced' });
  const first = guard.authorize({ toolName: 'adb.shell', channel: 'adb', operationType: 'structured_command' });
  assert.equal(first.allowed, true);
  const second = guard.authorize({ toolName: 'api.call', channel: 'api', operationType: 'structured_integration' });
  assert.equal(second.allowed, false);
  assert.equal(second.code, 'TOO_MANY_PENDING_AUTHORIZATIONS');
});

test('limits active executions per task', () => {
  const limitedPolicy = JSON.parse(JSON.stringify(policy));
  limitedPolicy.authorization.maxActivePerTask = 1;
  const guard = new VisualOperationGuard(limitedPolicy, { taskId: 't-active-limit', mode: 'balanced' });
  const first = guard.authorize({ toolName: 'adb.shell', channel: 'adb', operationType: 'structured_command' });
  assert.equal(guard.beginExecution({ authorizationId: first.authorizationId }).allowed, true);
  const second = guard.authorize({ toolName: 'api.call', channel: 'api', operationType: 'structured_integration' });
  assert.equal(second.allowed, false);
  assert.equal(second.code, 'TOO_MANY_ACTIVE_EXECUTIONS');
});

test('structured tools do not consume visual budget', () => {
  const guard = new VisualOperationGuard(policy, { taskId: 't-structured-tool', mode: 'balanced' });
  const preflight = visualPreflight({ chosenChannel: 'playwright' });
  preflight.alternatives.structured_ui = {
    status: 'available', channelsChecked: ['playwright'], strategyId: 'stable-selector', reason: 'stable test id exists'
  };
  assert.equal(guard.preflight(preflight).allowed, true);
  const decision = guard.authorize({ toolName: 'playwright.click', channel: 'playwright', operationType: 'structured_ui', coordinateBased: false, targetId: 'save' });
  assert.equal(decision.allowed, true);
  assert.equal(decision.visualCostUnits, 0);
  beginAndRecord(guard, decision, { success: true, progress: true });
  assert.equal(guard.snapshot().counters.visualActions, 0);
});

test('loads legacy task snapshots without activeExecutions', () => {
  const original = new VisualOperationGuard(policy, { taskId: 't-state-migration', mode: 'balanced' });
  const state = original.snapshot();
  delete state.activeExecutions;
  delete state.completedExecutions;
  const restored = VisualOperationGuard.fromState(policy, state);
  assert.deepEqual(restored.snapshot().activeExecutions, {});
  assert.deepEqual(restored.snapshot().completedExecutions, {});
});
