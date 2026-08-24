#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  SKILL_ROOT, parseArgs, ensureDir, run, shellQuote, pathExists, readJson, writeJson
} from './lib/common.mjs';
import { encodePng, comparePngFiles, writePng } from './lib/png.mjs';

const args = parseArgs();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiefficiency-skill-selftest-'));
const checks = [];
let failed = false;
let upgradeSource = null;
let healthServer = null;

try {
  checkCommand('validate-skill', `${q(process.execPath)} ${q(path.join(SKILL_ROOT, 'scripts', 'validate-skill.mjs'))}`, SKILL_ROOT, 0);

  ensureDir(path.join(root, 'web-dashboard', 'src', 'components'));
  ensureDir(path.join(root, 'web-dashboard', 'src', 'pages', 'devbench'));
  ensureDir(path.join(root, 'web-dashboard', 'dist', 'assets'));
  ensureDir(path.join(root, 'gateway'));
  fs.writeFileSync(path.join(root, 'web-dashboard', 'package.json'), JSON.stringify({ name: 'fixture-web', private: true, type: 'module', scripts: { build: 'node -e "process.exit(0)"', test: 'node -e "process.exit(0)"' } }, null, 2));
  fs.writeFileSync(path.join(root, 'gateway', 'package.json'), JSON.stringify({ name: 'fixture-gateway', private: true, type: 'module', scripts: { test: 'node -e "process.exit(0)"' } }, null, 2));
  fs.writeFileSync(path.join(root, 'web-dashboard', 'src', 'App.jsx'), `import Modal from './components/Modal.jsx';\nexport default function App(){ return <main className="flex min-w-0"><Modal /></main>; }\n`);
  fs.writeFileSync(path.join(root, 'web-dashboard', 'src', 'components', 'Modal.jsx'), `export default function Modal(){ return <button>Open</button>; }\n`);
  fs.writeFileSync(path.join(root, 'web-dashboard', 'src', 'components', 'AliasLocal.jsx'), `export default function AliasLocal(){ return <span>baseline</span>; }\n`);
  fs.writeFileSync(path.join(root, 'web-dashboard', 'src', 'pages', 'devbench', 'index.jsx'), `import AliasLocal from '@/components/AliasLocal.jsx';\nexport default function DevBench(){ return <AliasLocal />; }\n`);
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Fixture rules\n');

  checkCommand('git-init', 'git init', root, 0);
  checkCommand('git-config-email', 'git config user.email "selftest@example.invalid"', root, 0);
  checkCommand('git-config-name', 'git config user.name "Skill Selftest"', root, 0);
  checkCommand('git-add', 'git add .', root, 0);
  checkCommand('git-commit', 'git commit -m "baseline"', root, 0);

  checkCommand('install', `${q(process.execPath)} ${q(path.join(SKILL_ROOT, 'scripts', 'install.mjs'))} --repo ${q(root)}`, SKILL_ROOT, 0);
  assert('canonical-installed', pathExists(path.join(root, '.agents', 'skills', 'aiefficiency-fullstack-quality', 'SKILL.md')), 'canonical skill missing');
  assert('claude-adapter', pathExists(path.join(root, '.claude', 'skills', 'aiefficiency-fullstack-quality', 'SKILL.md')), 'Claude adapter cannot resolve SKILL.md');
  assert('agents-marker', fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8').includes('AIEFFICIENCY_FULLSTACK_QUALITY:START'), 'AGENTS marker missing');
  assert('quality-ignore', pathExists(path.join(root, '.aiefficiency', 'quality', '.gitignore')), 'quality .gitignore missing');
  assert('backup-ignore', pathExists(path.join(root, '.aiefficiency', 'skill-backups', '.gitignore')), 'backup .gitignore missing');

  upgradeSource = fs.mkdtempSync(path.join(os.tmpdir(), 'aiefficiency-skill-upgrade-'));
  fs.cpSync(SKILL_ROOT, upgradeSource, { recursive: true });
  fs.appendFileSync(path.join(upgradeSource, 'README.md'), '\n<!-- selftest-tree-upgrade -->\n');
  checkCommand('install-upgrade-tree-diff', `${q(process.execPath)} ${q(path.join(SKILL_ROOT, 'scripts', 'install.mjs'))} --repo ${q(root)} --source ${q(upgradeSource)}`, SKILL_ROOT, 0);
  assert('upgrade-detected', fs.readFileSync(path.join(root, '.agents', 'skills', 'aiefficiency-fullstack-quality', 'README.md'), 'utf8').includes('selftest-tree-upgrade'), 'installer ignored a non-SKILL.md package change');
  assert('upgrade-backup', fs.readdirSync(path.join(root, '.aiefficiency', 'skill-backups', 'canonical')).length >= 1, 'canonical upgrade backup missing');

  checkCommand('git-add-installed-skill', 'git add .', root, 0);
  checkCommand('git-commit-installed-skill', 'git commit -m "install quality skill"', root, 0);

  const aliasFile = path.join(root, 'web-dashboard', 'src', 'components', 'AliasLocal.jsx');
  const aliasBaseline = fs.readFileSync(aliasFile, 'utf8');
  fs.writeFileSync(aliasFile, `export default function AliasLocal(){ return <span>changed</span>; }\n`);
  const installedScriptsForAlias = path.join(root, '.agents', 'skills', 'aiefficiency-fullstack-quality', 'scripts');
  checkCommand('impact-alias-import', `${q(process.execPath)} ${q(path.join(installedScriptsForAlias, 'impact-map.mjs'))} --repo ${q(root)} --base HEAD`, root, 0);
  const aliasImpact = readJson(path.join(root, '.aiefficiency', 'quality', 'artifacts', 'impact-map.json'));
  assert('impact-alias-route', aliasImpact.routes.direct.includes('devbench'), 'configured @/ import alias was not resolved to the DevBench route');
  fs.writeFileSync(aliasFile, aliasBaseline);

  checkCommand('impact-invalid-base', `${q(process.execPath)} ${q(path.join(installedScriptsForAlias, 'impact-map.mjs'))} --repo ${q(root)} --base definitely-missing-ref`, root, 1);
  const invalidImpact = readJson(path.join(root, '.aiefficiency', 'quality', 'artifacts', 'impact-map.json'));
  assert('impact-invalid-base-artifact', invalidImpact.status === 'FAIL' && /cannot be resolved/.test(invalidImpact.reason), 'invalid Git base did not produce a blocking artifact');
  checkCommand('static-invalid-base', `${q(process.execPath)} ${q(path.join(installedScriptsForAlias, 'static-ui-audit.mjs'))} --repo ${q(root)} --base definitely-missing-ref`, root, 1);
  const invalidStatic = readJson(path.join(root, '.aiefficiency', 'quality', 'artifacts', 'static-ui-audit.json'));
  assert('static-invalid-base-artifact', invalidStatic.status === 'FAIL' && invalidStatic.findings.some((item) => item.ruleId === 'GIT-BASE-INVALID'), 'static audit silently passed an invalid Git base');

  fs.writeFileSync(path.join(root, 'web-dashboard', 'src', 'components', 'Modal.jsx'), `
export default function Modal(){
  try { throw new Error('fixture'); } catch { return []; }
  setInterval(() => {}, 500);
  return <div className="fixed inset-0 z-[999] w-screen"><div onClick={() => {}}>Broken</div></div>;
}
`.trimStart());

  const canonicalScripts = path.join(root, '.agents', 'skills', 'aiefficiency-fullstack-quality', 'scripts');
  checkCommand('impact-map', `${q(process.execPath)} ${q(path.join(canonicalScripts, 'impact-map.mjs'))} --repo ${q(root)} --base HEAD`, root, 0);
  const impact = readJson(path.join(root, '.aiefficiency', 'quality', 'artifacts', 'impact-map.json'));
  assert('impact-change', impact.changedFileCount >= 1, `expected changed files, got ${impact.changedFileCount}`);
  assert('impact-route', impact.verificationTargets.routeNames.includes('devbench') || impact.recommendedMode === 'deep', 'expected deep/shared risk or route impact');

  checkCommand('static-audit', `${q(process.execPath)} ${q(path.join(canonicalScripts, 'static-ui-audit.mjs'))} --repo ${q(root)} --base HEAD --no-fail`, root, 0);
  const staticAudit = readJson(path.join(root, '.aiefficiency', 'quality', 'artifacts', 'static-ui-audit.json'));
  assert('static-blocker', staticAudit.blockerCount >= 2, `expected >=2 blockers, got ${staticAudit.blockerCount}`);
  assert('static-z-rule', staticAudit.findings.some((item) => item.ruleId === 'UI-Z-ARBITRARY' && item.introduced), 'z-index rule did not trigger');
  assert('static-error-rule', staticAudit.findings.some((item) => item.ruleId === 'STATE-SILENT-EMPTY' && item.introduced), 'silent empty rule did not trigger');

  const distFile = path.join(root, 'web-dashboard', 'dist', 'assets', 'app.js');
  fs.writeFileSync(distFile, 'console.log("baseline");'.repeat(100));
  checkCommand('bundle-baseline', `${q(process.execPath)} ${q(path.join(canonicalScripts, 'bundle-audit.mjs'))} --repo ${q(root)} --update-baseline`, root, 0);
  const bundleBaselineFile = path.join(root, '.aiefficiency', 'quality', 'baselines', 'bundle.json');
  const bundleBaselineBefore = fs.readFileSync(bundleBaselineFile, 'utf8');
  fs.writeFileSync(distFile, `${fs.readFileSync(distFile, 'utf8')}\n${'const payload="abcdefghijklmnopqrstuvwxyz";'.repeat(10000)}`);
  checkCommand('bundle-regression', `${q(process.execPath)} ${q(path.join(canonicalScripts, 'bundle-audit.mjs'))} --repo ${q(root)} --no-fail`, root, 0);
  const bundle = readJson(path.join(root, '.aiefficiency', 'quality', 'artifacts', 'bundle-audit.json'));
  assert('bundle-fail', bundle.status === 'FAIL', `expected bundle FAIL, got ${bundle.status}`);
  checkCommand('bundle-baseline-launder-blocked', `${q(process.execPath)} ${q(path.join(canonicalScripts, 'bundle-audit.mjs'))} --repo ${q(root)} --update-baseline --no-fail`, root, 0);
  const blockedBundleUpdate = readJson(path.join(root, '.aiefficiency', 'quality', 'artifacts', 'bundle-audit.json'));
  assert('bundle-baseline-not-updated-on-fail', blockedBundleUpdate.status === 'FAIL' && blockedBundleUpdate.baselineUpdated === false, 'failed bundle was written as a passing baseline');
  assert('bundle-baseline-unchanged', fs.readFileSync(bundleBaselineFile, 'utf8') === bundleBaselineBefore, 'bundle baseline changed despite a blocking regression');

  const modalFile = path.join(root, 'web-dashboard', 'src', 'components', 'Modal.jsx');
  const brokenModalSource = fs.readFileSync(modalFile, 'utf8');
  fs.writeFileSync(modalFile, `export default function Modal(){ return <button>Open</button>; }
`);
  checkCommand(
    'quality-gate-explicit-budget-acceptance',
    `${q(process.execPath)} ${q(path.join(canonicalScripts, 'quality-gate.mjs'))} --repo ${q(root)} --base HEAD --mode quick --skip-doctor --skip-browser --skip-commands --update-baseline --accept-budget-change ${q('TB-SELFTEST approved bundle increase')}`,
    root,
    0
  );
  const acceptedBundleUpdate = readJson(path.join(root, '.aiefficiency', 'quality', 'artifacts', 'bundle-audit.json'));
  const acceptedGate = readJson(path.join(root, '.aiefficiency', 'quality', 'reports', 'latest.json'));
  assert('bundle-explicit-acceptance-recorded', acceptedBundleUpdate.budgetChangeAccepted === true && acceptedBundleUpdate.baselineUpdated === true, 'approved bundle budget change was not accepted or recorded');
  assert('quality-gate-forwarded-acceptance', acceptedGate.budgetChangeAcceptanceRequested === true && acceptedGate.budgetChangeAcceptanceReason === 'TB-SELFTEST approved bundle increase', 'quality gate did not forward or record the budget acceptance reason');
  fs.writeFileSync(modalFile, brokenModalSource);

  checkCommand(
    'quality-gate-blocks',
    `${q(process.execPath)} ${q(path.join(canonicalScripts, 'quality-gate.mjs'))} --repo ${q(root)} --base HEAD --mode quick --skip-doctor --skip-browser --skip-commands`,
    root,
    1
  );
  const gate = readJson(path.join(root, '.aiefficiency', 'quality', 'reports', 'latest.json'));
  assert('quality-gate-verdict', gate.status === 'FAIL' && gate.verdict?.decision === 'BLOCK', `expected BLOCK, got ${gate.status}/${gate.verdict?.decision}`);
  assert('quality-gate-component-status', gate.steps.some((item) => item.name === 'static-ui-audit' && item.status === 'FAIL'), 'script JSON status was not propagated into the gate report');

  const browserConfigFile = path.join(root, '.aiefficiency', 'quality', 'quality-gate.config.json');
  const browserTestConfig = readJson(browserConfigFile);
  const serverProgram = `
const http = require('node:http');
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><html><body><main data-ui-critical>fixture</main></body></html>');
});
server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port) + '\\n'));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`;
  healthServer = spawn(process.execPath, ['-e', serverProgram], { stdio: ['ignore', 'pipe', 'pipe'] });
  const browserPort = await new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`fixture server start timeout: ${stderr}`)), 5000);
    healthServer.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      const match = /^(\d+)\s*$/m.exec(stdout);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
    healthServer.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    healthServer.once('error', (error) => { clearTimeout(timer); reject(error); });
    healthServer.once('exit', (code) => {
      if (!stdout.trim()) { clearTimeout(timer); reject(new Error(`fixture server exited ${code}: ${stderr}`)); }
    });
  });
  browserTestConfig.routes = [{ name: 'fixture', path: '/', entryPatterns: ['web-dashboard/src/**'], siblings: [] }];
  browserTestConfig.browser.baseUrl = `http://127.0.0.1:${browserPort}`;
  browserTestConfig.browser.healthPath = '/';
  browserTestConfig.browser.viewports.quick = [{ width: 1000, height: 700 }];
  browserTestConfig.browser.commonScenarios = [{ name: 'default', modes: ['quick', 'standard', 'deep'], actions: [] }];
  browserTestConfig.browser.visual.enabled = true;
  browserTestConfig.browser.visual.failWithoutBaseline = false;
  writeJson(browserConfigFile, browserTestConfig);

  const fakeModuleRoot = ensureDir(path.join(root, 'gateway', 'node_modules', 'puppeteer-core'));
  fs.writeFileSync(path.join(fakeModuleRoot, 'package.json'), JSON.stringify({ name: 'puppeteer-core', version: '0.0.0-selftest', main: 'index.cjs' }, null, 2));
  const fakePng = encodePng({ width: 2, height: 2, data: Buffer.alloc(2 * 2 * 4, 255) }).toString('base64');
  writeFakePuppeteer(path.join(fakeModuleRoot, 'index.cjs'), 120, fakePng);
  checkCommand('browser-baseline-blocked-on-layout-failure', `${q(process.execPath)} ${q(path.join(canonicalScripts, 'browser-audit.mjs'))} --repo ${q(root)} --mode quick --update-baseline --no-fail`, root, 0);
  const blockedBrowserBaseline = readJson(path.join(root, '.aiefficiency', 'quality', 'artifacts', 'browser-audit.json'));
  assert('browser-baseline-not-updated-on-fail', blockedBrowserBaseline.status === 'FAIL' && blockedBrowserBaseline.baselineUpdated === false, 'browser baseline was updated despite a P1 layout finding');
  assert('browser-overflow-detected', blockedBrowserBaseline.findings.some((item) => item.ruleId === 'UI-H-OVERFLOW'), 'browser geometry audit did not detect horizontal overflow');

  writeFakePuppeteer(path.join(fakeModuleRoot, 'index.cjs'), 0, fakePng);
  checkCommand('browser-baseline-established', `${q(process.execPath)} ${q(path.join(canonicalScripts, 'browser-audit.mjs'))} --repo ${q(root)} --mode quick --update-baseline`, root, 0);
  const establishedBrowserBaseline = readJson(path.join(root, '.aiefficiency', 'quality', 'artifacts', 'browser-audit.json'));
  assert('browser-baseline-updated-after-pass', establishedBrowserBaseline.status === 'PASS' && establishedBrowserBaseline.baselineUpdated === true, `expected passing browser baseline, got ${establishedBrowserBaseline.status}`);
  checkCommand('browser-visual-compare', `${q(process.execPath)} ${q(path.join(canonicalScripts, 'browser-audit.mjs'))} --repo ${q(root)} --mode quick`, root, 0);
  const browserCompare = readJson(path.join(root, '.aiefficiency', 'quality', 'artifacts', 'browser-audit.json'));
  assert('browser-visual-pass', browserCompare.status === 'PASS' && browserCompare.cases.every((item) => item.visual.status === 'PASS'), 'browser visual baseline comparison did not pass');

  const pngDir = ensureDir(path.join(root, '.aiefficiency', 'quality', 'png-selftest'));
  const a = { width: 4, height: 4, data: Buffer.alloc(4 * 4 * 4, 255) };
  const b = { width: 4, height: 4, data: Buffer.from(a.data) };
  b.data[0] = 0; b.data[1] = 0; b.data[2] = 0;
  const aFile = path.join(pngDir, 'a.png');
  const bFile = path.join(pngDir, 'b.png');
  fs.writeFileSync(aFile, encodePng(a));
  fs.writeFileSync(bFile, encodePng(b));
  const pngDiff = comparePngFiles(aFile, bFile, { channelTolerance: 1 });
  assert('png-diff', pngDiff.differentPixels === 1, `expected 1 changed pixel, got ${pngDiff.differentPixels}`);
  writePng(path.join(pngDir, 'diff.png'), pngDiff.diff);

  checkCommand('uninstall-adapters', `${q(process.execPath)} ${q(path.join(canonicalScripts, 'uninstall.mjs'))} --repo ${q(root)} --keep-skill`, root, 0);
  assert('claude-removed', !pathExists(path.join(root, '.claude', 'skills', 'aiefficiency-fullstack-quality')), 'Claude adapter still exists');
  assert('agents-marker-removed', !fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8').includes('AIEFFICIENCY_FULLSTACK_QUALITY:START'), 'AGENTS marker still exists');
  assert('canonical-preserved', pathExists(path.join(root, '.agents', 'skills', 'aiefficiency-fullstack-quality', 'SKILL.md')), 'canonical skill should be preserved');
} catch (error) {
  failed = true;
  checks.push({ name: 'selftest-runtime', status: 'FAIL', detail: error.stack || error.message });
} finally {
  try {
    if (healthServer && healthServer.exitCode == null) {
      healthServer.kill('SIGTERM');
      await Promise.race([
        new Promise((resolve) => healthServer.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 1000))
      ]);
    }
  } catch {}
  if (!args.keep) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
    try { if (upgradeSource) fs.rmSync(upgradeSource, { recursive: true, force: true }); } catch {}
  }
}

const result = { status: failed || checks.some((c) => c.status === 'FAIL') ? 'FAIL' : 'PASS', fixture: args.keep ? root : '<removed>', checks };
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.status === 'FAIL' ? 1 : 0;

function checkCommand(name, command, cwd, expected) {
  const value = run(command, { cwd, timeoutMs: 180000 });
  const status = value.exitCode === expected ? 'PASS' : 'FAIL';
  checks.push({ name, status, exitCode: value.exitCode, stdout: value.stdout.slice(-2000), stderr: value.stderr.slice(-2000) });
  if (status === 'FAIL') throw new Error(`${name} exited ${value.exitCode}; expected ${expected}. ${value.stderr}`);
}

function assert(name, condition, detail) {
  checks.push({ name, status: condition ? 'PASS' : 'FAIL', detail: condition ? undefined : detail });
  if (!condition) throw new Error(`${name}: ${detail}`);
}

function writeFakePuppeteer(file, horizontalOverflowPx, pngBase64) {
  const source = `
const fs = require('node:fs');
const path = require('node:path');
const png = Buffer.from(${JSON.stringify(pngBase64)}, 'base64');
module.exports = {
  async launch() {
    return {
      async newPage() {
        let currentUrl = 'about:blank';
        return {
          on() {},
          async setViewport() {},
          async setExtraHTTPHeaders() {},
          async evaluateOnNewDocument() {},
          async addStyleTag() {},
          async goto(url) { currentUrl = url; return { status: () => 200 }; },
          url() { return currentUrl; },
          async evaluate() {
            return {
              page: { scrollWidth: 1000 + ${Number(horizontalOverflowPx)}, clientWidth: 1000, scrollHeight: 700, clientHeight: 700, horizontalOverflowPx: ${Number(horizontalOverflowPx)} },
              fixedOutOfBounds: [], clipped: [], occluded: [], layerCollisions: [], dialogProblems: [], loadingVisible: [],
              metrics: { lcp: 100, cls: 0, loadMs: 50, longTaskCount: 0, transferBytes: 1024, resourceCount: 2 }
            };
          },
          async screenshot(options) { fs.mkdirSync(path.dirname(options.path), { recursive: true }); fs.writeFileSync(options.path, png); },
          async close() {}
        };
      },
      async close() {}
    };
  }
};
`;
  fs.writeFileSync(file, source, 'utf8');
}

function q(value) { return shellQuote(String(value)); }
