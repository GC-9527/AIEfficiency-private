/**
 * 分布式 agentic 中心编排路由 - /api/distributed/*（本机作为「中心大脑」）
 * 用 api-engine 作大脑，把工具调用转发到目标远端执行器，跑「中心推理 + 远端执行」闭环。
 */
import { Router } from "express";
import { randomUUID } from "crypto";
import { getConfig } from "../services/config.js";
import { listRemoteProjects, remoteHealth } from "../services/remote-tools.js";
import { executeApiEngine, isApiEngine } from "../services/api-engine.js";
import { log } from "../services/logger.js";
import { isAdminPrincipal, requestPrincipal } from "../services/admin-auth.js";

const router = Router();

function allowUnauthenticatedDistributedDevelopment() {
  const environment = String(process.env.NODE_ENV || "").trim().toLowerCase();
  return environment === "test"
    || (
      environment === "development"
      && String(process.env.AIEFFICIENCY_ALLOW_UNAUTHENTICATED_DISTRIBUTED || "") === "1"
    );
}

router.use((req, res, next) => {
  if (allowUnauthenticatedDistributedDevelopment()) return next();
  const principal = requestPrincipal(req);
  if (!principal) {
    return res.status(401).json({
      ok: false,
      code: "DISTRIBUTED_AUTH_REQUIRED",
      error: "分布式执行控制面要求管理员身份",
    });
  }
  if (!isAdminPrincipal(principal)) {
    return res.status(403).json({
      ok: false,
      code: "DISTRIBUTED_ADMIN_REQUIRED",
      error: "分布式执行控制面仅允许管理员使用",
    });
  }
  req.principal = principal;
  return next();
});

function normalizedHost(value) {
  return String(value || "").trim().replace(/\/+$/, "").toLowerCase();
}

function configuredRemote(value) {
  const key = normalizedHost(value);
  if (!key) return null;
  return (getConfig().remoteExecutors || []).find(
    (entry) => normalizedHost(entry?.host) === key,
  ) || null;
}

async function attestedRemoteRoot(remote, root) {
  const requested = String(root || "").trim();
  if (!requested) return false;
  const projects = await listRemoteProjects(remote.host, remote.token);
  if (!projects?.ok) return false;
  return (Array.isArray(projects.data) ? projects.data : []).some((entry) => (
    [entry?.path, entry?.webAppPath, entry?.root]
      .some((candidate) => String(candidate || "").trim().toLowerCase() === requested.toLowerCase())
  ));
}

// 已配置的远端执行器列表 + 健康
router.get("/remotes", async (req, res) => {
  const list = getConfig().remoteExecutors || [];
  const data = [];
  for (const r of list) {
    const h = await remoteHealth(r.host, r.token);
    data.push({ name: r.name, host: r.host, online: !!h?.ok, allowedRoots: h?.allowedRoots || [] });
  }
  res.json({ ok: true, data });
});

// 拉取某远端可操作的工程（中心选 root 用）
router.get("/remote-projects", async (req, res) => {
  const remote = configuredRemote(req.query.host);
  if (!remote) {
    return res.status(400).json({
      ok: false,
      code: "DISTRIBUTED_REMOTE_NOT_REGISTERED",
      error: "远端执行器未在服务端静态配置中登记",
    });
  }
  const r = await listRemoteProjects(remote.host, remote.token);
  res.json(r);
});

// 跑一次分布式 agentic 任务：中心大脑(engine) 推理 + 工具在远端(host/root)执行
// body: { engine, prompt, host, token, root, sessionId? }
router.post("/run", async (req, res) => {
  const { engine, prompt, host, root, sessionId } = req.body || {};
  if (!engine || !isApiEngine(engine)) return res.status(400).json({ ok: false, error: "engine 必须是已启用的 API 引擎（OpenAI 兼容，作大脑）" });
  if (!prompt) return res.status(400).json({ ok: false, error: "缺少 prompt" });
  if (!host || !root) return res.status(400).json({ ok: false, error: "缺少远端 host 或 工程 root" });
  const remote = configuredRemote(host);
  if (!remote) {
    return res.status(400).json({
      ok: false,
      code: "DISTRIBUTED_REMOTE_NOT_REGISTERED",
      error: "远端执行器未在服务端静态配置中登记",
    });
  }
  if (!await attestedRemoteRoot(remote, root)) {
    return res.status(400).json({
      ok: false,
      code: "DISTRIBUTED_ROOT_NOT_ATTESTED",
      error: "远端工程根不在执行器实时返回的白名单中",
    });
  }
  const taskId = randomUUID();
  log(taskId, "info", "distributed", `分布式任务: 大脑=${engine} 远端=${remote.host} 工程=${root}`);
  try {
    const r = await executeApiEngine(
      engine,
      prompt,
      taskId,
      sessionId || null,
      { host: remote.host, token: remote.token, root },
    );
    res.json({ ok: true, data: { output: r.output, transcript: r.transcript || [] } });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

export default router;
