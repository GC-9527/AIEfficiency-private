import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultCustomSummaryRange,
  summaryRequestErrorMessage,
} from "./summaryRangeModel.js";

test("自定义总结默认范围是本地当前日期前 7 天到当前日期", () => {
  assert.deepEqual(
    defaultCustomSummaryRange(new Date(2026, 6, 27, 0, 5, 0)),
    { since: "2026-07-20", until: "2026-07-27" },
  );
});

test("自定义总结默认范围可正确跨月、跨年", () => {
  assert.deepEqual(
    defaultCustomSummaryRange(new Date(2026, 0, 3, 23, 30, 0)),
    { since: "2025-12-27", until: "2026-01-03" },
  );
});

test("旧 Gateway 的 period 错误会提示用户重启", () => {
  assert.equal(
    summaryRequestErrorMessage("period 不正确"),
    "period 不正确；当前 Gateway 进程仍是旧版本，请重启 Gateway 后再生成自定义总结",
  );
  assert.equal(summaryRequestErrorMessage("网络错误"), "网络错误");
});

