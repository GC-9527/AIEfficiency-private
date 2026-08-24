#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {
  SKILL_ROOT, parseArgs, resolveRepo, loadConfig, outputPaths, getGitState, getChangedFiles,
  matchesAny, pathExists, readJson, writeJson, writeText, run, shellQuote, relativeTo,
  truncate, markdownTable, nowId, pruneOldFiles, statusRank
} from './lib/common.mjs';

const args = parseArgs();
const repo = resolveRepo(args.repo || '.');
const config = loadConfig(repo, args.config);
const out = outputPaths(repo, config);
const base = String(args.base || config.git?.defaultBase || 'HEAD');
const requestedMode = ['quick', 'standard', 'deep'].includes(String(args.mode)) ? String(args.mode) : 'standard';
const startedAt = new Date();
const gitBefore = getGitState(repo);
const steps = [];
const warnings = [];

if (!args['skip-doctor']) await runScriptStep('doctor', 'doctor.mjs', ['--repo', repo, '--no-fail']);
await runScriptStep('impact-map', 'impact-map.mjs', ['--repo', repo, '--base', base]);
const impact = readArtifact('impact-map.json');
const effectiveMode = chooseMode(requestedMode, impact?.recommendedMode, Boolean(args['allow-lower-mode']));
if (effectiveMode !== requestedMode) warnings.push(`Requested mode ${requestedMode} was escalated to ${effectiveMode} because the impact map recommends ${impact?.recommendedMode}.`);

await runScriptStep('static-ui-audit', 'static-ui-audit.mjs', ['--repo', repo, '--base', base, '--no-fail']);
const staticAudit = readArtifact('static-ui-audit.json');

const changes = impact?.changes || getChangedFiles(repo, base, config.git?.includeUntracked !== false);
if (!args['skip-commands']) {
  const configuredCommands = config.commands?.[effectiveMode] || [];
  for (const command of configuredCommands) {
    const shouldRun = args.all || !command.whenAny?.length || changes.some((change) => matchesAny(change.path, command.whenAny));
    if (!shouldRun) {
      steps.push({ name: `command:${command.name}`, kind: 'command', status: 'SKIPPED', reason: 'No changed file matched whenAny.', command: command.command, durationMs: 0 });
      continue;
    }
    const result = run(command.command, {
      cwd: path.resolve(repo, command.cwd || '.'),
      timeoutMs: Number(command.timeoutMs || 300000),
      env: command.env || {},
      echo: true
    });
    steps.push({
      name: `command:${command.name}`,
      kind: 'command',
      status: result.exitCode === 0 ? 'PASS' : 'FAIL',
      command: command.command,
      cwd: relativeTo(repo, result.cwd),
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      stdout: sanitize(truncate(result.stdout, 12000)),
      stderr: sanitize(truncate(result.stderr, 12000))
    });
  }
}

const preBaselineFailed = steps.some((step) => step.status === 'FAIL') || staticAudit?.status === 'FAIL';
const mayUpdateBaseline = Boolean(args['update-baseline']) && !preBaselineFailed;
const budgetAcceptanceReason = typeof args['accept-budget-change'] === 'string'
  ? String(args['accept-budget-change']).trim()
  : '';
if (args['update-baseline'] && !mayUpdateBaseline) warnings.push('Baseline update was blocked because static checks or configured commands failed.');

if (!args['skip-bundle']) {
  const bundleArgs = ['--repo', repo, '--no-fail'];
  if (mayUpdateBaseline) bundleArgs.push('--update-baseline');
  if (mayUpdateBaseline && budgetAcceptanceReason) bundleArgs.push('--accept-budget-change', budgetAcceptanceReason);
  await runScriptStep('bundle-audit', 'bundle-audit.mjs', bundleArgs);
}
const bundleAudit = readArtifact('bundle-audit.json');

if (!args['skip-browser']) {
  const browserArgs = ['--repo', repo, '--mode', effectiveMode, '--no-fail'];
  if (mayUpdateBaseline && bundleAudit?.status !== 'FAIL') browserArgs.push('--update-baseline');
  if (args.routes) browserArgs.push('--routes', String(args.routes));
  await runScriptStep('browser-audit', 'browser-audit.mjs', browserArgs);
}
const browserAudit = readArtifact('browser-audit.json');

const gitAfter = getGitState(repo);
const componentStatuses = [
  ...steps.map((step) => step.status),
  staticAudit?.status,
  bundleAudit?.status,
  browserAudit?.status
].filter(Boolean);
const failed = componentStatuses.some((status) => status === 'FAIL' || status === 'ERROR');
const hasWarnings = warnings.length > 0 || componentStatuses.some((status) => ['WARN', 'PASS_WITH_WARNINGS', 'SKIPPED', 'NO_BASELINE'].includes(status));
const status = failed ? 'FAIL' : (hasWarnings ? 'PASS_WITH_WARNINGS' : 'PASS');
const finishedAt = new Date();
const runId = nowId(startedAt);
const result = {
  schemaVersion: 1,
  runId,
  generatedAt: finishedAt.toISOString(),
  status,
  requestedMode,
  effectiveMode,
  base,
  durationMs: finishedAt - startedAt,
  baselineUpdateRequested: Boolean(args['update-baseline']),
  baselineUpdateAllowed: mayUpdateBaseline,
  budgetChangeAcceptanceRequested: Boolean(budgetAcceptanceReason),
  budgetChangeAcceptanceReason: budgetAcceptanceReason || null,
  repo: '.',
  gitBefore,
  gitAfter,
  impact: impact ? {
    changedFileCount: impact.changedFileCount,
    recommendedMode: impact.recommendedMode,
    risk: impact.risk,
    routes: impact.routes,
    verificationTargets: impact.verificationTargets
  } : null,
  staticAudit: summarizeArtifact(staticAudit),
  bundleAudit: summarizeArtifact(bundleAudit),
  browserAudit: summarizeArtifact(browserAudit),
  steps,
  warnings,
  verdict: buildVerdict(status, staticAudit, bundleAudit, browserAudit, steps)
};

const runJson = path.join(out.reports, `quality-gate-${runId}.json`);
const runMd = path.join(out.reports, `quality-gate-${runId}.md`);
writeJson(runJson, result);
writeText(runMd, renderMarkdown(result));
if (config.report?.writeLatest !== false) {
  writeJson(path.join(out.reports, 'latest.json'), result);
  writeText(path.join(out.reports, 'latest.md'), renderMarkdown(result));
}
pruneOldFiles(out.reports, Number(config.report?.keepRuns || 20) * 2 + 2, (name) => /^quality-gate-.*\.(json|md)$/.test(name));
console.log(JSON.stringify({
  status,
  requestedMode,
  effectiveMode,
  durationMs: result.durationMs,
  verdict: result.verdict,
  report: relativeTo(repo, runMd),
  json: relativeTo(repo, runJson)
}, null, 2));
process.exitCode = failed ? 1 : 0;

async function runScriptStep(name, scriptName, values) {
  const script = path.join(SKILL_ROOT, 'scripts', scriptName);
  const artifact = path.join(out.artifacts, `${path.basename(scriptName, path.extname(scriptName))}.json`);
  try { if (pathExists(artifact)) fs.rmSync(artifact, { force: true }); } catch {}
  const command = [shellQuote(process.execPath), shellQuote(script), ...values.map((value) => shellQuote(value))].join(' ');
  const result = run(command, { cwd: repo, timeoutMs: scriptName === 'browser-audit.mjs' ? 900000 : 180000, echo: true });
  let parsed = null;
  const stdout = result.stdout.trim();
  try { parsed = JSON.parse(stdout); }
  catch {
    const start = stdout.lastIndexOf('\n{');
    if (start >= 0) {
      try { parsed = JSON.parse(stdout.slice(start + 1)); } catch {}
    }
  }
  steps.push({
    name,
    kind: 'script',
    status: result.exitCode === 0 ? (parsed?.status || 'PASS') : 'FAIL',
    command,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    stdout: sanitize(truncate(result.stdout, 8000)),
    stderr: sanitize(truncate(result.stderr, 8000))
  });
  return result;
}

function chooseMode(requested, recommended, allowLower) {
  if (allowLower || !recommended) return requested;
  const rank = { quick: 0, standard: 1, deep: 2 };
  return rank[recommended] > rank[requested] ? recommended : requested;
}

function readArtifact(name) {
  const file = path.join(out.artifacts, name);
  return pathExists(file) ? readJson(file, null) : null;
}

function summarizeArtifact(value) {
  if (!value) return null;
  return {
    status: value.status,
    blockerCount: value.blockerCount ?? value.comparison?.failures?.length ?? 0,
    summary: value.summary || value.findingSummary || null,
    reason: value.reason || null
  };
}

function buildVerdict(currentStatus, staticValue, bundleValue, browserValue, allSteps) {
  const failures = [];
  if (staticValue?.status === 'FAIL') failures.push(`${staticValue.blockerCount || 0} introduced static P0/P1 finding(s)`);
  if (bundleValue?.status === 'FAIL') failures.push(...(bundleValue.comparison?.failures || ['bundle audit failed']));
  if (browserValue?.status === 'FAIL') failures.push(`${browserValue.blockerCount || 0} new browser P0/P1 finding(s)`);
  for (const step of allSteps.filter((item) => item.status === 'FAIL')) {
    if (['static-ui-audit', 'bundle-audit', 'browser-audit'].includes(step.name)) continue;
    const message = step.kind === 'command' ? `${step.name} exited ${step.exitCode}` : `${step.name} failed${step.exitCode != null ? ` (exit ${step.exitCode})` : ''}`;
    if (!failures.includes(message)) failures.push(message);
  }
  return {
    decision: currentStatus === 'FAIL' ? 'BLOCK' : (currentStatus === 'PASS_WITH_WARNINGS' ? 'ALLOW_WITH_REVIEW' : 'ALLOW'),
    failures,
    skipped: allSteps.filter((item) => item.status === 'SKIPPED').map((item) => item.name)
  };
}

function sanitize(text) {
  return String(text || '')
    .replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s"']+/gi, '$1<redacted>')
    .replace(/((?:token|secret|password|cookie|api[_-]?key)\s*[:=]\s*)[^\s"']+/gi, '$1<redacted>')
    .replaceAll(repo, '<REPO>')
    .replaceAll(repo.replaceAll('\\', '/'), '<REPO>');
}

function renderMarkdown(resultValue) {
  const componentRows = [
    ['Static', resultValue.staticAudit?.status || 'SKIPPED', resultValue.staticAudit?.blockerCount ?? '-'],
    ['Bundle', resultValue.bundleAudit?.status || 'SKIPPED', resultValue.bundleAudit?.blockerCount ?? '-'],
    ['Browser', resultValue.browserAudit?.status || 'SKIPPED', resultValue.browserAudit?.blockerCount ?? '-']
  ];
  const stepRows = resultValue.steps.map((step) => [step.name, step.kind, step.status, step.exitCode ?? '-', `${step.durationMs}ms`, step.command || '-']);
  return `# AIEfficiency Full-stack Quality Gate\n\n## 结论\n\n- Status: **${resultValue.status}**\n- Decision: **${resultValue.verdict.decision}**\n- Requested / effective mode: **${resultValue.requestedMode} / ${resultValue.effectiveMode}**\n- Base: \`${resultValue.base}\`\n- Duration: ${resultValue.durationMs} ms\n- Baseline update: requested=${resultValue.baselineUpdateRequested}, allowed=${resultValue.baselineUpdateAllowed}\n\n## 影响范围\n\n- Changed files: ${resultValue.impact?.changedFileCount ?? 'unknown'}\n- Risk score: ${resultValue.impact?.risk?.score ?? 'unknown'}\n- Routes: ${resultValue.impact?.verificationTargets?.routeNames?.join(', ') || '-'}\n\n## 门禁结果\n\n${markdownTable(['Gate', 'Status', 'Blockers'], componentRows)}\n\n## 执行步骤\n\n${markdownTable(['Step', 'Kind', 'Status', 'Exit', 'Duration', 'Command'], stepRows)}\n\n## 阻断原因\n\n${resultValue.verdict.failures.map((item) => `- ${item}`).join('\n') || '- None'}\n\n## 警告与限制\n\n${resultValue.warnings.map((item) => `- ${item}`).join('\n') || '- None'}\n\n## 证据位置\n\n- Impact: \`${relativeTo(repo, path.join(out.artifacts, 'impact-map.md'))}\`\n- Static: \`${relativeTo(repo, path.join(out.artifacts, 'static-ui-audit.md'))}\`\n- Bundle: \`${relativeTo(repo, path.join(out.artifacts, 'bundle-audit.md'))}\`\n- Browser: \`${relativeTo(repo, path.join(out.artifacts, 'browser-audit.md'))}\`\n\n## 真实性说明\n\n` +
    `只有退出成功且真实执行的步骤标为 PASS。SKIPPED/NO_BASELINE 不等于通过，需在交付说明中保留。\n`;
}
