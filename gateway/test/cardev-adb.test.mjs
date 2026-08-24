import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  parseScrcpyDisplayList,
  classifyError,
  __setSpawn,
  listDevices,
} from "../services/cardev/adb.js";

/** 造一个最小 fake child：异步推 stdout/stderr，再以给定退出码 close。 */
function fakeSpawn({ stdout = "", stderr = "", code = 0 } = {}) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      if (stdout) child.stdout.emit("data", Buffer.from(stdout, "utf-8"));
      if (stderr) child.stderr.emit("data", Buffer.from(stderr, "utf-8"));
      child.emit("close", code);
    });
    return child;
  };
}

test("parseScrcpyDisplayList: parses scrcpy display-id output variants", () => {
  const text = `
scrcpy 2.7 <https://github.com/Genymobile/scrcpy>
INFO: List of displays:
    --display-id=2    (1920x720)
    --display-id 0 (2560x1440)
    --display_id=5
`;
  assert.deepEqual(parseScrcpyDisplayList(text), [
    { id: 0, resolution: "2560x1440" },
    { id: 2, resolution: "1920x720" },
    { id: 5, resolution: "" },
  ]);
});

test("parseScrcpyDisplayList: keeps later resolution for duplicate display-id", () => {
  const text = `
Usage: scrcpy --display-id=3
INFO:     --display-id=3 (1280x480)
INFO:     --display-id=1 (1920x1080)
`;
  assert.deepEqual(parseScrcpyDisplayList(text), [
    { id: 1, resolution: "1920x1080" },
    { id: 3, resolution: "1280x480" },
  ]);
});

test("parseScrcpyDisplayList: ignores unrelated text", () => {
  assert.deepEqual(parseScrcpyDisplayList("no display list available"), []);
});

// --- classifyError 仅诊断 stderr，不得把正常 stdout 设备列表误判为错误 ---

test("classifyError: still flags real adb stderr errors", () => {
  assert.ok(classifyError("adb: more than one device/emulator"));
  assert.ok(classifyError("error: device 'ABC' not found"));
  assert.ok(classifyError("error: device offline"));
  assert.ok(classifyError("adb.exe: device unauthorized."));
  assert.ok(classifyError("error: no devices/emulators found"));
});

test("classifyError: empty / benign text returns null", () => {
  assert.equal(classifyError(""), null);
  assert.equal(classifyError(null), null);
  assert.equal(classifyError("List of devices attached"), null);
});

// 回归（集成）：`adb devices` 退出码为 0、stdout 里含 unauthorized/offline 设备行。
// 修复前 finalize 把 stderr+stdout 一起喂给 classifyError，stdout 里的 "unauthorized"
// 触发 hint → r.ok=false → listDevices 丢掉整列设备返回空。
// 修复后只诊断 stderr，listDevices 应正常返回全部三个设备。
test("regression: listDevices keeps all devices even when one is unauthorized/offline", async () => {
  const devicesStdout =
    "List of devices attached\n" +
    "192.168.1.5:5555\tdevice\n" +
    "ABCD1234\tunauthorized\n" +
    "EFGH5678\toffline\n\n";
  __setSpawn(fakeSpawn({ stdout: devicesStdout, stderr: "", code: 0 }));
  try {
    const r = await listDevices();
    assert.equal(r.ok, true, "退出码 0 的 adb devices 不应被判失败");
    assert.deepEqual(r.devices, [
      { id: "192.168.1.5:5555", status: "device" },
      { id: "ABCD1234", status: "unauthorized" },
      { id: "EFGH5678", status: "offline" },
    ]);
  } finally {
    __setSpawn();
  }
});

test("listDevices exposes adb -l model details for friendly device selection", async () => {
  const calls = [];
  __setSpawn((command, args) => {
    calls.push({ command, args: [...args] });
    return fakeSpawn({
      stdout: "List of devices attached\n192.0.2.20:5555 device product:DHU041G model:P177_LE device:pikes_p177 transport_id:20\n",
    })();
  });
  try {
    const r = await listDevices();
    assert.equal(r.ok, true);
    assert.deepEqual(calls, [{ command: "adb", args: ["devices", "-l"] }]);
    assert.deepEqual(r.devices, [{
      id: "192.0.2.20:5555",
      status: "device",
      product: "DHU041G",
      model: "P177_LE",
      device: "pikes_p177",
      transport_id: "20",
    }]);
  } finally {
    __setSpawn();
  }
});

// 真实 stderr 错误仍要让命令判失败（确保修复没把诊断关掉）。
test("listDevices surfaces failure when adb errors on stderr", async () => {
  __setSpawn(
    fakeSpawn({ stdout: "", stderr: "adb: more than one device/emulator\n", code: 1 }),
  );
  try {
    const r = await listDevices();
    assert.equal(r.ok, false);
    assert.deepEqual(r.devices, []);
  } finally {
    __setSpawn();
  }
});
