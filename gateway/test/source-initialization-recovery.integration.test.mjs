import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "source-initialization-recovery-"));
const cloneParent = path.join(runtimeRoot, "clone-parent");
process.env.NODE_ENV = "production";
process.env.GATEWAY_DB_PATH = path.join(runtimeRoot, "gateway.db");
process.env.GATEWAY_CONFIG_PATH = path.join(runtimeRoot, "gateway.json");
process.env.DEVBENCH_CONFIG_PATH = path.join(runtimeRoot, "market.json");
process.env.DEVBENCH_LOCAL_PROJECTS_PATH = path.join(runtimeRoot, "local", "devbench-projects.json");
process.env.DEVBENCH_STORE_DIR = path.join(runtimeRoot, "store");
process.env.AIEFFICIENCY_CLONE_PARENT = cloneParent;
process.env.ROLE = "standalone";

fs.mkdirSync(path.dirname(process.env.DEVBENCH_LOCAL_PROJECTS_PATH), { recursive: true });
fs.writeFileSync(process.env.GATEWAY_CONFIG_PATH, JSON.stringify({
  role: "standalone",
  servers: { nodeId: "source-recovery-test", discovery: false, peers: [] },
}), "utf8");
fs.writeFileSync(process.env.DEVBENCH_CONFIG_PATH, "{}\n", "utf8");
fs.writeFileSync(process.env.DEVBENCH_LOCAL_PROJECTS_PATH, JSON.stringify({
  version: 2,
  cloneParent,
  projects: [],
}), "utf8");

const sourceRepository = path.join(runtimeRoot, "source-repository");
fs.mkdirSync(sourceRepository, { recursive: true });
execFileSync("git", ["init", "-b", "main"], { cwd: sourceRepository, stdio: "ignore", windowsHide: true });
execFileSync("git", ["config", "user.name", "Source Recovery Test"], { cwd: sourceRepository });
execFileSync("git", ["config", "user.email", "source-recovery@example.test"], { cwd: sourceRepository });
fs.writeFileSync(path.join(sourceRepository, "README.md"), "source recovery fixture\n", "utf8");
execFileSync("git", ["add", "README.md"], { cwd: sourceRepository });
execFileSync("git", ["commit", "-m", "fixture"], { cwd: sourceRepository, stdio: "ignore" });

const store = await import("../services/devbench/store.js");
const { recoverRemoteStorySourceInitializations } = await import("../routes/devbench.js");

async function waitFor(predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

test.after(async () => {
  try {
    const { default: database } = await import("../db/sqlite.js");
    if (database?.open) database.close();
  } catch {}
  try { fs.rmSync(runtimeRoot, { recursive: true, force: true }); } catch {}
});

test("重启后接管 cloning 残留，并仅在 managed worktree 就绪后发布 done", async (t) => {
  const repositoryId = "source-recovery-project";
  const projectDefinition = store.upsertProjectDef({
    id: repositoryId,
    name: "Source Recovery Project",
    https: sourceRepository,
    projectType: "application",
  });
  assert.equal(projectDefinition.ok, true, projectDefinition.error);
  store.updateRemoteConfig({ cloneParent });

  const created = store.createTab({ title: "源码初始化崩溃恢复" });
  store.updateTab(created.id, {
    mode: "remote",
    cloneStatus: "cloning",
    cloneError: null,
    remotePull: {
      sourcePlanVersion: 2,
      vehicle: "recoveryVehicle",
      tbId: "CARB-RECOVERY",
      entries: [{
        projectId: repositoryId,
        repositoryId,
        targetId: "source-recovery-main",
        targetRole: "primary",
        branch: "main",
        flavor: "recoveryProd",
        consumers: [{ vehicle: "recoveryVehicle", appName: "应用市场", flavor: "recoveryProd" }],
      }],
    },
  });

  assert.equal(recoverRemoteStorySourceInitializations(), 1);
  assert.equal(recoverRemoteStorySourceInitializations(), 0, "同一故事点只能有一个恢复执行器");
  const preparing = store.getTab(created.id);
  assert.equal(preparing.mode, "remote");
  assert.equal(preparing.primaryProjectId, null);
  assert.ok(["queued", "cloning"].includes(preparing.cloneStatus));

  const completed = await waitFor(() => {
    const current = store.getTab(created.id);
    return ["done", "error"].includes(current?.cloneStatus) ? current : null;
  });
  assert.ok(completed, "源码恢复应在超时前结束");
  assert.equal(completed.cloneStatus, "done", completed.cloneError);
  assert.equal(completed.mode, "local");
  assert.equal(completed.worktree?.managed, true);
  assert.equal(completed.worktreeStatus, "ready");
  const primary = completed.worktree.entries.find((entry) => entry.role === "primary" && entry.active !== false);
  assert.ok(primary?.path);
  t.after(() => {
    try {
      execFileSync("git", ["-C", completed.remoteRepos[0].path, "worktree", "remove", "--force", primary.path], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {}
  });
  assert.equal(path.resolve(completed.worktree.requestedRoot), path.resolve(cloneParent, "WorktreeSpace"));
  assert.equal(
    completed.worktree.relocatedForWindowsPath || path.resolve(primary.path).startsWith(path.resolve(cloneParent, "WorktreeSpace")),
    true,
  );
  assert.match(path.relative(cloneParent, completed.remoteRepos[0].path), /^SourceCache[\\/]/);
  assert.notEqual(path.resolve(primary.path), path.resolve(completed.remoteRepos[0].path));
  assert.equal(fs.existsSync(path.join(primary.path, "README.md")), true);
  assert.equal(fs.existsSync(store.getStoryStoragePaths(completed).scriptsDirectory), true);
  assert.equal(recoverRemoteStorySourceInitializations(), 0, "已完成故事点不得重复初始化");

  const legacyCreated = store.createTab({ title: "旧版提前发布缓存恢复" });
  store.updateTab(legacyCreated.id, {
    mode: "local",
    primaryProjectId: completed.primaryProjectId,
    cloneStatus: "done",
    cloneError: null,
    remoteLocalizedAt: Date.now(),
    remoteRepos: completed.remoteRepos,
    remotePull: completed.remotePull,
    worktree: null,
    worktreeStatus: null,
  });
  assert.equal(recoverRemoteStorySourceInitializations(), 1);
  const quarantined = store.getTab(legacyCreated.id);
  assert.equal(quarantined.mode, "remote", "旧版提前发布状态必须先撤回可对话入口");
  assert.equal(quarantined.primaryProjectId, null);
  assert.ok(["queued", "cloning"].includes(quarantined.cloneStatus));

  const legacyRecovered = await waitFor(() => {
    const current = store.getTab(legacyCreated.id);
    return ["done", "error"].includes(current?.cloneStatus) ? current : null;
  });
  assert.ok(legacyRecovered);
  assert.equal(legacyRecovered.cloneStatus, "done", legacyRecovered.cloneError);
  assert.equal(legacyRecovered.worktree?.managed, true);
  const recoveredPrimary = legacyRecovered.worktree.entries.find((entry) => entry.role === "primary" && entry.active !== false);
  assert.ok(recoveredPrimary?.path);
  assert.notEqual(path.resolve(recoveredPrimary.path), path.resolve(legacyRecovered.remoteRepos[0].path));
  t.after(() => {
    try {
      execFileSync("git", [
        "-C",
        legacyRecovered.remoteRepos[0].path,
        "worktree",
        "remove",
        "--force",
        recoveredPrimary.path,
      ], { stdio: "ignore", windowsHide: true });
    } catch {}
  });
});
