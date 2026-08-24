import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardServer } from '../src/index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const policy = JSON.parse(await readFile(resolve(here, './fixtures/policy.json'), 'utf8'));

test('HTTP server requires auth and persists task state', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'aievog-'));
  const app = createGuardServer({ rawPolicy: policy, host: '127.0.0.1', port: 0, apiKey: 'test-secret', stateDir });
  const address = await app.listen();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const unauthorized = await fetch(`${base}/v1/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskId: 'http-task' }) });
    assert.equal(unauthorized.status, 401);
    const metricsUnauthorized = await fetch(`${base}/metrics`);
    assert.equal(metricsUnauthorized.status, 401);
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);

    const created = await fetch(`${base}/v1/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-secret' },
      body: JSON.stringify({ taskId: 'http-task', mode: 'balanced' })
    });
    assert.equal(created.status, 201);
    const createdBody = await created.json();
    assert.equal(createdBody.taskId, 'http-task');

    const duplicate = await fetch(`${base}/v1/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-secret' },
      body: JSON.stringify({ taskId: 'http-task', mode: 'balanced' })
    });
    assert.equal(duplicate.status, 409);
    assert.equal((await duplicate.json()).error, 'TASK_ALREADY_EXISTS');

    const loaded = await fetch(`${base}/v1/tasks/http-task`, { headers: { authorization: 'Bearer test-secret' } });
    assert.equal(loaded.status, 200);
    assert.equal((await loaded.json()).state.task.taskId, 'http-task');

    const authorized = await fetch(`${base}/v1/tasks/http-task/authorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-secret' },
      body: JSON.stringify({ toolName: 'adb.shell', channel: 'adb', operationType: 'structured_command' })
    });
    assert.equal(authorized.status, 200);
    const authorizationId = (await authorized.json()).decision.authorizationId;
    assert.ok(authorizationId);

    const beginRequest = () => fetch(`${base}/v1/tasks/http-task/begin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-secret' },
      body: JSON.stringify({ authorizationId })
    });
    const beginResponses = await Promise.all([beginRequest(), beginRequest()]);
    assert.deepEqual(beginResponses.map((response) => response.status), [200, 200]);
    const beginCodes = await Promise.all(beginResponses.map(async (response) => (await response.json()).decision.code));
    assert.deepEqual(beginCodes.sort(), ['AUTHORIZATION_ALREADY_CONSUMED', 'EXECUTION_STARTED']);

    const recorded = await fetch(`${base}/v1/tasks/http-task/result`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-secret' },
      body: JSON.stringify({ authorizationId, success: true, progress: true })
    });
    assert.equal(recorded.status, 200);
    assert.equal((await recorded.json()).decision.code, 'RESULT_RECORDED');

    const handoff = await fetch(`${base}/v1/tasks/http-task/handoff`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-secret' },
      body: JSON.stringify({ reason: 'manual step', reply: 'manual complete', stayAt: 'target page', checkpoint: 'before manual' })
    });
    assert.equal(handoff.status, 200);
    assert.equal((await handoff.json()).decision.code, 'NEEDS_HUMAN_INPUT');

    const resumed = await fetch(`${base}/v1/tasks/http-task/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-secret' },
      body: JSON.stringify({ confirmed: true, userReply: 'manual complete', checkpoint: 'target page open' })
    });
    assert.equal(resumed.status, 200);
    assert.equal((await resumed.json()).decision.code, 'RESUMED');
  } finally {
    await app.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('non-loopback bind requires an API key', () => {
  assert.throws(() => createGuardServer({ rawPolicy: policy, host: '0.0.0.0', port: 0, apiKey: '' }), /AIEVOG_API_KEY/);
});
