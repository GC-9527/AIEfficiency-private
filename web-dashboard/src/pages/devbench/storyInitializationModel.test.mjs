import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { deviceRuntimeStatusView } from "./deviceRuntimeStatusModel.mjs";
import {
  applyStoryLocalFlavorMapping,
  applyStoryInitializationConflictResolution,
  applyStoryInitializationSharedConfiguration,
  canReuseStoryInitializationIntent,
  createStoryInitializationDraft,
  filterStoryInitializationProjects,
  isStoryInitializationSharedConfigurationConflict,
  orderStoryInitializationProjects,
  storyInitializationProjectRuntimeStatus,
  storyConfigurationSnapshotForEditing,
  storyConfigurationSnapshot,
  storyInitializationConflictResolutionMatchesDraft,
  storyInitializationConfig,
  storyInitializationConfirmAction,
  storyInitializationInferenceRequest,
  storyInitializationInferenceSummaryText,
  storyInitializationIntentRequestFingerprint,
  storyLocalFlavorMappingOptions,
  storyLocalFlavorMappingResolution,
  storyInitializationPrimaryAction,
  storyInitializationStudioPath,
  storyInitializationRequiresInferenceRefresh,
  mergeRemoteCloneProgress,
  remoteSourceInitializationProgress,
  storyWorkspaceInitializationPendingIds,
  storyInitializationTabsForMode,
  storyVehicleSourceConfigForProject,
  storyVehicleSourcePreview,
  shouldDiscardStoryInitializationIntent,
  validateStoryInitializationDraft,
} from "./storyInitializationModel.mjs";

const projects = [
  { id: "market", name: "应用市场", path: "D:/repo/market", exists: true },
  { id: "web", name: "WebApp", path: "D:/repo/web", exists: true },
];

test("AI 推理任何阶段都不参与确认创建门禁", () => {
  for (const inferencePhase of ["checking", "running", "applying", "review_ready", "reviewing", "saving_skip", "reviewed", "skipped", "error", "stale"]) {
    assert.equal(storyInitializationConfirmAction({
      canConfirm: true,
      inferencePhase,
    }), "confirm", inferencePhase);
  }
  assert.equal(storyInitializationConfirmAction({ canConfirm: false }), "blocked");
  assert.equal(storyInitializationConfirmAction({ canConfirm: true, partialRecovery: true }), "blocked");

  const panelSource = readFileSync(new URL("./StoryInitializationPanel.jsx", import.meta.url), "utf8");
  assert.doesNotMatch(panelSource, /confirmAction === "review_inference"/);
  assert.match(panelSource, /if \(formDisabled \|\| confirmAction !== "confirm"\) return;/);
  assert.match(panelSource, /disabled=\{formDisabled \|\| confirmAction === "blocked" \|\| unresolvedConflicts\.length > 0\}/);
  assert.match(panelSource, /data-confirm-action=\{confirmAction\}/);
  assert.match(panelSource, /AI 推理仅提供异步建议，不参与创建门禁/);
});

test("初始化推理摘要对字符串、数组和对象输出可读文本而不泄漏对象字符串", () => {
  assert.equal(storyInitializationInferenceSummaryText("直接摘要"), "直接摘要");
  assert.equal(storyInitializationInferenceSummaryText(["第一项", { summary: "第二项" }]), "第一项；第二项");
  assert.equal(storyInitializationInferenceSummaryText({
    summary: "对象直接摘要",
    targets: [{ repositoryName: "不应优先展示" }],
    missingInformation: ["也不应优先展示"],
  }), "对象直接摘要");
  assert.equal(storyInitializationInferenceSummaryText({
    targets: [{ repositoryName: "AppMarket", vehicle: "avatr8678", branch: "main", flavor: "prod" }],
    missingInformation: ["缺少附件"],
  }), "建议 AppMarket（avatr8678 / main / prod）");
  assert.equal(storyInitializationInferenceSummaryText({
    missingInformation: ["缺少 TB 描述", { explanation: "缺少截图" }],
  }), "缺少 TB 描述；缺少截图");
  assert.equal(storyInitializationInferenceSummaryText({}, { reasoning: "回退到推理对象" }), "回退到推理对象");
  assert.equal(
    storyInitializationInferenceSummaryText({ targets: [{}] }),
    "本入口没有可展示的推理摘要，请按当前面板信息人工确认。",
  );
  assert.equal(
    storyInitializationInferenceSummaryText({ targets: [{ branch: "main" }] }),
    "建议 分支：main（主工程待人工确认）",
  );
  const unreadable = storyInitializationInferenceSummaryText({ summary: {} }, {});
  assert.equal(unreadable.includes("[object Object]"), false);
  assert.equal(unreadable.includes("未命名工程"), false);
});

test("初始化推理摘要识别 store suggestion.summary 的真实工程结构", () => {
  const summary = {
    appName: "Browser AI",
    vehicle: "",
    projectName: "browser-ai-tool",
    repositories: ["browser-ai-tool", "browser-ai-core"],
    branch: "main",
    flavor: "",
    extras: ["browser-ai-core"],
    projectExists: true,
  };
  assert.equal(
    storyInitializationInferenceSummaryText(summary),
    "browser-ai-tool（main）；关联工程：browser-ai-core",
  );
  assert.equal(
    storyInitializationInferenceSummaryText({
      projectName: "",
      repositories: ["fallback-project"],
      branch: "release/202606",
      extras: [],
      projectExists: false,
    }),
    "fallback-project（release/202606）",
  );
});

test("组共享配置覆盖工程构建设备但保留成员标题与 TB 身份", () => {
  const member = {
    title: "成员故事点",
    ticketInput: "CARB-200",
    mode: "remote",
    projectDefId: "wrong",
    remoteProjectDefIds: ["wrong-extra"],
    vehicle: "wrong-vehicle",
    branch: "wrong-branch",
    remoteFlavor: "wrong-flavor",
    deviceSerial: "wrong-device",
  };
  const shared = {
    mode: "local",
    primaryProjectId: "market",
    extraProjectIds: ["web"],
    flavorByProjectId: { market: "avatr8678Prod" },
    deviceSerial: "shared-device",
  };
  assert.deepEqual(applyStoryInitializationSharedConfiguration(member, shared), {
    ...member,
    mode: "local",
    primaryProjectId: "market",
    extraProjectIds: ["web"],
    projectDefId: "",
    remoteProjectDefIds: [],
    vehicle: "",
    branch: "",
    remoteFlavor: "",
    flavorByProjectId: { market: "avatr8678Prod" },
    deviceSerial: "shared-device",
  });
  assert.equal(isStoryInitializationSharedConfigurationConflict({ dimension: "branch" }), true);
  assert.equal(isStoryInitializationSharedConfigurationConflict({ dimension: "repositoryId" }), true);
  assert.equal(isStoryInitializationSharedConfigurationConflict({ dimension: "title" }), false);
});

test("初始化 intent 只在完整草稿与 AI proof 未变化时复用", () => {
  const requestA = {
    title: "Story A",
    ticketInput: "CARB-1",
    configuration: { mode: "local", primaryProjectId: "market", deviceSerial: "device-a" },
    configInference: { runId: "CI-1", projectId: "project-a" },
    conflictResolutions: { branch: { selection: "manual", value: "main" } },
  };
  const sameDifferentKeyOrder = {
    conflictResolutions: { branch: { value: "main", selection: "manual" } },
    configInference: { projectId: "project-a", runId: "CI-1" },
    configuration: { deviceSerial: "device-a", primaryProjectId: "market", mode: "local" },
    ticketInput: "CARB-1",
    title: "Story A",
  };
  const fingerprint = storyInitializationIntentRequestFingerprint(requestA);
  assert.equal(storyInitializationIntentRequestFingerprint(sameDifferentKeyOrder), fingerprint);
  assert.equal(canReuseStoryInitializationIntent({
    id: "intent-1",
    fingerprint: "server-fingerprint",
    requestFingerprint: fingerprint,
  }, fingerprint), true);
  assert.equal(canReuseStoryInitializationIntent({
    id: "intent-1",
    fingerprint: "server-fingerprint",
    requestFingerprint: fingerprint,
  }, storyInitializationIntentRequestFingerprint({ ...requestA, title: "Story B" })), false);
  assert.equal(canReuseStoryInitializationIntent({
    id: "intent-1",
    fingerprint: "server-fingerprint",
    requestFingerprint: fingerprint,
  }, storyInitializationIntentRequestFingerprint({
    ...requestA,
    configInference: { ...requestA.configInference, runId: "CI-2" },
  })), false);
});

test("仅服务端明确判定 intent 失效时丢弃，未知创建结果继续幂等重放", () => {
  for (const code of [
    "STORY_INITIALIZATION_EXPIRED",
    "STORY_INITIALIZATION_OWNER_MISMATCH",
    "STORY_INITIALIZATION_CONSUMER_MISMATCH",
    "STORY_CREATE_AI_REVIEW_SCOPE_MISMATCH",
  ]) {
    assert.equal(shouldDiscardStoryInitializationIntent({ ok: false, code }), true, code);
  }
  assert.equal(shouldDiscardStoryInitializationIntent({ ok: false, code: "REQUEST_TIMEOUT", retryable: true }), false);
  assert.equal(shouldDiscardStoryInitializationIntent({ ok: false, code: "NETWORK_ERROR" }), false);
  assert.equal(shouldDiscardStoryInitializationIntent({
    ok: false,
    partial: true,
    code: "STORY_INITIALIZATION_EXPIRED",
    tabId: "story-1",
  }), false, "partial residue must stay in manual recovery even if an invalid code is also present");
  assert.equal(shouldDiscardStoryInitializationIntent({ ok: true }), false);
});

test("AI 复核证明确定失效时要求重新推理，网络未知结果仍保留当前 intent", () => {
  for (const code of [
    "STORY_CREATE_AI_REVIEW_REQUIRED",
    "STORY_CREATE_AI_REVIEW_OWNER_MISMATCH",
    "STORY_CREATE_AI_REVIEW_PROJECT_MISMATCH",
    "STORY_CREATE_AI_REVIEW_TRIGGER_MISMATCH",
    "STORY_CREATE_AI_REVIEW_CONSUMER_MISMATCH",
    "STORY_CREATE_AI_REVIEW_SCOPE_INVALID",
    "STORY_CREATE_AI_REVIEW_SCOPE_MISMATCH",
    "STORY_CREATE_AI_REVIEW_EXPIRED",
    "STORY_CREATE_AI_REVIEW_STALE",
  ]) {
    assert.equal(storyInitializationRequiresInferenceRefresh({ ok: false, code }), true, code);
  }
  assert.equal(storyInitializationRequiresInferenceRefresh({ ok: false, code: "NETWORK_ERROR" }), false);
  assert.equal(storyInitializationRequiresInferenceRefresh({ ok: false, code: "REQUEST_TIMEOUT" }), false);
  assert.equal(storyInitializationRequiresInferenceRefresh({
    ok: false,
    partial: true,
    code: "STORY_CREATE_AI_REVIEW_STALE",
  }), false, "partial creation must remain in manual recovery rather than start a new inference");
});

test("初始化草稿从已复核快照恢复主工程、关联工程、Flavor 与 TB", () => {
  const draft = createStoryInitializationDraft({
    body: { title: "#CARB-1# 国家码" },
    task: { ticketUrl: "https://tb/task/abc", title: "国家码" },
    projects,
    snapshot: {
      mode: "local",
      primaryProjectId: "market",
      baseExtraProjects: [{ baseProjectId: "web", path: "D:/repo/web" }],
      flavors: [{ path: "D:/repo/market", flavor: "avatr8678" }],
    },
  });
  assert.equal(draft.mode, "local");
  assert.equal(draft.primaryProjectId, "market");
  assert.deepEqual(draft.extraProjectIds, ["web"]);
  assert.equal(draft.flavorByProjectId.market, "avatr8678");
  assert.equal(draft.ticketInput, "https://tb/task/abc");
});

test("备份还原快照的 flavors 只有 projectId 时也能恢复 Flavor（无 path 可匹配）", () => {
  const draft = createStoryInitializationDraft({
    body: { title: "跨机还原故事点" },
    projects,
    snapshot: {
      mode: "local",
      primaryProjectId: "market",
      basePrimaryProjectId: "market",
      baseExtraProjects: [{ baseProjectId: "web", name: "web", branch: "story/x_CARB_9", flavor: "prod" }],
      flavors: [
        { projectId: "market", flavor: "avatr8678Prod" },
        { projectId: "web", flavor: "prod" },
      ],
    },
  });
  assert.equal(draft.primaryProjectId, "market");
  assert.deepEqual(draft.extraProjectIds, ["web"]);
  assert.equal(draft.flavorByProjectId.market, "avatr8678Prod", "主工程 Flavor 必须从备份快照还原");
  assert.equal(draft.flavorByProjectId.web, "prod", "关联工程 Flavor 必须从备份快照还原");
});

test("已解析任务项目覆盖旧入口项目，车型配置只能复用于完全相同的 TB 项目", () => {
  const draft = createStoryInitializationDraft({
    body: { title: "跨项目改绑", tbProjectId: "project-a" },
    task: { title: "新项目任务", projectId: "project-b" },
    snapshot: { remotePull: { tbProjectId: "project-a" } },
    projects,
  });
  assert.equal(draft.tbProjectId, "project-b");

  const sourceConfig = { vehicleMap: { avatr8678: {} } };
  assert.equal(storyVehicleSourceConfigForProject("project-b", "project-a", sourceConfig), null);
  assert.equal(storyVehicleSourceConfigForProject("project-b", "project-b", sourceConfig), sourceConfig);
  assert.equal(storyVehicleSourceConfigForProject("", "project-b", sourceConfig), null);
});

test("初始化工程列表把主工程和已选关联工程置顶且保持未选顺序", () => {
  const rows = [
    { id: "sdk", name: "SDK" },
    { id: "web", name: "WebApp" },
    { id: "market", name: "应用市场" },
    { id: "voice", name: "Voice" },
  ];
  const ordered = orderStoryInitializationProjects(rows, ["market", "web", "missing", "web"]);
  assert.deepEqual(ordered.map((item) => item.id), ["market", "web", "sdk", "voice"]);
  assert.deepEqual(rows.map((item) => item.id), ["sdk", "web", "market", "voice"], "排序不得修改服务端原数组");
});

test("本机主工程与关联工程可按工程名、Git 分支或完整路径模糊过滤", () => {
  const rows = [
    { id: "market", name: "应用市场", branch: "feature/CARB-123", path: "D:\\workspace\\AppMarket" },
    { id: "web", name: "Web Console", branch: "release/202606", path: "D:/workspace/WebApp" },
    { id: "sdk", name: "Voice SDK", branch: "main", path: "D:/workspace/SdkFactory" },
  ];

  assert.deepEqual(filterStoryInitializationProjects(rows, "市场").map((item) => item.id), ["market"]);
  assert.deepEqual(filterStoryInitializationProjects(rows, "carb-12").map((item) => item.id), ["market"]);
  assert.deepEqual(filterStoryInitializationProjects(rows, "D:/WORKSPACE/web").map((item) => item.id), ["web"]);
  assert.deepEqual(filterStoryInitializationProjects(rows, "workspace sdk").map((item) => item.id), ["sdk"]);
  assert.deepEqual(filterStoryInitializationProjects(rows, "missing"), []);
  assert.deepEqual(filterStoryInitializationProjects(rows, "  "), rows);
  assert.deepEqual(rows.map((item) => item.id), ["market", "web", "sdk"], "过滤不得修改服务端原数组");
});

test("本机 Flavor 映射展示可选 SDK/AIEfficiency，且 WebApp 不继承主工程 Flavor", () => {
  const projectDefs = [
    { id: "market", name: "应用市场", projectType: "application" },
    { id: "web", name: "WebApp", projectType: "application" },
    { id: "sdk", name: "语音 SDK", projectType: "sdk", defaultBranch: "release/sdk" },
    { id: "tooling", name: "AIEfficiency", projectType: "tooling", defaultBranch: "feat/admin-rbac" },
  ];
  const vehicleMap = {
    avatr8678: {
      apps: [{
        appName: "应用市场",
        repos: [
          { repoId: "market", branch: "release/8678", flavor: "avatr8678Prod", targetRole: "primary" },
          { repoId: "web", branch: "release/shared", flavor: "avatr8678Prod", targetRole: "webapp" },
        ],
      }],
    },
  };
  const projectApplications = [{
    id: "app-market",
    name: "应用市场",
    repositories: [
      { repositoryId: "market", projectIds: ["market-a", "market-b"] },
      { repositoryId: "web", projectIds: ["web"] },
      { repositoryId: "sdk", projectIds: ["sdk"] },
      { repositoryId: "tooling", projectIds: ["tooling"] },
    ],
  }];
  const localProjects = [
    { id: "market-a", name: "Market A", branch: "release/8678", path: "D:/repo/market-a", exists: true },
    { id: "market-b", name: "Market B", branch: "release/8678", path: "D:/repo/market-b", exists: true },
    { id: "web", name: "WebApp", branch: "release/shared", path: "D:/repo/web", exists: true, flavors: ["spotify", "youtube"] },
    { id: "sdk", name: "SDK", branch: "release/sdk", path: "D:/repo/sdk", exists: true },
    { id: "tooling", name: "AIEfficiency", branch: "feat/admin-rbac", path: "D:/repo/aiefficiency", exists: true },
  ];

  const [option] = storyLocalFlavorMappingOptions({ vehicleMap, projectDefs, projects: localProjects, projectApplications });
  assert.equal(option.vehicle, "avatr8678");
  assert.deepEqual(option.flavors, ["avatr8678Prod"]);
  assert.equal(option.targets.find((target) => target.repositoryId === "market").status, "ambiguous");
  assert.equal(option.targets.find((target) => target.repositoryId === "web").category, "common");
  assert.equal(option.targets.find((target) => target.repositoryId === "web").status, "ready");
  assert.equal(option.targets.find((target) => target.repositoryId === "sdk").category, "common");
  assert.equal(option.targets.find((target) => target.repositoryId === "sdk").optional, true);
  assert.equal(option.targets.find((target) => target.repositoryId === "sdk").status, "ready");
  assert.equal(option.targets.find((target) => target.repositoryId === "tooling").category, "common");
  assert.equal(option.targets.find((target) => target.repositoryId === "tooling").optional, true);

  const marketTarget = option.targets.find((target) => target.repositoryId === "market");
  const webTarget = option.targets.find((target) => target.repositoryId === "web");
  const sdkTarget = option.targets.find((target) => target.repositoryId === "sdk");
  const toolingTarget = option.targets.find((target) => target.repositoryId === "tooling");
  const requiredOnly = applyStoryLocalFlavorMapping({ mode: "local", flavorByProjectId: { stale: "old" } }, option, {
    [marketTarget.selectionKey]: "market-b",
  });
  assert.equal(requiredOnly.ok, true);
  assert.deepEqual(requiredOnly.draft.extraProjectIds, ["web"]);
  assert.deepEqual(requiredOnly.draft.flavorByProjectId, {
    "market-b": "avatr8678Prod",
  }, "WebApp 的无效车型 Flavor 必须被丢弃，不能从主工程复制");

  const applied = applyStoryLocalFlavorMapping({ mode: "local" }, option, {
    [marketTarget.selectionKey]: "market-b",
    [sdkTarget.selectionKey]: "sdk",
    [toolingTarget.selectionKey]: "tooling",
  }, {
    [webTarget.selectionKey]: "spotify",
  });
  assert.equal(applied.ok, true);
  assert.equal(applied.draft.primaryProjectId, "market-b");
  assert.deepEqual(applied.draft.extraProjectIds, ["web", "sdk", "tooling"]);
  assert.deepEqual(applied.draft.flavorByProjectId, {
    "market-b": "avatr8678Prod",
    web: "spotify",
  });
});

test("本机 Flavor 映射完成后可直接点击下一步，不要求先点独立应用按钮", () => {
  const panelSource = readFileSync(new URL("./StoryInitializationPanel.jsx", import.meta.url), "utf8");
  const goNextStart = panelSource.indexOf("function goNext()");
  const goNextEnd = panelSource.indexOf("async function copySettingPath", goNextStart);
  const goNextSource = panelSource.slice(goNextStart, goNextEnd);

  assert.match(goNextSource, /draft\.mode === "local"[\s\S]*?localProjectPickerMode === "flavor"/,
    "工程范围下一步必须识别当前正在配置的本机 Flavor 映射");
  assert.match(goNextSource, /applyStoryLocalFlavorMapping\([\s\S]*?localFlavorProjectSelections[\s\S]*?localFlavorSelections/,
    "下一步必须复用 canonical Flavor 映射函数，不能复制一份组装逻辑");
  assert.match(goNextSource, /if \(!mapping\.ok\)[\s\S]*?setErrors\([\s\S]*?primaryProjectId:[\s\S]*?return;/,
    "无效映射必须停留当前页并暴露 canonical 错误，不能放宽校验");
  assert.match(goNextSource, /validateStoryInitializationDraft\(nextDraft/,
    "下一步必须校验刚应用映射后的草稿，而不是闭包中的旧草稿");
});

test("本机 Flavor 映射在工程配置和分支刷新后重算，不保留过期命中", () => {
  const input = {
    vehicleMap: { carA: { apps: [{ appName: "App", repos: [{ repoId: "main", branch: "release/a" }] }] } },
    projectDefs: [{ id: "main", name: "Main", projectType: "application" }],
    projectApplications: [{ name: "App", repositories: [{ repositoryId: "main", projectIds: ["checkout"] }] }],
  };
  const project = { id: "checkout", name: "Checkout", path: "D:/repo/main", exists: true };
  const [before] = storyLocalFlavorMappingOptions({ ...input, projects: [{ ...project, branch: "main" }] });
  assert.equal(before.targets[0].status, "branch_mismatch");
  const [after] = storyLocalFlavorMappingOptions({ ...input, projects: [{ ...project, branch: "release/a" }] });
  assert.equal(after.targets[0].status, "ready");
  assert.equal(storyLocalFlavorMappingResolution(after).ok, true);
});

test("初始化配置为主工程和关联工程投影实时 Git 分支与当前 Flavor", () => {
  assert.deepEqual(storyInitializationProjectRuntimeStatus({
    id: "market",
    branch: "feature/CARB-100",
    path: "D:/workspace/AppMarket",
    exists: true,
  }, {
    market: "avatr8678Prod",
  }), {
    branch: "feature/CARB-100",
    flavor: "avatr8678Prod",
    path: "D:/workspace/AppMarket",
    branchLabel: "feature/CARB-100",
    flavorLabel: "avatr8678Prod",
    pathLabel: "D:/workspace/AppMarket",
  });
  assert.deepEqual(storyInitializationProjectRuntimeStatus({
    id: "web",
    branch: "",
    exists: true,
  }, {}), {
    branch: "",
    flavor: "",
    path: "",
    branchLabel: "未检测到",
    flavorLabel: "未指定",
    pathLabel: "本机路径未返回",
  });
  const unavailable = storyInitializationProjectRuntimeStatus({
    id: "missing",
    exists: false,
  }, {});
  assert.equal(unavailable.branchLabel, "路径不可用");
  assert.equal(unavailable.pathLabel, "路径不可用");

  const panelSource = readFileSync(new URL("./StoryInitializationPanel.jsx", import.meta.url), "utf8");
  const projectScopeStart = panelSource.indexOf('data-testid="story-initialization-projects"');
  const buildScopeStart = panelSource.indexOf('data-testid="story-initialization-build"', projectScopeStart);
  const projectScope = panelSource.slice(projectScopeStart, buildScopeStart);
  const primaryProjectStart = projectScope.indexOf('<LocalPrimaryProjectSelect');
  const relatedProjectStart = projectScope.indexOf('<div className={labelClass}>关联工程</div>', primaryProjectStart);
  const primaryProjectPicker = projectScope.slice(primaryProjectStart, relatedProjectStart);
  assert.match(primaryProjectPicker, /<LocalPrimaryProjectSelect[\s\S]*?projects=\{orderedLocalProjects\}/,
    "主工程必须使用能完整展示本机工程候选的自定义下拉");
  assert.match(panelSource, /function LocalPrimaryProjectSelect[\s\S]*?filteredProjects\.map[\s\S]*?<ProjectBranchTag/,
    "主工程的每个下拉候选必须展示当前 Git 分支标签");
  assert.match(panelSource, /function LocalPrimaryProjectSelect[\s\S]*?filterStoryInitializationProjects[\s\S]*?aria-label="搜索本机主工程"[\s\S]*?filteredProjects\.map/,
    "主工程下拉必须提供工程名、分支和完整路径搜索");
  assert.match(projectScope, /aria-label="搜索关联工程"[\s\S]*?relatedLocalProjects\.map/,
    "关联工程列表必须使用搜索结果而不是继续展示全部候选");
  assert.doesNotMatch(primaryProjectPicker, /<select/,
    "原生 select 无法在工程候选中展示分支标签，不得回退");
  assert.match(projectScope, /selectedPrimaryLocalProject[\s\S]*?<LocalProjectRuntimeMeta[\s\S]*?showFlavor=\{false\}/,
    "主工程选中后必须在工程范围页显示运行信息但不提前显示 Flavor");
  assert.match(projectScope, /toggleExtraProject[\s\S]*?<LocalProjectRuntimeMeta[\s\S]*?showFlavor=\{false\}/,
    "关联工程列表必须显示运行信息但不提前显示 Flavor");
  assert.match(projectScope, /return primaryProject && primaryProject\.exists !== false[\s\S]*?<StudioBtn/,
    "新建故事点的主工程也必须提供 Android Studio 打开按钮");
  assert.match(projectScope, /storyInitializationStudioPath\(project\) && project\.exists !== false[\s\S]*?<StudioBtn/,
    "新建故事点的关联工程也必须提供 Android Studio 打开按钮");
  assert.doesNotMatch(projectScope, /isEdit && [\s\S]{0,120}<StudioBtn/,
    "工程范围页的 Android Studio 按钮不能只在编辑态展示");
  assert.match(panelSource, /<RuntimeTag label="Git 分支"[\s\S]*?tone="branch"/,
    "Git 分支必须使用独立高亮标签");
  assert.match(panelSource, /<RuntimeTag label="Flavor"[\s\S]*?tone="flavor"/,
    "Flavor 必须使用独立高亮标签");
  assert.match(panelSource, /<RuntimeTag label="目录路径"[\s\S]*?tone="path"[\s\S]*?wide/,
    "目录路径必须使用可完整换行的独立高亮标签");
  assert.doesNotMatch(projectScope, /project\.path \|\| project\.id/,
    "工程范围页不应再以低对比度纯文本重复显示目录路径");
});

test("本机工程保留按分支入口并新增 Flavor 子 Tab、通用工程与刷新链路", () => {
  const panelSource = readFileSync(new URL("./StoryInitializationPanel.jsx", import.meta.url), "utf8");
  const pageSource = readFileSync(new URL("./index.jsx", import.meta.url), "utf8");
  const projectScopeStart = panelSource.indexOf('data-testid="story-initialization-projects"');
  const buildScopeStart = panelSource.indexOf('data-testid="story-initialization-build"', projectScopeStart);
  const projectScope = panelSource.slice(projectScopeStart, buildScopeStart);

  assert.match(projectScope, /\["branch", "按当前分支"[\s\S]*?\["flavor", "按车型 \/ Flavor"[\s\S]*?story-initialization-local-mode-\$\{id\}/,
    "本机工程必须同时保留按分支和按 Flavor 两个子 Tab");
  assert.match(projectScope, /data-testid="story-initialization-local-branch-picker"[\s\S]*?<LocalPrimaryProjectSelect/,
    "旧按分支主工程选择器必须保留");
  assert.match(projectScope, /data-testid="story-initialization-local-flavor-picker"[\s\S]*?\["common", "通用工程"[\s\S]*?story-local-flavor-group-\$\{category\}/,
    "Flavor 右侧必须将 WebApp 等通用工程独立分组");
  assert.match(projectScope, /data-testid="story-local-flavor-refresh"[\s\S]*?刷新工程与分支/,
    "工程配置或分支变化后必须有明确刷新映射入口");
  assert.match(projectScope, /projectMappingError[\s\S]*?role="alert"[\s\S]*?保留上次页面状态/,
    "本机关系读取失败不得伪装成空映射");
  assert.match(pageSource, /Promise\.all\(\[[\s\S]*?devbenchApi\.listProjects\(\)[\s\S]*?devbenchApi\.getProjectApplications\(\)/,
    "应并行刷新实时工程分支与本机应用仓库关系");
  assert.match(pageSource, /<StoryInitializationPanel[\s\S]*?projectApplications=\{projectApplications\}[\s\S]*?onRefreshProjects=\{reloadProjects\}/,
    "初始化面板必须消费本机仓库关系并能主动刷新");
});

test("工程范围的 AS 入口始终打开本机工程基础路径，不使用故事点 worktree", () => {
  const project = { id: "market", path: "D:/repo/market" };
  assert.equal(storyInitializationStudioPath(project), "D:/repo/market");
  assert.equal(storyInitializationStudioPath({ ...project, path: "  D:/repo/market  " }), "D:/repo/market");

  const panelSource = readFileSync(new URL("./StoryInitializationPanel.jsx", import.meta.url), "utf8");
  const pageSource = readFileSync(new URL("./index.jsx", import.meta.url), "utf8");
  assert.doesNotMatch(panelSource, /managedStudioPaths/,
    "配置面板不得再把故事点 worktree 映射为本机工程的 AS 打开路径");
  assert.doesNotMatch(pageSource, /<StoryInitializationPanel[\s\S]*?storyTab=\{/,
    "中央配置面板不得再接收故事点 worktree 作为本机工程 AS 路径来源");
  assert.match(panelSource, /<StudioBtn path=\{storyInitializationStudioPath\(primaryProject\)\}/,
    "主工程 AS 按钮必须显式使用基础工程路径解析函数");
  assert.match(panelSource, /<StudioBtn path=\{storyInitializationStudioPath\(project\)\}/,
    "关联工程 AS 按钮必须显式使用基础工程路径解析函数");
});

test("工作流与归档步骤只在编辑态展示，旧设置不进入共享工程快照", () => {
  assert.deepEqual(storyInitializationTabsForMode("create").map((item) => item.id), [
    "identity", "projects", "build", "review",
  ]);
  assert.deepEqual(storyInitializationTabsForMode("edit").map((item) => item.id), [
    "identity", "projects", "build", "workflow_archive", "review",
  ]);
  const draft = createStoryInitializationDraft({
    tab: {
      title: "旧故事点",
      mode: "local",
      primaryProjectId: "market",
      reportMode: "expert",
      archiveDir: "D:/story/ask/custom",
      effectiveArchiveDir: "D:/story/ask/custom",
      defaultArchiveDir: "D:/story/ask",
      archiveFile: "D:/story/ask/custom/旧故事点.txt",
      reportsDir: "D:/story/reports",
    },
    projects,
  });
  assert.equal(draft.reportMode, "expert");
  assert.equal(draft.archiveMode, "custom");
  assert.equal(draft.archiveDir, "D:/story/ask/custom");
  const shared = storyConfigurationSnapshot(draft, projects);
  assert.equal(Object.hasOwn(shared, "reportMode"), false);
  assert.equal(Object.hasOwn(shared, "archiveDir"), false);
  assert.equal(Object.hasOwn(shared, "archiveMode"), false);
});

test("编辑故事点配置可在任意 Tab 直接确认，并支持主动刷新目标设备", () => {
  const createTabs = storyInitializationTabsForMode("create").map((item) => item.id);
  const editTabs = storyInitializationTabsForMode("edit").map((item) => item.id);
  assert.deepEqual(createTabs.map((tabId) => storyInitializationPrimaryAction("create", tabId)), [
    "next", "next", "next", "confirm",
  ]);
  assert.deepEqual(editTabs.map((tabId) => storyInitializationPrimaryAction("edit", tabId)), [
    "confirm", "confirm", "confirm", "confirm", "confirm",
  ]);

  const panel = readFileSync(new URL("./StoryInitializationPanel.jsx", import.meta.url), "utf8");
  assert.match(panel, /onRefreshDevices/);
  assert.match(panel, /data-testid="story-initialization-device-refresh"/);
  assert.match(panel, /primaryAction === "confirm"/);

  const storyTab = readFileSync(new URL("./StoryTab.jsx", import.meta.url), "utf8");
  const menuStart = storyTab.indexOf("function ConfigMenuBtn");
  const menuEnd = storyTab.indexOf("export default function StoryTab", menuStart);
  const menu = storyTab.slice(menuStart, menuEnd);
  assert.doesNotMatch(menu, /编辑故事点配置/);
  assert.doesNotMatch(menu, /story-open-configuration-panel/);
  assert.match(storyTab, /data-testid="story-config-toggle"[\s\S]*?onOpenStoryConfig\?\.\(\)/,
    "独立的配置工程按钮仍需打开故事点配置面板");
});

test("用户在初始化面板修改 TB 绑定后，显式草稿值优先于入口任务旧值", () => {
  const draft = createStoryInitializationDraft({
    body: { title: "改绑工单", ticketInput: "https://tb/task/new-ticket" },
    task: { title: "旧任务", ticketUrl: "https://tb/task/old-ticket" },
    projects,
  });
  assert.equal(draft.ticketInput, "https://tb/task/new-ticket");
});

test("空白故事点只要求唯一标题，本地模式额外要求有效主工程", () => {
  assert.equal(validateStoryInitializationDraft({ title: "新故事点", mode: "blank" }, {
    existingTitles: ["旧故事点"],
  }).ok, true);
  assert.equal(validateStoryInitializationDraft({ title: "旧故事点", mode: "blank" }, {
    existingTitles: ["旧故事点"],
  }).errors.title, "标题已存在，请换一个标题");
  assert.equal(validateStoryInitializationDraft({ title: "新故事点", mode: "local" }, {
    projects,
  }).errors.primaryProjectId, "请选择主工程");
});

test("确认配置只输出稳定工程 ID，应用到已有故事点时才解析基仓路径", () => {
  const draft = {
    title: "新故事点",
    mode: "local",
    primaryProjectId: "market",
    extraProjectIds: ["market", "web", "web"],
    flavorByProjectId: { market: "avatr8678" },
    deviceSerial: "device-1",
  };
  assert.deepEqual(storyInitializationConfig(draft), {
    mode: "local",
    primaryProjectId: "market",
    extraProjectIds: ["web"],
    flavors: [{ projectId: "market", flavor: "avatr8678" }],
    deviceSerial: "device-1",
  });
  assert.deepEqual(storyConfigurationSnapshot(draft, projects), {
    mode: "local",
    primaryProjectId: "market",
    basePrimaryProjectId: "market",
    baseExtraProjects: [{ path: "D:/repo/web", basePath: "D:/repo/web", baseProjectId: "web", name: "WebApp" }],
    flavors: [{ path: "D:/repo/market", flavor: "avatr8678" }],
    deviceSerial: "device-1",
  });
});

test("远程初始化把主工程和关联工程汇总为同一份可审核拉取配置", () => {
  assert.deepEqual(storyInitializationConfig({
    mode: "remote",
    projectDefId: "market",
    remoteProjectDefIds: ["sdk"],
    vehicle: "avatr8678",
    branch: "release/avatr8678",
    remoteFlavor: "avatr8678Prod",
    ticketInput: "CARB-10",
  }), {
    mode: "remote",
    projectDefId: "market",
    deviceSerial: "",
    remotePull: {
      vehicle: "avatr8678",
      tbId: "CARB-10",
      entries: [
        { projectId: "market", branch: "release/avatr8678", flavor: "avatr8678Prod" },
        { projectId: "sdk", branch: "release/avatr8678", flavor: "avatr8678Prod" },
      ],
    },
  });
});

test("车型与应用多选生成分支隔离预览并提交高层选择", () => {
  const projectDefs = [{ id: "market" }, { id: "web" }];
  const vehicleMap = {
    avatr8678: { apps: [{ appName: "应用市场", repos: [
      { repoId: "market", branch: "release/8678", flavor: "avatr8678Prod", targetRole: "primary" },
      { repoId: "web", branch: "release/shared" },
    ] }] },
    avatr8155: { apps: [{ appName: "应用市场", repos: [
      { repoId: "market", branch: "release/8155", flavor: "avatr8155Prod" },
      { repoId: "web", branch: "release/shared" },
    ] }] },
  };
  const preview = storyVehicleSourcePreview([
    { vehicle: "avatr8678", appNames: ["应用市场"] },
    { vehicle: "avatr8155", appNames: ["应用市场"] },
  ], vehicleMap, projectDefs);
  assert.equal(preview.ok, true);
  assert.equal(preview.entries.length, 3);
  assert.equal(preview.entries.filter((entry) => entry.projectId === "market").length, 2);
  assert.equal(preview.entries.find((entry) => entry.projectId === "web").consumers.length, 2);

  const config = storyInitializationConfig({
    mode: "remote",
    tbProjectId: "tb-project-1",
    ticketInput: "CARB-100",
    vehicleSelections: preview.selections,
    vehicleSourceEntries: preview.entries,
    projectDefId: preview.projectDefId,
  });
  assert.equal(config.tbProjectId, "tb-project-1");
  assert.equal(config.remotePull.sourcePlanVersion, 2);
  assert.equal(config.remotePull.vehicleSelections.length, 2);
  assert.equal(config.remotePull.entries.length, 3);
  assert.equal(validateStoryInitializationDraft({
    title: "多车型",
    ...config,
    vehicleSelections: preview.selections,
    vehicleSourceEntries: preview.entries,
  }).ok, true);
  assert.equal(validateStoryInitializationDraft({
    title: "缺少应用",
    mode: "remote",
    vehicleSelections: [{ vehicle: "avatr8678", appNames: [] }],
    vehicleSourceEntries: [],
  }).errors.vehicleSelections, "每个车型至少选择一个应用");
});

test("初始化面板只认本次显式复核 session，配置种子中的旧 run 不能充当创建证明", () => {
  assert.equal(storyInitializationInferenceRequest({ projectId: "project-a" }), null);
  assert.equal(storyInitializationInferenceRequest({
    snapshot: { configInference: { runId: "run-from-copied-story" } },
    projectId: "project-a",
  }), null);
  assert.deepEqual(storyInitializationInferenceRequest({
    snapshot: { configInference: { runId: "run-reviewed" } },
    session: { id: "run-session", projectId: "project-a" },
    localProjectBindings: [{ targetId: "primary", projectId: "market" }],
  }), {
    runId: "run-session",
    projectId: "project-a",
    localProjectBindings: [{ targetId: "primary", projectId: "market" }],
  });
});

test("车型候选只在远程模式写入 vehicle", () => {
  const applied = applyStoryInitializationConflictResolution(
    { mode: "remote", vehicle: "old" },
    { dimension: "vehicle" },
    { selection: "candidate:avatr8678", value: "avatr8678" },
  );
  assert.equal(applied.ok, true);
  assert.equal(applied.draft.vehicle, "avatr8678");
  assert.deepEqual(applied.appliedFields, ["vehicle"]);

  const rejected = applyStoryInitializationConflictResolution(
    { mode: "local", primaryProjectId: "market" },
    { dimension: "vehicle" },
    { selection: "candidate:avatr8678", value: "avatr8678" },
  );
  assert.equal(rejected.ok, false);
  assert.equal(rejected.draft.vehicle, undefined);
  assert.match(rejected.error, /以当前面板配置为准/);
});

test("分支候选写入远程 branch", () => {
  const applied = applyStoryInitializationConflictResolution(
    { mode: "remote", branch: "main" },
    { dimension: "branch" },
    { selection: "candidate:release/202606", value: "release/202606" },
  );
  assert.equal(applied.ok, true);
  assert.equal(applied.draft.branch, "release/202606");
  assert.equal(applied.resolution.value, "release/202606");
});

test("Flavor 候选按当前工程模式写入远程或本地主工程", () => {
  const remote = applyStoryInitializationConflictResolution(
    { mode: "remote", remoteFlavor: "dev" },
    { dimension: "flavor" },
    { selection: "candidate:avatr8678Prod", value: "avatr8678Prod" },
  );
  assert.equal(remote.ok, true);
  assert.equal(remote.draft.remoteFlavor, "avatr8678Prod");

  const local = applyStoryInitializationConflictResolution(
    { mode: "local", primaryProjectId: "market", flavorByProjectId: { web: "webDev" } },
    { dimension: "flavor" },
    { selection: "candidate:geelyp162Stg", value: "geelyp162Stg" },
  );
  assert.equal(local.ok, true);
  assert.deepEqual(local.draft.flavorByProjectId, {
    web: "webDev",
    market: "geelyp162Stg",
  });

  const withoutPrimary = applyStoryInitializationConflictResolution(
    { mode: "local", primaryProjectId: "" },
    { dimension: "flavor" },
    { selection: "candidate:prod", value: "prod" },
  );
  assert.equal(withoutPrimary.ok, false);
});

test("主工程候选按稳定仓库标识唯一映射到本机或远程主工程", () => {
  const candidateProjects = [
    { id: "market", repositoryId: "app-market", name: "应用市场", exists: true },
    { id: "web", repositoryId: "web-app", name: "WebApp", exists: true },
  ];
  const local = applyStoryInitializationConflictResolution(
    { mode: "local", primaryProjectId: "web", extraProjectIds: ["market", "web"] },
    { dimension: "repositoryId" },
    { selection: "candidate:app-market", value: "app-market" },
    { projects: candidateProjects },
  );
  assert.equal(local.ok, true);
  assert.equal(local.draft.primaryProjectId, "market");
  assert.deepEqual(local.draft.extraProjectIds, ["web"]);

  const remote = applyStoryInitializationConflictResolution(
    { mode: "remote", projectDefId: "sdk", remoteProjectDefIds: ["market", "sdk"] },
    { dimension: "applicationRepository" },
    { selection: "candidate:app-market", value: "app-market" },
    { projectDefs: [
      { id: "market", repositoryId: "app-market", name: "应用市场" },
      { id: "sdk", repositoryId: "sdk-api", name: "SDK" },
    ] },
  );
  assert.equal(remote.ok, true);
  assert.equal(remote.draft.projectDefId, "market");
  assert.deepEqual(remote.draft.remoteProjectDefIds, ["sdk"]);

  const appName = applyStoryInitializationConflictResolution(
    { mode: "remote", projectDefId: "sdk" },
    { dimension: "appName" },
    { selection: "candidate:应用市场", value: "应用市场" },
    { projectDefs: [
      { id: "market", repositoryId: "app-market", name: "应用市场" },
      { id: "sdk", repositoryId: "sdk-api", name: "SDK" },
    ] },
  );
  assert.equal(appName.ok, true);
  assert.equal(appName.draft.projectDefId, "market");
});

test("无法唯一映射的主工程候选不会被记录为已应用", () => {
  const draft = { mode: "remote", projectDefId: "current", conflictResolutions: {} };
  const result = applyStoryInitializationConflictResolution(
    draft,
    { dimension: "repositoryId" },
    { selection: "candidate:shared", value: "shared" },
    { projectDefs: [
      { id: "one", repositoryId: "shared" },
      { id: "two", repositoryId: "shared" },
    ] },
  );
  assert.equal(result.ok, false);
  assert.equal(result.draft.projectDefId, "current");
  assert.equal(result.resolution, undefined);
  assert.match(result.error, /匹配到多个远程工程定义/);
  assert.match(result.error, /以当前面板配置为准/);
});

test("人工裁决保留面板配置，并把实际当前值写入裁决记录", () => {
  const draft = { mode: "remote", branch: "story/CARB-1" };
  const result = applyStoryInitializationConflictResolution(
    draft,
    { dimension: "branch" },
    { selection: "manual" },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.draft, draft);
  assert.deepEqual(result.resolution, {
    dimension: "branch",
    selection: "manual",
    value: "story/CARB-1",
  });
});

test("选择候选后若人工改掉对应字段，旧裁决不再视为当前有效", () => {
  const conflict = { dimension: "branch" };
  const resolution = {
    dimension: "branch",
    selection: "candidate:release/202606",
    value: "release/202606",
  };
  assert.equal(storyInitializationConflictResolutionMatchesDraft(
    { mode: "remote", branch: "release/202606" },
    conflict,
    resolution,
  ), true);
  assert.equal(storyInitializationConflictResolutionMatchesDraft(
    { mode: "remote", branch: "story/manual-change" },
    conflict,
    resolution,
  ), false);
  assert.equal(storyInitializationConflictResolutionMatchesDraft(
    { mode: "remote", branch: "story/manual-change" },
    conflict,
    { dimension: "branch", selection: "manual", value: "story/manual-change" },
  ), true);
  assert.equal(storyInitializationConflictResolutionMatchesDraft(
    { mode: "remote", branch: "story/changed-again" },
    conflict,
    { dimension: "branch", selection: "manual", value: "story/manual-change" },
  ), false);
});

test("初始化入口按草稿 TB 项目加载车型映射，任务项目不能偷用全局当前项目", () => {
  const source = readFileSync(new URL("./index.jsx", import.meta.url), "utf8");
  const requestStart = source.indexOf("function requestStoryInitialization");
  const requestEnd = source.indexOf("function closeStoryInitialization", requestStart);
  const requestFlow = source.slice(requestStart, requestEnd);
  assert.match(requestFlow, /sourceConfigProjectId\s*=\s*initialDraft\.tbProjectId\s*\|\|\s*currentProjectId/);
  assert.match(source, /function loadStoryInitializationSourceConfig[\s\S]*?getRemoteConfig\(sourceConfigProjectId\)/);
  assert.match(source, /sourceConfigGeneration !== generation[\s\S]*?sourceConfigProjectId !== sourceConfigProjectId/);
  assert.match(source, /nextSourceConfigProjectId[\s\S]*?sourceConfigProjectChanged[\s\S]*?loadStoryInitializationSourceConfig/);
  assert.match(source, /setVehicleSourceConfig\(null\);[\s\S]*?setVehicleSourceConfigProjectId\(""\);[\s\S]*?setCurrentProjectId\(id\)/);
  assert.match(source, /storyVehicleSourceConfigForProject\([\s\S]*?sourceConfigProjectId,[\s\S]*?vehicleSourceConfigProjectId,[\s\S]*?vehicleSourceConfig/);
  assert.match(source, /reviewedTask\?\.projectId[\s\S]*?nextDraft = \{ \.\.\.nextDraft, tbProjectId: nextSourceConfigProjectId \}/);
  const resumeStart = source.indexOf("function resumeStoryInitializationAfterInference");
  const resumeEnd = source.indexOf("async function continueDeferredStoryEntry", resumeStart);
  const resumeFlow = source.slice(resumeStart, resumeEnd);
  assert.match(resumeFlow, /nextDraft\.tbProjectId[\s\S]*?loadStoryInitializationSourceConfig/);
  assert.match(resumeFlow, /projectId:\s*nextSourceConfigProjectId/,
    "人工复核改绑 TB 后，推理请求必须使用新项目而不是入口项目");
  assert.match(requestFlow, /projectId:\s*sourceConfigProjectId/);

  const taskStart = source.indexOf("async function createConfiguredTaskStoryPoint");
  const taskEnd = source.indexOf("async function startDevFromTask", taskStart);
  const taskFlow = source.slice(taskStart, taskEnd);
  assert.match(taskFlow, /body:\s*\{\s*title,\s*tbProjectId:\s*projId\s*\}/);
  assert.match(taskFlow, /initialOverrides:\s*\{[\s\S]*?tbProjectId:\s*projId/);

  const panelSource = readFileSync(new URL("./StoryInitializationPanel.jsx", import.meta.url), "utf8");
  const sourcePlanStart = panelSource.indexOf('data-testid="story-initialization-source-plan"');
  const sourcePlanEnd = panelSource.indexOf("</section>", sourcePlanStart);
  const sourcePlan = panelSource.slice(sourcePlanStart, sourcePlanEnd);
  assert.match(sourcePlan, /entry\.targetRole === "primary" \? "主工程" : "关联"/);
  assert.equal(sourcePlan.includes("index === 0 ? \"主工程\""), false);
});

test("编辑失败的后台初始化时恢复用户确认过的计划，而不是展示已清空的占位配置", () => {
  const snapshot = {
    sourceTabId: "story-1",
    sourceTitle: "初始化失败故事点",
    mode: "local",
    primaryProjectId: null,
    extraProjects: [],
    flavors: [],
    worktree: null,
    workspaceInitialization: { status: "error", error: "git worktree add failed" },
    plannedInitializationSnapshot: {
      mode: "local",
      primaryProjectId: "market",
      extraProjects: [{ baseProjectId: "web", path: "D:/repo/web" }],
      flavors: [{ path: "D:/repo/market", flavor: "seresProd" }],
      deviceSerial: "DEVICE-001",
    },
  };

  const editable = storyConfigurationSnapshotForEditing(snapshot);
  assert.equal(editable.primaryProjectId, "market");
  assert.equal(editable.extraProjects[0].baseProjectId, "web");
  assert.equal(editable.flavors[0].flavor, "seresProd");
  assert.equal(editable.deviceSerial, "DEVICE-001");
  assert.equal(editable.workspaceInitialization.status, "error");
  assert.equal(editable.sourceTabId, "story-1");

  const draft = createStoryInitializationDraft({
    snapshot: editable,
    projects,
    tab: { reportMode: "expert", archiveDir: "D:/story/archive" },
  });
  assert.equal(draft.primaryProjectId, "market");
  assert.deepEqual(draft.extraProjectIds, ["web"]);
  assert.equal(draft.flavorByProjectId.market, "seresProd");
  assert.equal(draft.reportMode, "expert");
  assert.equal(draft.archiveDir, "D:/story/archive");

  const readySnapshot = { ...snapshot, workspaceInitialization: { status: "ready" } };
  assert.equal(storyConfigurationSnapshotForEditing(readySnapshot), readySnapshot);

  const source = readFileSync(new URL("./index.jsx", import.meta.url), "utf8");
  const editStart = source.indexOf("async function openStoryConfiguration");
  const editEnd = source.indexOf("function askTitle", editStart);
  const editFlow = source.slice(editStart, editEnd);
  assert.match(editFlow, /storyConfigurationSnapshotForEditing\(snapshotResult\.data\)/);
  assert.match(editFlow, /snapshot:\s*editableSnapshot/);
});

test("后台初始化完成事件丢失时持续校准 Tab，且旧刷新响应不能覆盖 ready", () => {
  assert.deepEqual(storyWorkspaceInitializationPendingIds([
    {
      id: "local-pending",
      workspaceInitialization: { status: "preparing" },
      worktreeStatus: "preparing",
    },
    {
      id: "remote-pending",
      remoteSourceInitialization: { status: "cloning" },
      cloneStatus: "cloning",
    },
    {
      id: "ready",
      workspaceInitialization: { status: "ready" },
      worktreeStatus: "ready",
    },
    {
      id: "failed",
      workspaceInitialization: { status: "error" },
      worktreeStatus: "error",
    },
  ]), ["local-pending", "remote-pending"]);

  const source = readFileSync(new URL("./index.jsx", import.meta.url), "utf8");
  assert.match(source, /const requestId = \+\+reloadTabsRequestSeqRef\.current/);
  assert.match(source, /if \(requestId < reloadTabsAppliedSeqRef\.current\) return list;/);
  assert.match(source, /const pendingWorkspaceInitializationIds = storyWorkspaceInitializationPendingIds\(tabs\)/);
  assert.match(source, /workspaceInitializationPollTimerRef\.current = setTimeout\(poll, 1000\)/);
});

test("远程源码总进度随 operation 事件和持久化状态单调更新", () => {
  const started = mergeRemoteCloneProgress(null, {
    tabId: "story-remote",
    repo: "__all__",
    operationId: "operation-1",
    generation: 1,
    status: "cloning",
    phase: "准备远程源码",
    percent: 5,
  });
  assert.equal(started.percent, 5);
  assert.equal(started.operationId, "operation-1");
  const advanced = mergeRemoteCloneProgress(started, {
    tabId: "story-remote",
    repo: "__all__",
    status: "cloning",
    phase: "Receiving objects",
    percent: 38,
  });
  assert.equal(advanced.percent, 38);
  const repository = mergeRemoteCloneProgress(advanced, {
    tabId: "story-remote",
    repo: "app-market",
    status: "cloning",
    phase: "Receiving objects",
    percent: 55,
  });
  assert.equal(repository.repos["app-market"].percent, 55);
  assert.equal(remoteSourceInitializationProgress({
    cloneStatus: "cloning",
    remoteSourceInitialization: { progress: 32 },
  }, repository), 38, "live total progress wins over an older persisted snapshot");
  assert.equal(remoteSourceInitializationProgress({
    cloneStatus: "cloning",
    remoteSourceInitialization: { progress: 47 },
  }, started), 47, "polling recovers progress when the WebSocket event is stale or missing");

  const nextGeneration = mergeRemoteCloneProgress(repository, {
    repo: "__all__",
    operationId: "operation-2",
    generation: 2,
    status: "cloning",
    percent: 5,
  });
  assert.deepEqual(nextGeneration.repos, {}, "a newer generation must not inherit repository rows from the old operation");
  const ignoredOldEvent = mergeRemoteCloneProgress(nextGeneration, {
    repo: "app-market",
    operationId: "operation-1",
    generation: 1,
    status: "error",
    error: "late A failure",
  });
  assert.deepEqual(ignoredOldEvent, nextGeneration, "a late old-generation event must not overwrite the current operation");
});

test("设备状态视图完整投影共享绑定、当前使用者和后续 FIFO 队列", () => {
  const view = deviceRuntimeStatusView({
    id: "SERIAL-001",
    connectivity: "online",
    bindings: [
      { storyId: "story-a", title: "故事点 A" },
      { storyId: "story-b", title: "故事点 B" },
    ],
    runtime: {
      status: "busy",
      lease: { requestId: "use-a", storyId: "story-a", operationKind: "story_turn", fencingToken: 7 },
      queue: [
        { requestId: "wait-b", storyId: "story-b", operationKind: "install_test", position: 1 },
        { requestId: "wait-plugin", storyId: "external:device-operation", operationKind: "adb_shell", metadata: { title: "诊断插件" }, position: 2 },
      ],
    },
  });

  assert.equal(view.online, true);
  assert.deepEqual(view.bindings.map((binding) => binding.title), ["故事点 A", "故事点 B"]);
  assert.deepEqual(view.currentUse, {
    requestId: "use-a",
    storyId: "story-a",
    storyTitle: "故事点 A",
    operationKind: "story_turn",
    operationLabel: "AI 任务",
    position: 0,
    fencingToken: 7,
    expired: false,
  });
  assert.deepEqual(view.queue.map((entry) => [entry.position, entry.storyTitle, entry.operationLabel]), [
    [1, "故事点 B", "安装测试"],
    [2, "诊断插件", "ADB 命令"],
  ]);

  const legacy = deviceRuntimeStatusView({
    id: "SERIAL-LEGACY",
    status: "device",
    bindings: [{ tabId: "story-old", title: "旧版故事点" }],
    currentUse: { requestId: "legacy-use", storyId: "story-old", operationKind: "plugin_operation" },
    useQueue: [{ requestId: "legacy-wait", storyId: "story-next", operationKind: "adb_push" }],
  });
  assert.equal(legacy.online, true);
  assert.equal(legacy.currentUse.storyTitle, "旧版故事点");
  assert.deepEqual(legacy.queue.map((entry) => [entry.position, entry.storyTitle, entry.operationLabel]), [
    [1, "story-next", "推送文件"],
  ]);
});

test("设备状态组件同时接入中央配置面板和兼容故事点配置区", () => {
  const card = readFileSync(new URL("./DeviceRuntimeStatusCard.jsx", import.meta.url), "utf8");
  const panel = readFileSync(new URL("./StoryInitializationPanel.jsx", import.meta.url), "utf8");
  const storyTab = readFileSync(new URL("./StoryTab.jsx", import.meta.url), "utf8");

  assert.match(card, /data-testid="device-runtime-bindings"/);
  assert.match(card, /data-testid="device-runtime-current-use"/);
  assert.match(card, /data-testid="device-runtime-queue"/);
  assert.match(card, /后续 FIFO 队列/);
  assert.match(panel, /<DeviceRuntimeStatusCard[\s\S]*?draft\.deviceSerial/);
  assert.match(storyTab, /<DeviceRuntimeStatusCard[\s\S]*?tab\.deviceSerial/);
});
