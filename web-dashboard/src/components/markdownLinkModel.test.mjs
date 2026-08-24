import { test } from "node:test";
import assert from "node:assert/strict";
import { isMailtoHref } from "./markdownLinkModel.mjs";

test("mailto 链接判定：标准邮箱 autolink 命中", () => {
  assert.equal(isMailtoHref("mailto:reviewer@example.com"), true);
  assert.equal(isMailtoHref("MAILTO:pengjunweiAI@corp.com"), true);
});

test("mailto 链接判定：任何 mailto: 前缀都命中（降级宽松，防打开优先）", () => {
  // 与 external-url.js 的“能否打开”校验（mailto 必须有收件人）不同：
  // 这里是“是否降级为纯文本”的判定，只要有 mailto: 协议前缀就应命中，避免任何唤起邮件客户端的可能。
  assert.equal(isMailtoHref("mailto:"), true);
  assert.equal(isMailtoHref("mailto:  "), true);
});

test("mailto 链接判定：http/https/相对路径/空值均不命中", () => {
  assert.equal(isMailtoHref("https://example.com/a"), false);
  assert.equal(isMailtoHref("/api/devbench/tabs/1/artifact"), false);
  assert.equal(isMailtoHref("storydev:/logs/x.txt"), false);
  assert.equal(isMailtoHref(""), false);
  assert.equal(isMailtoHref(undefined), false);
  assert.equal(isMailtoHref(null), false);
});

test("mailto 链接判定：文本不是 mailto 前缀即使含 @ 也不命中", () => {
  assert.equal(isMailtoHref("foo@example.com"), false);
  assert.equal(isMailtoHref("git@codeup.aliyun.com:x/repo.git"), false);
});
