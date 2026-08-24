#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {
  parseArgs, resolveRepo, loadConfig, outputPaths, getChangedFiles, getAddedLineRanges,
  pathExists, matchesAny, walkFiles, normalizeSlash, relativeTo, writeJson, writeText,
  markdownTable, validateGitBase
} from './lib/common.mjs';

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
    repo: '.',
    base,
    resolvedBase: null,
    reason: baseValidation.reason,
    detail: baseValidation.detail || null,
    changedFileCount: 0,
    changes: [],
    routes: { direct: [], shell: [], siblings: [], contract: [], impacted: [] },
    risk: { score: 0, recommendedMode: 'deep', allCriticalRoutes: true, reasons: [] },
    recommendedMode: 'deep',
    verificationTargets: { routeNames: [], requireBrowser: false, requireBundle: false, requireFullstack: false, allCriticalRoutes: true, modes: { selected: 'deep', minimumViewports: 6 } }
  };
  const jsonFile = path.join(out.artifacts, 'impact-map.json');
  const mdFile = path.join(out.artifacts, 'impact-map.md');
  writeJson(jsonFile, result);
  writeText(mdFile, `# Change Impact Map\n\n- Status: **FAIL**\n- Base: \`${base}\`\n- Reason: ${baseValidation.reason}\n`);
  console.log(JSON.stringify({ status: 'FAIL', base, reason: baseValidation.reason, artifacts: { json: relativeTo(repo, jsonFile), markdown: relativeTo(repo, mdFile) } }, null, 2));
  process.exit(1);
}
const resolvedBase = baseValidation.resolvedBase;
const ignore = config.git?.ignore || [];
const rawChanges = getChangedFiles(repo, resolvedBase, config.git?.includeUntracked !== false);
const changes = rawChanges.filter((item) => !matchesAny(item.path, ignore));
for (const change of changes) change.addedLineRanges = getAddedLineRanges(repo, resolvedBase, change.path, change.untracked);

const extensions = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.css', '.scss', '.sass', '.less']);
const roots = (config.project?.sourceRoots || []).map((rel) => path.join(repo, rel)).filter(pathExists);
const allFiles = [];
for (const root of roots) {
  for (const file of walkFiles(root, { extensions: [...extensions], ignore, maxFiles: 30000 })) {
    if (!allFiles.includes(file)) allFiles.push(file);
  }
}
const relFiles = new Set(allFiles.map((file) => relativeTo(repo, file)));
const graph = new Map();
const reverse = new Map();
const endpointFiles = new Map();

for (const file of allFiles) {
  const rel = relativeTo(repo, file);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
  const imports = extractImports(text);
  const resolved = new Set();
  for (const specifier of imports) {
    const target = resolveImport(repo, file, specifier, relFiles, config.project?.importAliases || {});
    if (target) resolved.add(target);
  }
  graph.set(rel, [...resolved]);
  for (const target of resolved) {
    if (!reverse.has(target)) reverse.set(target, new Set());
    reverse.get(target).add(rel);
  }
  for (const endpoint of extractEndpoints(text)) {
    if (!endpointFiles.has(endpoint)) endpointFiles.set(endpoint, new Set());
    endpointFiles.get(endpoint).add(rel);
  }
}

const changedPaths = changes.map((c) => c.path);
const dependentMap = {};
for (const file of changedPaths) dependentMap[file] = [...reverseClosure(file, reverse, 6)].sort();

const changedEndpoints = new Set();
for (const change of changes) {
  const full = path.join(repo, change.path);
  if (!pathExists(full) || !extensions.has(path.extname(full).toLowerCase())) continue;
  try { for (const endpoint of extractEndpoints(fs.readFileSync(full, 'utf8'))) changedEndpoints.add(endpoint); } catch {}
}
const endpointImpacts = {};
for (const endpoint of changedEndpoints) endpointImpacts[endpoint] = [...(endpointFiles.get(endpoint) || [])].sort();

const routes = classifyRoutes(config.routes || [], changes, dependentMap, endpointImpacts, config);
const risk = scoreRisk(changes, routes, config);
const result = {
  generatedAt: new Date().toISOString(),
  status: 'PASS',
  repo: '.',
  base,
  resolvedBase,
  emptyRepository: baseValidation.emptyRepository,
  changedFileCount: changes.length,
  changes,
  importsIndexed: graph.size,
  dependents: dependentMap,
  changedEndpoints: [...changedEndpoints].sort(),
  endpointImpacts,
  routes,
  risk,
  recommendedMode: risk.recommendedMode,
  verificationTargets: buildVerificationTargets(routes, risk)
};

const jsonFile = path.join(out.artifacts, 'impact-map.json');
const mdFile = path.join(out.artifacts, 'impact-map.md');
writeJson(jsonFile, result);
writeText(mdFile, renderMarkdown(result));
console.log(JSON.stringify({
  status: result.status,
  base,
  changedFileCount: changes.length,
  recommendedMode: result.recommendedMode,
  routeNames: result.verificationTargets.routeNames,
  artifacts: { json: relativeTo(repo, jsonFile), markdown: relativeTo(repo, mdFile) }
}, null, 2));

function extractImports(text) {
  const result = new Set();
  const patterns = [
    /\bimport\s+(?:[^'"()]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bexport\s+[^'"()]*?\s+from\s+['"]([^'"]+)['"]/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) result.add(match[1]);
  }
  return result;
}

function resolveImport(repoRoot, fromFile, specifier, fileSet, aliases = {}) {
  let basePath = null;
  if (specifier.startsWith('.')) basePath = path.resolve(path.dirname(fromFile), specifier);
  else {
    const prefix = Object.keys(aliases).sort((a, b) => b.length - a.length).find((key) => specifier.startsWith(key));
    if (!prefix) return null;
    basePath = path.resolve(repoRoot, aliases[prefix], specifier.slice(prefix.length));
  }
  const candidates = [
    basePath,
    ...[...extensions].map((ext) => `${basePath}${ext}`),
    ...[...extensions].map((ext) => path.join(basePath, `index${ext}`))
  ];
  for (const candidate of candidates) {
    const rel = relativeTo(repoRoot, candidate);
    if (fileSet.has(rel)) return rel;
  }
  return null;
}

function extractEndpoints(text) {
  const set = new Set();
  for (const match of text.matchAll(/['"`]((?:https?:\/\/[^'"`\s]+)?\/api\/[A-Za-z0-9_./:${}?=&-]+)/g)) {
    let endpoint = match[1].replace(/^https?:\/\/[^/]+/, '');
    endpoint = endpoint.replace(/\$\{[^}]+\}/g, ':param').replace(/[?#].*$/, '');
    if (endpoint.length <= 200) set.add(endpoint);
  }
  return set;
}

function reverseClosure(start, reverseGraph, maxDepth) {
  const seen = new Set();
  const queue = [{ file: start, depth: 0 }];
  while (queue.length) {
    const { file, depth } = queue.shift();
    if (depth >= maxDepth) continue;
    for (const dependent of reverseGraph.get(file) || []) {
      if (seen.has(dependent)) continue;
      seen.add(dependent);
      queue.push({ file: dependent, depth: depth + 1 });
    }
  }
  return seen;
}

function classifyRoutes(routeConfig, changeList, dependents, endpointMap, cfg) {
  const changed = changeList.map((c) => c.path);
  const allDependents = new Set(Object.values(dependents).flat());
  const endpointFilesFlat = new Set(Object.values(endpointMap).flat());
  const sharedPatterns = cfg.risk?.sharedUiPatterns || [];
  const shared = changed.some((file) => matchesAny(file, sharedPatterns)) ||
    [...allDependents].some((file) => matchesAny(file, sharedPatterns));
  const direct = new Set();
  const contract = new Set();
  for (const route of routeConfig) {
    if (changed.some((file) => matchesAny(file, route.entryPatterns || []))) direct.add(route.name);
    if ([...allDependents].some((file) => matchesAny(file, route.entryPatterns || []))) direct.add(route.name);
    if ([...endpointFilesFlat].some((file) => matchesAny(file, route.entryPatterns || []))) contract.add(route.name);
  }
  const shell = new Set(shared ? routeConfig.map((route) => route.name) : []);
  const siblings = new Set();
  for (const name of direct) {
    const route = routeConfig.find((item) => item.name === name);
    for (const sibling of route?.siblings || []) siblings.add(sibling);
  }
  const impacted = new Set([...direct, ...shell, ...siblings, ...contract]);
  return {
    direct: [...direct],
    shell: [...shell],
    siblings: [...siblings].filter((name) => !direct.has(name)),
    contract: [...contract].filter((name) => !direct.has(name)),
    impacted: routeConfig.filter((route) => impacted.has(route.name)).map((route) => ({ name: route.name, path: route.path }))
  };
}

function scoreRisk(changeList, routeInfo, cfg) {
  let score = 0;
  const reasons = [];
  const allCriticalRoutes = changeList.some((change) => matchesAny(change.path, [
    ...(cfg.risk?.sharedUiPatterns || []),
    ...(cfg.risk?.globalContractPatterns || [])
  ]));
  const add = (points, reason) => { score += points; reasons.push({ points, reason }); };
  for (const change of changeList) {
    const file = change.path;
    if (matchesAny(file, cfg.risk?.deepPatterns || [])) add(5, `${file}: deep-risk pattern`);
    else if (matchesAny(file, cfg.risk?.sharedUiPatterns || [])) add(4, `${file}: shared UI`);
    else if (/\.(css|scss|less)$/.test(file)) add(3, `${file}: stylesheet`);
    else if (/\.(jsx|tsx)$/.test(file)) add(2, `${file}: UI component`);
    else if (/(api|service|auth|store|database|migration|websocket|ws)/i.test(file)) add(3, `${file}: full-stack contract`);
    else add(1, `${file}: local change`);
  }
  if (routeInfo.impacted.length >= 4) add(3, `${routeInfo.impacted.length} routes impacted`);
  else if (routeInfo.impacted.length >= 2) add(2, `${routeInfo.impacted.length} routes impacted`);
  const recommendedMode = score >= 6 ? 'deep' : (score >= 3 ? 'standard' : 'quick');
  return { score, recommendedMode, allCriticalRoutes, reasons: reasons.slice(0, 50) };
}

function buildVerificationTargets(routeInfo, riskInfo) {
  const routeNames = routeInfo.impacted.map((route) => route.name);
  return {
    routeNames,
    requireBrowser: routeNames.length > 0,
    requireBundle: riskInfo.reasons.some((item) => /UI|stylesheet|component|route/i.test(item.reason)),
    requireFullstack: riskInfo.reasons.some((item) => /contract|auth|database|migration|websocket|api|service/i.test(item.reason)),
    allCriticalRoutes: riskInfo.allCriticalRoutes || routeInfo.shell.length > 0,
    modes: {
      selected: riskInfo.recommendedMode,
      minimumViewports: riskInfo.recommendedMode === 'deep' ? 6 : (riskInfo.recommendedMode === 'standard' ? 3 : 1)
    }
  };
}

function renderMarkdown(result) {
  const changeRows = result.changes.map((item) => [item.status, item.path, item.addedLineRanges.map((r) => `${r.start}-${r.end}`).join(', ') || '-']);
  const routeRows = [
    ['Direct', result.routes.direct.join(', ') || '-'],
    ['Shell', result.routes.shell.join(', ') || '-'],
    ['Sibling', result.routes.siblings.join(', ') || '-'],
    ['Contract', result.routes.contract.join(', ') || '-']
  ];
  return `# Change Impact Map\n\n- Base: \`${result.base}\`\n- Changed files: **${result.changedFileCount}**\n- Indexed imports: **${result.importsIndexed}**\n- Risk score: **${result.risk.score}**\n- Recommended mode: **${result.recommendedMode}**\n\n## Changed files\n\n${markdownTable(['Status', 'File', 'Added lines'], changeRows.length ? changeRows : [['-', 'No changed files detected', '-']])}\n\n## Routes\n\n${markdownTable(['Class', 'Routes'], routeRows)}\n\n## Changed API endpoints\n\n${result.changedEndpoints.length ? result.changedEndpoints.map((value) => `- \`${value}\``).join('\n') : '- None detected'}\n\n## Risk reasons\n\n${result.risk.reasons.map((item) => `- +${item.points}: ${item.reason}`).join('\n') || '- No changed files'}\n`;
}
