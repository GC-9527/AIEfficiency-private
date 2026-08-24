import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "story-create-ai-async-"));
process.env.NODE_ENV = "production";
process.env.GATEWAY_DB_PATH = path.join(tmp, "gateway.db");
process.env.GATEWAY_CONFIG_PATH = path.join(tmp, "gateway.json");
process.env.DEVBENCH_CONFIG_PATH = path.join(tmp, "market.json");
process.env.DEVBENCH_LOCAL_PROJECTS_PATH = path.join(tmp, "local-projects.json");
process.env.DEVBENCH_STORE_DIR = path.join(tmp, "store");
process.env.AIEFFICIENCY_CLONE_PARENT = path.join(tmp, "clone-parent");
process.env.ROLE = "standalone";

fs.writeFileSync(process.env.GATEWAY_CONFIG_PATH, JSON.stringify({
  role: "standalone",
  storyPointAiInferenceEnabled: true,
  servers: { nodeId: "story-create-ai-async", discovery: false, peers: [] },
}), "utf8");
fs.writeFileSync(process.env.DEVBENCH_CONFIG_PATH, JSON.stringify({ projects: [], projectDefs: [] }), "utf8");
fs.writeFileSync(process.env.DEVBENCH_LOCAL_PROJECTS_PATH, JSON.stringify({ version: 2, projects: [] }), "utf8");

const express = (await import("express")).default;
const router = (await import("../routes/devbench.js")).default;
const { issueToken, revokeToken } = await import("../services/admin-auth.js");
const { updateConfig } = await import("../services/config.js");

const app = express();
app.use(express.json());
app.use("/api/devbench", router);
const server = await new Promise((resolve) => {
  const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
});
const base = `http://127.0.0.1:${server.address().port}/api/devbench`;
const token = issueToken({ role: "viewer", name: "async owner", dingUserid: "async-owner" });

async function request(pathname, body) {
  const response = await fetch(`${base}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body || {}),
  });
  return { status: response.status, body: await response.json() };
}

test.after(async () => {
  revokeToken(token);
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  try {
    const { default: db } = await import("../db/sqlite.js");
    if (db?.open) db.close();
  } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

test("AI 开启且没有复核 run 时，人工初始化确认与最终创建不被 AI 阻塞", { timeout: 20_000 }, async () => {
  const title = `AI 异步人工创建-${Date.now()}`;
  const prepared = await request("/story-initializations", {
    title,
    sourceLabel: "当前草稿人工确认",
    entry: { kind: "blank_story", title },
    configuration: { mode: "blank" },
  });
  assert.equal(prepared.status, 201, prepared.body.error);
  assert.ok(prepared.body.data.id);

  const created = await request("/tabs", { initializationIntentId: prepared.body.data.id });
  assert.equal(created.status, 200, created.body.error);
  assert.equal(created.body.data.title, title);
  assert.equal(created.body.data.configInferenceRunId || null, null);
});

test("AI 非阻塞不放宽最终初始化确认，直接创建仍失败关闭", { timeout: 20_000 }, async () => {
  const direct = await request("/tabs", { title: `绕过初始化-${Date.now()}` });
  assert.equal(direct.status, 409);
  assert.equal(direct.body.code, "STORY_INITIALIZATION_CONFIRMATION_REQUIRED");
});

test("客户端显式声称采用不存在的 AI run 时，无论 AI 开关状态都拒绝伪造审计", { timeout: 20_000 }, async () => {
  for (const enabled of [true, false]) {
    updateConfig({ storyPointAiInferenceEnabled: enabled });
    const invalid = await request("/story-initializations", {
      title: `伪造 AI run-${enabled}-${Date.now()}`,
      sourceLabel: "显式 AI run",
      entry: { kind: "blank_story" },
      configuration: { mode: "blank" },
      configInference: { projectId: "missing-project", runId: "missing-run" },
    });
    assert.equal(invalid.status, 409, `AI enabled=${enabled}`);
    assert.equal(invalid.body.code, "STORY_CREATE_AI_REVIEW_REQUIRED");
  }
  updateConfig({ storyPointAiInferenceEnabled: true });
});
