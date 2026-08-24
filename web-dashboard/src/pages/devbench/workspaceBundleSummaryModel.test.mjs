import assert from "node:assert/strict";
import test from "node:test";

import { workspaceBundleSummary } from "./workspaceBundleSummaryModel.mjs";

test("Bundle 状态把 detached 依赖显示为来源分支和只读依赖", () => {
  const summary = workspaceBundleSummary({
    workspaceId: "CARB-13998-a13f",
    root: "D:\\ai-ws\\CARB-13998-a13f",
    bundle: { enabled: true, buildEntryRepositoryId: "app-market" },
    preflight: { status: "PASS", logicalBranch: "v202605_ui", buildValidation: { status: "PASS", task: "projects" } },
    entries: [
      { repositoryId: "app-market", name: "应用市场", checkoutDirName: "AppMarket", mode: "EDITABLE", branch: "story/CARB-13998", baseRevision: "a13c21e999" },
      { repositoryId: "app-market-web", name: "WebApp", checkoutDirName: "AppMarketWeb", mode: "READ_ONLY", detached: true, logicalBranch: "v202605_ui", branch: "", baseRevision: "73be901999" },
    ],
  });
  assert.equal(summary.status, "PASS");
  assert.deepEqual(summary.buildValidation, { status: "PASS", task: "projects" });
  assert.deepEqual(summary.members[1], {
    repositoryId: "app-market-web",
    name: "WebApp",
    directoryName: "AppMarketWeb",
    branchLabel: "来源分支",
    branch: "v202605_ui",
    commit: "73be9019",
    mode: "只读依赖",
    readOnly: true,
  });
});
