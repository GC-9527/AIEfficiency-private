import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateStoryCreationDevice } from "../services/devbench/story-create-device.js";

const validate = (serial, result) => validateStoryCreationDevice(serial, {
  listDevices: async () => result,
});

test("已有故事点的绑定不占用设备，在线 serial 可被其它故事点共享绑定", async () => {
  let enumerated = false;
  const result = await validateStoryCreationDevice("SERIAL-1", {
    listTabs: () => [{ id: "story-a", title: "故事 A", deviceSerial: "SERIAL-1" }],
    listDevices: async () => {
      enumerated = true;
      return { ok: true, devices: [{ id: "SERIAL-1", status: "device" }] };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.serial, "SERIAL-1");
  assert.equal(enumerated, true, "共享绑定仍必须执行 ADB 在线校验，不能因已有绑定而跳过");
});

test("设备枚举异常、失败、缺失、offline 和 unauthorized 均 fail-closed", async () => {
  const thrown = await validateStoryCreationDevice("SERIAL-1", {
    listDevices: async () => { throw new Error("adb crashed"); },
  });
  assert.equal(thrown.code, "STORY_DEVICE_ENUMERATION_FAILED");
  assert.equal((await validate("SERIAL-1", { ok: false, error: "adb down", devices: [] })).code,
    "STORY_DEVICE_ENUMERATION_FAILED");
  assert.equal((await validate("SERIAL-1", { ok: true, devices: [] })).code,
    "STORY_DEVICE_NOT_FOUND");
  const offline = await validate("SERIAL-1", {
    ok: true,
    devices: [{ id: "SERIAL-1", status: "offline" }],
  });
  assert.equal(offline.code, "STORY_DEVICE_NOT_READY");
  assert.equal(offline.deviceStatus, "offline");
  const unauthorized = await validate("SERIAL-1", {
    ok: true,
    devices: [{ id: "SERIAL-1", status: "unauthorized" }],
  });
  assert.equal(unauthorized.code, "STORY_DEVICE_NOT_READY");
  assert.equal(unauthorized.deviceStatus, "unauthorized");
});

test("仅 ADB status=device 的目标可通过创建前校验", async () => {
  const result = await validate("SERIAL-1", {
    ok: true,
    devices: [{ id: "SERIAL-1", status: "device" }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.serial, "SERIAL-1");
});

test("共享绑定不区分同组或组外，运行时互斥由 device-runtime 负责", async () => {
  const tabs = [
    { id: "story-a", groupId: "group-1", title: "同组来源", deviceSerial: "SERIAL-1" },
    { id: "story-b", groupId: "group-2", title: "组外来源", deviceSerial: "SERIAL-2" },
  ];
  const devices = {
    ok: true,
    devices: [
      { id: "SERIAL-1", status: "device" },
      { id: "SERIAL-2", status: "device" },
    ],
  };
  const shared = await validateStoryCreationDevice("SERIAL-1", {
    exceptStoryId: "story-target",
    exceptGroupId: "group-1",
    listTabs: () => tabs,
    listDevices: async () => devices,
  });
  assert.equal(shared.ok, true);
  const outsideGroupShared = await validateStoryCreationDevice("SERIAL-2", {
    exceptStoryId: "story-target",
    exceptGroupId: "group-1",
    listTabs: () => tabs,
    listDevices: async () => devices,
  });
  assert.equal(outsideGroupShared.ok, true);
  assert.equal(outsideGroupShared.serial, "SERIAL-2");
});

test("应用配置先 fail-closed 校验设备，再准备工程并原子写入共享绑定", () => {
  const source = readFileSync(new URL("../routes/devbench.js", import.meta.url), "utf8");
  const start = source.indexOf('router.post("/tabs/:id/apply-config"');
  const end = source.indexOf("// ===== 故事点组/队列", start);
  assert.ok(start >= 0 && end > start);
  const route = source.slice(start, end);
  assert.equal(route.includes("releaseDeviceFromOtherTabs"), false);
  assert.ok(
    route.indexOf("validateStoryCreationDevice") < route.indexOf("provisionLocalStoryWorkspace"),
    "设备在线状态必须在 worktree 副作用前校验",
  );
  assert.ok(
    route.indexOf("prepareDeviceBindingChange") < route.indexOf("provisionLocalStoryWorkspace"),
    "切换绑定前必须先阻止本故事点正在使用设备的情况",
  );
  assert.match(route, /WORKTREE_CREATE_FAILED[\s\S]*?partial:\s*true[\s\S]*?tabId:\s*tab\.id/);
  assert.match(route, /STORY_CONFIG_UPDATE_FAILED[\s\S]*?partial:\s*true/);
  assert.match(route, /updateTabDeviceBinding\(tab\.id, updates\)/);
  assert.equal(route.includes("updateTabWithDeviceClaim"), false);
  assert.equal(route.includes("STORY_DEVICE_TAKEN"), false);
});

test("手动绑定、普通创建和 Git 创建均保留在线预检与 Store 原子写入门禁", () => {
  const source = readFileSync(new URL("../routes/devbench.js", import.meta.url), "utf8");
  const manualStart = source.indexOf('router.post("/tabs/:id/device"');
  const manualEnd = source.indexOf('// 释放当前设备', manualStart);
  const manualRoute = source.slice(manualStart, manualEnd);
  assert.ok(
    manualRoute.indexOf("validateStoryCreationDevice") < manualRoute.indexOf("updateTabDeviceBinding"),
    "手动绑定必须先检查 ADB 在线状态",
  );
  assert.match(manualRoute, /updateTabDeviceBinding/);
  assert.equal(manualRoute.includes("store.listTabs().find"), false);
  assert.equal(manualRoute.includes("releaseDeviceFromOtherTabs"), false);

  const assignStart = source.indexOf("function assignDeviceAfterStoryCreation");
  const assignEnd = source.indexOf("async function resolveStoryInitializationTicket", assignStart);
  const assign = source.slice(assignStart, assignEnd);
  assert.match(assign, /updateTabDeviceBinding/);
  assert.equal(assign.includes("store.listTabs().find"), false);
  assert.equal(assign.includes("store.updateTab("), false);

  const createStart = source.indexOf('router.post("/tabs", async');
  const createEnd = source.indexOf('router.post("/tabs/:id/title"', createStart);
  const createRoute = source.slice(createStart, createEnd);
  assert.ok(
    createRoute.indexOf("creationDeviceValidation") < createRoute.indexOf("store.createTabGuarded"),
    "普通故事点必须在创建记录前重新校验设备在线状态",
  );
  assert.match(createRoute, /assignDeviceAfterStoryCreation\(tab, snapshot\.deviceSerial\)/);

  const gitStart = source.indexOf('router.post("/git-commit-story", async');
  const gitEnd = source.indexOf("function assignDeviceAfterStoryCreation", gitStart);
  const gitRoute = source.slice(gitStart, gitEnd);
  assert.ok(
    gitRoute.indexOf("deviceValidation") < gitRoute.indexOf("store.createTabGuarded"),
    "Git 故事点必须在创建记录前重新校验设备在线状态",
  );
  assert.match(gitRoute, /assignDeviceAfterStoryCreation/);
});
