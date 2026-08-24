import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const gatewayDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true }).trim();
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHealth(baseUrl, child) {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`隔离 Gateway 提前退出：${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("隔离 Gateway 启动超时");
}

async function api(baseUrl, method, route, body) {
  const response = await fetch(`${baseUrl}/api/devbench${route}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); }
  catch { payload = { ok: false, error: text.slice(0, 1200) }; }
  return { status: response.status, ...payload };
}

function confirmedLocalGitCommit(projectId, localRole = "primary") {
  return {
    configurationConfirmed: true,
    configuration: {
      mode: "local",
      localProjectId: projectId,
      localRole,
    },
  };
}

test("故事点 API 为同一基仓创建不同 worktree，复制配置不抢占原故事点", { timeout: 120_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devbench-worktree-routes-"));
  const source = path.join(root, "source");
  const cloneParent = path.join(root, "runtime");
  fs.mkdirSync(source);
  fs.mkdirSync(cloneParent);
  git(source, "init");
  git(source, "config", "user.name", "Devbench Test");
  git(source, "config", "user.email", "devbench@example.test");
  fs.writeFileSync(path.join(source, "tracked.txt"), "base\n");
  git(source, "add", "tracked.txt");
  git(source, "commit", "-m", "base");
  git(source, "remote", "add", "origin", "https://codeup.aliyun.com/xunihezi/AIEfficiency");
  const revision = git(source, "rev-parse", "HEAD");
  git(source, "update-ref", "refs/remotes/origin/main", revision);
  fs.writeFileSync(path.join(source, "original-dirty.txt"), "keep\n");
  const originalStatus = git(source, "status", "--porcelain");

  const market = path.join(root, "market.json");
  const localProjects = path.join(root, "local", "devbench-projects.json");
  const gatewayConfig = path.join(root, "gateway.json");
  fs.mkdirSync(path.dirname(localProjects), { recursive: true });
  fs.writeFileSync(market, "{}");
  fs.writeFileSync(localProjects, JSON.stringify({
    version: 2,
    cloneParent,
    projects: [{ id: "shared-base", name: "Shared Base", path: source, webAppPath: "" }],
  }));
  fs.writeFileSync(gatewayConfig, JSON.stringify({ role: "standalone", servers: { nodeId: "worktree-test" } }));

  const port = await freePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: gatewayDir,
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      ROLE: "standalone",
      GATEWAY_CONFIG_PATH: gatewayConfig,
      GATEWAY_DB_PATH: path.join(root, "gateway.db"),
      DEVBENCH_CONFIG_PATH: market,
      DEVBENCH_LOCAL_PROJECTS_PATH: localProjects,
      DEVBENCH_STORE_DIR: path.join(root, "store"),
      DEVBENCH_SYNC_SCOPE: `worktree-test-${Date.now()}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
    }
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl, child);

  const first = await api(baseUrl, "POST", "/tabs", { title: "#CARB-1234# worktree 并发一" });
  const second = await api(baseUrl, "POST", "/tabs", { title: "worktree 并发二" });
  assert.equal(first.ok, true, first.error);
  assert.equal(second.ok, true, second.error);
  assert.equal(first.data.worktree.managed, true);
  assert.equal(second.data.worktree.managed, true);
  let firstPath = first.data.worktree.entries.find((entry) => entry.role === "primary").path;
  let secondPath = second.data.worktree.entries.find((entry) => entry.role === "primary").path;
  assert.notEqual(firstPath, secondPath);
  assert.equal(fs.existsSync(firstPath), true);
  assert.equal(fs.existsSync(secondPath), true);
  assert.match(path.basename(firstPath), /^[A-Za-z0-9_]+$/);
  assert.match(path.basename(firstPath), /^master_CARB_1234$/, "有 TB 单号时无 Flavor 也应保留单号，避免失去故事归属");

  fs.writeFileSync(path.join(firstPath, "story-one.txt"), "one\n");
  assert.equal(fs.existsSync(path.join(secondPath, "story-one.txt")), false);
  assert.equal(fs.existsSync(path.join(source, "story-one.txt")), false);

  const sourceFlavor = await api(baseUrl, "POST", `/tabs/${first.data.id}/flavor`, {
    path: firstPath,
    flavor: "storyProd",
  });
  assert.equal(sourceFlavor.ok, true, sourceFlavor.error);
  const firstPathBeforeFlavor = firstPath;
  firstPath = sourceFlavor.data.worktree.entries.find((entry) => entry.role === "primary").path;
  assert.equal(firstPath, firstPathBeforeFlavor, "Flavor 只更新构建配置，不应破坏性重建 worktree");
  assert.equal(fs.existsSync(path.join(firstPath, "story-one.txt")), true, "切换 Flavor 必须保留未提交文件");
  assert.match(path.basename(firstPath), /^master_CARB_1234$/);
  assert.match(path.basename(firstPath), /^[A-Za-z0-9_]+$/);
  assert.match(
    sourceFlavor.data.worktree.entries.find((entry) => entry.role === "primary").branch,
    /^story\/master_CARB_1234$/,
  );
  const sourceTicketPreview = await api(baseUrl, "POST", `/tabs/${first.data.id}/ticket`, {
    url: "manual-CARB-5678",
  });
  assert.equal(sourceTicketPreview.status, 409);
  assert.equal(sourceTicketPreview.code, "WORKTREE_REBUILD_CONFIRM_REQUIRED");
  const sourceTicket = await api(baseUrl, "POST", `/tabs/${first.data.id}/ticket`, {
    url: "manual-CARB-5678",
    confirmRebuild: true,
    cleanupToken: sourceTicketPreview.data.inspection.token,
    forceCleanup: true,
    cleanupConfirmation: "强制删除",
  });
  assert.equal(sourceTicket.ok, true, sourceTicket.error);
  const firstPathBeforeTicket = firstPath;
  firstPath = sourceTicket.data.worktree.entries.find((entry) => entry.role === "primary").path;
  assert.equal(fs.existsSync(firstPathBeforeTicket), false);
  assert.match(path.basename(firstPath), /^master_CARB_5678$/);
  assert.match(
    sourceTicket.data.worktree.entries.find((entry) => entry.role === "primary").branch,
    /^story\/master_CARB_5678$/,
  );
  const copiedFromSource = await api(baseUrl, "POST", "/tabs", {
    title: "复制工程配置新故事点",
    copyFromId: first.data.id,
  });
  assert.equal(copiedFromSource.ok, true, copiedFromSource.error);
  const copiedPath = copiedFromSource.data.worktree.entries.find((entry) => entry.role === "primary").path;
  assert.match(path.basename(copiedPath), /^master_\d{8}(?:\d{2})?$/);
  assert.doesNotMatch(path.basename(copiedPath), /CARB_5678$/, "copyFromId 不得继承来源故事点的 TB 单号");
  assert.equal(copiedFromSource.data.ticketUrl || "", "");
  assert.equal(copiedFromSource.data.worktreeNaming || null, null);
  const sourceApk = await api(baseUrl, "POST", `/tabs/${first.data.id}/apk-source`, { path: firstPath });
  assert.equal(sourceApk.ok, true, sourceApk.error);
  const snapshot = await api(baseUrl, "GET", `/tabs/${first.data.id}/config-snapshot`);
  assert.equal(snapshot.ok, true, snapshot.error);
  const applied = await api(baseUrl, "POST", `/tabs/${second.data.id}/apply-config`, { snapshot: snapshot.data });
  assert.equal(applied.ok, true, applied.error);
  assert.equal(applied.data.tookOver.some((item) => /工程/.test(item)), false);
  assert.equal(applied.data.tab.primaryProjectId, "shared-base");
  const secondPathBeforeConfig = secondPath;
  secondPath = applied.data.tab.worktree.entries.find((entry) => entry.role === "primary").path;
  assert.equal(secondPath, secondPathBeforeConfig, "复制 Flavor/APK 配置不应重建同一主工程 worktree");
  assert.equal(fs.existsSync(secondPathBeforeConfig), true);
  assert.match(path.basename(secondPath), /^master_\d{8}(?:\d{2})?$/);
  assert.doesNotMatch(path.basename(secondPath), /CARB_1234$/, "复制工程配置不得继承来源故事点的 TB 单号");
  assert.deepEqual(applied.data.tab.flavors, [{ path: secondPath, flavor: "storyProd" }]);
  assert.equal(applied.data.tab.apkSourcePath, secondPath, "复制配置时 APK 来源必须映射为目标故事点 worktree");

  // Every path-taking Git endpoint must reject the original checkout. A stash
  // is prepared in the shared repository so apply/drop would cause observable
  // damage if any endpoint skipped ownership validation.
  fs.writeFileSync(path.join(source, "tracked.txt"), "stashed-change\n");
  git(source, "stash", "push", "-m", "base-protection-probe");
  const protectedBranch = git(source, "branch", "--show-current");
  const protectedStatus = git(source, "status", "--porcelain");
  const protectedContent = fs.readFileSync(path.join(source, "tracked.txt"), "utf8");
  const protectedStashes = git(source, "stash", "list");

  const rejectedCheckout = await api(baseUrl, "POST", `/tabs/${first.data.id}/git/checkout`, {
    path: source,
    branch: protectedBranch,
  });
  const rejectedStashRead = await api(
    baseUrl,
    "GET",
    `/tabs/${first.data.id}/git/stashes?path=${encodeURIComponent(source)}`,
  );
  const rejectedStashApply = await api(baseUrl, "POST", `/tabs/${first.data.id}/git/stash/apply`, {
    path: source,
    index: 0,
    pop: false,
  });
  const rejectedStashDrop = await api(baseUrl, "POST", `/tabs/${first.data.id}/git/stash/drop`, {
    path: source,
    index: 0,
  });
  const rejectedConflictResolution = await api(baseUrl, "POST", `/tabs/${first.data.id}/git/resolve-conflicts`, {
    path: source,
  });
  for (const response of [
    rejectedCheckout,
    rejectedStashRead,
    rejectedStashApply,
    rejectedStashDrop,
  ]) {
    assert.equal(response.status, 403, response.error);
    assert.equal(response.ok, false);
  }
  assert.equal(rejectedConflictResolution.status, 409, rejectedConflictResolution.error);
  assert.equal(rejectedConflictResolution.ok, false);
  assert.equal(rejectedConflictResolution.code, "STORY_BASE_REPOSITORY_PROTECTED");
  assert.match(rejectedConflictResolution.error, /基础仓库受保护/);
  assert.deepEqual(rejectedConflictResolution.repositoryPathAlert.paths, [source]);
  assert.deepEqual(rejectedConflictResolution.repositoryPathAlert.candidates, [firstPath]);
  const ownedStashes = await api(
    baseUrl,
    "GET",
    `/tabs/${first.data.id}/git/stashes?path=${encodeURIComponent(firstPath)}`,
  );
  assert.equal(ownedStashes.status, 200);
  assert.equal(ownedStashes.ok, true);
  assert.equal(git(source, "status", "--porcelain"), protectedStatus);
  assert.equal(fs.readFileSync(path.join(source, "tracked.txt"), "utf8"), protectedContent);
  assert.equal(git(source, "stash", "list"), protectedStashes);

  fs.writeFileSync(path.join(firstPath, "story-one.txt"), "one\n");
  const dirtyCleanupInspection = await api(
    baseUrl,
    "GET",
    `/tabs/${first.data.id}/worktree/cleanup-inspection`,
  );
  assert.equal(dirtyCleanupInspection.ok, true, dirtyCleanupInspection.error);
  assert.equal(dirtyCleanupInspection.data.safe, false);
  assert.equal(dirtyCleanupInspection.data.totals.dirty, 1);
  const missingTokenCleanup = await api(
    baseUrl,
    "POST",
    `/tabs/${first.data.id}/worktree/cleanup`,
    {},
  );
  assert.equal(missingTokenCleanup.status, 400);
  const blockedDirtyCleanup = await api(
    baseUrl,
    "POST",
    `/tabs/${first.data.id}/worktree/cleanup`,
    { token: dirtyCleanupInspection.data.token },
  );
  assert.equal(blockedDirtyCleanup.status, 409);
  assert.equal(blockedDirtyCleanup.code, "WORKTREE_CLEANUP_BLOCKED");
  assert.equal(fs.existsSync(firstPath), true);

  fs.rmSync(path.join(firstPath, "story-one.txt"));
  fs.writeFileSync(path.join(firstPath, "local-commit.txt"), "local\n");
  git(firstPath, "add", "local-commit.txt");
  git(firstPath, "commit", "-m", "local only");
  const unpushedCleanupInspection = await api(
    baseUrl,
    "GET",
    `/tabs/${first.data.id}/worktree/cleanup-inspection`,
  );
  assert.equal(unpushedCleanupInspection.ok, true, unpushedCleanupInspection.error);
  assert.equal(unpushedCleanupInspection.data.safe, false);
  assert.equal(unpushedCleanupInspection.data.totals.unpushed, 1);
  const missingForceConfirmation = await api(
    baseUrl,
    "POST",
    `/tabs/${first.data.id}/worktree/cleanup`,
    { token: unpushedCleanupInspection.data.token, force: true },
  );
  assert.equal(missingForceConfirmation.status, 400);
  assert.equal(missingForceConfirmation.code, "WORKTREE_FORCE_CONFIRMATION_REQUIRED");
  assert.equal(fs.existsSync(firstPath), true);
  const forcedCleanup = await api(
    baseUrl,
    "POST",
    `/tabs/${first.data.id}/worktree/cleanup`,
    {
      token: unpushedCleanupInspection.data.token,
      force: true,
      confirmation: "强制删除",
    },
  );
  assert.equal(forcedCleanup.ok, true, forcedCleanup.error);
  assert.equal(forcedCleanup.data.forced, true);
  assert.equal(forcedCleanup.data.tab.worktreeStatus, "cleaned");
  assert.equal(fs.existsSync(firstPath), false);

  fs.writeFileSync(path.join(secondPath, "pushed-story.txt"), "pushed\n");
  git(secondPath, "add", "pushed-story.txt");
  git(secondPath, "commit", "-m", "pushed story");
  const secondBranchBeforeCleanup = git(secondPath, "branch", "--show-current");
  const secondHeadBeforeCleanup = git(secondPath, "rev-parse", "HEAD");
  git(source, "update-ref", "refs/remotes/origin/second-story", secondHeadBeforeCleanup);
  const cleanCleanupInspection = await api(
    baseUrl,
    "GET",
    `/tabs/${second.data.id}/worktree/cleanup-inspection`,
  );
  assert.equal(cleanCleanupInspection.ok, true, cleanCleanupInspection.error);
  assert.equal(cleanCleanupInspection.data.safe, true);
  const cleaned = await api(
    baseUrl,
    "POST",
    `/tabs/${second.data.id}/worktree/cleanup`,
    { token: cleanCleanupInspection.data.token },
  );
  assert.equal(cleaned.ok, true, cleaned.error);
  assert.equal(cleaned.data.tab.worktreeStatus, "cleaned");
  assert.equal(cleaned.data.tab.worktree.entries.length, 0);
  assert.equal(fs.existsSync(secondPath), false);

  const blockedAfterCleanup = await api(baseUrl, "POST", `/tabs/${second.data.id}/send`, {
    content: "继续处理刚才的问题",
  });
  assert.equal(blockedAfterCleanup.status, 409, JSON.stringify(blockedAfterCleanup));
  assert.equal(blockedAfterCleanup.code, "STORY_WORKTREE_INTEGRITY_INVALID");
  assert.match(blockedAfterCleanup.error, /AI 未启动、未注入、未排队/);
  const tabsAfterCleanupSend = await api(baseUrl, "GET", "/tabs");
  const cleanedAfterSend = tabsAfterCleanupSend.data.find((tab) => tab.id === second.data.id);
  assert.equal(cleanedAfterSend.runningTaskId || null, null);
  assert.equal((cleanedAfterSend.queue || []).length, 0);

  const recreated = await api(
    baseUrl,
    "POST",
    `/tabs/${second.data.id}/worktree/recreate`,
    {},
  );
  assert.equal(recreated.ok, true, recreated.error);
  assert.equal(recreated.data.worktreeStatus, "ready");
  const recreatedPath = recreated.data.worktree.entries.find((entry) => entry.role === "primary").path;
  assert.equal(fs.existsSync(recreatedPath), true);
  assert.equal(git(recreatedPath, "rev-parse", "HEAD"), secondHeadBeforeCleanup);
  assert.equal(git(recreatedPath, "branch", "--show-current"), secondBranchBeforeCleanup);

  const preview = await api(baseUrl, "POST", "/git-commit-story/preview", {
    repositoryId: "aiEfficiency",
    revision,
    ...confirmedLocalGitCommit("shared-base"),
  });
  assert.equal(preview.ok, true, preview.error);
  assert.equal(preview.existing, false);
  assert.ok(preview.data.localSources.some((source) => source.projectId === "shared-base"));
  const unconfirmed = await api(baseUrl, "POST", "/git-commit-story", {
    repositoryId: "aiEfficiency",
    revision,
  });
  assert.equal(unconfirmed.status, 400);
  assert.equal(unconfirmed.code, "GIT_COMMIT_CONFIGURATION_CONFIRMATION_REQUIRED");
  const missingAiReview = await api(baseUrl, "POST", "/git-commit-story", {
    repositoryId: "aiEfficiency",
    revision,
    ...confirmedLocalGitCommit("shared-base"),
  });
  assert.equal(missingAiReview.status, 409);
  assert.equal(missingAiReview.code, "CONFIG_INFERENCE_REVIEW_REQUIRED");
  assert.equal(git(source, "status", "--porcelain"), originalStatus, "API 全流程不得修改原工作区文件状态");
});

test("Bundle API 创建固定兄弟 worktree、并发只读依赖并从 SQLite 与文件元数据恢复", { timeout: 180_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devbench-workspace-bundle-routes-"));
  const createRepository = (name, branch = "v202605_ui") => {
    const repository = path.join(root, name);
    fs.mkdirSync(repository, { recursive: true });
    git(repository, "init", "-b", branch);
    git(repository, "config", "user.name", "Devbench Test");
    git(repository, "config", "user.email", "devbench@example.test");
    fs.writeFileSync(path.join(repository, `${name}.txt`), `${name}\n`);
    if (name === "app-source") {
      if (process.platform === "win32") {
        fs.writeFileSync(path.join(repository, "gradlew.bat"), [
          "@echo off",
          "if /I not \"%~1\"==\"projects\" exit /b 9",
          "if not exist \"..\\AppMarketWeb\" exit /b 10",
          "echo bundle-preflight-ok",
          "exit /b 0",
          "",
        ].join("\r\n"));
      } else {
        const wrapper = path.join(repository, "gradlew");
        fs.writeFileSync(wrapper, "#!/usr/bin/env sh\n[ \"$1\" = projects ] && [ -d ../AppMarketWeb ] || exit 10\necho bundle-preflight-ok\n");
        fs.chmodSync(wrapper, 0o755);
      }
    }
    git(repository, "add", ".");
    git(repository, "commit", "-m", `初始化 ${name}`);
    return repository;
  };
  const appSource = createRepository("app-source");
  const webSource = createRepository("web-source");
  const toolSource = createRepository("tool-source", "tools-main");
  const appStatus = git(appSource, "status", "--porcelain=v1");
  const webStatus = git(webSource, "status", "--porcelain=v1");
  const toolStatus = git(toolSource, "status", "--porcelain=v1");
  const cloneParent = path.join(root, "runtime");
  const market = path.join(root, "market.json");
  const localProjects = path.join(root, "local", "devbench-projects.json");
  const gatewayConfig = path.join(root, "gateway.json");
  const databasePath = path.join(root, "gateway.db");
  const storeDirectory = path.join(root, "store");
  fs.mkdirSync(cloneParent, { recursive: true });
  fs.mkdirSync(path.dirname(localProjects), { recursive: true });
  fs.writeFileSync(market, JSON.stringify({
    projectDefs: [
      {
        id: "app-market",
        name: "应用市场",
        workspaceBundle: {
          enabled: true,
          id: "appmarket-webapp-bundle",
          buildEntryRepoId: "app-market",
          layoutPolicy: { type: "SAME_PARENT_SIBLINGS" },
          branchPolicy: { type: "SAME_LOGICAL_BRANCH", strict: true },
          members: [
            { repoId: "app-market", checkoutDirName: "AppMarket", required: true, defaultMode: "EDITABLE" },
            { repoId: "app-market-web", checkoutDirName: "AppMarketWeb", required: true, defaultMode: "READ_ONLY" },
          ],
        },
      },
      { id: "app-market-web", name: "WebApp" },
      { id: "associated-tools", name: "Associated Tools" },
    ],
  }));
  fs.writeFileSync(localProjects, JSON.stringify({
    version: 4,
    cloneParent,
    projects: [
      { id: "app-base", name: "应用市场本机源码", path: appSource },
      { id: "web-base", name: "WebApp 本机源码", path: webSource },
      { id: "tool-base", name: "关联工具本机源码", path: toolSource },
    ],
    applications: [{
      id: "appmarket-application",
      name: "应用市场",
      repositories: [
        { repositoryId: "app-market", projectIds: ["app-base"] },
        { repositoryId: "app-market-web", projectIds: ["web-base"] },
        { repositoryId: "associated-tools", projectIds: ["tool-base"] },
      ],
    }],
  }));
  fs.writeFileSync(gatewayConfig, JSON.stringify({ role: "standalone", servers: { nodeId: "workspace-bundle-test" } }));

  const children = [];
  const stop = async (child) => {
    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
  };
  const start = async () => {
    const port = await freePort();
    const child = spawn(process.execPath, ["server.js"], {
      cwd: gatewayDir,
      env: {
        ...process.env,
        NODE_ENV: "test",
        PORT: String(port),
        ROLE: "standalone",
        GATEWAY_CONFIG_PATH: gatewayConfig,
        GATEWAY_DB_PATH: databasePath,
        DEVBENCH_CONFIG_PATH: market,
        DEVBENCH_LOCAL_PROJECTS_PATH: localProjects,
        DEVBENCH_STORE_DIR: storeDirectory,
        DEVBENCH_SYNC_SCOPE: "workspace-bundle-route-test",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    children.push(child);
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForHealth(baseUrl, child);
    return { child, baseUrl };
  };
  t.after(async () => {
    for (const child of children) await stop(child);
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
  });

  const firstRuntime = await start();
  const first = await api(firstRuntime.baseUrl, "POST", "/tabs", { title: "#CARB-20001# Bundle 故事点一" });
  const second = await api(firstRuntime.baseUrl, "POST", "/tabs", { title: "#CARB-20002# Bundle 故事点二" });
  assert.equal(first.ok, true, first.error);
  assert.equal(second.ok, true, second.error);
  for (const [created, ticketId] of [[first.data, "20001"], [second.data, "20002"]]) {
    assert.equal(created.worktree.bundle.enabled, true);
    assert.equal(created.worktree.preflight.status, "PASS");
    assert.equal(created.worktree.preflight.buildValidation.status, "PASS");
    assert.equal(created.worktree.preflight.buildValidation.task, "projects");
    assert.match(created.worktree.preflight.buildValidation.output, /bundle-preflight-ok/);
    assert.match(path.basename(created.worktree.root), /^CARB-2000[12]-[a-f0-9]{8}$/);
    const entries = created.worktree.entries;
    assert.deepEqual(entries.map((entry) => path.basename(entry.worktreePath)), ["AppMarket", "AppMarketWeb"]);
    assert.equal(new Set(entries.map((entry) => path.dirname(entry.worktreePath))).size, 1);
    const editable = entries.find((entry) => entry.repositoryId === "app-market");
    assert.equal(editable.branch, `story/v202605_ui_CARB_${ticketId}`);
    assert.equal(git(editable.worktreePath, "branch", "--show-current"), `story/v202605_ui_CARB_${ticketId}`);
    assert.equal(entries.find((entry) => entry.repositoryId === "app-market-web").detached, true);
    assert.equal(entries.every((entry) => entry.logicalBranch === "v202605_ui"), true);
    assert.equal(fs.existsSync(path.join(created.worktree.root, ".aiefficiency", "workspace.json")), true);
  }
  assert.notEqual(first.data.worktree.root, second.data.worktree.root);
  const firstWebPath = first.data.worktree.entries.find((entry) => entry.repositoryId === "app-market-web").path;
  const rejectedReadOnlyCheckout = await api(firstRuntime.baseUrl, "POST", `/tabs/${first.data.id}/git/checkout`, {
    path: firstWebPath,
    branch: "v202605_ui",
  });
  assert.equal(rejectedReadOnlyCheckout.status, 409);
  assert.equal(rejectedReadOnlyCheckout.code, "WORKSPACE_BUNDLE_READ_ONLY");
  const rejectedReadOnlyUpdate = await api(firstRuntime.baseUrl, "POST", `/tabs/${first.data.id}/git/update`, { path: firstWebPath });
  assert.equal(rejectedReadOnlyUpdate.status, 409);
  assert.equal(rejectedReadOnlyUpdate.code, "WORKSPACE_BUNDLE_READ_ONLY");
  const rejectedReadOnlyPull = await api(firstRuntime.baseUrl, "POST", `/tabs/${first.data.id}/git/pull-latest`, { path: firstWebPath });
  assert.equal(rejectedReadOnlyPull.status, 409);
  assert.equal(rejectedReadOnlyPull.code, "WORKSPACE_BUNDLE_READ_ONLY");
  const rejectedReadOnlyBuild = await api(firstRuntime.baseUrl, "POST", `/tabs/${first.data.id}/build`, {
    jobs: [{ path: firstWebPath, buildTypes: ["debug"] }],
  });
  assert.equal(rejectedReadOnlyBuild.status, 409);
  assert.equal(rejectedReadOnlyBuild.code, "WORKSPACE_BUNDLE_READ_ONLY");
  const rejectedReadOnlyConflict = await api(firstRuntime.baseUrl, "POST", `/tabs/${first.data.id}/git/resolve-conflicts`, { path: firstWebPath });
  assert.equal(rejectedReadOnlyConflict.status, 409);
  assert.equal(rejectedReadOnlyConflict.code, "WORKSPACE_BUNDLE_READ_ONLY");
  const rebasePreview = await api(firstRuntime.baseUrl, "POST", `/tabs/${first.data.id}/git/rebase-preview`, {});
  assert.equal(rebasePreview.ok, true, rebasePreview.error);
  assert.equal(rebasePreview.data.length, 1);
  assert.equal(rebasePreview.data.some((entry) => entry.path === firstWebPath), false);
  const rejectedReadOnlyPr = await api(firstRuntime.baseUrl, "POST", `/tabs/${first.data.id}/git/pull-request`, { paths: [firstWebPath] });
  assert.equal(rejectedReadOnlyPr.status, 409);
  const pushPreview = await api(firstRuntime.baseUrl, "POST", `/tabs/${first.data.id}/git/push-preview`, { fetch: false });
  assert.equal(pushPreview.data.some((entry) => entry.path === firstWebPath), false);
  const firstPrimary = first.data.worktree.entries.find((entry) => entry.repositoryId === "app-market");
  const flavorChanged = await api(firstRuntime.baseUrl, "POST", `/tabs/${first.data.id}/flavor`, {
    path: firstPrimary.path,
    flavor: "geelyp162Prod",
  });
  assert.equal(flavorChanged.ok, true, flavorChanged.error);
  const flavorPrimary = flavorChanged.data.worktree.entries.find((entry) => entry.repositoryId === "app-market");
  assert.equal(flavorChanged.data.worktree.root, first.data.worktree.root);
  assert.equal(flavorPrimary.worktreePath, firstPrimary.worktreePath);
  assert.equal(flavorPrimary.branch, "story/v202605_ui_CARB_20001");
  const withAssociated = await api(firstRuntime.baseUrl, "POST", `/tabs/${first.data.id}/extra`, {
    path: toolSource,
    name: "Associated Tools",
  });
  assert.equal(withAssociated.ok, true, withAssociated.error);
  assert.equal(withAssociated.data.worktree.root, first.data.worktree.root);
  assert.equal(
    withAssociated.data.worktree.entries.find((entry) => entry.repositoryId === "app-market").worktreePath,
    firstPrimary.worktreePath,
  );
  const associated = withAssociated.data.worktree.entries.find((entry) => entry.repositoryId === "associated-tools");
  assert.equal(path.dirname(associated.worktreePath), first.data.worktree.root);
  assert.equal(path.basename(associated.worktreePath), "tool-source");
  assert.equal(associated.branch, "story/tools_main_CARB_20001");
  assert.equal(associated.logicalBranch, "tools-main");
  assert.equal(withAssociated.data.worktree.bundle.members.find((member) => member.repositoryId === "associated-tools").association, true);
  git(appSource, "branch", "story/manual_adjustment");
  const branchChanged = await api(firstRuntime.baseUrl, "POST", `/tabs/${first.data.id}/git/checkout`, {
    path: firstPrimary.worktreePath,
    branch: "story/manual_adjustment",
  });
  assert.equal(branchChanged.ok, true, branchChanged.error);
  assert.equal(branchChanged.data.branch, "story/manual_adjustment");
  assert.equal(branchChanged.data.branchSync.ok, true);
  assert.equal(git(firstPrimary.worktreePath, "branch", "--show-current"), "story/manual_adjustment");
  const afterBranchChange = await api(firstRuntime.baseUrl, "GET", "/tabs");
  const branchChangedTab = afterBranchChange.data.find((tab) => tab.id === first.data.id);
  const branchChangedPrimary = branchChangedTab.worktree.entries.find((entry) => entry.repositoryId === "app-market");
  assert.equal(branchChangedTab.worktree.root, first.data.worktree.root);
  assert.equal(branchChangedPrimary.worktreePath, firstPrimary.worktreePath);
  assert.equal(branchChangedPrimary.branch, "story/manual_adjustment");
  assert.equal(git(appSource, "status", "--porcelain=v1"), appStatus);
  assert.equal(git(webSource, "status", "--porcelain=v1"), webStatus);
  assert.equal(git(toolSource, "status", "--porcelain=v1"), toolStatus);

  const secondRoot = second.data.worktree.root;
  const cleanupInspection = await api(firstRuntime.baseUrl, "GET", `/tabs/${second.data.id}/worktree/cleanup-inspection`);
  assert.equal(cleanupInspection.ok, true, cleanupInspection.error);
  const cleanup = await api(firstRuntime.baseUrl, "POST", `/tabs/${second.data.id}/worktree/cleanup`, {
    token: cleanupInspection.data.token,
  });
  assert.equal(cleanup.ok, true, cleanup.error);
  assert.equal(fs.existsSync(secondRoot), false);

  await stop(firstRuntime.child);
  const { default: Database } = await import("better-sqlite3");
  const database = new Database(databasePath);
  const durable = database.prepare("SELECT id, story_id, status, workspace_json FROM story_workspace WHERE story_id = ?").get(first.data.id);
  assert.equal(durable.status, "READY");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM story_workspace_member WHERE workspace_id = ?").get(durable.id).count, 3);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM story_workspace WHERE story_id = ?").get(second.data.id).count, 0);
  const tabRows = database.prepare("SELECT user_key, data FROM devbench_userdata WHERE kind = 'tabs'").all();
  let stripped = false;
  for (const row of tabRows) {
    const tabs = JSON.parse(row.data || "[]");
    const target = tabs.find((tab) => tab.id === first.data.id);
    if (!target) continue;
    target.worktree = null;
    target.worktreeStatus = "ready";
    database.prepare("UPDATE devbench_userdata SET data = ?, updated_at = updated_at + 1 WHERE user_key = ? AND kind = 'tabs'")
      .run(JSON.stringify(tabs), row.user_key);
    stripped = true;
  }
  database.close();
  assert.equal(stripped, true, "测试必须先移除 tab 中的 worktree，才能证明恢复镜像生效");

  const restarted = await start();
  const tabsAfterRestart = await api(restarted.baseUrl, "GET", "/tabs");
  const recovered = tabsAfterRestart.data.find((tab) => tab.id === first.data.id);
  assert.equal(recovered.worktree.workspaceId, first.data.worktree.workspaceId);
  assert.equal(recovered.worktree.entries.length, 3);
  assert.equal(recovered.worktree.preflight.status, "PASS");
});

test("HTTP：批量查询可从独立 WebApp 工程解析且未逐条 AI 复核时拒绝创建", { timeout: 120_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devbench-git-batch-http-"));
  const mainSource = path.join(root, "main-source");
  const source = path.join(root, "source");
  const authorityRemote = path.join(root, "authority.git");
  const decoyRemote = path.join(root, "decoy.git");
  const authorityRemoteUrl = authorityRemote.replace(/\\/g, "/");
  const decoyRemoteUrl = decoyRemote.replace(/\\/g, "/");
  const cloneParent = path.join(root, "runtime");
  fs.mkdirSync(mainSource);
  fs.mkdirSync(source);
  fs.mkdirSync(authorityRemote);
  fs.mkdirSync(decoyRemote);
  fs.mkdirSync(cloneParent);
  git(authorityRemote, "init", "--bare");
  git(decoyRemote, "init", "--bare");
  git(mainSource, "init");
  git(mainSource, "config", "user.name", "Batch Main Test");
  git(mainSource, "config", "user.email", "batch-main@example.test");
  fs.writeFileSync(path.join(mainSource, "app.txt"), "main\n");
  git(mainSource, "add", "app.txt");
  git(mainSource, "commit", "-m", "主工程基线");
  git(mainSource, "remote", "add", "origin", decoyRemoteUrl);
  git(source, "init");
  git(source, "config", "user.name", "Batch Review Test");
  git(source, "config", "user.email", "batch-review@example.test");
  fs.writeFileSync(path.join(source, "first.txt"), "first\n");
  git(source, "add", "first.txt");
  git(source, "commit", "-m", "第一条评审提交");
  git(source, "branch", "-M", "master");
  const firstRevision = git(source, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(source, "second.txt"), "second\n");
  git(source, "add", "second.txt");
  git(source, "commit", "-m", "第二条评审提交");
  const secondRevision = git(source, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(source, "third.txt"), "third\n");
  git(source, "add", "third.txt");
  git(source, "commit", "-m", "并发评审提交");
  const concurrentRevision = git(source, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(source, "fourth.txt"), "fourth\n");
  git(source, "add", "fourth.txt");
  git(source, "commit", "-m", "失败回滚评审提交");
  const rollbackRevision = git(source, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(source, "first.txt"), "fixed in latest branch\n");
  git(source, "add", "first.txt");
  git(source, "commit", "-m", "后续提交修复第一条评审问题");
  const latestBranchRevision = git(source, "rev-parse", "HEAD");
  git(source, "remote", "add", "a-decoy", decoyRemoteUrl);
  git(source, "push", "a-decoy", `${firstRevision}:refs/heads/master`);
  git(source, "remote", "add", "origin", authorityRemoteUrl);
  git(source, "push", "-u", "origin", "master:refs/heads/master");
  fs.writeFileSync(path.join(source, "original-untracked.txt"), "keep\n");
  const originalStatus = git(source, "status", "--porcelain");

  const market = path.join(root, "market.json");
  const localProjects = path.join(root, "local", "devbench-projects.json");
  const gatewayConfig = path.join(root, "gateway.json");
  fs.mkdirSync(path.dirname(localProjects), { recursive: true });
  fs.writeFileSync(market, JSON.stringify({
    remotes: {
      aiEfficiency: {
        https: authorityRemoteUrl,
        ssh: authorityRemoteUrl,
      },
    },
  }));
  fs.writeFileSync(localProjects, JSON.stringify({
    version: 2,
    cloneParent,
    projects: [{
      id: "git-batch-source",
      name: "Git Batch Source",
      path: mainSource,
      webAppPath: source,
    }],
  }));
  fs.writeFileSync(gatewayConfig, JSON.stringify({
    role: "standalone",
    servers: { nodeId: "git-batch-http-test" },
  }));

  const port = await freePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: gatewayDir,
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      ROLE: "standalone",
      GATEWAY_CONFIG_PATH: gatewayConfig,
      GATEWAY_DB_PATH: path.join(root, "gateway.db"),
      DEVBENCH_CONFIG_PATH: market,
      DEVBENCH_LOCAL_PROJECTS_PATH: localProjects,
      DEVBENCH_STORE_DIR: path.join(root, "store"),
      DEVBENCH_SYNC_SCOPE: `git-batch-http-${Date.now()}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
    }
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl, child);
  const projectDefs = await api(baseUrl, "GET", "/project-defs");
  const configuredRepository = projectDefs.data?.find((item) => item.id === "aiEfficiency");
  assert.equal(
    configuredRepository?.ssh || configuredRepository?.https,
    authorityRemoteUrl,
    `隔离 Gateway 必须使用测试指定的权威仓库：${JSON.stringify(configuredRepository)}`,
  );
  const configuredProjects = await api(baseUrl, "GET", "/projects");
  const configuredWebProject = configuredProjects.data?.find((item) => path.resolve(item.path) === path.resolve(source));
  assert.ok(
    configuredProjects.data?.some((item) => path.resolve(item.path) === path.resolve(mainSource))
      && configuredWebProject,
    `隔离 Gateway 必须把旧 WebApp 子仓迁移成独立本机工程：${JSON.stringify(configuredProjects.data)}`,
  );

  const firstShort = firstRevision.slice(0, 12);
  const secondShort = secondRevision.slice(0, 12);
  const resolved = await api(baseUrl, "POST", "/git-commit-story/batch-resolve", {
    input: [
      `1. ${firstShort} 第一条提交可能影响其它 Flavor`,
      `2. ${secondShort} 第二条提交需要检查合并风险`,
      `[${firstShort}] 重复输入应自动跳过`,
    ].join("\n"),
  });
  assert.equal(resolved.status, 200, resolved.error);
  assert.equal(resolved.ok, true, resolved.error);
  assert.deepEqual(resolved.data.items.map((item) => item.status), [
    "resolved",
    "resolved",
    "duplicate",
  ]);
  assert.deepEqual(
    resolved.data.items.slice(0, 2).map((item) => item.resolution.revision),
    [firstRevision, secondRevision],
  );
  assert.equal(resolved.data.summary.repositoriesSearched, 1);

  const messageResolved = await api(baseUrl, "POST", "/git-commit-story/batch-resolve", {
    repositoryId: "aiEfficiency",
    input: "第二条评审提交",
  });
  assert.equal(messageResolved.status, 200, messageResolved.error);
  assert.equal(messageResolved.data.items[0].status, "resolved");
  assert.equal(messageResolved.data.items[0].resolution.revision, secondRevision);
  assert.equal(messageResolved.data.items[0].resolution.matchKind, "message");

  const fragmentResolved = await api(baseUrl, "POST", "/git-commit-story/batch-resolve", {
    repositoryId: "aiEfficiency",
    input: firstRevision.slice(10, 18),
  });
  assert.equal(fragmentResolved.status, 200, fragmentResolved.error);
  assert.equal(fragmentResolved.data.items[0].status, "resolved");
  assert.equal(fragmentResolved.data.items[0].resolution.revision, firstRevision);
  assert.equal(fragmentResolved.data.items[0].resolution.matchKind, "revision_fragment");

  const rejected = [];
  for (const item of resolved.data.items.filter((row) => row.status === "resolved")) {
    const response = await api(baseUrl, "POST", "/git-commit-story", {
      repositoryId: item.resolution.repositoryId,
      revision: item.resolution.revision,
      reviewHint: item.excerpt,
      ...confirmedLocalGitCommit(configuredWebProject.id, "primary"),
    });
    assert.equal(response.status, 409);
    assert.equal(response.code, "CONFIG_INFERENCE_REVIEW_REQUIRED");
    rejected.push(response);
  }
  assert.equal(rejected.length, 2);
  const tabsAfterRejectedCreate = await api(baseUrl, "GET", "/tabs");
  assert.equal(
    tabsAfterRejectedCreate.data.some((tab) => tab.reviewContext?.kind === "git_commit"),
    false,
    "批量解析结果也必须逐条经过 AI 人工复核，不能直接创建故事点",
  );
  assert.equal(git(source, "status", "--porcelain"), originalStatus, "解析和创建不得改动原工作区文件状态");
});

test("HTTP：两仓第二仓被 worktree lock 时部分清理可重试并完整重建", { timeout: 120_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devbench-worktree-partial-http-"));
  const primarySource = path.join(root, "primary-source");
  const extraSource = path.join(root, "extra-source");
  const cloneParent = path.join(root, "runtime");
  fs.mkdirSync(primarySource);
  fs.mkdirSync(extraSource);
  fs.mkdirSync(cloneParent);
  for (const [repo, file, remote] of [
    [primarySource, "primary.txt", "https://example.invalid/primary.git"],
    [extraSource, "extra.txt", "https://example.invalid/extra.git"],
  ]) {
    git(repo, "init");
    git(repo, "config", "user.name", "Devbench Test");
    git(repo, "config", "user.email", "devbench@example.test");
    fs.writeFileSync(path.join(repo, file), `${file}\n`);
    fs.writeFileSync(path.join(repo, ".gitignore"), [
      "docs/tempFiles/",
      "docs/*/archives/",
      "docs/story/*/archives/",
      "docs/*/reports/",
      "docs/story/*/reports/",
      "",
    ].join("\n"));
    git(repo, "add", file, ".gitignore");
    git(repo, "commit", "-m", "base");
    git(repo, "remote", "add", "origin", remote);
    git(repo, "update-ref", "refs/remotes/origin/main", git(repo, "rev-parse", "HEAD"));
  }
  const primaryStatusBefore = git(primarySource, "status", "--porcelain");
  const extraStatusBefore = git(extraSource, "status", "--porcelain");

  const market = path.join(root, "market.json");
  const localProjects = path.join(root, "local", "devbench-projects.json");
  const gatewayConfig = path.join(root, "gateway.json");
  fs.mkdirSync(path.dirname(localProjects), { recursive: true });
  fs.writeFileSync(market, "{}");
  fs.writeFileSync(localProjects, JSON.stringify({
    version: 2,
    cloneParent,
    projects: [
      { id: "partial-primary", name: "Partial Primary", path: primarySource, webAppPath: "" },
      { id: "partial-extra", name: "Partial Extra", path: extraSource, webAppPath: "" },
    ],
  }));
  fs.writeFileSync(gatewayConfig, JSON.stringify({
    role: "standalone",
    servers: { nodeId: "worktree-partial-http-test" },
  }));

  const port = await freePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: gatewayDir,
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      ROLE: "standalone",
      GATEWAY_CONFIG_PATH: gatewayConfig,
      GATEWAY_DB_PATH: path.join(root, "gateway.db"),
      DEVBENCH_CONFIG_PATH: market,
      DEVBENCH_LOCAL_PROJECTS_PATH: localProjects,
      DEVBENCH_STORE_DIR: path.join(root, "store"),
      DEVBENCH_SYNC_SCOPE: `worktree-partial-http-${Date.now()}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
    }
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl, child);

  const created = await api(baseUrl, "POST", "/tabs", { title: "两仓部分清理 HTTP" });
  assert.equal(created.ok, true, created.error);
  const initialPrimaryPath = created.data.worktree.entries.find((entry) => entry.role === "primary").path;
  fs.writeFileSync(path.join(initialPrimaryPath, "advanced-before-switch.txt"), "keep after switch\n");
  git(initialPrimaryPath, "add", "advanced-before-switch.txt");
  git(initialPrimaryPath, "commit", "-m", "advance before switch");
  const advancedPrimaryHead = git(initialPrimaryPath, "rev-parse", "HEAD");
  const advancedPrimaryBranch = git(initialPrimaryPath, "branch", "--show-current");
  git(primarySource, "update-ref", "refs/remotes/origin/synced-story", advancedPrimaryHead);
  git(initialPrimaryPath, "branch", "--set-upstream-to", "origin/synced-story", advancedPrimaryBranch);

  let withExtra = await api(baseUrl, "POST", `/tabs/${created.data.id}/extra`, {
    path: extraSource,
    name: "Partial Extra",
  });
  assert.equal(withExtra.ok, true, withExtra.error);
  assert.equal(
    withExtra.data.worktree.entries.find((entry) => entry.role === "primary").path,
    initialPrimaryPath,
    "增加关联工程时应原位复用主 worktree，不能创建第二份目录",
  );
  assert.equal(
    git(withExtra.data.worktree.entries.find((entry) => entry.role === "primary").path, "rev-parse", "HEAD"),
    advancedPrimaryHead,
    "增加关联工程时必须保留主 worktree 已产生的提交",
  );

  const switchedToExtraPreview = await api(baseUrl, "POST", `/tabs/${created.data.id}/primary`, {
    projectId: "partial-extra",
  });
  assert.equal(switchedToExtraPreview.status, 409);
  assert.equal(switchedToExtraPreview.code, "WORKTREE_REBUILD_CONFIRM_REQUIRED");
  const switchedToExtra = await api(baseUrl, "POST", `/tabs/${created.data.id}/primary`, {
    projectId: "partial-extra",
    confirmRebuild: true,
    cleanupToken: switchedToExtraPreview.data.inspection.token,
    forceCleanup: true,
    cleanupConfirmation: "强制删除",
  });
  assert.equal(switchedToExtra.ok, true, switchedToExtra.error);
  assert.equal(switchedToExtra.data.primaryProjectId, "partial-extra");
  assert.equal(switchedToExtra.data.worktree.entries.find((entry) => entry.role === "primary").basePath, extraSource);

  const switchedBackPreview = await api(baseUrl, "POST", `/tabs/${created.data.id}/primary`, {
    projectId: "partial-primary",
  });
  assert.equal(switchedBackPreview.status, 409);
  assert.equal(switchedBackPreview.code, "WORKTREE_REBUILD_CONFIRM_REQUIRED");
  const switchedBack = await api(baseUrl, "POST", `/tabs/${created.data.id}/primary`, {
    projectId: "partial-primary",
    confirmRebuild: true,
    cleanupToken: switchedBackPreview.data.inspection.token,
    forceCleanup: true,
    cleanupConfirmation: "强制删除",
  });
  assert.equal(switchedBack.ok, true, switchedBack.error);
  assert.equal(switchedBack.data.primaryProjectId, "partial-primary");
  const switchedBackPrimary = switchedBack.data.worktree.entries.find((entry) => entry.role === "primary");
  assert.equal(switchedBackPrimary.basePath, primarySource);
  assert.equal(switchedBack.rebuilt, true);
  assert.match(String(switchedBackPrimary.branch || ""), /^story\//);
  assert.equal(fs.existsSync(switchedBackPrimary.path), true);

  withExtra = await api(baseUrl, "POST", `/tabs/${created.data.id}/extra`, {
    path: extraSource,
    name: "Partial Extra",
  });
  assert.equal(withExtra.ok, true, withExtra.error);
  const promotedPath = withExtra.data.worktree.entries.find((entry) => entry.role === "extra").path;
  const promotedPreview = await api(baseUrl, "POST", `/tabs/${created.data.id}/swap-primary`, {
    extraPath: promotedPath,
  });
  assert.equal(promotedPreview.status, 409);
  assert.equal(promotedPreview.code, "WORKTREE_REBUILD_CONFIRM_REQUIRED");
  const promoted = await api(baseUrl, "POST", `/tabs/${created.data.id}/swap-primary`, {
    extraPath: promotedPath,
    confirmRebuild: true,
    cleanupToken: promotedPreview.data.inspection.token,
    forceCleanup: true,
    cleanupConfirmation: "强制删除",
  });
  assert.equal(promoted.ok, true, promoted.error);
  assert.equal(promoted.data.primaryProjectId, "partial-extra");
  const demotedPath = promoted.data.worktree.entries.find((entry) => (
    entry.role === "extra" && entry.baseProjectId === "partial-primary"
  )).path;
  const restoredPreview = await api(baseUrl, "POST", `/tabs/${created.data.id}/swap-primary`, {
    extraPath: demotedPath,
  });
  assert.equal(restoredPreview.status, 409);
  assert.equal(restoredPreview.code, "WORKTREE_REBUILD_CONFIRM_REQUIRED");
  const restored = await api(baseUrl, "POST", `/tabs/${created.data.id}/swap-primary`, {
    extraPath: demotedPath,
    confirmRebuild: true,
    cleanupToken: restoredPreview.data.inspection.token,
    forceCleanup: true,
    cleanupConfirmation: "强制删除",
  });
  assert.equal(restored.ok, true, restored.error);
  assert.equal(restored.data.primaryProjectId, "partial-primary");
  withExtra = restored;

  const extraBeforeRemove = withExtra.data.worktree.entries.find((entry) => entry.role === "extra");
  const removedExtra = await api(baseUrl, "DELETE", `/tabs/${created.data.id}/extra`, {
    path: extraBeforeRemove.path,
  });
  assert.equal(removedExtra.ok, true, removedExtra.error);
  assert.equal(
    removedExtra.data.worktree.entries.some((entry) => entry.role === "inactive" && entry.path === extraBeforeRemove.path),
    true,
    "移除关联工程后仍应保留 inactive worktree 元数据用于安全找回和清理",
  );
  withExtra = await api(baseUrl, "POST", `/tabs/${created.data.id}/extra`, {
    path: extraSource,
    name: "Partial Extra",
  });
  assert.equal(withExtra.ok, true, withExtra.error);
  assert.equal(
    withExtra.data.worktree.entries.find((entry) => entry.role === "extra").path,
    extraBeforeRemove.path,
    "重新添加关联工程必须找回原故事点 worktree",
  );

  const pushPreview = await api(baseUrl, "POST", `/tabs/${created.data.id}/git/push-preview`, { fetch: false });
  assert.equal(pushPreview.ok, true, pushPreview.error);
  assert.deepEqual(
    pushPreview.data.map((entry) => path.resolve(entry.path)).sort(),
    withExtra.data.worktree.entries.filter((entry) => entry.role !== "webapp").map((entry) => path.resolve(entry.path)).sort(),
    "Push 预检必须覆盖主工程和关联工程 worktree",
  );
  const expectedOwnedPaths = withExtra.data.worktree.entries
    .filter((entry) => ["primary", "extra"].includes(entry.role))
    .map((entry) => path.resolve(entry.path))
    .sort();
  const gitRepos = await api(baseUrl, "GET", `/tabs/${created.data.id}/git/repos`);
  const localChanges = await api(baseUrl, "GET", `/tabs/${created.data.id}/git/local-changes`);
  assert.equal(gitRepos.ok, true, gitRepos.error);
  assert.equal(localChanges.ok, true, localChanges.error);
  assert.deepEqual(gitRepos.data.map((entry) => path.resolve(entry.path)).sort(), expectedOwnedPaths);
  assert.deepEqual(localChanges.data.map((entry) => path.resolve(entry.path)).sort(), expectedOwnedPaths);
  assert.equal([...gitRepos.data, ...localChanges.data].some((entry) => (
    path.resolve(entry.path) === path.resolve(primarySource)
    || path.resolve(entry.path) === path.resolve(extraSource)
  )), false, "Git 概览与本地改动不得读取基仓");

  const rejectedBaseBuild = await api(baseUrl, "POST", `/tabs/${created.data.id}/build`, {
    jobs: [{ path: primarySource, clean: true, buildTypes: [] }],
  });
  assert.equal(rejectedBaseBuild.ok, false);
  const acceptedWorktreeBuild = await api(baseUrl, "POST", `/tabs/${created.data.id}/build`, {
    jobs: [{ path: expectedOwnedPaths[0], clean: true, buildTypes: [] }],
  });
  assert.equal(acceptedWorktreeBuild.ok, true, acceptedWorktreeBuild.error);
  assert.deepEqual(acceptedWorktreeBuild.jobs.map((job) => path.resolve(job.path)), [expectedOwnedPaths[0]]);

  const gitUpdate = await api(baseUrl, "POST", `/tabs/${created.data.id}/git/update`, {});
  assert.equal(gitUpdate.summary.total, 2, "主工程/关联工程各返回一个受管更新结果");
  assert.equal(gitUpdate.summary.bases, 2, "无效测试远端会在每个工程的基仓更新阶段失败");
  assert.equal(gitUpdate.summary.worktrees, 0);
  const updatedPaths = gitUpdate.data.map((entry) => path.resolve(entry.path)).sort();
  assert.deepEqual(updatedPaths, [primarySource, extraSource].map((entry) => path.resolve(entry)).sort());
  assert.deepEqual(
    gitUpdate.data.map((entry) => path.resolve(entry.basePath)).sort(),
    [primarySource, extraSource].map((entry) => path.resolve(entry)).sort(),
    "每个受管结果仍须证明对应基仓已在同一更新事务中处理",
  );
  assert.equal(gitUpdate.data.filter((entry) => entry.kind === "base").length, 2);
  assert.equal(gitUpdate.data.filter((entry) => entry.kind === "worktree").length, 0);
  const originalEntries = withExtra.data.worktree.entries.filter((entry) => entry.role !== "webapp");
  assert.equal(originalEntries.length, 2);
  const primaryEntry = originalEntries.find((entry) => entry.role === "primary");
  const extraEntry = originalEntries.find((entry) => entry.role === "extra");
  assert.ok(primaryEntry?.worktreePath);
  assert.ok(extraEntry?.worktreePath);
  assert.equal(fs.existsSync(primaryEntry.worktreePath), true);
  assert.equal(fs.existsSync(extraEntry.worktreePath), true);
  const expectedState = new Map(originalEntries.map((entry) => [
    entry.role,
    {
      branch: git(entry.worktreePath, "branch", "--show-current"),
      head: git(entry.worktreePath, "rev-parse", "HEAD"),
      basePath: entry.basePath,
    },
  ]));

  git(extraSource, "worktree", "lock", "--reason", "HTTP partial cleanup proof", extraEntry.worktreePath);
  const initialInspection = await api(
    baseUrl,
    "GET",
    `/tabs/${created.data.id}/worktree/cleanup-inspection`,
  );
  assert.equal(initialInspection.ok, true, initialInspection.error);
  assert.equal(initialInspection.data.safe, true, JSON.stringify(initialInspection.data, null, 2));
  assert.equal(initialInspection.data.totals.repositories, 2);

  const partial = await api(
    baseUrl,
    "POST",
    `/tabs/${created.data.id}/worktree/cleanup`,
    { token: initialInspection.data.token },
  );
  assert.equal(partial.status, 409);
  assert.equal(partial.ok, false);
  assert.equal(partial.code, "WORKTREE_CLEANUP_FAILED");
  assert.equal(partial.partial, true);
  assert.equal(fs.existsSync(primaryEntry.worktreePath), false, "第一仓应已删除");
  assert.equal(fs.existsSync(extraEntry.worktreePath), true, "锁定的第二仓必须保留");
  assert.equal(partial.data.tab.worktreeStatus, "cleanup_partial");
  assert.deepEqual(partial.data.tab.worktree.entries.map((entry) => entry.role), ["extra"]);
  assert.deepEqual(partial.data.tab.worktree.cleanedEntries.map((entry) => entry.role), ["primary"]);

  const listedAfterPartial = await api(baseUrl, "GET", "/tabs");
  const partialTab = listedAfterPartial.data.find((tab) => tab.id === created.data.id);
  assert.equal(partialTab.worktreeStatus, "cleanup_partial");
  assert.deepEqual(partialTab.refs.map((entry) => entry.role), ["extra"]);
  assert.equal(
    partialTab.refs.some((entry) => path.resolve(entry.path) === path.resolve(primarySource)),
    false,
    "部分清理后不得把原主工程回退为活动路径",
  );

  git(extraSource, "worktree", "unlock", extraEntry.worktreePath);
  const retryInspection = await api(
    baseUrl,
    "GET",
    `/tabs/${created.data.id}/worktree/cleanup-inspection`,
  );
  assert.equal(retryInspection.ok, true, retryInspection.error);
  assert.equal(retryInspection.data.safe, true);
  assert.equal(retryInspection.data.totals.repositories, 1);
  const completed = await api(
    baseUrl,
    "POST",
    `/tabs/${created.data.id}/worktree/cleanup`,
    { token: retryInspection.data.token },
  );
  assert.equal(completed.ok, true, completed.error);
  assert.equal(completed.data.tab.worktreeStatus, "cleaned");
  assert.equal(completed.data.tab.worktree.entries.length, 0);
  assert.deepEqual(
    completed.data.tab.worktree.cleanedEntries.map((entry) => entry.role).sort(),
    ["extra", "primary"],
  );
  assert.equal(fs.existsSync(extraEntry.worktreePath), false);

  const recreated = await api(
    baseUrl,
    "POST",
    `/tabs/${created.data.id}/worktree/recreate`,
    {},
  );
  assert.equal(recreated.ok, true, recreated.error);
  assert.equal(recreated.data.worktreeStatus, "ready");
  const rebuiltEntries = recreated.data.worktree.entries.filter((entry) => entry.role !== "webapp");
  assert.equal(rebuiltEntries.length, 2);
  for (const entry of rebuiltEntries) {
    const expected = expectedState.get(entry.role);
    assert.ok(expected, `缺少 ${entry.role} 的原状态`);
    assert.equal(path.resolve(entry.basePath), path.resolve(expected.basePath));
    assert.equal(fs.existsSync(entry.worktreePath), true);
    assert.equal(git(entry.worktreePath, "branch", "--show-current"), expected.branch);
    assert.equal(git(entry.worktreePath, "rev-parse", "HEAD"), expected.head);
  }
  assert.equal(git(primarySource, "status", "--porcelain"), primaryStatusBefore);
  assert.equal(git(extraSource, "status", "--porcelain"), extraStatusBefore);
});
