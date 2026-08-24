#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { SKILL_ROOT, parseArgs, pathExists, readJson, walkFiles, normalizeSlash } from './lib/common.mjs';

const args = parseArgs();
const root = path.resolve(String(args.root || SKILL_ROOT));
const errors = [];
const warnings = [];

function fail(message) { errors.push(message); }
function warn(message) { warnings.push(message); }

const skillFile = path.join(root, 'SKILL.md');
if (!pathExists(skillFile)) fail('SKILL.md is missing.');
let frontmatter = {};
let body = '';
if (pathExists(skillFile)) {
  const text = fs.readFileSync(skillFile, 'utf8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (!match) fail('SKILL.md must start with YAML frontmatter.');
  else {
    frontmatter = parseSimpleYaml(match[1]);
    body = match[2];
  }
}

const allowedFields = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);
for (const key of Object.keys(frontmatter)) {
  if (!allowedFields.has(key)) warn(`Non-standard frontmatter field: ${key}`);
}

const expectedName = path.basename(root);
if (!frontmatter.name) fail('frontmatter.name is required.');
else {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(frontmatter.name)) fail('name must be lowercase alphanumeric with single hyphens.');
  if (frontmatter.name.length > 64) fail('name must be <= 64 characters.');
  if (frontmatter.name !== expectedName) fail(`name (${frontmatter.name}) must match directory (${expectedName}).`);
}
if (!frontmatter.description) fail('frontmatter.description is required.');
else if (String(frontmatter.description).length > 1024) fail(`description is ${String(frontmatter.description).length} chars; max is 1024.`);
if (frontmatter.compatibility && String(frontmatter.compatibility).length > 500) fail('compatibility must be <= 500 characters.');
if (body.trim().length < 300) warn('SKILL.md body is unusually short.');
if (body.length > 30000) warn('SKILL.md body is large; move detail into references for progressive disclosure.');

for (const required of [
  'README.md',
  'LICENSE',
  'VERSION',
  'VERIFICATION.md',
  'agents/openai.yaml',
  'config/quality-gate.config.json',
  'config/quality-gate.schema.json',
  'references/02-ui-regression-contract.md',
  'references/03-performance-contract.md',
  'references/04-fullstack-contract.md',
  'scripts/quality-gate.mjs',
  'scripts/selftest.mjs',
  'evals/README.md',
  'evals/cases.json'
]) {
  if (!pathExists(path.join(root, required))) fail(`Required file missing: ${required}`);
}

const versionFile = path.join(root, 'VERSION');
const packageFile = path.join(root, 'package.json');
if (pathExists(versionFile)) {
  const version = fs.readFileSync(versionFile, 'utf8').trim();
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) fail(`VERSION is not valid SemVer: ${version}`);
  const metadataVersion = frontmatter.metadata && typeof frontmatter.metadata === 'object' ? String(frontmatter.metadata.version || '') : '';
  if (metadataVersion && metadataVersion !== version) fail(`frontmatter.metadata.version (${metadataVersion}) does not match VERSION (${version}).`);
  if (pathExists(packageFile)) {
    const pkg = readJson(packageFile, null);
    if (pkg?.version && String(pkg.version) !== version) fail(`package.json version (${pkg.version}) does not match VERSION (${version}).`);
  }
}
if (frontmatter.license === 'Apache-2.0' && !pathExists(path.join(root, 'LICENSE'))) fail('Apache-2.0 frontmatter requires a LICENSE file.');

for (const jsonFile of walkFiles(root, { extensions: ['.json'], ignore: ['**/node_modules/**'] })) {
  try { readJson(jsonFile); } catch (error) { fail(error.message); }
}

const scripts = walkFiles(path.join(root, 'scripts'), { extensions: ['.mjs', '.js'], ignore: ['**/node_modules/**'] });
for (const script of scripts) {
  const checked = spawnSync(process.execPath, ['--check', script], { encoding: 'utf8' });
  if (checked.status !== 0) fail(`Syntax error in ${normalizeSlash(path.relative(root, script))}: ${checked.stderr.trim()}`);
}

const references = [...body.matchAll(/`((?:references|assets|scripts|config)\/[A-Za-z0-9._\/-]+)`/g)].map((m) => m[1]);
for (const ref of new Set(references)) {
  if (!pathExists(path.join(root, ref))) fail(`SKILL.md references missing file: ${ref}`);
}

const result = {
  status: errors.length ? 'FAIL' : (warnings.length ? 'PASS_WITH_WARNINGS' : 'PASS'),
  root,
  name: frontmatter.name || null,
  descriptionLength: String(frontmatter.description || '').length,
  scriptCount: scripts.length,
  errors,
  warnings
};

console.log(JSON.stringify(result, null, 2));
process.exitCode = errors.length ? 1 : 0;

function parseSimpleYaml(text) {
  const result = {};
  const lines = text.split(/\r?\n/);
  let currentKey = null;
  let folded = false;
  let foldedLines = [];
  let mapKey = null;
  const flushFolded = () => {
    if (currentKey && folded) result[currentKey] = foldedLines.join(' ').replace(/\s+/g, ' ').trim();
    folded = false;
    foldedLines = [];
  };
  for (const raw of lines) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    if (folded && indent > 0) {
      foldedLines.push(raw.trim());
      continue;
    }
    flushFolded();
    const match = /^([A-Za-z0-9_-]+):(?:\s*(.*))?$/.exec(raw.trim());
    if (!match) continue;
    const [, key, valueRaw = ''] = match;
    if (indent === 0) {
      currentKey = key;
      mapKey = null;
      if (valueRaw === '>- ' || valueRaw === '>' || valueRaw === '>-') {
        folded = true;
        foldedLines = [];
      } else if (!valueRaw) {
        result[key] = {};
        mapKey = key;
      } else result[key] = stripQuotes(valueRaw);
    } else if (mapKey && result[mapKey] && typeof result[mapKey] === 'object') {
      result[mapKey][key] = stripQuotes(valueRaw);
    }
  }
  flushFolded();
  return result;
}

function stripQuotes(value) {
  const text = String(value).trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) return text.slice(1, -1);
  return text;
}
