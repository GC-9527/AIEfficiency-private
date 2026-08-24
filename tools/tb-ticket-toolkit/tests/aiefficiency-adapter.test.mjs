import assert from "node:assert/strict";
import test from "node:test";

import { createAiefficiencyAdapter } from "../adapters/aiefficiency/src/index.js";

test("off 模式只有 legacy 读写且不访问 canonical application", async () => {
  const calls = [];
  const adapter = createAiefficiencyAdapter({
    mode: "off",
    application: { async readContext() { calls.push("canonical-read"); } },
    legacyReader: async () => ({ comments: [1], attachments: [] }),
    legacyWriter: async () => { calls.push("legacy-write"); return { ok: true }; },
  });
  const read = await adapter.read("CARB-1");
  await adapter.update({ value: 1 });
  assert.equal(read.source, "legacy");
  assert.deepEqual(calls, ["legacy-write"]);
});

test("shadow 模式比对 canonical 读取但一次更新仍只调用 legacy writer", async () => {
  const calls = [];
  const adapter = createAiefficiencyAdapter({
    mode: "shadow",
    application: {
      async readContext() {
        calls.push("canonical-read");
        return { context: { comments: [1, 2], attachments: [1], contextDigest: "digest" }, snapshot: {} };
      },
      async updateApply() { calls.push("canonical-write"); },
    },
    legacyReader: async () => ({ comments: [1, 2], attachments: [1] }),
    legacyWriter: async () => { calls.push("legacy-write"); return { ok: true }; },
  });
  const read = await adapter.read("CARB-1");
  await adapter.update({ value: 1 });
  assert.equal(read.shadow.ok, true);
  assert.equal(read.shadow.matched, true);
  assert.deepEqual(calls, ["canonical-read", "legacy-write"]);
});

test("canonical 模式只调用统一 application 且不触发 legacy writer", async () => {
  const calls = [];
  const adapter = createAiefficiencyAdapter({
    mode: "canonical",
    application: {
      async readContext() { calls.push("canonical-read"); return { context: {} }; },
      async updateApply(input) { calls.push(["canonical-write", input]); return { state: "COMPLETED" }; },
    },
    legacyReader: async () => { calls.push("legacy-read"); },
    legacyWriter: async () => { calls.push("legacy-write"); },
  });
  await adapter.read("CARB-1");
  await adapter.update({ plan: { planId: "plan", apply: true } });
  assert.deepEqual(calls, ["canonical-read", ["canonical-write", { planId: "plan", apply: true }]]);
});

