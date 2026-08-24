import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "device-operation-route-guard-"));
process.env.NODE_ENV = "production";
process.env.GATEWAY_DB_PATH = path.join(tmp, "gateway.db");
process.env.GATEWAY_CONFIG_PATH = path.join(tmp, "gateway.json");
process.env.DEVBENCH_CONFIG_PATH = path.join(tmp, "market.json");
process.env.DEVBENCH_LOCAL_PROJECTS_PATH = path.join(tmp, "local", "devbench-projects.json");
process.env.DEVBENCH_STORE_DIR = path.join(tmp, "store");
process.env.AIEFFICIENCY_CLONE_PARENT = path.join(tmp, "clone-parent");
process.env.DEVBENCH_SYNC_SCOPE = `device-operation-route-${Date.now()}`;
process.env.ROLE = "standalone";

fs.mkdirSync(path.dirname(process.env.DEVBENCH_LOCAL_PROJECTS_PATH), { recursive: true });
fs.mkdirSync(process.env.AIEFFICIENCY_CLONE_PARENT, { recursive: true });
fs.writeFileSync(process.env.GATEWAY_CONFIG_PATH, JSON.stringify({
  role: "standalone",
  servers: { nodeId: "device-operation-route-node", discovery: false, peers: [] },
}), "utf8");
fs.writeFileSync(process.env.DEVBENCH_CONFIG_PATH, JSON.stringify({ projects: [] }), "utf8");
fs.writeFileSync(process.env.DEVBENCH_LOCAL_PROJECTS_PATH, JSON.stringify({
  version: 2,
  cloneParent: process.env.AIEFFICIENCY_CLONE_PARENT,
  projects: [],
}), "utf8");

const express = (await import("express")).default;
const cardevRouter = (await import("../routes/cardev.js")).default;
const devbenchRouter = (await import("../routes/devbench.js")).default;
const runtime = await import("../services/devbench/device-runtime-service.js");
const devbenchStore = await import("../services/devbench/store.js");
const { issueToken, revokeToken } = await import("../services/admin-auth.js");
const { __setSpawn } = await import("../services/cardev/adb.js");
const adminToken = issueToken({ role: "super", name: "设备路由守卫测试" });

const app = express();
app.use(express.json());
app.use("/api/cardev", cardevRouter);
app.use("/api/devbench", devbenchRouter);
const server = await new Promise((resolve) => {
  const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
});
const base = `http://127.0.0.1:${server.address().port}`;

async function request(pathname, body, { authenticated = true, headers: extraHeaders = {} } = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...extraHeaders,
  };
  if (authenticated) headers.Authorization = `Bearer ${adminToken}`;
  const response = await fetch(`${base}${pathname}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body || {}),
  });
  return { status: response.status, body: await response.json() };
}

const DIALPAD_XML = `<hierarchy>
  <node resource-id="com.android.dialer:id/one" bounds="[100,200][200,300]" />
  <node resource-id="com.android.dialer:id/two" bounds="[200,200][300,300]" />
  <node resource-id="com.android.dialer:id/three" bounds="[300,200][400,300]" />
  <node resource-id="com.android.dialer:id/four" bounds="[100,300][200,400]" />
  <node resource-id="com.android.dialer:id/five" bounds="[200,300][300,400]" />
  <node resource-id="com.android.dialer:id/six" bounds="[300,300][400,400]" />
  <node resource-id="com.android.dialer:id/seven" bounds="[100,400][200,500]" />
  <node resource-id="com.android.dialer:id/eight" bounds="[200,400][300,500]" />
  <node resource-id="com.android.dialer:id/nine" bounds="[300,400][400,500]" />
  <node resource-id="com.android.dialer:id/star" bounds="[100,500][200,600]" />
  <node resource-id="com.android.dialer:id/zero" bounds="[200,500][300,600]" />
  <node resource-id="com.android.dialer:id/pound" bounds="[300,500][400,600]" />
  <node resource-id="com.android.dialer:id/deleteButton" bounds="[400,500][500,600]" />
</hierarchy>`;

const DIALPAD_TAP_BY_KEY = Object.freeze({
  "#": ["350", "550"],
  "*": ["150", "550"],
  "0": ["250", "550"],
  "1": ["150", "250"],
  "2": ["250", "250"],
  "3": ["350", "250"],
  "4": ["150", "350"],
  "5": ["250", "350"],
  "6": ["350", "350"],
  "7": ["150", "450"],
  "8": ["250", "450"],
  "9": ["350", "450"],
});

function commandSpawnRecorder(calls) {
  return (command, args) => {
    calls.push({ command, args: [...args] });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;
    child.unref = () => {};
    setImmediate(() => {
      const output = args.includes("uiautomator")
        ? DIALPAD_XML
        : (args.includes("activity")
          ? "topResumedActivity=ActivityRecord{1 u10 com.geely.engineermode/.MainActivity}\n"
          : "ok\n");
      child.stdout.emit("data", Buffer.from(output, "utf8"));
      child.emit("close", 0);
    });
    return child;
  };
}

test("故事点投屏不受设备占用影响，其他设备操作仍不能绕过全局 lease", { timeout: 30_000 }, async (t) => {
  const serial = "ROUTE-GUARD-SERIAL";
  const spawnCalls = [];
  __setSpawn(commandSpawnRecorder(spawnCalls));
  t.after(async () => {
    __setSpawn();
    revokeToken(adminToken);
    await new Promise((resolve) => server.close(resolve));
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
  });

  const activeTab = devbenchStore.createTab({ title: "正在安装测试的故事点" });
  const activeBinding = devbenchStore.updateTabDeviceBinding(activeTab.id, { deviceSerial: serial });
  assert.equal(activeBinding.ok, true);

  const active = await runtime.acquireDeviceUse({
    serial,
    requestId: "active-story-request",
    storyId: activeTab.id,
    taskId: "active-story-task",
    operationKind: "install_test",
    metadata: { title: "正在安装测试的故事点" },
    ttlMs: 60_000,
  });
  assert.equal(active.status, "acquired");

  const tab = devbenchStore.createTab({ title: "等待投屏的故事点" });
  const bound = devbenchStore.updateTabDeviceBinding(tab.id, { deviceSerial: serial });
  assert.equal(bound.ok, true);

  const ownerScrcpy = await request(`/api/devbench/tabs/${activeTab.id}/scrcpy`, { displayId: 1 });
  assert.equal(ownerScrcpy.status, 200, JSON.stringify(ownerScrcpy.body));
  assert.equal(ownerScrcpy.body.ok, true);
  assert.equal(spawnCalls.length, 1, "设备 owner 故事点应能在任务运行期间启动投屏");
  assert.ok(["cmd.exe", "scrcpy"].includes(spawnCalls[0].command));

  const otherStoryScrcpy = await request(`/api/devbench/tabs/${tab.id}/scrcpy`, { displayId: 2 });
  assert.equal(otherStoryScrcpy.status, 200, JSON.stringify(otherStoryScrcpy.body));
  assert.equal(otherStoryScrcpy.body.ok, true);
  assert.equal(spawnCalls.length, 2, "其他已绑定故事点的投屏也不应受设备占用影响");
  assert.ok(["cmd.exe", "scrcpy"].includes(spawnCalls[1].command));

  const activeAfterScrcpy = await runtime.getDeviceRuntimeSnapshot(serial);
  assert.equal(activeAfterScrcpy.lease?.leaseId, active.lease.leaseId, JSON.stringify(activeAfterScrcpy));
  assert.equal(activeAfterScrcpy.lease?.storyId, activeTab.id, JSON.stringify(activeAfterScrcpy));
  assert.deepEqual(activeAfterScrcpy.queue, []);

  const unauthenticatedShell = await request(
    "/api/cardev/shell",
    { serial, cmd: "echo must-not-run" },
    { authenticated: false },
  );
  assert.equal(unauthenticatedShell.status, 401, JSON.stringify(unauthenticatedShell.body));
  assert.equal(unauthenticatedShell.body.code, "AUTH_REQUIRED");

  for (const headers of [
    { "X-Forwarded-For": "127.0.0.1, 192.168.50.20" },
    { Origin: "https://evil.example" },
  ]) {
    const rejected = await request(
      "/api/cardev/devices/engineering-mode/geely",
      { serial },
      { authenticated: false, headers },
    );
    assert.equal(rejected.status, 403, JSON.stringify(rejected.body));
    assert.equal(rejected.body.code, "CARDEV_ENGINEERING_MODE_LOCAL_ONLY");
  }
  assert.equal(spawnCalls.length, 2, "未登录普通写操作和非本机工程模式请求都不能触发底层命令");

  const blockedRequests = [
    ["/api/cardev/devices/scrcpy", { serial }],
    ["/api/cardev/devices/engineering-mode/geely", { serial }, { authenticated: false }],
    ["/api/cardev/shell", { serial, cmd: "getprop ro.product.model" }],
    ["/api/cardev/apk/install", { serial, apkPath: "missing.apk" }],
    ["/api/cardev/apk/install-xapk", { serial, xapkPath: "missing.xapk" }],
    ["/api/cardev/apk/push", { serial, localPath: "missing.bin", remotePath: "/sdcard/" }],
    ["/api/cardev/apk/media-space/step1", { serial }],
    ["/api/cardev/apk/hw-voice/step1", { serial }],
    ["/api/cardev/commands/exec", { serial, command: "adb shell id" }],
    ["/api/cardev/commands/exec", { command: `adb -s ${serial} shell id` }],
  ];

  for (const [pathname, body, options] of blockedRequests) {
    const blocked = await request(pathname, body, options);
    assert.equal(blocked.status, 409, `${pathname}: ${JSON.stringify(blocked.body)}`);
    assert.equal(blocked.body.ok, false, pathname);
    assert.equal(blocked.body.code, "DEVICE_RUNTIME_BUSY", pathname);
    assert.equal(blocked.body.currentOwner?.storyId, activeTab.id, pathname);
  }
  assert.equal(spawnCalls.length, 2, "忙碌期间除故事点投屏外，其他底层 adb/scrcpy 命令都必须保持零调用");

  const released = await runtime.releaseDeviceUse({
    serial,
    leaseId: active.lease.leaseId,
    fencingToken: active.lease.fencingToken,
    reason: "route_guard_test_release",
  });
  assert.equal(released.status, "released");

  const shell = await request("/api/cardev/shell", { serial, cmd: "echo release-check" });
  assert.equal(shell.status, 200, JSON.stringify(shell.body));
  assert.equal(shell.body.ok, true);
  assert.equal(spawnCalls.length, 3);
  assert.deepEqual(spawnCalls[2], {
    command: "adb",
    args: ["-s", serial, "shell", "echo release-check"],
  });

  const engineeringMode = await request(
    "/api/cardev/devices/engineering-mode/geely",
    { serial },
    { authenticated: false },
  );
  assert.equal(engineeringMode.status, 200, JSON.stringify(engineeringMode.body));
  assert.equal(engineeringMode.body.ok, true);
  assert.equal(engineeringMode.body.manufacturer, "geely");
  assert.match(engineeringMode.body.password, /^#\*\d+$/);
  assert.equal(engineeringMode.body.inputMethod, "dialpad_tap");
  const expectedEngineeringCalls = [
    { command: "adb", args: ["-s", serial, "shell", "am", "start", "-W", "-a", "android.intent.action.DIAL", "-d", "tel:0"] },
    { command: "adb", args: ["-s", serial, "exec-out", "uiautomator", "dump", "/dev/tty"] },
    { command: "adb", args: ["-s", serial, "shell", "input", "tap", "450", "550"] },
    ...[...engineeringMode.body.password].map((key) => ({
      command: "adb",
      args: ["-s", serial, "shell", "input", "tap", ...DIALPAD_TAP_BY_KEY[key]],
    })),
    { command: "adb", args: ["-s", serial, "shell", "dumpsys", "activity", "activities"] },
  ];
  assert.deepEqual(spawnCalls.slice(3, 3 + expectedEngineeringCalls.length), expectedEngineeringCalls);

  const scrcpy = await request(`/api/devbench/tabs/${tab.id}/scrcpy`, { displayId: 2 });
  assert.equal(scrcpy.status, 200, JSON.stringify(scrcpy.body));
  assert.equal(scrcpy.body.ok, true);
  assert.equal(spawnCalls.length, 4 + expectedEngineeringCalls.length);
  assert.ok(["cmd.exe", "scrcpy"].includes(spawnCalls.at(-1).command));

  const idle = await runtime.getDeviceRuntimeSnapshot(serial);
  assert.equal(idle.lease, null, JSON.stringify(idle));
  assert.deepEqual(idle.queue, []);
});
