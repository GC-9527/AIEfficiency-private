import assert from "node:assert/strict";
import test from "node:test";

import {
  WORKSPACE_BUNDLE_EDITABLE,
  emptyWorkspaceBundle,
  workspaceBundleDraftError,
  workspaceBundlePayload,
} from "./workspaceBundleModel.mjs";

const definitions = [{ id: "app-market" }, { id: "app-market-web" }];

test("Bundle 编辑模型固定构建入口、布局和严格相同逻辑分支", () => {
  const draft = emptyWorkspaceBundle("app-market");
  draft.members[0].checkoutDirName = "AppMarket";
  draft.members.push({ repositoryId: "app-market-web", checkoutDirName: "AppMarketWeb", required: true, mode: "READ_ONLY" });
  assert.equal(workspaceBundleDraftError(draft, definitions, "app-market"), "");
  assert.deepEqual(workspaceBundlePayload(draft, "app-market"), {
    ...draft,
    layoutPolicy: "SAME_PARENT_SIBLINGS",
    branchPolicy: "SAME_LOGICAL_BRANCH",
    strictBranch: true,
  });
  assert.equal(draft.members[0].mode, WORKSPACE_BUNDLE_EDITABLE);
});

test("Bundle 编辑模型在成员或固定目录名重复时阻止保存", () => {
  const draft = emptyWorkspaceBundle("app-market");
  draft.members[0].checkoutDirName = "AppMarket";
  draft.members.push({ repositoryId: "app-market", checkoutDirName: "AppMarketWeb", required: true, mode: "READ_ONLY" });
  assert.match(workspaceBundleDraftError(draft, definitions, "app-market"), /成员仓库重复/);
  draft.members[1].repositoryId = "app-market-web";
  draft.members[1].checkoutDirName = "appmarket";
  assert.match(workspaceBundleDraftError(draft, definitions, "app-market"), /固定目录名重复/);
});
