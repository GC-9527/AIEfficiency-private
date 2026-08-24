import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { __setSpawn } from "../services/cardev/adb.js";
import {
  buildGeelyEngineeringModePassword,
  openGeelyEngineeringMode,
  parseGeelyDialpadTargets,
  parseGeelyP177DialpadFallback,
} from "../services/cardev/engineering-mode/plugins/geely.js";
import {
  enterEngineeringMode,
  getEngineeringModePlugin,
  listEngineeringModePlugins,
} from "../services/cardev/engineering-mode/registry.js";

const DIALPAD_XML = `<?xml version="1.0"?><hierarchy>
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

function spawnRecorder(calls, { failAt = -1 } = {}) {
  return (command, args) => {
    const index = calls.length;
    calls.push({ command, args: [...args] });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;
    setImmediate(() => {
      if (index === failAt) child.stderr.emit("data", Buffer.from("step failed", "utf8"));
      else if (args.includes("uiautomator")) child.stdout.emit("data", Buffer.from(DIALPAD_XML, "utf8"));
      else if (args.includes("dumpsys") && args.includes("activity")) {
        child.stdout.emit("data", Buffer.from("topResumedActivity=ActivityRecord{1 u10 com.geely.engineermode/.MainActivity}", "utf8"));
      }
      child.emit("close", index === failAt ? 1 : 0);
    });
    return child;
  };
}

test("Geely 工程模式密码遵循月份加五、日期和 12 小时制小时规则", () => {
  assert.equal(buildGeelyEngineeringModePassword(new Date(2026, 4, 20, 15, 10)), "#*10203");
  assert.equal(buildGeelyEngineeringModePassword(new Date(2026, 0, 2, 0, 59)), "#*6212");
  assert.equal(buildGeelyEngineeringModePassword(new Date(2026, 11, 31, 12, 0)), "#*173112");
  assert.throws(() => buildGeelyEngineeringModePassword(new Date("invalid")), /valid Date/);
});

test("解析拨号盘按钮中心坐标并忽略无效节点", () => {
  const targets = parseGeelyDialpadTargets(`${DIALPAD_XML}<node resource-id="x:id/one" bounds="[0,0][0,0]" />`);
  assert.deepEqual(targets.deleteButton, { x: 450, y: 550 });
  assert.deepEqual(targets.keys["#"], { x: 350, y: 550 });
  assert.deepEqual(targets.keys["*"], { x: 150, y: 550 });
  assert.deepEqual(targets.keys["1"], { x: 150, y: 250 });
});

test("P177 只在主驾拨号窗口可见且分辨率匹配时使用几何兜底", () => {
  const windowDump = `Window #17 Window{1 u10 com.android.dialer/com.android.dialer.DialtactsActivity}:
    mDisplayId=0 mGeelyDisplayId=1001
    Requested w=2560 h=1600 mLayoutSeq=138
    mFrame=[0,0][2560,1600] last=[0,0][2560,1600]
    isOnScreen=true
    isVisible=true`;
  const targets = parseGeelyP177DialpadFallback("P177-LE", windowDump);
  assert.deepEqual(targets.deleteButton, { x: 752, y: 1248 });
  assert.deepEqual(targets.keys["#"], { x: 772, y: 1054 });
  assert.deepEqual(targets.keys["1"], { x: 188, y: 487 });
  assert.equal(targets.displayId, 0);

  assert.equal(parseGeelyP177DialpadFallback("Pixel_4_XL", windowDump), null);
  assert.equal(parseGeelyP177DialpadFallback("P177-LE", windowDump.replace("isVisible=true", "isVisible=false")), null);
  assert.equal(parseGeelyP177DialpadFallback("P177-LE", windowDump.replace("2560 h=1600", "1920 h=1080")), null);
});

test("厂商插件注册中心显式注册 Geely 并拒绝未知厂商", async () => {
  assert.deepEqual(listEngineeringModePlugins(), [{
    id: "geely",
    manufacturer: "Geely",
    displayName: "Geely车机工程模式",
  }]);
  assert.equal(getEngineeringModePlugin("GEELY")?.id, "geely");
  assert.deepEqual(await enterEngineeringMode("unknown", "CAR-UNKNOWN"), {
    ok: false,
    statusCode: 400,
    code: "CARDEV_ENGINEERING_MODE_PLUGIN_NOT_FOUND",
    error: "不支持的车机工程模式厂商：unknown",
  });
});

test("打开拨号页后重置旧号码，并按拨号盘按钮逐键输入", async () => {
  const calls = [];
  __setSpawn(spawnRecorder(calls));
  try {
    const result = await openGeelyEngineeringMode("CAR-001", {
      now: new Date(2026, 4, 20, 15, 10),
      renderDelayMs: 0,
      keyDelayMs: 0,
      verificationDelayMs: 0,
    });
    assert.deepEqual(result, {
      ok: true,
      serial: "CAR-001",
      password: "#*10203",
      inputMethod: "dialpad_tap",
    });
    assert.deepEqual(calls, [
      { command: "adb", args: ["-s", "CAR-001", "shell", "am", "start", "-W", "-a", "android.intent.action.DIAL", "-d", "tel:0"] },
      { command: "adb", args: ["-s", "CAR-001", "exec-out", "uiautomator", "dump", "/dev/tty"] },
      { command: "adb", args: ["-s", "CAR-001", "shell", "input", "tap", "450", "550"] },
      { command: "adb", args: ["-s", "CAR-001", "shell", "input", "tap", "350", "550"] },
      { command: "adb", args: ["-s", "CAR-001", "shell", "input", "tap", "150", "550"] },
      { command: "adb", args: ["-s", "CAR-001", "shell", "input", "tap", "150", "250"] },
      { command: "adb", args: ["-s", "CAR-001", "shell", "input", "tap", "250", "550"] },
      { command: "adb", args: ["-s", "CAR-001", "shell", "input", "tap", "250", "250"] },
      { command: "adb", args: ["-s", "CAR-001", "shell", "input", "tap", "250", "550"] },
      { command: "adb", args: ["-s", "CAR-001", "shell", "input", "tap", "350", "250"] },
      { command: "adb", args: ["-s", "CAR-001", "shell", "dumpsys", "activity", "activities"] },
    ]);
  } finally {
    __setSpawn();
  }
});

test("任一步失败后立即停止，不继续向车机输入", async () => {
  const calls = [];
  __setSpawn(spawnRecorder(calls, { failAt: 2 }));
  try {
    const result = await openGeelyEngineeringMode("CAR-002", {
      now: new Date(2026, 4, 20, 15, 10),
      renderDelayMs: 0,
      keyDelayMs: 0,
      verificationDelayMs: 0,
    });
    assert.equal(result.ok, false);
    assert.equal(result.step, "clear-seed");
    assert.equal(calls.length, 3);
  } finally {
    __setSpawn();
  }
});

test("拨号盘缺少所需按钮时失败关闭，不发送点击", async () => {
  const calls = [];
  __setSpawn((command, args) => {
    calls.push({ command, args: [...args] });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;
    setImmediate(() => {
      child.stdout.emit("data", Buffer.from(args.includes("uiautomator") ? "<hierarchy />" : "ok", "utf8"));
      child.emit("close", 0);
    });
    return child;
  });
  try {
    const result = await openGeelyEngineeringMode("CAR-003", {
      now: new Date(2026, 4, 20, 15, 10),
      renderDelayMs: 0,
      keyDelayMs: 0,
      verificationDelayMs: 0,
    });
    assert.equal(result.ok, false);
    assert.equal(result.step, "locate-dialpad");
    assert.equal(result.code, "CARDEV_GEELY_DIALPAD_KEYS_NOT_FOUND");
    assert.equal(calls.length, 3);
  } finally {
    __setSpawn();
  }
});

test("P177 HUD 抢占 uiautomator 时使用主屏拨号几何并验证工程模式", async () => {
  const calls = [];
  __setSpawn((command, args) => {
    calls.push({ command, args: [...args] });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;
    setImmediate(() => {
      let output = "";
      if (args.includes("uiautomator")) output = '<hierarchy><node package="com.geely.hud" /></hierarchy>';
      else if (args.includes("getprop")) output = "P177-LE\n";
      else if (args.includes("window")) {
        output = `Window #17 Window{1 u10 com.android.dialer/com.android.dialer.DialtactsActivity}:
          mDisplayId=0 mGeelyDisplayId=1001
          Requested w=2560 h=1600 mLayoutSeq=138
          mFrame=[0,0][2560,1600] last=[0,0][2560,1600]
          isVisible=true`;
      } else if (args.includes("activity")) {
        output = "topResumedActivity=ActivityRecord{1 u10 com.geely.engineermode/.MainActivity}";
      }
      child.stdout.emit("data", Buffer.from(output, "utf8"));
      child.emit("close", 0);
    });
    return child;
  });
  try {
    const result = await openGeelyEngineeringMode("P177-CAR", {
      now: new Date(2026, 4, 20, 15, 10),
      renderDelayMs: 0,
      keyDelayMs: 0,
      verificationDelayMs: 0,
    });
    assert.equal(result.ok, true);
    assert.equal(result.inputMethod, "p177_dialpad_geometry_tap");
    assert.deepEqual(calls[4].args, ["-s", "P177-CAR", "shell", "input", "-d", "0", "tap", "752", "1248"]);
    assert.deepEqual(calls.at(-1).args, ["-s", "P177-CAR", "shell", "dumpsys", "activity", "activities"]);
  } finally {
    __setSpawn();
  }
});

test("按键发完但未进入工程模式时不返回成功", async () => {
  const calls = [];
  __setSpawn((command, args) => {
    calls.push({ command, args: [...args] });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;
    setImmediate(() => {
      const output = args.includes("uiautomator")
        ? DIALPAD_XML
        : (args.includes("activity") ? "topResumedActivity=com.android.dialer/.DialtactsActivity" : "");
      child.stdout.emit("data", Buffer.from(output, "utf8"));
      child.emit("close", 0);
    });
    return child;
  });
  try {
    const result = await openGeelyEngineeringMode("CAR-004", {
      now: new Date(2026, 4, 20, 15, 10),
      renderDelayMs: 0,
      keyDelayMs: 0,
      verificationDelayMs: 0,
    });
    assert.equal(result.ok, false);
    assert.equal(result.step, "verify-engineering-mode");
    assert.equal(result.code, "CARDEV_GEELY_ENGINEERING_MODE_NOT_OPENED");
  } finally {
    __setSpawn();
  }
});
