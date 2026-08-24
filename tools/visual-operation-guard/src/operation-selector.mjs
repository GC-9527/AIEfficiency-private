export function selectOperationStrategy(operationMap, operationId, options = {}) {
  const operation = operationMap?.operations?.[operationId];
  if (!operation) return { found: false, code: 'OPERATION_NOT_FOUND', operationId };

  const platform = options.platform;
  const availableChannels = options.availableChannels ? new Set(options.availableChannels) : null;
  const allowVisual = options.allowVisual !== false;

  const candidates = operation.strategies
    .filter((strategy) => strategy.enabled !== false)
    .filter((strategy) => !platform || !Array.isArray(strategy.platforms) || strategy.platforms.includes(platform))
    .filter((strategy) => !availableChannels || availableChannels.has(strategy.channel))
    .filter((strategy) => allowVisual || !['visual', 'human'].includes(strategy.channel))
    .sort((a, b) => a.priority - b.priority);

  if (candidates.length === 0) {
    return {
      found: true,
      code: 'NO_AVAILABLE_STRATEGY',
      operationId,
      operation,
      humanHandoff: operation.humanHandoff ?? null
    };
  }

  return {
    found: true,
    code: 'STRATEGY_SELECTED',
    operationId,
    operation,
    strategy: candidates[0],
    alternatives: candidates.slice(1)
  };
}
