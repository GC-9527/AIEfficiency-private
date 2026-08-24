import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "devbench-remote-generation-"));
process.env.NODE_ENV = "test";
process.env.GATEWAY_DB_PATH = path.join(runtimeRoot, "gateway.db");
process.env.DEVBENCH_STORE_DIR = path.join(runtimeRoot, "store");

const [{ default: express }, routeModule, store, worktreeManager] = await Promise.all([
  import("express"),
  import("../routes/devbench.js"),
  import("../services/devbench/store.js"),
  import("../services/devbench/worktree-manager.js"),
]);

test.after(async () => {
  try {
    const { default: database } = await import("../db/sqlite.js");
    if (database?.open) database.close();
  } catch {}
  try { fs.rmSync(runtimeRoot, { recursive: true, force: true }); } catch {}
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate, message, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

async function startApi(t) {
  const app = express();
  app.use(express.json());
  app.use("/api/devbench", routeModule.default);
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}/api/devbench`;
}

async function api(baseUrl, method, route, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  return { status: response.status, ...payload };
}

function remotePull(branch) {
  return {
    vehicle: `vehicle-${branch}`,
    tbId: `CARB-${branch === "A" ? "10001" : "10002"}`,
    entries: [{ projectId: "app-market", branch, flavor: `flavor-${branch}` }],
  };
}

function remoteResult(branch) {
  return {
    ok: true,
    remoteRepos: [{
      key: "app-market",
      role: "primary",
      path: path.join(runtimeRoot, `source-${branch}`),
      branch,
      flavor: `flavor-${branch}`,
      ok: true,
    }],
  };
}

function fakeProvisionLocalStoryWorkspace(preparedTab, snapshot, options = {}) {
  assert.equal(options.leaseGuard(), true, "写回前必须仍持有当前 generation 的 mutation lease");
  const result = {
    mode: "local",
    primaryProjectId: snapshot.primaryProjectId,
    worktree: {
      managed: true,
      root: path.join(runtimeRoot, `worktree-${snapshot.primaryProjectId}`),
      entries: [],
    },
    extraProjects: [],
    flavors: snapshot.flavors || [],
    apkSourcePath: snapshot.apkSourcePath || null,
  };
  if (options.deferCommit === true) return Promise.resolve(result);
  const additional = typeof options.commitUpdates === "function"
    ? options.commitUpdates(result, store.getTab(preparedTab.id))
    : (options.commitUpdates || {});
  const committedTab = store.updateTab(preparedTab.id, {
    ...result,
    worktreeStatus: "ready",
    worktreeError: null,
    ...additional,
  });
  Object.defineProperty(result, "committedTab", { value: committedTab, enumerable: false });
  return Promise.resolve(result);
}

test("远程 A 未完成时应用 B，以 operation generation 排队且 A 晚到结果不能写入 B", async (t) => {
  const baseUrl = await startApi(t);
  const pendingA = deferred();
  const pendingB = deferred();
  const calls = [];
  const provisionedPrimaryProjects = [];
  const restoreRuntime = routeModule.setRemoteStorySourceInitializationRuntimeForTest({
    runRemoteInit: async (operationTab) => {
      const branch = operationTab.remotePull.entries[0].branch;
      calls.push({
        branch,
        operationTabId: operationTab.id,
        operationId: operationTab.remoteSourceInitialization?.operationId,
        generation: operationTab.remoteSourceInitialization?.generation,
      });
      return branch === "A" ? pendingA.promise : pendingB.promise;
    },
    localizeCompletedRemoteTab: (_tab, remoteRepos) => ({
      mode: "local",
      primaryProjectId: `localized-${remoteRepos[0].branch}`,
      extraProjects: [],
      flavors: [],
      apkSourcePath: remoteRepos[0].path,
      remoteLocalizedAt: Date.now(),
    }),
    provisionLocalStoryWorkspace: (...args) => {
      provisionedPrimaryProjects.push(args[1].primaryProjectId);
      return fakeProvisionLocalStoryWorkspace(...args);
    },
  });
  t.after(restoreRuntime);

  const created = store.createTab({ title: "远程代次保护" });
  store.updateTab(created.id, {
    mode: "remote",
    primaryProjectId: "previous-primary",
    worktree: { managed: true, root: path.join(runtimeRoot, "previous-worktree"), entries: [] },
    remotePull: remotePull("A"),
    remoteRepos: [],
    cloneStatus: null,
  });

  const startedA = await api(baseUrl, "POST", `/tabs/${created.id}/remote/init`);
  assert.equal(startedA.status, 200, JSON.stringify(startedA));
  await waitFor(() => calls.length === 1, "A 的可控初始化 Promise 未启动");
  const stateA = store.getTab(created.id);
  assert.equal(stateA.remoteSourceInitialization.generation, 1);
  assert.equal(calls[0].operationTabId, "",
    "底层 clone 必须使用前端忽略的空影子 tab，不能直接写真实故事点");
  assert.equal(calls[0].operationId, stateA.remoteSourceInitialization.operationId);
  assert.equal(calls[0].generation, 1);

  const appliedB = await api(baseUrl, "POST", `/tabs/${created.id}/apply-config`, {
    snapshot: {
      mode: "remote",
      projectDefId: null,
      primaryProjectId: null,
      extraProjects: [],
      flavors: [],
      deviceSerial: null,
      remotePull: remotePull("B"),
      remoteRepos: [],
    },
  });
  assert.equal(appliedB.status, 202, JSON.stringify(appliedB));
  assert.equal(appliedB.backgroundInitialization, true);
  const queuedB = store.getTab(created.id);
  assert.equal(queuedB.remotePull.entries[0].branch, "B");
  assert.equal(queuedB.remoteSourceInitialization.generation, 2);
  assert.notEqual(queuedB.remoteSourceInitialization.operationId, stateA.remoteSourceInitialization.operationId);
  assert.equal(queuedB.cloneStatus, "queued");
  assert.deepEqual(queuedB.remoteRepos, []);
  assert.equal(queuedB.primaryProjectId, null);
  assert.equal(calls.length, 1, "B 必须等待 A 的真实 Promise 收口，不能复用或并发篡改同一 worktree");

  pendingA.resolve(remoteResult("A"));
  await waitFor(() => calls.length === 2, "A 收口后没有按新 operation 启动 B");
  const afterLateA = store.getTab(created.id);
  assert.equal(afterLateA.remotePull.entries[0].branch, "B");
  assert.equal(afterLateA.remoteSourceInitialization.generation, 2);
  assert.deepEqual(afterLateA.remoteRepos, [], "A 的晚到 remoteRepos 不得进入 B");
  assert.equal(afterLateA.primaryProjectId, null, "A 的晚到 localization 不得进入 B");

  pendingB.resolve(remoteResult("B"));
  const completedB = await waitFor(
    () => store.getTab(created.id)?.cloneStatus === "done" && store.getTab(created.id),
    "B 初始化没有完成",
  );
  assert.equal(completedB.remoteSourceInitialization.status, "ready");
  assert.equal(completedB.remoteSourceInitialization.generation, 2);
  assert.equal(completedB.primaryProjectId, "localized-B");
  assert.deepEqual(completedB.remoteRepos.map((repo) => repo.branch), ["B"]);
  assert.deepEqual(provisionedPrimaryProjects, ["localized-B"],
    "旧 A 不得创建或写回 worktree，只有 B 可以进入 workspace provision");
});

test("被 B 取代的 A Promise 晚到拒绝时不得写入 B 的 error", async (t) => {
  const baseUrl = await startApi(t);
  const pendingA = deferred();
  const pendingB = deferred();
  const calls = [];
  const restoreRuntime = routeModule.setRemoteStorySourceInitializationRuntimeForTest({
    runRemoteInit: async (operationTab) => {
      const branch = operationTab.remotePull.entries[0].branch;
      calls.push(branch);
      return branch === "A" ? pendingA.promise : pendingB.promise;
    },
    localizeCompletedRemoteTab: (_tab, remoteRepos) => ({
      mode: "local",
      primaryProjectId: `localized-${remoteRepos[0].branch}`,
      extraProjects: [],
      flavors: [],
      apkSourcePath: remoteRepos[0].path,
      remoteLocalizedAt: Date.now(),
    }),
    provisionLocalStoryWorkspace: fakeProvisionLocalStoryWorkspace,
  });
  t.after(restoreRuntime);

  const created = store.createTab({ title: "远程旧错误隔离" });
  store.updateTab(created.id, {
    mode: "remote",
    remotePull: remotePull("A"),
    remoteRepos: [],
    cloneStatus: null,
  });
  assert.equal((await api(baseUrl, "POST", `/tabs/${created.id}/remote/init`)).status, 200);
  await waitFor(() => calls.length === 1, "A 未启动");
  const appliedB = await api(baseUrl, "POST", `/tabs/${created.id}/apply-config`, {
    snapshot: {
      mode: "remote",
      primaryProjectId: null,
      remotePull: remotePull("B"),
      remoteRepos: [],
      deviceSerial: null,
    },
  });
  assert.equal(appliedB.status, 202, JSON.stringify(appliedB));

  pendingA.reject(Object.assign(new Error("A late failure"), { code: "A_LATE_FAILURE" }));
  await waitFor(() => calls.length === 2, "A 失败收口后 B 未启动");
  const afterLateError = store.getTab(created.id);
  assert.equal(afterLateError.remoteSourceInitialization.generation, 2);
  assert.notEqual(afterLateError.remoteSourceInitialization.status, "error");
  assert.equal(afterLateError.remoteSourceInitialization.error, null);
  assert.equal(afterLateError.remoteSourceInitialization.errorCode, null);
  assert.equal(afterLateError.cloneError, null);

  pendingB.resolve(remoteResult("B"));
  const completedB = await waitFor(
    () => store.getTab(created.id)?.cloneStatus === "done" && store.getTab(created.id),
    "B 初始化没有完成",
  );
  assert.equal(completedB.remoteSourceInitialization.status, "ready");
  assert.deepEqual(completedB.remoteRepos.map((repo) => repo.branch), ["B"]);
});

test("逐仓库进度写入真实 operation，失败时保留具体 Git 错误与仓库结果", async (t) => {
  const baseUrl = await startApi(t);
  const finishSourcePreparation = deferred();
  t.after(() => finishSourcePreparation.resolve());
  const restoreRuntime = routeModule.setRemoteStorySourceInitializationRuntimeForTest({
    runRemoteInit: async (_operationTab, options = {}) => {
      options.onProgress?.({
        repo: "app-market",
        status: "cloning",
        phase: "Receiving objects",
        percent: 50,
        name: "应用市场",
        branch: "v202605-ui",
      });
      await finishSourcePreparation.promise;
      return {
        ok: false,
        error: "应用市场（v202605-ui）：Filename too long",
        remoteRepos: [{
          key: "app-market",
          repositoryId: "app-market",
          name: "应用市场",
          role: "primary",
          branch: "v202605-ui",
          path: path.join(runtimeRoot, "failed-source"),
          ok: false,
          errorCode: "SOURCE_PREPARATION_CLONE_FAILED",
          error: "fatal: unable to create file WebAppVoiceControlAccTreeDebugOrRelease.kt: Filename too long",
        }],
      };
    },
  });
  t.after(restoreRuntime);

  const created = store.createTab({ title: "远程长路径失败诊断" });
  store.updateTab(created.id, {
    mode: "remote",
    remotePull: remotePull("A"),
    remoteRepos: [],
    cloneStatus: null,
  });
  const started = await api(baseUrl, "POST", `/tabs/${created.id}/remote/init`);
  assert.equal(started.status, 200, JSON.stringify(started));
  const progressing = await waitFor(() => {
    const current = store.getTab(created.id);
    return current?.remoteSourceInitialization?.progress > 5 ? current : null;
  }, "逐仓库进度没有写入真实故事点 operation");
  assert.ok(progressing.remoteSourceInitialization.progress > 5);
  assert.equal(progressing.remoteSourceInitialization.repositories["app-market"].phase, "Receiving objects");
  assert.ok(progressing.remoteSourceInitialization.repositories["app-market"].percent > 0);

  finishSourcePreparation.resolve();
  const failed = await waitFor(() => {
    const current = store.getTab(created.id);
    return current?.cloneStatus === "error" ? current : null;
  }, "源码失败没有收敛到 error");
  assert.match(failed.cloneError, /应用市场.*v202605-ui.*Filename too long/);
  assert.equal(failed.remoteRepos[0].errorCode, "SOURCE_PREPARATION_CLONE_FAILED");
  assert.match(failed.remoteRepos[0].error, /WebAppVoiceControlAccTreeDebugOrRelease\.kt.*Filename too long/);
  assert.equal(failed.remoteSourceInitialization.errorCode, "SOURCE_PREPARATION_CLONE_FAILED");
  assert.equal(failed.remoteSourceInitialization.result.failedRepositories[0].key, "app-market");
});

test("同 tab AI lease 忙时 apply-config 在任何配置清空和初始化启动前返回 409", async (t) => {
  const baseUrl = await startApi(t);
  let runnerCalls = 0;
  const restoreRuntime = routeModule.setRemoteStorySourceInitializationRuntimeForTest({
    runRemoteInit: async () => {
      runnerCalls += 1;
      return remoteResult("B");
    },
    localizeCompletedRemoteTab: () => ({ mode: "local", primaryProjectId: "should-not-run" }),
    provisionLocalStoryWorkspace: fakeProvisionLocalStoryWorkspace,
  });
  t.after(restoreRuntime);

  const created = store.createTab({ title: "AI 忙门禁" });
  const sentinelWorktree = {
    managed: true,
    root: path.join(runtimeRoot, "ai-busy-worktree"),
    entries: [],
  };
  const before = store.updateTab(created.id, {
    mode: "local",
    primaryProjectId: "sentinel-primary",
    worktree: sentinelWorktree,
    remotePull: remotePull("A"),
    remoteRepos: [{ branch: "sentinel", ok: true }],
    cloneStatus: "done",
  });
  const aiLease = worktreeManager.beginStoryAiLease(before, "controlled-ai-task");
  assert.ok(aiLease, "测试必须真实持有同 tab AI lease");
  t.after(() => worktreeManager.endStoryAiLease(aiLease));

  const blocked = await api(baseUrl, "POST", `/tabs/${created.id}/apply-config`, {
    snapshot: {
      mode: "remote",
      primaryProjectId: null,
      remotePull: remotePull("B"),
      remoteRepos: [],
      deviceSerial: null,
    },
  });
  assert.equal(blocked.status, 409, JSON.stringify(blocked));
  assert.equal(blocked.code, "WORKTREE_AI_RUNNING");
  const after = store.getTab(created.id);
  assert.equal(after.mode, "local");
  assert.equal(after.primaryProjectId, "sentinel-primary");
  assert.deepEqual(after.worktree, sentinelWorktree);
  assert.equal(after.remotePull.entries[0].branch, "A");
  assert.deepEqual(after.remoteRepos, [{ branch: "sentinel", ok: true }]);
  assert.equal(after.cloneStatus, "done");
  assert.equal(after.remoteSourceInitialization, undefined);
  assert.equal(runnerCalls, 0);
});

test("同 tab worktree mutation 忙时 apply-config 在原子配置发布前返回 409", async (t) => {
  const baseUrl = await startApi(t);
  const created = store.createTab({ title: "mutation 忙门禁" });
  const sentinelWorktree = {
    managed: true,
    root: path.join(runtimeRoot, "mutation-busy-worktree"),
    entries: [],
  };
  const before = store.updateTab(created.id, {
    mode: "local",
    primaryProjectId: "mutation-sentinel-primary",
    worktree: sentinelWorktree,
    remotePull: remotePull("A"),
    remoteRepos: [{ branch: "mutation-sentinel", ok: true }],
    cloneStatus: "done",
  });
  assert.equal(worktreeManager.beginWorktreeMutation(before, "cleanup"), true,
    "测试必须真实持有同 tab worktree mutation lease");
  t.after(() => worktreeManager.endWorktreeMutation(before));

  const blocked = await api(baseUrl, "POST", `/tabs/${created.id}/apply-config`, {
    snapshot: {
      mode: "remote",
      primaryProjectId: null,
      remotePull: remotePull("B"),
      remoteRepos: [],
      deviceSerial: null,
    },
  });
  assert.equal(blocked.status, 409, JSON.stringify(blocked));
  assert.equal(blocked.code, "WORKTREE_MUTATION_BUSY");
  const after = store.getTab(created.id);
  assert.equal(after.mode, "local");
  assert.equal(after.primaryProjectId, "mutation-sentinel-primary");
  assert.deepEqual(after.worktree, sentinelWorktree);
  assert.equal(after.remotePull.entries[0].branch, "A");
  assert.deepEqual(after.remoteRepos, [{ branch: "mutation-sentinel", ok: true }]);
  assert.equal(after.remoteSourceInitialization, undefined);
});
