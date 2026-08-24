/**
 * 中心 AI 文本代理路由 - /api/claude-proxy/*
 * 仅供局域网远端调用：把单轮文本任务交给中心机的 AI 后端跑，SSE 流式回传。
 */
import { Router } from "express";
import { getConfig } from "../services/config.js";
import { runClaudeText, proxyHealth } from "../services/claude-proxy.js";
import { log } from "../services/logger.js";

const router = Router();

function checkAuth(req) {
  const root = getConfig();
  const cfg = root.claudeProxy || {};
  if (!cfg.enabled) return { ok: false, code: 403, error: "中心 AI 代理未启用（设置→AI 模式配置 开启对外提供 AI 文本代理）" };
  // 统一入站口令：servers.inboundToken（代理+执行器共用）优先，兼容旧 claudeProxy.token
  const expected = String(root.servers?.inboundToken || cfg.token || "").trim();
  const environment = String(process.env.NODE_ENV || "").trim().toLowerCase();
  const allowMissingToken = environment === "test"
    || (
      environment === "development"
      && String(process.env.AIEFFICIENCY_ALLOW_UNAUTHENTICATED_CLAUDE_PROXY || "") === "1"
    );
  if (!expected && !allowMissingToken) {
    return { ok: false, code: 503, error: "中心 AI 代理未配置入站认证口令，已失败关闭" };
  }
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (expected && token !== expected) return { ok: false, code: 401, error: "token 无效" };
  return { ok: true };
}

// 健康/状态（远端探测引擎可用性）
router.get("/health", (req, res) => {
  res.json(proxyHealth());
});

// 单轮文本任务（SSE 流式）。body: { prompt, system?, clientId?, requestId? }
router.post("/run", async (req, res) => {
  const auth = checkAuth(req);
  if (!auth.ok) return res.status(auth.code).json({ ok: false, error: auth.error });
  const prompt = req.body?.prompt;
  if (!prompt) return res.status(400).json({ ok: false, error: "缺少 prompt" });

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  const send = (event, data) => { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {} };

  const ac = new AbortController();
  let finished = false;
  // 用 res(响应)关闭检测客户端断开；req.close 在请求体读完即触发，会误杀任务
  res.on("close", () => { if (!finished) ac.abort(); });

  log("system", "info", "claude-proxy", `远端文本任务 client=${req.body?.clientId || "?"} prompt=${String(prompt).length}字符`);
  send("start", { busy: proxyHealth().busy });
  const r = await runClaudeText({ prompt, system: req.body?.system, onChunk: (t) => send("chunk", { delta: t }), signal: ac.signal });
  finished = true;
  if (r.ok) send("done", { text: r.text, usage: r.usage || null });
  else send("error", { message: r.error });
  res.end();
});

export default router;
