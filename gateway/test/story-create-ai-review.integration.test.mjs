import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "story-create-ai-review-integration-"));
process.env.NODE_ENV = "production";
process.env.GATEWAY_DB_PATH = path.join(tmp, "gateway.db");
process.env.GATEWAY_CONFIG_PATH = path.join(tmp, "gateway.json");
process.env.DEVBENCH_CONFIG_PATH = path.join(tmp, "market.json");
process.env.DEVBENCH_LOCAL_PROJECTS_PATH = path.join(tmp, "local", "devbench-projects.json");
process.env.DEVBENCH_STORE_DIR = path.join(tmp, "store");
process.env.AIEFFICIENCY_CLONE_PARENT = path.join(tmp, "clone-parent");
process.env.ROLE = "standalone";

const projectId = "project-story-create-gate";
const legacyReviewedRunId = "legacy-reviewed-without-revision-snapshot";
const legacyReviewedAt = Date.now();
const gitSource = path.join(tmp, "git-source");
const gitWebAppSource = path.join(tmp, "git-webapp-source");
const gitCloneParent = path.join(tmp, "git-runtime");
const gitRemoteUrl = "https://codeup.aliyun.com/example/story-create-review";
fs.mkdirSync(gitSource, { recursive: true });
fs.mkdirSync(gitCloneParent, { recursive: true });
const git = (...args) => execFileSync("git", ["-C", gitSource, ...args], {
  encoding: "utf8",
  windowsHide: true,
}).trim();
git("init");
git("config", "user.name", "Story Create Review Test");
git("config", "user.email", "story-create-review@example.test");
fs.writeFileSync(path.join(gitSource, "tracked.txt"), "base\n", "utf8");
git("add", "tracked.txt");
git("commit", "-m", "base");
git("remote", "add", "origin", gitRemoteUrl);
const gitRevision = git("rev-parse", "HEAD");
fs.writeFileSync(path.join(gitSource, "intent-freeze.txt"), "intent freeze\n", "utf8");
git("add", "intent-freeze.txt");
git("commit", "-m", "intent freeze fixture");
const gitIntentFreezeRevision = git("rev-parse", "HEAD");
execFileSync("git", ["clone", "--no-hardlinks", gitSource, gitWebAppSource], {
  encoding: "utf8",
  windowsHide: true,
});
execFileSync("git", ["-C", gitWebAppSource, "remote", "set-url", "origin", gitRemoteUrl], {
  encoding: "utf8",
  windowsHide: true,
});
fs.writeFileSync(process.env.GATEWAY_CONFIG_PATH, JSON.stringify({
  role: "standalone",
  storyPointAiInferenceEnabled: true,
  storyPointAiInferenceReviewTtlMs: 600000,
  servers: { nodeId: "story-create-gate-node", discovery: false, peers: [] },
  teambition: { projects: [{ id: projectId, name: "create gate" }] },
}), "utf8");
fs.writeFileSync(process.env.DEVBENCH_CONFIG_PATH, JSON.stringify({
  projects: [],
  projectDefs: [{ id: "repo-a", name: "Repo A", https: gitRemoteUrl, ssh: "" }],
  byProject: {
    [projectId]: {
      aiTraining: {
        configInference: {
          runs: {
            [legacyReviewedRunId]: {
              id: legacyReviewedRunId,
              projectId,
              trigger: "story_initialization",
              ticket: { projectId, title: "旧版已复核但没有 revision snapshot" },
              prediction: { status: "NO_SIGNAL", targets: [] },
              review: {
                decision: "insufficient",
                rating: 1,
                reviewer: "owner-a",
                reason: "旧版复核记录",
                reviewedAt: legacyReviewedAt,
              },
              version: "legacy-reviewed-version",
              createdAt: legacyReviewedAt,
              updatedAt: legacyReviewedAt,
            },
          },
          samples: {},
        },
      },
    },
  },
}), "utf8");
fs.mkdirSync(path.dirname(process.env.DEVBENCH_LOCAL_PROJECTS_PATH), { recursive: true });
fs.writeFileSync(process.env.DEVBENCH_LOCAL_PROJECTS_PATH, JSON.stringify({
  version: 2,
  cloneParent: gitCloneParent,
  projects: [{ id: "shared-base", name: "Shared Base", path: gitSource, webAppPath: gitWebAppSource }],
}), "utf8");

const express = (await import("express")).default;
const router = (await import("../routes/devbench.js")).default;
const { updateConfig } = await import("../services/config.js");
const { issueToken, revokeToken } = await import("../services/admin-auth.js");
const devbenchStore = await import("../services/devbench/store.js");
const { __setSpawn: setAdbSpawn } = await import("../services/cardev/adb.js");

const app = express();
app.use(express.json());
app.use("/api/devbench", router);
const server = await new Promise((resolve) => {
  const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
});
const base = `http://127.0.0.1:${server.address().port}/api/devbench`;
const ownerAToken = issueToken({ role: "viewer", name: "owner A", dingUserid: "owner-a" });
const ownerBToken = issueToken({ role: "viewer", name: "owner B", dingUserid: "owner-b" });

async function request(pathname, body, token = null, method = "POST") {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body || {}),
  });
  return { status: response.status, body: await response.json() };
}

function adbDevicesSpawn(devices) {
  const rows = (Array.isArray(devices) ? devices : [])
    .map((device) => `${device.id}\t${device.status}`)
    .join("\n");
  return (command, args) => {
    assert.equal(command, "adb");
    assert.deepEqual(args, ["devices"]);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from(`List of devices attached\n${rows}${rows ? "\n" : ""}`, "utf8"));
      child.emit("close", 0);
    });
    return child;
  };
}

async function createRun(title, token = ownerAToken, storyEntry = null, ticketOverrides = {}) {
  const entry = storyEntry || {
    kind: "story_initialization",
    createEntries: [{ kind: "blank_story", title }],
  };
  const run = await request("/ai-training/config-inference/run", {
    projectId,
    trigger: "story_initialization",
    storyEntry: entry,
    ticket: { projectId, title, ...ticketOverrides },
    captureSignals: false,
  }, token);
  assert.equal(run.status, 200, run.body.error);
  return run.body.data.id;
}

async function reviewRun(runId, decision = "insufficient", token = ownerAToken) {
  const reviewed = await request(
    `/ai-training/config-inference/runs/${encodeURIComponent(runId)}/review`,
    { projectId, decision, rating: 1, apply: false, reason: "人工定夺后使用面板配置继续" },
    token,
  );
  assert.equal(reviewed.status, 200, reviewed.body.error);
  const persisted = devbenchStore.getConfigInferenceData(projectId).runs.find((row) => row.id === runId);
  assert.equal(persisted?.stalePrediction, false, JSON.stringify(persisted?.staleReasons || []));
  return reviewed;
}

async function waitForWorkspaceInitialization(tabId, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const tab = devbenchStore.getTab(tabId);
    const status = tab?.workspaceInitialization?.status;
    if (status === "ready") return tab;
    if (status === "error") {
      assert.fail(tab.workspaceInitialization.error || tab.worktreeError || "后台工作区初始化失败");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`等待故事点 ${tabId} 后台工作区初始化超时`);
}

function initializationBody(title, runId, ticketInput = "") {
  return {
    title,
    sourceLabel: "AI 创建门禁集成测试",
    entry: { kind: "blank_story", title },
    configuration: { mode: "blank" },
    ...(ticketInput ? { ticketInput } : {}),
    ...(runId ? { configInference: { projectId, runId } } : {}),
  };
}

test.after(async () => {
  setAdbSpawn();
  revokeToken(ownerAToken);
  revokeToken(ownerBToken);
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  try {
    const { default: db } = await import("../db/sqlite.js");
    if (db?.open) db.close();
  } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

test("已复核 proof 冻结复核后的 revision，外部 registry 变化后 stale 且拒绝创建", async () => {
  const legacyOverview = devbenchStore.getConfigInferenceData(projectId);
  const legacyRun = legacyOverview.runs.find((row) => row.id === legacyReviewedRunId);
  assert.equal(legacyRun?.stalePrediction, true, "旧 reviewed run 缺少复核快照必须 fail-closed");
  assert.ok(legacyRun?.staleReasons?.includes("revision_metadata_missing"));
  assert.equal(legacyOverview.metrics.stalePendingRuns, 0, "reviewed run 不能计入待复核 stale 指标");

  const title = "复核 revision 快照防漂移";
  const runId = await createRun(title);
  await reviewRun(runId, "insufficient");

  const reviewedOverview = devbenchStore.getConfigInferenceData(projectId);
  const reviewedRun = reviewedOverview.runs.find((row) => row.id === runId);
  assert.ok(reviewedRun?.review?.inferenceRevisions, "复核后必须冻结独立 revision snapshot");
  assert.equal(reviewedRun?.stalePrediction, false, "本次复核自身写入不能立即污染 proof");
  assert.deepEqual(reviewedRun?.staleReasons, []);
  assert.equal(reviewedOverview.metrics.stalePendingRuns, 0);

  const registryProjectId = "review-stale-registry-project";
  const changed = devbenchStore.upsertProjectDef({
    id: registryProjectId,
    name: "Review stale registry project",
    https: "https://example.test/review-stale-registry.git",
    projectType: "tool",
    inferenceEnabled: true,
    defaultBranch: "main",
  });
  assert.equal(changed.ok, true, changed.error);
  try {
    const staleOverview = devbenchStore.getConfigInferenceData(projectId);
    const staleRun = staleOverview.runs.find((row) => row.id === runId);
    assert.equal(staleRun?.stalePrediction, true);
    assert.ok(staleRun?.staleReasons?.includes("registry"));
    assert.equal(staleOverview.metrics.stalePendingRuns, 0, "已复核 stale 只影响 proof，不属于 pending review");

    const blocked = await request(
      "/story-initializations",
      initializationBody(title, runId),
      ownerAToken,
    );
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.code, "STORY_CREATE_AI_REVIEW_STALE");
  } finally {
    devbenchStore.deleteProjectDef(registryProjectId);
  }
});

test("AI 开启时纯人工配置可直接创建，显式提交的 AI proof 仍强制同 owner 与同范围", async () => {
  const manualTitle = "AI 异步时纯人工配置直接创建";
  const manual = await request("/story-initializations", {
    title: manualTitle,
    sourceLabel: "人工初始化",
    configuration: { mode: "blank" },
  }, ownerAToken);
  assert.equal(manual.status, 201, manual.body.error);
  const manualCreated = await request("/tabs", {
    initializationIntentId: manual.body.data.id,
  }, ownerAToken);
  assert.equal(manualCreated.status, 200, manualCreated.body.error);
  assert.equal(manualCreated.body.data.title, manualTitle);

  const title = "AI 门禁负向复核仍可创建";
  const runId = await createRun(title);

  const unreviewed = await request("/story-initializations", initializationBody(title, runId), ownerAToken);
  assert.equal(unreviewed.status, 409);
  assert.equal(unreviewed.body.code, "STORY_CREATE_AI_REVIEW_REQUIRED");

  await reviewRun(runId, "insufficient");

  const missingProof = await request("/story-initializations", initializationBody(title, ""), ownerAToken);
  assert.equal(missingProof.status, 201, missingProof.body.error);
  assert.ok(missingProof.body.data.id);

  const crossOwner = await request("/story-initializations", initializationBody(title, runId), ownerBToken);
  assert.equal(crossOwner.status, 403);
  assert.equal(crossOwner.body.code, "STORY_CREATE_AI_REVIEW_OWNER_MISMATCH");

  const crossTitle = await request("/story-initializations", initializationBody("另一个标题", runId), ownerAToken);
  assert.equal(crossTitle.status, 409);
  assert.equal(crossTitle.body.code, "STORY_CREATE_AI_REVIEW_SCOPE_MISMATCH");

  const prepared = await request("/story-initializations", initializationBody(title, runId), ownerAToken);
  assert.equal(prepared.status, 201, prepared.body.error);

  const consumeAsOtherOwner = await request("/tabs", {
    initializationIntentId: prepared.body.data.id,
  }, ownerBToken);
  assert.equal(consumeAsOtherOwner.status, 403);
  assert.equal(consumeAsOtherOwner.body.code, "STORY_INITIALIZATION_OWNER_MISMATCH");

  const created = await request("/tabs", {
    initializationIntentId: prepared.body.data.id,
  }, ownerAToken);
  assert.equal(created.status, 200, created.body.error);
  assert.equal(created.body.data.title, title);

  const replay = await request("/tabs", {
    initializationIntentId: prepared.body.data.id,
  }, ownerAToken);
  assert.equal(replay.status, 200, replay.body.error);
  assert.equal(replay.body.data.id, created.body.data.id);
});

test("未显式配置复核 TTL 时，核对 11 分钟后仍可签发初始化 intent", async () => {
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  updateConfig({ storyPointAiInferenceReviewTtlMs: 0 });
  try {
    const title = "长时间核对后确认创建";
    const runId = await createRun(title);
    now += 1_000;
    await reviewRun(runId, "insufficient");
    now += 11 * 60 * 1000;

    const prepared = await request("/story-initializations", initializationBody(title, runId), ownerAToken);
    const persisted = devbenchStore.getConfigInferenceData(projectId).runs.find((row) => row.id === runId);
    assert.equal(prepared.status, 201, JSON.stringify({ response: prepared.body, review: persisted?.review }));
    assert.ok(prepared.body.data?.id);
  } finally {
    Date.now = originalNow;
    updateConfig({ storyPointAiInferenceReviewTtlMs: 600000 });
  }
});

test("空白故事点创建证明冻结 TB 身份：跨 TB 初始化被拒，同一 URL/CARB 规范化后可完成 intent", async () => {
  const title = "CARB-12001 TB 身份冻结";
  const tbTaskId = "abcdefabcdefabcdefabcdef";
  const otherTbTaskId = "1234567890abcdef12345678";
  const runId = await createRun(title, ownerAToken, null, {
    ticketId: "CARB-12001",
    tbTaskId,
    ticketUrl: `https://www.teambition.com/task/${tbTaskId}`,
  });
  await reviewRun(runId, "insufficient");

  const crossTicket = await request(
    "/story-initializations",
    initializationBody(title, runId, `https://www.teambition.com/task/${otherTbTaskId}`),
    ownerAToken,
  );
  assert.equal(crossTicket.status, 409);
  assert.equal(crossTicket.body.code, "STORY_CREATE_AI_REVIEW_SCOPE_MISMATCH");

  const prepared = await request(
    "/story-initializations",
    initializationBody(title, runId, `https://www.teambition.com/task/${tbTaskId.toUpperCase()}?from=review`),
    ownerAToken,
  );
  assert.equal(prepared.status, 201, prepared.body.error);
  const created = await request("/tabs", { initializationIntentId: prepared.body.data.id }, ownerAToken);
  assert.equal(created.status, 200, created.body.error);
  assert.equal(created.body.data.ticketUrl, `https://www.teambition.com/task/${tbTaskId.toUpperCase()}`);
});

test("task_group 每个 entry 独立绑定服务端解析 TB：换单、清空和改标题均拒绝", async () => {
  const taskATbTaskId = "333333333333333333333333";
  const taskBTbTaskId = "444444444444444444444444";
  const titleA = "任务组故事点 A";
  const titleB = "任务组故事点 B";
  const entryA = {
    kind: "task_story",
    taskId: "group-task-a",
    tbTaskId: taskATbTaskId,
    ticketUrl: `https://www.teambition.com/task/${taskATbTaskId}`,
    ticketId: "CARB-14001",
    title: titleA,
  };
  const entryB = {
    kind: "task_story",
    taskId: "group-task-b",
    tbTaskId: taskBTbTaskId,
    ticketUrl: `https://www.teambition.com/task/${taskBTbTaskId}`,
    ticketId: "CARB-14002",
    title: titleB,
  };
  const run = await request("/ai-training/config-inference/run", {
    projectId,
    trigger: "task_group_execute",
    storyEntry: { kind: "task_group", items: [entryA, entryB] },
    ticket: {
      projectId,
      title: titleA,
      tbTaskId: taskATbTaskId,
      ticketUrl: `https://www.teambition.com/task/${taskATbTaskId}`,
    },
    captureSignals: false,
  }, ownerAToken);
  assert.equal(run.status, 200, run.body.error);
  await reviewRun(run.body.data.id, "insufficient");
  const body = (title, entry, ticketInput) => ({
    title,
    sourceLabel: "任务组创建门禁",
    entry,
    configuration: { mode: "blank" },
    ...(ticketInput ? { ticketInput } : {}),
    configInference: { projectId, runId: run.body.data.id },
  });

  const swapped = await request(
    "/story-initializations",
    body(titleA, entryA, `https://www.teambition.com/task/${taskBTbTaskId}`),
    ownerAToken,
  );
  assert.equal(swapped.status, 409);
  assert.equal(swapped.body.code, "STORY_CREATE_AI_REVIEW_SCOPE_MISMATCH");

  const removed = await request("/story-initializations", body(titleA, entryA, ""), ownerAToken);
  assert.equal(removed.status, 409);
  assert.equal(removed.body.code, "STORY_CREATE_AI_REVIEW_SCOPE_MISMATCH");

  const renamed = await request(
    "/story-initializations",
    body(`${titleA}（改）`, { ...entryA, title: `${titleA}（改）` }, entryA.ticketUrl),
    ownerAToken,
  );
  assert.equal(renamed.status, 409);
  assert.equal(renamed.body.code, "STORY_CREATE_AI_REVIEW_SCOPE_MISMATCH");

  const preparedA = await request(
    "/story-initializations",
    body(titleA, { ...entryA, tbTaskId: taskATbTaskId.toUpperCase() }, `https://www.teambition.com/task/${taskATbTaskId.toUpperCase()}`),
    ownerAToken,
  );
  assert.equal(preparedA.status, 201, preparedA.body.error);
  const createdA = await request("/tabs", { initializationIntentId: preparedA.body.data.id }, ownerAToken);
  assert.equal(createdA.status, 200, createdA.body.error);

  const preparedB = await request("/story-initializations", body(titleB, entryB, entryB.ticketUrl), ownerAToken);
  assert.equal(preparedB.status, 201, preparedB.body.error);
});

test("关闭故事点仍全域占用 TB；初始化和预先签发 intent 的最终消费都拒绝副本", async () => {
  const tbTaskId = "666666666666666666666666";
  const firstTitle = "关闭 TB 唯一性原故事点";
  const pendingTitle = "关闭 TB 唯一性副本";
  const ticket = {
    ticketId: "CARB-15001",
    tbTaskId,
    ticketUrl: `https://www.teambition.com/task/${tbTaskId}`,
  };
  const firstRunId = await createRun(firstTitle, ownerAToken, null, ticket);
  const pendingRunId = await createRun(pendingTitle, ownerAToken, null, ticket);
  await reviewRun(firstRunId, "insufficient");
  await reviewRun(pendingRunId, "insufficient");

  const pendingIntent = await request(
    "/story-initializations",
    initializationBody(pendingTitle, pendingRunId, ticket.ticketUrl),
    ownerAToken,
  );
  assert.equal(pendingIntent.status, 201, pendingIntent.body.error);
  const firstIntent = await request(
    "/story-initializations",
    initializationBody(firstTitle, firstRunId, ticket.ticketUrl),
    ownerAToken,
  );
  assert.equal(firstIntent.status, 201, firstIntent.body.error);
  const firstCreated = await request("/tabs", { initializationIntentId: firstIntent.body.data.id }, ownerAToken);
  assert.equal(firstCreated.status, 200, firstCreated.body.error);
  const closed = await request(`/tabs/${encodeURIComponent(firstCreated.body.data.id)}`, {}, ownerAToken, "DELETE");
  assert.equal(closed.status, 200, closed.body.error);

  const duplicateInitialization = await request(
    "/story-initializations",
    initializationBody(pendingTitle, pendingRunId, ticket.ticketUrl),
    ownerAToken,
  );
  assert.equal(duplicateInitialization.status, 409);
  assert.equal(duplicateInitialization.body.code, "STORY_TICKET_TAKEN");
  assert.equal(duplicateInitialization.body.existingStory?.closed, true);

  const duplicateFinal = await request("/tabs", { initializationIntentId: pendingIntent.body.data.id }, ownerAToken);
  assert.equal(duplicateFinal.status, 409);
  assert.equal(duplicateFinal.body.code, "STORY_TICKET_TAKEN");
});

test("任意旧 run 无创建范围不能伪装成 AI 审计；无 proof intent 不受 AI 开关切换影响", async () => {
  const oldRun = await request("/ai-training/config-inference/run", {
    projectId,
    trigger: "manual",
    ticket: { projectId, title: "旧手工 run" },
    captureSignals: false,
  }, ownerAToken);
  assert.equal(oldRun.status, 200, oldRun.body.error);
  await reviewRun(oldRun.body.data.id, "insufficient");
  const forged = await request(
    "/story-initializations",
    initializationBody("旧手工 run", oldRun.body.data.id),
    ownerAToken,
  );
  assert.equal(forged.status, 409);
  assert.equal(forged.body.code, "STORY_CREATE_AI_REVIEW_REQUIRED");

  updateConfig({ storyPointAiInferenceEnabled: false });
  const compatible = await request("/story-initializations", {
    title: "AI 关闭兼容创建",
    sourceLabel: "人工初始化",
    configuration: { mode: "blank" },
  }, ownerAToken);
  assert.equal(compatible.status, 201, compatible.body.error);
  updateConfig({ storyPointAiInferenceEnabled: true });
  const blockedAfterToggle = await request(
    "/tabs",
    { initializationIntentId: compatible.body.data.id },
    ownerAToken,
  );
  assert.equal(blockedAfterToggle.status, 200, blockedAfterToggle.body.error);
  assert.equal(blockedAfterToggle.body.data.title, "AI 关闭兼容创建");
});

test("正向复核快照无法物化时仍可确认独立人工配置", async () => {
  updateConfig({ storyPointAiInferenceEnabled: true });
  const title = "正向复核改用人工空白配置";
  const runId = await createRun(title);
  const reviewed = await request(
    `/ai-training/config-inference/runs/${encodeURIComponent(runId)}/review`,
    {
      projectId,
      decision: "corrected",
      rating: 3,
      apply: false,
      reason: "明确无自动工程目标，改用面板人工配置",
      correctedPrediction: { noTargets: true, targets: [] },
    },
    ownerAToken,
  );
  assert.equal(reviewed.status, 200, reviewed.body.error);
  const prepared = await request(
    "/story-initializations",
    initializationBody(title, runId),
    ownerAToken,
  );
  assert.equal(prepared.status, 201, prepared.body.error);
  assert.ok(prepared.body.data.id);
});

test("普通与 Git 初始化可共享已有绑定，但仍在创建前 fail-closed 校验 ADB 状态", async () => {
  updateConfig({ storyPointAiInferenceEnabled: false });
  const owner = devbenchStore.createTab({ title: "设备共享绑定原故事点" });
  const serial = "SHARED-SERIAL";
  const ownerBinding = devbenchStore.updateTabDeviceBinding(owner.id, { deviceSerial: serial });
  assert.equal(ownerBinding.ok, true, ownerBinding.error);
  const prepare = (title, entry) => request("/story-initializations", {
    title,
    sourceLabel: "设备共享绑定测试",
    entry,
    configuration: { mode: "blank", deviceSerial: serial },
  }, ownerAToken);
  let createdNormalId = "";
  try {
    const beforeBlocked = devbenchStore.listTabs().length;
    setAdbSpawn(adbDevicesSpawn([{ id: serial, status: "unauthorized" }]));
    const unauthorized = await prepare(
      "设备未授权普通故事点",
      { kind: "blank_story", title: "设备未授权普通故事点" },
    );
    assert.equal(unauthorized.status, 409);
    assert.equal(unauthorized.body.code, "STORY_DEVICE_NOT_READY");
    assert.equal(unauthorized.body.deviceStatus, "unauthorized");
    assert.equal(devbenchStore.listTabs().length, beforeBlocked, "创建前设备校验失败不得落下故事点记录");

    setAdbSpawn(adbDevicesSpawn([{ id: serial, status: "device" }]));
    const normalTitle = "设备共享普通故事点";
    const normal = await prepare(normalTitle, { kind: "blank_story", title: normalTitle });
    assert.equal(normal.status, 201, normal.body.error);
    const createdNormal = await request(
      "/tabs",
      { initializationIntentId: normal.body.data.id },
      ownerAToken,
    );
    assert.equal(createdNormal.status, 200, createdNormal.body.error);
    createdNormalId = createdNormal.body.data.id;
    assert.equal(createdNormal.body.data.deviceSerial, serial);

    const gitShared = await prepare("设备共享 Git 故事点", {
      kind: "git_commit",
      repositoryId: "repo-a",
      revision: gitRevision,
    });
    assert.equal(gitShared.status, 201, gitShared.body.error);

    const bindings = devbenchStore.listTabs().filter((tab) => tab.deviceSerial === serial);
    assert.ok(bindings.some((tab) => tab.id === owner.id));
    assert.ok(bindings.some((tab) => tab.id === createdNormalId));
  } finally {
    setAdbSpawn();
    if (createdNormalId) devbenchStore.discardUnpublishedTab(createdNormalId);
    devbenchStore.discardUnpublishedTab(owner.id);
    updateConfig({ storyPointAiInferenceEnabled: true });
  }
});

test("重新打开的 worktree 恢复失败返回 partial，AI 关闭时幂等重试也不假成功", async () => {
  updateConfig({ storyPointAiInferenceEnabled: false });
  const tab = devbenchStore.createTab({ title: "重开 worktree partial" });
  devbenchStore.updateTab(tab.id, { mode: "local", primaryProjectId: "missing-reopen-project" });
  const closed = await request(`/tabs/${encodeURIComponent(tab.id)}`, {}, ownerAToken, "DELETE");
  assert.equal(closed.status, 200, closed.body.error);

  const first = await request("/tabs/reopen-closed", { id: tab.id }, ownerAToken);
  assert.equal(first.body.ok, false);
  assert.equal(first.body.partial, true);
  assert.equal(first.body.retryable, true);
  assert.equal(first.body.tabId, tab.id);
  assert.ok(devbenchStore.getTab(tab.id), "reopen 已发生，必须保留可核对的 active 记录");

  const retry = await request("/tabs/reopen-closed", { id: tab.id }, ownerAToken);
  assert.equal(retry.body.ok, false);
  assert.equal(retry.body.partial, true);
  assert.equal(retry.body.idempotent, true);
  devbenchStore.discardUnpublishedTab(tab.id);
  updateConfig({ storyPointAiInferenceEnabled: true });
});

test("重复激活当前 groupActive 成员幂等返回且不触发 worktree 重建", async () => {
  const active = devbenchStore.createTab({ title: "幂等 active 来源" });
  const member = devbenchStore.createTab({ title: "幂等 active 成员" });
  devbenchStore.updateTab(active.id, {
    mode: "local",
    primaryProjectId: "missing-idempotent-project",
    engine: "codex",
  });
  const joined = devbenchStore.joinGroup(member.id, active.id);
  assert.equal(joined.ok, true);
  const before = devbenchStore.getTab(active.id);
  const response = await request(`/tabs/${encodeURIComponent(active.id)}/group/active`, {}, ownerAToken);
  assert.equal(response.status, 200, response.body.error);
  assert.equal(response.body.idempotent, true);
  const after = devbenchStore.getTab(active.id);
  assert.equal(after.primaryProjectId, before.primaryProjectId);
  assert.equal(after.worktreeStatus, before.worktreeStatus);
  devbenchStore.discardUnpublishedTab(active.id);
  devbenchStore.discardUnpublishedTab(member.id);
});

test("Git 创建证明冻结标题和显式 TB 绑定状态；未绑定不能补绑，绑定后同 TB 可过且换单拒绝", async () => {
  updateConfig({ storyPointAiInferenceEnabled: true });
  const entry = { kind: "git_commit", repositoryId: "repo-a", revision: gitRevision };
  const taskA = "888888888888888888888888";
  const taskB = "777777777777777777777777";
  const run = async (title, ticket = {}) => {
    const result = await request("/ai-training/config-inference/run", {
      projectId,
      trigger: "git_commit_story_entry",
      storyEntry: { kind: "git_commit", createEntries: [entry] },
      ticket: { projectId, ticketId: `git:${gitRevision}`, title, ...ticket },
      captureSignals: false,
    }, ownerAToken);
    assert.equal(result.status, 200, result.body.error);
    await reviewRun(result.body.data.id, "insufficient");
    return result.body.data.id;
  };
  const prepare = (title, runId, ticketInput = "") => request("/story-initializations", {
    title,
    sourceLabel: "Git TB 冻结测试",
    entry,
    configuration: { mode: "blank" },
    ...(ticketInput ? { ticketInput } : {}),
    configInference: { projectId, runId },
  }, ownerAToken);

  const unboundTitle = `Git ${gitRevision.slice(0, 8)} 未绑定 CARB-15001`;
  const unboundRun = await run(unboundTitle);
  assert.equal((await prepare(unboundTitle, unboundRun, `https://www.teambition.com/task/${taskA}`)).body.code,
    "STORY_CREATE_AI_REVIEW_SCOPE_MISMATCH");
  assert.equal((await prepare(`${unboundTitle} 改标题`, unboundRun)).body.code,
    "STORY_CREATE_AI_REVIEW_SCOPE_MISMATCH");

  const boundTitle = `Git ${gitRevision.slice(0, 8)} 显式 TB 无 CARB`;
  const boundRun = await run(boundTitle, {
    tbTaskId: taskA,
    ticketUrl: `https://www.teambition.com/task/${taskA}`,
  });
  const same = await prepare(boundTitle, boundRun, `https://www.teambition.com/task/${taskA.toUpperCase()}`);
  assert.equal(same.status, 201, same.body.error);
  const swapped = await prepare(boundTitle, boundRun, `https://www.teambition.com/task/${taskB}`);
  assert.equal(swapped.status, 409);
  assert.equal(swapped.body.code, "STORY_CREATE_AI_REVIEW_SCOPE_MISMATCH");
});

test("Git intent 冻结 primary 本地候选，拒绝同仓 WebApp 候选篡改并允许原候选重试", async () => {
  updateConfig({ storyPointAiInferenceEnabled: false });
  const title = `Git ${gitIntentFreezeRevision.slice(0, 12)} 本地候选冻结`;
  const entry = {
    kind: "git_commit",
    repositoryId: "repo-a",
    revision: gitIntentFreezeRevision,
  };
  const primaryConfiguration = {
    mode: "local",
    localProjectId: "shared-base",
    localRole: "primary",
  };
  const prepared = await request("/story-initializations", {
    title,
    sourceLabel: "Git commit 本地候选冻结测试",
    configuration: { mode: "local", primaryProjectId: "shared-base" },
    entry: {
      ...entry,
      preview: {
        commit: {
          source: {
            kind: "local",
            projectId: "shared-base",
            role: "",
            path: gitSource,
          },
        },
      },
    },
  }, ownerAToken);
  assert.equal(prepared.status, 201, prepared.body.error);

  const before = devbenchStore.listTabs().length;
  const tampered = await request("/git-commit-story", {
    repositoryId: "repo-a",
    revision: gitIntentFreezeRevision,
    projectId,
    configurationConfirmed: true,
    configuration: {
      mode: "local",
      localProjectId: "shared-base",
      localRole: "webapp",
    },
    storyInitializationIntentId: prepared.body.data.id,
  }, ownerAToken);
  assert.equal(tampered.status, 409, tampered.body.error);
  assert.equal(tampered.body.code, "GIT_COMMIT_INITIALIZATION_LOCAL_SOURCE_MISMATCH");
  assert.equal(devbenchStore.listTabs().length, before, "候选篡改不得创建故事点或 worktree");

  const created = await request("/git-commit-story", {
    repositoryId: "repo-a",
    revision: gitIntentFreezeRevision,
    projectId,
    configurationConfirmed: true,
    configuration: primaryConfiguration,
    storyInitializationIntentId: prepared.body.data.id,
  }, ownerAToken);
  assert.equal(created.status, 202, created.body.error);
  assert.equal(created.body.data.reviewContext.configurationChoice.localProjectId, "shared-base");
  assert.equal(created.body.data.reviewContext.configurationChoice.localRole, "primary");

  const tamperedReplay = await request("/git-commit-story", {
    repositoryId: "repo-a",
    revision: gitIntentFreezeRevision,
    projectId,
    configurationConfirmed: true,
    configuration: {
      mode: "local",
      localProjectId: "shared-base",
      localRole: "webapp",
    },
    storyInitializationIntentId: prepared.body.data.id,
  }, ownerAToken);
  assert.equal(tamperedReplay.status, 409, tamperedReplay.body.error);
  assert.equal(tamperedReplay.body.code, "GIT_COMMIT_INITIALIZATION_LOCAL_SOURCE_MISMATCH");

  const replay = await request("/git-commit-story", {
    repositoryId: "repo-a",
    revision: gitIntentFreezeRevision,
    projectId,
    configurationConfirmed: true,
    configuration: primaryConfiguration,
    storyInitializationIntentId: prepared.body.data.id,
  }, ownerAToken);
  assert.equal(replay.status, 202, replay.body.error);
  assert.equal(replay.body.data.id, created.body.data.id);
  const ready = await waitForWorkspaceInitialization(created.body.data.id);
  assert.equal(ready.workspaceInitialization.status, "ready");
  assert.equal(ready.reviewContext.source.projectId, "shared-base");
  assert.equal(ready.reviewContext.source.role || "primary", "primary");
});

test("Git consumer 也只消费同仓库 revision 的人工复核 intent，负向决定不套用预测", async () => {
  updateConfig({ storyPointAiInferenceEnabled: true });
  const title = `Git ${gitRevision.slice(0, 12)} 人工配置评审`;
  const run = await request("/ai-training/config-inference/run", {
    projectId,
    trigger: "git_commit_story_entry",
    storyEntry: {
      kind: "git_commit",
      createEntries: [{ kind: "git_commit", repositoryId: "repo-a", revision: gitRevision }],
    },
    ticket: {
      projectId,
      ticketId: `git:${gitRevision}`,
      title,
      description: `Revision：${gitRevision}`,
    },
    captureSignals: false,
  }, ownerAToken);
  assert.equal(run.status, 200, run.body.error);
  await reviewRun(run.body.data.id, "insufficient");

  const prepared = await request("/story-initializations", {
    title,
    sourceLabel: "Git commit 人工初始化",
    configuration: { mode: "local", primaryProjectId: "shared-base" },
    entry: {
      kind: "git_commit",
      repositoryId: "repo-a",
      revision: gitRevision,
      preview: {
        commit: {
          source: {
            kind: "local",
            projectId: "shared-base",
            role: "",
            path: gitSource,
          },
        },
      },
    },
    configInference: { projectId, runId: run.body.data.id },
  }, ownerAToken);
  assert.equal(prepared.status, 201, prepared.body.error);

  const wrongConsumer = await request("/tabs", {
    initializationIntentId: prepared.body.data.id,
  }, ownerAToken);
  assert.equal(wrongConsumer.status, 409);
  assert.equal(wrongConsumer.body.code, "STORY_INITIALIZATION_CONSUMER_MISMATCH");

  const created = await request("/git-commit-story", {
    repositoryId: "repo-a",
    revision: gitRevision,
    projectId,
    configurationConfirmed: true,
    configuration: { mode: "local", localProjectId: "shared-base", localRole: "primary" },
    storyInitializationIntentId: prepared.body.data.id,
  }, ownerAToken);
  assert.equal(created.status, 202, created.body.error);
  assert.equal(created.body.backgroundInitialization, true);
  assert.equal(created.body.data.workspaceInitialization.status, "queued");
  assert.equal(created.body.data.workspaceInitialization.completionUpdates.reviewContext.repositoryId, "repo-a");
  assert.equal(created.body.data.workspaceInitialization.completionUpdates.reviewContext.revision, gitRevision);
  assert.equal(created.body.data.reviewContext.repositoryId, "repo-a",
    "queued 响应必须立即发布 commit 身份，重放不能等 worktree ready");
  assert.equal(created.body.data.reviewContext.revision, gitRevision);
  const ready = await waitForWorkspaceInitialization(created.body.data.id);
  assert.equal(ready.workspaceInitialization.status, "ready");
  assert.equal(ready.reviewContext.repositoryId, "repo-a");
  assert.equal(ready.reviewContext.revision, gitRevision);

  devbenchStore.updateTab(ready.id, {
    mode: "remote",
    primaryProjectId: null,
    extraProjects: [],
    flavors: [],
    deviceSerial: null,
  });
  const snapshotResponse = await fetch(`${base}/tabs/${encodeURIComponent(ready.id)}/config-snapshot`, {
    headers: { Authorization: `Bearer ${ownerAToken}` },
  });
  const snapshot = await snapshotResponse.json();
  assert.equal(snapshotResponse.status, 200, snapshot.error);
  assert.equal(snapshot.data.mode, "remote", "ready 后必须返回实时 mode，不能重放创建快照");
  assert.equal(snapshot.data.primaryProjectId, null);
  assert.deepEqual(snapshot.data.flavors, []);
  assert.equal(snapshot.data.workspaceInitialization.status, "ready");
});

test("后台初始化期间统一阻断工作流副作用与关闭，失败后允许安全关闭", async () => {
  const tab = devbenchStore.createTab({ title: `后台初始化生命周期-${Date.now()}` });
  devbenchStore.updateTab(tab.id, {
    mode: "local",
    primaryProjectId: null,
    workspaceInitialization: {
      version: 2,
      operationId: `test-${Date.now()}`,
      generation: 1,
      status: "queued",
      stage: "queued",
      progress: 5,
      snapshot: { mode: "local", primaryProjectId: "shared-base" },
    },
  });

  const triage = await request(`/tabs/${encodeURIComponent(tab.id)}/workflow/triage`, {}, ownerAToken);
  assert.equal(triage.status, 409);
  assert.equal(triage.body.code, "STORY_INITIALIZATION_IN_PROGRESS");
  const closing = await request(`/tabs/${encodeURIComponent(tab.id)}`, {}, ownerAToken, "DELETE");
  assert.equal(closing.status, 409);
  assert.equal(closing.body.code, "STORY_INITIALIZATION_IN_PROGRESS");

  devbenchStore.updateTab(tab.id, {
    worktreeStatus: "error",
    worktreeError: "isolated failure",
    workspaceInitialization: {
      ...devbenchStore.getTab(tab.id).workspaceInitialization,
      status: "error",
      stage: "error",
      error: "isolated failure",
    },
  });
  const closed = await request(`/tabs/${encodeURIComponent(tab.id)}`, {}, ownerAToken, "DELETE");
  assert.equal(closed.status, 200, closed.body.error);
});
