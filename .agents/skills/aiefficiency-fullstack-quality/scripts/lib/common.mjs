import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const SKILL_ROOT = path.resolve(SCRIPT_DIR, '..', '..');

export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      out._.push(token);
      continue;
    }
    const raw = token.slice(2);
    if (raw.startsWith('no-')) {
      out[raw] = true;
      out[raw.slice(3)] = false;
      continue;
    }
    const eq = raw.indexOf('=');
    if (eq >= 0) {
      out[raw.slice(0, eq)] = coerce(raw.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[raw] = coerce(next);
      i += 1;
    } else {
      out[raw] = true;
    }
  }
  return out;
}

function coerce(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

export function normalizeSlash(value) {
  return String(value).replaceAll('\\', '/').replace(/^\.\//, '');
}

export function resolveRepo(input = '.') {
  return path.resolve(String(input));
}

export function pathExists(file) {
  try {
    fs.accessSync(file);
    return true;
  } catch {
    return false;
  }
}

export function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Cannot read JSON ${file}: ${error.message}`);
  }
}

export function writeJson(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

export function writeText(file, text) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, String(text), 'utf8');
  fs.renameSync(tmp, file);
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function nowId(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

export function sha256(value) {
  const hash = crypto.createHash('sha256');
  hash.update(value);
  return hash.digest('hex');
}

export function fileSha256(file) {
  return sha256(fs.readFileSync(file));
}

export function deepMerge(base, override) {
  if (Array.isArray(override)) return override.map(clone);
  if (!isPlainObject(override)) return clone(override);
  const out = isPlainObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(out[key])) out[key] = deepMerge(out[key], value);
    else out[key] = clone(value);
  }
  return out;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clone(v)]));
  return value;
}

export function loadConfig(repo, explicitPath) {
  const defaultPath = path.join(SKILL_ROOT, 'config', 'quality-gate.config.json');
  const projectPath = explicitPath
    ? path.resolve(repo, String(explicitPath))
    : path.join(repo, '.aiefficiency', 'quality', 'quality-gate.config.json');
  const defaults = readJson(defaultPath);
  const project = pathExists(projectPath) ? readJson(projectPath) : {};
  const config = deepMerge(defaults, project);
  config.__paths = { defaultPath, projectPath: pathExists(projectPath) ? projectPath : null };
  return config;
}

export function outputPaths(repo, config) {
  const root = path.resolve(repo, config.project?.outputRoot || '.aiefficiency/quality');
  const result = {
    root,
    artifacts: path.join(root, 'artifacts'),
    baselines: path.join(root, 'baselines'),
    reports: path.join(root, 'reports'),
    screenshots: path.join(root, 'screenshots')
  };
  Object.values(result).forEach(ensureDir);
  return result;
}

export function globToRegExp(glob) {
  const input = normalizeSlash(glob);
  let regex = '^';
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    const next = input[i + 1];
    if (ch === '*' && next === '*') {
      const after = input[i + 2];
      if (after === '/') {
        regex += '(?:.*/)?';
        i += 2;
      } else {
        regex += '.*';
        i += 1;
      }
    } else if (ch === '*') regex += '[^/]*';
    else if (ch === '?') regex += '[^/]';
    else if ('\\.^$+{}()|[]'.includes(ch)) regex += `\\${ch}`;
    else regex += ch;
  }
  regex += '$';
  return new RegExp(regex);
}

const globCache = new Map();
export function matchesGlob(file, glob) {
  let re = globCache.get(glob);
  if (!re) {
    re = globToRegExp(glob);
    globCache.set(glob, re);
  }
  return re.test(normalizeSlash(file));
}

export function matchesAny(file, globs = []) {
  return globs.some((glob) => matchesGlob(file, glob));
}

export function walkFiles(root, options = {}) {
  const {
    extensions = null,
    ignore = [],
    maxFiles = 20000,
    followSymlinks = false
  } = options;
  const files = [];
  const stack = [root];
  while (stack.length && files.length < maxFiles) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const rel = normalizeSlash(path.relative(root, full));
      if (matchesAny(rel, ignore) || matchesAny(`${rel}/`, ignore)) continue;
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isSymbolicLink() && followSymlinks) {
        try {
          const stat = fs.statSync(full);
          if (stat.isDirectory()) stack.push(full);
          else if (!extensions || extensions.includes(path.extname(entry.name).toLowerCase())) files.push(full);
        } catch {}
      } else if (entry.isFile()) {
        if (!extensions || extensions.includes(path.extname(entry.name).toLowerCase())) files.push(full);
      }
      if (files.length >= maxFiles) break;
    }
  }
  return files;
}

export function run(command, options = {}) {
  const {
    cwd = process.cwd(),
    timeoutMs = 120000,
    env = {},
    echo = false,
    maxBuffer = 16 * 1024 * 1024
  } = options;
  if (echo) process.stdout.write(`$ ${command}\n`);
  const startedAt = Date.now();
  const result = spawnSync(command, {
    cwd,
    shell: true,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer,
    env: { ...process.env, ...env }
  });
  return {
    command,
    cwd,
    exitCode: Number.isInteger(result.status) ? result.status : (result.error ? 2 : 0),
    signal: result.signal || null,
    stdout: result.stdout || '',
    stderr: result.stderr || (result.error ? String(result.error.message) : ''),
    durationMs: Date.now() - startedAt,
    timedOut: result.error?.code === 'ETIMEDOUT'
  };
}

export function commandExists(command) {
  const probe = process.platform === 'win32' ? `where ${command}` : `command -v ${command}`;
  return run(probe, { timeoutMs: 5000 }).exitCode === 0;
}

export function git(repo, args, options = {}) {
  const quoted = args.map(shellQuote).join(' ');
  return run(`git ${quoted}`, { cwd: repo, timeoutMs: options.timeoutMs || 30000 });
}

export const EMPTY_GIT_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export function isGitRepo(repo) {
  return git(repo, ['rev-parse', '--is-inside-work-tree']).stdout.trim() === 'true';
}

export function validateGitBase(repo, requestedBase = 'HEAD') {
  const base = String(requestedBase || 'HEAD');
  if (!isGitRepo(repo)) return { ok: false, requestedBase: base, resolvedBase: null, reason: 'Repository is not a Git worktree.' };
  const probe = git(repo, ['rev-parse', '--verify', `${base}^{commit}`]);
  if (probe.exitCode === 0) return { ok: true, requestedBase: base, resolvedBase: base, commit: probe.stdout.trim(), emptyRepository: false };
  const head = git(repo, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (base === 'HEAD' && head.exitCode !== 0) {
    return { ok: true, requestedBase: base, resolvedBase: EMPTY_GIT_TREE, commit: null, emptyRepository: true };
  }
  return {
    ok: false,
    requestedBase: base,
    resolvedBase: null,
    reason: `Git base cannot be resolved to a commit: ${base}`,
    detail: probe.stderr.trim() || probe.stdout.trim() || null
  };
}

export function getGitState(repo) {
  if (!isGitRepo(repo)) return { isGitRepo: false, branch: null, head: null, status: [] };
  const branch = git(repo, ['branch', '--show-current']).stdout.trim() || '(detached)';
  const head = git(repo, ['rev-parse', 'HEAD']).stdout.trim();
  const status = git(repo, ['status', '--short', '--branch']).stdout.trimEnd().split(/\r?\n/).filter(Boolean);
  return { isGitRepo: true, branch, head, status };
}

export function getChangedFiles(repo, base = 'HEAD', includeUntracked = true) {
  if (!isGitRepo(repo)) return [];
  const result = git(repo, ['diff', '--name-status', '--find-renames', String(base), '--']);
  const changes = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const status = parts[0];
    if (status.startsWith('R') || status.startsWith('C')) {
      changes.push({ status: status[0], oldPath: normalizeSlash(parts[1]), path: normalizeSlash(parts[2]), untracked: false });
    } else {
      changes.push({ status: status[0], path: normalizeSlash(parts[1]), untracked: false });
    }
  }
  if (includeUntracked) {
    const untracked = git(repo, ['ls-files', '--others', '--exclude-standard']).stdout.split(/\r?\n/).filter(Boolean);
    for (const file of untracked) {
      const normalized = normalizeSlash(file);
      if (!changes.some((item) => item.path === normalized)) changes.push({ status: '?', path: normalized, untracked: true });
    }
  }
  return changes;
}

export function getAddedLineRanges(repo, base, file, untracked = false) {
  if (untracked) {
    try {
      const count = fs.readFileSync(path.join(repo, file), 'utf8').split(/\r?\n/).length;
      return [{ start: 1, end: Math.max(1, count) }];
    } catch {
      return [];
    }
  }
  const result = git(repo, ['diff', '--unified=0', String(base), '--', file]);
  const ranges = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!match) continue;
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    if (count > 0) ranges.push({ start, end: start + count - 1 });
  }
  return ranges;
}

export function lineInRanges(line, ranges = []) {
  return ranges.some((range) => line >= range.start && line <= range.end);
}

export function shellQuote(value) {
  const text = String(value);
  if (process.platform === 'win32') return `"${text.replaceAll('"', '\\"')}"`;
  return `'${text.replaceAll("'", "'\\''")}'`;
}

export function relativeTo(repo, file) {
  return normalizeSlash(path.relative(repo, file));
}

export function fileUrl(file) {
  return pathToFileURL(file).href;
}

export function truncate(text, max = 4000) {
  const value = String(text || '');
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n...<truncated ${value.length - max} chars>`;
}

export function humanBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'n/a';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export function statusRank(status) {
  return ({ PASS: 0, SKIPPED: 1, NO_BASELINE: 1, WARN: 2, PASS_WITH_WARNINGS: 2, FAIL: 3, ERROR: 4 }[status] ?? 2);
}

export function worstStatus(statuses) {
  return [...statuses].sort((a, b) => statusRank(b) - statusRank(a))[0] || 'PASS';
}

export function markdownTable(headers, rows) {
  const clean = (value) => String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', '<br>');
  return [
    `| ${headers.map(clean).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(clean).join(' | ')} |`)
  ].join('\n');
}

export function pruneOldFiles(dir, keep = 20, matcher = () => true) {
  if (!pathExists(dir)) return;
  const files = fs.readdirSync(dir)
    .map((name) => ({ name, full: path.join(dir, name) }))
    .filter((item) => {
      try { return fs.statSync(item.full).isFile() && matcher(item.name); } catch { return false; }
    })
    .sort((a, b) => fs.statSync(b.full).mtimeMs - fs.statSync(a.full).mtimeMs);
  for (const item of files.slice(Math.max(0, keep))) {
    try { fs.unlinkSync(item.full); } catch {}
  }
}
