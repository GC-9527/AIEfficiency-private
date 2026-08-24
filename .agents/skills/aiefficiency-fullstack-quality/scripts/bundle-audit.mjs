#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  parseArgs, resolveRepo, loadConfig, outputPaths, pathExists, walkFiles, relativeTo,
  fileSha256, writeJson, writeText, readJson, humanBytes, markdownTable
} from './lib/common.mjs';

const args = parseArgs();
const repo = resolveRepo(args.repo || '.');
const config = loadConfig(repo, args.config);
const out = outputPaths(repo, config);
const bundleConfig = config.bundle || {};
const dist = path.resolve(repo, String(args.dist || bundleConfig.dist || 'dist'));
const baselineFile = path.resolve(repo, String(bundleConfig.baselineFile || path.join(config.project?.outputRoot || '.aiefficiency/quality', 'baselines', 'bundle.json')));

if (!pathExists(dist)) {
  const result = {
    generatedAt: new Date().toISOString(),
    status: 'SKIPPED',
    reason: `Dist directory not found: ${relativeTo(repo, dist)}`,
    dist: relativeTo(repo, dist),
    baselineFile: relativeTo(repo, baselineFile),
    files: [], totals: {}
  };
  finish(result, false);
} else {
  const files = walkFiles(dist, { extensions: ['.js', '.mjs', '.cjs', '.css'], ignore: ['**/*.map'], maxFiles: 10000 })
    .map((file) => inspectFile(file, dist))
    .sort((a, b) => b.gzipBytes - a.gzipBytes);
  const current = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    dist: relativeTo(repo, dist),
    files,
    totals: sum(files),
    largestJsGzipBytes: Math.max(0, ...files.filter((f) => f.type === 'js').map((f) => f.gzipBytes))
  };
  const baseline = pathExists(baselineFile) ? readJson(baselineFile, null) : null;
  const comparison = compare(current, baseline, bundleConfig);
  const updateRequested = Boolean(args['update-baseline']);
  const acceptanceReason = typeof args['accept-budget-change'] === 'string' ? String(args['accept-budget-change']).trim() : '';
  const budgetChangeAccepted = comparison.failures.length > 0 && updateRequested && acceptanceReason.length >= 8;
  let status = comparison.failures.length ? 'FAIL' : (comparison.warnings.length ? 'PASS_WITH_WARNINGS' : 'PASS');
  if (!baseline && !comparison.failures.length) status = bundleConfig.failWithoutBaseline ? 'FAIL' : 'NO_BASELINE';
  let baselineUpdated = false;
  if (updateRequested && (!comparison.failures.length || budgetChangeAccepted)) {
    writeJson(baselineFile, current);
    baselineUpdated = true;
    status = comparison.failures.length || comparison.warnings.length ? 'PASS_WITH_WARNINGS' : 'PASS';
  }
  const result = {
    generatedAt: new Date().toISOString(),
    status,
    baselineUpdateRequested: updateRequested,
    baselineUpdated,
    budgetChangeAccepted,
    acceptanceReason: budgetChangeAccepted ? acceptanceReason : null,
    dist: relativeTo(repo, dist),
    baselineFile: relativeTo(repo, baselineFile),
    current,
    baseline,
    comparison
  };
  finish(result, status === 'FAIL');
}

function inspectFile(file, root) {
  const content = fs.readFileSync(file);
  const ext = path.extname(file).toLowerCase();
  return {
    file: relativeTo(root, file),
    type: ext === '.css' ? 'css' : 'js',
    rawBytes: content.length,
    gzipBytes: zlib.gzipSync(content, { level: 9 }).length,
    brotliBytes: zlib.brotliCompressSync(content, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }).length,
    sha256: fileSha256(file)
  };
}

function sum(files) {
  const result = {
    js: { rawBytes: 0, gzipBytes: 0, brotliBytes: 0, fileCount: 0 },
    css: { rawBytes: 0, gzipBytes: 0, brotliBytes: 0, fileCount: 0 },
    all: { rawBytes: 0, gzipBytes: 0, brotliBytes: 0, fileCount: files.length }
  };
  for (const file of files) {
    for (const key of ['rawBytes', 'gzipBytes', 'brotliBytes']) {
      result[file.type][key] += file[key];
      result.all[key] += file[key];
    }
    result[file.type].fileCount += 1;
  }
  return result;
}

function delta(current, baseline) {
  const bytes = current - baseline;
  const percent = baseline > 0 ? (bytes / baseline) * 100 : (current > 0 ? 100 : 0);
  return { bytes, percent: Number(percent.toFixed(2)) };
}

function compare(current, baseline, cfg) {
  const failures = [];
  const warnings = [];
  const maxChunk = Number(cfg.maxSingleJsGzipBytes ?? 768000);
  if (current.largestJsGzipBytes > maxChunk) failures.push(`Largest JS chunk is ${humanBytes(current.largestJsGzipBytes)}, over ${humanBytes(maxChunk)}.`);
  if (!baseline) return {
    status: failures.length ? 'FAIL' : 'NO_BASELINE',
    failures,
    warnings: ['No reviewed bundle baseline exists.'],
    deltas: null,
    addedFiles: current.files.map((file) => file.file)
  };
  const deltas = {
    jsGzip: delta(current.totals.js.gzipBytes, baseline.totals?.js?.gzipBytes || 0),
    cssGzip: delta(current.totals.css.gzipBytes, baseline.totals?.css?.gzipBytes || 0),
    allGzip: delta(current.totals.all.gzipBytes, baseline.totals?.all?.gzipBytes || 0),
    largestJsGzip: delta(current.largestJsGzipBytes, baseline.largestJsGzipBytes || 0)
  };
  const jsPct = Number(cfg.maxTotalJsGzipGrowthPercent ?? 10);
  const jsBytes = Number(cfg.maxTotalJsGzipGrowthBytes ?? 102400);
  if (deltas.jsGzip.bytes > 0 && (deltas.jsGzip.percent > jsPct || deltas.jsGzip.bytes > jsBytes)) {
    failures.push(`Total JS gzip grew ${humanBytes(deltas.jsGzip.bytes)} (${deltas.jsGzip.percent}%), over ${jsPct}% / ${humanBytes(jsBytes)} budget.`);
  }
  const cssPct = Number(cfg.maxTotalCssGzipGrowthPercent ?? 10);
  if (deltas.cssGzip.bytes > 0 && deltas.cssGzip.percent > cssPct) failures.push(`Total CSS gzip grew ${deltas.cssGzip.percent}%, over ${cssPct}% budget.`);
  const added = current.files.filter((file) => !baseline.files?.some((old) => old.file === file.file));
  if (added.length) warnings.push(`${added.length} new JS/CSS bundle file(s) detected.`);
  return { status: failures.length ? 'FAIL' : (warnings.length ? 'WARN' : 'PASS'), failures, warnings, deltas, addedFiles: added.map((f) => f.file) };
}

function finish(result, failed) {
  const jsonFile = path.join(out.artifacts, 'bundle-audit.json');
  const mdFile = path.join(out.artifacts, 'bundle-audit.md');
  writeJson(jsonFile, result);
  writeText(mdFile, renderMarkdown(result));
  console.log(JSON.stringify({ status: result.status, dist: result.dist, totals: result.current?.totals || result.totals, comparison: result.comparison || null, artifacts: { json: relativeTo(repo, jsonFile), markdown: relativeTo(repo, mdFile) } }, null, 2));
  process.exitCode = failed && !args['no-fail'] ? 1 : 0;
}

function renderMarkdown(result) {
  if (!result.current) return `# Bundle Audit\n\n- Status: **${result.status}**\n- Reason: ${result.reason}\n`;
  const rows = result.current.files.slice(0, 30).map((f) => [f.type, f.file, humanBytes(f.rawBytes), humanBytes(f.gzipBytes), humanBytes(f.brotliBytes)]);
  const cmp = result.comparison;
  return `# Bundle Audit\n\n- Status: **${result.status}**\n- Dist: \`${result.dist}\`\n- Baseline: \`${result.baselineFile}\`\n- Baseline updated: ${result.baselineUpdated}\n\n## Totals\n\n${markdownTable(['Type', 'Files', 'Raw', 'Gzip', 'Brotli'], ['js', 'css', 'all'].map((type) => { const value = result.current.totals[type]; return [type, value.fileCount, humanBytes(value.rawBytes), humanBytes(value.gzipBytes), humanBytes(value.brotliBytes)]; }))}\n\n## Comparison\n\n${cmp?.deltas ? markdownTable(['Metric', 'Bytes', 'Percent'], Object.entries(cmp.deltas).map(([key, value]) => [key, humanBytes(value.bytes), `${value.percent}%`])) : '- No reviewed baseline'}\n\n### Failures\n\n${cmp?.failures?.map((x) => `- ${x}`).join('\n') || '- None'}\n\n### Warnings\n\n${cmp?.warnings?.map((x) => `- ${x}`).join('\n') || '- None'}\n\n## Largest assets\n\n${markdownTable(['Type', 'File', 'Raw', 'Gzip', 'Brotli'], rows)}\n`;
}
