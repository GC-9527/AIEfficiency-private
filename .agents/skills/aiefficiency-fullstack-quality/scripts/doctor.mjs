#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  SKILL_ROOT, parseArgs, resolveRepo, loadConfig, outputPaths, getGitState,
  commandExists, pathExists, readJson, writeJson, writeText, markdownTable,
  normalizeSlash, relativeTo, nowId
} from './lib/common.mjs';

const args = parseArgs();
const repo = resolveRepo(args.repo || '.');
const config = loadConfig(repo, args.config);
const out = outputPaths(repo, config);
const checks = [];
const add = (id, status, message, detail = null) => checks.push({ id, status, message, detail });

const major = Number(process.versions.node.split('.')[0]);
add('node', major >= 20 ? 'PASS' : 'FAIL', `Node.js ${process.versions.node}`, major >= 20 ? null : 'Bundled scripts require Node.js 20+.');
add('repo', pathExists(repo) ? 'PASS' : 'FAIL', pathExists(repo) ? 'Repository path exists.' : 'Repository path does not exist.', repo);
add('git-cli', commandExists('git') ? 'PASS' : 'WARN', commandExists('git') ? 'git is available.' : 'git is unavailable; changed-line gating will be limited.');
add('npm-cli', commandExists('npm') ? 'PASS' : 'WARN', commandExists('npm') ? 'npm is available.' : 'npm is unavailable; configured npm commands cannot run.');

const gitState = getGitState(repo);
add('git-repo', gitState.isGitRepo ? 'PASS' : 'WARN', gitState.isGitRepo ? `Git ${gitState.branch} @ ${gitState.head?.slice(0, 12)}` : 'Path is not a Git worktree.');
if (gitState.status.length > 1) add('dirty-worktree', 'WARN', 'Working tree already contains changes; preserve them.', gitState.status.slice(0, 30));
else add('dirty-worktree', 'PASS', 'No pre-existing changed entries detected.');

const packageRoots = ['.', config.project?.frontendRoot, ...(config.project?.backendRoots || [])].filter(Boolean);
const packages = [];
for (const rel of new Set(packageRoots)) {
  const file = path.join(repo, rel, 'package.json');
  if (!pathExists(file)) continue;
  try {
    const pkg = readJson(file);
    packages.push({ root: normalizeSlash(rel), name: pkg.name || null, version: pkg.version || null, scripts: Object.keys(pkg.scripts || {}) });
  } catch (error) {
    add(`package:${rel}`, 'FAIL', `Invalid package.json at ${rel}.`, error.message);
  }
}
add('packages', packages.length ? 'PASS' : 'WARN', `Detected ${packages.length} package manifest(s).`, packages);

const canonical = path.join(repo, '.agents', 'skills', 'aiefficiency-fullstack-quality');
const canonicalSkill = path.join(canonical, 'SKILL.md');
const runningInstalled = path.resolve(SKILL_ROOT) === path.resolve(canonical);
add('canonical-skill', pathExists(canonicalSkill) || runningInstalled ? 'PASS' : 'WARN',
  pathExists(canonicalSkill) ? 'Canonical .agents skill is installed.' : (runningInstalled ? 'Running from canonical skill directory.' : 'Canonical skill is not installed in this repository.'),
  relativeTo(repo, canonicalSkill));

const adapterCandidates = [
  ['claude', path.join(repo, '.claude', 'skills', 'aiefficiency-fullstack-quality')],
  ['gemini', path.join(repo, '.gemini', 'skills', 'aiefficiency-fullstack-quality')],
  ['opencode', path.join(repo, '.opencode', 'skills', 'aiefficiency-fullstack-quality')]
];
const duplicates = [];
for (const [host, dir] of adapterCandidates) {
  if (!pathExists(dir)) continue;
  let linked = false;
  try { linked = fs.lstatSync(dir).isSymbolicLink(); } catch {}
  let same = false;
  try { same = path.resolve(fs.realpathSync(dir)) === path.resolve(fs.realpathSync(canonical)); } catch {}
  if (!same && pathExists(path.join(dir, 'SKILL.md'))) duplicates.push({ host, path: relativeTo(repo, dir), linked });
}
add('single-source', duplicates.length ? 'WARN' : 'PASS', duplicates.length ? 'Possible duplicate full skill sources detected.' : 'No duplicate full skill source detected.', duplicates);

const projectConfig = path.join(repo, '.aiefficiency', 'quality', 'quality-gate.config.json');
add('project-config', pathExists(projectConfig) ? 'PASS' : 'WARN', pathExists(projectConfig) ? 'Project quality configuration exists.' : 'Using bundled default configuration.', config.__paths);

const browser = detectBrowserRuntime(repo, config);
add('browser-runtime', browser.module && browser.executable ? 'PASS' : 'WARN',
  browser.module && browser.executable ? `Browser audit ready with ${browser.module}.` : 'Browser audit prerequisites are incomplete; browser checks may be SKIPPED.', browser);

const server = await probeUrl(new URL(config.browser?.healthPath || '/', config.browser?.baseUrl || 'http://127.0.0.1:3000').href, 1500);
add('local-server', server.ok ? 'PASS' : 'WARN', server.ok ? `Local UI responded with HTTP ${server.status}.` : 'Configured local UI is not reachable now; this is allowed before starting development services.', server);

const failCount = checks.filter((c) => c.status === 'FAIL').length;
const warnCount = checks.filter((c) => c.status === 'WARN').length;
const result = {
  generatedAt: new Date().toISOString(),
  status: failCount ? 'FAIL' : (warnCount ? 'PASS_WITH_WARNINGS' : 'PASS'),
  repo,
  configPath: config.__paths,
  git: gitState,
  packages,
  browser,
  server,
  checks
};

const jsonFile = path.join(out.artifacts, 'doctor.json');
const mdFile = path.join(out.artifacts, 'doctor.md');
writeJson(jsonFile, result);
writeText(mdFile, renderMarkdown(result));
console.log(JSON.stringify({ ...result, repo: '.', artifacts: { json: relativeTo(repo, jsonFile), markdown: relativeTo(repo, mdFile) } }, null, 2));
process.exitCode = failCount && !args['no-fail'] ? 1 : 0;

function detectBrowserRuntime(repoRoot, cfg) {
  const modules = [];
  for (const packageRoot of ['.', cfg.project?.frontendRoot, ...(cfg.project?.backendRoots || [])].filter(Boolean)) {
    const pkgFile = path.join(repoRoot, packageRoot, 'package.json');
    if (!pathExists(pkgFile)) continue;
    try {
      const req = createRequire(pkgFile);
      for (const name of ['playwright', '@playwright/test', 'puppeteer', 'puppeteer-core']) {
        try {
          const resolved = req.resolve(name);
          if (!modules.some((item) => item.name === name)) modules.push({ name, resolved: relativeTo(repoRoot, resolved), packageRoot: normalizeSlash(packageRoot) });
        } catch {}
      }
    } catch {}
  }
  const executable = findBrowserExecutable(cfg.browser?.executablePath);
  return { module: modules[0]?.name || null, modules, executable };
}

function findBrowserExecutable(configured) {
  const candidates = [
    configured,
    process.env.AIEFFICIENCY_BROWSER_PATH,
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    process.env.EDGE_PATH,
    ...(process.platform === 'win32' ? [
      `${process.env.PROGRAMFILES || 'C:/Program Files'}/Google/Chrome/Application/chrome.exe`,
      `${process.env['PROGRAMFILES(X86)'] || 'C:/Program Files (x86)'}/Google/Chrome/Application/chrome.exe`,
      `${process.env.LOCALAPPDATA || ''}/Google/Chrome/Application/chrome.exe`,
      `${process.env.PROGRAMFILES || 'C:/Program Files'}/Microsoft/Edge/Application/msedge.exe`,
      `${process.env['PROGRAMFILES(X86)'] || 'C:/Program Files (x86)'}/Microsoft/Edge/Application/msedge.exe`
    ] : [
      '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    ])
  ].filter(Boolean).map((p) => path.resolve(String(p)));
  return candidates.find(pathExists) || null;
}

async function probeUrl(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: 'GET', redirect: 'manual', signal: controller.signal });
    return { ok: response.status > 0 && response.status < 500, status: response.status, url };
  } catch (error) {
    return { ok: false, status: null, url, error: error.name === 'AbortError' ? 'timeout' : error.message };
  } finally {
    clearTimeout(timer);
  }
}

function renderMarkdown(result) {
  return `# AIEfficiency Quality Doctor\n\n- Status: **${result.status}**\n- Generated: ${result.generatedAt}\n- Branch: ${result.git.branch || 'n/a'}\n- Head: ${result.git.head || 'n/a'}\n\n${markdownTable(['Check', 'Status', 'Message'], result.checks.map((c) => [c.id, c.status, c.message]))}\n\n## Notes\n\n${result.checks.filter((c) => c.detail).map((c) => `### ${c.id}\n\n\`\`\`json\n${JSON.stringify(c.detail, null, 2)}\n\`\`\``).join('\n\n')}\n`;
}
