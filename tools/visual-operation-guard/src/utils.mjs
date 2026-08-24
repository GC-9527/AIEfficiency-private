import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export function nowIso() {
  return new Date().toISOString();
}

export function deepClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export function deepMerge(base, override) {
  if (override === undefined) return deepClone(base);
  if (base === null || override === null) return deepClone(override);
  if (Array.isArray(base) || Array.isArray(override)) return deepClone(override);
  if (typeof base !== 'object' || typeof override !== 'object') return deepClone(override);

  const result = { ...deepClone(base) };
  for (const [key, value] of Object.entries(override)) {
    result[key] = key in result ? deepMerge(result[key], value) : deepClone(value);
  }
  return result;
}

export function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export function sanitizeTaskId(taskId) {
  if (!nonEmptyString(taskId)) throw new Error('taskId must be a non-empty string');
  const sanitized = taskId.trim().replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  if (!sanitized || sanitized === '.' || sanitized === '..') throw new Error('taskId is invalid');
  return sanitized;
}

export function stableHash(value) {
  const input = typeof value === 'string' ? value : JSON.stringify(value);
  return createHash('sha256').update(input).digest('hex');
}

export function constantTimeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const SECRET_KEY = /(password|passwd|token|secret|cookie|authorization|api[_-]?key|private[_-]?key|session)/i;

export function redactSecrets(value, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, seen));

  const output = {};
  for (const [key, child] of Object.entries(value)) {
    output[key] = SECRET_KEY.test(key) ? '[REDACTED]' : redactSecrets(child, seen);
  }
  return output;
}

export async function atomicWriteJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const body = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(temp, body, { encoding: 'utf8', mode: 0o600 });
  await rename(temp, path);
}

export function boundedPush(array, value, max = 200) {
  array.push(value);
  if (array.length > max) array.splice(0, array.length - max);
}

export function isLoopback(host) {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}
