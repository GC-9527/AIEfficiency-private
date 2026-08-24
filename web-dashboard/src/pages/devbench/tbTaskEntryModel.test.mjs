import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTbTaskInput } from "./tbTaskEntryModel.mjs";

test("TB 输入模型规范化单号和任务链接", () => {
  assert.deepEqual(parseTbTaskInput("carb-13542"), {
    ok: true,
    kind: "number",
    normalized: "CARB-13542",
    preview: "CARB-13542",
  });
  assert.equal(parseTbTaskInput("13542").normalized, "CARB-13542");
  assert.equal(
    parseTbTaskInput("https://www.teambition.com/task/6a47ab5f34526c55d0b7224f?from=copy").normalized,
    "https://www.teambition.com/task/6a47ab5f34526c55d0b7224f",
  );
});

test("TB 输入模型提供可操作的错误提示", () => {
  assert.match(parseTbTaskInput("").error, /请输入/);
  assert.match(parseTbTaskInput("CARB-ABC").error, /格式不正确/);
  assert.match(
    parseTbTaskInput("https://teambition.com.evil.example/task/6a47ab5f34526c55d0b7224f").error,
    /格式不正确/,
  );
});
