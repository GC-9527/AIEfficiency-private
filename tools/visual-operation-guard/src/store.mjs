import { appendFile, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteJson, redactSecrets, sanitizeTaskId } from './utils.mjs';

export class FileStateStore {
  constructor(rootDir, options = {}) {
    this.rootDir = rootDir;
    this.maxStateBytes = options.maxStateBytes || 262144;
  }

  statePath(taskId) {
    return join(this.rootDir, 'tasks', `${sanitizeTaskId(taskId)}.json`);
  }

  auditPath() {
    return join(this.rootDir, 'audit', `${new Date().toISOString().slice(0, 10)}.jsonl`);
  }

  async save(taskId, state) {
    const body = JSON.stringify(state);
    if (Buffer.byteLength(body, 'utf8') > this.maxStateBytes) throw new Error(`Task state exceeds ${this.maxStateBytes} bytes`);
    await atomicWriteJson(this.statePath(taskId), state);
  }

  async load(taskId) {
    try {
      return JSON.parse(await readFile(this.statePath(taskId), 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  async appendAudit(event) {
    const path = this.auditPath();
    await mkdir(join(this.rootDir, 'audit'), { recursive: true });
    await appendFile(path, `${JSON.stringify(redactSecrets(event))}\n`, { encoding: 'utf8', mode: 0o600 });
  }

  async listTaskIds() {
    const dir = join(this.rootDir, 'tasks');
    try {
      const entries = await readdir(dir);
      return entries.filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5));
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
  }

  async size(taskId) {
    try {
      return (await stat(this.statePath(taskId))).size;
    } catch (error) {
      if (error?.code === 'ENOENT') return 0;
      throw error;
    }
  }
}
