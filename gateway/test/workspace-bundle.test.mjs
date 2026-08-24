import test from "node:test";
import assert from "node:assert/strict";
import {
  WORKSPACE_BUNDLE_EDITABLE,
  WORKSPACE_BUNDLE_FEATURE_FLAG,
  WORKSPACE_BUNDLE_READ_ONLY,
  buildStoryWorkspaceDirectoryName,
  expandWorkspaceBundleRemoteEntries,
  validateWorkspaceBundle,
  validateWorkspaceCheckoutDirName,
} from "../services/devbench/workspace-bundle.js";

const definitions = [{
  id: "app-market",
  workspaceBundle: {
    enabled: true,
    id: "appmarket-webapp-bundle",
    buildEntryRepositoryId: "app-market",
    layoutPolicy: "SAME_PARENT_SIBLINGS",
    branchPolicy: { type: "SAME_LOGICAL_BRANCH", strict: true },
    members: [
      { repositoryId: "app-market", checkoutDirName: "AppMarket", mode: WORKSPACE_BUNDLE_EDITABLE },
      { repositoryId: "app-market-web", checkoutDirName: "AppMarketWeb", mode: WORKSPACE_BUNDLE_READ_ONLY },
    ],
  },
}, { id: "app-market-web" }];

test("Bundle 配置要求固定、跨平台安全且大小写不冲突的兄弟目录名", () => {
  assert.equal(validateWorkspaceCheckoutDirName("AppMarketWeb").ok, true);
  assert.equal(validateWorkspaceCheckoutDirName("../AppMarketWeb").ok, false);
  assert.equal(validateWorkspaceCheckoutDirName("CON").ok, false);
  const duplicate = validateWorkspaceBundle({
    ...definitions[0].workspaceBundle,
    members: [
      { repositoryId: "app-market", checkoutDirName: "AppMarket" },
      { repositoryId: "app-market-web", checkoutDirName: "appmarket" },
    ],
  }, { definitionId: "app-market", knownRepositoryIds: definitions.map((item) => item.id) });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.code, "WORKSPACE_BUNDLE_DIR_DUPLICATE");
});

test("故事点 Bundle 父目录只含稳定工单标识与故事点短指纹", () => {
  const name = buildStoryWorkspaceDirectoryName({ storyId: "tab/with:unsafe-title", ticketId: "CARB-13998" });
  assert.match(name, /^CARB-13998-[a-f0-9]{8}$/);
  assert.equal(name.includes("unsafe"), false);
});

test("远程源码计划自动补齐必需只读依赖并冻结相同逻辑分支", () => {
  const result = expandWorkspaceBundleRemoteEntries([{
    repositoryId: "app-market",
    branch: "v202605_ui",
    targetRole: "primary",
  }], definitions);
  assert.equal(result.bundle.id, "appmarket-webapp-bundle");
  assert.equal(result.bundle.featureFlag, WORKSPACE_BUNDLE_FEATURE_FLAG);
  assert.deepEqual(result.entries.map((entry) => entry.repositoryId), ["app-market", "app-market-web"]);
  assert.equal(result.entries[1].branch, "v202605_ui");
  assert.equal(result.entries[1].targetRole, "webapp");
  assert.equal(result.entries[1].workspaceBundleMember.checkoutDirName, "AppMarketWeb");
});

test("严格 Bundle 在成员分支不一致时于源码创建前失败关闭", () => {
  assert.throws(() => expandWorkspaceBundleRemoteEntries([
    { repositoryId: "app-market", branch: "v202605_ui", targetRole: "primary" },
    { repositoryId: "app-market-web", branch: "develop", targetRole: "webapp" },
  ], definitions), (error) => error.code === "WORKSPACE_BUNDLE_BRANCH_MISMATCH");
});

test("Bundle 不允许关闭严格分支或重复引用同一仓库", () => {
  const nonStrict = validateWorkspaceBundle({
    ...definitions[0].workspaceBundle,
    strictBranch: false,
    branchPolicy: { type: "SAME_LOGICAL_BRANCH", strict: false },
  }, { definitionId: "app-market", knownRepositoryIds: definitions.map((item) => item.id) });
  assert.equal(nonStrict.code, "WORKSPACE_BUNDLE_STRICT_BRANCH_REQUIRED");
  const duplicateRepository = validateWorkspaceBundle({
    ...definitions[0].workspaceBundle,
    members: [
      { repositoryId: "app-market", checkoutDirName: "AppMarket", mode: "EDITABLE" },
      { repositoryId: "app-market", checkoutDirName: "AppMarketCopy", mode: "READ_ONLY" },
    ],
  }, { definitionId: "app-market", knownRepositoryIds: definitions.map((item) => item.id) });
  assert.equal(duplicateRepository.code, "WORKSPACE_BUNDLE_REPOSITORY_DUPLICATE");
});
