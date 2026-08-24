import test from "node:test";
import assert from "node:assert/strict";

import {
  chooseResourceScriptId,
  effectiveResourceRunForm,
  groupResourceScripts,
  normalizeResourceScripts,
  parseResourceScriptsJson,
  resourceScriptAvailability,
  resolveResourceScript,
} from "./resourceScriptModel.mjs";

const catalog = [
  {
    id: "full-market",
    name: "应用市场完整流程",
    category: "应用市场 / 综合",
    enabled: true,
    runner: "appmarket",
    workflow: { steps: [{ key: "launch", label: "启动", eventSteps: ["launch"] }] },
    run: { duration: 180 },
  },
  { id: "disabled", name: "已停用", enabled: false, workflow: [] },
];

test("normalizes catalog and chooses only a runnable task script", () => {
  const scripts = normalizeResourceScripts(catalog);
  assert.equal(scripts[0].category, "应用市场 / 综合");
  assert.equal(scripts[0].workflow.steps[0].key, "launch");
  assert.equal(scripts[1].workflow.steps.length, 0);
  assert.equal(chooseResourceScriptId(scripts, "disabled", "full-market"), "full-market");
});

test("groups the script library and explains why a task cannot run", () => {
  const scripts = normalizeResourceScripts([
    ...catalog,
    {
      id: "missing-entry",
      name: "入口缺失",
      category: { name: "应用市场 / 专项" },
      runner: "",
      workflow: { steps: [{ key: "launch" }] },
    },
    {
      id: "invalid-entry",
      name: "入口校验失败",
      group: "应用市场 / 专项",
      runner: "features/PerformanceFeature/tasks/invalid.py",
      available: false,
      availabilityReason: "入口文件不存在",
      workflow: { steps: [{ key: "launch" }] },
    },
  ]);

  const groups = groupResourceScripts(scripts);
  assert.deepEqual(groups.map((group) => group.category), ["应用市场 / 综合", "未分类", "应用市场 / 专项"]);
  assert.equal(resourceScriptAvailability(scripts[1]).code, "disabled");
  assert.equal(resourceScriptAvailability(scripts[2]).code, "missing-runner");
  assert.deepEqual(resourceScriptAvailability(scripts[3]), {
    code: "unavailable",
    label: "入口不可用",
    reason: "入口文件不存在",
    selectable: false,
  });
  assert.equal(chooseResourceScriptId(scripts, "invalid-entry", "missing-entry"), "full-market");
});

test("a frozen run snapshot wins over the mutable catalog", () => {
  const script = resolveResourceScript({
    scripts: catalog,
    run: {
      options: { scriptId: "full-market" },
      configSnapshot: {
        script: {
          id: "full-market",
          name: "采集时冻结名称",
          workflow: { steps: [{ key: "frozen", label: "冻结步骤", eventSteps: ["frozen_event"] }] },
          ui: { schemaVersion: 1, defaultView: "frozen-report", views: [{ id: "frozen-report", kind: "report", label: "冻结报表" }] },
        },
      },
    },
  });
  assert.equal(script.source, "snapshot");
  assert.equal(script.name, "采集时冻结名称");
  assert.equal(script.workflow.steps[0].key, "frozen");
  assert.equal(script.ui.defaultView, "frozen-report");
});

test("historical detail restores its script snapshot instead of the next-run selection", () => {
  const script = resolveResourceScript({
    scripts: catalog,
    fallbackScriptId: "full-market",
    detail: {
      run: {
        script: {
          id: "history-script",
          name: "历史脚本",
          workflow: { steps: [{ key: "history", label: "历史步骤", eventSteps: ["history"] }] },
        },
      },
    },
  });
  assert.equal(script.id, "history-script");
  assert.equal(script.source, "snapshot");
});

test("script run overrides are applied to the next-run form without mutating the base", () => {
  const base = { duration: 180, interval: 5, package: "com.appmarket.automotive" };
  const result = effectiveResourceRunForm(base, { run: { duration: 60, executeFlow: false } });
  assert.deepEqual(result, {
    duration: 60,
    interval: 5,
    package: "com.appmarket.automotive",
    executeFlow: false,
  });
  assert.equal(base.duration, 180);
});

test("scripts JSON rejects duplicate or missing ids", () => {
  assert.throws(() => parseResourceScriptsJson('[{"id":"same"},{"id":"same"}]'), /唯一/);
  assert.throws(() => parseResourceScriptsJson('{}'), /JSON 数组/);
});
