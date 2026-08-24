import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

const nativePath = process.env.PATH || "";
function readInstalledCliHelp(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: { ...process.env, PATH: nativePath },
    shell: process.platform === "win32",
    timeout: 15_000,
  });
  return result.status === 0 ? String(result.stdout || "") : "";
}

const installedCliHelp = {
  claude: readInstalledCliHelp("claude", ["--help"]),
  codex: readInstalledCliHelp("codex", ["exec", "--help"]),
  gemini: readInstalledCliHelp("gemini", ["--help"]),
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-v2-stage-execution-"));
const captureFile = path.join(tmp, "cli-captures.jsonl");
process.env.GATEWAY_CONFIG_PATH = path.join(tmp, "gateway.json");
process.env.GATEWAY_DB_PATH = path.join(tmp, "gateway.db");
process.env.DEVBENCH_LOCAL_PROJECTS_PATH = path.join(tmp, "projects.json");
process.env.AIEFFICIENCY_CLONE_PARENT = path.join(tmp, "clone-parent");
process.env.WORKFLOW_V2_CLI_CAPTURE = captureFile;
process.env.NODE_ENV = "test";
fs.writeFileSync(process.env.GATEWAY_CONFIG_PATH, JSON.stringify({
  codexEnabled: true,
  geminiEnabled: true,
  autoFallback: false,
  maxCliConcurrency: 1,
  workDir: tmp,
  distributedExecution: { enabled: true, protocol: "v2", commandPolicy: "workspace" },
}), "utf8");

const fakeCli = path.join(tmp, "fake-stage-cli.mjs");
fs.writeFileSync(fakeCli, `
import fs from "node:fs";
const [engine, ...args] = process.argv.slice(2);
const policyIndex = args.indexOf("--policy");
const policyPath = policyIndex >= 0 ? args[policyIndex + 1] : "";
const policyText = policyPath && fs.existsSync(policyPath) ? fs.readFileSync(policyPath, "utf8") : "";
fs.appendFileSync(process.env.WORKFLOW_V2_CLI_CAPTURE, JSON.stringify({ engine, args, policyPath, policyText }) + "\\n");
if (engine === "claude") {
  process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Task status: completed" }] } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Task status: completed", session_id: "fake-claude-session" }) + "\\n");
} else if (engine === "codex") {
  process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Task status: completed" } }) + "\\n");
} else {
  process.stdout.write("Task status: completed\\n");
}
`);

for (const engine of ["claude", "codex", "gemini"]) {
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(tmp, `${engine}.cmd`), `@echo off\r\n"${process.execPath}" "${fakeCli}" ${engine} %*\r\n`);
  } else {
    const executable = path.join(tmp, engine);
    fs.writeFileSync(executable, `#!/bin/sh\nexec "${process.execPath}" "${fakeCli}" ${engine} "$@"\n`);
    fs.chmodSync(executable, 0o755);
  }
}
process.env.PATH = `${tmp}${path.delimiter}${process.env.PATH || ""}`;

let db;
let runTask;
let cliPermissionArgs;
let isWorkflowV2CliPromptTurn;
let runRemoteAgentV2;
let resolveAppMarketMcpRegistration;
let compileWorkflowV2StageToolPolicy;
let getWorkflowV2StageToolPolicyTemplate;
let canonicalSha256;

before(async () => {
  db = await import("../db/sqlite.js");
  ({ runTask, cliPermissionArgs, isWorkflowV2CliPromptTurn } = await import("../services/agent-runner.js"));
  ({ runRemoteAgentV2 } = await import("../services/devbench/remote-agent-client.js"));
  ({ resolveAppMarketMcpRegistration } = await import("../services/appmarket-admin-mcp.js"));
  ({ compileWorkflowV2StageToolPolicy, getWorkflowV2StageToolPolicyTemplate } = await import("../services/devbench/workflow-v2/stage-tool-policy.js"));
  ({ canonicalSha256 } = await import("../services/devbench/workflow-v2/envelope-store.js"));
});

after(async () => {
  try {
    const { closeAppMarketMcpBridge } = await import("../services/appmarket-admin-mcp.js");
    await closeAppMarketMcpBridge();
  } catch {}
  try {
    const { default: database } = await import("../db/sqlite.js");
    database.close();
  } catch {}
  fs.rmSync(tmp, { recursive: true, force: true });
});

function publicStagePolicy(stageId, readOnly, allowedToolNames, maxToolIterations = 10) {
  return {
    identity: { stageId },
    readOnly,
    allowedToolNames,
    maxToolIterations,
    protectedPaths: [".git/**", "AGENTS.md", "CLAUDE.md"],
  };
}

async function runCli(engine, stageToolPolicy) {
  const promptOverride = "Return Task status: completed";
  const task = {
    id: randomUUID(),
    title: `${engine} stage policy regression`,
    description: "verify the real CLI invocation",
    type: "general",
    status: "pending",
    priority: 3,
    source: "test",
    sourceId: `stage-policy-${engine}`,
    explicitEngine: engine,
    allowEngineFallback: false,
    cwd: tmp,
    promptOverride,
    streamingInput: false,
    promptMode: "compatibility",
    cliSessionId: null,
    imagePaths: [],
    promptSha256: createHash("sha256").update(promptOverride, "utf8").digest("hex"),
    telemetryContext: {
      contextId: `ctx-${randomUUID()}`,
      contextRevision: 1,
      contextHash: "a".repeat(64),
      promptMode: "compatibility",
      stage: stageToolPolicy.identity.stageId,
    },
    stageToolPolicy,
    idleTimeoutMs: 5000,
    maxTimeoutMs: 10000,
  };
  db.createTask(task);
  return runTask(task);
}

async function runLegacyCli(engine) {
  const task = {
    id: randomUUID(),
    title: `${engine} legacy CLI regression`,
    description: "verify legacy chat remains outside the V2 worker gate",
    type: "general",
    status: "pending",
    priority: 3,
    source: "test",
    sourceId: `legacy-policy-${engine}`,
    explicitEngine: engine,
    allowEngineFallback: false,
    cwd: tmp,
    promptOverride: "Return Task status: completed",
    streamingInput: false,
    commandPolicy: "read_only",
    idleTimeoutMs: 5000,
    maxTimeoutMs: 10000,
  };
  db.createTask(task);
  return runTask(task);
}

function captures() {
  if (!fs.existsSync(captureFile)) return [];
  return fs.readFileSync(captureFile, "utf8").trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

test("all Prompt V2 CLI stages fail closed before Provider or CLI spawn", async () => {
  const beforeBlocked = captures().length;
  const cases = [
    ["claude", publicStagePolicy("TRIAGE", true, ["read_file", "list_dir", "search_files", "git_diff"], 10)],
    ["codex", publicStagePolicy("VERIFY_EXECUTE", true, ["read_file"], 24)],
    ["gemini", publicStagePolicy("REPORT_SHORT", true, [], 0)],
    ["claude", publicStagePolicy("REPAIR", false, ["read_file", "edit_file", "apply_patch"], 24)],
    ["codex", publicStagePolicy("MEMORY_DISTILL", true, [], 0)],
    ["gemini", publicStagePolicy("REPAIR", false, ["edit_file"], 24)],
  ];
  for (const [engine, policy] of cases) {
    await assert.rejects(
      runCli(engine, policy),
      (error) => error?.code === "WORKFLOW_V2_CLI_WORKER_ISOLATION_REQUIRED"
        && error?.stageId === policy.identity.stageId
        && error?.engine === engine
        && error?.terminalFailure === true,
    );
  }
  assert.equal(captures().length, beforeBlocked, "V2 CLI must not reach the fake Provider process");
});

test("V2 worker gate identifies compatibility/structured turns and never treats CLI flags as isolation", () => {
  assert.equal(isWorkflowV2CliPromptTurn({ promptMode: "compatibility" }), true);
  assert.equal(isWorkflowV2CliPromptTurn({ promptMode: "structured" }), true);
  assert.equal(isWorkflowV2CliPromptTurn({ stageToolPolicy: publicStagePolicy("TRIAGE", true, ["read_file"]) }), true);
  assert.equal(isWorkflowV2CliPromptTurn({ promptMode: "legacy", commandPolicy: "read_only" }), false);

  const claude = cliPermissionArgs("claude", { stageToolPolicy: publicStagePolicy("REPAIR", false, ["read_file", "edit_file", "apply_patch"], 24) });
  const codex = cliPermissionArgs("codex", { stageToolPolicy: publicStagePolicy("TRIAGE", true, ["read_file"], 10) });
  const gemini = cliPermissionArgs("gemini", { stageToolPolicy: publicStagePolicy("VERIFY_EXECUTE", true, [], 24) });
  for (const args of [claude, codex, gemini]) {
    assert.equal(args.includes("--dangerously-skip-permissions"), false);
    assert.equal(args.includes("--dangerously-bypass-approvals-and-sandbox"), false);
    assert.equal(args.includes("--yolo"), false);
  }
});

test("legacy CLI chat is not caught by the Prompt V2 worker gate", async () => {
  const before = captures().length;
  for (const engine of ["claude", "codex", "gemini"]) await runLegacyCli(engine);
  const legacyCaptures = captures().slice(before);
  assert.deepEqual(legacyCaptures.map((capture) => capture.engine).sort(), ["claude", "codex", "gemini"]);
  for (const capture of legacyCaptures) {
    assert.equal(capture.args.includes("--dangerously-skip-permissions"), false);
    assert.equal(capture.args.includes("--dangerously-bypass-approvals-and-sandbox"), false);
    assert.equal(capture.args.includes("--yolo"), false);
  }
});

test("story CLI MCP registration exposes only the stage-approved AppMarket tools", () => {
  const registration = resolveAppMarketMcpRegistration({
    enabledTools: ["appmarket_admin_self_check", "write_file", "appmarket_admin_self_check"],
  });
  assert.deepEqual(registration.enabledTools, ["appmarket_admin_self_check"]);
  assert.deepEqual(resolveAppMarketMcpRegistration({ enabledTools: [] }).enabledTools, []);
});

for (const [engine, help] of Object.entries(installedCliHelp)) {
  test(`installed ${engine} CLI help covers every generated stage-permission option`, {
    skip: help ? false : `${engine} CLI is not installed`,
  }, () => {
    const policy = engine === "claude"
      ? publicStagePolicy("REPAIR", false, ["read_file", "search_files", "edit_file"], 24)
      : publicStagePolicy("TRIAGE", true, engine === "codex" ? ["read_file"] : [], 10);
    const generated = cliPermissionArgs(engine, { stageToolPolicy: policy });
    const options = new Set(generated
      .filter((token) => /^--[a-z]/.test(token))
      .map((token) => token.split("=", 1)[0]));
    if (engine === "gemini") options.add("--policy");
    for (const option of options) {
      assert.match(help, new RegExp(`(^|\\s)${option.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}(?:[=,\\s]|$)`, "m"));
    }
    assert.equal(generated.includes("--max-turns"), false);
    assert.equal(generated.includes("--ask-for-approval"), false);
  });
}

function compiledRepairPolicy(projectRoot, artifactRoot) {
  const stageId = "REPAIR";
  const template = getWorkflowV2StageToolPolicyTemplate(stageId);
  const storyId = "story-remote-stage-policy";
  const taskId = "task-remote-stage-policy";
  const context = {
    schemaVersion: "tb-stage-context-v2",
    contextId: "ctx-remote-stage-policy",
    revision: 1,
    idempotencyKey: "remote-stage-policy:1",
    story: { storyId, ticketId: null, carbId: null, title: "remote stage policy", groupId: null },
    stage: { id: stageId, attempt: 1, riskLevel: "MEDIUM" },
    task: { instruction: "edit one file", successCriteria: ["edited"], userVisibleGoal: "safe edit" },
    scope: {
      roots: [
        { rootId: "main", kind: "MAIN", projectId: "p1", branch: null, flavor: null, versionName: null, writable: true },
        { rootId: "artifacts", kind: "ARTIFACT", projectId: null, branch: null, flavor: null, versionName: null, writable: false },
      ],
      protectedPaths: [".git/**", "AGENTS.md", "CLAUDE.md"],
      tempRootId: "artifacts",
      deviceProfileId: null,
    },
    capabilities: {
      allowedTools: [...template.allowedToolNames],
      canWriteSource: true,
      canReadGit: true,
      canWriteGit: false,
      canCommit: false,
      canUseDevice: false,
      canWriteTb: false,
      canWriteReport: false,
      maxToolIterations: template.maxToolIterations,
      longProcessProtocol: "NONE",
    },
    output: { schemaId: "https://example.local/repair-result-v2.json", maxChars: null, outputPath: null },
  };
  return compileWorkflowV2StageToolPolicy({
    context,
    storyId,
    taskId,
    contextHash: canonicalSha256(context),
    rootBindings: [
      { rootId: "main", realRoot: projectRoot },
      { rootId: "artifacts", realRoot: artifactRoot },
    ],
  });
}

test("Agent V2 filters the real session manifest and re-authorizes every remote tool call", async () => {
  const projectRoot = fs.mkdtempSync(path.join(tmp, "remote-project-"));
  const artifactRoot = fs.mkdtempSync(path.join(tmp, "remote-artifacts-"));
  fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
  const sourceFile = path.join(projectRoot, "src", "value.txt");
  const forbiddenFile = path.join(projectRoot, "forbidden.txt");
  fs.writeFileSync(sourceFile, "before\n", "utf8");
  const stageToolPolicy = compiledRepairPolicy(projectRoot, artifactRoot);
  let eventResponse = null;
  let eventId = 1;
  let sessionBody = null;
  const toolResults = [];
  const queued = [];
  const readBody = (request) => new Promise((resolve) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => resolve(body ? JSON.parse(body) : {}));
  });
  const emit = (type, data) => {
    const event = { id: eventId++, type, ts: Date.now(), data };
    if (!eventResponse) queued.push(event);
    else eventResponse.write(`id: ${event.id}\nevent: ${type}\ndata: ${JSON.stringify(event)}\n\n`);
  };
  const server = http.createServer(async (request, response) => {
    if (request.method === "POST" && request.url === "/api/agent/v2/sessions") {
      sessionBody = await readBody(request);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true, data: { id: "session-stage-policy", lastEventId: 0 } }));
      return;
    }
    if (request.method === "GET" && request.url.startsWith("/api/agent/v2/sessions/session-stage-policy/events")) {
      eventResponse = response;
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      while (queued.length) {
        const event = queued.shift();
        response.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      }
      emit("session_created", { sessionId: "session-stage-policy" });
      return;
    }
    if (request.method === "POST" && request.url === "/api/agent/v2/sessions/session-stage-policy/turn") {
      await readBody(request);
      emit("tool_call", {
        callId: "allowed-edit",
        name: "edit_file",
        arguments: { rootId: "main", path: "src/value.txt", old_string: "before", new_string: "after" },
      });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true, data: { id: "session-stage-policy", status: "waiting_tool", lastEventId: eventId - 1 } }));
      return;
    }
    if (request.method === "POST" && request.url === "/api/agent/v2/sessions/session-stage-policy/tool-results") {
      const body = await readBody(request);
      toolResults.push(body);
      if (toolResults.length === 1) {
        emit("tool_call", {
          callId: "forbidden-command",
          name: "run_command",
          arguments: { rootId: "main", command: `echo unsafe > ${forbiddenFile}`, path: "." },
        });
      } else {
        emit("final", { status: "completed", summary: "stage policy checked", history: [] });
        eventResponse.end();
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true, data: { id: "session-stage-policy", status: toolResults.length === 1 ? "waiting_tool" : "completed", lastEventId: eventId - 1 } }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    const result = await runRemoteAgentV2({
      centerHost: `http://127.0.0.1:${server.address().port}`,
      task: "edit one file and try a forbidden command",
      tab: { id: "story-remote-stage-policy", title: "remote stage policy", extraProjects: [] },
      project: { path: projectRoot, name: "project" },
      engine: "claude",
      maxRounds: 5,
      stageToolPolicy,
    });
    assert.equal(result.summary, "stage policy checked");
    assert.equal(fs.readFileSync(sourceFile, "utf8"), "after\n");
    assert.equal(fs.existsSync(forbiddenFile), false);
    assert.equal(toolResults[0].ok, true);
    assert.equal(toolResults[1].ok, false);
    assert.match(toolResults[1].result, /not authorized for this stage/);

    const manifestNames = sessionBody.toolManifest.map((tool) => tool.name).sort();
    assert.deepEqual(
      manifestNames,
      stageToolPolicy.allowedToolNames.filter((name) => name !== "run_local_check").sort(),
    );
    assert.equal(manifestNames.includes("run_local_check"), false);
    assert.equal(manifestNames.includes("run_command"), false);
    assert.equal(manifestNames.includes("write_file"), false);
    assert.equal(manifestNames.includes("spawn_subagent"), false);
    assert.deepEqual(sessionBody.workspace.capabilities.toolRegistry.tools.sort(), manifestNames);
    assert.equal(sessionBody.commandPolicy, "workspace");
    assert.ok(sessionBody.toolManifest.find((tool) => tool.name === "edit_file").parameters.required.includes("rootId"));
  } finally {
    eventResponse?.end();
    await new Promise((resolve) => server.close(resolve));
  }
});
