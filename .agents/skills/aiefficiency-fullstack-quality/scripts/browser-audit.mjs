#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import {
  parseArgs, resolveRepo, loadConfig, outputPaths, pathExists, readJson, writeJson,
  writeText, ensureDir, relativeTo, humanBytes, markdownTable, fileSha256
} from './lib/common.mjs';
import { comparePngFiles, writePng } from './lib/png.mjs';

const args = parseArgs();
const repo = resolveRepo(args.repo || '.');
const config = loadConfig(repo, args.config);
const mode = ['quick', 'standard', 'deep'].includes(String(args.mode)) ? String(args.mode) : 'standard';
const browserConfig = config.browser || {};
const out = outputPaths(repo, config);
const baselineFile = path.join(out.baselines, 'browser.json');
const updateBaseline = Boolean(args['update-baseline']);
const previousBaseline = pathExists(baselineFile) ? readJson(baselineFile, null) : null;

if (browserConfig.enabled === false || args.browser === false) {
  finish({ generatedAt: new Date().toISOString(), status: 'SKIPPED', mode, reason: 'Browser audit disabled by configuration.', cases: [], findings: [] }, false);
} else {
  const healthUrl = new URL(browserConfig.healthPath || '/', browserConfig.baseUrl || 'http://127.0.0.1:3000').href;
  const health = await probeUrl(healthUrl, Math.min(Number(browserConfig.navigationTimeoutMs || 30000), 3000));
  if (!health.ok) {
    const failed = mode === 'deep' && browserConfig.requireServerInDeep === true;
    finish({ generatedAt: new Date().toISOString(), status: failed ? 'FAIL' : 'SKIPPED', mode, reason: `Configured UI server is not reachable: ${health.error || health.status || 'unknown'}`, health, cases: [], findings: [] }, failed);
  } else {
    const runtime = await launchRuntime(repo, config);
    if (!runtime.ok) {
      const failed = mode === 'deep' && browserConfig.requireServerInDeep === true;
      finish({ generatedAt: new Date().toISOString(), status: failed ? 'FAIL' : 'SKIPPED', mode, reason: runtime.error, health, runtime: runtime.diagnostics, cases: [], findings: [] }, failed);
    } else {
      const selectedRoutes = selectRoutes(config, out, mode, args.routes);
      const viewports = browserConfig.viewports?.[mode] || [browserConfig.primaryViewport || { width: 1440, height: 900 }];
      const scenarios = browserConfig.commonScenarios || [{ name: 'default', actions: [] }];
      const cases = [];
      const currentBaseline = { schemaVersion: 1, capturedAt: new Date().toISOString(), cases: {}, findings: [] };
      let runtimeError = null;
      try {
        for (const route of selectedRoutes) {
          for (const viewport of viewports) {
            const matchingScenarios = scenarios.filter((scenario) =>
              (!scenario.modes || scenario.modes.includes(mode)) &&
              (!scenario.routeNames || scenario.routeNames.includes(route.name))
            );
            for (const scenario of matchingScenarios.length ? matchingScenarios : [{ name: 'default', actions: [] }]) {
              const result = await runCase(runtime, { repo, config, route, viewport, scenario, out, previousBaseline, updateBaseline });
              cases.push(result);
              currentBaseline.cases[result.caseId] = {
                screenshotSha256: result.screenshotSha256,
                metrics: result.metrics,
                findingSignatures: result.findings.map((f) => f.signature)
              };
            }
          }
        }
      } catch (error) {
        runtimeError = error;
      } finally {
        try { await runtime.close(); } catch {}
      }

      const findings = cases.flatMap((item) => item.findings);
      if (runtimeError) {
        findings.push(makeFinding('BROWSER-RUNTIME', 'P0', true, 'Browser audit aborted unexpectedly.', runtimeError.message, 'runtime'));
      }
      currentBaseline.findings = findings.map((f) => f.signature);
      const blockers = findings.filter((f) => f.introduced && ['P0', 'P1'].includes(f.severity));
      const baselineBlockers = updateBaseline ? findings.filter((f) => ['P0', 'P1'].includes(f.severity)) : [];
      let baselineUpdated = false;
      let baselineUpdateBlockedReason = null;
      if (updateBaseline) {
        const pendingCases = cases.filter((item) => item.visual?.status === 'BASELINE_PENDING');
        const missingScreenshots = pendingCases.filter((item) => !item.visual?.current || !pathExists(path.resolve(repo, item.visual.current)));
        if (!runtimeError && baselineBlockers.length === 0 && missingScreenshots.length === 0) {
          for (const item of pendingCases) {
            const current = path.resolve(repo, item.visual.current);
            const baseline = path.resolve(repo, item.visual.baseline);
            ensureDir(path.dirname(baseline));
            fs.copyFileSync(current, baseline);
            item.visual.status = 'BASELINE_UPDATED';
            item.visual.differentPixelRatio = 0;
          }
          writeJson(baselineFile, currentBaseline);
          baselineUpdated = true;
        } else {
          baselineUpdateBlockedReason = runtimeError
            ? 'Browser runtime failed.'
            : (baselineBlockers.length ? `${baselineBlockers.length} P0/P1 browser finding(s) must be resolved before baseline update.` : 'One or more current screenshots are missing.');
          for (const item of pendingCases) {
            item.visual.status = 'BASELINE_UPDATE_BLOCKED';
            item.visual.reason = baselineUpdateBlockedReason;
          }
        }
      }
      const visualNoBaseline = cases.some((item) => item.visual?.status === 'NO_BASELINE');
      const baselineUpdateFailed = updateBaseline && !baselineUpdated;
      const status = blockers.length || runtimeError || baselineUpdateFailed
        ? 'FAIL'
        : (!previousBaseline && !updateBaseline && visualNoBaseline ? 'NO_BASELINE' : (findings.length ? 'PASS_WITH_WARNINGS' : 'PASS'));
      const result = {
        generatedAt: new Date().toISOString(),
        status,
        mode,
        baseUrl: browserConfig.baseUrl,
        health,
        runtime: runtime.diagnostics,
        baselineFile: relativeTo(repo, baselineFile),
        baselineUpdateRequested: updateBaseline,
        baselineUpdated,
        baselineUpdateBlockedReason,
        baselineUpdateBlockerCount: baselineBlockers.length,
        selectedRoutes,
        viewports,
        caseCount: cases.length,
        blockerCount: blockers.length,
        findingSummary: summarize(findings),
        cases,
        findings
      };
      finish(result, blockers.length > 0 || Boolean(runtimeError) || baselineUpdateFailed);
    }
  }
}

async function runCase(runtime, context) {
  const { repo, config: cfg, route, viewport, scenario, out: output, previousBaseline: baseline, updateBaseline: updating } = context;
  const bc = cfg.browser || {};
  const visualConfig = bc.visual || {};
  const caseId = slug(`${route.name}__${viewport.width}x${viewport.height}__${scenario.name}`);
  const currentDir = path.resolve(repo, visualConfig.currentDir || path.join(cfg.project?.outputRoot || '.aiefficiency/quality', 'screenshots/current'));
  const baselineDir = path.resolve(repo, visualConfig.baselineDir || path.join(cfg.project?.outputRoot || '.aiefficiency/quality', 'baselines/screenshots'));
  const diffDir = path.resolve(repo, visualConfig.diffDir || path.join(cfg.project?.outputRoot || '.aiefficiency/quality', 'screenshots/diff'));
  ensureDir(currentDir); ensureDir(baselineDir); ensureDir(diffDir);
  const currentScreenshot = path.join(currentDir, `${caseId}.png`);
  const baselineScreenshot = path.join(baselineDir, `${caseId}.png`);
  const diffScreenshot = path.join(diffDir, `${caseId}.png`);
  const page = await runtime.newPage(viewport, bc);
  const consoleMessages = [];
  const pageErrors = [];
  const failedRequests = [];
  const responseErrors = [];
  attachEvents(page, consoleMessages, pageErrors, failedRequests, responseErrors, bc);
  await addInitMetrics(page);
  let navigation = null;
  let geometry = null;
  let actionResults = [];
  let screenshotSha256 = null;
  const url = new URL(route.path, bc.baseUrl).href;
  try {
    navigation = await runtime.goto(page, url, Number(bc.navigationTimeoutMs || 30000));
    await runtime.addStyle(page, buildAuditCss(bc.maskSelectors || []));
    await sleep(Number(bc.settleMs || 1200));
    actionResults = await performActions(runtime, page, scenario.actions || []);
    if ((scenario.actions || []).length) await sleep(Math.min(Number(bc.settleMs || 1200), 1000));
    geometry = await page.evaluate(auditDom, {
      criticalSelectors: bc.criticalSelectors || [],
      ignoreSelectors: bc.ignoreSelectors || [],
      loadingSelectors: bc.loadingSelectors || [],
      viewport,
      tolerance: 2
    });
    await runtime.screenshot(page, currentScreenshot);
    screenshotSha256 = fileSha256(currentScreenshot);
  } catch (error) {
    pageErrors.push(`CASE_ERROR: ${error.message}`);
    try { await runtime.screenshot(page, currentScreenshot); screenshotSha256 = fileSha256(currentScreenshot); } catch {}
  } finally {
    try { await page.close(); } catch {}
    try { await page.__aieffQualityContext?.close(); } catch {}
  }

  const findings = classifyFindings({
    caseId, route, viewport, scenario, navigation, geometry, consoleMessages, pageErrors,
    failedRequests, responseErrors, budgets: bc.budgets || {}, previousCase: baseline?.cases?.[caseId]
  });
  let visual = { status: 'SKIPPED', reason: 'Visual comparison disabled.' };
  if (visualConfig.enabled !== false && pathExists(currentScreenshot)) {
    if (updating) {
      visual = { status: 'BASELINE_PENDING', baseline: relativeTo(repo, baselineScreenshot), current: relativeTo(repo, currentScreenshot), differentPixelRatio: null };
    } else if (!pathExists(baselineScreenshot)) {
      visual = { status: 'NO_BASELINE', baseline: relativeTo(repo, baselineScreenshot), current: relativeTo(repo, currentScreenshot) };
      if (visualConfig.failWithoutBaseline === true) findings.push(makeFinding('UI-VISUAL-NO-BASELINE', 'P1', true, 'Reviewed screenshot baseline is missing.', caseId, caseId));
    } else {
      try {
        const comparison = comparePngFiles(baselineScreenshot, currentScreenshot, { channelTolerance: visualConfig.channelTolerance ?? 24 });
        if (comparison.diff) writePng(diffScreenshot, comparison.diff);
        const ratio = comparison.differentPixelRatio;
        const limit = Number(visualConfig.maxDifferentPixelRatio ?? 0.005);
        visual = {
          status: ratio > limit ? 'FAIL' : 'PASS',
          baseline: relativeTo(repo, baselineScreenshot),
          current: relativeTo(repo, currentScreenshot),
          diff: comparison.diff ? relativeTo(repo, diffScreenshot) : null,
          dimensionsMatch: comparison.dimensionsMatch,
          differentPixels: comparison.differentPixels,
          differentPixelRatio: ratio,
          maxDifferentPixelRatio: limit,
          meanChannelDelta: comparison.meanChannelDelta
        };
        if (ratio > limit) findings.push(makeFinding('UI-VISUAL-DIFF', 'P1', true, `Screenshot differs by ${(ratio * 100).toFixed(3)}%, over ${(limit * 100).toFixed(3)}% budget.`, caseId, caseId));
      } catch (error) {
        visual = { status: 'WARN', error: error.message, baseline: relativeTo(repo, baselineScreenshot), current: relativeTo(repo, currentScreenshot) };
        findings.push(makeFinding('UI-VISUAL-COMPARE', 'P2', true, 'Visual comparison could not be completed.', error.message, caseId));
      }
    }
  }

  return {
    caseId,
    route: { name: route.name, path: route.path },
    viewport,
    scenario: scenario.name,
    url,
    navigation,
    actionResults,
    metrics: geometry?.metrics || null,
    geometry: geometry ? { page: geometry.page, counts: geometry.counts } : null,
    consoleMessages,
    pageErrors,
    failedRequests,
    responseErrors,
    screenshot: pathExists(currentScreenshot) ? relativeTo(repo, currentScreenshot) : null,
    screenshotSha256,
    visual,
    findings
  };
}

function classifyFindings(ctx) {
  const findings = [];
  const baselineSignatures = new Set(ctx.previousCase?.findingSignatures || []);
  const add = (ruleId, severity, message, evidence, suffix = '') => {
    const signature = `${ctx.caseId}:${ruleId}:${suffix || normalizeEvidence(evidence)}`;
    const alwaysNew = ruleId.startsWith('PAGE-') || ruleId === 'BROWSER-RUNTIME';
    const introduced = alwaysNew || (ctx.previousCase ? !baselineSignatures.has(signature) : false);
    findings.push({ ruleId, severity, introduced, message, evidence, caseId: ctx.caseId, route: ctx.route.name, viewport: ctx.viewport, scenario: ctx.scenario.name, signature });
  };
  if (!ctx.navigation?.ok) add('PAGE-NAVIGATION', 'P0', 'Route failed to navigate successfully.', JSON.stringify(ctx.navigation), 'navigation');
  for (const error of ctx.pageErrors) add('PAGE-ERROR', 'P0', 'Unhandled browser page error.', error, error.slice(0, 120));
  for (const item of ctx.responseErrors) add('PAGE-HTTP-ERROR', item.status >= 500 ? 'P1' : 'P2', `HTTP ${item.status} while rendering route.`, item.url, `${item.status}:${stripUrl(item.url)}`);
  for (const item of ctx.failedRequests) add('PAGE-REQUEST-FAILED', 'P2', 'Network request failed.', `${item.url}: ${item.error}`, stripUrl(item.url));
  for (const item of ctx.consoleMessages.filter((m) => m.type === 'error')) add('PAGE-CONSOLE-ERROR', 'P2', 'Console error during route verification.', item.text, item.text.slice(0, 120));
  const g = ctx.geometry;
  if (!g) return findings;
  if (g.page.horizontalOverflowPx > 2) add('UI-H-OVERFLOW', 'P1', `Page horizontally overflows by ${g.page.horizontalOverflowPx}px.`, JSON.stringify(g.page), 'page');
  for (const item of g.fixedOutOfBounds || []) add('UI-FIXED-OOB', item.critical ? 'P1' : 'P2', 'Fixed/sticky/dialog element extends outside the viewport.', JSON.stringify(item), item.selector);
  for (const item of g.clipped || []) add('UI-CLIPPED', item.critical || item.interactive ? 'P1' : 'P2', 'Visible element is materially clipped by an overflow ancestor.', JSON.stringify(item), item.selector);
  for (const item of g.occluded || []) add('UI-OCCLUDED', item.critical || item.interactive ? 'P1' : 'P2', 'Interactive/critical element is covered by an unrelated layer.', JSON.stringify(item), item.selector);
  for (const item of g.layerCollisions || []) add('UI-LAYER-COLLISION', 'P1', 'Fixed/sticky layer overlaps a critical UI region.', JSON.stringify(item), `${item.layerSelector}->${item.criticalSelector}`);
  for (const item of g.dialogProblems || []) add('UI-DIALOG-FIT', 'P1', 'Dialog does not fit the viewport or lacks a reachable scroll contract.', JSON.stringify(item), item.selector);
  for (const item of g.loadingVisible || []) add('UI-STUCK-LOADING', 'P2', 'Loading marker is still visible after the settle window.', JSON.stringify(item), item.selector);
  const metrics = g.metrics || {};
  const budgets = ctx.budgets || {};
  if (Number.isFinite(metrics.lcp) && metrics.lcp > Number(budgets.lcpMs ?? Infinity)) add('PERF-LCP', 'P1', `LCP ${Math.round(metrics.lcp)}ms exceeds budget ${budgets.lcpMs}ms.`, String(metrics.lcp), 'lcp');
  if (Number.isFinite(metrics.cls) && metrics.cls > Number(budgets.cls ?? Infinity)) add('PERF-CLS', 'P1', `CLS ${metrics.cls.toFixed(4)} exceeds budget ${budgets.cls}.`, String(metrics.cls), 'cls');
  if (Number.isFinite(metrics.loadMs) && metrics.loadMs > Number(budgets.loadMs ?? Infinity)) add('PERF-LOAD', 'P1', `Load ${Math.round(metrics.loadMs)}ms exceeds budget ${budgets.loadMs}ms.`, String(metrics.loadMs), 'load');
  if (Number.isFinite(metrics.longTaskCount) && metrics.longTaskCount > Number(budgets.longTaskCount ?? Infinity)) add('PERF-LONG-TASKS', 'P1', `${metrics.longTaskCount} long tasks exceed budget ${budgets.longTaskCount}.`, String(metrics.longTaskCount), 'longtasks');
  if (Number.isFinite(metrics.transferBytes) && metrics.transferBytes > Number(budgets.transferBytes ?? Infinity)) add('PERF-TRANSFER', 'P1', `Transfer ${humanBytes(metrics.transferBytes)} exceeds ${humanBytes(budgets.transferBytes)}.`, String(metrics.transferBytes), 'transfer');
  if (Number.isFinite(metrics.resourceCount) && metrics.resourceCount > Number(budgets.resourceCount ?? Infinity)) add('PERF-RESOURCE-COUNT', 'P2', `${metrics.resourceCount} resources exceed budget ${budgets.resourceCount}.`, String(metrics.resourceCount), 'resources');
  return findings;
}

async function launchRuntime(repoRoot, cfg) {
  const candidates = resolveBrowserModules(repoRoot, cfg);
  const executable = findBrowserExecutable(cfg.browser?.executablePath);
  const errors = [];
  for (const candidate of candidates) {
    try {
      const mod = await import(pathToFileURL(candidate.resolved).href);
      if (candidate.name === 'playwright' || candidate.name === '@playwright/test') {
        const chromium = mod.chromium || mod.default?.chromium;
        if (!chromium) throw new Error('chromium export not found');
        const launchOptions = { headless: cfg.browser?.headless !== false, args: ['--disable-dev-shm-usage'] };
        if (executable) launchOptions.executablePath = executable;
        const browser = await chromium.launch(launchOptions);
        return {
          ok: true,
          diagnostics: { engine: 'playwright', module: candidate.name, packageRoot: candidate.packageRoot, executable: executable || 'bundled' },
          async newPage(viewport, bc) {
            const context = await browser.newContext({ viewport, ignoreHTTPSErrors: bc.ignoreHTTPSErrors !== false, extraHTTPHeaders: bc.extraHTTPHeaders || undefined });
            const page = await context.newPage();
            Object.defineProperty(page, '__aieffQualityContext', {
              configurable: true,
              enumerable: false,
              value: context
            });
            return page;
          },
          async goto(page, url, timeout) {
            const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
            return { ok: Boolean(response) && response.status() < 500, status: response?.status() ?? null, finalUrl: page.url() };
          },
          async addStyle(page, content) { await page.addStyleTag({ content }); },
          async screenshot(page, file) { await page.screenshot({ path: file, fullPage: false, animations: 'disabled' }); },
          async close() { await browser.close(); }
        };
      }
      if (candidate.name === 'puppeteer' || candidate.name === 'puppeteer-core') {
        const puppeteer = mod.default || mod;
        const launchOptions = { headless: cfg.browser?.headless !== false, args: ['--disable-dev-shm-usage', '--no-sandbox'] };
        if (executable) launchOptions.executablePath = executable;
        const browser = await puppeteer.launch(launchOptions);
        return {
          ok: true,
          diagnostics: { engine: 'puppeteer', module: candidate.name, packageRoot: candidate.packageRoot, executable: executable || 'bundled' },
          async newPage(viewport, bc) {
            const page = await browser.newPage();
            await page.setViewport(viewport);
            if (bc.extraHTTPHeaders) await page.setExtraHTTPHeaders(bc.extraHTTPHeaders);
            return page;
          },
          async goto(page, url, timeout) {
            const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
            return { ok: Boolean(response) && response.status() < 500, status: response?.status() ?? null, finalUrl: page.url() };
          },
          async addStyle(page, content) { await page.addStyleTag({ content }); },
          async screenshot(page, file) { await page.screenshot({ path: file, fullPage: false, type: 'png' }); },
          async close() { await browser.close(); }
        };
      }
    } catch (error) {
      errors.push(`${candidate.name}@${candidate.packageRoot}: ${error.message}`);
    }
  }
  return {
    ok: false,
    error: candidates.length
      ? `Browser modules were found but could not launch. ${errors.join(' | ')}`
      : 'No Playwright/Puppeteer module was found in the repository. Install one or reuse AIEfficiency gateway puppeteer-core.',
    diagnostics: { candidates: candidates.map((c) => ({ name: c.name, packageRoot: c.packageRoot })), executable, errors }
  };
}

function resolveBrowserModules(repoRoot, cfg) {
  const result = [];
  const roots = ['.', cfg.project?.frontendRoot, ...(cfg.project?.backendRoots || [])].filter(Boolean);
  for (const packageRoot of new Set(roots)) {
    const pkgFile = path.join(repoRoot, packageRoot, 'package.json');
    if (!pathExists(pkgFile)) continue;
    try {
      const req = createRequire(pkgFile);
      for (const name of ['playwright', '@playwright/test', 'puppeteer', 'puppeteer-core']) {
        try {
          const resolved = req.resolve(name);
          if (!result.some((item) => item.resolved === resolved)) result.push({ name, resolved, packageRoot });
        } catch {}
      }
    } catch {}
  }
  return result;
}

function findBrowserExecutable(configured) {
  const candidates = [
    configured, process.env.AIEFFICIENCY_BROWSER_PATH, process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    process.env.CHROME_PATH, process.env.EDGE_PATH,
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
  ].filter(Boolean).map((value) => path.resolve(String(value)));
  return candidates.find(pathExists) || null;
}

function selectRoutes(cfg, output, selectedMode, explicit) {
  const all = cfg.routes || [];
  if (explicit) {
    const names = String(explicit).split(',').map((x) => x.trim()).filter(Boolean);
    return all.filter((route) => names.includes(route.name) || names.includes(route.path));
  }
  const impactFile = path.join(output.artifacts, 'impact-map.json');
  const impact = pathExists(impactFile) ? readJson(impactFile, null) : null;
  const impactedNames = impact?.verificationTargets?.routeNames || [];
  if (
    selectedMode === 'deep' &&
    cfg.browser?.routeSelection?.deepAllCriticalRoutes !== false &&
    impact?.verificationTargets?.allCriticalRoutes === true
  ) return all;
  let selected = all.filter((route) => impactedNames.includes(route.name));
  if (!selected.length) selected = all.slice(0, selectedMode === 'quick' ? 1 : 3);
  if (selectedMode === 'quick') selected = selected.slice(0, Number(cfg.browser?.routeSelection?.quickMax || 2));
  return selected;
}

function attachEvents(page, consoleMessages, pageErrors, failedRequests, responseErrors, bc) {
  const ignore = (bc.networkIgnorePatterns || []).map((p) => String(p));
  page.on('console', (message) => {
    const type = typeof message.type === 'function' ? message.type() : 'log';
    const text = typeof message.text === 'function' ? message.text() : String(message);
    if (consoleMessages.length < 200) consoleMessages.push({ type, text: text.slice(0, 1000) });
  });
  page.on('pageerror', (error) => { if (pageErrors.length < 100) pageErrors.push(String(error?.message || error).slice(0, 2000)); });
  page.on('requestfailed', (request) => {
    const url = typeof request.url === 'function' ? request.url() : String(request.url || '');
    if (ignore.some((value) => url.includes(value))) return;
    const failure = typeof request.failure === 'function' ? request.failure() : null;
    if (failedRequests.length < 200) failedRequests.push({ url: redactUrl(url), error: failure?.errorText || 'request failed' });
  });
  page.on('response', (response) => {
    const status = typeof response.status === 'function' ? response.status() : 0;
    if (status < 400) return;
    const url = typeof response.url === 'function' ? response.url() : '';
    if (ignore.some((value) => url.includes(value))) return;
    if (responseErrors.length < 200) responseErrors.push({ status, url: redactUrl(url) });
  });
}

async function addInitMetrics(page) {
  const fn = () => {
    window.__aieffQualityMetrics = { lcp: null, cls: 0, longTasks: [], eventDurations: [] };
    try {
      new PerformanceObserver((list) => {
        const entries = list.getEntries();
        const last = entries[entries.length - 1];
        if (last) window.__aieffQualityMetrics.lcp = last.startTime;
      }).observe({ type: 'largest-contentful-paint', buffered: true });
    } catch {}
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) if (!entry.hadRecentInput) window.__aieffQualityMetrics.cls += entry.value;
      }).observe({ type: 'layout-shift', buffered: true });
    } catch {}
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) window.__aieffQualityMetrics.longTasks.push({ startTime: entry.startTime, duration: entry.duration });
      }).observe({ type: 'longtask', buffered: true });
    } catch {}
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) window.__aieffQualityMetrics.eventDurations.push(entry.duration);
      }).observe({ type: 'event', buffered: true, durationThreshold: 16 });
    } catch {}
  };
  if (typeof page.addInitScript === 'function') await page.addInitScript(fn);
  else if (typeof page.evaluateOnNewDocument === 'function') await page.evaluateOnNewDocument(fn);
}

function buildAuditCss(maskSelectors) {
  const masks = maskSelectors.length ? `${maskSelectors.join(',')} { visibility: hidden !important; }` : '';
  return `
    *, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; transition-duration: 0s !important; caret-color: transparent !important; }
    html { scroll-behavior: auto !important; }
    ${masks}
  `;
}

async function performActions(runtime, page, actions) {
  const results = [];
  for (const action of actions) {
    const started = Date.now();
    try {
      if (action.type === 'wait') await sleep(Number(action.ms || 100));
      else if (action.type === 'click') {
        const handle = await page.$(action.selector);
        if (!handle) {
          if (!action.optional) throw new Error(`Selector not found: ${action.selector}`);
          results.push({ ...action, status: 'SKIPPED', reason: 'selector not found', durationMs: Date.now() - started });
          continue;
        }
        await handle.click();
      } else if (action.type === 'fill') {
        const handle = await page.$(action.selector);
        if (!handle) {
          if (!action.optional) throw new Error(`Selector not found: ${action.selector}`);
          results.push({ ...action, status: 'SKIPPED', reason: 'selector not found', durationMs: Date.now() - started });
          continue;
        }
        await handle.evaluate((element, value) => {
          element.focus();
          element.value = value;
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
        }, String(action.value ?? ''));
      } else if (action.type === 'press') await page.keyboard.press(String(action.key || 'Enter'));
      else if (action.type === 'scroll') await page.evaluate((value) => window.scrollTo({ top: value === 'bottom' ? document.documentElement.scrollHeight : Number(value || 0), behavior: 'instant' }), action.value);
      else throw new Error(`Unsupported action type: ${action.type}`);
      results.push({ ...action, status: 'PASS', durationMs: Date.now() - started });
    } catch (error) {
      results.push({ ...action, status: action.optional ? 'SKIPPED' : 'FAIL', error: error.message, durationMs: Date.now() - started });
      if (!action.optional) throw error;
    }
  }
  return results;
}

function auditDom(options) {
  const { criticalSelectors, ignoreSelectors, loadingSelectors, viewport, tolerance } = options;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const doc = document.documentElement;
  const body = document.body;
  const ignored = (node) => ignoreSelectors.some((selector) => {
    try { return node.matches(selector) || node.closest(selector); } catch { return false; }
  });
  const isVisible = (node) => {
    if (!(node instanceof Element) || ignored(node)) return false;
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0.01 && rect.width > 1 && rect.height > 1;
  };
  const isCritical = (node) => criticalSelectors.some((selector) => {
    try { return node.matches(selector) || node.closest(selector); } catch { return false; }
  });
  const isInteractive = (node) => node.matches('button,a[href],input,select,textarea,[role="button"],[role="link"],[tabindex]:not([tabindex="-1"])');
  const selectorOf = (node) => {
    if (node.id) return `#${CSS.escape(node.id)}`;
    const testId = node.getAttribute('data-testid');
    if (testId) return `[data-testid="${testId.replaceAll('"', '\\"')}"]`;
    const region = node.getAttribute('data-ui-region');
    if (region) return `[data-ui-region="${region.replaceAll('"', '\\"')}"]`;
    const role = node.getAttribute('role');
    const aria = node.getAttribute('aria-label');
    if (role && aria) return `[role="${role}"][aria-label="${aria.replaceAll('"', '\\"')}"]`;
    const cls = [...node.classList].slice(0, 2).map((value) => `.${CSS.escape(value)}`).join('');
    return `${node.tagName.toLowerCase()}${cls}`;
  };
  const rectOf = (rect) => ({ left: round(rect.left), top: round(rect.top), right: round(rect.right), bottom: round(rect.bottom), width: round(rect.width), height: round(rect.height) });
  const round = (value) => Math.round(value * 10) / 10;
  const overlap = (a, b) => {
    const width = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
    const height = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    const area = width * height;
    return { area, ratioA: area / Math.max(1, a.width * a.height), ratioB: area / Math.max(1, b.width * b.height) };
  };
  const candidates = [...document.querySelectorAll('button,a[href],input,select,textarea,[role="button"],[role="dialog"],[aria-modal="true"],[data-ui-critical],[data-ui-region], [style*="position"]')]
    .filter(isVisible).slice(0, 800);
  const fixed = [...document.querySelectorAll('body *')].filter((node) => {
    if (!isVisible(node)) return false;
    const position = getComputedStyle(node).position;
    return position === 'fixed' || position === 'sticky';
  }).slice(0, 300);
  const critical = candidates.filter(isCritical);
  const fixedOutOfBounds = [];
  for (const node of fixed) {
    const rect = node.getBoundingClientRect();
    if (rect.left < -tolerance || rect.top < -tolerance || rect.right > vw + tolerance || rect.bottom > vh + tolerance) {
      fixedOutOfBounds.push({ selector: selectorOf(node), rect: rectOf(rect), position: getComputedStyle(node).position, critical: isCritical(node), interactive: isInteractive(node) });
    }
  }
  const clipped = [];
  for (const node of candidates) {
    const rect = node.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > vh || rect.right < 0 || rect.left > vw) continue;
    let ancestor = node.parentElement;
    while (ancestor && ancestor !== body && ancestor !== doc) {
      const style = getComputedStyle(ancestor);
      if (/(hidden|clip|auto|scroll)/.test(`${style.overflowX} ${style.overflowY}`)) {
        const ar = ancestor.getBoundingClientRect();
        const hit = overlap(rect, ar);
        if (hit.ratioA < 0.65 && hit.area > 0) {
          clipped.push({ selector: selectorOf(node), ancestor: selectorOf(ancestor), rect: rectOf(rect), ancestorRect: rectOf(ar), visibleRatio: round(hit.ratioA), critical: isCritical(node), interactive: isInteractive(node) });
          break;
        }
      }
      ancestor = ancestor.parentElement;
    }
  }
  const occluded = [];
  for (const node of candidates.filter((item) => isInteractive(item) || isCritical(item)).slice(0, 350)) {
    const rect = node.getBoundingClientRect();
    const left = Math.max(0, rect.left + Math.min(6, rect.width / 4));
    const right = Math.min(vw - 1, rect.right - Math.min(6, rect.width / 4));
    const top = Math.max(0, rect.top + Math.min(6, rect.height / 4));
    const bottom = Math.min(vh - 1, rect.bottom - Math.min(6, rect.height / 4));
    if (right <= left || bottom <= top) continue;
    const points = [[(left + right) / 2, (top + bottom) / 2], [left, top], [right, top], [left, bottom], [right, bottom]];
    const blockers = [];
    for (const [x, y] of points) {
      const stack = document.elementsFromPoint(x, y).filter((item) => getComputedStyle(item).pointerEvents !== 'none');
      const topNode = stack[0];
      if (!topNode) continue;
      if (topNode === node || node.contains(topNode) || topNode.contains(node)) continue;
      blockers.push(selectorOf(topNode));
    }
    if (blockers.length >= 3) occluded.push({ selector: selectorOf(node), blockers: [...new Set(blockers)], rect: rectOf(rect), critical: isCritical(node), interactive: isInteractive(node) });
  }
  const layerCollisions = [];
  for (const layer of fixed) {
    for (const target of critical) {
      if (layer === target || layer.contains(target) || target.contains(layer)) continue;
      const hit = overlap(layer.getBoundingClientRect(), target.getBoundingClientRect());
      if (hit.area > 64 && (hit.ratioA > 0.15 || hit.ratioB > 0.15)) {
        layerCollisions.push({ layerSelector: selectorOf(layer), criticalSelector: selectorOf(target), overlapArea: round(hit.area), layerRatio: round(hit.ratioA), criticalRatio: round(hit.ratioB) });
      }
    }
  }
  const dialogs = [...document.querySelectorAll('[role="dialog"],[aria-modal="true"]')].filter(isVisible);
  const dialogProblems = [];
  for (const node of dialogs) {
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    const out = rect.top < -tolerance || rect.left < -tolerance || rect.right > vw + tolerance || rect.bottom > vh + tolerance;
    const scrollable = /(auto|scroll)/.test(`${style.overflowY} ${style.overflow}`) || node.scrollHeight > node.clientHeight + 2;
    if (out && !scrollable) dialogProblems.push({ selector: selectorOf(node), rect: rectOf(rect), scrollHeight: node.scrollHeight, clientHeight: node.clientHeight, overflowY: style.overflowY });
  }
  const loadingVisible = [];
  for (const selector of loadingSelectors) {
    let nodes = [];
    try { nodes = [...document.querySelectorAll(selector)]; } catch {}
    for (const node of nodes.filter(isVisible)) loadingVisible.push({ selector: selectorOf(node), matchedBy: selector });
  }
  const nav = performance.getEntriesByType('navigation')[0];
  const resources = performance.getEntriesByType('resource');
  const qm = window.__aieffQualityMetrics || {};
  const transferBytes = resources.reduce((sum, item) => sum + (item.transferSize || 0), 0);
  const decodedBytes = resources.reduce((sum, item) => sum + (item.decodedBodySize || 0), 0);
  const metrics = {
    lcp: Number.isFinite(qm.lcp) ? qm.lcp : null,
    cls: Number.isFinite(qm.cls) ? qm.cls : null,
    longTaskCount: Array.isArray(qm.longTasks) ? qm.longTasks.length : 0,
    longTaskTotalMs: Array.isArray(qm.longTasks) ? qm.longTasks.reduce((sum, item) => sum + item.duration, 0) : 0,
    maxEventDurationMs: Array.isArray(qm.eventDurations) && qm.eventDurations.length ? Math.max(...qm.eventDurations) : null,
    ttfbMs: nav ? nav.responseStart : null,
    domContentLoadedMs: nav ? nav.domContentLoadedEventEnd : null,
    loadMs: nav ? nav.loadEventEnd : null,
    resourceCount: resources.length,
    transferBytes,
    decodedBytes
  };
  return {
    page: {
      viewport: { width: vw, height: vh },
      document: { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth, scrollHeight: doc.scrollHeight, clientHeight: doc.clientHeight },
      body: body ? { scrollWidth: body.scrollWidth, clientWidth: body.clientWidth, scrollHeight: body.scrollHeight, clientHeight: body.clientHeight } : null,
      horizontalOverflowPx: Math.max(0, doc.scrollWidth - doc.clientWidth)
    },
    counts: { candidates: candidates.length, fixed: fixed.length, critical: critical.length, dialogs: dialogs.length },
    fixedOutOfBounds, clipped, occluded, layerCollisions, dialogProblems, loadingVisible, metrics
  };
}

function makeFinding(ruleId, severity, introduced, message, evidence, suffix) {
  return { ruleId, severity, introduced, message, evidence, signature: `${suffix}:${ruleId}:${normalizeEvidence(evidence)}` };
}

function normalizeEvidence(value) { return String(value || '').replace(/\d+/g, '#').slice(0, 160); }
function stripUrl(value) { try { const url = new URL(value); return `${url.pathname}${url.search}`; } catch { return String(value); } }
function redactUrl(value) { try { const url = new URL(value); url.username = ''; url.password = ''; for (const key of [...url.searchParams.keys()]) if (/token|key|secret|cookie|auth/i.test(key)) url.searchParams.set(key, '<redacted>'); return url.toString(); } catch { return String(value); } }
function slug(value) { return String(value).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 180); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function probeUrl(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { redirect: 'manual', signal: controller.signal });
    return { ok: response.status > 0 && response.status < 500, status: response.status, url };
  } catch (error) {
    return { ok: false, status: null, url, error: error.name === 'AbortError' ? 'timeout' : error.message };
  } finally { clearTimeout(timer); }
}

function summarize(items) {
  const result = { total: items.length, introduced: 0, existing: 0, P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const item of items) {
    result[item.introduced ? 'introduced' : 'existing'] += 1;
    if (result[item.severity] !== undefined) result[item.severity] += 1;
  }
  return result;
}

function finish(result, failed) {
  const jsonFile = path.join(out.artifacts, 'browser-audit.json');
  const mdFile = path.join(out.artifacts, 'browser-audit.md');
  writeJson(jsonFile, result);
  writeText(mdFile, renderMarkdown(result));
  console.log(JSON.stringify({ status: result.status, mode: result.mode, caseCount: result.caseCount || 0, blockerCount: result.blockerCount || 0, reason: result.reason || null, artifacts: { json: relativeTo(repo, jsonFile), markdown: relativeTo(repo, mdFile) } }, null, 2));
  process.exitCode = failed && !args['no-fail'] ? 1 : 0;
}

function renderMarkdown(result) {
  if (!result.cases?.length) return `# Browser UI Audit\n\n- Status: **${result.status}**\n- Mode: ${result.mode}\n- Reason: ${result.reason || 'No browser cases executed.'}\n`;
  const caseRows = result.cases.map((item) => [item.caseId, item.navigation?.status ?? '-', item.findings.filter((f) => f.introduced && ['P0', 'P1'].includes(f.severity)).length, item.visual?.status || '-', item.screenshot || '-']);
  const findingRows = result.findings.map((item) => [item.severity, item.introduced ? 'NEW' : 'baseline', item.caseId || '-', item.ruleId, item.message]);
  return `# Browser UI / Visual / Performance Audit\n\n- Status: **${result.status}**\n- Mode: **${result.mode}**\n- Cases: **${result.caseCount}**\n- Blocking new findings: **${result.blockerCount}**\n- Runtime: ${result.runtime?.engine || '-'} / ${result.runtime?.module || '-'}\n- Baseline updated: ${result.baselineUpdated}\n\n## Cases\n\n${markdownTable(['Case', 'HTTP', 'New blockers', 'Visual', 'Screenshot'], caseRows)}\n\n## Findings\n\n${markdownTable(['Severity', 'Scope', 'Case', 'Rule', 'Message'], findingRows.length ? findingRows : [['-', '-', '-', '-', 'No findings']])}\n\n## Metrics\n\n${markdownTable(['Case', 'LCP', 'CLS', 'Load', 'Long tasks', 'Transfer', 'Resources'], result.cases.map((item) => { const m = item.metrics || {}; return [item.caseId, m.lcp == null ? '-' : `${Math.round(m.lcp)}ms`, m.cls == null ? '-' : m.cls.toFixed(4), m.loadMs == null ? '-' : `${Math.round(m.loadMs)}ms`, m.longTaskCount ?? '-', m.transferBytes == null ? '-' : humanBytes(m.transferBytes), m.resourceCount ?? '-']; }))}\n`;
}
