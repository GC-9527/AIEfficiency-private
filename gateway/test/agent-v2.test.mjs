import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import express from "express";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-v2-"));
process.env.GATEWAY_CONFIG_PATH = path.join(tmp, "gateway-config.json");
process.env.GATEWAY_DB_PATH = path.join(tmp, "gateway.db");
process.env.DEVBENCH_LOCAL_PROJECTS_PATH = path.join(tmp, "devbench-projects.json");
process.env.DEVBENCH_STORE_DIR = path.join(tmp, "devbench-store");
process.env.AIEFFICIENCY_CLONE_PARENT = path.join(tmp, "clone-parent");
fs.writeFileSync(process.env.GATEWAY_CONFIG_PATH, JSON.stringify({
  claudeProxy: { enabled: true },
  distributedExecution: { enabled: true, protocol: "v2", maxRounds: 5, commandPolicy: "workspace" },
}), "utf8");

let sessions;
let protocol;

before(async () => {
  sessions = await import("../services/agent-session.js");
  protocol = await import("../services/agent-protocol.js");
});

after(async () => {
  try {
    const { closeAppMarketMcpBridge } = await import("../services/appmarket-admin-mcp.js");
    await closeAppMarketMcpBridge();
  } catch {}
  try {
    const { default: db } = await import("../db/sqlite.js");
    db.close();
  } catch {}
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("Agent V2 session emits tool_call, accepts client tool result, then final", async () => {
  sessions.clearAgentSessionsForTest();
  const prompts = [];
  let calls = 0;
  const callBrain = async (prompt) => {
    prompts.push(prompt);
    calls++;
    if (calls === 1) {
      return { text: JSON.stringify({ tool_calls: [{ name: "read_file", arguments: { path: "src/app.js" }, thought: "inspect file" }] }) };
    }
    return { text: JSON.stringify({ tool: "final", summary: "read completed" }), usage: { inputTokens: 1, outputTokens: 2 } };
  };
  const session = sessions.createAgentSession({
    workspace: {
      roots: [{ id: "main", name: "project", kind: "main" }],
      rules: [{ rootId: "main", file: "AGENTS.md", content: "Follow AGENTS instructions." }],
      capabilities: {
        protocolFeatures: { clientDrivenTools: true, reverseExecutorRequired: false, artifactUpload: true, interrupts: true, subagents: true },
        toolRegistry: { count: 1, tools: ["read_file"], commandPolicy: "workspace", workspaceIsolation: true },
        skills: { available: true, count: 1, summary: "- /acceptance-report: build the verification report" },
        mcp: { available: true, totalServers: 1, providers: [{ provider: "codex", configured: true, serverCount: 1, servers: ["local-docs"], redacted: true }] },
      },
    },
    toolManifest: [{ name: "read_file", description: "read", parameters: { type: "object", properties: { path: { type: "string" } } } }],
  }, { callBrain });

  await sessions.startAgentTurn(session.id, { content: "read src/app.js" });
  assert.match(prompts[0], /Follow AGENTS instructions/);
  assert.match(prompts[0], /client capability declarations/);
  assert.match(prompts[0], /acceptance-report/);
  assert.match(prompts[0], /local-docs/);
  assert.equal(session.status, "waiting_tool");
  assert.equal(session.pendingToolCall.name, "read_file");
  assert.equal(session.pendingToolCall.arguments.path, "src/app.js");
  const callId = session.pendingToolCall.callId;

  await sessions.submitAgentToolResults(session.id, {
    callId,
    ok: true,
    exitCode: 0,
    result: "1 | console.log('ok')",
    truncated: true,
    nextCursor: 123,
  });

  assert.equal(session.status, "completed");
  assert.equal(session.history.length, 1);
  assert.match(prompts[1], /console\.log/);
  assert.match(prompts[1], /exitCode: 0/);
  assert.match(prompts[1], /truncated: true; nextCursor: 123/);
  const final = sessions.listAgentEvents(session.id).find((event) => event.type === "final");
  assert.equal(final.data.summary, "read completed");
  const usage = sessions.listAgentEvents(session.id).find((event) => event.type === "usage");
  assert.equal(usage.data.usage.outputTokens, 2);

  await sessions.submitAgentToolResults(session.id, { callId, ok: true, result: "duplicate" });
  assert.equal(calls, 2);
  assert.equal(session.history.length, 1);

  const same = sessions.createAgentSession({ id: session.id, toolManifest: session.toolManifest }, { callBrain });
  assert.equal(same.id, session.id);
  await sessions.startAgentTurn(session.id, { content: "follow up" });
  assert.equal(session.status, "completed");
  assert.equal(calls, 3);
});

test("Agent V2 parser maps legacy run_bash to run_command when manifest declares run_command", () => {
  const parsed = protocol.parseAgentResponse(
    '{"tool":"run_bash","command":"npm test","thought":"verify"}',
    [{ name: "run_command", parameters: { type: "object", properties: { command: { type: "string" } } } }],
  );
  assert.equal(parsed.type, "tool_call");
  assert.equal(parsed.name, "run_command");
  assert.equal(parsed.arguments.command, "npm test");
});

test("Agent V2 request signatures use canonical JSON and timestamp windows", () => {
  const timestamp = Date.now();
  const bodyA = { b: 2, a: { z: true, y: ["x", 1] } };
  const bodyB = { a: { y: ["x", 1], z: true }, b: 2 };
  const signature = protocol.agentRequestSignature({
    method: "POST",
    path: "/api/agent/v2/sessions",
    timestamp,
    body: bodyA,
    secret: "shared-secret",
  });
  const same = protocol.agentRequestSignature({
    method: "POST",
    path: "/api/agent/v2/sessions",
    timestamp,
    body: bodyB,
    secret: "shared-secret",
  });
  assert.equal(signature, same);
  assert.equal(protocol.verifyAgentRequestSignature({
    method: "POST",
    path: "/api/agent/v2/sessions",
    timestamp,
    body: bodyB,
    secret: "shared-secret",
    signature,
  }).ok, true);
  assert.equal(protocol.verifyAgentRequestSignature({
    method: "POST",
    path: "/api/agent/v2/sessions",
    timestamp: timestamp - protocol.AGENT_SIGNATURE_WINDOW_MS - 1,
    body: bodyB,
    secret: "shared-secret",
    signature,
    now: timestamp,
  }).ok, false);
});

test("Agent V2 capabilities expose subagents and artifact limits", () => {
  const caps = sessions.getAgentV2Capabilities();
  assert.equal(caps.clientDrivenTools, true);
  assert.equal(caps.subagents, true);
  assert.equal(caps.requestSigning.supported, true);
  assert.equal(caps.artifactLimits.maxArtifactBytes, 8 * 1024 * 1024);
  assert.equal(caps.artifactLimits.artifactTtlHours, 168);
});

test("Agent V2 persists waiting tool calls and resumes after reload", async () => {
  sessions.clearAgentSessionsForTest();
  let calls = 0;
  const callBrain = async () => {
    calls++;
    if (calls === 1) return { text: JSON.stringify({ tool_calls: [{ name: "read_file", arguments: { path: "src/resume.js" } }] }) };
    return { text: JSON.stringify({ tool: "final", summary: "resumed" }) };
  };
  const session = sessions.createAgentSession({
    id: "persisted-session",
    toolManifest: [{ name: "read_file", parameters: { type: "object", properties: { path: { type: "string" } } } }],
  }, { callBrain });
  await sessions.startAgentTurn(session.id, { content: "read file" });
  const callId = session.pendingToolCall.callId;

  sessions.clearAgentSessionsForTest({ keepStore: true });
  assert.equal(sessions.getAgentSession("persisted-session"), undefined);
  assert.equal(sessions.loadPersistedAgentSessions(), 1);
  const restored = sessions.createAgentSession({
    id: "persisted-session",
    toolManifest: [{ name: "read_file", parameters: { type: "object", properties: { path: { type: "string" } } } }],
  }, { callBrain });
  assert.equal(restored.pendingToolCall.callId, callId);
  assert.equal(restored.status, "waiting_tool");

  await sessions.submitAgentToolResults(restored.id, { callId, ok: true, result: "1 | restored" });
  assert.equal(restored.status, "completed");
  const final = sessions.listAgentEvents(restored.id).find((event) => event.type === "final" && event.data.summary === "resumed");
  assert.ok(final);
});

test("Agent V2 route can require signed requests", async () => {
  sessions.clearAgentSessionsForTest();
  const { updateConfig } = await import("../services/config.js");
  const { default: agentV2Router } = await import("../routes/agent-v2.js");
  updateConfig({
    claudeProxy: { enabled: true, token: "route-secret" },
    distributedExecution: { enabled: true, protocol: "v2", requireV2Signature: true },
  });
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use("/api/agent/v2", agentV2Router);
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/agent/v2/sessions`;
  const body = { id: "signed-route-session", toolManifest: [] };
  try {
    const unsigned = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer route-secret" },
      body: JSON.stringify(body),
    });
    assert.equal(unsigned.status, 401);

    const timestamp = Date.now();
    const signature = protocol.agentRequestSignature({
      method: "POST",
      path: "/api/agent/v2/sessions",
      timestamp,
      body,
      secret: "route-secret",
    });
    const signed = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer route-secret",
        "X-Agent-V2-Timestamp": String(timestamp),
        "X-Agent-V2-Signature": signature,
      },
      body: JSON.stringify(body),
    });
    assert.equal(signed.status, 200);
    const json = await signed.json();
    assert.equal(json.ok, true);
    assert.equal(json.data.id, "signed-route-session");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    sessions.clearAgentSessionsForTest();
    updateConfig({
      claudeProxy: { enabled: true },
      distributedExecution: { enabled: true, protocol: "v2", maxRounds: 5, commandPolicy: "workspace", requireV2Signature: false },
    });
  }
});

test("Agent V2 artifacts enforce size limits and persist analysis", () => {
  sessions.clearAgentSessionsForTest();
  const session = sessions.createAgentSession({ id: "artifact-session", toolManifest: [] });
  const artifact = sessions.addAgentArtifact(session.id, {
    name: "pixel.png",
    mime: "image/png",
    size: 1,
    base64: "AA==",
    ref: "main:/pixel.png",
  });
  sessions.updateAgentArtifact(session.id, artifact.id, { analysis: { ok: true, text: "persisted vision" } });
  const expired = sessions.addAgentArtifact(session.id, {
    name: "old.png",
    mime: "image/png",
    size: 1,
    base64: "AA==",
    ref: "main:/old.png",
  });
  sessions.updateAgentArtifact(session.id, expired.id, { createdAt: Date.now() - (8 * 24 * 60 * 60 * 1000) });

  const tooLarge = Buffer.alloc(8 * 1024 * 1024 + 1).toString("base64");
  assert.throws(() => sessions.addAgentArtifact(session.id, {
    name: "huge.png",
    mime: "image/png",
    base64: tooLarge,
  }), /artifact too large/);

  sessions.clearAgentSessionsForTest({ keepStore: true });
  assert.equal(sessions.loadPersistedAgentSessions(), 1);
  const restored = sessions.getAgentSession("artifact-session");
  assert.equal(restored.artifacts[0].analysis.text, "persisted vision");
  assert.equal(restored.artifacts.some((item) => item.id === expired.id), false);
});

test("remote-agent-client executes tool_call locally and posts tool result", async () => {
  const { runRemoteAgentV2 } = await import("../services/devbench/remote-agent-client.js");
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-v2-client-"));
  const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-v2-web-"));
  fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
  fs.mkdirSync(path.join(webRoot, "src"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "src", "app.txt"), "hello from client\n", "utf8");
  fs.writeFileSync(path.join(webRoot, "src", "web.txt"), "hello from webapp\n", "utf8");
  fs.writeFileSync(path.join(projectRoot, "AGENTS.md"), "Use project root rules.\n", "utf8");
  fs.writeFileSync(path.join(webRoot, "CLAUDE.md"), "Use web app rules.\n", "utf8");
  const originalCodexHome = process.env.CODEX_HOME;
  const codexHome = path.join(projectRoot, ".codex-test");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, "config.toml"), "[mcp_servers.local_docs]\ncommand = \"secret-command\"\n", "utf8");
  process.env.CODEX_HOME = codexHome;

  let eventRes = null;
  let nextEventId = 1;
  let sessionBody = null;
  let postedToolResult = null;
  const signedRequests = [];
  const pendingEvents = [];
  const writeEvent = (event) => {
    eventRes.write(`id: ${event.id}\n`);
    eventRes.write(`event: ${event.type}\n`);
    eventRes.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const sendEvent = (type, data) => {
    const event = { id: nextEventId++, type, ts: Date.now(), data };
    if (!eventRes) pendingEvents.push(event);
    else writeEvent(event);
  };
  const readBody = (req) => new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => resolve(body ? JSON.parse(body) : {}));
  });
  const server = http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/api/agent/v2/sessions") {
      sessionBody = await readBody(req);
      signedRequests.push({ method: req.method, url: req.url, headers: req.headers, body: sessionBody });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, data: { id: "session-1", lastEventId: 0 } }));
      return;
    }
    if (req.method === "GET" && req.url.startsWith("/api/agent/v2/sessions/session-1/events")) {
      signedRequests.push({ method: req.method, url: req.url, headers: req.headers, body: null });
      eventRes = res;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      while (pendingEvents.length) writeEvent(pendingEvents.shift());
      sendEvent("session_created", { sessionId: "session-1" });
      return;
    }
    if (req.method === "POST" && req.url === "/api/agent/v2/sessions/session-1/turn") {
      const turnBody = await readBody(req);
      signedRequests.push({ method: req.method, url: req.url, headers: req.headers, body: turnBody });
      sendEvent("tool_call", { callId: "call-1", name: "read_file", arguments: { rootId: "webapp", path: "src/web.txt" }, round: 1 });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, data: { id: "session-1", status: "waiting_tool", lastEventId: nextEventId - 1 } }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/agent/v2/sessions/session-1/tool-results") {
      postedToolResult = await readBody(req);
      signedRequests.push({ method: req.method, url: req.url, headers: req.headers, body: postedToolResult });
      sendEvent("final", {
        status: "completed",
        summary: "done",
        history: [{ tool: "read_file", args: { path: "src/app.txt" }, result: postedToolResult.result, ok: postedToolResult.ok }],
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, data: { id: "session-1", status: "completed", lastEventId: nextEventId - 1 } }));
      eventRes.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    const result = await runRemoteAgentV2({
      centerHost: `http://127.0.0.1:${server.address().port}`,
      token: "center-secret",
      task: "read file",
      tab: { id: "tab-1", title: "test", extraProjects: [] },
      project: { path: projectRoot, webAppPath: webRoot, name: "project" },
      engine: "claude",
      maxRounds: 3,
    });
    assert.equal(result.summary, "done");
    assert.equal(postedToolResult.callId, "call-1");
    assert.equal(postedToolResult.ok, true);
    assert.match(postedToolResult.result, /hello from webapp/);
    assert.match(postedToolResult.result, /webapp:\//);
    assert.match(JSON.stringify(sessionBody.workspace.rules), /Use project root rules/);
    assert.match(JSON.stringify(sessionBody.workspace.rules), /Use web app rules/);
    assert.equal(sessionBody.workspace.capabilities.protocolFeatures.clientDrivenTools, true);
    assert.equal(sessionBody.workspace.capabilities.protocolFeatures.reverseExecutorRequired, false);
    assert.ok(sessionBody.workspace.capabilities.toolRegistry.tools.includes("read_file"));
    assert.ok(sessionBody.workspace.capabilities.toolRegistry.tools.includes("appmarket_admin_self_check"));
    assert.equal(sessionBody.toolManifest.filter((tool) => tool.name.startsWith("appmarket_admin_")).length, 20);
    assert.equal(typeof sessionBody.workspace.capabilities.skills.count, "number");
    assert.ok(sessionBody.workspace.capabilities.mcp.providers.some((provider) => provider.provider === "codex" && provider.servers.includes("local_docs")));
    assert.ok(sessionBody.workspace.capabilities.mcp.providers.some((provider) => provider.provider === "devbench" && provider.servers.includes("appmarket_admin_backend")));
    assert.doesNotMatch(JSON.stringify(sessionBody.workspace.capabilities), /secret-command/);
    assert.ok(signedRequests.length >= 4);
    for (const item of signedRequests) {
      assert.equal(item.headers.authorization, "Bearer center-secret");
      assert.ok(item.headers["x-agent-v2-timestamp"]);
      assert.ok(item.headers["x-agent-v2-signature"]);
      assert.equal(protocol.verifyAgentRequestSignature({
        method: item.method,
        path: item.url,
        timestamp: item.headers["x-agent-v2-timestamp"],
        signature: item.headers["x-agent-v2-signature"],
        body: item.body,
        secret: "center-secret",
      }).ok, true);
    }
    assert.doesNotMatch(JSON.stringify(sessionBody.workspace), new RegExp(projectRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(JSON.stringify(sessionBody.workspace), new RegExp(webRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(postedToolResult.result, new RegExp(projectRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(postedToolResult.result, new RegExp(webRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    if (originalCodexHome == null) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    eventRes?.end();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(webRoot, { recursive: true, force: true });
  }
});

test("remote-agent-client forwards legacy overlay audit metadata without entering Full V2", async () => {
  const { runRemoteAgentV2 } = await import("../services/devbench/remote-agent-client.js");
  const store = await import("../services/devbench/store.js");
  const { beginStoryAiLease, endStoryAiLease } = await import("../services/devbench/worktree-manager.js");
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-v2-overlay-client-"));
  const tabId = "tab-remote-overlay-audit";
  const taskId = "ta<REDACTED_API_KEY>";
  const tab = {
    id: tabId,
    title: "overlay audit",
    docSlug: "remote-overlay-audit",
    storyStorageRoot: path.join(tmp, "clone-parent", "AllDocs", "StoryDev"),
    runningTaskId: taskId,
    extraProjects: [],
  };
  const aiLease = beginStoryAiLease(tab, taskId);
  assert.ok(aiLease);
  const prompt = "legacy prompt with a frozen Phase2 overlay";
  const overlayRolloutHash = "a".repeat(64);
  const overlayTemplateSha256 = "b".repeat(64);
  store.appendConversationNode(tabId, {
    role: "user",
    content: "repair the issue",
    taskId,
    aiPrompt: prompt,
    aiPromptTelemetry: {
      schemaVersion: "agent-prompt-observation-v1",
      storyId: tabId,
      promptMode: "legacy",
      promptVariant: "phase2_overlay",
      overlayStage: "REPAIR",
      overlayVersion: "phase2-prompt-production-v2",
      overlayRolloutHash,
      overlayTemplateFile: "repair.md",
      overlayTemplateSha256,
      sha256: createHash("sha256").update(prompt, "utf8").digest("hex"),
    },
  });

  let eventRes = null;
  let turnBody = null;
  let finalPending = false;
  const pendingEvents = [];
  const writeEvent = (event) => {
    eventRes.write(`id: ${event.id}\n`);
    eventRes.write(`event: ${event.type}\n`);
    eventRes.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const sendFinal = () => {
    const event = {
      id: 1,
      type: "final",
      ts: Date.now(),
      data: { status: "completed", summary: "overlay metadata received", history: [] },
    };
    if (eventRes) {
      writeEvent(event);
      eventRes.end();
    } else {
      pendingEvents.push(event);
      finalPending = true;
    }
  };
  const readBody = (req) => new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => resolve(body ? JSON.parse(body) : {}));
  });
  const server = http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/api/agent/v2/sessions") {
      await readBody(req);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, data: { id: "session-overlay-audit", lastEventId: 0 } }));
      return;
    }
    if (req.method === "GET" && req.url.startsWith("/api/agent/v2/sessions/session-overlay-audit/events")) {
      eventRes = res;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      while (pendingEvents.length) writeEvent(pendingEvents.shift());
      if (finalPending) eventRes.end();
      return;
    }
    if (req.method === "POST" && req.url === "/api/agent/v2/sessions/session-overlay-audit/turn") {
      turnBody = await readBody(req);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, data: { id: "session-overlay-audit", status: "completed", lastEventId: 1 } }));
      sendFinal();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    const result = await runRemoteAgentV2({
      centerHost: `http://127.0.0.1:${server.address().port}`,
      token: "center-secret",
      task: prompt,
      taskId,
      tab,
      project: { path: projectRoot, name: "project" },
      engine: "claude",
      maxRounds: 3,
      promptMode: "legacy",
    });
    assert.equal(result.summary, "overlay metadata received");
    assert.deepEqual(turnBody, {
      content: prompt,
      promptMode: "legacy",
      promptVariant: "phase2_overlay",
      overlayStage: "REPAIR",
      overlayVersion: "phase2-prompt-production-v2",
      overlayRolloutHash,
      overlayTemplateFile: "repair.md",
      overlayTemplateSha256,
    });
    assert.equal(Object.hasOwn(turnBody, "promptSha256"), false);
    assert.equal(Object.hasOwn(turnBody, "telemetryContext"), false);
  } finally {
    endStoryAiLease(aiLease);
    eventRes?.end();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("remote-agent-client exposes storydev root and rejects absolute or parent paths", async () => {
  const { runRemoteAgentV2 } = await import("../services/devbench/remote-agent-client.js");
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-v2-story-project-"));
  const storageParent = fs.mkdtempSync(path.join(os.tmpdir(), "agent-v2-story-storage-"));
  const storyStorageRoot = path.join(storageParent, "AllDocs", "StoryDev");
  const storyDirectory = path.join(storyStorageRoot, "story-path-safety");
  fs.mkdirSync(path.join(storyDirectory, "tempFiles"), { recursive: true });
  fs.writeFileSync(path.join(storyDirectory, "tempFiles", "story.txt"), "story scoped content\n", "utf8");
  fs.writeFileSync(path.join(projectRoot, "outside.txt"), "must not leak\n", "utf8");

  let eventRes = null;
  let nextEventId = 1;
  let sessionBody = null;
  const postedToolResults = [];
  const pendingEvents = [];
  const writeEvent = (event) => {
    eventRes.write(`id: ${event.id}\n`);
    eventRes.write(`event: ${event.type}\n`);
    eventRes.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const sendEvent = (type, data) => {
    const event = { id: nextEventId++, type, ts: Date.now(), data };
    if (!eventRes) pendingEvents.push(event);
    else writeEvent(event);
  };
  const readBody = (req) => new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => resolve(body ? JSON.parse(body) : {}));
  });
  const server = http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/api/agent/v2/sessions") {
      sessionBody = await readBody(req);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, data: { id: "session-storydev", lastEventId: 0 } }));
      return;
    }
    if (req.method === "GET" && req.url.startsWith("/api/agent/v2/sessions/session-storydev/events")) {
      eventRes = res;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      while (pendingEvents.length) writeEvent(pendingEvents.shift());
      sendEvent("session_created", { sessionId: "session-storydev" });
      return;
    }
    if (req.method === "POST" && req.url === "/api/agent/v2/sessions/session-storydev/turn") {
      await readBody(req);
      sendEvent("tool_call", {
        callId: "call-story-read",
        name: "read_file",
        arguments: { rootId: "storydev", path: "tempFiles/story.txt" },
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, data: { id: "session-storydev", status: "waiting_tool", lastEventId: nextEventId - 1 } }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/agent/v2/sessions/session-storydev/tool-results") {
      const body = await readBody(req);
      postedToolResults.push(body);
      if (postedToolResults.length === 1) {
        sendEvent("tool_call", {
          callId: "call-story-write",
          name: "write_file",
          arguments: { rootId: "storydev", path: "tempFiles/generated.txt", content: "generated in story root\n" },
        });
      } else if (postedToolResults.length === 2) {
        sendEvent("tool_call", {
          callId: "call-story-absolute",
          name: "read_file",
          arguments: { rootId: "storydev", path: path.join(projectRoot, "outside.txt") },
        });
      } else if (postedToolResults.length === 3) {
        sendEvent("tool_call", {
          callId: "call-story-parent",
          name: "read_file",
          arguments: { path: "storydev:/../outside.txt" },
        });
      } else {
        sendEvent("final", { status: "completed", summary: "storydev paths checked", history: [] });
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, data: { id: "session-storydev", status: postedToolResults.length < 4 ? "waiting_tool" : "completed", lastEventId: nextEventId - 1 } }));
      if (postedToolResults.length === 4) eventRes.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    const result = await runRemoteAgentV2({
      centerHost: `http://127.0.0.1:${server.address().port}`,
      task: "check story storage paths",
      tab: {
        id: "tab-story-path-safety",
        title: "story path safety",
        docSlug: "story-path-safety",
        storyStorageRoot,
        extraProjects: [],
      },
      project: { path: projectRoot, name: "project" },
      engine: "claude",
      maxRounds: 5,
    });
    assert.equal(result.summary, "storydev paths checked");
    assert.equal(postedToolResults.length, 4);
    assert.equal(postedToolResults[0].ok, true);
    assert.match(postedToolResults[0].result, /story scoped content/);
    assert.match(postedToolResults[0].result, /storydev:\//);
    assert.equal(postedToolResults[1].ok, true);
    assert.equal(fs.readFileSync(path.join(storyDirectory, "tempFiles", "generated.txt"), "utf8"), "generated in story root\n");
    assert.equal(postedToolResults[2].ok, false);
    assert.match(postedToolResults[2].result, /must use rootId \+ relative path/);
    assert.equal(postedToolResults[3].ok, false);
    assert.match(postedToolResults[3].result, /cannot contain \.\./);
    assert.doesNotMatch(postedToolResults[2].result, /must not leak/);
    assert.doesNotMatch(postedToolResults[3].result, /must not leak/);
    assert.ok(sessionBody.workspace.roots.some((root) => root.id === "storydev" && root.kind === "storydev"));
    const readTool = sessionBody.toolManifest.find((tool) => tool.name === "read_file");
    assert.ok(readTool.parameters.properties.rootId.enum.includes("storydev"));
    const writeTool = sessionBody.toolManifest.find((tool) => tool.name === "write_file");
    assert.ok(writeTool.parameters.properties.rootId.enum.includes("storydev"));
    assert.doesNotMatch(JSON.stringify(sessionBody.workspace), new RegExp(storyDirectory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    eventRes?.end();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(storageParent, { recursive: true, force: true });
  }
});

test("remote-agent-client posts poll_process cursor metadata", async () => {
  const { runRemoteAgentV2 } = await import("../services/devbench/remote-agent-client.js");
  const { beginStoryAiLease, endStoryAiLease } = await import("../services/devbench/worktree-manager.js");
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-v2-poll-client-"));
  const storyStorageRoot = path.join(tmp, "clone-parent", "AllDocs", "StoryDev");
  let eventRes = null;
  let nextEventId = 1;
  let postedPollResult = null;
  let startedProcessId = "";
  const pendingEvents = [];
  const writeEvent = (event) => {
    eventRes.write(`id: ${event.id}\n`);
    eventRes.write(`event: ${event.type}\n`);
    eventRes.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const sendEvent = (type, data) => {
    const event = { id: nextEventId++, type, ts: Date.now(), data };
    if (!eventRes) pendingEvents.push(event);
    else writeEvent(event);
  };
  const readBody = (req) => new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => resolve(body ? JSON.parse(body) : {}));
  });
  const server = http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/api/agent/v2/sessions") {
      await readBody(req);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, data: { id: "session-poll", lastEventId: 0 } }));
      return;
    }
    if (req.method === "GET" && req.url.startsWith("/api/agent/v2/sessions/session-poll/events")) {
      eventRes = res;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      while (pendingEvents.length) writeEvent(pendingEvents.shift());
      sendEvent("session_created", { sessionId: "session-poll" });
      return;
    }
    if (req.method === "POST" && req.url === "/api/agent/v2/sessions/session-poll/turn") {
      await readBody(req);
      sendEvent("tool_call", {
        callId: "start-process",
        name: "start_process",
        arguments: {
          command: "node -e \"process.stdout.write('abcdefg')\"",
          purpose: "cursor metadata test",
          max_minutes: 1,
        },
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, data: { id: "session-poll", status: "waiting_tool", lastEventId: nextEventId - 1 } }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/agent/v2/sessions/session-poll/tool-results") {
      const body = await readBody(req);
      if (body.callId === "start-process") {
        const started = JSON.parse(body.result);
        startedProcessId = started.process_id;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, data: { id: "session-poll", status: "waiting_tool", lastEventId: nextEventId - 1 } }));
        // The Windows process supervisor first establishes its Job Object and
        // immutable runtime identity. Wait for that fail-closed startup path
        // before the single absolute-cursor poll used by this protocol test.
        setTimeout(() => {
          sendEvent("tool_call", {
            callId: "poll-process",
            name: "poll_process",
            arguments: { process_id: started.process_id, cursor: 0, max_chars: 4 },
          });
        }, 4000);
        return;
      }
      if (body.callId === "poll-process") {
        postedPollResult = body;
        sendEvent("final", { status: "completed", summary: "polled" });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, data: { id: "session-poll", status: "completed", lastEventId: nextEventId - 1 } }));
        eventRes.end();
        return;
      }
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const storyTaskId = "task-poll-process";
  const storyTab = {
    id: "tab-poll",
    title: "poll",
    docSlug: "poll-process-story",
    storyStorageRoot,
    runningTaskId: storyTaskId,
    extraProjects: [],
  };
  const aiLease = beginStoryAiLease(storyTab, storyTaskId);
  assert.ok(aiLease);
  try {
    const result = await runRemoteAgentV2({
      centerHost: `http://127.0.0.1:${server.address().port}`,
      task: "poll process",
      taskId: storyTaskId,
      tab: storyTab,
      project: { path: projectRoot, name: "project" },
      engine: "claude",
      maxRounds: 3,
    });
    assert.equal(result.summary, "polled");
    assert.equal(postedPollResult.callId, "poll-process");
    assert.equal(postedPollResult.stdout, "abcd");
    assert.equal(postedPollResult.truncated, true);
    assert.equal(postedPollResult.nextCursor, 4);
    assert.equal(
      fs.existsSync(path.join(storyStorageRoot, "poll-process-story", "tempFiles", "api-tool-processes", `${startedProcessId}.json`)),
      true,
    );
    assert.equal(fs.existsSync(path.join(projectRoot, "docs", "tempFiles")), false);
  } finally {
    endStoryAiLease(aiLease);
    eventRes?.end();
    await new Promise((resolve) => server.close(resolve));
    // Windows may keep the short-lived child process working directory locked
    // for a brief moment after its final stdout has already been polled.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    fs.rmSync(projectRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("remote-agent-client rejects a matching stale task id without an active story lease", async () => {
  const { runRemoteAgentV2 } = await import("../services/devbench/remote-agent-client.js");
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-v2-stale-task-"));
  try {
    await assert.rejects(
      runRemoteAgentV2({
        centerHost: "http://127.0.0.1:1",
        task: "must not reach the center",
        taskId: "stale-task-id",
        tab: {
          id: "tab-stale-task",
          title: "stale task",
          docSlug: "stale-task-story",
          storyStorageRoot: path.join(tmp, "clone-parent", "AllDocs", "StoryDev"),
          runningTaskId: "stale-task-id",
          extraProjects: [],
        },
        project: { path: projectRoot, name: "project" },
        engine: "claude",
        maxRounds: 1,
      }),
      /活动 AI\/worktree 租约/,
    );
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("remote-agent-client resumes waiting_tool session without starting a new turn", async () => {
  const { runRemoteAgentV2 } = await import("../services/devbench/remote-agent-client.js");
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-v2-resume-client-"));
  fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "src", "resume.txt"), "resume me\n", "utf8");

  let eventRes = null;
  let eventsUrl = "";
  let turnCalled = false;
  let postedToolResult = null;
  const readBody = (req) => new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => resolve(body ? JSON.parse(body) : {}));
  });
  const sendEvent = (id, type, data) => {
    const event = { id, type, ts: Date.now(), data };
    eventRes.write(`id: ${event.id}\n`);
    eventRes.write(`event: ${type}\n`);
    eventRes.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const server = http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/api/agent/v2/sessions") {
      await readBody(req);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, data: { id: "session-waiting", status: "waiting_tool", lastEventId: 2 } }));
      return;
    }
    if (req.method === "GET" && req.url.startsWith("/api/agent/v2/sessions/session-waiting/events")) {
      eventsUrl = req.url;
      eventRes = res;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      sendEvent(2, "tool_call", { callId: "call-resume", name: "read_file", arguments: { path: "src/resume.txt" }, round: 1 });
      return;
    }
    if (req.method === "POST" && req.url === "/api/agent/v2/sessions/session-waiting/turn") {
      turnCalled = true;
      await readBody(req);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "session is already running" }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/agent/v2/sessions/session-waiting/tool-results") {
      postedToolResult = await readBody(req);
      sendEvent(3, "final", { status: "completed", summary: "resumed client", history: [] });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, data: { id: "session-waiting", status: "completed", lastEventId: 3 } }));
      eventRes.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    const result = await runRemoteAgentV2({
      centerHost: `http://127.0.0.1:${server.address().port}`,
      task: "resume existing",
      tab: { id: "tab-resume-client", title: "resume", extraProjects: [] },
      project: { path: projectRoot, name: "project" },
      engine: "claude",
      maxRounds: 3,
      remoteAgentSessionId: "session-waiting",
      remoteAgentLastEventId: 2,
    });
    assert.equal(result.summary, "resumed client");
    assert.equal(turnCalled, false);
    assert.match(eventsUrl, /after=0/);
    assert.match(postedToolResult.result, /resume me/);
  } finally {
    eventRes?.end();
    server.close();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("remote-agent-client uploads inspect_image artifact and returns vision result", async () => {
  const { runRemoteAgentV2 } = await import("../services/devbench/remote-agent-client.js");
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-v2-image-"));
  fs.mkdirSync(path.join(projectRoot, "assets"), { recursive: true });
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lH9sWAAAAABJRU5ErkJggg==",
    "base64",
  );
  fs.writeFileSync(path.join(projectRoot, "assets", "pixel.png"), png);

  let eventRes = null;
  let nextEventId = 1;
  let postedArtifact = null;
  let postedToolResult = null;
  const pendingEvents = [];
  const writeEvent = (event) => {
    eventRes.write(`id: ${event.id}\n`);
    eventRes.write(`event: ${event.type}\n`);
    eventRes.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const sendEvent = (type, data) => {
    const event = { id: nextEventId++, type, ts: Date.now(), data };
    if (!eventRes) pendingEvents.push(event);
    else writeEvent(event);
  };
  const readBody = (req) => new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => resolve(body ? JSON.parse(body) : {}));
  });
  const server = http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/api/agent/v2/sessions") {
      await readBody(req);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, data: { id: "session-img", lastEventId: 0 } }));
      return;
    }
    if (req.method === "GET" && req.url.startsWith("/api/agent/v2/sessions/session-img/events")) {
      eventRes = res;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      while (pendingEvents.length) writeEvent(pendingEvents.shift());
      sendEvent("session_created", { sessionId: "session-img" });
      return;
    }
    if (req.method === "POST" && req.url === "/api/agent/v2/sessions/session-img/turn") {
      await readBody(req);
      sendEvent("tool_call", {
        callId: "call-img",
        name: "inspect_image",
        arguments: { rootId: "main", path: "assets/pixel.png", prompt: "OCR this" },
        round: 1,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, data: { id: "session-img", status: "waiting_tool", lastEventId: nextEventId - 1 } }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/agent/v2/sessions/session-img/artifacts") {
      postedArtifact = await readBody(req);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        data: {
          id: "artifact-img",
          ref: postedArtifact.ref,
          mime: postedArtifact.mime,
          analysis: { ok: true, text: "vision saw one pixel" },
        },
      }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/agent/v2/sessions/session-img/tool-results") {
      postedToolResult = await readBody(req);
      sendEvent("final", { status: "completed", summary: "image done", history: [] });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, data: { id: "session-img", status: "completed", lastEventId: nextEventId - 1 } }));
      eventRes.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    const result = await runRemoteAgentV2({
      centerHost: `http://127.0.0.1:${server.address().port}`,
      task: "inspect image",
      tab: { id: "tab-img", title: "image", extraProjects: [] },
      project: { path: projectRoot, name: "project" },
      engine: "claude",
      maxRounds: 3,
    });
    assert.equal(result.summary, "image done");
    assert.equal(postedArtifact.mime, "image/png");
    assert.equal(postedArtifact.ref, "main:/assets/pixel.png");
    assert.equal(postedArtifact.base64, png.toString("base64"));
    assert.equal(postedToolResult.ok, true);
    assert.match(postedToolResult.result, /vision saw one pixel/);
    assert.doesNotMatch(postedToolResult.result, new RegExp(projectRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    eventRes?.end();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("remote-agent-client uploads inspect_video frames for vision analysis", async () => {
  const { runRemoteAgentV2 } = await import("../services/devbench/remote-agent-client.js");
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-v2-video-"));
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-v2-video-bin-"));
  fs.mkdirSync(path.join(projectRoot, "assets"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "assets", "sample.mp4"), Buffer.from("fake video"));
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lH9sWAAAAABJRU5ErkJggg==",
    "base64",
  );
  fs.writeFileSync(path.join(binDir, "pixel.png"), png);
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(binDir, "ffprobe.cmd"), '@echo off\r\necho {"streams":[],"format":{"duration":"1"}}\r\n', "utf8");
    fs.writeFileSync(path.join(binDir, "ffmpeg.cmd"), '@echo off\r\ncopy /Y "%~dp0pixel.png" "%~8" >NUL\r\n', "utf8");
  } else {
    fs.writeFileSync(path.join(binDir, "ffprobe"), '#!/bin/sh\necho \'{"streams":[],"format":{"duration":"1"}}\'\n', { mode: 0o755 });
    fs.writeFileSync(path.join(binDir, "ffmpeg"), '#!/bin/sh\ncp "$(dirname "$0")/pixel.png" "$8"\n', { mode: 0o755 });
  }

  let eventRes = null;
  let nextEventId = 1;
  const postedArtifacts = [];
  let postedToolResult = null;
  const pendingEvents = [];
  const writeEvent = (event) => {
    eventRes.write(`id: ${event.id}\n`);
    eventRes.write(`event: ${event.type}\n`);
    eventRes.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const sendEvent = (type, data) => {
    const event = { id: nextEventId++, type, ts: Date.now(), data };
    if (!eventRes) pendingEvents.push(event);
    else writeEvent(event);
  };
  const readBody = (req) => new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => resolve(body ? JSON.parse(body) : {}));
  });
  const server = http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/api/agent/v2/sessions") {
      await readBody(req);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, data: { id: "session-video", lastEventId: 0 } }));
      return;
    }
    if (req.method === "GET" && req.url.startsWith("/api/agent/v2/sessions/session-video/events")) {
      eventRes = res;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      while (pendingEvents.length) writeEvent(pendingEvents.shift());
      sendEvent("session_created", { sessionId: "session-video" });
      return;
    }
    if (req.method === "POST" && req.url === "/api/agent/v2/sessions/session-video/turn") {
      await readBody(req);
      sendEvent("tool_call", {
        callId: "call-video",
        name: "inspect_video",
        arguments: { path: "assets/sample.mp4", timestamps: [0], prompt: "OCR video frame" },
        round: 1,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, data: { id: "session-video", status: "waiting_tool", lastEventId: nextEventId - 1 } }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/agent/v2/sessions/session-video/artifacts") {
      const body = await readBody(req);
      postedArtifacts.push(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        data: {
          id: `artifact-video-${postedArtifacts.length}`,
          ref: body.ref,
          mime: body.mime,
          analysis: { ok: true, text: "vision inspected video frame" },
        },
      }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/agent/v2/sessions/session-video/tool-results") {
      postedToolResult = await readBody(req);
      sendEvent("final", { status: "completed", summary: "video done", history: [] });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, data: { id: "session-video", status: "completed", lastEventId: nextEventId - 1 } }));
      eventRes.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const originalPath = process.env.PATH;
  const windowsSystemPath = path.join(process.env.SystemRoot || "C:\\Windows", "System32");
  process.env.PATH = process.platform === "win32"
    ? `${binDir}${path.delimiter}${windowsSystemPath}`
    : `${binDir}${path.delimiter}${originalPath || ""}`;
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    const result = await runRemoteAgentV2({
      centerHost: `http://127.0.0.1:${server.address().port}`,
      task: "inspect video",
      tab: {
        id: "tab-video",
        title: "video",
        docSlug: "video-story",
        storyStorageRoot: path.join(tmp, "clone-parent", "AllDocs", "StoryDev"),
        extraProjects: [],
      },
      project: { path: projectRoot, name: "project" },
      engine: "claude",
      maxRounds: 3,
    });
    assert.equal(result.summary, "video done");
    assert.equal(postedArtifacts.length, 1);
    assert.equal(postedArtifacts[0].mime, "image/png");
    assert.match(postedArtifacts[0].ref, /^storydev:\/tempFiles\/video-frames\/frame_/);
    assert.equal(postedArtifacts[0].base64, png.toString("base64"));
    assert.equal(postedToolResult.ok, true);
    assert.match(postedToolResult.result, /vision inspected video frame/);
    assert.doesNotMatch(postedToolResult.result, new RegExp(projectRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(fs.existsSync(path.join(projectRoot, "docs", "tempFiles")), false);
  } finally {
    process.env.PATH = originalPath;
    eventRes?.end();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
  }
});

test("remote-agent-client uploads rendered PDF pages for vision analysis", async () => {
  const { runRemoteAgentV2 } = await import("../services/devbench/remote-agent-client.js");
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-v2-pdf-"));
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-v2-pdf-bin-"));
  fs.mkdirSync(path.join(projectRoot, "docs"), { recursive: true });
  const pdf = [
    "%PDF-1.4",
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
    "3 0 obj << /Type /Page /Parent 2 0 R /Contents 4 0 R >> endobj",
    "4 0 obj << /Length 43 >> stream",
    "BT /F1 12 Tf 72 720 Td (Hello Page) Tj ET",
    "endstream endobj",
    "%%EOF",
  ].join("\n");
  fs.writeFileSync(path.join(projectRoot, "docs", "fixture.pdf"), pdf, "latin1");
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lH9sWAAAAABJRU5ErkJggg==",
    "base64",
  );
  fs.writeFileSync(path.join(binDir, "pixel.png"), png);
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(binDir, "pdftoppm.cmd"), '@echo off\r\ncopy /Y "%~dp0pixel.png" "%~8.png" >NUL\r\n', "utf8");
  } else {
    fs.writeFileSync(path.join(binDir, "pdftoppm"), '#!/bin/sh\ncp "$(dirname "$0")/pixel.png" "$8.png"\n', { mode: 0o755 });
  }

  let eventRes = null;
  let nextEventId = 1;
  const postedArtifacts = [];
  let postedToolResult = null;
  const pendingEvents = [];
  const writeEvent = (event) => {
    eventRes.write(`id: ${event.id}\n`);
    eventRes.write(`event: ${event.type}\n`);
    eventRes.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const sendEvent = (type, data) => {
    const event = { id: nextEventId++, type, ts: Date.now(), data };
    if (!eventRes) pendingEvents.push(event);
    else writeEvent(event);
  };
  const readBody = (req) => new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => resolve(body ? JSON.parse(body) : {}));
  });
  const server = http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/api/agent/v2/sessions") {
      await readBody(req);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, data: { id: "session-pdf", lastEventId: 0 } }));
      return;
    }
    if (req.method === "GET" && req.url.startsWith("/api/agent/v2/sessions/session-pdf/events")) {
      eventRes = res;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      while (pendingEvents.length) writeEvent(pendingEvents.shift());
      sendEvent("session_created", { sessionId: "session-pdf" });
      return;
    }
    if (req.method === "POST" && req.url === "/api/agent/v2/sessions/session-pdf/turn") {
      await readBody(req);
      sendEvent("tool_call", {
        callId: "call-pdf",
        name: "inspect_pdf",
        arguments: { path: "docs/fixture.pdf", render_pages: [1], prompt: "OCR PDF page" },
        round: 1,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, data: { id: "session-pdf", status: "waiting_tool", lastEventId: nextEventId - 1 } }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/agent/v2/sessions/session-pdf/artifacts") {
      const body = await readBody(req);
      postedArtifacts.push(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        data: {
          id: `artifact-pdf-${postedArtifacts.length}`,
          ref: body.ref,
          mime: body.mime,
          analysis: { ok: true, text: "vision inspected pdf page" },
        },
      }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/agent/v2/sessions/session-pdf/tool-results") {
      postedToolResult = await readBody(req);
      sendEvent("final", { status: "completed", summary: "pdf done", history: [] });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, data: { id: "session-pdf", status: "completed", lastEventId: nextEventId - 1 } }));
      eventRes.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const originalPath = process.env.PATH;
  const windowsSystemPath = path.join(process.env.SystemRoot || "C:\\Windows", "System32");
  process.env.PATH = process.platform === "win32"
    ? `${binDir}${path.delimiter}${windowsSystemPath}`
    : `${binDir}${path.delimiter}${originalPath || ""}`;
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    const result = await runRemoteAgentV2({
      centerHost: `http://127.0.0.1:${server.address().port}`,
      task: "inspect pdf",
      tab: {
        id: "tab-pdf",
        title: "pdf",
        docSlug: "pdf-story",
        storyStorageRoot: path.join(tmp, "clone-parent", "AllDocs", "StoryDev"),
        extraProjects: [],
      },
      project: { path: projectRoot, name: "project" },
      engine: "claude",
      maxRounds: 3,
    });
    assert.equal(result.summary, "pdf done");
    assert.equal(postedArtifacts.length, 1);
    assert.equal(postedArtifacts[0].mime, "image/png");
    assert.match(postedArtifacts[0].ref, /^storydev:\/tempFiles\/pdf-pages\/page_0001/);
    assert.equal(postedArtifacts[0].base64, png.toString("base64"));
    assert.equal(postedToolResult.ok, true);
    assert.match(postedToolResult.result, /vision inspected pdf page/);
    assert.doesNotMatch(postedToolResult.result, new RegExp(projectRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(fs.existsSync(path.join(projectRoot, "docs", "tempFiles")), false);
  } finally {
    process.env.PATH = originalPath;
    eventRes?.end();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
  }
});

test("remote-agent-client supports spawn_subagent and wait_subagent tools", async () => {
  const { runRemoteAgentV2 } = await import("../services/devbench/remote-agent-client.js");
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-v2-subagent-"));
  const eventResBySession = new Map();
  const pendingEventsBySession = new Map();
  const nextEventIds = new Map();
  const postedParentResults = [];
  const sessionBodies = [];
  let childInterruptBody = null;
  let sessionCreateCount = 0;
  const readBody = (req) => new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => resolve(body ? JSON.parse(body) : {}));
  });
  const sendEvent = (sessionId, type, data) => {
    const res = eventResBySession.get(sessionId);
    if (!res) {
      const pending = pendingEventsBySession.get(sessionId) || [];
      pending.push({ type, data });
      pendingEventsBySession.set(sessionId, pending);
      return;
    }
    const id = nextEventIds.get(sessionId) || 1;
    nextEventIds.set(sessionId, id + 1);
    const event = { id, type, ts: Date.now(), data };
    res.write(`id: ${event.id}\n`);
    res.write(`event: ${type}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const sessionIdFromEventsUrl = (url) => String(url).match(/\/sessions\/([^/]+)\/events/)?.[1] || "";
  const server = http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/api/agent/v2/sessions") {
      const body = await readBody(req);
      sessionBodies.push(body);
      sessionCreateCount++;
      const id = sessionCreateCount === 1 ? "session-parent" : "session-child";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, data: { id, lastEventId: 0 } }));
      return;
    }
    if (req.method === "GET" && req.url.startsWith("/api/agent/v2/sessions/") && req.url.includes("/events")) {
      const sessionId = sessionIdFromEventsUrl(req.url);
      eventResBySession.set(sessionId, res);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      sendEvent(sessionId, "session_created", { sessionId });
      for (const pending of pendingEventsBySession.get(sessionId) || []) {
        sendEvent(sessionId, pending.type, pending.data);
      }
      pendingEventsBySession.delete(sessionId);
      return;
    }
    if (req.method === "POST" && req.url === "/api/agent/v2/sessions/session-parent/turn") {
      await readBody(req);
      sendEvent("session-parent", "tool_call", {
        callId: "call-spawn",
        name: "spawn_subagent",
        arguments: { task: "verify independently", title: "Verifier" },
        round: 1,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, data: { id: "session-parent", status: "waiting_tool", lastEventId: 2 } }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/agent/v2/sessions/session-child/turn") {
      await readBody(req);
      sendEvent("session-child", "final", { status: "completed", summary: "subagent verified", history: [] });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, data: { id: "session-child", status: "completed", lastEventId: 2 } }));
      eventResBySession.get("session-child")?.end();
      return;
    }
    if (req.method === "POST" && req.url === "/api/agent/v2/sessions/session-child/interrupt") {
      childInterruptBody = await readBody(req);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, data: { id: "session-child", status: "running", lastEventId: 2 } }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/agent/v2/sessions/session-parent/tool-results") {
      const body = await readBody(req);
      postedParentResults.push(body);
      if (body.callId === "call-spawn") {
        const spawn = JSON.parse(body.result);
        sendEvent("session-parent", "tool_call", {
          callId: "call-send",
          name: "send_subagent_message",
          arguments: { subagent_id: spawn.subagentId, message: "focus on regression risk" },
          round: 2,
        });
      } else if (body.callId === "call-send") {
        const send = JSON.parse(body.result);
        sendEvent("session-parent", "tool_call", {
          callId: "call-wait",
          name: "wait_subagent",
          arguments: { subagent_id: send.subagentId, timeout_ms: 5000 },
          round: 3,
        });
      } else if (body.callId === "call-wait") {
        sendEvent("session-parent", "final", { status: "completed", summary: "parent done", history: [] });
        eventResBySession.get("session-parent")?.end();
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, data: { id: "session-parent", status: "running", lastEventId: 3 } }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    const result = await runRemoteAgentV2({
      centerHost: `http://127.0.0.1:${server.address().port}`,
      task: "use verifier",
      tab: { id: "tab-subagent", title: "subagent", extraProjects: [] },
      project: { path: projectRoot, name: "project" },
      engine: "claude",
      maxRounds: 3,
    });
    assert.equal(result.summary, "parent done");
    assert.equal(postedParentResults.length, 3);
    assert.match(postedParentResults[0].result, /subagent-1/);
    assert.match(postedParentResults[1].result, /subagent-1/);
    assert.match(postedParentResults[2].result, /subagent verified/);
    assert.equal(childInterruptBody.message, "focus on regression risk");
    assert.ok(sessionBodies[0].toolManifest.some((tool) => tool.name === "spawn_subagent"));
    assert.ok(!sessionBodies[1].toolManifest.some((tool) => tool.name === "spawn_subagent"));
  } finally {
    for (const res of eventResBySession.values()) res.end();
    server.close();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("remote-agent-client reuses cached tool result when retrying same callId", async () => {
  const { runRemoteAgentV2 } = await import("../services/devbench/remote-agent-client.js");
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-v2-cache-"));
  const storageParent = fs.mkdtempSync(path.join(os.tmpdir(), "agent-v2-cache-storage-"));
  const storyStorageRoot = path.join(storageParent, "AllDocs", "StoryDev");
  fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "src", "cache.txt"), "first version\n", "utf8");

  let eventRes = null;
  const postedToolResults = [];
  const pendingEvents = [];
  const writeEvent = (event) => {
    eventRes.write(`id: ${event.id}\n`);
    eventRes.write(`event: ${event.type}\n`);
    eventRes.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const sendEvent = (id, type, data) => {
    const event = { id, type, ts: Date.now(), data };
    if (!eventRes) pendingEvents.push(event);
    else writeEvent(event);
  };
  const readBody = (req) => new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => resolve(body ? JSON.parse(body) : {}));
  });
  const server = http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/api/agent/v2/sessions") {
      await readBody(req);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, data: { id: "session-cache", lastEventId: 0 } }));
      return;
    }
    if (req.method === "GET" && req.url.startsWith("/api/agent/v2/sessions/session-cache/events")) {
      eventRes = res;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      while (pendingEvents.length) writeEvent(pendingEvents.shift());
      sendEvent(1, "session_created", { sessionId: "session-cache" });
      return;
    }
    if (req.method === "POST" && req.url === "/api/agent/v2/sessions/session-cache/turn") {
      await readBody(req);
      sendEvent(2, "tool_call", {
        callId: "call-cache",
        name: "read_file",
        arguments: { path: "src/cache.txt" },
        round: 1,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, data: { id: "session-cache", status: "waiting_tool", lastEventId: 2 } }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/agent/v2/sessions/session-cache/tool-results") {
      const body = await readBody(req);
      postedToolResults.push(body);
      if (postedToolResults.length === 1) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "simulated submit failure" }));
        eventRes.end();
        eventRes = null;
        return;
      }
      sendEvent(3, "final", { status: "completed", summary: "cached done", history: [] });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, data: { id: "session-cache", status: "completed", lastEventId: 3 } }));
      eventRes.end();
      eventRes = null;
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    const baseArgs = {
      centerHost: `http://127.0.0.1:${server.address().port}`,
      task: "read cached file",
      tab: {
        id: "tab-cache",
        title: "cache",
        docSlug: "cache-story",
        storyStorageRoot,
        extraProjects: [],
      },
      project: { path: projectRoot, name: "project" },
      engine: "claude",
      maxRounds: 3,
      remoteAgentSessionId: "session-cache",
    };
    await assert.rejects(runRemoteAgentV2(baseArgs), /simulated submit failure/);
    fs.writeFileSync(path.join(projectRoot, "src", "cache.txt"), "second version\n", "utf8");
    const result = await runRemoteAgentV2(baseArgs);
    assert.equal(result.summary, "cached done");
    assert.match(postedToolResults[0].result, /first version/);
    assert.match(postedToolResults[1].result, /first version/);
    assert.doesNotMatch(postedToolResults[1].result, /second version/);
    assert.equal(
      fs.existsSync(path.join(storyStorageRoot, "cache-story", "tempFiles", "agent-v2-tool-results", "session-cache.json")),
      true,
    );
    assert.equal(
      fs.existsSync(path.join(projectRoot, "docs", "tempFiles", "agent-v2-tool-results", "session-cache.json")),
      false,
    );
  } finally {
    eventRes?.end();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(storageParent, { recursive: true, force: true });
  }
});

test("remote-agent-client posts user interrupt to existing V2 session", async () => {
  const { interruptRemoteAgentV2 } = await import("../services/devbench/remote-agent-client.js");
  let interruptBody = null;
  const readBody = (req) => new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => resolve(body ? JSON.parse(body) : {}));
  });
  const server = http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/api/agent/v2/sessions/session-interrupt/interrupt") {
      interruptBody = await readBody(req);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, data: { id: "session-interrupt", status: "running", lastEventId: 2 } }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    const ok = await interruptRemoteAgentV2({
      centerHost: `http://127.0.0.1:${server.address().port}`,
      sessionId: "session-interrupt",
      message: "please change direction",
    });
    assert.equal(ok, true);
    assert.equal(interruptBody.message, "please change direction");
  } finally {
    server.close();
  }
});

test("remote-agent-client cancels center session when locally aborted", async () => {
  const { runRemoteAgentV2 } = await import("../services/devbench/remote-agent-client.js");
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-v2-cancel-"));
  let eventRes = null;
  let resolveTurn;
  let resolveCancel;
  const turnStarted = new Promise((resolve) => { resolveTurn = resolve; });
  const cancelPosted = new Promise((resolve) => { resolveCancel = resolve; });
  const readBody = (req) => new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => resolve(body ? JSON.parse(body) : {}));
  });
  const sendEvent = (type, data) => {
    const event = { id: 1, type, ts: Date.now(), data };
    eventRes.write(`id: ${event.id}\n`);
    eventRes.write(`event: ${type}\n`);
    eventRes.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const server = http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/api/agent/v2/sessions") {
      await readBody(req);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, data: { id: "session-cancel", lastEventId: 0 } }));
      return;
    }
    if (req.method === "GET" && req.url.startsWith("/api/agent/v2/sessions/session-cancel/events")) {
      eventRes = res;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      sendEvent("session_created", { sessionId: "session-cancel" });
      return;
    }
    if (req.method === "POST" && req.url === "/api/agent/v2/sessions/session-cancel/turn") {
      await readBody(req);
      resolveTurn();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, data: { id: "session-cancel", status: "thinking", lastEventId: 1 } }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/agent/v2/sessions/session-cancel/cancel") {
      const body = await readBody(req);
      resolveCancel(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, data: { id: "session-cancel", status: "cancelled", lastEventId: 2 } }));
      eventRes?.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    const controller = new AbortController();
    const runPromise = runRemoteAgentV2({
      centerHost: `http://127.0.0.1:${server.address().port}`,
      task: "wait",
      tab: { id: "tab-cancel", title: "cancel", extraProjects: [] },
      project: { path: projectRoot, name: "project" },
      engine: "claude",
      maxRounds: 3,
      signal: controller.signal,
    });
    await turnStarted;
    controller.abort();
    await assert.rejects(runPromise, (error) => error?.name === "AbortError" || /abort|final event/i.test(error?.message || ""));
    const cancelBody = await Promise.race([
      cancelPosted,
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout waiting for cancel")), 1000)),
    ]);
    assert.equal(cancelBody.reason, "client aborted");
  } finally {
    eventRes?.end();
    server.close();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});
