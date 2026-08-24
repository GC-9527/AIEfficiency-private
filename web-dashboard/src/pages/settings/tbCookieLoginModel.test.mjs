import assert from "node:assert/strict";
import test from "node:test";

import {
  formatTbCheckedAt,
  isTbLoginActive,
  isTbLoginTerminal,
  normalizeTbCookieHealth,
  normalizeTbLoginState,
  tbCookiePresentation,
} from "./tbCookieLoginModel.mjs";

test("Cookie 检测结果明确区分有效、过期和服务不可用", () => {
  const valid = normalizeTbCookieHealth({ valid: true, code: "COOKIE_VALID", user: "小明" });
  assert.equal(valid.status, "valid");
  assert.equal(tbCookiePresentation(valid).hint, "当前账号：小明");

  const expired = normalizeTbCookieHealth({ valid: false, code: "COOKIE_EXPIRED", reason: "登录已过期" });
  assert.equal(expired.status, "expired");
  assert.equal(tbCookiePresentation(expired).label, "已过期");

  const unavailable = normalizeTbCookieHealth({ valid: false, code: "TB_UNAVAILABLE" });
  assert.equal(unavailable.status, "unavailable");
  assert.match(tbCookiePresentation(unavailable).hint, /未被清除/);
});

test("登录状态把验证阶段视为进行中，并识别所有终态", () => {
  assert.equal(isTbLoginActive(normalizeTbLoginState({ status: "verifying" })), true);
  assert.equal(isTbLoginActive({ status: "success" }), false);
  for (const status of ["success", "failed", "timeout", "cancelled"]) {
    assert.equal(isTbLoginTerminal({ status }), true, status);
  }
});

test("检查时间仅格式化合法时间", () => {
  assert.equal(formatTbCheckedAt("not-a-date"), "");
  assert.match(formatTbCheckedAt("2026-08-03T08:15:00.000Z", "zh-CN"), /08.*03/);
});
