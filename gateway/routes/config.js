import { Router } from "express";
import { getConfig, updateConfig, mergeApiEnginesUpdate } from "../services/config.js";
import { getKnownNodes } from "../services/discovery.js";
import { cleanNodeNamePart, configuredNodeDisplayName, formatNodeDisplayName } from "../services/node-name.js";
import { spawn } from "child_process";
import { broadcastInstallProgress } from "../services/logger.js";
import { isAdminPrincipal, requestPrincipal } from "../services/admin-auth.js";
import { addAudit } from "../db/sqlite.js";
import { codeupApiBaseError, listCodeupOrganizations, probeCodeupConnection } from "../services/codeup.js";
import { isTrustedPerformanceResourceRequest } from "../services/performance-resource-local-access.js";
import { validateFeishuSourceViewsConfig } from "../../features/FeiShuProjects/src/gateway-sync-service.js";
import { probeApiEngine } from "../services/api-engine.js";
import { applyVolcengineToOpenCode, readOpenCodeVolcengineStatus } from "../services/opencode-config.js";
import {
  applyVolcengineToClaude,
  CLAUDE_VOLCENGINE_ENGINE_ID,
  isClaudeVolcengineReady,
  readClaudeVolcengineStatus,
} from "../services/claude-volcengine.js";
import { ensureArkCliInstalled, probeArkCli, ARKCLI_INSTALL_CMD } from "../services/arkcli.js";
import { refreshCliConcurrency } from "../services/agent-runner.js";
import {
  applyMinimaxToClaude,
  CLAUDE_MINIMAX_ENGINE_ID,
  isClaudeMinimaxReady,
  readClaudeMinimaxStatus,
} from "../services/claude-minimax.js";
import {
  applyMinimaxToCodex,
  CODEX_MINIMAX_ENGINE_ID,
  isCodexMinimaxReady,
  readCodexMinimaxStatus,
} from "../services/codex-minimax.js";
import { hermesExecutable, hermesInstallGuide } from "../services/hermes-cli.js";
import {
  applyAtlasToClient,
  ATLAS_CLAUDE_ENGINE_ID,
  ATLAS_CLIENT_TOOLS,
  ATLAS_CODEX_ENGINE_ID,
  ATLAS_HERMES_ENGINE_ID,
  isAtlasReady,
} from "../services/atlas-client-config.js";

const router = Router();

// 仅管理员（super/admin）可改的配置路径（影响集群身份/共享账号/本机安全暴露）。
// 其余不影响主机身份、机密或跨机信任边界的字段才允许普通用户修改。
const ADMIN_PATHS = [
  "role",
  "workDir",
  "apiAgent",
  "apiEngines",
  "claudeProxy",
  "claudeProxyClient",
  "vehicleConfigCenter",
  "lanSync",
  "executor",
  "distributedExecution",
  "remoteExecutors",
  "servers.nodeOwnerName",
  "servers.nodeName",
  "servers.nodeId",
  "servers.discoverySeeds",
  "servers.peers",
  "servers.selectedHost",
  "servers.advertiseIp",
  "servers.discovery",
  "servers.discoveryPort",
  "servers.distribute",
  "servers.inboundToken",
  "teambition",
  "feishuProjectSync",
];
const getPath = (o, p) => p.split(".").reduce((a, k) => (a == null ? a : a[k]), o);
function hasPath(o, p) { let c = o; for (const k of p.split(".")) { if (c == null || !(k in c)) return false; c = c[k]; } return true; }
function principal(req) { return requestPrincipal(req); }
function effectiveRole(config) {
  return String(process.env.ROLE || config.role || "standalone").toLowerCase();
}
function protectedPaths(config) {
  // Node 角色同样挂载管理员鉴权。允许匿名修改 executor 白名单或清空
  // inbound token 会把低权限 Worker 重新提升成 Gateway confused deputy。
  return ADMIN_PATHS;
}
const clientIp = (req) => String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].replace(/^::ffff:/, "").trim();
function requireAdminConfigWrite(req, res, next) {
  res.set("Cache-Control", "no-store");
  const p = principal(req);
  if (!isAdminPrincipal(p)) {
    return res.status(403).json({ success: false, error: "该操作会修改本机 AI 工具的全局配置，仅管理员可执行。请先登录管理后台。" });
  }
  return next();
}
function normalizeNameKey(value) {
  return cleanNodeNamePart(value).toLocaleLowerCase();
}
function normalizeHost(host) {
  return String(host || "").trim().replace(/\/+$/, "");
}
function isSameLocalNode(info, config) {
  const localId = String(config.servers?.nodeId || "").trim();
  if (localId && String(info?.id || "").trim() === localId) return true;
  const localHost = normalizeHost(config.servers?.selfHost || "");
  return !!localHost && normalizeHost(info?.host) === localHost;
}
function findDisplayNameConflict(displayName, currentConfig) {
  const key = normalizeNameKey(displayName);
  if (!key) return null;
  const servers = getKnownNodes();
  const latestConfig = getConfig();
  const localConfig = { ...currentConfig, servers: { ...(currentConfig.servers || {}), ...(latestConfig.servers || {}) } };
  return servers.find((s) => normalizeNameKey(s.name) === key && !isSameLocalNode(s, localConfig)) || null;
}
// 审计前后值脱敏：token/key/secret 字段不落明文
const SENSITIVE = /token|key|secret|apikey|cookie/i;
function maskDeep(v) {
  if (v && typeof v === "object") { const o = Array.isArray(v) ? [] : {}; for (const k of Object.keys(v)) o[k] = SENSITIVE.test(k) ? (v[k] ? "***" : "") : maskDeep(v[k]); return o; }
  return v;
}
const CREDENTIAL_FIELD = /(?:token|apiKey|secret|password|cookie)$/i;
function maskCredentialsDeep(v) {
  if (!v || typeof v !== "object") return v;
  const out = Array.isArray(v) ? [] : {};
  for (const [key, value] of Object.entries(v)) {
    out[key] = CREDENTIAL_FIELD.test(key)
      ? (value ? "***" : "")
      : maskCredentialsDeep(value);
  }
  return out;
}
// 按 path 脱敏：path 末段本身即敏感（如 servers.inboundToken）时整体打码；否则递归对象 key 脱敏
function maskByPath(path, v) {
  if (SENSITIVE.test(path.split(".").pop())) return v ? "***" : "";
  return maskDeep(v);
}

function codeupEnvironment() {
  const editionValue = String(process.env.CODEUP_EDITION || "").trim().toLowerCase();
  return {
    accessToken: String(process.env.CODEUP_ACCESS_TOKEN || "").trim(),
    organizationId: String(process.env.CODEUP_ORGANIZATION_ID || "").trim(),
    edition: editionValue ? (editionValue === "region" ? "region" : "central") : "",
    apiBaseUrl: String(process.env.CODEUP_API_BASE_URL || "").trim(),
  };
}

function maskClientConfig(config) {
  const safe = JSON.parse(JSON.stringify(config || {}));
  if (safe.dingtalkAppSecret) safe.dingtalkAppSecret = `${safe.dingtalkAppSecret.slice(0, 4)}****`;
  if (safe.dingtalkRobotSecret) safe.dingtalkRobotSecret = `${safe.dingtalkRobotSecret.slice(0, 4)}****`;
  if (safe.teambition && typeof safe.teambition === "object") {
    const userCookieConfigured = Boolean(String(config?.teambition?.userCookie || "").trim());
    delete safe.teambition.projects;
    safe.teambition = maskDeep(safe.teambition);
    if (Object.prototype.hasOwnProperty.call(config?.teambition || {}, "userCookie")) {
      safe.teambition.userCookie = userCookieConfigured ? "***" : "";
    } else {
      delete safe.teambition.userCookie;
    }
    if (config?.teambition?.userCookieUpdatedAt) {
      safe.teambition.userCookieUpdatedAt = config.teambition.userCookieUpdatedAt;
    }
    safe.teambition.userCookieConfigured = userCookieConfigured;
  }
  if (safe.feishuProjectSync && typeof safe.feishuProjectSync === "object") safe.feishuProjectSync = maskDeep(safe.feishuProjectSync);
  for (const key of [
    "claudeProxy",
    "claudeProxyClient",
    "vehicleConfigCenter",
    "executor",
    "remoteExecutors",
    "servers",
  ]) {
    if (safe[key] && typeof safe[key] === "object") safe[key] = maskCredentialsDeep(safe[key]);
  }
  if (safe.codeup && typeof safe.codeup === "object") {
    const env = codeupEnvironment();
    const envTokenConfigured = !!env.accessToken;
    const storedTokenConfigured = !!String(config?.codeup?.accessToken || "").trim();
    safe.codeup = maskDeep(safe.codeup);
    safe.codeup.accessToken = envTokenConfigured || storedTokenConfigured ? "***" : "";
    safe.codeup.accessTokenConfigured = envTokenConfigured || storedTokenConfigured;
    safe.codeup.accessTokenManagedByEnvironment = envTokenConfigured;
    safe.codeup.organizationIdManagedByEnvironment = !!env.organizationId;
    if (safe.codeup.organizationIdManagedByEnvironment) {
      safe.codeup.organizationId = env.organizationId;
    }
    const effectiveEdition = env.edition || (String(safe.codeup.edition || "").toLowerCase() === "region" ? "region" : "central");
    safe.codeup.edition = effectiveEdition;
    safe.codeup.editionManagedByEnvironment = !!env.edition;
    safe.codeup.apiBaseUrlManagedByEnvironment = effectiveEdition === "region" && !!env.apiBaseUrl;
    safe.codeup.apiBaseUrl = effectiveEdition === "central"
      ? "https://openapi-rdc.aliyuncs.com"
      : (env.apiBaseUrl || String(safe.codeup.apiBaseUrl || "").trim());
  }
  for (const engine of Object.values(safe.apiEngines || {})) {
    if (engine?.apiKey) engine.apiKey = "********";
  }
  return safe;
}

const isMasked = (value) => typeof value === "string" && /\*{3,}/.test(value);

// 获取当前配置
function mergeMasked(current, incoming) {
  if (isMasked(incoming)) return current;
  if (Array.isArray(incoming)) return incoming;
  if (incoming && typeof incoming === "object") {
    const out = { ...(current && typeof current === "object" && !Array.isArray(current) ? current : {}) };
    for (const [k, v] of Object.entries(incoming)) out[k] = mergeMasked(out[k], v);
    return out;
  }
  return incoming;
}

router.get("/", (req, res) => {
  res.set("Cache-Control", "no-store");
  const config = getConfig();
  res.json({ success: true, data: maskClientConfig(config) });
});

// 更新配置（即时生效）
router.put("/", (req, res) => {
  res.set("Cache-Control", "no-store");
  const updates = { ...(req.body || {}) };
  const nodeNameEdit = updates._nodeNameEdit === true;
  delete updates._nodeNameEdit;

  // 如果密码字段是 mask 过的（含****），不覆盖
  const current = getConfig();
  if (updates.teambition && typeof updates.teambition === "object") {
    const incomingTb = { ...(updates.teambition || {}) };
    delete incomingTb.projects;
    delete incomingTb.userCookieConfigured;
    updates.teambition = mergeMasked(current.teambition || {}, incomingTb);
  }
  if (updates.feishuProjectSync && typeof updates.feishuProjectSync === "object") {
    const incomingSync = updates.feishuProjectSync || {};
    const incomingFeishu = incomingSync.feishu && typeof incomingSync.feishu === "object" && !Array.isArray(incomingSync.feishu)
      ? incomingSync.feishu
      : null;
    const sourceViewsTouched = !!incomingFeishu
      && (
        Object.prototype.hasOwnProperty.call(incomingFeishu, "sourceViews")
        || Object.prototype.hasOwnProperty.call(incomingFeishu, "sourceView")
      );
    const legacySourceViewUpdate = !!incomingFeishu
      && Object.prototype.hasOwnProperty.call(incomingFeishu, "sourceView")
      && !Object.prototype.hasOwnProperty.call(incomingFeishu, "sourceViews");
    updates.feishuProjectSync = mergeMasked(current.feishuProjectSync || {}, incomingSync);
    if (legacySourceViewUpdate) {
      const sourceView = updates.feishuProjectSync.feishu?.sourceView;
      updates.feishuProjectSync.feishu = {
        ...(updates.feishuProjectSync.feishu || {}),
        sourceViews: sourceView && typeof sourceView === "object" && !Array.isArray(sourceView)
          ? [{ ...sourceView, enabled: sourceView.enabled !== false, isDefault: true }]
          : [],
      };
    }
    if (sourceViewsTouched) {
      const sourceValidation = validateFeishuSourceViewsConfig(updates.feishuProjectSync);
      if (!sourceValidation.ok) {
        const duplicate = sourceValidation.errors.some((error) => ["duplicate", "duplicate-id"].includes(error.code));
        return res.status(duplicate ? 409 : 400).json({
          success: false,
          error: sourceValidation.errors.map((error) => error.message).join("；") || "飞书工单来源配置无效",
          data: sourceValidation,
        });
      }
    }
  }
  if (updates.codeup && typeof updates.codeup === "object") {
    const incomingCodeup = { ...(updates.codeup || {}) };
    delete incomingCodeup.accessTokenConfigured;
    delete incomingCodeup.accessTokenManagedByEnvironment;
    delete incomingCodeup.organizationIdManagedByEnvironment;
    delete incomingCodeup.editionManagedByEnvironment;
    delete incomingCodeup.apiBaseUrlManagedByEnvironment;
    const env = codeupEnvironment();
    if (env.accessToken) delete incomingCodeup.accessToken;
    if (env.organizationId) delete incomingCodeup.organizationId;
    if (env.edition) delete incomingCodeup.edition;
    if (env.apiBaseUrl) delete incomingCodeup.apiBaseUrl;
    updates.codeup = mergeMasked(current.codeup || {}, incomingCodeup);
    const codeupChanged = JSON.stringify(updates.codeup) !== JSON.stringify(current.codeup || {});
    if (codeupChanged && !isTrustedPerformanceResourceRequest(req)) {
      return res.status(403).json({ success: false, error: "Codeup 个人令牌配置仅允许从本机可信页面修改" });
    }
  }
  if (updates.dingtalkAppSecret?.includes("****")) {
    updates.dingtalkAppSecret = current.dingtalkAppSecret;
  }
  if (updates.dingtalkRobotSecret?.includes("****")) {
    updates.dingtalkRobotSecret = current.dingtalkRobotSecret;
  }
  if (updates.apiEngines) {
    const merged = mergeApiEnginesUpdate(current.apiEngines || {}, updates.apiEngines, { isMaskedKey: isMasked });
    if (merged.error) {
      return res.status(400).json({ success: false, error: merged.error });
    }
    updates.apiEngines = merged.engines;
  }

  // 字段级管理员校验：仅当请求携带且改动了管理员字段时才要求管理员。
  for (const key of ["claudeProxy", "claudeProxyClient", "vehicleConfigCenter", "executor", "servers", "lanSync"]) {
    if (updates[key] && typeof updates[key] === "object") {
      updates[key] = mergeMasked(current[key] || {}, updates[key]);
    }
  }
  if (Array.isArray(updates.remoteExecutors)) {
    updates.remoteExecutors = updates.remoteExecutors.map((entry, index) => {
      const existing = (current.remoteExecutors || []).find((candidate) => (
        (entry?.id && candidate?.id === entry.id)
        || (entry?.name && candidate?.name === entry.name)
        || (entry?.host && candidate?.host === entry.host)
      )) || current.remoteExecutors?.[index] || {};
      return mergeMasked(existing, entry);
    });
  }

  const touched = protectedPaths(current).filter((p) => hasPath(updates, p) && JSON.stringify(getPath(updates, p)) !== JSON.stringify(getPath(current, p)));
  const p = principal(req);
  if ((touched.length || nodeNameEdit) && !isAdminPrincipal(p)) {
    const names = touched.length ? touched.join("、") : "servers.nodeName";
    return res.status(403).json({ success: false, error: `以下设置仅管理员可修改：${names}。请先登录管理后台。` });
  }

  if (updates.servers && typeof updates.servers === "object") {
    const nextServers = { ...(updates.servers || {}) };
    const nodeNameChanged = hasPath(updates, "servers.nodeName")
      && JSON.stringify(getPath(updates, "servers.nodeName")) !== JSON.stringify(getPath(current, "servers.nodeName"));
    const shouldBindOwner = nodeNameEdit || nodeNameChanged;
    const currentOwner = cleanNodeNamePart(current.servers?.nodeOwnerName);
    const loginOwner = cleanNodeNamePart(p?.name);
    const ownerName = shouldBindOwner ? (loginOwner || currentOwner) : currentOwner;
    nextServers.nodeOwnerName = ownerName;

    const shouldCheckDisplayName = nodeNameEdit || nodeNameChanged || hasPath(updates, "servers.nodeOwnerName");
    if (shouldCheckDisplayName) {
      const proposedName = formatNodeDisplayName(ownerName, nextServers.nodeName);
      const currentName = configuredNodeDisplayName(current);
      if (normalizeNameKey(proposedName) !== normalizeNameKey(currentName)) {
        const conflict = findDisplayNameConflict(proposedName, current);
        if (conflict) {
          return res.status(409).json({
            success: false,
            error: `节点名称「${proposedName}」已被局域网设备 ${conflict.host || conflict.name || ""} 使用，请换一个节点名称`,
            data: { conflict: { id: conflict.id || "", name: conflict.name || "", host: conflict.host || "" } },
          });
        }
      }
    }

    const latest = getConfig();
    if (!hasPath(updates, "servers.nodeId") && latest.servers?.nodeId) nextServers.nodeId = latest.servers.nodeId;
    updates.servers = nextServers;
  }

  const newConfig = updateConfig(updates);
  if (Object.prototype.hasOwnProperty.call(updates, "maxCliConcurrency")) {
    refreshCliConcurrency();
  }
  console.log("[config] 配置已更新并即时生效");

  // 管理员改动写审计（前后值脱敏 + 经 gossip 同步到其它服务端）
  for (const path of touched) {
    try {
      addAudit({
        id: `cfg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, ts: Date.now(), ip: clientIp(req),
        actor: p?.name || "?", role: p?.role || "", action: "配置.修改", target: `config:${path}`,
        before: maskByPath(path, getPath(current, path)), after: maskByPath(path, getPath(updates, path)), node: current.servers?.nodeId || "",
      });
    } catch {}
  }

  res.set("Cache-Control", "no-store");
  res.json({ success: true, data: maskClientConfig(newConfig) });
});

function codeupRequestConfig(body = {}) {
  const stored = getConfig().codeup || {};
  const env = codeupEnvironment();
  const incomingToken = String(body.accessToken || "").trim();
  const explicitToken = incomingToken && !isMasked(incomingToken) ? incomingToken : "";
  const edition = String(env.edition || body.edition || stored.edition || "central").trim().toLowerCase() === "region"
    ? "region"
    : "central";
  return {
    ...stored,
    apiBaseUrl: edition === "central"
      ? "https://openapi-rdc.aliyuncs.com"
      : String(env.apiBaseUrl || body.apiBaseUrl || stored.apiBaseUrl || "").trim(),
    edition,
    organizationId: String(env.organizationId || body.organizationId || stored.organizationId || "").trim(),
    accessToken: String(env.accessToken || explicitToken || stored.accessToken || "").trim(),
  };
}

function safeCodeupError(error, accessToken) {
  let value = String(error || "Codeup 请求失败");
  const token = String(accessToken || "").trim();
  if (token) value = value.split(token).join("***");
  return value.replace(/pt-[A-Za-z0-9_-]+/g, "pt-***").slice(0, 500);
}

function codeupErrorStatus(result) {
  if (["missing_config", "missing_token", "region_no_organization", "invalid_api_base"].includes(result?.reason)) return 400;
  const status = Number(result?.status || 0);
  return status >= 400 && status < 500 ? status : 502;
}

function requireLocalCodeupAccess(req, res, next) {
  res.set("Cache-Control", "no-store");
  if (!isTrustedPerformanceResourceRequest(req)) {
    return res.status(403).json({ success: false, error: "Codeup 个人令牌接口仅允许从本机可信页面访问" });
  }
  return next();
}

router.put("/codeup", requireLocalCodeupAccess, (req, res) => {
  res.set("Cache-Control", "no-store");
  const current = getConfig();
  const incoming = { ...((req.body?.codeup && typeof req.body.codeup === "object") ? req.body.codeup : (req.body || {})) };
  delete incoming.accessTokenConfigured;
  delete incoming.accessTokenManagedByEnvironment;
  delete incoming.organizationIdManagedByEnvironment;
  delete incoming.editionManagedByEnvironment;
  delete incoming.apiBaseUrlManagedByEnvironment;
  const env = codeupEnvironment();
  if (env.accessToken) delete incoming.accessToken;
  if (env.organizationId) delete incoming.organizationId;
  if (env.edition) delete incoming.edition;
  if (env.apiBaseUrl) delete incoming.apiBaseUrl;

  const nextCodeup = mergeMasked(current.codeup || {}, incoming);
  const storedEdition = String(nextCodeup.edition || "central").toLowerCase() === "region" ? "region" : "central";
  const effectiveEdition = env.edition || storedEdition;
  nextCodeup.edition = storedEdition;
  nextCodeup.apiBaseUrl = effectiveEdition === "central"
    ? "https://openapi-rdc.aliyuncs.com"
    : String(nextCodeup.apiBaseUrl || "").trim().replace(/\/+$/, "");
  const apiBaseError = codeupApiBaseError({
    ...nextCodeup,
    edition: effectiveEdition,
    apiBaseUrl: effectiveEdition === "central" ? "https://openapi-rdc.aliyuncs.com" : (env.apiBaseUrl || nextCodeup.apiBaseUrl),
  });
  if (apiBaseError) return res.status(400).json({ success: false, reason: "invalid_api_base", error: apiBaseError });

  const newConfig = updateConfig({ codeup: nextCodeup });
  return res.json({ success: true, data: { codeup: maskClientConfig(newConfig).codeup } });
});

router.post("/codeup/organizations", requireLocalCodeupAccess, async (req, res) => {
  res.set("Cache-Control", "no-store");
  const config = codeupRequestConfig(req.body || {});
  const result = await listCodeupOrganizations(config);
  if (!result.ok) {
    return res.status(codeupErrorStatus(result)).json({
      success: false,
      reason: result.reason || "request_failed",
      error: safeCodeupError(result.error, config.accessToken),
    });
  }
  return res.json({ success: true, data: { organizations: result.organizations || [] } });
});

router.post("/codeup/check", requireLocalCodeupAccess, async (req, res) => {
  res.set("Cache-Control", "no-store");
  const config = codeupRequestConfig(req.body || {});
  const result = await probeCodeupConnection(config);
  if (!result.ok) {
    return res.status(codeupErrorStatus(result)).json({
      success: false,
      reason: result.reason || "request_failed",
      missing: result.missing || [],
      error: safeCodeupError(result.error, config.accessToken),
    });
  }
  return res.json({
    success: true,
    data: {
      edition: result.edition,
      organizationId: result.organizationId,
      repositoryVisible: result.repositoryVisible,
      repository: result.repository,
    },
  });
});

// 检测引擎可用性
router.get("/check-engine/:engine", async (req, res) => {
  const engine = req.params.engine;

  try {
    const atlasClient = {
      [ATLAS_CLAUDE_ENGINE_ID]: "claude",
      [ATLAS_CODEX_ENGINE_ID]: "codex",
      [ATLAS_HERMES_ENGINE_ID]: "hermes",
    }[engine];
    if (atlasClient) {
      const ready = isAtlasReady();
      const base = await checkEngineAvailability(atlasClient);
      const installed = base.status === "available" || base.status === "need_login";
      const available = !!(ready && installed);
      return res.json({
        success: true,
        data: {
          ...base,
          available,
          status: !ready ? "missing_key" : (!installed ? "not_installed" : "available"),
          error: !ready ? "请先在设置页启用 Atlas Coding Plan 并填写 API Key" : (installed ? null : base.error),
          type: "cli",
          provider: "atlas",
        },
      });
    }
    const apiCfg = getConfig().apiEngines?.[engine];
    if (apiCfg) {
      if (!apiCfg.enabled) {
        return res.json({ success: true, data: { available: false, status: "disabled", error: "未启用", type: "api" } });
      }
      if (!apiCfg.apiKey) {
        return res.json({ success: true, data: { available: false, status: "missing_key", error: "未配置 API Key", type: "api" } });
      }
      const probe = await probeApiEngine(engine);
      return res.json({ success: true, data: { ...probe, type: "api" } });
    }
    const result = await checkEngineAvailability(engine);
    res.json({ success: true, data: result });
  } catch (err) {
    res.json({
      success: true,
      data: { available: false, status: "error", error: err.message },
    });
  }
});

// 探测 API 引擎连通性（可带未保存的覆盖字段）
router.post("/api-engines/:id/test", async (req, res) => {
  const id = String(req.params.id || "").trim();
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const overrides = {};
    for (const key of ["apiKey", "baseUrl", "model", "name"]) {
      if (body[key] != null && String(body[key]).trim() && !isMasked(body[key])) {
        overrides[key] = String(body[key]).trim();
      }
    }
    const probe = await probeApiEngine(id, overrides);
    res.json({ success: probe.ok, data: probe, error: probe.ok ? undefined : probe.error });
  } catch (err) {
    res.json({ success: false, error: err.message, data: { ok: false, available: false, status: "error", error: err.message, engineId: id } });
  }
});

// Atlas Coding Plan：安全合并到指定 AI 工具的用户级全局配置。
// API Key 可使用请求中的未脱敏值；掩码或缺省时读取服务端已保存的真实值。
router.post("/atlas/apply/:tool", requireAdminConfigWrite, async (req, res) => {
  const tool = String(req.params.tool || "").trim().toLowerCase();
  res.set("Cache-Control", "no-store");
  if (!ATLAS_CLIENT_TOOLS.has(tool)) {
    return res.status(400).json({ success: false, error: `不支持设置到 ${tool || "未知工具"}` });
  }
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const overrides = {};
    if (body.baseUrl != null && String(body.baseUrl).trim()) overrides.baseUrl = String(body.baseUrl).trim();
    if (body.model != null && String(body.model).trim()) overrides.model = String(body.model).trim();
    if (body.apiKey != null && String(body.apiKey).trim() && !isMasked(body.apiKey)) {
      overrides.apiKey = String(body.apiKey).trim();
    }
    const result = await applyAtlasToClient(tool, overrides);
    if (!result.ok) {
      const status = result.code === "HERMES_NOT_INSTALLED" ? 409 : 400;
      return res.status(status).json({ success: false, data: result, error: result.error });
    }
    const p = principal(req);
    try {
      addAudit({
        id: `atlas-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        ts: Date.now(),
        ip: clientIp(req),
        actor: p?.name || "?",
        role: p?.role || "",
        action: "AI模型.设置全局客户端",
        target: `atlas:${tool}`,
        before: null,
        after: { tool, model: result.model || "", backupCount: result.backups?.length || 0 },
        node: getConfig().servers?.nodeId || "",
      });
    } catch {}
    return res.json({ success: true, data: result });
  } catch (err) {
    return res.status(500).json({ success: false, error: err?.message || String(err) });
  }
});

// 读取本机 OpenCode 是否已配方舟 / 当前默认 model
router.get("/opencode/volcengine", (_req, res) => {
  try {
    const data = readOpenCodeVolcengineStatus();
    res.json({ success: !!data.ok, data, error: data.ok ? undefined : data.error });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// 一键把设置页「火山方舟」写入 ~/.config/opencode/opencode.json，并设为默认 model
router.post("/opencode/apply-volcengine", (req, res) => {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const overrides = {};
    if (body.baseUrl != null && String(body.baseUrl).trim()) overrides.baseUrl = String(body.baseUrl).trim();
    if (body.model != null && String(body.model).trim()) overrides.model = String(body.model).trim();
    // API Key：仅接受未脱敏明文；脱敏则走服务端已保存的真实 Key
    if (body.apiKey != null && String(body.apiKey).trim() && !isMasked(body.apiKey)) {
      overrides.apiKey = String(body.apiKey).trim();
    }
    const result = applyVolcengineToOpenCode(overrides);
    res.json({
      success: !!result.ok,
      data: result,
      error: result.ok ? undefined : result.error,
    });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Claude × 方舟：隔离配置目录状态
router.get("/claude/volcengine", async (_req, res) => {
  try {
    const data = readClaudeVolcengineStatus();
    const arkcli = await probeArkCli();
    res.json({ success: true, data: { ...data, arkcli } });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// 安装 Ark CLI（文档中的 arkcli helper / +connect 依赖此命令）
router.post("/arkcli/install", async (_req, res) => {
  try {
    const result = await ensureArkCliInstalled({ force: true });
    res.json({
      success: !!result.ok,
      data: result,
      error: result.ok ? undefined : (result.error || "安装 arkcli 失败"),
    });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

router.get("/arkcli", async (_req, res) => {
  try {
    const data = await probeArkCli();
    res.json({ success: true, data: { ...data, installCmd: ARKCLI_INSTALL_CMD } });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// 一键配置 Claude×方舟：默认 ~/.claude（终端 claude）+ ~/.claude-volcengine + 备份 ~/.claude-official
// 默认同时 ensure 安装 arkcli，避免文档步骤 `arkcli helper` 在 Windows 上报「找不到命令」
router.post("/claude/apply-volcengine", async (req, res) => {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const overrides = {};
    if (body.baseUrl != null && String(body.baseUrl).trim()) overrides.baseUrl = String(body.baseUrl).trim();
    if (body.model != null && String(body.model).trim()) overrides.model = String(body.model).trim();
    if (body.apiKey != null && String(body.apiKey).trim() && !isMasked(body.apiKey)) {
      overrides.apiKey = String(body.apiKey).trim();
    }
    const installArkCli = body.installArkCli !== false;
    let arkcli = null;
    if (installArkCli) {
      arkcli = await ensureArkCliInstalled({ force: false });
    } else {
      arkcli = await probeArkCli();
    }
    const result = applyVolcengineToClaude(overrides);
    const ok = !!result.ok;
    const arkHint = arkcli?.installed
      ? `本机已安装 arkcli${arkcli.version ? ` ${arkcli.version}` : ""}，可用 arkcli helper / arkcli +connect。`
      : `警告：arkcli 未就绪（${arkcli?.error || "未知"}）。请点「安装 Ark CLI」或手动执行：${ARKCLI_INSTALL_CMD}`;
    res.json({
      success: ok,
      data: {
        ...result,
        arkcli,
        hint: ok ? `${result.hint || ""} ${arkHint}`.trim() : result.error,
      },
      error: ok ? undefined : result.error,
    });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Claude × MiniMax：隔离配置目录状态
router.get("/claude/minimax", (_req, res) => {
  try {
    const data = readClaudeMinimaxStatus();
    res.json({ success: true, data });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// 一键配置 Claude×MiniMax：默认 ~/.claude（终端 claude）+ ~/.claude-minimax + 备份 ~/.claude-official
router.post("/claude/apply-minimax", (req, res) => {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const overrides = {};
    if (body.baseUrl != null && String(body.baseUrl).trim()) overrides.anthropicBaseUrl = String(body.baseUrl).trim();
    if (body.model != null && String(body.model).trim()) overrides.model = String(body.model).trim();
    if (body.apiKey != null && String(body.apiKey).trim() && !isMasked(body.apiKey)) {
      overrides.apiKey = String(body.apiKey).trim();
    }
    const result = applyMinimaxToClaude(overrides);
    res.json({
      success: !!result.ok,
      data: result,
      error: result.ok ? undefined : result.error,
    });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Codex × MiniMax：隔离配置目录状态
router.get("/codex/minimax", (_req, res) => {
  try {
    const data = readCodexMinimaxStatus();
    res.json({ success: true, data });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// 一键配置 Codex×MiniMax：默认 ~/.codex（终端 codex）+ ~/.codex-minimax + 备份 ~/.codex-official
router.post("/codex/apply-minimax", (req, res) => {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const overrides = {};
    if (body.baseUrl != null && String(body.baseUrl).trim()) overrides.baseUrl = String(body.baseUrl).trim();
    if (body.model != null && String(body.model).trim()) overrides.model = String(body.model).trim();
    if (body.apiKey != null && String(body.apiKey).trim() && !isMasked(body.apiKey)) {
      overrides.apiKey = String(body.apiKey).trim();
    }
    const result = applyMinimaxToCodex(overrides);
    res.json({
      success: !!result.ok,
      data: result,
      error: result.ok ? undefined : result.error,
    });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// 获取所有引擎状态
router.get("/engine-status", async (req, res) => {
  try {
    const [claude, gemini, codex, hermes] = await Promise.allSettled([
      checkEngineAvailability("claude"),
      checkEngineAvailability("gemini"),
      checkEngineAvailability("codex"),
      checkEngineAvailability("hermes"),
    ]);
    const extract = (r) => r.status === "fulfilled" ? r.value : { available: false, status: "error", error: r.reason?.message };
    const apiStatuses = {};
    const apiEngines = getConfig().apiEngines || {};
    for (const [id, cfg] of Object.entries(apiEngines)) {
      apiStatuses[id] = {
        type: "api",
        name: cfg.name || id,
        model: cfg.model || "",
        available: !!(cfg.enabled && cfg.apiKey),
        status: !cfg.enabled ? "disabled" : (cfg.apiKey ? "available" : "missing_key"),
        error: !cfg.enabled ? "未启用" : (cfg.apiKey ? null : "未配置 API Key"),
        custom: !!cfg.custom && !cfg.builtin,
        docsUrl: cfg.docsUrl || "",
      };
    }
    res.json({
      success: true,
      data: {
        claude: { ...extract(claude), name: "Claude（官方）", type: "cli" },
        [CLAUDE_VOLCENGINE_ENGINE_ID]: (() => {
          const ready = isClaudeVolcengineReady();
          const base = extract(claude);
          // 方舟 Claude 用 API Key，不依赖官方 claude login；仅要求本机已安装 claude CLI
          const installed = base.status === "available" || base.status === "need_login";
          const available = !!(ready && installed);
          return {
            type: "cli",
            name: "Claude（火山方舟）",
            available,
            status: !ready ? "missing_key" : (!installed ? "not_installed" : "available"),
            error: !ready
              ? "请先在设置页启用火山方舟并填写 API Key"
              : (!installed ? (base.error || "未安装 Claude Code CLI") : null),
            provider: "volcengine",
            installGuide: base.installGuide,
          };
        })(),
        [CLAUDE_MINIMAX_ENGINE_ID]: (() => {
          const ready = isClaudeMinimaxReady();
          const base = extract(claude);
          // MiniMax Claude 用 API Key，不依赖官方 claude login；仅要求本机已安装 claude CLI
          const installed = base.status === "available" || base.status === "need_login";
          const available = !!(ready && installed);
          return {
            type: "cli",
            name: "Claude（MiniMax）",
            available,
            status: !ready ? "missing_key" : (!installed ? "not_installed" : "available"),
            error: !ready
              ? "请先在设置页启用 MiniMax 并填写 API Key"
              : (!installed ? (base.error || "未安装 Claude Code CLI") : null),
            provider: "minimax",
            installGuide: base.installGuide,
          };
        })(),
        [CODEX_MINIMAX_ENGINE_ID]: (() => {
          const ready = isCodexMinimaxReady();
          const base = extract(codex);
          // MiniMax Codex 用 API Key，不依赖官方 codex login；仅要求本机已安装 codex CLI
          const installed = base.status === "available" || base.status === "need_login";
          const available = !!(ready && installed);
          return {
            type: "cli",
            name: "Codex（MiniMax）",
            available,
            status: !ready ? "missing_key" : (!installed ? "not_installed" : "available"),
            error: !ready
              ? "请先在设置页启用 MiniMax 并填写 API Key"
              : (!installed ? (base.error || "未安装 Codex CLI") : null),
            provider: "minimax",
            installGuide: base.installGuide,
          };
        })(),
        [ATLAS_CLAUDE_ENGINE_ID]: (() => {
          const ready = isAtlasReady();
          const base = extract(claude);
          const installed = base.status === "available" || base.status === "need_login";
          return {
            type: "cli",
            name: "Claude Code（Atlas Coding Plan）",
            available: !!(ready && installed),
            status: !ready ? "missing_key" : (!installed ? "not_installed" : "available"),
            error: !ready ? "请先在设置页启用 Atlas Coding Plan 并填写 API Key" : (!installed ? base.error : null),
            provider: "atlas",
            installGuide: base.installGuide,
          };
        })(),
        [ATLAS_CODEX_ENGINE_ID]: (() => {
          const ready = isAtlasReady();
          const base = extract(codex);
          const installed = base.status === "available" || base.status === "need_login";
          return {
            type: "cli",
            name: "Codex CLI（Atlas Coding Plan）",
            available: !!(ready && installed),
            status: !ready ? "missing_key" : (!installed ? "not_installed" : "available"),
            error: !ready ? "请先在设置页启用 Atlas Coding Plan 并填写 API Key" : (!installed ? base.error : null),
            provider: "atlas",
            installGuide: base.installGuide,
          };
        })(),
        [ATLAS_HERMES_ENGINE_ID]: (() => {
          const ready = isAtlasReady();
          const base = extract(hermes);
          const installed = base.status !== "not_installed";
          return {
            type: "cli",
            name: "Hermes（Atlas Coding Plan）",
            available: !!(ready && installed),
            status: !ready ? "missing_key" : (!installed ? "not_installed" : "available"),
            error: !ready ? "请先在设置页启用 Atlas Coding Plan 并填写 API Key" : (!installed ? base.error : null),
            provider: "atlas",
            installGuide: base.installGuide,
          };
        })(),
        gemini: extract(gemini),
        codex: extract(codex),
        hermes: { ...extract(hermes), name: "Hermes Agent", type: "cli" },
        ...apiStatuses,
      },
    });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// 自动安装引擎
router.post("/install-engine/:engine", async (req, res) => {
  const engine = req.params.engine;
  const packages = {
    claude: "@anthropic-ai/claude-code",
    codex: "@openai/codex",
    gemini: "@google/gemini-cli",
    arkcli: "@volcengine/ark-cli",
  };
  const pkg = packages[engine];
  if (!pkg) return res.status(400).json({ success: false, error: `不支持自动安装: ${engine}` });

  broadcastInstallProgress({ engine, output: `开始安装 ${pkg}...\n`, done: false, success: false });

  const proc = spawn("npm", ["install", "-g", pkg], { shell: true, windowsHide: true });
  let output = "";

  proc.stdout.on("data", (d) => {
    const text = d.toString();
    output += text;
    broadcastInstallProgress({ engine, output: text, done: false, success: false });
  });

  proc.stderr.on("data", (d) => {
    const text = d.toString();
    output += text;
    broadcastInstallProgress({ engine, output: text, done: false, success: false });
  });

  proc.on("close", (code) => {
    const success = code === 0;
    broadcastInstallProgress({ engine, output: success ? "\n安装完成!" : "\n安装失败", done: true, success });
    res.json({ success, output });
  });

  proc.on("error", (err) => {
    broadcastInstallProgress({ engine, output: `\n安装错误: ${err.message}`, done: true, success: false });
    res.json({ success: false, output: err.message });
  });
});

/**
 * 检测引擎是否已安装并已登录
 * 返回: { available, status, error, installGuide?, loginGuide? }
 * status: "available" | "not_installed" | "need_login" | "error"
 */
function checkEngineAvailability(engine) {
  return new Promise((resolve, reject) => {
    let command, args;

    if (engine === "claude") {
      command = "claude";
      args = ["-p", "--output-format", "text", "--dangerously-skip-permissions"];
    } else if (engine === "gemini") {
      command = "gemini";
      args = ["--version"];
    } else if (engine === "codex") {
      command = "codex";
      args = ["login", "status"];
    } else if (engine === "hermes") {
      // 不发起模型请求，避免状态页每次打开都产生费用；config check 会验证
      // 本地安装与配置文件结构，真实 provider 凭据仍由首个任务调用兜底验证。
      command = hermesExecutable();
      args = ["config", "check"];
    } else {
      return reject(new Error(`未知引擎: ${engine}`));
    }

    const proc = spawn(command, args, { shell: true, windowsHide: true, timeout: 30000 });
    let stdout = "";
    let stderr = "";

    // Claude 需要通过 stdin 传入 prompt
    if (engine === "claude") {
      proc.stdin.write("reply with just: ok");
      proc.stdin.end();
    }

    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));

    proc.on("error", (err) => {
      const guides = {
        claude: { command: "npm install -g @anthropic-ai/claude-code", url: "https://docs.anthropic.com/en/docs/claude-code/overview" },
        gemini: { command: "npm install -g @google/gemini-cli", url: "https://github.com/google-gemini/gemini-cli" },
        codex: { command: "npm install -g @openai/codex", url: "https://github.com/openai/codex" },
        hermes: hermesInstallGuide(),
      };
      const installGuide = guides[engine] || guides.claude;

      resolve({
        available: false,
        status: "not_installed",
        error: `未安装: ${err.message}`,
        installGuide,
      });
    });

    proc.on("close", (code) => {
      const output = (stdout + stderr).toLowerCase();
      const needLogin =
        /login|auth|unauthorized|sign in|not logged|authenticate|token expired/i.test(output);

      if (code === 0) {
        resolve({ available: true, status: "available" });
      } else if (needLogin) {
        const loginGuides = {
          claude: { steps: ["打开终端", "运行: claude login", "按提示完成浏览器授权", "返回重新检测"], command: "claude login" },
          gemini: { steps: ["打开终端", "运行: gemini", "按提示完成 Google 账号授权", "返回重新检测"], command: "gemini" },
          codex: { steps: ["打开终端", "运行: codex login", "按提示完成 OpenAI 账号授权", "返回重新检测"], command: "codex login" },
          hermes: { steps: ["打开终端", "运行: hermes setup", "配置本地 Hermes 的 provider 与模型", "返回重新检测"], command: "hermes setup" },
        };
        const loginGuide = loginGuides[engine] || loginGuides.claude;

        resolve({
          available: false,
          status: "need_login",
          needLogin: true,
          error: "需要登录",
          loginGuide,
        });
      } else {
        resolve({
          available: false,
          status: "error",
          error: `退出码 ${code}: ${(stderr || stdout).slice(0, 200)}`,
        });
      }
    });
  });
}

export default router;
