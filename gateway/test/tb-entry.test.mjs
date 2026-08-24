import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildTbTaskEntryPayload,
  parseTbTaskEntryInput,
} from "../services/devbench/tb-entry.js";

test("TB 建单输入支持 CARB 单号、纯数字和完整任务链接", () => {
  assert.deepEqual(parseTbTaskEntryInput("carb-13542"), {
    ok: true,
    kind: "number",
    lookup: "CARB-13542",
    display: "CARB-13542",
  });
  assert.equal(parseTbTaskEntryInput("13542").lookup, "CARB-13542");

  const parsed = parseTbTaskEntryInput("https://www.teambition.com/task/6a47ab5f34526c55d0b7224f?from=copy");
  assert.equal(parsed.ok, true);
  assert.equal(parsed.kind, "link");
  assert.equal(parsed.taskId, "6a47ab5f34526c55d0b7224f");
  assert.equal(parsed.lookup, "https://www.teambition.com/task/6a47ab5f34526c55d0b7224f");
});

test("TB 建单输入拒绝空值、伪造域名和非任务链接", () => {
  assert.equal(parseTbTaskEntryInput("").code, "TB_INPUT_REQUIRED");
  assert.equal(parseTbTaskEntryInput("CARB-abc").code, "TB_INPUT_INVALID");
  assert.equal(
    parseTbTaskEntryInput("https://teambition.com.evil.example/task/6a47ab5f34526c55d0b7224f").code,
    "TB_INPUT_INVALID",
  );
  assert.equal(
    parseTbTaskEntryInput("https://www.teambition.com/project/6a47ab5f34526c55d0b7224f").code,
    "TB_INPUT_INVALID",
  );
});

test("TB 详情映射保留故事点和待办所需的单号、项目、迭代与期限", () => {
  const payload = buildTbTaskEntryPayload(
    {
      tbTaskId: "6a47ab5f34526c55d0b7224f",
      ticketUrl: "https://www.teambition.com/task/6a47ab5f34526c55d0b7224f",
    },
    {
      uniqueId: 13542,
      content: "【应用市场】新增 TB 建单入口",
      project: { _id: "project-1", name: "平台组件" },
      tasklist: { _id: "list-1", title: "应用市场" },
      sprint: { _id: "sprint-1", name: "0723 版本", dueDate: "2026-07-30T00:00:00.000Z", status: "active" },
      taskflowstatus: { name: "待处理" },
      priority: 2,
      dueDate: "2026-07-29T00:00:00.000Z",
    },
  );

  assert.equal(payload.carbId, "CARB-13542");
  assert.equal(payload.title, "【应用市场】新增 TB 建单入口");
  assert.equal(payload.projectId, "project-1");
  assert.equal(payload.tasklistName, "应用市场");
  assert.equal(payload.sprintName, "0723 版本");
  assert.equal(payload.sprintDueDate, "2026-07-30");
  assert.equal(payload.deadline, "2026-07-29");
  assert.equal(payload.statusName, "待处理");
  assert.equal(payload.priority, 2);
});
