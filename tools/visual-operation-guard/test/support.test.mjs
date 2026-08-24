import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { redactSecrets, selectOperationStrategy } from '../src/index.mjs';

const here = dirname(fileURLToPath(import.meta.url));

test('selects the lowest priority enabled strategy', async () => {
  const operationMap = JSON.parse(await readFile(resolve(here, './fixtures/operation-map.json'), 'utf8'));
  const result = selectOperationStrategy(operationMap, 'open_ai_workbench_model_settings', { platform: 'web' });
  assert.equal(result.code, 'STRATEGY_SELECTED');
  assert.equal(result.strategy.id, 'model-settings-route');
});

test('filters visual strategy when disallowed', async () => {
  const operationMap = JSON.parse(await readFile(resolve(here, './fixtures/operation-map.json'), 'utf8'));
  const result = selectOperationStrategy(operationMap, 'open_ai_workbench_model_settings', {
    platform: 'web', availableChannels: ['visual'], allowVisual: false
  });
  assert.equal(result.code, 'NO_AVAILABLE_STRATEGY');
});

test('redacts nested secrets', () => {
  const result = redactSecrets({ user: 'u', password: 'p', nested: { authorization: 'Bearer x', safe: 1 }, list: [{ apiKey: 'k' }] });
  assert.equal(result.password, '[REDACTED]');
  assert.equal(result.nested.authorization, '[REDACTED]');
  assert.equal(result.list[0].apiKey, '[REDACTED]');
  assert.equal(result.nested.safe, 1);
});
