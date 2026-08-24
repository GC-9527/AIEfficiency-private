import test from "node:test";
import assert from "node:assert/strict";

import { buildResourceWorkflow } from "./resourceWorkflowModel.mjs";

test("active full flow exposes two independent lanes and the exact current step", () => {
  const workflow = buildResourceWorkflow({
    active: true,
    run: {
      status: "running",
      options: { executeFlow: true },
      live: {
        phase: "collecting",
        currentStep: { sequence: 3, step: "scroll_detail", status: "progress", message: "下滑 2/20" },
        stepHistory: [
          { sequence: 1, step: "launch", status: "passed", message: "首页稳定" },
          { sequence: 2, step: "open_detail", status: "clicked", message: "应用 A" },
          { sequence: 3, step: "scroll_detail", status: "progress", message: "下滑 2/20" },
        ],
      },
    },
  });
  assert.equal(workflow.system.find((step) => step.key === "collecting").state, "running");
  assert.equal(workflow.script.find((step) => step.key === "launch").state, "success");
  assert.equal(workflow.script.find((step) => step.key === "scroll").state, "running");
  assert.equal(workflow.currentLabel, "下滑至详情底部");
  assert.equal(workflow.currentEvent.message, "下滑 2/20");
});

test("dynamic menu children come from the run config and keep clicked or skipped evidence", () => {
  const workflow = buildResourceWorkflow({
    active: true,
    run: {
      status: "running",
      configSnapshot: { flow: { secondary_menus: [{ label: "更新管理" }, { label: "隐私政策" }] } },
      live: {
        phase: "collecting",
        currentStep: { sequence: 3, step: "browse_menu", status: "skipped", message: "未找到白名单菜单：隐私政策" },
        stepHistory: [
          { sequence: 1, step: "browse_menu", status: "clicked", message: "更新管理" },
          { sequence: 2, step: "browse_menu", status: "skipped", message: "未找到白名单菜单：隐私政策" },
        ],
      },
    },
  });
  const menus = workflow.script.find((step) => step.key === "menus").children;
  assert.deepEqual(menus.map((menu) => [menu.label, menu.state]), [
    ["更新管理", "success"],
    ["隐私政策", "warning"],
  ]);
  assert.equal(workflow.currentLabel, "浏览二级菜单 · 隐私政策");
});

test("download failure remains visible while later My-page steps continue", () => {
  const workflow = buildResourceWorkflow({
    active: true,
    run: {
      status: "running",
      live: {
        phase: "collecting",
        currentStep: { sequence: 3, step: "open_my", status: "clicked", message: "我的" },
        stepHistory: [
          { sequence: 1, step: "download_install", status: "failed", message: "安装超时" },
          { sequence: 2, step: "return_home", status: "clicked", message: "首页" },
          { sequence: 3, step: "open_my", status: "clicked", message: "我的" },
        ],
      },
    },
  });
  assert.equal(workflow.script.find((step) => step.key === "install").state, "failed");
  assert.equal(workflow.script.find((step) => step.key === "mine").state, "success");
});

test("completed launch-only history skips the full-flow-only nodes", () => {
  const workflow = buildResourceWorkflow({
    active: false,
    run: { status: "completed", options: { executeFlow: false }, live: {} },
    detail: { profile: { flow: { mode: "launch-only", status: "completed" } }, flowEvents: [] },
  });
  assert.equal(workflow.script[0].state, "success");
  assert.ok(workflow.script.slice(1, -1).every((step) => step.state === "skipped"));
  assert.equal(workflow.script.at(-1).state, "success");
  assert.ok(workflow.system.every((step) => step.state === "success"));
});

test("historical artifact events rebuild the workflow after a reload", () => {
  const workflow = buildResourceWorkflow({
    active: false,
    run: { status: "completed" },
    detail: {
      flowEvents: [
        { sequence: 1, step: "launch", status: "passed", message: "首页稳定" },
        { sequence: 2, step: "open_detail", status: "clicked", message: "应用 A" },
        { sequence: 3, step: "flow", status: "partial", message: "模拟操作结束" },
      ],
    },
  });
  assert.equal(workflow.script[0].state, "success");
  assert.equal(workflow.script[1].state, "success");
  assert.equal(workflow.script.at(-1).state, "warning");
});

test("a selected script snapshot defines the only visible nodes and maps events strictly", () => {
  const workflow = buildResourceWorkflow({
    active: true,
    run: {
      status: "running",
      configSnapshot: {
        script: {
          id: "search-script",
          name: "搜索性能脚本",
          description: "搜索并打开结果",
          workflow: {
            steps: [
              { key: "search", label: "搜索应用", eventSteps: ["submit_search"] },
              { key: "result", label: "打开搜索结果", eventSteps: ["open_result"] },
            ],
          },
        },
      },
      live: {
        phase: "collecting",
        currentStep: { sequence: 3, step: "legacy_open_detail", status: "progress", message: "不属于该脚本" },
        stepHistory: [
          { sequence: 1, step: "submit_search", status: "passed", message: "关键词：音乐" },
          { sequence: 2, step: "open_result", status: "progress", message: "等待结果页" },
          { sequence: 3, step: "legacy_open_detail", status: "progress", message: "不属于该脚本" },
        ],
      },
    },
  });
  assert.deepEqual(workflow.script.map((step) => step.key), ["search", "result"]);
  assert.equal(workflow.script[0].state, "success");
  assert.equal(workflow.script[1].state, "running");
  assert.equal(workflow.currentLabel, "未映射：legacy_open_detail");
  assert.deepEqual(workflow.unmappedEvents.map((event) => event.step), ["legacy_open_detail"]);
  assert.equal(workflow.scriptMeta.name, "搜索性能脚本");
  assert.equal(workflow.scriptMeta.legacy, false);
});

test("workflow modes decide applicability without relying on fixed node indexes", () => {
  const workflow = buildResourceWorkflow({
    active: true,
    run: {
      status: "running",
      options: { executeFlow: false },
      configSnapshot: {
        script: {
          id: "mode-script",
          name: "分模式脚本",
          workflow: {
            steps: [
              { key: "prepare", label: "准备", eventSteps: ["prepare"] },
              { key: "full-only", label: "完整流程动作", eventSteps: ["full_action"], modes: ["full"] },
              { key: "finish", label: "结束", eventSteps: ["finish"], modes: ["full", "launch-only"] },
            ],
          },
        },
      },
      live: { phase: "collecting", stepHistory: [] },
    },
  });
  assert.deepEqual(workflow.script.map((step) => step.state), ["pending", "skipped", "pending"]);
  assert.equal(workflow.applicable, 2);
});

test("historical workflow comes from the frozen detail snapshot", () => {
  const workflow = buildResourceWorkflow({
    active: false,
    run: { status: "completed" },
    detail: {
      run: {
        configSnapshot: {
          script: {
            id: "history",
            name: "历史冻结脚本",
            workflow: { steps: [{ key: "history-step", label: "历史节点", eventSteps: ["history_event"] }] },
          },
        },
      },
      flowEvents: [{ sequence: 1, step: "history_event", status: "passed", message: "历史证据" }],
    },
  });
  assert.equal(workflow.scriptMeta.name, "历史冻结脚本");
  assert.deepEqual(workflow.script.map((step) => [step.key, step.state]), [["history-step", "success"]]);
});

test("catalog script is used only before a run snapshot is available", () => {
  const workflow = buildResourceWorkflow({
    active: true,
    fallbackScriptId: "catalog-script",
    scripts: [{
      id: "catalog-script",
      name: "待启动脚本",
      workflow: { steps: [{ key: "catalog", label: "目录节点", eventSteps: ["catalog_event"] }] },
    }],
    run: { status: "starting", options: { scriptId: "catalog-script" }, live: { phase: "starting" } },
  });
  assert.equal(workflow.scriptMeta.source, "catalog");
  assert.deepEqual(workflow.script.map((step) => step.key), ["catalog"]);
});
