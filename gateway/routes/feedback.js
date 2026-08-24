/**
 * 问题反馈（类简约 TB 单）路由 - /api/feedback/*
 * - 客户端(node)提交/查询都转发到所连服务端；服务端本地存储，服务端间经 gossip 同步。
 * - 全员可看全部反馈单（支持按提交人/状态过滤）；管理员可改状态/指派/评论/「去解决」(一键发 Claude 修复)。
 * - 「AI提效工程配置」：每个工程的 git 远程/分支/本地路径，供一键修复用。
 */
import { Router } from "express";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getConfig, updateConfig } from "../services/config.js";
import { isAdminPrincipal, requestPrincipal, requirePeerReplicationAuth } from "../services/admin-auth.js";
import {
  prepareNodeCenterRequest,
  sendCenterForwardFailure,
} from "../services/center-forward.js";
import { upsertFeedback, getFeedback, listFeedback, updateFeedback, addFeedbackComment, maxFeedbackUpdated } from "../db/sqlite.js";
import { nodeId } from "../services/discovery.js";
import { runAgentLoop, defaultBrain } from "../services/devbench/agent-loop.js";
import { broadcastAll, log } from "../services/logger.js";

const router = Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FB_DIR = process.env.FEEDBACK_DIR || path.join(__dirname, "..", "feedback-files");

// ===== 鉴权 / 身份 =====
function principal(req) { return requestPrincipal(req, { allowM2M: true }); }
function isAdminReq(req) { return isAdminPrincipal(principal(req)); }
function reporterOf(req) {
  const b = req.body || {};
  const p = principal(req);
  return {
    reporter_id: String(b.reporterId || p?.dingUserid || p?.name || "").trim(),
    reporter_name: String(b.reporterName || p?.name || "匿名").trim(),
    reporter_kind: String(b.reporterKind || (p ? "ding" : "name")).trim(),
  };
}

// ===== 客户端(node)转发到服务端（二进制安全：附件下载也走这里） =====
async function forwardCentral(req, res) {
  const prepared = prepareNodeCenterRequest(req);
  if (!prepared.forward) return false;
  if (!prepared.ok) {
    sendCenterForwardFailure(res, prepared);
    return true;
  }
  try {
    const opts = {
      method: req.method,
      headers: prepared.headers,
      redirect: prepared.redirect,
    };
    if (!["GET", "DELETE"].includes(req.method)) {
      opts.headers.set("Content-Type", "application/json");
      opts.body = JSON.stringify(req.body || {});
    }
    const url = prepared.base + "/api/feedback" + req.originalUrl.replace(/^.*\/api\/feedback/, "");
    const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(20000) });
    const ct = r.headers.get("content-type") || "application/json";
    const buf = Buffer.from(await r.arrayBuffer());
    res.status(r.status).type(ct).send(buf);
  } catch (e) {
    res.status(502).json({
      ok: false,
      code: "CENTER_M2M_FORWARD_FAILED",
      error: "中心服务端不可达或拒绝了重定向：" + e.message,
    });
  }
  return true;
}

// ===== 附件落盘（base64）→ 返回元数据 =====
function saveAttachments(id, atts) {
  if (!Array.isArray(atts) || !atts.length) return [];
  const dir = path.join(FB_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const out = [];
  for (const a of atts) {
    if (!a?.name || !a?.dataBase64) continue;
    const safe = String(a.name).replace(/[\\/:*?"<>|]/g, "_").slice(0, 120);
    const buf = Buffer.from(a.dataBase64, "base64");
    fs.writeFileSync(path.join(dir, safe), buf);
    out.push({ name: safe, size: buf.length, kind: a.kind || "file" });
  }
  return out;
}

// ===== 通知客户端（WS 广播 + 评论留痕）=====
function notify(fb, text) {
  try { broadcastAll(JSON.stringify({ type: "feedback_update", data: { id: fb.id, status: fb.status, reporterId: fb.reporter_id, text } })); } catch {}
}

// ========== AI提效工程配置（git 远程/分支/本地路径，供一键修复）==========
function devConfig() { return getConfig().aiDevConfig || { projects: {} }; }
router.get("/dev-config", async (req, res) => {
  if (await forwardCentral(req, res)) return;
  res.json({ ok: true, data: devConfig() });
});
router.put("/dev-config", async (req, res) => {
  if (await forwardCentral(req, res)) return;
  if (!isAdminReq(req)) return res.status(403).json({ ok: false, error: "AI提效工程配置仅管理员可改" });
  const cur = devConfig();
  const next = { projects: { ...(cur.projects || {}), ...((req.body && req.body.projects) || {}) } };
  updateConfig({ aiDevConfig: next });
  res.json({ ok: true, data: next });
});

// ========== 列表 / 详情 ==========
// 全员可看全部；?mine=1&reporterId= 只看我的；?reporter= 按人；?status=
router.get("/", async (req, res) => {
  if (await forwardCentral(req, res)) return;
  const q = req.query || {};
  const reporterId = q.mine === "1" ? String(q.reporterId || "") : (q.reporter ? String(q.reporter) : undefined);
  const list = listFeedback({ reporterId, status: q.status || undefined, limit: parseInt(q.limit) || 500 });
  res.json({ ok: true, data: list });
});
router.get("/since", requirePeerReplicationAuth, (req, res) => { // gossip 增量
  res.json({ ok: true, data: listFeedback({ since: parseInt(req.query.since) || 0, limit: 1000 }) });
});
router.get("/:id", async (req, res) => {
  if (await forwardCentral(req, res)) return;
  const fb = getFeedback(req.params.id);
  if (!fb) return res.status(404).json({ ok: false, error: "反馈单不存在" });
  res.json({ ok: true, data: fb });
});
// 附件下载
router.get("/:id/attachments/:name", async (req, res) => {
  if (await forwardCentral(req, res)) return;
  const safe = String(req.params.name).replace(/[\\/:*?"<>|]/g, "_");
  const fp = path.join(FB_DIR, req.params.id, safe);
  if (!fp.startsWith(path.join(FB_DIR, req.params.id)) || !fs.existsSync(fp)) return res.status(404).json({ ok: false, error: "附件不存在" });
  res.download(fp, safe);
});

// ========== 创建 ==========
// body: { title, body, page?, priority?, project?, reporterName?, reporterId?, reporterKind?, attachments:[{name,dataBase64,kind}] }
router.post("/", async (req, res) => {
  if (await forwardCentral(req, res)) return; // 客户端→服务端
  const b = req.body || {};
  if (!String(b.title || "").trim()) return res.status(400).json({ ok: false, error: "缺少标题" });
  const id = `fb-${nodeId()}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const attachments = saveAttachments(id, b.attachments);
  const fb = upsertFeedback({
    id, ts: Date.now(), updated_at: Date.now(), ...reporterOf(req),
    title: String(b.title).trim(), body: String(b.body || ""), status: "open",
    priority: ["low", "normal", "high"].includes(b.priority) ? b.priority : "normal",
    page: String(b.page || ""), project: String(b.project || ""), attachments, comments: [], node: nodeId(),
  });
  notify(fb, "新反馈已提交");
  log("system", "info", "feedback", `新反馈 ${id}：${fb.title}`);
  res.json({ ok: true, data: fb });
});

// 追加附件（编辑日志附件那一栏：用户补充昨天的日志等）
router.post("/:id/attachments", async (req, res) => {
  if (await forwardCentral(req, res)) return;
  const fb = getFeedback(req.params.id);
  if (!fb) return res.status(404).json({ ok: false, error: "反馈单不存在" });
  const added = saveAttachments(fb.id, (req.body && req.body.attachments) || []);
  if (!added.length) return res.json({ ok: true, data: fb });
  const updated = updateFeedback(fb.id, { attachments: [...(fb.attachments || []), ...added] });
  res.json({ ok: true, data: updated });
});

// 评论（反馈人或管理员）
router.post("/:id/comments", async (req, res) => {
  if (await forwardCentral(req, res)) return;
  const fb = getFeedback(req.params.id);
  if (!fb) return res.status(404).json({ ok: false, error: "反馈单不存在" });
  const p = principal(req);
  const text = String((req.body && req.body.text) || "").trim();
  if (!text) return res.status(400).json({ ok: false, error: "评论为空" });
  const author = p?.name || String((req.body && req.body.author) || "匿名");
  const updated = addFeedbackComment(fb.id, { author, role: p?.role || "user", text });
  notify(updated, "新评论");
  res.json({ ok: true, data: updated });
});

// ========== 管理员：改状态/指派/优先级/标题（去解决用） ==========
router.put("/:id", async (req, res) => {
  if (await forwardCentral(req, res)) return;
  if (!isAdminReq(req)) return res.status(403).json({ ok: false, error: "仅管理员可处理反馈单" });
  const fb = getFeedback(req.params.id);
  if (!fb) return res.status(404).json({ ok: false, error: "反馈单不存在" });
  const b = req.body || {};
  const patch = {};
  if (b.status && ["open", "in_progress", "resolved", "closed", "wontfix"].includes(b.status)) patch.status = b.status;
  if (typeof b.assignee === "string") patch.assignee = b.assignee;
  if (b.priority && ["low", "normal", "high"].includes(b.priority)) patch.priority = b.priority;
  if (typeof b.project === "string") patch.project = b.project;
  if (typeof b.title === "string" && b.title.trim()) patch.title = b.title.trim();
  if (typeof b.body === "string") patch.body = b.body;
  const updated = updateFeedback(fb.id, patch);
  const actor = principal(req)?.name || "管理员";
  if (patch.status && patch.status !== fb.status) {
    addFeedbackComment(fb.id, { author: actor, role: "admin", text: `状态变更：${fb.status} → ${patch.status}` });
  }
  notify(getFeedback(fb.id), "管理员已更新");
  res.json({ ok: true, data: getFeedback(fb.id) });
});

// ========== 管理员：一键发 Claude 分析并修复 ==========
// 用 AI提效工程配置 里该工程的 本地路径(已克隆) 或 git 远程+分支(自动浅克隆) 作为工作根，跑 agent-loop。
router.post("/:id/solve", async (req, res) => {
  if (await forwardCentral(req, res)) return;
  if (!isAdminReq(req)) return res.status(403).json({ ok: false, error: "仅管理员可发起修复" });
  const fb = getFeedback(req.params.id);
  if (!fb) return res.status(404).json({ ok: false, error: "反馈单不存在" });

  const projKey = String((req.body && req.body.project) || fb.project || "default");
  const dc = (devConfig().projects || {})[projKey] || (devConfig().projects || {}).default || {};
  let root = String(dc.localPath || "").trim();
  const gitRemote = String(dc.gitRemote || "").trim();
  const branch = String(dc.branch || "").trim();

  const runId = `fbsolve_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  res.json({ ok: true, data: { started: true, runId } }); // 立即返回，进度走 WS
  const emit = (patch) => { try { broadcastAll(JSON.stringify({ type: "feedback_solve_step", data: { runId, id: fb.id, ...patch } })); } catch {} };

  try {
    // 无本地路径但有远程 → 浅克隆到 feedback-files/repos/<projKey>
    if ((!root || !fs.existsSync(root)) && gitRemote) {
      const dest = path.join(FB_DIR, "repos", projKey.replace(/[\\/:*?"<>|]/g, "_"));
      emit({ phase: "clone", text: `克隆 ${gitRemote}${branch ? "@" + branch : ""} …` });
      await cloneRepo(gitRemote, branch, dest);
      root = dest;
    }
    if (!root || !fs.existsSync(root)) {
      emit({ phase: "end", result: { ok: false, error: "未配置该工程的本地路径或 git 远程，请在「AI提效工程配置」设置" } });
      return;
    }
    // 还原现场：把反馈附带的文本日志/说明读出来注入任务，帮助 Claude 复现与定位
    const diag = collectDiagnostics(fb);
    emit({ phase: "diag", text: diag ? `已注入现场日志 ${diag.length} 字` : "无可读现场日志（仅文本附件可读，zip 不解包）" });
    const task = [
      `下面是一个用户问题反馈，请在本工程内定位并修复。`,
      `标题：${fb.title}`,
      `详情：${fb.body || "(无)"}`,
      `发生页面/位置：${fb.page || "(未知)"}`,
      (fb.attachments || []).some((a) => a.kind === "image") ? `（提交时附了界面截图）` : "",
      diag ? `\n===== 现场操作日志/补充（截断） =====\n${diag}\n===== 日志结束 =====` : "",
      `\n请基于以上现场信息：先复现/定位根因，再给出最小修复改动，并简述原因与验证方式。`,
    ].filter(Boolean).join("\n");
    const r = await runAgentLoop({ root, task, callBrain: defaultBrain(), maxRounds: Math.min(30, parseInt(req.body?.maxRounds) || 16), onStep: (s) => emit(s) });
    addFeedbackComment(fb.id, { author: "AI提效", role: "admin", text: `Claude 修复${r.done ? "完成" : r.reachedMax ? "(达上限)" : "结束"}：${(r.summary || "").slice(0, 800)}` });
    if (r.done) updateFeedback(fb.id, { status: "in_progress" });
    emit({ phase: "end", result: { ok: r.ok, done: r.done, reachedMax: r.reachedMax, summary: r.summary || "", steps: r.history?.length || 0, error: r.error || null } });
  } catch (e) { emit({ phase: "end", result: { ok: false, error: e.message } }); }
});

// 读反馈的文本附件(logs-*.txt / *.log / 补充说明.txt)拼成现场信息，截断到 ~8000 字（zip 不解包）
function collectDiagnostics(fb) {
  const dir = path.join(FB_DIR, fb.id);
  let out = "";
  for (const a of fb.attachments || []) {
    if (!/\.(txt|log)$/i.test(a.name)) continue;
    const fp = path.join(dir, a.name);
    try { if (fs.existsSync(fp)) out += `\n--- ${a.name} ---\n` + fs.readFileSync(fp, "utf-8"); } catch {}
  }
  out = out.trim();
  return out ? out.slice(0, 8000) : "";
}

function cloneRepo(remote, branch, dest) {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(path.join(dest, ".git"))) return resolve(dest);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const args = ["clone", "--depth", "1"];
    if (branch) args.push("--branch", branch);
    args.push(remote, dest);
    const p = spawn("git", args, { shell: true, windowsHide: true });
    let err = "";
    p.stderr.on("data", (d) => { err += d.toString(); });
    p.on("error", (e) => reject(e));
    p.on("close", (c) => (c === 0 ? resolve(dest) : reject(new Error("git clone 失败：" + err.slice(-300)))));
  });
}

// gossip 同步元数据（供 discovery 调用方探测最新水位）
export function feedbackWatermark() { return maxFeedbackUpdated(); }
export default router;
