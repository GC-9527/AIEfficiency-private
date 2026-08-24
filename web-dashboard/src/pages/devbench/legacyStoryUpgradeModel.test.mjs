import test from "node:test";
import assert from "node:assert/strict";
import {
  formatMigrationBytes,
  hasCompleteStoryRepositoryGrant,
  legacyUpgradeActionState,
  legacyUpgradeBlockerGuidance,
  legacyUpgradeSummary,
  needsLegacyStoryUpgrade,
} from "./legacyStoryUpgradeModel.mjs";

const completeEntry = {
  role: "primary",
  repositoryMode: "INDEPENDENT_REPOSITORY",
  repositoryId: "repo",
  workerIdentity: "sid:S-1-5-21-1",
  storyAclFingerprint: "a".repeat(64),
  baseRevision: "b".repeat(40),
  headRevision: "c".repeat(40),
};

test("旧故事点缺少独立仓证明时需要升级", () => {
  assert.equal(needsLegacyStoryUpgrade({
    mode: "local",
    primaryProjectId: "project",
    worktree: {
      repositoryMode: "LEGACY_LINKED_WORKTREE",
      entries: [{ role: "primary", path: "D:/legacy" }],
    },
  }), true);
});

test("完整独立仓忽略仅用于留档的 inactive 旧条目", () => {
  const tab = {
    mode: "local",
    primaryProjectId: "project",
    worktree: {
      repositoryMode: "INDEPENDENT_REPOSITORY",
      entries: [
        completeEntry,
        { role: "inactive", active: false, repositoryMode: "LEGACY_LINKED_WORKTREE" },
      ],
    },
  };
  assert.equal(hasCompleteStoryRepositoryGrant(tab), true);
  assert.equal(needsLegacyStoryUpgrade(tab), false);
});

test("远程故事点不进入本地升级向导", () => {
  assert.equal(needsLegacyStoryUpgrade({
    mode: "remote",
    primaryProjectId: "project",
  }), false);
});

test("已有独立仓但缺少 ACL 指纹时仍进入证明刷新向导", () => {
  assert.equal(needsLegacyStoryUpgrade({
    mode: "local",
    primaryProjectId: "project",
    worktree: {
      repositoryMode: "INDEPENDENT_REPOSITORY",
      entries: [{
        ...completeEntry,
        storyAclFingerprint: "",
      }],
    },
  }), true);
});

test("升级摘要和容量文案保持稳定", () => {
  assert.deepEqual(legacyUpgradeSummary({
    canUpgrade: true,
    blockers: [],
    summary: {
      projectCount: 2,
      snapshotCount: 1,
      changedFileCount: 3,
      untrackedCount: 4,
    },
  }), {
    projectCount: 2,
    snapshotCount: 1,
    changedFileCount: 3,
    untrackedCount: 4,
    blocked: false,
    blockerCount: 0,
  });
  assert.equal(formatMigrationBytes(1536), "1.5 KB");
  assert.equal(formatMigrationBytes(5 * 1024 * 1024), "5.0 MB");
});

test("Controller 未部署时主按钮仍可点击查看准确的前置条件", () => {
  const preview = {
    canUpgrade: false,
    previewToken: "1".repeat(64),
    projects: [],
    blockers: [
      {
        code: "GIT_CONTROLLER_CLIENT_CONFIG_REQUIRED",
        message: "Git Controller 不可用",
      },
      {
        code: "STORY_REPOSITORY_WORKER_IDENTITY_MISSING",
        message: "当前故事点尚未配置受限 Worker 身份",
      },
      {
        code: "STORY_REPOSITORY_DEFINITION_REQUIRED",
        message: "没有找到可升级的工程定义",
      },
    ],
  };
  assert.deepEqual(legacyUpgradeActionState(preview), {
    mode: "explain",
    disabled: false,
    ready: false,
    label: "查看升级前置条件",
  });
  assert.deepEqual(
    legacyUpgradeBlockerGuidance(preview).map((item) => item.key),
    ["controller", "worker"],
  );
});

test("只有有效预览令牌和通过状态才进入真正升级动作", () => {
  const state = legacyUpgradeActionState({
    canUpgrade: true,
    previewToken: "a".repeat(64),
    blockers: [],
  });
  assert.deepEqual(state, {
    mode: "upgrade",
    disabled: false,
    ready: true,
    label: "开始安全升级",
  });
  assert.equal(legacyUpgradeActionState(null).disabled, true);
});
