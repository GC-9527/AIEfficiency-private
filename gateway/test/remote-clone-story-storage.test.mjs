import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "devbench-remote-clone-storage-"));
const cloneParent = path.join(tmp, "clones");
process.env.DEVBENCH_CONFIG_PATH = path.join(tmp, "market.json");
process.env.DEVBENCH_LOCAL_PROJECTS_PATH = path.join(tmp, "local", "devbench-projects.json");
process.env.DEVBENCH_STORE_DIR = path.join(tmp, "store");
process.env.GATEWAY_CONFIG_PATH = path.join(tmp, "gateway.json");
process.env.GATEWAY_DB_PATH = path.join(tmp, "gateway.db");
process.env.AIEFFICIENCY_CLONE_PARENT = cloneParent;
fs.writeFileSync(process.env.DEVBENCH_CONFIG_PATH, "{}\n", "utf8");
fs.writeFileSync(process.env.GATEWAY_CONFIG_PATH, JSON.stringify({ servers: { discovery: false, peers: [] } }), "utf8");

let store;
let runRemoteInit;
let assignRemotePullRoles;
let localizeCompletedRemoteTab;

before(async () => {
  store = await import("../services/devbench/store.js");
  ({ runRemoteInit, assignRemotePullRoles, localizeCompletedRemoteTab } = await import("../services/devbench/clone.js"));
});

function git(repositoryPath, ...args) {
  return execFileSync("git", ["-C", repositoryPath, ...args], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

test("远程克隆只创建外置 StoryDev 目录，不再污染源码工程", async () => {
  const source = path.join(tmp, "source");
  fs.mkdirSync(source, { recursive: true });
  execFileSync("git", ["init"], { cwd: source, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Devbench Test"], { cwd: source });
  execFileSync("git", ["config", "user.email", "devbench-test@example.invalid"], { cwd: source });
  fs.writeFileSync(path.join(source, ".gitignore"), "existing-rule\n", "utf8");
  fs.writeFileSync(path.join(source, "README.md"), "fixture\n", "utf8");
  execFileSync("git", ["add", ".gitignore", "README.md"], { cwd: source });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: source, stdio: "ignore" });

  assert.equal(store.upsertProjectDef({
    id: "localCloneFixture",
    name: "Local Clone Fixture",
    https: source,
    projectType: "application",
  }).ok, true);
  store.updateRemoteConfig({ cloneParent });

  let tab = store.createTab({ title: "远程克隆外置目录" });
  tab = store.updateTab(tab.id, {
    mode: "remote",
    remotePull: {
      vehicle: "testVehicle",
      tbId: "CARB-STORAGE",
      entries: [{
        projectId: "localCloneFixture",
        targetRole: "primary",
        branch: "",
        flavor: "testVehicle",
      }],
    },
  });

  const result = await runRemoteInit(tab);
  assert.equal(result.ok, true, result.error);
  const checkout = result.remoteRepos[0].path;
  assert.equal(fs.existsSync(path.join(checkout, "docs")), false, "克隆完成后不得在源码工程创建 docs/tempFiles");
  assert.equal(
    fs.readFileSync(path.join(checkout, ".gitignore"), "utf8").replace(/\r\n/g, "\n"),
    "existing-rule\n",
  );

  const persisted = store.getTab(tab.id);
  assert.equal(persisted.mode, "remote", "cache preparation must not expose the shared checkout as a writable story project");
  assert.equal(persisted.primaryProjectId, null);
  assert.equal(persisted.cloneStatus, "cloning", "done is reserved for the managed worktree commit");
  const storage = store.getStoryStoragePaths(persisted);
  assert.equal(storage.storyDevRoot, path.join(cloneParent, "AllDocs", "StoryDev"));
  assert.equal(fs.existsSync(storage.scriptsDirectory), false, "cache preparation alone must not publish story storage");
});

test("source plan v2 按仓库分支复用稳定缓存并保留角色与消费者", async () => {
  const source = path.join(tmp, "source-plan-v2");
  fs.mkdirSync(source, { recursive: true });
  git(source, "init");
  git(source, "config", "user.name", "Devbench Test");
  git(source, "config", "user.email", "devbench-test@example.invalid");
  fs.writeFileSync(path.join(source, "README.md"), "source plan v2\n", "utf8");
  git(source, "add", "README.md");
  git(source, "commit", "-m", "source plan fixture");
  git(source, "branch", "-M", "release/8678");
  for (const branch of ["release/8155", "reuse/known", "feature/concurrent"]) {
    git(source, "branch", branch);
  }

  const projectId = "sourcePlanFixture";
  assert.equal(store.upsertProjectDef({
    id: projectId,
    name: "Source Plan Fixture",
    https: source,
    projectType: "application",
  }).ok, true);
  store.updateRemoteConfig({ cloneParent });

  const knownCheckout = path.join(tmp, "known-source-plan-checkout");
  execFileSync("git", ["clone", "--branch", "reuse/known", "--single-branch", source, knownCheckout], {
    windowsHide: true,
    stdio: "ignore",
  });
  store.recordLocalCheckout(projectId, {
    path: knownCheckout,
    name: "Known Source Plan Checkout",
    branch: "reuse/known",
  });

  const consumers = [
    { vehicle: "avatr8678", appName: "应用市场", flavor: "avatr8678Prod" },
    { vehicle: "avatr8155", appName: "应用市场", flavor: "avatr8155Prod" },
  ];
  const createSourcePlanTab = (title, branch) => {
    const created = store.createTab({ title });
    return store.updateTab(created.id, {
      mode: "remote",
      remotePull: {
        sourcePlanVersion: 2,
        vehicle: "multi-vehicle",
        tbId: title,
        entries: [{
          targetId: `target-${branch}`,
          repositoryId: projectId,
          branch,
          flavor: "avatr8678Prod",
          targetRole: "primary",
          consumers,
        }],
      },
    });
  };

  assert.deepEqual(assignRemotePullRoles([
    { repositoryId: projectId, targetRole: "primary" },
    { repositoryId: "web-source", targetRole: "webapp" },
    { repositoryId: "sdk-source", targetRole: "dependency" },
  ]), ["primary", "webapp", "extra"]);

  const firstTab = createSourcePlanTab("SOURCE-V2-FIRST", "release/8678");
  const first = await runRemoteInit(firstTab);
  assert.equal(first.ok, true, first.error);
  const firstRepo = first.remoteRepos[0];
  assert.equal(firstRepo.preparationStatus, "cloned");
  assert.equal(firstRepo.source, "remote");
  assert.equal(firstRepo.role, "primary");
  assert.equal(firstRepo.targetRole, "primary");
  assert.equal(firstRepo.repositoryId, projectId);
  assert.deepEqual(firstRepo.consumers, consumers);
  assert.equal(firstRepo.path, firstRepo.targetPath);
  assert.equal(git(firstRepo.path, "symbolic-ref", "--short", "HEAD"), "release/8678");
  const localization = localizeCompletedRemoteTab(firstTab, first.remoteRepos, { force: true });
  assert.deepEqual(
    localization.flavors
      .filter((item) => path.resolve(item.path) === path.resolve(firstRepo.path))
      .map((item) => item.flavor)
      .sort(),
    ["avatr8155Prod", "avatr8678Prod"],
    "one shared source target must retain every consumer vehicle flavor",
  );
  assert.equal(store.getTab(firstTab.id).mode, "remote");
  assert.equal(store.getTab(firstTab.id).cloneStatus, "cloning");
  const firstRelative = path.relative(cloneParent, firstRepo.path).split(path.sep);
  assert.deepEqual(firstRelative.slice(0, 2), ["SourceCache", projectId]);
  assert.match(firstRelative[2], /^release_8678-[a-f\d]{16}$/);

  const second = await runRemoteInit(createSourcePlanTab("SOURCE-V2-SECOND", "release/8678"));
  assert.equal(second.ok, true, second.error);
  assert.equal(second.remoteRepos[0].path, firstRepo.path);
  assert.equal(second.remoteRepos[0].preparationStatus, "reused");
  assert.equal(second.remoteRepos[0].source, "cache");
  assert.equal(second.remoteRepos[0].reused, true);

  const otherBranch = await runRemoteInit(createSourcePlanTab("SOURCE-V2-OTHER", "release/8155"));
  assert.equal(otherBranch.ok, true, otherBranch.error);
  assert.notEqual(otherBranch.remoteRepos[0].path, firstRepo.path);
  assert.equal(git(otherBranch.remoteRepos[0].path, "symbolic-ref", "--short", "HEAD"), "release/8155");

  const fromKnown = await runRemoteInit(createSourcePlanTab("SOURCE-V2-KNOWN", "reuse/known"));
  assert.equal(fromKnown.ok, true, fromKnown.error);
  const knownRepo = fromKnown.remoteRepos[0];
  assert.equal(knownRepo.preparationStatus, "cloned");
  assert.equal(knownRepo.source, "known-checkout");
  assert.equal(path.resolve(knownRepo.candidatePath), path.resolve(knownCheckout));
  assert.notEqual(path.resolve(knownRepo.path), path.resolve(knownCheckout));
  assert.equal(path.relative(cloneParent, knownRepo.path).split(path.sep)[0], "SourceCache");
  assert.equal(path.resolve(git(knownRepo.path, "remote", "get-url", "origin")), path.resolve(source));

  const concurrentTabs = [
    createSourcePlanTab("SOURCE-V2-CONCURRENT-A", "feature/concurrent"),
    createSourcePlanTab("SOURCE-V2-CONCURRENT-B", "feature/concurrent"),
  ];
  const [concurrentA, concurrentB] = await Promise.all(concurrentTabs.map(runRemoteInit));
  assert.equal(concurrentA.ok, true, concurrentA.error);
  assert.equal(concurrentB.ok, true, concurrentB.error);
  assert.equal(concurrentA.remoteRepos[0].path, concurrentB.remoteRepos[0].path);
  assert.equal(concurrentA.remoteRepos[0].preparationStatus, "cloned");
  assert.equal(concurrentB.remoteRepos[0].preparationStatus, "cloned");

  const registered = store.getLocalCheckouts(projectId);
  for (const prepared of [firstRepo, otherBranch.remoteRepos[0], knownRepo, concurrentA.remoteRepos[0]]) {
    assert.equal(registered.some((checkout) => path.resolve(checkout.path) === path.resolve(prepared.path)), true);
  }
});
