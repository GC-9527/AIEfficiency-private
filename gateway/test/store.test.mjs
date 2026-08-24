/**
 * devbench store 单元测试（隔离配置）：仓库定义(派生/去重)、车型多工程映射(3代迁移/展平)、
 * 关键词映射(按项目隔离/同步/识别)、旧顶层数据迁移、克隆父路径全局。
 */
import { test, beforeEach, before } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dbstore-"));
const MARKET = path.join(tmp, "market.json");
const LOCAL_PROJECTS = path.join(tmp, "local", "devbench-projects.json");
process.env.DEVBENCH_CONFIG_PATH = MARKET;
process.env.DEVBENCH_LOCAL_PROJECTS_PATH = LOCAL_PROJECTS;
process.env.DEVBENCH_STORE_DIR = path.join(tmp, "store");
process.env.GATEWAY_CONFIG_PATH = path.join(tmp, "gw.json");
process.env.GATEWAY_DB_PATH = path.join(tmp, "data.db"); // store 现在用 DB 存任务/Tab，隔离避免污染真实库
process.env.AIEFFICIENCY_CLONE_PARENT = path.join(tmp, "default-clone-parent");
fs.writeFileSync(process.env.GATEWAY_CONFIG_PATH, JSON.stringify({ teambition: { projects: [{ id: "projA", name: "A" }, { id: "projB", name: "B" }] } }));

let store, cfg, db;
before(async () => {
  store = await import("../services/devbench/store.js");
  cfg = await import("../services/config.js");
  db = await import("../db/sqlite.js");
  cfg.updateConfig({ teambition: { ...cfg.getConfig().teambition, projects: [{ id: "projA", name: "A" }, { id: "projB", name: "B" }] } });
});
// 每例前同时清空 JSON 与 SQLite 共享态：byProject(车型/关键词/经验/共享版本)存 SQLite 且跨用例持久，
// 不清会让"旧结构迁移"类用例因 byProject 已被前序用例填充而跳过迁移(ensureMigrated 的 if(!bucket.xxx) 守卫)。
beforeEach(() => {
  fs.writeFileSync(MARKET, "{}");
  fs.rmSync(LOCAL_PROJECTS, { force: true });
  db.setUserData("__devbench_shared__", "shared", { byProject: {}, dingtalkMsgConfig: null, _sharedVersion: 1 }, "test");
});
const PID = "projA";

function removeStoryFixture(id) {
  if (store.getTab(id)) {
    const closed = store.deleteTab(id);
    assert.equal(closed.ok, true, closed.error);
  }
  const preview = store.previewClosedStoryDeletion(id);
  if (!preview.ok) return;
  const removed = store.purgeClosedStory(id, {
    confirmId: id,
    expectedClosedAt: preview.data.story.closedAt,
    deleteConversationBackups: false,
    deleteArchiveDirectory: false,
    deleteAttachments: false,
  });
  assert.equal(removed.ok, true, removed.error);
}

test("本地工程列表：旧 WebApp 关联路径迁移为独立工程，后续清空只影响本地文件", () => {
  const legacy = [{
    id: "legacy",
    name: "Legacy",
    path: "D:\\workspace\\legacy",
    webAppPath: "D:\\workspace\\legacy-webapp",
  }];
  const migrated = [
    { id: "legacy", name: "Legacy", path: "D:\\workspace\\legacy" },
    { id: "legacy-webapp", name: "Legacy WebApp", path: "D:\\workspace\\legacy-webapp" },
  ];
  const cloneParent = path.join(tmp, "legacy-clones");
  const seedText = `${JSON.stringify({ projects: legacy, cloneParent }, null, 2)}\n`;
  fs.writeFileSync(MARKET, seedText);

  assert.deepEqual(store.listProjects().map(({ exists, ...project }) => project), migrated);
  assert.deepEqual(JSON.parse(fs.readFileSync(LOCAL_PROJECTS, "utf8")).projects, migrated);
  assert.equal(JSON.parse(fs.readFileSync(LOCAL_PROJECTS, "utf8")).cloneParent, cloneParent);
  assert.deepEqual(JSON.parse(fs.readFileSync(MARKET, "utf8")).projects, legacy);
  assert.equal(store.getRemoteConfig().cloneParent, cloneParent);
  assert.equal(fs.readFileSync(MARKET, "utf8"), seedText, "迁移本机配置后不得清洗或改写只读启动种子");

  assert.deepEqual(store.clearProjects(), { ok: true, cleared: 2 });
  assert.deepEqual(store.listProjects(), []);
  assert.deepEqual(store.exportProjects().projects, []);
  assert.equal(store.exportProjects().cloneParent, cloneParent);
});

test("本机工程配置：应用可关联多个仓库且同一仓库保存多个路径并读取各自分支", () => {
  const createRepo = (folder, remote, branch) => {
    const repoPath = path.join(tmp, folder);
    fs.rmSync(repoPath, { recursive: true, force: true });
    fs.mkdirSync(path.join(repoPath, ".git"), { recursive: true });
    fs.writeFileSync(path.join(repoPath, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
    fs.writeFileSync(path.join(repoPath, ".git", "config"), `[remote "origin"]\n\turl = ${remote}\n`);
    return repoPath;
  };
  const marketRemote = "git@example.com:team/AppMarket.git";
  const webRemote = "git@example.com:team/WebApp.git";
  assert.equal(store.upsertProjectDef({ id: "appMarket", name: "应用市场", ssh: marketRemote }).ok, true);
  assert.equal(store.upsertProjectDef({ id: "webApp", name: "WebApp", ssh: webRemote }).ok, true);
  const projects = [
    { id: "market-main", name: "应用市场主目录", path: createRepo("market-main", marketRemote, "main") },
    { id: "market-feature", name: "应用市场功能目录", path: createRepo("market-feature", marketRemote, "feat/search") },
    { id: "web-main", name: "WebApp 主目录", path: createRepo("web-main", webRemote, "release/web") },
  ];
  const cloneParent = path.join(tmp, "application-layout-clones");
  fs.mkdirSync(path.dirname(LOCAL_PROJECTS), { recursive: true });
  fs.writeFileSync(LOCAL_PROJECTS, JSON.stringify({ version: 3, cloneParent, projects }, null, 2));

  const migrated = store.getProjectApplications();
  assert.equal(migrated.length, 2, "旧扁平列表应按仓库身份迁移为应用分组");
  assert.deepEqual(
    migrated.find((application) => application.repositories[0].repositoryId === "appMarket")
      ?.repositories[0].projectIds,
    ["market-main", "market-feature"],
  );
  assert.equal(store.gitBranch(projects[0].path), "main");
  assert.equal(store.gitBranch(projects[1].path), "feat/search");

  const saved = store.setProjectApplications([{
    id: "application-market",
    name: "应用市场",
    repositories: [
      { repositoryId: "appMarket", projectIds: ["market-main"] },
      { repositoryId: "appMarket", projectIds: ["market-feature"] },
      { repositoryId: "webApp", projectIds: ["web-main"] },
    ],
  }]);
  assert.equal(saved.ok, true, saved.error);
  assert.deepEqual(saved.applications[0].repositories.map((repository) => repository.repositoryId), ["appMarket", "webApp"]);
  assert.deepEqual(saved.applications[0].repositories[0].projectIds, ["market-main", "market-feature"],
    "同一应用重复选择同一仓库时必须合并路径，不能静默丢失后续路径");
  const local = JSON.parse(fs.readFileSync(LOCAL_PROJECTS, "utf8"));
  assert.equal(local.version, 4);
  assert.deepEqual(local.applications, saved.applications);
  assert.deepEqual(store.exportProjects().applications, saved.applications);
  assert.equal(Object.prototype.hasOwnProperty.call(store.getSharedBundle(), "applications"), false,
    "应用与本机路径关联不得进入团队共享配置");

  assert.equal(store.deleteProject("market-feature").ok, true);
  assert.deepEqual(store.getProjectApplications()[0].repositories[0].projectIds, ["market-main"],
    "删除本机路径后必须同步清除应用分组中的引用");
  assert.equal(store.setProjectApplications([{
    id: "broken",
    name: "未完成应用",
    repositories: [{ repositoryId: "", projectIds: ["market-main"] }],
  }]).ok, false, "未选择仓库的应用配置不能落盘");
});

test("本机工程自动分组：同一 Git remote 按唯一 defaultBranch 区分主工程与 SDK", () => {
  const createRepo = (folder, remote, branch) => {
    const repoPath = path.join(tmp, folder);
    fs.rmSync(repoPath, { recursive: true, force: true });
    fs.mkdirSync(path.join(repoPath, ".git"), { recursive: true });
    fs.writeFileSync(path.join(repoPath, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
    fs.writeFileSync(path.join(repoPath, ".git", "config"), `[remote "origin"]\n\turl = ${remote}\n`);
    return repoPath;
  };
  const sharedRemote = "git@example.com:team/AppMarket.git";
  assert.equal(store.upsertProjectDef({
    id: "appMarket",
    name: "应用市场",
    ssh: sharedRemote,
    projectType: "application",
  }).ok, true);
  assert.equal(store.upsertProjectDef({
    id: "appMarketSdk",
    name: "应用市场 SDK",
    ssh: sharedRemote,
    projectType: "sdk",
    defaultBranch: "feat/sdk-v4",
  }).ok, true);
  fs.mkdirSync(path.dirname(LOCAL_PROJECTS), { recursive: true });
  fs.writeFileSync(LOCAL_PROJECTS, JSON.stringify({
    version: 4,
    projects: [
      { id: "market", name: "AppMarket", path: createRepo("same-remote-market", sharedRemote, "release/car") },
      { id: "sdk", name: "SDK", path: createRepo("same-remote-sdk", sharedRemote, "feat/sdk-v4") },
    ],
  }, null, 2));

  const applications = store.getProjectApplications();
  const bindingFor = (projectId) => applications
    .flatMap((application) => application.repositories)
    .find((repository) => repository.projectIds.includes(projectId))?.repositoryId;
  assert.equal(bindingFor("market"), "appMarket");
  assert.equal(bindingFor("sdk"), "appMarketSdk",
    "共享 remote 时唯一 defaultBranch 命中必须优先于定义列表顺序");
});

test("本机工程已有旧分组：同远端 SDK 通过分支专属仓库别名继续可见", () => {
  const createRepo = (folder, remote, branch) => {
    const repoPath = path.join(tmp, folder);
    fs.rmSync(repoPath, { recursive: true, force: true });
    fs.mkdirSync(path.join(repoPath, ".git"), { recursive: true });
    fs.writeFileSync(path.join(repoPath, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
    fs.writeFileSync(path.join(repoPath, ".git", "config"), `[remote "origin"]\n\turl = ${remote}\n`);
    return repoPath;
  };
  const sharedRemote = "git@example.com:team/AppMarket.git";
  assert.equal(store.upsertProjectDef({
    id: "appMarket",
    name: "应用市场",
    ssh: sharedRemote,
    projectType: "application",
  }).ok, true);
  assert.equal(store.upsertProjectDef({
    id: "appMarketSdk",
    name: "应用市场 SDK",
    ssh: sharedRemote,
    projectType: "sdk",
    defaultBranch: "feat/sdk-v4",
  }).ok, true);
  fs.mkdirSync(path.dirname(LOCAL_PROJECTS), { recursive: true });
  fs.writeFileSync(LOCAL_PROJECTS, JSON.stringify({
    version: 4,
    projects: [
      { id: "sdk", name: "SDK", path: createRepo("legacy-same-remote-sdk", sharedRemote, "feat/sdk-v4") },
    ],
    applications: [{
      id: "legacy-market",
      name: "旧应用市场分组",
      repositories: [{ repositoryId: "appMarket", projectIds: ["sdk"] }],
    }],
  }, null, 2));

  const applications = store.getProjectApplications();
  const repositories = applications.flatMap((application) => application.repositories);
  assert.equal(
    repositories.some((repository) => repository.repositoryId === "appMarketSdk"
      && repository.projectIds.includes("sdk")),
    true,
    "旧配置中误归到主工程仓库的 SDK 必须通过有效别名出现在 SDK 选择器中",
  );
  assert.equal(
    JSON.parse(fs.readFileSync(LOCAL_PROJECTS, "utf8")).applications[0].repositories.length,
    1,
    "只读兼容别名不得擅自改写本机工程配置",
  );
});

test("仓库定义：故事点 Bundle 固定目录配置参与共享持久化并拒绝未知成员", () => {
  assert.equal(store.upsertProjectDef({ id: "bundle-web", name: "Bundle Web", ssh: "git@example.com:team/bundle-web.git" }).ok, true);
  const saved = store.upsertProjectDef({
    id: "bundle-app",
    name: "Bundle App",
    ssh: "git@example.com:team/bundle-app.git",
    workspaceBundle: {
      enabled: true,
      buildEntryRepositoryId: "bundle-app",
      members: [
        { repositoryId: "bundle-app", checkoutDirName: "AppMarket", mode: "EDITABLE" },
        { repositoryId: "bundle-web", checkoutDirName: "AppMarketWeb", mode: "READ_ONLY" },
      ],
    },
  });
  assert.equal(saved.ok, true, saved.error);
  assert.equal(store.getProjectDef("bundle-app").workspaceBundle.members[1].checkoutDirName, "AppMarketWeb");
  assert.equal(store.getSharedBundle().projectDefs.some((definition) => definition.id === "bundle-app"), true);

  const rejected = store.upsertProjectDef({
    id: "broken-bundle",
    name: "Broken Bundle",
    ssh: "git@example.com:team/broken-bundle.git",
    workspaceBundle: {
      enabled: true,
      buildEntryRepositoryId: "broken-bundle",
      members: [
        { repositoryId: "broken-bundle", checkoutDirName: "AppMarket" },
        { repositoryId: "missing-repository", checkoutDirName: "AppMarketWeb" },
      ],
    },
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, "WORKSPACE_BUNDLE_REPOSITORY_UNKNOWN");
});

test("故事点：新建时默认使用 Codex", () => {
  const tab = store.createTab({ title: "默认模型验证" });
  assert.equal(tab.engine, "codex");
  assert.equal(tab.reportMode, "short", "新建故事点必须默认使用简短报告模式");
  assert.equal(tab.skipTestAcceptance, false, "新建故事点默认不得跳过测试验收");
  assert.equal(store.getTab(tab.id).engine, "codex", "默认模型必须持久化，不能依赖前端回退值");
  assert.equal(store.getTab(tab.id).reportMode, "short", "默认报告模式必须按 TB 单持久化");
  assert.equal(store.getTab(tab.id).skipTestAcceptance, false, "测试验收开关必须按故事点持久化");
  store.deleteTab(tab.id, { purge: true });
  removeStoryFixture(tab.id);
});

test("Bundle 只读成员按需晋升使用工作区 CAS 且禁止改变目录拓扑", () => {
  const tab = store.createTab({ title: "#CARB-15190# Bundle 按需晋升 CAS" });
  const root = path.join(tmp, "worktree-space", "CARB-15190-test");
  const original = {
    version: 3,
    managed: true,
    operationId: "create-op",
    workspaceId: "CARB-15190-test",
    root,
    bundle: {
      enabled: true,
      id: "bundle-test",
      buildEntryRepositoryId: "app",
      members: [
        { repositoryId: "app", checkoutDirName: "AppMarket", mode: "EDITABLE" },
        { repositoryId: "web", checkoutDirName: "AppMarketWeb", mode: "READ_ONLY" },
      ],
    },
    entries: [
      { repositoryId: "app", role: "primary", worktreePath: path.join(root, "AppMarket"), path: path.join(root, "AppMarket"), branch: "story/v202605_ui_CARB_15190", baseRevision: "a".repeat(40), mode: "EDITABLE", detached: false },
      { repositoryId: "web", role: "webapp", worktreePath: path.join(root, "AppMarketWeb"), path: path.join(root, "AppMarketWeb"), branch: "", baseRevision: "b".repeat(40), mode: "READ_ONLY", detached: true },
    ],
  };
  try {
    store.updateTab(tab.id, { worktree: original });
    const promoted = {
      ...original,
      bundle: {
        ...original.bundle,
        members: original.bundle.members.map((member) => (
          member.repositoryId === "web" ? { ...member, mode: "EDITABLE" } : member
        )),
      },
      entries: original.entries.map((entry) => (
        entry.repositoryId === "web"
          ? { ...entry, branch: "story/v202605_ui_CARB_15190", mode: "EDITABLE", detached: false }
          : entry
      )),
      updatedAt: Date.now(),
    };
    const saved = store.replaceStoryWorktreeWorkspace(tab.id, { expectedWorkspace: original, workspace: promoted });
    assert.equal(saved.ok, true, saved.error);
    assert.equal(store.getTab(tab.id).worktree.entries[1].mode, "EDITABLE");

    const stale = store.replaceStoryWorktreeWorkspace(tab.id, { expectedWorkspace: original, workspace: promoted });
    assert.equal(stale.ok, false);
    assert.equal(stale.code, "WORKSPACE_STATE_CHANGED");

    const moved = {
      ...promoted,
      root: path.join(tmp, "other-root"),
      entries: promoted.entries.map((entry) => ({ ...entry, path: path.join(tmp, "other-root", path.basename(entry.path)), worktreePath: path.join(tmp, "other-root", path.basename(entry.path)) })),
    };
    const topology = store.replaceStoryWorktreeWorkspace(tab.id, { expectedWorkspace: promoted, workspace: moved });
    assert.equal(topology.ok, false);
    assert.equal(topology.code, "WORKSPACE_TOPOLOGY_CHANGED");
  } finally {
    if (store.getTab(tab.id)) store.deleteTab(tab.id, { purge: true });
    removeStoryFixture(tab.id);
  }
});

test("受管故事点主工程解析忽略失效 worktree 条目", () => {
  const resolved = store.getPrimaryProject({
    primaryProjectId: "main-project",
    worktree: {
      managed: true,
      entries: [
        { role: "primary", active: false, name: "旧主工程", path: "D:\\worktrees\\old" },
        { role: "webapp", active: false, path: "D:\\worktrees\\old-web" },
        { role: "primary", active: true, name: "当前主工程", path: "D:\\worktrees\\current" },
        { role: "webapp", active: true, path: "D:\\worktrees\\current-web" },
      ],
    },
  });
  assert.equal(resolved.path, "D:\\worktrees\\current");
  assert.equal(resolved.webAppPath, "D:\\worktrees\\current-web");
});

test("故事点持久队首只允许一个 Gateway 原子固化设备请求身份", () => {
  const tab = store.createTab({ title: `设备队首 CAS-${Date.now()}` });
  try {
    store.updateTab(tab.id, { queue: ["legacy queued message", "second"] });
    const materialized = {
      content: "legacy queued message",
      displayContent: "legacy queued message",
      messageInput: { text: "legacy queued message" },
      deviceRuntimeRequestId: "story:queue-cas:task-1",
      deviceRuntimeTaskId: "task-1",
    };
    const first = store.replaceTabQueueHeadIfUnchanged(tab.id, "legacy queued message", materialized);
    assert.equal(first.ok, true, first.error);
    assert.deepEqual(store.getTab(tab.id).queue, [materialized, "second"]);

    const staleWriter = store.replaceTabQueueHeadIfUnchanged(tab.id, "legacy queued message", {
      ...materialized,
      deviceRuntimeRequestId: "story:queue-cas:task-2",
      deviceRuntimeTaskId: "task-2",
    });
    assert.equal(staleWriter.ok, false);
    assert.equal(staleWriter.code, "STORY_QUEUE_HEAD_CHANGED");
    assert.deepEqual(store.getTab(tab.id).queue, [materialized, "second"]);

    const removed = store.replaceTabQueueHeadIfUnchanged(tab.id, materialized, null);
    assert.equal(removed.ok, true, removed.error);
    assert.deepEqual(removed.queue, ["second"]);
    assert.deepEqual(store.getTab(tab.id).queue, ["second"]);

    const staleRemoval = store.replaceTabQueueHeadIfUnchanged(tab.id, materialized, null);
    assert.equal(staleRemoval.ok, false);
    assert.equal(staleRemoval.code, "STORY_QUEUE_HEAD_CHANGED");
    assert.deepEqual(store.getTab(tab.id).queue, ["second"]);
  } finally {
    removeStoryFixture(tab.id);
  }
});

test("故事点：guarded create 原子校验进行中和已关闭的 TB/显式 URL 身份", () => {
  const tbTaskId = "64a1b2c3d4e5f60718293a4b";
  const tbUrl = `https://www.teambition.com/task/${tbTaskId}`;
  const first = store.createTabGuarded({
    title: "原子票据占用-进行中",
    ticket: { tbTaskId, ticketUrl: tbUrl, ticketBound: true, inputProvided: true },
    initialUpdates: {
      ticketUrl: tbUrl,
      ticketBound: true,
      worktreeNaming: { ticketId: "CARB-17001" },
    },
  });
  assert.equal(first.ok, true, first.error);
  assert.equal(first.tab.ticketUrl, tbUrl);
  assert.equal(Object.hasOwn(first.tab, "ticketIdentity"), false, "稳定身份 hash 不得写入 Tab");
  assert.equal(Object.hasOwn(first.tab, "ticketIdentities"), false, "稳定身份 hash 集合不得写入 Tab");

  const activeDuplicate = store.createTabGuarded({
    title: "原子票据占用-并发候选",
    ticket: { tbTaskId, ticketBound: true, inputProvided: true },
  });
  assert.equal(activeDuplicate.ok, false);
  assert.equal(activeDuplicate.code, "STORY_TICKET_TAKEN");
  assert.equal(activeDuplicate.existingStory.closed, false);

  const closed = store.deleteTab(first.tab.id);
  assert.equal(closed.ok, true, closed.error);
  const closedDuplicate = store.createTabGuarded({
    title: "原子票据占用-已关闭候选",
    ticket: { ticketUrl: tbUrl, ticketBound: true, inputProvided: true },
  });
  assert.equal(closedDuplicate.ok, false);
  assert.equal(closedDuplicate.code, "STORY_TICKET_TAKEN");
  assert.equal(closedDuplicate.existingStory.closed, true);
  removeStoryFixture(first.tab.id);

  const explicitBase = "https://tickets.example.test/work-items/atomic-17002";
  const explicit = store.createTabGuarded({
    title: "显式 URL 原子占用",
    ticket: { ticketUrl: `${explicitBase}#left`, ticketBound: true, inputProvided: true },
    initialUpdates: { ticketUrl: `${explicitBase}#left`, ticketBound: true },
  });
  assert.equal(explicit.ok, true, explicit.error);
  const equivalentUrl = store.createTabGuarded({
    title: "显式 URL 等价候选",
    ticket: { ticketUrl: `${explicitBase}#right`, ticketBound: true, inputProvided: true },
  });
  assert.equal(equivalentUrl.ok, false);
  assert.equal(equivalentUrl.code, "STORY_TICKET_TAKEN");
  removeStoryFixture(explicit.tab.id);
});

test("故事点：多个故事点可原子绑定同一设备，绑定不再承担运行时排他语义", () => {
  const left = store.createTab({ title: "设备原子占用-左" });
  const right = store.createTab({ title: "设备原子占用-右" });
  const outside = store.createTab({ title: "设备原子占用-组外" });
  const serial = "ATOMIC-DEVICE-17004";
  try {
    const first = store.updateTabDeviceBinding(left.id, {
      deviceSerial: serial,
      flavors: [{ path: "left", flavor: "prod" }],
    });
    assert.equal(first.ok, true, first.error);
    assert.equal(first.tab.deviceSerial, serial);
    assert.deepEqual(first.tab.flavors, [{ path: "left", flavor: "prod" }]);

    const idempotent = store.updateTabDeviceBinding(left.id, {
      deviceSerial: serial,
      reportMode: "expert",
    });
    assert.equal(idempotent.ok, true, idempotent.error);
    assert.equal(idempotent.tab.reportMode, "expert", "同一 Tab 重绑同 serial 必须幂等并保留其它字段更新");

    const shared = store.updateTabDeviceBinding(right.id, {
      deviceSerial: serial,
      reportMode: "expert",
    });
    assert.equal(shared.ok, true, shared.error);
    assert.equal(shared.tab.deviceSerial, serial);
    assert.equal(shared.tab.reportMode, "expert");
    assert.equal(store.getTab(left.id).deviceSerial, serial, "共享绑定不能抢走原故事点的目标设备");

    // 旧插件仍可调用历史 API，但 exceptGroupId 不再改变语义：绑定始终可共享，
    // 真正互斥由 device-runtime 的 FIFO 租约负责。
    const groupId = "device-atomic-group";
    store.updateTab(left.id, { groupId });
    store.updateTab(right.id, { groupId });
    store.updateTab(outside.id, { groupId: "outside-group" });
    const legacyShared = store.updateTabWithDeviceClaim(
      outside.id,
      { deviceSerial: serial, reportMode: "expert" },
      { exceptGroupId: groupId },
    );
    assert.equal(legacyShared.ok, true, legacyShared.error);
    assert.equal(legacyShared.tab.deviceSerial, serial);
    assert.equal(legacyShared.tab.reportMode, "expert");

    const unbound = store.updateTabDeviceBinding(right.id, {
      deviceSerial: null,
      flavors: [{ path: "right", flavor: "dev" }],
    }, { exceptGroupId: groupId });
    assert.equal(unbound.ok, true, unbound.error);
    assert.equal(unbound.tab.deviceSerial, null);
    assert.deepEqual(unbound.tab.flavors, [{ path: "right", flavor: "dev" }]);

    const missing = store.updateTabDeviceBinding("missing-device-target", { deviceSerial: serial });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.code, "STORY_DEVICE_TARGET_NOT_FOUND");
  } finally {
    for (const tab of [left, right, outside]) {
      if (store.getTab(tab.id)) store.updateTab(tab.id, { groupId: null, groupActive: false });
      removeStoryFixture(tab.id);
    }
  }
});

test("故事点：每条 AI 回答独立持久化生成时的模型与档位快照", () => {
  const tab = store.createTab({ title: "回答模型快照" });
  const first = { engine: "codex", model: "gpt-5.6-sol", tier: "max", capturedAt: 1001 };
  const second = { engine: "codex", model: "gpt-5.7-sol", tier: "high", capturedAt: 2002 };
  store.appendMessage(tab.id, { role: "assistant", content: "第一次回答", engine: "codex", aiSnapshot: first });
  store.appendMessage(tab.id, { role: "assistant", content: "第二次回答", engine: "codex", aiSnapshot: second });

  // 模拟后续动态切换：tab 当前配置变化不能改写已经落盘的回答快照。
  store.updateTab(tab.id, { engine: "gemini" });
  const messages = store.getMessages(tab.id);
  assert.deepEqual(messages.map((message) => message.aiSnapshot), [first, second]);
  assert.equal(messages[0].content, "第一次回答");
  assert.equal(messages[1].content, "第二次回答");
  removeStoryFixture(tab.id);
});

test("仓库定义：空配置回退应用、SDK、WebApp 与工具工程种子", () => {
  const defs = store.getProjectDefs();
  assert.deepEqual(defs.map((d) => d.id).sort(), ["aiEfficiency", "appMarket", "appMarketSdk", "webApp"]);
  assert.deepEqual(store.getProjectDef("appMarket").workspaceBundle.members.map((member) => (
    [member.repositoryId, member.checkoutDirName, member.mode]
  )), [
    ["appMarket", "AppMarket", "EDITABLE"],
    ["webApp", "AppMarketWeb", "READ_ONLY"],
  ]);
  assert.equal(defs.find((def) => def.id === "appMarketSdk").projectType, "sdk");
  assert.equal(defs.find((def) => def.id === "aiEfficiency").projectType, "tooling");
  const profileOps = store.getSharedBundle().sharedOps.filter((op) => op.type === "projectDef.set");
  assert.deepEqual([...new Set(profileOps.map((op) => op.value.id))].sort(), ["aiEfficiency", "appMarket", "appMarketSdk", "webApp"]);
  const latestProfile = (id) => profileOps.filter((op) => op.value?.id === id)
    .sort((left, right) => Number(left.version) - Number(right.version)).at(-1)?.value;
  assert.deepEqual(latestProfile("appMarketSdk").requiresRepositories, ["appMarket"]);
  assert.deepEqual(latestProfile("webApp").requiresRepositories, ["appMarket"]);
});

test("仓库定义：管理员显式停用新版 AppMarket Bundle 后不会被画像迁移复活", () => {
  const market = store.getProjectDef("appMarket");
  const disabled = store.upsertProjectDef({ ...market, workspaceBundle: { enabled: false } });
  assert.equal(disabled.ok, true, disabled.error);
  assert.equal(store.getProjectDef("appMarket").inferenceProfileVersion, 3);
  assert.equal(store.getProjectDef("appMarket").workspaceBundle, undefined);
});

test("仓库推理画像：旧节点高版本操作会自愈并用更高时钟同步，重复读取不再写入", () => {
  store.getProjectDefs();
  const before = store.getSharedVersion();
  const legacyVersion = before + 5000;
  const applied = store.applySharedBundle({
    version: before + 1,
    sharedOps: [
      {
        id: `legacy:${legacyVersion}:market`, node: "legacy", version: legacyVersion, at: legacyVersion,
        type: "projectDef.set",
        value: {
          id: "appMarket", name: "应用市场",
          https: "https://codeup.aliyun.com/xunihezi/AppMarket",
          ssh: "git@codeup.aliyun.com:xunihezi/AppMarket.git",
          projectType: "application", inferenceProfileVersion: 2,
          inferenceEnabled: false, inferenceKeywords: [], requiresRepositories: [], inheritVariant: [],
        },
      },
      {
        id: `legacy:${legacyVersion}:sdk`, node: "legacy", version: legacyVersion, at: legacyVersion,
        type: "projectDef.set",
        value: {
          id: "appMarketSdk", name: "应用市场SDK",
          https: "https://codeup.aliyun.com/xunihezi/AppMarket",
          ssh: "git@codeup.aliyun.com:xunihezi/AppMarket.git",
        },
      },
      {
        id: `legacy:${legacyVersion}:tooling`, node: "legacy", version: legacyVersion, at: legacyVersion,
        type: "projectDef.set",
        value: {
          id: "aiEfficiency", name: "AIEfficiency",
          https: "https://codeup.aliyun.com/xunihezi/AIEfficiency",
          ssh: "git@codeup.aliyun.com:xunihezi/AIEfficiency.git",
          projectType: "application", inferenceEnabled: false, inferenceKeywords: [],
          requiresRepositories: [], inheritVariant: [], defaultBranch: "", defaultFlavor: "",
        },
      },
    ],
  });
  assert.equal(applied.applied, true);

  const defs = store.getProjectDefs();
  const sdk = defs.find((def) => def.id === "appMarketSdk");
  const tooling = defs.find((def) => def.id === "aiEfficiency");
  const market = defs.find((def) => def.id === "appMarket");
  assert.equal(market.inferenceProfileVersion, 3);
  assert.equal(market.workspaceBundle.members[1].checkoutDirName, "AppMarketWeb");
  assert.equal(sdk.projectType, "sdk");
  assert.deepEqual(sdk.inferenceKeywords, ["语音", "voice", "tts"]);
  assert.deepEqual(sdk.requiresRepositories, ["appMarket"]);
  assert.equal(sdk.defaultBranch, "feat/202605sdkaiV4");
  assert.equal(tooling.projectType, "tooling");
  assert.equal(tooling.inferenceEnabled, true);
  assert.ok(tooling.inferenceKeywords.includes("AI训练"));

  const repaired = store.getSharedBundle();
  const marketProfile = repaired.sharedOps
    .filter((op) => op.type === "projectDef.set" && op.value?.id === "appMarket")
    .sort((a, b) => Number(a.version) - Number(b.version))
    .at(-1);
  assert.ok(marketProfile.version > legacyVersion);
  assert.equal(marketProfile.value.inferenceProfileVersion, 3);
  assert.equal(marketProfile.value.workspaceBundle.members[0].checkoutDirName, "AppMarket");
  for (const id of ["appMarketSdk", "aiEfficiency"]) {
    const latest = repaired.sharedOps
      .filter((op) => op.type === "projectDef.set" && op.value?.id === id)
      .sort((a, b) => Number(a.version) - Number(b.version))
      .at(-1);
    assert.ok(latest.version > legacyVersion, `${id} 修复操作必须赢过旧节点时钟`);
    assert.equal(latest.value.inferenceProfileVersion, 2);
  }
  const stableVersion = repaired.version;
  const stableOpCount = repaired.sharedOps.length;
  const second = store.getSharedBundle();
  assert.equal(second.version, stableVersion);
  assert.equal(second.sharedOps.length, stableOpCount);
});

test("仓库推理画像：旧全量快照不能覆盖新版画像，显式编辑与删除仍保留", () => {
  const seeded = store.getProjectDefs();
  const beforeLegacy = store.getSharedBundle();
  const profileOpCount = beforeLegacy.sharedOps.filter((op) => op.type === "projectDef.set"
    && ["appMarketSdk", "aiEfficiency"].includes(op.value?.id)).length;
  const legacyDefs = seeded.map((def) => {
    if (!["appMarketSdk", "aiEfficiency"].includes(def.id)) return def;
    return { id: def.id, name: def.name, https: def.https, ssh: def.ssh };
  });
  const legacy = store.applySharedBundle({
    version: store.getSharedVersion() + 1000,
    projectDefs: legacyDefs,
    byProject: {},
  });
  assert.equal(legacy.applied, true);
  assert.equal(store.getProjectDef("appMarketSdk").projectType, "sdk");
  assert.equal(store.getProjectDef("aiEfficiency").projectType, "tooling");
  const afterLegacy = store.getSharedBundle();
  assert.equal(
    afterLegacy.sharedOps.filter((op) => op.type === "projectDef.set"
      && ["appMarketSdk", "aiEfficiency"].includes(op.value?.id)).length,
    profileOpCount,
    "已有版本化画像操作时，旧全量快照只能触发本地修复，不能重复广播",
  );

  const tooling = store.getProjectDef("aiEfficiency");
  const edited = store.upsertProjectDef({
    ...tooling,
    projectType: "application",
    inferenceEnabled: false,
    inferenceKeywords: [],
    requiresRepositories: [],
    inheritVariant: [],
    defaultBranch: "",
    defaultFlavor: "",
  });
  assert.equal(edited.ok, true);
  assert.equal(store.getProjectDef("aiEfficiency").projectType, "application", "新版显式空配置不得被自动恢复");
  assert.equal(store.getProjectDef("aiEfficiency").inferenceProfileVersion, 2);

  store.deleteProjectDef("appMarketSdk");
  const versionAfterDelete = store.getSharedVersion();
  assert.equal(store.getProjectDef("appMarketSdk"), null, "当前 schema 下显式删除不得复活");
  store.getSharedBundle();
  assert.equal(store.getSharedVersion(), versionAfterDelete);
});

test("故事点：标题唯一(titleTaken)进行中+已关闭", () => {
  const a = store.createTab({ title: "登录优化" });
  assert.ok(store.titleTaken("登录优化"), "进行中重名命中");
  assert.equal(store.titleTaken("登录优化", a.id), null, "排除自身");
  assert.equal(store.titleTaken("不存在的"), null);
  store.deleteTab(a.id); // 无工程配置不会进 closed
});

test("故事点：docSlug TB 单保留 #单号# 前缀(便于按单号归档)", () => {
  // computeDocSlug 约定：TB 单 → "#<单号>#<标题名>"(刻意保留单号，便于按单号识别存档目录)；非 TB → 仅标题名。
  const t = store.createTab({ title: "#CARB-9# 修复闪退" });
  assert.equal(store.ensureDocSlug(t), "#CARB-9#修复闪退");
  store.deleteTab(t.id);
  const t2 = store.createTab({ title: "纯标题无单号" });
  assert.equal(store.ensureDocSlug(t2), "纯标题无单号");
  store.deleteTab(t2.id);
});

test("故事点：存档目录可显示、仅允许当前故事点 ask 子目录并可恢复默认", () => {
  const repo = fs.mkdtempSync(path.join(tmp, "repo-"));
  const up = store.upsertProject({ id: "archiveRepo", name: "ArchiveRepo", path: repo });
  assert.equal(up.ok, true);
  let tab = store.createTab({ title: "#CARB-10# 存档目录" });
  tab = store.updateTab(tab.id, {
    primaryProjectId: "archiveRepo",
    worktree: {
      version: 1,
      managed: true,
      root: repo,
      entries: [{ role: "primary", baseProjectId: "archiveRepo", name: "ArchiveRepo", basePath: repo, path: repo }],
    },
  });
  let info = store.getArchiveDirInfo(tab);
  const storyRoot = path.join(process.env.AIEFFICIENCY_CLONE_PARENT, "AllDocs", "StoryDev");
  assert.equal(info.effectiveArchiveDir, path.join(storyRoot, "#CARB-10#存档目录", "ask"));
  assert.equal(info.defaultBackupDir, info.effectiveArchiveDir);
  assert.equal(info.attachmentDir, path.join(storyRoot, "#CARB-10#存档目录", "archives"));
  assert.equal(info.reportsDir, path.join(storyRoot, "#CARB-10#存档目录", "reports"));
  assert.equal(info.tempDir, path.join(storyRoot, "#CARB-10#存档目录", "tempFiles"));
  assert.equal(fs.existsSync(info.scriptsDir), true, "默认目录不存在时应自动创建");

  const custom = path.join(info.effectiveArchiveDir, "custom");
  const changed = store.setTabArchiveDir(tab.id, custom);
  assert.equal(changed.ok, true);
  assert.equal(changed.info.effectiveArchiveDir, custom);
  assert.equal(path.dirname(changed.info.archiveFile), custom);
  assert.equal(fs.existsSync(custom), true);

  const sourceTreeDirectory = path.join(repo, "docs", "story", "unsafe-archive");
  const rejected = store.setTabArchiveDir(tab.id, sourceTreeDirectory);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, "STORY_STORAGE_LINK_UNSAFE");
  assert.match(rejected.error, /当前故事点的外置 ask 目录/);
  assert.equal(fs.existsSync(sourceTreeDirectory), false, "拒绝前不得在源码工程创建目录");
  assert.equal(store.getTab(tab.id).archiveDir, custom, "非法设置不得覆盖上一次安全目录");

  const reset = store.setTabArchiveDir(tab.id, "");
  assert.equal(reset.ok, true);
  assert.equal(reset.info.effectiveArchiveDir, path.join(storyRoot, "#CARB-10#存档目录", "ask"));
  removeStoryFixture(tab.id);
});

test("故事点：旧任意存档路径自动回退，TXT 与 JSON 均不得写入源码树", async () => {
  const repo = fs.mkdtempSync(path.join(tmp, "unsafe-archive-repo-"));
  assert.equal(store.upsertProject({ id: "unsafeArchiveRepo", name: "UnsafeArchiveRepo", path: repo }).ok, true);
  let tab = store.createTab({ title: "#CARB-10D# 存档边界" });
  tab = store.updateTab(tab.id, {
    primaryProjectId: "unsafeArchiveRepo",
    archiveDir: path.join(repo, "docs", "story", "custom"),
    archiveFile: path.join(repo, "docs", "story", "custom", "unsafe.txt"),
  });
  store.appendMessage(tab.id, { role: "user", content: "不得写回源码树", turn: 1, ts: 1000 });

  const { exportFullArchive } = await import("../services/devbench/index.js");
  const exported = exportFullArchive(store.getTab(tab.id));
  assert.equal(exported.ok, true, exported.error);
  const storage = store.getStoryStoragePaths(store.getTab(tab.id), { create: true });
  assert.equal(path.dirname(exported.file), storage.archiveDirectory);
  assert.equal(fs.existsSync(path.join(repo, "docs")), false, "旧任意路径不得被全量存档重新创建");
  assert.equal(store.getTab(tab.id).archiveDir, null);

  const unsafeBackupDir = path.join(repo, "docs", "tempFiles", "backups");
  const backup = store.createConversationBackup(tab.id, { directory: unsafeBackupDir });
  assert.equal(backup.ok, false);
  assert.equal(backup.code, "STORY_STORAGE_LINK_UNSAFE");
  assert.match(backup.error, /当前故事点的外置 ask 目录/);
  assert.equal(fs.existsSync(unsafeBackupDir), false, "非法 JSON 备份目录不得在源码工程创建");

  const safeBackup = store.createConversationBackup(tab.id, {
    directory: path.join(storage.backupDirectory, "manual"),
  });
  assert.equal(safeBackup.ok, true, safeBackup.error);
  assert.equal(path.dirname(safeBackup.file), path.join(storage.backupDirectory, "manual"));
  removeStoryFixture(tab.id);
});

test("故事点：旧 worktree 默认 TXT 存档迁移到 cloneParent 下并清除脏文件", () => {
  const repo = fs.mkdtempSync(path.join(tmp, "legacy-archive-repo-"));
  assert.equal(store.upsertProject({ id: "legacyArchiveRepo", name: "LegacyArchiveRepo", path: repo }).ok, true);
  let tab = store.createTab({ title: "#CARB-10A# 旧存档迁移" });
  tab = store.updateTab(tab.id, {
    primaryProjectId: "legacyArchiveRepo",
    worktree: {
      version: 1,
      managed: true,
      root: repo,
      entries: [{ role: "primary", baseProjectId: "legacyArchiveRepo", name: "LegacyArchiveRepo", basePath: repo, path: repo }],
    },
  });
  const slug = store.ensureDocSlug(tab);
  const legacyFile = path.join(repo, "docs", "story", slug, "ask", `${slug}.txt`);
  fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
  fs.writeFileSync(legacyFile, "旧存档内容", "utf8");
  tab = store.updateTab(tab.id, { archiveFile: legacyFile });

  const info = store.getArchiveDirInfo(tab);
  assert.equal(info.archiveFile, path.join(
    process.env.AIEFFICIENCY_CLONE_PARENT,
    "AllDocs",
    "StoryDev",
    slug,
    "ask",
    `${slug}.txt`,
  ));
  assert.equal(fs.readFileSync(info.archiveFile, "utf8"), "旧存档内容");
  assert.equal(fs.existsSync(legacyFile), false, "迁移成功后 worktree 内的旧默认存档应移除");
  assert.equal(store.getTab(tab.id).archiveFile, info.archiveFile);
  removeStoryFixture(tab.id);
});

test("故事点：外置目标已有不同内容时保留冲突副本并清除旧 worktree 存档", () => {
  const repo = fs.mkdtempSync(path.join(tmp, "legacy-archive-conflict-repo-"));
  assert.equal(store.upsertProject({ id: "legacyArchiveConflictRepo", name: "LegacyArchiveConflictRepo", path: repo }).ok, true);
  let tab = store.createTab({ title: "#CARB-10B# 旧存档冲突迁移" });
  tab = store.updateTab(tab.id, {
    primaryProjectId: "legacyArchiveConflictRepo",
    worktree: {
      version: 1,
      managed: true,
      root: repo,
      entries: [{ role: "primary", baseProjectId: "legacyArchiveConflictRepo", name: "LegacyArchiveConflictRepo", basePath: repo, path: repo }],
    },
  });
  const slug = store.ensureDocSlug(tab);
  const legacyFile = path.join(repo, "docs", "story", slug, "ask", `${slug}.txt`);
  fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
  fs.writeFileSync(legacyFile, "旧 worktree 内容", "utf8");
  const storage = store.getStoryStoragePaths(tab, { create: true });
  const targetFile = path.join(storage.archiveDirectory, `${slug}.txt`);
  fs.writeFileSync(targetFile, "现有 StoryDev 内容", "utf8");
  tab = store.updateTab(tab.id, { archiveFile: legacyFile });

  const info = store.getArchiveDirInfo(tab);
  assert.equal(info.archiveFile, targetFile);
  assert.equal(fs.readFileSync(targetFile, "utf8"), "现有 StoryDev 内容");
  assert.equal(fs.existsSync(legacyFile), false, "冲突内容备份成功后必须清除 worktree 旧档");
  assert.ok(info.archiveMigrationConflictFile);
  assert.equal(fs.readFileSync(info.archiveMigrationConflictFile, "utf8"), "旧 worktree 内容");
  assert.equal(store.getTab(tab.id).archiveMigrationConflictFile, info.archiveMigrationConflictFile);
  removeStoryFixture(tab.id);
});

test("故事点：旧存档路径祖先为目录链接时拒绝迁移且保留边界外文件", () => {
  const repo = fs.mkdtempSync(path.join(tmp, "legacy-archive-link-repo-"));
  const outsideAsk = fs.mkdtempSync(path.join(tmp, "legacy-archive-link-outside-"));
  assert.equal(store.upsertProject({ id: "legacyArchiveLinkRepo", name: "LegacyArchiveLinkRepo", path: repo }).ok, true);
  let tab = store.createTab({ title: "#CARB-10C# 旧存档链接边界" });
  tab = store.updateTab(tab.id, {
    primaryProjectId: "legacyArchiveLinkRepo",
    worktree: {
      version: 1,
      managed: true,
      root: repo,
      entries: [{ role: "primary", baseProjectId: "legacyArchiveLinkRepo", name: "LegacyArchiveLinkRepo", basePath: repo, path: repo }],
    },
  });
  const slug = store.ensureDocSlug(tab);
  const legacyAskParent = path.join(repo, "docs", "story", slug);
  fs.mkdirSync(legacyAskParent, { recursive: true });
  fs.symlinkSync(outsideAsk, path.join(legacyAskParent, "ask"), process.platform === "win32" ? "junction" : "dir");
  const outsideFile = path.join(outsideAsk, `${slug}.txt`);
  fs.writeFileSync(outsideFile, "边界外内容", "utf8");
  const legacyFile = path.join(legacyAskParent, "ask", `${slug}.txt`);
  tab = store.updateTab(tab.id, { archiveFile: legacyFile });

  assert.throws(
    () => store.getArchiveDirInfo(tab),
    (error) => error?.code === "STORY_STORAGE_LINK_UNSAFE",
  );
  assert.equal(fs.readFileSync(outsideFile, "utf8"), "边界外内容");
  assert.equal(store.getTab(tab.id).archiveFile, legacyFile, "拒绝迁移时不得更新持久化归档路径");
  removeStoryFixture(tab.id);
});

test("故事点：旧临时目录兼容入口不得再修改源码工程或 .gitignore", () => {
  const repo = fs.mkdtempSync(path.join(tmp, "legacy-temp-isolation-"));
  fs.writeFileSync(path.join(repo, ".gitignore"), "existing-rule\n", "utf8");

  assert.equal(store.ensureTempFilesIsolation(repo), false);
  assert.equal(fs.existsSync(path.join(repo, "docs")), false);
  assert.equal(fs.readFileSync(path.join(repo, ".gitignore"), "utf8"), "existing-rule\n");
});

test("故事点：从全量存档文本还原页面会话", () => {
  const archiveDir = fs.mkdtempSync(path.join(tmp, "archive-restore-"));
  const archiveFile = path.join(archiveDir, "#CARB-11#恢复.txt");
  fs.writeFileSync(archiveFile, [
    "============================================================",
    "导出全部会话历史  [2026-07-14 10:00:00]   共 4 条消息",
    "============================================================",
    "========== 第 1 轮  [2026-07-14 10:00:01] ==========",
    "【我】",
    "问题一",
    "",
    "【AI:claude】",
    "回答一",
    "",
    "## 操作",
    "  - [工具] Bash  {}",
    "",
    "[token] 输入 1 / 输出 2",
    "========== 第 2 轮  [2026-07-14 10:00:02] ==========",
    "【我】",
    "问题二",
    "",
    "【AI:codex】【model:gpt-5.6-sol】【tier:max】",
    "回答二",
    "",
    "---------- [2026-07-14 10:00:03] 设置故事点存档目录 ----------",
    "",
  ].join("\n"), "utf-8");

  const tab = store.createTab({ title: "恢复目标" });
  const restored = store.restoreArchiveToTab(tab.id, archiveFile);
  assert.equal(restored.ok, true);
  assert.equal(restored.imported, 4);
  assert.equal(restored.turns, 2);
  const messages = store.getMessages(tab.id);
  assert.deepEqual(messages.map((m) => [m.role, m.content, m.engine || ""]), [
    ["user", "问题一", ""],
    ["assistant", "回答一", "claude"],
    ["user", "问题二", ""],
    ["assistant", "回答二", "codex"],
  ]);
  assert.equal(messages[1].aiSnapshot, undefined, "旧存档没有模型字段时不能伪造历史快照");
  assert.deepEqual(messages[3].aiSnapshot, {
    engine: "codex",
    model: "gpt-5.6-sol",
    tier: "max",
    capturedAt: messages[3].ts,
  });
  const updated = store.getTab(tab.id);
  const restoredStorage = store.getStoryStoragePaths(updated, { create: true });
  assert.equal(updated.archiveDir, null);
  assert.notEqual(updated.archiveFile, archiveFile);
  assert.equal(restored.activeArchiveFile, path.join(restoredStorage.archiveDirectory, `${store.ensureDocSlug(updated)}.txt`));
  assert.equal(updated.restoredArchiveSource, archiveFile);
  assert.equal(updated.cliSessionId, null);
  removeStoryFixture(tab.id);
});

test("故事点：全量存档导出并还原回答模型快照", async () => {
  const repo = fs.mkdtempSync(path.join(tmp, "archive-snapshot-"));
  store.upsertProject({ id: "archiveSnapshotRepo", name: "ArchiveSnapshotRepo", path: repo });
  let tab = store.createTab({ title: "模型快照存档" });
  tab = store.updateTab(tab.id, {
    primaryProjectId: "archiveSnapshotRepo",
    worktree: {
      version: 1,
      managed: true,
      root: repo,
      entries: [{ role: "primary", baseProjectId: "archiveSnapshotRepo", name: "ArchiveSnapshotRepo", basePath: repo, path: repo }],
    },
  });
  store.appendMessage(tab.id, { role: "user", content: "当前使用什么模型？", turn: 1 });
  store.appendMessage(tab.id, {
    role: "assistant",
    content: "当前回答",
    turn: 1,
    engine: "codex",
    aiSnapshot: {
      engine: "codex",
      name: "Codex CLI（火山方舟）",
      provider: "火山方舟",
      access: "Codex CLI · app-server",
      endpoint: "https://ark.cn-beijing.volces.com/api/coding/v1",
      official: false,
      model: "gpt-5.6-sol",
      tier: "max",
      capturedAt: 345678,
    },
  });

  const { exportFullArchive } = await import("../services/devbench/index.js");
  const exported = exportFullArchive(store.getTab(tab.id));
  assert.equal(exported.ok, true);
  const archiveText = fs.readFileSync(exported.file, "utf-8");
  assert.match(archiveText, /【AI:codex】【product:Codex CLI（火山方舟）】【provider:火山方舟】【access:Codex CLI · app-server】【endpoint:https:\/\/ark\.cn-beijing\.volces\.com\/api\/coding\/v1】【official:false】【model:gpt-5\.6-sol】【tier:max】【capturedAt:345678】/);
  const restored = store.parseArchiveMessages(archiveText);
  assert.deepEqual(restored.find((message) => message.role === "assistant")?.aiSnapshot, {
    engine: "codex",
    name: "Codex CLI（火山方舟）",
    provider: "火山方舟",
    access: "Codex CLI · app-server",
    endpoint: "https://ark.cn-beijing.volces.com/api/coding/v1",
    official: false,
    model: "gpt-5.6-sol",
    tier: "max",
    capturedAt: 345678,
  });
  removeStoryFixture(tab.id);
});

test("故事点：reopenClosed 不存在 → 报错", () => {
  const r = store.reopenClosed("no-such-id");
  assert.equal(r.ok, false);
  assert.ok(/不存在/.test(r.error));
});

test("仓库定义：只填 https 自动补 ssh，反之亦然", () => {
  let r = store.upsertProjectDef({ name: "天气", https: "https://codeup.aliyun.com/x/Weather" });
  assert.equal(r.ok, true);
  assert.equal(r.def.ssh, "git@codeup.aliyun.com:x/Weather.git");
  r = store.upsertProjectDef({ name: "媒体", ssh: "git@codeup.aliyun.com:x/Media.git" });
  assert.equal(r.def.https, "https://codeup.aliyun.com/x/Media");
});

test("仓库定义：仓库名去重 + git 地址去重", () => {
  const first = store.upsertProjectDef({ name: "仓库甲", ssh: "git@h:x/A.git" });
  assert.equal(first.ok, true);
  // 同名（与已存在的仓库甲）→ 拒绝
  const dupName = store.upsertProjectDef({ name: "仓库甲", ssh: "git@h:x/OTHER.git" });
  assert.equal(dupName.ok, false);
  assert.match(dupName.error, /已存在/);
  // 同 git 地址（与仓库甲一致）→ 拒绝
  const dupGit = store.upsertProjectDef({ name: "仓库乙", ssh: "git@h:x/A.git" });
  assert.equal(dupGit.ok, false);
  assert.match(dupGit.error, /已被仓库/);
});

test("仓库定义：同一远程可登记应用与 SDK 逻辑工程并同步推理元数据", () => {
  const remote = "git@h:x/AppMarket.git";
  assert.equal(store.upsertProjectDef({
    id: "market-main",
    name: "应用市场主工程",
    ssh: remote,
    projectType: "application",
  }).ok, true);
  const sdk = store.upsertProjectDef({
    id: "market-sdk",
    name: "应用市场SDK工程",
    ssh: remote,
    projectType: "sdk",
    inferenceKeywords: ["语音", "voice", "tts", "语音"],
    requiresRepositories: ["market-main"],
    inheritVariant: ["vehicle", "unknown"],
    defaultBranch: "feat/voice-sdk",
  });

  assert.equal(sdk.ok, true);
  assert.deepEqual(store.getProjectDef("market-sdk"), {
    id: "market-sdk",
    name: "应用市场SDK工程",
    https: "https://h/x/AppMarket",
    ssh: remote,
    projectType: "sdk",
    inferenceEnabled: false,
    inferenceKeywords: ["语音", "voice", "tts"],
    requiresRepositories: ["market-main"],
    inheritVariant: ["vehicle"],
    defaultBranch: "feat/voice-sdk",
    defaultFlavor: "",
  });
  const bundleSdk = store.getSharedBundle().projectDefs.find((def) => def.id === "market-sdk");
  assert.equal(bundleSdk.projectType, "sdk");
  assert.deepEqual(bundleSdk.requiresRepositories, ["market-main"]);
});

test("仓库定义：删除", () => {
  const r = store.upsertProjectDef({ name: "临时仓库", ssh: "git@h:x/Tmp.git" });
  store.deleteProjectDef(r.def.id);
  assert.equal(store.getProjectDefs().some((d) => d.id === r.def.id), false);
});

test("只读启动种子：共享配置 CRUD、学习写入和备份恢复均保持逐字不变", () => {
  const seedText = `${JSON.stringify({
    projectDefs: [{ id: "seed-repo", name: "种子仓库", https: "https://example.com/seed.git" }],
    projects: [],
    _comment: "read-only seed",
  }, null, 2)}\n`;
  fs.writeFileSync(MARKET, seedText);

  assert.equal(store.getProjectDef("seed-repo")?.name, "种子仓库");
  store.upsertProjectDef({ id: "runtime-repo", name: "运行时仓库", https: "https://example.com/runtime.git" });
  store.setDingtalkMsgConfig({ publish: { signed: [{ name: "测试人", mobile: "" }], unsigned: [] } });
  store.setVehicleMapping(PID, "runtime-car", {
    apps: [{ appName: "运行时应用", repos: [{ repoId: "runtime-repo", branch: "main", flavor: "runtime" }] }],
  });
  store.syncKeywordKeys(PID, "tag", ["运行时标签"]);
  store.setKeywordMapping(PID, "tag", "运行时标签", "vehicle", "runtime-car");
  const backup = store.createSharedSyncBackup({ label: "只读种子回归" });
  store.deleteProjectDef("runtime-repo");
  assert.equal(store.restoreSharedSyncBackup(backup.id).ok, true);

  assert.equal(fs.readFileSync(MARKET, "utf8"), seedText);
  const shared = db.getUserData("__devbench_shared__", "shared");
  assert.ok(shared.projectDefs.some((def) => def.id === "runtime-repo"));
  assert.equal(shared.byProject[PID].vehicleMap["runtime-car"].entries[0].branch, "main");
  assert.equal(shared.byProject[PID].keywordMappings.tag["运行时标签"].value, "runtime-car");
});

test("车型映射：apps→展平 entries + 项目隔离", () => {
  store.upsertProjectDef({ id: "appMarket", name: "应用市场", ssh: "git@h:x/AM.git" });
  const m = { apps: [{ appName: "App Market", repos: [{ repoId: "appMarket", branch: "v1", flavor: "car8678" }, { repoId: "webApp", branch: "main", flavor: "car8678" }] }] };
  const r = store.setVehicleMapping(PID, "car8678", m);
  assert.equal(r.ok, true);
  const vm = r.config.vehicleMap.car8678;
  assert.equal(vm.apps.length, 1);
  assert.deepEqual(vm.entries.map((e) => e.projectId), ["appMarket", "webApp"]);
  assert.equal(vm.entries[0].flavor, "car8678");
  // 项目隔离：projB 看不到 projA 的车型
  assert.deepEqual(Object.keys(store.getRemoteConfig("projB").vehicleMap), []);
});

test("车型映射：旧三代结构迁移（顶层 appMarketBranch → byProject.apps/entries）", () => {
  db.default.prepare("DELETE FROM devbench_userdata WHERE user_key=? AND kind=?").run("__devbench_shared__", "shared");
  const seedText = JSON.stringify({
    vehicleMap: { avatr: { appMarketBranch: "v202605", needWebApp: true, webAppBranch: "wb", needSdk: false } },
  });
  fs.writeFileSync(MARKET, seedText);
  const vm = store.getRemoteConfig(PID).vehicleMap.avatr; // 默认项目 = projA
  assert.ok(vm.apps.length >= 1);
  assert.deepEqual(vm.entries.map((e) => e.projectId).sort(), ["appMarket", "webApp"]);
  assert.equal(vm.entries.find((e) => e.projectId === "webApp").branch, "wb");
  // 顶层 vehicleMap 作为兼容种子保持不变；迁移结果只落 SQLite 共享态。
  const raw = JSON.parse(fs.readFileSync(MARKET, "utf8"));
  assert.ok(raw.vehicleMap.avatr);
  assert.equal(raw.byProject, undefined, "byProject 不再写入 market.json，改存 SQLite");
  assert.equal(fs.readFileSync(MARKET, "utf8"), seedText);
  const shared = db.getUserData("__devbench_shared__", "shared");
  assert.ok(shared?.byProject?.[PID]?.vehicleMap?.avatr, "迁移结果应落 SQLite 共享态");
});

test("车型映射：普通 GET 保持纯读，默认配置只能显式初始化", () => {
  const rc = store.getRemoteConfig(PID);
  assert.deepEqual(rc.vehicleMap, {});
  let shared = db.getUserData("__devbench_shared__", "shared");
  assert.equal(shared?.vehicleMapSeededAt, undefined, "GET 不得写入默认车型或初始化标记");
  assert.deepEqual(shared?.byProject?.[PID]?.vehicleMap || {}, {});

  const initialized = store.initializeVehicleMap(PID);
  assert.equal(initialized.ok, true);
  assert.equal(initialized.initialized, true);
  const initializedConfig = store.getRemoteConfig(PID);
  assert.deepEqual(Object.keys(initializedConfig.vehicleMap).sort(), ["avatr8155", "avatr8678", "geelye22", "zeekr9x"]);
  assert.deepEqual(initializedConfig.vehicleMap.avatr8678.entries.map((e) => e.projectId), ["appMarket"]);
  assert.deepEqual(initializedConfig.vehicleMap.geelye22.entries.map((e) => e.projectId).sort(), ["appMarket", "webApp"]);

  shared = db.getUserData("__devbench_shared__", "shared");
  assert.ok(shared?.vehicleMapSeededAt, "显式初始化应打一次性标记");
  assert.ok(shared?.byProject?.[PID]?.vehicleMap?.avatr8678, "显式初始化结果应写入 SQLite 共享态");
  const second = store.initializeVehicleMap(PID);
  assert.equal(second.noOp, true, "重复初始化必须是 no-op");
  const raw = JSON.parse(fs.readFileSync(MARKET, "utf8"));
  assert.equal(raw.byProject, undefined, "byProject 不应写回 market.json");
  assert.equal(raw.vehicleMapSeededAt, undefined, "初始化标记不应写回 market.json");
});

test("关键词映射：同步补新 key + 保留已有映射 + 按项目隔离", () => {
  store.syncKeywordKeys(PID, "tag", ["阿维塔", "奇瑞"]);
  store.setKeywordMapping(PID, "tag", "阿维塔", "vehicle", "avatr8678");
  // 再同步含新旧 key：不覆盖已映射的阿维塔，新增赛力斯
  const r = store.syncKeywordKeys(PID, "tag", ["阿维塔", "赛力斯"]);
  assert.equal(r.added, 1);
  const km = store.getKeywordMappings(PID);
  assert.equal(km.tag["阿维塔"].value, "avatr8678");
  assert.deepEqual(km.tag["赛力斯"], { category: "", value: "" });
  // projB 隔离
  assert.deepEqual(store.getKeywordMappings("projB").tag, {});
});

test("关键词映射：删除 + 标题识别应用/车型", () => {
  store.setKeywordMapping(PID, "title", "应用市场", "app", "App Market");
  store.setKeywordMapping(PID, "title", "阿维塔_8678", "vehicle", "avatr8678");
  const reco = store.recognizeFromTitleKeywords(PID, ["阿维塔_8678", "应用市场", "无关键词"]);
  assert.deepEqual(reco, { app: "App Market", vehicle: "avatr8678" });
  store.deleteKeywordMapping(PID, "title", "应用市场");
  assert.equal(store.getKeywordMappings(PID).title["应用市场"], undefined);
});

test("克隆父路径：全局（不随项目）+ 默认值", () => {
  const remoteConfig = store.getRemoteConfig(PID);
  const def = remoteConfig.cloneParent;
  assert.ok(def && def.length); // 有默认
  assert.equal(def, path.resolve(process.env.AIEFFICIENCY_CLONE_PARENT));
  assert.equal(store.resolveDefaultCloneParent(), path.resolve(process.env.AIEFFICIENCY_CLONE_PARENT));
  assert.equal(remoteConfig.defaultCloneParent, store.resolveDefaultCloneParent(), "车型源码配置必须返回默认按钮使用的本机默认路径");
  const ready = store.ensureCloneParentReady();
  assert.equal(ready, def);
  assert.equal(fs.statSync(path.join(def, "AllDocs", "StoryDev")).isDirectory(), true);
  const cloneParent = path.join(tmp, "myclones");
  store.updateRemoteConfig({ cloneParent }, PID);
  assert.equal(store.getRemoteConfig("projB").cloneParent, cloneParent); // 全局，projB 也读到
  assert.equal(store.ensureCloneParentReady(), cloneParent, "已持久化路径不得被新的平台默认值覆盖");
  assert.equal(fs.statSync(path.join(cloneParent, "AllDocs", "StoryDev")).isDirectory(), true);
  assert.throws(
    () => store.updateRemoteConfig({ cloneParent: "relative/clones" }, PID),
    /必须是绝对路径/,
  );
});

test("Android flavor：双维 project_flavor.gradle 只展示 car，并保留内部构建变体", () => {
  const project = path.join(tmp, "android-multi-flavor");
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, "settings.gradle"), "include ':app'\n");
  fs.writeFileSync(path.join(project, "project_flavor.gradle"), `
    android {
      flavorDimensions "car", "env"
      productFlavors {
        seres { dimension "car"; versionName "1.1.7" }
        geelyss21 { dimension "car"; versionName "1.4.60" }
        prod { dimension "env" }
        stg { dimension "env" }
      }
    }
  `);

  const result = store.getAndroidFlavors(project);
  assert.equal(result.isAndroid, true);
  assert.deepEqual(result.flavors, ["seres", "geelyss21"]);
  assert.deepEqual(result.buildVariants, ["seresProd", "seresStg", "geelyss21Prod", "geelyss21Stg"]);
  assert.deepEqual(store.expandAndroidBuildFlavors(project, ["geelyss21"]), ["geelyss21Prod", "geelyss21Stg"]);
});

test("Android flavor：flavorConfig.json 仍优先于 project_flavor.gradle", () => {
  const project = path.join(tmp, "android-flavor-config-priority");
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, "project_flavor.gradle"), `android { productFlavors { fallback { dimension "car" } } }`);
  fs.writeFileSync(path.join(project, "flavorConfig.json"), JSON.stringify({ configured: { versionName: "1.0.0" } }));

  assert.deepEqual(store.getAndroidFlavors(project), { isAndroid: true, flavors: ["configured"] });
});

test("Android 版本号：兼容末段 2 位/3 位 versionCode 并在进位时写成 xxx000", () => {
  const cases = [
    { name: "legacy2-no-carry", fromName: "1.1.80", fromCode: 10180, toName: "1.1.90", toCode: 10190 },
    { name: "legacy3-no-carry", fromName: "1.1.80", fromCode: 101080, toName: "1.1.90", toCode: 101090 },
    { name: "legacy2-carry", fromName: "1.1.90", fromCode: 10190, toName: "1.2.0", toCode: 102000 },
    { name: "legacy3-carry", fromName: "1.1.90", fromCode: 101090, toName: "1.2.0", toCode: 102000 },
  ];
  for (const c of cases) {
    const project = path.join(tmp, `android-version-${c.name}`);
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, "settings.gradle"), "include ':app'\n");
    fs.writeFileSync(path.join(project, "flavorConfig.json"), JSON.stringify({
      prod: { versionName: c.fromName, versionCode: c.fromCode },
    }, null, 2));

    const r = store.applyVersionOp(project, "prod", "bump10");
    assert.equal(r.ok, true, c.name);
    assert.equal(r.versionName, c.toName, c.name);
    assert.equal(r.versionCode, c.toCode, c.name);
    const saved = JSON.parse(fs.readFileSync(path.join(project, "flavorConfig.json"), "utf8"));
    assert.equal(saved.prod.versionName, c.toName, c.name);
    assert.equal(saved.prod.versionCode, c.toCode, c.name);
  }
});

test("钉钉消息配置：set/get 默认结构 + 空 signed 保留 + 项目无关全局共享", () => {
  // 未配置 → 返回默认（付浩/张明 + 空 unsigned）
  const def = store.getDingtalkMsgConfig();
  assert.deepEqual(def.publish.signed.map((x) => x.name), ["付浩", "张明"]);
  assert.deepEqual(def.publish.unsigned, []);
  // 显式置空 signed（"谁都不@"）要被保留，而不是回退默认
  store.setDingtalkMsgConfig({ publish: { signed: [], unsigned: [{ name: "u", mobile: "" }] } });
  const c = store.getDingtalkMsgConfig();
  assert.deepEqual(c.publish.signed, []);
  assert.deepEqual(c.publish.unsigned, [{ name: "u", mobile: "" }]);
  // 走 shared bundle，bump 版本
  assert.ok(store.getSharedVersion() > 0);
  assert.deepEqual(store.getSharedBundle().dingtalkMsgConfig.publish.signed, []);
});

test("钉钉消息配置：缺省 signed 不得返回模块级默认引用（防进程内默认被污染）", () => {
  // 配置存在但 publish 没有 signed 数组 → 走默认分支；返回值必须是深拷贝
  store.setDingtalkMsgConfig({ publish: { unsigned: [] } });
  const c1 = store.getDingtalkMsgConfig();
  assert.deepEqual(c1.publish.signed.map((x) => x.name), ["付浩", "张明"]);
  c1.publish.signed.push({ name: "POISON", mobile: "x" }); // 调用方就地修改
  // 再取（回退默认）不应看到 POISON——否则说明返回的是共享引用，默认被永久污染
  store.setDingtalkMsgConfig(null);
  const c2 = store.getDingtalkMsgConfig();
  assert.deepEqual(c2.publish.signed.map((x) => x.name), ["付浩", "张明"], "模块级默认被污染了");
});

test("钉钉消息配置：applySharedBundle 版本闸门（同版本不覆盖、更高版本无 key 保留本地）", () => {
  store.setDingtalkMsgConfig({ publish: { signed: [{ name: "local", mobile: "" }], unsigned: [] } });
  const v = store.getSharedVersion();
  // 同版本的对端配置 → 不应用
  let r = store.applySharedBundle({ version: v, dingtalkMsgConfig: { publish: { signed: [{ name: "peer", mobile: "" }] } } });
  assert.equal(r.applied, false);
  assert.deepEqual(store.getDingtalkMsgConfig().publish.signed.map((x) => x.name), ["local"]);
  // 更高版本但 bundle 未带 dingtalkMsgConfig key → 本地配置保留
  r = store.applySharedBundle({ version: v + 1000, byProject: {} });
  assert.equal(r.applied, true);
  assert.deepEqual(store.getDingtalkMsgConfig().publish.signed.map((x) => x.name), ["local"]);
});

test("共享同步：内容相同但远端水位更高时不写入且不推进本地版本", () => {
  const before = store.getSharedBundle();
  const localVersion = store.getSharedVersion();
  const recordBefore = db.getUserDataRecord("__devbench_shared__", "shared");
  const remoteVersion = before.version + 1000;
  const first = store.applySharedBundle({ ...before, version: remoteVersion });
  const recordAfter = db.getUserDataRecord("__devbench_shared__", "shared");
  assert.equal(first.applied, false);
  assert.equal(first.observedRemoteVersion, remoteVersion);
  assert.equal(store.getSharedVersion(), localVersion);
  assert.equal(recordAfter.updated_at, recordBefore.updated_at, "同内容 bundle 不得触发 SQLite 整行回写");
  assert.deepEqual(recordAfter.data, recordBefore.data);

  const replay = store.applySharedBundle({ ...before, version: remoteVersion });
  assert.equal(replay.applied, false);
  assert.equal(store.getSharedVersion(), localVersion);
  assert.equal(db.getUserDataRecord("__devbench_shared__", "shared").updated_at, recordBefore.updated_at);
});

test("车型映射：applySharedBundle 合并项目桶，缺省 vehicleMap 不清空本地", () => {
  const m = { apps: [{ appName: "App Market", repos: [{ repoId: "appMarket", branch: "v1", flavor: "car8678" }] }] };
  store.setVehicleMapping(PID, "car8678", m);
  const v = store.getSharedVersion();

  const r = store.applySharedBundle({
    version: v + 1000,
    byProject: {
      [PID]: {
        keywordMappings: { tag: { "阿维塔": { category: "vehicle", value: "car8678" } } },
        configMemory: [{ id: "mem1", config: { primaryProjectId: "appMarket", flavor: "car8678" } }],
      },
    },
  });

  assert.equal(r.applied, true);
  assert.equal(store.getRemoteConfig(PID).vehicleMap.car8678.entries[0].branch, "v1");
  assert.equal(store.getKeywordMappings(PID).tag["阿维塔"].value, "car8678");
  assert.deepEqual(store.getConfigMemories(PID).map((x) => x.id), ["mem1"]);
});

test("共享同步：保存车型只记录具体车型路径的增量 op", () => {
  store.setVehicleMapping(PID, "car8678", { apps: [{ appName: "App Market", repos: [{ repoId: "appMarket", branch: "v1", flavor: "car8678" }] }] });
  const ops = store.getSharedBundle().sharedOps;
  const op = ops.findLast((item) => item.type === "byProject.set" && item.path?.join("/") === "vehicleMap/car8678");
  assert.ok(op);
  assert.equal(op.type, "byProject.set");
  assert.equal(op.projectId, PID);
  assert.deepEqual(op.path, ["vehicleMap", "car8678"]);
  assert.equal(op.value.entries[0].branch, "v1");
});

test("共享同步：远端关键词增量 op 不覆盖本地车型配置", () => {
  store.setVehicleMapping(PID, "car8678", { apps: [{ appName: "App Market", repos: [{ repoId: "appMarket", branch: "v1", flavor: "car8678" }] }] });
  const r = store.applySharedBundle({
    version: 10,
    sharedOps: [{
      id: "peer:10:keyword",
      type: "byProject.set",
      projectId: PID,
      path: ["keywordMappings", "tag", "阿维塔"],
      value: { category: "vehicle", value: "car8678" },
      version: 10,
    }],
    byProject: { [PID]: { keywordMappings: { tag: { "阿维塔": { category: "vehicle", value: "car8678" } } } } },
  });
  assert.equal(r.applied, true);
  assert.equal(store.getRemoteConfig(PID).vehicleMap.car8678.entries[0].branch, "v1");
  assert.equal(store.getKeywordMappings(PID).tag["阿维塔"].value, "car8678");
});

test("共享同步：新版空 ops 包不得应用 full byProject 覆盖", () => {
  store.setVehicleMapping(PID, "car8678", { apps: [{ appName: "App Market", repos: [{ repoId: "appMarket", branch: "v1", flavor: "car8678" }] }] });
  const r = store.applySharedBundle({
    version: store.getSharedVersion() + 1000,
    sharedOps: [],
    byProject: {
      [PID]: {
        vehicleMap: {
          car8678: { apps: [{ appName: "Remote", repos: [{ repoId: "appMarket", branch: "remote", flavor: "car8678" }] }] },
        },
      },
    },
  });
  assert.equal(r.applied, false);
  assert.equal(store.getRemoteConfig(PID).vehicleMap.car8678.entries[0].branch, "v1");
});

test("共享同步：远端删除 op 只删除指定车型并保留其它车型", () => {
  store.setVehicleMapping(PID, "carA", { apps: [{ appName: "A", repos: [{ repoId: "appMarket", branch: "a", flavor: "carA" }] }] });
  store.setVehicleMapping(PID, "carB", { apps: [{ appName: "B", repos: [{ repoId: "appMarket", branch: "b", flavor: "carB" }] }] });
  const remoteVersion = store.getSharedVersion() + 1000;
  const r = store.applySharedBundle({
    version: remoteVersion,
    sharedOps: [{
      id: `peer:${remoteVersion}:delete-car-a`,
      type: "byProject.delete",
      projectId: PID,
      path: ["vehicleMap", "carA"],
      version: remoteVersion,
      node: "peer",
    }],
  });
  const vm = store.getRemoteConfig(PID).vehicleMap;
  assert.equal(r.applied, true);
  assert.equal(vm.carA, undefined);
  assert.equal(vm.carB.entries[0].branch, "b");
});

test("共享同步：旧节点高版本全量仓库快照可更新既有仓库并删除缺失仓库", () => {
  assert.equal(store.upsertProjectDef({
    id: "legacy-x", name: "旧节点仓库X", https: "https://example.com/legacy/x.git",
  }).ok, true);
  assert.equal(store.upsertProjectDef({
    id: "legacy-y", name: "旧节点仓库Y", https: "https://example.com/legacy/y.git",
  }).ok, true);
  const remoteVersion = store.getSharedVersion() + 1000;
  const applied = store.applySharedBundle({
    version: remoteVersion,
    projectDefs: [{
      id: "legacy-x", name: "旧节点更新后的仓库X", https: "https://example.com/legacy/x-new.git",
    }],
    byProject: {},
  });
  assert.equal(applied.ok, true);
  assert.equal(applied.applied, true);
  assert.equal(store.getProjectDef("legacy-x")?.name, "旧节点更新后的仓库X");
  assert.equal(store.getProjectDef("legacy-y"), null, "全量 projectDefs 明确缺失的仓库必须生成删除操作");
});

test("共享恢复屏障和 restore 操作在 2000 条训练操作后仍阻止旧配置复活", () => {
  const base = {
    projectDefs: [{ id: "repo", name: "恢复前仓库", https: "https://example.com/repo.git" }],
    byProject: { p: { vehicleMap: { car: { apps: [] } } } },
    dingtalkMsgConfig: null,
    _sharedVersion: 1,
    sharedOps: [],
    sharedOpClocks: {},
  };
  const restoreOp = {
    id: "restore-node:100:restore", node: "restore-node", version: 100, at: 100,
    type: "shared.restore", idValue: "backup-1",
    value: {
      projectDefs: [{ id: "repo", name: "已恢复仓库", https: "https://example.com/repo.git" }],
      byProject: { p: { vehicleMap: { car: { aliases: ["restored"], apps: [] } } } },
      dingtalkMsgConfig: null,
    },
  };
  const restored = store.__testMergeSharedStoreWrite(base, {
    ...base,
    _sharedVersion: 100,
    sharedOps: [restoreOp],
  });
  assert.equal(restored.projectDefs[0].name, "已恢复仓库");
  assert.equal(restored.sharedRestoreClock.version, 100);

  const filler = Array.from({ length: 2105 }, (_, index) => ({
    id: `filler:${101 + index}:run-${index}`,
    node: "filler",
    version: 101 + index,
    at: 101 + index,
    restoreEpoch: restoreOp.id,
    type: "byProject.set",
    projectId: "p",
    path: ["aiTraining", "configInference", "runs", `run-${index}`],
    value: { id: `run-${index}`, updatedAt: 101 + index },
  }));
  const compacted = store.__testMergeSharedStoreWrite(restored, {
    ...restored,
    _sharedVersion: 2300,
    sharedOps: [...restored.sharedOps, ...filler],
  });
  assert.ok(compacted.sharedOps.some((op) => op.type === "shared.restore"), "最新 restore 不得被训练窗口裁掉");
  assert.ok(compacted.sharedOps.length > 2000, "restore 应作为受保护操作保留在最近训练窗口之外");

  const stale = store.__testMergeSharedStoreWrite(compacted, {
    ...compacted,
    _sharedVersion: 2400,
    sharedOps: [
      ...compacted.sharedOps,
      {
        id: "offline:90:repo", node: "offline", version: 90, at: 90,
        type: "projectDef.set",
        value: { id: "repo", name: "离线旧仓库", https: "https://example.com/repo.git" },
      },
      {
        id: "offline:91:vehicle", node: "offline", version: 91, at: 91,
        type: "byProject.set", projectId: "p", path: ["vehicleMap", "car"],
        value: { aliases: ["stale"], apps: [] },
      },
    ],
  });
  assert.equal(stale.projectDefs[0].name, "已恢复仓库");
  assert.deepEqual(stale.byProject.p.vehicleMap.car.aliases, ["restored"]);
});

test("共享恢复与操作压缩：SQLite 合并在 restore 后仍从 snapshot 保留窗口外训练记录", () => {
  const restoreOp = {
    id: "restore-node:100:restore", node: "restore-node", version: 100, at: 100,
    type: "shared.restore", idValue: "backup-snapshot",
    value: { projectDefs: [], byProject: {}, dingtalkMsgConfig: null },
  };
  const oldRun = { id: "old-run", projectId: "p", title: "窗口外训练记录", updatedAt: 101 };
  const oldRunOp = {
    id: "peer:101:old-run", node: "peer", version: 101, at: 101,
    restoreEpoch: restoreOp.id,
    type: "byProject.set", projectId: "p",
    path: ["aiTraining", "configInference", "runs", oldRun.id],
    value: oldRun,
  };
  const filler = Array.from({ length: 2001 }, (_, index) => ({
    id: `peer:${102 + index}:filler-${index}`,
    node: "peer",
    version: 102 + index,
    at: 102 + index,
    restoreEpoch: restoreOp.id,
    type: "byProject.set",
    projectId: "p",
    path: ["aiTraining", "configInference", "runs", `filler-${index}`],
    value: { id: `filler-${index}`, projectId: "p", updatedAt: 102 + index },
  }));
  const merged = store.__testMergeSharedStoreWrite({
    projectDefs: [], byProject: {}, dingtalkMsgConfig: null, _sharedVersion: 1,
    sharedOps: [], sharedOpClocks: {}, sharedRestoreClock: null,
  }, {
    projectDefs: [],
    byProject: {
      p: { aiTraining: { configInference: { runs: { [oldRun.id]: oldRun } } } },
    },
    dingtalkMsgConfig: null,
    _sharedVersion: 2200,
    sharedOps: [restoreOp, oldRunOp, ...filler],
    sharedRestoreClock: restoreOp,
  });

  assert.ok(merged.sharedOps.some((op) => op.id === restoreOp.id), "restore 必须受压缩保护");
  assert.equal(merged.sharedOps.some((op) => op.id === oldRunOp.id), false, "旧训练 op 应已离开 2000 条窗口");
  assert.equal(
    merged.byProject.p.aiTraining.configInference.runs[oldRun.id]?.title,
    "窗口外训练记录",
    "窗口外训练记录必须由完整 snapshot 在 restore 后恢复",
  );
});

test("共享恢复安全：首次 SQLite 写入不接受无 restore 证据的孤立 clock", () => {
  const fakeClock = { id: "fake:999:restore", node: "fake", version: 999, at: 999 };
  const firstWrite = store.__testMergeSharedStoreWrite(null, {
    projectDefs: [], byProject: {}, dingtalkMsgConfig: null, _sharedVersion: 999,
    sharedOps: [], sharedOpClocks: {}, sharedRestoreClock: fakeClock,
  });
  assert.equal(firstWrite.sharedRestoreClock, null);
  assert.deepEqual(firstWrite.sharedOps, []);
});

test("共享恢复安全：恢复前旧 Gateway 的 snapshot 不得绕过 epoch 屏障复活旧训练记录", () => {
  const restoreOp = {
    id: "restore-node:100:restore", node: "restore-node", version: 100, at: 100,
    type: "shared.restore", idValue: "backup-concurrent",
    value: { projectDefs: [], byProject: {}, dingtalkMsgConfig: null },
  };
  const staleRun = { id: "stale-run", projectId: "p", title: "恢复前旧记录", updatedAt: 10_000 };
  const staleOp = {
    id: "old-gateway:10000:stale-run", node: "old-gateway", version: 10_000, at: 10_000,
    type: "byProject.set", projectId: "p",
    path: ["aiTraining", "configInference", "runs", staleRun.id], value: staleRun,
  };
  const merged = store.__testMergeSharedStoreWrite({
    projectDefs: [], byProject: {}, dingtalkMsgConfig: null, _sharedVersion: 100,
    sharedOps: [restoreOp], sharedOpClocks: {}, sharedRestoreClock: restoreOp,
  }, {
    projectDefs: [],
    byProject: { p: { aiTraining: { configInference: { runs: { [staleRun.id]: staleRun } } } } },
    dingtalkMsgConfig: null,
    _sharedVersion: 10_000,
    vehicleMapSeededAt: 10_000,
    repositoryInferenceProfilesVersion: 10_000,
    sharedOps: [staleOp],
    sharedOpClocks: {},
    sharedRestoreClock: null,
  });

  assert.equal(merged.sharedOps.some((op) => op.id === staleOp.id), false);
  assert.equal(merged.byProject.p?.aiTraining?.configInference?.runs?.[staleRun.id], undefined);
  assert.equal(merged.sharedRestoreClock?.id, restoreOp.id);
  assert.equal(merged._sharedVersion, 100, "旧 epoch 的伪高水位也不得推进恢复后的版本");
  assert.equal(Number(merged.vehicleMapSeededAt) || 0, 0);
  assert.equal(Number(merged.repositoryInferenceProfilesVersion) || 0, 0);
});

test("共享恢复迁移：旧版 retained restore 自动派生 clock 并给合法后续 op 补 epoch", () => {
  const restoreOp = {
    id: "legacy-restore:100:restore", node: "legacy-restore", version: 100, at: 100,
    type: "shared.restore", idValue: "legacy-backup",
    value: {
      projectDefs: [{ id: "repo", name: "恢复值", https: "https://example.com/restored.git" }],
      byProject: {}, dingtalkMsgConfig: null,
    },
  };
  const postRestoreOp = {
    id: "legacy-node:101:post", node: "legacy-node", version: 101, at: 101,
    type: "projectDef.set",
    value: { id: "post", name: "恢复后旧版写入", https: "https://example.com/post.git" },
  };
  const migrated = store.__testMergeSharedStoreWrite({
    projectDefs: [
      { id: "repo", name: "恢复值", https: "https://example.com/restored.git" },
      postRestoreOp.value,
    ],
    byProject: {}, dingtalkMsgConfig: null, _sharedVersion: 101,
    sharedOps: [restoreOp, postRestoreOp], sharedOpClocks: {},
  }, {
    projectDefs: [], byProject: {}, dingtalkMsgConfig: null, _sharedVersion: 200,
    sharedOps: [{
      id: "offline:200:stale", node: "offline", version: 200, at: 200,
      type: "projectDef.set",
      value: { id: "repo", name: "离线旧值", https: "https://example.com/stale.git" },
    }],
  });

  assert.equal(migrated.sharedRestoreClock?.id, restoreOp.id);
  assert.equal(migrated.sharedOps.find((op) => op.id === postRestoreOp.id)?.restoreEpoch, restoreOp.id);
  assert.equal(migrated.projectDefs.find((def) => def.id === "repo")?.name, "恢复值");
  assert.equal(migrated._sharedVersion, 101);
});

test("共享恢复迁移：SQLite 旧行读取后导出匹配 clock 与已补 epoch 的操作", () => {
  const defs = store.getProjectDefs();
  const restoreOp = {
    id: "legacy-db:100:restore", node: "legacy-db", version: 100, at: 100,
    type: "shared.restore", idValue: "legacy-db-backup",
    value: { projectDefs: defs, byProject: {}, dingtalkMsgConfig: null },
  };
  const postRestoreOp = {
    id: "legacy-db:101:post", node: "legacy-db", version: 101, at: 101,
    type: "projectDef.set",
    value: { id: "legacy-post", name: "旧版恢复后仓库", https: "https://example.com/legacy-post.git" },
  };
  db.setUserData("__devbench_shared__", "shared", {
    projectDefs: [...defs, postRestoreOp.value],
    byProject: {},
    dingtalkMsgConfig: null,
    _sharedVersion: 101,
    sharedOps: [restoreOp, postRestoreOp],
    sharedOpClocks: {},
  }, "legacy-db");

  const bundle = store.getSharedBundle();
  assert.equal(bundle.sharedRestoreClock?.id, restoreOp.id);
  assert.equal(bundle.sharedOps.find((op) => op.id === postRestoreOp.id)?.restoreEpoch, restoreOp.id);
  assert.equal(store.getProjectDef("legacy-post")?.name, "旧版恢复后仓库");
});

test("共享恢复安全：缺少匹配 restore 操作的伪造 clock 不得建立屏障", () => {
  const before = store.getSharedBundle();
  assert.equal(before.sharedRestoreClock, null);
  const fakeVersion = before.version + 10_000;
  const rejected = store.applySharedBundle({
    ...before,
    version: fakeVersion,
    sharedRestoreClock: {
      id: `fake-node:${fakeVersion}:restore`,
      node: "fake-node",
      version: fakeVersion,
      at: fakeVersion,
    },
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.applied, false);
  assert.match(rejected.error, /缺少匹配的 shared\.restore/);

  const after = store.getSharedBundle();
  assert.equal(after.sharedRestoreClock, null, "clock-only bundle 不得污染本机恢复屏障");
  assert.deepEqual(after.projectDefs, before.projectDefs);
  assert.equal(after.version, before.version);
});

test("共享恢复安全：恢复后拒绝无因果 epoch 的现代操作和旧版高版本全量包", () => {
  const before = store.getSharedBundle();
  const restoreVersion = before.version + 10_000;
  const restoredDefs = before.projectDefs.map((def) => def.id === "appMarket"
    ? { ...def, name: "恢复态应用市场" }
    : def);
  const restoreOp = {
    id: `restore-node:${restoreVersion}:restore`,
    node: "restore-node",
    version: restoreVersion,
    at: restoreVersion,
    type: "shared.restore",
    idValue: "security-backup",
    value: {
      projectDefs: restoredDefs,
      byProject: {},
      dingtalkMsgConfig: null,
    },
  };
  const restored = store.applySharedBundle({
    version: restoreVersion,
    sharedOps: [restoreOp],
    sharedRestoreClock: restoreOp,
  });
  assert.equal(restored.ok, true);
  assert.equal(restored.applied, true);
  assert.equal(store.getProjectDef("appMarket")?.name, "恢复态应用市场", "restore 必须持久化到 SQLite 权威态");
  const restoredBundle = store.getSharedBundle();
  assert.equal(restoredBundle.sharedRestoreClock?.id, restoreOp.id);
  assert.ok(restoredBundle.sharedOps.some((op) => op.id === restoreOp.id));

  const staleModernVersion = restoredBundle.version + 10_000;
  const rejectedModern = store.applySharedBundle({
    version: staleModernVersion,
    sharedOps: [
      restoreOp,
      {
        id: `offline:${staleModernVersion}:repo`,
        node: "offline",
        version: staleModernVersion,
        at: staleModernVersion,
        type: "projectDef.set",
        value: { id: "appMarket", name: "现代旧数据", https: "https://example.com/stale-modern.git" },
      },
    ],
    sharedRestoreClock: restoreOp,
  });
  assert.equal(rejectedModern.ok, false);
  assert.match(rejectedModern.error, /缺少匹配的因果 epoch/);
  assert.equal(store.getProjectDef("appMarket")?.name, "恢复态应用市场");

  const rejectedLegacy = store.applySharedBundle({
    version: staleModernVersion + 10_000,
    projectDefs: [{ id: "appMarket", name: "旧版高版本数据", https: "https://example.com/stale-legacy.git" }],
    byProject: {},
  });
  assert.equal(rejectedLegacy.ok, false);
  assert.match(rejectedLegacy.error, /不包含恢复 epoch/);
  assert.equal(store.getProjectDef("appMarket")?.name, "恢复态应用市场");

  const postRestoreVersion = staleModernVersion + 20_000;
  const postRestoreOp = {
    id: `peer:${postRestoreVersion}:repo`,
    node: "peer",
    version: postRestoreVersion,
    at: postRestoreVersion,
    restoreEpoch: restoreOp.id,
    type: "projectDef.set",
    value: { id: "appMarket", name: "恢复后合法更新", https: "https://example.com/post-restore.git" },
  };
  const accepted = store.applySharedBundle({
    version: postRestoreVersion,
    sharedOps: [restoreOp, postRestoreOp],
    sharedRestoreClock: restoreOp,
  });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.applied, true);
  assert.equal(store.getProjectDef("appMarket")?.name, "恢复后合法更新");
});

test("工程列表保持本机私有：shared bundle 不导出也不覆盖 projects", () => {
  store.upsertProject({ id: "local-only", name: "本机工程", path: "D:/local/project" });
  const before = store.listProjects().map((p) => p.id);
  assert.ok(before.includes("local-only"));

  const bundle = store.getSharedBundle();
  assert.equal(Object.prototype.hasOwnProperty.call(bundle, "projects"), false, "共享包不应携带本机工程列表");

  const r = store.applySharedBundle({
    version: store.getSharedVersion() + 1000,
    projects: [{ id: "peer-project", name: "远端工程", path: "D:/peer/project" }],
    byProject: {},
  });
  assert.equal(r.applied, true);
  const after = store.listProjects().map((p) => p.id);
  assert.deepEqual(after, before, "远端共享包不应覆盖本机工程列表");
  assert.equal(store.listProjects().some((p) => p.id === "peer-project"), false);
});

test("克隆父路径保持本机私有，并随本机工程配置备份还原", () => {
  const localCloneParent = path.join(tmp, "local-vehicle-clones");
  const changedCloneParent = path.join(tmp, "changed-vehicle-clones");
  store.updateRemoteConfig({ cloneParent: localCloneParent }, PID);
  store.upsertProject({ id: "local-backup", name: "本机备份工程", path: "D:/local/project" });
  const task = store.createTask({ title: "工程配置还原不得清空的任务" }).task;

  const backup = store.exportProjects();
  assert.equal(backup.version, 4);
  assert.equal(backup.cloneParent, localCloneParent);
  assert.equal(backup.projects[0].id, "local-backup");
  assert.equal(Object.prototype.hasOwnProperty.call(store.getSharedBundle(), "cloneParent"), false, "局域网共享包不应携带克隆父路径");

  const applied = store.applySharedBundle({
    version: store.getSharedVersion() + 1000,
    cloneParent: "Z:/peer/vehicle-clones",
    projects: [{ id: "peer-project", name: "对端工程", path: "Z:/peer/project" }],
    byProject: {},
  });
  assert.equal(applied.applied, true);
  assert.equal(store.getRemoteConfig(PID).cloneParent, localCloneParent, "对端共享包不应覆盖本机克隆父路径");

  store.updateRemoteConfig({ cloneParent: changedCloneParent }, PID);
  const restored = store.importData(backup, { mode: "replace" });
  assert.equal(restored.ok, true);
  assert.equal(restored.cloneParent.restored, true);
  assert.equal(restored.cloneParent.value, localCloneParent);
  assert.equal(store.getRemoteConfig(PID).cloneParent, localCloneParent);
  assert.equal(JSON.parse(fs.readFileSync(LOCAL_PROJECTS, "utf8")).cloneParent, localCloneParent);
  assert.equal(store.listTasks().some((item) => item.id === task.id), true, "仅还原本机路径配置不应清空任务");
  store.deleteTask(task.id);
});

test("AI训练任务来源通过 snapshot 跨目录恢复，清空后旧 bundle 不复活也不 bump 版本", () => {
  const source = {
    type: "teambition_section",
    url: "https://www.teambition.com/project/projA/sprint/section/section-1",
    projectId: PID,
    sectionId: "section-1",
    sprintId: "sprint-1",
    tasklistId: "tasklist-1",
    name: "极氪_9X",
    counts: { all: 12, pending: 3, completed: 9 },
    fetchSource: "open-api+cookie-source",
    statusCounts: [
      { key: "status-testable", id: "status-testable", name: "可提测", count: 8, pending: 0, completed: 8 },
      { key: "status-active", id: "status-active", name: "处理中", count: 4, pending: 3, completed: 1 },
    ],
    acquisition: { fetchSource: "open-api+cookie-source", openApiMatched: 4, cookieMatched: 12, mergedMatched: 12, cookieComplete: true, cookiePages: 1, cookieReportedTotal: 12, openApiFailures: 0 },
    filter: { completion: "all", statusKeys: ["status-testable"] },
    path: "D:/must-not-sync",
    rawTasks: [{ id: "must-not-sync" }],
  };
  const saved = store.setConfigInferenceTaskSource(PID, source);
  assert.equal(saved.ok, true);
  assert.deepEqual(saved.data.counts, { all: 12, pending: 3, completed: 9 });
  assert.equal(saved.data.fetchSource, "open-api+cookie-source");
  assert.deepEqual(saved.data.filter, { completion: "all", statusKeys: ["status-testable"] });
  assert.equal(saved.data.statusCounts.find((row) => row.name === "可提测")?.count, 8);
  assert.deepEqual(saved.data.acquisition, {
    fetchSource: "open-api+cookie-source",
    openApiMatched: 4,
    cookieMatched: 12,
    mergedMatched: 12,
    completionStates: ["pending", "completed"],
    taskflowStatusFilter: "none",
    cookieComplete: true,
    cookiePages: 1,
    cookieReportedTotal: 12,
    openApiFailures: 0,
  });
  assert.equal("path" in saved.data, false);
  assert.equal("rawTasks" in saved.data, false);

  const oldBundle = structuredClone(store.getSharedBundle());
  assert.equal(oldBundle.aiTrainingSnapshot.schemaVersion, 1);
  assert.equal(oldBundle.aiTrainingSnapshot.byProject[PID].configInference.settings.taskSource.sectionId, "section-1");
  assert.ok(oldBundle.sharedOps.some((op) => op.path?.join("/") === "aiTraining/configInference/settings"));
  assert.equal(store.getConfigInferenceData(PID).memoryScope.lanSync, true);

  const cleared = store.clearConfigInferenceTaskSource(PID);
  assert.equal(cleared.ok, true);
  assert.equal(store.getConfigInferenceTaskSource(PID), null);
  const versionAfterClear = store.getSharedVersion();
  const replay = store.applySharedBundle(oldBundle);
  assert.equal(replay.applied, false, "旧 snapshot/op 都应被 LWW 与持久 clock 拒绝");
  assert.equal(store.getSharedVersion(), versionAfterClear, "收到旧 loser op 不得制造新 sharedVersion");
  assert.equal(store.getConfigInferenceTaskSource(PID), null);
});

test("AI训练 snapshot 按时间 LWW 合并并用 tombstone 阻止旧 run 复活", () => {
  const first = store.applySharedBundle({
    version: 100,
    sharedOps: [],
    aiTrainingSnapshot: {
      schemaVersion: 1,
      version: 100,
      byProject: {
        [PID]: {
          configInference: {
            runs: {
              live: { id: "live", projectId: PID, title: "new", updatedAt: 200 },
              removed: { id: "removed", projectId: PID, title: "stale", updatedAt: 100 },
            },
            samples: {},
            settings: {},
            tombstones: { runs: { removed: { updatedAt: 150, version: 100, node: "peer", opId: "delete-removed" } }, samples: {} },
          },
        },
      },
    },
  });
  assert.equal(first.applied, true);
  assert.deepEqual(store.getConfigInferenceData(PID).runs.map((row) => row.id), ["live"]);

  const staleReplay = store.applySharedBundle({
    version: 101,
    sharedOps: [],
    aiTrainingSnapshot: {
      schemaVersion: 1,
      version: 101,
      byProject: {
        [PID]: {
          configInference: {
            runs: {
              live: { id: "live", projectId: PID, title: "old", updatedAt: 50 },
              removed: { id: "removed", projectId: PID, title: "older", updatedAt: 90 },
            },
            samples: {}, settings: {}, tombstones: {},
          },
        },
      },
    },
  });
  assert.equal(staleReplay.applied, false);
  const rows = store.getConfigInferenceData(PID).runs;
  assert.equal(rows.find((row) => row.id === "live").title, "new");
  assert.equal(rows.some((row) => row.id === "removed"), false);
});

test("AI训练实际值映射随 snapshot/sharedOps 同步，LWW 与 tombstone 阻止旧值复活且不改写 raw 样本", () => {
  const logicalKey = "ci.branch.voice-feature.sync-test";
  const rawTarget = {
    targetId: "sync-binding-main",
    appName: "应用市场",
    vehicle: "avatr8678",
    repositoryId: "appMarket",
    repositoryName: "应用市场",
    branch: "release/default-branch",
    flavor: "avatr8678",
    targetRole: "primary",
    order: 1,
    fieldBindings: {
      branch: {
        logicalKey,
        actualValue: "release/default-branch",
        defaultValue: "release/default-branch",
        sourceValue: "VOICE_FEATURE_BRANCH",
        scopeKey: "application|appmarket|应用市场|avatr8678|branch",
        label: "语音功能分支",
        revision: 0,
        resolved: true,
      },
    },
  };
  const rawSample = {
    id: "sync-binding-sample",
    projectId: PID,
    source: "user_feedback",
    signals: { sources: { title: ["应用市场语音配置"] } },
    groundTruth: { targets: [rawTarget], noTargets: false },
    feedback: { decision: "corrected", rating: 5 },
    createdAt: 100,
    updatedAt: 100,
  };
  const remoteBinding = {
    id: logicalKey,
    logicalKey,
    dimension: "branch",
    actualValue: "feature/synced-new",
    defaultValue: "release/default-branch",
    sourceValue: "VOICE_FEATURE_BRANCH",
    scopeKey: rawTarget.fieldBindings.branch.scopeKey,
    label: "语音功能分支",
    resolved: true,
    revision: 2,
    history: [{ revision: 2, previousActualValue: "feature/synced-old", actualValue: "feature/synced-new", updatedAt: 200 }],
    createdAt: 150,
    updatedAt: 200,
  };
  const applied = store.applySharedBundle({
    version: 200,
    sharedOps: [],
    aiTrainingSnapshot: {
      schemaVersion: 1,
      version: 200,
      byProject: {
        [PID]: {
          configInference: {
            runs: {},
            samples: { [rawSample.id]: rawSample },
            trainedTickets: {},
            trainingClaims: {},
            valueBindings: { [logicalKey]: remoteBinding },
            settings: {},
            tombstones: {},
          },
        },
      },
    },
  });
  assert.equal(applied.applied, true);

  const overview = store.getConfigInferenceData(PID);
  const binding = overview.valueBindings.find((row) => row.logicalKey === logicalKey);
  const materializedTarget = overview.samples.find((row) => row.id === rawSample.id)?.groundTruth?.targets?.[0];
  assert.equal(binding.actualValue, "feature/synced-new");
  assert.equal(binding.revision, 2);
  assert.equal(materializedTarget.branch, "feature/synced-new");
  assert.equal(materializedTarget.fieldBindings.branch.logicalKey, logicalKey);

  const exported = store.getSharedBundle().aiTrainingSnapshot.byProject[PID].configInference;
  assert.equal(exported.samples[rawSample.id].groundTruth.targets[0].branch, "release/default-branch", "读时物化不能覆盖 snapshot 中的 raw 学习值");
  assert.equal(exported.samples[rawSample.id].groundTruth.targets[0].fieldBindings.branch.logicalKey, logicalKey);
  assert.equal(exported.valueBindings[logicalKey].actualValue, "feature/synced-new");

  const stale = store.applySharedBundle({
    version: 201,
    sharedOps: [],
    aiTrainingSnapshot: {
      schemaVersion: 1,
      version: 201,
      byProject: {
        [PID]: {
          configInference: {
            runs: {}, samples: {}, trainedTickets: {}, trainingClaims: {}, settings: {}, tombstones: {},
            valueBindings: {
              [logicalKey]: { ...remoteBinding, actualValue: "feature/stale", revision: 1, updatedAt: 150 },
            },
          },
        },
      },
    },
  });
  assert.equal(stale.applied, false);
  assert.equal(store.getConfigInferenceData(PID).valueBindings.find((row) => row.logicalKey === logicalKey).actualValue, "feature/synced-new");

  const removed = store.applySharedBundle({
    version: 300,
    sharedOps: [{
      id: "peer-z:300:delete-binding",
      node: "peer-z",
      version: 300,
      at: 300,
      type: "byProject.delete",
      projectId: PID,
      path: ["aiTraining", "configInference", "valueBindings", logicalKey],
    }],
  });
  assert.equal(removed.applied, true);
  const afterDelete = store.getConfigInferenceData(PID);
  assert.equal(afterDelete.samples.find((row) => row.id === rawSample.id)?.groundTruth?.targets?.[0]?.branch, "release/default-branch");
  assert.equal(afterDelete.valueBindings.find((row) => row.logicalKey === logicalKey)?.actualValue, "release/default-branch");

  const replay = store.applySharedBundle({
    version: 301,
    sharedOps: [],
    aiTrainingSnapshot: {
      schemaVersion: 1,
      version: 301,
      byProject: {
        [PID]: {
          configInference: {
            runs: {}, samples: {}, trainedTickets: {}, trainingClaims: {}, settings: {}, tombstones: {},
            valueBindings: { [logicalKey]: remoteBinding },
          },
        },
      },
    },
  });
  assert.equal(replay.applied, false, "binding tombstone 必须阻止旧实际值从 snapshot 复活");
  assert.equal(store.getConfigInferenceData(PID).valueBindings.find((row) => row.logicalKey === logicalKey)?.actualValue, "release/default-branch");
});

test("additive checkpoint 同 ID 扩容时仍合并仓库选项与车型 tuple，并对不同到达顺序确定性收敛", () => {
  const repoId = "merge-repo";
  const vehicle = "merge-car";
  const mergeStrategy = "config_inference_additive";
  const baseDef = {
    id: repoId, name: "合并仓库", https: "https://example.com/merge-repo.git",
    branchOptions: ["base"], flavorOptions: ["base"],
  };
  const baseVehicle = {
    aliases: ["base"],
    apps: [{ appName: "应用市场", repos: [{ repoId, branch: "base", flavor: "base" }] }],
  };
  const reset = () => db.setUserData("__devbench_shared__", "shared", {
    projectDefs: [baseDef],
    byProject: { [PID]: { vehicleMap: { [vehicle]: baseVehicle } } },
    dingtalkMsgConfig: null,
    repositoryInferenceProfilesVersion: 1,
    _sharedVersion: 1,
    sharedOps: [],
    sharedOpClocks: {},
  }, "test");
  const pair = (label, node, version) => {
    const def = {
      ...baseDef,
      branchOptions: [label],
      flavorOptions: [label],
    };
    const mapping = {
      aliases: [label],
      apps: [{ appName: "应用市场", repos: [{ repoId, branch: label, flavor: label }] }],
    };
    return [
      {
        id: `${node}:${version}:project`, node, version, at: version,
        type: "projectDef.set", value: def, mergeStrategy,
      },
      {
        id: `${node}:${version}:vehicle`, node, version, at: version,
        type: "byProject.set", projectId: PID, path: ["vehicleMap", vehicle],
        value: mapping, mergeStrategy,
      },
    ];
  };
  const l1 = pair("branch-l1", "node-l1", 10);
  const l2 = pair("branch-l2", "node-l2", 20);
  const winner = pair("branch-w", "node-w", 30);

  reset();
  assert.equal(store.applySharedBundle({ version: 30, sharedOps: [...l1, ...l2, ...winner] }).applied, true);
  const enrichedBundle = store.getSharedBundle();
  const enrichedWinnerOps = enrichedBundle.sharedOps.filter((op) => winner.some((row) => row.id === op.id));
  assert.equal(enrichedWinnerOps.length, 2);
  assert.deepEqual(
    store.getProjectDef(repoId).branchOptions,
    ["base", "branch-l1", "branch-l2", "branch-w"],
  );

  reset();
  assert.equal(store.applySharedBundle({ version: 30, sharedOps: winner }).applied, true);
  assert.deepEqual(store.getProjectDef(repoId).branchOptions, ["branch-w", "base"], "单节点写入保留用户顺序");
  const expanded = store.applySharedBundle({ version: enrichedBundle.version, sharedOps: enrichedWinnerOps });
  assert.equal(expanded.applied, true, "同 ID 但已扩大的 checkpoint 不能被 existingIds 直接丢弃");
  assert.deepEqual(
    store.getProjectDef(repoId).branchOptions,
    ["base", "branch-l1", "branch-l2", "branch-w"],
  );
  assert.deepEqual(
    store.getRemoteConfig(PID).vehicleMap[vehicle].entries.map((entry) => `${entry.branch}|${entry.flavor}`),
    ["base|base", "branch-l1|branch-l1", "branch-l2|branch-l2", "branch-w|branch-w"],
  );
  assert.equal(store.applySharedBundle({ version: enrichedBundle.version, sharedOps: enrichedWinnerOps }).applied, false);
});

test("shared op 同路径按 version/node/id 确定性收敛并拒绝危险路径", () => {
  const op = (node, value) => ({
    id: `${node}:100:same-path`, node, version: 100, at: 100,
    type: "byProject.set", projectId: PID,
    path: ["keywordMappings", "tag", "极氪9X"],
    value: { category: "vehicle", value },
  });
  const runOrder = (ops) => {
    db.setUserData("__devbench_shared__", "shared", {
      byProject: {}, dingtalkMsgConfig: null, _sharedVersion: 1, sharedOps: [], sharedOpClocks: {},
    }, "test");
    const result = store.applySharedBundle({ version: 100, sharedOps: ops });
    assert.equal(result.applied, true);
    return store.getKeywordMappings(PID).tag["极氪9X"].value;
  };
  assert.equal(runOrder([op("node-z", "zeekr9x"), op("node-a", "wrong")]), "zeekr9x");
  assert.equal(runOrder([op("node-a", "wrong"), op("node-z", "zeekr9x")]), "zeekr9x");

  const beforeVersion = store.getSharedVersion();
  const malicious = store.applySharedBundle({
    version: beforeVersion + 1000,
    sharedOps: [{
      id: "evil:1", node: "evil", version: beforeVersion + 1000,
      type: "byProject.set", projectId: PID,
      path: ["__proto__", "polluted"], value: true,
    }],
  });
  assert.equal(malicious.applied, false);
  assert.equal(store.getSharedVersion(), beforeVersion);
  assert.equal(Object.prototype.polluted, undefined);
});

test("配置推理写操作拒绝缺失 projectId", () => {
  assert.equal(store.runConfigInference("", { ticket: { title: "missing project" }, captureSignals: false }).ok, false);
  assert.equal(store.reviewConfigInferenceRun("", "missing", { decision: "correct" }).ok, false);
  assert.equal(store.deleteConfigInferenceRun("", "missing").ok, false);
  assert.equal(store.setConfigInferenceTaskSource("", { sectionId: "x" }).ok, false);
  assert.equal(store.clearConfigInferenceTaskSource("").ok, false);
});

test("仓库身份统一 SSH/HTTPS 并可绑定另一份本机备份", () => {
  assert.equal(
    store.repositoryKey("git@example.com:team/AppMarket.git"),
    store.repositoryKey("https://example.com/team/AppMarket.git"),
  );
  const repoDir = path.join(tmp, "https-backup-repo");
  fs.rmSync(repoDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, ".git", "config"), '[remote "origin"]\n\turl = https://example.com/team/AppMarket.git\n');
  assert.equal(store.upsertProjectDef({ id: "canonical-market", name: "Canonical Market", ssh: "git@example.com:team/AppMarket.git" }).ok, true);
  assert.equal(store.upsertProject({ id: "backup-market", name: "Backup Market", path: repoDir }).ok, true);
  assert.equal(store.findAvailableSameProject("canonical-market", "git@example.com:team/AppMarket.git")?.id, "backup-market");
});

test("配置推理从受管 worktree 恢复主工程和关联工程的实时配置", () => {
  const mainId = "worktree-inference-main";
  const extraId = "worktree-inference-extra";
  for (const [id, name] of [[mainId, "Worktree Main"], [extraId, "Worktree Extra"]]) {
    assert.equal(store.upsertProjectDef({
      id,
      name,
      ssh: `git@example.com:team/${id}.git`,
      projectType: "tooling",
      inferenceEnabled: true,
    }).ok, true);
  }
  const createRepo = (folder, branch) => {
    const repoPath = path.join(tmp, folder);
    fs.rmSync(repoPath, { recursive: true, force: true });
    fs.mkdirSync(path.join(repoPath, ".git"), { recursive: true });
    fs.writeFileSync(path.join(repoPath, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
    fs.writeFileSync(path.join(repoPath, ".git", "config"), `[remote "origin"]\n\turl = git@example.com:team/${folder.replace(/^wt-/, "worktree-inference-")}.git\n`);
    return repoPath;
  };
  const mainBase = createRepo("main-base", "base-main");
  const extraBase = createRepo("extra-base", "base-extra");
  const mainWorktree = createRepo("wt-main", "story-main");
  const extraWorktree = createRepo("wt-extra", "story-extra");
  assert.equal(store.upsertProject({ id: mainId, name: "Main Base", path: mainBase }).ok, true);
  assert.equal(store.upsertProject({ id: extraId, name: "Extra Base", path: extraBase }).ok, true);

  const actual = store.getTabConfigInferenceActual({
    id: "tab-worktree-inference",
    mode: "local",
    primaryProjectId: mainId,
    worktree: {
      managed: true,
      entries: [
        { role: "primary", baseProjectId: mainId, basePath: mainBase, path: mainWorktree },
        { role: "extra", baseProjectId: extraId, basePath: extraBase, path: extraWorktree },
      ],
    },
    extraProjects: [{ name: "Extra", path: extraWorktree, basePath: extraBase, baseProjectId: extraId }],
    flavors: [
      { path: mainWorktree, flavor: "mainProd" },
      { path: extraWorktree, flavor: "sdkProd" },
    ],
  }, PID);
  assert.deepEqual(actual.targets.map((target) => target.repositoryId), [mainId, extraId]);
  assert.deepEqual(actual.targets.map((target) => target.branch), ["story-main", "story-extra"]);
  assert.deepEqual(actual.targets.map((target) => target.flavor), ["mainProd", "sdkProd"]);
  assert.deepEqual(actual.targets.map((target) => target.targetRole), ["primary", "dependency"]);
});

test("配置推理：当前分支不同时复用唯一同仓本机工程，多份候选由用户选择并记忆", () => {
  const repositoryId = "canonical-local";
  const remote = "git@example.com:team/CanonicalLocal.git";
  assert.equal(store.upsertProjectDef({
    id: repositoryId,
    name: "本机匹配仓库",
    ssh: remote,
    projectType: "tooling",
    inferenceEnabled: true,
  }).ok, true);

  const createCheckout = (id, name, branch) => {
    const repoDir = path.join(tmp, id);
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, ".git", "config"), `[remote "origin"]\n\turl = ${remote}\n`);
    fs.writeFileSync(path.join(repoDir, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
    assert.equal(store.upsertProject({ id, name, path: repoDir }).ok, true);
    return repoDir;
  };
  const firstPath = createCheckout("local-checkout-a", "本机源码 A", "develop");
  const target = {
    targetId: "local-target",
    repositoryId,
    repositoryName: "本机匹配仓库",
    branch: "feature/target",
    flavor: "",
    projectType: "tooling",
    repositoryOnly: true,
    targetRole: "standalone",
    order: 1,
  };

  const unique = store.buildConfigInferenceSnapshot(PID, [target]);
  assert.equal(unique.ok, true, unique.error);
  assert.equal(unique.snapshot.mode, "local", "唯一同远程源码即使当前分支不同也应直接复用");
  assert.equal(unique.snapshot.primaryProjectId, "local-checkout-a");
  assert.equal(unique.snapshot.branches[firstPath], "feature/target");
  assert.equal(unique.localResolution.targets[0].matchKind, "same_remote");

  const secondPath = createCheckout("local-checkout-b", "本机源码 B", "release/other");
  const ambiguous = store.buildConfigInferenceSnapshot(PID, [target]);
  assert.equal(ambiguous.snapshot.mode, "remote", "多份同仓且没有精确分支时不能擅自选择");
  assert.equal(ambiguous.localResolution.targets[0].matchKind, "ambiguous");
  assert.deepEqual(ambiguous.localResolution.targets[0].candidates.filter((row) => row.remoteMatch).map((row) => row.id).sort(), ["local-checkout-a", "local-checkout-b"]);

  const explicitRemote = store.buildConfigInferenceSnapshot(PID, [target], {
    localProjectBindings: [{ targetId: target.targetId, repositoryId, branch: target.branch, useRemote: true }],
  });
  assert.equal(explicitRemote.snapshot.mode, "remote");
  assert.equal(explicitRemote.localResolution.targets[0].matchKind, "remote_selected");

  const selected = store.buildConfigInferenceSnapshot(PID, [target], {
    localProjectBindings: [{ targetId: target.targetId, repositoryId, branch: target.branch, projectId: "local-checkout-b" }],
  });
  assert.equal(selected.snapshot.mode, "local");
  assert.equal(selected.snapshot.primaryProjectId, "local-checkout-b");
  assert.equal(selected.snapshot.branches[secondPath], "feature/target");

  const remembered = store.__testRememberConfigInferenceLocalBindings([
    { targetId: target.targetId, repositoryId, branch: target.branch, projectId: "local-checkout-b" },
  ]);
  assert.equal(remembered[repositoryId][target.branch].projectId, "local-checkout-b");
  const learned = store.buildConfigInferenceSnapshot(PID, [target]);
  assert.equal(learned.snapshot.mode, "local");
  assert.equal(learned.snapshot.primaryProjectId, "local-checkout-b");
  assert.equal(learned.localResolution.targets[0].matchKind, "remembered");

  const localConfig = JSON.parse(fs.readFileSync(LOCAL_PROJECTS, "utf8"));
  assert.equal(localConfig.version, 4);
  assert.equal(localConfig.repositoryBindings[repositoryId][target.branch].projectId, "local-checkout-b");
  assert.equal(Object.hasOwn(localConfig.repositoryBindings[repositoryId][target.branch], "path"), false, "绑定记忆只能保存本机工程 ID，不能重复写绝对路径");
});

test("配置推理：WebApp 必须作为独立本机工程显式绑定且再次打开仍为本地", () => {
  const mainRepositoryId = "canonical-main-with-webapp";
  const webRepositoryId = "webApp";
  assert.equal(store.upsertProjectDef({
    id: mainRepositoryId,
    name: "含 WebApp 的主工程",
    ssh: "git@example.com:team/MainWithWebApp.git",
    projectType: "tooling",
    inferenceEnabled: true,
  }).ok, true);
  assert.ok(store.getProjectDef(webRepositoryId), "测试配置应包含标准 WebApp 仓库定义");

  const mainPath = path.join(tmp, "local-main-with-webapp");
  const webAppPath = path.join(tmp, "local-main-with-webapp-child");
  for (const [repoPath, remote, branch] of [
    [mainPath, "git@example.com:team/MainWithWebApp.git", "develop"],
    [webAppPath, "git@example.com:team/WebApp.git", "develop-web"],
  ]) {
    fs.rmSync(repoPath, { recursive: true, force: true });
    fs.mkdirSync(path.join(repoPath, ".git"), { recursive: true });
    fs.writeFileSync(path.join(repoPath, ".git", "config"), `[remote "origin"]\n\turl = ${remote}\n`);
    fs.writeFileSync(path.join(repoPath, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
  }
  const legacyCombined = store.upsertProject({
    id: "local-main-with-webapp",
    name: "本机主工程",
    path: mainPath,
    webAppPath,
  });
  assert.equal(legacyCombined.ok, false);
  assert.match(legacyCombined.error, /WebApp.*独立工程/);
  assert.equal(store.upsertProject({
    id: "local-main-with-webapp",
    name: "本机主工程",
    path: mainPath,
  }).ok, true);
  assert.equal(store.upsertProject({
    id: "local-webapp-independent",
    name: "本机 WebApp",
    path: webAppPath,
  }).ok, true);

  const targets = [{
    targetId: "target-main-with-webapp",
    repositoryId: mainRepositoryId,
    repositoryName: "含 WebApp 的主工程",
    branch: "release/main-target",
    flavor: "mainProd",
    projectType: "tooling",
    repositoryOnly: true,
    targetRole: "primary",
    order: 1,
  }, {
    targetId: "target-inherited-webapp",
    repositoryId: webRepositoryId,
    repositoryName: "WebApp",
    branch: "release/web-target",
    flavor: "webProd",
    projectType: "tooling",
    repositoryOnly: true,
    targetRole: "dependency",
    order: 2,
  }];
  const bindings = [{
    targetId: targets[0].targetId,
    repositoryId: mainRepositoryId,
    branch: targets[0].branch,
    projectId: "local-main-with-webapp",
  }, {
    targetId: targets[1].targetId,
    repositoryId: webRepositoryId,
    branch: targets[1].branch,
    projectId: "local-webapp-independent",
  }];
  const selected = store.buildConfigInferenceSnapshot(PID, targets, {
    allowCurrentTargets: targets,
    localProjectBindings: bindings,
  });
  assert.equal(selected.ok, true, selected.error);
  assert.equal(selected.snapshot.mode, "local");
  assert.equal(selected.snapshot.primaryProjectId, "local-main-with-webapp");
  assert.deepEqual(selected.snapshot.extraProjects, [{ path: webAppPath, name: "本机 WebApp" }]);
  assert.equal(selected.snapshot.branches[mainPath], "release/main-target");
  assert.equal(selected.snapshot.branches[webAppPath], "release/web-target");
  assert.deepEqual(selected.snapshot.flavors, [
    { path: mainPath, flavor: "mainProd" },
    { path: webAppPath, flavor: "webProd" },
  ]);
  assert.equal(selected.localResolution.targets[1].selectionRequired, true);
  assert.equal(selected.localResolution.targets[1].matchKind, "user_selected");
  assert.equal(selected.localResolution.targets[1].selectedProjectId, "local-webapp-independent");

  store.__testRememberConfigInferenceLocalBindings(bindings);
  const reopened = store.buildConfigInferenceSnapshot(PID, targets, { allowCurrentTargets: targets });
  assert.equal(reopened.snapshot.mode, "local");
  assert.equal(reopened.snapshot.primaryProjectId, "local-main-with-webapp");
  assert.equal(reopened.localResolution.targets[0].matchKind, "remembered");
  assert.equal(reopened.localResolution.targets[1].matchKind, "remembered");
  assert.equal(reopened.localResolution.targets[1].selectedProjectId, "local-webapp-independent");
});

test("共享配置：拒绝不同作用域 bundle，并清理已知测试仓库夹具", () => {
  const before = store.getSharedVersion();
  const rejected = store.applySharedBundle({
    syncScope: "test:foreign-suite",
    version: before + 100,
    projectDefs: [{ id: "foreign", name: "不应同步" }],
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.scopeMismatch, true);
  assert.equal(store.getSharedVersion(), before);
  assert.equal(store.getSharedBundle().syncScope, "production");

  const cleaned = store.__testCleanSyntheticProjectDefs([
    { id: "market", name: "测试市场", ssh: "git@example.com:apps/market.git" },
    { id: "custom-app", name: "测试应用", https: "https://git.example.com/team/custom-app.git" },
    { id: "market", name: "真实同名 ID", ssh: "git@codeup.aliyun.com:xunihezi/real-market.git" },
    {
      id: "appMarketSdk",
      name: "应用市场SDK",
      ssh: "git@codeup.aliyun.com:xunihezi/AppMarket.git",
      customRepositoryMetadata: { owner: "sdk-owner", module: "voice-sdk" },
      releasePolicy: { channel: "sdk-stable", requireSignedArtifact: true },
    },
  ]);
  assert.equal(cleaned.some((def) => def.name === "测试市场"), false);
  assert.equal(cleaned.some((def) => def.id === "custom-app"), false);
  assert.equal(cleaned.some((def) => def.name === "真实同名 ID"), true, "非 example.com 的同 ID 真实配置必须保留");
  const sdk = cleaned.find((def) => def.id === "appMarketSdk");
  assert.equal(Object.hasOwn(sdk, "customRepositoryMetadata"), false);
  assert.equal(Object.hasOwn(sdk, "releasePolicy"), false);

  const cleanedState = store.__testCleanSyntheticSharedState({
    byProject: {
      [PID]: { keywordMappings: { tag: { real: { category: "app", value: "real" } } } },
      "project-a": { aiTraining: { configInference: { settings: {} } } },
      "project-config-writeback": { vehicleMap: { fixture: { apps: [] } } },
      "symbol-resolution-concurrency-project": { aiTraining: { configInference: { runs: { fixture: { id: "fixture" } } } } },
    },
  });
  assert.deepEqual(Object.keys(cleanedState.byProject), [PID, "project-a"]);
  assert.equal(cleanedState.byProject[PID].keywordMappings.tag.real.value, "real");

  const remoteVersion = store.getSharedVersion() + 1000;
  const applied = store.applySharedBundle({
    syncScope: "production",
    version: remoteVersion + 1,
    sharedOps: [
      {
        id: `remote-real-${remoteVersion}`,
        node: "remote-production-node",
        version: remoteVersion,
        at: remoteVersion,
        type: "byProject.set",
        projectId: PID,
        path: ["keywordMappings", "tag", "remote-real"],
        value: { category: "app", value: "remote-real" },
      },
      {
        id: `remote-fixture-${remoteVersion + 1}`,
        node: "remote-production-node",
        version: remoteVersion + 1,
        at: remoteVersion + 1,
        type: "byProject.set",
        projectId: "project-a",
        path: ["aiTraining", "configInference", "settings"],
        value: { fixture: true },
      },
    ],
    byProject: {
      "project-a": { aiTraining: { configInference: { settings: { fixture: true } } } },
    },
  });
  assert.equal(applied.ok, true);
  assert.equal(applied.applied, true);
  assert.equal(applied.ignoredSyntheticOps, 1);
  assert.equal(store.getKeywordMappings(PID).tag["remote-real"].value, "remote-real");
  assert.equal(store.getSharedBundle().byProject["project-a"], undefined);
  assert.deepEqual(
    cleanedState.byProject["project-a"].aiTraining.configInference.settings,
    {},
    "测试桶中的空 settings 只是稳定空容器，不得反复生成删除操作和 sharedVersion",
  );
});

test("故事点组队：切换当前成员时复用组内工程配置但保留各自 TB 单", () => {
  const p47 = path.join(tmp, "group-carb-12947");
  const p49 = path.join(tmp, "group-carb-12949");
  const pExtra = path.join(tmp, "group-carb-extra");
  fs.mkdirSync(p47, { recursive: true });
  fs.mkdirSync(p49, { recursive: true });
  fs.mkdirSync(pExtra, { recursive: true });
  store.upsertProject({ id: "carb-12947-project", name: "CARB-12947 工程", path: p47 });
  store.upsertProject({ id: "carb-12949-project", name: "CARB-12949 原工程", path: p49 });

  const anchor = store.createTab({ title: "#CARB-12947# 组队来源" });
  const target = store.createTab({ title: "#CARB-12949# 组队目标" });
  store.updateTab(anchor.id, {
    engine: "codex",
    projectDefId: "appMarket",
    primaryProjectId: "carb-12947-project",
    mode: "remote",
    flavors: [{ path: p47, flavor: "geelyss21" }],
    deviceSerial: "device-12947",
    apkSourcePath: path.join(p47, "app-release.apk"),
    extraProjects: [{ path: pExtra, name: "关联工程" }],
    remotePull: {
      tbId: "CARB-12947",
      entries: [{ repoId: "appMarket", branch: "feature/CARB-12947", flavor: "geelyss21", localPath: p47 }],
      vehicle: "ss21",
    },
    remoteRepos: [{ key: "appMarket", path: p47, name: "AppMarket-CARB-12947", role: "primary", branch: "feature/CARB-12947", flavor: "geelyss21", ok: true }],
    cloneStatus: "done",
    remoteLocalizedAt: 12947000,
    ticketUrl: "https://tb.example.com/CARB-12947",
    tbTaskId: "tb-12947",
    carbId: "CARB-12947",
    reportMode: "expert",
    skipTestAcceptance: true,
  });
  store.updateTab(target.id, {
    engine: "gemini",
    projectDefId: "webApp",
    primaryProjectId: "carb-12949-project",
    mode: "local",
    flavors: [{ path: p49, flavor: "old" }],
    deviceSerial: "device-12949",
    cliSessionId: "claude-old-session",
    cliSessionEngine: "claude",
    cliSessionIds: { claude: "claude-old-session", codex: "codex-old-session", gemini: "gemini-old-session" },
    remoteAgentSessionId: "remote-old-session",
    remoteAgentLastEventId: "remote-old-event",
    remotePull: {
      tbId: "CARB-12949",
      entries: [{ repoId: "appMarket", branch: "feature/CARB-12949-old", flavor: "old", localPath: p49 }],
      vehicle: "old",
    },
    ticketUrl: "https://tb.example.com/CARB-12949",
    tbTaskId: "tb-12949",
    carbId: "CARB-12949",
    reportMode: "short",
    skipTestAcceptance: false,
  });

  const joined = store.joinGroup(target.id, anchor.id);
  assert.equal(joined.ok, true);
  assert.equal(joined.inheritedConfig, true);
  let afterJoin = store.getTab(target.id);
  assert.equal(afterJoin.engine, "codex");
  assert.equal(afterJoin.primaryProjectId, "carb-12947-project");
  assert.equal(afterJoin.projectDefId, "appMarket");
  assert.equal(afterJoin.mode, "remote");
  assert.deepEqual(afterJoin.flavors, [{ path: p47, flavor: "geelyss21" }]);
  assert.equal(afterJoin.deviceSerial, "device-12947");
  assert.equal(afterJoin.cliSessionId, null);
  assert.equal(afterJoin.cliSessionEngine, null);
  assert.deepEqual(afterJoin.cliSessionIds, {});
  assert.equal(afterJoin.remoteAgentSessionId, null);
  assert.equal(afterJoin.remoteAgentLastEventId, null);
  assert.equal(afterJoin.deviceChangeNotice.from, "device-12949");
  assert.equal(afterJoin.deviceChangeNotice.to, "device-12947");
  assert.equal(afterJoin.apkSourcePath, path.join(p47, "app-release.apk"));
  assert.deepEqual(afterJoin.extraProjects, [{ path: pExtra, name: "关联工程" }]);
  assert.deepEqual(afterJoin.remotePull.entries.map((x) => x.branch), ["feature/CARB-12947"]);
  assert.equal(afterJoin.remotePull.tbId, "CARB-12949");
  assert.deepEqual(afterJoin.remoteRepos.map((x) => x.path), [p47]);
  assert.equal(afterJoin.cloneStatus, "done");
  assert.equal(afterJoin.remoteLocalizedAt, 12947000);
  assert.equal(afterJoin.ticketUrl, "https://tb.example.com/CARB-12949");
  assert.equal(afterJoin.tbTaskId, "tb-12949");
  assert.equal(afterJoin.carbId, "CARB-12949");
  assert.equal(afterJoin.reportMode, "short", "组队只共享工程配置，不能覆盖目标 TB 单的报告模式");
  assert.equal(afterJoin.skipTestAcceptance, true, "故事点组只有一轮统一验收，新成员必须继承组内跳过选择");

  store.updateTab(anchor.id, {
    engine: "gemini",
    primaryProjectId: "carb-12949-project",
    flavors: [{ path: p49, flavor: "geelyss22" }],
    deviceSerial: "device-updated",
    remotePull: {
      tbId: "CARB-12947",
      entries: [{ repoId: "appMarket", branch: "feature/CARB-12947-updated", flavor: "geelyss22", localPath: p49 }],
      vehicle: "ss22",
    },
    remoteRepos: [{ key: "appMarket", path: p49, name: "AppMarket-CARB-12947", role: "primary", branch: "feature/CARB-12947-updated", flavor: "geelyss22", ok: true }],
    remoteLocalizedAt: 12947001,
  });
  store.updateTab(target.id, {
    cliSessionId: "codex-target-session",
    cliSessionEngine: "codex",
    cliSessionIds: { codex: "codex-target-session" },
    remoteAgentSessionId: "remote-target-session",
    remoteAgentLastEventId: "remote-target-event",
  });
  const active = store.setGroupActive(joined.groupId, target.id);
  assert.equal(active.ok, true);
  assert.equal(active.inheritedConfig, true);
  afterJoin = store.getTab(target.id);
  const source = store.getTab(anchor.id);
  assert.equal(afterJoin.groupActive, true);
  assert.equal(source.groupActive, false);
  assert.equal(afterJoin.engine, "gemini");
  assert.equal(afterJoin.cliSessionId, null);
  assert.equal(afterJoin.cliSessionEngine, null);
  assert.deepEqual(afterJoin.cliSessionIds, {});
  assert.equal(afterJoin.remoteAgentSessionId, null);
  assert.equal(afterJoin.remoteAgentLastEventId, null);
  assert.equal(afterJoin.primaryProjectId, "carb-12949-project");
  assert.deepEqual(afterJoin.flavors, [{ path: p49, flavor: "geelyss22" }]);
  assert.equal(afterJoin.deviceSerial, "device-updated");
  assert.deepEqual(afterJoin.remotePull.entries.map((x) => x.branch), ["feature/CARB-12947-updated"]);
  assert.equal(afterJoin.remotePull.tbId, "CARB-12949");
  assert.deepEqual(afterJoin.remoteRepos.map((x) => x.path), [p49]);
  assert.equal(afterJoin.remoteLocalizedAt, 12947001);
  assert.equal(afterJoin.ticketUrl, "https://tb.example.com/CARB-12949");
  assert.equal(afterJoin.tbTaskId, "tb-12949");
  assert.equal(afterJoin.carbId, "CARB-12949");
  assert.equal(afterJoin.reportMode, "short", "切换组内活动成员也不能同步报告模式");
  assert.equal(afterJoin.skipTestAcceptance, true, "切换活动成员不能丢失组内统一的测试验收选择");

  removeStoryFixture(anchor.id);
  removeStoryFixture(target.id);
});

test("Windows 默认克隆父路径优先 D 盘，否则选择剩余空间最大的盘", () => {
  assert.equal(store.selectWindowsDefaultCloneParent([
    { root: "C:\\", freeBytes: 900 },
    { root: "D:\\", freeBytes: 1 },
    { root: "E:\\", freeBytes: 1200 },
  ]), "D:\\workspace\\AIProjects");

  assert.equal(store.selectWindowsDefaultCloneParent([
    { root: "C:\\", freeBytes: 900 },
    { root: "E:\\", freeBytes: 1200 },
    { root: "F:\\", freeBytes: 1000 },
  ]), "E:\\workspace\\AIProjects");
  assert.equal(store.selectWindowsDefaultCloneParent([]), "");
});

test("故事点原子迁组会 reconcile 旧组且保持新组唯一 active", () => {
  const oldAnchor = store.createTab({ title: "迁组旧锚点" });
  const moving = store.createTab({ title: "迁组成员" });
  const newAnchor = store.createTab({ title: "迁组新锚点" });
  const newMember = store.createTab({ title: "迁组新组成员" });
  const oldJoined = store.joinGroup(moving.id, oldAnchor.id);
  const newJoined = store.joinGroup(newMember.id, newAnchor.id);
  assert.equal(oldJoined.ok, true);
  assert.equal(newJoined.ok, true);

  const moved = store.joinGroup(moving.id, newAnchor.id);
  assert.equal(moved.ok, true);
  assert.equal(moved.movedFromGroupId, oldJoined.groupId);
  assert.equal(store.getTab(oldAnchor.id).groupId, null, "旧组仅剩一人时应解散");
  const members = store.getGroupMembers(newJoined.groupId);
  assert.deepEqual(new Set(members.map((tab) => tab.id)), new Set([newAnchor.id, newMember.id, moving.id]));
  assert.equal(members.filter((tab) => tab.groupActive).length, 1);

  for (const tab of [oldAnchor, moving, newAnchor, newMember]) removeStoryFixture(tab.id);
});

test("故事点组原子 join/active 保留已准备的本地 workspace 配置", () => {
  const anchor = store.createTab({ title: "workspace 来源" });
  const target = store.createTab({ title: "workspace 目标" });
  const targetWorkspace = {
    primaryProjectId: "target-project",
    flavors: [{ path: "target-path", flavor: "target-flavor" }],
    apkSourcePath: "target.apk",
    extraProjects: [{ path: "target-extra", name: "目标关联工程" }],
  };
  store.updateTab(anchor.id, {
    engine: "codex",
    primaryProjectId: "source-project",
    flavors: [{ path: "source-path", flavor: "source-flavor" }],
    apkSourcePath: "source.apk",
    extraProjects: [{ path: "source-extra", name: "来源关联工程" }],
  });
  store.updateTab(target.id, { engine: "gemini", ...targetWorkspace });

  const joined = store.joinGroup(target.id, anchor.id, { preserveLocalWorkspace: true });
  assert.equal(joined.ok, true);
  let current = store.getTab(target.id);
  assert.equal(current.engine, "codex", "非 workspace 的共享配置仍应继承");
  for (const [key, value] of Object.entries(targetWorkspace)) assert.deepEqual(current[key], value);

  store.updateTab(anchor.id, {
    engine: "claude",
    primaryProjectId: "source-project-updated",
    flavors: [{ path: "source-path-updated", flavor: "source-flavor-updated" }],
    apkSourcePath: "source-updated.apk",
    extraProjects: [{ path: "source-extra-updated", name: "来源关联工程更新" }],
  });
  const activated = store.setGroupActive(joined.groupId, target.id, { preserveLocalWorkspace: true });
  assert.equal(activated.ok, true);
  current = store.getTab(target.id);
  assert.equal(current.engine, "claude");
  for (const [key, value] of Object.entries(targetWorkspace)) assert.deepEqual(current[key], value);

  removeStoryFixture(anchor.id);
  removeStoryFixture(target.id);
});

test("故事点组 source token 过期时不迁组、不切 active，当前 active 幂等不覆盖配置", () => {
  const oldAnchor = store.createTab({ title: "CAS 旧锚点" });
  const moving = store.createTab({ title: "CAS 迁移成员" });
  const newAnchor = store.createTab({ title: "CAS 新锚点" });
  const newMember = store.createTab({ title: "CAS 新成员" });
  store.updateTab(oldAnchor.id, { engine: "codex" });
  store.updateTab(newAnchor.id, { engine: "codex", projectDefId: "repo-before" });
  const oldGroup = store.joinGroup(moving.id, oldAnchor.id).groupId;
  const newGroup = store.joinGroup(newMember.id, newAnchor.id).groupId;

  const joinPlan = store.planGroupJoin(moving.id, newAnchor.id);
  assert.equal(joinPlan.ok, true);
  store.updateTab(newAnchor.id, { engine: "gemini" });
  const staleJoin = store.joinGroup(moving.id, newAnchor.id, {
    expectedSourceToken: joinPlan.token,
  });
  assert.equal(staleJoin.code, "GROUP_SOURCE_CHANGED");
  assert.equal(store.getTab(moving.id).groupId, oldGroup);
  assert.equal(store.getGroupMembers(oldGroup).filter((tab) => tab.groupActive).length, 1);

  const activePlan = store.planGroupActive(newGroup, newMember.id);
  assert.equal(activePlan.ok, true);
  store.updateTab(newAnchor.id, { projectDefId: "repo-after" });
  const staleActive = store.setGroupActive(newGroup, newMember.id, {
    expectedSourceToken: activePlan.token,
  });
  assert.equal(staleActive.code, "GROUP_SOURCE_CHANGED");
  assert.equal(store.getTab(newMember.id).groupActive, false);
  assert.equal(store.getTab(newAnchor.id).groupActive, true);

  const activeBefore = store.getTab(newAnchor.id);
  const idempotentPlan = store.planGroupActive(newGroup, newAnchor.id);
  assert.equal(idempotentPlan.idempotent, true);
  const idempotent = store.setGroupActive(newGroup, newAnchor.id, {
    expectedSourceToken: idempotentPlan.token,
  });
  assert.equal(idempotent.idempotent, true);
  assert.equal(store.getTab(newAnchor.id).engine, activeBefore.engine);
  assert.equal(store.getTab(newAnchor.id).projectDefId, activeBefore.projectDefId);

  for (const tab of [oldAnchor, moving, newAnchor, newMember]) removeStoryFixture(tab.id);
});

test("故事点组队：整组关闭会一次性归档全部成员并保留组关系", () => {
  const anchor = store.createTab({ title: "#CARB-20001# 组队整组关闭来源" });
  const target = store.createTab({ title: "#CARB-20002# 组队整组关闭目标" });
  const joined = store.joinGroup(target.id, anchor.id);
  assert.equal(joined.ok, true);
  const groupId = joined.groupId;

  const r = store.closeGroup(groupId);
  assert.equal(r.ok, true);
  assert.equal(r.removed, 2);
  assert.equal(store.listTabs().some((t) => t.id === anchor.id || t.id === target.id), false);

  const closed = store.listClosedTabs().filter((t) => t.id === anchor.id || t.id === target.id);
  assert.equal(closed.length, 2);
  assert.deepEqual([...new Set(closed.map((t) => t.groupId))], [groupId]);
  assert.equal(closed.every((t) => t.groupActive === false), true);

  const reopened = store.reopenClosed(target.id);
  assert.equal(reopened.ok, true);
  assert.equal(reopened.restored, 2);
  assert.equal(reopened.groupRestored, groupId);
  assert.equal(reopened.tab.id, target.id);
  assert.equal(reopened.tab.groupId, groupId);
  assert.equal(reopened.tab.groupActive, true);
  const restored = store.listTabs().filter((t) => t.id === anchor.id || t.id === target.id);
  assert.equal(restored.length, 2);
  assert.deepEqual([...new Set(restored.map((t) => t.groupId))], [groupId]);
  assert.equal(restored.filter((t) => t.groupActive).length, 1);
  assert.equal(store.listClosedTabs().some((t) => t.id === anchor.id || t.id === target.id), false);

  removeStoryFixture(anchor.id);
  removeStoryFixture(target.id);
});

test("故事点新建复制配置：同步完整工程字段并按新标题保留 TB 单", () => {
  const p = path.join(tmp, "copy-config-main");
  fs.mkdirSync(p, { recursive: true });
  store.upsertProject({ id: "copy-config-project", name: "复制配置工程", path: p });
  const source = store.createTab({ title: "#CARB-12947# 复制来源" });
  store.updateTab(source.id, {
    engine: "codex",
    projectDefId: "appMarket",
    mode: "remote",
    primaryProjectId: "copy-config-project",
    remotePull: {
      tbId: "CARB-12947",
      vehicle: "ss21",
      entries: [{ projectId: "appMarket", branch: "feature/CARB-12947", flavor: "ss21" }],
    },
    remoteRepos: [{ key: "appMarket", path: p, name: "AppMarket-CARB-12947", role: "primary", branch: "feature/CARB-12947", flavor: "ss21", ok: true }],
    cloneStatus: "done",
    remoteLocalizedAt: 12947002,
    reportMode: "expert",
  });

  const { tab } = store.createTabFromConfig("#CARB-12949# 复制目标", store.getTab(source.id));
  assert.equal(tab.engine, "codex");
  assert.equal(tab.projectDefId, "appMarket");
  assert.equal(tab.mode, "remote");
  assert.equal(tab.primaryProjectId, "copy-config-project");
  assert.equal(tab.remotePull.tbId, "CARB-12949");
  assert.deepEqual(tab.remotePull.entries.map((x) => x.branch), ["feature/CARB-12947"]);
  assert.deepEqual(tab.remoteRepos.map((x) => x.path), [p]);
  assert.equal(tab.cloneStatus, "done");
  assert.equal(tab.remoteLocalizedAt, 12947002);
  assert.equal(tab.reportMode, "short", "复制工程配置不能把来源 TB 单的专家报告模式带到目标单");

  removeStoryFixture(source.id);
  removeStoryFixture(tab.id);
});

test("待办任务：任务组字段支持单条、批量、重命名与清空", () => {
  const single = store.createTask({
    title: "任务组单条任务",
    taskGroupId: "task_group_alpha",
    taskGroupName: "发布验收组",
  });
  assert.equal(single.ok, true);
  assert.equal(single.task.taskGroupId, "task_group_alpha");
  assert.equal(single.task.taskGroupName, "发布验收组");

  const renamed = store.updateTask(single.task.id, {
    taskGroupId: "task_group_alpha",
    taskGroupName: "联调验收组",
  });
  assert.equal(renamed.ok, true);
  assert.equal(renamed.task.taskGroupName, "联调验收组");

  const moved = store.updateTask(single.task.id, { taskGroupId: "task_group_beta" });
  assert.equal(moved.ok, true);
  assert.equal(moved.task.taskGroupId, "task_group_beta");
  assert.equal(moved.task.taskGroupName, "联调验收组");

  const cleared = store.updateTask(single.task.id, { taskGroupId: "", taskGroupName: "" });
  assert.equal(cleared.ok, true);
  assert.equal(cleared.task.taskGroupId, undefined);
  assert.equal(cleared.task.taskGroupName, undefined);

  const batch = store.createTasksBatch([
    { title: "任务组批量任务 A", taskGroupId: "task_group_batch", taskGroupName: "批量验收组" },
    { title: "任务组批量任务 B", taskGroupId: "task_group_batch", taskGroupName: "批量验收组" },
  ]);
  assert.equal(batch.ok, true);
  assert.equal(batch.tasks.length, 2);
  assert.deepEqual([...new Set(batch.tasks.map((t) => t.taskGroupId))], ["task_group_batch"]);
  assert.deepEqual([...new Set(batch.tasks.map((t) => t.taskGroupName))], ["批量验收组"]);

  store.deleteTask(single.task.id);
  for (const t of batch.tasks) store.deleteTask(t.id);
});

test("待办任务：空任务组可持久化并在重新打开面板时恢复", () => {
  const gid = "task_group_empty_persist";
  const created = store.createTaskGroup({ id: gid, name: "空组持久化验收" });
  assert.equal(created.ok, true);
  assert.equal(created.group.id, gid);

  const reopenedGroups = store.listTaskGroups();
  assert.ok(reopenedGroups.some((g) => g.id === gid && g.name === "空组持久化验收"));
  assert.ok(store.exportData().taskGroups.some((g) => g.id === gid), "导出包应包含空任务组");

  const renamed = store.updateTaskGroup(gid, { name: "空组重命名验收" });
  assert.equal(renamed.ok, true);
  assert.ok(store.listTaskGroups().some((g) => g.id === gid && g.name === "空组重命名验收"));

  const task = store.createTask({ title: "空组删除成员迁移验收", taskGroupId: gid, taskGroupName: "空组重命名验收" });
  assert.equal(task.ok, true);
  const removed = store.deleteTaskGroup(gid, { clearTasks: true });
  assert.equal(removed.ok, true);
  assert.equal(removed.cleared, 1);
  const moved = store.listTasks().find((t) => t.id === task.task.id);
  assert.equal(moved.taskGroupId, undefined);
  assert.equal(moved.taskGroupName, undefined);
  assert.equal(store.listTaskGroups().some((g) => g.id === gid), false);

  store.deleteTask(task.task.id);
});

test("待办任务：星标与自定义标签支持创建、更新、清空和批量", () => {
  const single = store.createTask({
    title: "星标标签单条任务",
    pinned: true,
    starred: true,
    customTags: ["验收", "高亮", "验收", "  长 标签  "],
  });
  assert.equal(single.ok, true);
  assert.equal(single.task.pinned, true);
  assert.equal(single.task.starred, true);
  assert.deepEqual(single.task.customTags, ["验收", "高亮", "长 标签"]);

  const updated = store.updateTask(single.task.id, { pinned: false, starred: false, customTags: "阻塞，联调；高亮" });
  assert.equal(updated.ok, true);
  assert.equal(updated.task.pinned, undefined);
  assert.equal(updated.task.starred, undefined);
  assert.deepEqual(updated.task.customTags, ["阻塞", "联调", "高亮"]);

  const cleared = store.updateTask(single.task.id, { customTags: [] });
  assert.equal(cleared.ok, true);
  assert.equal(cleared.task.customTags, undefined);

  const batch = store.createTasksBatch([
    { title: "星标标签批量任务 A", pinned: true, starred: true, customTags: ["冒烟"] },
    { title: "星标标签批量任务 B", tags: "回归,重点" },
  ]);
  assert.equal(batch.ok, true);
  assert.equal(batch.tasks[0].pinned, true);
  assert.equal(batch.tasks[0].starred, true);
  assert.deepEqual(batch.tasks[0].customTags, ["冒烟"]);
  assert.deepEqual(batch.tasks[1].customTags, ["回归", "重点"]);

  store.deleteTask(single.task.id);
  for (const t of batch.tasks) store.deleteTask(t.id);
});

test("TB 候选任务：同步时带入 TB 优先级并允许编辑清空", () => {
  const imported = store.importTbTasks([
    { tbTaskId: "tb-prio-a", title: "TB 优先级紧急", priority: 0 },
    { tbTaskId: "tb-prio-b", title: "TB 优先级普通", priority: 1 },
  ]);
  assert.equal(imported.ok, true);
  assert.equal(imported.added, 2);
  assert.equal(imported.updated, 0);
  const repeated = store.importTbTasks([
    { tbTaskId: "tb-prio-a", title: "TB 优先级紧急", priority: 0 },
    { tbTaskId: "tb-prio-b", title: "TB 优先级普通", priority: 1 },
  ]);
  assert.equal(repeated.added, 0);
  assert.equal(repeated.updated, 2);
  const tasks = store.listTasks().filter((t) => t.tbTaskId?.startsWith("tb-prio-"));
  assert.deepEqual(tasks.map((t) => t.priority).sort(), ["P0", "P1"]);
  const edited = store.updateTask(tasks[0].id, { priority: "P3" });
  assert.equal(edited.task.priority, "P3");
  const cleared = store.updateTask(tasks[0].id, { priority: "" });
  assert.equal(cleared.task.priority, null);
  for (const t of tasks) store.deleteTask(t.id);
});

test("车型映射：prodReleaseDir 去空白保留 + needsResign 默认 false 不落字段 / true 落字段", () => {
  // needsResign 未给 → 归一化后不应出现该字段（默认 false 语义）
  let r = store.setVehicleMapping(PID, "f1", { apps: [], prodReleaseDir: "  \\\\srv\\rel  " });
  let vm = r.config.vehicleMap.f1;
  assert.equal(vm.prodReleaseDir, "\\\\srv\\rel", "prodReleaseDir 应去除首尾空白");
  assert.equal("needsResign" in vm, false, "needsResign 默认 false 不写字段");
  // needsResign true → 落字段
  r = store.setVehicleMapping(PID, "f2", { apps: [], needsResign: true });
  vm = r.config.vehicleMap.f2;
  assert.equal(vm.needsResign, true);
  // 再以不带 needsResign 的 mapping 覆盖同车型 → 旧 true 被清除（normalize 重建）
  r = store.setVehicleMapping(PID, "f2", { apps: [] });
  assert.equal("needsResign" in r.config.vehicleMap.f2, false, "覆盖后旧 needsResign 应被清除");
});

test("配置记忆：同签名(主工程+flavor+车型)去重累加权重 + tags/titleKeywords 并集 + 项目隔离", () => {
  const r1 = store.addConfigMemory(PID, { config: { primaryProjectId: "appMarket", flavor: "f" }, signals: { vehicle: "v", tags: ["a"], titleKeywords: ["k1"] }, sampleTitle: "t1" });
  assert.equal(r1.count, 1);
  const r2 = store.addConfigMemory(PID, { config: { primaryProjectId: "appMarket", flavor: "f" }, signals: { vehicle: "v", tags: ["b"], titleKeywords: ["k2"] }, sampleTitle: "t2" });
  assert.equal(r2.count, 2, "同签名应累加权重而非新增");
  assert.deepEqual(r2.signals.tags.sort(), ["a", "b"]);
  assert.deepEqual(r2.signals.titleKeywords.sort(), ["k1", "k2"]);
  assert.equal(store.getConfigMemories(PID).length, 1, "去重后仍是一条");
  // 不同车型 → 不同签名 → 新增
  store.addConfigMemory(PID, { config: { primaryProjectId: "appMarket", flavor: "f" }, signals: { vehicle: "v2", tags: [] } });
  assert.equal(store.getConfigMemories(PID).length, 2);
  // 缺 primaryProjectId → 不写入
  assert.equal(store.addConfigMemory(PID, { config: {}, signals: {} }), null);
  // 项目隔离
  assert.equal(store.getConfigMemories("projB").length, 0);
});

test("配置记忆：连续写入 201 条后快照与完整操作重放都只保留最新 200 条", () => {
  for (let index = 0; index < 201; index += 1) {
    store.addConfigMemory(PID, {
      config: { primaryProjectId: `app-${index}`, flavor: `flavor-${index}` },
      signals: { vehicle: `vehicle-${index}`, tags: [] },
    });
  }

  const expected = store.getConfigMemories(PID);
  assert.equal(expected.length, 200);
  assert.equal(expected[0].config.primaryProjectId, "app-1");
  assert.equal(expected.at(-1).config.primaryProjectId, "app-200");

  const bundle = store.getSharedBundle();
  assert.equal(bundle.sharedOps.filter((op) => op.type === "configMemory.set").length, 201);

  // 清空共享快照后只靠完整操作集恢复，验证 gossip/Service Control 接收端
  // 不会把已被 200 条上限淘汰的首条记录复活成第 201 条。
  db.setUserData("__devbench_shared__", "shared", {
    projectDefs: [], byProject: {}, dingtalkMsgConfig: null,
    _sharedVersion: 1, sharedOps: [], sharedOpClocks: {},
  }, "replay-target");
  const replayed = store.applySharedBundle(bundle);
  assert.equal(replayed.ok, true);
  assert.equal(replayed.applied, true);
  assert.deepEqual(store.getConfigMemories(PID), expected);
});

test("经验库：同 carbId 更新而非新增 + 无 carbId 追加 + 删除 + 项目隔离", () => {
  store.addLesson(PID, { carbId: "CARB-1", cause: "c1", prevent: "p1" });
  store.addLesson(PID, { carbId: "CARB-1", cause: "c1-updated" });
  let list = store.getLessons(PID);
  assert.equal(list.length, 1, "同 carbId 应更新");
  assert.equal(list[0].cause, "c1-updated");
  // 无 carbId 的两条都追加
  store.addLesson(PID, { cause: "x" });
  store.addLesson(PID, { cause: "y" });
  assert.equal(store.getLessons(PID).length, 3);
  // 删除
  const id = store.getLessons(PID)[0].id;
  store.deleteLesson(PID, id);
  assert.equal(store.getLessons(PID).some((l) => l.id === id), false);
  // 项目隔离
  assert.equal(store.getLessons("projB").length, 0);
});

test("旧顶层 keywordMappings 迁移到默认项目桶", () => {
  db.default.prepare("DELETE FROM devbench_userdata WHERE user_key=? AND kind=?").run("__system__", "marketProjectsRuntimeSeedV1");
  const seedText = JSON.stringify({ keywordMappings: { tag: { 旧标签: { category: "app", value: "X" } } } });
  fs.writeFileSync(MARKET, seedText);
  const km = store.getKeywordMappings(PID);
  assert.equal(km.tag["旧标签"].value, "X");
  const raw = JSON.parse(fs.readFileSync(MARKET, "utf8"));
  assert.ok(raw.keywordMappings.tag["旧标签"]);
  assert.equal(raw.byProject, undefined, "byProject 不再写入 market.json，改存 SQLite");
  assert.equal(fs.readFileSync(MARKET, "utf8"), seedText);
  const shared = db.getUserData("__devbench_shared__", "shared");
  assert.ok(shared?.byProject?.[PID]?.keywordMappings?.tag?.["旧标签"], "迁移结果应落 SQLite 共享态");

  store.deleteKeywordMapping(PID, "tag", "旧标签");
  const emptyBackup = store.createSharedSyncBackup({ label: "旧种子迁移后空状态" });
  store.setKeywordMapping(PID, "tag", "旧标签", "app", "临时值");
  assert.equal(store.restoreSharedSyncBackup(emptyBackup.id).ok, true);
  assert.equal(store.getKeywordMappings(PID).tag["旧标签"], undefined, "删除并恢复为空后不得从只读种子复活旧值");
  assert.equal(fs.readFileSync(MARKET, "utf8"), seedText);
});
test("sync backup: backup and restore shared config plus syncable userdata", () => {
  db.default.prepare("DELETE FROM devbench_sync_backups").run();
  db.default.prepare("DELETE FROM devbench_sync_backup_blobs").run();
  store.setVehicleMapping(PID, "carA", {
    apps: [{ appName: "App Market", repos: [{ repoId: "appMarket", branch: "before", flavor: "carA" }] }],
    prodReleaseDir: "\\\\share\\before",
  });
  db.setUserData("tb:backup-user", "tasks", [{ id: "task-before", title: "before" }], "test");
  const backup = store.createSharedSyncBackup({ source: "manual", label: "unit-backup" });
  assert.equal(backup.summary.vehicleCount, 1);
  assert.equal(backup.summary.taskCount, 1);
  assert.equal(backup.encoding, "gzip-json-v1");
  assert.ok(backup.storedBytes < backup.rawBytes);

  store.setVehicleMapping(PID, "carA", {
    apps: [{ appName: "App Market", repos: [{ repoId: "appMarket", branch: "after", flavor: "carA" }] }],
    prodReleaseDir: "\\\\share\\after",
  });
  db.setUserData("tb:backup-user", "tasks", [{ id: "task-after", title: "after" }], "test");

  const restored = store.restoreSharedSyncBackup(backup.id);
  assert.equal(restored.ok, true);
  const vm = store.getRemoteConfig(PID).vehicleMap.carA;
  assert.equal(vm.entries[0].branch, "before");
  assert.equal(vm.prodReleaseDir, "\\\\share\\before");
  assert.equal(db.getUserData("tb:backup-user", "tasks")[0].id, "task-before");
  assert.equal(restored.preRestoreBackup.source, "pre-restore");
  const shared = db.getUserData("__devbench_shared__", "shared");
  const lastOp = shared.sharedOps[shared.sharedOps.length - 1];
  assert.equal(lastOp.type, "shared.restore");
  assert.equal(lastOp.idValue, backup.id);
});

test("sync backup: auto backup skips unchanged data and keeps only the configured recent snapshots", () => {
  db.default.prepare("DELETE FROM devbench_sync_backups").run();
  db.default.prepare("DELETE FROM devbench_sync_backup_blobs").run();
  db.default.prepare("DELETE FROM devbench_sync_backup_settings").run();
  store.updateSharedSyncBackupSettings({
    enabled: true,
    intervalMinutes: 5,
    maxAutoBackups: 2,
    lastAutoBackupAt: 0,
  });
  const first = store.runDueSharedSyncAutoBackup(1_000_000);
  assert.equal(first.created, true);
  const skipped = store.runDueSharedSyncAutoBackup(1_000_000 + 60_000);
  assert.equal(skipped.created, false);
  const unchanged = store.runDueSharedSyncAutoBackup(1_000_000 + 5 * 60_000);
  assert.equal(unchanged.created, false);
  assert.equal(unchanged.unchanged, true);
  assert.equal(unchanged.duplicateOf, first.backup.id);

  db.setUserData("tb:auto-backup-user", "tasks", [{ id: "auto-v2", title: "v2" }], "test");
  const second = store.runDueSharedSyncAutoBackup(1_000_000 + 10 * 60_000);
  assert.equal(second.created, true);
  assert.notEqual(first.backup.id, second.backup.id);

  db.setUserData("tb:auto-backup-user", "tasks", [{ id: "auto-v3", title: "v3" }], "test");
  const third = store.runDueSharedSyncAutoBackup(1_000_000 + 15 * 60_000);
  assert.equal(third.created, true);
  assert.equal(third.backup.maintenance.deleted, 1);
  const backups = store.listSharedSyncBackups({ limit: 20 });
  const ids = backups.map((b) => b.id);
  assert.equal(backups.length, 2);
  assert.equal(ids.includes(first.backup.id), false);
  assert.ok(ids.includes(second.backup.id));
  assert.ok(ids.includes(third.backup.id));
  assert.ok(backups.every((backup) => backup.encoding === "gzip-json-v1"));

  const storage = store.getSharedSyncBackupStorageStats();
  assert.equal(storage.backupCount, 2);
  assert.equal(storage.uniqueBlobCount, 2);
  assert.equal(storage.legacyBackupCount, 0);
  assert.ok(storage.backupBytes < storage.backupRawBytes);
  assert.equal(storage.bySource.find((row) => row.source === "auto")?.count, 2);
});

test("vehicle source import/export: merge and replace across devices", () => {
  const custom = store.upsertProjectDef({ id: "customRepo", name: "Custom Repo", ssh: "git@host:x/Custom.git" });
  assert.equal(custom.ok, true);
  store.setVehicleMapping(PID, "carA", {
    apps: [{ appName: "A", repos: [{ repoId: "customRepo", branch: "main", flavor: "carA" }] }],
    prodReleaseDir: "\\\\share\\carA",
  });
  const exported = store.exportVehicleSourceConfig(PID);
  assert.equal(exported.type, "devbench-vehicle-source-config");
  assert.equal(exported.vehicleMap.carA.entries[0].projectId, "customRepo");
  assert.equal(exported.projectDefs.some((d) => d.id === "customRepo"), true);

  store.setVehicleMapping(PID, "carB", { apps: [{ appName: "B", repos: [{ repoId: "appMarket", branch: "b", flavor: "carB" }] }] });
  let imported = store.importVehicleSourceConfig(PID, exported, { mode: "merge", importProjectDefs: true });
  assert.equal(imported.ok, true);
  assert.equal(imported.imported, 1);
  assert.equal(store.getRemoteConfig(PID).vehicleMap.carB.entries[0].branch, "b", "merge should keep local-only vehicle");

  imported = store.importVehicleSourceConfig(PID, exported, { mode: "replace", importProjectDefs: true });
  assert.equal(imported.ok, true);
  const vm = store.getRemoteConfig(PID).vehicleMap;
  assert.equal(vm.carA.entries[0].branch, "main");
  assert.equal(vm.carB, undefined, "replace should delete vehicle not present in import file");
});

test("historical tab without storyStorageRoot creates the missing StoryDev directories safely", () => {
  const cloneParent = path.join(tmp, `legacy-story-storage-${Date.now()}`);
  store.updateRemoteConfig({ cloneParent });
  const storyDevRoot = path.join(cloneParent, "AllDocs", "StoryDev");
  fs.rmdirSync(storyDevRoot);
  const historicalTab = {
    id: `legacy-story-storage-${Date.now()}`,
    title: "#CARB-10E# historical storage",
    docSlug: "#CARB-10E#historical-storage",
  };

  const storage = store.getStoryStoragePaths(historicalTab, { create: true, persist: false });

  assert.equal(storage.storyDevRoot, storyDevRoot);
  for (const directory of [
    storage.storyDirectory,
    storage.archiveDirectory,
    storage.attachmentDirectory,
    storage.reportsDirectory,
    storage.tempDirectory,
    storage.scriptsDirectory,
  ]) {
    assert.equal(fs.statSync(directory).isDirectory(), true, `${directory} should be created`);
    assert.equal(fs.lstatSync(directory).isSymbolicLink(), false, `${directory} must not be a link`);
  }
});

test("historical tab without storyStorageRoot rejects a StoryDev junction without external writes", (t) => {
  const cloneParent = path.join(tmp, `legacy-story-storage-link-${Date.now()}`);
  store.updateRemoteConfig({ cloneParent });
  const storyDevRoot = path.join(cloneParent, "AllDocs", "StoryDev");
  const outside = fs.mkdtempSync(path.join(tmp, "legacy-story-storage-outside-"));
  fs.rmdirSync(storyDevRoot);
  try {
    fs.symlinkSync(outside, storyDevRoot, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    t.skip(`directory links are unavailable in this environment: ${error.message}`);
    return;
  }
  const historicalTab = {
    id: `legacy-story-storage-link-${Date.now()}`,
    title: "#CARB-10F# historical storage link",
    docSlug: "#CARB-10F#historical-storage-link",
  };

  assert.throws(
    () => store.getStoryStoragePaths(historicalTab, { create: true, persist: false }),
    (error) => error?.code === "STORY_STORAGE_LINK_UNSAFE",
  );
  assert.deepEqual(fs.readdirSync(outside), [], "rejecting the junction must not write outside StoryDev");
});

test("隐藏态：同一次收起操作共享隐藏批次，还原清除批次字段（OneTab 分组）", () => {
  const a = store.createTab({ title: "#CARB-30001# 隐藏批次-A" });
  const b = store.createTab({ title: "#CARB-30002# 隐藏批次-B" });
  const c = store.createTab({ title: "#CARB-30003# 隐藏批次-C" });
  const batch1 = { id: "h-1111-aaaa", at: 1111 };

  // 单 tab 收起（带批次）：写入 hideBatchId/hideBatchAt
  let r = store.setTabHidden(a.id, true, batch1);
  assert.equal(r.ok, true, r.error);
  assert.equal(store.getTab(a.id).hidden, true);
  assert.equal(store.getTab(a.id).hideBatchId, "h-1111-aaaa");
  assert.equal(store.getTab(a.id).hideBatchAt, 1111);

  // 同一批次收起第二个 tab：共享同一 hideBatchId（同一次操作归为一组）
  r = store.setTabHidden(b.id, true, { ...batch1 });
  assert.equal(r.ok, true, r.error);
  assert.equal(store.getTab(b.id).hideBatchId, "h-1111-aaaa");
  assert.equal(store.getTab(b.id).hideBatchAt, 1111);

  // 一键收起：剩余未隐藏的 tab（只有 c）归入新批次；已隐藏的 a/b 保持原批次不动
  const batch2 = { id: "h-2222-bbbb", at: 2222 };
  r = store.hideAllTabs(batch2);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.hidden, 1, "已隐藏的故事点不再重复计数");
  const cAfter = store.getTab(c.id);
  assert.equal(cAfter.hidden, true);
  assert.equal(cAfter.hideBatchId, "h-2222-bbbb");
  assert.equal(cAfter.hideBatchAt, 2222);
  assert.equal(store.getTab(a.id).hideBatchId, "h-1111-aaaa", "hide-all 不得覆盖已隐藏 tab 的批次");
  assert.equal(store.getTab(b.id).hideBatchId, "h-1111-aaaa");

  // 还原：清除批次字段
  r = store.setTabHidden(a.id, false);
  assert.equal(r.ok, true, r.error);
  const aAfter = store.getTab(a.id);
  assert.equal(aAfter.hidden, false);
  assert.equal(aAfter.hideBatchId, undefined);
  assert.equal(aAfter.hideBatchAt, undefined);

  // 不传批次的隐藏：保留已有批次（兼容旧调用方，不破坏分组）
  r = store.setTabHidden(b.id, true);
  assert.equal(r.ok, true, r.error);
  assert.equal(store.getTab(b.id).hideBatchId, "h-1111-aaaa");

  for (const id of [a.id, b.id, c.id]) removeStoryFixture(id);
});
