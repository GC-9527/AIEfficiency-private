import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  clearStoryInitializationIntentsForTest,
  commitStoryInitializationIntent,
  issueStoryInitializationIntent,
  normalizeStoryInitialization,
  releaseStoryInitializationIntent,
  resolveVehicleSourceTargets,
  reserveStoryInitializationIntent,
} from "../services/devbench/story-initialization.js";

const projects = [
  { id: "main", name: "主工程", path: "D:/repo/main", exists: true },
  { id: "sdk", name: "SDK", path: "D:/repo/sdk", exists: true },
];
const projectDefs = [{ id: "main" }, { id: "sdk" }];

test("多车型多应用按仓库和分支生成稳定目标并保留消费者", () => {
  const defs = [
    { id: "app", name: "App Market", projectType: "application" },
    { id: "web", name: "WebApp", projectType: "application" },
  ];
  const vehicleMap = {
    avatr8678: {
      apps: [
        { appName: "应用市场", repos: [
          { repoId: "app", branch: "release/8678", flavor: "avatr8678Prod", targetRole: "primary" },
          { repoId: "web", branch: "release/shared", flavor: "avatr8678Prod" },
        ] },
      ],
    },
    avatr8155: {
      apps: [
        { appName: "应用市场", repos: [
          { repoId: "app", branch: "release/8155", flavor: "avatr8155Prod" },
          { repoId: "web", branch: "release/shared", flavor: "avatr8155Prod" },
        ] },
      ],
    },
  };
  const result = resolveVehicleSourceTargets({
    vehicleSelections: [
      { vehicle: "avatr8678", appNames: ["应用市场"] },
      { vehicle: "avatr8155", appNames: ["应用市场"] },
    ],
  }, { vehicleMap, projectDefs: defs });
  assert.equal(result.ok, true);
  assert.equal(result.entries.length, 3, "同仓同分支去重，同仓不同分支必须拆成两个目标");
  const appTargets = result.entries.filter((entry) => entry.repositoryId === "app");
  assert.equal(appTargets.length, 2);
  assert.notEqual(appTargets[0].targetId, appTargets[1].targetId);
  const sharedWeb = result.entries.find((entry) => entry.repositoryId === "web");
  assert.equal(sharedWeb.consumers.length, 2);
  assert.deepEqual(sharedWeb.consumers.map((item) => item.vehicle).sort(), ["avatr8155", "avatr8678"]);
  assert.equal(result.entries.filter((entry) => entry.targetRole === "primary").length, 1);

  const normalized = normalizeStoryInitialization({
    title: "多车型初始化",
    mode: "remote",
    projectDefId: "",
    remotePull: {
      tbId: "CARB-10001",
      vehicleSelections: [
        { vehicle: "avatr8678", appNames: ["应用市场"] },
        { vehicle: "avatr8155", appNames: ["应用市场"] },
      ],
      // 浏览器伪造的展开结果必须被服务端 vehicleMap 覆盖。
      entries: [{ projectId: "app", branch: "forged" }],
    },
  }, { projects, projectDefs: defs, vehicleMap });
  assert.equal(normalized.ok, true);
  assert.equal(normalized.data.snapshot.remotePull.sourcePlanVersion, 2);
  assert.equal(normalized.data.snapshot.remotePull.entries.some((entry) => entry.branch === "forged"), false);
});

test("车型应用、仓库和分支配置异常时拒绝初始化", () => {
  const defs = [{ id: "app" }];
  assert.equal(resolveVehicleSourceTargets({
    vehicleSelections: [{ vehicle: "v", appNames: [] }],
  }, { vehicleMap: { v: { apps: [{ appName: "应用市场", repos: [{ repoId: "app", branch: "main" }] }] } }, projectDefs: defs }).code, "STORY_SOURCE_APPLICATION_REQUIRED");
  assert.equal(resolveVehicleSourceTargets({
    vehicleSelections: [{ vehicle: "missing", appNames: ["应用市场"] }],
  }, { vehicleMap: {}, projectDefs: defs }).code, "STORY_SOURCE_VEHICLE_INVALID");
  assert.equal(resolveVehicleSourceTargets({
    vehicleSelections: [{ vehicle: "v", appNames: ["伪造应用"] }],
  }, { vehicleMap: { v: { apps: [{ appName: "应用市场", repos: [] }] } }, projectDefs: defs }).code, "STORY_SOURCE_APPLICATION_INVALID");
  assert.equal(resolveVehicleSourceTargets({
    vehicleSelections: [{ vehicle: "v", appNames: ["应用市场"] }],
  }, { vehicleMap: { v: { apps: [{ appName: "应用市场", repos: [{ repoId: "app", branch: "" }] }] } }, projectDefs: defs }).code, "STORY_SOURCE_BRANCH_REQUIRED");
});

test("本地初始化只接受登记工程并在服务端转换路径快照", () => {
  const result = normalizeStoryInitialization({
    title: "国家码",
    mode: "local",
    primaryProjectId: "main",
    extraProjectIds: ["sdk", "main", "sdk"],
    flavors: [{ projectId: "main", flavor: "avatr8678Prod" }],
  }, { projects, projectDefs });
  assert.equal(result.ok, true);
  assert.equal(result.data.snapshot.primaryProjectId, "main");
  assert.deepEqual(result.data.snapshot.baseExtraProjects, [{
    path: "D:/repo/sdk",
    basePath: "D:/repo/sdk",
    baseProjectId: "sdk",
    name: "SDK",
  }]);
  assert.deepEqual(result.data.snapshot.flavors, [{ path: "D:/repo/main", flavor: "avatr8678Prod" }]);
});

test("缺标题、无效主工程和未裁决来源冲突均不能签发确认", () => {
  assert.equal(normalizeStoryInitialization({}, { projects, projectDefs }).code, "STORY_TITLE_REQUIRED");
  assert.equal(normalizeStoryInitialization({ title: "x", mode: "local" }, { projects, projectDefs }).code, "STORY_PRIMARY_PROJECT_REQUIRED");
  assert.equal(normalizeStoryInitialization({
    title: "x",
    mode: "blank",
    conflicts: [{ id: "source_conflict:flavor", dimension: "flavor", resolutionRequired: true }],
  }, { projects, projectDefs }).code, "STORY_SOURCE_CONFLICT_UNRESOLVED");
});

test("来源冲突裁决必须是面板允许的候选值且与最终快照一致", () => {
  const base = {
    title: "冲突裁决",
    mode: "remote",
    projectDefId: "main",
    remotePull: {
      vehicle: "avatr8678",
      entries: [{ projectId: "main", branch: "main", flavor: "avatr8678Prod" }],
    },
    conflicts: [{
      id: "source_conflict:vehicle",
      dimension: "vehicle",
      candidates: [{ value: "avatr8678" }, { value: "avatr8155" }],
    }],
  };
  const forged = normalizeStoryInitialization({
    ...base,
    conflictResolutions: {
      "source_conflict:vehicle": { dimension: "vehicle", selection: "candidate:fake", value: "fake" },
    },
  }, { projects, projectDefs });
  assert.equal(forged.ok, false);
  assert.equal(forged.code, "STORY_SOURCE_CONFLICT_UNRESOLVED");

  const candidate = normalizeStoryInitialization({
    ...base,
    conflictResolutions: {
      "source_conflict:vehicle": {
        dimension: "vehicle",
        selection: "candidate:avatr8678",
        value: "avatr8678",
      },
    },
  }, { projects, projectDefs });
  assert.equal(candidate.ok, true);

  const snapshotMismatch = normalizeStoryInitialization({
    ...base,
    remotePull: { ...base.remotePull, vehicle: "avatr8155" },
    conflictResolutions: {
      "source_conflict:vehicle": {
        dimension: "vehicle",
        selection: "candidate:avatr8678",
        value: "avatr8678",
      },
    },
  }, { projects, projectDefs });
  assert.equal(snapshotMismatch.ok, false);
  assert.equal(snapshotMismatch.code, "STORY_SOURCE_CONFLICT_UNRESOLVED");

  const manual = normalizeStoryInitialization({
    ...base,
    mode: "blank",
    conflictResolutions: {
      "source_conflict:vehicle": {
        dimension: "vehicle",
        selection: "manual",
        value: "当前面板未设置车型",
      },
    },
  }, { projects, projectDefs });
  assert.equal(manual.ok, true);
});

test("确认意图绑定用户和入口，失败可释放，成功可幂等重放", () => {
  clearStoryInitializationIntentsForTest();
  const issued = issueStoryInitializationIntent({ title: "x", snapshot: { mode: "blank" } }, {
    ownerKey: "u1",
    consumer: "tabs",
    now: 1000,
    ttlMs: 2000,
  });
  assert.equal(reserveStoryInitializationIntent(issued.id, { ownerKey: "u2", consumer: "tabs", now: 1500 }).code, "STORY_INITIALIZATION_OWNER_MISMATCH");
  assert.equal(reserveStoryInitializationIntent(issued.id, { ownerKey: "u1", consumer: "git_commit_story", now: 1500 }).code, "STORY_INITIALIZATION_CONSUMER_MISMATCH");
  const first = reserveStoryInitializationIntent(issued.id, { ownerKey: "u1", consumer: "tabs", now: 1500 });
  assert.equal(first.ok, true);
  assert.equal(reserveStoryInitializationIntent(issued.id, { ownerKey: "u1", consumer: "tabs", now: 1600 }).code, "STORY_INITIALIZATION_IN_PROGRESS");
  assert.equal(releaseStoryInitializationIntent(issued.id, {
    ownerKey: "u1",
    reservationId: first.reservationId,
    now: 1700,
  }).ok, true);
  const retry = reserveStoryInitializationIntent(issued.id, { ownerKey: "u1", consumer: "tabs", now: 1800 });
  assert.equal(retry.ok, true);
  const committed = commitStoryInitializationIntent(issued.id, {
    ownerKey: "u1",
    reservationId: retry.reservationId,
    result: { statusCode: 200, body: { ok: true, data: { id: "tab-1" } } },
    now: 1900,
  });
  assert.equal(committed.ok, true);
  const replay = reserveStoryInitializationIntent(issued.id, { ownerKey: "u1", consumer: "tabs", now: 2000 });
  assert.equal(replay.replay, true);
  assert.deepEqual(replay.result, { statusCode: 200, body: { ok: true, data: { id: "tab-1" } } });

  const expiring = issueStoryInitializationIntent({ title: "y", snapshot: { mode: "blank" } }, {
    ownerKey: "u1",
    now: 2000,
    ttlMs: 1000,
  });
  assert.equal(reserveStoryInitializationIntent(expiring.id, { ownerKey: "u1", consumer: "tabs", now: 3001 }).code, "STORY_INITIALIZATION_EXPIRED");
});

test("创建路由原子插入故事点后排队后台工作区，设备只在工作区成功后绑定", () => {
  const source = readFileSync(new URL("../routes/devbench.js", import.meta.url), "utf8");
  const localHelper = source.slice(
    source.indexOf("function queueLocalStoryWorkspaceInitialization"),
    source.indexOf("function recoverLocalStoryWorkspaceInitializations"),
  );
  const gitRoute = source.slice(
    source.indexOf('router.post("/git-commit-story", async'),
    source.indexOf('router.post("/tabs/:id/git-commit-review/refresh-latest"'),
  );
  const tabsRoute = source.slice(
    source.indexOf('router.post("/tabs", async'),
    source.indexOf('router.post("/tabs/reopen-closed"'),
  );
  for (const route of [gitRoute, tabsRoute]) {
    assert.equal(route.includes("store.releaseDeviceFromOtherTabs"), false, "创建路由不得在工作区成功前直接释放旧故事点设备");
    assert.equal(route.includes("store.createTabGuarded"), true, "初始化确认后的最终 Tab 插入必须走 store 原子门禁");
    assert.ok(route.indexOf("queueLocalStoryWorkspaceInitialization") > route.indexOf("store.createTabGuarded"),
      "本地故事点必须先原子占用身份，再冻结后台初始化计划");
    assert.match(route, /localWorkspaceQueued \? 202 : 200/,
      "本地工作区排队后必须立即以 202 返回，不能等待 Git worktree 完成");
    assert.match(route, /void startLocalStoryWorkspaceInitialization\(tab\.id\)\.catch/,
      "返回结果前只允许无等待地启动后台任务");
    assert.ok(
      /if \(!localWorkspaceQueued\) tab = assignDeviceAfterStoryCreation/.test(route)
        || /if \(snapshot\.mode === "local" && snapshot\.primaryProjectId\)[\s\S]*?queueLocalStoryWorkspaceInitialization[\s\S]*?\} else \{[\s\S]*?assignDeviceAfterStoryCreation/.test(route),
      "排队中的本地工作区不得走同步设备绑定分支",
    );
  }
  const provisionIndex = localHelper.indexOf("await provisionLocalStoryWorkspace");
  const assignmentIndex = localHelper.indexOf("assignDeviceAfterStoryCreation", provisionIndex);
  const readyIndex = localHelper.indexOf('status: "ready"', assignmentIndex);
  assert.ok(provisionIndex >= 0 && assignmentIndex > provisionIndex && readyIndex > assignmentIndex,
    "后台任务必须在工作区成功后绑定设备，最后才发布 ready");
  assert.match(localHelper, /status: "error"[\s\S]*?emitLocalStoryWorkspaceInitialization/,
    "后台失败必须持久化并广播可重试错误状态");
  assert.match(localHelper, /operationId: randomUUID\(\)/,
    "后台初始化计划必须有持久化操作代次");
  assert.match(localHelper, /onWorktreePlanned:[\s\S]*?persistLocalStoryWorktreePlan/,
    "Git 副作用前必须把精确 worktree 目标写入初始化计划");
  assert.match(localHelper, /WORKSPACE_INITIALIZATION_HANDOFF_CODES\.has\(error\?\.code\)[\s\S]*?status: "queued"/,
    "跨 Gateway 租约竞争必须保持排队，不能污染成业务失败");
  assert.match(localHelper, /initializationIdentityUpdates\(completionUpdates\)/,
    "Git commit 等安全身份必须在 queued 阶段立即发布，避免重复创建");
  assert.match(source, /router\.post\("\/tabs\/:id\/workspace-initialization\/retry"/,
    "失败状态必须提供显式重试入口");
  assert.ok(gitRoute.indexOf("const ticketOwner") < gitRoute.indexOf("store.createTabGuarded"));
  assert.ok(gitRoute.includes('code: "STORY_TICKET_TAKEN"'));
});

test("本地 worktree 与远程 clone 都准确声明后台初始化", () => {
  const source = readFileSync(new URL("../routes/devbench.js", import.meta.url), "utf8");
  assert.match(source, /backgroundInitialization:\s*localWorkspaceQueued \|\| snapshot\.mode === "remote"/);
});

test("工作区后台初始化期间和失败后，构建与开发工作流在副作用前关闭", () => {
  const source = readFileSync(new URL("../routes/devbench.js", import.meta.url), "utf8");
  const preflight = source.slice(
    source.indexOf("function sendPreflightError"),
    source.indexOf("function sendDeviceRuntimeBusy", source.indexOf("function sendPreflightError")),
  );
  assert.match(preflight, /STORY_INITIALIZATION_IN_PROGRESS/);
  assert.match(preflight, /STORY_INITIALIZATION_FAILED/);
  assert.match(preflight, /STORY_INITIALIZATION_SAFE_MUTATIONS/);
  assert.match(preflight, /failureRepair = action === "apply-config"/,
    "统一写路由门禁必须只给失败态的配置修复留出口");

  const buildRoute = source.slice(
    source.indexOf('router.post("/tabs/:id/build", async'),
    source.indexOf('router.post("/tabs/:id/build/stop"'),
  );
  const workflowRoute = source.slice(
    source.indexOf('router.post("/tabs/:id/workflow/start-dev", async'),
    source.indexOf('router.post("/tabs/:id/workflow/', source.indexOf('router.post("/tabs/:id/workflow/start-dev", async') + 1),
  );
  assert.ok(buildRoute.indexOf("sendPreflightError(tab)") < buildRoute.indexOf("buildProcs.set("),
    "构建门禁必须先于构建任务副作用");
  assert.ok(workflowRoute.indexOf("sendPreflightError(tab)") < workflowRoute.indexOf("kickTriage("),
    "开发工作流门禁必须先于 TB 状态和 AI 副作用");
});

test("ready 后配置快照只返回实时配置，关闭动作与初始化生命周期互斥", () => {
  const source = readFileSync(new URL("../routes/devbench.js", import.meta.url), "utf8");
  const snapshotRoute = source.slice(
    source.indexOf('router.get("/tabs/:id/config-snapshot"'),
    source.indexOf('router.post("/tabs/:id/apply-config"'),
  );
  assert.match(snapshotRoute, /\["queued", "preparing"\]\.includes\(initialization\?\.status\)/);
  assert.match(snapshotRoute, /plannedInitializationSnapshot: initialization\?\.status === "error"/,
    "失败计划只能作为诊断字段暴露，不能覆盖当前配置");

  const closeRoute = source.slice(
    source.indexOf('router.delete("/tabs/:id", async'),
    source.indexOf('router.get("/tabs/:id/flavors"'),
  );
  assert.match(closeRoute, /storyWorkspaceInitializationPending\(tab\)/);
  assert.match(closeRoute, /localStoryWorkspaceInitializationInFlight\.has\(tab\.id\)/);
  assert.match(closeRoute, /STORY_INITIALIZATION_IN_PROGRESS/);

  const applyRoute = source.slice(
    source.indexOf('router.post("/tabs/:id/apply-config"'),
    source.indexOf('// ===== 故事点组/队列'),
  );
  assert.ok(applyRoute.indexOf("applyConfigMutationPreflight(tab, snap)") < applyRoute.indexOf("prepareDeviceBindingChange"),
    "AI、mutation 和初始化门禁必须早于设备队列及配置持久化副作用");
  assert.ok(applyRoute.indexOf("applyConfigMutationPreflight(tab, snap)") < applyRoute.indexOf("store.updateTab(tab.id"),
    "门禁失败前不得发布 repair generation 或清空当前工程");
  assert.match(applyRoute, /generation: \(Number\(previousInitialization\.generation\) \|\| 0\) \+ 1/);
  assert.match(applyRoute, /status: "ready"[\s\S]*?error: null[\s\S]*?errorCode: null/,
    "成功修复必须完成新代次并清除旧失败门禁");
  assert.match(applyRoute, /newRemoteStorySourceInitializationPlan\(store\.getTab\(tab\.id\) \|\| tab, updates\.remotePull\)/,
    "remote apply 必须把新 operation generation 与破坏性字段放进同一次原子写回");
  assert.match(applyRoute, /startRemoteStorySourceInitialization\(tab\.id, remoteInitializationPlan\)/);
  assert.match(applyRoute, /const responseStatus = remoteInitializationRequested \? 202 : 200/,
    "远程后台初始化只能返回明确的 202 pending，不能伪装成已完成成功");
});

test("远程初始化确认后自动准备稳定源码缓存并创建故事点 worktree", () => {
  const source = readFileSync(new URL("../routes/devbench.js", import.meta.url), "utf8");
  const helper = source.slice(
    source.indexOf("const remoteStorySourceInitializationInFlight"),
    source.indexOf("function isMutationLeaseLoss"),
  );
  assert.match(helper, /newRemoteStorySourceInitializationPlan[\s\S]*operationId:\s*randomUUID\(\)[\s\S]*generation:/);
  assert.match(helper, /remoteStorySourceInitializationKey[\s\S]*generation[\s\S]*operationId/,
    "in-flight 必须按 tab、generation、operation 复合身份索引");
  assert.match(helper, /beginWorktreeMutation\(mutationTab, "recreate"/);
  assert.match(helper, /remoteStorySourceInitializationShadowTab\(runningTab, identity\)/,
    "底层 clone 的直接写入和进度必须隔离到 operation 影子 tab");
  assert.match(helper, /remoteStorySourceInitializationRuntime\.runRemoteInit/);
  assert.match(helper, /remoteStorySourceInitializationRuntime\.provisionLocalStoryWorkspace/);
  assert.match(helper, /deferCommit:\s*true[\s\S]*updateCurrentRemoteStorySourceInitialization[\s\S]*cloneStatus:\s*"done"/,
    "worktree 结果必须在 generation CAS 内一次提交，不能先由通用 helper 无条件写回");
  assert.match(helper, /cloneStatus:\s*"done"/);
  assert.match(helper, /cloneStatus:\s*"error"/);
  assert.match(helper, /STORY_SOURCE_INITIALIZATION_SUPERSEDED/);
  assert.match(helper, /Promise\.allSettled\(olderRecords\.map/,
    "新代次必须等待旧真实 Promise 收口，不能复用旧 Promise");
  assert.match(helper, /recoverRemoteStorySourceInitializations/);
  assert.match(helper, /\["queued", "cloning"\]\.includes\(tab\.cloneStatus\)/);

  const cloneSource = readFileSync(new URL("../services/devbench/clone.js", import.meta.url), "utf8");
  const remoteInit = cloneSource.slice(cloneSource.indexOf("export async function runRemoteInit"));
  assert.equal(remoteInit.includes('cloneStatus: allOk ? "done"'), false,
    "共享缓存准备阶段不得提前发布 done");
  assert.equal(remoteInit.includes("localizeCompletedRemoteTab(tab"), false,
    "共享缓存准备阶段不得把故事点直接指向 SourceCache");
  assert.match(remoteInit, /sourcePrepared:\s*true/);

  const manualRoute = source.slice(
    source.indexOf('router.post("/tabs/:id/remote/init"'),
    source.indexOf('router.post("/tabs/:id/extra"'),
  );
  assert.equal(manualRoute.includes('["queued", "cloning"].includes(tab.cloneStatus) ||'), false,
    "重启残留的 queued/cloning 状态不能在检查共享租约前固定返回 409");
  assert.match(manualRoute, /const resumed = \["queued", "cloning"\]\.includes\(tab\.cloneStatus\)/);

  const gitRoute = source.slice(
    source.indexOf('router.post("/git-commit-story", async'),
    source.indexOf('router.post("/tabs/:id/git-commit-review/refresh-latest"'),
  );
  const tabsRoute = source.slice(
    source.indexOf('router.post("/tabs", async'),
    source.indexOf('router.post("/tabs/reopen-closed"'),
  );
  for (const route of [gitRoute, tabsRoute]) {
    assert.match(route, /cloneStatus:\s*snapshot\.mode === "remote" \? "queued" : null/);
    assert.match(route, /startRemoteStorySourceInitialization\(tab\.id\)/);
    assert.equal(route.includes("STORY_DEVICE_TAKEN"), false, "共享设备绑定不应保留旧排他冲突分支");
  }
});

test("worktree 清理与重建把祖先/后代 checkout 视为共享归属并在删除前阻断", () => {
  const source = readFileSync(new URL("../routes/devbench.js", import.meta.url), "utf8");
  const ownership = source.slice(
    source.indexOf("function worktreeOwnershipKeys"),
    source.indexOf("function tabOwnedProjectPaths"),
  );
  assert.match(ownership, /function worktreeOwnershipPathsOverlap/);
  assert.match(ownership, /leftKey\.startsWith\(`\$\{rightKey\}\/`\)/);
  assert.match(ownership, /rightKey\.startsWith\(`\$\{leftKey\}\/`\)/);
  assert.match(ownership, /row\.keys\.some\(\(foreignKey\) => worktreeOwnershipPathsOverlap/);

  for (const routeMarker of [
    'router.get("/tabs/:id/worktree/cleanup-inspection"',
    'router.post("/tabs/:id/worktree/cleanup"',
  ]) {
    const start = source.indexOf(routeMarker);
    const route = source.slice(start, source.indexOf("\nrouter.", start + routeMarker.length));
    assert.match(route, /assertExclusiveStoryWorktreeOwnership/);
  }
});
