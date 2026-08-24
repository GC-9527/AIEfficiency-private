import assert from "node:assert/strict";
import test from "node:test";

import { storyTicketIdentities } from "../services/devbench/story-ticket-identity.js";

test("显式任意 URL 生成稳定且不泄露原文的故事点身份", () => {
  const first = storyTicketIdentities({
    ticketUrl: "HTTPS://Example.Invalid:443/devbench-ticket-race#panel",
    inputProvided: true,
    ticketBound: true,
  });
  const second = storyTicketIdentities({
    ticketUrl: "https://example.invalid/devbench-ticket-race",
    inputProvided: true,
    ticketBound: true,
  });

  assert.deepEqual(first, second);
  assert.equal(first.length, 1);
  assert.match(first[0], /^url:[0-9a-f]{64}$/);
  assert.equal(first[0].includes("example.invalid"), false);
});

test("仅用于命名的标题 CARB 不形成故事点绑定身份", () => {
  assert.deepEqual(storyTicketIdentities({
    ticketId: "CARB-12002",
    inputProvided: false,
    ticketBound: false,
  }), []);

  const firstUrl = storyTicketIdentities({
    ticketUrl: "https://example.invalid/first-ticket",
    ticketId: "CARB-12002",
    inputProvided: true,
    ticketBound: true,
  });
  const secondUrl = storyTicketIdentities({
    ticketUrl: "https://example.invalid/second-ticket",
    ticketId: "CARB-12002",
    inputProvided: true,
    ticketBound: true,
  });
  assert.match(firstUrl[0], /^url:[0-9a-f]{64}$/);
  assert.notDeepEqual(firstUrl, secondUrl, "标题命名号不能让两个不同的显式 URL 冲突");
  assert.deepEqual(storyTicketIdentities({
    ticketId: "CARB-12002",
    inputProvided: true,
    ticketBound: true,
  }), ["carb:CARB-12002"]);
});
