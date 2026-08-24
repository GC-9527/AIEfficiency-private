import test from "node:test";
import assert from "node:assert/strict";
import {
  buildWorktreeRebuildPreview,
  worktreeNamingSignature,
  workspaceBundleTopologySignature,
} from "../services/devbench/worktree-rebuild.js";

test("naming signature ignores Flavor because Flavor no longer changes worktree identity", () => {
  assert.equal(
    worktreeNamingSignature({ flavors: ["Avatr8678", "x"], ticketId: "carb-1" }),
    worktreeNamingSignature({ flavors: ["x", "avatr8678"], ticketId: "CARB-1" }),
  );
});

test("Bundle topology signature ignores runtime paths but preserves fixed siblings and member modes", () => {
  const declaration = {
    enabled: true,
    id: "market-web",
    buildEntryRepositoryId: "appMarket",
    layoutPolicy: "SAME_PARENT_SIBLINGS",
    branchPolicy: "SAME_LOGICAL_BRANCH",
    strictBranch: true,
    members: [
      { repositoryId: "appMarket", checkoutDirName: "AppMarket", mode: "EDITABLE" },
      { repositoryId: "webApp", checkoutDirName: "AppMarketWeb", mode: "READ_ONLY" },
    ],
  };
  assert.equal(
    workspaceBundleTopologySignature({ ...declaration, root: "D:/one", buildEntryPath: "D:/one/AppMarket" }),
    workspaceBundleTopologySignature({ ...declaration, root: "E:/two", buildEntryPath: "E:/two/AppMarket" }),
  );
  assert.equal(
    workspaceBundleTopologySignature(declaration),
    workspaceBundleTopologySignature({
      ...declaration,
      members: [
        ...declaration.members,
        {
          repositoryId: "associated-tools",
          checkoutDirName: "AssociatedTools",
          mode: "EDITABLE",
          association: true,
        },
      ],
    }),
  );
  assert.notEqual(
    workspaceBundleTopologySignature(declaration),
    workspaceBundleTopologySignature({
      ...declaration,
      members: declaration.members.map((member) => (
        member.repositoryId === "webApp" ? { ...member, mode: "EDITABLE" } : member
      )),
    }),
  );
});

test("buildWorktreeRebuildPreview：仅切换 Flavor 不删除或重建 worktree", () => {
  const createdAt = new Date(2026, 6, 24, 17, 11).getTime();
  const preview = buildWorktreeRebuildPreview({
    tab: {
      id: "t1",
      primaryProjectId: "p1",
      createdAt,
      worktree: {
        managed: true,
        entries: [{
          role: "primary",
          name: "App",
          path: process.cwd(), // exists
          worktreePath: process.cwd(),
          basePath: process.cwd(),
          branch: "story/v202605_UI_07241711",
          originalBranch: "v202605/UI",
        }],
      },
    },
    nextSnapshot: {
      primaryProjectId: "p1",
      flavors: [{ path: process.cwd(), flavor: "Avatr8678" }],
      worktreeNaming: { ticketId: "CARB-1234" },
    },
    currentNaming: { flavors: [], ticketId: "CARB-1234", createdAt },
    nextNaming: { flavors: ["Avatr8678"], ticketId: "CARB-1234", createdAt },
    nextOriginalBranch: "v202605/UI",
  });
  assert.equal(preview.needed, false);
  assert.deepEqual(preview.reasons, []);
  assert.deepEqual(preview.deleteEntries, []);
});

test("buildWorktreeRebuildPreview：Bundle 拓扑或成员模式变化必须进入安全重建确认", () => {
  const preview = buildWorktreeRebuildPreview({
    tab: {
      id: "legacy-bundle",
      primaryProjectId: "market",
      createdAt: Date.now(),
      worktree: {
        managed: true,
        entries: [{
          role: "primary",
          name: "AppMarket",
          path: process.cwd(),
          worktreePath: process.cwd(),
          basePath: process.cwd(),
          branch: "story/CARB_15190",
          originalBranch: "release/geely-e22",
        }],
      },
    },
    nextSnapshot: { primaryProjectId: "market", flavors: [] },
    currentNaming: { ticketId: "CARB-15190" },
    nextNaming: { ticketId: "CARB-15190" },
    nextOriginalBranch: "release/geely-e22",
    workspaceTopologyChanged: true,
  });
  assert.equal(preview.needed, true);
  assert.equal(preview.workspaceTopologyChanged, true);
  assert.ok(preview.reasons.some((reason) => reason.code === "workspace_bundle_changed"));
  assert.equal(preview.deleteEntries.length, 1);
});

test("buildWorktreeRebuildPreview：TB 单号变化时给出删除列表与预估分支名", () => {
  const createdAt = new Date(2026, 6, 24, 17, 11).getTime();
  const preview = buildWorktreeRebuildPreview({
    tab: {
      id: "t-ticket",
      primaryProjectId: "p1",
      createdAt,
      worktree: {
        managed: true,
        entries: [{
          role: "primary",
          name: "App",
          path: process.cwd(),
          worktreePath: process.cwd(),
          basePath: process.cwd(),
          branch: "story/v202605_UI_CARB_1000",
          originalBranch: "v202605/UI",
        }],
      },
    },
    nextSnapshot: { primaryProjectId: "p1", worktreeNaming: { ticketId: "CARB-1234" } },
    currentNaming: { ticketId: "CARB-1000", createdAt },
    nextNaming: { ticketId: "CARB-1234", createdAt },
    nextOriginalBranch: "v202605/UI",
  });
  assert.equal(preview.needed, true);
  assert.ok(preview.reasons.some((reason) => reason.code === "naming_changed"));
  assert.equal(preview.deleteEntries.length, 1);
  assert.equal(preview.expectedDirectoryName, "v202605_UI_CARB_1234");
  assert.equal(preview.expectedBranchName, "story/v202605_UI_CARB_1234");
});

test("buildWorktreeRebuildPreview：主工程变更时需要删除旧 worktree", () => {
  const createdAt = Date.now();
  const preview = buildWorktreeRebuildPreview({
    tab: {
      id: "t2",
      primaryProjectId: "old",
      createdAt,
      worktree: {
        managed: true,
        entries: [{
          role: "primary",
          name: "Old",
          path: process.cwd(),
          worktreePath: process.cwd(),
          basePath: process.cwd(),
          branch: "story/x",
          originalBranch: "main",
        }],
      },
    },
    nextSnapshot: { primaryProjectId: "new" },
    currentNaming: { flavors: ["A"], ticketId: "", createdAt },
    nextNaming: { flavors: ["A"], ticketId: "", createdAt },
    nextOriginalBranch: "main",
  });
  assert.equal(preview.needed, true);
  assert.ok(preview.reasons.some((reason) => reason.code === "primary_changed"));
});
