import express from "express";
import cors from "cors";
import { createServer } from "http";
import { createServer as createHttpsServer } from "https";
import { WebSocketServer } from "ws";
import db, {
  getStats,
  getAgents,
  getTokenUsage,
  getTokenUsageDaily,
  getWorkflowObservability,
  searchLogs,
  pruneOldLogs,
} from "./db/sqlite.js";
import { setWsAuthInvalidationHandler, setWsClients } from "./services/logger.js";
import { getRunningAgents, reconcileStaleRuntimeStates, reconcileStaleRuntimeStatesAsync } from "./services/agent-runner.js";
import { getConfig } from "./services/config.js";
import tasksRouter from "./routes/tasks.js";
import logsRouter from "./routes/logs.js";
import dingtalkRouter from "./routes/dingtalk.js";
import configRouter from "./routes/config.js";
import chatRouter from "./routes/chat.js";
import skillsRouter from "./routes/skills.js";
import clipboardRouter from "./routes/clipboard.js";
import devicesRouter from "./routes/devices.js";
import workflowsRouter, { workflowRunsRouter } from "./routes/workflows.js";
import reportRouter from "./routes/report.js";
import scheduleRouter from "./routes/schedule.js";
import driveeatsRouter from "./routes/driveeats.js";
import cardevRouter from "./routes/cardev.js";
import devbenchRouter, {
  requireDevbenchAuth,
  recoverLocalStoryWorkspaceInitializations,
  recoverRemoteStorySourceInitializations,
} from "./routes/devbench.js";
import devbenchArtifactsRouter from "./routes/devbench-artifacts.js";
import projectdevRouter from "./routes/projectdev.js";
import performanceRouter from "./routes/performance.js";
import claudeProxyRouter from "./routes/claude-proxy.js";
import agentV2Router from "./routes/agent-v2.js";
import executorRouter from "./routes/executor.js";
import distributedRouter from "./routes/distributed.js";
import adminRouter from "./routes/admin.js";
import discoveryRouter from "./routes/discovery.js";
import lanSyncRouter from "./routes/lan-sync.js";
import feedbackRouter from "./routes/feedback.js";
import helpRouter from "./routes/help.js";
import distributeRouter from "./routes/distribute.js";
import backupRouter from "./routes/backup.js";
import feishuProjectSyncRouter from "./routes/feishu-project-sync.js";
import aiautoworkRouter from "./routes/aiautowork.js";
import { initDiscovery } from "./services/discovery.js";
import { handleLanSyncConnection, initLanSync, stopLanSync } from "./services/lan-sync/index.js";
import { lanSyncServerTlsOptions, lanSyncTlsConfig } from "./services/lan-sync/tls.js";
import { initScheduler } from "./services/scheduler.js";
import { initFeishu } from "./services/feishu.js";
import { initTbTaskWatcher } from "./services/tb-task-watcher.js";
import { schedulePersistedTabQueueDrains } from "./services/devbench/index.js";
import { syncSharedConfig } from "./services/config.js";
import { refreshAndroidStudioState } from "./services/android-studio.js";
import tbTasksRouter from "./routes/tb-tasks.js";
import { BugAgentStorage } from "./services/bug-agent/storage/db.js";
import { createBugAgentRouter } from "./services/bug-agent/api/routes.js";
import { log as logFn } from "./services/logger.js";
import {
  handlePerformanceResourceVideoConnection,
  isPerformanceResourceVideoRequest,
  stopAllPerformanceResourceVideoStreams,
} from "./services/performance-resource-stream.js";
import { closeAppMarketMcpBridge } from "./services/appmarket-admin-mcp.js";
import {
  isPerformanceResourceLocalOnlyPath,
  isTrustedPerformanceResourceRequest,
} from "./services/performance-resource-local-access.js";
import {
  attachTbBrowserViewer,
  detachTbBrowserViewer,
  handleTbBrowserInput,
} from "./services/tb-remote-browser.js";
import {
  attachFeishuBrowserViewer,
  detachFeishuBrowserViewer,
  handleFeishuBrowserInput,
} from "./services/feishu-remote-browser.js";
import { join as pathJoin, dirname as pathDirname } from "path";
import { fileURLToPath as toFileUrlPath } from "url";
import { existsSync as fsExistsSync } from "fs";
import { verifyToken } from "./services/admin-auth.js";
import { isLocalTrustedWsRequest } from "./services/ws-local-trust.js";
import { isActiveTbLoginChallenge } from "./services/tb-login-challenge.js";

const app = express();
const PORT = process.env.PORT || 3001;

// 性能采集控制、状态与原始证据必须在宽松的全局 CORS 之前拦截，避免恶意网页
// 借本机浏览器访问 localhost，或通过 Host/DNS rebinding 绕过路由级本机校验。
app.use((req, res, next) => {
  if (
    isPerformanceResourceLocalOnlyPath(req.originalUrl || req.url)
    && !isTrustedPerformanceResourceRequest(req)
  ) {
    return res.status(403).json({ success: false, error: "性能测试控制与原始数据仅允许本机可信页面访问" });
  }
  return next();
});

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    let parsed;
    try { parsed = new URL(origin); } catch { return cb(null, false); }
    const host = parsed.hostname.toLowerCase();
    const privateHost = host === "localhost"
      || host === "127.0.0.1"
      || host === "::1"
      || /^10\./.test(host)
      || /^192\.168\./.test(host)
      || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
    if (["http:", "https:"].includes(parsed.protocol) && privateHost) return cb(null, true);
    const config = getConfig();
    if (config.cloudDomain) {
      try {
        const allowedHost = new URL(
          /^https?:\/\//i.test(config.cloudDomain) ? config.cloudDomain : `https://${config.cloudDomain}`,
        ).hostname.toLowerCase();
        if (host === allowedHost || host.endsWith(`.${allowedHost}`)) return cb(null, true);
      } catch {}
    }
    return cb(null, false);
  },
  credentials: true,
}));
// Bug Agent 路由必须在 express.json 全局中间件之前挂载，
// 因为 /api/bug/webhook/feishu 需要读取原始字节做 HMAC 签名校验。
// bug-agent router 内部会为其他 JSON 路由自行挂载 express.json()。
const bugAgentStorage = new BugAgentStorage();
// 注入给 devbench 经验沉淀，让 TB 单完成后的经验可 best-effort 写入 Bug Agent 记忆（复用同一存储单例）
import("./services/devbench/lessons.js").then((m) => m.setBugAgentStorage(bugAgentStorage)).catch(() => {});
app.use(
  "/api/bug",
  createBugAgentRouter({
    storage: bugAgentStorage,
    logger: (level, module, msg) => logFn(null, level, module, msg),
  })
);

app.use(express.json({ limit: "10mb" }));

// TB / 飞书远程扫码 viewer（独立 HTML，避免 SPA HashRouter 干扰；须在面板 fallback 之前）
{
  const gatewayDir = pathDirname(toFileUrlPath(import.meta.url));
  const tbBrowserHtml = pathJoin(gatewayDir, "public", "tb-browser.html");
  const feishuBrowserHtml = pathJoin(gatewayDir, "public", "feishu-browser.html");
  app.get("/tb-browser", (req, res) => {
    if (!fsExistsSync(tbBrowserHtml)) {
      return res.status(404).type("text").send("tb-browser.html missing");
    }
    res.sendFile(tbBrowserHtml);
  });
  app.get("/tb-browser/session/current", (req, res) => res.redirect(302, "/tb-browser"));
  app.get("/feishu-browser", (req, res) => {
    if (!fsExistsSync(feishuBrowserHtml)) {
      return res.status(404).type("text").send("feishu-browser.html missing");
    }
    res.sendFile(feishuBrowserHtml);
  });
  app.get("/feishu-browser/session/current", (req, res) => res.redirect(302, "/feishu-browser"));
}

// ---------- 部署角色：server | node | standalone（默认 standalone=全挂，单机/向后兼容）----------
// 优先级：环境变量 ROLE > 配置 role > standalone
const ROLE = String(process.env.ROLE || getConfig().role || "standalone").toLowerCase();
const isServer = ROLE === "server" || ROLE === "standalone";   // 中心：Claude 能力 + 编排（+未来 admin）
const isNode = ROLE === "node" || ROLE === "standalone";       // 节点/客户端：本地执行 + 全部开发工具
console.log(`[role] 部署角色 = ${ROLE}（server=${isServer} node=${isNode}）`);

// ---------- API路由（按角色挂载）----------

// 始终挂载：核心配置（两种角色都要读/改配置）
app.use("/api/config", configRouter);
// 始终挂载：服务发现（服务端广播算力 / 客户端选服务端，两种角色都需要）
app.use("/api/discovery", discoveryRouter);
// 团队配置 LAN 增量同步的配对、成员与诊断接口；业务发布接口仍归 devbench。
app.use("/api/lan-sync", lanSyncRouter);
// 问题反馈 + 帮助中心文档：两种角色都挂（客户端经 forwardCentral 转发到服务端）
app.use("/api/feedback", feedbackRouter);
app.use("/api/help", helpRouter);
// AI 配置/记忆/Skills 备份迁移作用于当前网关本机文件；所有角色都应可检测并明确响应。
app.use("/api/backup", backupRouter);
// 管理员鉴权始终挂载：纯客户端也需要登录后把本机角色切回 standalone/server。
// 前端导航仍按 isServer 隐藏完整管理后台入口，node 主要用于 /auth/* 解锁本机设置。
app.use("/api/admin", adminRouter);

// 服务端角色：中心 AI 文本代理 + 分布式编排（未来 admin 后台亦在此）
if (isServer) {
  app.use("/api/claude-proxy", claudeProxyRouter);
  app.use("/api/agent/v2", agentV2Router);
  app.use("/api/distributed", distributedRouter);
  // LAN 自分发：客户端无需中心 Docker，从本服务端 /install 一键装（可配置关闭）
  if (getConfig().servers?.distribute !== false) app.use("/", distributeRouter);
}

// 节点/客户端角色：本地执行器 + 全部开发工具（被中心驱动 + 本地开发）
if (isNode) {
  app.use("/api/tasks", tasksRouter);
  app.use("/api/logs", logsRouter);
  app.use("/api/dingtalk", dingtalkRouter);
  app.use("/api/chat", chatRouter);
  app.use("/api/skills", skillsRouter);
  app.use("/api/clipboard", clipboardRouter);
  app.use("/api/devices", devicesRouter);
  app.use("/api/workflows", workflowsRouter);
  app.use("/api/workflow-runs", workflowRunsRouter);
  app.use("/api/report", reportRouter);
  app.use("/api/schedule", scheduleRouter);
  app.use("/api/tb-tasks", tbTasksRouter);
  app.use("/api/feishu-project-sync", feishuProjectSyncRouter);
  app.use("/api/driveeats", driveeatsRouter);
  app.use("/api/cardev", cardevRouter);
  app.use("/api/devbench", requireDevbenchAuth, devbenchArtifactsRouter);
  app.use("/api/devbench", devbenchRouter);
  app.use("/api/project-dev", projectdevRouter);
  app.use("/api/performance", performanceRouter);
  app.use("/api/executor", executorRouter);
  // AI Workbench（/aiautowork）— 节点角色必须有，因为它是基于 devbench 的上层入口
  app.use("/api/aiautowork", aiautoworkRouter);
}

// 服务端角色也开放只读入口（概览/设置/审计），方便多人面板访问
if (isServer) {
  app.use("/api/aiautowork", aiautoworkRouter);
}

// Token 用量
app.get("/api/tokens", (req, res) => {
  const requestedDays = Number(req.query.days);
  const days = Number.isFinite(requestedDays) && requestedDays > 0
    ? Math.min(3650, Math.max(1, Math.floor(requestedDays)))
    : 30;
  const dailyDays = Math.min(days, 30);
  const summary = getTokenUsage({ days });
  const daily = getTokenUsageDaily({ days: dailyDays });
  const workflow = getWorkflowObservability({ days });
  res.json({ success: true, data: { windowDays: days, dailyWindowDays: dailyDays, summary, daily, workflow } });
});

// 日志搜索
app.get("/api/logs/search", (req, res) => {
  const { taskId, taskIds, keyword, level, limit } = req.query;
  const logs = searchLogs({
    taskId,
    taskIds: taskIds ? taskIds.split(",") : undefined,
    keyword,
    level,
    limit: limit ? parseInt(limit) : 200,
  });
  res.json({ success: true, data: logs });
});

// 系统状态
app.get("/api/status", (req, res) => {
  const stats = getStats();
  const agents = getAgents();
  const runningAgents = getRunningAgents();
  const tokens = getTokenUsage({ days: 30 });

  res.json({
    success: true,
    data: { stats, agents, runningAgents, tokens, uptime: process.uptime(), timestamp: new Date().toISOString() },
  });
});

import { createRequire } from "module";
const _require = createRequire(import.meta.url);
const _pkg = _require("./package.json");

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", version: _pkg.version || "unknown", timestamp: new Date().toISOString() });
});

// 前端面板托管：Electron 桌面模式 或 服务端角色(LAN 自分发，客户端可直接打开本服务端面板)
if (process.env.ELECTRON === "1" || isServer) {
  const { existsSync } = await import("fs");
  const { join, dirname } = await import("path");
  const { fileURLToPath } = await import("url");
  const __dirname = dirname(fileURLToPath(import.meta.url));
  // 打包后 web-dist 在 resources 目录；源码部署用 web-dashboard/dist（需先 npm run build）
  const webDist = join(__dirname, "..", "web-dist");
  const devDist = join(__dirname, "..", "web-dashboard", "dist");
  const distDir = existsSync(webDist) ? webDist : existsSync(devDist) ? devDist : null;
  if (distDir) {
    app.use(express.static(distDir));
    app.get("*", (req, res, next) => {
      // 分发/安装/接口/远程扫码页不走面板回退
      if (
        req.path.startsWith("/api/")
        || req.path === "/ws"
        || req.path === "/install"
        || req.path === "/setup.ps1"
        || req.path.startsWith("/download/")
        || req.path === "/tb-browser"
        || req.path.startsWith("/tb-browser/")
        || req.path === "/feishu-browser"
        || req.path.startsWith("/feishu-browser/")
      ) return next();
      res.sendFile(join(distDir, "index.html"));
    });
    console.log(`[panel] 前端面板托管: ${distDir}`);
  } else if (isServer) {
    console.log(`[panel] 未找到面板构建产物(web-dist / web-dashboard/dist)，/install 的"网页版"入口需先构建前端`);
  }
}

// ---------- HTTP + WebSocket ----------

const lanTls = lanSyncTlsConfig();
const server = lanTls.enabled
  ? createHttpsServer(lanSyncServerTlsOptions(), app)
  : createServer(app);
const wss = new WebSocketServer({
  server,
  path: "/ws",
  // Never echo the credential-bearing protocol value in the handshake.
  handleProtocols(protocols) {
    return protocols.has("aiefficiency.v1") ? "aiefficiency.v1" : false;
  },
});

const wsClients = new Set();
const authenticatedWsClients = new Set();
setWsClients(wsClients);

function websocketProtocolSession(req) {
  const values = String(req.headers["sec-websocket-protocol"] || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!values.includes("aiefficiency.v1")) return null;
  const credentials = values.filter((value) => value.startsWith("aiefficiency.auth."));
  if (credentials.length !== 1) return null;
  const token = credentials[0].slice("aiefficiency.auth.".length);
  if (!/^[0-9a-f]{48}$/i.test(token)) return null;
  const principal = verifyToken(token);
  return principal ? { token, principal } : null;
}

function websocketTbLoginChallenge(req) {
  const values = String(req.headers["sec-websocket-protocol"] || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!values.includes("aiefficiency.v1")) return "";
  const credentials = values.filter((value) => value.startsWith("aiefficiency.tb-login."));
  if (credentials.length !== 1) return "";
  const token = credentials[0].slice("aiefficiency.tb-login.".length);
  return isActiveTbLoginChallenge(token) ? token : "";
}

function closeRevokedWebSocket(ws) {
  authenticatedWsClients.delete(ws);
  wsClients.delete(ws);
  try { ws.close(1008, "administrator session revoked"); } catch {}
}

function revalidateWebSocket(ws) {
  const principal = ws.authToken ? verifyToken(ws.authToken) : null;
  if (!principal) {
    closeRevokedWebSocket(ws);
    return null;
  }
  ws.principal = principal;
  return principal;
}

setWsAuthInvalidationHandler(() => {
  for (const ws of authenticatedWsClients) revalidateWebSocket(ws);
});

wss.on("connection", (ws, req) => {
  let requestUrl;
  try {
    requestUrl = new URL(req.url || "/ws", "http://localhost");
  } catch {
    try { ws.close(1008, "invalid websocket url"); } catch {}
    return;
  }
  if (requestUrl.searchParams.get("channel") === "lan-sync") {
    handleLanSyncConnection(ws, req);
    return;
  }
  // scrcpy 视频连接使用独立客户端集合和二进制帧，不进入全局 JSON 广播集合。
  // URL 只携带 runId；设备 serial 由 performance runner 的冻结状态决定。
  const environment = String(process.env.NODE_ENV || "").trim().toLowerCase();
  const allowUnauthenticatedDevelopment = environment === "test"
    || (
      environment === "development"
      && String(process.env.AIEFFICIENCY_ALLOW_UNAUTHENTICATED_WS || "") === "1"
    );
  const authSession = websocketProtocolSession(req);
  const principal = authSession?.principal || null;
  const tbLoginChallenge = websocketTbLoginChallenge(req);
  // 本机回环 + 受信 Origin 的连接放行免认证建立实时通道；否则生产环境仍要求有效
  // admin token 或 TB 登录挑战。此前 WS 强制鉴权而 HTTP 业务路由对本机请求免认证，
  // 导致本机浏览器收不到 chat_stream 实时流（故事点实时信息不显示，所有模型均受影响）。
  // 判定逻辑见 services/ws-local-trust.js。
  const localTrusted = isLocalTrustedWsRequest(req);
  if (!allowUnauthenticatedDevelopment && !principal && !tbLoginChallenge && !localTrusted) {
    try { ws.close(1008, "websocket authentication required"); } catch {}
    return;
  }
  if (!principal && tbLoginChallenge) {
    ws.tbLoginChallenge = tbLoginChallenge;
    ws.send(JSON.stringify({ type: "connected", data: { timestamp: new Date().toISOString(), scope: "tb-login" } }));
    ws.on("message", (raw) => {
      try {
        if (!isActiveTbLoginChallenge(ws.tbLoginChallenge)) {
          detachTbBrowserViewer(ws);
          ws.close(1008, "tb login challenge expired");
          return;
        }
        const msg = JSON.parse(raw);
        if (msg.type === "tb_browser_subscribe") attachTbBrowserViewer(ws);
        else if (msg.type === "tb_browser_detach") detachTbBrowserViewer(ws);
        else if (msg.type === "tb_browser_input") handleTbBrowserInput(msg.data || {});
      } catch {}
    });
    return;
  }
  ws.principal = principal || null;
  ws.authToken = authSession?.token || "";
  if (ws.authToken) {
    authenticatedWsClients.add(ws);
    const forgetAuthenticatedSocket = () => authenticatedWsClients.delete(ws);
    ws.once("close", forgetAuthenticatedSocket);
    ws.once("error", forgetAuthenticatedSocket);
  }
  ws.performanceResourceTrusted = isTrustedPerformanceResourceRequest(req);
  if (isPerformanceResourceVideoRequest(requestUrl)) {
    handlePerformanceResourceVideoConnection(ws, req, requestUrl);
    return;
  }
  ws.subscribedSessions = new Set();
  wsClients.add(ws);
  ws.send(JSON.stringify({ type: "connected", data: { timestamp: new Date().toISOString() } }));

  ws.on("message", (raw) => {
    try {
      if (ws.authToken && !revalidateWebSocket(ws)) return;
      const msg = JSON.parse(raw);
      if (msg.type === "subscribe_session") ws.subscribedSessions.add(msg.sessionId);
      else if (msg.type === "unsubscribe_session") ws.subscribedSessions.delete(msg.sessionId);
      else if (msg.type === "tb_browser_subscribe") attachTbBrowserViewer(ws);
      else if (msg.type === "tb_browser_detach") detachTbBrowserViewer(ws);
      else if (msg.type === "tb_browser_input") handleTbBrowserInput(msg.data || {});
      else if (msg.type === "feishu_browser_subscribe") attachFeishuBrowserViewer(ws);
      else if (msg.type === "feishu_browser_detach") detachFeishuBrowserViewer(ws);
      else if (msg.type === "feishu_browser_input") handleFeishuBrowserInput(msg.data || {});
    } catch {}
  });

  ws.on("close", () => { wsClients.delete(ws); authenticatedWsClients.delete(ws); });
  ws.on("error", () => { wsClients.delete(ws); authenticatedWsClients.delete(ws); });
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    stopLanSync();
    Promise.allSettled([
      stopAllPerformanceResourceVideoStreams(signal),
      closeAppMarketMcpBridge(),
    ]).finally(() => process.exit(0));
  });
}

server.listen(PORT, () => {
  console.log(`AI工作提效网关已启动 → ${lanTls.enabled ? "https" : "http"}://localhost:${PORT}`);

  try {
    const studioState = refreshAndroidStudioState();
    console.log(`[android-studio] detected=${studioState.count} default=${studioState.defaultExe || "none"}`);
  } catch (e) {
    console.error("[android-studio] refresh failed:", e.message);
  }

  // 不在启动时全量重置 running 任务/Agent：多个 Gateway 可能共享 data.db，
  // 另一进程的真实任务必须继续存活。故事点互斥由可过期的跨进程租约负责。
  // 等旧 Gateway 的租约 TTL 到期后，只收敛“无有效租约、且过期 worker 启动身份
  // 也不匹配”的残留状态；每分钟重试，避免一次临时 DB 错误造成永久 running。
  const recoverRuntimeStates = async () => {
    try {
      const summary = await reconcileStaleRuntimeStatesAsync();
      if (summary.taskUpdated || summary.agentsCleared) {
        console.log(`[runtime-recovery] 已收敛 ${summary.taskUpdated} 个任务、${summary.agentsCleared} 个 Agent 残留状态`);
      }
      const queuedTabs = schedulePersistedTabQueueDrains();
      if (queuedTabs > 0) {
        console.log(`[runtime-recovery] 已重新调度 ${queuedTabs} 个故事点的持久化消息队列`);
      }
      const sourceInitializations = recoverRemoteStorySourceInitializations();
      if (sourceInitializations > 0) {
        console.log(`[runtime-recovery] 已接管 ${sourceInitializations} 个中断的故事点源码初始化`);
      }
      const localInitializations = recoverLocalStoryWorkspaceInitializations();
      if (localInitializations > 0) {
        console.log(`[runtime-recovery] 已接管 ${localInitializations} 个中断的本地故事点工作区初始化`);
      }
    } catch (error) {
      console.error("[runtime-recovery] 运行态收敛失败:", error.message);
    }
  };
  const initialRuntimeRecovery = setTimeout(recoverRuntimeStates, 16_000);
  initialRuntimeRecovery.unref?.();
  const runtimeRecoveryInterval = setInterval(recoverRuntimeStates, 60_000);
  runtimeRecoveryInterval.unref?.();

  // 日志保留清理：启动清一次 + 每 12h 清（按 config.logRetentionDays，0=不按时间清；另有 20 万条兜底）
  const pruneLogs = () => {
    try {
      const days = parseInt(getConfig().logRetentionDays); // NaN/0 → 不按时间删，仅条数兜底
      const n = pruneOldLogs({ days: Number.isFinite(days) ? days : 14, maxRows: 200000 });
      if (n > 0) console.log(`[cleanup] 已清理 ${n} 条过期日志（保留 ${Number.isFinite(days) ? days : 14} 天）`);
    } catch (e) { console.error("[cleanup] 日志清理失败:", e.message); }
  };
  pruneLogs();
  setInterval(pruneLogs, 12 * 60 * 60 * 1000);

  // 非关键服务延迟初始化，避免阻塞端口就绪（改善启动性能）
  setTimeout(() => {
    const cloudUrl = process.env.CLOUD_URL || "http://192.168.10.156:8080";
    syncSharedConfig(cloudUrl).catch(e => console.error("[config] sync 失败:", e.message));

    // 局域网服务发现（广播算力 / 监听服务端 / 轮询手动 peer）
    try { initLanSync(); } catch (e) { console.error("[lan-sync] 初始化失败:", e.message); }
    try { initDiscovery(); } catch (e) { console.error("[discovery] 初始化失败:", e.message); }

    // 调度/飞书/TB 监控属节点功能：仅 node/standalone 角色启动（纯 server 角色不跑这些）
    if (isNode) {
      initScheduler();
      // 飞书/TB 监控耗时较长，再延迟 2 秒
      setTimeout(() => {
        try { initFeishu(); } catch (e) { console.error("[feishu] 初始化失败:", e.message); }
        try { initTbTaskWatcher(); } catch (e) { console.error("[tb-watcher] 初始化失败:", e.message); }
      }, 2000);
    }
  }, 500);
});
