/**
 * 远端执行器路由 - /api/executor/*
 * 供中心大脑驱动：在本机工程内执行工具（read/write/edit/list/bash），返回结果。
 * 鉴权 executor.token；root 白名单在 services/executor.js 内校验。
 */
import fs from "fs";
import os from "os";
import path from "path";
import { Router } from "express";
import { getConfig, updateConfig } from "../services/config.js";
import { runTool, allowedRoots } from "../services/executor.js";
import { configuredNodeDisplayName } from "../services/node-name.js";
import * as store from "../services/devbench/store.js";
import { addAudit } from "../db/sqlite.js";
import { isAdminPrincipal, requestPrincipal } from "../services/admin-auth.js";

const router = Router();

function checkAuth(req) {
  const root = getConfig();
  const cfg = root.executor || {};
  if (!cfg.enabled) return { ok: false, code: 403, error: "本机执行器未启用（设置→远端执行器）" };
  // 统一入站口令：servers.inboundToken（代理+执行器共用）优先，兼容旧 executor.token
  const expected = String(root.servers?.inboundToken || cfg.token || "").trim();
  if (expected) {
    const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    if (token !== expected) return { ok: false, code: 401, error: "token 无效" };
  }
  return { ok: true };
}

function effectiveRole() {
  const cfg = getConfig();
  return String(process.env.ROLE || cfg.role || "standalone").toLowerCase();
}

function isAdminRequest(req) {
  return isAdminPrincipal(requestPrincipal(req));
}

function normalizeRootInput(root) {
  const raw = String(root || "").trim().replace(/^["']|["']$/g, "");
  if (!raw) throw new Error("请先输入执行目录");
  if (!path.isAbsolute(raw)) throw new Error("执行目录必须是绝对路径");
  const abs = path.resolve(raw);
  const parsed = path.parse(abs);
  if (abs === parsed.root) throw new Error("不能把磁盘根目录加入执行器白名单");
  return abs;
}

function suggestedRootFromEnv() {
  const raw = String(process.env.AIEFFICIENCY_EXECUTOR_TEST_ROOT || "").trim();
  return raw && path.isAbsolute(raw) ? path.resolve(raw) : "";
}

function suggestedRootFromCloneParent() {
  try {
    const raw = String(store.getRemoteConfig?.().cloneParent || "").trim();
    return raw && path.isAbsolute(raw) ? path.resolve(raw) : "";
  } catch {
    return "";
  }
}

function suggestedRootFromWorkDir() {
  const raw = String(getConfig().workDir || "").trim();
  return raw && path.isAbsolute(raw) ? path.join(path.resolve(raw), ".aiefficiency-executor-test") : "";
}

function suggestedRootFromGatewayCwd() {
  const cwd = path.resolve(process.cwd());
  const root = path.basename(cwd).toLowerCase() === "gateway" ? path.dirname(cwd) : cwd;
  const parent = path.dirname(root);
  const name = path.basename(root) || "AIEfficiency";
  if (!parent || parent === root) return "";
  return path.join(parent, `${name}-executor-test`);
}

function suggestExecutorRoot() {
  const choices = [
    ["cloneParent", suggestedRootFromCloneParent()],
    ["env", suggestedRootFromEnv()],
    ["workDir", suggestedRootFromWorkDir()],
    ["gateway", suggestedRootFromGatewayCwd()],
    ["home", path.join(os.homedir(), ".aiefficiency", "executor-test")],
  ];
  const picked = choices.find(([, root]) => root);
  const cfg = getConfig();
  return {
    root: path.resolve(picked[1]),
    source: picked[0],
    cloneParent: suggestedRootFromCloneParent(),
    nodeId: String(cfg.servers?.nodeId || ""),
    nodeName: configuredNodeDisplayName(cfg),
    role: effectiveRole(),
  };
}

function addConfiguredRoot(abs) {
  const cfg = getConfig();
  const current = Array.isArray(cfg.executor?.allowedRoots) ? cfg.executor.allowedRoots : [];
  const exists = current.some((r) => path.resolve(String(r || "")).toLowerCase() === abs.toLowerCase());
  const allowedRoots = exists ? current : [...current, abs];
  const next = updateConfig({
    executor: { ...(cfg.executor || {}), enabled: true, allowedRoots },
  });
  return next.executor || {};
}

function clientIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].replace(/^::ffff:/, "").trim();
}
function clipAuditText(value, max = 600) {
  const text = String(value ?? "");
  return text.length <= max ? text : `${text.slice(0, max)}...(已截断 ${text.length - max} 字符)`;
}
function compactArgs(args = {}) {
  const out = { ...(args || {}) };
  for (const key of ["content", "old_string", "new_string", "patch"]) {
    if (out[key] != null) out[key] = `[${String(out[key]).length} chars] ${clipAuditText(out[key], 180)}`;
  }
  if (out.command) out.command = clipAuditText(out.command, 300);
  return out;
}
function auditRunTool(req, root, name, args, result) {
  const cfg = getConfig();
  if ((cfg.distributedExecution || {}).audit === false) return;
  try {
    addAudit({
      id: `exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ts: Date.now(),
      ip: clientIp(req),
      actor: String(req.body?.clientId || "remote-executor"),
      role: "system",
      action: "执行器.动作",
      target: `session:${req.body?.sessionId || ""} ${name}`,
      before: { root, name, round: req.body?.round || null, args: compactArgs(args) },
      after: { ok: result?.ok !== false, error: result?.error || null, result: clipAuditText(result?.result || "", 1200) },
      node: cfg.servers?.nodeId || "",
    });
  } catch {}
}

// 设置页辅助：返回当前网关机器上的默认执行目录。前端不能写死自己的绝对路径。
router.get("/suggested-root", (req, res) => {
  res.json({ ok: true, data: suggestExecutorRoot() });
});

// 设置页辅助：创建执行目录、加入白名单并启用执行器。
// 纯客户端 node 没有管理后台，可直接维护本机执行器；standalone 仍要求管理员 token。
router.post("/prepare-root", (req, res) => {
  if (effectiveRole() !== "node" && !isAdminRequest(req)) {
    return res.status(403).json({ ok: false, error: "仅管理员或纯客户端本机可准备执行目录" });
  }
  try {
    const root = normalizeRootInput(req.body?.root || suggestExecutorRoot().root);
    fs.mkdirSync(root, { recursive: true });
    const executor = addConfiguredRoot(root);
    res.json({ ok: true, data: { root, executor } });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message || "准备执行目录失败" });
  }
});

// 健康/能力：是否启用 + 本机可操作的工程根
router.get("/health", (req, res) => {
  const root = getConfig();
  const cfg = root.executor || {};
  res.json({
    ok: !!cfg.enabled,
    enabled: !!cfg.enabled,
    nodeId: String(root.servers?.nodeId || ""),
    nodeName: configuredNodeDisplayName(root),
    allowedRoots: [...allowedRoots()],
  });
});

// 本机工程列表（中心据此知道这台远端有哪些工程可改）
router.get("/projects", (req, res) => {
  const auth = checkAuth(req);
  if (!auth.ok) return res.status(auth.code).json({ ok: false, error: auth.error });
  let projects = [];
  try { projects = store.listProjects().map((p) => ({ id: p.id, name: p.name, path: p.path, webAppPath: p.webAppPath, exists: p.exists })); } catch {}
  res.json({ ok: true, data: projects });
});

// 执行一个工具。body: { root, name, args }
router.post("/run-tool", async (req, res) => {
  const auth = checkAuth(req);
  if (!auth.ok) return res.status(auth.code).json({ ok: false, error: auth.error });
  const { root, name, args, artifactScope, taskId, commandPolicy } = req.body || {};
  if (!root || !name) return res.status(400).json({ ok: false, error: "缺少 root 或 name" });
  // tempRoot 不属于远端协议；只转交 story/generic 逻辑标识，由执行器本机推导实际目录。
  const r = await runTool(root, name, args || {}, {
    artifactScope,
    taskId,
    commandPolicy: commandPolicy === "read_only" ? "read_only" : undefined,
  });
  auditRunTool(req, root, name, args || {}, r);
  res.json(r);
});

export default router;
