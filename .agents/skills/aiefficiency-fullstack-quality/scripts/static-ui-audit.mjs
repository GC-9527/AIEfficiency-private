#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {
  parseArgs, resolveRepo, loadConfig, outputPaths, getChangedFiles, getAddedLineRanges,
  lineInRanges, matchesAny, pathExists, normalizeSlash, relativeTo, writeJson, writeText,
  markdownTable, validateGitBase
} from './lib/common.mjs';

const RULES = {
  'UI-Z-ARBITRARY': 'Arbitrary or excessive z-index can create cross-route layer collisions.',
  'UI-FIXED-UNTOKENED': 'New fixed/sticky layer lacks an explicit semantic layer marker.',
  'UI-VIEWPORT-WIDTH': '100vw/w-screen commonly creates horizontal overflow beside scrollbars or sidebars.',
  'UI-HARD-WIDTH': 'Large fixed pixel width is likely to break smaller viewports.',
  'UI-HARD-HEIGHT': 'Large fixed pixel height can make dialogs/content unreachable.',
  'UI-OVERFLOW-HIDDEN': 'overflow-hidden in a flex/layout container can clip popovers, focus rings or content.',
  'UI-DIALOG-NOSCROLL': 'Dialog-like fixed overlay has no visible max-height/internal scroll contract.',
  'UI-CLICK-DIV': 'Clickable non-semantic element lacks keyboard/role evidence.',
  'UI-INDEX-KEY': 'Array index as React key can corrupt state when rows reorder.',
  'STATE-SILENT-EMPTY': 'Catch block appears to convert an error into empty/null state.',
  'STATE-RAW-FETCH': 'Raw fetch outside the shared transport layer can drift in auth/error behavior.',
  'PERF-FAST-POLL': 'Fast polling can increase load and duplicate requests.',
  'PERF-TIMER-NOCLEANUP': 'Interval/timeout registration has no obvious cleanup in the same file.',
  'PERF-HEAVY-EAGER': 'Heavy dependency is eagerly imported into a shared or route module.',
  'MAINT-LARGE-FILE': 'Very large source file increases change coupling and regression risk.'
};


const args = parseArgs();
const repo = resolveRepo(args.repo || '.');
const config = loadConfig(repo, args.config);
const base = String(args.base || config.git?.defaultBase || 'HEAD');
const out = outputPaths(repo, config);
const baseValidation = validateGitBase(repo, base);
if (!baseValidation.ok) {
  const result = {
    generatedAt: new Date().toISOString(),
    status: 'FAIL',
    base,
    resolvedBase: null,
    reason: baseValidation.reason,
    changedFilesScanned: 0,
    blockerCount: 1,
    summary: { total: 1, introduced: 1, existing: 0, P0: 1, P1: 0, P2: 0, P3: 0 },
    findings: [{ ruleId: 'GIT-BASE-INVALID', severity: 'P0', file: '.', line: 1, introduced: true, message: baseValidation.reason, evidence: baseValidation.detail || base }],
    rules: { ...RULES, 'GIT-BASE-INVALID': 'The requested Git base must resolve before changed-line gating can be trusted.' }
  };
  const jsonFile = path.join(out.artifacts, 'static-ui-audit.json');
  const mdFile = path.join(out.artifacts, 'static-ui-audit.md');
  writeJson(jsonFile, result);
  writeText(mdFile, renderMarkdown(result));
  console.log(JSON.stringify({ status: 'FAIL', changedFilesScanned: 0, blockerCount: 1, reason: baseValidation.reason, artifacts: { json: relativeTo(repo, jsonFile), markdown: relativeTo(repo, mdFile) } }, null, 2));
  process.exit(1);
}
const resolvedBase = baseValidation.resolvedBase;
const audit = config.staticAudit || {};
const ignore = [...(config.git?.ignore || []), ...(audit.ignoreFiles || [])];
const extensions = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.css', '.scss', '.sass', '.less', '.html']);
const changes = getChangedFiles(repo, resolvedBase, config.git?.includeUntracked !== false)
  .filter((item) => !matchesAny(item.path, ignore))
  .filter((item) => extensions.has(path.extname(item.path).toLowerCase()));

const findings = [];
for (const change of changes) {
  const full = path.join(repo, change.path);
  if (!pathExists(full)) continue;
  let text;
  try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
  const lines = text.split(/\r?\n/);
  const ranges = getAddedLineRanges(repo, resolvedBase, change.path, change.untracked);
  const ctx = { file: change.path, text, lines, ranges, untracked: change.untracked };
  runLineRules(ctx);
  runFileRules(ctx);
}

const ignoredRuleIds = new Set(audit.ignoreRules || []);
const filtered = findings.filter((item) => !ignoredRuleIds.has(item.ruleId));
const failSeverities = new Set(audit.failOnIntroducedSeverities || ['P0', 'P1']);
const blockers = filtered.filter((item) => item.introduced && failSeverities.has(item.severity));
const summary = summarize(filtered);
const status = blockers.length ? 'FAIL' : (filtered.length ? 'PASS_WITH_WARNINGS' : 'PASS');
const result = {
  generatedAt: new Date().toISOString(),
  status,
  base,
  resolvedBase,
  emptyRepository: baseValidation.emptyRepository,
  changedFilesScanned: changes.length,
  blockerCount: blockers.length,
  summary,
  findings: filtered,
  rules: RULES
};

const jsonFile = path.join(out.artifacts, 'static-ui-audit.json');
const mdFile = path.join(out.artifacts, 'static-ui-audit.md');
writeJson(jsonFile, result);
writeText(mdFile, renderMarkdown(result));
console.log(JSON.stringify({ status, changedFilesScanned: changes.length, blockerCount: blockers.length, summary, artifacts: { json: relativeTo(repo, jsonFile), markdown: relativeTo(repo, mdFile) } }, null, 2));
process.exitCode = blockers.length && !args['no-fail'] ? 1 : 0;


function addFinding(ctx, ruleId, severity, line, message, evidence, extra = {}) {
  if (isSuppressed(ctx.lines, line, ruleId)) return;
  findings.push({
    ruleId,
    severity,
    file: ctx.file,
    line,
    introduced: ctx.untracked || lineInRanges(line, ctx.ranges),
    message,
    evidence: String(evidence || '').trim().slice(0, 300),
    ...extra
  });
}

function runLineRules(ctx) {
  const maxZ = Number(audit.maxArbitraryZIndex ?? 120);
  const widthThreshold = Number(audit.hardWidthWarningPx ?? 480);
  const heightThreshold = Number(audit.hardHeightWarningPx ?? 720);
  const pollingThreshold = Number(audit.pollingWarningMs ?? 5000);
  let catchWindow = 0;
  for (let index = 0; index < ctx.lines.length; index += 1) {
    const lineNo = index + 1;
    const line = ctx.lines[index];
    const trimmed = line.trim();

    for (const match of line.matchAll(/\bz-\[(\d+)\]/g)) {
      const value = Number(match[1]);
      addFinding(ctx, 'UI-Z-ARBITRARY', value > maxZ ? 'P1' : 'P2', lineNo,
        value > maxZ ? `New z-index ${value} exceeds the project semantic ceiling ${maxZ}.` : `Arbitrary z-index ${value} should use a semantic layer token.`, trimmed, { value });
    }
    const styleZ = /\bzIndex\s*:\s*(\d+)/.exec(line);
    if (styleZ) {
      const value = Number(styleZ[1]);
      addFinding(ctx, 'UI-Z-ARBITRARY', value > maxZ ? 'P1' : 'P2', lineNo,
        value > maxZ ? `Inline zIndex ${value} exceeds the project semantic ceiling ${maxZ}.` : `Inline zIndex ${value} should use a semantic layer token.`, trimmed, { value });
    }

    if (/\b(?:fixed|sticky)\b/.test(line) && /\bz-(?:\d+|\[)/.test(line) && !/data-ui-layer/.test(line)) {
      addFinding(ctx, 'UI-FIXED-UNTOKENED', 'P2', lineNo, 'Fixed/sticky element uses a numeric layer without data-ui-layer or an obvious semantic token.', trimmed);
    }
    if (/\b(?:w-screen|min-w-screen|max-w-screen)\b|\bwidth\s*:\s*["']?100vw/.test(line)) {
      addFinding(ctx, 'UI-VIEWPORT-WIDTH', 'P1', lineNo, 'Viewport width sizing can overflow inside the shared shell.', trimmed);
    }
    for (const match of line.matchAll(/\b(?:w|min-w|max-w)-\[(\d+)px\]/g)) {
      const value = Number(match[1]);
      if (value >= widthThreshold) addFinding(ctx, 'UI-HARD-WIDTH', 'P2', lineNo, `Fixed width ${value}px requires an explicit responsive fallback.`, trimmed, { value });
    }
    for (const match of line.matchAll(/\b(?:h|min-h|max-h)-\[(\d+)px\]/g)) {
      const value = Number(match[1]);
      if (value >= heightThreshold) addFinding(ctx, 'UI-HARD-HEIGHT', 'P2', lineNo, `Fixed height ${value}px can exceed shorter viewports.`, trimmed, { value });
    }
    if (/\boverflow-hidden\b/.test(line) && /\b(?:flex|grid|fixed|absolute|relative)\b/.test(line)) {
      addFinding(ctx, 'UI-OVERFLOW-HIDDEN', 'P2', lineNo, 'Layout/positioned container combines with overflow-hidden; verify clipping and scroll ownership.', trimmed);
    }
    if (/<(?:div|span)\b[^>]*\bonClick=/.test(line) && !/\brole=|\bonKeyDown=|\bonKeyUp=|\btabIndex=/.test(line)) {
      addFinding(ctx, 'UI-CLICK-DIV', 'P2', lineNo, 'Clickable div/span has no keyboard or semantic evidence on the same element.', trimmed);
    }
    if (/\bkey=\{\s*(?:index|i|idx)\s*\}/.test(line)) {
      addFinding(ctx, 'UI-INDEX-KEY', 'P2', lineNo, 'React list uses an array index as key.', trimmed);
    }

    if (/\bcatch\s*(?:\([^)]*\))?\s*\{?/.test(line)) catchWindow = 8;
    else if (catchWindow > 0) catchWindow -= 1;
    if (catchWindow > 0 && /\breturn\s+(?:\[\s*\]|null|\{\s*\})\s*;?/.test(line)) {
      addFinding(ctx, 'STATE-SILENT-EMPTY', 'P1', lineNo, 'Error path returns empty/null and may render an incorrect Empty state.', trimmed);
      catchWindow = 0;
    }

    if (/\bfetch\s*\(/.test(line) && !/(?:^|\/)services?\/|api\.(?:js|ts|mjs)$|gateway\.(?:js|ts|mjs)$/.test(normalizeSlash(ctx.file))) {
      addFinding(ctx, 'STATE-RAW-FETCH', 'P2', lineNo, 'Raw fetch outside shared transport; verify auth, timeout and structured error mapping.', trimmed);
    }
    const interval = /\bsetInterval\s*\([^,]+,\s*(\d+)\s*\)/.exec(line);
    if (interval) {
      const value = Number(interval[1]);
      if (value < pollingThreshold) addFinding(ctx, 'PERF-FAST-POLL', value < 1000 ? 'P1' : 'P2', lineNo, `Polling interval ${value}ms is below ${pollingThreshold}ms.`, trimmed, { value });
    }
    if (/^\s*import\b.*?['"](?:html2canvas|jszip|@xyflow\/react|@dagrejs\/dagre|monaco-editor|echarts)['"]/.test(line)) {
      const shared = /(?:src\/App\.|src\/components\/|src\/main\.)/.test(normalizeSlash(ctx.file));
      addFinding(ctx, 'PERF-HEAVY-EAGER', shared ? 'P1' : 'P2', lineNo, shared ? 'Heavy dependency is eagerly imported from shared UI code.' : 'Heavy dependency is eagerly imported; verify route-level code splitting.', trimmed);
    }
  }
}

function runFileRules(ctx) {
  const lineCount = ctx.lines.length;
  const maxLines = Number(config.risk?.largeFileLines ?? 1000);
  if (lineCount > maxLines) {
    const line = firstIntroducedLine(ctx.ranges) || 1;
    addFinding(ctx, 'MAINT-LARGE-FILE', 'P2', line, `File has ${lineCount} lines; isolate the changed responsibility and verify reverse consumers.`, `${ctx.file}: ${lineCount} lines`, { lineCount });
  }
  if (/\bsetInterval\s*\(/.test(ctx.text) && !/\bclearInterval\s*\(/.test(ctx.text)) {
    const line = lineOf(ctx.lines, /\bsetInterval\s*\(/);
    addFinding(ctx, 'PERF-TIMER-NOCLEANUP', 'P1', line, 'setInterval exists without clearInterval in the same file.', ctx.lines[line - 1]);
  }
  const dialogLike = /(?:role=["']dialog["']|aria-modal=["']true["']|\bfixed\s+inset-0\b)/.test(ctx.text);
  const hasScrollContract = /(?:max-h-|overflow-y-auto|overflow-auto)/.test(ctx.text);
  if (dialogLike && !hasScrollContract) {
    const line = lineOf(ctx.lines, /(?:role=["']dialog["']|aria-modal=["']true["']|\bfixed\s+inset-0\b)/);
    addFinding(ctx, 'UI-DIALOG-NOSCROLL', 'P1', line, 'Dialog-like overlay has no max-height/internal scroll class in the file.', ctx.lines[line - 1]);
  }
}

function lineOf(lines, regex) {
  const index = lines.findIndex((line) => regex.test(line));
  return index >= 0 ? index + 1 : 1;
}

function firstIntroducedLine(ranges) {
  return ranges?.[0]?.start || null;
}

function isSuppressed(lines, line, ruleId) {
  for (let i = Math.max(0, line - 3); i < line; i += 1) {
    const value = lines[i] || '';
    const match = /quality-gate-ignore\s+([A-Z0-9-]+)\s*:\s*(.+)/.exec(value);
    if (match && match[1] === ruleId && match[2].trim().length >= 5) return true;
  }
  return false;
}

function summarize(items) {
  const result = { total: items.length, introduced: 0, existing: 0, P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const item of items) {
    result[item.introduced ? 'introduced' : 'existing'] += 1;
    if (result[item.severity] !== undefined) result[item.severity] += 1;
  }
  return result;
}

function renderMarkdown(result) {
  const rows = result.findings.map((item) => [item.severity, item.introduced ? 'NEW' : 'existing', `${item.file}:${item.line}`, item.ruleId, item.message]);
  return `# Static UI / Full-stack Audit\n\n- Status: **${result.status}**\n- Base: \`${result.base}\`\n- Changed files scanned: **${result.changedFilesScanned}**\n- Blocking introduced findings: **${result.blockerCount}**\n\n## Summary\n\n${markdownTable(['Metric', 'Count'], Object.entries(result.summary).map(([key, value]) => [key, value]))}\n\n## Findings\n\n${markdownTable(['Severity', 'Scope', 'Location', 'Rule', 'Message'], rows.length ? rows : [['-', '-', '-', '-', 'No findings']])}\n\n## Suppression contract\n\nUse a narrow, reviewed comment immediately above the line: \`quality-gate-ignore RULE-ID: concrete reason\`. Global ignores and reasonless suppressions are not accepted.\n`;
}
