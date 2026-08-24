import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "perf-resource-db-"));
process.env.GATEWAY_DB_PATH = path.join(tmp, "gateway.db");

let sqlite;

before(async () => {
  sqlite = await import("../db/sqlite.js");
});

after(() => {
  try { sqlite?.default?.close(); } catch {}
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function insertResourceRun(id, flavor, script) {
  sqlite.insertPerfSession({
    id,
    scenario: "resource_profile",
    flavor,
    appVersion: "1.2.3",
    appVersionCode: 123,
    deviceModel: "MockCar",
    deviceBrand: "Test",
    deviceId: "mock-serial",
    round: "resource_script_test",
    rawJson: JSON.stringify({
      resourceProfile: {
        acceptance: "PASS",
        script,
      },
      resourceSamples: [],
    }),
  });
}

test("resource history and detail expose only the bounded performance script projection", () => {
  insertResourceRun("resource-script-valid", "script-valid", {
    id: "appmarket-default",
    name: "应用市场完整性能测试",
    description: "启动并遍历应用市场，同时采集 CPU 与内存。",
    runner: "features/PerformanceFeature/step20260714/docs/appmarket_perf_runner.py",
    workflow: {
      steps: [
        {
          key: "launch",
          label: "启动并等待首页",
          eventSteps: ["launch", "select_home"],
          modes: ["full", "launch-only"],
          selectors: { password: "must-not-leak" },
        },
        {
          key: "detail",
          label: "进入应用详情",
          eventSteps: ["open_detail"],
          modes: ["full"],
        },
      ],
      private: { token: "must-not-leak" },
    },
    flow: { token: "must-not-leak" },
  });

  const expected = {
    id: "appmarket-default",
    name: "应用市场完整性能测试",
    description: "启动并遍历应用市场，同时采集 CPU 与内存。",
    runner: "features/PerformanceFeature/step20260714/docs/appmarket_perf_runner.py",
    workflow: {
      steps: [
        {
          key: "launch",
          label: "启动并等待首页",
          eventSteps: ["launch", "select_home"],
          modes: ["full", "launch-only"],
        },
        {
          key: "detail",
          label: "进入应用详情",
          eventSteps: ["open_detail"],
          modes: ["full"],
        },
      ],
    },
  };
  const history = sqlite.listPerfResourceRuns({ flavor: "script-valid", limit: 10 });
  assert.equal(history.length, 1);
  assert.deepEqual(history[0].script, expected);
  assert.equal(JSON.stringify(history[0]).includes("must-not-leak"), false);

  const detail = sqlite.getPerfResourceRun("resource-script-valid");
  assert.deepEqual(detail.run.script, expected);
  assert.deepEqual(detail.profile.script, expected);
  assert.equal(JSON.stringify(detail).includes("must-not-leak"), false);
});

test("resource history drops a forged or structurally ambiguous script", () => {
  insertResourceRun("resource-script-forged", "script-forged", {
    id: "forged-script",
    name: "伪造脚本",
    description: "",
    runner: "features/PerformanceFeature/../../secrets.py",
    workflow: {
      steps: [
        { key: "one", label: "一", eventSteps: ["same"] },
        { key: "two", label: "二", eventSteps: ["same"] },
      ],
    },
  });

  const history = sqlite.listPerfResourceRuns({ flavor: "script-forged", limit: 10 });
  assert.equal(history.length, 1);
  assert.equal(history[0].script, null);
  const detail = sqlite.getPerfResourceRun("resource-script-forged");
  assert.equal(detail.run.script, null);
  assert.equal(Object.hasOwn(detail.profile, "script"), false);
});
