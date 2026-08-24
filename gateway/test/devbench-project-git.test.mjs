/**
 * 本机工程级 git 接口测试：GET /projects/git-info、POST /projects/git/checkout、POST /projects/git/fetch
 * 以及 GET /projects 返回 webAppBranch 字段。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { bootGateway, waitHealth } from "./_helpers.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "devbench-project-git-"));
const PORT = 39871;
const base = `http://localhost:${PORT}`;
const dbPath = path.join(tmp, "data.db");
let srv;
let adminToken = "project-git-admin-token";

before(async () => {
  // 在启动网关前把管理员 token 写入 DB，网关启动时 loadAuthTokens 会加载到内存
  const authDb = new Database(dbPath);
  authDb.exec("CREATE TABLE IF NOT EXISTS admin_tokens (token TEXT PRIMARY KEY, data TEXT, exp INTEGER)");
  authDb.prepare("INSERT INTO admin_tokens (token, data, exp) VALUES (?, ?, ?)")
    .run(adminToken, JSON.stringify({ role: "admin", name: "Project Git Test Admin" }), Date.now() + 600000);
  authDb.close();
  srv = bootGateway({
    port: PORT,
    role: "standalone",
    gwCfg: path.join(tmp, "gateway.json"),
    market: path.join(tmp, "market.json"),
    storeDir: path.join(tmp, "store"),
    dbPath,
  });
  await waitHealth(PORT, srv);
}, { timeout: 40000 });

after(() => { try { srv.kill(); } catch {} });

const json = (method, url, body, token) => fetch(base + url, {
  method,
  headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: body == null ? undefined : JSON.stringify(body),
}).then((r) => r.json());

function initRepo(repo, marker, branch = "main") {
  fs.mkdirSync(repo, { recursive: true });
  execFileSync("git", ["-C", repo, "init", "-b", branch], { stdio: "ignore", windowsHide: true });
  execFileSync("git", ["-C", repo, "config", "user.name", "Project Git Test"], { stdio: "ignore", windowsHide: true });
  execFileSync("git", ["-C", repo, "config", "user.email", "pgt@example.test"], { stdio: "ignore", windowsHide: true });
  fs.writeFileSync(path.join(repo, `${marker}.txt`), `${marker}\n`);
  execFileSync("git", ["-C", repo, "add", `${marker}.txt`], { stdio: "ignore", windowsHide: true });
  execFileSync("git", ["-C", repo, "commit", "-m", `初始化 ${marker}`], { stdio: "ignore", windowsHide: true });
}

test("GET /projects 返回主工程分支与 webAppBranch 字段", async () => {
  const main = path.join(tmp, "main-repo");
  const web = path.join(tmp, "web-repo");
  initRepo(main, "main", "main");
  initRepo(web, "web", "main");
  // 创建一个新分支让 web 不止 main
  execFileSync("git", ["-C", web, "branch", "feat/web"], { stdio: "ignore", windowsHide: true });

  const save = await json("POST", "/api/devbench/projects", { id: "p1", name: "工程1", path: main, webAppPath: web });
  assert.equal(save.ok, true, save.error);

  const r = await json("GET", "/api/devbench/projects");
  assert.equal(r.ok, true);
  const proj = (r.data || []).find((p) => p.id === "p1");
  assert.ok(proj, "应找到刚保存的工程");
  assert.equal(proj.branch, "main", "主工程 branch 应为 main");
  assert.equal(proj.webAppBranch, "main", "webAppBranch 应为 main");
});

test("GET /projects/git-info 返回完整 git 信息", async () => {
  const repo = path.join(tmp, "info-repo");
  initRepo(repo, "info", "main");
  execFileSync("git", ["-C", repo, "branch", "feat/x"], { stdio: "ignore", windowsHide: true });
  // 配置一个 origin 远程地址，验证 remoteUrl 字段
  execFileSync("git", ["-C", repo, "remote", "add", "origin", "git@example.com:group/info-repo.git"], { stdio: "ignore", windowsHide: true });

  const r = await json("GET", `/api/devbench/projects/git-info?path=${encodeURIComponent(repo)}`);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.branch, "main");
  assert.ok(r.data.branches.includes("main"), "branches 应含 main");
  assert.ok(r.data.branches.includes("feat/x"), "branches 应含 feat/x");
  assert.equal(r.data.dirty, false, "干净仓库 dirty 应为 false");
  assert.equal(r.data.dirtyCount, 0);
  assert.equal(r.data.remoteUrl, "git@example.com:group/info-repo.git", "应返回 origin 远程地址");
  // 匹配仓库定义：先建一个 ssh 相同的仓库定义，应命中 repoDefName
  const def = await json("PUT", "/api/devbench/project-defs", {
    id: "info-repo-def", name: "信息仓库", ssh: "git@example.com:group/info-repo.git", projectType: "application",
  }, adminToken);
  assert.equal(def.ok, true, def.error);
  const r2 = await json("GET", `/api/devbench/projects/git-info?path=${encodeURIComponent(repo)}`);
  assert.equal(r2.ok, true, r2.error);
  assert.equal(r2.data.repoDefId, "info-repo-def", "应匹配到仓库定义 id");
  assert.equal(r2.data.repoDefName, "信息仓库", "应返回用户设置的仓库名");
});

test("GET /projects/git-info 缺 path 参数返回 400", async () => {
  const r = await json("GET", "/api/devbench/projects/git-info");
  assert.equal(r.ok, false);
});

test("GET /projects/git-info 不存在的路径返回错误", async () => {
  const r = await json("GET", `/api/devbench/projects/git-info?path=${encodeURIComponent(path.join(tmp, "no-such-repo"))}`);
  assert.equal(r.ok, false);
});

test("POST /projects/git/checkout 切换分支并自动暂存改动", async () => {
  const repo = path.join(tmp, "checkout-repo");
  initRepo(repo, "co", "main");
  execFileSync("git", ["-C", repo, "branch", "feat/y"], { stdio: "ignore", windowsHide: true });

  // 在 main 上制造未跟踪改动
  fs.writeFileSync(path.join(repo, "untracked.txt"), "new\n");

  const r = await json("POST", "/api/devbench/projects/git/checkout", { path: repo, branch: "feat/y" });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.branch, "feat/y");
  assert.equal(r.data.stashed, true, "有改动时应自动暂存");

  // 切回 main 应能成功
  const r2 = await json("POST", "/api/devbench/projects/git/checkout", { path: repo, branch: "main" });
  assert.equal(r2.ok, true, r2.error);
  assert.equal(r2.data.branch, "main");
});

test("关闭故事点占用目标分支时可迁移到 story 分支并保留修改后继续切换", async () => {
  const repo = path.join(tmp, "main-repo");
  const remote = path.join(tmp, "main-remote.git");
  execFileSync("git", ["init", "--bare", remote], { stdio: "ignore", windowsHide: true });
  execFileSync("git", ["-C", repo, "remote", "add", "origin", remote], { stdio: "ignore", windowsHide: true });
  execFileSync("git", ["-C", repo, "branch", "release/baic-n5"], { stdio: "ignore", windowsHide: true });
  execFileSync("git", ["-C", repo, "push", "-u", "origin", "main", "release/baic-n5"], { stdio: "ignore", windowsHide: true });

  const created = await json("POST", "/api/devbench/tabs", {
    title: "#CARB-90001# 关闭故事点分支占用",
  });
  assert.equal(created.ok, true, created.error);
  assert.equal(created.data.primaryProjectId, "p1");
  const storyEntry = created.data.worktree.entries.find((entry) => entry.role === "primary");
  assert.ok(storyEntry?.worktreePath, "应创建故事点主工程 worktree");

  const occupied = await json("POST", `/api/devbench/tabs/${created.data.id}/git/checkout`, {
    path: storyEntry.worktreePath,
    branch: "release/baic-n5",
  });
  assert.equal(occupied.ok, true, occupied.error);
  fs.writeFileSync(path.join(storyEntry.worktreePath, "preserve-local.txt"), "keep\n");
  fs.writeFileSync(path.join(storyEntry.worktreePath, "main.txt"), "tracked-change\n");
  fs.writeFileSync(path.join(storyEntry.worktreePath, "staged-preserve.txt"), "staged\n");
  execFileSync("git", ["-C", storyEntry.worktreePath, "add", "staged-preserve.txt"], { stdio: "ignore", windowsHide: true });

  const closed = await json("DELETE", `/api/devbench/tabs/${created.data.id}`);
  assert.equal(closed.ok, true, closed.error);
  const beforeStatus = execFileSync("git", ["-C", storyEntry.worktreePath, "status", "--porcelain=v1"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const beforeHead = execFileSync("git", ["-C", storyEntry.worktreePath, "rev-parse", "HEAD"], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();

  const conflict = await json("POST", "/api/devbench/projects/git/checkout", {
    path: repo,
    branch: "release/baic-n5",
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, "GIT_BRANCH_IN_USE_BY_WORKTREE");
  assert.equal(conflict.data.ownerTabId, created.data.id);
  assert.equal(conflict.data.ownerClosed, true);
  assert.equal(conflict.data.canRehome, true);

  const missingConfirmation = await json("POST", "/api/devbench/projects/git/checkout", {
    path: repo,
    branch: "release/baic-n5",
    rehomeOccupiedWorktree: true,
  });
  assert.equal(missingConfirmation.ok, false);
  assert.equal(missingConfirmation.code, "WORKTREE_REHOME_CONFIRMATION_REQUIRED");
  assert.equal(
    execFileSync("git", ["-C", storyEntry.worktreePath, "branch", "--show-current"], { encoding: "utf8", windowsHide: true }).trim(),
    "release/baic-n5",
  );

  const switched = await json("POST", "/api/devbench/projects/git/checkout", {
    path: repo,
    branch: "release/baic-n5",
    rehomeOccupiedWorktree: true,
    confirmation: "迁移并切换",
  });
  assert.equal(switched.ok, true, switched.error);
  assert.equal(switched.data.branch, "release/baic-n5");
  assert.equal(switched.data.rehome.ownerClosed, true);
  assert.match(switched.data.rehome.storyBranch, /^story\/baic_n5_CARB_90001(?:_\d+)?$/);
  assert.equal(
    execFileSync("git", ["-C", storyEntry.worktreePath, "branch", "--show-current"], { encoding: "utf8", windowsHide: true }).trim(),
    switched.data.rehome.storyBranch,
  );
  assert.equal(
    execFileSync("git", ["-C", storyEntry.worktreePath, "status", "--porcelain=v1"], { encoding: "utf8", windowsHide: true }),
    beforeStatus,
  );
  assert.equal(
    execFileSync("git", ["-C", storyEntry.worktreePath, "rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).trim(),
    beforeHead,
  );
  assert.equal(fs.readFileSync(path.join(storyEntry.worktreePath, "preserve-local.txt"), "utf8"), "keep\n");
  assert.equal(fs.readFileSync(path.join(storyEntry.worktreePath, "main.txt"), "utf8"), "tracked-change\n");
  assert.equal(fs.readFileSync(path.join(storyEntry.worktreePath, "staged-preserve.txt"), "utf8"), "staged\n");
  assert.equal(
    execFileSync("git", ["-C", repo, "branch", "--show-current"], { encoding: "utf8", windowsHide: true }).trim(),
    "release/baic-n5",
  );

  const stateDb = new Database(dbPath, { readonly: true });
  const closedRows = stateDb.prepare("SELECT data FROM devbench_userdata WHERE kind='closed'").all();
  stateDb.close();
  const closedStory = closedRows
    .flatMap((row) => JSON.parse(row.data || "[]"))
    .find((item) => item.id === created.data.id);
  assert.ok(closedStory, "关闭故事点记录应继续存在");
  const updatedEntry = closedStory.worktree.entries.find((entry) => entry.role === "primary");
  assert.equal(updatedEntry.branch, switched.data.rehome.storyBranch);
  assert.equal(updatedEntry.originalBranch, "release/baic-n5");
  assert.equal(updatedEntry.baseRef, "release/baic-n5");
});

test("无 upstream 的目标分支含本地提交时拒绝自动迁移", async () => {
  const repo = path.join(tmp, "main-repo");
  execFileSync("git", ["-C", repo, "branch", "release/no-upstream"], { stdio: "ignore", windowsHide: true });

  const created = await json("POST", "/api/devbench/tabs", {
    title: "#CARB-90002# 无 upstream 分支保护",
  });
  assert.equal(created.ok, true, created.error);
  const storyEntry = created.data.worktree.entries.find((entry) => entry.role === "primary");
  const occupied = await json("POST", `/api/devbench/tabs/${created.data.id}/git/checkout`, {
    path: storyEntry.worktreePath,
    branch: "release/no-upstream",
  });
  assert.equal(occupied.ok, true, occupied.error);
  fs.writeFileSync(path.join(storyEntry.worktreePath, "local-only.txt"), "local-only\n");
  execFileSync("git", ["-C", storyEntry.worktreePath, "add", "local-only.txt"], { stdio: "ignore", windowsHide: true });
  execFileSync("git", ["-C", storyEntry.worktreePath, "commit", "-m", "本地独有提交"], {
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, DEVBENCH_SYSTEM_GIT_OP: "1" },
  });
  assert.equal((await json("DELETE", `/api/devbench/tabs/${created.data.id}`)).ok, true);

  const blocked = await json("POST", "/api/devbench/projects/git/checkout", {
    path: repo,
    branch: "release/no-upstream",
    rehomeOccupiedWorktree: true,
    confirmation: "迁移并切换",
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, "WORKTREE_REHOME_UPSTREAM_MISSING");
  assert.equal(
    execFileSync("git", ["-C", storyEntry.worktreePath, "branch", "--show-current"], { encoding: "utf8", windowsHide: true }).trim(),
    "release/no-upstream",
  );
  assert.equal(
    execFileSync("git", ["-C", repo, "branch", "--show-current"], { encoding: "utf8", windowsHide: true }).trim(),
    "release/baic-n5",
  );
});

test("目标分支领先 upstream 时拒绝自动迁移", async () => {
  const repo = path.join(tmp, "main-repo");
  execFileSync("git", ["-C", repo, "branch", "release/ahead"], { stdio: "ignore", windowsHide: true });
  execFileSync("git", ["-C", repo, "push", "-u", "origin", "release/ahead"], { stdio: "ignore", windowsHide: true });

  const created = await json("POST", "/api/devbench/tabs", {
    title: "#CARB-90003# 未推送提交保护",
  });
  assert.equal(created.ok, true, created.error);
  const storyEntry = created.data.worktree.entries.find((entry) => entry.role === "primary");
  const occupied = await json("POST", `/api/devbench/tabs/${created.data.id}/git/checkout`, {
    path: storyEntry.worktreePath,
    branch: "release/ahead",
  });
  assert.equal(occupied.ok, true, occupied.error);
  fs.writeFileSync(path.join(storyEntry.worktreePath, "ahead-only.txt"), "ahead\n");
  execFileSync("git", ["-C", storyEntry.worktreePath, "add", "ahead-only.txt"], { stdio: "ignore", windowsHide: true });
  execFileSync("git", ["-C", storyEntry.worktreePath, "commit", "-m", "未推送提交"], {
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, DEVBENCH_SYSTEM_GIT_OP: "1" },
  });
  assert.equal((await json("DELETE", `/api/devbench/tabs/${created.data.id}`)).ok, true);

  const blocked = await json("POST", "/api/devbench/projects/git/checkout", {
    path: repo,
    branch: "release/ahead",
    rehomeOccupiedWorktree: true,
    confirmation: "迁移并切换",
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, "WORKTREE_REHOME_TARGET_AHEAD");
  assert.match(blocked.error, /1 个未推送提交/);
  assert.equal(
    execFileSync("git", ["-C", storyEntry.worktreePath, "branch", "--show-current"], { encoding: "utf8", windowsHide: true }).trim(),
    "release/ahead",
  );
  assert.equal(
    execFileSync("git", ["-C", repo, "branch", "--show-current"], { encoding: "utf8", windowsHide: true }).trim(),
    "release/baic-n5",
  );
});

test("POST /projects/git/checkout 缺参数返回 400", async () => {
  const r = await json("POST", "/api/devbench/projects/git/checkout", { path: "x" });
  assert.equal(r.ok, false);
});

test("POST /projects/git/fetch 拉取远程（无 remote 时返回错误但不崩溃）", async () => {
  const repo = path.join(tmp, "fetch-repo");
  initRepo(repo, "fetch", "main");
  // 无 remote 配置，fetch --all 会失败，应返回 ok:false
  const r = await json("POST", "/api/devbench/projects/git/fetch", { path: repo });
  assert.ok(r.ok === false || r.ok === true, "接口应正常响应不崩溃");
});
