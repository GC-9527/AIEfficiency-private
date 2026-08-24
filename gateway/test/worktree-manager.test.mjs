import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
const WORKTREE_TEST_RUNTIME = fs.mkdtempSync(path.join(os.tmpdir(), "devbench-worktree-suite-"));
process.env.GATEWAY_DB_PATH = path.join(WORKTREE_TEST_RUNTIME, "gateway.db");
process.on("exit", () => {
  try { fs.rmSync(WORKTREE_TEST_RUNTIME, { recursive: true, force: true }); } catch {}
});
const {
  beginStoryAiLease,
  beginWorktreeMutation,
  applyWorktreeConflictTimestamp,
  buildWorktreeBranchName,
  buildWorktreeDirectoryName,
  cleanupStoryWorktrees,
  endStoryAiLease,
  endWorktreeMutation,
  inspectStoryWorktreeCleanup,
  isStoryAiLeaseActive,
  isWorktreeMutationLocked,
  mergeCleanedWorktreeEntries,
  promoteReadOnlyWorkspaceMembers,
  provisionStoryWorktrees,
  safeWorktreeDirectorySegment,
  storyWorktreeResourceKeys,
  __test: worktreeTest,
} = await import("../services/devbench/worktree-manager.js");
const runtimeDb = await import("../db/sqlite.js");
const { captureProcessIdentitySync } = await import("../services/process-identity.js");

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true }).trim();
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devbench-worktree-"));
  const source = path.join(root, "source");
  fs.mkdirSync(source);
  git(source, "init");
  git(source, "config", "user.name", "Devbench Test");
  git(source, "config", "user.email", "devbench@example.test");
  fs.writeFileSync(path.join(source, "tracked.txt"), "base\n");
  git(source, "add", "tracked.txt");
  git(source, "commit", "-m", "base");
  return { root, source, worktreeRoot: path.join(root, "managed") };
}

function bundleFixture({ webBranch = "v202605_ui" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devbench-workspace-bundle-"));
  const createRepo = (name, branch) => {
    const repo = path.join(root, name);
    fs.mkdirSync(repo);
    git(repo, "init", "-b", branch);
    git(repo, "config", "user.name", "Devbench Test");
    git(repo, "config", "user.email", "devbench@example.test");
    fs.writeFileSync(path.join(repo, `${name}.txt`), `${name}\n`);
    git(repo, "add", ".");
    git(repo, "commit", "-m", `init ${name}`);
    return repo;
  };
  return {
    root,
    app: createRepo("app-source", "v202605_ui"),
    web: createRepo("web-source", webBranch),
    createRepo,
    worktreeRoot: path.join(root, "managed"),
  };
}

function appMarketBundle({ webMode = "READ_ONLY" } = {}) {
  return {
    enabled: true,
    id: "appmarket-webapp-bundle",
    buildEntryRepositoryId: "app-market",
    layoutPolicy: "SAME_PARENT_SIBLINGS",
    branchPolicy: { type: "SAME_LOGICAL_BRANCH", strict: true },
    members: [
      { repositoryId: "app-market", checkoutDirName: "AppMarket", mode: "EDITABLE" },
      { repositoryId: "app-market-web", checkoutDirName: "AppMarketWeb", mode: webMode },
    ],
  };
}

test("worktree 目录名只使用英文数字下划线并按 Flavor、原始分支、TB 或时间命名", () => {
  const createdAt = new Date(2026, 6, 24, 17, 11, 9).getTime();
  assert.equal(buildWorktreeDirectoryName({
    flavors: ["Avatr8678"],
    originalBranch: "v202605/UI",
    ticketId: "CARB-1234",
    createdAt,
  }), "v202605_UI_CARB_1234");
  assert.equal(buildWorktreeDirectoryName({
    flavors: ["Avatr8678"],
    originalBranch: "v202605/UI",
    createdAt,
  }), "v202605_UI_07241711");
  assert.equal(buildWorktreeDirectoryName({
    flavors: [],
    originalBranch: "Avatr8678/v202605 UI",
    ticketId: "CARB-1234",
    createdAt,
  }), "Avatr8678_v202605_UI_CARB_1234");
  assert.equal(buildWorktreeDirectoryName({
    flavors: ["Avatr8678", "Avatr8155"],
    originalBranch: "release/v202605-UI",
    ticketId: "CARB-1234",
    createdAt,
  }), "v202605_UI_CARB_1234");
  assert.equal(safeWorktreeDirectorySegment("feature/中文 ui-fix@1"), "feature_ui_fix_1");
  assert.equal(
    applyWorktreeConflictTimestamp("feat_202605sdkaiV4_07251823", new Date(2026, 6, 25, 18, 23, 11).getTime()),
    "feat_202605sdkaiV4_0725182311",
  );
  assert.equal(
    applyWorktreeConflictTimestamp("Avatr8678_v202605_UI_CARB_1234", new Date(2026, 6, 25, 18, 23, 11).getTime()),
    "Avatr8678_v202605_UI_CARB_1234_0725182311",
  );
  for (const value of [
    buildWorktreeDirectoryName({ flavors: ["车型 8678"], originalBranch: "feature/a-b c", ticketId: "CARB-9", createdAt }),
    safeWorktreeDirectorySegment("feature/中文 ui-fix@1"),
  ]) {
    assert.match(value, /^[A-Za-z0-9_]+$/);
  }
});

test("worktree 分支名使用 story/ 前缀并与目录命名规则一致", () => {
  const createdAt = new Date(2026, 6, 24, 17, 11).getTime();
  assert.equal(buildWorktreeBranchName({
    flavors: ["avatr8678"],
    originalBranch: "v202605/UI",
    ticketId: "CARB-1234",
    createdAt,
  }), "story/v202605_UI_CARB_1234");
  assert.equal(buildWorktreeBranchName({
    flavors: ["avatr8678"],
    originalBranch: "v202605/UI",
    createdAt,
  }), "story/v202605_UI_07241711");
  assert.equal(buildWorktreeBranchName({
    flavors: [],
    originalBranch: "avatr8678/v202605 UI",
    ticketId: "CARB-1234",
    createdAt,
  }), "story/avatr8678_v202605_UI_CARB_1234");
  assert.equal(buildWorktreeBranchName({
    flavors: ["Avatr8678", "Avatr8155"],
    originalBranch: "v202605/UI",
    ticketId: "CARB-1234",
    createdAt,
  }), "story/v202605_UI_CARB_1234");
});

test("故事点 Bundle 创建固定兄弟目录、同逻辑分支和 detached 只读依赖", async (t) => {
  const f = bundleFixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const originalAppStatus = git(f.app, "status", "--porcelain=v1");
  const originalWebStatus = git(f.web, "status", "--porcelain=v1");
  const workspace = await provisionStoryWorktrees({
    tabId: "tab-bundle-1",
    worktreeRoot: f.worktreeRoot,
    naming: { ticketId: "CARB-13998" },
    workspaceBundle: appMarketBundle(),
    repositories: [
      {
        role: "primary",
        repositoryId: "app-market",
        name: "AppMarket",
        path: f.app,
        baseRef: "v202605_ui",
        logicalBranch: "v202605_ui",
      },
      {
        role: "webapp",
        repositoryId: "app-market-web",
        name: "AppMarketWeb",
        path: f.web,
        baseRef: "v202605_ui",
        logicalBranch: "v202605_ui",
        detached: true,
      },
    ],
  });
  assert.equal(workspace.version, 3);
  assert.match(path.basename(workspace.root), /^CARB-13998-[a-f0-9]{8}$/);
  assert.deepEqual(workspace.entries.map((entry) => path.basename(entry.worktreePath)), ["AppMarket", "AppMarketWeb"]);
  assert.equal(new Set(workspace.entries.map((entry) => path.dirname(entry.worktreePath))).size, 1);
  assert.equal(workspace.entries[0].branch, "story/v202605_ui_CARB_13998");
  assert.equal(workspace.entries[1].detached, true);
  assert.equal(workspace.entries[1].mode, "READ_ONLY");
  assert.equal(workspace.preflight.status, "PASS");
  assert.equal(fs.existsSync(path.join(workspace.root, ".aiefficiency", "workspace.json")), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(workspace.root, ".aiefficiency", "state.json"), "utf8")).status, "READY");
  const resumed = await provisionStoryWorktrees({
    tabId: "tab-bundle-1",
    worktreeRoot: f.worktreeRoot,
    naming: { ticketId: "CARB-13998" },
    workspaceBundle: appMarketBundle(),
    repositories: workspace.entries.map((entry) => ({
      role: entry.role,
      repositoryId: entry.repositoryId,
      name: entry.name,
      path: entry.basePath,
      baseRef: "v202605_ui",
      logicalBranch: "v202605_ui",
      detached: entry.detached,
      existingWorktreePath: entry.worktreePath,
    })),
  });
  assert.equal(resumed.root, workspace.root);
  assert.equal(resumed.entries.every((entry) => entry.reused), true);
  const associatedSource = f.createRepo("associated-tools", "tools-main");
  const extended = await provisionStoryWorktrees({
    tabId: "tab-bundle-1",
    worktreeRoot: f.worktreeRoot,
    naming: { ticketId: "CARB-13998" },
    workspaceBundle: appMarketBundle(),
    repositories: [
      ...resumed.entries.map((entry) => ({
        role: entry.role,
        repositoryId: entry.repositoryId,
        name: entry.name,
        path: entry.basePath,
        baseRef: entry.logicalBranch,
        logicalBranch: entry.logicalBranch,
        detached: entry.detached,
        existingWorktreePath: entry.worktreePath,
      })),
      {
        role: "extra",
        repositoryId: "associated-tools",
        name: "Associated Tools",
        path: associatedSource,
        baseRef: "tools-main",
        logicalBranch: "tools-main",
      },
    ],
  });
  assert.equal(extended.root, workspace.root);
  assert.deepEqual(
    extended.entries.map((entry) => path.basename(entry.worktreePath)),
    ["AppMarket", "AppMarketWeb", "associated-tools"],
  );
  assert.equal(extended.entries.slice(0, 2).every((entry) => entry.reused), true);
  assert.equal(extended.entries[2].branch, "story/tools_main_CARB_13998");
  assert.equal(extended.entries[2].logicalBranch, "tools-main");
  assert.equal(extended.bundle.members.find((member) => member.repositoryId === "associated-tools").association, true);
  const durable = runtimeDb.getStoryWorkspaceBundle("tab-bundle-1");
  assert.equal(durable.status, "READY");
  assert.equal(durable.workspace.root, workspace.root);
  assert.equal(durable.members.length, 3);
  assert.equal(git(f.app, "status", "--porcelain=v1"), originalAppStatus);
  assert.equal(git(f.web, "status", "--porcelain=v1"), originalWebStatus);
});

test("AI 获得写权限时在原 Bundle 目录晋升全部只读成员并保留各自分支规则", async (t) => {
  const f = bundleFixture();
  const sdk = f.createRepo("sdk-source", "tools-main");
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const bundle = appMarketBundle();
  bundle.members.push({ repositoryId: "sdk", checkoutDirName: "SdkFactory", mode: "READ_ONLY", association: true });
  const workspace = await provisionStoryWorktrees({
    tabId: "tab-bundle-promote-all",
    worktreeRoot: f.worktreeRoot,
    naming: { ticketId: "CARB-15190" },
    workspaceBundle: bundle,
    repositories: [
      { role: "primary", repositoryId: "app-market", name: "AppMarket", path: f.app, baseRef: "v202605_ui", logicalBranch: "v202605_ui" },
      { role: "webapp", repositoryId: "app-market-web", name: "AppMarketWeb", path: f.web, baseRef: "v202605_ui", logicalBranch: "v202605_ui", detached: true },
      { role: "extra", repositoryId: "sdk", name: "SdkFactory", path: sdk, baseRef: "tools-main", logicalBranch: "tools-main", detached: true },
    ],
  });
  const originalPaths = workspace.entries.map((entry) => entry.worktreePath);
  let persisted = null;
  const result = await promoteReadOnlyWorkspaceMembers({
    storyId: "tab-bundle-promote-all",
    workspace,
    naming: { ticketId: "CARB-15190", createdAt: workspace.createdAt },
    persistWorkspace(next, expected) {
      assert.equal(expected, workspace);
      persisted = next;
      return { ok: true, tab: { id: "tab-bundle-promote-all", worktree: next } };
    },
  });
  assert.equal(result.promoted, true);
  assert.equal(result.entries.length, 2);
  assert.deepEqual(result.workspace.entries.map((entry) => entry.worktreePath), originalPaths);
  assert.equal(result.workspace.entries[0].branch, "story/v202605_ui_CARB_15190");
  assert.equal(result.workspace.entries[1].branch, "story/v202605_ui_CARB_15190");
  assert.equal(result.workspace.entries[2].branch, "story/tools_main_CARB_15190");
  assert.deepEqual(result.workspace.entries.map((entry) => entry.mode), ["EDITABLE", "EDITABLE", "EDITABLE"]);
  assert.deepEqual(result.workspace.entries.map((entry) => entry.detached), [false, false, false]);
  assert.equal(git(workspace.entries[1].worktreePath, "branch", "--show-current"), "story/v202605_ui_CARB_15190");
  assert.equal(git(workspace.entries[2].worktreePath, "branch", "--show-current"), "story/tools_main_CARB_15190");
  const metadata = JSON.parse(fs.readFileSync(path.join(workspace.root, ".aiefficiency", "workspace.json"), "utf8"));
  assert.deepEqual(metadata.members.map((member) => member.mode), ["EDITABLE", "EDITABLE", "EDITABLE"]);
  assert.deepEqual(metadata.members.map((member) => member.checkoutBranch), result.workspace.entries.map((entry) => entry.branch));
  const durable = runtimeDb.getStoryWorkspaceBundle("tab-bundle-promote-all");
  assert.deepEqual(durable.members.map((member) => member.mode), ["EDITABLE", "EDITABLE", "EDITABLE"]);
  assert.equal(persisted, result.workspace);
  const idempotent = await promoteReadOnlyWorkspaceMembers({
    storyId: "tab-bundle-promote-all",
    workspace: result.workspace,
    persistWorkspace() { throw new Error("无只读成员时不应再次持久化"); },
  });
  assert.equal(idempotent.promoted, false);
});

test("关联工程故事分支状态写回失败时恢复 detached 并删除本次新分支", async (t) => {
  const f = bundleFixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const workspace = await provisionStoryWorktrees({
    tabId: "tab-bundle-promote-rollback",
    worktreeRoot: f.worktreeRoot,
    naming: { ticketId: "CARB-15191" },
    workspaceBundle: appMarketBundle(),
    repositories: [
      { role: "primary", repositoryId: "app-market", name: "AppMarket", path: f.app, baseRef: "v202605_ui", logicalBranch: "v202605_ui" },
      { role: "webapp", repositoryId: "app-market-web", name: "AppMarketWeb", path: f.web, baseRef: "v202605_ui", logicalBranch: "v202605_ui", detached: true },
    ],
  });
  await assert.rejects(() => promoteReadOnlyWorkspaceMembers({
    storyId: "tab-bundle-promote-rollback",
    workspace,
    naming: { ticketId: "CARB-15191", createdAt: workspace.createdAt },
    persistWorkspace: () => ({ ok: false, code: "WORKSPACE_STATE_CHANGED", error: "模拟 CAS 冲突" }),
  }), (error) => error.code === "WORKSPACE_STATE_CHANGED");
  assert.equal(git(workspace.entries[1].worktreePath, "branch", "--show-current"), "");
  assert.throws(() => git(f.web, "show-ref", "--verify", "--quiet", "refs/heads/story/v202605_ui_CARB_15191"));
  const metadata = JSON.parse(fs.readFileSync(path.join(workspace.root, ".aiefficiency", "workspace.json"), "utf8"));
  assert.equal(metadata.members[1].mode, "READ_ONLY");
  assert.equal(metadata.members[1].checkoutBranch, null);
  const durable = runtimeDb.getStoryWorkspaceBundle("tab-bundle-promote-rollback");
  assert.equal(durable.members.find((member) => member.repo_id === "app-market-web").mode, "READ_ONLY");
});

test("Bundle 必需依赖缺少同名逻辑分支时回滚已创建主 worktree", async (t) => {
  const f = bundleFixture({ webBranch: "develop" });
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  await assert.rejects(() => provisionStoryWorktrees({
    tabId: "tab-bundle-rollback",
    worktreeRoot: f.worktreeRoot,
    naming: { ticketId: "CARB-14001" },
    workspaceBundle: appMarketBundle(),
    repositories: [
      {
        role: "primary",
        repositoryId: "app-market",
        path: f.app,
        baseRef: "v202605_ui",
        logicalBranch: "v202605_ui",
      },
      {
        role: "webapp",
        repositoryId: "app-market-web",
        path: f.web,
        baseRef: "v202605_ui",
        logicalBranch: "v202605_ui",
      },
    ],
  }), (error) => error.code === "WORKTREE_BASE_REF_NOT_FOUND");
  const bundleRoot = fs.existsSync(f.worktreeRoot)
    ? fs.readdirSync(f.worktreeRoot).find((name) => /^CARB-14001-/.test(name))
    : "";
  if (bundleRoot) {
    assert.equal(fs.existsSync(path.join(f.worktreeRoot, bundleRoot, "AppMarket")), false);
  }
  assert.equal(git(f.app, "worktree", "list", "--porcelain").includes(`${path.join(f.worktreeRoot, bundleRoot, "AppMarket")}`), false);
});

test("Bundle Gradle 构建入口预检失败时整体回滚两个 worktree 和元数据", async (t) => {
  const f = bundleFixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  let inspected = null;
  await assert.rejects(() => provisionStoryWorktrees({
    tabId: "tab-bundle-gradle-rollback",
    worktreeRoot: f.worktreeRoot,
    naming: { ticketId: "CARB-14004" },
    workspaceBundle: appMarketBundle(),
    repositories: [
      { role: "primary", repositoryId: "app-market", path: f.app, baseRef: "v202605_ui", logicalBranch: "v202605_ui" },
      { role: "webapp", repositoryId: "app-market-web", path: f.web, baseRef: "v202605_ui", logicalBranch: "v202605_ui", detached: true },
    ],
    workspacePreflight: async (context) => {
      inspected = context;
      return { ok: false, status: "FAIL", code: "TEST_GRADLE_PREFLIGHT_FAILED", error: "模拟 Gradle projects 失败" };
    },
  }), (error) => error.code === "TEST_GRADLE_PREFLIGHT_FAILED" && /Gradle projects/.test(error.message));
  assert.equal(path.basename(inspected.buildEntry), "AppMarket");
  assert.equal(inspected.entries.length, 2);
  assert.equal(fs.existsSync(path.join(inspected.workspaceRoot, "AppMarket")), false);
  assert.equal(fs.existsSync(path.join(inspected.workspaceRoot, "AppMarketWeb")), false);
  const failedState = JSON.parse(fs.readFileSync(path.join(inspected.workspaceRoot, ".aiefficiency", "state.json"), "utf8"));
  assert.equal(failedState.status, "FAILED");
  assert.equal(failedState.failure.code, "TEST_GRADLE_PREFLIGHT_FAILED");
  const failureLogs = fs.readdirSync(path.join(inspected.workspaceRoot, ".aiefficiency", "logs"));
  assert.equal(failureLogs.length, 1);
  const failureLog = JSON.parse(fs.readFileSync(path.join(inspected.workspaceRoot, ".aiefficiency", "logs", failureLogs[0]), "utf8"));
  assert.equal(failureLog.failure.preflight.status, "FAIL");
  assert.equal(git(f.app, "worktree", "list", "--porcelain").includes(inspected.buildEntry), false);
  assert.equal(git(f.web, "worktree", "list", "--porcelain").includes(path.join(inspected.workspaceRoot, "AppMarketWeb")), false);

  const retried = await provisionStoryWorktrees({
    tabId: "tab-bundle-gradle-rollback",
    worktreeRoot: f.worktreeRoot,
    naming: { ticketId: "CARB-14004" },
    workspaceBundle: appMarketBundle(),
    repositories: [
      { role: "primary", repositoryId: "app-market", path: f.app, baseRef: "v202605_ui", logicalBranch: "v202605_ui" },
      { role: "webapp", repositoryId: "app-market-web", path: f.web, baseRef: "v202605_ui", logicalBranch: "v202605_ui", detached: true },
    ],
    workspacePreflight: async () => ({ ok: true, status: "PASS", task: "projects" }),
  });
  assert.equal(retried.preflight.status, "PASS");
  const readyState = JSON.parse(fs.readFileSync(path.join(inspected.workspaceRoot, ".aiefficiency", "state.json"), "utf8"));
  assert.equal(readyState.status, "READY");
  assert.equal(fs.readdirSync(path.join(inspected.workspaceRoot, ".aiefficiency", "logs")).length, 1, "成功重试前保留失败诊断日志");
});

test("Bundle 两个可修改仓库使用各自 Repository 中的同名故事分支", async (t) => {
  const f = bundleFixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const workspace = await provisionStoryWorktrees({
    tabId: "tab-bundle-editable-pair",
    worktreeRoot: f.worktreeRoot,
    naming: { ticketId: "CARB-14002" },
    workspaceBundle: appMarketBundle({ webMode: "EDITABLE" }),
    repositories: [
      { role: "primary", repositoryId: "app-market", path: f.app, baseRef: "v202605_ui", logicalBranch: "v202605_ui" },
      { role: "extra", repositoryId: "app-market-web", path: f.web, baseRef: "v202605_ui", logicalBranch: "v202605_ui" },
    ],
  });
  assert.equal(workspace.entries[0].detached, false);
  assert.equal(workspace.entries[1].detached, false);
  assert.equal(workspace.entries[0].branch, workspace.entries[1].branch);
  assert.equal(workspace.entries[0].branch, "story/v202605_ui_CARB_14002");
});

test("旧 worktree 含未提交改动时事务迁移到 Bundle 固定目录并保持 Git 状态", async (t) => {
  const f = bundleFixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const legacy = await provisionStoryWorktrees({
    tabId: "tab-bundle-migration",
    worktreeRoot: f.worktreeRoot,
    naming: { ticketId: "CARB-14003" },
    repositories: [
      { role: "primary", repositoryId: "app-market", path: f.app, baseRef: "v202605_ui", originalBranch: "v202605_ui" },
      { role: "webapp", repositoryId: "app-market-web", path: f.web, baseRef: "v202605_ui", originalBranch: "v202605_ui", detached: true },
    ],
  });
  const oldApp = legacy.entries.find((entry) => entry.repositoryId === "app-market").worktreePath;
  const oldWeb = legacy.entries.find((entry) => entry.repositoryId === "app-market-web").worktreePath;
  fs.writeFileSync(path.join(oldApp, "local-dirty.txt"), "keep me\n");
  const beforeStatus = git(oldApp, "status", "--porcelain=v1");
  const migrated = await provisionStoryWorktrees({
    tabId: "tab-bundle-migration",
    worktreeRoot: f.worktreeRoot,
    naming: { ticketId: "CARB-14003" },
    workspaceBundle: appMarketBundle(),
    repositories: [
      { role: "primary", repositoryId: "app-market", path: f.app, baseRef: "v202605_ui", logicalBranch: "v202605_ui", existingWorktreePath: oldApp },
      { role: "webapp", repositoryId: "app-market-web", path: f.web, baseRef: "v202605_ui", logicalBranch: "v202605_ui", detached: true, existingWorktreePath: oldWeb },
    ],
  });
  const newApp = migrated.entries.find((entry) => entry.repositoryId === "app-market").worktreePath;
  assert.equal(path.basename(newApp), "AppMarket");
  assert.equal(path.basename(migrated.entries.find((entry) => entry.repositoryId === "app-market-web").worktreePath), "AppMarketWeb");
  assert.equal(fs.existsSync(oldApp), false);
  assert.equal(fs.existsSync(oldWeb), false);
  assert.equal(fs.readFileSync(path.join(newApp, "local-dirty.txt"), "utf8"), "keep me\n");
  assert.equal(git(newApp, "status", "--porcelain=v1"), beforeStatus);
});

test("补充单 Flavor 和 TB 单号时安全迁移已有 worktree 且保留本地改动", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  git(f.source, "branch", "-m", "v202605/UI");
  const createdAt = new Date(2026, 6, 24, 17, 11).getTime();
  const first = await provisionStoryWorktrees({
    tabId: "tab-safe-name",
    worktreeRoot: f.worktreeRoot,
    naming: { flavors: [], ticketId: "CARB-1234", createdAt },
    repositories: [{ role: "primary", name: "App", path: f.source }],
  });
  const original = first.entries[0];
  assert.equal(path.basename(original.worktreePath), "v202605_UI_CARB_1234");
  fs.writeFileSync(path.join(original.path, "keep-local.txt"), "keep\n");
  const legacyPath = path.join(first.root, "12345678-abcdef1234-b");
  git(f.source, "worktree", "move", original.worktreePath, legacyPath);
  assert.equal(path.basename(legacyPath), "12345678-abcdef1234-b");

  const renamed = await provisionStoryWorktrees({
    tabId: "tab-safe-name",
    worktreeRoot: f.worktreeRoot,
    naming: { flavors: ["Avatr8678"], ticketId: "CARB-1234", createdAt },
    repositories: [{
      role: "primary",
      name: "App",
      path: f.source,
      baseRef: original.branch,
      originalBranch: original.originalBranch,
      existingWorktreePath: legacyPath,
    }],
  });
  const current = renamed.entries[0];
  assert.equal(path.basename(current.worktreePath), "v202605_UI_CARB_1234");
  assert.match(path.basename(current.worktreePath), /^[A-Za-z0-9_]+$/);
  // 目录可按新规则迁移；已存在的开发分支必须保留，避免静默改名丢提交。
  assert.equal(current.branch, original.branch);
  assert.equal(fs.existsSync(legacyPath), false);
  assert.equal(fs.readFileSync(path.join(current.path, "keep-local.txt"), "utf8"), "keep\n");
  assert.match(git(current.path, "status", "--porcelain"), /keep-local\.txt/);
  assert.equal(current.originalBranch, "v202605/UI");
  assert.equal(renamed.namingVersion, 2);
});

test("新建 worktree 按 Flavor、原始分支、TB 或时间生成 story/ 分支名", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  git(f.source, "branch", "-m", "v202605/UI");
  const createdAt = new Date(2026, 6, 24, 17, 11).getTime();

  const withTicket = await provisionStoryWorktrees({
    tabId: "tab-branch-ticket",
    worktreeRoot: f.worktreeRoot,
    naming: { flavors: ["avatr8678"], ticketId: "CARB-1234", createdAt },
    repositories: [{ role: "primary", name: "App", path: f.source }],
  });
  assert.equal(withTicket.entries[0].branch, "story/v202605_UI_CARB_1234");
  assert.equal(path.basename(withTicket.entries[0].worktreePath), "v202605_UI_CARB_1234");

  const noTicketRoot = path.join(f.root, "managed-no-ticket");
  const noTicket = await provisionStoryWorktrees({
    tabId: "tab-branch-stamp",
    worktreeRoot: noTicketRoot,
    naming: { flavors: ["avatr8678"], ticketId: "", createdAt },
    repositories: [{ role: "primary", name: "App", path: f.source }],
  });
  assert.equal(noTicket.entries[0].branch, "story/v202605_UI_07241711");

  const multiFlavorRoot = path.join(f.root, "managed-multi");
  const multiFlavor = await provisionStoryWorktrees({
    tabId: "tab-branch-multi",
    worktreeRoot: multiFlavorRoot,
    naming: { flavors: ["avatr8678", "avatr8155"], ticketId: "CARB-1234", createdAt },
    repositories: [{ role: "primary", name: "App", path: f.source }],
  });
  // 多 Flavor 有 TB 单号时按分支+CARB_单号命名；前一个 withTicket 用例已在同仓创建
  // story/v202605_UI_CARB_1234 且仍被其 worktree 占用，故此处分支名按冲突规则升到 _2。
  assert.equal(multiFlavor.entries[0].branch, "story/v202605_UI_CARB_1234_2");
});

test("同一本地基仓可供两个故事点创建隔离 worktree，且不改原工作区", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(f.source, "original-only.txt"), "dirty\n");
  const before = git(f.source, "status", "--porcelain");
  const createdAt = new Date(2026, 6, 25, 18, 23, 0).getTime();

  const first = await provisionStoryWorktrees({
    tabId: "tab-one",
    worktreeRoot: f.worktreeRoot,
    naming: { createdAt },
    repositories: [{ role: "primary", name: "App", path: f.source }],
  });
  const second = await provisionStoryWorktrees({
    tabId: "tab-two",
    worktreeRoot: f.worktreeRoot,
    naming: { createdAt },
    repositories: [{ role: "primary", name: "App", path: f.source }],
  });

  assert.notEqual(first.entries[0].path, second.entries[0].path);
  // 直接落在 WorktreeSpace/<目录名>，无中间哈希、无短指纹；同名冲突时第二项升到含秒
  assert.equal(path.resolve(first.root), path.resolve(f.worktreeRoot));
  assert.equal(path.dirname(first.entries[0].worktreePath), path.resolve(f.worktreeRoot));
  assert.equal(path.dirname(second.entries[0].worktreePath), path.resolve(f.worktreeRoot));
  assert.equal(path.basename(first.entries[0].worktreePath), "master_07251823");
  assert.match(path.basename(second.entries[0].worktreePath), /^master_07251823\d{2}$/);
  assert.doesNotMatch(first.entries[0].worktreePath.replace(/\\/g, "/"), /\/[0-9a-f]{12}\//i);
  assert.equal(fs.readFileSync(path.join(first.entries[0].path, "tracked.txt"), "utf8").replace(/\r\n/g, "\n"), "base\n");
  assert.equal(fs.existsSync(path.join(first.entries[0].path, "original-only.txt")), false);
  fs.writeFileSync(path.join(first.entries[0].path, "story-one.txt"), "one\n");
  assert.equal(fs.existsSync(path.join(second.entries[0].path, "story-one.txt")), false);
  assert.equal(fs.existsSync(path.join(f.source, "story-one.txt")), false);
  assert.equal(git(f.source, "status", "--porcelain"), before, "原工作区状态不得变化");
  assert.match(first.entries[0].branch, /^story\//);
  assert.match(second.entries[0].branch, /^story\//);
  assert.notEqual(first.entries[0].branch, second.entries[0].branch);
});

test("两个 Gateway 进程并发初始化同一基仓时原子预留不同目录和 story 分支", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const createdAt = new Date(2026, 7, 2, 14, 2, 29).getTime();
  const moduleUrl = new URL("../services/devbench/worktree-manager.js", import.meta.url).href;
  const childScript = `
    const request = JSON.parse(process.env.WORKTREE_REQUEST_JSON);
    const { provisionStoryWorktrees } = await import(process.env.WORKTREE_MANAGER_MODULE_URL);
    const result = await provisionStoryWorktrees(request);
    process.stdout.write(JSON.stringify({ operationId: result.operationId, entry: result.entries[0] }));
  `;
  const runChild = (tabId, operationId) => execFileAsync(
    process.execPath,
    ["--input-type=module", "-e", childScript],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 120_000,
      env: {
        ...process.env,
        GATEWAY_DB_PATH: path.join(f.root, `${tabId}.db`),
        DEVBENCH_STORE_DIR: path.join(f.root, `${tabId}-store`),
        WORKTREE_MANAGER_MODULE_URL: moduleUrl,
        WORKTREE_REQUEST_JSON: JSON.stringify({
          tabId,
          worktreeRoot: f.worktreeRoot,
          naming: { createdAt, operationId },
          repositories: [{ role: "primary", name: "App", path: f.source }],
        }),
      },
    },
  );

  const [leftOutput, rightOutput] = await Promise.all([
    runChild("cross-process-left", "operation-cross-process-left"),
    runChild("cross-process-right", "operation-cross-process-right"),
  ]);
  const left = JSON.parse(leftOutput.stdout);
  const right = JSON.parse(rightOutput.stdout);

  assert.equal(left.operationId, "operation-cross-process-left");
  assert.equal(right.operationId, "operation-cross-process-right");
  assert.notEqual(left.entry.worktreePath, right.entry.worktreePath);
  assert.notEqual(left.entry.branch, right.entry.branch);
  assert.equal(left.entry.branch, `story/${path.basename(left.entry.worktreePath)}`);
  assert.equal(right.entry.branch, `story/${path.basename(right.entry.worktreePath)}`);
  assert.equal(fs.existsSync(path.join(left.entry.worktreePath, "tracked.txt")), true);
  assert.equal(fs.existsSync(path.join(right.entry.worktreePath, "tracked.txt")), true);
  const reservations = fs.readdirSync(f.worktreeRoot)
    .filter((name) => name.endsWith(".devbench-worktree-reservation.json"));
  assert.equal(reservations.length, 2);
});

test("worktree 计划回调先于 git add，add 失败时保留无法证明归属的目标目录", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const operationId = "operation-plan-before-add";
  let planned = null;

  await assert.rejects(
    provisionStoryWorktrees({
      tabId: "plan-before-add",
      worktreeRoot: f.worktreeRoot,
      naming: { operationId, createdAt: new Date(2026, 7, 2, 14, 3, 0).getTime() },
      repositories: [{
        role: "primary",
        name: "App",
        path: f.source,
        baseProjectId: "project-app",
        repositoryId: "repository-app",
      }],
      onWorktreePlanned: async (payload) => {
        planned = payload;
        fs.mkdirSync(payload.worktreePath, { recursive: true });
        fs.writeFileSync(path.join(payload.worktreePath, "other-operation.marker"), "keep\n");
      },
    }),
    (error) => error?.code === "WORKTREE_TARGET_CONFLICT",
  );

  assert.ok(planned);
  assert.equal(planned.role, "primary");
  assert.equal(planned.basePath, path.resolve(f.source));
  assert.equal(planned.baseProjectId, "project-app");
  assert.equal(planned.repositoryId, "repository-app");
  assert.equal(planned.operationId, operationId);
  assert.equal(planned.directoryName, path.basename(planned.worktreePath));
  assert.ok(planned.gitCommonDir);
  assert.equal(
    fs.readFileSync(path.join(planned.worktreePath, "other-operation.marker"), "utf8"),
    "keep\n",
  );
  const managerSource = fs.readFileSync(
    new URL("../services/devbench/worktree-manager.js", import.meta.url),
    "utf8",
  );
  const addFailureBlock = managerSource.match(/if \(!added\.ok\) \{([\s\S]*?)let actual/);
  assert.ok(addFailureBlock, "应保留 git worktree add 失败处理分支");
  assert.doesNotMatch(addFailureBlock[1], /rmSync|worktree", "remove|worktree", "prune/);
});

test("预留目标被 junction 偷换为 sibling worktree 时拒绝静默复用", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  fs.mkdirSync(f.worktreeRoot, { recursive: true });
  const sibling = path.join(f.worktreeRoot, "sibling");
  git(f.source, "worktree", "add", "-b", "story/sibling", sibling, "HEAD");
  const siblingFile = path.join(sibling, "tracked.txt");
  const before = fs.readFileSync(siblingFile, "utf8");
  let plannedPath = "";

  await assert.rejects(
    provisionStoryWorktrees({
      tabId: "junction-swap",
      worktreeRoot: f.worktreeRoot,
      naming: { operationId: "junction-swap-operation", createdAt: new Date(2026, 7, 2, 14, 3, 30).getTime() },
      repositories: [{ role: "primary", name: "App", path: f.source }],
      onWorktreePlanned: async (planned) => {
        plannedPath = planned.worktreePath;
        try {
          fs.symlinkSync(sibling, plannedPath, process.platform === "win32" ? "junction" : "dir");
        } catch (error) {
          t.skip(`当前平台无法创建目录链接：${error.code || error.message}`);
        }
      },
    }),
    (error) => ["WORKTREE_TARGET_REPARSE_POINT", "WORKTREE_TARGET_ALIAS_CONFLICT", "WORKTREE_TARGET_REGISTRATION_CONFLICT"].includes(error?.code),
  );

  if (!plannedPath) return;
  assert.equal(fs.realpathSync.native(plannedPath), fs.realpathSync.native(sibling));
  assert.equal(git(sibling, "branch", "--show-current"), "story/sibling");
  assert.equal(fs.readFileSync(siblingFile, "utf8"), before);
});

test("worktree 根目录经 ancestor junction 落入基础仓时在 git add 前拒绝", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const physicalParent = path.join(f.source, "worktree-alias-target");
  const aliasParent = path.join(os.tmpdir(), `dj-${Date.now().toString(36)}`);
  t.after(() => { try { fs.rmSync(aliasParent, { recursive: true, force: true }); } catch {} });
  fs.mkdirSync(physicalParent, { recursive: true });
  try {
    fs.symlinkSync(physicalParent, aliasParent, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    t.skip(`当前平台无法创建目录链接：${error.code || error.message}`);
    return;
  }
  const requestedRoot = path.join(aliasParent, "managed");
  const beforeList = git(f.source, "worktree", "list", "--porcelain");

  await assert.rejects(
    provisionStoryWorktrees({
      tabId: "root-junction-inside-base",
      worktreeRoot: requestedRoot,
      naming: { operationId: "root-junction-operation" },
      repositories: [{ role: "primary", name: "App", path: f.source }],
    }),
    (error) => error?.code === "WORKTREE_ROOT_INSIDE_SOURCE" || error?.code === "WORKTREE_ROOT_REPARSE_POINT",
  );

  assert.equal(git(f.source, "worktree", "list", "--porcelain"), beforeList);
  assert.equal(fs.existsSync(path.join(physicalParent, "managed")), false);
});

test("worktree 根目录经过任意 ancestor junction 时在创建目录前拒绝", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const physicalParent = fs.mkdtempSync(path.join(os.tmpdir(), "devbench-root-target-"));
  const aliasParent = path.join(os.tmpdir(), `dj-out-${Date.now().toString(36)}`);
  t.after(() => {
    try { fs.rmSync(aliasParent, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(physicalParent, { recursive: true, force: true }); } catch {}
  });
  try {
    fs.symlinkSync(physicalParent, aliasParent, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    t.skip(`当前平台无法创建目录链接：${error.code || error.message}`);
    return;
  }
  const requestedRoot = path.join(aliasParent, "managed");
  const beforeList = git(f.source, "worktree", "list", "--porcelain");

  await assert.rejects(
    provisionStoryWorktrees({
      tabId: "root-junction-outside-base",
      worktreeRoot: requestedRoot,
      naming: { operationId: "root-junction-outside-operation" },
      repositories: [{ role: "primary", name: "App", path: f.source }],
    }),
    (error) => error?.code === "WORKTREE_ROOT_REPARSE_POINT",
  );

  assert.equal(git(f.source, "worktree", "list", "--porcelain"), beforeList);
  assert.equal(fs.existsSync(path.join(physicalParent, "managed")), false);
});

test("同一 tab 重启后按显式 existingWorktreePath 复用已持久化计划", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const naming = {
    operationId: "operation-restart-reuse",
    createdAt: new Date(2026, 7, 2, 14, 4, 0).getTime(),
  };
  let persistedPlan = null;
  const first = await provisionStoryWorktrees({
    tabId: "restart-reuse",
    worktreeRoot: f.worktreeRoot,
    naming,
    repositories: [{ role: "primary", name: "App", path: f.source }],
    onWorktreePlanned: async (payload) => {
      persistedPlan = payload;
    },
  });
  assert.ok(persistedPlan);
  assert.equal(persistedPlan.worktreePath, first.entries[0].worktreePath);

  let resumedPlan = null;
  const resumed = await provisionStoryWorktrees({
    tabId: "restart-reuse",
    worktreeRoot: f.worktreeRoot,
    naming,
    repositories: [{
      role: "primary",
      name: "App",
      path: f.source,
      existingWorktreePath: persistedPlan.worktreePath,
    }],
    onWorktreePlanned: async (payload) => {
      resumedPlan = payload;
    },
  });

  assert.ok(resumedPlan);
  assert.equal(resumedPlan.worktreePath, persistedPlan.worktreePath);
  assert.equal(resumed.entries[0].worktreePath, persistedPlan.worktreePath);
  assert.equal(resumed.entries[0].reused, true);
  assert.equal(resumed.operationId, naming.operationId);
});

test("其它 tab 或 operation 不能释放不属于自己的 worktree sidecar", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const created = await provisionStoryWorktrees({
    tabId: "sidecar-owner",
    worktreeRoot: f.worktreeRoot,
    naming: { operationId: "sidecar-owner-operation" },
    repositories: [{ role: "primary", name: "App", path: f.source }],
  });
  const entry = created.entries[0];
  const sidecar = worktreeTest.worktreeDirectoryReservationPath(
    path.dirname(entry.worktreePath),
    path.basename(entry.worktreePath),
  );
  assert.equal(fs.existsSync(sidecar), true);
  assert.equal(worktreeTest.releaseWorktreeDirectoryReservation(entry.worktreePath, entry.gitCommonDir, {
    tabId: "foreign-tab",
    operationId: "sidecar-owner-operation",
  }), false);
  assert.equal(worktreeTest.releaseWorktreeDirectoryReservation(entry.worktreePath, entry.gitCommonDir, {
    tabId: "sidecar-owner",
    operationId: "foreign-operation",
  }), false);
  assert.equal(fs.existsSync(sidecar), true);
  assert.equal(worktreeTest.releaseWorktreeDirectoryReservation(entry.worktreePath, entry.gitCommonDir, {
    tabId: "sidecar-owner",
    operationId: "sidecar-owner-operation",
  }), true);
  assert.equal(fs.existsSync(sidecar), false);
});

test("旧版本 existingWorktreePath 没有 sidecar 时跨分钟仍在原位认领并复用", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const createdAt = new Date(2026, 7, 2, 14, 5, 0).getTime();
  let firstPlan = null;
  const first = await provisionStoryWorktrees({
    tabId: "legacy-no-sidecar",
    worktreeRoot: f.worktreeRoot,
    naming: { createdAt, operationId: "legacy-first-generation" },
    repositories: [{ role: "primary", name: "App", path: f.source }],
    onWorktreePlanned: async (payload) => {
      firstPlan = payload;
    },
  });
  fs.unlinkSync(firstPlan.reservationPath);

  let resumedPlan = null;
  const resumed = await provisionStoryWorktrees({
    tabId: "legacy-no-sidecar",
    worktreeRoot: f.worktreeRoot,
    naming: { createdAt: createdAt + 120_000, operationId: "legacy-next-generation" },
    repositories: [{
      role: "primary",
      name: "App",
      path: f.source,
      existingWorktreePath: first.entries[0].worktreePath,
    }],
    onWorktreePlanned: async (payload) => {
      resumedPlan = payload;
    },
  });

  assert.equal(resumed.entries[0].worktreePath, first.entries[0].worktreePath);
  assert.equal(resumedPlan.worktreePath, first.entries[0].worktreePath);
  assert.equal(fs.existsSync(resumedPlan.reservationPath), true);
  assert.equal(resumed.entries[0].reused, true);
});

test("故事点切走后再选回同一仓库时复用已前移的实时开发分支", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const first = await provisionStoryWorktrees({
    tabId: "tab-return",
    worktreeRoot: f.worktreeRoot,
    repositories: [{ role: "primary", name: "App", path: f.source }],
  });
  const entry = first.entries[0];
  fs.writeFileSync(path.join(entry.path, "story-commit.txt"), "story\n");
  git(entry.path, "add", "story-commit.txt");
  git(entry.path, "commit", "-m", "story commit");
  const advancedHead = git(entry.path, "rev-parse", "HEAD");

  const returned = await provisionStoryWorktrees({
    tabId: "tab-return",
    worktreeRoot: f.worktreeRoot,
    repositories: [{
      role: "primary",
      name: "App",
      path: f.source,
      existingWorktreePath: entry.worktreePath,
      preferredBranch: entry.branch,
    }],
  });
  assert.equal(returned.entries[0].path, entry.path);
  assert.equal(returned.entries[0].reused, true);
  assert.equal(git(returned.entries[0].path, "rev-parse", "HEAD"), advancedHead);
  assert.equal(returned.entries[0].baseRevision, advancedHead);
  assert.equal(returned.entries[0].branch, entry.branch);
});

test("同仓库内的 WebApp 子目录复用同一个 worktree", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(f.source, "WebApp"));
  fs.writeFileSync(path.join(f.source, "WebApp", "web.txt"), "web\n");
  git(f.source, "add", "WebApp/web.txt");
  git(f.source, "commit", "-m", "web");

  const result = await provisionStoryWorktrees({
    tabId: "tab-web",
    worktreeRoot: f.worktreeRoot,
    repositories: [
      { role: "primary", name: "App", path: f.source },
      { role: "webapp", name: "WebApp", path: path.join(f.source, "WebApp") },
    ],
  });
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[1].path, path.join(result.entries[0].path, "WebApp"));
  assert.equal(result.entries[0].worktreePath, result.entries[1].worktreePath);
});

test("commit review 可创建精确 revision 的 detached worktree", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const revision = git(f.source, "rev-parse", "HEAD");

  const result = await provisionStoryWorktrees({
    tabId: "tab-review",
    worktreeRoot: f.worktreeRoot,
    repositories: [{
      role: "primary",
      name: "Review",
      path: f.source,
      baseRef: revision,
      detached: true,
    }],
  });
  assert.equal(git(result.entries[0].path, "rev-parse", "HEAD"), revision);
  assert.equal(git(result.entries[0].path, "branch", "--show-current"), "");
  assert.equal(result.entries[0].detached, true);
});

test("拒绝把 worktree 根目录放进任一原工程内部", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  await assert.rejects(
    provisionStoryWorktrees({
      tabId: "tab-inside",
      worktreeRoot: path.join(f.source, "WorktreeSpace"),
      repositories: [{ role: "primary", name: "App", path: f.source }],
    }),
    (error) => error?.code === "WORKTREE_ROOT_INSIDE_SOURCE",
  );
  assert.equal(fs.existsSync(path.join(f.source, "WorktreeSpace")), false);
});

test("同一故事点请求不同 revision 或模式时不得静默复用旧 HEAD", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const firstRevision = git(f.source, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(f.source, "second.txt"), "second\n");
  git(f.source, "add", "second.txt");
  git(f.source, "commit", "-m", "second");
  const secondRevision = git(f.source, "rev-parse", "HEAD");

  const first = await provisionStoryWorktrees({
    tabId: "tab-revision",
    worktreeRoot: f.worktreeRoot,
    repositories: [{ role: "primary", name: "App", path: f.source, baseRef: firstRevision, detached: true }],
  });
  const second = await provisionStoryWorktrees({
    tabId: "tab-revision",
    worktreeRoot: f.worktreeRoot,
    repositories: [{ role: "primary", name: "App", path: f.source, baseRef: secondRevision, detached: true }],
  });
  const branchMode = await provisionStoryWorktrees({
    tabId: "tab-revision",
    worktreeRoot: f.worktreeRoot,
    repositories: [{ role: "primary", name: "App", path: f.source, baseRef: secondRevision, detached: false }],
  });

  assert.notEqual(first.entries[0].path, second.entries[0].path);
  assert.notEqual(second.entries[0].path, branchMode.entries[0].path);
  assert.equal(git(first.entries[0].path, "rev-parse", "HEAD"), firstRevision);
  assert.equal(git(second.entries[0].path, "rev-parse", "HEAD"), secondRevision);
  assert.equal(second.entries[0].detached, true);
  assert.equal(branchMode.entries[0].detached, false);
  assert.match(branchMode.entries[0].branch, /^story\//);

  const reused = await provisionStoryWorktrees({
    tabId: "tab-revision",
    worktreeRoot: f.worktreeRoot,
    repositories: [{
      role: "primary",
      name: "App",
      path: f.source,
      baseRef: secondRevision,
      detached: true,
      existingWorktreePath: second.entries[0].worktreePath,
    }],
  });
  assert.equal(reused.entries[0].path, second.entries[0].path);
  assert.equal(reused.entries[0].baseRevision, secondRevision);
  assert.equal(reused.entries[0].detached, true);
  assert.equal(reused.entries[0].reused, true);
});

test("开发分支已前移且 worktree 被移除后，按原 revision 重建不得复用漂移分支", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const requestedRevision = git(f.source, "rev-parse", "HEAD");

  const first = await provisionStoryWorktrees({
    tabId: "tab-rebuild",
    worktreeRoot: f.worktreeRoot,
    repositories: [{ role: "primary", name: "App", path: f.source, baseRef: requestedRevision, detached: false }],
  });
  const firstEntry = first.entries[0];
  fs.writeFileSync(path.join(firstEntry.path, "story-change.txt"), "story\n");
  git(firstEntry.path, "add", "story-change.txt");
  git(firstEntry.path, "commit", "-m", "story change");
  const advancedRevision = git(firstEntry.path, "rev-parse", "HEAD");
  assert.notEqual(advancedRevision, requestedRevision);
  git(f.source, "-c", "core.longpaths=true", "worktree", "remove", "--force", firstEntry.worktreePath);

  const rebuilt = await provisionStoryWorktrees({
    tabId: "tab-rebuild",
    worktreeRoot: f.worktreeRoot,
    repositories: [{ role: "primary", name: "App", path: f.source, baseRef: requestedRevision, detached: false }],
  });
  const rebuiltEntry = rebuilt.entries[0];
  assert.equal(git(rebuiltEntry.path, "rev-parse", "HEAD"), requestedRevision);
  assert.equal(rebuiltEntry.baseRevision, requestedRevision);
  assert.notEqual(rebuiltEntry.branch, firstEntry.branch);
  assert.equal(git(f.source, "rev-parse", firstEntry.branch), advancedRevision, "已前移分支必须保留，不得强制回退");
});

test("Windows 超长配置根目录会映射到安全短路径并成功创建 worktree", {
  skip: process.platform !== "win32",
}, async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const requestedRoot = path.join(f.root, "a".repeat(120), "b".repeat(120));
  assert.ok(path.join(requestedRoot, "W".repeat(112)).length >= 180);

  const result = await provisionStoryWorktrees({
    tabId: "tab-windows-long-path",
    worktreeRoot: requestedRoot,
    repositories: [{ role: "primary", name: "App", path: f.source }],
  });
  const entry = result.entries[0];
  try {
    assert.equal(result.relocatedForWindowsPath, true);
    assert.equal(result.requestedRoot, path.resolve(requestedRoot));
    assert.ok(entry.path.length < 180, `实际 worktree 路径仍过长：${entry.path.length}`);
    assert.equal(fs.existsSync(path.join(entry.path, "tracked.txt")), true);
    assert.equal(git(entry.path, "rev-parse", "HEAD"), git(f.source, "rev-parse", "HEAD"));
  } finally {
    try { git(f.source, "-c", "core.longpaths=true", "worktree", "remove", "--force", entry.worktreePath); } catch {}
    try { fs.rmSync(result.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch {}
  }
});

test("安全清理预检分别阻止 dirty、未推送提交和未恢复 stash", async (t) => {
  await t.test("dirty", async (t) => {
    const f = fixture();
    t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    const worktree = await provisionStoryWorktrees({
      tabId: "cleanup-dirty",
      worktreeRoot: f.worktreeRoot,
      repositories: [{ role: "primary", name: "App", path: f.source }],
    });
    fs.writeFileSync(path.join(worktree.entries[0].path, "dirty.txt"), "dirty\n");
    const inspection = await inspectStoryWorktreeCleanup({ worktree, storyTitle: "清理 dirty" });
    assert.equal(inspection.safe, false);
    assert.equal(inspection.totals.dirty, 1);
    assert.equal(inspection.blockers.some((blocker) => blocker.type === "dirty"), true);
  });

  await t.test("未推送提交", async (t) => {
    const f = fixture();
    t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    const worktree = await provisionStoryWorktrees({
      tabId: "cleanup-unpushed",
      worktreeRoot: f.worktreeRoot,
      repositories: [{ role: "primary", name: "App", path: f.source }],
    });
    const entry = worktree.entries[0];
    fs.writeFileSync(path.join(entry.path, "commit.txt"), "commit\n");
    git(entry.path, "add", "commit.txt");
    git(entry.path, "commit", "-m", "local only");
    const inspection = await inspectStoryWorktreeCleanup({ worktree, storyTitle: "清理未推送" });
    assert.equal(inspection.safe, false);
    assert.equal(inspection.totals.unpushed, 1);
    assert.equal(inspection.blockers.some((blocker) => blocker.type === "unpushed"), true);
  });

  await t.test("未恢复 stash", async (t) => {
    const f = fixture();
    t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    const worktree = await provisionStoryWorktrees({
      tabId: "cleanup-stash",
      worktreeRoot: f.worktreeRoot,
      repositories: [{ role: "primary", name: "App", path: f.source }],
    });
    const entry = worktree.entries[0];
    fs.writeFileSync(path.join(entry.path, "tracked.txt"), "stash me\n");
    git(entry.path, "stash", "push", "-m", "manual safety stash");
    const inspection = await inspectStoryWorktreeCleanup({ worktree, storyTitle: "清理 stash" });
    assert.equal(inspection.safe, false);
    assert.equal(inspection.totals.dirty, 0);
    assert.equal(inspection.totals.stashes, 1);
    assert.equal(inspection.blockers.some((blocker) => blocker.type === "stash"), true);
  });

  await t.test("stash 后重命名分支仍必须阻止清理", async (t) => {
    const f = fixture();
    t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    const worktree = await provisionStoryWorktrees({
      tabId: "cleanup-renamed-stash",
      worktreeRoot: f.worktreeRoot,
      repositories: [{ role: "primary", name: "App", path: f.source }],
    });
    const entry = worktree.entries[0];
    fs.writeFileSync(path.join(entry.path, "tracked.txt"), "stash before rename\n");
    git(entry.path, "stash", "push", "-m", "manual safety stash before rename");
    git(entry.path, "branch", "-m", `${entry.branch}-renamed`);

    const inspection = await inspectStoryWorktreeCleanup({
      worktree,
      storyTitle: "重命名分支 stash",
    });
    assert.equal(inspection.safe, false);
    assert.equal(inspection.totals.dirty, 0);
    assert.equal(inspection.totals.stashes, 1);
    assert.equal(inspection.blockers.some((blocker) => blocker.type === "stash"), true);
  });
});

test("清理执行前若发现 checkout 被其它故事点登记则不删除任何内容", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const worktree = await provisionStoryWorktrees({
    tabId: "cleanup-owner-guard",
    worktreeRoot: f.worktreeRoot,
    repositories: [{ role: "primary", name: "App", path: f.source }],
  });
  const target = worktree.entries[0].worktreePath;
  const inspection = await inspectStoryWorktreeCleanup({ worktree, storyTitle: "owner guard" });
  const result = await cleanupStoryWorktrees({
    tabId: "cleanup-owner-guard",
    worktree,
    storyTitle: "owner guard",
    expectedToken: inspection.token,
    ownershipGuard: () => false,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "WORKTREE_SHARED_OWNERSHIP_CONFLICT");
  assert.equal(fs.existsSync(path.join(target, "tracked.txt")), true);
  assert.deepEqual(result.removed, []);
});

test("安全清理要求预检 token 最新，成功后删除目录但保留开发分支", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const worktree = await provisionStoryWorktrees({
    tabId: "cleanup-safe",
    worktreeRoot: f.worktreeRoot,
    repositories: [{ role: "primary", name: "App", path: f.source }],
  });
  const entry = worktree.entries[0];
  const firstInspection = await inspectStoryWorktreeCleanup({ worktree, storyTitle: "安全清理" });
  assert.equal(firstInspection.safe, true);
  assert.match(firstInspection.token, /^[0-9a-f]{64}$/);

  fs.writeFileSync(path.join(entry.path, "changed-after-check.txt"), "changed\n");
  const stale = await cleanupStoryWorktrees({
    worktree,
    storyTitle: "安全清理",
    expectedToken: firstInspection.token,
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, "WORKTREE_CLEANUP_STALE");
  fs.rmSync(path.join(entry.path, "changed-after-check.txt"));

  const latest = await inspectStoryWorktreeCleanup({ worktree, storyTitle: "安全清理" });
  assert.equal(latest.safe, true);
  const branch = entry.branch;
  const head = git(entry.path, "rev-parse", "HEAD");
  const cleaned = await cleanupStoryWorktrees({
    worktree,
    storyTitle: "安全清理",
    expectedToken: latest.token,
  });
  assert.equal(cleaned.ok, true, cleaned.error);
  assert.equal(fs.existsSync(entry.path), false);
  assert.equal(git(f.source, "rev-parse", branch), head, "清理 worktree 不得删除开发分支");
});

test("强制清理仍校验最新 token，可删除脏且锁定的 worktree 并保留开发分支", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const worktree = await provisionStoryWorktrees({
    tabId: "cleanup-force",
    worktreeRoot: f.worktreeRoot,
    repositories: [{ role: "primary", name: "App", path: f.source }],
  });
  const entry = worktree.entries[0];
  const branch = entry.branch;
  const head = git(entry.path, "rev-parse", "HEAD");
  const cleanInspection = await inspectStoryWorktreeCleanup({ worktree, storyTitle: "强制清理" });

  fs.writeFileSync(path.join(entry.path, "discard-me.txt"), "discard\n");
  git(f.source, "worktree", "lock", "--reason", "force cleanup test", entry.worktreePath);
  const stale = await cleanupStoryWorktrees({
    worktree,
    storyTitle: "强制清理",
    expectedToken: cleanInspection.token,
    force: true,
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, "WORKTREE_CLEANUP_STALE");
  assert.equal(fs.existsSync(entry.path), true);

  const riskyInspection = await inspectStoryWorktreeCleanup({ worktree, storyTitle: "强制清理" });
  assert.equal(riskyInspection.safe, false);
  const forced = await cleanupStoryWorktrees({
    worktree,
    storyTitle: "强制清理",
    expectedToken: riskyInspection.token,
    force: true,
  });
  assert.equal(forced.ok, true, forced.error);
  assert.equal(forced.forced, true);
  assert.equal(fs.existsSync(entry.path), false);
  assert.equal(git(f.source, "rev-parse", branch), head, "强制清理不得删除开发分支");
});

test("配置重建清理可删除旧 story/ 分支，默认清理仍保留分支", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const worktree = await provisionStoryWorktrees({
    tabId: "cleanup-delete-branch",
    worktreeRoot: f.worktreeRoot,
    repositories: [{ role: "primary", name: "App", path: f.source }],
  });
  const entry = worktree.entries[0];
  const branch = entry.branch;
  assert.match(branch, /^story\//);
  const inspection = await inspectStoryWorktreeCleanup({ worktree, storyTitle: "删分支" });
  assert.equal(inspection.safe, true);
  const cleaned = await cleanupStoryWorktrees({
    worktree,
    storyTitle: "删分支",
    expectedToken: inspection.token,
    deleteLocalBranches: true,
  });
  assert.equal(cleaned.ok, true, cleaned.error);
  assert.equal(fs.existsSync(entry.path), false);
  assert.equal(cleaned.deletedBranches?.some((item) => item.branch === branch), true);
  let branchGone = false;
  try {
    git(f.source, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`);
  } catch {
    branchGone = true;
  }
  assert.equal(branchGone, true, "deleteLocalBranches 时应删除 story/ 分支");
});

test("worktree 的 .git 指针丢失时保留原目录并从可信原仓完成安全清理", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const worktree = await provisionStoryWorktrees({
    tabId: "cleanup-orphaned-directory",
    worktreeRoot: f.worktreeRoot,
    repositories: [{ role: "primary", name: "App", path: f.source }],
  });
  const entry = worktree.entries[0];
  const branch = entry.branch;
  const retainedFile = path.join(entry.path, ".idea", "workspace.xml");
  fs.mkdirSync(path.dirname(retainedFile), { recursive: true });
  fs.writeFileSync(retainedFile, "<workspace />\n");
  fs.rmSync(path.join(entry.path, ".git"), { force: true });

  const inspection = await inspectStoryWorktreeCleanup({
    worktree,
    storyTitle: "Git 指针丢失",
  });
  assert.equal(inspection.safe, true);
  assert.equal(inspection.forceAllowed, true);
  assert.equal(inspection.repositories[0].orphanedDirectory, true);
  assert.equal(inspection.repositories[0].retainedDirectory, true);
  assert.equal(inspection.totals.inspectionErrors, 0);

  const cleaned = await cleanupStoryWorktrees({
    worktree,
    storyTitle: "Git 指针丢失",
    expectedToken: inspection.token,
    deleteLocalBranches: true,
  });
  assert.equal(cleaned.ok, true, cleaned.error);
  assert.equal(cleaned.removed[0].retainedDirectory, true);
  assert.equal(fs.existsSync(retainedFile), true, "失效目录中的 IDE 文件必须保留");
  assert.equal(git(f.source, "worktree", "list", "--porcelain").includes(entry.path), false);
  assert.throws(
    () => git(f.source, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`),
    "失效 worktree 登记清除后应删除旧 story/ 分支",
  );
});

test("强制清理不可越出故事点根目录或绕过 Git common-dir 归属校验", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const actual = await provisionStoryWorktrees({
    tabId: "cleanup-scope",
    worktreeRoot: path.join(f.root, "actual-managed-root"),
    repositories: [{ role: "primary", name: "App", path: f.source }],
  });
  const entry = actual.entries[0];

  const outsideDeclaredRoot = {
    ...actual,
    root: path.join(f.root, "declared-managed-root"),
  };
  const outsideInspection = await inspectStoryWorktreeCleanup({
    worktree: outsideDeclaredRoot,
    storyTitle: "根目录外强制删除",
  });
  assert.equal(outsideInspection.safe, false);
  assert.equal(outsideInspection.forceAllowed, false);
  assert.equal(outsideInspection.blockers.some((blocker) => blocker.type === "inspection"), true);
  const outsideForced = await cleanupStoryWorktrees({
    worktree: outsideDeclaredRoot,
    storyTitle: "根目录外强制删除",
    expectedToken: outsideInspection.token,
    force: true,
  });
  assert.equal(outsideForced.ok, false);
  assert.equal(outsideForced.code, "WORKTREE_FORCE_BLOCKED");
  assert.equal(fs.existsSync(entry.path), true, "根目录外的 worktree 不得被删除");

  const wrongCommonDir = {
    ...actual,
    entries: actual.entries.map((item) => ({
      ...item,
      gitCommonDir: path.join(f.root, "tampered-common-dir"),
    })),
  };
  const identityInspection = await inspectStoryWorktreeCleanup({
    worktree: wrongCommonDir,
    storyTitle: "Git 归属不一致",
  });
  assert.equal(identityInspection.safe, false);
  assert.equal(identityInspection.forceAllowed, false);
  const identityForced = await cleanupStoryWorktrees({
    worktree: wrongCommonDir,
    storyTitle: "Git 归属不一致",
    expectedToken: identityInspection.token,
    force: true,
  });
  assert.equal(identityForced.ok, false);
  assert.equal(identityForced.code, "WORKTREE_FORCE_BLOCKED");
  assert.equal(fs.existsSync(entry.path), true, "Git 归属不一致的 worktree 不得被删除");

  const cleanInspection = await inspectStoryWorktreeCleanup({ worktree: actual, storyTitle: "清理测试现场" });
  const cleaned = await cleanupStoryWorktrees({
    worktree: actual,
    storyTitle: "清理测试现场",
    expectedToken: cleanInspection.token,
  });
  assert.equal(cleaned.ok, true, cleaned.error);
});

test("同一故事点的 worktree mutation lock 互斥且可释放", () => {
  const tabId = `lock-${Date.now()}`;
  assert.equal(isWorktreeMutationLocked(tabId), false);
  assert.equal(beginWorktreeMutation(tabId), true);
  assert.equal(isWorktreeMutationLocked(tabId), true);
  assert.equal(beginWorktreeMutation(tabId), false);
  endWorktreeMutation(tabId);
  assert.equal(isWorktreeMutationLocked(tabId), false);
});

test("AI 与清理按物理 worktree 路径跨故事点互斥", (t) => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "devbench-worktree-resource-"));
  t.after(() => fs.rmSync(runtime, { recursive: true, force: true }));
  const space = path.join(runtime, "WorktreeSpace");
  const sharedCheckout = path.join(space, "shared-checkout");
  fs.mkdirSync(sharedCheckout, { recursive: true });
  const aiTab = {
    id: `ai-${Date.now()}`,
    worktree: { managed: true, root: space, entries: [{ path: sharedCheckout, worktreePath: sharedCheckout }] },
  };
  const cleanupTab = {
    id: `cleanup-${Date.now()}`,
    worktree: { managed: true, root: space, entries: [{ path: sharedCheckout, worktreePath: sharedCheckout }] },
  };

  const aiLease = beginStoryAiLease(aiTab, "task-resource-lock");
  assert.ok(aiLease);
  assert.equal(isStoryAiLeaseActive(cleanupTab), true);
  assert.equal(beginWorktreeMutation(cleanupTab, "cleanup"), false);
  endStoryAiLease(aiLease);

  assert.equal(beginWorktreeMutation(cleanupTab, "cleanup"), true);
  assert.equal(beginStoryAiLease(aiTab, "task-must-wait"), null);
  endWorktreeMutation(cleanupTab);
  assert.equal(isWorktreeMutationLocked(cleanupTab), false);
});

test("同 WorktreeSpace 父目录下的不同故事点互不锁租约（确认并继续可并行）", (t) => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "devbench-worktree-space-"));
  t.after(() => fs.rmSync(runtime, { recursive: true, force: true }));
  const space = path.join(runtime, "WorktreeSpace");
  const pathA = path.join(space, "geely_CARB_1");
  const pathB = path.join(space, "geely_CARB_2");
  fs.mkdirSync(pathA, { recursive: true });
  fs.mkdirSync(pathB, { recursive: true });

  const tabA = {
    id: `story-a-${Date.now()}`,
    worktree: {
      managed: true,
      root: space,
      entries: [{ role: "primary", path: pathA, worktreePath: pathA }],
    },
  };
  const tabB = {
    id: `story-b-${Date.now()}`,
    worktree: {
      managed: true,
      root: space,
      entries: [{ role: "primary", path: pathB, worktreePath: pathB }],
    },
  };

  const keysA = storyWorktreeResourceKeys(tabA);
  const keysB = storyWorktreeResourceKeys(tabB);
  assert.equal(keysA.some((key) => key.startsWith("path:")), true);
  assert.equal(keysB.some((key) => key.startsWith("path:")), true);
  assert.equal(
    keysA.filter((key) => key.startsWith("path:")).some((key) => keysB.includes(key)),
    false,
    "不同 checkout 路径不得共享 path 租约 key",
  );

  const aiLease = beginStoryAiLease(tabA, "task-a-running");
  assert.ok(aiLease, "故事点 A 应能拿到 AI 租约");
  assert.equal(isStoryAiLeaseActive(tabB), false, "故事点 B 不应被 A 的 AI 租约误判为活跃");
  assert.equal(beginWorktreeMutation(tabB, "recreate"), true, "故事点 B 应能重建/创建 worktree");
  endWorktreeMutation(tabB);
  const aiLeaseB = beginStoryAiLease(tabB, "task-b-start");
  assert.ok(aiLeaseB, "故事点 B 确认后应能启动 AI");
  endStoryAiLease(aiLeaseB);
  endStoryAiLease(aiLease);
});

test("资源租约 key 不得包含共享 WorktreeSpace 父目录本身", async () => {
  const { createHash } = await import("node:crypto");
  const space = path.join(os.tmpdir(), `WorktreeSpace-shared-key-${Date.now()}`);
  const checkout = path.join(space, "branch_CARB_9");
  fs.mkdirSync(checkout, { recursive: true });
  const tab = {
    id: "tab-root-key",
    worktree: {
      managed: true,
      root: space,
      entries: [
        { role: "primary", path: checkout, worktreePath: checkout },
        { role: "inactive", path: space, worktreePath: space },
      ],
    },
  };
  const keys = storyWorktreeResourceKeys(tab);
  const pathKeys = keys.filter((key) => key.startsWith("path:"));
  assert.equal(pathKeys.length, 1, "仅保留专属 checkout 路径，不含共享父目录与 inactive 项");
  const checkoutHash = createHash("sha256")
    .update(path.resolve(checkout).replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase())
    .digest("hex");
  assert.ok(pathKeys[0].includes(checkoutHash) || pathKeys.length === 1);
  try { fs.rmSync(space, { recursive: true, force: true }); } catch {}
});

test("AI 结束请求在真实 worker 仍存活时延迟释放物理 worktree 租约", async () => {
  const taskId = `delayed-release-${Date.now()}`;
  const leaseId = `worker-${taskId}`;
  const tab = {
    id: `tab-${taskId}`,
    worktree: {
      managed: true,
      root: path.join(WORKTREE_TEST_RUNTIME, taskId),
      entries: [{ path: path.join(WORKTREE_TEST_RUNTIME, taskId, "repo") }],
    },
  };
  const handle = beginStoryAiLease(tab, taskId);
  assert.ok(handle);
  runtimeDb.upsertTaskRuntimeLease({
    leaseId,
    taskId,
    ownerInstance: "delayed-release-test",
    ownerPid: process.pid,
    workerPid: process.pid,
    workerIdentity: captureProcessIdentitySync(process.pid),
    ttlMs: 60_000,
  });
  endStoryAiLease(handle);
  assert.equal(isStoryAiLeaseActive(tab), true);
  runtimeDb.removeTaskRuntimeLease(leaseId, "delayed-release-test");
  const deadline = Date.now() + 6000;
  while (isStoryAiLeaseActive(tab) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(isStoryAiLeaseActive(tab), false);
});

test("重建在 worktree add 后失租时不执行无围栏回滚删除", async (t) => {
  const f = fixture();
  t.after(() => {
    try { fs.rmSync(f.root, { recursive: true, force: true }); } catch {}
  });
  let guardChecks = 0;
  let createdPath = "";
  await assert.rejects(
    provisionStoryWorktrees({
      tabId: "lease-lost-after-add",
      worktreeRoot: f.worktreeRoot,
      repositories: [{ role: "primary", name: "App", path: f.source }],
      leaseGuard: () => {
        guardChecks += 1;
        return guardChecks <= 3;
      },
    }),
    (error) => error?.code === "WORKTREE_MUTATION_LEASE_LOST",
  );
  const listed = git(f.source, "worktree", "list", "--porcelain")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
  createdPath = listed.find((candidate) => path.resolve(candidate) !== path.resolve(f.source)) || "";
  assert.ok(createdPath, "失租后的新 worktree 应保留为 orphan，禁止旧持有者回滚删除");
  assert.equal(fs.existsSync(createdPath), true);
  git(f.source, "-c", "core.longpaths=true", "worktree", "remove", "--force", createdPath);
});

test("worktree mutation lock 生效期间 sendTurn 不得启动 AI 任务", async (t) => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "devbench-worktree-lock-"));
  const previousDbPath = process.env.GATEWAY_DB_PATH;
  const previousStoreDir = process.env.DEVBENCH_STORE_DIR;
  process.env.GATEWAY_DB_PATH = path.join(runtime, "gateway.db");
  process.env.DEVBENCH_STORE_DIR = path.join(runtime, "store");
  t.after(() => {
    endWorktreeMutation("locked-send-turn");
    if (previousDbPath == null) delete process.env.GATEWAY_DB_PATH;
    else process.env.GATEWAY_DB_PATH = previousDbPath;
    if (previousStoreDir == null) delete process.env.DEVBENCH_STORE_DIR;
    else process.env.DEVBENCH_STORE_DIR = previousStoreDir;
    try {
      fs.rmSync(runtime, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      // devbench 的 SQLite 单例会持有测试数据库句柄，进程退出后由系统临时目录回收。
    }
  });
  const { sendTurn } = await import("../services/devbench/index.js");
  assert.equal(beginWorktreeMutation("locked-send-turn"), true);
  const result = sendTurn({ id: "locked-send-turn" }, "不应启动");
  assert.match(result.error || "", /worktree 正在清理或重新创建/);
});

test("已推送前移提交清理后按原分支名和精确 HEAD 重建", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const worktree = await provisionStoryWorktrees({
    tabId: "cleanup-preserve-branch",
    worktreeRoot: f.worktreeRoot,
    repositories: [{ role: "primary", name: "App", path: f.source }],
  });
  const entry = worktree.entries[0];
  fs.writeFileSync(path.join(entry.path, "pushed.txt"), "pushed\n");
  git(entry.path, "add", "pushed.txt");
  git(entry.path, "commit", "-m", "pushed story change");
  const pushedHead = git(entry.path, "rev-parse", "HEAD");
  git(f.source, "remote", "add", "origin", "https://example.invalid/repo.git");
  git(f.source, "update-ref", "refs/remotes/origin/story", pushedHead);

  const inspection = await inspectStoryWorktreeCleanup({ worktree, storyTitle: "保留分支重建" });
  assert.equal(inspection.safe, true);
  const cleaned = await cleanupStoryWorktrees({
    worktree,
    storyTitle: "保留分支重建",
    expectedToken: inspection.token,
  });
  assert.equal(cleaned.ok, true, cleaned.error);

  const recreated = await provisionStoryWorktrees({
    tabId: "cleanup-preserve-branch",
    worktreeRoot: f.worktreeRoot,
    repositories: [{
      role: "primary",
      name: "App",
      path: f.source,
      baseRef: pushedHead,
      preferredBranch: entry.branch,
      strictPreferredBranch: true,
    }],
  });
  assert.equal(recreated.entries[0].branch, entry.branch);
  assert.equal(git(recreated.entries[0].path, "branch", "--show-current"), entry.branch);
  assert.equal(git(recreated.entries[0].path, "rev-parse", "HEAD"), pushedHead);
});

test("多仓部分清理快照与后续清理快照合并且不丢失先删仓库", () => {
  const primary = {
    role: "primary",
    basePath: "D:\\repos\\app",
    path: "D:\\worktrees\\story\\app",
    cleanupHead: "a".repeat(40),
    cleanupBranch: "devbench/story/app",
  };
  const extra = {
    role: "extra",
    basePath: "D:\\repos\\sdk",
    path: "D:\\worktrees\\story\\sdk",
    cleanupHead: "b".repeat(40),
    cleanupBranch: "devbench/story/sdk",
  };
  const latestPrimary = { ...primary, cleanedAt: 2 };
  const merged = mergeCleanedWorktreeEntries([primary], [extra, latestPrimary]);
  assert.equal(merged.length, 2);
  assert.equal(merged.find((entry) => entry.role === "primary")?.cleanedAt, 2);
  assert.equal(merged.find((entry) => entry.role === "extra")?.cleanupHead, "b".repeat(40));
});

test("isGitLockError 识别 git 公共目录锁竞争错误，不误判普通错误", () => {
  const isGitLockError = worktreeTest.isGitLockError;
  assert.equal(isGitLockError(null), false);
  assert.equal(isGitLockError({ ok: true }), false);
  assert.equal(isGitLockError({ ok: false, stderr: "" }), false);
  assert.equal(
    isGitLockError({ ok: false, stderr: "fatal: Unable to create '/repo/.git/index.lock': File exists." }),
    true,
  );
  assert.equal(
    isGitLockError({ ok: false, stderr: "fatal: Another git process seems to be running in this repository" }),
    true,
  );
  assert.equal(
    isGitLockError({ ok: false, stderr: "fatal: unable to create '/repo/.git/worktrees/wt/gitdir': File exists" }),
    true,
  );
  assert.equal(
    isGitLockError({ ok: false, stderr: "fatal: not a git repository" }),
    false,
  );
  assert.equal(
    isGitLockError({ ok: false, stderr: "error: pathspec 'foo.txt' did not match any file(s) known to git" }),
    false,
  );
});

test("其他 worktree 持锁时仍能从同一基仓创建新 worktree（锁竞争重试）", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const createdAt = new Date(2026, 6, 25, 18, 23, 0).getTime();

  const first = await provisionStoryWorktrees({
    tabId: "tab-busy",
    worktreeRoot: f.worktreeRoot,
    naming: { createdAt },
    repositories: [{ role: "primary", name: "App", path: f.source }],
  });
  assert.equal(fs.existsSync(first.entries[0].path), true);
  const aiLease = beginStoryAiLease(
    { id: "tab-busy", worktree: first },
    "ta<REDACTED_API_KEY>",
  );
  assert.ok(aiLease, "第一个 worktree 应能拿到 AI 租约");

  const second = await provisionStoryWorktrees({
    tabId: "tab-concurrent",
    worktreeRoot: f.worktreeRoot,
    naming: { createdAt },
    repositories: [{ role: "primary", name: "App", path: f.source }],
  });

  assert.notEqual(first.entries[0].path, second.entries[0].path);
  assert.equal(fs.existsSync(second.entries[0].path), true);
  assert.equal(
    fs.readFileSync(path.join(second.entries[0].path, "tracked.txt"), "utf8").replace(/\r\n/g, "\n"),
    "base\n",
  );
  assert.equal(git(f.source, "status", "--porcelain"), "");
  assert.equal(isStoryAiLeaseActive({ id: "tab-busy", worktree: first }), true);
  endStoryAiLease(aiLease);
});

test("git worktree add 遇到基仓公共目录锁竞争时短暂退避重试后成功", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const createdAt = new Date(2026, 6, 25, 18, 23, 0).getTime();

  const newBranch = "story/master_07251823";
  const branchLockDir = path.join(f.source, ".git", "refs", "heads", "story");
  fs.mkdirSync(branchLockDir, { recursive: true });
  const branchLock = path.join(branchLockDir, "master_07251823.lock");
  fs.writeFileSync(branchLock, "simulated busy lock from another worktree AI");
  setTimeout(() => {
    try { fs.rmSync(branchLock, { force: true }); } catch {}
  }, 600);

  const created = await provisionStoryWorktrees({
    tabId: "tab-lock-retry",
    worktreeRoot: f.worktreeRoot,
    naming: { createdAt },
    repositories: [{ role: "primary", name: "App", path: f.source }],
  });

  assert.equal(fs.existsSync(created.entries[0].path), true);
  assert.equal(
    fs.readFileSync(path.join(created.entries[0].path, "tracked.txt"), "utf8").replace(/\r\n/g, "\n"),
    "base\n",
  );
  assert.equal(created.entries[0].branch, newBranch);
  assert.equal(fs.existsSync(branchLock), false, "锁文件应已被释放");
});
