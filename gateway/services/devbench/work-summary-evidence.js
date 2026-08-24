/**
 * 工作总结 AI 会话采集器。
 *
 * 目标：
 * 1. 只提取“用户指令 + AI 文本回复”，跳过工具输出等大体积噪声；
 * 2. 使用本机增量索引，文件未变化时不再重复读取，增长中的会话只读新增字节；
 * 3. Claude / Codex 即使工作目录相同也保持为独立来源，避免引擎归属串线。
 *
 * 索引是机器本地运行时缓存，默认位于 LOCALAPPDATA/AIEfficiency/cache，
 * 不写入项目仓库，也不会被自动暂存。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { performance } from "node:perf_hooks";

const CACHE_VERSION = 2;
const USER_TEXT_LIMIT = 600;
const ASSISTANT_TEXT_LIMIT = 400;

function toTime(value) {
  const time = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(time) ? time : null;
}

function normalizeText(value, limit) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function isHumanPrompt(text) {
  const value = String(text || "").trim();
  if (!value) return false;
  return !/^<(?:command-|local-command|system-reminder|INSTRUCTIONS|environment_context|permissions)/i.test(value)
    && !/^# AGENTS\.md\b/i.test(value);
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  if (content.some((item) => item?.type === "tool_result")) return "";
  return content
    .filter((item) => item && (item.type === "text" || item.type === "input_text" || item.type === "output_text"))
    .map((item) => item.text || item.input_text || item.output_text || "")
    .join(" ");
}

function defaultCachePath(homeDir = os.homedir(), env = process.env) {
  if (String(env.WORK_SUMMARY_CACHE_PATH || "").trim()) {
    return path.resolve(String(env.WORK_SUMMARY_CACHE_PATH).trim());
  }
  const base = String(env.LOCALAPPDATA || "").trim() || path.join(homeDir, ".aiefficiency");
  return path.join(base, "AIEfficiency", "cache", `work-summary-ai-sessions-v${CACHE_VERSION}.json`);
}

function readCache(cachePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    if (parsed?.version === CACHE_VERSION && parsed.files && typeof parsed.files === "object") return parsed;
  } catch {}
  return { version: CACHE_VERSION, files: {} };
}

function writeCache(cachePath, cache) {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    const temporary = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(cache), "utf8");
    fs.renameSync(temporary, cachePath);
  } catch {
    // 缓存失败不能影响工作总结；下次退化为重新扫描。
  }
}

function safeEntries(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function fileStat(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() ? stat : null;
  } catch {
    return null;
  }
}

function collectClaudeCandidates(roots) {
  const selected = new Map();
  for (let rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
    const root = roots[rootIndex];
    if (!root || !fs.existsSync(root)) continue;
    for (const projectEntry of safeEntries(root)) {
      if (!projectEntry.isDirectory()) continue;
      const projectDir = path.join(root, projectEntry.name);
      for (const fileEntry of safeEntries(projectDir)) {
        if (!fileEntry.isFile() || !fileEntry.name.endsWith(".jsonl")) continue;
        const filePath = path.join(projectDir, fileEntry.name);
        const stat = fileStat(filePath);
        if (!stat) continue;
        const key = `claude/${projectEntry.name}/${fileEntry.name}`;
        const candidate = {
          key,
          engine: "claude",
          projectFallback: projectEntry.name,
          path: filePath,
          priority: rootIndex,
          stat,
          sessionDateMs: null,
        };
        const previous = selected.get(key);
        // 源与备份同会话优先取内容更完整的文件；大小相同时取优先级更高的源目录。
        if (!previous || stat.size > previous.stat.size
          || (stat.size === previous.stat.size && rootIndex < previous.priority)) {
          selected.set(key, candidate);
        }
      }
    }
  }
  return [...selected.values()];
}

function collectCodexCandidates(root) {
  if (!root || !fs.existsSync(root)) return [];
  const candidates = [];
  for (const yearEntry of safeEntries(root)) {
    if (!yearEntry.isDirectory() || !/^\d{4}$/.test(yearEntry.name)) continue;
    const yearPath = path.join(root, yearEntry.name);
    for (const monthEntry of safeEntries(yearPath)) {
      if (!monthEntry.isDirectory() || !/^\d{2}$/.test(monthEntry.name)) continue;
      const monthPath = path.join(yearPath, monthEntry.name);
      for (const dayEntry of safeEntries(monthPath)) {
        if (!dayEntry.isDirectory() || !/^\d{2}$/.test(dayEntry.name)) continue;
        const dayPath = path.join(monthPath, dayEntry.name);
        const date = `${yearEntry.name}-${monthEntry.name}-${dayEntry.name}`;
        const sessionDateMs = toTime(`${date}T00:00:00`);
        for (const fileEntry of safeEntries(dayPath)) {
          if (!fileEntry.isFile() || !fileEntry.name.endsWith(".jsonl")) continue;
          const filePath = path.join(dayPath, fileEntry.name);
          const stat = fileStat(filePath);
          if (!stat) continue;
          candidates.push({
            key: `codex/${date}/${fileEntry.name}`,
            engine: "codex",
            projectFallback: date,
            path: filePath,
            priority: 0,
            stat,
            sessionDateMs,
          });
        }
      }
    }
  }
  return candidates;
}

function addMessage(state, role, timestamp, text) {
  const ts = toTime(timestamp);
  const limit = role === "user" ? USER_TEXT_LIMIT : ASSISTANT_TEXT_LIMIT;
  const normalized = normalizeText(text, limit);
  if (ts == null || !normalized || (role === "user" && !isHumanPrompt(normalized))) return;
  const previous = state.messages[state.messages.length - 1];
  if (previous && previous.role === role && previous.ts === ts && previous.text === normalized) return;
  state.messages.push({ role, ts, text: normalized });
}

function parseClaudeLine(line, state) {
  if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"') && !line.includes('"cwd"')) return;
  let event;
  try { event = JSON.parse(line); } catch { return; }
  if (event.cwd) state.cwd = String(event.cwd);
  if (event.type === "user") addMessage(state, "user", event.timestamp, contentText(event.message?.content));
  if (event.type === "assistant") addMessage(state, "assistant", event.timestamp, contentText(event.message?.content));
}

function parseCodexLine(line, state) {
  if (!line.includes('"type":"session_meta"') && !line.includes('"type":"response_item"')) return;
  let event;
  try { event = JSON.parse(line); } catch { return; }
  const payload = event.payload || {};
  // session_meta 往往早于用户选择的起始时间，仍必须先保存 cwd，才能识别跨日期持续会话。
  if (event.type === "session_meta" && payload.cwd) state.cwd = String(payload.cwd);
  if (event.type !== "response_item" || payload.type !== "message") return;
  if (payload.role !== "user" && payload.role !== "assistant") return;
  addMessage(state, payload.role, event.timestamp, contentText(payload.content));
}

async function parseJsonl(candidate, startOffset, previous) {
  const state = {
    cwd: startOffset > 0 ? String(previous?.cwd || "") : "",
    messages: startOffset > 0 && Array.isArray(previous?.messages) ? [...previous.messages] : [],
  };
  const stream = fs.createReadStream(candidate.path, {
    encoding: "utf8",
    ...(startOffset > 0 ? { start: startOffset } : {}),
  });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const parse = candidate.engine === "codex" ? parseCodexLine : parseClaudeLine;
  for await (const line of lines) parse(line, state);
  state.cwd ||= candidate.projectFallback;
  return state;
}

function couldOverlap(candidate, startMs, endMs) {
  if (candidate.stat.mtimeMs < startMs) return false;
  if (candidate.engine === "codex" && candidate.sessionDateMs != null && candidate.sessionDateMs > endMs) return false;
  return true;
}

function groupCachedMessages(candidates, cache, startMs, endMs) {
  const grouped = new Map();
  const engineCounts = {};
  let sessionCount = 0;
  let messageCount = 0;
  for (const candidate of candidates) {
    const entry = cache.files[candidate.key];
    if (!entry || !Array.isArray(entry.messages)) continue;
    const messages = entry.messages.filter((item) => item.ts >= startMs && item.ts <= endMs);
    if (!messages.length) continue;
    const project = String(entry.cwd || candidate.projectFallback || "unknown");
    const groupKey = `${candidate.engine}\u0000${project}`;
    if (!grouped.has(groupKey)) {
      grouped.set(groupKey, {
        project,
        engine: candidate.engine,
        sessionKeys: new Set(),
        prompts: [],
        assistants: [],
      });
    }
    const group = grouped.get(groupKey);
    group.sessionKeys.add(candidate.key);
    for (const message of messages) {
      if (message.role === "user") group.prompts.push({ ts: message.ts, text: message.text });
      else group.assistants.push({ ts: message.ts, text: message.text });
      messageCount += 1;
    }
  }
  const byProject = [...grouped.values()]
    .map((group) => ({
      project: group.project,
      engine: group.engine,
      sessionCount: group.sessionKeys.size,
      prompts: group.prompts.sort((a, b) => a.ts - b.ts),
      assistants: group.assistants.sort((a, b) => a.ts - b.ts),
    }))
    .filter((group) => group.prompts.length > 0)
    .sort((a, b) => b.prompts.length - a.prompts.length || a.project.localeCompare(b.project));
  for (const group of byProject) {
    sessionCount += group.sessionCount;
    engineCounts[group.engine] = (engineCounts[group.engine] || 0) + group.prompts.length + group.assistants.length;
  }
  return { byProject, sessionCount, messageCount, engineCounts };
}

let collectionQueue = Promise.resolve();

async function collectAiSessionsInternal({
  since,
  until,
  homeDir = os.homedir(),
  claudeProjects = path.join(homeDir, ".claude", "projects"),
  claudeBackupProjects = "D:\\backup\\claude\\projects",
  codexSessions = path.join(homeDir, ".codex", "sessions"),
  cachePath = defaultCachePath(homeDir),
} = {}) {
  const startedAt = performance.now();
  const startMs = toTime(`${since}T00:00:00`);
  const endMs = toTime(`${until}T23:59:59.999`);
  if (startMs == null || endMs == null || startMs > endMs) throw new Error("AI 会话采集的起止日期无效");

  const candidates = [
    ...collectClaudeCandidates([claudeProjects, claudeBackupProjects]),
    ...collectCodexCandidates(codexSessions),
  ];
  const cache = readCache(cachePath);
  const liveKeys = new Set(candidates.map((candidate) => candidate.key));
  for (const key of Object.keys(cache.files)) {
    if (!liveKeys.has(key)) delete cache.files[key];
  }

  let cacheHits = 0;
  let parsedFiles = 0;
  let bytesRead = 0;
  let incrementalFiles = 0;
  const errors = [];
  for (const candidate of candidates) {
    const previous = cache.files[candidate.key];
    const unchanged = previous
      && previous.version === CACHE_VERSION
      && previous.path === candidate.path
      && previous.size === candidate.stat.size
      && previous.mtimeMs === candidate.stat.mtimeMs;
    if (unchanged) {
      cacheHits += 1;
      continue;
    }
    // 未命中当前范围的未知/变化文件不需要为本次总结预读；后续选中其日期时再建立索引。
    if (!couldOverlap(candidate, startMs, endMs)) continue;

    const canAppend = previous
      && previous.version === CACHE_VERSION
      && previous.path === candidate.path
      && previous.size > 0
      && candidate.stat.size > previous.size
      && Array.isArray(previous.messages);
    const startOffset = canAppend ? previous.size : 0;
    let parsed;
    try {
      parsed = await parseJsonl(candidate, startOffset, previous);
    } catch (error) {
      errors.push(`${candidate.engine}:${path.basename(candidate.path)}:${String(error?.message || error).slice(0, 120)}`);
      continue;
    }
    parsedFiles += 1;
    bytesRead += Math.max(0, candidate.stat.size - startOffset);
    if (startOffset > 0) incrementalFiles += 1;
    cache.files[candidate.key] = {
      version: CACHE_VERSION,
      engine: candidate.engine,
      path: candidate.path,
      size: candidate.stat.size,
      mtimeMs: candidate.stat.mtimeMs,
      cwd: parsed.cwd,
      messages: parsed.messages,
      indexedAt: Date.now(),
    };
  }
  cache.updatedAt = Date.now();
  writeCache(cachePath, cache);

  const grouped = groupCachedMessages(candidates, cache, startMs, endMs);
  return {
    byProject: grouped.byProject,
    stats: {
      durationMs: Math.round(performance.now() - startedAt),
      candidateFiles: candidates.length,
      cacheHits,
      parsedFiles,
      incrementalFiles,
      bytesRead,
      sessionCount: grouped.sessionCount,
      messageCount: grouped.messageCount,
      engineCounts: grouped.engineCounts,
      errors,
    },
  };
}

/**
 * 串行更新同一份本机索引，避免用户连续点击或多个页面同时生成时互相覆盖缓存。
 */
export function collectAiSessions(options = {}) {
  const run = collectionQueue.then(() => collectAiSessionsInternal(options));
  collectionQueue = run.catch(() => {});
  return run;
}

export const workSummaryEvidenceInternals = {
  defaultCachePath,
  contentText,
  isHumanPrompt,
};
