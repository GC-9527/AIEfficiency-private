import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const storeModuleUrl = new URL("../services/devbench/store.js", import.meta.url).href;
const runtimeServiceModuleUrl = new URL("../services/devbench/device-runtime-service.js", import.meta.url).href;
const gatewayDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const workerSource = `
const store = await import(process.env.STORE_MODULE_URL);
const mode = process.env.WORKER_MODE;
let result;
if (mode === "bootstrap") {
  const left = store.createTab({ title: "多 Gateway 设备共享绑定-左" });
  const right = store.createTab({ title: "多 Gateway 设备共享绑定-右" });
  result = { leftId: left.id, rightId: right.id };
} else if (mode === "bind") {
  const delay = Math.max(0, Number(process.env.START_AT || 0) - Date.now());
  if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
  result = store.updateTabDeviceBinding(process.env.TAB_ID, {
    deviceSerial: process.env.DEVICE_SERIAL,
    deviceClaimOwner: process.env.CLAIM_OWNER,
  });
} else if (mode === "inspect") {
  result = store.listTabs().map((tab) => ({
    id: tab.id,
    deviceSerial: tab.deviceSerial || null,
    deviceClaimOwner: tab.deviceClaimOwner || null,
  }));
} else if (mode === "runtime-acquire") {
  const runtime = await import(process.env.DEVICE_RUNTIME_SERVICE_MODULE_URL);
  const delay = Math.max(0, Number(process.env.START_AT || 0) - Date.now());
  if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
  result = await runtime.acquireDeviceUse({
    serial: process.env.DEVICE_SERIAL,
    requestId: process.env.REQUEST_ID,
    storyId: process.env.TAB_ID,
    taskId: process.env.TASK_ID,
    operationKind: "integration-test",
    ownerId: process.env.CLAIM_OWNER,
    ttlMs: process.env.TTL_MS ? Number(process.env.TTL_MS) : undefined,
  });
} else if (mode === "runtime-snapshot") {
  const runtime = await import(process.env.DEVICE_RUNTIME_SERVICE_MODULE_URL);
  result = await runtime.getDeviceRuntimeSnapshot(process.env.DEVICE_SERIAL);
} else if (mode === "runtime-project") {
  const runtime = await import(process.env.DEVICE_RUNTIME_SERVICE_MODULE_URL);
  result = await runtime.projectDeviceRuntime(process.env.DEVICE_SERIAL, []);
} else if (mode === "runtime-release") {
  const runtime = await import(process.env.DEVICE_RUNTIME_SERVICE_MODULE_URL);
  result = await runtime.releaseDeviceUse({
    serial: process.env.DEVICE_SERIAL,
    leaseId: process.env.LEASE_ID,
    fencingToken: Number(process.env.FENCING_TOKEN),
    reason: "integration-test-release",
  });
} else {
  throw new Error("unknown worker mode");
}
process.stdout.write("\\nDEVICE_RACE_RESULT:" + JSON.stringify(result) + "\\n");
`;

function runWorker(baseEnv, extraEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", workerSource], {
      cwd: gatewayDir,
      env: { ...process.env, ...baseEnv, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`设备运行时 worker 退出 ${code}: ${stderr || stdout}`));
        return;
      }
      const matches = [...stdout.matchAll(/DEVICE_RACE_RESULT:(.+)/g)];
      if (!matches.length) {
        reject(new Error(`设备运行时 worker 未返回结果: ${stderr || stdout}`));
        return;
      }
      try {
        resolve(JSON.parse(matches.at(-1)[1]));
      } catch (error) {
        reject(new Error(`设备运行时 worker 结果无法解析: ${error.message}; ${stdout}`));
      }
    });
  });
}

test("两个 Gateway 可并发共享绑定同一 serial，但运行时只授予一个并按 FIFO 交接", { timeout: 30_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "story-device-claim-race-"));
  const gatewayConfig = path.join(root, "gateway.json");
  const marketConfig = path.join(root, "market.json");
  const localProjects = path.join(root, "local", "devbench-projects.json");
  fs.mkdirSync(path.dirname(localProjects), { recursive: true });
  fs.mkdirSync(path.join(root, "clone-parent"), { recursive: true });
  fs.writeFileSync(gatewayConfig, JSON.stringify({ role: "standalone", servers: { nodeId: "device-race" } }));
  fs.writeFileSync(marketConfig, "{}");
  fs.writeFileSync(localProjects, JSON.stringify({ version: 2, projects: [], cloneParent: path.join(root, "clone-parent") }));
  t.after(() => {
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
  });

  const baseEnv = {
    NODE_ENV: "test",
    STORE_MODULE_URL: storeModuleUrl,
    DEVICE_RUNTIME_SERVICE_MODULE_URL: runtimeServiceModuleUrl,
    GATEWAY_CONFIG_PATH: gatewayConfig,
    GATEWAY_DB_PATH: path.join(root, "gateway.db"),
    DEVBENCH_CONFIG_PATH: marketConfig,
    DEVBENCH_LOCAL_PROJECTS_PATH: localProjects,
    DEVBENCH_STORE_DIR: path.join(root, "store"),
    AIEFFICIENCY_CLONE_PARENT: path.join(root, "clone-parent"),
    DEVBENCH_SYNC_SCOPE: `device-race-${Date.now()}`,
  };
  const seeded = await runWorker(baseEnv, { WORKER_MODE: "bootstrap" });
  const serial = "MULTI-GATEWAY-SERIAL-17005";
  const startAt = Date.now() + 500;
  const [left, right] = await Promise.all([
    runWorker(baseEnv, {
      WORKER_MODE: "bind",
      TAB_ID: seeded.leftId,
      DEVICE_SERIAL: serial,
      CLAIM_OWNER: "left",
      START_AT: String(startAt),
    }),
    runWorker(baseEnv, {
      WORKER_MODE: "bind",
      TAB_ID: seeded.rightId,
      DEVICE_SERIAL: serial,
      CLAIM_OWNER: "right",
      START_AT: String(startAt),
    }),
  ]);

  const outcomes = [left, right];
  assert.equal(outcomes.filter((item) => item.ok === true).length, 2, JSON.stringify(outcomes));

  const tabs = await runWorker(baseEnv, { WORKER_MODE: "inspect" });
  const bindings = tabs.filter((tab) => tab.deviceSerial === serial);
  assert.equal(bindings.length, 2, JSON.stringify(tabs));
  assert.deepEqual(
    bindings.map((tab) => tab.deviceClaimOwner).sort(),
    ["left", "right"],
    "共享绑定的两个原子写入都必须保留，不能互相覆盖",
  );

  const runtimeStartAt = Date.now() + 500;
  const runtimeInputs = [
    {
      TAB_ID: seeded.leftId,
      REQUEST_ID: "runtime-request-left",
      TASK_ID: "runtime-task-left",
      CLAIM_OWNER: "left",
    },
    {
      TAB_ID: seeded.rightId,
      REQUEST_ID: "runtime-request-right",
      TASK_ID: "runtime-task-right",
      CLAIM_OWNER: "right",
    },
  ];
  const runtimeOutcomes = await Promise.all(runtimeInputs.map((input) => runWorker(baseEnv, {
    WORKER_MODE: "runtime-acquire",
    DEVICE_SERIAL: serial,
    START_AT: String(runtimeStartAt),
    ...input,
  })));
  const acquired = runtimeOutcomes.find((item) => item.status === "acquired");
  const queued = runtimeOutcomes.find((item) => item.status === "queued");
  assert.ok(acquired?.lease, JSON.stringify(runtimeOutcomes));
  assert.ok(queued, JSON.stringify(runtimeOutcomes));
  assert.equal(runtimeOutcomes.filter((item) => item.status === "acquired").length, 1);
  assert.equal(runtimeOutcomes.filter((item) => item.status === "queued").length, 1);
  assert.equal(queued.position, 1);

  const busySnapshot = await runWorker(baseEnv, {
    WORKER_MODE: "runtime-snapshot",
    DEVICE_SERIAL: serial,
  });
  assert.equal(busySnapshot.lease.requestId, acquired.requestId);
  assert.equal(busySnapshot.lease.fencingToken, 1);
  assert.deepEqual(busySnapshot.queue.map((item) => item.requestId), [queued.requestId]);

  const released = await runWorker(baseEnv, {
    WORKER_MODE: "runtime-release",
    DEVICE_SERIAL: serial,
    LEASE_ID: acquired.lease.leaseId,
    FENCING_TOKEN: String(acquired.lease.fencingToken),
  });
  assert.equal(released.status, "released");
  assert.equal(released.nextLease.requestId, queued.requestId);
  assert.equal(released.nextLease.fencingToken, 2, "每次授予必须单调增加 fencing token");

  const handedOff = await runWorker(baseEnv, {
    WORKER_MODE: "runtime-snapshot",
    DEVICE_SERIAL: serial,
  });
  assert.equal(handedOff.lease.requestId, queued.requestId);
  assert.equal(handedOff.queue.length, 0);

  const restartSerial = "GATEWAY-RESTART-SERIAL-17006";
  const persistedRequest = {
    WORKER_MODE: "runtime-acquire",
    DEVICE_SERIAL: restartSerial,
    REQUEST_ID: "persisted-request-after-restart",
    TAB_ID: seeded.leftId,
    TASK_ID: "persisted-task-after-restart",
    CLAIM_OWNER: "",
  };
  const beforeRestart = await runWorker(baseEnv, persistedRequest);
  const afterRestart = await runWorker(baseEnv, persistedRequest);
  assert.equal(beforeRestart.status, "acquired");
  assert.equal(afterRestart.status, "acquired");
  assert.equal(afterRestart.idempotent, true, "同端口 Gateway 重启后必须能重放持久 requestId");
  assert.equal(afterRestart.lease.leaseId, beforeRestart.lease.leaseId);
  assert.equal(afterRestart.lease.ownerId, beforeRestart.lease.ownerId);

  const recoverySerial = "DEVICE-LIST-RECOVERY-SERIAL-17007";
  await runWorker(baseEnv, {
    WORKER_MODE: "runtime-acquire",
    DEVICE_SERIAL: recoverySerial,
    REQUEST_ID: "expiring-owner",
    TAB_ID: seeded.leftId,
    TASK_ID: "expiring-owner-task",
    CLAIM_OWNER: "owner-before-expiry",
    TTL_MS: "4000",
  });
  await runWorker(baseEnv, {
    WORKER_MODE: "runtime-acquire",
    DEVICE_SERIAL: recoverySerial,
    REQUEST_ID: "waiting-after-expiry",
    TAB_ID: seeded.rightId,
    TASK_ID: "waiting-after-expiry-task",
    CLAIM_OWNER: "owner-after-expiry",
  });
  await new Promise((resolve) => setTimeout(resolve, 4100));
  const projected = await runWorker(baseEnv, {
    WORKER_MODE: "runtime-project",
    DEVICE_SERIAL: recoverySerial,
  });
  assert.equal(projected.recovery.expiredLease.requestId, "expiring-owner");
  assert.equal(projected.recovery.nextLease.requestId, "waiting-after-expiry");
  assert.equal(projected.runtime.lease.requestId, "waiting-after-expiry");
});
