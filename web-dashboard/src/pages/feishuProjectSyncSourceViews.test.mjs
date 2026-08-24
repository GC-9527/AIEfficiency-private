import assert from "node:assert/strict";
import test from "node:test";
import {
  addFeishuSourceView,
  applySourceViewsToConfig,
  canonicalSourceViewKey,
  defaultFeishuSourceView,
  normalizeFeishuSourceViewsForUi,
  parseFeishuSourceViewUrl,
  removeFeishuSourceView,
  setDefaultFeishuSourceView,
  sourceViewControlAriaLabels,
  sourceViewValidationIssues,
  sourceViewsForRequest,
  sourceViewsSummary,
  toggleFeishuSourceView,
  updateFeishuSourceView,
  validateFeishuSourceViewUrl,
} from "./feishuProjectSyncSourceViews.js";

const originalUrl = "https://project.feishu.cn/intelligentspace/workObjectView/bug/2OuLlBcDg?scope=workspaces&node=28602134";
const doubleEightUrl = "https://project.feishu.cn/intelligentspace/workObjectView/bug_double_eight/6VIRXf5vg";

test("可解析带查询参数和不带查询参数的飞书 workObjectView URL", () => {
  assert.deepEqual(parseFeishuSourceViewUrl(originalUrl), {
    sourceProjectKey: "intelligentspace",
    sourceWorkItemTypeKey: "bug",
    viewId: "2OuLlBcDg",
    scope: "workspaces",
    node: "28602134",
    hostname: "project.feishu.cn",
    normalizedUrl: originalUrl,
  });
  const parsed = parseFeishuSourceViewUrl(doubleEightUrl);
  assert.equal(parsed.sourceProjectKey, "intelligentspace");
  assert.equal(parsed.sourceWorkItemTypeKey, "bug_double_eight");
  assert.equal(parsed.viewId, "6VIRXf5vg");
  assert.equal(parsed.scope, "");
  assert.equal(parsed.node, "");
  assert.equal(validateFeishuSourceViewUrl(doubleEightUrl).ok, true);
});

test("非法协议、域名和非列表路径会返回可读校验提示", () => {
  assert.match(validateFeishuSourceViewUrl("").error, /请输入/);
  assert.match(validateFeishuSourceViewUrl("not-a-url").error, /格式/);
  assert.match(validateFeishuSourceViewUrl(originalUrl.replace("https:", "http:")).error, /https/);
  assert.match(validateFeishuSourceViewUrl("https://example.com/intelligentspace/workObjectView/bug/x").error, /project\.feishu\.cn/);
  assert.match(validateFeishuSourceViewUrl("https://user:secret@project.feishu.cn/intelligentspace/workObjectView/bug/x").error, /账号或密码/);
  assert.match(validateFeishuSourceViewUrl("https://project.feishu.cn/intelligentspace/bug/detail/123").error, /workObjectView/);
});

test("旧版单 sourceView 会迁移为唯一启用且默认的来源", () => {
  const sources = normalizeFeishuSourceViewsForUi({
    feishu: {
      sourceView: {
        url: originalUrl,
        viewId: "2OuLlBcDg",
        scope: "workspaces",
        node: "28602134",
      },
    },
  });
  assert.equal(sources.length, 1);
  assert.equal(sources[0].enabled, true);
  assert.equal(sources[0].isDefault, true);
  assert.equal(sources[0].sourceWorkItemTypeKey, "bug");
  assert.equal(sourceViewValidationIssues(sources).length, 0);
});

test("新增来源会解析 bug_double_eight 并阻止规范化重复项", () => {
  const original = normalizeFeishuSourceViewsForUi({ feishu: { sourceView: { url: originalUrl } } });
  const added = addFeishuSourceView(original, { name: "Double Eight", url: doubleEightUrl });
  assert.equal(added.error, "");
  assert.equal(added.sources.length, 2);
  assert.equal(added.added.sourceWorkItemTypeKey, "bug_double_eight");
  assert.equal(added.added.viewId, "6VIRXf5vg");

  const reorderedQuery = "https://project.feishu.cn/intelligentspace/workObjectView/bug/2OuLlBcDg?node=28602134&scope=workspaces";
  assert.equal(canonicalSourceViewKey(reorderedQuery), canonicalSourceViewKey(originalUrl));
  const duplicate = addFeishuSourceView(added.sources, { url: reorderedQuery });
  assert.match(duplicate.error, /已存在/);
  assert.equal(duplicate.duplicateId, original[0].id);
  assert.equal(duplicate.sources.length, 2);
});

test("名称和 URL 可更新，重复或非法行会产生逐项问题", () => {
  const retargetable = normalizeFeishuSourceViewsForUi({ feishu: { sourceView: { url: originalUrl } } });
  const retargeted = updateFeishuSourceView(retargetable, retargetable[0].id, { url: doubleEightUrl });
  assert.equal(retargeted[0].viewId, "6VIRXf5vg");
  assert.equal(retargeted[0].sourceWorkItemTypeKey, "bug_double_eight");
  assert.equal(retargeted[0].name, "bug_double_eight · 6VIRXf5vg");
  assert.equal(retargeted[0].id, retargetable[0].id);

  const added = addFeishuSourceView(
    normalizeFeishuSourceViewsForUi({ feishu: { sourceView: { url: originalUrl } } }),
    { name: "Double Eight", url: doubleEightUrl },
  );
  const secondId = added.added.id;
  const renamed = updateFeishuSourceView(added.sources, secondId, { name: "双八缺陷" });
  assert.equal(renamed.find((view) => view.id === secondId).name, "双八缺陷");

  const invalid = updateFeishuSourceView(renamed, secondId, { url: "https://example.com/not-feishu" });
  assert.equal(sourceViewValidationIssues(invalid).find((issue) => issue.message?.includes("project.feishu.cn") || issue.code === "invalid-url")?.code, "invalid-url");

  const renamedAgain = updateFeishuSourceView(added.sources, secondId, { name: "双八缺陷" });
  const duplicate = updateFeishuSourceView(renamedAgain, secondId, { url: originalUrl });
  assert.equal(sourceViewValidationIssues(duplicate).find((issue) => issue.code === "duplicate")?.code, "duplicate");
});

test("保存配置时会折叠重复飞书视图，避免添加后变成两条相同来源", () => {
  const original = normalizeFeishuSourceViewsForUi({ feishu: { sourceView: { url: originalUrl } } });
  const added = addFeishuSourceView(original, { name: "Double Eight", url: doubleEightUrl }).sources;
  const duplicated = updateFeishuSourceView(added, added[0].id, { url: doubleEightUrl });
  assert.equal(duplicated.length, 2);
  assert.equal(sourceViewValidationIssues(duplicated).some((issue) => issue.code === "duplicate"), true);

  const saved = applySourceViewsToConfig({ feishu: { sourceView: { url: originalUrl } } }, duplicated);
  assert.equal(saved.feishu.sourceViews.length, 1);
  assert.equal(saved.feishu.sourceViews[0].url, doubleEightUrl);
  assert.equal(saved.feishu.workItemTypeKey, "bug_double_eight");
  assert.equal(sourceViewValidationIssues(saved).length, 0);
});

test("重复显式来源 ID 会稳定重建为唯一 ID，单卡操作不会影响其他来源", () => {
  const input = [
    { id: "shared-source", name: "缺陷来源", url: originalUrl, enabled: true, isDefault: true },
    { id: "shared-source", name: "双八来源", url: doubleEightUrl, enabled: true },
  ];
  const sources = normalizeFeishuSourceViewsForUi(input);
  const ids = sources.map((view) => view.id);

  assert.equal(new Set(ids).size, 2);
  assert.notEqual(ids[0], ids[1]);
  assert.deepEqual(normalizeFeishuSourceViewsForUi(sources).map((view) => view.id), ids);
  assert.equal(new Set(sourceViewsForRequest(sources).map((view) => view.id)).size, 2);

  const renamed = updateFeishuSourceView(sources, ids[1], { name: "仅修改双八来源" });
  assert.equal(renamed[0].name, "缺陷来源");
  assert.equal(renamed[1].name, "仅修改双八来源");

  const disabled = toggleFeishuSourceView(renamed, ids[1], false);
  assert.equal(disabled.error, "");
  assert.equal(disabled.sources[0].enabled, true);
  assert.equal(disabled.sources[1].enabled, false);

  const selected = setDefaultFeishuSourceView(disabled.sources, ids[1]);
  assert.equal(selected[0].isDefault, false);
  assert.equal(selected[1].isDefault, true);
  const removed = removeFeishuSourceView(selected, ids[1]);
  assert.equal(removed.error, "");
  assert.deepEqual(removed.sources.map((view) => view.id), [ids[0]]);
});

test("来源操作的可访问名称包含对应来源名称", () => {
  const labels = sourceViewControlAriaLabels({ name: "双八来源", isDefault: false }, 1);
  assert.equal(Object.values(labels).every((label) => label.includes("双八来源")), true);
  assert.match(labels.toggle, /启用状态/);
  assert.match(labels.setDefault, /设为默认来源/);
  assert.match(labels.remove, /删除/);
  assert.match(labels.confirmRemove, /确认删除/);
  assert.match(labels.cancelRemove, /取消删除/);
});

test("默认项唯一，禁用或删除默认项时提升下一个已启用来源", () => {
  const first = normalizeFeishuSourceViewsForUi({ feishu: { sourceView: { url: originalUrl } } });
  const added = addFeishuSourceView(first, { name: "Double Eight", url: doubleEightUrl }).sources;
  const secondId = added[1].id;
  const selected = setDefaultFeishuSourceView(added, secondId);
  assert.equal(defaultFeishuSourceView(selected).id, secondId);
  assert.equal(selected.filter((view) => view.isDefault).length, 1);

  const disabled = toggleFeishuSourceView(selected, secondId, false);
  assert.equal(disabled.error, "");
  assert.equal(defaultFeishuSourceView(disabled.sources).id, added[0].id);

  const selectedAgain = setDefaultFeishuSourceView(disabled.sources, secondId);
  const removed = removeFeishuSourceView(selectedAgain, secondId);
  assert.equal(removed.error, "");
  assert.equal(defaultFeishuSourceView(removed.sources).id, added[0].id);
});

test("不允许禁用、删除最后一个已启用来源", () => {
  const first = normalizeFeishuSourceViewsForUi({ feishu: { sourceView: { url: originalUrl } } });
  assert.match(toggleFeishuSourceView(first, first[0].id, false).error, /至少/);
  assert.match(removeFeishuSourceView(first, first[0].id).error, /至少/);

  const added = addFeishuSourceView(first, { url: doubleEightUrl }).sources;
  const disabledSecond = toggleFeishuSourceView(added, added[1].id, false).sources;
  assert.match(removeFeishuSourceView(disabledSecond, disabledSecond[0].id).error, /先启用其他来源/);
});

test("写入 sourceViews 时同步镜像默认来源到旧字段和网页登录字段", () => {
  const original = normalizeFeishuSourceViewsForUi({ feishu: { sourceView: { url: originalUrl } } });
  const added = addFeishuSourceView(original, { name: "Double Eight", url: doubleEightUrl }).sources;
  const selected = setDefaultFeishuSourceView(added, added[1].id);
  const config = applySourceViewsToConfig({
    enabled: true,
    feishu: {
      sourceView: { url: originalUrl },
      web: { homepageUrl: originalUrl, profileDir: "keep-me" },
      spaceKey: "old-space",
      workItemTypeKey: "bug",
    },
  }, selected);

  assert.equal(config.feishu.sourceViews.length, 2);
  assert.equal(config.feishu.sourceView.url, doubleEightUrl);
  assert.equal(config.feishu.sourceView.viewId, "6VIRXf5vg");
  assert.equal(config.feishu.web.homepageUrl, doubleEightUrl);
  assert.equal(config.feishu.web.profileDir, "keep-me");
  assert.equal(config.feishu.spaceKey, "intelligentspace");
  assert.equal(config.feishu.workItemTypeKey, "bug_double_eight");
  assert.equal(sourceViewsSummary(config), "已启用 2/2 · 默认：Double Eight");
  assert.deepEqual(sourceViewsForRequest(config).map((view) => view.viewId), ["2OuLlBcDg", "6VIRXf5vg"]);
});
