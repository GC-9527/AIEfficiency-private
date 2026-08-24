#!/usr/bin/env node
/**
 * 验收测试运行器：自动发现 test/*.test.mjs，【每个文件单独子进程】跑 `node --test`。
 *
 * 为何不直接 `node --test test/*.mjs`：本仓 Node(22.11) 不支持 --test-isolation，多文件会塞进同一进程，
 * 而 store.js / db/sqlite.js 等在模块加载期一次性读 env 路径(DEVBENCH_CONFIG_PATH/GATEWAY_DB_PATH)，
 * 先 import 的文件会把路径固化，导致后续文件读写到别人的库 → 跨文件污染、假性失败。
 * 逐文件独立进程可彻底隔离，且新增 *.test.mjs 自动纳入，无需再手维护 package.json 里的长文件列表。
 *
 * 用法：node scripts/run-tests.mjs [子串过滤...]   例：node scripts/run-tests.mjs store forward
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GW_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEST_DIR = path.join(GW_DIR, "test");
const SUMMARY_KEYS = ["tests", "pass", "fail", "cancelled", "skipped", "todo"];
const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;

function normalizeOutput(value) {
  return String(value || "").replace(ANSI_PATTERN, "").replace(/\r\n/g, "\n");
}

/**
 * 解析 Node TAP/spec reporter 的最终汇总。主流程固定使用 TAP；兼容 spec 是为了让
 * 聚合器测试能够覆盖 Node 版本漂移，并在人工传入输出时仍给出可审计结果。
 */
export function parseNodeTestSummary(output) {
  const counts = Object.fromEntries(SUMMARY_KEYS.map((key) => [key, null]));
  for (const rawLine of normalizeOutput(output).split("\n")) {
    const line = rawLine.trim();
    const match = line.match(/^(?:#|ℹ)\s+(tests|pass|fail|cancelled|skipped|todo)\s+(\d+)\s*$/u);
    if (match) counts[match[1]] = Number(match[2]);
  }

  const complete = SUMMARY_KEYS.every((key) => Number.isSafeInteger(counts[key]));
  const accounted = complete
    ? counts.pass + counts.fail + counts.cancelled + counts.skipped + counts.todo
    : null;
  return {
    ...counts,
    complete,
    consistent: complete && counts.tests === accounted,
    accounted,
  };
}

function mergeRanges(ranges) {
  const sorted = ranges
    .filter(([start, end]) => end >= start)
    .sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (!previous || range[0] > previous[1] + 1) merged.push([...range]);
    else previous[1] = Math.max(previous[1], range[1]);
  }
  return merged;
}

/** 失败时保留每个 `not ok` 的错误块和尾部汇总，避免只剩一个文件名。 */
export function excerptFailureStream(output, { contextAfter = 40, tailLines = 24 } = {}) {
  const normalized = normalizeOutput(output).trimEnd();
  if (!normalized) return "<空>";
  const lines = normalized.split("\n");
  const ranges = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*not ok\b/.test(lines[index])) {
      ranges.push([Math.max(0, index - 2), Math.min(lines.length - 1, index + contextAfter)]);
    }
  }
  ranges.push([Math.max(0, lines.length - tailLines), lines.length - 1]);

  const selected = [];
  let previousEnd = -1;
  for (const [start, end] of mergeRanges(ranges)) {
    if (start > previousEnd + 1) selected.push(`... 省略 ${start - previousEnd - 1} 行 ...`);
    selected.push(...lines.slice(start, end + 1));
    previousEnd = end;
  }
  return selected.join("\n");
}

export function evaluateTestProcess(file, processResult) {
  const stdout = normalizeOutput(processResult?.stdout);
  const stderr = normalizeOutput(processResult?.stderr);
  const summary = parseNodeTestSummary(stdout);
  const protocolIssues = [];

  if (!summary.complete) protocolIssues.push("缺少 Node 测试最终汇总");
  else if (!summary.consistent) {
    protocolIssues.push(
      `汇总不一致：tests=${summary.tests}，已归类=${summary.accounted}`,
    );
  }
  if (processResult?.error) protocolIssues.push(`子进程错误：${processResult.error.message}`);
  if (processResult?.signal) protocolIssues.push(`子进程被信号终止：${processResult.signal}`);
  if (!Number.isInteger(processResult?.status)) {
    protocolIssues.push(`子进程缺少退出码：${String(processResult?.status)}`);
  }

  const ok = processResult?.status === 0
    && !processResult?.error
    && !processResult?.signal
    && summary.complete
    && summary.consistent
    && summary.fail === 0;

  return {
    file,
    stdout,
    stderr,
    status: processResult?.status ?? null,
    signal: processResult?.signal ?? null,
    summary,
    protocolIssues,
    ok,
  };
}

function displayCount(value) {
  return Number.isSafeInteger(value) ? String(value) : "?";
}

export function runTestFiles(files, {
  cwd = GW_DIR,
  spawnImpl = spawnSync,
  nodePath = process.execPath,
  env = process.env,
  write = (line) => console.log(line),
} = {}) {
  const results = [];
  for (const file of files) {
    const rel = path.join("test", file);
    // 每个文件只执行一次。任何一次非零退出都直接保留为本轮失败，不做自动重跑。
    const processResult = spawnImpl(
      nodePath,
      ["--test", "--test-reporter=tap", "--test-timeout=60000", rel],
      {
        cwd,
        encoding: "utf8",
        env,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    const result = evaluateTestProcess(file, processResult);
    results.push(result);

    const { summary } = result;
    write(
      `${result.ok ? "✅" : "❌"} ${file.padEnd(48)}`
      + ` tests=${displayCount(summary.tests)}`
      + ` pass=${displayCount(summary.pass)}`
      + ` fail=${displayCount(summary.fail)}`
      + ` skipped=${displayCount(summary.skipped)}`,
    );

    if (!result.ok) {
      write(`    退出：status=${String(result.status)} signal=${String(result.signal || "-")}`);
      for (const issue of result.protocolIssues) write(`    聚合协议：${issue}`);
      write("    stdout 摘要:");
      for (const line of excerptFailureStream(result.stdout).split("\n")) write(`      ${line}`);
      write("    stderr 摘要:");
      for (const line of excerptFailureStream(result.stderr, { contextAfter: 20, tailLines: 40 }).split("\n")) {
        write(`      ${line}`);
      }
    }
  }
  return results;
}

export function summarizeResults(results) {
  const known = results.filter((result) => result.summary.complete && result.summary.consistent);
  const totals = Object.fromEntries(
    SUMMARY_KEYS.map((key) => [
      key,
      known.reduce((total, result) => total + result.summary[key], 0),
    ]),
  );
  const failedFiles = results.filter((result) => !result.ok);
  return {
    files: results.length,
    passedFiles: results.length - failedFiles.length,
    failedFiles,
    unknownSummaryFiles: results.length - known.length,
    totals,
    ok: failedFiles.length === 0,
  };
}

export function main({
  filters = process.argv.slice(2),
  listFiles = () => readdirSync(TEST_DIR),
  write = (line) => console.log(line),
  writeError = (line) => console.error(line),
  spawnImpl = spawnSync,
  now = () => Date.now(),
} = {}) {
  let files = listFiles()
    .filter((file) => file.endsWith(".test.mjs"))
    .sort();
  if (filters.length) files = files.filter((file) => filters.some((filter) => file.includes(filter)));

  if (!files.length) {
    writeError("未发现匹配的测试文件");
    return 1;
  }

  write("");
  write(`运行 ${files.length} 个测试文件（逐文件独立进程隔离，TAP 可审计汇总）`);
  write("");
  const startedAt = now();
  const results = runTestFiles(files, { spawnImpl, write });
  const aggregate = summarizeResults(results);
  const elapsedSeconds = ((now() - startedAt) / 1000).toFixed(1);

  write("");
  write("──────────────────────────────────────────");
  write(
    `合计：文件 ${aggregate.files}`
    + `（通过 ${aggregate.passedFiles} / 失败 ${aggregate.failedFiles.length}）`
    + ` | 用例 tests=${aggregate.totals.tests}`
    + ` pass=${aggregate.totals.pass}`
    + ` fail=${aggregate.totals.fail}`
    + ` skipped=${aggregate.totals.skipped}`
    + ` cancelled=${aggregate.totals.cancelled}`
    + ` todo=${aggregate.totals.todo}`
    + ` | 未知汇总文件 ${aggregate.unknownSummaryFiles}`
    + ` | 耗时 ${elapsedSeconds}s`,
  );
  if (aggregate.failedFiles.length) {
    write(`失败文件：${aggregate.failedFiles.map((result) => result.file).join(", ")}`);
    return 1;
  }
  write("全部通过 ✅");
  return 0;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const modulePath = fileURLToPath(import.meta.url);
if (invokedPath.toLowerCase() === modulePath.toLowerCase()) {
  process.exitCode = main();
}
