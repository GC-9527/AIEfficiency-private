/**
 * 中心 → 远端 工具转发（阶段1 中心编排）。
 * 中心大脑(api-engine 的 tool-use 循环)产生工具调用后，经此把工具发到「目标远端执行器」本地执行。
 * target: { host, token, root }
 */
import { log } from "./logger.js";
import { normalizeHttpOrigin } from "./m2m-auth.js";

function requiredArtifactScopeField(value, field, maxLength) {
  if (typeof value !== "string") {
    throw new Error(`artifactScope.${field} 必须是字符串`);
  }
  const cleaned = value.trim();
  if (!cleaned || cleaned.length > maxLength || /[\u0000-\u001f\u007f]/.test(cleaned)) {
    throw new Error(`artifactScope.${field} 无效`);
  }
  return cleaned;
}

/**
 * 远端执行协议只转发 story/generic 逻辑产物标识。绝对路径、tempRoot 及其它调用方字段
 * 都不会跨机器传输；实际 StoryDev 或系统临时目录必须由执行器本机配置推导。
 */
export function sanitizeArtifactScope(value) {
  if (value == null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("artifactScope 必须是对象");
  }
  if (value.kind === "generic") {
    return {
      kind: "generic",
      id: requiredArtifactScopeField(value.id, "id", 240),
    };
  }
  if (value.kind !== "story") {
    throw new Error("artifactScope.kind 仅支持 story 或 generic");
  }
  return {
    kind: "story",
    id: requiredArtifactScopeField(value.id, "id", 240),
    title: requiredArtifactScopeField(value.title, "title", 1000),
    docSlug: requiredArtifactScopeField(value.docSlug, "docSlug", 240),
  };
}

function remoteToolBody(target, name, args, meta, { includeRound = false } = {}) {
  const artifactScope = sanitizeArtifactScope(meta.artifactScope);
  const commandPolicy = meta.commandPolicy === "read_only" ? "read_only" : "";
  return {
    root: target.root,
    name,
    args,
    taskId: meta.taskId || target.taskId || "",
    sessionId: meta.sessionId || target.sessionId || "",
    clientId: meta.clientId || "api-engine",
    ...(includeRound ? { round: meta.round || null } : {}),
    ...(artifactScope ? { artifactScope } : {}),
    ...(commandPolicy ? { commandPolicy } : {}),
  };
}

export async function runRemoteToolResult(target, name, args = {}, signal = null, meta = {}) {
  if (!target?.host) return { ok: false, error: "未指定远端地址" };
  const base = normalizeHttpOrigin(target.host);
  if (!base) return { ok: false, error: "远端地址必须是纯 http(s) origin" };
  const url = `${base}/api/executor/run-tool`;
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(target.token ? { Authorization: `Bearer ${target.token}` } : {}) },
      redirect: "error",
      body: JSON.stringify(remoteToolBody(target, name, args, meta, { includeRound: true })),
      signal: signal || undefined,
    });
    let data; try { data = await resp.json(); } catch { data = null; }
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}: ${data?.error || ""}` };
    if (!data || data.ok === false) return { ok: false, error: data?.error || "未知错误" };
    return { ok: true, result: data.result };
  } catch (e) {
    return { ok: false, error: `连接远端执行器失败: ${e.message}` };
  }
}

// 在远端工程(root)内执行一个工具，返回标准化文本结果（喂回给 LLM）。
export async function runRemoteTool(target, name, args = {}, signal = null, meta = {}) {
  if (!target?.host) return "工具执行失败: 未指定远端地址";
  const base = normalizeHttpOrigin(target.host);
  if (!base) return "工具执行失败: 远端地址必须是纯 http(s) origin";
  const url = `${base}/api/executor/run-tool`;
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(target.token ? { Authorization: `Bearer ${target.token}` } : {}) },
      redirect: "error",
      body: JSON.stringify(remoteToolBody(target, name, args, meta)),
      signal: signal || undefined,
    });
    let data; try { data = await resp.json(); } catch { data = null; }
    if (!resp.ok) return `工具执行失败(HTTP ${resp.status}): ${data?.error || ""}`;
    if (!data || data.ok === false) return `工具执行失败: ${data?.error || "未知错误"}`;
    const r = data.result;
    return typeof r === "string" ? r : JSON.stringify(r);
  } catch (e) {
    return `连接远端执行器失败: ${e.message}`;
  }
}

// 拉取远端可操作的工程列表（中心选 root 用）。
export async function listRemoteProjects(host, token) {
  if (!host) return { ok: false, error: "未指定远端地址" };
  const base = normalizeHttpOrigin(host);
  if (!base) return { ok: false, error: "远端地址必须是纯 http(s) origin" };
  const url = `${base}/api/executor/projects`;
  try {
    const resp = await fetch(url, {
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      redirect: "error",
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data?.ok) return { ok: false, error: data?.error || `HTTP ${resp.status}` };
    return { ok: true, data: data.data || [] };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// 远端执行器健康
export async function remoteHealth(host, token) {
  if (!host) return { ok: false };
  const base = normalizeHttpOrigin(host);
  if (!base) return { ok: false };
  try {
    const resp = await fetch(`${base}/api/executor/health`, {
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      redirect: "error",
    });
    return await resp.json().catch(() => ({ ok: false }));
  } catch { return { ok: false }; }
}
