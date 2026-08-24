/**
 * AI 模型诊断纯逻辑单测（不探测本机 CLI / 不访问 npm）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compareSemver,
  diagnoseAiModels,
  extractVersion,
  summarizeEngines,
  versionStatus,
} from "../services/devbench/ai-model-diag.js";

test("extractVersion：从 CLI 输出提取版本号", () => {
  assert.equal(extractVersion("2.1.207 (Claude Code)"), "2.1.207");
  assert.equal(extractVersion("codex-cli 0.145.0"), "0.145.0");
  assert.equal(extractVersion("0.52.0"), "0.52.0");
  assert.equal(extractVersion("no version here"), "");
});

test("compareSemver：大小与相等", () => {
  assert.equal(compareSemver("2.1.220", "2.1.207"), 1);
  assert.equal(compareSemver("2.1.207", "2.1.220"), -1);
  assert.equal(compareSemver("0.145.0", "0.145.0"), 0);
  assert.equal(compareSemver("bad", "1.0.0"), null);
});

test("versionStatus：安装态映射", () => {
  assert.equal(versionStatus("", "1.0.0", false), "not_installed");
  assert.equal(versionStatus("1.0.0", "1.0.1", true), "outdated");
  assert.equal(versionStatus("1.0.1", "1.0.0", true), "up_to_date");
  assert.equal(versionStatus("1.0.0", "1.0.0", true), "up_to_date");
  assert.equal(versionStatus("1.0.0", "", true), "unknown");
});

test("summarizeEngines：汇总计数", () => {
  const s = summarizeEngines([
    { installed: true, status: "up_to_date" },
    { installed: true, status: "outdated" },
    { installed: false, status: "not_installed" },
  ]);
  assert.equal(s.total, 3);
  assert.equal(s.installed, 2);
  assert.equal(s.upToDate, 1);
  assert.equal(s.outdated, 1);
  assert.equal(s.missing, 1);
  assert.equal(s.allLatest, false);
  assert.equal(s.anyOutdated, true);
});

test("diagnoseAiModels：注入依赖后返回结构与可见模型", async () => {
  const data = await diagnoseAiModels({
    probe: async (cmd) => {
      if (cmd === "claude") return { ok: true, out: "2.1.207 (Claude Code)" };
      if (cmd === "codex") return { ok: true, out: "codex-cli 0.145.0" };
      return { ok: false, out: "not found" };
    },
    fetchLatest: async (pkg) => {
      if (pkg.includes("claude")) return { version: "2.1.220", error: "" };
      if (pkg.includes("codex")) return { version: "0.145.0", error: "" };
      if (pkg.includes("gemini")) return { version: "0.52.0", error: "" };
      return { version: "", error: "unknown" };
    },
    getMetadata: () => ({
      claude: { model: "claude-opus-4-8", tier: "high", source: "用户配置" },
      codex: { model: "gpt-5.4", tier: "xhigh", source: "用户配置" },
      gemini: { model: "", tier: "", source: "" },
    }),
    getCfg: () => ({
      apiEngines: {
        deepseek: {
          name: "DeepSeek",
          enabled: true,
          apiKey: "x",
          model: "deepseek-v4-pro",
          availableModels: ["deepseek-v4-pro", "deepseek-chat"],
        },
      },
    }),
  });

  assert.ok(data.checkedAt);
  assert.equal(data.engines.length, 6);
  const claude = data.engines.find((e) => e.id === "claude");
  assert.equal(claude.status, "outdated");
  assert.equal(claude.localVersion, "2.1.207");
  assert.equal(claude.latestVersion, "2.1.220");
  assert.ok(claude.models.includes("claude-opus-4-8"));
  assert.ok(claude.latestModels.length > 0);
  assert.equal(claude.currentModel, "claude-opus-4-8");

  const codex = data.engines.find((e) => e.id === "codex");
  assert.equal(codex.status, "up_to_date");

  const gemini = data.engines.find((e) => e.id === "gemini");
  assert.equal(gemini.status, "not_installed");
  assert.ok(gemini.models.includes("gemini-3.1-pro-preview"));

  const hermes = data.engines.find((e) => e.id === "hermes");
  assert.equal(hermes.status, "not_installed");
  assert.equal(hermes.autoUpgradeable, false);
  assert.equal(hermes.upgradeCmd, "hermes update");

  assert.equal(data.summary.outdated, 1);
  assert.equal(data.summary.missing, 4);
  assert.equal(data.apiEngines.length, 1);
  assert.equal(data.apiEngines[0].id, "deepseek");
  assert.deepEqual(data.apiEngines[0].latestModels, ["deepseek-v4-pro", "deepseek-chat"]);
});
