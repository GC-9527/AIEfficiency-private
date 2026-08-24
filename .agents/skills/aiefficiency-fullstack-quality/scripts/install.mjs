#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {
  SKILL_ROOT, parseArgs, resolveRepo, pathExists, ensureDir, nowId, writeJson,
  fileSha256, relativeTo
} from './lib/common.mjs';

const args = parseArgs();
const repo = resolveRepo(args.repo || '.');
const source = path.resolve(String(args.source || SKILL_ROOT));
const name = 'aiefficiency-fullstack-quality';
const canonical = path.join(repo, '.agents', 'skills', name);
const timestamp = nowId();
const actions = [];
const backups = [];
const dryRun = Boolean(args['dry-run']);
const backupRoot = path.join(repo, '.aiefficiency', 'skill-backups');

if (!pathExists(repo)) throw new Error(`Repository path does not exist: ${repo}`);
if (!pathExists(path.join(source, 'SKILL.md'))) throw new Error(`Source is not a skill directory: ${source}`);

const backupIgnore = path.join(backupRoot, '.gitignore');
if (!pathExists(backupIgnore)) {
  act(`create ${relativeTo(repo, backupIgnore)}`, () => {
    ensureDir(path.dirname(backupIgnore));
    fs.writeFileSync(backupIgnore, '*\n!.gitignore\n', 'utf8');
  }, 'backup-ignore');
}

if (path.resolve(source) !== path.resolve(canonical)) {
  if (pathExists(canonical)) {
    const same = sameSkill(source, canonical);
    if (!same || args.force) {
      const backup = path.join(backupRoot, 'canonical', `${name}-${timestamp}`);
      act(`backup existing canonical skill to ${relativeTo(repo, backup)}`, () => movePath(canonical, backup));
      backups.push(relativeTo(repo, backup));
    } else {
      actions.push({ action: 'canonical', status: 'UNCHANGED', path: relativeTo(repo, canonical), reason: 'SKILL.md hash matches source' });
    }
  }
  if (!pathExists(canonical) || args.force || !sameSkill(source, canonical)) {
    const temp = `${canonical}.installing-${process.pid}`;
    act(`copy skill to ${relativeTo(repo, canonical)}`, () => {
      removePath(temp);
      ensureDir(path.dirname(temp));
      fs.cpSync(source, temp, { recursive: true, dereference: false, filter: (src) => !shouldExclude(src, source) });
      if (pathExists(canonical)) removePath(canonical);
      fs.renameSync(temp, canonical);
    });
  }
} else {
  actions.push({ action: 'canonical', status: 'UNCHANGED', path: relativeTo(repo, canonical), reason: 'installer is running from canonical directory' });
}

const claudeAdapter = path.join(repo, '.claude', 'skills', name);
installLinkAdapter('claude', claudeAdapter, canonical);

if (args['legacy-adapters']) {
  installLinkAdapter('gemini', path.join(repo, '.gemini', 'skills', name), canonical);
  installLinkAdapter('opencode', path.join(repo, '.opencode', 'skills', name), canonical);
}

const qualityRoot = path.join(repo, '.aiefficiency', 'quality');
const projectConfig = path.join(qualityRoot, 'quality-gate.config.json');
if (!pathExists(projectConfig)) {
  act(`create ${relativeTo(repo, projectConfig)}`, () => {
    ensureDir(path.dirname(projectConfig));
    fs.copyFileSync(path.join(canonical, 'config', 'quality-gate.config.json'), projectConfig);
  });
} else actions.push({ action: 'project-config', status: 'PRESERVED', path: relativeTo(repo, projectConfig) });

const projectSchema = path.join(qualityRoot, 'quality-gate.schema.json');
if (!pathExists(projectSchema)) {
  act(`create ${relativeTo(repo, projectSchema)}`, () => {
    ensureDir(path.dirname(projectSchema));
    fs.copyFileSync(path.join(canonical, 'config', 'quality-gate.schema.json'), projectSchema);
  });
} else actions.push({ action: 'project-schema', status: 'PRESERVED', path: relativeTo(repo, projectSchema) });

const qualityIgnore = path.join(qualityRoot, '.gitignore');
if (!pathExists(qualityIgnore)) {
  act(`create ${relativeTo(repo, qualityIgnore)}`, () => {
    ensureDir(path.dirname(qualityIgnore));
    fs.writeFileSync(qualityIgnore, [
      'artifacts/',
      'reports/',
      'screenshots/current/',
      'screenshots/diff/',
      'skill-install.json',
      '*.tmp-*',
      ''
    ].join('\n'), 'utf8');
  }, 'quality-ignore');
} else actions.push({ action: 'quality-ignore', status: 'PRESERVED', path: relativeTo(repo, qualityIgnore) });

if (!args['no-agents']) mergeAgentsFile();
else actions.push({ action: 'AGENTS.md', status: 'SKIPPED', reason: '--no-agents' });

const manifest = {
  schemaVersion: 1,
  installedAt: new Date().toISOString(),
  version: fs.readFileSync(path.join(source, 'VERSION'), 'utf8').trim(),
  source: path.resolve(source) === path.resolve(canonical) ? relativeTo(repo, source) : '<external-package>',
  canonical: relativeTo(repo, canonical),
  actions,
  backups,
  dryRun
};
const manifestFile = path.join(qualityRoot, 'skill-install.json');
if (!dryRun) writeJson(manifestFile, manifest);
console.log(JSON.stringify({ status: 'PASS', ...manifest, manifest: relativeTo(repo, manifestFile) }, null, 2));

function installLinkAdapter(host, adapter, target) {
  if (entryExists(adapter)) {
    let same = false;
    try { same = path.resolve(fs.realpathSync(adapter)) === path.resolve(fs.realpathSync(target)); } catch {}
    if (same) {
      actions.push({ action: `${host}-adapter`, status: 'UNCHANGED', path: relativeTo(repo, adapter), target: relativeTo(repo, target) });
      return;
    }
    const backup = path.join(backupRoot, 'adapters', `${host}-${name}-${timestamp}`);
    act(`backup existing ${host} adapter to ${relativeTo(repo, backup)}`, () => movePath(adapter, backup));
    backups.push(relativeTo(repo, backup));
  }
  act(`link ${host} adapter ${relativeTo(repo, adapter)} -> ${relativeTo(repo, target)}`, () => {
    ensureDir(path.dirname(adapter));
    if (process.platform === 'win32') fs.symlinkSync(path.resolve(target), adapter, 'junction');
    else fs.symlinkSync(path.relative(path.dirname(adapter), target), adapter, 'dir');
  }, `${host}-adapter`);
}

function mergeAgentsFile() {
  const agentsFile = path.join(repo, 'AGENTS.md');
  const snippetBase = pathExists(canonical) ? canonical : source;
  const snippetFile = path.join(snippetBase, 'assets', 'AGENTS.snippet.md');
  const snippet = fs.readFileSync(snippetFile, 'utf8').trim();
  const start = '<!-- AIEFFICIENCY_FULLSTACK_QUALITY:START -->';
  const end = '<!-- AIEFFICIENCY_FULLSTACK_QUALITY:END -->';
  const current = pathExists(agentsFile) ? fs.readFileSync(agentsFile, 'utf8') : '';
  let next;
  const startAt = current.indexOf(start);
  const endAt = current.indexOf(end);
  if (startAt >= 0 && endAt >= startAt) next = `${current.slice(0, startAt)}${snippet}${current.slice(endAt + end.length)}`;
  else next = `${current.trimEnd()}${current.trim() ? '\n\n' : ''}${snippet}\n`;
  if (next === current) {
    actions.push({ action: 'AGENTS.md', status: 'UNCHANGED', path: 'AGENTS.md' });
    return;
  }
  if (pathExists(agentsFile)) {
    const backup = path.join(backupRoot, 'agents', `AGENTS.md-${timestamp}.bak`);
    act(`backup AGENTS.md to ${relativeTo(repo, backup)}`, () => {
      ensureDir(path.dirname(backup));
      fs.copyFileSync(agentsFile, backup);
    });
    backups.push(relativeTo(repo, backup));
  }
  act('merge quality gate marker block into AGENTS.md', () => fs.writeFileSync(agentsFile, next, 'utf8'), 'AGENTS.md');
}

function sameSkill(a, b) {
  try {
    const left = skillTreeSnapshot(a);
    const right = skillTreeSnapshot(b);
    if (left.length !== right.length) return false;
    return left.every((item, index) => item === right[index]);
  } catch {
    return false;
  }
}

function skillTreeSnapshot(root) {
  const rows = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const rel = path.relative(root, full).replaceAll('\\', '/');
      if (!rel || shouldExclude(full, root)) continue;
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) rows.push(`${rel}:${fileSha256(full)}`);
      else if (entry.isSymbolicLink()) rows.push(`${rel}:link:${fs.readlinkSync(full)}`);
    }
  }
  return rows.sort();
}

function shouldExclude(src, root) {
  const rel = path.relative(root, src).replaceAll('\\', '/');
  return rel === 'node_modules' || rel.startsWith('node_modules/') || rel === '.git' || rel.startsWith('.git/') || rel.endsWith('.zip');
}

function movePath(from, to) {
  ensureDir(path.dirname(to));
  try { fs.renameSync(from, to); }
  catch {
    fs.cpSync(from, to, { recursive: true, dereference: false });
    removePath(from);
  }
}

function removePath(target) {
  if (!entryExists(target)) return;
  fs.rmSync(target, { recursive: true, force: true });
}

function entryExists(target) {
  try { fs.lstatSync(target); return true; }
  catch { return false; }
}

function act(description, fn, action = 'install') {
  if (dryRun) actions.push({ action, status: 'DRY_RUN', description });
  else {
    fn();
    actions.push({ action, status: 'DONE', description });
  }
}
