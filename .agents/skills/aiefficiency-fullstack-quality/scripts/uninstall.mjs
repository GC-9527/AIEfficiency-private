#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, resolveRepo, pathExists, ensureDir, nowId, relativeTo } from './lib/common.mjs';

const args = parseArgs();
const repo = resolveRepo(args.repo || '.');
const name = 'aiefficiency-fullstack-quality';
const canonical = path.join(repo, '.agents', 'skills', name);
const timestamp = nowId();
const actions = [];
const backupRoot = path.join(repo, '.aiefficiency', 'skill-backups');

removeAdapter(path.join(repo, '.claude', 'skills', name), 'claude');
removeAdapter(path.join(repo, '.gemini', 'skills', name), 'gemini');
removeAdapter(path.join(repo, '.opencode', 'skills', name), 'opencode');
removeAgentsBlock();

if (!args['keep-skill'] && pathExists(canonical)) {
  fs.rmSync(canonical, { recursive: true, force: true });
  actions.push({ action: 'canonical', status: 'REMOVED', path: relativeTo(repo, canonical) });
} else actions.push({ action: 'canonical', status: pathExists(canonical) ? 'PRESERVED' : 'ABSENT', path: relativeTo(repo, canonical) });

if (args['purge-evidence']) {
  const root = path.join(repo, '.aiefficiency', 'quality');
  if (pathExists(root)) fs.rmSync(root, { recursive: true, force: true });
  actions.push({ action: 'evidence', status: 'REMOVED', path: relativeTo(repo, root) });
} else actions.push({ action: 'evidence', status: 'PRESERVED', path: '.aiefficiency/quality' });

if (args['purge-backups']) {
  if (pathExists(backupRoot)) fs.rmSync(backupRoot, { recursive: true, force: true });
  actions.push({ action: 'backups', status: 'REMOVED', path: relativeTo(repo, backupRoot) });
} else actions.push({ action: 'backups', status: pathExists(backupRoot) ? 'PRESERVED' : 'ABSENT', path: relativeTo(repo, backupRoot) });

console.log(JSON.stringify({ status: 'PASS', repo: '.', actions }, null, 2));

function removeAdapter(adapter, host) {
  if (!entryExists(adapter)) {
    actions.push({ action: `${host}-adapter`, status: 'ABSENT', path: relativeTo(repo, adapter) });
    return;
  }
  let safe = false;
  try {
    const stat = fs.lstatSync(adapter);
    safe = stat.isSymbolicLink() || (pathExists(canonical) && path.resolve(fs.realpathSync(adapter)) === path.resolve(fs.realpathSync(canonical)));
  } catch {}
  if (!safe) {
    actions.push({ action: `${host}-adapter`, status: 'PRESERVED', path: relativeTo(repo, adapter), reason: 'not a verified link to canonical skill' });
    return;
  }
  fs.rmSync(adapter, { recursive: true, force: true });
  actions.push({ action: `${host}-adapter`, status: 'REMOVED', path: relativeTo(repo, adapter) });
}

function removeAgentsBlock() {
  const file = path.join(repo, 'AGENTS.md');
  if (!pathExists(file)) {
    actions.push({ action: 'AGENTS.md', status: 'ABSENT' });
    return;
  }
  const start = '<!-- AIEFFICIENCY_FULLSTACK_QUALITY:START -->';
  const end = '<!-- AIEFFICIENCY_FULLSTACK_QUALITY:END -->';
  const current = fs.readFileSync(file, 'utf8');
  const startAt = current.indexOf(start);
  const endAt = current.indexOf(end);
  if (startAt < 0 || endAt < startAt) {
    actions.push({ action: 'AGENTS.md', status: 'UNCHANGED', reason: 'marker block not found' });
    return;
  }
  const backup = path.join(backupRoot, 'agents', `AGENTS.md-${timestamp}.bak`);
  ensureDir(path.dirname(backup));
  fs.copyFileSync(file, backup);
  const next = `${current.slice(0, startAt)}${current.slice(endAt + end.length)}`.replace(/\n{3,}/g, '\n\n').trimEnd();
  fs.writeFileSync(file, next ? `${next}\n` : '', 'utf8');
  actions.push({ action: 'AGENTS.md', status: 'UPDATED', backup: relativeTo(repo, backup) });
}

function entryExists(target) {
  try { fs.lstatSync(target); return true; }
  catch { return false; }
}
