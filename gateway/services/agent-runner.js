import { spawn, execFile } from "child_process";
import { writeFileSync, readFileSync, unlinkSync, existsSync, watch } from "fs";
import { join, dirname, isAbsolute } from "path";
import { fileURLToPath } from "url";
import {
  addTokenUsage,
  getTask,
  hasActiveTaskRuntimeLease,
  hasActiveWorktreeResourceLeaseForTask,
  listRuntimeStateTaskIds,
  listTaskRuntimeLeases,
  removeTaskRuntimeLease,
  settleInactiveTaskRuntimeState,
  updateTask,
  upsertTaskRuntimeLease,
} from "../db/sqlite.js";
import { startProcessTreeWatchdog } from "./process-watchdog.js";
import { isSameLiveProcess, isSameLiveProcessAsync, captureProcessIdentityAsync } from "./process-identity.js";
import { log, broadcastTaskUpdate, broadcastAgentStatus, broadcastLoginRequired, broadcastTaskDispatched, broadcastChatStream, broadcastChatStreamEnd, broadcastSkillsChanged } from "./logger.js";
import { upsertAgent, updateAgentStatus } from "../db/sqlite.js";
import { dispatch, getFallbackEngine } from "./dispatcher.js";
import { getConfig } from "./config.js";
import { createHash, randomUUID } from "crypto";
import { homedir } from "os";
import { normalizeCodexJsonEvent } from "./codex-json-stream.js";
import { createUtf8StreamDecoder } from "./utf8-stream-decoder.js";
import {
  ensureExternalTempDirectory,
  ensurePlainExternalChildDirectory,
} from "./external-temp.js";
import {
  buildClaudeOfficialSpawnEnv,
  buildClaudeVolcengineSpawnEnv,
  ensureClaudeVolcengineTrust,
  isClaudeCliEngine,
  isClaudeVolcengineEngine,
  normalizeClaudeVolcengineModelId,
} from "./claude-volcengine.js";
import {
  buildClaudeMinimaxSpawnEnv,
  ensureClaudeMinimaxTrust,
  isClaudeMinimaxEngine,
} from "./claude-minimax.js";
import {
  buildCodexAppServerSpawnEnv,
  buildCodexMinimaxSpawnEnv,
  buildCodexOfficialSpawnEnv,
  isCodexMinimaxEngine,
} from "./codex-minimax.js";
import {
  buildClaudeAtlasSpawnEnv,
  buildCodexAtlasSpawnEnv,
  buildHermesAtlasSpawnEnv,
  ensureClaudeAtlasTrust,
  isAtlasStoryEngine,
  isClaudeAtlasEngine,
  isCodexAtlasEngine,
  isHermesAtlasEngine,
} from "./atlas-client-config.js";
import { CodexAppServerClient } from "./codex-app-server.js";
import {
  APPMARKET_MCP_TOOL_NAMES,
  APPMARKET_MCP_REGISTRATION_ID,
  prepareStoryAppMarketMcpForCli,
} from "./appmarket-admin-mcp.js";
import {
  completeAgentTurnTelemetry,
  normalizeProviderUsage,
  unicodeCharCount,
} from "./agent-telemetry.js";
import { assertWorkflowV2ReceiptTransport } from "./devbench/workflow-v2/receipt-transport-policy.js";
import {
  buildHermesOneshotArgs,
  buildHermesChatArgs,
  hermesExecutable,
  isHermesEngine,
  readHermesUsageFile,
} from "./hermes-cli.js";
import {
  parseHermesChatStream,
  flushHermesChatStream,
} from "./hermes-chat-stream.js";
import {
  createAgentExecutionSupervisor,
  isAutomaticConvergenceError,
  isMeaningfulProgressStream,
  resolveAgentProgressPolicy,
} from "./agent-progress.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLI_SUPERVISOR = join(__dirname, "cli-supervisor.js");
const runningProcesses = new Map();
const runtimeOwnerInstance = `gateway-${process.pid}-${randomUUID()}`;
const TASK_RUNTIME_LEASE_TTL_MS = 15000;
const TASK_RUNTIME_HEARTBEAT_MS = 4000;
const MINUTE_MS = 60 * 1000;
const DEFAULT_CLI_IDLE_TIMEOUT_MS = 15 * MINUTE_MS;
const LONG_DEVBENCH_IDLE_TIMEOUT_MS = 60 * MINUTE_MS;
const DEFAULT_MAX_TIMEOUT_MS = 2 * 60 * MINUTE_MS;
const LONG_DEVBENCH_MAX_TIMEOUT_MS = 8 * 60 * MINUTE_MS;
// 启动后无任何 stdout/stderr 输出则判定启动卡死（stdin 管道死锁 / 初始化挂起 / 大 prompt 喂不进去）。
// 区别于 idle 计时器：idle 只在「有过输出后再次沉默」才触发；本计时器专治「从头到尾零输出」的启动期卡死，
// 避免一个 60 分钟的 claude idle 上限让卡死任务白白占用槽位一小时。首次输出到达即取消。
const DEFAULT_FIRST_OUTPUT_TIMEOUT_MS = 4 * MINUTE_MS;
const CLI_HEARTBEAT_INTERVAL_MS = 60 * 1000;
let codexAppServerAvailableCache;

function isCodexCliEngine(engine) {
  return engine === "codex" || isCodexMinimaxEngine(engine) || isCodexAtlasEngine(engine);
}

export function codexAppServerHelpSupportsRealtime(helpText) {
  const text = String(helpText || "");
  return /\bcodex\s+app-server\b/i.test(text)
    && /--(?:stdio|listen)\b/i.test(text);
}

export function codexAppServerSpawnSpec(platform = process.platform) {
  // Windows 的 npm 全局命令通常是 codex.cmd，Node 不能在 shell:false 下
  // 直接执行；使用完全固定的命令串，既兼容 .cmd，也不拼接任何用户输入。
  if (platform === "win32") {
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", "codex app-server --stdio"],
      shell: false,
      detached: false,
    };
  }
  return {
    command: "codex",
    args: ["app-server", "--stdio"],
    shell: false,
    detached: true,
  };
}

let codexAppServerAvailablePromise = null;

function isCodexAppServerAvailable() {
  if (codexAppServerAvailableCache != null) return codexAppServerAvailableCache;
  if (codexAppServerAvailablePromise) return false;
  codexAppServerAvailablePromise = new Promise((resolve) => {
    execFile("codex", ["app-server", "--help"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    }, (error, stdout) => {
      codexAppServerAvailableCache = !error && codexAppServerHelpSupportsRealtime(stdout || "");
      codexAppServerAvailablePromise = null;
      resolve(codexAppServerAvailableCache);
    });
  });
  return false;
}

function promptTempDirectory(task = {}) {
  if (!task.storyScoped) {
    return ensureExternalTempDirectory(["aiefficiency", "agent-prompts"], {
      avoidRoots: [task.cwd],
    });
  }
  const storyTempRoot = typeof task.tempRoot === "string" ? task.tempRoot.trim() : "";
  if (!storyTempRoot || !isAbsolute(storyTempRoot)) {
    const error = new Error("故事点 AI 任务缺少有效的临时目录");
    error.code = "STORY_TEMP_ROOT_REQUIRED";
    throw error;
  }
  return ensurePlainExternalChildDirectory(storyTempRoot, "prompts", {
    avoidRoots: [task.cwd],
  });
}

function createPromptTempFile(prompt, task = {}, agentId = "agent") {
  const directory = promptTempDirectory(task);
  const file = join(directory, `prompt-${agentId}-${randomUUID()}.txt`);
  try {
    writeFileSync(file, prompt, { encoding: "utf-8", flag: "wx", mode: 0o600 });
    return file;
  } catch (error) {
    try { unlinkSync(file); } catch {}
    throw error;
  }
}

function cleanupPromptTempFile(file) {
  if (!file) return;
  try { unlinkSync(file); } catch {}
}

function geminiStageAllowedToolNames(stagePolicy = {}) {
  const stageNames = new Set(Array.isArray(stagePolicy.allowedToolNames) ? stagePolicy.allowedToolNames : []);
  const allowed = new Set();
  if (["list_dir", "read_file", "read_binary_metadata", "inspect_image", "inspect_pdf", "inspect_video", "list_archive", "extract_archive_entry"]
    .some((name) => stageNames.has(name))) {
    allowed.add("read_file");
    allowed.add("list_directory");
  }
  if (stageNames.has("search_files")) {
    allowed.add("glob");
    allowed.add("grep_search");
  }
  for (const name of stageNames) {
    if (APPMARKET_MCP_TOOL_NAMES.includes(name)) {
      allowed.add(`mcp_${APPMARKET_MCP_REGISTRATION_ID}_${name}`);
    }
  }
  return [...allowed];
}

export function geminiStagePolicyText(stagePolicy = {}) {
  const rules = [
    "# Generated for one Workflow v2 CLI turn. Deny is the default.",
    "[[rule]]",
    'toolName = "*"',
    'decision = "deny"',
    "priority = 998",
  ];
  for (const name of geminiStageAllowedToolNames(stagePolicy)) {
    rules.push(
      "",
      "[[rule]]",
      `toolName = ${JSON.stringify(name)}`,
      'decision = "allow"',
      "priority = 999",
    );
  }
  return `${rules.join("\n")}\n`;
}

function createGeminiStagePolicyFile(task = {}, agentId = "agent") {
  const directory = promptTempDirectory(task);
  const safeId = String(agentId || "agent").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80) || "agent";
  const file = join(directory, `gemini-stage-policy-${safeId}-${randomUUID()}.toml`);
  writeFileSync(file, geminiStagePolicyText(task.stageToolPolicy), { encoding: "utf8", mode: 0o600, flag: "wx" });
  return file;
}

function runtimeLeaseId(key) {
  return `${runtimeOwnerInstance}:${String(key || "")}`;
}

function refreshRuntimeLease(key, entry) {
  if (!entry?.taskId) return true;
  if (!getTask(entry.taskId)) return true;
  try {
    const result = upsertTaskRuntimeLease({
      leaseId: runtimeLeaseId(key),
      taskId: entry.taskId,
      parentTaskId: entry.parentTaskId || null,
      ownerInstance: runtimeOwnerInstance,
      ownerPid: process.pid,
      workerPid: entry.proc?.pid || null,
      workerIdentity: entry.runtimeWorkerIdentity || "",
      ttlMs: TASK_RUNTIME_LEASE_TTL_MS,
    });
    if (result?.changes !== 1) return false;
    entry.runtimeLeaseHeartbeatAt = Date.now();
    return true;
  } catch {
    return false;
  }
}

function ensureRuntimeWorkerIdentity(key, entry) {
  if (!entry?.proc?.pid || entry.runtimeWorkerIdentity) return;
  captureProcessIdentityAsync(entry.proc.pid).then((identity) => {
    if (identity && runningProcesses.get(key) === entry) {
      entry.runtimeWorkerIdentity = identity;
    }
  }).catch(() => {});
}

function trackRunningProcess(key, entry = {}) {
  runningProcesses.set(key, entry);
  ensureRuntimeWorkerIdentity(key, entry);
  if (refreshRuntimeLease(key, entry)) return;
  runningProcesses.delete(key);
  const error = new Error("无法建立 AI 任务运行租约");
  error.code = "TASK_RUNTIME_LEASE_UNAVAILABLE";
  throw error;
}

function untrackRunningProcess(key) {
  const entry = runningProcesses.get(key);
  runningProcesses.delete(key);
  if (!entry?.taskId) return;
  try { removeTaskRuntimeLease(runtimeLeaseId(key), runtimeOwnerInstance); } catch {}
}

const taskRuntimeHeartbeat = setInterval(() => {
  for (const [key, entry] of runningProcesses) {
    if (refreshRuntimeLease(key, entry)) continue;
    if (Date.now() - Number(entry.runtimeLeaseHeartbeatAt || 0) < TASK_RUNTIME_LEASE_TTL_MS / 2) {
      continue;
    }
    try { entry.abort?.("AI 任务运行租约续期失败，已终止以保护故事点 worktree"); } catch {}
    try { killProcessTree(entry.proc); } catch {}
  }
}, TASK_RUNTIME_HEARTBEAT_MS);
taskRuntimeHeartbeat.unref?.();

function stopTrackedProcessesForShutdown(signal) {
  for (const entry of runningProcesses.values()) {
    try { entry.abort?.(`Gateway 收到 ${signal}，终止 AI 任务`); } catch {}
    try { killProcessTree(entry.proc); } catch {}
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => stopTrackedProcessesForShutdown(signal));
}

// 不在 exit 钩子里删除租约：若进程树终止失败，带 worker_pid 的过期行仍能阻止
// 另一 Gateway 在旧 CLI 存活时清理 worktree。正常收尾会由 untrackRunningProcess 删除。

function isDevbenchLikeTask(task = {}) {
  return /^devbench(?:-|$)/i.test(String(task.source || ""));
}

export function defaultIdleTimeoutMsForTask(engine, task = {}) {
  if (isClaudeCliEngine(engine)) return LONG_DEVBENCH_IDLE_TIMEOUT_MS;
  // hermes chat -q 流式模式有实时输出，idle 超时与其他 devbench CLI 引擎一致；
  // oneshot 时代因全程无输出才需要 8 小时豁免。
  if ((isCodexCliEngine(engine) || isHermesEngine(engine)) && isDevbenchLikeTask(task)) return LONG_DEVBENCH_IDLE_TIMEOUT_MS;
  return DEFAULT_CLI_IDLE_TIMEOUT_MS;
}

export function defaultMaxTimeoutMsForTask(engine, task = {}) {
  if (isHermesEngine(engine) && isDevbenchLikeTask(task)) return LONG_DEVBENCH_MAX_TIMEOUT_MS;
  if (isCodexCliEngine(engine) && isDevbenchLikeTask(task)) return LONG_DEVBENCH_MAX_TIMEOUT_MS;
  return DEFAULT_MAX_TIMEOUT_MS;
}

export function shouldTrustWorkingStatusForTask(engine, task = {}) {
  if (task.trustWorkingStatus === false) return false;
  return isCodexCliEngine(engine) && isDevbenchLikeTask(task);
}

function formatDuration(ms) {
  const rawMs = Math.max(0, Number(ms || 0));
  if (rawMs > 0 && rawMs < 1000) return `${Math.round(rawMs)} 毫秒`;
  const totalSeconds = Math.max(0, Math.round(rawMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
}

function compactPreview(value, limit = 260) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function serializeToolInput(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

export function __testFormatClaudeToolUse(name, input) {
  const toolName = String(name || "unknown");
  const fullInput = serializeToolInput(input);
  return {
    toolName,
    fullInput,
    liveLabel: fullInput ? `${toolName}\n${fullInput}` : toolName,
  };
}

function emitTaskStream(task, engine, chunk, deltaType = "text") {
  if (!chunk) return;
  if (task.promptMode === "structured" && deltaType === "text") return;
  try { task.onStream?.({ chunk, deltaType, engine }); } catch {}
  broadcastChatStream({
    taskId: task.id,
    sessionId: task.sourceId || null,
    subtaskId: task.subtaskId || null,
    chunk,
    engine,
    deltaType,
    aiSnapshot: task.aiSnapshot || null,
        conversation: task.conversation || null,
  });
}

function cliEngineDisplayName(engine) {
  if (isCodexCliEngine(engine)) return "Codex";
  if (isClaudeCliEngine(engine)) return "Claude";
  if (engine === "gemini") return "Gemini";
  if (isHermesEngine(engine)) return "Hermes";
  return String(engine || "CLI");
}

function failureResult(errorMsg, error = {}) {
  const payload = { error: errorMsg };
  if (error.code) payload.code = error.code;
  if (error.cliSessionId) payload.cliSessionId = error.cliSessionId;
  if (error.lastActivity) payload.lastActivity = error.lastActivity;
  if (error.partialOutput) payload.partialOutput = String(error.partialOutput).slice(-4000);
  if (error.timeoutKind) payload.timeoutKind = error.timeoutKind;
  if (error.executionStartedAt) payload.executionStartedAt = error.executionStartedAt;
  if (error.lastMeaningfulProgressAt) payload.lastMeaningfulProgressAt = error.lastMeaningfulProgressAt;
  if (error.resumable === true) payload.resumable = true;
  if (error.storyLifetimeExpired === false) payload.storyLifetimeExpired = false;
  if (typeof error.terminationVerified === "boolean") payload.terminationVerified = error.terminationVerified;
  if (error.terminationVerifiedAt) payload.terminationVerifiedAt = error.terminationVerifiedAt;
  if (error.terminationVerificationError) payload.terminationVerificationError = error.terminationVerificationError;
  if (error.workingIdleExtensions) payload.workingIdleExtensions = error.workingIdleExtensions;
  if (error.usage && typeof error.usage === "object") payload.usage = error.usage;
  if (error.telemetry && typeof error.telemetry === "object") payload.telemetry = error.telemetry;
  if (Array.isArray(error.transcript) && error.transcript.length) {
    payload.transcriptTail = error.transcript.slice(-8).map((item) => ({
      type: item?.type || "",
      content: compactPreview(item?.content, 700),
      ts: item?.ts || null,
      ...(item?.input ? { input: compactPreview(item.input, 500) } : {}),
    }));
  }
  return payload;
}

// ========== CLI 并发信号量 ==========
let cliRunning = 0;
const cliQueue = [];

function stoppedTaskError(reason = "用户手动终止") {
  if (reason instanceof Error) {
    reason.terminalFailure = true;
    return reason;
  }
  const error = new Error(String(reason || "用户手动终止"));
  error.userStopped = true;
  error.terminalFailure = true;
  return error;
}

function acquireCliSlot(signal, { onWait, heartbeatMs = CLI_HEARTBEAT_INTERVAL_MS } = {}) {
  const config = getConfig();
  const max = config.maxCliConcurrency || 2;
  if (signal?.aborted) return Promise.reject(stoppedTaskError(signal.reason));
  if (cliRunning < max) {
    cliRunning++;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const queuedAt = Date.now();
    let heartbeatTimer = null;
    const clearHeartbeat = () => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    };
    const queued = {
      signal,
      resolve: () => {
        clearHeartbeat();
        signal?.removeEventListener?.("abort", queued.onAbort);
        resolve();
      },
      reject,
      onAbort: null,
    };
    queued.onAbort = () => {
      const index = cliQueue.indexOf(queued);
      if (index >= 0) cliQueue.splice(index, 1);
      clearHeartbeat();
      reject(stoppedTaskError(signal?.reason));
    };
    signal?.addEventListener?.("abort", queued.onAbort, { once: true });
    cliQueue.push(queued);
    const notifyWait = () => {
      const index = cliQueue.indexOf(queued);
      if (index < 0) return;
      try {
        onWait?.({
          running: cliRunning,
          max,
          position: index + 1,
          waitedMs: Date.now() - queuedAt,
        });
      } catch {}
    };
    notifyWait();
    const intervalMs = Math.max(10, Number(heartbeatMs) || CLI_HEARTBEAT_INTERVAL_MS);
    if (!signal?.aborted && cliQueue.includes(queued)) {
      heartbeatTimer = setInterval(notifyWait, intervalMs);
      heartbeatTimer.unref?.();
    }
  });
}

function releaseCliSlot() {
  while (cliQueue.length > 0) {
    const next = cliQueue.shift();
    if (next.signal?.aborted) continue;
    next.resolve(); // 不减 cliRunning，直接传给下一个
    return;
  }
  cliRunning--;
}

// 配置热更新后，立即把新增的并发槽位分配给已有排队任务。
// releaseCliSlot 只会在任务结束时触发，不能覆盖“运行中任务未结束但上限已提高”的场景。
export function refreshCliConcurrency() {
  const max = Math.max(1, Number(getConfig().maxCliConcurrency) || 2);
  while (cliRunning < max && cliQueue.length > 0) {
    const next = cliQueue.shift();
    if (!next || next.signal?.aborted) continue;
    cliRunning++;
    next.resolve();
  }
  return { running: cliRunning, queued: cliQueue.length, max };
}

/**
 * 终止进程树（Windows 上 shell:true 产生 cmd.exe → 实际进程 的进程链）
 * Windows: taskkill /pid PID /t /f — /t 杀整棵进程树，/f 强制
 * Unix: process.kill(-pid, "SIGTERM") — 负 PID 杀进程组
 */
function killProcessTree(proc) {
  try {
    if (!proc || !proc.pid) return;
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(proc.pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
        detached: true,
      }).unref();
    } else {
      process.kill(-proc.pid, "SIGTERM");
    }
  } catch {
  }
}

/**
 * 注册进程到 runningProcesses（供 task-decomposer 等外部模块使用）
 */
export function registerProcess(key, proc, taskId, parentTaskId = null) {
  trackRunningProcess(key, { proc, taskId, parentTaskId });
}

export function registerVirtualProcess(key, entry = {}) {
  trackRunningProcess(key, entry);
}

/**
 * 从 runningProcesses 注销进程
 */
export function unregisterProcess(key) {
  untrackRunningProcess(key);
}

/**
 * 外部路由里用：根据 key 找到已注册的 virtual process 并调用其 abort() 回调。
 * 用于停止"轻量级"长操作（如 devbench 单附件下载），不暴露 runningProcesses 内部 Map。
 * @param {string} key
 * @returns {boolean} 是否找到并成功触发 abort
 */
export function triggerAbortViaVirtualProcess(key) {
  const entry = runningProcesses?.get?.(key);
  if (!entry || typeof entry.abort !== "function") return false;
  try {
    return entry.abort("用户手动停止") !== false;
  } catch {
    return false;
  }
}

// 仅匹配 CLI 自身的认证错误（出现在 stderr 或非零退出码时）
// 不能匹配 "登录" 等中文业务词汇，否则分析"登录失败"的 bug 报告会被误判
const CLI_AUTH_ERROR =
  /not logged in|token expired|please log in|authentication required|invalid.*api.?key|api.?key.*invalid|EAUTH|(?:401|403).{0,80}(?:auth|credential|token|api.?key)|(?:auth|login|credential|token|api.?key|openai|codex|claude|gemini|hermes).{0,80}unauthorized|unauthorized.{0,80}(?:auth|login|credential|token|api.?key|openai|codex|claude|gemini|hermes)/i;
const CODEX_REFRESH_TOKEN_REUSED =
  /refresh_token_reused|refresh token has already been used|refresh token was already used/i;
const CODEX_TOOL_ROUTER_ERROR = /codex_core::tools::router/i;
const CODEX_LOG_LINE = /^\d{4}-\d{2}-\d{2}T\S+\s+\w+\s+/;

function removeCodexToolRouterDiagnostics(text) {
  const kept = [];
  let skippingToolRouterBlock = false;
  for (const line of String(text || "").split(/\r?\n/)) {
    const isLogLine = CODEX_LOG_LINE.test(line);
    if (CODEX_TOOL_ROUTER_ERROR.test(line)) {
      skippingToolRouterBlock = true;
      continue;
    }
    if (skippingToolRouterBlock && isLogLine) {
      skippingToolRouterBlock = false;
    }
    if (!skippingToolRouterBlock) kept.push(line);
  }
  return kept.join("\n");
}

export function isCliAuthError(engine, text) {
  let value = String(text || "");
  if (!value.trim()) return false;
  if (engine === "codex") value = removeCodexToolRouterDiagnostics(value);
  return CLI_AUTH_ERROR.test(value);
}

export function isCodexRefreshTokenReusedError(text) {
  return CODEX_REFRESH_TOKEN_REUSED.test(String(text || ""));
}

export function shouldRetryCodexRefreshTokenError(error) {
  if (!isCodexRefreshTokenReusedError(error?.message || error)) return false;
  if (error?.codexPromptMayHaveStarted) return false;
  if (String(error?.partialOutput || "").trim()) return false;
  return !(Array.isArray(error?.transcript) && error.transcript.some((item) => (
    ["text", "tool_use", "tool_output"].includes(String(item?.type || ""))
    && String(item?.content || "").trim()
  )));
}

function waitForCodexCredentialPropagation(task = {}) {
  const configured = Number(task.codexAuthRetryDelayMs);
  const delayMs = Number.isFinite(configured) && configured >= 0 ? configured : 750;
  if (task.abortSignal?.aborted) return Promise.reject(stoppedTaskError(task.abortSignal.reason));
  return new Promise((resolve, reject) => {
    let timer = null;
    const onAbort = () => {
      if (timer) clearTimeout(timer);
      task.abortSignal?.removeEventListener?.("abort", onAbort);
      reject(stoppedTaskError(task.abortSignal?.reason));
    };
    task.abortSignal?.addEventListener?.("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      task.abortSignal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, delayMs);
    timer.unref?.();
  });
}

function codexLoginRequiredError(cause) {
  const error = new Error(
    "Codex 登录状态已失效（refresh_token_reused）。请先在本机终端执行 `codex logout`，再执行 `codex login` 完成重新登录，然后重新发送本条消息。",
  );
  error.code = "CODEX_LOGIN_REQUIRED";
  error.authRequired = true;
  error.terminalFailure = true;
  error.cause = cause;
  error.cliSessionId = cause?.cliSessionId || null;
  error.transcript = cause?.transcript || [];
  error.partialOutput = cause?.partialOutput || "";
  error.lastActivity = cause?.lastActivity || null;
  return error;
}

async function runCodexWithAuthRecovery(task, execute, transport) {
  try {
    return await execute();
  } catch (firstError) {
    if (!shouldRetryCodexRefreshTokenError(firstError) || task.abortSignal?.aborted) throw firstError;
    const status = `Codex ${transport} 检测到共享登录凭据刷新冲突，正在重新加载已旋转的凭据并自动重试（1/1）`;
    log(task.id, "warn", "agent-runner", status);
    emitTaskStream(task, "codex", status, "status");
    await waitForCodexCredentialPropagation(task);
    try {
      return await execute();
    } catch (retryError) {
      if (!isCodexRefreshTokenReusedError(retryError?.message || retryError)) throw retryError;
      broadcastChatStreamEnd({
        taskId: task.id,
        sessionId: task.sourceId || null,
        subtaskId: task.subtaskId || null,
        engine: "codex",
        success: false,
        aiSnapshot: task.aiSnapshot || null,
        conversation: task.conversation || null,
      });
      throw codexLoginRequiredError(retryError);
    }
  }
}

// Gemini 429 / 容量不足 — 无需等待 CLI 自行重试，直接 fallback
const GEMINI_CAPACITY_ERROR =
  /429|No capacity available|RESOURCE_EXHAUSTED|quota exceeded|rate limit/i;

export function shouldAutoFallback(task = {}, config = {}) {
  return !!config.autoFallback && task.allowEngineFallback !== false;
}

export function apiEngineLocalTargetForTask(task = {}, signal) {
  return {
    cwd: task.cwd,
    addDirs: task.addDirs,
    storyScoped: !!task.storyScoped,
    tempRoot: task.tempRoot || "",
    artifactScope: task.artifactScope || null,
    commandPolicy: task.commandPolicy === "read_only" ? "read_only" : undefined,
    stageToolPolicy: task.stageToolPolicy || null,
    stageReceiptRecorder: task.stageReceiptRecorder || null,
    signal,
  };
}

export function resolveAgentWorkingDirectory(task = {}, config = getConfig()) {
  const requested = String(task.cwd || "").trim();
  if (task.storyScoped) {
    if (!requested || !isAbsolute(requested) || !existsSync(requested)) {
      const error = new Error("故事点 worktree 工作目录不存在或不是绝对路径，AI 已停止以保护基础工程");
      error.code = "STORY_WORKTREE_CWD_INVALID";
      throw error;
    }
    return requested;
  }
  return requested && existsSync(requested)
    ? requested
    : (config.workDir && existsSync(config.workDir) ? config.workDir : homedir());
}

export function cliPermissionArgs(engine, task = {}) {
  const stagePolicy = task.stageToolPolicy && typeof task.stageToolPolicy === "object"
    ? task.stageToolPolicy
    : null;
  if (stagePolicy) {
    const stageId = String(stagePolicy.identity?.stageId || "UNKNOWN");
    const allowedToolNames = Array.isArray(stagePolicy.allowedToolNames)
      ? [...new Set(stagePolicy.allowedToolNames.filter((name) => typeof name === "string" && name))]
      : [];
    const readOnly = stagePolicy.readOnly === true;
    const unsupportedWritePolicy = () => {
      const error = new Error(
        `Workflow v2 ${stageId} requires an exclusive stage tool allowlist that ${engine} CLI cannot enforce`,
      );
      error.code = "WORKFLOW_V2_CLI_STAGE_POLICY_UNENFORCEABLE";
      error.stageId = stageId;
      error.engine = engine;
      return error;
    };

    if (isClaudeCliEngine(engine)) {
      if (!readOnly && stageId !== "REPAIR") throw unsupportedWritePolicy();
      const allowed = new Set();
      if (allowedToolNames.some((name) => ["list_dir", "read_file", "read_binary_metadata", "inspect_image", "inspect_pdf", "inspect_video", "list_archive", "extract_archive_entry"].includes(name))) {
        allowed.add("Read");
      }
      if (allowedToolNames.includes("search_files")) {
        allowed.add("Glob");
        allowed.add("Grep");
      }
      if (!readOnly) {
        if (allowedToolNames.some((name) => ["apply_patch", "edit_file"].includes(name))) allowed.add("Edit(**)");
      }
      for (const name of allowedToolNames) {
        if (APPMARKET_MCP_TOOL_NAMES.includes(name)) {
          allowed.add(`mcp__${APPMARKET_MCP_REGISTRATION_ID}__${name}`);
        }
      }
      const denied = new Set(["Bash", "NotebookEdit", "WebFetch", "WebSearch", "Task"]);
      if (!allowed.has("Read")) denied.add("Read");
      if (!allowed.has("Glob")) denied.add("Glob");
      if (!allowed.has("Grep")) denied.add("Grep");
      for (const name of APPMARKET_MCP_TOOL_NAMES) {
        const rule = `mcp__${APPMARKET_MCP_REGISTRATION_ID}__${name}`;
        if (!allowed.has(rule)) denied.add(rule);
      }
      for (const protectedPath of Array.isArray(stagePolicy.protectedPaths) ? stagePolicy.protectedPaths : []) {
        denied.add(`Read(${protectedPath})`);
        if (!String(protectedPath).startsWith("**/")) denied.add(`Read(**/${protectedPath})`);
      }
      if (readOnly) {
        for (const name of ["Edit", "Write"]) denied.add(name);
      } else {
        for (const protectedPath of Array.isArray(stagePolicy.protectedPaths) ? stagePolicy.protectedPaths : []) {
          denied.add(`Edit(${protectedPath})`);
          if (!String(protectedPath).startsWith("**/")) denied.add(`Edit(**/${protectedPath})`);
        }
      }
      const builtInTools = [...allowed]
        .filter((rule) => !rule.startsWith("mcp__"))
        .map((rule) => rule.replace(/\(.+\)$/, ""));
      const args = [
        "--permission-mode", readOnly ? "plan" : "dontAsk",
        "--strict-mcp-config",
      ];
      if (builtInTools.length) args.push("--tools", builtInTools.join(","));
      else args.push("--tools=");
      if (allowed.size) args.push("--allowed-tools", [...allowed].join(","));
      if (denied.size) args.push("--disallowed-tools", [...denied].join(","));
      return args;
    }
    if (engine === "gemini") {
      if (!readOnly) throw unsupportedWritePolicy();
      return ["--approval-mode", "plan"];
    }
    if (isCodexCliEngine(engine)) {
      if (!readOnly || allowedToolNames.length === 0) throw unsupportedWritePolicy();
      return [
        "--sandbox", "read-only",
        ...(engine === "codex" ? ["--ignore-user-config"] : []),
      ];
    }
    throw unsupportedWritePolicy();
  }
  const readOnly = task.commandPolicy === "read_only";
  if (isClaudeCliEngine(engine)) {
    return readOnly
      ? ["--permission-mode", "plan", "--disallowed-tools", "Edit,Write,NotebookEdit"]
      : ["--dangerously-skip-permissions"];
  }
  if (engine === "gemini") {
    return readOnly ? ["--approval-mode", "plan"] : ["--yolo"];
  }
  if (isCodexCliEngine(engine)) {
    return readOnly
      ? ["--sandbox", "read-only"]
      : ["--dangerously-bypass-approvals-and-sandbox"];
  }
  return [];
}

/**
 * Prompt V2 的 capability 清单只能约束模型可请求的工具，不能把 Gateway
 * 身份降权，也不能替代 OS ACL / container 边界。现有 isolated-worker
 * 部署链路尚未接入本 CLI supervisor，因此在它提供逐次、可验证的 Worker
 * lease 之前，禁止任何 V2 prompt turn 直接启动本机 CLI。
 *
 * 这里刻意以 promptMode 和冻结的 stage policy 双重识别：compatibility
 * turn 也属于 V2，不能因为它不是 structured receipt 而回落到 Gateway
 * 身份执行。普通 legacy chat 不带这两个标记，不受影响。
 */
export function isWorkflowV2CliPromptTurn(task = {}) {
  const promptMode = String(task?.promptMode || "").trim().toLowerCase();
  if (promptMode === "structured" || promptMode === "compatibility") return true;
  return !!(
    task?.stageToolPolicy
    && typeof task.stageToolPolicy === "object"
    && String(task.stageToolPolicy.identity?.stageId || "").trim()
  );
}

export function assertWorkflowV2CliWorkerBoundary(task = {}, engine = "") {
  if (!isWorkflowV2CliPromptTurn(task)) return;
  const stageId = String(
    task?.stageToolPolicy?.identity?.stageId
      || task?.telemetryContext?.stage
      || task?.workflowKind
      || "UNKNOWN",
  ).trim().toUpperCase();
  const error = new Error(
    `Workflow v2 ${stageId} 禁止直接以 Gateway 身份启动 ${engine || "CLI"}；请选择本地 API 引擎，或先部署并接入已验证的低权限 Worker/OS ACL 隔离执行器`,
  );
  error.code = "WORKFLOW_V2_CLI_WORKER_ISOLATION_REQUIRED";
  error.stageId = stageId;
  error.engine = engine;
  // 不允许 auto fallback 把同一 V2 turn 悄悄换成另一条未隔离 CLI 路径。
  error.terminalFailure = true;
  return error;
}

/**
 * 执行任务（含自动引擎切换）
 */
async function runTaskInternal(task) {
  const { engine, skill } = dispatch(task);
  const config = getConfig();

  // 广播分类结果，让前端显示分类标签
  broadcastTaskDispatched({
    taskId: task.id,
    type: task.type,
    engine,
    skill: skill ? `/${skill}` : null,
    sessionId: task.sourceId || null,
  });

  try {
    const result = await tryRunWithEngine(task, engine, skill);
    return result;
  } catch (error) {
    if (task.promptMode === "structured") {
      if (!error || (typeof error !== "object" && typeof error !== "function")) {
        error = new Error(String(error || "structured task 执行失败"));
      }
      error.terminalFailure = true;
    }
    const errorMsg = error.message || "";
    const needLogin = !isApiEngine(engine) && (error?.authRequired || isCliAuthError(engine, errorMsg));

    if (needLogin) {
      broadcastLoginPrompt(task.id, engine);
    }

    // 续接会话失效（--resume 会话不存在）不属于"引擎不可用"，不要切换引擎：
    // 直接抛回让调用方（devbench）用同一引擎、清掉死会话后以新会话重试，保留用户为该故事点选定的 AI。
    if (error.staleSession) {
      updateTask(task.id, {
        status: "failed",
        result: JSON.stringify(taskResultForPersistence(task, failureResult(errorMsg, error))),
      });
      broadcastTaskUpdate({ ...task, status: "failed" });
      throw error;
    }

    // 用户停止和超时都已是明确终态，不应再自动切换引擎继续占用故事点。
    if (error.terminalFailure) {
      updateTask(task.id, {
        status: "failed",
        result: JSON.stringify(taskResultForPersistence(task, failureResult(errorMsg, error))),
      });
      broadcastTaskUpdate({ ...task, status: "failed" });
      throw error;
    }

    // 自动切换引擎
    // 故事点等交互场景明确指定了引擎时，调用方可禁止静默回退。
    // 否则用户选择 DeepSeek 后可能实际由 Claude 修改代码，且最终错误会掩盖首个引擎的真实原因。
    if (shouldAutoFallback(task, config)) {
      const fallback = getFallbackEngine(engine, config);

      if (fallback) {
        log(
          task.id,
          "warn",
          "agent-runner",
          `引擎 ${engine} 失败${needLogin ? "(需登录)" : ""}，自动切换到 ${fallback}`
        );
        broadcastEngineFallback(task.id, engine, fallback);

        try {
          const result = await tryRunWithEngine(task, fallback, skill);
          return result;
        } catch (fallbackError) {
          if (!isApiEngine(fallback) && isCliAuthError(fallback, fallbackError.message || "")) {
            broadcastLoginPrompt(task.id, fallback);
          }
          const combinedMessage = `所有引擎均失败。${engine}: ${errorMsg}; ${fallback}: ${fallbackError.message}`;
          const combinedError = new Error(combinedMessage);
          combinedError.cliSessionId = fallbackError.cliSessionId || error.cliSessionId || null;
          combinedError.lastActivity = fallbackError.lastActivity || error.lastActivity || null;
          combinedError.partialOutput = [error.partialOutput, fallbackError.partialOutput].filter(Boolean).join("\n\n");
          combinedError.transcript = [
            ...(Array.isArray(error.transcript) ? error.transcript : []),
            ...(Array.isArray(fallbackError.transcript) ? fallbackError.transcript : []),
          ];
          combinedError.usage = fallbackError.usage || error.usage || null;
          combinedError.telemetry = fallbackError.telemetry || error.telemetry || null;
          updateTask(task.id, {
            status: "failed",
            result: JSON.stringify(taskResultForPersistence(task, failureResult(combinedMessage, combinedError))),
          });
          broadcastTaskUpdate({ ...task, status: "failed" });
          log(task.id, "error", "agent-runner", `所有引擎均失败`);
          throw combinedError;
        }
      }
    }

    updateTask(task.id, {
      status: "failed",
      result: JSON.stringify(taskResultForPersistence(task, failureResult(errorMsg, error))),
    });
    broadcastTaskUpdate({ ...task, status: "failed" });
    throw error;
  }
}

async function isTaskProcessTreeActiveAsync(taskId) {
  for (const entry of runningProcesses.values()) {
    if (entry.taskId !== taskId && entry.parentTaskId !== taskId) continue;
    if (!entry.proc?.pid) return true;
    try {
      if (await isSameLiveProcessAsync(entry.proc.pid, entry.runtimeWorkerIdentity)) return true;
    } catch {
      return true;
    }
  }
  try {
    const leases = listTaskRuntimeLeases(taskId);
    for (const lease of leases) {
      if (lease.worker_pid && await isSameLiveProcessAsync(lease.worker_pid, lease.worker_identity)) return true;
    }
    // A live pid-less lease means an API/remote execution boundary has not
    // completed its own cancellation cleanup, so process-tree exit is not yet
    // independently confirmed.
    if (hasActiveTaskRuntimeLease(taskId)) return true;
    return false;
  } catch {
    return true;
  }
}

async function waitForTaskProcessTreeExit(taskId, timeoutMs) {
  const deadline = Date.now() + Math.max(1, Number(timeoutMs) || 1);
  do {
    if (!await isTaskProcessTreeActiveAsync(taskId)) return true;
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(1, deadline - Date.now()))));
  } while (Date.now() <= deadline);
  return !await isTaskProcessTreeActiveAsync(taskId);
}

export async function runTask(task) {
  task = prepareStructuredTask(task);
  const lifecycleKey = `task-lifecycle-${task.id}-${randomUUID()}`;
  const controller = new AbortController();
  const progressPolicy = resolveAgentProgressPolicy(getConfig().apiAgent || {}, task.progressPolicy || {});
  let automaticError = null;
  let previousProgressState = "";
  const supervisor = createAgentExecutionSupervisor({
    policy: progressPolicy,
    onState: (progress) => {
      if (progress.state !== previousProgressState) {
        if (progress.state === "warning") {
          log(task.id, "warn", "agent-progress", "AI 仍有心跳，但业务推进已停滞；已进入自动取消前警告阶段");
        } else if (progress.state === "cancelling") {
          log(task.id, "warn", "agent-progress", "AI 执行片段正在自动取消，并将在取消后验证进程树退出");
        } else if (previousProgressState === "warning" && progress.state === "active") {
          log(task.id, "info", "agent-progress", "检测到新的可验证业务推进，停滞计时已重新开始");
        }
        previousProgressState = progress.state;
      }
      try { task.onProgressState?.(progress); } catch {}
    },
    onCancel: (error) => {
      automaticError = error;
      controller.abort(error);
    },
  });
  let lifecycleTracked = false;
  try {
    trackRunningProcess(lifecycleKey, {
      proc: null,
      taskId: task.id,
      parentTaskId: task.parentTaskId || null,
      abort: (reason = "用户手动终止") => {
        controller.abort(reason);
        return true;
      },
    });
    lifecycleTracked = true;
    const supervisedTask = {
      ...task,
      abortSignal: controller.signal,
      onStream: (event) => {
        try { task.onStream?.(event); } catch {}
        if (isMeaningfulProgressStream(event)) supervisor.markMeaningfulProgress(event);
      },
      onMeaningfulProgress: (detail) => supervisor.markMeaningfulProgress(detail),
      onApiEngineStart: () => supervisor.startApiActiveTurn(),
    };
    return await runTaskInternal(supervisedTask);
  } catch (error) {
    const abortReason = controller.signal?.reason;
    if (automaticError || isAutomaticConvergenceError(abortReason)) {
      automaticError ||= abortReason;
      for (const key of ["cliSessionId", "lastActivity", "partialOutput", "transcript", "usage", "telemetry"]) {
        if (automaticError[key] == null && error?.[key] != null) automaticError[key] = error[key];
      }
      throw automaticError;
    }
    throw error;
  } finally {
    supervisor.dispose();
    if (lifecycleTracked) untrackRunningProcess(lifecycleKey);
    if (automaticError) {
      const verified = await waitForTaskProcessTreeExit(task.id, progressPolicy.terminationVerifyMs);
      automaticError.terminationVerified = verified;
      automaticError.terminationVerifiedAt = Date.now();
      automaticError.progressState = verified ? "terminated" : "termination_unconfirmed";
      if (!verified) {
        automaticError.terminationVerificationError = "取消后仍检测到任务进程或运行租约；需要用户检查执行节点";
      }
      try {
        task.onProgressState?.({
          ...supervisor.snapshot(),
          state: automaticError.progressState,
          code: automaticError.code,
          timeoutKind: automaticError.timeoutKind,
          resumable: true,
          storyLifetimeExpired: false,
          terminationVerified: verified,
          terminationVerifiedAt: automaticError.terminationVerifiedAt,
        });
      } catch {}
      try {
        updateTask(task.id, {
          status: "failed",
          result: JSON.stringify(taskResultForPersistence(task, failureResult(automaticError.message, automaticError))),
        });
        broadcastTaskUpdate({ ...task, status: "failed" });
      } catch {}
      log(
        task.id,
        verified ? "info" : "error",
        "agent-progress",
        verified ? "自动取消完成，已验证任务进程树退出" : "自动取消已发出，但任务进程树退出未确认",
      );
    }
  }
}

/**
 * 用指定引擎尝试执行任务
 */
async function tryRunWithEngine(task, engine, skill) {
  const agentId = `agent-${engine}-${randomUUID().slice(0, 8)}`;

  upsertAgent({
    id: agentId,
    name: `${engine}-worker`,
    engine,
    status: "running",
    currentTaskId: task.id,
  });
  broadcastAgentStatus({ id: agentId, engine, status: "running", taskId: task.id });

  updateTask(task.id, { status: "running", assignedEngine: engine });
  broadcastTaskUpdate({ ...task, status: "running", assignedEngine: engine });

  log(task.id, "info", "agent-runner", `启动 ${engine} Agent: ${agentId}`);

  let actualPrompt = "";
  let telemetryPersisted = false;
  const usesApiTransport = isApiEngine(engine);
  try {
    const promptTask = task.storyScoped
      ? { ...task, cwd: resolveAgentWorkingDirectory(task) }
      : task;
    actualPrompt = buildPrompt(promptTask, skill);
    const result = await executeAgent(engine, task, skill, agentId, actualPrompt);

    // M0: Record Phase2 telemetry for every provider request
    try {
      const { workflowV2Telemetry } = await import("./devbench/workflow-v2/telemetry.js");
      const tctx = task.telemetryContext || {};
      const reportedUsage = normalizeProviderUsage(result.usage);
      workflowV2Telemetry.recordRequest({
        contextId: tctx.contextId || `legacy-${task.id}`,
        contextRevision: tctx.contextRevision || 1,
        stageId: tctx.stage || task.workflowKind || "UNKNOWN",
        attempt: tctx.turnAttempt || 1,
        providerName: engine,
        modelName: task.aiModel || task.aiSnapshot?.model || "",
        contextChars: unicodeCharCount(actualPrompt),
        systemChars: 0,
        stageChars: 0,
        toolSchemaChars: 0,
        toolResultChars: 0,
        inputTokens: reportedUsage?.inputTokens ?? null,
        outputTokens: reportedUsage?.outputTokens ?? null,
        cachedTokens: reportedUsage?.cachedTokens ?? null,
        requestAttempt: tctx.turnAttempt || 1,
        toolRound: result?.toolRounds ?? 0,
        idempotencyKey: tctx.contextId
          ? `${tctx.contextId}:${tctx.stage || task.workflowKind}:${tctx.turnAttempt || 1}`
          : `legacy-${task.id}`,
      });
    } catch (_telemetryError) {
      // 遥测失败不影响主流程
    }

    // 认证检查：只检查 stderr（CLI自身错误），不检查 stdout（业务输出）
    // 避免报告内容中包含"登录"等词汇被误判
    if (result.stderr && isCliAuthError(engine, result.stderr)) {
      throw new Error(`${engine} 认证错误: ${result.stderr.slice(0, 300)}`);
    }

    // Provider 有真实 usage 时按真实值落库；不可观测的 CLI 才保留兼容估算，
    // 并在 telemetry.usage.source 中明确标成 estimated，不能再冒充真实基线。
    const promptLen = unicodeCharCount(actualPrompt);
    const measuredOutput = task.promptMode === "structured" && result.structuredResult
      ? JSON.stringify(result.structuredResult)
      : (result.output || "");
    const outputLen = unicodeCharCount(measuredOutput);
    const estInput = Math.ceil(promptLen * 0.6);
    const estOutput = Math.ceil(outputLen * 0.6);
    const reportedUsage = normalizeProviderUsage(result.usage);
    result.telemetry = completeAgentTurnTelemetry(result.telemetry, {
      provider: engine,
      model: task.aiModel || task.aiSnapshot?.model || "",
      prompt: actualPrompt,
      storyId: task.telemetryContext?.storyId,
      attemptId: task.telemetryContext?.attemptId,
      workflowKind: task.workflowKind,
      stage: task.telemetryContext?.stage,
      contextId: task.telemetryContext?.contextId,
      contextRevision: task.telemetryContext?.contextRevision,
      turnAttempt: task.telemetryContext?.turnAttempt,
      retryReasons: task.telemetryContext?.retryReasons,
      usage: reportedUsage,
      estimatedUsage: usesApiTransport ? null : { inputTokens: estInput, outputTokens: estOutput },
      transcript: result.transcript,
      assumeSingleRequest: !usesApiTransport,
    });
    result.telemetry.executionSucceeded = true;
    const persistedUsage = result.telemetry.usage || {};
    const recordedInput = persistedUsage.source === "unavailable" ? 0 : Number(persistedUsage.inputTokens || 0);
    const recordedOutput = persistedUsage.source === "unavailable" ? 0 : Number(persistedUsage.outputTokens || 0);
    try {
      addTokenUsage(task.id, engine, recordedInput, recordedOutput, result.telemetry);
      telemetryPersisted = true;
    } catch (telemetryError) {
      log(task.id, "warn", "agent-telemetry", `遥测落库失败: ${telemetryError.message}`);
    }

    updateTask(task.id, {
      status: "completed",
      result: JSON.stringify(taskResultForPersistence(task, result)),
      report: result.report || result.output,
    });
    broadcastTaskUpdate({ ...task, status: "completed" });
    updateAgentStatus(agentId, "idle", null);
    broadcastAgentStatus({ id: agentId, engine, status: "idle", taskId: null });
    const usageLabel = persistedUsage.source === "provider"
      ? "Provider 实报"
      : persistedUsage.source === "estimated" ? "兼容估算" : "不可观测";
    log(task.id, "info", "agent-runner", `任务完成: ${task.id} (${usageLabel} ${recordedInput}+${recordedOutput} tokens)`);
    return result;
  } catch (error) {
    if (!actualPrompt) {
      try { actualPrompt = buildPrompt(task, skill); } catch {}
    }
    const reportedUsage = normalizeProviderUsage(error?.usage || error?.telemetry?.usage);
    error.telemetry = completeAgentTurnTelemetry(error?.telemetry, {
      provider: engine,
      model: task.aiModel || task.aiSnapshot?.model || "",
      prompt: actualPrompt,
      storyId: task.telemetryContext?.storyId,
      attemptId: task.telemetryContext?.attemptId,
      workflowKind: task.workflowKind,
      stage: task.telemetryContext?.stage,
      contextId: task.telemetryContext?.contextId,
      contextRevision: task.telemetryContext?.contextRevision,
      turnAttempt: task.telemetryContext?.turnAttempt,
      retryReasons: task.telemetryContext?.retryReasons,
      usage: reportedUsage,
      transcript: error?.transcript,
      assumeSingleRequest: !usesApiTransport,
    });
    error.telemetry.executionSucceeded = false;
    // M0: Record Phase2 error telemetry
    try {
      const { workflowV2Telemetry: v2telErr } = await import("./devbench/workflow-v2/telemetry.js");
      const tctxErr = task.telemetryContext || {};
      v2telErr.recordRequest({
        contextId: tctxErr.contextId || `legacy-${task.id}`,
        contextRevision: tctxErr.contextRevision || 1,
        stageId: tctxErr.stage || task.workflowKind || "UNKNOWN",
        attempt: tctxErr.turnAttempt || 1,
        providerName: engine,
        modelName: task.aiModel || task.aiSnapshot?.model || "",
        contextChars: unicodeCharCount(actualPrompt || ""),
        systemChars: 0,
        stageChars: 0,
        toolSchemaChars: 0,
        toolResultChars: 0,
        inputTokens: reportedUsage?.inputTokens ?? null,
        outputTokens: reportedUsage?.outputTokens ?? null,
        cachedTokens: reportedUsage?.cachedTokens ?? null,
        requestAttempt: tctxErr.turnAttempt || 1,
        toolRound: 0,
        idempotencyKey: tctxErr.contextId
          ? `${tctxErr.contextId}:${tctxErr.stage || task.workflowKind}:${tctxErr.turnAttempt || 1}`
          : `legacy-${task.id}`,
        errorCode: error.code || "WORKFLOW_V2_AGENT_ERROR",
      });
    } catch {}
    if (!telemetryPersisted) {
      try {
        addTokenUsage(
          task.id,
          engine,
          reportedUsage?.inputTokens || 0,
          reportedUsage?.outputTokens || 0,
          error.telemetry,
        );
        telemetryPersisted = true;
      } catch (telemetryError) {
        log(task.id, "warn", "agent-telemetry", `失败回合遥测落库失败: ${telemetryError.message}`);
      }
    }
    const finalAgentStatus = error.userStopped ? "idle" : "error";
    updateAgentStatus(agentId, finalAgentStatus, null);
    broadcastAgentStatus({ id: agentId, engine, status: finalAgentStatus, taskId: null });
    log(task.id, "error", "agent-runner", `${engine} 执行失败: ${error.message}`);
    throw error;
  }
}

/**
 * 调用CLI引擎执行
 *
 * 关键改动：prompt 写入临时文件，通过 stdin 管道传入 CLI，
 * 避免命令行参数长度限制和 shell 特殊字符转义问题。
 */
import { isApiEngine, executeApiEngine } from "./api-engine.js";

async function executeAgent(engine, task, skill, agentId, preparedPrompt = null) {
  if (task.storyScoped) task = { ...task, cwd: resolveAgentWorkingDirectory(task) };
  const prompt = preparedPrompt == null ? buildPrompt(task, skill) : String(preparedPrompt);
  const structuredMode = task.promptMode === "structured";
  if (structuredMode && engine === "claude-proxy") {
    throw workflowV2StructuredTaskError("structured task 不允许中心文本代理 transport");
  }

  // 中心 AI 文本代理（远端）：HTTP/SSE 转发到中心机 AI 后端，不占本地 CLI 槽
  if (engine === "claude-proxy") {
    return executeClaudeProxy(prompt, task, task.abortSignal);
  }

  // API 引擎走 HTTP 调用，不走 CLI，不受并发限制
  if (isApiEngine(engine)) {
    try { task.onApiEngineStart?.({ engine, at: Date.now() }); } catch {}
    if (structuredMode) {
      assertWorkflowV2ReceiptTransport({
        stageId: task.stageToolPolicy?.identity?.stageId || task.telemetryContext?.stage,
        promptMode: task.promptMode,
        transport: task.remoteTarget ? "remote" : "api",
        remoteTarget: !!task.remoteTarget,
      });
    }
    if (structuredMode && task.structuredOutput.strategy !== "finish_stage") {
      throw workflowV2StructuredTaskError("API structured task 只允许 finish_stage strategy");
    }
    const controller = new AbortController();
    let abortReason = "用户手动终止";
    const abortFromTask = () => {
      abortReason = task.abortSignal?.reason || abortReason;
      controller.abort(abortReason);
    };
    if (task.abortSignal?.aborted) abortFromTask();
    else task.abortSignal?.addEventListener?.("abort", abortFromTask, { once: true });
    trackRunningProcess(agentId, {
      proc: null,
      taskId: task.id,
      parentTaskId: task.parentTaskId || null,
      abort: (reason = "用户手动终止") => {
        abortReason = reason;
        controller.abort(reason);
        return true;
      },
    });
    try {
      // task.remoteTarget 存在时，工具在远端工程执行（分布式 agentic：中心大脑 + 远端手脚）
      return await executeApiEngine(
        engine,
        prompt,
        task.id,
        task.sourceId,
        task.remoteTarget,
        apiEngineLocalTargetForTask(task, controller.signal),
        {
          model: String(task.aiModel || task.aiSnapshot?.model || "").trim(),
          tier: String(task.aiTier || task.aiSnapshot?.tier || "").trim(),
          aiSnapshot: task.aiSnapshot || null,
          conversation: task.conversation || null,
          telemetryContext: task.telemetryContext || { workflowKind: task.workflowKind || "" },
          structuredOutput: task.promptMode === "structured" ? task.structuredOutput : null,
          // devbench 通过 task.onStream 维护服务端 liveDraft（刷新/路由切换后恢复实时内容）；
          // CLI 路径在 executeCli 的 emitStream 已自动调用，这里补齐 API 引擎路径。
          onStream: typeof task.onStream === "function" ? task.onStream : null,
          onMeaningfulProgress: typeof task.onMeaningfulProgress === "function" ? task.onMeaningfulProgress : null,
        }
      );
    } catch (error) {
      if (controller.signal.aborted) {
        const stopped = stoppedTaskError(abortReason);
        stopped.transcript = error?.transcript || [];
        stopped.telemetry = error?.telemetry || null;
        stopped.usage = error?.usage || null;
        throw stopped;
      }
      throw error;
    } finally {
      task.abortSignal?.removeEventListener?.("abort", abortFromTask);
      untrackRunningProcess(agentId);
    }
  }

  // Do not mistake CLI sandbox/plan flags for an OS-level worker boundary.
  // The Provider has not been contacted and no CLI queue/process has started.
  const workerBoundaryError = assertWorkflowV2CliWorkerBoundary(task, engine);
  if (workerBoundaryError) throw workerBoundaryError;

  if (structuredMode && task.structuredOutput.strategy !== "json_text") {
    throw workflowV2StructuredTaskError("CLI structured task 只允许 json_text strategy");
  }

  // CLI 引擎：等待并发槽位
  log(task.id, "info", "agent-runner", `等待 CLI 并发槽位 (当前 ${cliRunning}/${getConfig().maxCliConcurrency || 2})...`);
  const engineName = cliEngineDisplayName(engine);
  const queueHeartbeatMs = Number(task.cliQueueHeartbeatIntervalMs) > 0
    ? Number(task.cliQueueHeartbeatIntervalMs)
    : CLI_HEARTBEAT_INTERVAL_MS;
  await acquireCliSlot(task.abortSignal, {
    heartbeatMs: queueHeartbeatMs,
    onWait: ({ running, max, position, waitedMs }) => {
      const message = `${engineName} 正在等待 CLI 并发槽位（占用 ${running}/${max}，排队第 ${position} 位，已等待 ${formatDuration(waitedMs)}）`;
      if (waitedMs >= queueHeartbeatMs) {
        log(task.id, "info", "agent-runner", message);
      }
      emitTaskStream(task, engine, message, "status");
    },
  });
  if (task.abortSignal?.aborted) {
    releaseCliSlot();
    throw stoppedTaskError(task.abortSignal.reason);
  }
  log(task.id, "info", "agent-runner", `获得 CLI 槽位，开始执行`);
  emitTaskStream(task, engine, `已获得 CLI 并发槽位，${engineName} 开始执行`, "status");

  try {
    // Codex CLI 的 `exec` stdin 只接收首条 prompt，无法在运行中的 turn
    // 追加用户消息。凡明确由 Codex CLI 承载的故事点引擎（官方或隔离的
    // 兼容 provider）都走 app-server/turn/steer；网关直连 API 引擎仍排队。
    const executeCliWithAuthRecovery = () => engine === "codex"
      ? runCodexWithAuthRecovery(task, () => executeCli(engine, prompt, task, agentId), "exec")
      : executeCli(engine, prompt, task, agentId);
    if (isCodexCliEngine(engine) && task.streamingInput) {
      if (!isCodexAppServerAvailable()) {
        log(task.id, "warn", "agent-runner", "当前 Codex CLI 不支持 app-server，已降级为 exec；运行中追问将进入持久队列");
        emitTaskStream(task, engine, "当前 Codex CLI 版本不支持实时追加，本轮使用 exec，后续消息将排队", "status");
        return await (engine === "codex"
          ? runCodexWithAuthRecovery(
            task,
            () => executeCli(engine, prompt, { ...task, streamingInput: false }, agentId),
            "exec",
          )
          : executeCli(engine, prompt, { ...task, streamingInput: false }, agentId));
      }
      try {
        return await (engine === "codex"
          ? runCodexWithAuthRecovery(
            task,
            () => executeCodexAppServer(engine, prompt, task, agentId),
            "app-server",
          )
          : executeCodexAppServer(engine, prompt, task, agentId));
      } catch (error) {
        if (error?.code !== "CODEX_APP_SERVER_STARTUP_FAILED" || task.abortSignal?.aborted) throw error;
        log(task.id, "warn", "agent-runner", `Codex app-server 启动失败，安全降级 exec（尚未发送首条 prompt）: ${error.message}`);
        emitTaskStream(task, engine, "Codex 实时通道启动失败，本轮已安全降级；运行中追问将排队", "status");
        return await (engine === "codex"
          ? runCodexWithAuthRecovery(
            task,
            () => executeCli(engine, prompt, { ...task, streamingInput: false }, agentId),
            "exec",
          )
          : executeCli(engine, prompt, { ...task, streamingInput: false }, agentId));
      }
    }
    const result = await executeCliWithAuthRecovery();
    return structuredMode ? finalizeStructuredCliResult(task, result) : result;
  } finally {
    releaseCliSlot();
  }
}

// 中心 AI 文本代理（远端→中心）：把单轮文本 prompt 发到中心 /api/claude-proxy/run，
// 解析 SSE，把 chunk 转成本地 chat_stream，返回 { output, usage }。
async function executeClaudeProxy(prompt, task, signal) {
  const cfg = getConfig().claudeProxyClient || {};
  if (!cfg.host) return { output: "", error: "未配置中心 AI 代理地址（设置→AI 模式配置）" };
  const url = `${String(cfg.host).replace(/\/+$/, "")}/api/claude-proxy/run`;
  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}) },
      body: JSON.stringify({ prompt, clientId: getConfig().clientName || "remote", requestId: task.id }),
      signal,
    });
  } catch (e) {
    if (signal?.aborted) throw stoppedTaskError(signal.reason);
    return { output: "", error: `连接中心 AI 代理失败: ${e.message}` };
  }
  if (!resp.ok || !resp.body) {
    let t = ""; try { t = await resp.text(); } catch {}
    return { output: "", error: `中心代理返回 ${resp.status} ${t.slice(0, 200)}` };
  }
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = "", text = "", usage = null, errMsg = null;
  while (true) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch (e) {
      if (signal?.aborted) throw stoppedTaskError(signal.reason);
      errMsg = e.message;
      break;
    }
    if (chunk.done) break;
    buf += dec.decode(chunk.value, { stream: true });
    const blocks = buf.split("\n\n"); buf = blocks.pop();
    for (const block of blocks) {
      let ev = null, dataStr = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) ev = line.slice(6).trim();
        else if (line.startsWith("data:")) dataStr += line.slice(5).trim();
      }
      if (!ev) continue;
      let d = {}; try { d = JSON.parse(dataStr || "{}"); } catch {}
      if (ev === "chunk" && d.delta) {
        text += d.delta;
        try { task.onStream?.({ chunk: d.delta, deltaType: "text", engine: "claude-proxy" }); } catch {}
        broadcastChatStream({ taskId: task.id, sessionId: task.sourceId || null, subtaskId: task.subtaskId || null, chunk: d.delta, engine: "claude-proxy", deltaType: "text" });
      } else if (ev === "done") {
        if (d.text) text = d.text;
        usage = d.usage || null;
      } else if (ev === "error") {
        errMsg = d.message || "中心代理出错";
      }
    }
  }
  if (signal?.aborted) throw stoppedTaskError(signal.reason);
  if (task.sourceId) broadcastChatStreamEnd({ taskId: task.id, sessionId: task.sourceId, usage, aiSnapshot: task.aiSnapshot || null });
  if (errMsg && !text) return { output: "", error: errMsg };
  return { output: text, usage, cliSessionId: null };
}

function executeCodexAppServer(engine, prompt, task, agentId) {
  return new Promise((resolve, reject) => {
    const config = getConfig();
    const cwd = resolveAgentWorkingDirectory(task, config);
    let proc;
    let runtimeProfile;
    try {
      runtimeProfile = buildCodexAppServerSpawnEnv({ ...process.env }, {
        engine,
        model: String(task.aiModel || task.aiSnapshot?.model || "").trim() || undefined,
      });
      const identity = task.aiSnapshot?.name
        || (isCodexAtlasEngine(engine) ? "Codex CLI（Atlas Coding Plan）"
          : isCodexMinimaxEngine(engine) ? "Codex CLI（MiniMax）" : "Codex CLI");
      log(task.id, "info", "agent-runner", `${identity} · app-server/turn/steer · provider=${runtimeProfile.modelProvider} · model=${task.aiSnapshot?.model || "默认"}`);
      const spawnSpec = codexAppServerSpawnSpec();
      // Windows Job controller 的异步 stdin 桥适用于单向 CLI，却会让
      // app-server 的 initialize 双向握手得不到响应。因此这里直接持有
      // app-server 根进程；既有 watchdog + killProcessTree(/t) 继续负责
      // Gateway 崩溃和用户停止时的整棵进程树回收。
      proc = spawn(spawnSpec.command, spawnSpec.args, {
        cwd,
        shell: spawnSpec.shell,
        windowsHide: true,
        env: runtimeProfile.env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: spawnSpec.detached,
      });
      startProcessTreeWatchdog(proc.pid, process.pid).catch(() => {});
    } catch (error) {
      runtimeProfile?.cleanup?.();
      reject(new Error(`启动 Codex app-server 失败: ${error.message}`));
      return;
    }

    proc.once("close", () => runtimeProfile?.cleanup?.());

    const client = new CodexAppServerClient(proc);
    const transcript = [];
    const agentItemText = new Map();
    const toolItems = new Set();
    let finalText = "";
    let streamedText = "";
    let stderr = "";
    let usage = null;
    let settled = false;
    let initialized = false;
    let turnStarted = false;
    let lastActivity = { ts: Date.now(), kind: "start", preview: "Codex app-server 正在启动" };
    let idleTimer = null;
    let maxTimer = null;
    let firstOutputTimer = null;
    let heartbeatTimer = null;
    let stopReason = "";
    let protocolPhase = "starting";

    const idleOverride = Number(task.idleTimeoutMs);
    const maxOverride = Number(task.maxTimeoutMs);
    const firstOutputOverride = Number(task.firstOutputTimeoutMs);
    const heartbeatOverride = Number(task.cliHeartbeatIntervalMs);
    const IDLE_TIMEOUT_MS = Number.isFinite(idleOverride) && idleOverride > 0
      ? idleOverride
      : defaultIdleTimeoutMsForTask(engine, task);
    const MAX_TIMEOUT_MS = Number.isFinite(maxOverride) && maxOverride > 0
      ? maxOverride
      : defaultMaxTimeoutMsForTask(engine, task);
    const FIRST_OUTPUT_TIMEOUT_MS = Number.isFinite(firstOutputOverride) && firstOutputOverride > 0
      ? firstOutputOverride
      : DEFAULT_FIRST_OUTPUT_TIMEOUT_MS;
    const HEARTBEAT_INTERVAL_MS = Number.isFinite(heartbeatOverride) && heartbeatOverride > 0
      ? heartbeatOverride
      : CLI_HEARTBEAT_INTERVAL_MS;

    const pushTranscript = (type, content, extra = {}) => {
      const value = String(content || "");
      if (!value) return;
      transcript.push({
        type,
        content: value.length > 4096 ? `${value.slice(0, 4096)}...(已截断)` : value,
        ts: Date.now(),
        ...extra,
      });
      lastActivity = { ts: Date.now(), kind: type, preview: compactPreview(value) };
    };
    const emitStream = (chunk, deltaType = "text") => emitTaskStream(task, engine, chunk, deltaType);
    const emitUsage = () => {
      if (!usage) return;
      try { task.onStream?.({ deltaType: "usage", engine, usage }); } catch {}
      broadcastChatStream({
        taskId: task.id,
        sessionId: task.sourceId || null,
        subtaskId: task.subtaskId || null,
        chunk: "",
        engine,
        deltaType: "usage",
        usage,
        aiSnapshot: task.aiSnapshot || null,
        conversation: task.conversation || null,
      });
    };
    const clearTimers = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (maxTimer) clearTimeout(maxTimer);
      if (firstOutputTimer) clearTimeout(firstOutputTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      idleTimer = maxTimer = firstOutputTimer = heartbeatTimer = null;
    };
    const resetIdle = () => {
      if (firstOutputTimer) {
        clearTimeout(firstOutputTimer);
        firstOutputTimer = null;
      }
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (settled || !runningProcesses.has(agentId)) return;
        const silentMs = Date.now() - lastActivity.ts;
        const message = `codex app-server 已 ${formatDuration(silentMs)}无协议活动，继续等待到总上限 ${formatDuration(MAX_TIMEOUT_MS)}`;
        log(task.id, "info", "agent-runner", message);
        emitStream(message, "status");
        resetIdle();
      }, IDLE_TIMEOUT_MS);
      idleTimer.unref?.();
    };
    const finish = (error = null, { kill = false, userStopped = false } = {}) => {
      if (settled) return false;
      settled = true;
      clearTimers();
      const retryableCredentialRefresh = !!error
        && protocolPhase !== "turn-starting"
        && protocolPhase !== "turn-active"
        && isCodexRefreshTokenReusedError(error?.message || error);
      if (!retryableCredentialRefresh) {
        broadcastChatStreamEnd({
          taskId: task.id,
          sessionId: task.sourceId || null,
          subtaskId: task.subtaskId || null,
          engine,
          success: !error,
          usage,
          aiSnapshot: task.aiSnapshot || null,
          conversation: task.conversation || null,
        });
      }
      if (kill) {
        try { killProcessTree(proc); } catch {}
      } else {
        try { proc.stdin.end(); } catch {}
      }
      untrackRunningProcess(agentId);
      if (!error) {
        resolve({
          output: finalText || streamedText,
          report: finalText || streamedText,
          stderr,
          cliSessionId: client.threadId || null,
          transcript,
          usage,
        });
        return true;
      }
      const wrapped = error instanceof Error ? error : new Error(String(error));
      wrapped.cliSessionId = client.threadId || null;
      wrapped.transcript = transcript;
      wrapped.partialOutput = finalText || streamedText;
      wrapped.lastActivity = lastActivity;
      wrapped.codexPromptMayHaveStarted = turnStarted
        || protocolPhase === "turn-starting"
        || protocolPhase === "turn-active";
      wrapped.userStopped = userStopped;
      wrapped.terminalFailure = userStopped || wrapped.terminalFailure;
      reject(wrapped);
      return true;
    };

    const runningEntry = {
      proc,
      taskId: task.id,
      parentTaskId: task.parentTaskId || null,
      streamingInput: true,
      injectUser: async (text) => {
        if (settled || !turnStarted || !client.turnId) return false;
        try {
          const clientUserMessageId = `story-${task.id}-${randomUUID()}`;
          await client.steer(text, { clientUserMessageId });
          pushTranscript("user", text, { injected: true, clientUserMessageId });
          emitStream("新消息已实时追加到当前 Codex 回合", "status");
          return true;
        } catch (error) {
          log(task.id, "warn", "agent-runner", `Codex turn/steer 失败，交由故事点队列兜底: ${error.message}`);
          return false;
        }
      },
      abort: (reason = "用户手动终止") => {
        if (settled) return false;
        stopReason = String(reason || "用户手动终止");
        void client.interrupt().catch(() => {}).finally(() => {
          finish(stoppedTaskError(stopReason), { kill: true, userStopped: true });
        });
        return true;
      },
    };

    try {
      trackRunningProcess(agentId, runningEntry);
    } catch (error) {
      try { killProcessTree(proc); } catch {}
      reject(error);
      return;
    }

    client.on("activity", (message) => {
      lastActivity = {
        ts: Date.now(),
        kind: message?.method || "response",
        preview: compactPreview(message?.method || "Codex app-server response"),
      };
      resetIdle();
    });
    client.on("stderr", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-16_384);
      lastActivity = { ts: Date.now(), kind: "stderr", preview: compactPreview(chunk) };
      resetIdle();
    });
    client.on("protocolError", (error) => {
      log(task.id, "warn", "agent-runner", `Codex app-server 协议告警: ${error.message}`);
    });
    client.on("closed", (error) => {
      if (!settled) finish(new Error(`${stopReason || error.message}${stderr ? `: ${compactPreview(stderr, 500)}` : ""}`));
    });
    client.on("notification", (method, params) => {
      if (method === "turn/started") {
        turnStarted = true;
        client.turnId = params?.turn?.id || client.turnId;
        emitStream("Codex 已开始处理", "status");
        return;
      }
      if (method === "item/agentMessage/delta") {
        const delta = String(params?.delta || "");
        if (!delta) return;
        const itemId = String(params?.itemId || "agent");
        agentItemText.set(itemId, `${agentItemText.get(itemId) || ""}${delta}`);
        streamedText += delta;
        emitStream(delta, "text");
        return;
      }
      if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") {
        const delta = String(params?.delta || "");
        if (delta) {
          emitStream(delta, "thinking");
          pushTranscript("thinking", delta);
        }
        return;
      }
      if (method === "item/commandExecution/outputDelta" || method === "item/fileChange/outputDelta") {
        const delta = String(params?.delta || "");
        if (delta) {
          emitStream(delta, "tool_output");
          pushTranscript("tool_output", delta);
        }
        return;
      }
      if (method === "item/started") {
        const item = params?.item || {};
        const itemId = String(item.id || "");
        let label = "";
        if (item.type === "commandExecution") label = Array.isArray(item.command) ? item.command.join(" ") : String(item.command || "command");
        else if (item.type === "fileChange") label = "apply_patch";
        else if (item.type === "mcpToolCall") label = `${item.server || "mcp"}/${item.tool || "tool"}`;
        else if (item.type === "webSearch") label = `web_search: ${item.query || ""}`;
        if (label && !toolItems.has(itemId || label)) {
          toolItems.add(itemId || label);
          emitStream(label, "tool_use");
          pushTranscript("tool_use", label);
        }
        return;
      }
      if (method === "item/completed") {
        const item = params?.item || {};
        if (item.type === "agentMessage" && item.text) {
          const itemId = String(item.id || "agent");
          const seen = agentItemText.get(itemId) || "";
          const completed = String(item.text);
          if (!seen) {
            streamedText += completed;
            emitStream(completed, "text");
          } else if (completed.startsWith(seen) && completed.length > seen.length) {
            const tail = completed.slice(seen.length);
            streamedText += tail;
            emitStream(tail, "text");
          }
          agentItemText.set(itemId, completed);
          finalText = completed;
          pushTranscript("text", completed);
        }
        return;
      }
      if (method === "thread/tokenUsage/updated") {
        const total = params?.tokenUsage?.total || params?.tokenUsage?.last;
        if (total) {
          usage = {
            inputTokens: Number(total.inputTokens || 0),
            outputTokens: Number(total.outputTokens || 0),
            cacheReadTokens: Number(total.cachedInputTokens || 0),
            cacheCreationTokens: Number(total.cacheWriteInputTokens || 0),
          };
          emitUsage();
        }
        return;
      }
      if (method === "error") {
        const message = params?.error?.message || params?.message || "Codex app-server turn 发生错误";
        log(task.id, "warn", "agent-runner", message);
        return;
      }
      if (method === "turn/completed") {
        const status = String(params?.turn?.status || "failed");
        if (status === "completed") finish(null, { kill: true });
        else if (status === "interrupted") finish(stoppedTaskError(stopReason || "Codex 回合已中断"), { kill: true, userStopped: !!stopReason });
        else finish(new Error(params?.turn?.error?.message || `Codex 回合结束状态: ${status}`), { kill: true });
      }
    });

    firstOutputTimer = setTimeout(() => {
      if (settled || initialized) return;
      const error = new Error(`Codex app-server 启动后 ${formatDuration(FIRST_OUTPUT_TIMEOUT_MS)} 未完成初始化`);
      error.timeoutKind = "first-output";
      error.terminalFailure = true;
      finish(error, { kill: true });
    }, FIRST_OUTPUT_TIMEOUT_MS);
    firstOutputTimer.unref?.();
    maxTimer = setTimeout(() => {
      if (settled) return;
      const error = new Error(`Codex app-server 总执行时间超过 ${formatDuration(MAX_TIMEOUT_MS)}，强制终止`);
      error.timeoutKind = "max";
      error.terminalFailure = true;
      finish(error, { kill: true });
    }, MAX_TIMEOUT_MS);
    maxTimer.unref?.();
    if (task.cliHeartbeat !== false) {
      heartbeatTimer = setInterval(() => {
        if (settled || Date.now() - lastActivity.ts < HEARTBEAT_INTERVAL_MS - 1000) return;
        emitStream(`Codex 仍在执行；最后协议活动在 ${formatDuration(Date.now() - lastActivity.ts)}前`, "status");
      }, HEARTBEAT_INTERVAL_MS);
      heartbeatTimer.unref?.();
    }
    resetIdle();

    void (async () => {
      try {
        await client.initialize();
        initialized = true;
        protocolPhase = "initialized";
        const model = String(task.aiModel || task.aiSnapshot?.model || "").trim();
        const effort = String(task.aiTier || task.aiSnapshot?.tier || "").trim();
        await client.startThread({
          cwd,
          model,
          modelProvider: runtimeProfile.modelProvider,
          effort,
          readOnly: task.commandPolicy === "read_only",
          workspaceRoots: Array.isArray(task.addDirs) ? task.addDirs : [],
        });
        protocolPhase = "thread-ready";
        // From this point the initial user prompt may have reached Codex. Never
        // fall back to exec on error, otherwise the same request could execute twice.
        protocolPhase = "turn-starting";
        await client.startTurn(prompt, {
          imagePaths: (Array.isArray(task.imagePaths) ? task.imagePaths : []).filter((path) => path && existsSync(path)),
          clientUserMessageId: `story-${task.id}-initial`,
        });
        protocolPhase = "turn-active";
      } catch (error) {
        if (protocolPhase === "starting" || protocolPhase === "initialized" || protocolPhase === "thread-ready") {
          error.code = "CODEX_APP_SERVER_STARTUP_FAILED";
        }
        finish(error, { kill: true });
      }
    })();
  });
}

function executeCli(engine, prompt, task, agentId) {

  return new Promise((resolve, reject) => {
    if (isHermesEngine(engine) && task.commandPolicy === "read_only") {
      const error = new Error("Hermes 非 TTY 运行会自动放行工具审批，当前无法提供可验证的只读沙箱，已拒绝启动");
      error.code = "HERMES_READ_ONLY_UNSUPPORTED";
      reject(error);
      return;
    }
    let command, args;
    let storyMcpRuntime = null;

    if (isClaudeCliEngine(engine)) {
      // -p: 非交互模式（flag，不接参数），prompt 通过 stdin 管道传入
      // --dangerously-skip-permissions: 子进程无终端，无法弹出授权弹窗，
      //   不加此参数遇到需要授权的工具（如WebFetch）会永远卡住
      //   此网关仅本地运行，安全风险可控
      // claude-volcengine：同一 claude CLI，隔离 CLAUDE_CONFIG_DIR + 方舟 ANTHROPIC_*（与官方区分）
      command = "claude";
      args = ["-p", "--output-format", "stream-json", "--verbose", ...cliPermissionArgs(engine, task)];
      let model = String(task.aiModel || task.aiSnapshot?.model || "").trim();
      if (isClaudeVolcengineEngine(engine) && model) {
        model = normalizeClaudeVolcengineModelId(model);
      }
      if (model) args.push("--model", model);
      // 流式输入：stdin 常开、可多次喂 JSON 用户消息（支持 AI 工作中注入新消息/重规划）
      if (task.streamingInput) {
        args.push("--input-format", "stream-json");
      }
      // 续接已有 CLI 会话（零额外 token 开销的上下文关联）
      if (task.cliSessionId) {
        args.push("--resume", task.cliSessionId);
      }
      // 把额外工作目录纳入 Claude 工作区（等同于在该目录 terminal 运行：可访问其文件、加载其 CLAUDE.md）。
      // devbench 用它把"关联工程 + 主工程 WebApp"加进来，让故事点效果接近在各工程里直接跑 claude。
      if (Array.isArray(task.addDirs)) {
        const seen = new Set([task.cwd]);
        for (const d of task.addDirs) {
          if (d && !seen.has(d) && existsSync(d)) { args.push("--add-dir", d); seen.add(d); }
        }
      }
    } else if (isHermesEngine(engine)) {
      // Hermes Agent 流式查询模式（chat -q）：非 TTY 管道下工具进度行和正文
      // 逐句写到 stdout，前端可实时展示（等价 Codex 的逐句体验）。oneshot 模式
      // 会把 stdout 整体重定向到 devnull 直到进程结束才一次性输出最终答案，
      // 导致故事点长时间"卡住不动"。
      // Prompt 本体仍由下方写入受控临时文件，避免 Windows 命令行长度上限。
      command = hermesExecutable();
      args = [];
    } else if (engine === "gemini") {
      // Gemini CLI:
      // --yolo: 自动批准所有工具调用，等价于 Claude 的 --dangerously-skip-permissions
      //   不加此参数遇到 Read/Write/Bash 等工具会等待审批，子进程无终端导致卡死
      // prompt 通过 stdin 管道传入（无 prompt 参数时 stdin 即触发 headless）
      command = "gemini";
      args = [...cliPermissionArgs(engine, task)];
      const model = String(task.aiModel || task.aiSnapshot?.model || "").trim();
      if (model) args.push("--model", model);
      if (task.cliSessionId) {
        args.push("--resume", task.cliSessionId);
      }
    } else if (isCodexCliEngine(engine)) {
      // OpenAI Codex CLI — 非交互模式用 exec 子命令
      // --skip-git-repo-check: 工作目录可能不是 git 仓库
      // --dangerously-bypass-approvals-and-sandbox: 默认沙盒是 read-only，
      //   不加此参数无法创建/修改文件（与 Claude --dangerously-skip-permissions 等价）
      // --json: 输出 JSONL 事件流，前端可实时显示 Codex 的文本/推理/工具进度。
      // -c model= / model_reasoning_effort=：故事点级覆盖，不改全局 config.toml。
      command = "codex";
      args = ["exec", "--skip-git-repo-check", ...cliPermissionArgs(engine, task), "--json"];
      const model = String(task.aiModel || task.aiSnapshot?.model || "").trim();
      const tier = String(task.aiTier || task.aiSnapshot?.tier || "").trim();
      if (model) args.push("-c", `model=${JSON.stringify(model)}`);
      if (tier) args.push("-c", `model_reasoning_effort=${JSON.stringify(tier)}`);
      for (const img of Array.isArray(task.imagePaths) ? task.imagePaths : []) {
        if (img && existsSync(img)) args.push("--image", img);
      }
      args.push("-");
    } else {
      return reject(new Error(`未知引擎: ${engine}`));
    }

    log(
      task.id,
      "info",
      "agent-runner",
      `执行: ${command} (prompt ${prompt.length} 字符，${isHermesEngine(engine) ? "通过受控临时文件引用传入" : "通过stdin传入"})`
    );

    // 工作目录优先级: 任务级 cwd（devbench 按工程指定）> 配置 workDir > 用户主目录
    // 避免在 gateway 目录下运行导致 Mac 等平台文件创建失败
    const config_ = getConfig();
    const cwd = resolveAgentWorkingDirectory(task, config_);

    let tmpFile = "";
    let stagePolicyFile = "";
    let usageFile = "";
    const cleanupTaskFiles = () => {
      cleanupPromptTempFile(tmpFile);
      cleanupPromptTempFile(stagePolicyFile);
      cleanupPromptTempFile(usageFile);
    };
    let proc;
    try {
      tmpFile = createPromptTempFile(prompt, task, agentId);
      if (engine === "gemini" && task.stageToolPolicy) {
        stagePolicyFile = createGeminiStagePolicyFile(task, agentId);
        args.push("--policy", stagePolicyFile);
      }
      if (isHermesEngine(engine)) {
        // chat -q 流式模式不支持 --usage-file（仅顶层 oneshot 支持）；用量由
        // stderr 会话摘要兜底解析（见 hermesChatStreamState），缺失时按 null 降级。
        // devbench 故事点修复任务工具轮次多（编译/装机/日志检索），放大 max-turns
        // 覆盖 hermes 全局 agent.max_turns=60，避免复杂任务截断导致报告只剩半句。
        const hermesMaxTurns = isDevbenchLikeTask(task) ? 200 : 60;
        args = buildHermesChatArgs({
          promptFile: tmpFile,
          model: String(task.aiModel || task.aiSnapshot?.model || "").trim(),
          maxTurns: hermesMaxTurns,
        });
      }
    } catch (error) {
      cleanupTaskFiles();
      reject(error);
      return;
    }

    try {
      const spawnEnv = { ...process.env };
      // Claude Code：故事点档位覆盖（官方 env；不改 ~/.claude）
      if (isClaudeCliEngine(engine) && task?.aiTier) {
        spawnEnv.CLAUDE_CODE_EFFORT_LEVEL = String(task.aiTier);
      }
      // 方舟 / 官方 Claude：分别用 CLAUDE_CONFIG_DIR 隔离（默认 ~/.claude 一键后走方舟）
      let finalEnv = spawnEnv;
      if (isClaudeAtlasEngine(engine)) {
        const built = buildClaudeAtlasSpawnEnv(spawnEnv, {
          model: String(task.aiModel || task.aiSnapshot?.model || "").trim() || undefined,
        });
        finalEnv = built.env;
        try {
          const trustDirs = [cwd, ...(Array.isArray(task.addDirs) ? task.addDirs : [])];
          const trustRes = ensureClaudeAtlasTrust(trustDirs);
          if (trustRes.changed) {
            log(task.id, "info", "agent-runner", `Claude Code（Atlas Coding Plan）· 已信任工作区: ${trustRes.trusted.join(", ")}`);
          }
        } catch (e) {
          log(task.id, "warn", "agent-runner", `Claude Code（Atlas Coding Plan）· 信任工作区失败: ${e?.message || e}`);
        }
        log(task.id, "info", "agent-runner", `Claude Code（Atlas Coding Plan）· ${built.creds.anthropicBaseUrl} · model=${built.creds.model}`);
      } else if (isClaudeVolcengineEngine(engine)) {
        const built = buildClaudeVolcengineSpawnEnv(spawnEnv, {
          model: String(task.aiModel || task.aiSnapshot?.model || "").trim() || undefined,
        });
        finalEnv = built.env;
        // 隔离配置目录从未交互式接受过工作区信任弹窗；非交互(-p)运行会因此报
        // "workspace has not been trusted" 退出 1。这里预先把 cwd + 附加目录标记为已信任。
        try {
          const trustDirs = [cwd, ...(Array.isArray(task.addDirs) ? task.addDirs : [])];
          const trustRes = ensureClaudeVolcengineTrust(trustDirs);
          if (trustRes.changed) {
            log(task.id, "info", "agent-runner", `Claude（火山方舟）· 已信任工作区: ${trustRes.trusted.join(", ")}`);
          }
        } catch (e) {
          log(task.id, "warn", "agent-runner", `Claude（火山方舟）· 信任工作区失败: ${e?.message || e}`);
        }
        log(task.id, "info", "agent-runner", `Claude（火山方舟）· ${built.creds.anthropicBaseUrl} · model=${built.creds.model}`);
      } else if (isClaudeMinimaxEngine(engine)) {
        const built = buildClaudeMinimaxSpawnEnv(spawnEnv, {
          model: String(task.aiModel || task.aiSnapshot?.model || "").trim() || undefined,
        });
        finalEnv = built.env;
        // 隔离配置目录从未交互式接受过工作区信任弹窗；非交互(-p)运行会因此报
        // "workspace has not been trusted" 退出 1。这里预先把 cwd + 附加目录标记为已信任。
        try {
          const trustDirs = [cwd, ...(Array.isArray(task.addDirs) ? task.addDirs : [])];
          const trustRes = ensureClaudeMinimaxTrust(trustDirs);
          if (trustRes.changed) {
            log(task.id, "info", "agent-runner", `Claude（MiniMax）· 已信任工作区: ${trustRes.trusted.join(", ")}`);
          }
        } catch (e) {
          log(task.id, "warn", "agent-runner", `Claude（MiniMax）· 信任工作区失败: ${e?.message || e}`);
        }
        log(task.id, "info", "agent-runner", `Claude（MiniMax）· ${built.creds.anthropicBaseUrl} · model=${built.creds.model}`);
      } else if (engine === "claude") {
        const built = buildClaudeOfficialSpawnEnv(spawnEnv);
        finalEnv = built.env;
        log(task.id, "info", "agent-runner", `Claude（官方）· CLAUDE_CONFIG_DIR=${built.configDir}`);
      } else if (isCodexAtlasEngine(engine)) {
        const built = buildCodexAtlasSpawnEnv(spawnEnv, {
          model: String(task.aiModel || task.aiSnapshot?.model || "").trim() || undefined,
        });
        finalEnv = built.env;
        log(task.id, "info", "agent-runner", `Codex CLI（Atlas Coding Plan）· CODEX_HOME=${built.configDir} · model=${built.creds.model}`);
      } else if (isCodexMinimaxEngine(engine)) {
        const built = buildCodexMinimaxSpawnEnv(spawnEnv, {
          model: String(task.aiModel || task.aiSnapshot?.model || "").trim() || undefined,
        });
        finalEnv = built.env;
        log(task.id, "info", "agent-runner", `Codex（MiniMax）· CODEX_HOME=${built.configDir} · model=${built.creds.model}`);
      } else if (engine === "codex") {
        // 官方 Codex：走隔离 ~/.codex-official（CODEX_HOME），避免默认 ~/.codex 被 minimax 一键配置污染
        const built = buildCodexOfficialSpawnEnv(spawnEnv);
        finalEnv = built.env;
        log(task.id, "info", "agent-runner", `Codex（官方）· CODEX_HOME=${built.configDir}`);
      } else if (isHermesAtlasEngine(engine)) {
        const built = buildHermesAtlasSpawnEnv(spawnEnv, {
          model: String(task.aiModel || task.aiSnapshot?.model || "").trim() || undefined,
        });
        finalEnv = built.env;
        log(task.id, "info", "agent-runner", `Hermes（Atlas Coding Plan）· HERMES_HOME=${built.configDir} · model=${built.creds.model}`);
      }
      if (task.storyScoped) {
        const enabledStageMcpTools = task.stageToolPolicy
          ? APPMARKET_MCP_TOOL_NAMES.filter((name) => task.stageToolPolicy.allowedToolNames?.includes(name))
          : undefined;
        storyMcpRuntime = prepareStoryAppMarketMcpForCli(engine, {
          args,
          env: finalEnv,
          ...(enabledStageMcpTools ? { enabledTools: enabledStageMcpTools } : {}),
        });
        args = storyMcpRuntime.args;
        finalEnv = storyMcpRuntime.env;
        if (storyMcpRuntime.supported === false) {
          log(task.id, "info", "agent-runner", `${engine} 使用自身本地 MCP/Plugin 配置，跳过 AppMarket 临时 MCP 注册`);
        } else {
          const readiness = storyMcpRuntime.runtime?.ok
            ? "ready"
            : `degraded(${storyMcpRuntime.runtime?.problems?.join("；") || "unknown"})`;
          log(
            task.id,
            storyMcpRuntime.runtime?.ok ? "info" : "warn",
            "agent-runner",
            `故事点 MCP · ${storyMcpRuntime.registrationId || "unsupported"} · ${readiness}`,
          );
        }
      }
      const supervisorPayload = Buffer.from(JSON.stringify({
        command,
        args,
        parentPid: process.pid,
      }), "utf8").toString("base64url");
      proc = spawn(process.execPath, [CLI_SUPERVISOR, supervisorPayload], {
        cwd,
        shell: false,
        windowsHide: true,
        env: finalEnv,
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      });
      startProcessTreeWatchdog(proc.pid, process.pid).catch(() => {});
    } catch (error) {
      try { killProcessTree(proc); } catch {}
      storyMcpRuntime?.cleanup?.();
      cleanupTaskFiles();
      reject(error);
      return;
    }
    proc.once("close", () => storyMcpRuntime?.cleanup?.());

    // 流式输入模式（仅 Claude 系 + task.streamingInput）：用 --input-format stream-json 保持 stdin 常开，
    // 支持"AI 工作中追加消息"——像 Claude CLI 一样把新消息注入当前运行的会话，由它在下一思考循环读取并重规划。
    const streaming = isClaudeCliEngine(engine) && !!task.streamingInput;
    let idleCloseTimer = null;
    const STREAM_IDLE_MS = 1200; // 收到 result 后若这么久无新注入 → 关 stdin 让其收尾退出
    const writeUserMsg = (text) => new Promise((resolveWrite) => {
      if (!proc.stdin || proc.stdin.destroyed || proc.stdin.writableEnded || proc.stdin.writable === false) {
        resolveWrite(false);
        return;
      }
      const line = JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: String(text) }] } }) + "\n";
      let finished = false;
      const finishWrite = (ok) => {
        if (finished) return;
        finished = true;
        proc.stdin.off("error", onWriteError);
        resolveWrite(ok);
      };
      const onWriteError = () => finishWrite(false);
      proc.stdin.once("error", onWriteError);
      try {
        // stream.write() 返回 false 只表示背压，数据已被接受，不能据此把同一
        // 条消息再次排队。回调才是本次写入成功/失败的权威结果。
        proc.stdin.write(line, "utf8", (error) => finishWrite(!error));
      } catch {
        finishWrite(false);
      }
    });
    const cancelIdleClose = () => { if (idleCloseTimer) { clearTimeout(idleCloseTimer); idleCloseTimer = null; } };
    const scheduleIdleClose = () => {
      cancelIdleClose();
      idleCloseTimer = setTimeout(() => {
        try { proc.stdin.end(); } catch {} // EOF → claude 处理完所有输入后退出
        // 关 stdin 后仍被后台子进程占管道不退出 → 8s 后强杀兜底
        setTimeout(() => { if (runningProcesses.has(agentId)) { try { killProcessTree(runningProcesses.get(agentId).proc); } catch {} } }, 8000);
      }, STREAM_IDLE_MS);
    };
    // 注入一条用户消息到正在工作的会话（被 /send 在运行中调用）。返回是否写入成功。
    const injectUser = streaming ? async (text) => {
      cancelIdleClose();
      return await writeUserMsg(text);
    } : null;

    try {
      trackRunningProcess(agentId, { proc, taskId: task.id, parentTaskId: task.parentTaskId || null, streamingInput: streaming, injectUser });

      // 通过 stdin 传入 prompt（监听 drain 防止大 prompt 阻塞）
      if (streaming) {
        void writeUserMsg(prompt); // 流式：写首条消息后【不关 stdin】，留通道接受后续注入
      } else if (!proc.stdin.write(prompt)) {
        proc.stdin.once("drain", () => proc.stdin.end());
      } else {
        proc.stdin.end();
      }
    } catch (error) {
      untrackRunningProcess(agentId);
      try { killProcessTree(proc); } catch {}
      cleanupTaskFiles();
      reject(error);
      return;
    }
    proc.stdin.on("error", () => {}); // 忽略 stdin 写入错误（进程可能已退出）

    let stdout = "";
    let stderr = "";
    let stdoutBuffer = ""; // 用于处理跨 data 事件的不完整行（Claude stream-json）
    const stdoutDecoder = createUtf8StreamDecoder();
    const stderrDecoder = createUtf8StreamDecoder();
    let cliSessionId = null; // 从 result 事件中捕获，用于后续会话续接
    let terminalAfterClose = null;
    let usage = null; // Claude result 事件中的真实 token 用量
    let textBlocks = 0; // 累计 text 段数量（>1 时保留带分隔的累积文本，避免多段叙述粘连）
    let claudeResultOk = false; // Claude CLI 已发出成功的 result 事件（subtype=success 且 !is_error）：本轮已正常完成
    let resultGraceTimer = null; // 收到 result 后若进程被孤儿后台子进程占住管道迟迟不退出，宽限后强制结束
    let codexStreamedText = false;
    let codexFinalText = "";
    let codexLastEmittedMessage = "";
    let settled = false;
    // hermes chat -q 流式解析状态（跨 stdout data 事件的半行缓冲 + session_id）
    let hermesChatStreamState = isHermesEngine(engine) ? { lineBuffer: "", sessionId: "" } : null;
    let hermesStreamedText = false;
    // 回答框正文累积：工具调用间 hermes 会多次开合 ╭─╮ 框，前几段是过程叙述，
    // 只有最后一个框才是最终答案。这里只保留"最后一个框"的正文作为最终报告
    // （等价 codex 的 codexFinalText：只取最后一条最终消息），前段叙述仅流式展示。
    let hermesBoxBuffer = ""; // 当前回答框内正文累积
    let hermesFinalText = ""; // 最后一个回答框的正文（最终报告候选）
    let idleTimer = null;
    let maxTimer = null;
    let heartbeatTimer = null;
    let firstOutputTimer = null; // 启动卡死监测：首次 stdout/stderr 输出到达前生效，到达即取消
    let lastCliOutputAt = Date.now();
    let lastActivity = { ts: Date.now(), kind: "start", preview: `${engine} 进程已启动` };
    let workingIdleExtensions = 0;
    const codexToolSeen = new Set();
    const transcript = []; // 事件轨迹（thinking/text/tool_use）按时序
    const TRANSCRIPT_BLOCK_MAX = 4096;
    const noteActivity = (kind, value) => {
      const preview = compactPreview(value);
      if (!preview) return;
      lastActivity = { ts: Date.now(), kind, preview };
    };
    const pushTranscript = (type, content, extra = {}) => {
      if (!content) return;
      if (task.promptMode === "structured" && type === "text") return;
      const str = typeof content === "string" ? content : String(content);
      transcript.push({
        type,
        content: str.length > TRANSCRIPT_BLOCK_MAX ? str.slice(0, TRANSCRIPT_BLOCK_MAX) + "...(已截断)" : str,
        ts: Date.now(),
        ...extra,
      });
      noteActivity(type, str);
    };
    const emitStream = (chunk, deltaType = "text") => {
      if (!chunk) return;
      if (task.promptMode === "structured" && deltaType === "text") return;
      try { task.onStream?.({ chunk, deltaType, engine }); } catch {}
      broadcastChatStream({
        taskId: task.id,
        sessionId: task.sourceId || null,
        subtaskId: task.subtaskId || null,
        chunk,
        engine,
        deltaType,
        // 回答级不可变快照（模型/档位）：让前端在流式阶段就能展示「当前用什么 AI 模型档位」，
        // 不必等到最终 chat_message。仅当任务自带 aiSnapshot 时才携带（如 devbench 故事点、工作总结）。
        aiSnapshot: task.aiSnapshot || null,
        conversation: task.conversation || null,
      });
    };
    const emitUsage = (nextUsage = usage) => {
      if (!nextUsage) return;
      try { task.onStream?.({ deltaType: "usage", engine, usage: nextUsage }); } catch {}
      broadcastChatStream({
        taskId: task.id,
        sessionId: task.sourceId || null,
        subtaskId: task.subtaskId || null,
        chunk: "",
        engine,
        deltaType: "usage",
        usage: nextUsage,
      });
    };
    const clearExecutionTimers = () => {
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      if (maxTimer) { clearTimeout(maxTimer); maxTimer = null; }
      if (resultGraceTimer) { clearTimeout(resultGraceTimer); resultGraceTimer = null; }
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
      if (firstOutputTimer) { clearTimeout(firstOutputTimer); firstOutputTimer = null; }
      cancelIdleClose();
    };
    const rejectExecution = (error, { kill = false, userStopped = false, terminalFailure = false } = {}) => {
      if (settled) return false;
      settled = true;
      clearExecutionTimers();
      const err = error instanceof Error ? error : new Error(String(error || `${engine} 执行失败`));
      err.cliSessionId = cliSessionId;
      err.transcript = transcript;
      err.partialOutput = stdout || "";
      err.lastActivity = lastActivity;
      err.workingIdleExtensions = workingIdleExtensions;
      err.userStopped = userStopped;
      err.terminalFailure = terminalFailure || userStopped;
      cleanupTaskFiles();
      terminalAfterClose = () => {
        cleanupTaskFiles();
        broadcastChatStreamEnd({
          taskId: task.id,
          sessionId: task.sourceId || null,
          subtaskId: task.subtaskId || null,
          engine,
          success: false,
          usage,
          aiSnapshot: task.aiSnapshot || null,
        conversation: task.conversation || null,
        });
        reject(err);
      };
      if (kill) killProcessTree(proc);
      return true;
    };
    const resolveExecution = ({ kill = false, reason = "" } = {}) => {
      if (settled) return false;
      settled = true;
      clearExecutionTimers();
      if (reason) log(task.id, "warn", "agent-runner", reason);
      if (isCodexCliEngine(engine) && codexFinalText) {
        // Codex exec occasionally leaves helper processes alive after the final
        // agent message. Persist the final answer instead of waiting forever.
        stdout = codexFinalText;
      }
      if (!isClaudeCliEngine(engine) && stdout && transcript.length === 0) {
        pushTranscript("text", stdout);
      }
      cleanupTaskFiles();
      terminalAfterClose = () => {
        cleanupTaskFiles();
        broadcastChatStreamEnd({
          taskId: task.id,
          sessionId: task.sourceId || null,
          subtaskId: task.subtaskId || null,
          engine,
          success: true,
          usage,
          aiSnapshot: task.aiSnapshot || null,
        conversation: task.conversation || null,
        });
        resolve({ output: stdout, stderr, report: stdout, cliSessionId, transcript, usage });
      };
      if (kill) killProcessTree(proc);
      return true;
    };
    const entry = runningProcesses.get(agentId);
    if (entry) {
      entry.abort = (reason = "用户手动终止") => rejectExecution(new Error(reason), {
        kill: true,
        userStopped: true,
        terminalFailure: true,
      });
    }
    const isCodexTerminalFinalText = (message) => (
      /(?:\u4efb\u52a1\u72b6\u6001)\s*[:\uff1a]\s*(?:\u5df2\u5b8c\u6210|\u90e8\u5206\u5b8c\u6210|\u672a\u5b8c\u6210)/.test(message)
      || /<!--\s*NEXT:/i.test(message)
    );
    const handleCodexJsonEvent = (event) => {
      const normalized = normalizeCodexJsonEvent(event);
      noteActivity("codex_event", event?.type || event?.event || event?.item?.type || "codex event");
      const hasProgress = normalized.thinking.length || normalized.tools.length || normalized.toolOutputs.length || normalized.text.length;
      if (hasProgress && resultGraceTimer) {
        clearTimeout(resultGraceTimer);
        resultGraceTimer = null;
      }
      if (normalized.sessionId) cliSessionId = normalized.sessionId;
      if (normalized.usage) {
        usage = normalized.usage;
        emitUsage(usage);
      }
      for (const t of normalized.thinking) {
        emitStream(t.endsWith("\n") ? t : `${t}\n`, "thinking");
        pushTranscript("thinking", t);
      }
      for (const tool of normalized.tools) {
        const key = `${tool}`;
        if (codexToolSeen.has(key)) continue;
        codexToolSeen.add(key);
        emitStream(tool, "tool_use");
        pushTranscript("tool_use", tool);
      }
      for (const output of normalized.toolOutputs || []) {
        const text = output.endsWith("\n") ? output : `${output}\n`;
        emitStream(text, "tool_output");
        pushTranscript("tool_output", output);
      }
      for (const chunk of normalized.text) {
        stdout += chunk;
        codexStreamedText = true;
        emitStream(chunk, "text");
        noteActivity("text", chunk);
      }
      if (normalized.finalText) {
        const message = normalized.finalText.trim();
        codexFinalText = normalized.finalText;
        // Codex exec 可能先发一条“我先检查…”的 agent_message，完成时再发真正总结。
        // 每条不同的 agent_message 都实时展示，但最终持久化必须始终取最后一条。
        const alreadyStreamed = !message
          || message === codexLastEmittedMessage
          || stdout.trim() === message
          || stdout.trim().endsWith(message);
        if (!alreadyStreamed) {
          const displayed = `${codexStreamedText ? "\n\n" : ""}${normalized.finalText}`;
          emitStream(displayed, "text");
          pushTranscript("text", normalized.finalText);
        }
        codexLastEmittedMessage = message;
        codexStreamedText = true;
        if (isCodexTerminalFinalText(message)) {
          if (resultGraceTimer) clearTimeout(resultGraceTimer);
          resultGraceTimer = setTimeout(() => {
            if (!runningProcesses.has(agentId)) return;
            resolveExecution({
              kill: true,
              reason: `${engine} 已输出最终结果但进程未退出，按最终回复收尾并释放槽位`,
            });
          }, 30000);
        }
      }
      if (normalized.turnCompleted) {
        // `codex exec --json` 已明确结束当前 turn 时，生命周期不能再依赖最终正文中的
        // 自然语言 marker。部分验收报告会以 VERIFY: FAIL 等业务结论收尾；若 Codex 或
        // 它的辅助进程仍占着管道，继续等待 idle timeout 只会让任务和 CLI 槽位假运行。
        // 放到 microtask 中，先消费同一 stdout data chunk 内剩余的 JSONL 行，再按已捕获
        // 的最终正文和 usage 正常收尾并释放完整进程树。
        queueMicrotask(() => {
          if (!runningProcesses.has(agentId)) return;
          resolveExecution({
            kill: true,
            reason: `${engine} 已发出 turn.completed 但进程未退出，按协议终止事件收尾并释放槽位`,
          });
        });
      }
    };

    proc.stdout.on("data", (data) => {
      lastCliOutputAt = Date.now();
      // CLI 的 UTF-8 中文可能横跨多个 data chunk；逐块 Buffer.toString()
      // 会把拆开的多字节字符永久替换为 �，随后一路进入实时命令输出。
      const text = typeof data === "string" ? data : stdoutDecoder.write(data);

      if (isClaudeCliEngine(engine)) {
        // Claude CLI stream-json 格式：
        // {"type":"system","subtype":"init",...}     — 初始化
        // {"type":"assistant","message":{content:[{type:"thinking",...},{type:"text",...},{type:"tool_use",...}]}} — 完整消息
        // {"type":"user","message":{content:[{type:"tool_result",...}]}} — 工具返回
        // {"type":"result",...}                      — 最终结果
        stdoutBuffer += text;
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop(); // 保留最后一个可能不完整的行

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const event = JSON.parse(trimmed);

            if (event.type === "assistant" && event.message?.content) {
              // 解析 assistant 消息中的 content blocks
              for (const block of event.message.content) {
                if (block.type === "thinking" && block.thinking) {
                  // 思考过程 — 广播给前端 + 写日志
                  emitStream(block.thinking, "thinking");
                  const truncated = block.thinking.length > 2000
                    ? block.thinking.slice(0, 2000) + "...(已截断)"
                    : block.thinking;
                  log(task.id, "info", "thinking", truncated);
                  pushTranscript("thinking", block.thinking);
                } else if (block.type === "text" && block.text) {
                  // 文本回复 — 流式推送
                  // 多段叙述（工具调用间的 text）用空行分隔，避免渲染时粘成一坨
                  textBlocks++;
                  stdout += (stdout ? "\n\n" : "") + block.text;
                  emitStream(block.text, "text");
                  pushTranscript("text", block.text);
                } else if (block.type === "tool_use") {
                  // 工具调用 — 通知前端 + 写日志
                  const { toolName, fullInput, liveLabel } = __testFormatClaudeToolUse(block.name, block.input);
                  emitStream(liveLabel, "tool_use");
                  log(task.id, "info", "tool_use", `调用工具: ${toolName}`);
                  pushTranscript("tool_use", toolName, { input: fullInput });
                }
              }
            } else if (event.type === "result") {
              // 本轮是否正常完成：Claude 的 result 事件带 subtype/is_error（success 且非 error 即为成功收尾）
              if (event.is_error !== true && (event.subtype == null || event.subtype === "success")) {
                claudeResultOk = true;
              }
              // 最终结果事件：单段回答用 result 字段（干净），多段叙述保留带空行分隔的累积文本
              if (event.result && textBlocks <= 1) {
                // 流式输入模式下一个进程内可有多条用户消息→多个 result，累加而非覆盖，避免末尾文本丢失
                stdout = streaming && stdout ? `${stdout}\n\n${event.result}` : event.result;
              }
              // 捕获 CLI 返回的 session_id，供后续 --resume 续接
              if (event.session_id) {
                cliSessionId = event.session_id;
              }
              // 捕获真实 token 用量（input/output/cache + 费用）
              if (event.usage) {
                usage = {
                  inputTokens: event.usage.input_tokens || 0,
                  outputTokens: event.usage.output_tokens || 0,
                  cacheReadTokens: event.usage.cache_read_input_tokens || 0,
                  cacheCreationTokens: event.usage.cache_creation_input_tokens || 0,
                  costUsd: event.total_cost_usd || null,
                };
                emitUsage(usage);
              }
              if (streaming) {
                // 流式输入：收到 result → 等一会儿，若无新注入就关 stdin 收尾（注入会取消该计时器，保持会话）
                scheduleIdleClose();
              } else if (!resultGraceTimer) {
                // Claude 已给出最终结果。若它在 -p 单轮里 spawn 了后台进程(tail -f / gradlew 等)，
                // 这些子进程会继承 stdout 管道，使 claude 进程不 EOF、close 永不触发，
                // 从而一直占着 CLI 并发槽导致后续消息卡死。这里设宽限超时强制收尾。
                resultGraceTimer = setTimeout(() => {
                  if (runningProcesses.has(agentId)) {
                    log(task.id, "warn", "agent-runner", `${engine} 已输出最终结果但进程未退出(疑似后台子进程占用管道)，强制结束以释放槽位`);
                    killProcessTree(runningProcesses.get(agentId).proc);
                  }
                }, 10000);
              }
            }
          } catch {
            // 非 JSON 行，作为普通文本处理
            stdout += trimmed;
            log(task.id, "info", engine, trimmed);
            noteActivity("stdout", trimmed);
          }
        }
      } else if (isHermesEngine(engine)) {
        // hermes chat -q 流式输出：工具进度行 + 正文逐句到达，带 ANSI/装饰。
        // 解析器剥离装饰后按事件类型实时转发；只有回答框内正文（final=true）
        // 才累积进 stdout（最终报告），框外过程文本仅作 thinking 流式展示，
        // 避免提示词回显/工具 diff 污染最终 content（对比 codex 的 codexFinalText）。
        const events = parseHermesChatStream(text, hermesChatStreamState);
        for (const ev of events) {
          if (ev.type === "meta") {
            if (hermesChatStreamState.sessionId) cliSessionId = hermesChatStreamState.sessionId;
            continue;
          }
          if (ev.type === "box_open") {
            // 新回答框开始：前一段框是过程叙述，丢弃（不进最终报告，仅已流式展示）
            hermesBoxBuffer = "";
            continue;
          }
          if (ev.type === "box_close") {
            // 回答框结束：封存当前框正文为最新候选（后面若再开框会被 box_open 丢弃）
            hermesFinalText = hermesBoxBuffer;
            continue;
          }
          if (ev.type === "tool_use") {
            emitStream(ev.text, "tool_use");
            pushTranscript("tool_use", ev.text);
            log(task.id, "info", "tool_use", `调用工具: ${ev.text}`);
            continue;
          }
          if (ev.type === "tool_output") {
            const textOut = ev.text.endsWith("\n") ? ev.text : `${ev.text}\n`;
            emitStream(textOut, "tool_output");
            pushTranscript("tool_output", ev.text);
            continue;
          }
          if (ev.type === "thinking") {
            emitStream(`${ev.text}\n`, "thinking");
            pushTranscript("thinking", ev.text);
            continue;
          }
          // text（final=true）：回答框内正文 → 累积进当前框缓冲；最后一个框结束时
          // 才作为最终报告（等价 codexFinalText）。过程中不直接进 stdout。
          hermesBoxBuffer += `${hermesBoxBuffer ? "\n" : ""}${ev.text}`;
          hermesStreamedText = true;
          emitStream(ev.text.endsWith("\n") ? ev.text : `${ev.text}\n`, "text");
          pushTranscript("text", ev.text);
          noteActivity("text", ev.text);
        }
      } else if (isCodexCliEngine(engine)) {
        stdoutBuffer += text;
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop();
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            handleCodexJsonEvent(JSON.parse(trimmed));
          } catch {
            stdout += line;
            codexStreamedText = true;
            emitStream(line, "text");
            log(task.id, "info", engine, trimmed);
            noteActivity("stdout", trimmed);
          }
        }
      } else {
        // Gemini 等其他引擎：保持原有文本模式
        stdout += text;
        emitStream(text, "text");
        noteActivity("stdout", text);
        const lines = text.split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed) {
            log(task.id, "info", engine, trimmed);
          }
        }
      }
    });

    proc.stderr.on("data", (data) => {
      lastCliOutputAt = Date.now();
      const text = typeof data === "string" ? data : stderrDecoder.write(data);
      stderr += text;
      const lines = text.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          log(task.id, "debug", engine, trimmed);
          noteActivity("stderr", trimmed);
          if (isCodexCliEngine(engine)) {
            emitStream(`[codex] ${trimmed}\n`, "thinking");
          }
        }
      }

      // Gemini 429/容量不足时，提前终止，触发快速 fallback
      if (engine === "gemini" && GEMINI_CAPACITY_ERROR.test(text)) {
        log(task.id, "warn", "agent-runner", `检测到 Gemini 容量不足(429)，提前终止以触发 fallback`);
        killProcessTree(proc);
      }
    });

    proc.on("close", (code) => {
      const stdoutTail = stdoutDecoder.end();
      if (stdoutTail) stdoutBuffer += stdoutTail;
      const stderrTail = stderrDecoder.end();
      if (stderrTail) stderr += stderrTail;
      if (isHermesEngine(engine)) {
        const hermesUsage = readHermesUsageFile(usageFile);
        if (hermesUsage) {
          usage = hermesUsage;
          emitUsage(usage);
        }
      }
      if (settled) {
        untrackRunningProcess(agentId);
        clearExecutionTimers();
        cleanupTaskFiles();
        const finish = terminalAfterClose;
        terminalAfterClose = null;
        try { finish?.(); } catch {}
        return;
      }
      settled = true;
      untrackRunningProcess(agentId);
      clearExecutionTimers();

      // 处理 stdoutBuffer 中残留的不完整行（Claude/Codex JSONL）
      if (isClaudeCliEngine(engine) && stdoutBuffer.trim()) {
        try {
          const event = JSON.parse(stdoutBuffer.trim());
          if (event.type === "result") {
            if (event.is_error !== true && (event.subtype == null || event.subtype === "success")) {
              claudeResultOk = true;
            }
            if (event.result && textBlocks <= 1) stdout = event.result;
            if (event.session_id) cliSessionId = event.session_id;
            if (event.usage) {
              usage = {
                inputTokens: event.usage.input_tokens || 0,
                outputTokens: event.usage.output_tokens || 0,
                cacheReadTokens: event.usage.cache_read_input_tokens || 0,
                cacheCreationTokens: event.usage.cache_creation_input_tokens || 0,
                costUsd: event.total_cost_usd || null,
              };
              emitUsage(usage);
            }
          }
        } catch {}
      }
      if (isCodexCliEngine(engine) && stdoutBuffer.trim()) {
        const trimmed = stdoutBuffer.trim();
        try {
          handleCodexJsonEvent(JSON.parse(trimmed));
        } catch {
          stdout += trimmed;
          codexStreamedText = true;
          emitStream(trimmed, "text");
        }
      }
      // hermes chat -q：flush 残留的半行（进程已结束，按事件类型收尾）
      if (isHermesEngine(engine) && hermesChatStreamState) {
        if (hermesChatStreamState.sessionId) cliSessionId = hermesChatStreamState.sessionId;
        const tailEvents = flushHermesChatStream(hermesChatStreamState);
        for (const ev of tailEvents) {
          if (ev.type === "tool_use") {
            emitStream(ev.text, "tool_use");
            pushTranscript("tool_use", ev.text);
          } else if (ev.type === "tool_output") {
            emitStream(`${ev.text}\n`, "tool_output");
            pushTranscript("tool_output", ev.text);
          } else if (ev.type === "thinking") {
            emitStream(`${ev.text}\n`, "thinking");
            pushTranscript("thinking", ev.text);
          } else {
            // 框内残留半行：进程结束时还在框内 → 属于最后一段框，累积进缓冲
            hermesBoxBuffer += `${hermesBoxBuffer ? "\n" : ""}${ev.text}`;
            hermesFinalText = hermesBoxBuffer;
            hermesStreamedText = true;
            emitStream(`${ev.text}\n`, "text");
            pushTranscript("text", ev.text);
          }
        }
      }
      if (isCodexCliEngine(engine) && codexFinalText) {
        // 最后一条 agent_message 才是 Codex 的终态答复；不能让前面的过程说明占据最终消息。
        stdout = codexFinalText;
      }
      if (isHermesEngine(engine) && hermesFinalText) {
        // 等价 codexFinalText：只取最后一个回答框的正文作为最终报告，
        // 工具调用间前几段框（过程叙述）不进 content。
        stdout = hermesFinalText;
      }

      // 清理临时文件
      cleanupTaskFiles();

      // Claude 系引擎已发出成功的 result 事件（本轮已正常完成），但进程仍以非 0 退出
      // （方舟端点常见：连接被重置/后台子进程占管道/CLI 收尾异常等），此时应按成功收尾，
      // 否则会把「任务状态：已完成」的正常结果当成 "退出码 1" 错误抛出。
      const claudeCompleted = isClaudeCliEngine(engine) && claudeResultOk;

      // 通知前端流式输出结束（附带真实 token 用量，供 devbench 等展示）
      const retryableCredentialRefresh = engine === "codex"
        && code !== 0
        && !String(stdout || "").trim()
        && isCodexRefreshTokenReusedError(stderr);
      if (!retryableCredentialRefresh) {
        broadcastChatStreamEnd({
          taskId: task.id,
          sessionId: task.sourceId || null,
          subtaskId: task.subtaskId || null,
          engine,
          success: code === 0 || claudeCompleted,
          usage,
          aiSnapshot: task.aiSnapshot || null,
          conversation: task.conversation || null,
        });
      }

      if (code === 0 || claudeCompleted) {
        if (code !== 0 && claudeCompleted) {
          log(task.id, "warn", "agent-runner", `${engine} 已输出成功结果但退出码 ${code}，按已完成收尾`);
        }
        // 非 Claude/Codex 结构化引擎：没有结构化 block，把最终 stdout 作为单条 text 条目
        if (!isClaudeCliEngine(engine) && stdout && transcript.length === 0) {
          pushTranscript("text", stdout);
        }
        resolve({ output: stdout, stderr, report: stdout, cliSessionId, transcript, usage });
      } else {
        const errText = stderr || stdout || "";
        // 续接的 CLI 会话已不存在（claude/gemini --resume 指向的会话被清理/过期/换了机器或目录）→ 标记 staleSession，
        // 让调用方清掉失效会话并改用新会话重试，避免每轮都 "No conversation found with session ID" 硬失败。
        const staleSession = !!task.cliSessionId &&
          /no conversation found with session id|session id\b.*\bnot found|could not (find|resume) (the )?(conversation|session)|conversation\b.*\bnot found/i.test(errText);
        // 出错也带上已捕获的 cliSessionId/transcript，供调用方保留续接链、不丢上下文
        const err = new Error(`${engine} 退出码 ${code}: ${errText.slice(0, 500)}`);
        // 会话已失效时不要把这个死 id 传回去续接（否则下一轮还会用它继续失败）
        err.cliSessionId = staleSession ? null : cliSessionId;
        err.staleSession = staleSession;
        err.transcript = transcript;
        err.partialOutput = stdout || "";
        reject(err);
      }
    });

    proc.on("error", (error) => {
      rejectExecution(new Error(`启动 ${engine} 失败: ${error.message}`));
    });

    // 双重超时保护：
    // 1. 活动超时：无输出判定卡死（Claude 有 extended thinking 需要更长，大型任务可能长时间无 stdout）
    // 2. 总超时：2 小时强制终止（防止无限运行）
    const idleOverride = Number(task.idleTimeoutMs);
    const maxOverride = Number(task.maxTimeoutMs);
    const IDLE_TIMEOUT_MS = Number.isFinite(idleOverride) && idleOverride > 0
      ? idleOverride
      : defaultIdleTimeoutMsForTask(engine, task);
    const MAX_TIMEOUT_MS = Number.isFinite(maxOverride) && maxOverride > 0
      ? maxOverride
      : defaultMaxTimeoutMsForTask(engine, task);

    // hermes chat -q 流式模式有实时输出，不再需要 oneshot 的"全静默"豁免；
    // idle 超时按 devbench 标准（60 分钟无输出才判卡死，思考/长工具执行不会误杀）。
    const silentOneshot = false;
    idleTimer = silentOneshot ? null : setTimeout(onIdle, IDLE_TIMEOUT_MS);
    maxTimer = setTimeout(onMax, MAX_TIMEOUT_MS);
    // 启动卡死监测：首次输出前生效。任务可用 task.firstOutputTimeoutMs 覆盖（毫秒）。
    const firstOutputOverride = Number(task.firstOutputTimeoutMs);
    const FIRST_OUTPUT_TIMEOUT_MS = Number.isFinite(firstOutputOverride) && firstOutputOverride > 0
      ? firstOutputOverride
      : DEFAULT_FIRST_OUTPUT_TIMEOUT_MS;
    const heartbeatOverride = Number(task.cliHeartbeatIntervalMs);
    const HEARTBEAT_INTERVAL_MS = Number.isFinite(heartbeatOverride) && heartbeatOverride > 0
      ? heartbeatOverride
      : CLI_HEARTBEAT_INTERVAL_MS;
    firstOutputTimer = setTimeout(onFirstOutputTimeout, FIRST_OUTPUT_TIMEOUT_MS);
    if (task.cliHeartbeat !== false && IDLE_TIMEOUT_MS >= 5 * MINUTE_MS) {
      heartbeatTimer = setInterval(onHeartbeat, HEARTBEAT_INTERVAL_MS);
      heartbeatTimer.unref?.();
    }

    function resetIdleTimer() {
      if (silentOneshot) return;
      // 首次 stdout/stderr 输出到达 → 启动期不再视为卡死，交由常规 idle 计时器接管后续沉默判定
      if (firstOutputTimer) { clearTimeout(firstOutputTimer); firstOutputTimer = null; }
      clearTimeout(idleTimer);
      idleTimer = setTimeout(onIdle, IDLE_TIMEOUT_MS);
    }

    function onIdle() {
      if (settled || !runningProcesses.has(agentId)) return;
      if (shouldTrustWorkingStatusForTask(engine, task)) {
        workingIdleExtensions++;
        const silentMs = Date.now() - lastCliOutputAt;
        const elapsedSinceActivity = Date.now() - (lastActivity?.ts || Date.now());
        const activity = lastActivity?.preview
          ? `; last activity ${formatDuration(elapsedSinceActivity)} ago: ${compactPreview(lastActivity.preview, 180)}`
          : "";
        const message = `${engine} is still Working; no CLI output for ${formatDuration(silentMs)}${activity}; keep waiting until max ${formatDuration(MAX_TIMEOUT_MS)}`;
        log(task.id, "info", "agent-runner", message);
        emitStream(message, "status");
        resetIdleTimer();
        return;
      }
      const elapsedSinceActivity = Date.now() - (lastActivity?.ts || Date.now());
      const activity = lastActivity?.preview
        ? `；最后活动 ${formatDuration(elapsedSinceActivity)}前：${compactPreview(lastActivity.preview, 180)}`
        : "";
      const message = `${engine} 已 ${formatDuration(IDLE_TIMEOUT_MS)}无输出，判定为卡死并终止${activity}`;
      const err = new Error(message);
      err.timeoutKind = "idle";
      log(task.id, "warn", "agent-runner", message);
      rejectExecution(err, { kill: true, terminalFailure: true });
    }

    function onMax() {
      if (settled || !runningProcesses.has(agentId)) return;
      const message = `${engine} 总执行时间超过 ${formatDuration(MAX_TIMEOUT_MS)}，强制终止`;
      log(task.id, "warn", "agent-runner", message);
      const err = new Error(message);
      err.timeoutKind = "max";
      rejectExecution(err, { kill: true, terminalFailure: true });
    }

    function onFirstOutputTimeout() {
      if (settled || !runningProcesses.has(agentId)) return;
      // 已有输出则交由常规 idle 计时器管理（本函数理论上也已被 resetIdleTimer 取消，双保险）
      if (stdout || stderr) return;
      const message = `${engine} 启动后 ${formatDuration(FIRST_OUTPUT_TIMEOUT_MS)} 仍无任何输出，判定为启动卡死（可能 stdin 管道阻塞或初始化挂起）并终止`;
      log(task.id, "warn", "agent-runner", message);
      const err = new Error(message);
      err.timeoutKind = "first-output";
      rejectExecution(err, { kill: true, terminalFailure: true });
    }

    function onHeartbeat() {
      if (settled || !runningProcesses.has(agentId)) return;
      const silentMs = Date.now() - lastCliOutputAt;
      if (silentMs < Math.max(0, HEARTBEAT_INTERVAL_MS - 1000)) return;
      const elapsedSinceActivity = Date.now() - (lastActivity?.ts || Date.now());
      const activity = lastActivity?.preview
        ? `；最后活动 ${formatDuration(elapsedSinceActivity)}前：${compactPreview(lastActivity.preview, 160)}`
        : "";
      const waitingForFirstOutput = Boolean(firstOutputTimer) && !stdout && !stderr;
      const timeoutLabel = silentOneshot
        ? `总执行上限 ${formatDuration(MAX_TIMEOUT_MS)}`
        : waitingForFirstOutput
        ? `首次输出上限 ${formatDuration(FIRST_OUTPUT_TIMEOUT_MS)}`
        : `idle 上限 ${formatDuration(IDLE_TIMEOUT_MS)}`;
      const message = `${engine} 仍在执行，已 ${formatDuration(silentMs)}没有 CLI 输出${activity}；${timeoutLabel}`;
      log(task.id, "info", "agent-runner", message);
      emitStream(message, "status");
    }

    // stdout/stderr 有输出时重置活动计时器
    proc.stdout.on("data", resetIdleTimer);
    proc.stderr.on("data", resetIdleTimer);

  });
}

// 缓存已读取的 skill 内容，避免重复读文件
const skillContentCache = new Map();

// 监听 skills 目录变化，自动清空缓存 + 重建能力文档 + 通知前端
import { invalidateCapabilityCache, generateCapabilityDoc } from "./capability-doc.js";
import { invalidatePlatformContext } from "./platform-context.js";
const SKILLS_DIR_WATCH = join(__dirname, "..", "..", "skills");
try {
  const skillsWatcher = watch(SKILLS_DIR_WATCH, { recursive: true }, () => {
    skillContentCache.clear();
    invalidateCapabilityCache();
    invalidatePlatformContext();
    try { generateCapabilityDoc(); } catch {}
    broadcastSkillsChanged();
  });
  // 测试/一次性脚本没有 HTTP server 时，不让文件监听器独自阻止进程退出。
  skillsWatcher.unref?.();
} catch {}

// 模板变量 → 运行时实际值
const PROJECT_ROOT = join(__dirname, "..", "..");
const TEMPLATE_VARS = {
  "{PROJECT_ROOT}": PROJECT_ROOT,
  "{SKILLS_DIR}": join(PROJECT_ROOT, "skills"),
  "{GATEWAY_URL}": `http://localhost:${process.env.PORT || 3001}`,
  "{PLATFORM}": process.platform === "darwin" ? "macOS" : process.platform === "win32" ? "Windows" : "Linux",
};

function replaceTemplateVars(content) {
  let result = content;
  for (const [key, value] of Object.entries(TEMPLATE_VARS)) {
    result = result.replaceAll(key, value);
  }
  return result;
}

function loadSkillContent(skillName) {
  if (skillContentCache.has(skillName)) {
    return skillContentCache.get(skillName);
  }
  // 先尝试顶层文件，再尝试子目录（如 skills/decrypt-elog/decrypt-elog.md）
  const candidates = [
    join(__dirname, "..", "..", "skills", `${skillName}.md`),
    join(__dirname, "..", "..", "skills", skillName, `${skillName}.md`),
  ];
  for (const skillPath of candidates) {
    try {
      if (existsSync(skillPath)) {
        const raw = readFileSync(skillPath, "utf-8");
        const content = replaceTemplateVars(raw);
        skillContentCache.set(skillName, content);
        return content;
      }
    } catch {}
  }
  skillContentCache.set(skillName, null);
  return null;
}

function loadDeviceProfiles() {
  const profilePath = join(__dirname, "..", "..", "configs", "device-profiles.json");
  try {
    if (existsSync(profilePath)) {
      return readFileSync(profilePath, "utf-8");
    }
  } catch {}
  return null;
}

function trimHistory(messages, engine) {
  const budget = engine === "gemini" ? 3000 : 6000;
  const maxPerUser = 500;
  const maxPerAssistant = 800;
  let totalLen = 0;
  const result = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const limit = msg.role === "user" ? maxPerUser : maxPerAssistant;
    let content = msg.content || "";
    if (content.length > limit) content = content.slice(0, limit) + "...(已截断)";
    if (totalLen + content.length > budget) break;
    totalLen += content.length;
    result.unshift({ role: msg.role, content });
  }
  return result;
}

import { buildContextBlock } from "./context-manager.js";

const STRUCTURED_DESCRIPTOR_KEYS = Object.freeze([
  "contextId",
  "contextRevision",
  "idempotencyKey",
  "mode",
  "schema",
  "schemaId",
  "strategy",
]);

function workflowV2StructuredTaskError(message) {
  const error = new Error(message);
  error.code = "WORKFLOW_V2_STRUCTURED_TASK_INVALID";
  error.terminalFailure = true;
  return error;
}

function isJsonValue(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false;
  seen.add(value);
  const children = Array.isArray(value) ? value : Object.values(value);
  const valid = children.every((child) => isJsonValue(child, seen));
  seen.delete(value);
  return valid;
}

function deepFreezeJson(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreezeJson(child);
  return Object.freeze(value);
}

function taskResultForPersistence(task, result) {
  if (task?.promptMode !== "structured") return result;
  const persisted = {};
  const descriptor = task?.structuredOutput;
  if (typeof descriptor?.schemaId === "string" && descriptor.schemaId) persisted.schemaId = descriptor.schemaId;
  if (typeof descriptor?.contextId === "string" && descriptor.contextId) persisted.contextId = descriptor.contextId;
  if (Number.isSafeInteger(descriptor?.contextRevision) && descriptor.contextRevision >= 1) {
    persisted.contextRevision = descriptor.contextRevision;
  }
  const safeFailureCode = String(result?.code || "");
  if ((/^WORKFLOW_V2_[A-Z0-9_]+$/.test(safeFailureCode)
    || ["AI_NO_MEANINGFUL_PROGRESS", "API_AGENT_ACTIVE_TURN_TIMEOUT"].includes(safeFailureCode))
    && typeof result?.error === "string") {
    persisted.code = result.code;
    persisted.error = result.error.slice(0, 500);
  }
  if (["AI_NO_MEANINGFUL_PROGRESS", "API_AGENT_ACTIVE_TURN_TIMEOUT"].includes(safeFailureCode)) {
    persisted.timeoutKind = result.timeoutKind || null;
    persisted.resumable = result.resumable === true;
    persisted.storyLifetimeExpired = false;
    persisted.lastMeaningfulProgressAt = result.lastMeaningfulProgressAt || null;
    persisted.terminationVerified = result.terminationVerified === true;
    persisted.terminationVerifiedAt = result.terminationVerifiedAt || null;
  }
  if (result?.usage && isJsonValue(result.usage)) {
    persisted.usage = JSON.parse(JSON.stringify(result.usage));
  }
  if (result?.telemetry && isJsonValue(result.telemetry)) {
    persisted.telemetry = JSON.parse(JSON.stringify(result.telemetry));
  }
  return persisted;
}

function cloneStructuredOutputDescriptor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !isJsonValue(value)) {
    throw workflowV2StructuredTaskError("structuredOutput 必须是可冻结的 JSON object");
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== STRUCTURED_DESCRIPTOR_KEYS.length
    || keys.some((key, index) => key !== STRUCTURED_DESCRIPTOR_KEYS[index])) {
    throw workflowV2StructuredTaskError("structuredOutput 字段不符合冻结合同");
  }
  if (value.mode !== "structured" || !["finish_stage", "json_text"].includes(value.strategy)) {
    throw workflowV2StructuredTaskError("structuredOutput mode/strategy 无效");
  }
  const schemaId = String(value.schemaId || "").trim();
  const contextId = String(value.contextId || "").trim();
  const idempotencyKey = String(value.idempotencyKey || "").trim();
  if (!schemaId || schemaId !== value.schemaId
    || !contextId || contextId !== value.contextId
    || !idempotencyKey || idempotencyKey !== value.idempotencyKey
    || !Number.isSafeInteger(value.contextRevision) || value.contextRevision < 1
    || !value.schema || typeof value.schema !== "object" || Array.isArray(value.schema)) {
    throw workflowV2StructuredTaskError("structuredOutput 缺少 schema/context/idempotency 身份");
  }
  const cloned = JSON.parse(JSON.stringify(value));
  return deepFreezeJson(cloned);
}

function finalizeStructuredCliResult(task, result) {
  const sanitizedTranscript = (Array.isArray(result?.transcript) ? result.transcript : [])
    .filter((item) => item?.type !== "text");
  const invalidJsonText = (message) => {
    const error = workflowV2StructuredTaskError(message);
    error.code = "WORKFLOW_V2_STRUCTURED_JSON_TEXT_INVALID";
    error.cliSessionId = null;
    error.transcript = sanitizedTranscript;
    error.usage = result?.usage || null;
    return error;
  };
  if (task?.structuredOutput?.strategy !== "json_text") {
    throw workflowV2StructuredTaskError("CLI structured result 与 json_text strategy 不一致");
  }
  const reportText = typeof result?.report === "string"
    ? result.report
    : (typeof result?.output === "string" ? result.output : "");
  if (typeof result?.report === "string"
    && typeof result?.output === "string"
    && result.report.trim() !== result.output.trim()) {
    throw invalidJsonText("CLI structured output/report 不一致");
  }
  let parsed;
  try {
    parsed = JSON.parse(reportText.trim());
  } catch {
    throw invalidJsonText("CLI structured report 必须是单一 JSON object");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw invalidJsonText("CLI structured report 必须是 JSON object");
  }
  return {
    ...result,
    output: "",
    report: "",
    cliSessionId: null,
    transcript: sanitizedTranscript,
    structuredResult: deepFreezeJson(JSON.parse(JSON.stringify(parsed))),
    structuredSchemaId: task.structuredOutput.schemaId,
  };
}

function prepareStructuredTask(task) {
  if (task?.promptMode !== "structured") return task;
  const prompt = typeof task.promptOverride === "string" ? task.promptOverride : "";
  const promptSha256 = createHash("sha256").update(prompt, "utf8").digest("hex");
  const descriptor = cloneStructuredOutputDescriptor(task.structuredOutput);
  const telemetry = task.telemetryContext;
  if (!telemetry || typeof telemetry !== "object" || Array.isArray(telemetry) || !isJsonValue(telemetry)) {
    throw workflowV2StructuredTaskError("structured telemetryContext 必须是可冻结的 JSON object");
  }
  const valid = prompt.trim().length > 0
    && task.cliSessionId === null
    && task.streamingInput === false
    && Array.isArray(task.imagePaths)
    && task.imagePaths.length === 0
    && typeof task.promptSha256 === "string"
    && task.promptSha256 === promptSha256
    && telemetry?.promptMode === "structured"
    && typeof telemetry.contextId === "string"
    && telemetry.contextId.trim().length > 0
    && Number.isSafeInteger(telemetry.contextRevision)
    && telemetry.contextRevision >= 1
    && /^[a-f0-9]{64}$/.test(String(telemetry.contextHash || ""))
    && telemetry.contextId === descriptor.contextId
    && telemetry.contextRevision === descriptor.contextRevision
    && telemetry.schemaId === descriptor.schemaId
    && telemetry.idempotencyKey === descriptor.idempotencyKey;
  if (!valid) {
    throw workflowV2StructuredTaskError("structured task 缺少冻结 Prompt/hash/context 或 telemetry 身份不一致");
  }
  const telemetrySnapshot = deepFreezeJson(JSON.parse(JSON.stringify(telemetry)));
  return { ...task, structuredOutput: descriptor, telemetryContext: telemetrySnapshot };
}

function buildPrompt(task, skill) {
  if (task.promptMode === "structured") {
    return prepareStructuredTask(task).promptOverride;
  }
  if (task.promptMode === "compatibility") {
    const prompt = typeof task.promptOverride === "string" ? task.promptOverride : "";
    const sha256 = createHash("sha256").update(prompt, "utf8").digest("hex");
    const valid = !!prompt
      && task.cliSessionId == null
      && task.streamingInput === false
      && Array.isArray(task.imagePaths)
      && task.imagePaths.length === 0
      && typeof task.promptSha256 === "string"
      && task.promptSha256 === sha256
      && typeof task.telemetryContext?.contextId === "string"
      && task.telemetryContext.contextId.trim().length > 0
      && Number.isSafeInteger(task.telemetryContext?.contextRevision)
      && task.telemetryContext.contextRevision >= 1
      && /^[a-f0-9]{64}$/.test(String(task.telemetryContext?.contextHash || ""))
      && task.telemetryContext?.promptMode === "compatibility";
    if (!valid) {
      const error = new Error("compatibility task 缺少冻结 Prompt/hash/context，拒绝回退 legacy builder");
      error.code = "WORKFLOW_V2_COMPATIBILITY_PROMPT_INVALID";
      throw error;
    }
    return prompt;
  }
  // devbench 等模块直接提供完整 prompt 时，原样使用（不叠加 Persona/Skill/任务模板）
  if (task.promptOverride) return task.promptOverride;

  let prompt = "";
  const engine = task.assignedEngine || "claude";

  // 1. Persona + 对话摘要 + 智能历史（无 CLI session 时注入）
  if (!task.cliSessionId) {
    const sessionId = task.sourceId || null;
    const contextBlock = buildContextBlock(sessionId, engine);
    if (contextBlock) {
      prompt += contextBlock + "\n---\n\n";
    }
  }

  // 2. Skill 指南
  if (skill) {
    const skillContent = loadSkillContent(skill);
    if (skillContent) {
      prompt += `## Skill 指南 (/${skill})\n\n${skillContent}\n\n---\n\n`;
      prompt += `请严格按照上述 Skill 指南来处理以下任务。\n\n`;
    } else {
      prompt += `请使用 /${skill} skill 来处理以下任务。\n\n`;
    }
  }

  // 3. 任务信息
  prompt += `## 任务信息\n`;
  prompt += `- 标题: ${task.title}\n`;
  prompt += `- 类型: ${task.type}\n`;
  prompt += `- 优先级: P${task.priority}\n\n`;

  if (task.description) {
    prompt += `## 任务描述\n${task.description}\n\n`;
  }

  // 4. 适配类任务注入设备参数
  if (["complex_adaptation", "simple_adaptation"].includes(task.type)) {
    const profiles = loadDeviceProfiles();
    if (profiles) {
      prompt += `## 参考设备配置\n\`\`\`json\n${profiles}\n\`\`\`\n\n`;
    }
  }

  prompt += `请完成上述任务并输出结构化的分析报告。`;
  return prompt;
}

function broadcastLoginPrompt(taskId, engine) {
  const loginCmd = isAtlasStoryEngine(engine)
    ? "设置页配置并启用 Atlas Coding Plan 后重试"
    : isClaudeVolcengineEngine(engine)
    ? "设置页一键配置 Claude（火山方舟）后重试"
    : engine === "claude"
      ? "claude login"
      : engine === "codex"
        ? "codex login"
        : isHermesEngine(engine)
          ? "hermes setup"
          : "gemini";
  log(taskId, "error", engine, `需要登录: 请在终端运行 ${loginCmd} 完成认证`);
  broadcastLoginRequired({ engine, taskId, loginCmd });
}

function broadcastEngineFallback(taskId, failedEngine, fallbackEngine) {
  log(taskId, "warn", "dispatcher", `ENGINE_FALLBACK: ${failedEngine} -> ${fallbackEngine}`);
}

export function stopAgent(agentId) {
  const entry = runningProcesses.get(agentId);
  if (entry) {
    const aborted = typeof entry.abort === "function" ? entry.abort("用户手动终止") : false;
    if (!aborted) {
      killProcessTree(entry.proc);
      untrackRunningProcess(agentId);
    }
    return true;
  }
  return false;
}

/**
 * 终止任务及其所有子任务的进程
 * 匹配 taskId 或 parentTaskId，确保 DAG 子任务也能被终止
 */
export function stopTaskAgent(taskId) {
  const matched = [];

  for (const [agentId, entry] of runningProcesses) {
    if (entry.taskId === taskId || entry.parentTaskId === taskId) {
      matched.push({ agentId, entry });
    }
  }

  if (matched.length === 0) return false;

  for (const { agentId, entry } of matched) {
    const aborted = typeof entry.abort === "function" ? entry.abort("用户手动终止") : false;
    if (!aborted) {
      killProcessTree(entry.proc);
      untrackRunningProcess(agentId);
    }
    updateTask(entry.taskId, { status: "failed", result: JSON.stringify({ error: "用户手动终止" }) });
    broadcastTaskUpdate({ id: entry.taskId, status: "failed" });
    updateAgentStatus(agentId, "idle", null);
    broadcastAgentStatus({ id: agentId, status: "idle", taskId: null });
    log(entry.taskId, "warn", "agent-runner", "任务被用户手动终止");
  }

  // 父任务本身也标记为 failed
  const parentMatched = matched.some(m => m.entry.parentTaskId === taskId);
  if (parentMatched) {
    updateTask(taskId, { status: "failed", result: JSON.stringify({ error: "用户手动终止（含子任务）" }) });
    broadcastTaskUpdate({ id: taskId, status: "failed" });
    log(taskId, "warn", "agent-runner", "父任务及子任务被用户手动终止");
  }

  return true;
}

export function getRunningAgents() {
  return Array.from(runningProcesses.keys());
}

/**
 * 把一条用户消息【注入】到某任务正在运行的会话（仅 claude 流式输入模式有效）。
 * 像 Claude CLI 一样让正在工作的 Agent 在下一思考循环读取并重新规划，而非排队等本轮结束。
 * Promise 返回 true=已由底层协议确认接收；false=该任务不在跑/非流式/写入失败
 * （调用方可退回排队）。不能用 stream.write() 的背压布尔值判断消息失败。
 */
export async function injectIntoTask(taskId, text) {
  if (!taskId) return false;
  for (const entry of runningProcesses.values()) {
    if ((entry.taskId === taskId || entry.parentTaskId === taskId) && entry.streamingInput && typeof entry.injectUser === "function") {
      try { return !!(await entry.injectUser(text)); } catch { return false; }
    }
  }
  return false;
}

/**
 * 判断某个任务（含其 DAG 子任务）的进程是否真的还在运行。
 * 用于识别"残留运行态"——重启等原因导致 taskId 被记下但进程其实已不存在。
 */
export function isTaskAgentRunning(taskId) {
  if (!taskId) return false;
  for (const entry of runningProcesses.values()) {
    if (entry.taskId === taskId || entry.parentTaskId === taskId) return true;
  }
  return false;
}

export function isTaskAgentRunningAnywhere(taskId) {
  if (isTaskAgentRunning(taskId)) return true;
  try {
    if (hasActiveTaskRuntimeLease(taskId)
      || hasActiveWorktreeResourceLeaseForTask(taskId)) return true;
    return listTaskRuntimeLeases(taskId)
      .some((lease) => isSameLiveProcess(lease.worker_pid, lease.worker_identity));
  } catch {
    // 破坏性调用依赖该谓词；运行态数据库不可读时必须失败关闭。
    return true;
  }
}

export async function isTaskAgentRunningAnywhereAsync(taskId) {
  if (isTaskAgentRunning(taskId)) return true;
  try {
    if (hasActiveTaskRuntimeLease(taskId)
      || hasActiveWorktreeResourceLeaseForTask(taskId)) return true;
    const leases = listTaskRuntimeLeases(taskId);
    for (const lease of leases) {
      if (await isSameLiveProcessAsync(lease.worker_pid, lease.worker_identity)) return true;
    }
    return false;
  } catch {
    return true;
  }
}

export function reconcileInactiveTaskRuntimeState(taskId) {
  const task = String(taskId || "").trim();
  if (!task) return { active: false, taskUpdated: 0, agentsCleared: 0, leasesRemoved: 0 };
  if (isTaskAgentRunningAnywhere(task)) {
    return { active: true, taskUpdated: 0, agentsCleared: 0, leasesRemoved: 0 };
  }
  try {
    return settleInactiveTaskRuntimeState(task);
  } catch {
    // 状态数据库不可用时保持原状态，不能把"不确定"当成已停止。
    return { active: true, taskUpdated: 0, agentsCleared: 0, leasesRemoved: 0 };
  }
}

export async function reconcileInactiveTaskRuntimeStateAsync(taskId) {
  const task = String(taskId || "").trim();
  if (!task) return { active: false, taskUpdated: 0, agentsCleared: 0, leasesRemoved: 0 };
  if (await isTaskAgentRunningAnywhereAsync(task)) {
    return { active: true, taskUpdated: 0, agentsCleared: 0, leasesRemoved: 0 };
  }
  try {
    return settleInactiveTaskRuntimeState(task);
  } catch {
    return { active: true, taskUpdated: 0, agentsCleared: 0, leasesRemoved: 0 };
  }
}

export function reconcileStaleRuntimeStates() {
  let taskIds;
  try {
    taskIds = listRuntimeStateTaskIds();
  } catch {
    return { checked: 0, active: 0, settled: 0, taskUpdated: 0, agentsCleared: 0 };
  }
  const summary = {
    checked: taskIds.length,
    active: 0,
    settled: 0,
    taskUpdated: 0,
    agentsCleared: 0,
  };
  for (const taskId of taskIds) {
    const result = reconcileInactiveTaskRuntimeState(taskId);
    if (result.active) {
      summary.active += 1;
      continue;
    }
    summary.settled += 1;
    summary.taskUpdated += Number(result.taskUpdated) || 0;
    summary.agentsCleared += Number(result.agentsCleared) || 0;
  }
  return summary;
}

export async function reconcileStaleRuntimeStatesAsync() {
  let taskIds;
  try {
    taskIds = listRuntimeStateTaskIds();
  } catch {
    return { checked: 0, active: 0, settled: 0, taskUpdated: 0, agentsCleared: 0 };
  }
  const summary = {
    checked: taskIds.length,
    active: 0,
    settled: 0,
    taskUpdated: 0,
    agentsCleared: 0,
  };
  for (const taskId of taskIds) {
    const result = await reconcileInactiveTaskRuntimeStateAsync(taskId);
    if (result.active) {
      summary.active += 1;
      continue;
    }
    summary.settled += 1;
    summary.taskUpdated += Number(result.taskUpdated) || 0;
    summary.agentsCleared += Number(result.agentsCleared) || 0;
  }
  return summary;
}

export { killProcessTree };
