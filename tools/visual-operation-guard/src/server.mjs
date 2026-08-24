import { createServer } from 'node:http';
import { URL } from 'node:url';
import { VisualOperationGuard } from './guard.mjs';
import { FileStateStore } from './store.mjs';
import { GuardMetrics } from './metrics.mjs';
import { constantTimeEqual, isLoopback, nowIso, redactSecrets, sanitizeTaskId } from './utils.mjs';

const MAX_BODY_BYTES = 1024 * 1024;

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error('Request body exceeds 1 MiB');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('Invalid JSON body');
    error.statusCode = 400;
    throw error;
  }
}

function sendJson(res, statusCode, body) {
  const json = `${JSON.stringify(body, null, 2)}\n`;
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  res.end(json);
}

function bearerToken(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  return header.slice(7);
}

export function createGuardServer(options) {
  const {
    rawPolicy,
    host = '127.0.0.1',
    port = 18081,
    apiKey = process.env.AIEVOG_API_KEY || '',
    stateDir = '.aievog-state'
  } = options;

  if (!rawPolicy) throw new Error('rawPolicy is required');
  if (!isLoopback(host) && !apiKey) throw new Error('AIEVOG_API_KEY is required when binding to a non-loopback host');

  const store = new FileStateStore(stateDir, { maxStateBytes: rawPolicy.audit?.maxTaskStateBytes || 262144 });
  const metrics = new GuardMetrics();
  const guards = new Map();
  const taskQueues = new Map();

  function enqueueTask(taskId, work) {
    const previous = taskQueues.get(taskId) || Promise.resolve();
    const run = previous.catch(() => undefined).then(work);
    taskQueues.set(taskId, run);
    return run.finally(() => {
      if (taskQueues.get(taskId) === run) taskQueues.delete(taskId);
    });
  }

  async function getGuard(taskId) {
    if (guards.has(taskId)) return guards.get(taskId);
    const state = await store.load(taskId);
    if (!state) return null;
    const guard = VisualOperationGuard.fromState(rawPolicy, state);
    guards.set(taskId, guard);
    return guard;
  }

  async function persist(guard, requestMeta, decision) {
    const snapshot = guard.snapshot();
    await store.save(guard.taskId, snapshot);
    await store.appendAudit({ at: nowIso(), taskId: guard.taskId, request: redactSecrets(requestMeta), decision: redactSecrets(decision) });
  }

  async function applyAction(guard, action, body) {
    if (action === 'preflight') return guard.preflight(body);
    if (action === 'authorize') return guard.authorize(body);
    if (action === 'begin') return guard.beginExecution(body);
    if (action === 'result') return guard.recordResult(body);
    if (action === 'handoff') return guard.requestHandoff(body);
    if (action === 'resume') return guard.resumeAfterHandoff(body);
    if (action === 'checkpoint') return guard.markCheckpoint(body.checkpoint);
    throw new Error(`Unsupported action: ${action}`);
  }

  const server = createServer(async (req, res) => {
    const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const path = requestUrl.pathname;

    try {
      if (path === '/healthz' && req.method === 'GET') {
        return sendJson(res, 200, { status: 'ok', version: '1.0.0', at: nowIso() });
      }
      if (path === '/metrics' && req.method === 'GET') {
        if (apiKey && !constantTimeEqual(bearerToken(req), apiKey)) {
          metrics.inc('aievog_http_requests_total', { status: 401 });
          return sendJson(res, 401, { error: 'UNAUTHORIZED' });
        }
        const text = metrics.render();
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store' });
        return res.end(text);
      }
      if (apiKey && !constantTimeEqual(bearerToken(req), apiKey)) {
        metrics.inc('aievog_http_requests_total', { status: 401 });
        return sendJson(res, 401, { error: 'UNAUTHORIZED' });
      }

      if (path === '/v1/tasks' && req.method === 'POST') {
        const body = await readJson(req);
        const candidate = new VisualOperationGuard(rawPolicy, body);
        const outcome = await enqueueTask(candidate.taskId, async () => {
          const existing = await getGuard(candidate.taskId);
          if (existing) {
            return {
              statusCode: 409,
              body: { error: 'TASK_ALREADY_EXISTS', taskId: candidate.taskId, state: existing.snapshot() }
            };
          }
          guards.set(candidate.taskId, candidate);
          const response = { taskId: candidate.taskId, state: candidate.snapshot() };
          await persist(candidate, { method: req.method, path, body }, response);
          metrics.inc('aievog_tasks_created_total', { mode: candidate.task.mode, unattended: candidate.task.unattended });
          return { statusCode: 201, body: response };
        });
        metrics.inc('aievog_http_requests_total', { status: outcome.statusCode });
        return sendJson(res, outcome.statusCode, outcome.body);
      }

      const match = path.match(/^\/v1\/tasks\/([^/]+)(?:\/(preflight|authorize|begin|result|handoff|resume|checkpoint))?$/);
      if (!match) {
        metrics.inc('aievog_http_requests_total', { status: 404 });
        return sendJson(res, 404, { error: 'NOT_FOUND' });
      }

      const requestedTaskId = decodeURIComponent(match[1]);
      const taskId = sanitizeTaskId(requestedTaskId);
      if (taskId !== requestedTaskId) {
        metrics.inc('aievog_http_requests_total', { status: 400 });
        return sendJson(res, 400, { error: 'INVALID_TASK_ID', taskId: requestedTaskId });
      }
      const action = match[2] || null;

      if (!action && req.method === 'GET') {
        const response = await enqueueTask(taskId, async () => {
          const guard = await getGuard(taskId);
          return guard ? { statusCode: 200, body: { taskId, state: guard.snapshot() } } : { statusCode: 404, body: { error: 'TASK_NOT_FOUND', taskId } };
        });
        metrics.inc('aievog_http_requests_total', { status: response.statusCode });
        return sendJson(res, response.statusCode, response.body);
      }
      if (!action || req.method !== 'POST') {
        metrics.inc('aievog_http_requests_total', { status: 405 });
        return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
      }

      const body = await readJson(req);
      const outcome = await enqueueTask(taskId, async () => {
        const guard = await getGuard(taskId);
        if (!guard) return { statusCode: 404, body: { error: 'TASK_NOT_FOUND', taskId } };

        const decision = await applyAction(guard, action, body);
        await persist(guard, { method: req.method, path, body }, decision);
        metrics.inc('aievog_decisions_total', { code: decision.code, allowed: decision.allowed });
        if (action === 'authorize' && decision.allowed) metrics.inc('aievog_authorizations_total', { operation: body.operationType || 'unknown', channel: body.channel || 'unknown' });
        if (action === 'begin' && decision.allowed) metrics.inc('aievog_executions_started_total', { mode: guard.task.mode });
        if (['NEEDS_HUMAN_INPUT', 'BLOCKED_NEEDS_HUMAN'].includes(decision.code)) metrics.inc('aievog_handoffs_total', { code: decision.code, mode: guard.task.mode });
        if (decision.visualCostUnits) metrics.inc('aievog_visual_cost_units_total', { mode: guard.task.mode }, decision.visualCostUnits);
        return { statusCode: 200, body: { decision, state: guard.snapshot() } };
      });

      metrics.inc('aievog_http_requests_total', { status: outcome.statusCode });
      return sendJson(res, outcome.statusCode, outcome.body);
    } catch (error) {
      const statusCode = error.statusCode || 500;
      metrics.inc('aievog_http_requests_total', { status: statusCode });
      const publicMessage = statusCode === 500 && process.env.AIEVOG_DEBUG !== 'true' ? 'Internal server error' : error.message;
      return sendJson(res, statusCode, { error: statusCode === 500 ? 'INTERNAL_ERROR' : error.message, message: publicMessage });
    }
  });

  return {
    server,
    host,
    port,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve(server.address());
        });
      });
    },
    close() {
      return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}
