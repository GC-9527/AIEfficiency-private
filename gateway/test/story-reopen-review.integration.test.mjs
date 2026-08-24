import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "story-reopen-review-integration-"));
process.env.NODE_ENV = "production";
process.env.GATEWAY_DB_PATH = path.join(tmp, "gateway.db");
process.env.GATEWAY_CONFIG_PATH = path.join(tmp, "gateway.json");
process.env.DEVBENCH_CONFIG_PATH = path.join(tmp, "market.json");
process.env.DEVBENCH_LOCAL_PROJECTS_PATH = path.join(tmp, "local", "devbench-projects.json");
process.env.DEVBENCH_STORE_DIR = path.join(tmp, "store");
process.env.AIEFFICIENCY_CLONE_PARENT = path.join(tmp, "clone-parent");
process.env.ROLE = "standalone";

const projectId = "project-story-reopen-gate";
fs.writeFileSync(process.env.GATEWAY_CONFIG_PATH, JSON.stringify({
  role: "standalone",
  storyPointAiInferenceEnabled: true,
  storyPointAiInferenceReviewTtlMs: 600000,
  servers: { nodeId: "story-reopen-gate-node", discovery: false, peers: [] },
  teambition: { projects: [{ id: projectId, name: "reopen gate" }] },
}), "utf8");
fs.writeFileSync(process.env.DEVBENCH_CONFIG_PATH, JSON.stringify({
  projects: [],
  projectDefs: [],
  byProject: { [projectId]: {} },
}), "utf8");

const express = (await import("express")).default;
const router = (await import("../routes/devbench.js")).default;
const store = await import("../services/devbench/store.js");
const { updateConfig } = await import("../services/config.js");
const { issueToken, revokeToken } = await import("../services/admin-auth.js");

const app = express();
app.use(express.json());
app.use("/api/devbench", router);
const server = await new Promise((resolve) => {
  const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
});
const base = `http://127.0.0.1:${server.address().port}/api/devbench`;
const ownerAToken = issueToken({ role: "viewer", name: "owner A", dingUserid: "owner-a" });
const ownerBToken = issueToken({ role: "viewer", name: "owner B", dingUserid: "owner-b" });

function headers(token) {
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function request(pathname, body, token = null) {
  const response = await fetch(`${base}${pathname}`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify(body || {}),
  });
  return { status: response.status, body: await response.json() };
}

function createClosedStory(title) {
  const created = store.createTab({ title });
  store.updateTab(created.id, {
    tbContext: { projectId, title, sourceCoverage: { manual: { available: true, complete: true } } },
  });
  const closed = store.deleteTab(created.id);
  assert.equal(closed.ok, true);
  return store.listClosedTabs().find((row) => row.id === created.id);
}

async function reviewedRun(story, token = ownerAToken, decision = "insufficient") {
  const run = await request("/ai-training/config-inference/run", {
    projectId,
    trigger: "story_reopened",
    storyEntry: { kind: "story_reopen", storyId: story.id },
    ticket: { projectId, title: story.title },
    captureSignals: false,
  }, token);
  assert.equal(run.status, 200, run.body.error);
  const reviewed = await request(
    `/ai-training/config-inference/runs/${encodeURIComponent(run.body.data.id)}/review`,
    { projectId, decision, rating: 1, apply: false, reason: "人工确认后继续" },
    token,
  );
  assert.equal(reviewed.status, 200, reviewed.body.error);
  return run.body.data.id;
}

test.after(async () => {
  revokeToken(ownerAToken);
  revokeToken(ownerBToken);
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  try {
    const { default: db } = await import("../db/sqlite.js");
    if (db?.open) db.close();
  } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

test("production：重新打开不再强制 AI 推理复核（直开）；携带复核 runId 时仍校验同故事同 owner/未过期", async () => {
  const storyA = createClosedStory("重开门禁 A");
  const storyB = createClosedStory("重开门禁 B");

  // 体验优化：AI 推理开启时，重新打开已关闭故事点不弹推理窗、直接恢复（无需 runId）。
  const directStory = createClosedStory("直开不弹推理窗");
  const direct = await request("/tabs/reopen-closed", { id: directStory.id }, ownerAToken);
  assert.equal(direct.status, 200, direct.body.error);
  assert.equal(direct.body.data.id, directStory.id);
  assert.equal(direct.body.configInferenceRunId, undefined, "直开不应走推理复核");

  const unreviewed = await request("/ai-training/config-inference/run", {
    projectId,
    trigger: "story_reopened",
    storyEntry: { storyIds: [{ id: storyB.id }] },
    ticket: { projectId, title: storyB.title },
    captureSignals: false,
  }, ownerAToken);
  assert.equal(unreviewed.status, 200, unreviewed.body.error);
  const beforeReview = await request("/tabs/reopen-closed", {
    id: storyB.id,
    projectId,
    configInferenceRunId: unreviewed.body.data.id,
  }, ownerAToken);
  assert.equal(beforeReview.status, 409);
  assert.equal(beforeReview.body.code, "STORY_REOPEN_AI_REVIEW_REQUIRED");

  const runId = await reviewedRun(storyA, ownerAToken, "insufficient");
  const crossStory = await request("/tabs/reopen-closed", {
    id: storyB.id,
    projectId,
    configInferenceRunId: runId,
  }, ownerAToken);
  assert.equal(crossStory.status, 409);
  assert.equal(crossStory.body.code, "STORY_REOPEN_AI_REVIEW_SCOPE_MISMATCH");

  const crossOwner = await request("/tabs/reopen-closed", {
    id: storyA.id,
    projectId,
    configInferenceRunId: runId,
  }, ownerBToken);
  assert.equal(crossOwner.status, 403);
  assert.equal(crossOwner.body.code, "STORY_REOPEN_AI_REVIEW_OWNER_MISMATCH");

  const allowed = await request("/tabs/reopen-closed", {
    id: storyA.id,
    projectId,
    configInferenceRunId: runId,
  }, ownerAToken);
  assert.equal(allowed.status, 200, allowed.body.error);
  assert.equal(allowed.body.data.id, storyA.id);
  assert.equal(allowed.body.reviewDecision, "insufficient");

  const replay = await request("/tabs/reopen-closed", {
    id: storyA.id,
    projectId,
    configInferenceRunId: runId,
  }, ownerAToken);
  assert.equal(replay.status, 200, replay.body.error);
  assert.equal(replay.body.idempotent, true);
  assert.equal(replay.body.data.id, storyA.id);

  const expiringStory = createClosedStory("重开门禁过期");
  const expiringRunId = await reviewedRun(expiringStory);
  updateConfig({ storyPointAiInferenceReviewTtlMs: 1 });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const expired = await request("/tabs/reopen-closed", {
    id: expiringStory.id,
    projectId,
    configInferenceRunId: expiringRunId,
  }, ownerAToken);
  assert.equal(expired.status, 409);
  assert.equal(expired.body.code, "STORY_REOPEN_AI_REVIEW_EXPIRED");

  updateConfig({
    storyPointAiInferenceEnabled: false,
    storyPointAiInferenceReviewTtlMs: 600000,
  });
  const compatibleStory = createClosedStory("AI 关闭兼容直开");
  const compatible = await request("/tabs/reopen-closed", { id: compatibleStory.id }, ownerAToken);
  assert.equal(compatible.status, 200, compatible.body.error);
  assert.equal(compatible.body.data.id, compatibleStory.id);
});
