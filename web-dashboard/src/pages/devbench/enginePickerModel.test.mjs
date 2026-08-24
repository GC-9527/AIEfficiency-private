import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  BASE_DEVBENCH_ENGINES,
  buildEnginePickerGroups,
  compactEngineProductName,
  engineGroupId,
} from "./enginePickerModel.mjs";

test("故事点 AI 选择器按 CLI 分组并在组内展示具体 AI 产品", () => {
  const groups = buildEnginePickerGroups(BASE_DEVBENCH_ENGINES, "claude-atlas");

  assert.deepEqual(groups.map((group) => group.name), [
    "Claude Code",
    "Codex CLI",
    "Gemini CLI",
    "Hermes",
  ]);
  assert.deepEqual(
    groups.find((group) => group.id === "claude-code")?.options.map((option) => option.productName),
    ["Anthropic 官方", "火山方舟", "MiniMax", "Atlas Coding Plan"],
  );
  assert.deepEqual(
    groups.find((group) => group.id === "codex-cli")?.options.map((option) => option.productName),
    ["OpenAI 官方", "MiniMax", "Atlas Coding Plan"],
  );
  assert.equal(groups.find((group) => group.id === "claude-code")?.selectedProductName, "Atlas Coding Plan");
  assert.equal(engineGroupId("codex-minimax"), "codex-cli");
});

test("动态 API 引擎保留在 API 直连分组且不会污染 CLI 分组", () => {
  const dynamic = { id: "company-gateway", name: "公司模型网关", short: "CG", api: true };
  const groups = buildEnginePickerGroups([...BASE_DEVBENCH_ENGINES, dynamic], dynamic.id);
  const apiGroup = groups.find((group) => group.id === "api-direct");

  assert.ok(apiGroup);
  assert.equal(apiGroup.selected, true);
  assert.deepEqual(apiGroup.options.map((option) => option.productName), ["公司模型网关"]);
  assert.equal(groups.find((group) => group.id === "claude-code")?.options.some((option) => option.id === dynamic.id), false);
});

test("底部按钮把产品名称压缩为稳定短名", () => {
  assert.equal(compactEngineProductName("claude-atlas"), "Atlas");
  assert.equal(compactEngineProductName("codex-minimax"), "MiniMax");
  assert.equal(compactEngineProductName("claude"), "Claude");
  assert.equal(compactEngineProductName("codex"), "Codex");
  assert.equal(compactEngineProductName({ id: "atlas", name: "Atlas Coding Plan", api: true }), "Atlas");
  assert.equal(compactEngineProductName({ id: "company-gateway", name: "公司模型网关", api: true }), "公司模型网关");
});

test("StoryTab 使用可访问的 CLI accordion，而不是继续平铺所有引擎", () => {
  const source = fs.readFileSync(new URL("./StoryTab.jsx", import.meta.url), "utf8");

  assert.match(source, /buildEnginePickerGroups\(engineOptions, cur\)/);
  assert.match(source, /devbench-ai-cli-group-\$\{group\.id\}/);
  assert.match(source, /aria-expanded=\{expanded\}/);
  assert.match(source, /devbench-ai-product-\$\{e\.id\}/);
  assert.match(source, /role="dialog"/);
  assert.match(source, /event\.key !== "Escape"/);
  assert.match(source, /triggerRef\.current\?\.focus\(\)/);
  assert.doesNotMatch(source, /\{engineOptions\.map\(\(e\) => \{/);
});

test("故事点底部 AI 按钮只显示有宽度上限的主要产品短名", () => {
  const source = fs.readFileSync(new URL("./StoryTab.jsx", import.meta.url), "utf8");
  const pillStart = source.indexOf("{isPill ? (");
  const pillEnd = source.indexOf(") : curMeta.short}", pillStart);
  const pillMarkup = source.slice(pillStart, pillEnd);

  assert.ok(pillStart > 0 && pillEnd > pillStart);
  assert.match(pillMarkup, /data-testid="devbench-current-ai-product"/);
  assert.match(pillMarkup, /max-w-\[80px\]/);
  assert.doesNotMatch(pillMarkup, /curGroup\?\.name/);
  assert.doesNotMatch(pillMarkup, /curModelTier\.model/);
  assert.doesNotMatch(pillMarkup, /curModelTier\.tier/);
  assert.match(source, /flex flex-wrap items-end gap-2[^>]+data-testid="devbench-story-composer-row"/);
  assert.match(source, /min-w-\[min\(12rem,100%\)\][^>]+data-testid="devbench-story-composer-input"/);
});
