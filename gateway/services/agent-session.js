import { createHash, randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { getConfig } from "./config.js";
import { runClaudeText, proxyHealth } from "./claude-proxy.js";
import { getClaudeProxyAiSnapshot } from "./ai-model-metadata.js";
import {
  AGENT_PROTOCOL_VERSION,
  makeEvent,
  normalizeToolManifest,
  normalizeToolResult,
  parseAgentResponse,
} from "./agent-protocol.js";

const sessions = new Map();
const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MAX_ROUNDS = 12;
const KEEP_RECENT = 6;
const MAX_RESULT_IN_RECENT = 6000;
const MAX_SUMMARY_CHARS = 6000;
const MAX_PERSISTED_SESSIONS = 200;
const MAX_ARTIFACTS_PER_SESSION = 200;
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const MAX_SESSION_ARTIFACT_BYTES = 64 * 1024 * 1024;
const ARTIFACT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function compact(value, limit) {
  const text = String(value ?? "");
  return text.length > limit ? `${text.slice(0, limit)}...(truncated ${text.length - limit} chars)` : text;
}

function sessionStorePath() {
  if (process.env.AGENT_V2_STORE_PATH) return process.env.AGENT_V2_STORE_PATH;
  if (process.env.GATEWAY_CONFIG_PATH) return join(dirname(process.env.GATEWAY_CONFIG_PATH), "agent-v2-sessions.json");
  return join(__dirname, "..", ".tmp", "agent-v2-sessions.json");
}

function serializeSession(session) {
  pruneExpiredArtifacts(session);
  return {
    id: session.id,
    protocolVersion: session.protocolVersion,
    engine: session.engine,
    aiSnapshot: session.aiSnapshot,
    status: session.status,
    task: session.task,
    workspace: session.workspace,
    toolManifest: session.toolManifest,
    commandPolicy: session.commandPolicy,
    maxRounds: session.maxRounds,
    round: session.round,
    summary: session.summary,
    recent: session.recent,
    history: session.history,
    interrupts: session.interrupts,
    artifacts: session.artifacts,
    pendingToolCall: session.pendingToolCall,
    completedCallIds: [...(session.completedCallIds || new Map()).entries()],
    events: session.events,
    lastEventId: session.lastEventId,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function hydrateSession(raw = {}) {
  const completed = new Map(Array.isArray(raw.completedCallIds) ? raw.completedCallIds : []);
  const status = ["running", "thinking"].includes(raw.status) ? "created" : (raw.status || "created");
  const session = {
    id: String(raw.id || randomUUID()),
    protocolVersion: raw.protocolVersion || AGENT_PROTOCOL_VERSION,
    engine: String(raw.engine || "claude"),
    aiSnapshot: raw.aiSnapshot || null,
    status,
    task: String(raw.task || ""),
    workspace: raw.workspace || {},
    toolManifest: normalizeToolManifest(raw.toolManifest || []),
    commandPolicy: raw.commandPolicy || "workspace",
    maxRounds: Math.max(1, Math.min(200, Number(raw.maxRounds || DEFAULT_MAX_ROUNDS))),
    round: Number(raw.round || 0),
    summary: String(raw.summary || ""),
    recent: Array.isArray(raw.recent) ? raw.recent : [],
    history: Array.isArray(raw.history) ? raw.history : [],
    interrupts: Array.isArray(raw.interrupts) ? raw.interrupts : [],
    artifacts: normalizeArtifacts(raw.artifacts, raw.createdAt),
    pendingToolCall: raw.pendingToolCall || null,
    completedCallIds: completed,
    events: Array.isArray(raw.events) ? raw.events : [],
    listeners: new Set(),
    lastEventId: Number(raw.lastEventId || 0),
    createdAt: Number(raw.createdAt || Date.now()),
    updatedAt: Number(raw.updatedAt || Date.now()),
    abortController: new AbortController(),
    callBrain: resolveBrain(raw.engine),
    advancing: null,
  };
  pruneExpiredArtifacts(session);
  return session;
}

function persistSessions() {
  const file = sessionStorePath();
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const list = [...sessions.values()]
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, MAX_PERSISTED_SESSIONS)
    .map(serializeSession);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, savedAt: Date.now(), sessions: list }, null, 2), "utf-8");
  renameSync(tmp, file);
}

function tryPersistSessions() {
  try { persistSessions(); } catch {}
}

function decodedBase64Bytes(value) {
  const text = String(value || "").replace(/\s+/g, "");
  if (!text) return 0;
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((text.length * 3) / 4) - padding);
}

function artifactDeclaredSize(artifact = {}) {
  const actual = artifact.base64 ? decodedBase64Bytes(artifact.base64) : 0;
  return Math.max(actual, Number(artifact.size || 0));
}

function normalizeArtifacts(artifacts = [], fallbackCreatedAt = Date.now()) {
  return (Array.isArray(artifacts) ? artifacts : []).map((artifact) => ({
    ...artifact,
    size: Number(artifact.size || 0),
    createdAt: Number(artifact.createdAt || fallbackCreatedAt || Date.now()),
  }));
}

function pruneExpiredArtifacts(session, now = Date.now()) {
  const artifacts = normalizeArtifacts(session.artifacts, session.createdAt || now)
    .filter((artifact) => now - Number(artifact.createdAt || now) <= ARTIFACT_TTL_MS)
    .sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
  while (artifacts.length > MAX_ARTIFACTS_PER_SESSION) artifacts.shift();
  let totalSize = artifacts.reduce((sum, artifact) => sum + (Number(artifact.size) || 0), 0);
  while (totalSize > MAX_SESSION_ARTIFACT_BYTES && artifacts.length) {
    const removed = artifacts.shift();
    totalSize -= Number(removed?.size || 0);
  }
  session.artifacts = artifacts;
}

export function loadPersistedAgentSessions() {
  const file = sessionStorePath();
  if (!existsSync(file)) return 0;
  let parsed;
  try { parsed = JSON.parse(readFileSync(file, "utf-8")); } catch { return 0; }
  const list = Array.isArray(parsed.sessions) ? parsed.sessions : [];
  let count = 0;
  for (const raw of list) {
    if (!raw?.id || sessions.has(String(raw.id))) continue;
    const session = hydrateSession(raw);
    sessions.set(session.id, session);
    count++;
  }
  return count;
}

function resolveBrain(engine) {
  return async (prompt, opts = {}) => {
    const result = await runClaudeText({
      prompt,
      system: [
        "You are the reasoning side of Agent V2.",
        "Return exactly one JSON object per turn. Do not execute tools yourself.",
      ].join("\n"),
      onChunk: opts.onChunk,
      signal: opts.signal || null,
    });
    if (!result.ok) throw new Error(result.error || `${engine || "AI"} call failed`);
    return { text: result.text || "", usage: result.usage || null };
  };
}

function appendEvent(session, type, data = {}) {
  const event = makeEvent(type, data, ++session.lastEventId);
  session.events.push(event);
  if (session.events.length > 2000) session.events.splice(0, session.events.length - 2000);
  session.updatedAt = Date.now();
  for (const listener of session.listeners) {
    try { listener(event); } catch {}
  }
  tryPersistSessions();
  return event;
}

function foldSummary(session) {
  while (session.recent.length > KEEP_RECENT) {
    const step = session.recent.shift();
    const args = compact(JSON.stringify(step.arguments || {}), 300);
    const result = compact(step.result || step.error || "", 500);
    session.summary += `\n- ${step.name || "action"} ${args}: ${step.ok === false ? "failed" : "ok"} ${result}`;
  }
  if (session.summary.length > MAX_SUMMARY_CHARS) {
    session.summary = `...(older context omitted)...\n${session.summary.slice(-MAX_SUMMARY_CHARS)}`;
    appendEvent(session, "context_compacted", { retainedRecent: session.recent.length, summaryChars: session.summary.length });
  }
}

function workspaceText(workspace = {}) {
  const roots = Array.isArray(workspace.roots) ? workspace.roots : [];
  const rules = Array.isArray(workspace.rules) ? workspace.rules : [];
  const lines = [];
  if (workspace.storyId) lines.push(`storyId: ${workspace.storyId}`);
  if (workspace.phase) lines.push(`phase: ${workspace.phase}`);
  if (roots.length) {
    lines.push("workspace roots:");
    for (const root of roots) {
      lines.push(`- ${root.id || root.rootId || "root"}: ${root.name || root.label || ""} ${root.kind ? `(${root.kind})` : ""}`.trim());
    }
  }
  if (rules.length) {
    lines.push("workspace rules:");
    for (const rule of rules) {
      const label = `${rule.rootId || "main"}:/${rule.file || "rules"}`;
      if (rule.skipped) {
        lines.push(`## ${label}`);
        lines.push(`skipped: ${rule.reason || "unavailable"}`);
      } else {
        lines.push(`## ${label}`);
        lines.push(compact(rule.content || "", MAX_RESULT_IN_RECENT));
      }
    }
  }
  const capabilities = clientCapabilitiesText(workspace.capabilities || {});
  if (capabilities) {
    lines.push("client capability declarations:");
    lines.push(capabilities);
  }
  return lines.join("\n") || "workspace metadata was not provided";
}

function clientCapabilitiesText(capabilities = {}) {
  if (!capabilities || typeof capabilities !== "object") return "";
  const lines = [];
  const protocol = capabilities.protocolFeatures || {};
  if (Object.keys(protocol).length) {
    lines.push(`protocol: clientDrivenTools=${protocol.clientDrivenTools !== false}, reverseExecutorRequired=${!!protocol.reverseExecutorRequired}, artifactUpload=${!!protocol.artifactUpload}, interrupts=${!!protocol.interrupts}, subagents=${!!protocol.subagents}`);
  }
  const registry = capabilities.toolRegistry || {};
  if (registry.count != null || Array.isArray(registry.tools)) {
    lines.push(`tool registry: ${Number(registry.count || 0)} tools, commandPolicy=${registry.commandPolicy || "workspace"}, workspaceIsolation=${registry.workspaceIsolation !== false}`);
    if (Array.isArray(registry.tools) && registry.tools.length) lines.push(`tools: ${registry.tools.join(", ")}`);
    if (Array.isArray(registry.mediaArtifacts) && registry.mediaArtifacts.length) lines.push(`media/artifact tools: ${registry.mediaArtifacts.join(", ")}`);
  }
  const skills = capabilities.skills || {};
  if (skills.available || skills.count != null || skills.error) {
    lines.push(`skills: available=${!!skills.available}, count=${Number(skills.count || 0)}, truncated=${!!skills.truncated}`);
    if (Array.isArray(skills.engines) && skills.engines.length) lines.push(`skill engines: ${skills.engines.join(", ")}`);
    if (skills.summary) lines.push(compact(skills.summary, 5000));
    else if (skills.error) lines.push(`skills error: ${skills.error}`);
  }
  const mcp = capabilities.mcp || {};
  if (mcp.available || Array.isArray(mcp.providers)) {
    lines.push(`mcp: available=${!!mcp.available}, totalServers=${Number(mcp.totalServers || 0)}, redacted=true`);
    for (const provider of mcp.providers || []) {
      const servers = Array.isArray(provider.servers) && provider.servers.length ? ` [${provider.servers.join(", ")}]` : "";
      const suffix = provider.skipped ? ` skipped=${provider.reason || "true"}` : provider.error ? ` error=${provider.error}` : "";
      lines.push(`- ${provider.provider || "mcp"}: configured=${!!provider.configured}, serverCount=${Number(provider.serverCount || 0)}${servers}${suffix}`);
    }
    if (mcp.note) lines.push(compact(mcp.note, 500));
  }
  return lines.join("\n");
}

function toolManifestText(manifest = []) {
  return JSON.stringify(manifest.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  })), null, 2);
}

function buildPrompt(session) {
  const lines = [
    "You are an AI reasoning server in Agent V2 client-driven mode.",
    "The client owns the workspace, files, commands, devices, artifacts, cancellation, and tool execution.",
    "You must only choose the next tool call or final answer. Never claim you executed or inspected something until a tool result is present.",
    "Return exactly one JSON object. Use one of these shapes:",
    "{\"tool_calls\":[{\"name\":\"read_file\",\"arguments\":{\"path\":\"src/app.js\"},\"thought\":\"why\"}]}",
    "{\"tool\":\"final\",\"summary\":\"final answer\"}",
    "Use rootId plus a relative path for workspace tools. rootId is a logical client root such as main, webapp, or extra-1. Do not use client absolute paths.",
    "",
    "# Protocol",
    AGENT_PROTOCOL_VERSION,
    "",
    "# Workspace",
    workspaceText(session.workspace),
    "",
    "# Available Tools",
    toolManifestText(session.toolManifest),
    "",
    "# User Task",
    session.task || "(no task)",
  ];
  if (session.interrupts.length) {
    lines.push("", "# User Interrupts", session.interrupts.map((item) => `- ${item}`).join("\n"));
  }
  if (session.summary) lines.push("", "# Earlier Tool Summary", session.summary);
  lines.push("", "# Recent Tool Results");
  if (!session.recent.length) lines.push("(none)");
  for (const [index, step] of session.recent.entries()) {
    lines.push(`## ${index + 1}. ${step.name}`);
    if (step.thought) lines.push(`thought: ${step.thought}`);
    lines.push(`arguments: ${compact(JSON.stringify(step.arguments || {}), 1000)}`);
    lines.push(`status: ${step.ok === false ? "failed" : "completed"}`);
    if (step.exitCode != null) lines.push(`exitCode: ${step.exitCode}`);
    if (step.truncated) lines.push(`truncated: true; nextCursor: ${step.nextCursor ?? ""}`);
    if (Array.isArray(step.artifacts) && step.artifacts.length) lines.push(`artifacts: ${compact(JSON.stringify(step.artifacts), 1000)}`);
    lines.push(`result: ${compact(step.result || step.error || "", MAX_RESULT_IN_RECENT)}`);
  }
  lines.push("", "Return the next JSON action now.");
  return lines.join("\n");
}

function hardStopped(session) {
  return session.status === "cancelled" || session.abortController.signal.aborted;
}

export function getAgentV2Capabilities() {
  const cfg = getConfig();
  const dist = cfg.distributedExecution || {};
  const health = proxyHealth();
  return {
    protocolVersion: AGENT_PROTOCOL_VERSION,
    serverTime: new Date().toISOString(),
    eventTypes: [
      "thinking_delta",
      "text_delta",
      "tool_call",
      "tool_call_cancelled",
      "context_compacted",
      "usage",
      "final",
      "error",
    ],
    clientDrivenTools: true,
    reverseExecutorRequired: false,
    subagents: true,
    requestSigning: {
      supported: true,
      required: !!dist.requireV2Signature,
      headerTimestamp: "X-Agent-V2-Timestamp",
      headerSignature: "X-Agent-V2-Signature",
    },
    maxRoundsDefault: Number(dist.maxRounds) || DEFAULT_MAX_ROUNDS,
    artifactLimits: {
      maxArtifactsPerSession: MAX_ARTIFACTS_PER_SESSION,
      maxArtifactBytes: MAX_ARTIFACT_BYTES,
      maxSessionArtifactBytes: MAX_SESSION_ARTIFACT_BYTES,
      artifactTtlMs: ARTIFACT_TTL_MS,
      artifactTtlHours: ARTIFACT_TTL_MS / (60 * 60 * 1000),
    },
    backend: {
      ok: health.ok,
      busy: health.busy,
      queueLen: health.queueLen,
      backend: health.backend,
      configuredBackend: health.configuredBackend,
      vision: !!String(cfg.claudeProxy?.anthropicApiKey || "").trim(),
    },
  };
}

export function createAgentSession(input = {}, deps = {}) {
  const id = String(input.id || randomUUID());
  const cfg = getConfig();
  const dist = cfg.distributedExecution || {};
  const existing = sessions.get(id);
  if (existing) {
    existing.engine = String(input.engine || existing.engine || "claude");
    existing.workspace = input.workspace || existing.workspace || {};
    existing.toolManifest = normalizeToolManifest(input.toolManifest || input.tools || existing.toolManifest || []);
    existing.commandPolicy = input.commandPolicy || existing.commandPolicy || dist.commandPolicy || "workspace";
    existing.maxRounds = Math.max(1, Math.min(200, Number(input.maxRounds || existing.maxRounds || dist.maxRounds || DEFAULT_MAX_ROUNDS)));
    if (deps.callBrain || input.callBrain) existing.callBrain = deps.callBrain || input.callBrain;
    existing.updatedAt = Date.now();
    existing.aiSnapshot = getClaudeProxyAiSnapshot({ config: cfg, capturedAt: existing.updatedAt });
    tryPersistSessions();
    return existing;
  }
  const session = {
    id,
    protocolVersion: AGENT_PROTOCOL_VERSION,
    engine: String(input.engine || "claude"),
    aiSnapshot: getClaudeProxyAiSnapshot({ config: cfg }),
    status: "created",
    task: "",
    workspace: input.workspace || {},
    toolManifest: normalizeToolManifest(input.toolManifest || input.tools || []),
    commandPolicy: input.commandPolicy || dist.commandPolicy || "workspace",
    maxRounds: Math.max(1, Math.min(200, Number(input.maxRounds || dist.maxRounds || DEFAULT_MAX_ROUNDS))),
    round: 0,
    summary: "",
    recent: [],
    history: [],
    interrupts: [],
    artifacts: [],
    pendingToolCall: null,
    completedCallIds: new Map(),
    events: [],
    listeners: new Set(),
    lastEventId: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    abortController: new AbortController(),
    callBrain: deps.callBrain || input.callBrain || resolveBrain(input.engine),
    advancing: null,
  };
  sessions.set(id, session);
  appendEvent(session, "session_created", {
    sessionId: id,
    protocolVersion: AGENT_PROTOCOL_VERSION,
    toolCount: session.toolManifest.length,
    aiSnapshot: session.aiSnapshot,
  });
  return session;
}

export function getAgentSession(id) {
  return sessions.get(String(id || ""));
}

export function listAgentEvents(id, after = 0) {
  const session = getAgentSession(id);
  if (!session) return [];
  const cursor = Number(after) || 0;
  return session.events.filter((event) => event.id > cursor);
}

export function subscribeAgentEvents(id, listener) {
  const session = getAgentSession(id);
  if (!session) return () => {};
  session.listeners.add(listener);
  return () => session.listeners.delete(listener);
}

async function advanceSession(session) {
  if (session.advancing) return session.advancing;
  session.advancing = (async () => {
    try {
      while (!session.pendingToolCall && !hardStopped(session) && session.status !== "completed") {
        if (hardStopped(session)) {
          session.status = "cancelled";
          appendEvent(session, "error", { error: "session cancelled", cancelled: true });
          return session;
        }
        if (session.round >= session.maxRounds) {
          session.status = "reached_max";
          appendEvent(session, "final", {
            status: "partial",
            summary: `Agent V2 reached max rounds (${session.maxRounds}) before final answer.`,
            history: session.history,
            aiSnapshot: session.aiSnapshot,
          });
          return session;
        }
        session.round += 1;
        session.status = "thinking";
        let brainResult;
        let streamed = "";
        try {
          brainResult = await session.callBrain(buildPrompt(session), {
            signal: session.abortController.signal,
            onChunk: (chunk) => {
              streamed += String(chunk || "");
              appendEvent(session, "text_delta", { delta: String(chunk || ""), round: session.round });
            },
          });
        } catch (error) {
          session.status = "error";
          appendEvent(session, "error", { error: error.message || String(error), round: session.round });
          return session;
        }
        const text = typeof brainResult === "string" ? brainResult : (brainResult?.text || streamed || "");
        if (brainResult?.usage) appendEvent(session, "usage", { usage: brainResult.usage, round: session.round });
        const parsed = parseAgentResponse(text, session.toolManifest);
        if (parsed?.type === "final") {
          session.status = "completed";
          appendEvent(session, "final", {
            status: "completed",
            summary: parsed.summary || "completed",
            history: session.history,
            usage: brainResult?.usage || null,
            aiSnapshot: session.aiSnapshot,
          });
          return session;
        }
        if (parsed?.type !== "tool_call") {
          const step = {
            name: "protocol_error",
            arguments: {},
            ok: false,
            error: parsed?.error || "protocol error",
            result: parsed?.raw || "",
          };
          session.history.push(step);
          session.recent.push(step);
          foldSummary(session);
          continue;
        }
        const callId = parsed.id || `${session.id}:${session.round}:${randomUUID()}`;
        session.pendingToolCall = {
          callId,
          name: parsed.name,
          arguments: parsed.arguments || {},
          thought: parsed.thought || "",
          round: session.round,
        };
        session.status = "waiting_tool";
        appendEvent(session, "tool_call", session.pendingToolCall);
        return session;
      }
      return session;
    } finally {
      session.updatedAt = Date.now();
      session.advancing = null;
      tryPersistSessions();
    }
  })();
  return session.advancing;
}

export async function startAgentTurn(id, input = {}) {
  const session = getAgentSession(id);
  if (!session) throw new Error("session not found");
  if (session.pendingToolCall || ["running", "thinking", "waiting_tool"].includes(session.status)) {
    throw new Error("session is already running");
  }
  if (session.status === "cancelled") throw new Error("session is cancelled");
  const content = String(input.content || input.task || "").trim();
  if (!content) throw new Error("turn content is required");
  if (input.promptMode === "compatibility") {
    const promptSha256 = String(input.promptSha256 || "");
    const telemetryContext = input.telemetryContext;
    const actualSha256 = createHash("sha256").update(content, "utf8").digest("hex");
    const valid = /^[a-f0-9]{64}$/.test(promptSha256)
      && promptSha256 === actualSha256
      && typeof telemetryContext?.contextId === "string"
      && telemetryContext.contextId.trim().length > 0
      && Number.isSafeInteger(telemetryContext?.contextRevision)
      && telemetryContext.contextRevision >= 1
      && /^[a-f0-9]{64}$/.test(String(telemetryContext?.contextHash || ""))
      && telemetryContext?.promptMode === "compatibility";
    if (!valid) throw new Error("compatibility turn prompt hash/context is invalid");
  }
  session.aiSnapshot = getClaudeProxyAiSnapshot({ config: getConfig() });
  session.task = session.task ? `${session.task}\n\n# Follow-up\n${content}` : content;
  session.status = "running";
  appendEvent(session, "turn_started", {
    sessionId: session.id,
    round: session.round + 1,
    aiSnapshot: session.aiSnapshot,
  });
  return advanceSession(session);
}

export async function submitAgentToolResults(id, input = {}) {
  const session = getAgentSession(id);
  if (!session) throw new Error("session not found");
  const items = Array.isArray(input.results) ? input.results : [input];
  let accepted = 0;
  for (const item of items) {
    const result = normalizeToolResult(item);
    if (!result.callId) throw new Error("tool result callId is required");
    if (session.completedCallIds.has(result.callId)) continue;
    const pending = session.pendingToolCall;
    if (!pending || pending.callId !== result.callId) {
      throw new Error(`unexpected tool result callId: ${result.callId}`);
    }
    const text = result.result || [
      result.stdout ? `stdout:\n${result.stdout}` : "",
      result.stderr ? `stderr:\n${result.stderr}` : "",
    ].filter(Boolean).join("\n");
    const step = {
      callId: result.callId,
      name: pending.name,
      tool: pending.name,
      arguments: pending.arguments,
      args: pending.arguments,
      thought: pending.thought,
      ok: result.ok,
      status: result.status,
      exitCode: result.exitCode,
      result: text,
      artifacts: result.artifacts,
      truncated: result.truncated,
      nextCursor: result.nextCursor,
    };
    session.completedCallIds.set(result.callId, step);
    session.history.push(step);
    session.recent.push(step);
    session.pendingToolCall = null;
    accepted++;
    foldSummary(session);
  }
  if (!accepted) return session;
  session.status = "running";
  return advanceSession(session);
}

export function interruptAgentSession(id, message = "") {
  const session = getAgentSession(id);
  if (!session) throw new Error("session not found");
  const text = String(message || "").trim();
  if (text) session.interrupts.push(text);
  appendEvent(session, "text_delta", { delta: text ? `\n[interrupt queued] ${text}\n` : "\n[interrupt queued]\n" });
  return session;
}

export function cancelAgentSession(id, reason = "") {
  const session = getAgentSession(id);
  if (!session) throw new Error("session not found");
  session.abortController.abort();
  if (session.pendingToolCall) {
    appendEvent(session, "tool_call_cancelled", { callId: session.pendingToolCall.callId, reason: reason || "cancelled" });
    session.pendingToolCall = null;
  }
  session.status = "cancelled";
  appendEvent(session, "error", { error: reason || "session cancelled", cancelled: true });
  return session;
}

export function addAgentArtifact(id, artifact = {}) {
  const session = getAgentSession(id);
  if (!session) throw new Error("session not found");
  pruneExpiredArtifacts(session);
  if (session.artifacts.length >= MAX_ARTIFACTS_PER_SESSION) {
    throw new Error(`artifact count limit exceeded (${MAX_ARTIFACTS_PER_SESSION})`);
  }
  const size = artifactDeclaredSize(artifact);
  if (size > MAX_ARTIFACT_BYTES) {
    throw new Error(`artifact too large (${size} bytes > ${MAX_ARTIFACT_BYTES})`);
  }
  const totalSize = session.artifacts.reduce((sum, item) => sum + (Number(item.size) || 0), 0);
  if (totalSize + size > MAX_SESSION_ARTIFACT_BYTES) {
    throw new Error(`session artifact storage limit exceeded (${totalSize + size} bytes > ${MAX_SESSION_ARTIFACT_BYTES})`);
  }
  const item = {
    id: artifact.id || randomUUID(),
    name: String(artifact.name || ""),
    mime: String(artifact.mime || artifact.mediaType || ""),
    size,
    sha256: String(artifact.sha256 || ""),
    ref: artifact.ref || artifact.path || null,
    createdAt: Date.now(),
  };
  session.artifacts.push(item);
  session.updatedAt = Date.now();
  tryPersistSessions();
  return item;
}

export function updateAgentArtifact(id, artifactId, patch = {}) {
  const session = getAgentSession(id);
  if (!session) throw new Error("session not found");
  const item = session.artifacts.find((artifact) => artifact.id === artifactId);
  if (!item) throw new Error("artifact not found");
  Object.assign(item, patch);
  session.updatedAt = Date.now();
  tryPersistSessions();
  return item;
}

export function clearAgentSessionsForTest({ keepStore = false } = {}) {
  sessions.clear();
  if (!keepStore) {
    try { unlinkSync(sessionStorePath()); } catch {}
  }
}

loadPersistedAgentSessions();
