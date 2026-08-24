import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyTabAiPrefsToMetadata,
  mergeAiPrefsUpdate,
  normalizeAiPrefs,
  resolveEngineAiPrefs,
} from "../services/devbench/ai-engine-prefs.js";

test("normalizeAiPrefs 忽略空项并规范化引擎名", () => {
  assert.deepEqual(normalizeAiPrefs({
    Codex: { model: " gpt-5.4 ", tier: " high " },
    claude: { model: "", tier: "" },
    junk: null,
  }), {
    codex: { model: "gpt-5.4", tier: "high" },
  });
});

test("mergeAiPrefsUpdate 支持设置与清空模型/档位", () => {
  let prefs = mergeAiPrefsUpdate({}, "codex", { model: "gpt-5.4", tier: "xhigh" });
  assert.deepEqual(prefs, { codex: { model: "gpt-5.4", tier: "xhigh" } });
  prefs = mergeAiPrefsUpdate(prefs, "codex", { model: "" });
  assert.deepEqual(prefs, { codex: { tier: "xhigh" } });
  prefs = mergeAiPrefsUpdate(prefs, "codex", { tier: "" });
  assert.deepEqual(prefs, {});
});

test("resolveEngineAiPrefs 优先故事点覆盖，否则回退元数据", () => {
  const tab = { aiPrefs: { codex: { model: "gpt-story", tier: "max" } } };
  const resolved = resolveEngineAiPrefs(tab, "codex", { model: "gpt-global", tier: "high", source: "用户配置" });
  assert.equal(resolved.model, "gpt-story");
  assert.equal(resolved.tier, "max");
  assert.equal(resolved.overridden, true);
  assert.equal(resolved.source, "故事点配置");
  assert.ok(resolved.catalog.models.includes("gpt-5.4"));
  assert.ok(resolved.catalog.tiers.includes("xhigh"));
});

test("applyTabAiPrefsToMetadata 把覆盖与 catalog 写进展示字段", () => {
  const meta = applyTabAiPrefsToMetadata({
    codex: { name: "Codex", model: "gpt-user", tier: "medium", source: "用户配置" },
  }, { aiPrefs: { codex: { tier: "max" } } });
  assert.equal(meta.codex.model, "gpt-user");
  assert.equal(meta.codex.tier, "max");
  assert.equal(meta.codex.overridden, true);
  assert.equal(meta.codex.source, "故事点配置");
  assert.ok(Array.isArray(meta.codex.catalog.tiers));
});
