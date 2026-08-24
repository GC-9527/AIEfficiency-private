#!/usr/bin/env node
/**
 * devbench 验收·埋点 DB 查询 CLI（验收 Agent 调用）
 *
 * 用法：
 *   node <gateway>/services/devbench/run-buried-point.mjs \
 *     --env prod --query "SELECT * FROM events WHERE event='xxx' AND uid='...' ORDER BY ts DESC LIMIT 5" \
 *     --tab <story-tab-id> \
 *     --out "<cloneParent>/AllDocs/StoryDev/<slug>/reports/buried-point/tc01.json" [--expect "xxx"]
 *
 * 行为：在配置的对应环境数据库执行查询，把结果存成证据 JSON 到 --out，并打印
 *   [devbench-bp] {found,count,env,out}
 * 查到（count>0，且若给了 --expect 则原始结果包含该子串）→ exit 0；否则 exit 1。
 * DB 连接信息读 gateway/buried-point-db.json（不进 git）。凭据不会写进证据文件。
 */
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { queryEnv, listEnvs } from "./buried-point.js";
import * as store from "./store.js";

function arg(name, def = "") {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const env = arg("--env");
let query = arg("--query");
const queryFile = arg("--query-file");
const out = arg("--out");
const tabId = arg("--tab");
const expect = arg("--expect");
if (queryFile && !query) { try { query = readFileSync(queryFile, "utf-8"); } catch {} }

if (!env || !query) {
  console.error("用法: --env <环境> --query <SQL>|--query-file <文件> --tab <故事点ID> --out <证据json> [--expect <子串>]");
  console.error("已配置环境: " + (listEnvs().join(", ") || "(无——请配置 gateway/buried-point-db.json)"));
  process.exit(2);
}

let evidenceOut = "";
if (out) {
  if (!tabId) {
    console.error("指定 --out 时必须同时提供 --tab，证据只能写入该故事点的外置 reports 目录");
    process.exit(2);
  }
  const tab = store.getTab(tabId);
  if (!tab) {
    console.error(`故事点不存在：${tabId}`);
    process.exit(2);
  }
  if (!path.isAbsolute(out)) {
    console.error("--out 必须是当前故事点外置 reports 目录内的绝对路径");
    process.exit(2);
  }
  try {
    const storage = store.getStoryStoragePaths(tab, { create: true });
    evidenceOut = store.validateStoryStorageTarget(tab, path.resolve(out), {
      baseDirectory: storage.reportsDirectory,
      createParentDirectories: true,
      mustExist: false,
      expectedType: "file",
    });
  } catch (error) {
    console.error(`--out 必须位于当前故事点的外置 reports 目录内：${error.message}`);
    process.exit(2);
  }
}

const r = await queryEnv(env, query);
const found = !!(r.ok && (r.count || 0) > 0 && (!expect || String(r.raw || "").includes(expect)));
const evidence = {
  env, query, at: new Date().toISOString(),
  ok: r.ok, count: r.count || 0, found,
  expect: expect || null,
  rows: Array.isArray(r.rows) ? r.rows.slice(0, 50) : r.rows,
  raw: r.raw || null,
  error: r.error || null,
};
let evidenceWriteFailed = false;
if (evidenceOut) {
  try {
    mkdirSync(path.dirname(evidenceOut), { recursive: true });
    writeFileSync(evidenceOut, JSON.stringify(evidence, null, 2), "utf-8");
    const tab = store.getTab(tabId);
    const storage = store.getStoryStoragePaths(tab, { create: true });
    store.validateStoryStorageTarget(tab, evidenceOut, {
      baseDirectory: storage.reportsDirectory,
      mustExist: true,
      expectedType: "file",
    });
  } catch (e) {
    evidenceWriteFailed = true;
    console.error("写证据失败:", e.message);
  }
}
console.log("[devbench-bp] " + JSON.stringify({ found, count: r.count || 0, env, ok: r.ok, out: evidenceOut || null, error: r.error || null }));
process.exit(evidenceWriteFailed ? 2 : found ? 0 : 1);
