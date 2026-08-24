import { getConfig } from "../config.js";
import { executeTool, getToolDefinitions } from "../api-tools.js";
import { agentRequestSignature, toolDefinitionsToManifest } from "../agent-protocol.js";
import { getCapabilityDoc } from "../capability-doc.js";
import { createHash } from "crypto";
import path from "path";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import * as store from "./store.js";
import { ensureExternalTempDirectory } from "../external-temp.js";
import { isStoryTaskAiLeaseActive } from "./worktree-manager.js";
import {
  APPMARKET_MCP_REGISTRATION_ID,
  getAppMarketMcpOpenAiTools,
  inspectAppMarketMcpRuntime,
} from "../appmarket-admin-mcp.js";
import {
  authorizeWorkflowV2StageToolCall,
  sanitizeWorkflowV2StageToolResult,
} from "./workflow-v2/stage-tool-policy.js";
import {
  PROMPT_COMPATIBILITY_OVERLAY_STAGES,
  PROMPT_COMPATIBILITY_OVERLAY_VARIANT,
  PROMPT_COMPATIBILITY_OVERLAY_VERSION,
  promptCompatibilityOverlayTemplateFiles,
} from "./workflow-v2/prompt-compatibility-overlay.js";

const MAX_IMAGE_UPLOAD_BYTES = 6 * 1024 * 1024;
const MAX_RULE_FILE_BYTES = 256 * 1024;
const MAX_RULE_CONTENT_CHARS = 24000;
const MAX_CACHED_TOOL_RESULTS = 500;
const MAX_DECLARED_SKILLS = 80;
const MAX_DECLARATION_TEXT_CHARS = 12000;
const MAX_MCP_CONFIG_BYTES = 1024 * 1024;
const MAX_MCP_SERVERS = 50;
const DEFAULT_SUBAGENT_TIMEOUT_MS = 1000;
const WORKSPACE_RULE_FILES = ["AGENTS.md", "CLAUDE.md"];
const SHA256_RE = /^[a-f0-9]{64}$/;
const PROMPT_COMPATIBILITY_OVERLAY_STAGE_SET = new Set(PROMPT_COMPATIBILITY_OVERLAY_STAGES);

function remotePromptOverlayAuditError(reason) {
  return Object.assign(new Error(`remote prompt overlay audit metadata is invalid: ${reason}`), {
    code: "REMOTE_PROMPT_OVERLAY_AUDIT_INVALID",
  });
}

function remotePromptOverlayAudit({ tab, taskId, task, promptMode }) {
  if (promptMode !== "legacy") return null;
  const storyId = String(tab?.id || "").trim();
  const runTaskId = String(taskId || "").trim();
  if (!storyId || !runTaskId) return null;

  const conversation = store.getConversation(storyId);
  const candidates = (Array.isArray(conversation?.nodes) ? conversation.nodes : [])
    .filter((node) => node?.role === "user"
      && String(node.taskId || "").trim() === runTaskId
      && node.aiPromptTelemetry?.promptVariant === PROMPT_COMPATIBILITY_OVERLAY_VARIANT);
  if (!candidates.length) return null;

  const prompt = String(task ?? "");
  const promptSha256 = createHash("sha256").update(prompt, "utf8").digest("hex");
  const node = candidates.findLast((candidate) => candidate.aiPromptTelemetry?.sha256 === promptSha256);
  if (!node) throw remotePromptOverlayAuditError("prompt hash does not match the persisted observation");

  const observation = node.aiPromptTelemetry;
  const overlayStage = String(observation.overlayStage || "").trim().toUpperCase();
  const overlayVersion = String(observation.overlayVersion || "").trim();
  const overlayRolloutHash = String(observation.overlayRolloutHash || "").trim();
  const overlayTemplateFile = String(observation.overlayTemplateFile || "").trim();
  const overlayTemplateSha256 = String(observation.overlayTemplateSha256 || "").trim();
  if (observation.promptMode !== "legacy") {
    throw remotePromptOverlayAuditError("overlay promptMode must remain legacy");
  }
  if (String(observation.storyId || "").trim() !== storyId) {
    throw remotePromptOverlayAuditError("storyId does not match the remote tab");
  }
  if (!PROMPT_COMPATIBILITY_OVERLAY_STAGE_SET.has(overlayStage)) {
    throw remotePromptOverlayAuditError("overlay stage is unsupported");
  }
  if (overlayVersion !== PROMPT_COMPATIBILITY_OVERLAY_VERSION) {
    throw remotePromptOverlayAuditError("overlay version is unsupported");
  }
  if (!SHA256_RE.test(overlayRolloutHash)) {
    throw remotePromptOverlayAuditError("rollout hash is malformed");
  }
  if (overlayTemplateFile !== promptCompatibilityOverlayTemplateFiles[overlayStage]) {
    throw remotePromptOverlayAuditError("template file does not match the overlay stage");
  }
  if (!SHA256_RE.test(overlayTemplateSha256)) {
    throw remotePromptOverlayAuditError("template hash is malformed");
  }

  return Object.freeze({
    promptVariant: PROMPT_COMPATIBILITY_OVERLAY_VARIANT,
    overlayStage,
    overlayVersion,
    overlayRolloutHash,
    overlayTemplateFile,
    overlayTemplateSha256,
  });
}

const PATH_FIELDS = {
  search_files: ["path"],
  read_file: ["path"],
  list_dir: ["path"],
  git_status: ["path"],
  git_diff: ["path", "file"],
  write_file: ["path"],
  edit_file: ["path"],
  apply_patch: ["path"],
  run_command: ["path"],
  run_bash: ["path"],
  start_process: ["path"],
  run_tests: ["path"],
  read_binary_metadata: ["path"],
  inspect_image: ["path"],
  inspect_pdf: ["path", "output_dir"],
  list_archive: ["path"],
  extract_archive_entry: ["path", "output_path"],
  inspect_video: ["path", "output_dir"],
};

const ROOT_DEFAULT_PATH_TOOLS = new Set([
  "search_files",
  "list_dir",
  "git_status",
  "git_diff",
  "apply_patch",
  "run_command",
  "run_bash",
  "start_process",
  "run_tests",
  "read_binary_metadata",
  "inspect_image",
  "inspect_pdf",
  "list_archive",
  "extract_archive_entry",
  "inspect_video",
]);

const SUBAGENT_TOOL_MANIFEST = [
  {
    name: "spawn_subagent",
    description: "Start an independent verification/research subagent that shares the same client workspace policy. Use wait_subagent to collect its result.",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "Subagent task or question" },
        title: { type: "string", description: "Optional short label for audit/progress" },
      },
      required: ["task"],
    },
  },
  {
    name: "wait_subagent",
    description: "Wait for a spawned subagent and return its final summary/history when available.",
    parameters: {
      type: "object",
      properties: {
        subagent_id: { type: "string", description: "ID returned by spawn_subagent" },
        timeout_ms: { type: "integer", description: "Maximum wait time for this call, default 1000ms" },
      },
      required: ["subagent_id"],
    },
  },
  {
    name: "send_subagent_message",
    description: "Send an interrupt/follow-up message to a running subagent so it can re-plan at the next safe point.",
    parameters: {
      type: "object",
      properties: {
        subagent_id: { type: "string", description: "ID returned by spawn_subagent" },
        message: { type: "string", description: "Message to inject into the subagent" },
      },
      required: ["subagent_id", "message"],
    },
  },
];

function requestPath(url) {
  const parsed = new URL(String(url));
  return `${parsed.pathname}${parsed.search}`;
}

function authHeaders(token, request = {}) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  if (!token) return headers;
  const timestamp = String(Date.now());
  headers["X-Agent-V2-Timestamp"] = timestamp;
  headers["X-Agent-V2-Signature"] = agentRequestSignature({
    method: request.method || "GET",
    path: request.path || requestPath(request.url || "/"),
    timestamp,
    body: request.body ?? null,
    secret: token,
  });
  return headers;
}

function parseSseBlock(block) {
  let id = 0;
  let type = "message";
  let data = "";
  for (const line of String(block || "").split("\n")) {
    if (line.startsWith("id:")) id = Number(line.slice(3).trim()) || 0;
    else if (line.startsWith("event:")) type = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  if (!data) return null;
  try {
    const parsed = JSON.parse(data);
    return { id: parsed.id || id, type: parsed.type || type, data: parsed.data || parsed };
  } catch {
    return { id, type, data };
  }
}

async function postJson(url, token, body, signal) {
  const payload = body || {};
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(token, { method: "POST", url, body: payload }) },
    body: JSON.stringify(payload),
    signal: signal || undefined,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.ok === false) {
    throw new Error(data?.error || `HTTP ${response.status}`);
  }
  return data?.data || data;
}

async function postCancel(base, token, sessionId, reason) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    await postJson(`${base}/api/agent/v2/sessions/${sessionId}/cancel`, token, { reason }, controller.signal);
  } catch {
    // Best-effort cleanup: the caller is already aborting local work.
  } finally {
    clearTimeout(timer);
  }
}

export async function interruptRemoteAgentV2({ centerHost, token, sessionId, message, signal = null } = {}) {
  if (!centerHost) throw new Error("missing centerHost");
  if (!sessionId) throw new Error("missing sessionId");
  const base = String(centerHost).replace(/\/+$/, "");
  const controller = signal ? null : new AbortController();
  const timer = controller ? setTimeout(() => controller.abort(), 5000) : null;
  try {
    await postJson(`${base}/api/agent/v2/sessions/${sessionId}/interrupt`, token, {
      message: String(message || ""),
    }, signal || controller.signal);
    return true;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function toolFailed(result) {
  return /^(?:错误|工具执行异常|搜索失败|补丁校验失败|补丁应用失败|工具执行失败|error:)/i.test(String(result || ""));
}

function workspaceRoots(tab, project) {
  const refs = store.tabProjectPaths(tab || {});
  const source = refs.length
    ? refs
    : [
        project?.path ? { path: project.path, name: project.name || "main", role: "primary" } : null,
        project?.webAppPath ? { path: project.webAppPath, name: "WebApp", role: "webapp" } : null,
      ].filter(Boolean);
  const roots = [];
  let extraIndex = 1;
  for (const item of source) {
    if (!item?.path) continue;
    if (item.role === "primary") roots.push({ id: "main", name: item.name || "main", kind: "main", path: item.path });
    else if (item.role === "webapp") roots.push({ id: "webapp", name: item.name || "WebApp", kind: "webapp", path: item.path });
    else roots.push({ id: `extra-${extraIndex++}`, name: item.name || `extra-${extraIndex - 1}`, kind: "extra", path: item.path });
  }
  if (tab) {
    const storage = store.getStoryStoragePaths(tab, { create: true });
    if (!storage?.storyDirectory) throw new Error("StoryDev storage directory is unavailable");
    roots.push({
      id: "storydev",
      name: tab.title ? `StoryDev · ${tab.title}` : "StoryDev",
      kind: "storydev",
      path: storage.storyDirectory,
    });
  }
  return roots;
}

function truncateRuleContent(text) {
  const value = String(text || "");
  if (value.length <= MAX_RULE_CONTENT_CHARS) return { content: value, truncated: false };
  return {
    content: `${value.slice(0, MAX_RULE_CONTENT_CHARS)}\n...(truncated ${value.length - MAX_RULE_CONTENT_CHARS} chars)`,
    truncated: true,
  };
}

function workspaceRules(roots) {
  const rules = [];
  for (const root of roots) {
    for (const file of WORKSPACE_RULE_FILES) {
      const fullPath = path.join(root.path, file);
      try {
        if (!existsSync(fullPath)) continue;
        const stat = statSync(fullPath);
        if (!stat.isFile()) continue;
        if (stat.size > MAX_RULE_FILE_BYTES) {
          rules.push({
            rootId: root.id,
            file,
            skipped: true,
            reason: `rule file exceeds ${MAX_RULE_FILE_BYTES} bytes`,
            size: stat.size,
          });
          continue;
        }
        const { content, truncated } = truncateRuleContent(sanitizeToolResult(readFileSync(fullPath, "utf8"), roots));
        rules.push({
          rootId: root.id,
          file,
          content,
          truncated,
          size: stat.size,
        });
      } catch (error) {
        rules.push({
          rootId: root.id,
          file,
          skipped: true,
          reason: error.message,
        });
      }
    }
  }
  return rules;
}

function truncateDeclarationText(value, max = MAX_DECLARATION_TEXT_CHARS) {
  const text = String(value || "");
  return text.length > max ? `${text.slice(0, max)}\n...(truncated ${text.length - max} chars)` : text;
}

function skillDeclaration() {
  try {
    const doc = getCapabilityDoc();
    const capabilities = Array.isArray(doc.capabilities) ? doc.capabilities : [];
    return {
      available: capabilities.length > 0,
      count: capabilities.length,
      truncated: capabilities.length > MAX_DECLARED_SKILLS,
      engines: Array.isArray(doc.engines) ? doc.engines.map(String) : [],
      summary: truncateDeclarationText(doc.summary || ""),
      skills: capabilities.slice(0, MAX_DECLARED_SKILLS).map((cap) => ({
        id: String(cap.skill || ""),
        name: String(cap.name || cap.skill || ""),
        description: truncateDeclarationText(cap.description || "", 500),
        triggers: Array.isArray(cap.triggers) ? cap.triggers.map(String).slice(0, 20) : [],
        isModification: !!cap.isModification,
        engine: String(cap.engine || "auto"),
      })).filter((cap) => cap.id),
    };
  } catch (error) {
    return { available: false, error: error.message || String(error) };
  }
}

function normalizeMcpName(raw) {
  let name = String(raw || "").trim();
  if (!name) return "";
  if ((name.startsWith("\"") && name.endsWith("\"")) || (name.startsWith("'") && name.endsWith("'"))) {
    name = name.slice(1, -1);
  }
  return name.replace(/\\(["'\\])/g, "$1").trim().slice(0, 120);
}

function parseCodexMcpServers(text) {
  const names = new Set();
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = line.match(/^\s*\[\s*mcp_servers\s*\.\s*(.+?)\s*\]\s*$/);
    if (!match) continue;
    const name = normalizeMcpName(match[1]);
    if (name) names.add(name);
  }
  return [...names].slice(0, MAX_MCP_SERVERS);
}

function collectClaudeMcpServers(value, names = new Set(), depth = 0) {
  if (!value || typeof value !== "object" || depth > 5) return names;
  if (value.mcpServers && typeof value.mcpServers === "object" && !Array.isArray(value.mcpServers)) {
    for (const name of Object.keys(value.mcpServers)) {
      const normalized = normalizeMcpName(name);
      if (normalized) names.add(normalized);
    }
  }
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") collectClaudeMcpServers(child, names, depth + 1);
  }
  return names;
}

function parseClaudeMcpServers(text) {
  try {
    return [...collectClaudeMcpServers(JSON.parse(String(text || "")))].slice(0, MAX_MCP_SERVERS);
  } catch {
    return [];
  }
}

function readMcpProvider(provider, file, parser) {
  try {
    if (!existsSync(file)) return null;
    const stat = statSync(file);
    if (!stat.isFile()) return null;
    if (stat.size > MAX_MCP_CONFIG_BYTES) {
      return { provider, configured: false, serverCount: 0, servers: [], redacted: true, skipped: true, reason: "config too large" };
    }
    const servers = parser(readFileSync(file, "utf8"));
    return {
      provider,
      configured: servers.length > 0,
      serverCount: servers.length,
      servers,
      redacted: true,
    };
  } catch (error) {
    return { provider, configured: false, serverCount: 0, servers: [], redacted: true, error: error.message || String(error) };
  }
}

function mcpDeclaration() {
  const home = homedir();
  const codexHome = process.env.CODEX_HOME || path.join(home, ".codex");
  const sources = [
    ["codex", path.join(codexHome, "config.toml"), parseCodexMcpServers],
    ["claude", path.join(home, ".claude.json"), parseClaudeMcpServers],
    ["claude", path.join(home, ".claude", "settings.json"), parseClaudeMcpServers],
  ];
  const providers = sources
    .map(([provider, file, parser]) => readMcpProvider(provider, file, parser))
    .filter(Boolean);
  const appMarketRuntime = inspectAppMarketMcpRuntime();
  providers.push({
    provider: "devbench",
    configured: true,
    ready: appMarketRuntime.ok,
    serverCount: 1,
    servers: [APPMARKET_MCP_REGISTRATION_ID],
    redacted: true,
    ...(appMarketRuntime.ok ? {} : { error: appMarketRuntime.problems.join("；") }),
  });
  const totalServers = providers.reduce((sum, item) => sum + (Number(item.serverCount) || 0), 0);
  return {
    available: totalServers > 0,
    totalServers,
    providers,
    note: "Only MCP server names are declared. Commands, URLs, env values, tokens, and local config paths are not uploaded.",
  };
}

function clientCapabilityDeclaration(definitions, ctx, { includeSubagents = true } = {}) {
  const tools = toolDefinitionsToManifest(definitions).map((tool) => tool.name).filter(Boolean);
  return {
    protocolFeatures: {
      clientDrivenTools: true,
      reverseExecutorRequired: false,
      callIdResultCache: true,
      artifactUpload: true,
      interrupts: true,
      subagents: includeSubagents,
    },
    toolRegistry: {
      count: tools.length,
      tools,
      commandPolicy: ctx.commandPolicy || "workspace",
      workspaceIsolation: ctx.workspaceIsolation !== false,
      longProcesses: tools.includes("start_process") && tools.includes("poll_process") && tools.includes("stop_process"),
      mediaArtifacts: tools.filter((name) => ["inspect_image", "inspect_pdf", "inspect_video", "list_archive", "extract_archive_entry", "read_binary_metadata"].includes(name)),
    },
    skills: skillDeclaration(),
    mcp: mcpDeclaration(),
  };
}

function workspaceFor(tab, project, definitions = [], ctx = {}, opts = {}) {
  const fullRoots = workspaceRoots(tab, project);
  const roots = fullRoots.map(({ id, name, kind }) => ({ id, name, kind }));
  return {
    storyId: tab?.id || "",
    title: tab?.title || "",
    phase: tab?.workflow?.phase || "",
    roots,
    rules: workspaceRules(fullRoots),
    capabilities: clientCapabilityDeclaration(definitions, ctx, opts),
  };
}

function toolContext(tab, project, signal, taskId = "", commandPolicy = "") {
  const cfg = getConfig();
  const dist = cfg.distributedExecution || {};
  const apiCfg = cfg.apiAgent || {};
  const storyStorage = tab ? store.getStoryStoragePaths(tab, { create: true }) : null;
  const persistedTab = tab ? store.getTab(tab.id) : null;
  const currentTab = persistedTab || tab || null;
  const explicitTaskId = String(taskId || "").trim();
  const persistedTaskId = String(currentTab?.runningTaskId || "").trim();
  if (explicitTaskId && (!persistedTaskId || explicitTaskId !== persistedTaskId)) {
    throw new Error(
      persistedTaskId
        ? "Agent V2 taskId 与故事点当前运行任务不一致"
        : "Agent V2 故事点没有可验证的运行中任务",
    );
  }
  if (explicitTaskId && !isStoryTaskAiLeaseActive(currentTab, explicitTaskId)) {
    throw new Error("Agent V2 taskId 没有对应的活动 AI/worktree 租约");
  }
  return {
    cwd: project.path,
    allowedRoots: workspaceRoots(tab, project).map((item) => item.path).filter((item) => item && item !== project.path),
    tempRoot: storyStorage?.tempDirectory || "",
    artifactScope: currentTab ? {
      kind: "story",
      id: String(currentTab.id || ""),
      title: String(currentTab.title || ""),
      docSlug: String(storyStorage?.docSlug || currentTab.docSlug || ""),
    } : null,
    storyTaskId: explicitTaskId,
    workspaceIsolation: apiCfg.workspaceIsolation !== false,
    commandPolicy: commandPolicy === "read_only"
      ? "read_only"
      : (dist.commandPolicy || apiCfg.commandPolicy || "workspace"),
    signal: signal || null,
  };
}

function isAbsoluteLike(value) {
  const raw = String(value || "").trim();
  return path.isAbsolute(raw) || path.win32.isAbsolute(raw) || path.posix.isAbsolute(raw) || /^[a-zA-Z]:[\\/]/.test(raw) || /^\\\\/.test(raw);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rootById(roots, id) {
  return roots.find((root) => root.id === id) || null;
}

function parseRootPrefixedPath(value, roots) {
  const raw = String(value || "");
  const match = raw.match(/^([A-Za-z][A-Za-z0-9_-]*):[\\/]*(.*)$/);
  if (!match) return null;
  const root = rootById(roots, match[1]);
  return root ? { root, relPath: match[2] || "." } : null;
}

function safeJoinRoot(root, relPath) {
  const raw = String(relPath == null || relPath === "" ? "." : relPath);
  if (raw.includes("\0")) throw new Error("path contains NUL byte");
  if (isAbsoluteLike(raw)) throw new Error("Agent V2 tool paths must use rootId + relative path, not client absolute paths");
  if (raw.split(/[\\/]+/).includes("..")) throw new Error("Agent V2 tool paths cannot contain ..");
  return path.join(root.path, raw);
}

function normalizeWorkspaceArgs(name, args, roots) {
  const out = { ...(args || {}) };
  let selectedRoot = rootById(roots, String(out.rootId || out.workspaceId || out.root || "main"));
  for (const field of PATH_FIELDS[name] || []) {
    const parsed = out[field] != null ? parseRootPrefixedPath(out[field], roots) : null;
    if (parsed) selectedRoot = parsed.root;
  }
  if (!selectedRoot && (out.rootId || out.workspaceId || out.root)) {
    throw new Error(`unknown workspace rootId: ${out.rootId || out.workspaceId || out.root}`);
  }
  delete out.rootId;
  delete out.workspaceId;
  delete out.root;
  const fields = PATH_FIELDS[name] || [];
  for (const field of fields) {
    if (out[field] == null || out[field] === "") {
      if (field === "path" && selectedRoot && ROOT_DEFAULT_PATH_TOOLS.has(name)) out[field] = selectedRoot.path;
      continue;
    }
    const parsed = parseRootPrefixedPath(out[field], roots);
    const root = parsed?.root || selectedRoot;
    if (root) out[field] = safeJoinRoot(root, parsed?.relPath ?? out[field]);
    else if (isAbsoluteLike(out[field])) throw new Error("Agent V2 tool paths cannot use client absolute paths");
  }
  return out;
}

function sanitizeToolResult(text, roots) {
  let out = String(text || "");
  for (const root of roots) {
    const resolved = path.resolve(root.path).replace(/[\\/]+$/, "");
    const forms = [...new Set([resolved, resolved.replace(/\\/g, "/"), resolved.replace(/\//g, "\\")])].sort((a, b) => b.length - a.length);
    for (const form of forms) {
      if (!form) continue;
      out = out.replace(new RegExp(`${escapeRegExp(form)}([\\\\/])?`, "gi"), `${root.id}:/`);
    }
  }
  return out;
}

function publicPathRef(args = {}, roots) {
  const parsed = args.path != null ? parseRootPrefixedPath(args.path, roots) : null;
  const rootId = String(args.rootId || args.workspaceId || args.root || parsed?.root?.id || "main");
  const rel = String(parsed?.relPath || args.path || ".").replace(/\\/g, "/").replace(/^\/+/, "");
  return `${rootId}:/${rel || "."}`;
}

function normalizedLocalPath(value) {
  const resolved = path.resolve(String(value || ""));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isWithinLocalRoot(root, target) {
  const rel = path.relative(normalizedLocalPath(root.path), normalizedLocalPath(target));
  return rel === "" || (rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function publicRefForLocalPath(file, roots) {
  const root = roots.find((item) => isWithinLocalRoot(item, file));
  if (!root) throw new Error("generated artifact is outside workspace roots");
  const rel = path.relative(path.resolve(root.path), path.resolve(file)).replace(/\\/g, "/");
  return `${root.id}:/${rel || "."}`;
}

function buildToolManifest(definitions, roots, { includeSubagents = true, requireRootId = false } = {}) {
  const rootIds = roots.map((root) => root.id);
  const manifest = toolDefinitionsToManifest(definitions).map((tool) => {
    if (!PATH_FIELDS[tool.name]) return tool;
    const parameters = {
      ...(tool.parameters || { type: "object" }),
      properties: {
        ...((tool.parameters || {}).properties || {}),
        rootId: {
          type: "string",
          enum: rootIds,
          description: "Logical workspace root. Use main for the primary repo, storydev for this story's external files, webapp for WebApp, or extra-N for related repos. Do not send client absolute paths.",
        },
      },
      ...(requireRootId ? { required: [...new Set([...((tool.parameters || {}).required || []), "rootId"])] } : {}),
    };
    return { ...tool, parameters };
  });
  return includeSubagents ? [...manifest, ...SUBAGENT_TOOL_MANIFEST] : manifest;
}

function safeCacheName(value) {
  const name = String(value || "").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120);
  return name || "session";
}

function toolResultCacheFile(tab, project, sessionId) {
  if (tab) {
    try {
      const storage = store.getStoryStoragePaths(tab, { create: true });
      if (storage?.tempDirectory) {
        return path.join(storage.tempDirectory, "agent-v2-tool-results", `${safeCacheName(sessionId)}.json`);
      }
    } catch {
      // Cache persistence is best effort, but a story-scoped run must never
      // fall back to writing generated files into the source repository.
    }
    return "";
  }
  const directory = ensureExternalTempDirectory(["aiefficiency", "agent-v2-tool-results"], {
    avoidRoots: [project?.path],
  });
  return path.join(directory, `${safeCacheName(sessionId)}.json`);
}

function loadToolResultCache(tab, project, sessionId) {
  try {
    const file = toolResultCacheFile(tab, project, sessionId);
    if (!file || !existsSync(file)) return new Map();
    if (tab) {
      const storage = store.getStoryStoragePaths(tab, { create: true });
      store.validateStoryStorageTarget(tab, file, {
        baseDirectory: storage.tempDirectory,
        mustExist: true,
        expectedType: "file",
      });
    }
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return new Map(Object.entries(parsed.results || {}));
  } catch {
    return new Map();
  }
}

function saveToolResultCache(tab, project, sessionId, cache) {
  try {
    const file = toolResultCacheFile(tab, project, sessionId);
    if (!file) return;
    if (tab) {
      const storage = store.getStoryStoragePaths(tab, { create: true });
      store.validateStoryStorageTarget(tab, file, {
        baseDirectory: storage.tempDirectory,
        createParentDirectories: true,
        mustExist: false,
      });
    } else {
      mkdirSync(path.dirname(file), { recursive: true });
    }
    const entries = [...cache.entries()].slice(-MAX_CACHED_TOOL_RESULTS);
    writeFileSync(file, JSON.stringify({ version: 1, savedAt: Date.now(), results: Object.fromEntries(entries) }, null, 2), "utf8");
    if (tab) {
      const storage = store.getStoryStoragePaths(tab, { create: true });
      store.validateStoryStorageTarget(tab, file, {
        baseDirectory: storage.tempDirectory,
        mustExist: true,
        expectedType: "file",
      });
    }
  } catch {
    // Cache loss only affects retry idempotency; tool execution still proceeds.
  }
}

function timeoutResult(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timedOut: true }), ms);
    timer.unref?.();
  });
}

function subagentPublicResult(record) {
  return {
    subagentId: record.id,
    status: record.status,
    title: record.title,
    remoteAgentSessionId: record.remoteAgentSessionId || null,
    result: record.result || null,
    error: record.error || null,
  };
}

async function executeSubagentTool(name, args, runtime) {
  const { subagents, base, token, tab, project, engine, maxRounds, signal, onEvent, subagentDepth, maxSubagentDepth, taskId, commandPolicy } = runtime;
  if (!subagents) throw new Error("subagent registry is unavailable");
  if (name === "spawn_subagent") {
    if (subagentDepth >= maxSubagentDepth) throw new Error("subagent depth limit reached");
    const task = String(args.task || args.content || args.message || "").trim();
    if (!task) throw new Error("subagent task is required");
    const id = `subagent-${subagents.nextId++}`;
    const record = {
      id,
      title: String(args.title || id),
      status: "running",
      remoteAgentSessionId: "",
      pendingInterrupts: [],
      result: null,
      error: null,
      promise: null,
    };
    subagents.items.set(id, record);
    record.promise = runRemoteAgentV2({
      centerHost: base,
      token,
      task,
      taskId,
      tab,
      project,
      engine,
      maxRounds,
      commandPolicy,
      signal,
      subagents,
      subagentDepth: subagentDepth + 1,
      maxSubagentDepth,
      onSession: async (session) => {
        record.remoteAgentSessionId = session.id;
        for (const message of record.pendingInterrupts.splice(0)) {
          await interruptRemoteAgentV2({ centerHost: base, token, sessionId: session.id, message });
        }
      },
      onEvent: (event) => {
        onEvent?.({ type: "subagent_event", id: event.id || 0, data: { subagentId: id, event } });
      },
    })
      .then((result) => {
        record.status = result.ok === false ? "failed" : "completed";
        record.result = result;
        return result;
      })
      .catch((error) => {
        record.status = "failed";
        record.error = error.message || String(error);
        throw error;
      });
    record.promise.catch(() => {});
    return { ok: true, result: JSON.stringify(subagentPublicResult(record)) };
  }
  if (name === "wait_subagent") {
    const id = String(args.subagent_id || args.subagentId || args.id || "");
    const record = subagents.items.get(id);
    if (!record) throw new Error(`unknown subagent: ${id}`);
    const timeoutMs = Math.max(0, Math.min(60_000, Number(args.timeout_ms || DEFAULT_SUBAGENT_TIMEOUT_MS)));
    const outcome = timeoutMs > 0 ? await Promise.race([record.promise, timeoutResult(timeoutMs)]) : await record.promise;
    if (outcome?.timedOut) return { ok: true, result: JSON.stringify(subagentPublicResult(record)) };
    return { ok: record.status !== "failed", result: JSON.stringify(subagentPublicResult(record)) };
  }
  if (name === "send_subagent_message") {
    const id = String(args.subagent_id || args.subagentId || args.id || "");
    const message = String(args.message || args.content || "").trim();
    if (!message) throw new Error("subagent message is required");
    const record = subagents.items.get(id);
    if (!record) throw new Error(`unknown subagent: ${id}`);
    if (record.remoteAgentSessionId) {
      await interruptRemoteAgentV2({ centerHost: base, token, sessionId: record.remoteAgentSessionId, message, signal });
    } else {
      record.pendingInterrupts.push(message);
    }
    return { ok: true, result: JSON.stringify({ subagentId: id, status: record.status, messageQueued: !record.remoteAgentSessionId }) };
  }
  throw new Error(`unknown subagent tool: ${name}`);
}

async function inspectImageWithVision({ base, token, sessionId, call, mappedArgs, roots, ctx, signal }) {
  const metadataResult = await executeTool("inspect_image", mappedArgs, ctx);
  const metadataText = typeof metadataResult === "string" ? metadataResult : JSON.stringify(metadataResult);
  if (toolFailed(metadataText)) return { ok: false, result: sanitizeToolResult(metadataText, roots) };
  let metadata;
  try { metadata = JSON.parse(metadataText); } catch { metadata = { note: metadataText }; }
  const stat = statSync(mappedArgs.path);
  if (stat.size > MAX_IMAGE_UPLOAD_BYTES) {
    return {
      ok: false,
      result: JSON.stringify({
        ref: publicPathRef(call.arguments || {}, roots),
        metadata,
        error: `image is too large to upload for vision (${stat.size} bytes > ${MAX_IMAGE_UPLOAD_BYTES})`,
      }),
    };
  }
  const base64 = readFileSync(mappedArgs.path).toString("base64");
  const artifact = await postJson(`${base}/api/agent/v2/sessions/${sessionId}/artifacts`, token, {
    type: "image",
    inspect: true,
    name: path.basename(mappedArgs.path),
    mime: metadata.mime || "application/octet-stream",
    size: metadata.size || stat.size,
    sha256: metadata.sha256 || "",
    ref: publicPathRef(call.arguments || {}, roots),
    prompt: call.arguments?.prompt || "Describe this image, including visible text/OCR and relevant UI state.",
    base64,
  }, signal);
  const vision = artifact.analysis || null;
  const ok = vision?.ok !== false;
  return {
    ok,
    result: JSON.stringify({
      ref: artifact.ref,
      metadata: { ...metadata, path: artifact.ref },
      vision,
      artifactId: artifact.id,
    }),
  };
}

function resolveGeneratedFramePath(framePath, project, roots) {
  const raw = String(framePath || "");
  const candidate = isAbsoluteLike(raw) ? path.resolve(raw) : path.resolve(project.path, raw);
  publicRefForLocalPath(candidate, roots);
  return candidate;
}

async function inspectVideoWithVision({ base, token, sessionId, call, mappedArgs, roots, ctx, project, signal }) {
  const videoResult = await executeTool("inspect_video", mappedArgs, ctx);
  const videoText = typeof videoResult === "string" ? videoResult : JSON.stringify(videoResult);
  if (toolFailed(videoText)) return { ok: false, result: sanitizeToolResult(videoText, roots) };
  let video;
  try { video = JSON.parse(videoText); } catch { return { ok: true, result: videoText }; }
  const frames = Array.isArray(video.frames) ? video.frames : [];
  for (const frame of frames) {
    if (!frame?.ok || !frame.path) continue;
    try {
      const framePath = resolveGeneratedFramePath(frame.path, project, roots);
      const ref = publicRefForLocalPath(framePath, roots);
      const prompt = call.arguments?.frame_prompt
        || call.arguments?.prompt
        || `Analyze this video frame at ${frame.timestamp ?? "unknown"} seconds. Include OCR, UI state, and relevant visual evidence.`;
      const inspected = await inspectImageWithVision({
        base,
        token,
        sessionId,
        call: { arguments: { path: ref, prompt } },
        mappedArgs: { path: framePath },
        roots,
        ctx,
        signal,
      });
      const payload = JSON.parse(inspected.result);
      frame.path = ref;
      frame.ref = payload.ref || ref;
      frame.artifactId = payload.artifactId || null;
      frame.vision = payload.vision || null;
      if (inspected.ok === false) frame.ok = false;
    } catch (error) {
      frame.vision = { ok: false, error: error.message };
    }
  }
  return {
    ok: frames.every((frame) => frame?.vision?.ok !== false),
    result: JSON.stringify(video),
  };
}

async function inspectPdfWithVision({ base, token, sessionId, call, mappedArgs, roots, ctx, project, signal }) {
  const pdfResult = await executeTool("inspect_pdf", mappedArgs, ctx);
  const pdfText = typeof pdfResult === "string" ? pdfResult : JSON.stringify(pdfResult);
  if (toolFailed(pdfText)) return { ok: false, result: sanitizeToolResult(pdfText, roots) };
  let pdf;
  try { pdf = JSON.parse(pdfText); } catch { return { ok: true, result: pdfText }; }
  const pages = Array.isArray(pdf.renderedPages) ? pdf.renderedPages : [];
  for (const page of pages) {
    if (!page?.ok || !page.path) continue;
    try {
      const pagePath = resolveGeneratedFramePath(page.path, project, roots);
      const ref = publicRefForLocalPath(pagePath, roots);
      const prompt = call.arguments?.page_prompt
        || call.arguments?.prompt
        || `Analyze rendered PDF page ${page.page ?? "unknown"}. Include OCR, layout, and relevant visual evidence.`;
      const inspected = await inspectImageWithVision({
        base,
        token,
        sessionId,
        call: { arguments: { path: ref, prompt } },
        mappedArgs: { path: pagePath },
        roots,
        ctx,
        signal,
      });
      const payload = JSON.parse(inspected.result);
      page.path = ref;
      page.ref = payload.ref || ref;
      page.artifactId = payload.artifactId || null;
      page.vision = payload.vision || null;
      if (inspected.ok === false) page.ok = false;
    } catch (error) {
      page.vision = { ok: false, error: error.message };
    }
  }
  return {
    ok: pages.every((page) => page?.vision?.ok !== false),
    result: JSON.stringify(pdf),
  };
}

function tryParseJson(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed || !/^[\[{]/.test(trimmed)) return null;
  try { return JSON.parse(trimmed); } catch { return null; }
}

function parseFormattedCommandResult(text) {
  const value = String(text || "");
  const exitMatch = value.match(/^exit_code:\s*(unknown|-?\d+)/m);
  const timedOut = /^timed_out:\s*true\b/m.test(value);
  const aborted = /^aborted:\s*true\b/m.test(value);
  const outputMarker = "\noutput:\n";
  const outputIndex = value.indexOf(outputMarker);
  return {
    exitCode: exitMatch && exitMatch[1] !== "unknown" ? Number(exitMatch[1]) : null,
    timedOut,
    aborted,
    output: outputIndex >= 0 ? value.slice(outputIndex + outputMarker.length) : "",
  };
}

function clientToolResultPayload(name, text, ok) {
  const payload = {
    status: ok ? "completed" : "failed",
    ok,
    result: text,
  };
  if (["run_command", "run_bash", "run_tests"].includes(name)) {
    const parsed = parseFormattedCommandResult(text);
    const failed = parsed.timedOut || parsed.aborted || (parsed.exitCode != null && parsed.exitCode !== 0);
    return {
      ...payload,
      status: parsed.timedOut ? "timeout" : failed ? "failed" : "completed",
      ok: ok && !failed,
      exitCode: parsed.exitCode,
      stdout: parsed.output,
    };
  }
  const json = tryParseJson(text);
  if (json && name === "poll_process") {
    const status = String(json.status || payload.status);
    const failed = ["failed", "error", "timeout", "cancelled", "stopped"].includes(status);
    return {
      ...payload,
      status,
      ok: ok && !failed,
      exitCode: json.exit_code ?? null,
      stdout: json.output == null ? "" : String(json.output),
      truncated: !!json.truncated,
      nextCursor: json.nextCursor ?? json.next_cursor ?? null,
    };
  }
  if (json && name === "start_process") {
    return {
      ...payload,
      status: String(json.status || "running"),
    };
  }
  return payload;
}

async function executeClientTool(event, runtime) {
  const { tab, project, signal, base, token, sessionId, taskId, commandPolicy, stageToolPolicy } = runtime;
  const call = event.data || {};
  const name = call.name;
  const roots = workspaceRoots(tab, project);
  let text;
  let ok = true;
  try {
    const requestedArgs = stageToolPolicy
      ? authorizeWorkflowV2StageToolCall(stageToolPolicy, name, call.arguments || {}).args
      : (call.arguments || {});
    if (SUBAGENT_TOOL_MANIFEST.some((tool) => tool.name === name)) {
      const result = await executeSubagentTool(name, requestedArgs, runtime);
      return {
        callId: call.callId,
        status: result.ok ? "completed" : "failed",
        ok: result.ok,
        result: result.result,
      };
    }
    const args = normalizeWorkspaceArgs(name, requestedArgs, roots);
    const ctx = toolContext(tab, project, signal, taskId, commandPolicy);
    if (name === "inspect_image") {
      const inspected = await inspectImageWithVision({ base, token, sessionId, call, mappedArgs: args, roots, ctx, signal });
      ok = inspected.ok;
      text = sanitizeToolResult(inspected.result, roots);
    } else if (name === "inspect_pdf") {
      const inspected = await inspectPdfWithVision({ base, token, sessionId, call, mappedArgs: args, roots, ctx, project, signal });
      ok = inspected.ok;
      text = sanitizeToolResult(inspected.result, roots);
    } else if (name === "inspect_video") {
      const inspected = await inspectVideoWithVision({ base, token, sessionId, call, mappedArgs: args, roots, ctx, project, signal });
      ok = inspected.ok;
      text = sanitizeToolResult(inspected.result, roots);
    } else {
      const result = await executeTool(name, args, ctx);
      const serialized = typeof result === "string" ? result : JSON.stringify(result);
      text = stageToolPolicy
        ? sanitizeWorkflowV2StageToolResult(stageToolPolicy, serialized)
        : sanitizeToolResult(serialized, roots);
      ok = !toolFailed(text);
    }
    if (stageToolPolicy && ["inspect_image", "inspect_pdf", "inspect_video"].includes(name)) {
      text = sanitizeWorkflowV2StageToolResult(stageToolPolicy, text);
    }
  } catch (error) {
    text = `工具执行异常: ${error.message}`;
    ok = false;
  }
  return {
    callId: call.callId,
    ...clientToolResultPayload(name, text, ok),
  };
}

export async function runRemoteAgentV2({
  centerHost,
  token,
  task,
  taskId = "",
  tab,
  project,
  engine,
  maxRounds,
  commandPolicy = "",
  stageToolPolicy = null,
  remoteAgentSessionId = "",
  remoteAgentLastEventId = 0,
  promptMode = "legacy",
  promptSha256 = "",
  telemetryContext = null,
  signal = null,
  onSession = null,
  onEvent = null,
  subagents = null,
  subagentDepth = 0,
  maxSubagentDepth = 1,
} = {}) {
  if (!centerHost) throw new Error("missing centerHost");
  if (!project?.path) throw new Error("missing project path");
  const base = String(centerHost).replace(/\/+$/, "");
  const effectiveCommandPolicy = stageToolPolicy?.readOnly === true ? "read_only" : commandPolicy;
  const ctx = toolContext(tab, project, signal, taskId, effectiveCommandPolicy);
  const roots = workspaceRoots(tab, project);
  const subagentRegistry = subagents || { nextId: 1, items: new Map() };
  let toolDefinitions = [
    ...getToolDefinitions(ctx),
    ...await getAppMarketMcpOpenAiTools(),
  ];
  if (stageToolPolicy) {
    const allowed = new Set(Array.isArray(stageToolPolicy.allowedToolNames) ? stageToolPolicy.allowedToolNames : []);
    toolDefinitions = toolDefinitions.filter((definition) => {
      const name = String(definition?.function?.name || definition?.name || "");
      return allowed.has(name);
    });
  }
  const includeSubagents = !stageToolPolicy && subagentDepth < maxSubagentDepth;
  const toolManifest = buildToolManifest(toolDefinitions, roots, {
    includeSubagents,
    requireRootId: !!stageToolPolicy,
  });
  const effectiveMaxRounds = stageToolPolicy && Number.isSafeInteger(stageToolPolicy.maxToolIterations)
    ? Math.max(1, Math.min(Number(maxRounds) || 1, stageToolPolicy.maxToolIterations + 1))
    : maxRounds;
  const session = await postJson(`${base}/api/agent/v2/sessions`, token, {
    id: remoteAgentSessionId || undefined,
    engine,
    maxRounds: effectiveMaxRounds,
    commandPolicy: ctx.commandPolicy,
    workspace: workspaceFor(tab, project, toolDefinitions, ctx, { includeSubagents }),
    toolManifest,
  }, signal);
  onSession?.(session);

  let cancelPromise = null;
  const scheduleCancel = (reason) => {
    if (cancelPromise) return cancelPromise;
    cancelPromise = postCancel(base, token, session.id, reason);
    return cancelPromise;
  };
  const onAbort = () => {
    scheduleCancel("client aborted");
  };
  signal?.addEventListener?.("abort", onAbort, { once: true });
  if (signal?.aborted) scheduleCancel("client aborted");

  try {
    let finalEvent = null;
    let lastEventId = Number(remoteAgentLastEventId) || 0;
    let eventCursor = lastEventId;
    if (session.status === "waiting_tool") {
      eventCursor = 0;
      lastEventId = 0;
    } else if ((session.lastEventId || 0) < eventCursor) {
      eventCursor = 0;
      lastEventId = 0;
    }
    const handledCalls = new Set();
    const history = [];
    const cachedToolResults = loadToolResultCache(tab, project, session.id);
    const shouldStartTurn = !["running", "thinking", "waiting_tool"].includes(session.status);
    const promptOverlayAudit = shouldStartTurn
      ? remotePromptOverlayAudit({ tab, taskId, task, promptMode })
      : null;
    let eventsError = null;
    const eventsPromise = (async () => {
      const response = await fetch(`${base}/api/agent/v2/sessions/${session.id}/events?after=${encodeURIComponent(eventCursor)}`, {
        headers: authHeaders(token, { method: "GET", url: `${base}/api/agent/v2/sessions/${session.id}/events?after=${encodeURIComponent(eventCursor)}` }),
        signal: signal || undefined,
      });
      if (!response.ok || !response.body) throw new Error(`Agent V2 events failed: HTTP ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() || "";
        for (const part of parts) {
          if (!part.trim() || part.trimStart().startsWith(":")) continue;
          const event = parseSseBlock(part);
          if (!event) continue;
          lastEventId = Math.max(lastEventId, event.id || 0);
          onEvent?.(event);
          if (event.type === "tool_call") {
            const callId = event.data?.callId;
            if (!callId || handledCalls.has(callId)) continue;
            handledCalls.add(callId);
            let result = cachedToolResults.get(callId);
            if (!result) {
              result = await executeClientTool(event, {
                tab,
                project,
                taskId,
                signal,
                base,
                token,
                sessionId: session.id,
                engine,
                maxRounds,
                commandPolicy: effectiveCommandPolicy,
                stageToolPolicy,
                onEvent,
                subagents: subagentRegistry,
                subagentDepth,
                maxSubagentDepth,
              });
              cachedToolResults.set(callId, result);
              saveToolResultCache(tab, project, session.id, cachedToolResults);
            }
            history.push({
              tool: event.data.name,
              args: event.data.arguments || {},
              thought: event.data.thought || "",
              ok: result.ok,
              result: result.result,
            });
            await postJson(`${base}/api/agent/v2/sessions/${session.id}/tool-results`, token, result, signal);
            onEvent?.({ type: "tool_result", id: lastEventId, data: { ...result, name: event.data.name } });
          } else if (event.type === "final") {
            finalEvent = event;
            try { await reader.cancel(); } catch {}
            return;
          } else if (event.type === "error") {
            const msg = event.data?.error || event.data?.message || "Agent V2 failed";
            throw new Error(msg);
          }
        }
      }
    })().catch((error) => {
      eventsError = error;
    });

    if (shouldStartTurn) {
      await postJson(`${base}/api/agent/v2/sessions/${session.id}/turn`, token, {
        content: task,
        promptMode,
        ...(promptOverlayAudit || {}),
        ...(promptMode === "compatibility" ? {
          promptSha256,
          telemetryContext,
        } : {}),
      }, signal);
    }
    await eventsPromise;
    if (eventsError) throw eventsError;
    if (!finalEvent) throw new Error("Agent V2 session ended without final event");
    const data = finalEvent.data || {};
    return {
      ok: data.status !== "failed",
      summary: data.summary || "",
      history: Array.isArray(data.history) ? data.history : history,
      usage: data.usage || null,
      aiSnapshot: data.aiSnapshot || session.aiSnapshot || null,
      remoteAgentSessionId: session.id,
      remoteAgentLastEventId: lastEventId,
      lastEventId,
    };
  } finally {
    signal?.removeEventListener?.("abort", onAbort);
    if (signal?.aborted) await scheduleCancel("client aborted");
  }
}
