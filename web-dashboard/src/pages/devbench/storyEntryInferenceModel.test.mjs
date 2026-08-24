import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  confirmedConfigInferenceSnapshot,
  configInferenceSnapshotForReviewResult,
  configInferenceReviewFailurePolicy,
  configInferenceReopenReviewProof,
  configInferenceStoryEntryScope,
  createConfigInferencePresentationGuard,
  createConfigInferenceSubmissionGuard,
  createStoryEntryInFlightGuard,
  isDeferredTaskGroupStoryEntry,
  isDeferredGitCommitStoryEntry,
  isDeferredStoryInitializationEntry,
  isDeferredStoryInitializationPanelEntry,
  isDeferredStoryReopenEntry,
  isDeferredTeamDevStoryEntry,
  isDeferredTaskStoryEntry,
  isStoryPointAiInferenceEnabled,
  resolveInferenceProjectId,
  resolveClosedStoryIdForTask,
  reopenReviewedConfigPartialResult,
  resolveStoryInferenceProjectId,
  resolveTaskStoryInferenceTask,
  requiresSavedStoryCreationReview,
  requiresSavedStoryReopenReview,
  shouldDeferStoryEntry,
  shouldContinueDeferredStoryEntry,
  shouldDismissConfigInferenceBeforeReview,
  shouldDismissStoryInitializationSkipBeforeReview,
  shouldSkipReviewedSnapshotForConflict,
  taskStoryCreateEntry,
} from "./storyEntryInferenceModel.mjs";

const readSource = (relativePath) => fs.readFileSync(new URL(relativePath, import.meta.url), "utf8");

test("工程配置按应用组织多仓库多路径且 WebApp 独立，车型源码配置可恢复默认克隆父路径", () => {
  const projectConfig = readSource("./ProjectConfigModal.jsx");
  const review = readSource("./ConfigInferenceReview.jsx");
  const vehicleSource = readSource("./VehicleSourceModal.jsx");

  assert.doesNotMatch(projectConfig, /webAppPath|WebApp 路径（可空）/,
    "本机工程配置不能继续把 WebApp 作为主工程的附属路径");
  assert.match(projectConfig, /应用 → 关联 Git 仓库 → 多个本机路径/);
  assert.match(projectConfig, /list="project-application-options"[\s\S]*?data-testid="project-application-name"/,
    "应用名称必须支持自由输入以及带过滤能力的候选下拉");
  assert.match(projectConfig, /changeApplicationName[\s\S]*?repositories[\s\S]*?matched\.id/,
    "应用名称命中仓库定义时必须自动建立仓库关联");
  assert.match(projectConfig, /data-testid="project-repository-card"[\s\S]*?data-testid="project-local-path-row"/,
    "一个应用必须能包含多个仓库且每个仓库可包含多个本机路径");
  assert.match(projectConfig, /WebApp 与其他仓库完全相同，需要单独添加、单独选择路径/);
  assert.match(projectConfig, /<ProjectGitCell repoPath=\{project\.path\}/,
    "每条本机路径输入后必须按该路径独立读取并展示 Git 分支");
  assert.doesNotMatch(review, /inheritedWebApp|requiresWebApp|随主工程|config-local-project-inherited/,
    "AI 推理出的 WebApp 目标必须和其他工程一样由用户独立绑定");
  assert.match(vehicleSource, /setCloneParent\(cfg\?\.defaultCloneParent \|\| ""\)[\s\S]*?>默认<\/button>/,
    "车型源码配置应提供默认按钮并使用后端给出的本机默认路径");
  assert.match(projectConfig, /repositorySubscriptions=\{applicationLayoutPayload\(applications\)\}/,
    "车型初始预置必须复用已保存的应用仓库订阅，且不能上传本机路径");
  assert.match(vehicleSource, /data-testid="vehicle-source-generate-initial-presets"[\s\S]*?根据仓库订阅生成初始预置/,
    "车型源码配置必须暴露仓库订阅扫描入口");
  assert.match(vehicleSource, /previewVehicleInitialPresets[\s\S]*?previewVehicleConfigPublication/,
    "扫描候选必须继续进入团队发布预览，不能直接写共享配置");
});

test("工程配置重开立即复用应用布局缓存，车型源码配置合并为第三个 Tab", () => {
  const projectConfig = readSource("./ProjectConfigModal.jsx");
  const index = readSource("./index.jsx");

  assert.match(projectConfig, /const cachedLayout = projectConfigCache\.read\(projectId\)/);
  assert.match(projectConfig, /const \[layoutLoading, setLayoutLoading\] = useState\(\(\) => !cachedLayout\)/,
    "存在缓存时重开应用工程配置不能再次显示全量加载态");
  assert.match(projectConfig, /reloadProjectLayout\(\{ showLoading: !cached \}\)/,
    "缓存渲染后仍应在后台刷新服务端真值");
  assert.match(projectConfig, /cachedLayout \? cachedLayout\.applicationOptions : null/,
    "父面板候选未知时不能用空数组覆盖车型源码面板已有的独立缓存");
  assert.match(projectConfig, /if \(projectConfigCache\.read\(projectId\)\) \{[\s\S]*?applicationOptions: nextOptions/,
    "候选项先返回时不能生成假的空布局快照");
  assert.match(projectConfig, /applicationOptionsRef\.current \|\| \[\]/,
    "布局后返回时应合并已经到达的候选项");
  assert.match(projectConfig, /aria-selected=\{tab === "vehicle"\}[\s\S]*?>车型源码配置<\/button>/);
  assert.match(projectConfig, /<VehicleSourceModal[\s\S]*?embedded[\s\S]*?projectDefs=\{defs\}/,
    "车型源码配置必须复用工程配置面板及其仓库定义状态");
  assert.doesNotMatch(index, /showVehicle|setShowVehicle|import VehicleSourceModal/,
    "工程开发页不能再维护第二个独立车型源码弹窗");
  assert.match(index, /setConfigInitialTab\("vehicle"\); setShowConfig\(true\)/,
    "旧快捷入口仍应直达合并后的车型源码 Tab");
});

test("story project configuration entries open the central panel", () => {
  const source = readSource("./StoryTab.jsx");
  const missingProjectEntries = source.match(
    /if \(!tab\.primaryProjectId\) \{ onOpenStoryConfig\?\.\(\); return; \}/g,
  ) || [];

  assert.equal(missingProjectEntries.length, 3,
    "upload, drop, and send must all open the central panel when the primary project is missing");
  assert.match(source, /const \[showConfig\] = useState\(false\)/,
    "the legacy inline configuration must not auto-open for an unconfigured story");
  assert.match(source,
    /data-testid="story-config-toggle"[\s\S]{0,350}onOpenStoryConfig\?\.\(\);[\s\S]{0,250}>\s*配置工程\s*<\/button>/,
    "the visible configuration button must open the central multi-tab panel");
  assert.doesNotMatch(source, /setShowConfig\(/,
    "no current user entry may reopen the legacy inline configuration");
});

test("AI 命令按回答聚合为一个短标签区域并统一展开全部命令", () => {
  const source = readSource("./StoryTab.jsx");
  const sectionStart = source.indexOf("function ToolCommandSection");
  const sectionEnd = source.indexOf("function tailLogText", sectionStart);
  const section = source.slice(sectionStart, sectionEnd);
  assert.match(section, /<details[\s\S]*?<summary[\s\S]*?<span className="shrink-0">命令<\/span>[\s\S]*?commands\.length[\s\S]*?commands\.map/,
    "命令区域必须只用一个 details 和“命令 + 数量”短标签包住全部命令");
  assert.doesNotMatch(section, /<details[^>]*\sopen(?:=|\s|>)/,
    "整块命令区域必须默认收起");
  assert.equal((section.match(/<details/g) || []).length, 1,
    "单条命令不得再各自创建 details");
  const summary = section.slice(section.indexOf("<summary"), section.indexOf("</summary>") + 10);
  assert.doesNotMatch(summary, /title=\{(?:detail|command)/,
    "收起态不得通过标题继续展示完整命令");
  assert.match(section, /const name = String\(item\.content[\s\S]*?const detail = String\(item\.input \|\| name\)[\s\S]*?command\.name[\s\S]*?<pre[\s\S]*?>\{command\.detail\}<\/pre>/,
    "统一展开后必须按顺序显示每条工具名和完整命令参数");
  assert.match(source, /<ToolCommandSection tools=\{tools\} \/>/,
    "历史回答必须使用统一命令区域");
  assert.match(source, /<ToolCommandSection tools=\{live\.tools\} live \/>/,
    "实时回答必须使用同一个统一命令区域");
  assert.doesNotMatch(source, /ToolCommandChip/,
    "旧的逐条命令展开组件必须移除");

  const liveStart = source.indexOf('data-testid="live-command-output-details"');
  const liveEnd = source.indexOf("</details>", liveStart);
  const liveOutput = source.slice(source.lastIndexOf("<details", liveStart), liveEnd + 10);
  assert.match(liveOutput, /<summary[\s\S]*?实时命令输出[\s\S]*?显示最近输出，完整内容以脚本日志为准/);
  assert.doesNotMatch(liveOutput, /<details[^>]*\sopen(?:=|\s|>)/,
    "实时命令输出必须可以单独展开收起且默认收起");
});

test("基础仓库无法安全映射时在聊天输入区持久醒目提示且不冒充 AI 已执行", () => {
  const indexSource = readSource("./index.jsx");
  assert.match(indexSource, /STORY_BASE_WORKTREE_MISSING/);
  assert.match(indexSource, /STORY_BASE_WORKTREE_AMBIGUOUS/);
  assert.match(indexSource, /STORY_WORKTREE_INTEGRITY_INVALID/);
  assert.match(indexSource, /STORY_BASE_REPOSITORY_PROTECTED/);

  const sendStart = indexSource.indexOf("async function onSend(");
  const sendEnd = indexSource.indexOf("async function onSetPrimary", sendStart);
  const sendFlow = indexSource.slice(sendStart, sendEnd);
  assert.match(sendFlow, /repositoryPathAlertFromResponse\(r\)[\s\S]*?rememberRepositoryPathAlert\(tabId, repositoryPathAlert\)[\s\S]*?await reloadTabs\(\)/,
    "普通发送的路径映射错误必须先保留即时告警并刷新服务端 tab 状态");
  assert.match(sendFlow, /else \{\s*clearTransientRepositoryPathAlert\(tabId\)/,
    "普通发送成功后必须清除旧的本地瞬时告警");

  const editStart = indexSource.indexOf("async function onEditAndResend(");
  const editEnd = indexSource.indexOf("async function onSelectConversationBranch", editStart);
  const editFlow = indexSource.slice(editStart, editEnd);
  assert.match(editFlow, /repositoryPathAlertFromResponse\(r\)[\s\S]*?rememberRepositoryPathAlert\(tabId, repositoryPathAlert\)[\s\S]*?await reloadTabs\(\)/,
    "编辑重发的路径映射错误也必须刷新服务端 tab 状态");
  assert.match(editFlow, /clearTransientRepositoryPathAlert\(tabId\)/,
    "编辑重发成功后必须清除旧的本地瞬时告警");
  assert.match(indexSource, /repositoryPathAlert=\{repositoryPathAlertMap\[active\.id\] \|\| null\}/,
    "错误响应中的即时告警必须传给当前故事点聊天框");

  const storyTabSource = readSource("./StoryTab.jsx");
  assert.match(storyTabSource, /const repositoryPathAlert = tab\.repositoryPathAlert \|\| responseRepositoryPathAlert/,
    "服务端 tab 持久告警必须优先于本地瞬时告警");
  const cardStart = storyTabSource.indexOf("function RepositoryPathAlertCard");
  const cardEnd = storyTabSource.indexOf("export default function StoryTab", cardStart);
  const card = storyTabSource.slice(cardStart, cardEnd);
  assert.match(card, /role="alert"/);
  assert.match(card, /AI 未执行/);
  assert.match(card, /story-repository-path-alert-issues[\s\S]*?issues\.map/,
    "告警必须逐条列出仓库路径和未映射或歧义原因");
  assert.match(card, /data-testid="story-repository-path-alert-config"[\s\S]*?onOpenStoryConfig\?\.\(\)/,
    "告警必须提供进入故事点工程配置的按钮");
  const composerStart = storyTabSource.indexOf("{/* Git Update 进度小窗");
  const textareaStart = storyTabSource.indexOf('data-testid="devbench-story-input"', composerStart);
  const composer = storyTabSource.slice(composerStart, textareaStart);
  assert.match(composer, /<RepositoryPathAlertCard/,
    "路径映射告警必须出现在聊天输入框上方而不是隐藏在 toast 中");
});

test("Git Update 失败弹窗在小屏幕内保留滚动详情和可点击关闭入口", () => {
  const storyTab = readSource("./StoryTab.jsx");
  const updateBar = readSource("./GitUpdateBar.jsx");

  assert.match(storyTab,
    /data-testid="git-update-popup"[\s\S]{0,260}className="fixed[^"]*bottom-2[^"]*sm:absolute[^"]*sm:bottom-full/,
    "窄屏必须改用视口定位，宽屏才恢复输入框上方的绝对定位");
  assert.match(storyTab,
    /data-testid="git-update-popup"[\s\S]{0,180}z-\[85\]/,
    "Git Update 操作栏必须高于全局开发工具浮层，避免短屏下关闭按钮被遮挡");
  assert.doesNotMatch(storyTab,
    /data-testid="git-update-popup"[\s\S]{0,300}sm:z-30/,
    "宽屏断点不得降低 Git Update 弹窗层级");
  assert.match(updateBar,
    /data-testid="git-update-result-panel"[\s\S]{0,220}max-h-\[calc\(100dvh-1rem\)\][\s\S]{0,220}sm:max-h-\[min\(520px,calc\(100dvh-10rem\)\)\]/,
    "弹窗整体高度必须同时受动态视口和输入区预留空间限制");
  assert.match(updateBar,
    /data-testid="git-update-scroll-region"[\s\S]{0,180}min-h-0 flex-1 overflow-y-auto overscroll-contain/,
    "长错误和多工程冲突只能滚动中间详情，不能把操作栏推离视口");
  assert.match(updateBar,
    /data-testid="git-update-close-footer"[\s\S]{0,120}onClick=\{onClose\}[\s\S]{0,260}>关闭<\/button>/,
    "失败态底部必须提供带文字的关闭按钮，不能只依赖可能越界的顶部图标");
});

test("初始化面板并发显示 AI 状态并接入可搜索 Flavor、工程打开和旧版配置", () => {
  const panel = readSource("./StoryInitializationPanel.jsx");
  const index = readSource("./index.jsx");
  assert.match(panel, /AI正在推理/);
  assert.match(panel, /AI 推理已完成/);
  assert.match(panel, /story-initialization-inference-ready[\s\S]*?查看 AI 建议 · 不影响创建/);
  assert.match(panel, /<EditableCombobox[\s\S]*?local-flavor-/);
  assert.match(panel, /<EditableCombobox[\s\S]*?story-initialization-remote-flavor/);
  assert.match(panel, /<StudioBtn path=\{storyInitializationStudioPath\(project\)\} onToast=\{onToast\} compact/);
  const primaryStart = panel.indexOf('htmlFor="story-initialization-primary-project"');
  const extraStart = panel.indexOf('<div className={labelClass}>关联工程</div>', primaryStart);
  const primaryEditor = panel.slice(primaryStart, extraStart);
  assert.match(primaryEditor, /primaryProject[\s\S]*?<StudioBtn path=\{storyInitializationStudioPath\(primaryProject\)\}/,
    "编辑故事点时主工程也必须提供 Android Studio 入口");
  assert.doesNotMatch(panel, /storyTab\?\.worktree\?\.entries[\s\S]*?baseProjectId[\s\S]*?worktreePath/,
    "故事点配置中的本机工程 Android Studio 入口不得改写为故事点 worktree");
  assert.match(panel, /if \(inferenceReviewOpen \|\| showArchiveDirPicker\) return/,
    "子弹窗打开时 Escape 不能关闭整个初始化面板");
  assert.match(panel, /activeTab === "workflow_archive"[\s\S]*?简短模式[\s\S]*?专家报告模式/);
  assert.match(index, /workflowReportMode\(tabId, nextReportMode\)/);
  assert.match(index, /setArchiveDir\(tabId, nextArchiveDir\)/);
  assert.match(index, /controlsLocked=\{false\}/,
    "AI 推理和来源配置加载都不能锁住用户编辑，最终确认由独立门禁控制");
});

test("远程源码后台初始化进度和失败重试常驻 StoryTab，不依赖旧配置区", () => {
  const source = readSource("./StoryTab.jsx");
  const bannerStart = source.indexOf('{(backgroundInitializing || backgroundInitializationFailed) && (');
  const bannerEnd = source.indexOf('{/* 故事点组：排队中横幅', bannerStart);
  const banner = source.slice(bannerStart, bannerEnd);
  assert.ok(bannerStart >= 0 && bannerEnd > bannerStart, "应存在统一后台初始化横幅");
  assert.match(source, /const remoteInitializing = \["queued", "cloning"\]\.includes\(tab\.cloneStatus\)/);
  assert.match(source, /const remoteInitializationFailed = tab\.cloneStatus === "error"/);
  assert.match(banner, /cloneProgress\?\.repos|remoteProgress/);
  assert.match(banner, /devbenchApi\.remoteInit\(tab\.id\)/);
  assert.doesNotMatch(banner, /showConfig/,
    "远程进度不能依赖固定关闭的旧配置区");
});

test("Git commit 并发推理继续携带完整预览证据", () => {
  const source = readSource("./index.jsx");
  assert.match(source, /preview: resolvedPreview/);
  assert.match(source, /if \(gitEntry\?\.preview\)[\s\S]*?buildGitCommitInferenceTicket\([\s\S]*?gitEntry\.preview/,
    "新面板并发推理不能退化成只有 revision 的简化工单");
});

test("changed TB binding resolves the real project before inference and creation", async () => {
  const oldTask = {
    id: "local-task-1",
    title: "Old TB title",
    storyTitle: "#CARB-100# Planned story",
    ticketUrl: "https://www.teambition.com/task/aaaaaaaaaaaaaaaaaaaaaaaa",
    ticketId: "aaaaaaaaaaaaaaaaaaaaaaaa",
    tbTaskId: "aaaaaaaaaaaaaaaaaaaaaaaa",
    carbId: "CARB-100",
    projectId: "old-project",
    description: "old description",
    note: "old note",
    comments: [{ content: "old comment" }],
    attachments: [{ name: "old.txt" }],
    tags: ["old"],
    sourceCoverage: { tbDescription: true },
  };
  let resolverInput = "";
  const resolved = await resolveTaskStoryInferenceTask(oldTask, {
    currentTicket: "CARB-200",
    storyTitle: "Final story title",
    resolveTbTask: async (input) => {
      resolverInput = input;
      return {
        ok: true,
        data: {
          tbTaskId: "bbbbbbbbbbbbbbbbbbbbbbbb",
          carbId: "carb-200",
          title: "New TB title",
          ticketUrl: "https://www.teambition.com/task/bbbbbbbbbbbbbbbbbbbbbbbb",
          projectId: "new-project",
          projectName: "New project",
        },
      };
    },
  });

  assert.equal(resolverInput, "CARB-200");
  assert.equal(resolved.ok, true);
  assert.equal(resolved.changed, true);
  assert.equal(resolved.task.id, "local-task-1", "the local todo identity must remain stable");
  assert.equal(resolved.task.projectId, "new-project", "the old TB project must not leak into inference");
  assert.equal(resolved.task.tbTaskId, "bbbbbbbbbbbbbbbbbbbbbbbb");
  assert.equal(resolved.task.ticketId, "bbbbbbbbbbbbbbbbbbbbbbbb");
  assert.equal(resolved.task.carbId, "CARB-200");
  assert.equal(resolved.task.storyTitle, "Final story title");
  assert.equal(resolved.task.title, "New TB title");
  assert.equal(resolved.task.description, "");
  assert.equal(resolved.task.note, "");
  assert.deepEqual(resolved.task.comments, []);
  assert.deepEqual(resolved.task.attachments, []);
  assert.deepEqual(resolved.task.tags, []);
  assert.deepEqual(resolved.task.sourceCoverage, {});

  const createEntry = taskStoryCreateEntry(resolved.task);
  assert.deepEqual(createEntry, {
    kind: "task_story",
    taskId: "local-task-1",
    tbTaskId: "bbbbbbbbbbbbbbbbbbbbbbbb",
    ticketUrl: "https://www.teambition.com/task/bbbbbbbbbbbbbbbbbbbbbbbb",
    ticketId: "bbbbbbbbbbbbbbbbbbbbbbbb",
    carbId: "CARB-200",
    title: "Final story title",
  });
  assert.deepEqual(configInferenceStoryEntryScope({
    kind: "story_initialization_panel",
    flowId: "flow-cross-project",
    body: { title: "Final story title", ticketInput: "CARB-200" },
    task: resolved.task,
    entry: createEntry,
  }), {
    kind: "story_initialization_panel",
    createEntries: [createEntry],
  });
});

test("same TB identity avoids a second lookup and a changed TB cannot reuse the old project", async () => {
  const task = {
    id: "local-task-1",
    tbTaskId: "bbbbbbbbbbbbbbbbbbbbbbbb",
    carbId: "CARB-200",
    ticketUrl: "https://www.teambition.com/task/bbbbbbbbbbbbbbbbbbbbbbbb",
    projectId: "new-project",
    storyTitle: "Final story title",
  };
  let lookups = 0;
  const sameTask = await resolveTaskStoryInferenceTask(task, {
    currentTicket: "CARB-200",
    storyTitle: "Final story title",
    resolveTbTask: async () => {
      lookups += 1;
      return { ok: false };
    },
  });
  assert.equal(sameTask.ok, true);
  assert.equal(sameTask.changed, false);
  assert.equal(sameTask.task, task);
  assert.equal(lookups, 0);

  const unresolvedProject = await resolveTaskStoryInferenceTask(task, {
    currentTicket: "CARB-300",
    storyTitle: "Final story title",
    resolveTbTask: async () => ({
      ok: true,
      data: {
        tbTaskId: "cccccccccccccccccccccccc",
        carbId: "CARB-300",
        ticketUrl: "https://www.teambition.com/task/cccccccccccccccccccccccc",
        projectId: "",
      },
    }),
  });
  assert.equal(unresolvedProject.ok, false);
  assert.match(unresolvedProject.error, /TB|project|项目/i);
});

test("TB entry reopens a closed existing story through the unified guarded flow", () => {
  const source = readSource("./index.jsx");
  const start = source.indexOf("async function createStoryPointFromTb");
  // 切片右边界取 backup 入口（紧邻 TB 入口之后），不再用 beginGitCommitConfigInference，
  // 避免把不相关的 createStoryPointFromBackup 中的 beginStoryEntry 算进 TB 入口。
  const end = source.indexOf("async function createStoryPointFromBackup", start);
  assert.ok(start >= 0 && end > start, "the TB entry handler must exist");
  const tbEntrySource = source.slice(start, end);
  assert.match(tbEntrySource, /if \(resolved\.existingTab\?\.id\) \{\s*if \(resolved\.existingTab\.closed === true\) \{\s*return await reopenClosed\(resolved\.existingTab\.id\);\s*\}\s*await reloadTabs\(\);/,
    "a closed match must reopen, while an active match must keep the direct switch path");
  assert.equal((tbEntrySource.match(/beginStoryEntry\(/g) || []).length, 1,
    "the TB handler may acquire only its new-story lock; reopenClosed owns the reopen lock");
  assert.ok(
    tbEntrySource.indexOf("return await reopenClosed(resolved.existingTab.id)")
      < tbEntrySource.indexOf('beginStoryEntry("tb_story")'),
    "the closed-story branch must run before the new-story entry lock is acquired",
  );

  const reopenStart = source.indexOf("async function reopenClosedNow");
  const reopenEnd = source.indexOf("async function reopenClosed", reopenStart + 1);
  const reopenSource = source.slice(reopenStart, reopenEnd);
  assert.match(reopenSource, /if \(!applied\) \{[\s\S]*?await reloadTabs\(\);[\s\S]*?reopenReviewedConfigPartialResult[\s\S]*?return partialResult;/,
    "a reopened record whose reviewed configuration failed must reconcile and return partial");
  assert.ok(
    reopenSource.indexOf("return partialResult") < reopenSource.indexOf("setActive(r.data.id)"),
    "reviewed configuration failure must return before activation, message loading, and the success toast",
  );
  const partialStart = reopenSource.indexOf("r?.partial === true");
  const partialEnd = reopenSource.indexOf("} else {", partialStart);
  const reopenPartialSource = reopenSource.slice(partialStart, partialEnd);
  assert.match(reopenPartialSource, /await reloadTabs\(\)/,
    "a partial reopen must reconcile the active list because the record may already have moved out of closed storage");
  assert.match(reopenPartialSource, /tabId: recoveryTabId/,
    "the partial result must preserve a locatable active tab id for manual recovery");
  assert.doesNotMatch(reopenPartialSource, /setActive\(|loadMessages\(|已打开该故事点（/,
    "partial reopen reconciliation must not masquerade as a successful open");
});

test("reviewed configuration failure converts a successful reopen into a locatable partial result", () => {
  const result = reopenReviewedConfigPartialResult({
    ok: true,
    restored: 1,
    data: { id: "story-1", title: "原故事点" },
  }, {
    tabId: "story-1",
    recoveredTab: { id: "story-1", title: "原故事点" },
  });
  assert.equal(result.ok, false);
  assert.equal(result.partial, true);
  assert.equal(result.tabId, "story-1");
  assert.equal(result.recoveryTabFound, true);
  assert.equal(result.code, "STORY_REOPEN_REVIEWED_CONFIG_APPLY_FAILED");
  assert.match(result.error, /已恢复到活动列表/);
  assert.match(result.error, /工作流未启动/);
});

test("group creation locks shared configuration and joins each completed member immediately", () => {
  const source = readSource("./index.jsx");
  const panel = readSource("./StoryInitializationPanel.jsx");
  const groupStart = source.indexOf("async function continueGroupDevFromTasks");
  const groupEnd = source.indexOf("async function cancelTeamFromTask", groupStart);
  const groupSource = source.slice(groupStart, groupEnd);
  assert.match(source, /sharedConfigurationSnapshot: anchorSnapshot,[\s\S]*?sharedConfigurationSource: `组锚/,
    "team creation must seed and lock from the anchor snapshot");
  assert.match(groupSource, /getConfigSnapshot\(anchorTabId\)[\s\S]*?sharedConfigurationSnapshot = actualConfig\.data/,
    "the first task actual configuration must become the group source");
  assert.match(groupSource, /const joined = await devbenchApi\.groupJoin\(tabId, anchorTabId\);[\s\S]*?created\.push\(\{ task, tabId, disposition: ensured\.disposition \}\);/,
    "each later member must join before it is counted as completed");
  assert.match(groupSource, /if \(!tabId\) \{[\s\S]*?return partialResult/,
    "a second or third initialization cancellation must report the completed prefix");
  assert.match(groupSource, /if \(!joined\.ok\) \{[\s\S]*?return partialResult/,
    "a join failure must report partial completion instead of claiming group success");
  assert.doesNotMatch(groupSource, /groupLeave\(tabId\)/,
    "atomic groupJoin must migrate directly without first leaving the old group");
  const teamStart = source.indexOf("async function continueTeamDev");
  const teamEnd = source.indexOf("async function confirmTeamDev", teamStart);
  assert.doesNotMatch(source.slice(teamStart, teamEnd), /groupLeave\(tabId\)/,
    "team migration must also preserve the old group until atomic groupJoin succeeds");
  assert.match(groupSource, /已完成项保持可用，不自动回滚工作区/);

  assert.match(panel, /const sharedConfigurationLocked = !isEdit && !!sharedConfigurationDraft/,
    "ordinary creation and edit panels must remain configurable");
  assert.match(panel, /const configurationDisabled = formDisabled \|\| sharedConfigurationLocked/);
  assert.match(panel, /data-testid="story-initialization-shared-configuration-lock"/);
  assert.match(panel, /id="story-initialization-title-input"[\s\S]*?disabled=\{formDisabled\}/,
    "group members must still be able to confirm their title");
  assert.match(panel, /id="story-initialization-ticket-input"[\s\S]*?disabled=\{formDisabled\}/,
    "group members must still be able to confirm their TB binding");
  assert.match(panel, /id="story-initialization-primary-project"[\s\S]*?disabled=\{configurationDisabled\}/,
    "group project controls must be locked");
  assert.match(panel, /id="story-initialization-device"[\s\S]*?disabled=\{configurationDisabled\}/,
    "the shared device must be read-only in the member panel");
  assert.match(source, /const creationDraft = pending\.sharedConfigurationDraft[\s\S]*?deviceSerial: ""/,
    "a new member must defer the occupied anchor device until groupJoin inherits it");
});

test("initialization retry reuses the prepared intent and freezes partial creation for manual recovery", () => {
  const source = readSource("./index.jsx");
  const panel = readSource("./StoryInitializationPanel.jsx");
  const start = source.indexOf("async function confirmStoryInitialization");
  const end = source.indexOf("function askTitle", start);
  const confirmSource = source.slice(start, end);
  assert.match(confirmSource, /storyInitializationIntentRequestFingerprint\(prepareRequest\)/);
  assert.match(confirmSource, /if \(!canReuseStoryInitializationIntent\(preparedIntent, requestFingerprint\)\) \{[\s\S]*?prepareStoryInitialization\(prepareRequest\)/,
    "same draft and proof must skip a second prepare call");
  assert.match(confirmSource, /patchStoryInitialization\(pending\.flowId, \{ preparedIntent \}\)/,
    "server intent id and fingerprint must survive an unknown final-create result");
  assert.match(confirmSource, /createTab\(\{ initializationIntentId: preparedIntent\.id \}\)/);
  assert.match(confirmSource, /if \(shouldDiscardStoryInitializationIntent\(result\)\) \{[\s\S]*?preparedIntent: null/,
    "an explicitly expired, foreign-owner, wrong-consumer, or stale-scope intent must be re-prepared on retry");
  const partialStart = confirmSource.indexOf("result?.partial === true && result?.tabId");
  const partialEnd = confirmSource.indexOf("if (!result?.ok)", partialStart);
  const partialSource = confirmSource.slice(partialStart, partialEnd);
  assert.match(partialSource, /await reloadTabs\(\)[\s\S]*?busy: false[\s\S]*?partialRecovery:[\s\S]*?return;/,
    "partial creation must refresh evidence and stay in an explicit recovery state");
  assert.doesNotMatch(partialSource, /ok: true|reconciled: true/,
    "partial worktree or device residue must never be upgraded to successful creation");
  assert.match(confirmSource, /if \(pending\.partialRecovery\) \{[\s\S]*?return;/,
    "a direct confirm call must not replay or prepare a new intent after partial creation");
  const syncStart = source.indexOf("function syncStoryInitializationDraft");
  const syncEnd = source.indexOf("async function prepareStoryInitializationInference", syncStart);
  assert.match(source.slice(syncStart, syncEnd), /if \(!pending \|\| !draft \|\| pending\.partialRecovery\) return;/,
    "draft effects emitted after partial creation must not clear its prepared intent or recovery state");
  assert.match(source, /partialRecovery=\{storyInitialization\.partialRecovery\}/);
  assert.match(source, /canConfirm=\{!storyInitialization\.partialRecovery &&/,
    "ordinary confirmation must be disabled while recovery is pending");
  assert.match(panel, /const recoveryLocked = !!partialRecovery;[\s\S]*?const formDisabled = busy \|\| controlsLocked \|\| recoveryLocked;/);
  assert.match(panel, /data-testid="story-initialization-partial-recovery"[\s\S]*?打开残留故事点并人工核对/,
    "the panel must expose a dedicated, explicit manual-recovery action");

  const openStart = source.indexOf("async function openStoryInitializationPartialRecovery");
  const openEnd = source.indexOf("function syncStoryInitializationDraft", openStart);
  const openSource = source.slice(openStart, openEnd);
  assert.match(openSource, /pending\.resolve\?\.\(\{[\s\S]*?ok: false,[\s\S]*?partial: true,[\s\S]*?recovery: true/,
    "opening the residual tab must settle the entry as partial, never successful");
  assert.doesNotMatch(openSource, /kickTbWorkflow|ok: true/,
    "manual recovery must never auto-start the workflow");

  const closeStart = source.indexOf("function closeStoryInitialization");
  const closeEnd = source.indexOf("async function openStoryInitializationPartialRecovery", closeStart);
  const closeSource = source.slice(closeStart, closeEnd);
  assert.match(closeSource, /if \(pending\.partialRecovery\) \{[\s\S]*?ok: false,[\s\S]*?partial: true/,
    "closing a partial result must preserve its failure outcome rather than report cancellation or success");
});

test("story initialization prepare and create requests have finite abort timeouts", () => {
  const api = readSource("./api.js");
  assert.match(api, /STORY_INITIALIZATION_PREPARE_TIMEOUT_MS = 30_000/);
  assert.match(api, /STORY_INITIALIZATION_CREATE_TIMEOUT_MS = 30_000/);
  assert.match(api, /CONFIG_INFERENCE_REVIEW_TIMEOUT_MS = 30_000/);
  const callStart = api.indexOf("async function call");
  const callEnd = api.indexOf("async function probeGateway", callStart);
  const callSource = api.slice(callStart, callEnd);
  assert.match(callSource, /new AbortController\(\)[\s\S]*?setTimeout\(\(\) => controller\.abort\(\), timeoutMs\)/);
  assert.match(callSource, /code: "REQUEST_TIMEOUT"[\s\S]*?retryable: true/);
  assert.match(api, /prepareStoryInitialization:[\s\S]*?STORY_INITIALIZATION_PREPARE_TIMEOUT_MS/);
  assert.match(api, /reviewConfigInference:[\s\S]*?CONFIG_INFERENCE_REVIEW_TIMEOUT_MS/,
    "AI review persistence must not leave the initialization panel locked indefinitely");
  assert.match(api, /createTab:[\s\S]*?STORY_INITIALIZATION_CREATE_TIMEOUT_MS/);
  assert.match(api, /createGitCommitStory:[\s\S]*?STORY_INITIALIZATION_CREATE_TIMEOUT_MS/,
    "Git-backed initialization must use the same finite final-create timeout");
  assert.match(api, /retryStoryWorkspaceInitialization:[\s\S]*?workspace-initialization\/retry/,
    "failed background initialization must expose an explicit retry API");
});

test("expired or stale AI review proof preserves the draft and exposes a rerun path", () => {
  const source = readSource("./index.jsx");
  const staleStart = source.indexOf("function markStoryInitializationInferenceStale");
  const staleEnd = source.indexOf("async function prepareStoryInitializationInference", staleStart);
  const staleSource = source.slice(staleStart, staleEnd);
  assert.match(staleSource, /storyInitializationRequiresInferenceRefresh\(result\)/);
  assert.match(staleSource, /busy: false,[\s\S]*?preparedIntent: null,[\s\S]*?inferencePhase: "stale",[\s\S]*?inferenceStatus: "failed"/);
  assert.doesNotMatch(staleSource, /currentDraft|initialDraft/,
    "proof expiry must preserve every field currently visible in the initialization panel");

  const confirmStart = source.indexOf("async function confirmStoryInitialization");
  const confirmEnd = source.indexOf("function askTitle", confirmStart);
  const confirmSource = source.slice(confirmStart, confirmEnd);
  assert.match(confirmSource, /prepareStoryInitialization\(prepareRequest\)[\s\S]*?markStoryInitializationInferenceStale\(pending, prepared\)/,
    "prepare-time proof expiry must enter the stale recovery state");
  assert.match(confirmSource, /createTab\(\{ initializationIntentId: preparedIntent\.id \}\);[\s\S]*?markStoryInitializationInferenceStale\(pending, result\)/,
    "create-time proof expiry must enter the same stale recovery state");
  assert.match(source, /onRunInference=\{\["error", "stale"\]\.includes\(storyInitialization\.inferencePhase\)/,
    "stale recovery must show the explicit rerun-inference action");
});

test("initialization panel renders structured inference summaries through the readable model", () => {
  const panel = readSource("./StoryInitializationPanel.jsx");
  assert.match(panel, /storyInitializationInferenceSummaryText,/,
    "the component must import the structured summary formatter");
  assert.match(panel, /const resolvedInferenceSummary = storyInitializationInferenceSummaryText\(inferenceSummary, inference\);/);
  assert.doesNotMatch(panel, /function inferenceSummaryText\(/,
    "the old object-to-String formatter must not remain in the component");
  assert.doesNotMatch(panel, /text\(inferenceSummary\)/,
    "structured summary objects must never be implicitly rendered as [object Object]");
  assert.doesNotMatch(panel, /未命名(?:远程)?工程/,
    "incomplete inference must use an actionable confirmation hint, not an unnamed-project placeholder");
});

test("reviewed Git configuration is not overwritten by stale preview seeds", () => {
  const source = readSource("./index.jsx");
  const start = source.indexOf("async function createStoryPointFromGitCommit");
  const end = source.indexOf("async function createConfiguredTaskStoryPoint", start);
  const gitSource = source.slice(start, end);
  assert.match(gitSource, /snapshot: reviewedSnapshot,[\s\S]*?\.\.\.\(!reviewedSnapshot \? \{ initialOverrides \} : \{\}\)/,
    "preview overrides may seed only the no-review path");
  assert.doesNotMatch(gitSource, /snapshot: reviewedSnapshot,[\s\S]*?localProjectBindings,[\s\S]*?initialOverrides,\s*entry:/,
    "the dispatcher must not pass stale overrides unconditionally after review");
});

test("新建浮层保留独立空白标题 Tab 且移除选择工程直建入口", () => {
  const source = readSource("./NewStoryPanel.jsx");
  assert.match(source, /new-story-tab-\$\{item\.id\}/);
  assert.match(source, /new-story-blank-title/);
  assert.match(source, /const result = await onCreateBlank\?\.\(\{ title \}\)/,
    "空白入口必须等待初始化事务的真实结果，不能点击后立即结束 busy 状态");
  assert.doesNotMatch(source, /选择工程新建故事点/);
  assert.doesNotMatch(source, /onCreateProject/);
});

test("初始化事务仅在取消或真实创建成功时 settle，创建失败保留面板供重试", () => {
  const source = readSource("./index.jsx");
  const start = source.indexOf("async function confirmStoryInitialization");
  const end = source.indexOf("function askTitle", start);
  assert.ok(start >= 0 && end > start, "应存在初始化确认事务");
  const confirmSource = source.slice(start, end);
  assert.equal((confirmSource.match(/pending\.resolve\?\./g) || []).length, 1,
    "confirm 的 resolver 只能在成功路径调用一次");
  assert.match(confirmSource, /if \(!result\?\.ok\) throw new Error/);
  const catchStart = confirmSource.indexOf("} catch (error) {");
  assert.ok(catchStart >= 0, "应有可恢复失败分支");
  const catchSource = confirmSource.slice(catchStart);
  assert.match(catchSource, /busy: false/);
  assert.doesNotMatch(catchSource, /resolve\?\./,
    "创建失败不能提前结束入口 Promise 或释放全局入口锁");
  assert.match(source, /async function newTab[\s\S]*?return await createInitializedStory\(body\);[\s\S]*?finally \{\s*finishStoryEntry\(entryToken\);/,
    "空白和复制入口锁必须覆盖整个初始化事务");
});

test("AI 推理开关只保留在设置页而不重复放入设备页", () => {
  const settings = readSource("../Settings.jsx");
  const devices = readSource("../Devices.jsx");
  assert.match(settings, /label="故事点 AI 推理"/);
  assert.match(settings, /默认关闭/);
  assert.doesNotMatch(devices, /故事点 AI 推理/);
});

test("推理正确的确认动作冻结服务端快照，复核保存失败仍可应用到故事点", () => {
  const snapshot = {
    mode: "remote",
    projectDefId: "appMarket",
    remotePull: {
      vehicle: "geelyss21",
      entries: [
        { projectId: "appMarket", branch: "release/geely-e22", flavor: "geelyss21", targetRole: "primary" },
        { projectId: "webApp", branch: "release/geely-e22", flavor: "geelyss21", targetRole: "dependency" },
      ],
    },
  };
  const session = { suggestedSnapshot: snapshot };

  assert.equal(confirmedConfigInferenceSnapshot(session, { decision: "correct", apply: true }), snapshot);
  assert.equal(confirmedConfigInferenceSnapshot(session, { decision: "correct", apply: false }), null);
  assert.equal(confirmedConfigInferenceSnapshot(session, { decision: "insufficient", apply: true }), null);
  assert.equal(confirmedConfigInferenceSnapshot(session, { decision: "ticket_wrong", apply: true }), null);
  assert.equal(confirmedConfigInferenceSnapshot(session, {
    decision: "corrected",
    correctedPrediction: { targets: [{ repositoryId: "webApp" }] },
    apply: true,
  }), null, "人工纠正后不能误用纠正前的 suggestedSnapshot");
  assert.equal(confirmedConfigInferenceSnapshot(session, {
    decision: "correct",
    apply: true,
    localProjectBindings: [{ repositoryId: "appMarket", projectId: "local-market" }],
  }), null, "人工选择本机工程后不能把旧远程 suggestedSnapshot 当成降级配置");
  assert.equal(confirmedConfigInferenceSnapshot(session, {
    decision: "correct",
    apply: true,
    localProjectBindings: [{ repositoryId: "appMarket", useRemote: true }],
  }), snapshot, "用户明确选择远程时原始远程快照仍可作为网络失败降级");
  assert.equal(confirmedConfigInferenceSnapshot({}, { decision: "correct", apply: true }), null);
});

test("复核成功只采用服务端快照，业务失败优先采用服务端确认的本机快照", () => {
  const staleRemote = { mode: "remote", projectDefId: "appMarket" };
  const confirmedLocal = { mode: "local", primaryProjectId: "local-market" };
  const payload = { decision: "correct", apply: true };

  assert.equal(
    configInferenceSnapshotForReviewResult({ ok: true, snapshot: null }, payload, staleRemote),
    null,
    "服务端因代号字段返回 null 时不能回退旧远程快照",
  );
  assert.equal(
    configInferenceSnapshotForReviewResult({ ok: true, snapshot: confirmedLocal }, payload, staleRemote),
    confirmedLocal,
  );
  assert.equal(
    configInferenceSnapshotForReviewResult({ ok: false, confirmedSnapshot: confirmedLocal }, payload, staleRemote),
    confirmedLocal,
  );
  assert.equal(
    configInferenceSnapshotForReviewResult({ ok: false }, payload, staleRemote),
    staleRemote,
  );
  assert.equal(
    configInferenceSnapshotForReviewResult({ ok: false, confirmedSnapshot: confirmedLocal }, { ...payload, apply: false }, staleRemote),
    null,
  );
});

test("故事点 AI 推理开关缺省关闭且仅显式 true 时开启", () => {
  assert.equal(isStoryPointAiInferenceEnabled(), false);
  assert.equal(isStoryPointAiInferenceEnabled({}), false);
  assert.equal(isStoryPointAiInferenceEnabled({ storyPointAiInferenceEnabled: true }), true);
  assert.equal(isStoryPointAiInferenceEnabled({ storyPointAiInferenceEnabled: false }), false);
});

test("复核项目优先取推理 session 并按 ticket、pending、当前项目逐级回退", () => {
  assert.equal(resolveInferenceProjectId({ projectId: " session-project " }, "pending-project", "current-project"), "session-project");
  assert.equal(resolveInferenceProjectId({ ticket: { projectId: "ticket-project" } }, "pending-project", "current-project"), "ticket-project");
  assert.equal(resolveInferenceProjectId({}, "pending-project", "current-project"), "pending-project");
  assert.equal(resolveInferenceProjectId({}, "", "current-project"), "current-project");
});

test("新建入口先进入初始化面板，只有既有故事点继续使用前置推理入口", () => {
  const task = { id: "task-1" };
  const items = [{ id: "task-open", tabId: "story-open" }, { id: "task-closed", tabId: "story-closed" }];
  assert.equal(shouldDeferStoryEntry({ enabled: true, kind: "task", task }), false,
    "新建任务必须先展示初始化面板，让 AI 在面板内并发推理");
  assert.equal(shouldDeferStoryEntry({ enabled: true, kind: "task", task: { id: "task-open", tabId: "story-open" } }), true, "已打开故事点在开关开启时也必须先推理");
  assert.equal(shouldDeferStoryEntry({ enabled: true, kind: "task", task: { id: "task-closed", tabId: "story-closed" } }), true, "重新打开故事点在开关开启时也必须先推理");
  assert.equal(shouldDeferStoryEntry({ enabled: true, kind: "task_group", items }), true);
  assert.equal(shouldDeferStoryEntry({ enabled: true, kind: "task_group", items: [...items, task] }), false,
    "包含新任务的整组入口必须逐项先展示初始化面板");
  assert.equal(shouldDeferStoryEntry({ enabled: false, kind: "task", task }), false);
  assert.equal(shouldDeferStoryEntry({ enabled: false, kind: "task_group", items }), false);
  assert.equal(shouldDeferStoryEntry({ enabled: true, kind: "task_group", items: [items[0]] }), false);
  assert.equal(isDeferredTaskStoryEntry({ deferredEntry: { kind: "task", task } }), true);
  assert.equal(isDeferredTaskStoryEntry({ deferredEntry: { kind: "task_group", items } }), false);
  assert.equal(isDeferredTaskGroupStoryEntry({ deferredEntry: { kind: "task_group", items } }), true);
  assert.equal(isDeferredTaskGroupStoryEntry({ deferredEntry: { kind: "task", task } }), false);
  assert.equal(isDeferredTaskStoryEntry(null), false);
});

test("Git commit 创建入口只在 AI 推理 run 存在时视为可续跑", () => {
  assert.equal(isDeferredGitCommitStoryEntry({
    session: { id: "CI_git" },
    deferredEntry: {
      kind: "git_commit",
      body: { revision: "abcdef1", repositoryId: "appMarket" },
    },
  }), true);
  assert.equal(isDeferredGitCommitStoryEntry({
    session: {},
    deferredEntry: { kind: "git_commit", body: { revision: "abcdef1" } },
  }), false);
  assert.equal(isDeferredGitCommitStoryEntry({
    session: { id: "CI_git" },
    deferredEntry: { kind: "task", body: { revision: "abcdef1" } },
  }), false);
});

test("没有 TB 项目时按故事入口建立隔离推理域", () => {
  assert.equal(resolveStoryInferenceProjectId({ projectId: "tb-a", deferredKind: "blank_story" }), "tb-a");
  assert.equal(resolveStoryInferenceProjectId({ tabId: "story-1" }), "story:story-1");
  assert.equal(resolveStoryInferenceProjectId({ deferredKind: "story_reopen" }), "story-entry:story_reopen");
  assert.equal(resolveStoryInferenceProjectId(), "story-entry:manual");
});

test("空白、复制和 TB 新建的 AI 复核可异步衔接统一初始化面板", () => {
  const pending = {
    deferredEntry: {
      kind: "story_initialization",
      body: { title: "新故事点" },
    },
  };
  assert.equal(isDeferredStoryInitializationEntry(pending), true);
  assert.equal(isDeferredStoryInitializationEntry({ deferredEntry: { kind: "story_initialization" } }), false);
  assert.equal(shouldDismissConfigInferenceBeforeReview(pending), true);
  assert.equal(configInferenceReviewFailurePolicy(pending), "continue_without_reopen");
  assert.equal(requiresSavedStoryCreationReview(pending), false);
  const panelPending = {
    session: { id: "CI_panel" },
    deferredEntry: { kind: "story_initialization_panel", flowId: "flow-1" },
  };
  const skipPayload = {
    decision: "insufficient",
    correctedPrediction: { targets: [] },
    apply: false,
  };
  assert.equal(isDeferredStoryInitializationPanelEntry(panelPending), true);
  assert.equal(isDeferredStoryInitializationPanelEntry({ deferredEntry: { kind: "story_initialization_panel" } }), false);
  assert.equal(requiresSavedStoryCreationReview(panelPending), false,
    "story initialization uses the current human-confirmed draft and must not require an AI proof");
  assert.equal(shouldDismissConfigInferenceBeforeReview(panelPending), true,
    "story initialization review persistence must be dismissible and asynchronous");
  assert.equal(shouldDismissStoryInitializationSkipBeforeReview(panelPending, skipPayload), true);
  assert.equal(shouldDismissStoryInitializationSkipBeforeReview(panelPending, { ...skipPayload, apply: true }), false);
  assert.equal(shouldDismissStoryInitializationSkipBeforeReview({ ...panelPending, continueAction: "group_auto" }, skipPayload), false,
    "group-auto review remains a blocking backend gate");
});

test("初始化面板采用或暂不采用都会立即退出推理页并异步保存，任何结果都不锁住创建", () => {
  const source = readSource("./index.jsx");
  const modal = readSource("./ConfigSuggestModal.jsx");
  const submitStart = source.indexOf("async function submitConfigInferenceReview");
  const submitEnd = source.indexOf("// 半自动", submitStart);
  const submitSource = source.slice(submitStart, submitEnd);
  const immediateBranch = submitSource.indexOf("if (isDeferredStoryInitializationPanelEntry(pending))");
  const immediateDismiss = submitSource.indexOf("setConfigSuggest(null);", immediateBranch);
  const backgroundReview = submitSource.indexOf("Promise.resolve().then(() => devbenchApi.reviewConfigInference", immediateDismiss);

  assert.ok(immediateBranch >= 0 && immediateDismiss > immediateBranch && backgroundReview > immediateDismiss,
    "AI review presentation and draft application must finish before feedback is persisted in background");
  assert.match(submitSource, /resumeStoryInitializationAfterInference\([\s\S]*?confirmedSnapshot[\s\S]*?continuationContext/);
  assert.match(submitSource, /AI 建议反馈保存失败；当前草稿与创建流程不受影响/);
  assert.match(source, /controlsLocked=\{false\}/,
    "AI 推理、复核和来源配置加载不得锁住初始化表单");
  assert.match(source, /canConfirm=\{!storyInitialization\.partialRecovery && storyInitialization\.sourceConfigReady !== false/);
  assert.doesNotMatch(source, /canConfirm=\{[^}]*inferencePhase/,
    "AI phase must not participate in the creation-confirmable expression");
  assert.match(source, /onContinueMainFlow=\{isDeferredStoryInitializationPanelEntry\(configSuggest\)/);
  const confirmStart = source.indexOf("async function confirmStoryInitialization");
  const confirmEnd = source.indexOf("function askTitle", confirmStart);
  const confirmSource = source.slice(confirmStart, confirmEnd);
  assert.match(confirmSource, /setConfigSuggest\(\(current\) => \{[\s\S]*?isDeferredStoryInitializationPanelEntry\(current\)[\s\S]*?suppress\(current\.session\?\.id\)[\s\S]*?return null;/,
    "clicking the underlying final confirm while AI review is open must dismiss the orphanable review panel");
  assert.match(modal, /config-inference-continue-main-flow/,
    "opened AI review must expose a direct path back to the current-draft creation flow");
  assert.match(modal, /pointer-events-none[\s\S]*?pointer-events-auto/,
    "stacked inference review must not install a full-screen interaction shield");
  assert.doesNotMatch(modal, /disabled=\{busy\}[\s\S]*?config-inference-return-to-initialization/,
    "returning to initialization must remain available while feedback is saving");
});

test("历史故事点重新打开可作为推理后的延迟入口", () => {
  const pending = { deferredEntry: { kind: "story_reopen", storyId: "closed-1" } };
  assert.equal(isDeferredStoryReopenEntry(pending), true);
  assert.equal(isDeferredStoryReopenEntry({ deferredEntry: { kind: "story_reopen" } }), false);
  assert.equal(shouldDismissConfigInferenceBeforeReview(pending), true);
});

test("组队开发的新建或恢复入口也可在推理后续跑", () => {
  const pending = {
    deferredEntry: {
      kind: "team_dev",
      task: { id: "task-1" },
      source: { id: "anchor-1" },
    },
  };
  assert.equal(isDeferredTeamDevStoryEntry(pending), true);
  assert.equal(isDeferredTeamDevStoryEntry({ deferredEntry: { kind: "team_dev" } }), false);
  assert.equal(shouldDismissConfigInferenceBeforeReview(pending), false);
});

test("确认与暂不采用共用的 deferred 分发覆盖重开和组队且排除 Git 特例", () => {
  const task = { id: "task-1" };
  const continuations = [
    { deferredEntry: { kind: "task", task } },
    { deferredEntry: { kind: "task_group", items: [task, { id: "task-2" }] } },
    { deferredEntry: { kind: "story_initialization", body: { title: "新故事点" } } },
    { deferredEntry: { kind: "story_reopen", storyId: "closed-1" } },
    { deferredEntry: { kind: "team_dev", task, source: { id: "anchor-1" } } },
  ];
  for (const pending of continuations) {
    assert.equal(shouldContinueDeferredStoryEntry(pending), true, pending.deferredEntry.kind);
  }
  const gitPending = {
    session: { id: "CI_git" },
    deferredEntry: { kind: "git_commit", body: { revision: "abcdef1" } },
  };
  assert.equal(shouldContinueDeferredStoryEntry(gitPending), false, "Git 由独立 dispatcher 恢复初始化面板");
  assert.equal(requiresSavedStoryCreationReview(gitPending), true, "Git 暂不采用也必须先保存人工决定");
  assert.equal(shouldContinueDeferredStoryEntry(null), false);

  const source = readSource("./index.jsx");
  const dispatchUses = source.match(/shouldContinueDeferredStoryEntry\(pending\)/g) || [];
  assert.equal(dispatchUses.length >= 2, true, "确认和暂不采用分支都必须调用统一 deferred 分发门禁");
});

test("推理 run 冻结任务、整组、历史和组队可能恢复的关闭故事点 ID", () => {
  assert.deepEqual(configInferenceStoryEntryScope(
    { kind: "story_reopen", storyId: "closed-history" },
  ), { kind: "story_reopen", storyIds: ["closed-history"] });
  assert.deepEqual(configInferenceStoryEntryScope(
    { kind: "task", task: { tabId: "closed-task" } },
  ), { kind: "task", storyIds: ["closed-task"] });
  assert.deepEqual(configInferenceStoryEntryScope(
    { kind: "task_group", items: [{ tabId: "closed-a" }, { tabId: "open-b" }, { tabId: "closed-a" }] },
    { openStoryIds: ["open-b"] },
  ), { kind: "task_group", storyIds: ["closed-a"] });
  assert.deepEqual(configInferenceStoryEntryScope(
    { kind: "team_dev", task: { tabId: "closed-task" }, source: { id: "closed-anchor", closed: true } },
  ), { kind: "team_dev", storyIds: ["closed-task", "closed-anchor"] });
  assert.equal(configInferenceStoryEntryScope(
    { kind: "team_dev", task: { tabId: "open-task" }, source: { id: "open-anchor", closed: false } },
    { openStoryIds: ["open-task", "open-anchor"] },
  ), null);
  assert.deepEqual(configInferenceStoryEntryScope(
    { kind: "story_initialization", body: { title: "new" } },
  ), {
    kind: "story_initialization",
    createEntries: [{ kind: "blank_story", title: "new" }],
  });
  assert.deepEqual(configInferenceStoryEntryScope({
    kind: "story_initialization_panel",
    flowId: "flow-blank",
    body: { title: "panel new" },
    task: null,
    entry: { kind: "blank_story" },
  }), {
    kind: "story_initialization_panel",
    createEntries: [{ kind: "blank_story", title: "panel new" }],
  });
  assert.deepEqual(configInferenceStoryEntryScope(
    { kind: "task", task: { title: "原任务", storyTitle: "#CARB-1# 原任务(2)" } },
  ), {
    kind: "task",
    createEntries: [{ kind: "task_story", title: "#CARB-1# 原任务(2)" }],
  });
  assert.deepEqual(configInferenceStoryEntryScope(
    {
      kind: "task_group",
      items: [
        { title: "重复任务", storyTitle: "重复任务" },
        { title: "重复任务", storyTitle: "重复任务(2)" },
      ],
    },
  ), {
    kind: "task_group",
    createEntries: [
      { kind: "task_story", title: "重复任务" },
      { kind: "task_story", title: "重复任务(2)" },
    ],
  });
  assert.deepEqual(configInferenceStoryEntryScope({
    kind: "story_initialization_panel",
    flowId: "flow-copy",
    body: { title: "副本", copyFromId: "closed-1", copyFromKind: "closed" },
  }), {
    kind: "story_initialization_panel",
    createEntries: [{
      kind: "story_copy",
      title: "副本",
      copyFromId: "closed-1",
      copyFromKind: "closed",
    }],
  });
  assert.deepEqual(configInferenceStoryEntryScope({
    kind: "story_initialization_panel",
    flowId: "flow-git",
    body: { title: "Review abcdef" },
    entry: { kind: "git_commit", repositoryId: "market", revision: "ABCDEF123456" },
  }), {
    kind: "story_initialization_panel",
    createEntries: [{
      kind: "git_commit",
      repositoryId: "market",
      revision: "ABCDEF123456",
      title: "Review abcdef",
    }],
  });

  const closedStories = [
    { id: "closed-ticket", ticketUrl: "https://tb/task/1", title: "工单故事点" },
    { id: "closed-carb", title: "#CARB-123# 历史故事点" },
    { id: "closed-title", title: "精确标题" },
  ];
  assert.equal(resolveClosedStoryIdForTask({ ticketUrl: "https://tb/task/1" }, closedStories), "closed-ticket");
  assert.equal(resolveClosedStoryIdForTask({ carbId: "carb-123" }, closedStories), "closed-carb");
  assert.equal(resolveClosedStoryIdForTask({ title: "精确标题" }, closedStories), "closed-title");
  assert.equal(resolveClosedStoryIdForTask({ title: "不存在" }, closedStories), "");
  assert.equal(resolveClosedStoryIdForTask({ title: "重复" }, [
    { id: "closed-1", title: "重复" },
    { id: "closed-2", title: "重复" },
  ]), "", "多条历史故事点命中时不得猜测授权目标");
  assert.deepEqual(configInferenceStoryEntryScope(
    { kind: "task_group", items: [{ ticketUrl: "https://tb/task/1" }, { carbId: "CARB-123" }] },
    { closedStories },
  ), { kind: "task_group", storyIds: ["closed-ticket", "closed-carb"] });
});

test("带服务端重开范围的推理必须先保存复核并生成绑定 run 的凭证", () => {
  const pending = {
    projectId: "pending-project",
    session: {
      id: "CI_reopen",
      projectId: "run-project",
      reopenScope: {
        consumer: "reopen_closed",
        storyIds: [{ id: "closed-1", closedAt: 123 }],
      },
    },
    deferredEntry: { kind: "story_reopen", storyId: "closed-1" },
  };
  assert.equal(requiresSavedStoryReopenReview(pending), true);
  assert.deepEqual(configInferenceReopenReviewProof(pending, "ignored-project"), {
    projectId: "run-project",
    configInferenceRunId: "CI_reopen",
  });
  assert.equal(shouldDismissConfigInferenceBeforeReview(pending), false);
  assert.equal(configInferenceReviewFailurePolicy(pending), "keep_current_modal");
  assert.equal(requiresSavedStoryReopenReview({ session: { id: "CI_create" } }), false);
  assert.equal(configInferenceReopenReviewProof({ session: { id: "CI_create" } }, "project"), null);

  const source = readSource("./index.jsx");
  assert.match(source, /\["task", "task_group", "team_dev"\]\.includes\(deferredEntry\?\.kind\)/,
    "可能按历史记录兜底重开的入口必须在推理前刷新关闭故事点范围");
  assert.match(source, /devbenchApi\.reopenClosed\(id, false, reopenReview\)/,
    "历史重开必须把复核凭证传给 API");
  assert.match(source, /devbenchApi\.reopenClosed\(task\.tabId, false, reopenReview\)/,
    "任务重开必须把复核凭证传给 API");
  assert.match(source, /devbenchApi\.reopenClosed\(source\.id, true, reopenReview\)/,
    "组队锚点重开必须把复核凭证传给 API");
});

test("创建型入口等待服务端复核证明，非创建操作仍可按既有策略收起弹窗", () => {
  const task = { id: "task-1" };
  const items = [task, { id: "task-2" }];
  assert.equal(shouldDismissConfigInferenceBeforeReview({ deferredEntry: { kind: "task", task } }), false);
  assert.equal(shouldDismissConfigInferenceBeforeReview({ deferredEntry: { kind: "task_group", items } }), false);
  assert.equal(shouldDismissConfigInferenceBeforeReview({
    tabId: "reopened-story",
    dismissOnConfirm: true,
  }), true);
  assert.equal(shouldDismissConfigInferenceBeforeReview({
    continueAction: "group_auto",
    dismissOnConfirm: true,
    deferredEntry: { kind: "task", task },
  }), false);
  assert.equal(shouldDismissConfigInferenceBeforeReview({ tabId: "existing-story" }), false);
  assert.equal(shouldDismissConfigInferenceBeforeReview(null), false);
  assert.equal(configInferenceReviewFailurePolicy({ deferredEntry: { kind: "task", task } }), "keep_current_modal");
  assert.equal(configInferenceReviewFailurePolicy({ deferredEntry: { kind: "task_group", items } }), "keep_current_modal");
  assert.equal(configInferenceReviewFailurePolicy({
    tabId: "reopened-story",
    dismissOnConfirm: true,
  }), "continue_without_reopen");
  assert.equal(configInferenceReviewFailurePolicy({ continueAction: "group_auto" }), "keep_current_modal");
  assert.equal(configInferenceReviewFailurePolicy({ tabId: "existing-story" }), "keep_current_modal");
});

test("已提交的推理 run 在故事点创建和 tab 刷新期间不会被自动恢复成二次弹窗", () => {
  const guard = createConfigInferencePresentationGuard(2);
  assert.equal(guard.shouldPresent({ runId: "run-1" }), true);
  assert.equal(guard.shouldPresent({ runId: "run-1", storyEntryInFlight: true }), false);
  guard.suppress("run-1");
  assert.equal(guard.isSuppressed("run-1"), true);
  assert.equal(guard.shouldPresent({ runId: "run-1" }), false);
  assert.equal(guard.shouldPresent({ runId: "run-2", currentSuggest: { session: { id: "run-open" } } }), false);
  assert.equal(guard.shouldPresent({ runId: "run-2" }), true);
});

test("任务列表确认后即使复核保存失败也永久抑制同一 run 的二次弹窗", () => {
  const guard = createConfigInferencePresentationGuard();
  guard.suppress("run-failed");
  assert.equal(guard.shouldPresent({ runId: "run-failed" }), false);
  assert.equal(guard.isSuppressed("run-failed"), true);
  assert.equal(guard.shouldPresent({ runId: "run-failed" }), false);
});

test("同一渲染帧的重复确认只能有一个配置复核提交事务", () => {
  const guard = createConfigInferenceSubmissionGuard();
  const token = guard.acquire("run-once");
  assert.match(token, /^run-once:\d+$/);
  assert.equal(guard.acquire("run-once"), "");
  assert.equal(guard.acquire("run-other"), "");
  assert.deepEqual(guard.current(), { token, runId: "run-once" });
  assert.equal(guard.release("wrong-token"), false);
  assert.equal(guard.release(token), true);
  assert.match(guard.acquire("run-once"), /^run-once:\d+$/);
});

test("故事点入口互斥只允许一个在途请求且旧 token 不能误释放新请求", () => {
  const guard = createStoryEntryInFlightGuard();
  assert.equal(guard.acquire("task:1"), true);
  assert.equal(guard.acquire("task:1"), false);
  assert.equal(guard.acquire("task_group:2"), false);
  assert.equal(guard.release("task_group:2"), false);
  assert.equal(guard.current(), "task:1");
  assert.equal(guard.release("task:1"), true);
  assert.equal(guard.acquire("task_group:2"), true);
  assert.equal(guard.current(), "task_group:2");
});

test("Git 复核保存后先关闭旧弹窗，取消初始化也不能复用已释放 token", () => {
  const source = readSource("./index.jsx");
  assert.match(source, /entryToken && storyEntryGuardRef\.current\.current\(\) !== entryToken/,
    "借入的 Git entry token 必须仍是当前锁，旧 token 不得绕过互斥");
  const reviewStart = source.indexOf("if (isDeferredGitCommitStoryEntry(pending))", source.indexOf("async function submitConfigInferenceReview"));
  const panelStart = source.indexOf("if (isDeferredStoryInitializationPanelEntry(pending))", reviewStart);
  const gitReviewSource = source.slice(reviewStart, panelStart);
  assert.match(gitReviewSource, /suppress\(pending\.session\?\.id\);\s*setConfigSuggest\(null\);\s*const continued = await continueDeferredStoryEntry/,
    "已保存的 Git review 必须在等待初始化面板前进入终态，取消后不能重新露出");
  assert.match(source, /if \(result\?\.cancelled\) return result;/,
    "用户取消 Git 初始化应作为正常终止，不得伪报创建失败");
});

test("资源占用冲突时不自动应用已复核快照，用户选择优先", () => {
  assert.equal(shouldSkipReviewedSnapshotForConflict(null), false);
  assert.equal(shouldSkipReviewedSnapshotForConflict({ primaryProjectId: "project-1" }), true);
});

test("任务创建、TB 改绑和组锚收尾保持初始化面板最终决定", () => {
  const source = readSource("./index.jsx");
  assert.match(source, /function planTaskStory[\s\S]*?storyTitle: title/,
    "任务入口应在推理前冻结最终故事点标题");
  assert.match(source, /entry: taskStoryCreateEntry\(scopedTask\) \|\| \{ kind: "task_story", title \}/,
    "最终初始化 intent 应携带同一任务故事标题");
  assert.match(source, /resolveTaskStoryInferenceTask\(pending\.task, \{[\s\S]*?resolveTbTask: devbenchApi\.resolveTbTask,[\s\S]*?task = taskResolution\.task;/,
    "改绑 TB 后重新推理必须使用当前工单并清空旧来源快照");
  assert.match(source, /if \(ensured\.disposition !== "created"\) \{[\s\S]*?applyReviewedInferenceSnapshot\(anchorTabId, reviewedSnapshot\)[\s\S]*?getConfigSnapshot\(anchorTabId\)/,
    "新建组锚不得二次覆盖；复用组锚则必须先应用复核配置再冻结实际共享快照");

  assert.match(source, /task: pending\.task \? task : null/,
    "Synthetic inference tasks must not turn blank, copied, or Git stories into task_story entries");

  const resumeStart = source.indexOf("function resumeStoryInitializationAfterInference");
  const resumeEnd = source.indexOf("async function continueDeferredStoryEntry", resumeStart);
  const resumeSource = source.slice(resumeStart, resumeEnd);
  assert.doesNotMatch(resumeSource, /initialOverrides/,
    "Git 旧预览 overrides 不能覆盖人工复核后的 snapshot");
  assert.match(resumeSource, /task: reviewedTask,[\s\S]*?entry: reviewedEntry,/,
    "Reviewed TB identity must be written back to the initialization transaction");

  const confirmStart = source.indexOf("async function confirmStoryInitialization");
  const confirmEnd = source.indexOf("function askTitle", confirmStart);
  const confirmSource = source.slice(confirmStart, confirmEnd);
  assert.match(confirmSource, /resolveTaskStoryInferenceTask\(pending\.task, \{[\s\S]*?entry: confirmedEntry,/,
    "The AI-disabled path must resolve a changed TB binding before creation");
  assert.match(resumeSource, /inferencePhase: accepted \? "reviewed" : "skipped"/,
    "人工选择采用但 snapshot 暂不可物化时仍应标记为已复核，而非暂不采用");
});
