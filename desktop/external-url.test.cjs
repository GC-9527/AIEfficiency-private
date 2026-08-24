"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { normalizeExternalUrl } = require("./external-url.js");

test("external URL normalization only accepts canonical web links; mailto is rejected", () => {
  assert.equal(normalizeExternalUrl("https://example.com/review?id=1"), "https://example.com/review?id=1");
  assert.equal(normalizeExternalUrl("http://example.com"), "http://example.com/");
  // mailto 一律拒绝：内部工具禁止唤起系统邮箱客户端（“一直打开邮箱”）
  assert.equal(normalizeExternalUrl("mailto:reviewer@example.com"), "");

  for (const unsafe of [
    "https:\\..\\..\\secret.txt",
    "https:C:\\secret.txt",
    "http:\\D:\\secret.txt",
    "http:javascript:alert(1)",
    "javascript:alert(1)",
    "data:text/html,pwned",
    "file:///D:/secret.txt",
    "D:\\workspace\\secret.txt",
    "/local/absolute/path",
    "mailto:C:\\secret.txt",
  ]) {
    assert.equal(normalizeExternalUrl(unsafe), "", unsafe);
  }
});
