import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dispatcher-"));
process.env.GATEWAY_DB_PATH = path.join(tmp, "data.db");
process.env.GATEWAY_CONFIG_PATH = path.join(tmp, "gateway.json");
process.env.NODE_ENV = "test";
fs.writeFileSync(process.env.GATEWAY_CONFIG_PATH, JSON.stringify({
  defaultEngine: "claude",
  codexEnabled: false,
  hermesEnabled: true,
  autoFallback: true,
}));

let dispatch;
before(async () => {
  ({ dispatch } = await import("../services/dispatcher.js"));
});

test("禁止回退的故事点任务保持显式选择的 Codex", () => {
  const result = dispatch({
    id: "story-codex",
    type: "general",
    explicitEngine: "codex",
    allowEngineFallback: false,
  });

  assert.equal(result.engine, "codex");
});

test("普通任务仍可把未启用的显式引擎回退到默认引擎", () => {
  const result = dispatch({
    id: "general-codex",
    type: "general",
    explicitEngine: "codex",
  });

  assert.equal(result.engine, "claude");
});

test("已启用的本地 Hermes 可作为显式任务引擎", () => {
  const result = dispatch({
    id: "general-hermes",
    type: "general",
    explicitEngine: "hermes",
  });

  assert.equal(result.engine, "hermes");
});
