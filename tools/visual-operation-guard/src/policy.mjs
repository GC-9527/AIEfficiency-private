import { readFile } from 'node:fs/promises';
import { deepClone, deepMerge, nonEmptyString } from './utils.mjs';

export async function loadPolicy(path) {
  const raw = JSON.parse(await readFile(path, 'utf8'));
  validatePolicy(raw);
  return raw;
}

export function resolvePolicy(rawPolicy, mode) {
  validatePolicy(rawPolicy);
  const selectedMode = mode || rawPolicy.defaultMode;
  if (!rawPolicy.modes || !(selectedMode in rawPolicy.modes)) {
    throw new Error(`Unknown policy mode: ${selectedMode}`);
  }

  const base = deepClone(rawPolicy);
  delete base.modes;
  const resolved = deepMerge(base, rawPolicy.modes[selectedMode]);
  resolved.mode = selectedMode;
  return resolved;
}

export function validatePolicy(policy) {
  if (!policy || typeof policy !== 'object') throw new Error('Policy must be an object');
  if (!nonEmptyString(policy.version)) throw new Error('Policy.version is required');
  if (!nonEmptyString(policy.policyId)) throw new Error('Policy.policyId is required');
  if (!nonEmptyString(policy.defaultMode)) throw new Error('Policy.defaultMode is required');
  if (!Array.isArray(policy.channelOrder) || policy.channelOrder.length === 0) throw new Error('Policy.channelOrder must be non-empty');
  if (!policy.preflight || !Array.isArray(policy.preflight.requiredCategories)) throw new Error('Policy.preflight.requiredCategories is required');
  if (!policy.visual || typeof policy.visual !== 'object') throw new Error('Policy.visual is required');
  if (!policy.visual.costUnits || typeof policy.visual.costUnits !== 'object') throw new Error('Policy.visual.costUnits is required');
  if (!policy.authorization || typeof policy.authorization !== 'object') throw new Error('Policy.authorization is required');
  if (!Number.isInteger(policy.authorization.ttlSeconds) || policy.authorization.ttlSeconds < 1) throw new Error('Policy.authorization.ttlSeconds must be a positive integer');
  if (!Number.isInteger(policy.authorization.executionResultTtlSeconds) || policy.authorization.executionResultTtlSeconds < 1) throw new Error('Policy.authorization.executionResultTtlSeconds must be a positive integer');
  if (!Number.isInteger(policy.authorization.resultReplayTtlSeconds) || policy.authorization.resultReplayTtlSeconds < 1) throw new Error('Policy.authorization.resultReplayTtlSeconds must be a positive integer');
  if (!Number.isInteger(policy.authorization.maxPendingPerTask) || policy.authorization.maxPendingPerTask < 1) throw new Error('Policy.authorization.maxPendingPerTask must be a positive integer');
  if (!Number.isInteger(policy.authorization.maxActivePerTask) || policy.authorization.maxActivePerTask < 1) throw new Error('Policy.authorization.maxActivePerTask must be a positive integer');
  if (!Number.isInteger(policy.authorization.maxCompletedPerTask) || policy.authorization.maxCompletedPerTask < 1) throw new Error('Policy.authorization.maxCompletedPerTask must be a positive integer');
  if (policy.authorization.singleUse !== true) throw new Error('Policy.authorization.singleUse must be true');
  if (!policy.modes || typeof policy.modes !== 'object') throw new Error('Policy.modes is required');
  if (!(policy.defaultMode in policy.modes)) throw new Error('Policy.defaultMode must exist in policy.modes');

  const nonNegative = [
    'maxDiscoveryScreenshots', 'maxVerificationScreenshots', 'maxOtherScreenshots',
    'maxVisualActions', 'maxCoordinateActions', 'maxRetriesPerTarget',
    'maxSameScreenRepeats', 'maxNoProgressEvents',
    'handoffWhenEstimatedScreenTransitionsGt', 'handoffWhenEstimatedVisualActionsGt',
    'maxVisualCostUnits'
  ];
  for (const key of nonNegative) {
    const value = policy.visual[key];
    if (typeof value !== 'number' || value < 0) throw new Error(`Policy.visual.${key} must be a non-negative number`);
  }
  return true;
}
