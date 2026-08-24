/**
 * 前端纯逻辑单元测试（diaglogic.js）：环境结论、识别文案、工具安装方式、查询串。
 * 无 DOM 依赖，node:test 直接跑。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  envMissingRequired,
  envOkToCompile,
  toolAction,
  recoText,
  apiQuery,
  isRemoteAiMode,
  shouldWarnNoAiServer,
  aiModelDiagHeadline,
  aiCliStatusLabel,
  aiCliNeedsUpgrade,
  aiCliUpgradeableEngines,
  aiCliUpgradeButtonLabel,
} from "./diaglogic.js";

const env = (results, hasWinget = true) => ({ results, hasWinget, okToCompile: false });

test("envMissingRequired：列出缺失的必需工具", () => {
  const d = env([
    { key: "git", name: "Git", required: true, installed: true },
    { key: "java", name: "Java (JDK)", required: true, installed: false },
    { key: "adb", name: "ADB", required: false, installed: false },
  ]);
  assert.deepEqual(envMissingRequired(d), ["Java (JDK)"]); // adb 可选不计入
});

test("envMissingRequired：空/异常输入", () => {
  assert.deepEqual(envMissingRequired(null), []);
  assert.deepEqual(envMissingRequired({}), []);
  assert.deepEqual(envMissingRequired({ results: "x" }), []);
});

test("envOkToCompile：必需全装→true，缺一→false", () => {
  assert.equal(envOkToCompile(env([{ required: true, installed: true }, { required: false, installed: false }])), true);
  assert.equal(envOkToCompile(env([{ required: true, installed: false }])), false);
  assert.equal(envOkToCompile(null), false);
  assert.equal(envOkToCompile(env([])), true); // 无必需项 → 视为可编译
});

test("toolAction：已装 none / 有winget install / 无winget manual", () => {
  assert.equal(toolAction({ installed: true }, true), "none");
  assert.equal(toolAction({ installed: false }, true), "install");
  assert.equal(toolAction({ installed: false }, false), "manual");
  assert.equal(toolAction(null, true), "none");
});

test("recoText：应用+车型 / 只一个 / 都无 / null", () => {
  assert.equal(recoText({ app: "App Market", vehicle: "avatr8678" }), "（识别：应用 App Market、车型 avatr8678）");
  assert.equal(recoText({ app: "App Market", vehicle: "" }), "（识别：应用 App Market）");
  assert.equal(recoText({ app: "", vehicle: "avatr8678" }), "（识别：车型 avatr8678）");
  assert.equal(recoText({ app: "", vehicle: "" }), "");
  assert.equal(recoText(null), "");
});

test("apiQuery：projectId/refresh 组合 + 编码", () => {
  assert.equal(apiQuery({}), "");
  assert.equal(apiQuery({ projectId: "p1" }), "?projectId=p1");
  assert.equal(apiQuery({ refresh: true }), "?refresh=1");
  assert.equal(apiQuery({ projectId: "p1", refresh: true }), "?refresh=1&projectId=p1");
  assert.equal(apiQuery({ projectId: "a b/c" }), "?projectId=a%20b%2Fc");
});

test("纯客户端模式：node 角色始终使用 AI 服务器", () => {
  const localNode = { role: "node", claudeProxyClient: { enabled: false, host: "http://old-server:3001" } };
  assert.equal(isRemoteAiMode(localNode), true);
  assert.equal(shouldWarnNoAiServer(localNode, []), true);
});

test("单机模式：standalone 关闭远端开关后使用本机 AI", () => {
  const standalone = { role: "standalone", claudeProxyClient: { enabled: false, host: "http://old-server:3001" } };
  assert.equal(isRemoteAiMode(standalone), false);
  assert.equal(shouldWarnNoAiServer(standalone, []), false);
});

test("旧配置同时开启本机和远端代理时，本机模式优先且不提示", () => {
  const conflicted = {
    role: "standalone",
    claudeProxy: { enabled: true },
    claudeProxyClient: { enabled: true, host: "http://old-server:3001" },
  };
  assert.equal(isRemoteAiMode(conflicted), false);
  assert.equal(shouldWarnNoAiServer(conflicted, []), false);
});

test("借用服务端模式：仅在没有可用算力时提示", () => {
  const remoteNode = { role: "node", claudeProxyClient: { enabled: true } };
  assert.equal(shouldWarnNoAiServer(remoteNode, []), true);
  assert.equal(shouldWarnNoAiServer(remoteNode, [{ isServer: true, claudeEnabled: true, full: true }]), true);
  assert.equal(shouldWarnNoAiServer(remoteNode, [{ isServer: true, claudeEnabled: true, full: false }]), false);
});

test("aiModelDiagHeadline：按摘要生成文案", () => {
  assert.equal(aiModelDiagHeadline(null), "");
  assert.equal(aiModelDiagHeadline({ allLatest: true }), "全部已装 CLI 均为最新版本");
  assert.equal(aiModelDiagHeadline({ anyOutdated: true, outdated: 2 }), "2 个 CLI 可升级到最新版");
  assert.equal(aiModelDiagHeadline({ missing: 3, total: 3 }), "尚未检测到已安装的 AI CLI");
  assert.equal(aiModelDiagHeadline({ installed: 1, total: 3 }), "已检测 1 个 CLI，可查看可见模型");
});

test("aiCliStatusLabel：状态标签", () => {
  assert.equal(aiCliStatusLabel("up_to_date").text, "已是最新");
  assert.equal(aiCliStatusLabel("outdated").tone, "warn");
  assert.equal(aiCliStatusLabel("not_installed").text, "未安装");
  assert.equal(aiCliStatusLabel("").text, "未检测");
});

test("aiCliNeedsUpgrade / upgradeable / 按钮文案", () => {
  assert.equal(aiCliNeedsUpgrade({ status: "outdated" }), true);
  assert.equal(aiCliNeedsUpgrade({ status: "not_installed" }), true);
  assert.equal(aiCliNeedsUpgrade({ status: "not_installed", autoUpgradeable: false }), false);
  assert.equal(aiCliNeedsUpgrade({ status: "up_to_date" }), false);
  const list = aiCliUpgradeableEngines([
    { id: "claude", status: "outdated" },
    { id: "codex", status: "up_to_date" },
    { id: "gemini", status: "not_installed" },
    { id: "hermes", status: "not_installed", autoUpgradeable: false },
  ]);
  assert.deepEqual(list.map((e) => e.id), ["claude", "gemini"]);
  assert.equal(aiCliUpgradeButtonLabel({ status: "outdated" }), "一键升级到最新");
  assert.equal(aiCliUpgradeButtonLabel({ status: "not_installed" }), "一键安装最新版");
  assert.equal(aiCliUpgradeButtonLabel({ status: "outdated" }, { busy: true }), "升级中…");
});
